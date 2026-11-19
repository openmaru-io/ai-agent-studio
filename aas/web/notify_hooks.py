# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""알림을 메신저로도 보내는 자리(스펙 2026-11-17-008 §6-2). 보내기 자체는 aas/ops/notify_out.

  승인·되묻기   채팅 이벤트로 받은편지함 항목이 생기는 순간(inbox.Pending.on_new, 대화를 연 복제본). 받는 사람 = 항목의 to.
  실패 예약 작업 리더가 1분마다 훑는다(이벤트가 없다). 연결한 메신저나 팀 공지가 있는 작업공간만, 한 번 도는 시간 SCAN_BUDGET 초.
                성공→실패로 바뀐 첫 실패(streak 1)는 바로, 계속 실패하면 하루 한 번. 받는 사람 = 만든 사람(cron_creators) + 주인.
  칸반 검토·막힘 리더 훑기. 받는 사람 = 카드 소유자.
  팀 공지       주인이 공유 구역에서 고른 (프로파일, 메신저)의 홈 채널로 실패한 예약 작업만(첫 판).
보내기는 HTTP 요청이라 채팅 스레드·요청 스레드를 막지 않게 작은 스레드 풀에서 한다.
"""
from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

from ..hermes.hermes_api import HermesAPI
from ..ops import messenger_links, notify_out

SCAN_BUDGET = 30.0
_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="notify")


def _server():
    from . import server
    return server


def _home_of(pod) -> tuple[str, callable]:
    """(루트 HERMES_HOME 경로, 프로파일 이름 → 루트인가). 프로파일 목록의 path 로 정한다."""
    rows = _server()._profile_rows(pod)
    root = next((r for r in rows if r.get("is_default")), None)
    roots = {r["name"] for r in rows if r.get("is_default")}
    return str((root or {}).get("path") or "/opt/data"), (lambda name: name in roots)


def _alias(pod) -> str:
    s = _server()
    try:
        return s.office.agent_names_provider().get(pod.id) or pod.id
    except Exception:
        return pod.id


def send_to(pod, emails, kind: str, key: str, link_path: str) -> dict:
    """사람들에게 같은 알림. {email: 결과}."""
    if not notify_out.enabled():
        return {}
    root, is_root = _home_of(pod)
    api = HermesAPI(_server().hub(pod).auth)
    alias, link = _alias(pod), notify_out.aas_link(link_path)
    out = {}
    for email in dict.fromkeys(e.lower() for e in emails if e and "@" in e):
        out[email] = notify_out.deliver(pod, email, kind, alias, link, key, api=api, root_home=root, is_root_profile=is_root,
                                        links=messenger_links.links(pod.id, email))
    return out


def on_inbox_new(item_id: str, item: dict) -> None:
    """받은편지함에 승인·되묻기가 새로 생겼다(대화를 연 복제본). 뒤에서 보낸다."""
    if item.get("kind") not in ("approval", "clarify") or not notify_out.enabled():
        return

    def run():
        try:
            pod = next((p for p in _server().registry().pods if p.id == item.get("pod")), None)
            if pod is not None:
                send_to(pod, item.get("to") or [], item["kind"], item_id, "#/chat")
        except Exception as exc:
            print(f"메신저 알림(승인·되묻기)을 보내지 못했습니다: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
    _pool.submit(run)


def _cron_key(pod_id: str, f: dict, now: float) -> tuple[str, str]:
    """(알림 키, 종류). 첫 실패면 실행 시각으로 한 번, 계속 실패면 하루 한 번."""
    base = f"cron|{pod_id}|{f['profile']}|{f['job_id']}"
    if int(f.get("streak") or 0) <= 1:
        return f"{base}|{f.get('last_run_at') or ''}", "cron_failed"
    return f"{base}|day|{datetime.fromtimestamp(now).strftime('%Y-%m-%d')}", "cron_still_failing"


def scan(reg, now: float | None = None) -> int:
    """리더: 실패 예약 작업·칸반 검토/막힘을 연결된 사람(과 팀 공지)에게. 보낸(또는 시도한) 알림 수."""
    if not notify_out.enabled():
        return 0
    from ..fleet import sharing
    s = _server()
    now = time.time() if now is None else now
    start, n = time.monotonic(), 0
    linked_pods = {r["pod"] for r in _all_links()}
    for pod in reg.pods:
        if time.monotonic() - start > SCAN_BUDGET:
            break                                         # 다음 차례에 이어서
        team = sharing.team_notice(pod.id)
        if pod.id not in linked_pods and not team:
            continue
        try:
            failed = [f for f in s._health(pod).get("failed_jobs", []) if not f.get("muted")]
        except Exception:
            continue
        for f in failed:
            key, kind = _cron_key(pod.id, f, now)
            who = [x for x in (notify_out.cron_creator(pod.id, f["profile"], f["job_id"]), pod.owner) if x]
            send_to(pod, who, kind, key, "#/flows")
            if team:
                root, is_root = _home_of(pod)
                notify_out.deliver_team(pod, team["profile"], team["platform"], kind, _alias(pod), notify_out.aas_link("#/flows"), key,
                                        api=HermesAPI(s.hub(pod).auth), root_home=root, is_root=is_root(team["profile"]))
            n += 1
    try:                                                  # 칸반: 카드 소유자에게. 카드는 작업공간에 매이지 않아(오피스 전체) 그 사람이 메신저를 이은 작업공간의 봇으로 보낸다
        owners = s._card_owners()
        by_id = {p.id: p for p in reg.pods}
        for r in s._inbox_cards():
            if r["status"] not in ("review", "blocked"):
                continue
            email = owners.get((r["board"], r["task_id"]), "")
            mine = [x for x in messenger_links.links_of(email) if x["pod"] in by_id] if email else []
            if not mine:
                continue
            send_to(by_id[mine[0]["pod"]], [email], r["status"], f"card|{r['board']}|{r['task_id']}|{r['status']}", "#/office")
            n += 1
    except Exception as exc:
        print(f"메신저 알림(칸반)을 훑지 못했습니다: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
    return n


def _all_links() -> list[dict]:
    with messenger_links._conn() as conn:
        return [dict(r) for r in conn.execute("SELECT DISTINCT pod FROM messenger_links").fetchall()]


def scan_in_background(reg) -> None:
    def run():
        try:
            scan(reg)
        except Exception as exc:
            print(f"메신저 알림을 훑지 못했습니다: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
    _pool.submit(run)
