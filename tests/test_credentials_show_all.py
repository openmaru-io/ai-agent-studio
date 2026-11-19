# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""API 키·토큰 표가 프로파일 .env 의 모든 항목과 stt·auxiliary 의 api_key 를 싣는다(스펙 2026-11-18-007).

COP 신대수 님 personal_agenta 에서 .env 6개 중 이름 규칙에 맞는 1개만 보이던 것을 고친다. 이름 규칙 밖 항목은
「설정 값」(value_kind=setting) 이고, 설정 값·AAS 기본 값 행은 같은 값·만료·빈 값 점검과 프로파일 목록·흐름 그림의 수에서 빠진다.
파일을 직접 읽을 때와 사이드카로 읽을 때 같은 결과인지 둘 다 본다.
"""
import base64
import http.client
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sidecar"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import aasserver  # noqa: E402
from aas_sidecar import ops as sc_ops, server as sc_server  # noqa: E402

from aas.assets import image_packages, inventory  # noqa: E402
from aas.fleet import profiles as fleet_profiles  # noqa: E402
from aas.hermes.readers import remote  # noqa: E402
from aas.ops import models  # noqa: E402

TOKEN = "show-all-token-0123456789abcdef"
SERVER_KEY = "sk-aas-litellm-0123456789abcdef"
REF = '"${HERMES_LLM_API_KEY}"'


def _jwt(exp: int) -> str:
    part = lambda o: base64.urlsafe_b64encode(json.dumps(o).encode()).decode().rstrip("=")  # noqa: E731
    return f"{part({'alg': 'HS256'})}.{part({'exp': exp, 'sub': 'x'})}.c2lnbmF0dXJlLXZhbHVl"


SOON = _jwt(int(time.time()) + 3 * 86400 + 43200)              # 3.5일 뒤 만료 → 「N일 뒤 만료」 플래그(분 단위 반올림에 기대지 않는다)


def build_home(root: Path) -> Path:
    home = root / "hermes"
    home.mkdir(parents=True)
    (home / "config.yaml").write_text(f"model:\n  default: m\nproviders:\n  litellm:\n    api_key: {REF}\n", encoding="utf-8")
    agenta = home / "profiles" / "agenta"
    agenta.mkdir(parents=True)
    (agenta / ".env").write_text(
        "DOCMOST_API_KEY=dm-key-0123456789abcdef\n"
        "DOCMOST_URL=https://docs.example.local\n"
        "KANBAN_DAYS=7\nKANBAN_DAYS=14\n"                        # 같은 이름 두 줄 → 마지막 줄
        "KANBAN_GROUP_BY=\n"                                      # 빈 설정 값 — 「비어 있음」 아님
        f"SESSION_JWT={SOON}\n"                                   # 이름 규칙 밖이지만 JWT → 키(E5)
        "lower_setting=abc\n", encoding="utf-8")
    (agenta / "config.yaml").write_text(
        "model:\n  default: m\n"
        f"providers:\n  litellm:\n    api_key: {REF}\n"
        f"stt:\n  openai:\n    api_key: {REF}\n  local:\n    model: whisper\n"   # local 은 api_key 없음 → 행 없음
        f"auxiliary:\n  vision:\n    api_key: {SERVER_KEY}\n  embed:\n    api_key: sk-own-aux-0123456789ab\n",  # 서버 키 글자 그대로 → 기본 값(E6)
        encoding="utf-8")
    other = home / "profiles" / "other"
    other.mkdir(parents=True)
    (other / ".env").write_text("DOCMOST_URL=https://docs.example.local\nKANBAN_DAYS=14\n", encoding="utf-8")   # 같은 설정 값 → 묶음 없음
    (other / "config.yaml").write_text("model:\n  default: m\nstt: [broken]\nauxiliary: x\n", encoding="utf-8")   # 깨진 모양 → 건너뜀
    return home


class CredentialsShowAllTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.home = build_home(Path(cls.tmp.name))
        cls.httpd = sc_server.make_server("127.0.0.1", 0, sc_ops.Ops(cls.home), TOKEN)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.httpd.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.tmp.cleanup()

    def setUp(self):
        for p in (mock.patch.object(models, "server_llm_key", return_value=(SERVER_KEY, "AAS_LITELLM_KEY")),
                  mock.patch.dict(os.environ, {"AAS_HERMES_COMPOSE_ENV": str(Path(self.tmp.name) / "none.env")})):
            p.start()
            self.addCleanup(p.stop)

    def roots(self):
        backend = remote.RemoteBackend(self.url, TOKEN, label="t")
        self.assertTrue(backend.snapshot())
        return {"files": self.home, "sidecar": remote.RemotePath(backend, "")}

    def rows(self, root):
        return {(i["profile"], i["name"], i["location"].rsplit(" › ", 1)[-1]): i for i in inventory._credentials(root)["items"]}

    def test_env_의_모든_이름이_행이_되고_규칙_밖은_설정_값이다(self):
        for mode, root in self.roots().items():
            with self.subTest(mode=mode):
                env = {k[1]: v for k, v in self.rows(root).items() if k[0] == "agenta" and k[2].endswith(".env")}
                self.assertEqual(set(env), {"DOCMOST_API_KEY", "DOCMOST_URL", "KANBAN_DAYS", "KANBAN_GROUP_BY", "SESSION_JWT", "lower_setting"})
                kinds = {n: r["value_kind"] for n, r in env.items()}
                self.assertEqual(kinds, {"DOCMOST_API_KEY": "secret", "DOCMOST_URL": "setting", "KANBAN_DAYS": "setting",
                                         "KANBAN_GROUP_BY": "setting", "SESSION_JWT": "secret", "lower_setting": "setting"})
                for n in ("DOCMOST_URL", "KANBAN_DAYS", "KANBAN_GROUP_BY", "lower_setting"):
                    self.assertEqual((env[n]["flags"], env[n]["shared_with"], env[n]["expires"]), ([], 0, None), n)
                self.assertFalse(env["KANBAN_GROUP_BY"]["set"])
                self.assertTrue(any(f.endswith("일 뒤 만료") for f in env["SESSION_JWT"]["flags"]), env["SESSION_JWT"]["flags"])  # JWT 는 이름 규칙 밖이어도 만료 점검(E5)
                self.assertTrue(env["SESSION_JWT"]["expires"])

    def test_같은_이름_두_줄은_마지막_값_한_행이다(self):
        items = inventory._credentials(self.home)["items"]
        same = [i for i in items if (i["profile"], i["name"]) == ("agenta", "KANBAN_DAYS")]
        self.assertEqual(len(same), 1)
        self.assertEqual(len({i["id"] for i in items}), len(items))           # 행 id 가 겹치지 않는다
        both = {i["profile"]: i for i in items if i["name"] == "KANBAN_DAYS"}
        self.assertEqual(both["agenta"]["shared_with"], 0)                    # 마지막 값 14 가 other 와 같아도 묶지 않는다

    def test_stt_auxiliary_api_key_를_싣고_깨진_모양은_건너뛴다(self):
        for mode, root in self.roots().items():
            with self.subTest(mode=mode):
                rows = self.rows(root)
                self.assertEqual(rows[("agenta", "api_key", "stt.openai")]["aas_default"], "llm")
                self.assertNotIn(("agenta", "api_key", "stt.local"), rows)
                self.assertEqual(rows[("agenta", "api_key", "auxiliary.vision")]["aas_default"], "llm")   # 서버 키 지문(E6)
                own = rows[("agenta", "api_key", "auxiliary.embed")]
                self.assertEqual((own["aas_default"], own["value_kind"]), (None, "secret"))
                self.assertFalse([k for k in rows if k[0] == "other" and k[1] == "api_key"])           # stt 목록·auxiliary 글자

    def test_합계는_기본_값_설정_값을_점검_수에_넣지_않는다(self):
        got = inventory._credentials(self.home)
        t = got["totals"]
        self.assertEqual(t["items"], len(got["items"]))
        self.assertEqual(t["empty"], 0)                                        # 빈 KANBAN_GROUP_BY 는 설정 값이라 세지 않는다
        self.assertEqual(t["expiring"], 1)                                     # SESSION_JWT 하나
        self.assertEqual(t["shared_groups"], 0)
        self.assertEqual(t, inventory._totals(got["items"]))

    def test_숨긴_루트_거르기는_새_결과를_만들고_원본을_고치지_않는다(self):
        d = inventory.credentials(self.home)
        before = len(d["items"])
        root_defaults = [i for i in d["items"] if i["profile"] == "" and i["aas_default"]]
        self.assertTrue(root_defaults)
        out = inventory.without_hidden_root_defaults(d)
        self.assertEqual(len(out["items"]), before - len(root_defaults))
        self.assertEqual(out["totals"], inventory._totals(out["items"]))
        self.assertEqual(len(d["items"]), before)                              # 공유 결과는 그대로(E1)
        self.assertEqual(len(inventory.credentials(self.home)["items"]), before)
        self.assertIs(inventory.without_hidden_root_defaults(out), out)        # 뺄 것이 없으면 그대로 돌려준다

    def test_프로파일_목록의_키_수는_기본_값_설정_값을_세지_않는다(self):
        creds = inventory._credentials(self.home)["items"]
        empty = {"profiles": []}
        rows = fleet_profiles.summarize([{"name": "agenta"}], [], empty, empty, empty, creds, empty, {})
        # 사람 키: DOCMOST_API_KEY·SESSION_JWT·auxiliary.embed 셋
        self.assertEqual(rows[0]["creds"], 3)
        self.assertEqual(rows[0]["creds_expiring"], 1)


class CredentialsRouteTest(unittest.TestCase):
    """GET /api/credentials 가 숨긴 루트의 기본 값 행만 빼고, tools·libraries 는 그대로다(R9)."""

    @classmethod
    def setUpClass(cls):
        from aas.auth import auth
        from aas.fleet import pods
        from aas.web import server
        cls.server = server
        cls.tmp = tempfile.TemporaryDirectory()
        cls.home = build_home(Path(cls.tmp.name))
        reg = Path(cls.tmp.name) / "pods.json"
        reg.write_text(json.dumps({"pods": [{"id": "loc", "owner": "t@example.com", "hermes_home": str(cls.home)}]}))
        cls.old = (server._auth, server._registry)
        server._auth = auth.Auth({"issuer": "https://accounts.google.com", "client_id": "", "client_secret": "", "domain": "",
                                  "public_url": "http://localhost:17900", "hours": 1,
                                  "users_file": Path(cls.tmp.name) / "no-users.json"})          # 로그인 꺼짐
        server._registry = pods.Registry(reg)
        server._cache.clear()
        cls.web = aasserver.start()

    @classmethod
    def tearDownClass(cls):
        cls.web.shutdown()
        cls.web.server_close()
        cls.server._auth, cls.server._registry = cls.old
        cls.server._cache.clear()
        cls.tmp.cleanup()

    def setUp(self):
        self.server._cache.clear()
        for p in (mock.patch.object(models, "server_llm_key", return_value=(SERVER_KEY, "AAS_LITELLM_KEY")),
                  mock.patch.dict(os.environ, {"AAS_HERMES_COMPOSE_ENV": str(Path(self.tmp.name) / "none.env")})):
            p.start()
            self.addCleanup(p.stop)

    def get(self, path):
        c = http.client.HTTPConnection("127.0.0.1", self.web.server_port, timeout=20)
        c.request("GET", path, headers={"Cookie": f"{self.server.POD_COOKIE}=loc"})
        r = c.getresponse()
        body = json.loads(r.read())
        c.close()
        return r.status, body

    def root_defaults(self, body):
        return [i for i in body["items"] if i["profile"] == "" and i["aas_default"]]

    def test_숨긴_루트면_루트_기본_값_행만_뺀다(self):
        with mock.patch("aas.fleet.primary.hide_root", return_value="drop"):
            code, body = self.get("/api/credentials")
        self.assertEqual(code, 200)
        self.assertEqual(self.root_defaults(body), [])
        self.assertTrue([i for i in body["items"] if i["profile"] == "agenta"])
        self.assertEqual(body["totals"]["items"], len(body["items"]))
        self.assertTrue(self.root_defaults(inventory.credentials(self.home)))     # 캐시·메모의 원본은 그대로

    def test_보이는_루트면_그대로다(self):
        with mock.patch("aas.fleet.primary.hide_root", return_value="show"):
            code, body = self.get("/api/credentials")
        self.assertEqual(code, 200)
        self.assertTrue(self.root_defaults(body))

    def test_판정이_실패하면_거르지_않고_로그를_남긴다(self):
        with mock.patch("aas.fleet.primary.hide_root", side_effect=RuntimeError("boom")), \
                self.assertLogs("aas.web", level="WARNING") as logs:
            code, body = self.get("/api/credentials")
        self.assertEqual(code, 200)
        self.assertTrue(self.root_defaults(body))
        self.assertTrue(any("credentials hide_root failed pod=loc" in m for m in logs.output))

    def test_tools_libraries_응답은_그대로다(self):
        # /api/libraries 는 서버가 이미지 목록(로컬은 not_k8s)을 넘긴다(스펙 2026-11-19-001)
        libs = lambda h: inventory.libraries(h, image_packages.for_pod(False))  # noqa: E731
        for path, fn in (("/api/tools", inventory.tools), ("/api/libraries", libs)):
            with self.subTest(path=path):
                code, body = self.get(path)
                self.assertEqual(code, 200)
                expect = json.loads(json.dumps(fn(self.home), ensure_ascii=False))
                for k in ("collected_at",):
                    body.pop(k, None); expect.pop(k, None)
                self.assertEqual(body, expect)


if __name__ == "__main__":
    unittest.main()
