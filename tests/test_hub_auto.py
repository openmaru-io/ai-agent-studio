# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""오피스 칸반·크론 시험 — 설치본 둘의 가짜 Hermes 대시보드를 붙여, AAS 오피스 API(hub_auto.route)로 되는지 본다."""
import json
import os
import re
import tempfile
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.office import hub_auto, office, relay  # noqa: E402
from aas.hermes.hermes_api import HermesError  # noqa: E402
from aas.fleet.pods import Pod  # noqa: E402


class FakeDash:
    """설치본 하나의 Hermes 대시보드(칸반·크론)를 흉내 낸다."""

    def __init__(self, name):
        self.name, self.boards, self.jobs, self.calls, self.n, self.down = name, {}, {}, [], 0, False

    def call(self, method, path, body=None, query=None):
        if self.down:
            raise HermesError("연결할 수 없습니다", 503)
        q = {k: v for k, v in (query or {}).items() if v not in (None, "")}
        self.calls.append((method, path, body, q))
        if path.startswith("/api/cron"):
            return self.cron(method, path[len("/api/cron"):], body or {}, q)
        p = path[len("/api/plugins/kanban"):]
        if p == "/boards" and method == "POST":
            self.boards.setdefault(body["slug"], {"name": body.get("name"), "tasks": {}, "comments": {}})
            return {"board": {"slug": body["slug"]}, "current": "default"}
        m = re.fullmatch(r"/boards/([^/]+)", p)
        if m:
            self.boards[m.group(1)]["name"] = body.get("name")
            return {"board": {}}
        b = self.boards.get(q.get("board"))
        if b is None:
            raise HermesError("board not found", 404)
        if p == "/board":
            cols = ["triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done"] + (["archived"] if q.get("include_archived") else [])
            return {"columns": [{"name": c, "tasks": [t for t in b["tasks"].values() if t["status"] == c]} for c in cols], "tenants": [], "assignees": []}
        if p == "/tasks" and method == "POST":
            self.n += 1
            tid = f"t_{self.name}{self.n}"
            b["tasks"][tid] = {"id": tid, "title": body["title"], "body": body.get("body"), "assignee": body.get("assignee"), "status": "triage" if body.get("triage") else ("ready" if body.get("assignee") else "todo"),
                               "priority": body.get("priority", 0), "created_at": 1000 + self.n, "link_counts": {"parents": 0, "children": 0}}
            return {"task": b["tasks"][tid]}
        if p == "/dispatch":
            out = []
            for t in b["tasks"].values():
                if t["status"] == "ready" and t["assignee"]:
                    t["status"] = "running"
                    out.append([t["id"], t["assignee"], "/ws"])
            return {"spawned": out, "reclaimed": 0}
        if p == "/tasks/bulk":
            for tid in body["ids"]:
                b["tasks"][tid]["status"] = "archived"
            return {"ok": True}
        m = re.fullmatch(r"/tasks/([^/]+)(/[a-z]+)?", p)
        t = b["tasks"].get(m.group(1)) if m else None
        if t is None:
            raise HermesError("task not found", 404)
        sub = m.group(2)
        if not sub and method == "GET":
            return {"task": t, "comments": b["comments"].get(t["id"], []), "events": [{"id": 1, "kind": "created", "payload": {}, "created_at": 1}],
                    "attachments": [], "links": {"parents": [], "children": []}, "child_results": [], "runs": [{"id": 1, "profile": t["assignee"], "status": "done"}]}
        if not sub and method == "PATCH":
            t.update({k: v for k, v in body.items() if k in ("title", "body", "assignee", "status", "priority")})
            return {"task": t}
        if not sub and method == "DELETE":
            del b["tasks"][t["id"]]
            return {"ok": True}
        if sub == "/comments":
            b["comments"].setdefault(t["id"], []).append({"id": len(b["comments"].get(t["id"], [])) + 1, "author": body["author"], "body": body["body"], "created_at": 5})
            return {"ok": True}
        if sub == "/reassign":
            t["assignee"] = body["profile"]
            return {"ok": True}
        if sub == "/reclaim":
            if t["status"] != "running":
                raise HermesError("cannot reclaim", 409)
            t["status"] = "ready"
            return {"ok": True}
        if sub == "/log":
            return {"exists": True, "size_bytes": 3, "content": "log", "truncated": False, "path": "/opt/data/x"}
        raise HermesError("nope", 404)

    def cron(self, method, p, body, q):
        prof = q.get("profile")
        if p == "/delivery-targets":
            return {"targets": [{"id": "local", "name": "Local", "home_target_set": True, "home_env_var": None}]}
        if p == "/jobs" and method == "GET":
            return {"jobs": [j for j in self.jobs.values() if j["profile"] == prof]}
        if p == "/jobs" and method == "POST":
            if body["schedule"] == "nonsense":
                raise HermesError("Invalid schedule 'nonsense'", 400)
            jid = f"j{len(self.jobs) + 1}"
            self.jobs[jid] = {"id": jid, "name": body["name"], "prompt": body["prompt"], "schedule": {"kind": "cron", "expr": body["schedule"], "display": body["schedule"]},
                              "enabled": True, "state": "scheduled", "deliver": body["deliver"], "profile": prof, "hermes_home": "/opt/data/secret-path",
                              "next_run_at": "2026-10-07T09:00:00+09:00", "latest_execution": None}
            return {"job": self.jobs[jid]}
        m = re.fullmatch(r"/jobs/([^/]+)(/[a-z]+)?", p)
        j = self.jobs.get(m.group(1))
        if j is None or j["profile"] != prof:
            raise HermesError("Job not found", 404)
        sub = m.group(2)
        if sub == "/pause":
            j.update(state="paused", enabled=False)
        elif sub == "/resume":
            j.update(state="scheduled", enabled=True)
        elif sub == "/trigger":
            j["latest_execution"] = {"id": "e1", "status": "running"}
        elif sub == "/runs":
            return {"runs": [{"id": "cron_j1_x", "started_at": 1.0, "ended_at": 31.0, "title": "아침 보고", "system_prompt": "SECRET PROMPT"}]}
        elif method == "PUT":
            j.update({k: v for k, v in body["updates"].items() if k != "schedule"})
        elif method == "DELETE":
            del self.jobs[j["id"]]
            return {"ok": True}
        return {"job": j}


