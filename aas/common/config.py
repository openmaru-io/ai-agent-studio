# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""설정 한 곳 — 환경변수(AAS_*)와 환경 파일(aas.env)을 읽는 자리는 여기 하나다.

기본값은 컨테이너 안의 위치(/etc/aas, /data, /opt/data)만 쓴다. 운영 맥의 경로나 루프백 주소는 기본값에 없다.
값이 없으면 빈 문자열이고, 그 값에 기대는 기능만 꺼진다(`missing()` 이 시작할 때 무엇이 빠졌는지 알려 준다).
"""
from __future__ import annotations

import os
from pathlib import Path

DEFAULT_CONFIG_DIR = "/etc/aas"
DEFAULT_DATA_DIR = "/data"
DEFAULT_HERMES_HOME = "/opt/data"           # Hermes 이미지가 데이터를 두는 자리


def config_dir() -> Path:
    return Path(os.environ.get("AAS_CONFIG_DIR") or DEFAULT_CONFIG_DIR)


def env_file() -> Path:
    return config_dir() / "aas.env"


def pods_file() -> Path:
    return Path(os.environ.get("AAS_PODS_FILE") or config_dir() / "pods.json")


def users_file() -> Path:
    return Path(os.environ.get("AAS_USERS_FILE") or config_dir() / "users.json")


def hermes_home() -> Path:
    return Path(os.environ.get("AAS_HERMES_HOME") or DEFAULT_HERMES_HOME)


def data_dir_default() -> Path:
    return Path(os.environ.get("AAS_DATA_DIR") or DEFAULT_DATA_DIR)


def db_backend() -> str:
    """`sqlite`(기본) 또는 `postgres`. 단위 시험과 compose 는 sqlite 로 돈다."""
    return (os.environ.get("AAS_DB_BACKEND") or "sqlite").strip().lower()


def db_settings() -> dict:
    """PostgreSQL 접속 설정. 비밀번호는 환경변수로만 받는다(연결 문자열에 넣지 않는다)."""
    env = os.environ.get
    # 풀은 서버마다 최소 5·최대 20(스펙 2026-10-24-010 Q1·Q2). 최소만큼 미리 맺어 두어 요청이 새 연결(약 22ms)을 기다리지 않는다
    pool_max = int(env("AAS_DB_POOL_MAX") or 20)
    pool_min = min(int(env("AAS_DB_POOL_MIN") or 5), pool_max)
    return {"host": env("AAS_DB_HOST") or "aas-postgres", "port": int(env("AAS_DB_PORT") or 5432),
            "dbname": env("AAS_DB_NAME") or "aas", "user": env("AAS_DB_USER") or "aas",
            "password": env("AAS_DB_PASSWORD") or "", "sslmode": env("AAS_DB_SSLMODE") or "prefer",
            "schema": env("AAS_DB_SCHEMA") or "public",
            "pool_min": pool_min, "pool_max": pool_max, "pool_timeout": float(env("AAS_DB_POOL_TIMEOUT") or 10),
            "connect_wait": float(env("AAS_DB_CONNECT_WAIT") or 60),
            # 쿼리·잠금 대기·트랜잭션 중 쉼의 한도(PostgreSQL 단위 문자열). DB 노드가 사라지거나 트랜잭션 도중 서버가 없어져도
            # 풀이 바닥나거나 잠금이 남지 않게 한다(스펙 2026-10-24-002 R6·D3). 0 이면 끈다
            "statement_timeout": env("AAS_DB_STATEMENT_TIMEOUT") or "30s", "lock_timeout": env("AAS_DB_LOCK_TIMEOUT") or "10s",
            "idle_tx_timeout": env("AAS_DB_IDLE_TX_TIMEOUT") or "60s"}


def compose_env_file() -> Path | None:
    """Hermes 컨테이너 환경값 파일. 지정하지 않으면 읽지 않는다(쿠버네티스에는 이 파일이 없다)."""
    value = os.environ.get("AAS_HERMES_COMPOSE_ENV")
    return Path(value) if value else None


def read_env_file(path: Path | None = None) -> dict[str, str]:
    """KEY=VALUE 줄을 읽는다. 빈 줄·# 줄은 건너뛰고 값의 따옴표를 벗긴다. 파일이 없으면 빈 dict."""
    path = path or env_file()
    out: dict[str, str] = {}
    if not path.is_file():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            out[key.strip()] = value.strip().strip("\"'")
    return out


def get(key: str, default: str = "") -> str:
    """환경변수 → 환경 파일 → 기본값 순서로 읽는다."""
    if os.environ.get(key):
        return os.environ[key]
    return read_env_file().get(key) or default


def get_or_empty(key: str, default: str = "") -> str:
    """`get` 과 같지만 빈 값으로 적어 둔 것(기능 끄기)과 적지 않은 것(기본값)을 구분한다."""
    if key in os.environ:
        return os.environ[key]
    values = read_env_file()
    return values[key] if key in values else default


def missing(required: dict[str, str]) -> list[str]:
    """{이름: 환경변수} 중 값이 비어 있는 것을 「이름 (환경변수)」 목록으로 돌려준다."""
    return [f"{label} ({key})" for label, key in required.items() if not get(key)]
