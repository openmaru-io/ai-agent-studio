# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""화면에 보이는 에이전트 이름·사람 이름(스펙 2026-10-18-010).

- 오피스 자리 별칭이 설치본 id(aas-agent-…)면 에이전트 화면과 같은 이름(HermesAgent displayName)으로 보인다.
  관리자가 「오피스 이름」으로 지은 별칭은 그대로 둔다. 한 설치본에 자리가 여럿이면 프로파일을 붙인다.
- 채팅·메신저 연결 목록의 프로파일 옆에 그 설치본 주인의 사람 이름, 변경 기록의 「누가」에 사람 이름."""
import unittest

try:
    from tests.test_office_access import A, B, C, KNOWN, AccessBase, Reg
except ImportError:
    from test_office_access import A, B, C, KNOWN, AccessBase, Reg  # noqa: F401

from aas.office import office  # noqa: E402
from aas.ops import changes  # noqa: E402
from aas.web import server  # noqa: E402


class LabelTest(AccessBase):
    def setUp(self):
        super().setUp()
        self._old = office.agent_names_provider
        office.agent_names_provider = lambda: {"yj": "AAS 관리자", "scdf": "시험계정"}
        # yj 는 자리가 둘(sa·ma), scdf 는 하나(scdf-doc → doc)
        self.addCleanup(lambda: setattr(office, "agent_names_provider", self._old))

    def test_자동_별칭은_에이전트_이름으로_바뀌고_설치본에_자리가_여럿이면_프로파일을_붙인다(self):
        with office.connect() as conn:
            conn.execute("UPDATE office_seats SET by='auto' WHERE alias IN ('sa', 'ma', 'doc')")
        labels = office.seat_labels()
        self.assertEqual(labels["doc"], "시험계정")
        self.assertEqual((labels["sa"], labels["ma"]), ("AAS 관리자 · sa", "AAS 관리자 · ma"))

    def test_관리자가_지은_별칭은_그대로_두고_설치본_id_별칭은_바꾼다(self):
        # 시험 준비의 자리는 by='me'(관리자가 만든 것) — 별칭을 지은 것으로 본다
        self.assertEqual(office.seat_labels(), {"sa": "sa", "ma": "ma", "doc": "doc"})
        with office.connect() as conn:
            conn.execute("UPDATE office_seats SET alias='scdf' WHERE alias='doc'")   # 별칭이 설치본 id 와 같다 = 자동 별칭
        self.assertEqual(office.seat_labels()["scdf"], "시험계정")

    def test_에이전트_이름이_없으면_별칭을_그대로_쓴다(self):
        office.agent_names_provider = lambda: {}
        with office.connect() as conn:
            conn.execute("UPDATE office_seats SET by='auto'")
        self.assertEqual(office.seat_labels(), {"sa": "sa", "ma": "ma", "doc": "doc"})

    def test_오피스_자료의_자리와_설치본에_이름이_실린다(self):
        with office.connect() as conn:
            conn.execute("UPDATE office_seats SET by='auto'")
        base = server._office_base(Reg, {"email": A}, True)
        self.assertEqual({s["alias"]: s["label"] for s in base["seats"]}, {"sa": "AAS 관리자 · sa", "ma": "AAS 관리자 · ma"})   # 내 설치본의 자리만 온다
        self.assertEqual({p["id"]: p["name"] for p in base["pods"]}, {"yj": "AAS 관리자"})
        admin = server._office_base(Reg, {"email": "admin@x.com"}, True)
        self.assertEqual({s["alias"]: s["label"] for s in admin["seats"]}["doc"], "시험계정")

    def test_3D_오피스_에이전트에_이름과_설치본_이름이_실린다(self):
        with office.connect() as conn:
            conn.execute("UPDATE office_seats SET by='auto'")
        rows = server._with_agent_names([{"alias": "sa", "pod": "yj"}, {"alias": "doc", "pod": "scdf"}, {"alias": "x", "pod": "none"}])
        self.assertEqual([(r["label"], r["pod_name"]) for r in rows],
                         [("AAS 관리자 · sa", "AAS 관리자"), ("시험계정", "시험계정"), ("x", "")])   # 자리·이름이 없으면 별칭·빈 값

    def test_회의_자료에_참가자와_글쓴이의_이름이_실린다(self):
        from aas.office import meeting
        with office.connect() as conn:
            conn.execute("UPDATE office_seats SET by='auto'")
        view = meeting.Meeting(None).view(self.r1)
        self.assertEqual({p["alias"]: p["label"] for p in view["participants"]}, {"sa": "AAS 관리자 · sa", "doc": "시험계정"})
        self.assertEqual(view["labels"]["doc"], "시험계정")

    def test_회의_경고_글의_앞머리_별칭도_이름으로_보인다(self):
        from aas.office import meeting
        with office.connect() as conn:
            conn.execute("UPDATE office_seats SET by='auto'")
        meeting._append(self.r1, "system", "doc", "doc 에게 보내지 못했습니다 (ChatUnavailable)")
        meeting._append(self.r1, "system", "doc", "다른 글 doc 가 앞에 없다")        # 앞머리가 아니면 그대로
        msgs = meeting.Meeting(None).view(self.r1)["messages"]
        self.assertEqual([m["content"] for m in msgs], ["시험계정 에게 보내지 못했습니다 (ChatUnavailable)", "다른 글 doc 가 앞에 없다"])
        self.assertEqual(msgs[0]["author"], "doc")                       # 글쓴이 값은 그대로(색·묶음 기준)

    def test_회의_자료에_사람_글쓴이의_이름이_실린다(self):
        """스펙 2026-10-20-025: 사람이 쓴 글 아래에 이메일 대신 이름. 이름을 모르면 이메일 앞부분."""
        from aas.office import meeting
        office.person_touch(A, "김에이")
        self.addCleanup(OwnerNameTest._forget, A)
        meeting._append(self.r1, "user", A, "안녕")
        meeting._append(self.r1, "user", B, "반가워")
        view = meeting.Meeting(None).view(self.r1)
        self.assertEqual((view["labels"][A], view["labels"][B]), ("김에이", B.split("@")[0]))
        self.assertEqual([m["author"] for m in view["messages"]], [A, B])   # 글쓴이 값은 그대로

    def test_회의_자료의_올린_사람과_에이전트는_사람_이름과_주인_에이전트_이름이다(self):
        """스펙 2026-10-20-025 §6: 사람은 이름(모르면 이메일 앞부분), 에이전트 자리는 「주인 · 에이전트 이름」(설치본에 자리가 여럿이면 프로파일)."""
        old = office.agent_labels_provider
        office.agent_labels_provider = lambda: {"yj": "김에이 · AAS 관리자", "scdf": "시험계정"}
        self.addCleanup(lambda: setattr(office, "agent_labels_provider", old))
        office.person_touch(A, "김에이")
        self.addCleanup(OwnerNameTest._forget, A)
        self.assertEqual(office.who_labels([A, B, "sa", "doc", "local", "모르는별칭", ""]),
                         {A: "김에이", B: "b", "sa": "김에이 · AAS 관리자 · sa", "doc": "시험계정"})   # 바뀌지 않는 값은 빠진다


class OwnerNameTest(AccessBase):
    def test_변경_기록의_누가는_사람_이름도_함께_준다(self):
        office.person_touch("kim@x.com", "김철수")
        rows = server._with_who_names([{"who": "kim@x.com", "kind": "x"}, {"who": "", "actor": "aas"}, {"who": "local"}, {"who": "lee@x.com"}])
        self.assertEqual([r.get("who_name") for r in rows], ["김철수", None, None, "lee"])   # 이름을 모르면 이메일 앞부분
        self.assertEqual(rows[0]["who"], "kim@x.com")                                         # 이메일은 그대로(풍선말·검색)

    def test_주인_이름은_이메일이_있는_설치본만_준다(self):
        office.person_touch("kim@x.com", "김철수")
        self.assertEqual(server._pod_owner_name(type("P", (), {"owner": "kim@x.com"})()), "김철수")
        self.assertEqual(server._pod_owner_name(type("P", (), {"owner": "*"})()), "")
        self.assertEqual(server._pod_owner_name(type("P", (), {"owner": ""})()), "")

    def test_사용자_화면의_설치본_목록에_에이전트_이름이_실린다(self):
        old = office.agent_names_provider
        office.agent_names_provider = lambda: {"yj": "AAS 관리자"}
        self.addCleanup(lambda: setattr(office, "agent_names_provider", old))
        rows = {r["id"]: r for r in server._pod_rows(Reg)}
        self.assertEqual((rows["yj"]["name"], rows["scdf"]["name"]), ("AAS 관리자", ""))     # 이름을 짓지 않았으면 빈 값(화면이 id 를 쓴다)
        self.assertEqual(rows["yj"]["owner"], A)

    def test_내_정보의_pod_에도_에이전트_이름이_실린다(self):
        old = office.agent_names_provider
        office.agent_names_provider = lambda: {"yj": "AAS 관리자"}
        self.addCleanup(lambda: setattr(office, "agent_names_provider", old))
        yj, scdf = Reg.pods
        self.assertEqual(server._pod_public(yj), {"id": "yj", "owner": A, "name": "AAS 관리자", "owner_name": "a"})   # 주인 이름(2026-10-19-003), 모르면 이메일 앞부분
        self.assertEqual(server._pod_public(scdf)["name"], "")          # 이름을 짓지 않았으면 빈 값(화면이 id 를 쓴다)
        self.assertIsNone(server._pod_public(None))

    @staticmethod
    def _forget(email):
        with office.connect() as conn:
            conn.execute("DELETE FROM office_people WHERE email=?", (email,))

    def test_주인이_없는_설치본은_주인_이름이_빈_값이다(self):
        """스펙 2026-10-19-003: 화면은 주인 이름이 없으면 에이전트 이름만 보인다. 로컬 모드 주인 「*」를 사람 이름으로 만들지 않는다."""
        office.person_touch(A, "김에이")
        self.addCleanup(self._forget, A)
        P = type("P", (), {"id": "x", "owner": "*"})
        self.assertEqual(server._pod_label(P(), {"x": "기본"}), {"name": "기본", "owner_name": ""})
        self.assertEqual(server._pod_label(Reg.pods[0], {})["owner_name"], "김에이")


class ChangeLabelTest(unittest.TestCase):
    """스펙 2026-10-19-003: 변경 기록이 「주인 · 에이전트 이름」을 그릴 값을 주고, 대상 글 안의 설치본 id 를 뺀다."""

    def tearDown(self):
        from aas.common import store
        with store.connect() as conn:
            conn.execute("DELETE FROM usage WHERE pod IN ('lab-a', 'lab-b')")

    def test_대상_글에서_설치본_id_를_빼고_에이전트_이름을_준다(self):
        from types import SimpleNamespace
        from aas.common import store
        from aas.fleet import pods
        store.log_usage("market_install", "kim@x.com ns/pkg@1.0 → lab-a/main", pod="lab-a")
        store.log_usage("profile_soul_identity", "kim@x.com lab-a/main", pod="lab-a")
        store.log_usage("profile_soul", "kim@x.com lab-a 옛 글", pod="lab-a")              # id 를 적지 않는 종류는 손대지 않는다
        store.log_usage("market_grant", "kim@x.com lab-b team → 허용", pod="lab-b")
        old = office.agent_names_provider
        office.agent_names_provider = lambda: {"lab-a": "운영 도우미"}
        self.addCleanup(lambda: setattr(office, "agent_names_provider", old))
        reg = SimpleNamespace(pods=[pods.Pod("lab-a", "kim@x.com", "/tmp"), pods.Pod("lab-b", "*", "/tmp")])
        rows = [r for r in server._with_owners(changes.rows(30), reg) if r.get("pod") in ("lab-a", "lab-b")]
        self.assertEqual(sorted(r["detail"] for r in rows), ["lab-a 옛 글", "main", "ns/pkg@1.0 → main", "team → 허용"])
        a = next(r for r in rows if r["pod"] == "lab-a")
        b = next(r for r in rows if r["pod"] == "lab-b")
        self.assertEqual((a["pod_name"], a["owner_name"]), ("운영 도우미", "kim"))
        self.assertEqual((b["pod_name"], b["owner_name"]), ("", ""))            # 이름이 없으면 화면이 id 를 쓴다


    def test_마켓_기록의_slug_를_읽을_때_표시_이름으로(self):
        """스펙 2026-10-28-010 D10: 저장은 slug(free·paid), 읽을 때 표시 이름(shared·restricted). 다른 낱말·패키지 이름·프로파일 이름은 그대로."""
        from aas.common import store
        store.log_usage("market_install", "kim@x.com free/x@1 → lab-a/ma", pod="lab-a")
        store.log_usage("market_install", "kim@x.com freebie/x@1 → lab-a/free", pod="lab-a")          # 다른 낱말, 프로파일 이름 free
        store.log_usage("market_install_failed", "kim@x.com free-tier/y@1 → lab-a/ma", pod="lab-a")
        store.log_usage("market_remove", "kim@x.com community/free ← lab-a/ma req=r1", pod="lab-a")    # 패키지 이름 free
        store.log_usage("market_grant", "kim@x.com lab-b paid → 허용", pod="lab-b")
        store.log_usage("profile_soul", "kim@x.com free 를 적은 글", pod="lab-b")                        # 마켓 기록이 아니면 손대지 않는다
        got = sorted(r["detail"] for r in changes.rows(30) if r.get("pod") in ("lab-a", "lab-b"))      # 한국어(기본) 화면: 공용·제한(§6-3)
        self.assertEqual(got, sorted(["공용/x@1 → ma", "freebie/x@1 → free", "free-tier/y@1 → ma", "community/free ← ma",
                                      "제한 → 허용", "free 를 적은 글"]))
        from aas.common import i18n
        self.addCleanup(i18n.set_lang, i18n.DEFAULT)
        i18n.set_lang("en")
        got = sorted(r["detail"] for r in changes.rows(30) if r.get("pod") in ("lab-a", "lab-b"))
        self.assertEqual(got, sorted(["shared/x@1 → ma", "freebie/x@1 → free", "free-tier/y@1 → ma", "community/free ← ma",
                                      "restricted → 허용", "free 를 적은 글"]))


class ServerSentenceTest(AccessBase):
    """스펙 2026-10-19-003: 서버 문장·받은편지함이 설치본 id 대신 이름을 쓴다."""

    def setUp(self):
        super().setUp()
        old_n, old_l = office.agent_names_provider, office.agent_labels_provider
        office.agent_names_provider = lambda: {"yj": "AAS 관리자"}
        self.addCleanup(lambda: (setattr(office, "agent_names_provider", old_n), setattr(office, "agent_labels_provider", old_l)))

    def test_서버_글자는_주인_이름_에이전트_이름_순이고_없으면_줄인다(self):
        from unittest import mock
        office.person_touch(A, "김에이")
        self.addCleanup(OwnerNameTest._forget, A)
        with mock.patch.object(server, "registry", return_value=Reg):
            self.assertEqual(server._agent_labels(), {"yj": "김에이 · AAS 관리자", "scdf": "b · scdf"})   # B 는 이름을 모르는 사람: 이메일 앞부분

    def test_자리_이름이_겹치면_다른_에이전트를_이름으로_알린다(self):
        office.agent_labels_provider = lambda: {"yj": "김에이 · AAS 관리자"}
        with self.assertRaises(office.OfficeError) as e:
            office.set_seat({"pod": "scdf", "profile": "scdf-doc", "alias": "sa"}, "me", KNOWN)
        self.assertIn("김에이 · AAS 관리자 의 ", str(e.exception))
        self.assertNotIn("yj", str(e.exception))

    def test_받은편지함_항목에_보일_이름이_붙고_별칭은_그대로다(self):
        from unittest import mock
        with office.connect() as conn:
            conn.execute("UPDATE office_seats SET alias='scdf', by='auto' WHERE alias='doc'")       # 자동 별칭 = 설치본 id
        office.agent_names_provider = lambda: {"scdf": "시험계정"}
        item = {"id": "q1", "kind": "approval", "alias": "scdf", "text": "rm?"}
        reg = mock.Mock(pods=[], is_admin=lambda u: False)
        with mock.patch.object(server.INBOX, "for_person", return_value=[item]):
            got = next(i for i in server._office_inbox(reg, {"email": A})["items"] if i["id"] == "q1")
        self.assertEqual((got["alias"], got["label"]), ("scdf", "시험계정"))
        self.assertNotIn("label", item)                                                       # 저장된 항목은 바꾸지 않는다


if __name__ == "__main__":
    unittest.main()
