# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Hermes 를 지우기 전에 남기는 내보내기 묶음(tar.gz). 설정·크론·스킬·기억·성격만 담는다.

.env·auth.json·state.db(대화 이력)·토큰은 허용 목록에 없어 들어가지 않는다. 설정 파일 안의 키·토큰 값은 가린다.
묶음은 AAS 데이터 폴더의 exports/ 에 둔다(주인이 요청하면 관리자가 꺼내 준다).
"""
from __future__ import annotations

import io
import re
import tarfile
import time
from pathlib import Path

from ..common import store

PATTERNS = ("config.yaml", "SOUL.md", "cron/jobs.json", "memories/**/*", "skills/**/*.md",
            "profiles/*/config.yaml", "profiles/*/SOUL.md", "profiles/*/cron/jobs.json", "profiles/*/memories/**/*", "profiles/*/skills/**/*.md")
SECRET_LINE = re.compile(r"(?im)^(\s*[\w.-]*(?:api[_-]?key|token|secret|password)[\w.-]*\s*:\s*)(?!\$\{)(\S.*)$")
MAX_FILES = 2000


def _mask(rel: str, data: bytes) -> bytes:
    if not rel.endswith((".yaml", ".yml")):
        return data
    return SECRET_LINE.sub(r"\1***", data.decode("utf-8", "replace")).encode()


def bundle(home, name: str) -> Path | None:
    """home(Path 또는 RemotePath)에서 허용 목록 파일을 모아 묶음을 만든다. 읽을 수 있는 파일이 하나도 없으면 None."""
    files: dict[str, bytes] = {}
    for pattern in PATTERNS:
        try:
            for p in home.glob(pattern):
                rel = p.relative_to(home).as_posix()
                if rel in files or len(files) >= MAX_FILES or not p.is_file():
                    continue
                try:
                    files[rel] = _mask(rel, p.read_bytes())
                except OSError:
                    continue                     # 너무 크거나 읽지 못한 파일은 건너뛴다
        except OSError:
            continue
    if not files:
        return None
    out_dir = store.data_dir() / "exports"
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{name}-{time.strftime('%Y%m%d-%H%M%S')}.tar.gz"
    with tarfile.open(path, "w:gz") as tar:
        for rel, data in sorted(files.items()):
            info = tarfile.TarInfo(rel)
            info.size, info.mtime, info.mode = len(data), int(time.time()), 0o600
            tar.addfile(info, io.BytesIO(data))
    path.chmod(0o600)
    return path
