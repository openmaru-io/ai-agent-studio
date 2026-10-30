# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""aas collect | serve | digest | evaluate | doctor"""
from __future__ import annotations

import argparse
import os
import sys
import time

from .ops import collect_all, cron_health, dashboard, digest, evaluate
from .common import config, leader, owner, store
from .web import server


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="aas", description="CogentAI AAS (Hermes 관리 콘솔)")  # i18n-ignore: 명령줄 출력
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("collect", help="수집해서 스냅샷을 남긴다")  # i18n-ignore: 명령줄 출력
    sp = sub.add_parser("serve", help="웹 콘솔을 띄운다")  # i18n-ignore: 명령줄 출력
    sp.add_argument("--host", default="127.0.0.1")
    sp.add_argument("--port", type=int, default=17900)
    sp.add_argument("--ticker", action="store_true", help="30분마다 수집·다이제스트를 이 프로세스에서 돌린다")  # i18n-ignore: 명령줄 출력
    dp = sub.add_parser("digest", help="다이제스트를 만들고(자격증명이 있으면) 보낸다")  # i18n-ignore: 명령줄 출력
    dp.add_argument("--no-send", action="store_true")
    ep = sub.add_parser("evaluate", help="평가 마크다운을 표준 출력으로 낸다")  # i18n-ignore: 명령줄 출력
    ep.add_argument("kind", choices=["baseline", "weekly"])
    sub.add_parser("doctor", help="프로파일별 수집 상태를 보여 준다")  # i18n-ignore: 명령줄 출력
    pp = sub.add_parser("pod", help="POD 목록(쿠버네티스에서는 HermesAgent 가 POD 다. 만들기는 화면이나 kubectl 로)")  # i18n-ignore: 명령줄 출력
    pp.add_argument("action", choices=["list"])
    up = sub.add_parser("user", help="AAS 자체 계정(IP 접속용 로그인)")  # i18n-ignore: 명령줄 출력
    up.add_argument("action", choices=["list", "set-password", "remove"])
    up.add_argument("email", nargs="?")
    mp = sub.add_parser("db-migrate", help="SQLite(aas.db)를 PostgreSQL 로 옮기고 모든 행을 비교한다(서버를 멈춘 뒤)")  # i18n-ignore: 명령줄 출력
    mp.add_argument("--data-dir", default=None)
    sub.add_parser("tick", help="launchd 용: 수집하고, 시각에 맞으면 다이제스트·주간 평가까지")  # i18n-ignore: 명령줄 출력
    args = ap.parse_args(argv)

    if args.cmd == "user":
        return _user(args)
    if args.cmd == "db-migrate":
        os.environ["AAS_DB_STATEMENT_TIMEOUT"] = "0"     # 서버를 멈추고 한 번 도는 이전 도구 — 큰 테이블 복사가 30초를 넘을 수 있다(스펙 2026-10-24-002 R6)
        from .common import dbmigrate
        return dbmigrate.main(args.data_dir)
    if args.cmd == "pod":
        return _pod(args)
    if args.cmd == "serve":
        if args.ticker:
            _start_ticker()
        from .auth import auth
        auth.bootstrap_admin()                      # 로그인 검사(계정이 있어야 127.0.0.1 밖으로 연다) 전에 첫 관리자(스펙 2026-10-21-015 R9)
        server.serve(args.host, args.port)
        return 0
    health = cron_health.collect()
    if args.cmd == "doctor":
        t = health["totals"]
        print(f"프로파일 {t['profiles']}곳, 수집 성공 {t['profiles_ok']}곳, 작업 {t['jobs']}개")  # i18n-ignore: 명령줄 출력
        for p in health["profiles"]:
            print(f"  {p['name']:<10} jobs={p['jobs_status']:<13} exec={p['exec_status']:<18} "  # i18n-ignore: 명령줄 출력
                  f"작업 {p['jobs_total']:>3}  사건 {p['open_incidents']:>3}  "  # i18n-ignore: 명령줄 출력
                  f"{'STALE ' if p['stale'] else ''}{p['detail']}")
        return 0 if t["profiles_ok"] == t["profiles"] else 1
    store.record_snapshot(health)
    if args.cmd == "collect":
        print(health["totals"])
    elif args.cmd == "tick":
        _tick(health)
        _office_check()
    elif args.cmd == "digest":
        print(digest.run(health, send=not args.no_send))
    elif args.cmd == "evaluate":
        print(evaluate.baseline_md(health) if args.kind == "baseline" else evaluate.weekly_md())
    return 0


