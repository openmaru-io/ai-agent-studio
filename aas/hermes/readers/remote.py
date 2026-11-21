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
import contextlib
import contextvars
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
# 언어별 의존성·캐시 폴더 중 그 도구만 쓰는 이름(스펙 2026-11-03-003 §3-3 「기본에 더함」). 가상 환경·site-packages 가 데이터 폴더에
# 8만 개 넘게 쌓여 묶음이 상한에서 늘 잘렸다(GitHub #1). vendor·target·build 처럼 스킬이 자기 파일에도 쓰는 이름은 넣지 않는다 —
# 필요하면 AAS_TREE_SKIP_DIRS_EXTRA 로 더한다(D8). 묶음(R2)과 찾기용 재귀 목록(R5)이 같은 목록을 쓴다
DEPENDENCY_DIRS = [
    ".npm", ".pnpm-store", ".yarn", "bower_components", ".next", ".nuxt", ".turbo", ".parcel-cache",          # Node.js
    "site-packages", "dist-packages", ".venv", "venv", ".venvs", "lazy-packages",                           # Python
    # .deps: 스킬·플러그인이 `pip install --target <스킬>/.deps` 로 깐 패키지(COP share-marketing 6만여 개로 묶음이 끊겨 사이드카
    # OOMKilled), .python: uv 가 받은 파이썬 해석기. 스펙 2026-11-18-018 R1. backup·backups 는 넣지 않는다 — 스킬 안 state/backup
    # 같은 폴더가 묶음에서 partial 이 되면 그 프로파일의 찾기 전체가 사이드카로 간다(사용자 최종 승인)
    ".deps", ".python",
    ".tox", ".nox", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".ipynb_checkpoints",
    ".gradle", ".m2", ".cargo", ".rustup", ".bundle", ".dart_tool", ".pub-cache", ".stack-work", "dist-newstyle",
    "renv", ".terraform",
]
# 찾기·집계용 재귀 목록(스킬 찾기·스킬 그래프·스킬 파일 목록·사용처 집계)이 들어가지 않는 이름. 묶음에서 건너뛴 폴더 중
# 보안(mcp-tokens)이나 다른 뜻(home·workspace·sessions·terminal-sessions)이 있는 것은 빼고, 따로 묻기로 읽는다(D11)
_SEARCH_BASE = [".git", "cache", ".cache", "logs", "__pycache__", "node_modules"]
TRUNCATED_MEMO = 600.0      # 잘린 묶음을 실패로 기억하는 시간(초). 항목 수는 몇 분 안에 줄지 않는다(D6). 일반 실패 기억(fail_memo)과 따로 둔다


def _extra_skip_dirs(environ) -> list[str]:
    """AAS_TREE_SKIP_DIRS_EXTRA(쉼표로 나눔). 폴더 이름만 받는다 — 빈 값·`/`·`.`·`..` 는 버린다. 기본 목록은 줄일 수 없다(R2)."""
    names = (n.strip() for n in str(environ.get("AAS_TREE_SKIP_DIRS_EXTRA") or "").split(","))
    return [n for n in names if n and "/" not in n and n not in (".", "..")]


def _unique(names) -> list[str]:
    return list(dict.fromkeys(names))


def tree_skip_dirs(environ=None) -> list[str]:
    """묶음(tree·changes)에서 안을 보지 않는 폴더 이름: 기본 + 의존성 이름 + 환경변수로 더한 이름."""
    import os
    return _unique(TREE_SKIP_DIRS + DEPENDENCY_DIRS + _extra_skip_dirs(os.environ if environ is None else environ))


def search_skip_dirs(environ=None) -> frozenset[str]:
    """찾기·집계용 재귀 목록이 건너뛰는 이름(D11). 환경변수로 더한 이름도 의존성 폴더로 보고 함께 건너뛴다."""
    import os
    return frozenset(_SEARCH_BASE + DEPENDENCY_DIRS + _extra_skip_dirs(os.environ if environ is None else environ))


# 끊김·잘림 경고(스펙 2026-11-18-018 R5). 운영자가 README 문제 해결 표를 이 태그로 찾는다 — 문장이 바뀌어도 태그는 그대로 둔다.
# 조치는 건너뛰기 먼저: 상한을 올리면 사이드카가 더 큰 목록을 만들어 메모리가 모자란 경우(COP 2026-11-18 OOMKilled)를 더 나쁘게 한다
CUT_TAG = "[AAS-TREE-CUT]"
_CUT_FIX = ("많은 폴더가 의존성·백업 폴더면 서버의 AAS_TREE_SKIP_DIRS_EXTRA 에 그 이름을 더하세요(스킬 이름은 넣지 않음). "  # i18n-ignore: 로그
            "그래도 끊기면 사이드카의 AAS_SIDECAR_MAX_ENTRIES(기본 50000)를 올리세요(사이드카 메모리가 늘어남)")  # i18n-ignore: 로그
_STRUCT_NAMES = frozenset({"profiles", "skills", "plugins"})


def _extra_note() -> str:
    import os
    extra = _extra_skip_dirs(os.environ)
    return "EXTRA=" + (",".join(extra) if extra else "(비움)")  # i18n-ignore: 로그


def _clean_name(name: str) -> str:
    """로그에 찍는 사용자 폴더 이름: 제어 문자를 빼고 64자로 자른다(로그 줄 꾸밈 방지)."""
    return "".join(ch for ch in name if ch.isprintable())[:64]


