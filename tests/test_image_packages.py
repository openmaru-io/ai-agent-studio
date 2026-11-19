# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Hermes 이미지 패키지 목록과 라이브러리 칸 판정(스펙 2026-11-19-001 1단계)."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.assets import flow, image_packages, inventory  # noqa: E402
from aas.common import i18n  # noqa: E402

# OKE fea7(Hermes 1.0.5-0.22.2) /opt/hermes/.venv 에 실제로 있는 판(2026-11-19 확인)
IMAGE = {"image": "registry/hermes@sha256:" + "a" * 64, "taken_at": "2026-11-19T10:00:00+09:00", "python": "3.14.0",
         "prefix": "/opt/hermes/.venv", "script_ver": 1,
         "packages": [{"name": "numpy", "version": "2.5.4"},
                      {"name": "openpyxl", "version": "3.1.5"},
                      {"name": "opencv-python-headless", "version": "5.0.0.93", "modules": ["cv2"]},
                      {"name": "PyYAML", "version": "6.0.2", "modules": ["_yaml", "yaml"]},
                      {"name": "protobuf", "version": "6.31.0", "modules": ["google"]},
                      {"name": "google-api-core", "version": "2.25.0", "modules": ["google"]}]}


def omit(name: str, modules: list[str]) -> dict:
    """빌드 스크립트의 생략 규칙: 기본 모듈과 같으면 modules 를 싣지 않는다."""
    p = {"name": name, "version": "1.0"}
    if modules != image_packages.default_modules(name):
        p["modules"] = modules
    return p


def make_home(root: Path, *, profile_numpy: tuple[str, ...] = ()) -> Path:
    home = root / "hermes"
    sk = home / "skills" / "ocr" / "card"
    (sk / "scripts").mkdir(parents=True)
    (sk / "SKILL.md").write_text("---\nname: card\ndescription: 명함 OCR\n---\n# card\n\n실행: `python3 scripts/cards.py`\n")
    (sk / "scripts" / "cards.py").write_text(
        "import cv2\nimport numpy\nimport openpyxl\nimport google.auth\nimport yaml\nimport missingpkg\n")
    (sk / "scripts" / "pack.js").write_text("const yaml = require('yaml')\n")
    (home / "profiles" / "ma").mkdir(parents=True)
    (home / "profiles" / "ma" / "config.yaml").write_text("model:\n  default: m1\n")
    for i, ver in enumerate(profile_numpy):
        site = home / "profiles" / "ma" / ".venvs" / f"v{i}" / "lib" / "python3.14" / "site-packages"
        d = site / f"numpy-{ver}.dist-info"
        d.mkdir(parents=True)
        (d / "top_level.txt").write_text("numpy\n")
    return home


def lib_nodes(home: Path, image: dict | None) -> dict:
    ix = flow.build(home, image)
    return {nid: n for nid, n in ix["nodes"].items() if n["kind"] == "lib"}


