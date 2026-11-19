# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Hermes 이미지에 든 Python 패키지 목록(스펙 2026-11-19-001).

목록은 이미지 빌드가 만든 JSON(D3 형식)이다:
  {"image", "taken_at", "python", "prefix", "script_ver", "packages": [{"name", "version", "modules"?}]}
`modules` 는 `default_modules(name)` 과 다를 때만 실린다(출력 크기).

쿠버네티스(2단계): 이미지 빌드가 config label 로 붙인 목록을 오퍼레이터가 ConfigMap `aas-image-packages` 에 digest 키
(`sha256-<hex>`)로 옮긴다. 서버는 HermesAgent 의 status.image 로 키를 찾는다. ConfigMap 은 네임스페이스마다 한 번 읽어 15초 두고,
오래되면 지난 값을 주며 뒤에서 다시 읽는다(rollouts.registry_status 와 같은 방식). 쿠버네티스가 아닐 때(로컬 compose)만 개발용
환경 변수 `AAS_IMAGE_PACKAGES_FILE` 의 파일을 읽는다. 목록을 모르면 라이브러리 칸은 경고 대신 「이미지 목록 확인 전」이다.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import threading
import time
from pathlib import Path

ENV_FILE = "AAS_IMAGE_PACKAGES_FILE"
CONFIGMAP = "aas-image-packages"
CM_TTL = 15.0
MAX_ITEMS = 2000
MAX_BYTES = 1 << 20

_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")
_VERSION = re.compile(r"^[A-Za-z0-9.+!_-]{1,64}$")
_MODULE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,99}$")


def default_modules(name: str) -> list[str]:
    """`modules` 가 생략됐을 때의 최상위 모듈. 빌드 스크립트의 생략 조건과 글자 그대로 같아야 한다."""
    return [name.replace("-", "_").replace(".", "_").lower()]


def normalize(name: str) -> str:
    """배포 이름 비교용(PEP 503)."""
    return re.sub(r"[-_.]+", "-", name).lower()


def unknown(reason: str) -> dict:
    return {"packages": None, "reason": reason}


def parse(data) -> dict:
    """D3 JSON → {packages, prefix, taken_at, python, dropped, reason}. 형식이 맞지 않는 항목만 빼고 목록은 살린다.
    목록 전체를 버리는 것은 JSON 모양이 틀렸거나 항목이 MAX_ITEMS 를 넘을 때뿐이다(이유 `bad_json`)."""
    if not isinstance(data, dict) or not isinstance(data.get("packages"), list) or len(data["packages"]) > MAX_ITEMS:
        return unknown("bad_json")
    packages, dropped = [], 0
    for p in data["packages"]:
        name = p.get("name") if isinstance(p, dict) else None
        version = p.get("version") if isinstance(p, dict) else None
        if not isinstance(name, str) or not _NAME.match(name) or not isinstance(version, str) or not _VERSION.match(version):
            dropped += 1
            continue
        mods = p.get("modules")
        if isinstance(mods, list):
            good = [m for m in mods if isinstance(m, str) and _MODULE.match(m) and not (m.startswith("__") and m.endswith("__"))]
            dropped += len(mods) - len(good)
            mods = good or default_modules(name)
        else:
            mods = default_modules(name)
        packages.append({"name": name, "version": version, "modules": [m.lower() for m in mods]})
    return {"packages": packages, "reason": "", "dropped": dropped,
            "prefix": str(data.get("prefix") or "/opt/hermes/.venv")[:200],
            "taken_at": str(data.get("taken_at") or "")[:32], "python": str(data.get("python") or "")[:32]}


