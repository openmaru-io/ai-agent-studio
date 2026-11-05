# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""루트 게이트웨이가 프로파일을 함께 돌릴 때(쿠버네티스 GATEWAY_MULTIPLEX_PROFILES=true, OMAI-1147) 채널 화면의 게이트웨이 상태.
이 구조에서는 이름 있는 프로파일 폴더에 gateway_state.json 이 생기지 않고, 루트의 gateway_state.json 에 served_profiles 가 있다.
예전에는 프로파일 폴더의 파일만 읽어 돌고 있는 main 이 「게이트웨이 중지됨」으로 보였다(OKE 2026-10-14, 재시작해도 그대로)."""
import json
import os
from datetime import datetime, timezone
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.ops import channels  # noqa: E402


def make_home(root_state=None, own_state=None, files=None):
    """files: {프로파일 이름: {상대 경로: 글}} — config.yaml·.env·cron/jobs.json 등. 루트는 이름 "default"."""
    d = tempfile.TemporaryDirectory()
    home = Path(d.name)
    (home / "profiles" / "main").mkdir(parents=True)
    (home / "profiles" / "solo").mkdir(parents=True)
    if root_state is not None:
        (home / "gateway_state.json").write_text(json.dumps(root_state))
    for name, st in (own_state or {}).items():
        (home / "profiles" / name / "gateway_state.json").write_text(json.dumps(st))
    for name, items in (files or {}).items():
        base = home if name == "default" else home / "profiles" / name
        for rel, text in items.items():
            (base / rel).parent.mkdir(parents=True, exist_ok=True)
            (base / rel).write_text(text)
    return d, home


def collect(home):
    with mock.patch.object(channels, "service_status", return_value={}), mock.patch("aas.hermes.hermes_reader.profiles", wraps=None) as p:
        from aas.hermes import hermes_reader as hr
        # 실제 hr.profiles 처럼 루트 행(default, 경로 = home)을 맨 앞에 둔다 — 없으면 루트 행 판정(R3)을 시험하지 못한다(외부 검토 OV1)
        p.side_effect = lambda h=None: [hr.Profile("default", home)] + [
            hr.Profile(n, home / "profiles" / n) for n in sorted(x.name for x in (home / "profiles").iterdir())]
        return {r["name"]: r for r in channels.collect(home)["profiles"]}


def collect_all(home):
    """collect 결과 전체(totals 포함)."""
    with mock.patch.object(channels, "service_status", return_value={}), mock.patch("aas.hermes.hermes_reader.profiles", wraps=None) as p:
        from aas.hermes import hermes_reader as hr
        p.side_effect = lambda h=None: [hr.Profile("default", home)] + [
            hr.Profile(n, home / "profiles" / n) for n in sorted(x.name for x in (home / "profiles").iterdir())]
        return channels.collect(home)


NOW = datetime.now(timezone.utc).isoformat()
TELEGRAM = {".env": "TELEGRAM_BOT_TOKEN=x\n"}                     # 프로파일 설정에 텔레그램 켬(값은 보지 않는다)
LEFTOVER = {"pid": 1414091, "gateway_state": "running", "updated_at": NOW,     # 멀티플렉스 전 프로파일별 게이트웨이가 남긴 파일
            "platforms": {"telegram": {"state": "disconnected", "writer_pid": 1414091, "updated_at": NOW}}}


def root(state="running", **platforms):
    """루트 상태 파일(Hermes 0.22 멀티플렉스). platforms 키는 "main__telegram" 꼴로 받아 "main:telegram" 으로 바꾼다."""
    return {"pid": 3610, "gateway_state": state, "updated_at": NOW, "code_version": "0.22.2",
            "served_profiles": ["default", "main"],
            "platforms": {k.replace("__", ":"): {"writer_pid": 3610, "updated_at": NOW, **v} for k, v in platforms.items()}}


def texts(row):
    return [i["text"] for i in row["issues"]]


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


class MultiplexChannelStateTest(unittest.TestCase):
    """공개 레포 이슈 #3(스펙 cogentai-aas-docs 2026-11-06-001): 루트가 함께 돌리는 이름 있는 프로파일의 채널 상태는
    루트 파일의 "<이름>:<채널>" 키에서 읽고, 프로파일 폴더에 남은 옛 상태 파일은 무시한다."""

    def run_home(self, root_state, own_state=None, files=None):
        d, home = make_home(root_state, own_state, {"main": TELEGRAM, **(files or {})})
        self.addCleanup(d.cleanup)
        return home

    def test_T1_루트_키의_연결됨을_그_프로파일로_돌려준다(self):
        rows = collect(self.run_home(root(main__telegram={"state": "connected"})))
        self.assertEqual(rows["main"]["issues"], [])
        self.assertEqual([(p["name"], p["state"]) for p in rows["main"]["platforms"]], [("telegram", "connected")])
        self.assertNotIn("main:telegram", [p["name"] for p in rows["default"]["platforms"]])    # 루트 행에 섞이지 않는다(R3)

    def test_T2_남은_프로파일_상태_파일은_무시한다(self):
        rows = collect(self.run_home(root(main__telegram={"state": "connected"}), {"main": LEFTOVER}))
        self.assertEqual(rows["main"]["issues"], [])
        self.assertTrue(rows["main"]["shared"])
        self.assertIs(rows["main"]["running"], True)
        self.assertEqual(rows["main"]["gateway_state"], "running")
        self.assertEqual(rows["main"]["version"], "0.22.2")                                    # 루트 값

    def test_T3_루트_키가_끊김이면_bad(self):
        rows = collect(self.run_home(root(main__telegram={"state": "fatal", "error_message": "Unauthorized"})))
        self.assertTrue(any(t.startswith("telegram") and "fatal" in t for t in texts(rows["main"])), texts(rows["main"]))
        self.assertTrue(any(i["level"] == "bad" for i in rows["main"]["issues"]))

    def test_T4_루트_pid_와_다른_writer_pid_는_옛_기록(self):
        rows = collect(self.run_home(root(main__telegram={"state": "disconnected", "writer_pid": 99})))
        self.assertTrue(rows["main"]["platforms"][0]["stale"])
        self.assertEqual(rows["main"]["issues"], [])

    def test_T5_멀티플렉스에서_못_돌리는_채널은_주의(self):
        rows = collect(self.run_home(root(
            main__telegram={"state": "connected"},
            main__webhook={"state": "disabled", "error_code": "multiplex_shared_ingress",
                           "error_message": "not served under multiplex (shared ingress owned by default)"},
            main__sms={"state": "disabled", "error_code": "x_unknown", "error_message": "something new"})))
        issues = rows["main"]["issues"]
        self.assertEqual({i["level"] for i in issues}, {"warn"}, issues)                        # bad 없음
        self.assertTrue(any(i["text"].startswith("webhook") and "default" in i["text"] for i in issues), issues)
        self.assertTrue(any(i["text"].startswith("sms") and i["text"].endswith("something new") for i in issues), issues)

    def test_T6_예약_작업_전달_채널이_연결돼_있으면_문제_없음(self):
        jobs = json.dumps({"jobs": [{"id": "j1", "name": "아침 보고", "deliver": "telegram:123"}]})
        rows = collect(self.run_home(root(main__telegram={"state": "connected"}), files={"main": {**TELEGRAM, "cron/jobs.json": jobs}}))
        self.assertEqual(rows["main"]["issues"], [])

    def test_T7_루트가_꺼지면_꺼짐이고_남은_파일의_끊김은_보이지_않는다(self):
        rows = collect(self.run_home(root("stopped", main__telegram={"state": "connected"}), {"main": LEFTOVER}))
        self.assertIs(rows["main"]["running"], False)
        self.assertFalse(any("disconnected" in t for t in texts(rows["main"])), texts(rows["main"]))

    def test_T8_집계는_두_번_세지_않고_못_돌리는_채널은_분모에서_뺀다(self):
        home = self.run_home(root(main__telegram={"state": "connected"},
                                  main__webhook={"state": "disabled", "error_code": "multiplex_shared_ingress"}))
        tot = collect_all(home)["totals"]
        self.assertEqual((tot["messengers_connected"], tot["messengers_total"]), (1, 1))

    def test_T9_루트_자신의_채널_끊김은_루트_행에_그대로(self):
        home = self.run_home(root(telegram={"state": "disconnected"}, main__telegram={"state": "connected"}),
                             files={"default": TELEGRAM})
        rows = collect(home)
        self.assertTrue(any(t.startswith("telegram") and "disconnected" in t for t in texts(rows["default"])), texts(rows["default"]))
        self.assertEqual(rows["main"]["issues"], [])
        self.assertEqual([p["name"] for p in rows["default"]["platforms"]], ["telegram"])

    def test_T10_루트가_다시_켜지는_중에도_남은_파일을_믿지_않는다(self):
        rows = collect(self.run_home(root("starting"), {"main": LEFTOVER}))
        self.assertIs(rows["main"]["running"], False)
        self.assertFalse(any("disconnected" in t for t in texts(rows["main"])), texts(rows["main"]))


if __name__ == "__main__":
    unittest.main()
