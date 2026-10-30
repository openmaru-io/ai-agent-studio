# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""지운 에이전트의 남은 데이터 볼륨 알림(OMAI-1291): 판정·기간 계산·받은편지함 항목·처리 뒤 조용함·끄기."""
import os
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.common import dbmigrate, store  # noqa: E402
from aas.fleet import retained_volumes as rv  # noqa: E402
from aas.office import office  # noqa: E402
from aas.office.office_access import Denied  # noqa: E402
from aas.web import server  # noqa: E402

T0 = datetime(2026, 10, 1, 9, 0).astimezone()


def pvc(name, size="5Gi"):
    return {"metadata": {"name": name}, "spec": {"resources": {"requests": {"storage": size}}}}


class RetainedVolumesTest(unittest.TestCase):
    def setUp(self):
        with store.connect() as conn:
            conn.executescript(rv.SCHEMA)
            conn.execute("DELETE FROM retained_volumes")

    def test_에이전트가_없는_data_볼륨만_남은_볼륨이다(self):
        got = rv.scan([pvc("data-aas-agent-a-1111-0"), pvc("data-aas-agent-b-2222-0"), pvc("aas-shared"), pvc("data-x-1")], {"aas-agent-b-2222"}, T0)
        self.assertEqual([r["pvc"] for r in got], ["data-aas-agent-a-1111-0"])
        self.assertEqual(got[0]["agent"], "aas-agent-a-1111")
        self.assertEqual(rv.agent_of("data-aas-agent-x-10-0"), "aas-agent-x-10")       # 숫자 꼬리가 있어도 끝의 -0 만 뗀다
        self.assertEqual(rv.agent_of("data-aas-agent-x-1"), "")

    def test_지운_기록이_있으면_그_시각부터_없으면_처음_본_시각부터_센다(self):
        rv.record_deletion("aas-agent-a-1111", "a@x.com", "admin@x.com", "aas-agent-a-1111-20261001.tar.gz", T0 - timedelta(days=40))
        rv.scan([pvc("data-aas-agent-a-1111-0"), pvc("data-aas-agent-old-9999-0", "10Gi")], set(), T0)
        items = rv.notice_items("agents-ns", T0, days=30)
        self.assertEqual(len(items), 1)                                               # 항목은 하나로 묶는다
        vols = items[0]["volumes"]
        self.assertEqual([v["pvc"] for v in vols], ["data-aas-agent-a-1111-0"])       # 처음 본 옛 볼륨은 아직 0일
        self.assertEqual((vols[0]["owner"], vols[0]["days"], vols[0]["size"], vols[0]["export"]), ("a@x.com", 40, "5Gi", "aas-agent-a-1111-20261001.tar.gz"))
        self.assertEqual(items[0]["kind"], "retained_volume")
        self.assertIn("kubectl -n agents-ns delete pvc data-aas-agent-a-1111-0", items[0]["command"])
        later = T0 + timedelta(days=31)
        rv.scan([pvc("data-aas-agent-a-1111-0"), pvc("data-aas-agent-old-9999-0", "10Gi")], set(), later)
        self.assertEqual(len(rv.notice_items("agents-ns", later, days=30)[0]["volumes"]), 2)

    def test_지울_때_적은_에이전트_이름과_주인_이름을_항목에_싣는다(self):
        """스펙 2026-10-19-003: 지운 뒤에는 등록부에 이름이 없어 지울 때 적는다. 그 전에 지운 것은 빈 값(화면이 이메일 · id 를 보인다)."""
        rv.record_deletion("aas-agent-a-1111", "a@x.com", "admin@x.com", "", T0 - timedelta(days=40), agent_name="영업 도우미", owner_name="김에이")
        rv.record_deletion("aas-agent-b-2222", "b@x.com", "admin@x.com", "", T0 - timedelta(days=40))
        rv.scan([pvc("data-aas-agent-a-1111-0"), pvc("data-aas-agent-b-2222-0")], set(), T0)
        vols = {v["agent"]: v for v in rv.notice_items("ns", T0, days=30)[0]["volumes"]}
        self.assertEqual((vols["aas-agent-a-1111"]["agent_name"], vols["aas-agent-a-1111"]["owner_name"]), ("영업 도우미", "김에이"))
        self.assertEqual((vols["aas-agent-b-2222"]["agent_name"], vols["aas-agent-b-2222"]["owner_name"]), ("", ""))

    def test_처리했습니다_뒤에는_같은_기간이_지날_때까지_다시_알리지_않는다(self):
        rv.record_deletion("aas-agent-a-1111", "a@x.com", "admin@x.com", "", T0 - timedelta(days=30))
        rv.scan([pvc("data-aas-agent-a-1111-0")], set(), T0)
        item = rv.notice_items("ns", T0, days=30)[0]
        rv.ack(item["id"], "admin@x.com", T0)
        self.assertEqual(rv.notice_items("ns", T0 + timedelta(days=29), days=30), [])
        self.assertEqual(len(rv.notice_items("ns", T0 + timedelta(days=30), days=30)), 1)

    def test_볼륨이_사라지면_기록도_지운다(self):
        rv.record_deletion("aas-agent-a-1111", "a@x.com", "admin@x.com", "", T0 - timedelta(days=40))
        rv.scan([pvc("data-aas-agent-a-1111-0")], set(), T0)
        rv.scan([], set(), T0)
        self.assertEqual(rv.notice_items("ns", T0, days=30), [])
        with store.connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM retained_volumes").fetchone()[0], 0)

    def test_같은_이름으로_다시_만든_에이전트의_볼륨은_남은_볼륨이_아니다(self):
        rv.record_deletion("aas-agent-a-1111", "a@x.com", "admin@x.com", "", T0 - timedelta(days=40))
        self.assertEqual(rv.scan([pvc("data-aas-agent-a-1111-0")], {"aas-agent-a-1111"}, T0), [])
        self.assertEqual(rv.notice_items("ns", T0, days=30), [])

    def test_기간이_0_이면_끄고_설정값을_읽는다(self):
        rv.record_deletion("aas-agent-a-1111", "a@x.com", "admin@x.com", "", T0 - timedelta(days=400))
        rv.scan([pvc("data-aas-agent-a-1111-0")], set(), T0)
        self.assertEqual(rv.notice_items("ns", T0, days=0), [])
        with mock.patch.dict(os.environ, {"AAS_RETAINED_VOLUME_NOTICE_DAYS": "0"}):
            self.assertEqual(rv.notice_days(), 0)
        with mock.patch.dict(os.environ, {"AAS_RETAINED_VOLUME_NOTICE_DAYS": "x"}):
            self.assertEqual(rv.notice_days(), 30)
        self.assertEqual(rv.notice_days(), 30)

    def test_모르는_항목_id_로_처리하면_거절한다(self):
        with self.assertRaises(ValueError):
            rv.ack("rvol|nope", "admin@x.com", T0)


