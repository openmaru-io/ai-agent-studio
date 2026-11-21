# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""M2-8: 전체 POD 수집(동시 N개·POD 별 시간 제한), 병합, 관리자 요약, 다음 바퀴 건너뛰기."""
import os
import tempfile
import threading
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ["AAS_DATA_DIR"] = str(Path(TMP.name) / "data")

from aas.ops import collect_all, cron_health, digest, evaluate, mutes
from aas.fleet import pods
from aas.common import store  # noqa: E402

NOW = datetime(2026, 10, 10, 12, 0, tzinfo=timezone.utc)


def health(profile="ma", incidents=0, failing=True, status="ok", **over):
    """cron_health.collect 결과 모양의 가짜 한 POD 분."""
    inc = [{"profile": profile, "id": f"i{n}", "job_id": f"j{n}", "job": f"job{n}", "new": n == 0, "now": "failing" if failing else "ok",
            "error": "boom", "age_days": 2, "first_seen_at": "2026-10-08T00:00:00+00:00", "last_seen_at": "2026-10-10T00:00:00+00:00", "ack": "x"}
           for n in range(incidents)]
    row = {"name": profile, "jobs_status": "ok" if status == "ok" else "error", "exec_status": "ok" if status == "ok" else "error",
           "detail": "" if status == "ok" else "읽지 못함", "jobs_total": 3, "jobs_active": 2, "open_incidents": incidents, "new_incidents": min(incidents, 1),
           "failed_jobs": 0, "stalled_jobs": 0, "silent_jobs": 0, "runs_7d": 5, "runs_failed_7d": incidents, "stale": False}
    out = {"collected_at": NOW.isoformat(), "profiles": [row], "incidents": inc, "failed_jobs": [], "stalled": [], "silent": []}
    out["totals"] = {"profiles": 1, "profiles_ok": 1 if status == "ok" else 0, "jobs": 3, "jobs_active": 2, "open_incidents": incidents,
                     "new_incidents": min(incidents, 1), "live_incidents": incidents if failing else 0, "settled_incidents": 0 if failing else incidents,
                     "failed_jobs": 0, "stalled": 0, "silent": 0, "stale_profiles": []}
    out.update(over)
    return out


def pod(pid):
    return pods.Pod(pid, "o@x.com", Path("/x/" + pid))


class MergeTest(unittest.TestCase):
    def test_프로파일_이름에_POD_를_붙이되_무시_기록을_맞출_원래_이름은_남긴다(self):
        s = collect_all.scoped(health("ma", incidents=1), "hag-a")
        self.assertEqual(s["profiles"][0]["name"], "hag-a/ma")
        self.assertEqual((s["incidents"][0]["profile"], s["incidents"][0]["raw_profile"]), ("hag-a/ma", "ma"))

    def test_POD_둘을_합치면_숫자가_더해지고_같은_프로파일_이름도_섞이지_않는다(self):
        a, b = collect_all.scoped(health("ma", 2), "hag-a"), collect_all.scoped(health("ma", 1, failing=False), "hag-b")
        m = collect_all.merge([a, b], pods_total=2)
        t = m["totals"]
        self.assertEqual((t["profiles"], t["profiles_ok"], t["open_incidents"], t["live_incidents"], t["settled_incidents"], t["jobs"]), (2, 2, 3, 2, 1, 6))
        self.assertEqual(sorted(p["name"] for p in m["profiles"]), ["hag-a/ma", "hag-b/ma"])
        self.assertEqual(len(m["incidents"]), 3)
        self.assertEqual(m["pods"], {"ok": 2, "total": 2, "failed": []})

    def test_수집_실패_POD_는_실패_줄로_남고_전체_숫자에_성공으로_세지_않는다(self):
        m = collect_all.merge([collect_all.scoped(health("ma", 1), "hag-a"), collect_all.failure("hag-b", "시간 초과(60초)", NOW)], pods_total=2)
        self.assertEqual(m["pods"], {"ok": 1, "total": 2, "failed": [{"pod": "hag-b", "reason": "시간 초과(60초)"}]})
        bad = [p for p in m["profiles"] if p["name"].startswith("hag-b")][0]
        self.assertEqual((bad["exec_status"], bad["detail"]), ("error", "시간 초과(60초)"))
        self.assertEqual(m["totals"]["profiles_ok"], 1)


