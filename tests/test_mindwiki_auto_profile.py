# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""MindWiki 자동화가 고른 AAS 프로파일 T 의 자동화 전용 복제본 mwauto-<T>(스펙 2026-11-21-002 §3-2·§5·§6).
본문 agent.profile 검사, 이름·판정 함수, 설정 변환·.env 허용 키·쓸 때 점검, 상태 행, 파드 찾기(캐시·나란히 2초·무응답),
복제(빈 프로파일 + 설정·SOUL·AGENTS·허용 키·보호 스킬)와 실패 정리(지우기·1시간), 상한, 마감, 카드를 본다. Hermes 는 파드마다 가짜다."""
import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

import yaml  # noqa: E402

from aas.common import store  # noqa: E402
from aas.hermes.hermes_api import HermesError  # noqa: E402
from aas.ops import mindwiki_auto_clone as clones  # noqa: E402
from aas.ops import mindwiki_connect, owner_guard  # noqa: E402
from aas.ops import mindwiki_webhook as mw  # noqa: E402
from aas.web import mindwiki_webhook as route  # noqa: E402

T_CONFIG = """model:
  default: gemma
  provider: custom
custom_providers:
- name: litellm
  base_url: ${LITELLM_URL}
  api_key: ${LITELLM_KEY}
platforms:
  telegram:
    enabled: true
    allowed_users: ['42']
mcp_servers:
  cogentai-mindwiki:
    url: https://wiki/mcp
    headers: {Authorization: 'Bearer ${MCP_COGENTAI_MINDWIKI_API_KEY}'}
  github:
    url: https://gh/mcp
skills:
  external_dirs: [/opt/aas-skills]
