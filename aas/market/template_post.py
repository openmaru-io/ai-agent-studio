# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""템플릿 설치 뒤 단계(스펙 2026-11-18-002 §4-2 5, 3단계): Hermes 가 프로파일을 만든 뒤 리더가 한다.

  (a) config 에 받는 사람 모델이 있는지 확인(합치기는 stage 가 이미 했다) — 실패는 다시 해도 같아 retryable 아님
  (b) AGENTS.md 쓰기        (c) 참고 파일을 같은 판으로 다시 받아 작업 폴더에 쓰기
  (d) 허브 스킬을 적힌 판으로 하나씩(install_companion)   (e) KEY 를 기다리는 MCP 가 꺼져 있는지 확인   (f) 예약 작업은 꺼진 채(확인만)

색인  data/market/post/<요청 id>.json — 배달기의 대기 줄과 따로 둔다(market_dispatch.tick 은 대기 줄만 본다, E11). 리더가 주기마다 한 줄씩 다룬다.
결과  설치 기록(done 줄)의 post 칸 {단계: {state, retryable, tries, error_id, reason}}. 모든 단계는 다시 해도 같은 결과다(덮어쓰기·이미 있으면 건너뜀).
      실패한 단계만 3번까지 다시 하고, 그 뒤에는 「확인할 것」에 남겨 사람이 「다시 하기」를 누른다. 되돌리기(프로파일 지우기)는 하지 않는다.
