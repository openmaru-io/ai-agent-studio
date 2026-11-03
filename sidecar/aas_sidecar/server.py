# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""읽기 사이드카 HTTP — 모든 경로에 토큰이 필요하다(version 포함). 쓰는 메서드는 없다."""
from __future__ import annotations

import contextlib
import hmac
import json
import os
import socket
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .ops import OpError, Ops

MAX_BODY = 1_000_000
_POST = {"/v1/stat", "/v1/read", "/v1/list", "/v1/tree", "/v1/changes", "/v1/sqlite", "/v1/sqlite_batch", "/v1/scan", "/v1/check"}
CHUNK = 64 * 1024
# 내용을 담는 큰 연산은 한 번에 하나만(2026-10-14). tree 한 번이 30MB 넘게 쓴다(내용 8MB 를 base64·JSON·bytes 로 복사).
# 서버가 캐시를 한꺼번에 다시 만들며 여러 번 동시에 부르면 메모리 한도를 넘어 OOMKilled 됐다. 응답을 만드는 동안까지 막는다.
_HEAVY = {"/v1/tree", "/v1/read"}
# 이 크기(바이트) 이하의 read 는 잠금 밖에서 처리한다 — 설정·상태 파일 하나 읽기가 큰 tree 뒤에 줄 서지 않게
# (스펙 2026-10-24-002 R20·검토 D6). 메모리를 많이 쓰는 큰 read 와 tree 는 그대로 하나씩이다
SMALL_READ = 256 * 1024
# 연결마다 한 번의 읽기·보내기가 이보다 오래 멈추면 그 연결을 끊는다(2026-10-23 OKE). 받던 AAS 서버 파드가 다시 시작되며 사라지면
# 끊김 신호가 오지 않아 보내기가 TCP 재전송 한도(15분 넘게)까지 멈췄고, 위 잠금을 쥔 채라 그 작업공간의 파일 읽기가 모두 막혔다.
# 서버는 30초(IDLE_REUSE)보다 오래 쉰 연결을 다시 쓰지 않으므로 쉬는 연결도 이 시간에 닫아도 된다. 큰 tree 응답(30MB)도 안에서 끝난다
SEND_TIMEOUT = 60.0


