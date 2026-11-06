# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""채팅 입력창의 「/」 Hermes 내장 명령(스펙 2026-10-26-010 §10·§11, 2단계 2026-10-27-002).

1단계 명령 10개(R1·R10)와 2단계 6개(learn·memory·review·refine·goal·loop), 3단계 3개(title·subgoal·btw, 스펙 2026-10-27-004)를 쓴다.
init·moa 는 넣지 않는다(2단계 R1·R2). 3단계는 slash worker(대화마다 약 100MB)를 쓰지 않는다 — 셋 모두 Hermes 전용 RPC 가 있다. 허용 목록은 이 모듈 한 곳에 두고 목록 거르기·실행 확인·시험이 같은 상수를 본다(9-4).
- status·context·usage 는 slash.exec(worker 없이 바로 답함), help 는 AAS 가 만든다 — Hermes 의 help 는 slash worker 를 띄운다(R8).
- 그 밖은 command.dispatch. 같은 이름의 빠른·플러그인 명령이 있으면 거절한다 — dispatch 는 빠른 명령을 먼저 처리하고
  빠른 명령 exec 는 셸을 돈다(R9). 실행 전마다 그 세션의 catalog 를 새로 읽고, 못 읽으면 실행하지 않는다.
- 플러그인은 내장 명령 이름으로 등록되지 않는다(Hermes plugins.register_command 가 거절). 빠른 명령은 같은 이름이 된다.
"""
from __future__ import annotations

import re

from ..common.i18n import tr

NAMES = ("help", "status", "context", "usage", "retry", "undo", "compress", "plan", "queue", "steer",
         "learn", "memory", "review", "refine", "goal", "loop", "title", "subgoal", "btw")
RPC = frozenset({"title", "subgoal", "btw", "heartbeat"})   # command.dispatch·slash.exec 가 아니라 전용 RPC — catalog desktop 값·이름 겹침을 보지 않는다(3단계)
CONTROL_ONLY = frozenset({"heartbeat"})                  # 목표·반복 줄 단추 전용. 목록·command_names 에 넣지 않는다 — /heartbeat 는 worker 로 간다(3단계 R9)
ANYTIME = frozenset({"title", "subgoal", "btw", "heartbeat"})   # 답하는 중에도 — Hermes 가 바쁨을 보지 않는 RPC
LIVE = frozenset({"status", "context", "usage", "review", "refine"})   # slash.exec — Hermes 가 세션에서 바로 답한다(worker 없음)
READ_ONLY = frozenset({"help", "status", "context", "usage"})          # 답하는 중에도 보이기만 하는 명령. review·refine 은 Hermes 가 바쁘면 띄우지 않는다
WHILE_BUSY = frozenset({"steer", "queue"})               # 답하는 중에도 보낼 수 있다(R10)
REQUIRED = frozenset({"steer", "queue", "loop", "btw"})  # 인자가 비면 보내지 않는다(DC10)
OWNER_ONLY = frozenset({"goal", "loop", "title", "subgoal", "heartbeat"})   # 주인·관리자만(2단계 R12, 3단계 R7·R9)
OFFICE_OUT = frozenset({"review", "refine", "goal", "loop", "subgoal", "btw", "heartbeat"})   # 오피스 1:1 은 Hermes 가 시작한 턴·곁 답을 따라가지 않는다(2단계 R3, 3단계)
TITLE_MAX = 100                                          # Hermes 대화 제목 상한(hermes_state.py, 넘으면 4022)
CONTROL = frozenset({"pause", "resume", "clear", "stop", "status"})   # goal·loop 의 상태 바꾸기 — 답하는 중에도 보낸다(목표·반복 줄 단추)
MEMORY_WRITE = frozenset({"approve", "reject", "approval", "mode"})   # 기억을 바꾸는 /memory 인자 — 주인·관리자만(§4-2)
NOT_OURS = ("User commands", "Plugin commands")          # catalog 의 빠른·플러그인 명령 분류(Hermes _catalog_quick_commands·_catalog_plugin_commands)
COMPRESS_TIMEOUT = 180                                   # R7 — 대화 다시 열기(RESUME_TIMEOUT)와 같은 값
HISTORY_TIMEOUT = 30                                     # 되감은 뒤 기록 다시 읽기
BUSY, USAGE, EMPTY = 4009, 4004, (4001, 4018)            # Hermes 거절 코드(tui_gateway/methods_tools.py)


def describe(name: str) -> str:
    return {
        "help": tr("쓸 수 있는 명령과 스킬", "Commands and skills you can use"),
        "status": tr("대화·모델·토큰 상태 보기", "Show session, model and token status"),
        "context": tr("대화 맥락 사용량 보기", "Show context window usage"),
        "usage": tr("토큰 사용량 보기", "Show token usage"),
        "retry": tr("마지막 질문에 다시 답하기", "Answer the last message again"),
        "undo": tr("마지막 턴 되돌리기", "Undo the last turn"),
        "compress": tr("대화를 요약해 줄이기", "Summarize the chat to save context"),
        "plan": tr("실행하지 않고 계획만 쓰기", "Write a plan without running it"),
        "queue": tr("답이 끝난 뒤 보낼 말 예약", "Send a message after this answer"),
        "steer": tr("답하는 중에 방향 바꾸기", "Redirect the agent while it answers"),
        "learn": tr("이 대화에서 배운 것을 스킬로 남기기", "Save what this chat taught as a skill"),
        "memory": tr("기억 쓰기 승인 대기 보기", "Review pending memory writes"),
        "review": tr("지금까지의 작업을 뒤에서 검토", "Review the work so far in the background"),
        "refine": tr("기억·스킬을 뒤에서 다듬기", "Refine memory and skills in the background"),
        "goal": tr("목표를 정하고 끝날 때까지 이어 하기", "Set a goal and keep working until it is done"),
        "loop": tr("정한 간격마다 다시 일하기", "Repeat a task on an interval"),
        "title": tr("대화 제목 보기·바꾸기", "Show or set the chat title"),
        "subgoal": tr("목표에 조건 더하기·빼기", "Add or remove criteria on the goal"),
        "btw": tr("답을 끊지 않고 곁 질문하기", "Ask a side question without interrupting"),
    }.get(name, "")


def hint(name: str) -> str:
    """목록 줄 오른쪽의 인자 모양(DC10)."""
    return {
        "steer": tr("<할 말>", "<message>"),
        "queue": tr("<할 말>", "<message>"),
        "plan": tr("[할 일]", "[task]"),
        "undo": tr("[턴 수]", "[turns]"),
        "learn": tr("[무엇을]", "[topic]"),
        "memory": tr("[pending|approve <id>|reject <id>]", "[pending|approve <id>|reject <id>]"),
        "review": tr("[볼 것]", "[focus]"),
        "goal": tr("<목표>|pause|resume|clear", "<goal>|pause|resume|clear"),
        "loop": tr("<간격> <할 일>|pause|resume|stop", "<interval> <task>|pause|resume|stop"),
        "title": tr("[제목]", "[title]"),
        "subgoal": tr("[조건]|remove <번호>|clear", "[criterion]|remove <n>|clear"),
        "btw": tr("<질문>", "<question>"),
    }.get(name, "")


def pick(result) -> dict:
    """commands.catalog 응답에서 쓸 수 있는 허용 명령 이름과, 같은 이름의 빠른·플러그인 명령 때문에 뺀 이름(R9).
    Hermes 판에 없는 명령과 desktop 제약(값이 있음)이 생긴 명령은 뺀다(§4-1). help 는 AAS 가 만들어 늘 쓸 수 있다."""
    result = result if isinstance(result, dict) else {}
    others = set()
    for cat in result.get("categories") or []:
        if isinstance(cat, dict) and cat.get("name") in NOT_OURS:
            others.update(str(p[0]).lower() for p in cat.get("pairs") or [] if isinstance(p, (list, tuple)) and p)
    meta = result.get("commands") if isinstance(result.get("commands"), dict) else {}
    ok, blocked = [], []
    for name in NAMES:
        key = "/" + name
        if name == "help" or name in RPC:              # AAS 가 만들거나 전용 RPC 로 부른다
            ok.append(name)
        elif key in others:
            blocked.append(key)
        elif key in meta and not (meta[key] if isinstance(meta[key], dict) else {}).get("desktop"):
            ok.append(name)
    return {"commands": ok, "blocked": blocked, "plugins": plugin_rows(result), **known_names(result, others)}


def plugin_rows(result: dict) -> list[dict]:
    """그 세션 Hermes 플러그인이 등록한 명령(catalog 「Plugin commands」). 화면 「/」 목록에 보이기만 한다 —
    고르면 글로 보내고 그 플러그인의 훅(pre_llm_call 등)이 처리한다. command.dispatch 로 보내지 않고 command_names 에도 넣지 않는다(R9).
    빠른 명령(「User commands」)은 셸을 돌므로 계속 보이지 않는다."""
    meta = result.get("commands") if isinstance(result.get("commands"), dict) else {}
    rows = []
    for cat in result.get("categories") or []:
        if not (isinstance(cat, dict) and cat.get("name") == "Plugin commands"):
            continue
        for p in cat.get("pairs") or []:
            if not (isinstance(p, (list, tuple)) and p and str(p[0]).startswith("/") and len(str(p[0])) > 1):
                continue
            key = str(p[0])
            m = meta.get(key) if isinstance(meta.get(key), dict) else {}
            rows.append({"command": key, "name": key[1:], "description": str(p[1] if len(p) > 1 else "")[:200],
                         "hint": tr("<내용>", "<text>") if m.get("argument_mode") in ("text", "mixed") else ""})
    return rows


def known_names(result: dict, others: set) -> dict:
    """그 세션 Hermes 가 아는 내장 명령 이름(「/이름」)과 허용 명령의 별칭(3단계 R2·R6·R10). 화면은 이 이름을 치면
    허용 밖이면 막는다 — 막지 않으면 /version·/init 같은 글이 모델로 갔다. 내장 명령은 categories(TUI 전용 이름 포함)와
    commands(별칭 포함)에 있고, 스킬은 둘 다에 없다. 빠른·플러그인 명령(others)은 넣지 않는다 — 1단계 R9 이름 겹침 규칙 그대로."""
    names = set()
    for cat in result.get("categories") or []:
        if isinstance(cat, dict) and cat.get("name") not in NOT_OURS:
            names.update(str(p[0]).lower() for p in cat.get("pairs") or [] if isinstance(p, (list, tuple)) and p)
    names.update(str(k).lower() for k in (result.get("commands") or {}) if isinstance(result.get("commands"), dict))
    names = {n for n in names if n.startswith("/") and len(n) > 1} - others
    canon = result.get("canon") if isinstance(result.get("canon"), dict) else {}
    aliases = {str(k).lower(): str(v).lower().lstrip("/") for k, v in canon.items()
               if str(k).lower() != str(v).lower() and str(v).lower().lstrip("/") in NAMES and str(k).lower() not in others}
    return {"known": sorted(names), "aliases": aliases}


def shown_names(got: dict, allowed: bool = True, manages: bool = True, office: bool = False) -> list[str]:
    """이 사람·이 화면에서 쓸 수 있는 명령. goal·loop 는 주인·관리자만(R12), 오피스 1:1 에는 2-B·2-C 가 없다(R3)."""
    names = got.get("commands") or [] if allowed else []
    return [n for n in names if (manages or n not in OWNER_ONLY) and not (office and n in OFFICE_OUT)]


def view(got: dict, allowed: bool = True, manages: bool = True, office: bool = False) -> dict:
    """화면 목록 응답에 더할 명령 칸(DC5·DC13). 이름 목록은 권한·목록 실패와 관계없이 준다 — 화면이 친 명령을 알아보고
    실행할 수 없으면 보내기를 막는다(글로 모델에 가지 않게)."""
    names = shown_names(got, allowed, manages, office)
    return {"commands": [{"command": "/" + n, "name": n, "description": describe(n), "hint": hint(n), "required": n in REQUIRED,
                          "while_busy": n in WHILE_BUSY or n in ANYTIME} for n in names],
            # 그 세션의 내장 명령 이름 전부 — 허용 밖은 화면이 막는다(3단계 R2). 목록을 못 읽었으면 NAMES 만
            "command_names": sorted({"/" + n for n in NAMES} | set(got.get("known") or [])),
            "command_aliases": dict(got.get("aliases") or {}),      # /q → queue(3단계 R10)
            "owner_only": ["/" + n for n in sorted(OWNER_ONLY - CONTROL_ONLY)] if allowed and not manages else [],
            "commands_blocked": list(got.get("commands_blocked") or []) if allowed else [],
            "commands_allowed": bool(allowed),
            # 플러그인 명령(보이기만, 글로 보낸다) — 실행은 Hermes 플러그인이 하므로 이 사람의 명령 권한과 관계없다
            "plugin_commands": list(got.get("plugins") or [])}


def help_text(cat: dict, names: list[str] | None = None) -> str:
    """/help 결과(R8). 허용 명령(names: 이 사람이 쓸 수 있는 것)과 그 세션의 스킬. 고정폭으로 맞춘다(DC2)."""
    rows = [("/" + n, describe(n), hint(n)) for n in (cat.get("commands") or [] if names is None else names)]
    skills = [(r["command"], r.get("description") or "", "") for r in cat.get("skills") or []]
    width = max([len(r[0]) + (len(r[2]) + 1 if r[2] else 0) for r in rows + skills] or [0])
    line = lambda r: f"  {(r[0] + (' ' + r[2] if r[2] else '')).ljust(width)}  {r[1]}".rstrip()   # noqa: E731
    out = [tr("명령", "Commands"), *map(line, rows)]
    out += ["", tr(f"스킬 {len(skills)}개", f"Skills ({len(skills)})"), *(map(line, skills) if skills else [tr("  (없음)", "  (none)")])]
    return "\n".join(out)


class CommandError(Exception):
    """화면이 안내 문장으로 보일 거절(9-3·11-4). code: usage·empty·busy·collision·catalog·unsupported·failed."""

    def __init__(self, code: str, text: str):
        super().__init__(text)
        self.code, self.text = code, text


def usage_error(name: str) -> CommandError:
    if name == "undo":
        return CommandError("usage", tr("턴 수는 숫자로 쓰세요 · 예: /undo 2", "Use a number of turns · e.g. /undo 2"))
    return CommandError("usage", tr(f"/{name} 뒤에 할 말을 쓰세요", f"Write a message after /{name}"))


def empty_error(name: str) -> CommandError:
    return CommandError("empty", {"retry": tr("다시 답할 질문이 없습니다", "There is no message to answer again"),
                                  "undo": tr("되돌릴 답이 없습니다", "There is nothing to undo"),
                                  "compress": tr("줄일 대화가 없습니다", "There is no chat to compress")}.get(
        name, tr("이 대화에서는 쓸 수 없습니다", "Not available in this chat")))


def busy_error() -> CommandError:
    return CommandError("busy", tr("답이 끝난 뒤에 쓸 수 있습니다", "Available after the answer finishes"))


def from_hermes(name: str, exc) -> CommandError:
    """Hermes 의 거절 코드를 안내 문장으로(9-3). 모르는 코드는 Hermes 의 글을 그대로 붙인다."""
    code = getattr(exc, "code", None)
    if code == BUSY:
        return busy_error()
    if code == USAGE:
        return usage_error(name)
    if code in EMPTY and name in ("retry", "undo", "compress"):
        return empty_error(name)
    return CommandError("failed", tr(f"/{name} 를 실행하지 못했습니다: {exc}", f"/{name} failed: {exc}"))


def check(cat: dict, name: str) -> None:
    """실행 전 확인(R9): 목록을 못 읽음·이름 겹침·이 Hermes 에서 못 씀이면 거절한다."""
    if cat.get("warning"):
        raise CommandError("catalog", tr("명령을 확인하지 못했습니다 · 다시 시도해 주세요", "Could not check the command · Try again"))
    if "/" + name in (cat.get("commands_blocked") or []):
        raise CommandError("collision", tr(f"/{name} 를 실행하지 않았습니다 · 같은 이름의 빠른 명령이 있습니다",
                                           f"/{name} was not run · A quick command has the same name"))
    if name not in (cat.get("commands") or []):
        raise CommandError("unsupported", tr(f"이 AI 에이전트에서는 /{name} 를 쓸 수 없습니다", f"/{name} is not available for this AI Agent"))


_LOOP_TIMES = re.compile(r"\s--times\s+\S+")
_LOOP_UNTIL = re.compile(r"\s--until\s+.+$", re.S)


def loop_runs_command(arg: str) -> bool:
    """/loop 의 반복 내용이 「/」 명령인가(2단계 R11). Hermes 는 그런 반복을 차례마다 command.dispatch 로 돌려
    허용 목록·권한을 비켜 간다(hermes_cli/loops.py fire_tick, d923a5eb). parse_loop_args 처럼 --times·--until·every 를 떼고,
    간격 낱말이 무엇이든 앞 두 낱말 중 하나가 「/」로 시작하면 명령으로 본다(넓게 막는 쪽)."""
    raw = _LOOP_UNTIL.sub("", _LOOP_TIMES.sub("", " " + str(arg or ""))).strip()
    words = raw.split()
    if words and words[0].lower() == "every":
        words = words[1:]
    return any(w.startswith("/") for w in words[:2])


def normalize(name: str, arg: str) -> tuple[str, str]:
    """(명령 이름, 인자). 허용 목록 밖이면 CommandError. 필요한 인자가 비면 사용법 오류(DC10)."""
    name = str(name or "").strip().lstrip("/").lower()
    if name not in NAMES and name not in CONTROL_ONLY:
        raise CommandError("unknown", tr("모르는 명령입니다", "Unknown command"))
    arg = str(arg or "").strip()[:4000]
    if name in REQUIRED and not arg:
        raise usage_error(name)
    if name == "undo" and arg and not re.fullmatch(r"\d{1,3}", arg):
        raise usage_error(name)
    if name in CONTROL_ONLY and arg not in ("pause", "resume", "clear"):
        raise CommandError("usage", tr("멈춤·다시·지우기만 할 수 있습니다", "Only pause, resume or clear"))
    if name == "title" and len(arg) > TITLE_MAX:
        raise CommandError("usage", tr(f"제목은 {TITLE_MAX}자까지입니다", f"A title can be up to {TITLE_MAX} characters"))
    if name == "subgoal" and first_word(arg) == "remove" and not re.fullmatch(r"remove\s+\d{1,2}", arg, re.I):
        raise CommandError("usage", tr("빼려는 조건의 번호를 쓰세요 · 예: /subgoal remove 2", "Write the number to remove · e.g. /subgoal remove 2"))
    if name == "loop" and loop_runs_command(arg):
        raise CommandError("usage", tr("반복에는 글만 넣을 수 있습니다 · 「/」 명령은 반복하지 않습니다",
                                       "A loop can only repeat a message · Slash commands cannot be repeated"))
    return name, arg


def first_word(arg: str) -> str:
    return (str(arg or "").split() or [""])[0].lower()


def forbidden() -> CommandError:
    return CommandError("forbidden", tr("이 명령은 AI 에이전트의 주인·관리자만 쓸 수 있습니다",
                                        "Only the AI Agent's owner or an admin can use this command"))


def allowed_for(name: str, arg: str, manages: bool) -> None:
    """권한 확인(2단계 R12·§4-2). goal·loop 는 걸기·멈춤 모두, memory 는 기억을 바꾸는 인자만 주인·관리자."""
    if manages:
        return
    if name in OWNER_ONLY or (name == "memory" and first_word(arg) in MEMORY_WRITE):
        raise forbidden()


PLAN_HEAD = "[/plan — plan mode]"                       # Hermes agent/plan_prompt.py build_plan_prompt 의 첫 줄(d923a5eb)
# 할 일 끝은 Hermes 의 고정 꼬리 첫머리로 찾는다. 첫 빈 줄에서 끊으면 문단이 둘인 할 일이 첫 문단만 보였다(OMAI-1498).
_PLAN_TASK = re.compile(r"\nTask to plan:\n(.*)\n\nWrite the plan for an implementer", re.S)


def shown(text: str) -> str:
    """Hermes 가 저장한 사용자 말을 화면 말풍선 글로. /plan 은 만든 계획 프롬프트 전체가 저장돼 retry·되감기·다시 열기에서
    영어 프롬프트가 보였다(OKE 2026-10-27, 12-7) — 사용자가 친 「/plan 할 일」로 되돌린다. 그 밖의 글은 그대로."""
    text = str(text or "")
    if not text.startswith(PLAN_HEAD):
        return text
    m = _PLAN_TASK.search(text)
    return f"/plan {m.group(1).strip()}".strip() if m else "/plan"


# Hermes 가 스스로 시작한 턴의 프롬프트 머리(d923a5eb). Hermes 는 이 프롬프트를 사용자 말로 저장해, 다시 연 대화에 영어 지시가
# 사용자 말풍선으로 보였다(OKE 2026-10-27 화면 확인). 실시간 화면의 aas.turn.auto 와 같은 까닭으로 바꾼다.
#   hermes_cli/goals.py CONTINUATION_PROMPT_*_TEMPLATE, hermes_cli/loops.py WAKEUP_PROMPT_*_TEMPLATE, hermes_cli/heartbeat.py,
#   tools/process_registry_notifications.py(위임 결과·백그라운드 프로세스). Hermes 판을 올리면 머리가 그대로인지 본다
AUTO_HEADS = (("[Continuing toward your standing goal", "goal"), ("[/loop wakeup #", "loop"),
              ("[Heartbeat — recurring instruction", "heartbeat"), ("[ASYNC DELEGATION ", "process"),
              ("[Background process ", "process"), ("[IMPORTANT: Background process ", "process"))


def auto_reason(text: str) -> str:
    """Hermes 가 스스로 시작한 턴의 저장된 프롬프트면 그 까닭(goal·loop·heartbeat·process), 아니면 빈 값."""
    head = str(text or "").lstrip()
    return next((reason for prefix, reason in AUTO_HEADS if head.startswith(prefix)), "")


def live_command(name: str, arg: str) -> str:
    """slash.exec 로 보낼 글. usage 의 인자(reset)는 Codex 한도를 쓰는 동작이라 넘기지 않는다. context 는 all 만.
    review·refine 은 볼 것(인자)을 그대로 넘긴다."""
    if name in ("review", "refine"):
        return "/" + name + (" " + arg if arg else "")
    return "/" + name + (" all" if name == "context" and arg.lower() == "all" else "")


def undone_turns(notice: str) -> int:
    """Hermes undo 안내(↶ Undid N turn…)의 턴 수. 못 읽으면 1."""
    m = re.search(r"Undid (\d+)", str(notice or ""))
    return int(m.group(1)) if m else 1


def sent_display(name: str, arg: str, res: dict) -> str:
    """Hermes 가 만든 글(message)로 보낸 턴의 말풍선 글. plan·learn·goal 은 친 명령, queue·steer 는 글만(DC8).
    goal resume 은 Hermes 가 정한 표시(display)가 있다."""
    if res.get("display"):
        return str(res["display"])
    return f"/{name} {arg}".strip() if name in ("plan", "learn", "goal") else arg


def _rpc(hub, method: str, params: dict, name: str) -> dict:
    from .hermes_chat import ChatUnavailable
    try:
        return hub.request(method, params) or {}
    except ChatUnavailable as exc:
        code = getattr(exc, "code", None)
        if code is None:
            raise
        text = str(exc)
        if code == 5035:
            raise CommandError("failed", tr("에이전트가 다시 시작하는 중입니다 · 잠시 뒤 다시 해 주세요",
                                            "The agent is restarting · Try again shortly")) from None
        if name == "title" and code == 4022:              # 길이·중복(hermes_state_titles.py)
            raise CommandError("failed", tr("같은 제목의 대화가 이미 있습니다", "Another chat already uses this title")
                               if "in use" in text else tr(f"제목을 바꾸지 못했습니다: {text}", f"Could not set the title: {text}")) from None
        if name == "subgoal" and code == 4004:            # 목표 없음·번호 범위 밖·빈 글이 모두 4004(methods_session_control.py)
            low = text.lower()
            if "no active goal" in low:
                raise CommandError("empty", tr("진행 중인 목표가 없습니다 · 먼저 /goal 로 거세요",
                                               "There is no active goal · Set one with /goal first")) from None
            if "out of range" in low:
                raise CommandError("empty", tr("그 번호의 조건이 없습니다", "There is no criterion with that number")) from None
        raise from_hermes(name, exc) from None


def run_rpc(hub, sid: str, name: str, arg: str) -> dict:
    """3단계 명령(스펙 2026-10-27-004) — slash worker 없이 전용 RPC 로. 돌려주는 값은 run 과 같은 모양에 더해
    {kind: btw_pending, count}(곁 질문을 보냈다 — 답은 aas.btw 로 온다). title 은 {stored_key} 도 준다(오피스가 저장 번호로 쓴다)."""
    if name == "title":
        if not arg:
            res = _rpc(hub, "session.title", {"session_id": sid}, name)
            return {"kind": "output", "command": "/title", "text": str(res.get("title") or tr("(제목 없음)", "(Untitled)"))}
        res = _rpc(hub, "session.title", {"session_id": sid, "title": arg}, name)
        title = str(res.get("title") or arg)
        # 첫 말 전에 정한 제목이면 Hermes 자동 제목이 꺼져 session.title 이벤트가 오지 않는다 — 저장 번호를 읽기로 받는다(R8·OV1)
        key = str((_rpc(hub, "session.title", {"session_id": sid}, name) or {}).get("session_key") or "")
        hub.title_set(sid, title, key)
        text = tr(f"제목을 「{title}」로 바꿨습니다", f"Renamed the chat to “{title}”")
        if res.get("pending"):
            text += "\n" + tr("첫 말을 보낸 뒤 적용됩니다", "It applies after the first message")
        return {"kind": "output", "command": "/title", "text": text, "stored_key": key}
    if name == "subgoal":
        word = first_word(arg)
        if not arg:
            control = (_rpc(hub, "session.control.read", {"session_id": sid}, name).get("control") or {})
            goal = control.get("goal") or {}
            subs = goal.get("subgoals") or []
            if not goal:
                raise CommandError("empty", tr("진행 중인 목표가 없습니다 · 먼저 /goal 로 거세요", "There is no active goal · Set one with /goal first"))
            text = "\n".join(f"{i}. {t}" for i, t in enumerate(subs, 1)) or tr("더한 조건이 없습니다", "No extra criteria")
            return {"kind": "output", "command": "/subgoal", "text": text}
        if word == "clear":
            params = {"action": "subgoal.clear"}
        elif word == "remove":
            params = {"action": "subgoal.remove", "args": {"index": int(arg.split()[1])}}
        else:
            params = {"action": "subgoal.add", "args": {"text": arg}}
        res = _rpc(hub, "session.control", {"session_id": sid, **params}, name)
        out = (res.get("dispatch") or {}).get("output") or ""        # 결과는 dispatch 안에 있다(OV2)
        return {"kind": "output", "command": "/subgoal", "text": str(out)}
    if name == "heartbeat":                               # 목표·반복 줄 단추 전용(R9)
        res = _rpc(hub, "session.control", {"session_id": sid, "action": f"heartbeat.{arg}"}, name)
        return {"kind": "output", "command": "/heartbeat", "text": str((res.get("dispatch") or {}).get("output") or "")}
    # btw — 답은 btw.complete 로 따로 온다. 답하는 중이면 그 턴이 끝난 뒤 카드로(R1·R5)
    res = _rpc(hub, "prompt.btw", {"session_id": sid, "text": arg}, name)
    return {"kind": "btw_pending", "count": hub.btw_wait(sid, str(res.get("task_id") or ""), arg)}


def run(hub, sid: str, name: str, arg: str = "", by: str = "", manages: bool = True) -> dict:
    """채팅 화면(/api/chat/command)의 명령 하나. 돌려주는 값(화면이 그리는 모양, 스펙 §11):
      {kind: output, command, text}   결과 카드(DC2)
      {kind: sent, retry?}            보통 턴으로 보냈다(plan·쉬는 중 queue·steer, retry)
      {kind: steered}                 답하는 중 방향 바꾸기를 넣었다(DC7)
      {kind: queued, count}           예약했다(DC8)
      {kind: prefill, text}           undo — 입력창에 넣는다
      {kind: retry_failed, text}      되감았지만 다시 보내지 못했다 — 입력창에 넣는다(R13·DC9)
      {kind: compress_timeout}        180초 안에 끝나지 않았다(R7·DC4)
    manages: 그 에이전트의 주인·관리자인가(goal·loop·memory 쓰기, 2단계 R12).
    거절은 CommandError(9-3·11-4). 연결 끊김은 ChatUnavailable 그대로(503)."""
    from . import skill_commands
    from .hermes_chat import REQUEST_TIMEOUT, ChatUnavailable, RequestTimeout
    name, arg = normalize(name, arg)
    allowed_for(name, arg, manages)
    hub._known(sid)
    busy = hub.running(sid)
    control = name in OWNER_ONLY and first_word(arg) in CONTROL   # 목표·반복 줄 단추 — 답하는 중에도(Hermes 도 막지 않는다)
    if (hub.sessions.get(sid) or {}).get("compressing") or (
            busy and name not in WHILE_BUSY and name not in READ_ONLY and name not in ANYTIME and not control):
        raise busy_error()
    if name in RPC:                                         # 3단계 — 전용 RPC, catalog 를 읽지 않는다
        out = run_rpc(hub, sid, name, arg)
        out.pop("stored_key", None)                         # 오피스만 쓴다
        return out
    cat = skill_commands.read(hub, session_id=sid)          # 실행할 때마다 새로 읽는다(R9)
    check(cat, name)
    if name == "help":
        return {"kind": "output", "command": "/help", "text": help_text(cat, shown_names(cat, manages=manages))}
    if name in LIVE:
        try:
            res = hub.request("slash.exec", {"session_id": sid, "command": live_command(name, arg)}) or {}
        except ChatUnavailable as exc:
            if getattr(exc, "code", None) is None:
                raise
            raise from_hermes(name, exc) from None
        out = {"kind": "output", "command": "/" + name, "text": str(res.get("output") or "")}
        return {**out, "background": True} if name in ("review", "refine") else out     # 결과는 뒤에서 Hermes 가 시작한 턴으로 온다(§4-3)
    if name == "queue" and busy:
        return {"kind": "queued", "count": hub.enqueue(sid, arg, by)}
    if name == "compress":
        hub.compress_begin(sid)
    try:
        res = hub.request("command.dispatch", {"session_id": sid, "name": name, "arg": arg},
                          timeout=COMPRESS_TIMEOUT if name == "compress" else REQUEST_TIMEOUT) or {}
    except RequestTimeout:
        if name == "compress":
            hub.compress_end(sid, "timeout")
            return {"kind": "compress_timeout"}
        raise
    except ChatUnavailable as exc:
        if name == "compress":
            hub.compress_end(sid, "failed")
        if getattr(exc, "code", None) is None:
            raise
        raise from_hermes(name, exc) from None
    if name == "compress":
        hub.compress_end(sid, "done")
    kind = res.get("type")
    if kind in ("exec", "plugin"):
        if name == "steer":
            return {"kind": "steered"}
        return {"kind": "output", "command": "/" + name, "text": str(res.get("output") or "")}
    if kind == "send" and str(res.get("message") or "").strip():
        message = str(res["message"])
        if name == "retry":
            hub.rewind(sid, "retry")
            try:
                hub.send(sid, message, by=by, display=shown(message), retry=True)     # Hermes 로는 저장된 글 그대로
            except ChatUnavailable:
                return {"kind": "retry_failed", "text": shown(message)}
            return {"kind": "sent", "retry": True}
        if name in WHILE_BUSY and hub.running(sid):        # Hermes 가 steer 를 받지 못했거나 그사이 답이 시작됐다 — 다음 턴으로
            return {"kind": "queued", "count": hub.enqueue(sid, arg, by)}
        if name == "goal" and hub.running(sid):             # 답하는 중 goal resume — 목표는 다시 켜졌고 이 턴이 끝나면 Hermes 가 이어 한다
            return {"kind": "output", "command": "/goal", "text": str(res.get("notice") or "")}
        # Hermes 로는 만든 글(message)을 보낸다(SC3). 말풍선 글은 sent_display
        hub.send(sid, message, by=by, display=sent_display(name, arg, res))
        if name == "learn":                                 # 턴이 끝나면 스킬 목록 저장값을 비운다(§4-2)
            hub.sessions[sid]["skills_stale"] = True
        return {"kind": "sent"}
    if kind == "prefill" and name == "undo":
        hub.rewind(sid, "undo", undone_turns(str(res.get("notice") or "")))
        return {"kind": "prefill", "text": shown(str(res.get("message") or ""))}      # /plan 턴이면 친 명령을 입력창에(12-7)
    raise CommandError("unsupported", tr(f"이 화면에서 쓸 수 없는 결과입니다(/{name})", f"This screen cannot show the result of /{name}"))
