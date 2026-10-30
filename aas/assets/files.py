# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Hermes 의 스킬·스크립트 파일 보기. 허용한 폴더의 글 파일만, 비밀값 모양은 가려서 내보낸다."""
from __future__ import annotations

import hashlib
import re
import threading
from datetime import datetime
from pathlib import Path

from ..common.i18n import tr

TEXT_EXT = {".md", ".py", ".sh", ".js", ".ts", ".json", ".yaml", ".yml", ".txt", ".toml", ".sql", ".html", ".css", ".tmpl", ".j2"}
MAX_BYTES = 400_000
MASK = "«가림»"  # i18n-ignore: 화면에 나가는 가림 표지이자 저장 거절을 판단하는 값

# 코드를 읽을 수 있게, "값처럼 생긴 것"만 가린다(변수 이름이나 os.environ 읽기는 그대로 둔다).
_MASKS = [
    (re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{16,}"), lambda m: f"{m.group(1)} {MASK}"),
    (re.compile(r"(?i)((?:token|secret|password|passwd|api[_-]?key|apikey|private[_-]?key)\w*[\"']?\s*[=:]\s*[\"'])([^\"'\s${}<>]{12,})([\"'])"),
     lambda m: f"{m.group(1)}{MASK}{m.group(3)}"),
    (re.compile(r"\b\d{6,}:[A-Za-z0-9_-]{30,}\b"), lambda m: MASK),                      # 텔레그램 봇 토큰 모양
    (re.compile(r"\b(?:sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{16,}\b"), lambda m: MASK),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b"), lambda m: MASK),   # JWT
    (re.compile(r"([\"'])[A-Za-z0-9+/_-]{48,}={0,2}([\"'])"), lambda m: f"{m.group(1)}{MASK}{m.group(2)}"),
    (re.compile(r"(https?://)[^/\s:@\"']+:[^@\s\"']+@"), lambda m: f"{m.group(1)}{MASK}@"),  # 주소에 박힌 계정
    (re.compile(r"(https?://hooks\.[\w.-]+/(?:services|triggers|workflows)/)[^\s\"'`)>]+"), lambda m: f"{m.group(1)}{MASK}"),   # 웹훅 주소는 그 자체가 비밀
    (re.compile(r"(?i)([?&](?:key|token|secret|sig|signature|access_token|api_key|apikey|password)=)[^\s&\"'`)>]{6,}"), lambda m: f"{m.group(1)}{MASK}"),
    (re.compile(r"(https?://[^\s\"'`)>]*?/)[A-Za-z0-9_]{24,}(?=[/?\s\"'`)>]|$)"), lambda m: f"{m.group(1)}{MASK}"),           # 주소 속 긴 불투명 조각(하이픈으로 이은 읽히는 이름은 둔다)
]


# 작업 지침(AGENTS.md)은 링크가 많아 「주소 속 긴 불투명 조각」 규칙(마지막 줄)을 빼고 가린다. 토큰·키·JWT·주소 속 계정·웹훅·키 쿼리는 그대로(스펙 2026-10-19-004 O7·§10 H4)
_MASKS_AGENTS = _MASKS[:-1]


def kind_of(key: str) -> str:
    """버전 키(soul:…·agents:… 등)에서 가림 규칙의 종류를 고른다. agents 만 다르다."""
    return "agents" if key.startswith("agents:") else ""


def mask_line(line: str, kind: str = "") -> str:
    for pat, repl in (_MASKS_AGENTS if kind == "agents" else _MASKS):
        line = pat.sub(repl, line)
    return line


class FileError(Exception):
    """reason: 화면이 종류를 가리는 코드(문장은 언어마다 달라진다), field: 거절된 칸의 이름(그 칸 아래에 문구를 보인다, 스펙 2026-10-15-011 TD3)."""

    def __init__(self, message: str, code: int = 400, reason: str = "", field: str = ""):
        super().__init__(message)
        self.code = code
        self.reason = reason
        self.field = field


def allowed(rel: str) -> bool:
    """skills/…, scripts/…, profiles/<이름>/skills/… , profiles/<이름>/scripts/… 만."""
    parts = Path(rel).parts
    if not parts or rel.startswith("/") or any(p in ("..", "") or p.startswith(".") for p in parts):
        return False
    if parts[0] in ("skills", "scripts"):
        return len(parts) > 1
    return len(parts) > 3 and parts[0] == "profiles" and parts[2] in ("skills", "scripts")


def resolve(home: Path, rel: str) -> Path:
    if "\x00" in rel or not allowed(rel):
        raise FileError(tr("볼 수 없는 위치입니다", "This location cannot be viewed"), 403)
    target = (home / rel).resolve()
    if home.resolve() not in target.parents:                       # 심링크로 폴더 밖을 가리키는 경우
        raise FileError(tr("볼 수 없는 위치입니다", "This location cannot be viewed"), 403)
    if target.suffix.lower() not in TEXT_EXT:
        raise FileError(tr("글 파일만 볼 수 있습니다", "Only text files can be viewed"), 415)
    if not target.is_file():
        raise FileError(tr("없는 파일입니다", "File not found"), 404)
    return target


def read(home: Path, rel: str) -> dict:
    target = resolve(home, rel)
    size = target.stat().st_size
    if size > MAX_BYTES:
        raise FileError(tr(f"파일이 너무 큽니다 ({size // 1024}KB)", f"The file is too large ({size // 1024} KB)"), 413)
    raw = target.read_bytes()
    lines = raw.decode("utf-8", errors="replace").splitlines()
    masked = [mask_line(ln) for ln in lines]
    return {"path": rel, "name": target.name, "size": size, "lines": masked,
            "masked_lines": [i for i, (a, b) in enumerate(zip(lines, masked), 1) if a != b],
            "sha": hashlib.sha256(raw.decode("utf-8", errors="replace").encode("utf-8")).hexdigest(),
            "modified": datetime.fromtimestamp(target.stat().st_mtime).astimezone().isoformat(timespec="seconds")}


def siblings(home: Path, rel: str) -> list[str]:
    """스킬 폴더 안의 다른 글 파일(코드 보기에서 옆 파일로 넘어가려고)."""
    home = home.resolve()
    target = resolve(home, rel)
    # 하위 폴더 파일(templates/x.html 등)을 열어도 스킬 폴더 전체를 보인다. 그 파일의 폴더만 보면 목록이 하나뿐이라
    # 화면의 파일 고르기 칸이 사라져 SKILL.md 로 돌아갈 수 없었다(2026-10-17-020). SKILL.md 가 있는 가장 가까운 위 폴더가 스킬 폴더다
    root = target.parent
    for d in [target.parent, *target.parent.parents]:
        if d == home or home not in d.parents:
            break
        if (d / "SKILL.md").is_file():
            root = d
            break
    out = []
    for p in sorted(root.rglob("*")):
        if len(out) >= 60:
            break
        if p.is_file() and p.suffix.lower() in TEXT_EXT and not any(x.startswith(".") for x in p.relative_to(root).parts):
            out.append(str(p.relative_to(home)))
    return out


# ---- 스킬 문서 고치기 ----------------------------------------------------------
# AAS 는 Hermes 의 파일을 직접 쓰지 않는다. SKILL.md 만, Hermes 의 스킬 API 로 보낸다(Hermes 가 검사하고 저장).
# 스크립트는 보기만 된다. 고치기 전·후 내용은 AAS 쪽 DB 에 남겨 비교하고 되돌린다.
import difflib

from ..common import store

VERSION_SCHEMA = ("CREATE TABLE IF NOT EXISTS file_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, pod TEXT NOT NULL, path TEXT NOT NULL, "
                  "sha TEXT NOT NULL, content TEXT NOT NULL, saved_at TEXT NOT NULL, by TEXT, note TEXT)")
# 판 조회는 거의 모두 pod·path 로 거르고 id 순으로 읽는다 — 인덱스가 없어 본문이 든 표 전체를 읽었다(스펙 2026-10-24-006 R1)
VERSION_INDEX = "CREATE INDEX IF NOT EXISTS file_versions_pod_path ON file_versions (pod, path, id)"
MAX_VERSIONS = 40
MAX_AGENT_VERSIONS = 20      # Hermes 가 대화로 고친 판은 따로 센다 — 사람이 저장한 판이 밀려나지 않게(스펙 2026-10-14-015 R12)
AGENT_BY = "hermes:"
# 「확인함」 기록(스펙 2026-10-19-004 §10 D17). 판 id 에 딸린 행이라 판을 지울 때 함께 지운다. id 열이 없어 dbmigrate 의 IDENTITY_TABLES 에는 넣지 않는다
ACK_SCHEMA = ("CREATE TABLE IF NOT EXISTS file_acks (pod TEXT NOT NULL, path TEXT NOT NULL, version_id INTEGER NOT NULL, "
              "by TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (pod, path, version_id))")
DELETED_SHA = "deleted"      # 「Hermes 가 지움」 판의 sha 자리 표시. 실제 내용의 sha 와 겹치지 않아 파일이 다시 생기면 새 판으로 남는다(D19)
SECRET_NOTE = "비밀값이 있어 기록하지 않음"  # i18n-ignore: DB 에 저장하는 판 메모(UI 가 번역한다)

_locks: dict[str, threading.RLock] = {}
_locks_guard = threading.Lock()


def text_lock(pod: str, key: str) -> threading.RLock:
    """같은 글의 저장과 「Hermes 가 고침」 버전 기록이 엇갈리지 않게 하는 잠금(§10 H1). 한 서버 프로세스 안에서만 듣는다."""
    with _locks_guard:
        return _locks.setdefault(f"{key}@{pod}", threading.RLock())


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _raw(home: Path, rel: str) -> str:
    target = resolve(home, rel)
    if target.stat().st_size > MAX_BYTES:
        raise FileError(tr("파일이 너무 커서 여기서 고칠 수 없습니다", "The file is too large to edit here"), 413)
    return target.read_bytes().decode("utf-8", errors="replace")


def editable(rel: str) -> bool:
    return Path(rel).name == "SKILL.md"


def has_secrets(text: str, kind: str = "") -> bool:
    return any(mask_line(ln, kind) != ln for ln in text.splitlines())


def check(rel: str, content: str) -> None:
    """Hermes 에 보내기 전에 걸러 낼 것. 문제가 있으면 FileError(422). 나머지 검사는 Hermes 가 한다."""
    if not editable(rel):
        raise FileError(tr("여기서는 스킬 문서(SKILL.md)만 고칠 수 있습니다", "Only skill documents (SKILL.md) can be edited here"), 403)
    if "\x00" in content:
        raise FileError(tr("글이 아닌 내용이 섞여 있습니다", "The content includes non-text data"), 422)
    if len(content.encode("utf-8")) > MAX_BYTES:
        raise FileError(tr("내용이 너무 깁니다", "The content is too long"), 413)
    if MASK in content:
        raise FileError(tr("가려진 값(«가림»)이 들어 있어 저장할 수 없습니다", f"Cannot save: the content includes a masked value ({MASK})"), 422)
    if not content.lstrip().startswith("---"):
        raise FileError(tr("SKILL.md 는 --- 로 시작하는 머리말(name, description)이 있어야 합니다",
                                "SKILL.md must start with a --- header that has name and description"), 422)


def _remember(pod: str, rel: str, content: str, by: str, note: str) -> int | None:
    """버전을 남기고 그 버전 id 를 돌려준다. 마지막 버전과 내용이 같으면 남기지 않고 None."""
    with store.connect() as conn:
        ensure_schema(conn)
        last = conn.execute("SELECT sha FROM file_versions WHERE pod=? AND path=? ORDER BY id DESC LIMIT 1", (pod, rel)).fetchone()
        if last and last["sha"] == _sha(content):
            return None
        vid = conn.execute("INSERT INTO file_versions (pod, path, sha, content, saved_at, by, note) VALUES (?,?,?,?,?,?,?) RETURNING id",
                           (pod, rel, _sha(content), content, datetime.now().astimezone().isoformat(timespec="seconds"), by, note)).fetchone()[0]
        _prune(conn, pod, rel)
    return int(vid)


def remember_version(pod: str, key: str, content: str, by: str, note: str) -> int | None:
    """글 하나를 버전으로 남긴다(MCP 설정 지도처럼 Hermes 에 따로 쓰는 것을 되돌릴 수 있게). 비밀값처럼 보이는 줄이 있으면 남기지 않고 None."""
    if has_secrets(content, kind_of(key)):
        return None
    return _remember(pod, key, content, by, note)


def ensure_schema(conn) -> None:
    """버전 기록 표와 인덱스. 표는 처음 쓰는 곳에서 만들어지므로 쓰는 곳마다 부른다(PostgreSQL 은 한 번만 보낸다)."""
    conn.execute(VERSION_SCHEMA)
    conn.execute(VERSION_INDEX)


def _prune(conn, pod: str, rel: str) -> None:
    """사람이 저장한 버전은 40개, Hermes 가 고친 버전(by 가 hermes: 로 시작)은 따로 20개까지만 둔다."""
    for agent, limit in ((False, MAX_VERSIONS), (True, MAX_AGENT_VERSIONS)):
        cond = "by LIKE ?" if agent else "(by IS NULL OR by NOT LIKE ?)"
        conn.execute(f"DELETE FROM file_versions WHERE pod=? AND path=? AND {cond} AND id NOT IN "
                     f"(SELECT id FROM file_versions WHERE pod=? AND path=? AND {cond} ORDER BY id DESC LIMIT ?)",
                     (pod, rel, AGENT_BY + "%", pod, rel, AGENT_BY + "%", limit))
    conn.execute(ACK_SCHEMA)                                     # 새 DB 에서도 지우기가 깨지지 않게 먼저 만든다(§10 M2)
    conn.execute("DELETE FROM file_acks WHERE pod=? AND path=? AND version_id NOT IN (SELECT id FROM file_versions WHERE pod=? AND path=?)",
                 (pod, rel, pod, rel))


def record_agent_edit(pod: str, rel: str, profile: str, content: str, sha: str) -> str:
    """Hermes 가 대화로 고친 SKILL.md 를 「Hermes 가 고침」 판으로 남긴다. 마지막 판과 같으면 남기지 않는다.
    비밀값처럼 보이는 줄이 있으면 내용은 저장하지 않고 그 사실만 남긴다(AAS DB 에 키가 남지 않게, R12).
    반환: 'recorded' | 'secret' | 'same' | 'first'(처음 보는 스킬이라 지금 내용을 기준 판으로만 남김)"""
    by = AGENT_BY + profile
    with store.connect() as conn:
        ensure_schema(conn)
        last = conn.execute("SELECT sha FROM file_versions WHERE pod=? AND path=? ORDER BY id DESC LIMIT 1", (pod, rel)).fetchone()
        if last and last["sha"] == sha:
            return "same"
        secret = has_secrets(content, kind_of(rel))
        first = last is None
        conn.execute("INSERT INTO file_versions (pod, path, sha, content, saved_at, by, note) VALUES (?,?,?,?,?,?,?)",
                     (pod, rel, sha, "" if secret else content, datetime.now().astimezone().isoformat(timespec="seconds"),
                      "" if first else by, SECRET_NOTE if secret else ("처음 본 버전" if first else "Hermes 가 고침")))  # i18n-ignore: DB 에 저장하는 판 메모(UI 가 번역한다)
        _prune(conn, pod, rel)
    return "secret" if secret else ("first" if first else "recorded")


def save(home: Path, pod: str, rel: str, content: str, base_sha: str, by: str, send, note: str = "") -> dict:
    """send(rel, 지금 내용, 새 내용) 이 Hermes 에 저장을 요청한다. AAS 는 파일을 직접 쓰지 않는다."""
    current = _raw(home, rel)
    if has_secrets(current):
        raise FileError(tr("비밀값으로 보이는 줄이 있는 파일은 여기서 고칠 수 없습니다. AI 에이전트 작업공간 쪽에서 직접 고치세요.",
                                "A file with lines that look like secrets cannot be edited here. Edit it on the AI Agent Workspace side."), 403)
    if _sha(current) != base_sha:
        raise FileError(tr("그사이 파일이 바뀌었습니다. 다시 열어서 고쳐 주세요.", "The file changed in the meantime. Reopen it and edit again."), 409)
    content = content.replace("\r\n", "\n")
    if current.endswith("\n") and not content.endswith("\n"):      # 편집창은 끝의 줄바꿈을 떼고 보여 준다 — 원래대로 붙인다
        content += "\n"
    if content == current:
        raise FileError(tr("바뀐 내용이 없습니다", "Nothing has changed"), 400)
    check(rel, content)
    _remember(pod, rel, current, "", "고치기 전")  # i18n-ignore: DB 에 저장하는 판 메모(UI 가 번역한다)
    send(rel, current, content)
    after = _raw(home, rel)
    if after == current:
        raise FileError(tr("Hermes 가 저장했다고 답했지만 파일이 그대로입니다. 다시 저장해 보고, 계속되면 관리자에게 알려 주세요.",
                                "Hermes reported success, but the file is unchanged. Save again, and if it keeps happening, tell your administrator."), 502)
    _remember(pod, rel, after, by, note or "저장")  # i18n-ignore: DB 에 저장하는 판 메모
    return {**read(home, rel), "saved": True, "exact": after.rstrip("\n") == content.rstrip("\n")}


def latest_shas(pod: str) -> dict[str, str]:
    """이 POD 의 스킬 문서(…/SKILL.md)마다 마지막 버전의 sha. 버전 기록 수집이 바뀐 것만 읽으려고 쓴다."""
    with store.connect() as conn:
        ensure_schema(conn)
        rows = conn.execute("SELECT path, sha FROM file_versions WHERE pod=? AND path LIKE ? AND id IN "
                            "(SELECT MAX(id) FROM file_versions WHERE pod=? AND path LIKE ? GROUP BY path)", (pod, "%/SKILL.md", pod, "%/SKILL.md")).fetchall()
    return {r["path"]: r["sha"] for r in rows}


def versions(pod: str, rel: str) -> list[dict]:
    with store.connect() as conn:
        ensure_schema(conn)
        rows = conn.execute("SELECT id, sha, saved_at, by, note, length(content) AS size FROM file_versions WHERE pod=? AND path=? ORDER BY id DESC",
                            (pod, rel)).fetchall()
    from ..office import office                                   # 판을 저장한 사람을 이름으로(by_name, 2026-10-30). hermes:* 는 그대로
    known = office.people()
    out = [{**dict(r), "by_name": office.person_name(r["by"] or "", known)} for r in rows]
    if kind_of(rel) == "agents":                                   # 작업 지침: 지움 판·내용을 남기지 않은 판을 화면이 가린다(§10 D19·H4)
        for r in out:
            r["deleted"], r["withheld"] = r["sha"] == DELETED_SHA, _withheld(r)
    return out


def version_content(pod: str, rel: str, vid: int) -> str:
    with store.connect() as conn:
        ensure_schema(conn)
        row = conn.execute("SELECT content FROM file_versions WHERE pod=? AND path=? AND id=?", (pod, rel, vid)).fetchone()
    if not row:
        raise FileError(tr("없는 버전입니다", "Version not found"), 404)
    return row["content"]


def diff(home: Path, pod: str, rel: str, vid: int | None = None, proposed: str | None = None) -> dict:
    """vid 가 있으면 그 버전 → 지금, proposed 가 있으면 지금 → 저장하려는 내용."""
    return diff_text(pod, rel, _raw(home, rel), vid, proposed)


def diff_text(pod: str, rel: str, current: str, vid: int | None = None, proposed: str | None = None) -> dict:
    """파일이 아닌 글(SOUL 등)에도 같은 버전 관리를 쓴다 — rel 은 버전을 묶는 이름일 뿐이다."""
    old, new = (usable_content(pod, rel, vid), current) if vid is not None else (current, (proposed or "").replace("\r\n", "\n"))
    lines = [mask_line(ln, kind_of(rel)) for ln in difflib.unified_diff(old.splitlines(), new.splitlines(), tr("이전", "Before"), tr("지금", "Current") if vid is not None else tr("저장할 내용", "To save"), lineterm="", n=2)]
    return {"lines": lines[:3000], "added": sum(1 for ln in lines[2:] if ln.startswith("+")),
            "removed": sum(1 for ln in lines[2:] if ln.startswith("-")), "same": old == new}


class SavedText(str):
    """저장된 내용. 글 그대로 쓰되 남긴 버전 id(before·version)를 함께 든다 — 방 알림이 버전 범위를 적는다(OMAI-1126 재검토 M3)."""
    before: int | None = None
    version: int | None = None


def save_text(pod: str, key: str, current: str, content: str, base_sha: str, by: str, send, reread, note: str = "",
              remember_before: bool = True) -> SavedText:
    """파일이 아닌 글(SOUL)의 저장. send(새 내용) 이 Hermes 에 보내고 reread() 가 저장된 내용을 다시 읽는다. 저장된 내용을 돌려준다.
    remember_before: 고치기 전 내용을 판으로 남길지. 아직 없는 파일(AGENTS.md)을 처음 만들 때는 빈 판을 남기지 않는다.
    같은 글의 「Hermes 가 고침」 판 기록과 엇갈리지 않게 text_lock 을 잡는다(§10 H1)."""
    with text_lock(pod, key):
        return _save_text(pod, key, current, content, base_sha, by, send, reread, note, remember_before)


def _save_text(pod: str, key: str, current: str, content: str, base_sha: str, by: str, send, reread, note: str, remember_before: bool) -> SavedText:
    if has_secrets(current, kind_of(key)):
        raise FileError(tr("비밀값으로 보이는 줄이 있어 여기서는 고칠 수 없습니다. AI 에이전트 작업공간 쪽에서 직접 고치세요.",
                                "Lines that look like secrets prevent editing here. Edit it on the AI Agent Workspace side."), 403)
    if _sha(current) != base_sha:
        raise FileError(tr("그사이 내용이 바뀌었습니다. 다시 열어서 고쳐 주세요.", "The content changed in the meantime. Reopen it and edit again."), 409)
    content = content.replace("\r\n", "\n")
    if current.endswith("\n") and not content.endswith("\n"):
        content += "\n"
    if content == current:
        raise FileError(tr("바뀐 내용이 없습니다", "Nothing has changed"), 400)
    if "\x00" in content or len(content.encode("utf-8")) > MAX_BYTES:
        raise FileError(tr("저장할 수 없는 내용입니다", "This content cannot be saved"), 422)
    if MASK in content:
        raise FileError(tr("가려진 값(«가림»)이 들어 있어 저장할 수 없습니다", f"Cannot save: the content includes a masked value ({MASK})"), 422)
    before = _remember(pod, key, current, "", "고치기 전") if remember_before else None  # i18n-ignore: DB 에 저장하는 판 메모(UI 가 번역한다)
    send(content)
    after = reread()
    if after == current:
        raise FileError(tr("Hermes 가 저장했다고 답했지만 내용이 그대로입니다. 다시 저장해 보고, 계속되면 관리자에게 알려 주세요.",
                                "Hermes reported success, but the content is unchanged. Save again, and if it keeps happening, tell your administrator."), 502)
    out = SavedText(after)
    out.before = before if before is not None else _last_version(pod, key)
    out.version = _remember(pod, key, after, by, note or "저장")  # i18n-ignore: DB 에 저장하는 판 메모
    return out


def _last_version(pod: str, key: str) -> int | None:
    with store.connect() as conn:
        ensure_schema(conn)
        row = conn.execute("SELECT MAX(id) FROM file_versions WHERE pod=? AND path=?", (pod, key)).fetchone()
    return int(row[0]) if row and row[0] is not None else None


def text_sha(text: str) -> str:
    return _sha(text)


# ---- 작업 지침(AGENTS.md)의 판: 사람 판·지움 판·확인함(스펙 2026-10-19-004 §9 D7·D8, §10) ----------------------
def is_human(by: str | None) -> bool:
    """사람이 저장한 버전(§10 M1): by 가 비어 있지 않고 hermes: 로 시작하지 않는다(인증 꺼짐의 local 포함). 처음 본 버전·고치기 전 버전(by="")은 아니다."""
    return bool(by) and not str(by).startswith(AGENT_BY)


def _withheld(row) -> bool:
    """비밀값 때문에 내용을 남기지 않은 버전. 내용은 비었는데 sha 는 빈 글의 것이 아니다."""
    size = row["size"] if "size" in row.keys() else len(row["content"])
    return not size and row["sha"] not in (_sha(""), DELETED_SHA)


def usable_content(pod: str, key: str, vid: int) -> str:
    """버전 내용. 작업 지침에서 비밀값 때문에 내용을 남기지 않은 버전은 비교·되돌리기에 쓰지 않는다(§10 H4). 다른 글은 version_content 와 같다."""
    if kind_of(key) != "agents":
        return version_content(pod, key, vid)
    with store.connect() as conn:
        ensure_schema(conn)
        row = conn.execute("SELECT sha, content FROM file_versions WHERE pod=? AND path=? AND id=?", (pod, key, vid)).fetchone()
    if not row:
        raise FileError(tr("없는 버전입니다", "Version not found"), 404)
    if _withheld(row):
        raise FileError(tr("비밀값이 있어 내용을 남기지 않은 버전이라 비교하거나 되돌릴 수 없습니다",
                           "This version was stored without its content because it had secrets, so it cannot be compared or restored"), 422, reason="withheld")
    return row["content"]


def revert_content(pod: str, key: str, vid: int) -> str:
    """되돌릴 내용. 「Hermes 가 지움」 버전이면 그 앞의 마지막 사람 버전으로 파일을 다시 만든다(§10 D19)."""
    with store.connect() as conn:
        ensure_schema(conn)
        row = conn.execute("SELECT sha FROM file_versions WHERE pod=? AND path=? AND id=?", (pod, key, vid)).fetchone()
        if row and row["sha"] == DELETED_SHA:
            for r in conn.execute("SELECT id, sha, by, length(content) AS size FROM file_versions WHERE pod=? AND path=? AND id<? ORDER BY id DESC",
                                  (pod, key, vid)).fetchall():
                if is_human(r["by"]) and r["sha"] != DELETED_SHA and not _withheld(r):
                    return usable_content(pod, key, int(r["id"]))
            raise FileError(tr("되돌릴 사람 저장 버전이 없습니다", "There is no version saved by a person to restore"), 422, reason="no_human_version")
    return usable_content(pod, key, vid)


def record_agent_delete(pod: str, key: str, profile: str) -> str:
    """판이 있던 파일이 없어졌다 — 내용 없는 「Hermes 가 지움」 판을 남긴다(§10 D19). 판이 하나도 없으면 아무것도 남기지 않는다(H2).
    반환: 'recorded' | 'same'(이미 지움 판) | 'none'(판 없음)"""
    with store.connect() as conn:
        ensure_schema(conn)
        last = conn.execute("SELECT sha FROM file_versions WHERE pod=? AND path=? ORDER BY id DESC LIMIT 1", (pod, key)).fetchone()
        if not last:
            return "none"
        if last["sha"] == DELETED_SHA:
            return "same"
        conn.execute("INSERT INTO file_versions (pod, path, sha, content, saved_at, by, note) VALUES (?,?,?,?,?,?,?)",
                     (pod, key, DELETED_SHA, "", datetime.now().astimezone().isoformat(timespec="seconds"), AGENT_BY + profile, "Hermes 가 지움"))  # i18n-ignore: DB 에 저장하는 판 메모(UI 가 번역한다)
        _prune(conn, pod, key)
    return "recorded"


def agent_state(pod: str, key: str, exists: bool) -> dict:
    """작업 지침 탭의 에이전트 변경·출처 모름 배너에 쓰는 값(§9 D7·D8, §10 D20·M3).
    agent_change: 마지막 판이 hermes:* 이고 아무도 「확인함」을 누르지 않았을 때만. compare_id 는 마지막 사람 판(없으면 처음 본 판),
    revert_id 는 마지막 사람 판(없으면 None — 되돌리기를 끈다). never_saved: 파일이 있는데 사람 저장 판이 하나도 없다."""
    with store.connect() as conn:
        ensure_schema(conn)
        conn.execute(ACK_SCHEMA)
        rows = conn.execute("SELECT id, sha, by, saved_at, length(content) AS size FROM file_versions WHERE pod=? AND path=? ORDER BY id DESC",
                            (pod, key)).fetchall()
        last = rows[0] if rows else None
        agent_last = bool(last) and str(last["by"] or "").startswith(AGENT_BY)
        acked = agent_last and conn.execute("SELECT 1 FROM file_acks WHERE pod=? AND path=? AND version_id=?", (pod, key, last["id"])).fetchone() is not None
    usable = [r for r in rows if r["sha"] != DELETED_SHA and not _withheld(r)]
    human = next((r for r in usable if is_human(r["by"])), None)
    first_seen = next((r for r in reversed(usable) if not r["by"]), None)
    change = None
    if agent_last and not acked:
        base = human or first_seen
        change = {"id": int(last["id"]), "at": last["saved_at"], "deleted": last["sha"] == DELETED_SHA,
                  "compare_id": int(base["id"]) if base else None, "revert_id": int(human["id"]) if human else None}
    return {"versions": len(rows), "agent_change": change, "never_saved": bool(exists) and not any(is_human(r["by"]) for r in rows)}


def ack(pod: str, key: str, vid: int, by: str) -> None:
    """「확인함」(§9 D7, §10 D17·H3). vid 가 지금 마지막 버전이고 그 버전이 hermes:* 여야 한다. 파일은 건드리지 않는다."""
    with text_lock(pod, key), store.connect() as conn:
        ensure_schema(conn)
        conn.execute(ACK_SCHEMA)
        last = conn.execute("SELECT id, by FROM file_versions WHERE pod=? AND path=? ORDER BY id DESC LIMIT 1", (pod, key)).fetchone()
        if not last or int(last["id"]) != vid or not str(last["by"] or "").startswith(AGENT_BY):
            raise FileError(tr("그사이 버전이 바뀌었습니다. 다시 열어 확인해 주세요.", "The versions changed in the meantime. Reopen and check again."), 409, reason="stale_version")
        conn.execute("INSERT INTO file_acks (pod, path, version_id, by, at) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING",
                     (pod, key, vid, by, datetime.now().astimezone().isoformat(timespec="seconds")))


def move_key(pod: str, old: str, new: str) -> None:
    """프로파일 이름을 바꿀 때 버전과 확인 기록을 새 이름으로 옮긴다(§10 M1). 새 이름에 남아 있던 옛 기록(지운 같은 이름의 프로파일)은 버린다."""
    with store.connect() as conn:
        ensure_schema(conn)
        conn.execute(ACK_SCHEMA)
        for table in ("file_acks", "file_versions"):
            conn.execute(f"DELETE FROM {table} WHERE pod=? AND path=?", (pod, new))
            conn.execute(f"UPDATE {table} SET path=? WHERE pod=? AND path=?", (new, pod, old))


def forget_key(pod: str, key: str) -> None:
    """지운 프로파일의 버전과 확인 기록. 같은 이름으로 다시 만든 프로파일이 옛 버전과 비교되어 「에이전트가 고침」으로 보이지 않게 한다."""
    with store.connect() as conn:
        ensure_schema(conn)
        conn.execute(ACK_SCHEMA)
        conn.execute("DELETE FROM file_acks WHERE pod=? AND path=?", (pod, key))
        conn.execute("DELETE FROM file_versions WHERE pod=? AND path=?", (pod, key))


# ---- 판 다루기(이름 붙이기·두 판 비교·한 판 보기)와 AAS 쪽에만 있는 글(작업 메모) -------------------------
KEY = re.compile(r"^(soul|config|agents|jobnote|jobprompt):[A-Za-z0-9_./-]{1,160}$")


def valid_key(key: str) -> bool:
    if ".." in key or "//" in key:
        return False
    return bool(KEY.match(key)) or (allowed(key) and Path(key).suffix.lower() in TEXT_EXT)


def label_version(pod: str, key: str, vid: int, note: str) -> None:
    with store.connect() as conn:
        ensure_schema(conn)
        if not conn.execute("UPDATE file_versions SET note=? WHERE pod=? AND path=? AND id=?", (note[:200], pod, key, vid)).rowcount:
            raise FileError(tr("없는 버전입니다", "Version not found"), 404)


def version_view(pod: str, key: str, vid: int) -> dict:
    text = usable_content(pod, key, vid)
    return {"id": vid, "lines": [mask_line(ln, kind_of(key)) for ln in text.splitlines()], "sha": _sha(text)}


def diff_versions(pod: str, key: str, a: int, b: int) -> dict:
    old, new = usable_content(pod, key, a), usable_content(pod, key, b)
    lines = [mask_line(ln, kind_of(key)) for ln in difflib.unified_diff(old.splitlines(), new.splitlines(), tr(f"버전 {a}", f"Version {a}"), tr(f"버전 {b}", f"Version {b}"), lineterm="", n=2)]
    return {"lines": lines[:3000], "added": sum(1 for ln in lines[2:] if ln.startswith("+")),
            "removed": sum(1 for ln in lines[2:] if ln.startswith("-")), "same": old == new}


def note_get(pod: str, key: str) -> dict:
    """AAS 쪽에만 있는 글(작업 메모): 가장 최근 버전이 곧 지금 내용이다."""
    vs = versions(pod, key)
    text = version_content(pod, key, vs[0]["id"]) if vs else ""
    return {"lines": text.splitlines(), "sha": _sha(text), "versions": len(vs), "masked_lines": []}


def note_save(pod: str, key: str, content: str, base_sha: str, by: str, note: str = "") -> dict:
    current = "\n".join(note_get(pod, key)["lines"])
    vs = versions(pod, key)
    current = version_content(pod, key, vs[0]["id"]) if vs else ""
    if _sha(current) != base_sha:
        raise FileError(tr("그사이 내용이 바뀌었습니다. 다시 열어서 고쳐 주세요.", "The content changed in the meantime. Reopen it and edit again."), 409)
    content = content.replace("\r\n", "\n")
    if len(content.encode("utf-8")) > 60_000:
        raise FileError(tr("메모가 너무 깁니다", "The note is too long"), 413)
    if has_secrets(content):
        raise FileError(tr("비밀값으로 보이는 내용은 메모에 적을 수 없습니다", "Content that looks like a secret cannot go in a note"), 422)
    if content == current:
        raise FileError(tr("바뀐 내용이 없습니다", "Nothing has changed"), 400)
    _remember(pod, key, content, by, note or "저장")  # i18n-ignore: DB 에 저장하는 판 메모
    return note_get(pod, key)


def notes_index(pod: str, prefix: str) -> dict[str, str]:
    """prefix 로 시작하는 글들의 지금 내용(가장 최근 버전). 목록에서 메모를 보여 주고 찾을 때 쓴다."""
    with store.connect() as conn:
        ensure_schema(conn)
        rows = conn.execute("SELECT path, content FROM file_versions WHERE pod=? AND path LIKE ? AND id IN "
                            "(SELECT MAX(id) FROM file_versions WHERE pod=? GROUP BY path)", (pod, prefix + "%", pod)).fetchall()
    return {r["path"]: r["content"] for r in rows if r["content"].strip()}
