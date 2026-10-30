# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""운영 평가 — 기준선과 주간 변화를 마크다운으로 낸다. 숫자는 AAS 자체 스냅샷에서만 온다."""
from __future__ import annotations

from datetime import datetime, timedelta
from statistics import median

from ..common import store
from ..hermes.hermes_reader import parse_ts

# i18n-ignore: 호스트·명령줄이 파일로 내는 보고서(요청 밖이라 한국어)
CRITERIA = """## 4주 뒤 판정 기준

| # | 질문 | 무엇을 보나 |
| --- | --- | --- |
| 1 | 지금도 실패 중인 사건이 줄었는가 | 아래 «추이» 의 «지금도 실패». 열린 사건 수는 Hermes 에서 닫아야 줄어든다(AAS 는 닫지 않는다) |
| 2 | 새 사건을 12시간 안에 알았는가 | 다이제스트 발송 기록, 신규 사건 수 |
| 3 | 알림이 안 가는 작업마다 처리 결정을 내렸는가 | 조용한 작업 수의 변화와 사용자 메모 |
| 4 | 실제로 봤는가 | 콘솔을 연 날 수, 다이제스트가 발송된 날 수 (주 3일 이상) |
"""


def _n(v) -> str:
    return "—" if v is None else str(v)


def _row(label: str, t: dict) -> str:
    rate = f"{100 * (t['runs_failed_7d'] or 0) / t['runs_7d']:.0f}%" if t.get("runs_7d") else "—"
    return (f"| {label} | {t['open_incidents']} | {_n(t.get('live_incidents'))} | "
            f"{_n(t.get('settled_incidents'))} | {_n(t.get('muted_incidents'))} | {t['failed_jobs']} | {t['stalled']} | "
            f"{t['silent']} | {t['jobs']} | {rate} | {t['collect_errors'] or 0} |")


HEAD = ("| 시점 | 열린 사건 | 지금도 실패 | 이미 회복 | 무시 | 마지막 실행 실패 작업 | 멈춘 작업 | 알림 안 가는 작업 | 작업 수 | "  # i18n-ignore: 호스트·명령줄이 파일로 내는 보고서(요청 밖이라 한국어)
        "7일 실행 실패율 | 수집 실패 프로파일 |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")

NOTE = ("> «지금도 실패» = 사건이 열려 있고 그 작업의 마지막 실행도 실패. «이미 회복» = 작업은 다시 성공했는데 "  # i18n-ignore: 호스트·명령줄이 파일로 내는 보고서(요청 밖이라 한국어)
        "Hermes 에 사건만 열려 있음. «무시» = AAS 에서 무시로 둔 작업의 사건(앞의 두 칸에서 빠진다). "
        "— 는 그 구분을 남기기 전의 스냅샷.")


