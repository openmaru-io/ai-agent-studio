# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""로그인·로그아웃 화면과 서버 안내 화면(_page)의 모양 시험(OMAI-1128, 스펙 2026-10-14-001).
인증 흐름은 test_auth.py 가 본다. 여기서는 HTML 이 에어갭을 지키고 필요한 요소를 갖췄는지만 본다."""
import os
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import i18n  # noqa: E402
from aas.web import server  # noqa: E402

EXTERNAL = re.compile(r"""(?:\bsrc|<link\b[^>]*\bhref)\s*=\s*['"]?(?:https?:)?//|url\(\s*['"]?(?:https?:)?//|@import""", re.I)  # 화면을 열 때 밖에서 받는 것(<a> 링크는 누를 때만 간다)


def render_login(*, oidc=True, password=False, error="", out=False, local=True, secure=False, nxt="/"):
    """_login_page 를 가짜 핸들러로 불러 HTML 을 돌려준다."""
    h = server.Handler.__new__(server.Handler)
    sent = {}
    h._send = lambda code, body, ctype, headers=None: sent.update(code=code, body=body.decode())
    h._oidc_base = lambda: "http://localhost" if oidc else None
    h._is_local_host = lambda: local
    h._secure_request = lambda: secure
    a = mock.Mock(oidc_enabled=oidc, password_enabled=password)
    with mock.patch.object(server, "auth", return_value=a):
        h._login_page(error=error, next_path=nxt, logged_out=out)
    return sent["code"], sent["body"]


class PageTest(unittest.TestCase):
    def tearDown(self):
        i18n.set_lang("ko")

    def test_page_is_card_with_inline_logo_and_no_external_requests(self):
        body = server._page("<제목>", "<p>본문</p>").decode()
        self.assertIn("<html lang=ko>", body)
        self.assertIn("<svg", body)                                       # 로고를 HTML 안에 넣는다
        self.assertIn("&lt;제목&gt;", body)                                # 제목은 이스케이프
        css = body[body.index("<style>"):body.index("</style>")]
        self.assertIn(":root{color-scheme:dark;--bg:#08090a", css)         # 어두운 테마가 기본: 콘솔(ThemeMode.tsx readMode)도 저장값이 없으면 다크다(OMAI-1245)
        self.assertNotIn("prefers-color-scheme", css)                      # OS 설정을 따르지 않는다. 콘솔이 따르지 않기 때문에 화면마다 달라졌었다
        self.assertIn("content='light dark'", body)
        self.assertIsNone(EXTERNAL.search(body), "외부 주소를 부르면 에어갭에서 깨진다")
        self.assertNotIn("<script src", body)                              # 스크립트는 테마를 읽는 인라인 한 줄뿐이다
        self.assertEqual(body.count("<script"), 1)

    def test_footer_company_address_is_a_new_window_link_in_footer_color(self):
        """바닥글의 회사 주소는 새 창으로 여는 링크다(사용자 지시 2026-10-30). 색은 바닥글 글자색을 그대로 쓴다."""
        body = server._page("t", "").decode()
        foot = body[body.index("<footer class=foot>"):body.index("</footer>")]
        self.assertIn("Copyright (c) 2026. OPENMARU, Inc. · <a href=https://www.openmaru.io/ target=_blank rel=noopener>https://www.openmaru.io/</a>", foot)
        self.assertIn(".foot a{color:inherit;text-decoration:none}", body)
        self.assertIsNone(EXTERNAL.search(body))                           # 누를 때만 가는 링크라 화면을 열 때 받아 오는 것이 아니다
        self.assertIsNotNone(EXTERNAL.search("<img src=https://x/a.png>"))   # 받아 오는 주소는 그대로 잡는다
        self.assertIsNotNone(EXTERNAL.search("<link rel=stylesheet href='https://x/a.css'>"))

    def test_page_has_the_console_favicon_inline(self):
        """탭 아이콘이 콘솔(ui/index.html)과 같다. data URI 라 화면을 열 때 받는 것이 없다(§13)."""
        body = server._page("t", "").decode()
        self.assertIn(f'<link rel=icon href="{server._FAVICON}">', body)
        self.assertTrue(server._FAVICON.startswith("data:image/svg+xml,"))
        self.assertIsNone(EXTERNAL.search(body))
        index = Path(__file__).resolve().parents[1] / "ui" / "index.html"
        if index.exists():                                                 # 이미지 안(/src)에는 ui/ 가 없을 수 있다
            self.assertIn(f'<link rel="icon" href="{server._FAVICON}"', index.read_text(encoding="utf-8"))

    def test_page_follows_the_theme_chosen_in_the_console(self):
        # 콘솔의 테마 단추는 localStorage 'aas-theme'(light|dark)에 고른 값을 저장한다. 로그인·로그아웃·준비 중 화면도 같은 값을 따라야 한다
        body = server._page("t", "").decode()
        css = body[body.index("<style>"):body.index("</style>")]
        script = body[body.index("<script>"):body.index("</script>")]
        self.assertIn("localStorage.getItem('aas-theme')", script)
        self.assertIn("setAttribute('data-theme'", script)
        self.assertLess(body.index("<script>"), body.index("<style>"))     # 칠하기 전에 정해 번쩍이지 않게
        self.assertIn(":root[data-theme=light]{color-scheme:light;--bg:#edeef2", css)  # 밝게 골랐을 때만 밝다(OS 설정과 무관)
        self.assertIn(":root:not([data-theme=light]) .notice.ok", css)      # 알림 글자색도 같은 규칙을 따른다

    def test_page_lang_follows_request(self):
        i18n.set_lang("en")
        self.assertIn(b"<html lang=en>", server._page("t", ""))


