# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""읽기 사이드카 — 연산 5개(stat/read/list/sqlite/version), 토큰, 경로·심링크 탈출 거절, 읽기 전용 SQL."""
import base64
import http.client
import json
import os
import sqlite3
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sidecar"))

from aas_sidecar import ops, server  # noqa: E402

TOKEN = "t0ken-for-tests-0123456789"


def make_root(tmp: Path) -> Path:
    root = tmp / "hermes"
    (root / "profiles" / "ma" / "cron").mkdir(parents=True)
    (root / "config.yaml").write_text("model:\n  default: m\n", encoding="utf-8")
    (root / "profiles" / "ma" / "config.yaml").write_text("x: 1\n", encoding="utf-8")
    (root / "binary.bin").write_bytes(bytes(range(256)))
    (root / "big.txt").write_text("a" * 5000, encoding="utf-8")
    db = root / "state.db"
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, n INTEGER, blob BLOB)")
    conn.executemany("INSERT INTO sessions VALUES (?,?,?,?)",
                     [(f"s{i}", "cli" if i % 2 else "cron", i, b"\x00\x01") for i in range(10)])
    conn.commit()
    conn.close()
    outside = tmp / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("SHOULD_NOT_BE_READ", encoding="utf-8")
    (root / "link-out").symlink_to(outside)                        # 폴더 밖을 가리키는 심링크
    (root / "link-in").symlink_to(root / "profiles")               # 폴더 안을 가리키는 심링크
    return root


class OpsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = make_root(Path(self.tmp.name))
        self.ops = ops.Ops(self.root, max_file=4000, max_total=6000, max_entries=50, max_rows=5, sql_seconds=5)

    def test_stat_and_list_report_the_permission_bits(self):
        script = self.root / "run.sh"
        script.write_text("#!/bin/sh\n")
        script.chmod(0o755)
        self.assertEqual(self.ops.stat("run.sh")["mode"] & 0o777, 0o755)
        listed = {e["path"]: e for e in self.ops.glob("", "*.sh")["entries"]}
        self.assertEqual(listed["run.sh"]["mode"] & 0o111, 0o111)
        self.assertEqual(self.ops.stat("config.yaml")["mode"] & 0o111, 0)

    def test_stat_file_dir_missing(self):
        self.assertEqual(self.ops.stat("config.yaml")["type"], "file")
        self.assertGreater(self.ops.stat("config.yaml")["size"], 0)
        self.assertEqual(self.ops.stat("profiles")["type"], "dir")
        self.assertEqual(self.ops.stat("nope"), {"exists": False})
        self.assertEqual(self.ops.stat("")["type"], "dir")           # 루트

    def test_path_escape_is_refused(self):
        for bad in ("../outside/secret.txt", "profiles/../../outside", "/etc/passwd", "a\x00b", "link-out/secret.txt"):
            with self.subTest(path=bad):
                if bad.startswith("link-out"):
                    self.assertEqual(self.ops.stat(bad), {"exists": False})
                    r = self.ops.read([bad])["files"][0]
                    self.assertFalse(r["ok"])
                    self.assertNotIn("SHOULD_NOT", json.dumps(r))
                else:
                    with self.assertRaises(ops.OpError) as cm:
                        self.ops.stat(bad)
                    self.assertEqual(cm.exception.code, 400)

    def test_symlink_inside_root_is_followed(self):
        self.assertEqual(self.ops.stat("link-in/ma/config.yaml")["type"], "file")

    def test_read_many_with_per_file_errors(self):
        out = self.ops.read(["config.yaml", "nope", "profiles", "big.txt"])["files"]
        self.assertTrue(out[0]["ok"])
        self.assertEqual(base64.b64decode(out[0]["data_b64"]).decode(), "model:\n  default: m\n")
        self.assertEqual((out[1]["ok"], out[1]["error"]), (False, "missing"))
        self.assertEqual((out[2]["ok"], out[2]["error"]), (False, "not_file"))
        self.assertEqual((out[3]["ok"], out[3]["error"]), (False, "too_large"))     # max_file=4000 < 5000

    def test_read_binary_roundtrip_and_total_cap(self):
        out = self.ops.read(["binary.bin"])["files"][0]
        self.assertEqual(base64.b64decode(out["data_b64"]), bytes(range(256)))
        many = self.ops.read(["binary.bin"] * 40)["files"]            # 256B * 40 > max_total 6000 이 되기 전에 끊는다
        self.assertEqual(sum(1 for f in many if f["ok"]), 23)
        self.assertEqual(many[-1]["error"], "total_cap")

    def test_list_glob_and_recursive(self):
        top = {e["path"]: e for e in self.ops.glob("", "*")["entries"]}
        self.assertEqual(top["profiles"]["type"], "dir")
        self.assertEqual(top["config.yaml"]["type"], "file")
        self.assertNotIn("link-out", top)                                # 밖을 가리키는 항목은 목록에서 뺀다
        rec = {e["path"] for e in self.ops.glob("", "**/*.yaml")["entries"]}
        self.assertEqual(rec, {"config.yaml", "profiles/ma/config.yaml"})      # ** 는 심링크 폴더로 내려가지 않는다(파이썬 기본)
        sub = {e["path"] for e in self.ops.glob("profiles", "*")["entries"]}
        self.assertEqual(sub, {"profiles/ma"})

    def test_glob_rejects_bad_patterns_and_caps_entries(self):
        for bad in ("../*", "/etc/*", "a/../../*"):
            with self.assertRaises(ops.OpError):
                self.ops.glob("", bad)
        for i in range(60):
            (self.root / f"f{i}.txt").write_text("x")
        out = self.ops.glob("", "f*.txt")
        self.assertTrue(out["truncated"])
        self.assertEqual(len(out["entries"]), 50)

    def test_sqlite_select_and_pragma_table_info(self):
        out = self.ops.sqlite("state.db", "SELECT id, n FROM sessions WHERE source = ? ORDER BY n", ["cli"])
        self.assertEqual(out["columns"], ["id", "n"])
        self.assertEqual(out["rows"][0], ["s1", 1])
        info = self.ops.sqlite("state.db", "PRAGMA table_info(sessions)", [])
        self.assertIn("source", [r[1] for r in info["rows"]])

    def test_sqlite_truncates_rows_and_encodes_blob(self):
        out = self.ops.sqlite("state.db", "SELECT id, blob FROM sessions", [])
        self.assertTrue(out["truncated"])
        self.assertEqual(len(out["rows"]), 5)
        self.assertEqual(out["rows"][0][1], {"$b64": base64.b64encode(b"\x00\x01").decode()})

    def test_sqlite_refuses_anything_but_reads(self):
        for sql in ("DELETE FROM sessions", "DROP TABLE sessions", "UPDATE sessions SET n=1",
                    "INSERT INTO sessions VALUES ('x','y',1,NULL)", "PRAGMA journal_mode=WAL",
                    "ATTACH DATABASE '/etc/passwd' AS p", "SELECT 1; SELECT 2", "VACUUM",
                    "SELECT load_extension('x')", "PRAGMA writable_schema=1"):
            with self.subTest(sql=sql), self.assertRaises(ops.OpError) as cm:
                self.ops.sqlite("state.db", sql, [])
            self.assertEqual(cm.exception.code, 400)
        n = self.ops.sqlite("state.db", "SELECT COUNT(*) FROM sessions", [])["rows"][0][0]
        self.assertEqual(n, 10)                                          # 어느 것도 DB 를 바꾸지 못했다

    def test_sqlite_missing_db_and_outside(self):
        with self.assertRaises(ops.OpError) as cm:
            self.ops.sqlite("nope.db", "SELECT 1", [])
        self.assertEqual(cm.exception.code, 404)
        with self.assertRaises(ops.OpError):
            self.ops.sqlite("../outside/x.db", "SELECT 1", [])

    def test_sqlite_path_with_special_characters(self):
        odd = self.root / "a b#c?d.db"
        conn = sqlite3.connect(odd)
        conn.execute("CREATE TABLE t (x)")
        conn.execute("INSERT INTO t VALUES (7)")
        conn.commit()
        conn.close()
        self.assertEqual(self.ops.sqlite("a b#c?d.db", "SELECT x FROM t", [])["rows"], [[7]])

    def test_sqlite_time_limit(self):
        slow = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT COUNT(*) FROM c"
        quick = ops.Ops(self.root, sql_seconds=0.3)
        with self.assertRaises(ops.OpError) as cm:
            quick.sqlite("state.db", slow, [])
        self.assertEqual(cm.exception.code, 408)

    def test_version(self):
        v = self.ops.version()
        self.assertEqual(v["api"], 1)
        self.assertTrue(v["root_ok"])


class HttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.root = make_root(Path(cls.tmp.name))
        cls.httpd = server.make_server("127.0.0.1", 0, ops.Ops(cls.root), TOKEN)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.port = cls.httpd.server_port

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.tmp.cleanup()

    def call(self, method, path, body=None, token=TOKEN, raw=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        headers = {"Content-Type": "application/json"}
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        c.request(method, path, body=data, headers=headers)
        r = c.getresponse()
        out = r.read()
        c.close()
        return r.status, (json.loads(out) if out else {})

    def test_every_endpoint_requires_the_token(self):
        for method, path in (("GET", "/v1/version"), ("POST", "/v1/stat"), ("POST", "/v1/read"),
                             ("POST", "/v1/list"), ("POST", "/v1/sqlite")):
            for token in (None, "wrong", TOKEN + "x", ""):
                with self.subTest(path=path, token=token):
                    code, body = self.call(method, path, {"path": "config.yaml"}, token=token)
                    self.assertEqual(code, 401)
                    self.assertNotIn("api", body)

    def test_version_stat_read_list_sqlite_over_http(self):
        self.assertEqual(self.call("GET", "/v1/version")[1]["api"], 1)
        self.assertEqual(self.call("POST", "/v1/stat", {"path": "config.yaml"})[1]["type"], "file")
        self.assertTrue(self.call("POST", "/v1/read", {"paths": ["config.yaml"]})[1]["files"][0]["ok"])
        self.assertIn("config.yaml", [e["path"] for e in self.call("POST", "/v1/list", {"path": "", "pattern": "*"})[1]["entries"]])
        self.assertEqual(self.call("POST", "/v1/sqlite", {"path": "state.db", "sql": "SELECT COUNT(*) FROM sessions", "params": []})[1]["rows"], [[10]])

    def test_bad_requests_get_4xx_without_host_paths(self):
        code, body = self.call("POST", "/v1/stat", {"path": "../x"})
        self.assertEqual(code, 400)
        self.assertNotIn(str(self.root), json.dumps(body))
        self.assertEqual(self.call("POST", "/v1/stat", raw=b"{not json")[0], 400)
        self.assertEqual(self.call("POST", "/v1/stat", {"nope": 1})[0], 400)
        self.assertEqual(self.call("POST", "/v1/unknown", {})[0], 404)
        self.assertEqual(self.call("GET", "/v1/stat")[0], 405)

    def test_oversized_body_is_refused_without_reading_it(self):
        """공격자가 정한 크기만큼 읽어 비우지 않는다. 헤더만 보고 413 으로 끊는다."""
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.putrequest("POST", "/v1/stat")
        c.putheader("Authorization", f"Bearer {TOKEN}")
        c.putheader("Content-Type", "application/json")
        c.putheader("Content-Length", str(server.MAX_BODY + 1))
        c.endheaders()
        r = c.getresponse()
        self.assertEqual(r.status, 413)
        r.read()
        c.close()

    def test_rejected_request_cannot_smuggle_a_second_request_in_its_body(self):
        """401·404·405 로 거절하면서 본문을 읽지 않으면, 남은 바이트가 다음 요청으로 해석된다. 연결을 닫아야 한다."""
        import socket
        smuggled = (f"GET /v1/version HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {TOKEN}\r\n\r\n").encode()
        for method, path, token in (("POST", "/v1/stat", None), ("POST", "/v1/stat", "wrong"), ("PUT", "/v1/stat", TOKEN),
                                    ("POST", "/v1/nope", TOKEN), ("DELETE", "/v1/stat", TOKEN)):
            with self.subTest(method=method, path=path, token=token):
                auth = f"Authorization: Bearer {token}\r\n" if token else ""
                req = (f"{method} {path} HTTP/1.1\r\nHost: x\r\n{auth}Content-Length: {len(smuggled)}\r\n\r\n").encode() + smuggled
                with socket.create_connection(("127.0.0.1", self.port), timeout=5) as sock:
                    sock.sendall(req)
                    sock.shutdown(socket.SHUT_WR)
                    data = b""
                    while chunk := sock.recv(65536):
                        data += chunk
                self.assertEqual(data.count(b"HTTP/1.1 "), 1, data)            # 응답은 하나뿐이다(숨긴 GET 에는 답하지 않는다)
                self.assertNotIn(b'"api"', data)                                  # version 정보가 새지 않는다
                self.assertIn(b"Connection: close", data)

    def test_write_methods_are_not_offered(self):
        for method in ("PUT", "DELETE", "PATCH"):
            self.assertEqual(self.call(method, "/v1/stat", {"path": "x"})[0], 405)


if __name__ == "__main__":
    unittest.main()


class StalledReaderTest(unittest.TestCase):
    """응답을 받지 않는 연결이 무거운 읽기 잠금을 쥔 채 멈추지 않는다(2026-10-23 OKE). AAS 서버 파드를 다시 띄우면 옛 파드가
    큰 응답을 받던 중에 사라진다. 끊김 신호가 오지 않아 사이드카의 보내기가 TCP 재전송 한도(15분 넘게)까지 멈췄고,
    그동안 그 작업공간의 모든 파일 읽기가 잠금 뒤에 줄을 서 10초 시간 초과로 실패했다(채팅 목록이 몇 분씩 걸림)."""

    def test_a_reader_that_stops_reading_does_not_block_other_reads(self):
        import socket
        import time
        with tempfile.TemporaryDirectory() as tmp:
            root = make_root(Path(tmp))
            (root / "huge.bin").write_bytes(os.urandom(12_000_000))      # base64·JSON 으로 16MB 넘음 — 소켓 버퍼를 채운다
            old = server.SEND_TIMEOUT
            server.SEND_TIMEOUT = 1.0
            try:
                httpd = server.make_server("127.0.0.1", 0, ops.Ops(root, max_file=20_000_000, max_total=20_000_000), TOKEN)
            finally:
                server.SEND_TIMEOUT = old
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            stalled = socket.socket()
            try:
                stalled.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
                stalled.connect(("127.0.0.1", httpd.server_port))
                body = json.dumps({"paths": ["huge.bin"]}).encode()
                stalled.sendall(b"POST /v1/read HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n"
                                + f"Authorization: Bearer {TOKEN}\r\nContent-Length: {len(body)}\r\n\r\n".encode() + body)
                time.sleep(0.5)                                              # 잠금을 쥐고 보내다 멈출 때까지
                c = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=8)
                start = time.monotonic()
                c.request("POST", "/v1/read", body=json.dumps({"paths": ["config.yaml"]}).encode(),
                          headers={"Content-Type": "application/json", "Authorization": f"Bearer {TOKEN}"})
                r = c.getresponse()
                r.read()
                c.close()
                self.assertEqual(r.status, 200)
                self.assertLess(time.monotonic() - start, 5)
            finally:
                stalled.close()
                httpd.shutdown()
                httpd.server_close()


