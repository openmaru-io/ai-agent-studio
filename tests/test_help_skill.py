# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""AAS 사용법 스킬(aas-help) — 스펙 2026-10-18-001 B 를 2026-10-29-001 이 바꿨다(OMAI-1534).

aas-help 는 스킬 허브 패키지(free/aas-help)로 프로파일마다 들어간다. 서버는 ConfigMap(aas-help-skill)을 올리지 않고,
프로파일 config.yaml 의 skills.external_dirs 에 /opt/aas-skills 를 더하지 않는다. 이미 그 값이 든 설정은 그대로 둔다 —
주인의 설정 저장 검사는 계속 허용한다(없는 폴더는 Hermes 가 건너뛴다)."""
import os
import tempfile
import unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.ops import help_skill, owner_guard  # noqa: E402


class ConfigGuardTest(unittest.TestCase):
    def test_주인의_설정_저장_검사는_예전에_넣은_aas_스킬_폴더를_허용한다(self):
        ok = "skills:\n  external_dirs:\n  - /opt/data/profiles/a/skills\n  - /opt/aas-skills\n"
        self.assertEqual(owner_guard.config_dirs_error(ok), "")
        self.assertNotEqual(owner_guard.config_dirs_error("skills:\n  external_dirs:\n  - /opt/aas-skills/../../etc\n"), "")
        self.assertNotEqual(owner_guard.config_dirs_error("skills:\n  external_dirs:\n  - /etc\n"), "")


class NoConfigMapTest(unittest.TestCase):
    def test_서버는_ConfigMap_도_스킬_폴더_설정도_쓰지_않는다(self):
        from aas.web import server
        self.assertFalse(hasattr(server, "help_skill_sync_once"))
        self.assertFalse(hasattr(help_skill, "sync_configmap"))
        self.assertFalse(hasattr(help_skill, "with_help_dir"))
        src = Path(server.__file__).read_text(encoding="utf-8")
        self.assertNotIn("help_skill.", src)


if __name__ == "__main__":
    unittest.main()
