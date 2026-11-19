# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""받는 사람의 메신저로도 알림 보내기(스펙 2026-11-17-008 단계 4, §6). 웹 받은편지함은 그대로 두고 같은 일을 DM 으로도 알린다.

  길       Hermes 웹훅 플랫폼(오퍼레이터 --agent-notify-webhook, 포트 8644)의 deliver_only 경로. 모델을 돌리지 않는다.
           경로는 루트 $HERMES_HOME/webhook_subscriptions.json 의 aas-notify-<프로파일>-<메신저> 항목(profile 키로 그 프로파일의 봇),
           요청마다 Hermes 가 다시 읽는다. HMAC 비밀은 작업공간마다 하나(notify_secrets), V2 서명(X-Webhook-Timestamp·X-Webhook-Signature-V2).
  받는 곳  messenger_links 의 그 사람 줄만(본문 chat_id 를 받지 않는다 — 부르는 쪽이 연결표에서 고른다). 팀 공지는 chat_id 를 비워
           Hermes 가 그 메신저의 홈 채널({P}_HOME_CHANNEL)로 보낸다.
  한 번만  notify_sent(key) 에 INSERT … ON CONFLICT DO NOTHING 으로 자리를 잡은 쪽만 보낸다(복제본 둘·다시 시작에도 한 번). 7일 뒤 지운다.
  한도     한 사람에게 1분에 RATE_MAX 개. 넘으면 그 분의 나머지는 「알림 N개가 더 있습니다」 한 줄로 묶는다(다음 보내기 때).
  끄기     설치 전체: 환경 변수 AAS_NOTIFY_WEBHOOK(차트가 오퍼레이터 플래그와 함께 켠다)와 관리자 설정 meta messenger_notify. 사람마다 notify_prefs.
  내용     기본은 「종류 · AI 에이전트 작업공간 별명 · AAS 링크」. 명령·질문 글은 넣지 않는다. 받는 사람이 연결할 때 고른 언어로 쓴다.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import posixpath
import secrets
import threading
import time
import urllib.parse
import urllib.request

from contextlib import contextmanager

from ..common import config, i18n, store
from ..common.i18n import tr

SCHEMA = """
CREATE TABLE IF NOT EXISTS notify_sent (key TEXT PRIMARY KEY, ts REAL NOT NULL);
CREATE TABLE IF NOT EXISTS notify_rate (email TEXT NOT NULL, at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS notify_secrets (pod TEXT PRIMARY KEY, secret TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notify_prefs (email TEXT PRIMARY KEY, off INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS cron_creators (pod TEXT NOT NULL, profile TEXT NOT NULL, job_id TEXT NOT NULL, email TEXT NOT NULL, ts REAL NOT NULL,
  PRIMARY KEY (pod, profile, job_id));
"""
KEEP = 7 * 86400
RATE_MAX = 5
RATE_WINDOW = 60.0
WEBHOOK_PORT = 8644
ROUTES_FILE = "webhook_subscriptions.json"
SETTING_KEY = "messenger_notify"
DELIVERABLE_BY_USER_ID = ("telegram", "slack")       # 사람 id 로 DM 을 보낼 수 있는 메신저(§1-1)
TIMEOUT = 8.0

_routes_done: set[tuple] = set()                      # (pod, profile, platform, secret) — 이 프로세스가 이미 써 둔 경로
_lock = threading.Lock()
counters = {"sent": 0, "failed": 0, "skipped": 0, "folded": 0}   # 로그·지표용(§11)


def _conn():
    conn = store.connect()
    conn.executescript(SCHEMA)
    return conn


# ---- 켜기·끄기 ----------------------------------------------------------------------------------------------------
def installed() -> bool:
    """설치에서 웹훅 길을 열었는가(차트가 오퍼레이터 --agent-notify-webhook 과 함께 AAS_NOTIFY_WEBHOOK=1 을 준다)."""
    return config.get("AAS_NOTIFY_WEBHOOK", "") in ("1", "true", "yes")


