# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""목록·평가·파일·설명·모델·채널 묶음의 서버 문장이 요청 언어를 따르는지 시험한다."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.ops import channels, models
from aas.assets import credentials, files, inventory
from aas.common import i18n  # noqa: E402


def both(fn):
    """같은 호출을 영어와 한국어로 한 번씩 해서 (영어, 한국어) 를 돌려준다."""
    try:
        i18n.set_lang("en")
        en = fn()
        i18n.set_lang("ko")
        ko = fn()
    finally:
        i18n.set_lang("ko")
    return en, ko


class InventoryTest(unittest.TestCase):
    def tearDown(self):
        i18n.set_lang("ko")

    def test_register_errors(self):
        def msg():
            with self.assertRaises(ValueError) as cm:
                inventory.register("bogus", "k", "review")
            return str(cm.exception)
        self.assertEqual(both(msg), ("Unknown kind", "알 수 없는 종류"))

    def test_interface_label(self):
        self.assertEqual(both(lambda: inventory._iface("TELEGRAM_BOT_TOKEN")), ("Channel", "채널"))
        self.assertEqual(both(lambda: inventory._iface("GOOGLE_KEY")), ("REST API (Google)", "REST API(구글)"))

    def test_tools_labels(self):
        home = Path(TMP.name) / "invhome"
        (home / "scripts").mkdir(parents=True)
        (home / "cron").mkdir()
        (home / "scripts" / "pull.py").write_text('"""지표."""\nimport os\n', encoding="utf-8")
        (home / "cron" / "jobs.json").write_text('{"jobs": [{"id": "a", "name": "daily", "script": "pull.py"}]}')
        item = lambda: inventory.tools(home)["items"][0]
        en, ko = both(lambda: (item()["kind"], item()["used_by"]))
        self.assertEqual(en, ("Shared script", ["Scheduled job daily"]))     # UI(bits.tsx)가 cron/skill/script 접두어를 읽는다
        self.assertEqual(ko, ("공용 스크립트", ["예약 작업 daily"]))

    def test_scope_values_stay_korean(self):
        # UI 가 맞대어 보는 값이라 언어와 상관없이 한국어다
        self.assertEqual((inventory.GLOBAL, inventory.PROFILE), ("전역", "프로파일"))


class FilesTest(unittest.TestCase):
    def tearDown(self):
        i18n.set_lang("ko")

    def test_errors_follow_language(self):
        def msg():
            with self.assertRaises(files.FileError) as cm:
                files.resolve(Path(TMP.name), "../etc/passwd")
            return str(cm.exception)
        self.assertEqual(both(msg), ("This location cannot be viewed", "볼 수 없는 위치입니다"))

    def test_conflict_message_is_translated_and_code_is_409(self):
        home = Path(TMP.name) / "home"
        (home / "skills" / "s").mkdir(parents=True)
        (home / "skills" / "s" / "SKILL.md").write_text("---\nname: s\n---\nx\n", encoding="utf-8")

        def msg():
            with self.assertRaises(files.FileError) as cm:
                files.save(home, "pod", "skills/s/SKILL.md", "---\nname: s\n---\ny\n", "stale", "u", lambda *a: None)
            return str(cm.exception), cm.exception.code
        en, ko = both(msg)
        self.assertIn("그사이", ko[0])
        self.assertIn("in the meantime", en[0])
        self.assertEqual((en[1], ko[1]), (409, 409))          # UI 는 문장이 아니라 상태 코드로 충돌을 가린다

    @staticmethod
    def _drop_versions(pod):
        with files.store.connect() as conn:
            conn.execute("DELETE FROM file_versions WHERE pod=?", (pod,))

    def test_unchanged_after_save_does_not_send_people_to_a_screen_they_cannot_open(self):
        """Hermes 가 저장했다고 답했는데 그대로일 때. 사용자가 들어갈 수 없는 Hermes 웹 화면을 안내하지 않는다(OMAI-1462)."""
        home = Path(TMP.name) / "home-unchanged"
        (home / "skills" / "s").mkdir(parents=True)
        current = "---\nname: s\n---\nx\n"
        (home / "skills" / "s" / "SKILL.md").write_text(current, encoding="utf-8")
        self.addCleanup(self._drop_versions, "pod-unchanged")                       # 「고치기 전」 판이 공유 데이터 폴더에 남는다

        def file_msg():
            with self.assertRaises(files.FileError) as cm:
                files.save(home, "pod-unchanged", "skills/s/SKILL.md", "---\nname: s\n---\ny\n", files.text_sha(current), "u", lambda *a: None)
            return str(cm.exception), cm.exception.code

        def text_msg():
            with self.assertRaises(files.FileError) as cm:
                files.save_text("pod-unchanged", "soul:main", "옛 내용\n", "새 내용\n", files.text_sha("옛 내용\n"), "u",
                                lambda c: None, lambda: "옛 내용\n", remember_before=False)
            return str(cm.exception), cm.exception.code

        for fn in (file_msg, text_msg):
            en, ko = both(fn)
            self.assertEqual((en[1], ko[1]), (502, 502))
            self.assertNotIn("대시보드", ko[0])
            self.assertNotIn("dashboard", en[0])
            self.assertIn("관리자에게 알려 주세요", ko[0])
            self.assertIn("tell your administrator", en[0])

    def test_diff_header_and_masked_value(self):
        home = Path(TMP.name) / "home2"
        (home / "skills" / "s").mkdir(parents=True)
        (home / "skills" / "s" / "SKILL.md").write_text("---\nname: s\n---\nx\n", encoding="utf-8")
        en, ko = both(lambda: files.diff(home, "pod", "skills/s/SKILL.md", None, "---\nname: s\n---\ny\n")["lines"][:2])
        self.assertEqual(en, ["--- Before", "+++ To save"])
        self.assertEqual(ko, ["--- 이전", "+++ 저장할 내용"])
        def masked():
            with self.assertRaises(files.FileError) as cm:
                files.check("skills/s/SKILL.md", "---\n" + files.MASK)
            return str(cm.exception)
        en, ko = both(masked)
        self.assertIn(files.MASK, en)
        self.assertIn("가려진 값", ko)


