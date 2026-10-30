# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""주 프로파일(main) — 새 사용자만, 상태 이어 하기, 첫 템플릿, 대체값(스펙 2026-10-14-003)."""
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import soul_templates  # noqa: E402
from aas.fleet import primary  # noqa: E402



class FakeAPI:
    """대시보드 API 대역: 프로파일 목록·만들기·SOUL 읽기/쓰기."""

    def __init__(self, profiles=("default",), soul=None, fail_soul=False):
        self.profiles, self.calls, self.fail_soul = list(profiles), [], fail_soul
        from aas.fleet import identity
        self.souls = {p: soul if soul is not None else identity.HERMES_DEFAULT + " " + soul_templates.HERMES_DEFAULT_REST for p in profiles}

    def call(self, method, path, body=None, query=None):
        self.calls.append((method, path, body))
        if path == "/api/profiles" and method == "GET":
            return {"profiles": [{"name": p, "is_default": p == "default"} for p in self.profiles]}
        if path == "/api/profiles" and method == "POST":
            self.profiles.append(body["name"])
            self.souls[body["name"]] = self.souls["default"]
            return {"ok": True}
        if path.endswith("/soul"):
            name = path.split("/")[3]
            if self.fail_soul:
                raise ConnectionError("hermes 아직 준비 중")
            if method == "PUT":
                self.souls[name] = body["content"]
            return {"content": self.souls.get(name, "")}
        raise AssertionError(path)


def saver(calls):
    def save_text(pod, key, current, new, base_sha, who, write, read, note=""):
        write(new)
        calls.append((pod, key, note))
        return new
    return save_text