def baseline_md(health: dict) -> str:
    ts = store.baseline_ts()
    t = store.totals_at(ts)
    lines = [f"> AAS v0 운영 평가의 기준선. 기준 시각 {ts}. 이 숫자와 견주어 AAS 가 운영에 도움이 되는지 판단한다.",  # i18n-ignore: 호스트·명령줄이 파일로 내는 보고서(요청 밖이라 한국어)
             "> 출처: AAS 가 Hermes 의 `cron/jobs.json`·`cron/executions.db` 를 읽기 전용으로 읽은 값.",  # i18n-ignore: 호스트·명령줄이 파일로 내는 보고서(요청 밖이라 한국어)
             "", "## 기준선", "", HEAD, _row("기준선", t), "", NOTE, "", "## 프로파일별", "",  # i18n-ignore: 호스트·명령줄이 파일로 내는 보고서(요청 밖이라 한국어)
             "| 프로파일 | 작업(활성) | 열린 사건 | 실패 작업 | 멈춤 | 알림 안 감 | 7일 실행(실패) | 사건 기록 |",  # i18n-ignore: 호스트·명령줄이 파일로 내는 보고서(요청 밖이라 한국어)
             "| --- | --- | --- | --- | --- | --- | --- | --- |"]
    label = {"ok": "있음", "no_incident_table": "테이블 없음", "no_db": "DB 없음", "error": "읽기 실패"}  # i18n-ignore: 호스트·명령줄이 파일로 내는 보고서(요청 밖이라 한국어)
    for p in health["profiles"]:
        lines.append(f"| {p['name']} | {p['jobs_total']}({p['jobs_active']}) | {p['open_incidents']} | "
                     f"{p['failed_jobs']} | {p['stalled_jobs']} | {p['silent_jobs']} | "
                     f"{p['runs_7d']}({p['runs_failed_7d']}) | {label.get(p['exec_status'], p['exec_status'])} |")
    lines += ["", "## 기준선에서 드러난 것", ""]  # i18n-ignore: 호스트·명령줄이 파일로 내는 보고서(요청 밖이라 한국어)
    old = sorted(health["incidents"], key=lambda i: -(i["age_days"] or 0))[:5]
    lines.append("가장 오래 열려 있는 사건:")  # i18n-ignore: 호스트·명령줄이 파일로 내는 보고서(요청 밖이라 한국어)
    lines += [f"- {i['profile']}/{i['job']} — {i['age_days']}일째 ({i['state']})" for i in old]  # i18n-ignore: 호스트·명령줄이 파일로 내는 보고서(요청 밖이라 한국어)
    lines.append("")
    lines.append("연속 실패가 가장 긴 작업:")  # i18n-ignore: 호스트·명령줄이 파일로 내는 보고서(요청 밖이라 한국어)
    lines += [f"- {j['profile']}/{j['job']} — 연속 {j['streak']}회" for j in health["failed_jobs"][:5]]  # i18n-ignore: 호스트·명령줄이 파일로 내는 보고서(요청 밖이라 한국어)
    lines.append("")
    lines.append("멈춘 작업:")  # i18n-ignore: 호스트·명령줄이 파일로 내는 보고서(요청 밖이라 한국어)
    lines += [f"- {j['profile']}/{j['job']} — {j['kind']}, {j['since'][:10]} 부터 ({j['hours']:.0f}시간)"  # i18n-ignore: 호스트·명령줄이 파일로 내는 보고서(요청 밖이라 한국어)
              for j in health["stalled"]] or ["- 없음"]  # i18n-ignore: 호스트·명령줄이 파일로 내는 보고서(요청 밖이라 한국어)
    lines.append("")
    lines.append("실패해도 알림이 안 가는 작업:")  # i18n-ignore: 호스트·명령줄이 파일로 내는 보고서(요청 밖이라 한국어)
    lines += [f"- {j['profile']}/{j['job']} — {j['reason']}" for j in health["silent"]]
    lines += ["", CRITERIA]
    return "\n".join(lines)


def _pod_section() -> list[str]:
    """여러 POD 를 수집했을 때만 POD 별 절을 낸다(열린 사건이 많은 POD 부터)."""
    pods = store.latest_by_pod()
    if not pods:
        return []
    return ["", "## POD 별 현황 (가장 최근 수집)", "",  # i18n-ignore: 호스트·명령줄이 파일로 내는 보고서(요청 밖이라 한국어)
            "| POD | 프로파일 | 작업 | 열린 사건 | 마지막 실행 실패 작업 | 수집 실패 |", "| --- | --- | --- | --- | --- | --- |",  # i18n-ignore: 호스트·명령줄이 파일로 내는 보고서(요청 밖이라 한국어)
            *[f"| {p['pod']} | {p['profiles']} | {p['jobs']} | {p['open_incidents']} | {p['failed_jobs']} | {p['errors']} |" for p in pods]]


