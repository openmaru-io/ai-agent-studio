# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""다이제스트 — 0건이어도 매번 만든다. 발송은 자격증명이 있을 때만, Hermes 를 거치지 않는다."""
from __future__ import annotations

import json
import os
import urllib.request
from datetime import datetime
from pathlib import Path

from ..common import config, store



def _load_env() -> dict:
    env = config.read_env_file()
    for k in ("AAS_TELEGRAM_BOT_TOKEN", "AAS_TELEGRAM_CHAT_ID"):
        if os.environ.get(k):
            env[k] = os.environ[k]
    return env


def render(health: dict) -> str:
    from . import mutes
    health = mutes.apply(health)                            # 무시한 작업은 숫자와 목록에서 뺀다(끝에 개수만 남긴다)
    for key in ("incidents", "failed_jobs", "stalled", "silent"):
        health[key] = [r for r in health[key] if not r.get("muted")]
    t = health["totals"]
    lines = [f"AAS Cron 건강 · {health['collected_at'][:16].replace('T', ' ')}",  # i18n-ignore: 텔레그램·파일로 나가는 다이제스트와 명령줄 출력(운영자용, 저장 문장)
             f"수집 {t['profiles_ok']}/{t['profiles']} 프로파일 · 작업 {t['jobs']}개(활성 {t['jobs_active']})"]  # i18n-ignore: 텔레그램·파일로 나가는 다이제스트와 명령줄 출력(운영자용, 저장 문장)
    pods = health.get("pods")                                 # 여러 POD 를 합친 수집이면 수집한 POD 수를 적는다(0건이어도 적는다)
    if pods:
        lines.append(f"수집 POD {pods['ok']}/{pods['total']}")  # i18n-ignore: 텔레그램·파일로 나가는 다이제스트와 명령줄 출력(운영자용, 저장 문장)
        for f in pods["failed"]:
            lines.append(f"  ! 수집하지 못한 POD: {f['pod']} — {f['reason']}")  # i18n-ignore: 텔레그램·파일로 나가는 다이제스트와 명령줄 출력(운영자용, 저장 문장)
    bad = [p for p in health["profiles"] if (p["jobs_status"] == "error" or p["exec_status"] == "error") and not p["name"].endswith("/(수집)")]  # i18n-ignore: 텔레그램·파일로 나가는 다이제스트와 명령줄 출력(운영자용, 저장 문장)
    for p in bad:
        lines.append(f"  ! 수집 실패: {p['name']} — {p['detail']}")  # i18n-ignore: 텔레그램·파일로 나가는 다이제스트와 명령줄 출력(운영자용, 저장 문장)
    if t["stale_profiles"]:
        lines.append(f"  ! 실행 이력이 뒤처짐: {', '.join(t['stale_profiles'])}")  # i18n-ignore: 텔레그램·파일로 나가는 다이제스트와 명령줄 출력(운영자용, 저장 문장)
    lines.append("")
    lines.append(f"열린 사건 {len(health['incidents'])}건 (신규 {t['new_incidents']}) — 지금도 실패 중 {t.get('live_incidents', 0)}건, "  # i18n-ignore: 텔레그램·파일로 나가는 다이제스트와 명령줄 출력(운영자용, 저장 문장)
                 f"이미 풀림 {t.get('settled_incidents', 0)}건(확인만 하면 닫힘)")  # i18n-ignore: 텔레그램·파일로 나가는 다이제스트와 명령줄 출력(운영자용, 저장 문장)
    new = [i for i in health["incidents"] if i["new"]]
    for i in new[:8]:
        lines.append(f"  새로 {i['profile']}/{i['job']}: {i['error'][:90]}")  # i18n-ignore: 텔레그램·파일로 나가는 다이제스트와 명령줄 출력(운영자용, 저장 문장)
    old = sorted((i for i in health["incidents"] if not i["new"] and i.get("now", "failing") == "failing"),
                 key=lambda i: -(i["age_days"] or 0))
    for i in old[:5]:
        lines.append(f"  {i['age_days']}일째 {i['profile']}/{i['job']}")  # i18n-ignore: 텔레그램·파일로 나가는 다이제스트와 명령줄 출력(운영자용, 저장 문장)
    if len(old) > 5:
        lines.append(f"  … 지금도 실패 중인 이월 {len(old) - 5}건 더")  # i18n-ignore: 텔레그램·파일로 나가는 다이제스트와 명령줄 출력(운영자용, 저장 문장)
    by_prof = {}
    for i in health["incidents"]:
        if i.get("now", "failing") == "failing":
            by_prof[i["profile"]] = by_prof.get(i["profile"], 0) + 1
    if by_prof:
        lines.append("  지금도 실패 중, 프로파일별: " + ", ".join(f"{k} {v}" for k, v in  # i18n-ignore: 텔레그램·파일로 나가는 다이제스트와 명령줄 출력(운영자용, 저장 문장)
                                               sorted(by_prof.items(), key=lambda kv: -kv[1])))
    lines.append("")
    lines.append(f"마지막 실행이 실패인 작업 {t['failed_jobs']}개")  # i18n-ignore: 텔레그램·파일로 나가는 다이제스트와 명령줄 출력(운영자용, 저장 문장)
    for j in health["failed_jobs"][:5]:
        lines.append(f"  {j['profile']}/{j['job']} (연속 {j['streak']}회)")  # i18n-ignore: 텔레그램·파일로 나가는 다이제스트와 명령줄 출력(운영자용, 저장 문장)
    lines.append(f"멈춘 작업 {t['stalled']}개")  # i18n-ignore: 텔레그램·파일로 나가는 다이제스트와 명령줄 출력(운영자용, 저장 문장)
    for j in health["stalled"][:5]:
        lines.append(f"  {j['profile']}/{j['job']} — {j['kind']}, {j['hours']:.0f}시간")  # i18n-ignore: 텔레그램·파일로 나가는 다이제스트와 명령줄 출력(운영자용, 저장 문장)
    lines.append(f"실패해도 알림이 안 가는 작업 {t['silent']}개")  # i18n-ignore: 텔레그램·파일로 나가는 다이제스트와 명령줄 출력(운영자용, 저장 문장)
    if health.get("muted"):
        lines.append(f"무시한 작업 {len(health['muted'])}개: " + ", ".join(f"{m['profile']}/{m['job']}" for m in health["muted"][:6]))  # i18n-ignore: 텔레그램·파일로 나가는 다이제스트와 명령줄 출력(운영자용, 저장 문장)
    lines.append("")
    console = config.get("AAS_CONSOLE_URL")
    if console:
        lines.append(f"콘솔: {console}")  # i18n-ignore: 텔레그램·파일로 나가는 다이제스트와 명령줄 출력(운영자용, 저장 문장)
    return "\n".join(lines)


