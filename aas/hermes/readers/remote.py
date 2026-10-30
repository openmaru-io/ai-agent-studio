# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""원격 읽기 백엔드 — 읽기 사이드카(연산 5개)를 pathlib.Path 와 sqlite3 처럼 쓰게 해 주는 얇은 층.

서버의 15개 넘는 읽기 모듈은 `home` 으로 Path 를 받는다. 쿠버네티스에서는 그 자리에 RemotePath 를 넣는다.
모듈 코드는 바뀌지 않는다: exists/is_file/is_dir/stat/read_text/read_bytes/iterdir/glob/rglob/resolve/relative_to 와
sqlite 의 execute/fetchone/fetchall/반복을 같은 모양으로 낸다. 도메인 규칙은 여기에 없다.
예외 하나: 자격증명 파일의 원문은 받는 자리에서 버린다(`secret_scrub`, 스펙 2026-10-19-015 A1).
"""
from __future__ import annotations

import base64
import fnmatch
import hashlib
import http.client
import json
import posixpath
import socket
import sqlite3
import threading
import time
import urllib.parse
import weakref
from pathlib import PurePosixPath
from types import SimpleNamespace
from typing import Callable
from ...common import netcache
from ...common.i18n import tr
from . import secret_scrub, tree_cache

STAT_TTL = 2.0              # 같은 경로를 연달아 묻는 왕복을 줄인다. 쓰기는 Hermes API 가 하므로 이 정도 지연은 허용한다.
TREE_TTL = 60.0             # 폴더 전체 묶음(tree)을 쓰는 시간. 여러 화면이 같은 묶음을 쓴다. AAS 가 고치면 _forget 이 곧바로 버린다(OMAI-1102)
# 묶음에서 안을 보지 않는 폴더(사이드카에 따로 묻는다)와 내용을 싣지 않는 파일. 실행 기록·로그·캐시·DB 는 수집이 파일째 읽지 않는다.
# workspace 는 대화 작업 폴더(사용자 파일, OMAI-1153) — 묶음 지문과 항목 상한을 흔들지 않게 들어가지 않는다
# .cache: 에이전트 도구가 홈(profiles/<이름>/home/.cache)에 쌓는 캐시. 한 OKE 에이전트에서 11,787개(176MB)라 묶음이 모두 훑으면 느려진다(OMAI-1175)
# home: 에이전트 홈($HOME = profiles/<이름>/home) 전체. 도구(npm·pip·playwright 등)가 캐시를 여기에 쌓아 이름을 하나씩 더해서는 따라가지 못한다.
#   OKE YJBot 의 home/.npm(2,769개)이 묶음을 10초 넘게 끌었고, 사이드카가 끊긴 요청까지 끝까지 처리하느라 작은 요청도 20초씩 밀렸다(2026-10-21).
#   홈 안에서 AAS 가 읽는 것(자산 목록의 home/.local·home/.venvs)은 건너뛴 폴더라 사이드카에 따로 묻는다
# mcp-tokens: MCP OAuth 토큰(리프레시 토큰 포함). 내용이 AAS 로 오지 않게 들어가지 않는다 — 있는지는 따로 묻는 목록(이름·크기·시각)으로 본다(스펙 2026-10-16-010 12절 D29)
TREE_SKIP_DIRS = ["logs", "sessions", "cache", ".cache", "home", "node_modules", "__pycache__", ".git", "terminal-sessions", "workspace", "mcp-tokens"]
# 게이트웨이가 수시로 고쳐 쓰는 상태 파일 두 개는 내용을 묶음에 넣지 않는다 — 읽을 때마다 사이드카에서 새로 받는다.
# 묶음(60초)의 내용으로 답하면 MCP 로그인 뒤 게이트웨이가 붙은 것을 60초 늦게 보고, 로그인 직후의 유예가 끝나 「확인 전」이 된다
# (OKE 2026-10-17, 스펙 2026-10-16-010 14-15). 둘 다 작은 파일이라 왕복 한 번이다.
# 묶음은 있음·없음도 들고 있으므로 내용만 빼서는 모자란다: 새 파드는 MCP 서버를 처음 더할 때 상태 파일이 생기는데, 묶음이 「없음」을
# 들고 있으면 60초 동안 없다고 답했다(14-17). 그래서 stat·read 도 이 이름은 묶음을 거치지 않는다(LIVE_FILES).
LIVE_FILES = frozenset({"aas-mcp-status.json", "gateway_state.json"})
TREE_NO_CONTENT = [".db", ".db-wal", ".db-shm", ".sqlite", ".sqlite3", ".log", ".jsonl", ".gz", ".zip", ".tar", ".png", ".jpg", ".jpeg", ".gif", ".pdf", ".so", ".whl",
                   *sorted(LIVE_FILES)]
TREE_MAX_FILE = 262_144
# 묶음은 목록만 받고(내용 없이) 지난 묶음과 견줘 바뀐 파일만 read 로 받는다. 한 번에 이 바이트까지 묶어 읽는다 — 사이드카 read 상한
# (8MB)보다 작고 느린 노드(worker-5, 약 0.65MB/s)에서도 기본 한도 10초 안에 든다(스펙 2026-10-24-013 R1·R3·Q4)
READ_CHUNK = 4_000_000
MEMO_MAX_AGE = 300.0        # 지문이 같아 다음 묶음으로 넘겨받는 무거운 결과(memo)의 최대 나이. 지문이 못 보는 바깥 상태가 묵지 않게(외부 검토 OV3)
# Hermes 가 몇 초마다 고쳐 쓰는 상태 파일. 있음·없음만 지문에 넣는다 — 크기·시각까지 넣으면 지문이 늘 바뀌어 무거운 결과를
# 매번 다시 만들었다(스펙 2026-10-24-013 P1·R2, Q3)
VOLATILE_NAMES = frozenset({"ticker_heartbeat", "ticker_last_success", "gateway.heartbeat", *LIVE_FILES})
# 묶음(tree)만 쓰는 시간 한도(초). 묶음은 수 MB 라 느린 노드에서 다른 연산의 한도(10초)를 넘는다. OKE worker-5 의 에이전트는 7.6MB 에
# 11초가 걸려 매번 끊겼고, 끊기면 30초 동안 하나씩 묻기로 떨어져 사이드카를 초당 75번 불렀다(스펙 2026-10-24-012)
TREE_TIMEOUT = 60.0
BURST_CALLS, BURST_SECONDS = 40, 2.0   # 이만큼 하나씩 묻기 시작하면(무거운 수집, 수백 번) 묶음을 받는다. 가벼운 수집(상태·채팅 등 20번 안팎)은 하나씩 묻는다
# 스레드마다 사이드카 연결 하나를 열어 두고 다시 쓴다. 호출마다 새로 열면 그때마다 DNS 를 묻는데, UDP 패킷 하나만 사라져도
# glibc 가 5초를 기다려 화면이 5초씩 튄다(OKE 실측 약 3천 번에 한 번, OMAI-1102). 이보다 오래 쉰 연결은 닫고 새로 연다.
IDLE_REUSE = 30.0
_STALE = (ConnectionResetError, BrokenPipeError, ConnectionAbortedError, http.client.BadStatusLine)   # 쉬던 연결을 사이드카가 닫았다(RemoteDisconnected 포함)


def _ack_at_once(conn: http.client.HTTPConnection) -> None:
    """응답을 읽기 전에 지연 ACK 를 끈다(리눅스, 한 번 쓰면 풀리므로 요청마다). 옛 사이드카(1.3.0 까지)는 Nagle 을 켠 채
    머리와 본문을 두 번에 보내서, 다시 쓰는 연결에서는 본문이 우리 ACK 를 40ms 기다렸다(OKE 실측 15→57ms, OMAI-1102)."""
    opt = getattr(socket, "TCP_QUICKACK", None)
    if opt is not None and conn.sock is not None:
        try:
            conn.sock.setsockopt(socket.IPPROTO_TCP, opt, 1)
        except OSError:
            pass


def _volatile(path: str) -> bool:
    name = posixpath.basename(path)
    return name in VOLATILE_NAMES or name.startswith("state.db")


def server_fingerprint(entries: list[dict], partial) -> str:
    """서버가 만드는 묶음 지문. 파일은 경로·크기·시각, 상태 파일(VOLATILE)은 있음만, 폴더는 경로만 넣는다. 안을 보지 않는
    폴더(partial)는 시각도 넣는다 — 그 안의 변화(예: mcp-tokens 에 토큰이 생김)는 폴더 시각으로만 안다(외부 검토 OV3)."""
    partial = set(partial)
    h = hashlib.sha256()
    for e in sorted(entries, key=lambda e: e["path"]):
        path = e["path"]
        if e["type"] == "dir":
            line = f"{path}\0d\0{e['mtime']!r}" if path in partial else f"{path}\0d"
        elif _volatile(path):
            line = f"{path}\0v"
        else:
            line = f"{path}\0{e['type']}\0{e['size']}\0{e['mtime']!r}"
        h.update(line.encode("utf-8", "surrogateescape") + b"\n")
    return h.hexdigest()


def _wants_content(e: dict) -> bool:
    return e["type"] == "file" and e["size"] <= TREE_MAX_FILE and not e["path"].endswith(tuple(TREE_NO_CONTENT))


class _Tree:
    """사이드카 목록 한 번과 그 내용. 이 안에 있는 경로는 사이드카에 다시 묻지 않는다. 내용은 `tree_cache.Blob`(압축·한 벌)."""

    def __init__(self, entries: list[dict], partial, data: dict, taken: float, server_fp: str = ""):
        self.taken = taken
        self.server_fp = server_fp
        self.memo: dict = {}                                  # 이 묶음으로 만든 무거운 결과(스킬 그래프 등)
        self.memo_born = taken                                # memo 를 처음 만든 묶음의 시각(넘겨받아도 그대로, MEMO_MAX_AGE)
        self.memo_stale = False                               # AAS 가 고쳤다 — 다음 묶음이 memo 를 넘겨받지 않는다(외부 검토 OV2)
        self.memo_lock = threading.Lock()
        self.entries: dict[str, dict] = {}
        self.data: dict = data
        self.children: dict[str, list[str]] = {"": []}
        for e in entries:
            path = e["path"]
            self.entries[path] = {"exists": True, "type": e["type"], "size": e["size"], "mtime": e["mtime"], "mode": e.get("mode", 0)}
            self.children.setdefault(posixpath.dirname(path), []).append(path)
            if e["type"] == "dir":
                self.children.setdefault(path, [])
        self.partial = set(partial)
        self.cursor: str | None = None                        # 사이드카 변경 커서(1.5 부터) — 다음에는 바뀐 것만 묻는다(R10)

    def content(self, rel: str) -> bytes | None:
        blob = self.data.get(rel)
        return None if blob is None else blob.bytes()

    def covers(self, rel: str) -> bool:
        """rel 의 존재 여부를 이 묶음이 안다(안을 보지 않은 폴더의 하위가 아니다)."""
        cur = posixpath.dirname(rel) if rel else ""
        while cur:
            if cur in self.partial:
                return False
            cur = posixpath.dirname(cur)
        return True

    def stat(self, rel: str) -> dict | None:
        if rel == "":
            return {"exists": True, "type": "dir", "size": 0, "mtime": 0, "mode": 0o40755}
        if rel in self.entries:
            return self.entries[rel]
        return {"exists": False} if self.covers(rel) else None

    def descendants(self, rel: str, recursive: bool) -> list[str] | None:
        """rel 아래 항목들. 안을 보지 않은 폴더가 걸리면 None(사이드카에 묻는다)."""
        if rel in self.partial or not self.covers(rel) or rel not in self.children:
            return None
        out, stack = [], [rel]
        while stack:
            cur = stack.pop()
            for child in self.children.get(cur, []):
                out.append(child)
                if recursive and self.entries[child]["type"] == "dir":
                    if child in self.partial:
                        return None
                    stack.append(child)
        return out


def _match(parts: list[str], pat: list[str]) -> bool:
    """pathlib.Path.glob 의 패턴 맞춤(조각마다 fnmatch, ** 는 0개 이상의 폴더). 대소문자를 구분한다."""
    if not pat:
        return not parts
    if pat[0] == "**":
        return any(_match(parts[i:], pat[1:]) for i in range(len(parts) + 1))
    return bool(parts) and fnmatch.fnmatchcase(parts[0], pat[0]) and _match(parts[1:], pat[1:])


_calls_lock = threading.Lock()
_calls: dict = {"ops": {}, "agents": {}}


def _count(label: str, path: str, seconds: float, nbytes: int) -> None:
    with _calls_lock:
        op = _calls["ops"].setdefault(path, {"n": 0, "ms": 0.0, "bytes": 0})
        op["n"] += 1
        op["ms"] += seconds * 1000
        op["bytes"] += nbytes
        ag = _calls["agents"].setdefault(label, {"n": 0, "bytes": 0})
        ag["n"] += 1
        ag["bytes"] += nbytes


def call_stats() -> dict:
    """마지막 호출 뒤 쌓인 사이드카 호출(연산별·에이전트별 횟수·시간·받은 바이트). 부르면 0 으로 돌아간다(스펙 2026-10-24-013 R0)."""
    global _calls
    with _calls_lock:
        out, _calls = _calls, {"ops": {}, "agents": {}}
    return out


def call_report_line(st: dict) -> str | None:
    """5분 사이드카 호출 기록 한 줄. 호출이 없으면 None. 연산은 받은 바이트 순, 에이전트는 상위 5개."""
    if not st.get("ops"):
        return None
    ops = sorted(st["ops"].items(), key=lambda kv: -kv[1]["bytes"])
    top = sorted(st["agents"].items(), key=lambda kv: -kv[1]["bytes"])[:5]
    return ("사이드카 호출(5분): " + ", ".join(f"{p} {v['n']}건 {v['ms']:.0f}ms {v['bytes'] / 1024:.0f}KB" for p, v in ops)  # i18n-ignore: 로그
            + " | 많이 받은 에이전트: " + ", ".join(f"{k} {v['n']}건 {v['bytes'] / 1024:.0f}KB" for k, v in top))   # i18n-ignore: 로그


class SidecarError(OSError):
    """사이드카가 응답하지 않거나 이상한 답을 줬다. 호출한 쪽은 OSError 로 받아 「수집 실패」로 다룬다."""
    timed_out = False                                         # 시간 초과로 실패했는가(응답 없음 기억에 쓴다)


# 시간 초과가 나면 「응답 없음」으로 기억하는 가벼운 연산(스펙 2026-10-24-002 R4·검토 D4). tree·scan 은 데이터가 커서
# 사이드카가 멀쩡해도 늦을 수 있고, tree 가 실패하면 하나씩 묻는 길로 넘어가므로 그 길을 막지 않는다
LIGHT_OPS = {"/v1/version", "/v1/stat", "/v1/list", "/v1/read", "/v1/sqlite", "/v1/sqlite_batch", "/v1/check"}


def _batch_read(path: str, body: dict | None) -> bool:
    """여러 파일을 묶은 read. 합계가 256KB 를 넘으면 사이드카에서 tree 와 같은 무거운 잠금 뒤에 줄 서므로(R20), 늦어도 사이드카가
    죽은 것이 아니다 — 「응답 없음」 기억을 켜지 않는다(스펙 2026-10-24-002 외부 검토 4)."""
    return path == "/v1/read" and len((body or {}).get("paths") or ()) > 1


class RemoteBackend:
    def __init__(self, url: str, token: str | Callable[[], str], *, timeout: float = 10.0, label: str = "", fail_memo: float = 30.0):
        self.url = url.rstrip("/")
        self._parts = urllib.parse.urlsplit(self.url)
        self._local = threading.local()                     # 스레드마다 연결 하나(http.client 연결은 스레드끼리 나눠 쓸 수 없다)
        self._token = token
        self.timeout = timeout
        self.label = label or self.url
        self._lock = threading.Lock()
        self._stats: dict[str, tuple[float, dict]] = {}
        self._tree: _Tree | None = None
        self._tree_lock = threading.Lock()                  # 같은 묶음을 동시에 두 번 받지 않는다
        self._has_tree: bool | None = None                  # 옛 사이드카(1.0)에는 tree 가 없다 — 그때는 지금처럼 하나씩 묻는다
        self._recent: list[float] = []                      # 최근 하나씩 묻기 시각(묶음을 받을지 판단)
        self._last_tree: _Tree | None = None                # 시간이 지난 묶음(다시 받을 때 지문을 비교한다)
        self._has_batch: bool | None = None                 # 옛 사이드카(1.2 까지)에는 sqlite_batch 가 없다
        # 응답 없음 기억(R4). 가벼운 연산이 시간 초과를 내면 fail_memo 초 동안 사이드카에 보내지 않고 바로 실패한다.
        # 그동안에도 시험 호출 하나는 보내, 사이드카가 돌아오면 바로 풀린다
        self.fail_memo = fail_memo
        self._down_at = 0.0
        self._trial = False
        self._tree_failed_at = 0.0                          # 마지막 tree 실패 시각 — 그 뒤 fail_memo 초 동안은 묶음 없이 하나씩 묻는다(R13)
        self._has_changes: bool | None = None               # 옛 사이드카(1.4 까지)에는 changes 가 없다(R10)
        self._conns: "weakref.WeakSet" = weakref.WeakSet()  # 스레드마다 연 연결 — 묶음을 버릴 때 함께 닫는다(외부 검토 OV10)

    # ---- 전송 ---------------------------------------------------------------------------------
    def _call(self, method: str, path: str, body: dict | None = None, timeout: float | None = None) -> dict:
        token = self._token() if callable(self._token) else self._token
        data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        trial = self._gate()
        began = time.monotonic()
        try:
            status, raw = self._send(method, self._parts.path + path, data, headers, timeout)
        except SidecarError as exc:
            _count(self.label, path, time.monotonic() - began, 0)
            with self._lock:
                if trial:
                    self._trial = False
                if exc.timed_out and path in LIGHT_OPS and not _batch_read(path, body):
                    self._down_at = time.monotonic()
            raise
        _count(self.label, path, time.monotonic() - began, len(raw))
        with self._lock:                                      # 답이 왔다(오류 상태라도) — 사이드카는 살아 있다
            self._down_at = 0.0
            if trial:
                self._trial = False
        if status >= 400:
            detail = ""
            try:
                detail = json.loads(raw).get("error", "")
            except Exception:
                pass
            if status == 401:
                raise PermissionError(tr(f"사이드카가 토큰을 거절했습니다 ({self.label})", f"The sidecar rejected the token ({self.label})"))
            if status == 404:
                raise FileNotFoundError(detail or tr("없습니다", "Not found"))
            raise SidecarError(tr(f"사이드카 오류 HTTP {status}: {detail}", f"Sidecar error HTTP {status}: {detail}"))
        try:
            return json.loads(raw)
        except ValueError:
            raise SidecarError(tr(f"사이드카 응답을 읽지 못했습니다 ({self.label})", f"Cannot parse the sidecar response ({self.label})")) from None

    def _conn(self) -> http.client.HTTPConnection:
        local = self._local
        conn = getattr(local, "conn", None)
        if conn is not None and time.monotonic() - local.used > IDLE_REUSE:
            conn.close()
            conn = None
        if conn is None:
            cls = http.client.HTTPSConnection if self._parts.scheme == "https" else http.client.HTTPConnection
            conn = local.conn = cls(self._parts.hostname, self._parts.port, timeout=self.timeout)
            conn._create_connection = netcache.create_connection   # 새로 여는 연결도 DNS 를 다시 묻지 않는다(OMAI-1108)
            self._conns.add(conn)
        return conn

    def _send(self, method: str, target: str, data: bytes | None, headers: dict, timeout: float | None = None) -> tuple[int, bytes]:
        """이 스레드의 연결로 보내고 (상태, 본문)을 돌려준다. 쉬던 연결이 끊겨 있으면 한 번만 새로 열어 다시 보낸다(연산은 모두 읽기다).
        timeout 을 주면 이 요청만 그 한도를 쓰고, 끝나면 연결의 한도를 되돌린다(같은 연결을 다음 연산이 다시 쓴다)."""
        for attempt in (0, 1):
            conn = self._conn()
            reused = conn.sock is not None
            if timeout is not None:
                conn.timeout = timeout                          # 새로 여는 연결
                if conn.sock is not None:
                    conn.sock.settimeout(timeout)               # 다시 쓰는 연결
            try:
                conn.request(method, target, body=data, headers=headers)
                _ack_at_once(conn)
                resp = conn.getresponse()
                return resp.status, resp.read()                 # 본문을 끝까지 읽어야 같은 연결로 다음 요청을 보낼 수 있다
            except _STALE as exc:
                conn.close()
                if reused and attempt == 0:
                    continue
                err = exc
            except (OSError, http.client.HTTPException) as exc:  # 연결 거부·시간 초과 등. 시간 초과는 다시 보내지 않는다(기다림이 두 배가 된다)
                conn.close()
                err = exc
            except BaseException:
                conn.close()                                     # 주고받던 중에 멈춘 연결은 다시 쓰지 않는다
                raise
            finally:
                self._local.used = time.monotonic()
                if timeout is not None:
                    conn.timeout = self.timeout
                    if conn.sock is not None:
                        conn.sock.settimeout(self.timeout)
            fail = SidecarError(tr(f"사이드카에 연결할 수 없습니다 ({self.label}): {type(err).__name__}", f"Cannot reach the sidecar ({self.label}): {type(err).__name__}"))
            fail.timed_out = isinstance(err, TimeoutError)
            raise fail
        raise AssertionError("unreachable")

    def _gate(self) -> bool:
        """응답 없음으로 기억하는 동안이면 바로 실패한다. 다만 시험 호출이 하나도 없으면 이 호출이 시험 호출이 된다(참을 돌려준다)."""
        with self._lock:
            if not self._down_at or time.monotonic() - self._down_at >= self.fail_memo:
                return False
            if self._trial:
                raise SidecarError(tr(f"사이드카가 응답하지 않습니다 ({self.label}). 잠시 뒤 다시 시도합니다",
                                      f"The sidecar is not responding ({self.label}). Will retry shortly"))
            self._trial = True
            return True

    # ---- 연산 ---------------------------------------------------------------------------------
    def version(self) -> dict:
        return self._call("GET", "/v1/version")

    def invalidate(self) -> None:
        """AAS 가 이 에이전트의 파일을 고쳤다. 묶음은 만료로 돌리고 무거운 결과(memo)는 다시 만들게 한다. 목록·내용은 다음 묶음이
        바뀐 파일만 읽도록 견줄 기준으로 남긴다 — 다 버리면 AAS 가 쓸 때마다 두 서버가 전부 다시 읽었다(외부 검토 OV2)."""
        with self._lock:
            self._stats.clear()
            if self._tree is not None:
                self._last_tree, self._tree = self._tree, None
            if self._last_tree is not None:
                self._last_tree.memo_stale = True

    def drop(self) -> None:
        """묶음을 버리고 이 백엔드의 사이드카 연결을 닫는다(최근 사용 순 정리, R8). 다음에 쓰면 처음부터 다시 받는다."""
        with self._lock:
            self._stats.clear()
            self._tree = self._last_tree = None
        for conn in list(self._conns):
            try:
                conn.close()
            except Exception:
                pass

    def has_tree(self) -> bool:
        return self._tree is not None or self._last_tree is not None

    def entry_count(self) -> int:
        tree = self._tree or self._last_tree
        return len(tree.entries) if tree is not None else 0

    def snapshot(self, max_age: float = TREE_TTL) -> bool:
        """데이터 폴더 전체를 한 번에 받아 둔다. 그 뒤 stat·list·read 는 묶음에서 답한다. 받았거나 이미 있으면 True."""
        tree_cache.touch(self.label)
        if self._has_tree is False:
            return False
        if self._tree_failed_at and time.monotonic() - self._tree_failed_at < self.fail_memo:
            # 방금 tree 가 실패했다. 줄 선 스레드가 저마다 다시 받으면 기다림이 N × 10초가 된다(스펙 2026-10-24-002 R13)
            return False
        with self._tree_lock:
            if self._tree_failed_at and time.monotonic() - self._tree_failed_at < self.fail_memo:
                return False                                  # 잠금을 기다리는 동안 앞 스레드가 실패했다
            tree = self._tree
            if tree is not None and time.monotonic() - tree.taken < max_age:
                return True
            base = tree or self._last_tree
            merged = self._changes_since(base)
            if merged is not None:
                self._has_tree = True
                self._tree = self._build_tree(merged, base)
                self._last_tree = None
                self._tree_failed_at = 0.0
                return True
            try:
                listing = self._call("POST", "/v1/tree", self._listing_body(), timeout=TREE_TIMEOUT)
            except FileNotFoundError:
                self._has_tree = False                    # 옛 사이드카: 없는 경로(404)
                return False
            except (OSError, ValueError, KeyError):
                self._tree_failed_at = time.monotonic()
                return False                              # 묶음을 못 받아도 수집은 하나씩 묻는 길로 이어 간다
            if listing.get("truncated"):
                return False
            self._has_tree = True
            self._tree = self._build_tree(listing, base)
            self._last_tree = None                        # 견주기가 끝났다 — 에이전트마다 묶음 하나만 둔다
            self._tree_failed_at = 0.0
            return True

    def _listing_body(self) -> dict:
        # "" 는 모든 파일 — 목록만. hashes·cursor 는 사이드카 1.5 부터(파일 해시·변경 커서, R7·R10). 옛 사이드카는 모르는 키를 무시한다
        return {"path": "", "skip_dirs": TREE_SKIP_DIRS, "no_content": [""], "max_file": TREE_MAX_FILE,
                "hashes": TREE_NO_CONTENT, "cursor": True}

    def _changes_since(self, base: "_Tree | None") -> dict | None:
        """지난 묶음의 커서 뒤에 바뀐 것만 받아 목록을 맞춘다(R10). 쓸 수 없으면(커서 없음·옛 사이드카·reset·실패) None —
        부른 쪽이 목록 전체를 받는다."""
        if base is None or not base.cursor or self._has_changes is False:
            return None
        body = {"since": base.cursor, "path": "", "skip_dirs": TREE_SKIP_DIRS, "max_file": TREE_MAX_FILE, "hashes": TREE_NO_CONTENT,
                "fresh": base.memo_stale}                     # AAS 가 고친 직후 — 사이드카의 2초 재사용 없이 다시 훑게
        try:
            out = self._call("POST", "/v1/changes", body, timeout=TREE_TIMEOUT)
        except FileNotFoundError:
            self._has_changes = False
            return None
        except (OSError, ValueError, KeyError):
            return None
        self._has_changes = True
        if out.get("reset"):
            return None
        entries = {p: {"path": p, **e} for p, e in base.entries.items()}
        for p in out.get("removed", []):
            entries.pop(p, None)
        for e in out.get("entries", []):
            entries[e["path"]] = e
        return {"entries": list(entries.values()), "partial": out.get("partial", list(base.partial)), "cursor": out.get("cursor")}

    def _build_tree(self, listing: dict, base: "_Tree | None") -> "_Tree":
        """목록과 지난 묶음을 견줘 크기·시각이 같은 파일은 내용을 넘겨받고, 새로 생기거나 바뀐 파일만 READ_CHUNK 씩 나눠 읽는다.
        한 조각이 실패해도 받은 것은 남긴다 — 빠진 파일은 읽을 때 사이드카에 묻는다(외부 검토 OV7)."""
        entries, partial = listing["entries"], listing.get("partial", [])
        data, ask = {}, []
        for e in entries:
            if not _wants_content(e):
                continue
            old = base.entries.get(e["path"]) if base is not None else None
            if old is not None and e["path"] in base.data and old["size"] == e["size"] and old["mtime"] == e["mtime"]:
                data[e["path"]] = base.data[e["path"]]
            elif e.get("sha256") and not secret_scrub.is_credential(e["path"]) and tree_cache.known(e["sha256"]) is not None:
                data[e["path"]] = tree_cache.known(e["sha256"])    # 다른 에이전트·프로필의 같은 내용 — 읽지 않는다(R7)
            else:
                ask.append(e)
        chunk, size = [], 0
        for e in ask + [None]:
            if e is not None and (not chunk or size + e["size"] <= READ_CHUNK):
                chunk.append(e["path"])
                size += e["size"]
                continue
            if chunk:
                try:
                    files = self._call("POST", "/v1/read", {"paths": chunk})["files"]
                except (OSError, ValueError, KeyError):
                    break
                for f in secret_scrub.scrub_files(files):
                    if f.get("ok") and "data_b64" in f:
                        raw = base64.b64decode(f["data_b64"])
                        # 자격증명 파일(원문을 토큰으로 바꾼 것)은 서버 전체 한 벌 저장소에 넣지 않는다(리뷰 A1)
                        data[f["path"]] = tree_cache.private(raw) if secret_scrub.is_credential(f["path"]) else tree_cache.intern(raw)
            if e is not None:
                chunk, size = [e["path"]], e["size"]
        fp = server_fingerprint(entries, partial)
        tree = _Tree(entries, partial, data, time.monotonic(), fp)
        tree.cursor = listing.get("cursor")
        if (base is not None and base.server_fp == fp and not base.memo_stale
                and time.monotonic() - base.memo_born < MEMO_MAX_AGE):
            with base.memo_lock:
                tree.memo = dict(base.memo)
            tree.memo_born = base.memo_born
        return tree

    def fingerprint(self) -> str | None:
        """이 에이전트 폴더의 서버 지문. 지금 묶음이 있으면 그것, 없으면 목록만 받아(내용 없이) 만든다. 못 받으면 None.
        태그·설명 루프가 바뀐 에이전트만 스킬을 다시 모으는 데 쓴다(D6)."""
        tree = self._tree
        if tree is not None and time.monotonic() - tree.taken < TREE_TTL:
            return tree.server_fp
        try:
            listing = self._call("POST", "/v1/tree", self._listing_body(), timeout=TREE_TIMEOUT)
        except (OSError, ValueError, KeyError):
            return None
        if listing.get("truncated") or "entries" not in listing:
            return None
        return server_fingerprint(listing["entries"], listing.get("partial", []))

    def current_tree(self) -> "_Tree | None":
        """지금 쓸 수 있는 묶음(받으러 가지 않는다)."""
        tree_cache.touch(self.label)
        tree = self._tree
        return tree if tree is not None and time.monotonic() - tree.taken < TREE_TTL else None

    def _fresh_tree(self) -> "_Tree | None":
        tree_cache.touch(self.label)
        tree = self._tree
        if tree is not None and time.monotonic() - tree.taken < TREE_TTL:
            return tree
        if tree is not None:
            self._last_tree, self._tree = tree, None
        if self._has_tree is False:
            return None
        now = time.monotonic()
        with self._lock:
            self._recent = [t for t in self._recent if now - t < BURST_SECONDS] + [now]
            burst = len(self._recent) >= BURST_CALLS
            if burst:
                self._recent = []
        if burst and self.snapshot():
            return self._tree
        return None

    def stat(self, rel: str) -> dict:
        if posixpath.basename(rel) in LIVE_FILES:              # 묶음도 stat 캐시도 거치지 않는다(14-17)
            return self._call("POST", "/v1/stat", {"path": rel})
        tree = self._fresh_tree()
        if tree is not None:
            hit = tree.stat(rel)
            if hit is not None:
                return hit
        now = time.monotonic()
        with self._lock:
            hit = self._stats.get(rel)
            if hit and now - hit[0] < STAT_TTL:
                return hit[1]
        out = self._call("POST", "/v1/stat", {"path": rel})
        with self._lock:
            self._stats[rel] = (now, out)
        return out

    def stat_now(self, rel: str) -> dict:
        """묶음·stat 캐시를 거치지 않는 stat. 인증 파일 목록이 쓴다 — 바꾼 직후의 mtime_ns 와 견줘야 한다(스펙 2026-10-22-004 R13)."""
        return self._call("POST", "/v1/stat", {"path": rel})

    def list_now(self, rel: str, pattern: str) -> list[dict]:
        """캐시를 거치지 않는 목록(사이드카 glob). 폴더가 없으면 빈 목록."""
        try:
            return list(self._call("POST", "/v1/list", {"path": rel, "pattern": pattern}).get("entries") or [])
        except FileNotFoundError:
            return []

    def read(self, rels: list[str]) -> list[dict]:
        tree = self._fresh_tree()
        if tree is None:
            return secret_scrub.scrub_files(self._call("POST", "/v1/read", {"paths": rels})["files"])
        out: list[dict | None] = []
        ask = []
        for rel in rels:
            if posixpath.basename(rel) in LIVE_FILES:
                out.append(None)                          # 게이트웨이가 수시로 쓰는 파일 — 늘 사이드카에 묻는다
                ask.append(rel)
                continue
            if rel in tree.data:
                data = tree.data[rel].bytes()
                out.append({"path": rel, "ok": True, "size": len(data), "data_b64": base64.b64encode(data).decode()})
                continue
            st = tree.stat(rel)
            if st is not None and not st.get("exists"):
                out.append({"path": rel, "ok": False, "error": "missing"})
            elif st is not None and st.get("type") == "dir":
                out.append({"path": rel, "ok": False, "error": "not_file"})
            else:
                out.append(None)                          # 큰 파일·건너뛴 폴더 안 — 사이드카에 묻는다
                ask.append(rel)
        if ask:
            got = iter(secret_scrub.scrub_files(self._call("POST", "/v1/read", {"paths": ask})["files"]))
            out = [o if o is not None else next(got) for o in out]
        return out  # type: ignore[return-value]

    def list(self, rel: str, pattern: str) -> list[dict]:
        tree = self._fresh_tree()
        pat = [p for p in pattern.split("/") if p] if pattern else []
        # 끝이 ** 인 패턴은 파이썬 판마다 뜻이 달라(3.13 부터 파일도 낸다) 사이드카에 그대로 묻는다
        if tree is not None and pat and pat[-1] != "**" and not pattern.startswith("/") and ".." not in pat:
            found = tree.descendants(rel, recursive=len(pat) > 1 or "**" in pat)
            if found is not None:
                if rel and rel not in tree.entries:
                    raise FileNotFoundError(rel)
                base = len(rel) + 1 if rel else 0
                hits = sorted(p for p in found if _match(p[base:].split("/"), pat))
                return [{"path": p, **{k: tree.entries[p][k] for k in ("type", "size", "mtime", "mode")}} for p in hits]
        out = self._call("POST", "/v1/list", {"path": rel, "pattern": pattern})
        now = time.monotonic()
        with self._lock:                              # 목록이 준 종류·크기를 stat 캐시에 넣어 is_file() 왕복을 없앤다
            for e in out["entries"]:
                self._stats[e["path"]] = (now, {"exists": True, "type": e["type"], "size": e["size"], "mtime": e["mtime"],
                                                "mode": e.get("mode", 0)})
        return out["entries"]

    # ---- 대화 파일(사이드카 1.4.0, OMAI-1153) ---------------------------------------------------
    def has_file_ops(self) -> bool:
        """사이드카가 scan·check·download 를 아는가(1.4.0). 옛 사이드카면 파일 기능을 끈다. 아는 경우만 기억한다."""
        known = getattr(self, "_has_files", None)            # (판정, 시각) — 아는 것은 계속, 모르는 것은 60초 동안 기억
        if known and (known[0] or time.monotonic() - known[1] < 60):
            return known[0]
        try:
            ok = "download" in (self.version().get("ops") or [])
        except (OSError, ValueError):
            ok = False
        self._has_files = (ok, time.monotonic())
        return ok

    def scan(self, rel: str, skip_dirs: list[str] | None = None) -> dict:
        return self._call("POST", "/v1/scan", {"path": rel, "skip_dirs": skip_dirs or []})

    def check(self, rel: str) -> dict:
        return self._call("POST", "/v1/check", {"path": rel})

    def open_download(self, rel: str, method: str = "GET", timeout: float = 60.0):
        """내려받기를 연다. (상태, 머리, 응답, 연결). 200 이면 부른 쪽이 응답을 끝까지 읽고 연결을 닫는다.
        흘려보내는 동안 스레드의 공용 연결을 붙잡지 않도록 새 연결을 쓴다."""
        token = self._token() if callable(self._token) else self._token
        cls = http.client.HTTPSConnection if self._parts.scheme == "https" else http.client.HTTPConnection
        conn = cls(self._parts.hostname, self._parts.port, timeout=timeout)
        conn._create_connection = netcache.create_connection
        target = self._parts.path + "/v1/download?" + urllib.parse.urlencode({"path": rel})
        try:
            conn.request(method, target, headers={"Authorization": f"Bearer {token}"})
            resp = conn.getresponse()
        except (OSError, http.client.HTTPException) as exc:
            conn.close()
            raise SidecarError(tr(f"사이드카에 연결할 수 없습니다 ({self.label}): {type(exc).__name__}", f"Cannot reach the sidecar ({self.label}): {type(exc).__name__}")) from None
        if resp.status != 200:
            raw = resp.read() if method != "HEAD" else b""
            conn.close()
            try:
                code = json.loads(raw).get("error", "") if raw else ""
            except ValueError:
                code = ""
            return resp.status, code, None, None
        return 200, "", resp, conn

    def sqlite(self, rel: str, sql: str, params: list) -> dict:
        return self._call("POST", "/v1/sqlite", {"path": rel, "sql": sql, "params": params})

    def sqlite_batch(self, queries: list[tuple[str, str, list]]) -> list[dict]:
        """여러 쿼리를 요청 하나로(사이드카 1.3.0). 옛 사이드카는 하나씩 묻는다. 결과는 쿼리마다 sqlite() 응답이거나 {error, code}."""
        if self._has_batch is not False and queries:
            try:
                out = self._call("POST", "/v1/sqlite_batch",
                                 {"queries": [{"path": r, "sql": q, "params": list(ps)} for r, q, ps in queries]})
                self._has_batch = True
                return out["results"]
            except FileNotFoundError:
                self._has_batch = False                   # 옛 사이드카: 없는 경로(404)
        results = []
        for r, q, ps in queries:
            try:
                results.append(self.sqlite(r, q, list(ps)))
            except FileNotFoundError as exc:
                results.append({"error": str(exc) or "missing", "code": 404})
            except (SidecarError, PermissionError) as exc:
                results.append({"error": str(exc), "code": 500})
        return results


def _norm(rel: str) -> str:
    return "/".join(p for p in rel.split("/") if p not in ("", "."))


class RemotePath:
    """pathlib.Path 의 읽기 쪽 일부를 사이드카 위에 낸다. 루트는 Hermes 데이터 폴더다."""

    __slots__ = ("_b", "_rel")

    def __init__(self, backend: RemoteBackend, rel: str = ""):
        self._b = backend
        self._rel = _norm(rel)

    # ---- 이름·비교 ----------------------------------------------------------------------------
    @property
    def backend(self) -> RemoteBackend:
        return self._b

    @property
    def rel(self) -> str:
        return self._rel

    @property
    def _outside(self) -> bool:
        return self._rel == ".." or self._rel.startswith("../")

    @property
    def name(self) -> str:
        return posixpath.basename(self._rel)

    @property
    def suffix(self) -> str:
        return PurePosixPath(self._rel).suffix

    @property
    def stem(self) -> str:
        return PurePosixPath(self._rel).stem

    @property
    def parts(self) -> tuple[str, ...]:
        return tuple(p for p in self._rel.split("/") if p)

    @property
    def parent(self) -> "RemotePath":
        return RemotePath(self._b, posixpath.dirname(self._rel))

    @property
    def parents(self) -> list["RemotePath"]:
        if self._outside:
            return []                                  # 밖으로 나간 경로는 root 의 하위로 치지 않는다
        out, cur = [], self._rel
        while cur:
            cur = posixpath.dirname(cur)
            out.append(RemotePath(self._b, cur))
        return out

    def __truediv__(self, other) -> "RemotePath":
        text = str(other)
        if text.startswith("/"):
            raise ValueError(tr("절대 경로는 이을 수 없습니다", "Cannot join an absolute path"))
        return RemotePath(self._b, f"{self._rel}/{text}" if self._rel else text)

    def joinpath(self, *others) -> "RemotePath":
        out = self
        for o in others:
            out = out / o
        return out

    def relative_to(self, other) -> PurePosixPath:
        base = other.rel if isinstance(other, RemotePath) else _norm(str(other))
        if base and self._rel != base and not self._rel.startswith(base + "/"):
            raise ValueError(tr(f"{self} 는 {other} 의 하위가 아닙니다", f"{self} is not under {other}"))
        return PurePosixPath(self._rel[len(base):].lstrip("/") or ".")

    def resolve(self) -> "RemotePath":
        """`..` 를 글자 그대로 정리한다. 심링크 탈출은 사이드카가 막는다. root 위로 나가면 root 의 하위가 아닌 경로가 된다."""
        parts: list[str] = []
        for p in self._rel.split("/"):
            if p == "..":
                if parts and parts[-1] != "..":
                    parts.pop()
                else:
                    parts.append("..")
            elif p:
                parts.append(p)
        return RemotePath(self._b, "/".join(parts))

    def __eq__(self, other) -> bool:
        return isinstance(other, RemotePath) and other._b.url == self._b.url and other._rel == self._rel

    def __hash__(self) -> int:
        return hash((self._b.url, self._rel))

    def __lt__(self, other: "RemotePath") -> bool:
        return self._rel < other._rel

    def __str__(self) -> str:
        return f"{self._b.label}:/{self._rel}"

    __repr__ = __str__

    # ---- 읽기 ---------------------------------------------------------------------------------
    def _stat(self) -> dict:
        if self._outside:
            return {"exists": False}
        return self._b.stat(self._rel)

    def exists(self) -> bool:
        return bool(self._stat().get("exists"))

    def is_file(self) -> bool:
        return self._stat().get("type") == "file"

    def is_dir(self) -> bool:
        return self._stat().get("type") == "dir"

    def stat(self):
        st = self._stat()
        if not st.get("exists"):
            raise FileNotFoundError(str(self))
        return SimpleNamespace(st_size=st["size"], st_mtime=st["mtime"], st_mode=st.get("mode", 0))

    def read_bytes(self) -> bytes:
        if self._outside:
            raise PermissionError(tr("root 밖입니다", "Outside the root"))
        tree = self._b.current_tree()
        if tree is not None and self._rel in tree.data:
            return tree.data[self._rel].bytes()                # 묶음에 있으면 base64 를 다시 만들고 풀지 않는다
        item = self._b.read([self._rel])[0]
        if item["ok"]:
            return base64.b64decode(item["data_b64"])
        err = item.get("error")
        if err == "not_file":
            raise IsADirectoryError(str(self))
        if err == "too_large":
            raise OSError(27, tr("파일이 너무 큽니다", "File is too large"), str(self))
        if err == "missing":
            raise FileNotFoundError(str(self))
        raise SidecarError(tr(f"읽지 못했습니다 ({err})", f"Cannot read ({err})"))

    def read_text(self, encoding: str = "utf-8", errors: str = "strict") -> str:
        return self.read_bytes().decode(encoding, errors)

    def _list(self, pattern: str) -> list["RemotePath"]:
        if self._outside:
            raise PermissionError(tr("root 밖입니다", "Outside the root"))
        return [RemotePath(self._b, e["path"]) for e in self._b.list(self._rel, pattern)]

    def iterdir(self):
        return iter(self._list("*"))

    def glob(self, pattern: str):
        try:
            return iter(self._list(pattern))
        except FileNotFoundError:
            return iter(())                            # pathlib 처럼 없는 폴더의 glob 은 빈 결과

    def rglob(self, pattern: str):
        return self.glob("**/" + pattern)


def read_texts(paths: list[RemotePath], batch: int = 200, strict: bool = False) -> list[str]:
    """여러 파일을 사이드카 요청 한 번에 여럿씩 읽는다. 읽지 못한 파일은 빈 문자열이다(파일마다 왕복하면 느리다).
    한 요청의 총량 상한(total_cap)에 걸린 파일은 다음 요청으로 다시 읽는다. 한 파일도 못 읽는 요청이 나오면 남은 파일은 포기한다.
    strict: 사이드카에 닿지 못하면 빈 글로 바꾸지 않고 SidecarError 를 올린다(화면이 「연결할 수 없음」을 보이게)."""
    out: dict[int, str] = {}
    pending = [(i, p) for i, p in enumerate(paths) if not p._outside]
    while pending:
        chunk, rest = pending[:batch], pending[batch:]
        try:
            items = chunk[0][1]._b.read([p._rel for _, p in chunk])
        except SidecarError:
            if strict:
                raise
            break
        retry = []
        for (i, p), item in zip(chunk, items):
            if item.get("ok"):
                out[i] = base64.b64decode(item["data_b64"]).decode("utf-8", "replace")
            elif item.get("error") == "total_cap":
                retry.append((i, p))
        if retry and len(retry) == len(chunk):
            break
        pending = retry + rest
    return [out.get(i, "") for i in range(len(paths))]


class RemoteRow(tuple):
    """sqlite3.Row 처럼 번호·이름으로 읽고 반복·dict() 가 된다."""

    def __new__(cls, columns: tuple[str, ...], values):
        row = super().__new__(cls, values)
        row._cols = columns
        return row

    def keys(self) -> list[str]:
        return list(self._cols)

    def __getitem__(self, key):
        if isinstance(key, str):
            try:
                return tuple.__getitem__(self, self._cols.index(key))
            except ValueError:
                lowered = [c.lower() for c in self._cols]
                if key.lower() in lowered:
                    return tuple.__getitem__(self, lowered.index(key.lower()))
                raise IndexError(f"No item with that key: {key}") from None
        return tuple.__getitem__(self, key)


class RemoteCursor:
    def __init__(self, rows: list[RemoteRow]):
        self._rows, self._pos = rows, 0

    def fetchone(self):
        if self._pos >= len(self._rows):
            return None
        self._pos += 1
        return self._rows[self._pos - 1]

    def fetchall(self) -> list[RemoteRow]:
        out, self._pos = self._rows[self._pos:], len(self._rows)
        return out

    def __iter__(self):
        return iter(self.fetchall())


class RemoteConnection:
    row_factory = None                                 # 행은 항상 RemoteRow(이름으로도 읽힌다)

    def __init__(self, path: RemotePath):
        self._path = path

    def execute(self, sql: str, params=()) -> RemoteCursor:
        try:
            out = self._path.backend.sqlite(self._path.rel, sql, list(params))
        except PermissionError as exc:
            raise sqlite3.OperationalError(str(exc)) from None
        except FileNotFoundError:
            raise sqlite3.OperationalError("unable to open database file") from None
        except SidecarError as exc:
            raise sqlite3.OperationalError(str(exc)) from None
        cols = tuple(out["columns"])
        rows = [RemoteRow(cols, [self._cell(c) for c in r]) for r in out["rows"]]
        if out.get("truncated"):
            raise sqlite3.OperationalError(tr("결과가 너무 많아 잘렸습니다", "Result truncated: too many rows"))
        return RemoteCursor(rows)

    @staticmethod
    def _cell(value):
        if isinstance(value, dict) and "$b64" in value:
            return base64.b64decode(value["$b64"])
        return value

    def close(self) -> None:
        pass


def connect(path: RemotePath) -> RemoteConnection:
    return RemoteConnection(path)


def prefetch(home) -> bool:
    """무거운 수집 앞에서 부른다: 원격이면 묶음을 먼저 받아 하나씩 묻기를 시작하지 않게 한다(로컬 Path 는 아무것도 하지 않는다)."""
    backend = getattr(home, "backend", None)
    return bool(backend is not None and backend.snapshot())


def memo(home, name: str, fn):
    """같은 묶음으로 만든 무거운 결과를 다시 쓴다(예: 호출흐름이 스킬 그래프를 세 번 만들던 것). 묶음이 없으면 그냥 만든다.
    결과는 호출자들이 나눠 쓰므로 고쳐 쓰면 안 된다(지금 호출자는 모두 읽기만 한다)."""
    from ...common import i18n
    backend = getattr(home, "backend", None)
    tree = backend.current_tree() if backend is not None else None
    if tree is None:
        return fn()
    key = (name, home.rel, i18n.get_lang())
    with tree.memo_lock:
        if key in tree.memo:
            return tree.memo[key]
    value = fn()
    with tree.memo_lock:
        tree.memo.setdefault(key, value)
    return value
