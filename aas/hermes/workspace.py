# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""대화 작업 폴더(/opt/data/workspace) — 에이전트 POD 하나의 업로드·결과 파일(OMAI-1153, 스펙 2026-10-14-005).

읽기는 사이드카(scan·check·download, 1.4.0)로, 쓰기는 Hermes 대시보드 파일 API 로 한다. 내려받기·지우기의 안전 검사는
실제 파일을 여는 사이드카가 한다(심링크·하드링크로 대화 DB 가 나가거나 지워지지 않게, R1·R8). 여기서는 경로가
workspace/ 아래인지와 업로드 한도(R15)를 본다.
"""
from __future__ import annotations

import datetime as _dt
import posixpath
import re
import threading
import time
import unicodedata

from ..common import config

WORKSPACE = "workspace"
WORKSPACE_ABS = "/opt/data/workspace"
UPLOADS = "workspace/uploads"
# 턴 전후 비교·목록·용량 합계에서 들어가지 않는 폴더(R10). aas-shared·aas-shared-out 은 회의 공유 볼륨의 마운트 지점이다(스펙 2026-10-15 meeting-file-sharing §4-9)
SKIP_DIRS = [".git", "node_modules", ".venv", "__pycache__", "aas-shared", "aas-shared-out"]
SHARED_IN_POD = "/opt/data/workspace/uploads/aas-shared"          # 회의에서 올린 파일(에이전트 읽기 전용)
SHARED_OUT_POD = "/opt/data/workspace/uploads/aas-shared-out"     # 에이전트가 나눌 결과를 쓰는 폴더
SHARED_MARKER = ".aas-shared"                                     # 서버가 공유 폴더 루트에 직접 쓰는 표지 파일 — 마운트된 설치본만 이것을 본다
MAX_FILE = 100 * 1024 * 1024                                   # Hermes upload-stream 과 같은 한 파일 상한(D8)
MAX_FILES_PER_MESSAGE = 10                                     # D7
CHIP_LIMIT = 20                                                # 한 턴의 결과 칩(R5)
_KST = _dt.timezone(_dt.timedelta(hours=9))
_BAD = re.compile(r"[\x00-\x1f\x7f/\\]")


def quota() -> int:
    """에이전트별 workspace 업로드 한도(R15). nfs-client 는 PVC 크기를 강제하지 않아 AAS 가 지킨다."""
    raw = str(config.get("AAS_WORKSPACE_QUOTA") or "").strip()
    try:
        return int(raw) if raw and int(raw) > 0 else 2 * 1024 ** 3
    except ValueError:
        return 2 * 1024 ** 3


def clean_name(name: str) -> str:
    """경로 구분자·제어 문자를 지우고 200바이트로 자른다(확장자는 남긴다). 비면 upload.
    자모가 풀린(NFD) 이름은 완성형(NFC)으로 바꾼다 — macOS 는 한글 파일 이름을 NFD 로 주는데, 모델은 경로를 NFC 로 쓰므로
    그대로 저장하면 에이전트가 자기가 입력한 경로로 파일을 열지 못한다(OMAI-1153)."""
    name = _BAD.sub("", unicodedata.normalize("NFC", str(name or ""))).strip().strip(".") or "upload"
    raw = name.encode("utf-8")
    if len(raw) <= 200:
        return name
    stem, ext = posixpath.splitext(name)
    keep = 200 - len(ext.encode("utf-8"))
    return stem.encode("utf-8")[:max(keep, 1)].decode("utf-8", "ignore") + ext


def in_workspace(path: str) -> bool:
    """workspace/ 아래의 상대 경로인가(글자 검사). 실제 파일 검사는 사이드카가 한다."""
    if not isinstance(path, str) or not path or path.startswith("/") or "\x00" in path:
        return False
    parts = path.split("/")
    return parts[0] == WORKSPACE and len(parts) > 1 and not any(p in ("", ".", "..") for p in parts)


def in_uploads(path: str) -> bool:
    return in_workspace(path) and path.startswith(UPLOADS + "/")


SHARED_DIRS = (f"{UPLOADS}/aas-shared", f"{UPLOADS}/aas-shared-out")     # 회의 공유 볼륨(작업 폴더 기준 상대 경로)


def own_upload(path: str) -> bool:
    """주인이 채팅에서 올린 파일인가: uploads/ 아래이면서 회의 공유 폴더가 아닌 곳(스펙 2026-10-20-002 F10).
    in_uploads 는 공유 폴더도 참이라 따로 둔다. 첨부 안내 문구(올렸습니다/골랐습니다)·고른 파일 크기 상한·오피스 받기 거절이 같은 규칙을 쓴다."""
    return in_uploads(path) and not any(path == d or path.startswith(d + "/") for d in SHARED_DIRS)


def today_dir() -> str:
    return f"{UPLOADS}/{_dt.datetime.now(_KST).strftime('%Y-%m-%d')}"


PLANS = f"{WORKSPACE}/.hermes/plans"      # Hermes /plan 이 계획을 쓰는 곳(작업 폴더 기준 .hermes/plans/, 스펙 2026-10-26-010 12-7)
# 화면의 「계획 파일 열기」가 같은 경로를 펼친다(ui/src/screens/chat/files.tsx PLANS_DIR, 스펙 2026-10-27-012). 바꾸면 두 곳을 함께 고친다


def _hidden(path: str) -> bool:
    """점 파일과 Hermes 업로드 임시 파일(*.upload)은 목록·칩에 보이지 않는다.
    /plan 이 쓴 계획(.hermes/plans/ 아래)만 보인다 — 숨기면 「계획 파일 열기」로 서랍을 열어도 계획이 없었다(OKE 2026-10-27).
    그 안에서도 점 이름은 숨긴다. .hermes 의 다른 파일(상태 등)은 그대로 숨긴다."""
    if path.endswith(".upload"):
        return True
    if path in (PLANS, PLANS.rsplit("/", 1)[0]):
        return False                           # 폴더 줄 둘(.hermes·.hermes/plans) — 아래에 계획이 있을 때만 서랍에 남는다
    rest = path[len(PLANS) + 1:] if path.startswith(PLANS + "/") else "/".join(path.split("/")[1:])
    return any(p.startswith(".") for p in rest.split("/"))


hidden = _hidden          # 첨부 검사·오피스 받기가 쓰는 이름(목록에서 숨기는 파일은 붙이거나 받을 수도 없다, 스펙 2026-10-20-002 F3)


def can_delete_dir(path: str) -> bool:
    """화면에서 통째로 지워도 되는 폴더(스펙 2026-10-28-002 §4-1). 올린 파일 루트·회의 공유 볼륨(마운트)·Hermes 상태 폴더·숨은 경로는 막는다.
    작업 폴더 루트는 in_workspace 가 이미 막는다. .hermes/plans 는 서랍에 보이므로 지울 수 있다."""
    if not in_workspace(path) or path == UPLOADS or path == f"{WORKSPACE}/.hermes":
        return False
    if any(path == d or path.startswith(d + "/") for d in SHARED_DIRS):
        return False
    return not _hidden(path)


class Workspace:
    """POD 하나의 작업 폴더. backend 는 사이드카(RemoteBackend), api 는 Hermes 대시보드(HermesAPI)."""

    def __init__(self, backend, api):
        self.backend = backend
        self.api = api
        self._reserved = 0                         # 이 서버 파드에서 진행 중인 업로드 크기(R15 예약분)
        self._lock = threading.Lock()

    # ---- 확인 -------------------------------------------------------------------------------
    def supported(self) -> bool:
        return self.backend.has_file_ops()

    def check(self, path: str) -> dict:
        return self.backend.check(path)

    def used(self) -> int | None:
        """workspace 일반 파일 합계(심링크 제외). 목록이 잘리거나 조회에 실패하면 None(모름)."""
        try:
            out = self.backend.scan(WORKSPACE, SKIP_DIRS)
        except (OSError, ValueError):
            return None
        return None if out.get("truncated") else int(out.get("total") or 0)

    def reserve(self, size: int) -> tuple[bool, int | None]:
        """업로드 한도를 넘지 않으면 size 를 예약한다(같은 파드의 동시 업로드가 같은 옛 합계를 보지 않게).
        합계를 모르면 막지 않는다(R15 「조회 실패 때 진행」). (허용, 지금 합계)."""
        used = self.used()
        with self._lock:
            if used is not None and used + self._reserved + size > quota():
                return False, used
            self._reserved += size
        return True, used

    def release(self, size: int) -> None:
        with self._lock:
            self._reserved = max(0, self._reserved - size)

    def pick_name(self, folder: str, name: str) -> str:
        """folder 안에서 비어 있는 이름(이름, 이름-2, 이름-3 …, R9)."""
        stem, ext = posixpath.splitext(name)
        for i in range(1, 100):
            cand = name if i == 1 else f"{stem}-{i}{ext}"
            if not self.backend.check(f"{folder}/{cand}").get("exists"):
                return cand
        return f"{stem}-{int(time.time())}{ext}"

    # ---- 쓰기(Hermes) -------------------------------------------------------------------------
    def ensure(self, folder: str = WORKSPACE) -> bool:
        """폴더를 만든다(있으면 그대로). 실패하면 False — 부른 쪽이 cwd 없이 진행한다(R4)."""
        try:
            self.api.call("POST", "/api/files/mkdir", {"path": folder})
            return True
        except Exception:
            return False

    def delete(self, path: str, recursive: bool = False) -> None:
        """recursive 면 폴더를 통째로 지운다(Hermes shutil.rmtree). 지워도 되는 폴더인지는 부르는 쪽이 can_delete_dir 로 먼저 본다."""
        self.api.call("DELETE", "/api/files", {"path": path, "recursive": recursive})

    # ---- 목록 ---------------------------------------------------------------------------------
    def listing(self) -> dict:
        """「파일」 서랍(D10): 들어가지 않는 폴더는 항목만, 심링크·하드링크는 받을 수 없다고 표시.
        회의 공유 폴더 둘(SHARED_DIRS)은 따로 읽어 파일 줄에 shared·room 을 붙이고 합계를 shared_used 로 준다(스펙 2026-10-20-002 R10).
        공유 볼륨은 에이전트 한도(quota) 밖 저장소라 used 에 넣지 않는다. 마운트 지점 폴더 줄 둘은 공유 줄이 대신하므로 뺀다.
        아래에 보이는 파일이 하나도 없는 폴더 줄도 뺀다(빈 폴더만 줄줄이 보이던 문제, 2026-10-20). 목록이 잘렸으면 빈 폴더인지 몰라 둔다."""
        out = self.backend.scan(WORKSPACE, SKIP_DIRS)
        entries = [e for e in (_entry(e) for e in out.get("entries", []) if not _hidden(e["path"]) and e["path"] not in SHARED_DIRS) if e]
        if not out.get("truncated"):
            parents = {p.rsplit("/", i)[0] for e in entries if e["kind"] == "file" for p in [e["path"]] for i in range(1, p.count("/") + 1)}
            entries = [e for e in entries if e["kind"] != "dir" or e["path"] in parents]
        shared, shared_used, shared_truncated = self._shared()
        return {"entries": entries + shared, "truncated": bool(out.get("truncated")), "used": self.used(), "quota": quota(),
                "shared_used": shared_used, "shared_truncated": shared_truncated}

    def _shared(self) -> tuple[list[dict], int | None, bool]:
        """(공유 파일 줄, 합계, 잘림). 폴더가 없으면 빈 목록과 0, 읽지 못하거나 잘리면 합계는 None(모름)."""
        rows, total, truncated = [], 0, False
        for folder in SHARED_DIRS:
            try:
                out = self.backend.scan(folder, SKIP_DIRS)
            except (OSError, ValueError):
                total = None
                continue
            truncated = truncated or bool(out.get("truncated"))
            for e in out.get("entries", []):
                row = _entry(e) if e["type"] != "dir" and not _hidden(e["path"]) else None
                if row:
                    room = e["path"].split("/")[3:4]                # workspace/uploads/<공유 폴더>/<방>/…
                    rows.append({**row, "shared": True, **({"room": int(room[0])} if room and room[0].isdigit() else {})})
                    if total is not None and e["type"] == "file":   # 합계는 보이는 줄로 낸다(표지 파일 .aas-shared 는 빠진다)
                        total += int(e.get("size") or 0)
        return rows, (None if truncated else total), truncated

    # ---- 턴 전후 비교(R10) -----------------------------------------------------------------------
    def snapshot(self) -> dict | None:
        """{경로: (크기, mtime, nlink)} — uploads·점 파일·심링크 제외. 잘리면 {"__truncated__": …}. 실패면 None."""
        try:
            out = self.backend.scan(WORKSPACE, SKIP_DIRS)
        except (OSError, ValueError):
            return None
        snap = {e["path"]: (e["size"], e["mtime"], int(e.get("nlink") or 1)) for e in out.get("entries", [])
                if e["type"] == "file" and not e["path"].startswith(UPLOADS + "/") and not _hidden(e["path"])}
        if out.get("truncated"):
            snap["__truncated__"] = (0, 0, 0)
        return snap


def _entry(e: dict) -> dict | None:
    """사이드카 scan 항목 하나를 서랍 줄로. 일반 파일·심링크·폴더 밖의 종류는 None."""
    if e["type"] == "link":
        return {**_view(e), "kind": "file", "downloadable": False, "reason": "link"}
    if e["type"] == "file":
        ok = int(e.get("nlink") or 1) == 1
        return {**_view(e), "kind": "file", "downloadable": ok, "reason": "" if ok else "hardlink"}
    if e["type"] == "dir":
        return {**_view(e), "kind": "dir", "downloadable": False, "reason": "dir"}
    return None


def _view(e: dict) -> dict:
    return {"path": e["path"], "name": e["path"].rsplit("/", 1)[-1], "size": e.get("size", 0), "mtime": e.get("mtime", 0)}


def diff(before: dict | None, after: dict | None) -> dict | None:
    """이번 턴에 새로 생기거나 크기·mtime 이 바뀐 파일(R10). 서버가 정렬하고 자른다(재검토 O-6):
    새 파일 먼저·바뀐 파일 나중, 각 묶음 안에서 크기 큰 순, CHIP_LIMIT 개. 시계는 비교하지 않는다."""
    if before is None or after is None:
        return None
    if "__truncated__" in before or "__truncated__" in after:
        return {"files": [], "total": 0, "truncated": True}
    found = []
    for path, (size, mtime, nlink) in after.items():
        old = before.get(path)
        if old is None:
            status = "new"
        elif (old[0], old[1]) != (size, mtime):
            status = "modified"
        else:
            continue
        ok = nlink == 1
        found.append({"path": path, "name": path.rsplit("/", 1)[-1], "size": size, "status": status,
                      "downloadable": ok, "reason": "" if ok else "hardlink"})
    found.sort(key=lambda f: (f["status"] != "new", -f["size"], f["path"]))
    return {"files": found[:CHIP_LIMIT], "total": len(found), "truncated": False}

