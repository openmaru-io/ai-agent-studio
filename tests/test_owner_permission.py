# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""에이전트 주인이 자기 에이전트의 SOUL 과 스킬을 바꾼다(OMAI-1126, 스펙 2026-10-13-014)."""
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.web import server  # noqa: E402

POD = SimpleNamespace(id="kim", owner="kim@x.com", owner_sub="sub-kim")
SHARED = SimpleNamespace(id="base", owner="*", owner_sub="")
KIM = {"email": "Kim@X.com", "sub": "sub-kim"}
KIM_NEW_MAIL = {"email": "kim.new@x.com", "sub": "sub-kim"}         # 이메일이 바뀌어도 sub 로 알아본다
LEE = {"email": "lee@x.com", "sub": "sub-lee"}                       # 화면 권한(grants)으로 kim 의 POD 를 보기만 하는 사람


class OwnsPodTest(unittest.TestCase):
    def test_주인은_이메일이나_sub_로_알아본다(self):
        self.assertTrue(server._owns_pod(POD, KIM, True))
        self.assertTrue(server._owns_pod(POD, KIM_NEW_MAIL, True))
        self.assertFalse(server._owns_pod(POD, LEE, True))
        self.assertFalse(server._owns_pod(SHARED, {"email": "*"}, True))
        self.assertFalse(server._owns_pod(None, KIM, True))

    def test_로그인을_끈_환경은_모두_통과한다(self):
        self.assertTrue(server._owns_pod(POD, None, False))


class OwnedByTest(unittest.TestCase):
    def test_볼_수_있는_POD_와_주인_판정이_같은_함수를_쓴다(self):
        from aas.fleet import pods
        pod = pods.Pod("kim", "kim@x.com", "/tmp", owner_sub="sub-kim")
        shared = pods.Pod("base", "*", "/tmp")
        self.assertTrue(pod.owned_by(KIM))
        self.assertTrue(pod.owned_by(KIM_NEW_MAIL))
        self.assertFalse(pod.owned_by(LEE))
        self.assertFalse(pod.owned_by(None))
        self.assertFalse(shared.owned_by({"email": "*"}))
        reg = pods.Registry.__new__(pods.Registry)
        reg.pods, reg.admins = [pod, shared], set()
        reg.grants = lambda: {"lee@x.com": {"pods": ["kim"]}}
        reg.is_admin = lambda u: False
        self.assertEqual([p.id for p in reg.allowed(KIM, True)], ["kim"])
        self.assertEqual([p.id for p in reg.allowed(LEE, True)], ["kim"])               # 보기는 되지만
        self.assertFalse(server._owns_pod(pod, LEE, True))                               # 주인은 아니다


