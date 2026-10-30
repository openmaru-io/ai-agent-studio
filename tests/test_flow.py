# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""흐름 그래프와 파일 보기 시험 — 근거의 파일·줄이 실제 내용과 맞는지, 볼 수 없는 위치를 막는지."""
import json
import os
import tempfile
import unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.assets import files, flow  # noqa: E402


def make_home(root: Path) -> Path:
    home = root / "hermes"
    sk = home / "skills" / "ops" / "digest"
    (sk / "scripts").mkdir(parents=True)
    (home / "scripts").mkdir()
    (home / "secrets").mkdir()
    (home / "profiles" / "ma" / "cron").mkdir(parents=True)
    (home / "skills" / "ops" / "notify").mkdir(parents=True)
    (home / "skills" / "ops" / "notify" / "SKILL.md").write_text("---\nname: notify\ndescription: 알림\n---\n# notify\n")
    (sk / "SKILL.md").write_text(
        "---\nname: digest\ndescription: 요약 발송\nrelated_skills: [notify]\n---\n# digest\n\n"
        "실행: `python3 /opt/data/scripts/send.py`\n\n정리는 `helper.py` 가 한다.\n")
    (sk / "scripts" / "helper.py").write_text("import json\nimport requests\n\nrequests.get('https://api.example.org/v1/items')\n")
    (home / "scripts" / "send.py").write_text(
        "import os\nimport yaml\nfrom util import fmt\n\nKEY = os.environ['DIGEST_API_KEY']\n"
        "HOOK = 'https://hooks.slack.com/services/T000/B000/abcdefghijklmnop'\n"
        "password = 'supersecretvalue1234'\n")
    (home / "scripts" / "util.py").write_text("def fmt(x):\n    return str(x)\n")
    (home / ".env").write_text("DIGEST_API_KEY=abc123abc123abc123\n")
    (home / "scripts" / "bridge.py").write_text("import os\nCFG = os.environ['BRIDGE_CONFIG']\n")
    (home / "skills" / "ops" / "digest" / "SKILL.md").write_text((home / "skills" / "ops" / "digest" / "SKILL.md").read_text() + "\n문서는 `mcp__DOCS__get_page` 로 읽는다.\n")
    for prof, secret in (("ma", "docs_ma.json"), ("zz", "docs_zz.json")):
        (home / "profiles" / prof).mkdir(parents=True, exist_ok=True)
        (home / "secrets" / secret).write_text('{"apiUrl": "https://docs.example.org", "token": "yyyyyyyyyyyyyyyyyyyy"}')
        (home / "profiles" / prof / "config.yaml").write_text(
            "model:\n  default: m1\nmcp_servers:\n  DOCS:\n    command: python3\n    args:\n    - /opt/data/scripts/bridge.py\n"
            f"    env:\n      BRIDGE_CONFIG: /opt/data/secrets/{secret}\n      API_KEY: ${{DIGEST_API_KEY}}\n    enabled: true\n")
    (home / "secrets" / "hook.json").write_text('{"token": "zzzzzzzzzzzzzzzzzzzz"}')
    (home / "profiles" / "ma" / "cron" / "jobs.json").write_text(json.dumps({"jobs": [
        {"id": "j1", "name": "digest-daily", "skills": ["ops/digest"], "enabled": True, "last_status": "error",
         "failure_streak": 2, "deliver": "local", "schedule_display": "0 9 * * *"},
        {"id": "j2", "name": "send-only", "script": "send.py", "no_agent": True, "enabled": False}]}))
    return home


class FlowTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.home = make_home(Path(TMP.name))
        cls.ix = flow.build(cls.home)
        cls.skill = next(n for n in cls.ix["nodes"] if n.startswith("skill:") and n.endswith("digest"))

    def edges(self, sub):
        return {(e["from"].split(":", 1)[1].split("/")[-1], e["to"].split(":", 1)[1].split("/")[-1], e["kind"]): e for e in sub["edges"]}

    def test_evidence_points_at_real_lines(self):
        sub = flow.subgraph(self.ix, self.skill)
        checked = 0
        for e in sub["edges"]:
            for ev in e["evidence"]:
                if not ev["line"]:
                    continue
                line = (self.home / ev["file"]).read_text().splitlines()[ev["line"] - 1]
                self.assertTrue(ev["text"][:12] in files.mask_line(line.strip()), (ev, line))
                checked += 1
        self.assertGreaterEqual(checked, 6)

    def test_skill_flow_reaches_scripts_hosts_credentials_libraries(self):
        sub = flow.subgraph(self.ix, self.skill)
        ed = self.edges(sub)
        self.assertEqual(ed[("digest", "send.py", "runs")]["conf"], "doc")            # 문서가 지시한 스크립트
        self.assertEqual(ed[("digest", "helper.py", "runs")]["conf"], "doc")          # 폴더 안 스크립트
        self.assertEqual(ed[("send.py", ".env:DIGEST_API_KEY", "uses")]["conf"], "code")
        self.assertEqual(ed[("send.py", "hooks.slack.com", "calls")]["conf"], "code")
        self.assertEqual(ed[("send.py", "pyyaml", "imports")]["conf"], "code")        # import yaml → pyyaml
        self.assertIn(("send.py", "util.py", "imports"), ed)                          # 옆 파일 import 는 스크립트로
        self.assertIn(("helper.py", "requests", "imports"), ed)
        self.assertNotIn(("helper.py", "json", "imports"), ed)                        # 표준 라이브러리는 뺀다
        self.assertEqual(ed[("digest", "notify", "refers")]["conf"], "doc")           # related_skills
        kinds = {n["kind"] for n in sub["nodes"]}
        self.assertTrue({"cron", "skill", "script", "host", "cred", "lib"} <= kinds)
        up = [n for n in sub["nodes"] if n["depth"] < 0]
        self.assertEqual([(n["label"], n["status"]) for n in up], [("digest-daily", "bad")])   # 이 스킬을 돌리는 크론

    def test_library_nodes_do_not_link_to_the_hidden_library_screen(self):
        # 라이브러리 화면은 메뉴에서 숨겼고 쿠버네티스에서는 항상 비어 있다(OMAI-1175). 그래프의 라이브러리 노드가 거기로 보내지 않는다
        sub = flow.subgraph(self.ix, self.skill)
        libs = [n for n in sub["nodes"] if n["kind"] == "lib"]
        self.assertTrue(libs)
        for n in libs:
            self.assertFalse((n.get("link") or {}).get("view") == "libraries", n)

    def test_mcp_server_links_to_its_script_and_credentials_of_the_right_profile(self):
        cron = next(s["id"] for s in flow.starts(self.ix) if s["label"] == "digest-daily")      # ma 프로파일의 크론
        sub = flow.subgraph(self.ix, cron)
        ed = self.edges(sub)
        self.assertEqual(ed[("DOCS", "bridge.py", "runs")]["conf"], "config")
        self.assertEqual(ed[("DOCS", "docs_ma.json:docs_ma.json", "uses")]["evidence"][0]["file"], "profiles/ma/config.yaml")
        self.assertIn(("DOCS", ".env:DIGEST_API_KEY", "uses"), ed)                              # ${DIGEST_API_KEY} 참조
        labels = [n["label"] for n in sub["nodes"]]
        self.assertIn("docs_ma.json", labels); self.assertNotIn("docs_zz.json", labels)         # 다른 프로파일의 인증값은 싣지 않는다
        line = (self.home / "profiles/ma/config.yaml").read_text().splitlines()[ed[("DOCS", "bridge.py", "runs")]["evidence"][0]["line"] - 1]
        self.assertIn("bridge.py", line)
        self.assertNotIn("yyyyyyyyyyyyyyyyyyyy", json.dumps(sub))

    def test_cron_roots_and_starts(self):
        st = {s["label"]: s for s in flow.starts(self.ix)}
        self.assertEqual(st["digest-daily"]["skills"], ["digest"])
        self.assertEqual((st["send-only"]["scripts"], st["send-only"]["status"]), (["send.py"], "off"))
        sub = flow.subgraph(self.ix, st["digest-daily"]["id"])
        self.assertIn("hooks.slack.com", [n["label"] for n in sub["nodes"]])
        self.assertIsNone(flow.subgraph(self.ix, "skill:nope"))

    def test_evidence_and_file_view_mask_secrets(self):
        blob = json.dumps(flow.subgraph(self.ix, self.skill), ensure_ascii=False)
        for secret in ("abcdefghijklmnop", "supersecretvalue1234", "abc123abc123abc123", "zzzzzzzzzzzzzzzzzzzz"):
            self.assertNotIn(secret, blob)
        f = files.read(self.home, "scripts/send.py")
        text = "\n".join(f["lines"])
        self.assertNotIn("supersecretvalue1234", text)
        self.assertIn("os.environ['DIGEST_API_KEY']", text)                           # 이름은 그대로 읽힌다
        self.assertIn(7, f["masked_lines"])
        self.assertEqual(files.mask_line("see https://wiki.corp.example/s/ab/p/20261004-aas-ai-agent-console-gstack-yatnf51ogX now"),
                         "see https://wiki.corp.example/s/ab/p/20261004-aas-ai-agent-console-gstack-yatnf51ogX now")     # 읽히는 문서 주소는 가리지 않는다
        self.assertNotIn("Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0", files.mask_line("curl https://api.example.com/v1/Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0/send"))

    def test_file_view_only_inside_allowed_folders(self):
        for bad in (".env", "secrets/hook.json", "../x", "skills/../.env", "profiles/ma/cron/jobs.json", "/etc/passwd", "skills", "scripts/nope.py"):
            with self.assertRaises(files.FileError, msg=bad):
                files.read(self.home, bad)
        os.symlink(self.home / ".env", self.home / "scripts" / "leak.txt")
        with self.assertRaises(files.FileError):
            files.read(self.home, "scripts/leak.txt")
        self.assertIn("skills/ops/digest/scripts/helper.py", files.siblings(self.home, "skills/ops/digest/SKILL.md"))

    def test_siblings_from_subfolder_file_list_whole_skill(self):
        # 하위 폴더 파일(scripts/helper.py)을 열어도 스킬 폴더 전체를 돌려준다. 예전에는 그 파일의 폴더만 봐서
        # 목록이 하나뿐이라 화면의 파일 고르기 칸이 사라지고 SKILL.md 로 돌아갈 수 없었다(2026-10-17-020)
        from_sub = files.siblings(self.home, "skills/ops/digest/scripts/helper.py")
        self.assertIn("skills/ops/digest/SKILL.md", from_sub)
        self.assertEqual(from_sub, files.siblings(self.home, "skills/ops/digest/SKILL.md"))


if __name__ == "__main__":
    unittest.main()
