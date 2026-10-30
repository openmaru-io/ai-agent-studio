# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""오피스에 지금 있는 사람과 그 사람 아바타의 위치(계획 007 P6a·P6b, R6).

화면이 10초마다 신호를 보내고, 30초 동안 신호가 없으면 빠진다. 오피스 화면을 연 로그인 사용자 모두에게 서로를 보이되,
이메일은 관리자에게만 보낸다.

서버 복제본이 2개이고 브라우저마다 한 서버에 고정된다(OMAI-1105). 그래서 접속자·위치·앉은 의자를 서버 메모리가 아니라
공유 DB(`office_presence`)에 둔다. 각 서버는 `changes()` 로 DB 를 짧은 간격으로 읽어 바뀐 걸음을 자기 화면들에 보낸다.
같은 의자는 부분 고유 색인으로 한 사람만 앉는다 — 어느 서버로 왔든 먼저 쓴 사람이 앉는다.
"""
from __future__ import annotations

import hashlib
import threading
import time

from . import office, shared

TTL = 30.0

SCHEMA = """
CREATE TABLE IF NOT EXISTS office_presence /* unlogged */ (
  email TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', seed TEXT NOT NULL DEFAULT '', viewing TEXT NOT NULL DEFAULT '',
  ts REAL NOT NULL, x REAL, y REAL, f REAL, sit TEXT NOT NULL DEFAULT '');