class PrimaryTest(unittest.TestCase):
    def setUp(self):
        self.env = mock.patch.dict(os.environ, {"AAS_K8S_NAMESPACE": "ns", "AAS_PRIMARY_MAIN": "1"})
        self.env.start()
        from aas.common import store
        with store.connect() as conn:
            conn.execute(primary.SCHEMA)
            conn.execute("DELETE FROM pod_primary")
            conn.execute("DELETE FROM meta WHERE key LIKE 'soul_default_template%'")

    def tearDown(self):
        self.env.stop()

    def test_설정이_꺼져_있으면_기록하지_않고_기록이_없는_POD_는_default(self):
        with mock.patch.dict(os.environ, {"AAS_PRIMARY_MAIN": ""}):
            self.assertFalse(primary.mark("old"))
        self.assertEqual(primary.primary_of("old"), "default")
        self.assertEqual(primary.hide_root("old", admin=False), "show")

    def test_새_사용자는_main_을_만들고_부서_템플릿을_입힌다(self):
        self.assertTrue(primary.mark("new"))
        self.assertEqual(primary.primary_of("new"), "main")
        pod, api, saved = SimpleNamespace(id="new", owner="kim@x.com"), FakeAPI(), []
        with mock.patch("aas.common.settings.departments", return_value={"kim@x.com": "마케팅팀"}):
            what = primary.ensure(pod, api, "kim", saver(saved))
        self.assertEqual(what, "created templated")
        self.assertIn(("POST", "/api/profiles", {"name": "main", "clone_from": "default"}), api.calls)
        self.assertFalse(soul_templates.is_default_soul(api.souls["main"]))          # 템플릿으로 바뀜
        self.assertEqual(saved[0][1], "soul:main")
        self.assertEqual(soul_templates.use_of("new", "main")["template_id"] != "", True)
        self.assertEqual(primary.state("new")["state"], "templated")
        self.assertEqual(primary.ensure(pod, api, "kim", saver(saved)), "")             # 끝난 POD 는 다시 하지 않는다
        self.assertEqual((primary.hide_root("new", admin=False), primary.hide_root("new", admin=True)), ("drop", "hidden"))

    def test_SOUL_을_읽지_못하면_만듦_상태로_남고_다음에_이어_한다(self):
        primary.mark("p2")
        pod = SimpleNamespace(id="p2", owner="lee@x.com")
        with self.assertRaises(ConnectionError):
            primary.ensure(pod, FakeAPI(fail_soul=True), "lee", saver([]))
        self.assertEqual(primary.state("p2")["state"], "created")
        api = FakeAPI(profiles=("default", "main"))
        primary.ensure(pod, api, "lee", saver([]))
        self.assertFalse(any(c[0] == "POST" for c in api.calls))                        # 이미 있으면 다시 만들지 않는다
        self.assertEqual(primary.state("p2")["state"], "templated")

    def test_사람이_고친_SOUL_은_덮지_않는다(self):
        primary.mark("p3")
        api = FakeAPI(profiles=("default", "main"), soul="# 내가 쓴 SOUL\n")
        saved = []
        primary.ensure(SimpleNamespace(id="p3", owner="x@x.com"), api, "x", saver(saved))
        self.assertEqual((api.souls["main"], saved), ("# 내가 쓴 SOUL\n", []))

    def test_기존_사용자를_옮기면_자리와_SOUL_판이_main_으로_간다(self):
        from aas.assets import files
        from aas.common import store
        from aas.office import office
        with office.connect() as conn:
            conn.execute("DELETE FROM office_seats WHERE pod='old1'")
            conn.execute("INSERT INTO office_seats (alias, pod, profile, by, ts) VALUES ('old1-seat', 'old1', 'default', 'auto', 't')")
        with store.connect() as conn:
            conn.execute(files.VERSION_SCHEMA)
            conn.execute("DELETE FROM file_versions WHERE pod='old1'")
            conn.execute("INSERT INTO file_versions (pod, path, sha, content, saved_at) VALUES ('old1', 'soul:default', 's', '# 옛 SOUL', 't')")
        with mock.patch.dict(os.environ, {"AAS_PRIMARY_MAIN": ""}):                     # 설정과 상관없이 관리자가 옮긴다
            self.assertEqual(primary.adopt("old1"), "main")
            self.assertEqual(primary.adopt("old1"), "main")                               # 두 번 돌려도 같다
        self.assertEqual(primary.state("old1")["state"], "target")
        self.assertEqual(office.seat_alias("old1", "main"), "old1-seat")                  # 별칭·책상은 그대로
        self.assertEqual(office.seat_alias("old1", "default"), "")
        with store.connect() as conn:
            rows = conn.execute("SELECT path FROM file_versions WHERE pod='old1' ORDER BY path").fetchall()
            conn.execute("DELETE FROM file_versions WHERE pod='old1'")
        with office.connect() as conn:
            conn.execute("DELETE FROM office_seats WHERE pod='old1'")
        self.assertEqual([r["path"] for r in rows], ["soul:default", "soul:main"])        # 루트 판은 남기고 main 에 복사

    def test_부서가_없으면_관리자_기본_템플릿_없으면_그대로(self):
        from aas.common import settings
        with mock.patch("aas.common.settings.departments", return_value={}):
            self.assertIsNone(primary.pick_template(""))
            first = soul_templates.templates()[0]
            settings.set_default_template(f"{first['id']}.{first['lang']}", "admin@x.com")
            self.assertEqual(primary.pick_template("")["id"], first["id"])


