# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""이름·ID·버전처럼 값 전체를 검사하는 정규식은 끝을 \\Z 로 맺는다(스펙 2026-11-14-016, OMAI-2027).
파이썬의 $ 는 끝 줄바꿈 하나를 통과시켜 "name\\n" 이 이름 검사를 지난다. 줄을 나눠 읽는 정규식은 대상이 아니다."""
import importlib
import unittest
from unittest import mock

VALIDATORS = [
    ("aas.market.marketplace", "NAME"), ("aas.market.marketplace", "PROFILE"), ("aas.market.marketplace", "VERSION"),
    ("aas.market.marketplace", "_SKILL"), ("aas.market.market_publish", "_RID"), ("aas.market.market_publish", "ENV_NAME"),
    ("aas.market.market_dispatch", "_RID"), ("aas.fleet.profiles", "NAME"), ("aas.fleet.profiles", "ENV_KEY"),
    ("aas.fleet.rollouts", "DIGEST"), ("aas.fleet.agents", "EMAIL"), ("aas.fleet.agents", "_CPU_IN"),
    ("aas.fleet.agents", "_MEM_IN"), ("aas.fleet.agents", "_QTY"), ("aas.office.hub_auto", "SLUG"),
    ("aas.office.hub_auto", "_PROFILE_NAME"), ("aas.office.office", "ID"), ("aas.office.office", "EMAIL"),
    ("aas.web.server", "SKILL_DELETE_NAME"), ("aas.web.credential_files", "NAME"), ("aas.web.credential_files", "PATH"),
    ("aas.common.soul_templates", "ID"), ("aas.ops.pc_import", "_ID"), ("aas.ops.pc_import", "_ENV_NAME"),
    ("aas.ops.bundled_repair", "PROFILE_RE"), ("aas.ops.owner_guard", "_USER_ID"), ("aas.ops.owner_guard", "_SERVER_URL"),
    ("aas.ops.mcp_servers", "NAME"), ("aas.ops.mcp_servers", "ENV_NAME"), ("aas.assets.script_refs", "_HOST_OK"),
    ("aas.assets.skill_setup", "_ENV_NAME"), ("aas.assets.skill_header", "_ENV_NAME"), ("aas.assets.files", "KEY"),
]


class ValidatorRegexTest(unittest.TestCase):
    def test_whole_value_validators_end_with_backslash_z(self):
        for mod, name in VALIDATORS:
            pat = getattr(importlib.import_module(mod), name).pattern
            self.assertTrue(pat.endswith("\\Z"), f"{mod}.{name}: {pat}")
            self.assertNotIn("$", pat, f"{mod}.{name}")

    def test_trailing_newline_is_refused(self):
        from aas.fleet import profiles, rollouts
        from aas.market import marketplace as mp
        from aas.ops import mcp_servers
        for rx, ok in ((mp.NAME, "free"), (mp.PROFILE, "main"), (mp.VERSION, "1.2.3"), (profiles.NAME, "main"),
                       (mcp_servers.NAME, "jira"), (rollouts.DIGEST, "r/x@sha256:" + "0" * 64)):
            self.assertTrue(rx.match(ok), (rx.pattern, ok))
            self.assertIsNone(rx.match(ok + "\n"), (rx.pattern, ok))


class K8sPathSegmentTest(unittest.TestCase):
    """경로 조각은 / 까지 인코딩한다(스펙 2026-11-14-016). 이름에 / 가 섞여도 다른 리소스 경로가 되지 않는다."""

    def test_names_are_encoded_as_one_segment(self):
        from aas.fleet import k8s
        c = k8s.K8s("ns/x", api="http://127.0.0.1:9")
        seen = []
        with mock.patch.object(c, "call", side_effect=lambda m, p, *a, **k: seen.append(p) or {}):
            c.get_agent("a/../b"); c.patch_agent("a/b", {}); c.delete_agent("a/b")
            c.get_task("t/1"); c.delete_task("t/1")
        for p in seen:
            self.assertIn("/namespaces/ns%2Fx/", p)
            self.assertNotIn("a/", p.split("/namespaces/")[1].split("/", 2)[-1].replace("hermesagents/", "").replace("hermestasks/", ""))
        self.assertTrue(seen[0].endswith("/a%2F..%2Fb"))


if __name__ == "__main__":
    unittest.main()
