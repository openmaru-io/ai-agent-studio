# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""스킬 흐름 그래프 — 시작(크론) → 스킬 → 스크립트 → MCP·외부 호스트 → 자격증명·라이브러리.

파이프라인을 따로 저장하지 않는다. 스킬이 단위(노드)이고, 파이프라인은 시작점에서 따라간 흐름이다.
연결마다 근거(파일·줄·그 줄)와 확실한 정도를 붙인다:
  config  — 크론 설정에 적혀 있음
  code    — 스크립트 코드 안에서 확인
  doc     — 스킬 문서(SKILL.md)의 지시·관련 스킬 표기
  mention — 문서에 이름만 나옴
읽기만 한다. 근거 줄은 화면에 나가므로 비밀값 모양은 가린다.
"""
from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path

from ..hermes import hermes_reader as hr
from ..hermes.readers import remote
from . import inventory, script_refs, skill_graph
from .files import mask_line
from ..common.i18n import tr
from ..common.redact import clean_url
from ..market import skill_desc

MAX_BYTES = 300_000
MAX_EVIDENCE = 8
MAX_NODES = 140
CONF_RANK = {"config": 0, "code": 1, "doc": 2, "mention": 3, "observed": 4}

_MCP_TOOL = re.compile(r"\bmcp__([A-Za-z0-9-]+)__([A-Za-z][A-Za-z0-9_]*)")
_SECRET_FILE = re.compile(r"(?:/opt/data/)?(secrets/[\w.-]+\.(?:json|ya?ml|env|txt|pem|key))")
_ENV = [re.compile(r"os\.environ(?:\.get)?\s*[\[(]\s*[\"']([A-Z][A-Z0-9_]{2,})[\"']"),
        re.compile(r"os\.getenv\(\s*[\"']([A-Z][A-Z0-9_]{2,})[\"']"),
        re.compile(r"process\.env\.([A-Z][A-Z0-9_]{2,})"),
        re.compile(r"\$\{?([A-Z][A-Z0-9_]{2,})\b")]
# import 이름과 배포 이름이 다른 흔한 경우
_ALIAS = {"yaml": "pyyaml", "googleapiclient": "google-api-python-client", "pil": "pillow", "bs4": "beautifulsoup4",
          "dotenv": "python-dotenv", "cv2": "opencv-python", "docx": "python-docx", "pptx": "python-pptx",
          "fitz": "pymupdf", "dateutil": "python-dateutil", "jwt": "pyjwt", "sklearn": "scikit-learn",
          "telegram": "python-telegram-bot", "google.oauth2": "google-auth", "google.auth": "google-auth",
          "google_auth_oauthlib": "google-auth-oauthlib", "openpyxl": "openpyxl", "markdown": "markdown"}
# Node 에 들어 있는 모듈(module.builtinModules). require('fs') 처럼 node: 없이 써도 라이브러리가 아니다(스펙 2026-10-28-013 §3-3-2)
_NODE_BUILTINS = {"assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants", "crypto", "dgram",
                  "diagnostics_channel", "dns", "domain", "events", "fs", "http", "http2", "https", "inspector", "module", "net",
                  "os", "path", "perf_hooks", "process", "punycode", "querystring", "readline", "repl", "stream", "string_decoder",
                  "sys", "timers", "tls", "trace_events", "tty", "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib"}
_SHELL_NOISE = {"PATH", "HOME", "PWD", "USER", "SHELL", "LANG", "TZ", "IFS", "PYTHONPATH", "TMPDIR", "HERMES_HOME"}


def _read(path: Path) -> str:
    try:
        if not path.is_file() or path.stat().st_size > MAX_BYTES:
            return ""
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


class Graph:
    def __init__(self):
        self.nodes: dict[str, dict] = {}
        self.out: dict[str, dict[tuple, dict]] = {}
        self.inc: dict[str, list[dict]] = {}

    def node(self, nid: str, **kw) -> dict:
        n = self.nodes.get(nid)
        if n is None:
            n = self.nodes[nid] = {"id": nid, "kind": nid.split(":", 1)[0], "label": nid, "sub": "", "status": None,
                                   "badges": [], "meta": {}, "path": None, "link": None}
            n.update(kw)
        return n

    def edge(self, a: str, b: str, kind: str, conf: str, file: str = "", line: int = 0, text: str = "", **meta) -> dict:
        if a == b:
            return {}
        e = self.out.setdefault(a, {}).get((b, kind))
        if e is None:
            e = self.out[a][(b, kind)] = {"from": a, "to": b, "kind": kind, "conf": conf, "evidence": [], "meta": {}}
            self.inc.setdefault(b, []).append(e)
        if CONF_RANK[conf] < CONF_RANK[e["conf"]]:
            e["conf"] = conf
        for k, v in meta.items():
            if k == "profile":
                e["meta"]["profiles"] = sorted(set(e["meta"].get("profiles", [])) | {v})
            elif isinstance(v, (set, list)):
                e["meta"][k] = sorted(set(e["meta"].get(k, [])) | set(v))[:20]
            else:
                e["meta"][k] = v
        if file and len(e["evidence"]) < MAX_EVIDENCE and not any(x["file"] == file and x["line"] == line for x in e["evidence"]):
            e["evidence"].append({"file": file, "line": line, "text": mask_line(text.strip())[:200]})
        return e


def build(home: Path | None = None) -> dict:
    home = home or hr.hermes_home()
    remote.prefetch(home)                                     # 원격이면 묶음을 먼저 받는다(OMAI-1102)
    sg = skill_graph.build(home)
    creds = inventory.credentials(home)["items"]
    tools = inventory.tools(home)["items"]
    libs = inventory.libraries(home)["items"]
    g = Graph()

    tool_by_path = {t["path"]: t for t in tools}
    tools_by_name: dict[str, list[dict]] = {}
    for t in tools:
        tools_by_name.setdefault(t["name"], []).append(t)
    cred_by_name: dict[str, list[dict]] = {}
    cred_by_file: dict[str, list[dict]] = {}
    for c in creds:
        cred_by_name.setdefault(c["name"], []).append(c)
        cred_by_file.setdefault(Path(c["location"]).name, []).append(c)
    lib_by_name: dict[str, list[dict]] = {}
    for lib in libs:
        lib_by_name.setdefault(lib["name"].lower().replace("_", "-"), []).append(lib)
    mcp_names = {n for names in sg["mcp_configured"].values() for n in names}
    mcp_where: dict[str, list[str]] = {}
    for prof, names in sg["mcp_configured"].items():
        for n in names:
            mcp_where.setdefault(n, []).append(prof)
    skills = sg["skills"]
    skill_by_key: dict[tuple[str, str], dict] = {}
    skill_names: dict[str, list[dict]] = {}
    for s in skills:
        skill_by_key.setdefault((s["profile"], s["name"]), s)
        skill_names.setdefault(s["name"], []).append(s)

    # ---- 노드 만들기 ---------------------------------------------------------
    def script_node(t: dict) -> str:
        nid = "script:" + t["path"]
        if nid not in g.nodes:
            g.node(nid, label=t["name"], sub=f"{t['language']} · {t['kind']}", path=t["path"], profile=t["profile"],
                   badges=[f for f in t["flags"] if "찾지 못함" not in f] + (["등록됨"] if t.get("reg") else []),  # i18n-ignore: 배지 "등록됨"·"실패 N회" 는 UI 가 색을 정하느라 맞대어 본다(나머지는 읽는 때 번역)
                   meta={"요약": t.get("summary") or "", "경로": t["path"], "수정": (t.get("modified") or "")[:10],  # i18n-ignore: meta 키 "경로" 는 UI 가 맞대어 본다(나머지는 캐시된 문장, 읽는 때 _localize_node 가 번역)
                         "범위": t["scope"] if t["scope"] == "전역" else t["profile"]},  # i18n-ignore: 캐시되는 그래프는 한국어로 두고 읽는 때 _localize_node 가 번역한다
                   link={"view": "tools", "params": {"tab": "all", "q": t["name"]}})
        return nid

    def cred_node(items: list[dict], label: str, profile: str) -> str | None:
        if not items:
            return None
        pick = [c for c in items if c["profile"] == profile] or [c for c in items if c["scope"] == "전역"] or items  # i18n-ignore: 인벤토리의 한글 값과 맞대어 비교한다
        c = pick[0]
        nid = f"cred:{c['location']}:{label}"
        if nid not in g.nodes:
            flags = sorted({f for x in pick for f in x["flags"]})
            bad = any(re.search("만료됨|비어 있음", f) for f in flags)  # i18n-ignore: 인벤토리의 한글 값과 맞대어 비교한다
            exp = min((x["expires"] for x in pick if x.get("expires")), default=None)
            g.node(nid, label=label, sub=f"{c['interface']} · {c['location']}", profile=c["profile"],
                   status="bad" if bad else "warn" if flags else None, badges=flags[:3],
                   meta={"범위": c["scope"] if c["scope"] == "전역" else c["profile"], "저장 위치": c["source"], "파일": c["location"],  # i18n-ignore: 캐시되는 그래프는 한국어로 두고 읽는 때 _localize_node 가 번역한다
                         "값": "채워져 있음" if all(x["set"] for x in pick) else "비어 있는 값이 있음",  # i18n-ignore: 캐시되는 그래프는 한국어로 두고 읽는 때 _localize_node 가 번역한다
                         "만료": (exp or "")[:10], "같은 이름": f"{len(items)}곳" if len(items) > 1 else ""},  # i18n-ignore: 캐시되는 그래프는 한국어로 두고 읽는 때 _localize_node 가 번역한다
                   link={"view": "credentials", "params": {"tab": "all", "q": label}})
        return nid

    def lib_node(mod: str, node_pkg: bool = False) -> str:
        key = _ALIAS.get(mod.lower()) or _ALIAS.get(mod.split(".")[0].lower()) or mod.split(".")[0].lower().replace("_", "-")
        hits = lib_by_name.get(key, [])
        nid = "lib:" + key
        if nid not in g.nodes and node_pkg and not hits:          # 설치 목록은 Python 환경만 읽는다 — Node 패키지는 있는지 모르므로 경고하지 않는다(D5)
            g.node(nid, label=key, sub="Node 패키지 · 설치 확인 안 함", status=None, badges=[], meta={})  # i18n-ignore: 캐시되는 그래프는 한국어로 두고 읽는 때 _localize_node 가 번역한다
        if nid not in g.nodes:
            vers = sorted({h["version"] for h in hits})
            g.node(nid, label=key, sub=", ".join(vers[:3]) if hits else "설치 목록에 없음",  # i18n-ignore: 캐시되는 그래프는 한국어로 두고 읽는 때 _localize_node 가 번역한다
                   status=None if hits else "warn", badges=[] if hits else ["설치 목록에 없음"] + ([] if len(vers) < 2 else ["버전 여러 개"]),  # i18n-ignore: 캐시되는 그래프는 한국어로 두고 읽는 때 _localize_node 가 번역한다
                   meta={"버전": ", ".join(vers), "설치 환경": ", ".join(sorted({h["env"] for h in hits})[:4])})  # i18n-ignore: 캐시되는 그래프는 한국어로 두고 읽는 때 _localize_node 가 번역한다
        return nid

    def mcp_node(server: str) -> str:
        nid = "mcp:" + server
        if nid not in g.nodes:
            where = mcp_where.get(server, [])
            g.node(nid, label=server, sub="MCP 서버" + (f" · {len(where)}개 프로파일에 설정" if where else " · 설정에 없음"),  # i18n-ignore: 캐시되는 그래프는 한국어로 두고 읽는 때 _localize_node 가 번역한다
                   status=None if where else "warn", badges=[] if where else ["설정에 없음"],  # i18n-ignore: 캐시되는 그래프는 한국어로 두고 읽는 때 _localize_node 가 번역한다
                   meta={"설정된 프로파일": ", ".join(where)}, link={"view": "credentials", "params": {"tab": "all", "q": server}})  # i18n-ignore: 캐시되는 그래프는 한국어로 두고 읽는 때 _localize_node 가 번역한다
        return nid

    def host_node(host: str) -> str:
        nid = "host:" + host
        if nid not in g.nodes:
            g.node(nid, label=host, sub="외부 호스트", meta={}, link={"view": "skills", "params": {"lens": "host:" + host}})  # i18n-ignore: 캐시되는 그래프는 한국어로 두고 읽는 때 _localize_node 가 번역한다
        return nid

    # ---- 한 파일을 줄 단위로 읽어 연결을 만든다 ---------------------------------
    scanned: dict[str, int] = {}                             # 스크립트 노드 → 읽은 가장 얕은 깊이

    def scan(src: str, rel: str, conf: str, profile: str, is_doc: bool):
        """src 노드가 가진 파일 rel 을 읽어 src → (호스트·MCP·스크립트·자격증명·라이브러리) 연결을 만든다.
        호스트·스크립트 규칙은 script_refs(스킬 목록과 같은 규칙)."""
        text = _read(home / rel)
        if not text:
            return
        ext = Path(rel).suffix.lower()
        for no, line, host, raw in script_refs.hosts(text):
            g.edge(src, host_node(host), "calls", conf, rel, no, line, urls=[mask_line(clean_url(raw))])
        for target, kind, no, line in script_refs.refs(home, rel, text, is_doc, lambda r: r in tool_by_path):
            g.edge(src, script_node(tool_by_path[target]), kind, conf, rel, no, line)
        for no, line in script_refs.lines(text):
            for m in _MCP_TOOL.finditer(line):
                g.edge(src, mcp_node(m.group(1)), "calls", conf, rel, no, line, tools=[m.group(2)])
            if "mcp" in line.lower():
                for name in mcp_names:
                    us = re.escape(name.replace("-", "_"))
                    found = re.findall(rf"\bmcp_{us}_([a-z][a-z0-9_]*)", line)
                    if found:
                        g.edge(src, mcp_node(name), "calls", conf, rel, no, line, tools=found)
                    elif re.search(rf"(?<![\w-]){re.escape(name)}(?![\w-])", line):
                        g.edge(src, mcp_node(name), "calls", "mention" if is_doc else conf, rel, no, line)
            for m in _SECRET_FILE.finditer(line):
                nid = cred_node(cred_by_file.get(Path(m.group(1)).name, []), Path(m.group(1)).name, profile)
                if nid:
                    g.edge(src, nid, "uses", conf, rel, no, line)
            if not is_doc or "`" in line or "$" in line:
                for pat in _ENV:
                    for m in pat.finditer(line):
                        name = m.group(1)
                        if name in _SHELL_NOISE or name not in cred_by_name:
                            continue
                        nid = cred_node(cred_by_name[name], name, profile)
                        if nid:
                            g.edge(src, nid, "uses", conf, rel, no, line)
            if is_doc:
                continue
            node_pkg = ext in (".js", ".mjs", ".cjs", ".ts")
            for mod in script_refs.modules(line, ext):
                if script_refs.is_sibling_module(home, rel, mod) or script_refs.is_stdlib(mod):
                    continue                                  # 옆 파일 import 는 스크립트 연결(script_refs.refs)이 만든다
                if node_pkg and mod.split("/")[0] in _NODE_BUILTINS:
                    continue
                g.edge(src, lib_node(mod, node_pkg), "imports", conf, rel, no, line)

    def scan_script(nid: str, profile: str, depth: int = 0):
        """스크립트를 읽고 그 스크립트가 부르는 스크립트로 내려간다. 스크립트마다 가장 얕은 깊이를 기억해,
        다른 스킬에서 더 얕게 만나면 아래를 다시 따라간다(script_refs.follow 와 같은 깊이 규칙, 재검토 D2)."""
        if depth > script_refs.MAX_DEPTH or scanned.get(nid, script_refs.MAX_DEPTH + 1) <= depth:
            return
        if nid not in scanned:
            scan(nid, g.nodes[nid]["path"], "code", profile, False)
        scanned[nid] = depth
        for (to, _kind) in list(g.out.get(nid, {})):
            if to.startswith("script:"):
                scan_script(to, profile, depth + 1)

    # ---- 스킬 ----------------------------------------------------------------
    for s in skills:
        nid = "skill:" + s["id"]
        md_rel = s["path"] + "/SKILL.md"
        g.node(nid, label=s["name"], sub=("공용" if s["profile"] == "default" else s["profile"]) + " · 스킬", profile=s["profile"],  # i18n-ignore: 캐시되는 그래프는 한국어로 두고 읽는 때 _localize_node 가 번역한다
               path=md_rel, meta={"설명": s["description"], "경로": s["path"], "수정": s["modified"][:10], "파일": f"{s['files']}개"},  # i18n-ignore: meta 키 "경로" 는 UI 가 맞대어 본다(나머지는 캐시된 문장, 읽는 때 _localize_node 가 번역)
               link={"view": "skills", "params": {"open": s["id"]}}, n_hosts=len(s["rest"]))
        md = _read(home / md_rel)
        md_lines = md.splitlines()
        scan(nid, md_rel, "doc", s["profile"], True)
        for r in s.get("rest_doc") or []:                     # README·참고 글에만 나온 호스트: 「이름만 언급」 연결(D2). 호스트 연결만 만든다
            for f in r["files"]:
                rel = f[len("/opt/data/"):] if f.startswith("/opt/data/") else f"{s['path']}/{f}"
                for no, line, host, raw in script_refs.hosts(_read(home / rel)):
                    if host == r["host"]:
                        g.edge(nid, host_node(host), "calls", "mention", rel, no, line, urls=[mask_line(clean_url(raw))])
        for rel in s["scripts"]:
            t = tool_by_path.get(f"{s['path']}/{rel}")
            if not t:
                continue
            sn = script_node(t)
            hit = next(((i, ln) for i, ln in enumerate(md_lines, 1) if t["name"] in ln), None)
            g.edge(nid, sn, "runs", "doc", md_rel if hit else "", hit[0] if hit else 0, hit[1] if hit else "", bundled=True)
            scan_script(sn, s["profile"])
        for (to, _kind) in list(g.out.get(nid, {})):
            if to.startswith("script:"):
                scan_script(to, s["profile"])
        related = set()
        fm_end = next((i for i, ln in enumerate(md_lines[1:60], 2) if ln.strip() == "---"), 0) if md_lines[:1] == ["---"] else 0
        for other in s["skills"]:
            target = skill_by_key.get((s["profile"], other)) or skill_by_key.get(("default", other)) or (skill_names.get(other) or [None])[0]
            if not target:
                continue
            pat = re.compile(rf"(?<![\w-]){re.escape(other)}(?![\w-])")
            hit = next(((i, ln) for i, ln in enumerate(md_lines, 1) if pat.search(ln)), None)
            in_fm = bool(hit and fm_end and hit[0] <= fm_end)
            if in_fm:
                related.add(other)
            g.edge(nid, "skill:" + target["id"], "refers", "doc" if in_fm else "mention",
                   md_rel if hit else "", hit[0] if hit and md_rel else 0, hit[1] if hit else "")   # AAS 기본 스킬은 열 파일이 없어 줄 번호를 두지 않는다

    # ---- 크론 작업 -------------------------------------------------------------
    for prof in hr.profiles(home):
        try:
            jobs = hr.read_jobs(prof) or []
        except Exception:
            continue
        jobs_rel = "cron/jobs.json" if prof.name == "default" else f"profiles/{prof.name}/cron/jobs.json"
        for job in jobs:
            jid = str(job.get("id") or job.get("name"))
            nid = f"cron:{prof.name}/{jid}"
            enabled = bool(job.get("enabled", True)) and not job.get("paused_at")
            last = job.get("last_status")
            failed = bool(last) and last not in ("ok", "success", "completed", "delivery_failed")   # delivery_failed 는 실행 성공 + 전달 실패(OMAI-1292)
            sched = job.get("schedule_display") or (job.get("schedule") or {}).get("display", "") if isinstance(job.get("schedule"), dict) else job.get("schedule_display") or ""
            g.node(nid, label=job.get("name") or jid, sub=f"{prof.name} · {sched or '일정 없음'}", profile=prof.name,  # i18n-ignore: 캐시되는 그래프는 한국어로 두고 읽는 때 _localize_node 가 번역한다
                   status="off" if not enabled else "bad" if failed else "ok" if last else None,
                   badges=([] if enabled else ["꺼짐"]) + ([f"실패 {max(int(job.get('failure_streak') or 0), 1)}회"] if enabled and failed else [])  # i18n-ignore: 배지 "등록됨"·"실패 N회" 는 UI 가 색을 정하느라 맞대어 본다(나머지는 읽는 때 번역)
                          + (["전달 실패"] if enabled and (last == "delivery_failed" or job.get("last_delivery_error")) else [])  # i18n-ignore: 실행은 성공했고 결과 전달만 실패(OMAI-1292). UI 가 주의 색으로 보인다
                          + (["알림 없음"] if job.get("deliver") in (None, "", "local") else []),  # i18n-ignore: 캐시되는 그래프는 한국어로 두고 읽는 때 _localize_node 가 번역한다
                   meta={"프로파일": prof.name, "일정": sched, "마지막 실행": str(job.get("last_run_at") or "")[:16].replace("T", " "),  # i18n-ignore: 캐시되는 그래프는 한국어로 두고 읽는 때 _localize_node 가 번역한다
                         "마지막 결과": last or "미실행", "결과 전달": job.get("deliver") or "local",  # i18n-ignore: 캐시되는 그래프는 한국어로 두고 읽는 때 _localize_node 가 번역한다
                         "AI 에이전트 없이 실행": "예 (스크립트만)" if job.get("no_agent") else "", "모델": job.get("model") or "", "작업 id": jid},  # i18n-ignore: 캐시되는 그래프는 한국어로 두고 읽는 때 _localize_node 가 번역한다
                   link={"view": "cron", "params": {"tab": "profiles", "q": prof.name}})
            for sk in job.get("skills") or ([job["skill"]] if job.get("skill") else []):
                short = str(sk).split("/")[-1]
                target = skill_by_key.get((prof.name, short)) or skill_by_key.get(("default", short))
                if target:
                    g.edge(nid, "skill:" + target["id"], "runs", "config", jobs_rel, 0, f"skills: {sk}")
            if job.get("script"):
                name = Path(str(job["script"])).name
                cands = tools_by_name.get(name, [])
                t = next((c for c in cands if c["profile"] == prof.name), None) or next((c for c in cands if c["scope"] == "전역"), None)  # i18n-ignore: 인벤토리의 한글 값과 맞대어 비교한다
                if t:
                    sn = script_node(t)
                    g.edge(nid, sn, "runs", "config", jobs_rel, 0, f"script: {job['script']}")
                    scan_script(sn, prof.name)

    # ---- MCP 서버 설정: 어떤 스크립트로 뜨고 어떤 인증값을 받는가(프로파일의 config.yaml) --------------
    try:
        import yaml
    except ImportError:                                       # yaml 이 없으면 이 연결만 빠진다
        yaml = None
    for prof in hr.profiles(home) if yaml else []:
        cfg_path = prof.path / "config.yaml"
        text = _read(cfg_path)
        try:
            servers = (yaml.safe_load(text) or {}).get("mcp_servers") or {}
        except Exception:
            continue
        rel = str(cfg_path.relative_to(home))
        lines = text.splitlines()
        start = next((i for i, ln in enumerate(lines) if ln.startswith("mcp_servers:")), 0)

        def where(word: str, frm: int = start) -> tuple[int, str]:
            return next(((i + 1, ln) for i, ln in enumerate(lines[frm:], frm) if ln.strip().startswith(word + ":")), (0, word))
        for server, conf in servers.items() if isinstance(servers, dict) else []:
            if not isinstance(conf, dict):
                continue
            mn = mcp_node(str(server))
            at, _ln = where(str(server))
            for arg in [conf.get("command"), *(conf.get("args") or [])]:
                m = script_refs.OPT_REF.search(str(arg or ""))
                t = tool_by_path.get(m.group(1)) if m else None
                if t:
                    no, ln = next(((i + 1, x) for i, x in enumerate(lines[max(at - 1, 0):], max(at - 1, 0)) if t["name"] in x), (at, str(arg)))
                    g.edge(mn, script_node(t), "runs", "config", rel, no, ln, profile=prof.name)
                    scan_script("script:" + t["path"], prof.name)
            for key, val in (conf.get("env") or {}).items() if isinstance(conf.get("env"), dict) else []:
                ref = re.fullmatch(r"\$\{?([A-Z][A-Z0-9_]*)\}?", str(val).strip())
                sf = _SECRET_FILE.search(str(val))
                if sf:
                    cn = cred_node(cred_by_file.get(Path(sf.group(1)).name, []), Path(sf.group(1)).name, prof.name)
                else:
                    name = ref.group(1) if ref else str(key)
                    cn = cred_node(cred_by_name.get(name, []), name, prof.name)
                if cn:
                    no, _x = where(str(key), max(at - 1, 0))
                    g.edge(mn, cn, "uses", "config", rel, no, f"{key}: " + (str(val) if ref or sf else "(값)"), profile=prof.name)  # i18n-ignore: 연결 근거 줄에 캐시되는 문장(번역하지 않음)

    # ---- 외부 호스트 ↔ 그 호스트용으로 저장된 인증값(자격증명 목록의 대상 주소) ------------------------
    from urllib.parse import urlsplit
    for c in creds:
        if not c.get("target") or any("백업" in f for f in c["flags"]):  # i18n-ignore: 인벤토리의 한글 값과 맞대어 비교한다
            continue
        try:
            host = urlsplit(c["target"]).hostname or ""
        except ValueError:
            continue
        hn = "host:" + host
        if hn in g.nodes:
            cn = cred_node([c], c["name"], c["profile"])
            if cn:
                e = g.edge(hn, cn, "uses", "config", profile=c["profile"] or "default")
                if e:
                    e["meta"]["note"] = "자격증명 목록에 이 호스트용으로 적혀 있음"  # i18n-ignore: 캐시되는 그래프는 한국어로 두고 읽는 때 _localize_node 가 번역한다

    return {"built_at": datetime.now().astimezone().isoformat(timespec="seconds"), "nodes": g.nodes,
            "skill_ids": {f"{s['profile']}/{s['name']}": "skill:" + s["id"] for s in skills},
            "out": {k: list(v.values()) for k, v in g.out.items()}, "inc": g.inc,
            "totals": {"nodes": len(g.nodes), "edges": sum(len(v) for v in g.out.values())}}


def without_job(index: dict, profile: str, job_id: str) -> dict:
    """지운 크론 작업 하나를 뺀 그림. 원래 그림은 고치지 않는다(읽는 요청이 같은 그림을 쓰고 있을 수 있다).
    그림 전체를 다시 만드는 데 수십 초가 걸려, 그동안 목록에 지운 작업이 남지 않게 지운 직후에 쓴다."""
    nid = f"cron:{profile}/{job_id}"
    if nid not in index.get("nodes", {}):
        return index
    nodes = {k: v for k, v in index["nodes"].items() if k != nid}
    out = {k: v for k, v in index["out"].items() if k != nid}
    inc = {k: [e for e in v if e.get("from") != nid] for k, v in index["inc"].items() if k != nid}
    return {**index, "nodes": nodes, "out": out, "inc": inc,
            "totals": {"nodes": len(nodes), "edges": sum(len(v) for v in out.values())}}


def starts(index: dict) -> list[dict]:
    """흐름의 시작점 — 크론 작업. 무엇을 돌리는지(스킬·스크립트)와 한 단계 아래 개수."""
    rows = []
    for nid, n in index["nodes"].items():
        if n["kind"] != "cron":
            continue
        outs = index["out"].get(nid, [])
        rows.append({"id": nid, "label": n["label"], "profile": n["profile"], "sub": _loc_sub(n["sub"]), "status": n["status"], "badges": _loc_badges(n["badges"]),
                     "skills": [index["nodes"][e["to"]]["label"] for e in outs if e["to"].startswith("skill:")],
                     "scripts": [index["nodes"][e["to"]]["label"] for e in outs if e["to"].startswith("script:")]})
    return sorted(rows, key=lambda r: (r["status"] != "bad", r["status"] == "off", r["profile"], r["label"]))


def subgraph(index: dict, root: str, mentions: bool = False, upstream: bool = True) -> dict | None:
    """root 에서 따라간 흐름. 스킬→스킬(문서의 관련 표기)은 뿌리 스킬과 크론이 직접 돌리는 스킬에서만 한 단계 따라간다."""
    nodes, out, inc = index["nodes"], index["out"], index["inc"]
    if root not in nodes:
        return None
    keep: dict[str, int] = {root: 0}
    edges: list[dict] = []
    seen_e: set[tuple] = set()
    truncated = False
    primary = {root} | {e["to"] for e in out.get(root, []) if nodes[root]["kind"] == "cron" and e["to"].startswith("skill:")}
    ctx = {nodes[root].get("profile") or "default", "default"} | {nodes[e["from"]].get("profile") for e in inc.get(root, []) if e["from"].startswith("cron:")}
    queue = [root]
    while queue:
        cur = queue.pop(0)
        for e in out.get(cur, []):
            if e["conf"] == "mention" and not mentions:
                continue
            if e["kind"] == "refers" and cur not in primary:
                continue
            profs = e["meta"].get("profiles")
            if profs and cur != root and not (set(profs) & ctx):       # 다른 프로파일의 설정에서 온 연결은 이 흐름에 싣지 않는다
                continue
            if e["to"] not in keep:
                if len(keep) >= MAX_NODES:
                    truncated = True
                    continue
                keep[e["to"]] = keep[cur] + 1
                if not (e["kind"] == "refers" and e["to"].startswith("skill:")):   # 가리킨 스킬은 보여 주되 그 아래로는 펼치지 않는다
                    queue.append(e["to"])
            key = (e["from"], e["to"], e["kind"])
            if key not in seen_e:
                seen_e.add(key)
                edges.append(e)
    ups = []
    if upstream:
        for e in inc.get(root, []):
            if e["conf"] == "mention" and not mentions:
                continue
            if e["from"] in keep:
                continue
            if len(ups) >= 14:
                truncated = True
                break
            ups.append(e["from"])
            edges.append(e)
    hidden = {nid: sum(1 for e in out.get(nid, []) if e["to"] not in keep and (mentions or e["conf"] != "mention"))
              for nid in keep if nid.startswith("skill:")}
    return {"root": root, "built_at": index["built_at"], "truncated": truncated,
            "nodes": [{**_localize_node(nodes[n]), "depth": d, "more": hidden.get(n, 0)} for n, d in keep.items()]
                     + [{**_localize_node(nodes[n]), "depth": -1, "more": 0} for n in ups],
            "edges": [_localize_edge(e) for e in edges],
            "hidden_mentions": 0 if mentions else sum(1 for e in out.get(root, []) if e["conf"] == "mention"),
            # 중심 스킬의 외부 호스트 수 — 스킬 목록·서랍과 같은 수(script_refs 규칙). 그림이 잘려도 이 수를 보인다(재검토 D3)
            "root_hosts": nodes[root].get("n_hosts")}


def overlay(index: dict, sub: dict, obs: dict) -> dict:
    """실행 기록을 그림에 얹는다. 정적 분석으로 찾은 연결에는 관측 횟수를 붙이고,
    크론 작업이 뿌리일 때는 실행에서만 보인 호출(스킬·스크립트·MCP)을 연결로 더한다."""
    nodes = {n["id"]: n for n in sub["nodes"]}
    root = nodes[sub["root"]]
    days = obs.get("days", 14)

    def bucket_for(profile: str) -> dict | None:
        return obs["profiles"].get(profile)

    job = obs["jobs"].get(sub["root"][5:]) if root["kind"] == "cron" else None
    scope_label = tr("이 작업의 실행", "runs of this job") if job is not None else tr("이 프로파일의 실행", "runs of this profile")
    if root["kind"] == "cron" and job is None:
        return {**sub, "observed": {"days": days, "scope": tr("기록 없음", "no records"), "runs": 0, "matched": 0, "notes": obs.get("notes", []),
                                    "hint": tr("이 작업의 세션 기록이 없습니다. AI 에이전트 없이 스크립트만 도는 작업은 세션이 남지 않습니다.", "There are no session records for this job. A job that runs only a script, without an AI Agent, leaves no session.")}}
    # 뿌리가 스킬이면 그 스킬을 돌리는 크론 작업들의 기록과, 스킬 프로파일의 기록을 합쳐서 본다
    pools = [job] if job is not None else [obs["jobs"].get(n["id"][5:]) for n in sub["nodes"] if n["kind"] == "cron"]
    pools = [p for p in pools if p]
    if job is None:
        pb = bucket_for(root.get("profile") or "")
        if pb:
            pools.append(pb)

    def seen(kind: str, key: str) -> int:
        return sum(p[kind].get(key, 0) if kind != "mcp" else sum(p["mcp"].get(key, {}).values()) for p in pools)

    edges = []
    for e in sub["edges"]:
        e = {**e, "meta": dict(e["meta"])}
        to = nodes.get(e["to"])
        n = 0
        if to and to["kind"] == "skill" and e["kind"] in ("runs", "refers"):
            n = seen("skills", to["label"])
        elif to and to["kind"] == "script" and nodes[e["from"]]["kind"] in ("skill", "cron"):
            n = seen("scripts", to["path"])
        elif to and to["kind"] == "mcp" and nodes[e["from"]]["kind"] in ("skill", "cron"):
            n = seen("mcp", to["label"])
        if n:
            e["meta"]["observed"] = n
        edges.append(e)
    extra_nodes = []
    if job is not None:
        have = {(e["from"], e["to"]) for e in edges}
        reach = set(nodes)

        def add(nid: str, node: dict | None, count: int, tools: list[str] | None = None):
            if (sub["root"], nid) in have or count <= 0:
                return
            if nid in reach:                                   # 그림 안에 이미 있는 노드(스킬이 부르는 것) — 연결만 표시해 둔다
                for e in edges:
                    if e["to"] == nid:
                        e["meta"]["observed"] = max(e["meta"].get("observed", 0), count)
                return
            n = _localize_node(dict(index["nodes"].get(nid) or node or {})) if nid in index["nodes"] else dict(node or {})
            if not n:
                return
            extra_nodes.append({**n, "depth": 1, "more": 0, "badges": list(n.get("badges", [])) + ["실행에서만 보임"]})  # i18n-ignore: 배지는 한국어 값으로 두고 UI 가 표시할 때 번역한다
            reach.add(nid)
            edges.append({"from": sub["root"], "to": nid, "kind": "calls" if nid.startswith("mcp:") else "runs", "conf": "observed",
                          "evidence": [], "meta": {"observed": count, **({"tools": tools} if tools else {})}})

        prof = root.get("profile") or ""
        for name, c in job["skills"].items():
            sid = index["skill_ids"].get(f"{prof}/{name}") or index["skill_ids"].get(f"default/{name}")
            if sid:
                add(sid, None, c)
        for rel, c in job["scripts"].items():
            add("script:" + rel, {"id": "script:" + rel, "kind": "script", "label": rel.split("/")[-1], "sub": tr("스크립트", "Script"), "status": None,
                                  "badges": [], "meta": {"경로": rel}, "path": rel, "link": None}, c)  # i18n-ignore: meta 키 "경로" 는 UI 가 맞대어 본다(나머지는 캐시된 문장, 읽는 때 _localize_node 가 번역)
        for server, tools in job["mcp"].items():
            add("mcp:" + server, {"id": "mcp:" + server, "kind": "mcp", "label": server, "sub": tr("MCP 서버", "MCP server"), "status": None, "badges": [],
                                  "meta": {}, "path": None, "link": None}, sum(tools.values()), sorted(tools, key=lambda t: -tools[t])[:12])
        root["meta"] = {**root["meta"],
                        tr(f"최근 {days}일 실행", f"Runs in the last {days} days"): tr(f"{job['runs']}회", f"{job['runs']} runs") + (tr(f" · 마지막 {job['last'][:16].replace('T', ' ')}", f" · last {job['last'][:16].replace('T', ' ')}") if job["last"] else ""),
                        tr("가장 많이 쓴 도구", "Most used tools"): ", ".join(f"{k} {v}" for k, v in sorted(job["tools"].items(), key=lambda kv: -kv[1])[:6])}
    return {**sub, "nodes": list(nodes.values()) + extra_nodes, "edges": edges,
            "observed": {"days": days, "scope": scope_label, "runs": sum(p["runs"] for p in pools), "notes": obs.get("notes", []),
                         "matched": sum(1 for e in edges if e["meta"].get("observed"))}}


# ---- 읽는 때 번역 -------------------------------------------------------------
# build() 의 결과는 언어와 상관없이 캐시되므로 한국어로 두고, 화면으로 나갈 때(starts·subgraph·overlay) 여기서 번역한다.
# UI 가 한국어 값과 맞대어 보는 것은 번역하지 않는다: meta 키 "경로"(GraphView)와 모든 배지(색과 필터를 정한다. 표시할 때 UI 의 serverTerms.ts 가 번역한다).
_SUB_RULES = [  # i18n-ignore: 캐시된 한국어 문장을 찾는 패턴
    (r"^공용(?= · )", "shared"), (r" · 스킬$", " · skill"), (r"^MCP 서버", "MCP server"),  # i18n-ignore: 패턴
    (r" · (\d+)개 프로파일에 설정$", r" · set in \1 profiles"), (r" · 설정에 없음$", " · not in config"),  # i18n-ignore: 패턴
    (r"^설치 목록에 없음$", "Not in the install list"), (r"^Node 패키지 · 설치 확인 안 함$", "Node package · install not checked"), (r"^외부 호스트$", "External host"), (r"^스크립트$", "Script"),  # i18n-ignore: 패턴
    (r" · 일정 없음$", " · no schedule"),  # i18n-ignore: 패턴
]
_META_KEYS = {"요약": "Summary", "수정": "Modified", "범위": "Scope", "저장 위치": "Stored in", "파일": "File", "값": "Value", "만료": "Expires",  # i18n-ignore: 사전 키
              "같은 이름": "Same name", "버전": "Versions", "설치 환경": "Environment", "설정된 프로파일": "Profiles with config", "설명": "Description",  # i18n-ignore: 사전 키
              "프로파일": "Profile", "일정": "Schedule", "마지막 실행": "Last run", "마지막 결과": "Last result", "결과 전달": "Delivery",  # i18n-ignore: 사전 키
              "AI 에이전트 없이 실행": "Runs without an AI Agent", "에이전트 없이 실행": "Runs without an AI Agent", "모델": "Model", "작업 id": "Job ID"}  # i18n-ignore: 사전 키
_META_VALUES = {"전역": "Global", "채워져 있음": "Filled", "비어 있는 값이 있음": "Has empty values", "미실행": "Not run yet",  # i18n-ignore: 사전 키
                "예 (스크립트만)": "Yes (script only)"}  # i18n-ignore: 사전 키
_NOTES = {"자격증명 목록에 이 호스트용으로 적혀 있음": "Listed in the credentials for this host"}  # i18n-ignore: 사전 키


def _loc_sub(text: str) -> str:
    en = text
    for pat, to in _SUB_RULES:
        en = re.sub(pat, to, en)
    return tr(text, en)


def _loc_badges(badges: list) -> list:
    """배지는 번역하지 않는다. UI 가 한국어 값으로 색과 필터를 정하고(lib/serverTerms.ts), 표시할 때 현재 언어로 바꾼다."""
    return list(badges)


def _loc_meta_value(value):
    if not isinstance(value, str):
        return value
    m = re.fullmatch(r"(\d+)([개곳])", value)  # i18n-ignore: 개수 표기 패턴
    en = f"{m.group(1)} places" if m and m.group(2) == "곳" else m.group(1) if m else _META_VALUES.get(value, value)  # i18n-ignore: 패턴 비교
    return tr(value, en)


def _localize_node(node: dict) -> dict:
    """캐시된 노드를 고치지 않고 요청 언어로 번역한 사본을 돌려준다. 한국어면 스킬 설명만 번역을 붙이고(스펙 2026-10-19-017 P5) 나머지는 그대로 쓴다."""
    desc = (node.get("meta") or {}).get("설명")  # i18n-ignore: 캐시된 노드의 데이터 키
    if node.get("kind") == "skill" and desc:
        shown = skill_desc.translate_text(node.get("label") or "", desc, 240)
        if shown != desc:
            node = {**node, "meta": {**node["meta"], "설명": shown}}  # i18n-ignore: 데이터 키
    if tr("ko", "en") == "ko":
        return node
    meta = {tr(k, _META_KEYS.get(k, k)): _loc_meta_value(v) for k, v in (node.get("meta") or {}).items()}
    return {**node, "sub": _loc_sub(node.get("sub") or ""), "badges": _loc_badges(node.get("badges") or []), "meta": meta}


def _localize_edge(edge: dict) -> dict:
    note = (edge.get("meta") or {}).get("note")
    if tr("ko", "en") == "ko" or note not in _NOTES:
        return edge
    return {**edge, "meta": {**edge["meta"], "note": tr(note, _NOTES[note])}}
