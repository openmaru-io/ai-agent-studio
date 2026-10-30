# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""변경 기록 — AAS 에서 누가 언제 무엇을 바꿨는지. usage 표에 쌓인 것을 사람이 읽을 말로 푼다.
값(비밀값·글 내용)은 처음부터 기록하지 않는다. 여기에는 이름과 대상만 있다."""
from __future__ import annotations

import re
from datetime import datetime, timedelta

from ..common import store

# 대상 글에 설치본 id 를 적은 기록(server.py 의 log_usage). 읽을 때 id 를 뺀다(스펙 2026-10-19-003)
POD_IN_NOTE = {"market_install", "market_remove", "market_restore", "market_publish_request", "market_grant", "profile_soul_identity"}
# 대상 글에 네임스페이스 slug(free·paid)를 적은 마켓 기록. 저장은 slug 그대로, 읽을 때 요청 언어의 표시 이름(공용·제한 / shared·restricted)으로 바꾼다
# — 이미 쌓인 기록도 같게 보인다(스펙 2026-10-28-010 D10)
NS_IN_NOTE = {"market_install", "market_remove", "market_grant", "market_publish_request", "market_publish_decide", "market_auto_settings"}

# kind → (묶음, 한 일)
LABELS = {
    "cron_create": ("크론", "작업을 만듦"), "cron_delete": ("크론", "작업을 삭제"), "cron_schedule": ("크론", "주기를 바꿈"),  # i18n-ignore: kind 코드를 UI 가 번역한다(changeLabels.ts)
    "cron_deliver": ("크론", "전달 대상을 바꿈"), "cron_pause": ("크론", "작업을 끔"), "cron_resume": ("크론", "작업을 켬"),  # i18n-ignore: kind 코드를 UI 가 번역한다(changeLabels.ts)
    "cron_trigger": ("크론", "지금 실행을 요청"), "cron_prompt": ("크론", "지시문을 고침"), "cron_skill": ("크론", "돌릴 스킬을 바꿈"),  # i18n-ignore: kind 코드를 UI 가 번역한다(changeLabels.ts)
    "cron_mute": ("크론", "작업을 무시로 등록"), "cron_unmute": ("크론", "무시를 풂"),  # i18n-ignore: kind 코드를 UI 가 번역한다(changeLabels.ts)
    "profile_create": ("프로파일", "프로파일을 만듦"), "profile_delete": ("프로파일", "프로파일을 삭제"), "profile_rename": ("프로파일", "이름을 바꿈"),  # i18n-ignore: kind 코드를 UI 가 번역한다(changeLabels.ts)
    "profile_export": ("프로파일", "내보냄"), "profile_describe": ("프로파일", "소개를 고침"), "profile_soul": ("프로파일", "SOUL 을 고침"),  # i18n-ignore: kind 코드를 UI 가 번역한다(changeLabels.ts)
    "profile_soul_revert": ("프로파일", "SOUL 을 이전 버전으로 되돌림"), "profile_config": ("프로파일", "설정을 고침"),  # i18n-ignore: kind 코드를 UI 가 번역한다(changeLabels.ts)
    "profile_config_revert": ("프로파일", "설정을 이전 버전으로 되돌림"), "profile_model": ("프로파일", "주 모델을 바꿈"),  # i18n-ignore: kind 코드를 UI 가 번역한다(changeLabels.ts)
    "profile_gateway": ("프로파일", "게이트웨이를 조작"), "profile_skill": ("프로파일", "스킬을 켜거나 끔"),  # i18n-ignore: kind 코드를 UI 가 번역한다(changeLabels.ts)
    "profile_toolset": ("프로파일", "도구묶음을 켜거나 끔"), "profile_mcp": ("프로파일", "MCP 서버를 켜거나 끔"),  # i18n-ignore: kind 코드를 UI 가 번역한다(changeLabels.ts)
    "profile_env_set": ("비밀값", "비밀값을 넣거나 바꿈"), "profile_env_clear": ("비밀값", "비밀값을 지움"),  # i18n-ignore: kind 코드를 UI 가 번역한다(changeLabels.ts)
    "profile_credential_put": ("비밀값", "인증 파일을 넣거나 바꿈"), "profile_credential_clear": ("비밀값", "인증 파일을 지움"),  # i18n-ignore: kind 코드를 UI 가 번역한다(changeLabels.ts). 스펙 2026-10-22-004 R12
    "skill_save": ("스킬", "스킬 문서를 고침"), "skill_revert": ("스킬", "스킬 문서를 이전 버전으로 되돌림"), "skill_create": ("스킬", "스킬을 만듦"), "skill_delete": ("스킬", "스킬을 지움"), "skill_upload": ("스킬", "스킬 zip 을 올림"), "skill_download": ("스킬", "스킬을 zip 으로 내려받음"), "skill_agent_edit": ("스킬", "Hermes 가 스킬 문서를 고침"),  # i18n-ignore: kind 코드를 UI 가 번역한다(changeLabels.ts)
    "office_change": ("오피스", "자리·방·핀·열쇠를 바꿈"),  # i18n-ignore: kind 코드를 UI 가 번역한다(changeLabels.ts)
    "market_install": ("스킬 허브", "패키지 설치를 요청"), "market_remove": ("스킬 허브", "스킬 패키지 지우기를 요청"), "market_grant": ("스킬 허브", "허용이 필요한 네임스페이스의 사용 허용을 바꿈"), "market_restore": ("스킬 허브", "보관한 스킬 되살리기를 요청"),  # i18n-ignore: kind 코드를 UI 가 번역한다(changeLabels.ts)
    "profile_soul_notice": ("프로파일", "열린 방에 SOUL 변경을 알림"),  # i18n-ignore: kind 코드를 UI 가 번역한다(changeLabels.ts). 실패만 남긴다(재검토 L7)
    "profile_soul_identity": ("프로파일", "SOUL 첫 문장을 회사 이름으로 맞춤"), "settings_company": ("설정", "회사 이름을 바꿈"),  # i18n-ignore: kind 코드를 UI 가 번역한다(changeLabels.ts)
    "user_grant": ("접속", "권한을 줌·바꿈·뺌"), "login": ("접속", "로그인"), "login_failed": ("접속", "로그인 실패"), "session_revoke": ("접속", "세션을 끊음"),  # i18n-ignore: kind 코드를 UI 가 번역한다(changeLabels.ts)
    "user_create": ("접속", "사용자를 만듦"), "user_update": ("접속", "사용자 정보·권한을 바꿈"), "user_password": ("접속", "비밀번호를 재설정"),  # i18n-ignore: kind 코드를 UI 가 번역한다(changeLabels.ts)
    "user_enable": ("접속", "사용자를 사용 중지·다시 사용"), "user_delete": ("접속", "사용자를 삭제"), "user_access": ("접속", "AAS 접근을 줌"),  # i18n-ignore: kind 코드를 UI 가 번역한다(changeLabels.ts)
    "chat_send": ("일 시키기", "채팅으로 일을 시킴"), "office_command": ("일 시키기", "오피스에서 일을 시킴"),  # i18n-ignore: kind 코드를 UI 가 번역한다(changeLabels.ts)
    "pc_import_start": ("일 시키기", "PC 에서 main 을 가져옴"), "pc_export": ("일 시키기", "main 을 내보냄"),  # i18n-ignore: kind 코드를 UI 가 번역한다(changeLabels.ts)
    "department_managers": ("접속", "팀 관리자를 바꿈"),  # i18n-ignore: kind 코드를 UI 가 번역한다(changeLabels.ts)
    "user_logout": ("접속", "로그인을 끊음"),  # i18n-ignore: kind 코드를 UI 가 번역한다(changeLabels.ts)
    "notice_save": ("설정", "공지를 올리거나 고침"), "notice_remove": ("설정", "공지를 내림"),  # i18n-ignore: kind 코드를 UI 가 번역한다(changeLabels.ts). 스펙 2026-10-24-007
}


# 에이전트 주인이 자기 POD 기록에서 보는 묶음. 접속·설정·오피스는 POD 에 매이지 않아 빠진다(디자인 결정 1A)
OWNER_GROUPS = ("크론", "프로파일", "비밀값", "스킬", "스킬 허브", "일 시키기")  # i18n-ignore: LABELS 의 묶음 이름과 맞춘다
# 기록 끝 " role=<자격>" → 줄의 표시. admin 은 주인 화면에서 이름을 가리고, team·other 는 이름을 보인다(스펙 2026-10-22-001 D15)
ROLES = {"admin": "by_admin", "team": "by_team_manager", "other": "by_other"}
WORK_GROUP = "일 시키기"  # i18n-ignore: LABELS 의 묶음 이름과 맞춘다. 보낼 때마다 쌓여 SQL 에서 날짜별로 묶어 읽는다(R7, 디자인 DD7)


def _ns_labels(detail: str) -> str:
    """마켓 기록 글의 slug(free·paid)를 표시 이름으로. 낱말 하나(「paid → 허용」)이거나 패키지 ID 의 앞(「free/x@1」)일 때만 바꾼다
    — 「freebie」·「free-tier」 같은 다른 낱말, 「community/free」 같은 패키지 이름, 「lab-a/free」 같은 프로파일 이름은 그대로 둔다.
    설치본 id 를 빼기 전에 부른다(빼고 나면 프로파일 이름이 앞에 남는다)."""
    from ..market import marketplace
    cfg = marketplace.settings()
    names = {s: marketplace.ns_label(s, cfg) for s in marketplace.NS_LABELS}
    names = {s: label for s, label in names.items() if label != s}
    if not names:
        return detail
    return re.sub(rf"(?<![\w./@-])({'|'.join(map(re.escape, names))})(?![\w.@-])", lambda m: names[m.group(1)], detail)


def _kinds(groups, only_work: bool) -> list[str]:
    base = [k for k, (group, _) in LABELS.items() if group in groups and (group == WORK_GROUP) == only_work]
    return base + [k + "_failed" for k in base]


def owner_kinds() -> list[str]:
    return _kinds(OWNER_GROUPS, False) + _kinds(OWNER_GROUPS, True)


def rows(days: int = 30, limit: int = 500, pod: str | None = None, since: str = "") -> list[dict]:
    """pod 를 주면 그 POD 의 주인용 기록만 SQL 에서 거른다(파이썬에서 거르면 다른 POD 기록 4000줄에 밀려 빈 화면이 된다, 재검토 H2).
    since 는 그보다 앞선 기록을 뺀다(주인이 된 시각, 재검토 L6)."""
    start = max((datetime.now().astimezone() - timedelta(days=days)).isoformat(timespec="seconds"), since or "")
    with store.connect() as conn:
        if pod is None:
            raw = conn.execute("SELECT ts, kind, note, pod FROM usage WHERE ts >= ? ORDER BY ts DESC LIMIT 4000", (start,)).fetchall()
        else:
            kinds, work = _kinds(OWNER_GROUPS, False), _kinds(OWNER_GROUPS, True)
            raw = conn.execute(f"SELECT ts, kind, note, pod FROM usage WHERE pod = ? AND ts >= ? AND kind IN ({','.join('?' * len(kinds))}) "
                               "ORDER BY ts DESC LIMIT 4000", (pod, start, *kinds)).fetchall()
            # 「일 시키기」는 보낼 때마다 쌓여 설정 기록을 밀어내므로 따로, 보낸 사람·대상·날짜별 건수로 읽는다(note 는 「<이메일> <프로파일 또는 자리>」로 고정)
            grouped = conn.execute(f"SELECT kind, note, pod, COUNT(*) AS n, MAX(ts) AS ts FROM usage WHERE pod = ? AND ts >= ? AND kind IN ({','.join('?' * len(work))}) "
                                   "GROUP BY kind, pod, note, substr(ts, 1, 10)", (pod, start, *work)).fetchall()
            raw = sorted([*raw, *({"ts": g["ts"], "kind": g["kind"], "note": g["note"], "pod": g["pod"], "count": g["n"]} for g in grouped)],
                         key=lambda r: r["ts"], reverse=True)
    out = []
    for r in map(dict, raw):
        kind, failed = r["kind"], r["kind"].endswith("_failed")
        base = kind[:-7] if failed and kind != "login_failed" else kind
        if base not in LABELS:
            continue
        group, what = LABELS[base]
        note = str(r["note"] or "")
        who, _, rest = note.partition(" ")
        # 사람이 아닌 주체는 actor 로 가른다(2026-10-17-012). 화면이 「AAS 자동」·「에이전트」·「기록 없음」으로 보인다
        actor = ""
        if who == "aas":                                      # AAS 서버가 스스로 바꾼 것(server.py 의 log_usage(…, "aas …"))
            who, actor = "", "aas"
        elif "@" not in who and who != "local":               # 옛 기록: 누가 했는지 없이 대상만 적힌 것
            who, rest = "", note
        if base == "skill_agent_edit" and not who:            # Hermes 가 스킬 문서를 직접 고친 것을 서버가 알아챈 기록
            actor = "agent"
        if base == "login_failed" and not who:                # 로그인 실패는 아이디가 아니라 IP 만 남긴다(auth.py) — 옛 기록이 아니다
            actor = "guest"
        via = ""                                              # 토큰으로 한 일(store.log_usage 가 role 뒤에 붙인다, 스펙 2026-10-28-001 §3-7 ⑦) — role 보다 먼저 뗀다
        if rest.endswith(" via=token") or rest == "via=token":
            rest, via = rest[:-len("via=token")].rstrip(), "token"
        role = next((x for x in ROLES if rest.endswith(f" role={x}")), "")   # 작성자의 자격(store.log_usage). 권한이 바뀐 뒤에도 같게 보인다(D11·D15)
        if role:
            rest = rest[:-len(f" role={role}")]
        rest, _, req = rest.partition(" req=")                 # 마켓 요청 id(재검토 M5) — 화면에는 요청 상태로 보인다
        row = {"ts": r["ts"], "kind": base, "group": group, "what": what, "who": who, "detail": rest.strip(), "failed": failed and base != "login_failed" or base == "login_failed"}
        if role and actor != "aas":                           # AAS 자동 기록은 요청 중에 남아도 사람의 자격으로 보이지 않는다
            row[ROLES[role]] = True
        if via:
            row["via"] = via
        if r.get("count"):                                    # 「일 시키기」는 날짜별로 묶은 건수
            row["count"] = r["count"]
        if req:
            row["request"] = req.strip()
        if base in ("profile_credential_put", "profile_credential_clear") and not failed:   # 「보기」 링크(?file=)의 칸(2026-10-22-004 R12). note 는 「<이메일> <프로파일> <경로>」
            prof, _, path = row["detail"].partition(" ")
            if prof and path:
                row["profile"], row["file"] = prof, path
        if base in NS_IN_NOTE:
            row["detail"] = _ns_labels(row["detail"])
        if r["pod"]:                                          # 어느 에이전트(POD)의 일인가 — 대상 글에는 프로파일 이름만 있어 사용자마다 같은 「main」이 된다(2026-10-18)
            row["pod"] = r["pod"]
            # 마켓·주 프로파일 기록은 대상 글에 설치본 id 를 적었다(「→ <id>/main」). 화면이 대상 앞에 「주인 · 에이전트 이름」을 붙이므로
            # 읽을 때 id 를 뺀다 — 이미 쌓인 기록도 같게 보인다(스펙 2026-10-19-003)
            if base in POD_IN_NOTE:
                row["detail"] = re.sub(rf"(?<![\w.-]){re.escape(r['pod'])}(?:/| )", "", row["detail"])
        if actor:
            row["actor"] = actor
        out.append(row)
        if len(out) >= limit:
            break
    return out