class Reg:
    pods = [Pod("yj", "a@x.com", Path("/nonexistent")), Pod("scdf", "a@x.com", Path("/nonexistent"))]


KNOWN = {"yj": {"sa", "ma"}, "scdf": {"scdf-doc", "sa"}}
B = "office-0123456789abcdef0123456789abcdef"


class AutoTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dash = {"yj": FakeDash("yj"), "scdf": FakeDash("scdf")}
        cls.bridge = relay.Bridge(Reg(), lambda pod: None)
        cls.auto = hub_auto.Auto(cls.bridge, lambda pod: cls.dash[pod])
        with hub_auto._db() as conn:
            for t in ("office_seats", "office_boards", "office_board_pods", "office_cards", "office_events", "office_cron"):
                conn.execute(f"DELETE FROM {t}")
        office.set_seat({"pod": "yj", "profile": "sa"}, "me", KNOWN)
        office.set_seat({"pod": "yj", "profile": "ma"}, "me", KNOWN)
        office.set_seat({"pod": "scdf", "profile": "scdf-doc"}, "me", KNOWN)
        office.set_seat({"pod": "scdf", "profile": "sa", "alias": "scdf-sa"}, "me", KNOWN)
        cls.bridge.routes(0)

    def call(self, method, path, body=None):
        """서버가 하는 일을 그대로: 경로·질의를 나눠 route 에 넘기고, 거절(Fail)은 {"error","detail"} 본문으로 바꾼다."""
        url = urlsplit(path)
        try:
            return hub_auto.route(self.auto, method, url.path, parse_qs(url.query), body or {})
        except hub_auto.Fail as exc:
            return exc.status, {"error": exc.code, "detail": exc.detail}

    def test_2_board_spans_installs(self):
        self.assertEqual(self.call("GET", f"/api/office/kanban/board?board={B}")[0], 404)
        self.assertEqual(self.call("GET", "/api/office/kanban/board")[1]["error"], "board_required")
        st, res = self.call("POST", "/api/office/kanban/boards", {"slug": B, "name": "오픈마루 오피스"})
        self.assertEqual((st, res["board"]["name"], res["board"]["total"]), (201, "오픈마루 오피스", 0))
        self.assertEqual(self.call("POST", "/api/office/kanban/boards", {"slug": B, "name": "다른 이름"})[0], 200)      # 다시 만들어도 그대로
        self.assertIn(B, self.dash["yj"].boards)
        self.assertNotIn(B, self.dash["scdf"].boards)                                  # 카드가 갈 때 만든다
        cur = self.call("GET", f"/api/office/events?board={B}")[1]["cursor"]
        view = self.call("GET", f"/api/office/kanban/board?board={B}")[1]
        self.assertEqual([c["name"] for c in view["columns"]], list(hub_auto.COLUMNS))
        st, a = self.call("POST", f"/api/office/kanban/tasks?board={B}", {"title": "견적서 초안", "assignee": "sa", "priority": "2"})
        self.assertEqual((st, a["task"]["assignee"], a["task"]["status"]), (201, "sa", "ready"))
        st, b = self.call("POST", f"/api/office/kanban/tasks?board={B}", {"title": "백서 목차", "assignee": "scdf-doc"})
        st, c = self.call("POST", f"/api/office/kanban/tasks?board={B}", {"title": "SCDF 영업 메모", "assignee": "scdf-sa"})
        self.assertEqual(c["task"]["assignee"], "scdf-sa")                              # 다른 이름으로 앉은 자리도 그 이름으로 보인다
        self.assertEqual(self.dash["scdf"].boards[B]["tasks"][c["task"]["id"]]["assignee"], "sa")
        self.assertEqual(self.call("POST", f"/api/office/kanban/tasks?board={B}", {"title": "x", "assignee": "ghost"})[1]["error"], "profile_not_found")
        view = self.call("GET", f"/api/office/kanban/board?board={B}")[1]
        ready = next(col["tasks"] for col in view["columns"] if col["name"] == "ready")
        self.assertEqual({t["assignee"] for t in ready}, {"sa", "scdf-doc", "scdf-sa"})
        self.assertEqual(view["assignees"], ["sa", "scdf-doc", "scdf-sa"])
        ev = self.call("GET", f"/api/office/events?board={B}&cursor={cur}")[1]
        self.assertEqual([e["kind"] for e in ev["events"]], ["task.created"] * 3)
        self.assertEqual(self.call("GET", f"/api/office/events?board={B}&cursor=bogus")[1]["error"], "unknown_cursor")
        self.assertEqual(self.call("GET", f"/api/office/events?board={B}&cursor=v1.999999")[0], 400)
        type(self).ids, type(self).cur = (a["task"]["id"], b["task"]["id"]), ev["cursor"]

    def test_3_run_and_finish_make_events(self):
        a, b = self.ids
        res = self.call("POST", f"/api/office/kanban/dispatch?board={B}", {})[1]
        self.assertEqual({(s["task_id"], s["profile"]) for s in res["spawned"]} >= {(a, "sa"), (b, "scdf-doc")}, True)
        ev = self.call("GET", f"/api/office/events?board={B}&cursor={self.cur}")[1]
        started = [e for e in ev["events"] if e["kind"] == "task.run.started"]
        self.assertEqual({e["payload"]["assignee"] for e in started}, {"sa", "scdf-doc", "scdf-sa"})
        self.dash["scdf"].boards[B]["tasks"][b]["status"] = "done"                     # 워커가 끝냈다
        self.auto.sync(B, force=True)
        ev2 = self.call("GET", f"/api/office/events?board={B}&cursor={ev['cursor']}")[1]
        kinds = [(e["kind"], e["task_id"]) for e in ev2["events"]]
        self.assertEqual(kinds, [("task.run.finished", b), ("task.status", b)])
        self.assertEqual(ev2["events"][1]["payload"], {"from": "running", "to": "done", "parent_count": 0, "title": "백서 목차", "assignee": "scdf-doc"})
        self.assertEqual(self.call("PATCH", f"/api/office/kanban/tasks/{a}?board={B}", {"status": "running"})[1]["error"], "invalid_transition")
        self.assertEqual(self.call("POST", f"/api/office/kanban/tasks/{a}/terminate?board={B}", {})[0], 200)
        self.assertEqual(self.call("POST", f"/api/office/kanban/tasks/{a}/terminate?board={B}", {})[1]["error"], "no_active_run")

    def test_3c_card_table_change_calls_the_hook_once(self):
        # 카드 표가 바뀌었을 때만 화면 토픽(office:cards·받은편지함)을 다시 읽게 한다(스펙 2026-10-17-004 D10)
        _a, b = self.ids
        calls = []
        hub_auto.ON_CARDS_CHANGED.append(lambda: calls.append(1))
        try:
            self.auto.sync(B, force=True)
            calls.clear()
            self.auto.sync(B, force=True)                                          # 바뀐 것이 없다
            self.assertEqual(calls, [])
            self.dash["scdf"].boards[B]["tasks"][b]["title"] = "백서 목차(고침)"
            self.auto.sync(B, force=True)
            self.assertEqual(calls, [1])
        finally:
            hub_auto.ON_CARDS_CHANGED.pop()

    def test_4b_detail_masks_secret_shapes_but_keeps_lines(self):
        """OMAI-1172 R3·R7: 에이전트가 쓴 실행 요약·오류, 댓글, 이벤트 사유의 토큰 모양은 줄마다 가리고 줄바꿈은 그대로 둔다."""
        tid = self.call("POST", f"/api/office/kanban/tasks?board={B}", {"title": "R3 시험 카드", "assignee": "scdf-doc"})[1]["task"]["id"]
        secret_bearer = "Bearer " + "a1B2c3D4e5F6g7H8i9J0"
        secret_gh = "ghp_" + "Z9y8X7w6V5u4T3s2R1q0"
        dash = self.dash["scdf"]
        orig = dash.call

        def patched(method, path, body=None, query=None):
            out = orig(method, path, body, query)
            if method == "GET" and re.fullmatch(r"/api/plugins/kanban/tasks/[^/]+", path):
                out = dict(out)
                out["runs"] = [{"id": 7, "profile": "sa", "status": "blocked", "outcome": "blocked", "started_at": 5,
                                "summary": f"첫 줄은 그대로\n호출 머리 {secret_bearer}\n마지막 줄", "error": f"토큰 {secret_gh} 로 실패\r\n다음 줄"}]
                out["comments"] = [{"id": 1, "author": "ma", "body": f"키는 {secret_gh} 입니다\n두 번째 줄", "created_at": 5}]
                out["events"] = [{"id": 1, "kind": "blocked", "payload": {"reason": f"{secret_bearer} 필요\n자세히", "attempt": 2}, "created_at": 1},
                                 {"id": 2, "kind": "created", "payload": {}, "created_at": 1}]
            return out

        dash.call = patched
        try:
            d = self.call("GET", f"/api/office/kanban/tasks/{tid}?board={B}")[1]
        finally:
            dash.call = orig
        run = d["runs"][0]
        self.assertEqual(run["summary"], "첫 줄은 그대로\n호출 머리 Bearer «가림»\n마지막 줄")
        self.assertEqual(run["error"], "토큰 «가림» 로 실패\r\n다음 줄")                      # 줄바꿈 문자(\r\n)가 그대로 남는다
        self.assertEqual((run["id"], run["outcome"], run["profile"]), (7, "blocked", "scdf-sa"))   # 다른 필드와 프로파일→별칭 변환은 그대로
        self.assertEqual(d["comments"][0]["body"], "키는 «가림» 입니다\n두 번째 줄")
        self.assertEqual(d["events"][0]["payload"], {"reason": "Bearer «가림» 필요\n자세히", "attempt": 2})
        self.assertEqual(d["events"][1]["payload"], {})                                    # 사유가 없는 이벤트는 그대로
        self.assertNotIn(secret_gh, json.dumps(d, ensure_ascii=False))
        self.assertNotIn(secret_bearer, json.dumps(d, ensure_ascii=False))

    def test_4c_detail_leaves_plain_and_non_string_values_alone(self):
        """가리기는 문자열 필드에만 적용된다. 요약이 없거나 문자열이 아니어도 깨지지 않고, 평범한 글은 바뀌지 않는다."""
        tid = self.call("POST", f"/api/office/kanban/tasks?board={B}", {"title": "R3 평문 시험 카드", "assignee": "scdf-doc"})[1]["task"]["id"]
        dash = self.dash["scdf"]
        orig = dash.call

        def patched(method, path, body=None, query=None):
            out = orig(method, path, body, query)
            if method == "GET" and re.fullmatch(r"/api/plugins/kanban/tasks/[^/]+", path):
                out = dict(out)
                out["runs"] = [{"id": 1, "profile": "sa", "outcome": "completed", "summary": "결과: 2", "error": None}, {"id": 2, "profile": "sa", "summary": 5}, "not-a-dict"]
                out["comments"] = [{"id": 1, "author": "ma", "body": "표도 넣어 주세요"}, {"id": 2, "author": "ma"}, "not-a-dict"]
                out["events"] = [{"id": 1, "payload": {"reason": 7}}, {"id": 2, "payload": "text"}, {"id": 3}, "not-a-dict"]
            return out

        dash.call = patched
        try:
            d = self.call("GET", f"/api/office/kanban/tasks/{tid}?board={B}")[1]
        finally:
            dash.call = orig
        self.assertEqual([r.get("summary") for r in d["runs"]], ["결과: 2", 5])               # dict 가 아닌 실행은 서버가 이미 걸러 낸다
        self.assertIsNone(d["runs"][0]["error"])
        self.assertEqual(d["comments"][0]["body"], "표도 넣어 주세요")
        self.assertNotIn("body", d["comments"][1])
        self.assertEqual(d["events"][0]["payload"], {"reason": 7})
        self.assertEqual(d["events"][1]["payload"], "text")

    def test_4c2_detail_comment_author_profile_becomes_alias(self):
        """댓글 작성자가 Hermes 프로파일(예: main)이면 실행 기록처럼 자리 별칭으로 바꾼다. 자리가 아닌 이름(aas·다른 설치본의 프로파일)은 그대로."""
        tid = self.call("POST", f"/api/office/kanban/tasks?board={B}", {"title": "작성자 시험 카드", "assignee": "scdf-doc"})[1]["task"]["id"]
        dash = self.dash["scdf"]
        orig = dash.call

        def patched(method, path, body=None, query=None):
            out = orig(method, path, body, query)
            if method == "GET" and re.fullmatch(r"/api/plugins/kanban/tasks/[^/]+", path):
                out = dict(out)
                out["comments"] = [{"id": 1, "author": "sa", "body": "a"}, {"id": 2, "author": "aas", "body": "b"}, {"id": 3, "author": "ma", "body": "c"}, {"id": 4, "body": "d"}]
            return out

        dash.call = patched
        try:
            d = self.call("GET", f"/api/office/kanban/tasks/{tid}?board={B}")[1]
        finally:
            dash.call = orig
        self.assertEqual([c.get("author") for c in d["comments"]], ["scdf-sa", "aas", "ma", None])

    def test_4d_task_object_masks_agent_written_fields_in_board_and_detail(self):
        """OMAI-1172 T5 에서 발견: 카드 객체의 latest_summary·result·block_reason 도 에이전트가 쓴 글이라 보드 목록·상세·만들기 응답에서 가린다. 사람이 쓴 title·body 는 그대로."""
        secret = "ghp_" + "Q9w8E7r6T5y4U3i2O1p0"
        c = self.call("POST", f"/api/office/kanban/tasks?board={B}", {"title": "R3 카드 객체 시험", "body": f"사람이 쓴 본문 {secret}", "assignee": "scdf-doc"})[1]["task"]
        task = self.dash["scdf"].boards[B]["tasks"][c["id"]]
        task.update(latest_summary=f"요약\n키 {secret}\n끝", result=f"결과 {secret}", block_reason=f"사유 {secret}")
        detail = self.call("GET", f"/api/office/kanban/tasks/{c['id']}?board={B}")[1]["task"]
        view = self.call("GET", f"/api/office/kanban/board?board={B}")[1]
        listed = next(t for col in view["columns"] for t in col["tasks"] if t["id"] == c["id"])
        for out in (detail, listed):
            self.assertEqual(out["latest_summary"], "요약\n키 «가림»\n끝")
            self.assertEqual((out["result"], out["block_reason"]), ("결과 «가림»", "사유 «가림»"))
            self.assertEqual(out["body"], f"사람이 쓴 본문 {secret}")                   # 사람이 쓴 글은 그대로
            self.assertEqual(out["title"], "R3 카드 객체 시험")

    def test_4b_unassigned_triage_card_follows_new_assignee_to_other_install(self):
        """담당 없이 만든 카드는 기본 설치본(yj)에 생긴다. 다른 설치본의 에이전트로 담당을 바꾸면 카드가 그 설치본으로 옮겨 간다(OMAI-1187 후속)."""
        st, c = self.call("POST", f"/api/office/kanban/tasks?board={B}", {"title": "사무실 소개해줘", "body": "본문", "priority": "1"})
        old = c["task"]["id"]
        self.assertEqual((st, c["task"]["status"], c["task"]["assignee"]), (201, "triage", None))
        self.assertIn(old, self.dash["yj"].boards[B]["tasks"])
        self.call("POST", f"/api/office/kanban/tasks/{old}/comments?board={B}", {"author": "kim", "body": "참고 메모"})
        st, r = self.call("POST", f"/api/office/kanban/tasks/{old}/reassign?board={B}", {"profile": "scdf-doc"})
        self.assertEqual(st, 200, r)
        new = r["task"]
        self.assertNotEqual(new["id"], old)                                           # 설치본이 바뀌면 카드 번호도 바뀐다
        self.assertEqual((new["assignee"], new["status"], new["title"], new["body"], new["priority"]), ("scdf-doc", "triage", "사무실 소개해줘", "본문", 1))
        self.assertNotIn(old, self.dash["yj"].boards[B]["tasks"])                     # 옛 카드는 지운다(복사본이 둘 남지 않는다)
        self.assertIn(new["id"], self.dash["scdf"].boards[B]["tasks"])
        self.assertEqual([x["body"] for x in self.dash["scdf"].boards[B]["comments"][new["id"]]], ["참고 메모"])   # 댓글은 옮긴다
        self.assertEqual(self.call("GET", f"/api/office/kanban/tasks/{new['id']}?board={B}")[0], 200)
        self.assertEqual(self.call("GET", f"/api/office/kanban/tasks/{old}?board={B}")[1]["error"], "task_not_found")

    def test_4e_detail_attachments_hide_stored_path_newest_first(self):
        """카드 상세의 첨부(스펙 office/kanban-card-structured-brief §3-9, R6): Hermes 카드 상세의 값을 쓰고 stored_path 는 내보내지 않는다.
        최근 것부터. 올린 프로파일은 자리 이름으로. Hermes 답에 attachments 가 없거나 목록이 아니면 빈 목록."""
        tid = self.call("POST", f"/api/office/kanban/tasks?board={B}", {"title": "첨부 시험 카드", "assignee": "scdf-sa"})[1]["task"]["id"]
        dash = self.dash["scdf"]
        orig = dash.call
        state = {"attachments": [
            {"id": 3, "task_id": tid, "filename": "old.txt", "content_type": "text/plain", "size": 3, "uploaded_by": "sa", "stored_path": "/opt/data/kanban/a/old.txt", "created_at": 100},
            {"id": 5, "task_id": tid, "filename": "new.md", "content_type": "text/markdown", "size": 9, "uploaded_by": "dashboard", "stored_path": "/opt/data/kanban/a/new.md", "created_at": 200},
            {"id": 4, "task_id": tid, "filename": "same-time.csv", "content_type": "text/csv", "size": 1, "uploaded_by": None, "stored_path": "/x", "created_at": 100},
            "not-a-dict"]}

        def patched(method, path, body=None, query=None):
            out = orig(method, path, body, query)
            if method == "GET" and re.fullmatch(r"/api/plugins/kanban/tasks/[^/]+", path):
                out = dict(out)
                if "attachments" in state:
                    out["attachments"] = state["attachments"]
                else:
                    out.pop("attachments", None)
            return out

        dash.call = patched
        try:
            d = self.call("GET", f"/api/office/kanban/tasks/{tid}?board={B}")[1]
            self.assertEqual([a["id"] for a in d["attachments"]], [5, 4, 3])                 # 시각이 같으면 번호가 큰 것이 먼저
            for a in d["attachments"]:
                self.assertEqual(set(a), {"id", "filename", "size", "content_type", "uploaded_by", "created_at"})
            self.assertNotIn("/opt/data", json.dumps(d))
            self.assertEqual(d["attachments"][2]["uploaded_by"], "scdf-sa")                  # 설치본 scdf 의 프로파일 sa → 자리 이름
            self.assertEqual(d["attachments"][0]["uploaded_by"], "dashboard")
            state.pop("attachments")
            self.assertEqual(self.call("GET", f"/api/office/kanban/tasks/{tid}?board={B}")[1]["attachments"], [])
            state["attachments"] = {"id": 1}
            self.assertEqual(self.call("GET", f"/api/office/kanban/tasks/{tid}?board={B}")[1]["attachments"], [])
        finally:
            dash.call = orig

    def test_4f_attachment_from_kanban_complete_shows_the_runner(self):
        """에이전트가 완료 때 올린 첨부는 Hermes 가 uploaded_by 를 kanban_complete 로 적는다. 화면이 에이전트 칩으로 보이므로
        그 시각까지 시작한 가장 최근 실행의 프로파일(자리 이름)로, 실행이 없으면 카드 담당으로 바꾼다(OKE 확인 2026-10-18, §8-4)."""
        tid = self.call("POST", f"/api/office/kanban/tasks?board={B}", {"title": "완료 첨부 카드", "assignee": "scdf-sa"})[1]["task"]["id"]
        dash = self.dash["scdf"]
        orig = dash.call
        state = {"runs": [{"id": 1, "profile": "other", "started_at": 50, "status": "done"},
                          {"id": 2, "profile": "sa", "started_at": 150, "status": "done"}]}
        atts = [{"id": 1, "filename": "early.md", "uploaded_by": "kanban_complete", "created_at": 60},
                {"id": 2, "filename": "hello.md", "uploaded_by": "kanban_request_review", "created_at": 160}]

        def patched(method, path, body=None, query=None):
            out = orig(method, path, body, query)
            if method == "GET" and re.fullmatch(r"/api/plugins/kanban/tasks/[^/]+", path):
                out = {**out, "attachments": atts, "runs": state["runs"]}
            return out

        dash.call = patched
        try:
            by = {a["filename"]: a["uploaded_by"] for a in self.call("GET", f"/api/office/kanban/tasks/{tid}?board={B}")[1]["attachments"]}
            self.assertEqual(by, {"hello.md": "scdf-sa", "early.md": "other"})
            state["runs"] = []
            by = {a["filename"]: a["uploaded_by"] for a in self.call("GET", f"/api/office/kanban/tasks/{tid}?board={B}")[1]["attachments"]}
            self.assertEqual(by, {"hello.md": "scdf-sa", "early.md": "scdf-sa"})              # 실행이 없으면 카드 담당
        finally:
            dash.call = orig

    def test_4_detail_comment_actions(self):
        a, b = self.ids
        d = self.call("GET", f"/api/office/kanban/tasks/{b}?board={B}")[1]
        self.assertEqual(set(d), {"task", "comments", "events", "attachments", "links", "runs"})
        self.assertEqual(d["attachments"], [])
        self.assertEqual(d["runs"][0]["profile"], "scdf-doc")
        st, c = self.call("POST", f"/api/office/kanban/tasks/{b}/comments?board={B}", {"author": "김", "body": "표도 넣어 주세요"})
        self.assertEqual((st, c["comment"]["body"]), (201, "표도 넣어 주세요"))
        st, r = self.call("POST", f"/api/office/kanban/tasks/{a}/reassign?board={B}", {"profile": "scdf-doc", "reclaim_first": True})
        self.assertEqual((st, r["error"]), (409, "invalid_transition"))                # 다른 설치본으로는 못 넘긴다
        self.assertIn("scdf", r["detail"])
        self.assertEqual(self.call("POST", f"/api/office/kanban/tasks/{a}/reassign?board={B}", {"profile": "ma"})[1]["task"]["assignee"], "ma")
        self.assertEqual(self.call("POST", f"/api/office/kanban/tasks/{a}/request-changes?board={B}", {})[1]["error"], "missing_field")
        self.assertEqual(self.call("POST", f"/api/office/kanban/tasks/{a}/approve?board={B}", {})[1]["task"]["status"], "done")
        for name in ("specify", "decompose", "estimate"):                              # AAS 화면에 없는 동작 — 사람이 갈 다른 화면도 없다
            self.assertEqual(self.call("POST", f"/api/office/kanban/tasks/{a}/{name}?board={B}", {})[1]["error"], "unknown_action")
        self.assertEqual(self.call("POST", f"/api/office/kanban/tasks/{a}/dance?board={B}", {})[1]["error"], "unknown_action")
        self.assertEqual(self.call("GET", f"/api/office/kanban/tasks/{a}/log?board={B}")[1], {"exists": True, "size_bytes": 3, "content": "log", "truncated": False})
        self.assertEqual(self.call("GET", f"/api/office/kanban/tasks/t_nope?board={B}")[1]["error"], "task_not_found")
        self.assertEqual(self.call("POST", f"/api/office/kanban/tasks/{a}/archive?board={B}", {})[1]["task"]["status"], "archived")
        self.assertEqual(self.call("DELETE", f"/api/office/kanban/tasks/{b}?board={B}")[1], {"ok": True})
        meta = self.call("GET", "/api/office/kanban/boards?include_archived=true")[1]["boards"][0]
        self.assertEqual((meta["counts"].get("archived"), meta["total"]), (1, 1))
        self.assertEqual(self.call("PATCH", f"/api/office/kanban/boards/{B}", {"name": "새 이름"})[1]["board"]["name"], "새 이름")
        self.assertEqual(self.call("GET", "/api/office/kanban/orchestration")[0], 404)

    def test_5_unreachable_install_keeps_the_rest(self):
        self.dash["scdf"].down = True
        try:
            view = self.call("GET", f"/api/office/kanban/board?board={B}")
            self.assertEqual(view[0], 200)
            with hub_auto._db() as conn:                                                # 안 닿는 설치본의 카드를 지워진 것으로 치지 않는다
                self.assertTrue(conn.execute("SELECT 1 FROM office_cards WHERE board=? AND pod='scdf'", (B,)).fetchone())
            st, r = self.call("POST", f"/api/office/kanban/tasks?board={B}", {"title": "y", "assignee": "scdf-doc"})
            self.assertEqual((st, r["error"]), (503, "hermes_unavailable"))
        finally:
            self.dash["scdf"].down = False

    def test_6_cron(self):
        base = "/api/office/cron/sa"
        self.assertEqual(self.call("GET", "/api/office/cron/ghost/jobs")[1]["error"], "profile_not_found")     # 앉지 않은 이름
        self.assertEqual(self.call("GET", base + "/jobs?include_disabled=true")[1], {"jobs": []})
        self.assertEqual(self.call("POST", base + "/jobs", {"name": "x", "schedule": "nonsense"})[1]["error"], "invalid_schedule")
        st, r = self.call("POST", base + "/jobs", {"name": "아침 보고", "prompt": "어제 실적 요약", "schedule": "0 9 * * *"})
        job = r["job"]
        self.assertEqual((st, job["schedule"]["expr"], job["state"], job["deliver"], job["skills"]), (201, "0 9 * * *", "scheduled", "local", []))
        self.assertNotIn("hermes_home", job)                                            # Hermes 안쪽 경로는 내보내지 않는다
        jid = job["id"]
        self.assertEqual(self.call("GET", "/api/office/cron/ma/jobs/" + jid)[1]["error"], "job_not_found")   # 다른 자리의 작업은 안 보인다
        self.assertEqual(self.call("PUT", f"{base}/jobs/{jid}", {"updates": {"name": "오전 보고", "hermes_home": "/x"}})[1]["job"]["name"], "오전 보고")
        self.assertEqual(self.call("PUT", f"{base}/jobs/{jid}", {"updates": {"hermes_home": "/x"}})[1]["error"], "invalid_update")
        self.assertEqual(self.call("POST", f"{base}/jobs/{jid}/pause", {})[1]["job"]["state"], "paused")
        self.assertEqual(self.call("POST", f"{base}/jobs/{jid}/run", {})[1]["error"], "job_paused")
        self.call("POST", f"{base}/jobs/{jid}/resume", {})
        cur = self.call("GET", f"/api/office/events?board={B}")[1]["cursor"]
        st, r = self.call("POST", f"{base}/jobs/{jid}/run", {})
        self.assertEqual((st, r["accepted"]), (202, True))
        self.auto._cron_at = 0
        ev = self.call("GET", f"/api/office/events?board={B}&cursor={cur}")[1]
        self.assertEqual([(e["kind"], e["profile"], e["job_id"]) for e in ev["events"]], [("cron.run.started", "sa", jid)])
        self.dash["yj"].jobs[jid]["latest_execution"] = {"id": "e1", "status": "completed"}
        self.auto._cron_at = 0
        ev = self.call("GET", f"/api/office/events?board={B}&cursor={ev['cursor']}")[1]
        self.assertEqual([(e["kind"], e["payload"]["status"]) for e in ev["events"]], [("cron.run.finished", "ok")])
        runs = self.call("GET", f"{base}/jobs/{jid}/runs?limit=5")[1]
        self.assertEqual((runs["limit"], runs["runs"][0]["status"], runs["runs"][0]["summary"]), (5, "ok", "아침 보고"))
        self.assertNotIn("SECRET", json.dumps(runs))
        self.assertEqual(self.call("GET", base + "/delivery-targets")[1]["targets"][0]["id"], "local")
        self.assertEqual(self.call("GET", base + "/blueprints")[1], {"blueprints": []})
        self.assertEqual(self.call("DELETE", f"{base}/jobs/{jid}")[1], {"ok": True})

    def test_7_tick_pushes_only_boards_with_work(self):
        st, r = self.call("POST", f"/api/office/kanban/tasks?board={B}", {"title": "밀어 주기", "assignee": "ma"})
        n = len([c for c in self.dash["yj"].calls if c[1].endswith("/dispatch")])
        self.auto.tick()
        self.assertEqual(len([c for c in self.dash["yj"].calls if c[1].endswith("/dispatch")]), n + 1)
        self.assertEqual(self.dash["yj"].boards[B]["tasks"][r["task"]["id"]]["status"], "running")