def _user(args) -> int:
    import getpass
    from .auth import auth
    if args.action == "list":
        for email in sorted(auth.load_users()):
            print(email)
        print(f"({auth.USERS_FILE})")
        return 0
    if not args.email or "@" not in args.email:
        print("사용: aas user set-password|remove <이메일>")  # i18n-ignore: 명령줄 출력
        return 2
    if args.action == "remove":
        auth.save_user(args.email, None)
        print("지웠습니다:", args.email.lower())  # i18n-ignore: 명령줄 출력
        return 0
    pw = getpass.getpass("새 비밀번호: ")  # i18n-ignore: 명령줄 출력
    if len(pw) < 10:
        print("10자 이상으로 정하세요.")  # i18n-ignore: 명령줄 출력
        return 1
    if pw != getpass.getpass("한 번 더: "):  # i18n-ignore: 명령줄 출력
        print("두 입력이 다릅니다.")  # i18n-ignore: 명령줄 출력
        return 1
    auth.save_user(args.email, pw)
    print(f"저장했습니다(해시만): {args.email.lower()} → {auth.USERS_FILE}")  # i18n-ignore: 명령줄 출력
    return 0


def _pod(args) -> int:
    from .fleet import pods
    reg = pods.Registry()
    for p in reg.pods:
        print(f"{p.id:<12} {p.owner:<28} {p.container:<22} {p.dashboard_url}  {p.hermes_home}")
    print("관리자:", ", ".join(sorted(reg.admins)) or "(없음)", reg.error)  # i18n-ignore: 명령줄 출력
    return 0


def _office_check() -> list[str]:
    """오피스 자리가 있으면 설치본의 Hermes 대시보드가 살아 있는지, 핀과 버전이 어긋났는지 본다. 문제 문장 목록을 돌려준다."""
    from .office import office
    if not office.seats():
        return []
    found = [p["text"] for p in office.run_checks(server.registry().pods)["problems"]]
    if found:
        print("오피스 점검:", " / ".join(found), flush=True)  # i18n-ignore: 명령줄 출력
    return found


MERGE_WAIT = 90.0               # 수집 창이 열린 뒤 리더가 다른 서버의 줄을 기다리는 시간(초). 다 모이면 바로 합친다


def _health_slot(now) -> str:
    return f"{now:%Y-%m-%d}T{now.hour:02d}:{(now.minute // 30) * 30:02d}"


def _collect_mine_health(slot: str, pods: list) -> None:
    """이 서버가 맡은 에이전트만 읽어 에이전트별 줄로 적는다(스펙 2026-10-24-013 3단계 D5). 모든 서버가 수집 창마다 한 번."""
    from .office import shared
    mine = owner.mine(list(pods), server.SHARED.origin, server._alive_origins())
    for pid, body in collect_all.collect_rows(mine).items():
        shared.put_health(slot, pid, body)


def _merge_health(slot: str, pods: list) -> dict:
    """담당 서버들이 적은 줄을 합친다. 줄이 없는 에이전트(담당이 죽었거나 아직 못 적음)는 리더가 직접 읽는다."""
    from .office import shared
    rows = shared.get_health(slot)
    missing = [p for p in pods if p.id not in rows]
    if missing:
        rows.update(collect_all.collect_rows(missing))
    return collect_all.merge([rows[p.id] for p in pods if p.id in rows], len(pods))


def _collect_health(slot: str | None = None):
    """설치본이 하나면 그 설치본을 수집하고(예전 모양 그대로), 여럿이면 담당 서버들이 적은 줄을 합친다(빠진 것은 직접 읽는다).
    한 POD 가 느리거나 죽어도 그 POD 만 수집 실패로 남는다(collect_all, 계획 R12·R13)."""
    from datetime import datetime
    pods = server.registry().pods
    if not pods and config.get("AAS_K8S_NAMESPACE"):
        return collect_all.merge([], 0)      # 쿠버네티스는 사용자가 첫 로그인할 때 Hermes 가 생긴다. 그 전에는 읽을 곳이 없다
    if len(pods) > 1:
        started = time.monotonic()
        merged = _merge_health(slot or _health_slot(datetime.now()), pods)
        collect_all.save_round(merged["pods"], time.monotonic() - started)
        return merged
    return cron_health.collect(home=pods[0].hermes_home) if pods else cron_health.collect()


