# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""관리자 공지(스펙 2026-10-24-007). 관리자가 기간·종류·대상(전체 또는 부서)을 정해 올린 공지를 저장하고,
지금 보일 공지를 사람마다 골라 준다. 시각은 UTC 로 저장하고 서버 시각으로 판정한다(A2).
- 사람에게 가는 칸은 PUBLIC 뿐이다. 대상·쓴 사람은 관리자 목록만 준다(O7).
- 토픽 값은 공지 목록과 {이메일: 부서 키} 맵을 함께 갖고, 사람별 거르기는 맵에서 찾기만 한다(R6). 맵은 사람에게 보내지 않는다.
- 사람별 거르기에서도 끝 시각을 다시 본다. 읽기가 실패한 주기에도 끝난 공지가 남지 않게 한다(O4)."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from ..common import store, table_cache
from ..common.i18n import tr

KINDS = ("outage", "maintenance", "deprecation", "feature", "info")   # 띠에 보이는 순서(4-5)
TITLE_MAX, BODY_MAX, LINK_MAX = 80, 300, 500
LIST_LIMIT = 1000                                                    # 관리 목록은 최근 1,000행(R3)
EXTEND = timedelta(hours=1)                                          # 「1시간 연장」(3A)
PUBLIC = ("id", "kind", "title", "body", "link", "starts_at", "ends_at", "dismissible", "updated_ts", "reshow_ts")

SCHEMA = ("CREATE TABLE IF NOT EXISTS notices (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, title TEXT NOT NULL, "
          "body TEXT NOT NULL DEFAULT '', link TEXT NOT NULL DEFAULT '', starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, "
          "audience TEXT NOT NULL DEFAULT 'all', dismissible INTEGER NOT NULL DEFAULT 1, deleted INTEGER NOT NULL DEFAULT 0, "
          "author TEXT NOT NULL DEFAULT '', ts TEXT NOT NULL, editor TEXT NOT NULL DEFAULT '', updated_ts TEXT NOT NULL, reshow_ts TEXT NOT NULL)")


class NoticeError(ValueError):
    """field: 화면 서랍의 칸 이름(E9). code: HTTP 상태. reason: 화면이 종류를 가리는 값."""

    def __init__(self, message: str, field: str = "", code: int = 400, reason: str = ""):
        super().__init__(message)
        self.field, self.code, self.reason = field, code, reason


def now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat()


def parse_time(value, field: str) -> datetime:
    """시간대가 붙은 ISO 시각만 받는다(화면은 브라우저 시간대를 붙여 보낸다, A2)."""
    text = str(value or "").strip()
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        dt = None
    if dt is None or dt.tzinfo is None:
        raise NoticeError(tr("시각을 읽을 수 없습니다", "Cannot read the time"), field)
    return dt.astimezone(timezone.utc)


def key(name) -> str:
    """부서 비교용 키 — office.team_key 와 같은 규칙(앞뒤·겹친 공백을 줄이고 대소문자를 가리지 않는다)."""
    return " ".join(str(name or "").split()).casefold()


def _one_line(value, limit: int, field: str) -> str:
    """한 줄 글(줄바꿈·겹친 공백을 하나로). 제목은 비울 수 없다."""
    text = " ".join(str(value or "").split())
    if field == "title" and not text:
        raise NoticeError(tr("제목을 적으세요", "Enter the title"), field)
    if len(text) > limit:
        raise NoticeError(tr(f"제목은 {limit}자까지 쓸 수 있습니다", f"The title can be up to {limit} characters") if field == "title"
                          else tr(f"글은 {limit}자까지 쓸 수 있습니다", f"The text can be up to {limit} characters"), field)
    return text


def check_link(value) -> str:
    """AAS 안 경로(#/…)와 http(s) 주소만 받는다(A1). 나머지 스킴(javascript: 등)은 거절한다."""
    link = str(value or "").strip()
    if not link:
        return ""
    if len(link) > LINK_MAX or any(c in link for c in "\r\n\t <>\"'"):
        raise NoticeError(tr("쓸 수 없는 주소입니다", "This address cannot be used"), "link")
    low = link.lower()
    if not (link.startswith("#/") or low.startswith("http://") or low.startswith("https://")):
        raise NoticeError(tr("주소는 #/ 로 시작하는 화면 경로나 http(s) 주소만 쓸 수 있습니다",
                              "Use a screen path starting with #/ or an http(s) address"), "link")
    return link


