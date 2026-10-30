# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""픽스처 Hermes 홈으로 수집·집계·마스킹·스킬 추출을 시험한다. 실제 Hermes 는 건드리지 않는다."""
import json
import os
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

KST = timezone(timedelta(hours=9))
NOW = datetime(2026, 10, 4, 12, 0, tzinfo=KST)


def iso(**delta):
    return (NOW - timedelta(**delta)).isoformat()


def make_home(root: Path) -> Path:
    home = root / "hermes"
    (home / "cron").mkdir(parents=True)
    (home / "config.yaml").write_text(
        "model:\n  default: m-main\n  provider: custom\n  base_url: http://host.docker.internal:14400/v1\n"
        "fallback_providers:\n- provider: custom\n  model: m-gone\n  api_mode: openai\n  base_url: http://host.docker.internal:14400/v1\n"
        "providers:\n  litellm:\n    base_url: http://host.docker.internal:14400/v1\n    api_key: sk-FIXTUREKEY123456\n"
        "    models: [m-main, m-old]\nauxiliary:\n  vision:\n    model: m-vis\n    api_key: ''\n  title:\n    model: ''\n"
        "mcp_servers:\n  OMDM:\n    url: https://secret.example/mcp\n    headers:\n"
        "      Authorization: Bearer SHOULD_NOT_BE_READ\n  my-crm:\n    command: x\nother: 1\n")
    a = home / "profiles" / "alpha"
    (a / "cron").mkdir(parents=True)
    jobs = [
        {"id": "j1", "name": "ok-job", "enabled": True, "deliver": "telegram:1", "last_status": "ok",
         "last_run_at": iso(hours=1), "next_run_at": iso(hours=-23), "skills": ["report"]},
        {"id": "j2", "name": "broken", "enabled": True, "deliver": "telegram:1", "last_status": "error",
         "last_error": "GET https://api.x.io/v1?token=abc123secret failed", "failure_streak": 4,
         "last_run_at": iso(hours=2), "next_run_at": iso(hours=-22)},
        {"id": "j3", "name": "stuck", "enabled": True, "deliver": "buzz", "last_status": "ok",
         "next_run_at": iso(hours=50)},
        {"id": "j4", "name": "quiet", "enabled": True, "deliver": "local", "last_status": "ok",
         "next_run_at": iso(hours=-1)},
        {"id": "j5", "name": "paused", "enabled": False, "deliver": "local", "last_status": "error",
         "next_run_at": iso(hours=99)},
        {"id": "j6", "name": "edge", "enabled": True, "deliver": "telegram:1", "last_status": "ok",
         "next_run_at": iso(hours=1, minutes=59)},
    ]
    (a / "cron" / "jobs.json").write_text(json.dumps({"jobs": jobs}))
    db = sqlite3.connect(a / "cron" / "executions.db")
    db.executescript("""
      CREATE TABLE executions (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, source TEXT, process_id TEXT,
        pid INTEGER, process_started_at INTEGER, status TEXT NOT NULL, claimed_at TEXT NOT NULL,
        started_at TEXT, finished_at TEXT, error TEXT);
      CREATE TABLE cron_incidents (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, error_sig TEXT NOT NULL,
        state TEXT NOT NULL, failure_type TEXT NOT NULL DEFAULT 'unknown', first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL, acked_at TEXT, closed_at TEXT, error TEXT NOT NULL, output_file TEXT);""")
    db.execute("INSERT INTO executions VALUES ('e1','j1','s','p',1,0,'completed',?,?,?,NULL)",
               (iso(hours=1), iso(hours=1), iso(hours=1)))
    db.execute("INSERT INTO executions VALUES ('e2','j2','s','p',1,0,'failed',?,?,?,'boom')",
               (iso(hours=2), iso(hours=2), iso(hours=2)))
    db.execute("INSERT INTO executions VALUES ('e3','j1','s','p',1,0,'running',?,?,NULL,NULL)",
               (iso(hours=9), iso(hours=9)))
    db.execute("INSERT INTO cron_incidents VALUES ('i1','j2','sig','alerted','script',?,?,NULL,NULL,?,NULL)",
               (iso(days=5), iso(hours=2), "Authorization: Bearer abcdefghijklmnop failed"))
    db.execute("INSERT INTO cron_incidents VALUES ('i2','j2','sig2','detected','script',?,?,NULL,NULL,'new one',NULL)",
               (iso(hours=3), iso(hours=3)))
    db.execute("INSERT INTO cron_incidents VALUES ('i3','j2','sig3','closed','script',?,?,?,?,'old',NULL)",
               (iso(days=9), iso(days=8), iso(days=8), iso(days=8)))
    db.commit(); db.close()
    b = home / "profiles" / "beta"            # 사건 테이블이 없는 프로파일
    (b / "cron").mkdir(parents=True)
    (b / "cron" / "jobs.json").write_text(json.dumps({"jobs": []}))
    db = sqlite3.connect(b / "cron" / "executions.db")
    db.execute("CREATE TABLE executions (id TEXT, job_id TEXT, status TEXT, claimed_at TEXT, started_at TEXT)")
    db.commit(); db.close()
    c = home / "profiles" / "gamma"           # 깨진 jobs.json
    (c / "cron").mkdir(parents=True)
    (c / "cron" / "jobs.json").write_text("{not json")
    (home / "profiles" / ".hidden").mkdir()
    s = home / "skills" / "ops" / "report"
    s.mkdir(parents=True)
    (s / "SKILL.md").write_text(
        "---\nname: report\ndescription: \"주간 보고\"\nmetadata:\n  hermes:\n    related_skills: [helper]\n---\n"
        "`mcp__OMDM__create_page` 로 올린다. mcp_my_crm_search 도 쓴다.\n"
        "curl https://api.example.org/v2/items?key=SECRETVALUE 그리고 https://docs.openmaru.io/a/b?x=1\n"
        "`/helper` 를 먼저 부른다. 예시: http://localhost:8080/x\n")
    (s / "run.py").write_text("import requests\nrequests.get('https://api.github.com/repos')\n")
    h = home / "skills" / "ops" / "helper"
    h.mkdir(parents=True)
    (h / "SKILL.md").write_text("---\nname: helper\ndescription: 보조\n---\n본문\n")
    bk = home / "skills" / ".curator_backups" / "old"
    bk.mkdir(parents=True)
    (bk / "SKILL.md").write_text("---\nname: old\n---\n")
    return home


class AasTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.home = make_home(Path(cls.tmp.name))
        os.environ["AAS_HERMES_HOME"] = str(cls.home)
        os.environ["AAS_DATA_DIR"] = str(Path(cls.tmp.name) / "data")
        from aas.ops import cron_health
        cls.health = cron_health.collect(now=NOW)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def prof(self, name):
        return next(p for p in self.health["profiles"] if p["name"] == name)

    def test_profiles_discovered_without_hidden(self):
        self.assertEqual([p["name"] for p in self.health["profiles"]],
                         ["default", "alpha", "beta", "gamma"])

    def test_open_incidents_exclude_closed_and_flag_new(self):
        inc = {i["id"]: i for i in self.health["incidents"]}
        self.assertEqual(set(inc), {"i1", "i2"})
        self.assertTrue(inc["i2"]["new"]); self.assertFalse(inc["i1"]["new"])
        self.assertEqual(inc["i1"]["age_days"], 5)
        self.assertEqual(self.health["incidents"][0]["id"], "i2")   # 신규가 먼저
        self.assertIn("hermes -p alpha cron incidents ack i1", inc["i1"]["ack"])

    def test_failed_jobs_skip_disabled(self):
        self.assertEqual([j["job"] for j in self.health["failed_jobs"]], ["broken"])
        self.assertEqual(self.health["failed_jobs"][0]["streak"], 4)

    def test_stall_boundary_and_long_running(self):
        kinds = {(j["job"], j["kind"]) for j in self.health["stalled"]}
        self.assertIn(("stuck", "예정 시각 지남"), kinds)
        self.assertIn(("ok-job", "실행이 끝나지 않음"), kinds)
        self.assertNotIn("edge", {j["job"] for j in self.health["stalled"]})    # 1시간 59분은 아직
        self.assertNotIn("paused", {j["job"] for j in self.health["stalled"]})

    def test_silent_jobs(self):
        self.assertEqual([j["job"] for j in self.health["silent"]], ["quiet"])

    def test_missing_table_and_broken_file_are_not_zero(self):
        self.assertEqual(self.prof("beta")["exec_status"], "no_incident_table")
        self.assertEqual(self.prof("gamma")["jobs_status"], "error")
        self.assertEqual(self.prof("default")["exec_status"], "no_db")
        self.assertEqual(self.health["totals"]["profiles_ok"], 3)

    def test_secrets_are_redacted(self):
        blob = json.dumps(self.health, ensure_ascii=False)
        for secret in ("abc123secret", "abcdefghijklmnop", "SHOULD_NOT_BE_READ"):
            self.assertNotIn(secret, blob)
        self.assertIn("https://api.x.io/v1", blob)

    def test_redact_patterns(self):
        from aas.common.redact import redact, clean_url
        self.assertEqual(clean_url("https://u:p@h.io:8443/a/b?token=1#f"), "https://h.io:8443/a/b")
        self.assertEqual((clean_url(""), clean_url("   ")), ("", ""))                    # OMAI-1175: 주소가 없으면 「://」 가 아니라 빈 값(자격증명 표의 대상 칸)
        self.assertNotIn("12345", redact("api_key=12345 password: hunter2"))
        self.assertNotIn("hunter2", redact("api_key=12345 password: hunter2"))
        self.assertLessEqual(len(redact("x" * 5000)), 300)

    def test_skill_graph(self):
        from aas.assets import skill_graph
        g = skill_graph.build()
        names = [s["name"] for s in g["skills"]]
        self.assertEqual(sorted(names), ["helper", "report"])              # 백업 디렉터리 제외
        rep = next(s for s in g["skills"] if s["name"] == "report")
        mcp = {m["server"]: m["tools"] for m in rep["mcp"]}
        self.assertEqual(mcp["OMDM"], ["create_page"])
        self.assertEqual(mcp["my-crm"], ["search"])
        hosts = {r["host"] for r in rep["rest"]}
        self.assertEqual(hosts, {"docs.openmaru.io", "api.github.com"})   # 예시 호스트는 제외
        self.assertNotIn("localhost", hosts)
        self.assertEqual(rep["skills"], ["helper"])
        self.assertEqual(rep["scripts"], ["run.py"])
        self.assertEqual([c["job"] for c in rep["cron"]], ["ok-job"])
        blob = json.dumps(g, ensure_ascii=False)
        self.assertNotIn("SECRETVALUE", blob); self.assertNotIn("SHOULD_NOT_BE_READ", blob)
        self.assertEqual(g["mcp_configured"]["default"], ["OMDM", "my-crm"])
        self.assertNotIn("FIXTUREKEY", blob)

    def test_skill_list_row_carries_urls(self):
        # 스킬 목록의 외부 URL 탭이 「호출 URL」 열을 그리도록 목록 행에 URL 을 싣는다(호스트 순)
        from aas.assets import skill_graph
        rep = next(s for s in skill_graph.build()["skills"] if s["name"] == "report")
        row = skill_graph.list_row(rep)
        self.assertEqual(row["n_rest"], len(rep["rest"]))
        self.assertEqual(row["urls"], [u for r in rep["rest"] for u in r["urls"]])
        self.assertTrue(row["urls"] and all(u.startswith("http") for u in row["urls"]))
        self.assertEqual(set(row) - {"urls"}, {"id", "name", "profile", "description", "modified", "origin",
                                              "n_mcp", "n_rest", "n_scripts", "n_cron", "shared_from"})

    def test_models_view_flags_missing_models_and_hides_key(self):
        from unittest import mock
        from aas.ops import models
        gw = {"url": "http://127.0.0.1:14400", "reachable": True, "auth": "ok", "key_source": "프로파일 설정",
              "models": ["m-main", "m-extra"], "error": ""}
        with mock.patch.dict(os.environ, {"AAS_LITELLM_URL": "http://127.0.0.1:14400"}), \
             mock.patch.object(models, "fetch_litellm", return_value=gw) as f:
            d = models.collect({"failed_jobs": [{"profile": "default", "job": "j", "error": "x build_kwargs y"}],
                                "incidents": []})
        self.assertEqual(f.call_args[0], ("sk-FIXTUREKEY123456", "프로파일 설정"))       # 키는 조회에만 쓴다
        self.assertNotIn("FIXTUREKEY", json.dumps(d, ensure_ascii=False))
        p = next(x for x in d["profiles"] if x["name"] == "default")
        self.assertEqual((p["primary"]["model"], [x["model"] for x in p["fallbacks"]]), ("m-main", ["m-gone"]))
        texts = " | ".join(i["text"] for i in p["issues"])
        for needle in ("api_mode `openai`", "폴백 모델 `m-gone`", "보조(vision) 모델 `m-vis`", "m-old", "build_kwargs"):
            self.assertIn(needle, texts)
        self.assertNotIn("주 모델 `m-main`", texts)
        rows = {m["id"]: m for m in d["models"]}
        self.assertEqual((rows["m-gone"]["in_litellm"], rows["m-main"]["primary"], rows["m-extra"]["in_litellm"]),
                         (False, ["default"], True))
        self.assertEqual(d["totals"]["unused_models"], 1)
        self.assertFalse(next(x for x in d["profiles"] if x["name"] == "alpha").get("has_config"))

    def test_channels_view(self):
        import json as _j
        from unittest import mock
        from aas.ops import channels
        a = self.home / "profiles" / "alpha"
        (a / "gateway_state.json").write_text(_j.dumps({"pid": 7, "gateway_state": "running", "platforms": {
            "telegram": {"state": "connected", "writer_pid": 7, "updated_at": iso(minutes=5)},
            "buzz": {"state": "disconnected", "writer_pid": 7, "error_message": "token=abc123secret refused",
                     "needs_attention": True, "retrying_since": iso(days=3)},
            "api_server": {"state": "fatal", "writer_pid": 1, "updated_at": iso(days=40)}}}))
        (a / ".env").write_text("TELEGRAM_BOT_TOKEN=123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef\n")
        svc = {"alpha": {"up": True, "disabled": False, "status": "up"},
               "beta": {"up": False, "disabled": True, "status": "down"}}
        with mock.patch.object(channels, "service_status", return_value=svc):
            d = channels.collect()
        blob = _j.dumps(d, ensure_ascii=False)
        self.assertNotIn("abc123secret", blob); self.assertNotIn("ABCDEFGHIJ", blob)
        al = next(r for r in d["profiles"] if r["name"] == "alpha")
        ps = {p["name"]: p for p in al["platforms"]}
        self.assertTrue(ps["api_server"]["stale"])                       # 다른 pid 가 쓴 옛 기록
        texts = " | ".join(i["text"] for i in al["issues"])
        self.assertIn("buzz 연결 안 됨", texts)
        self.assertIn("buzz 로 보내는 예약 작업 1개", texts)               # stuck(deliver=buzz)
        self.assertNotIn("api_server", texts)
        # 메신저(텔레그램·슬랙 등) 연결 수: 옛 기록(stale)과 api_server(Hermes 자신의 API, 메신저가 아니다)는 센 값에서 뺀다
        self.assertEqual((d["totals"]["messengers_connected"], d["totals"]["messengers_total"]), (1, 2))   # telegram 연결, buzz 끊김
        be = next(r for r in d["profiles"] if r["name"] == "beta")
        self.assertIn("게이트웨이가 꺼져 있음", be["issues"][0]["text"])   # 크론 없음 → 주의만
        self.assertEqual(be["issues"][0]["level"], "warn")

    def test_activity_reads_only_aggregates(self):
        import time as _t
        from aas.ops import activity
        db = sqlite3.connect(self.home / "profiles" / "alpha" / "state.db")
        db.execute("CREATE TABLE sessions (id TEXT, source TEXT NOT NULL, started_at REAL NOT NULL, model TEXT, "
                   "message_count INTEGER, tool_call_count INTEGER, input_tokens INTEGER, output_tokens INTEGER, title TEXT)")
        now = _t.time()
        db.executemany("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?)", [
            ("a", "cron", now - 3600, "m-main", 10, 4, 1000, 50, "비밀 제목"),
            ("b", "telegram", now - 7200, "m-main", 6, 0, 500, 20, "x"),
            ("c", "cron", now - 20 * 86400, "m-old", 99, 9, 9, 9, "오래됨")])
        db.commit(); db.close()
        d = activity.collect(7)
        al = next(p for p in d["profiles"] if p["name"] == "alpha")
        self.assertEqual((al["sessions"], al["messages"], al["input_tokens"], al["total_sessions"]), (2, 16, 1500, 3))
        self.assertEqual({s["source"]: s["sessions"] for s in al["sources"]}, {"cron": 1, "telegram": 1})
        self.assertEqual(next(p for p in d["profiles"] if p["name"] == "beta")["status"], "no_db")
        self.assertNotIn("비밀 제목", json.dumps(d, ensure_ascii=False))
        self.assertEqual(activity.collect(30)["totals"]["sessions"], 3)

    def test_inventories_scope_and_secrets(self):
        import base64, time as _t
        from aas.assets import inventory
        os.environ["AAS_HERMES_COMPOSE_ENV"] = str(self.home / "no-compose-env")   # 실제 호스트 파일을 읽지 않게
        def jwt(exp):
            b = lambda o: base64.urlsafe_b64encode(json.dumps(o).encode()).rstrip(b"=").decode()
            return f"{b({'alg': 'HS256', 'typ': 'JWT'})}.{b({'exp': exp, 'sub': 'x'})}.signaturesignature"
        sec = self.home / "secrets"; sec.mkdir(exist_ok=True)
        soon = jwt(_t.time() + 3 * 86400 + 3600)
        (sec / "omdm.json").write_text(json.dumps({"base_url": "https://wiki.example.org/api?x=1", "token": soon}))
        (sec / "omdm.json.bak-old").write_text(json.dumps({"token": jwt(_t.time() - 86400)}))
        (self.home / ".env").write_text("SHARED_API_KEY=supersecretvalue123\nEMPTY_TOKEN=\nPLAIN_SETTING=1\n")
        (self.home / "profiles" / "alpha" / ".env").write_text("SHARED_API_KEY=supersecretvalue123\nTELEGRAM_BOT_TOKEN=123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef\n")
        scripts = self.home / "scripts"; scripts.mkdir(exist_ok=True)
        (scripts / "pull.py").write_text('"""지표를 끌어온다."""\nimport os, requests\nimport helper\nK = os.environ["SHARED_API_KEY"]\nopen("/opt/data/secrets/omdm.json")\n')
        (scripts / "helper.py").write_text("import json\n")
        (scripts / "orphan.sh").write_text("#!/bin/sh\n# 아무도 안 부른다\necho hi\n")
        sp = self.home / ".venvs" / "x" / "lib" / "python3.13" / "site-packages"
        (sp / "requests-2.33.0.dist-info").mkdir(parents=True)
        (sp / "PyYAML-6.0.dist-info").mkdir(); (sp / "PyYAML-6.0.dist-info" / "top_level.txt").write_text("yaml\n")
        sp2 = self.home / "profiles" / "alpha" / "home" / ".local" / "lib" / "python3.13" / "site-packages"
        (sp2 / "requests-2.34.2.dist-info").mkdir(parents=True)

        c = inventory.credentials(self.home)
        blob = json.dumps(c, ensure_ascii=False)
        for secret in ("supersecretvalue123", "ABCDEFGHIJKLMNOP", soon, "signaturesignature", "SHOULD_NOT_BE_READ", "sk-FIXTUREKEY"):
            self.assertNotIn(secret, blob)
        by = {(i["profile"], i["name"]): i for i in c["items"]}
        self.assertNotIn(("", "PLAIN_SETTING"), by)                                   # 비밀이 아닌 설정은 싣지 않는다
        self.assertEqual((by[("", "SHARED_API_KEY")]["scope"], by[("alpha", "SHARED_API_KEY")]["scope"]), ("전역", "프로파일"))
        self.assertEqual(by[("", "SHARED_API_KEY")]["shared_group"], by[("alpha", "SHARED_API_KEY")]["shared_group"])
        self.assertIn("스크립트 pull.py", by[("", "SHARED_API_KEY")]["used_by"])
        self.assertIn("비어 있음", by[("", "EMPTY_TOKEN")]["flags"])
        self.assertEqual(by[("alpha", "TELEGRAM_BOT_TOKEN")]["interface"], "채널")
        om = by[("", "omdm.json")]
        self.assertEqual((om["target"], om["flags"][0], om["used_by"]), ("https://wiki.example.org/api", "3일 뒤 만료", ["스크립트 pull.py"]))
        self.assertTrue({"백업·임시 파일", "만료됨"} <= set(by[("", "omdm.json.bak-old")]["flags"]))

        # 프로파일 사본은 루트 정본의 참조를 물려받지 않는다 — 경로가 그 사본을 가리킬 때만 센다
        psec = self.home / "profiles" / "alpha" / "secrets"; psec.mkdir(exist_ok=True)
        (psec / "omdm.json").write_text(json.dumps({"token": jwt(_t.time() - 86400)}))
        by = {(i["profile"], i["name"]): i for i in inventory.credentials(self.home)["items"]}
        self.assertEqual((by[("alpha", "omdm.json")]["used_count"], by[("", "omdm.json")]["used_by"]), (0, ["스크립트 pull.py"]))
        self.assertIn("쓰는 곳을 찾지 못함", by[("alpha", "omdm.json")]["flags"])
        (scripts / "alpha_only.py").write_text('open("/opt/data/profiles/alpha/secrets/omdm.json")\n# omdm.json.bak-old 는 옛 키\n')
        by = {(i["profile"], i["name"]): i for i in inventory.credentials(self.home)["items"]}
        self.assertEqual((by[("alpha", "omdm.json")]["used_by"], by[("", "omdm.json")]["used_by"]), (["스크립트 alpha_only.py"], ["스크립트 pull.py"]))
        (scripts / "alpha_only.py").unlink(); (psec / "omdm.json").unlink()
        self.assertTrue(any(i["interface"] == "MCP: OMDM" for i in c["items"]))

        t = {i["name"]: i for i in inventory.tools(self.home)["items"]}
        self.assertEqual((t["pull.py"]["language"], t["pull.py"]["imports"], t["pull.py"]["summary"]), ("Python", ["requests"], "지표를 끌어온다."))
        self.assertIn("부르는 곳을 찾지 못함", t["orphan.sh"]["flags"])
        self.assertEqual(t["run.py"]["kind"], "스킬 내부 스크립트")

        l = inventory.libraries(self.home)
        req = [i for i in l["items"] if i["name"] == "requests"]
        self.assertEqual({(i["scope"], i["version"]) for i in req}, {("전역", "2.33.0"), ("프로파일", "2.34.2")})
        self.assertTrue(all(i["used_count"] >= 1 and any("버전이 다름" in f for f in i["flags"]) for i in req))
        self.assertEqual(next(i for i in l["items"] if i["name"] == "PyYAML")["used_count"], 0)

        key = by[("", "SHARED_API_KEY")]["id"]
        inventory.register("credential", key, "review", "yj", "LiteLLM 키")
        again = {i["id"]: i for i in inventory.credentials(self.home)["items"]}
        self.assertEqual((again[key]["reg"]["status"], again[key]["reg"]["owner"]), ("review", "yj"))
        inventory.register("credential", key, "none")
        self.assertIsNone({i["id"]: i for i in inventory.credentials(self.home)["items"]}[key]["reg"])
        with self.assertRaises(ValueError):
            inventory.register("credential", key, "bogus")


    def test_credentials_names_the_pattern_of_listed_keys(self):
        """화면이 「이 이름은 표에 나타나지 않습니다」 경고를 서버와 같은 식으로 하게, 표가 쓰는 이름 규칙을 응답에 싣는다(스펙 2026-10-14-025 D9)."""
        import re
        from aas.assets import inventory
        os.environ["AAS_HERMES_COMPOSE_ENV"] = str(self.home / "no-compose-env")
        pat = inventory.credentials(self.home)["name_pattern"]
        self.assertEqual(pat, inventory._SECRET_KEY.pattern)
        rx = re.compile(pat, re.I)
        for listed in ("SHARED_API_KEY", "TELEGRAM_BOT_TOKEN", "my_password", "WEBHOOK_URL"):
            self.assertTrue(rx.search(listed), listed)
        for hidden in ("LAW_OC", "PLAIN_SETTING", "TZ"):
            self.assertFalse(rx.search(hidden), hidden)

    def test_store_tracks_closed_incidents_only_for_readable_profiles(self):
        from aas.common import store
        store.record_snapshot(self.health)
        later = json.loads(json.dumps(self.health))
        later["collected_at"] = (NOW + timedelta(hours=1)).isoformat()
        later["incidents"] = [i for i in later["incidents"] if i["id"] != "i1"]
        store.record_snapshot(later)
        with store.connect() as conn:
            rows = {r["incident_id"]: r["closed_seen_at"] for r in conn.execute("SELECT * FROM incident_seen")}
        self.assertIsNotNone(rows["i1"]); self.assertIsNone(rows["i2"])
        broken = json.loads(json.dumps(later))
        broken["collected_at"] = (NOW + timedelta(hours=2)).isoformat()
        broken["incidents"] = []
        for p in broken["profiles"]:
            p["exec_status"] = "error"
        store.record_snapshot(broken)
        with store.connect() as conn:
            self.assertIsNone(conn.execute("SELECT closed_seen_at c FROM incident_seen "
                                           "WHERE incident_id='i2'").fetchone()["c"])
        self.assertEqual(store.baseline_ts(), self.health["collected_at"])

    def test_snapshot_splits_open_incidents_and_weekly_shows_it(self):
        from aas.ops import evaluate, mutes
        from aas.common import store
        h = json.loads(json.dumps(self.health))
        states = ["failing", "ok"]
        for n, inc in enumerate(h["incidents"]):
            inc["now"] = states[n % 2]
        store.record_snapshot(h)
        t = store.totals_at(h["collected_at"])
        fail = sum(1 for i in h["incidents"] if i["now"] == "failing")
        self.assertEqual((t["live_incidents"], t["settled_incidents"], t["muted_incidents"]),
                         (fail, len(h["incidents"]) - fail, 0))
        first = next(i for i in h["incidents"] if i["now"] == "failing")
        mutes.mute(first["profile"], first["job_id"], first["job"], "시험", "t")
        later = json.loads(json.dumps(h))
        later["collected_at"] = (NOW + timedelta(hours=3)).isoformat()
        store.record_snapshot(later)
        t2 = store.totals_at(later["collected_at"])
        gone = sum(1 for i in h["incidents"] if (i["profile"], i["job_id"]) == (first["profile"], first["job_id"]))
        self.assertEqual(t2["muted_incidents"], gone)
        self.assertEqual(t2["live_incidents"] + t2["settled_incidents"] + gone, len(h["incidents"]))
        self.assertEqual(t2["open_incidents"], t["open_incidents"])      # 원래 숫자는 그대로 남는다
        md = evaluate.weekly_md()
        self.assertIn("지금도 실패", md)
        mutes.unmute(first["profile"], first["job_id"])

    def test_hermes_files_untouched(self):
        import hashlib
        files = sorted(p for p in self.home.rglob("*") if p.is_file())
        before = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
        from aas.ops import cron_health
        from aas.assets import skill_graph
        cron_health.collect(now=NOW); skill_graph.build()
        after_files = sorted(p for p in self.home.rglob("*") if p.is_file())
        self.assertEqual(files, after_files)                                # -wal/-shm 도 생기지 않는다
        self.assertEqual(before, {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in files})


if __name__ == "__main__":
    unittest.main()
