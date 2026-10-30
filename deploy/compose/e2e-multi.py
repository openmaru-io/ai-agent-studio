#!/usr/bin/env python3
# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Hermes 여러 개 시험 환경의 끝에서 끝까지 확인: 로그인 → 자리 앉히기 → 칸반 카드(설치본 셋에 걸침) → 방 만들기 → 회의 → 오피스 상태.

실제 Hermes 3개를 상대로 AAS 의 오피스 API 를 부른다. 표준 라이브러리만 쓴다.
사용: python3 e2e-multi.py [--url http://127.0.0.1:17901] [--email admin@example.com] [--password ...]
모델(LLM)이 연결돼 있지 않으면 회의의 에이전트 답은 「답하지 못했습니다」 알림으로 돌아온다. 이것도 정상 경로로 본다.
"""
import argparse
import http.cookiejar
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("--url", default="http://127.0.0.1:17901")
ap.add_argument("--email", default="admin@example.com")
ap.add_argument("--password", default="multi-aas-pass-123")
ap.add_argument("--members", action="store_true", help="방 구성원 권한(일반 사용자의 보이는 자리·카드·회의·보류)까지 확인한다. 설치본 three 의 주인 계정이 필요하다")
ap.add_argument("--member-email", default="member@example.com")
ap.add_argument("--member-password", default="multi-member-pass-123")
ap.add_argument("--llm", action="store_true", help="모델이 연결돼 있다고 보고, 에이전트가 실제로 답하는지와 카드가 실행되는지까지 확인한다")
args = ap.parse_args()

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def session(email, password):
    """로그인한 요청 함수 (call, 열기). 사용자마다 쿠키를 따로 갖는다."""
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), NoRedirect)
    form = urllib.parse.urlencode({"email": email, "password": password, "next": "/"}).encode()
    try:
        opener.open(urllib.request.Request(args.url + "/auth/password", data=form, method="POST"), timeout=15)
    except urllib.error.HTTPError as exc:
        if exc.code not in (302, 303):
            raise SystemExit(f"{email} 로그인 실패: HTTP {exc.code}")
    if not len(jar):
        raise SystemExit(f"{email} 로그인 쿠키가 없습니다")

    def call(method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(args.url + path, data=data, method=method,
                                     headers={"X-AAS": "1", "Content-Type": "application/json", "Host": urllib.parse.urlsplit(args.url).netloc})
        try:
            with opener.open(req, timeout=60) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read() or b"{}")

    return call, opener


fails = []
call, _ = session(args.email, args.password)


def check(name, ok, detail=""):
    print(("ok   " if ok else "FAIL ") + name + (f"  {detail}" if detail and not ok else ""))
    if not ok:
        fails.append(name)


check("로그인", True)

# 2. 자리: 설치본마다 프로파일 하나씩
for pod, profile in (("one", "ma"), ("two", "qa"), ("three", "sa")):
    st, out = call("POST", "/api/office/action", {"action": "seat.set", "pod": pod, "profile": profile, "title": profile.upper(), "enabled": True})
    check(f"자리 {pod}/{profile}", st == 200, str(out))
st, ov = call("GET", "/api/office")
check("오피스 요약에 설치본 셋", [p["id"] for p in ov.get("pods", [])] == ["one", "two", "three"], str(ov.get("pods")))
check("자리 셋", {s["alias"] for s in ov.get("seats", [])} >= {"ma", "qa", "sa"})

# 3. 칸반: 설치본 셋에 걸친 카드
slug = "office-e2e" + str(int(time.time()))[-6:]
st, out = call("POST", "/api/office/kanban/boards", {"slug": slug, "name": "e2e"})
check("보드 만들기", st in (200, 201), str(out))
ids = {}
for who in ("ma", "qa", "sa"):
    st, out = call("POST", f"/api/office/kanban/tasks?board={slug}", {"title": f"{who} 의 일", "assignee": who})
    check(f"카드({who})", st == 201 and out["task"]["assignee"] == who, str(out))
    ids[who] = out.get("task", {}).get("id")
st, view = call("GET", f"/api/office/kanban/board?board={slug}")
ready = [t["assignee"] for c in view.get("columns", []) if c["name"] == "ready" for t in c["tasks"]]
check("보드에 세 설치본의 카드가 합쳐 보임", sorted(ready) == ["ma", "qa", "sa"], str(ready))
st, out = call("POST", f"/api/office/kanban/tasks/{ids['ma']}/comments?board={slug}", {"body": "e2e 댓글"})
check("댓글", st == 201, str(out))
st, out = call("POST", f"/api/office/kanban/tasks/{ids['ma']}/reassign?board={slug}", {"profile": "qa"})
check("다른 설치본으로 넘기기는 거절", st == 409, f"{st} {out}")
st, det = call("GET", f"/api/office/kanban/tasks/{ids['qa']}?board={slug}")
check("카드 상세", st == 200 and det["task"]["title"] == "qa 의 일", str(det)[:200])
st, ev = call("GET", f"/api/office/events?board={slug}")
check("이벤트 커서", st == 200 and "cursor" in ev, str(ev)[:200])

# 4. 크론
st, out = call("POST", "/api/office/cron/ma/jobs", {"name": "e2e 크론", "prompt": "안녕", "schedule": "0 9 * * *", "paused": True})
check("크론 만들기", st == 201, str(out))
jid = out.get("job", {}).get("id")
st, out = call("GET", "/api/office/cron/ma/jobs")
check("크론 목록", st == 200 and any(j["id"] == jid for j in out.get("jobs", [])), str(out)[:200])
st, out = call("POST", "/api/office/cron/qa/jobs", {"name": "다른 자리", "prompt": "안녕", "schedule": "nonsense"})
check("나쁜 일정은 invalid_schedule", st == 400 and out.get("error") == "invalid_schedule", f"{st} {out}")
if jid:
    check("크론 지우기", call("DELETE", f"/api/office/cron/ma/jobs/{jid}")[0] == 200)

# 5. 방과 회의
st, out = call("POST", "/api/office/action", {"action": "room.set", "name": "e2e 방", "purpose": "점검", "seats": ["ma", "qa", "sa"], "people": ["admin"]})
check("방 만들기", st == 200, str(out))
rid = out.get("id")
st, out = call("POST", "/api/office/meeting/say", {"room": rid, "text": "각자 한 줄로 자기소개 해 줘"})
check("회의 말하기", st == 202 and sorted(out.get("targets", [])) == ["ma", "qa", "sa"], f"{st} {out}")
end, view = time.time() + 90, {}
while time.time() < end:
    st, view = call("GET", f"/api/office/meeting?room={rid}")
    if not view.get("pending") and len(view.get("messages", [])) >= 4:
        break
    time.sleep(1.5)
authors = sorted({m["author"] for m in view.get("messages", []) if m["role"] != "user"})
check("세 에이전트가 모두 기록을 남김(답 또는 실패 알림)", authors == ["ma", "qa", "sa"], str(view.get("messages")))
if args.llm:
    check("모델이 연결돼 세 에이전트가 모두 실제로 답함", sorted(m["author"] for m in view.get("messages", []) if m["role"] == "assistant") == ["ma", "qa", "sa"],
          str([m["content"][:80] for m in view.get("messages", []) if m["role"] == "system"]))
for m in view.get("messages", [])[1:]:
    print(f"     [{m['role']}] {m['author']}: {m['content'][:80]!r}")

# 5-1. 카드 실행(모델 필요): 서버의 20초 주기가 dispatch 해서 Hermes 가 일을 끝낸다
if args.llm:
    st, made = call("POST", f"/api/office/kanban/tasks?board={slug}", {"title": "1+1 은 얼마인지 한 줄로 답하고 카드를 완료해", "assignee": "ma", "priority": 5})
    run_id, final = made.get("task", {}).get("id"), ""
    end = time.time() + 150
    while time.time() < end and run_id:
        st, det = call("GET", f"/api/office/kanban/tasks/{run_id}?board={slug}")
        final = det.get("task", {}).get("status", "")
        if final in ("done", "review", "blocked"):
            break
        time.sleep(5)
    check("카드가 실행되어 끝(또는 검토·막힘)에 닿음", final in ("done", "review", "blocked"), f"마지막 상태 {final!r}")
    print(f"     카드 최종 상태: {final}")
    ids["run"] = run_id

# 6. 상태와 정리
st, state = call("GET", "/api/office/state")
check("오피스 상태에 자리 셋", {a["alias"] for a in state.get("agents", [])} >= {"ma", "qa", "sa"})
for who in ("ma", "qa", "sa", "run"):
    if ids.get(who):
        call("DELETE", f"/api/office/kanban/tasks/{ids[who]}?board={slug}")
call("POST", "/api/office/action", {"action": "room.delete", "id": rid})
for alias in ("ma", "qa", "sa"):
    call("POST", "/api/office/action", {"action": "seat.delete", "alias": alias})

# 6-1. MCP 서버: 추가 → 설정 읽기 → 연결 시험 → 삭제. 실제 Hermes 의 저장 형식·${이름} 해석·오류 코드와 맞물리는지 본다.
#      uvx 가 패키지(mcp-server-time)를 받으므로 이 컨테이너에서 PyPI 에 닿아야 연결 시험이 도구를 읽는다. 닿지 않아도 추가·설정·삭제는 확인한다
secret = "e2e-secret-" + str(int(time.time()))
st, out = call("POST", "/api/profile/action", {"name": "ma", "action": "mcp_add", "server": "e2e-tz", "kind": "stdio", "command": "uvx", "args": ["mcp-server-time"], "env": {"API_TOKEN": secret}})
check("MCP 서버 추가(프로그램 실행 + 환경변수)", st == 200 and out.get("env_written") == 1, f"{st} {out}")
st, det = call("GET", "/api/profile?name=ma")
check("서버 목록에 새 서버", st == 200 and any(m["name"] == "e2e-tz" and m["transport"] == "stdio" for m in det.get("mcp") or []), str(det.get("mcp")))
cfg_text = (det.get("config") or {}).get("content") or json.dumps(det.get("config") or {})
check("설정에는 ${MCP_…} 참조만 있고 비밀 값은 없다", "${MCP_E2E_TZ__API_TOKEN__" in cfg_text and secret not in cfg_text and secret not in json.dumps(det), cfg_text[:200])
check("설정 탭이 읽기 전용이 되지 않는다(가려진 줄 없음)", not (det.get("config") or {}).get("masked_lines"), str((det.get("config") or {}).get("masked_lines")))
st, dup = call("POST", "/api/profile/action", {"name": "ma", "action": "mcp_add", "server": "E2E_TZ", "kind": "url", "url": "https://example.com/mcp"})
check("같은 키의 이름은 거절", st == 409 and dup.get("reason") == "name_exists" and dup.get("field") == "name", f"{st} {dup}")
st, test = call("POST", "/api/profile/action", {"name": "ma", "action": "mcp_test", "target": "e2e-tz"})
check("연결 시험 응답(성공이면 도구 수, 아니면 이유)", st == 200 and "ok" in test.get("test", {}), str(test))
print(f"     연결 시험: {test.get('test')}")
st, gone = call("POST", "/api/profile/action", {"name": "ma", "action": "mcp_remove", "target": "e2e-tz"})
check("MCP 서버 삭제 + 이 서버만 쓰던 비밀값 줄도 지움", st == 200 and gone.get("env_cleared") == 1 and gone.get("env_left") == 0, f"{st} {gone}")
st, det = call("GET", "/api/profile?name=ma")
check("삭제 뒤 목록에서 사라짐", st == 200 and not any(m["name"] == "e2e-tz" for m in det.get("mcp") or []), str(det.get("mcp")))

# 7. 방 구성원 권한(--members): 설치본 three 의 주인(member)은 자기 에이전트(sa)와 구성원인 방의 에이전트(ma)만 보고 시킨다
if args.members:
    mcall, mopen = session(args.member_email, args.member_password)
    for pod, profile in (("one", "ma"), ("two", "qa"), ("three", "sa")):
        call("POST", "/api/office/action", {"action": "seat.set", "pod": pod, "profile": profile, "title": profile.upper(), "enabled": True})
    st, shared = call("POST", "/api/office/action", {"action": "room.set", "name": "공유 방", "purpose": "구성원 시험", "seats": ["ma", "sa"], "members": [args.member_email]})
    st2, hidden = call("POST", "/api/office/action", {"action": "room.set", "name": "비공개 방", "purpose": "구성원 아님", "seats": ["qa"]})
    check("방 둘 만들기(구성원 지정)", st == 200 and st2 == 200, f"{shared} {hidden}")
    st, ov = mcall("GET", "/api/office")
    check("member: 보이는 자리는 내 설치본의 sa 와 구성원인 방의 ma(qa 는 안 보임)", st == 200 and {s["alias"] for s in ov.get("seats", [])} == {"ma", "sa"}, str(ov.get("seats")))
    check("member: 보이는 방은 구성원인 방 하나, 구성원 이메일은 안 옴", st == 200 and [r["name"] for r in ov.get("rooms", [])] == ["공유 방"] and all("members" not in r for r in ov["rooms"]), str(ov.get("rooms")))
    check("member: 편집 권한 없음·오피스 API 사용 가능", ov.get("can_edit") is False and ov.get("can_act") is True)
    st, state = mcall("GET", "/api/office/state")
    check("member: 오피스 상태에는 보이는 자리만", {a["alias"] for a in state.get("agents", [])} == {"ma", "sa"}, str(state)[:200])
    first = b""
    req = urllib.request.Request(args.url + "/api/office/stream", headers={"Host": urllib.parse.urlsplit(args.url).netloc})
    with mopen.open(req, timeout=15) as r:
        for _ in range(40):
            line = r.fp.readline()
            if line.startswith(b"data:"):
                first = line
                break
    snap = json.loads(first[5:]) if first else {}
    check("member: 스트림 snapshot 에도 보이는 자리만", {a["alias"] for a in snap.get("payload", {}).get("agents", [])} == {"ma", "sa"}, str(snap)[:200])
    st, _ = mcall("POST", "/api/office/action", {"action": "seat.set", "pod": "three", "profile": "dev"})
    check("member: 자리·방 바꾸기는 관리자만", st in (403, 404), f"HTTP {st}")
    st, out = mcall("GET", f"/api/office/meeting?room={shared['id']}")
    check("member: 구성원인 방의 회의를 본다", st == 200, str(out))
    st, out = mcall("GET", f"/api/office/meeting?room={hidden['id']}")
    check("member: 구성원이 아닌 방의 회의는 403", st == 403, f"{st} {out}")
    st, out = mcall("POST", "/api/office/meeting/say", {"room": hidden["id"], "text": "들어가 본다"})
    check("member: 구성원이 아닌 방에서는 말할 수 없다", st == 403, f"{st} {out}")
    st, out = mcall("POST", "/api/office/meeting/say", {"room": shared["id"], "text": "한 줄로 인사해", "targets": ["ma"]})
    check("member: 구성원인 방에서 남의 에이전트(ma)에게 말한다", st == 202 and out.get("targets") == ["ma"], f"{st} {out}")
    slug2 = "office-mem" + str(int(time.time()))[-6:]
    call("POST", "/api/office/kanban/boards", {"slug": slug2, "name": "구성원 시험"})
    st, out = mcall("POST", f"/api/office/kanban/tasks?board={slug2}", {"title": "남의 일", "assignee": "qa"})
    check("member: 보이지 않는 에이전트(qa)에게는 카드를 못 맡긴다", st == 403, f"{st} {out}")
    st, mine = mcall("POST", f"/api/office/kanban/tasks?board={slug2}", {"title": "방 일", "assignee": "ma"})
    check("member: 구성원인 방의 에이전트(ma)에게는 맡긴다", st == 201, f"{st} {mine}")
    call("POST", f"/api/office/kanban/tasks?board={slug2}", {"title": "비공개 일", "assignee": "qa"})
    st, view = mcall("GET", f"/api/office/kanban/board?board={slug2}")
    titles = sorted(t["title"] for c in view.get("columns", []) for t in c["tasks"])
    check("member: 보드에는 보이는 자리의 카드만", titles == ["방 일"], str(titles))
    st, cron = mcall("GET", "/api/office/cron/qa/jobs")
    check("member: 보이지 않는 에이전트의 크론은 403", st == 403, f"{st} {cron}")
    # 방에서 빼면 맡긴 카드가 실행할 때 보류된다
    call("POST", "/api/office/action", {"action": "room.set", "id": shared["id"], "name": "공유 방", "seats": ["ma", "sa"], "members": []})
    call("POST", f"/api/office/kanban/dispatch?board={slug2}", {})
    st, adm = call("GET", f"/api/office/kanban/tasks/{mine['task']['id']}?board={slug2}")
    check("방에서 빠진 member 의 카드는 실행하지 않고 보류(blocked)", adm.get("task", {}).get("status") == "blocked", str(adm.get("task", {}).get("status")))
    st, ov = mcall("GET", "/api/office")
    check("member: 방에서 빠지면 ma 도 방도 안 보인다", {s["alias"] for s in ov.get("seats", [])} == {"sa"} and ov.get("rooms") == [], str(ov)[:200])
    st, out = mcall("GET", f"/api/office/meeting?room={shared['id']}")
    check("member: 빠진 방의 회의는 403", st == 403, f"{st}")
    for t in view.get("columns", []):
        for card in t["tasks"]:
            call("DELETE", f"/api/office/kanban/tasks/{card['id']}?board={slug2}")
    for rid2 in (shared["id"], hidden["id"]):
        call("POST", "/api/office/action", {"action": "room.delete", "id": rid2})
    for alias in ("ma", "qa", "sa"):
        call("POST", "/api/office/action", {"action": "seat.delete", "alias": alias})


print(f"\n{'실패 ' + str(len(fails)) + '건: ' + ', '.join(fails) if fails else '모두 통과'}")
sys.exit(1 if fails else 0)
