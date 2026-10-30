# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""마켓플레이스 — 따로 설치된 SkillHub 에 연결해 패키지를 보여 주고, 설치 요청을 남긴다.

AAS 는 Hermes 에 직접 쓰지 않는다. 설치는 Hermes 의 공식 CLI(`hermes profile install`)가 하는데 대시보드 API 에는 그 길이
없어서, AAS 는 요청 파일만 남기고 서버의 배달기(market_dispatch)가 SkillHub 에서 받아 HermesTask 로 보내면 오퍼레이터가 Hermes 안에서 CLI 를 돌린다.

  패키지 두 종류     스킬 — 고른 프로파일의 skills/market/<이름>/ 에 얹는다.
                     에이전트 — 패키지 안 agent/ (SOUL·스킬·크론·MCP)로 새 프로파일을 만든다.
  shared/restricted  SkillHub 네임스페이스(slug free·paid, 화면 이름 한국어 공용·제한, 영어 shared·restricted — NS_LABELS). 허용이 필요한(공개가 아닌)
                     네임스페이스는 그 Hermes 설치본(POD)에 허용해 준 뒤에만 설치된다.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

from ..common import config, db, store
from ..assets.files import mask_line
from ..common.i18n import SUPPORTED, get_lang, tr
from ..common.redact import redact
from ..ops import pc_import
from . import tags as market_tags

NAME = re.compile(r"^[a-z0-9][a-z0-9-]{1,62}$")              # 패키지·네임스페이스 이름
PROFILE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,40}$")
VERSION = re.compile(r"^\d+\.\d+\.\d+$")
AGENT_MANIFEST = "agent/distribution.yaml"
PAYLOAD_LIMIT = 512 * 1024                 # HermesTask 에 실을 묶음(tar.gz) 크기 한도. market_stage 가 묶은 뒤 같은 값으로 거른다(C5)
MAX_PACKING_RATIO = 20                     # 글 파일이 아주 잘 눌려도 이 배율까지다. 파일 합계가 한도의 이 배를 넘으면 묶어 볼 것도 없이 못 들어간다
ORIGINS = "origins.json"                   # mirror.py push 가 남기는 출처 표: {"community/<이름>": {kind, url, license, version}} (C4)
MODES = ("install", "update", "skills")    # 지우기(remove)는 request_remove 로만 들어온다. skills: 에이전트 패키지의 스킬만 기존 프로파일에(2026-10-14-002)
SCHEMA = """
CREATE TABLE IF NOT EXISTS market_grants (
  pod TEXT NOT NULL, namespace TEXT NOT NULL, by TEXT, ts TEXT, PRIMARY KEY (pod, namespace));
CREATE TABLE IF NOT EXISTS market_default_pending (
  pod TEXT NOT NULL, profile TEXT NOT NULL, package TEXT NOT NULL, ts TEXT, PRIMARY KEY (pod, profile, package));
"""


class MarketError(Exception):
    def __init__(self, message: str, code: int = 400):
        super().__init__(message)
        self.code = code


def settings() -> dict:
    token_file = os.environ.get("AAS_SKILLHUB_TOKEN_FILE", "")
    return {"url": os.environ.get("AAS_SKILLHUB_URL", "").rstrip("/"), "token_file": token_file,
            "namespaces": [n for n in os.environ.get("AAS_MARKET_NAMESPACES", "free,paid").split(",") if NAME.match(n)],
            # 미러 번들(공개 스킬)이 올라가는 네임스페이스 — 마켓에는 보이지만 사용자가 게시하는 곳은 아니다(2026-10-14-026 C3)
            "readonly": [n for n in os.environ.get("AAS_MARKET_READONLY_NAMESPACES", "community").split(",") if NAME.match(n)]}


def readable(cfg: dict) -> list[str]:
    return cfg["namespaces"] + [n for n in cfg.get("readonly", []) if n not in cfg["namespaces"]]


# ---- 네임스페이스 표시 이름 (스펙 2026-10-28-010) --------------------------------------------------------
# slug(free·paid)는 SkillHub 경로·저장 데이터·API 의 namespace 값으로 그대로 쓴다. 바꿀 수 없다(SkillHub 에 slug 를 바꾸는 기능이 없다, D6).
# 사람이 읽는 곳에만 이 이름을 보인다. 표는 여기 한 곳에만 둔다 — 화면은 응답의 namespace_labels 를 읽는다. 표에 없으면 slug 를 보인다.
# 이름은 (한국어, 영어) 이고 요청 언어(i18n)를 따른다 — 한국어 화면 공용·제한, 영어 화면 shared·restricted(§6-3)
NS_LABELS = {"free": ("공용", "shared"), "paid": ("제한", "restricted")}   # 2026-10-28-010. i18n-ignore: (한국어, 영어) 표 — ns_label 이 요청 언어로 고르고 ns_slug 는 두 언어를 모두 받는다


def _known(cfg: dict | None) -> list[str]:
    return readable(cfg or settings())


def _label(slug: str, lang: str, known: list[str]) -> str:
    names = NS_LABELS.get(slug)
    label = (names[1] if lang == "en" else names[0]) if names else ""
    if not label or label in [n for n in known if n != slug]:
        return slug
    return label


def ns_label(slug: str, cfg: dict | None = None) -> str:
    """사람에게 보이는 이름(요청 언어). 그 이름이 설정된 다른 slug 와 같으면(어떤 사이트가 진짜 slug shared 를 쓴다) 헷갈리지 않게 slug 를 그대로 보인다."""
    return _label(slug, get_lang(), _known(cfg))


