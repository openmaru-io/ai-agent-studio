# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""POD 등록부 — 사용자와 그 사람의 Hermes 인스턴스를 잇는다(ADR-0003).

`AAS_CONFIG_DIR/pods.json`:
  {"admins": ["a@x.com"],
   "pods": [{"id": "alice", "owner": "alice@x.com", "hermes_home": "/…/hermes-agent",
             "container": "hermes-agent", "dashboard_url": "http://hermes:9119",
             "dashboard_user_env": "AAS_DASHBOARD_USER", "dashboard_password_env": "AAS_DASHBOARD_PASSWORD"}]}
비밀값은 여기 두지 않고 aas.env 의 변수 이름만 적는다. 파일이 없으면 지금 환경 하나를 POD 로 본다.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from ..common import config, db, table_cache
from ..hermes import readers
from ..hermes import hermes_reader as hr
from ..common.i18n import tr

FILE = config.pods_file()


def env_admins() -> set[str]:
    """AAS_ADMINS(쉼표·공백으로 나눈 이메일)에 적힌 관리자. 컨테이너·쿠버네티스에서는 등록부 파일 대신 설치 값으로 지정한다."""
    out = set()
    for tok in re.split(r"[,\s]+", config.get("AAS_ADMINS")):
        tok = tok.strip().lower()
        if re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", tok):
            out.add(tok)
    return out


@dataclass(frozen=True)
class Pod:
    id: str
    owner: str
    hermes_home: "Path | readers.RemotePath"
    container: str = "hermes-agent"
    dashboard_url: str = ""
    dashboard_user_env: str = "AAS_DASHBOARD_USER"
    dashboard_password_env: str = "AAS_DASHBOARD_PASSWORD"
    sidecar_url: str = ""                      # 있으면 hermes_home 은 이 읽기 사이드카를 통해 읽는다(쿠버네티스)
    sidecar_token_env: str = "AAS_SIDECAR_TOKEN"
    credentials_secret: str = ""               # 있으면 대시보드 계정·사이드카 토큰을 이 Secret 에서 읽는다(쿠버네티스, credentials.py)
    owner_sub: str = ""                        # 소유자의 OIDC sub. 있으면 이메일이 바뀌어도 이 값으로 알아본다(쿠버네티스)
    restarting: bool = False                   # Ready 였다가 다시 뜨는 중(Registry.restarting, 스펙 2026-10-23-006)
    restart_reason: str = ""                   # 다시 뜨는 이유. "update" 면 롤아웃이 새 버전으로 바꾸는 중(스펙 2026-10-28-015 DD13)

    def public(self) -> dict:
        return {"id": self.id, "owner": self.owner, **({"restarting": True} if self.restarting else {}),
                **({"restart_reason": self.restart_reason} if self.restarting and self.restart_reason else {})}

    def owned_by(self, user: dict | None) -> bool:
        """이 사용자가 주인인가(이메일 또는 OIDC sub). 주인 '*' 인 기본 POD 는 아무의 것도 아니다.
        볼 수 있는 POD(Registry.allowed)와 주인 권한(server._owns_pod)이 이 한 곳을 함께 쓴다(OMAI-1126 리뷰 O6)."""
        if not user or self.owner == "*":
            return False
        email, sub = str(user.get("email") or "").lower(), str(user.get("sub") or "")
        return (bool(email) and self.owner == email) or bool(sub and getattr(self, "owner_sub", "") == sub)


