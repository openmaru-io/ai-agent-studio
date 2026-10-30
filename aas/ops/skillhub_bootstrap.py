# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""SkillHub 첫 설정 — 서버 파드 안에서 돈다. deploy/k8s/skillhub/bootstrap.sh 와 COP 인스톨러가 kubectl exec 로 부른다.

스펙 2026-10-29-001 R11(옛 deploy/k8s/skillhub/bootstrap.py 를 서버 이미지 안으로 옮김)·R13(게시 전용 계정)·F7, OMAI-1534.
표준 라이브러리만 쓴다 — 미러 번들·인스톨러 쪽에 사본을 두지 않으려고 서버 이미지 안에 둔다(원본은 여기 하나).

  1) 관리자(admin)로 로그인해 네임스페이스 free·paid·community 를 만든다. 이미 있으면 건너뛴다. slug free·paid 의 표시 이름은
     Shared·Restricted 다(스펙 2026-10-28-010). AAS 화면 이름은 aas/market/marketplace.py NS_LABELS 에 있다.
  2) MAKE_TOKEN=1 이면 관리자 계정의 서버 토큰(aas-server)을 만들어 TOKEN_OUT 에 쓴다 — 목록 읽기·사용자 스킬 게시용(R13 그대로).
  3) MAKE_PUBLISH_TOKEN=1 이면 기본 스킬 게시 전용 계정 aas_admin 을 둔다. SkillHub v0.2.22 에는 관리자가 계정을 만드는 API 가 없어
     회원가입으로 만들고, 관리자가 SUPER_ADMIN 역할을 준다 — SUPER_ADMIN 만 검토 없이 바로 게시된다(SkillPublishService autoPublish).
     새로 만들면 비밀번호를 PUBLISH_PW_OUT 에 쓴다. 이미 있으면 PUBLISH_PW(전에 쓴 비밀번호)로 로그인한다. 없으면 멈춘다.
     그 계정으로 토큰(aas-bundle-publish)을 만들어 PUBLISH_TOKEN_OUT 에 쓴다.
