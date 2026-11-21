# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""게이트웨이 다시 시작 필요 장부(스펙 2026-11-18-016 4-1~4-3): 판정·기록·지우기·옛 장부 옮기기·잠금·시작 시각."""
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import store  # noqa: E402
from aas.ops import restart_pending as rp  # noqa: E402

POD = "rp-test"
T0 = 1_800_000_000.0


def clean():
    with store.connect() as conn:
        for table in ("restart_pending", "restart_lock"):
            conn.execute(f"DELETE FROM {table} WHERE pod LIKE 'rp-%'")
        conn.execute("DELETE FROM meta WHERE key LIKE 'messenger_restart:rp-%'")
    rp._starts.clear()
    rp._logged.clear()


def names(pod=POD):
    return sorted((r["profile"], r["kind"], r["target"]) for r in rp.all_items(pod))


class NeedsRestart(unittest.TestCase):
    def test_kind_별_판단(self):
        self.assertEqual(rp.needs_restart("mcp", name="docmost"), [("mcp", "docmost")])
        self.assertEqual(rp.needs_restart("channel", name="telegram", hot_served=True), [])
        self.assertEqual(rp.needs_restart("channel", name="telegram", hot_served=False), [("channel", "telegram")])
        self.assertEqual(rp.needs_restart("pairing"), [("pairing", "*")])
        self.assertEqual(rp.needs_restart("mindwiki"), [("mindwiki", "mindwiki")])

    def test_env_는_쓰이는_변수만_읽기_실패면_기록(self):
        cfg = {"mcp_servers": {"docmost": {"headers": {"Authorization": "Bearer ${MCP_DOCMOST_API_KEY}"}}}, "platforms": {}}
        self.assertEqual(rp.needs_restart("env", name="MCP_DOCMOST_API_KEY", before=cfg), [("env", "MCP_DOCMOST_API_KEY")])
        self.assertEqual(rp.needs_restart("env", name="OTHER_KEY", before=cfg), [])
        self.assertEqual(rp.needs_restart("env", name="TELEGRAM_BOT_TOKEN", before=cfg, managed=True), [("env", "TELEGRAM_BOT_TOKEN")])
        self.assertEqual(rp.needs_restart("env", name="OTHER_KEY", before=None), [("env", "OTHER_KEY")])

    def test_config_비교는_platforms_와_있던_mcp_항목만(self):
        before = {"model": "a", "platforms": {"telegram": {"enabled": True}}, "mcp_servers": {"docmost": {"url": "a"}, "old": {"url": "x"}}}
        after = {"model": "b", "platforms": {"telegram": {"enabled": False}}, "mcp_servers": {"docmost": {"url": "b"}, "new": {"url": "y"}}}
        self.assertEqual(rp.needs_restart("config", before=before, after=after), [("channel", "telegram"), ("mcp", "docmost")])
        self.assertEqual(rp.needs_restart("config", before={"model": "a"}, after={"model": "b"}), [])
        self.assertEqual(rp.needs_restart("config", before=None, after={}), [("config", "config.yaml")])