"""
from __future__ import annotations

import json
import secrets
import time

from ..common import store
from ..common.redact import redact
from . import marketplace

STEPS = ("a", "b", "c", "d", "e", "f")
UPDATE_STEPS = ("m", "d")             # 새 판으로 올렸을 때: (m) MCP 더함·바뀜 합치기, (d) 새 허브 스킬. AGENTS·참고 파일은 사용자가 고쳤을 수 있어 덮지 않는다


def steps_of(row: dict) -> tuple:
    return UPDATE_STEPS if row.get("mode") == "update" else STEPS
MAX_TRIES = 3
RETRY_GAP = 30.0                      # 실패한 단계를 다시 하기까지 쉬는 초


class StepError(Exception):
    def __init__(self, reason: str, retryable: bool = True):
        super().__init__(reason)
        self.retryable = retryable


def _dir():
    d = store.data_dir() / "market" / "post"
    d.mkdir(parents=True, exist_ok=True)
    return d


def enqueue(row: dict) -> None:
    """템플릿 설치가 done 으로 끝났다 — 색인 줄을 만든다(이미 있으면 그대로)."""
    if not row.get("template") or row.get("status") != "done":
        return
    path = _dir() / f"{row['id']}.json"
    if path.exists():
        return
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({"id": row["id"], "pod": row.get("pod"), "profile": row.get("profile"), "next": 0.0}, ensure_ascii=False), encoding="utf-8")
    tmp.rename(path)


def entries() -> list[dict]:
    out = []
    for p in sorted(_dir().glob("*.json")):
        try:
            row = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(row, dict) and row.get("id"):
            out.append(row)
    return out


def _done_row(rid: str) -> dict | None:
    return marketplace._read(marketplace._dir("done") / f"{rid}.json")


def _save_done(row: dict) -> None:
    d = marketplace._dir("done")
    tmp = d / f"{row['id']}.tmp"
    tmp.write_text(json.dumps(row, ensure_ascii=False), encoding="utf-8")
    tmp.rename(d / f"{row['id']}.json")


def _drop(rid: str) -> None:
    (_dir() / f"{rid}.json").unlink(missing_ok=True)


def run_one(entry: dict, ops: dict, now: float | None = None) -> dict | None:
    """색인 줄 하나를 한 걸음 나아가게 한다. ops = {단계: 함수(설치 줄) → 사유 없음 또는 짧은 결과 문장}. 갱신한 post 칸(없으면 None)."""
    now = time.time() if now is None else now
    if float(entry.get("next") or 0) > now:
        return None
    row = _done_row(entry["id"])
    if row is None:
        _drop(entry["id"])
        return None
    post = dict(row.get("post") or {})
    left = False
    for step in steps_of(row):
        cur = dict(post.get(step) or {})
        if cur.get("state") == "ok" or (cur.get("state") == "failed" and (not cur.get("retryable") or int(cur.get("tries") or 0) >= MAX_TRIES)):
            continue
        fn = ops.get(step)
        try:
            note = fn(row) if fn else ""
            cur = {"state": "ok", **({"note": str(note)[:300]} if note else {})}
        except StepError as exc:
            cur = {"state": "failed", "retryable": exc.retryable, "tries": int(cur.get("tries") or 0) + 1,
                   "error_id": cur.get("error_id") or "e-" + secrets.token_hex(2), "reason": redact(str(exc), 300)}
        except Exception as exc:                                       # noqa: BLE001 — 예상하지 못한 실패: error_id 를 로그와 함께 남긴다
            cur = {"state": "failed", "retryable": True, "tries": int(cur.get("tries") or 0) + 1,
                   "error_id": cur.get("error_id") or "e-" + secrets.token_hex(2), "reason": type(exc).__name__}
            print(f"템플릿 설치 뒤 단계 실패 {entry['id']} {step} {cur['error_id']}: {redact(str(exc), 200)}", flush=True)   # i18n-ignore: 로그
        post[step] = cur
        if cur["state"] == "failed" and cur.get("retryable") and cur["tries"] < MAX_TRIES:
            left = True
    row["post"] = post
    _save_done(row)
    if left:
        entry["next"] = now + RETRY_GAP
        tmp = _dir() / f"{entry['id']}.tmp"
        tmp.write_text(json.dumps(entry, ensure_ascii=False), encoding="utf-8")
        tmp.rename(_dir() / f"{entry['id']}.json")
    else:
        _drop(entry["id"])                                              # 다 끝났거나 사람의 「다시 하기」를 기다린다
    return post


def retry(rid: str) -> bool:
    """「다시 하기」: 실패한 단계의 tries 를 비우고 색인 줄을 다시 세운다. retryable 이 아닌 (a) 도 사람이 고친 뒤 다시 할 수 있다."""
    row = _done_row(rid)
    if not row or not row.get("template"):
        return False
    post = {k: ({**v, "tries": 0, "retryable": True} if v.get("state") == "failed" else v) for k, v in (row.get("post") or {}).items()}
    row["post"] = post
    _save_done(row)
    _drop(rid)
    enqueue(row)
    return True


def cycle(ops_for, limit: int = 1) -> list[str]:
    """리더가 주기마다 부른다. ops_for(설치 줄) → 단계 함수 표(그 작업공간의 Hermes 에 닿는 것). 다룬 요청 id 들."""
    done = []
    for entry in entries():
        if len(done) >= limit:
            break
        row = _done_row(entry["id"])
        if row is None:
            _drop(entry["id"])
            continue
        try:
            ops = ops_for(row)
        except Exception as exc:                                       # noqa: BLE001 — 작업공간이 없어졌거나 닿지 않는다: 다음 주기에
            print(f"템플릿 설치 뒤 단계 준비 실패 {entry['id']}: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
            continue
        try:
            if run_one(entry, ops) is not None:
                done.append(entry["id"])
        finally:
            close = ops.get("close")
            if close:
                close()
    return done


def issues(pod_id: str, profile: str, installed_rows: list[dict]) -> list[dict]:
    """「확인할 것」: 끝내 실패한 설치 뒤 단계(다시 하기 단추가 붙는다)."""
    from ..common.i18n import tr
    rec = next((r for r in installed_rows if r["profile"] == profile and r.get("template")), None)
    if not rec:
        return []
    row = _done_row(str(rec.get("id") or "")) if rec.get("id") else None
    post = (row or rec).get("post") or {}
    bad = {k: v for k, v in post.items() if v.get("state") == "failed" and (not v.get("retryable") or int(v.get("tries") or 0) >= MAX_TRIES)}
    if not bad:
        return []
    names = {"a": tr("모델 설정", "model setting"), "b": tr("작업 지침", "work instructions"), "c": tr("참고 파일", "reference files"),
             "d": tr("허브 스킬", "hub skills"), "e": tr("MCP 끄기", "MCP turned off"), "f": tr("예약 작업", "cron jobs"),
             "m": tr("새 판 MCP 합치기", "merging MCP servers of the new version")}
    what = ", ".join(f"{names[k]}({v.get('reason') or ''}, {v.get('error_id') or ''})" for k, v in sorted(bad.items()))
    fix = tr(" 주 프로파일에 모델을 정한 뒤 다시 하세요.", " Set a model on the main profile, then retry.") if "a" in bad else ""
    return [{"code": "template_post", "level": "bad", "request": rec.get("id"), "retry": rec.get("id"),
             "text": tr(f"AI 에이전트 템플릿 설치 뒤 마무리하지 못한 것: {what}.{fix}", f"AI Agent template setup steps that did not finish: {what}.{fix}")}]