def make_server(host: str, port: int, ops: Ops, token: str) -> ThreadingHTTPServer:
    if len(token) < 16:
        raise ValueError("토큰은 16자 이상이어야 합니다")
    want = token.encode()
    heavy = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        server_version = "aas-sidecar"
        protocol_version = "HTTP/1.1"
        timeout = SEND_TIMEOUT                       # 소켓 시간 한도. 넘으면 그 요청만 끝나고 잠금이 풀린다
        # 머리와 본문을 두 번에 보낸다. Nagle 이 켜져 있으면 연결을 다시 쓸 때 본문이 머리의 ACK(지연 ACK 40ms)를 기다린다(OMAI-1102)
        disable_nagle_algorithm = True

        def log_message(self, fmt, *args):          # 경로·토큰이 로그에 남지 않게 한다
            pass

        _body_consumed = False

        def _has_unread_body(self) -> bool:
            if self._body_consumed:
                return False
            length = self.headers.get("Content-Length", "")
            return (length.isdigit() and int(length) > 0) or bool(self.headers.get("Transfer-Encoding"))

        def _send(self, code: int, obj: dict):
            body = json.dumps(obj, ensure_ascii=False).encode()
            # 요청 본문을 읽지 않고 답하면 남은 바이트가 다음 요청 줄로 해석된다(요청 밀수).
            # 그런 연결과 모든 오류 응답 뒤에는 연결을 닫는다.
            if code >= 400 or self._has_unread_body():
                self.close_connection = True
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            if self.close_connection:
                self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)

        def _authed(self) -> bool:
            header = self.headers.get("Authorization", "")
            got = header[7:].encode() if header.startswith("Bearer ") else b""
            return bool(got) and hmac.compare_digest(got, want)

        def do_GET(self):  # noqa: N802
            if not self._authed():
                self._send(401, {"error": "토큰이 필요합니다"})
                return
            if self.path == "/v1/version":
                self._send(200, ops.version())
            elif self.path.startswith("/v1/download?"):
                self._download()
            elif self.path in _POST:
                self._send(405, {"error": "POST 로 부르세요"})
            else:
                self._send(404, {"error": "없는 경로입니다"})

        def do_POST(self):  # noqa: N802
            if not self._authed():
                self._send(401, {"error": "토큰이 필요합니다"})
                return
            if self.path not in _POST:
                self._send(404 if self.path != "/v1/version" else 405, {"error": "없는 경로입니다"})
                return
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = -1
            if length < 0 or length > MAX_BODY:
                self.close_connection = True
                self._send(413, {"error": "요청이 너무 큽니다"})
                return
            try:
                raw = self.rfile.read(length)
                self._body_consumed = True
                body = json.loads(raw or b"{}")
                if not isinstance(body, dict):
                    raise ValueError
            except ValueError:
                self._send(400, {"error": "JSON 객체가 아닙니다"})
                return
            try:
                held = self._needs_heavy(body)
                with heavy if held else contextlib.nullcontext():
                    if held and self._peer_gone():
                        self.close_connection = True     # 잠금을 기다리는 동안 끊고 나갔다 — 받을 상대가 없는 일을 하지 않는다
                        return
                    self._send(200, self._run(body))
            except OpError as exc:
                self._send(exc.code, {"error": exc.message})
            except KeyError:
                self._send(400, {"error": "필요한 필드가 없습니다"})

        def _needs_heavy(self, body: dict) -> bool:
            if self.path == "/v1/read":
                return ops.read_size(body.get("paths")) > SMALL_READ
            return self.path in _HEAVY

        def _peer_gone(self) -> bool:
            """상대가 연결을 닫았는가(끊김 신호를 받았다). 기다리지 않고 들여다보기만 한다."""
            try:
                self.connection.settimeout(0)
                return self.connection.recv(1, socket.MSG_PEEK) == b""
            except (BlockingIOError, InterruptedError):
                return False
            except OSError:
                return True
            finally:
                self.connection.settimeout(self.timeout)

        def _download(self):
            """대화 파일 내려받기(OMAI-1153). 연 파일 기준으로 검사하고 흘려보낸다. 큰 파일 동안 tree 가 멈추지 않게
            heavy 잠금을 잡지 않는다(메모리는 조각 하나만 쓴다)."""
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            rel = (query.get("path") or [""])[0]
            try:
                fd, size, name = ops.open_download(rel)
            except OpError as exc:
                self._send(exc.code, {"error": exc.message})
                return
            try:
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(size))
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("X-File-Name", urllib.parse.quote(name))
                self.end_headers()
                if self.command == "HEAD":
                    return
                left = size
                while left > 0:
                    chunk = os.read(fd, min(CHUNK, left))
                    if not chunk:
                        break                       # 읽는 사이에 파일이 줄었다 — 받는 쪽이 길이가 모자란 것을 안다
                    self.wfile.write(chunk)
                    left -= len(chunk)
                if left:
                    self.close_connection = True
            finally:
                os.close(fd)

        def do_HEAD(self):  # noqa: N802
            if not self._authed() or not self.path.startswith("/v1/download?"):
                self.close_connection = True
                self.send_response(401 if not self._authed() else 404)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self._download()

        def _run(self, body: dict) -> dict:
            op = self.path.rsplit("/", 1)[1]
            if op == "stat":
                return ops.stat(body["path"])
            if op == "read":
                return ops.read(body["paths"])
            if op == "list":
                return ops.glob(body.get("path", ""), body.get("pattern", "*"), skip_dirs=body.get("skip_dirs"))
            if op == "tree":
                return ops.tree(body.get("path", ""), skip_dirs=body.get("skip_dirs"), no_content=body.get("no_content"),
                                max_file=body.get("max_file", 262_144), max_total=body.get("max_total"),
                                if_fingerprint=str(body.get("if_fingerprint") or ""), hashes=body.get("hashes"),
                                cursor=bool(body.get("cursor")))
            if op == "changes":
                return ops.changes(str(body.get("since") or ""), body.get("path", ""), skip_dirs=body.get("skip_dirs"),
                                   max_file=body.get("max_file", 262_144), hashes=body.get("hashes"), fresh=body.get("fresh"))
            if op == "scan":
                return ops.scan(body.get("path", ""), skip_dirs=body.get("skip_dirs"))
            if op == "check":
                return ops.check(body["path"])
            if op == "sqlite_batch":
                return ops.sqlite_batch(body["queries"])
            return ops.sqlite(body["path"], body["sql"], body.get("params", []))

        def _method_not_allowed(self):
            if not self._authed():
                self._send(401, {"error": "토큰이 필요합니다"})
            else:
                self._send(405, {"error": "읽기 전용입니다"})

        do_PUT = do_DELETE = do_PATCH = _method_not_allowed  # noqa: N815

    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.daemon_threads = True
    return httpd