class ProfileActionTest(unittest.TestCase):
    def test_주인은_SOUL_스킬_도구_비밀값_채널만(self):
        # 도구(toolset)는 OMAI-1193, 비밀값·채널은 OMAI-1196(스펙 2026-10-15-011 단계 1), MCP 서버 추가·삭제·카탈로그는 OMAI-1240 에서 열었다.
        # mcp_url_check(주소 가능 여부, 읽기 전용)·mcp_to_oauth(헤더→OAuth)는 OMAI-1263 에서 더했다. 모델·게이트웨이·삭제는 관리자(삭제는 owner_delete 가 따로 허용)
        # 작업 지침(AGENTS.md) 넷은 OMAI-1340(스펙 2026-10-19-004 D2·§10 H3)에서 SOUL 과 같은 권한으로 더했다
        allowed = {"soul", "soul_preview", "soul_revert", "agents", "agents_preview", "agents_revert", "agents_ack", "skill", "toolset", "env_set", "env_clear", "channel_save", "channel_test", "pairing_approve", "pairing_revoke",
                   "config", "config_preview", "config_revert", "mcp", "mcp_test", "rename", "create", "mcp_add", "mcp_remove", "mcp_catalog", "mcp_install", "mcp_docmost_write", "mcp_outline_write", "mcp_apply", "mcp_url_check", "mcp_to_oauth"}
        self.assertEqual(server.OWNER_PROFILE_ACTIONS, allowed)                                  # 조용히 넓어지지 않게 정확한 집합을 고정한다
        for action in allowed:
            self.assertTrue(server.may_change_profile(action, POD, KIM, True, False), action)
        for action in ("model", "gateway", "describe", "delete", "export", ""):          # 모델·게이트웨이는 관리자. 삭제는 owner_delete 가 따로 허용한다(핸들러)
            self.assertFalse(server.may_change_profile(action, POD, KIM, True, False), action)
        self.assertFalse(server.may_change_profile("toolset", POD, LEE, True, False))   # 보기만 받은 사람은 도구도 못 바꾼다
        for action in ("mcp_add", "mcp_remove", "mcp_catalog", "mcp_install", "mcp_apply"):
            self.assertFalse(server.may_change_profile(action, POD, LEE, True, False), action)

    def test_보기만_받은_사람은_SOUL_도_못_바꾼다(self):
        self.assertFalse(server.may_change_profile("soul", POD, LEE, True, False))
        for action in ("env_set", "env_clear", "channel_save", "channel_test", "pairing_approve", "pairing_revoke"):      # 비밀값·채널은 그 파드의 주인과 관리자만
            self.assertFalse(server.may_change_profile(action, POD, LEE, True, False), action)                       # 보기만 받은 사람은 못 한다
            self.assertTrue(server.may_change_profile(action, POD, LEE, True, True), action)

    def test_관리자는_모두(self):
        self.assertTrue(server.may_change_profile("delete", POD, LEE, True, True))


class MarketTest(unittest.TestCase):
    def test_주인은_설치와_지우기를_하고_유료_허용은_못_한다(self):
        self.assertTrue(server.may_use_market("/api/market/install", POD, KIM, True, False))
        self.assertTrue(server.may_use_market("/api/market/remove", POD, KIM, True, False))
        self.assertFalse(server.may_use_market("/api/market/grant", POD, KIM, True, False))

    def test_남의_POD_에는_설치하지_못한다(self):
        self.assertFalse(server.may_use_market("/api/market/install", POD, LEE, True, False))

    def test_관리자는_유료_허용도(self):
        self.assertTrue(server.may_use_market("/api/market/grant", POD, LEE, True, True))


if __name__ == "__main__":
    unittest.main()


@unittest.skipIf(__import__("aas.common.config", fromlist=["x"]).db_backend() == "postgres", "SQLite 옛 DB 모양 시험")
class OldDbColumnsTest(unittest.TestCase):
    """옛 DB 에 usage.pod·office_messages.kind·data 를 더한다(재검토 ET1)."""

    def setUp(self):
        import os
        import sqlite3
        import tempfile
        from aas.common import store
        from aas.office import meeting, office
        self.d = tempfile.TemporaryDirectory()
        self.old_env = os.environ.get("AAS_DATA_DIR")
        os.environ["AAS_DATA_DIR"] = self.d.name
        conn = sqlite3.connect(os.path.join(self.d.name, "aas.db"))
        conn.executescript("CREATE TABLE usage (ts TEXT NOT NULL, kind TEXT NOT NULL, note TEXT);"
                           "INSERT INTO usage VALUES ('t0', 'login', 'kim@x.com');"
                           "CREATE TABLE office_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, room INTEGER NOT NULL, role TEXT NOT NULL,"
                           " author TEXT NOT NULL DEFAULT '', content TEXT NOT NULL, ts TEXT NOT NULL);")
        conn.commit()
        conn.close()
        # 열 추가 여부는 (백엔드, 데이터 폴더, 스키마) 마다 기억한다 — 새 폴더라 다시 검사한다. 다른 시험의 기억은 건드리지 않는다
        self.caches = (store._MIGRATED, meeting._MIGRATED, office._MIGRATED)

    def tearDown(self):
        import os
        if self.old_env is None:
            os.environ.pop("AAS_DATA_DIR", None)
        else:
            os.environ["AAS_DATA_DIR"] = self.old_env
        for cache in self.caches:
            for key in [k for k in cache if self.d.name in k]:
                cache.discard(key)
        self.d.cleanup()

    def test_옛_DB_에_열을_더하고_기록에_POD_를_남긴다(self):
        from aas.common import db, store
        from aas.office import meeting
        store.log_usage("profile_soul", "kim@x.com kim/default", pod="kim")
        with store.connect() as conn:
            rows = [tuple(r) for r in conn.execute("SELECT kind, pod FROM usage ORDER BY rowid")]
            self.assertIn("usage_pod_ts", {r[1] for r in conn.execute("PRAGMA index_list(usage)")})
        self.assertEqual(rows[0], ("login", ""))                     # 옛 기록은 빈 값
        self.assertEqual(rows[1], ("profile_soul", "kim"))
        with meeting._db() as conn:
            self.assertTrue({"kind", "data"} <= db.columns(conn, "office_messages"))