class PrimaryWiringTest(unittest.TestCase):
    """설정을 켠 경우 서버·읽기·오피스가 주 프로파일을 따른다(리뷰 D8·D10·D11, M1·M3)."""

    def setUp(self):
        self.env = mock.patch.dict(os.environ, {"AAS_K8S_NAMESPACE": "ns", "AAS_PRIMARY_MAIN": "1"})
        self.env.start()
        from aas.common import store
        with store.connect() as conn:
            conn.execute(primary.SCHEMA)
            conn.execute("DELETE FROM pod_primary")
        primary.mark("newpod")
        primary.forget_cache()

    def tearDown(self):
        self.env.stop()
        primary.forget_cache()

    def test_프로파일_목록은_사용자에게_루트를_빼고_관리자에게는_루트숨김(self):
        from aas.web import server
        rows = [{"name": "default", "is_default": True}, {"name": "main", "is_default": False}]
        with mock.patch.object(server, "_profile_rows", return_value=rows):
            new, old = SimpleNamespace(id="newpod"), SimpleNamespace(id="oldpod")
            self.assertEqual([r["name"] for r in server._visible_profile_rows(new, admin=False)], ["main"])
            self.assertEqual(server._visible_profile_rows(new, admin=True)[0].get("hidden_root"), True)
            self.assertEqual(server._visible_profile_rows(old, admin=False), [{**r, "importing": False} for r in rows])   # 기록 없는 POD 는 지금 그대로(가져오는 중 표시만 붙는다, OMAI-1444 DD4)

    def test_main_은_이름_바꾸기와_삭제를_거절한다(self):
        from aas.web import server
        self.assertTrue(server._is_primary(SimpleNamespace(id="newpod"), "main"))
        self.assertFalse(server._is_primary(SimpleNamespace(id="oldpod"), "main"))

    def test_읽기_목록에서_대상_POD_의_루트를_뺀다(self):
        from aas.hermes import hermes_reader
        d = Path(tempfile.mkdtemp(dir=TMP.name))
        (d / "profiles" / "main").mkdir(parents=True)

        class Home(type(d)):
            pass
        home = Home(d)
        home._b = SimpleNamespace(label="newpod")
        self.assertEqual([p.name for p in hermes_reader.profiles(home)], ["main"])
        home._b = SimpleNamespace(label="oldpod")
        self.assertEqual([p.name for p in hermes_reader.profiles(home)], ["default", "main"])

    def test_오피스_자동_자리는_main_이고_별칭은_이메일_앞부분(self):
        from aas.office import office
        from aas.web import server
        reg = SimpleNamespace(pods=[SimpleNamespace(id="newpod", owner="kim@x.com"), SimpleNamespace(id="oldpod", owner="lee@x.com")])
        pods = server._office_seat_pods(reg)
        self.assertEqual([(p.id, p.profiles) for p in pods], [("newpod", ["main"]), ("oldpod", ["default"])])
        self.assertEqual(office._alias_base("kim@x.com", "main", "main"), "kim")
        self.assertEqual(office._alias_base("lee@x.com", "main"), "lee-main")                 # 주 프로파일이 아니면 지금처럼


class SkillSyncTest(unittest.TestCase):
    """Hermes 버전이 바뀌면 기본 스킬 목록(.bundled_manifest)이 있는 이름 있는 프로파일마다 SkillSync 를 요청한다(리뷰 D14, 스펙 2026-10-14-015 D3)."""

    def setUp(self):
        self.env = mock.patch.dict(os.environ, {"AAS_K8S_NAMESPACE": "ns", "AAS_PRIMARY_MAIN": "1"})
        self.env.start()
        from aas.common import store
        with store.connect() as conn:
            conn.execute("DELETE FROM meta WHERE key LIKE 'hermes_version:%'")
        self.home = Path(tempfile.mkdtemp(dir=TMP.name))
        for name, manifest in (("main", True), ("test1", True), ("pkgbot", False)):          # pkgbot = 마켓 패키지로 만든 프로파일(기본 스킬 목록 없음)
            (self.home / "profiles" / name / "skills").mkdir(parents=True)
            if manifest:
                (self.home / "profiles" / name / "skills" / ".bundled_manifest").write_text("a:1\n", encoding="utf-8")

    def tearDown(self):
        self.env.stop()

    def test_버전은_처음엔_기록만_하고_바뀌면_알린다(self):
        self.assertFalse(primary.pod_version_changed("sp", "0.21.3"))                   # 처음: 기록만
        self.assertFalse(primary.pod_version_changed("sp", "0.21.3"))                   # 같음
        self.assertTrue(primary.pod_version_changed("sp", "0.22.0"))                    # 바뀜
        self.assertFalse(primary.pod_version_changed("sp", "0.22.0"))
        self.assertFalse(primary.pod_version_changed("sp", ""))                         # 못 읽은 값은 기록하지 않는다
        task = primary.skill_sync_task("sp", "main", "0.22.0", "ns", "aas.openmaru.io", "v1alpha1")
        self.assertEqual((task["spec"]["type"], task["spec"]["profile"], task["metadata"]["namespace"]), ("SkillSync", "main", "ns"))
        self.assertRegex(task["metadata"]["name"], r"^[a-z0-9]([a-z0-9.-]{0,60}[a-z0-9])?$")

    def test_기본_스킬_목록이_있는_이름_있는_프로파일만_고른다(self):
        self.assertEqual(primary.sync_profiles(self.home), ["main", "test1"])           # 패키지 프로파일(pkgbot)은 기본 스킬이 깔리지 않게 뺀다
        self.assertEqual(primary.sync_profiles(self.home / "nope"), [])

    def test_서버는_버전이_바뀐_POD_의_해당_프로파일마다_작업을_만든다(self):
        from aas.web import server
        primary.pod_version_changed("sp", "0.21.3")
        created = []
        client = SimpleNamespace(namespace="ns", create_task=lambda body: created.append(body))
        api = SimpleNamespace(call=lambda m, p, *a, **k: {"version": "0.22.0"})
        reg = SimpleNamespace(pods=[SimpleNamespace(id="sp", owner="x@x.com", hermes_home=self.home)])
        with mock.patch.object(server.k8s, "client", return_value=client), \
             mock.patch.object(server, "HermesAPI", return_value=api), mock.patch.object(server, "hub", return_value=SimpleNamespace(auth=None)):
            self.assertEqual(server.primary_skill_sync_once(reg), ["sp/main", "sp/test1"])
            self.assertEqual(server.primary_skill_sync_once(reg), [])                  # 같은 버전이면 다시 만들지 않는다
        self.assertEqual(sorted(c["spec"]["profile"] for c in created), ["main", "test1"])


