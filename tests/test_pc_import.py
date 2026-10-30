# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""내 PC 의 Hermes 를 main 에 넣기(OMAI-1136): 묶음 검사·한 파드 하나만·단계 실행과 되돌리기·멈춘 것 복구·받은편지함·확인할 것."""
import io
import json
import os
import tarfile
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import dbmigrate, store  # noqa: E402
from aas.fleet import k8s  # noqa: E402
from aas.ops import pc_import as pc  # noqa: E402


def bundle(files: dict, links: tuple = (), root: str = "default") -> bytes:
    """{상대 경로: 글} 로 tar.gz 를 만든다. links 는 심볼릭 링크 이름."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        if root:
            d = tarfile.TarInfo(root)
            d.type = tarfile.DIRTYPE
            tar.addfile(d)
        for rel, text in files.items():
            data = text.encode("utf-8") if isinstance(text, str) else text
            info = tarfile.TarInfo(f"{root}/{rel}" if root else rel)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
        for rel in links:
            info = tarfile.TarInfo(f"{root}/{rel}")
            info.type = tarfile.SYMTYPE
            info.linkname = "/etc/passwd"
            tar.addfile(info)
    return buf.getvalue()


JOBS = json.dumps({"jobs": [{"id": "a", "name": "아침 보고", "enabled": True, "script": "/Users/kim/bin/r.sh"},
                            {"id": "b", "name": "주간", "enabled": False}]})
SKILL_MAC = "---\nname: apple-notes\nplatforms: [macos]\n---\n본문"
SKILL_ANY = "---\nname: web\nrequired_env: [SERP_API_KEY]\n---\n본문"


class InspectTest(unittest.TestCase):
    def test_정상_묶음은_개수와_안내_목록을_낸다(self):
        got = pc.inspect_bytes(bundle({"SOUL.md": "나", "config.yaml": "model:\n  api_key: ${OPENAI_API_KEY}\n",
                                       "skills/apple/apple-notes/SKILL.md": SKILL_MAC, "skills/web/web/SKILL.md": SKILL_ANY,
                                       "cron/jobs.json": JOBS, "sessions/s1.json": "{}", "sessions/s2.json": "{}", "memories/m.md": "x"}))
        self.assertTrue(got["ok"], got)
        self.assertEqual(got["root"], "default")
        self.assertEqual(got["counts"], {"skills": 2, "cron": 2, "sessions": 2, "memories": 1, "soul": True})
        self.assertEqual(got["os_only_skills"], ["apple-notes"])
        self.assertEqual(got["pc_path_jobs"], ["아침 보고"])
        self.assertEqual(got["env_refs"], ["OPENAI_API_KEY", "SERP_API_KEY"])

    def test_거절_이유(self):
        # 2026-10-22-003 R4 계약: 링크·비밀 정보·plugins 는 거절하지 않고 걸러서 받는다(바뀐 행마다 새 기대값)
        got = pc.inspect_bytes(bundle({"SOUL.md": "x"}, links=("skills/evil",)))
        self.assertTrue(got["ok"], got)
        self.assertEqual((got["dropped"]["links"], got["dropped"]["link_skills"]), (1, ["evil"]))
        got = pc.inspect_bytes(bundle({"SOUL.md": "x", ".env": "AK=1"}))
        self.assertTrue(got["ok"], got)
        self.assertEqual(got["secrets"]["env_keys"], ["AK"])                      # 값은 남기지 않고 이름만
        got = pc.inspect_bytes(bundle({"SOUL.md": "x", "auth.json.bak": "{}"}))
        self.assertTrue(got["ok"], got)
        self.assertEqual((got["dropped"]["credential"], got["secrets"]["files"]), (1, []))   # 사본은 옮기지 않는다(R9)
        got = pc.inspect_bytes(bundle({"SOUL.md": "x", "mcp-tokens/x.json": "{}"}))
        self.assertEqual(got["secrets"]["files"], ["mcp-tokens/x.json"])           # 비밀 파일로 옮긴다(R9)
        got = pc.inspect_bytes(bundle({"SOUL.md": "x", "plugins/p.py": "print(1)"}))
        self.assertTrue(got["ok"], got)
        self.assertEqual(got["dropped"]["other_names"], ["plugins"])
        self.assertEqual(pc.inspect_bytes(bundle({"a.txt": "x"}, root=""))["reason"], "multi_root")   # 최상위 폴더 없이 파일만
        self.assertEqual(pc.inspect_bytes(bundle({"x": "y"}, root="../up"))["reason"], "bad_path")
        self.assertEqual(pc.inspect_bytes(b"not a tar")["reason"], "not_archive")
        two = io.BytesIO()
        with tarfile.open(fileobj=two, mode="w:gz") as tar:
            for name in ("a/SOUL.md", "b/SOUL.md"):
                info = tarfile.TarInfo(name)
                tar.addfile(info, io.BytesIO(b""))
        self.assertEqual(pc.inspect_bytes(two.getvalue())["reason"], "multi_root")

    def test_점_접두가_붙은_묶음도_같게_읽고_점_파일은_놓치지_않는다(self):
        """`tar -czf x -C dir .` 모양: 항목이 ./ 로 시작하고 . 폴더가 있다. ./default/.env 를 env 로 잘못 읽으면 비밀 파일을 놓친다."""
        ok = pc.inspect_bytes(bundle({"SOUL.md": "x"}, root="./default"))
        self.assertTrue(ok["ok"], ok)
        self.assertEqual(ok["root"], "default")
        dot = pc.inspect_bytes(bundle({"SOUL.md": "x", ".env": "AK=1"}, root="./default"))
        self.assertEqual(dot["secrets"]["env_keys"], ["AK"])                         # ./default/.env 도 최상위 .env 로 읽는다

    def test_풀린_크기_파일_수_한도(self):
        with mock.patch.object(pc, "max_unpacked", return_value=10):
            self.assertEqual(pc.inspect_bytes(bundle({"sessions/a": "x" * 20}))["reason"], "too_big")
        with mock.patch.object(pc, "max_members", return_value=2):
            self.assertEqual(pc.inspect_bytes(bundle({"a": "1", "b": "2", "c": "3"}))["reason"], "too_many")


def raw_profile_archive() -> bytes:
    """프로파일 폴더를 통째로 묶은 모양(2026-10-22 kimbiseo 조사). 내용·링크·비밀 정보·홈·plugins·로그·작업 폴더가 섞여 있다."""
    buf = io.BytesIO()

    def add(tar, rel, data=b"", kind=tarfile.REGTYPE, mode=0o644, link=""):
        info = tarfile.TarInfo(f"kimbiseo/{rel}" if rel else "kimbiseo")
        info.type, info.mode = kind, mode
        if kind == tarfile.SYMTYPE:
            info.linkname = link
            tar.addfile(info)
        elif kind == tarfile.DIRTYPE:
            tar.addfile(info)
        else:
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        add(tar, "", kind=tarfile.DIRTYPE, mode=0o755)
        add(tar, "SOUL.md", "나는 김비서".encode())
        add(tar, "memories", kind=tarfile.DIRTYPE, mode=0o755)
        add(tar, "memories/MEMORY.md", b"m")
        add(tar, "skills/b/SKILL.md", b"---\nname: b\n---\n")
        add(tar, "skills/yjops/a", kind=tarfile.SYMTYPE, link="/opt/data/skills/yjops/a")
        add(tar, "scripts/run.sh", b"#!/bin/sh\necho hi\n", mode=0o755)
        add(tar, "cron/jobs.json", json.dumps({"jobs": [{"id": "m", "name": "아침", "enabled": True, "state": "scheduled"}]}).encode())
        add(tar, ".env", b"# c\nexport TELEGRAM_BOT_TOKEN='t-1'\nSEARXNG_URL=\"http://s\"\nBAD LINE\nEMPTY=\n")
        add(tar, ".env.bak-1", b"OLD=1\n")
        add(tar, "google_token.json", b"{}")
        add(tar, "auth.json", b"{}")
        add(tar, "pairing", kind=tarfile.DIRTYPE, mode=0o700)
        add(tar, "whatsapp/session/s", b"x")
        add(tar, "home/.local/py", kind=tarfile.SYMTYPE, link="/opt/data/profiles/kimbiseo/home/.local/py3")
        add(tar, "home/.local/lib.so", b"x" * 10)
        add(tar, "plugins/p.py", b"print(1)")
        add(tar, "state.db", b"db")
        add(tar, "logs/agent.log", b"log")
        add(tar, "workspace/doc.txt", b"d")
    return buf.getvalue()


def filtered(blob: bytes, secrets_enabled: bool = True):
    """(검사 결과, 내용 묶음 바이트, 비밀 묶음 바이트)."""
    content, secret = io.BytesIO(), io.BytesIO()
    got = pc.inspect(io.BytesIO(blob), content_out=content, secrets_out=secret, secrets_enabled=secrets_enabled)
    return got, content.getvalue(), secret.getvalue()


def members(blob: bytes) -> dict:
    if not blob:
        return {}
    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as tar:
        return {m.name.split("/", 1)[1] if "/" in m.name else "": m for m in tar}


class FilterTest(unittest.TestCase):
    """2026-10-22-003: 프로파일 폴더를 통째로 묶은 묶음을 거절하지 않고 내용 묶음·비밀 묶음으로 걸러 받는다."""

    def test_통째로_묶은_묶음을_걸러서_받는다(self):
        """protects=kimbiseo 모양 묶음이 ok 이고 dropped·secrets 개수가 맞음; fails_when=credential·link·plugins 로 거절하거나 개수가 틀림; no_claim=실제 OKE 묶음은 OKE 확인(기준 15)"""
        got, content, secret = filtered(raw_profile_archive())
        self.assertTrue(got["ok"], got)
        self.assertEqual(got["dropped"]["link_skills"], ["a"])
        self.assertEqual(got["dropped"]["links"], 2)                               # 링크는 비밀 경로보다 먼저 센다(§4-1 순서 4)
        self.assertEqual(got["secrets"]["files"], ["google_token.json"])
        self.assertEqual(got["secrets"]["files_count"], 1)
        self.assertEqual(got["secrets"]["env_keys"], ["SEARXNG_URL", "TELEGRAM_BOT_TOKEN"])
        self.assertEqual(got["secrets"]["env_unreadable"], ["EMPTY"])            # `=` 없는 줄은 이름을 알 수 없어 보이지 않는다
        self.assertEqual(got["secrets"]["model_files"], ["auth.json"])
        self.assertEqual(sorted(g["name"] for g in got["dropped"]["credential_groups"]),
                         [".env.bak-1", "auth.json", "home", "whatsapp"])          # 빈 pairing/ 은 어디에도 세지 않는다
        self.assertEqual(sorted(g["name"] for g in got["dropped"]["other_groups"]), ["logs", "plugins", "state.db", "workspace"])
        self.assertNotIn("workspace", got["dropped"])                              # DD18: 작업 폴더는 「그 밖」의 한 줄
        self.assertEqual(got["counts"]["soul"], True)
        self.assertEqual(got["secrets_enabled"], True)
        self.assertNotIn("t-1", json.dumps(got))                                   # 값은 어디에도 없다

    def test_내용_묶음은_내용_항목만이고_크론은_멈춰_있다(self):
        """protects=내용 묶음에 내용 항목의 일반 파일·폴더만, 실행 비트 유지, 크론 일시정지; fails_when=비밀·링크가 섞이거나 크론이 켜진 채; no_claim=Hermes 가져오기 자체는 가짜"""
        _got, content, _secret = filtered(raw_profile_archive())
        m = members(content)
        for rel, info in m.items():
            if not rel:
                continue
            self.assertTrue(info.isreg() or info.isdir(), rel)
            self.assertIn(rel.split("/")[0], pc.CONTENT_ITEMS, rel)
            self.assertFalse(pc._credential(rel), rel)
        self.assertEqual(m["scripts/run.sh"].mode & 0o777, 0o755)
        with tarfile.open(fileobj=io.BytesIO(content), mode="r:gz") as tar:
            jobs = json.loads(tar.extractfile("kimbiseo/cron/jobs.json").read())["jobs"]
        self.assertEqual((jobs[0]["enabled"], jobs[0]["state"]), (False, "paused"))

    def test_비밀_묶음은_옮길_비밀과_env_만(self):
        """protects=비밀 묶음에 R20 범위 파일과 최상위 .env 만, 빈 폴더 없음; fails_when=auth.json·.env.bak·home·세션·빈 pairing 이 들어감; no_claim=오퍼레이터 합치기는 Go 시험"""
        _got, _content, secret = filtered(raw_profile_archive())
        self.assertEqual(sorted(k for k, v in members(secret).items() if k and v.isreg()), [".env", "google_token.json"])
        self.assertFalse(any(v.isdir() and k for k, v in members(secret).items()))

    def test_main_이_아닌_대상은_채널_연결_파일을_옮기지_않는다(self):
        """protects=OMAI-1444 R8(6종을 비밀 묶음·개수에서 빼고 이름만, 나머지 SECRET_MOVE 는 그대로); fails_when=research 에 채널 파일이 들어가거나 main 에서 빠짐; no_claim=Hermes 멀티플렉스 동작"""
        files = {"SOUL.md": "x", "google_token.json": "{}", "slack_tokens.json": "{}", "webhook_subscriptions.json": "{}",
                 "teams_pipeline_store.json": "{}", "pairing/a.json": "{}", "platforms/pairing/b.json": "{}", "feishu_comment_pairing.json": "{}"}
        blob = bundle(files)
        content, secret = io.BytesIO(), io.BytesIO()
        skipped = pc.inspect(io.BytesIO(blob), content_out=content, secrets_out=secret, skip_channels=True)
        self.assertTrue(skipped["ok"], skipped)
        self.assertEqual(skipped["channel_files_skipped"], sorted(pc.CHANNEL_MOVE))
        self.assertEqual((skipped["secrets"]["files"], skipped["secrets"]["files_count"], skipped["secrets"]["channel_files"]), (["google_token.json"], 1, 0))
        self.assertEqual(sorted(k for k, v in members(secret.getvalue()).items() if v.isreg()), ["google_token.json"])
        self.assertNotIn("slack_tokens.json", json.dumps(skipped["dropped"]))         # 「가져오지 않는 것」에 다시 세지 않는다
        kept, _c, kept_secret = filtered(blob)
        self.assertNotIn("channel_files_skipped", kept)                               # main 은 지금과 같다(R5)
        self.assertEqual(kept["secrets"]["files_count"], 7)
        self.assertIn("slack_tokens.json", members(kept_secret))
        only_channels = pc.inspect(io.BytesIO(bundle({"SOUL.md": "x", "slack_tokens.json": "{}"})), content_out=io.BytesIO(),
                                   secrets_out=io.BytesIO(), skip_channels=True)
        self.assertFalse(only_channels["secrets_bundle"])                            # 옮길 것이 채널 파일뿐이면 비밀 묶음이 없다

    def test_https_가_아니면_비밀_묶음을_만들지_않는다(self):
        """protects=R17 http 판정이면 비밀을 옮기지 않음; fails_when=http 에서도 비밀 묶음이 생김; no_claim=_secure 판정 자체는 경로 시험"""
        got, _content, secret = filtered(raw_profile_archive(), secrets_enabled=False)
        self.assertTrue(got["ok"], got)
        self.assertEqual((got["secrets_enabled"], got["secrets"]["files"], got["secrets"]["env_keys"]), (False, [], []))
        self.assertEqual(members(secret), {})
        self.assertEqual(got["dropped"]["secrets_off_names"], [".env", "google_token.json"])   # DD12: 「가져오지 않는 것」에 다시 세지 않는다
        self.assertNotIn("google_token.json", [g["name"] for g in got["dropped"]["credential_groups"]])

    def test_내용이_없으면_no_content(self):
        """protects=DD17 내용 없는 묶음은 no_content 와 최상위 이름; fails_when=ok 로 받거나 다른 사유; no_claim=화면 문구는 Vitest"""
        got = pc.inspect_bytes(bundle({"state.db": "x", "logs/a": "y"}))
        self.assertEqual(got["reason"], "no_content")
        self.assertEqual(got["top_names"], ["logs", "state.db"])

    def test_원본_크기_상한은_버릴_파일도_센다(self):
        """protects=R1 원본 전체 크기 상한(압축 폭탄); fails_when=남긴 것만 세서 3GiB logs 를 끝까지 풂; no_claim=실제 CPU 시간은 재지 않음"""
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tar:
            d = tarfile.TarInfo("default")
            d.type = tarfile.DIRTYPE
            tar.addfile(d)
            tar.addfile(tarfile.TarInfo("default/SOUL.md"), io.BytesIO(b""))
            big = tarfile.TarInfo("default/logs/x")
            big.size = 3 * 1024 ** 3
            tar.fileobj.write(big.tobuf())                                        # 머리만 쓴다(데이터 없이)
        self.assertEqual(pc.inspect_bytes(buf.getvalue())["reason"], "too_big")

    def test_env_읽기_규칙(self):
        """protects=R21 한 줄 규칙; fails_when=따옴표가 값에 남거나 이상한 줄을 넣음; no_claim=Hermes 의 .env 해석과 같다는 보장은 없음"""
        keys, bad = pc.parse_env(b"export AK='1'\nBK=\"two\"\n# x\n\nCK=3\nlower=1\nDK=\nEK='open\nFK=" + b"x" * 4001 + b"\n")
        self.assertEqual(keys, {"AK": "1", "BK": "two", "CK": "3"})
        self.assertEqual(sorted(bad), ["DK", "EK", "FK", "lower"])


class FakeAPI:
    """target 은 가져오는 대상 프로파일 이름(OMAI-1444 R5: main 으로 굳지 않게). souls 를 주면 SOUL 을 읽을 때마다 앞에서 하나씩 돌려준다."""

    def __init__(self, fail=None, target="main", souls=None):
        self.calls, self.fail, self.target, self.souls = [], fail or set(), target, list(souls or [])

    def call(self, method, path, body=None, query=None, timeout=30):
        self.calls.append((method, path, body, query))
        if (method, path) in self.fail:
            raise RuntimeError(f"boom {path}")
        if path == "/api/config/raw" and method == "GET":
            prof = (query or {}).get("profile")
            return {"yaml": "model:\n  default: aas\nterminal:\n  backend: docker\nagent:\n  max_turns: 10\n" if prof == self.target
                    else "model:\n  default: pc\nterminal:\n  backend: local\nagent:\n  max_turns: 99\n"}
        if path == f"/api/profiles/{self.target}/soul" and method == "GET" and self.souls:
            return {"content": self.souls.pop(0)}
        return {"ok": True}


class RunnerTest(unittest.TestCase):
    def setUp(self):
        with store.connect() as conn:
            conn.executescript(pc.SCHEMA)
            conn.execute("DELETE FROM pc_imports")
            conn.execute("DELETE FROM pc_exports")

    tearDown = setUp

    def job(self, pod="p1", summary=None, profile="main"):
        jid = pc.new_id()
        s = summary or {"ok": True, "counts": {"cron": 3}, "env_refs": ["OPENAI_API_KEY", "SERP_API_KEY"], "os_only_skills": ["apple-notes"], "pc_path_jobs": []}
        pc.record_upload(jid, pod, profile, "kim@x.com", "kim@x.com", False, "hermes.tar.gz", 100, s)
        self.assertTrue(pc.claim(jid, pod))
        return pc.get(jid)

    def test_한_파드에서_하나만_돈다(self):
        self.job()
        other = pc.new_id()
        pc.record_upload(other, "p1", "main", "kim@x.com", "kim@x.com", False, "b.tar.gz", 1, {"ok": True})
        self.assertFalse(pc.claim(other, "p1"))
        third = pc.new_id()
        pc.record_upload(third, "p2", "main", "lee@x.com", "lee@x.com", False, "c.tar.gz", 1, {"ok": True})
        self.assertTrue(pc.claim(third, "p2"))                     # 다른 파드는 따로

    def test_거절한_묶음은_시작할_수_없다(self):
        jid = pc.new_id()
        pc.record_upload(jid, "p1", "main", "a@x.com", "a@x.com", False, "x", 1, {"ok": False, "reason": "link"})
        self.assertEqual(pc.get(jid)["state"], "rejected")
        self.assertFalse(pc.claim(jid, "p1"))
        self.assertTrue(pc.cancel(jid))

    def test_성공_순서와_설정_얹기(self):
        """protects=OMAI-1444 R5 B(main·research 두 이름으로 같은 단계: 작업 spec.profile·설정 읽기·기록 profile 이 대상 이름); fails_when=어딘가 main 으로 굳음; no_claim=재시작 대상은 runner_for 시험"""
        for target in ("main", "research"):
            with self.subTest(target=target):
                job = self.job(pod=f"p-{target}", profile=target)
                api, tasks, restarts = FakeAPI(target=target), [], []
                r = pc.Runner(job, api, task=lambda *a, tasks=tasks: tasks.append(a),
                              restart=lambda api=api, restarts=restarts: restarts.append([c[:2] for c in api.calls]), env_names=lambda: {"OPENAI_API_KEY"})
                out = r.run()
                self.assertEqual((out["state"], out["profile"]), ("done", target))
                temp = pc.temp_profile(job["id"])
                self.assertEqual(api.calls[0][:3], ("POST", "/api/profiles/import", {"archive": f"/opt/data/{pc.upload_path(job['id'])}", "name": temp}))
                self.assertIn(("GET", "/api/config/raw", None, {"profile": target}), api.calls)   # 대상의 설정 위에 얹는다
                put = next(c for c in api.calls if c[0] == "PUT")
                self.assertEqual(put[3], {"profile": temp})                 # 얹은 설정은 임시 프로파일에 쓴다 — 대상은 작업이 바꾼다
                self.assertIn("backend: docker", put[2]["yaml_text"])       # 실행 위치는 대상 값(잠긴 키, R9)
                self.assertIn("max_turns: 99", put[2]["yaml_text"])         # 잠기지 않은 키는 PC 값
                self.assertEqual(tasks, [("ProfileContentReplace", target, temp, job["id"]), ("SkillBundledRepair", target, "", job["id"])])   # 가린 기본 스킬 되돌리기(2026-10-27-011)
                self.assertEqual(len(restarts), 1)
                self.assertIn(("DELETE", f"/api/profiles/{temp}"), restarts[0])    # 임시 프로파일은 게이트웨이를 다시 띄우기 전에 지운다(OKE 에서 재시작 중 삭제가 폴더를 남겼다)
                self.assertEqual(sum(1 for c in api.calls if c[:2] == ("DELETE", f"/api/profiles/{temp}")), 1)
                self.assertEqual(out["result"]["secrets_needed"], ["SERP_API_KEY"])
                self.assertEqual(out["result"]["paused_cron"], 3)
                self.assertEqual(pc.latest(f"p-{target}", target)["id"], job["id"])

    def test_컨테이너가_주는_환경변수는_비밀값_필요에서_뺀다(self):
        """protects=OMAI-1444 실제 시험(AAS 에서 내보낸 묶음의 ${HERMES_LLM_*}·${AAS_*} 가 「비밀값 5개 필요」로 나옴); fails_when=CONTAINER_ENV 를 세거나 옛 기록에 남음; no_claim=오퍼레이터가 실제로 넣는 값(resources.go 와 손으로 맞춤)"""
        refs = ["SERP_API_KEY", "HERMES_LLM_MODEL", "HERMES_LLM_BASE_URL", "HERMES_LLM_API_KEY", "AAS_AGENT_NAME", "AAS_OWNER_SUB"]
        job = self.job(pod="p-env", profile="research", summary={"ok": True, "counts": {}, "env_refs": refs, "os_only_skills": [], "pc_path_jobs": []})
        out = pc.Runner(job, FakeAPI(target="research"), task=lambda *a: None, restart=lambda: None, env_names=lambda: set()).run()
        self.assertEqual(out["result"]["secrets_needed"], ["SERP_API_KEY"])
        pc._set(job["id"], result={**out["result"], "secrets_needed": refs})          # 고치기 전에 끝난 기록
        self.assertEqual(pc.view(pc.get(job["id"]))["result"]["secrets_needed"], ["SERP_API_KEY"])
        got = {i["code"]: i.get("n") for i in pc.issues_for("p-env", "research")}
        self.assertEqual(got["pc_import_secrets"], 1)

    def test_runner_for_는_대상_프로파일을_다시_시작하고_작업에_넘긴다(self):
        """protects=OMAI-1444 OV9(재시작·작업·비밀값 읽기 대상이 기록의 프로파일); fails_when=main 으로 굳음; no_claim=실제 게이트웨이"""
        from aas.web import pc_import_routes as routes
        pod = mock.Mock(id="p1", sidecar_url="http://s")
        job = self.job(profile="research")
        with mock.patch.object(routes, "_api") as api, mock.patch.object(routes, "run_task") as run_task, \
                mock.patch.object(routes.profiles, "gateway_shared", return_value=False) as shared:
            api.return_value.call.return_value = {}
            r = routes.runner_for(pod, "kim@x.com", "김")(job)
            r.restart()
            r.task("ProfileContentReplace", "research", "t", job["id"])
            r.env_names()
        self.assertEqual(shared.call_args.kwargs["profile"], "research")
        self.assertEqual(api.return_value.call.call_args_list[0].args, ("POST", "/api/gateway/restart", {}, {"profile": "research"}))
        self.assertEqual(run_task.call_args.args[:3], (pod, "ProfileContentReplace", "research"))
        self.assertEqual(api.return_value.call.call_args_list[-1].kwargs["query"], {"profile": "research"})

    def soul_versions(self, pod, profile):
        from aas.assets import files
        return [(v["note"], v["by"]) for v in reversed(files.versions(pod, f"soul:{profile}"))]

    def forget_souls(self, *pods):
        from aas.assets import files
        for pod in pods:
            for prof in ("main", "research"):
                files.forget_key(pod, f"soul:{prof}")

    def test_SOUL_이_바뀌면_판_둘을_남기고_한_번_알린다(self):
        """protects=OMAI-1444 R10·R12(ROV10 고치기 전·PC 에서 가져옴 두 판, 그 판 번호로 알림), main·research 모두; fails_when=판이 없거나 알림이 없거나 번호가 다름; no_claim=방 저장은 meeting 시험"""
        from aas.assets import files
        for target in ("main", "research"):
            with self.subTest(target=target):
                pod = f"soul-{target}"
                self.addCleanup(self.forget_souls, pod)
                job = self.job(pod=pod, profile=target)
                notes = []
                out = pc.Runner(job, FakeAPI(target=target, souls=["옛 성격\n", "PC 성격\n"]), task=lambda *a: None, restart=lambda: None,
                                notice=lambda a, b: notes.append((a, b))).run()
                self.assertEqual(out["state"], "done")
                self.assertEqual(self.soul_versions(pod, target), [("고치기 전", ""), ("PC 에서 가져옴", "kim@x.com")])
                ids = [v["id"] for v in reversed(files.versions(pod, f"soul:{target}"))]
                self.assertEqual(notes, [tuple(ids)])

    def test_SOUL_이_그대로면_판도_알림도_없다(self):
        self.addCleanup(self.forget_souls, "soul-same")
        notes = []
        out = pc.Runner(self.job(pod="soul-same"), FakeAPI(souls=["같음\n", "같음\n"]), task=lambda *a: None, restart=lambda: None,
                        notice=lambda a, b: notes.append((a, b))).run()
        self.assertEqual((out["state"], notes, self.soul_versions("soul-same", "main")), ("done", [], []))

    def test_되돌렸으면_판도_알림도_없다(self):
        """protects=R10 rolled_back 이면 알리지 않음; fails_when=되돌린 가져오기를 방에 알림; no_claim=-"""
        self.addCleanup(self.forget_souls, "soul-rb")
        notes = []

        def task(*a):
            raise RuntimeError("[ROLLEDBACK] x")
        out = pc.Runner(self.job(pod="soul-rb"), FakeAPI(souls=["옛\n", "새\n"]), task=task, restart=lambda: None,
                        notice=lambda a, b: notes.append((a, b))).run()
        self.assertEqual((out["state"], notes, self.soul_versions("soul-rb", "main")), ("rolled_back", [], []))

    def test_판_저장이_실패해도_done_이고_판_번호_없이_알린다(self):
        """protects=R12(판 저장 실패·비밀값처럼 보이는 줄은 같은 길)·6A(알림 실패도 done); fails_when=가져오기가 실패로 바뀜; no_claim=-"""
        from aas.assets import files
        from aas.common import store as st
        self.addCleanup(self.forget_souls, "soul-fail", "soul-secret", "soul-notice")
        notes = []
        with mock.patch.object(files, "remember_version", side_effect=RuntimeError("db down")):
            out = pc.Runner(self.job(pod="soul-fail"), FakeAPI(souls=["옛\n", "새\n"]), task=lambda *a: None, restart=lambda: None,
                            notice=lambda a, b: notes.append((a, b))).run()
        self.assertEqual((out["state"], notes), ("done", [(None, None)]))
        notes.clear()
        out = pc.Runner(self.job(pod="soul-secret"), FakeAPI(souls=["옛\n", "api_key: sk-abcdefghijklmnopqrstuvwxyz123456\n"]), task=lambda *a: None,
                        restart=lambda: None, notice=lambda a, b: notes.append((a, b))).run()
        self.assertEqual((out["state"], notes), ("done", [(None, None)]))           # remember_version 이 None 이면 실패와 같은 길(ROV10)

        def boom(a, b):
            raise RuntimeError("room down")
        out = pc.Runner(self.job(pod="soul-notice"), FakeAPI(souls=["옛\n", "새\n"]), task=lambda *a: None, restart=lambda: None, notice=boom).run()
        self.assertEqual(out["state"], "done")
        with st.connect() as conn:
            self.assertTrue(conn.execute("SELECT 1 FROM usage WHERE kind='profile_soul_notice_failed' AND pod='soul-notice'").fetchone())

    def test_main_이_아닌_대상은_다시_연결할_채널_수를_남긴다(self):
        """protects=OMAI-1444 DD3 channels_to_reconnect; fails_when=결과에 수가 없음; no_claim=화면"""
        s = {"ok": True, "channel_files_skipped": ["pairing", "slack_tokens.json"]}
        out = pc.Runner(self.job(pod="ch", summary=s, profile="research"), FakeAPI(target="research"), task=lambda *a: None, restart=lambda: None).run()
        self.assertEqual(out["result"]["channels_to_reconnect"], 2)
        main = pc.Runner(self.job(pod="ch2", summary={"ok": True}), FakeAPI(), task=lambda *a: None, restart=lambda: None).run()
        self.assertNotIn("channels_to_reconnect", main["result"])

    def test_임시_프로파일을_못_지우면_적어_두고_나중에_지운다(self):
        job = self.job()
        temp = pc.temp_profile(job["id"])
        with mock.patch.object(pc.threading, "Event") as ev:              # 다시 시도 전 3초 기다림을 건너뛴다
            ev.return_value.wait.return_value = False
            out = pc.Runner(job, FakeAPI(fail={("DELETE", f"/api/profiles/{temp}")}), task=lambda *a: None, restart=lambda: None).run()
        self.assertEqual(out["state"], "done")                             # 결과는 그대로
        self.assertEqual(out["result"]["temp_left"], temp)
        self.assertEqual([j["id"] for j in pc.temps_left()], [job["id"]])
        self.assertFalse(pc.sweep_temps(pc.temps_left()[0], lambda t: (_ for _ in ()).throw(RuntimeError("still busy"))))
        self.assertTrue(pc.sweep_temps(pc.temps_left()[0], lambda t: None))
        self.assertEqual(pc.temps_left(), [])
        self.assertEqual(pc.get(job["id"])["result"]["paused_cron"], 3)     # 다른 결과 값은 남는다

    def test_보관_기간이_지난_보관본만_지우고_되돌리기_실패는_남긴다(self):
        old = pc._iso(pc._now() - timedelta(days=20))
        done, failed_rb, fresh = self.job(), self.job(pod="p2"), self.job(pod="p3")
        pc._set(done["id"], state="done", result={"paused_cron": 1})
        pc._set(failed_rb["id"], state="rollback_failed")
        pc._set(fresh["id"], state="done")
        with store.connect() as conn:
            conn.execute("UPDATE pc_imports SET updated=? WHERE id IN (?,?)", (old, done["id"], failed_rb["id"]))
        due = pc.backups_due(days=14)
        self.assertEqual([j["id"] for j in due], [done["id"]])          # 기간 안의 것·되돌리기 실패는 남긴다
        self.assertEqual(pc.backups_due(days=0), [])                     # 0 이면 지우지 않는다
        paths = []
        self.assertTrue(pc.prune_backup(due[0], paths.append))
        self.assertEqual(paths, [f"profiles/.aas-import-backup/{done['id']}"])
        self.assertEqual(pc.backups_due(days=14), [])                    # 다시 지우지 않는다
        self.assertEqual(pc.get(done["id"])["result"]["paused_cron"], 1)

        gone = self.job(pod="p4")
        pc._set(gone["id"], state="rolled_back")
        with store.connect() as conn:
            conn.execute("UPDATE pc_imports SET updated=? WHERE id=?", (old, gone["id"]))

        def not_found(path):
            raise RuntimeError("HTTP 404 Path not found")
        self.assertTrue(pc.prune_backup(pc.backups_due(days=14)[0], not_found))   # 이미 없으면 지운 것으로 본다

    def test_보관_정리는_하루_한_번(self):
        from aas.web import pc_import_routes as routes
        reg = mock.Mock(pods=[])
        routes._last_prune["at"] = 0.0
        with mock.patch.object(pc, "backups_due", return_value=[]) as due:
            routes.prune_once(reg, now=100_000.0)
            routes.prune_once(reg, now=100_000.0 + 3600)                # 한 시간 뒤에는 건너뛴다
            routes.prune_once(reg, now=100_000.0 + 24 * 3600 + 1)
        self.assertEqual(due.call_count, 2)

    def test_가져오기_실패는_main_그대로(self):
        job = self.job()
        tasks = []
        out = pc.Runner(job, FakeAPI(fail={("POST", "/api/profiles/import")}), task=lambda *a: tasks.append(a), restart=lambda: None).run()
        self.assertEqual((out["state"], out["reason"]), ("failed", "import_failed"))
        self.assertEqual(tasks, [])

    def test_작업이_되돌렸으면_rolled_back_되돌리기도_실패면_rollback_failed(self):
        for word, state in (("ROLLEDBACK", "rolled_back"), ("ROLLBACKFAILED", "rollback_failed"), ("BACKUPFAILED", "failed"), ("TIMEOUT", "rollback_failed")):
            job = self.job(pod=f"p-{word}")

            def task(*a, word=word):
                raise RuntimeError(f"[{word}] x")
            out = pc.Runner(job, FakeAPI(), task=task, restart=lambda: None).run()
            self.assertEqual(out["state"], state, word)

    def test_재시작_실패면_보관본으로_되돌린다(self):
        job = self.job()
        tasks = []

        def restart():
            if not tasks or tasks[-1][0] == "SkillBundledRepair":       # 바꾸기·되돌리기 뒤 첫 재시작
                raise RuntimeError("gateway down")
        out = pc.Runner(job, FakeAPI(), task=lambda *a: tasks.append(a), restart=restart).run()
        self.assertEqual(out["state"], "rolled_back")
        self.assertEqual([t[0] for t in tasks], ["ProfileContentReplace", "SkillBundledRepair", "ProfileContentRestore"])

        job2 = self.job(pod="p9")

        def task2(kind, *a):
            if kind == "ProfileContentRestore":
                raise RuntimeError("[RESTOREFAILED] x")

        def down():
            raise RuntimeError("gateway down")
        self.assertEqual(pc.Runner(job2, FakeAPI(), task=task2, restart=down).run()["state"], "rollback_failed")

    def test_멈춘_것_복구(self):
        job = self.job()
        pc._set(job["id"], stage="restart")
        with store.connect() as conn:
            conn.execute("UPDATE pc_imports SET updated=? WHERE id=?", (pc._iso(pc._now() - timedelta(hours=1)), job["id"]))
        stale = pc.stale()
        self.assertEqual([j["id"] for j in stale], [job["id"]])
        tasks = []
        self.assertEqual(pc.recover(stale[0], lambda *a: tasks.append(a), lambda: None, lambda *a: None), "rolled_back")
        self.assertEqual(tasks[0][0], "ProfileContentRestore")
        early = self.job(pod="p5")
        pc._set(early["id"], stage="import")
        self.assertEqual(pc.recover(pc.get(early["id"]), lambda *a: None, lambda: None, lambda *a: None), "failed")   # 바꾸기 전이면 되돌릴 것이 없다

        def nobackup(*a):
            raise RuntimeError("[NOBACKUP] x")
        mid = self.job(pod="p6")
        pc._set(mid["id"], stage="replace")
        self.assertEqual(pc.recover(pc.get(mid["id"]), nobackup, lambda: None, lambda *a: None), "failed")

    def test_받은편지함과_확인할_것(self):
        job = self.job()
        pc._set(job["id"], state="done", by_admin=1, by_user="admin@x.com", owner="kim@x.com",
                result={"secrets_needed": ["A"], "paused_cron": 2, "os_only_skills": ["x"]})
        label = lambda pod, prof: prof                               # noqa: E731
        owner_items = pc.inbox_items("kim@x.com", False, label)
        self.assertEqual([(i["kind"], i["status"]) for i in owner_items], [("pc_import", "by_admin")])
        self.assertEqual([i["status"] for i in pc.inbox_items("admin@x.com", True, label)], ["done"])   # 시작한 관리자
        self.assertEqual(pc.inbox_items("lee@x.com", False, label), [])
        pc.ack(owner_items[0]["id"], "kim@x.com")
        self.assertEqual(pc.inbox_items("kim@x.com", False, label), [])
        self.assertEqual([i["code"] for i in pc.issues_for("p1", "main")], ["pc_import_secrets", "pc_import_cron", "pc_import_skills"])
        pc._set(job["id"], state="rollback_failed")
        self.assertEqual([i["code"] for i in pc.issues_for("p1", "main")], ["pc_import_rollback_failed"])
        self.assertEqual([i["status"] for i in pc.inbox_items("boss@x.com", True, label)], ["rollback_failed"])   # 관리자 모두

    def test_env_이름_읽기(self):
        self.assertEqual(pc.env_names_of({"A": {"is_set": True}, "B": {"is_set": False}}), {"A"})
        self.assertEqual(pc.env_names_of({"vars": [{"key": "C", "is_set": True}]}), {"C"})
        self.assertEqual(pc.env_names_of("odd"), set())

    def test_스키마가_이전_목록에_있다(self):
        self.assertIn(pc.SCHEMA, dbmigrate.schema_scripts())


ENV_TEXT = (b"EXISTING_KEY=old-pc\nSEARXNG_URL=http://s\nSERP_API_KEY=serp-secret-1\nTELEGRAM_BOT_TOKEN=tg-secret-1\n"
            b"OPENAI_API_KEY=sk-secret-1\nGATEWAY_ALLOW_ALL_USERS=true\nBROKEN='x\n")
SECRET_VALUES = ("old-pc", "serp-secret-1", "tg-secret-1", "sk-secret-1")


def secrets_archive() -> bytes:
    return bundle({"SOUL.md": "x", "memories/MEMORY.md": "m", ".env": ENV_TEXT.decode(), "google_token.json": "{\"t\": \"tok-secret-1\"}"},
                  links=("skills/linked",))


class EnvAPI(FakeAPI):
    """main 의 비밀값 목록을 돌려주는 대역. EXISTING_KEY 는 값이 있고 SEARXNG_URL 은 이름만 있다(R21: 없는 키로 본다)."""

    def __init__(self, fail=None, env_fail=False):
        super().__init__(fail)
        self.env_fail = env_fail

    def call(self, method, path, body=None, query=None, timeout=30):
        if path == "/api/env" and method == "GET":
            self.calls.append((method, path, body, query))
            if self.env_fail:
                raise RuntimeError("HTTP 503")
            return {"vars": {"EXISTING_KEY": {"is_set": True, "category": "tool"}, "SEARXNG_URL": {"is_set": False, "category": "tool"},
                             "OPENAI_API_KEY": {"is_set": False, "category": "provider"},
                             "TELEGRAM_BOT_TOKEN": {"is_set": False, "category": "messaging"}}}
        return super().call(method, path, body, query, timeout)


class SecretsRunnerTest(unittest.TestCase):
    """2026-10-22-003 §4-5: secrets·env 단계, 되돌리기, 옛 오퍼레이터(R19·R22), 이름 읽기 실패(R25)."""

    def setUp(self):
        with store.connect() as conn:
            conn.executescript(pc.SCHEMA)
            conn.execute("DELETE FROM pc_imports")

    def tearDown(self):
        with store.connect() as conn:
            conn.execute("DELETE FROM pc_imports")

    def job(self, by_admin=True):
        summary, _content, self.secret_blob = filtered(secrets_archive())
        self.assertTrue(summary["ok"], summary)
        jid = pc.new_id()
        pc.record_upload(jid, "p1", "main", "boss@x.com", "kim@x.com", by_admin, "hermes.tar.gz", 100, summary)
        self.assertTrue(pc.claim(jid, "p1"))
        return pc.get(jid)

    def download(self, lists=None):
        def get(path):
            if path.endswith(".secrets.tar.gz"):
                return self.secret_blob
            name = path.rsplit("/", 1)[-1]
            if lists is None:
                raise OSError("missing")
            return lists.get(name, b"")
        return get

    def test_성공하면_없는_키만_넣고_관리자도_거르기를_적용한다(self):
        """protects=기준 9(main 에 있는 키·env_key_check 거절 키는 관리자가 해도 넣지 않음, env_planned 를 PUT 보다 먼저 저장); fails_when=모든 키를 PUT 하거나 계획을 나중에 저장; no_claim=Hermes /api/env 의 실제 저장은 대역"""
        job = self.job(by_admin=True)
        api, tasks, seen_plan = EnvAPI(), [], []
        orig_put = api.call

        def call(method, path, body=None, query=None, timeout=30):
            if method == "PUT" and path == "/api/env":
                seen_plan.append(pc.get(job["id"])["result"].get("env_planned"))
            return orig_put(method, path, body, query, timeout)
        api.call = call
        lists = {".secrets-replaced": b"google_token.json\n", ".secrets-added": b""}
        out = pc.Runner(job, api, task=lambda *a: tasks.append(a[0]), restart=lambda: None, env_names=lambda: {"EXISTING_KEY"},
                        download=self.download(lists)).run()
        self.assertEqual(out["state"], "done", out)
        self.assertEqual(tasks, ["ProfileContentReplace", "ProfileSecretsReplace", "SkillBundledRepair"])
        res = out["result"]
        self.assertEqual(sorted(res["env_added"]), ["SEARXNG_URL", "SERP_API_KEY"])
        self.assertEqual(seen_plan[0], sorted(res["env_added"]))                    # 계획을 먼저 저장했다
        skipped = {d["name"]: d["reason"] for d in res["env_skipped"]}
        self.assertEqual(skipped, {"EXISTING_KEY": "exists", "OPENAI_API_KEY": "blocked", "TELEGRAM_BOT_TOKEN": "blocked",
                                   "GATEWAY_ALLOW_ALL_USERS": "blocked", "BROKEN": "unreadable"})
        self.assertEqual((res["secrets_replaced"], res["secrets_added"]), (["google_token.json"], []))
        puts = [c for c in api.calls if c[:2] == ("PUT", "/api/env")]
        self.assertEqual({c[2]["key"] for c in puts}, {"SEARXNG_URL", "SERP_API_KEY"})
        self.assertIn(("DELETE", "/api/files", {"path": pc.secrets_path(job["id"]), "recursive": False}, None), api.calls)
        stored = json.dumps(pc.get(job["id"]), ensure_ascii=False)                  # 기준 13: 값은 DB 에 없다
        for v in SECRET_VALUES + ("tok-secret-1",):
            self.assertNotIn(v, stored)
        self.assertEqual(pc.get(job["id"])["stage"], "cleanup")

    def test_키_하나가_실패해도_끝나고_남긴다(self):
        """protects=R15 일부 실패는 env_failed 로 남기고 done; fails_when=전체를 되돌리거나 실패 키를 잃음; no_claim=화면 문구"""
        job = self.job()
        api = EnvAPI()
        orig = api.call

        def call(method, path, body=None, query=None, timeout=30):
            if method == "PUT" and path == "/api/env" and body["key"] == "SERP_API_KEY":
                raise RuntimeError("HTTP 500 serp-secret-1")
            return orig(method, path, body, query, timeout)
        api.call = call
        out = pc.Runner(job, api, task=lambda *a: None, restart=lambda: None, download=self.download({})).run()
        self.assertEqual(out["state"], "done")
        self.assertEqual(out["result"]["env_failed"], [{"name": "SERP_API_KEY", "reason": "RuntimeError"}])
        self.assertNotIn("serp-secret-1", json.dumps(out))
        self.assertIn("pc_import_secrets", [i["code"] for i in pc.issues_for("p1", "main")])

    def test_재시작_실패면_넣은_키를_지우고_비밀_내용_순서로_되돌린다(self):
        """protects=기준 10; fails_when=키가 남거나 ProfileSecretsRestore 를 빠뜨림; no_claim=오퍼레이터 복원 자체는 Go 시험"""
        job = self.job()
        api, tasks = EnvAPI(), []

        def restart():
            if not any(t == "ProfileContentRestore" for t in tasks):
                raise RuntimeError("gateway down")
        out = pc.Runner(job, api, task=lambda *a: tasks.append(a[0]), restart=restart, download=self.download({})).run()
        self.assertEqual(out["state"], "rolled_back")
        self.assertEqual(tasks, ["ProfileContentReplace", "ProfileSecretsReplace", "SkillBundledRepair", "ProfileSecretsRestore", "ProfileContentRestore"])
        deleted = {c[2]["key"] for c in api.calls if c[:2] == ("DELETE", "/api/env")}
        self.assertEqual(deleted, {"SEARXNG_URL", "SERP_API_KEY"})
        self.assertTrue(out["result"]["secrets_rolled_back"])

    def test_비밀_작업이_실행_중_실패하면_모두_되돌린다(self):
        """protects=§4-5 실행 중 실패면 비밀·내용 되돌림; fails_when=내용만 남기고 done; no_claim=실제 BACKUPEXISTS 상황은 Go 시험"""
        job = self.job()
        tasks = []

        def task(kind, *a):
            tasks.append(kind)
            if kind == "ProfileSecretsReplace":
                raise RuntimeError("[BACKUPEXISTS] 이미 보관본이 있습니다")
        api = EnvAPI()
        out = pc.Runner(job, api, task=task, restart=lambda: None, download=self.download({})).run()
        self.assertEqual((out["state"], out["reason"]), ("rolled_back", "secrets_failed"))
        self.assertEqual(tasks, ["ProfileContentReplace", "ProfileSecretsReplace", "ProfileSecretsRestore", "ProfileContentRestore"])
        self.assertFalse([c for c in api.calls if c[:2] == ("PUT", "/api/env")])  # env 단계 전에 멈춘다

    def test_옛_오퍼레이터가_거절하면_비밀만_건너뛰고_끝난다(self):
        """protects=기준 11·R22(CRD 422, 검증 거절); fails_when=내용을 되돌리거나 env 를 건너뜀; no_claim=실제 쿠버네티스 응답 모양"""
        for err in (k8s.K8sError("Unsupported value: ProfileSecretsReplace", 422), RuntimeError('[INVALID] 알 수 없는 작업 종류입니다: "ProfileSecretsReplace"')):
            with self.subTest(err=str(err)):
                job = self.job()
                tasks = []

                def task(kind, *a, err=err):
                    tasks.append(kind)
                    if kind == "ProfileSecretsReplace":
                        raise err
                out = pc.Runner(job, EnvAPI(), task=task, restart=lambda: None, download=self.download({})).run()
                self.assertEqual(out["state"], "done")
                self.assertTrue(out["result"]["secrets_unsupported"])
                self.assertEqual(sorted(out["result"]["env_added"]), ["SEARXNG_URL", "SERP_API_KEY"])
                self.assertEqual(tasks, ["ProfileContentReplace", "ProfileSecretsReplace", "SkillBundledRepair"])
                self.assertIn("pc_import_secrets_skipped", [i["code"] for i in pc.issues_for("p1", "main")])
                with store.connect() as conn:
                    conn.execute("DELETE FROM pc_imports")

    def test_main_비밀값_이름을_못_읽으면_넣지_않는다(self):
        """protects=R25 이름을 모르면 PUT 0회, 모두 unchecked; fails_when=main 값을 덮어씀; no_claim=_env_names 경로 함수는 경로 시험"""
        job = self.job()
        api = EnvAPI(env_fail=True)
        out = pc.Runner(job, api, task=lambda *a: None, restart=lambda: None, download=self.download({})).run()
        self.assertEqual(out["state"], "done")
        self.assertFalse([c for c in api.calls if c[:2] == ("PUT", "/api/env")])
        reasons = {d["reason"] for d in out["result"]["env_skipped"] if d["name"] != "BROKEN"}
        self.assertEqual(reasons, {"unchecked"})

    def test_목록을_못_읽으면_표시하고_받은편지함은_본_계획으로_센다(self):
        """protects=OV-6 읽기 실패 표시, OV-11 n·m; fails_when=실패를 빈 목록으로 보임; no_claim=화면 문구"""
        job = self.job(by_admin=True)
        pc.set_summary(job["id"], secrets_plan_seen={"known": True, "files_replace": ["google_token.json"], "files_new": [], "env_add": ["SEARXNG_URL", "SERP_API_KEY"]})
        job = pc.get(job["id"])
        out = pc.Runner(job, EnvAPI(), task=lambda *a: None, restart=lambda: None, download=self.download(None)).run()
        self.assertTrue(out["result"]["secrets_list_unreadable"])
        self.assertFalse(out["result"]["changed_after_confirm"])
        items = pc.inbox_items("kim@x.com", False, lambda pod, prof: prof)
        self.assertEqual(items[0]["secrets"], {"files": 1, "env": 2})

    def test_확인_뒤_바뀌면_표시한다(self):
        """protects=OV-2 changed_after_confirm; fails_when=본 계획과 달라도 표시 없음; no_claim=화면"""
        job = self.job()
        pc.set_summary(job["id"], secrets_plan_seen={"known": True, "files_replace": [], "files_new": ["google_token.json"], "env_add": ["SEARXNG_URL"]})
        out = pc.Runner(pc.get(job["id"]), EnvAPI(), task=lambda *a: None, restart=lambda: None, download=self.download({})).run()
        self.assertTrue(out["result"]["changed_after_confirm"])

    def test_멈춘_것_복구는_계획한_키를_지우고_비밀부터_되돌린다(self):
        """protects=기준 10 recover; fails_when=env_planned 키가 남음; no_claim=리더 점검 주기"""
        job = self.job()
        pc._set(job["id"], stage="env", result={"env_planned": ["SERP_API_KEY"]})
        tasks, deleted, cleaned = [], [], []
        state = pc.recover(pc.get(job["id"]), lambda kind, *a: tasks.append(kind), lambda: None, lambda *paths: cleaned.extend(paths), deleted.append)
        self.assertEqual(state, "rolled_back")
        self.assertEqual(tasks, ["ProfileSecretsRestore", "ProfileContentRestore"])
        self.assertEqual(deleted, ["SERP_API_KEY"])
        self.assertIn(pc.secrets_path(job["id"]), cleaned)

    def test_화면에는_전체_이름_목록을_보내지_않고_단계를_더한다(self):
        """protects=OV-1·DD14; fails_when=secrets_index 가 응답에 실림; no_claim=화면"""
        v = pc.view(self.job())
        self.assertNotIn("secrets_index", v["summary"])
        self.assertEqual(v["stages"], ["import", "config", "replace", "secrets", "env", "skills", "restart"])
        self.assertEqual(pc.view(pc.get(pc.record_upload(pc.new_id(), "p9", "main", "a", "a", False, "x", 1, {"ok": True})["id"]))["stages"],
                         ["import", "config", "replace", "skills", "restart"])


class LifecycleTest(unittest.TestCase):
    """R18 만료·교체, R28 이름 지우기, R27 할 일이 끝나면 줄기."""

    def setUp(self):
        with store.connect() as conn:
            conn.executescript(pc.SCHEMA)
            conn.execute("DELETE FROM pc_imports")

    tearDown = setUp

    def test_24시간_지난_확인_단계는_만료되고_이름이_지워진다(self):
        """protects=기준 8·R28; fails_when=오래된 묶음이 남거나 닫힌 기록에 비밀 이름이 남음; no_claim=리더 점검이 묶음을 지우는 호출은 경로 시험"""
        summary, _c, _s = filtered(secrets_archive())
        jid = pc.new_id()
        pc.record_upload(jid, "p1", "main", "a", "a", False, "x", 1, summary)
        self.assertEqual(pc.expired(), [])
        with store.connect() as conn:
            conn.execute("UPDATE pc_imports SET updated=? WHERE id=?", (pc._iso(pc._now() - timedelta(hours=25)), jid))
        self.assertEqual([r["id"] for r in pc.expired()], [jid])
        self.assertTrue(pc.cancel(jid, "expired"))
        row = pc.get(jid)
        self.assertEqual((row["state"], row["reason"]), ("cancelled", "expired"))
        text = json.dumps(row, ensure_ascii=False)
        for name in ("google_token.json", "SERP_API_KEY", "EXISTING_KEY"):
            self.assertNotIn(name, text)
        self.assertEqual(row["summary"]["secrets"]["files_count"], 1)                # 개수는 남는다

    def test_거절_기록에도_비밀_이름이_없다(self):
        """protects=R28 rejected 는 바로 지움; fails_when=거절 기록에 키 이름; no_claim=-"""
        jid = pc.new_id()
        pc.record_upload(jid, "p1", "main", "a", "a", False, "x", 1, {"ok": False, "reason": "too_big", "secrets_index": {"env_keys": ["SERP_API_KEY"]},
                                                                     "secrets": {"env_keys": ["SERP_API_KEY"], "env_keys_count": 1}})
        self.assertNotIn("SERP_API_KEY", json.dumps(pc.get(jid)))

    def test_끝난_기록은_보관_기간_뒤_이름을_지운다(self):
        """protects=R28 done 14일; fails_when=이름이 계속 남음; no_claim=-"""
        jid = pc.new_id()
        pc.record_upload(jid, "p1", "main", "a", "a", False, "x", 1, {"ok": True, "secrets_index": {"files": ["google_token.json"]}})
        pc._set(jid, state="done", result={"env_added": ["SERP_API_KEY"], "secrets_replaced": ["google_token.json"]})
        self.assertEqual(pc.names_due(), [])
        with store.connect() as conn:
            conn.execute("UPDATE pc_imports SET updated=? WHERE id=?", (pc._iso(pc._now() - timedelta(days=15)), jid))
        due = pc.names_due()
        self.assertEqual([r["id"] for r in due], [jid])
        pc.scrub_names(due[0])
        row = pc.get(jid)
        self.assertNotIn("google_token.json", json.dumps(row))
        self.assertEqual((row["result"]["env_added_n"], row["result"]["secrets_replaced_n"]), (1, 1))
        self.assertEqual(pc.names_due(), [])

    def test_할_일이_끝나면_확인할_것이_준다(self):
        """protects=R27; fails_when=main 에 키·스킬이 생겨도 그대로 셈; no_claim=개요 화면"""
        jid = pc.new_id()
        pc.record_upload(jid, "p1", "main", "a", "a", False, "x", 1, {"ok": True})
        pc._set(jid, state="done", result={"secrets_needed": ["AK"], "env_failed": [{"name": "BK", "reason": "x"}],
                                            "env_skipped": [{"name": "CK", "reason": "unchecked"}, {"name": "DK", "reason": "exists"}],
                                            "link_skills": ["s1", "s2"]})
        got = {i["code"]: i.get("n") for i in pc.issues_for("p1", "main")}
        self.assertEqual((got["pc_import_secrets"], got["pc_import_link_skills"]), (3, 2))
        got = {i["code"]: i.get("n") for i in pc.issues_for("p1", "main", env_have=lambda: {"AK", "BK"}, skills_have=lambda: {"s1"})}
        self.assertEqual((got["pc_import_secrets"], got["pc_import_link_skills"]), (1, 1))
        got = [i["code"] for i in pc.issues_for("p1", "main", env_have=lambda: {"AK", "BK", "CK"}, skills_have=lambda: {"s1", "s2"})]
        self.assertEqual(got, [])
        got = {i["code"]: i.get("n") for i in pc.issues_for("p1", "main", env_have=lambda: (_ for _ in ()).throw(OSError()))}
        self.assertEqual(got["pc_import_secrets"], 3)                               # 읽지 못하면 줄이지 않는다
        self.assertEqual(pc.skill_names_of([("main", "skills/a/s1/SKILL.md"), ("other", "skills/s2/SKILL.md")], "main"), {"s1"})

    def test_이름을_바꾸면_기록이_따라가고_지우면_끊긴다(self):
        """protects=OMAI-1444 R2(move_profile·detach_profile 뒤 latest·issues_for·받은편지함); fails_when=옛 이름에 결과가 남거나 같은 이름 새 프로파일에 옛 기록; no_claim=server 호출 자리는 ProfileGuardTest"""
        jid = pc.new_id()
        pc.record_upload(jid, "p1", "research", "kim@x.com", "kim@x.com", False, "x", 1, {"ok": True})
        pc._set(jid, state="done", result={"secrets_needed": ["AK"]})
        other = pc.new_id()
        pc.record_upload(other, "p2", "research", "kim@x.com", "kim@x.com", False, "x", 1, {"ok": True})
        pc.move_profile("p1", "research", "study")
        self.assertIsNone(pc.latest("p1", "research"))
        self.assertEqual(pc.latest("p1", "study")["id"], jid)
        self.assertEqual([i["code"] for i in pc.issues_for("p1", "study")], ["pc_import_secrets"])
        self.assertEqual(pc.get(other)["profile"], "research")                     # 다른 파드는 그대로
        pc.detach_profile("p1", "study")
        self.assertIsNone(pc.latest("p1", "study"))                                  # 같은 이름으로 새로 만들어도 옛 기록이 붙지 않는다
        self.assertEqual(pc.issues_for("p1", "study"), [])
        self.assertEqual(pc.get(jid)["state"], "done")                               # 기록은 남는다
        self.assertEqual([i["profile"] for i in pc.inbox_items("kim@x.com", False, lambda pod, prof: prof)], [""])   # 화면이 「지운 프로파일」 문구를 고른다

    def test_확인_단계는_같은_프로파일의_것만_찾는다(self):
        """protects=OMAI-1444 R6 uploaded_of(pod, profile); fails_when=다른 프로파일 확인 단계까지 닫음; no_claim=-"""
        a, b = pc.new_id(), pc.new_id()
        pc.record_upload(a, "p1", "main", "a", "a", False, "x", 1, {"ok": True})
        pc.record_upload(b, "p1", "research", "a", "a", False, "x", 1, {"ok": True})
        self.assertEqual([r["id"] for r in pc.uploaded_of("p1", "research")], [b])

    def test_되돌리기_실패_문구는_대상_이름을_쓴다(self):
        """protects=OMAI-1444 §4-2; fails_when=research 의 확인할 것에 main 이라 적음; no_claim=화면 문구"""
        jid = pc.new_id()
        pc.record_upload(jid, "p1", "research", "a", "a", False, "x", 1, {"ok": True})
        pc._set(jid, state="rollback_failed")
        with mock.patch.object(pc, "tr", side_effect=lambda ko, en: ko):
            text = pc.issues_for("p1", "research")[0]["text"]
        self.assertIn("research 프로파일", text)
        self.assertNotIn("main", text)

    def test_다시_압축해_커지면_too_big(self):
        """protects=L1 거른 묶음 하나가 100MB 를 넘으면 거절; fails_when=Hermes 가 받지 못할 묶음을 올림; no_claim=실제 100MB 묶음은 만들지 않음"""
        with mock.patch.object(pc, "_bundle_max", return_value=10):
            got, _c, _s = filtered(raw_profile_archive())
        self.assertEqual(got["reason"], "too_big")


if __name__ == "__main__":
    unittest.main()
