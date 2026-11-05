# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""사이드카에서 받은 자격증명 파일의 원문을 받는 자리에서 버린다(스펙 2026-10-19-015 A1·리뷰 R10).

원문 대신 값마다 토큰(`aas-cred:<지문>[:jwt:<만료>]`)을 남긴다. 지문은 이 프로세스에서만 쓰는 무작위 키로 만든
HMAC 이라 디스크·화면으로 나가지 않고, 프로세스가 끝나면 되돌릴 방법이 없다. 같은 값이면 같은 지문이라
자격증명 현황표의 「같은 값」 묶기와 JWT 만료 표시는 그대로 된다(`inventory._Share`·`_jwt_exp`).

- `.env`(`.env.*`·`.envrc`·`*.env` 포함): `KEY=토큰` 줄만 남긴다(`export ` 는 그대로)(주석·빈 줄·값 없는 줄의 값은 버린다). 이름만 보는 곳(채널·스킬)은 그대로 동작한다.
- JSON: 모양과 키는 두고 문자열·숫자 값을 토큰으로 바꾼다. `url`·`base_url` 은 scheme://host/path 만 남긴다.
- 그 밖(`*.pem`·`*.key` 등): 파일 전체를 토큰 하나로 바꾼다.
compose(로컬) 모드는 파일을 직접 읽으므로 원문 그대로다. 그래도 `digest` 가 원문·토큰을 같은 지문으로 바꿔 결과가 같다.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import posixpath
import re
import secrets

from ...common.redact import clean_url

PREFIX = "aas-cred:"
_KEY = secrets.token_bytes(32)
_ENV_LINE = re.compile(r"^\s*((?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$")
_JWT = re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.([A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{4,}")
_URL_KEYS = frozenset({"url", "base_url"})
# Hermes 자격증명 파일 가운데 파일 항목(`aas/ops/pc_import._CREDENTIAL_PATHS` 의 파일 이름들, 시험이 빠짐없는지 본다).
# 폴더 항목(home·backups·proxy 등)은 다른 읽기 모듈이 쓰는지 조사한 뒤 더한다(스펙 §7).
CREDENTIAL_FILES = frozenset({
    "auth.json", ".op.env", "npmrc", ".anthropic_oauth.json", "google_token.json", "google_oauth.json", "google_oauth_pending.json",
    "google_client_secret.json", "google_chat_user_client_secret.json", "google_chat_user_oauth_pending.json",
    "google_chat_user_token.json", "slack_tokens.json", "honcho.json", "mem0.json", "webhook_subscriptions.json",
    "teams_pipeline_store.json", "feishu_comment_pairing.json", "bws_cache.json", "bws_cache.enc.json", "node_token.json",
    ".copilot_jwt.json", "photon-sidecar.json",
})
CREDENTIAL_DIRS = frozenset({"secrets", "mcp-tokens"})


def _is_env_name(name: str) -> bool:
    """KEY=VALUE 형식으로 읽을 자격증명 파일 이름인가(소문자). `.env`·`.env.*`·`.envrc`, 그리고 사용자 스킬이 흔히 쓰는
    `*.env`(`.docmost-work-log.env`·`.calendar.env` 등) — 빠져 있어 원문이 공용 내용 저장소에 들어갔다."""
    return name == ".envrc" or name.startswith(".env.") or name.endswith(".env")


def is_credential(rel: str) -> bool:
    """데이터 폴더 기준 경로 rel 이 자격증명 파일인가. 이름만 본다(대소문자 무시)."""
    parts = [p.lower() for p in rel.split("/") if p]
    if not parts:
        return False
    name = parts[-1]
    return (_is_env_name(name) or name.startswith(".cred-") or name in CREDENTIAL_FILES
            or name.endswith((".pem", ".key")) or any(p in CREDENTIAL_DIRS for p in parts[:-1]))


def _jwt_exp(value: str) -> str:
    m = _JWT.search(value)
    if not m:
        return ""
    try:
        payload = json.loads(base64.urlsafe_b64decode(m.group(1) + "=" * (-len(m.group(1)) % 4)))
        return str(int(float(payload["exp"])))
    except Exception:
        return "-"


def token(value: str) -> str:
    """값 하나를 토큰으로. JWT 면 만료(초)를 함께 싣는다(만료를 읽지 못하면 `-`)."""
    fp = hmac.new(_KEY, value.encode("utf-8", "surrogatepass"), hashlib.sha256).hexdigest()[:32]
    exp = _jwt_exp(value)
    return f"{PREFIX}{fp}" + (f":jwt:{exp}" if exp else "")


def is_token(value: str) -> bool:
    return isinstance(value, str) and value.startswith(PREFIX)


def digest(value: str) -> str:
    """같은 값 묶기에 쓰는 지문. 토큰이면 그 지문, 원문이면 같은 방법으로 만든 지문."""
    if not is_token(value):
        value = token(value)
    return value[len(PREFIX):].split(":", 1)[0]


def token_exp(value: str) -> float | None:
    """토큰에 실린 JWT 만료(초). 없으면 None."""
    if not is_token(value) or ":jwt:" not in value:
        return None
    try:
        return float(value.rsplit(":", 1)[1])
    except ValueError:
        return None


def is_jwt_token(value: str) -> bool:
    return is_token(value) and ":jwt:" in value


def _env(text: str) -> str:
    out = []
    for line in text.splitlines():
        m = _ENV_LINE.match(line)
        if not m or line.lstrip().startswith("#"):
            continue
        value = m.group(3).strip().strip("\"'")
        out.append(f"{m.group(1)}{m.group(2)}={token(value) if value else ''}")   # `export ` 는 남긴다(이름만 보는 곳의 결과가 원문과 같게)
    return "\n".join(out) + ("\n" if out else "")


def _json(obj, key: str = ""):
    if isinstance(obj, dict):
        return {k: _json(v, str(k)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_json(v, key) for v in obj]
    if isinstance(obj, bool) or obj is None:
        return obj
    if key.lower() in _URL_KEYS and isinstance(obj, str):
        return clean_url(obj)
    return token(str(obj)) if str(obj) else ""


def scrub(rel: str, data: bytes) -> bytes:
    """rel 이 자격증명 파일이면 원문을 버린 내용을, 아니면 data 를 그대로 돌려준다."""
    if not is_credential(rel):
        return data
    name = posixpath.basename(rel).lower()
    text = data.decode("utf-8", "replace")
    if _is_env_name(name):
        return _env(text).encode()
    if name.endswith(".json") or ".json." in name:
        try:
            return json.dumps(_json(json.loads(text)), ensure_ascii=False).encode()
        except ValueError:
            pass
    return token(text).encode()


def scrub_files(files: list[dict]) -> list[dict]:
    """사이드카 read 응답(`{"path","ok","data_b64",...}` 목록)의 자격증명 파일 내용을 바꾼다."""
    for f in files:
        if f.get("ok") and "data_b64" in f and is_credential(f.get("path", "")):
            data = scrub(f["path"], base64.b64decode(f["data_b64"]))
            f["data_b64"], f["size"] = base64.b64encode(data).decode(), len(data)
    return files
