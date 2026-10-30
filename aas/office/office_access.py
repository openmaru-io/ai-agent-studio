# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""오피스 접근 규칙 — 누가 어느 에이전트를 보고 시킬 수 있는가(계획 003 §8-1, 결정 R9·R21).

  관리자(또는 로그인을 끈 로컬 실행)  모든 자리·방. 자리·방·구성원을 바꾼다.
  TFT 방 담당                         그 방의 이름·목적·구성원·에이전트(자기 것만 새로)·끝내기를 바꾼다(2026-10-18-009).
  TFT 방 구성원                       그 방의 이름·목적을 바꾼다.
  그 밖의 사람                        ① 자기가 볼 수 있는 설치본(소유·권한을 받은 것)의 자리 ② 자기가 구성원인 방(끝나지 않은 방)에 앉은 자리.
                                      이 둘을 「보이는 자리」라 부른다. 보이는 자리의 에이전트를 오피스 API(상태·스트림·칸반·크론·회의)로 시킬 수 있다.
3D 장면에는 여기에 ③ 자리 팀이 내 부서와 같은 자리를 더해 보인다(scene_aliases, 스펙 2026-10-21-022). 시키는 범위는 늘지 않는다.
오피스 밖 화면(채팅·프로파일 등)의 권한은 이 모듈이 바꾸지 않는다(FR-15: 주인·grants 만).
"""
from __future__ import annotations

from . import office
from ..common import settings
from ..common.i18n import tr


class Denied(Exception):
    """오피스 접근 거절. 화면에 사유를 그대로 보인다."""

    def __init__(self, message: str, code: int = 403):
        super().__init__(message)
        self.code = code


class Access:
    def __init__(self, reg, user, auth_enabled: bool):
        self.email = str((user or {}).get("email") or "").lower()
        self.admin = (not auth_enabled) or reg.is_admin(user)
        self._own_pods = {p.id for p in reg.allowed(user, auth_enabled)}       # 보이는 설치본(주인·접근 권한·팀 에이전트)
        self._owned = {p.id for p in reg.pods if p.owned_by(user)}            # 주인인 설치본만
        self._managed = {p.id for p in reg.managed(user, auth_enabled)}       # 주인 또는 팀 관리자인 설치본(관리자·로그인 끔은 전부)
        self._seats = {s["alias"]: s for s in office.seats() if s["enabled"]}
        self._rooms = {r["id"]: r for r in office.rooms()}
        self._member = office.member_rooms(self.email)

    # ---- 방 ---------------------------------------------------------------
    def rooms(self) -> list[dict]:
        """이 사람에게 보이는 방(관리자는 전부, 그 밖은 구성원인 방)."""
        return [r for r in self._rooms.values() if self.admin or r["id"] in self._member]

    def member_of(self, room_id: int) -> bool:
        return self.admin or room_id in self._member

    def require_room(self, room_id: int) -> dict:
        room = self._rooms.get(room_id)
        if not room:
            raise Denied(tr("없는 방입니다", "No such room"), 404)
        if not self.member_of(room_id):
            raise Denied(tr("이 방의 구성원이 아닙니다. 관리자에게 구성원으로 넣어 달라고 요청하세요.", "You are not a member of this room. Ask an admin to add you."))
        return room

    # ---- 방 고치기(스펙 2026-10-18-009, 사용자 결정 2026-10-18) ---------------
    def room_role(self, room_id: int) -> str:
        """이 방을 고칠 수 있는 역할: admin · owner(담당) · member(구성원) · 빈 값. 팀 방은 관리자만(서버가 다시 거절한다)."""
        room = self._rooms.get(room_id)
        if not room:
            return ""
        if self.admin:
            return "admin"
        if room.get("kind", "tft") == "team" or not self.email:
            return ""
        if (room.get("owner") or "").lower() == self.email:
            return "owner"
        return "member" if room_id in self._member else ""

    def room_edit(self, body: dict) -> dict:
        """관리자가 아닌 사람의 방 고치기 요청을 그 역할이 바꿀 수 있는 칸만 남긴 room.set 요청으로 바꾼다. 안 되면 Denied.
        구성원: 이름·목적. 담당: 거기에 구성원(열쇠로 받는다)·에이전트·방 끝내기. 담당 바꾸기·방 지우기·새 방은 관리자만.
        에이전트는 내가 관리하는 것(내 것, 팀 관리자면 팀원 것)만 새로 넣는다(D14) — 방 구성원은 그 방에 앉은 에이전트를 쓸 수 있어, 남의 것을 넣으면 그 권한을 얻는다."""
        rid = int(body.get("id") or 0)
        if str(body.get("action") or "") != "room.set" or not rid:
            raise Denied(tr("방 만들기와 지우기는 관리자만 할 수 있습니다", "Only admins can create or delete rooms"))
        role = self.room_role(rid)
        if not role:
            raise Denied(tr("이 방의 담당이나 구성원만 고칠 수 있습니다", "Only the room's owner or members can edit it"))
        old = self._rooms[rid]
        out = {"action": "room.set", "id": rid, "name": body.get("name", old["name"]), "purpose": body.get("purpose", old["purpose"]),
               "owner": old["owner"], "seats": old["seats"], "status": old["status"]}
        if role == "member":
            return out                                                     # members·people 를 보내지 않아 그대로 남는다
        new_seats = [str(a) for a in (body.get("seats") if isinstance(body.get("seats"), list) else old["seats"])]
        added = [a for a in new_seats if a not in old["seats"]]
        if any(not self.manages(a) for a in added):
            raise Denied(tr("내가 관리하지 않는 AI 에이전트는 방에 새로 넣을 수 없습니다. 내 AI 에이전트와 내가 팀 관리자인 팀원의 AI 에이전트만 넣을 수 있습니다.",
                            "You can only add AI Agents you manage (your own, or your team's as a team manager) to a room."))
        out["seats"] = new_seats
        if str(body.get("status") or "") in ("open", "closed"):
            out["status"] = body["status"]
        if isinstance(body.get("members"), list):
            emails = []
            for k in body["members"]:
                email = office.email_of_key(str(k))
                if not email:
                    raise Denied(tr("모르는 사람이 구성원에 있습니다. 화면을 새로 고친 뒤 다시 고르세요.",
                                    "An unknown person is in the member list. Reload the page and choose again."), 400)
                emails.append(email)
            out["members"] = emails                                        # 담당은 set_room 이 구성원에 다시 넣는다
        return out

    # ---- 자리 -------------------------------------------------------------
    def visible_aliases(self) -> set[str]:
        if self.admin:
            return set(self._seats)
        mine = {a for a, s in self._seats.items() if s["pod"] in self._own_pods}
        # 팀 방(kind='team')은 뺀다. 팀 방 구성원은 Keycloak 부서로 정해지고(사용자가 바꿀 수 있다) 에이전트는 그 팀 자리 전부라,
        # 넣으면 같은 부서 사람끼리 서로의 에이전트에게 1:1 대화·크론·칸반을 시킬 수 있다(계획 2026-10-13-011 §7 리뷰 A1).
        # 팀 방 구성원이 할 수 있는 것은 그 방 회의를 보고 말하는 것까지다(require_room)
        via_rooms = {a for r in self.rooms() if r["status"] != "closed" and r.get("kind", "tft") != "team"
                     for a in r["seats"] if a in self._seats}
        return mine | via_rooms

    # ---- 3D 장면의 보기 범위(스펙 2026-10-21-022) ------------------------------
    # 장면이 덜 복잡하도록 보이는 것을 줄인다(비밀 보호가 목적이 아니다). 시키는 범위(visible_aliases)는 그대로 두고 그 위에 ③ 을 더한다.
    def _my_team(self) -> str:
        """내 부서를 자리 팀과 같은 모양으로. default_teams 가 팀에 부서명을 80자로 잘라 넣으므로 같이 자른다. 부서가 없으면 빈 값."""
        dept = settings.departments().get(self.email, "") if self.email else ""
        return office.team_key(office._text(dept, 80))

    def scene_aliases(self) -> set[str]:
        """장면에 보이는 자리: ① 내 것 ② 내가 구성원인 열린 TFT 방 ③ 자리 팀이 내 부서와 같은 자리. 관리자는 전부."""
        if self.admin:
            return set(self._seats)
        team = self._my_team()
        same_team = {a for a, s in self._seats.items() if office.team_key(s.get("team")) == team} if team else set()
        return self.visible_aliases() | same_team

    def scene_people(self) -> set[str] | None:
        """장면에 보이는 사람 이메일: 나, 같은 부서 사람, 내가 구성원인 열린 TFT 방의 구성원. 관리자는 None(거르지 않음)."""
        if self.admin:
            return None
        out = {self.email} if self.email else set()
        team = self._my_team()
        if team:
            out |= {e for e, d in settings.departments().items() if office.team_key(office._text(d, 80)) == team}
        for r in self.rooms():
            if r["status"] != "closed" and r.get("kind", "tft") != "team":
                out |= {m.lower() for m in r.get("members") or []}
        return out

    def can_use(self, alias: str) -> bool:
        return self.admin or alias in self.visible_aliases()       # 관리자는 없는 자리 이름도 통과시켜 칸반·크론이 사유(profile_not_found)를 낸다

    def require_use(self, alias: str) -> None:
        if alias and not self.can_use(alias):
            name = office.seat_labels().get(alias, alias)          # 자동 별칭(설치본 id)이면 에이전트 이름(스펙 2026-10-19-003)
            raise Denied(tr(f"{name} 는 내가 쓸 수 있는 AI 에이전트가 아닙니다. 내 AI 에이전트이거나 내가 구성원인 방에 앉아 있어야 합니다.",
                         f"{name} is not an AI Agent you can use. It must be your AI Agent or be seated in a room you belong to."))

    def seat_of(self, alias: str) -> dict | None:
        return self._seats.get(alias)

    def owns(self, alias: str) -> bool:
        """이 자리의 설치본 주인인가. 접근 권한만 받은 사람과 팀 관리자는 아니다."""
        seat = self._seats.get(alias)
        return bool(seat and seat["pod"] in self._owned)

    def managed_aliases(self) -> set[str]:
        """내가 관리하는 자리 전부(관리자는 전부). 회의에서 주인의 위키 계정으로 쓰게 둘 에이전트를 고른다(스펙 2026-10-23-004 15-9)."""
        return {a for a in self._seats if self.manages(a)}

    def manages(self, alias: str) -> bool:
        """이 자리를 관리하는가: 관리자, 주인, 그 설치본의 팀 관리자. 접근 권한만 받은 사람은 아니다(D12)."""
        if self.admin:
            return True
        seat = self._seats.get(alias)
        return bool(seat and seat["pod"] in self._managed)

    def acting_on_others(self, alias: str) -> bool:
        """남의 에이전트를 시키는 요청인가(변경 기록 대상)."""
        return bool(alias) and not self.admin and not self.owns(alias)


# 장면 이벤트의 공개 범위(계획 007 §3-2, R1·R5). 표에 없는 종류는 아무에게도 보내지 않는다(기본 거부, M2).
#   public — 오피스에 들어온 로그인 사용자 모두(자리·이름·상태·도구 이름)
#   party  — payload["_to"] 에 적힌 사람(대화를 시작한 사람·에이전트 주인)과 관리자. "_to" 는 보내기 전에 뺀다
PUBLIC_EVENTS = frozenset({"agent.status", "seat.added", "seat.removed", "chat.start", "chat.end", "tool", "agent.lastSeen",
                           "layout.changed", "desks.changed"})
PARTY_EVENTS = frozenset({"chat.delta"})


def event_view(etype: str, payload: dict, email: str, admin: bool) -> dict | None:
    """이 사람에게 보낼 이벤트 내용. 보내지 않으면 None."""
    if etype in PUBLIC_EVENTS:
        return payload
    if etype in PARTY_EVENTS:
        to = payload.get("_to") or []
        if admin or (email and email.lower() in to):
            return {k: v for k, v in payload.items() if k != "_to"}
    return None
