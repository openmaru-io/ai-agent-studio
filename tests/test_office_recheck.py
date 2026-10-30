# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""오피스 점검 띠(「Hermes API 서버에 연결할 수 없습니다」)가 파드가 다시 뜬 뒤에도 남던 문제(OKE 2026-10-14).
점검은 서버가 뜰 때와 30분마다만 돌고, 화면은 저장된 마지막 결과를 나이와 상관없이 보였다. 에이전트 파드가 다시 뜨는 동안
한 번 실패하면 다음 점검까지 약 30분 동안 살아난 설치본에 「연결할 수 없음」 띠가 남았다. 이제 실패였던 설치본만 보일 때 다시 본다."""
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.office import office  # noqa: E402

KNOWN = {"a": {"p1"}, "b": {"p2"}}


def pod(pid):
    return SimpleNamespace(id=pid, dashboard_url=f"http://{pid}.example:9119")


class RecheckTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.TemporaryDirectory()
        self._old = os.environ.get("AAS_DATA_DIR")
        os.environ["AAS_DATA_DIR"] = self.d.name
        office._rechecked.clear()
        office.set_seat({"pod": "a", "profile": "p1"}, "me", KNOWN)
        office.set_seat({"pod": "b", "profile": "p2"}, "me", KNOWN)
        with office.connect() as conn:
            conn.execute("INSERT INTO office_checks VALUES ('2000-01-01T00:00:00+00:00','pod:a','down','','URLError')")
            conn.execute("INSERT INTO office_checks VALUES ('2000-01-01T00:00:00+00:00','pod:b','ok','0.21.3','')")

    def tearDown(self):
        if self._old is None:
            os.environ.pop("AAS_DATA_DIR", None)
        else:
            os.environ["AAS_DATA_DIR"] = self._old
        self.d.cleanup()

    def test_실패였던_설치본이_지금_닿으면_띠가_사라지고_기록이_바뀐다(self):
        self.assertEqual(len(office.problems()), 1)                       # 고치기 전 상태: 저장된 down 이 그대로 보인다
        with mock.patch.object(office, "_probe", return_value=("ok", "0.21.3", "")) as probe:
            office.recheck_failed([pod("a"), pod("b")])
        self.assertEqual(office.problems(), [])
        self.assertEqual([c.args[0] for c in probe.call_args_list], ["http://a.example:9119/api/health"])   # 닿던 b 는 다시 보지 않는다
        self.assertEqual(office.last_checks()["pod:a"]["status"], "ok")

    def test_띠_문장은_설치본_id_대신_주인과_에이전트_이름이다(self):
        """스펙 2026-10-19-003: 「a 의 Hermes API 서버에…」처럼 id 가 보였다. 서버가 넣은 글자(주인 · 이름)를 쓰고, 모르면 id."""
        with mock.patch.object(office, "agent_labels_provider", return_value={"a": "김철수 · 영업 도우미"}):
            self.assertTrue(office.problems()[0]["text"].startswith("김철수 · 영업 도우미 의 Hermes API 서버"), office.problems())
        self.assertTrue(office.problems()[0]["text"].startswith("a 의 Hermes"))

    def test_아직_안_닿으면_띠는_남고_다시_보기는_15초에_한_번만(self):
        with mock.patch.object(office, "_probe", return_value=("down", "", "URLError")) as probe:
            office.recheck_failed([pod("a")])
            office.recheck_failed([pod("a")])                              # 15초 안: 다시 보지 않는다(보는 사람이 많아도 서버 부담이 같다)
        self.assertEqual(probe.call_count, 1)
        self.assertEqual(len(office.problems()), 1)
        self.assertEqual(office.last_checks()["pod:a"]["status"], "down")  # 실패는 새 기록을 쌓지 않는다(기록 200개가 밀려나지 않게)

    def test_15초가_지나면_다시_본다(self):
        with mock.patch.object(office, "_probe", return_value=("down", "", "URLError")) as probe, mock.patch.object(office.time, "monotonic") as clock:
            clock.return_value = 1000.0
            office.recheck_failed([pod("a")])
            clock.return_value = 1000.0 + office.RECHECK_EVERY + 1
            office.recheck_failed([pod("a")])
        self.assertEqual(probe.call_count, 2)

    def test_다시_보다_예외가_나도_화면_응답을_깨지_않는다(self):
        """주소가 비정상인 설치본은 urlopen 이 ValueError 를 던진다(OSError 가 아니다). 오피스 개요(/api/office)가 500 이 되면 안 된다."""
        with mock.patch.object(office, "_probe", side_effect=ValueError("unknown url type: '/api/health'")):
            office.recheck_failed([pod("a")])
        self.assertEqual(office.last_checks()["pod:a"]["status"], "down")
        self.assertEqual(len(office.problems()), 1)

    def test_점검할_것이_없으면_아무것도_부르지_않는다(self):
        with office.connect() as conn:
            conn.execute("DELETE FROM office_checks")
        with mock.patch.object(office, "_probe") as probe:
            office.recheck_failed([pod("a"), pod("b")])
        probe.assert_not_called()


if __name__ == "__main__":
    unittest.main()
