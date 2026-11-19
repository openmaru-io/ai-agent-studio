/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/* AAS 채팅 위젯 초기화(OMAI-1873). CogentAI 위젯의 cogentai-init.js 와 같은 방식이다.
 * 위젯 빌드(npm run build:widget)가 aas-widget.js 옆에 그대로 내보내고, AAS 서버가 /static/js/aas-widget-init.js 로 내보낸다.
 * 호스트는 이 파일과 위젯을 AAS 서버에서 직접 불러온다(<AAS 주소>/static/js/…). CSP 를 바꿀 수 없는 호스트만 ui/embed/dist.sh 로 복사한다.
 *
 * 주입하는 세 줄(OpsKnow 위키처럼 CSP nonce 를 다는 곳은 세 태그에 모두 nonce 를 단다) —
 *   <script nonce="{csp-nonce}">window.__COGENTAI_AAS__={backendUrl:"<AAS 절대 주소>", accessTokenCookie:"<쿠키 이름>"}</script>
 *   <script defer nonce="{csp-nonce}" src="…/aas-widget.js"></script>
 *   <script defer nonce="{csp-nonce}" src="…/aas-widget-init.js"></script>
 * 인라인 script 는 파싱 중에 바로 돌고 defer 는 그 뒤에 문서 순서대로 돈다. 그래서 이 파일이 돌 때 설정과 위젯이 모두 준비돼 있다.
 *
 * 선택 방식(사설 인증서 현장): 이 파일만 호스트 출처에 복사하고(ui/embed/dist.sh --init-only) 위젯 태그를 빼면, 이 파일이
 *   <AAS 주소>/static/js/aas-widget.js 를 불러온다. 브라우저가 AAS 인증서를 믿지 않아 받지 못하면 「연결 설정 필요」 안내를 띄운다.
 *
 * 설정을 이 파일에 적지 않고 window.__COGENTAI_AAS__ 로 받는다. 사이트마다 주소·쿠키 이름이 달라서, 파일에 적으면 값 하나를 바꾸려고
 * 위젯을 다시 구워야 한다. 설정 이름은 CogentAIAASWidget.init() 과 같다(문서 202-configuration).
 * 함수 설정(getAccessToken·onLoginRequired)도 window.__COGENTAI_AAS__ 에 넣으면 그대로 init() 에 넘어간다(OMAI-1908).
 *
 * 주의: 위젯 script 태그에 data-aas-* 속성을 붙이지 않는다. 속성이 하나라도 있으면 위젯이 스스로 그 속성으로 떠 있게 되고,
 *   그 뒤의 init() 은 이미 뜬 것을 돌려줄 뿐이라 여기 설정이 쓰이지 않는다(위젯은 하나만 뜬다. 두 개가 뜨지는 않는다).
 *
 * 콘솔 문구는 영어 ASCII 다. 호스트가 문자 집합을 알리지 않고 이 파일을 내보내도 문자열이 깨지지 않게 한다.
 */
