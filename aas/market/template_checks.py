# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""에이전트 패키지·프로파일 템플릿의 설치 때 검사와 템플릿 전용 config 합치기(스펙 2026-11-18-002 §4-2).

  검사          리더의 stage 가 실제로 받은 본문에 대해 한다(E2). 걸리면 Refuse 로 요청을 닫는다.
                ${…} 참조: config·cron 의 참조는 모두 env_requires 안에 있어야 하고, 막힌 이름(owner_guard)은 쓸 수 없고,
                주소의 호스트 부분에는 쓸 수 없다(R1). stdio MCP: 공용 구역 금지(D4), 판 고정 패키지 실행기만, args 엄격 해석,
                command·args 의 ${…} 금지, 동의 해시 일치(E9). 참고 파일 경로: 예약 이름 금지(E10).
  합치기        받는 사람 main config 에서 채널·mcp_servers·스킬 켜기/끄기를 빼고, 템플릿 config 의 허용 키만 덮는다(E1).
                ${KEY} 를 쓰는 MCP 는 enabled: false 로 넣는다 — KEY 를 넣기 전에 글자 그대로 바깥 서버에 가지 않게(R13).
"""
from __future__ import annotations

import hashlib
import json
import posixpath
import re

import yaml

from ..ops import owner_guard

PUBLIC_NAMESPACES = ("free",)                                     # 공용 구역 = 허브 밖에도 공개되는 네임스페이스(D4, market_publish.VISIBILITY)
REF = re.compile(r"\$\{([^}]*)\}")
ENV_NAME = re.compile(r"^[A-Z_][A-Z0-9_]{0,63}\Z")
TEMPLATE_CONFIG_KEYS = ("toolsets", "platform_toolsets", "skills", "mcp_servers")   # 템플릿이 담고 덮어쓰는 config 키(§4-1 허용 목록)
TEMPLATE_SKILL_KEYS = ("disabled",)                              # skills 안에서 템플릿이 정하는 것: 켜기/끄기만. external_dirs 는 담지 않는다
RESERVED_FILES = (".env", "auth.json", ".hermes", "config.yaml")
MAX_TEMPLATE_FILES = 30
MAX_TEMPLATE_BYTES = 10 * 2**20
FILES_PREFIX = "template/files/"
# 판을 고정한 패키지 실행기(E9). 위치 인자는 패키지 하나, 플래그는 아래 것만. docker 는 Hermes 컨테이너에 없어 뺀다
_PIN = {"npx": re.compile(r"^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?\Z"),
        "uvx": re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9,._-]+\])?==\d+(\.\d+){1,2}([a-z0-9.+-]*)?\Z")}
_PIN["pipx"] = _PIN["uvx"]
_FLAGS = {"npx": {"-y", "--yes"}, "uvx": set(), "pipx": set()}


class CheckError(Exception):
    """검사 거절. code = 오류 코드(§4-5 표), 메시지는 요청 기록·화면에 그대로 보인다."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def consent_hash(command: str, args) -> str:
    """stdio MCP 동의 해시 = sha256(정규 JSON [command, args]). 서버가 계산해 상세 조회로 돌려주고 설치 요청이 담아 온다(§4-5)."""
    body = json.dumps([str(command), [str(a) for a in (args or [])]], ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def refs(value) -> set[str]:
    """값 안의 ${…} 참조 이름들(문자열·목록·표를 모두 훑는다)."""
    out: set[str] = set()
    if isinstance(value, str):
        out.update(m.group(1).strip() for m in REF.finditer(value))
    elif isinstance(value, dict):
        for k, v in value.items():
            out |= refs(k) | refs(v)
    elif isinstance(value, (list, tuple)):
        for v in value:
            out |= refs(v)
    return out


def blocked(name: str) -> bool:
    """주인이 넣을 수 없는 이름(owner_guard 의 접속·동작 이름)이거나 이름 꼴이 아니다. 설치한 사람이 넣을 수 없으니 템플릿도 쓰지 못한다.
    AAS_OWNER_ENV_URLS 허용 목록은 보지 않는다 — 템플릿은 다른 설치에서도 쓰이므로 한 설치의 허용 목록에 기대면 안 된다(스펙 2026-11-24-009 D3)."""
    if not ENV_NAME.match(name or ""):
        return True
    return bool(owner_guard.env_key_check(name, {})[0])


def _host_of(url: str) -> str:
    rest = url.split("://", 1)[1] if "://" in url else url
    return re.split(r"[/?#]", rest, maxsplit=1)[0]


def _is_stdio(spec: dict) -> bool:
    return bool(spec.get("command")) and not spec.get("url")


def stdio_problem(command: str, args) -> str:
    """판 고정·인자 검사. 문제가 없으면 빈 문자열, 있으면 사유."""
    args = [str(a) for a in (args or [])]
    if refs(command) or refs(args):
        return "command·args 에는 ${…} 를 쓸 수 없습니다(값은 env 에만 넣습니다)"  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
    base = posixpath.basename(str(command))
    if base not in _PIN:
        return f"허용하지 않는 명령입니다: {command} — 판을 고정한 npx pkg@x.y.z, uvx pkg==x.y.z, pipx run pkg==x.y.z 만 받습니다"  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
    rest = args[1:] if base == "pipx" and args[:1] == ["run"] else (args if base != "pipx" else None)
    if rest is None:
        return "pipx 는 pipx run pkg==x.y.z 꼴만 받습니다"  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
    positional = [a for a in rest if not a.startswith("-")]
    flags = [a for a in rest if a.startswith("-")]
    bad = [f for f in flags if f not in _FLAGS[base]]
    if bad:
        return f"허용하지 않는 인자입니다: {' '.join(bad)} — 추가 패키지 지정(-p·--package 등)은 받지 않습니다"  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
    if len(positional) != 1 or not _PIN[base].match(positional[0]):
        return f"판을 고정한 패키지 하나만 받습니다(예: {'pkg@1.2.3' if base == 'npx' else 'pkg==1.2.3'})"  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
    return ""


def mcp_servers_of(cfg: dict) -> dict:
    servers = cfg.get("mcp_servers") if isinstance(cfg, dict) else None
    return servers if isinstance(servers, dict) else {}


def stdio_list(servers: dict) -> list[dict]:
    """stdio MCP 마다 {name, command, args, consent_hash} — 설치 화면의 동의 칸과 서버 검사가 같은 값을 쓴다."""
    out = []
    for name, spec in sorted(servers.items()):
        if isinstance(spec, dict) and _is_stdio(spec):
            args = [str(a) for a in spec.get("args") or []]
            out.append({"name": str(name), "command": str(spec["command"]), "args": args, "consent_hash": consent_hash(spec["command"], args)})
    return out


def check(namespace: str, config_text: str, cron_text: str, env_names: list[str], files: list[str],
          consents: list[str] | None, mcp_json_text: str = "") -> dict:
    """받은 본문의 검사(§4-2 4). 거절은 CheckError. 돌려주는 값: {stdio: [...], refs: [...]}.
    consents = 설치 요청에 담겨 온 동의 해시들(None 이면 동의 확인을 하지 않는다 — 올리기 등 새 프로파일이 아닌 길)."""
    try:
        cfg = yaml.safe_load(config_text or "") or {}
    except yaml.YAMLError:
        raise CheckError("config_invalid", "agent/config.yaml 을 읽을 수 없습니다") from None  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
    if not isinstance(cfg, dict):
        raise CheckError("config_invalid", "agent/config.yaml 이 표 모양이 아닙니다")  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
    servers = dict(mcp_servers_of(cfg))
    if mcp_json_text.strip():                                      # 템플릿이 아닌 옛 에이전트 패키지의 mcp.json 도 같은 검사를 한다(R1 을 다른 패키지에 열어 두지 않는다)
        try:
            extra = json.loads(mcp_json_text)
        except ValueError:
            raise CheckError("config_invalid", "agent/mcp.json 을 읽을 수 없습니다") from None  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
        more = (extra.get("mcpServers") or extra.get("mcp_servers")) if isinstance(extra, dict) else None
        for k, v in (more or {}).items() if isinstance(more, dict) else ():
            servers.setdefault(f"mcp.json:{k}", v)
    allowed = set(env_names)
    used = refs(cfg) | refs(cron_text) | refs(servers)
    for name in sorted(used):
        if blocked(name):
            raise CheckError("env_ref_blocked", f"쓸 수 없는 이름을 참조합니다: ${{{name}}} — 접속·동작을 정하는 이름은 템플릿에 쓸 수 없습니다")  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
        if name not in allowed:
            raise CheckError("env_ref_blocked", f"env_requires 에 없는 이름을 참조합니다: ${{{name}}}")  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
    for name, spec in sorted(servers.items()):
        if not isinstance(spec, dict):
            continue
        url = spec.get("url")
        if isinstance(url, str) and refs(_host_of(url)):
            raise CheckError("env_ref_host", f"MCP {name} 주소의 호스트에 ${{…}} 가 있습니다 — 주소는 고정해야 합니다")  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
        if _is_stdio(spec):
            if namespace in PUBLIC_NAMESPACES:
                raise CheckError("stdio_public", f"공용 구역 패키지에는 명령을 실행하는 MCP({name})를 담을 수 없습니다")  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
            why = stdio_problem(spec["command"], spec.get("args"))
            if why:
                raise CheckError("stdio_unpinned", f"MCP {name}: {why}")  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
    stdio = stdio_list(servers)
    if consents is not None:
        missing = [s["name"] for s in stdio if s["consent_hash"] not in set(consents)]
        if missing:
            raise CheckError("consent_required" if not consents else "consent_mismatch",
                             f"명령을 실행하는 MCP 에 대한 동의가 없거나 판이 바뀌었습니다: {', '.join(missing)} — 설치 화면에서 다시 동의하세요")  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
    template_files = [f for f in files if f.startswith(FILES_PREFIX)]
    if len(template_files) > MAX_TEMPLATE_FILES:
        raise CheckError("files_too_many", f"참고 파일은 {MAX_TEMPLATE_FILES}개까지입니다")  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
    for f in template_files:
        why = file_path_problem(f[len(FILES_PREFIX):])
        if why:
            raise CheckError("file_path", f"참고 파일 경로를 받을 수 없습니다: {f} — {why}")  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
    return {"stdio": stdio, "refs": sorted(used)}


def file_path_problem(rel: str) -> str:
    """작업 폴더 안 상대 경로인가(E10). 만들 때와 설치 때 같은 검사."""
    if not rel or rel.startswith("/") or "\\" in rel or "\x00" in rel:
        return "절대 경로나 빈 경로입니다"  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
    norm = posixpath.normpath(rel)
    if norm != rel or norm.startswith("..") or "/../" in f"/{norm}/":
        return "작업 폴더 밖을 가리킵니다"  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
    if any(part in RESERVED_FILES or part.startswith(".hermes") for part in norm.split("/")):
        return "예약된 이름입니다(.env·auth.json·.hermes·config.yaml)"  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
    return ""


def merge_config(main_text: str, template_text: str, env_names: list[str]) -> tuple[str, list[str]]:
    """템플릿 전용 합치기(E1): main 에서 채널 블록·mcp_servers·스킬 켜기/끄기를 빼고, 템플릿의 허용 키만 덮는다.
    `import_overlay` 는 받는 쪽의 mcp_servers·skills·채널을 지켜 템플릿 MCP 가 사라지고 main 의 MCP 인증 헤더가 복사되므로 쓰지 않는다.
    env_names 가운데 하나라도 쓰는 MCP 는 enabled: false 로 둔다 — KEY 를 넣은 뒤 서버가 켠다(§4-2 6).
    돌려주는 값: (config 글, KEY 를 기다리는 MCP 이름들). 만든 사람이 처음부터 꺼 둔 MCP 는 기다림 목록에 넣지 않는다(KEY 가 차도 켜지 않는다)."""
    from ..ops import profile_copy
    base = profile_copy._load(profile_copy.for_new_profile(main_text))
    tmpl = profile_copy._load(template_text)
    base.pop("mcp_servers", None)
    skills = base.get("skills") if isinstance(base.get("skills"), dict) else None
    if skills is not None:
        skills = {k: v for k, v in skills.items() if k not in TEMPLATE_SKILL_KEYS and k != "external_dirs"}
        base["skills"] = skills
    for key in TEMPLATE_CONFIG_KEYS:
        if key not in tmpl:
            continue
        if key == "skills":
            src = tmpl["skills"] if isinstance(tmpl["skills"], dict) else {}
            mine = dict(base.get("skills") or {})
            mine.update({k: v for k, v in src.items() if k in TEMPLATE_SKILL_KEYS})
            if mine:
                base["skills"] = mine
        else:
            base[key] = tmpl[key]
    servers, waiting = dict(mcp_servers_of(base)), []
    for name, spec in list(servers.items()):
        if isinstance(spec, dict) and refs(spec) & set(env_names) and spec.get("enabled") is not False:
            servers[name] = {**spec, "enabled": False}
            waiting.append(str(name))
    if servers:
        base["mcp_servers"] = servers
    return profile_copy._dump(base), sorted(waiting)


def ready_servers(servers: dict, waiting: list[str], have: set[str]) -> list[str]:
    """기다리던 MCP 가운데 KEY 가 다 찬(참조하는 이름이 모두 have 에 있는) 꺼진 것 — env_set 뒤 서버가 켠다."""
    out = []
    for name in sorted(waiting):
        spec = servers.get(name)
        if isinstance(spec, dict) and spec.get("enabled") is False and refs(spec) <= have:
            out.append(name)
    return out


# ---- 새 판 합치기(스펙 2026-11-18-002 §4-2 「템플릿 새 판」) ------------------------------------------------
# 올리기(update) 때 Hermes 는 config.yaml 을 지킨다. 그래서 MCP 는 AAS 가 따로 합친다: 더함·바뀜만 넣고 없어진 것은 지우지 않고 알린다.
# 새로·바뀐 MCP 가운데 KEY 가 다 차지 않은 것은 꺼 둔다(설치 때와 같다).

def _comparable(spec) -> dict:
    """비교용: 켜고 끄기(enabled)는 사용자 몫이라 뺀다."""
    return {k: v for k, v in spec.items() if k != "enabled"} if isinstance(spec, dict) else {}


def mcp_diff(current: dict, new: dict) -> dict:
    """{added, changed, kept}: 프로파일의 지금 mcp_servers 와 새 판 템플릿의 mcp_servers 비교. kept 는 지우지 않고 그대로 둘 것."""
    cur, nxt = current or {}, new or {}
    return {"added": sorted(n for n in nxt if n not in cur),
            "changed": sorted(n for n in nxt if n in cur and _comparable(cur[n]) != _comparable(nxt[n])),
            "kept": sorted(n for n in cur if n not in nxt)}                 # 템플릿에 없는 지금 MCP(사용자가 더했거나 템플릿에서 빠짐) — 그대로 둔다


def merge_mcp(current: dict, new: dict, have: set[str], base: dict | None = None) -> tuple[dict, list[str], list[str]]:
    """새 판의 더함·바뀜을 합친 mcp_servers. 돌려주는 값: (합친 지도, KEY 를 기다리는 MCP, 템플릿에서 없어진 MCP).
    base = 이전 판 템플릿의 mcp_servers(있으면 「템플릿에서 없어진 것」을 가린다 — 사용자가 직접 더한 MCP 는 없어진 것으로 보지 않는다)."""
    out = dict(current or {})
    diff = mcp_diff(current, new)
    waiting = []
    for name in diff["added"] + diff["changed"]:
        spec = dict(new[name])
        if refs(spec) - set(have):
            spec["enabled"] = False
            waiting.append(name)
        elif name in (current or {}) and isinstance(current[name], dict) and current[name].get("enabled") is False:
            spec["enabled"] = False                                   # 사용자가 꺼 둔 것은 켜지 않는다
        out[name] = spec
    gone = sorted(n for n in (base or {}) if n not in (new or {}) and n in out)
    return out, sorted(waiting), gone


def mask_values(text: str, env_text: str, min_len: int = 6) -> str:
    """오류 한 줄에 프로파일 .env 의 값이 글자 그대로 들어 있으면 ***** 로 바꾼다(§4-5 가리기). 주소의 경로·쿼리에 든 ${KEY} 가
    펼쳐진 채 오류에 실릴 수 있다. 짧은 값(min_len 미만)은 흔한 낱말과 겹쳐 바꾸지 않는다. 긴 값부터 바꾼다."""
    values = []
    for line in (env_text or "").splitlines():
        if "=" not in line or line.lstrip().startswith("#"):
            continue
        v = line.split("=", 1)[1].strip().strip("\"'")
        if len(v) >= min_len:
            values.append(v)
    for v in sorted(set(values), key=len, reverse=True):
        text = text.replace(v, "*****")
    return text