class PoolTest(unittest.TestCase):
    def test_응답_없는_POD_하나가_다른_POD_수집을_늦추지_않는다(self):
        release = threading.Event()

        def fake(now=None, home=None):
            if home.name == "hag-slow":
                release.wait(5)                           # 응답 없는 사이드카
                return health("x")
            return health("ma", 1)
        try:
            started = time.monotonic()
            m = collect_all.collect_pods([pod("hag-slow"), pod("hag-1"), pod("hag-2")], collect=fake, workers=8, timeout=0.5)
            took = time.monotonic() - started
        finally:
            release.set()
        self.assertLess(took, 2.0)                        # 시간 제한(0.5초)만 기다린다
        self.assertEqual(m["pods"]["ok"], 2)
        self.assertEqual([f["pod"] for f in m["pods"]["failed"]], ["hag-slow"])
        self.assertIn("시간 초과", m["pods"]["failed"][0]["reason"])
        self.assertEqual(m["totals"]["open_incidents"], 2)

    def test_동시_실행은_workers_개까지만(self):
        lock, state = threading.Lock(), {"now": 0, "max": 0}

        def fake(now=None, home=None):
            with lock:
                state["now"] += 1; state["max"] = max(state["max"], state["now"])
            time.sleep(0.05)
            with lock:
                state["now"] -= 1
            return health("ma")
        collect_all.collect_pods([pod(f"hag-{i}") for i in range(12)], collect=fake, workers=3, timeout=5)
        self.assertEqual(state["max"], 3)

    def test_수집_함수가_예외를_내도_그_POD_만_실패로_남긴다(self):
        def fake(now=None, home=None):
            if home.name == "hag-bad":
                raise OSError("사이드카에 연결할 수 없습니다")
            return health("ma")
        m = collect_all.collect_pods([pod("hag-bad"), pod("hag-ok")], collect=fake, workers=2, timeout=5)
        self.assertEqual((m["pods"]["ok"], m["pods"]["failed"][0]["pod"]), (1, "hag-bad"))
        self.assertIn("OSError", m["pods"]["failed"][0]["reason"])

    def test_POD_가_없으면_빈_수집(self):
        m = collect_all.collect_pods([], collect=lambda **k: health("x"), workers=2, timeout=1)
        self.assertEqual((m["pods"]["total"], m["totals"]["profiles"]), (0, 0))

    def test_설정값(self):
        with mock.patch.dict(os.environ, {"AAS_COLLECT_WORKERS": "4", "AAS_COLLECT_TIMEOUT": "30"}):
            self.assertEqual((collect_all.workers(), collect_all.timeout()), (4, 30.0))
        with mock.patch.dict(os.environ, {"AAS_COLLECT_WORKERS": "0", "AAS_COLLECT_TIMEOUT": "x"}):
            self.assertEqual((collect_all.workers(), collect_all.timeout()), (8, 60.0))     # 잘못된 값은 기본값


class RoundGuardTest(unittest.TestCase):
    def test_한_바퀴가_안_끝났으면_다음_바퀴는_건너뛴다(self):
        gate, ran = threading.Event(), []
        guard = collect_all.RoundGuard()

        def work():
            ran.append(1)
            gate.wait(2)
        t = threading.Thread(target=lambda: guard.run(work)); t.start()
        time.sleep(0.1)
        self.assertFalse(guard.run(lambda: ran.append(2)))      # 건너뜀
        gate.set(); t.join()
        self.assertTrue(guard.run(lambda: ran.append(3)))
        self.assertEqual(ran, [1, 3])