def admin_enabled() -> bool:
    with _conn() as conn:
        row = conn.execute("SELECT value FROM meta WHERE key=?", (SETTING_KEY,)).fetchone()
    return not (row is not None and str(row["value"] or "") == "0")


def set_admin_enabled(on: bool) -> bool:
    with _conn() as conn:
        conn.execute("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value=excluded.value", (SETTING_KEY, "1" if on else "0"))
    return bool(on)


def enabled() -> bool:
    return installed() and admin_enabled()


def person_off(email: str) -> bool:
    with _conn() as conn:
        row = conn.execute("SELECT off FROM notify_prefs WHERE email=?", (email.lower(),)).fetchone()
    return bool(row and row["off"])


def set_person_off(email: str, off: bool) -> None:
    with _conn() as conn:
        conn.execute("INSERT INTO notify_prefs (email, off) VALUES (?, ?) ON CONFLICT (email) DO UPDATE SET off=excluded.off", (email.lower(), 1 if off else 0))


# ---- 예약 작업을 만든 사람 ------------------------------------------------------------------------------------------
def note_cron_creator(pod: str, profile: str, job_id: str, email: str) -> None:
    if not (job_id and email):
        return
    with _conn() as conn:
        conn.execute("INSERT INTO cron_creators (pod, profile, job_id, email, ts) VALUES (?,?,?,?,?) "
                      "ON CONFLICT (pod, profile, job_id) DO UPDATE SET email=excluded.email, ts=excluded.ts", (pod, profile, job_id, email.lower(), time.time()))


def cron_creator(pod: str, profile: str, job_id: str) -> str:
    with _conn() as conn:
        row = conn.execute("SELECT email FROM cron_creators WHERE pod=? AND profile=? AND job_id=?", (pod, profile, job_id)).fetchone()
    return row["email"] if row else ""


def creators_to_owner(pod: str, email: str) -> int:
    """구성원을 뺄 때: 그 사람이 만든 예약 작업의 받는 사람을 주인으로 돌린다(기록을 지우면 주인이 받는다, §3-5)."""
    with _conn() as conn:
        return conn.execute("DELETE FROM cron_creators WHERE pod=? AND email=?", (pod, email.lower())).rowcount


# ---- 한 번만·한도 -------------------------------------------------------------------------------------------------
def claim(key: str, now: float | None = None) -> bool:
    """이 알림을 보낼 자리를 잡는다. 이미 누군가 잡았으면 False."""
    now = time.time() if now is None else now
    with _conn() as conn:
        conn.execute("DELETE FROM notify_sent WHERE ts < ?", (now - KEEP,))
        return conn.execute("INSERT INTO notify_sent (key, ts) VALUES (?, ?) ON CONFLICT (key) DO NOTHING", (key, now)).rowcount == 1


def was_sent(keys: list[str]) -> set[str]:
    keys = [k for k in keys if k]
    if not keys:
        return set()
    with _conn() as conn:
        return {r["key"] for r in conn.execute(f"SELECT key FROM notify_sent WHERE key IN ({','.join('?' * len(keys))})", keys).fetchall()}


def _rate_take(email: str, now: float) -> bool:
    with _conn() as conn:
        conn.execute("DELETE FROM notify_rate WHERE at < ?", (now - RATE_WINDOW * 10,))
        n = conn.execute("SELECT COUNT(*) AS n FROM notify_rate WHERE email=? AND at >= ?", (email, now - RATE_WINDOW)).fetchone()["n"]
        if int(n) >= RATE_MAX:
            return False
        conn.execute("INSERT INTO notify_rate (email, at) VALUES (?, ?)", (email, now))
    return True


# ---- 웹훅 경로 ----------------------------------------------------------------------------------------------------
def _secret(pod: str) -> str:
    with _conn() as conn:
        row = conn.execute("SELECT secret FROM notify_secrets WHERE pod=?", (pod,)).fetchone()
        if row:
            return row["secret"]
        value = secrets.token_hex(32)
        conn.execute("INSERT INTO notify_secrets (pod, secret) VALUES (?, ?) ON CONFLICT (pod) DO NOTHING", (pod, value))
        return conn.execute("SELECT secret FROM notify_secrets WHERE pod=?", (pod,)).fetchone()["secret"]


