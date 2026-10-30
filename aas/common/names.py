# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""사람 표시 이름 규칙 하나(2026-10-18). 사용자 목록·로그인 세션·오피스가 같은 이름을 쓴다."""
from __future__ import annotations

import re


def person_name(first: str, last: str, username: str = "") -> str:
    """성+이름(한글이면 붙여 쓰고, 로마자가 섞이면 띄운다). 둘 다 없으면 아이디."""
    first, last = (first or "").strip(), (last or "").strip()
    sep = " " if re.search(r"[A-Za-z]", first + last) else ""
    return f"{last}{sep}{first}".strip() or username
