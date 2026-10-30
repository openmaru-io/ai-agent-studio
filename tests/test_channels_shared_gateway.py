# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""루트 게이트웨이가 프로파일을 함께 돌릴 때(쿠버네티스 GATEWAY_MULTIPLEX_PROFILES=true, OMAI-1147) 채널 화면의 게이트웨이 상태.
이 구조에서는 이름 있는 프로파일 폴더에 gateway_state.json 이 생기지 않고, 루트의 gateway_state.json 에 served_profiles 가 있다.
예전에는 프로파일 폴더의 파일만 읽어 돌고 있는 main 이 「게이트웨이 중지됨」으로 보였다(OKE 2026-10-14, 재시작해도 그대로)."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.ops import channels  # noqa: E402


def make_home(root_state=None, own_state=None):
    d = tempfile.TemporaryDirectory()
    home = Path(d.name)
    (home / "profiles" / "main").mkdir(parents=True)
    (home / "profiles" / "solo").mkdir(parents=True)
    if root_state is not None:
        (home / "gateway_state.json").write_text(json.dumps(root_state))
    for name, st in (own_state or {}).items():
        (home / "profiles" / name / "gateway_state.json").write_text(json.dumps(st))
    return d, home


def collect(home):
    with mock.patch.object(channels, "service_status", return_value={}), mock.patch("aas.hermes.hermes_reader.profiles", wraps=None) as p:
        from aas.hermes import hermes_reader as hr
        p.side_effect = lambda h=None: [hr.Profile(n, home / "profiles" / n) for n in sorted(x.name for x in (home / "profiles").iterdir())]
        return {r["name"]: r for r in channels.collect(home)["profiles"]}


class SharedGatewayTest(unittest.TestCase):
    def test_루트가_함께_돌리는_프로파일은_실행_중이다(self):
        d, home = make_home({"pid": 1, "gateway_state": "running", "served_profiles": ["default", "main"]})
        self.addCleanup(d.cleanup)
        rows = collect(home)
        self.assertIs(rows["main"]["running"], True)
        self.assertTrue(rows["main"].get("shared"))
        self.assertIs(rows["solo"]["running"], False)                  # 루트가 맡지 않은 프로파일은 그대로 꺼짐
        self.assertEqual(rows["main"]["issues"], [])                   # 「게이트웨이가 꺼져 있음」 주의가 붙지 않는다

    def test_루트_게이트웨이가_실행_중이_아니면_함께_도는_프로파일도_꺼짐이다(self):
        d, home = make_home({"pid": 1, "gateway_state": "stopped", "served_profiles": ["default", "main"]})
        self.addCleanup(d.cleanup)
        self.assertIs(collect(home)["main"]["running"], False)

    def test_루트_상태_파일이_없거나_served_profiles_가_없으면_예전_그대로(self):
        d, home = make_home(None)
        self.addCleanup(d.cleanup)
        self.assertIs(collect(home)["main"]["running"], False)
        d2, home2 = make_home({"pid": 1, "gateway_state": "running"})   # 옛 Hermes: served_profiles 없음
        self.addCleanup(d2.cleanup)
        self.assertIs(collect(home2)["main"]["running"], False)

    def test_자기_상태_파일이_있으면_그것을_쓴다(self):
        d, home = make_home({"pid": 1, "gateway_state": "running", "served_profiles": ["default", "main"]},
                            {"solo": {"pid": 9, "gateway_state": "running"}})
        self.addCleanup(d.cleanup)
        rows = collect(home)
        self.assertIs(rows["solo"]["running"], True)
        self.assertFalse(rows["solo"].get("shared"))


if __name__ == "__main__":
    unittest.main()