def _top_folder_names(entries, limit: int = 3) -> list[tuple[str, int]]:
    """받은 항목을 부모 경로 조각 이름별로 세어 많은 순 limit 개. 항목 자신의 이름(파일 이름)은 세지 않는다.
    어느 항목에나 붙는 구조 이름(profiles·skills·plugins, 프로파일 이름, 스킬 카테고리)은 뺀다. 하나를 고르면 그 이름이 경로에 든
    항목(그 폴더 안과 그 폴더를 품은 위 폴더 몫)을 빼고 다시 세어, 같은 줄기(.deps 와 그 안 googleapiclient, .deps 를 가진 스킬
    폴더)가 자리를 채우지 않게 한다. 같은 수면 이름순. 스펙 2026-11-18-018 R5."""
    from collections import Counter
    paths = []
    for e in entries:
        parts = str(e.get("path") or "").split("/")[:-1]
        names = {part for i, part in enumerate(parts)
                 if part not in _STRUCT_NAMES and not (i and parts[i - 1] in ("profiles", "skills"))}
        if names:
            paths.append(names)
    picked: list[tuple[str, int]] = []
    for _ in range(limit):
        counts: Counter = Counter()
        for names in paths:
            counts.update(names)
        if not counts:
            break
        name, n = min(counts.items(), key=lambda kv: (-kv[1], kv[0]))
        picked.append((name, n))
        paths = [names for names in paths if name not in names]
    return [(_clean_name(n), c) for n, c in picked]
# 게이트웨이가 수시로 고쳐 쓰는 상태 파일 두 개는 내용을 묶음에 넣지 않는다 — 읽을 때마다 사이드카에서 새로 받는다.
# 묶음(60초)의 내용으로 답하면 MCP 로그인 뒤 게이트웨이가 붙은 것을 60초 늦게 보고, 로그인 직후의 유예가 끝나 「확인 전」이 된다
# (OKE 2026-10-17, 스펙 2026-10-16-010 14-15). 둘 다 작은 파일이라 왕복 한 번이다.
# 묶음은 있음·없음도 들고 있으므로 내용만 빼서는 모자란다: 새 파드는 MCP 서버를 처음 더할 때 상태 파일이 생기는데, 묶음이 「없음」을
# 들고 있으면 60초 동안 없다고 답했다(14-17). 그래서 stat·read 도 이 이름은 묶음을 거치지 않는다(LIVE_FILES).
# gateway-starts.log 는 게이트웨이가 시작할 때마다 한 줄 쓴다. 바깥 다시 시작 판별(스펙 2026-11-18-016 4-3)이 마지막 시각을 읽으므로
# 묶음이 들고 있는 있음·없음으로 답하지 않는다
LIVE_FILES = frozenset({"aas-mcp-status.json", "gateway_state.json", "gateway-starts.log"})
TREE_NO_CONTENT = [".db", ".db-wal", ".db-shm", ".sqlite", ".sqlite3", ".log", ".jsonl", ".gz", ".zip", ".tar", ".png", ".jpg", ".jpeg", ".gif", ".pdf", ".so", ".whl",
                   *sorted(LIVE_FILES)]
TREE_MAX_FILE = 262_144
# 묶음은 목록만 받고(내용 없이) 지난 묶음과 견줘 바뀐 파일만 read 로 받는다. 한 번에 이 바이트까지 묶어 읽는다 — 사이드카 read 상한
# (8MB)보다 작고 느린 노드(worker-5, 약 0.65MB/s)에서도 기본 한도 10초 안에 든다(스펙 2026-10-24-013 R1·R3·Q4)
READ_CHUNK = 4_000_000
FILL_ROUNDS = 3          # 빠진 내용 채우기 최대 바퀴(한 바퀴에 더 줄지 않으면 그 전에 멈춘다, §5-0-7)
MEMO_MAX_AGE = 300.0        # 지문이 같아 다음 묶음으로 넘겨받는 무거운 결과(memo)의 최대 나이. 지문이 못 보는 바깥 상태가 묵지 않게(외부 검토 OV3)
# Hermes 가 몇 초마다 고쳐 쓰는 상태 파일. 있음·없음만 지문에 넣는다 — 크기·시각까지 넣으면 지문이 늘 바뀌어 무거운 결과를
# 매번 다시 만들었다(스펙 2026-10-24-013 P1·R2, Q3)
VOLATILE_NAMES = frozenset({"ticker_heartbeat", "ticker_last_success", "gateway.heartbeat", *LIVE_FILES})
# 묶음(tree)만 쓰는 시간 한도(초). 묶음은 수 MB 라 느린 노드에서 다른 연산의 한도(10초)를 넘는다. OKE worker-5 의 에이전트는 7.6MB 에
# 11초가 걸려 매번 끊겼고, 끊기면 30초 동안 하나씩 묻기로 떨어져 사이드카를 초당 75번 불렀다(스펙 2026-10-24-012)
TREE_TIMEOUT = 60.0
# 가벼운 연산(stat·list·read 등)의 기본 한도(초). 묶음 조각 읽기도 예전에는 이 한도였다
LIGHT_TIMEOUT = 10.0
# 묶음 잠금 안 작업 전체(변경분·목록·내용 조각)의 마감(초, 잠금을 잡은 때부터). 예전에는 변경분 60초 실패 뒤 목록 60초, 조각마다 10초라
# 최악 약 160초 동안 잠금을 쥐었다(스펙 2026-11-20-001 §5-8, Eng 재검토 H4). 목록 전체 받기만 남은 시간이 모자라도 LIGHT_TIMEOUT 은 준다 —
# 목록까지 못 받으면 묶음이 통째로 없어 화면이 파일마다 사이드카를 부른다
LOCK_BUDGET = TREE_TIMEOUT
_STARTED = time.monotonic()                     # 이 프로세스가 뜬 때 — 묶음 받기 로그의 「뜬뒤」(배포 직후 경우를 가른다)
# 묶음 잠금을 이만큼 넘게 기다렸거나 묶음 받기가 이만큼 넘게 걸리면 로그 한 줄(스펙 2026-11-20-001 A7). 같은 에이전트·같은 종류는
# SLOW_LOG_EVERY 초에 한 줄 — 배포 직후 줄 선 요청마다 찍히지 않게. 화면 지연이 묶음 잠금 탓인지 OKE 로그로 가르려는 것이다
SLOW_LOG, SLOW_LOG_EVERY = 2.0, 60.0
# 이 맥락에서는 연달아 읽어도 묶음을 받으러 가지 않는다 — 신선한 묶음이 있으면 쓰고, 없으면 하나씩 묻는다. 지난 값을 쓸 수 없어
# 요청 스레드에서 다시 만드는 작은 읽기(받은편지함 MCP 로그인 항목)가 만료된 묶음 받기(10~13초)를 기다리지 않게(스펙 2026-11-20-001 2단계)
_NO_BUNDLE: contextvars.ContextVar[bool] = contextvars.ContextVar("aas_remote_no_bundle", default=False)
# 묶음 내용 조각 읽기는 시간 초과여도 「응답 없음」 기억을 켜지 않는다. 파일 하나짜리 조각은 `_batch_read` 예외에 들지 않아, 켜지면
# 남은 조각과 그 뒤 30초의 다른 읽기가 바로 실패했다(스펙 2026-11-20-001 §5-8)
_NO_DOWN: contextvars.ContextVar[bool] = contextvars.ContextVar("aas_remote_no_down", default=False)


