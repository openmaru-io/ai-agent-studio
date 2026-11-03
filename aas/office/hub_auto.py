# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""오피스의 칸반·크론 — Hermes 가 원래 가진 대시보드 API 를 AAS 의 오피스 API 로 바꿔 전한다.

Hermes 에는 아무것도 깔지 않는다. 쓰는 것은 대시보드의 `/api/plugins/kanban/*`(Hermes 에 딸려 오는 칸반)와 `/api/cron/jobs`.

여러 설치본을 한 보드로 보이게 하는 법:
  - 오피스의 보드 하나(slug)를 설치본마다 같은 이름의 Hermes 보드로 둔다(카드가 처음 그 설치본에 갈 때 만든다).
  - 카드는 담당 에이전트가 사는 설치본의 보드에 만든다. 보드 보기는 설치본들의 보드를 합친다.
  - 어느 카드가 어느 설치본에 있는지, 마지막으로 본 상태가 무엇이었는지는 AAS DB(office_cards)에 적는다.
  - 한계: 카드를 다른 설치본의 에이전트에게 넘기지는 못한다(그쪽에 새 카드를 만들어야 한다).

이벤트: Hermes 대시보드에는 HTTP 로 읽는 사건 목록이 없다. 그래서 보드를 볼 때마다 지난번과 견주어
"상태가 바뀜 / 일을 시작함 / 끝남"을 만들어 office_events 에 쌓고, 화면은 그 번호(커서)로 이어 읽는다.

실행: 실행을 누르면 대시보드의 dispatch 를 부른다. 그리고 준비·진행 중인 카드가 있는 보드는
서버가 20초마다 dispatch 를 다시 불러 끝까지 밀어 준다(start_ticker. Hermes 의 자체 디스패처 설정은 건드리지 않는다).

경로(AAS 서버가 이 모듈의 route 로 넘긴다):
  /api/office/kanban/…            보드·카드
  /api/office/events              이벤트(커서로 이어 읽기)
  /api/office/cron/<자리 이름>/…   그 자리의 크론 작업