def check_audience(value, known: list[str]) -> str:
    """'all' 또는 부서 이름 목록(JSON 글로 저장). 부서는 목록에 있는 것만, team_key 로 중복을 없앤다(Q-c)."""
    if value == "all" or value is None:
        return "all"
    if not isinstance(value, list):
        raise NoticeError(tr("대상을 고르세요", "Choose who sees it"), "audience")
    by_key = {key(n): n for n in known}
    out: list[str] = []
    for item in value:
        name = by_key.get(key(item))
        if name is None:
            raise NoticeError(tr(f"없는 부서입니다: {item}", f"No such department: {item}"), "audience")
        if name not in out:
            out.append(name)
    if not out:
        raise NoticeError(tr("대상 부서를 하나 이상 고르거나 전체로 두세요", "Choose at least one department, or everyone"), "audience")
    return json.dumps(out, ensure_ascii=False)


def audience_of(raw: str):
    if raw == "all":
        return "all"
    try:
        names = json.loads(raw)
    except ValueError:
        return []
    return [str(n) for n in names] if isinstance(names, list) else []


def status(row: dict, at: datetime) -> str:
    if row.get("deleted"):
        return "deleted"
    if at >= parse_time(row["ends_at"], "ends_at"):
        return "ended"
    if at < parse_time(row["starts_at"], "starts_at"):
        return "scheduled"
    return "active"


def _row(r) -> dict:
    d = dict(r)
    d["dismissible"] = bool(d.get("dismissible"))
    d["deleted"] = bool(d.get("deleted"))
    return d


def public(row: dict) -> dict:
    return {k: row[k] for k in PUBLIC}


def admin_view(row: dict, at: datetime) -> dict:
    return {**public(row), "audience": audience_of(row["audience"]), "status": status(row, at), "author": row["author"],
            "ts": row["ts"], "editor": row["editor"], "deleted": row["deleted"]}


def _order(rows: list[dict]) -> list[dict]:
    """종류 순서(장애 → 작업 → 중단 예정 → 새 기능 → 안내), 같은 종류는 시작이 늦은(새) 것 먼저(4-5)."""
    rank = {k: i for i, k in enumerate(KINDS)}
    return sorted(sorted(rows, key=lambda r: r["starts_at"], reverse=True), key=lambda r: rank.get(r["kind"], len(KINDS)))


def _get(conn, nid: int) -> dict | None:
    r = conn.execute("SELECT * FROM notices WHERE id=?", (nid,)).fetchone()
    return _row(r) if r is not None else None


def save(body: dict, who: str, known_departments: list[str], at: datetime | None = None) -> dict:
    """만들기(id 없음)·고치기(id 있음). 검사를 통과한 행을 돌려준다. 장애는 닫을 수 없다(Q-a, Q3).
    reshow 가 참이면 reshow_ts 를 지금으로 바꿔 닫은 사람에게 다시 보인다(3C). 아니면 그대로 둔다."""
    at = at or now()
    kind = str(body.get("kind") or "")
    if kind not in KINDS:
        raise NoticeError(tr("공지 종류를 고르세요", "Choose the notice type"), "kind")
    title = _one_line(body.get("title"), TITLE_MAX, "title")
    text = _one_line(body.get("body"), BODY_MAX, "body")
    link = check_link(body.get("link"))
    starts = parse_time(body.get("starts_at"), "starts_at")
    ends = parse_time(body.get("ends_at"), "ends_at")
    if ends <= starts:
        raise NoticeError(tr("끝 시각은 시작 시각보다 뒤여야 합니다", "The end must be after the start"), "ends_at")
    audience = check_audience(body.get("audience", "all"), known_departments)
    dismissible = kind != "outage" and bool(body.get("dismissible", True))
    stamp, nid = _iso(at), body.get("id")
    values = (kind, title, text, link, _iso(starts), _iso(ends), audience, 1 if dismissible else 0)
    with store.connect() as conn:
        conn.execute(SCHEMA)
        if nid in (None, "", 0):
            if ends <= at:
                raise NoticeError(tr("끝 시각이 이미 지났습니다", "The end time has already passed"), "ends_at")
            row = conn.execute("INSERT INTO notices (kind, title, body, link, starts_at, ends_at, audience, dismissible, deleted, author, ts, editor, "
                               "updated_ts, reshow_ts) VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?,?) RETURNING id",
                               (*values, who, stamp, who, stamp, stamp)).fetchone()
            return _get(conn, int(row[0]))
        try:
            nid = int(nid)
        except (TypeError, ValueError):
            raise NoticeError(tr("없는 공지입니다", "No such notice"), code=404) from None
        old = _get(conn, nid)
        if old is None or old["deleted"]:
            raise NoticeError(tr("없는 공지입니다", "No such notice"), code=404)
        reshow = stamp if body.get("reshow") else old["reshow_ts"]
        conn.execute("UPDATE notices SET kind=?, title=?, body=?, link=?, starts_at=?, ends_at=?, audience=?, dismissible=?, editor=?, updated_ts=?, "
                     "reshow_ts=? WHERE id=?", (*values, who, stamp, reshow, nid))
        return _get(conn, nid)


