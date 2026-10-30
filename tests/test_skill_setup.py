# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""스킬이 선언한 필요한 비밀값(aas/assets/skill_setup.py, 스펙 2026-10-16-010 2단계, OMAI-1263). Hermes 와 같은 합치기 규칙인지 본다."""
import tempfile
import unittest
from pathlib import Path

from aas.assets import skill_setup

MD = """---
name: gws
required_environment_variables:
  - GOOGLE_CLIENT_ID
  - name: GOOGLE_CLIENT_SECRET
    prompt: OAuth 클라이언트 비밀
    help: https://console.cloud.google.com/apis/credentials
    required_for: 메일 보내기
setup:
  help: 관리자에게 받으세요
  collect_secrets:
    - env_var: GOOGLE_CLIENT_ID
      prompt: 겹치면 먼저 나온 것
    - env_var: GWS_DOMAIN
      provider_url: https://admin.google.com
      optional: true
prerequisites:
  env_vars: [LEGACY_TOKEN, "bad name"]
---
본문
"""


class RequiredEnvTest(unittest.TestCase):
    def test_merges_the_three_places_like_hermes(self):
        got = skill_setup.required_env(skill_setup.frontmatter(MD))
        self.assertEqual([e["name"] for e in got], ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GWS_DOMAIN", "LEGACY_TOKEN"])
        by = {e["name"]: e for e in got}
        self.assertEqual(by["GOOGLE_CLIENT_ID"], {"name": "GOOGLE_CLIENT_ID", "prompt": "", "help": "관리자에게 받으세요"})   # 먼저 나온 것이 이긴다
        self.assertEqual((by["GOOGLE_CLIENT_SECRET"]["help"], by["GOOGLE_CLIENT_SECRET"]["required_for"]),
                         ("https://console.cloud.google.com/apis/credentials", "메일 보내기"))
        self.assertEqual(by["GWS_DOMAIN"]["help"], "https://admin.google.com")      # collect_secrets 는 optional 을 옮기지 않는다(Hermes 와 같다)

    def test_missing_or_broken_frontmatter_needs_nothing(self):
        for md in ("본문만", "---\nname: [\n---\n", "---\n- a\n---\n"):
            self.assertEqual(skill_setup.required_env(skill_setup.frontmatter(md)), [], md)

    def test_set_names_reads_only_names_with_values(self):
        d = Path(tempfile.mkdtemp())
        (d / ".env").write_text("GOOGLE_CLIENT_ID=abc\nEMPTY=\nexport QUOTED=\"x\"\n# COMMENT=1\nBLANK=''\n")
        self.assertEqual(skill_setup.set_names(d / ".env", d / "missing.env"), {"GOOGLE_CLIENT_ID", "QUOTED"})


if __name__ == "__main__":
    unittest.main()
