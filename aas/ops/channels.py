# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""채널 연결 현황 — 프로파일마다 게이트웨이가 도는지, 어떤 채널이 붙어 있고 살아 있는지,
크론 작업의 전달 대상 채널이 실제로 연결돼 있는지.

읽는 것: 프로파일의 gateway_state.json(런타임), config.yaml 의 채널 설정(이름·켜짐 여부만),
.env 의 변수 **이름**(값은 읽지 않는다), 컨테이너 안 s6 서비스 상태(`s6-svstat`, 읽기 전용).
"""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone

from ..hermes import hermes_reader as hr, readers
from ..common.i18n import tr
from ..common.redact import redact

CONTAINER = os.environ.get("AAS_HERMES_CONTAINER", "hermes-agent")
KNOWN = ("telegram", "buzz", "slack", "discord", "mattermost", "whatsapp", "signal", "matrix", "email", "api_server")
ENV_HINT = {"telegram": "TELEGRAM_BOT_TOKEN", "slack": "SLACK_BOT_TOKEN", "discord": "DISCORD_BOT_TOKEN", "mattermost": "MATTERMOST_TOKEN",
            "buzz": "BUZZ_PRIVATE_KEY"}
STALE_DAYS = 2


def _agent_status(name: str) -> dict | None:
    """쿠버네티스 모드: HermesAgent 의 status. 등록부가 읽어 둔 목록에서 먼저 찾고, 없을 때만 API 에 묻는다(OMAI-1109).
    클러스터를 읽지 못하면 None."""
    from ..fleet import k8s
    try:
        client = k8s.client()
        item = client.known_agent(name) or client.get_agent(name)
    except (k8s.K8sError, AttributeError):
        return None
    return item.get("status") or {}


def _from_agent(name: str) -> dict[str, dict]:
    """쿠버네티스 모드: 오퍼레이터가 주기적으로 읽어 HermesAgent status.channels 에 적어 둔 값. 읽지 못했으면 빈 dict."""
    rows = ((_agent_status(name) or {}).get("channels")) or []
    return {str(c["name"]): {"up": bool(c.get("up")), "disabled": bool(c.get("disabled")), "status": str(c.get("status") or "")[:80]}
            for c in rows if isinstance(c, dict) and c.get("name")}


def service_status(container: str | None = None) -> dict[str, dict]:
    """s6 게이트웨이 서비스 상태. 쿠버네티스 모드면 오퍼레이터가 HermesAgent status.channels 에 적어 둔 값을 읽는다.
    그 밖의 환경(compose 시험)에는 컨테이너 안을 읽을 길이 없어 빈 dict 다(화면은 '모름'으로 표시). 예전의 `docker exec` 는 없앴다."""
    from ..fleet import k8s
    if k8s.client() is not None:
        return _from_agent(container or CONTAINER)
    return {}


def services_checked(container: str | None = None) -> bool:
    """오퍼레이터가 컨테이너를 읽었는데(확인 시각이 있고 오류가 없다) 서비스 목록이 비어 있는가.
    s6 를 쓰지 않는 이미지(게이트웨이가 PID 1 로 도는 이미지)는 읽어도 s6 서비스가 없다. 이것은 「읽지 못함」이 아니라
    「서비스가 없음」이라, 게이트웨이 동작 여부를 상태 파일로 판단하는 것이 정상이다. 읽다가 실패했거나(channelsError)
    아직 읽지 않았거나 클러스터를 읽지 못하면 거짓이다."""
    from ..fleet import k8s
    if k8s.client() is None:
        return False
    status = _agent_status(container or CONTAINER)
    return bool(status and status.get("channelsCheckedAt") and not status.get("channelsError"))


def _env_names(prof: hr.Profile, text: str | None = None) -> set[str]:
    """text: 미리 읽은 .env 글(collect 가 한 번에 읽는다). 없으면 파일을 읽는다."""
    if text is None:
        f = prof.path / ".env"
        if not f.is_file():
            return set()
        text = f.read_text(errors="replace")
    return {m.group(1) for m in re.finditer(r"^([A-Z][A-Z0-9_]*)=", text, re.M)}


def _configured(prof: hr.Profile, cfg_text: str | None = None, env_text: str | None = None) -> dict[str, bool]:
    """설정상 켜진 채널. 값(토큰·채널 id)은 보지 않고 켜짐 여부만. cfg_text·env_text: 미리 읽은 config.yaml·.env 글."""
    try:
        import yaml
        cfg = yaml.safe_load(cfg_text if cfg_text is not None else (prof.path / "config.yaml").read_text(errors="replace")) or {}
    except Exception:
        cfg = {}
    found: dict[str, bool] = {}
    for src in ((cfg.get("gateway") or {}).get("platforms") or {}, cfg.get("platforms") or {}):
        for name, sect in src.items():
            if isinstance(sect, dict) and "enabled" in sect:
                found[name] = bool(sect["enabled"])
            else:
                found.setdefault(name, True)
    env = _env_names(prof, env_text)
    for name, var in ENV_HINT.items():
        if var in env:
            found.setdefault(name, True)
    return found


def _age_days(ts) -> float | None:
    dt = hr.parse_ts(ts)
    return (datetime.now(timezone.utc) - dt).total_seconds() / 86400 if dt else None


def _json_or(text: str, default):
    try:
        return json.loads(text) if text.strip() else default
    except ValueError:
        return default


def _jobs(text: str) -> list:
    """cron/jobs.json 글 → 켜진 작업 목록(hr.read_jobs 와 같은 해석). 없거나 모양이 다르면 빈 목록."""
    data = _json_or(text, None)
    jobs = data.get("jobs") if isinstance(data, dict) else data
    return [j for j in jobs if isinstance(j, dict) and j.get("enabled", True) and not j.get("paused_at")] if isinstance(jobs, list) else []


def _root_gateway(home) -> dict:
    """루트 게이트웨이의 상태 파일. 루트가 프로파일을 함께 돌리는 구조(쿠버네티스 GATEWAY_MULTIPLEX_PROFILES=true, OMAI-1147)에서는
    이름 있는 프로파일 폴더에 gateway_state.json 이 생기지 않고 이 파일의 served_profiles 에 이름이 있다. 읽지 못하면 빈 dict."""
    try:
        return json.loads(((home or hr.hermes_home()) / "gateway_state.json").read_text()) or {}
    except Exception:
        return {}


def collect(home=None, container: str | None = None) -> dict:
    services = service_status(container)
    profiles = hr.profiles(home)
    # 필요한 파일을 모아 한 번에 읽는다 — 사이드카에서는 read 요청 하나다. 프로파일마다 하나씩 읽으면 사이드카가 늦을 때
    # 프로파일 3개에 40초가 넘었다(OMAI-1459, 스펙 2026-10-24-002 R5)
    files = ("gateway_state.json", "config.yaml", ".env", "cron/jobs.json")
    texts = readers.read_texts([(home or hr.hermes_home()) / "gateway_state.json"]
                               + [prof.path / n for prof in profiles for n in files])
    root = _json_or(texts[0], {})
    if not isinstance(root, dict):
        root = {}
    # 루트가 실행 중일 때만 함께 도는 프로파일로 친다. served_profiles 가 없는 옛 Hermes 는 빈 집합이라 예전 판정 그대로다
    served = {str(n) for n in (root.get("served_profiles") or [])} if root.get("gateway_state") == "running" else set()
    rows = []
    for i, prof in enumerate(profiles):
        state_text, cfg_text, env_text, jobs_text = texts[1 + i * len(files):1 + (i + 1) * len(files)]
        state = _json_or(state_text, {})
        if not isinstance(state, dict):
            state = {}
        shared = not state and prof.name in served             # 자기 상태 파일이 있으면 그것을 쓴다
        if shared:                                              # 상태·버전·시각은 루트 것을 보인다. 채널(platforms)은 루트에 속해 여기에 얹지 않는다
            state = {k: root.get(k) for k in ("gateway_state", "updated_at", "code_version")}
        jobs = _jobs(jobs_text)
        svc = services.get(prof.name)
        configured = _configured(prof, cfg_text, env_text)
        pid = state.get("pid")
        platforms = []
        for name in sorted(set(configured) | set((state.get("platforms") or {}).keys()),
                           key=lambda n: (KNOWN.index(n) if n in KNOWN else 99, n)):
            rt = (state.get("platforms") or {}).get(name) or {}
            age = _age_days(rt.get("updated_at"))
            stale = bool(rt) and (rt.get("writer_pid") not in (None, pid) or (age is not None and age > STALE_DAYS
                                                                                 and rt.get("state") != "connected"))
            if not rt and configured.get(name) is False:
                continue                      # 꺼 둔 채널이고 런타임 기록도 없으면 보여 줄 것이 없다
            platforms.append({"name": name, "configured": configured.get(name),
                              "state": rt.get("state") or (tr("설정만 있음", "Configured only") if configured.get(name) else ""),
                              "error": redact(rt.get("error_message") or rt.get("error_code") or "", 160),
                              "needs_attention": bool(rt.get("needs_attention")),
                              "retrying_since": rt.get("retrying_since"), "updated_at": rt.get("updated_at"),
                              "stale": stale, "runtime": bool(rt)})
        if svc:
            running = svc["up"]
        elif shared:                                     # 루트 게이트웨이가 이 프로파일의 크론·채널을 맡아 돌고 있다
            running = True
        elif services:                                   # 서비스 목록은 읽었는데 이 프로파일 것이 없다
            running = None
        else:                                            # docker 를 못 쓰는 환경: 상태 파일로 판단한다
            running = state.get("gateway_state") == "running" if state else False
        connected = {p["name"] for p in platforms if p["state"] == "connected" and not p["stale"]}
        issues = []
        if svc and not svc["up"] and jobs:
            why = tr("s6 down 파일로 일부러 꺼 둠", "turned off on purpose with an s6 down file") if svc["disabled"] else svc["status"]
            issues.append({"level": "bad", "text": tr(f"게이트웨이가 꺼져 있어 활성 예약 작업 {len(jobs)}개가 돌지 않음 ({why}): ",
                                         f"The gateway is off, so {len(jobs)} active scheduled jobs do not run ({why}): ")
                           + ", ".join(str(j.get('name')) for j in jobs[:4])})
        if running is False and not jobs:
            issues.append({"level": "warn", "text": tr("게이트웨이가 꺼져 있음(활성 예약 작업은 없음) — 채널로 오는 메시지를 받지 못한다",
                                                                 "The gateway is off (no active scheduled jobs). Messages from channels are not received")})
        for p in platforms:
            if p["stale"] or running is False:     # 게이트웨이가 꺼져 있으면 채널 끊김은 그 결과일 뿐이다
                continue
            # 설정에 켜져 있거나, 게이트웨이가 이 채널을 띄우려 한 기록이 있으면 대상이다
            if (p["configured"] or p["runtime"]) and p["state"] not in ("connected", "") and p["name"] != "api_server":
                issues.append({"level": "bad", "text": tr(f"{p['name']} 연결 안 됨: {p['state']} {p['error']}", f"{p['name']} is not connected: {p['state']} {p['error']}").strip()})
            if p["needs_attention"]:
                since = (p["retrying_since"] or "")[:10]
                issues.append({"level": "warn", "text": tr(f"{p['name']} 에 '주의 필요' 표시", f"{p['name']} is marked as needing attention")
                               + (tr(f" — {since}부터 재시도 기록이 남아 있음", f" (retrying since {since})") if since else "")
                               + (tr(" (지금은 연결됨)", " (connected now)") if p["state"] == "connected" else "")})
        if state.get("gateway_state") == "startup_failed":      # 켜려고 했는데 뜨지 못한 경우 — 이유를 그대로 보여 준다
            issues.insert(0, {"level": "bad", "text": tr("게이트웨이가 시작하지 못함: ", "The gateway could not start: ") + redact(state.get("exit_reason") or tr("이유 기록 없음", "no reason recorded"), 240)})
        undeliverable: dict[str, list[str]] = {}
        for j in jobs:
            target = str(j.get("deliver") or "local").split(":")[0]
            if target in KNOWN and target not in connected and running is not False:
                undeliverable.setdefault(target, []).append(str(j.get("name") or j.get("id")))
        for target, names in undeliverable.items():
            issues.append({"level": "bad", "text": tr(f"{target} 로 보내는 예약 작업 {len(names)}개의 전달 채널이 연결돼 있지 않음: ",
                                         f"The delivery channel of {len(names)} scheduled jobs sending to {target} is not connected: ")
                           + ", ".join(names[:4])})
        rows.append({"name": prof.name, "service": svc, "running": running, "shared": shared,
                     "gateway_state": state.get("gateway_state"), "updated_at": state.get("updated_at"),
                     "version": state.get("code_version"), "jobs_active": len(jobs),
                     "platforms": platforms, "issues": issues})
    return {"collected_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            "services_known": bool(services) or services_checked(container), "profiles": rows,
            "totals": {"profiles": len(rows),
                       "gateways_up": sum(1 for r in rows if r["running"]),
                       "gateways_down_with_jobs": sum(1 for r in rows if r["running"] is False and r["jobs_active"]),
                       # 메신저(텔레그램·슬랙 등) 연결 수. 옛 기록(stale)과 api_server(Hermes 자신의 API)는 뺀다 — 대시보드의 「메신저 연결」 칸(2026-10-18)
                       "messengers_connected": sum(1 for r in rows for p in r["platforms"]
                                                   if p["name"] != "api_server" and p["state"] == "connected" and not p["stale"]),
                       "messengers_total": sum(1 for r in rows for p in r["platforms"] if p["name"] != "api_server" and not p["stale"]),
                       "channels_connected": sum(1 for r in rows for p in r["platforms"]
                                                 if p["state"] == "connected" and not p["stale"]),
                       "needs_attention": sum(1 for r in rows for p in r["platforms"]
                                              if p["needs_attention"] and not p["stale"]),
                       "profiles_with_bad": sum(1 for r in rows if any(i["level"] == "bad" for i in r["issues"]))}}