def _start_ticker() -> None:
    """매시 0분·30분에 수집(_tick)을 돌린다. 컨테이너에서는 launchd 가 없으므로 서버가 직접 한다."""
    import threading
    from datetime import datetime

    def loop():
        last = None                           # 리더가 합친 창
        written = None                        # 내 몫을 적은 창
        while True:
            now = datetime.now()
            slot = (now.hour, now.minute // 30)
            in_window = now.minute % 30 < 5
            key = _health_slot(now)
            # 모든 서버가 자기가 맡은 에이전트를 읽어 줄로 적는다(스펙 2026-10-24-013 D5). 에이전트가 하나면 리더가 예전대로 읽는다
            if in_window and slot != written:
                written = slot
                try:
                    pods = server.registry().pods
                    if len(pods) > 1:
                        _collect_mine_health(key, pods)
                except Exception as exc:
                    print(f"내 몫 수집 실패: {type(exc).__name__}: {exc}", flush=True)  # i18n-ignore: 명령줄 출력
            # 합치기·보고서·설치본 점검은 리더만(OMAI-1105). 다른 서버의 줄이 다 모이거나 창이 열린 지 90초가 지나면 합친다
            if slot != last and in_window and leader.is_leader() and _ready_to_merge(key, now):
                last = slot
                try:
                    health = _collect_health(key)
                    store.record_snapshot(health)
                    _prune_old()                      # 31일 지난 사용 기록·수집 줄(스펙 2026-10-24-006 R3). 실패해도 수집은 이어 간다
                    _dashboard_round(health)
                    _tick(health)
                    _office_check()                   # 설치본 점검은 수집과 따로 — 수집이 실패해도 돈다
                except Exception as exc:          # 한 번의 실패가 주기를 멈추지 않게 한다
                    print(f"tick 실패: {type(exc).__name__}: {exc}", flush=True)  # i18n-ignore: 명령줄 출력
            time.sleep(30)

    threading.Thread(target=loop, daemon=True, name="aas-ticker").start()


def _ready_to_merge(slot: str, now) -> bool:
    if (now.minute % 30) * 60 + now.second >= MERGE_WAIT:
        return True
    try:
        from .office import shared
        pods = server.registry().pods
        return len(pods) <= 1 or {p.id for p in pods} <= set(shared.get_health(slot))
    except Exception:
        return True


def _prune_old() -> None:
    try:
        gone = store.prune_old()
        if any(gone.values()):
            print("오래된 기록 정리: " + ", ".join(f"{t} {n}줄" for t, n in gone.items()), flush=True)  # i18n-ignore: 서버 로그
    except Exception as exc:
        print(f"오래된 기록 정리 실패: {type(exc).__name__}: {exc}", flush=True)  # i18n-ignore: 서버 로그


def _dashboard_round(health) -> None:
    """대시보드 값(계획 2026-10-14-014 R1·R10): POD 요약은 바퀴마다, 일별 사용량은 하루 한 번(00:30). 실패해도 수집 주기는 그대로 돈다."""
    from datetime import datetime
    pods = server.registry().pods
    try:
        dashboard.record_round(pods, health)
        now = datetime.now().astimezone()
        if dashboard.usage_due(now):
            dashboard.record_usage(pods, now)
    except Exception as exc:
        print(f"대시보드 수집 실패: {type(exc).__name__}: {exc}", flush=True)  # i18n-ignore: 명령줄 출력


def _tick(health) -> None:
    """30분마다 불린다. 08:30·18:30 다이제스트, 월요일 09:00 주간 평가를 data 폴더에 남긴다."""
    from datetime import datetime
    now = datetime.now()
    slot = now.strftime("%H") + ("00" if now.minute < 30 else "30")
    if slot in ("0830", "1830"):
        print(digest.run(health))
    if slot == "0900" and now.isoweekday() == 1:
        out = store.data_dir() / f"weekly-{now:%Y%m%d}.md"
        out.write_text(evaluate.weekly_md(), encoding="utf-8")
        print(f"주간 평가를 {out} 에 남겼습니다")  # i18n-ignore: 명령줄 출력
    print(f"tick {now:%Y-%m-%d %H:%M} 열린 사건 {health['totals']['open_incidents']}")  # i18n-ignore: 명령줄 출력


if __name__ == "__main__":
    sys.exit(main())
