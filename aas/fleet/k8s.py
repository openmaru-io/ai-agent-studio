# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""쿠버네티스 API 를 쓰는 아주 작은 클라이언트 — 사용자 Hermes(`HermesAgent` 커스텀 리소스)를 읽고 쓰고, 계정 Secret 을 읽는다.

표준 라이브러리(urllib)만 쓴다. 서버가 가진 권한은 전용 네임스페이스의 HermesAgent·HermesTask·HermesRollout 쓰기와 secrets get 뿐이다(list 는 2026-10-19 뺐다, 스펙 2026-10-19-015 B2)(계획 R8·R16).
Secret 값은 로그·DB 에 남기지 않는다(호출한 쪽이 메모리에만 둔다). 설정:
  AAS_K8S_NAMESPACE  사용자 Hermes 가 사는 네임스페이스. 비어 있으면 쿠버네티스 모드가 꺼진다(compose·파일 등록부).
  AAS_K8S_API        API 서버 주소. 비우면 파드 안 환경(KUBERNETES_SERVICE_HOST·PORT)을 쓴다. 개발 중에는 `kubectl proxy` 주소.
  AAS_K8S_TOKEN_FILE·AAS_K8S_CA_FILE  기본은 파드의 서비스 계정 경로. 토큰은 부를 때마다 읽는다(주기적으로 바뀐다).