class ParseTest(unittest.TestCase):
    def test_round_trip_of_omitted_modules(self):
        for name, modules in (("PyYAML", ["yaml"]), ("ruamel.yaml", ["ruamel"]), ("opencv_python_headless", ["cv2"]),
                              ("Pillow", ["pil"]), ("zope.interface", ["zope_interface"]), ("requests", ["requests"])):
            got = image_packages.parse({"packages": [omit(name, modules)]})["packages"][0]["modules"]
            self.assertEqual(got, modules, name)

    def test_bad_items_are_dropped_and_the_list_survives(self):
        got = image_packages.parse({"packages": [
            {"name": "charset-normalizer", "version": "3.4.2", "modules": ["charset_normalizer", "81d243bd2c585b0f4821__mypyc", "__pycache__"]},
            {"name": "bad name!", "version": "1"}, {"name": "ok", "version": "bad version!"}, {"name": "fine", "version": "1.0"}]})
        self.assertEqual([p["name"] for p in got["packages"]], ["charset-normalizer", "fine"])
        self.assertEqual(got["packages"][0]["modules"], ["charset_normalizer"])
        self.assertEqual(got["dropped"], 4)

    def test_whole_list_is_rejected_only_for_bad_shape_or_too_many(self):
        self.assertEqual(image_packages.parse([])["reason"], "bad_json")
        self.assertEqual(image_packages.parse({"packages": "x"})["reason"], "bad_json")
        many = {"packages": [{"name": f"p{i}", "version": "1"} for i in range(image_packages.MAX_ITEMS + 1)]}
        self.assertEqual(image_packages.parse(many)["reason"], "bad_json")

    def test_file_only_outside_kubernetes(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(IMAGE, f)
        with mock.patch.dict(os.environ, {image_packages.ENV_FILE: f.name}):
            self.assertEqual(image_packages.for_pod(True), {"packages": None, "reason": "pending"})  # 쿠버네티스에서는 개발용 파일을 읽지 않는다
            self.assertEqual(len(image_packages.for_pod(False)["packages"]), 6)
        with mock.patch.dict(os.environ, {image_packages.ENV_FILE: ""}):
            self.assertEqual(image_packages.for_pod(False)["reason"], "not_k8s")
        Path(f.name).write_text("{broken")
        with mock.patch.dict(os.environ, {image_packages.ENV_FILE: f.name}):
            self.assertEqual(image_packages.for_pod(False)["reason"], "bad_json")
        os.unlink(f.name)


class LibraryViewTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_image_libraries_are_found_without_warning(self):
        libs = lib_nodes(make_home(self.root), image_packages.parse(IMAGE))
        cv2 = libs["lib:py:cv2"]
        self.assertEqual((cv2["label"], cv2["sub"], cv2["status"]), ("opencv-python-headless", "Hermes 이미지 · 5.0.0.93", None))
        self.assertEqual(libs["lib:py:numpy"]["sub"], "Hermes 이미지 · 2.5.4")
        self.assertEqual(libs["lib:py:openpyxl"]["sub"], "Hermes 이미지 · 3.1.5")
        self.assertEqual(libs["lib:py:yaml"]["label"], "PyYAML")
        self.assertEqual((libs["lib:py:missingpkg"]["status"], libs["lib:py:missingpkg"]["badges"]), ("warn", ["설치 목록에 없음"]))

    def test_unknown_image_list_does_not_warn(self):
        libs = lib_nodes(make_home(self.root), image_packages.unknown("not_built"))
        for nid in ("lib:py:cv2", "lib:py:numpy", "lib:py:openpyxl", "lib:py:missingpkg"):
            self.assertEqual((libs[nid]["status"], libs[nid]["badges"], libs[nid]["sub"]), (None, [], "이미지 목록 확인 전"), nid)
        self.assertEqual(libs["lib:py:cv2"]["meta"]["이유"], "not_built")
        self.assertEqual(lib_nodes(make_home(self.root / "b"), None)["lib:py:cv2"]["sub"], "이미지 목록 확인 전")

    def test_namespace_package_is_not_claimed_as_found(self):
        g = lib_nodes(make_home(self.root), image_packages.parse(IMAGE))["lib:py:google.auth"]
        self.assertEqual((g["status"], g["sub"]), (None, "이름공간 패키지 · 확인 안 함"))
        self.assertIn("protobuf", g["meta"]["패키지"])

    def test_python_and_node_packages_of_the_same_name_are_separate_nodes(self):
        libs = lib_nodes(make_home(self.root), image_packages.parse(IMAGE))
        self.assertIn("lib:py:yaml", libs)
        self.assertEqual(libs["lib:yaml"]["sub"], "Node 패키지 · 설치 확인 안 함")

    def test_version_badge_only_between_profile_environments(self):
        img = image_packages.parse(IMAGE)
        one = lib_nodes(make_home(self.root / "a", profile_numpy=("2.3.0",)), img)["lib:py:numpy"]
        self.assertEqual((one["sub"], one["badges"]), ("2.3.0", []))       # 이미지 2.5.4 와 달라도 배지 없음
        self.assertIn("2.5.4", one["meta"]["버전"])
        two = lib_nodes(make_home(self.root / "b", profile_numpy=("2.3.0", "2.4.0")), img)["lib:py:numpy"]
        self.assertEqual(two["badges"], ["버전 여러 개"])

    def test_inventory_reports_image_list_state(self):
        home = make_home(self.root)
        self.assertEqual(inventory.libraries(home)["image_list"], "unknown")
        known = inventory.libraries(home, image_packages.parse(IMAGE))
        self.assertEqual(known["image_list"], "known")
        cv = next(i for i in known["items"] if i["name"] == "opencv-python-headless")
        self.assertEqual((cv["modules"], cv["image"]), (["cv2"], True))

    def test_english_subtitles(self):
        i18n.set_lang("en")
        self.addCleanup(i18n.set_lang, "ko")
        self.assertEqual(flow._loc_sub("이미지 목록 확인 전"), "Image list not checked yet")
        self.assertEqual(flow._loc_sub("Hermes 이미지 · 3.1.5"), "Hermes image · 3.1.5")
        self.assertEqual(flow._loc_sub("이름공간 패키지 · 확인 안 함"), "Namespace package · not checked")
        self.assertEqual(flow._META_VALUES[flow.IMAGE_UNKNOWN_NOTE][:20], "The list of librarie")


class FakeK8s:
    """known_agent·get_configmap 만 있는 쿠버네티스 대역(2단계)."""

    def __init__(self, image="", data=None, error=None):
        self.namespace, self.image, self.data, self.error, self.reads = "agents", image, data or {}, error, 0

    def known_agent(self, name):
        return {"metadata": {"name": name}, "status": {"image": self.image}} if self.image is not None else None

    def get_configmap(self, name):
        self.reads += 1
        if self.error:
            raise self.error
        return {"data": self.data}


DIGEST = "reg.local/hermes@sha256:" + "c" * 64
KEY = "sha256-" + "c" * 64


class FromK8sTest(unittest.TestCase):
    """2단계: 오퍼레이터가 옮긴 ConfigMap aas-image-packages 를 status.image digest 키로 읽는다."""

    def setUp(self):
        image_packages.forget()
        self.addCleanup(image_packages.forget)

    def read(self, fake):
        from aas.fleet import k8s
        with mock.patch.object(k8s, "client", return_value=fake):
            return image_packages.for_pod(True, "u1")

    def test_digest_keys_match_operator_table(self):
        rows = json.loads((Path(__file__).parent / "fixtures" / "digest_keys.json").read_text())
        for image, key in rows:
            self.assertEqual(image_packages.digest_key(image), key, image)

    def test_reads_packages_by_digest_key(self):
        fake = FakeK8s(DIGEST, {KEY: json.dumps(IMAGE)})
        got = self.read(fake)
        self.assertEqual(got["reason"], "")
        self.assertIn("cv2", next(p for p in got["packages"] if p["name"] == "opencv-python-headless")["modules"])
        self.read(fake)                                  # 15초 안에는 다시 읽지 않는다
        self.assertEqual(fake.reads, 1)

    def test_reasons(self):
        from aas.fleet import k8s
        cases = [(FakeK8s(""), "pending"), (FakeK8s(DIGEST, {}), "no_key"),
                 (FakeK8s(DIGEST, error=k8s.K8sError("nf", 404)), "no_key"),
                 (FakeK8s(DIGEST, error=k8s.K8sError("forbidden", 403)), "forbidden"),
                 (FakeK8s(DIGEST, error=k8s.K8sError("down", 503)), "timeout"),
                 (FakeK8s(DIGEST, {KEY: '{"reason":"no_label"}'}), "no_label"),
                 (FakeK8s(DIGEST, {KEY: "{broken"}), "bad_json"),
                 (FakeK8s(DIGEST, {KEY: '{"packages": 3}'}), "bad_json")]
        for fake, reason in cases:
            image_packages.forget()
            with self.subTest(reason=reason):
                self.assertEqual(self.read(fake), image_packages.unknown(reason))
        with mock.patch.object(k8s, "client", return_value=None):
            self.assertEqual(image_packages.for_pod(True, "u1")["reason"], "not_k8s")

    def test_signature_changes_with_content(self):
        a = image_packages.signature(image_packages.unknown("no_key"))
        b = image_packages.signature(image_packages.parse(IMAGE))
        c = image_packages.signature(image_packages.parse({**IMAGE, "packages": IMAGE["packages"][:1]}))
        self.assertEqual(len({a, b, c}), 3)


if __name__ == "__main__":
    unittest.main()
