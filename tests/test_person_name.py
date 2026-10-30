# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""화면에 남의 이메일 대신 사람 이름을 보이는 도우미(office.person_name, 2026-10-30 사용자 지시)와 그것을 싣는 응답들."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.office import office  # noqa: E402
from aas.ops import mutes  # noqa: E402

KNOWN = {"kim@x.io": {"name": "김영주", "seed": ""}}


class PersonNameTest(unittest.TestCase):
    def test_email_becomes_name_and_other_values_stay(self):
        self.assertEqual(office.person_name("kim@x.io", KNOWN), "김영주")
        self.assertEqual(office.person_name("lee@x.io", KNOWN), "lee")             # 모르는 사람은 이메일 앞부분
        self.assertEqual(office.person_name("hermes:ma", KNOWN), "hermes:ma")      # 에이전트·시스템 표시는 그대로
        self.assertEqual(office.person_name("keycloak", KNOWN), "keycloak")
        self.assertEqual(office.person_name("", KNOWN), "")

    def test_muted_rows_carry_by_name(self):
        with mock.patch.object(office, "people", return_value=KNOWN):
            mutes.mute("ma", "job1", "주간 보고", "잠시 멈춤", by="kim@x.io")
            try:
                row = mutes.get("ma", "job1")
                self.assertEqual((row["by"], row["by_name"]), ("kim@x.io", "김영주"))
            finally:
                mutes.unmute("ma", "job1")


if __name__ == "__main__":
    unittest.main()
