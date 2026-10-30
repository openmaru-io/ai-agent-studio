# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""스킬 내려받기·올리기(OMAI-1195, 스펙 2026-10-15-009).
내려받기: 스킬 폴더를 zip 으로 준다. 비밀값이 든 파일은 빼고 이름을 알린다(R4, DR6)."""
import aasserver  # 실제 uvicorn 앱을 띄우는 시험 하네스(OMAI-1100)
import http.client
import io
import json
import os
import tempfile
import tarfile
import time
import unittest
import zipfile
from unittest import mock
from pathlib import Path
from urllib.parse import quote

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.auth import auth  # noqa: E402
from aas.fleet import pods  # noqa: E402
from aas.fleet import k8s  # noqa: E402
from aas.market.marketplace import MarketError  # noqa: E402
from aas.web import server, skill_files  # noqa: E402

KEY = "sk-" + "a1B2c3D4e5F6g7H8i9J0k1L2"          # 비밀값으로 보이는 문자열(마켓 올리기와 같은 검사)


class DownloadTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(TMP.name)
        cls.home = root / "hermes"
        folder = cls.home / "profiles" / "ma" / "skills" / "ops" / "weekly"
        (folder / "scripts").mkdir(parents=True)
        (folder / "references").mkdir()
        (folder / "SKILL.md").write_text('---\nname: weekly\ndescription: "주간 보고를 만든다"\n---\n\n# weekly\n', encoding="utf-8")
        (folder / "scripts" / "run.py").write_text("print('ok')\n", encoding="utf-8")
        (folder / "references" / "note.md").write_text("참고\n", encoding="utf-8")
        (folder / "scripts" / "leaky.py").write_text(f'API_KEY = "{KEY}"\n', encoding="utf-8")
        (folder / ".hidden").write_text("x", encoding="utf-8")
        clean = cls.home / "profiles" / "ma" / "skills" / "ops" / "clean"
        clean.mkdir(parents=True)
        (clean / "SKILL.md").write_text('---\nname: clean\ndescription: "비밀값이 없는 스킬"\n---\n\n# clean\n', encoding="utf-8")
        reg = root / "pods.json"
        reg.write_text(json.dumps({"pods": [{"id": "t", "owner": "t@example.com", "hermes_home": str(cls.home)}]}))
        cls.old = {k: os.environ.get(k) for k in ("AAS_OIDC_ISSUER", "AAS_OIDC_CLIENT_FILE", "AAS_USERS_FILE", "AAS_ALLOWED_HOSTS", "AAS_PODS_FILE")}
        for k in cls.old:
            os.environ.pop(k, None)
        os.environ["AAS_USERS_FILE"] = str(root / "no-users.json")
        os.environ["AAS_PODS_FILE"] = str(root / "no-pods.json")
        server._auth = auth.Auth({"issuer": "https://accounts.google.com", "client_id": "", "client_secret": "", "domain": "",
                                  "public_url": "http://localhost:17900", "hours": 1, "users_file": root / "no-users.json"})
        server._registry = pods.Registry(reg)
        cls.httpd = aasserver.start()
        cls.port = cls.httpd.server_port

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        for k, v in cls.old.items():
            if v is not None:
                os.environ[k] = v
        server._auth = server._registry = None

    def get(self, path):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request("GET", path)
        r = c.getresponse()
        body = r.read()
        headers = {k.lower(): v for k, v in r.getheaders()}
        c.close()
        return r.status, headers, body

    def url(self, profile="ma", path="skills/ops/weekly"):
        return f"/api/skill/download?profile={profile}&path={quote(path)}"

    def test_the_skill_folder_comes_back_as_a_zip_with_skill_md_at_the_top(self):
        status, headers, body = self.get(self.url(path="skills/ops/clean"))
        self.assertEqual(status, 200)
        self.assertEqual(headers["content-type"], "application/zip")
        self.assertIn('filename="clean.zip"', headers["content-disposition"])
        names = zipfile.ZipFile(io.BytesIO(body)).namelist()
        self.assertEqual(names, ["SKILL.md"])                                    # 제외가 없으면 EXCLUDED.txt 도 없다
        self.assertNotIn("x-aas-excluded", headers)

    def test_files_with_secrets_are_left_out_and_named_in_the_header_and_in_excluded_txt(self):
        status, headers, body = self.get(self.url())
        self.assertEqual(status, 200)
        z = zipfile.ZipFile(io.BytesIO(body))
        names = set(z.namelist())
        self.assertEqual(names, {"SKILL.md", "scripts/run.py", "references/note.md", "EXCLUDED.txt"})   # 점 파일은 지금처럼 말없이 뺀다
        self.assertNotIn("scripts/leaky.py", names)
        self.assertEqual(json.loads(headers["x-aas-excluded"]), ["scripts/leaky.py"])
        note = z.read("EXCLUDED.txt").decode("utf-8")
        self.assertIn("scripts/leaky.py", note)
        self.assertNotIn(KEY, b"".join(z.read(n) for n in z.namelist()).decode("utf-8"))   # 비밀값은 어느 파일에도 담기지 않는다

    # ---- 올리기 라우트 ----------------------------------------------------------------------
    def post(self, path, data, content_type="application/zip"):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request("POST", path, body=data, headers={"Content-Type": content_type, "X-AAS": "1"})
        r = c.getresponse()
        body = json.loads(r.read() or b"{}")
        c.close()
        return r.status, body

    def apply(self, **body):
        return self.post("/api/skill/apply", json.dumps(body).encode(), "application/json")

    def upload(self, files, profile="ma"):
        status, info = self.post(f"/api/skill/upload?profile={profile}", make_zip(files))
        self.assertEqual(status, 200, info)
        return info

    def test_upload_returns_the_preview_and_tells_a_name_conflict(self):
        info = self.upload({"SKILL.md": SKILL.replace("name: weekly", "name: brand-new")})
        self.assertEqual((info["name"], info["conflict"], info["only_skill_md"]), ("brand-new", False, True))
        self.assertEqual(len(info["hash"]), 64)
        self.assertTrue(self.upload({"SKILL.md": SKILL})["conflict"])                # ma 에 weekly 가 이미 있다

    def test_the_upload_limit_is_512kib_while_the_general_post_limit_stays_256kib(self):
        self.assertEqual(self.post("/api/skill/upload?profile=ma", make_zip({"SKILL.md": SKILL}))[0], 200)
        status, _ = self.post("/api/skill/upload?profile=ma", b"x" * (300 * 1024))   # 256KiB 를 넘어도 이 경로는 받고 zip 이 아니라서 400
        self.assertEqual(status, 400)
        status, body = self.post("/api/skill/upload?profile=ma", b"x" * (skill_files.UPLOAD_MAX + 1))
        self.assertEqual(status, 413)
        self.assertIn("512", body["error"])
        self.assertEqual(self.post("/api/settings", b"x" * (300 * 1024), "application/json")[0], 413)   # 일반 POST 한도는 그대로

    def test_only_admins_and_owners_may_upload_or_apply(self):
        with mock.patch.object(server, "_may_upload", return_value=False):
            self.assertEqual(self.post("/api/skill/upload?profile=ma", make_zip({"SKILL.md": SKILL}))[0], 403)
            self.assertEqual(self.apply(hash="0" * 64, profile="ma")[0], 403)

    def test_a_skill_md_only_bundle_goes_through_the_hermes_skill_api_into_uploaded(self):
        info = self.upload({"SKILL.md": SKILL.replace("name: weekly", "name: brand-new")})
        calls = []
        api = mock.Mock()
        api.return_value.call.side_effect = lambda *a: calls.append(a) or {}
        with mock.patch.object(server, "HermesAPI", api), mock.patch.object(server, "hub", return_value=mock.Mock()):
            status, out = self.apply(hash=info["hash"], profile="ma")
        self.assertEqual((status, out["state"], out["name"]), (200, "done", "brand-new"), out)
        method, path, payload = calls[-1]
        self.assertEqual((method, path, payload["name"], payload["category"], payload["profile"]), ("POST", "/api/skills", "brand-new", "uploaded", "ma"))
        self.assertTrue(payload["content"].startswith("---\nname: brand-new"))

    def test_a_conflicting_name_can_be_changed_at_apply_and_the_header_follows(self):
        info = self.upload({"SKILL.md": SKILL})                                   # weekly 가 이미 있다
        api = mock.Mock()
        calls = []
        api.return_value.call.side_effect = lambda *a: calls.append(a) or {}
        with mock.patch.object(server, "HermesAPI", api), mock.patch.object(server, "hub", return_value=mock.Mock()):
            self.assertEqual(self.apply(hash=info["hash"], profile="ma")[0], 409)               # 이름을 안 바꾸면 거절
            status, out = self.apply(hash=info["hash"], profile="ma", name="weekly-two")
        self.assertEqual((status, out["name"]), (200, "weekly-two"))
        self.assertIn("name: weekly-two", calls[-1][2]["content"])

    def test_scripts_need_confirmation_and_go_out_as_a_hermes_task_only_in_kubernetes(self):
        info = self.upload({**FULL, "SKILL.md": SKILL.replace("name: weekly", "name: with-script")})
        self.assertEqual(len(info["scripts"]), 1)
        self.assertEqual(self.apply(hash=info["hash"], profile="ma")[0], 400)                   # 확인 체크 없이는 거절
        with mock.patch.object(server, "_upload_client", return_value=None):
            status, out = self.apply(hash=info["hash"], profile="ma", confirm_scripts=True)
            self.assertEqual(status, 400)                                                         # compose 에서는 파일이 든 묶음을 받지 않는다
            self.assertIn("SKILL.md", out["error"])
        sent = []
        with mock.patch.object(server, "_upload_client", return_value=mock.Mock(namespace="ns")), \
                mock.patch.object(skill_files, "send_bundle", side_effect=lambda *a, **k: sent.append(a) or "done"):
            status, out = self.apply(hash=info["hash"], profile="ma", confirm_scripts=True)
        self.assertEqual(status, 200, out)
        self.assertEqual((out["state"], out["scripts"]), ("done", 1))
        self.assertEqual(sent[0][2:4], ("ma", "with-script"))

    def test_after_a_hermes_task_places_the_folder_hermes_reloads_its_skill_commands(self):
        """파일로 놓인 스킬은 Hermes 가 다시 읽기(skills.reload) 전에는 /스킬 명령 목록에 없다 — 새 대화에서 「noskill」이었다
        (2026-10-28 OKE, Claude Code 로 올린 스크립트 스킬, OMAI-1513 스펙 Q10). 적용이 끝나면 그 프로파일로 다시 읽게 한다.
        다시 읽기가 실패해도 적용은 성공이다(파일은 놓였다)."""
        info = self.upload({**FULL, "SKILL.md": SKILL.replace("name: weekly", "name: reload-me")})
        hub = mock.Mock()
        with mock.patch.object(server, "_upload_client", return_value=mock.Mock(namespace="ns")), \
                mock.patch.object(skill_files, "send_bundle", return_value="done"), mock.patch.object(server, "hub", return_value=hub):
            status, out = self.apply(hash=info["hash"], profile="ma", confirm_scripts=True)
        self.assertEqual((status, out.get("reload")), (200, "ok"), out)
        hub.request.assert_called_once()
        self.assertEqual(hub.request.call_args[0][:2], ("skills.reload", {"profile": "ma"}))
        info = self.upload({**FULL, "SKILL.md": SKILL.replace("name: weekly", "name: reload-two")})
        hub.request.side_effect = RuntimeError("gateway down")
        with mock.patch.object(server, "_upload_client", return_value=mock.Mock(namespace="ns")), \
                mock.patch.object(skill_files, "send_bundle", return_value="done"), mock.patch.object(server, "hub", return_value=hub):
            status, out = self.apply(hash=info["hash"], profile="ma", confirm_scripts=True)
        self.assertEqual((status, out.get("reload")), (200, "failed"), out)

    def test_a_hidden_root_an_unknown_profile_and_an_expired_hash_are_refused(self):
        info = self.upload({"SKILL.md": SKILL.replace("name: weekly", "name: brand-new")})
        with mock.patch.object(server.cron_policy, "root_hidden", return_value=True):
            status, out = self.apply(hash=info["hash"], profile="default")
        self.assertEqual(status, 400)
        self.assertIn("main", out["error"])
        self.assertEqual(self.apply(hash=info["hash"], profile="ghost")[0], 400)
        self.assertEqual(self.apply(hash="f" * 64, profile="ma")[0], 410)

    def test_skills_list_says_whether_the_viewer_can_upload(self):
        with mock.patch.object(server, "_may_upload", return_value=False):
            self.assertFalse(json.loads(self.get("/api/skills")[2])["can_upload"])
        self.assertTrue(json.loads(self.get("/api/skills")[2])["can_upload"])                   # 로그인이 꺼진 시험 환경은 관리자와 같다

    def test_a_downloaded_zip_can_be_uploaded_again_as_the_same_skill(self):
        """내려받기→올리기 왕복(스펙 §3-2): 뺀 파일과 EXCLUDED.txt 를 빼고 같은 스킬이 된다."""
        _, _, blob = self.get(self.url())
        info = skill_files.inspect(blob)
        self.assertEqual(sorted(f["path"] for f in info["files"]), ["SKILL.md", "references/note.md", "scripts/run.py"])
        self.assertEqual((info["name"], info["scripts"][0]["path"]), ("weekly", "scripts/run.py"))

    def test_bad_requests_are_refused_without_reading_outside_the_profile(self):
        self.assertEqual(self.get(self.url(path="skills/ops/nope"))[0], 404)
        self.assertEqual(self.get(self.url(path="skills/../../etc"))[0], 400)         # 상위 경로
        self.assertEqual(self.get(self.url(path="profiles/ma"))[0], 400)               # skills/ 밖
        self.assertEqual(self.get(self.url(profile="ghost"))[0], 404)                  # 없는 프로파일


def make_zip(files: dict, wrap: str = "") -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for rel, data in files.items():
            z.writestr(wrap + rel, data)
    return buf.getvalue()


SKILL = '---\nname: weekly\ndescription: "주간 보고를 만든다"\n---\n\n# weekly\n'
FULL = {"SKILL.md": SKILL, "references/note.md": "참고\n",
        "scripts/run.py": "#!/usr/bin/env python3\n# 주간 보고 데이터를 모은다\nimport requests\nrequests.get('https://api.example.com/v1/x')\n"}


class UploadInspectTest(unittest.TestCase):
    def refused(self, blob, code):
        with self.assertRaises(MarketError) as cm:
            skill_files.inspect(blob)
        self.assertEqual(cm.exception.code, code)
        return str(cm.exception)

    def test_a_skill_md_only_zip_is_previewed_with_its_name_and_hash(self):
        out = skill_files.inspect(make_zip({"SKILL.md": SKILL}))
        self.assertEqual((out["name"], out["name_valid"], out["description"], out["only_skill_md"], out["scripts"]), ("weekly", True, "주간 보고를 만든다", True, []))
        self.assertEqual(len(out["hash"]), 64)

    def test_scripts_are_listed_with_what_they_do_and_the_hosts_they_call(self):
        out = skill_files.inspect(make_zip(FULL))
        self.assertFalse(out["only_skill_md"])
        self.assertEqual(out["scripts"], [{"path": "scripts/run.py", "summary": "주간 보고 데이터를 모은다", "hosts": ["api.example.com"]}])
        self.assertEqual([f["path"] for f in out["files"]], ["SKILL.md", "references/note.md", "scripts/run.py"])

    def test_a_zip_of_the_folder_itself_and_macos_leftovers_are_accepted(self):
        out = skill_files.inspect(make_zip({**FULL, "__MACOSX/._SKILL.md": "x", ".DS_Store": "x"}, wrap="weekly/"))
        self.assertEqual([f["path"] for f in out["files"]], ["SKILL.md", "references/note.md", "scripts/run.py"])

    def test_the_excluded_note_from_a_download_is_not_taken_as_a_skill_file(self):
        """내려받기가 넣는 EXCLUDED.txt 는 올릴 때 스킬 파일로 받지 않는다(DR6). 폴더째 묶은 zip 안의 것도 같다."""
        for wrap in ("", "weekly/"):
            out = skill_files.inspect(make_zip({**FULL, "EXCLUDED.txt": "scripts/leaky.py\n"}, wrap=wrap))
            self.assertNotIn("EXCLUDED.txt", [f["path"] for f in out["files"]], wrap)

    def test_things_that_cannot_be_accepted(self):
        self.assertIn("zip", self.refused(b"not a zip", 400))
        self.refused(make_zip({"readme.md": "x"}), 400)                                   # SKILL.md 없음
        self.refused(make_zip({"SKILL.md": SKILL, "../evil.py": "x"}), 400)               # 상위 경로
        self.refused(make_zip({"SKILL.md": SKILL, "/abs.py": "x"}), 400)                  # 절대 경로
        self.refused(b"x" * (skill_files.UPLOAD_MAX + 1), 413)                             # 한도 512KiB
        msg = self.refused(make_zip({"SKILL.md": SKILL, "scripts/leak.py": f'KEY = "{KEY}"\n'}), 400)
        self.assertIn("scripts/leak.py", msg)                                              # 비밀값이 든 파일 이름을 알린다

    def test_a_symlink_entry_is_refused(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("SKILL.md", SKILL)
            info = zipfile.ZipInfo("link")
            info.external_attr = 0o120777 << 16
            z.writestr(info, "/etc/passwd")
        self.refused(buf.getvalue(), 400)


class UploadApplyTest(unittest.TestCase):
    def setUp(self):
        self.blob = make_zip(FULL)

    def test_the_stored_file_is_found_again_only_by_its_owner_and_pod_and_expires(self):
        h = skill_files.keep(self.blob, "p1", "kim@example.com")
        self.assertEqual(skill_files.recall(h, "p1", "kim@example.com"), self.blob)
        for args in ((h, "p2", "kim@example.com"), (h, "p1", "lee@example.com"), ("x" * 64, "p1", "kim@example.com"), ("../etc", "p1", "kim@example.com")):
            with self.assertRaises(MarketError) as cm:
                skill_files.recall(*args)
            self.assertEqual(cm.exception.code, 410)
        with mock.patch.object(skill_files.time, "time", return_value=time.time() + skill_files.TTL + 5):
            with self.assertRaises(MarketError) as cm:
                skill_files.recall(h, "p1", "kim@example.com")
        self.assertEqual(cm.exception.code, 410)

    def test_conflicts_bad_names_and_unconfirmed_scripts_are_refused_again_at_apply(self):
        for name, taken, ok, code in (("", {"weekly"}, True, 409), ("Bad Name", set(), True, 400), ("weekly", set(), False, 400)):
            with self.assertRaises(MarketError) as cm:
                skill_files.prepare(self.blob, name, taken, ok)
            self.assertEqual(cm.exception.code, code, (name, taken, ok))

    def test_renaming_rewrites_the_name_in_skill_md(self):
        plan = skill_files.prepare(self.blob, "weekly-two", {"weekly"}, True)
        self.assertEqual(plan["name"], "weekly-two")
        self.assertIn("name: weekly-two", plan["content"])
        self.assertNotIn("name: weekly\n", plan["content"])
        self.assertEqual(skill_files.prepare(self.blob, "", set(), True)["name"], "weekly")     # 이름을 안 주면 머리말의 것

    def test_the_distribution_carries_only_the_uploaded_folder_with_executable_scripts(self):
        plan = skill_files.prepare(self.blob, "weekly", set(), True)
        raw = skill_files.distribution("main", "weekly", plan["files"], "kim@example.com")
        tar = tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz")
        names = {m.name: m for m in tar.getmembers()}
        self.assertEqual(set(names), {"distribution.yaml", "skills/uploaded/weekly/SKILL.md", "skills/uploaded/weekly/references/note.md", "skills/uploaded/weekly/scripts/run.py"})
        self.assertEqual(names["skills/uploaded/weekly/scripts/run.py"].mode, 0o755)               # 실행 비트(zip 은 잃는다)
        self.assertEqual(names["skills/uploaded/weekly/SKILL.md"].mode, 0o644)
        import yaml
        manifest = yaml.safe_load(tar.extractfile("distribution.yaml").read())
        self.assertEqual((manifest["name"], manifest["distribution_owned"]), ("main", ["skills/uploaded/weekly"]))   # skills/market/ 이 아니다

    def test_the_distribution_files_carry_the_upload_time(self):
        """Hermes 는 tar 의 시각을 그대로 풀어 놓는다. 0 이면 스킬의 수정 시각이 1970-01-01 로 보였다(2026-10-28 OKE cc-mcp-count2)."""
        plan = skill_files.prepare(self.blob, "weekly", set(), True)
        before = time.time()
        tar = tarfile.open(fileobj=io.BytesIO(skill_files.distribution("main", "weekly", plan["files"], "kim")), mode="r:gz")
        for m in tar.getmembers():
            self.assertGreaterEqual(m.mtime, int(before), m.name)

    def test_a_bundle_over_the_payload_limit_is_refused_before_sending(self):
        big = [("SKILL.md", SKILL.encode()), ("data.bin", __import__("os").urandom(600 * 1024))]
        with self.assertRaises(MarketError) as cm:
            skill_files.distribution("main", "big", big, "kim")
        self.assertEqual(cm.exception.code, 413)

    def fake_client(self, phases):
        client = mock.Mock(namespace="ns")
        client.get_task.side_effect = [{"status": {"phase": p, "message": "끝"}} if p else {} for p in phases]
        return client

    def test_send_bundle_waits_for_the_task_and_reports_success_failure_or_pending(self):
        files = skill_files.prepare(self.blob, "weekly", set(), True)["files"]
        with mock.patch.object(skill_files.time, "sleep"):
            ok = self.fake_client([None, "Succeeded"])
            self.assertEqual(skill_files.send_bundle(ok, "t", "main", "weekly", files, "kim"), "done")
            sent = ok.create_task.call_args[0][0]
            self.assertEqual((sent["spec"]["type"], sent["spec"]["profile"], sent["spec"]["agent"], sent["spec"]["force"]), ("ProfileInstall", "main", "t", True))
            ok.delete_task.assert_called_once()
            bad = self.fake_client(["Failed"])
            with self.assertRaises(MarketError) as cm:
                skill_files.send_bundle(bad, "t", "main", "weekly", files, "kim")
            self.assertEqual(cm.exception.code, 502)
            slow = self.fake_client([None] * 50)
            self.assertEqual(skill_files.send_bundle(slow, "t", "main", "weekly", files, "kim", wait=0.0), "pending")
        boom = mock.Mock(namespace="ns")
        boom.create_task.side_effect = k8s.K8sError("거절", 403)
        with self.assertRaises(MarketError) as cm:
            skill_files.send_bundle(boom, "t", "main", "weekly", files, "kim")
        self.assertEqual(cm.exception.code, 503)


if __name__ == "__main__":
    unittest.main()