"""
T_ENV = "LITELLM_URL=http://llm\nLITELLM_KEY='sk-live-123'\nTELEGRAM_BOT_TOKEN=bot-secret\nMCP_COGENTAI_MINDWIKI_API_KEY=wiki_pat_x\nGITHUB_TOKEN=gh\nFOO_TOKEN=foo\n"


def _payload(sub, profile="team-alpha", web=False, automation="auto-1", pod=None):
    agent = {"instruction": "team-alpha-draft 스킬로 초안", "web": web, "author": {"sub": sub, "email": f"{sub}@x", "name": "관리자"},
             "target": {"pageId": "row-1", "databaseId": "db-1"}}
    if profile is not None:
        agent["profile"] = profile
    if pod is not None:
        agent["pod"] = pod
    return json.dumps({"source": {"type": "automation", "automationId": automation, "name": "고객 문의"}, "workspaceId": "ws-9",
                       "data": {"type": "page", "id": "row-1"}, "agent": agent}).encode()


class OpsTest(unittest.TestCase):
    def test_profile_경계값(self):
        """MindWiki checkOutbound·automationProblem 과 같은 목록(스펙 §6)."""
        ok = ["", "a", "a" * 30, "team_alpha", "team-alpha", "web", "0x"]
        bad = ["a" * 31, "Reb", "-a", "_a", "mindwiki-auto", "mindwiki-auto-x", "mwauto", "mwauto-x", "mwautox", "web-x", "pcimp-x", "default", "a b", "가"]
        for v in ok:
            self.assertEqual(mw.parse(_payload("s", v))["profile"], v, v)
        self.assertEqual(mw.parse(_payload("s", None))["profile"], "")
        for v in [*bad, 3, ["x"], {"a": 1}]:
            with self.assertRaises(mw.Reject, msg=str(v)) as cm:
                mw.parse(_payload("s", v))
            self.assertEqual((cm.exception.status, cm.exception.reason), (422, "invalid"))
        self.assertEqual(mw.parse(_payload("s"))["automation_id"], "auto-1")

    def test_이름과_판정(self):
        self.assertEqual((mw.profile_for(False), mw.profile_for(True)), ("mindwiki-auto", "mindwiki-auto-web"))
        self.assertEqual((mw.profile_for(False, "t"), mw.profile_for(True, "t")), ("mwauto-t", "mwauto-web-t"))
        self.assertEqual(len(mw.profile_for(True, "a" * 30)), 41)
        for n in ("mindwiki-auto", "mindwiki-auto-web", "mwauto-x", "mwauto-web-x", "mwauto-web", "mwauto-" + "a" * 30):
            self.assertTrue(mw.is_auto_profile(n), n)
        for n in ("mindwiki-autox", "mwautox", "x-mwauto", "mwauto-", "mwauto-X", "main", "mwauto-" + "a" * 31):
            self.assertFalse(mw.is_auto_profile(n), n)
        self.assertFalse(mw.is_clone("mindwiki-auto"))
        for n in ("mwauto-x", "mindwiki-auto", "mindwiki-autox", "mwauto-anything"):
            self.assertTrue(mw.reserved_auto_name(n), n)
        self.assertFalse(mw.reserved_auto_name("main"))

    def test_복제본의_쓰기_토큰도_automation(self):
        self.assertTrue(mindwiki_connect.token_body("mwauto-team-alpha", True)["automation"])
        self.assertTrue(mindwiki_connect.token_body("mwauto-web-team-alpha", True)["automation"])
        self.assertNotIn("automation", mindwiki_connect.token_body("team-alpha", True))
        self.assertNotIn("automation", mindwiki_connect.token_body("mwautox", True))

    def test_개수_상한은_자동화_프로파일을_세지_않는다(self):
        names = ["default", "main", "mindwiki-auto", "mindwiki-auto-web", "mwauto-a", "mwauto-web-a", "pcimp-1", "sales"]
        self.assertEqual(owner_guard.profile_count(names, True), 2)       # main·sales

    def test_도구_묶음은_복제본만_skills_를_남긴다(self):
        rows = [{"name": "web", "enabled": True}, {"name": "skills", "enabled": True}, {"name": "file", "enabled": True}, {"name": "terminal", "enabled": False}]
        self.assertEqual(mw.toolset_changes(rows, False), [("web", False), ("skills", False), ("file", False)])   # 기본은 지금 그대로(G4)
        self.assertEqual(mw.toolset_changes(rows, False, skills=True), [("web", False), ("file", False)])
        self.assertEqual(mw.toolset_changes([{"name": "skills", "enabled": False}], True, skills=True), [("skills", True)])

    def test_복제본_카드에만_skill_manage_금지_줄(self):
        w = mw.parse(_payload("s"))
        self.assertIn("skill_manage 를 쓰지 않는다", mw.card(w, "i", "7", clone=True)["body"])
        self.assertNotIn("skill_manage", mw.card(w, "i", "7")["body"])

    def test_복제본_설정(self):
        out = yaml.safe_load(clones.clone_config(T_CONFIG, {"TELEGRAM_BOT_TOKEN", "DISCORD_BOT_TOKEN"}))
        self.assertEqual(out["platforms"], {"telegram": {"enabled": False}, "discord": {"enabled": False}})   # env 로만 켜지는 discord 도 끔
        self.assertNotIn("mcp_servers", out)
        self.assertEqual(out["skills"], {"external_dirs": ["/opt/aas-skills"], "write_approval": True})
        self.assertEqual(out["model"], {"default": "gemma", "provider": "custom"})                   # 모델 설정은 그대로
        self.assertEqual(out["custom_providers"][0]["api_key"], "${LITELLM_KEY}")
        legacy = yaml.safe_load(clones.clone_config("telegram:\n  bot: x\nmodel: m\n"))
        self.assertEqual((legacy.get("telegram"), legacy["platforms"]), (None, {"telegram": {"enabled": False}}))

    def test_복제본은_쓰지_않는_칸반_도구와_skill_manage_를_미룬다(self):
        out = yaml.safe_load(clones.clone_config(T_CONFIG))
        self.assertEqual(out["tools"]["tool_search"]["defer"], list(clones.DEFER_TOOLS))
        for keep in ("kanban_show", "kanban_complete", "kanban_block", "kanban_heartbeat"):
            self.assertNotIn(keep, clones.DEFER_TOOLS)                   # 카드를 읽고 끝내는 도구는 그대로
        mine = yaml.safe_load(clones.clone_config("tools:\n  tool_search:\n    defer: [session_search, kanban_create]\n    threshold_pct: 3\n"))
        search = mine["tools"]["tool_search"]
        self.assertEqual(search["defer"][:2], ["session_search", "kanban_create"])   # 있던 목록은 그대로 두고 더한다(Hermes 는 통째로 바꿔 쓴다)
        self.assertEqual(sorted(search["defer"]), sorted(set(["session_search"] + list(clones.DEFER_TOOLS))))
        self.assertEqual(search["threshold_pct"], 3)
        self.assertIsNone(clones.tuned_config(clones.clone_config(T_CONFIG)))       # 다 있으면 다시 쓰지 않는다

    def test_복제본은_MindWiki_도구를_처음부터_싣고_반복_실패를_멈춘다(self):
        out = yaml.safe_load(clones.clone_config(T_CONFIG))
        self.assertEqual(out["tools"]["tool_search"]["enabled"], "off")       # MCP 도구를 미루지 않는다(tool_call 감싸기 없음)
        self.assertEqual(out["tool_loop_guardrails"], clones.GUARDRAILS)
        connected = dict(out, mcp_servers={"cogentai-mindwiki": {"url": "https://wiki/mcp", "tools": {"include": ["search_pages", "create_page"]}}})
        tuned = yaml.safe_load(clones.tuned_config(yaml.safe_dump(connected)))
        self.assertEqual(tuned["mcp_servers"]["cogentai-mindwiki"]["tools"]["include"], list(clones.CLONE_MINDWIKI_TOOLS))
        self.assertIn("create_row", clones.CLONE_MINDWIKI_TOOLS)          # 「추가로 쓸 데이터베이스」 실행(스펙 2026-11-24-002) — 없으면 Hermes 가 update_row 로 바꿔 불렀다
        self.assertEqual(tuned["mcp_servers"]["cogentai-mindwiki"]["url"], "https://wiki/mcp")
        self.assertIsNone(clones.tuned_config(yaml.safe_dump(tuned)))
        with mock.patch.dict(os.environ, {"AAS_MINDWIKI_CLONE_EAGER_TOOLS": "0"}):
            off = yaml.safe_load(clones.clone_config(T_CONFIG))
        self.assertNotIn("enabled", off["tools"]["tool_search"])
        self.assertNotIn("tool_loop_guardrails", off)

    def test_env_허용_키(self):
        cfg = clones.clone_config(T_CONFIG)
        self.assertEqual(clones.env_allowed(cfg), {"LITELLM_URL", "LITELLM_KEY"})
        self.assertEqual(clones.env_allowed("model:\n  api_key_env: OPENAI_API_KEY\n  x: ${MCP_A}\n"), {"OPENAI_API_KEY"})
        env = clones.parse_env(T_ENV + "# c\nexport A_B=1\nbad line\nlower=x\n")
        self.assertEqual((env["LITELLM_KEY"], env["A_B"]), ("sk-live-123", "1"))
        self.assertNotIn("lower", env)

    def test_쓸_때_점검의_이유(self):
        kw = {"mindwiki_server": "cogentai-mindwiki", "mindwiki_key": "MCP_COGENTAI_MINDWIKI_API_KEY"}
        good = clones.clone_config(T_CONFIG, {"TELEGRAM_BOT_TOKEN"})
        self.assertEqual(clones.unsafe_reasons(good, {"LITELLM_KEY"}, mindwiki_ok=False, **kw), [])     # 채널 블록은 있어도 enabled:false 면 안전
        self.assertIn("channel_on:telegram", clones.unsafe_reasons(T_CONFIG, set(), mindwiki_ok=True, **kw))
        self.assertIn("channel_env", clones.unsafe_reasons(good, {"TELEGRAM_BOT_TOKEN"}, mindwiki_ok=False, **kw))
        wiki = good.replace("skills:", "mcp_servers:\n  cogentai-mindwiki: {url: x}\nskills:")
        self.assertEqual(clones.unsafe_reasons(wiki, {"MCP_COGENTAI_MINDWIKI_API_KEY"}, mindwiki_ok=True, **kw), [])
        self.assertEqual(clones.unsafe_reasons(wiki, {"MCP_COGENTAI_MINDWIKI_API_KEY"}, mindwiki_ok=False, **kw),
                         ["mcp_server:cogentai-mindwiki", "mcp_env:MCP_COGENTAI_MINDWIKI_API_KEY"])
        self.assertEqual(clones.unsafe_reasons(good, {"MCP_GITHUB_API_KEY"}, mindwiki_ok=True, **kw), ["mcp_env:MCP_GITHUB_API_KEY"])  # 키 이름만
        self.assertEqual(clones.unsafe_reasons(good.replace("write_approval: true", "write_approval: false"), set(), mindwiki_ok=False, **kw),
                         ["write_approval"])

    def test_상태_행(self):
        pod, t = "pod-s-" + os.urandom(2).hex(), [1000.0]
        with mock.patch.object(clones, "now", lambda: t[0]):
            self.assertTrue(clones.claim(pod, "mwauto-a", "a", "o1"))
            self.assertFalse(clones.claim(pod, "mwauto-a", "a", "o2"))                 # 만드는 중 — 다른 서버는 못 맡는다
            self.assertTrue(clones.fresh_making(clones.get(pod, "mwauto-a")))
            self.assertEqual(clones.making(pod), ["mwauto-a"])
            t[0] += clones.STALE + 1
            self.assertTrue(clones.stale_making(clones.get(pod, "mwauto-a")))
            self.assertTrue(clones.take_stale(pod, "mwauto-a", "o3"))
            self.assertFalse(clones.take_stale(pod, "mwauto-a", "o4"))                 # 하나만 지운다
            clones.mark_unsafe(pod, "mwauto-a", "x")
            self.assertTrue(clones.unsafe(clones.get(pod, "mwauto-a")))
            self.assertFalse(clones.claim(pod, "mwauto-a", "a", "o5"))
            t[0] += clones.UNSAFE_FOR + 1
            self.assertFalse(clones.unsafe(clones.get(pod, "mwauto-a")))
            self.assertTrue(clones.claim(pod, "mwauto-a", "a", "o5"))                  # 1시간 뒤 다시 복제
            self.assertTrue(clones.ready(pod, "mwauto-a", "o5", "sha", ["s1"]))
            self.assertEqual(clones.skills_of(clones.get(pod, "mwauto-a")), ["s1"])
            self.assertTrue(clones.claim(pod, "mwauto-a", "a", "o6"))                  # ready 인데 복제본이 없어진 경우(사람이 지움, D4)
        clones.drop(pod, "mwauto-a")
        self.assertIsNone(clones.get(pod, "mwauto-a"))

    def test_PC_가져오기와_에이전트_패키지도_자동화_이름을_거절한다(self):
        from aas.market import marketplace
        from aas.web import pc_import_routes as routes
        with mock.patch.object(routes.primary, "primary_of", return_value="main"):
            for n in ("mwauto-x", "mindwiki-auto-x"):
                with self.assertRaises(routes._Denied) as cm:
                    routes._target_profile(SimpleNamespace(id="p"), n)
                self.assertEqual(cm.exception.code, "bad_profile")
        with mock.patch.object(marketplace, "install_state", return_value={"enabled": True, "reason": ""}):
            with self.assertRaises(marketplace.MarketError) as cm:
                marketplace.request_install("pg", "hermes", {"version": "1.0.0", "kind": "agent"}, "1.0.0", "mwauto-x", "install", "a@x.io", [])
            self.assertIn("mwauto-", str(cm.exception))


# ---- 가짜 Hermes(파드마다) ---------------------------------------------------------------------------------------------

class Hermes:
    def __init__(self, profiles=("default", "main")):
        self.profiles = set(profiles)
        self.configs: dict = {}
        self.env: dict = {}
        self.souls: dict = {}
        self.agents: dict = {}
        self.calls: list = []
        self.toolsets = [{"name": "web", "enabled": True}, {"name": "skills", "enabled": True}, {"name": "terminal", "enabled": True}]
        self.delay = 0.0
        self.fail: HermesError | None = None
        self.fail_on: tuple | None = None                # (method, path 앞부분) 에서만 실패
        self.ignore_config = False                       # 설정 쓰기를 무시한다(확인 실패 시험)
        self.tasks: dict = {}
        self.board: dict = {}                            # 칸반 보드(상태 → 카드), 동시 상한 시험
        self.links: dict = {}                            # 뒤 카드 → 선행 카드들

    def call(self, method, path, body=None, query=None, timeout=30):
        self.calls.append((method, path, body, query))
        if self.delay:
            time.sleep(self.delay)
        if self.fail is not None:
            raise self.fail
        if self.fail_on and method == self.fail_on[0] and path.startswith(self.fail_on[1]):
            raise HermesError("boom", 500)
        q = query or {}
        if (method, path) == ("GET", "/api/profiles"):
            return {"profiles": [{"name": n, "is_default": n == "default"} for n in sorted(self.profiles)]}
        if path == "/api/config/raw":
            if method == "PUT":
                if not self.ignore_config:
                    self.configs[body["profile"]] = body["yaml_text"]
                return {}
            return {"yaml": self.configs.get(q.get("profile"), "")}
        if path == "/api/env":
            if method == "PUT":
                self.env.setdefault(body["profile"], {})[body["key"]] = body["value"]
                return {}
            return {k: {"is_set": True} for k in self.env.get(q.get("profile"), {})}
        if path.endswith("/soul"):
            name = path.split("/")[3]
            if method == "PUT":
                self.souls[name] = body["content"]
                return {}
            return {"content": self.souls.get(name, "")}
        if (method, path) == ("GET", "/api/tools/toolsets"):
            return self.toolsets
        if method == "POST" and path == "/api/plugins/kanban/tasks":
            tid = self.tasks.setdefault(body["idempotency_key"], f"t_{len(self.tasks) + 1}")
            return {"task": {"id": tid}}
        if (method, path) == ("GET", "/api/plugins/kanban/board"):
            return {"columns": [{"name": k, "tasks": v} for k, v in self.board.items()]}   # Hermes 의 꼴: 열 이름과 카드의 목록
        if method == "GET" and path.startswith("/api/plugins/kanban/tasks/"):
            return {"links": {"parents": self.links.get(path.rsplit("/", 1)[1], [])}}
        if (method, path) == ("DELETE", "/api/plugins/kanban/links"):
            self.links[q["child_id"]] = [x for x in self.links.get(q["child_id"], []) if x != q["parent_id"]]
            return {"ok": True}
        return {}


FAKES: dict = {}


class FakeAPI:
    def __init__(self, auth):
        self.h = FAKES[auth]
        self.auth = auth

    def call(self, method, path, body=None, query=None, timeout=30):
        return self.h.call(method, path, body, query, timeout)


class Pod(SimpleNamespace):
    def owned_by(self, user):
        return user.get("sub") == self.owner_sub or user.get("email") == self.owner


class RouteTest(unittest.TestCase):
    def setUp(self):
        self.sub = "sub-" + os.urandom(3).hex()
        self.pods = [Pod(id=f"pa-{self.sub}", owner="a@x", owner_sub=self.sub)]
        FAKES.clear()
        FAKES[self.pods[0].id] = self.h = Hermes(("default", "main", "team-alpha"))
        self.h.configs["team-alpha"] = T_CONFIG
        self.h.souls["team-alpha"] = "# 민원 담당"
        self.h.agents["team-alpha"] = "작업 지침"
        self.env_texts = {"team-alpha": T_ENV}
        self.reg = SimpleNamespace(pods=self.pods, restarting=[])
        self.actions: list = []
        self.protected: dict = {"enabled": [], "ok": True, "calls": []}
        patches = [
            mock.patch.object(route, "HermesAPI", FakeAPI),
            mock.patch.object(route.server, "registry", lambda: self.reg),
            mock.patch.object(route.server, "hub", lambda pod: SimpleNamespace(auth=pod.id)),
            mock.patch.object(route.server, "_profile_action", self.fake_action),
            mock.patch.object(route.server, "_profile_text_io", self.text_io),
            mock.patch.object(route.server, "_forget", lambda pod, *a, **k: None),
            mock.patch.object(route.server, "_ProtectedOps", lambda pod: "ops"),
            mock.patch.object(route, "_env_text", lambda pod, name: self.env_texts.get(name, "")),
            mock.patch.object(route.protected_skills, "enabled_for", lambda pod, prof: list(self.protected["enabled"]) if prof == "team-alpha" else []),
            mock.patch.object(route.protected_skills, "apply_now", self.fake_apply),
            mock.patch.object(route.primary, "primary_of", lambda pod_id: "main"),
            mock.patch.dict(os.environ, {"AAS_MINDWIKI_WEBHOOK_SECRET": "s" * 32}),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        route._CACHE.clear()
        route._STREAK.clear()
        route._BOARDS.clear()
        route._MAKING.clear()
        self.addCleanup(self._cleanup)
        self.n = 0

    def _cleanup(self):
        with store.connect() as conn:
            conn.executescript(clones.SCHEMA)
            for p in self.pods:
                conn.execute("DELETE FROM mindwiki_auto_clone WHERE pod=?", (p.id,))
        with mindwiki_connect._conn() as conn:
            conn.execute("DELETE FROM connector_tokens WHERE sub=?", (self.sub,))

    def text_io(self, api, kind, name, prof):
        h = FAKES[api.auth] if not hasattr(api, "h") else api.h
        return (lambda: h.agents.get(name, "")), (lambda text: h.agents.__setitem__(name, text))

    def fake_action(self, pod, body, who, auto=False, locked=False):
        self.actions.append((body["action"], body["name"], auto, locked))
        h = FAKES[pod.id]
        if body["action"] == "create":
            if self.create_fail:
                raise HermesError("cannot create", 500)
            h.profiles.add(body["name"])
            h.configs[body["name"]] = "model: x\n"
            h.env[body["name"]] = {}
        elif body["action"] == "delete":
            h.profiles.discard(body["name"])
        return {"ok": True}

    create_fail = False

    def fake_apply(self, pod, profile, skill, ops, wait=10.0):
        self.protected["calls"].append((pod, profile, skill))
        return self.protected["ok"]

    def send(self, profile="team-alpha", web=False, deadline=None, automation="auto-1", pod=None):
        self.n += 1
        w = mw.parse(_payload(self.sub, profile, web, automation, pod))
        return route._deliver(w, "inst-1", str(self.n), deadline)

    def wait_clone(self, pod_id, name):
        for _ in range(200):
            row = clones.get(pod_id, name)
            if row is None or row["status"] != "making":
                return row
            time.sleep(0.02)
        self.fail("clone thread did not finish")

    def connect(self, profile, pod=None):
        with mindwiki_connect._conn() as conn:                          # 웹훅이 둔 빈 행(idle)을 연결된 행으로 바꾼다(다음 로그인의 자동 첫 연결)
            conn.execute("DELETE FROM connector_tokens WHERE product='mindwiki' AND sub=? AND pod=? AND profile=?", (self.sub, pod or self.pods[0].id, profile))
            conn.execute("INSERT INTO connector_tokens (product, sub, pod, profile, tid, workspace, write, status, expires_at, created_at) "
                         "VALUES ('mindwiki', ?, ?, ?, 'tid', 'ws', 1, 'connected', '2099-01-01T00:00:00+00:00', '')",
                         (self.sub, pod or self.pods[0].id, profile))

    def ready_clone(self, name="mwauto-team-alpha", connect=True):
        """첫 웹훅으로 복제본을 만들고 연결까지 해 둔다."""
        self.assertEqual(self.send()[:2], (202, "profile_preparing"))
        self.assertEqual(self.wait_clone(self.pods[0].id, name)["status"], "ready")
        if connect:
            self.connect(name)

    # -- 복제 ------------------------------------------------------------------------------------------------------

    def test_첫_웹훅은_복제를_시작하고_profile_preparing(self):
        self.protected["enabled"] = ["team-alpha-draft"]
        status, reason, tid, name = self.send()
        self.assertEqual((status, reason, tid, name), (202, "profile_preparing", "", "mwauto-team-alpha"))
        row = self.wait_clone(self.pods[0].id, name)
        self.assertEqual(row["status"], "ready")
        self.assertIn(("create", name, True, True), self.actions)                     # AAS 만들기 경로(auto·잠금), 빈 프로파일
        cfg = yaml.safe_load(self.h.configs[name])
        self.assertEqual(cfg["platforms"], {"telegram": {"enabled": False}})
        self.assertNotIn("mcp_servers", cfg)
        self.assertTrue(cfg["skills"]["write_approval"])
        self.assertEqual(self.h.env[name], {"LITELLM_URL": "http://llm", "LITELLM_KEY": "sk-live-123"})   # 허용 키만(채널·MCP_·GITHUB·FOO 없음)
        self.assertEqual((self.h.souls[name], self.h.agents[name]), ("# 민원 담당", "작업 지침"))
        self.assertEqual(self.protected["calls"], [(self.pods[0].id, name, "team-alpha-draft")])
        self.assertEqual(clones.skills_of(row), ["team-alpha-draft"])
        self.assertEqual(row["template_sha"], clones.sha(T_CONFIG))
        conn = mindwiki_connect._row(self.sub, self.pods[0].id, name)
        self.assertEqual((conn["status"], conn["workspace"]), ("idle", "ws-9"))        # 다음 로그인 때 자동화 전용 첫 연결
        self.assertFalse(any(c[1] == "/api/plugins/kanban/tasks" for c in self.h.calls))
        # 연결 전 다음 웹훅은 blocked(만들기 요청 없음)
        n = len(self.actions)
        self.assertEqual(self.send()[:2], (202, "blocked_no_write_token"))
        self.assertEqual(len(self.actions), n)

    def test_연결된_복제본이_카드를_맡고_skills_는_켜_둔다(self):
        self.ready_clone()
        log = []
        with mock.patch.object(route.store, "log_usage", lambda kind, text, **k: log.append((kind, text))):
            from starlette.requests import Request  # noqa: F401 — 경로 전체는 test_mindwiki_webhook 이 본다
            status, reason, tid, name = self.send()
        self.assertEqual((status, reason, tid, name), (202, "ok", "t_1", "mwauto-team-alpha"))
        task = next(c for c in self.h.calls if c[1] == "/api/plugins/kanban/tasks")
        self.assertEqual(task[2]["assignee"], "mwauto-team-alpha")
        self.assertIn("skill_manage 를 쓰지 않는다", task[2]["body"])
        puts = [(c[1], c[2]["enabled"]) for c in self.h.calls if c[0] == "PUT" and c[1].startswith("/api/tools/toolsets/")]
        self.assertNotIn(("/api/tools/toolsets/skills", False), puts)
        self.assertIn(("/api/tools/toolsets/terminal", False), puts)

    # -- 보호 스킬 미리 싣기(스펙 AAS 2026-11-22-004 M4) ----------------------------------------------------------------

    def _task(self):
        return next(c for c in self.h.calls if c[1] == "/api/plugins/kanban/tasks")

    def test_복제본_카드에_켠_보호_스킬을_싣는다(self):
        self.ready_clone()
        seen = []
        with mock.patch.object(route.protected_skills, "preload_for", lambda pod, prof, message=None: seen.append((prof, message)) or ["team-alpha-draft"]):
            self.assertEqual(self.send()[:2], (202, "ok"))
        self.assertEqual([p for p, _ in seen], ["mwauto-team-alpha"])    # 복제본 이름으로 고른다(같은 이름 알림이 있는 것은 preload_for 가 뺀다)
        self.assertTrue(seen[0][1])                                       # 맡길 일을 넘겨 첫 구절의 보호 스킬만 고른다(스펙 2026-11-24-002 D8)
        self.assertEqual(self._task()[2]["skills"], ["team-alpha-draft"])

    def test_실을_스킬이_없으면_skills_칸을_보내지_않는다(self):
        self.ready_clone()
        with mock.patch.object(route.protected_skills, "preload_for", lambda pod, prof, message=None: []):
            self.assertEqual(self.send()[:2], (202, "ok"))
        self.assertNotIn("skills", self._task()[2])

    def test_미리_싣기_스위치를_끄면_복제_경로는_싣지_않는다(self):
        self.ready_clone()
        with mock.patch.dict(os.environ, {"AAS_MINDWIKI_PRELOAD_SKILLS": "0"}), \
                mock.patch.object(route.protected_skills, "preload_for", lambda pod, prof, message=None: ["team-alpha-draft"]):
            self.assertEqual(self.send()[:2], (202, "ok"))
        self.assertNotIn("skills", self._task()[2])

    # -- 고정 작업 폴더(스펙 AAS 2026-11-23-003 P5 뒤): 카드마다 폴더가 다르면 시스템 프롬프트의 작업 폴더 줄이 바뀌어
    #    그 뒤의 미리 실은 스킬 · 도구 설명이 vLLM 캐시에 맞지 않는다(2026-11-23 gemma 첫 요청 47초) --------------------------

    def test_복제본_카드는_복제본마다_고정된_작업_폴더를_쓴다(self):
        self.ready_clone()
        self.assertEqual(self.send()[:2], (202, "ok"))
        task = self._task()[2]
        self.assertEqual(task["workspace_kind"], "dir")
        self.assertEqual(task["workspace_path"], "/opt/data/kanban/boards/mindwiki/workspaces/shared-mwauto-team-alpha")

    def test_고정_작업_폴더_스위치를_끄면_보내지_않는다(self):
        self.ready_clone()
        with mock.patch.dict(os.environ, {"AAS_MINDWIKI_SHARED_WORKDIR": "0"}):
            self.assertEqual(self.send()[:2], (202, "ok"))
        self.assertNotIn("workspace_kind", self._task()[2])
        self.assertNotIn("workspace_path", self._task()[2])

    def test_스킬을_찾지_못해_카드가_실패하면_skills_없이_한_번_다시_보낸다(self):
        self.ready_clone()
        real = self.h.call

        def call(method, path, body=None, query=None, timeout=30):
            if method == "POST" and path == "/api/plugins/kanban/tasks" and "skills" in (body or {}):
                self.h.calls.append((method, path, body, query))
                raise HermesError("unknown skill: team-alpha-draft", 400)
            return real(method, path, body, query, timeout)
        logs = []
        with mock.patch.object(self.h, "call", call), mock.patch.object(route, "_log", lambda ev, **kv: logs.append((ev, kv))), \
                mock.patch.object(route.protected_skills, "preload_for", lambda pod, prof, message=None: ["team-alpha-draft"]):
            self.assertEqual(self.send()[:2], (202, "ok"))
        posts = [c[2] for c in self.h.calls if c[1] == "/api/plugins/kanban/tasks"]
        self.assertEqual(["skills" in b for b in posts], [True, False])
        ev, kv = next(x for x in logs if "preload_failed" in x[0])
        self.assertEqual((kv["profile"], kv["skills"]), ("mwauto-team-alpha", "team-alpha-draft"))
        self.assertIn("unknown skill", kv["error"])

    def test_앞서_만든_복제본에도_카드_때_미룰_도구를_더한다(self):
        self.ready_clone()
        name = "mwauto-team-alpha"
        old = yaml.safe_load(self.h.configs[name])
        old.pop("tools", None)                                           # 이 판 앞에 만든 복제본
        self.h.configs[name] = yaml.safe_dump(old)
        self.assertEqual(self.send()[:2], (202, "ok"))
        self.assertEqual(yaml.safe_load(self.h.configs[name])["tools"]["tool_search"]["defer"], list(clones.DEFER_TOOLS))
        self.assertEqual(yaml.safe_load(self.h.configs[name])["skills"]["write_approval"], True)   # 다른 설정은 그대로
        self.h.calls.clear()
        self.assertEqual(self.send()[:2], (202, "ok"))
        self.assertFalse(any(c[0] == "PUT" and c[1] == "/api/config/raw" for c in self.h.calls))   # 다 있으면 쓰지 않는다

    def test_미룰_도구_쓰기가_실패해도_카드는_만든다(self):
        self.ready_clone()
        name = "mwauto-team-alpha"
        old = yaml.safe_load(self.h.configs[name])
        old.pop("tools", None)
        self.h.configs[name] = yaml.safe_dump(old)
        self.h.fail_on = ("PUT", "/api/config/raw")
        logs = []
        with mock.patch.object(route, "_log", lambda ev, **kv: logs.append(ev)):
            self.assertEqual(self.send()[:2], (202, "ok"))
        self.assertIn("WARNING mindwiki_auto_tune_tools_failed", logs)

    # -- 복제본 동시 상한(스펙 AAS 2026-11-22-004 M11) --------------------------------------------------------------------

    @staticmethod
    def _card(tid, assignee="mwauto-team-alpha", created=1, parents=0):
        return {"id": tid, "assignee": assignee, "created_at": created, "link_counts": {"parents": parents, "children": 0}}

    def test_상한이_없으면_선행_카드를_걸지_않는다(self):
        self.ready_clone()
        self.h.board = {"running": [self._card("t_run")]}
        self.assertEqual(self.send()[:2], (202, "ok"))
        self.assertNotIn("parents", self._task()[2])

    def test_상한_1_이면_도는_카드_뒤에_줄_세운다(self):
        self.ready_clone()
        self.h.board = {"running": [self._card("t_old", created=1)], "ready": [self._card("t_new", created=5)],
                        "done": [self._card("t_done", created=9)], "todo": [self._card("t_other", assignee="main", created=8)]}
        with mock.patch.dict(os.environ, {"AAS_MINDWIKI_CARD_CONCURRENCY": "1"}):
            self.assertEqual(self.send()[:2], (202, "ok"))
        self.assertEqual(self._task()[2]["parents"], ["t_new"])          # 가장 늦게 만든, 아직 도는 같은 복제본 카드
        self.h.calls.clear()
        self.h.board = {"done": [self._card("t_new")]}
        with mock.patch.dict(os.environ, {"AAS_MINDWIKI_CARD_CONCURRENCY": "1"}):
            self.assertEqual(self.send()[:2], (202, "ok"))
        self.assertNotIn("parents", self._task()[2])                     # 도는 것이 없으면 바로 시작

    def test_선행_카드가_막혀_묶인_카드는_이음을_풀고_준비로_돌린다(self):
        self.ready_clone()
        self.h.board = {"blocked": [self._card("t_bad", created=1)], "todo": [self._card("t_wait", created=2, parents=1)]}
        self.h.links = {"t_wait": ["t_bad"]}
        with mock.patch.dict(os.environ, {"AAS_MINDWIKI_CARD_CONCURRENCY": "1"}):
            self.assertEqual(self.send()[:2], (202, "ok"))
        self.assertEqual(self.h.links["t_wait"], [])
        self.assertIn(("PATCH", "/api/plugins/kanban/tasks/t_wait", {"status": "ready"}), [c[:3] for c in self.h.calls])
        self.assertEqual(self._task()[2]["parents"], ["t_wait"])          # 풀린 카드가 도는 카드가 되어 그 뒤에 선다

    def test_보드를_읽지_못하면_상한_없이_보낸다(self):
        self.ready_clone()
        self.h.fail_on = ("GET", "/api/plugins/kanban/board")
        logs = []
        with mock.patch.dict(os.environ, {"AAS_MINDWIKI_CARD_CONCURRENCY": "1"}), mock.patch.object(route, "_log", lambda ev, **kv: logs.append(ev)):
            self.assertEqual(self.send()[:2], (202, "ok"))
        self.assertNotIn("parents", self._task()[2])
        self.assertIn("WARNING mindwiki_auto_queue_failed", logs)

    # -- 같은 행 카드 막기(스펙 AAS 2026-11-22-004 따로 고칠 것 16) --------------------------------------------------------------

    def _ledger_card(self, delivery, card_id, page="row-1", install="inst-1"):
        """앞선 웹훅이 이 행으로 카드를 만들고 끝난 원장 줄. 시험 끝에 지운다(시험들이 데이터 폴더를 함께 쓴다)."""
        mw.begin(install, delivery, self.sub)
        mw.finish(install, delivery, card_id, "ok", page=page)
        self.addCleanup(self._drop_ledger, install, delivery)

    @staticmethod
    def _drop_ledger(install, delivery):
        with mw._conn() as conn:
            conn.execute("DELETE FROM mindwiki_webhook_ledger WHERE install=? AND delivery=?", (install, delivery))

    def test_같은_행_카드가_돌고_있으면_새_카드를_만들지_않는다(self):
        self.ready_clone()
        self._ledger_card("same-row-1", "t_prev")
        self.h.board = {"todo": [self._card("t_prev")]}
        logs = []
        self.h.calls.clear()
        with mock.patch.object(route, "_log", lambda ev, **kv: logs.append(ev)):
            self.assertEqual(self.send()[:3], (202, "ok", "t_prev"))          # 그 카드로 답한다 — 위키 「AI 작업 중」이 그 카드를 따른다
        self.assertFalse(any(c[1] == "/api/plugins/kanban/tasks" and c[0] == "POST" for c in self.h.calls))
        self.assertIn("mindwiki_auto_same_row", logs)

    def test_같은_행_카드가_끝났으면_새_카드를_만든다(self):
        self.ready_clone()
        self._ledger_card("same-row-2", "t_prev")
        self.h.board = {"done": [self._card("t_prev")]}
        status, reason, tid, _ = self.send()
        self.assertEqual((status, reason), (202, "ok"))
        self.assertNotEqual(tid, "t_prev")

    def test_다른_행_카드는_막지_않는다(self):
        self.ready_clone()
        self._ledger_card("same-row-3", "t_other_row", page="row-2")
        self.h.board = {"running": [self._card("t_other_row")]}
        self.assertNotEqual(self.send()[2], "t_other_row")

    def test_같은_행을_볼_보드를_읽지_못하면_막지_않는다(self):
        self.ready_clone()
        self._ledger_card("same-row-4", "t_prev")
        self.h.fail_on = ("GET", "/api/plugins/kanban/board")
        logs = []
        with mock.patch.object(route, "_log", lambda ev, **kv: logs.append(ev)):
            self.assertEqual(self.send()[:2], (202, "ok"))
        self.assertIn("POST", [c[0] for c in self.h.calls if c[1] == "/api/plugins/kanban/tasks"])
        self.assertIn("WARNING mindwiki_auto_same_row_failed", logs)

    def test_원장은_행_id_를_남긴다(self):
        self._ledger_card("same-row-5", "t_x", page="row-9")
        self.assertEqual(mw.cards_for_page("inst-1", "row-9"), ["t_x"])
        self.assertEqual(mw.cards_for_page("inst-other", "row-9"), [])
        self.assertEqual(mw.cards_for_page("inst-1", ""), [])

    def test_log_usage_는_deliver_가_돌려준_이름(self):
        self.ready_clone()
        got = []
        body = _payload(self.sub)
        with mock.patch.object(route.mw, "verify", return_value=("inst-1", "900")), \
                mock.patch.object(route.store, "log_usage", lambda kind, text, **k: got.append((kind, text))):
            import anyio
            from starlette.requests import Request
            scope = {"type": "http", "method": "POST", "path": route.PATH, "query_string": b"", "headers": [(b"content-length", str(len(body)).encode())],
                     "scheme": "https", "server": ("a", 443), "client": ("1", 1), "root_path": ""}
            parts = [body]

            async def receive():
                return {"type": "http.request", "body": parts.pop(0) if parts else b"", "more_body": False}
            resp = anyio.run(route.receive, Request(scope, receive))
        self.assertEqual(resp.status_code, 202)
        self.assertEqual(got, [("mindwiki_webhook_card", "mwauto-team-alpha ok t_1")])
        with store.connect() as conn:
            conn.execute("DELETE FROM mindwiki_webhook_ledger WHERE delivery='900'")

    def test_웹_조사를_켜면_mwauto_web_복제본_둘은_따로(self):
        self.ready_clone()
        self.assertEqual(self.send(web=True)[:2], (202, "profile_preparing"))
        self.assertEqual(self.wait_clone(self.pods[0].id, "mwauto-web-team-alpha")["status"], "ready")
        self.assertEqual(owner_guard.profile_count(sorted(self.h.profiles), False), 3)   # default·main·team-alpha — 복제본 둘은 세지 않는다

    def test_보호_스킬이_맞지_않으면_카드_없이_profile_preparing(self):
        self.protected["enabled"] = ["team-alpha-draft"]
        self.ready_clone()
        self.protected["ok"] = False
        self.assertEqual(self.send()[:2], (202, "profile_preparing"))
        self.assertFalse(any(c[1] == "/api/plugins/kanban/tasks" for c in self.h.calls))

    def test_설치_규칙을_복제본에_복사하지_못하면_카드_없이_profile_preparing(self):
        # 스펙 2026-11-24-001 4-5: 규칙 표 쓰기가 실패하면 카드를 규칙 없이 돌리지 않는다
        self.protected["enabled"] = ["team-alpha-draft"]
        self.ready_clone()
        with mock.patch.object(route.protected_skills, "copy_rules", side_effect=RuntimeError("db")), mock.patch("builtins.print") as out:
            self.assertEqual(self.send()[:2], (202, "profile_preparing"))
        self.assertTrue(any("protected_skill_rules_copy_failed" in str(c) for c in out.call_args_list))
        self.assertFalse(any(c[1] == "/api/plugins/kanban/tasks" for c in self.h.calls))

    def test_설치_규칙은_복제와_카드_직전에_T_에서_복사한다(self):
        self.protected["enabled"] = ["team-alpha-draft"]
        seen = []
        with mock.patch.object(route.protected_skills, "copy_rules", side_effect=lambda *a: seen.append(a) or 0):
            self.ready_clone()
            self.send()
        name = "mwauto-team-alpha"
        self.assertEqual(seen, [(self.pods[0].id, "team-alpha", name, "team-alpha-draft")] * 2)

    def test_복제_중_설치_규칙_복사가_실패하면_복제를_멈춘다(self):
        self.protected["enabled"] = ["team-alpha-draft"]
        with mock.patch.object(route.protected_skills, "copy_rules", side_effect=RuntimeError("db")):
            self.assertEqual(self.send()[:2], (202, "profile_preparing"))
            row = self.wait_clone(self.pods[0].id, "mwauto-team-alpha")
        self.assertNotEqual((row or {}).get("status"), "ready")
        self.assertEqual(self.protected["calls"], [])                    # 규칙 없이 사본을 쓰지 않았다

    def test_T_설정이_바뀌면_경고만_남기고_카드는_만든다(self):
        self.ready_clone()
        self.h.configs["team-alpha"] = T_CONFIG + "timezone: Asia/Seoul\n"
        with mock.patch("builtins.print") as out:
            self.assertEqual(self.send()[:2], (202, "ok"))
        self.assertTrue(any("mindwiki_auto_profile_drift" in str(c) for c in out.call_args_list))

    # -- 실패 정리 ---------------------------------------------------------------------------------------------------

    def test_확인에_실패하면_지우고_1시간_profile_unsafe(self):
        self.h.ignore_config = True                                   # 설정 쓰기가 반영되지 않아 write_approval 이 없다
        self.assertEqual(self.send()[:2], (202, "profile_preparing"))
        row = self.wait_clone(self.pods[0].id, "mwauto-team-alpha")
        self.assertEqual(row["status"], "unsafe")
        self.assertIn(("delete", "mwauto-team-alpha", False, False), self.actions)
        n = len(self.actions)
        self.assertEqual(self.send()[:2], (202, "profile_unsafe"))      # 1시간 안 — 다시 복제하지 않는다
        self.assertEqual(len(self.actions), n)
        with mock.patch.object(clones, "now", lambda: time.time() + clones.UNSAFE_FOR + 5):
            self.h.ignore_config = False
            self.assertEqual(self.send()[:2], (202, "profile_preparing"))   # 1시간 뒤 다시 복제
            self.wait_clone(self.pods[0].id, "mwauto-team-alpha")

    def test_단계마다_예외가_나면_이번에_만든_복제본을_지운다(self):
        for step in (("PUT", "/api/config/raw"), ("PUT", "/api/profiles/mwauto-team-alpha/soul"), ("PUT", "/api/env")):
            with self.subTest(step=step):
                self.h.fail_on = step
                self.actions.clear()
                self.assertEqual(self.send()[:2], (202, "profile_preparing"))
                self.assertEqual(self.wait_clone(self.pods[0].id, "mwauto-team-alpha")["status"], "unsafe")
                self.assertIn(("delete", "mwauto-team-alpha", False, False), self.actions)
                clones.drop(self.pods[0].id, "mwauto-team-alpha")
        self.h.fail_on = None
        self.protected["enabled"], self.protected["ok"] = ["team-alpha-draft"], False   # 보호 스킬 쓰기 실패도 같다
        self.actions.clear()
        self.send()
        self.assertEqual(self.wait_clone(self.pods[0].id, "mwauto-team-alpha")["status"], "unsafe")
        self.assertIn(("delete", "mwauto-team-alpha", False, False), self.actions)

    def test_만들기_자체가_실패하면_지우지_않고_다음에_다시(self):
        self.create_fail = True
        self.assertEqual(self.send()[:2], (202, "profile_preparing"))
        self.assertIsNone(self.wait_clone(self.pods[0].id, "mwauto-team-alpha"))
        self.assertFalse(any(a[0] == "delete" for a in self.actions))

    def test_이미_있는_이름이면_지우지_않는다(self):
        real = self.h.call

        def appear(method, path, body=None, query=None, timeout=30):      # 웹훅이 본 뒤, 뒤 작업 전에 다른 서버가 만들었다
            if (method, path) == ("GET", "/api/profiles") and threading.current_thread().name.startswith("mwauto-"):
                self.h.profiles.add("mwauto-team-alpha")
            return real(method, path, body, query, timeout)
        self.h.call = appear
        self.assertEqual(self.send()[:2], (202, "profile_preparing"))
        self.assertIsNone(self.wait_clone(self.pods[0].id, "mwauto-team-alpha"))   # 줄만 지움, 기억 없음
        self.assertFalse(any(a[0] in ("create", "delete") for a in self.actions))

    def test_멈춘_만들기는_한_서버만_지우고_profile_unsafe(self):
        pod = self.pods[0].id
        with mock.patch.object(clones, "now", lambda: time.time() - clones.STALE - 5):
            clones.claim(pod, "mwauto-team-alpha", "team-alpha", "other-server")
        self.h.profiles.add("mwauto-team-alpha")
        self.assertEqual(self.send()[:2], (202, "profile_unsafe"))
        for _ in range(100):
            if any(a[0] == "delete" for a in self.actions):
                break
            time.sleep(0.02)
        self.assertIn(("delete", "mwauto-team-alpha", False, False), self.actions)
        self.assertTrue(clones.unsafe(clones.get(pod, "mwauto-team-alpha")))

    def test_다른_서버가_만드는_중이면_blocked(self):
        clones.claim(self.pods[0].id, "mwauto-team-alpha", "team-alpha", "other-server")   # DB 행만 making(메모리 표시 없음)
        self.assertEqual(self.send()[:2], (202, "blocked_no_write_token"))
        self.assertEqual(self.actions, [])

    # -- 쓸 때 점검 --------------------------------------------------------------------------------------------------

    def test_이미_있는_복제본의_점검(self):
        name = "mwauto-team-alpha"
        self.ready_clone()
        good = self.h.configs[name]
        cases = {
            "channel": (good.replace("enabled: false", "enabled: true"), {}),
            "mindwiki_no_row": (good.replace("skills:", "mcp_servers:\n  cogentai-mindwiki: {url: x}\nskills:"), {}),
            "write_approval": (good.replace("write_approval: true", "write_approval: false"), {}),
            "shared_key": (good, {"MCP_GITHUB_API_KEY": "x"}),
            "channel_env": (good, {"TELEGRAM_BOT_TOKEN": "x"}),
        }
        for label, (cfg, env) in cases.items():
            with self.subTest(label):
                if label == "mindwiki_no_row":
                    with mindwiki_connect._conn() as conn:
                        conn.execute("DELETE FROM connector_tokens WHERE sub=?", (self.sub,))
                else:
                    self.connect(name)
                self.h.configs[name], self.h.env[name] = cfg, {"LITELLM_KEY": "k", **env}
                self.actions.clear()
                self.assertEqual(self.send()[:2], (202, "profile_unsafe"))
                self.assertEqual(self.actions, [])                       # 이번 호출이 만든 것이 아니므로 지우지 않는다
                self.assertFalse(any(c[1] == "/api/plugins/kanban/tasks" for c in self.h.calls))
        self.h.configs[name] = good.replace("skills:", "mcp_servers:\n  cogentai-mindwiki: {url: x}\nskills:")   # 자동화 연결 행이 있으면 받는다
        self.h.env[name] = {"LITELLM_KEY": "k", "MCP_COGENTAI_MINDWIKI_API_KEY": "wiki_pat_auto"}
        self.connect(name)
        self.assertEqual(self.send()[:2], (202, "ok"))

    def test_상한_3개(self):
        self.h.profiles |= {"mwauto-a", "mwauto-b", "mwauto-web-a"}
        self.assertEqual(self.send()[:2], (202, "profile_limit"))
        self.assertEqual(self.actions, [])

    def test_상한은_만드는_중도_센다(self):
        self.h.profiles |= {"mwauto-a", "mwauto-b"}
        self.h.profiles.add("other")
        self.assertEqual(self.send()[:2], (202, "profile_preparing"))
        clones.claim(self.pods[0].id, "mwauto-other", "other", "o")      # 뒤 작업이 끝나기 전 다른 T 의 웹훅
        self.wait_clone(self.pods[0].id, "mwauto-team-alpha")
        self.h.profiles.discard("mwauto-team-alpha")
        clones.drop(self.pods[0].id, "mwauto-team-alpha")
        self.assertEqual(self.send()[:2], (202, "profile_limit"))        # a·b + 만드는 중 other = 3
        clones.drop(self.pods[0].id, "mwauto-other")

    # -- 파드 찾기 ---------------------------------------------------------------------------------------------------

    def add_pod(self, profiles=("default", "main")):
        p = Pod(id=f"pb-{self.sub}-{len(self.pods)}", owner="a@x", owner_sub=self.sub)
        self.pods.append(p)
        FAKES[p.id] = Hermes(profiles)
        return p, FAKES[p.id]

    def test_T_가_없으면_no_profile_여럿이면_ambiguous(self):
        self.add_pod()
        self.assertEqual(self.send("nothere")[:2], (202, "no_profile"))
        _, h2 = self.add_pod(("default", "team-alpha"))
        self.assertEqual(self.send()[:2], (202, "ambiguous_profile"))
        self.assertEqual(self.actions, [])

    def test_답하지_않는_파드가_있으면_503_세_번이면_pod_unreachable(self):
        _, h2 = self.add_pod()
        h2.fail = HermesError("starting", 503)
        self.assertEqual(self.send("nothere")[:2], (503, "hermes_not_ready"))   # 답한 파드에 없음 + 답하지 않은 파드
        self.assertEqual(self.send()[:2], (503, "hermes_not_ready"))     # T 가 답한 한 파드에만 있어도(D6 을 지킬 수 없다)
        self.assertEqual(self.send()[:2], (503, "hermes_not_ready"))
        self.assertEqual(self.send()[:2], (202, "pod_unreachable"))      # 같은 자동화·같은 T 에서 세 번째
        self.assertEqual(self.send()[:2], (503, "hermes_not_ready"))     # 알린 뒤 다시 센다
        self.assertEqual(self.send(automation="auto-2")[:2], (503, "hermes_not_ready"))   # 다른 자동화는 따로 센다

    def test_느린_파드는_약_2초에_답하지_않음(self):
        _, h2 = self.add_pod()
        h2.delay = 3.0
        t0 = time.monotonic()
        self.assertEqual(self.send()[:2], (503, "hermes_not_ready"))
        self.assertLess(time.monotonic() - t0, 2.7)

    def test_느린_파드에_웹훅이_몰려도_조회는_하나(self):
        _, h2 = self.add_pod()
        h2.delay = 1.0
        threads = [threading.Thread(target=self.send) for _ in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(sum(1 for c in h2.calls if c[:2] == ("GET", "/api/profiles")), 1)

    def test_캐시가_맞으면_그_파드에만_묻고_주인이_바뀌면_다시_찾는다(self):
        p2, h2 = self.add_pod()
        self.ready_clone()
        h2.calls.clear()
        self.send()
        self.assertEqual(h2.calls, [])                                   # 캐시한 파드에만 GET /api/profiles
        self.pods[0].owner_sub, self.pods[0].owner = "someone-else", "z@x"   # 캐시 뒤 주인이 바뀜
        self.assertEqual(self.send()[:2], (202, "no_profile"))
        self.assertTrue(any(c[:2] == ("GET", "/api/profiles") for c in h2.calls))

    def test_마감이_지나면_카드_없이_503(self):
        self.ready_clone()
        self.assertEqual(self.send(deadline=time.monotonic() - 1)[:2], (503, "hermes_not_ready"))
        self.assertFalse(any(c[1] == "/api/plugins/kanban/tasks" for c in self.h.calls))
        self.h.delay = 0.3                                               # 카드 직전에 마감이 지난다
        self.assertEqual(self.send(deadline=time.monotonic() + 1.0)[:2], (503, "hermes_not_ready"))
        self.assertFalse(any(c[1] == "/api/plugins/kanban/tasks" for c in self.h.calls))

    def test_파드가_없으면_422(self):
        self.pods.clear()
        self.assertEqual(self.send()[:2], (422, "no_agent"))

    def test_profile_이_없으면_지금_경로(self):
        """G4: 기본 mindwiki-auto 는 skills 도 끈다(지금 그대로)."""
        self.h.profiles.add("mindwiki-auto")
        self.connect("mindwiki-auto")
        status, reason, tid, name = self.send(profile=None)
        self.assertEqual((status, reason, name), (202, "ok", "mindwiki-auto"))
        puts = [(c[1], c[2]["enabled"]) for c in self.h.calls if c[0] == "PUT"]
        self.assertIn(("/api/tools/toolsets/skills", False), puts)
        self.assertEqual(self.actions, [])


    # -- 지정한 AAS 에이전트(스펙 2026-11-21-002 §3-7) -----------------------------------------------------------------

    def test_파드를_지정하면_같은_이름이_여럿이어도_그_파드로(self):
        p2, h2 = self.add_pod(("default", "team-alpha"))
        h2.configs["team-alpha"] = T_CONFIG
        self.assertEqual(self.send()[:2], (202, "ambiguous_profile"))                  # 지정이 없으면 지금처럼 막힘
        self.assertEqual(self.send(pod=p2.id)[:2], (202, "profile_preparing"))         # 지정하면 그 파드에서 복제를 시작
        self.assertEqual(self.wait_clone(p2.id, "mwauto-team-alpha")["status"], "ready")
        self.assertIsNone(clones.get(self.pods[0].id, "mwauto-team-alpha"))            # 다른 파드는 건드리지 않는다
        self.assertEqual(self.send("nothere", pod=p2.id)[:2], (202, "no_profile"))     # 그 파드에 없으면 no_profile(다른 파드는 보지 않는다)

    def test_남의_파드나_없는_파드를_지정하면_pod_not_owned(self):
        other = Pod(id="pz-other", owner="z@x", owner_sub="someone")
        self.pods.append(other)
        FAKES[other.id] = Hermes(("default", "team-alpha"))
        for pod in (other.id, "pz-gone"):
            self.assertEqual(self.send(pod=pod)[:2], (202, "pod_not_owned"))
            self.assertEqual(self.send(profile=None, pod=pod)[:2], (202, "pod_not_owned"))
        self.assertEqual(FAKES[other.id].calls, [])                                    # 남의 파드에는 묻지도 않는다
        self.assertEqual(self.actions, [])

    def test_지정한_파드가_다시_뜨는_중이면_503(self):
        p2 = Pod(id=f"pr-{self.sub}", owner="a@x", owner_sub=self.sub)
        self.reg.restarting = [p2]
        self.assertEqual(self.send(pod=p2.id)[:2], (503, "hermes_not_ready"))
        self.assertEqual(self.send(profile=None, pod=p2.id)[:2], (503, "hermes_not_ready"))

    def test_기본_경로도_지정한_파드의_mindwiki_auto(self):
        p2, h2 = self.add_pod(("default", "mindwiki-auto"))
        self.connect("mindwiki-auto", pod=p2.id)
        status, reason, tid, name = self.send(profile=None, pod=p2.id)
        self.assertEqual((status, reason, name), (202, "ok", "mindwiki-auto"))
        self.assertTrue(any(c[1] == "/api/plugins/kanban/tasks" for c in h2.calls))
        self.assertFalse(any(c[1] == "/api/plugins/kanban/tasks" for c in self.h.calls))

    def test_pod_값_검사(self):
        for bad in (5, ["p"], "p" * 101):
            body = json.loads(_payload(self.sub))
            body["agent"]["pod"] = bad
            with self.assertRaises(mw.Reject):
                mw.parse(json.dumps(body).encode())
        self.assertEqual(mw.parse(_payload(self.sub, pod=" p1 "))["pod"], "p1")
        self.assertEqual(mw.parse(_payload(self.sub))["pod"], "")

if __name__ == "__main__":
    unittest.main()