@contextlib.contextmanager
def no_bundle():
    token = _NO_BUNDLE.set(True)
    try:
        yield
    finally:
        _NO_BUNDLE.reset(token)


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

    def descendants(self, rel: str, recursive: bool, skip: frozenset = frozenset(), skipped: set | None = None) -> list[str] | None:
        """rel 아래 항목들. 안을 보지 않은 폴더가 걸리면 None(사이드카에 묻는다).
        skip 이름의 항목(폴더면 그 안까지)은 결과에서 빼므로, 안을 보지 않은 폴더여도 사이드카에 묻지 않는다(스펙 2026-11-03-003 D11).
        로컬 `search_rglob` 과 같은 규칙이다: 경로 조각 하나라도 skip 에 있으면 뺀다. skipped 를 주면 뺀 항목의 경로를 담는다
        (스킬 덮기 판정이 깊은 .deps 를 알아야 한다, 스펙 2026-11-18-018 R6)."""
        if rel in self.partial or not self.covers(rel) or rel not in self.children:
            return None
        out, stack = [], [rel]
        while stack:
            cur = stack.pop()
            for child in self.children.get(cur, []):
                if skip and posixpath.basename(child) in skip:
                    if skipped is not None:
                        skipped.add(child)
                    continue
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
    status = 0                                                # 사이드카가 돌려준 HTTP 상태(답이 없었으면 0)


# 원격 sqlite 의 실패 종류. 모두 sqlite3.OperationalError 의 하위 종류라 except sqlite3.Error 로 받던 호출부는 그대로 동작하고,
# 사용 집계처럼 실패마다 다르게 할 호출부는 문장 비교 없이 가른다(스펙 2026-11-19-005 U1)
class SqlTruncated(sqlite3.OperationalError):
    """결과가 행 상한이나 바이트 상한을 넘어 잘렸다. 범위를 줄여 다시 물으면 된다."""


class SqlTimeout(sqlite3.OperationalError):
    """사이드카의 SQL 시간 한도(408)나 소켓 한도를 넘었다."""


class SqlBusy(sqlite3.OperationalError):
    """DB 가 잠겨 지금 읽을 수 없다(사이드카 503)."""


# 시간 초과가 나면 「응답 없음」으로 기억하는 가벼운 연산(스펙 2026-10-24-002 R4·검토 D4). tree·scan 은 데이터가 커서
# 사이드카가 멀쩡해도 늦을 수 있고, tree 가 실패하면 하나씩 묻는 길로 넘어가므로 그 길을 막지 않는다
LIGHT_OPS = {"/v1/version", "/v1/stat", "/v1/list", "/v1/read", "/v1/sqlite", "/v1/sqlite_batch", "/v1/check"}


def _batch_read(path: str, body: dict | None) -> bool:
    """여러 파일을 묶은 read. 합계가 256KB 를 넘으면 사이드카에서 tree 와 같은 무거운 잠금 뒤에 줄 서므로(R20), 늦어도 사이드카가
    죽은 것이 아니다 — 「응답 없음」 기억을 켜지 않는다(스펙 2026-10-24-002 외부 검토 4)."""
    return path == "/v1/read" and len((body or {}).get("paths") or ()) > 1


def _long_sql(path: str, body: dict | None) -> bool:
    """시간 한도를 늘려 물은 sqlite(사용 집계의 긴 읽기). 늦어도 사이드카가 죽은 것이 아니다 — 「응답 없음」 기억을 켜지 않는다
    (스펙 2026-11-19-005 U1, _batch_read 와 같은 예외)."""
    return path == "/v1/sqlite" and bool((body or {}).get("max_seconds"))