class ServerWiringTest(unittest.TestCase):
    """받은편지함·「처리했습니다」·하루 1회 점검에 붙인 곳."""

    def setUp(self):
        with store.connect() as conn:
            conn.executescript(rv.SCHEMA)
            conn.execute("DELETE FROM retained_volumes")
        rv.record_deletion("aas-agent-a-1111", "a@x.com", "admin@x.com", "", datetime.now().astimezone() - timedelta(days=45))
        rv.scan([pvc("data-aas-agent-a-1111-0")], set())
        self.reg = mock.Mock(pods=[], is_admin=lambda u: (u or {}).get("email") == "admin@x.com")

    def items(self, who):
        with mock.patch.dict(os.environ, {"AAS_K8S_NAMESPACE": "agents-ns"}):
            return [i for i in server._office_inbox(self.reg, {"email": who})["items"] if i["kind"] == "retained_volume"]

    def test_관리자_받은편지함에만_항목이_있고_처리하면_사라진다(self):
        self.assertEqual(self.items("u@x.com"), [])
        got = self.items("admin@x.com")
        self.assertEqual([v["pvc"] for v in got[0]["volumes"]], ["data-aas-agent-a-1111-0"])
        with self.assertRaises(Denied):
            server._office_inbox_answer(self.reg, {"email": "u@x.com"}, True, {"id": got[0]["id"], "choice": "handled"})
        self.assertEqual(server._office_inbox_answer(self.reg, {"email": "admin@x.com"}, True, {"id": got[0]["id"], "choice": "handled"}), {"ok": True})
        self.assertEqual(self.items("admin@x.com"), [])
        with self.assertRaises(office.OfficeError):                                    # 다시 누르면(목록이 바뀜) 다시 읽으라고 알린다
            server._office_inbox_answer(self.reg, {"email": "admin@x.com"}, True, {"id": got[0]["id"], "choice": "handled"})

    def test_쿠버네티스_모드가_아니면_항목이_없다(self):
        with mock.patch.dict(os.environ, {"AAS_K8S_NAMESPACE": ""}):
            self.assertEqual([i for i in server._office_inbox(self.reg, {"email": "admin@x.com"})["items"] if i["kind"] == "retained_volume"], [])

    def test_하루_1회_점검이_PVC_를_읽어_남은_볼륨을_기록한다(self):
        client = mock.Mock(namespace="agents-ns")
        client.list_agents.return_value = [{"metadata": {"name": "aas-agent-live-2222"}}]
        client.list_pvcs.return_value = [pvc("data-aas-agent-live-2222-0"), pvc("data-aas-agent-gone-3333-0")]
        reg = mock.Mock(pods=[])
        with mock.patch.object(server.k8s, "client", return_value=client), mock.patch.object(server, "registry", return_value=reg), \
                mock.patch.object(server.keycloak, "admin_from_config", return_value=None), mock.patch.object(server.lifecycle, "run_idle", return_value=[]):
            out = server.lifecycle_once()
        self.assertEqual(out["retained"], 1)                                          # a-1111 은 PVC 목록에 없어 사라지고 gone-3333 만 남는다
        with store.connect() as conn:
            self.assertEqual([r["pvc"] for r in conn.execute("SELECT pvc FROM retained_volumes")], ["data-aas-agent-gone-3333-0"])

    def test_표는_PostgreSQL_이전_목록에_있다(self):
        self.assertIn(rv.SCHEMA, dbmigrate.schema_scripts())