def run(health: dict, send: bool = True) -> dict:
    text = render(health)
    out_dir = store.data_dir() / "digests"
    out_dir.mkdir(exist_ok=True)
    path = out_dir / f"{datetime.now():%Y%m%d-%H%M}.md"
    path.write_text(text + "\n", encoding="utf-8")
    env = _load_env()
    token, chat = env.get("AAS_TELEGRAM_BOT_TOKEN"), env.get("AAS_TELEGRAM_CHAT_ID")
    if not send or not (token and chat):
        store.log_usage("digest_unsent", "자격증명 없음" if send else "발송 끔")  # i18n-ignore: 텔레그램·파일로 나가는 다이제스트와 명령줄 출력(운영자용, 저장 문장)
        return {"file": str(path), "sent": False,
                "reason": "발송 끔" if not send else f"{config.env_file()} 에 자격증명이 없습니다"}  # i18n-ignore: 텔레그램·파일로 나가는 다이제스트와 명령줄 출력(운영자용, 저장 문장)
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=json.dumps({"chat_id": chat, "text": text[:4000],
                         "disable_web_page_preview": True}).encode(),
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            ok = json.loads(resp.read()).get("ok", False)
    except Exception as exc:  # 토큰이 URL 에 있으므로 예외 문자열을 그대로 내지 않는다
        store.log_usage("digest_failed", type(exc).__name__)
        return {"file": str(path), "sent": False, "reason": f"발송 실패: {type(exc).__name__}"}  # i18n-ignore: 텔레그램·파일로 나가는 다이제스트와 명령줄 출력(운영자용, 저장 문장)
    store.log_usage("digest_sent" if ok else "digest_failed")
    return {"file": str(path), "sent": bool(ok), "reason": "" if ok else "API 가 ok 를 주지 않음"}  # i18n-ignore: 텔레그램·파일로 나가는 다이제스트와 명령줄 출력(운영자용, 저장 문장)