def remove(nid, who: str, at: datetime | None = None) -> dict:
    """「지금 내리기」: 지우지 않고 deleted 로 둔다(원래 기간이 기록에 남게, 4-6)."""
    at = at or now()
    with store.connect() as conn:
        conn.execute(SCHEMA)
        try:
            row = _get(conn, int(nid))
        except (TypeError, ValueError):
            row = None
        if row is None or row["deleted"]:
            raise NoticeError(tr("없는 공지입니다", "No such notice"), code=404)
        conn.execute("UPDATE notices SET deleted=1, editor=?, updated_ts=? WHERE id=?", (who, _iso(at), row["id"]))
        return _get(conn, row["id"])


def extend(nid, seen_ends_at, who: str, at: datetime | None = None) -> dict:
    """「1시간 연장」(3A·E3). 화면이 본 끝 시각과 지금 끝 시각이 같을 때만 1시간 늘린다(두 번 눌러도 2시간이 되지 않게).
    다르면 409. 내렸거나 이미 끝난 공지는 400. 비교는 글자가 아니라 시각으로 한다."""
    at = at or now()
    seen = parse_time(seen_ends_at, "ends_at")
    with store.connect() as conn:
        conn.execute(SCHEMA)
        try:
            row = _get(conn, int(nid))
        except (TypeError, ValueError):
            row = None
        if row is None or row["deleted"]:
            raise NoticeError(tr("없는 공지입니다", "No such notice"), code=404)
        current = parse_time(row["ends_at"], "ends_at")
        if current <= at:
            raise NoticeError(tr("이미 끝난 공지는 연장할 수 없습니다", "An ended notice cannot be extended"), "ends_at")
        if current != seen:
            raise NoticeError(tr("그사이 공지가 바뀌었습니다. 목록을 다시 읽습니다.", "The notice changed in the meantime. Reloading the list."),
                              code=409, reason="changed")
        new_end = _iso(current + EXTEND)
        done = conn.execute("UPDATE notices SET ends_at=?, editor=?, updated_ts=? WHERE id=? AND ends_at=?",
                            (new_end, who, _iso(at), row["id"], row["ends_at"])).rowcount
        if not done:
            raise NoticeError(tr("그사이 공지가 바뀌었습니다. 목록을 다시 읽습니다.", "The notice changed in the meantime. Reloading the list."),
                              code=409, reason="changed")
        return _get(conn, row["id"])


def rows_all(limit: int = LIST_LIMIT) -> list[dict]:
    """관리 목록: 시작이 늦은 순 최근 limit 행(R3)."""
    with store.connect() as conn:
        conn.execute(SCHEMA)
        return [_row(r) for r in conn.execute("SELECT * FROM notices ORDER BY starts_at DESC, id DESC LIMIT ?", (limit,)).fetchall()]


