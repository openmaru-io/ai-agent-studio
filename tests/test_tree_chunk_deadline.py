# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""묶음 내용 조각 읽기와 잠금 안 마감(스펙 2026-11-20-001 §5-0 0-1·§5-8 E1), 경우를 나누는 로그(H2).

OKE 에서 첫 `/v1/read` 조각이 가벼운 연산 한도(10초)를 넘어 실패하면 남은 조각을 읽지 않아(`break`) 묶음 내용이 비었고,
화면이 파일마다 사이드카를 불렀다(fea7 내용 0/1293). 고친 뒤: 한 조각이 실패해도 다음 조각을 읽고, 잠금을 잡은 때부터
마감 하나(목록 + 조각)를 둔다. 로그는 배포 직후·오래 비움·사이드카 재시작을 가를 수 있게 값을 더한다."""
import base64
import contextlib
import io
import json
import time
import unittest
import unittest.mock

from aas.hermes.readers import remote, tree_cache

FILES = [f"f{i}.md" for i in range(6)]                      # 4바이트씩, 조각 8바이트 → 조각 3개


def listing(cursor="ep:1"):
    return {"entries": [{"path": p, "type": "file", "size": 4, "mtime": 1.0, "mode": 0o100644} for p in FILES],
            "partial": [], "cursor": cursor}


class FakeSidecar(remote.RemoteBackend):
    """`_send` 만 흉내 낸다 — `_call` 의 응답 없음 기억·오류 처리는 진짜 코드가 돈다."""

    def __init__(self, read_plan=None, changes=None, changes_sleep=0.0):
        super().__init__("http://127.0.0.1:9", "t", label="chunk-x")
        self.read_plan = list(read_plan or [])          # 조각마다 "ok" | "timeout" | "error"
        self.changes = changes                           # None 이면 404(옛 사이드카), dict 면 그 답
        self.changes_sleep = changes_sleep
        self.calls = []                                  # (path, timeout, 경로 수)

    def _send(self, method, target, data, headers, timeout=None):
        path = target
        body = json.loads(data) if data else {}
        self.calls.append((path, timeout, len(body.get("paths") or ())))
        if path == "/v1/tree":
            return 200, json.dumps(listing()).encode()
        if path == "/v1/changes":
            time.sleep(self.changes_sleep)
            if self.changes is None:
                return 404, b'{"error":"none"}'
            if self.changes == "error":
                return 500, b'{"error":"boom"}'
            return 200, json.dumps(self.changes).encode()
        if path == "/v1/read":
            kind = self.read_plan.pop(0) if self.read_plan else "ok"
            if kind == "timeout":
                err = remote.SidecarError("timeout")
                err.timed_out = True
                raise err
            if kind == "error":
                return 500, b'{"error":"boom"}'
            files = [{"path": p, "ok": True, "data_b64": base64.b64encode(b"abcd").decode()} for p in body["paths"]]
            return 200, json.dumps({"files": files}).encode()
        return 404, b'{"error":"none"}'

    def reads(self):
        return [c for c in self.calls if c[0] == "/v1/read"]

    def _start_fill(self):                                   # 빠진 내용 채우기 스레드는 따로 시험한다(FillMissingTest) — 읽기 횟수 세기에 끼지 않게
        self.fill_started = True


def chunked():
    return unittest.mock.patch.object(remote, "READ_CHUNK", 8)


class ChunkReadTest(unittest.TestCase):
    def test_first_chunk_timeout_does_not_stop_the_rest(self):
        b = FakeSidecar(read_plan=["timeout", "ok", "ok"])
        with chunked():
            self.assertTrue(b.snapshot())
        self.assertEqual(len(b.reads()), 3)
        self.assertEqual(sorted(b._tree.data), FILES[2:])            # 실패한 첫 조각의 두 파일만 빠진다
        self.assertEqual(b._down_at, 0.0)                            # 조각 읽기 실패는 「응답 없음」 기억을 켜지 않는다

    def test_single_file_chunk_timeout_does_not_remember_down(self):
        b = FakeSidecar(read_plan=["ok", "ok", "timeout"])
        with unittest.mock.patch.object(remote, "READ_CHUNK", 4):    # 조각마다 파일 하나
            b.read_plan = ["ok", "ok", "ok", "ok", "ok", "timeout"]
            self.assertTrue(b.snapshot())
        self.assertEqual(b._down_at, 0.0)
        self.assertEqual(len(b._tree.data), 5)

    def test_two_timeouts_skip_the_remaining_chunks(self):
        b = FakeSidecar(read_plan=["timeout", "timeout", "ok"])
        with chunked():
            self.assertTrue(b.snapshot())
        self.assertEqual(len(b.reads()), 2)
        self.assertEqual(b._tree.data, {})

    def test_three_other_failures_skip_the_remaining_chunks(self):
        b = FakeSidecar(read_plan=["error", "error", "error", "ok"])
        with unittest.mock.patch.object(remote, "READ_CHUNK", 4):
            self.assertTrue(b.snapshot())
        self.assertEqual(len(b.reads()), 3)

    def test_chunk_timeouts_use_the_remaining_deadline(self):
        b = FakeSidecar()
        with chunked():
            self.assertTrue(b.snapshot())
        limits = [t for _, t, _ in b.reads()]
        self.assertTrue(all(t is not None and t <= remote.LOCK_BUDGET for t in limits), limits)
        self.assertTrue(all(t > remote.LIGHT_TIMEOUT for t in limits), limits)   # 10초가 아니라 남은 마감

    def test_list_stage_shares_the_deadline(self):
        """변경분이 실패하면 목록 전체 받기도 같은 마감 안에서 — 목록만 120초까지 가지 않게(Eng 재검토 H4)."""
        b = FakeSidecar(changes="error", changes_sleep=0.25)
        with chunked():
            self.assertTrue(b.snapshot())
            b._tree.taken -= remote.TREE_TTL + 1
            with unittest.mock.patch.object(remote, "LOCK_BUDGET", 30.0):
                self.assertTrue(b.snapshot())
        tree_calls = [t for p, t, _ in b.calls if p == "/v1/tree"]
        self.assertLessEqual(tree_calls[-1], 30.0 - 0.25 + 0.05)                # 변경분이 쓴 만큼 줄어든 남은 마감
        self.assertGreaterEqual(tree_calls[-1], remote.LIGHT_TIMEOUT)

    def test_no_time_left_skips_chunks_and_keeps_listing(self):
        """마감이 없어도 목록 전체는 LIGHT_TIMEOUT 으로 받는다 — 목록까지 없으면 화면이 파일마다 묻는다. 내용 조각만 건너뛴다."""
        b = FakeSidecar()
        with chunked(), unittest.mock.patch.object(remote, "LOCK_BUDGET", 0.0):
            self.assertTrue(b.snapshot())
        self.assertEqual(b.reads(), [])
        self.assertEqual(set(b._tree.entries), set(FILES))           # 목록은 있다 — 내용만 빈다(읽을 때 하나씩)


class FillMissingTest(unittest.TestCase):
    """처음 받기가 마감·조각 실패로 내용 일부를 못 받으면, 받기가 끝난 뒤 뒤에서 빠진 파일만 채운다(스펙 2026-11-20-001 §5-0-7).
    OKE 에서 큰 에이전트의 처음 받기가 60초 마감에 닿아 빠진내용=155~299 였고, 빠진 파일은 읽을 때마다 사이드카에 하나씩 물었다."""

    def test_빠진_내용이_있으면_채우기를_띄운다(self):
        b = FakeSidecar(read_plan=["timeout", "ok", "ok"])
        with chunked():
            self.assertTrue(b.snapshot())
        self.assertEqual(b._missing, 2)
        self.assertTrue(getattr(b, "fill_started", False))

    def test_빠진_내용이_없으면_띄우지_않는다(self):
        b = FakeSidecar()
        with chunked():
            self.assertTrue(b.snapshot())
        self.assertFalse(getattr(b, "fill_started", False))

    def test_채우기는_빠진_파일만_읽어_지금_묶음에_넣는다(self):
        b = FakeSidecar(read_plan=["timeout", "ok", "ok"])
        with chunked():
            self.assertTrue(b.snapshot())
            before = len(b.reads())
            tree = b._tree
            left = b._fill_missing()
        self.assertEqual(left, 0)
        self.assertIs(b._tree, tree)                                     # 묶음을 새로 받지 않고 그 자리에서 채운다
        self.assertEqual(sorted(tree.data), FILES)
        fill_reads = b.reads()[before:]
        self.assertEqual([n for _, _, n in fill_reads], [2])             # 빠진 두 파일만, 조각 하나
        self.assertEqual(b._missing, 0)
        self.assertEqual(b._down_at, 0.0)

    def test_채우기_반복은_더_줄지_않으면_멈춘다(self):
        b = FakeSidecar(read_plan=["timeout", "ok", "ok"])
        with chunked():
            self.assertTrue(b.snapshot())
            b.read_plan = ["timeout", "timeout", "timeout", "timeout"]   # 채우기도 계속 실패
            remote.RemoteBackend._fill_loop(b)
        self.assertEqual(b._missing, 2)
        self.assertFalse(b._filling)


class CaseLogTest(unittest.TestCase):
    def capture(self):
        out = io.StringIO()
        return out, contextlib.redirect_stdout(out)

    def test_fetch_line_tells_uptime_drop_and_reset(self):
        b = FakeSidecar(changes={"cursor": "ep:2", "reset": True})
        with chunked():
            self.assertTrue(b.snapshot())
        b.drop("idle")
        out, redirect = self.capture()
        with chunked(), redirect, unittest.mock.patch.object(remote, "SLOW_LOG", -1.0):
            self.assertTrue(b.snapshot())
        line = [ln for ln in out.getvalue().splitlines() if ln.startswith("묶음 받기 느림 chunk-x")][0]
        self.assertIn("까닭=처음", line)
        self.assertIn("뜬뒤=", line)
        self.assertIn("버린뒤=", line)
        self.assertIn("(idle)", line)
        # 커서 reset 도 줄에 남는다
        b._tree.taken -= remote.TREE_TTL + 1
        b._slow_logged.clear()
        out2, redirect2 = self.capture()
        with chunked(), redirect2, unittest.mock.patch.object(remote, "SLOW_LOG", -1.0):
            self.assertTrue(b.snapshot())
        line2 = [ln for ln in out2.getvalue().splitlines() if ln.startswith("묶음 받기 느림 chunk-x")][0]
        self.assertIn("까닭=만료", line2)
        self.assertIn("reset", line2)

    def test_missing_content_is_counted_in_the_line(self):
        b = FakeSidecar(read_plan=["timeout", "ok", "ok"])
        out, redirect = self.capture()
        with chunked(), redirect, unittest.mock.patch.object(remote, "SLOW_LOG", -1.0):
            self.assertTrue(b.snapshot())
        line = [ln for ln in out.getvalue().splitlines() if ln.startswith("묶음 받기 느림 chunk-x")][0]
        self.assertIn("빠진내용=2", line)

    def test_sweep_tells_idle_from_cap(self):
        b = FakeSidecar()
        with chunked():
            self.assertTrue(b.snapshot())
        with unittest.mock.patch.object(tree_cache, "_used", {}), unittest.mock.patch.object(tree_cache, "_grace", {}):
            tree_cache.sweep([b])                                    # 사람이 쓴 적 없음·유예 끝남 → idle
        self.assertEqual(b._drop_kind, "idle")
        with chunked():
            self.assertTrue(b.snapshot())
        with unittest.mock.patch.object(tree_cache, "_used", {"chunk-x": time.monotonic()}), \
                unittest.mock.patch.object(tree_cache, "_grace", {}), \
                unittest.mock.patch.object(tree_cache, "cap_bytes", lambda: 0):
            tree_cache.sweep([b])
        self.assertEqual(b._drop_kind, "cap")

    def test_lock_waits_are_counted_and_flushed(self):
        b = FakeSidecar()
        b._note_wait(3.0)
        b._note_wait(5.0)
        b._note_wait(0.5)                                            # 기준(SLOW_LOG) 아래는 세지 않는다
        out, redirect = self.capture()
        with redirect:
            b.flush_waits()
            b.flush_waits()                                          # 새로 센 것이 없으면 줄을 남기지 않는다
        lines = [ln for ln in out.getvalue().splitlines() if ln.startswith("묶음 잠금 대기 합계 chunk-x")]
        self.assertEqual(len(lines), 1, out.getvalue())
        self.assertIn("2번", lines[0])
        self.assertIn("합 8.0초", lines[0])
        self.assertIn("최대 5.0초", lines[0])


if __name__ == "__main__":
    unittest.main()