(function () {
  "use strict";

  var PREFIX = "[CogentAIAASWidget]";
  var CFG = window.__COGENTAI_AAS__;

  if (!CFG || typeof CFG !== "object") {
    console.error(PREFIX + " init: window.__COGENTAI_AAS__ is missing; the inline config script must run before aas-widget-init.js");
    return;
  }

  /* backendUrl 은 절대 주소(http·https)여야 한다. 위젯은 호스트와 다른 출처의 AAS 로 직접 요청하고 웹소켓을 연다.
   * 상대 주소를 주면 호스트 자신에게 요청이 가서 교환이 404·로그인 화면으로 끝난다. */
  var BACKEND_URL = typeof CFG.backendUrl === "string" ? CFG.backendUrl.replace(/\/+$/, "") : "";
  if (!/^https?:\/\/[^/]+/i.test(BACKEND_URL)) {
    console.error(PREFIX + " init: window.__COGENTAI_AAS__.backendUrl must be an absolute http(s) URL of AAS (got " + JSON.stringify(CFG.backendUrl) + ")");
    return;
  }

  var CONTAINER_ID = "cogentai-aas-widget-container"; // 위젯의 shadowDom.ts 와 같은 id
  var widget = null;

  /* 위젯 파일을 이 파일이 직접 불러오는 경우(2026-11-14). 호스트가 이 파일만 자기 출처에 복사하고 aas-widget.js 태그를 넣지 않으면,
   * 이 파일이 <backendUrl>/static/js/aas-widget.js 를 불러온다. 위젯 태그가 먼저 있으면(기본 방식) 지금처럼 그것을 쓴다.
   * 이유: AAS 가 사설 인증서를 쓰고 브라우저가 그 CA 를 믿지 않으면, 다른 출처의 스크립트는 경고 화면 없이 실패한다.
   *   위젯 파일이 없으면 위젯 안의 인증서 안내(certHelper.ts)도 나오지 않는다. 이 파일이 호스트 출처에 있으면 실패를 알고 안내를 띄울 수 있다. */
  var LOADER_ID = "cogentai-aas-widget-loader";
  var WIDGET_SRC = BACKEND_URL + "/static/js/aas-widget.js";
  var SELF = document.currentScript; // 처음 실행하는 동안만 값이 있다. CSP nonce 를 새 script 태그에 넘긴다
  var NONCE = (SELF && SELF.nonce) || "";
  var POLL_START_MS = 500; // certHelper.ts 와 같은 간격: 0.5초에서 1.5배씩, 최대 3초, 40번(약 2분)
  var POLL_MAX_MS = 3000;
  var POLL_GROWTH = 1.5;
  var POLL_MAX_TRIES = 40;
  var loading = false;
  var notice = null;

  /* 안내 문구. 이 파일은 ASCII 만 쓰므로 한국어는 \u 이스케이프로 둔다(줄 끝 주석이 원문). 위젯 i18n 의 embed.cert.* 와 같은 말이다 */
  var MSG = {
    ko: {
      title: "\uc5f0\uacb0 \uc124\uc815 \ud544\uc694", // 연결 설정 필요
      problem: "AAS \ucc44\ud305 \uc704\uc82f\uc744 \ubd88\ub7ec\uc624\uc9c0 \ubabb\ud588\uc2b5\ub2c8\ub2e4. \uc774 \ube0c\ub77c\uc6b0\uc800\uac00 AAS \uc758 \uc778\uc99d\uc11c\ub97c \uc544\uc9c1 \ubbff\uc9c0 \uc54a\uc744 \uc218 \uc788\uc2b5\ub2c8\ub2e4.", // AAS 채팅 위젯을 불러오지 못했습니다. 이 브라우저가 AAS 의 인증서를 아직 믿지 않을 수 있습니다.
      step1: "1. \u300c\uc5f0\uacb0 \uc124\uc815\ud558\uae30\u300d\ub97c \ub204\ub974\uc138\uc694.", // 1. 「연결 설정하기」를 누르세요.
      step2: "2. \uc0c8 \ucc3d\uc5d0\uc11c \uc778\uc99d\uc11c \uacbd\uace0\ub97c \ubc1b\uc544\ub4e4\uc774\uc138\uc694.", // 2. 새 창에서 인증서 경고를 받아들이세요.
      setup: "\uc5f0\uacb0 \uc124\uc815\ud558\uae30", // 연결 설정하기
      close: "\ub2eb\uae30", // 닫기
      waiting: "\uc0c8 \ucc3d\uc5d0\uc11c \uc5f0\uacb0 \uc124\uc815\uc744 \ub9c8\uce58\uc138\uc694.", // 새 창에서 연결 설정을 마치세요.
      success: "\uc5f0\uacb0\ub418\uc5c8\uc2b5\ub2c8\ub2e4. \uc704\uc82f\uc744 \ubd88\ub7ec\uc635\ub2c8\ub2e4.", // 연결되었습니다. 위젯을 불러옵니다.
      timeout: "\uc5f0\uacb0\uc744 \ud655\uc778\ud558\uc9c0 \ubabb\ud588\uc2b5\ub2c8\ub2e4. \uc0c8 \ucc3d\uc5d0\uc11c \uc124\uc815\uc744 \ub9c8\uce5c \ub4a4 \u300c\uc5f0\uacb0 \uc124\uc815\ud558\uae30\u300d\ub97c \ub2e4\uc2dc \ub204\ub974\uc138\uc694." // 연결을 확인하지 못했습니다. 새 창에서 설정을 마친 뒤 「연결 설정하기」를 다시 누르세요.
    },
    en: {
      title: "Connection setup required",
      problem: "Could not load the AAS chat widget. This browser may not trust the AAS certificate yet.",
      step1: "1. Select \"Set up connection\".",
      step2: "2. Accept the certificate warning in the new window.",
      setup: "Set up connection",
      close: "Close",
      waiting: "Finish the setup in the new window.",
      success: "Connected. Loading the widget.",
      timeout: "Could not confirm the connection. Finish the setup in the new window, then select \"Set up connection\" again."
    }
  };

  /* 호스트의 다크·라이트를 따라간다. 위젯은 Shadow DOM 안이라 호스트 CSS·테마를 받지 못한다.
   * Outline(OpsKnow 위키)이 내는 신호 두 가지를 읽는다: window 의 theme-changed 이벤트, localStorage 의 theme 키(JSON 문자열).
   * 다른 호스트에서는 두 신호가 없어서 설정의 theme 을 그대로 쓴다. */
  var currentTheme = CFG.theme === "dark" ? "dark" : "light";

  function prefersDark() {
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }

  function readStoredTheme() {
    try {
      var raw = window.localStorage.getItem("theme");
      if (!raw) return null;
      var v = JSON.parse(raw);
      if (v === "dark" || v === "light") return v;
      if (v === "system") return prefersDark() ? "dark" : "light";
      return null;
    } catch (e) {
      return null; // 사생활 보호 모드 등에서 localStorage 가 막힐 수 있다. JSON 이 아닌 값도 여기로 온다
    }
  }

  function applyTheme(theme) {
    if ((theme !== "dark" && theme !== "light") || theme === currentTheme) return;
    currentTheme = theme;
    if (!widget || !widget.updateTheme) return;
    try {
      widget.updateTheme(theme);
    } catch (e) {
      console.warn(PREFIX + " init: updateTheme failed", e);
    }
  }

  function watchTheme() {
    window.addEventListener("theme-changed", function (e) {
      // 인쇄 미리 보기에서도 isDark:false 가 온다. 인쇄 중에는 무시한다(CogentAI 초기화 스크립트와 같다)
      if (window.matchMedia && window.matchMedia("print").matches) return;
      var detail = e && e.detail;
      if (!detail || typeof detail.isDark !== "boolean") return;
      applyTheme(detail.isDark ? "dark" : "light");
    });
  }

  /* 위젯 안에서 누른 키가 호스트 단축키를 실행하지 않게 한다. 이벤트가 Shadow DOM 밖으로 나오면 대상이 컨테이너 div 로 바뀌어,
   * 호스트(Outline 등)는 「입력 중이 아니다」로 보고 단축키('?'·'/')를 실행한다. 컨테이너에서 전파만 멈춘다(입력은 막지 않는다). */
  function isolateKeyboard() {
    function attach(el) {
      if (el.getAttribute("data-aas-key-isolated")) return;
      el.setAttribute("data-aas-key-isolated", "1");
      ["keydown", "keypress", "keyup"].forEach(function (type) {
        el.addEventListener(type, function (e) {
          e.stopPropagation();
        });
      });
    }
    var el = document.getElementById(CONTAINER_ID);
    if (el) return attach(el);
    if (typeof MutationObserver === "undefined") return;
    var obs = new MutationObserver(function () {
      var found = document.getElementById(CONTAINER_ID);
      if (found) {
        attach(found);
        obs.disconnect();
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(function () {
      obs.disconnect();
    }, 30000);
  }

  function widgetApi() {
    var api = window.CogentAIAASWidget;
    return api && typeof api.init === "function" ? api : null;
  }

  function text(key) {
    var lang = CFG.langCode || (document.documentElement && document.documentElement.lang) || navigator.language || "";
    return (/^ko/i.test(String(lang)) ? MSG.ko : MSG.en)[key];
  }

  /* CORS 검사 없이 AAS 에 닿는가. no-cors 는 응답을 읽지 못하지만 인증서·네트워크 오류면 reject 된다(certHelper.ts probeReachable 과 같다) */
  function probe() {
    if (typeof fetch !== "function") return Promise.resolve(false);
    return fetch(BACKEND_URL + "/healthz", { method: "GET", mode: "no-cors", cache: "no-store", credentials: "omit" }).then(
      function () {
        return true;
      },
      function () {
        return false;
      }
    );
  }

  function loadWidget() {
    if (loading) return;
    loading = true;
    var s = document.createElement("script");
    s.src = WIDGET_SRC;
    s.async = true;
    if (NONCE) s.nonce = NONCE;
    s.onload = function () {
      loading = false;
      if (widgetApi()) start();
      else console.error(PREFIX + " init: " + WIDGET_SRC + " loaded but window.CogentAIAASWidget is missing");
    };
    s.onerror = function () {
      loading = false;
      if (s.parentNode) s.parentNode.removeChild(s);
      loadFailed();
    };
    (document.head || document.documentElement).appendChild(s);
  }

  /* 위젯 파일을 받지 못한 원인을 가린다. no-cors /healthz 가 되면 인증서가 아니다(주소·CSP script-src 문제) */
  function loadFailed() {
    probe().then(function (reachable) {
      if (reachable) {
        console.error(PREFIX + " init: cannot load " + WIDGET_SRC + " although AAS answers; check the URL and the CSP script-src of this page");
      } else if (!/^https:/i.test(BACKEND_URL)) {
        console.error(PREFIX + " unreachable cannot reach " + BACKEND_URL);
      } else {
        console.error(PREFIX + " cert_required this browser does not trust the certificate of " + BACKEND_URL + "; showing the connection setup notice");
        showCertNotice();
      }
    });
  }

  /* 인증서 안내. 위젯이 없으므로 호스트 페이지에 작은 상자를 직접 붙인다. 호스트 CSS 가 들어오지 않게 Shadow DOM 안에 둔다.
   * 「연결 설정하기」를 누른 순간 /embed/cert 새 창을 연다(늦게 열면 팝업 차단에 걸린다). /healthz 가 되면 위젯을 다시 불러온다. */
  function showCertNotice() {
    if (notice || !document.body) return;
    var dark = currentTheme === "dark";
    var host = document.createElement("div");
    host.id = LOADER_ID;
    host.style.cssText =
      "position:fixed;bottom:20px;" + (CFG.position === "bottom-right" ? "right" : "left") + ":20px;z-index:2147483000;";
    var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
    function el(tag, style, value) {
      var n = document.createElement(tag);
      n.style.cssText = style;
      if (value) n.textContent = value;
      return n;
    }
    var panel = el(
      "div",
      "box-sizing:border-box;width:320px;max-width:calc(100vw - 40px);padding:20px;border-radius:12px;font-family:sans-serif;" +
        "box-shadow:0 12px 48px rgba(0,0,0,.25);background:" + (dark ? "#1f2937;color:#f3f4f6;" : "#ffffff;color:#1f1f1f;")
    );
    panel.setAttribute("role", "alertdialog");
    panel.setAttribute("data-testid", "aas-loader-cert");
    var title = el("h2", "margin:0 0 10px;font-size:16px;font-weight:700;line-height:1.4;", text("title"));
    var body = el("p", "margin:0 0 16px;font-size:13px;line-height:1.7;color:" + (dark ? "#d1d5db;" : "#4b5563;"));
    [text("problem"), text("step1"), text("step2")].forEach(function (line, i) {
      if (i) body.appendChild(document.createElement("br"));
      body.appendChild(document.createTextNode(line));
    });
    var status = el(
      "div",
      "display:none;margin:0 0 14px;padding:8px;border-radius:8px;font-size:13px;background:" + (dark ? "#374151;" : "#f3f4f6;")
    );
    status.setAttribute("role", "status");
    var row = el("div", "display:flex;gap:8px;justify-content:flex-end;");
    var btn = "padding:6px 14px;border-radius:6px;cursor:pointer;font:inherit;font-size:13px;";
    var close = el("button", btn + "background:transparent;color:inherit;border:1px solid #9ca3af;", text("close"));
    var setup = el("button", btn + "background:#111827;color:#f7f8f8;border:1px solid #111827;font-weight:600;", text("setup"));
    close.type = setup.type = "button";
    close.setAttribute("data-testid", "aas-loader-close");
    setup.setAttribute("data-testid", "aas-loader-setup");
    row.appendChild(close);
    row.appendChild(setup);
    panel.appendChild(title);
    panel.appendChild(body);
    panel.appendChild(status);
    panel.appendChild(row);
    root.appendChild(panel);
    document.body.appendChild(host);

    var timer = null;
    var win = null;
    function say(key) {
      status.style.display = "block";
      status.textContent = text(key);
    }
    function remove() {
      if (timer) clearTimeout(timer);
      timer = null;
      if (win && !win.closed) win.close();
      if (host.parentNode) host.parentNode.removeChild(host);
      notice = null;
    }
    notice = { remove: remove };
    close.onclick = remove;
    setup.onclick = function () {
      var w = 700;
      var h = 550;
      var left = Math.max(0, (window.screen.width - w) / 2);
      var top = Math.max(0, (window.screen.height - h) / 2);
      win = window.open(BACKEND_URL + "/embed/cert", "_blank",
        "width=" + w + ",height=" + h + ",left=" + left + ",top=" + top + ",resizable=yes,scrollbars=yes");
      setup.disabled = true;
      setup.style.opacity = "0.5";
      say("waiting");
      var tries = 0;
      var delay = POLL_START_MS;
      function poll() {
        timer = null;
        tries += 1;
        probe().then(function (ok) {
          if (notice === null) return; // 닫았다
          if (ok) {
            say("success");
            if (win && !win.closed) win.close();
            timer = setTimeout(function () {
              remove();
              loadWidget();
            }, 800);
            return;
          }
          if (tries >= POLL_MAX_TRIES) {
            say("timeout");
            setup.disabled = false;
            setup.style.opacity = "1";
            return;
          }
          delay = Math.min(delay * POLL_GROWTH, POLL_MAX_MS);
          timer = setTimeout(poll, delay);
        });
      }
      timer = setTimeout(poll, delay);
    };
    setup.focus();
  }

  function start() {
    if (widget) return;
    var api = widgetApi();
    if (!api) {
      loadWidget(); // 위젯 태그가 없다: 이 파일만 호스트에 복사한 경우. 받으면 다시 start() 한다
      return;
    }
    var config = {};
    for (var k in CFG) if (Object.prototype.hasOwnProperty.call(CFG, k)) config[k] = CFG[k];
    config.backendUrl = BACKEND_URL;
    config.theme = currentTheme;
    isolateKeyboard();
    widget = api.init(config);
  }

  function whenReady(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn, { once: true });
    else fn();
  }

  whenReady(function () {
    currentTheme = readStoredTheme() || currentTheme;
    watchTheme();
    start();
  });
})();
