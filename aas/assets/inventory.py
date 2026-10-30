# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""자격증명·도구·라이브러리 목록 — 무엇이 어디에(전역/프로파일) 있고 누가 쓰는지.

전부 읽기 전용이다. 자격증명은 **값을 내보내지 않는다**: 이름, 위치, 채워져 있는지, (JWT 면) 만료일,
같은 값이 여러 곳에 있는지(그룹 번호만)만 알려 준다. 값은 이 판단을 하는 동안 메모리에서만 쓴다.
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path

from ..common import config
from ..hermes import hermes_reader as hr
from ..hermes.readers import remote, secret_scrub
from . import skill_graph
from ..common import store
from ..common.i18n import tr
from ..common.redact import clean_url, mcp_target

_log = logging.getLogger(__name__)
GLOBAL = "전역"      # i18n-ignore: UI 가 맞대어 보는 값
PROFILE = "프로파일"  # i18n-ignore: UI 가 맞대어 보는 값
SCRIPT_EXT = {".py": "Python", ".sh": "Shell", ".js": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
              ".ts": "TypeScript"}
MAX_READ = 300_000
_SECRET_KEY = re.compile(r"key|token|secret|password|passwd|authorization|credential|private|webhook|cookie", re.I)
_ENV_LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$")
_TOKEN = re.compile(r"\b[A-Z][A-Z0-9_]{3,}\b")
_JWT = re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.([A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{4,}")
_STDLIB = set(getattr(sys, "stdlib_module_names", ()))

# 이름으로 어떤 인터페이스의 인증값인지 가늠한다(위에서부터 먼저 맞는 것). 부르는 때에 언어가 정해지도록 함수로 둔다.
def _interfaces() -> list[tuple[str, str]]:
    return [
        (r"^(TELEGRAM|SLACK|DISCORD|MATTERMOST|WHATSAPP|SIGNAL|BUZZ|MATRIX)_", tr("채널", "Channel")),
        (r"WEBHOOK", tr("웹훅(REST)", "Webhook (REST)")),
        (r"^(API_SERVER|HERMES_DASHBOARD|DASHBOARD)", tr("Hermes API·WebSocket", "Hermes API·WebSocket")),
        (r"MCP", "MCP"),
        (r"(LITELLM|OPENAI|ANTHROPIC|OPENROUTER|GEMINI|LLM|MODEL)", "LLM"),
        (r"(GOOGLE|GA4|GSC|GMAIL|YOUTUBE)", tr("REST API(구글)", "REST API (Google)")),
    ]


def _iface(name: str) -> str:
    for pat, label in _interfaces():
        if re.search(pat, name, re.I):
            return label
    return "REST API"


def _read(path: Path) -> str:
    try:
        if path.stat().st_size > MAX_READ:
            return ""
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def _read_many(paths: list) -> list[str]:
    """_read 를 여러 파일에 한다. 사이드카로 읽는 경로(RemotePath)는 요청을 묶는다."""
    from ..hermes.readers import remote
    if paths and all(isinstance(p, remote.RemotePath) for p in paths):
        ok = []
        for p in paths:
            try:
                ok.append(p.stat().st_size <= MAX_READ)
            except OSError:
                ok.append(False)
        texts = iter(remote.read_texts([p for p, keep in zip(paths, ok) if keep]))
        return [next(texts) if keep else "" for keep in ok]
    return [_read(p) for p in paths]


def _mtime(path: Path) -> str | None:
    try:
        return datetime.fromtimestamp(path.stat().st_mtime).astimezone().isoformat(timespec="minutes")
    except OSError:
        return None


def _jwt_exp(value: str) -> str | None:
    exp = secret_scrub.token_exp(value)                       # 쿠버네티스: 받는 자리에서 원문 대신 남긴 토큰(스펙 2026-10-19-015 A1)
    if exp is not None:
        return datetime.fromtimestamp(exp).astimezone().isoformat(timespec="minutes")
    m = _JWT.search(value or "")
    if not m:
        return None
    try:
        payload = json.loads(base64.urlsafe_b64decode(m.group(1) + "=" * (-len(m.group(1)) % 4)))
        return datetime.fromtimestamp(float(payload["exp"])).astimezone().isoformat(timespec="minutes")
    except Exception:
        return None


class _Share:
    """같은 값이 여러 곳에 있는지 본다. 값·해시는 밖으로 나가지 않고 그룹 번호만 나간다."""

    def __init__(self):
        self._seen: dict[str, list[dict]] = {}

    def add(self, item: dict, value: str) -> None:
        if value and (len(value) >= 8 or secret_scrub.is_token(value)):
            # 원문·토큰을 같은 지문으로 — `.env`(토큰)와 config.yaml(원문)의 같은 값도 한 묶음이 된다(A1)
            self._seen.setdefault(secret_scrub.digest(value), []).append(item)

    def finish(self) -> None:
        n = 0
        for items in self._seen.values():
            places = {(i["scope"], i["profile"], i["name"]) for i in items}
            if len(places) > 1:
                n += 1
                for i in items:
                    i["shared_group"] = n
                    i["shared_with"] = len(places)


def _env_file(path: Path) -> list[tuple[str, str]]:
    out = []
    for line in _read(path).splitlines():
        if line.lstrip().startswith("#"):
            continue
        m = _ENV_LINE.match(line)
        if m:
            out.append((m.group(1), m.group(2).strip().strip("\"'")))
    return out


def _walk_secret_values(obj, prefix=""):
    """(키 경로, 값) — 비밀로 보이는 문자열 값만."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            path = f"{prefix}.{k}" if prefix else str(k)
            if isinstance(v, (dict, list)):
                yield from _walk_secret_values(v, path)
            elif isinstance(v, str) and (_SECRET_KEY.search(str(k)) or _JWT.search(v) or secret_scrub.is_jwt_token(v)):
                yield path, v
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from _walk_secret_values(v, f"{prefix}[{i}]")


def _usage_index(home: Path) -> dict[str, set[str]]:
    """대문자 토큰 → 그 토큰을 언급하는 스킬·스크립트 이름. 자격증명 이름이 어디서 쓰이는지 찾는 데 쓴다."""
    index: dict[str, set[str]] = {}

    def feed(label: str, text: str):
        for tok in set(_TOKEN.findall(text)):
            index.setdefault(tok, set()).add(label)

    skills = [(md, [p for p in md.parent.rglob("*") if p.is_file() and p.suffix in (".md", ".py", ".sh", ".js")]) for prof, md in hr.skill_files(home)]
    scripts = []
    for prof in hr.profiles(home):
        d = prof.path / "scripts"
        if d.is_dir():
            scripts += [p for p in d.iterdir() if p.is_file() and p.suffix in SCRIPT_EXT]
    texts = iter(_read_many([p for _, files in skills for p in files] + scripts))      # 원격이면 파일마다 왕복하지 않고 묶어서 읽는다
    for md, files in skills:
        feed(tr(f"스킬 {md.parent.name}", f"Skill {md.parent.name}"), "\n".join(next(texts) for _ in files))
    for p in scripts:
        feed(tr(f"스크립트 {p.name}", f"Script {p.name}"), next(texts))
    return index


_PROFILE_SECRETS = re.compile(r"profiles/([^/]+)/secrets/$")


def _refers_to(text: str, fname: str, profile: str, owner: str) -> bool:
    """text 가 profile("" = 루트)의 secrets/fname 을 가리키는가. owner 는 text 를 가진 프로파일.

    `profiles/<p>/secrets/` 가 앞에 있으면 그 프로파일, 다른 절대경로면 루트, 이름만 있거나 상대·변수 경로면
    (HERMES_HOME 기준이므로) text 를 가진 프로파일의 것으로 본다. `omdm.json` 이 `omdm.json.bak-…` 안에서
    맞는 것도 막는다.
    """
    if fname not in text:
        return False
    pat = re.compile(r"(?<![\w.-])((?:[\w./$%{}~-]*/)?)" + re.escape(fname) + r"(?![\w-]|\.\w)")
    for m in pat.finditer(text):
        pre = m.group(1)
        p = _PROFILE_SECRETS.search(pre)
        target = p.group(1) if p else ("" if pre.startswith("/") else owner)
        if target == profile:
            return True
    return False


# AAS 가 모든 프로파일 config.yaml 의 providers 에 넣는 LiteLLM 키 참조(스펙 2026-10-28-006 H1). 실제 키는 파드 환경변수로 들어온다.
# 같은 글자를 쓰는 곳: 오퍼레이터 config/samples/hermes-seed.yaml, COP 차트 namespace-agents.yaml hermes-seed,
# deploy/compose/hermes-config.seed.yaml, aas/hermes/stt_config.py — 레포 안의 둘은 시험이 이 상수와 같은지 본다.
AAS_LLM_KEY_REF = "${HERMES_LLM_API_KEY}"
_ANONYMOUS = "anonymous"
_AUTH_KNOWN_KEYS = frozenset({"version", "providers", "credential_pool", "updated_at", "active_provider"})


def _auth_kind(data, providers) -> str:
    """auth.json 이 누구 것인가: "derived"(config.yaml providers 에서 Hermes 가 만든 사본뿐), "anonymous"(Hermes 가 스스로 만든
    Nous 익명 로그인과 사본뿐), "user"(그 밖 — 사람이 로그인했거나 넣은 것). 사이드카 경유면 값이 토큰이라 글자가 아니라
    `secret_scrub.digest` 로 견준다(같은 프로세스 지문, 리뷰 R1). 키(제공자 이름)는 토큰으로 바뀌지 않는다."""
    if not isinstance(data, dict) or any(v for k, v in data.items() if k not in _AUTH_KNOWN_KEYS):
        return "user"                                            # 모르는 모양이면 보인다
    made = {secret_scrub.digest(f"config:{n}") for n in providers}
    kind = "derived"
    pool = data.get("credential_pool") or {}
    if not isinstance(pool, dict):
        return "user"
    for entries in pool.values():
        for e in entries if isinstance(entries, list) else [entries]:
            src = e.get("source") if isinstance(e, dict) else None
            if not (isinstance(src, str) and src and secret_scrub.digest(src) in made):
                return "user"
    provs = data.get("providers") or {}
    if not isinstance(provs, dict):
        return "user"
    for state in provs.values():
        method = state.get("auth_method") if isinstance(state, dict) else None
        if not (isinstance(method, str) and method and secret_scrub.digest(method) == secret_scrub.digest(_ANONYMOUS)):
            return "user"
        kind = "anonymous"
    return kind


def credentials(home: Path | None = None) -> dict:
    home = home or hr.hermes_home()
    remote.prefetch(home)                                     # 원격이면 묶음을 먼저 받고, 같은 묶음 안에서는 한 번만 만든다(OMAI-1102)
    return remote.memo(home, "credentials", lambda: _credentials(home))


def _credentials(home) -> dict:
    items: list[dict] = []
    share = _Share()
    usage = _usage_index(home)
    src_secrets = tr("secrets 파일", "secrets file")
    # AAS 가 넣는 기본 값은 표에서 뺀다 — 같은 값 묶음·합계에도 들지 않게 share.add 전에 거른다(스펙 2026-10-28-006 R3)
    hidden: dict[str, int] = {}
    hidden_kinds: set[str] = set()
    from ..ops import models
    llm_key = models.server_llm_key()[0]
    llm_fp = secret_scrub.digest(llm_key) if llm_key else None

    def hide(profile: str, kind: str) -> None:
        hidden[profile] = hidden.get(profile, 0) + 1
        hidden_kinds.add(kind)

    def add(name, scope, profile, source, location, value, iface=None, extra=None):
        item = {"id": f"{scope}:{profile}:{location}:{name}", "name": name, "scope": scope, "profile": profile,
                "source": source, "location": location, "interface": iface or _iface(name),
                "set": bool(value), "expires": _jwt_exp(value), "shared_group": None, "shared_with": 0,
                "used_by": sorted(usage.get(name, ()))[:12], "used_count": len(usage.get(name, ())), "flags": []}
        if extra:
            item.update(extra)
        share.add(item, value)
        items.append(item)
        return item

    compose_env = config.compose_env_file()
    if compose_env and compose_env.is_file():
        for name, value in _env_file(compose_env):
            if _SECRET_KEY.search(name):
                hide("", "compose_env")                         # AAS 운영 값(관리자 비밀번호·사이드카 토큰 등) — 이 화면에서 바꿀 수 없다(D3)
    import yaml
    for prof in hr.profiles(home):
        scope, pname = (GLOBAL, "") if prof.name == "default" else (PROFILE, prof.name)
        base = "" if prof.name == "default" else f"profiles/{prof.name}/"
        env = prof.path / ".env"
        for name, value in _env_file(env):
            if _SECRET_KEY.search(name):
                if name == "HERMES_LLM_API_KEY" and llm_fp and value and secret_scrub.digest(value) == llm_fp:
                    hide(pname, "llm_default")                  # AAS 가 넣은 LiteLLM 키 그대로(R10). 사용자가 바꿨으면 보인다
                    continue
                add(name, scope, pname, ".env", base + ".env", value, extra={"modified": _mtime(env)})
        cfg_path = prof.path / "config.yaml"
        try:
            cfg = yaml.safe_load(_read(cfg_path)) or {}
        except Exception:
            cfg = {}
        if not isinstance(cfg, dict):                         # 깨진 설정 한 개가 자격증명 표와 흐름 그림(flow.build)을 깨뜨리지 않게 모양을 확인한다(OMAI-1249)
            cfg = {}
        mcp = cfg.get("mcp_servers")
        for server, sect in (mcp if isinstance(mcp, dict) else {}).items():
            if not isinstance(sect, dict):
                continue
            env, headers = sect.get("env"), sect.get("headers")
            for key, value in {**(env if isinstance(env, dict) else {}), **(headers if isinstance(headers, dict) else {})}.items():
                if isinstance(value, str) and (_SECRET_KEY.search(str(key)) or _JWT.search(value) or str(key).endswith("_CONFIG")):
                    add(str(key), scope, pname, "config.yaml › mcp_servers", f"{base}config.yaml › mcp_servers.{server}",
                        value, iface=f"MCP: {server}", extra={"modified": _mtime(cfg_path)})
            if str(sect.get("auth") or "").lower() == "oauth":
                # OAuth 서버의 토큰(스펙 2026-10-16-010 T7): 파일이 있는지와 수정 시각만 본다. 토큰·만료 시각은 파일 안에 있어 읽지 않는다(D29·6절)
                tok = prof.path / "mcp-tokens" / f"{server}.json"
                have = tok.is_file()
                item = add(f"{server} (OAuth)", scope, pname, tr("MCP OAuth 토큰", "MCP OAuth token"), f"{base}mcp-tokens/{server}.json",
                           f"oauth:{base}{server}" if have else "", iface=f"MCP: {server}",
                           extra={"modified": _mtime(tok) if have else None, "oauth": True})
                if not have:
                    item["flags"].append("로그인 필요")  # i18n-ignore: UI 가 맞대어 보는 값
        providers = cfg.get("providers")
        for pname2, sect in (providers if isinstance(providers, dict) else {}).items():
            if isinstance(sect, dict) and sect.get("api_key"):
                if str(sect["api_key"]).strip() == AAS_LLM_KEY_REF:
                    hide(pname, "llm_default")                  # AAS 시드가 넣은 참조(H1). 글자 그대로 적은 키는 보인다
                    continue
                add("api_key", scope, pname, "config.yaml › providers", f"{base}config.yaml › providers.{pname2}",
                    str(sect["api_key"]), iface=f"LLM: {pname2}",
                    extra={"modified": _mtime(cfg_path), "target": clean_url(str(sect.get("base_url") or ""))})
        for d in (prof.path / "secrets",):
            if not d.is_dir():
                continue
            for f in sorted(d.iterdir()):
                if not f.is_file():
                    continue
                flags = []
                if re.search(r"\.bak|\.pending|\.example|\.old", f.name):
                    flags.append("백업·임시 파일")  # i18n-ignore: 다른 모듈과 UI 가 맞대어 보는 값
                try:
                    data = json.loads(_read(f)) if f.suffix == ".json" or ".json." in f.name else {}
                except ValueError:
                    data = {}
                secrets_in = list(_walk_secret_values(data))
                exps = sorted(e for e in (_jwt_exp(v) for _, v in secrets_in) if e)
                target = ""
                if isinstance(data, dict):
                    target = clean_url(str(data.get("base_url") or data.get("url") or "")) if (data.get("base_url") or data.get("url")) else ""
                item = add(f.name, scope, pname, src_secrets, f"{base}secrets/{f.name}",
                           "|".join(v for _, v in secrets_in),
                           iface=tr("MCP·REST (설정 파일)", "MCP·REST (config file)") if "omdm" in f.name or "docmost" in f.name
                           else tr("REST API (설정 파일)", "REST API (config file)"),
                           extra={"modified": _mtime(f), "keys": [k for k, _ in secrets_in][:8], "target": target})
                item["expires"] = exps[0] if exps else None
                item["flags"] += flags
                item["_fname"] = f.name
        google = tr("REST API(구글)", "REST API (Google)")
        for fname, iface in (("auth.json", tr("LLM (자격증명 풀)", "LLM (credential pool)")), ("google_token.json", google),
                             ("google_client_secret.json", google)):
            f = prof.path / fname
            if f.is_file():
                if fname == "auth.json":
                    try:
                        auth = json.loads(_read(f) or "null")
                    except ValueError:
                        auth = None                              # 읽지 못하면 지금처럼 보인다
                    kind = _auth_kind(auth, providers if isinstance(providers, dict) else {}) if auth is not None else "user"
                    if kind != "user":
                        hide(pname, "auth_" + kind)              # 설정 사본·Nous 익명 로그인뿐(H2)
                        continue
                add(fname, scope, pname, tr("파일", "File"), base + fname, hashlib.sha256(f.read_bytes()).hexdigest(), iface=iface,
                    extra={"modified": _mtime(f)})
    share.finish()

    # secrets 파일은 경로로 참조된다 — 같은 이름이 루트와 프로파일에 따로 있으므로 이름만 보면
    # 프로파일 사본이 루트 정본의 참조를 물려받는다(만료된 사본이 「쓰는 곳 90」 으로 보이던 원인).
    file_items = [i for i in items if i.get("_fname")]
    if file_items:
        texts: list[tuple[str, str, str]] = []
        for prof, md in hr.skill_files(home):
            texts.append(("" if prof == "default" else prof, tr(f"스킬 {md.parent.name}", f"Skill {md.parent.name}"),
                          "\n".join(_read(p) for p in md.parent.rglob("*") if p.is_file() and p.suffix in (".md", ".py", ".sh", ".js"))))
        for prof in hr.profiles(home):
            d = prof.path / "scripts"
            if d.is_dir():
                texts += [("" if prof.name == "default" else prof.name, tr(f"스크립트 {p.name}", f"Script {p.name}"), _read(p))
                          for p in d.iterdir() if p.is_file() and p.suffix in SCRIPT_EXT]
        for i in file_items:
            users = sorted({label for owner, label, text in texts if _refers_to(text, i["_fname"], i["profile"], owner)})
            i["used_by"], i["used_count"] = users[:12], len(users)
            del i["_fname"]

    now = datetime.now().astimezone()
    for i in items:
        if not i["set"] and not i.get("oauth"):                   # OAuth 토큰은 「로그인 필요」로 따로 알린다
            i["flags"].append("비어 있음")  # i18n-ignore: UI 가 맞대어 보는 값
        if i["expires"]:
            days = (hr.parse_ts(i["expires"]) - now).days
            i["expires_in_days"] = days
            if days < 0:
                i["flags"].append("만료됨")  # i18n-ignore: UI 가 맞대어 보는 값
            elif days <= 14:
                i["flags"].append(f"{days}일 뒤 만료")  # i18n-ignore: 다른 모듈과 UI 가 맞대어 보는 값
        if i["shared_with"] > 1:
            i["flags"].append(f"같은 값이 {i['shared_with']}곳에")  # i18n-ignore: 플래그 문구는 한국어로 고정(맞대어 보는 값과 한 묶음)
        if i["set"] and not i["used_count"] and i["source"] in (".env", src_secrets) and "백업·임시 파일" not in i["flags"]:  # i18n-ignore: 플래그 비교
            i["flags"].append("쓰는 곳을 찾지 못함")  # i18n-ignore: 다른 모듈이 맞대어 보는 값
    _attach_registry("credential", items)
    # name_pattern: 이 표가 .env 에서 행으로 싣는 이름의 규칙. 화면이 새 비밀값 이름이 표에 나타날지 같은 식으로 미리 알린다(스펙 2026-10-14-025 D9)
    return {"collected_at": now.isoformat(timespec="seconds"), "items": items, "name_pattern": _SECRET_KEY.pattern,
            "totals": {"items": len(items), "global": sum(1 for i in items if i["scope"] == GLOBAL),
                       "profile": sum(1 for i in items if i["scope"] == PROFILE),
                       "empty": sum(1 for i in items if not i["set"]),
                       "expiring": sum(1 for i in items if any("만료" in f for f in i["flags"])),  # i18n-ignore: 플래그 비교
                       "backups": sum(1 for i in items if "백업·임시 파일" in i["flags"]),  # i18n-ignore: 플래그 비교
                       "shared_groups": len({i["shared_group"] for i in items if i["shared_group"]}),
                       "registered": sum(1 for i in items if i["reg"])},
            # 감춘 기본 값의 수만 알린다(값·이름은 싣지 않는다, D5). 화면은 고른 프로파일의 수를 쓴다(외부 검토 OV-9)
            "hidden": {"count": sum(hidden.values()), "by_profile": hidden, "kinds": sorted(hidden_kinds)}}


# ---------------------------------------------------------------------------
# 도구(스크립트)
# ---------------------------------------------------------------------------

_PY_FROM = re.compile(r"^\s*from\s+([A-Za-z_]\w*)[\w.]*\s+import\b", re.M)
_PY_IMPORT = re.compile(r"^\s*import\s+([^#\n]+)", re.M)
_JS_IMPORT = re.compile(r"""(?:require\(\s*['"]([^'"./][^'"]*)['"]\s*\)|from\s+['"]([^'"./][^'"]*)['"])""")


def _imports(path: Path, text: str, local: set[str]) -> list[str]:
    if path.suffix == ".py":
        names = set(_PY_FROM.findall(text))
        for line in _PY_IMPORT.findall(text):            # `import os, requests as rq` 처럼 여러 개를 한 줄에 쓴 경우
            for part in line.split(","):
                mod = part.strip().split(" as ")[0].strip().split(".")[0]
                if re.fullmatch(r"[A-Za-z_]\w*", mod):
                    names.add(mod)
        return sorted(n for n in names if n not in _STDLIB and n not in local and not n.startswith("_"))
    if path.suffix in (".js", ".mjs", ".cjs", ".ts"):
        names = {(a or b) for a, b in _JS_IMPORT.findall(text)}
        return sorted({n if n.startswith("@") else n.split("/")[0] for n in names if not n.startswith("node:")})
    return []


def tools(home: Path | None = None) -> dict:
    home = home or hr.hermes_home()
    remote.prefetch(home)                                     # 원격이면 묶음을 먼저 받고, 같은 묶음 안에서는 한 번만 만든다(OMAI-1102)
    return remote.memo(home, "tools", lambda: _tools(home))


def _tools(home) -> dict:
    graph = skill_graph.build(home)
    by_ref: dict[str, set[str]] = {}
    for s in graph["skills"]:
        for ref in s["external_scripts"]:
            by_ref.setdefault(ref.split("/")[-1], set()).add(tr(f"스킬 {s['name']}", f"Skill {s['name']}"))
    cron_ref: dict[tuple[str, str], list[str]] = {}
    for prof in hr.profiles(home):
        try:
            jobs = hr.read_jobs(prof) or []
        except Exception:
            jobs = []
        for j in jobs:
            if j.get("script"):
                cron_ref.setdefault((prof.name, str(j["script"]).split("/")[-1]), []).append(str(j.get("name") or j.get("id")))
    items = []
    kind_shared, kind_profile = tr("공용 스크립트", "Shared script"), tr("프로파일 스크립트", "Profile script")
    kind_exec, kind_skill = tr("실행 파일", "Executable"), tr("스킬 내부 스크립트", "Skill script")

    def scan(directory: Path, scope: str, profile: str, kind: str, owner: str = ""):
        if not directory.is_dir():
            return
        files = [p for p in sorted(directory.iterdir()) if p.is_file() and p.suffix in SCRIPT_EXT]
        local = {p.stem for p in files}
        for p in files:
            text = _read(p)
            first = text.splitlines()[0] if text else ""
            rel = str(p.relative_to(home))
            users = set(by_ref.get(p.name, ())) if kind == kind_shared else set()
            if owner:
                users.add(tr(f"스킬 {owner}", f"Skill {owner}"))
            crons = [tr(f"예약 작업 {n}", f"Scheduled job {n}") for (pr, name), ns in cron_ref.items() if name == p.name and (pr == profile or scope == GLOBAL or not profile) for n in ns]
            doc = ""
            m = re.search(r'^\s*(?:"""|\'\'\')\s*(.+)', text, re.M) if p.suffix == ".py" else re.search(r"^\s*(?:#|//)\s*(?!!)(.{8,})", text, re.M)
            if m:
                doc = m.group(1).strip().strip('"\'')[:120]
            st = p.stat()
            item = {"id": rel, "name": p.name, "path": rel, "scope": scope, "profile": profile, "kind": kind,
                    "language": SCRIPT_EXT[p.suffix], "runtime": first[2:].strip()[:60] if first.startswith("#!") else "",
                    "size": st.st_size, "modified": _mtime(p), "executable": bool(st.st_mode & 0o111),
                    "summary": doc, "imports": _imports(p, text, local)[:20],
                    "used_by": sorted(users | set(crons))[:12], "used_count": len(users) + len(crons), "flags": []}
            if not item["used_count"]:
                item["flags"].append("부르는 곳을 찾지 못함")  # i18n-ignore: 다른 모듈이 맞대어 보는 값
            if re.search(r"\.bak|[-_](old|copy|backup)\b", p.name):
                item["flags"].append("백업으로 보임")  # i18n-ignore: 플래그 문구는 한국어로 고정
            items.append(item)

    for prof in hr.profiles(home):
        scope, pname = (GLOBAL, "") if prof.name == "default" else (PROFILE, prof.name)
        scan(prof.path / "scripts", scope, pname, kind_shared if scope == GLOBAL else kind_profile)
        scan(prof.path / "bin", scope, pname, kind_exec)
    for s in graph["skills"]:
        sdir = home / s["path"]
        scope, pname = (GLOBAL, "") if s["profile"] == "default" else (PROFILE, s["profile"])
        for sub in {str(Path(x).parent) for x in s["scripts"]}:
            scan(sdir / sub if sub != "." else sdir, scope, pname, kind_skill, owner=s["name"])
    seen, uniq = set(), []
    for i in items:
        if i["id"] not in seen:
            seen.add(i["id"])
            uniq.append(i)
    _attach_registry("tool", uniq)
    langs: dict[str, int] = {}
    for i in uniq:
        langs[i["language"]] = langs.get(i["language"], 0) + 1
    try:                                                      # 이 목록의 예외가 스크립트 목록과 흐름 그림(flow.build 도 tools 를 부른다)까지 깨뜨리면 안 된다
        mcp, mcp_skipped = _mcp(home)
    except Exception as exc:                                  # noqa: BLE001 — 설정 내용이 로그에 새지 않게 예외 종류만 남긴다
        _log.warning("MCP 서버 목록을 만들지 못함: %s", type(exc).__name__)    # i18n-ignore: 로그
        mcp, mcp_skipped = [], [{"profile": "*", "reason": "error"}]
    return {"collected_at": datetime.now().astimezone().isoformat(timespec="seconds"), "items": uniq,
            "mcp": mcp, "mcp_skipped": mcp_skipped,
            "totals": {"items": len(uniq), "global": sum(1 for i in uniq if i["scope"] == GLOBAL),
                       "profile": sum(1 for i in uniq if i["scope"] == PROFILE), "languages": langs,
                       "mcp": len(mcp), "mcp_off": sum(1 for r in mcp if not r["enabled"]),
                       "unreferenced": sum(1 for i in uniq if "부르는 곳을 찾지 못함" in i["flags"]),  # i18n-ignore: 플래그 비교
                       "registered": sum(1 for i in uniq if i["reg"])}}


# ---------------------------------------------------------------------------
# MCP 서버(스펙 2026-10-16-002): 모든 프로파일의 config.yaml mcp_servers 를 읽기만 한다. 비밀 값은 싣지 않는다(이름과 mcp_target 결과만).
# ---------------------------------------------------------------------------

_NAME_CAP = 20


def _mcp_row(profile: str, scope: str, pname: str, name, sect, modified) -> dict:
    if not isinstance(sect, dict):
        raise ValueError("section")
    env, headers, args = sect.get("env"), sect.get("headers"), sect.get("args")
    url, command = sect.get("url"), sect.get("command")
    for value, kind in ((env, dict), (headers, dict), (args, list), (url, str), (command, str)):
        if value is not None and not isinstance(value, kind):
            raise ValueError("shape")
    env, headers, name = env or {}, headers or {}, str(name)
    transport = sect.get("transport")
    transport = transport.strip() if isinstance(transport, str) and transport.strip() else ("http" if url else "stdio" if command else "")
    auth = sect.get("auth")
    return {"id": f"{profile}:{name}", "name": name, "scope": scope, "profile": pname, "transport": transport,
            "enabled": sect.get("enabled") is not False, "auth": auth if isinstance(auth, str) else "",
            "target": mcp_target(url, command, args),
            "env_names": sorted(str(k) for k in env)[:_NAME_CAP], "env_count": len(env),
            "header_names": sorted(str(k) for k in headers)[:_NAME_CAP], "header_count": len(headers),
            "modified": modified}


def _mcp(home) -> tuple[list[dict], list[dict]]:
    """(서버 행, 건너뛴 프로파일). 건너뛴 이유는 짧은 분류만 싣는다: unreadable(YAML 을 못 읽음)·not_a_map(모양이 사전이 아님)·partial(일부 항목만 못 읽음)·error."""
    import yaml
    rows: list[dict] = []
    skipped: list[dict] = []
    seen: set[str] = set()

    def skip(profile: str, reason: str) -> None:
        _log.warning("mcp_servers 를 건너뜀: profile=%s reason=%s", profile, reason)    # i18n-ignore: 로그
        if not any(s["profile"] == profile for s in skipped):
            skipped.append({"profile": profile, "reason": reason})

    for prof in hr.profiles(home):
        scope, pname = (GLOBAL, "") if prof.name == "default" else (PROFILE, prof.name)
        try:
            cfg_path = prof.path / "config.yaml"
            text = _read(cfg_path)
            if not text.strip():
                continue                                      # 파일이 없거나 비었다(300KB 를 넘는 설정도 여기서 빈 값이 된다: _read)
            try:
                cfg = yaml.safe_load(text)
            except yaml.YAMLError:
                skip(prof.name, "unreadable")
                continue
            if cfg is None:
                continue
            servers = cfg.get("mcp_servers") if isinstance(cfg, dict) else False
            if servers is False or (servers is not None and not isinstance(servers, dict)):
                skip(prof.name, "not_a_map")
                continue
            modified = _mtime(cfg_path)
            for name, sect in (servers or {}).items():
                try:
                    row = _mcp_row(prof.name, scope, pname, name, sect, modified)
                except Exception:                             # noqa: BLE001 — 이 항목만 건너뛴다
                    skip(prof.name, "partial")
                    continue
                if row["id"] not in seen:
                    seen.add(row["id"])
                    rows.append(row)
        except Exception:                                     # noqa: BLE001 — 이 프로파일만 건너뛴다
            skip(prof.name, "error")
    rows.sort(key=lambda r: (r["scope"] != GLOBAL, r["profile"], r["name"]))
    return rows, skipped


# ---------------------------------------------------------------------------
# 라이브러리
# ---------------------------------------------------------------------------

def _dist_infos(site: Path) -> list[dict]:
    out = []
    for d in site.glob("*.dist-info"):
        name, _, version = d.name[: -len(".dist-info")].rpartition("-")
        tops = [t.strip() for t in _read(d / "top_level.txt").splitlines() if t.strip()]
        out.append({"name": name or d.name, "version": version, "modules": tops or [name.replace("-", "_").lower()]})
    return out


def libraries(home: Path | None = None) -> dict:
    home = home or hr.hermes_home()
    remote.prefetch(home)                                     # 원격이면 묶음을 먼저 받는다(OMAI-1102)
    # 묶음 memo 에 넣지 않는다 — 서버 로컬 파일(hermes_image_packages.json)을 읽어 묶음 지문이 그 변화를 보지 못한다(스펙 2026-10-24-013 OV3)
    return _libraries(home)


def _libraries(home) -> dict:
    tool_items = tools(home)["items"]
    imported: dict[str, set[str]] = {}
    for t in tool_items:
        for mod in t["imports"]:
            imported.setdefault(mod.lower(), set()).add(t["name"])
    envs, items = [], []

    def add_env(label, scope, profile, kind, packages, path="", note="", key=""):
        envs.append({"env": label, "scope": scope, "profile": profile, "kind": kind, "path": path,
                     "packages": len(packages), "note": note})
        for p in packages:
            mods = [m.lower() for m in p.get("modules") or [p["name"].replace("-", "_").lower()]]
            users = sorted({u for m in mods for u in imported.get(m, ())})
            items.append({"id": f"{key or label}:{p['name']}", "name": p["name"], "version": p.get("version", ""),
                          "env": label, "scope": scope, "profile": profile, "kind": kind,
                          "used_by": users[:12], "used_count": len(users), "flags": [],
                          "_missing": bool(p.get("missing"))})

    snap = store.data_dir() / "hermes_image_packages.json"
    if snap.is_file():
        try:
            data = json.loads(snap.read_text(encoding="utf-8"))
            taken = data.get("taken_at", "")[:16].replace("T", " ")
            runtime = ", ".join(data.get("runtime", []))
            add_env(tr("Hermes 이미지 (/opt/hermes/.venv)", "Hermes image (/opt/hermes/.venv)"), GLOBAL, "", "Python",
                    data.get("packages", []), note=tr(f"{taken} 에 떠 둔 목록 · {runtime}", f"List saved at {taken} · {runtime}"),
                    key="Hermes 이미지 (/opt/hermes/.venv)")  # i18n-ignore: 등록부에 저장되는 키
        except ValueError:
            pass
    for prof in hr.profiles(home):
        scope, pname = (GLOBAL, "") if prof.name == "default" else (PROFILE, prof.name)
        roots = [prof.path / ".venvs", prof.path / ".venv-google", prof.path / ".hermes", prof.path / ".local",
                 prof.path / "home" / ".local", prof.path / "home" / ".venvs"]
        for root in roots:
            if not root.is_dir():
                continue
            for site in root.glob("**/site-packages"):
                if "node_modules" in site.parts or len(site.relative_to(root).parts) > 6:
                    continue
                rel = str(site.relative_to(home))
                add_env(rel.split("/lib/")[0], scope, pname, "Python", _dist_infos(site), path=rel)
        for pkg in list(prof.path.glob("mcp/*/package.json")) + list(prof.path.glob("scripts/*/package.json")):
            try:
                meta = json.loads(_read(pkg))
            except ValueError:
                continue
            deps = {**(meta.get("dependencies") or {}), **(meta.get("devDependencies") or {})}
            packages = []
            for name, want in deps.items():
                inst = pkg.parent / "node_modules" / name / "package.json"
                try:
                    version = json.loads(_read(inst)).get("version", "") if inst.is_file() else ""
                except ValueError:
                    version = ""
                packages.append({"name": name, "version": version or tr(f"(미설치, 요구 {want})", f"(not installed, requires {want})"),
                                 "modules": [name], "missing": not version})
            add_env(str(pkg.parent.relative_to(home)), scope, pname, "Node.js", packages, path=str(pkg.relative_to(home)))
    versions: dict[str, set[str]] = {}
    for i in items:
        versions.setdefault((i["kind"], i["name"].lower().replace("_", "-")), set()).add(i["version"])
    for i in items:
        vs = versions[(i["kind"], i["name"].lower().replace("_", "-"))]
        if len(vs) > 1:
            i["flags"].append(f"환경마다 버전이 다름 ({len(vs)}가지)")  # i18n-ignore: 플래그 문구는 한국어로 고정
        if i.pop("_missing"):
            i["flags"].append("설치되지 않음")  # i18n-ignore: UI 가 맞대어 보는 값
    _attach_registry("library", items)
    return {"collected_at": datetime.now().astimezone().isoformat(timespec="seconds"), "envs": envs, "items": items,
            "totals": {"items": len(items), "envs": len(envs),
                       "global": sum(1 for i in items if i["scope"] == GLOBAL),
                       "profile": sum(1 for i in items if i["scope"] == PROFILE),
                       "used": sum(1 for i in items if i["used_count"]),
                       "version_conflicts": len({(i["kind"], i["name"].lower()) for i in items if any("버전이 다름" in f for f in i["flags"])}),  # i18n-ignore: 플래그 비교
                       "registered": sum(1 for i in items if i["reg"])}}


# ---------------------------------------------------------------------------
# 등록부 — AAS 가 따로 갖는 관리 기록(담당·메모·상태). Hermes 쪽 파일은 건드리지 않는다.
# ---------------------------------------------------------------------------

REG_SCHEMA = ("CREATE TABLE IF NOT EXISTS registry (kind TEXT NOT NULL, key TEXT NOT NULL, status TEXT NOT NULL, "
              "owner TEXT, note TEXT, updated_by TEXT, updated_at TEXT, PRIMARY KEY (kind, key))")
REG_STATUS = ("registered", "review", "deprecated")


def _attach_registry(kind: str, items: list[dict]) -> None:
    with store.connect() as conn:
        conn.execute(REG_SCHEMA)
        rows = {r["key"]: dict(r) for r in conn.execute("SELECT * FROM registry WHERE kind=?", (kind,))}
    for i in items:
        r = rows.get(i["id"])
        i["reg"] = {k: r[k] for k in ("status", "owner", "note", "updated_by", "updated_at")} if r else None


def register(kind: str, key: str, status: str, owner: str = "", note: str = "", by: str = "") -> dict:
    if kind not in ("credential", "tool", "library"):
        raise ValueError(tr("알 수 없는 종류", "Unknown kind"))
    with store.connect() as conn:
        conn.execute(REG_SCHEMA)
        if status == "none":
            conn.execute("DELETE FROM registry WHERE kind=? AND key=?", (kind, key))
            return {"ok": True, "reg": None}
        if status not in REG_STATUS:
            raise ValueError(tr("알 수 없는 상태", "Unknown status"))
        now = datetime.now().astimezone().isoformat(timespec="seconds")
        conn.execute("INSERT INTO registry VALUES (?,?,?,?,?,?,?) ON CONFLICT(kind, key) DO UPDATE SET "
                     "status=excluded.status, owner=excluded.owner, note=excluded.note, "
                     "updated_by=excluded.updated_by, updated_at=excluded.updated_at",
                     (kind, key, status, owner[:80], note[:400], by[:120], now))
    return {"ok": True, "reg": {"status": status, "owner": owner[:80], "note": note[:400], "updated_by": by, "updated_at": now}}