class OwnerChangesTest(unittest.TestCase):
    """주인용 변경 기록: SQL 에서 POD·종류로 거르고 주인이 된 시각 뒤만(재검토 H2·L6, ET2)."""

    def tearDown(self):
        from aas.common import store
        with store.connect() as conn:
            conn.execute("DELETE FROM usage WHERE pod IN ('own-a', 'own-b') OR note LIKE 'noise %'")
            conn.execute("CREATE TABLE IF NOT EXISTS pod_owners (pod TEXT PRIMARY KEY, owner TEXT NOT NULL, since TEXT NOT NULL)")
            conn.execute("DELETE FROM pod_owners WHERE pod IN ('own-a', 'own-b')")

    def test_다른_POD_기록_4000줄_뒤에도_주인_기록이_보이고_접속_기록은_빠진다(self):
        from aas.common import store
        from aas.ops import changes
        store.log_usage("profile_soul", "kim@x.com own-a 첫 기록", pod="own-a")
        store.log_usage("market_install", "admin@x.com free/x@1 → own-a/ma req=r1", pod="own-a")
        store.log_usage("login", "kim@x.com", pod="own-a")                                   # 접속은 주인 화면에 없다
        with store.connect() as conn:
            for i in range(4100):
                conn.execute("INSERT INTO usage (ts, kind, note, pod) VALUES (?,?,?,?)", ("2999-01-01T00:00:00+09:00", "profile_soul", f"noise {i}", "own-b"))
        mine = changes.rows(30, pod="own-a")
        self.assertEqual(sorted(r["kind"] for r in mine), ["market_install", "profile_soul"])
        self.assertEqual(next(r for r in mine if r["kind"] == "market_install")["request"], "r1")
        self.assertEqual(changes.rows(30, pod="own-a", since="2999-01-01T00:00:00+09:00"), [])   # 주인이 되기 전 기록은 빠진다

    def test_사람이_아닌_주체는_actor_로_가른다(self):
        """「누가」가 빈 기록을 원인별로 가른다(2026-10-17-012): AAS 서버가 스스로 한 일(note 가 aas 로 시작) → aas,
        Hermes 가 스킬 문서를 고친 것(skill_agent_edit) → agent, 누가 했는지 남기기 전의 옛 기록 → 없음."""
        from aas.common import store
        from aas.ops import changes
        store.log_usage("profile_config", "aas main curator.prune_builtins=false", pod="own-a")
        store.log_usage("skill_agent_edit", "main zz-skill", pod="own-a")
        store.log_usage("profile_soul", "own-a 옛 기록", pod="own-a")
        store.log_usage("profile_soul", "kim@x.com own-a 새 기록", pod="own-a")
        got = {r["kind"] + ":" + r["detail"]: r for r in changes.rows(30, pod="own-a")}
        auto = got["profile_config:main curator.prune_builtins=false"]
        self.assertEqual((auto["who"], auto.get("actor")), ("", "aas"))
        agent = got["skill_agent_edit:main zz-skill"]
        self.assertEqual((agent["who"], agent.get("actor")), ("", "agent"))
        old = got["profile_soul:own-a 옛 기록"]
        self.assertEqual((old["who"], old.get("actor")), ("", None))
        person = got["profile_soul:own-a 새 기록"]
        self.assertEqual((person["who"], person.get("actor")), ("kim@x.com", None))
        store.log_usage("login_failed", "10.0.0.9", pod="own-a")
        guest = next(r for r in changes.rows(30) if r["kind"] == "login_failed" and r["detail"] == "10.0.0.9")
        self.assertEqual((guest["who"], guest.get("actor")), ("", "guest"))   # 로그인 실패는 IP 만 남아 「로그인 전」

    def test_주인이_바뀌면_주인_시작_시각을_새로_적는다(self):
        from aas.fleet import pods
        reg = pods.Registry.__new__(pods.Registry)
        pod = pods.Pod("own-a", "kim@x.com", "/tmp")
        first = reg.owner_since(pod)
        self.assertEqual(reg.owner_since(pod), first)
        import time
        time.sleep(1.1)
        moved = pods.Pod("own-a", "lee@x.com", "/tmp")
        self.assertGreater(reg.owner_since(moved), first)