def weekly_md(now: datetime | None = None) -> str:
    now = now or datetime.now().astimezone()
    base_ts = store.baseline_ts()
    base = store.totals_at(base_ts)
    trend = store.trend(30)                          # 수집 보관 31일 안(스펙 2026-10-24-006 R4)
    week_ago = (now - timedelta(days=7)).isoformat()
    with store.connect() as conn:
        opened = conn.execute("SELECT COUNT(*) n FROM incident_seen WHERE aac_first_saw>=? "
                              "AND aac_first_saw>?", (week_ago, base_ts)).fetchone()["n"]
        closed_rows = conn.execute("SELECT first_seen_at, closed_seen_at FROM incident_seen "
                                   "WHERE closed_seen_at>=?", (week_ago,)).fetchall()
        use = {r["kind"]: r["days"] for r in conn.execute(
            "SELECT kind, COUNT(DISTINCT substr(ts,1,10)) days FROM usage WHERE ts>=? GROUP BY kind",
            (week_ago,))}
        collect_days = conn.execute("SELECT COUNT(DISTINCT substr(ts,1,10)) n FROM snapshots "
                                    "WHERE ts>=?", (week_ago,)).fetchone()["n"]
    hours = []
    for r in closed_rows:
        a, b = parse_ts(r["first_seen_at"]), parse_ts(r["closed_seen_at"])
        if a and b:
            hours.append((b - a).total_seconds() / 3600)
    lines = [f"> AAS v0 주간 평가. 작성 {now:%Y-%m-%d %H:%M}. 기준선 {base_ts[:16]}.", "",  # i18n-ignore: 호스트·명령줄이 파일로 내는 보고서(요청 밖이라 한국어)
             "## 기준선 대비", "", HEAD, _row("기준선", base)]  # i18n-ignore: 호스트·명령줄이 파일로 내는 보고서(요청 밖이라 한국어)
    if trend:
        lines.append(_row(f"현재 ({trend[-1]['day']})", trend[-1]))  # i18n-ignore: 호스트·명령줄이 파일로 내는 보고서(요청 밖이라 한국어)
    lines += ["", NOTE, "", "## 지난 7일", "",  # i18n-ignore: 호스트·명령줄이 파일로 내는 보고서(요청 밖이라 한국어)
              "| 항목 | 값 |", "| --- | --- |",  # i18n-ignore: 호스트·명령줄이 파일로 내는 보고서(요청 밖이라 한국어)
              f"| 새로 열린 사건 | {opened} |",  # i18n-ignore: 호스트·명령줄이 파일로 내는 보고서(요청 밖이라 한국어)
              f"| 닫힌 사건 | {len(closed_rows)} |",  # i18n-ignore: 호스트·명령줄이 파일로 내는 보고서(요청 밖이라 한국어)
              f"| 닫힐 때까지 걸린 시간(중앙값) | {f'{median(hours):.0f}시간' if hours else '—'} |",  # i18n-ignore: 호스트·명령줄이 파일로 내는 보고서(요청 밖이라 한국어)
              f"| 수집이 돈 날 | {collect_days}/7 |",  # i18n-ignore: 호스트·명령줄이 파일로 내는 보고서(요청 밖이라 한국어)
              f"| 콘솔을 연 날 | {use.get('console_view', 0)}/7 |",  # i18n-ignore: 호스트·명령줄이 파일로 내는 보고서(요청 밖이라 한국어)
              f"| 다이제스트가 발송된 날 | {use.get('digest_sent', 0)}/7 |",  # i18n-ignore: 호스트·명령줄이 파일로 내는 보고서(요청 밖이라 한국어)
              f"| 다이제스트가 미발송된 날 | {use.get('digest_unsent', 0) + use.get('digest_failed', 0)}/7 |",  # i18n-ignore: 호스트·명령줄이 파일로 내는 보고서(요청 밖이라 한국어)
              *_pod_section(),
              "", "## 추이 (일별 마지막 수집)", "",  # i18n-ignore: 호스트·명령줄이 파일로 내는 보고서(요청 밖이라 한국어)
              "| 날짜 | 열린 사건 | 지금도 실패 | 이미 회복 | 무시 | 실패 작업 | 멈춤 | 알림 안 감 |",  # i18n-ignore: 호스트·명령줄이 파일로 내는 보고서(요청 밖이라 한국어)
              "| --- | --- | --- | --- | --- | --- | --- | --- |"]
    lines += [f"| {t['day']} | {t['open_incidents']} | {_n(t.get('live_incidents'))} | "
              f"{_n(t.get('settled_incidents'))} | {_n(t.get('muted_incidents'))} | {t['failed_jobs']} | {t['stalled']} | {t['silent']} |"
              for t in trend]
    lines += ["", CRITERIA]
    return "\n".join(lines)