class ColumnMigrationTest(unittest.TestCase):
    """연결마다 ALTER TABLE … ADD COLUMN IF NOT EXISTS 를 보냈다. PostgreSQL 은 열이 있어도 표 전체 잠금을 잡고 WAL 쓰기
    COMMIT 을 기다려, OKE 느린 문장 로그에 일주일 89번(0.5~2.2초) 남았다(스펙 2026-10-28-009 R1)."""

    def setUp(self):
        with store.connect() as conn:
            conn.executescript(rv.SCHEMA)

    def test_두_번째_연결부터는_열_확인도_ALTER_도_보내지_않는다(self):
        rv._MIGRATED.clear()
        with mock.patch.object(rv.db, "columns", wraps=rv.db.columns) as cols, \
                mock.patch.object(rv.db, "add_column", wraps=rv.db.add_column) as add:
            with rv._conn():
                pass
            first = (cols.call_count, add.call_count)
            for _ in range(3):
                with rv._conn():
                    pass
        self.assertGreaterEqual(first[0], 1)                         # 처음 한 번은 열 목록을 본다(없는 열은 add_column 도 본다)
        self.assertEqual((cols.call_count, add.call_count), first)

    def test_열이_없는_옛_표는_처음_연결에서_열을_더한다(self):
        with store.connect() as conn:                                   # 옛 DB: 두 열이 없는 retained_volumes
            conn.execute("DROP TABLE retained_volumes")
            conn.execute("CREATE TABLE retained_volumes (pvc TEXT PRIMARY KEY, agent TEXT NOT NULL, owner TEXT NOT NULL DEFAULT '', "
                         "deleted_by TEXT NOT NULL DEFAULT '', deleted_at TEXT NOT NULL DEFAULT '', first_seen TEXT NOT NULL DEFAULT '', "
                         "export TEXT NOT NULL DEFAULT '', size TEXT NOT NULL DEFAULT '', acked_at TEXT NOT NULL DEFAULT '', acked_by TEXT NOT NULL DEFAULT '')")
        rv._MIGRATED.clear()
        with rv._conn() as conn:
            cols = rv.db.columns(conn, "retained_volumes")
        self.assertTrue({"agent_name", "owner_name"} <= cols)


if __name__ == "__main__":
    unittest.main()
