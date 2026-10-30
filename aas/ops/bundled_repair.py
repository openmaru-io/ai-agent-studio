# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""내보내기 때 가려진 기본 스킬 되돌리기(HermesTask SkillBundledRepair, 스펙 2026-10-27-011 R9~R13).

Hermes 의 프로파일 내보내기는 스킬 파일까지 비밀값 모양 글자를 가린다. PC 가져오기로 들어온 기본 스킬이 그래서
「기본(바뀜)」이 된다. 오퍼레이터 작업이 「서버 기본 판을 같은 규칙으로 가린 결과」와 바이트 단위로 같은 사본만 되돌린다.
이 모듈은 AAS 쪽 기록(meta 표 `bundled_repair:<pod>:<profile>`)과 자동 주기의 한 걸음을 맡는다.

기록: {"state": "pending"|"retry"|"done", "task": 작업 이름, "attempt": 시도 번호, "n": 되돌린 수, "at": ISO 시각}.
완료(done)는 작업이 Succeeded 로 끝난 뒤에만 남긴다(D7). Failed·미지원·SKIPPED 는 남기지 않고 다음 주기에 다시 본다(재검토 D3).
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timedelta, timezone

from ..common import store

KIND = "SkillBundledRepair"
PREFIX = "bundled_repair:"
PROFILE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,40}$")   # CRD 의 profile 패턴(hermestask_types.go) — 밖이면 생성이 422 로 거절된다
SHOW_DAYS = 7                                             # 안내 띠는 7일 안의 기록만 보인다. 기록 자체는 지우지 않는다(재검토, R13 과 충돌하지 않게)
_REPAIRED = re.compile(r"\[REPAIRED\]\s*(\d+)")


def _key(pod: str, profile: str) -> str:
    return f"{PREFIX}{pod}:{profile}"


def get(pod: str, profile: str) -> dict | None:
    with store.connect() as conn:
        row = conn.execute("SELECT value FROM meta WHERE key=?", (_key(pod, profile),)).fetchone()
    if not row:
        return None
    try:
        rec = json.loads(row["value"])
    except ValueError:
        return None
    return rec if isinstance(rec, dict) else None


def put(pod: str, profile: str, rec: dict) -> None:
    with store.connect() as conn:
        conn.execute("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value=excluded.value",
                     (_key(pod, profile), json.dumps(rec, ensure_ascii=False)))


def move_profile(pod: str, old: str, new: str) -> None:
    """프로파일 이름을 바꾸면 기록이 새 이름을 따라간다(pc_import.move_profile 과 같이 부른다)."""
    rec = get(pod, old)
    with store.connect() as conn:
        conn.execute("DELETE FROM meta WHERE key=?", (_key(pod, old),))
    if rec is not None:
        put(pod, new, rec)


def detach_profile(pod: str, name: str) -> None:
    """프로파일을 지우면 기록도 지운다 — 같은 이름으로 새로 만든 프로파일이 「이미 되돌림」으로 보이지 않게."""
    with store.connect() as conn:
        conn.execute("DELETE FROM meta WHERE key=?", (_key(pod, name),))


def repaired_count(message: str) -> int | None:
    """오퍼레이터 성공 메시지 `[REPAIRED] n` 의 n. 모양이 다르면 None."""
    m = _REPAIRED.search(message or "")
    return int(m.group(1)) if m else None


def skipped(text: str) -> bool:
    """이 Hermes 버전에서는 되돌릴 수 없어 아무것도 지우지 않고 끝났다(오퍼레이터 `[SKIPPED]`)."""
    return "[SKIPPED]" in (text or "")


def done(pod: str, profile: str, n: int, now: datetime | None = None) -> None:
    put(pod, profile, {"state": "done", "n": int(n), "at": (now or datetime.now(timezone.utc)).isoformat(timespec="seconds")})


