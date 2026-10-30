# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""관리자에게 요청(스펙 2026-10-15-011 단계 5, 엔지니어링 리뷰 §12). 사용자가 막힌 일을 AAS 안에서 관리자에게 부탁하고, 관리자는 받은편지함에서 처리한다.

  저장    표 admin_requests 하나. 처리 대기 요청은 만료 없이 처리될 때까지 남는다. 처리·거절된 행은 90일 뒤 읽을 때 지운다.
  항목    받은편지함에는 읽을 때 계산해 넣는다(INBOX 메모리에는 넣지 않는다). 관리자용 areq|<id>, 요청자용 areq_res|<id>.
  동시성  처리·거절은 UPDATE … WHERE status='pending' 의 영향 행 수가 1 일 때만 성공. 확인은 requester_ack_at IS NULL 조건으로 멱등.
  중복    같은 (파드, 프로파일, 종류)의 대기 요청이 있으면 부분 유니크 색인이 막는다.
"""
from __future__ import annotations

from datetime import datetime, timedelta

from ..common import config, store
from ..common.i18n import tr
from ..common.redact import redact

SCHEMA = """
CREATE TABLE IF NOT EXISTS admin_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, pod TEXT NOT NULL, profile TEXT NOT NULL, requester TEXT NOT NULL, kind TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL,
  handled_by TEXT, handled_at TEXT, reason TEXT, requester_ack_at TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS admin_requests_pending ON admin_requests (pod, profile, kind) WHERE status='pending';