class Registry:
    def __init__(self, path: Path | None = None):
        self.path = path or FILE
        self.admins: set[str] = set()
        self.pods: list[Pod] = []
        self.agents: list[dict] = []               # 쿠버네티스 모드: 준비 전인 것까지 포함한 HermesAgent 요약(agents.view)
        self.restarting: list[Pod] = []            # Ready 였다가 다시 뜨는 중. pods 에는 없다 — pick·웹소켓 허용만 본다(스펙 2026-10-23-006)
        self.rollouts: list[dict] = []             # HermesRollout 원본(관리자 화면의 버전 열·진행 띠, 스펙 2026-10-28-015). CRD 가 없으면 빈 목록
        self.error = ""
        self._loaded = 0.0
        self._lock = threading.Lock()
        self._refreshing = False
        self._refresh_lock = threading.Lock()               # 다시 읽는 중인지만 본다. _lock 을 쓰면 요청이 느린 다시 읽기를 기다린다
        self.reload()

    def refresh(self, ttl: float = 10.0) -> None:
        """쿠버네티스 모드에서 HermesAgent 목록을 ttl 초마다 다시 읽는다(만들어지고 준비되는 것을 따라간다). 다른 모드에서는 하지 않는다.
        이미 읽은 뒤의 주기 다시 읽기는 뒤 스레드에서 하고 요청은 지금 목록으로 답한다 — OKE etcd 가 주기적으로 몇 초씩 멈춰
        요청이 API 를 기다리면 화면이 3~10초 멈췄다(OMAI-1109). ttl=0(만들기·지우기 직후)은 그 자리에서 읽는다."""
        from . import k8s
        if k8s.client() is None or time.monotonic() - self._loaded < ttl:
            return
        if ttl > 0 and self._loaded:
            with self._refresh_lock:
                if self._refreshing:
                    return
                self._refreshing = True
            threading.Thread(target=self._reload_behind, args=(ttl,), daemon=True, name="registry-refresh").start()
            return
        self._reload_if_due(ttl)

    def _reload_if_due(self, ttl: float) -> None:
        """쿠버네티스 목록은 잠금 밖에서 읽고 표만 잠금 안에서 바꾼다 — 잠금 안에서 k8s(10초)를 기다리면 로그인·에이전트 만들기·
        웹소켓 토픽이 그 뒤에 줄을 섰다(스펙 2026-10-24-002 R9)."""
        from . import k8s
        client = k8s.client()
        if client is not None:
            if time.monotonic() - self._loaded >= ttl:
                self._reload_k8s(client, admins=env_admins())
            return
        with self._lock:
            if time.monotonic() - self._loaded >= ttl:
                self.reload()

    def _reload_behind(self, ttl: float) -> None:
        try:
            self._reload_if_due(ttl)
        finally:
            with self._refresh_lock:
                self._refreshing = False

    def _reload_k8s(self, client, admins: set[str] | None = None) -> None:
        """HermesAgent 가 곧 등록부다. 준비된 것만 Pod 로 연다. API 에 닿지 않으면 마지막으로 읽은 목록을 두고 오류를 알린다.
        k8s 는 잠금 밖에서 읽고, 표는 잠금 안에서 한 번에 바꾼다(R9)."""
        from . import agents, k8s
        self._loaded = time.monotonic()
        try:
            items = client.list_agents()
        except k8s.K8sError as exc:
            with self._lock:
                if admins is not None:
                    self.admins = admins
                self.error = tr(f"쿠버네티스에서 HermesAgent 를 읽지 못했습니다: {exc}", f"Cannot read HermesAgent from Kubernetes: {exc}")
            return
        views = [agents.view(i) for i in items]
        pods = [p for p in (agents.pod_from(i) for i in items) if p]
        restarting = [p for p in (agents.restarting_pod_from(i) for i in items) if p]
        try:                                         # 롤아웃은 같은 바퀴에 읽는다. 차트를 올리기 전(CRD 없음, 404)이나 읽기 실패면 지난 값을 둔다
            rollouts = client.list_rollouts()
        except k8s.K8sError as exc:
            rollouts = [] if exc.code == 404 else self.rollouts
        with self._lock:
            if admins is not None:
                self.admins = admins
            self.agents, self.pods, self.restarting, self.rollouts, self.error = views, pods, restarting, rollouts, ""
        self.note_owners()

    def reload(self) -> None:
        from . import k8s
        client = k8s.client()
        if client is not None:                              # 쿠버네티스 모드: 등록부 파일 대신 HermesAgent
            self.admins, self.error = env_admins(), ""
            self._reload_k8s(client)
            return
        self.admins, self.pods, self.error = env_admins(), [], ""
        if not self.path.is_file():
            # 주인은 AAS_DEFAULT_POD_OWNER(빠른 시작 compose 가 첫 관리자 이메일로 넘긴다, 스펙 2026-10-21-015 R2). 비면 "*"(아무의 것도 아님)
            owner = config.get("AAS_DEFAULT_POD_OWNER").strip().lower() or "*"
            self.pods = [Pod("default", owner, hr.hermes_home(),
                             os.environ.get("AAS_HERMES_CONTAINER", "hermes-agent"),
                             config.get("AAS_DASHBOARD_URL").rstrip("/"),
                             sidecar_url=config.get("AAS_SIDECAR_URL").rstrip("/"))]
            return
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            self.admins |= {str(a).lower() for a in data.get("admins", [])}
            seen = set()
            for p in data.get("pods", []):
                pid = str(p["id"])
                if pid in seen or not pid.replace("-", "").replace("_", "").isalnum():
                    raise ValueError(tr(f"POD id 가 겹치거나 형식이 맞지 않습니다: {pid}", f"POD id is duplicated or malformed: {pid}"))
                seen.add(pid)
                sidecar_url = str(p.get("sidecar_url") or "").rstrip("/")
                token_env = str(p.get("sidecar_token_env") or "AAS_SIDECAR_TOKEN")
                home = (readers.remote_home(sidecar_url, token_env, label=pid) if sidecar_url
                        else Path(os.path.expandvars(str(p["hermes_home"]))))     # 사이드카가 없으면 로컬 폴더가 꼭 있어야 한다
                self.pods.append(Pod(pid, str(p["owner"]).lower(), home,
                                     str(p.get("container") or "hermes-agent"),
                                     str(p.get("dashboard_url") or "").rstrip("/"),
                                     str(p.get("dashboard_user_env") or "AAS_DASHBOARD_USER"),
                                     str(p.get("dashboard_password_env") or "AAS_DASHBOARD_PASSWORD"),
                                     sidecar_url, token_env))
        except Exception as exc:      # 등록부가 깨졌으면 아무 POD 도 열지 않는다(잘못된 연결보다 안전)
            self.pods, self.error = [], tr(f"POD 등록부를 읽지 못했습니다: {exc}", f"Cannot read the POD registry: {exc}")
        self.note_owners()

    # ---- 화면에서 준 권한(AAS DB). 등록부 파일에 적힌 것 위에 더해진다 — 파일의 관리자·소유자는 화면에서 못 뺀다.
    GRANT_SCHEMA = ("CREATE TABLE IF NOT EXISTS access_grants (email TEXT PRIMARY KEY, role TEXT NOT NULL, pods TEXT NOT NULL DEFAULT '', "
                    "by TEXT, ts TEXT NOT NULL)")

    def grants(self) -> dict[str, dict]:
        from ..common import store

        def read() -> list[dict]:
            with store.connect() as conn:
                conn.execute(self.GRANT_SCHEMA)
                return [dict(r) for r in conn.execute("SELECT email, role, pods, by, ts FROM access_grants").fetchall()]
        try:
            # 일반 사용자는 is_admin·allowed·managed 가 한 요청에서 3~5번 읽었다. 읽기만 하는 요청 안에서는 한 번만(스펙 2026-10-24-009 3-2)
            rows = store.memo(f"grants:{id(self)}", read)
        except Exception:
            return {}
        known = {p.id for p in self.pods}
        return {r["email"]: {"role": r["role"], "pods": [x for x in r["pods"].split(",") if x in known], "by": r["by"], "ts": r["ts"]} for r in rows}

    def grant(self, email: str, role: str, pods: list[str], by: str) -> None:
        from datetime import datetime
        from ..common import store
        email = email.lower()
        with store.connect() as conn:
            conn.execute(self.GRANT_SCHEMA)
            if role == "none":
                conn.execute("DELETE FROM access_grants WHERE email=?", (email,))
            else:
                conn.execute(db.upsert("access_grants", ("email", "role", "pods", "by", "ts"), ("email",)),
                             (email, role, ",".join(pods), by, datetime.now().astimezone().isoformat(timespec="seconds")))

    def admin_grants(self) -> list[str]:
        """화면이 예전에 준 관리자(access_grants.role=admin) 중 아직 Keycloak 관리자 그룹으로 옮기지 못한 이메일(K7)."""
        from ..common import store
        try:
            with store.connect() as conn:
                conn.execute(self.GRANT_SCHEMA)
                return sorted(r["email"] for r in conn.execute("SELECT email FROM access_grants WHERE role='admin'"))
        except Exception:
            return []

    def migrated(self, email: str) -> None:
        """Keycloak 관리자 그룹으로 옮긴 행을 사용자로 바꾼다. 볼 수 있는 에이전트(pods)는 그대로 둔다(K7). 여러 번 불러도 같다."""
        from ..common import store
        with store.connect() as conn:
            conn.execute(self.GRANT_SCHEMA)
            conn.execute("UPDATE access_grants SET role='user' WHERE email=? AND role='admin'", (email.lower(),))

    # ---- 지금 주인이 언제부터 주인인가. 주인은 이 시각 이후의 자기 POD 변경 기록만 본다(OMAI-1126 재검토 D10, L6)
    OWNER_SCHEMA = "CREATE TABLE IF NOT EXISTS pod_owners (pod TEXT PRIMARY KEY, owner TEXT NOT NULL, since TEXT NOT NULL)"

    def owner_since(self, pod: Pod) -> str:
        """이 POD 의 지금 주인이 처음 보인 시각. 기록이 없거나 주인이 바뀌었으면 지금을 적는다.
        등록부를 다시 읽을 때마다 부르므로(note_owners) 주인이 바뀐 시각과 몇 초 안쪽으로 맞는다."""
        from datetime import datetime
        from ..common import store
        with store.connect() as conn:
            conn.execute(self.OWNER_SCHEMA)
            row = conn.execute("SELECT owner, since FROM pod_owners WHERE pod=?", (pod.id,)).fetchone()
            if row and row["owner"] == pod.owner:
                return row["since"]
            now = datetime.now().astimezone().isoformat(timespec="seconds")
            conn.execute(db.upsert("pod_owners", ("pod", "owner", "since"), ("pod",)), (pod.id, pod.owner, now))
            return now

    def note_owners(self) -> None:
        """다시 읽은 등록부의 주인을 적는다. DB 가 아직 없으면 넘긴다(다음 다시 읽기나 기록 조회 때 적힌다)."""
        from datetime import datetime
        from ..common import store
        try:                                                # 쿠버네티스 모드는 10초마다 다시 읽는다 — 한 번 읽고 바뀐 것만 쓴다
            def read() -> dict[str, str]:
                with store.connect() as conn:
                    conn.execute(self.OWNER_SCHEMA)
                    return {r["pod"]: r["owner"] for r in conn.execute("SELECT pod, owner FROM pod_owners")}
            have = table_cache.get("pods.owners", ("pod_owners",), read, dict)   # 10초마다 읽었다(스펙 2026-10-26-002 R10)
            if all(p.owner == "*" or have.get(p.id) == p.owner for p in self.pods):
                return
            with store.connect() as conn:
                now = datetime.now().astimezone().isoformat(timespec="seconds")
                for p in self.pods:
                    if p.owner != "*" and have.get(p.id) != p.owner:
                        conn.execute(db.upsert("pod_owners", ("pod", "owner", "since"), ("pod",)), (p.id, p.owner, now))
        except Exception:
            pass

    def is_admin(self, user: dict | None) -> bool:
        """세션의 관리자 표시(토큰의 역할) · 등록부·AAS_ADMINS · 아직 Keycloak 으로 옮기지 못한 access_grants.role=admin 행.
        옮긴 행은 role 이 user 로 바뀌므로 더는 관리자로 읽히지 않는다(K7, 스펙 2026-10-14-011)."""
        if not user:
            return False
        if user.get("via") == "token":                  # Claude Code 연결로 온 요청은 관리자 권한을 쓰지 않는다(이메일 관리자 목록도 무시, 스펙 2026-10-28-001 D5)
            return False
        email = user["email"].lower()
        return bool(user.get("admin")) or email in self.admins or self.grants().get(email, {}).get("role") == "admin"

    def team_of_manager(self, user: dict | None) -> str:
        """이 사람이 지금 팀 관리자인 부서의 team_key. 아니면 ''.
        team_managers 행이 있고, 지금 부서(user_directory)가 그 행의 부서와 같아야 한다. 부서가 빈 사람은 늘 ''(스펙 2026-10-22-001 §3)."""
        from ..common import settings
        email = str((user or {}).get("email") or "").lower()
        if not email:
            return ""
        dept = settings.departments().get(email, "")
        key = settings._team_key(dept) if dept else ""
        return key if key and email in settings.team_managers().get(key, []) else ""

    def team_pods(self, user: dict | None) -> list[Pod]:
        """팀 관리자가 다루는 에이전트: 주인의 부서가 팀 관리자의 부서와 같은 것. 주인 '*'·주인을 지운 에이전트·부서를 모르는 주인은 뺀다."""
        return self._team_of(user, self.pods)

    def _team_of(self, user: dict | None, pool: list[Pod]) -> list[Pod]:
        from ..common import settings
        key = self.team_of_manager(user)
        if not key:
            return []
        depts = settings.departments()
        return [p for p in pool if p.owner != "*" and p.owner in depts and settings._team_key(depts[p.owner]) == key]

    def managed(self, user: dict | None, auth_enabled: bool) -> list[Pod]:
        """설정을 다루는 에이전트: 주인인 것 + 팀 에이전트. 접근 권한(access_grants)으로 보기만 받은 것은 뺀다."""
        if not auth_enabled or (user and self.is_admin(user)):
            return list(self.pods)
        if not user:
            return []
        team = {p.id for p in self.team_pods(user)}
        return [p for p in self.pods if p.owned_by(user) or p.id in team]

    def allowed(self, user: dict | None, auth_enabled: bool, restarting: bool = False) -> list[Pod]:
        """볼 수 있는 POD. restarting=True 면 다시 뜨는 중인 것(Registry.restarting)도 같은 규칙으로 더한다(스펙 2026-10-23-006)."""
        pool = list(self.pods) + (list(getattr(self, "restarting", [])) if restarting else [])   # 시험의 Registry.__new__ 에는 없다
        if not auth_enabled:
            return pool                                  # 로그인이 꺼져 있으면(루프백 전용) 전부
        if not user:
            return []
        if self.is_admin(user):
            return pool
        extra = set(self.grants().get(user["email"].lower(), {}).get("pods", []))
        team = {p.id for p in self.team_pods(user)} | ({p.id for p in self._team_of(user, list(getattr(self, "restarting", [])))} if restarting else set())
        return [p for p in pool if p.owned_by(user) or p.id in extra or p.id in team]   # '*' 는 로그인 사용자에게 주지 않는다

    def pick(self, user: dict | None, auth_enabled: bool, wanted: str = "") -> Pod | None:
        """고른 에이전트. 쿠키 값이 허용 목록에 없거나 비면 내 에이전트, 그것도 없으면 첫 에이전트(팀 관리자도 자기 에이전트가 기본).
        쿠키의 에이전트가 다시 뜨는 중이면 다른 곳으로 넘기지 않고 그것(restarting=True)을 돌려준다 — 넘기면 다시 시작하는 1분 동안
        화면이 다른 사람의 작업공간을 보였다(OKE 2026-10-23, 스펙 2026-10-23-006). 기본값은 준비된 것만 본다."""
        pods = self.allowed(user, auth_enabled)
        hit = next((p for p in pods if p.id == wanted), None)
        if hit is not None:
            return hit
        # 쿠키의 에이전트나 기본값(내 첫 에이전트·첫 에이전트)이 다시 뜨는 중이어도 같은 것을 고른다. 쿠키가 없는 사용자(바꾼 적 없음)는
        # 기본값이 「준비된 것 중 첫째」라 다시 뜨는 동안 다음 에이전트로 넘어갔다(OKE 2026-10-23 재시험, 스펙 2026-10-23-006 5-1).
        # 그래서 준비된 것과 다시 뜨는 것을 HermesAgent 목록 순서(agents)로 합쳐 고른다.
        both = self.allowed(user, auth_enabled, restarting=True)
        order = {a.get("name"): i for i, a in enumerate(getattr(self, "agents", []) or [])}
        both.sort(key=lambda p: order.get(p.id, len(order)))
        return (next((p for p in both if p.id == wanted), None) if wanted else None) or next((p for p in both if p.owned_by(user)), None) \
            or (both[0] if both else None)
