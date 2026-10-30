# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""프로파일 인증 파일(JSON) 서버(스펙 2026-10-22-004): 칸 이름, 내용 검사, 바꾼 사람 기록·판정, 올리기·지우기 흐름, 임시본 정리, 변경 기록."""
import os
import sys
import tempfile
import types
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aas.common import store  # noqa: E402
from aas.fleet import k8s  # noqa: E402
from aas.ops import changes  # noqa: E402
from aas.web import credential_files as cf, pc_import_routes as pcr  # noqa: E402

MARK = "SECRET-MARKER-7f3a"                                  # 내용이 응답·기록·예외에 새지 않는지 보는 표지
POD = "cf-test-pod"


def _clean():
    with cf._conn() as conn:
        conn.execute("DELETE FROM credential_files WHERE pod LIKE 'cf-test-%'")
        conn.execute("DELETE FROM credential_staged WHERE pod LIKE 'cf-test-%'")
    with store.connect() as conn:
        conn.execute("DELETE FROM usage WHERE pod LIKE 'cf-test-%'")


class FakeWs:
    def __init__(self, ensure=True):
        self.api = types.SimpleNamespace(auth=object())
        self.deleted, self._ensure = [], ensure

    def ensure(self, folder):
        return self._ensure

    def delete(self, path):
        self.deleted.append(path)


class SlotTest(unittest.TestCase):
    def test_칸_이름만_받고_경로는_받지_않는다(self):
        self.assertEqual(cf.slot_path("google_client_secret"), "google_client_secret.json")
        self.assertEqual(cf.slot_path("google_token"), "google_token.json")
        self.assertEqual(cf.slot_path("secret:omdm"), "secrets/omdm.json")
        for bad in ("auth", "auth.json", "secret:../auth", "secret:Omdm", "secret:a.b", "secret:", "secret:a/b",
                    "../google_token.json", "/etc/passwd", "secret:" + "a" * 64, "secret:a\x00", ""):
            with self.subTest(bad=bad), self.assertRaises(cf.Fail):
                cf.slot_path(bad)

    def test_칸과_경로는_서로_돌아온다(self):
        for slot in ("google_client_secret", "google_token", "secret:omdm", "secret:a_b-1"):
            self.assertEqual(cf.slot_of(cf.slot_path(slot)), slot)


class ContentTest(unittest.TestCase):
    def code(self, path, data):
        try:
            cf.check_content(path, data)
        except cf.Fail as f:
            self.assertNotIn(MARK, repr(f) + repr(f.extra))
            return f.code
        return ""

    def test_검사_표(self):
        rows = [
            ("google_token.json", b"", "empty"),
            ("google_token.json", b"{" + b" " * cf.MAX_BYTES + b"}", "too_large"),
            ("google_token.json", b"\xef\xbb\xbf{}", "not_utf8"),
            ("google_token.json", b"\xff\xfe{}", "not_utf8"),
            ("google_token.json", f"{{{MARK}".encode(), "not_json"),
            ("google_token.json", b"[1]", "bad_shape"),
            ("google_token.json", f'{{"token": "{MARK}"}}'.encode(), ""),
            ("google_client_secret.json", b'{"other": {}}', "bad_shape"),
            ("google_client_secret.json", b'{"installed": "x"}', "bad_shape"),
            ("google_client_secret.json", b'{"installed": {"client_id": "x"}}', ""),
            ("google_client_secret.json", b'{"web": {}}', ""),
            ("secrets/omdm.json", b"[1, 2]", ""),
            ("secrets/omdm.json", b'"text"', "bad_shape"),
        ]
        for path, data, want in rows:
            with self.subTest(path=path, want=want):
                self.assertEqual(self.code(path, data), want)