CREATE UNIQUE INDEX IF NOT EXISTS office_presence_sit ON office_presence (sit) WHERE sit <> '';
"""


def person_id(email: str) -> str:
    """이메일을 드러내지 않는 안정된 id(화면의 key·내 얼굴 찾기에 쓴다)."""
    return hashlib.sha256((email or "").lower().encode()).hexdigest()[:16]


def _connect():
    conn = office.connect()
    conn.executescript(SCHEMA)
    return conn


HOLD_EVERY = 15.0      # 웹소켓으로 붙은 사람의 ts 를 서버가 한꺼번에 고치는 주기(초, 스펙 2026-10-26-001 리뷰 D15). TTL 30초의 절반


class Presence:
    def __init__(self, ttl: float = TTL, clock=time.time):
        self._ttl, self._clock = ttl, clock
        self._last: dict[str, dict] | None = None        # changes() 가 마지막으로 본 위치(id → 위치)
        self._people: dict[str, tuple] | None = None     # changes() 가 마지막으로 본 사람(이메일 → (이름, 얼굴)). 사람 목록 토픽용
        self.people_changed = False                      # changes() 가 사람 목록 변화를 찾았다 — 서버가 office:people 을 다시 읽게 하고 끈다
        self._seen: dict[str, tuple] = {}                # 이 서버가 본 신호(이메일 → (이름, 얼굴, 시각)). 바뀐 신호만 알린다(D5)
        self._held: dict[str, tuple] = {}                # 웹소켓 연결 id → (이메일, 이름, 얼굴, 보는 탭). 서버가 15초마다 ts 를 대신 고친다(D15)
        self._lock = threading.Lock()

    def _expire(self, conn) -> None:
        conn.execute("DELETE FROM office_presence WHERE ts < ?", (self._clock() - self._ttl,))

    def expire(self) -> None:
        """신호가 끊긴 사람의 행을 지운다. 60초 정리(server.shared_tick)가 부른다 — 읽기(changes·view)는 지우지 않고 시각으로 거른다
        (걸음 보기가 쓰기 트랜잭션이 되지 않게, 스펙 2026-10-24-009 리뷰 C2·외부 검토 M2)."""
        with _connect() as conn:
            self._expire(conn)

    def _news(self, email: str, name: str, seed: str, now: float) -> bool:
        """다른 화면에 알릴 신호인가: 이 서버가 처음 보는 사람, 마지막 신호가 TTL 보다 오래된(떠났다 돌아온) 사람, 이름·얼굴이 바뀐 사람.
        ts·보는 탭(viewing)만 바뀐 신호는 알리지 않는다 — viewing 은 화면이 읽지 않고, 탭을 둘 열면 신호마다 바뀐다(리뷰 D12)."""
        with self._lock:
            prev = self._seen.get(email)
            self._seen[email] = (name, seed, now)
        return prev is None or now - prev[2] > self._ttl or prev[0] != name or prev[1] != seed

    def beat(self, email: str, name: str, seed: str, viewing: str = "") -> None:
        if not email:
            return
        email = email.lower()
        news = self._news(email, name or "", seed or "", self._clock())
        stale = self._clock() - self._ttl
        with _connect() as conn:
            # 시간이 다 된 행은 60초 정리 전까지 남는다. 그 사람이 돌아오면 옛 자리를 비워 알림 없이 다시 나타나지 않게 한다(외부 검토 L3)
            conn.execute("INSERT INTO office_presence (email, name, seed, viewing, ts) VALUES (?,?,?,?,?) "
                         "ON CONFLICT(email) DO UPDATE SET name=excluded.name, seed=excluded.seed, viewing=excluded.viewing, ts=excluded.ts, "
                         "x=CASE WHEN office_presence.ts < ? THEN NULL ELSE office_presence.x END, "
                         "y=CASE WHEN office_presence.ts < ? THEN NULL ELSE office_presence.y END, "
                         "f=CASE WHEN office_presence.ts < ? THEN NULL ELSE office_presence.f END, "
                         "sit=CASE WHEN office_presence.ts < ? THEN '' ELSE office_presence.sit END",
                         (email, name or "", seed or "", (viewing or "")[:80], self._clock(), stale, stale, stale, stale))
            if news:                                     # 들어옴·이름·얼굴 바뀜 — 모든 서버의 presence_tick 이 사람 목록을 다시 본다(D5)
                shared.notify(conn, "presence")

    def leave(self, email: str) -> None:
        email = (email or "").lower()
        with self._lock:
            self._seen.pop(email, None)
        with _connect() as conn:
            conn.execute("DELETE FROM office_presence WHERE email=?", (email,))
            shared.notify(conn, "presence")

    # ---- 웹소켓으로 붙은 사람(스펙 2026-10-26-001 리뷰 D15) ------------------------------------------------------
    def hold(self, conn_id: str, email: str, name: str, seed: str, viewing: str = "") -> None:
        """웹소켓 신호를 받았다: 신호를 쓰고, 이 연결이 이 사람을 붙잡고 있다고 기억한다. 그 뒤 10초 신호는 화면이 보내지 않는다."""
        email = (email or "").lower()
        if not email:
            return
        self.beat(email, name, seed, viewing)
        with self._lock:
            self._held[conn_id] = (email, name or "", seed or "", (viewing or "")[:80])

    def release(self, conn_id: str, leave: bool = False) -> None:
        """연결이 끊겼거나 화면이 오피스를 떠났다. 떠났는데 같은 사람의 다른 연결이 이 서버에 없으면 바로 뺀다.
        끊긴 것(leave=False)은 지우지 않는다 — 다시 붙는 동안 사라졌다 나타나지 않게 TTL(30초)에 맡긴다."""
        with self._lock:
            held = self._held.pop(conn_id, None)
            still = held is not None and any(h[0] == held[0] for h in self._held.values())
        if held and leave and not still:
            self.leave(held[0])

    def held_emails(self) -> set[str]:
        with self._lock:
            return {h[0] for h in self._held.values()}

    def refresh_held(self) -> int:
        """붙잡은 사람 모두의 ts 를 한 문장으로 고친다(서버마다 15초에 한 번). 고친 사람 수를 돌려준다.
        다른 서버에서 같은 사람이 떠나 행이 지워졌으면, 아직 붙잡고 있는 사람은 다시 넣는다(드문 경우라 한 사람씩)."""
        with self._lock:
            held = {h[0]: h for h in self._held.values()}
        if not held:
            return 0
        now = self._clock()
        emails = sorted(held)
        marks = ",".join("?" for _ in emails)
        with _connect() as conn:
            cur = conn.execute(f"UPDATE office_presence SET ts=? WHERE email IN ({marks})", (now, *emails))
            done = cur.rowcount
            if done < len(emails):
                have = {str(r["email"]) for r in conn.execute(f"SELECT email FROM office_presence WHERE email IN ({marks})", tuple(emails))}
            else:
                have = set(emails)
        with self._lock:
            for e in have:
                h = held[e]
                self._seen[e] = (h[1], h[2], now)
        for e in sorted(set(emails) - have):
            _email, name, seed, viewing = held[e]
            with self._lock:
                self._seen.pop(e, None)                   # 다시 넣는 것은 들어옴으로 알린다
            self.beat(e, name, seed, viewing)
        return len(emails)

    def move(self, email: str, x: float, y: float, facing: float, sit: str = "") -> dict | None:
        """내 아바타를 옮긴다. 의자에 앉으려 할 때 이미 남이 앉아 있으면 앉지 못한다(먼저 요청한 사람이 앉는다).
        돌려주는 것은 모두에게 보낼 위치(이메일 없이 id). 오피스에 있지 않으면(신호가 없으면) None."""
        email = (email or "").lower()
        pos = {"x": round(float(x), 1), "y": round(float(y), 1), "f": round(float(facing), 1), "sit": sit or ""}
        with _connect() as conn:
            self._expire(conn)                               # 시간이 다 된 사람의 의자를 먼저 비운다
        sql = "UPDATE office_presence SET x=?, y=?, f=?, sit=? WHERE email=?"
        try:
            with _connect() as conn:                         # 문장마다 따로 커밋한다 — 실패한 문장은 그것만 되돌린다
                cur = conn.execute(sql, (pos["x"], pos["y"], pos["f"], pos["sit"], email))
                if cur.rowcount:
                    shared.notify(conn, "presence")
        except Exception:                                     # 고유 색인: 남이 먼저 앉았다
            if not pos["sit"]:
                raise
            pos["sit"] = ""
            with _connect() as conn:
                cur = conn.execute(sql, (pos["x"], pos["y"], pos["f"], "", email))
                if cur.rowcount:
                    shared.notify(conn, "presence")
        if not cur.rowcount:
            return None
        return {"id": person_id(email), **pos}

    def view(self, me: str, admin: bool) -> list[dict]:
        """지금 있는 사람들. 나를 맨 앞에 둔다. 관리자에게만 이메일을 준다."""
        me = (me or "").lower()
        with _connect() as conn:
            rows = [dict(r) for r in conn.execute("SELECT * FROM office_presence WHERE ts >= ?", (self._clock() - self._ttl,))]
        rows.sort(key=lambda r: (r["email"] != me, r["name"] or r["email"]))
        out = []
        for r in rows:
            email = r["email"]
            row = {"id": person_id(email), "name": r["name"] or email.split("@")[0], "seed": r["seed"] or person_id(email),
                   "viewing": r["viewing"], "me": email == me}
            if r["x"] is not None:
                row["pos"] = {"x": r["x"], "y": r["y"], "f": r["f"], "sit": r["sit"]}
            if admin:
                row["email"] = email
            out.append(row)
        return out

    def anyone(self) -> bool:
        """마지막 changes() 읽기에서 오피스에 있는 사람이 있었나(어느 서버에 붙었든). 아직 읽지 않았으면 있다고 본다.
        판단을 위해 따로 읽지 않는다 — 들어옴은 알림으로 곧 읽고, TTL 로 빠진 것은 다음 폴백 읽기(최대 60초)에 안다(스펙 2026-10-26-002 R15)."""
        return self._people is None or bool(self._people)

    def changes(self) -> list[tuple[str, dict]]:
        """마지막으로 부른 뒤 바뀐 걸음과 떠난 사람(다른 서버에서 쓴 것도). 처음 부르면 바탕만 잡고 빈 목록.
        같은 읽기로 사람 목록(들어옴·떠남·이름·얼굴)도 비교해 바뀌었으면 people_changed 를 켠다(스펙 2026-10-26-001 리뷰 D3).
        보는 탭(viewing)은 비교하지 않는다(D12)."""
        with _connect() as conn:
            rows = [dict(r) for r in conn.execute("SELECT email, name, seed, x, y, f, sit FROM office_presence WHERE ts >= ?",
                                                  (self._clock() - self._ttl,))]
        people = {str(r["email"]): (str(r["name"] or ""), str(r["seed"] or "")) for r in rows}
        if self._people is not None and people != self._people:
            self.people_changed = True
        self._people = people
        now = {person_id(r["email"]): {"x": r["x"], "y": r["y"], "f": r["f"], "sit": r["sit"]} for r in rows if r["x"] is not None}
        prev, self._last = self._last, now
        if prev is None:
            return []
        out = [("person.move", {"id": pid, **pos}) for pid, pos in now.items() if prev.get(pid) != pos]
        out += [("person.leave", {"id": pid}) for pid in prev if pid not in now]
        return out