def ns_slug(name: str, cfg: dict | None = None) -> str:
    """입력(slug 또는 표시 이름)을 slug 로(D7). 설정된 진짜 slug 가 먼저다. 표시 이름은 화면 언어와 관계없이 두 언어 모두 받는다.
    둘 다 아니면 입력 그대로 — 그다음 기존 검사가 거절한다."""
    known = _known(cfg)
    if name in known:
        return name
    return next((s for s in NS_LABELS for lang in SUPPORTED if _label(s, lang, known) == name), name)


def ns_labels(cfg: dict | None = None) -> dict[str, str]:
    """응답의 namespace_labels — 설정·읽기 전용 네임스페이스 모두 {slug: 이름}."""
    return {n: ns_label(n, cfg) for n in _known(cfg)}


def pkg_label(package_id: str, cfg: dict | None = None) -> str:
    """「free/x@1」 → 「공용/x@1」(영어 화면은 「shared/x@1」). 첫 「/」 앞(네임스페이스)만 바꾼다. 「/」가 없으면 그대로."""
    ns, sep, rest = (package_id or "").partition("/")
    return f"{ns_label(ns, cfg)}/{rest}" if sep else package_id


def pkg_slug(package_id: str, cfg: dict | None = None) -> str:
    """pkg_label 의 반대 — 입력의 패키지 ID 를 저장하는 꼴(slug)로."""
    ns, sep, rest = (package_id or "").partition("/")
    return f"{ns_slug(ns, cfg)}/{rest}" if sep else package_id


def _token(path: str) -> str:
    try:
        return Path(path).read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def _not_found(exc: urllib.error.HTTPError) -> bool:
    """HTTP 400 응답의 본문이 「… not found」인가(SkillHub 가 없는 항목을 400 으로 알린다)."""
    try:
        msg = str((json.loads(exc.read() or b"{}") or {}).get("msg") or "")
    except (OSError, ValueError, AttributeError):
        return False
    return "not found" in msg.lower()


def fetch(path: str, cfg: dict | None = None) -> dict:
    """SkillHub 읽기 호출. 응답의 data 를 돌려준다."""
    cfg = cfg or settings()
    if not cfg["url"]:
        raise MarketError(tr("스킬 허브 주소(AAS_SKILLHUB_URL)가 설정돼 있지 않습니다", "The skill hub URL (AAS_SKILLHUB_URL) is not set"), 503)
    req = urllib.request.Request(cfg["url"] + path, headers={"Accept": "application/json"})
    token = _token(cfg["token_file"])
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        # SkillHub 는 없는 스킬에 404 가 아니라 HTTP 400 과 {"msg": "Skill not found: x"} 를 준다(OKE 에서 확인). 처음 올리는 이름의 조회가 이것 때문에 막혔다
        if exc.code == 404 or (exc.code == 400 and _not_found(exc)):
            raise MarketError(tr("스킬 허브에 없는 패키지입니다", "The skill hub has no such package"), 404) from None
        if exc.code in (401, 403):
            raise MarketError(tr("스킬 허브가 거절했습니다 — AAS 의 연결 토큰에 이 네임스페이스 권한이 없습니다", "The skill hub refused the request. The AAS connection token has no access to this namespace"), 502) from None
        raise MarketError(tr(f"스킬 허브 오류 (HTTP {exc.code})", f"Skill hub error (HTTP {exc.code})"), 502) from None
    except (OSError, ValueError) as exc:
        raise MarketError(tr(f"스킬 허브에 연결할 수 없습니다: {type(exc).__name__}", f"Cannot reach the skill hub: {type(exc).__name__}"), 503) from None
    return body.get("data", body) if isinstance(body, dict) else {}


def _ver(v: str) -> tuple:
    return tuple(int(x) for x in v.split(".")) if VERSION.match(v or "") else (0, 0, 0)


PAGE_SIZE, MAX_PAGES = 100, 30                                 # 네임스페이스마다 최대 3000개 — 미러 번들이 100개를 넘어도 다 보이게 쪽으로 읽는다(2026-10-14-026 C1)


def _listed(ns: str, cfg: dict) -> list[dict]:
    """네임스페이스의 패키지 목록을 쪽 넘김으로 읽는다. 쪽이 비거나 같은 쪽이 되풀이되거나 total 을 채우면 멈춘다."""
    out, seen = [], set()
    for page in range(MAX_PAGES):
        body = fetch(f"/api/web/skills?namespace={urllib.parse.quote(ns)}&page={page}&size={PAGE_SIZE}", cfg)
        items = [it for it in body.get("items", []) if isinstance(it, dict)]
        fresh = [it for it in items if (it.get("namespace"), it.get("slug")) not in seen]
        if not fresh:
            break
        seen.update((it.get("namespace"), it.get("slug")) for it in fresh)
        out += fresh
        total = body.get("total")
        if len(items) < PAGE_SIZE or (isinstance(total, int) and len(out) >= total):
            break
    return out


def catalog(cfg: dict | None = None) -> list[dict]:
    cfg = cfg or settings()
    out, table, tag_table = [], origins(), market_tags.load()
    for ns in readable(cfg):
        try:
            listed = _listed(ns, cfg)
        except MarketError:
            if ns in cfg["namespaces"]:
                raise
            continue                                          # 미러 네임스페이스가 아직 없거나 읽을 수 없어도 free·paid 목록은 보인다
        for it in listed:
            pub = it.get("publishedVersion") or {}
            if it.get("namespace") != ns or it.get("status") != "ACTIVE" or not pub.get("version") or not NAME.match(str(it.get("slug") or "")):
                continue
            out.append({"id": f"{ns}/{it['slug']}", "namespace": ns, "name": it["slug"], "summary": str(it.get("summary") or "")[:400],
                        "version": pub["version"], "paid": it.get("visibility") != "PUBLIC", "restricted": it.get("visibility") != "PUBLIC",   # restricted = paid(D3, paid 는 외부 MCP 클라이언트 때문에 남김)
                        "owner": str(it.get("ownerDisplayName") or ""),
                        "downloads": it.get("downloadCount") or 0, "updated": str(it.get("updatedAt") or "")[:19],
                        "origin": origin_of(ns, it["slug"], cfg, table), "tags": market_tags.row_tags(tag_table, f"{ns}/{it['slug']}")})
    return sorted(out, key=lambda r: (r["paid"], r["name"]))