"""
from __future__ import annotations

import base64
import json
import os
import ssl
import urllib.error
import urllib.parse
import urllib.request

from ..common import config
from ..common.i18n import tr

GROUP, VERSION, PLURAL = "aas.openmaru.io", "v1alpha1", "hermesagents"
TASK_PLURAL = "hermestasks"
ROLLOUT_PLURAL = "hermesrollouts"
SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount"


class K8sError(Exception):
    """쿠버네티스가 거절하거나 닿지 않았다. code 는 HTTP 상태(닿지 않으면 503)."""

    def __init__(self, message: str, code: int = 503):
        super().__init__(message)
        self.code = code


class K8s:
    def __init__(self, namespace: str, api: str = "", token_file: str = "", ca_file: str = ""):
        self.namespace = namespace
        self._last_agents: list[dict] | None = None          # 마지막으로 읽은 HermesAgent 목록(등록부가 뒤에서 10초마다 다시 읽는다)
        host, port = os.environ.get("KUBERNETES_SERVICE_HOST", ""), os.environ.get("KUBERNETES_SERVICE_PORT", "443")
        self.api = (api or (f"https://{host}:{port}" if host else "")).rstrip("/")
        self.token_file = token_file or (f"{SA_DIR}/token" if not api else "")
        self.ca_file = ca_file or (f"{SA_DIR}/ca.crt" if self.api.startswith("https") else "")

    def _token(self) -> str:
        if not self.token_file or not os.path.isfile(self.token_file):
            return ""
        with open(self.token_file, encoding="utf-8") as fh:
            return fh.read().strip()

    def _ctx(self):
        if not self.api.startswith("https"):
            return None
        return ssl.create_default_context(cafile=self.ca_file) if self.ca_file and os.path.isfile(self.ca_file) else ssl.create_default_context()

    def call(self, method: str, path: str, body: dict | None = None, timeout: float = 10.0) -> dict:
        if not self.api:
            raise K8sError(tr("쿠버네티스 API 주소를 알 수 없습니다(AAS_K8S_API 또는 파드 안 환경)", "Kubernetes API address is unknown (set AAS_K8S_API or run inside a pod)"))
        headers = {"Accept": "application/json"}
        token = self._token()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/merge-patch+json" if method == "PATCH" else "application/json"
        req = urllib.request.Request(self.api + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=self._ctx()) as resp:
                raw = resp.read()
            return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = str(json.loads(exc.read() or b"{}").get("message") or "")
            except Exception:
                pass
            raise K8sError(detail or tr(f"쿠버네티스가 거절했습니다 (HTTP {exc.code})", f"Kubernetes rejected the request (HTTP {exc.code})"), exc.code) from None
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as exc:
            raise K8sError(tr(f"쿠버네티스 API 에 연결할 수 없습니다: {type(exc).__name__}", f"Cannot reach the Kubernetes API: {type(exc).__name__}")) from None
        except ValueError:
            raise K8sError(tr("쿠버네티스 응답을 읽지 못했습니다", "Cannot parse the Kubernetes response")) from None

    # ---- PVC(읽기만, OMAI-1291) --------------------------------------------
    def list_pvcs(self) -> list[dict]:
        """에이전트 네임스페이스의 PVC. 지운 에이전트의 남은 볼륨을 찾는 하루 1회 점검이 쓴다(서버 Role 은 get·list 만)."""
        return self.call("GET", f"/api/v1/namespaces/{urllib.parse.quote(self.namespace)}/persistentvolumeclaims").get("items", [])

    # ---- HermesAgent ------------------------------------------------------
    def _agents(self) -> str:
        return f"/apis/{GROUP}/{VERSION}/namespaces/{urllib.parse.quote(self.namespace)}/{PLURAL}"

    def list_agents(self) -> list[dict]:
        items = self.call("GET", self._agents()).get("items", [])
        self._last_agents = items
        return items

    def known_agent(self, name: str) -> dict | None:
        """마지막으로 읽은 목록에 있는 HermesAgent. 없으면 None. 화면 요청이 API 를 기다리지 않게 쓴다
        (OKE etcd 가 주기적으로 몇 초씩 멈춘다, OMAI-1109). 값을 바꾸기 전 확인처럼 최신 값이 필요하면 get_agent 를 쓴다."""
        for item in self._last_agents or []:
            if (item.get("metadata") or {}).get("name") == name:
                return item
        return None

    def last_agents(self) -> list[dict]:
        """마지막으로 읽은 HermesAgent 원본 목록(등록부가 뒤에서 10초마다 다시 읽는다). 아직 읽지 않았으면 빈 목록."""
        return list(self._last_agents or [])

    def get_agent(self, name: str) -> dict:
        return self.call("GET", f"{self._agents()}/{urllib.parse.quote(name)}")

    def create_agent(self, body: dict) -> dict:
        return self.call("POST", self._agents(), body)

    def patch_agent(self, name: str, patch: dict) -> dict:
        return self.call("PATCH", f"{self._agents()}/{urllib.parse.quote(name)}", patch)

    def delete_agent(self, name: str) -> dict:
        return self.call("DELETE", f"{self._agents()}/{urllib.parse.quote(name)}")

    # ---- HermesTask (마켓 설치·지우기: 오퍼레이터가 pods/exec 로 돌린다. 서버에는 exec 권한이 없다) --------
    def _tasks(self) -> str:
        return f"/apis/{GROUP}/{VERSION}/namespaces/{urllib.parse.quote(self.namespace)}/{TASK_PLURAL}"

    def create_task(self, body: dict, dry_run: bool = False, timeout: float = 10.0) -> dict:
        """dry_run 이면 저장하지 않고 검사만 한다(CRD enum 등, PC 가져오기의 지원 확인 2026-10-22-003 R26)."""
        return self.call("POST", self._tasks() + ("?dryRun=All" if dry_run else ""), body, timeout=timeout)

    def get_task(self, name: str) -> dict:
        return self.call("GET", f"{self._tasks()}/{urllib.parse.quote(name)}")

    def delete_task(self, name: str) -> dict:
        return self.call("DELETE", f"{self._tasks()}/{urllib.parse.quote(name)}")

    # ---- HermesRollout (순차 롤아웃: 관리자 화면이 만들고 멈춤·계속을 바꾼다. 진행은 오퍼레이터가 한다, 스펙 2026-10-28-015) ----
    def _rollouts(self) -> str:
        return f"/apis/{GROUP}/{VERSION}/namespaces/{urllib.parse.quote(self.namespace)}/{ROLLOUT_PLURAL}"

    def list_rollouts(self) -> list[dict]:
        return self.call("GET", self._rollouts()).get("items", [])

    def create_rollout(self, body: dict) -> dict:
        return self.call("POST", self._rollouts(), body)

    def patch_rollout(self, name: str, patch: dict) -> dict:
        return self.call("PATCH", f"{self._rollouts()}/{urllib.parse.quote(name)}", patch)

    # ---- 남은 자리(읽기만, 스펙 2026-10-30-003 §4-5). 서버 Role 은 configmaps aas-capacity get·resourcequotas get 뿐이다 ----
    def get_configmap(self, name: str, timeout: float = 5.0) -> dict:
        return self.call("GET", f"/api/v1/namespaces/{urllib.parse.quote(self.namespace)}/configmaps/{urllib.parse.quote(name)}", timeout=timeout)

    def get_resourcequota(self, name: str, timeout: float = 5.0) -> dict:
        return self.call("GET", f"/api/v1/namespaces/{urllib.parse.quote(self.namespace)}/resourcequotas/{urllib.parse.quote(name)}", timeout=timeout)

    # ---- Secret -----------------------------------------------------------
    def secret(self, name: str) -> dict[str, str]:
        """Secret 의 값을 풀어서 돌려준다. 호출한 쪽이 메모리에만 두고 로그에 싣지 않는다."""
        data = self.call("GET", f"/api/v1/namespaces/{urllib.parse.quote(self.namespace)}/secrets/{urllib.parse.quote(name)}").get("data") or {}
        return {k: base64.b64decode(v).decode("utf-8", "replace") for k, v in data.items()}


_client: K8s | None = None
_client_key: tuple = ()


def client() -> K8s | None:
    """설정에서 만든 클라이언트. AAS_K8S_NAMESPACE 가 없으면 None(쿠버네티스 모드 꺼짐). 설정이 바뀌면 다시 만든다."""
    global _client, _client_key
    ns = config.get("AAS_K8S_NAMESPACE")
    if not ns:
        _client, _client_key = None, ()
        return None
    key = (ns, config.get("AAS_K8S_API"), config.get("AAS_K8S_TOKEN_FILE"), config.get("AAS_K8S_CA_FILE"))
    if _client is None or key != _client_key:
        _client, _client_key = K8s(ns, key[1], key[2], key[3]), key
    return _client
