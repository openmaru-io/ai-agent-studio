# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""내 PC 의 Hermes 가져오기 경로(OMAI-1136): 권한(주인·관리자만, grant 거절), 대상 프로파일 검사(OMAI-1444), 올리기·검사·조회·취소를 끝까지."""
import http.client
import http.server
import json
import os
import sys
import tempfile
import threading
import types
import unittest
import urllib.parse
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sidecar"))
import aasserver  # noqa: E402
from aas_sidecar import ops as sc_ops, server as sc_server  # noqa: E402

from aas.auth import auth  # noqa: E402
from aas.common import store  # noqa: E402
from aas.fleet import pods, primary  # noqa: E402
from aas.office import office_state  # noqa: E402
from aas.ops import pc_import as pc  # noqa: E402
from aas.web import pc_import_routes as routes, server  # noqa: E402
from test_chat_files import FakeDashboard  # noqa: E402
import io  # noqa: E402
import tarfile  # noqa: E402
from datetime import timedelta  # noqa: E402

from aas.fleet import k8s  # noqa: E402
from test_pc_import import bundle, raw_profile_archive  # noqa: E402

TOKEN = "t0ken-for-tests-0123456789"


class PcDashboard(FakeDashboard):
    """FakeDashboard 에 프로파일 목록(GET /api/profiles, OMAI-1444 R4)과 프로파일 내보내기를 더한다. gets 는 GET 요청 경로."""
    gets: list = []

    def do_GET(self):  # noqa: N802
        PcDashboard.gets.append(self.path)
        if not self._authed():
            return self._json(401, {})
        if self.path == "/api/profiles":
            return self._json(200, {"profiles": [{"name": "default", "is_default": True}, {"name": "main"}, {"name": "research"}]})
        self._json(404, {})

    def do_POST(self):  # noqa: N802
        if self.path.startswith("/api/profiles/") and self.path.endswith("/export") and self._authed():
            out = json.loads(self._body())["output"].replace("/opt/data/", "", 1)
            (self.root / out).parent.mkdir(parents=True, exist_ok=True)
            (self.root / out).write_bytes(b"tar")
            return self._json(200, {"ok": True})
        super().do_POST()


class ContextTest(unittest.TestCase):
    """권한 판정만(_context): 가짜 인증·등록부."""

    def ctx(self, user, owner="kim@x.com", admin=False, k8s_on=True, sidecar="http://s"):
        pod = types.SimpleNamespace(id="p1", owner=owner, sidecar_url=sidecar)
        pod.owned_by = lambda u: bool(u) and u.get("email") == owner
        reg = types.SimpleNamespace(pods=[pod], is_admin=lambda u: admin)
        a = types.SimpleNamespace(enabled=True, user=lambda cookie: user)
        req = types.SimpleNamespace(headers={"Sec-Fetch-Site": "same-origin"}, query_params={"pod": "p1"})
        view = types.SimpleNamespace(_host_ok=lambda: True, _same_origin=lambda: True)
        with mock.patch.object(routes.files, "_View", return_value=view), mock.patch.object(server, "auth", return_value=a), \
                mock.patch.object(server, "registry", return_value=reg), \
                mock.patch.object(server, "_owns_pod", side_effect=lambda p, u, en: p.owned_by(u)), \
                mock.patch.object(server, "_manages_pod", side_effect=lambda p, u, en: p.owned_by(u)), \
                mock.patch.object(routes, "_k8s_ready", return_value=k8s_on):
            return routes._context(req, write=True)

    def code(self, **kw):
        try:
            self.ctx(**kw)
        except routes._Denied as d:
            return d.code, d.status
        return "ok", 200

    def test_주인과_관리자만(self):
        self.assertEqual(self.ctx({"email": "kim@x.com"})[3], False)                       # 주인: 대행 아님
        self.assertEqual(self.ctx({"email": "boss@x.com"}, admin=True)[3], True)           # 관리자가 남의 것: 대행
        self.assertEqual(self.code(user={"email": "lee@x.com"}), ("not_owner", 403))      # 접근 권한(grant)만 받은 사람(R3·R10)
        self.assertEqual(self.code(user=None), ("login", 401))

    def test_쿠버네티스에서만(self):
        self.assertEqual(self.code(user={"email": "kim@x.com"}, k8s_on=False), ("unsupported", 501))
        self.assertEqual(self.code(user={"email": "kim@x.com"}, sidecar=""), ("unsupported", 501))

    def target(self, profile, main="main", exists=True, listed=("default", "main", "research"), down=False):
        """(돌려준 이름 또는 오류 코드, 상태, Hermes 를 부른 횟수)."""
        pod = types.SimpleNamespace(id="p-root")
        api = mock.Mock()
        api.call.side_effect = routes.HermesError("down") if down else None
        api.call.return_value = {"profiles": [{"name": n, "is_default": n == "default"} for n in listed]}
        with mock.patch.object(primary, "primary_of", return_value=main), mock.patch.object(routes, "_api", return_value=api):
            try:
                return routes._target_profile(pod, profile, exists=exists), 200, api.call.call_count
            except routes._Denied as d:
                return d.code, d.status, api.call.call_count

    def test_대상_프로파일_검사_표(self):
        """protects=OMAI-1444 R5 회귀 계약(빈 값은 main, main 없으면 no_main)·§4-1 거절 순서·R4/D10(존재 확인은 exists 일 때만);
        fails_when=not_main 이 남거나 루트·임시 이름을 받거나 상태 읽기가 Hermes 를 부름; no_claim=실제 Hermes 목록 모양"""
        cases = [  # (이름, main, exists, Hermes 실패, 기대 (값, 상태, 호출 수))
            ("", "main", True, False, ("main", 200, 0)),                       # 빈 값은 지금처럼 main, Hermes 를 부르지 않는다
            ("", primary.ROOT, True, False, ("no_main", 409, 0)),
            ("main", "main", True, False, ("main", 200, 1)),
            ("research", "main", True, False, ("research", 200, 1)),           # not_main 은 없어졌다
            ("research", primary.ROOT, True, False, ("research", 200, 1)),     # main 없는 파드의 이름 있는 프로파일(Q2)
            ("default", "main", True, False, ("root_profile", 409, 0)),
            ("pcimp-abc123abc123", "main", True, False, ("bad_profile", 400, 0)),
            ("Bad Name", "main", True, False, ("bad_profile", 400, 0)),
            ("ghost", "main", True, False, ("no_profile", 404, 1)),
            ("research", "main", True, True, ("agent_unreachable", 502, 1)),
            ("ghost", "main", False, False, ("ghost", 200, 0)),                # 상태 읽기: 이름 규칙만 보고 DB 기록(없으면 빈 상태)
            ("default", "main", False, False, ("root_profile", 409, 0)),
        ]
        for name, main, exists, down, want in cases:
            with self.subTest(name=name, main=main, exists=exists, down=down):
                self.assertEqual(self.target(name, main=main, exists=exists, down=down), want)


