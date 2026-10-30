# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""내보내기 때 가려진 기본 스킬 되돌리기(스펙 2026-10-27-011 R9~R13, 재검토 D2·D3): 기록·자동 주기 한 걸음·PC 가져오기 단계."""
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.fleet import k8s  # noqa: E402
from aas.ops import bundled_repair as br  # noqa: E402
from aas.ops import pc_import as pc  # noqa: E402

NS, GROUP, VER = "ns", "aas.openmaru.io", "v1alpha1"


class FakeClient:
    """HermesTask 만 흉내 낸다. statuses[이름] 이 있으면 get_task 가 그 상태를 돌려준다."""

    namespace = NS

    def __init__(self, create_error=None):
        self.created, self.statuses, self.create_error, self.gone = [], {}, create_error, False

    def create_task(self, body, dry_run=False, timeout=10.0):
        self.created.append(body)
        if self.create_error:
            raise self.create_error
        return body

    def get_task(self, name):
        if name in self.statuses:
            return {"status": self.statuses[name]}
        if self.gone or name not in {b["metadata"]["name"] for b in self.created}:
            raise k8s.K8sError("not found", 404)
        return {}                                                         # 만들었지만 오퍼레이터가 아직 상태를 쓰지 않았다


def step(client, pod, profile, now=None):
    return br.step(client, pod, profile, NS, GROUP, VER, pc.unsupported, now)


class RecordTest(unittest.TestCase):
    def test_결과_문구에서_되돌린_수를_읽는다(self):
        self.assertEqual(br.repaired_count("[REPAIRED] 12"), 12)
        self.assertEqual(br.repaired_count("[REPAIRED]0"), 0)
        self.assertIsNone(br.repaired_count("기본 스킬을 맞췄습니다"))
        self.assertTrue(br.skipped("[SKIPPED] 이 Hermes 판에서는 할 수 없습니다"))
        self.assertFalse(br.skipped("[FAILED] x"))

    def test_후보는_이름_규칙과_근거가_있는_프로파일만(self):
        names = ["main", "default", "Bad_Name", "x" * 42, "quiet", "imp"]
        self.assertEqual(br.candidates(names, {"main", "Bad_Name", "x" * 42}, {"imp"}), ["main", "imp"])

    def test_띠는_7일_안에_하나_이상_되돌린_기록만(self):
        now = datetime(2026, 10, 27, tzinfo=timezone.utc)
        br.done("rec-pod", "main", 12, now - timedelta(days=1))
        br.done("rec-pod", "zero", 0, now)
        br.done("rec-pod", "old", 3, now - timedelta(days=8))
        br.done("rec_pod", "other", 5, now)                               # LIKE 의 _ 가 다른 POD 를 끌어오지 않는다
        self.assertEqual([(r["profile"], r["n"]) for r in br.recent("rec-pod", now)], [("main", 12)])
        self.assertEqual(br.get("rec-pod", "old")["state"], "done")       # 기록 자체는 남는다(R13 이 다시 돌지 않게)

    def test_이름_바꾸기와_삭제를_따라간다(self):
        br.done("mv-pod", "a", 2)
        br.move_profile("mv-pod", "a", "b")
        self.assertIsNone(br.get("mv-pod", "a"))
        self.assertEqual(br.get("mv-pod", "b")["n"], 2)
        br.detach_profile("mv-pod", "b")
        self.assertIsNone(br.get("mv-pod", "b"))


class StepTest(unittest.TestCase):
    def test_요청하고_다음_주기에_성공하면_기록한다(self):
        c = FakeClient()
        self.assertEqual(step(c, "s-pod", "main"), ("pending", 0))
        name = c.created[0]["metadata"]["name"]
        self.assertEqual(name, br.task_name("s-pod", "main", 0))
        self.assertEqual(c.created[0]["spec"], {"agent": "s-pod", "profile": "main", "type": "SkillBundledRepair", "requestedBy": "aas"})
        self.assertEqual(step(c, "s-pod", "main"), ("pending", 0))       # 아직 상태 없음 — 기다린다
        self.assertEqual(len(c.created), 1)
        c.statuses[name] = {"phase": "Succeeded", "message": "[REPAIRED] 12"}
        self.assertEqual(step(c, "s-pod", "main"), ("done", 12))
        self.assertEqual(step(c, "s-pod", "main"), ("skip", 0))           # 끝난 프로파일은 다시 요청하지 않는다
        self.assertEqual(len(c.created), 1)

    def test_실패하면_기록하지_않고_다음_시도_이름으로_다시(self):
        c = FakeClient()
        step(c, "f-pod", "main")
        c.statuses[br.task_name("f-pod", "main", 0)] = {"phase": "Failed", "message": "[NOPROFILE] 프로파일 폴더가 없습니다"}
        self.assertEqual(step(c, "f-pod", "main"), ("retry", 0))
        self.assertNotEqual(br.get("f-pod", "main")["state"], "done")
        step(c, "f-pod", "main")
        self.assertEqual(c.created[-1]["metadata"]["name"], br.task_name("f-pod", "main", 1))

    def test_SKIPPED_는_미지원으로_보고_다시_본다(self):
        c = FakeClient()
        step(c, "k-pod", "main")
        c.statuses[br.task_name("k-pod", "main", 0)] = {"phase": "Failed", "message": "[SKIPPED] 이 Hermes 판에서는 할 수 없습니다"}
        self.assertEqual(step(c, "k-pod", "main"), ("unsupported", 0))
        self.assertEqual(br.get("k-pod", "main")["state"], "retry")

    def test_지워진_작업은_다시_요청한다(self):
        c = FakeClient()
        step(c, "g-pod", "main")
        c.gone = True                                                     # 오퍼레이터가 24시간 뒤 지웠다
        self.assertEqual(step(c, "g-pod", "main"), ("retry", 0))

    def test_409_는_다른_복제본의_같은_작업을_기다린다(self):
        c = FakeClient(create_error=k8s.K8sError("exists", 409))
        self.assertEqual(step(c, "c-pod", "main"), ("pending", 0))
        self.assertEqual(br.get("c-pod", "main")["task"], br.task_name("c-pod", "main", 0))

    def test_옛_CRD_는_기록하지_않는다(self):
        c = FakeClient(create_error=k8s.K8sError('Unsupported value: "SkillBundledRepair"', 422))
        self.assertEqual(step(c, "o-pod", "main"), ("unsupported", 0))
        self.assertIsNone(br.get("o-pod", "main"))