class ModelsChannelsTest(unittest.TestCase):
    def tearDown(self):
        i18n.set_lang("ko")

    def test_litellm_errors(self):
        with mock.patch.dict(os.environ, {"AAS_LITELLM_URL": "", "AAS_K8S_NAMESPACE": "ns"}):     # 쿠버네티스(운영 LiteLLM) 문구
            en, ko = both(lambda: models.fetch_litellm("", "")["error"])
        self.assertEqual(en, "The LiteLLM address (AAS_LITELLM_URL) is not set")
        self.assertEqual(ko, "LiteLLM 주소(AAS_LITELLM_URL)가 설정되지 않았습니다")

    def test_probe_without_key(self):
        with mock.patch.dict(os.environ, {"AAS_LITELLM_URL": "http://127.0.0.1:1", "AAS_LITELLM_KEY": "", "AAS_K8S_NAMESPACE": "ns"}), \
                mock.patch.object(models.hr, "profiles", return_value=[]):
            en, ko = both(lambda: models.probe("m")["error"])
        self.assertEqual((en, ko), ("No key", "키가 없습니다"))

    def test_key_source(self):
        with mock.patch.dict(os.environ, {"AAS_LITELLM_KEY": ""}):
            en, ko = both(lambda: models._resolve_key("k")[1])
        self.assertEqual((en, ko), ("Profile config", "프로파일 설정"))

    def test_channel_issues(self):
        home = Path(TMP.name) / "chhome"
        (home / "cron").mkdir(parents=True)
        (home / "cron" / "jobs.json").write_text('{"jobs": [{"id": "a", "name": "daily", "enabled": true, "deliver": "telegram:1"}]}')
        svc = {"default": {"up": False, "disabled": True, "status": ""}}
        with mock.patch.object(channels, "service_status", return_value=svc):
            en, ko = both(lambda: channels.collect(home)["profiles"][0]["issues"][0]["text"])
        self.assertTrue(en.startswith("The gateway is off, so 1 active scheduled jobs do not run (turned off on purpose with an s6 down file)"))
        self.assertTrue(ko.startswith("게이트웨이가 꺼져 있어 활성 예약 작업 1개가 돌지 않음 (s6 down 파일로 일부러 꺼 둠)"))

    def test_credentials_error(self):
        with mock.patch.object(credentials.k8s, "client", return_value=None):
            def msg():
                with self.assertRaises(credentials.k8s.K8sError) as cm:
                    credentials.secret_values("x")
                return str(cm.exception)
            en, ko = both(msg)
        self.assertEqual(en, "Not running in Kubernetes mode (AAS_K8S_NAMESPACE)")
        self.assertEqual(ko, "쿠버네티스 모드가 아닙니다(AAS_K8S_NAMESPACE)")


class EvaluateExplainTest(unittest.TestCase):
    def tearDown(self):
        i18n.set_lang("ko")

    def test_explain_titles_and_unknown(self):
        from aas.assets import explain
        self.assertEqual(both(lambda: explain._title("cred")), ("API keys & tokens it uses", "쓰는 API 키·토큰"))
        index = {"nodes": {}, "skill_ids": {}}
        en, ko = both(lambda: explain.build(index, Path(TMP.name), "default", "", "", None, {"running": False})["checks"][0]["text"])
        self.assertTrue(en.startswith("The gateway of default is off."))
        self.assertTrue(ko.startswith("default 의 게이트웨이가 꺼져 있습니다"))


if __name__ == "__main__":
    unittest.main()