class RoutesHttpTest(unittest.TestCase):
    """uvicorn + 실제 사이드카 + 가짜 Hermes 대시보드. 로그인이 꺼진 설치(관리자와 같다)."""

    @classmethod
    def setUpClass(cls):
        cls.old = {k: os.environ.get(k) for k in ("AAS_SIDECAR_TOKEN", "AAS_DASHBOARD_USER", "AAS_DASHBOARD_PASSWORD", "AAS_ALLOWED_HOSTS")}
        cls.root = Path(TMP.name) / "agent"
        (cls.root / "workspace").mkdir(parents=True)
        os.environ.update(AAS_SIDECAR_TOKEN=TOKEN, AAS_DASHBOARD_USER="u", AAS_DASHBOARD_PASSWORD="p")
        cls.sidecar = sc_server.make_server("127.0.0.1", 0, sc_ops.Ops(cls.root), TOKEN)
        threading.Thread(target=cls.sidecar.serve_forever, daemon=True).start()
        FakeDashboard.root = cls.root
        cls.dash = http.server.ThreadingHTTPServer(("127.0.0.1", 0), PcDashboard)
        threading.Thread(target=cls.dash.serve_forever, daemon=True).start()
        reg = Path(TMP.name) / "pods-pc.json"
        reg.write_text(json.dumps({"pods": [{
            "id": "w", "owner": "t@example.com", "hermes_home": "/nonexistent",
            "sidecar_url": f"http://127.0.0.1:{cls.sidecar.server_address[1]}",
            "dashboard_url": f"http://127.0.0.1:{cls.dash.server_address[1]}"}]}))
        server._auth = auth.Auth({"issuer": "https://accounts.google.com", "client_id": "", "client_secret": "", "domain": "",
                                  "public_url": "http://localhost:17900", "hours": 1, "users_file": Path(TMP.name) / "no-users.json"})
        server._registry = pods.Registry(reg)
        server.OFFICE = office_state.Office()
        server._hubs.clear()
        server._workspaces.clear()
        with store.connect() as conn:
            conn.executescript(primary.SCHEMA)
            conn.execute("DELETE FROM pod_primary WHERE pod='w'")
            conn.execute("INSERT INTO pod_primary (pod, profile, state, ts) VALUES ('w','main','templated','2026-10-17T00:00:00+09:00')")
        cls.patches = [mock.patch.object(routes, "_k8s_ready", return_value=True),
                       mock.patch.object(routes, "keeps", return_value={"env": 3, "channels": [], "shared_with": ["research"], "others": ["research"]})]
        for p in cls.patches:
            p.start()
        cls.httpd = aasserver.start()
        cls.port = cls.httpd.server_port

    @classmethod
    def tearDownClass(cls):
        for p in cls.patches:
            p.stop()
        cls.httpd.shutdown()
        cls.sidecar.shutdown()
        cls.dash.shutdown()
        server._hubs.clear()
        server._workspaces.clear()
        for k, v in cls.old.items():
            os.environ.pop(k, None)
            if v is not None:
                os.environ[k] = v
        server._auth = server._registry = None

    def setUp(self):
        with store.connect() as conn:
            conn.executescript(pc.SCHEMA)
            conn.execute("DELETE FROM pc_imports")
            conn.execute("DELETE FROM pc_exports")

    def req(self, method, path, body=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        c.request(method, path, body=body, headers={"X-AAS": "1"} if method != "GET" else {})
        r = c.getresponse()
        data = r.read()
        c.close()
        try:
            return r, json.loads(data or b"{}")
        except ValueError:
            raise AssertionError(f"{r.status} {data[:300]!r}") from None

    def put(self, blob, name="hermes-default.tar.gz"):
        return self.req("PUT", f"/api/profile/pc-import?pod=w&name={urllib.parse.quote(name)}", body=blob)

    def test_올리면_검사하고_숨은_이름으로_두며_취소하면_지운다(self):
        r, body = self.put(bundle({"SOUL.md": "나", "skills/a/a/SKILL.md": "---\nname: a\n---\n", "sessions/s.json": "{}"}))
        self.assertEqual(r.status, 200, body)
        self.assertEqual(body["state"], "uploaded")
        self.assertEqual(body["summary"]["counts"]["skills"], 1)
        self.assertEqual(body["keeps"]["shared_with"], ["research"])
        stored = self.root / pc.upload_path(body["id"])
        self.assertTrue(stored.is_file())
        self.assertTrue(stored.name.startswith("."))                       # 작업 폴더 목록에서 숨는다
        r, st = self.req("GET", "/api/profile/pc-import?pod=w")
        self.assertEqual((r.status, st["job"]["id"], st["profile"]), (200, body["id"], "main"))
        r, _ = self.req("POST", f"/api/profile/pc-import/cancel?pod=w&id={body['id']}")
        self.assertEqual(r.status, 200)
        self.assertFalse(stored.exists())
        self.assertEqual(pc.get(body["id"])["state"], "cancelled")

    def test_거절한_묶음은_바로_지우고_시작할_수_없다(self):
        r, body = self.put(bundle({"SOUL.md": "x"}, root="../x"))          # R4: 링크는 이제 걸러서 받는다. 경로 탈출로 거절을 본다
        self.assertEqual((r.status, body["state"], body["reason"]), (200, "rejected", "bad_path"))
        self.assertFalse((self.root / pc.upload_path(body["id"])).exists())
        r, err = self.req("POST", f"/api/profile/pc-import/start?pod=w&id={body['id']}")
        self.assertEqual((r.status, err["code"]), (409, "not_ready"))

    def test_지운_프로파일의_확인_단계는_시작하지_않는다(self):
        """protects=OMAI-1444 R2(끊긴 기록 profile='' 로 오퍼레이터 작업을 만들지 않음); fails_when=빈 프로파일로 시작; no_claim=-"""
        jid = pc.new_id()
        pc.record_upload(jid, "w", "", "a@x.com", "t@example.com", False, "x", 1, {"ok": True})
        r, err = self.req("POST", f"/api/profile/pc-import/start?pod=w&id={jid}")
        self.assertEqual((r.status, err["code"]), (409, "not_ready"))

    def test_진행_중이면_새로_올리지_못한다(self):
        jid = pc.new_id()
        pc.record_upload(jid, "w", "main", "a@x.com", "t@example.com", False, "x", 1, {"ok": True})
        self.assertTrue(pc.claim(jid, "w"))
        r, err = self.put(bundle({"SOUL.md": "x"}))
        self.assertEqual((r.status, err["code"]), (409, "busy_import"))

    def stored(self, job_id):
        return self.root / pc.upload_path(job_id), self.root / pc.secrets_path(job_id)

    def names(self, path):
        with tarfile.open(path, "r:gz") as tar:
            return sorted(m.name.split("/", 1)[1] for m in tar if "/" in m.name and m.isfile())

    def test_통째로_묶은_묶음은_걸러_두_묶음으로_둔다(self):
        """protects=기준 7(원본 삭제 → 내용·비밀 묶음 올림), 응답에 전체 이름 목록 없음; fails_when=원본이 남거나 비밀이 내용 묶음에 섞임; no_claim=실제 Hermes upload-stream 은 가짜 대시보드"""
        with mock.patch.object(routes, "dry_run_secrets", return_value=True) as dry:
            r, body = self.put(raw_profile_archive())
        self.assertEqual((r.status, body["state"]), (200, "uploaded"), body)
        content, secret = self.stored(body["id"])
        self.assertNotIn("google_token.json", self.names(content))
        self.assertIn("SOUL.md", self.names(content))
        self.assertEqual(self.names(secret), [".env", "google_token.json"])
        self.assertNotIn("secrets_index", body["summary"])
        self.assertTrue(body["summary"]["secrets_supported"])
        self.assertEqual(dry.call_count, 1)
        self.assertEqual(body["stages"], ["import", "config", "replace", "secrets", "env", "skills", "restart"])   # skills: 2026-10-27-011 D10
        r, _ = self.req("POST", f"/api/profile/pc-import/cancel?pod=w&id={body['id']}")
        self.assertEqual(r.status, 200)
        self.assertFalse(content.exists() or secret.exists())               # 취소는 두 묶음을 지운다

    def test_https_가_아니면_비밀_묶음이_없고_dry_run_도_없다(self):
        """protects=기준 6·R17·R26(비밀 없음이면 호출 0회); fails_when=http 에서 비밀이 올라감; no_claim=_secrets_ok 판정 규칙 자체는 server 시험"""
        with mock.patch.object(routes.files._View, "_secrets_ok", return_value=False), mock.patch.object(routes, "dry_run_secrets") as dry:
            r, body = self.put(raw_profile_archive())
        self.assertEqual(body["state"], "uploaded")
        self.assertFalse(body["summary"]["secrets_enabled"])
        self.assertFalse(self.stored(body["id"])[1].exists())
        dry.assert_not_called()

    def test_올리기_실패는_store_failed_이고_올린_것을_지운다(self):
        """protects=기준 7·R2; fails_when=반쯤 올린 묶음이 남거나 uploaded 로 기록; no_claim=화면 문구"""
        calls = []

        def push(auth, path, local):
            calls.append(path)
            return 200 if len(calls) == 1 else 502
        with mock.patch.object(routes.files, "push_file", side_effect=push), mock.patch.object(routes, "dry_run_secrets", return_value=True):
            r, body = self.put(raw_profile_archive())
        self.assertEqual((r.status, body["code"], body["state"], body["reason"]), (502, "agent_unreachable", "rejected", "store_failed"))
        self.assertEqual(len(calls), 2)
        content, secret = self.stored(body["id"])
        self.assertFalse(content.exists() or secret.exists())

    def test_새로_올리면_앞의_확인_단계를_닫고_묶음을_지운다(self):
        """protects=R18 교체; fails_when=앞 묶음이 남음; no_claim=-"""
        with mock.patch.object(routes, "dry_run_secrets", return_value=True):
            _r, first = self.put(raw_profile_archive())
            _r, second = self.put(bundle({"SOUL.md": "x"}))
        self.assertEqual((pc.get(first["id"])["state"], pc.get(first["id"])["reason"]), ("cancelled", "replaced"))
        self.assertFalse(any(p.exists() for p in self.stored(first["id"])))
        self.assertEqual(second["state"], "uploaded")

    def test_24시간_지나면_리더_점검이_닫는다(self):
        """protects=기준 8; fails_when=오래된 묶음이 남음; no_claim=리더 선출"""
        with mock.patch.object(routes, "dry_run_secrets", return_value=True):
            _r, body = self.put(raw_profile_archive())
        with store.connect() as conn:
            conn.execute("UPDATE pc_imports SET updated=? WHERE id=?", (pc._iso(pc._now() - timedelta(hours=25)), body["id"]))
        routes.recover_once(server.registry())
        self.assertEqual((pc.get(body["id"])["state"], pc.get(body["id"])["reason"]), ("cancelled", "expired"))
        self.assertFalse(any(p.exists() for p in self.stored(body["id"])))

    def test_다른_프로파일에도_올린다(self):
        """protects=OMAI-1444 §4-1(research 받아들임)·R8(채널 연결 파일은 main 이 아닌 대상에서 빠짐); fails_when=not_main 으로 거절하거나 채널 파일이 비밀 묶음에 들어감; no_claim=-"""
        blob = bundle({"SOUL.md": "x", "google_token.json": "{}", "slack_tokens.json": "{}", "pairing/a.json": "{}"})
        with mock.patch.object(routes, "dry_run_secrets", return_value=True):
            r, body = self.req("PUT", "/api/profile/pc-import?pod=w&profile=research&name=a.tar.gz", body=blob)
            self.assertEqual((r.status, body["state"], body["profile"]), (200, "uploaded", "research"), body)
            self.assertEqual(body["summary"]["channel_files_skipped"], ["pairing", "slack_tokens.json"])
            self.assertEqual(self.names(self.stored(body["id"])[1]), ["google_token.json"])
            r, main = self.req("PUT", "/api/profile/pc-import?pod=w&profile=main&name=a.tar.gz", body=blob)
        self.assertNotIn("channel_files_skipped", main["summary"])          # main 은 지금과 같다(R5)
        self.assertEqual(self.names(self.stored(main["id"])[1]), ["google_token.json", "pairing/a.json", "slack_tokens.json"])

    def test_없는_프로파일과_임시_이름은_거절한다(self):
        r, err = self.req("PUT", "/api/profile/pc-import?pod=w&profile=ghost&name=a.tar.gz", body=b"x")
        self.assertEqual((r.status, err["code"]), (404, "no_profile"))
        r, err = self.req("POST", "/api/profile/pc-export?pod=w&profile=pcimp-abc123abc123")
        self.assertEqual((r.status, err["code"]), (400, "bad_profile"))
        r, err = self.req("GET", "/api/profile/pc-import?pod=w&profile=default")
        self.assertEqual((r.status, err["code"]), (409, "root_profile"))

    def test_올리는_사이_대상이_사라지면_기록을_만들지_않고_묶음을_지운다(self):
        """protects=커밋 전 리뷰 2(올리는 도중 지우거나 이름을 바꾼 대상에 확인 단계가 남지 않음); fails_when=옛 이름에 uploaded 행이 생김; no_claim=Hermes 의 실제 삭제"""
        real = routes._target_profile
        calls = []

        def gone(pod, profile, exists=False):
            calls.append(exists)
            if len(calls) > 1:                                              # 처음 검사는 통과, 기록 직전 검사에서 없어졌다
                raise routes._Denied("no_profile", 404)
            return real(pod, profile, exists)
        before = set((self.root / pc.UPLOADS).glob(".import-*"))
        with mock.patch.object(routes, "_target_profile", side_effect=gone):
            r, err = self.req("PUT", "/api/profile/pc-import?pod=w&profile=research&name=a.tar.gz", body=bundle({"SOUL.md": "x"}))
        self.assertEqual((r.status, err["code"], calls), (404, "no_profile", [True, True]))
        self.assertIsNone(pc.latest("w", "research"))
        self.assertEqual(set((self.root / pc.UPLOADS).glob(".import-*")) - before, set())

    def test_keeps_를_저장하기_전의_확인_단계는_keeps_없이_준다(self):
        """protects=커밋 전 리뷰 1(배포 전 기록·올리기 도중에 빈 keeps {} 를 보내지 않음); fails_when=keeps:{} 로 화면이 깨짐; no_claim=화면 기본값(Vitest)"""
        jid = pc.new_id()
        pc.record_upload(jid, "w", "main", "a@x.com", "t@example.com", False, "x", 1, {"ok": True})
        r, st = self.req("GET", "/api/profile/pc-import?pod=w&profile=main")
        self.assertEqual((r.status, st["job"]["id"]), (200, jid))
        self.assertNotIn("keeps", st["job"])

    def test_상태_읽기는_Hermes_를_부르지_않고_저장한_keeps_와_busy_profile_을_준다(self):
        """protects=R14(keeps 는 올릴 때 저장)·R4/D10(상태 GET 은 DB 만)·R3(busy_profile); fails_when=상태 GET 이 keeps 를 다시 계산하거나 Hermes 를 부름; no_claim=화면 막기"""
        _r, body = self.put(bundle({"SOUL.md": "x"}))
        self.assertEqual(pc.get(body["id"])["summary"]["keeps"]["shared_with"], ["research"])
        PcDashboard.gets.clear()
        with mock.patch.object(routes, "keeps", side_effect=AssertionError("상태 읽기에서 다시 계산함")):
            r, st = self.req("GET", "/api/profile/pc-import?pod=w&profile=main")
            r2, empty = self.req("GET", "/api/profile/pc-import?pod=w&profile=ghost")
        self.assertEqual((r.status, st["job"]["keeps"]["shared_with"]), (200, ["research"]))
        self.assertNotIn("keeps", st["job"]["summary"])
        self.assertEqual((r2.status, empty["job"], empty["profile"]), (200, None, "ghost"))   # 없는 이름은 빈 상태
        self.assertEqual(PcDashboard.gets, [])
        self.assertNotIn("busy_profile", st)
        jid = pc.new_id()
        pc.record_upload(jid, "w", "research", "a@x.com", "t@example.com", False, "x", 1, {"ok": True})
        self.assertTrue(pc.claim(jid, "w"))
        _r, st = self.req("GET", "/api/profile/pc-import?pod=w&profile=main")
        self.assertEqual(st["busy_profile"], "research")
        _r, own = self.req("GET", "/api/profile/pc-import?pod=w&profile=research")
        self.assertNotIn("busy_profile", own)                               # 자기 진행은 job 으로 본다
        r, err = self.put(bundle({"SOUL.md": "x"}))
        self.assertEqual((r.status, err["code"], err["profile"]), (409, "busy_import", "research"))

    def test_다른_프로파일에_올려도_이_프로파일의_확인_단계는_남는다(self):
        """protects=R6 같은 프로파일만 닫음; fails_when=research 확인 단계가 main 올리기로 닫힘; no_claim=-"""
        _r, research = self.req("PUT", "/api/profile/pc-import?pod=w&profile=research&name=a.tar.gz", body=bundle({"SOUL.md": "x"}))
        _r, first = self.put(bundle({"SOUL.md": "x"}))
        _r, second = self.put(bundle({"SOUL.md": "y"}))
        self.assertEqual(pc.get(research["id"])["state"], "uploaded")
        self.assertTrue(self.stored(research["id"])[0].exists())
        self.assertEqual((pc.get(first["id"])["state"], pc.get(first["id"])["reason"]), ("cancelled", "replaced"))
        self.assertEqual(second["state"], "uploaded")

    def test_내보내기는_전용_한도에서_돌고_한도가_차면_기다리지_않고_429(self):
        """내보내기는 Hermes 를 최대 600초 기다린다. 공용 요청 스레드(64개)에서 돌면 몰릴 때 다른 화면 요청이 밀린다 —
        전용 한도에서 돌리고, 차면 바로 「잠시 뒤 다시」를 돌려준다(스펙 2026-10-24-002 R15). no_claim=실제 600초 내보내기"""
        full = types.SimpleNamespace(available_tokens=0)
        with mock.patch.object(routes, "_export_limiter", return_value=full):
            r, out = self.req("POST", "/api/profile/pc-export?pod=w&profile=research")
        self.assertEqual((r.status, out["code"]), (429, "busy_export"), out)

    def test_내보내기는_공용_스킬_수를_알린다(self):
        """protects=R16 shared_skills; fails_when=칸이 없거나 다른 프로파일의 공용 스킬을 셈; no_claim=실제 hermes profile export"""
        rows = [("research", "main", Path("a")), ("research", "main", Path("b")), ("other", "x", Path("c"))]
        with mock.patch.object(routes.hermes_reader, "shared_skill_files", return_value=rows):
            r, out = self.req("POST", "/api/profile/pc-export?pod=w&profile=research")
            self.assertEqual((r.status, out["profile"], out["shared_skills"]), (200, "research", {"n": 2, "sources": ["main"]}), out)
            self.assertEqual(routes.shared_skills_of(types.SimpleNamespace(hermes_home=None), "main"), {"n": 0, "sources": []})
        with mock.patch.object(routes.hermes_reader, "shared_skill_files", side_effect=OSError("x")):
            self.assertEqual(routes.shared_skills_of(types.SimpleNamespace(hermes_home=None), "research"), {"n": 0, "sources": []})



class ProfileGuardTest(unittest.TestCase):
    """OMAI-1444 R1·R2·R11·ROV4·ROV6·ROV8·ROV9: 프로파일 이름 바꾸기·삭제와 가져오기 기록, 임시 프로파일(pcimp-) 숨김·예약. Hermes 는 대역."""
    POD = types.SimpleNamespace(id="pg")
    ROWS = [{"name": "default", "is_default": True}, {"name": "main", "is_default": False}, {"name": "research", "is_default": False}]

    def setUp(self):
        from aas.assets import files as afiles
        with store.connect() as conn:
            conn.executescript(pc.SCHEMA)
            conn.execute("DELETE FROM pc_imports WHERE pod='pg'")
        for key in ("soul:research", "soul:study"):
            afiles.forget_key("pg", key)

    tearDown = setUp

    def act(self, body, rows=None):
        """(_profile_action 결과 또는 예외, Hermes 호출 목록, _drop_bundles 대역)."""
        api = mock.Mock()
        api.call.return_value = {}
        hub = types.SimpleNamespace(auth=None, status=lambda: {"sessions": []}, busy_sessions=lambda name: [],   # 지우기의 세션 닫기(2026-11-07-001)
                                    begin_delete=lambda name: [], end_delete=lambda name: None, close_for_delete=lambda name: [],
                                    announce_closed=lambda sids, deleted: None)
        with mock.patch.object(server, "HermesAPI", return_value=api), mock.patch.object(server, "hub", return_value=hub), \
                mock.patch.object(server, "_profile_rows", return_value=rows or self.ROWS), mock.patch.object(server, "_is_primary", return_value=False), \
                mock.patch.object(routes, "_drop_bundles") as drop:
            try:
                out = server._profile_action(self.POD, body, "kim@x.com")
            except Exception as exc:                                         # noqa: BLE001
                out = exc
        return out, [c.args[:2] for c in api.call.call_args_list], drop

    def record(self, profile="research", state="uploaded", result=None):
        jid = pc.new_id()
        pc.record_upload(jid, "pg", profile, "kim@x.com", "kim@x.com", False, "x", 1, {"ok": True})
        if state == "running":
            self.assertTrue(pc.claim(jid, "pg"))
        elif state != "uploaded":
            pc._set(jid, state=state, result=result or {})
        return jid

    RENAME = {"action": "rename", "name": "research", "new_name": "study"}
    DELETE = {"action": "delete", "name": "research", "confirm": "research", "skip_export": True}

    def test_가져오는_중이면_이름_바꾸기와_삭제를_409_로_거절한다(self):
        """protects=R1 running 거절(reason busy_import, Hermes 요청 없음), 다른 프로파일 진행은 막지 않음; fails_when=진행 중에 지우거나 400 으로 거절; no_claim=claim 과의 경쟁(한계)"""
        self.record(state="running")
        for body in (self.RENAME, self.DELETE):
            with self.subTest(action=body["action"]):
                out, calls, _drop = self.act(body)
                self.assertIsInstance(out, server.files.FileError)
                self.assertEqual((out.code, out.reason), (409, "busy_import"))
                self.assertEqual([c for c in calls if c[0] in ("PATCH", "DELETE")], [])
        out, calls, _drop = self.act({**self.DELETE, "skip_export": False})         # 미리 내보내기 전에 거절해 묶음이 헛되이 남지 않는다
        self.assertEqual((getattr(out, "code", None), [c for c in calls if c[0] == "POST"]), (409, []))
        out, calls, _drop = self.act({**self.DELETE, "confirm": "wrong"})           # 다른 검사가 먼저다(ROV4)
        self.assertIsInstance(out, ValueError)
        out, calls, _drop = self.act({"action": "rename", "name": "main", "new_name": "m2"})
        self.assertEqual(out, {"ok": True, "name": "m2"})                            # 다른 프로파일의 진행은 막지 않는다

    def test_이름을_바꾸면_확인_단계는_취소하고_기록과_SOUL_판이_따라간다(self):
        """protects=R1 uploaded 취소·묶음 지움, R2 move, ROV9 soul: 키; fails_when=확인 단계가 옛 이름에 남거나 결과·판이 사라짐; no_claim=-"""
        from aas.assets import files as afiles
        done = self.record(state="done", result={"secrets_needed": ["AK"]})
        pending = self.record()
        afiles.remember_version("pg", "soul:research", "성격\n", "kim@x.com", "저장")
        out, calls, drop = self.act(self.RENAME)
        self.assertEqual(out, {"ok": True, "name": "study"})
        self.assertIn(("PATCH", "/api/profiles/research"), calls)
        self.assertEqual((pc.get(pending)["state"], pc.get(pending)["reason"]), ("cancelled", "profile_changed"))
        drop.assert_called_once_with(self.POD, pending)
        self.assertEqual(pc.latest("pg", "study")["id"], done)
        self.assertIsNone(pc.latest("pg", "research"))
        self.assertEqual([i["code"] for i in pc.issues_for("pg", "study")], ["pc_import_secrets"])
        self.assertEqual((len(afiles.versions("pg", "soul:study")), afiles.versions("pg", "soul:research")), (1, []))

    def test_지우면_확인_단계는_취소하고_기록을_끊고_SOUL_판을_지운다(self):
        """protects=R1·R2 detach·ROV9; fails_when=같은 이름 새 프로파일에 옛 결과·판이 보임; no_claim=-"""
        from aas.assets import files as afiles
        done = self.record(state="done", result={"secrets_needed": ["AK"]})
        pending = self.record()
        afiles.remember_version("pg", "soul:research", "성격\n", "kim@x.com", "저장")
        out, calls, drop = self.act(self.DELETE)
        self.assertEqual(out["deleted"], "research")
        self.assertIn(("DELETE", "/api/profiles/research"), calls)
        drop.assert_called_once_with(self.POD, pending)
        self.assertIsNone(pc.latest("pg", "research"))
        self.assertEqual((pc.get(done)["profile"], pc.get(done)["state"]), ("", "done"))
        self.assertEqual(afiles.versions("pg", "soul:research"), [])

    def test_pcimp_이름은_만들기와_이름_바꾸기에서_거절한다(self):
        """protects=R11·ROV6 이름 예약; fails_when=임시 프로파일 이름으로 만들 수 있음; no_claim=-"""
        for body in ({"action": "create", "name": "pcimp-x"}, {"action": "rename", "name": "research", "new_name": "pcimp-x"}):
            with self.subTest(action=body["action"]):
                out, calls, _drop = self.act(body)
                self.assertIsInstance(out, ValueError)
                self.assertIn("pcimp-", str(out))
                self.assertEqual([c for c in calls if c[0] in ("POST", "PATCH")], [])

    def test_화면_목록은_임시_프로파일을_숨기고_가져오는_중을_표시한다(self):
        """protects=R11(목록에서만 숨김)·DD4 importing·ROV11(캐시 행을 고치지 않음); fails_when=pcimp- 가 보이거나 캐시가 바뀜; no_claim=화면 Pill"""
        rows = [*self.ROWS, {"name": "pcimp-abc123abc123", "is_default": False}]
        self.record(state="running")
        with mock.patch.object(server, "_profile_rows", return_value=rows), mock.patch.object(primary, "hide_root", return_value="show"):
            got = server._visible_profile_rows(self.POD, admin=True)
        self.assertEqual([(r["name"], r["importing"]) for r in got], [("default", False), ("main", False), ("research", True)])
        self.assertTrue(all("importing" not in r for r in rows))
        self.assertEqual(server.owner_guard.profile_count([r["name"] for r in rows], False), 3)   # 상한 셈에서도 뺀다(ROV8)

    def test_마켓_설치도_pcimp_이름을_거절한다(self):
        from aas.market import marketplace
        with mock.patch.object(marketplace, "install_state", return_value={"enabled": True, "reason": ""}):
            with self.assertRaises(marketplace.MarketError) as cm:
                marketplace.request_install("pg", "hermes", {"version": "1.0.0", "kind": "agent"}, "1.0.0", "pcimp-x", "install", "a@x.io", [])
        self.assertIn("pcimp-", str(cm.exception))


class PlanTest(unittest.TestCase):
    """확인 화면의 미리 나누기(DD7·R23·R24·OV-2)와 dry-run 분류(R26). 사이드카·쿠버네티스는 대역."""

    def setUp(self):
        with store.connect() as conn:
            conn.executescript(pc.SCHEMA)
            conn.execute("DELETE FROM pc_imports")
        routes._plans.clear()
        self.checked = []
        self.existing = {"profiles/main/google_token.json"}
        backend = types.SimpleNamespace(check=lambda rel: self.checked.append(rel) or {"exists": rel in self.existing})
        self.ws = types.SimpleNamespace(supported=lambda: True, backend=backend)
        self.pod = types.SimpleNamespace(id="p1")

    tearDown = setUp

    def job(self, files):
        jid = pc.new_id()
        summary = {"ok": True, "secrets_bundle": True, "secrets_enabled": True, "secrets": {"mcp_files": 0, "channel_files": 0},
                   "secrets_index": {"files": files, "env_keys": ["EXISTING_KEY", "NEW_KEY", "OPENAI_API_KEY"]}}
        pc.record_upload(jid, "p1", "main", "a", "a", False, "x", 1, summary)
        return pc.get(jid)

    LISTING = {"vars": {"EXISTING_KEY": {"is_set": True, "category": "tool"}, "OPENAI_API_KEY": {"is_set": False, "category": "provider"}}}

    def test_미리_나누고_본_계획을_저장하고_1분_동안_다시_묻지_않는다(self):
        """protects=DD7·OV-2·R24 캐시; fails_when=숫자가 틀리거나 매번 사이드카를 부름; no_claim=실제 사이드카 check"""
        job = self.job(["google_token.json", "mcp-tokens/a.json"])
        with mock.patch.object(server, "workspace_for", return_value=self.ws):
            plan = routes.secrets_plan(self.pod, "main", job, self.LISTING)
            again = routes.secrets_plan(self.pod, "main", job, self.LISTING)
        self.assertTrue(plan["known"])
        self.assertEqual((plan["files_replace"], plan["files_new"]), (["google_token.json"], ["mcp-tokens/a.json"]))
        self.assertEqual((plan["env_add"], plan["env_exists"], plan["env_blocked"]), (["NEW_KEY"], ["EXISTING_KEY"], ["OPENAI_API_KEY"]))
        self.assertEqual(len(self.checked), 2)                                  # 두 번째는 캐시
        self.assertIs(again, plan)
        self.assertEqual(pc.get(job["id"])["summary"]["secrets_plan_seen"]["env_add"], ["NEW_KEY"])
        routes.forget_plan("p1")                                                # 비밀값을 바꾸면 다시 계산한다(OV-8)
        with mock.patch.object(server, "workspace_for", return_value=self.ws):
            routes.secrets_plan(self.pod, "main", job, self.LISTING)
        self.assertEqual(len(self.checked), 4)

    def test_모르면_known_false(self):
        """protects=R23(목록 못 읽음)·R24(50개 초과); fails_when=0 을 확신 있게 보임; no_claim=화면 문구"""
        with mock.patch.object(server, "workspace_for", return_value=self.ws):
            self.assertFalse(routes.secrets_plan(self.pod, "main", self.job(["google_token.json"]), None)["known"])
            many = routes.secrets_plan(self.pod, "main", self.job([f"mcp-tokens/{i}.json" for i in range(51)]), self.LISTING)
        self.assertFalse(many["known"])
        self.assertEqual(self.checked, [])                                      # 상한을 넘으면 묻지도 않는다

    def test_dry_run_분류(self):
        """protects=R26 422 만 false, 그 밖은 None; fails_when=일시 오류를 미지원으로 단정; no_claim=실제 API 서버의 dryRun 처리"""
        client = mock.Mock(namespace="ns")
        pod = types.SimpleNamespace(id="p1")
        with mock.patch.object(routes.k8s, "client", return_value=client):
            client.create_task.return_value = {}
            self.assertTrue(routes.dry_run_secrets(pod, "main", "abc"))
            self.assertEqual(client.create_task.call_args.kwargs, {"dry_run": True, "timeout": 3.0})
            client.create_task.side_effect = k8s.K8sError("Unsupported value", 422)
            self.assertFalse(routes.dry_run_secrets(pod, "main", "abc"))
            client.create_task.side_effect = k8s.K8sError("down", 503)
            self.assertIsNone(routes.dry_run_secrets(pod, "main", "abc"))
        with mock.patch.object(routes.k8s, "client", return_value=None):
            self.assertIsNone(routes.dry_run_secrets(pod, "main", "abc"))

    def test_keeps_는_다른_이름_있는_프로파일을_알린다(self):
        """protects=OMAI-1444 DD10·ROV3 keeps.others(루트·임시·대상 제외); fails_when=게이트웨이 안내 조건이 틀림; no_claim=화면 안내"""
        rows = [{"name": "default", "is_default": True}, {"name": "main"}, {"name": "research", "channels": [{"name": "slack"}]},
                {"name": "pcimp-abc123abc123"}, {"name": "zeta"}]
        pod = types.SimpleNamespace(id="p1", hermes_home=None)
        with mock.patch.object(server, "_profile_rows", return_value=rows), mock.patch.object(routes, "_env_listing", return_value=None), \
                mock.patch.object(routes.hermes_reader, "shared_skill_files", return_value=[]), mock.patch.object(routes.hermes_reader, "skill_files", return_value=[]):
            got = routes.keeps(pod, "research")
        self.assertEqual((got["others"], got["channels"]), (["main", "zeta"], ["slack"]))

    def test_방_알림의_누가(self):
        """protects=OMAI-1444 R15(실제 관리자 대행은 「관리자」, 팀 관리자·주인은 표시 이름); fails_when=이메일이 그대로 보이거나 팀 관리자를 관리자로 씀; no_claim=화면 문장"""
        a = types.SimpleNamespace(enabled=True)
        reg = types.SimpleNamespace(is_admin=lambda u: (u or {}).get("email") == "boss@x.com")
        with mock.patch.object(server, "auth", return_value=a), mock.patch.object(server, "registry", return_value=reg), \
                mock.patch.object(routes.office, "display_name", side_effect=lambda e: {"kim@x.com": "김주인"}.get(e, e.split("@")[0])), \
                mock.patch.object(routes, "tr", side_effect=lambda ko, en: ko):
            self.assertEqual(routes._notice_who({"email": "boss@x.com"}, True), "관리자")
            self.assertEqual(routes._notice_who({"email": "kim@x.com"}, False), "김주인")
            self.assertEqual(routes._notice_who({"email": "lead@x.com"}, False), "lead")       # 팀 관리자는 이름(by_admin 아님)

    def test_env_이름을_못_읽으면_None(self):
        """protects=R25 _env_names 는 실패를 빈 집합과 구별; fails_when=빈 집합으로 보여 덮어씀; no_claim=-"""
        api = mock.Mock()
        api.call.side_effect = routes.HermesError("down")
        with mock.patch.object(routes, "_api", return_value=api):
            self.assertIsNone(routes._env_names(self.pod, "main"))


if __name__ == "__main__":
    unittest.main()
