# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""정적 파일 제공 시험 — 허용한 확장자만, web 폴더 밖으로는 못 나간다."""
import aasserver  # 실제 uvicorn 앱을 띄우는 시험 하네스(OMAI-1100)
import http.client
import os
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.web import server  # noqa: E402


class StaticTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.old = {k: os.environ.get(k) for k in ("AAS_OIDC_ISSUER", "AAS_OIDC_CLIENT_FILE", "AAS_USERS_FILE", "AAS_ALLOWED_HOSTS", "AAS_PODS_FILE")}
        for k in cls.old:
            os.environ.pop(k, None)
        os.environ["AAS_USERS_FILE"] = str(Path(TMP.name) / "no-users.json")
        os.environ["AAS_PODS_FILE"] = str(Path(TMP.name) / "no-pods.json")
        from aas.auth import auth
        from aas.fleet import pods
        home = Path(TMP.name) / "hermes"
        (home / "profiles").mkdir(parents=True, exist_ok=True)
        reg = Path(TMP.name) / "static-pods.json"
        reg.write_text('{"pods": [{"id": "t", "owner": "t@example.com", "hermes_home": "%s"}]}' % home)
        server._auth = auth.Auth({"issuer": "https://accounts.google.com", "client_id": "", "client_secret": "", "domain": "",
                                  "public_url": "http://localhost:17900", "hours": 1,
                                  "users_file": Path(TMP.name) / "no-users.json"})      # 로그인 꺼짐
        server._registry = pods.Registry(reg)
        cls.httpd = aasserver.start()
        cls.port = cls.httpd.server_port
        # 개발 장비에 React 빌드(aas/static)가 있어도 없어도 같은 결과가 나오게, 기본은 「빌드 없음」으로 고정한다.
        from unittest import mock
        cls.no_build = mock.patch.object(server, "STATIC_DIR", Path(TMP.name) / "no-build")
        cls.no_build.start()

    @classmethod
    def tearDownClass(cls):
        cls.no_build.stop()
        cls.httpd.shutdown()
        for k, v in cls.old.items():
            if v is not None:
                os.environ[k] = v
        server._auth = None
        server._registry = None

    def get(self, path, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("GET", path, headers=headers or {})
        r = c.getresponse()
        body = r.read()
        c.close()
        return r, body

    def test_healthz_answers_without_login_or_allowed_host(self):
        """쿠버네티스 프로브는 파드 IP 를 Host 로 보내고 쿠키가 없다. 허용 Host·로그인 검사보다 앞서 답한다."""
        os.environ["AAS_ALLOWED_HOSTS"] = "only.example.com"
        try:
            r, body = self.get("/healthz", {"Host": "10.244.1.7:17900"})
            self.assertEqual(r.status, 200)
            self.assertEqual(r.getheader("Cache-Control"), "no-store")
            self.assertEqual(r.getheader("X-Frame-Options"), "DENY")
            self.assertIn(b'"ok": true', body)
            r2, _ = self.get("/api/me", {"Host": "10.244.1.7:17900"})
            self.assertEqual(r2.status, 400)           # healthz 만 예외다. 다른 경로는 그대로 막힌다
        finally:
            os.environ.pop("AAS_ALLOWED_HOSTS", None)

    def test_readyz_는_로그인_없이_답하고_DB_상태를_따른다(self):
        """SQLite 면 항상 200. PostgreSQL 이면 DB 를 내렸을 때 503(트래픽만 끊고 재시작하지 않는다). Host 검사보다 앞서 답한다."""
        from unittest import mock
        os.environ["AAS_ALLOWED_HOSTS"] = "only.example.com"
        try:
            r, body = self.get("/readyz", {"Host": "10.244.1.7:17900"})
            self.assertEqual((r.status, b'"ok": true' in body), (200, True))
            with mock.patch("aas.common.db.ping", return_value=False):
                r2, body2 = self.get("/readyz", {"Host": "10.244.1.7:17900"})
            self.assertEqual((r2.status, b'"ok": false' in body2), (503, True))
            r3, _ = self.get("/healthz", {"Host": "10.244.1.7:17900"})
            self.assertEqual(r3.status, 200)           # /healthz 는 DB 와 무관하다
        finally:
            os.environ.pop("AAS_ALLOWED_HOSTS", None)

    # ---- React 빌드 산출물(aas/static) -----------------------------------------
    def with_build(self, files):
        """임시 빌드 폴더를 만들어 서버의 STATIC_DIR 로 바꿔 끼운다."""
        from unittest import mock
        root = Path(TMP.name) / f"build-{len(list(Path(TMP.name).iterdir()))}"
        for rel, data in files.items():
            (root / rel).parent.mkdir(parents=True, exist_ok=True)
            (root / rel).write_bytes(data if isinstance(data, bytes) else data.encode())
        patcher = mock.patch.object(server, "STATIC_DIR", root)
        patcher.start()
        self.addCleanup(patcher.stop)
        return root

    def test_root_serves_the_react_build_when_it_exists(self):
        self.with_build({"index.html": '<!doctype html><div id="root"></div>'})
        for path in ("/", "/index.html"):
            r, body = self.get(path)
            self.assertEqual(r.status, 200, path)
            self.assertIn(b'id="root"', body)
            self.assertEqual(r.getheader("Cache-Control"), "no-store")      # index.html 은 늘 새로 받는다(해시 이름 자산을 가리킨다)

    def test_root_without_a_build_says_how_to_build(self):
        from unittest import mock
        with mock.patch.object(server, "STATIC_DIR", Path(TMP.name) / "no-build-here"):
            r, body = self.get("/")
        self.assertEqual(r.status, 503)
        self.assertIn("npm run build".encode(), body)

    def test_legacy_ui_is_gone(self):
        """옛 화면(aas/web, /legacy/, /static/)은 지웠다(M1-10). 경로는 모두 404 다."""
        self.with_build({"index.html": '<div id="root"></div>'})
        for path in ("/legacy/", "/legacy", "/legacy/index.html", "/static/css/app.css", "/static/js/app.js"):
            self.assertEqual(self.get(path)[0].status, 404, path)
        self.assertFalse((Path(server.__file__).parent / "web").exists())

    def test_assets_are_served_with_long_cache_and_etag(self):
        self.with_build({"index.html": "x", "assets/index-abc123.js": "console.log(1)", "assets/index-abc123.css": "a{}",
                         "assets/font.woff2": b"wOF2"})
        r, body = self.get("/assets/index-abc123.js")
        self.assertEqual((r.status, body), (200, b"console.log(1)"))
        self.assertIn("javascript", r.getheader("Content-Type"))
        self.assertEqual(r.getheader("Cache-Control"), "public, max-age=31536000, immutable")
        self.assertEqual(self.get("/assets/index-abc123.css")[0].status, 200)
        self.assertEqual(self.get("/assets/font.woff2")[0].getheader("Content-Type"), "font/woff2")
        r2, body2 = self.get("/assets/index-abc123.js", {"If-None-Match": r.getheader("ETag")})
        self.assertEqual((r2.status, body2), (304, b""))

    def test_3D_모델과_글꼴도_내려준다(self):
        """오피스 장면의 가구(.glb)가 404 였다 — 시험용 가짜 서버는 확장자를 가리지 않아 놓쳤다."""
        self.with_build({"index.html": "x", "assets/desk-abc123.glb": b"glTF", "assets/NotoSansKR-abc.woff": b"wOFF"})
        r, body = self.get("/assets/desk-abc123.glb")
        self.assertEqual((r.status, body, r.getheader("Content-Type")), (200, b"glTF", "model/gltf-binary"))
        self.assertEqual(self.get("/assets/NotoSansKR-abc.woff")[0].getheader("Content-Type"), "font/woff")

    def test_오피스_배경음도_내려준다(self):
        """오피스 배경음(.mp3, 계획 007 P8)이 404 였다 — 위 .glb 와 같은 원인(확장자 목록에 없음)."""
        self.with_build({"index.html": "x", "assets/contemplation-abc.mp3": b"ID3"})
        r, body = self.get("/assets/contemplation-abc.mp3")
        self.assertEqual((r.status, body, r.getheader("Content-Type")), (200, b"ID3", "audio/mpeg"))

    def test_문서_뷰어의_작업_스레드_wasm_cmaps_글꼴을_내려준다(self):
        """pdf.js 작업 스레드(.mjs)·wasm·cmaps(.bcmap)·기본 글꼴(.pfb·.ttf)이 404 였다(스펙 2026-10-20-005 §5-3)."""
        self.with_build({"index.html": "x", "assets/pdf.worker.min-abc.mjs": "w", "assets/rhwp_bg-abc.wasm": b"\0asm",
                         "assets/pdfjs-6.3.289/cmaps/UniKS-UCS2-H.bcmap": b"bc", "assets/pdfjs-6.3.289/standard_fonts/FoxitSerif.pfb": b"pf",
                         "assets/pdfjs-6.3.289/standard_fonts/LiberationSans-Regular.ttf": b"tt"})
        for path, ctype, body in (("/assets/pdf.worker.min-abc.mjs", "text/javascript; charset=utf-8", b"w"),
                                  ("/assets/rhwp_bg-abc.wasm", "application/wasm", b"\0asm"),
                                  ("/assets/pdfjs-6.3.289/cmaps/UniKS-UCS2-H.bcmap", "application/octet-stream", b"bc"),
                                  ("/assets/pdfjs-6.3.289/standard_fonts/FoxitSerif.pfb", "application/octet-stream", b"pf"),
                                  ("/assets/pdfjs-6.3.289/standard_fonts/LiberationSans-Regular.ttf", "font/ttf", b"tt")):
            with self.subTest(path=path):
                r, got = self.get(path)
                self.assertEqual((r.status, got, r.getheader("Content-Type")), (200, body, ctype))
                self.assertEqual(r.getheader("Cache-Control"), "public, max-age=31536000, immutable")
                self.assertEqual(r.getheader("X-Content-Type-Options"), "nosniff")

    def test_큰_파일도_바이트가_같고_304_와_HEAD_가_된다(self):
        """/assets/ 는 Starlette FileResponse 로 나눠 보낸다(리뷰 D11). 옛 Handler 어댑터는 응답을 통째로 모았다."""
        blob = bytes(range(256)) * (3 * 4096 + 7)            # 약 3 MB — 나눠 보내는 크기보다 크다
        self.with_build({"index.html": "x", "assets/rhwp_bg-big.wasm": blob})
        r, body = self.get("/assets/rhwp_bg-big.wasm")
        self.assertEqual((r.status, len(body), body == blob), (200, len(blob), True))
        self.assertEqual(r.getheader("Content-Length"), str(len(blob)))
        r2, body2 = self.get("/assets/rhwp_bg-big.wasm", {"If-None-Match": r.getheader("ETag")})
        self.assertEqual((r2.status, body2), (304, b""))
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("HEAD", "/assets/rhwp_bg-big.wasm")
        h = c.getresponse()
        self.assertEqual((h.status, h.read(), h.getheader("Content-Length")), (200, b"", str(len(blob))))
        c.close()

    def test_미리_압축한_wasm_은_gzip_을_받는_요청에만_낸다(self):
        """§7 D7: rhwp_bg.wasm 을 .gz 로 미리 압축. 압축본·원본은 ETag 가 다르고 Vary 를 붙인다(OV2-M6). .gz 를 따로 받지는 못한다."""
        import gzip
        raw = b"\0asm" + bytes(range(256)) * 400
        self.with_build({"index.html": "x", "assets/rhwp_bg-abc.wasm": raw, "assets/rhwp_bg-abc.wasm.gz": gzip.compress(raw),
                         "assets/other-abc.js": "x", "assets/other-abc.js.gz": gzip.compress(b"y")})
        r, body = self.get("/assets/rhwp_bg-abc.wasm", {"Accept-Encoding": "gzip, deflate"})
        self.assertEqual((r.status, r.getheader("Content-Encoding"), r.getheader("Vary"), r.getheader("Content-Type")),
                         (200, "gzip", "Accept-Encoding", "application/wasm"))
        self.assertEqual(gzip.decompress(body), raw)
        r2, body2 = self.get("/assets/rhwp_bg-abc.wasm")
        self.assertEqual((r2.status, r2.getheader("Content-Encoding"), r2.getheader("Vary"), body2), (200, None, "Accept-Encoding", raw))
        self.assertNotEqual(r.getheader("ETag"), r2.getheader("ETag"))
        r3, _ = self.get("/assets/rhwp_bg-abc.wasm", {"Accept-Encoding": "gzip", "If-None-Match": r.getheader("ETag")})
        self.assertEqual(r3.status, 304)
        self.assertEqual(self.get("/assets/rhwp_bg-abc.wasm.gz")[0].status, 404)
        self.assertIsNone(self.get("/assets/other-abc.js", {"Accept-Encoding": "gzip"})[0].getheader("Content-Encoding"))   # wasm 만

    def test_assets_는_로그인이_필요하다(self):
        """옛 경로처럼 로그인이 켜져 있으면 세션 없이 받지 못한다(새 Starlette 경로가 규칙을 빠뜨리지 않는다)."""
        from unittest import mock
        self.with_build({"index.html": "x", "assets/ok.js": "ok"})
        fake = mock.Mock(enabled=True)
        fake.user.return_value = None
        with mock.patch.object(server, "auth", return_value=fake):
            r, body = self.get("/assets/ok.js")
        self.assertEqual((r.status, r.getheader("Location")), (302, "/auth/login"))
        self.assertNotIn(b"ok", body)

    def test_assets_block_traversal_dotfiles_unknown_types_and_listings(self):
        self.with_build({"index.html": "x", "secret.txt": "SECRET", ".hidden.js": "h", "assets/ok.js": "ok",
                         "assets/.dot.js": "d", "assets/notes.txt": "n", "assets/page.html": "<b>",
                         "assets/tool.exe": "MZ", "assets/index-abc.js.map": "{}"})
        for path in ("/assets/../index.html", "/assets/%2e%2e/secret.txt", "/assets/..%2fsecret.txt", "/assets/", "/assets",
                     "/assets/.dot.js", "/assets/notes.txt", "/assets/page.html", "/assets/nope.js", "/assets/ok.js%00.png",
                     "/assets//etc/passwd", "/assets/tool.exe", "/assets/index-abc.js.map"):
            with self.subTest(path=path):
                r, body = self.get(path)
                self.assertEqual(r.status, 404)
                self.assertNotIn(b"SECRET", body)

    def test_symlink_in_build_dir_cannot_escape(self):
        root = self.with_build({"index.html": "x", "assets/ok.js": "ok"})
        outside = Path(TMP.name) / "outside-secret.js"
        outside.write_text("SECRET")
        (root / "assets" / "link.js").symlink_to(outside)
        r, body = self.get("/assets/link.js")
        self.assertEqual(r.status, 404)
        self.assertNotIn(b"SECRET", body)

    def test_blocks_traversal_and_other_types(self):
        for path in ("/static/../server.py", "/static/%2e%2e/server.py", "/static/..%2f..%2fpyproject.toml",
                     "/static/css/../../__init__.py", "/static/index.html", "/static/js/", "/static/js/nope.js",
                     "/static//etc/passwd", "/static/css/app.css%00.png"):
            r, body = self.get(path)
            self.assertEqual(r.status, 404, path)
            self.assertNotIn(b"import", body)

    def test_built_page_has_no_inline_script(self):
        self.with_build({"index.html": '<!doctype html><div id="root"></div><script type="module" src="/assets/index-abc.js"></script>'})
        r, body = self.get("/")
        self.assertEqual(r.status, 200)
        self.assertIn(b"/assets/index-abc.js", body)
        self.assertNotIn(b"<script>", body)          # 인라인 스크립트 없음

if __name__ == "__main__":
    unittest.main()