class Ledger(unittest.TestCase):
    def setUp(self):
        clean()

    tearDown = setUp

    def test_같은_대상은_한_줄로_고친다(self):
        rp.add(POD, "main", "mcp", "docmost", "도구 범위", "a@x.com", now=T0)
        rp.add(POD, "main", "mcp", "docmost", "도구 범위", "b@x.com", now=T0 + 5)
        got = rp.items(POD)
        self.assertEqual(got["total"], 1)
        self.assertEqual((got["items"][0]["by"], got["items"][0]["at"]), ("b@x.com", T0 + 5))

    def test_target_note_120자(self):
        rp.add(POD, "main", "mcp", "x" * 300, "n" * 300, now=T0)
        row = rp.items(POD)["items"][0]
        self.assertEqual((len(row["target"]), len(row["note"])), (120, 120))

    def test_모르는_kind_는_거절(self):
        with self.assertRaises(ValueError):
            rp.add(POD, "main", "model", "x")

    def test_최근_순_20건과_total(self):
        for i in range(25):
            rp.add(POD, "main", "env", f"K{i:02d}", now=T0 + i)
        got = rp.items(POD)
        self.assertEqual((got["total"], len(got["items"]), got["items"][0]["target"]), (25, 20, "K24"))

    def test_다시_시작_뒤에는_요청_시각_전_기록만_지운다(self):
        rp.add(POD, "main", "mcp", "a", now=T0)
        rp.add(POD, "main", "mcp", "b", now=T0 + 10)               # 다시 시작을 요청한 뒤 생긴 기록
        rp.add(POD, "work", "mcp", "c", now=T0)
        rp.clear(POD, ["main"], before=T0 + 5)
        self.assertEqual(names(), [("main", "mcp", "b"), ("work", "mcp", "c")])
        rp.clear(POD, None, before=T0 + 5)                           # 쿠버네티스: 작업공간 전체
        self.assertEqual(names(), [("main", "mcp", "b")])

    def test_바깥_다시_시작은_시작_시각_여유_전_기록만(self):
        rp.add(POD, "main", "mcp", "old", now=T0)
        rp.add(POD, "main", "mcp", "edge", now=T0 + 97)             # 시작 100 - 5 = 95 보다 뒤 — 애매하면 남긴다
        rp.add(POD, "main", "mcp", "after", now=T0 + 120)
        self.assertEqual(rp.prune(POD, {"main": T0 + 100}), 1)
        self.assertEqual(names(), [("main", "mcp", "after"), ("main", "mcp", "edge")])

    def test_여유는_환경_변수로(self):
        rp.add(POD, "main", "mcp", "edge", now=T0 + 97)
        with mock.patch.dict(os.environ, {"AAS_RESTART_CLOCK_SKEW_S": "0"}):
            rp.prune(POD, {"main": T0 + 100})
        self.assertEqual(names(), [])

    def test_시작_시각을_모르면_지우지_않는다(self):
        rp.add(POD, "main", "mcp", "a", now=T0)
        self.assertEqual(rp.prune(POD, {"main": None}), 0)
        self.assertEqual(len(names()), 1)

    def test_보기는_캐시한_시작_시각으로_거른다(self):
        rp.add(POD, "main", "mcp", "old", now=T0)
        rp.add(POD, "main", "mcp", "new", now=T0 + 200)
        got = rp.items(POD, starts={"main": T0 + 100})
        self.assertEqual([r["target"] for r in got["items"]], ["new"])
        self.assertEqual(len(names()), 2)                            # 읽기만 — 지우지 않는다

    def test_이름_바꾸기는_따라가고_겹치면_덮어쓴다(self):
        rp.add(POD, "old", "mcp", "a", "옛", now=T0 + 10)
        rp.add(POD, "new", "mcp", "a", "새", now=T0)
        rp.rename(POD, "old", "new")
        rows = rp.items(POD)["items"]
        self.assertEqual([(r["profile"], r["note"]) for r in rows], [("new", "옛")])

    def test_프로파일_작업공간_지우기(self):
        rp.add(POD, "a", "mcp", "x", now=T0)
        rp.add(POD, "b", "mcp", "x", now=T0)
        rp.drop(POD, "a")
        self.assertEqual(names(), [("b", "mcp", "x")])
        rp.drop(POD)
        self.assertEqual(names(), [])

    def test_반영됨으로_표시는_멱등(self):
        rp.add(POD, "main", "env", "K", now=T0)
        self.assertEqual(rp.dismiss(POD, "main", "env", "K"), 1)
        self.assertEqual(rp.dismiss(POD, "main", "env", "K"), 0)

    def test_비밀값은_기록되지_않는다(self):
        with rp.recording(POD, "main", "a@x.com") as st:
            rp.note(rp.needs_restart("mcp", name="docmost"), "Docmost 도구 범위 바꾸기")
        blob = json.dumps(rp.items(POD), ensure_ascii=False)
        self.assertNotIn("Bearer", blob)
        self.assertEqual(rp.outcome(st), [{"profile": "main", "kind": "mcp", "target": "docmost"}])


class Legacy(unittest.TestCase):
    def setUp(self):
        clean()

    tearDown = setUp

    def put_meta(self, pod, profiles):
        with store.connect() as conn:
            conn.execute("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value=excluded.value",
                         (rp.LEGACY_KEY + pod, json.dumps(profiles)))

    def test_옮기기는_두_번_돌려도_한_줄이고_target_은_별(self):
        self.put_meta(POD, ["main"])
        rp.migrate_meta()
        self.put_meta(POD, ["main"])                                 # 롤아웃 중 옛 서버가 다시 썼다
        rp.migrate_meta()
        self.assertEqual(names(), [("main", "pairing", "*")])
        self.assertEqual(rp.items(POD)["items"][0]["by_kind"], "auto")

    def test_롤아웃_중에는_meta_도_함께_읽는다(self):
        self.put_meta(POD, ["work"])
        self.assertEqual(names(), [("work", "pairing", "*")])
        rp.clear(POD, ["work"], before=time.time())
        self.assertEqual(names(), [])


class Recording(unittest.TestCase):
    def setUp(self):
        clean()

    tearDown = setUp

    def test_범위_밖이면_기록하지_않는다(self):
        rp.note([("mcp", "x")])
        self.assertEqual(names(), [])

    def test_한_요청의_channel_과_pairing_은_channel_한_줄(self):
        with rp.recording(POD, "main", "a@x.com") as st:
            rp.note([("pairing", "telegram")], pod=POD, profile="main")
            rp.note([("channel", "telegram")])
        self.assertEqual(names(), [("main", "channel", "telegram")])
        self.assertEqual([m[1] for m in st["made"]], ["channel"])

    def test_MCP_도구로_바꾸면_by_kind(self):
        mark = store.actor_via.set("token")
        try:
            with rp.recording(POD, "main", "a@x.com"):
                rp.note([("mcp", "x")])
        finally:
            store.actor_via.reset(mark)
        self.assertEqual(rp.items(POD)["items"][0]["by_kind"], "mcp_tool")

    def test_DB_오류는_unrecorded(self):
        with rp.recording(POD, "main", "a@x.com") as st, mock.patch.object(rp, "add", side_effect=RuntimeError("db down")):
            rp.note([("mcp", "x")])
        self.assertEqual(rp.outcome(st), "unrecorded")