def route_name(profile: str, platform: str) -> str:
    return f"aas-notify-{profile}-{platform}"


def route_entry(profile: str | None, platform: str, secret: str) -> dict:
    """Hermes 웹훅 경로 하나. 받은 글({message})이 곧 메시지이고, chat_id 가 비면 그 메신저의 홈 채널로 간다."""
    entry = {"description": "CogentAI AAS notifications", "secret": secret, "deliver_only": True, "deliver": platform,
             "deliver_extra": {"chat_id": "{chat_id}"}, "prompt": "{message}"}
    if profile:
        entry["profile"] = profile
    return entry


def ensure_route(api, root_home: str, pod: str, profile: str, is_root: bool, platform: str) -> str:
    """루트 webhook_subscriptions.json 에 경로가 있게 한다(없거나 비밀이 다르면 쓴다). 이 프로세스가 한 번 쓴 것은 다시 보지 않는다."""
    secret = _secret(pod)
    key = (pod, profile, platform, secret)
    with _lock:
        if key in _routes_done:
            return secret
    path = posixpath.join(root_home, ROUTES_FILE)
    try:
        cur = api.call("GET", "/api/fs/read-text", query={"path": path})
        data = json.loads(str((cur or {}).get("content") or "") or "{}")
    except Exception:                                   # 파일이 없거나 깨졌다 — 우리 경로만 새로 쓴다(다른 경로는 깨진 파일과 함께 그대로 둘 수 없다)
        data = {}
    if not isinstance(data, dict):
        data = {}
    name = route_name(profile, platform)
    want = route_entry(None if is_root else profile, platform, secret)
    if data.get(name) != want:
        data[name] = want
        api.call("POST", "/api/fs/write-text", {"path": path, "content": json.dumps(data, ensure_ascii=False, indent=2)})
    with _lock:
        _routes_done.add(key)
    return secret


def webhook_url(dashboard_url: str, profile: str, is_root: bool, platform: str) -> str:
    u = urllib.parse.urlsplit(dashboard_url)
    host = u.hostname or ""
    base = f"{u.scheme or 'http'}://{host}:{int(config.get('AAS_NOTIFY_WEBHOOK_PORT', str(WEBHOOK_PORT)) or WEBHOOK_PORT)}"
    prefix = "" if is_root else f"/p/{urllib.parse.quote(profile, safe='')}"
    return f"{base}{prefix}/webhooks/{urllib.parse.quote(route_name(profile, platform), safe='')}"


def sign(secret: str, body: bytes, ts: int | None = None) -> dict[str, str]:
    ts = int(time.time()) if ts is None else ts
    sig = hmac.new(secret.encode(), str(ts).encode() + b"." + body, hashlib.sha256).hexdigest()
    return {"Content-Type": "application/json", "X-Webhook-Timestamp": str(ts), "X-Webhook-Signature-V2": sig}


def post(url: str, secret: str, message: str, chat_id: str, delivery_id: str) -> bool:
    body = json.dumps({"message": message, "chat_id": chat_id}, ensure_ascii=False).encode()
    req = urllib.request.Request(url, data=body, method="POST", headers={**sign(secret, body), "X-Request-ID": delivery_id})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return 200 <= resp.status < 300
    except Exception:
        return False


@contextmanager
def use_lang(lang: str):
    """받는 사람의 언어로 글을 만든다. 리더가 보내는 알림은 요청이 없어 언어를 모른다(§6-2)."""
    token = i18n._lang.set(lang if lang in i18n.SUPPORTED else i18n.DEFAULT)
    try:
        yield
    finally:
        i18n._lang.reset(token)