class SnapshotAndReportTest(unittest.TestCase):
    def setUp(self):
        with store.connect() as c:
            for t in ("snapshots", "incident_seen", "snapshot_totals", "cron_muted", "meta"):
                try:
                    c.execute(f"DELETE FROM {t}")
                except Exception:
                    pass

    def merged(self):
        return collect_all.merge([collect_all.scoped(health("ma", 2), "hag-a"), collect_all.scoped(health("ma", 1), "hag-b"),
                                  collect_all.failure("hag-c", "시간 초과(60초)", NOW)], pods_total=3)

    def test_스냅샷은_POD_별로_따로_쌓이고_수집_실패_POD_의_사건은_닫힌_것으로_치지_않는다(self):
        store.record_snapshot(self.merged())
        with store.connect() as c:
            rows = {r["profile"]: r["open_incidents"] for r in c.execute("SELECT profile, open_incidents FROM snapshots")}
        self.assertEqual(rows["hag-a/ma"], 2); self.assertEqual(rows["hag-b/ma"], 1)
        self.assertIn("hag-c/(수집)", rows)
        # 다음 바퀴에 hag-a 의 사건이 사라지면 닫힘, hag-b 가 실패하면 닫지 않는다
        nxt = collect_all.merge([collect_all.scoped(health("ma", 0), "hag-a"), collect_all.failure("hag-b", "시간 초과(60초)", NOW)], pods_total=2)
        nxt["collected_at"] = "2026-10-10T12:30:00+00:00"
        store.record_snapshot(nxt)
        with store.connect() as c:
            closed = {(r["profile"], r["incident_id"]): r["closed_seen_at"] for r in c.execute("SELECT * FROM incident_seen")}
        self.assertIsNotNone(closed[("hag-a/ma", "i0")])
        self.assertIsNone(closed[("hag-b/ma", "i0")])

    def test_무시한_작업은_POD_이름이_붙어도_원래_프로파일_이름으로_맞춘다(self):
        mutes.mute("ma", "j0", "job0")
        out = mutes.apply(self.merged())
        muted = [i for i in out["incidents"] if i["muted"]]
        self.assertEqual({i["profile"] for i in muted}, {"hag-a/ma", "hag-b/ma"})      # 두 POD 모두 같은 (ma, j0) 가 무시된다
        self.assertEqual(out["totals"]["new_incidents"], 0)
        mutes.unmute("ma", "j0")

    def test_다이제스트는_수집한_POD_수와_실패한_POD_를_적고_0건이어도_만든다(self):
        text = digest.render(self.merged())
        self.assertIn("POD 2/3", text)
        self.assertIn("hag-c", text)
        self.assertIn("시간 초과(60초)", text)
        empty = digest.render(collect_all.merge([collect_all.scoped(health("ma", 0), "hag-a")], pods_total=1))
        self.assertIn("POD 1/1", empty)

    def test_주간_평가에_POD_별_절이_생긴다(self):
        store.record_snapshot(self.merged())
        md = evaluate.weekly_md(NOW)
        self.assertIn("## POD 별 현황", md)
        self.assertIn("hag-a", md); self.assertIn("hag-b", md)

    def test_POD_가_하나면_예전_모양_그대로(self):
        store.record_snapshot(health("ma", 1))
        self.assertNotIn("## POD 별 현황", evaluate.weekly_md(NOW))
        self.assertNotIn("POD ", digest.render(health("ma", 1)).split("\n")[1])

    def test_바퀴_기록(self):
        collect_all.save_round({"ok": 2, "total": 3, "failed": [{"pod": "hag-c", "reason": "x"}]}, 12.3)
        got = collect_all.last_round()
        self.assertEqual((got["pods"]["ok"], got["seconds"]), (2, 12.3))
        self.assertTrue(got["ts"])


class _Sidecar:
    """`RemoteBackend` 에 `_send` 만 흉내 낸다 — 묶음 받기·`touch`·받기 로그는 운영 코드가 돈다(test_tree_chunk_deadline 과 같은 방식)."""

    @staticmethod
    def make(label):
        import base64
        import json
        from aas.hermes.readers import remote

        class Fake(remote.RemoteBackend):
            def _send(self, method, target, data, headers, timeout=None):
                body = json.loads(data) if data else {}
                if target == "/v1/tree":
                    return 200, json.dumps({"entries": [{"path": "a.md", "type": "file", "size": 4, "mtime": 1.0, "mode": 0o100644}],
                                            "partial": [], "cursor": "ep:1"}).encode()
                if target == "/v1/read":
                    return 200, json.dumps({"files": [{"path": p, "ok": True, "data_b64": base64.b64encode(b"abcd").decode()}
                                                      for p in body["paths"]]}).encode()
                return 404, b'{"error":"none"}'
        return Fake("http://127.0.0.1:9", "t", label=label)


