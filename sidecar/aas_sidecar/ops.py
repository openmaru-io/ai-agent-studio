# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""읽기 사이드카의 연산 — stat / read / glob / tree / sqlite / version.

Hermes 데이터 폴더(root) 밖은 읽지 못한다. 쓰는 연산은 없다. 도메인 규칙(집계·분석·마스킹)은 여기에 없다 —
경로와 SQL 은 AAS 서버가 넘기고, 사이드카는 파일과 SQLite 를 읽어 그대로 돌려줄 뿐이다.
표준 라이브러리만 쓴다(사이드카는 AAS 와 따로 만들고 따로 올리는 작은 이미지다).
"""
from __future__ import annotations

import base64
import fnmatch
import hashlib
import os
import stat as _stat
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote

API = 1
# 사이드카 판은 AAS 판(이미지 태그, 예 1.0.5)과 같다. 이미지를 만들 때 AAS_VERSION 빌드 인자로 넣고, 없으면(소스로 바로 실행) "dev".
# 서버는 이 번호로 기능을 가리지 않는다 — version() 의 ops 목록·없는 경로(404)·모르는 키 무시로 판별한다(스펙 2026-11-03-003, 사용자 지시 2026-11-03).
# 기능 이력(예전 사이드카 자체 번호): 1.1.0 tree(폴더 전체를 한 번에), 1.2.0 tree 지문, 1.3.0 sqlite_batch, 1.3.1 Nagle 끔(OMAI-1102),
# 1.3.2 tree·read 한 번에 하나, 1.4.0 scan·check·download(대화 파일, OMAI-1153), 1.5.0 tree 파일 해시·커서와 changes(스펙 2026-10-24-013 R7·R10),
# (1.0.5 부터 AAS 판) 항목 상한 50,000·AAS_SIDECAR_MAX_ENTRIES, list 의 skip_dirs, 잘린 changes 는 reset, 해시 캐시 정리(스펙 2026-11-03-003), sqlite 를 mode=ro 먼저 열고 read_mode 를 알림(열기·IO 계열 오류만 immutable, 스펙 2026-11-03-001 R15)
VERSION = os.environ.get("AAS_SIDECAR_VERSION", "").strip() or "dev"

DEFAULT_MAX_FILE = 2_000_000          # 파일 하나
DEFAULT_MAX_TOTAL = 8_000_000         # 한 번의 read 요청 전체
DEFAULT_MAX_ENTRIES = 50_000          # 한 번의 glob·tree·scan 결과. 2만에서는 가상 환경이 큰 데이터 폴더의 묶음이 늘 잘렸다(GitHub #1, 스펙 2026-11-03-003 D10)
DEFAULT_MAX_ROWS = 20_000             # 한 번의 sqlite 결과
DEFAULT_SQL_SECONDS = 10.0
TREE_WORKERS = 16                     # tree 의 stat·해시를 동시에 하는 수. NFS 에서 하나씩은 stat 8.1ms, 16개씩은 0.66ms/항목(OKE 2026-11-03)
MAX_BATCH = 400                       # 한 번의 sqlite_batch 쿼리 수

_PRAGMAS_OK = {"table_info", "table_xinfo"}
_FUNCTIONS_DENIED = {"load_extension"}


# mode=ro 로 열거나 읽지 못했을 때 immutable 로 다시 여는 오류: 열기(CANTOPEN 14)·IO(IOERR 10)·읽기 전용(READONLY 8, 읽기 전용 폴더의
# -shm 은 READONLY_DIRECTORY). 기본 코드(하위 8비트)로 본다. 잠금(BUSY 5·LOCKED 6)·손상 등은 다시 열지 않는다(스펙 2026-11-03-002 D3·D9·D10).
_REOPEN_IMMUTABLE_CODES = {8, 10, 14}


def _open_or_io_error(exc: sqlite3.Error) -> bool:
    code = getattr(exc, "sqlite_errorcode", None)
    return isinstance(code, int) and (code & 0xFF) in _REOPEN_IMMUTABLE_CODES


class OpError(Exception):
    """요청을 처리하지 못한 이유. code 는 HTTP 상태로 쓴다. 메시지에 호스트 경로를 싣지 않는다."""

    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def max_entries_from_env(environ) -> int:
    """AAS_SIDECAR_MAX_ENTRIES — 한 번의 목록 상한. 비었거나 숫자가 아니거나 1 보다 작으면 기본값(스펙 2026-11-03-003 R1)."""
    try:
        value = int(str(environ.get("AAS_SIDECAR_MAX_ENTRIES") or "").strip())
    except ValueError:
        return DEFAULT_MAX_ENTRIES
    return value if value > 0 else DEFAULT_MAX_ENTRIES


def _type_of(st: os.stat_result) -> str:
    import stat as _stat
    if _stat.S_ISREG(st.st_mode):
        return "file"
    if _stat.S_ISDIR(st.st_mode):
        return "dir"
    return "other"


def _match(parts: list[str], pat: list[str]) -> bool:
    """pathlib.Path.glob 의 패턴 맞춤(조각마다 fnmatch, ** 는 0개 이상의 폴더). 서버 `remote._match` 와 같은 규칙이다."""
    if not pat:
        return not parts
    if pat[0] == "**":
        return any(_match(parts[i:], pat[1:]) for i in range(len(parts) + 1))
    return bool(parts) and fnmatch.fnmatchcase(parts[0], pat[0]) and _match(parts[1:], pat[1:])


class Ops:
    def __init__(self, root: Path, *, max_file: int = DEFAULT_MAX_FILE, max_total: int = DEFAULT_MAX_TOTAL,
                 max_entries: int = DEFAULT_MAX_ENTRIES, max_rows: int = DEFAULT_MAX_ROWS,
                 sql_seconds: float = DEFAULT_SQL_SECONDS):
        self.root = Path(os.path.realpath(root))
        self.max_file, self.max_total = max_file, max_total
        self.max_entries, self.max_rows, self.sql_seconds = max_entries, max_rows, sql_seconds
        self._hashes: dict[tuple, str] = {}                # (경로, 크기, 시각 ns) → sha256 — 바뀐 파일만 다시 해시한다(R7)
        self._hash_lock = threading.Lock()
        # 해시 캐시 상한은 항목 상한에 비례한다. 5만 고정이면 상한을 5만 넘게 둔 폴더에서 캐시가 자주 넘쳐 통째로 비워지고,
        # 다음 목록에서 모든 파일을 다시 읽어 해시했다(스펙 2026-11-03-003 R8·D13). 오래된 키는 tree 가 끝날 때 지운다
        from .index import ChangeIndex
        self.index = ChangeIndex(lambda p: self.tree(p["path"], skip_dirs=p["skip_dirs"], no_content=[""], max_file=p["max_file"],
                                                     hashes=p["hashes"], _listing=True))

    @property
    def hash_cap(self) -> int:
        return max(50_000, 2 * int(self.max_entries))

    # ---- 경로 ---------------------------------------------------------------------------------
    @staticmethod
    def _parts(rel) -> list[str]:
        if not isinstance(rel, str) or "\x00" in rel or rel.startswith("/"):
            raise OpError(400, "경로 모양이 맞지 않습니다")
        parts = [p for p in rel.split("/") if p not in ("", ".")]
        if any(p == ".." for p in parts):
            raise OpError(400, "경로 모양이 맞지 않습니다")
        return parts

    def _inside(self, real: Path) -> bool:
        return real == self.root or self.root in real.parents

    def _resolve(self, rel) -> Path | None:
        """root 안의 실제 경로. 심링크가 root 밖을 가리키면 None(없는 것처럼 다룬다)."""
        target = self.root.joinpath(*self._parts(rel))
        real = Path(os.path.realpath(target))
        return real if self._inside(real) else None

    def _rel(self, real: Path) -> str:
        r = real.relative_to(self.root).as_posix()
        return "" if r == "." else r

    # ---- 연산 ---------------------------------------------------------------------------------
    def stat(self, rel) -> dict:
        real = self._resolve(rel)
        if real is None:
            return {"exists": False}
        try:
            st = os.stat(real)
        except OSError:
            return {"exists": False}
        return {"exists": True, "type": _type_of(st), "size": st.st_size, "mtime": st.st_mtime, "mtime_ns": st.st_mtime_ns, "mode": st.st_mode}

    def read(self, paths) -> dict:
        if not isinstance(paths, list) or not all(isinstance(p, str) for p in paths):
            raise OpError(400, "paths 는 문자열 목록이어야 합니다")
        files, total, capped = [], 0, False
        for rel in paths:
            item = {"path": rel}
            real = self._resolve(rel)
            if real is None or not real.exists():
                files.append({**item, "ok": False, "error": "missing"})
                continue
            if not real.is_file():
                files.append({**item, "ok": False, "error": "not_file"})
                continue
            size = real.stat().st_size
            if size > self.max_file:
                files.append({**item, "ok": False, "error": "too_large"})
                continue
            if capped or total + size > self.max_total:
                capped = True
                files.append({**item, "ok": False, "error": "total_cap"})
                continue
            try:
                data = real.read_bytes()
            except OSError:
                files.append({**item, "ok": False, "error": "unreadable"})
                continue
            total += len(data)
            files.append({**item, "ok": True, "size": len(data), "data_b64": base64.b64encode(data).decode()})
        return {"files": files}

    def read_size(self, paths) -> int:
        """read 가 읽을 파일 크기의 합(바이트). 없거나 파일이 아닌 경로는 0 으로 친다. 서버가 큰 연산 잠금을 쓸지 정한다."""
        if not isinstance(paths, list):
            return 0
        total = 0
        for rel in paths:
            if not isinstance(rel, str):
                continue
            real = self._resolve(rel)
            try:
                if real is not None and real.is_file():
                    total += real.stat().st_size
            except OSError:
                continue
        return total

    def glob(self, rel, pattern, skip_dirs=None) -> dict:
        """skip_dirs 가 있으면 그 이름의 폴더(와 그 안)를 결과에서 빼고 안으로 들어가지도 않는다(스펙 2026-11-03-003 R5).
        `Path.glob` 은 들어가는 도중에 멈출 수 없어 그때는 직접 걷는다. 키가 없으면 지금처럼 `Path.glob` 이다."""
        base = self._resolve(rel)
        if base is None or not base.is_dir():
            raise OpError(404, "폴더가 없습니다")
        if not isinstance(pattern, str) or not pattern or pattern.startswith("/") or "\x00" in pattern \
                or ".." in pattern.split("/"):
            raise OpError(400, "패턴 모양이 맞지 않습니다")
        skip = {str(x) for x in (skip_dirs or [])}
        entries, truncated = [], False
        for p in (self._walk_glob(base, pattern, skip) if skip else base.glob(pattern)):
            real = Path(os.path.realpath(p))
            if not self._inside(real):
                continue                                     # 밖을 가리키는 항목은 목록에서 뺀다
            try:
                st = os.stat(real)
            except OSError:
                continue
            if len(entries) >= self.max_entries:
                truncated = True
                break
            entries.append({"path": self._rel_under(base, p),
                            "type": _type_of(st), "size": st.st_size, "mtime": st.st_mtime, "mtime_ns": st.st_mtime_ns,
                            "mode": st.st_mode})
        entries.sort(key=lambda e: e["path"])
        return {"entries": entries, "truncated": truncated}

    @staticmethod
    def _walk_glob(base: Path, pattern: str, skip: set[str]):
        """`Path.glob(pattern)` 과 같은 결과를 내되 skip 이름의 폴더는 내지도 들어가지도 않는다. 심링크 폴더 안으로는 들어가지 않는다
        (tree 와 같다). `**` 가 없으면 패턴 깊이까지만 걷는다."""
        pat = [p for p in pattern.split("/") if p]
        depth = None if "**" in pat else len(pat)
        stack = [(base, [])]
        while stack:
            here, parts = stack.pop()
            try:
                items = sorted(os.scandir(here), key=lambda d: d.name)
            except OSError:
                continue
            for d in items:
                if d.name in skip:
                    continue
                rel = parts + [d.name]
                if _match(rel, pat):
                    yield Path(d.path)
                try:
                    walk = d.is_dir(follow_symlinks=False)
                except OSError:
                    walk = False
                if walk and (depth is None or len(rel) < depth):
                    stack.append((Path(d.path), rel))

    def _sha256(self, path: str, real_path: str, st) -> str | None:
        key = (path, st.st_size, st.st_mtime_ns)
        hit = self._hashes.get(key)
        if hit is None:
            try:
                with open(real_path, "rb") as fh:
                    hit = hashlib.sha256(fh.read()).hexdigest()
            except OSError:
                return None
            with self._hash_lock:                            # tree 가 여러 스레드로 해시한다
                if len(self._hashes) > self.hash_cap:
                    self._hashes.clear()
                self._hashes[key] = hit
        return hit

    def _prune_hashes(self, base_rel: str, seen: set, partial: list[str]) -> None:
        """tree 하나를 마친 뒤 그 목록이 훑은 범위(base_rel 아래, 안을 보지 않은 폴더 밖)에서 이번에 보지 못한 키를 지운다.
        다른 범위의 목록이 쓰는 키는 남긴다(스펙 2026-11-03-003 D13)."""
        pre = f"{base_rel}/" if base_rel else ""
        skipped = tuple(f"{p}/" for p in partial)
        for key in [k for k in self._hashes if k not in seen and k[0].startswith(pre) and not k[0].startswith(skipped)]:
            del self._hashes[key]

    @staticmethod
    def _index_key(rel, skip_dirs, max_file, hashes) -> tuple:
        return (str(rel or ""), tuple(sorted(str(x) for x in (skip_dirs or []))), int(max_file), tuple(sorted(hashes)) if hashes is not None else None)

    def changes(self, since: str, rel="", *, skip_dirs=None, max_file=262_144, hashes=None, fresh=False) -> dict:
        """since 커서 뒤에 바뀐 것만(R10). 물을 때 훑고 2초 안이면 지난 훑기를 쓴다(D3) — fresh 면 다시 훑는다. 알 수 없으면 reset."""
        params = {"path": rel, "skip_dirs": skip_dirs, "max_file": max_file, "hashes": hashes}
        return self.index.changes(self._index_key(rel, skip_dirs, max_file, hashes), since, params, fresh=bool(fresh))

    def tree(self, rel="", *, skip_dirs=None, no_content=None, max_file=262_144, max_total=None, if_fingerprint="",
             hashes=None, cursor=False, _listing=False) -> dict:
        """rel 아래 전체를 한 번에: 모든 항목의 종류·크기·시각과 작은 파일의 내용.
        서버가 파일·폴더마다 묻던 왕복(수백 번)을 한 번으로 줄인다. 무엇을 건너뛸지는 서버가 정한다(도메인 규칙은 여기 없다).
        skip_dirs 에 이름이 있는 폴더와 심링크 폴더는 항목만 내고 안을 보지 않는다(partial 에 적는다 — 서버가 따로 묻는다).
        no_content 에 접미사가 있는 파일과 max_file 보다 큰 파일은 내용 없이 낸다. 내용 총량이 max_total 을 넘으면 그 뒤는 내용 없이.
        목록(경로·종류·크기·시각)으로 지문을 만든다. if_fingerprint 와 같으면 내용을 읽지 않고 {"unchanged": true} 만 낸다."""
        base = self._resolve(rel)
        if base is None or not base.is_dir():
            raise OpError(404, "폴더가 없습니다")
        skip = {str(x) for x in (skip_dirs or [])}
        no_ext = tuple(str(x) for x in (no_content or []))
        max_file = min(int(max_file), self.max_file)
        max_total = min(int(max_total or self.max_total), self.max_total)
        entries, partial, total, truncated, want = [], [], 0, False, []
        seen: set = set()                                    # 이번 목록이 쓴 해시 키 — 끝나면 범위 안의 나머지 키를 지운다(D13)
        # 1단계: stat·파일 읽기 없이 훑어 항목을 모으고 센다(os.scandir 의 d_type). 심링크만 realpath 로 안팎을 본다.
        # NFS 에서는 항목마다 stat 이 약 8ms, 파일 읽기가 약 20ms 라서, 예전처럼 훑으며 하나씩 하면 5만 개에 수백~수천 초가 들었고
        # 상한에서 잘린다는 것도 그 뒤에야 알았다 — 서버는 60초에 끊고 30초마다 다시 물었다(OKE 2026-11-03, 스펙 2026-11-03-003 §9-5).
        # 훑기만은 1만 개에 약 0.7초다.
        # 다음 폴더를 열면 상한을 넘을 때 그 폴더와 아직 열지 않은 폴더를 끊어(cut) partial 로 적고 받은 만큼 낸다. 서버는 끊긴 폴더
        # 안만 따로 묻는다(후속 F1, 스펙 2026-11-03-003 D15). 예전처럼 목록을 통째로 버리면 서버가 모든 파일을 하나씩 물었다(5분에
        # 약 1,700번). 이름순으로 넣고 뒤에서 꺼내므로 끊는 자리는 늘 같다 — 커서 색인이 엉뚱한 「없어짐」을 적지 않는다.
        # 루트 폴더 하나만으로 상한을 넘을 때만 예전처럼 stat·해시 없이 잘림과 센 수를 낸다
        found: list[tuple[str, str, str, bool]] = []          # (상대 경로, 이름, 읽을 실제 경로, 심링크인가)
        cut: set = set()                                     # 끊어서 안을 보지 않은 폴더
        stack = [(base, self._rel(base))]
        while stack and not truncated:
            here, here_rel = stack.pop()
            try:
                items = sorted(os.scandir(here), key=lambda d: d.name)
            except OSError:
                continue
            if len(found) + len(items) > self.max_entries:
                if here == base:
                    truncated = True
                    break
                cut.add(here_rel)
                cut.update(r for _, r in stack)
                break
            for d in items:
                path = f"{here_rel}/{d.name}" if here_rel else d.name
                try:
                    link = d.is_symlink()
                    if link:
                        real = os.path.realpath(d.path)
                        if not self._inside(Path(real)):
                            continue                             # 밖을 가리키는 심링크는 없는 것처럼
                        walk = False                             # 심링크 폴더는 안을 보지 않는다(partial)
                    else:
                        real = d.path
                        walk = d.is_dir(follow_symlinks=False) and d.name not in skip
                except OSError:
                    continue
                found.append((path, d.name, real, link))
                if walk:
                    stack.append((Path(d.path), path))
        if truncated:
            out = {"entries": [], "partial": [], "truncated": True, "entry_count": len(found) + len(items)}
            return out if _listing else {"root": self._rel(base), **out, "content_bytes": 0, "fingerprint": ""}
        # 2단계: stat 과 해시를 TREE_WORKERS 개씩 동시에 한다. NFS 왕복을 기다리는 일이라 스레드가 그만큼 줄인다(stat 8.1 → 0.66 ms/항목)
        hash_skip = tuple(str(x) for x in (hashes or []))

        def look(f):
            path, name, real, link = f
            try:
                st = os.stat(real) if link else os.lstat(real)
            except OSError:
                return None
            sha = None
            if hashes is not None and _stat.S_ISREG(st.st_mode) and st.st_size <= max_file and not name.endswith(hash_skip):
                sha = self._sha256(path, real, st)               # 서버가 아는 내용이면 읽지 않는다(R7)
            return st, sha
        with ThreadPoolExecutor(max_workers=TREE_WORKERS) as pool:
            looked = list(pool.map(look, found))
        for (path, name, real, link), got in zip(found, looked):
            if got is None:
                continue
            st, sha = got
            kind = _type_of(st)
            item = {"path": path, "type": kind, "size": st.st_size, "mtime": st.st_mtime, "mode": st.st_mode}
            if kind == "dir":
                if name in skip or link or path in cut:
                    partial.append(path)                         # 항목만 내고 안을 보지 않는다
            elif kind == "file" and st.st_size <= max_file and not name.endswith(no_ext):
                want.append((item, real))                        # 내용은 지문을 본 뒤에 읽는다
            if sha:
                item["sha256"] = sha
                seen.add((path, st.st_size, st.st_mtime_ns))
            entries.append(item)
        entries.sort(key=lambda e: e["path"])
        partial.sort()
        if hashes is not None:                               # 끊긴 폴더(partial) 안의 키는 지우지 않는다
            self._prune_hashes(self._rel(base), seen, partial)
        digest = hashlib.sha1()
        for e in entries:
            digest.update(f"{e['path']}\0{e['type']}\0{e['size']}\0{e['mtime']!r}\n".encode("utf-8", "surrogateescape"))
        fingerprint = digest.hexdigest()
        if _listing:
            return {"entries": entries, "partial": partial, "truncated": False, "cut": bool(cut)}
        if if_fingerprint and if_fingerprint == fingerprint:
            return {"root": self._rel(base), "unchanged": True, "fingerprint": fingerprint}
        for item, real_path in want:
            if total + item["size"] > max_total:
                continue
            try:
                with open(real_path, "rb") as fh:
                    data = fh.read()
            except OSError:
                continue
            item["data_b64"] = base64.b64encode(data).decode()
            total += len(data)
        out = {"root": self._rel(base), "entries": entries, "partial": partial, "truncated": False, "cut": bool(cut),
               "content_bytes": total, "fingerprint": fingerprint}
        if cursor:
            out["cursor"] = self.index.record(self._index_key(rel, skip_dirs, max_file, hashes), {"entries": out["entries"], "partial": partial})
        return out

    # ---- 대화 파일(OMAI-1153) ------------------------------------------------------------------
    def _open_nofollow(self, rel, *, want_dir: bool = False) -> int:
        """root 에서 경로 조각마다 심링크를 따르지 않고 연다(openat + O_NOFOLLOW). 확인과 사용 사이에 링크로 바꿔치기할
        틈이 없다. 돌려준 fd 는 부른 쪽이 닫는다. 조각이 심링크면 OpError(403, link)."""
        parts = self._parts(rel)
        flags_dir = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(self.root, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            for i, name in enumerate(parts):
                last = i == len(parts) - 1
                flags = flags_dir if (not last or want_dir) else os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
                try:
                    nfd = os.open(name, flags, dir_fd=fd)
                except OSError as exc:
                    # O_NOFOLLOW 가 심링크를 만나면 ELOOP(리눅스)·ENOTDIR(폴더 링크, 맥)·EFTYPE 등 — 링크인지 직접 확인한다
                    try:
                        is_link = _stat.S_ISLNK(os.lstat(name, dir_fd=fd).st_mode)
                    except OSError:
                        raise OpError(404, "missing") from None
                    if is_link:
                        raise OpError(403, "link") from None
                    if isinstance(exc, (FileNotFoundError, NotADirectoryError)):
                        raise OpError(404, "missing") from None
                    raise OpError(403, f"unreadable:{type(exc).__name__}") from None
                os.close(fd)
                fd = nfd
            return fd
        except BaseException:
            os.close(fd)
            raise

    def check(self, rel) -> dict:
        """rel 을 심링크 없이 열 수 있는지와 그 종류·크기·링크 수. 지우기 전 확인과 업로드 이름 고르기에 쓴다."""
        try:
            fd = self._open_nofollow(rel)
        except OpError as exc:
            if exc.message == "missing":
                return {"exists": False}
            if exc.message == "link":
                return {"exists": True, "link": True}
            raise
        try:
            st = os.fstat(fd)
        finally:
            os.close(fd)
        return {"exists": True, "link": False, "type": _type_of(st), "size": st.st_size, "mtime": st.st_mtime, "nlink": st.st_nlink}

    def open_download(self, rel):
        """내려받을 파일을 연다. 심링크가 끼었거나, 일반 파일이 아니거나, 하드링크(링크 수 > 1)면 거절한다.
        (fd, 크기, 이름)을 돌려주고 fd 는 부른 쪽이 닫는다. 연 파일 기준으로 검사하므로 검사와 읽기 사이 틈이 없다."""
        fd = self._open_nofollow(rel)
        try:
            st = os.fstat(fd)
            if not _stat.S_ISREG(st.st_mode):
                raise OpError(403, "not_file")
            if st.st_nlink > 1:
                raise OpError(403, "hardlink")
        except BaseException:
            os.close(fd)
            raise
        return fd, st.st_size, self._parts(rel)[-1]

    def scan(self, rel="", *, skip_dirs=None) -> dict:
        """rel 아래 전체 목록(lstat 기준, 심링크는 따라가지 않고 link 로 낸다)과 일반 파일 크기 합계.
        skip_dirs 이름의 폴더는 들어가지 않는다(항목만 낸다). 항목이 max_entries 를 넘으면 잘라 truncated 로 알린다."""
        try:
            fd = self._open_nofollow(rel, want_dir=True) if rel else None
        except OpError as exc:
            if exc.message == "missing":
                return {"entries": [], "truncated": False, "total": 0, "missing": True}
            raise
        if fd is not None:
            os.close(fd)
        base = self.root.joinpath(*self._parts(rel)) if rel else self.root
        skip = {str(x) for x in (skip_dirs or [])}
        entries, total, truncated = [], 0, False
        stack = [(base, self._rel(base))]
        while stack and not truncated:
            here, here_rel = stack.pop()
            try:
                items = list(os.scandir(here))
            except OSError:
                continue
            for d in items:
                path = f"{here_rel}/{d.name}" if here_rel else d.name
                try:
                    st = d.stat(follow_symlinks=False)
                except OSError:
                    continue
                if _stat.S_ISLNK(st.st_mode):
                    kind = "link"
                else:
                    kind = _type_of(st)
                entries.append({"path": path, "type": kind, "size": st.st_size if kind == "file" else 0,
                                "mtime": st.st_mtime, "nlink": st.st_nlink})
                if kind == "file":
                    total += st.st_size
                elif kind == "dir" and d.name not in skip:
                    stack.append((Path(d.path), path))
                if len(entries) >= self.max_entries:
                    truncated = True
                    break
        entries.sort(key=lambda e: e["path"])
        return {"entries": entries, "truncated": truncated, "total": total}

    def _rel_under(self, base: Path, p: Path) -> str:
        """glob 이 낸 경로를 root 기준 상대 경로로(심링크 이름은 그대로 둔다)."""
        r = Path(os.path.normpath(p)).relative_to(base).as_posix()
        pre = self._rel(base)
        return f"{pre}/{r}" if pre else r

    @staticmethod
    def _open_db(real: Path) -> tuple[sqlite3.Connection, str]:
        """(연결, 읽기 방식). mode=ro 를 먼저 쓴다 — WAL 에만 있는 최신 기록까지 읽는다(스펙 2026-11-03-001 R15, 2026-11-03-002 2A).
        읽기 전용 마운트처럼 WAL 공유 메모리(-shm)를 잡지 못해 열리지 않으면 immutable 로 다시 연다. immutable 은 WAL 의 최신 기록을
        놓칠 수 있어, 응답의 read_mode 로 알려 부른 쪽이 「없음」을 단정하지 않게 한다.
        mode=ro 는 쓰기 가능한 폴더에서 -shm·-wal 파일을 만들 수 있다(Hermes 가 돌 때는 이미 있는 파일이다). DB 내용은 바꾸지 않는다."""
        uri = f"file:{quote(str(real))}"
        conn = None
        try:
            conn = sqlite3.connect(f"{uri}?mode=ro", uri=True, timeout=1.0)
            conn.execute("SELECT 1 FROM sqlite_master LIMIT 1").fetchall()   # 여는 것만으로는 -shm 실패가 드러나지 않는다 — 한 번 읽어 본다
            return conn, "ro"
        except sqlite3.Error as exc:
            if conn is not None:
                conn.close()
            if not _open_or_io_error(exc):                      # 잠금(BUSY) 등은 읽기 방식 탓이 아니다 — immutable 로 덮지 않는다(스펙 2026-11-03-002 D3·D9·D10)
                raise OpError(503, f"DB 를 지금 읽을 수 없습니다: {exc}") from None
        return sqlite3.connect(f"{uri}?immutable=1", uri=True), "immutable"

    def sqlite(self, rel, sql, params) -> dict:
        if not isinstance(sql, str) or not isinstance(params, list):
            raise OpError(400, "sql 은 문자열, params 는 목록이어야 합니다")
        real = self._resolve(rel)
        if real is None or not real.is_file():
            raise OpError(404, "DB 파일이 없습니다")
        conn, read_mode = self._open_db(real)
        deadline = time.monotonic() + self.sql_seconds
        timed_out = {"v": False}

        def _progress():
            if time.monotonic() > deadline:
                timed_out["v"] = True
                return 1
            return 0

        def _authorize(action, arg1, arg2, dbname, source):
            if action in (sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_RECURSIVE):
                return sqlite3.SQLITE_OK
            if action == sqlite3.SQLITE_FUNCTION:
                return sqlite3.SQLITE_DENY if str(arg2).lower() in _FUNCTIONS_DENIED else sqlite3.SQLITE_OK
            if action == sqlite3.SQLITE_PRAGMA and str(arg1).lower() in _PRAGMAS_OK:
                return sqlite3.SQLITE_OK
            return sqlite3.SQLITE_DENY

        try:
            conn.execute("PRAGMA query_only=1")              # 인가 검사기를 걸기 전에 한 번
            conn.set_authorizer(_authorize)
            conn.set_progress_handler(_progress, 1000)
            try:
                cur = conn.execute(sql, params)
                columns = [d[0] for d in (cur.description or [])]
                rows = cur.fetchmany(self.max_rows + 1)
            except sqlite3.Error as exc:
                if timed_out["v"]:
                    raise OpError(408, "SQL 시간 제한을 넘었습니다") from None
                raise OpError(400, f"SQL 을 실행하지 못했습니다: {exc}") from None
            except (TypeError, ValueError, OverflowError) as exc:
                raise OpError(400, f"SQL 인자가 맞지 않습니다: {type(exc).__name__}") from None
            truncated = len(rows) > self.max_rows
            return {"columns": columns, "rows": [[self._cell(c) for c in r] for r in rows[:self.max_rows]],
                    "truncated": truncated, "read_mode": read_mode}
        finally:
            conn.close()

    def sqlite_batch(self, queries) -> dict:
        """여러 DB·쿼리를 요청 하나로(OMAI-1102). 쿼리마다 sqlite() 와 같은 검사·시간 제한을 쓰고, 하나가 실패해도 나머지는 돈다.
        결과는 같은 차례로 {columns, rows, truncated} 이거나 {error, code} 다."""
        if not isinstance(queries, list) or len(queries) > MAX_BATCH:
            raise OpError(400, f"queries 는 {MAX_BATCH}개 이하의 목록이어야 합니다")
        out = []
        for q in queries:
            if not isinstance(q, dict):
                out.append({"error": "쿼리 모양이 맞지 않습니다", "code": 400})
                continue
            try:
                out.append(self.sqlite(q.get("path"), q.get("sql"), q.get("params", [])))
            except OpError as exc:
                out.append({"error": exc.message, "code": exc.code})
        return {"results": out}

    @staticmethod
    def _cell(value):
        if isinstance(value, (bytes, bytearray, memoryview)):
            return {"$b64": base64.b64encode(bytes(value)).decode()}
        return value

    def version(self) -> dict:
        return {"api": API, "sidecar": VERSION, "root_ok": self.root.is_dir(),
                "ops": ["stat", "read", "list", "tree", "changes", "sqlite", "sqlite_batch", "scan", "check", "download", "version"]}