class Starts(unittest.TestCase):
    def setUp(self):
        clean()

    tearDown = setUp

    def test_마지막_줄(self):
        self.assertEqual(rp.last_start("1.5\n\n1800000000.25\n"), 1800000000.25)
        self.assertEqual(rp.last_start("1.5\nbroken"), 1.5)
        self.assertIsNone(rp.last_start(""))

    def test_hermes_계약_시작_기록_파일(self):
        """Hermes 664394605e gateway/status.py record_start_and_check_storm 이 쓰는 모양: repr(float) 한 줄씩, 끝 줄바꿈."""
        sample = "\n".join(repr(t) for t in (1763452800.123456, 1763452900.5)) + "\n"
        self.assertEqual(rp.last_start(sample), 1763452900.5)

    def test_compose_는_프로파일_폴더_쿠버네티스는_루트(self):
        home = Path(TMP.name) / "home"
        (home / "profiles" / "work").mkdir(parents=True, exist_ok=True)
        (home / "profiles" / "work" / "SOUL.md").write_text("x")
        (home / rp.STARTS_FILE).write_text("100.0\n")
        (home / "profiles" / "work" / rp.STARTS_FILE).write_text("200.0\n")
        self.assertEqual(rp.read_starts(home, shared_all=False), {"default": 100.0, "work": 200.0})
        self.assertEqual(rp.read_starts(home, shared_all=True), {"default": 100.0, "work": 100.0})

    def test_읽기_실패는_지우지_않고_로그는_10분에_한_번(self):
        rp.add(POD, "main", "mcp", "a", now=T0)

        def boom():
            raise OSError("sidecar down")
        with mock.patch("builtins.print") as out:
            rp.refresh_starts(POD, boom)
            rp.refresh_starts(POD, boom)
        self.assertEqual(out.call_count, 1)
        self.assertEqual(len(names()), 1)
        self.assertIsNone(rp.cached_starts(POD))

    def test_읽기는_2초_제한(self):
        def slow():
            time.sleep(3)
            return {"main": T0}
        t = time.time()
        with mock.patch.object(rp, "READ_LIMIT", 0.2), mock.patch("builtins.print"):
            self.assertIsNone(rp.refresh_starts(POD, slow))
        self.assertLess(time.time() - t, 1.5)

    def test_보기는_기다리지_않고_15초에_한_번_읽는다(self):
        calls = []

        def slow():
            calls.append(1)
            time.sleep(0.5)
            return {"main": T0}
        t = time.time()
        self.assertIsNone(rp.starts_for_view(POD, slow))
        self.assertIsNone(rp.starts_for_view(POD, slow))
        self.assertLess(time.time() - t, 0.3)
        time.sleep(0.8)
        self.assertEqual(rp.starts_for_view(POD, slow), {"main": T0})
        self.assertEqual(len(calls), 1)


class Gate(unittest.TestCase):
    def setUp(self):
        clean()

    tearDown = setUp

    def test_겹치면_Locked_와_남은_초_끝나면_풀림(self):
        with rp.restart_gate(POD, targets=1, step=60):
            with self.assertRaises(rp.Locked) as got:
                with _other_request(POD):
                    pass
            self.assertGreater(got.exception.retry_after, 60)
        with rp.restart_gate(POD):
            pass

    def test_실패해도_풀림(self):
        with self.assertRaises(RuntimeError):
            with rp.restart_gate(POD):
                raise RuntimeError("hermes")
        with _other_request(POD):
            pass

    def test_같은_요청_안에서는_다시_들어간다(self):
        with rp.restart_gate(POD, targets=2) as outer:
            with rp.restart_gate(POD) as inner:
                self.assertIs(inner, outer)
                inner.extend()

    def test_만료가_지나면_다른_요청이_얻는다(self):
        with store.connect() as conn:
            conn.execute("INSERT INTO restart_lock (pod, expires, token) VALUES (?,?,?)", (POD, time.time() - 1, "dead"))
        with _other_request(POD):
            pass


def _other_request(pod):
    """다른 요청(다른 컨텍스트)처럼 잠금을 얻는다."""
    import contextvars
    from contextlib import contextmanager

    @contextmanager
    def run():
        ctx = contextvars.Context()
        cm = rp.restart_gate(pod)
        ctx.run(cm.__enter__)
        try:
            yield
        finally:
            ctx.run(cm.__exit__, None, None, None)
    return run()


if __name__ == "__main__":
    unittest.main()