class RecordTest(unittest.TestCase):
    def tearDown(self):
        _clean()

    def test_기록_바꾸기_이름_바꾸기_지우기(self):
        cf.record(POD, "main", "google_token.json", "kim@x.com", "team", 111)
        cf.record(POD, "main", "google_token.json", "lee@x.com", "", 222)
        got = cf.changes_of(POD, "main")["google_token.json"]
        self.assertEqual((got["by_user"], got["role"], int(got["mtime_ns"])), ("lee@x.com", "", 222))
        cf.move_profile(POD, "main", "work")
        self.assertEqual(cf.changes_of(POD, "main"), {})
        self.assertIn("google_token.json", cf.changes_of(POD, "work"))
        cf.detach_profile(POD, "work")
        self.assertEqual(cf.changes_of(POD, "work"), {})

    def test_나노초_큰_값도_그대로(self):
        big = 1_761_200_000_123_456_789
        cf.record(POD, "main", "secrets/a.json", "kim@x.com", "", big)
        self.assertEqual(int(cf.changes_of(POD, "main")["secrets/a.json"]["mtime_ns"]), big)

    def test_바꾼_사람_판정(self):
        rec = {"by_user": "kim@x.com", "role": "team", "ts": "t", "mtime_ns": 5}
        self.assertEqual(cf.who_view(None, 5), {"changed_by": None, "outside": True})
        same = cf.who_view(rec, 5)
        self.assertEqual(same["changed_by"]["who"], "kim@x.com")
        self.assertTrue(same["by_other"])
        self.assertNotIn("outside_after", same)
        later = cf.who_view(rec, 9)                                # 토큰 갱신 등 화면 밖 변경 뒤에도 사람·태그가 남는다(R16)
        self.assertTrue(later["outside_after"])
        self.assertTrue(later["by_other"])
        self.assertEqual(later["changed_by"]["who"], "kim@x.com")
        self.assertNotIn("outside_after", cf.who_view(rec, None))   # 옛 사이드카(mtime_ns 없음)는 판정하지 않는다
        self.assertFalse(cf.who_view({**rec, "role": ""}, 5)["by_other"])


class PutRemoveTest(unittest.TestCase):
    pod = types.SimpleNamespace(id=POD)

    def tearDown(self):
        _clean()

    def put(self, task, data=b'{"token": "' + MARK.encode() + b'"}', push=200, ws=None):
        ws = ws or FakeWs()
        pushed = []
        with mock.patch.object(cf.files, "push_bytes", side_effect=lambda auth, path, d: pushed.append((path, d)) or push), \
                mock.patch.object(store, "log_usage") as log:
            try:
                out = cf.put(self.pod, "main", "google_token.json", data, "kim@x.com", "team", ws=ws, task=task)
            except cf.Fail as f:
                out = f
            self.assertFalse(log.called)                            # 기록은 경로(file_route)가 남긴다 — 내용과 함께 남기지 않는다
        return out, pushed, ws

    def test_올리면_숨은_임시본으로_넘기고_오퍼레이터_시각을_기록한다(self):
        calls = []

        def task(pod, kind, profile, source, backup, who, wait, extra):
            calls.append((kind, profile, backup, wait, extra))
            return "[WRITTEN] 1761200000123456789"
        out, pushed, ws = self.put(task)
        self.assertEqual(out, {"ok": True, "path": "google_token.json", "mtime_ns": 1761200000123456789})
        (path, data), = pushed
        self.assertRegex(path, r"^workspace/uploads/\.cred-[0-9a-f]{16}\.json$")
        self.assertIn(MARK.encode(), data)
        kind, profile, backup, wait, extra = calls[0]
        self.assertEqual((kind, profile, wait, extra), ("CredentialFilePut", "main", cf.TASK_WAIT, {"fileName": "google_token.json"}))
        self.assertIn(backup, path)
        self.assertEqual(int(cf.changes_of(POD, "main")["google_token.json"]["mtime_ns"]), 1761200000123456789)
        self.assertEqual(ws.deleted, [])                            # 성공하면 오퍼레이터가 지웠다
        with cf._conn() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) n FROM credential_staged WHERE pod=?", (POD,)).fetchone()["n"], 0)
        self.assertNotIn(MARK, repr(out))

    def test_실패는_코드로_바꾸고_임시본을_지운다(self):
        rows = [(RuntimeError(f"[INVALID] {MARK}"), "invalid", 400),
                (RuntimeError("[NOSOURCE] x"), "nosource", 409),
                (RuntimeError("[TIMEOUT] 작업이 정해진 시간 안에 끝나지 않았습니다"), "timeout", 504),
                (k8s.K8sError("unsupported", 422), "operator_outdated", 501),
                (RuntimeError("알 수 없는 작업 종류입니다: \"CredentialFilePut\""), "operator_outdated", 501),
                (RuntimeError("boom"), "task_failed", 502)]
        for exc, code, status in rows:
            with self.subTest(code=code):
                def task(*a, exc=exc, **k):
                    raise exc
                out, pushed, ws = self.put(task)
                self.assertIsInstance(out, cf.Fail)
                self.assertEqual((out.code, out.status), (code, status))
                self.assertEqual(ws.deleted, [pushed[0][0]])
                self.assertNotIn(MARK, repr(out))
                self.assertEqual(cf.changes_of(POD, "main"), {})

    def test_결과_단어가_이상하면_실패(self):
        out, pushed, ws = self.put(lambda *a, **k: "[WRITTEN] abc")
        self.assertEqual(out.code, "task_failed")
        self.assertEqual(ws.deleted, [pushed[0][0]])

    def test_올리기_실패와_내용_오류는_작업을_만들지_않는다(self):
        never = mock.Mock(side_effect=AssertionError("작업을 만들면 안 된다"))
        out, _p, ws = self.put(never, push=502)
        self.assertEqual(out.code, "agent_unreachable")
        out, pushed, _w = self.put(never, data=b"not json")
        self.assertEqual((out.code, pushed), ("not_json", []))
        out, pushed, _w = self.put(never, ws=FakeWs(ensure=False))
        self.assertEqual((out.code, pushed), ("agent_unreachable", []))

    def test_지우기(self):
        cf.record(POD, "main", "secrets/omdm.json", "kim@x.com", "", 1)
        seen = []
        out = cf.remove(self.pod, "main", "secrets/omdm.json", "kim@x.com",
                        task=lambda pod, kind, profile, src, backup, who, wait, extra: seen.append((kind, extra)) or "[REMOVED]")
        self.assertEqual(out, {"ok": True, "path": "secrets/omdm.json"})
        self.assertEqual(seen, [("CredentialFileRemove", {"fileName": "secrets/omdm.json"})])
        self.assertEqual(cf.changes_of(POD, "main"), {})


