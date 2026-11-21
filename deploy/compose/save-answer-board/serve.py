#!/usr/bin/env python3
# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""위젯 답 저장 시험용 게시판(스펙 cogentai-aas-docs security/chat-embed-save-answer 2026-11-18-012 §8-7).

다른 출처의 간단한 게시판 페이지에 AAS 위젯을 붙이고, 답 말풍선의 「게시판에 저장」으로 답을 게시글 꼴(board-post.schema.json)로 넣는다.

  python3 serve.py setup  [--aas http://127.0.0.1:17900] [--origin http://127.0.0.1:8765]   # 임베드 앱(host-signed)·형식 등록, 페이지 형식 허용
  python3 serve.py serve  [--port 8765]                                                      # 게시판 페이지와 /token
  python3 serve.py cleanup                                                                   # 임베드 앱 지우기(형식은 deleted 로 남음)

- 관리자 로그인은 환경 변수 AAS_ADMIN_EMAIL·AAS_ADMIN_PASSWORD(없으면 ../.env)로 한다. 값은 출력하지 않는다.
- 서명 키는 시험 도우미(tests/embed_keys.py)로 만들어 나만 읽는 파일(~/.cache/aas-local-dev/save-answer-board.json)에 둔다.
- /token 은 그 키로 4분짜리 host-signed JWT 를 만든다(iss=앱 id, aud=AAS 가 알리는 자기 주소, email=관리자). 시험 전용이다 — 사내망·운영에 띄우지 않는다.
"""
from __future__ import annotations

import argparse
import http.cookiejar
import http.server
import json
import os
import secrets
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[2] / "tests"))
sys.path.insert(0, str(HERE.parents[2]))           # 서명 도우미가 aas.auth.embed 의 패딩 함수를 쓴다
import embed_keys  # noqa: E402  시험 도우미(순수 파이썬 RSA)

STATE = Path(os.environ.get("XDG_RUNTIME_DIR") or Path.home() / ".cache") / "aas-local-dev" / "save-answer-board.json"
APP_NAME = "save-answer-board (시험)"
FORMAT_ID = "board-post"
LABEL = {"ko": "게시판에 저장", "en": "Save to board"}
INSTRUCTIONS = ("답에서 게시글을 만든다. 제목은 답의 주제를 한 줄로, 분류는 장애·오류 이야기면 장애, 알림 문장이면 공지, 질문에 대한 설명이면 질문, "
                "작업 절차나 한 일을 적은 답이면 작업 기록이다. 요약은 세 줄 이내, 본문은 답의 핵심을 그대로 옮긴다. "
                "태그는 3개까지, 기한은 답에 날짜가 있을 때만 채운다.")


def _env() -> dict:
    env = dict(os.environ)
    dot = HERE.parent / ".env"
    if dot.is_file():
        for line in dot.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                env.setdefault(k.strip(), v.strip())
    return env


def _load() -> dict:
    return json.loads(STATE.read_text(encoding="utf-8")) if STATE.is_file() else {}


def _save(state: dict) -> None:
    STATE.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(STATE.parent, 0o700)
    STATE.write_text(json.dumps(state), encoding="utf-8")
    os.chmod(STATE, 0o600)


class Admin:
    """AAS 관리자 세션(비밀번호 로그인 쿠키)."""

    def __init__(self, aas: str, email: str, password: str):
        self.aas = aas.rstrip("/")
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        data = urllib.parse.urlencode({"email": email, "password": password, "next": "/"}).encode()
        req = urllib.request.Request(self.aas + "/auth/password", data=data, headers={"Content-Type": "application/x-www-form-urlencoded"})
        self.opener.open(req, timeout=15).read()
        if not any(c for c in self.jar):
            raise SystemExit("관리자 로그인에 실패했습니다(AAS_ADMIN_EMAIL·AAS_ADMIN_PASSWORD 를 확인하세요).")

    def call(self, method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
        req = urllib.request.Request(self.aas + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                     headers={"Content-Type": "application/json", "X-AAS": "1", "Origin": self.aas})
        try:
            with self.opener.open(req, timeout=60) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")


def setup(args) -> None:
    env = _env()
    email, password = env.get("AAS_ADMIN_EMAIL", ""), env.get("AAS_ADMIN_PASSWORD", "")
    if not email or not password:
        raise SystemExit("AAS_ADMIN_EMAIL·AAS_ADMIN_PASSWORD 가 필요합니다.")
    admin = Admin(args.aas, email, password)
    state = _load()
    key = embed_keys.Key() if "key" not in state else None
    if key is not None:
        state["key"] = key.jwk(private=True)
    key_jwk = state["key"]
    public = {k: key_jwk[k] for k in ("kty", "n", "e")}
    status, apps = admin.call("GET", "/api/admin/embed-apps")
    old = next((a for a in apps.get("apps", []) if a.get("name") == APP_NAME), None)
    body = {"action": "save", "name": APP_NAME, "origins": [args.origin], "mode": "host-signed", "public_jwk": json.dumps(public)}
    if old:
        body["app_id"] = old["app_id"]
    status, out = admin.call("POST", "/api/admin/embed-apps", body)
    if status != 200:
        raise SystemExit(f"임베드 앱 등록 실패 {status}: {out}")
    app_id = out["app"]["app_id"]
    schema = json.loads((HERE / "board-post.schema.json").read_text(encoding="utf-8"))
    fmt = {"id": FORMAT_ID, "label": LABEL, "schema": schema, "instructions": INSTRUCTIONS}
    status, out = admin.call("POST", f"/api/admin/embed-apps/{app_id}/formats", fmt)
    if status == 409:
        status, out = admin.call("PUT", f"/api/admin/embed-apps/{app_id}/formats/{FORMAT_ID}", fmt)
    if status != 200:
        raise SystemExit(f"형식 등록 실패 {status}: {out}")
    status, _ = admin.call("PUT", f"/api/admin/embed-apps/{app_id}/formats-settings", {"page_schema": True})   # 게시판의 「페이지 형식」 방식
    if status != 200:
        raise SystemExit(f"「페이지가 형식을 넘길 수 있음」 켜기 실패 {status}")
    aud = (apps.get("audiences") or [admin.aas])[0]            # host-signed 토큰의 aud 는 AAS 가 아는 자기 주소(AAS_PUBLIC_URL)다
    state.update({"aas": admin.aas, "aud": aud, "origin": args.origin, "app_id": app_id, "email": email})
    _save(state)
    print(f"임베드 앱 {app_id}, 형식 {FORMAT_ID} 판 {out['version']} schemaHash {out['schemaHash']}")
    for w in out.get("warnings", []):
        print(f"  경고 {w['path']} {w['keyword']}: {w['message']}")


def cleanup(_args) -> None:
    env, state = _env(), _load()
    if not state.get("app_id"):
        print("지울 앱이 없습니다.")
        return
    admin = Admin(state["aas"], env.get("AAS_ADMIN_EMAIL", ""), env.get("AAS_ADMIN_PASSWORD", ""))
    status, out = admin.call("POST", "/api/admin/embed-apps", {"action": "remove", "app_id": state["app_id"]})
    print(f"앱 지우기 {status}")
    STATE.unlink(missing_ok=True)


def mint(state: dict) -> str:
    k = state["key"]
    key = embed_keys.Key.__new__(embed_keys.Key)
    key.n, key.e, key.d = (int.from_bytes(_b64d(k[x]), "big") for x in ("n", "e", "d"))
    key.k = (key.n.bit_length() + 7) // 8
    now = time.time()
    claims = {"iss": state["app_id"], "aud": state.get("aud") or state["aas"], "exp": int(now + 240), "iat": int(now), "jti": secrets.token_hex(12),
              "email": state["email"]}
    return embed_keys.jwt(claims, key)


def _b64d(s: str) -> bytes:
    import base64
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def serve(args) -> None:
    state = _load()
    if not state.get("app_id"):
        raise SystemExit("먼저 python3 serve.py setup 을 돌리세요.")
    page = (HERE / "board.html").read_text(encoding="utf-8")

    class H(http.server.BaseHTTPRequestHandler):
        def _send(self, status: int, body: bytes, ctype: str):
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # noqa: N802
            path = self.path.split("?")[0]
            if path in ("/", "/index.html"):
                self._send(200, page.replace("__AAS__", state["aas"]).encode(), "text/html; charset=utf-8")
            elif path == "/token":
                self._send(200, json.dumps({"token": mint(state)}).encode(), "application/json")
            else:
                self._send(404, b"not found", "text/plain")

        def log_message(self, fmt, *a):
            if "/token" not in (a[0] if a else ""):
                sys.stderr.write(fmt % a + "\n")

    host = urllib.parse.urlsplit(state["origin"]).hostname or "127.0.0.1"
    print(f"게시판: {state['origin']}  (AAS {state['aas']}, 앱 {state['app_id']})")
    http.server.ThreadingHTTPServer((host, args.port), H).serve_forever()


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("setup")
    s.add_argument("--aas", default="http://127.0.0.1:17900")
    s.add_argument("--origin", default="http://127.0.0.1:8765")
    s.set_defaults(fn=setup)
    v = sub.add_parser("serve")
    v.add_argument("--port", type=int, default=8765)
    v.set_defaults(fn=serve)
    c = sub.add_parser("cleanup")
    c.set_defaults(fn=cleanup)
    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