class WorkerContextTest(unittest.TestCase):
    """map_pods 일꾼이 부른 쪽의 「사람의 요청」 표시와 언어만 물려받는다(스펙 2026-11-20-006).
    고치기 전에는 일꾼 스레드가 빈 맥락으로 시작해, 사람이 연 프로파일 화면의 다른 에이전트 묶음도 5분 정리에서 버려졌다."""

    def setUp(self):
        from aas.hermes.readers import tree_cache
        self.tc = tree_cache
        self.saved_used, self.saved_grace = dict(tree_cache._used), dict(tree_cache._grace)
        tree_cache._used.clear()

    def tearDown(self):
        self.tc._used.clear()
        self.tc._used.update(self.saved_used)
        self.tc._grace.clear()
        self.tc._grace.update(self.saved_grace)

    def human(self, value):
        token = self.tc.HUMAN.set(value)
        self.addCleanup(self.tc.HUMAN.reset, token)

    def test_1_사람의_요청이면_일꾼도_사람_배경이면_일꾼도_배경(self):
        self.human(True)
        got = collect_all.map_pods([pod("hag-a"), pod("hag-b")], lambda p: self.tc.HUMAN.get(), workers=2, timeout=5)
        self.assertEqual({k: v for k, v in got.items()}, {"hag-a": (True, True), "hag-b": (True, True)})
        self.human(False)
        got = collect_all.map_pods([pod("hag-a")], lambda p: self.tc.HUMAN.get(), workers=1, timeout=5)
        self.assertEqual(got["hag-a"], (True, False))

    def test_2_일꾼의_문구가_요청_언어를_따른다(self):
        from aas.common import i18n
        token = i18n._lang.set("en")
        self.addCleanup(i18n._lang.reset, token)
        got = collect_all.map_pods([pod("hag-a")], lambda p: i18n.tr("한국어", "English"), workers=1, timeout=5)
        self.assertEqual(got["hag-a"], (True, "English"))

    def test_3_요청_메모와_다시_시작_기록은_넘기지_않는다(self):
        from aas.ops import restart_pending
        held = restart_pending._HELD.set({"pod": "hag-a"})
        self.addCleanup(restart_pending._HELD.reset, held)
        self.human(True)
        with store.request_memo(), restart_pending.recording("hag-a", "p", "o@x.com"):
            self.assertIsNotNone(store._MEMO.get())
            got = collect_all.map_pods([pod("hag-a")], lambda p: (store._MEMO.get(), restart_pending._CTX.get(), restart_pending._HELD.get()),
                                       workers=1, timeout=5)
        self.assertEqual(got["hag-a"], (True, (None, None, None)))

    def test_4_앞_호출의_값이나_포기된_일꾼이_다음_배경_호출에_남지_않는다(self):
        release, done = threading.Event(), threading.Event()

        def slow(p):
            release.wait(5)
            done.set()
            return self.tc.HUMAN.get()
        self.human(True)
        got = collect_all.map_pods([pod("hag-slow")], slow, workers=1, timeout=0.2)     # 한도를 넘겨 포기된다
        self.assertFalse(got["hag-slow"][0])
        release.set()
        self.assertTrue(done.wait(5))
        self.human(False)
        got = collect_all.map_pods([pod("hag-a"), pod("hag-b")], lambda p: self.tc.HUMAN.get(), workers=1, timeout=5)
        self.assertEqual({v for v in got.values()}, {(True, False)})

    def test_5_사람이_연_다른_에이전트의_묶음은_정리에서_남고_받기_줄에_사람_칸이_찍힌다(self):
        import contextlib
        import io
        from aas.hermes.readers import remote
        out = io.StringIO()
        with mock.patch.object(remote, "SLOW_LOG", -1.0), mock.patch.object(self.tc, "cap_bytes", lambda: 1 << 40), \
                contextlib.redirect_stdout(out):
            seen = _Sidecar.make("hag-seen")                         # label = pod id(운영 fleet/pods.py 와 같은 규칙)
            self.human(True)
            collect_all.map_pods([pod("hag-seen")], lambda p: seen.snapshot(), workers=1, timeout=5)
            bg = _Sidecar.make("hag-bg")                             # 백엔드를 따로 — 받기 줄은 백엔드마다 60초에 한 줄
            self.human(False)
            collect_all.map_pods([pod("hag-bg")], lambda p: bg.snapshot(), workers=1, timeout=5)
            with mock.patch.object(self.tc, "_grace", {}):          # 배경 받기의 유예(§5-0-7)를 빼고 사람 사용 규칙만 본다
                dropped = self.tc.sweep([seen, bg])
        self.assertEqual(dropped, ["hag-bg"])                        # 고치기 전에는 사람이 연 hag-seen 도 idle 로 버려졌다
        self.assertTrue(seen.has_tree())
        lines = out.getvalue()
        self.assertRegex(lines, r"묶음 받기 느림 hag-seen .*사람=True")
        self.assertRegex(lines, r"묶음 받기 느림 hag-bg .*사람=False")

    def test_5_일꾼_안의_캐시_조회도_사람이_본_것으로_센다(self):
        from aas.web import server
        self.human(True)
        collect_all.map_pods([pod("hag-cache")], lambda p: server._cached(f"{p.id}:wctx-test", 1, lambda: 1, per_lang=False),
                             workers=1, timeout=5)
        server._forget(pod("hag-cache"), notify=False)
        self.assertIn("hag-cache", self.tc._used)
        self.assertFalse(self.tc.idle("hag-cache"))


if __name__ == "__main__":
    unittest.main()
