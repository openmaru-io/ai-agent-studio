# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""메신저 계정 ↔ AAS 사용자 연결(스펙 2026-11-17-008 §5). Hermes 페어링 승인 결과(user_id·user_name·chat_id)를 그 사람과 묶어 둔다.

  messenger_links          (pod, profile, platform, platform_user_id) 하나에 한 사람. dm_chat_id 는 패치한 Hermes 가 준 DM 대화방 id
                           (Telegram·Slack 은 비어도 user_id 로 보낼 수 있다). lang 은 연결할 때 그 사람의 화면 언어(알림 글).
  messenger_revoke_queue   구성원을 뺄 때 파드가 꺼져 있어 Hermes 철회가 실패한 것. 리더가 1분마다 다시 시도한다(최대 MAX_TRIES).
  messenger_link_tries     연결 코드 시도. 사람마다 1시간 PER_PERSON 번, (pod, profile, platform) 마다 1시간 PER_BOT 번 —
                           Hermes 는 플랫폼 전체에서 5번 틀리면 1시간 잠그므로 한 사람이 다른 사람의 연결을 막지 못하게 AAS 가 먼저 센다.
"""
from __future__ import annotations

import re
import time
from datetime import datetime

from ..common import store

SCHEMA = """
CREATE TABLE IF NOT EXISTS messenger_links (
  pod TEXT NOT NULL, profile TEXT NOT NULL, platform TEXT NOT NULL, platform_user_id TEXT NOT NULL,
  dm_chat_id TEXT NOT NULL DEFAULT '', email TEXT NOT NULL, user_name TEXT NOT NULL DEFAULT '', lang TEXT NOT NULL DEFAULT '',
  ts TEXT NOT NULL, PRIMARY KEY (pod, profile, platform, platform_user_id));
CREATE TABLE IF NOT EXISTS messenger_revoke_queue (
  pod TEXT NOT NULL, profile TEXT NOT NULL, platform TEXT NOT NULL, platform_user_id TEXT NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0, next_at REAL NOT NULL DEFAULT 0, PRIMARY KEY (pod, profile, platform, platform_user_id));
