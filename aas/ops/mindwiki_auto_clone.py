# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""MindWiki 자동화가 고른 프로파일 T 의 자동화 전용 복제본(mwauto-<T>)의 상태와 설정 변환(스펙 2026-11-21-002 §3-2).

  상태    (파드, 복제본 이름) 한 줄: making(만드는 중, 만드는 서버 owner·heartbeat) | ready(다 만듦) | unsafe(안전하게 만들지 못함,
          until 까지 다시 복제하지 않는다). 프로세스 메모리가 아니라 DB 라 서버가 여럿이어도 같다. making 의 heartbeat 가 STALE 초
          넘게 멈추면 멈춘 복제로 보고, 조건부 UPDATE 에 성공한 서버 하나만 그 복제본을 지운다.
  설정    복제본 config.yaml = T 의 설정에서 ① 채널은 플랫폼마다 enabled: false(블록 안의 봇·허용 사용자 값은 버린다)
          ② mcp_servers 없음 ③ skills.write_approval: true(skill_manage 쓰기를 승인 대기로, 2026-11-21-003 §4 P9)
          ④ tools.tool_search.defer 에 DEFER_TOOLS(쓰지 않는 칸반 도구 · skill_manage, 2026-11-22-004 M9)
          ⑤ tool_search 끔 · MindWiki 도구 여덟 · 반복 실패 멈추기(M10, tune_tools — 연결 뒤에도 카드 때 맞춘다).
          Hermes 는 enabled: false 가 없으면 env 자격 값만으로 플랫폼을 켠다(hermes-agent gateway/config_env.py _enable_from_env).
  .env    복제본 config 의 모델·제공자 설정이 ${이름} 으로 부르는 키만 옮긴다. 채널 자격 키·MCP_ 키는 늘 뺀다.
  점검    unsafe_reasons: 켜진 채널·채널 자격 키·자동화 연결 없는 MCP 서버·MCP_ 키·write_approval 빠짐.
"""
from __future__ import annotations

import hashlib
import json
import re
import time

import yaml

from ..common import store

STALE = 600.0                    # making 의 heartbeat 가 이만큼 멈추면 멈춘 복제(10분)
UNSAFE_FOR = 3600.0              # 안전하지 않음을 기억하는 시간(1시간)

SCHEMA = """
CREATE TABLE IF NOT EXISTS mindwiki_auto_clone (
  pod TEXT NOT NULL, name TEXT NOT NULL, template TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'making',
  owner TEXT NOT NULL DEFAULT '', heartbeat REAL NOT NULL DEFAULT 0, until REAL NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT '',
  template_sha TEXT NOT NULL DEFAULT '', skills TEXT NOT NULL DEFAULT '[]', created REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (pod, name));