class LoginPageTest(unittest.TestCase):
    def tearDown(self):
        i18n.set_lang("ko")

    def test_sso_only_shows_primary_sso_button_and_product(self):
        code, body = render_login(nxt="/office")
        self.assertEqual(code, 200)
        self.assertIn("/auth/oidc?next=/office", body)
        self.assertIn("<span class=product>AAS</span>", body)            # 로고 옆 제품명(상단 막대와 같이)
        self.assertIn("class='btn btn-primary' href='/auth/oidc", body)   # SSO 만 있으면 주 단추
        self.assertNotIn("name=password", body)
        self.assertNotIn("또는", body)
        self.assertIsNone(EXTERNAL.search(body))

    def test_sso_button_opens_a_popup_and_falls_back_to_a_link(self):
        """스펙 2026-10-15-019: 단추는 링크(팝업이 막히면 같은 창에서 이동)이고, 스크립트가 팝업을 연다. 외부 요청은 없다."""
        _, body = render_login(nxt="/office?tab=seats")
        self.assertIn("id=sso data-next='/office?tab=seats'", body)
        self.assertIn("window.open(a.href+'&popup=1'", body)
        self.assertIn("/api/me", body)                                            # 끝난 것을 세션으로도 알아챈다
        self.assertIn("e.origin===location.origin", body)                         # 메시지는 같은 출처만 믿는다
        self.assertEqual(body.count("<script"), 3)                                # 테마 한 줄 + 팝업 + 테마·언어 고르기
        self.assertIsNone(EXTERNAL.search(body))
        self.assertIn("새 창에서 로그인합니다", body)
        _, none = render_login(oidc=False, password=True)
        self.assertNotIn("window.open", none)                                     # SSO 가 없으면 스크립트도 없다

    def test_logged_out_notice(self):
        _, body = render_login(out=True)
        self.assertIn("로그아웃했습니다", body)
        self.assertIn("/auth/oidc", body)                                 # 바로 다시 로그인할 수 있다
        _, body = render_login(out=False)
        self.assertNotIn("로그아웃했습니다", body)

    def test_password_and_sso_together(self):
        _, body = render_login(password=True)
        self.assertIn("name=password", body)
        self.assertIn("name=email", body)
        self.assertIn("또는", body)                                       # 두 방법 사이 구분
        self.assertIn("class='btn btn-secondary' href='/auth/oidc", body)  # 비밀번호가 있으면 SSO 는 보조 단추
        self.assertEqual(body.count("btn-primary'"), 1)                    # 빨강 주 단추는 하나(로그인)

    def test_error_is_escaped_alert(self):
        code, body = render_login(error="<b>틀림</b>")
        self.assertIn("role=alert", body)
        self.assertIn("&lt;b&gt;틀림&lt;/b&gt;", body)
        self.assertNotIn("<b>틀림</b>", body)

    def test_http_warning_only_off_local_without_tls(self):
        _, body = render_login(local=False, secure=False)
        self.assertIn("암호화되지 않습니다", body)
        _, body = render_login(local=False, secure=True)
        self.assertNotIn("암호화되지 않습니다", body)

    def test_english(self):
        i18n.set_lang("en")
        _, body = render_login(out=True)
        self.assertIn("Sign in with SSO", body)
        self.assertIn("You have signed out", body)


    def test_welcome_heading_product_full_name_and_tagline(self):
        """사용자 지시 2026-10-30: 환영 문구, 「AAS」의 풀이, 작은 표어 「We make IT better!」(§13)."""
        _, body = render_login()
        self.assertIn("<h1>AAS 에 오신 것을 환영합니다</h1>", body)
        self.assertIn("<title>로그인 — AAS</title>", body)                       # 탭 제목은 그대로
        self.assertIn("<span class=product>AAS</span><span class=product-full><b>A</b>I <b>A</b>gent <b>S</b>tudio</span>", body)
        self.assertIn("<p class=tagline>We make IT better!</p>", body)
        i18n.set_lang("en")
        _, body = render_login()
        self.assertIn("<h1>Welcome to AAS</h1>", body)
        self.assertIn("We make IT better!", body)                                # 표어는 번역하지 않는다

    def test_theme_and_language_pickers_use_console_keys(self):
        """테마 버튼과 언어 고르기는 콘솔과 같은 localStorage 키를 쓰고, 언어는 쿠키에도 넣어 로그인 화면을 같은 next 로 다시 연다."""
        _, body = render_login(nxt="/office")
        self.assertIn("<div class=prefs id=prefs hidden data-next='/office'>", body)   # 스크립트가 보이게 한다(없으면 고를 수 없다)
        self.assertIn("<span class=to-light>", body)
        self.assertIn("<span class=to-dark>", body)
        self.assertIn(":root[data-theme=light] .theme .to-light{display:none}", body)  # 바꿀 쪽 이름만 보인다
        self.assertIn("<option value=ko selected>한국어</option><option value=en>English</option>", body)
        self.assertIn("localStorage.setItem('aas-theme',t)", body)
        self.assertIn("localStorage.setItem('aas-lang',l)", body)
        self.assertIn("document.cookie='aas-lang='+l+';path=/;max-age=31536000;samesite=lax'", body)
        self.assertIn("location.replace('/auth/login'", body)                     # 비밀번호 오류 화면(POST 결과)을 다시 부르지 않는다
        self.assertIsNone(EXTERNAL.search(body))
        i18n.set_lang("en")
        _, body = render_login()
        self.assertIn("<option value=en selected>English</option>", body)
        self.assertIn("aria-label='Language'", body)

    def test_other_server_pages_keep_their_title_and_have_no_pickers(self):
        body = server._page("준비 중", "<p>x</p>").decode()
        self.assertIn("<h1>준비 중</h1>", body)
        self.assertIn("class=product-full", body)                               # 풀이는 모든 서버 화면의 머리에
        self.assertNotIn("id=prefs", body)


class RequestLangTest(unittest.TestCase):
    def test_chosen_language_cookie_wins_over_accept_language(self):
        self.assertEqual(i18n.request_lang("ko-KR,ko;q=0.9", "a=1; aas-lang=en"), "en")
        self.assertEqual(i18n.request_lang("en-US", "aas-lang=ko"), "ko")
        self.assertEqual(i18n.request_lang("en-US", "aas-lang=fr; x=1"), "en")    # 모르는 값이면 헤더
        self.assertEqual(i18n.request_lang("en-US", "xaas-lang=ko"), "en")        # 이름이 정확히 같아야 한다
        self.assertEqual(i18n.request_lang(None, None), "ko")

if __name__ == "__main__":
    unittest.main()