CREATE TABLE IF NOT EXISTS messenger_link_tries (who TEXT NOT NULL, bot TEXT NOT NULL, at REAL NOT NULL);
"""

CODE = re.compile(r"^[A-HJ-NP-Z2-9]{8}\Z")      # Hermes gateway/pairing.py 의 ALPHABET·CODE_LENGTH(8자, 0·1·I·O 없음)
PER_PERSON = 3
PER_BOT = 4
WINDOW = 3600.0
MAX_TRIES = 30                                   # 1분 간격으로 30분 넘게 실패하면 큐에서 뺀다(로그만 남는다)


def _conn():
    conn = store.connect()
    conn.executescript(SCHEMA)
    return conn


def clean_code(raw) -> str:
    """사람이 넣은 코드(띄어쓰기·소문자 허용)를 Hermes 형식으로. 맞지 않으면 빈 문자열 — Hermes 를 부르지 않는다."""
    code = "".join(str(raw or "").upper().split())
    return code if CODE.match(code) else ""


def tries_left(email: str, bot: str, now: float | None = None) -> tuple[int, int]:
    """(이 사람이 남은 횟수, 이 봇에 남은 횟수). bot = "<pod>|<profile>|<platform>"."""
    now = time.time() if now is None else now
    with _conn() as conn:
        conn.execute("DELETE FROM messenger_link_tries WHERE at < ?", (now - WINDOW,))
        mine = conn.execute("SELECT COUNT(*) AS n FROM messenger_link_tries WHERE who=? AND at >= ?", (email.lower(), now - WINDOW)).fetchone()["n"]
        bots = conn.execute("SELECT COUNT(*) AS n FROM messenger_link_tries WHERE bot=? AND at >= ?", (bot, now - WINDOW)).fetchone()["n"]
    return PER_PERSON - int(mine), PER_BOT - int(bots)


def note_try(email: str, bot: str, now: float | None = None) -> None:
    with _conn() as conn:
        conn.execute("INSERT INTO messenger_link_tries (who, bot, at) VALUES (?,?,?)", (email.lower(), bot, time.time() if now is None else now))


def forget_tries(email: str, bot: str) -> None:
    """연결에 성공하면 그 사람의 시도는 지운다(다음 연결을 막지 않게). 봇 단위 수는 남긴다."""
    with _conn() as conn:
        conn.execute("DELETE FROM messenger_link_tries WHERE who=? AND bot=?", (email.lower(), bot))


def record(pod: str, profile: str, platform: str, user: dict, email: str, lang: str = "") -> dict:
    """승인 결과(user: {user_id, user_name, chat_id})를 이 사람의 연결로 적는다. 같은 메신저 계정이면 덮어쓴다(다른 사람이 다시 연결)."""
    row = {"pod": pod, "profile": profile, "platform": platform, "platform_user_id": str(user.get("user_id") or ""),
           "dm_chat_id": str(user.get("chat_id") or ""), "email": email.lower(), "user_name": str(user.get("user_name") or "")[:120],
           "lang": lang[:8], "ts": datetime.now().astimezone().isoformat(timespec="seconds")}
    if not row["platform_user_id"]:
        raise ValueError("user_id")
    with _conn() as conn:
        conn.execute("INSERT INTO messenger_links (pod, profile, platform, platform_user_id, dm_chat_id, email, user_name, lang, ts) "
                     "VALUES (:pod,:profile,:platform,:platform_user_id,:dm_chat_id,:email,:user_name,:lang,:ts) "
                     "ON CONFLICT (pod, profile, platform, platform_user_id) DO UPDATE SET dm_chat_id=excluded.dm_chat_id, "
                     "email=excluded.email, user_name=excluded.user_name, lang=excluded.lang, ts=excluded.ts", row)
    return row


def links(pod: str, email: str | None = None, profile: str | None = None) -> list[dict]:
    q, args = "SELECT * FROM messenger_links WHERE pod=?", [pod]
    if email is not None:
        q, args = q + " AND email=?", [*args, email.lower()]
    if profile is not None:
        q, args = q + " AND profile=?", [*args, profile]
    with _conn() as conn:
        return [dict(r) for r in conn.execute(q + " ORDER BY profile, platform, ts", args).fetchall()]


def links_of(email: str) -> list[dict]:
    with _conn() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM messenger_links WHERE email=? ORDER BY pod, profile", (email.lower(),)).fetchall()]


def drop(pod: str, profile: str, platform: str, platform_user_id: str) -> None:
    with _conn() as conn:
        conn.execute("DELETE FROM messenger_links WHERE pod=? AND profile=? AND platform=? AND platform_user_id=?",
                     (pod, profile, platform, platform_user_id))


def queue_revoke(pod: str, profile: str, platform: str, platform_user_id: str, now: float | None = None) -> None:
    now = time.time() if now is None else now
    with _conn() as conn:
        conn.execute("INSERT INTO messenger_revoke_queue (pod, profile, platform, platform_user_id, tries, next_at) VALUES (?,?,?,?,0,?) "
                     "ON CONFLICT (pod, profile, platform, platform_user_id) DO NOTHING", (pod, profile, platform, platform_user_id, now + 60))


def due_revokes(now: float | None = None, limit: int = 20) -> list[dict]:
    now = time.time() if now is None else now
    with _conn() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM messenger_revoke_queue WHERE next_at <= ? ORDER BY next_at LIMIT ?",
                                              (now, limit)).fetchall()]


def revoke_done(row: dict) -> None:
    with _conn() as conn:
        conn.execute("DELETE FROM messenger_revoke_queue WHERE pod=? AND profile=? AND platform=? AND platform_user_id=?",
                     (row["pod"], row["profile"], row["platform"], row["platform_user_id"]))


def revoke_failed(row: dict, now: float | None = None) -> bool:
    """한 번 더 실패. 너무 많이 실패했으면 큐에서 빼고 False."""
    now = time.time() if now is None else now
    if int(row.get("tries") or 0) + 1 >= MAX_TRIES:
        revoke_done(row)
        return False
    with _conn() as conn:
        conn.execute("UPDATE messenger_revoke_queue SET tries=tries+1, next_at=? WHERE pod=? AND profile=? AND platform=? AND platform_user_id=?",
                     (now + 60, row["pod"], row["profile"], row["platform"], row["platform_user_id"]))
    return True
