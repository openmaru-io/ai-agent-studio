# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""회사 역할별 SOUL 템플릿(계획 2026-10-13-009)."""
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import settings, soul_templates as st, store  # noqa: E402
from aas.fleet import identity  # noqa: E402
from aas.office import office  # noqa: E402
from aas.web import server  # noqa: E402

# 옆 레포(hermes-agent)가 있는 개발 장비에서만 대조한다. CI 컨테이너(/src/tests)에는 위로 세 단계 폴더가 없다
_UP = Path(__file__).resolve().parents
HERMES_SOUL = (_UP[3] if len(_UP) > 3 else _UP[-1]) / "hermes-agent" / "hermes_cli" / "default_soul.py"


def clear():
    with st._connect() as conn:
        for t in ("soul_templates", "soul_template_versions", "soul_template_uses"):
            conn.execute(f"DELETE FROM {t}")
    with store.connect() as conn:
        conn.execute("DELETE FROM meta WHERE key IN ('company_name', 'company_by', 'identity_history')")
        conn.execute(settings._SCHEMA)
        conn.execute("DELETE FROM user_directory")
    settings.reset_cache()                                   # 부서 조회는 서버 캐시를 거친다 — DB 를 직접 지웠으면 비운다
    with office.connect() as conn:
        conn.execute("DELETE FROM office_seats")


class Base(unittest.TestCase):
    def setUp(self):
        clear()

    tearDown = staticmethod(clear)


class BuiltinTest(Base):
    def test_기본_템플릿_10개가_두_언어로_있고_회사_문장으로_시작하지_않는다(self):
        items = st.templates()
        self.assertEqual(len(items), 20)
        self.assertEqual({(t["id"], t["lang"]) for t in items}, {(c[0], lang) for c in st.CATALOG for lang in st.LANGS})
        for t in items:
            self.assertTrue(t["body"].startswith("## "), t["id"])                  # 결정 D1: 「## 역할」부터
            self.assertNotIn("AAS Agent, built by", t["body"])
            self.assertFalse(st.files.has_secrets(t["body"]))

    def test_id_와_lang_이_키다(self):
        st.save({"id": "marketing", "lang": "ko", "name": "마케팅", "body": "## 역할\n고침\n", "keywords": "마케팅"}, "a@x.com")
        self.assertEqual(st.get("marketing", "ko")["body"], "## 역할\n고침\n")
        self.assertNotEqual(st.get("marketing", "en")["body"], "## 역할\n고침\n")      # 영어 판은 그대로
        self.assertTrue(st.get("marketing", "ko")["modified"])


class SaveTest(Base):
    def test_저장할_때마다_판이_남고_이전_판으로_되돌린다(self):
        a = st.save({"lang": "ko", "name": "보안", "body": "## 역할\n판1\n"}, "a@x.com")
        self.assertTrue(a["id"].startswith("u_"))
        b = st.save({"id": a["id"], "lang": "ko", "name": "보안", "body": "## 역할\n판2\n", "base_rev": 1}, "a@x.com")
        self.assertEqual(b["rev"], 2)
        self.assertEqual([v["rev"] for v in st.versions(a["id"], "ko")], [2, 1])
        c = st.revert(a["id"], "ko", 1, "b@x.com")
        self.assertEqual((c["rev"], c["body"]), (3, "## 역할\n판1\n"))

    def test_그사이_다른_사람이_고쳤으면_409(self):
        a = st.save({"lang": "ko", "name": "보안", "body": "## 역할\n판1\n"}, "a@x.com")
        st.save({"id": a["id"], "lang": "ko", "name": "보안", "body": "## 역할\n판2\n"}, "b@x.com")
        with self.assertRaises(st.TemplateError) as cm:
            st.save({"id": a["id"], "lang": "ko", "name": "보안", "body": "## 역할\n판3\n", "base_rev": 1}, "a@x.com")
        self.assertEqual(cm.exception.code, 409)

    def test_비밀값이_든_템플릿은_저장하지_않는다(self):
        with self.assertRaises(st.TemplateError) as cm:
            st.save({"lang": "ko", "name": "x", "body": 'api_key: "sk-abcdefghijklmnopqrstuvwxyz"\n'}, "a@x.com")
        self.assertEqual(cm.exception.code, 422)

    def test_지운_기본_템플릿을_처음으로_되돌린다(self):
        st.save({"id": "hr", "lang": "ko", "name": "인사", "body": "## 역할\n고침\n"}, "a@x.com")
        st.delete("hr", "ko", "a@x.com")
        self.assertIsNone(st.get("hr", "ko"))
        self.assertTrue(st.get("hr", "ko", include_deleted=True)["deleted"])
        st.reset("hr", "ko")
        self.assertEqual(st.get("hr", "ko")["body"], st.builtin("hr", "ko")["body"])
        self.assertEqual(st.versions("hr", "ko")[-1]["rev"], 0)                       # 고친 판은 남고 처음 내용(판 0)이 맨 끝
        self.assertEqual(st.save({"id": "hr", "lang": "ko", "name": "인사", "body": "## 역할\n다시\n"}, "a@x.com")["rev"], 2)   # 판 번호를 다시 쓰지 않는다

    def test_사용자_템플릿은_처음으로_되돌릴_수_없다(self):
        a = st.save({"lang": "en", "name": "Security", "body": "## Role\nx\n"}, "a@x.com")
        with self.assertRaises(st.TemplateError):
            st.reset(a["id"], "en")