"""
from __future__ import annotations

import json
import re
import threading
import time
from urllib.parse import quote

from . import office
from ..assets.files import mask_line
from ..common import db
from ..common.i18n import tr
from ..hermes import hermes_reader as hr
from ..hermes.hermes_api import HermesAPI, HermesError

COLUMNS = ("triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done")
SLUG = re.compile(r"^[a-z0-9][a-z0-9_-]{0,80}$")
TASK_FIELDS = ("title", "body", "tenant", "priority", "parents", "triage", "idempotency_key", "max_runtime_seconds", "skills", "goal_mode",
               "goal_max_turns", "model_override", "provider_override", "reasoning_effort")
PATCH_FIELDS = ("title", "body", "priority", "result", "summary", "metadata", "model_override", "provider_override", "reasoning_effort", "block_reason")
JOB_KEYS = ("id", "name", "prompt", "schedule", "schedule_display", "repeat", "enabled", "state", "next_run_at", "last_run_at", "last_status",
            "last_error", "deliver", "skills", "model", "provider", "created_at", "script", "paused_at", "paused_reason", "last_delivery_error")
ATTACHMENT_KEYS = ("id", "filename", "size", "content_type", "uploaded_by", "created_at")   # 카드 첨부로 내보내는 값(stored_path 는 뺀다)
# 에이전트가 완료·검토 요청 때 올린 첨부는 Hermes 가 올린 사람을 프로파일이 아닌 이 이름으로 적는다(kanban_db.py _stage_completion_artifacts)
RUN_UPLOADERS = ("kanban_complete", "kanban_request_review")
JOB_UPDATES = ("schedule", "prompt", "name", "deliver", "model", "provider", "enabled", "skills", "repeat")
SCHEMA = """
CREATE TABLE IF NOT EXISTS office_boards (slug TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0, synced INTEGER NOT NULL DEFAULT 0, ts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS office_board_pods (slug TEXT NOT NULL, pod TEXT NOT NULL, PRIMARY KEY (slug, pod));
CREATE TABLE IF NOT EXISTS office_cards (board TEXT NOT NULL, task_id TEXT NOT NULL, pod TEXT NOT NULL, status TEXT NOT NULL DEFAULT '',
  assignee TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', parents INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (board, task_id));
CREATE TABLE IF NOT EXISTS office_events (id INTEGER PRIMARY KEY AUTOINCREMENT, board TEXT NOT NULL, ts REAL NOT NULL, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS office_cron (alias TEXT NOT NULL, job_id TEXT NOT NULL, last_exec TEXT NOT NULL DEFAULT '', last_state TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (alias, job_id));
CREATE TABLE IF NOT EXISTS office_flags (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', ts TEXT NOT NULL DEFAULT '');
"""
KEEP_EVENTS = 5000
# 실행 하나의 「실행한 명령」(스펙 2026-11-03-001 R11·R13·R14·R15, DD3·DD12)
COMMAND_LIMIT = 200                                     # 실행당 명령 수 상한(R14). 질의는 LIMIT 201 로 「더 있음」을 안다
COMMAND_CHARS = 200                                     # 명령 하나의 앞 글자 수(가린 뒤에 자른다 — 자른 뒤 가리면 토큰 모양이 깨져 안 가려질 수 있다)
PENDING_SECONDS = 600                                   # 끝난 지 10분 안이면 대화 기록이 아직 반영되지 않았을 수 있다(DD12, OPERATIONS.md 「이력 뒤처짐」과 같은 값)
DEFAULT_SIDECAR_MAX_ROWS = 20_000                       # 사이드카 한 번의 sqlite 결과 상한(sidecar ops.DEFAULT_MAX_ROWS). LIMIT 201 은 이보다 작아야 한다(외부 검토 M3)
TERMINAL_TOOL = "terminal"                              # Hermes tools/terminal_tool.py 의 도구 이름. 명령은 인자의 "command"
BLOCKED_PREFIX = "BLOCKED:"                             # 막힌 명령의 거절 문구 앞머리(M1, Hermes tools/approval.py)
BLOCKED_HEAD = 300                                      # 막힘 판정에 읽는 도구 결과 앞 글자 수
# 터미널 도구는 거절을 JSON 으로 낸다(tools/terminal_tool.py _error_json: {"output": "", "exit_code": -1, "error": "BLOCKED: …", "status": "blocked"}).
# 2026-11-03 OKE 카나리아에서 앞머리만 보던 판정이 이 모양을 놓쳤다. 출력에 BLOCKED: 가 섞인 것은 막힘이 아니므로 error 값의 앞머리를 본다
_BLOCKED_JSON = re.compile(r'^\{\s*"output":\s*"",\s*"exit_code":\s*-1,\s*"error":\s*"BLOCKED:')
_PROFILE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
MAX_RUN_SESSIONS = 50                                   # 실행 하나의 대화 수(압축으로 늘어난다). 질의 인자 수를 묶어 둔다
ON_CARDS_CHANGED: list = []                             # 카드 표가 바뀐 뒤 부른다(서버가 토픽 office:cards·받은편지함을 다시 읽게 한다, 스펙 2026-10-17-004)
DEFAULT_BOARD = "default"                                # 서버가 처음 한 번 만드는 보드(OMAI-1286)


def ensure_default_board(has_pods: bool) -> bool:
    """에이전트가 생기면 칸반을 바로 쓰게 기본 보드를 한 번만 만든다(OMAI-1286). 만들었으면 True.
    보드가 이미 있는 설치나 한 번 만든 뒤(관리자가 보관·삭제해도)에는 다시 만들지 않는다 — 표시를 office_flags 에 남긴다.
    Hermes 쪽 보드는 카드가 그 설치본에 처음 갈 때 만든다(ensure_on_pod). 서버 복제본 둘이 함께 불러도 하나만 생긴다."""
    if not has_pods:
        return False
    with _db() as conn:
        if conn.execute("SELECT 1 FROM office_flags WHERE key='default_board'").fetchone():
            return False
        made = 0
        if not conn.execute("SELECT 1 FROM office_boards LIMIT 1").fetchone():
            made = conn.execute("INSERT INTO office_boards (slug, name, ts) VALUES (?,?,?) ON CONFLICT DO NOTHING",
                                (DEFAULT_BOARD, tr("기본 보드", "Default board"), office._now())).rowcount
        conn.execute("INSERT INTO office_flags (key, value, ts) VALUES ('default_board', ?, ?) ON CONFLICT DO NOTHING",
                     (DEFAULT_BOARD if made else "", office._now()))
    return bool(made)


class Fail(Exception):
    """화면에 돌려줄 거절. 본문은 {"error": 코드, "detail": 설명}."""

    def __init__(self, status: int, code: str, detail: str = ""):
        super().__init__(code)
        self.status, self.code, self.detail = status, code, detail


_cards_gen = [0]                 # 이 서버가 카드 표를 쓴 횟수 — 진행 카드 기억(server._running_cards)이 쓴 뒤 바로 다시 읽게(스펙 2026-10-26-002 R5)
_cards_gen_lock = threading.Lock()


def cards_gen() -> int:
    return _cards_gen[0]


def cards_written() -> None:
    with _cards_gen_lock:
        _cards_gen[0] += 1


def _db():
    conn = office.connect()
    conn.executescript(SCHEMA)
    return conn


def _now_ts() -> float:
    """지금 시각(초). 시험이 바꿔 넣는다."""
    return time.time()


def _mask_text(value):
    """줄바꿈은 그대로 두고 줄마다 비밀값 모양을 가린다(assets.files.mask_line). 문자열이 아니면 건드리지 않는다."""
    if not isinstance(value, str):
        return value
    return "".join(mask_line(line) for line in value.splitlines(keepends=True))


def _mask_fields(item, *keys):
    """딕셔너리의 문자열 필드만 가린 복사본. 딕셔너리가 아니거나 없는 필드는 그대로 둔다."""
    if not isinstance(item, dict):
        return item
    out = dict(item)
    for key in keys:
        if isinstance(out.get(key), str):
            out[key] = _mask_text(out[key])
    return out


class Auto:
    def __init__(self, bridge, api_factory=None):
        self.bridge = bridge
        self._api = api_factory or (lambda pod_id: HermesAPI(bridge.hub(pod_id).auth))
        self._synced_at: dict[str, float] = {}
        self._cron_at = 0.0
        self._lock = threading.RLock()
        self.allowed = None                                       # (이메일, 자리 이름) → 그 사람이 지금도 그 에이전트를 시킬 수 있는가. 서버가 넣는다(003 §8-1)

    # ---- 공통 -------------------------------------------------------------
    def api(self, pod: str) -> HermesAPI:
        return self._api(pod)

    def call(self, pod: str, method: str, path: str, body=None, query=None):
        """대시보드 호출. Hermes 의 거절을 화면이 아는 코드로 바꾼다."""
        try:
            return self.api(pod).call(method, path, body, query)
        except HermesError as exc:
            code = {404: "task_not_found", 409: "invalid_transition", 400: "invalid_field", 422: "invalid_field"}.get(exc.code, "hermes_unavailable")
            raise Fail(exc.code if exc.code in (400, 404, 409) else (400 if exc.code == 422 else 503), code, str(exc)) from None
        except Exception as exc:                              # 로그인 실패 등(ChatUnavailable)
            raise Fail(503, "hermes_unavailable", str(exc)[:200]) from None

    def seats(self) -> dict[str, dict]:
        return self.bridge.routes()

    def default_pod(self) -> str:
        pods = [p.id for p in self.bridge.registry.pods]
        if not pods:
            raise Fail(503, "hermes_unavailable", tr("등록된 Hermes 설치본이 없습니다", "No Hermes installation is registered"))
        return pods[0]

    def alias_of(self, pod: str, profile) -> str:
        """Hermes 쪽 이름(설치본·프로파일) → 오피스의 자리 이름. 자리가 아니면 그 이름 그대로."""
        if not profile:
            return ""
        for alias, seat in self.seats().items():
            if seat["pod"] == pod and seat["profile"] == profile:
                return alias
        return str(profile)

    def seat_of(self, alias: str) -> dict:
        seat = self.seats().get(alias)
        if not seat:
            raise Fail(400, "profile_not_found", tr(f"오피스에 앉지 않은 이름입니다: {alias}", f"Not an AI Agent in the office: {alias}"))
        return seat

    # ---- 보드 -------------------------------------------------------------
    def board_row(self, slug: str) -> dict:
        if not slug:
            raise Fail(400, "board_required")
        with _db() as conn:
            row = conn.execute("SELECT * FROM office_boards WHERE slug=?", (slug,)).fetchone()
        if not row:
            raise Fail(404, "board_not_found")
        return dict(row)

    def board_pods(self, slug: str) -> list[str]:
        with _db() as conn:
            return [r["pod"] for r in conn.execute("SELECT pod FROM office_board_pods WHERE slug=? ORDER BY pod", (slug,))]

    def ensure_on_pod(self, slug: str, pod: str) -> None:
        if pod in self.board_pods(slug):
            return
        row = self.board_row(slug)
        self.call(pod, "POST", "/api/plugins/kanban/boards", {"slug": slug, "name": row["name"] or slug, "description": "AAS 오피스 보드"})  # i18n-ignore: Hermes 에 저장되는 보드 설명
        with _db() as conn:
            conn.execute("INSERT INTO office_board_pods VALUES (?,?) ON CONFLICT DO NOTHING", (slug, pod))

    def meta(self, row: dict) -> dict:
        with _db() as conn:
            counts = {r["status"]: r["n"] for r in conn.execute("SELECT status, COUNT(*) n FROM office_cards WHERE board=? GROUP BY status", (row["slug"],))}
        return {"slug": row["slug"], "name": row["name"], "description": row["description"], "is_current": False, "archived": bool(row["archived"]),
                "counts": counts, "total": sum(n for s, n in counts.items() if s != "archived")}

    def create_board(self, body: dict) -> tuple[int, dict]:
        slug, name = str(body.get("slug") or ""), " ".join(str(body.get("name") or "").split())[:120]
        if not SLUG.match(slug):
            raise Fail(400, "invalid_field", "slug")
        with _db() as conn:
            fresh = conn.execute("INSERT INTO office_boards (slug, name, ts) VALUES (?,?,?) ON CONFLICT DO NOTHING", (slug, name or slug, office._now())).rowcount
        try:
            self.ensure_on_pod(slug, self.default_pod())          # 담당 없는 카드가 갈 곳
        except Fail:
            pass                                               # 그 설치본이 잠깐 안 닿아도 보드는 만든다 — 카드를 만들 때 다시 시도한다
        return (201 if fresh else 200), {"board": self.meta(self.board_row(slug))}

    def list_boards(self, include_archived: bool) -> dict:
        with _db() as conn:
            rows = [dict(r) for r in conn.execute("SELECT * FROM office_boards ORDER BY ts")]
        return {"boards": [self.meta(r) for r in rows if include_archived or not r["archived"]], "current": None}

    def patch_board(self, slug: str, body: dict) -> dict:
        row = self.board_row(slug)
        name = " ".join(str(body["name"]).split())[:120] if isinstance(body.get("name"), str) and body["name"].strip() else row["name"]
        desc = str(body["description"])[:400] if isinstance(body.get("description"), str) else row["description"]
        archived = int(bool(body["archived"])) if "archived" in body else row["archived"]
        with _db() as conn:
            conn.execute("UPDATE office_boards SET name=?, description=?, archived=? WHERE slug=?", (name, desc, archived, slug))
        for pod in self.board_pods(slug):                      # Hermes 쪽 이름도 맞춘다(실패해도 오피스는 계속)
            try:
                self.call(pod, "PATCH", f"/api/plugins/kanban/boards/{quote(slug, safe='')}", {"name": name, "archived": bool(archived)})
            except Fail:
                pass
        return {"board": self.meta(self.board_row(slug))}

    # ---- 카드 -------------------------------------------------------------
    def task_out(self, pod: str, task: dict) -> dict:
        # 카드 객체에도 에이전트가 쓴 글(최근 요약·결과·막힌 사유)이 실려 나간다. 보드 목록·상세·만들기 응답 모두 같은 길이라 여기서 가린다.
        # 사람이 쓴 title·body 는 그대로 둔다(계획 2026-10-14-024 R3·R7, OKE 시험 T5 에서 발견)
        out = _mask_fields(dict(task), "latest_summary", "result", "block_reason")
        out["assignee"] = self.alias_of(pod, task.get("assignee")) or None
        out.setdefault("link_counts", {"parents": 0, "children": 0})
        for key in ("comment_count", "progress", "warnings", "review"):
            out.setdefault(key, 0 if key == "comment_count" else None)
        return out

    def fetch(self, slug: str, include_archived: bool = True) -> tuple[list[tuple[str, dict]], set[str], set[str]]:
        """(설치본, 카드)들, 테넌트, 닿은 설치본. 안 닿는 설치본은 건너뛴다."""
        cards, tenants, reached = [], set(), set()
        for pod in self.board_pods(slug):
            try:
                data = self.call(pod, "GET", "/api/plugins/kanban/board", query={"board": slug, "include_archived": "true" if include_archived else None})
            except Fail:
                continue
            reached.add(pod)
            tenants.update(str(t) for t in data.get("tenants") or [] if t)
            for col in data.get("columns") or []:
                for task in col.get("tasks") or []:
                    if isinstance(task, dict) and task.get("id"):
                        cards.append((pod, task))
        return cards, tenants, reached

    def board_view(self, slug: str, include_archived: bool) -> dict:
        self.board_row(slug)
        cards, tenants, reached = self.fetch(slug)
        self._diff(slug, cards, reached)
        names = COLUMNS + (("archived",) if include_archived else ())
        cols = {n: [] for n in names}
        for pod, task in cards:
            if task.get("status") in cols:
                cols[task["status"]].append(self.task_out(pod, task))
        for tasks in cols.values():
            tasks.sort(key=lambda t: (-(t.get("priority") or 0), t.get("created_at") or 0))
        return {"columns": [{"name": n, "tasks": cols[n]} for n in names], "tenants": sorted(tenants),
                "assignees": sorted({t["assignee"] for ts in cols.values() for t in ts if t.get("assignee")}),
                "latest_event_id": self._last_event(), "now": int(time.time())}

    def pod_of(self, slug: str, task_id: str) -> str:
        self.board_row(slug)
        with _db() as conn:
            row = conn.execute("SELECT pod FROM office_cards WHERE board=? AND task_id=?", (slug, task_id)).fetchone()
        if row:
            return row["pod"]
        for pod in self.board_pods(slug):                      # 아직 적어 두지 않은 카드 — 설치본마다 물어본다
            try:
                self.call(pod, "GET", f"/api/plugins/kanban/tasks/{quote(task_id, safe='')}", query={"board": slug})
                return pod
            except Fail:
                continue
        raise Fail(404, "task_not_found")

    def detail(self, slug: str, task_id: str, pod: str = "") -> dict:
        pod = pod or self.pod_of(slug, task_id)
        d = self.call(pod, "GET", f"/api/plugins/kanban/tasks/{quote(task_id, safe='')}", query={"board": slug})
        links = d.get("links") if isinstance(d.get("links"), dict) else {}
        # 에이전트가 쓴 글(실행 요약·오류, 댓글, 막힘 사유)은 토큰 모양을 가려서 내보낸다(계획 2026-10-14-024 R3·R7). 줄바꿈은 그대로 둔다
        # 댓글 작성자도 실행 기록처럼 프로파일(예: main)을 자리 별칭으로 바꾼다. 화면이 별칭을 에이전트 이름으로 보인다
        comments = [{**c, "author": self.alias_of(pod, c["author"])} if isinstance(c, dict) and c.get("author") else c
                    for c in (_mask_fields(c, "body") for c in d.get("comments") or [])]
        events = [{**e, "payload": _mask_fields(e["payload"], "reason")} if isinstance(e, dict) and isinstance(e.get("payload"), dict) else e
                  for e in d.get("events") or []]
        runs = [{**_mask_fields(r, "summary", "error"), "profile": self.alias_of(pod, r.get("profile"))} for r in d.get("runs") or [] if isinstance(r, dict)]
        return {"task": self.task_out(pod, d.get("task") or {}), "comments": comments, "events": events, "attachments": self.attachments_out(pod, d.get("attachments"), runs, (d.get("task") or {}).get("assignee")),
                "links": {"parents": links.get("parents") or [], "children": links.get("children") or []}, "runs": runs}

    def attachments_out(self, pod: str, raw, runs: list | None = None, assignee=None) -> list[dict]:
        """카드 첨부 목록(스펙 office/kanban-card-structured-brief §3-9, R6). Hermes 카드 상세가 이미 준 값만 쓴다(추가 호출 없음).
        Hermes 파드 안의 절대 경로(stored_path)는 내보내지 않는다. 올린 프로파일은 자리 이름으로 바꾼다. 최근 것부터.
        에이전트가 완료 때 올린 첨부(uploaded_by=kanban_complete 등)는 그 시각까지 시작한 가장 최근 실행의 프로파일로 바꾼다.
        실행이 없으면 카드 담당. 화면이 이 값을 에이전트 칩으로 보이기 때문이다(OKE 확인 2026-10-18, §8-4)."""
        def num(v) -> float:
            try:
                return float(v)
            except (TypeError, ValueError):
                return 0.0
        out = [{k: a.get(k) for k in ATTACHMENT_KEYS} for a in (raw if isinstance(raw, list) else []) if isinstance(a, dict) and a.get("id") is not None]
        for a in out:
            if a["uploaded_by"] in RUN_UPLOADERS:
                done = [r for r in runs or [] if r.get("profile") and num(r.get("started_at")) <= num(a["created_at"])]
                runner = max(done, key=lambda r: num(r.get("started_at")))["profile"] if done else ""
                a["uploaded_by"] = runner or self.alias_of(pod, assignee) or a["uploaded_by"]
            else:
                a["uploaded_by"] = self.alias_of(pod, a["uploaded_by"]) or a["uploaded_by"]
        out.sort(key=lambda a: (num(a["created_at"]), num(a["id"])), reverse=True)
        return out

    def create_task(self, slug: str, body: dict) -> dict:
        self.board_row(slug)
        if not str(body.get("title") or "").strip():
            raise Fail(400, "missing_field", "title")
        alias = str(body.get("assignee") or "")
        seat = self.seat_of(alias) if alias else None
        pod = seat["pod"] if seat else self.default_pod()
        self.ensure_on_pod(slug, pod)
        payload = {k: body[k] for k in TASK_FIELDS if body.get(k) is not None}
        if "priority" in payload:
            try:
                payload["priority"] = int(payload["priority"])
            except (TypeError, ValueError):
                payload.pop("priority")
        if seat:
            payload["assignee"] = seat["profile"]
        else:
            payload["triage"] = True                           # 담당 없는 카드를 준비 칸에 두면 Hermes 가 기본 프로파일에게 맡겨 돌려 버린다
        res = self.call(pod, "POST", "/api/plugins/kanban/tasks", payload, {"board": slug})
        tid = str((res.get("task") or res).get("id") or "")
        if not tid:
            raise Fail(503, "hermes_unavailable", tr("카드를 만들었다는 답을 받지 못했습니다", "Did not receive confirmation that the card was created"))
        self.sync(slug, force=True)
        return {"task": self.detail(slug, tid, pod)["task"]}

    def patch_task(self, slug: str, task_id: str, body: dict) -> dict:
        pod = self.pod_of(slug, task_id)
        if body.get("status") == "running":
            raise Fail(409, "invalid_transition", tr("진행 중으로는 직접 옮길 수 없습니다 — 실행을 누르세요", "Cannot move a card to In progress directly. Use Run."))
        payload = {k: body[k] for k in PATCH_FIELDS if k in body and body[k] is not None}
        if "priority" in payload:
            try:
                payload["priority"] = int(payload["priority"])
            except (TypeError, ValueError):
                payload.pop("priority")
        if body.get("status"):
            payload["status"] = str(body["status"])
        if body.get("assignee"):
            payload["assignee"] = self._same_pod(pod, str(body["assignee"]))
        if payload:
            self.call(pod, "PATCH", f"/api/plugins/kanban/tasks/{quote(task_id, safe='')}", payload, {"board": slug})
        self.sync(slug, force=True)
        return {"task": self.detail(slug, task_id, pod)["task"]}

    def _other_pod(self, alias: str, seat: dict) -> Fail:
        name, pod = office.seat_labels().get(alias, alias), office.agent_label(seat["pod"])   # 설치본 id 대신 이름(스펙 2026-10-19-003)
        return Fail(409, "invalid_transition", tr(f"{name} 는 다른 AI 에이전트 작업공간({pod})의 프로파일입니다. 카드를 넘길 수 없으니 그 프로파일 앞으로 새 카드를 만드세요.",
                                                  f"{name} is a profile in another AI Agent Workspace ({pod}). The card cannot be reassigned; create a new card for that profile."))

    def _same_pod(self, pod: str, alias: str) -> str:
        seat = self.seat_of(alias)
        if seat["pod"] != pod:
            raise self._other_pod(alias, seat)
        return seat["profile"]

    def _move_unassigned(self, slug: str, task_id: str, pod: str, alias: str) -> dict:
        """담당 없이 만든 분류 대기 카드를 다른 설치본의 에이전트에게 넘긴다.
        담당 없는 카드는 기본 설치본(`default_pod`)에 생기는데, 그 설치본이 에이전트의 설치본과 다르면 Hermes 의 reassign 이 닿지 않는다.
        시작하지 않은 카드(분류 대기·담당 없음·연결 없음)만 대상 설치본에 새로 만들고 댓글을 옮긴 뒤 옛 카드를 지운다. 카드 번호가 바뀐다."""
        seat = self.seat_of(alias)
        path = f"/api/plugins/kanban/tasks/{quote(task_id, safe='')}"
        d = self.call(pod, "GET", path, query={"board": slug})
        t = d.get("task") or {}
        links = d.get("links") if isinstance(d.get("links"), dict) else {}
        if t.get("status") != "triage" or t.get("assignee") or links.get("parents") or links.get("children"):
            raise self._other_pod(alias, seat)                 # 이미 담당이 있거나 시작한 카드는 지금처럼 못 넘긴다
        self.ensure_on_pod(slug, seat["pod"])
        payload = {k: t[k] for k in TASK_FIELDS if t.get(k) is not None and k not in ("parents", "triage", "idempotency_key")}
        payload.update(assignee=seat["profile"], triage=True)  # 담당을 줘도 분류 대기에 둔다(같은 설치본에서 바꿀 때와 같다)
        res = self.call(seat["pod"], "POST", "/api/plugins/kanban/tasks", payload, {"board": slug})
        new_id = str((res.get("task") or res).get("id") or "")
        if not new_id:
            raise Fail(503, "hermes_unavailable", tr("카드를 옮겼다는 답을 받지 못했습니다", "Did not receive confirmation that the card was moved"))
        for c in d.get("comments") or []:
            self.call(seat["pod"], "POST", f"/api/plugins/kanban/tasks/{quote(new_id, safe='')}/comments",
                      {"body": str(c.get("body") or ""), "author": str(c.get("author") or "aas")[:120]}, {"board": slug})
        self.call(pod, "DELETE", path, query={"board": slug})
        with _db() as conn:                                    # 카드를 맡긴 사람의 기록도 새 번호로 옮긴다
            conn.execute("UPDATE office_card_owner SET task_id=? WHERE board=? AND task_id=?", (new_id, slug, task_id))
        self.sync(slug, force=True)
        return {"task": self.detail(slug, new_id, seat["pod"])["task"]}

    def delete_task(self, slug: str, task_id: str) -> dict:
        pod = self.pod_of(slug, task_id)
        self.call(pod, "DELETE", f"/api/plugins/kanban/tasks/{quote(task_id, safe='')}", query={"board": slug})
        self.sync(slug, force=True)
        return {"ok": True}

    def comment(self, slug: str, task_id: str, body: dict) -> dict:
        text = str(body.get("body") or "").strip()
        if not text:
            raise Fail(400, "missing_field", "body")
        pod = self.pod_of(slug, task_id)
        self.call(pod, "POST", f"/api/plugins/kanban/tasks/{quote(task_id, safe='')}/comments", {"body": text, "author": str(body.get("author") or "aas")[:120]},
                  {"board": slug})
        comments = self.detail(slug, task_id, pod)["comments"]
        return {"comment": comments[-1] if comments else {"id": 0, "author": body.get("author"), "body": text, "created_at": int(time.time())}}

    def action(self, slug: str, task_id: str, name: str, body: dict) -> dict:
        pod, tid = self.pod_of(slug, task_id), quote(task_id, safe="")
        base, q = f"/api/plugins/kanban/tasks/{tid}", {"board": slug}
        note = str(body.get("comment") or "").strip()
        if name == "reassign":
            if self.seat_of(str(body.get("profile") or ""))["pod"] != pod:
                return self._move_unassigned(slug, task_id, pod, str(body.get("profile") or ""))
            self.call(pod, "POST", base + "/reassign", {"profile": self._same_pod(pod, str(body.get("profile") or "")), "reclaim_first": bool(body.get("reclaim_first"))}, q)
        elif name in ("reclaim", "terminate"):
            try:
                self.call(pod, "POST", base + "/reclaim", {"reason": "오피스에서 중지"}, q)  # i18n-ignore: Hermes 에 저장되는 사유
            except Fail as exc:
                if name == "terminate" and exc.status == 409:
                    raise Fail(409, "no_active_run", tr("돌고 있는 실행이 없습니다", "No run is in progress")) from None
                raise
        elif name == "approve":
            self.call(pod, "PATCH", base, {"status": "done"}, q)
        elif name in ("request-changes", "unblock"):
            if name == "request-changes" and not note:
                raise Fail(400, "missing_field", "comment")
            if note:
                self.call(pod, "POST", base + "/comments", {"body": note, "author": "aas"}, q)
            self.call(pod, "PATCH", base, {"status": "ready"}, q)
        elif name == "archive":
            self.call(pod, "POST", "/api/plugins/kanban/tasks/bulk", {"ids": [task_id], "archive": True}, q)
        else:
            raise Fail(404, "unknown_action")
        self.sync(slug, force=True)
        return {"task": self.detail(slug, task_id, pod)["task"]}

    def log(self, slug: str, task_id: str, tail) -> dict:
        pod = self.pod_of(slug, task_id)
        try:
            d = self.call(pod, "GET", f"/api/plugins/kanban/tasks/{quote(task_id, safe='')}/log", query={"board": slug, "tail": tail})
        except Fail:
            return {"exists": False, "size_bytes": 0, "content": "", "truncated": False}
        return {"exists": bool(d.get("exists")), "size_bytes": int(d.get("size_bytes") or 0), "content": str(d.get("content") or ""), "truncated": bool(d.get("truncated"))}

    # ---- 실행한 명령(스펙 2026-11-03-001 R11·R13·R14·R15) ----------------------------
    def pod_home(self, pod: str):
        """설치본의 Hermes 데이터 폴더(로컬 Path 또는 사이드카 RemotePath)."""
        for p in self.bridge.registry.pods:
            if p.id == pod:
                return p.hermes_home
        raise Fail(503, "hermes_unavailable", tr("설치본을 찾지 못했습니다", "The installation was not found"))

    @staticmethod
    def kanban_db(home, slug: str):
        """Hermes 보드의 칸반 DB(hermes_cli/kanban_db.py kanban_db_path): default 는 <루트>/kanban.db, 다른 보드는 <루트>/kanban/boards/<slug>/kanban.db.
        칸반은 프로파일과 상관없이 루트에 하나다(kanban_home). AAS 보드 이름이 곧 Hermes 보드 이름이다(ensure_on_pod)."""
        return home / "kanban.db" if slug == "default" else home / "kanban" / "boards" / slug / "kanban.db"

    @staticmethod
    def state_db(home, profile: str):
        """프로파일의 대화 기록: default 는 루트, 나머지는 profiles/<이름>/state.db."""
        return home / "state.db" if profile == "default" else home / "profiles" / profile / "state.db"

    def run_commands(self, slug: str, task_id: str, run_id: int) -> dict:
        """카드 실행 하나가 쓴 터미널 명령. 짝은 칸반 DB 의 aas_run_sessions(R13, Hermes 패치가 적는다), 명령은 담당 프로파일의 state.db.
        state: running(실행이 안 끝남, M2) · ok(명령 있음) · pending(immutable 로 읽었거나 끝난 지 10분 안) · none(대화는 있는데 터미널 호출 없음) · lost(대화를 못 찾음).
        none·lost 는 mode=ro 로 읽었을 때만 말한다(R15). 명령은 가리고 앞 200자, 실행당 200개(R14)."""
        self.board_row(slug)
        pod = self.pod_of(slug, task_id)
        home = self.pod_home(pod)
        kdb = self.kanban_db(home, slug)
        (runs, links), mode_k = hr.query_batch_read_mode([
            (kdb, "SELECT profile, started_at, ended_at FROM task_runs WHERE id=? AND task_id=?", (run_id, task_id)),
            (kdb, "SELECT session_id FROM aas_run_sessions WHERE run_id=? ORDER BY created_at, session_id LIMIT ?", (run_id, MAX_RUN_SESSIONS))])
        if isinstance(runs, hr.MissingDb) or (isinstance(runs, list) and not runs):
            raise Fail(404, "run_not_found")                    # 다른 카드의 실행 번호도 여기서 거른다
        if isinstance(runs, Exception):
            raise Fail(503, "hermes_unavailable", str(runs)[:200])
        if isinstance(links, Exception):
            if "no such table" not in str(links):               # 표가 없는 옛 Hermes 이미지는 「짝 없음」과 같다
                raise Fail(503, "hermes_unavailable", str(links)[:200])
            links = []
        run = runs[0]
        sids = [str(r["session_id"]) for r in links if r["session_id"]]
        profile = str(run["profile"] or "")
        commands, more, seen, mode_s = [], False, False, "ro"
        if sids and _PROFILE_NAME.match(profile):
            sdb, marks = self.state_db(home, profile), ",".join("?" * len(sids))
            (found, calls, blocked), mode_s = hr.query_batch_read_mode([
                (sdb, f"SELECT id FROM sessions WHERE id IN ({marks})", tuple(sids)),
                (sdb, f"SELECT id, timestamp, tool_calls FROM messages WHERE session_id IN ({marks}) AND role='assistant' "
                      f"AND tool_calls LIKE ? ORDER BY id LIMIT ?", (*sids, f"%{TERMINAL_TOOL}%", COMMAND_LIMIT + 1)),
                (sdb, f"SELECT tool_call_id, substr(content, 1, ?) AS head FROM messages WHERE session_id IN ({marks}) AND role='tool' "
                      f"AND instr(substr(content, 1, ?), ?) > 0 LIMIT ?", (BLOCKED_HEAD, *sids, BLOCKED_HEAD, BLOCKED_PREFIX, 5000))])
            if not isinstance(found, hr.MissingDb):              # 대화 기록 DB 가 없으면 세션도 없다(lost)
                for res in (found, calls, blocked):
                    if isinstance(res, Exception):
                        raise Fail(503, "hermes_unavailable", str(res)[:200])
                seen = bool(found)
                blocked_ids = {str(r["tool_call_id"]) for r in blocked if r["tool_call_id"] and _blocked_result(r["head"])}
                more = len(calls) > COMMAND_LIMIT
                for row in calls[:COMMAND_LIMIT]:
                    for cid, text in _terminal_calls(row["tool_calls"]):
                        masked = _mask_text(text)
                        commands.append({"command": masked[:COMMAND_CHARS], "truncated": len(masked) > COMMAND_CHARS,
                                         "time": row["timestamp"], "blocked": bool(cid) and cid in blocked_ids})
                if len(commands) > COMMAND_LIMIT:
                    commands, more = commands[:COMMAND_LIMIT], True
        read_mode = "immutable" if "immutable" in (mode_k, mode_s) else "ro"
        ended = run["ended_at"]
        if ended is None:
            state = "running"
        elif commands:
            state = "ok"
        elif read_mode == "immutable" or _now_ts() - float(ended) < PENDING_SECONDS:
            state = "pending"
        else:
            state = "none" if seen else "lost"
        return {"run_id": run_id, "state": state, "read_mode": read_mode, "commands": commands, "more": more}

    # ---- 카드를 맡긴 사람의 권한(방 구성원, 003 §8-1) ----------------------------
    def record_owner(self, slug: str, task_id: str, email: str) -> None:
        if email:
            with _db() as conn:
                conn.execute(db.upsert("office_card_owner", ("board", "task_id", "email", "ts"), ("board", "task_id")), (slug, task_id, email.lower(), office._now()))

    def card_assignee(self, slug: str, task_id: str) -> str:
        with _db() as conn:
            row = conn.execute("SELECT assignee FROM office_cards WHERE board=? AND task_id=?", (slug, task_id)).fetchone()
        return row["assignee"] if row else ""

    def enforce_owners(self, slug: str) -> list[str]:
        """아직 끝나지 않은 카드를 맡긴 사람이 그 에이전트를 더는 시킬 수 없으면 카드를 막힘(보류)으로 옮긴다.
        방에서 빠졌거나 자리를 뺐거나 방이 끝난 경우다. 실행 중이면 먼저 멈춘다. 옮긴 카드 번호를 돌려준다."""
        if self.allowed is None:
            return []
        with _db() as conn:
            rows = [dict(r) for r in conn.execute(
                "SELECT c.task_id, c.pod, c.status, c.assignee, o.email FROM office_cards c JOIN office_card_owner o ON o.board=c.board AND o.task_id=c.task_id "
                "WHERE c.board=? AND c.assignee!='' AND c.status IN ('triage','todo','scheduled','ready','running')", (slug,))]
        held, verdict = [], {}
        for r in rows:
            key = (r["email"], r["assignee"])
            if key not in verdict:
                verdict[key] = bool(self.allowed(*key))
            if verdict[key]:
                continue
            base, q, tid = f"/api/plugins/kanban/tasks/{quote(r['task_id'], safe='')}", {"board": slug}, r["task_id"]
            try:
                if r["status"] == "running":
                    self.call(r["pod"], "POST", base + "/reclaim", {"reason": "카드를 맡긴 사람이 더는 이 에이전트를 시킬 수 없어 멈춤"}, q)  # i18n-ignore: Hermes 에 저장되는 사유
                self.call(r["pod"], "PATCH", base, {"status": "blocked", "block_reason": f"{r['email']} 님이 더는 {r['assignee']} 를 시킬 수 없어 보류했습니다(방 구성원이 아니거나 자리가 빠짐)"}, q)  # i18n-ignore: Hermes 에 저장되는 사유
            except Fail:
                continue                                          # 이 설치본이 안 닿으면 다음 주기에 다시 한다
            with _db() as conn:
                self._emit(conn, slug, "task.held", task_id=tid, assignee=r["assignee"], payload={"owner": r["email"], "from": r["status"]})
            held.append(tid)
        if held:
            self.sync(slug, force=True)
        return held

    def dispatch(self, slug: str, max_n=None) -> dict:
        self.board_row(slug)
        self.enforce_owners(slug)                                 # 실행할 때마다 맡긴 사람이 아직 시킬 수 있는지 본다
        spawned = []
        for pod in self.board_pods(slug):
            try:
                res = self.call(pod, "POST", "/api/plugins/kanban/dispatch", {}, {"board": slug, "max": max_n})
            except Fail:
                continue
            for item in res.get("spawned") or []:
                if isinstance(item, (list, tuple)) and item:
                    spawned.append({"task_id": str(item[0]), "profile": self.alias_of(pod, item[1] if len(item) > 1 else "")})
        self.sync(slug, force=True)
        return {"spawned": spawned, "skipped_locked": False}

    # ---- 이벤트: 지난번 본 것과 견주어 만든다 ---------------------------------
    def _last_event(self) -> int:
        with _db() as conn:
            return int(conn.execute("SELECT COALESCE(MAX(id), 0) n FROM office_events").fetchone()["n"])

    def _emit(self, conn, board: str, kind: str, **fields) -> None:
        body = {"kind": kind, **({"board": board} if board else {}), **{k: v for k, v in fields.items() if v not in (None, "")}}
        body.setdefault("payload", {})
        db.lock_events(conn)                    # PostgreSQL: id 순서와 커밋 순서를 같게 한다
        conn.execute("INSERT INTO office_events (board, ts, body) VALUES (?,?,?)", (board, time.time(), json.dumps(body, ensure_ascii=False)))

    def _diff(self, slug: str, cards: list, reached: set) -> None:
        if self._diff_rows(slug, cards, reached):
            for fn in list(ON_CARDS_CHANGED):
                try:
                    fn()
                except Exception as exc:                       # 알림 실패가 동기화를 실패로 만들지 않게
                    print(f"카드 바뀜 알림 실패: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그

    def _diff_rows(self, slug: str, cards: list, reached: set) -> bool:
        """카드 표를 맞춘다. 줄을 더하거나 바꾸거나 지웠으면 참(조용한 첫 동기화 포함)."""
        changed = False
        with self._lock, _db() as conn:
            board = conn.execute("SELECT synced FROM office_boards WHERE slug=?", (slug,)).fetchone()
            if not board:
                return False
            quiet = not board["synced"]                        # 처음 보는 보드 — 기준만 잡고 알리지 않는다
            old = {r["task_id"]: dict(r) for r in conn.execute("SELECT * FROM office_cards WHERE board=?", (slug,))}
            seen = set()
            for pod, t in cards:
                tid, status = str(t["id"]), str(t.get("status") or "")
                alias, title = self.alias_of(pod, t.get("assignee")), str(t.get("title") or "")
                parents = int((t.get("link_counts") or {}).get("parents") or 0)
                seen.add(tid)
                was = old.get(tid)
                if not was or (was["pod"], was["status"], was["assignee"], was["title"], int(was["parents"] or 0)) != (pod, status, alias, title, parents):
                    changed = True
                    # 바뀐 카드만 쓴다 — 같은 값도 PostgreSQL 은 갱신으로 쳐 표 바뀜 알림이 가고 카드 표 캐시가 동기화마다 버려졌다(스펙 2026-10-26-002 §9-14)
                    conn.execute(db.upsert("office_cards", ("board", "task_id", "pod", "status", "assignee", "title", "parents"), ("board", "task_id")), (slug, tid, pod, status, alias, title, parents))
                if quiet:
                    continue
                if not was:
                    self._emit(conn, slug, "task.created", task_id=tid, profile=alias, payload={"title": title, "status": status, "assignee": alias})
                    was = {"status": "", "assignee": alias, "title": title}
                if was["status"] != status:
                    if status == "running":
                        self._emit(conn, slug, "task.run.started", task_id=tid, profile=alias, payload={"assignee": alias, "title": title})
                    elif was["status"] == "running":
                        self._emit(conn, slug, "task.run.finished", task_id=tid, profile=alias, payload={"outcome": status, "assignee": alias})
                    if was["status"]:
                        self._emit(conn, slug, "task.status", task_id=tid, profile=alias,
                                   payload={"from": was["status"], "to": status, "parent_count": parents, "title": title, "assignee": alias})
                elif was["assignee"] != alias or was["title"] != title:
                    self._emit(conn, slug, "task.updated", task_id=tid, profile=alias, payload={"fields": ["assignee" if was["assignee"] != alias else "title"]})
            for tid, was in old.items():
                if tid not in seen and was["pod"] in reached:  # 닿지 않은 설치본의 카드는 지워진 것으로 치지 않는다
                    conn.execute("DELETE FROM office_cards WHERE board=? AND task_id=?", (slug, tid))
                    changed = True
                    if not quiet:
                        self._emit(conn, slug, "task.deleted", task_id=tid, payload={"title": was["title"]})
            conn.execute("UPDATE office_boards SET synced=1 WHERE slug=?", (slug,))
            conn.execute("DELETE FROM office_events WHERE id <= (SELECT MAX(id) FROM office_events) - ?", (KEEP_EVENTS,))
            self._synced_at[slug] = time.time()
        if changed:
            cards_written()                                    # 커밋 뒤 — 진행 카드 기억이 다시 읽는다
        return changed

    def sync(self, slug: str, force: bool = False, every: float = 4.0) -> None:
        if not force and time.time() - self._synced_at.get(slug, 0) < every:
            return
        try:
            cards, _, reached = self.fetch(slug)
            self._diff(slug, cards, reached)
        except Fail:
            pass

    def events(self, slug: str, cursor: str, limit: int) -> dict:
        self.board_row(slug)
        self.sync(slug)
        self.cron_sync()
        top = self._last_event()
        if not cursor:                                         # 처음 — 지난 일은 다시 틀지 않고 "지금"만 건넨다
            return {"events": [], "cursor": f"v1.{top}", "has_more": False}
        m = re.fullmatch(r"v1\.(\d+)", cursor)
        if not m or int(m.group(1)) > top:
            raise Fail(400, "unknown_cursor")
        after, limit = int(m.group(1)), max(1, min(int(limit or 200), 500))
        with _db() as conn:
            rows = conn.execute("SELECT id, ts, body FROM office_events WHERE id > ? AND board IN (?, '') ORDER BY id LIMIT ?", (after, slug, limit + 1)).fetchall()
        more, rows = len(rows) > limit, rows[:limit]
        out = [{"id": f"h:{r['id']}", "ts": int(r["ts"]), **json.loads(r["body"])} for r in rows]
        return {"events": out, "cursor": f"v1.{rows[-1]['id'] if more else top}", "has_more": more}

    def tick(self) -> None:
        """준비·진행 중인 카드가 있는 보드를 한 번 밀어 준다(서버가 20초마다 부른다)."""
        with _db() as conn:
            slugs = [r["board"] for r in conn.execute("SELECT DISTINCT c.board FROM office_cards c JOIN office_boards b ON b.slug=c.board "
                                                      "WHERE b.archived=0 AND c.status IN ('ready','running')")]
        for slug in slugs:
            try:
                self.dispatch(slug)
            except Fail:
                pass

    # ---- 크론 -------------------------------------------------------------
    @staticmethod
    def job_out(job: dict) -> dict:
        out = {k: job.get(k) for k in JOB_KEYS}
        out["skills"] = job.get("skills") or []
        sched = job.get("schedule") if isinstance(job.get("schedule"), dict) else {"kind": "cron", "expr": str(job.get("schedule") or "")}
        out["schedule"], out["schedule_display"] = sched, out["schedule_display"] or sched.get("display") or sched.get("expr") or ""
        out["state"] = out["state"] or ("scheduled" if job.get("enabled", True) else "paused")
        return out

    def _job(self, res) -> dict:
        job = res.get("job", res) if isinstance(res, dict) else {}
        if not isinstance(job, dict) or not job.get("id"):
            raise Fail(404, "job_not_found")
        return job

    def cron(self, alias: str, seat: dict, method: str, rest: str, body: dict, query: dict) -> tuple[int, dict]:
        pod, q = seat["pod"], {"profile": seat["profile"]}

        def call(m, path, payload=None, extra=None):
            try:
                return self.call(pod, m, "/api/cron" + path, payload, {**q, **(extra or {})})
            except Fail as exc:
                if exc.status == 404:
                    raise Fail(404, "job_not_found", exc.detail) from None
                if exc.code == "invalid_field":
                    raise Fail(400, "invalid_schedule" if "schedule" in exc.detail.lower() else "invalid_field", exc.detail) from None
                raise
        if rest == "/jobs" and method == "GET":
            res = call("GET", "/jobs")
            jobs = res.get("jobs", []) if isinstance(res, dict) else res
            return 200, {"jobs": [self.job_out(j) for j in jobs if isinstance(j, dict) and j.get("profile", seat["profile"]) in (seat["profile"], None)]}
        if rest == "/jobs" and method == "POST":
            if not str(body.get("schedule") or "").strip():
                raise Fail(400, "missing_field", "schedule")
            payload = {"name": str(body.get("name") or "")[:120], "prompt": str(body.get("prompt") or ""), "schedule": str(body["schedule"]),
                       "deliver": str(body.get("deliver") or "local"), "skills": body.get("skills") or None, "model": body.get("model") or None,
                       "provider": body.get("provider") or None, "script": body.get("script") or None}
            job = self._job(call("POST", "/jobs", payload))
            if body.get("paused"):
                job = self._job(call("POST", f"/jobs/{quote(str(job['id']), safe='')}/pause", {}))
            with _db() as conn:
                conn.execute("INSERT INTO office_cron (alias, job_id) VALUES (?,?) ON CONFLICT DO NOTHING", (alias, str(job["id"])))
            return 201, {"job": self.job_out(job)}
        if rest == "/delivery-targets" and method == "GET":
            try:
                targets = self.call(pod, "GET", "/api/cron/delivery-targets").get("targets") or []
            except Fail:
                targets = []
            return 200, {"targets": targets or [{"id": "local", "name": "Local", "home_target_set": True, "home_env_var": None}]}
        if rest == "/blueprints" and method == "GET":
            return 200, {"blueprints": []}
        m = re.fullmatch(r"/jobs/([^/]+)(/runs|/pause|/resume|/run)?", rest)
        if not m:
            raise Fail(404, "not_found")
        jid, op = quote(m.group(1), safe=""), (m.group(2) or "")[1:]
        if not op and method == "GET":
            return 200, {"job": self.job_out(self._job(call("GET", f"/jobs/{jid}")))}
        if not op and method == "PUT":
            updates = body.get("updates") if isinstance(body.get("updates"), dict) else {}
            clean = {k: updates[k] for k in JOB_UPDATES if k in updates}
            if not clean:
                raise Fail(400, "invalid_update")
            return 200, {"job": self.job_out(self._job(call("PUT", f"/jobs/{jid}", {"updates": clean})))}
        if not op and method == "DELETE":
            call("DELETE", f"/jobs/{jid}")
            with _db() as conn:
                conn.execute("DELETE FROM office_cron WHERE alias=? AND job_id=?", (alias, m.group(1)))
            return 200, {"ok": True}
        if op in ("pause", "resume") and method == "POST":
            return 200, {"job": self.job_out(self._job(call("POST", f"/jobs/{jid}/{op}", {})))}
        if op == "run" and method == "POST":
            job = self._job(call("GET", f"/jobs/{jid}"))
            if job.get("state") == "paused" or job.get("enabled") is False:      # Hermes 는 멈춘 작업도 돌려 버린다 — 여기서 막는다
                raise Fail(409, "job_paused", tr("멈춰 둔 작업입니다. 먼저 다시 켜세요.", "This job is paused. Resume it first."))
            call("POST", f"/jobs/{jid}/trigger", {})
            return 202, {"accepted": True, "job": self.job_out(job)}
        if op == "runs" and method == "GET":
            limit = max(1, min(int((query.get("limit") or ["20"])[0] or 20), 50))
            res = call("GET", f"/jobs/{jid}/runs", extra={"limit": limit})
            runs = res.get("runs", []) if isinstance(res, dict) else res
            return 200, {"limit": limit, "runs": [{                 # 세션 기록에서 화면에 필요한 것만 — 시스템 지시문 등은 내보내지 않는다
                "id": str(r.get("id") or ""), "started_at": r.get("started_at"), "ended_at": r.get("ended_at"),
                "status": "running" if not r.get("ended_at") else ("error" if str(r.get("end_reason") or "") in ("error", "failed", "timeout") else "ok"),
                "summary": str(r.get("title") or r.get("preview") or "")[:300], "result_text": ""} for r in runs if isinstance(r, dict)]}
        raise Fail(404, "not_found")

    def cron_sync(self, every: float = 30.0) -> None:
        """오피스에서 만든 크론 작업만 지켜보다가, 실행이 시작되고 끝나면 알린다."""
        if time.time() - self._cron_at < every:
            return
        self._cron_at = time.time()
        with _db() as conn:
            rows = [dict(r) for r in conn.execute("SELECT * FROM office_cron")]
        table = self.seats()
        for row in rows:
            seat = table.get(row["alias"])
            if not seat:
                continue
            try:
                job = self._job(self.call(seat["pod"], "GET", f"/api/cron/jobs/{quote(row['job_id'], safe='')}", query={"profile": seat["profile"]}))
            except Fail:
                continue
            ex = job.get("latest_execution") if isinstance(job.get("latest_execution"), dict) else {}
            eid, state = str(ex.get("id") or ""), str(ex.get("status") or "")
            if not eid or (eid, state) == (row["last_exec"], row["last_state"]):
                continue
            done = state in ("completed", "failed", "error", "timed_out", "cancelled")
            base = {"profile": row["alias"], "job_id": row["job_id"]}
            with _db() as conn:
                if eid != row["last_exec"]:
                    self._emit(conn, "", "cron.run.started", run_id=eid, payload={"job_name": job.get("name")}, **base)
                if done:
                    self._emit(conn, "", "cron.run.finished", run_id=eid, **base,
                               payload={"job_id": row["job_id"], "job_name": job.get("name"), "profile": row["alias"],
                                        "status": "ok" if state == "completed" else "error", "result_text": str(ex.get("error") or "")})
                conn.execute("UPDATE office_cron SET last_exec=?, last_state=? WHERE alias=? AND job_id=?", (eid, state, row["alias"], row["job_id"]))


def _blocked_result(head) -> bool:
    """도구 결과 앞머리가 승인 검사의 거절인가. 거절 문구 그대로(BLOCKED: …)이거나 터미널 도구의 거절 JSON 이다."""
    head = str(head or "")
    return head.startswith(BLOCKED_PREFIX) or bool(_BLOCKED_JSON.match(head))


def _terminal_calls(raw) -> list[tuple[str, str]]:
    """assistant 메시지의 tool_calls(JSON) 에서 터미널 호출의 (호출 id, 명령). 감싼 호출(tool_call)도 푼다(ops/observed.py 와 같은 모양)."""
    try:
        calls = json.loads(raw) if isinstance(raw, str) else raw
    except ValueError:
        return []
    out = []
    for call in calls if isinstance(calls, list) else []:
        fn = (call or {}).get("function") if isinstance(call, dict) else None
        if not isinstance(fn, dict):
            continue
        name, args = fn.get("name"), fn.get("arguments")
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except ValueError:
                args = None
        if name == "tool_call" and isinstance(args, dict) and isinstance(args.get("name"), str):
            name, args = args["name"], args.get("arguments")
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except ValueError:
                    args = None
        if name == TERMINAL_TOOL and isinstance(args, dict) and isinstance(args.get("command"), str):
            out.append((str(call.get("id") or ""), args["command"]))
    return out


KANBAN = "/api/office/kanban"
CRON = re.compile(r"^/api/office/cron/([^/]+)(/.*)$")
# 카드 경로. 서버의 접근 검사(server._office_route)도 이것으로 카드를 알아본다 — runs/<번호>/commands 도 같은 검사를 받는다(X2)
TASK_PATH = re.compile(KANBAN + r"/tasks/([^/]+)(?:/([a-z-]+))?(?:/(\d+)/commands)?")


def route(auto: Auto, method: str, path: str, query: dict, body: dict) -> tuple[int, dict]:
    """`/api/office/kanban/*`, `/api/office/events`, `/api/office/cron/<자리>/*`. (상태 코드, 본문). 거절은 Fail."""
    one = lambda k: (query.get(k) or [""])[0]                 # noqa: E731
    slug = one("board")
    cron = CRON.match(path)
    if cron:
        alias = cron.group(1)
        return auto.cron(alias, auto.seat_of(alias), method, cron.group(2), body, query)
    if path == "/api/office/events" and method == "GET":
        return 200, auto.events(slug, one("cursor"), int(one("limit") or 200))
    if path == f"{KANBAN}/boards":
        if method == "GET":
            return 200, auto.list_boards(one("include_archived") == "true")
        if method == "POST":
            return auto.create_board(body)
    m = re.fullmatch(KANBAN + r"/boards/([^/]+)", path)
    if m and method == "PATCH":
        return 200, auto.patch_board(m.group(1), body)
    if path == f"{KANBAN}/board" and method == "GET":
        return 200, auto.board_view(slug, one("include_archived") == "true")
    if path == f"{KANBAN}/dispatch" and method == "POST":
        return 200, auto.dispatch(slug, one("max") or None)
    if path == f"{KANBAN}/tasks" and method == "POST":
        return 201, auto.create_task(slug, body)
    m = TASK_PATH.fullmatch(path)
    if m:
        tid, sub, run = m.group(1), m.group(2), m.group(3)
        if run is not None:
            if sub == "runs" and method == "GET":
                return 200, auto.run_commands(slug, tid, int(run))
            raise Fail(404, "not_found")
        if not sub:
            if method == "GET":
                return 200, auto.detail(slug, tid)
            if method == "PATCH":
                return 200, auto.patch_task(slug, tid, body)
            if method == "DELETE":
                return 200, auto.delete_task(slug, tid)
        elif sub == "comments" and method == "POST":
            return 201, auto.comment(slug, tid, body)
        elif sub == "log" and method == "GET":
            return 200, auto.log(slug, tid, one("tail") or None)
        elif method == "POST" and sub not in ("attachments", "blackboard"):
            return 200, auto.action(slug, tid, sub, body)
    raise Fail(404, "not_found")


def start_ticker(auto: Auto, every: float = 20.0) -> None:
    def loop():
        while True:
            time.sleep(every)
            try:
                auto.tick()
            except Exception as exc:                          # 한 번의 실패가 주기를 멈추지 않게
                # i18n-ignore: 서버 로그
                print(f"오피스: 보드 밀어 주기 실패 ({type(exc).__name__})", flush=True)
    threading.Thread(target=loop, daemon=True, name="aas-office-dispatch").start()