def load_file(path: str) -> dict:
    try:
        p = Path(path)
        if p.stat().st_size > MAX_BYTES:
            return unknown("bad_json")
        return parse(json.loads(p.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return unknown("bad_json")


def digest_key(image: str) -> str:
    """이미지 참조(`저장소@sha256:…` 또는 `sha256:…`)의 ConfigMap 키. digest 꼴이 아니면 "".
    오퍼레이터 ImagePackagesKey 와 같은 규칙이다(입력 표 tests/fixtures/digest_keys.json)."""
    digest = str(image or "").rsplit("@", 1)[-1]
    return "sha256-" + digest[7:] if re.fullmatch(r"sha256:[0-9a-f]{64}", digest) else ""


_log = logging.getLogger("aas.assets")
_cm_lock = threading.Lock()
_cm: dict = {}                       # 네임스페이스 → {"at", "value"(data dict | 이유 str), "busy"}
_warned = {"forbidden": 0.0}


def _read_cm(client) -> dict | str:
    """ConfigMap data, 또는 읽지 못한 이유(no_cm·forbidden·timeout)."""
    from ..fleet import k8s
    try:
        value: dict | str = (client.get_configmap(CONFIGMAP).get("data") or {})
    except k8s.K8sError as exc:
        code = getattr(exc, "code", 503)
        value = "no_cm" if code == 404 else "forbidden" if code in (401, 403) else "timeout"
        if value == "forbidden" and time.monotonic() - _warned["forbidden"] > 60:
            _warned["forbidden"] = time.monotonic()
            _log.warning("cannot read ConfigMap %s/%s (forbidden): add %s to configmaps get resourceNames of the aas-server Role in the COP chart",
                         client.namespace, CONFIGMAP, CONFIGMAP)
    with _cm_lock:
        _cm[client.namespace] = {"at": time.monotonic(), "value": value, "busy": False}
    return value


def _configmap(client) -> dict | str:
    with _cm_lock:
        hit = _cm.get(client.namespace)
        stale = hit is None or time.monotonic() - hit["at"] >= CM_TTL
        start = stale and hit is not None and not hit["busy"]
        if start:
            hit["busy"] = True
    if hit is None:                  # 처음 한 번은 기다린다
        return _read_cm(client)
    if start:
        threading.Thread(target=_read_cm, args=(client,), daemon=True, name="aas-image-packages").start()
    return hit["value"]


def forget() -> None:
    with _cm_lock:
        _cm.clear()


def from_k8s(agent: str) -> dict:
    """쿠버네티스: HermesAgent `agent` 의 이미지 목록. 이유: not_k8s·pending(status.image 없음)·no_key(아직 옮기지 않음)·
    forbidden·timeout·bad_json·no_label·parse."""
    from ..fleet import k8s
    client = k8s.client()
    if client is None:
        return unknown("not_k8s")
    item = client.known_agent(agent) or {}
    key = digest_key((item.get("status") or {}).get("image") or "")
    if not key:
        return unknown("pending")
    data = _configmap(client)
    if isinstance(data, str):
        return unknown("no_key" if data == "no_cm" else data)
    raw = data.get(key)
    if raw is None:
        return unknown("no_key")
    try:
        doc = json.loads(raw) if len(raw) <= MAX_BYTES else None
    except ValueError:
        doc = None
    if isinstance(doc, dict) and isinstance(doc.get("reason"), str) and "packages" not in doc:
        return unknown(doc["reason"] if doc["reason"] in ("no_label", "parse") else "bad_json")
    return parse(doc)


def signature(value: dict) -> str:
    """그래프를 다시 만들어야 하는지 가리는 값(상태·이유·내용)."""
    body = json.dumps(value.get("packages"), sort_keys=True, ensure_ascii=False) if value.get("packages") is not None else ""
    return f"{value.get('reason') or ''}:{hashlib.sha256(body.encode()).hexdigest()[:16]}"


def for_pod(in_k8s: bool, agent: str = "") -> dict:
    """그래프에 넘길 이미지 목록. 쿠버네티스면 오퍼레이터가 옮긴 ConfigMap, 아니면 개발용 파일이 있을 때만 읽는다."""
    if in_k8s:
        return from_k8s(agent) if agent else unknown("pending")
    path = os.environ.get(ENV_FILE, "").strip()
    return load_file(path) if path else unknown("not_k8s")