# ---- 글 ----------------------------------------------------------------------------------------------------------
def kind_text(kind: str) -> str:
    """알림 종류 이름(지금 언어로)."""
    return {
        "approval": tr("위험 명령 승인 요청", "Approval request for a risky command"),
        "clarify": tr("AI 에이전트의 질문", "A question from the AI agent"),
        "cron_failed": tr("예약 작업 실패", "Scheduled job failed"),
        "cron_still_failing": tr("예약 작업이 아직 실패 중", "Scheduled job still failing"),
        "review": tr("칸반 카드 검토 요청", "Kanban card waiting for review"),
        "blocked": tr("칸반 카드 막힘", "Kanban card blocked"),
    }.get(kind) or tr("알림", "Notice")


def message(kind: str, alias: str, link: str, lang: str = "", extra: int = 0) -> str:
    """기본 내용: 종류 · AI 에이전트 작업공간 별명 · AAS 링크. 명령·질문 글은 넣지 않는다(§6-2)."""
    with use_lang(lang or "ko"):
        head = kind_text(kind)
        more = tr(f"\n알림 {extra}개가 더 있습니다.", f"\n{extra} more notifications.") if extra else ""
        return f"[CogentAI AAS] {head} · {alias}\n{link}{more}".strip()


def aas_link(path: str = "") -> str:
    base = str(config.get("AAS_PUBLIC_URL", "") or "").rstrip("/")
    return f"{base}/{path.lstrip('/')}" if base else path


# ---- 보내기 ------------------------------------------------------------------------------------------------------
def targets(links: list[dict]) -> list[dict]:
    """연결 줄 → 보낼 곳. DM 대화방 id 가 있으면 그것, 없으면 사람 id 로 보낼 수 있는 메신저만."""
    out = []
    for r in links:
        chat = r.get("dm_chat_id") or (r["platform_user_id"] if r["platform"] in DELIVERABLE_BY_USER_ID else "")
        if chat:
            out.append({**r, "chat_id": chat})
    return out


def deliver(pod, email: str, kind: str, alias: str, link: str, key: str, *, api, root_home: str, is_root_profile,
            links: list[dict], now: float | None = None) -> str:
    """한 사람에게 한 알림. 돌려주는 값: sent·skipped(off·no_link·dup)·folded·failed. 부르는 쪽은 다른 스레드에서 부른다."""
    now = time.time() if now is None else now
    email = (email or "").lower()
    if not enabled() or not email:
        return "skipped"
    if person_off(email):
        counters["skipped"] += 1
        return "skipped"
    tgt = targets(links)
    if not tgt:
        counters["skipped"] += 1
        return "skipped"
    if not claim(f"{key}|{email}", now):
        return "skipped"
    if not _rate_take(email, now):
        counters["folded"] += 1
        return "folded"
    ok_any = False
    for t in tgt:
        try:
            secret = ensure_route(api, root_home, pod.id, t["profile"], is_root_profile(t["profile"]), t["platform"])
        except Exception:
            counters["failed"] += 1
            continue
        text = message(kind, alias, link, t.get("lang") or "")
        if post(webhook_url(pod.dashboard_url, t["profile"], is_root_profile(t["profile"]), t["platform"]), secret, text, t["chat_id"], key):
            ok_any = True
            counters["sent"] += 1
        else:
            counters["failed"] += 1
    return "sent" if ok_any else "failed"


def deliver_team(pod, profile: str, platform: str, kind: str, alias: str, link: str, key: str, *, api, root_home: str, is_root: bool) -> str:
    """팀 공지 대화방: chat_id 를 비워 그 메신저의 홈 채널로 보낸다."""
    if not enabled() or not claim(f"{key}|team|{profile}|{platform}"):
        return "skipped"
    try:
        secret = ensure_route(api, root_home, pod.id, profile, is_root, platform)
    except Exception:
        counters["failed"] += 1
        return "failed"
    ok = post(webhook_url(pod.dashboard_url, profile, is_root, platform), secret, message(kind, alias, link), "", key)
    counters["sent" if ok else "failed"] += 1
    return "sent" if ok else "failed"