class ChangeTargetTest(unittest.TestCase):
    """변경 기록의 「대상」만으로 누구의 프로파일·어느 방인지 알 수 있어야 한다(2026-10-18). 「main skills…」·「room.delete」만 보였다."""

    def tearDown(self):
        from aas.common import store
        from aas.office import office
        with store.connect() as conn:
            conn.execute("DELETE FROM usage WHERE pod IN ('own-a', 'own-b', 'base-x')")
        with office.connect() as conn:
            conn.execute("DELETE FROM office_rooms WHERE name LIKE '대상시험%'")
            conn.execute("DELETE FROM office_people WHERE email='kim@x.com'")

    def test_관리자_기록에_POD_와_주인_이름이_붙는다(self):
        from aas.common import store
        from aas.fleet import pods
        from aas.office import office
        from aas.ops import changes
        office.person_touch("kim@x.com", "김철수")
        store.log_usage("profile_config", "aas main skills.external_dirs+=/opt/aas-skills", pod="own-a")
        store.log_usage("profile_config", "aas main skills.external_dirs+=/opt/aas-skills", pod="own-b")
        store.log_usage("profile_config", "aas default curator.prune_builtins=false", pod="base-x")
        reg = SimpleNamespace(pods=[pods.Pod("own-a", "kim@x.com", "/tmp"), pods.Pod("own-b", "lee@x.com", "/tmp"), pods.Pod("base-x", "*", "/tmp")])
        got = {r["pod"]: r for r in server._with_owners(changes.rows(30), reg) if r.get("pod") in ("own-a", "own-b", "base-x")}
        self.assertEqual(got["own-a"]["owner"], "김철수")
        self.assertEqual(got["own-b"]["owner"], "lee")                 # 이름을 모르면 이메일 앞부분
        self.assertEqual(got["base-x"]["owner"], "base-x")             # 주인이 없는 기본 POD 는 POD 이름

    def test_방을_지운_기록에_방_이름이_남는다(self):
        from aas.office import office
        rid = office.set_room({"name": "대상시험 방", "seats": []}, "admin@x.com")["id"]
        self.assertEqual(server._office_target({"action": "room.delete", "id": rid}), "대상시험 방")
        self.assertEqual(server._office_target({"action": "seat.set", "alias": "kim-main"}), "kim-main")
        self.assertEqual(server._room_note({"room": rid}, {}), " 방 대상시험 방")
        self.assertEqual(server._room_note({}, {"room": [str(rid)]}), " 방 대상시험 방")
        self.assertEqual(server._room_note({}, {}), "")