class DefaultBoardTest(unittest.TestCase):
    """에이전트를 만들면 칸반을 바로 쓰게 서버가 기본 보드를 한 번 만든다(스펙 2026-10-17-003 P1)."""

    @staticmethod
    def clear():
        with hub_auto._db() as conn:
            for t in ("office_boards", "office_board_pods", "office_flags"):
                conn.execute(f"DELETE FROM {t}")

    def setUp(self):
        self.clear()

    def tearDown(self):
        self.clear()

    @staticmethod
    def boards():
        with hub_auto._db() as conn:
            return [(r["slug"], r["name"]) for r in conn.execute("SELECT slug, name FROM office_boards ORDER BY slug")]

    def test_설치본이_있고_보드가_없으면_기본_보드를_한_번_만든다(self):
        self.assertTrue(hub_auto.ensure_default_board(True))
        self.assertFalse(hub_auto.ensure_default_board(True))
        self.assertEqual(len(self.boards()), 1)
        slug, name = self.boards()[0]
        self.assertEqual(slug, hub_auto.DEFAULT_BOARD)
        self.assertIn(name, ("기본 보드", "Default board"))

    def test_설치본이_없으면_만들지_않고_생긴_뒤에_만든다(self):
        self.assertFalse(hub_auto.ensure_default_board(False))
        self.assertEqual(self.boards(), [])
        self.assertTrue(hub_auto.ensure_default_board(True))

    def test_관리자가_지우거나_보관한_뒤에는_다시_만들지_않는다(self):
        hub_auto.ensure_default_board(True)
        with hub_auto._db() as conn:
            conn.execute("DELETE FROM office_boards")
        self.assertFalse(hub_auto.ensure_default_board(True))
        self.assertEqual(self.boards(), [])

    def test_이미_보드가_있는_설치에는_만들지_않는다(self):
        with hub_auto._db() as conn:
            conn.execute("INSERT INTO office_boards (slug, name, ts) VALUES ('mine', '우리 보드', 'now')")
        self.assertFalse(hub_auto.ensure_default_board(True))
        self.assertEqual(self.boards(), [("mine", "우리 보드")])
        with hub_auto._db() as conn:
            conn.execute("DELETE FROM office_boards")
        self.assertFalse(hub_auto.ensure_default_board(True))                  # 그 뒤 모두 지워도 새로 만들지 않는다


if __name__ == "__main__":
    unittest.main()