def active_rows(at: datetime | None = None) -> list[dict]:
    """지금 보일 공지(내리지 않았고 시작 ≤ 지금 < 끝). 순서는 띠 순서."""
    at = at or now()
    stamp = _iso(at)

    def read() -> list[dict]:
        # 시각 조건 없이 읽어 캐시한다 — 끝 시각은 아래에서 거른다(시각이 든 결과를 60초 남기면 끝난 공지가 보였다, 스펙 2026-10-26-002 R10)
        with store.connect() as conn:
            conn.execute(SCHEMA)
            return [_row(r) for r in conn.execute("SELECT * FROM notices WHERE deleted=0 ORDER BY starts_at DESC").fetchall()]
    rows = [r for r in table_cache.get("notices.live", ("notices",), read) if str(r["ends_at"]) > stamp]
    return _order([r for r in rows if status(r, at) == "active"])


def visible(rows: list[dict], dept_key: str | None, at: datetime | None = None) -> list[dict]:
    """한 사람에게 보일 공지(사람에게 가는 칸만). dept_key 가 None 이면(부서 없음·로그인 끈 실행) 전체 공지만(4-3).
    끝 시각을 다시 본다(O4)."""
    at = at or now()
    out = []
    for r in rows:
        if parse_time(r["ends_at"], "ends_at") <= at or parse_time(r["starts_at"], "starts_at") > at:
            continue
        aud = audience_of(r["audience"])
        if aud == "all" or (dept_key and dept_key in {key(n) for n in aud}):
            out.append(public(r))
    return out


def for_user(email: str, departments: dict[str, str], at: datetime | None = None) -> list[dict]:
    """/api/me 와 서버 페이지용(R4·R5). departments 는 {이메일: 부서}(settings.departments())."""
    dept = departments.get(str(email or "").lower(), "")
    return visible(active_rows(at), key(dept) or None, at)


def topic_source(departments: dict[str, str]) -> dict:
    """토픽 값: 지금 보일 공지와 {이메일: 부서 키} 맵(R6). 끝 시각을 다시 보려고 행 전체를 둔다(사람에게는 view 결과만 간다)."""
    return {"rows": active_rows(), "people": {e: key(d) for e, d in departments.items() if d}}


def topic_view(value: dict, email: str) -> list[dict]:
    return visible((value or {}).get("rows") or [], ((value or {}).get("people") or {}).get(str(email or "").lower()) or None)


def reach_from(audience, people: list[str]) -> int:
    """대상 사람 수. people 은 사람마다 부서 이름(부서 없으면 빈 글자) 목록이다(R9: Keycloak 기준, 닿지 않으면 user_directory)."""
    aud = audience_of(audience) if isinstance(audience, str) and audience != "all" else audience
    if aud in ("all", None):
        return len(people)
    keys = {key(n) for n in aud}
    return sum(1 for d in people if key(d) in keys)


def directory_people() -> list[str]:
    """Keycloak 에 닿지 않을 때의 대상 사람 수 출처: user_directory 의 모든 사람(부서 없는 사람도, 전체 공지의 수에 든다)."""
    from ..common import settings
    with store.connect() as conn:
        conn.execute(settings._SCHEMA)
        return [str(r["department"] or "") for r in conn.execute("SELECT department FROM user_directory").fetchall()]


def rename_department(conn, old_key: str, new_name: str) -> None:
    """부서 이름 바꾸기 때 공지 대상도 새 이름으로 옮긴다(R7). settings.rename_finish 가 같은 연결로 부른다."""
    conn.execute(SCHEMA)
    for r in conn.execute("SELECT id, audience FROM notices WHERE audience <> 'all'").fetchall():
        names = audience_of(r["audience"])
        if not isinstance(names, list) or not any(key(n) == old_key for n in names):
            continue
        moved: list[str] = []
        for n in names:
            n = new_name if key(n) == old_key else n
            if key(n) not in {key(m) for m in moved}:
                moved.append(n)
        conn.execute("UPDATE notices SET audience=? WHERE id=?", (json.dumps(moved, ensure_ascii=False), r["id"]))


def log_note(who: str, row: dict) -> str:
    """변경 기록 글. 제목에 changes.py 가 잘라 읽는 꼬리(` role=`·` req=`)가 들어가지 않게 지운다(O12)."""
    title = str(row.get("title") or "").replace(" role=", " role:").replace(" req=", " req:")
    return f"{who} {title}"
