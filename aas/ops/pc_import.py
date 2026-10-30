# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""내 PC 의 Hermes 묶음을 프로파일에 넣기, 프로파일을 PC 용으로 내보내기(OMAI-1136). 대상은 루트·임시가 아닌 이름 있는 프로파일(OMAI-1444).

  올리기   화면이 묶음(tar.gz)을 올린다. 서버는 흘려보내며 임시 파일에도 써서 검사하고(inspect), Hermes 의
           workspace/uploads/.import-<id>.tar.gz 에 넣는다. 검사 결과(개수·거절 이유)는 표 pc_imports 에 남는다.
  시작     확인 단계에서 「main 내용 바꾸기」를 누르면 뒤에서 단계를 돈다(Runner):
             import   묶음을 임시 프로파일(pcimp-<id>)로 가져온다(Hermes 대시보드). main 은 그대로다
             config   임시 프로파일의 config.yaml 을 main 설정 위에 얹은 글(import_overlay)로 바꾼다 — 잠긴 키·채널·MCP 는 main 값
             replace  오퍼레이터 작업(ProfileContentReplace)이 main 의 내용 항목을 보관한 뒤 임시 프로파일의 것으로 바꾸고 크론을 일시정지한다.
                      실패하면 그 자리에서 되돌린다. main 폴더·비밀값·로그인 정보·삭제 표시는 건드리지 않는다
             restart  루트 게이트웨이를 다시 시작한다. 실패하면 보관본으로 되돌린다(ProfileContentRestore)
             cleanup  임시 프로파일과 올린 묶음을 지운다(실패해도 결과는 그대로)
  복구     진행 중 표시가 오래 갱신되지 않으면(서버가 도중에 다시 떴다) 리더의 점검이 되돌리거나 실패로 닫는다.
  내보내기 main 을 /opt/data/.aas-exports/<id>.tar.gz 로 내보내고 주인·관리자 전용 경로로 한 번 내려받게 한다(작업 폴더 밖, R10).