CREATE INDEX IF NOT EXISTS admin_requests_status ON admin_requests (status, created_at);
CREATE INDEX IF NOT EXISTS admin_requests_requester ON admin_requests (requester, status);
"""
KINDS = ("model_change", "profile_limit", "office_seat", "archive_restore", "channel_apply", "other")
DETAIL_MAX, REASON_MAX = 300, 300
ADMIN_LIST_MAX = 200
STALE_DAYS = 7
ADMIN_PREFIX, RESULT_PREFIX = "areq|", "areq_res|"


class RequestError(ValueError):
    """사용자에게 그대로 보이는 거절 사유. code 는 HTTP 상태."""

    def __init__(self, message: str, code: int = 400):
        super().__init__(message)
        self.code = code


def _int_env(name: str, default: int) -> int:
    try:
        return max(1, int(config.get(name, str(default))))
    except ValueError:
        return default


def pending_max() -> int:
    return _int_env("AAS_REQUEST_PENDING_MAX", 10)


def result_days() -> int:
    return _int_env("AAS_REQUEST_RESULT_DAYS", 7)


def keep_days() -> int:
    return _int_env("AAS_REQUEST_KEEP_DAYS", 90)


def _now() -> datetime:
    return datetime.now().astimezone()


def _iso(dt: datetime) -> str:
    return dt.isoformat(timespec="seconds")


def _conn():
    conn = store.connect()
    conn.executescript(SCHEMA)
    return conn


def create(pod: str, profile: str, requester: str, kind: str, detail: str, now: datetime | None = None) -> int:
    """요청을 만든다. 종류가 목록에 없거나 사용자당 대기 상한을 넘거나 같은 요청이 이미 대기 중이면 RequestError."""
    if kind not in KINDS:
        raise RequestError(tr("알 수 없는 요청 종류입니다", "Unknown request type"))
    who = (requester or "").lower()
    with _conn() as conn:
        waiting = conn.execute("SELECT COUNT(*) FROM admin_requests WHERE requester=? AND status='pending'", (who,)).fetchone()[0]
        if waiting >= pending_max():
            raise RequestError(tr(f"처리를 기다리는 요청이 {pending_max()}건 있습니다. 처리된 뒤에 다시 요청하세요", f"You already have {pending_max()} requests waiting. Request again after some are handled"), 429)
        made = conn.execute("INSERT INTO admin_requests (pod, profile, requester, kind, detail, status, created_at) VALUES (?,?,?,?,?,'pending',?) "
                            "ON CONFLICT DO NOTHING RETURNING id",
                            (pod, profile, who, kind, redact(" ".join(str(detail or "").split()), DETAIL_MAX), _iso(now or _now()))).fetchone()
    if made is None:
        raise RequestError(tr("이미 같은 요청이 처리를 기다리고 있습니다", "The same request is already waiting to be handled"), 409)
    return int(made[0])


def prune(now: datetime | None = None) -> None:
    """처리·거절된 지 보관 기간이 지난 행을 지운다."""
    cut = _iso((now or _now()) - timedelta(days=keep_days()))
    with _conn() as conn:
        conn.execute("DELETE FROM admin_requests WHERE status<>'pending' AND handled_at < ?", (cut,))


def _days_between(since: str, now: datetime) -> int:
    try:
        return max(0, (now - datetime.fromisoformat(since)).days)
    except ValueError:
        return 0


def admin_items(label_of, now: datetime | None = None, name_of=None) -> list[dict]:
    """관리자 받은편지함 항목: 처리 대기 요청, 오래된 것부터, 200건까지. label_of(pod, profile) → 표시 이름.
    name_of(email) → 요청자의 사람 이름(requester_name). 화면은 이름을 보이고 이메일은 풍선말로 둔다(2026-10-30 사용자 지시)."""
    now = now or _now()
    with _conn() as conn:
        rows = [dict(r) for r in conn.execute("SELECT * FROM admin_requests WHERE status='pending' ORDER BY created_at, id LIMIT ?", (ADMIN_LIST_MAX,))]
    out = []
    for r in rows:
        days = _days_between(r["created_at"], now)
        out.append({"id": f"{ADMIN_PREFIX}{r['id']}", "kind": "admin_request", "req_kind": r["kind"], "pod": r["pod"], "profile": r["profile"],
                    "alias": label_of(r["pod"], r["profile"]), "requester": r["requester"],
                    "requester_name": name_of(r["requester"]) if name_of else r["requester"], "text": r["detail"],
                    "waiting_days": days, "stale": days >= STALE_DAYS, "at": datetime.fromisoformat(r["created_at"]).timestamp()})
    return out


def result_items(requester: str, label_of, now: datetime | None = None) -> list[dict]:
    """요청자 받은편지함 항목: 결과가 나왔고 아직 확인하지 않은 자기 요청. 처리한 관리자 이름은 넣지 않는다."""
    now = now or _now()
    cut = _iso(now - timedelta(days=result_days()))
    with _conn() as conn:
        rows = [dict(r) for r in conn.execute("SELECT * FROM admin_requests WHERE requester=? AND status<>'pending' AND requester_ack_at IS NULL "
                                              "AND handled_at >= ? ORDER BY handled_at, id", ((requester or "").lower(), cut))]
    return [{"id": f"{RESULT_PREFIX}{r['id']}", "kind": "admin_request_result", "req_kind": r["kind"], "status": r["status"], "pod": r["pod"],
             "profile": r["profile"], "alias": label_of(r["pod"], r["profile"]), "text": r["detail"], "reason": r["reason"] or "",
             "at": datetime.fromisoformat(r["handled_at"]).timestamp()} for r in rows]


def signal_rows(requester: str) -> list[tuple]:
    """받은편지함 바뀜 번호(스펙 2026-10-17-004)에 쓰는 줄: 처리 대기 요청과, 이 사람이 아직 확인하지 않은 자기 요청의 (id, 상태).
    받은편지함 신호가 사람마다 15초마다 읽어 표 캐시로 읽는다(스펙 2026-10-26-002 §9-14)."""
    from ..common import table_cache
    who = (requester or "").lower()

    def read() -> list[tuple]:
        with _conn() as conn:
            return [tuple(r) for r in conn.execute("SELECT id, status FROM admin_requests WHERE status='pending' OR (requester=? AND requester_ack_at IS NULL) "
                                                   "ORDER BY id LIMIT ?", (who, ADMIN_LIST_MAX * 2))]
    return table_cache.get(f"admin_requests.signal:{who}", ("admin_requests",), read, clone=list)


def pending_count() -> int:
    with _conn() as conn:
        return int(conn.execute("SELECT COUNT(*) FROM admin_requests WHERE status='pending'").fetchone()[0])


def waiting_for(requester: str, pod: str) -> list[dict]:
    """이 사람이 이 파드에서 기다리는 요청(막힌 자리에 「처리 대기 중」을 보일 때)."""
    now = _now()
    with _conn() as conn:
        rows = [dict(r) for r in conn.execute("SELECT profile, kind, created_at FROM admin_requests WHERE requester=? AND pod=? AND status='pending'",
                                              ((requester or "").lower(), pod))]
    return [{"profile": r["profile"], "kind": r["kind"], "waiting_days": _days_between(r["created_at"], now)} for r in rows]


def decide(item_id: str, status: str, admin: str, reason: str, now: datetime | None = None) -> None:
    """관리자가 처리(handled)하거나 거절(declined)한다. 이미 처리됐으면 RequestError(409)."""
    rid = _id_of(item_id, ADMIN_PREFIX)
    if status not in ("handled", "declined") or rid is None:
        raise RequestError(tr("알 수 없는 요청", "Unknown request"))
    with _conn() as conn:
        done = conn.execute("UPDATE admin_requests SET status=?, handled_by=?, handled_at=?, reason=? WHERE id=? AND status='pending'",
                            (status, (admin or "").lower(), _iso(now or _now()), redact(" ".join(str(reason or "").split()), REASON_MAX), rid))
        if done.rowcount != 1:
            raise RequestError(tr("이미 처리된 요청입니다", "This request was already handled"), 409)


def ack(item_id: str, requester: str) -> None:
    """요청자가 결과를 확인한다. 본인 요청이 아니면 RequestError(403). 두 번 눌러도 같은 결과(멱등)."""
    rid = _id_of(item_id, RESULT_PREFIX)
    if rid is None:
        raise RequestError(tr("알 수 없는 요청", "Unknown request"))
    with _conn() as conn:
        row = conn.execute("SELECT requester FROM admin_requests WHERE id=?", (rid,)).fetchone()
        if row is None or row[0] != (requester or "").lower():
            raise RequestError(tr("이 알림을 확인할 수 있는 사람이 아닙니다", "You cannot acknowledge this notice"), 403)
        conn.execute("UPDATE admin_requests SET requester_ack_at=? WHERE id=? AND requester_ack_at IS NULL AND status<>'pending'", (_iso(_now()), rid))


def _id_of(item_id: str, prefix: str) -> int | None:
    tail = item_id[len(prefix):] if item_id.startswith(prefix) else ""
    return int(tail) if tail.isdigit() else None