class RemoteBackend:
    def __init__(self, url: str, token: str | Callable[[], str], *, timeout: float = LIGHT_TIMEOUT, label: str = "", fail_memo: float = 30.0):
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
        # 묶음이 사이드카 항목 상한에서 잘린 시각. 잘린 목록은 쓸 수 없고 다시 받아도 잘리므로 TRUNCATED_MEMO 동안 받지 않는다.
        # 기억하지 않으면 연달아 읽을 때마다 4 MB 를 다시 받았다(GitHub #1: 5분에 /v1/tree 512번, 스펙 2026-11-03-003 R3·D6)
        self._tree_truncated_at = 0.0
        self._truncated_warned = False
        self._cut_warned = False
        self._has_changes: bool | None = None               # 옛 사이드카(1.4 까지)에는 changes 가 없다(R10)
        self._conns: "weakref.WeakSet" = weakref.WeakSet()  # 스레드마다 연 연결 — 묶음을 버릴 때 함께 닫는다(외부 검토 OV10)
        self._fetch_note = ""                               # 마지막 묶음 받기의 까닭·걸린 시간 — 잠금을 기다린 요청의 로그에 붙인다(A7)
        self._slow_logged: dict[str, float] = {}           # 느림 로그 종류마다 마지막으로 남긴 시각(A7)
        # 경우를 가르는 값(스펙 2026-11-20-001 §5-0 0-1): 마지막으로 버린 때와 종류(idle·cap·manual), 마지막 받기의 커서 reset·빠진 내용 수,
        # 잠금 대기 계수기 [횟수, 합, 최대] — 대기 줄은 60초에 한 줄이라 줄 선 요청 수를 셀 수 없었다
        self._dropped_at = 0.0
        self._drop_kind = ""
        self._last_reset = False
        self._missing = 0
        self._waits = [0, 0.0, 0.0]
        self._filling = False                              # 빠진 내용 채우기 스레드가 도는 중(하나만, §5-0-7)

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
                if (exc.timed_out and path in LIGHT_OPS and not _batch_read(path, body) and not _long_sql(path, body)
                        and not _NO_DOWN.get()):
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
            err = SidecarError(tr(f"사이드카 오류 HTTP {status}: {detail}", f"Sidecar error HTTP {status}: {detail}"))
            err.status = status
            raise err
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

    def drop(self, kind: str = "manual") -> None:
        """묶음을 버리고 이 백엔드의 사이드카 연결을 닫는다(최근 사용 순 정리, R8). 다음에 쓰면 처음부터 다시 받는다.
        kind 는 버린 까닭(`idle` 10분 정리·`cap` 메모리 상한·`manual`) — 다음 받기 로그가 오래 비움과 배포 직후를 가른다."""
        with self._lock:
            self._stats.clear()
            self._tree = self._last_tree = None
            self._dropped_at, self._drop_kind = time.monotonic(), kind
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
        if self._truncated_recently():
            return False
        asked = time.monotonic()
        with self._tree_lock:
            waited = time.monotonic() - asked
            self._note_wait(waited)
            if waited > SLOW_LOG:
                self._slow_log("wait", f"묶음 잠금 대기 {self.label} {waited:.1f}초 앞 받기={self._fetch_note or '-'} "   # i18n-ignore: 로그
                                       f"스레드={threading.current_thread().name}")
            if self._tree_failed_at and time.monotonic() - self._tree_failed_at < self.fail_memo:
                return False                                  # 잠금을 기다리는 동안 앞 스레드가 실패했다
            if self._truncated_recently():
                return False
            tree = self._tree
            if tree is not None and time.monotonic() - tree.taken < max_age:
                return True
            base = tree or self._last_tree
            reason = "처음" if base is None else ("고친뒤" if base.memo_stale else "만료")   # i18n-ignore: 로그
            started = time.monotonic()
            try:
                ok, cut = self._fetch_locked(base, started + LOCK_BUDGET)
            finally:
                self._note_fetch(reason, time.monotonic() - started)
        if cut is not None:
            self._warn_cut(cut)                           # 이름 세기(5만 개)는 묶음 잠금 밖에서(스펙 2026-11-18-018 R5)
        if ok and not tree_cache.HUMAN.get():
            # 배경 작업이 받은 묶음도 버리기 시간만큼 남긴다. 예전에는 「사용」이 아니라 다음 정리 바퀴에 버려, 사람이 보지 않는 에이전트를
            # 배경 작업이 5분마다 처음부터 다시 받았다(서버 한 대 1시간 약 2,000초, 스펙 2026-11-20-001 §5-0-7, 사용자 결정 — OV4 를 바꿈).
            # 사람 사용(_used)은 그대로라 상한을 넘으면 사람이 안 쓴 묶음부터 버린다
            tree_cache.grace(self.label, time.monotonic() + tree_cache.idle_drop())
        if ok and self._missing:
            self._start_fill()                            # 마감·조각 실패로 빠진 내용은 뒤에서 채운다(§5-0-7)
        return ok

    def _start_fill(self) -> None:
        """빠진 내용 채우기 스레드를 하나 띄운다(이미 돌면 그대로). 배경 스레드라 사람 사용(HUMAN)으로 세지 않는다."""
        with self._lock:
            if self._filling:
                return
            self._filling = True
        threading.Thread(target=self._fill_loop, daemon=True, name="aas-tree-fill").start()

    def _fill_loop(self) -> None:
        """빠진 내용이 없어지거나, 한 바퀴에 더 줄지 않거나, FILL_ROUNDS 바퀴가 지나면 멈춘다."""
        try:
            for _ in range(FILL_ROUNDS):
                before = self._missing
                left = self._fill_missing()
                if left == 0 or left >= before:
                    break
        finally:
            with self._lock:
                self._filling = False

    def _fill_missing(self) -> int:
        """지금 묶음에서 내용이 빠진 파일만 조각으로 읽어 그 묶음에 넣는다. 남은 빠진 수를 돌려준다.
        처음 받기가 60초 마감(LOCK_BUDGET)에 닿으면 큰 에이전트는 파일 155~299 개의 내용이 빠졌고(OKE 2026-11-20), 빠진 파일은 읽을 때마다
        사이드카에 하나씩 물었다. 묶음 잠금을 쥐고 새 마감으로 읽는다 — 그동안 같은 에이전트의 묶음 받기는 기다린다(빠진 파일만이라 짧다)."""
        started = time.monotonic()
        with self._tree_lock:
            tree = self._tree
            if tree is None:
                return 0
            ask = []
            for path, e in tree.entries.items():
                item = {"path": path, **e}
                if path not in tree.data and _wants_content(item):
                    ask.append(item)
            if not ask:
                self._missing = 0
                return 0
            data, missing = self._read_chunks(ask, time.monotonic() + LOCK_BUDGET)
            tree.data.update(data)                        # dict 갱신 — 읽는 쪽은 잠금 없이 tree.data 를 보지만 키 하나씩 들어가므로 안전하다
            self._missing = missing
        print(f"묶음 내용 채움 {self.label} {len(data)}개 남음 {missing} {time.monotonic() - started:.1f}초", flush=True)   # i18n-ignore: 로그
        return missing

    def _fetch_locked(self, base: "_Tree | None", deadline: float | None = None) -> "tuple[bool, dict | None]":
        """_tree_lock 을 쥔 채로 부른다. 변경분, 안 되면 목록 전체를 받아 묶음을 바꾼다. (받았는지, 잠금 밖에서 남길 cut 경고).
        deadline 은 잠금 안 작업 전체의 마감(monotonic) — 변경분·목록·내용 조각이 남은 시간을 나눠 쓴다(§5-8)."""
        deadline = time.monotonic() + LOCK_BUDGET if deadline is None else deadline
        self._last_reset, self._missing = False, 0
        merged = self._changes_since(base, deadline)
        if self._truncated_recently():
            return False, None                            # 변경분이 잘렸다(R7) — 목록 전체도 잘리므로 받지 않는다
        if merged is not None:
            self._has_tree = True
            self._tree = self._build_tree(merged, base, deadline)
            self._last_tree = None
            self._tree_failed_at = 0.0
            return True, None
        try:
            limit = min(TREE_TIMEOUT, max(LIGHT_TIMEOUT, deadline - time.monotonic()))
            listing = self._call("POST", "/v1/tree", self._listing_body(), timeout=limit)
        except FileNotFoundError:
            self._has_tree = False                    # 옛 사이드카: 없는 경로(404)
            return False, None
        except (OSError, ValueError, KeyError):
            self._tree_failed_at = time.monotonic()
            return False, None                        # 묶음을 못 받아도 수집은 하나씩 묻는 길로 이어 간다
        if listing.get("truncated"):
            self._mark_truncated(listing.get("entry_count") or len(listing.get("entries") or ()))
            return False, None
        cut = listing if listing.get("cut") and not self._cut_warned else None
        self._has_tree = True
        self._tree = self._build_tree(listing, base, deadline)
        self._last_tree = None                        # 견주기가 끝났다 — 에이전트마다 묶음 하나만 둔다
        self._tree_failed_at = 0.0
        self._tree_truncated_at = 0.0
        return True, cut

    def _note_fetch(self, reason: str, secs: float) -> None:
        """묶음 받기 한 번을 적어 둔다. 오래 걸렸으면 로그 한 줄 — 받은 요청 자신도 그동안 멈췄다(A7).
        경우를 가르는 값을 붙인다(§5-0 0-1): 프로세스가 뜬 뒤 초(배포 직후), 마지막으로 버린 뒤 초와 종류(오래 비움), 커서 reset
        (사이드카 재시작), 빠진 내용 수(마감·조각 실패로 내용이 빈 경우)."""
        self._fetch_note = f"{reason} {secs:.1f}초"   # i18n-ignore: 로그
        if secs > SLOW_LOG:
            now = time.monotonic()
            extra = f" 뜬뒤={now - _STARTED:.0f}초"   # i18n-ignore: 로그
            if self._dropped_at:
                extra += f" 버린뒤={now - self._dropped_at:.0f}초({self._drop_kind})"   # i18n-ignore: 로그
            if self._last_reset:
                extra += " reset"
            if self._missing:
                extra += f" 빠진내용={self._missing}"   # i18n-ignore: 로그
            # 사람= 은 받은 스레드의 「사람의 요청」 표시다. map_pods 일꾼은 사람 요청도 배경 작업도 aas-pods_* 라 스레드 이름으로는 못 가른다.
            # 사람 요청이 잠금을 기다리는 사이 배경 작업이 받으면 False 로 찍히므로 「사람이 봤나」의 판정에는 쓰지 않는다(스펙 2026-11-20-006)
            extra += f" 사람={tree_cache.HUMAN.get()}"   # i18n-ignore: 로그
            self._slow_log("fetch", f"묶음 받기 느림 {self.label} {secs:.1f}초 까닭={reason} "   # i18n-ignore: 로그
                                    f"스레드={threading.current_thread().name}{extra}")

    def _note_wait(self, secs: float) -> None:
        """묶음 잠금을 SLOW_LOG 넘게 기다린 요청을 센다. `flush_waits` 가 5분마다 한 줄로 남긴다."""
        if secs <= SLOW_LOG:
            return
        with self._lock:
            w = self._waits
            w[0] += 1
            w[1] += secs
            w[2] = max(w[2], secs)

    def flush_waits(self) -> None:
        """센 잠금 대기를 한 줄로 남기고 비운다(서버의 5분 정리 바퀴가 부른다). 센 것이 없으면 아무것도 하지 않는다."""
        with self._lock:
            n, total, worst = self._waits
            self._waits = [0, 0.0, 0.0]
        if n:
            print(f"묶음 잠금 대기 합계 {self.label} {n}번 합 {total:.1f}초 최대 {worst:.1f}초", flush=True)   # i18n-ignore: 로그

    def _slow_log(self, kind: str, line: str) -> None:
        now = time.monotonic()
        with self._lock:
            if now - self._slow_logged.get(kind, float("-inf")) < SLOW_LOG_EVERY:
                return
            self._slow_logged[kind] = now
        print(line, flush=True)

    def _truncated_recently(self) -> bool:
        return bool(self._tree_truncated_at) and time.monotonic() - self._tree_truncated_at < TRUNCATED_MEMO

    def _mark_truncated(self, count: int) -> None:
        """묶음이 사이드카 항목 상한에서 잘렸다. TRUNCATED_MEMO 동안 다시 받지 않고, 원인과 고칠 길을 에이전트마다 한 번 남긴다."""
        self._tree_truncated_at = time.monotonic()
        if not self._truncated_warned:
            self._truncated_warned = True
            print(f"{CUT_TAG} 사이드카 묶음이 항목 상한에서 잘렸습니다({self.label}, 받은 항목 {count}개, {_extra_note()}). "   # i18n-ignore: 로그
                  f"{TRUNCATED_MEMO:.0f}초 동안 묶음 없이 파일마다 묻습니다. {_CUT_FIX}", flush=True)

    def _warn_cut(self, listing: dict) -> None:
        """사이드카가 상한에서 폴더 몇 개를 끊고 나머지를 보냈다(후속 F1, 2026-11-03 판부터). 묶음은 그대로 쓰고, 끊긴 폴더 안만
        파일마다 묻는다 — 잘림 기억(TRUNCATED_MEMO)은 두지 않는다. 원인과 고칠 길을 에이전트마다 한 번 남긴다.
        받은 항목을 이름별로 세어 많은 폴더 이름을 붙인다 — 끊긴 폴더(partial)는 이름순이라 원인이 아니다(스펙 2026-11-18-018 R5)."""
        if self._cut_warned:
            return
        self._cut_warned = True
        entries = (listing or {}).get("entries") or []
        top = " · ".join(f"{n} {c}" for n, c in _top_folder_names(entries))
        names = f", 받은 항목 기준 많은 폴더 이름: {top}" if top else ""  # i18n-ignore: 로그
        print(f"{CUT_TAG} 사이드카가 항목 상한에서 폴더 일부를 끊었습니다({self.label}, 받은 항목 {len(entries)}개{names}, "   # i18n-ignore: 로그
              f"{_extra_note()}). 끊긴 폴더 안은 파일마다 묻습니다. {_CUT_FIX}", flush=True)

    def _listing_body(self) -> dict:
        # "" 는 모든 파일 — 목록만. hashes·cursor 는 사이드카 1.5 부터(파일 해시·변경 커서, R7·R10). 옛 사이드카는 모르는 키를 무시한다
        return {"path": "", "skip_dirs": tree_skip_dirs(), "no_content": [""], "max_file": TREE_MAX_FILE,
                "hashes": TREE_NO_CONTENT, "cursor": True}

    def _changes_since(self, base: "_Tree | None", deadline: float | None = None) -> dict | None:
        """지난 묶음의 커서 뒤에 바뀐 것만 받아 목록을 맞춘다(R10). 쓸 수 없으면(커서 없음·옛 사이드카·reset·실패) None —
        부른 쪽이 목록 전체를 받는다."""
        if base is None or not base.cursor or self._has_changes is False:
            return None
        body = {"since": base.cursor, "path": "", "skip_dirs": tree_skip_dirs(), "max_file": TREE_MAX_FILE, "hashes": TREE_NO_CONTENT,
                "fresh": base.memo_stale}                     # AAS 가 고친 직후 — 사이드카의 2초 재사용 없이 다시 훑게
        try:
            left = TREE_TIMEOUT if deadline is None else deadline - time.monotonic()
            if left <= 0:
                return None
            out = self._call("POST", "/v1/changes", body, timeout=min(TREE_TIMEOUT, left))
        except FileNotFoundError:
            self._has_changes = False
            return None
        except (OSError, ValueError, KeyError):
            return None
        self._has_changes = True
        if out.get("truncated"):
            # 폴더가 커서 뒤 상한을 넘었다(truncated 를 아는 사이드카, 2026-11-03 판부터). 잘린 나머지를 「없어짐」으로 맞추면 있는 파일을 없다고 답한다(R7·D12)
            self._mark_truncated(len(base.entries))
            return None
        if out.get("reset"):
            self._last_reset = True                       # 사이드카가 다시 떴거나 기록이 넘쳤다 — 목록 전체를 받는다(로그에 남김)
            return None
        entries = {p: {"path": p, **e} for p, e in base.entries.items()}
        for p in out.get("removed", []):
            entries.pop(p, None)
        for e in out.get("entries", []):
            entries[e["path"]] = e
        return {"entries": list(entries.values()), "partial": out.get("partial", list(base.partial)), "cursor": out.get("cursor")}

    def _read_chunks(self, ask: list[dict], deadline: float) -> "tuple[dict, int]":
        """ask 의 파일 내용을 READ_CHUNK 씩 나눠 읽는다. (경로 → 내용, 빠진 수). 한 조각이 실패해도 다음 조각을 읽고, 조각 한도는
        min(TREE_TIMEOUT, 남은 마감), 마감이 지나거나 시간 초과 두 번·다른 실패 세 번이면 남은 조각을 건너뛴다(§5-8)."""
        data: dict = {}
        chunks, chunk, size = [], [], 0
        for e in ask:
            if chunk and size + e["size"] > READ_CHUNK:
                chunks.append(chunk)
                chunk, size = [], 0
            chunk.append(e["path"])
            size += e["size"]
        if chunk:
            chunks.append(chunk)
        timeouts = others = 0
        missing = 0
        for chunk in chunks:
            left = deadline - time.monotonic()
            if left <= 0 or timeouts >= 2 or others >= 3:
                missing += len(chunk)
                continue
            token = _NO_DOWN.set(True)
            try:
                files = self._call("POST", "/v1/read", {"paths": chunk}, timeout=min(TREE_TIMEOUT, left))["files"]
            except SidecarError as exc:
                if exc.timed_out:
                    timeouts += 1
                else:
                    others += 1
                missing += len(chunk)
                continue
            except (OSError, ValueError, KeyError):
                others += 1
                missing += len(chunk)
                continue
            finally:
                _NO_DOWN.reset(token)
            got = 0
            for f in secret_scrub.scrub_files(files):
                if f.get("ok") and "data_b64" in f:
                    raw = base64.b64decode(f["data_b64"])
                    # 자격증명 파일(원문을 토큰으로 바꾼 것)은 서버 전체 한 벌 저장소에 넣지 않는다(리뷰 A1)
                    data[f["path"]] = tree_cache.private(raw) if secret_scrub.is_credential(f["path"]) else tree_cache.intern(raw)
                    got += 1
            missing += len(chunk) - got
        return data, missing

    def _build_tree(self, listing: dict, base: "_Tree | None", deadline: float | None = None) -> "_Tree":
        """목록과 지난 묶음을 견줘 크기·시각이 같은 파일은 내용을 넘겨받고, 새로 생기거나 바뀐 파일만 READ_CHUNK 씩 나눠 읽는다.
        한 조각이 실패해도 다음 조각을 읽는다 — 빠진 파일은 읽을 때 사이드카에 묻는다(외부 검토 OV7). 예전에는 첫 조각이 실패하면
        남은 조각을 읽지 않아(break) OKE 에서 묶음 내용이 통째로 비었다(fea7 0/1293, 스펙 2026-11-20-001 §5-8).
        조각마다 한도는 min(TREE_TIMEOUT, 남은 마감), 마감이 지나거나 시간 초과 두 번·다른 실패 세 번이면 남은 조각은 건너뛴다."""
        entries, partial = listing["entries"], listing.get("partial", [])
        deadline = time.monotonic() + LOCK_BUDGET if deadline is None else deadline
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
        got, missing = self._read_chunks(ask, deadline)
        data.update(got)
        self._missing = missing
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
        if self._truncated_recently():
            return None                                       # 잘린 묶음을 기억하는 동안 4 MB 목록을 다시 받지 않는다(R3)
        try:
            listing = self._call("POST", "/v1/tree", self._listing_body(), timeout=TREE_TIMEOUT)
        except (OSError, ValueError, KeyError):
            return None
        if listing.get("truncated"):
            self._mark_truncated(listing.get("entry_count") or len(listing.get("entries") or ()))
            return None
        if "entries" not in listing:
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
        if self._has_tree is False or _NO_BUNDLE.get():
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

    def list(self, rel: str, pattern: str, skip: frozenset = frozenset(), skipped: set | None = None, *,
             skipped_probe: bool = True, incomplete: list | None = None, fallback_skip: frozenset | None = None) -> list[dict]:
        """skip: 결과에서 빼고 들어가지 않을 폴더 이름(찾기·집계용, 스펙 2026-11-03-003 D11). 묶음이 있으면 그 이름의 폴더는
        안을 보지 않았어도 사이드카에 묻지 않는다. 사이드카에 물을 때는 skip_dirs 를 싣고, 그 키를 모르는 옛 사이드카가 무시해도 같게 받은 결과를 거른다.
        묶음이 답하지 못해 사이드카에 물을 때(대체 길, 스펙 2026-11-18-019 R7):
        - skipped_probe=False 면 건너뛴 이름을 찾으려고 폴더마다 다시 묻지 않는다(스킬 묶음은 클릭 한 번에 수백 번이 될 수 있다).
        - incomplete 를 주면 대체 길로 간 rel 을 담는다 — skipped 가 덜 찼다는 표지를 skipped 에 섞지 않는다.
        - fallback_skip 을 주면 사이드카에는 skip 대신 이것을 싣고 거른다(스킬 묶음이 깊이 규칙을 직접 적용할 이름을 빼고 묻는다)."""
        tree = self._fresh_tree()
        pat = [p for p in pattern.split("/") if p] if pattern else []
        # 끝이 ** 인 패턴은 파이썬 판마다 뜻이 달라(3.13 부터 파일도 낸다) 사이드카에 그대로 묻는다
        if tree is not None and pat and pat[-1] != "**" and not pattern.startswith("/") and ".." not in pat:
            found = tree.descendants(rel, recursive=len(pat) > 1 or "**" in pat, skip=skip, skipped=skipped)
            if found is not None:
                if rel and rel not in tree.entries:
                    raise FileNotFoundError(rel)
                base = len(rel) + 1 if rel else 0
                hits = sorted(p for p in found if _match(p[base:].split("/"), pat))
                return [{"path": p, **{k: tree.entries[p][k] for k in ("type", "size", "mtime", "mode")}} for p in hits]
        if incomplete is not None:
            incomplete.append(rel)
        skip = skip if fallback_skip is None else fallback_skip
        body = {"path": rel, "pattern": pattern, **({"skip_dirs": sorted(skip)} if skip else {})}
        out = self._call("POST", "/v1/list", body)
        entries = out["entries"]
        if skip:
            base = len(rel) + 1 if rel else 0
            entries = [e for e in entries if not skip.intersection(e["path"][base:].split("/"))]
            if skipped is not None and skipped_probe:                   # 사이드카는 skip 폴더를 내지 않는다 — 폴더마다 얕게 물어 건너뛴 이름을 찾는다
                for d in [rel] + [e["path"] for e in entries if e.get("type") == "dir"]:
                    for e in self._call("POST", "/v1/list", {"path": d, "pattern": "*"}).get("entries") or ():
                        if posixpath.basename(e["path"]) in skip:
                            skipped.add(e["path"])
        now = time.monotonic()
        with self._lock:                              # 목록이 준 종류·크기를 stat 캐시에 넣어 is_file() 왕복을 없앤다
            for e in entries:
                self._stats[e["path"]] = (now, {"exists": True, "type": e["type"], "size": e["size"], "mtime": e["mtime"],
                                                "mode": e.get("mode", 0)})
        return entries

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

    def sqlite(self, rel: str, sql: str, params: list, max_seconds: float | None = None, max_bytes: int | None = None) -> dict:
        """max_seconds·max_bytes 는 사이드카가 그 질의에 쓸 한도다(옛 사이드카는 모르는 키라 무시한다). 시간 한도를 늘리면
        소켓도 그만큼(+5초) 기다린다(스펙 2026-11-19-005 U1)."""
        body = {"path": rel, "sql": sql, "params": params}
        if max_seconds:
            body["max_seconds"] = max_seconds
        if max_bytes:
            body["max_bytes"] = max_bytes
        if max_seconds:
            return self._call("POST", "/v1/sqlite", body, max_seconds + 5)
        return self._call("POST", "/v1/sqlite", body)

    def has_sql_limits(self) -> bool:
        """사이드카가 sqlite 의 요청별 시간·바이트 한도를 아는가. 모르면(옛 판) 부른 쪽이 행 수를 낮춰 묻는다."""
        known = getattr(self, "_has_sql_limits", None)       # has_file_ops 와 같이 — 아는 것은 계속, 모르는 것은 60초 동안 기억
        if known and (known[0] or time.monotonic() - known[1] < 60):
            return known[0]
        try:
            ok = "sqlite_limits" in (self.version().get("ops") or [])
        except (OSError, ValueError):
            ok = False
        self._has_sql_limits = (ok, time.monotonic())
        return ok

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

    def _list(self, pattern: str, skip: frozenset = frozenset(), skipped: set | None = None, **opts) -> list["RemotePath"]:
        if self._outside:
            raise PermissionError(tr("root 밖입니다", "Outside the root"))
        return [RemotePath(self._b, e["path"]) for e in self._b.list(self._rel, pattern, skip, skipped, **opts)]

    def iterdir(self):
        return iter(self._list("*"))

    def glob(self, pattern: str, skip: frozenset = frozenset(), skipped: set | None = None, **opts):
        try:
            return iter(self._list(pattern, skip, skipped, **opts))
        except FileNotFoundError:
            return iter(())                            # pathlib 처럼 없는 폴더의 glob 은 빈 결과

    def rglob(self, pattern: str, skip: frozenset = frozenset(), skipped: set | None = None, **opts):
        return self.glob("**/" + pattern, skip, skipped, **opts)


