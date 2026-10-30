# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""내 PC 의 Hermes 를 프로파일에 넣기·프로파일 내보내기 경로(OMAI-1136, 대상 넓히기 OMAI-1444). 큰 파일을 흘려보내므로 files.py 처럼 Starlette 라우트로 둔다.

- PUT  /api/profile/pc-import?pod=&profile=&name=   본문 = 묶음 바이트. Hermes 에 흘려보내며 서버 임시 파일로 검사한다
- GET  /api/profile/pc-import?pod=&profile=          마지막 가져오기(진행·결과). 서랍을 다시 열면 이것을 보인다
- POST /api/profile/pc-import/start?pod=&id=         「{name} 내용 바꾸기」
- POST /api/profile/pc-import/cancel?pod=&id=        확인 단계에서 그만두기(올린 묶음을 지운다)
- POST /api/profile/pc-export?pod=&profile=          프로파일을 작업 폴더 밖에 내보낸다
- GET  /api/profile/pc-export?pod=&id=               내보낸 묶음을 한 번 내려받는다. 다 받으면 지운다
권한은 그 에이전트의 주인과 관리자다(R3). 접근 권한(grant)만 받은 사용자는 거절한다(R10). 관리자가 남의 에이전트에 하면 사용 기록과 주인 알림이 남는다.
"""
from __future__ import annotations

import os
import secrets
import tempfile
import threading
import time
import urllib.parse

import anyio
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from ..common import store
from ..common.i18n import tr
from ..fleet import k8s, primary, profiles
from ..hermes import workspace as wsp
from ..hermes.hermes_api import HermesAPI, HermesError
from ..hermes import hermes_reader
from ..office import meeting, office
from ..ops import pc_import
from . import files, server, topics


class _Denied(Exception):
    def __init__(self, code: str, status: int):
        super().__init__(code)
        self.code, self.status = code, status


def _err(code: str, status: int, **extra) -> JSONResponse:
    return JSONResponse({"code": code, **extra}, status_code=status, headers={"Cache-Control": "no-store"})


def _context(request: Request, *, write: bool):
    """(pod, user, admin, by_admin). 주인·팀 관리자와 관리자만. 상태를 바꾸는 요청은 같은 출처만(files._context 와 같은 판정)."""
    view = files._View(request)
    if not view._host_ok():
        raise _Denied("forbidden", 403)
    if write and not view._same_origin():
        raise _Denied("forbidden", 403)
    if not write and request.headers.get("Sec-Fetch-Site", "same-origin") not in ("same-origin", "none"):
        raise _Denied("forbidden", 403)
    a = server.auth()
    user = server.request_user(a, request)
    if a.enabled and not user:
        raise _Denied("login", 401)
    reg = server.registry()
    pod = next((p for p in reg.pods if p.id == request.query_params.get("pod", "")), None)
    if pod is None:
        raise _Denied("pod", 404)
    admin = (not a.enabled) or reg.is_admin(user)
    owner = server._owns_pod(pod, user, a.enabled)
    if not (admin or server._manages_pod(pod, user, a.enabled)):     # 팀 관리자도 통과, 주인 알림(by_admin)은 관리자 대행일 때만
        raise _Denied("not_owner", 403)                          # 접근 권한(grant)만 받은 사람은 못 한다(R3·R10)
    if not pod.sidecar_url or not _k8s_ready():
        raise _Denied("unsupported", 501)                        # 컨테이너 안 바꾸기는 오퍼레이터 작업이라 쿠버네티스에서만
    return pod, user, admin, bool(admin and not owner)


def _log_work(kind: str, pod, user, profile: str) -> None:
    """「일 시키기」 기록. 작성자 자격(관리자·팀 관리자·다른 사람, D15)을 붙인다 — 비동기 처리 본문에서 부르므로 표시를 잠깐 켜고 되돌린다(리뷰 R3=B 의 작업 스레드 한계와 따로)."""
    token = store.actor_role.set(server._actor_role(pod, user, server.auth().enabled))
    try:
        store.log_usage(kind, f"{_who(user)} {profile}", pod=pod.id)
    finally:
        store.actor_role.reset(token)


def _k8s_ready() -> bool:
    return k8s.client() is not None


async def _ctx(request: Request, *, write: bool):
    return await anyio.to_thread.run_sync(lambda: _context(request, write=write))


def _who(user) -> str:
    return str((user or {}).get("email") or "local").lower()


def _target_profile(pod, profile: str, exists: bool = False) -> str:
    """가져오기·내보내기 대상(OMAI-1444 §4-1). 빈 값은 지금처럼 main(없으면 no_main). 루트·임시(pcimp-)·이름 규칙 위반은 거절한다.
    exists 가 참이면(올리기·내보내기) Hermes 프로파일 목록을 한 번 불러 있는지 본다(R4·D10). 상태 읽기는 DB 만 본다."""
    if not profile:
        main = primary.primary_of(pod.id)
        if main == primary.ROOT:
            raise _Denied("no_main", 409)
        return main
    if not profiles.NAME.match(profile):
        raise _Denied("bad_profile", 400)
    if profile == primary.ROOT:
        raise _Denied("root_profile", 409)                       # Hermes·오퍼레이터가 profiles/<이름> 만 다룬다
    if pc_import.reserved_name(profile):
        raise _Denied("bad_profile", 400)
    if exists:
        try:
            listed = _api(pod).call("GET", "/api/profiles").get("profiles", [])
        except HermesError:
            raise _Denied("agent_unreachable", 502) from None
        if profile not in {str(r.get("name") or "") for r in listed if isinstance(r, dict) and not r.get("is_default")}:
            raise _Denied("no_profile", 404)
    return profile


def _api(pod) -> HermesAPI:
    return HermesAPI(server.hub(pod).auth)


# ---- 오퍼레이터 작업·게이트웨이 ----------------------------------------------------------------------------
def run_task(pod, kind: str, profile: str, source: str, backup: str, who: str, wait: float = pc_import.REPLACE_WAIT,
             extra: dict | None = None) -> str:
    """HermesTask 를 만들고 끝나기를 기다린다. 실패하면 오퍼레이터 메시지(맨 앞 [결과 단어])를 담은 예외.
    성공하면 오퍼레이터 메시지를 돌려준다. extra 는 spec 에 더할 필드(인증 파일 작업의 fileName, 스펙 2026-10-22-004)."""
    client = k8s.client()
    name = "pci-" + secrets.token_hex(6)
    spec = {"agent": pod.id, "profile": profile, "type": kind, "backup": backup, "requestedBy": who[:200]}
    if source:
        spec["sourceProfile"] = source
    spec.update(extra or {})
    client.create_task({"apiVersion": f"{k8s.GROUP}/{k8s.VERSION}", "kind": "HermesTask",
                        "metadata": {"name": name, "namespace": client.namespace, "labels": {"aas.openmaru.io/agent": pod.id}}, "spec": spec})
    deadline = time.monotonic() + wait
    while True:
        try:
            status = client.get_task(name).get("status") or {}
        except k8s.K8sError:
            status = {}
        phase = status.get("phase")
        if phase in ("Succeeded", "Failed"):
            try:
                client.delete_task(name)
            except k8s.K8sError:
                pass                                                   # 오퍼레이터가 24시간 뒤 지운다
            if phase == "Failed":
                raise RuntimeError(str(status.get("message") or "[FAILED]"))
            return str(status.get("message") or "")
        if time.monotonic() >= deadline:
            raise RuntimeError(tr("[TIMEOUT] 작업이 정해진 시간 안에 끝나지 않았습니다", "[TIMEOUT] The task did not finish in time"))
        time.sleep(2.0)


def _restart(pod, profile: str) -> None:
    path, query = profiles.gateway_request("restart", profile, shared=profiles.gateway_shared(in_k8s=bool(pod.sidecar_url), profile=profile))
    _api(pod).call("POST", path, {}, query or None)


def _env_listing(pod, profile: str):
    """Hermes GET /api/env 응답. 읽지 못하면 None(빈 목록과 구별한다, 2026-10-22-003 R25)."""
    try:
        return _api(pod).call("GET", "/api/env", query={"profile": profile})
    except HermesError:
        return None


def _env_names(pod, profile: str) -> set[str] | None:
    listing = _env_listing(pod, profile)
    return None if listing is None else pc_import.env_names_of(listing)


DOWNLOAD_MAX = 100 * 1024 * 1024


def _download(pod, rel: str, limit: int = DOWNLOAD_MAX) -> bytes:
    """데이터 폴더 기준 경로의 파일을 사이드카로 읽는다(링크·하드링크는 사이드카가 거절). 비밀 묶음·오퍼레이터 목록 파일을 읽는다(OV-6).
    tree 캐시·secret_scrub 를 거치지 않는다. 없거나 읽지 못하면 OSError."""
    ws = server.workspace_for(pod)
    if ws is None or not ws.supported():
        raise OSError("unsupported")
    status, _code, resp, conn = ws.backend.open_download(rel)
    if status != 200:
        raise OSError(f"download {status}")
    try:
        data = resp.read(limit + 1)
    finally:
        conn.close()
    if len(data) > limit:
        raise OSError("too_big")
    return data


def _notice_who(user, by_admin: bool) -> str:
    """방 알림의 「누가」(OMAI-1444 R15). 실제 관리자가 대행하면 「관리자」, 아니면 표시 이름(팀 관리자도 이름)."""
    if by_admin and server.auth().enabled and server.registry().is_admin(user):
        return tr("관리자", "Admin")
    email = _who(user)
    try:
        return office.display_name(email)
    except Exception:                                                  # noqa: BLE001 — 사용자 목록을 못 읽으면 이메일 앞부분
        return email.split("@")[0]


def _notice(pod, profile: str, who: str):
    """가져오기로 SOUL 이 바뀌면 그 프로파일이 앉은 열린 방에 알린다(R10). 앞 알림과 합치지 않는다(DD13·ROV4)."""
    def send(rev_from, rev_to):
        if meeting.notice_soul(pod.id, profile, who, rev_from, rev_to, "", source="pc_import"):
            topics.invalidate("office:meeting:")
    return send


def runner_for(pod, who: str, notice_who: str = ""):
    def make(job: dict):
        return pc_import.Runner(job, _api(pod),
                                task=lambda kind, prof, src, backup: run_task(pod, kind, prof, src, backup, who),
                                restart=lambda: _restart(pod, job["profile"]),
                                env_names=lambda: _env_names(pod, job["profile"]),
                                on_change=lambda: server._forget(pod),
                                download=lambda rel: _download(pod, rel),
                                notice=_notice(pod, job["profile"], notice_who or who.split("@")[0]))
    return make


def _drop_bundles(pod, job_id: str) -> None:
    """올린 두 묶음을 지운다(취소·만료·교체, R18). 없으면 그냥 넘어간다."""
    api = _api(pod)
    for path in (pc_import.upload_path(job_id), pc_import.secrets_path(job_id)):
        try:
            api.call("DELETE", "/api/files", {"path": path, "recursive": False})
        except HermesError:
            pass


def recover_once(reg) -> list[str]:
    """리더 점검: 서버가 도중에 다시 떠 멈춘 가져오기를 닫는다(R11-3). 닫은 id 목록."""
    done = []
    for job in pc_import.stale():
        pod = next((p for p in reg.pods if p.id == job["pod"]), None)
        if pod is None:
            continue

        def cleanup(temp: str, *uploads: str, pod=pod):
            api = _api(pod)
            for method, path, body in (("DELETE", f"/api/profiles/{temp}", None), *(("DELETE", "/api/files", {"path": u, "recursive": False}) for u in uploads)):
                try:
                    api.call(method, path, body)
                except HermesError:
                    pass

        def env_delete(key: str, pod=pod, job=job):
            _api(pod).call("DELETE", "/api/env", {"key": key, "profile": job["profile"]}, {"profile": job["profile"]})
        state = pc_import.recover(job, lambda kind, prof, src, backup, pod=pod: run_task(pod, kind, prof, src, backup, "aas-recover"),
                                  lambda pod=pod, job=job: _restart(pod, job["profile"]), cleanup, env_delete)
        store.log_usage("pc_import_recovered", f"{job['id']} {state}", pod=pod.id)
        server._forget(pod)
        done.append(job["id"])
    for job in pc_import.temps_left():                                  # 지우지 못하고 남은 임시 프로파일을 다시 지운다
        pod = next((p for p in reg.pods if p.id == job["pod"]), None)
        if pod is not None and pc_import.sweep_temps(job, lambda temp, pod=pod: _api(pod).call("DELETE", f"/api/profiles/{temp}", None, timeout=60)):
            store.log_usage("pc_import_temp_swept", job["id"], pod=pod.id)
            server._forget(pod)
    for job in pc_import.expired():                                     # 확인 단계에 24시간 넘게 남은 묶음(R18)
        pod = next((p for p in reg.pods if p.id == job["pod"]), None)
        if pod is not None and pc_import.cancel(job["id"], "expired"):
            _drop_bundles(pod, job["id"])
            forget_plan(pod.id)
            store.log_usage("pc_import_expired", job["id"], pod=pod.id)
    prune_once(reg)
    return done


_last_prune = {"at": 0.0}


def prune_once(reg, now: float | None = None) -> list[str]:
    """보관 기간(AAS_PC_IMPORT_BACKUP_DAYS, 기본 14일)이 지난 보관 폴더를 하루 한 번 지운다(사용자 결정 2026-10-17).
    결과 화면의 「N일 동안 보관」 약속을 지키려고 기간이 지난 것만 지운다. 지운 id 목록."""
    now = time.time() if now is None else now
    if now - _last_prune["at"] < pc_import.PRUNE_EVERY:
        return []
    _last_prune["at"] = now
    pruned = []
    for job in pc_import.backups_due():
        pod = next((p for p in reg.pods if p.id == job["pod"]), None)
        if pod is None:
            continue
        if pc_import.prune_backup(job, lambda path, pod=pod: _api(pod).call("DELETE", "/api/files", {"path": path, "recursive": True}, timeout=120)):
            store.log_usage("pc_import_backup_pruned", job["id"], pod=pod.id)
            pruned.append(job["id"])
    for job in pc_import.names_due():                                   # 보관 기간이 지난 끝난 기록의 비밀 이름(R28)
        pc_import.scrub_names(job)
    return pruned


# ---- 확인 단계에 보일 「그대로 남는 것」·공용 스킬 영향·옮길 비밀 미리 나누기 ----------------------------------------
PLAN_TTL = 60.0                                                         # 미리 나눈 계획을 다시 쓰는 시간(R24)
PLAN_CHECK_MAX = 50                                                     # 미리 나누기의 사이드카 확인 경로 상한(R24)
_plans: dict[str, tuple[float, str, dict]] = {}                         # 업로드 id → (시각, 파드, 계획)
_plans_lock = threading.Lock()


def forget_plan(pod_id: str) -> None:
    """그 파드의 미리 나눈 계획을 버린다(비밀값 넣기·지우기, 가져오기 시작·취소 뒤, OV-8)."""
    with _plans_lock:
        for k in [k for k, v in _plans.items() if v[1] == pod_id]:
            _plans.pop(k, None)


def secrets_plan(pod, profile: str, job: dict, listing) -> dict:
    """확인 화면의 「옮기는 비밀」 숫자(DD7). 입력은 검사 때 저장한 전체 이름 목록(OV-1). 계산하지 못하면 known=false(R23).
    계산한 계획은 DB summary.secrets_plan_seen 에 저장해 바꾸기 때 비교한다(OV-2)."""
    summary = job.get("summary") or {}
    with _plans_lock:
        hit = _plans.get(job["id"])
    if hit and time.monotonic() - hit[0] < PLAN_TTL:
        return hit[2]
    index = summary.get("secrets_index") or {}
    files = list(index.get("files") or [])
    plan = {"known": False, "files_replace": [], "files_new": [], "env_add": [], "env_exists": [], "env_blocked": [],
            "mcp_files": int((summary.get("secrets") or {}).get("mcp_files") or 0),
            "channel_files": int((summary.get("secrets") or {}).get("channel_files") or 0), "supported": summary.get("secrets_supported")}
    ws = server.workspace_for(pod)
    if listing is not None and len(files) <= PLAN_CHECK_MAX and ws is not None and ws.supported():
        try:
            plan.update(pc_import.plan_files(files, ws.backend.check, profile))
            env = pc_import.plan_env(index.get("env_keys") or [], listing)
            plan.update(env_add=env["add"], env_exists=env["exists"], env_blocked=env["blocked"], known=True)
        except (OSError, ValueError):
            pass
    for k in ("files_replace", "files_new", "env_add", "env_exists", "env_blocked"):
        plan[f"{k}_count"] = len(plan[k])
    if plan["known"]:
        pc_import.set_summary(job["id"], secrets_plan_seen={k: plan[k] for k in ("known", "files_replace", "files_new", "env_add", "supported")})
    view = {**plan, **{k: plan[k][:pc_import.NAMES_MAX] for k in ("files_replace", "files_new", "env_add", "env_exists", "env_blocked")}}
    with _plans_lock:
        _plans[job["id"]] = (time.monotonic(), pod.id, view)
    return view


def keeps(pod, profile: str, job: dict | None = None) -> dict:
    """확인 단계의 「그대로 남는 것」. 올리기 끝에 한 번 계산해 기록 summary 에 저장한다(OMAI-1444 R14). skills_main 은 대상 프로파일의 스킬 수다.
    others 는 같은 파드의 다른 이름 있는 프로파일(루트·임시·대상 제외) — 있으면 화면이 게이트웨이 재시작 안내를 보인다(DD10·ROV3)."""
    out = {"env": 0, "env_known": False, "channels": [], "shared_with": [], "skills_main": None, "others": []}
    listing = _env_listing(pod, profile)
    if listing is not None:
        out["env"], out["env_known"] = len(pc_import.env_names_of(listing)), True
    try:
        rows = server._profile_rows(pod)
        row = next((r for r in rows if r["name"] == profile), None)
        out["channels"] = [c.get("name") for c in (row or {}).get("channels") or [] if c.get("name")]
        out["others"] = sorted(r["name"] for r in rows if not r.get("is_default") and r["name"] != profile and not pc_import.reserved_name(r["name"]))
    except (HermesError, OSError):
        pass
    try:
        out["shared_with"] = sorted({prof for prof, label, _p in hermes_reader.shared_skill_files(pod.hermes_home) if label == profile and prof != profile})
    except OSError:
        pass
    try:
        out["skills_main"] = len(pc_import.skill_names_of(hermes_reader.skill_files(pod.hermes_home), profile))
    except OSError:
        pass
    summary = (job or {}).get("summary") or {}
    if summary.get("secrets_bundle") and summary.get("secrets_enabled"):
        out["secrets_plan"] = secrets_plan(pod, profile, job, listing)
    return out


def dry_run_secrets(pod, profile: str, job_id: str) -> bool | None:
    """오퍼레이터(CRD)가 ProfileSecretsReplace 를 아는가(R26). 저장하지 않는 생성 요청으로 본다. 422 만 거짓, 그 밖의 실패는 모름(None)."""
    client = k8s.client()
    if client is None:
        return None
    body = {"apiVersion": f"{k8s.GROUP}/{k8s.VERSION}", "kind": "HermesTask",
            "metadata": {"name": "pci-dry-" + secrets.token_hex(4), "namespace": client.namespace},
            "spec": {"agent": pod.id, "profile": profile, "type": "ProfileSecretsReplace", "backup": job_id, "requestedBy": "aas-dry-run"}}
    try:
        client.create_task(body, dry_run=True, timeout=3.0)
        return True
    except k8s.K8sError as exc:
        return False if getattr(exc, "code", 0) == 422 else None


# ---- 경로 --------------------------------------------------------------------------------------------
async def upload(request: Request) -> Response:
    try:
        pod, user, admin, by_admin = await _ctx(request, write=True)
        profile = await anyio.to_thread.run_sync(lambda: _target_profile(pod, request.query_params.get("profile", ""), exists=True))
    except _Denied as d:
        return _err(d.code, d.status)
    busy = await anyio.to_thread.run_sync(pc_import.running, pod.id)
    if busy:                                                            # 파드에 하나만(Q3). 어느 프로파일이 쓰는지 알린다(R3)
        return _err("busy_import", 409, profile=busy["profile"])
    raw_len = request.headers.get("content-length", "")
    if not raw_len.isdigit():
        return _err("length", 411)
    size = int(raw_len)
    if size == 0:
        return _err("empty", 400)
    if size > wsp.MAX_FILE:
        return _err("too_big", 413, limit=wsp.MAX_FILE)
    ws = server.workspace_for(pod)
    if ws is None or not ws.supported():
        return _err("unsupported", 501)
    if not files.SLOTS.take():
        return _err("busy", 429)
    job_id = pc_import.new_id()
    name = pc_import.safe_name(urllib.parse.unquote(request.query_params.get("name", "")))
    fd, tmp = tempfile.mkstemp(prefix="aas-pcimp-", suffix=".tar.gz")
    try:
        with os.fdopen(fd, "wb") as out:
            ok, used = await anyio.to_thread.run_sync(ws.reserve, size)
            if not ok:
                return _err("quota", 413, used=used, quota=wsp.quota())
            try:
                if not await anyio.to_thread.run_sync(ws.ensure, pc_import.UPLOADS):
                    return _err("agent_unreachable", 502)
                status = await files._stream_to_hermes(request, ws.api.auth, pc_import.upload_path(job_id), size, tee=out.write)
            finally:
                ws.release(size)
        if status != 200:
            return _err({413: "too_big", 499: "aborted"}.get(status, "agent_unreachable"), {413: 413, 499: 400}.get(status, 502))

        secure = files._View(request)._secrets_ok()                         # https·localhost 가 아니면 비밀을 옮기지 않는다(R17)

        def finish():
            for old in pc_import.uploaded_of(pod.id, profile):             # 같은 프로파일에 새로 올리면 앞의 확인 단계를 닫는다(R18·OMAI-1444 R6)
                if pc_import.cancel(old["id"], "replaced"):
                    _drop_bundles(pod, old["id"])
            forget_plan(pod.id)
            skip_channels = profile != primary.primary_of(pod.id)          # main 이 아닌 대상은 채널 연결 파일을 옮기지 않는다(OMAI-1444 R8)
            with open(tmp, "rb") as f, open(content_tmp, "w+b") as content, open(secret_tmp, "w+b") as secret:
                summary = pc_import.inspect(f, content_out=content, secrets_out=secret, secrets_enabled=secure, skip_channels=skip_channels)
            store_ok = summary["ok"]
            try:                                                           # 원본은 검사가 끝나면 지운다(F3). 걸러 받은 묶음만 남긴다
                ws.delete(pc_import.upload_path(job_id))
            except HermesError:
                store_ok = False
            if summary["ok"] and store_ok:
                pushed = []
                bundles = [(pc_import.upload_path(job_id), content_tmp)]
                if summary.get("secrets_bundle"):
                    bundles.append((pc_import.secrets_path(job_id), secret_tmp))
                for path, local in bundles:
                    if files.push_file(ws.api.auth, path, local) != 200:
                        store_ok = False
                        break
                    pushed.append(path)
                if not store_ok:
                    for path in pushed:
                        try:
                            ws.delete(path)
                        except HermesError:
                            pass
            if summary["ok"] and not store_ok:
                summary = {**summary, "ok": False, "reason": "store_failed"}
            if summary["ok"] and summary.get("secrets_bundle") and summary.get("secrets_enabled"):
                summary["secrets_supported"] = dry_run_secrets(pod, profile, job_id)
            if summary["ok"]:
                try:                                                       # 올리는 사이 대상이 지워지거나 이름이 바뀌었으면 기록을 만들지 않는다(OMAI-1444 커밋 전 리뷰 2)
                    _target_profile(pod, profile, True)
                except _Denied as gone:
                    _drop_bundles(pod, job_id)
                    return None, gone
            row = pc_import.record_upload(job_id, pod.id, profile, _who(user), pod.owner or "", by_admin, name, size, summary)
            kept = keeps(pod, profile, row) if summary["ok"] else {}
            if summary["ok"]:
                pc_import.set_summary(job_id, keeps=kept)                  # 상태 읽기는 이 저장값만 돌려준다(R14)
            return {**pc_import.view(row), "keeps": kept}, summary.get("reason") != "store_failed"
        content_tmp, secret_tmp = tmp + ".content", tmp + ".secrets"
        out_view, stored = await anyio.to_thread.run_sync(finish)
    finally:
        files.SLOTS.give()
        for path in (tmp, tmp + ".content", tmp + ".secrets"):
            try:
                os.unlink(path)
            except OSError:
                pass
    if out_view is None:
        return _err(stored.code, stored.status)
    sm = out_view.get("summary") or {}
    store.log_usage("pc_import_upload", f"{_who(user)} {profile} id={job_id} size={size} state={out_view['state']}"
                    f" kept={sm.get('kept', 0)} secrets={(sm.get('secrets') or {}).get('files_count', 0)}+{(sm.get('secrets') or {}).get('env_keys_count', 0)}"
                    + (" by_admin" if by_admin else ""), pod=pod.id)                 # 개수만 남긴다(§4-3)
    if not stored:
        return JSONResponse({**out_view, "code": "agent_unreachable"}, status_code=502, headers={"Cache-Control": "no-store"})
    return JSONResponse(out_view, headers={"Cache-Control": "no-store"})


async def status(request: Request) -> Response:
    try:
        pod, _user, _admin, _by = await _ctx(request, write=False)
        profile = await anyio.to_thread.run_sync(_target_profile, pod, request.query_params.get("profile", ""))
    except _Denied as d:
        return _err(d.code, d.status)
    row = await anyio.to_thread.run_sync(_refresh, pod, profile)
    body = {"job": pc_import.view(row), "profile": profile, "owner": pod.owner or "", "owner_name": office.person_name(pod.owner or "")}
    if row and row["state"] == "uploaded":
        kept = (row["summary"] or {}).get("keeps")                      # 올리기 때 저장한 값(R14). Hermes·사이드카를 부르지 않는다
        if kept:                                                        # 저장 전(배포 전 기록·올리기 도중)이면 보내지 않는다 — 화면은 기본값을 쓴다
            body["job"]["keeps"] = kept
    busy = await anyio.to_thread.run_sync(pc_import.running, pod.id)
    if busy and busy["profile"] != profile:                             # 같은 파드의 다른 프로파일이 가져오는 중(R3)
        body["busy_profile"] = busy["profile"]
    return JSONResponse(body, headers={"Cache-Control": "no-store"})


def _refresh(pod, profile: str) -> dict | None:
    """마지막 가져오기. 지원 여부를 몰랐으면 한 번 더 묻고(R26), 끝났는데 바꾼 파일 목록을 읽지 못했으면 보관 기간 안에서 다시 읽는다(OV-6)."""
    row = pc_import.latest(pod.id, profile)
    if not row:
        return row
    summary, result = row["summary"] or {}, row["result"] or {}
    if row["state"] == "uploaded" and summary.get("secrets_bundle") and summary.get("secrets_enabled") and summary.get("secrets_supported") is None:
        got = dry_run_secrets(pod, profile, row["id"])
        if got is not None:
            pc_import.set_summary(row["id"], secrets_supported=got)
            row = pc_import.get(row["id"])
    elif row["state"] == "done" and result.get("secrets_list_unreadable") and not result.get("backup_pruned"):
        lists = pc_import.read_secret_lists(lambda rel: _download(pod, rel), row["id"])
        if not lists.get("secrets_list_unreadable"):
            pc_import._set(row["id"], result={**{k: v for k, v in result.items() if k != "secrets_list_unreadable"}, **lists})
            row = pc_import.get(row["id"])
    return row


async def start(request: Request) -> Response:
    try:
        pod, user, _admin, _by = await _ctx(request, write=True)
    except _Denied as d:
        return _err(d.code, d.status)
    job_id = request.query_params.get("id", "")
    row = await anyio.to_thread.run_sync(pc_import.get, job_id) if pc_import.valid_id(job_id) else None
    if not row or row["pod"] != pod.id:
        return _err("not_found", 404)
    if row["state"] != "uploaded" or not row["profile"]:                # 프로파일을 지워 끊긴 기록은 시작하지 않는다(OMAI-1444 R2)
        return _err("not_ready", 409)
    sessions = (await anyio.to_thread.run_sync(lambda: server.hub(pod).status()))["sessions"]
    if any(s["profile"] == row["profile"] and not s["closed"] for s in sessions):     # 열린 대화가 있으면 시작하지 않는다(R7, 기존 삭제 규칙과 같다)
        return _err("open_chats", 409)
    if not await anyio.to_thread.run_sync(pc_import.claim, job_id, pod.id):
        return _err("busy_import", 409)
    forget_plan(pod.id)
    row = await anyio.to_thread.run_sync(pc_import.get, job_id)
    pc_import.start(row, runner_for(pod, _who(user), _notice_who(user, _by)))
    _log_work("pc_import_start", pod, user, row["profile"])    # 날짜별로 묶어 읽으려고 「<이메일> <프로파일>」로 고정
    server._forget(pod)
    return JSONResponse({"job": pc_import.view(row)}, headers={"Cache-Control": "no-store"})


async def cancel(request: Request) -> Response:
    try:
        pod, user, _admin, _by = await _ctx(request, write=True)
    except _Denied as d:
        return _err(d.code, d.status)
    job_id = request.query_params.get("id", "")
    row = await anyio.to_thread.run_sync(pc_import.get, job_id) if pc_import.valid_id(job_id) else None
    if not row or row["pod"] != pod.id:
        return _err("not_found", 404)
    if not await anyio.to_thread.run_sync(pc_import.cancel, job_id):
        return _err("not_ready", 409)
    await anyio.to_thread.run_sync(_drop_bundles, pod, job_id)
    forget_plan(pod.id)
    return JSONResponse({"ok": True})


# 내보내기 전용 스레드 한도. 내보내기는 Hermes 를 최대 600초 기다리므로 공용 요청 스레드(AAS_THREADPOOL)에서 돌지 않는다 —
# 몰리면 다른 화면 요청이 밀렸다. 차면 기다리지 않고 「잠시 뒤 다시」를 돌려준다(스펙 2026-10-24-002 R15)
EXPORT_MAX = 2
_EXPORT_LIMITER: anyio.CapacityLimiter | None = None


def _export_limiter() -> anyio.CapacityLimiter:
    global _EXPORT_LIMITER
    if _EXPORT_LIMITER is None:
        _EXPORT_LIMITER = anyio.CapacityLimiter(EXPORT_MAX)
    return _EXPORT_LIMITER


async def export(request: Request) -> Response:
    try:
        pod, user, _admin, _by = await _ctx(request, write=True)
        profile = await anyio.to_thread.run_sync(lambda: _target_profile(pod, request.query_params.get("profile", ""), exists=True))
    except _Denied as d:
        return _err(d.code, d.status)
    job_id = pc_import.new_id()
    ws = server.workspace_for(pod)
    if ws is None or not ws.supported():
        return _err("unsupported", 501)                               # 내려받기는 사이드카 파일 읽기를 쓴다

    def make():
        api = _api(pod)
        api.call("POST", "/api/files/mkdir", {"path": pc_import.EXPORTS})
        api.call("POST", f"/api/profiles/{urllib.parse.quote(profile, safe='')}/export",
                 {"output": f"{pc_import.DATA_DIR}/{pc_import.export_path(job_id)}"}, timeout=600)
        info = ws.check(pc_import.export_path(job_id))
        size = int(info.get("size") or 0)
        pc_import.record_export(job_id, pod.id, profile, _who(user), size)
        return size
    limiter = _export_limiter()
    if limiter.available_tokens < 1:
        return _err("busy_export", 429)
    try:
        size = await anyio.to_thread.run_sync(make, limiter=limiter)
    except HermesError as exc:
        return _err("export_failed", 502, error=str(exc)[:300])
    _log_work("pc_export", pod, user, profile)
    shared = await anyio.to_thread.run_sync(shared_skills_of, pod, profile)
    return JSONResponse({"id": job_id, "size": size, "profile": profile, "shared_skills": shared}, headers={"Cache-Control": "no-store"})


def shared_skills_of(pod, profile: str) -> dict:
    """그 프로파일이 skills.external_dirs 로 보는 공용 스킬 수와 원본 프로파일(OMAI-1444 R16). 내보낸 묶음에는 들어가지 않는다. 못 읽으면 0."""
    try:
        rows = [label for prof, label, _p in hermes_reader.shared_skill_files(pod.hermes_home) if prof == profile]
    except OSError:
        rows = []
    return {"n": len(rows), "sources": sorted(set(rows))}


async def download(request: Request) -> Response:
    try:
        pod, user, _admin, _by = await _ctx(request, write=False)
    except _Denied as d:
        return files._page(d.status, d.code)
    job_id = request.query_params.get("id", "")
    row = await anyio.to_thread.run_sync(pc_import.get_export, job_id)
    if not row or row["pod"] != pod.id:
        return files._page(404, "not_found")
    if row["downloaded"]:
        return files._page(410, "not_found")                          # 한 번만 받는다(D9). 다시 받으려면 다시 내보낸다
    ws = server.workspace_for(pod)
    path = pc_import.export_path(job_id)
    if not files.SLOTS.take():
        return files._page(429, "busy")
    try:
        code_status, code, resp, conn = await anyio.to_thread.run_sync(ws.backend.open_download, path)
    except OSError:
        files.SLOTS.give()
        return files._page(502, "agent_unreachable")
    if code_status != 200:
        files.SLOTS.give()
        return files._page(code_status, {"missing": "not_found"}.get(code, code or "not_file"))
    total = int(resp.getheader("Content-Length") or 0)
    sent = {"n": 0, "closed": False}

    def close():
        if sent["closed"]:
            return
        sent["closed"] = True
        conn.close()
        files.SLOTS.give()
        if total and sent["n"] >= total:                               # 끝까지 보냈을 때만 지운다. 끊기면 다시 받을 수 있다
            def forget():
                pc_import.mark_downloaded(job_id)
                try:
                    _api(pod).call("DELETE", "/api/files", {"path": path, "recursive": False})
                except HermesError:
                    pass
                store.log_usage("pc_export_download", f"{_who(user)} {row['profile']} id={job_id}", pod=pod.id)
            threading.Thread(target=forget, daemon=True).start()        # 응답을 닫는 자리(이벤트 루프)에서 Hermes 를 기다리지 않는다

    async def chunks():
        while True:
            chunk = await anyio.to_thread.run_sync(resp.read, files.CHUNK, limiter=files.limiter())
            if not chunk:
                break
            sent["n"] += len(chunk)
            yield chunk

    name = f"hermes-{row['profile']}-{row['created'][:10]}.tar.gz"
    headers = {"Content-Length": str(total) if total else "",
               "Content-Disposition": "attachment; filename=\"" + name + "\"",
               "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store"}
    return files._SlotStream(chunks(), media_type="application/gzip", headers=headers, on_close=close)


async def pc_import_route(request: Request) -> Response:
    return await (upload(request) if request.method == "PUT" else status(request))


async def pc_export_route(request: Request) -> Response:
    return await (export(request) if request.method == "POST" else download(request))


def routes() -> list:
    return [Route("/api/profile/pc-import/start", start, methods=["POST"]),
            Route("/api/profile/pc-import/cancel", cancel, methods=["POST"]),
            Route("/api/profile/pc-import", pc_import_route, methods=["GET", "PUT"]),
            Route("/api/profile/pc-export", pc_export_route, methods=["GET", "POST"])]