class RenderTest(Base):
    def test_첫_줄은_지금_회사_문장이고_자리_표시를_채운다(self):
        settings.set_company_name("오픈마루", "a@x.com")
        out = st.render(st.get("marketing", "ko"), {"department": "마케팅팀", "agent": "kim"})
        first, _, rest = out.partition("\n\n")
        self.assertEqual(first, "You are CogentAI AAS Agent, built by 오픈마루.")
        self.assertIn("오픈마루 마케팅팀 소속 마케팅 담당 에이전트이고, 오피스 이름은 kim다.", rest)
        self.assertEqual(identity.rewrite(out, settings.identity_sentence(), settings.identity_history()), None)   # 008 첫 문장 맞추기와 겹치지 않는다

    def test_모르는_자리_표시는_그대로_두고_빈_부서는_공백을_남기지_않는다(self):
        out = st.fill("{company} {department} 소속 {unknown} {agent}", {"company": "A", "department": "", "agent": "k"})
        self.assertEqual(out, "A 소속 {unknown} k")

    def test_프로파일_미리_보기는_보는_사람이_아니라_POD_주인의_부서다(self):
        settings.set_department("owner@x.com", "영업팀")
        settings.set_department("admin@x.com", "경영지원팀")
        office.set_seat({"pod": "p1", "profile": "default", "alias": "lee"}, "admin", {"p1": {"default"}})
        pod = SimpleNamespace(id="p1", owner="owner@x.com")
        self.assertEqual(server._soul_template_values(pod, "default", {"email": "admin@x.com"}), {"department": "영업팀", "agent": "lee"})
        self.assertEqual(server._soul_template_values(None, "", {"email": "admin@x.com"}), {"department": "경영지원팀"})


class RecommendTest(Base):
    def test_가장_긴_키워드가_맞은_템플릿이고_동률이면_목록_순이다(self):
        self.assertEqual(st.recommend("마케팅팀", lang="ko")["id"], "marketing")
        self.assertEqual(st.recommend("마케팅·세일즈팀", lang="ko")["id"], "marketing")     # 「마케팅」「세일즈」 둘 다 세 글자 — 목록 순
        self.assertEqual(st.recommend("고객기술지원팀", lang="ko")["id"], "support")        # 「기술지원」(4)이 「기술」(2)보다 길다
        self.assertIsNone(st.recommend("", lang="ko"))
        self.assertIsNone(st.recommend("우주선", lang="ko"))


class DefaultSoulTest(Base):
    def test_Hermes_기본_문단_사본이_원본과_같다(self):
        if not HERMES_SOUL.is_file():
            self.skipTest("hermes-agent 원본이 옆에 없다")
        ns = {}
        exec(compile(HERMES_SOUL.read_text(encoding="utf-8"), str(HERMES_SOUL), "exec"), ns)
        self.assertEqual(ns["DEFAULT_SOUL_MD"], identity.HERMES_DEFAULT + " " + st.HERMES_DEFAULT_REST)

    def test_첫_문장을_회사_문장으로_바꾼_기본_문단도_기본으로_본다(self):
        rest = " " + st.HERMES_DEFAULT_REST
        self.assertTrue(st.is_default_soul(identity.HERMES_DEFAULT + rest))
        self.assertTrue(st.is_default_soul(settings.identity_sentence() + rest))
        self.assertTrue(st.is_default_soul(""))
        self.assertFalse(st.is_default_soul(settings.identity_sentence() + rest + "\n추가 규칙"))
        self.assertFalse(st.is_default_soul("You are Kim's helper."))


class UseTest(Base):
    def test_적용한_판보다_템플릿이_바뀌면_다시_적용_안내(self):
        st.record_use("p1", "default", "sales", "ko", 0, "a@x.com")
        self.assertFalse(st.use_of("p1", "default")["changed"])
        st.save({"id": "sales", "lang": "ko", "name": "세일즈", "body": "## 역할\n고침\n"}, "a@x.com")
        use = st.use_of("p1", "default")
        self.assertTrue(use["changed"])
        self.assertEqual((use["rev"], use["current_rev"], use["name"]), (0, 1, "세일즈"))

    def test_기본_SOUL_뿐이면_주인의_부서로_추천한다(self):
        hint = st.profile_hint("p1", "default", identity.HERMES_DEFAULT + " " + st.HERMES_DEFAULT_REST, "인사팀")
        self.assertEqual(hint["recommend"]["id"], "hr")
        self.assertIsNone(st.profile_hint("p1", "default", "사람이 쓴 SOUL", "인사팀")["recommend"])


class ApiTest(Base):
    def call(self, body, admin):
        out = {}
        h = SimpleNamespace(_json=lambda data, code=200: out.update(data=data, code=code))
        reg = SimpleNamespace(is_admin=lambda u: admin)
        orig = server.registry
        server.registry = lambda: reg
        try:
            server.Handler._soul_templates_post(h, "/api/soul-templates", body, SimpleNamespace(enabled=True), {"email": "u@x.com"}, None)
        finally:
            server.registry = orig
        return out

    def test_관리자가_아니면_403(self):
        self.assertEqual(self.call({"op": "save", "lang": "ko", "name": "x", "body": "## 역할\n"}, False)["code"], 403)

    def test_관리자는_만들고_변경_기록을_남긴다(self):
        out = self.call({"op": "save", "lang": "ko", "name": "보안", "body": "## 역할\n보안\n"}, True)
        self.assertEqual(out["code"], 200)
        with store.connect() as conn:
            kinds = [r["kind"] for r in conn.execute("SELECT kind FROM usage WHERE kind LIKE 'soul_template_%'")]
        self.assertIn("soul_template_create", kinds)


if __name__ == "__main__":
    unittest.main()
