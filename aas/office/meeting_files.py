# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""회의 파일 공유 — 서버가 공유 볼륨에 직접 쓰는 저장·한도·정리(스펙 office/meeting-file-sharing §4-9).

올린 파일:   AAS_MEETING_SHARED_IN/<방>/<KST 날짜>/<파일id>-<이름>   (서버 읽기·쓰기, 에이전트 읽기 전용. 목록의 기준은 DB office_files)
에이전트 출력: AAS_MEETING_SHARED_OUT/<방>/<별칭>/<날짜>/<이름>       (에이전트 읽기·쓰기. 목록의 기준은 디스크 스캔)
한도는 DB 합계로 센다. 올리기를 시작할 때 status='uploading'·예상 크기 행을 먼저 넣어 동시 업로드가 겹쳐도 한도를 넘지 않는다.
"""
from __future__ import annotations

import json
import os
import secrets
import shutil
import stat
import threading
from datetime import datetime, timedelta
from pathlib import Path

from . import office
from ..common import config, db
from ..common.i18n import tr
from ..hermes import workspace as wsp

SCHEMA = """
CREATE TABLE IF NOT EXISTS office_files (
  id TEXT PRIMARY KEY, room INTEGER NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, uploader TEXT NOT NULL DEFAULT '',
  ts TEXT NOT NULL, date TEXT NOT NULL, rel TEXT NOT NULL, status TEXT NOT NULL, msg INTEGER, from_alias TEXT NOT NULL DEFAULT '',
  src TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS office_files_room ON office_files (room, ts);
"""
MAX_PER_MESSAGE = wsp.MAX_FILES_PER_MESSAGE
OUT_LIMIT = 2000                                              # 에이전트 출력 스캔 최대 항목
ORPHAN_HOURS = 24                                             # 말에 연결되지 않은 파일을 지우는 기준
LOCK_FILES = 1397441348                                       # office_files 한도 검사를 한 줄로 세우는 advisory 잠금 키('MFIL')
CHUNK = 64 * 1024                                             # 에이전트 결과 파일을 사이드카에서 받아 쓰는 단위
_lock = threading.Lock()                                      # 이 서버 프로세스 안의 한 줄 세우기(SQLite·PostgreSQL 공통)
_marked: set[str] = set()
_MIGRATED: set[tuple] = set()


class FileError(Exception):
    """code 는 API 오류 코드(JSON {"error": code}), status 는 HTTP 상태."""

    def __init__(self, code: str, status: int, message: str = ""):
        super().__init__(message or code)
        self.code, self.status = code, status


# ---- 설정 ------------------------------------------------------------------------------------------
def root_in() -> Path | None:
    raw = config.get("AAS_MEETING_SHARED_IN").strip()
    return Path(raw) if raw else None


def root_out() -> Path | None:
    raw = config.get("AAS_MEETING_SHARED_OUT").strip()
    return Path(raw) if raw else None


def _int(key: str, default: int) -> int:
    try:
        value = int(config.get(key).strip() or default)
    except ValueError:
        return default
    return value if value > 0 else default


def limits() -> dict:
    return {"file": _int("AAS_MEETING_FILE_MAX", 25 * 1024 ** 2), "room": _int("AAS_MEETING_ROOM_QUOTA", 500 * 1024 ** 2),
            "total": _int("AAS_MEETING_FILES_QUOTA", 5 * 1024 ** 3)}


def enabled() -> bool:
    """올린 파일 저장 폴더가 설정돼 있고 쓸 수 있을 때만 켠다."""
    root = root_in()
    return bool(root and root.is_dir() and os.access(root, os.W_OK | os.X_OK))


def info() -> dict:
    """GET /api/office/meeting 응답의 files 키."""
    return {"enabled": enabled(), "limits": limits(), "max_per_message": MAX_PER_MESSAGE}


def _db():
    conn = office.connect()
    conn.executescript(SCHEMA)
    key = (db.backend(), os.environ.get("AAS_DATA_DIR", ""), os.environ.get("AAS_DB_SCHEMA", ""))
    if key not in _MIGRATED:
        # src: 에이전트 결과 파일의 출처 「설치본:경로」. 같은 출처는 최신판 하나만 둔다(2026-10-20)
        if "src" not in db.columns(conn, "office_files"):
            db.add_column(conn, "office_files", "src TEXT NOT NULL DEFAULT ''")
        _MIGRATED.add(key)
    return conn


def ensure_marker() -> None:
    """공유 폴더 루트에 표지 파일을 서버가 직접 쓴다(에이전트 경유로 쓰면 마운트가 안 된 설치본에도 보이는 거짓 양성이 된다)."""
    for root in (root_in(), root_out()):
        if root is None or str(root) in _marked:
            continue
        try:
            marker = root / wsp.SHARED_MARKER
            if not marker.exists():
                marker.write_text("aas-shared\n", encoding="utf-8")
            os.chmod(marker, 0o644)
            _marked.add(str(root))
        except OSError:
            pass                                              # 쓰지 못한 폴더는 다음에 다시 시도한다


# ---- 경로 ------------------------------------------------------------------------------------------
def _today() -> str:
    return datetime.now(wsp._KST).strftime("%Y-%m-%d")


def _mkdir(path: Path) -> None:
    """폴더를 0755 로 만든다(에이전트가 읽을 수 있게 — 서버와 에이전트의 소유자 ID 가 다를 수 있다)."""
    if not path.is_dir():
        path.mkdir(mode=0o755, exist_ok=True)
    try:
        os.chmod(path, 0o755)
    except OSError:
        pass


def resolve(root: Path, rel: str) -> Path:
    """root 아래의 일반 파일 경로. 절대 경로·`..`·빈 구성요소·NUL·심링크가 끼면 FileError. 존재하는지는 부르는 쪽이 본다."""
    if not isinstance(rel, str) or not rel or rel.startswith("/") or "\\" in rel or "\x00" in rel:
        raise FileError("bad_request", 400)
    parts = rel.split("/")
    if any(p in ("", ".", "..") for p in parts):
        raise FileError("bad_request", 400)
    cur = root
    for part in parts:
        cur = cur / part
        try:
            if stat.S_ISLNK(os.lstat(cur).st_mode):
                raise FileError("bad_request", 400)
        except FileNotFoundError:
            break
        except OSError:
            raise FileError("io_error", 502) from None
    return cur


def open_regular(root: Path, rel: str):
    """(파일 객체, 크기, 이름). 심링크 없이 열리는 일반 파일만. 없으면 404 no_file."""
    path = resolve(root, rel)
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except FileNotFoundError:
        raise FileError("no_file", 404) from None
    except OSError:
        raise FileError("bad_request", 400) from None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise FileError("no_file", 404)
    except BaseException:
        os.close(fd)
        raise
    return os.fdopen(fd, "rb"), st.st_size, path.name


# ---- 올리기 ----------------------------------------------------------------------------------------
class Upload:
    """진행 중인 올리기 하나. write 로 쓰고 finish 로 이름을 바꿔 ready 로 만든다. 끊기면 abort."""

    def __init__(self, rec: dict, part: Path, final: Path, size: int):
        self.rec, self.part, self.final, self.size = rec, part, final, size
        self.got = 0
        self._fh = None
        self._done = False

    def write(self, chunk: bytes) -> None:
        if self._fh is None:
            fd = os.open(self.part, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
            os.fchmod(fd, 0o644)
            self._fh = os.fdopen(fd, "wb")
        self.got += len(chunk)
        if self.got > self.size:
            raise FileError("bad_request", 400)
        self._fh.write(chunk)

    def finish(self) -> dict:
        if self.got != self.size:
            raise FileError("bad_request", 400)
        try:
            if self._fh is None:                              # 크기 0 은 begin 이 거절한다 — 여기 오는 일은 없다
                raise FileError("bad_request", 400)
            self._fh.close()
            self._fh = None
            os.replace(self.part, self.final)
            os.chmod(self.final, 0o644)
        except FileError:
            raise
        except OSError:
            raise FileError("io_error", 502) from None
        with _db() as conn:
            conn.execute("UPDATE office_files SET status='ready' WHERE id=?", (self.rec["id"],))
        self._done = True
        return {"id": self.rec["id"], "name": self.rec["name"], "size": self.size, "date": self.rec["date"], "status": "ready"}

    def abort(self) -> None:
        """임시 파일과 uploading 행을 지운다(여러 번 불러도 안전). finish 가 끝난 뒤에는 아무 일도 하지 않는다."""
        if self._done:
            return
        self._done = True
        if self._fh is not None:
            try:
                self._fh.close()
            except OSError:
                pass
        for path in (self.part, self.final):
            try:
                path.unlink()
            except OSError:
                pass
        try:
            with _db() as conn:
                conn.execute("DELETE FROM office_files WHERE id=? AND status='uploading'", (self.rec["id"],))
        except Exception:
            pass


def _lock_files(conn) -> None:
    if db.is_pg(conn):
        conn.execute("SELECT pg_advisory_xact_lock(?)", (LOCK_FILES,))
    elif not conn.in_transaction:
        conn.execute("BEGIN IMMEDIATE")


def _remove_rows(rows: list) -> None:
    root = root_in()
    for r in rows:
        if root is not None:
            try:
                (root / r["rel"]).unlink()
            except OSError:
                pass
            if str(r["status"]) == "uploading":
                try:
                    (root / (r["rel"] + ".part")).unlink()
                except OSError:
                    pass


def purge_orphans(now: datetime | None = None) -> int:
    """말에 연결되지 않은 채 24시간 지난 ready·uploading 파일을 지운다(다음 업로드 때 그때그때)."""
    now = now or datetime.now().astimezone()
    cutoff = now - timedelta(hours=ORPHAN_HOURS)
    stale = []
    with _db() as conn:
        for r in conn.execute("SELECT id, rel, status, ts FROM office_files WHERE msg IS NULL AND status IN ('ready','uploading')").fetchall():
            try:
                if datetime.fromisoformat(str(r["ts"])) < cutoff:
                    stale.append(dict(r))
            except ValueError:
                stale.append(dict(r))
        for r in stale:
            conn.execute("DELETE FROM office_files WHERE id=?", (r["id"],))
    _remove_rows(stale)
    return len(stale)


def begin(room: int, name: str, size: int, uploader: str) -> Upload:
    """한도를 확인하고 uploading 행을 넣은 Upload 를 돌려준다. 한도를 넘으면 FileError(413 …)."""
    root = root_in()
    if not enabled() or root is None:
        raise FileError("not_configured", 501)
    lim = limits()
    if size <= 0:
        raise FileError("bad_request", 400)
    if size > lim["file"]:
        raise FileError("too_large", 413)
    ensure_marker()
    try:
        purge_orphans()
    except Exception:
        pass                                                  # 정리가 실패해도 올리기는 계속한다
    fid = secrets.token_hex(6)
    clean = wsp.clean_name(name)
    date = _today()
    rel = f"{room}/{date}/{fid}-{clean}"
    with _lock, _db() as conn:
        _lock_files(conn)
        in_room = conn.execute("SELECT COALESCE(SUM(size), 0) FROM office_files WHERE room=? AND status IN ('uploading','ready')", (room,)).fetchone()[0]
        total = conn.execute("SELECT COALESCE(SUM(size), 0) FROM office_files WHERE status IN ('uploading','ready')").fetchone()[0]
        if in_room + size > lim["room"]:
            raise FileError("room_quota", 413)
        if total + size > lim["total"]:
            raise FileError("total_quota", 413)
        conn.execute("INSERT INTO office_files (id, room, name, size, uploader, ts, date, rel, status, msg, from_alias) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                     (fid, room, clean, size, uploader, office._now(), date, rel, "uploading", None, ""))
    rec = {"id": fid, "name": clean, "date": date, "rel": rel}
    up = Upload(rec, root / (rel + ".part"), root / rel, size)
    try:
        _mkdir(root / str(room))
        _mkdir(root / str(room) / date)
    except OSError:
        up.abort()
        raise FileError("io_error", 502) from None
    return up


def put_agent(room: int, name: str, size: int, read, uploader: str, alias: str, src: str, msg: int) -> dict:
    """에이전트 결과 파일 하나를 방 자료에 둔다. read(n) 으로 내용을 읽는다. 칩 행(msg)에 연결해 24시간 정리에서 빼고,
    같은 출처(src)로 먼저 올라간 파일은 새 판이 다 올라간 뒤 지운다 — 실패하면 옛 판이 남는다."""
    up = begin(room, name, size, uploader)
    try:
        while True:
            chunk = read(CHUNK)
            if not chunk:
                break
            up.write(chunk)
        out = up.finish()
    except BaseException:
        up.abort()
        raise
    with _db() as conn:
        conn.execute("UPDATE office_files SET from_alias=?, src=?, msg=? WHERE id=?", (alias, src, msg, out["id"]))
        old = [dict(r) for r in conn.execute("SELECT id, rel, status FROM office_files WHERE room=? AND src=? AND id<>? AND status='ready'",
                                             (room, src, out["id"]))]
        for r in old:
            conn.execute("DELETE FROM office_files WHERE id=?", (r["id"],))
    _remove_rows(old)
    return out


def publish(room: int, alias: str, pod: str, files: list[dict], ws, msg: int) -> list[dict]:
    """턴이 끝난 뒤 에이전트 결과 파일을 방 자료에 자동으로 올린다(2026-10-20 결정 — 원안 D2 의 「사람이 눌러야 올림」을 바꿈).
    파일마다 {"room": 파일id} 또는 {"skip": 오류 코드}. 한 파일의 실패가 다른 파일을 막지 않는다."""
    out: list[dict] = []
    for f in files:
        try:
            status, code, resp, conn = ws.backend.open_download(f["path"])
            if status != 200:
                raise FileError("no_file" if status == 404 or code == "missing" else "io_error", 502)
            try:
                size = int(resp.getheader("Content-Length") or 0)
                if size <= 0:
                    raise FileError("empty", 400)
                rec = put_agent(room, f["name"], size, resp.read, alias, alias, f"{pod}:{f['path']}", msg)
            finally:
                conn.close()
            out.append({"room": rec["id"]})
        except FileError as exc:
            out.append({"skip": exc.code})
        except Exception:                                     # 사이드카 연결 끊김 등
            out.append({"skip": "io_error"})
    return out


# ---- 읽기·지우기 -------------------------------------------------------------------------------------
def _row(room: int, fid: str):
    with _db() as conn:
        r = conn.execute("SELECT * FROM office_files WHERE id=? AND room=? AND status='ready'", (fid, room)).fetchone()
    return dict(r) if r else None


def listing(room: int) -> dict:
    with _db() as conn:
        rows = [dict(r) for r in conn.execute("SELECT id, name, size, uploader, ts, date, status, msg FROM office_files WHERE room=? AND status='ready' ORDER BY ts DESC, id DESC", (room,))]
        in_room = conn.execute("SELECT COALESCE(SUM(size), 0) FROM office_files WHERE room=? AND status IN ('uploading','ready')", (room,)).fetchone()[0]
        total = conn.execute("SELECT COALESCE(SUM(size), 0) FROM office_files WHERE status IN ('uploading','ready')").fetchone()[0]
    out, truncated = scan_out(room)
    mades = made(room)
    labels = office.who_labels([r["uploader"] for r in rows] + [o["alias"] for o in out] + [m["alias"] for m in mades])   # 이메일·별칭 대신 이름(2026-10-20-025 §6)
    return {"files": rows, "out": out, "made": mades, "used": {"room": int(in_room), "total": int(total)}, "out_truncated": truncated, "labels": labels}


def open_file(room: int, fid: str):
    """(파일 객체, 크기, 이름). 다른 방 id·없는 파일은 FileError no_file."""
    row = _row(room, fid)
    root = root_in()
    if row is None or root is None:
        raise FileError("no_file", 404)
    fh, size, _ = open_regular(root, row["rel"])
    return fh, size, row["name"]


def remove(room: int, fid: str, who: str, admin: bool) -> None:
    row = _row(room, fid)
    if row is None:
        raise FileError("no_file", 404)
    if not (admin or (who and row["uploader"] == who)):
        raise FileError("forbidden", 403)
    with _db() as conn:
        conn.execute("DELETE FROM office_files WHERE id=? AND room=?", (fid, room))
    _remove_rows([row])


def delete_room(room: int) -> None:
    """방을 지울 때 그 방의 파일과 행을 지운다. 실패해도 예외를 내지 않는다(방 삭제는 진행)."""
    try:
        with _db() as conn:
            conn.execute("DELETE FROM office_files WHERE room=?", (room,))
    except Exception:
        pass
    for root in (root_in(), root_out()):
        if root is not None:
            shutil.rmtree(root / str(int(room)), ignore_errors=True)


def claim(room: int, ids: list[str]) -> list[dict]:
    """말에 붙일 파일 행들(순서 유지). 이 방의 ready 이고 아직 어느 말에도 연결되지 않은 것만 — 아니면 FileError bad_file 400."""
    rows = []
    with _db() as conn:
        for fid in ids:
            r = conn.execute("SELECT id, name, size, date, rel, msg FROM office_files WHERE id=? AND room=? AND status='ready'", (fid, room)).fetchone()
            if r is None or r["msg"] is not None:
                raise FileError("bad_file", 400, tr("붙일 수 없는 파일입니다", "This file cannot be attached"))
            rows.append(dict(r))
    return rows


def attach(ids: list[str], msg: int, conn=None) -> None:
    """conn: 회의 말하기가 방 잠금을 쥔 연결(스펙 2026-10-20-027 R1). 주면 그 트랜잭션 안에서 쓴다."""
    if conn is None:
        with _db() as own:
            return attach(ids, msg, own)
    for fid in ids:
        conn.execute("UPDATE office_files SET msg=? WHERE id=? AND msg IS NULL", (msg, fid))


def pod_path(room: int, row: dict) -> str:
    """에이전트 파드 안에서 보이는 경로(workspace/ 기준 상대, 사이드카 check 용)."""
    return f"workspace/uploads/aas-shared/{room}/{row['date']}/{row['id']}-{row['name']}"


# ---- 에이전트 출력 ---------------------------------------------------------------------------------------
def scan_out(room: int) -> tuple[list[dict], bool]:
    """AAS_MEETING_SHARED_OUT/<방> 디스크 스캔. 심링크·점 파일·*.upload 제외, 최대 OUT_LIMIT 개. (목록, 잘렸는가)."""
    root = root_out()
    if root is None:
        return [], False
    base = root / str(int(room))
    out: list[dict] = []
    truncated = False
    stack = [base]
    while stack and not truncated:
        here = stack.pop()
        try:
            items = list(os.scandir(here))
        except OSError:
            continue
        for d in items:
            if d.name.startswith(".") or d.name.endswith(".upload"):
                continue
            try:
                if d.is_symlink():
                    continue
                if d.is_dir(follow_symlinks=False):
                    stack.append(Path(d.path))
                    continue
                st = d.stat(follow_symlinks=False)
            except OSError:
                continue
            if not stat.S_ISREG(st.st_mode):
                continue
            if len(out) >= OUT_LIMIT:
                truncated = True
                break
            rel = Path(d.path).relative_to(base).as_posix()
            parts = rel.split("/")
            out.append({"path": rel, "name": d.name, "size": st.st_size, "mtime": st.st_mtime,
                        "alias": parts[0] if len(parts) >= 3 else "", "date": parts[1] if len(parts) >= 3 else ""})
    out.sort(key=lambda e: (-e["mtime"], e["path"]))
    return out, truncated


def made(room: int) -> list[dict]:
    """방 기록의 결과 칩 행(kind='files')에 남은 파일 — 에이전트가 공유 출력 폴더가 아니라 자기 작업 폴더에 쓴 것 중 방 자료로 아직 올라가지 않은 것.
    같은 설치본·경로는 가장 최근 행 하나만, 최근 것이 앞. 받기·「방에 올리기」는 (msg, n) 으로 agent-file·from-agent 를 쓴다."""
    from . import meeting                                     # meeting 이 이 모듈을 가져오므로 여기서 가져온다
    with meeting._db() as conn:
        rows = conn.execute("SELECT id, author, ts, data FROM office_messages WHERE room=? AND kind=? ORDER BY id DESC",
                            (int(room), meeting.CHIP_NOTE)).fetchall()
    out: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for r in rows:
        try:
            data = json.loads(r["data"] or "{}")
            files = data.get("files") or []
        except (ValueError, AttributeError):
            continue
        pod = str(data.get("pod") or "")
        for n, f in enumerate(files):
            if not isinstance(f, dict) or f.get("room"):              # 자동으로 방에 올라간 것은 「올린 파일」에 이미 있다
                continue
            path = str(f.get("path") or "")
            if (pod, path) in seen or not wsp.in_workspace(path):        # agent-file 이 받지 않는 경로는 보이지 않는다
                continue
            seen.add((pod, path))
            out.append({"msg": r["id"], "n": n, "alias": r["author"], "ts": r["ts"], "path": path,
                        "name": str(f.get("name") or path.rsplit("/", 1)[-1]), "size": int(f.get("size") or 0)})
    return out


def open_out(room: int, rel: str):
    """에이전트 출력 파일 하나(방 폴더 안, 심링크 거부). (파일 객체, 크기, 이름)."""
    root = root_out()
    if root is None:
        raise FileError("not_configured", 501)
    parts = rel.split("/") if isinstance(rel, str) else []
    if any(p.startswith(".") and p not in ("", ".", "..") for p in parts) or str(rel).endswith(".upload"):
        raise FileError("bad_request", 400)
    return open_regular(root, f"{int(room)}/{rel}")


def names(ids: list[str]) -> str:
    """감사 기록에 남길 「이름(크기)」 목록."""
    with _db() as conn:
        rows = [conn.execute("SELECT name, size FROM office_files WHERE id=?", (i,)).fetchone() for i in ids]
    return ", ".join(f"{r['name']}({r['size']}B)" for r in rows if r)[:150]