"""
from __future__ import annotations

import io
import json
import posixpath
import re
import secrets
import tarfile
import threading
import urllib.parse
import zlib
from datetime import datetime, timedelta

import yaml

from ..common import config, store
from ..common.i18n import tr
from . import profile_copy


def _person(value: str) -> str:
    """기록의 「누가」(이메일) → 화면에 보일 이름(2026-10-30). 오피스 모듈을 늦게 부른다."""
    from ..office import office
    return office.person_name(value)


SCHEMA = """
CREATE TABLE IF NOT EXISTS pc_imports (
  id TEXT PRIMARY KEY, pod TEXT NOT NULL, profile TEXT NOT NULL, state TEXT NOT NULL, stage TEXT NOT NULL DEFAULT '',
  by_user TEXT NOT NULL DEFAULT '', owner TEXT NOT NULL DEFAULT '', by_admin INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL DEFAULT '{}', result TEXT NOT NULL DEFAULT '{}',
  error TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '', acks TEXT NOT NULL DEFAULT '[]',
  created TEXT NOT NULL DEFAULT '', updated TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS pc_exports (
  id TEXT PRIMARY KEY, pod TEXT NOT NULL, profile TEXT NOT NULL, by_user TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0,
  created TEXT NOT NULL DEFAULT '', downloaded TEXT NOT NULL DEFAULT '');
"""
PREFIX = "pcimp|"
STATES = ("uploaded", "rejected", "running", "done", "failed", "rolled_back", "rollback_failed", "cancelled")
STAGES = ("check", "import", "config", "replace", "secrets", "env", "restart", "cleanup")
UPLOADS = "workspace/uploads"
EXPORTS = ".aas-exports"
DATA_DIR = "/opt/data"
# 오퍼레이터 작업이 다루는 내용 항목(cogentai-aas-operator internal/tasks 와 같은 목록). 화면의 「바뀌는 것」 문장도 이것을 따른다
CONTENT_ITEMS = ("SOUL.md", "MEMORY.md", "USER.md", "todo.json", "AGENTS.md", "CLAUDE.md", "system_prompt.md", ".cursorrules",
                 "config.yaml", "memories", "skills", "cron", "scripts", "sessions", "plans")
# Hermes PROFILE_CREDENTIAL_PATHS(hermes_cli/profiles.py)와 HOME_CREDENTIAL_DIRS(agent/file_safety.py). 묶음에 있으면 거절한다.
# 내용 바꾸기는 위 항목만 옮기므로 이 검사는 한 겹 더 막는 장치다
_CREDENTIAL_PATHS = (
    "auth.json", ".env", "auth/google_oauth.json", ".op.env", "npmrc", ".anthropic_oauth.json", "google_token.json",
    "google_oauth_pending.json", "google_client_secret.json", "google_chat_user_tokens", "google_chat_user_client_secret.json",
    "google_chat_user_oauth_pending.json", "google_chat_user_token.json", "google_chat_user_oauth_pending", "slack_tokens.json",
    "honcho.json", "mem0.json", "webhook_subscriptions.json", "teams_pipeline_store.json", "mcp-tokens", "vault",
    "browser-profile", "browser_auth", "bot-desktop", "browser-profiles", "browser_profiles", "pairing", "platforms/pairing",
    "feishu_comment_pairing.json", "whatsapp/session", "platforms/whatsapp/session", "matrix/store", "platforms/matrix/store",
    "cache/bws_cache.json", "cache/bws_cache.enc.json", "workspace/meetings/node_token.json", "weixin/accounts", ".copilot_jwt.json",
    "runtime/photon-sidecar.json", "proxy", "chrome-debug", "home", "backups", "state-snapshots",
    ".ssh", ".aws", ".gnupg", ".kube", ".docker", ".azure", ".config/gh", ".config/gcloud", ".envrc")
_CRED_PARTS = tuple(tuple(p.casefold().split("/")) for p in _CREDENTIAL_PATHS)
_PC_PATH = re.compile(r"(/Users/|/home/|[A-Za-z]:\\)")
_ENV_REF = re.compile(r"\$\{([A-Z][A-Z0-9_]{1,80})\}")
_ID = re.compile(r"^[a-z0-9]{12}$")
UPLOADED_TTL = 24 * 3600                    # 확인 단계에 남은 묶음을 닫는 때(2026-10-22-003 R18)
REPLACE_WAIT = 20 * 60                      # 오퍼레이터 작업(대화 기록이 크면 오래 걸린다) 기다리는 최대 시간
STALE_AFTER = 10 * 60                       # 진행 중 표시가 이만큼 갱신되지 않으면 서버가 도중에 다시 뜬 것으로 본다


class ImportError_(Exception):
    """화면이 번역할 이유 코드(reason)와 사람이 읽을 문장. status 는 HTTP 상태."""

    def __init__(self, reason: str, message: str = "", status: int = 400):
        super().__init__(message or reason)
        self.reason, self.status = reason, status


def _now() -> datetime:
    return datetime.now().astimezone()


def _iso(dt: datetime | None = None) -> str:
    return (dt or _now()).isoformat(timespec="seconds")


def new_id() -> str:
    return secrets.token_hex(6)


TEMP_PREFIX = "pcimp-"                       # 임시 프로파일 이름 앞부분. 사용자가 이 이름으로 만들지 못하게 예약한다(OMAI-1444 R11)


def temp_profile(job_id: str) -> str:
    return f"{TEMP_PREFIX}{job_id}"


def reserved_name(name: str) -> bool:
    """임시 프로파일 이름인가. 목록에서 숨기고 만들기·이름 바꾸기·마켓 설치에서 거절한다(OMAI-1444 R11, ROV6·ROV8)."""
    return str(name or "").startswith(TEMP_PREFIX)


def reserved_error() -> str:
    return tr(f"{TEMP_PREFIX} 로 시작하는 이름은 쓸 수 없습니다", f"Names starting with {TEMP_PREFIX} cannot be used")


def upload_path(job_id: str) -> str:
    """올린 묶음의 Hermes 쪽 상대 경로. 점 이름이라 작업 폴더 목록에서 숨는다(workspace._hidden)."""
    return f"{UPLOADS}/.import-{job_id}.tar.gz"


def secrets_path(job_id: str) -> str:
    """비밀 묶음의 Hermes 쪽 상대 경로(2026-10-22-003 R13). 오퍼레이터 ProfileSecretsReplace 가 backup 이름으로 같은 경로를 찾는다."""
    return f"{UPLOADS}/.import-{job_id}.secrets.tar.gz"


def export_path(job_id: str) -> str:
    return f"{EXPORTS}/{job_id}.tar.gz"


def max_unpacked() -> int:
    """풀린 크기 합계 상한(R11-2). 기본 2GiB."""
    try:
        return max(1, int(config.get("AAS_PC_IMPORT_MAX_UNPACKED", str(2 * 1024 ** 3))))
    except ValueError:
        return 2 * 1024 ** 3


def max_members() -> int:
    try:
        return max(1, int(config.get("AAS_PC_IMPORT_MAX_FILES", "100000")))
    except ValueError:
        return 100000


def backup_days() -> int:
    """바꾸기 전 내용을 남겨 두는 날 수(결과 화면 문장). 지나면 하루 한 번 점검이 지운다(prune_backup). 0 이면 지우지 않는다."""
    try:
        return max(0, int(config.get("AAS_PC_IMPORT_BACKUP_DAYS", "14")))
    except ValueError:
        return 14


# ---- 묶음 검사 --------------------------------------------------------------------------------------
# 비밀 경로 중 main 으로 옮기는 토큰·키 파일(2026-10-22-003 R9·R14·R20). 그 밖의 비밀 경로는 버리고 이름만 보인다
SECRET_MOVE = (
    "google_token.json", "google_oauth_pending.json", "google_client_secret.json", "auth/google_oauth.json", "google_chat_user_tokens",
    "google_chat_user_client_secret.json", "google_chat_user_oauth_pending.json", "google_chat_user_token.json",
    "google_chat_user_oauth_pending", "slack_tokens.json", "honcho.json", "mem0.json", "webhook_subscriptions.json",
    "teams_pipeline_store.json", "mcp-tokens", "vault", "pairing", "platforms/pairing", "feishu_comment_pairing.json",
    "cache/bws_cache.json", "cache/bws_cache.enc.json", "workspace/meetings/node_token.json", "npmrc", ".op.env")
_MOVE_PARTS = tuple(tuple(p.casefold().split("/")) for p in SECRET_MOVE)
# main 이 아닌 대상에는 옮기지 않는 채널 연결 파일(OMAI-1444 R8). 한 게이트웨이 안의 두 프로파일에 같은 채널 연결이 생기지 않게 한다
CHANNEL_MOVE = ("slack_tokens.json", "webhook_subscriptions.json", "teams_pipeline_store.json", "pairing", "platforms/pairing", "feishu_comment_pairing.json")
_CHANNEL_MOVE_PARTS = tuple((p, tuple(p.casefold().split("/"))) for p in CHANNEL_MOVE)
# 오퍼레이터가 모든 Hermes 컨테이너에 넣는 환경변수(cogentai-aas-operator internal/resources/resources.go hermesEnv). 설정이 ${이름} 으로 참조해도
# 프로파일 .env 에 없을 뿐 비어 있지 않으므로 「비밀값 필요」에서 뺀다 — AAS 에서 내보낸 묶음을 다시 가져오면 늘 다섯 개로 잘못 나왔다(OMAI-1444 실제 시험)
CONTAINER_ENV = frozenset({"AAS_AGENT_NAME", "AAS_OWNER_SUB", "HERMES_LLM_BASE_URL", "HERMES_LLM_MODEL", "HERMES_LLM_API_KEY"})
MODEL_FILES = ("auth.json", ".anthropic_oauth.json", ".copilot_jwt.json")   # 모델 연결 파일은 누가 하든 옮기지 않는다(R14)
_MCP_PREFIX = ("mcp-tokens",)
_CHANNEL_PREFIX = ("pairing", "platforms/pairing", "slack_tokens.json", "google_chat_user", "feishu_comment_pairing.json")
NAMES_MAX, LINK_SKILLS_MAX = 20, 50
_ENV_NAME = re.compile(r"^[A-Z][A-Z0-9_]{1,63}$")                    # fleet.profiles.ENV_KEY 와 같다(비밀값 탭과 같은 이름 규칙)
PAUSED_REASON = "PC 에서 가져옴"                                       # i18n-ignore: jobs.json 에 저장되는 값(Hermes 크론 화면이 보인다)
SOUL_NOTE = "PC 에서 가져옴"                                           # i18n-ignore: DB 에 저장하는 SOUL 판 메모(UI 가 번역한다, OMAI-1444 R12)


def _credential(rel: str) -> bool:
    parts = tuple(p.casefold() for p in rel.split("/") if p)
    if not parts:
        return False
    name = parts[0]
    if len(parts) == 1 and (name.startswith("auth.json.") or name.startswith(".env.")):
        return True
    return any(parts[:len(c)] == c for c in _CRED_PARTS)


def _secret_move(rel: str) -> bool:
    parts = tuple(p.casefold() for p in rel.split("/") if p)
    return bool(parts) and any(parts[:len(c)] == c for c in _MOVE_PARTS)


def _channel_move(rel: str) -> str:
    """CHANNEL_MOVE 중 rel 이 속한 이름. 아니면 빈 문자열."""
    parts = tuple(p.casefold() for p in rel.split("/") if p)
    return next((name for name, c in _CHANNEL_MOVE_PARTS if parts[:len(c)] == c), "")


def secret_kind(rel: str) -> str:
    """옮기는 비밀 파일의 갈래(화면의 「MCP 로그인 파일」·「채널 연결 파일」, DD2). 그 밖은 빈 문자열."""
    low = rel.casefold()
    if any(low == p or low.startswith(p + "/") for p in _MCP_PREFIX):
        return "mcp"
    if any(low == p or low.startswith(p + "/") or (p == "google_chat_user" and low.startswith(p)) for p in _CHANNEL_PREFIX):
        return "channel"
    return ""


def parse_env(raw: bytes) -> tuple[dict[str, str], list[str]]:
    """.env 를 한 줄 KEY=VALUE 규칙으로 읽는다(R21). (이름 → 값, 읽을 수 없는 이름). `=` 가 없는 줄은 이름을 알 수 없어 건너뛴다 —
    줄을 그대로 보이면 값이 섞일 수 있다. 값은 이 함수를 부른 쪽 메모리에만 둔다."""
    keys: dict[str, str] = {}
    bad: set[str] = set()
    for line in raw.decode("utf-8", "replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        name, _, value = line.partition("=")
        name, value = name.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        elif value[:1] in ("'", '"'):                                 # 따옴표가 닫히지 않았다(여러 줄 값)
            value = ""
        if not _ENV_NAME.match(name) or not value or len(value) > 4000 or any(c in value for c in "\r\n\x00"):
            if name:
                bad.add(name[:80])
            keys.pop(name, None)
            continue
        bad.discard(name)
        keys[name] = value
    return keys, sorted(bad)


def _frontmatter(text: str) -> dict:
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    try:
        data = yaml.safe_load(text[3:end] if end > 0 else "")
    except yaml.YAMLError:
        return {}
    return data if isinstance(data, dict) else {}


def _paused_jobs(raw: bytes) -> bytes:
    """예약 작업을 모두 일시정지한 jobs.json(R13). 임시 프로파일의 게이트웨이가 PC 작업을 돌리지 않게 한다. 읽을 수 없으면 그대로."""
    try:
        data = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return raw
    jobs = data.get("jobs") if isinstance(data, dict) else data
    for j in jobs if isinstance(jobs, list) else []:
        if isinstance(j, dict):
            j.update(enabled=False, state="paused", paused_reason=PAUSED_REASON)
    return json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")


def _clean_info(m: tarfile.TarInfo, name: str, size: int | None = None) -> tarfile.TarInfo:
    info = tarfile.TarInfo(name)
    info.type = tarfile.DIRTYPE if m.isdir() else tarfile.REGTYPE
    info.mode, info.mtime = m.mode & 0o7777, m.mtime
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    info.size = 0 if m.isdir() else (m.size if size is None else size)
    return info


def _names(counter: dict[str, int], limit: int = NAMES_MAX) -> list[dict]:
    return [{"name": k, "files": counter[k]} for k in sorted(counter)[:limit]]


def inspect(fileobj, content_out=None, secrets_out=None, secrets_enabled: bool = True, skip_channels: bool = False) -> dict:
    """올린 묶음을 한 번 읽으며 거절 이유·개수를 내고, 내용 묶음(content_out)과 비밀 묶음(secrets_out)을 쓴다(2026-10-22-003 §4-1·§4-2).
    원본은 디스크에 풀지 않는다. secrets_enabled 가 거짓이면(https 아님, R17) 비밀 묶음을 만들지 않는다.
    skip_channels 가 참이면(main 이 아닌 대상, OMAI-1444 R8) 채널 연결 파일(CHANNEL_MOVE)을 비밀 묶음과 개수에서 빼고 이름만 channel_files_skipped 에 둔다.
    거절이면 두 출력의 내용은 쓰지 않는다(부르는 쪽이 버린다). 비밀 묶음은 넣을 파일이 있을 때만 생긴다."""
    out = {"ok": False, "reason": "", "root": "", "unpacked": 0, "members": 0,
           "counts": {"skills": 0, "cron": 0, "sessions": 0, "memories": 0, "soul": False},
           "os_only_skills": [], "pc_path_jobs": [], "env_refs": [], "kept": 0, "kept_size": 0, "secrets_enabled": bool(secrets_enabled),
           "secrets": {"files": [], "files_count": 0, "env_keys": [], "env_keys_count": 0, "env_unreadable": [], "size": 0,
                       "model_files": [], "mcp_files": 0, "channel_files": 0},
           "dropped": {}, "top_names": []}
    roots: set[str] = set()
    tops: set[str] = set()
    jobs_raw = b""
    env_refs: set[str] = set()
    links, link_skills = 0, set()
    cred, other, off = {}, {}, {}
    channel_skipped: set[str] = set()
    sec_files, env_keys, env_bad, model_files = [], [], [], set()
    content_tar = secrets_tar = None

    def secret_writer():
        nonlocal secrets_tar
        if secrets_tar is None and secrets_out is not None:
            secrets_tar = tarfile.open(fileobj=secrets_out, mode="w:gz", compresslevel=6)
        return secrets_tar

    try:
        if content_out is not None:
            content_tar = tarfile.open(fileobj=content_out, mode="w:gz", compresslevel=6)
        with tarfile.open(fileobj=fileobj, mode="r:*") as tar:
            for m in tar:
                out["members"] += 1
                if out["members"] > max_members():
                    out["reason"] = "too_many"
                    return out
                name = m.name
                while name.startswith("./"):                       # `tar -C dir .` 로 묶으면 ./ 가 붙는다(점 파일 이름은 그대로 둔다)
                    name = name[2:]
                if name in ("", ".") and m.isdir():
                    continue
                if not name or name.startswith("/") or "\x00" in name or any(p == ".." for p in name.split("/")):
                    out["reason"] = "bad_path"
                    return out
                parts = [p for p in name.split("/") if p]
                roots.add(parts[0])
                if len(roots) > 1:
                    out["reason"] = "multi_root"
                    return out
                if len(parts) == 1:
                    if not m.isdir():                              # 최상위 폴더 하나 아래에 있어야 한다(hermes profile export 의 모양)
                        out["reason"] = "multi_root"
                        return out
                    if content_tar is not None:
                        content_tar.addfile(_clean_info(m, parts[0]))
                    continue
                rel = "/".join(parts[1:])
                top = parts[1]
                if not (_secret_move(rel) or rel == ".env" or _credential(rel)):   # no_content 문구에 보일 이름. 비밀 경로 이름은 넣지 않는다(R28)
                    tops.add(top)
                if m.isreg():                                      # 원본 전체의 풀린 크기 상한은 버릴 파일도 센다(R1, 압축 폭탄)
                    out["unpacked"] += m.size
                    if out["unpacked"] > max_unpacked():
                        out["reason"] = "too_big"
                        return out
                if not (m.isreg() or m.isdir()):                   # 4. 링크·장치·FIFO
                    links += 1
                    if top == "skills" and len(parts) > 2:
                        link_skills.add(parts[-1])
                    continue
                if _secret_move(rel) or (rel == ".env"):
                    if not m.isreg():                              # 비밀 묶음에는 일반 파일만(빈 폴더는 넣지 않는다, R12)
                        continue
                    channel = _channel_move(rel) if skip_channels else ""
                    if channel:                                    # main 이 아닌 대상: 옮기지 않고 이름만(R8). https 여부와 관계없이 같다
                        channel_skipped.add(channel)
                        continue
                    if not secrets_enabled:                        # https 아님(R17): 옮기지 않고 따로 센다(화면이 「가져오지 않는 것」에 다시 세지 않는다)
                        off[top] = off.get(top, 0) + 1
                        continue
                    data = _read(tar, m, m.size)
                    if rel == ".env":
                        keys, bad = parse_env(data)
                        env_keys, env_bad = sorted(keys), bad
                    else:
                        sec_files.append(rel)
                        kind = secret_kind(rel)
                        if kind:
                            out["secrets"][f"{kind}_files"] += 1
                    out["secrets"]["size"] += m.size
                    w = secret_writer()
                    if w is not None:
                        w.addfile(_clean_info(m, f"{parts[0]}/{rel}", len(data)), io.BytesIO(data))
                    continue
                if _credential(rel):                               # 7. 옮기지 않는 비밀
                    if m.isreg():
                        cred[top] = cred.get(top, 0) + 1
                        if rel in MODEL_FILES:
                            model_files.add(rel)
                    continue
                if top not in CONTENT_ITEMS:                       # 8. 내용 항목 밖(plugins/·logs/·state.db·workspace/ …)
                    if m.isreg():
                        other[top] = other.get(top, 0) + 1
                    continue
                if m.isdir():                                      # 9. 내용 항목
                    if content_tar is not None:
                        content_tar.addfile(_clean_info(m, f"{parts[0]}/{rel}"))
                    continue
                out["kept"] += 1
                out["kept_size"] += m.size
                data = None
                if top == "SOUL.md" and len(parts) == 2:
                    out["counts"]["soul"] = True
                elif top == "sessions":
                    out["counts"]["sessions"] += 1
                elif top == "memories":
                    out["counts"]["memories"] += 1
                elif top == "skills" and parts[-1] == "SKILL.md":
                    out["counts"]["skills"] += 1
                    data = _read(tar, m, m.size)
                    meta = _frontmatter(data[:256 * 1024].decode("utf-8", "replace"))
                    plats = meta.get("platforms")
                    if isinstance(plats, list) and plats and "linux" not in [str(p).lower() for p in plats]:
                        out["os_only_skills"].append(str(meta.get("name") or parts[-2]))
                    nested = meta.get("metadata") if isinstance(meta.get("metadata"), dict) else {}
                    req = meta.get("required_env") or nested.get("required_env")
                    for k in req if isinstance(req, list) else []:
                        if isinstance(k, str) and re.match(r"^[A-Z][A-Z0-9_]{1,80}$", k):
                            env_refs.add(k)
                elif rel == "cron/jobs.json":
                    data = _read(tar, m, 5 * 1024 * 1024)
                    if len(data) == m.size:
                        jobs_raw = data
                        data = _paused_jobs(data)
                    else:                                          # 너무 커서 고칠 수 없다. 그대로 두면 임시 프로파일에서 돌 수 있으니 넣지 않는다
                        data = b""
                        out["kept"] -= 1
                        out["kept_size"] -= m.size
                        continue
                elif rel == "config.yaml":
                    data = _read(tar, m, m.size)
                    if m.size <= 1024 * 1024:
                        env_refs.update(_ENV_REF.findall(data.decode("utf-8", "replace")))
                if content_tar is not None:
                    if data is None:
                        content_tar.addfile(_clean_info(m, f"{parts[0]}/{rel}"), tar.extractfile(m))
                    else:
                        content_tar.addfile(_clean_info(m, f"{parts[0]}/{rel}", len(data)), io.BytesIO(data))
    except (tarfile.TarError, EOFError, OSError, zlib.error):
        out["reason"] = "not_archive"
        return out
    finally:
        for t in (content_tar, secrets_tar):
            if t is not None:
                try:
                    t.close()
                except (tarfile.TarError, OSError):
                    pass
    if not roots:
        out["reason"] = "empty"
        return out
    out["root"] = next(iter(roots))
    out["top_names"] = sorted(tops)[:3]
    out["dropped"] = {
        "links": links, "link_skills": sorted(link_skills)[:LINK_SKILLS_MAX], "link_skills_count": len(link_skills),
        "credential": sum(cred.values()), "credential_names": sorted(cred)[:NAMES_MAX],
        "credential_groups": _names(cred), "credential_groups_count": len(cred),
        "other": sum(other.values()), "other_names": sorted(other)[:NAMES_MAX],
        "other_groups": _names(other), "other_groups_count": len(other),
        "secrets_off": sum(off.values()), "secrets_off_names": sorted(off)[:NAMES_MAX], "secrets_off_count": len(off)}
    sec = out["secrets"]
    sec.update(files=sorted(sec_files)[:NAMES_MAX], files_count=len(sec_files), env_keys=env_keys[:NAMES_MAX],
               env_keys_count=len(env_keys), env_unreadable=env_bad[:NAMES_MAX], model_files=sorted(model_files))
    out["secrets_bundle"] = secrets_tar is not None
    if skip_channels:
        out["channel_files_skipped"] = sorted(channel_skipped)
    out["secrets_index"] = {"files": sorted(sec_files), "env_keys": env_keys, "env_unreadable": env_bad}   # 미리 나누기 입력(OV-1). 화면에는 보내지 않는다
    if not out["kept"]:
        out["reason"] = "no_content"
        return out
    for t, label in ((content_out, "content"), (secrets_out, "secrets")):
        try:
            size = t.tell() if t is not None else 0
        except (OSError, ValueError):
            size = 0
        if size > _bundle_max():                                    # 다시 압축해 커질 수 있다(독립 검토 L1)
            out["reason"] = "too_big"
            return out
    jobs = _jobs_of(jobs_raw)
    out["counts"]["cron"] = len(jobs)
    out["pc_path_jobs"] = [str(j.get("name") or j.get("id") or "")[:80] for j in jobs if _PC_PATH.search(json.dumps(j, ensure_ascii=False))]
    out["env_refs"] = sorted(env_refs)
    out["os_only_skills"] = sorted(set(out["os_only_skills"]))
    out["ok"] = True
    return out


def _bundle_max() -> int:
    """거른 묶음 하나의 상한. Hermes upload-stream 의 한 파일 상한(workspace.MAX_FILE)과 같다."""
    from ..hermes import workspace
    return workspace.MAX_FILE


def _read(tar: tarfile.TarFile, m: tarfile.TarInfo, limit: int) -> bytes:
    if m.size > limit:
        return b""
    f = tar.extractfile(m)
    return f.read(limit) if f else b""


def _jobs_of(raw: bytes) -> list[dict]:
    if not raw:
        return []
    try:
        data = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return []
    jobs = data.get("jobs") if isinstance(data, dict) else data
    return [j for j in jobs if isinstance(j, dict)] if isinstance(jobs, list) else []


def inspect_bytes(blob: bytes) -> dict:
    return inspect(io.BytesIO(blob))


# ---- 기록 -----------------------------------------------------------------------------------------
def _conn():
    conn = store.connect()
    conn.executescript(SCHEMA)
    return conn


def _row(r) -> dict:
    d = dict(r)
    for k in ("summary", "result"):
        try:
            d[k] = json.loads(d.get(k) or "{}")
        except ValueError:
            d[k] = {}
    try:
        d["acks"] = json.loads(d.get("acks") or "[]")
    except ValueError:
        d["acks"] = []
    return d


def record_upload(job_id: str, pod: str, profile: str, by_user: str, owner: str, by_admin: bool, name: str, size: int, summary: dict) -> dict:
    state = "uploaded" if summary.get("ok") else "rejected"
    if state == "rejected":                                       # 닫힌 기록에는 비밀 이름을 남기지 않는다(R28)
        summary = scrub_summary(summary)
    now = _iso()
    with _conn() as conn:
        conn.execute("INSERT INTO pc_imports (id, pod, profile, state, stage, by_user, owner, by_admin, name, size, summary, reason, created, updated) "
                     "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                     (job_id, pod, profile, state, "check", (by_user or "").lower(), (owner or "").lower(), 1 if by_admin else 0,
                      name[:200], int(size), json.dumps(summary, ensure_ascii=False), summary.get("reason") or "", now, now))
    return get(job_id)


def get(job_id: str) -> dict | None:
    with _conn() as conn:
        r = conn.execute("SELECT * FROM pc_imports WHERE id=?", (job_id,)).fetchone()
    return _row(r) if r else None


def latest(pod: str, profile: str) -> dict | None:
    """이 파드·프로파일의 마지막 가져오기. 서랍을 다시 열면 이것을 보인다(D6). 취소한 것은 건너뛴다."""
    with _conn() as conn:
        r = conn.execute("SELECT * FROM pc_imports WHERE pod=? AND profile=? AND state<>'cancelled' ORDER BY created DESC, id DESC LIMIT 1",
                         (pod, profile)).fetchone()
    return _row(r) if r else None


def running(pod: str) -> dict | None:
    with _conn() as conn:
        r = conn.execute("SELECT * FROM pc_imports WHERE pod=? AND state='running' LIMIT 1", (pod,)).fetchone()
    return _row(r) if r else None


def _set(job_id: str, **fields) -> None:
    fields["updated"] = _iso()
    for k in ("summary", "result"):
        if k in fields and not isinstance(fields[k], str):
            fields[k] = json.dumps(fields[k], ensure_ascii=False)
    cols = ", ".join(f"{k}=?" for k in fields)
    with _conn() as conn:
        conn.execute(f"UPDATE pc_imports SET {cols} WHERE id=?", (*fields.values(), job_id))


def claim(job_id: str, pod: str) -> bool:
    """uploaded → running. 같은 파드에서 이미 도는 것이 있으면 거짓(하나만, R7). 여러 서버 복제본이 같은 DB 를 보므로 조건부 UPDATE 로 정한다."""
    now = _iso()
    with _conn() as conn:
        cur = conn.execute("UPDATE pc_imports SET state='running', stage='import', updated=? WHERE id=? AND pod=? AND state='uploaded' "
                           "AND NOT EXISTS (SELECT 1 FROM pc_imports WHERE pod=? AND state='running')", (now, job_id, pod, pod))
        return (cur.rowcount or 0) > 0


def cancel(job_id: str, reason: str = "") -> bool:
    """uploaded·rejected → cancelled. reason 은 expired(24시간, R18)·replaced(같은 파드에 새로 올림)·빈 문자열(사용자가 그만둠).
    닫으면 비밀 이름을 지운다(R28). 두 묶음을 지우는 일은 부른 쪽이 한다."""
    row = get(job_id)
    if not row:
        return False
    with _conn() as conn:
        cur = conn.execute("UPDATE pc_imports SET state='cancelled', reason=?, summary=?, updated=? WHERE id=? AND state IN ('uploaded','rejected')",
                           (reason, json.dumps(scrub_summary(row["summary"]), ensure_ascii=False), _iso(), job_id))
        return (cur.rowcount or 0) > 0


def uploaded_of(pod: str, profile: str) -> list[dict]:
    """이 파드·프로파일의 확인 단계 기록(같은 프로파일에 새로 올리면 닫는다, R18·OMAI-1444 R6). 다른 프로파일의 것은 그대로 둔다."""
    with _conn() as conn:
        return [_row(r) for r in conn.execute("SELECT * FROM pc_imports WHERE pod=? AND profile=? AND state='uploaded'", (pod, profile))]


def move_profile(pod: str, old: str, new: str) -> None:
    """프로파일 이름을 바꾸면 그 이름의 기록이 새 이름을 따라간다(OMAI-1444 R2). 결과 화면·「확인할 것」이 바뀐 프로파일에 남는다."""
    with _conn() as conn:
        conn.execute("UPDATE pc_imports SET profile=? WHERE pod=? AND profile=?", (new, pod, old))


def detach_profile(pod: str, name: str) -> None:
    """프로파일을 지우면 그 이름의 기록을 이름과 끊는다(profile 을 비움, OMAI-1444 R2). 같은 이름으로 새로 만든 프로파일에 옛 기록이 붙지 않는다.
    기록·보관 폴더는 남는다. 받은편지함은 끊긴 기록을 에이전트 이름만으로 보인다."""
    with _conn() as conn:
        conn.execute("UPDATE pc_imports SET profile='' WHERE pod=? AND profile=?", (pod, name))


def expired(now: datetime | None = None) -> list[dict]:
    """확인 단계에 UPLOADED_TTL 넘게 남은 기록(R18). 리더 점검이 닫고 두 묶음을 지운다."""
    cut = _iso((now or _now()) - timedelta(seconds=UPLOADED_TTL))
    with _conn() as conn:
        return [_row(r) for r in conn.execute("SELECT * FROM pc_imports WHERE state='uploaded' AND updated < ?", (cut,))]


def set_summary(job_id: str, **fields) -> dict:
    """summary 에 값을 더한다(secrets_supported·secrets_plan_seen). 고친 summary."""
    row = get(job_id)
    if not row:
        return {}
    summary = {**row["summary"], **fields}
    _set(job_id, summary=summary)
    return summary


# ---- 비밀 이름 지우기(R28) ---------------------------------------------------------------------------------
_SUMMARY_NAME_KEYS = ("secrets_index", "secrets_plan_seen", "keeps")   # keeps 는 확인 단계에만 쓰고 비밀 이름(secrets_plan)이 들어 있다(OMAI-1444 R14)
_RESULT_NAME_KEYS = ("env_planned", "env_added", "env_failed", "env_skipped", "secrets_replaced", "secrets_added")


def scrub_summary(summary: dict) -> dict:
    """비밀 파일·키 이름을 지우고 개수만 남긴다."""
    out = {k: v for k, v in (summary or {}).items() if k not in _SUMMARY_NAME_KEYS}
    sec = dict(out.get("secrets") or {})
    for k in ("files", "env_keys", "env_unreadable", "model_files"):
        if k in sec:
            sec[k] = []
    if sec:
        out["secrets"] = sec
    dropped = dict(out.get("dropped") or {})
    for k in ("credential_names", "credential_groups", "secrets_off_names"):
        if k in dropped:
            dropped[k] = []
    if dropped:
        out["dropped"] = dropped
    out["names_scrubbed"] = True
    return out


def scrub_result(result: dict) -> dict:
    out = {k: v for k, v in (result or {}).items() if k not in _RESULT_NAME_KEYS}
    for k in _RESULT_NAME_KEYS:
        if (result or {}).get(k):
            out[f"{k}_n"] = len(result[k])
    out["names_scrubbed"] = True
    return out


def names_due(now: datetime | None = None, days: int | None = None) -> list[dict]:
    """보관 기간이 지나 비밀 이름을 지울 끝난 기록(done·rolled_back·failed, R28). 기간이 0 이면 지우지 않는다."""
    days = backup_days() if days is None else days
    if days <= 0:
        return []
    cut = _iso((now or _now()) - timedelta(days=days))
    with _conn() as conn:
        rows = [_row(r) for r in conn.execute("SELECT * FROM pc_imports WHERE state IN ('done','rolled_back','failed') AND updated < ?", (cut,))]
    return [r for r in rows if not r["result"].get("names_scrubbed")]


def scrub_names(job: dict) -> None:
    """updated 는 그대로 둔다(보관 기간 판정이 updated 를 본다)."""
    with _conn() as conn:
        conn.execute("UPDATE pc_imports SET summary=?, result=? WHERE id=?",
                     (json.dumps(scrub_summary(job["summary"]), ensure_ascii=False), json.dumps(scrub_result(job["result"]), ensure_ascii=False), job["id"]))


def view(row: dict | None) -> dict | None:
    """화면에 보내는 모양. 오류 문장은 사람이 읽는 것이고, 화면은 reason 코드로 문장을 고른다."""
    if not row:
        return None
    summary = {k: v for k, v in (row["summary"] or {}).items() if k not in _SUMMARY_NAME_KEYS}   # 전체 이름 목록은 화면에 보내지 않는다(OV-1)
    return {"id": row["id"], "profile": row["profile"], "state": row["state"], "stage": row["stage"], "name": row["name"], "size": row["size"],
            "by_admin": bool(row["by_admin"]), "owner": row["owner"], "owner_name": _person(row["owner"] or ""), "summary": summary, "result": _without_container_env(row["result"]),
            "reason": row["reason"], "error": row["error"], "created": row["created"], "updated": row["updated"],
            "backup_days": backup_days(), "stages": stages_of(row["summary"])}


def _without_container_env(result: dict | None) -> dict | None:
    """결과의 「비밀값 필요」에서 컨테이너가 주는 이름을 뺀다(CONTAINER_ENV). 고치기 전에 끝난 기록도 화면에 바르게 보이게."""
    if not result or not result.get("secrets_needed"):
        return result
    return {**result, "secrets_needed": [k for k in result["secrets_needed"] if k not in CONTAINER_ENV]}


def stages_of(summary: dict) -> list[str]:
    """화면 진행 표시의 단계(DD14). 비밀 묶음이 있으면 secrets·env 를 더한다."""
    if (summary or {}).get("secrets_bundle"):
        return ["import", "config", "replace", "secrets", "env", "skills", "restart"]
    return ["import", "config", "replace", "skills", "restart"]          # skills: 가려진 기본 스킬 되돌리기(스펙 2026-10-27-011 D10)


def plan_env(keys, listing, unreadable=()) -> dict:
    """.env 키를 main 에 넣을 것·건너뛸 것으로 나눈다(R6·R16·R21·R25). listing 은 Hermes GET /api/env 응답, 읽지 못했으면 None.
    {"add": [...], "exists": [...], "blocked": [...], "unreadable": [...], "unchecked": [...]} — 모두 이름만."""
    from . import owner_guard
    out = {"add": [], "exists": [], "blocked": [], "unreadable": sorted(set(unreadable)), "unchecked": []}
    if listing is None:
        out["unchecked"] = sorted(set(keys))
        return out
    have = env_names_of(listing)
    catalog = owner_guard.catalog_of(listing)
    for k in sorted(set(keys)):
        if k in have:
            out["exists"].append(k)
        elif owner_guard.env_key_check(k, catalog)[0]:
            out["blocked"].append(k)
        else:
            out["add"].append(k)
    return out


def plan_files(paths, check, profile: str) -> dict:
    """비밀 파일을 main 에서 바뀔 것·새로 생길 것으로 나눈다. check(rel) 은 사이드카 check(데이터 폴더 기준).
    main 쪽이 링크면 바뀜으로 센다(오퍼레이터가 링크를 지우고 쓴다, OV-10)."""
    replace, new = [], []
    for rel in paths:
        info = check(f"profiles/{profile}/{rel}") or {}
        (replace if info.get("exists") else new).append(rel)
    return {"files_replace": replace, "files_new": new}


def read_env_from(blob: bytes) -> tuple[dict[str, str], list[str]]:
    """비밀 묶음에서 최상위 .env 를 읽는다. 없거나 읽을 수 없으면 빈 값."""
    try:
        with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as tar:
            for m in tar:
                parts = [p for p in m.name.split("/") if p and p != "."]
                if len(parts) == 2 and parts[1] == ".env" and m.isreg():
                    return parse_env(_read(tar, m, 1024 * 1024))
    except (tarfile.TarError, EOFError, OSError, zlib.error):
        pass
    return {}, []


# ---- 단계 실행 --------------------------------------------------------------------------------------
class Runner:
    """한 가져오기의 단계를 돈다. api 는 Hermes 대시보드(HermesAPI), task 는 오퍼레이터 작업을 만들고 기다리는 함수,
    restart 는 게이트웨이를 다시 시작하는 함수, env_names 는 대상에 넣어진 비밀값 이름을 읽는 함수(읽지 못하면 None),
    download 는 데이터 폴더 기준 경로의 파일을 사이드카로 읽는 함수다(시험에서 바꿔 끼운다).
    notice(판_전, 판_후) 는 SOUL 이 바뀌었을 때 오피스 방에 알리는 함수다(OMAI-1444 R10·R12). 없으면 판 기록만 남긴다."""

    def __init__(self, job: dict, api, task, restart, env_names=None, on_change=None, download=None, notice=None):
        self.job, self.api, self.task, self.restart = job, api, task, restart
        self.env_names = env_names or (lambda: set())
        self.on_change = on_change or (lambda: None)
        self.download = download
        self.notice = notice

    def _stage(self, stage: str) -> None:
        _set(self.job["id"], stage=stage)
        self.on_change()

    def run(self) -> dict:
        jid, profile = self.job["id"], self.job["profile"]
        temp = temp_profile(jid)
        summary = self.job.get("summary") or {}
        sec = summary.get("secrets") or {}
        enabled = bool(summary.get("secrets_enabled") and summary.get("secrets_bundle"))
        has_files = enabled and bool(sec.get("files_count"))
        has_env = enabled and bool(sec.get("env_keys_count") or sec.get("env_unreadable"))
        values: dict[str, str] = {}
        plan = None
        result: dict = {}
        try:
            self.api.call("POST", "/api/profiles/import", {"archive": f"{DATA_DIR}/{upload_path(jid)}", "name": temp}, timeout=600)
            self._stage("config")
            main_cfg = str(self.api.call("GET", "/api/config/raw", query={"profile": profile}).get("yaml") or "")
            temp_cfg = str(self.api.call("GET", "/api/config/raw", query={"profile": temp}).get("yaml") or "")
            merged = profile_copy.import_overlay(main_cfg, temp_cfg)           # 잠긴 키·채널·MCP 는 main 값(R9)
            self.api.call("PUT", "/api/config/raw", {"yaml_text": merged, "profile": temp}, {"profile": temp})
            if has_env:                                                   # .env 값은 이 함수의 메모리에만 둔다(§4-5)
                values, plan = self._env_plan(profile, summary)
            soul_before = self._soul(profile)                             # 끝나면 「고치기 전」 판으로 남긴다(OMAI-1444 R12). 읽지 못하면 판·알림 없음
            self._stage("replace")
        except Exception as exc:                                          # noqa: BLE001 — main 은 아직 그대로다
            self._cleanup(temp)
            return self._finish("failed", "import_failed", str(exc))
        try:
            self.task("ProfileContentReplace", profile, temp, jid)
        except Exception as exc:                                          # noqa: BLE001
            word = _word(str(exc))
            self._cleanup(temp)
            if word in ("ROLLEDBACK", "BACKUPFAILED", "NOPROFILE", "NOSOURCE", "BACKUPEXISTS", "NOHOME", "INVALID"):
                return self._finish("rolled_back" if word == "ROLLEDBACK" else "failed", "replace_failed", str(exc))
            return self._finish("rollback_failed", "replace_failed", str(exc))
        secrets_ran = False
        if has_files:
            self._stage("secrets")
            try:
                self.task("ProfileSecretsReplace", profile, "", jid)
                secrets_ran = True
                result.update(self._secret_lists())
            except Exception as exc:                                      # noqa: BLE001
                if not unsupported(exc):                                  # 실행 중 실패: 비밀·내용 모두 되돌린다
                    return self._restore(temp, "secrets_failed", str(exc), secrets=True, result=result)
                result["secrets_unsupported"] = True                      # 옛 CRD·옛 오퍼레이터: 파일을 바꾸기 전 거절(R19·R22). 내용은 그대로 둔다
        if plan is not None:
            self._stage("env")
            result.update(self._put_env(profile, values, plan))
        values.clear()
        self._stage("skills")                                             # 내보내기 때 가려진 기본 스킬을 서버 기본 판으로(스펙 2026-10-27-011 R11). 실패해도 가져오기는 계속한다(D8)
        result.update(self._bundled_repair(profile))
        self._cleanup(temp)                                               # 임시 프로파일은 더 쓰지 않는다. 게이트웨이를 다시 띄우기 전에 지운다 —
        self._stage("restart")                                            # 재시작 중에 지우면 Hermes 가 게이트웨이를 기다리다 폴더를 남긴다(OKE 2026-10-17 확인)
        try:
            self.restart()
        except Exception as exc:                                          # noqa: BLE001 — 바꾼 내용으로 게이트웨이가 뜨지 않는다. 보관본으로 되돌린다
            return self._restore(temp, "restart_failed", str(exc), secrets=secrets_ran, env_keys=result.get("env_added") or [], result=result)
        self._stage("cleanup")
        have = self.env_names() or set()
        added = set(result.get("env_added") or [])
        result.update({"done_at": _iso(), "secrets_needed": [k for k in summary.get("env_refs") or [] if k not in have and k not in added and k not in CONTAINER_ENV],
                       "paused_cron": int((summary.get("counts") or {}).get("cron") or 0), "pc_path_jobs": summary.get("pc_path_jobs") or [],
                       "os_only_skills": summary.get("os_only_skills") or [], "mcp_relogin": 0,
                       "link_skills": (summary.get("dropped") or {}).get("link_skills") or []})
        result["changed_after_confirm"] = _changed(summary.get("secrets_plan_seen"), result)
        if "channel_files_skipped" in summary:                            # main 이 아닌 대상: 옮기지 않은 채널 연결 파일 수(OMAI-1444 R8)
            result["channels_to_reconnect"] = len(summary.get("channel_files_skipped") or [])
        self._soul_changed(profile, soul_before)
        return self._finish("done", "", "", result)

    def _soul(self, profile: str) -> str | None:
        try:
            return str(self.api.call("GET", f"/api/profiles/{urllib.parse.quote(profile, safe='')}/soul").get("content") or "")
        except Exception:                                                 # noqa: BLE001 — 읽지 못하면 판 기록·알림을 건너뛴다
            return None

    def _soul_changed(self, profile: str, before: str | None) -> None:
        """SOUL 이 바뀌었으면 판 기록에 「고치기 전」·「PC 에서 가져옴」 두 판을 남기고 방에 알린다(OMAI-1444 R10·R12, ROV10).
        오퍼레이터가 파일을 이미 바꿨으므로 save_text 는 쓰지 않는다. 판 저장·알림이 실패해도 가져오기는 done 그대로다(디자인 결정 6A)."""
        if before is None:
            return
        after = self._soul(profile)
        if after is None or after == before:
            return
        from ..assets import files                                        # 판 기록은 화면의 SOUL 저장과 같은 표(files)를 쓴다
        pod, key = self.job["pod"], f"soul:{profile}"
        rev_from = rev_to = None
        try:
            with files.text_lock(pod, key):
                rev_from = files.remember_version(pod, key, before, "", "고치기 전")   # i18n-ignore: DB 에 저장하는 판 메모(UI 가 번역한다)
                if rev_from is None and not files.has_secrets(before, files.kind_of(key)):
                    rev_from = files._last_version(pod, key)              # 마지막 판과 같은 내용이면 그 판이 「고치기 전」이다
                rev_to = files.remember_version(pod, key, after, self.job.get("by_user") or "", SOUL_NOTE)
            if rev_to is None:                                            # 비밀값처럼 보이는 줄이 있거나 같은 내용 — 판 저장 실패와 같은 길(ROV10)
                raise ValueError("not_recorded")
        except Exception as exc:                                          # noqa: BLE001
            rev_from = rev_to = None
            store.log_usage("pc_import_soul_version_failed", f"{self.job['id']} {type(exc).__name__}", pod=pod)
        if self.notice is None:
            return
        try:
            self.notice(rev_from, rev_to)
        except Exception as exc:                                          # noqa: BLE001 — 가져오기는 이미 끝났다. 기록만 남긴다
            store.log_usage("profile_soul_notice_failed", f"{self.job['id']} {profile} {type(exc).__name__}", pod=pod)

    def _env_plan(self, profile: str, summary: dict) -> tuple[dict[str, str], dict]:
        """비밀 묶음의 .env 를 사이드카로 읽고 넣을 키를 고른다. 묶음을 읽지 못하면 모든 키를 확인하지 못함으로 둔다."""
        index = summary.get("secrets_index") or {}
        try:
            blob = self.download(secrets_path(self.job["id"])) if self.download else None
        except Exception:                                                 # noqa: BLE001
            blob = None
        if blob is None:
            return {}, {"add": [], "exists": [], "blocked": [], "unreadable": list(index.get("env_unreadable") or []),
                        "unchecked": list(index.get("env_keys") or [])}
        values, bad = read_env_from(blob)
        try:
            listing = self.api.call("GET", "/api/env", query={"profile": profile})
        except Exception:                                                 # noqa: BLE001 — 이름을 모르면 아무 키도 넣지 않는다(R25)
            listing = None
        return values, plan_env(values, listing, bad)

    def _put_env(self, profile: str, values: dict[str, str], plan: dict) -> dict:
        """넣을 키 이름을 먼저 저장하고(R15, 서버가 도중에 멈춰도 recover 가 지운다) 하나씩 넣는다. 실패한 키는 남기고 진행한다."""
        planned = list(plan["add"])
        _set(self.job["id"], result={"env_planned": planned})
        added, failed = [], []
        for k in planned:
            try:
                self.api.call("PUT", "/api/env", {"key": k, "value": values[k], "profile": profile}, {"profile": profile})
                added.append(k)
            except Exception as exc:                                      # noqa: BLE001 — 이유에는 값이 섞이지 않게 종류만 남긴다
                failed.append({"name": k, "reason": str(getattr(exc, "reason", "") or type(exc).__name__)[:60]})
        skipped = [{"name": k, "reason": why} for why in ("exists", "blocked", "unreadable", "unchecked") for k in plan.get(why) or []]
        return {"env_planned": planned, "env_added": added, "env_failed": failed, "env_skipped": skipped}

    def _bundled_repair(self, profile: str) -> dict:
        """SkillBundledRepair 를 돌려 결과를 result 에 담는다(R11·R12, 재검토 D3). 미지원(옛 CRD·옛 오퍼레이터·SKIPPED)이면
        bundled_repair_unsupported, 그 밖의 실패는 bundled_repair_error. 성공하면 되돌린 수와 이름 목록(보관 폴더의 파일)을 읽고
        자동 주기가 다시 하지 않게 완료 기록을 남긴다."""
        from . import bundled_repair
        try:
            msg = self.task(bundled_repair.KIND, profile, "", self.job["id"])
        except Exception as exc:                                          # noqa: BLE001 — 되돌리기 실패의 피해는 가린 사본이 남는 것뿐이다
            if unsupported(exc) or bundled_repair.skipped(str(exc)):
                return {"bundled_repair_unsupported": True}
            return {"bundled_repair_error": str(exc)[:300]}
        out: dict = {}
        n = bundled_repair.repaired_count(msg)
        if n is not None:
            out["bundled_repaired_n"] = n
            try:
                bundled_repair.done(self.job["pod"], profile, n)
            except Exception:                                             # noqa: BLE001 — 기록을 못 남기면 자동 주기가 한 번 더 볼 뿐이다
                pass
        out.update(read_lists(self.download, self.job["id"], (("bundled_repaired", ".bundled-repaired"), ("bundled_kept", ".bundled-kept")),
                              "bundled_list_unreadable"))
        return out

    def _secret_lists(self) -> dict:
        """오퍼레이터가 남긴 바꾼·더한 파일 목록(OV-6). 읽지 못하면 secrets_list_unreadable."""
        return read_secret_lists(self.download, self.job["id"])

    def _restore(self, temp: str, reason: str, error: str, secrets: bool = False, env_keys=(), result: dict | None = None) -> dict:
        result = dict(result or {})
        profile = self.job["profile"]
        for k in env_keys:                                                # 넣은 키를 먼저 지운다(main 에 없던 키만 넣었다)
            try:
                self.api.call("DELETE", "/api/env", {"key": k, "profile": profile}, {"profile": profile})
            except Exception:                                             # noqa: BLE001
                result.setdefault("env_left", []).append(k)
        try:
            if secrets:
                self.task("ProfileSecretsRestore", profile, "", self.job["id"])
            self.task("ProfileContentRestore", profile, "", self.job["id"])
            try:
                self.restart()
            except Exception:                                             # noqa: BLE001 — 내용은 되돌렸다. 게이트웨이는 다음 점검이 다시 띄운다
                pass
            state = "rolled_back"
            if secrets or env_keys:
                result["secrets_rolled_back"] = True
        except Exception as exc:                                          # noqa: BLE001
            state, error = "rollback_failed", f"{error} / {exc}"
        self._cleanup(temp)
        return self._finish(state, reason, error, result)

    def _cleanup(self, temp: str) -> None:
        """임시 프로파일과 올린 두 묶음을 지운다. 프로파일 삭제는 Hermes 가 게이트웨이를 최대 10초 기다리므로 넉넉히 기다리고 한 번 더 한다.
        두 번 실패해도 결과는 그대로다(남은 임시 프로파일은 이름이 pcimp- 로 시작해 구별된다)."""
        if not getattr(self, "_cleaned", False):
            self._cleaned = True
            for attempt in (1, 2):
                try:
                    self.api.call("DELETE", f"/api/profiles/{temp}", None, timeout=60)
                    break
                except Exception as exc:                                  # noqa: BLE001 — 정리 실패는 결과를 바꾸지 않는다
                    if attempt == 1:
                        threading.Event().wait(3)
                    else:                                                 # 남은 임시 프로파일은 결과에 적어 두고 5분 점검(sweep_temps)이 다시 지운다
                        self._temp_left = temp
                        store.log_usage("pc_import_temp_left", f"{self.job['id']} {type(exc).__name__}: {str(exc)[:200]}", pod=self.job["pod"])
            paths = [upload_path(self.job["id"])]
            if (self.job.get("summary") or {}).get("secrets_bundle"):
                paths.append(secrets_path(self.job["id"]))
            for path in paths:
                try:
                    self.api.call("DELETE", "/api/files", {"path": path, "recursive": False})
                except Exception:                                         # noqa: BLE001
                    pass

    def _finish(self, state: str, reason: str, error: str, result: dict | None = None) -> dict:
        result = dict(result or {})
        if getattr(self, "_temp_left", ""):
            result["temp_left"] = self._temp_left
        _set(self.job["id"], state=state, reason=reason, error=error[:600], result=result)
        self.on_change()
        return get(self.job["id"]) or {}


def unsupported(exc: Exception) -> bool:
    """오퍼레이터가 작업을 파일을 바꾸기 전에 거절했는가(R19·R22): CRD 가 종류를 모름(생성 422), 옛 오퍼레이터의 검증 거절."""
    msg = str(exc)
    return (getattr(exc, "code", 0) == 422 or _word(msg) == "INVALID"
            or "알 수 없는 작업 종류" in msg or "unknown task type" in msg.lower())   # i18n-ignore: 옛 오퍼레이터 메시지(plan.go)와 대조


def read_lists(download, job_id: str, pairs, unreadable: str) -> dict:
    """오퍼레이터가 보관 폴더에 남긴 목록 파일(한 줄에 하나)을 사이드카로 읽는다. 500개까지. 하나라도 못 읽으면 {unreadable: True}."""
    if download is None:
        return {unreadable: True}
    out = {}
    try:
        for key, name in pairs:
            blob = download(f"{backup_path(job_id)}/{name}")
            out[key] = sorted({ln.strip() for ln in (blob or b"").decode("utf-8", "replace").splitlines() if ln.strip()})[:500]
    except Exception:                                                     # noqa: BLE001
        return {unreadable: True}
    return out


def read_secret_lists(download, job_id: str) -> dict:
    return read_lists(download, job_id, (("secrets_replaced", ".secrets-replaced"), ("secrets_added", ".secrets-added")), "secrets_list_unreadable")


def _changed(seen: dict | None, result: dict) -> bool:
    """확인 화면에서 본 계획과 바꾸기 때 결과가 다른가(DD7·OV-2). 본 계획이 없거나 모름이었으면 거짓."""
    if not seen or not seen.get("known"):
        return False
    if "env_planned" in result and sorted(seen.get("env_add") or []) != sorted(result["env_planned"]):
        return True
    if "secrets_replaced" in result and sorted(seen.get("files_replace") or []) != sorted(result["secrets_replaced"]):
        return True
    return bool(result.get("secrets_unsupported")) and seen.get("supported") is True


def _word(message: str) -> str:
    m = re.match(r"^\[([A-Z]+)\]", message or "")
    return m.group(1) if m else ""


def start(job: dict, runner_factory) -> threading.Thread:
    """뒤에서 단계를 돈다. 진행 중에는 1분마다 updated 를 갱신해 다른 복제본의 복구 점검이 손대지 않게 한다."""
    stop = threading.Event()

    def beat():
        while not stop.wait(60):
            _set(job["id"])

    def go():
        hb = threading.Thread(target=beat, daemon=True)
        hb.start()
        try:
            runner_factory(job).run()
        finally:
            stop.set()

    t = threading.Thread(target=go, name=f"pc-import-{job['id']}", daemon=True)
    t.start()
    return t


def stale(now: datetime | None = None) -> list[dict]:
    """진행 중인데 STALE_AFTER 동안 갱신되지 않은 것(서버가 도중에 다시 떴다, R11-3)."""
    cut = _iso((now or _now()) - timedelta(seconds=STALE_AFTER))
    with _conn() as conn:
        return [_row(r) for r in conn.execute("SELECT * FROM pc_imports WHERE state='running' AND updated < ?", (cut,))]


def recover(job: dict, task, restart, cleanup, env_delete=None) -> str:
    """멈춘 가져오기를 닫는다. 바꾸기 단계에 들어갔으면 넣은 비밀값을 지우고 비밀·내용을 보관본으로 되돌린다(§4-5).
    그 전이면 main 은 그대로이므로 실패로 닫는다."""
    stage = job["stage"]
    has_files = bool((job.get("summary") or {}).get("secrets_bundle"))
    if stage in ("replace", "secrets", "env", "restart", "cleanup"):
        for k in (job.get("result") or {}).get("env_planned") or []:     # 어디까지 넣었는지 모르므로 계획한 키를 모두 지운다(main 에 없던 키다)
            try:
                if env_delete:
                    env_delete(k)
            except Exception:                                             # noqa: BLE001
                pass
        try:
            if has_files and stage != "replace":
                task("ProfileSecretsRestore", job["profile"], "", job["id"])
            task("ProfileContentRestore", job["profile"], "", job["id"])
            try:
                restart()
            except Exception:                                             # noqa: BLE001
                pass
            state = "rolled_back"
        except Exception as exc:                                          # noqa: BLE001
            if _word(str(exc)) == "NOBACKUP" and stage == "replace":      # 보관 전에 멈췄다 — main 은 그대로다
                state = "failed"
            else:
                state = "rollback_failed"
    else:
        state = "failed"
    try:
        cleanup(temp_profile(job["id"]), upload_path(job["id"]), *([secrets_path(job["id"])] if has_files else []))
    except Exception:                                                     # noqa: BLE001
        pass
    _set(job["id"], state=state, reason="interrupted", error=tr("서버가 도중에 다시 시작되었습니다", "The server restarted during the import"))
    return state


def temps_left() -> list[dict]:
    """끝났는데 임시 프로파일을 지우지 못한 가져오기. OKE 에서 가져오기 직후 지우면 실패하고 몇 분 뒤에는 되는 것을 보았다(2026-10-17)."""
    with _conn() as conn:
        rows = [_row(r) for r in conn.execute("SELECT * FROM pc_imports WHERE state IN ('done','failed','rolled_back','rollback_failed') "
                                              "AND result LIKE ?", ('%"temp_left"%',))]
    return [r for r in rows if r["result"].get("temp_left")]


def sweep_temps(job: dict, delete) -> bool:
    """남은 임시 프로파일을 다시 지운다. 지웠으면(이미 없으면) 결과에서 표시를 뗀다."""
    temp = job["result"].get("temp_left") or ""
    if not temp.startswith("pcimp-"):
        return False
    try:
        delete(temp)
    except Exception as exc:                                              # noqa: BLE001
        if "404" not in str(exc) and getattr(exc, "code", 0) != 404:
            return False
    result = {k: v for k, v in job["result"].items() if k != "temp_left"}
    _set(job["id"], result=result)
    return True


BACKUPS = "profiles/.aas-import-backup"
PRUNE_EVERY = 24 * 3600                     # 보관 폴더 정리는 하루 한 번(리더의 5분 점검 안에서)


def backup_path(job_id: str) -> str:
    return f"{BACKUPS}/{job_id}"


def backups_due(now: datetime | None = None, days: int | None = None) -> list[dict]:
    """보관 기간이 지나 지울 보관본. 끝난 가져오기(done·rolled_back)만 — 되돌리기 실패(rollback_failed)의 보관본은
    운영자가 손으로 복구할 때 쓰므로 지우지 않는다. 기간이 0 이면 지우지 않는다."""
    days = backup_days() if days is None else days
    if days <= 0:
        return []
    cut = _iso((now or _now()) - timedelta(days=days))
    with _conn() as conn:
        rows = [_row(r) for r in conn.execute("SELECT * FROM pc_imports WHERE state IN ('done','rolled_back') AND updated < ?", (cut,))]
    return [r for r in rows if not r["result"].get("backup_pruned")]


def prune_backup(job: dict, delete) -> bool:
    """보관 폴더를 지우고 결과에 표시한다. 이미 없으면(404) 지운 것으로 본다."""
    try:
        delete(backup_path(job["id"]))
    except Exception as exc:                                              # noqa: BLE001
        if "404" not in str(exc) and getattr(exc, "code", 0) != 404:
            return False
    _set(job["id"], result={**job["result"], "backup_pruned": _iso()})
    return True


# ---- 받은편지함·확인할 것 -----------------------------------------------------------------------------
def inbox_items(me: str, admin: bool, label_of, now: datetime | None = None) -> list[dict]:
    """받은편지함 항목(D11·§10-5). 받는 사람: 관리자가 대행했을 때 주인(끝남), 되돌리기 실패는 주인·관리자, 시작한 사람(끝남·되돌림).
    「확인」하면 그 사람만 지운다. 14일이 지나면 보이지 않는다."""
    me = (me or "").lower()
    if not me:
        return []
    cut = _iso((now or _now()) - timedelta(days=14))
    with _conn() as conn:
        rows = [_row(r) for r in conn.execute("SELECT * FROM pc_imports WHERE state IN ('done','rolled_back','rollback_failed') AND updated >= ? "
                                              "ORDER BY updated", (cut,))]
    out = []
    for r in rows:
        if me in r["acks"]:
            continue
        mine = r["by_user"] == me
        owner = r["owner"] == me
        if r["state"] == "rollback_failed":
            show, kind = mine or owner or admin, "rollback_failed"
        elif r["by_admin"] and owner and not mine:
            show, kind = r["state"] == "done", "by_admin"
        else:
            show, kind = mine, r["state"]
        if not show:
            continue
        item = {"id": f"{PREFIX}{r['id']}", "kind": "pc_import", "status": kind, "pod": r["pod"], "profile": r["profile"],
                "alias": label_of(r["pod"], r["profile"]), "by": r["by_user"], "by_name": _person(r["by_user"]), "text": "",
                "at": datetime.fromisoformat(r["updated"]).timestamp()}
        moved = _moved(r)
        if moved:
            item["secrets"] = moved
        out.append(item)
    return out


def _moved(row: dict) -> dict | None:
    """받은편지함 문장의 n(인증 파일)·m(비밀값)(OV-11). 비밀을 옮기지 않았으면 None."""
    res, summary = row["result"] or {}, row["summary"] or {}
    if row["state"] != "done" or res.get("secrets_unsupported") or not summary.get("secrets_bundle"):
        return None
    if res.get("secrets_list_unreadable"):
        files = len((summary.get("secrets_plan_seen") or {}).get("files_replace") or []) + len((summary.get("secrets_plan_seen") or {}).get("files_new") or [])
    else:
        files = len(res.get("secrets_replaced") or []) + len(res.get("secrets_added") or []) + int(res.get("secrets_replaced_n") or 0) + int(res.get("secrets_added_n") or 0)
    env = len(res.get("env_added") or []) + int(res.get("env_added_n") or 0)
    return {"files": files, "env": env} if files or env else None


def ack(item_id: str, who: str) -> None:
    job_id = item_id[len(PREFIX):]
    row = get(job_id)
    if not row:
        raise ValueError("unknown")
    who = (who or "").lower()
    if who and who not in row["acks"]:
        with _conn() as conn:
            conn.execute("UPDATE pc_imports SET acks=? WHERE id=?", (json.dumps([*row["acks"], who]), job_id))


def pod_of(item_id: str) -> str:
    row = get(item_id[len(PREFIX):])
    return row["pod"] if row else ""


def issues_for(pod: str, profile: str, env_have=None, skills_have=None) -> list[dict]:
    """프로파일 개요 「확인할 것」(D5·D7): 마지막 가져오기의 남은 할 일, 되돌리기 실패.
    env_have·skills_have 는 main 의 지금 비밀값 이름·스킬 이름을 읽는 함수(읽지 못하면 None). 할 일이 끝나면 그만큼 줄인다(R27)."""
    row = latest(pod, profile)
    if not row:
        return []
    if row["state"] == "rollback_failed":
        return [{"level": "bad", "code": "pc_import_rollback_failed", "text": tr(f"PC 에서 가져오기를 되돌리지 못했습니다. {profile} 프로파일이 중간 상태일 수 있습니다",
                                                                              f"Could not roll back the import from a PC. The {profile} profile may be partly changed")}]
    if row["state"] != "done":
        return []
    res = row["result"] or {}
    out = []
    need = set(res.get("secrets_needed") or []) - CONTAINER_ENV            # 고치기 전 기록에도 컨테이너가 주는 이름이 들어 있다
    need |= {f.get("name") for f in res.get("env_failed") or [] if isinstance(f, dict) and f.get("name")}
    need |= {f.get("name") for f in res.get("env_skipped") or [] if isinstance(f, dict) and f.get("reason") in ("unreadable", "unchecked")}
    if need and env_have:
        have = _safe_call(env_have)
        if have is not None:
            need -= set(have)
    if need:
        n = len(need)
        out.append({"level": "warn", "code": "pc_import_secrets", "n": n, "text": tr(f"비밀값 {n}개 필요", f"{n} secrets needed")})
    if res.get("paused_cron"):
        n = int(res["paused_cron"])
        out.append({"level": "warn", "code": "pc_import_cron", "n": n, "text": tr(f"일시정지된 PC 예약 작업 {n}개", f"{n} paused scheduled jobs from your PC")})
    if res.get("os_only_skills"):
        n = len(res["os_only_skills"])
        out.append({"level": "warn", "code": "pc_import_skills", "n": n, "text": tr(f"컨테이너에서 읽히지 않는 스킬 {n}개", f"{n} skills that cannot load in the container")})
    links = set(res.get("link_skills") or [])
    if links and skills_have:
        have = _safe_call(skills_have)
        if have is not None:
            links -= set(have)
    if links:
        n = len(links)
        out.append({"level": "warn", "code": "pc_import_link_skills", "n": n, "text": tr(f"따로 넣어야 할 스킬 {n}개", f"{n} skills to add separately")})
    if res.get("secrets_unsupported"):
        out.append({"level": "warn", "code": "pc_import_secrets_skipped", "text": tr("비밀값·인증 파일을 옮기지 못했습니다", "Secrets and credential files were not moved")})
    return out


def _safe_call(fn):
    try:
        return fn()
    except Exception:                                                     # noqa: BLE001 — 읽지 못하면 줄이지 않는다
        return None


# ---- 내보내기 ----------------------------------------------------------------------------------------
def record_export(job_id: str, pod: str, profile: str, by_user: str, size: int) -> None:
    with _conn() as conn:
        conn.execute("INSERT INTO pc_exports (id, pod, profile, by_user, size, created) VALUES (?,?,?,?,?,?)",
                     (job_id, pod, profile, (by_user or "").lower(), int(size), _iso()))


def get_export(job_id: str) -> dict | None:
    if not _ID.match(job_id or ""):
        return None
    with _conn() as conn:
        r = conn.execute("SELECT * FROM pc_exports WHERE id=?", (job_id,)).fetchone()
    return dict(r) if r else None


def mark_downloaded(job_id: str) -> None:
    with _conn() as conn:
        conn.execute("UPDATE pc_exports SET downloaded=? WHERE id=?", (_iso(), job_id))


def valid_id(job_id: str) -> bool:
    return bool(_ID.match(job_id or ""))


def skill_names_of(rows, profile: str) -> set[str]:
    """hermes_reader.skill_files 의 (프로파일, SKILL.md 경로) 에서 그 프로파일의 스킬 이름(폴더 이름)."""
    return {posixpath.basename(posixpath.dirname(str(path))) for prof, path in rows or [] if prof == profile}


def env_names_of(env_listing) -> set[str]:
    """Hermes /api/env 응답에서 값이 들어 있는 이름. 모양을 모르면 빈 집합."""
    names: set[str] = set()
    items = env_listing.get("vars", env_listing) if isinstance(env_listing, dict) else env_listing
    if isinstance(items, dict):
        items = [{"key": k, **(v if isinstance(v, dict) else {"is_set": bool(v)})} for k, v in items.items()]
    for it in items if isinstance(items, list) else []:
        if isinstance(it, dict) and (it.get("is_set") or it.get("set") or it.get("has_value")):
            k = str(it.get("key") or it.get("name") or "")
            if k:
                names.add(k)
    return names


def safe_name(name: str) -> str:
    return posixpath.basename(str(name or "")).strip()[:200] or "hermes.tar.gz"