class SoulNoticeTest(unittest.TestCase):
    """SOUL 이 바뀌면 그 에이전트가 켜진 자리로 앉은 열린 방에 알린다(OMAI-1126 T9, 재검토 ET3)."""

    def setUp(self):
        import os
        import tempfile
        from aas.office import office
        self.d = tempfile.TemporaryDirectory()
        self.old_env = os.environ.get("AAS_DATA_DIR")
        os.environ["AAS_DATA_DIR"] = self.d.name             # 시험마다 빈 DB(PostgreSQL 은 AAS_DB_SCHEMA=auto 로 빈 스키마)
        known = {"kim": {"sa", "ma"}}
        office.set_seat({"pod": "kim", "profile": "sa"}, "me", known)
        office.set_seat({"pod": "kim", "profile": "ma", "enabled": False}, "me", known)
        self.open_room = office.set_room({"name": "제안 TFT", "seats": ["sa"], "members": ["kim@x.com"]}, "me")["id"]
        self.closed = office.set_room({"name": "끝난 방", "seats": ["sa"], "status": "closed"}, "me")["id"]
        self.off_room = office.set_room({"name": "꺼진 자리 방", "seats": ["ma"]}, "me")["id"]

    def tearDown(self):
        import os
        if self.old_env is None:
            os.environ.pop("AAS_DATA_DIR", None)
        else:
            os.environ["AAS_DATA_DIR"] = self.old_env
        self.d.cleanup()

    def messages(self, room):
        from aas.office import meeting
        with meeting._db() as conn:
            return [dict(r) for r in conn.execute("SELECT id, role, kind, data, content FROM office_messages WHERE room=? ORDER BY id", (room,))]

    def test_켜진_자리의_열린_방에만_알리고_10분_안의_연속_저장은_하나로_합친다(self):
        import json
        from aas.office import meeting
        self.assertEqual(meeting.notice_soul("kim", "sa", "kim@x.com", 10, 11, "말투를 바꿈"), 1)
        self.assertEqual(meeting.notice_soul("kim", "sa", "kim@x.com", 11, 12), 1)
        msgs = self.messages(self.open_room)
        self.assertEqual(len(msgs), 1)
        data = json.loads(msgs[0]["data"])
        self.assertEqual((msgs[0]["role"], msgs[0]["kind"], data["rev_from"], data["rev_to"], data["pod"], data["profile"]),
                         ("system", "soul_changed", 10, 12, "kim", "sa"))
        self.assertIn("버전 10→12", msgs[0]["content"])                                    # 옛 화면용 대체 문장도 함께 고친다
        self.assertEqual((self.messages(self.closed), self.messages(self.off_room)), ([], []))
        self.assertEqual(meeting.notice_soul("kim", "ma", "kim@x.com", 1, 2), 0)        # 꺼 둔 자리만 있으면 알리지 않는다

    def test_사이에_다른_말이_있으면_합치지_않는다(self):
        from aas.office import meeting
        meeting.notice_soul("kim", "sa", "kim@x.com", 10, 11)
        meeting._append(self.open_room, "user", "kim@x.com", "확인했습니다")
        meeting.notice_soul("kim", "sa", "kim@x.com", 11, 12)
        self.assertEqual([m["kind"] for m in self.messages(self.open_room)], ["soul_changed", "", "soul_changed"])

    def test_동시에_저장해도_알림은_하나다(self):
        import threading
        from aas.office import meeting
        errors = []

        def save(n):
            try:
                meeting.notice_soul("kim", "sa", "kim@x.com", n, n + 1)
            except Exception as exc:                                          # pragma: no cover
                errors.append(exc)
        threads = [threading.Thread(target=save, args=(n,)) for n in range(6)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        self.assertEqual((errors, len(self.messages(self.open_room))), ([], 1))

    def test_잠금을_기다리는_사이_다른_저장이_먼저_남겨도_합친다(self):
        # 위 동시 저장 시험이 CI 에서 가끔 알림 둘로 실패했다. 시각을 잠금 전에 구해, 초 경계에서 먼저 잠금을 잡은
        # 다른 저장(12:00:01)보다 이른 시각(12:00:00.9)으로 비교하면 간격이 음수라 합치지 않았다. 그 순서를 그대로 만든다
        import json
        from datetime import datetime, timedelta, timezone
        from unittest import mock
        from aas.office import meeting
        t0 = datetime(2026, 10, 23, 12, 0, 0, 900000, tzinfo=timezone(timedelta(hours=9)))
        clock = {"now": t0}                                                     # 잠금을 기다리기 시작한 때 12:00:00.9

        class Clock(datetime):
            @classmethod
            def now(cls, tz=None):
                return clock["now"]
        real_lock, other = meeting._lock_room, {"saved": False}

        def lock_after_other_saver(conn, room):
            real_lock(conn, room)
            if not other["saved"]:                                         # 이 저장이 잠금을 기다리는 사이 다른 저장이 먼저 남긴다
                other["saved"] = True
                data = {"alias": "sa", "pod": "kim", "profile": "sa", "who": "kim@x.com", "note": "", "ts": "2026-10-23T12:00:01+09:00",
                        "rev_from": 1, "rev_to": 2}
                conn.execute("INSERT INTO office_messages (room, role, author, content, ts, kind, data) VALUES (?,?,?,?,?,?,?)",
                             (room, "system", "", "SOUL", data["ts"], meeting.NOTICE_KIND, json.dumps(data)))
                clock["now"] = t0 + timedelta(seconds=0.3)                      # 잠금을 잡은 때는 12:00:01.2
        with mock.patch.object(meeting, "datetime", Clock), mock.patch.object(meeting, "_lock_room", lock_after_other_saver):
            meeting.notice_soul("kim", "sa", "kim@x.com", 2, 3)
        rows = self.messages(self.open_room)
        self.assertEqual(len(rows), 1)
        self.assertEqual((json.loads(rows[0]["data"])["rev_from"], json.loads(rows[0]["data"])["rev_to"]), (1, 3))

    def test_패키지_업데이트_알림은_패키지와_판을_적고_합치지_않는다(self):
        import json
        from aas.office import meeting
        meeting.notice_soul("kim", "sa", "kim@x.com", 1, 2)
        meeting.notice_soul("kim", "sa", "kim@x.com", package="free/helper", version="1.3")
        msgs = self.messages(self.open_room)
        self.assertEqual(len(msgs), 2)
        self.assertEqual(json.loads(msgs[1]["data"])["package"], "free/helper")
        self.assertEqual(json.loads(msgs[1]["data"])["package_label"], "공용/helper")        # 화면이 보이는 이름(스펙 2026-10-28-010). 저장은 요청 밖이라 한국어
        from aas.common import i18n                                                                  # 읽을 때 보는 사람의 언어로 다시 정한다(§6-3) — 뒤 작업이 저장해 언어가 없다
        self.addCleanup(i18n.set_lang, i18n.DEFAULT)
        i18n.set_lang("en")
        rows = meeting.Meeting(None).view(self.open_room)["messages"]
        self.assertEqual(rows[1]["data"]["package_label"], "shared/helper")

    def test_PC_가져오기_알림은_앞뒤_어느_쪽과도_합치지_않는다(self):
        """protects=OMAI-1444 DD13·ROV4(source 알림은 앞 알림에 합치지 않고, 뒤이은 저장도 그 알림에 합치지 않음, note 는 비움); fails_when=가져오기 알림이 덮임; no_claim=화면 문장"""
        import json
        from aas.office import meeting
        meeting.notice_soul("kim", "sa", "kim@x.com", 1, 2)
        meeting.notice_soul("kim", "sa", "김", 2, 3, "메모", source="pc_import")
        meeting.notice_soul("kim", "sa", "kim@x.com", 3, 4)
        msgs = self.messages(self.open_room)
        self.assertEqual(len(msgs), 3)
        data = json.loads(msgs[1]["data"])
        self.assertEqual((data["source"], data["note"], data["who"], data["rev_from"], data["rev_to"]), ("pc_import", "", "김", 2, 3))
        self.assertEqual(json.loads(msgs[2]["data"])["rev_from"], 3)
        self.assertIn("PC 에서 가져와", msgs[1]["content"])                              # 옛 화면용 대체 문장도 갈래를 둔다
        self.assertNotIn("source", json.loads(msgs[0]["data"]))

    def test_배달기가_에이전트_패키지_업데이트를_끝내면_알린다(self):
        from aas.market import market_dispatch
        market_dispatch._notice_update({"pod": "kim", "profile": "sa", "who": "kim@x.com", "package": "free/helper", "version": "1.3",
                                        "mode": "update", "kind": "agent"})
        self.assertEqual([m["kind"] for m in self.messages(self.open_room)], ["soul_changed"])

    def test_회의_보기는_알림을_구조로_보낸다(self):
        from aas.office import meeting
        meeting.notice_soul("kim", "sa", "kim@x.com", 3, 4, "메모")
        meeting._append(self.open_room, "user", "kim@x.com", "안녕")
        m = meeting.Meeting(None)                              # 회의 목록 상태가 공유 DB 로 옮겨 내부 값을 직접 채우지 않는다(2026-10-20-017 R4)
        rows = m.view(self.open_room)["messages"]
        self.assertEqual((rows[0]["kind"], rows[0]["data"]["note"]), ("soul_changed", "메모"))
        self.assertNotIn("kind", rows[1])

    def test_알림이_실패해도_저장_응답은_성공이고_실패를_기록한다(self):
        from unittest import mock
        from aas.assets import files
        from aas.common import store
        pod = SimpleNamespace(id="kim")
        saved = files.SavedText("새 내용")
        saved.before = 3
        saved.version = 4
        with mock.patch.object(server.meeting, "notice_soul", side_effect=RuntimeError("db down")):
            out = server._notice_soul(pod, "sa", "kim@x.com", saved, "")
        self.assertEqual(out, {"rooms": 0, "failed": True})
        with store.connect() as conn:
            row = conn.execute("SELECT kind, pod FROM usage WHERE kind='profile_soul_notice_failed'").fetchone()
        self.assertEqual(tuple(row), ("profile_soul_notice_failed", "kim"))
        self.assertEqual(server._notice_soul(pod, "sa", "kim@x.com", saved, ""), {"rooms": 1})

    def test_편집기_위_방_이름은_구성원인_방만_보인다(self):
        pod = SimpleNamespace(id="kim")
        self.assertEqual(server._soul_rooms(pod, "sa", {"email": "kim@x.com"}, False), {"names": ["제안 TFT"], "others": 0})
        self.assertEqual(server._soul_rooms(pod, "sa", {"email": "lee@x.com"}, False), {"names": [], "others": 1})
        self.assertEqual(server._soul_rooms(pod, "sa", None, True), {"names": ["제안 TFT"], "others": 0})


class MarketAgentProfileTest(unittest.TestCase):
    def test_스킬만_넣은_프로파일은_마켓_프로파일이_아니다(self):
        """주인 삭제(T6)는 패키지로 만든 프로파일만. 스킬만 넣은 기록(mode=skills)은 빠진다(2026-10-14-002)."""
        from unittest import mock
        rows = [{"profile": "sa", "package": "free/bot", "kind": "agent", "mode": "skills"},
                {"profile": "newbot", "package": "free/bot", "kind": "agent", "mode": "install"}]
        with mock.patch.object(server.marketplace, "installed", return_value=rows):
            self.assertEqual(server._market_agent(POD, "sa"), "")
            self.assertEqual(server._market_agent(POD, "newbot"), "free/bot")