class CuratorSettingTest(unittest.TestCase):
    """큐레이터가 기본 스킬을 보관하지 않게 config.yaml 에 한 줄만 넣는다(스펙 2026-10-14-015 D4)."""

    def test_값이_없으면_한_줄만_더하고_있으면_사람이_정한_값을_존중한다(self):
        import yaml
        base = "model:\n  default: m  # 주석\nterminal:\n  cwd: /x\n"
        out = primary.curator_patch(base)
        self.assertTrue(out.startswith(base))                                            # 쓰던 내용·주석은 그대로, 뒤에 더한다
        self.assertEqual(yaml.safe_load(out)["curator"], {"prune_builtins": False})
        block = "curator:\n  enabled: true\nmodel: m\n"
        out = primary.curator_patch(block)
        self.assertEqual(yaml.safe_load(out)["curator"], {"enabled": True, "prune_builtins": False})
        self.assertIn("model: m", out)
        self.assertIsNone(primary.curator_patch("curator:\n  prune_builtins: true\n"))   # 사람이 켜 둔 값은 건드리지 않는다
        self.assertIsNone(primary.curator_patch("curator:\n  prune_builtins: false\n"))  # 이미 꺼져 있다
        self.assertIsNone(primary.curator_patch("curator: {enabled: true}\n"))            # 줄 안에 적은 모양은 안전하게 못 고친다
        self.assertIsNone(primary.curator_patch("a: [1,\n"))                              # 읽을 수 없는 글은 고치지 않는다

    def test_nous_guest_는_값이_없을_때만_false_를_더한다(self):
        """Hermes 는 nous.guest 가 없으면(기본 true) 외부 포털에 익명 계정을 만든다(스펙 2026-10-28-006 §4-4). 사람이 정한 값은 둔다."""
        import yaml
        base = "model:\n  default: m  # 주석\n"
        out = primary.nous_guest_patch(base)
        self.assertTrue(out.startswith(base))
        self.assertEqual(yaml.safe_load(out)["nous"], {"guest": False})
        out = primary.nous_guest_patch("nous:\n  portal_url: https://p\nmodel: m\n")
        self.assertEqual(yaml.safe_load(out)["nous"], {"portal_url": "https://p", "guest": False})
        self.assertIsNone(primary.nous_guest_patch("nous:\n  guest: true\n"))      # 사람이 켜 둔 값
        self.assertIsNone(primary.nous_guest_patch("nous:\n  guest: false\n"))     # 이미 꺼짐
        self.assertIsNone(primary.nous_guest_patch("nous: {guest: true}\n"))        # 줄 안에 적은 모양
        self.assertIsNone(primary.nous_guest_patch("a: [1,\n"))                     # 읽을 수 없는 글

    def test_비밀값_줄이_있는_설정은_판_없이_바로_쓴다(self):
        """판 기록(save_text)은 비밀값처럼 보이는 줄이 있으면 403 이라, 키를 글자 그대로 적은 프로파일에는 설정이 영영 안 들어가고
        주기마다 실패만 되풀이했다(스펙 2026-10-28-006 R9·R12). 판 없이 Hermes 에 바로 쓰고 meta 를 남긴다."""
        from aas.common import store
        from aas.web import server
        with store.connect() as conn:
            conn.execute("DELETE FROM meta WHERE key LIKE 'nousguest:%'")
        secret = "model: m\nmcp_servers:\n  x:\n    headers:\n      Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789\n"
        texts = {"p": secret, "q": "model: m\n"}

        class API:
            def call(self, method, path, body=None, query=None):
                name = (query or {}).get("profile", "p")
                if method == "GET":
                    return {"yaml": texts[name]}
                texts[name] = body["yaml_text"]
                return {"ok": True}
        saved: list = []
        pod = SimpleNamespace(id="pod1")
        with mock.patch("aas.assets.files.save_text", side_effect=saver(saved)):
            self.assertEqual(server._nous_guest_one(pod, API(), {"name": "p"}), "pod1/p")
            self.assertEqual(server._nous_guest_one(pod, API(), {"name": "q"}), "pod1/q")
            self.assertEqual(server._nous_guest_one(pod, API(), {"name": "p"}), "")       # meta 표시 — 다시 쓰지 않는다
        self.assertIn("nous:\n  guest: false", texts["p"])
        self.assertTrue(texts["p"].startswith(secret))
        # 판 기록은 비밀값 없는 글만. 앞 시험(멈춘 작업공간)이 남긴 스레드가 같은 대역을 부를 수 있어 이 pod 만 본다
        self.assertEqual([k for p, k, _ in saved if p == "pod1"], ["config:q"])
        with store.connect() as conn:
            conn.execute("DELETE FROM meta WHERE key LIKE 'nousguest:%'")

    def test_멈춘_작업공간_하나가_다른_작업공간의_설정_맞추기를_늘리지_않는다(self):
        """작업공간 × 프로파일을 차례로 부르고 한 번에 30초씩 기다려, 멈춘 Hermes 하나가 한 주기를 길게 늘렸다(스펙 2026-10-24-002 R16)."""
        import threading
        import time
        from aas.common import store
        from aas.web import server
        with store.connect() as conn:
            conn.execute("DELETE FROM meta WHERE key LIKE 'curator:%'")
        release = threading.Event()
        self.addCleanup(release.set)

        class API:
            def __init__(self, pod):
                self.pod = pod

            def call(self, method, path, body=None, query=None):
                if self.pod == "stuck":
                    release.wait(10)                          # 연결은 받았는데 답하지 않는 Hermes
                if path == "/api/profiles":
                    return {"profiles": [{"name": "default", "is_default": True}]}
                if method == "GET":
                    return {"yaml": texts.get(self.pod, "model: m\n")}
                texts[self.pod] = body["yaml_text"]
                return {"ok": True}
        texts: dict = {}
        reg = SimpleNamespace(pods=[SimpleNamespace(id="stuck", owner="x@x.com"), SimpleNamespace(id="ok", owner="x@x.com")])
        with mock.patch.object(server, "HermesAPI", side_effect=lambda auth: API(auth)), \
                mock.patch.object(server, "hub", side_effect=lambda pod: SimpleNamespace(auth=pod.id)), \
                mock.patch.object(server, "SYNC_POD_TIMEOUT", 0.5):
            began = time.monotonic()
            self.assertEqual(server.curator_sync_once(reg), ["ok/default"])
            self.assertLess(time.monotonic() - began, 3)

    def test_앞_단계가_아직_도는_작업공간은_다음_단계에서_건너뛴다(self):
        """한도를 넘긴 작업은 결과만 버리고 계속 돈다. 다음 단계가 같은 작업공간을 바로 다시 돌려 같은 config.yaml 에 단계끼리
        동시에 썼다(스펙 2026-10-24-002 외부 검토 5). 앞 작업이 끝나면 다시 돈다."""
        import threading
        import time
        from types import SimpleNamespace
        from unittest import mock
        from aas.web import server
        release, ran = threading.Event(), []
        self.addCleanup(release.set)

        def slow(pod):
            ran.append(("1", pod.id))
            if pod.id == "busy-a":
                release.wait(10)
            return []

        def step(name):
            def one(pod):
                ran.append((name, pod.id))
                return []
            return one
        pods = [SimpleNamespace(id="busy-a"), SimpleNamespace(id="busy-b")]
        with mock.patch.object(server, "SYNC_POD_TIMEOUT", 0.3):
            server._each_pod(pods, slow, "1")
            server._each_pod(pods, step("2"), "2")
            release.set()
            end = time.monotonic() + 3
            while time.monotonic() < end and "busy-a" in server._POD_BUSY:
                time.sleep(0.02)
            server._each_pod(pods, step("3"), "3")
        self.assertEqual(sorted(ran), [("1", "busy-a"), ("1", "busy-b"), ("2", "busy-b"), ("3", "busy-a"), ("3", "busy-b")])

    def test_시작하지_못하고_취소된_작업공간은_진행_중으로_남지_않는다(self):
        """map_pods 는 끝날 때 시작하지 않은 작업을 취소한다 — 그 작업공간이 다음 주기에 영영 건너뛰어지면 안 된다."""
        from types import SimpleNamespace
        from unittest import mock
        from aas.web import server
        pods = [SimpleNamespace(id="never-a"), SimpleNamespace(id="never-b")]
        with mock.patch.object(server.collect_all, "map_pods", side_effect=lambda ps, fn, **kw: {ps[0].id: (True, fn(ps[0]))}):
            server._each_pod(pods, lambda pod: [], "t")
        self.assertFalse({"never-a", "never-b"} & server._POD_BUSY)

    def test_서버는_프로파일마다_한_번만_넣고_다음에는_다시_하지_않는다(self):
        from aas.common import store
        from aas.web import server
        with store.connect() as conn:
            conn.execute("DELETE FROM meta WHERE key LIKE 'curator:%'")
        texts = {"default": "model: m\n", "main": "curator:\n  prune_builtins: true\n"}
        puts = []

        class API:
            def call(self, method, path, body=None, query=None):
                if path == "/api/profiles":
                    return {"profiles": [{"name": "default", "is_default": True}, {"name": "main", "is_default": False}]}
                prof = (query or {}).get("profile") or (body or {}).get("profile") or "default"
                if method == "GET":
                    return {"yaml": texts[prof]}
                puts.append((prof, body["yaml_text"]))
                texts[prof] = body["yaml_text"]
                return {"ok": True}
        reg = SimpleNamespace(pods=[SimpleNamespace(id="sp", owner="x@x.com")])
        with mock.patch.object(server, "HermesAPI", return_value=API()), mock.patch.object(server, "hub", return_value=SimpleNamespace(auth=None)):
            self.assertEqual(server.curator_sync_once(reg), ["sp/default"])             # main 은 사람이 켜 둬서 건드리지 않는다
            self.assertEqual(server.curator_sync_once(reg), [])                         # 한 번 본 프로파일은 다시 보지 않는다
        self.assertEqual([p for p, _ in puts], ["default"])
        self.assertIn("prune_builtins: false", texts["default"])

    def test_적용_값이_이미_false_이면_쓰지_않고_끝난_것으로_기록한다(self):
        # Hermes v0.22.2 는 curator.prune_builtins 기본값이 False 이고, 기본값과 같은 줄은 저장 때 남기지 않는다.
        # 써도 다시 읽으면 그대로라 「저장했다고 답했지만 내용이 그대로」로 주기마다 실패했다(OMAI-1295).
        from aas.common import store
        from aas.web import server
        with store.connect() as conn:
            conn.execute("DELETE FROM meta WHERE key LIKE 'curator:%'")
        calls = []

        class API:
            def call(self, method, path, body=None, query=None):
                calls.append((method, path))
                if path == "/api/profiles":
                    return {"profiles": [{"name": "default", "is_default": True}]}
                if path == "/api/config":
                    return {"model": {"default": "m"}, "curator": {"prune_builtins": False}}
                if method == "GET":
                    return {"yaml": "model: m\n"}
                return {"ok": True}                                         # 받아들이지만 기본값 줄은 버린다
        reg = SimpleNamespace(pods=[SimpleNamespace(id="sp22", owner="x@x.com")])
        try:
            with mock.patch.object(server, "HermesAPI", return_value=API()), mock.patch.object(server, "hub", return_value=SimpleNamespace(auth=None)):
                self.assertEqual(server.curator_sync_once(reg), [])
                self.assertNotIn(("PUT", "/api/config/raw"), calls)
                calls.clear()
                self.assertEqual(server.curator_sync_once(reg), [])
                self.assertEqual(calls, [("GET", "/api/profiles")])        # 끝난 것으로 기록돼 다시 묻지 않는다
        finally:
            with store.connect() as conn:
                conn.execute("DELETE FROM meta WHERE key LIKE 'curator:sp22/%'")