def recent(pod: str, now: datetime | None = None, days: int = SHOW_DAYS) -> list[dict]:
    """「스킬」 화면의 안내 띠(D14): 이 POD 에서 SHOW_DAYS 안에 하나 이상 되돌린 기록 [{profile, n, at}], 프로파일 이름 순."""
    now = now or datetime.now(timezone.utc)
    out = []
    with store.connect() as conn:
        rows = conn.execute("SELECT key, value FROM meta WHERE key LIKE ?", (f"{PREFIX}{pod}:%",)).fetchall()
    for r in rows:
        if not str(r["key"]).startswith(f"{PREFIX}{pod}:"):             # LIKE 의 _ 는 아무 글자와 맞는다 — 다른 POD 를 거른다
            continue
        try:
            rec = json.loads(r["value"])
            at = datetime.fromisoformat(str(rec.get("at") or ""))
        except (ValueError, TypeError, AttributeError):
            continue
        if rec.get("state") != "done" or int(rec.get("n") or 0) <= 0:
            continue
        if at.tzinfo is None:
            at = at.replace(tzinfo=timezone.utc)
        if now - at > timedelta(days=days):
            continue
        out.append({"profile": str(r["key"])[len(f"{PREFIX}{pod}:"):], "n": int(rec["n"]), "at": rec["at"]})
    return sorted(out, key=lambda x: x["profile"])


def task_name(pod: str, profile: str, attempt: int) -> str:
    """POD·프로파일·시도 번호로 정한 이름 — 서버 복제본 둘이 같은 주기에 요청해도 같은 작업 하나가 된다(409)."""
    return "bundledrepair-" + hashlib.sha1(f"{pod}|{profile}|{attempt}".encode()).hexdigest()[:12]


def task_body(pod: str, profile: str, attempt: int, namespace: str, group: str, version: str) -> dict:
    return {"apiVersion": f"{group}/{version}", "kind": "HermesTask",
            "metadata": {"name": task_name(pod, profile, attempt), "namespace": namespace, "labels": {"aas.openmaru.io/agent": pod}},
            "spec": {"agent": pod, "profile": profile, "type": KIND, "requestedBy": "aas"}}


def candidates(profiles: list[str], modified: set[str], imported: set[str]) -> list[str]:
    """되돌리기를 요청할 프로파일(R13): 기본 스킬 목록이 있는 이름 있는 프로파일 가운데, 출처 「기본(바뀜)」 줄이 있거나
    PC 가져오기를 마친 것. CRD 이름 규칙에 맞지 않으면 뺀다(그대로 보내면 422 를 미지원으로 읽고 주기마다 다시 보낸다)."""
    return [p for p in profiles if p != "default" and PROFILE_RE.match(p) and (p in modified or p in imported)]


def step(client, pod: str, profile: str, namespace: str, group: str, version: str, unsupported, now: datetime | None = None) -> tuple[str, int]:
    """한 프로파일의 한 걸음. 돌려주는 값 (상태, 되돌린 수): done(이번에 끝남)·pending·retry·skip(이미 끝남)·unsupported.
    작업을 기다리지 않는다 — 요청만 하고 다음 주기에 결과를 읽는다. unsupported(exc) 는 pc_import.unsupported."""
    from ..fleet import k8s
    rec = get(pod, profile) or {}
    if rec.get("state") == "done":
        return "skip", 0
    attempt = int(rec.get("attempt") or 0)
    if rec.get("state") == "pending" and rec.get("task"):
        try:
            status = (client.get_task(rec["task"]) or {}).get("status") or {}
        except k8s.K8sError as exc:
            if exc.code != 404:
                return "pending", 0
            status = {"phase": "Failed", "message": "[GONE]"}         # 지워졌다(24시간 뒤 정리) — 결과를 모르니 다시 한다
        phase, msg = status.get("phase"), str(status.get("message") or "")
        if phase == "Succeeded":
            n = repaired_count(msg) or 0
            done(pod, profile, n, now)
            return "done", n
        if phase == "Failed":
            put(pod, profile, {"state": "retry", "attempt": attempt + 1})
            return ("unsupported" if skipped(msg) or "알 수 없는 작업 종류" in msg or "unknown task type" in msg.lower() else "retry"), 0   # i18n-ignore: 옛 오퍼레이터 메시지(plan.go)와 대조
        return "pending", 0
    name = task_name(pod, profile, attempt)
    try:
        client.create_task(task_body(pod, profile, attempt, namespace, group, version))
    except k8s.K8sError as exc:
        if exc.code != 409:                                            # 409 = 다른 복제본이 같은 이름으로 이미 요청했다 — 그 작업을 기다린다
            if unsupported(exc):
                return "unsupported", 0                                # 옛 CRD — 기록하지 않고 다음 주기에 다시 본다
            raise
    put(pod, profile, {"state": "pending", "task": name, "attempt": attempt})
    return "pending", 0
