# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""bin/push-image.sh — 빌드마다 지워지지 않는 고유 태그(스펙 2026-11-17-001 R1).

docker 는 PATH 앞의 대역 셸 스크립트로 바꾼다. 대역은 받은 인자를 한 줄씩 적고, 환경변수로 실패를 흉내 낸다.
"""
import os
import pathlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "bin" / "push-image.sh"
DIGEST = "sha256:" + "ab" * 32
OTHER = "sha256:" + "cd" * 32

FAKE_DOCKER = r"""#!/bin/sh
echo "$*" >> "$FAKE_LOG"
case "$*" in
  "buildx build "*)
    if [ -n "$FAKE_IMMUTABLE" ]; then echo "ERROR: failed to push: unknown: The image is configured as immutable" >&2; exit 1; fi
    meta=""; prev=""
    for a in "$@"; do [ "$prev" = "--metadata-file" ] && meta="$a"; prev="$a"; done
    if [ -n "$meta" ] && [ -z "$FAKE_NO_META" ]; then
      printf '{\n  "buildx.build.ref": "x",\n  "containerimage.digest": "%s"\n}\n' "$FAKE_DIGEST" > "$meta"
    fi ;;
  "buildx imagetools inspect "*)
    if [ -n "$FAKE_NO_VERSION" ]; then echo "not found" >&2; exit 1; fi
    # Jenkins 의 buildx 는 --format 을 주어도 기본 텍스트를 낸다(2026-11-17 #631). 그 꼴을 그대로 흉내 낸다.
    d="${FAKE_MOVED:-$FAKE_DIGEST}"
    printf 'Name:      %s\nMediaType: application/vnd.oci.image.index.v1+json\nDigest:    %s\n           \nManifests: \n' "$4" "$d"
    printf '  Name:        %s@sha256:%s\n  MediaType:   application/vnd.oci.image.manifest.v1+json\n  Platform:    linux/amd64\n' "$4" "$(printf 'ef%.0s' $(seq 32))"
    printf '  Annotations: \n    vnd.docker.reference.digest: sha256:%s\n' "$(printf '12%.0s' $(seq 32))" ;;
esac
exit 0
"""


class PushImageTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = pathlib.Path(self.tmp.name)
        fake = d / "docker"
        fake.write_text(FAKE_DOCKER)
        fake.chmod(0o755)
        self.log = d / "docker.log"
        self.images = d / "images.txt"
        self.env = {
            "PATH": f"{d}:{os.environ['PATH']}", "FAKE_LOG": str(self.log), "FAKE_DIGEST": DIGEST,
            "REGISTRY": "registry.example.com/images", "VERSION": "1.0.5", "AAS_BUILD_NUM": "123",
            "GIT_SHA7": "1a2b3c4", "AAS_IMAGE_FILE": str(self.images),
        }

    def tearDown(self):
        self.tmp.cleanup()

    def run_push(self, cwd=ROOT, **env):
        e = dict(self.env)
        for k, v in env.items():
            if v is None:
                e.pop(k, None)
            else:
                e[k] = v
        return subprocess.run(["bash", str(SCRIPT), "cogentai-aas-sidecar", "sidecar", "--build-arg", "AAS_VERSION=1.0.5"],
                              env=e, capture_output=True, text=True, cwd=cwd)

    def calls(self):
        return self.log.read_text().splitlines() if self.log.exists() else []

    def test_unique_tag_first_then_version_moves_to_same_digest(self):
        r = self.run_push()
        self.assertEqual(r.returncode, 0, r.stderr)
        repo = "registry.example.com/images/cogentai-aas-sidecar"
        calls = self.calls()
        self.assertIn(f"-t {repo}:1.0.5-b123-1a2b3c4 --metadata-file", calls[0])
        self.assertNotIn(f"{repo}:1.0.5 ", calls[0] + " ")  # 빌드는 고유 태그 하나로만 올린다
        self.assertEqual(calls[1], f"buildx imagetools create -t {repo}:1.0.5 {repo}@{DIGEST}")
        self.assertTrue(calls[2].startswith(f"buildx imagetools inspect {repo}:1.0.5"))
        line = f"AAS_IMAGE sidecar={repo}:1.0.5-b123-1a2b3c4@{DIGEST}"
        self.assertEqual(r.stdout.strip().splitlines()[-1], line)
        self.assertEqual(self.images.read_text().strip(), line)

    def test_no_build_number_does_not_overwrite_an_existing_version(self):
        r = self.run_push(AAS_BUILD_NUM=None)
        self.assertEqual(r.returncode, 1)
        self.assertIn("ALLOW_NO_UNIQUE_TAG=1", r.stderr)
        self.assertFalse(any(c.startswith("buildx build") for c in self.calls()))

    def test_allow_no_unique_tag_overwrites_version_with_a_warning(self):
        r = self.run_push(AAS_BUILD_NUM=None, ALLOW_NO_UNIQUE_TAG="1")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("고유 태그 없이", r.stderr)
        self.assertIn("-t registry.example.com/images/cogentai-aas-sidecar:1.0.5 --push sidecar", self.calls()[-1])

    def test_first_push_without_build_number_needs_no_flag(self):
        r = self.run_push(AAS_BUILD_NUM=None, FAKE_NO_VERSION="1")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn("WARN", r.stderr)
        self.assertIn("-t registry.example.com/images/cogentai-aas-sidecar:1.0.5 --push sidecar", self.calls()[-1])

    def test_bad_commit_or_build_number_fails_before_pushing(self):
        # 커밋값을 못 얻음: GIT_SHA7 이 비고 git 저장소 밖(얕은 clone 이 아니라 .git 이 없는 경우를 흉내 낸다)
        self.log.unlink(missing_ok=True)
        r = self.run_push(cwd=self.tmp.name, GIT_SHA7="", GIT_CEILING_DIRECTORIES=self.tmp.name)
        self.assertEqual(r.returncode, 1, r.stdout)
        self.assertIn("형식 오류", r.stderr)
        self.assertEqual(self.calls(), [])
        for env in ({"GIT_SHA7": "XYZ1234"}, {"GIT_SHA7": "1a2b3c"}, {"AAS_BUILD_NUM": "12a"}):
            with self.subTest(env=env):
                self.log.unlink(missing_ok=True)
                r = self.run_push(**env)
                self.assertEqual(r.returncode, 1)
                self.assertIn("형식 오류", r.stderr)
                self.assertEqual(self.calls(), [])

    def test_missing_metadata_digest_fails(self):
        r = self.run_push(FAKE_NO_META="1")
        self.assertEqual(r.returncode, 1)
        self.assertIn("containerimage.digest", r.stderr)
        self.assertFalse(any("imagetools create" in c for c in self.calls()))

    def test_immutable_tag_conflict_says_run_a_new_build(self):
        r = self.run_push(FAKE_IMMUTABLE="1")
        self.assertEqual(r.returncode, 1)
        self.assertIn("이미 digest", r.stderr)
        self.assertIn("새 BUILD_NUMBER", r.stderr)
        self.assertFalse(any("imagetools create" in c for c in self.calls()))

    def test_version_pointing_elsewhere_after_move_fails(self):
        r = self.run_push(FAKE_MOVED=OTHER)
        self.assertEqual(r.returncode, 1)
        self.assertIn(OTHER, r.stderr)
        self.assertFalse(self.images.exists())


if __name__ == "__main__":
    unittest.main()
