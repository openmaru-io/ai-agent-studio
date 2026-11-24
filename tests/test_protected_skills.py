# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""보호 스킬 원본·설치 값·잠금·점검 명령(cogentai-aas-docs 스펙 2026-11-21-003 §3-1, 2단계).

공용 시험이라 고객사 이름을 쓰지 않는다 — 가짜 보호 스킬 protected-fixture 를 임시 폴더에 만든다.
고객사 스킬 자체의 확인은 tests/test_edition_reb.py(사내 전용)에 있다.
"""
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))   # 다른 시험과 같은 꼴(같이 돌면 앞 시험의 값을 쓴다)

from aas.market import protected_skills as ps, skill_bundle  # noqa: E402

NAME = "protected-fixture"
SETTING = "AAS_PROTECTED_FIXTURE_ENABLED"
ATTRS = "aas/assets/protected_skills                export-ignore\naas/assets/protected_skills/**             export-ignore\n"
RULES = "# 시험용\ndeny    customer-x    (?i:protected[-_]fixture)\n"


def skill_md(version="0.1.0", body="원본"):
    return f"---\nname: {NAME}\ndescription: 시험용 보호 스킬\nversion: {version}\n---\n\n{body}\n"


class Tree:
    """임시 원본 폴더 + .gitattributes + 흔적 규칙."""

    def __init__(self):
        self._tmp = tempfile.TemporaryDirectory()
        base = Path(self._tmp.name)
        self.root = base / "protected_skills"
        (self.root / NAME / "references").mkdir(parents=True)
        (self.root / NAME / "SKILL.md").write_text(skill_md(), encoding="utf-8")
        (self.root / NAME / "references" / "faq.md").write_text("참고\n", encoding="utf-8")
        (self.root / "README.md").write_text("설명\n", encoding="utf-8")   # 스킬이 아니다
        self.attrs = base / ".gitattributes"
        self.attrs.write_text(ATTRS, encoding="utf-8")
        self.rules = base / "rules.txt"
        self.rules.write_text(RULES, encoding="utf-8")
        ps.write_lock(self.root)

    def check(self, settings=None):
        return ps.check(self.root, {NAME: SETTING} if settings is None else settings, self.attrs, self.rules)

    def close(self):
        self._tmp.cleanup()


class ProtectedSkillsTest(unittest.TestCase):
    def setUp(self):
        self.t = Tree()
        self.addCleanup(self.t.close)

    def test_names_are_skill_folders_only_and_a_missing_folder_means_none(self):
        self.assertEqual(ps.protected_names(self.t.root), [NAME])
        self.assertEqual(ps.protected_names(self.t.root / "없음"), [])      # 공개본에는 폴더가 없다

    def test_enabled_needs_the_setting_on_and_a_table_entry(self):
        table = {NAME: SETTING}
        with mock.patch.dict(os.environ, {SETTING: ""}):
            with mock.patch.object(ps.skill_bundle.config, "read_env_file", return_value={}):
                self.assertEqual(ps.protected_enabled(self.t.root, table), [])
        with mock.patch.dict(os.environ, {SETTING: "true"}):
            self.assertEqual(ps.protected_enabled(self.t.root, table), [NAME])
            self.assertEqual(ps.protected_enabled(self.t.root, {}), [])     # 표에 없으면 켜지 않는다

    def test_a_clean_tree_passes_the_check(self):
        self.assertEqual(self.t.check(), [])

    def test_changing_content_without_a_new_version_fails_the_lock(self):
        (self.t.root / NAME / "SKILL.md").write_text(skill_md(body="고친 글"), encoding="utf-8")
        with self.assertRaises(skill_bundle.BundleError):
            ps.write_lock(self.t.root)
        self.assertTrue(any("version" in p for p in self.t.check()))

    def test_a_new_version_needs_the_lock_rewritten(self):
        (self.t.root / NAME / "SKILL.md").write_text(skill_md("0.1.1", "고친 글"), encoding="utf-8")
        self.assertTrue(any("versions.lock.json" in p for p in self.t.check()))
        ps.write_lock(self.t.root)
        self.assertEqual(self.t.check(), [])
        self.assertEqual(ps.read_lock(self.t.root)[NAME]["version"], "0.1.1")

    def test_each_missing_piece_is_named(self):
        self.assertTrue(any("설정 이름 표" in p and NAME in p for p in self.t.check(settings={})))
        self.assertTrue(any("ghost" in p for p in self.t.check(settings={NAME: SETTING, "ghost": "AAS_GHOST_ENABLED"})))
        self.t.attrs.write_text("aas/assets/protected_skills/**  export-ignore\n", encoding="utf-8")   # 폴더 이름 줄이 빠짐
        found = self.t.check()
        self.assertEqual(len(found), 1)
        self.assertIn("aas/assets/protected_skills export-ignore", found[0])
        self.t.attrs.write_text(ATTRS, encoding="utf-8")
        self.t.rules.write_text("deny  other  nothing-here\n", encoding="utf-8")
        found = self.t.check()
        self.assertEqual(sorted(p.split(":")[0] for p in found), sorted([NAME, SETTING]))   # 스킬 이름도 설정 이름도 못 잡음

    def test_the_default_bundle_does_not_see_protected_skills(self):
        # 기본 묶음 동작은 그대로(스펙 G5): 보호 폴더는 기본 묶음 폴더 밖이고 names()·enabled_names() 에 섞이지 않는다
        self.assertNotEqual(ps.PROTECTED_DIR, skill_bundle.PACKAGES_DIR)
        self.assertFalse(set(ps.protected_names()) & set(skill_bundle.names()))
        self.assertFalse(set(ps.protected_names()) & set(skill_bundle.enabled_names()))

    def test_the_repository_tree_passes_the_check(self):
        # make check-protected-skills 와 같은 점검 — 보호 스킬을 더하고 한 곳을 빠뜨리면 여기서 실패한다
        self.assertEqual(ps.check(), [])



# ---- 3단계: 기록 표·쓰기·점검·되돌리기 ------------------------------------------------------------------------------------

class FakeOps:
    """Hermes 파일 API 대역: 메모리 안 파일과 수정 시각. 프로파일 config.yaml 이 있어야 프로파일이 있다."""

    def __init__(self, profiles=("p1",)):
        self.files: dict[str, bytes] = {f"profiles/{p}/config.yaml": b"x" for p in profiles}
        self.mtime: dict[str, float] = {}
        self.clock = 1000.0
        self.writes: list[str] = []
        self.fail_write = None            # 경로 → HTTP 상태
        self.skill_rows: dict[str, list] = {}
        self.toggles: list = []

    def read(self, path):
        return self.files.get(path)

    def write(self, path, data):
        if self.fail_write and self.fail_write(path):
            return 500
        self.clock += 1
        self.files[path] = data
        self.mtime[path] = self.clock
        self.writes.append(path)
        return 200

    def listdir(self, path):
        pre = path.rstrip("/") + "/"
        kids = {}
        for f in self.files:
            if f.startswith(pre):
                head, _, rest = f[len(pre):].partition("/")
                kids[head] = kids.get(head) or bool(rest)
        if not kids:
            return None
        return [{"name": k, "is_directory": d, "size": None if d else len(self.files[pre + k]), "mtime": None if d else self.mtime.get(pre + k)}
                for k, d in sorted(kids.items())]

    def delete(self, path, recursive):
        for f in [f for f in self.files if f == path or f.startswith(path.rstrip("/") + "/")]:
            del self.files[f]

    def skills(self, profile):
        return self.skill_rows.get(profile, [])


class Pod:
    def __init__(self, pid):
        self.id = pid


class CycleTest(unittest.TestCase):
    POD = "ps-test-pod"

    def setUp(self):
        self.t = Tree()
        self.addCleanup(self.t.close)
        self.settings = {NAME: SETTING}
        env = mock.patch.dict(os.environ, {SETTING: "true"})
        env.start()
        self.addCleanup(env.stop)
        self.ops = FakeOps(("p1", "p2"))
        self.pods = [Pod(self.POD)]
        ps.reset()
        self.addCleanup(self._clean)

    def _clean(self):
        for r in ps.rows():
            if r["pod"].startswith("ps-test-"):
                ps.forget_profile(r["pod"], r["profile"])

    def run_cycle(self, now=None, force=False, ops=None, pods=None):
        ops = ops or self.ops
        return ps.cycle(pods or self.pods, lambda pod: [p.split("/")[1] for p in ops.files if p.endswith("/config.yaml")],
                        lambda pod: ops, root=self.t.root, settings=self.settings, now=now or 1_000_000.0, force=force)

    def enable(self, profile="p1"):
        return ps.set_enabled(self.POD, profile, NAME, True, settings=self.settings, root=self.t.root)

    def base(self, profile="p1"):
        return f"profiles/{profile}/skills/protected/{NAME}"

    def test_turning_on_writes_the_copy_on_the_next_cycle_with_skill_md_last(self):
        got = self.enable()
        self.assertEqual((got["kind"], got["state"], got["applied"]), ("protected", "pending", False))
        self.assertEqual(ps.status(self.POD, "p1", NAME)["state"], "pending")
        self.run_cycle()
        self.assertEqual(self.ops.writes[-1], f"{self.base()}/SKILL.md")
        self.assertIn(f"{self.base()}/references/faq.md", self.ops.files)
        self.assertEqual(ps.status(self.POD, "p1", NAME)["state"], "on")
        self.assertNotIn(f"profiles/p2/skills/protected/{NAME}/SKILL.md", self.ops.files)   # 켠 프로파일에만
        self.assertEqual(ps.issues(self.POD, "p1"), [])                                   # 첫 쓰기는 되돌림이 아니다
        self.assertEqual(self.enable()["state"], "on")

    def test_an_unchanged_copy_is_not_written_again(self):
        self.enable()
        self.run_cycle()
        n = len(self.ops.writes)
        self.run_cycle(now=1_000_060.0)
        self.assertEqual(len(self.ops.writes), n)

    def test_a_changed_or_deleted_file_is_restored_with_one_notice(self):
        self.enable()
        self.run_cycle()
        self.ops.write(f"{self.base()}/SKILL.md", b"injected")
        self.ops.delete(f"{self.base()}/references/faq.md", False)
        self.ops.writes.clear()
        with mock.patch("builtins.print") as out:
            self.run_cycle(now=1_000_060.0)
        self.assertEqual(self.ops.files[f"{self.base()}/SKILL.md"], skill_md().encode())
        self.assertIn(f"{self.base()}/references/faq.md", self.ops.files)
        self.assertTrue(any("protected_skill_restored" in str(c) for c in out.call_args_list))
        found = ps.issues(self.POD, "p1")
        self.assertEqual([i["code"] for i in found], ["protected_skill_restored"])
        self.assertIn("SKILL.md", found[0]["text"])
        self.assertTrue(ps.status(self.POD, "p1", NAME)["last_restored_at"])

    def test_a_same_size_same_time_edit_is_caught_by_the_full_check(self):
        self.enable()
        self.run_cycle()
        path = f"{self.base()}/references/faq.md"
        keep = self.ops.mtime[path]
        self.ops.files[path] = "변조\n".encode()[:len(self.ops.files[path])].ljust(len(self.ops.files[path]), b" ")   # 크기 같게
        self.ops.mtime[path] = keep                                                                                   # touch -r
        self.run_cycle(now=1_000_060.0)
        self.assertNotEqual(self.ops.files[path], "참고\n".encode())                    # 크기·시각으로는 못 본다
        self.run_cycle(now=1_000_000.0 + ps.FULL_EVERY + 1)
        self.assertEqual(self.ops.files[path], "참고\n".encode())

    def test_an_extra_file_in_the_copy_is_removed(self):
        self.enable()
        self.run_cycle()
        self.ops.write(f"{self.base()}/scripts/evil.sh", b"rm -rf /")
        self.run_cycle(now=1_000_060.0)
        self.assertNotIn(f"{self.base()}/scripts/evil.sh", self.ops.files)

    def test_a_new_version_is_written_without_a_restore_notice(self):
        self.enable()
        self.run_cycle()
        (self.t.root / NAME / "SKILL.md").write_text(skill_md("0.2.0", "새 판"), encoding="utf-8")
        with mock.patch("builtins.print") as out:
            self.run_cycle(now=1_000_060.0)
        self.assertIn("새 판".encode(), self.ops.files[f"{self.base()}/SKILL.md"])
        self.assertTrue(any("protected_skill_version_changed" in str(c) for c in out.call_args_list))
        self.assertEqual(ps.issues(self.POD, "p1"), [])
        self.assertEqual(ps.status(self.POD, "p1", NAME)["version"], "0.2.0")

    def test_turning_off_removes_the_copy(self):
        self.enable()
        self.run_cycle()
        got = ps.set_enabled(self.POD, "p1", NAME, False, settings=self.settings, root=self.t.root)
        self.assertEqual(got["state"], "off")
        self.run_cycle(now=1_000_060.0)
        self.assertIsNone(self.ops.listdir(self.base()))
        self.assertEqual(ps.status(self.POD, "p1", NAME)["state"], "off")

    def test_switching_the_setting_off_retires_and_on_again_revives(self):
        self.enable()
        self.run_cycle()
        with mock.patch.dict(os.environ, {SETTING: ""}), mock.patch.object(ps.skill_bundle.config, "read_env_file", return_value={}):
            self.run_cycle(now=1_000_060.0)
        self.assertIsNone(self.ops.listdir(self.base()))
        self.assertEqual(ps.status(self.POD, "p1", NAME)["state"], "retired")
        self.run_cycle(now=1_000_120.0)
        self.assertEqual(ps.status(self.POD, "p1", NAME)["state"], "on")
        self.assertIn(f"{self.base()}/SKILL.md", self.ops.files)

    def test_a_removed_workspace_retires_and_a_removed_profile_drops_the_row(self):
        self.enable("p1")
        self.enable("p2")
        self.run_cycle()
        del self.ops.files["profiles/p2/config.yaml"]
        self.run_cycle(now=1_000_060.0)
        self.assertIsNone(ps.status(self.POD, "p2", NAME))
        self.run_cycle(now=1_000_120.0, pods=[Pod("ps-test-other")])
        self.assertEqual(ps.status(self.POD, "p1", NAME)["state"], "retired")

    def test_write_failures_back_off_and_notice_on_the_third(self):
        self.enable()
        self.ops.fail_write = lambda path: True
        t = 1_000_000.0
        for i in range(3):
            self.run_cycle(now=t)
            st = ps.status(self.POD, "p1", NAME)
            self.assertEqual((st["state"], st["failures"], st["last_error_code"]), ("failed", i + 1, "write_failed"))
            t = ps._row(self.POD, "p1", NAME)["next_try_at"] + 1
        self.assertEqual([i["code"] for i in ps.issues(self.POD, "p1")], ["protected_skill_failed"])
        self.assertLessEqual(ps._row(self.POD, "p1", NAME)["next_try_at"] - t, ps.BACKOFF_MAX)
        self.ops.fail_write = None
        self.run_cycle(now=t)
        self.assertEqual(ps.status(self.POD, "p1", NAME)["state"], "on")
        self.assertEqual(ps.issues(self.POD, "p1"), [])

    def test_one_failing_row_does_not_stop_the_others(self):
        self.enable("p1")
        self.enable("p2")
        real = self.ops.listdir

        def boom(path):
            if path.startswith("profiles/p1/"):
                raise RuntimeError("bad")
            return real(path)
        self.ops.listdir = boom
        with mock.patch("builtins.print"), mock.patch("traceback.print_exc"):
            self.run_cycle()
        self.assertIn(f"profiles/p2/skills/protected/{NAME}/SKILL.md", self.ops.files)

    def test_a_held_lock_skips_that_profile(self):
        self.enable()
        with ps.protected_lock(self.POD, "p1") as got:
            self.assertTrue(got)
            with ps.protected_lock(self.POD, "p1") as again:
                self.assertFalse(again)
            self.run_cycle()
        self.assertNotIn(f"{self.base()}/SKILL.md", self.ops.files)
        self.run_cycle(now=1_000_060.0)
        self.assertIn(f"{self.base()}/SKILL.md", self.ops.files)

    def test_orphan_copies_are_removed_up_to_the_cap(self):
        for i in range(2):
            self.ops.write(f"profiles/p{i + 1}/skills/protected/{NAME}/SKILL.md", b"old")
        with mock.patch("builtins.print"):
            self.run_cycle(force=True)
        self.assertIsNone(self.ops.listdir(self.base("p1")))
        with mock.patch.object(ps, "ORPHAN_MAX", 0), mock.patch("builtins.print"):
            self.ops.write(f"{self.base('p1')}/SKILL.md", b"old")
            self.run_cycle(force=True)
        self.assertIsNotNone(self.ops.listdir(self.base("p1")))                          # 상한을 넘으면 지우지 않고 알린다
        self.assertIn("protected_skill_orphan", [i["code"] for i in ps.issues(self.POD, "p1")])

    def test_a_same_name_skill_and_a_hermes_side_off_are_reported_not_changed(self):
        self.enable()
        self.run_cycle()
        self.ops.skill_rows["p1"] = [{"name": f"market/{NAME}", "category": "market", "enabled": True},
                                     {"name": f"protected/{NAME}", "category": "protected", "enabled": False}]
        self.ops.write(f"profiles/p1/skills/market/{NAME}/SKILL.md", b"fake")
        with mock.patch("builtins.print"):
            self.run_cycle(now=1_000_060.0, force=True)
        codes = [i["code"] for i in ps.issues(self.POD, "p1")]
        self.assertIn("protected_skill_duplicate", codes)
        self.assertIn("protected_skill_hermes_disabled", codes)
        self.assertIn(f"profiles/p1/skills/market/{NAME}/SKILL.md", self.ops.files)      # 옮기거나 지우지 않는다
        self.ops.skill_rows["p1"] = [{"name": NAME, "category": "protected", "enabled": True}]
        self.run_cycle(now=1_000_120.0, force=True)
        self.assertEqual(ps.issues(self.POD, "p1"), [])

    def test_refusals_and_rename(self):
        with self.assertRaises(ps.ProtectedError) as cm:
            ps.set_enabled(self.POD, "default", NAME, True, settings=self.settings, root=self.t.root)
        self.assertEqual((cm.exception.code, cm.exception.status), ("invalid", 400))
        with self.assertRaises(ps.ProtectedError) as cm:
            ps.set_enabled(self.POD, "p1", NAME, True, settings={}, root=self.t.root)       # 설치 값이 꺼진 이름
        self.assertEqual((cm.exception.code, cm.exception.status), ("not_found", 404))
        self.enable()
        self.assertTrue(ps.requested())
        self.run_cycle()
        self.assertFalse(any(r["check_requested_at"] for r in ps.rows(self.POD)))
        ps.rename_profile(self.POD, "p1", "p9")
        self.assertIsNone(ps.status(self.POD, "p1", NAME))
        self.assertEqual(ps.status(self.POD, "p9", NAME)["state"], "on")

    def test_rows_left_over_the_budget_wait_for_the_next_cycle(self):
        self.enable("p1")
        self.enable("p2")
        with mock.patch.object(ps, "BUDGET", -1), mock.patch("builtins.print") as out:
            self.run_cycle()
        self.assertTrue(any("protected_skill_cycle_skipped" in str(c) for c in out.call_args_list))
        self.assertEqual([ps.status(self.POD, p, NAME)["state"] for p in ("p1", "p2")], ["pending", "pending"])

    def test_a_stalled_cycle_shows_up_in_the_issues(self):
        self.enable()
        self.run_cycle()
        with mock.patch.dict(ps._state, {"last_done": time.time() - ps.STALL - 1}):
            self.assertIn("protected_skill_stalled", [i["code"] for i in ps.issues(self.POD, "p1")])


class ServerOpsTest(unittest.TestCase):
    """서버의 파일 연산 꾸러미 — 없는 폴더·민감 파일은 None, 호출마다 시간 제한(스펙 §3-3 M8)."""

    def test_listdir_and_delete_map_missing_paths_and_pass_the_timeout(self):
        from aas.hermes.hermes_api import HermesError
        from aas.web import server
        calls = []

        class API:
            def call(self, method, path, body=None, query=None, timeout=30):
                calls.append((method, path, timeout))
                if (query or {}).get("path") == "gone" or (body or {}).get("path") == "gone":
                    raise HermesError("Path not found", 404)
                if (query or {}).get("path") == "secret":
                    raise HermesError("Access to sensitive files is not allowed", 502)
                return {"entries": [{"name": "SKILL.md", "is_directory": False, "size": 3, "mtime": 1.0}]}

        ops = server._ProtectedOps.__new__(server._ProtectedOps)
        ops.api = API()
        self.assertIsNone(ops.listdir("gone"))
        self.assertIsNone(ops.listdir("secret"))
        self.assertEqual(ops.listdir("ok")[0]["name"], "SKILL.md")
        ops.delete("gone", True)                                         # 이미 없으면 조용히
        self.assertTrue(all(t == server.PROTECTED_CALL_TIMEOUT for _m, _p, t in calls))

class ToggleAndListTest(unittest.TestCase):
    """4단계: 켜기 거절·목록 맞추기·화면 API·MCP 오류 코드(스펙 §3-2). 준비는 CycleTest 와 같다(그 시험들은 다시 돌리지 않는다)."""
    POD = CycleTest.POD
    setUp, _clean, run_cycle, enable = CycleTest.setUp, CycleTest._clean, CycleTest.run_cycle, CycleTest.enable

    def listed(self, *extra):
        return [{"name": "other", "category": "", "enabled": True}, *extra]

    def test_first_turn_on_is_refused_when_a_same_name_skill_exists(self):
        with self.assertRaises(ps.ProtectedError) as got:
            ps.set_enabled(self.POD, "p1", NAME, True, settings=self.settings, root=self.t.root,
                           listed=self.listed({"name": NAME, "category": "market", "enabled": True}))
        self.assertEqual((got.exception.code, got.exception.status), ("conflict", 409))
        self.assertIn("market/" + NAME, str(got.exception))
        self.assertIsNone(ps.status(self.POD, "p1", NAME))            # 거절하면 남는 결과가 없다
        ps.set_enabled(self.POD, "p1", NAME, True, settings=self.settings, root=self.t.root, listed=self.listed())
        again = ps.set_enabled(self.POD, "p1", NAME, True, settings=self.settings, root=self.t.root,   # 켠 뒤에는 주기가 알린다
                               listed=self.listed({"name": "market/" + NAME, "category": "market"}, {"name": "protected/" + NAME, "category": "protected"}))
        self.assertTrue(again["enabled"])

    def test_profile_panel_rows_follow_the_record_and_hide_when_the_setting_is_off(self):
        hermes = [{"name": "other", "category": "", "enabled": True}]
        got = ps.merge_profile_skills(self.POD, "p1", hermes, root=self.t.root, settings=self.settings)
        row = next(r for r in got if r["name"] == NAME)
        self.assertEqual((row["enabled"], row["category"], row["protected"]["state"]), (False, "protected", "off"))
        self.assertEqual(row["description"], "시험용 보호 스킬")
        self.assertEqual([r["name"] for r in ps.merge_profile_skills(self.POD, "default", hermes, root=self.t.root, settings=self.settings)], ["other"])
        self.enable()
        self.run_cycle()
        written = hermes + [{"name": NAME, "category": "protected", "enabled": True}]
        row = next(r for r in ps.merge_profile_skills(self.POD, "p1", written, root=self.t.root, settings=self.settings) if r["name"] == NAME)
        self.assertEqual((row["enabled"], row["protected"]["state"]), (True, "on"))
        self.assertEqual(sum(r["name"] == NAME for r in ps.merge_profile_skills(self.POD, "p1", written, root=self.t.root, settings=self.settings)), 1)
        with mock.patch.dict(os.environ, {SETTING: ""}):              # 설치 값을 끄면 보이지 않는다
            self.assertEqual([r["name"] for r in ps.merge_profile_skills(self.POD, "p1", written, root=self.t.root, settings=self.settings)], ["other"])

    def test_skill_list_rows_share_the_id_before_and_after_writing(self):
        got = ps.merge_list_rows(self.POD, [], ["default", "p1"], root=self.t.root, settings=self.settings)
        self.assertEqual([(r["profile"], r["id"], r["origin"], r["enabled"]) for r in got],
                         [("p1", f"p1:profiles/p1/skills/protected/{NAME}", "protected", False)])
        self.assertEqual(got[0]["delete_block"], "origin")
        self.enable()
        real = [{"id": ps.skill_id("p1", NAME), "name": NAME, "profile": "p1", "origin": "protected", "enabled": False}]
        got = ps.merge_list_rows(self.POD, real, ["p1"], root=self.t.root, settings=self.settings)
        self.assertEqual(len(got), 1)
        self.assertEqual((got[0]["enabled"], got[0]["protected"]["state"]), (True, "pending"))
        with mock.patch.dict(os.environ, {SETTING: ""}):
            self.assertEqual(ps.merge_list_rows(self.POD, real, ["p1"], root=self.t.root, settings=self.settings), [])

    def test_preload_for_names_only_written_copies_without_a_duplicate(self):
        self.assertEqual(ps.preload_for(self.POD, "p1", root=self.t.root, settings=self.settings), [])
        self.enable()
        self.assertEqual(ps.preload_for(self.POD, "p1", root=self.t.root, settings=self.settings), [])      # 아직 안 씀(pending)
        self.run_cycle()
        self.assertEqual(ps.preload_for(self.POD, "p1", root=self.t.root, settings=self.settings), [NAME])
        ps._notice(self.POD, "p1", NAME, "duplicate", "x")
        self.assertEqual(ps.preload_for(self.POD, "p1", root=self.t.root, settings=self.settings), [])      # 같은 이름이면 --skills 가 실패한다
        ps._clear_notice(self.POD, "p1", NAME, "duplicate")
        with mock.patch.dict(os.environ, {SETTING: ""}):
            self.assertEqual(ps.preload_for(self.POD, "p1", root=self.t.root, settings=self.settings), [])

    def test_preload_pick_names_one_skill_by_the_instruction(self):
        # 스펙 2026-11-24-002 D8 (가): 맡길 일 첫 구절의 보호 스킬만, 준비되지 않았으면 아무것도, 이름이 없을 때만 모두
        known = ["team-alpha", "team-alpha-draft", "team-alpha-faq"]
        ready = ["team-alpha-draft", "team-alpha-faq"]
        pick = ps.preload_pick
        self.assertEqual(pick(ready, known, "team-alpha-faq 스킬로 이 행을 FAQ 로"), (["team-alpha-faq"], "team-alpha-faq"))
        self.assertEqual(pick(ready, known, "  「team-alpha-draft」 스킬로 초안"), (["team-alpha-draft"], "team-alpha-draft"))
        self.assertEqual(pick(ready, known, '"team-alpha-faq 스킬로'), (["team-alpha-faq"], "team-alpha-faq"))
        self.assertEqual(pick(ready, known, "team-alpha 스킬로 x"), ([], "team-alpha"))          # 앞부분 이름은 다른 스킬 — 준비 안 됨
        self.assertEqual(pick(["team-alpha-draft"], known, "team-alpha-faq 스킬로 x"), ([], "team-alpha-faq"))   # off · failed · 같은 이름: 싣지 않음
        self.assertEqual(pick(ready, known, "team-alpha-faqx 스킬로"), (ready, ""))               # 낱말 단위
        self.assertEqual(pick(ready, known, "민원 초안을 써 주세요"), (ready, ""))
        self.assertEqual(pick(ready, known, ""), (ready, ""))

    def test_preload_for_with_a_message(self):
        self.enable()
        self.run_cycle()
        got = ps.preload_for(self.POD, "p1", root=self.t.root, settings=self.settings, message=f"{NAME} 스킬로 해 주세요")
        self.assertEqual(got, [NAME])
        self.assertEqual(ps.preload_for(self.POD, "p1", root=self.t.root, settings=self.settings, message="아무 일"), [NAME])
        ps._notice(self.POD, "p1", NAME, "duplicate", "x")
        self.assertEqual(ps.preload_for(self.POD, "p1", root=self.t.root, settings=self.settings, message=f"{NAME} 스킬로"), [])
        ps._clear_notice(self.POD, "p1", NAME, "duplicate")

    def test_origin_marks_the_protected_folder_first(self):
        from aas.assets import skill_origin
        facts = skill_origin.Facts.__new__(skill_origin.Facts)
        facts.hub, facts.manifest, facts.agent = {NAME}, {NAME: ""}, {NAME}
        self.assertEqual(skill_origin.origin(facts, NAME, f"skills/protected/{NAME}", Path(".")), "protected")
        self.assertEqual(skill_origin.origin(facts, NAME, f"skills/market/{NAME}", Path(".")), "hub")

    def server_toggle(self, api, on, profile="p1"):
        import functools
        from aas.web import server
        with mock.patch.object(server.protected_skills, "set_enabled",
                               functools.partial(ps.set_enabled, settings=self.settings, root=self.t.root)):
            return server._protected_toggle(Pod(self.POD), api, profile, profile, NAME, on)

    def test_server_toggle_changes_the_record_without_touching_hermes_unless_its_copy_is_off(self):
        from aas.web.server import files
        calls = []

        class API:
            def __init__(self, listed):
                self.listed = listed

            def call(self, method, path, body=None, query=None, timeout=30):
                calls.append((method, path, (body or {}).get("name")))
                return self.listed if method == "GET" else {}

        got = self.server_toggle(API(self.listed()), True)
        self.assertEqual((got["ok"], got["kind"], got["state"]), (True, "protected", "pending"))
        self.assertEqual([c for c in calls if c[0] == "PUT"], [])
        self.server_toggle(API(self.listed()), False)
        self.assertEqual(ps.status(self.POD, "p1", NAME)["state"], "off")
        self.assertEqual([c for c in calls if c[0] == "PUT"], [])     # 끄기는 Hermes 끔 목록에 넣지 않는다
        self.server_toggle(API(self.listed({"name": NAME, "category": "protected", "enabled": False})), True)
        self.assertEqual([c for c in calls if c[0] == "PUT"], [("PUT", "/api/skills/toggle", NAME)])   # 사람이 켜면 Hermes 쪽 끔도 푼다
        ps.forget_profile(self.POD, "p1")
        with self.assertRaises(files.FileError) as got:
            self.server_toggle(API(self.listed({"name": NAME, "category": "", "enabled": True})), True)
        self.assertEqual((got.exception.code, got.exception.reason, got.exception.extra), (409, "conflict", {"code": "conflict"}))
        with self.assertRaises(files.FileError) as got:
            self.server_toggle(API(self.listed()), True, profile="default")
        self.assertEqual((got.exception.code, got.exception.reason), (400, "invalid"))
        with mock.patch.dict(os.environ, {SETTING: ""}), self.assertRaises(files.FileError) as got:
            self.server_toggle(API(self.listed()), True)
        self.assertEqual((got.exception.code, got.exception.reason), (404, "not_found"))

    def test_mcp_maps_the_refusals_to_their_codes(self):
        from aas.web import mcp_server
        for status, reason in ((409, "conflict"), (404, "not_found")):
            with self.assertRaises(mcp_server.ToolError) as got:
                mcp_server._ok(status, {"error": "x", "reason": reason, "code": reason})
            self.assertEqual(got.exception.word, reason)
        with self.assertRaises(mcp_server.ToolError) as got:
            mcp_server._ok(403, {"error": "x"})
        self.assertEqual(got.exception.word, "forbidden")
        self.assertIn("protected", mcp_server.SKILL_ROW)


class ProtectedCopyEditTest(unittest.TestCase):
    """보호 사본은 화면·MCP 의 스킬 문서 고치기에서 보기만 된다 — 고쳐도 1분 안에 되돌아가 저장된 것처럼만 보였다(2026-11-21 OKE 6단계)."""

    def test_protected_copies_are_read_only_and_saving_is_refused(self):
        from aas.assets import files
        for rel in (f"profiles/p1/skills/protected/{NAME}/SKILL.md", f"skills/protected/{NAME}/SKILL.md"):
            with self.subTest(rel=rel):
                self.assertTrue(files.protected_copy(rel))
                self.assertFalse(files.editable(rel))
                with self.assertRaises(files.FileError) as got:
                    files.check(rel, "---\nname: x\n---\n")
                self.assertEqual((got.exception.code, got.exception.reason), (403, "protected"))
        for rel in (f"profiles/p1/skills/market/{NAME}/SKILL.md", "profiles/protected/skills/x/SKILL.md", "skills/protected/SKILL.md"):
            with self.subTest(rel=rel):
                self.assertFalse(files.protected_copy(rel))

    def test_edit_state_names_the_reason(self):
        from types import SimpleNamespace
        from aas.web import server
        got = server.Handler._edit_state(SimpleNamespace(enabled=False), None, f"profiles/p1/skills/protected/{NAME}/SKILL.md", {"masked_lines": []})
        self.assertFalse(got["editable"])
        self.assertEqual(got["why_not"], server.files.protected_why())


if __name__ == "__main__":
    unittest.main()