def origins() -> dict:
    try:
        data = json.loads((store.data_dir() / "market" / ORIGINS).read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def origin_of(ns: str, name: str, cfg: dict, table: dict | None = None) -> dict:
    """패키지가 어디서 왔는가: 미러(clawhub·github)는 출처 표에서, 사용자가 올린 free·paid 는 own, 표에 없는 미러 항목은 unknown."""
    row = (origins() if table is None else table).get(f"{ns}/{name}")
    if isinstance(row, dict) and row.get("kind") in ("clawhub", "github"):
        url = str(row.get("url") or "")
        return {"kind": row["kind"], "url": url if re.match(r"^https?://", url) else "", "license": str(row.get("license") or "")[:60]}
    return {"kind": "own" if ns in cfg["namespaces"] else "unknown", "url": "", "license": ""}


def kind_of(paths: list[str]) -> str:
    return "agent" if AGENT_MANIFEST in paths else "skill"


def package(ns: str, name: str, cfg: dict | None = None) -> dict:
    """패키지 하나 — 종류(스킬/에이전트), 들어 있는 파일, 버전들, 설명글. ns 는 표시 이름(shared)도 받는다(D7)."""
    cfg = cfg or settings()
    ns = ns_slug(ns, cfg)
    if not (NAME.match(ns) and NAME.match(name)):
        raise MarketError(tr("패키지 이름이 올바르지 않습니다", "The package name is not valid"))
    if ns not in readable(cfg):
        raise MarketError(tr("이 스킬 허브에서 다루지 않는 네임스페이스입니다", "This skill hub does not serve that namespace"), 404)
    base = f"/api/v1/skills/{ns}/{name}"
    info = fetch(base, cfg)
    version = (info.get("publishedVersion") or {}).get("version") or ""
    if not version:
        raise MarketError(tr("아직 공개된 버전이 없습니다", "No version has been published yet"), 404)
    files = fetch(f"{base}/versions/{version}/files", cfg)
    files = files if isinstance(files, list) else files.get("items", [])
    paths = [str(f.get("filePath") or "") for f in files]
    meta = fetch(f"{base}/versions/{version}", cfg)
    try:
        body = str(json.loads(meta.get("parsedMetadataJson") or "{}").get("body") or "")
    except ValueError:
        body = ""
    versions = fetch(f"{base}/versions", cfg).get("items", [])
    return {"id": f"{ns}/{name}", "namespace": ns, "name": name, "summary": str(info.get("summary") or "")[:400], "version": version,
            "paid": info.get("visibility") != "PUBLIC", "restricted": info.get("visibility") != "PUBLIC", "kind": kind_of(paths), "owner": str(info.get("ownerDisplayName") or ""),
            "files": [{"path": p, "size": f.get("fileSize") or 0} for p, f in zip(paths, files)][:300],
            "bytes": sum(int(f.get("fileSize") or 0) for f in files), "limit": PAYLOAD_LIMIT, "too_big": sum(int(f.get("fileSize") or 0) for f in files) > PAYLOAD_LIMIT * MAX_PACKING_RATIO, "origin": origin_of(ns, name, cfg), "tags": market_tags.row_tags(market_tags.load(), f"{ns}/{name}"),
            "scripts": sum(1 for p in paths if p.startswith("scripts/") or "/scripts/" in p),
            "versions": [{"version": v.get("version"), "published": str(v.get("publishedAt") or "")[:19]} for v in versions if v.get("status") == "PUBLISHED"][:30],
            "body": "\n".join(mask_line(ln) for ln in body[:6000].splitlines())}


# ---- 허용이 필요한 네임스페이스의 사용 허용 (AAS 쪽 기록) --------------------------------------------

def _conn():
    conn = store.connect()
    conn.executescript(SCHEMA)
    return conn


def grants() -> list[dict]:
    with _conn() as conn:
        return [dict(r) for r in conn.execute("SELECT pod, namespace, by, ts FROM market_grants ORDER BY pod, namespace")]


def set_grant(pod: str, namespace: str, allow: bool, by: str) -> None:
    namespace = ns_slug(namespace)                                # 표시 이름(restricted)을 받아도 slug 로 저장한다 — NAME 만 보면 쓸모없는 행이 조용히 남는다(D7)
    if not NAME.match(namespace):
        raise MarketError(tr("네임스페이스 이름이 올바르지 않습니다", "The namespace name is not valid"))
    with _conn() as conn:
        if allow:
            conn.execute(db.upsert("market_grants", ("pod", "namespace", "by", "ts"), ("pod", "namespace")), (pod, namespace, by, _now()))
        else:
            conn.execute("DELETE FROM market_grants WHERE pod=? AND namespace=?", (pod, namespace))


def allowed(pod: str, pkg: dict) -> bool:
    if not pkg["paid"]:
        return True
    with _conn() as conn:
        return bool(conn.execute("SELECT 1 FROM market_grants WHERE pod=? AND namespace=?", (pod, pkg["namespace"])).fetchone())


# ---- 설치 요청과 결과 (파일 — 서버의 배달기와 주고받는다) ----------------------------------------

def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _dir(kind: str) -> Path:
    d = store.data_dir() / "market" / kind
    d.mkdir(parents=True, exist_ok=True)
    return d


def _read(path: Path) -> dict | None:
    try:
        row = json.loads(path.read_text(encoding="utf-8"))
        return row if isinstance(row, dict) and row.get("id") else None
    except (OSError, ValueError):
        return None


def requests(pod: str | None = None, limit: int = 200) -> list[dict]:
    """기다리는 요청과 끝난 요청. 새 것부터. who_name 은 요청한 사람의 이름(화면 표시, 2026-10-30)."""
    from ..office import office
    known = office.people()
    rows = []
    for kind, default in (("queue", "queued"), ("done", "")):
        for p in _dir(kind).glob("*.json"):
            row = _read(p)
            if row and (pod is None or row.get("pod") == pod):
                row.setdefault("status", default or "failed")
                row["message"] = redact(str(row.get("message") or ""), 600)
                row["who_name"] = office.person_name(str(row.get("who") or ""), known)
                rows.append(row)
    return sorted(rows, key=lambda r: str(r["id"]), reverse=True)[:limit]        # id 가 시각(마이크로초)으로 시작한다


def installed(pod: str) -> list[dict]:
    """이 설치본에서 프로파일마다 마지막으로 성공한 설치."""
    return _fold(requests(pod, 2000))


_ALL: dict = {}


def installed_all(pods: list[str]) -> dict[str, list[dict]]:
    """살아 있는 작업공간(pods)마다 installed() 와 같은 결과. 요청 파일을 한 번만 훑는다(스펙 2026-10-29-002 R14) —
    작업공간마다 installed() 를 부르면 queue·done 전체를 작업공간 수만큼 다시 읽는다. 폴더가 바뀌지 않았으면 앞 결과를 쓴다
    (파일이 생기거나 옮겨지면 폴더 mtime 이 바뀐다)."""
    try:
        key = tuple(_dir(kind).stat().st_mtime_ns for kind in ("queue", "done"))
    except OSError:
        key = None
    if key is None or _ALL.get("key") != key:
        by_pod: dict[str, list[dict]] = {}
        for r in requests(None, 10**9):
            by_pod.setdefault(str(r.get("pod") or ""), []).append(r)
        _ALL.update(key=key, value={p: _fold(rows) for p, rows in by_pod.items()})
    return {p: _ALL["value"].get(p, []) for p in pods}


def _fold(rows: list[dict]) -> list[dict]:
    """한 작업공간의 요청(새 것부터)을 프로파일마다 마지막으로 성공한 설치로 접는다."""
    seen: dict[tuple, dict] = {}
    for r in reversed(rows):
        mode = r.get("mode")
        if r["status"] != "done":
            continue
        if mode == "forget":                                      # 프로파일이 없어졌다 — 그 프로파일의 기록을 모두 내린다
            for key in [k for k in seen if k[0] == r["profile"]]:
                del seen[key]
        elif mode == "rename":                                    # 프로파일 이름이 바뀌었다 — 기록이 새 이름을 따라간다
            for key in [k for k in seen if k[0] == r["profile"]]:
                seen[(r["to"], key[1])] = {**seen.pop(key), "profile": r["to"]}
        elif mode == "restore":                                   # 보관한 스킬을 되살렸다 — 설치 기록과 관계없다
            continue
        elif mode == "remove":
            seen.pop((r["profile"], r["package"]), None)
        elif mode == "skills" and seen.get((r["profile"], r["package"]), {}).get("mode") not in (None, "skills"):
            # 패키지로 만든 프로파일에 스킬만 새로 넣었다 — 프로파일 기록(판·종류)은 그대로 두고 스킬 판만 적는다.
            # 기록을 덮으면 그 프로파일이 마켓 프로파일에서 빠져 주인 삭제·올리기가 막힌다(2026-10-14-002)
            seen[(r["profile"], r["package"])]["skills_version"] = r.get("version")
        else:
            seen[(r["profile"], r["package"])] = {k: r.get(k) for k in ("profile", "package", "namespace", "name", "version", "kind", "mode", "ts", "who")}
    return sorted(seen.values(), key=lambda r: (r["profile"], r["package"]))


def helper_status() -> dict:
    """도우미가 살아 있는가 — 도우미는 돌 때마다 heartbeat 파일에 시각을 적는다."""
    try:
        beat = json.loads((store.data_dir() / "market" / "helper.json").read_text(encoding="utf-8"))
        age = (datetime.now().astimezone() - datetime.fromisoformat(beat["ts"])).total_seconds()
        return {"alive": age < 180, "last": beat["ts"], "error": str(beat.get("error") or "")[:200]}
    except (OSError, ValueError, KeyError):
        return {"alive": False, "last": "", "error": ""}


def install_state() -> dict:
    """설치·지우기를 받는가. 오퍼레이터가 없는 환경(compose 시험)에서는 AAS_MARKET_INSTALL=off 로 끈다."""
    if config.get("AAS_MARKET_INSTALL", "helper").strip().lower() == "off":
        return {"enabled": False, "reason": tr("이 환경(docker compose)에서는 스킬 허브 설치와 지우기를 끕니다. 쿠버네티스에서만 설치할 수 있습니다.", "Skill hub install and removal are turned off in this environment (docker compose). You can install only on Kubernetes.")}
    return {"enabled": True, "reason": ""}


def agent_skills(pkg: dict) -> list[str]:
    """에이전트 패키지 안의 스킬 폴더(agent/skills/ 아래 SKILL.md 가 있는 곳). 패키지 상세의 파일 목록으로 본다."""
    dirs = sorted({p["path"].rsplit("/", 1)[0] for p in pkg.get("files", [])
                   if p["path"].startswith("agent/skills/") and p["path"].endswith("/SKILL.md")})
    return [d for d in dirs if not any(d.startswith(o + "/") for o in dirs)]   # 스킬 폴더 안의 SKILL.md 는 따로 세지 않는다


def request_install(pod_id: str, container: str, pkg: dict, version: str, profile: str, mode: str, who: str, profiles: list[str], on_modified: str = "") -> dict:
    """요청을 검사하고 줄에 세운다. profiles = 이 설치본에 지금 있는 프로파일 이름들.
    on_modified = 고친 스킬을 만났을 때의 선택: "" 묻는다 / "keep" 내 것을 지키고 나머지만 / "overwrite" 백업을 남기고 덮는다 / "copy" 고친 것을 skills/local/<이름>-local 로 복사해 두고 새 판으로 덮는다(스펙 2026-10-14-015)."""
    st = install_state()
    if not st["enabled"]:
        raise MarketError(st["reason"], 403)
    version = version or pkg["version"]
    if mode not in MODES or on_modified not in ("", "keep", "overwrite", "copy"):
        raise MarketError(tr("알 수 없는 요청입니다", "Unknown request"))
    if not PROFILE.match(profile or ""):
        raise MarketError(tr("프로파일 이름은 소문자·숫자·하이픈·밑줄로 적습니다", "Write the profile name with lowercase letters, digits, hyphens, and underscores"))
    if profile == "default":
        raise MarketError(tr("공용(루트) 프로파일에는 설치할 수 없습니다 — Hermes 가 막습니다", "You cannot install to the shared (root) profile. Hermes blocks it"))
    if pc_import.reserved_name(profile):                          # PC 가져오기 임시 프로파일 이름(OMAI-1444 R11·ROV6)
        raise MarketError(pc_import.reserved_error())
    if not VERSION.match(version) or version not in {v["version"] for v in pkg["versions"]}:
        raise MarketError(tr("공개된 버전이 아닙니다", "That version is not published"))
    if int(pkg.get("bytes") or 0) > PAYLOAD_LIMIT * MAX_PACKING_RATIO:      # 확실히 못 들어가는 것만 요청 전에 막는다(C5). 경계는 묶은 뒤 market_stage 가 거른다
        raise MarketError(tr(f"패키지가 너무 큽니다(파일 합계 {int(pkg['bytes']) // 1024} KiB, 묶음 한도 {PAYLOAD_LIMIT // 1024} KiB)",
                       f"The package is too large ({int(pkg['bytes']) // 1024} KiB of files, bundle limit {PAYLOAD_LIMIT // 1024} KiB)"))
    if not allowed(pod_id, pkg):
        label = ns_label(pkg["namespace"])
        raise MarketError(tr(f"이 AI 에이전트 작업공간은 허용이 필요한 네임스페이스 '{label}' 를 받을 수 없습니다 — 관리자가 허용해야 합니다",
                       f"This AI Agent Workspace cannot receive the namespace '{label}', which needs an allowance. An admin must allow it"), 403)
    mine = [r for r in installed(pod_id) if r["profile"] == profile]
    same = next((r for r in mine if r["package"] == pkg["id"]), None)
    exists = profile in profiles
    if mode == "skills":                                          # 에이전트 패키지의 스킬만 있는 프로파일에 넣는다 — SOUL·설정·크론·MCP 는 그대로
        if pkg["kind"] != "agent":
            raise MarketError(tr("스킬만 설치는 AI 에이전트 패키지에만 씁니다", "Installing only the skills applies to AI Agent packages"))
        if not exists:
            raise MarketError(tr(f"프로파일 '{profile}' 이 없습니다", f"Profile '{profile}' does not exist"))
        if not agent_skills(pkg):
            raise MarketError(tr("이 AI 에이전트 패키지에는 스킬이 없습니다", "This AI Agent package has no skills"))
    elif pkg["kind"] == "agent":
        if mode == "install" and exists:
            raise MarketError(tr(f"프로파일 '{profile}' 이 이미 있습니다 — AI 에이전트 패키지는 새 이름으로 설치합니다",
                           f"Profile '{profile}' already exists. Install an AI Agent package under a new name"))
        if mode == "update" and not (exists and same and same.get("mode") != "skills"):   # 스킬만 넣은 프로파일을 올리면 SOUL 을 덮는다
            raise MarketError(tr("이 패키지로 만든 프로파일만 새 버전으로 올릴 수 있습니다", "You can upgrade only profiles created from this package"))
    else:
        if not exists:
            raise MarketError(tr(f"프로파일 '{profile}' 이 없습니다", f"Profile '{profile}' does not exist"))
        mode = "update" if same else "install"
    if mode == "update" and same and _ver(version) <= _ver(str(same["version"])) and pkg["kind"] == "agent":
        raise MarketError(tr(f"이미 {same['version']} 버전입니다", f"Version {same['version']} is already installed"))
    if any(r["status"] in ("queued", "running") and r["profile"] == profile for r in requests(pod_id)):
        raise MarketError(tr("이 프로파일에 아직 끝나지 않은 설치 요청이 있습니다", "This profile still has an unfinished install request"), 409)
    row = {"id": datetime.now().strftime("%Y%m%d%H%M%S%f") + "-" + secrets.token_hex(3), "ts": _now(), "who": who, "pod": pod_id, "container": container,
           "package": pkg["id"], "namespace": pkg["namespace"], "name": pkg["name"], "version": version, "kind": pkg["kind"],
           "profile": profile, "mode": mode, "status": "queued"}
    if on_modified:
        row["on_modified"] = on_modified
    return _enqueue(row)


# ---- 새 사용자 기본 스킬 (스펙 2026-10-23-002 Q5) ----------------------------------------------------
# main 을 처음 만들 때 설치 값 AAS_DEFAULT_SKILLS(「네임스페이스/이름」을 쉼표로)의 패키지를 대기 표에 넣는다. 첫 로그인 순간에는
# main 이 아직 없어 request_install 이 거절하므로 바로 요청하지 않는다. 한 프로파일에 끝나지 않은 요청이 있으면 409 라 주기마다 하나씩 넣는다.

def env_default_packages() -> list[str]:
    """설치 값 AAS_DEFAULT_SKILLS 의 패키지 — main 을 처음 만들 때만 넣는다(스펙 2026-10-29-001 R14)."""
    out: list[str] = []
    for item in config.get("AAS_DEFAULT_SKILLS", "").split(","):
        ns, _, name = item.strip().partition("/")
        if NAME.match(ns) and NAME.match(name) and f"{ns}/{name}" not in out:
            out.append(f"{ns}/{name}")
    return out


def default_packages() -> list[str]:
    """기본 스킬 = 설치 값 ∪ 서버 묶음(AAS 기본 스킬, 설치 값과 상관없이 늘, 스펙 2026-10-29-001 R12). 자동 올리기 대상을 고른다."""
    from . import bundle_defaults
    out = env_default_packages()
    return out + [p for p in bundle_defaults.packages() if p not in out]


def queue_defaults(pod_id: str, profile: str) -> int:
    """새로 넣은 줄 수. 이미 있는 줄은 그대로 둔다."""
    made = 0
    with _conn() as conn:
        for pkg in env_default_packages():                     # 묶음 패키지는 bundle_defaults 가 모든 프로파일에 넣는다
            if not conn.execute("SELECT 1 FROM market_default_pending WHERE pod=? AND profile=? AND package=?", (pod_id, profile, pkg)).fetchone():
                conn.execute("INSERT INTO market_default_pending (pod, profile, package, ts) VALUES (?,?,?,?)", (pod_id, profile, pkg, _now()))
                made += 1
    return made


def _has(pod_id: str, profile: str, package_id: str) -> bool:
    return any(r["profile"] == profile and r["package"] == package_id for r in installed(pod_id))


def install_companion(pod_id: str, container: str, profile: str, package_id: str, who: str) -> str:
    """다른 설치에 딸린 스킬 하나를 그 프로파일에 설치 요청한다(스펙 2026-10-23-002 12-8). 결과: queued·queued_later(끝나지 않은 요청이 있어
    대기 표에 넣음, 다음 주기에 다시)·installed(이미 설치됨)·failed·skipped. 실패해도 부른 쪽(MCP 서버 추가)은 성공으로 둔다 — 예외를 올리지 않는다.
    이미 설치된 스킬을 다시 요청하지 않는다 — request_install 이 update 로 받고, 사용자가 고친 스킬이면 묻는 상태로 멈춘다(스펙 2026-10-23-004 R3)."""
    ns, _, name = package_id.partition("/")
    if not (NAME.match(ns) and NAME.match(name)) or profile == "default":       # 루트 프로파일에는 Hermes 가 설치를 막는다
        return "skipped"
    if _has(pod_id, profile, package_id):
        return "installed"
    try:
        request_install(pod_id, container, package(ns, name), "", profile, "install", who, [profile])
    except MarketError as exc:
        if exc.code == 409:                                       # 같은 프로파일에 끝나지 않은 요청 — 기본 스킬과 같은 대기 표로 다시 시도한다
            with _conn() as conn:
                if not conn.execute("SELECT 1 FROM market_default_pending WHERE pod=? AND profile=? AND package=?", (pod_id, profile, package_id)).fetchone():
                    conn.execute("INSERT INTO market_default_pending (pod, profile, package, ts) VALUES (?,?,?,?)", (pod_id, profile, package_id, _now()))
            return "queued_later"
        store.log_usage("market_companion_failed", f"{pod_id}/{profile} {package_id}: {redact(str(exc), 200)}", pod=pod_id)
        return "failed"
    except Exception as exc:                                      # 스킬 허브에 닿지 않는 등
        store.log_usage("market_companion_failed", f"{pod_id}/{profile} {package_id}: {type(exc).__name__}", pod=pod_id)
        return "failed"
    store.log_usage("market_companion_install", f"{pod_id}/{profile} {package_id}", pod=pod_id)
    return "queued"


def drain_defaults(pods: list) -> list[str]:
    """대기 표를 설치 요청으로 바꾼다. 「pod/프로파일 패키지」 목록을 돌려준다. 409(끝나지 않은 요청)는 남기고, 다른 실패는 기록하고 지운다
    — 스킬 허브가 없거나 패키지가 없는 설치에서 매 주기 다시 묻지 않게."""
    by_id = {p.id: p for p in pods}
    with _conn() as conn:
        rows = [dict(r) for r in conn.execute("SELECT pod, profile, package FROM market_default_pending ORDER BY ts, package")]
    done: list[str] = []
    busy: set[tuple[str, str]] = set()
    for row in rows:
        pod = by_id.get(row["pod"])
        where = (row["pod"], row["profile"])
        if pod is None or where in busy:
            continue
        busy.add(where)                                               # 한 프로파일에 한 주기 하나
        ns, _, name = row["package"].partition("/")
        if _has(pod.id, row["profile"], row["package"]):              # 그사이 설치됐다 — 다시 받지 않는다(스펙 2026-10-23-004 R3)
            with _conn() as conn:
                conn.execute("DELETE FROM market_default_pending WHERE pod=? AND profile=? AND package=?", (row["pod"], row["profile"], row["package"]))
            continue
        try:
            pkg = package(ns, name)
            request_install(pod.id, pod.container, pkg, "", row["profile"], "install", "aas", [row["profile"]])
        except MarketError as exc:
            if exc.code == 409:
                continue
            store.log_usage("market_default_failed", f"{pod.id}/{row['profile']} {row['package']}: {redact(str(exc), 200)}", pod=pod.id)
        except Exception as exc:                                      # 스킬 허브에 닿지 않는 등 — 첫 로그인 흐름은 막지 않는다
            store.log_usage("market_default_failed", f"{pod.id}/{row['profile']} {row['package']}: {type(exc).__name__}", pod=pod.id)
        else:
            store.log_usage("market_default_install", f"{pod.id}/{row['profile']} {row['package']}", pod=pod.id)
            done.append(f"{pod.id}/{row['profile']} {row['package']}")
        with _conn() as conn:
            conn.execute("DELETE FROM market_default_pending WHERE pod=? AND profile=? AND package=?", (row["pod"], row["profile"], row["package"]))
    return done


def _enqueue(row: dict) -> dict:
    tmp = _dir("queue") / (row["id"] + ".tmp")
    tmp.write_text(json.dumps(row, ensure_ascii=False), encoding="utf-8")
    tmp.rename(_dir("queue") / (row["id"] + ".json"))             # 도우미가 반쯤 쓰인 파일을 읽지 않게
    return row


def request_remove(pod_id: str, container: str, package_id: str, profile: str, who: str) -> dict:
    """스킬 패키지를 프로파일에서 지우는 요청. AAS 가 설치했다고 기록한 것만 지운다 — 손으로 넣은 스킬이나 다른 폴더는 대상이 아니다."""
    st = install_state()
    if not st["enabled"]:
        raise MarketError(st["reason"], 403)
    if not PROFILE.match(profile or ""):
        raise MarketError(tr("프로파일 이름이 올바르지 않습니다", "The profile name is not valid"))
    have = next((r for r in installed(pod_id) if r["profile"] == profile and r["package"] == package_id), None)
    if not have:
        raise MarketError(tr("스킬 허브에서 이 프로파일에 설치한 기록이 없습니다", "No skill hub install is recorded for this profile"), 404)
    if have["kind"] != "skill":
        raise MarketError(tr("AI 에이전트 패키지는 프로파일째 지웁니다 — 내 AI 에이전트 › 프로파일에서 삭제하세요", "AI Agent packages are removed together with their profile. Delete it under My AI Agents › Profiles"))
    if any(r["status"] in ("queued", "running") and r["profile"] == profile for r in requests(pod_id)):
        raise MarketError(tr("이 프로파일에 아직 끝나지 않은 요청이 있습니다", "This profile still has an unfinished request"), 409)
    return _enqueue({"id": datetime.now().strftime("%Y%m%d%H%M%S%f") + "-" + secrets.token_hex(3), "ts": _now(), "who": who, "pod": pod_id, "container": container,
                     "package": package_id, "namespace": have["namespace"], "name": have["name"], "version": str(have["version"]), "kind": "skill",
                     "profile": profile, "mode": "remove", "status": "queued"})


_SKILL = re.compile(r"^[a-z0-9][a-z0-9-]{1,62}$")


def request_restore(pod_id: str, container: str, profile: str, skill: str, who: str) -> dict:
    """큐레이터가 보관한 스킬 하나를 되살리는 요청(오퍼레이터가 `hermes curator restore` 로 한다, 스펙 2026-10-14-015 R6)."""
    st = install_state()
    if not st["enabled"]:
        raise MarketError(st["reason"], 403)
    if not PROFILE.match(profile or "") or profile == "default" or not _SKILL.match(skill or ""):
        raise MarketError(tr("프로파일이나 스킬 이름이 올바르지 않습니다", "The profile or skill name is not valid"))
    if any(r["status"] in ("queued", "running") and r["profile"] == profile for r in requests(pod_id)):
        raise MarketError(tr("이 프로파일에 아직 끝나지 않은 요청이 있습니다", "This profile still has an unfinished request"), 409)
    return _enqueue({"id": datetime.now().strftime("%Y%m%d%H%M%S%f") + "-" + secrets.token_hex(3), "ts": _now(), "who": who, "pod": pod_id, "container": container,
                     "package": "", "namespace": "", "name": skill, "version": "", "kind": "skill", "profile": profile, "mode": "restore", "status": "queued"})


def note_profile(pod_id: str, profile: str, mode: str, who: str, to: str = "", message: str = "") -> dict | None:
    """프로파일이 지워지거나 이름이 바뀐 것을 설치 기록에 적는다. 그 프로파일에 마켓으로 설치한 것이 없으면 아무것도 남기지 않는다."""
    if mode in ("forget", "rename") and (mode == "forget" or PROFILE.match(to or "")):
        from . import updates                                     # 건너뛰기·대기·자동 올리기 표도 프로파일을 따라간다(스펙 2026-10-24-003 외부 검토 13)
        updates.follow_profile(pod_id, profile, mode, to)          # 기록 없는(폴더 이름으로 찾은) 스킬의 건너뛰기도 있어 기록과 관계없이 옮긴다
    mine = [r for r in installed(pod_id) if r["profile"] == profile]
    if mode not in ("forget", "rename") or not mine or (mode == "rename" and not PROFILE.match(to or "")):
        return None
    row = {"id": datetime.now().strftime("%Y%m%d%H%M%S%f") + "-" + secrets.token_hex(3), "ts": _now(), "finished": _now(), "who": who, "pod": pod_id,
           "package": "", "namespace": "", "name": f"설치 기록 {len(mine)}건", "version": "", "kind": "", "profile": profile, "to": to, "mode": mode, "status": "done",  # i18n-ignore: 설치 기록 파일에 저장되는 문장
           "message": message or ("프로파일을 지워 설치 기록을 내렸습니다" if mode == "forget" else f"프로파일 이름이 {to} 로 바뀌어 설치 기록을 옮겼습니다")}  # i18n-ignore: 설치 기록 파일에 저장되는 문장
    tmp = _dir("done") / (row["id"] + ".tmp")
    tmp.write_text(json.dumps(row, ensure_ascii=False), encoding="utf-8")
    tmp.rename(_dir("done") / (row["id"] + ".json"))
    return row


def copy_records(pod_id: str, src: str, dest: str, who: str, src_pod: str = "") -> int:
    """프로파일을 복제하거나 다른 작업공간에서 가져와 만들 때 원본의 스킬 패키지 설치 기록을 새 프로파일로 옮겨 적는다(스펙 2026-10-24-003 R16).
    스킬이 원본에서 함께 복사됐으니 기록도 따라가야 새 버전을 알린다. 에이전트 패키지 기록은 옮기지 않는다(새 프로파일은 그 패키지로 만든 것이 아니다).
    src_pod = 원본 작업공간(없으면 같은 작업공간). 옮긴 기록 수."""
    if not (PROFILE.match(src or "") and PROFILE.match(dest or "")):
        return 0
    made = 0
    for r in installed(src_pod or pod_id):
        if r["profile"] != src or r.get("kind") != "skill":
            continue
        row = {"id": datetime.now().strftime("%Y%m%d%H%M%S%f") + "-" + secrets.token_hex(3), "ts": _now(), "finished": _now(), "who": who, "pod": pod_id,
               "package": r["package"], "namespace": r["namespace"], "name": r["name"], "version": str(r["version"]), "kind": "skill",
               "profile": dest, "mode": "install", "status": "done", "copied_from": f"{src_pod or pod_id}/{src}",
               "message": f"{src} 에서 복사한 스킬의 설치 기록을 옮겼습니다"}  # i18n-ignore: 설치 기록 파일에 저장되는 문장
        tmp = _dir("done") / (row["id"] + ".tmp")
        tmp.write_text(json.dumps(row, ensure_ascii=False), encoding="utf-8")
        tmp.rename(_dir("done") / (row["id"] + ".json"))
        made += 1
    return made


def reconcile(pod_id: str, existing: list[str], grace: float = 120.0) -> list[str]:
    """AAS 밖에서(Hermes 대시보드·CLI) 지워진 프로파일의 설치 기록을 내린다. existing = Hermes 가 지금 알려 준 프로파일 이름들.

    목록이 비어 있으면(읽지 못했을 수 있다) 아무것도 하지 않는다. 방금 설치한 것은 목록에 아직 안 보일 수 있어 grace 초 동안은 건드리지 않고,
    끝나지 않은 요청이 있는 프로파일도 그대로 둔다.
    """
    if not existing:
        return []
    now, busy = datetime.now().astimezone(), {r["profile"] for r in requests(pod_id) if r["status"] in ("queued", "running")}
    gone = []
    for profile in sorted({r["profile"] for r in installed(pod_id)} - set(existing) - busy):
        last = max(str(r["ts"]) for r in installed(pod_id) if r["profile"] == profile)
        try:
            fresh = (now - datetime.fromisoformat(last)).total_seconds() < grace
        except ValueError:
            fresh = False
        if not fresh and note_profile(pod_id, profile, "forget", "aas", message="Hermes 에 이 프로파일이 없어 설치 기록을 내렸습니다"):  # i18n-ignore: 설치 기록 파일에 저장되는 문장
            gone.append(profile)
    return gone


def overview(pod_id: str, cfg: dict | None = None, cat: dict | None = None, rows: list[dict] | None = None) -> dict:
    """스킬 허브 화면. cat = 서버가 모아 둔 허브 목록 {ok, items, error}(없으면 지금 읽는다, 스펙 2026-10-24-003 R20),
    rows = 판 비교 결과(updates.scan). 있으면 「새 버전」을 그것으로 정한다(R19) — 없으면 설치 기록 판과 비교한다."""
    cfg = cfg or settings()
    out = {"configured": bool(cfg["url"]), "namespaces": cfg["namespaces"], "namespace_labels": ns_labels(cfg), "packages": [], "error": "",
           "grants": [g for g in grants() if g["pod"] == pod_id], "installed": installed(pod_id), "requests": requests(pod_id, 50), "helper": helper_status(), "install": install_state()}
    if out["configured"] and cat is not None:
        out["packages"], out["error"] = [dict(p) for p in cat["items"]], cat["error"]
    elif out["configured"]:
        try:
            out["packages"] = catalog(cfg)
        except MarketError as exc:
            out["error"] = str(exc)
    have = {}
    for r in out["installed"]:
        have.setdefault(r["package"], []).append(r)
    granted = {g["namespace"] for g in out["grants"]}
    for p in out["packages"]:
        p["installed"] = have.get(p["id"], [])
        if rows is None:
            p["update"] = any(_ver(p["version"]) > _ver(str(r["version"])) for r in p["installed"])
        else:
            mine = [r for r in rows if r["package"] == p["id"]]
            p["update"] = any(r["state"] == "update" for r in mine)
            p["skipped"] = any(r["state"] == "skipped" for r in mine)
        p["allowed"] = not p["paid"] or p["namespace"] in granted
    return out