class GoneClientSkippedTest(unittest.TestCase):
    """잠금을 기다리는 동안 끊고 나간 요청은 하지 않는다(2026-10-23 OKE). 막힌 사이드카에 끊긴 요청이 478개 쌓여 있었다 —
    잠금이 풀리면 받을 상대가 없는 tree·read 를 하나씩 다시 해 막힘이 길어진다."""

    def test_a_request_whose_client_left_while_waiting_is_not_run(self):
        import socket
        import time
        calls = []

        class Slow(ops.Ops):
            def read(self, paths):
                calls.append(list(paths))
                if len(calls) == 1:
                    time.sleep(1.0)                                       # 잠금을 쥔다
                return super().read(paths)

        with tempfile.TemporaryDirectory() as tmp:
            root = make_root(Path(tmp))
            # 작은 read 는 잠금 밖이다(스펙 2026-10-24-002 검토 D6) — 잠금을 기다리는 큰 read(256KB 초과)로 본다
            (root / "large.txt").write_text("a" * 300_000, encoding="utf-8")
            (root / "large2.txt").write_text("b" * 300_000, encoding="utf-8")
            httpd = server.make_server("127.0.0.1", 0, Slow(root, max_file=1_000_000, max_total=2_000_000), TOKEN)
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            try:
                def raw(paths):
                    s = socket.create_connection(("127.0.0.1", httpd.server_port))
                    body = json.dumps({"paths": paths}).encode()
                    s.sendall(b"POST /v1/read HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n"
                              + f"Authorization: Bearer {TOKEN}\r\nContent-Length: {len(body)}\r\n\r\n".encode() + body)
                    return s
                holder = raw(["large.txt"])
                time.sleep(0.2)
                raw(["large2.txt"]).close()                                   # 기다리다 끊고 나간다
                time.sleep(0.2)
                holder.settimeout(3)
                got = b""
                while b"\r\n\r\n" not in got:                                 # 큰 응답을 끝까지 받는다(Content-Length 만큼)
                    got += holder.recv(1 << 16)
                head, rest = got.split(b"\r\n\r\n", 1)
                length = int(next(l.split(b":")[1] for l in head.split(b"\r\n") if l.lower().startswith(b"content-length")))
                while len(rest) < length:
                    rest += holder.recv(1 << 20)
                time.sleep(1.2)                                                # 잠금이 풀리고 끊긴 요청 차례가 지나도록
                holder.close()
                self.assertEqual(calls, [["large.txt"]])
            finally:
                httpd.shutdown()
                httpd.server_close()


