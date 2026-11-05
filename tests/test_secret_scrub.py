# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""자격증명 파일 원문을 받는 자리에서 버린다(스펙 2026-10-19-015 A1·리뷰 R10).

사이드카에서 받은 `.env`·`secrets/*.json`·`auth.json`·`*.pem` 은 묶음(tree)과 하나씩 읽기(read) 모두 원문 없이 토큰만 남는다.
그래도 자격증명 현황표(같은 값 묶기·JWT 만료)와 채널·스킬의 변수 이름은 파일을 직접 읽을 때(compose)와 같다.
"""
import base64
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sidecar"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from aas_sidecar import ops as sc_ops, server as sc_server  # noqa: E402

from aas.assets import inventory, skill_setup  # noqa: E402
from aas.hermes import hermes_reader as hr  # noqa: E402
from aas.hermes.readers import remote, secret_scrub  # noqa: E402
from aas.ops import channels, pc_import  # noqa: E402
from test_aas import make_home  # noqa: E402

TOKEN = "scrub-token-0123456789abcdef"
SHARED = "sk-shared-0123456789abcdefghij"        # .env 와 config.yaml 에 같이 있는 값
BOT = "123456:telegram-bot-token-abcdefghijk"


def _jwt(exp: int) -> str:
    enc = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")   # noqa: E731
    return f"{enc({'alg': 'HS256'})}.{enc({'exp': exp, 'sub': 'x'})}.c2lnbmF0dXJlLXZhbHVl"


JWT = _jwt(1893456000)
RAW = [SHARED, BOT, JWT, "pem-private-body", "pool-refresh-token"]


def build_home(root: Path) -> Path:
    home = make_home(root)
    (home / ".env").write_text(f"# 주석에 비밀 {BOT}\nexport OPENAI_API_KEY='{SHARED}'\nTELEGRAM_BOT_TOKEN={BOT}\nEMPTY_VAR=\n", encoding="utf-8")
    cfg = home / "config.yaml"
    cfg.write_text(cfg.read_text(encoding="utf-8") + f"providers:\n  shared:\n    api_key: {SHARED}\n    base_url: https://llm.example.com/v1?key=x\n",
                   encoding="utf-8")
    (home / "secrets").mkdir()
    (home / "secrets" / "omdm.json").write_text(json.dumps({"base_url": "https://omdm.example.com/api?token=zz", "api_token": JWT, "name": "omdm"}),
                                                encoding="utf-8")
    (home / "auth.json").write_text(json.dumps({"pool": [{"refresh": "pool-refresh-token"}]}), encoding="utf-8")
    (home / "certs").mkdir()
    (home / "certs" / "client.pem").write_text("-----BEGIN-----\npem-private-body\n-----END-----\n", encoding="utf-8")
    alpha = home / "profiles" / "alpha"
    alpha.mkdir(parents=True, exist_ok=True)
    (alpha / ".env").write_text(f"SLACK_BOT_TOKEN={SHARED}\n", encoding="utf-8")
    return home


class ScrubUnitTest(unittest.TestCase):
    def test_credential_paths(self):
        for rel in (".env", "profiles/a/.env", ".env.local", "auth.json", "secrets/x.json", "profiles/a/secrets/y.yaml",
                    "certs/c.pem", "k.key", "mcp-tokens/s.json", "Auth.JSON",
                    "workspace/uploads/.cred-0a1b2c3d4e5f6a7b.json",       # 인증 파일 올리기의 임시본(2026-10-22-004)
                    ".docmost-work-log.env", "daily-news-work/.calendar.env", "x/Prod.ENV"):   # 사용자 스킬의 *.env
            self.assertTrue(secret_scrub.is_credential(rel), rel)
        for rel in ("config.yaml", "SOUL.md", "skills/a/SKILL.md", "envoy.txt", "secrets", "",
                    "workspace/uploads/cred.json", "workspace/.credits.txt", "notes.env.md", "venv/x.py"):
            self.assertFalse(secret_scrub.is_credential(rel), rel)

    def test_pc_import_file_entries_are_covered(self):
        # 자격증명 목록은 pc_import 가 정본이다. 그중 파일 항목은 모두 막혀야 한다(폴더 항목은 스펙 §7 대로 나중에)
        for p in pc_import._CREDENTIAL_PATHS:
            name = p.rsplit("/", 1)[-1]
            if "." in name.lstrip(".") or name in ("npmrc",) or name.startswith(".env") or name == ".envrc":
                self.assertTrue(secret_scrub.is_credential(p), p)

    def test_env_keeps_names_and_drops_values_and_comments(self):
        out = secret_scrub.scrub(".env", f"# {BOT}\nexport A='{SHARED}'\nB={BOT}\nC=\nnot a line\n".encode()).decode()
        self.assertNotIn(SHARED, out)
        self.assertNotIn(BOT, out)
        lines = out.splitlines()
        self.assertEqual([ln.split("=", 1)[0] for ln in lines], ["export A", "B", "C"])
        self.assertTrue(lines[0].split("=", 1)[1].startswith(secret_scrub.PREFIX))
        self.assertEqual(lines[2], "C=")

    def test_star_env_keeps_names_like_dot_env(self):
        # *.env 도 .env 처럼 이름은 두고 값만 토큰으로(파일 전체를 토큰 하나로 바꾸면 이름만 보는 곳이 깨진다)
        for rel in (".docmost-work-log.env", "daily-news-work/.calendar.env"):
            out = secret_scrub.scrub(rel, f"DOCMOST_KEY={SHARED}\nexport CAL_URL='{BOT}'\n".encode()).decode()
            self.assertNotIn(SHARED, out, rel)
            self.assertNotIn(BOT, out, rel)
            self.assertEqual([ln.split("=", 1)[0] for ln in out.splitlines()], ["DOCMOST_KEY", "export CAL_URL"], rel)

    def test_same_value_same_digest_and_jwt_expiry_survives(self):
        self.assertEqual(secret_scrub.digest(SHARED), secret_scrub.digest(secret_scrub.token(SHARED)))
        self.assertNotEqual(secret_scrub.digest(SHARED), secret_scrub.digest(BOT))
        self.assertEqual(secret_scrub.token_exp(secret_scrub.token(JWT)), 1893456000.0)
        self.assertIsNone(secret_scrub.token_exp(secret_scrub.token(SHARED)))

    def test_json_keeps_keys_and_reduces_urls(self):
        out = json.loads(secret_scrub.scrub("secrets/o.json", json.dumps({"url": "https://h.example.com/p?k=s", "n": [1, True, None]}).encode()))
        self.assertEqual(out["url"], "https://h.example.com/p")
        self.assertTrue(out["n"][0].startswith(secret_scrub.PREFIX))
        self.assertEqual(out["n"][1:], [True, None])

    def test_other_files_untouched(self):
        self.assertEqual(secret_scrub.scrub("config.yaml", b"api_key: x"), b"api_key: x")


class RemoteScrubTest(unittest.TestCase):
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

    def roots(self):
        bundled = remote.RemoteBackend(self.url, TOKEN, label="t")
        self.assertTrue(bundled.snapshot())
        plain = remote.RemoteBackend(self.url, TOKEN, label="t")
        plain._has_tree = False                                   # 옛 사이드카처럼 하나씩 읽는다
        return {"tree": remote.RemotePath(bundled, ""), "read": remote.RemotePath(plain, "")}

    def test_no_raw_value_reaches_aas(self):
        for mode, root in self.roots().items():
            for rel in (".env", "profiles/alpha/.env", "secrets/omdm.json", "auth.json", "certs/client.pem"):
                with self.subTest(mode=mode, rel=rel):
                    text = (root / rel).read_text()
                    for raw in RAW:
                        self.assertNotIn(raw, text)
            if mode == "tree":
                tree = root.backend.current_tree()
                cached = b"".join(tree.content(k) for k in tree.data if secret_scrub.is_credential(k))
                for raw in RAW:
                    self.assertNotIn(raw.encode(), cached)
            self.assertIn(SHARED, (root / "config.yaml").read_text())      # 자격증명 파일이 아니면 그대로

    def test_inventory_same_as_reading_files_directly(self):
        local = inventory._credentials(self.home)["items"]
        for mode, root in self.roots().items():
            with self.subTest(mode=mode):
                got = inventory._credentials(root)["items"]
                key = lambda i: (i["scope"], i["profile"], i["location"], i["name"])   # noqa: E731
                pick = lambda items: {key(i): (i["set"], i["expires"], i["shared_with"], i.get("keys"), i.get("target")) for i in items}   # noqa: E731
                self.assertEqual(pick(got), pick(local))
                groups = {key(i): i["shared_group"] for i in got}
                shared = [g for k, g in groups.items() if k[3] in ("OPENAI_API_KEY", "api_key", "SLACK_BOT_TOKEN")]
                self.assertEqual(len(shared), 3)
                self.assertEqual(len(set(shared)), 1)                     # .env·config.yaml·다른 프로파일 .env 의 같은 값이 한 묶음
                self.assertIsNotNone(shared[0])
                omdm = next(i for i in got if i["name"] == "omdm.json")
                self.assertIsNotNone(omdm["expires"])                      # 토큰에 실린 JWT 만료

    def test_channel_and_skill_names_unchanged(self):
        for mode, root in self.roots().items():
            with self.subTest(mode=mode):
                self.assertEqual(skill_setup.set_names(root / ".env"), {"OPENAI_API_KEY", "TELEGRAM_BOT_TOKEN"})
                prof = next(p for p in hr.profiles(root) if p.name == "default")
                self.assertEqual(channels._env_names(prof), channels._env_names(next(p for p in hr.profiles(self.home) if p.name == "default")))


if __name__ == "__main__":
    unittest.main()
