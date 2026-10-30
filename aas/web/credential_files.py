# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""프로파일의 파일 형태 비밀(인증 파일) 목록·넣기·지우기(스펙 2026-10-22-004, OMAI-1437).

- GET    /api/profile/credential-files?pod=&profile=          칸 목록. 있음·없음·수정 시각·마지막으로 화면에서 바꾼 사람. 내용은 읽지 않는다
- PUT    /api/profile/credential-file?pod=&profile=&slot=     본문 = 파일(64KB 이하 JSON). 오퍼레이터 CredentialFilePut 이 쓴다
- DELETE /api/profile/credential-file?pod=&profile=&slot=&confirm=<경로>   오퍼레이터 CredentialFileRemove 가 지운다

칸(slot)은 경로가 아니라 이름으로 받는다. google_client_secret·google_token 과 secret:<이름>(secrets/<이름>.json)뿐이다.
auth.json 은 다루지 않는다(D23 — 모델 연결은 LiteLLM 으로만). 오퍼레이터도 같은 허용 목록으로 다시 거른다.
내용은 서버 디스크·DB·로그에 두지 않는다. 메모리에서 검사하고 Hermes 작업 폴더의 숨은 임시 파일(.cred-<id>.json)로 넘기면
오퍼레이터가 성공·실패와 상관없이 지운다. 「마지막으로 바꾼 사람」은 credential_files 표에 두고, 오퍼레이터가 돌려준
mtime_ns 와 지금 파일의 mtime_ns 가 같은지로 화면 밖 변경을 가린다(R13·R15·R16).
"""
from __future__ import annotations

import json
import re
import secrets
from datetime import datetime, timedelta

import anyio
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from ..common import db, store
from ..fleet import k8s, primary
from ..hermes import workspace as wsp
from ..office import office
from ..ops import pc_import
from . import files, pc_import_routes as pcr, server

FIXED = {"google_client_secret": "google_client_secret.json", "google_token": "google_token.json"}
NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{0,62}$")          # secrets/<이름>.json 의 이름(오퍼레이터 Validate 와 같다)
PATH = re.compile(r"^(google_client_secret\.json|google_token\.json|secrets/[a-z0-9][a-z0-9_-]{0,62}\.json)$")
MAX_BYTES = 64 * 1024
TASK_WAIT = 60.0                                          # 파일 하나 쓰기는 몇 초면 끝난다. 넘으면 「결과 모름」(R7)
WORDS = ("WRITTEN", "REMOVED", "INVALID", "NOSOURCE", "NOPROFILE")

SCHEMA = """
CREATE TABLE IF NOT EXISTS credential_files (
  pod TEXT NOT NULL, profile TEXT NOT NULL, path TEXT NOT NULL,
  by_user TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT '', mtime_ns BIGINT NOT NULL DEFAULT 0, ts TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (pod, profile, path));
