# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""작업공간 공유 API(스펙 2026-11-17-008 단계 2, §3-4·§3-5·§3-6). 경로는 server 가 나눠 부른다.

  GET  /api/agents/members?pod=          구성원·관리자가 준 보기·안내 한 줄·공유 시작 시각. 그 작업공간을 볼 수 있는 사람
  POST /api/agents/members               {pod, op:set, email, role:use|edit|none, hide_before?} · {pod, op:note, note}. 주인·팀 관리자·관리자
  GET  /api/agents/members/search?q=     공유할 사람 찾기(Keycloak 사용자 → 로그인 기록). 이름·이메일·부서, 10명까지
  GET  /api/admin/sharing                관리자: 공유 현황(?format=csv 는 내려받기)
  POST /api/settings/sharing             관리자: {enabled} 설치 전체 「소유자 공유 허용」
구성원을 빼면 그 사람의 열린 채팅 스트림은 다음 확인(20초 안)에 끝나고(server._chat_event_stream), 오피스 보기 범위를 다시 그린다."""
from __future__ import annotations

import csv
import io

from ..common import settings, store
from ..common.i18n import tr
from ..fleet import agents, sharing
from ..office import office

SEARCH_MAX = 10
SEARCH_MIN = 2


class ShareError(Exception):
    def __init__(self, message: str, code: int = 400):
        super().__init__(message)
        self.code = code


def _server():
    from . import server
    return server


def _pod(reg, pod_id: str):
    pod = next((p for p in reg.pods if p.id == pod_id), None)
    if pod is None:
        raise ShareError(tr("없는 AI 에이전트 작업공간입니다", "No such AI Agent Workspace"), 404)
    return pod


def can_manage(reg, user, auth_enabled: bool, pod) -> bool:
    """공유 목록을 바꿀 수 있는가: 설치에서 공유를 켰고, 관리자이거나 주인·팀 관리자(_manages_pod). 주인이 지워진 작업공간은 관리자만."""
    if not sharing.enabled():
        return False
    return (not auth_enabled) or reg.is_admin(user) or _server()._manages_pod(pod, user, auth_enabled)


def _person(email: str, people: dict, depts: dict) -> dict:
    return {"email": email, "name": office.display_name(email, people) if "@" in email else email, "department": depts.get(email, "")}


def view(reg, user, auth_enabled: bool, pod_id: str) -> dict:
    pod = _pod(reg, pod_id)
    if auth_enabled and pod.id not in {p.id for p in reg.allowed(user, auth_enabled)}:
        raise ShareError(tr("이 AI 에이전트 작업공간을 볼 수 없습니다", "You cannot see this AI Agent Workspace"), 403)
    people, depts = office.people(), settings.departments()
    members = [{**_person(r["email"], people, depts), "role": r["role"], "by": office.display_name(r["by"] or "", people) if "@" in (r["by"] or "") else "",
                "ts": r["ts"]} for r in reg.member_rows(pod.id)]
    granted = sorted((_person(e, people, depts) for e, g in reg.grants().items() if pod.id in g.get("pods", []) and g.get("role") != "admin"),
                     key=lambda x: x["name"])
    me = str((user or {}).get("email") or "").lower()
    return {"pod": pod.id, "enabled": sharing.enabled(), "can_manage": can_manage(reg, user, auth_enabled, pod),
            "team_notice": sharing.team_notice(pod.id),
            "owner": pod.owner if "@" in (pod.owner or "") else "", "owner_name": _server()._pod_owner_name(pod),
            "my_role": "owner" if (auth_enabled and pod.owned_by(user)) else reg.member_role(user, pod.id) if me else "",
            "members": members, "granted": granted, **sharing.info(pod.id), "note_max": sharing.NOTE_MAX}


def write(reg, user, auth_enabled: bool, body: dict) -> dict:
    s = _server()
    pod = _pod(reg, str(body.get("pod") or ""))
    if not sharing.enabled():
        raise ShareError(tr("관리자가 이 설치에서 AI 에이전트 작업공간 공유를 껐습니다", "An admin turned off AI Agent Workspace sharing for this installation"), 403)
    if not can_manage(reg, user, auth_enabled, pod):
        raise ShareError(tr("이 AI 에이전트 작업공간의 소유자나 관리자만 공유를 바꿀 수 있습니다",
                            "Only the owner of this AI Agent Workspace or an admin can change sharing"), 403)
    me = str((user or {}).get("email") or "local").lower()
    op = str(body.get("op") or "set")
    if op == "note":
        try:
            note = sharing.set_note(pod.id, str(body.get("note") or ""), me)
        except ValueError:
            raise ShareError(tr(f"안내는 {sharing.NOTE_MAX}자까지 쓸 수 있습니다", f"The note can be up to {sharing.NOTE_MAX} characters")) from None
        store.log_usage("member_note", f"{me} {pod.id}", pod=pod.id)
        return {"ok": True, "note": note}
    if op == "team":                                  # 팀 공지 대화방(§6-4): 실패한 예약 작업을 그 봇의 홈 채널로도
        from . import messenger_api
        profile, platform = str(body.get("profile") or ""), str(body.get("platform") or "")
        if profile and not any(b["profile"] == profile and b["platform"] == platform for b in messenger_api.bots(pod)):
            raise ShareError(tr("이 AI 에이전트 작업공간에 연결된 메신저가 아닙니다", "That messenger is not connected to this AI Agent Workspace"))
        got = sharing.set_team_notice(pod.id, profile, platform, me)
        store.log_usage("member_team_notice", f"{me} {pod.id} {profile or '-'} {platform or '-'}", pod=pod.id)
        return {"ok": True, "team_notice": got}
    if op != "set":
        raise ShareError(tr("잘못된 요청", "Invalid request"))
    email, role = str(body.get("email") or "").strip().lower(), str(body.get("role") or "")
    if not agents.EMAIL.match(email):
        raise ShareError(tr("공유할 사람은 이메일 주소로 적습니다", "Enter the person's email address"))
    if role not in (*reg.MEMBER_ROLES, "none"):
        raise ShareError(tr("권한은 대화·편집 중 하나입니다", "The access must be chat or edit"))
    if email == (pod.owner or "").lower():
        raise ShareError(tr("소유자는 구성원으로 넣을 수 없습니다", "The owner cannot be added as a member"))
    before = next((r["role"] for r in reg.member_rows(pod.id) if r["email"] == email), "")
    if role != "none":
        sharing.start(pod.id, bool(body.get("hide_before", True)), me)    # 처음 공유할 때 한 번(숨김 기본 켬, §3-4)
    reg.set_member(pod.id, email, role, me)
    event = "member_remove" if role == "none" else ("member_role" if before else "member_add")
    if role == "none" and not before:
        return {"ok": True, "unchanged": True}
    store.log_usage(event, f"{me} {pod.id} {email} {before or '-'}->{role}", pod=pod.id)
    s._scene_scope_changed()                          # 보기 범위가 바뀐다 — 오피스·작업공간 목록을 다시 그린다(주인 바꿀 때와 같다)
    s.topics.invalidate(s.inbox_topic(email), exact=True)   # 새로 공유받음 알림
    revoked = 0
    if role == "none":                                # 그 사람이 이은 메신저를 철회한다(단계 3, §3-5). 파드가 꺼져 있으면 리더가 다시 시도
        from . import messenger_api
        try:
            from ..ops import notify_out
            notify_out.creators_to_owner(pod.id, email)   # 그 사람이 만든 예약 작업의 결과·실패는 주인이 받는다
            revoked = messenger_api.member_removed(reg, pod, email)
        except Exception as exc:
            print(f"메신저 연결을 철회하지 못했습니다({pod.id}): {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
    from ..ops import restart_pending
    with restart_pending.recording(pod.id, "", me) as rec:   # 이 요청에서 생긴 페어링 기록 — 화면이 me 를 다시 읽는다(스펙 2026-11-18-016 4-4)
        restart = s._messenger_sync(pod) if event != "member_role" else []   # 구성원이 생기거나 없어지면 페어링을 켜고 끈다(§5-1)
    got = restart_pending.outcome(rec)
    return {"ok": True, "event": event, "revoked_links": revoked, "restart_needed": restart, **({"restart_pending": got} if got else {}), **sharing.info(pod.id)}


def search(a, reg, q: str) -> dict:
    """공유할 사람 찾기. Keycloak 사용자를 먼저 보고(로그인한 적 없는 사람도), 닿지 않으면 로그인으로 알게 된 사람(user_directory)."""
    q = " ".join(str(q or "").split()).lower()
    if len(q) < SEARCH_MIN:
        return {"people": []}
    s = _server()
    people: list[dict] = []
    _, kc = s._users_mode(a)
    if kc is not None:
        try:
            for u in s._cached("share:kc_users", 60, kc.list_users, per_lang=False):
                email = str(u.get("email") or "").lower()
                if not email or u.get("enabled") is False:
                    continue
                first, last = str(u.get("firstName") or ""), str(u.get("lastName") or "")
                people.append({"email": email, "name": s._display_name(first, last, str(u.get("username") or "")),
                               "department": s._kc_department(u) or ""})
        except Exception:                             # Keycloak 에 닿지 않으면 로그인 기록으로
            people = []
    if not people:
        known, depts = office.people(), settings.departments()
        people = [_person(e, known, depts) for e in sorted(depts)]
    hits = [p for p in people if q in p["email"] or q in p["name"].lower() or q in p["department"].lower()]
    return {"people": hits[:SEARCH_MAX]}


def overview(reg) -> list[dict]:
    """관리자 공유 현황: 구성원이나 관리자가 준 보기가 있는 작업공간마다 한 줄씩(사람 단위)."""
    s = _server()
    people, depts = office.people(), settings.departments()
    grants = reg.grants()
    rows = []
    for pod in reg.pods:
        owner_name = s._pod_owner_name(pod)
        for r in reg.member_rows(pod.id):
            rows.append({"pod": pod.id, "owner_name": owner_name, **_person(r["email"], people, depts), "role": r["role"], "source": "owner", "ts": r["ts"]})
        for e, g in grants.items():
            if pod.id in g.get("pods", []) and g.get("role") != "admin":
                rows.append({"pod": pod.id, "owner_name": owner_name, **_person(e, people, depts), "role": "use", "source": "admin", "ts": g.get("ts") or ""})
    return rows


def overview_csv(rows: list[dict]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["pod", "owner", "member_email", "member_name", "department", "role", "source", "since"])
    for r in rows:
        w.writerow([r["pod"], r["owner_name"], r["email"], r["name"], r["department"], r["role"], r["source"], r["ts"]])
    return "﻿" + buf.getvalue()                  # 엑셀이 한글을 깨뜨리지 않게 BOM
