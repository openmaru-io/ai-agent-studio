# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""AAS 기본 스킬 묶음을 스킬 허브에 게시(스펙 2026-10-29-001 R1·R13·F7, OMAI-1534).

허브 판이 없거나 묶음 판보다 낮을 때만 게시 전용 토큰(aas-admin)으로 free 에 게시한다. 같거나 높으면 건너뛴다(되돌리기를 막는다).
검토 대기(pending_review)·실패한 판은 같은 판을 다시 보내지 않는다. 토큰이나 허브 주소가 없으면 아무것도 하지 않는다.
"""
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import store  # noqa: E402
from aas.market import bundle_publish, market_publish, marketplace, skill_bundle  # noqa: E402
from aas.market.marketplace import MarketError  # noqa: E402


def _hub(versions: dict):
    """fetch 대역: versions = {이름: 허브 판 또는 None(없음)}."""
    def fetch(path, cfg=None):
        name = path.rsplit("/", 1)[-1]
        v = versions.get(name)
        if v is None:
            raise MarketError("없음", 404)
        return {"publishedVersion": {"version": v}}
    return fetch


class BundlePublishTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        tok = Path(self.dir.name) / "publish-token"
        tok.write_text("t-publish\n", encoding="utf-8")
        env = {"AAS_SKILLHUB_URL": "http://hub", "AAS_SKILLHUB_TOKEN_FILE": str(Path(self.dir.name) / "read-token"),
               bundle_publish.TOKEN_ENV: str(tok)}
        p = mock.patch.dict(os.environ, env)
        p.start()
        self.addCleanup(p.stop)
        bundle_publish.reset()
        with store.connect() as conn:
            conn.execute("DELETE FROM meta WHERE key LIKE ?", (bundle_publish.KEY + "%",))
        self.names = skill_bundle.names()
        self.version = {n: skill_bundle.front(n)["version"] for n in self.names}
        self.posts = []

    def _post(self, status=200, body=None):
        def post(namespace, name, version, blob, token=None):
            self.posts.append((namespace, name, version, token, len(blob)))
            return status, body if body is not None else {"code": 0, "data": {"status": "PUBLISHED"}}
        return post

    def test_publishes_missing_and_lower_versions_with_the_publish_token(self):
        hub = {self.names[0]: None, self.names[1]: "0.9.0"}
        hub.update({n: self.version[n] for n in self.names[2:]})
        with mock.patch.object(marketplace, "fetch", _hub(hub)), mock.patch.object(market_publish, "_post", self._post()):
            done = bundle_publish.publish_once()
        self.assertEqual(sorted(p[1] for p in self.posts), sorted(self.names[:2]))
        self.assertTrue(all(p[0] == "free" and p[3] == "t-publish" and p[4] > 0 for p in self.posts))
        self.assertEqual(sorted(done), sorted(f"{n} {self.version[n]}" for n in self.names[:2]))

    def test_higher_hub_version_is_left_alone(self):
        with mock.patch.object(marketplace, "fetch", _hub({n: "9.0.0" for n in self.names})), \
                mock.patch.object(market_publish, "_post", self._post()):
            bundle_publish.publish_once()
        self.assertEqual(self.posts, [])

    def test_pending_review_and_failure_are_not_sent_again_for_the_same_version(self):
        hub = _hub({n: None for n in self.names})
        with mock.patch.object(marketplace, "fetch", hub), \
                mock.patch.object(market_publish, "_post", self._post(body={"code": 0, "data": {"status": "PENDING_REVIEW"}})):
            bundle_publish.publish_once()
        self.assertEqual(len(self.posts), len(self.names))
        bundle_publish.reset()                                    # 다음 주기(시간 제한 지남)
        with mock.patch.object(marketplace, "fetch", hub), mock.patch.object(market_publish, "_post", self._post(500, {"msg": "x"})):
            bundle_publish.publish_once()
        self.assertEqual(len(self.posts), len(self.names))        # 검토 대기인 판은 다시 보내지 않는다
        self.assertEqual({bundle_publish.state(n)["status"] for n in self.names}, {"pending_review"})

    def test_failure_is_recorded_once_and_not_retried_for_that_version(self):
        hub = _hub({n: None for n in self.names})
        with mock.patch.object(marketplace, "fetch", hub), mock.patch.object(market_publish, "_post", self._post(500, {"msg": "boom"})):
            bundle_publish.publish_once()
            bundle_publish.reset()
            bundle_publish.publish_once()
        self.assertEqual(len(self.posts), len(self.names))
        row = bundle_publish.state(self.names[0])
        self.assertEqual((row["status"], row["version"]), ("failed", self.version[self.names[0]]))
        self.assertIn("500", row["message"])

    def test_already_existing_version_counts_as_published(self):
        hub = _hub({n: None for n in self.names})
        with mock.patch.object(marketplace, "fetch", hub), \
                mock.patch.object(market_publish, "_post", self._post(400, {"msg": "Version already exists"})):
            bundle_publish.publish_once()
        self.assertEqual({bundle_publish.state(n)["status"] for n in self.names}, {"published"})

    def test_token_defaults_to_publish_token_next_to_the_server_token(self):
        """COP 차트는 Secret aas-skillhub-token 전체를 붙인다 — 그 안의 publish-token 키를 따로 설정 없이 읽는다(§9-6a)."""
        d = Path(self.dir.name) / "mount"
        d.mkdir()
        (d / "publish-token").write_text("t-mounted\n", encoding="utf-8")
        hub = _hub({n: None for n in self.names})
        with mock.patch.dict(os.environ, {"AAS_SKILLHUB_TOKEN_FILE": str(d / "token"), bundle_publish.TOKEN_ENV: ""}), \
                mock.patch.object(marketplace, "fetch", hub), mock.patch.object(market_publish, "_post", self._post()):
            bundle_publish.publish_once()
        self.assertEqual(len(self.posts), len(self.names))

    def test_nothing_without_token_or_hub_url(self):
        with mock.patch.dict(os.environ, {bundle_publish.TOKEN_ENV: str(Path(self.dir.name) / "none")}), \
                mock.patch.object(market_publish, "_post", self._post()):
            self.assertEqual(bundle_publish.publish_once(), [])
        with mock.patch.dict(os.environ, {"AAS_SKILLHUB_URL": ""}), mock.patch.object(market_publish, "_post", self._post()):
            bundle_publish.reset()
            self.assertEqual(bundle_publish.publish_once(), [])
        self.assertEqual(self.posts, [])

    def test_runs_at_most_once_per_interval(self):
        hub = _hub({n: None for n in self.names})
        with mock.patch.object(marketplace, "fetch", hub) as _f, mock.patch.object(market_publish, "_post", self._post()):
            bundle_publish.publish_once()
            bundle_publish.publish_once()                         # 시간 제한 안 — 허브를 다시 묻지 않는다
        self.assertEqual(len(self.posts), len(self.names))

    def test_hub_unreachable_skips_without_recording(self):
        def down(path, cfg=None):
            raise MarketError("연결 안 됨", 503)
        with mock.patch.object(marketplace, "fetch", down), mock.patch.object(market_publish, "_post", self._post()):
            self.assertEqual(bundle_publish.publish_once(), [])
        self.assertEqual(self.posts, [])
        self.assertIsNone(bundle_publish.state(self.names[0]))

    def test_zip_has_the_package_files_at_its_root(self):
        import io
        import zipfile
        blob = bundle_publish.package_zip("markdown-to-doc")
        names = zipfile.ZipFile(io.BytesIO(blob)).namelist()
        self.assertIn("SKILL.md", names)
        self.assertIn("scripts/md_to_xlsx.py", names)
        self.assertFalse(any("__pycache__" in n for n in names))


class PostTokenTest(unittest.TestCase):
    def test_post_uses_the_given_token_instead_of_the_read_token(self):
        seen = {}

        class Resp:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return b'{"code": 0}'

        def urlopen(req, timeout=0):
            seen["auth"] = req.get_header("Authorization")
            return Resp()
        with tempfile.TemporaryDirectory() as d:
            read = Path(d) / "read"
            read.write_text("t-read", encoding="utf-8")
            with mock.patch.dict(os.environ, {"AAS_SKILLHUB_URL": "http://hub", "AAS_SKILLHUB_TOKEN_FILE": str(read)}), \
                    mock.patch("urllib.request.urlopen", urlopen):
                market_publish._post("free", "x", "1.0.0", b"z", token="t-publish")
                self.assertEqual(seen["auth"], "Bearer t-publish")
                market_publish._post("free", "x", "1.0.0", b"z")
                self.assertEqual(seen["auth"], "Bearer t-read")


if __name__ == "__main__":
    unittest.main()