비밀번호·토큰은 출력하지 않는다. 환경: HUB(기본 http://aas-skillhub-server:8080), ADMIN_PW.
"""
from __future__ import annotations

import json
import os
import secrets
import string
import sys
import urllib.error
import urllib.parse
import urllib.request

HUB = "http://aas-skillhub-server:8080"
PUBLISH_USER = "aas_admin"                         # SkillHub 계정 이름은 영문·숫자·밑줄만 된다 — aas-admin 은 거절된다(스펙 §9-6a)
PUBLISH_EMAIL = "aas_admin@skillhub.local"
PUBLISH_TOKEN_NAME = "aas-bundle-publish"
NAMESPACES = (("free", "Shared", "전사 공용 패키지(모든 작업공간)"), ("paid", "Restricted", "제한 패키지(관리자 허용 필요)"),   # i18n-ignore: SkillHub 에 남는 설명
              ("community", "Community", "공개 스킬 미러(라이선스 확인된 것만)"))   # i18n-ignore: SkillHub 에 남는 설명


class BootstrapError(Exception):
    pass


class Session:
    """쿠키를 직접 들고 다니는 호출기. 서버가 Secure 쿠키를 내려 평문 HTTP 에서는 쿠키 저장소가 다시 보내지 않는다."""

    def __init__(self, base: str):
        self.base, self.cookies = base.rstrip("/"), {}

    def call(self, method: str, path: str, body=None) -> tuple[int, dict]:
        headers, data = {"Accept": "application/json"}, None
        if body is not None:
            data, headers["Content-Type"] = json.dumps(body).encode(), "application/json"
        if self.cookies:
            headers["Cookie"] = "; ".join(f"{k}={v}" for k, v in self.cookies.items())
            if "XSRF-TOKEN" in self.cookies:
                headers["X-XSRF-TOKEN"] = self.cookies["XSRF-TOKEN"]
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            resp = urllib.request.urlopen(req, timeout=30)
            raw, hdrs, code = resp.read(), resp.headers, resp.status
        except urllib.error.HTTPError as exc:
            raw, hdrs, code = exc.read(), exc.headers, exc.code
        for sc in hdrs.get_all("Set-Cookie") or []:
            k, _, v = sc.split(";")[0].partition("=")
            self.cookies[k.strip()] = v.strip()
        try:
            return code, (json.loads(raw) if raw else {})
        except ValueError:
            return code, {"msg": raw[:200].decode("utf-8", "replace")}

    def xsrf(self) -> None:
        self.call("GET", "/api/v1/auth/methods")                   # 로그인·회원가입 전에 XSRF 쿠키를 받는다(없으면 401 「Session expired」)

    def login(self, user: str, password: str) -> dict:
        self.xsrf()
        code, res = self.call("POST", "/api/v1/auth/local/login", {"username": user, "password": password})
        if code != 200:
            raise BootstrapError(f"{user} 로그인에 실패했습니다 (HTTP {code}): {str(res.get('msg') or '')[:80]}")   # i18n-ignore: 설치 로그
        return res.get("data") or {}


def _password() -> str:
    """정책(대·소문자·숫자·기호)을 늘 채우는 32자."""
    pool = string.ascii_letters + string.digits
    core = "".join(secrets.choice(pool) for _ in range(28))
    return core + secrets.choice(string.ascii_uppercase) + secrets.choice(string.ascii_lowercase) + secrets.choice(string.digits) + "#"


def _write(path: str, value: str) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(value)


def _user(admin: Session, name: str) -> dict | None:
    code, res = admin.call("GET", f"/api/v1/admin/users?search={urllib.parse.quote(name)}&page=0&size=50")
    if code != 200:
        raise BootstrapError(f"계정 목록을 읽지 못했습니다 (HTTP {code})")   # i18n-ignore: 설치 로그
    return next((u for u in (res.get("data") or {}).get("items") or [] if u.get("username") == name), None)


def _token(sess: Session, name: str) -> str:
    code, res = sess.call("POST", "/api/v1/tokens", {"name": name})
    token = str((res.get("data") or {}).get("token") or "")
    if code != 200 or not token:
        raise BootstrapError(f"토큰 {name} 을 만들지 못했습니다 (HTTP {code})")   # i18n-ignore: 설치 로그
    return token


def run(hub: str, admin_pw: str, token_out: str = "", publish_token_out: str = "", publish_password: str = "",
        publish_password_out: str = "") -> None:
    admin = Session(hub)
    admin.login("admin", admin_pw)
    for slug, name, desc in NAMESPACES:
        code, res = admin.call("POST", "/api/v1/namespaces", {"slug": slug, "displayName": name, "description": desc})
        msg = str(res.get("msg") or "")
        if code == 200:
            print("네임스페이스", slug, "만듦")   # i18n-ignore: 설치 로그
        elif code == 400 and "already exists" in msg:              # 이미 있으면 서버가 400 으로 알린다
            print("네임스페이스", slug, "이미 있음")   # i18n-ignore: 설치 로그
        else:
            raise BootstrapError(f"네임스페이스 {slug} 를 만들지 못했습니다 (HTTP {code}): {msg[:80]}")   # i18n-ignore: 설치 로그
    if token_out:
        _write(token_out, _token(admin, "aas-server"))
        print("서버 토큰 만듦 (값은 출력하지 않는다)")   # i18n-ignore: 설치 로그
    if not publish_token_out:
        return
    user = _user(admin, PUBLISH_USER)
    if user is None:
        password = _password()
        reg = Session(hub)
        reg.xsrf()
        code, res = reg.call("POST", "/api/v1/auth/local/register",
                             {"username": PUBLISH_USER, "password": password, "email": PUBLISH_EMAIL})
        if code != 200:
            raise BootstrapError(f"{PUBLISH_USER} 계정을 만들지 못했습니다 (HTTP {code}): {str(res.get('msg') or '')[:80]}")   # i18n-ignore: 설치 로그
        if publish_password_out:
            _write(publish_password_out, password)
        user = _user(admin, PUBLISH_USER)
        if user is None:
            raise BootstrapError(f"{PUBLISH_USER} 계정을 만든 뒤 찾지 못했습니다")   # i18n-ignore: 설치 로그
        print(PUBLISH_USER, "계정 만듦")   # i18n-ignore: 설치 로그
    elif publish_password:
        password = publish_password
    else:
        raise BootstrapError(f"{PUBLISH_USER} 계정이 이미 있는데 비밀번호(PUBLISH_PW)를 받지 못했습니다. "   # i18n-ignore: 설치 로그
                             f"Secret aas-skillhub-token 의 publish-password 를 넘기세요")   # i18n-ignore: 설치 로그
    if "SUPER_ADMIN" not in (user.get("platformRoles") or []):
        code, _res = admin.call("PUT", f"/api/v1/admin/users/{urllib.parse.quote(user['id'])}/role", {"role": "SUPER_ADMIN"})
        if code != 200:
            raise BootstrapError(f"{PUBLISH_USER} 에 SUPER_ADMIN 을 주지 못했습니다 (HTTP {code})")   # i18n-ignore: 설치 로그
    pub = Session(hub)
    pub.login(PUBLISH_USER, password)
    _write(publish_token_out, _token(pub, PUBLISH_TOKEN_NAME))
    print("게시 토큰 만듦 (값은 출력하지 않는다)")   # i18n-ignore: 설치 로그


def main() -> int:
    env = os.environ
    try:
        run(env.get("HUB", HUB), env["ADMIN_PW"],
            token_out=env.get("TOKEN_OUT", "") if env.get("MAKE_TOKEN") == "1" else "",
            publish_token_out=env.get("PUBLISH_TOKEN_OUT", "") if env.get("MAKE_PUBLISH_TOKEN") == "1" else "",
            publish_password=env.get("PUBLISH_PW", ""), publish_password_out=env.get("PUBLISH_PW_OUT", ""))
    except BootstrapError as err:
        print(err, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