class ListingTest(unittest.TestCase):
    def tearDown(self):
        _clean()

    def test_정해진_칸은_늘_보이고_secrets_는_있는_것만(self):
        cf.record(POD, "main", "google_token.json", "kim@x.com", "admin", 7)
        stats = {"profiles/main/google_client_secret.json": {"exists": False},
                 "profiles/main/google_token.json": {"exists": True, "type": "file", "mtime": 1.5, "mtime_ns": 8}}
        backend = types.SimpleNamespace(
            stat_now=lambda rel: stats[rel],
            list_now=lambda rel, pat: [{"path": "profiles/main/secrets/omdm.json", "type": "file", "mtime": 2.0, "mtime_ns": 3},
                                       {"path": "profiles/main/secrets/sub.json", "type": "dir", "mtime": 2.0, "mtime_ns": 3},
                                       {"path": "profiles/main/secrets/Bad.json", "type": "file", "mtime": 2.0, "mtime_ns": 3}])
        out = cf.listing(types.SimpleNamespace(id=POD), "main", backend=backend, reason="", can_edit=True, admin=True,
                         names=lambda email: {"kim@x.com": "김민수"}.get(email, email.split("@")[0]))
        rows = {r["path"]: r for r in out["rows"]}
        self.assertEqual(rows["google_token.json"]["changed_by"]["name"], "김민수")
        self.assertEqual(rows["google_client_secret.json"], {"slot": "google_client_secret", "path": "google_client_secret.json", "exists": False})
        tok = rows["google_token.json"]
        self.assertEqual((tok["type"], tok["changed_by"]["who"], tok["by_other"], tok.get("outside_after")), ("file", "kim@x.com", True, True))
        self.assertEqual((rows["secrets/omdm.json"]["slot"], rows["secrets/omdm.json"]["outside"]), ("secret:omdm", True))
        self.assertEqual(rows["secrets/sub.json"]["type"], "unknown")
        self.assertEqual((rows["secrets/Bad.json"]["slot"], rows["secrets/Bad.json"]["type"]), ("", "unknown"))
        self.assertTrue(out["can_edit"])
        self.assertNotIn("auth.json", rows)

    def test_관리자가_아니면_이메일을_주지_않고_이름만(self):
        cf.record(POD, "main", "google_token.json", "kim@x.com", "team", 7)
        backend = types.SimpleNamespace(stat_now=lambda rel: {"exists": True, "type": "file", "mtime": 1.0, "mtime_ns": 7} if rel.endswith("google_token.json") else {"exists": False},
                                        list_now=lambda rel, pat: [])
        out = cf.listing(types.SimpleNamespace(id=POD), "main", backend=backend, reason="", can_edit=True, admin=False,
                         names=lambda email: "김민수")
        by = next(r for r in out["rows"] if r["path"] == "google_token.json")["changed_by"]
        self.assertEqual(by["name"], "김민수")
        self.assertNotIn("who", by)
        self.assertNotIn("kim@x.com", repr(out))

    def test_사유가_있으면_바꿀_수_없다(self):
        backend = types.SimpleNamespace(stat_now=lambda rel: {"exists": False}, list_now=lambda rel, pat: [])
        out = cf.listing(types.SimpleNamespace(id=POD), "main", backend=backend, reason="operator_outdated", can_edit=True, admin=True)
        self.assertEqual((out["can_edit"], out["reason"], out["admin"]), (False, "operator_outdated", True))


