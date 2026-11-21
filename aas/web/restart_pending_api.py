# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""게이트웨이 다시 시작 필요 — /api/me 의 pod.restart_pending 과 두 경로(스펙 2026-11-18-016 4-4). 경로는 server 가 나눠 부른다.

  POST /api/restart-pending/apply    {pod, profiles?, since?}  기록이 있는 게이트웨이를 하나씩 다시 시작한다
  POST /api/restart-pending/dismiss  {pod, profile, kind, target} · {pod, all: true}  「반영됨으로 표시」
권한은 _may_restart(관리자이거나 _manages_pod) 하나로, 상단 막대 아이콘과 두 경로가 함께 쓴다.
"""
from __future__ import annotations

import time

from ..common.i18n import tr
from ..common.redact import redact
from ..hermes.hermes_api import HermesError
from ..ops import mindwiki_connect, restart_pending


class RestartError(Exception):
    def __init__(self, message: str, code: int, reason: str, field: str = "", **extra):
        super().__init__(message)
        self.code, self.reason, self.field, self.extra = code, reason, field, extra
        self.retry_after = extra.pop("retry_after", None)


def _server():
    from . import server
    return server


def may_restart(pod, user, auth_enabled: bool, reg=None) -> bool:
    """다시 시작할 수 있는 사람: 로그인을 끈 설치·관리자·주인·팀 관리자. mcp_apply(OWNER_PROFILE_ACTIONS)와 같은 조건."""
    s = _server()
    if not auth_enabled:
        return True
    return pod is not None and ((reg or s.registry()).is_admin(user) or s._manages_pod(pod, user, auth_enabled))


def _reader(pod):
    return lambda: restart_pending.read_starts(pod.hermes_home, shared_all=bool(pod.sidecar_url))


def view(pod, user, auth_enabled: bool, reg) -> dict | None:
    """/api/me 의 pod.restart_pending. 다시 시작할 수 없는 사람에게는 None(빼서 아이콘이 보이지 않게).
    읽기만 한다 — 시작 시각이 15초보다 오래됐으면 백그라운드 갱신만 걸고, 캐시한 시작 시각으로 지워질 기록을 거른다(4-3)."""
    if pod is None or not may_restart(pod, user, auth_enabled, reg):
        return None
    got = restart_pending.items(pod.id)
    if any(r["kind"] != "mindwiki" and r["at"] for r in got["items"]):
        starts = restart_pending.starts_for_view(pod.id, _reader(pod), where="gateway-starts.log")
        if starts:
            got = restart_pending.items(pod.id, starts=starts)
    from ..fleet import sharing
    from ..office import office
    try:
        members = bool(sharing.enabled() and reg.member_rows(pod.id))
    except Exception:
        members = False
    known = office.people()                                    # 이메일 대신 사람 이름(by_name)을 함께 싣는다(2026-10-30 표시 규칙)
    got["items"] = [{**r, "by_name": office.person_name(r["by"], known)} for r in got["items"]]
    return {**got, "has_members": members, "shared_gateway": bool(pod.sidecar_url)}   # 쿠버네티스: 게이트웨이 하나가 모든 프로파일(영향 안내 문구)


def _pod(reg, user, auth_enabled: bool, pod_id: str):
    if any(p.id == pod_id for p in getattr(reg, "restarting", []) or []):
        raise RestartError(tr("이미 다시 시작하는 중입니다", "Already restarting"), 409, "restart_in_progress")
    pod = next((p for p in reg.pods if p.id == pod_id), None)
    if pod is None:
        raise RestartError(tr("없는 AI 에이전트 작업공간입니다", "No such AI Agent Workspace"), 404, "not_found")
    if not may_restart(pod, user, auth_enabled, reg):
        raise RestartError(tr("이 AI 에이전트 작업공간의 소유자나 관리자만 다시 시작할 수 있습니다",
                              "Only the owner of this AI Agent Workspace or an admin can restart it"), 403, "forbidden")
    return pod


def _groups(pod, targets: list[str]) -> list[tuple[str, list[str]]]:
    """다시 시작할 게이트웨이와 그것이 반영하는 프로파일. 쿠버네티스는 루트 하나가 작업공간 전체, compose 는 프로파일마다 하나."""
    if pod.sidecar_url:
        return [(targets[0], list(targets))]
    return [(t, [t]) for t in targets]


def apply(reg, user, auth_enabled: bool, body: dict) -> dict:
    """기록이 있는 프로파일(또는 profiles)을 게이트웨이 단위로 다시 시작한다. 대상마다 _profile_action 의 mcp_apply 를 부른다 —
    MindWiki 세대 번호·기록 지우기·잠금이 그 경로에서 함께 처리된다. since 를 주면(결과를 모르는 요청의 「다시 시도」) 먼저
    게이트웨이 시작 시각이 since 뒤로 바뀌었는지 보고, 바뀌었으면 다시 시작하지 않고 기록만 지운다."""
    s = _server()
    pod = _pod(reg, user, auth_enabled, str(body.get("pod") or ""))
    who = str((user or {}).get("email") or "local")
    have = sorted({r["profile"] for r in restart_pending.all_items(pod.id)})
    wanted = body.get("profiles")
    if wanted is not None:
        if not isinstance(wanted, list) or not all(isinstance(p, str) for p in wanted):
            raise RestartError(tr("profiles 는 프로파일 이름 목록입니다", "profiles must be a list of profile names"), 400, "invalid", "profiles")
        unknown = [p for p in wanted if p not in have]
        if unknown:
            raise RestartError(tr(f"다시 시작 기록이 없는 프로파일입니다: {', '.join(unknown)[:200]}", f"No restart record for: {', '.join(unknown)[:200]}"),
                               400, "unknown_profile", "profiles")
        targets = sorted(set(wanted))
    else:
        targets = have
    if not targets:
        return {"done": [], "failed": []}
    asked = time.time()
    groups = _groups(pod, targets)
    since = body.get("since")
    started = None
    if isinstance(since, (int, float)) and since > 0:
        started = restart_pending.refresh_starts(pod.id, _reader(pod), where="retry")
    done: list[str] = []
    failed: list[dict] = []
    try:
        with restart_pending.restart_gate(pod.id, targets=len(groups), step=s.RESTART_STEP) as gate:
            for gw, covered in groups:
                if started and (started.get(gw) or 0) > float(since):   # 앞선 요청이 실제로 다시 시작했다 — 두 번 하지 않는다
                    restart_pending.clear(pod.id, None if pod.sidecar_url else covered, before=float(since))
                    done += covered
                    continue
                gate.extend(s.RESTART_STEP + 30)
                try:
                    s._profile_action(pod, {"action": "mcp_apply", "name": gw}, who)
                    done += covered
                except HermesError as exc:
                    failed += [{"profile": p, "reason": "outcome_unknown" if exc.reason == "timeout" else "hermes", "error": redact(str(exc), 300)} for p in covered]
                except (s.files.FileError, ValueError) as exc:
                    failed += [{"profile": p, "reason": getattr(exc, "reason", "") or "invalid", "error": redact(str(exc), 300)} for p in covered]
    except restart_pending.Locked as exc:
        raise RestartError(tr(f"다른 요청이 다시 시작을 처리하는 중입니다. {exc.retry_after}초 뒤 다시 하세요.",
                              f"Another request is handling the restart. Try again in {exc.retry_after} seconds."),
                           409, "restart_locked", retry_after=exc.retry_after) from None
    s.store.log_usage("restart_pending_apply", f"{who} {pod.id} done={','.join(done)[:200]} failed={','.join(f['profile'] for f in failed)[:200]}", pod=pod.id)
    if failed:
        raise RestartError(tr("일부 게이트웨이를 다시 시작하지 못했습니다" if done else "게이트웨이를 다시 시작하지 못했습니다",
                              "Some gateways could not be restarted" if done else "The gateway could not be restarted"),
                           502, "restart_partial_failed" if done else "restart_failed", done=done, failed=failed, asked_at=asked)
    return {"done": done, "failed": []}


def dismiss(reg, user, auth_enabled: bool, body: dict) -> dict:
    """「반영됨으로 표시」. 같은 요청을 여러 번 보내도 200. MindWiki 줄은 세대 번호를 적용됨으로 적는다(mark_applied)."""
    s = _server()
    pod = _pod(reg, user, auth_enabled, str(body.get("pod") or ""))
    who = str((user or {}).get("email") or "local")
    if body.get("all") is True:
        n = restart_pending.dismiss_all(pod.id)
        s.store.log_usage("restart_pending_dismiss", f"{who} {pod.id} all n={n}", pod=pod.id)
        return {"ok": True, "removed": n}
    profile, kind, target = (str(body.get(k) or "")[:restart_pending.CUT] for k in ("profile", "kind", "target"))
    if kind not in restart_pending.KINDS or not profile or not target:
        raise RestartError(tr("지울 기록이 맞지 않습니다", "Invalid record"), 400, "invalid", "kind" if kind not in restart_pending.KINDS else "profile")
    if kind == "mindwiki":
        try:
            n = mindwiki_connect.mark_applied(mindwiki_connect.apply_snapshot(pod.id, [profile]))
        except Exception as exc:
            print(f"MindWiki 적용됨 표시 실패({pod.id} {profile}): {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
            raise RestartError(tr("MindWiki 기록을 반영됨으로 표시하지 못했습니다. 다시 해 보세요.", "Could not mark the MindWiki record as applied. Try again."),
                               500, "mindwiki_mark_failed") from None
    else:
        n = restart_pending.dismiss(pod.id, profile, kind, target)
    s.store.log_usage("restart_pending_dismiss", f"{who} {pod.id} {profile} {kind} {target[:60]} n={n}", pod=pod.id)
    return {"ok": True, "removed": n}


def error_body(exc: RestartError) -> dict:
    return {"error": str(exc), "reason": exc.reason, **({"field": exc.field} if exc.field else {}),
            **({"retry_after": exc.retry_after} if exc.retry_after else {}), **exc.extra}
