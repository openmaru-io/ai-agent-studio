# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Keycloak 관리 API 로 AAS 를 쓸 수 있는 사람(그룹 aas-users 구성원 + 역할 aas-admin 보유자)을 읽고, 「사용자·권한」 화면의 사용자를 만들고 고친다.

하루 1회 대조(lifecycle.reconcile)가 읽기를 쓴다. 로그인하지 않는 퇴사자도 찾으려는 것이다(계획 R19).
「사용자·권한」 화면(스펙 2026-10-14-011)이 쓰기를 쓴다: 만들기·고치기·관리자 그룹·비밀번호·사용 중지·로그아웃·삭제.
서비스 계정 클라이언트가 필요하다: AAS_KEYCLOAK_ADMIN_CLIENT_ID·AAS_KEYCLOAK_ADMIN_CLIENT_SECRET.
그 클라이언트에는 realm-management 의 view-users·query-users·query-groups(그룹 구성원), view-realm(역할 보유자 조회에 필요 — 실제 Keycloak 26 에서 없으면 403)과
manage-users(사용자 쓰기, 스펙 2026-10-14-011 K1)를 준다. manage-users 가 없으면 쓰기는 403 이고 읽기는 그대로 된다.
발급자 주소(AAS_OIDC_ISSUER = https://<호스트>/realms/<realm>)에서 관리 API 주소를 만든다.
토큰은 캐시하지 않는다. 화면 동작 하나마다 한 번 받아(token()) 그 동작의 요청들에 넘긴다 — 권한을 바꾼 뒤 서버를 다시 시작하지 않아도 된다(C2).
"""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request

from ..common import config
from ..common.i18n import tr
from . import tls

PAGE = 100


class KeycloakError(Exception):
    def __init__(self, message: str, code: int = 0, detail: str = ""):
        super().__init__(message)
        self.code = code            # Keycloak 이 준 HTTP 상태(닿지 않았으면 0)
        self.detail = detail        # Keycloak 이 준 errorMessage(예: 「User exists with same email」). 409 의 겹친 칸을 가리는 데 쓴다


def is_service_account(u: dict) -> bool:
    """서비스 계정 사용자(service-account-aas-admin 등)는 사람이 아니다. 목록과 관리자 수에서 뺀다(C6)."""
    return bool(u.get("serviceAccountClientId")) or str(u.get("username") or "").startswith("service-account-")


def _enabled(u: dict) -> bool:
    return u.get("enabled", True) is not False          # 짧은 표현에 enabled 가 없으면 켜진 것으로 본다


class KeycloakAdmin:
    def __init__(self, issuer: str, client_id: str, client_secret: str, users_group: str, admin_role: str, timeout: float = 15.0):
        u = urllib.parse.urlsplit(issuer.rstrip("/"))
        head, sep, self.realm = u.path.rpartition("/realms/")
        if not sep or not self.realm:             # rpartition 은 구분자가 없으면 통째로 마지막 조각에 넣는다
            raise KeycloakError(tr("AAS_OIDC_ISSUER 가 …/realms/<realm> 모양이 아닙니다", "AAS_OIDC_ISSUER must look like …/realms/<realm>"))
        self.base = f"{u.scheme}://{u.netloc}{head}"
        self.issuer = issuer.rstrip("/")
        self.client_id, self.client_secret = client_id, client_secret
        self.users_group, self.admin_role, self.timeout = users_group, admin_role, timeout

    def _send(self, req: urllib.request.Request) -> tuple[object, dict]:
        """(JSON 본문, 응답 머리). 204 처럼 본문이 없으면 None. 거절은 KeycloakError(code, detail), 닿지 않으면 code 0."""
        try:
            with tls.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read()
                return json.loads(raw or b"null"), {k.lower(): v for k, v in resp.headers.items()}
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                body = json.loads(exc.read() or b"{}")
                detail = str(body.get("errorMessage") or body.get("error_description") or body.get("error") or "")[:200]
            except Exception:
                pass
            raise KeycloakError(tr(f"OIDC 가 거절했습니다 (HTTP {exc.code})", f"OIDC rejected the request (HTTP {exc.code})"), exc.code, detail) from None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
            raise KeycloakError(tr(f"OIDC 에 연결할 수 없습니다: {type(exc).__name__}", f"Cannot reach OIDC: {type(exc).__name__}")) from None

    def _open(self, req: urllib.request.Request):
        return self._send(req)[0]

    def token(self) -> str:
        """관리 API 토큰(client_credentials). 화면 동작 하나에 한 번 받아 아래 함수들의 token 으로 넘긴다."""
        body = urllib.parse.urlencode({"grant_type": "client_credentials", "client_id": self.client_id,
                                       "client_secret": self.client_secret}).encode()
        out = self._open(urllib.request.Request(self.issuer + "/protocol/openid-connect/token", data=body))
        token = (out or {}).get("access_token")
        if not token:
            raise KeycloakError(tr("OIDC 가 토큰을 주지 않았습니다", "OIDC returned no token"))
        return token

    def _request(self, token: str, method: str, path: str, body=None, **query) -> tuple[object, dict]:
        """관리 API(/admin/realms/<realm><path>)에 method 로 보낸다. body 가 있으면 JSON 으로 보낸다. (본문, 응답 머리)."""
        url = f"{self.base}/admin/realms/{urllib.parse.quote(self.realm)}{path}"
        if query:
            url += "?" + urllib.parse.urlencode(query)
        headers = {"Authorization": "Bearer " + token}
        data = None
        if body is not None:
            data, headers["Content-Type"] = json.dumps(body).encode(), "application/json"
        return self._send(urllib.request.Request(url, data=data, headers=headers, method=method))

    def _get(self, token: str, path: str, **query):
        return self._request(token, "GET", path, **query)[0]

    def _pages(self, token: str, path: str, **query) -> list[dict]:
        out, first = [], 0
        while True:
            page = self._get(token, path, first=first, max=PAGE, **query) or []
            out += page
            if len(page) < PAGE:
                return out
            first += PAGE

    @staticmethod
    def _q(value: str) -> str:
        return urllib.parse.quote(value, safe="")

    # ---- 그룹 -----------------------------------------------------------------
    def _group(self, token: str, name: str) -> dict | None:
        """이름이 정확히 같은 최상위 그룹. 없으면 None."""
        return next((g for g in (self._get(token, "/groups", search=name, exact="true") or []) if g.get("name") == name), None)

    def admin_groups(self, token: str) -> list[dict]:
        """관리자 역할(AAS_OIDC_ADMIN_ROLE)이 붙은 그룹(지금 aas-admins). 역할이 없으면(404) 빈 목록(O4)."""
        if not self.admin_role:
            return []
        try:
            return self._pages(token, f"/roles/{self._q(self.admin_role)}/groups")
        except KeycloakError as exc:
            if exc.code != 404:
                raise
            return []

    def _role_users(self, token: str) -> list[dict]:
        """관리자 역할을 직접 받은 사람. 역할이 없으면(404) 빈 목록. 권한 부족(403) 등은 오류로 올린다."""
        if not self.admin_role:
            return []
        try:
            return self._pages(token, f"/roles/{self._q(self.admin_role)}/users")
        except KeycloakError as exc:
            if exc.code != 404:
                raise
            return []

    def _admin_sets(self, token: str) -> tuple[dict[str, dict], dict[str, dict]]:
        """({id: 사용자} 역할을 직접 받은 사람, {id: 사용자} 역할이 붙은 그룹의 구성원)."""
        direct = {u["id"]: u for u in self._role_users(token)}
        via_group: dict[str, dict] = {}
        for g in self.admin_groups(token):
            for u in self._pages(token, f"/groups/{self._q(g['id'])}/members"):
                via_group[u["id"]] = u
        return direct, via_group

    def members(self) -> list[dict]:
        """[{id, email}]. 그룹도 역할도 찾지 못하면 빈 목록이 아니라 오류다(설정이 틀린 채 모두를 멈추지 않으려고).
        사용 중지(enabled=false)한 사람은 뺀다 — 빼지 않으면 대조가 그 사람의 Hermes 를 「돌아온 사람」으로 본다(R1)."""
        token = self.token()
        found: dict[str, dict] = {}
        if self.users_group:
            group = self._group(token, self.users_group)
            if not group:
                raise KeycloakError(tr(f"그룹 {self.users_group} 을 찾지 못했습니다", f"Group {self.users_group} not found"))
            for u in self._pages(token, f"/groups/{self._q(group['id'])}/members"):
                if _enabled(u):
                    found[u["id"]] = {"id": u["id"], "email": str(u.get("email") or "").lower()}
        if self.admin_role:
            # 역할을 그룹으로 받은 사람(예: 그룹 aas-admins 에 역할 aas-admin, 스펙 2026-10-13-012 D1)도 센다.
            # /roles/{role}/users 는 역할을 직접 받은 사람만 준다 — 빼면 aas-users 밖의 관리자가 「빠진 사람」이 된다
            direct, via_group = self._admin_sets(token)
            for u in [*direct.values(), *via_group.values()]:
                if _enabled(u):
                    found[u["id"]] = {"id": u["id"], "email": str(u.get("email") or "").lower()}
        return list(found.values())

    def admin_ids(self, token: str | None = None, enabled_only: bool = True) -> dict[str, str]:
        """{id: 이메일} 관리자(역할을 직접 받은 사람 + 역할이 붙은 그룹의 구성원). 기본은 사용 중인 사람만(O5) — 로그인 판정과 같은 규칙이다.
        「마지막 관리자」 계산이 쓴다. AAS_ADMINS 는 서버가 더한다."""
        direct, via_group = self._admin_sets(token or self.token())
        return {i: str(u.get("email") or "").lower() for i, u in {**direct, **via_group}.items()
                if (_enabled(u) or not enabled_only) and not is_service_account(u)}

    # ---- 목록 -----------------------------------------------------------------
    def list_users(self, token: str | None = None) -> list[dict]:
        """realm 의 사람 전부(전체 표현 — attributes 의 department 가 필요하다). 서비스 계정은 뺀다(C6)."""
        users = self._pages(token or self.token(), "/users", briefRepresentation="false")
        return [u for u in users if not is_service_account(u)]

    def directory(self, token: str | None = None) -> dict:
        """화면 목록에 필요한 것을 한 번에: {users, members(사용자 그룹 id), admin_group(관리자 그룹 구성원 id), admin_direct(역할 직접 id)}.
        요청 수는 사용자 수가 아니라 그룹 수에 비례한다(COP 방식, §10-2 성능)."""
        token = token or self.token()
        users = self.list_users(token)
        members: set[str] = set()
        if self.users_group:
            group = self._group(token, self.users_group)
            if group:
                members = {u["id"] for u in self._pages(token, f"/groups/{self._q(group['id'])}/members")}
        direct, via_group = self._admin_sets(token)
        return {"users": users, "members": members, "admin_group": set(via_group), "admin_direct": set(direct)}

    def find_by_email(self, email: str, token: str | None = None) -> list[dict]:
        """이메일이 정확히 같은 사람(대소문자 무시). 서비스 계정은 뺀다."""
        email = email.strip().lower()
        found = self._get(token or self.token(), "/users", email=email, exact="true", briefRepresentation="false") or []
        return [u for u in found if str(u.get("email") or "").lower() == email and not is_service_account(u)]

    def get_user(self, user_id: str, token: str | None = None) -> dict:
        return self._get(token or self.token(), f"/users/{self._q(user_id)}") or {}

    def is_member(self, email: str) -> bool:
        """그 사람이 지금 AAS 에 들어올 수 있는가 — 사용 중이고 사용자 그룹이나 관리자 역할(로그인 Auth._access 와 같은 규칙).
        Claude Code 연결 토큰이 5분마다 확인한다(스펙 2026-10-28-001 D12)."""
        token = self.token()
        found = [u for u in self.find_by_email(email, token) if _enabled(u)]
        if not found:
            return False
        uid = found[0]["id"]
        if not self.users_group:
            return True
        names = {str(g.get("name") or "").strip("/") for g in (self._get(token, f"/users/{self._q(uid)}/groups") or [])}
        return self.users_group in names or bool(self.admin_role and uid in self.admin_ids(token))

    # ---- 쓰기 -----------------------------------------------------------------
    def _users_group_id(self, token: str) -> str:
        group = self._group(token, self.users_group) if self.users_group else None
        if not group:
            raise KeycloakError(tr(f"그룹 {self.users_group} 을 찾지 못했습니다", f"Group {self.users_group} not found"), 404)
        return group["id"]

    def _admin_group(self, token: str) -> dict:
        groups = self.admin_groups(token)
        if not groups:
            raise KeycloakError(tr(f"역할 {self.admin_role} 이 붙은 그룹을 찾지 못했습니다", f"No group has the {self.admin_role} role"), 404)
        return groups[0]

    def create_user(self, username: str, email: str, first_name: str, last_name: str, department: str, password: str,
                    admin: bool = False, token: str | None = None) -> str:
        """사용자를 만들고 Keycloak id(= 토큰의 sub)를 돌려준다. 409 는 아이디·이메일 중복이다.
        emailVerified 를 반드시 켠다 — AAS 로그인 검사가 email_verified 를 본다(auth._validate). 비밀번호는 임시(첫 로그인 때 바꾼다, K4)."""
        token = token or self.token()
        groups = ["/" + self.users_group] if self.users_group else []
        if admin:
            g = self._admin_group(token)
            groups.append(str(g.get("path") or "/" + g["name"]))
        body = {"username": username, "email": email, "firstName": first_name, "lastName": last_name,
                "enabled": True, "emailVerified": True, "attributes": {"department": [department]} if department else {},
                "credentials": [{"type": "password", "value": password, "temporary": True}], "groups": groups}
        _, headers = self._request(token, "POST", "/users", body)
        user_id = str(headers.get("location") or "").rstrip("/").rsplit("/", 1)[-1]
        if not user_id:
            raise KeycloakError(tr("OIDC 가 만든 사용자의 id 를 주지 않았습니다", "OIDC returned no id for the new user"))
        return user_id

    def update_user(self, user_id: str, changes: dict, token: str | None = None) -> dict:
        """GET 한 전체 표현에 바꿀 칸만 고쳐 PUT 한다. 일부만 보내면 Keycloak 26 에서 department 같은 속성이 지워질 수 있다(O7).
        changes 의 키: firstName·lastName·enabled·department(빈 값이면 속성을 지운다). 아이디·이메일은 받지 않는다(R2)."""
        token = token or self.token()
        rep = self.get_user(user_id, token)
        for key in ("firstName", "lastName", "enabled"):
            if key in changes:
                rep[key] = changes[key]
        if "department" in changes:
            attrs = dict(rep.get("attributes") or {})
            if changes["department"]:
                attrs["department"] = [changes["department"]]
            else:
                attrs.pop("department", None)
            rep["attributes"] = attrs
        self._request(token, "PUT", f"/users/{self._q(user_id)}", rep)
        return rep

    def set_member(self, user_id: str, on: bool, token: str | None = None) -> None:
        """사용자 그룹(들어올 자격)에 넣거나 뺀다(K8 「AAS 에 추가」)."""
        token = token or self.token()
        self._request(token, "PUT" if on else "DELETE", f"/users/{self._q(user_id)}/groups/{self._q(self._users_group_id(token))}")

    def set_admin(self, user_id: str, on: bool, token: str | None = None) -> None:
        """관리자로 올리기 = 관리자 그룹에 넣기(역할을 직접 주지 않는다). 내리기 = 관리자 그룹들과 직접 받은 역할을 빼고,
        사용자 그룹에 없으면 넣는다 — 관리자는 그룹 검사를 건너뛰어 사용자 그룹에 없을 수 있다. 그대로 빼면 로그인을 잃는다(O6)."""
        token = token or self.token()
        uid = self._q(user_id)
        if on:
            self._request(token, "PUT", f"/users/{uid}/groups/{self._q(self._admin_group(token)['id'])}")
            return
        mine = {g["id"] for g in (self._get(token, f"/users/{uid}/groups") or [])}
        for g in self.admin_groups(token):
            if g["id"] in mine:
                self._request(token, "DELETE", f"/users/{uid}/groups/{self._q(g['id'])}")
        if self.admin_role:
            direct = [r for r in (self._get(token, f"/users/{uid}/role-mappings/realm") or []) if r.get("name") == self.admin_role]
            if direct:                                    # 역할을 직접 받았으면 그것도 뺀다. 남기면 내려도 관리자다
                self._request(token, "DELETE", f"/users/{uid}/role-mappings/realm", direct)
        if self.users_group:
            gid = self._users_group_id(token)
            if gid not in mine:
                self._request(token, "PUT", f"/users/{uid}/groups/{self._q(gid)}")

    def reset_password(self, user_id: str, password: str, token: str | None = None, temporary: bool = True) -> None:
        """비밀번호를 바꾼다. 기본은 임시 비밀번호(첫 로그인 때 사용자가 바꾼다, K4). 본인이 바꿀 때는 temporary=False(스펙 2026-10-14-017)."""
        self._request(token or self.token(), "PUT", f"/users/{self._q(user_id)}/reset-password",
                      {"type": "password", "value": password, "temporary": bool(temporary)})

    def verify_password(self, username: str, password: str) -> bool:
        """그 사용자의 현재 비밀번호가 맞는가(스펙 2026-10-14-017 S3). 관리 클라이언트로 password grant 를 보내 본다.
        맞으면 참, 틀리면(invalid_grant·401) 거짓, 그 밖의 거절·연결 실패는 KeycloakError. 받은 토큰은 쓰지 않고 버린다.
        비밀번호는 로그·오류 문장에 넣지 않는다."""
        body = urllib.parse.urlencode({"grant_type": "password", "client_id": self.client_id, "client_secret": self.client_secret,
                                       "username": username, "password": password, "scope": "openid"}).encode()
        try:
            self._open(urllib.request.Request(self.issuer + "/protocol/openid-connect/token", data=body))
            return True
        except KeycloakError as exc:
            if exc.code in (400, 401) and exc.detail in ("Invalid user credentials", "invalid_grant", "Account disabled", "Account is not fully set up", ""):
                return False
            raise

    def logout_user(self, user_id: str, token: str | None = None) -> None:
        """그 사람의 Keycloak 세션을 모두 끝낸다."""
        self._request(token or self.token(), "POST", f"/users/{self._q(user_id)}/logout")

    def set_enabled(self, user_id: str, enabled: bool, token: str | None = None) -> None:
        """사용 중지·다시 사용. 사용 중지면 Keycloak 세션도 끝낸다."""
        token = token or self.token()
        self.update_user(user_id, {"enabled": bool(enabled)}, token)
        if not enabled:
            self.logout_user(user_id, token)

    def delete_user(self, user_id: str, token: str | None = None) -> None:
        self._request(token or self.token(), "DELETE", f"/users/{self._q(user_id)}")


def admin_from_config() -> KeycloakAdmin | None:
    """설정에서 만든 관리 클라이언트. 발급자·클라이언트 정보가 없으면 None(대조를 하지 않는다)."""
    issuer, cid, secret = config.get("AAS_OIDC_ISSUER"), config.get("AAS_KEYCLOAK_ADMIN_CLIENT_ID"), config.get("AAS_KEYCLOAK_ADMIN_CLIENT_SECRET")
    if not (issuer and cid and secret):
        return None
    # 클러스터 안에서는 내부 주소(AAS_OIDC_DISCOVERY_URL)로 닿는다. 공개 주소는 사설 인증서일 수 있다.
    issuer = config.get("AAS_OIDC_DISCOVERY_URL").strip() or issuer
    return KeycloakAdmin(issuer, cid, secret, config.get("AAS_OIDC_USERS_GROUP", "aas-users").strip().strip("/"),
                         config.get("AAS_OIDC_ADMIN_ROLE", "aas-admin").strip())