class ImportStageTest(unittest.TestCase):
    def runner(self, task, download):
        job = {"id": "jobrepair01", "pod": "i-pod", "profile": "main", "summary": {}}
        return pc.Runner(job, SimpleNamespace(), task=task, restart=lambda: None, download=download)

    def test_되돌린_수와_목록을_결과에_담고_완료로_기록한다(self):
        files = {f"{pc.backup_path('jobrepair01')}/.bundled-repaired": b"profiles/main/skills/productivity/airtable\n",
                 f"{pc.backup_path('jobrepair01')}/.bundled-kept": b"profiles/main/skills/productivity/notion\n"}
        out = self.runner(lambda *a: "[REPAIRED] 1", lambda p: files[p])._bundled_repair("main")
        self.assertEqual(out, {"bundled_repaired_n": 1, "bundled_repaired": ["profiles/main/skills/productivity/airtable"],
                               "bundled_kept": ["profiles/main/skills/productivity/notion"]})
        self.assertEqual(br.get("i-pod", "main")["n"], 1)

    def test_목록을_못_읽어도_수는_남긴다(self):
        out = self.runner(lambda *a: "[REPAIRED] 4", None)._bundled_repair("main")
        self.assertEqual(out, {"bundled_repaired_n": 4, "bundled_list_unreadable": True})

    def test_미지원과_SKIPPED_와_실패를_나눈다(self):
        def raise_(msg):
            def task(*a):
                raise RuntimeError(msg)
            return task
        self.assertEqual(self.runner(raise_('[INVALID] 알 수 없는 작업 종류입니다: "SkillBundledRepair"'), None)._bundled_repair("main"),
                         {"bundled_repair_unsupported": True})
        self.assertEqual(self.runner(raise_("[SKIPPED] 이 Hermes 판에서는 할 수 없습니다"), None)._bundled_repair("main"),
                         {"bundled_repair_unsupported": True})
        self.assertEqual(self.runner(raise_("[TIMEOUT] 작업이 정해진 시간 안에 끝나지 않았습니다"), None)._bundled_repair("main"),
                         {"bundled_repair_error": "[TIMEOUT] 작업이 정해진 시간 안에 끝나지 않았습니다"})


class CycleTest(unittest.TestCase):
    def test_가져오기_중인_POD_는_건너뛰고_후보만_요청한다(self):
        from aas.web import server
        c = FakeClient()
        pods_ = [SimpleNamespace(id="cy-busy", hermes_home=None), SimpleNamespace(id="cy-pod", hermes_home=None)]
        with mock.patch.object(server.k8s, "client", return_value=c), \
                mock.patch.object(server.primary, "sync_profiles", return_value=["main", "quiet", "imp"]), \
                mock.patch.object(server.pc_import, "running", side_effect=lambda pod: {"id": "x"} if pod == "cy-busy" else None), \
                mock.patch.object(server.pc_import, "latest", side_effect=lambda pod, p: {"state": "done"} if p == "imp" else None):
            with server._lock:
                server._cache["cy-pod:skills"] = (0.0, {"skills": [{"profile": "main", "origin": "bundled_modified"}, {"profile": "quiet", "origin": "bundled"}]})
            server.bundled_repair_once(SimpleNamespace(pods=pods_))
            self.assertEqual(sorted((b["spec"]["agent"], b["spec"]["profile"]) for b in c.created), [("cy-pod", "imp"), ("cy-pod", "main")])
            c.statuses[br.task_name("cy-pod", "main", 0)] = {"phase": "Succeeded", "message": "[REPAIRED] 2"}
            with mock.patch.object(server, "_forget") as forget, mock.patch.object(server.store, "log_usage") as log:
                self.assertEqual(server.bundled_repair_once(SimpleNamespace(pods=pods_[1:])), ["cy-pod/main"])
            forget.assert_called_once()                                    # 안내 띠와 표가 어긋나지 않게 스킬 목록을 버린다
            self.assertIn("cy-pod/main 2", log.call_args[0][1])


if __name__ == "__main__":
    unittest.main()