class SupportTest(unittest.TestCase):
    def test_오퍼레이터_지원_판정(self):
        class E(Exception):
            def __init__(self, code):
                super().__init__("x")
                self.code = code
        pod = types.SimpleNamespace(id=POD)
        for raised, want in ((None, ""), (E(422), "operator_outdated"), (E(500), "operator_unreachable"), (TimeoutError(), "operator_unreachable")):
            client = types.SimpleNamespace(namespace="ns")
            client.create_task = mock.Mock(side_effect=raised)
            with self.subTest(want=want), mock.patch.object(k8s, "client", return_value=client), mock.patch.object(k8s, "K8sError", E):
                self.assertEqual(cf.support(pod, "main"), want)
        with mock.patch.object(k8s, "client", return_value=None):
            self.assertEqual(cf.support(pod, "main"), "not_k8s")


class SweepTest(unittest.TestCase):
    def tearDown(self):
        _clean()

    def test_오래된_임시본만_지운다(self):
        cf._staged(POD, "workspace/uploads/.cred-old.json", True)
        with cf._conn() as conn:
            conn.execute("UPDATE credential_staged SET ts=? WHERE path=?",
                         ((datetime.now().astimezone() - timedelta(hours=1)).isoformat(timespec="seconds"), "workspace/uploads/.cred-old.json"))
        cf._staged(POD, "workspace/uploads/.cred-new.json", True)
        ws = FakeWs()
        reg = types.SimpleNamespace(pods=[types.SimpleNamespace(id=POD)])
        with mock.patch.object(cf.server, "workspace_for", return_value=ws):
            self.assertEqual(cf.sweep_once(reg), 1)
        self.assertEqual(ws.deleted, ["workspace/uploads/.cred-old.json"])
        with cf._conn() as conn:
            left = [r["path"] for r in conn.execute("SELECT path FROM credential_staged WHERE pod=?", (POD,)).fetchall()]
        self.assertEqual(left, ["workspace/uploads/.cred-new.json"])


class ChangesTest(unittest.TestCase):
    def tearDown(self):
        _clean()

    def test_팀_관리자의_변경이_주인_변경_기록에_보이고_파일로_간다(self):
        token = store.actor_role.set("team")
        try:
            store.log_usage("profile_credential_put", "kim@x.com main secrets/omdm.json", pod=POD)
            store.log_usage("profile_credential_clear_failed", "kim@x.com main google_token.json", pod=POD)
        finally:
            store.actor_role.reset(token)
        rows = changes.rows(pod=POD)
        put = next(r for r in rows if r["kind"] == "profile_credential_put")
        self.assertEqual((put["group"], put["profile"], put["file"], put.get("by_team_manager")), ("비밀값", "main", "secrets/omdm.json", True))
        failed = next(r for r in rows if r["kind"] == "profile_credential_clear")
        self.assertTrue(failed["failed"])
        self.assertNotIn("file", failed)                            # 실패한 줄에는 「보기」 링크가 없다


class RunTaskTest(unittest.TestCase):
    """run_task 의 extra·돌려주는 값(R9 회귀): extra 가 없으면 spec 이 지금과 같다."""

    def run_with(self, extra):
        made = []
        client = types.SimpleNamespace(namespace="ns", create_task=lambda body: made.append(body),
                                       get_task=lambda name: {"status": {"phase": "Succeeded", "message": "[WRITTEN] 5"}},
                                       delete_task=lambda name: None)
        with mock.patch.object(pcr.k8s, "client", return_value=client):
            msg = pcr.run_task(types.SimpleNamespace(id="p1"), "CredentialFilePut", "main", "", "b1", "kim@x.com", wait=1, extra=extra)
        return made[0]["spec"], msg

    def test_extra_는_spec_에_더하고_메시지를_돌려준다(self):
        spec, msg = self.run_with({"fileName": "google_token.json"})
        self.assertEqual(spec["fileName"], "google_token.json")
        self.assertEqual(msg, "[WRITTEN] 5")
        spec, _ = self.run_with(None)
        self.assertEqual(spec, {"agent": "p1", "profile": "main", "type": "CredentialFilePut", "backup": "b1", "requestedBy": "kim@x.com"})


