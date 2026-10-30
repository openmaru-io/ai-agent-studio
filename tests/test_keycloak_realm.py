# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""AAS Keycloak realm(aas) 파일의 로그인 설정 시험 — 아이디(예: aas-test)와 이메일 둘 다로 로그인한다(OMAI-1124).

realm 파일은 새로 설치할 때만 들어간다(`--import-realm` 은 이미 있는 realm 을 덮지 않는다). 그래서 기본값에 기대지 않고 값을 적어 둔다.
COP 차트(openmaru-cop-helm-chart/charts/openmaru-cogentai-aas/files/realm-aas.json)도 같은 내용이어야 한다.
"""
import json
import unittest
from pathlib import Path

REALM = Path(__file__).resolve().parents[1] / "deploy" / "k8s" / "keycloak" / "realm-aas.json"


class RealmLoginTest(unittest.TestCase):
    def setUp(self):
        self.realm = json.loads(REALM.read_text(encoding="utf-8"))

    def test_아이디와_이메일_둘_다로_로그인한다(self):
        self.assertIs(self.realm.get("registrationEmailAsUsername"), False)   # 켜면 아이디가 곧 이메일이라 「aas-test」로 못 들어간다
        self.assertIs(self.realm.get("loginWithEmailAllowed"), True)
        self.assertIs(self.realm.get("duplicateEmailsAllowed"), False)         # 이메일로 들어올 때 한 사람으로 정해져야 한다

    def test_로그인_화면은_한국어를_지원하고_기본이_한국어다(self):
        """다국어를 켜지 않으면 Keycloak 은 브라우저 언어와 무관하게 영어로만 그린다(OMAI-1245, OKE 에서 SSO 팝업이 영문). 영어를 쓰는 브라우저는 영어로 나온다."""
        self.assertIs(self.realm.get("internationalizationEnabled"), True)
        self.assertEqual(self.realm.get("supportedLocales"), ["ko", "en"])
        self.assertEqual(self.realm.get("defaultLocale"), "ko")

    def test_사용자는_자기_아이디를_고치지_않는다(self):
        self.assertIs(self.realm.get("editUsernameAllowed"), False)            # 아이디는 관리자만 고친다

    def test_아이디_속성은_관리자가_볼_수_있다(self):
        """editUsernameAllowed=false 면 Keycloak 은 관리자 API 로도 아이디를 바꾸지 못한다(error-user-attribute-read-only, 2026-10-13 OKE).
        이미 있는 계정의 아이디를 바꿀 때는 잠시 true 로 바꾸고 끝나면 되돌린다(스펙 §2-2). 여기서는 아이디 속성이 사용자 프로필에 있는지만 본다."""
        profile = next(c for c in self.realm["components"]["org.keycloak.userprofile.UserProfileProvider"])
        attrs = {a["name"]: a for a in json.loads(profile["config"]["kc.user.profile.config"][0])["attributes"]}
        self.assertIn("admin", attrs["username"]["permissions"]["view"])

    def test_서비스_계정은_사용자를_만들고_고칠_수_있다(self):
        """「사용자·권한」 화면이 Keycloak 사용자를 만든다(스펙 2026-10-14-011 K1). 읽기 역할도 그대로 둔다(하루 1회 대조)."""
        sa = next(u for u in self.realm["users"] if u.get("serviceAccountClientId") == "aas-admin")
        roles = sa["clientRoles"]["realm-management"]
        for role in ("manage-users", "view-users", "query-users", "query-groups", "view-realm"):
            self.assertIn(role, roles)

    def test_본인_비밀번호_확인은_aas_admin_만_직접_액세스를_쓴다(self):
        """본인이 비밀번호를 바꿀 때 서버가 현재 비밀번호를 password grant 로 확인한다(스펙 2026-10-14-017 S3). 사람이 로그인하는 aas 는 계속 끈다."""
        clients = {c["clientId"]: c for c in self.realm["clients"]}
        self.assertIs(clients["aas-admin"].get("directAccessGrantsEnabled"), True)
        self.assertIs(clients["aas"].get("directAccessGrantsEnabled"), False)
        self.assertIs(clients["aas-admin"].get("standardFlowEnabled"), False)    # 사람이 이 클라이언트로 로그인하지는 못한다

    def test_비밀번호는_8자_이상(self):
        self.assertEqual(self.realm.get("passwordPolicy"), "length(8)")           # 서버도 8자 미만을 먼저 거른다

    def test_이메일은_관리자만_고친다(self):
        """사용자가 계정 화면에서 이메일을 바꾸면 emailVerified 가 꺼져 AAS 로그인이 막힌다(O2). AAS 는 이메일을 열쇠로 쓴다(R2)."""
        profile = next(c for c in self.realm["components"]["org.keycloak.userprofile.UserProfileProvider"])
        attrs = {a["name"]: a for a in json.loads(profile["config"]["kc.user.profile.config"][0])["attributes"]}
        self.assertEqual(attrs["email"]["permissions"]["edit"], ["admin"])
        self.assertIn("user", attrs["email"]["permissions"]["view"])
        self.assertEqual(attrs["department"]["permissions"]["edit"], ["admin"])

if __name__ == "__main__":
    unittest.main()
