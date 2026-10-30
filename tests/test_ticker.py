# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""주기 작업(--ticker, aas tick)의 오피스 점검과 설치본 수 처리.

옛 오피스 코드를 걷어낼 때 `_tick` 안의 점검이 지워진 함수(server.office_urls)를 불러, 예외가 삼켜진 채로 점검이 멈춘 적이 있다."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas import __main__ as cli  # noqa: E402
from aas.office import office
from aas.web import server  # noqa: E402
from aas.fleet.pods import Pod  # noqa: E402


class Reg:
    def __init__(self, *ids):
        self.pods = [Pod(i, "a@x.com", Path(TMP.name), "c", f"http://{i}.invalid:9119") for i in ids]


class OfficeCheckTest(unittest.TestCase):
    def setUp(self):
        with office.connect() as conn:
            for t in ("office_seats", "office_checks", "office_pins"):
                conn.execute(f"DELETE FROM {t}")

    def test_자리가_없으면_점검하지_않는다(self):
        with mock.patch.object(server, "registry", return_value=Reg("one")), mock.patch.object(office, "_probe") as probe:
            self.assertEqual(cli._office_check(), [])
        probe.assert_not_called()

    def test_닿지_않는_설치본을_문제로_돌려주고_예외를_내지_않는다(self):
        office.set_seat({"pod": "one", "profile": "ma"}, "me", {"one": {"ma"}})
        with mock.patch.object(server, "registry", return_value=Reg("one", "two")), \
                mock.patch.object(office, "_probe", return_value=("down", "", "ConnectionRefusedError")):
            found = cli._office_check()
        self.assertEqual(len(found), 1)                                   # 자리가 있는 설치본(one)만 점검한다
        self.assertIn("one", found[0])
        self.assertIn("연결할 수 없습니다", found[0])

    def test_정상이면_문제가_없다(self):
        office.set_seat({"pod": "one", "profile": "ma"}, "me", {"one": {"ma"}})
        with mock.patch.object(server, "registry", return_value=Reg("one")), \
                mock.patch.object(office, "_probe", return_value=("ok", "0.21.3", "ok")):
            self.assertEqual(cli._office_check(), [])


class CollectHealthTest(unittest.TestCase):
    def test_설치본이_여럿이면_모두_수집해_POD_이름을_붙여_합치고_바퀴를_기록한다(self):
        reg = Reg("one", "two")
        seen = []

        def fake(now=None, home=None):
            seen.append(home)
            return {"collected_at": "2026-10-10T12:00:00+09:00", "profiles": [{"name": "ma", "jobs_status": "ok", "exec_status": "ok", "detail": "", "jobs_total": 1, "jobs_active": 1,
                                                                            "open_incidents": 0, "new_incidents": 0, "failed_jobs": 0, "stalled_jobs": 0, "silent_jobs": 0,
                                                                            "runs_7d": 0, "runs_failed_7d": 0, "stale": False}],
                    "incidents": [], "failed_jobs": [], "stalled": [], "silent": [],
                    "totals": {"profiles": 1, "profiles_ok": 1, "jobs": 1, "jobs_active": 1, "open_incidents": 0, "new_incidents": 0, "live_incidents": 0, "settled_incidents": 0,
                               "failed_jobs": 0, "stalled": 0, "silent": 0, "stale_profiles": []}}
        with mock.patch.object(server, "registry", return_value=reg), mock.patch.object(cli.cron_health, "collect", side_effect=fake):
            health = cli._collect_health()
        self.assertEqual(sorted(p["name"] for p in health["profiles"]), ["one/ma", "two/ma"])
        self.assertEqual(health["pods"], {"ok": 2, "total": 2, "failed": []})
        self.assertEqual(cli.collect_all.last_round()["pods"]["ok"], 2)

    def test_설치본이_하나면_그_설치본의_폴더로_수집한다(self):
        reg = Reg("one")
        with mock.patch.object(server, "registry", return_value=reg), mock.patch.object(cli.cron_health, "collect", return_value={"ok": 1}) as collect:
            self.assertEqual(cli._collect_health(), {"ok": 1})
        collect.assert_called_once_with(home=reg.pods[0].hermes_home)

    def test_쿠버네티스에서_Hermes_가_하나도_없으면_수집하지_않고_빈_결과를_낸다(self):
        """사용자가 아직 없는 새 설치에서 주기마다 「Hermes 데이터 디렉터리가 없습니다」 오류가 나던 것을 막는다(OKE 실측)."""
        reg = Reg()
        with mock.patch.object(server, "registry", return_value=reg), mock.patch.dict(os.environ, {"AAS_K8S_NAMESPACE": "cogentai-aas-agents"}), \
                mock.patch.object(cli.cron_health, "collect", side_effect=FileNotFoundError("/opt/data")) as collect:
            health = cli._collect_health()
        collect.assert_not_called()
        self.assertEqual((health["profiles"], health["pods"]["total"]), ([], 0))


if __name__ == "__main__":
    unittest.main()
