# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""프로파일 템플릿 만들기·게시 시험(스펙 2026-11-18-002 2단계) — 묶음에 담기는 것과 빠지는 것, MCP 값의 ${KEY} 바꾸기,
예약 작업 필드 고르기, 검사(비밀값·막힌 이름·공용 구역 stdio·사내 주소), 하루 한도, 같은 이름, 내리기 권한, 만든 묶음을 설치 쪽이 받는지."""
import io
import json
import os
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

import yaml

TMP = tempfile.TemporaryDirectory()
os.environ["AAS_DATA_DIR"] = str(Path(TMP.name) / "data")

from aas.market import market_publish as mp, market_stage as ms, marketplace as mk, profile_template as pt, template_checks as tc  # noqa: E402

SKILL = "---\nname: proposal\ndescription: 영업 제안서 초안을 만드는 스킬입니다\nrequired_environment_variables:\n  - name: DEEPL_KEY\n    prompt: 번역 키\n---\n본문"
CONFIG = {"model": {"default": "openmaru-cogentai", "provider": "custom"}, "telegram": {"allowed_users": "1"}, "toolsets": ["web"],
          "terminal": {"cwd": "/opt/data/x"}, "skills": {"disabled": ["old"], "external_dirs": ["/opt/data/shared"]},
          "mcp_servers": {"jira": {"url": "https://jira.example/mcp", "headers": {"Authorization": "Bearer abc123"}},
                          "docs": {"url": "https://docs.example/mcp", "headers": {"Authorization": "Bearer ${MCP_DOCS_API_KEY}"}},
                          "fs": {"command": "npx", "args": ["-y", "@s/fs@1.0.0"], "env": {"FS_TOKEN": "zzz"}}}}
JOBS = {"jobs": [{"id": "j1", "name": "주간 정리", "prompt": "정리해", "schedule": {"kind": "cron", "expr": "0 9 * * 1"}, "enabled": True,
                  "deliver": "telegram:123", "origin": {"platform": "telegram", "chat_id": "123"}, "model": "m", "workdir": "/opt/data/w",
                  "monitor_url": "https://m", "last_status": "ok"}]}


def put(root: Path, files: dict):
    for rel, text in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")


class Base(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(dir=TMP.name))
        self.root = self.home / "profiles" / "sales"
        put(self.root, {"SOUL.md": "나는 영업 도우미", "config.yaml": yaml.safe_dump(CONFIG, allow_unicode=True), "cron/jobs.json": json.dumps(JOBS, ensure_ascii=False),
                        ".env": "DEEPL_KEY=real-secret-value\n", "memories/MEMORY.md": "고객 A", "sessions/s.json": "{}", "auth.json": "{}",
                        "skills/local/proposal/SKILL.md": SKILL})
        for f in mp._dir().glob("*"):
            f.unlink()
        self.cfg = {"url": "http://hub", "token_file": "", "namespaces": ["free", "paid"]}
        self._p = [mock.patch.object(mk, "settings", return_value=self.cfg), mock.patch.object(mk, "fetch", side_effect=mk.MarketError("없음", 404)),
                   mock.patch.object(mk, "default_packages", return_value=[])]
        for p in self._p:
            p.start()

    def tearDown(self):
        for p in self._p:
            p.stop()

    def build(self, ns="paid", **kw):
        return pt.build("p1", self.home, "sales", name="sales", description="영업 제안서와 견적을 돕는 프로파일입니다", namespace=ns, author="김영업", **kw)


class BuildTest(Base):
    def test_bundle_contents_and_what_is_left_out(self):
        out = self.build()
        files = dict(out["files"])
        self.assertEqual(sorted(files), ["SKILL.md", "agent/README.md", "agent/SOUL.md", "agent/config.yaml", "agent/cron/jobs.json", "agent/distribution.yaml",
                                         "agent/skills/local/proposal/SKILL.md"])
        blob = b"".join(files.values()).decode()
        for gone in ("real-secret-value", "abc123", "zzz", "고객 A", "telegram:123", "allowed_users", "/opt/data/shared", "openmaru-cogentai\n  provider"):
            self.assertNotIn(gone, blob)
        cfg = yaml.safe_load(files["agent/config.yaml"])
        self.assertEqual(sorted(cfg), ["mcp_servers", "skills", "toolsets"])           # 허용 키만(model·채널·terminal 없음)
        self.assertEqual(cfg["mcp_servers"]["jira"]["headers"]["Authorization"], "Bearer ${MCP_JIRA_AUTHORIZATION}")
        self.assertEqual(cfg["mcp_servers"]["docs"]["headers"]["Authorization"], "Bearer ${MCP_DOCS_API_KEY}")
        self.assertEqual(cfg["mcp_servers"]["fs"]["env"], {"FS_TOKEN": "${FS_TOKEN}"})
        job = json.loads(files["agent/cron/jobs.json"])["jobs"][0]
        self.assertEqual((job["enabled"], job["deliver"]), (False, "local"))
        for k in ("origin", "model", "workdir", "monitor_url", "last_status"):
            self.assertNotIn(k, job)
        man = yaml.safe_load(files["agent/distribution.yaml"])
        names = [e["name"] for e in man["env_requires"]]
        self.assertEqual(names, ["DEEPL_KEY", "FS_TOKEN", "MCP_DOCS_API_KEY", "MCP_JIRA_AUTHORIZATION"])
        self.assertFalse(any("default" in e for e in man["env_requires"]))
        self.assertEqual((man["aas"]["template"], man["aas"]["model_hint"]), (1, "openmaru-cogentai"))
        self.assertEqual(out["errors"], [])
        self.assertEqual([s["name"] for s in out["stdio"]], ["fs"])

    def test_first_chat_examples_go_into_the_manifest(self):
        out = self.build(examples=["  견적 요청을 정리해 줘 ", "", "제안서 초안"] + [f"x{i}" for i in range(10)])
        man = yaml.safe_load(dict(out["files"])["agent/distribution.yaml"])
        self.assertEqual(man["aas"]["examples"], ["견적 요청을 정리해 줘", "제안서 초안", "x0", "x1", "x2"])

    def test_key_notes_describe_keys_for_the_installer(self):
        # MCP 에서 꺼낸 KEY 는 설명이 비어 받는 사람 칸에 이름만 보였다(OKE my-template, 2026-11-18). 올리는 사람이 적은 설명을 쓴다
        out = self.build(key_notes={"MCP_DOCS_API_KEY": "  문서 사이트 \n 설정 › API 키에서 발급  ", "NOT_USED": "x", "FS_TOKEN": ""})
        man = yaml.safe_load(dict(out["files"])["agent/distribution.yaml"])
        desc = {e["name"]: e["description"] for e in man["env_requires"]}
        self.assertEqual(desc["MCP_DOCS_API_KEY"], "문서 사이트 설정 › API 키에서 발급")
        self.assertEqual(desc["MCP_JIRA_AUTHORIZATION"], "")                  # 적지 않은 KEY 는 그대로
        self.assertNotIn("NOT_USED", desc)                                   # 템플릿이 쓰지 않는 이름은 더하지 않는다
        long = self.build(key_notes={"MCP_DOCS_API_KEY": "가" * 500})["env_requires"]
        self.assertEqual(len(next(e for e in long if e["name"] == "MCP_DOCS_API_KEY")["description"]), 200)

    def test_model_reference_is_not_shown_as_a_model_name(self):
        put(self.root, {"config.yaml": yaml.safe_dump({"model": {"default": "${HERMES_LLM_MODEL}"}})})
        self.assertEqual(self.build()["model_hint"], "")               # AAS 기본 모델 참조는 받는 쪽에서 뜻이 없다(OKE 시험 2026-11-18)

    def test_choices_leave_items_out_and_recompute_keys(self):
        out = self.build(choices={"mcp": ["docs"], "cron": [], "skills": []})
        names = [e["name"] for e in out["env_requires"]]
        self.assertEqual(names, ["MCP_DOCS_API_KEY"])
        self.assertNotIn("agent/cron/jobs.json", dict(out["files"]))
        self.assertEqual([i["included"] for i in out["items"]["mcp"]], [True, False, False])   # docs, fs, jira 순

    def test_soul_override_goes_only_into_the_bundle(self):
        out = self.build(soul_override="템플릿용 SOUL")
        self.assertEqual(dict(out["files"])["agent/SOUL.md"], "템플릿용 SOUL".encode())
        self.assertEqual((self.root / "SOUL.md").read_text(encoding="utf-8"), "나는 영업 도우미")

    def test_shared_zone_refuses_stdio_and_internal_addresses(self):
        out = self.build(ns="free")
        self.assertIn("stdio_public", [e["code"] for e in out["errors"]])
        put(self.root, {"SOUL.md": "사내 위키 https://wiki.example.local 를 본다"})      # 실제 사내 주소는 공개 스냅샷 검사(bin/export-public/rules.txt)가 막는다. 내부 전용 최상위 이름 .local 로 같은 검사를 본다
        self.assertIn("internal_ref", [e["code"] for e in self.build(ns="free", choices={"mcp": []})["errors"]])
        member = self.build(ns="paid", choices={"mcp": []})
        self.assertEqual(member["errors"], [])
        self.assertIn("internal_ref", [w["code"] for w in member["warnings"]])            # 제한 구역은 경고만

    def test_shared_zone_internal_addresses_pass_when_the_person_confirms(self):
        """사내 공유(스펙 2026-11-18-010): 올리는 사람이 확인하면 공용 구역의 사내 주소·사설 IP 는 오류가 아니라 경고다. 다른 오류는 그대로 막는다"""
        put(self.root, {"SOUL.md": "사내 위키 https://wiki.example.local 을 본다"})   # 사설 IP 를 시험에 적으면 공개본 사내 흔적 검사가 잡는다(.local 로 같은 검사를 본다)
        out = self.build(ns="free", choices={"mcp": []}, allow_internal=True)
        self.assertNotIn("internal_ref", [e["code"] for e in out["errors"]])
        self.assertIn("internal_ref_ok", [w["code"] for w in out["warnings"]])
        self.assertTrue(out["internal_refs"])                                        # 게시 기록에 남길 목록
        self.assertIn("stdio_public", [e["code"] for e in self.build(ns="free", allow_internal=True)["errors"]])   # 확인은 사내 주소만 푼다

    def test_blocked_reference_and_secret_in_soul_are_errors(self):
        cfg = dict(CONFIG, mcp_servers={"x": {"url": "https://x.example/mcp", "headers": {"A": "${LITELLM_API_KEY}"}}})
        put(self.root, {"config.yaml": yaml.safe_dump(cfg)})
        self.assertIn("env_ref_blocked", [e["code"] for e in self.build()["errors"]])
        put(self.root, {"SOUL.md": "키는 glpat-AAAAAAAAAAAAAAAAAAAAAAAA 이다", "config.yaml": "{}"})
        self.assertIn("secret_found", [e["code"] for e in self.build()["errors"]])

    def test_llm_env_of_a_skill_is_not_asked_or_blocked(self):
        """스펙 2026-11-19-002: LLM_BASE_URL(_BASE_URL 로 막힌 이름)을 선언한 스킬이 든 템플릿이 env_ref_blocked 로 멈추지 않고,
        LLM 접속값을 설치한 사람에게 묻지 않는다."""
        put(self.root, {"skills/local/crm/SKILL.md": "---\nname: crm\ndescription: 고객 관리 스킬입니다\n"
                        "required_environment_variables: [LLM_BASE_URL, LLM_API_KEY, LLM_MODEL, CRM_TOKEN]\n---\n본문"})
        out = self.build()
        self.assertNotIn("env_ref_blocked", [e["code"] for e in out["errors"]])
        man = yaml.safe_load(dict(out["files"])["agent/distribution.yaml"])
        names = [e["name"] for e in man["env_requires"]]
        self.assertIn("CRM_TOKEN", names)
        self.assertFalse(any(n.startswith(("LLM_", "HERMES_LLM_")) for n in names), names)

    def test_built_bundle_installs_through_stage(self):
        out = self.build(choices={"mcp": ["jira", "docs"]})
        pkg = Path(tempfile.mkdtemp(dir=TMP.name)) / "pkg"
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            for rel, data in out["files"]:
                z.writestr(rel, data)
        ms.extract(buf.getvalue(), pkg, {})
        req = {"id": "20261118090000000000-abcdef", "namespace": "paid", "name": "sales", "package": "paid/sales", "version": "1.0.0", "profile": "b1",
               "kind": "agent", "mode": "install", "pod": "p2"}
        report = {}
        man = ms.stage(req, pkg, Path(tempfile.mkdtemp(dir=TMP.name)) / "out", current={"config.yaml": yaml.safe_dump({"model": {"default": "mine"}})}, report=report)
        self.assertIn("skills/local/proposal", man["distribution_owned"])
        self.assertEqual(report["waiting_mcp"], ["docs", "jira"])


class PublishTest(Base):
    def publish(self, who="kim@x.io", admin=False, **kw):
        args = dict(name="sales", description="영업 제안서와 견적을 돕는 프로파일입니다", namespace="paid", author="김영업", choices={"mcp": ["jira"]})
        args.update(kw)
        with mock.patch.object(mp, "_post", return_value=(200, {"code": 0, "data": {"status": "PUBLISHED"}})) as post, \
                mock.patch.object(pt, "_notify_admins") as note:
            out = pt.publish("p1", self.home, "sales", who, admin=admin, **args)
        return out, post, note

    def test_dry_run_does_not_publish_or_count(self):
        out, post, _ = self.publish(dry_run=True)
        self.assertEqual((out["status"], out["version"], out["used"]), ("preview", "1.0.0", 0))
        post.assert_not_called()
        self.assertEqual(pt.used_today("kim@x.io"), [])

    def test_publish_records_and_notifies_and_counts(self):
        out, post, note = self.publish()
        self.assertEqual(out["status"], "published")
        post.assert_called_once()
        note.assert_called_once()
        row = mp.get(out["request_id"])
        self.assertEqual((row["kind"], row["who"], row["namespace"]), ("template", "kim@x.io", "paid"))
        self.assertEqual(len(pt.used_today("kim@x.io")), 1)
        self.assertEqual([m["name"] for m in pt.mine("kim@x.io")], ["sales"])

    def test_shared_zone_publish_with_internal_addresses_needs_confirmation(self):
        put(self.root, {"SOUL.md": "사내 위키 https://wiki.example.local 를 본다"})
        with self.assertRaises(pt.TemplateError) as cm:
            self.publish(namespace="free", choices={"mcp": []})
        self.assertEqual(cm.exception.reason, "internal_ref")
        out, post, _ = self.publish(namespace="free", choices={"mcp": []}, allow_internal=True)
        self.assertEqual(out["status"], "published")
        post.assert_called_once()                                                    # 게시 단계(mp._publish)도 같은 확인으로 통과한다
        row = mp.get(out["request_id"])
        self.assertEqual(row["internal_refs_ack"]["by"], "kim@x.io")
        self.assertTrue(row["internal_refs_ack"]["refs"])

    def test_errors_refuse_with_code(self):
        with self.assertRaises(pt.TemplateError) as cm:
            self.publish(namespace="free", choices={"mcp": ["fs"]})
        self.assertEqual((cm.exception.code, cm.exception.reason), (422, "stdio_public"))

    def test_daily_limit(self):
        with mock.patch.dict(os.environ, {"AAS_TEMPLATE_DAILY_LIMIT": "1"}):
            self.publish()
            with mock.patch.object(mp, "_exists", return_value={"namespace": "paid", "version": "1.0.0"}):
                with self.assertRaises(pt.TemplateError) as cm:
                    self.publish()
                self.assertEqual((cm.exception.code, cm.exception.reason), (429, "publish_daily_limit"))
                out, _, _ = self.publish(who="admin@x.io", admin=True)                    # 관리자 직접 게시는 세지 않는다
                self.assertEqual(out["version"], "1.0.1")

    def test_same_name_is_mine_to_bump_or_refused(self):
        self.publish()
        with mock.patch.object(mp, "_exists", return_value={"namespace": "paid", "version": "1.0.0"}):
            out, _, _ = self.publish()
            self.assertEqual((out["version"], out["update"]), ("1.0.1", True))
            with self.assertRaises(pt.TemplateError) as cm:
                self.publish(who="lee@x.io")
            self.assertEqual(cm.exception.reason, "name_taken")

    def test_mine_marks_templates_taken_down_on_the_hub(self):
        # 내린 템플릿이 「내가 올린」 목록에 올라간 것처럼 보이고 「내리기」가 붙었다(OKE #656, 2026-11-18). 내린 뒤 다시 올리면 다시 올라감
        self.publish()
        ts = pt.mine("kim@x.io")[0]["ts"]
        later = "2999-01-01T00:00:00+09:00"
        with mock.patch("aas.market.hub_hide.records", return_value=[{"namespace": "paid", "name": "sales", "by": "kim@x.io", "ts": later}]):
            self.assertEqual([(m["name"], m["status"]) for m in pt.mine("kim@x.io")], [("sales", "hidden")])
        with mock.patch("aas.market.hub_hide.records", return_value=[{"namespace": "paid", "name": "sales", "by": "kim@x.io", "ts": "2000-01-01T00:00:00+09:00"}]):
            self.assertEqual(pt.mine("kim@x.io")[0]["status"], "published")     # 숨긴 뒤에 다시 올린 판
        self.assertTrue(ts)

    def test_unpublish_only_by_publisher_or_admin(self):
        self.publish()
        with mock.patch.object(mp, "_exists", return_value={"namespace": "paid", "version": "1.0.0"}), \
                mock.patch("aas.market.hub_hide.hide", return_value={"hidden": True}) as hide:
            with self.assertRaises(pt.TemplateError) as cm:
                pt.unpublish("sales", "lee@x.io", False)
            self.assertEqual(cm.exception.code, 403)
            pt.unpublish("sales", "kim@x.io", False)
            pt.unpublish("sales", "boss@x.io", True)
        self.assertEqual(hide.call_count, 2)


class McpEntryTest(unittest.TestCase):
    def test_existing_references_are_kept_and_literals_replaced(self):
        keys = []
        entry, errors = pt.template_mcp("svc", {"url": "https://s/mcp", "env": {"lowercase": "v"}, "headers": {"X-Key": "plain"}, "args": ["-v"]},
                                        lambda k, u: keys.append(k))
        self.assertEqual(entry["env"]["lowercase"], "${MCP_SVC_LOWERCASE}")
        self.assertEqual(entry["headers"]["X-Key"], "${MCP_SVC_X_KEY}")
        self.assertEqual(errors, [])
        self.assertEqual(sorted(set(keys)), ["MCP_SVC_LOWERCASE", "MCP_SVC_X_KEY"])
        _, errors = pt.template_mcp("svc", {"command": "npx", "args": ["--token", "glpat-AAAAAAAAAAAAAAAAAAAAAAAA"]}, lambda k, u: None)
        self.assertTrue(errors)

    def test_cron_job_keeps_only_listed_fields(self):
        job = pt.template_job({"id": "a", "name": "n", "prompt": "p", "base_url": "http://x", "provider": "y", "origin": {"a": 1}, "repeat": {"times": 3, "completed": 2}})
        self.assertEqual(job["repeat"], {"times": 3, "completed": 0})
        self.assertNotIn("base_url", job)
        self.assertNotIn("provider", job)


if __name__ == "__main__":
    unittest.main()
