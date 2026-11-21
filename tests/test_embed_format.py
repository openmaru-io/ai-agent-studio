# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""위젯 답 저장 경로(스펙 security/chat-embed-save-answer 2026-11-18-012 D5·D6·D7·D16·D17·D20·D22·D24·D25).

실제 uvicorn 앱에 붙는다. 서버 띄우기·토큰 교환은 test_embed_auth.EmbedHttpTest 의 것을 그대로 쓴다(모듈 이름으로만 불러 그 시험이 여기서 다시 돌지 않게). 모델은 대역이다.
"""
import http.client
import json
import threading
import unittest
from unittest import mock

import test_embed_auth as ea

from test_embed_auth import ALICE, BOSS, KC_APP, KC_ORIGIN, PORTAL_ORIGIN

from aas.auth import embed, mcp_limits
from aas.common import store
from aas.ops import answer_format as af
from aas.web import embed_format as ef

SCHEMA = {"type": "object", "properties": {"title": {"type": "string", "title": "제목", "maxLength": 80},
                                           "category": {"title": "분류", "enum": ["질문", "공지"]}},
          "required": ["title", "category"], "additionalProperties": False}
LABEL = {"ko": "게시판에 저장", "en": "Save to board"}
GOOD = json.dumps({"title": "디스크 정리", "category": "질문"}, ensure_ascii=False)
FILL = "/api/chat/answer-format/fill?pod=em-a"


def _cleanup():
    ea._cleanup_db()
    with embed._conn() as conn:
        conn.execute("DELETE FROM embed_formats")
    with mcp_limits._conn() as conn:
        conn.execute("DELETE FROM mcp_rate WHERE user_email LIKE 'fmt%'")


class Base(unittest.TestCase):
    setUpClass = classmethod(ea.EmbedHttpTest.setUpClass.__func__)
    tearDownClass = classmethod(ea.EmbedHttpTest.tearDownClass.__func__)
    req, login, kc_token, exchange, embed_token = (ea.EmbedHttpTest.req, ea.EmbedHttpTest.login, ea.EmbedHttpTest.kc_token,
                                                   ea.EmbedHttpTest.exchange, ea.EmbedHttpTest.embed_token)

    def setUp(self):
        ea.EmbedHttpTest.setUp(self)
        _cleanup()
        embed.add_app("COP", [KC_ORIGIN], "keycloak", app_id=KC_APP, issuer=ea.ISSUER, jwks_url=ea.JWKS_URL, audience=ea.AUD)
        embed.add_app("Portal", [PORTAL_ORIGIN], "host-signed", app_id=ea.HOST_APP, public_jwk=json.dumps(self.host_key.jwk()))
        self.addCleanup(_cleanup)
        embed.save_format(KC_APP, "board-post", LABEL, SCHEMA, "제목은 한 줄", create=True)
        self.token = self.embed_token()
        self.ask = mock.Mock(return_value=GOOD)
        p = mock.patch.object(af, "_ask_llm", side_effect=lambda msgs, left: self.ask(msgs, left))
        p.start()
        self.addCleanup(p.stop)

    def fill(self, body=None, token=None, path=FILL, origin=KC_ORIGIN):
        b = {"profile": "main", "markdown": "디스크가 찼습니다. 로그를 지우세요.", "markdownLength": 20, "format": "board-post"}
        b.update(body or {})
        return self.req("POST", path, {k: v for k, v in b.items() if v is not None}, origin, token or self.token)

    def notes(self, kind):
        with store.connect() as conn:
            return [r["note"] for r in conn.execute("SELECT note FROM usage WHERE kind=? ORDER BY ts", (kind,))]


class FillTest(Base):
    def test_registered_format_fills_and_returns_version_hash_and_request_id(self):
        r, out = self.fill({"question": "디스크가 찼어요", "context": {"title": "작업 #7", "selection": "고른 글"}})
        self.assertEqual(r.status, 200, out)
        self.assertEqual(out["payload"], {"title": "디스크 정리", "category": "질문"})
        self.assertEqual((out["format"], out["version"], out["source"], out["errors"]), ("board-post", 1, "registered", []))
        self.assertEqual(out["schemaHash"], af.schema_hash(SCHEMA))
        self.assertTrue(out["filledAt"].endswith("Z"))
        self.assertEqual(r.getheader("Access-Control-Allow-Origin"), KC_ORIGIN)
        msgs = self.ask.call_args[0][0]
        self.assertIn("제목은 한 줄", msgs[0]["content"])                    # 등록 형식의 채우는 법은 system
        self.assertIn("[Question]\n디스크가 찼어요", msgs[-1]["content"])
        self.assertNotIn("고른 글", msgs[-1]["content"])
        note = self.notes("embed_format_fill")[-1]
        self.assertTrue(note.startswith(f"app={KC_APP.lower()} format=board-post source=registered chars=20 code=ok req={out['requestId']}"), note)
        self.assertNotIn("디스크", note)                                     # 본문을 남기지 않는다

    def test_main_screen_cookie_and_no_token_are_403_not_embed(self):
        cookie = self.login(ALICE)
        r, out = self.req("POST", FILL, {"profile": "main", "markdown": "x", "format": "board-post"},
                          headers={"Cookie": cookie, "X-AAS": "1"})
        self.assertEqual((r.status, out["code"], out["detail"]["reason"]), (403, "format.forbidden", "not_embed"))
        self.ask.assert_not_called()

    def test_other_app_format_and_page_schema_off_and_both(self):
        embed.save_format(ea.HOST_APP, "portal-only", LABEL, SCHEMA, create=True)
        r, out = self.fill({"format": "portal-only"})
        self.assertEqual((r.status, out["code"]), (404, "format.not_found"))
        r, out = self.fill({"format": None, "schema": SCHEMA})
        self.assertEqual((r.status, out["code"]), (403, "format.page_schema_off"))
        r, out = self.fill({"schema": SCHEMA})
        self.assertEqual((r.status, out["code"]), (400, "format.bad_request"))
        embed.set_page_schema(KC_APP, True)
        r, out = self.fill({"format": None, "schema": SCHEMA, "instructions": "페이지 지시"})
        self.assertEqual((r.status, out["source"], out["version"]), (200, "page", None), out)
        self.assertIn("페이지 지시", self.ask.call_args[0][0][-1]["content"])  # 페이지 글은 user 메시지(가드레일 검사)
        r, out = self.fill({"format": None, "schema": {"type": "object", "properties": {"a": {"type": "string", "pattern": "x"}}}})
        self.assertEqual((r.status, out["code"], out["errors"][0]["path"]), (400, "format.schema_invalid", "/properties/a/pattern"))

    def test_pod_and_profile_are_checked_like_chat(self):
        r, out = self.fill(path="/api/chat/answer-format/fill?pod=em-b")         # Bob 의 작업공간
        self.assertEqual((r.status, out["detail"]["reason"]), (403, "pod"))
        r, out = self.fill({"profile": "nobody"})
        self.assertEqual((r.status, out["detail"]["reason"]), (403, "profile"))
        r, out = self.fill({"markdown": "  \n"})
        self.assertEqual((r.status, out["code"]), (400, "format.bad_request"))

    def test_rejections_do_not_use_the_limit_and_the_sixth_fill_is_429(self):
        for _ in range(6):
            r, _out = self.fill({"format": "nope"})
            self.assertEqual(r.status, 404)
        for i in range(5):
            r, out = self.fill()
            self.assertEqual(r.status, 200, (i, out))
        r, out = self.fill()
        self.assertEqual((r.status, out["code"]), (429, "format.rate_limited"))
        self.assertTrue(1 <= out["retry_after"] <= 60)
        self.assertEqual(r.getheader("Retry-After"), str(out["retry_after"]))
        self.assertEqual(self.ask.call_count, 5)

    def test_body_over_256kb_is_413_with_and_without_content_length(self):
        r, out = self.fill({"markdown": "가" * 100_000})                    # 300KB 쯤
        self.assertEqual((r.status, out["code"]), (413, "format.too_large"))
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        chunk = json.dumps({"profile": "main", "format": "board-post", "markdown": "x" * 300_000}).encode()
        c.request("POST", FILL, body=iter([chunk[:100_000], chunk[100_000:]]), encode_chunked=True,
                  headers={"Origin": KC_ORIGIN, "Authorization": f"Bearer {self.token}", "Content-Type": "application/json"})
        r = c.getresponse()
        out = json.loads(r.read())
        c.close()
        self.assertEqual((r.status, out["code"]), (413, "format.too_large"))
        self.ask.assert_not_called()

    def test_llm_failures_map_to_codes_and_are_logged(self):
        self.ask.side_effect = ["?", "??"]
        r, out = self.fill()
        self.assertEqual((r.status, out["code"]), (502, "format.fill_llm"))
        self.assertIn("code=format.fill_llm", self.notes("embed_format_fill")[-1])
        self.ask.side_effect = [json.dumps({"title": "x", "category": "기타"})] * 2
        r, out = self.fill()
        self.assertEqual((r.status, [e["path"] for e in out["errors"]]), (200, ["/category"]))
        self.assertIn("code=ok_with_errors", self.notes("embed_format_fill")[-1])

    def test_busy_when_slots_are_taken_and_the_slot_is_held_until_the_thread_ends(self):
        gate, entered = threading.Event(), threading.Event()

        def slow(msgs, left):
            entered.set()
            gate.wait(10)
            return GOOD
        self.ask.side_effect = slow
        slots = threading.BoundedSemaphore(1)
        with mock.patch.object(ef, "_slots", slots), mock.patch.object(ef, "_thread_limiter", ef.anyio.CapacityLimiter(1)):
            done = {}
            t = threading.Thread(target=lambda: done.update(r=self.fill()))
            t.start()
            self.assertTrue(entered.wait(5))
            r, out = self.fill()
            self.assertEqual((r.status, out["code"]), (429, "format.busy"))
            gate.set()
            t.join(10)
            self.assertEqual(done["r"][0].status, 200)
            self.assertTrue(slots.acquire(blocking=False))               # 자리가 돌아왔다
            slots.release()

    def test_deleted_app_does_not_revive_formats(self):
        embed.remove_app(KC_APP)
        embed.add_app("COP", [KC_ORIGIN], "keycloak", app_id=KC_APP, issuer=ea.ISSUER, jwks_url=ea.JWKS_URL, audience=ea.AUD)
        token = self.embed_token()
        r, out = self.req("GET", "/api/chat/answer-format/info?format=board-post", None, KC_ORIGIN, token)
        self.assertEqual((r.status, out["code"]), (404, "format.not_found"))
        f = embed.save_format(KC_APP, "board-post", LABEL, SCHEMA, create=True)
        self.assertEqual(f["version"], 2)                                  # 다시 등록할 때 판이 이어진다


class InfoOutcomeTest(Base):
    def test_info_and_page_schema(self):
        r, out = self.req("GET", "/api/chat/answer-format/info?format=board-post", None, KC_ORIGIN, self.token)
        self.assertEqual((r.status, out["label"], out["version"], out["schemaHash"]), (200, LABEL, 1, af.schema_hash(SCHEMA)))
        r, out = self.req("GET", "/api/chat/answer-format/info?pageSchema=1", None, KC_ORIGIN, self.token)
        self.assertEqual(out["page_schema"], False)
        r, out = self.req("GET", "/api/chat/answer-format/info?format=nope", None, KC_ORIGIN, self.token)
        self.assertEqual((r.status, out["code"]), (404, "format.not_found"))
        self.assertEqual(r.getheader("Access-Control-Allow-Origin"), KC_ORIGIN)   # 오류에도 CORS — 위젯이 코드를 읽는다

    def test_outcome_values_are_checked_and_logged_without_content(self):
        path = "/api/chat/answer-format/outcome?pod=em-a"
        before = len(self.notes("embed_format_outcome"))
        r, out = self.req("POST", path, {"format": "board-post", "source": "registered", "outcome": "saved", "edited": 2}, KC_ORIGIN, self.token)
        self.assertEqual(r.status, 200, out)
        self.assertEqual(self.notes("embed_format_outcome")[-1].split(" role=")[0],
                         f"app={KC_APP.lower()} format=board-post source=registered outcome=saved edited=2")
        for bad in ({"format": "x code=ok edited=999", "source": "registered", "outcome": "saved", "edited": 1},
                    {"format": "board-post\n", "source": "registered", "outcome": "saved", "edited": 1},
                    {"format": "board-post", "source": "registered", "outcome": "done", "edited": 1},
                    {"format": "board-post", "source": "registered", "outcome": "saved", "edited": -1},
                    {"format": "board-post", "source": "registered", "outcome": "saved", "edited": True},
                    {"format": "page", "source": "page", "outcome": "saved", "edited": 0}):
            with self.subTest(bad=bad):
                r, out = self.req("POST", path, bad, KC_ORIGIN, self.token)
                self.assertEqual((r.status, out["code"]), (400, "format.bad_request"))
        self.assertEqual(len(self.notes("embed_format_outcome")), before + 1)


class TypesFileTest(Base):
    def test_types_file_is_served_as_text_without_login(self):
        import tempfile
        from pathlib import Path

        from aas.web import server
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "js").mkdir()
            (Path(d) / "js" / "aas-widget.d.ts").write_text("declare var CogentAIAASWidget: unknown;\n")
            with mock.patch.object(server, "STATIC_DIR", Path(d)):
                r, body = self.req("GET", "/static/js/aas-widget.d.ts")
        self.assertEqual(r.status, 200)
        self.assertTrue(r.getheader("Content-Type").startswith("text/plain"))
        self.assertIn(b"CogentAIAASWidget", body)


class AdminTest(Base):
    def setUp(self):
        super().setUp()
        self.boss, self.alice = self.login(BOSS), self.login(ALICE)
        self.base = f"/api/admin/embed-apps/{KC_APP}"

    def api(self, method, path, body=None, cookie=None):
        return self.req(method, self.base + path, body, headers={"Cookie": cookie or self.boss, "X-AAS": "1"})

    def test_only_admins_and_not_embed_tokens(self):
        r, out = self.api("GET", "/formats", cookie=self.alice)
        self.assertEqual((r.status, out["code"]), (403, "format.admin_only"))
        r, out = self.req("GET", self.base + "/formats", None, KC_ORIGIN, self.token)
        self.assertEqual((r.status, out["error"]), (401, "path_not_allowed"))
        r, _ = self.req("POST", self.base + "/formats", {"id": "x"}, headers={"Cookie": self.boss})       # X-AAS 없음
        self.assertEqual(r.status, 403)

    def test_create_update_version_and_delete(self):
        r, out = self.api("GET", "/formats")
        self.assertEqual((r.status, [f["id"] for f in out["formats"]], out["page_schema"]), (200, ["board-post"], False), out)
        r, out = self.api("POST", "/formats", {"id": "work-log", "label": LABEL, "schema": SCHEMA})
        self.assertEqual((r.status, out["version"]), (200, 1), out)
        r, out = self.api("POST", "/formats", {"id": "work-log", "label": LABEL, "schema": SCHEMA})
        self.assertEqual((r.status, out["code"]), (409, "format.id_exists"))
        for fid, code in (("Bad_ID", "format.id_invalid"), ("page", "format.id_reserved"), ("none", "format.id_reserved")):
            r, out = self.api("POST", "/formats", {"id": fid, "label": LABEL, "schema": SCHEMA})
            self.assertEqual((r.status, out["code"]), (400, code))
        r, out = self.api("PUT", "/formats/work-log", {"label": {"ko": "다른 이름", "en": "Other"}, "schema": SCHEMA})
        self.assertEqual(out["version"], 1)                                # 이름만 바꾸면 판 그대로
        r, out = self.api("PUT", "/formats/work-log", {"label": LABEL, "schema": SCHEMA, "instructions": "새 지시"})
        self.assertEqual(out["version"], 2)
        r, out = self.api("PUT", "/formats/work-log", {"label": {"ko": "가" * 41, "en": "x"}, "schema": SCHEMA})
        self.assertEqual((r.status, out["code"]), (400, "format.text_too_long"))
        r, out = self.api("PUT", "/formats/work-log", {"label": LABEL, "schema": {"type": "object", "oneOf": []}})
        self.assertEqual((r.status, out["code"], out["errors"][0]["path"]), (400, "format.schema_invalid", "/oneOf"))
        r, out = self.api("DELETE", "/formats/work-log")
        self.assertEqual(r.status, 200, out)
        r, out = self.api("POST", "/formats", {"id": "work-log", "label": LABEL, "schema": SCHEMA})
        self.assertEqual(out["version"], 3)                                # 지운 형식을 다시 만들면 판이 이어진다

    def test_warnings_stats_settings_and_try(self):
        loose = {"type": "object", "properties": {"note": {"type": "string"}}}
        r, out = self.api("POST", "/formats", {"id": "loose", "label": LABEL, "schema": loose})
        self.assertEqual(sorted((w["path"], w["keyword"]) for w in out["warnings"]), [("/note", "maxLength"), ("/note", "title")])
        self.fill()
        self.req("POST", "/api/chat/answer-format/outcome?pod=em-a",
                 {"format": "board-post", "source": "registered", "outcome": "saved", "edited": 3}, KC_ORIGIN, self.token)
        r, out = self.api("GET", "/formats")
        stats = next(f for f in out["formats"] if f["id"] == "board-post")["stats"]
        self.assertEqual((stats["fills"], stats["failed"], stats["saveRate"], stats["editedAvg"]), (1, 0, 1.0, 3.0))
        r, out = self.api("PUT", "/formats-settings", {"page_schema": True})
        self.assertEqual((r.status, embed.get_app(KC_APP)["page_schema"]), (200, True))
        r, out = self.api("POST", "/formats/board-post/try", {"markdown": "디스크 정리"})
        self.assertEqual((r.status, out["payload"]["category"]), (200, "질문"), out)
        r, out = self.api("POST", "/formats-try", {"schema": SCHEMA, "markdown": "디스크 정리"})
        self.assertEqual(r.status, 200, out)
        self.assertIn("elapsedMs", out)


if __name__ == "__main__":
    unittest.main()