def search_rglob(path, pattern: str, skip: frozenset | None = None, skipped: set | None = None, **opts):
    """찾기·집계용 재귀 목록: `path.rglob(pattern)` 에서 skip 이름의 폴더(기본 `search_skip_dirs()`)와 그 안을 뺀다.
    로컬 Path 와 RemotePath 가 같은 결과를 낸다(스펙 2026-11-03-003 D11·D9). 원격이면 그 폴더 안을 사이드카에 묻지 않는다.
    모든 파일이 필요한 호출(라이브러리 목록·Hermes 와 같은 해시)은 이것을 쓰지 않는다.
    skipped 를 주면 건너뛴 폴더의 path 기준 상대 경로("a/.deps")를 담는다(스펙 2026-11-18-018 R6, 로컬·묶음·사이드카 같은 결과).
    opts(skipped_probe·incomplete·fallback_skip)는 원격 대체 길에만 쓴다 — `RemoteBackend.list` 참고(스펙 2026-11-18-019). 로컬은 무시한다."""
    skip = search_skip_dirs() if skip is None else frozenset(skip)
    if isinstance(path, RemotePath):
        found: set | None = set() if skipped is not None else None
        out = list(path.rglob(pattern, skip, found, **opts))
        if skipped is not None:
            base = len(path._rel) + 1 if path._rel else 0
            skipped.update(p[base:] for p in found or ())
        return out
    if skipped is None:
        return [p for p in path.rglob(pattern) if not skip.intersection(p.relative_to(path).parts)]
    out = []
    for p in path.rglob("*"):                          # 건너뛴 폴더를 찾으려면 패턴과 관계없이 모든 경로를 본다(로컬이라 싸다)
        parts = p.relative_to(path).parts
        hit = next((i for i, part in enumerate(parts) if part in skip), None)
        if hit is not None:
            skipped.add("/".join(parts[:hit + 1]))
    for p in path.rglob(pattern):
        if not skip.intersection(p.relative_to(path).parts):
            out.append(p)
    return out


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

    def execute(self, sql: str, params=(), *, max_seconds: float | None = None, max_bytes: int | None = None) -> RemoteCursor:
        try:
            if max_seconds or max_bytes:
                out = self._path.backend.sqlite(self._path.rel, sql, list(params), max_seconds=max_seconds, max_bytes=max_bytes)
            else:
                out = self._path.backend.sqlite(self._path.rel, sql, list(params))
        except PermissionError as exc:
            raise sqlite3.OperationalError(str(exc)) from None
        except FileNotFoundError:
            raise sqlite3.OperationalError("unable to open database file") from None
        except SidecarError as exc:
            if exc.timed_out or exc.status == 408:
                raise SqlTimeout(str(exc)) from None
            if exc.status == 503:
                raise SqlBusy(str(exc)) from None
            raise sqlite3.OperationalError(str(exc)) from None
        cols = tuple(out["columns"])
        rows = [RemoteRow(cols, [self._cell(c) for c in r]) for r in out["rows"]]
        if out.get("truncated"):
            raise SqlTruncated(tr("결과가 너무 많아 잘렸습니다", "Result truncated: too many rows"))
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