CREATE TABLE IF NOT EXISTS credential_staged (pod TEXT NOT NULL, path TEXT NOT NULL, ts TEXT NOT NULL, PRIMARY KEY (pod, path));
"""
SWEEP_AFTER = 600                                         # 올린 지 10분 넘게 남은 임시 파일만 지운다(작업 중인 것을 건드리지 않게)


class Fail(Exception):
    def __init__(self, code: str, status: int = 400, **extra):
        super().__init__(code)
        self.code, self.status, self.extra = code, status, extra


# ---- 칸·내용 검사 ---------------------------------------------------------------------------------------------
def slot_path(slot: str) -> str:
    """칸 이름 → 프로파일 기준 경로. 맞지 않으면 bad_slot. 경로를 받지 않으므로 ../·절대 경로·auth.json 이 들어올 수 없다."""
    if slot in FIXED:
        return FIXED[slot]
    if slot.startswith("secret:") and NAME.match(slot[len("secret:"):]):
        return f"secrets/{slot[len('secret:'):]}.json"
    raise Fail("bad_slot")


def slot_of(path: str) -> str:
    for k, v in FIXED.items():
        if v == path:
            return k
    return "secret:" + path[len("secrets/"):-len(".json")]


def check_content(path: str, data: bytes) -> None:
    """크기·UTF-8·JSON·칸별 최소 형태. 실패 문장에 내용을 넣지 않는다(코드만, T5)."""
    if not data:
        raise Fail("empty")
    if len(data) > MAX_BYTES:
        raise Fail("too_large", 413, limit=MAX_BYTES)
    if data.startswith(b"\xef\xbb\xbf"):
        raise Fail("not_utf8")                          # BOM 이 붙은 파일은 Hermes·google 라이브러리가 읽지 못한다
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise Fail("not_utf8") from None
    try:
        doc = json.loads(text)
    except ValueError:
        raise Fail("not_json") from None
    if path.startswith("secrets/"):
        if not isinstance(doc, (dict, list)):
            raise Fail("bad_shape")
    elif not isinstance(doc, dict):
        raise Fail("bad_shape")
    if path == "google_client_secret.json" and not any(isinstance(doc.get(k), dict) for k in ("installed", "web")):
        raise Fail("bad_shape")


# ---- 마지막으로 화면에서 바꾼 사람(R13) ---------------------------------------------------------------------------
def _conn():
    conn = store.connect()
    conn.executescript(SCHEMA)
    return conn


def record(pod: str, profile: str, path: str, by_user: str, role: str, mtime_ns: int) -> None:
    cols = ("pod", "profile", "path", "by_user", "role", "mtime_ns", "ts")
    with _conn() as conn:
        conn.execute(db.upsert("credential_files", cols, ("pod", "profile", "path")),
                     (pod, profile, path, by_user, role, int(mtime_ns), datetime.now().astimezone().isoformat(timespec="seconds")))


def forget(pod: str, profile: str, path: str) -> None:
    with _conn() as conn:
        conn.execute("DELETE FROM credential_files WHERE pod=? AND profile=? AND path=?", (pod, profile, path))


def changes_of(pod: str, profile: str) -> dict[str, dict]:
    with _conn() as conn:
        rows = conn.execute("SELECT * FROM credential_files WHERE pod=? AND profile=?", (pod, profile)).fetchall()
    return {r["path"]: dict(r) for r in rows}


def move_profile(pod: str, old: str, new: str) -> None:
    """프로파일 이름을 바꾸면 기록이 따라간다(server.py 의 rename, pc_import.move_profile 옆)."""
    with _conn() as conn:
        conn.execute("UPDATE credential_files SET profile=? WHERE pod=? AND profile=?", (new, pod, old))


def detach_profile(pod: str, name: str) -> None:
    """프로파일을 지우면 기록도 지운다 — 같은 이름의 새 프로파일에 옛 사람이 붙지 않게."""
    with _conn() as conn:
        conn.execute("DELETE FROM credential_files WHERE pod=? AND profile=?", (pod, name))


def who_view(rec: dict | None, mtime_ns: int | None) -> dict:
    """줄의 「바꾼 사람」(R16). rec 이 없으면 화면 밖에서만 바뀐 파일이다. 기록이 있으면 늘 그 사람을 보이고,
    지금 mtime_ns 가 기록과 다르면 「그 뒤 화면 밖에서 바뀜」(outside_after)을 붙인다. 사이드카가 mtime_ns 를 주지 않으면(옛 이미지) 판정하지 않는다."""
    if not rec:
        return {"changed_by": None, "outside": True}
    by = {"who": rec["by_user"], "role": rec["role"], "ts": rec["ts"]}
    out = {"changed_by": by, "outside": False, "by_other": rec["role"] in ("admin", "team", "other")}
    if mtime_ns is not None and int(rec["mtime_ns"]) != int(mtime_ns):
        out["outside_after"] = True
    return out


# ---- 오퍼레이터 지원 여부·결과 -------------------------------------------------------------------------------------
def support(pod, profile: str) -> str:
    """CRD 가 새 작업 종류를 아는가. "" = 된다, operator_outdated = 422, operator_unreachable = 그 밖의 실패(일시적일 수 있다)."""
    client = k8s.client()
    if client is None:
        return "not_k8s"
    body = {"apiVersion": f"{k8s.GROUP}/{k8s.VERSION}", "kind": "HermesTask",
            "metadata": {"name": "cred-dry-" + secrets.token_hex(4), "namespace": client.namespace},
            "spec": {"agent": pod.id, "profile": profile, "type": "CredentialFilePut", "backup": "dry",
                     "fileName": "google_token.json", "requestedBy": "aas-dry-run"}}
    try:
        client.create_task(body, dry_run=True, timeout=3.0)
        return ""
    except k8s.K8sError as exc:
        return "operator_outdated" if getattr(exc, "code", 0) == 422 else "operator_unreachable"
    except Exception:                                              # noqa: BLE001 — 시간 초과 등
        return "operator_unreachable"


def _word(msg: str) -> tuple[str, str]:
    """오퍼레이터 메시지 「[WORD] 나머지」 → (WORD, 나머지)."""
    m = re.match(r"^\[([A-Z]+)\]\s*(.*)$", msg.strip(), re.S)
    return (m.group(1), m.group(2)) if m else ("", msg)


def _outdated(exc: Exception) -> bool:
    """CRD 가 종류를 모르거나(생성 422) 옛 오퍼레이터가 종류를 거절했다. 우리 INVALID(내용 문제)와 섞지 않는다."""
    msg = str(exc)
    return getattr(exc, "code", 0) == 422 or "알 수 없는 작업 종류" in msg or "unknown task type" in msg.lower()   # i18n-ignore: 옛 오퍼레이터 메시지와 대조


# ---- 동작 ----------------------------------------------------------------------------------------------------
def listing(pod, profile: str, *, backend, reason: str, can_edit: bool, admin: bool, names=None) -> dict:
    """구역 목록. 정해진 두 칸은 늘 보이고, secrets/*.json 은 있는 것만. 폴더·일반 파일이 아닌 항목은 unknown.
    바꾼 사람은 사람 이름(name)으로 보인다. 이메일 전체(who)는 관리자에게만 준다(변경 기록 who_name 과 같은 규칙, 계획 007 R6)."""
    recs = changes_of(pod.id, profile)
    base = f"profiles/{profile}"
    rows = []
    if names is None:                                              # 사람 목록은 기록이 있을 때 한 번만 읽는다
        known: list = []

        def names(email: str) -> str:
            if not known:
                known.append(office.people())
            return office.display_name(email, known[0])

    def row(path: str, st: dict) -> dict:
        exists = bool(st.get("exists"))
        r = {"slot": slot_of(path), "path": path, "exists": exists}
        if exists:
            r["type"] = "file" if st.get("type") == "file" else "unknown"
            r["mtime"] = st.get("mtime")
            r.update(who_view(recs.get(path), st.get("mtime_ns")))
            by = r.get("changed_by")
            if by:
                by["name"] = names(by["who"])
                if not admin:
                    by.pop("who", None)
        return r
    for path in FIXED.values():
        rows.append(row(path, backend.stat_now(f"{base}/{path}")))
    for e in backend.list_now(f"{base}/secrets", "*.json"):
        name = str(e.get("path") or "").split("/")[-1]
        path = f"secrets/{name}"
        if PATH.match(path):
            rows.append(row(path, {"exists": True, **e}))
        else:
            rows.append({"slot": "", "path": path, "exists": True, "type": "unknown", "mtime": e.get("mtime")})
    return {"profile": profile, "rows": rows, "reason": reason, "can_edit": can_edit and not reason, "admin": admin,
            "max_bytes": MAX_BYTES}


def put(pod, profile: str, path: str, data: bytes, who: str, role: str, *, ws, task=None) -> dict:
    """검사 → 숨은 임시 파일로 올리기 → 오퍼레이터 작업 → 기록. 실패는 Fail(code)."""
    check_content(path, data)
    task = task or pcr.run_task
    backup = secrets.token_hex(8)
    staged = f"{wsp.UPLOADS}/.cred-{backup}.json"
    if not ws.ensure(wsp.UPLOADS):
        raise Fail("agent_unreachable", 502)
    _staged(pod.id, staged, True)                                  # 서버가 여기서 멈춰도 점검(sweep_once)이 지운다
    try:
        if files.push_bytes(ws.api.auth, staged, data) != 200:
            _cleanup(ws, staged)
            raise Fail("agent_unreachable", 502)
        try:
            msg = task(pod, "CredentialFilePut", profile, "", backup, who, wait=TASK_WAIT, extra={"fileName": path})
        except Exception as exc:                                   # noqa: BLE001
            _cleanup(ws, staged)
            raise _task_fail(exc) from None
        word, rest = _word(msg)
        if word != "WRITTEN" or not rest.strip().isdigit():
            _cleanup(ws, staged)
            raise Fail("task_failed", 502)
    finally:
        _staged(pod.id, staged, False)
    mtime_ns = int(rest.strip())
    record(pod.id, profile, path, who, role, mtime_ns)
    return {"ok": True, "path": path, "mtime_ns": mtime_ns}


def remove(pod, profile: str, path: str, who: str, *, task=None) -> dict:
    task = task or pcr.run_task
    try:
        msg = task(pod, "CredentialFileRemove", profile, "", secrets.token_hex(8), who, wait=TASK_WAIT, extra={"fileName": path})
    except Exception as exc:                                       # noqa: BLE001
        raise _task_fail(exc) from None
    if _word(msg)[0] != "REMOVED":
        raise Fail("task_failed", 502)
    forget(pod.id, profile, path)
    return {"ok": True, "path": path}


def _cleanup(ws, staged: str) -> None:
    """오퍼레이터가 지우지만, 시간 초과·생성 실패면 작업이 돌지 않았을 수 있어 한 번 더 지운다(R7)."""
    try:
        ws.delete(staged)
    except Exception:                                              # noqa: BLE001 — 남으면 점검이 지운다(sweep)
        pass


def _task_fail(exc: Exception) -> Fail:
    if _outdated(exc):
        return Fail("operator_outdated", 501)
    word = _word(str(exc))[0]
    if word == "TIMEOUT":
        return Fail("timeout", 504)
    if word in ("INVALID", "NOSOURCE", "NOPROFILE"):
        return Fail(word.lower(), 400 if word == "INVALID" else 409)
    return Fail("task_failed", 502)


def _staged(pod: str, path: str, on: bool) -> None:
    with _conn() as conn:
        if on:
            conn.execute(db.upsert("credential_staged", ("pod", "path", "ts"), ("pod", "path")),
                         (pod, path, datetime.now().astimezone().isoformat(timespec="seconds")))
        else:
            conn.execute("DELETE FROM credential_staged WHERE pod=? AND path=?", (pod, path))


def sweep_once(reg, now: datetime | None = None) -> int:
    """서버가 올리기와 작업 사이에 멈춰 남은 임시 파일(.cred-*)을 지운다(실패 모드 표). 리더 점검이 부른다.
    올린 기록이 있는 것만 보므로 POD 마다 사이드카를 훑지 않는다. 지운 수."""
    cut = ((now or datetime.now().astimezone()) - timedelta(seconds=SWEEP_AFTER)).isoformat(timespec="seconds")
    with _conn() as conn:
        rows = [dict(r) for r in conn.execute("SELECT pod, path FROM credential_staged WHERE ts < ?", (cut,)).fetchall()]
    n = 0
    for r in rows:
        pod = next((p for p in reg.pods if p.id == r["pod"]), None)
        ws = server.workspace_for(pod) if pod is not None else None
        if ws is not None:
            try:
                ws.delete(r["path"])
            except Exception:                                      # noqa: BLE001 — 없는 파일이면 이미 오퍼레이터가 지웠다
                pass
        _staged(r["pod"], r["path"], False)
        n += 1
    return n


# ---- 경로 ----------------------------------------------------------------------------------------------------
def _err(code: str, status: int, **extra) -> JSONResponse:
    return JSONResponse({"code": code, **extra}, status_code=status, headers={"Cache-Control": "no-store"})


def _view_context(request: Request):
    """목록: 이 POD 를 볼 수 있는 사람(접근 권한만 받은 사람 포함). (pod, user, admin, can_edit, reason, ws)."""
    view = files._View(request)
    if not view._host_ok() or request.headers.get("Sec-Fetch-Site", "same-origin") not in ("same-origin", "none"):
        raise Fail("forbidden", 403)
    a = server.auth()
    user = server.request_user(a, request)
    if a.enabled and not user:
        raise Fail("login", 401)
    pid = request.query_params.get("pod", "")
    pod = next((p for p in server.registry().allowed(user, a.enabled) if p.id == pid), None)
    if pod is None:
        raise Fail("pod", 403)
    admin = (not a.enabled) or server.registry().is_admin(user)
    manager = admin or server._manages_pod(pod, user, a.enabled)
    ws = server.workspace_for(pod)
    if ws is None or not pod.sidecar_url or not pcr._k8s_ready():
        reason = "not_k8s"
    elif not manager:
        reason = "grant"
    elif not view._secrets_ok():
        reason = "insecure"
    else:
        reason = ""
    return pod, user, admin, manager, reason, ws


def _profile(pod, raw: str) -> str:
    """대상 프로파일. 빈 값은 주 프로파일. 루트·임시·규칙 위반은 거절(오퍼레이터는 profiles/<이름> 만 다룬다, R10)."""
    try:
        return pcr._target_profile(pod, raw)
    except pcr._Denied as d:
        raise Fail(d.code, d.status) from None


async def list_route(request: Request) -> JSONResponse:
    try:
        pod, _user, admin, manager, reason, ws = await anyio.to_thread.run_sync(_view_context, request)
        if ws is None:
            return JSONResponse({"rows": [], "reason": "not_k8s", "can_edit": False, "admin": admin}, headers={"Cache-Control": "no-store"})
        raw = request.query_params.get("profile", "")
        if raw == primary.ROOT:
            return JSONResponse({"rows": [], "reason": "root_profile", "can_edit": False, "admin": admin}, headers={"Cache-Control": "no-store"})
        profile = await anyio.to_thread.run_sync(_profile, pod, raw)
        if not reason:
            reason = await anyio.to_thread.run_sync(support, pod, profile)
        out = await anyio.to_thread.run_sync(lambda: listing(pod, profile, backend=ws.backend, reason=reason, can_edit=manager, admin=admin))
    except Fail as f:
        return _err(f.code, f.status, **f.extra)
    except OSError:
        return _err("sidecar_unreachable", 502)
    return JSONResponse(out, headers={"Cache-Control": "no-store"})


async def file_route(request: Request) -> JSONResponse:
    try:
        pod, user, admin, by_admin = await pcr._ctx(request, write=True)
    except pcr._Denied as d:
        return _err(d.code, d.status)
    if not files._View(request)._secrets_ok():
        return _err("insecure", 403)
    try:
        profile = await anyio.to_thread.run_sync(_profile, pod, request.query_params.get("profile", ""))
        path = slot_path(request.query_params.get("slot", ""))
    except Fail as f:
        return _err(f.code, f.status)
    if await anyio.to_thread.run_sync(pc_import.running, pod.id):
        return _err("busy_import", 409)                            # PC 가져오기 되돌리기가 새 파일을 덮지 않게(R2)
    who = pcr._who(user)
    role = server._actor_role(pod, user, server.auth().enabled)
    kind = "profile_credential_put" if request.method == "PUT" else "profile_credential_clear"
    try:
        if request.method == "PUT":
            raw_len = request.headers.get("content-length", "")
            if raw_len.isdigit() and int(raw_len) > MAX_BYTES:
                return _err("too_large", 413, limit=MAX_BYTES)     # 끝까지 읽지 않는다
            data = bytearray()
            async for chunk in request.stream():
                data += chunk
                if len(data) > MAX_BYTES:
                    return _err("too_large", 413, limit=MAX_BYTES)
            ws = server.workspace_for(pod)
            out = await anyio.to_thread.run_sync(lambda: put(pod, profile, path, bytes(data), who, role, ws=ws))
            del data
        else:
            if request.query_params.get("confirm", "") != path:
                return _err("confirm_mismatch", 400)
            out = await anyio.to_thread.run_sync(lambda: remove(pod, profile, path, who))
    except Fail as f:
        await anyio.to_thread.run_sync(_log, kind + "_failed", pod, user, profile, path)
        return _err(f.code, f.status, **f.extra)
    await anyio.to_thread.run_sync(_log, kind, pod, user, profile, path)
    return JSONResponse(out, headers={"Cache-Control": "no-store"})


def _log(kind: str, pod, user, profile: str, path: str) -> None:
    """변경 기록(R12). note 는 「<이메일> <프로파일> <경로>」로 고정 — changes.rows 가 file 을 따로 낸다. 내용·크기·해시는 없다."""
    token = store.actor_role.set(server._actor_role(pod, user, server.auth().enabled))
    try:
        store.log_usage(kind, f"{pcr._who(user)} {profile} {path}", pod=pod.id)
    finally:
        store.actor_role.reset(token)


def routes() -> list:
    return [Route("/api/profile/credential-files", list_route, methods=["GET"]),
            Route("/api/profile/credential-file", file_route, methods=["PUT", "DELETE"])]