"""

# Hermes 채널 플러그인이 env 로 켜는 자격 키(hermes-agent plugins/platforms/*/gateway_env.py 의 ENV_ENABLE_CREDENTIALS, 2026-11-21 로컬 소스)
CHANNEL_ENV = {
    "telegram": ("TELEGRAM_BOT_TOKEN",), "discord": ("DISCORD_BOT_TOKEN",), "slack": ("SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"),
    "mattermost": ("MATTERMOST_TOKEN",), "matrix": ("MATRIX_ACCESS_TOKEN", "MATRIX_PASSWORD"), "signal": ("SIGNAL_HTTP_URL",),
    "whatsapp": ("WHATSAPP_ENABLED",), "whatsapp_cloud": ("WHATSAPP_CLOUD_PHONE_NUMBER_ID", "WHATSAPP_CLOUD_ACCESS_TOKEN"),
    "email": ("EMAIL_ADDRESS", "EMAIL_PASSWORD", "EMAIL_IMAP_HOST", "EMAIL_SMTP_HOST"), "sms": ("TWILIO_ACCOUNT_SID",),
    "dingtalk": ("DINGTALK_CLIENT_ID", "DINGTALK_CLIENT_SECRET"), "feishu": ("FEISHU_APP_ID", "FEISHU_APP_SECRET"),
    "wecom": ("WECOM_BOT_ID", "WECOM_SECRET", "WECOM_CALLBACK_CORP_ID", "WECOM_CALLBACK_CORP_SECRET"),
    "weixin": ("WEIXIN_TOKEN", "WEIXIN_ACCOUNT_ID"), "qqbot": ("QQ_APP_ID", "QQ_CLIENT_SECRET"), "yuanbao": ("YUANBAO_APP_ID", "YUANBAO_APP_SECRET"),
    "bluebubbles": ("BLUEBUBBLES_SERVER_URL", "BLUEBUBBLES_PASSWORD"),
}
CHANNEL_KEYS = frozenset(k for keys in CHANNEL_ENV.values() for k in keys)
# config.yaml 의 채널 블록: platforms(플랫폼마다) 와 옛 최상위 블록(owner_guard._CHANNEL_BLOCKS 와 같은 이름)
_TOP_CHANNEL_BLOCKS = ("discord", "matrix", "mattermost", "telegram", "slack", "whatsapp", "signal", "email")
_MODEL_TOP = ("model", "providers", "custom_providers", "fallback_providers", "auxiliary")   # .env 허용 키를 찾는 자리
_VAR = re.compile(r"\$\{([A-Z][A-Z0-9_]{1,63})\}")
_ENV_KEY = re.compile(r"^[A-Z][A-Z0-9_]{1,63}$")


def now() -> float:
    """모든 시각 비교의 한 곳. 시험은 이것을 바꿔 넣는다."""
    return time.time()


def _conn():
    conn = store.connect()
    conn.executescript(SCHEMA)
    return conn


# ---- 상태 ---------------------------------------------------------------------------------------------------------------

def get(pod: str, name: str) -> dict | None:
    with _conn() as conn:
        r = conn.execute("SELECT * FROM mindwiki_auto_clone WHERE pod=? AND name=?", (pod, name)).fetchone()
    return dict(r) if r else None


def making(pod: str) -> list[str]:
    """그 파드에서 만드는 중(멈추지 않은)인 복제본 이름 — 3개 상한을 셀 때 함께 센다."""
    with _conn() as conn:
        return [r["name"] for r in conn.execute("SELECT name FROM mindwiki_auto_clone WHERE pod=? AND status='making' AND heartbeat>=?",
                                                (pod, now() - STALE))]


def unsafe(row: dict | None) -> bool:
    return bool(row) and row["status"] == "unsafe" and float(row["until"] or 0) > now()


def fresh_making(row: dict | None) -> bool:
    return bool(row) and row["status"] == "making" and float(row["heartbeat"] or 0) >= now() - STALE


def stale_making(row: dict | None) -> bool:
    return bool(row) and row["status"] == "making" and float(row["heartbeat"] or 0) < now() - STALE


def claim(pod: str, name: str, template: str, owner: str) -> bool:
    """만들기를 맡는다(making). 줄이 없거나, ready(사람이 복제본을 지워 다시 만든다, D4) 또는 기한이 지난 unsafe 면 맡는다."""
    t = now()
    with _conn() as conn:
        conn.execute("INSERT INTO mindwiki_auto_clone (pod, name, template, status, owner, heartbeat, created) VALUES (?,?,?,'making',?,?,?) "
                     "ON CONFLICT (pod, name) DO NOTHING", (pod, name, template, owner, t, t))
        n = conn.execute("UPDATE mindwiki_auto_clone SET status='making', template=?, owner=?, heartbeat=?, until=0, reason='', created=? "
                         "WHERE pod=? AND name=? AND (owner=? AND status='making' OR status='ready' OR status='unsafe' AND until<=?)",
                         (template, owner, t, t, pod, name, owner, t)).rowcount
    return n == 1


def beat(pod: str, name: str, owner: str) -> bool:
    with _conn() as conn:
        return conn.execute("UPDATE mindwiki_auto_clone SET heartbeat=? WHERE pod=? AND name=? AND owner=? AND status='making'",
                            (now(), pod, name, owner)).rowcount == 1


def take_stale(pod: str, name: str, owner: str) -> bool:
    """멈춘 복제를 정리할 서버 하나를 고른다(조건부 UPDATE). 성공한 서버만 복제본을 지운다."""
    t = now()
    with _conn() as conn:
        return conn.execute("UPDATE mindwiki_auto_clone SET owner=?, heartbeat=? WHERE pod=? AND name=? AND status='making' AND heartbeat<?",
                            (owner, t, pod, name, t - STALE)).rowcount == 1


def ready(pod: str, name: str, owner: str, template_sha: str, skills: list[str]) -> bool:
    with _conn() as conn:
        return conn.execute("UPDATE mindwiki_auto_clone SET status='ready', template_sha=?, skills=?, heartbeat=? "
                            "WHERE pod=? AND name=? AND owner=? AND status='making'",
                            (template_sha, json.dumps(sorted(skills)), now(), pod, name, owner)).rowcount == 1


def mark_unsafe(pod: str, name: str, reason: str) -> None:
    t = now()
    with _conn() as conn:
        conn.execute("INSERT INTO mindwiki_auto_clone (pod, name, status, until, reason, created) VALUES (?,?,'unsafe',?,?,?) "
                     "ON CONFLICT (pod, name) DO UPDATE SET status='unsafe', until=excluded.until, reason=excluded.reason, owner=''",
                     (pod, name, t + UNSAFE_FOR, reason[:120], t))


def drop(pod: str, name: str, owner: str | None = None) -> None:
    """줄을 지운다(만들기를 시작하지 못함 — 다음 웹훅이 다시 한다). owner 를 주면 그 서버가 맡은 줄만."""
    with _conn() as conn:
        if owner is None:
            conn.execute("DELETE FROM mindwiki_auto_clone WHERE pod=? AND name=?", (pod, name))
        else:
            conn.execute("DELETE FROM mindwiki_auto_clone WHERE pod=? AND name=? AND owner=?", (pod, name, owner))


def skills_of(row: dict | None) -> list[str]:
    try:
        got = json.loads((row or {}).get("skills") or "[]")
    except ValueError:
        return []
    return [str(s) for s in got if isinstance(s, str)]


# ---- 설정 변환 -------------------------------------------------------------------------------------------------------

def _load(text: str) -> dict:
    try:
        cfg = yaml.safe_load(text or "")
    except yaml.YAMLError as exc:
        raise ValueError(f"config.yaml parse: {exc}") from exc       # i18n-ignore: 서버 로그로만 가는 이유
    if cfg is None:
        return {}
    if not isinstance(cfg, dict):
        raise ValueError("config.yaml is not a mapping")              # i18n-ignore: 서버 로그로만 가는 이유
    return cfg


def sha(text: str) -> str:
    return hashlib.sha256((text or "").encode()).hexdigest()


def channel_platforms(cfg: dict, env_names: set[str] | frozenset = frozenset()) -> set[str]:
    """설정·.env 로 켜질 수 있는 채널 플랫폼 이름들."""
    out = set()
    plats = cfg.get("platforms")
    if isinstance(plats, dict):
        out |= {str(p) for p in plats if p in CHANNEL_ENV}
    out |= {b for b in _TOP_CHANNEL_BLOCKS if b in cfg}
    out |= {p for p, keys in CHANNEL_ENV.items() if any(k in env_names for k in keys)}
    return out


# 칸반 작업자에게 Hermes 가 늘 통째로 붙이는 kanban 묶음 가운데 자동화 카드가 쓰지 않는 도구와 skill_manage(복제본 카드 규칙이
# 금지)를 「필요할 때 불러오기」(tools.tool_search.defer)로 돌린다 — 정의가 호출마다 실리지 않는다(스펙 AAS 2026-11-22-004 M9).
# kanban_show · kanban_complete · kanban_block · kanban_heartbeat 는 카드를 읽고 끝내는 데 쓰므로 그대로 둔다. 미룬 도구도
# tool_search 로 찾아 부를 수 있어 막히지는 않는다. Hermes 는 defer 목록을 기본 목록 대신 통째로 쓰므로 있던 목록에 더한다.
DEFER_TOOLS = ("kanban_create", "kanban_request_review", "kanban_request_changes", "kanban_comment", "kanban_link",
               "kanban_attach", "kanban_attach_url", "kanban_attachments", "kanban_list", "kanban_unblock", "skill_manage")


def with_deferred_tools(cfg: dict) -> bool:
    """cfg 의 tools.tool_search.defer 에 DEFER_TOOLS 를 더한다(있던 이름 · 순서는 둠). 바꿨으면 True."""
    tools = cfg.get("tools") if isinstance(cfg.get("tools"), dict) else {}
    search = tools.get("tool_search") if isinstance(tools.get("tool_search"), dict) else {}
    have = [str(n) for n in search.get("defer") or []] if isinstance(search.get("defer"), list) else []
    missing = [n for n in DEFER_TOOLS if n not in have]
    if not missing:
        return False
    search["defer"] = have + missing
    tools["tool_search"] = search
    cfg["tools"] = tools
    return True


# 복제본은 MindWiki 도구를 처음부터 싣는다(스펙 AAS 2026-11-22-004 M10, 사용자 요청 2026-11-22). Hermes 는 MCP 도구를 늘 미뤄
# tool_call 로만 부르게 하는데, 긴 JSON 을 감싸 넘기다 자주 깨졌다(본문 없이 「검토 중」, 같은 거절 34번). MCP 서버 단위로 미루지 않는
# 설정이 없어 tool_search 를 끄고, 늘어나는 정의를 줄이려고 MindWiki 연결의 도구를 자동화 행 작업에 쓰는 여덟로 좁힌다(정의 약 7천 자).
# tool_search 를 끄면 위의 DEFER_TOOLS 는 효과가 없다(미룰 다리가 없다) — 스위치를 끄면 다시 쓰인다. 끄기: AAS_MINDWIKI_CLONE_EAGER_TOOLS=0
# prepare_context: 자동화 실행의 레시피(함께 보낼 자료)를 위키가 한 번에 모아 돌려준다(스펙 AAS 2026-11-23-003 Q7 · P3). 모델 호출을 줄이는 도구라
# 처음부터 싣는다. 위키에 아직 이 도구가 없으면 Hermes 가 include 의 없는 이름을 건너뛴다.
# create_row: 「추가로 쓸 데이터베이스」가 있는 실행만 그 데이터베이스에 행 하나를 만든다(위키 스펙 2026-11-24-006, 스펙 2026-11-24-002). 목록에
# 없으면 Hermes 가 create_row 를 update_row 로 「고쳐」 불러 세 번 실패하고 가드레일이 멈췄다(2026-11-24 OKE 시험 카드). 다른 실행에는 위키가 거절한다
CLONE_MINDWIKI_TOOLS = ("query_database", "read_page", "search_pages", "read_page_blocks", "update_row", "edit_block", "append_to_page",
                        "suggest_edit", "prepare_context", "create_row")
MINDWIKI_SERVER = "cogentai-mindwiki"
# 같은 도구 실패가 이어지면 멈춘다. 칸반 작업자는 플랫폼이 cli 로 잡혀 Hermes 기본값이 경고만 한다(2026-11-22 OKE: 같은 거절 34번).
GUARDRAILS = {"hard_stop_enabled": True, "hard_stop_after": {"exact_failure": 3, "same_tool_failure": 5, "idempotent_no_progress": 3}}


def eager_tools() -> bool:
    import os
    return os.environ.get("AAS_MINDWIKI_CLONE_EAGER_TOOLS", "1").strip().lower() not in ("0", "false", "no", "off")


def _set(parent: dict, key: str, value) -> bool:
    if parent.get(key) == value:
        return False
    parent[key] = value
    return True


def _dict(parent: dict, key: str) -> dict:
    if not isinstance(parent.get(key), dict):
        parent[key] = {}
    return parent[key]


def tune_tools(cfg: dict) -> bool:
    """복제본 설정의 도구 몫을 맞춘다: 칸반 도구 미루기(M9) · MindWiki 도구 처음부터 싣기와 여덟으로 좁히기(M10) · 반복 실패 멈추기.
    바꿨으면 True. MindWiki 서버 항목은 연결한 뒤에만 있다(복제할 때는 없다)."""
    changed = with_deferred_tools(cfg)
    if not eager_tools():
        return changed
    changed |= _set(_dict(_dict(cfg, "tools"), "tool_search"), "enabled", "off")
    servers = cfg.get("mcp_servers") if isinstance(cfg.get("mcp_servers"), dict) else {}
    if isinstance(servers.get(MINDWIKI_SERVER), dict):
        changed |= _set(_dict(servers[MINDWIKI_SERVER], "tools"), "include", list(CLONE_MINDWIKI_TOOLS))
    guard = _dict(cfg, "tool_loop_guardrails")
    changed |= _set(guard, "hard_stop_enabled", True)
    after = _dict(guard, "hard_stop_after")
    for k, v in GUARDRAILS["hard_stop_after"].items():
        changed |= _set(after, k, v)
    return changed


def tuned_config(cfg_text: str) -> str | None:
    """이미 만든 복제본의 config.yaml 을 tune_tools 로 맞춘 글, 이미 맞으면 None."""
    cfg = _load(cfg_text)
    if not tune_tools(cfg):
        return None
    return yaml.safe_dump(cfg, allow_unicode=True, sort_keys=False, default_flow_style=False)


def clone_config(src_text: str, env_names: set[str] | frozenset = frozenset()) -> str:
    """T 의 config.yaml 에서 복제본 설정을 만든다(모듈 머리말 「설정」). 모델·제공자·그 밖 키는 그대로 둔다."""
    cfg = _load(src_text)
    platforms = channel_platforms(cfg, env_names)
    for block in _TOP_CHANNEL_BLOCKS:
        cfg.pop(block, None)
    plats = cfg.get("platforms") if isinstance(cfg.get("platforms"), dict) else {}
    kept = {p: v for p, v in plats.items() if p not in CHANNEL_ENV and not isinstance(v, dict)}   # 채널이 아닌 값(목록 등)은 그대로
    for p, v in plats.items():
        if p not in CHANNEL_ENV and isinstance(v, dict):
            kept[p] = {"enabled": False}                             # 모르는 플랫폼도 켜지 않는다 — 자동화 프로파일은 메신저를 쓰지 않는다
    for p in sorted(platforms):
        kept[p] = {"enabled": False}
    if kept:
        cfg["platforms"] = kept
    else:
        cfg.pop("platforms", None)
    cfg.pop("mcp_servers", None)
    skills = dict(cfg.get("skills")) if isinstance(cfg.get("skills"), dict) else {}
    skills["write_approval"] = True
    cfg["skills"] = skills
    tune_tools(cfg)
    return yaml.safe_dump(cfg, allow_unicode=True, sort_keys=False, default_flow_style=False)


def _strings(node):
    if isinstance(node, str):
        yield node
    elif isinstance(node, dict):
        for k, v in node.items():
            yield from _strings(v)
            if isinstance(k, str) and k.endswith("_env") and isinstance(v, str):
                yield "${" + v + "}"
    elif isinstance(node, list):
        for v in node:
            yield from _strings(v)


def env_allowed(cfg_text: str) -> set[str]:
    """복제본 .env 에 옮길 키: 모델·제공자 설정이 ${이름}(또는 *_env: 이름)으로 부르는 키. 채널 자격 키·MCP_ 키는 늘 뺀다."""
    cfg = _load(cfg_text)
    names: set[str] = set()
    for top in _MODEL_TOP:
        for s in _strings(cfg.get(top)):
            names |= set(_VAR.findall(s))
    return {n for n in names if n not in CHANNEL_KEYS and not n.startswith("MCP_")}


def parse_env(text: str) -> dict[str, str]:
    """.env 글 → {키: 값}. 따옴표 한 겹은 벗긴다. 주석·빈 줄·이상한 줄은 버린다."""
    out: dict[str, str] = {}
    for line in (text or "").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key.startswith("export "):
            key = key[7:].strip()
        if not _ENV_KEY.match(key):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        out[key] = value
    return out


def unsafe_reasons(cfg_text: str, env_names: set[str], *, mindwiki_ok: bool, mindwiki_server: str, mindwiki_key: str) -> list[str]:
    """복제본을 카드에 써도 되는가 — 안 되면 이유 목록(쓸 때 점검 ②, 스펙 2026-11-21-002 엔지니어링 재검토 「채널 점검 기준」).
    mindwiki_ok: 그 (작성자, 파드, 복제본)의 자동화 전용 연결 행이 있어 MindWiki MCP 서버와 그 키를 받아도 되는가."""
    try:
        cfg = _load(cfg_text)
    except ValueError:
        return ["config_unreadable"]
    out = []
    plats = cfg.get("platforms") if isinstance(cfg.get("platforms"), dict) else {}
    if any(b in cfg for b in _TOP_CHANNEL_BLOCKS):
        out.append("channel_block")
    for p, v in plats.items():
        if isinstance(v, dict) and v.get("enabled") is not False:
            out.append(f"channel_on:{p}")
    if any(k in env_names for k in CHANNEL_KEYS):
        out.append("channel_env")
    servers = cfg.get("mcp_servers") if isinstance(cfg.get("mcp_servers"), dict) else {}
    extra = sorted(s for s in servers if not (mindwiki_ok and s == mindwiki_server))
    if extra:
        out.append("mcp_server:" + ",".join(extra))
    keys = sorted(k for k in env_names if k.startswith("MCP_") and not (mindwiki_ok and k == mindwiki_key))
    if keys:
        out.append("mcp_env:" + ",".join(keys))                      # 키 이름만 — 값은 남기지 않는다
    skills = cfg.get("skills") if isinstance(cfg.get("skills"), dict) else {}
    if skills.get("write_approval") is not True:
        out.append("write_approval")
    return out
