# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""가짜 AAS 서버. 새 화면(/)을 Hermes 없이 띄워 오프라인 점검(offline.mjs)·프레임 속도 측정(fps.mjs)에 쓴다.
옛 화면과의 대조(run.mjs)는 옛 화면을 지울 때(M1-10) 함께 없앴다. 커밋 3e3319d 에 있다.

실제 Hermes 없이 화면만 그린다. 쓰기 요청은 아무것도 바꾸지 않는다. 사용: python3 mock_aas.py [포트]
"""
import http.server, json, os, sys, urllib.parse
import pathlib
HERE = pathlib.Path(__file__).resolve().parent
ROOT = str(HERE.parent.parent / "aas" / "static")          # 새 화면(빌드 산출물)
FIXTURES = os.environ.get("MOCK_FILES") or str(HERE / "fixtures")   # 대화 파일 받기 표본(문서 뷰어 시험)
T = "2026-10-10T"
D = {
 "/api/me": {"auth_enabled": True, "user": {"email": "kim@corp.example", "name": "김철수"}, "department": "개발팀", "account": {"method": "keycloak", "can_change_password": True}, "admin": True, "pod": {"id": "one", "owner": "kim"}, "pods": [{"id": "one", "owner": "kim"}, {"id": "two", "owner": "lee"}]},
 "/api/health": {"collected_at": T+"14:00:00+09:00", "dashboard_url": "http://hermes.local", "totals": {"profiles": 3, "profiles_ok": 3, "failed_jobs": 2, "stalled": 1, "jobs_active": 7, "jobs": 9, "settled_incidents": 2, "silent": 1, "muted_jobs": 3, "live_incidents": 1, "new_incidents": 1, "open_incidents": 3, "stale_profiles": []},
   "incidents": [{"id": "i1", "job": "nightly", "job_id": "j1", "profile": "ma", "error": "타임아웃 발생", "now": "failing", "state": "detected", "age_days": 3, "last_seen_at": T+"08:00:00+09:00", "new": True, "ack": "hermes cron ack i1"}, {"id": "i2", "job": "old", "job_id": "j2", "profile": "ops", "error": "401", "now": "ok", "state": "notified", "age_days": 9, "last_seen_at": T+"01:00:00+09:00", "ack": "hermes cron ack i2"}],
   "silent": [{"job": "quiet", "job_id": "j7", "profile": "ma", "schedule": "0 8 * * *", "reason": "전달 대상이 local"}], "muted": [],
   "profiles": [{"name": "ma", "open_incidents": 1, "failed_jobs": 1, "stalled_jobs": 0, "silent_jobs": 1, "jobs_total": 5, "jobs_active": 4, "runs_7d": 10, "runs_failed_7d": 2, "exec_status": "ok", "jobs_status": "ok"}, {"name": "ops", "open_incidents": 0, "failed_jobs": 0, "stalled_jobs": 1, "silent_jobs": 0, "jobs_total": 1, "jobs_active": 1, "runs_7d": 0, "runs_failed_7d": 0, "exec_status": "ok", "jobs_status": "ok"}],
   "failed_jobs": [{"job": "nightly", "job_id": "j1", "profile": "ma", "schedule": "30 9 * * *", "error": "타임아웃 발생", "streak": 3, "deliver": "local"}, {"job": "digest", "job_id": "j2", "profile": "ops", "error": "401", "streak": 2}],
   "stalled": [{"job": "slowpoke", "job_id": "s1", "profile": "ops", "schedule": "30m", "kind": "지연", "cause": "락 대기", "hours": 5.6, "since": T+"00:00:00+09:00"}],
   "weekly": {"problem": "발행 실패", "error": "404", "last_ok": "2026-10-03T09:00:00+09:00", "ts": T+"08:00:00+09:00"}},
 "/api/profiles": {"can_edit": True, "profiles": [{"name": "ma", "title": "마케팅", "description": "마케팅 담당", "model": "qwen3", "is_default": False, "running": False, "jobs_active": 4, "jobs_total": 5, "failed_jobs": 1, "sessions_7d": 3, "skills": 6, "mcp": ["chart"], "creds": 2, "creds_expiring": 1, "last_activity": T+"08:00:00+09:00", "channels": [{"name": "telegram", "state": "connected", "attention": True}], "issues": [{"level": "bad", "text": "게이트웨이가 꺼져 있음"}]}, {"name": "default", "title": "", "description": "", "model": "qwen3", "is_default": True, "running": True, "jobs_active": 0, "jobs_total": 0, "failed_jobs": 0, "sessions_7d": 0, "skills": 2, "mcp": [], "creds": 0, "channels": [], "issues": []}]},
 "/api/profile": {"profile": {"name": "ma", "title": "마케팅", "description": "마케팅 담당", "model": "qwen3", "is_default": False, "running": False, "jobs_active": 4, "jobs_total": 5, "failed_jobs": 1, "sessions_7d": 3, "skills": 6, "mcp": ["chart"], "creds": 2, "creds_expiring": 1, "last_activity": T+"08:00:00+09:00", "channels": [{"name": "telegram", "state": "connected", "attention": True}], "issues": [{"level": "bad", "text": "게이트웨이가 꺼져 있음"}]}, "can_edit": True, "secure": True, "notes": [], "models": ["qwen3", "gemma"], "soul": {"lines": ["# 성격", "친절하게"], "sha": "s1", "versions": 1, "masked_lines": []}, "config": {"lines": ["model: qwen3"], "sha": "c1", "versions": 0, "masked_lines": []}, "env": [{"name": "OPENAI_API_KEY", "set": True, "description": "OpenAI 키", "category": "LLM"}, {"name": "SLACK_TOKEN", "set": False, "description": "슬랙", "channel": True}], "skills": [{"name": "report", "description": "보고", "enabled": True, "usage": 3}, {"name": "alert", "description": "", "enabled": False}], "mcp": [{"name": "chart", "transport": "http", "target": "http://chart", "env_names": ["CHART_KEY"], "enabled": True}], "toolsets": [{"name": "web", "label": "웹", "description": "웹 도구", "tools": 4, "enabled": True, "available": True, "configured": True}]},
 "/api/flow": {"root": "cron:ma/j1", "nodes": [
   {"id": "cron:ma/j1", "kind": "cron", "label": "nightly", "sub": "", "badges": ["실패"], "depth": 0, "meta": {"프로파일": "ma", "일정": "30 9 * * *"}},
   {"id": "skill:ma:report", "kind": "skill", "label": "report", "sub": "", "badges": ["등록됨"], "depth": 1, "profile": "ma", "meta": {"경로": "skills/report"}, "path": "skills/report/SKILL.md"},
   {"id": "script:run.py", "kind": "script", "label": "run.py", "sub": "", "badges": [], "depth": 2, "meta": {}, "path": "skills/report/run.py"},
   {"id": "mcp:chart", "kind": "mcp", "label": "chart", "sub": "", "badges": [], "depth": 2, "meta": {}},
   {"id": "cred:KEY", "kind": "cred", "label": "OPENAI_API_KEY", "sub": "", "badges": ["만료됨"], "depth": 3, "meta": {}, "status": "bad"}],
  "edges": [
   {"from": "cron:ma/j1", "to": "skill:ma:report", "kind": "runs", "conf": "config", "meta": {}, "evidence": []},
   {"from": "skill:ma:report", "to": "script:run.py", "kind": "calls", "conf": "code", "meta": {}, "evidence": [{"file": "skills/report/SKILL.md", "line": 3, "text": "python run.py"}]},
   {"from": "skill:ma:report", "to": "mcp:chart", "kind": "calls", "conf": "observed", "meta": {"observed": 4, "tools": ["render"]}, "evidence": []},
   {"from": "mcp:chart", "to": "cred:KEY", "kind": "uses", "conf": "doc", "meta": {}, "evidence": []}],
  "observed": {"days": 14, "scope": "이 작업", "runs": 6, "matched": 1}, "hidden_mentions": 2},
 "/api/file": {"name": "SKILL.md", "path": "skills/report/SKILL.md", "lines": ["# report", "설명", "python run.py", "끝"], "sha": "f1", "versions": 1, "masked_lines": [], "modified": "2026-10-01T00:00:00", "editable": True, "siblings": ["skills/report/SKILL.md", "skills/report/run.py"]},
 "/api/flows": {"totals": {"nodes": 40, "edges": 55}, "starts": [{"id": "ma/j1", "label": "daily", "profile": "ma", "status": "ok", "badges": [], "sub": "ma · 30 9 * * *", "skills": ["report"], "scripts": []}]},
 "/api/text/versions": {"versions": []},
 "/api/chat/status": {"configured": True, "agents": [{"name": "default", "description": "공용"}, {"name": "ma", "title": "마케팅", "description": "마케팅 담당", "running": True, "channels": ["telegram"], "last_activity": T+"08:00:00+09:00"}, {"name": "ops", "description": "운영", "running": False, "failed_jobs": 2}], "sessions": []},
 "/api/chat/history": {"sessions": [{"id": "h1", "source": "telegram", "title": "텔레그램 대화", "preview": "안녕하세요", "started_at": 1760000000, "message_count": 4}]},
 "/api/market/package": {"kind": "skill", "paid": False, "owner": "openmaru", "files": [{"path": "SKILL.md", "size": 10}], "scripts": 1, "body": "설명 본문", "version": "1.2", "versions": [{"version": "1.2"}, {"version": "1.1"}], "allowed": True},
 "/api/market": {"configured": True, "admin": True, "helper": {"alive": True}, "web": "http://hub.local",
   "packages": [{"id": "free/report", "namespace": "free", "name": "report", "summary": "리포트 스킬", "version": "1.2", "paid": False, "allowed": True, "update": False, "installed": [{"profile": "ma", "version": "1.0"}]}, {"id": "pro/tuner", "namespace": "pro", "name": "tuner", "summary": "튜너 에이전트", "version": "2.0", "paid": True, "allowed": False, "update": True, "installed": []}],
   "installed": [{"profile": "ma", "package": "free/report", "name": "report", "namespace": "free", "kind": "skill", "version": "1.0", "ts": T+"10:00:00+09:00"}],
   "requests": [{"status": "failed", "mode": "install", "profile": "ma", "name": "report", "package": "free/report", "version": "1.0", "kind": "skill", "who": "kim", "message": "디스크 부족", "ts": T+"11:00:00+09:00"}]},
 "/api/skills": {"totals": {"skills": 3, "with_cron": 1, "with_mcp": 2, "with_rest": 1}, "skills": [{"id": "default:report", "name": "report", "description": "주간 보고", "profile": "default", "n_cron": 1, "n_mcp": 1, "n_rest": 0, "n_scripts": 2}, {"id": "ma:alert", "name": "alert", "description": "", "profile": "ma", "n_cron": 0, "n_mcp": 1, "n_rest": 2, "n_scripts": 0, "urls": ["https://api.example.com/v1/alerts", "https://api.example.com/v1/rules", "https://hooks.slack.com/services/T000/B000"]}], "by_mcp": {"chart": ["default:report", "ma:alert"]}, "by_host": {"api.example.com": ["ma:alert"]}},
 "/api/skill": {"name": "report", "description": "주간 보고를 만든다", "profile": "default", "path": "skills/report", "modified": "2026-10-01T00:00:00Z", "files": 4, "cron": [{"profile": "ma", "job": "weekly", "enabled": True, "last_status": "ok"}], "mcp": [{"server": "chart", "tools": ["render"], "evidence": ""}], "rest": [{"host": "api.example.com", "urls": ["https://api.example.com/a"]}], "skills": ["alert"], "scripts": ["skills/report/run.py"], "external_scripts": []},
 "/api/cron/job": {"can_edit": True, "job": {"id": "j1", "name": "nightly", "enabled": True, "state": "scheduled", "schedule_display": "30 9 * * *", "next_run_at": "2026-10-11T09:30:00+09:00", "last_run_at": T+"09:30:00+09:00", "last_status": "error", "failure_streak": 3, "last_error": "타임아웃", "deliver": "local", "skills": ["report"]}, "targets": [{"id": "local", "name": "저장만", "ready": True}, {"id": "telegram", "name": "텔레그램", "ready": True}], "runs": [{"started_at": 1760056200, "ended_at": 1760056242, "status": "ok", "tool_call_count": 3}], "muted": None, "note_doc": {"lines": ["메모"], "sha": "n1", "versions": 0, "masked_lines": []}, "prompt_doc": {"lines": ["지시문"], "sha": "p1", "versions": 0, "masked_lines": []}},
 "/api/cron/explain": {"skill": {"id": "ma:report", "name": "report", "where": "ma", "description": "주간 보고", "outline": []}, "root": "cron:ma/j1", "checks": [{"level": "ok", "text": "스킬 있음"}], "groups": [], "observed": {"days": 7, "scope": "이 작업", "runs": 5, "matched": 0}},
 "/api/registry": {"reg": {"status": "registered", "owner": "kim", "updated": T+"10:00:00+09:00", "note": "메모"}},
 "/api/credentials": {"totals": {"items": 3, "global": 1, "profile": 2, "expiring": 1, "empty": 1, "backups": 0, "shared_groups": 1, "registered": 0}, "items": [
   {"id": "c1", "name": "OPENAI_API_KEY", "scope": "프로파일", "profile": "ma", "set": True, "flags": ["만료됨"], "interface": "REST", "target": "openai", "location": "/data/profiles/ma/.env", "source": ".env", "expires": "2026-09-30T00:00:00Z", "used_count": 2, "used_by": ["스킬 report/x", "크론 ma/daily"], "shared": 2},
   {"id": "c2", "name": "SLACK_TOKEN", "scope": "전역", "set": False, "flags": ["비어 있음"], "interface": "WebSocket", "location": "/data/.env", "source": ".env", "used_count": 0, "used_by": []},
   {"id": "c3", "name": "OK_KEY", "scope": "전역", "set": True, "flags": [], "interface": "MCP", "location": "docker/compose.yml", "source": "compose", "used_count": 0, "used_by": []}]},
 "/api/tools": {"totals": {"items": 1, "global": 0, "profile": 1, "languages": {"python": 1}, "unreferenced": 1, "registered": 0}, "items": [{"id": "t1", "name": "sync.py", "scope": "프로파일", "profile": "ma", "language": "python", "kind": "script", "path": "profiles/ma/scripts/sync.py", "modified": "2026-10-02T00:00:00Z", "summary": "동기화", "imports": ["requests"], "flags": ["부르는 곳 없음"], "used_count": 0, "used_by": []}]},
 "/api/libraries": {"totals": {"items": 1, "envs": 1, "global": 1, "profile": 0, "used": 1, "version_conflicts": 0, "registered": 0}, "items": [{"id": "l1", "name": "requests", "version": "2.32", "scope": "전역", "kind": "python", "env": "image", "flags": [], "used_count": 1, "used_by": ["스크립트 sync.py"]}], "envs": [{"env": "image", "kind": "python", "scope": "전역", "packages": 120, "path": "/usr/lib", "note": "스냅샷"}]},
 "/api/channels": {"services_known": True, "totals": {"gateways_up": 1, "profiles": 3, "gateways_down_with_jobs": 1, "channels_connected": 2, "needs_attention": 1}, "profiles": [
   {"name": "ma", "running": False, "service": {"status": "inactive"}, "jobs_active": 4, "platforms": [{"name": "telegram", "state": "connected", "needs_attention": True, "updated_at": T+"09:30:00+09:00"}], "issues": [{"level": "bad", "text": "게이트웨이가 꺼져 있어 크론 4개가 돌지 않습니다"}, {"level": "warn", "text": "재시도 기록"}]},
   {"name": "ops", "running": True, "jobs_active": 1, "platforms": [{"name": "buzz", "state": "connected"}, {"name": "slack", "state": "fatal", "error": "invalid_auth"}], "issues": []},
   {"name": "idle", "running": None, "jobs_active": 0, "platforms": [], "issues": []}]},
 "/api/activity": {"days": 7, "totals": {"sessions": 10, "messages": 12345, "tool_calls": 20000, "input_tokens": 2500000, "output_tokens": 90000, "idle_profiles": 1},
   "by_source": [{"source": "cron", "sessions": 4}, {"source": "telegram", "sessions": 6}],
   "by_model": [{"model": "qwen3", "sessions": 8, "input_tokens": 2000000, "output_tokens": 80000}],
   "profiles": [{"name": "ma", "status": "ok", "sessions": 10, "messages": 12345, "tool_calls": 20000, "input_tokens": 2500000, "output_tokens": 90000, "last_activity": T+"08:15:00+09:00", "sources": [{"source": "telegram", "sessions": 6}, {"source": "cron", "sessions": 4}]},
                {"name": "idle", "status": "ok", "sessions": 0, "messages": 0, "tool_calls": 0, "input_tokens": 0, "output_tokens": 0, "last_activity": None, "sources": []}]},
 "/api/changes": {"days": 30, "rows": [
   {"ts": T+"10:00:00+09:00", "group": "크론", "kind": "cron", "failed": False, "who": "kim", "what": "크론 수정", "detail": "ma/abc"},
   {"ts": "2026-10-02T09:00:00+09:00", "group": "비밀값", "kind": "cred", "failed": True, "who": "kim", "what": "키 교체", "detail": "ma/OPENAI"},
   {"ts": "2026-10-03T09:00:00+09:00", "group": "접속", "kind": "login", "failed": False, "who": "kim", "what": "로그인", "detail": ""}]},
 "/api/models": {"litellm": {"url": "http://litellm:4000", "reachable": True, "auth": "ok", "key_source": "env"}, "totals": {"litellm_models": 3, "profiles_with_bad": 1, "profiles_with_warn": 2, "fallback_trace_jobs": 0, "unused_models": 1},
   "models": [{"id": "qwen3", "in_litellm": True, "primary": ["ma", "ops"], "fallback": ["ma"], "auxiliary": ["vision"], "cron": []}, {"id": "spare", "in_litellm": True, "primary": [], "fallback": [], "auxiliary": [], "cron": []}],
   "profiles": [{"name": "ma", "has_config": True, "primary": {"model": "qwen3", "provider": "litellm"}, "fallbacks": [], "auxiliary": [], "cron_overrides": [], "issues": [{"level": "warn", "text": "폴백이 없습니다"}]}]},
 "/api/models/probe": {"ok": True, "ms": 1234},
 "/api/users": {"auth_enabled": True, "domain": "corp.example", "me": "kim@corp.example", "registry_file": "/etc/aas/users.json", "pods": [{"id": "one"}, {"id": "two"}],
   "users": [{"email": "kim@corp.example", "admin": True, "pods": ["one", "two"], "sessions": 1, "logins": 5, "last_login": T+"09:00:00+09:00", "until": "2026-10-11T09:00:00+09:00", "fixed": True},
             {"email": "lee@corp.example", "admin": False, "pods": ["one"], "sessions": 0, "password": True, "grant": {"ts": "2026-10-01T10:00:00+09:00", "by": "kim"}}]},
}
OFFICE_AGENTS = [
 {"alias": "ma", "pod": "one", "profile": "ma", "status": "working", "title": "마케팅", "role": "기획 · 성장", "team": "마케팅", "avatar": "", "mine": True},  # 내 에이전트 표시(2026-10-21-012)
 {"alias": "ops", "pod": "one", "profile": "ops", "status": "idle", "title": "운영", "role": "", "team": "플랫폼", "avatar": ""},
 {"alias": "qa", "pod": "two", "profile": "qa", "status": "error", "title": "품질", "role": "", "team": "", "avatar": ""},
]
if os.environ.get("MOCK_AGENTS"):                         # 장면 성능 측정용: 에이전트를 N 명으로 늘린다(fps.mjs)
    n = int(os.environ["MOCK_AGENTS"])
    OFFICE_AGENTS = [{"alias": f"a{i:02d}", "pod": "one", "profile": f"a{i:02d}", "status": ("working", "idle", "error")[i % 3 if i % 5 else 0],
                      "title": f"에이전트 {i}", "role": "", "team": "", "avatar": "", "mine": i == 0} for i in range(n)]
# rooms: 방 표시 uid 와 방 번호의 짝. 기본 배치의 TFT 회의실 1(kr_56, kr-21 부터. 전에는 kr_74)이 방 1 이다 — 상태판 회의실 행이 카메라를 옮기고 표시한다(2026-10-21-012)
D["/api/office/state"] = {"agents": OFFICE_AGENTS, "seq": 1, "ts": T+"14:00:00+09:00", "rooms": [{"uid": "kr_56", "kind": "tft", "label": "장애 대응", "name": "장애 대응", "room": 1}]}
D["/api/office"] = {"can_edit": True, "problems": [], "mine": "개발팀", "banners": json.loads(os.environ.get("MOCK_BANNERS") or '[{"team": "개발팀", "goal": "고객이 먼저 쓰는 제품을 만든다"}, {"team": "운영팀", "goal": "멈추지 않는 서비스"}]'), "seats": [{**{k: a[k] for k in ("alias", "pod", "profile", "title", "role", "team")}, "enabled": True, "note": "", "has_key": False} for a in OFFICE_AGENTS],
  "rooms": [{"id": 1, "name": "장애 대응", "purpose": "결제 지연", "owner": "kim", "seats": ["ma", "ops"], "people": ["lee"], "status": "open"}],
  "pods": [{"id": "one", "owner": "kim", "profiles": [{"name": "ma", "seated": True}, {"name": "ops", "seated": True}, {"name": "idle", "seated": False}]}, {"id": "two", "owner": "lee", "profiles": [{"name": "qa", "seated": True}]}]}

# 도구 화면의 MCP 서버 탭(OMAI-1249): 켜짐·꺼짐, http·stdio·알려지지 않은 연결 값, 이름이 20개를 넘는 서버, 읽지 못한 프로파일
D["/api/tools"]["mcp"] = [
    {"id": "default:github", "name": "github", "scope": "전역", "profile": "", "transport": "stdio", "enabled": True, "auth": "", "target": "npx -y server-github",
     "env_names": ["GITHUB_TOKEN", "LOG_LEVEL"], "env_count": 2, "header_names": [], "header_count": 0, "modified": "2026-10-16T11:00:00+09:00"},
    {"id": "ma:docs", "name": "docs", "scope": "프로파일", "profile": "ma", "transport": "http", "enabled": True, "auth": "header", "target": "https://docs.example.com/…",
     "env_names": [], "env_count": 0, "header_names": ["Authorization"], "header_count": 1, "modified": "2026-10-16T11:00:00+09:00"},
    {"id": "ma:big", "name": "big", "scope": "프로파일", "profile": "ma", "transport": "stdio", "enabled": True, "auth": "", "target": "python3 bridge.py --api-key ***",
     "env_names": [f"MCP_BIG_K{i:02d}" for i in range(20)], "env_count": 22, "header_names": [], "header_count": 0, "modified": "2026-10-16T11:00:00+09:00"},
    {"id": "sa:memory", "name": "memory", "scope": "프로파일", "profile": "sa", "transport": "sse", "enabled": False, "auth": "", "target": "https://memory.example.io/…",
     "env_names": [], "env_count": 0, "header_names": [], "header_count": 0, "modified": "2026-10-16T11:00:00+09:00"},
]
D["/api/tools"]["mcp_skipped"] = [{"profile": "broken", "reason": "unreadable"}]
D["/api/tools"]["totals"].update({"mcp": 4, "mcp_off": 1})
def _card(i, title, who, pri=0, cc=0):
    return {"id": i, "title": title, "assignee": who, "priority": pri, "comment_count": cc, "created_at": 1760000000}
def _col(name, *cards):
    return {"name": name, "tasks": [{**c, "status": name} for c in cards]}
D["/api/settings"] = {"company_name": "", "default_company": "OPENMARU, Inc.", "effective_company": "OPENMARU, Inc.", "identity_sentence": "You are CogentAI AAS Agent, built by OPENMARU, Inc.", "max": 80, "can_edit": True}   # 설정 › 회사 정보(계획 2026-10-13-008)
D["/api/users/me/password"] = {"ok": True, "other_sessions_ended": 1}      # 내 정보 서랍(스펙 2026-10-14-017)
D["/api/office/layout"] = {"version": 0, "items": None, "desks": {}}   # 판이 없으면 화면이 기본 배치로 그린다(계획 007 P−1)
D["/api/office/presence"] = {"people": []}
D["/api/office/inbox"] = {"items": []}
D["/api/office/cards"] = {"cards": []}
D["/api/office/meeting/active"] = {"meetings": []}
D["/api/office/kanban/boards"] = {"boards": [{"slug": "office-aa", "name": "제안 보드", "total": 5, "archived": False, "counts": {}}], "current": None}
D["/api/office/kanban/board"] = {"columns": [
  _col("triage", _card("t1", "고객사 요구 정리", None)), _col("todo"), _col("scheduled"),
  _col("ready", _card("t2", "견적서 초안", "ma", 2)), _col("running", _card("t3", "경쟁사 비교표", "qa", 0, 1)),
  _col("blocked"), _col("review", _card("t4", "제안서 목차", "ma")), _col("done", _card("t5", "킥오프 메모", "ops"))],
  "tenants": [], "assignees": ["ma", "ops", "qa"]}
D["/api/office/meeting"] = {"room": {"id": 1, "name": "장애 대응", "purpose": "결제 지연", "status": "open", "seats": ["ma", "ops"], "people": ["lee"]},
  "participants": [{"alias": "ma", "title": "마케팅", "pod": "one", "enabled": True}, {"alias": "ops", "title": "운영", "pod": "one", "enabled": True}],
  "messages": [{"id": 1, "role": "user", "author": "kim", "content": "결제 지연 원인부터 정리해 줘", "ts": T+"10:00:00+09:00"},
               {"id": 2, "role": "assistant", "author": "ops", "content": "**DB 커넥션 풀**이 가득 찼습니다.\n- 12:01 이후 대기 급증", "ts": T+"10:00:12+09:00"},
               {"id": 3, "role": "system", "author": "ma", "content": "ma 가 답하지 못했습니다: 시간 초과", "ts": T+"10:00:30+09:00"}], "pending": []}
# 대시보드(계획 2026-10-14-014). 관리자 「전체 에이전트」 구역의 값. AAS_MOCK_ROLE=user 면 관리자가 아닌 주인으로 본다
_V = lambda **k: {"profiles": 3, "gateways_up": 2, "profiles_bad": 0, "creds_expiring": 0, "jobs": 6, "jobs_active": 5, "failed_jobs": 0, "stalled_jobs": 0, "open_incidents": 0, **k}
_P = lambda pid, owner, **k: {"id": pid, "owner": owner, "owner_me": pid == "one", "ready": True, "phase": "Ready", "collected": True, "ok": True, "reason": "",
                              "ts": T+"14:00:00+09:00", "checked": T+"14:00:00+09:00", "stale": False, "values": _V(), "last_day": "2026-10-09", **k}
D["/api/dashboard"] = {"admin": True, "now": T+"14:10:00+09:00", "next_collect": T+"14:30+09:00", "collected_at": T+"14:00:00+09:00",
  "pods": [_P("one", "kim@corp.example", values=_V(failed_jobs=2, stalled_jobs=1, profiles_bad=1, creds_expiring=1)), _P("two", "lee@corp.example"),
           _P("three", "park@corp.example", ok=False, reason="시간 초과(60초)", checked=T+"14:00:00+09:00", ts=T+"11:00:00+09:00"),
           _P("four", "choi@corp.example", checked=T+"11:30:00+09:00", ts=T+"11:30:00+09:00", values=_V(failed_jobs=1)),
           {**_P("five", "jung@corp.example"), "ready": False, "phase": "Pending", "collected": False, "values": None, "ts": None, "checked": None, "last_day": None}],
  "totals": {"agents_ready": 4, "agents_total": 5, "failed_stalled": 4, "profiles_bad": 1, "creds_expiring": 1, "counted": 3, "countable": 4, "failed": 1},
  "trend": [{"day": f"2026-10-{d:02d}", "runs_7d": 38 + d, "failed_jobs": [0, 1, 1, 2, 0, 0, 3, 2, 1, 3][d - 1], "stalled": [0, 0, 1, 0, 0, 1, 1, 0, 0, 1][d - 1],
             "open_incidents": [1, 1, 2, 3, 2, 1, 3, 4, 3, 4][d - 1], "collect_errors": 1 if d == 7 else 0, "jobs": 30} for d in range(1, 11)],
  "usage": [{"day": f"2026-10-{d:02d}", "sessions": 10 + d, "messages": 40 + 3 * d, "input_tokens": 200000 + 15000 * d, "output_tokens": 9000 + 700 * d} for d in range(1, 10)],
  "ops": {"users": 5, "last_login": T+"13:50:00+09:00", "litellm": {"reachable": True}, "market": None, "collect": {"ts": T+"14:00:00+09:00", "seconds": 8.4, "pods": {"ok": 3, "total": 4, "failed": []}}}}
# 화면 내장 도움말(OMAI-1274 T2b): 내 주 에이전트(primary)와 프로파일 탭 권한(caps). 서버(aas/web/server.py)와 같은 모양이다
D["/api/me"]["primary"] = {"profile": "ma", "ready": True}
_CAPS = lambda admin: {**{k: {"can": True, "reason": ""} for k in ("soul", "config", "skills", "tools", "mcp", "cron", "env", "channels", "rename")},
                       "model": {"can": admin, "reason": "" if admin else "admin_only_model"},
                       "delete": {"can": admin, "reason": "" if admin else "admin_only"}}
D["/api/profile"].update({"caps": _CAPS(True), "owner": True})
# 채팅 묶음(/api/chat/status?all=1, 2026-10-19-001 R2). 프로파일이 하나뿐인 에이전트는 묶음 머리 없이 에이전트 이름 줄 하나(2026-10-19-013)
D["/api/chat/status"] = {**D["/api/chat/status"], "pod": "one", "groups": [
    {"pod": "one", "current": True, "configured": True, "name": "김철수", "primary": "main", "agents": [{"name": "main", "running": True, "last_activity": T+"09:00:00+09:00"}], "sessions": []},
    {"pod": "two", "shared": True, "owner_name": "이영희", "configured": True, "name": "이영희 에이전트", "primary": "main", "agents": [{"name": "main", "running": True}, {"name": "sales", "title": "영업", "running": True}], "sessions": []},
    {"pod": "three", "shared": True, "owner_name": "박민수", "configured": True, "name": "고객지원 도우미", "primary": "main", "agents": [{"name": "main", "running": False}], "sessions": []}]}
D["/api/agents"] = {"enabled": True, "limit": 3, "count": 1, "default_limit": 3, "can_create": True, "admin": True, "collect": None,   # 에이전트 화면(가이드 user.my-agents)
                    "agents": [{"name": "one", "owner": "kim@corp.example", "display_name": "김철수", "phase": "Ready", "message": "", "ready": True, "suspended": False, "created": T+"09:00:00+09:00",
                                "profiles": ["main", "ops", "research", "writer", "customer-support-korea"], "chat_default": "main"},   # 프로파일 칸(스펙 2026-10-19-006)
                               {"name": "two", "owner": "lee@corp.example", "display_name": "이영희", "phase": "Ready", "message": "", "ready": True, "suspended": False, "created": T+"08:00:00+09:00", "profiles": ["main"], "chat_default": "main"},
                               {"name": "three", "owner": "park@corp.example", "display_name": "박민수", "phase": "Ready", "message": "", "ready": True, "suspended": False, "created": T+"07:00:00+09:00", "profiles": None, "chat_default": ""},
                               {"name": "four", "owner": "choi@corp.example", "display_name": "최지은", "phase": "Ready", "message": "멈춰 있습니다(데이터는 그대로)", "ready": False, "suspended": True, "suspended_reason": "idle", "created": T+"06:00:00+09:00", "profiles": None, "chat_default": ""}]}
if os.environ.get("MOCK_SAME_NAME") == "1":   # 프로파일 서랍의 「같은 이름이 있는 에이전트」 캡처(스펙 2026-10-19-011)
    D["/api/me"] = {**D["/api/me"], "pod": {"id": "one", "owner": "kim", "name": "마케팅 도우미"}}
    D["/api/profile"] = {**D["/api/profile"], "pod": "one"}
    D["/api/agents"]["agents"][0] = {**D["/api/agents"]["agents"][0], "display_name": "마케팅 도우미", "profiles": ["ma", "ops"]}
    D["/api/agents"]["agents"][1:1] = [
        {"name": "five", "owner": "kim@corp.example", "display_name": "관리자 AAS", "phase": "Ready", "message": "", "ready": True, "suspended": False, "created": T+"05:00:00+09:00", "profiles": ["ma"], "chat_default": "ma"},
        {"name": "six", "owner": "kim@corp.example", "display_name": "시험 에이전트", "phase": "Ready", "message": "", "ready": True, "suspended": False, "created": T+"04:00:00+09:00", "profiles": ["ma"], "chat_default": "ma"}]
if os.environ.get("MOCK_ALL_AGENTS") == "1":   # 프로파일 화면의 내 에이전트 전체 목록 캡처(스펙 2026-10-19-018). 응답은 /api/profiles?all=1 모양
    _p = D["/api/profiles"]["profiles"]
    _main = lambda pod, name: {**_p[1], "name": "main", "is_default": False, "pod": pod, "pod_name": name}   # noqa: E731
    D["/api/me"] = {**D["/api/me"], "pod": {"id": "one", "owner": "kim", "name": "마케팅 도우미"}}
    D["/api/profiles"] = {"can_edit": True, "default_model": "", "profiles": [
        _main("one", "마케팅 도우미"), {**_p[0], "pod": "one", "pod_name": "마케팅 도우미"}, _main("five", "관리자 AAS"), _main("six", "시험 에이전트"),
        {**_p[0], "name": "research", "title": "조사", "issues": [], "pod": "six", "pod_name": "시험 에이전트"}], "groups": [
        {"pod": "one", "name": "마케팅 도우미", "current": True, "state": "ok", "can_create": True, "primary": "main", "chat_default": "main", "owner": True, "count": 2},
        {"pod": "five", "name": "관리자 AAS", "state": "ok", "can_create": True, "primary": "main", "chat_default": "main", "owner": True, "count": 1},
        {"pod": "six", "name": "시험 에이전트", "state": "ok", "can_create": True, "primary": "main", "chat_default": "research", "owner": True, "count": 2},
        {"pod": "two", "name": "이영희 에이전트", "owner_name": "이영희", "shared": True, "state": "error", "error": "응답 없음", "can_create": False},
        {"pod": "seven", "name": "새 에이전트", "state": "ok", "can_create": True, "primary": "main", "chat_default": "main", "owner": True, "count": 0},
        {"pod": "four", "name": "멈춘 에이전트", "state": "stopped"}]}
    D["/api/agents"]["agents"][0] = {**D["/api/agents"]["agents"][0], "display_name": "마케팅 도우미", "profiles": ["main", "ma"]}
    D["/api/agents"]["agents"][1:1] = [
        {"name": "five", "owner": "kim@corp.example", "display_name": "관리자 AAS", "phase": "Ready", "message": "", "ready": True, "suspended": False, "created": T+"05:00:00+09:00", "profiles": ["main"], "chat_default": "main"},
        {"name": "six", "owner": "kim@corp.example", "display_name": "시험 에이전트", "phase": "Ready", "message": "", "ready": True, "suspended": False, "created": T+"04:00:00+09:00", "profiles": ["main", "research"], "chat_default": "research"}]
if os.environ.get("MOCK_TOPBAR_AGENTS") == "1":   # 상단 막대 에이전트 고르개 캡처(스펙 2026-10-19-019). 일부 수집 실패로 경고 점도 보인다
    _k = "kim@corp.example"
    D["/api/me"] = {**D["/api/me"], "pod": {"id": "one", "owner": _k, "name": "마케팅 도우미"}, "pods": [
        {"id": "one", "owner": _k, "name": "마케팅 도우미"}, {"id": "five", "owner": _k, "name": "관리자 AAS"}, {"id": "six", "owner": _k, "name": "시험 에이전트"},
        {"id": "a1", "owner": "u1@corp.example", "owner_name": "AAS 사용자1", "name": "사용자1 에이전트"},
        {"id": "a2", "owner": "u2@corp.example", "owner_name": "AAS 사용자2", "name": "사용자2 에이전트"},
        {"id": "t1", "owner": "test@corp.example", "owner_name": "테스트 AAS", "name": "AAS 테스트"}]}
    D["/api/health"] = {**D["/api/health"], "totals": {**D["/api/health"]["totals"], "profiles_ok": 2}}
if os.environ.get("AAS_MOCK_ROLE") == "user":
    D["/api/me"] = {**D["/api/me"], "admin": False, "owner": True, "pods": [{"id": "one", "owner": "kim"}]}
    D["/api/profile"] = {**D["/api/profile"], "can_edit": False, "owner": True, "caps": _CAPS(False)}
    D["/api/agents"] = {**D["/api/agents"], "admin": False}
# 스킬 AI 요약(스펙 2026-10-17-002). GET·POST 모두 같은 값을 돌려준다(마켓·스킬 서랍 확인용)
D["/api/skill/summary"] = {"enabled": True, "lang": "ko", "at": T + "11:30:00+09:00", "model": "cogentai-aas", "stale": False, "src": "1.2", "other": None,
                           "summary": {"one_line": "일정과 작업 기록을 모아 주간 보고서를 만든다",
                                       "use_when": ["금요일에 팀 주간 보고를 써야 할 때", "여러 채널의 진행 상황을 한 문서로 모을 때"],
                                       "what_it_does": ["Cron 작업 결과와 대화 기록을 읽는다", "항목별로 묶어 요약한다", "차트를 그려 보고서에 붙인다"],
                                       "strengths": ["손으로 모을 때보다 빠지는 항목이 적다", "매주 같은 형식으로 나온다"],
                                       "requires": ["chart MCP 서버", "api.example.com 에 닿는 네트워크"],
                                       "cautions": ["보고서 내용이 외부 API 로 전송된다"]}}
# 웹소켓이 없는 화면의 HTTP 갱신 확인(스펙 2026-10-17-004 R6 B·L8). 이 가짜 서버에는 /ws 가 없어 화면은 HTTP 다시 읽기로 내려간다.
#  POST /__mock/set {"/api/office/inbox": {...}, ...}  응답을 바꾼다(받은편지함·카드·회의가 다음 다시 읽기에 바뀌는지 본다)
#  GET  /__mock/log                                    오피스 대화 차례 묻기에 온 after 값과 동시에 걸린 최대 요청 수
#  오피스 대화: send 는 차례 하나를 만들고, turn 은 0.9초 늦게 조각을 하나씩 준다(앞 요청이 끝난 뒤에만 다음을 묻는지 본다)
TURN_ITEMS = [{"kind": "delta", "text": "안녕"}, {"kind": "delta", "text": "하세요"}, {"kind": "final", "text": "안녕하세요, 확인했습니다"}]
LOG = {"turn_after": [], "in_flight": 0, "most": 0}
D["/api/office/chat/history"] = {"messages": [], "turn": None}
# 입력창 「/」 스킬 목록(스펙 2026-10-19-012). 회의실은 참가자별 가진 스킬(agents)과 못 읽은 참가자(failed)
_SKILLS = [{"command": "/요약", "name": "요약", "description": "주간 업무를 표 한 장으로 요약합니다", "usage": 3},
           {"command": "/web-research", "name": "web-research", "description": "웹을 찾아 출처와 함께 정리합니다", "usage": 1}]
D["/api/chat/skills"] = {"profile": "ma", "skills": _SKILLS, "warning": ""}
D["/api/office/chat/skills"] = {"skills": _SKILLS, "warning": ""}
D["/api/office/meeting/skills"] = {"skills": [{**_SKILLS[0], "agents": ["ma"]}, {**_SKILLS[1], "agents": ["ma", "ops"]}], "members": ["ma", "ops"], "failed": []}
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, body, ctype):
        self.send_response(code); self.send_header("Content-Type", ctype); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0); raw = self.rfile.read(n)
        p = urllib.parse.urlparse(self.path).path
        if p == "/__mock/set":
            D.update(json.loads(raw or b"{}")); return self._send(200, b'{"ok":true}', "application/json")
        if p == "/api/office/chat/send":
            LOG["turn_after"].clear(); return self._send(202, b'{"turn":"run_mock"}', "application/json")
        self._send(200, json.dumps(D.get(p, {"ok": True, "ended": 1})).encode(), "application/json")
    def do_GET(self):
        p = urllib.parse.urlparse(self.path).path
        if p == "/__mock/log": return self._send(200, json.dumps(LOG).encode(), "application/json")
        if p == "/api/office/chat/turn":
            import time
            after = int((urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("after") or ["0"])[0])
            LOG["turn_after"].append(after); LOG["in_flight"] += 1; LOG["most"] = max(LOG["most"], LOG["in_flight"])
            time.sleep(0.9); LOG["in_flight"] -= 1
            items = TURN_ITEMS[after:after + 1]
            body = {"items": items, "next": after + len(items), "done": after + len(items) >= len(TURN_ITEMS), "status": "running"}
            return self._send(200, json.dumps(body, ensure_ascii=False).encode(), "application/json; charset=utf-8")
        if p == "/api/office/stream":                          # snapshot 한 번 보내고 연결을 열어 둔다
            self.send_response(200); self.send_header("Content-Type", "text/event-stream"); self.end_headers()
            data = json.dumps({"type": "snapshot", "payload": D["/api/office/state"]}, ensure_ascii=False)
            try:
                self.wfile.write(f"id: 1\ndata: {data}\n\n".encode()); self.wfile.flush()
                import time
                while True:
                    time.sleep(15); self.wfile.write(b": keepalive\n\n"); self.wfile.flush()
            except OSError:
                return
        if p == "/api/chat/files":                            # 문서 뷰어 시험(viewer-offline.mjs): parity/fixtures 의 표본을 내려준다(파일 이름만 본다)
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            name = os.path.basename((q.get("path") or [""])[0])
            f = next((os.path.join(d, name) for d in (FIXTURES, os.environ.get("VIEWER_EXTRA", "")) if d and os.path.isfile(os.path.join(d, name))), "")
            if not name or not f: return self._send(404, b'{"code":"not_found"}', "application/json")
            return self._send(200, open(f, "rb").read(), "application/octet-stream")
        if p in D: return self._send(200, json.dumps(D[p], ensure_ascii=False).encode(), "application/json; charset=utf-8")
        if p.startswith("/api/"): return self._send(404, b'{"error":"mock"}', "application/json")
        f = os.path.join(ROOT, p.lstrip("/")) if p != "/" else os.path.join(ROOT, "index.html")
        if not os.path.isfile(f): f = os.path.join(ROOT, "index.html")
        if not os.path.isfile(f): return self._send(404, b"not found", "text/plain")
        ct = {"js": "text/javascript", "mjs": "text/javascript", "wasm": "application/wasm", "css": "text/css", "html": "text/html; charset=utf-8",
              "svg": "image/svg+xml"}.get(f.rsplit(".", 1)[-1], "application/octet-stream")
        self._send(200, open(f, "rb").read(), ct)
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 17960
http.server.ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
