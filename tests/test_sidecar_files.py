# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""읽기 사이드카 1.4.0 의 대화 파일 연산(OMAI-1153) — scan·check·download 가 심링크·하드링크로 대화 DB 를 내주지 않는다."""
import http.client
import json
import os
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
    ws = root / "workspace"
    (ws / "outputs").mkdir(parents=True)
    (ws / "node_modules" / "pkg").mkdir(parents=True)
    (root / "state.db").write_bytes(b"SQLITE-CHAT-HISTORY")
    (ws / "outputs" / "report.txt").write_bytes(b"hello report")
    (ws / "node_modules" / "pkg" / "index.js").write_bytes(b"x" * 100)
    (ws / "outputs" / "db-link").symlink_to(root / "state.db")        # 파일 심링크 → 대화 DB
    (ws / "dir-link").symlink_to(root)                                 # 폴더 심링크 → 데이터 폴더 맨 위
    os.link(root / "state.db", ws / "outputs" / "db-hard")             # 하드링크 → 대화 DB
    return root


class FileOpsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = make_root(Path(self.tmp.name))
        self.ops = ops.Ops(self.root, max_entries=50)

    def test_open_download_reads_a_plain_file(self):
        fd, size, name = self.ops.open_download("workspace/outputs/report.txt")
        try:
            self.assertEqual((size, name, os.read(fd, 100)), (12, "report.txt", b"hello report"))
        finally:
            os.close(fd)

    def test_open_download_refuses_symlink_hardlink_and_folder_link(self):
        for rel, why in (("workspace/outputs/db-link", "link"), ("workspace/outputs/db-hard", "hardlink"),
                         ("workspace/dir-link/state.db", "link"), ("workspace/outputs", "not_file")):
            with self.subTest(rel=rel), self.assertRaises(ops.OpError) as cm:
                fd, _size, _name = self.ops.open_download(rel)
                os.close(fd)
            self.assertEqual(cm.exception.message, why)

    def test_open_download_refuses_path_tricks_and_missing(self):
        for rel in ("../state.db", "/etc/passwd", "workspace/../state.db"):
            with self.subTest(rel=rel), self.assertRaises(ops.OpError):
                self.ops.open_download(rel)
        with self.assertRaises(ops.OpError) as cm:
            self.ops.open_download("workspace/none.txt")
        self.assertEqual((cm.exception.code, cm.exception.message), (404, "missing"))

    def test_check_reports_link_type_size_and_link_count(self):
        self.assertEqual(self.ops.check("workspace/none")["exists"], False)
        self.assertEqual(self.ops.check("workspace/outputs/db-link"), {"exists": True, "link": True})
        self.assertEqual(self.ops.check("workspace/dir-link/state.db"), {"exists": True, "link": True})
        plain = self.ops.check("workspace/outputs/report.txt")
        self.assertEqual((plain["type"], plain["size"], plain["nlink"], plain["link"]), ("file", 12, 1, False))
        self.assertEqual(self.ops.check("workspace/outputs/db-hard")["nlink"], 2)

    def test_scan_uses_lstat_skips_dirs_and_sums_only_regular_files(self):
        out = self.ops.scan("workspace", skip_dirs=["node_modules"])
        kinds = {e["path"]: e["type"] for e in out["entries"]}
        self.assertEqual(kinds["workspace/outputs/db-link"], "link")
        self.assertEqual(kinds["workspace/dir-link"], "link")
        self.assertIn("workspace/node_modules", kinds)
        self.assertNotIn("workspace/node_modules/pkg/index.js", kinds)      # 들어가지 않았다
        # 일반 파일만 합한다: report(12) + 하드링크(19) — 심링크 대상(state.db)은 더하지 않는다
        self.assertEqual(out["total"], 12 + len(b"SQLITE-CHAT-HISTORY"))
        self.assertFalse(out["truncated"])

    def test_scan_truncates_and_missing_folder(self):
        small = ops.Ops(self.root, max_entries=2)
        self.assertTrue(small.scan("workspace")["truncated"])
        self.assertTrue(self.ops.scan("nope").get("missing"))


class DownloadHttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.root = make_root(Path(cls.tmp.name))
        cls.httpd = server.make_server("127.0.0.1", 0, ops.Ops(cls.root), TOKEN)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.port = cls.httpd.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.tmp.cleanup()

    def _req(self, method, path, body=None, token=TOKEN):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        data = json.dumps(body).encode() if body is not None else None
        if data is not None:
            headers["Content-Type"] = "application/json"
        conn.request(method, path, body=data, headers=headers)
        resp = conn.getresponse()
        raw = resp.read()
        conn.close()
        return resp, raw

    def test_download_streams_the_file_with_length_and_name(self):
        resp, raw = self._req("GET", "/v1/download?path=workspace/outputs/report.txt")
        self.assertEqual((resp.status, raw), (200, b"hello report"))
        self.assertEqual(resp.getheader("Content-Length"), "12")
        self.assertEqual(resp.getheader("X-File-Name"), "report.txt")

    def test_head_checks_without_body(self):
        resp, raw = self._req("HEAD", "/v1/download?path=workspace/outputs/report.txt")
        self.assertEqual((resp.status, raw), (200, b""))
        resp, _ = self._req("HEAD", "/v1/download?path=workspace/outputs/db-link")
        self.assertEqual(resp.status, 403)

    def test_download_refuses_links_and_needs_the_token(self):
        for rel, code in (("workspace/outputs/db-link", 403), ("workspace/outputs/db-hard", 403), ("workspace/none", 404)):
            resp, raw = self._req("GET", f"/v1/download?path={rel}")
            self.assertEqual(resp.status, code, rel)
            self.assertNotIn(b"SQLITE-CHAT-HISTORY", raw)
        resp, _ = self._req("GET", "/v1/download?path=workspace/outputs/report.txt", token="")
        self.assertEqual(resp.status, 401)

    def test_scan_and_check_over_http(self):
        resp, raw = self._req("POST", "/v1/scan", {"path": "workspace", "skip_dirs": ["node_modules"]})
        self.assertEqual(resp.status, 200)
        self.assertIn("total", json.loads(raw))
        resp, raw = self._req("POST", "/v1/check", {"path": "workspace/outputs/report.txt"})
        self.assertEqual(json.loads(raw)["nlink"], 1)
        resp, raw = self._req("GET", "/v1/version")
        self.assertIn("download", json.loads(raw)["ops"])


if __name__ == "__main__":
    unittest.main()
