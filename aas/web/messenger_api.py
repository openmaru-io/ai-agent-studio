# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""내 메신저 계정 연결과 페어링 켜기(스펙 2026-11-17-008 단계 3, §5). 경로는 server 가 나눠 부른다.

  GET  /api/messenger/links?pod=     연결할 수 있는 봇(프로파일 × 메신저)과 내 연결, 소유자에게는 다시 시작이 필요한 프로파일
  POST /api/messenger/links          {pod, op: link, profile, platform, code} · {pod, op: unlink, profile, platform, user_id}
                                     · {pod, op: apply} (소유자: 페어링 설정을 반영하려고 게이트웨이 다시 시작)
페어링 켜기: 구성원이 있고 메신저가 연결된 프로파일은 config.yaml 의 platforms.<p>.extra.dm_policy 를 pairing 으로, 구성원이
없으면 빈 값으로 둔다(sync_pairing). 프로파일마다 읽는 것은 Hermes 패치(pairing-profile-dm-policy)가 한다. 값을 바꾸면 게이트웨이가
다시 떠야 읽히므로(사전 확인 §9) 다시 시작이 필요한 프로파일을 다시 시작 장부(restart_pending, 스펙 2026-11-18-016)에 적어 두고
소유자가 시점을 고른다. 예전에는 meta 의 messenger_restart:<pod> 였다 — 서버가 시작할 때 장부로 옮긴다.
"""
from __future__ import annotations

from ..common import i18n, store
from ..common.i18n import tr
from ..hermes.hermes_api import HermesAPI, HermesError
from ..office import office
from ..ops import messenger_links, owner_guard, restart_pending


class MessengerError(Exception):
    def __init__(self, message: str, code: int = 400, reason: str = ""):
        super().__init__(message)
        self.code, self.reason = code, reason


def _server():
    from . import server
    return server


def _pod(reg, pod_id: str):
    pod = next((p for p in reg.pods if p.id == pod_id), None)
    if pod is None:
        raise MessengerError(tr("없는 AI 에이전트 작업공간입니다", "No such AI Agent Workspace"), 404)
    return pod


def bots(pod) -> list[dict]:
    """연결된 메신저(프로파일 × 플랫폼). AAS 화면이 다루는 네 메신저만."""
    s = _server()
    out = []
    for prof in s._channels(pod).get("profiles", []):
        for p in prof.get("platforms") or []:
            if p.get("name") in owner_guard.CHANNELS and p.get("configured"):
                out.append({"profile": prof["name"], "platform": p["name"], "state": p.get("state") or "", "connected": p.get("state") == "connected"})
    return out


def may_link(reg, user, auth_enabled: bool, pod) -> bool:
    """자기 메신저를 이 작업공간에 이을 수 있는가: 구성원(대화·편집)과 주인·팀 관리자·관리자."""
    s = _server()
    if not auth_enabled:
        return True
    return pod.owned_by(user) or reg.is_admin(user) or s._manages_pod(pod, user, True) or bool(reg.member_role(user, pod.id))


def _restart_needed(pod_id: str) -> list[str]:
    """메신저 페어링·채널 기록이 남은 프로파일(다시 시작 장부)."""
    return restart_pending.profiles_with(pod_id, ("pairing", "channel"))


def view(reg, user, auth_enabled: bool, pod_id: str) -> dict:
    s = _server()
    pod = _pod(reg, pod_id)
    if auth_enabled and pod.id not in {p.id for p in reg.allowed(user, auth_enabled)}:
        raise MessengerError(tr("이 AI 에이전트 작업공간을 볼 수 없습니다", "You cannot see this AI Agent Workspace"), 403)
    me = str((user or {}).get("email") or "").lower()
    manages = (not auth_enabled) or reg.is_admin(user) or s._manages_pod(pod, user, auth_enabled)
    mine = [{k: r[k] for k in ("profile", "platform", "platform_user_id", "user_name", "dm_chat_id", "ts")} for r in messenger_links.links(pod.id, me)] if me else []
    return {"pod": pod.id, "can_link": may_link(reg, user, auth_enabled, pod), "bots": bots(pod), "mine": mine,
            "owner_name": s._pod_owner_name(pod), "restart_needed": _restart_needed(pod.id) if manages else []}


def _hermes_error(exc: HermesError) -> MessengerError:
    if exc.code == 429:
        return MessengerError(tr("이 봇의 연결 시도가 너무 많아 잠시 잠겼습니다. 1시간 뒤 다시 시도하세요.",
                                 "Too many link attempts on this bot; it is locked for a while. Try again in an hour."), 429, "hermes_locked")
    if exc.code == 404:
        return MessengerError(tr("코드가 맞지 않거나 1시간이 지났습니다. 봇에게 다시 말을 걸어 새 코드를 받으세요.",
                                 "The code is wrong or more than an hour old. Message the bot again to get a new code."), 404, "code_invalid")
    return MessengerError(str(exc), exc.code if 400 <= exc.code < 600 else 502, "hermes")


def link(reg, user, auth_enabled: bool, body: dict) -> dict:
    """구성원(또는 주인)이 봇에게서 받은 코드로 자기 메신저 계정을 잇는다. code 로만 승인한다 — request_id 는 받지 않는다(§5-2)."""
    s = _server()
    pod = _pod(reg, str(body.get("pod") or ""))
    if not may_link(reg, user, auth_enabled, pod):
        raise MessengerError(tr("이 AI 에이전트 작업공간을 공유받은 사람만 메신저를 연결할 수 있습니다",
                                "Only people this AI Agent Workspace is shared with can link a messenger"), 403)
    profile, platform = str(body.get("profile") or ""), str(body.get("platform") or "")
    if not any(b["profile"] == profile and b["platform"] == platform for b in bots(pod)):
        raise MessengerError(tr("소유자가 아직 이 메신저를 연결하지 않았습니다", "The owner has not connected this messenger yet"), 400, "no_bot")
    code = messenger_links.clean_code(body.get("code"))
    if not code:
        raise MessengerError(tr("연결 코드는 봇이 보낸 8자리 영문·숫자입니다", "The link code is the 8 letters and digits the bot sent"), 400, "code_format")
    me = str((user or {}).get("email") or "local").lower()
    bot = f"{pod.id}|{profile}|{platform}"
    mine_left, bot_left = messenger_links.tries_left(me, bot)
    if mine_left <= 0 or bot_left <= 0:
        raise MessengerError(tr("연결 시도가 많아 1시간 동안 막혔습니다. 잠시 뒤 다시 시도하세요.", "Too many link attempts. Try again in an hour."),
                             429, "aas_limit")
    messenger_links.note_try(me, bot)
    prof = None if _is_root(pod, profile) else profile
    try:
        res = HermesAPI(s.hub(pod).auth).call("POST", "/api/pairing/approve", {"platform": platform, "code": code, "profile": prof}, {"profile": prof})
    except HermesError as exc:
        raise _hermes_error(exc) from None
    got = (res or {}).get("user") if isinstance(res, dict) else None
    if not isinstance(got, dict) or not got.get("user_id"):
        raise MessengerError(tr("메신저가 연결 결과를 돌려주지 않았습니다", "The messenger did not return the link result"), 502, "hermes")
    row = messenger_links.record(pod.id, profile, platform, got, me, i18n.get_lang())
    messenger_links.forget_tries(me, bot)
    store.log_usage("messenger_link", f"{me} {pod.id} {profile} {platform} {row['platform_user_id']}", pod=pod.id)
    _drop_channel_cache(pod, profile)
    s.topics.invalidate(s.inbox_topic((pod.owner or "").lower()), exact=True)      # 주인에게 「○○님이 @이름 을 연결」
    return {"ok": True, "link": {k: row[k] for k in ("profile", "platform", "platform_user_id", "user_name", "dm_chat_id", "ts")},
            "delivery": bool(row["dm_chat_id"]) or platform in ("telegram", "slack")}


def unlink(reg, user, auth_enabled: bool, body: dict) -> dict:
    """연결 해제: 자기 것은 본인이, 남의 것은 주인·팀 관리자·관리자가. Hermes 허용 목록에서도 뺀다."""
    s = _server()
    pod = _pod(reg, str(body.get("pod") or ""))
    profile, platform, uid = str(body.get("profile") or ""), str(body.get("platform") or ""), str(body.get("user_id") or "")
    row = next((r for r in messenger_links.links(pod.id, profile=profile) if r["platform"] == platform and r["platform_user_id"] == uid), None)
    if row is None:
        raise MessengerError(tr("없는 연결입니다", "No such link"), 404)
    me = str((user or {}).get("email") or "").lower()
    manages = (not auth_enabled) or reg.is_admin(user) or s._manages_pod(pod, user, auth_enabled)
    if auth_enabled and row["email"] != me and not manages:
        raise MessengerError(tr("자기 연결만 해제할 수 있습니다", "You can only remove your own link"), 403)
    revoke(pod, row)
    store.log_usage("messenger_unlink", f"{me or 'local'} {pod.id} {profile} {platform} {uid}", pod=pod.id)
    return {"ok": True}


def _drop_channel_cache(pod, profile: str) -> None:
    """「메신저 연결」 탭의 승인 목록 캐시(20초)를 버려 연결한 이름이 바로 보이게 한다."""
    _server()._drop_pod_key(pod, f"chanhermes:{profile}:0", f"chanhermes:{profile}:1")


def _is_root(pod, profile: str) -> bool:
    s = _server()
    return bool(next((r for r in s._profile_rows(pod) if r["name"] == profile), {}).get("is_default"))


def revoke(pod, row: dict) -> bool:
    """Hermes 에서 철회하고 연결 줄을 지운다. Hermes 에 닿지 않으면 리더가 다시 시도할 큐에 넣는다. 바로 철회했으면 True."""
    s = _server()
    messenger_links.drop(pod.id, row["profile"], row["platform"], row["platform_user_id"])
    _drop_channel_cache(pod, row["profile"])
    try:
        prof = None if _is_root(pod, row["profile"]) else row["profile"]
        HermesAPI(s.hub(pod).auth).call("POST", "/api/pairing/revoke", {"platform": row["platform"], "user_id": row["platform_user_id"], "profile": prof},
                                        {"profile": prof})
        return True
    except HermesError as exc:
        if exc.code == 404:                       # 이미 허용 목록에 없다
            return True
        messenger_links.queue_revoke(pod.id, row["profile"], row["platform"], row["platform_user_id"])
        return False
    except Exception:                             # 파드가 꺼져 있거나 닿지 않는다
        messenger_links.queue_revoke(pod.id, row["profile"], row["platform"], row["platform_user_id"])
        return False


def member_removed(reg, pod, email: str) -> int:
    """구성원을 뺄 때(또는 퇴사) 그 사람이 이 작업공간에 이은 메신저를 모두 철회한다. 철회한(또는 큐에 넣은) 수.
    그 사람의 대화방으로 결과를 보내던 예약 작업은 받는 곳을 local 로 바꾼다 — 작업공간 결과가 나간 사람에게 계속 가지 않게(§3-5)."""
    from ..ops import notify_out
    rows = messenger_links.links(pod.id, email)
    _retarget_jobs(pod, {(t["profile"], f"{t['platform']}:{t['chat_id']}") for t in notify_out.targets(rows)})
    for r in rows:
        revoke(pod, r)
    return len(rows)


def _retarget_jobs(pod, targets: set[tuple[str, str]]) -> int:
    """(프로파일, 받는 곳) 의 예약 작업 받는 곳을 local 로. Hermes 에 닿지 않으면 넘긴다(결과는 그 사람의 DM 으로 가지만 봇 허용은 철회된다)."""
    if not targets:
        return 0
    s = _server()
    api = HermesAPI(s.hub(pod).auth)
    done = 0
    for profile in {p for p, _ in targets}:
        prof = None if _is_root(pod, profile) else profile
        try:
            res = api.call("GET", "/api/cron/jobs", query={"profile": prof})
            jobs = res.get("jobs", res) if isinstance(res, dict) else res
            for j in jobs if isinstance(jobs, list) else []:
                if isinstance(j, dict) and (profile, str(j.get("deliver") or "")) in targets and j.get("id"):
                    api.call("PUT", f"/api/cron/jobs/{j['id']}", {"updates": {"deliver": "local"}}, {"profile": prof})
                    done += 1
        except (HermesError, OSError) as exc:
            print(f"예약 작업 받는 곳을 돌리지 못했습니다({pod.id} {profile}): {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
    return done


def retry_revokes(reg) -> int:
    """리더: 큐의 철회를 다시 시도한다. 성공한 수."""
    s = _server()
    done = 0
    for row in messenger_links.due_revokes():
        pod = next((p for p in reg.pods if p.id == row["pod"]), None)
        if pod is None:                            # 작업공간이 없어졌다 — 허용 목록도 함께 사라졌다
            messenger_links.revoke_done(row)
            continue
        try:
            prof = None if _is_root(pod, row["profile"]) else row["profile"]
            HermesAPI(s.hub(pod).auth).call("POST", "/api/pairing/revoke", {"platform": row["platform"], "user_id": row["platform_user_id"], "profile": prof},
                                            {"profile": prof})
            messenger_links.revoke_done(row)
            done += 1
        except HermesError as exc:
            if exc.code == 404:
                messenger_links.revoke_done(row)
                done += 1
            elif not messenger_links.revoke_failed(row):
                print(f"메신저 연결 철회를 포기했습니다: {row['pod']} {row['profile']} {row['platform']}", flush=True)   # i18n-ignore: 로그
        except Exception:
            if not messenger_links.revoke_failed(row):
                print(f"메신저 연결 철회를 포기했습니다: {row['pod']} {row['profile']} {row['platform']}", flush=True)   # i18n-ignore: 로그
    return done


def _dm_policy(cfg: dict, platform: str) -> str:
    plat = ((cfg.get("platforms") or {}) if isinstance(cfg, dict) else {}).get(platform)
    if not isinstance(plat, dict):
        return ""
    extra = plat.get("extra") if isinstance(plat.get("extra"), dict) else {}
    return str(extra.get("dm_policy") or plat.get("dm_policy") or "").strip().lower()


def sync_pairing(reg, pod) -> list[str]:
    """구성원이 있으면 메신저가 연결된 프로파일의 dm_policy 를 pairing 으로, 없으면 빈 값으로 맞춘다. 바꾼 프로파일 이름.
    「pairing」 이 아닌 값(소유자·관리자가 직접 고른 allowlist 등)은 건드리지 않는다. 바꾼 프로파일은 다시 시작이 필요하다고 적는다."""
    from ..fleet import sharing
    s = _server()
    want = "pairing" if sharing.enabled() and reg.member_rows(pod.id) else ""
    changed: list[str] = []
    api = HermesAPI(s.hub(pod).auth)
    for b in bots(pod):
        prof = None if _is_root(pod, b["profile"]) else b["profile"]
        try:
            cfg = api.call("GET", "/api/config", query={"profile": prof, "include_defaults": "false"})
            now = _dm_policy(cfg, b["platform"])
            if now == want or (now and now != "pairing"):
                continue
            api.call("PUT", "/api/config", {"config": {"platforms": {b["platform"]: {"extra": {"dm_policy": want}}}}, "profile": prof}, {"profile": prof})
            changed.append(b["profile"])
            restart_pending.note(restart_pending.needs_restart("pairing", name=b["platform"]), pod=pod.id, profile=b["profile"])
        except HermesError as exc:
            print(f"페어링 설정을 맞추지 못했습니다({pod.id} {b['profile']} {b['platform']}): {exc.code}", flush=True)   # i18n-ignore: 로그
    if changed:
        store.log_usage("messenger_pairing", f"{pod.id} {want or 'off'} {','.join(sorted(set(changed)))}", pod=pod.id)
    return sorted(set(changed))


def apply(reg, user, auth_enabled: bool, body: dict) -> dict:
    """소유자가 고른 때 게이트웨이를 다시 시작해 페어링 설정을 읽게 한다. 기존 profile action mcp_apply 와 같은 길."""
    s = _server()
    pod = _pod(reg, str(body.get("pod") or ""))
    if auth_enabled and not (reg.is_admin(user) or s._manages_pod(pod, user, True)):
        raise MessengerError(tr("이 AI 에이전트 작업공간의 소유자나 관리자만 다시 시작할 수 있습니다",
                                "Only the owner of this AI Agent Workspace or an admin can restart it"), 403)
    todo = _restart_needed(pod.id)
    who = str((user or {}).get("email") or "local")
    for name in todo:
        if name not in _restart_needed(pod.id):               # 쿠버네티스는 루트 한 번으로 작업공간 기록이 모두 지워진다
            continue
        try:
            s._profile_action(pod, {"action": "mcp_apply", "name": name}, who)   # 성공하면 그 프로파일의 기록을 지운다
        except (HermesError, ValueError) as exc:
            raise MessengerError(tr(f"다시 시작하지 못했습니다: {exc}", f"Could not restart: {exc}"), getattr(exc, "code", 502) if getattr(exc, "reason", "") == "restart_locked" else 502) from None
    return {"ok": True, "restarted": todo}


def owner_items(reg, email: str, days: int = 7) -> list[dict]:
    """주인에게: 최근 7일 안에 다른 사람이 내 작업공간에 이은 메신저(§5-2 소유자 알림). 확인하면 사라진다."""
    from datetime import datetime, timedelta, timezone
    from ..ops import workspace_notices
    me = (email or "").lower()
    if not me:
        return []
    seen = workspace_notices.acked(me)
    people = office.people()
    out = []
    now = datetime.now(timezone.utc)
    for pod in reg.pods:
        if (pod.owner or "").lower() != me:
            continue
        for r in messenger_links.links(pod.id):
            if r["email"] == me:
                continue
            item_id = f"{workspace_notices.LINK_PREFIX}{pod.id}|{r['profile']}|{r['platform']}|{r['platform_user_id']}|{r['ts']}"
            try:
                at = datetime.fromisoformat(r["ts"])
            except ValueError:
                continue
            if at.tzinfo is None:
                at = at.replace(tzinfo=timezone.utc)
            if item_id in seen or now - at > timedelta(days=days):
                continue
            out.append({"id": item_id, "kind": "messenger_linked", "pod": pod.id, "alias": r["profile"], "profile": r["profile"],
                        "platform": r["platform"], "user_name": r["user_name"], "member_name": office.display_name(r["email"], people), "at": at.timestamp()})
    return out