class RouteTest(unittest.TestCase):
    """경로(file_route): https·칸 이름·64KB 상한(끝까지 읽지 않음)·PC 가져오기 중·지우기 확인·기록에 내용 없음."""
    pod = types.SimpleNamespace(id=POD)

    def tearDown(self):
        _clean()

    def call(self, method, query, chunks=(b"",), headers=None, secure=True, running=None, put_out=None):
        import asyncio
        import json as _json
        from starlette.requests import Request
        reads = []

        async def receive():
            i = len(reads)
            reads.append(i)
            if i < len(chunks):
                return {"type": "http.request", "body": chunks[i], "more_body": i < len(chunks) - 1}
            return {"type": "http.disconnect"}
        hdrs = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
        scope = {"type": "http", "method": method, "path": "/api/profile/credential-file", "query_string": query.encode(), "headers": hdrs}

        async def ctx(request, write):
            return self.pod, {"email": "kim@x.com"}, False, False
        view = types.SimpleNamespace(_secrets_ok=lambda: secure)
        logs = []
        with mock.patch.object(cf.pcr, "_ctx", ctx), mock.patch.object(cf.files, "_View", return_value=view), \
                mock.patch.object(cf.pcr, "_target_profile", side_effect=lambda pod, raw: raw or "main"), \
                mock.patch.object(cf.pc_import, "running", return_value=running), \
                mock.patch.object(cf.server, "_actor_role", return_value="team"), \
                mock.patch.object(cf.server, "auth", return_value=types.SimpleNamespace(enabled=True)), \
                mock.patch.object(cf.server, "workspace_for", return_value=FakeWs()), \
                mock.patch.object(cf, "put", side_effect=lambda *a, **k: put_out or {"ok": True, "path": a[2], "mtime_ns": 1}), \
                mock.patch.object(cf, "remove", side_effect=lambda *a, **k: {"ok": True, "path": a[2]}), \
                mock.patch.object(store, "log_usage", side_effect=lambda kind, note, pod="": logs.append((kind, note))):
            resp = asyncio.run(cf.file_route(Request(scope, receive)))
        return resp.status_code, _json.loads(resp.body), logs, reads

    def test_https_가_아니면_거절(self):
        self.assertEqual(self.call("PUT", "pod=p&slot=google_token", secure=False)[:2], (403, {"code": "insecure"}))

    def test_auth_json_과_경로는_칸이_아니다(self):
        for slot in ("auth", "auth.json", "secret:../x"):
            self.assertEqual(self.call("PUT", f"pod=p&slot={slot}")[1]["code"], "bad_slot")

    def test_64KB_를_넘으면_끝까지_읽지_않는다(self):
        status, body, _l, reads = self.call("PUT", "pod=p&slot=google_token", headers={"content-length": str(cf.MAX_BYTES + 1)})
        self.assertEqual((status, body["code"], reads), (413, "too_large", []))
        big = [b"x" * 40000, b"x" * 40000, b"x" * 40000]
        status, body, _l, reads = self.call("PUT", "pod=p&slot=google_token", chunks=big)
        self.assertEqual((status, body["code"], len(reads)), (413, "too_large", 2))

    def test_PC_가져오기_중이면_409(self):
        self.assertEqual(self.call("PUT", "pod=p&slot=google_token", running={"profile": "main"})[:2], (409, {"code": "busy_import"}))

    def test_지우기는_경로를_그대로_적어야_한다(self):
        self.assertEqual(self.call("DELETE", "pod=p&slot=secret:omdm&confirm=omdm.json")[1]["code"], "confirm_mismatch")
        status, body, logs, _r = self.call("DELETE", "pod=p&slot=secret:omdm&confirm=secrets/omdm.json")
        self.assertEqual((status, body["path"]), (200, "secrets/omdm.json"))
        self.assertEqual(logs, [("profile_credential_clear", "kim@x.com main secrets/omdm.json")])

    def test_넣기_기록에는_칸_경로만_남고_내용은_없다(self):
        status, body, logs, _r = self.call("PUT", "pod=p&slot=google_token", chunks=(f'{{"t": "{MARK}"}}'.encode(),))
        self.assertEqual(status, 200)
        self.assertEqual(logs, [("profile_credential_put", "kim@x.com main google_token.json")])
        self.assertNotIn(MARK, repr(logs) + repr(body))


if __name__ == "__main__":
    unittest.main()
