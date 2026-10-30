# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""프로파일 설정 복사(스펙 2026-10-15-011 D6·D8): 새 프로파일용 변환과 다른 에이전트에서 가져오기 변환."""
import unittest

import yaml

from aas.ops import owner_guard, profile_copy as pc

SRC = """
model: src-model
providers: {litellm: {api: http://src}}
display: {theme: dark}
agent: {name: 소스}
telegram: {allowed_users: ['1']}
mcp_servers: {x: {url: http://x, headers: {Authorization: Bearer abc}}}
skills: {external_dirs: [/opt/data/skills]}
terminal: {backend: docker, docker_image: foo, cwd: /work}
approvals: {mode: "off"}
"""
DEST = """
model: dest-model
providers: {litellm: {api: http://dest}}
display: {theme: light}
terminal: {backend: local, cwd: /home}
skills: {external_dirs: []}
approvals: {mode: smart}
"""


class CopyTest(unittest.TestCase):
    def test_for_new_profile_drops_only_channel_blocks(self):
        out = yaml.safe_load(pc.for_new_profile(SRC))
        self.assertNotIn("telegram", out)
        self.assertEqual((out["model"], out["mcp_servers"]["x"]["url"]), ("src-model", "http://x"))       # 같은 파드의 원본 설정은 그대로 둔다

    def test_import_keeps_the_receivers_locked_values_and_takes_the_safe_ones(self):
        out = yaml.safe_load(pc.import_overlay(DEST, SRC))
        self.assertEqual((out["model"], out["providers"]["litellm"]["api"]), ("dest-model", "http://dest"))        # 모델·제공자는 받는 쪽
        self.assertEqual((out["display"]["theme"], out["agent"]["name"]), ("dark", "소스"))                         # 안전한 키는 가져온다
        self.assertNotIn("telegram", out)                                                                           # 채널은 가져오지 않는다
        self.assertNotIn("mcp_servers", out)                                                                        # MCP 서버(인증값 가능)도
        self.assertEqual(out["skills"], {"external_dirs": []})                                                      # skills 는 받는 쪽
        self.assertEqual(out["terminal"], {"backend": "local", "cwd": "/work"})                                     # 실행 위치 키는 받는 쪽, 나머지는 가져온다
        self.assertEqual(out["approvals"], {"mode": "smart"})                                                       # 승인 설정은 받는 쪽(OMAI-1460 D2)

    def test_the_result_passes_the_owner_lock_check(self):
        self.assertEqual(owner_guard.config_error(DEST, pc.import_overlay(DEST, SRC)), "")

    def test_skipped_keys_and_bad_yaml(self):
        self.assertEqual(pc.skipped_keys(SRC), ["mcp_servers", "providers", "skills", "telegram", "model"][0:0] or sorted(["approvals", "mcp_servers", "providers", "skills", "telegram", "model"]))
        for bad in ("a: [\n", "- 1\n"):
            with self.assertRaises(ValueError):
                pc.import_overlay(DEST, bad)


if __name__ == "__main__":
    unittest.main()