class SmallReadOutsideHeavyLockTest(unittest.TestCase):
    """작은 read 는 큰 연산 잠금 뒤에 줄 서지 않는다(스펙 2026-10-24-002 R20·검토 D6). 설정 파일 하나 읽기도 큰 tree 뒤에서
    기다려 AAS 쪽 10초 한도를 넘기면, 멀쩡한 사이드카가 「응답 없음」으로 기억됐다."""

    def test_tree_가_도는_동안_작은_read_는_바로_답하고_큰_read_는_기다린다(self):
        import time

        class SlowTree(ops.Ops):
            def tree(self, *a, **kw):
                time.sleep(1.5)
                return super().tree(*a, **kw)

        with tempfile.TemporaryDirectory() as tmp:
            root = make_root(Path(tmp))
            (root / "large.txt").write_text("a" * 300_000, encoding="utf-8")   # 256KB 를 넘는다
            httpd = server.make_server("127.0.0.1", 0, SlowTree(root, max_file=1_000_000, max_total=2_000_000), TOKEN)
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            try:
                def call(path, body):
                    c = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=10)
                    began = time.monotonic()
                    c.request("POST", path, body=json.dumps(body).encode(),
                              headers={"Content-Type": "application/json", "Authorization": f"Bearer {TOKEN}"})
                    r = c.getresponse()
                    r.read()
                    c.close()
                    return r.status, time.monotonic() - began
                tree = threading.Thread(target=call, args=("/v1/tree", {"path": ""}), daemon=True)
                tree.start()
                time.sleep(0.2)                                  # tree 가 잠금을 잡을 때까지
                status, took = call("/v1/read", {"paths": ["config.yaml"]})
                self.assertEqual(status, 200)
                self.assertLess(took, 0.5)
                status, took = call("/v1/read", {"paths": ["large.txt"]})
                self.assertEqual(status, 200)
                self.assertGreater(took, 0.8)                    # 큰 read 는 지금처럼 tree 뒤에 기다린다(메모리 보호)
                tree.join(5)
            finally:
                httpd.shutdown()
                httpd.server_close()


class HeavyOpsOneAtATimeTest(unittest.TestCase):
    """tree·read 는 한 번에 하나만 돈다(2026-10-14). tree 한 번이 30MB 넘게 써서, 서버가 동시에 여러 번 부르면 128Mi 사이드카가
    OOMKilled 됐다. 응답을 JSON 으로 만드는 동안까지 막아야 한다 — 복사가 가장 많이 일어나는 곳이 거기다."""

    def test_concurrent_tree_and_read_do_not_overlap(self):
        import time
        state = {"now": 0, "max": 0}
        guard = threading.Lock()

        class Slow(ops.Ops):
            def _enter(self):
                with guard:
                    state["now"] += 1
                    state["max"] = max(state["max"], state["now"])
                time.sleep(0.15)
                with guard:
                    state["now"] -= 1

            def tree(self, *a, **kw):
                self._enter()
                return super().tree(*a, **kw)

            def read(self, *a, **kw):
                self._enter()
                return super().read(*a, **kw)

        with tempfile.TemporaryDirectory() as tmp:
            root = make_root(Path(tmp))
            # 작은 read(256KB 이하)는 잠금 밖이다(스펙 2026-10-24-002 검토 D6) — 큰 read 로 큰 연산끼리 겹치지 않는지 본다
            (root / "large.txt").write_text("a" * 300_000, encoding="utf-8")
            httpd = server.make_server("127.0.0.1", 0, Slow(root, max_file=1_000_000, max_total=2_000_000), TOKEN)
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            try:
                def call(path, body):
                    c = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=10)
                    c.request("POST", path, body=json.dumps(body).encode(),
                              headers={"Content-Type": "application/json", "Authorization": f"Bearer {TOKEN}"})
                    r = c.getresponse()
                    r.read()
                    c.close()
                    return r.status
                results = []
                jobs = [threading.Thread(target=lambda p=p, b=b: results.append(call(p, b)))
                        for p, b in [("/v1/tree", {"path": ""}), ("/v1/tree", {"path": ""}), ("/v1/read", {"paths": ["large.txt"]})]]
                for j in jobs:
                    j.start()
                for j in jobs:
                    j.join()
                self.assertEqual(sorted(results), [200, 200, 200])
                self.assertEqual(state["max"], 1)
            finally:
                httpd.shutdown()
                httpd.server_close()
