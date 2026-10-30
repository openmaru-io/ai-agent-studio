# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""회의 파일 공유 시험(스펙 office/meeting-file-sharing §4-9, §12-5).

- 저장·한도·정리(aas/office/meeting_files.py): 임시 폴더를 공유 볼륨 대신 쓴다. 실제 NFS 는 아니다.
- 라우트(aas/web/meeting_files.py): 실제 uvicorn + 실제 사이드카 + 가짜 로그인(방 구성원 확인은 실제 office_access).
"""
import aasserver  # 실제 uvicorn 앱을 띄우는 시험 하네스
import http.client
import json
import os
import socket
import stat
import sys
import tempfile
import threading
import time
import unicodedata
import unittest
import urllib.parse
from datetime import datetime, timedelta
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sidecar"))
from aas_sidecar import ops as sc_ops, server as sc_server  # noqa: E402

from aas.fleet import pods  # noqa: E402
from aas.hermes import attach_notice, workspace as wsp  # noqa: E402
from aas.office import meeting, meeting_files as mf, office  # noqa: E402
from aas.office.meeting_files import FileError  # noqa: E402
from aas.web import files as web_files, server  # noqa: E402

ENV_KEYS = ("AAS_MEETING_SHARED_IN", "AAS_MEETING_SHARED_OUT", "AAS_MEETING_FILE_MAX", "AAS_MEETING_ROOM_QUOTA", "AAS_MEETING_FILES_QUOTA")
TOKEN = "t0ken-for-tests-0123456789"


def slurp(opened) -> bytes:
    """mf.open_file·open_out 이 돌려준 (파일 객체, 크기, 이름) 의 내용을 읽고 닫는다."""
    with opened[0] as fh:
        return fh.read()


def clean_tables():
    with mf._db() as conn:
        conn.execute("DELETE FROM office_files")
    with office.connect() as conn:
        for t in ("office_seats", "office_rooms", "office_room_members"):
            conn.execute(f"DELETE FROM {t}")
    with meeting._db() as conn:
        conn.execute("DELETE FROM office_messages")


class SharedEnv(unittest.TestCase):
    """공유 볼륨 대신 임시 폴더 둘을 쓰고 한도 환경 변수를 되돌린다."""

    def setUp(self):
        self.old = {k: os.environ.get(k) for k in ENV_KEYS}
        self.tmp = tempfile.TemporaryDirectory()
        self.shared_in = Path(self.tmp.name) / "shared-in"
        self.shared_out = Path(self.tmp.name) / "shared-out"
        self.shared_in.mkdir()
        self.shared_out.mkdir()
        os.environ["AAS_MEETING_SHARED_IN"] = str(self.shared_in)
        os.environ["AAS_MEETING_SHARED_OUT"] = str(self.shared_out)
        for k in ENV_KEYS[2:]:
            os.environ.pop(k, None)
        mf._marked.clear()
        clean_tables()
        self.addCleanup(self.restore)

    def restore(self):
        clean_tables()
        for k, v in self.old.items():
            os.environ.pop(k, None)
            if v is not None:
                os.environ[k] = v
        self.tmp.cleanup()

    def put(self, room=1, name="a.txt", data=b"hello", who="kim@x.com") -> dict:
        up = mf.begin(room, name, len(data), who)
        up.write(data)
        return up.finish()


# ---- 저장·한도·정리 -------------------------------------------------------------------------------------
class StorageTest(SharedEnv):
    def test_upload_lands_in_room_and_date_folder_with_agent_readable_modes(self):
        out = self.put(7, "보고서.txt", b"abc")
        today = datetime.now(wsp._KST).strftime("%Y-%m-%d")
        path = self.shared_in / "7" / today / f"{out['id']}-보고서.txt"
        self.assertEqual((out["name"], out["size"], out["date"], out["status"]), ("보고서.txt", 3, today, "ready"))
        self.assertEqual(path.read_bytes(), b"abc")
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o644)               # 에이전트가 읽을 수 있게
        self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE(path.parent.parent.stat().st_mode), 0o755)
        self.assertEqual(list(path.parent.glob("*.part")), [])
        self.assertEqual(len(out["id"]), 12)
        self.assertEqual(mf.pod_path(7, {"date": today, "id": out["id"], "name": "보고서.txt"}),
                         f"workspace/uploads/aas-shared/7/{today}/{out['id']}-보고서.txt")

    def test_same_name_twice_gets_different_ids_and_never_overwrites(self):
        a, b = self.put(1, "x.csv", b"one"), self.put(1, "x.csv", b"two")
        self.assertNotEqual(a["id"], b["id"])
        self.assertEqual(slurp(mf.open_file(1, a["id"])), b"one")
        self.assertEqual(slurp(mf.open_file(1, b["id"])), b"two")

    def test_names_are_cleaned_like_chat_files(self):
        nfd = unicodedata.normalize("NFD", "스크린샷 2026.png")
        out = self.put(1, "../../etc/pass\\wd\x00.txt")
        self.assertNotIn("/", out["name"] + "\\")
        self.assertEqual(out["name"], "..etcpasswd.txt".strip("."))
        self.assertTrue((self.shared_in / "1" / out["date"] / f"{out['id']}-{out['name']}").is_file())
        self.assertEqual(self.put(1, nfd)["name"], "스크린샷 2026.png")                  # macOS 자모 분리형 → 완성형
        self.assertEqual([p.name for p in self.shared_in.iterdir() if p.name != wsp.SHARED_MARKER], ["1"])   # 루트 밖으로 새지 않는다

    def test_marker_file_is_written_by_the_server_on_first_use(self):
        self.assertFalse((self.shared_in / wsp.SHARED_MARKER).exists())
        self.put()
        self.assertTrue((self.shared_in / wsp.SHARED_MARKER).is_file())
        self.assertTrue((self.shared_out / wsp.SHARED_MARKER).is_file())

    def test_disabled_without_a_writable_folder(self):
        os.environ["AAS_MEETING_SHARED_IN"] = str(self.shared_in / "nope")
        self.assertFalse(mf.enabled())
        with self.assertRaises(FileError) as cm:
            mf.begin(1, "a", 1, "k")
        self.assertEqual((cm.exception.code, cm.exception.status), ("not_configured", 501))
        os.environ.pop("AAS_MEETING_SHARED_IN")
        self.assertEqual(mf.info()["enabled"], False)

    def test_info_reports_limits_and_defaults(self):
        self.assertEqual(mf.info(), {"enabled": True, "limits": {"file": 25 * 1024 ** 2, "room": 500 * 1024 ** 2, "total": 5 * 1024 ** 3}, "max_per_message": 10})
        os.environ["AAS_MEETING_FILE_MAX"] = "10"
        self.assertEqual(mf.info()["limits"]["file"], 10)

    def test_three_limits(self):
        os.environ.update(AAS_MEETING_FILE_MAX="10", AAS_MEETING_ROOM_QUOTA="15", AAS_MEETING_FILES_QUOTA="22")
        with self.assertRaises(FileError) as cm:
            mf.begin(1, "big", 11, "k")
        self.assertEqual((cm.exception.code, cm.exception.status), ("too_large", 413))
        self.put(1, "a", b"x" * 10)
        with self.assertRaises(FileError) as cm:                                        # 방 1: 10 + 6 > 15
            mf.begin(1, "b", 6, "k")
        self.assertEqual((cm.exception.code, cm.exception.status), ("room_quota", 413))
        self.put(2, "c", b"x" * 10)                                                    # 다른 방은 따로 센다
        with self.assertRaises(FileError) as cm:                                        # 서버 전체: 20 + 3 > 22
            mf.begin(3, "d", 3, "k")
        self.assertEqual((cm.exception.code, cm.exception.status), ("total_quota", 413))
        self.put(3, "e", b"x" * 2)                                                     # 22 까지는 된다
        with self.assertRaises(FileError):
            mf.begin(3, "f", 0, "k")                                                   # 빈 파일은 거절

    def test_started_upload_counts_toward_the_limit_before_it_finishes(self):
        os.environ["AAS_MEETING_ROOM_QUOTA"] = "100"
        first = mf.begin(1, "a", 60, "k")                                               # 아직 쓰지 않은 uploading 행
        with self.assertRaises(FileError) as cm:
            mf.begin(1, "b", 60, "k")
        self.assertEqual(cm.exception.code, "room_quota")
        first.abort()
        mf.begin(1, "b", 60, "k").abort()                                               # 끊긴 올리기는 합계에서 빠진다

    def test_concurrent_uploads_cannot_pass_the_room_quota_together(self):
        os.environ["AAS_MEETING_ROOM_QUOTA"] = "100"
        barrier, results = threading.Barrier(6), []

        def worker(i):
            barrier.wait()
            try:
                results.append(mf.begin(1, f"f{i}", 40, "k"))
            except FileError as exc:
                results.append(exc.code)
        threads = [threading.Thread(target=worker, args=(i,)) for i in range(6)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        ups = [r for r in results if isinstance(r, mf.Upload)]
        self.assertEqual(len(ups), 2)                                                   # 40 * 2 = 80 ≤ 100 < 120
        self.assertEqual(sorted(r for r in results if isinstance(r, str)), ["room_quota"] * 4)
        with mf._db() as conn:
            self.assertEqual(conn.execute("SELECT COALESCE(SUM(size),0) FROM office_files WHERE room=1").fetchone()[0], 80)

    def test_aborted_upload_leaves_no_part_file_and_no_row(self):
        up = mf.begin(1, "cut.bin", 10, "k")
        up.write(b"12345")
        part = Path(up.part)
        self.assertTrue(part.exists())
        up.abort()
        up.abort()                                                                      # 두 번 불러도 안전
        self.assertFalse(part.exists())
        with mf._db() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM office_files").fetchone()[0], 0)

    def test_short_or_long_body_is_refused_and_cleaned(self):
        up = mf.begin(1, "short", 10, "k")
        up.write(b"123")
        with self.assertRaises(FileError):
            up.finish()
        up.abort()
        up = mf.begin(1, "long", 3, "k")
        with self.assertRaises(FileError):
            up.write(b"12345")
        up.abort()
        self.assertEqual([p for p in (self.shared_in / "1").rglob("*") if p.is_file()], [])

    def test_unattached_files_older_than_a_day_are_purged_on_the_next_upload(self):
        old, fresh, kept = self.put(1, "old"), self.put(1, "fresh"), self.put(1, "kept")
        stale = (datetime.now().astimezone() - timedelta(hours=25)).isoformat(timespec="seconds")
        with mf._db() as conn:
            conn.execute("UPDATE office_files SET ts=? WHERE id IN (?,?)", (stale, old["id"], kept["id"]))
        mf.attach([kept["id"]], 5)                                                      # 말에 연결된 파일은 오래돼도 남는다
        old_path = self.shared_in / "1" / old["date"] / f"{old['id']}-old"
        self.assertTrue(old_path.exists())
        self.put(1, "next")
        self.assertFalse(old_path.exists())
        ids = {r["id"] for r in mf.listing(1)["files"]}
        self.assertEqual(ids & {old["id"], fresh["id"], kept["id"]}, {fresh["id"], kept["id"]})

    def test_listing_carries_display_names_for_uploaders_and_agents(self):
        self.put(1, "a.txt", who="kim@x.com")
        self.assertEqual(mf.listing(1)["labels"], {"kim@x.com": "kim"})                  # 이름을 모르면 이메일 앞부분(스펙 2026-10-20-025 §6)

    def test_orphan_uploading_rows_older_than_a_day_are_purged_too(self):
        crashed = mf.begin(1, "crash.bin", 50, "k")                                      # 서버가 죽어 끝나지 않은 올리기
        crashed.write(b"x" * 10)
        stale = (datetime.now().astimezone() - timedelta(hours=30)).isoformat(timespec="seconds")
        with mf._db() as conn:
            conn.execute("UPDATE office_files SET ts=?", (stale,))
        self.put(1, "fresh")
        self.assertFalse(Path(crashed.part).exists())
        with mf._db() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM office_files WHERE status='uploading'").fetchone()[0], 0)

    def test_files_of_another_room_are_not_readable_or_deletable_by_id(self):
        out = self.put(1, "a.txt", b"secret")
        with self.assertRaises(FileError) as cm:
            mf.open_file(2, out["id"])
        self.assertEqual((cm.exception.code, cm.exception.status), ("no_file", 404))
        with self.assertRaises(FileError):
            mf.remove(2, out["id"], "kim@x.com", True)
        self.assertEqual(slurp(mf.open_file(1, out["id"])), b"secret")

    def test_only_uploader_or_admin_can_delete(self):
        out = self.put(1, "a.txt", who="kim@x.com")
        path = self.shared_in / "1" / out["date"] / f"{out['id']}-a.txt"
        with self.assertRaises(FileError) as cm:
            mf.remove(1, out["id"], "lee@x.com", False)
        self.assertEqual((cm.exception.code, cm.exception.status), ("forbidden", 403))
        self.assertTrue(path.exists())
        mf.remove(1, out["id"], "kim@x.com", False)
        self.assertFalse(path.exists())
        out2 = self.put(1, "b.txt", who="kim@x.com")
        mf.remove(1, out2["id"], "boss@x.com", True)
        self.assertEqual(mf.listing(1)["files"], [])

    def test_claim_accepts_only_ready_unattached_files_of_the_room(self):
        a, b = self.put(1, "a"), self.put(2, "b")
        self.assertEqual([r["id"] for r in mf.claim(1, [a["id"]])], [a["id"]])
        for ids in (["nope"], [b["id"]]):                                                # 없음·다른 방
            with self.assertRaises(FileError) as cm:
                mf.claim(1, ids)
            self.assertEqual((cm.exception.code, cm.exception.status), ("bad_file", 400))
        mf.attach([a["id"]], 9)
        with self.assertRaises(FileError):
            mf.claim(1, [a["id"]])                                                       # 이미 말에 연결됨

    def test_delete_room_removes_folders_and_rows(self):
        self.put(5, "a")
        (self.shared_out / "5" / "sa" / "2026-10-15").mkdir(parents=True)
        (self.shared_out / "5" / "sa" / "2026-10-15" / "o.txt").write_text("x")
        self.put(6, "keep")
        mf.delete_room(5)
        self.assertFalse((self.shared_in / "5").exists())
        self.assertFalse((self.shared_out / "5").exists())
        self.assertTrue((self.shared_in / "6").exists())
        self.assertEqual(mf.listing(5)["files"], [])
        self.assertEqual(len(mf.listing(6)["files"]), 1)

    def test_deleting_a_room_deletes_its_meeting_files(self):
        room = office.set_room({"name": "삭제할 방", "seats": []}, "me")["id"]
        self.put(room, "a")
        office.delete_room(room)
        self.assertFalse((self.shared_in / str(room)).exists())
        self.assertEqual(mf.listing(room)["files"], [])

    def test_deleting_a_room_still_works_when_file_cleanup_fails(self):
        room = office.set_room({"name": "정리 실패 방", "seats": []}, "me")["id"]
        old = mf.delete_room
        mf.delete_room = lambda rid: (_ for _ in ()).throw(RuntimeError("boom"))
        try:
            self.assertEqual(office.delete_room(room), {"ok": True})
        finally:
            mf.delete_room = old
        self.assertNotIn(room, [r["id"] for r in office.rooms()])


class PathSafetyTest(SharedEnv):
    def test_resolve_refuses_escapes_and_symlinks(self):
        for bad in ("../x", "/etc/passwd", "a/../../x", "a//b", "a/./b", "", "a\\b", "a\x00b"):
            with self.assertRaises(FileError, msg=bad):
                mf.resolve(self.shared_out, bad)
        (self.shared_out / "1").mkdir()
        (self.shared_out / "secret.txt").write_text("s")
        (self.shared_out / "1" / "link.txt").symlink_to(self.shared_out / "secret.txt")
        (self.shared_out / "linkdir").symlink_to(self.shared_in)
        with self.assertRaises(FileError):
            mf.resolve(self.shared_out, "1/link.txt")
        with self.assertRaises(FileError):
            mf.resolve(self.shared_out, "linkdir/x")
        self.assertEqual(mf.resolve(self.shared_out, "1/new.txt"), self.shared_out / "1" / "new.txt")

    def test_open_out_stays_inside_the_room_folder(self):
        (self.shared_out / "1" / "sa" / "2026-10-15").mkdir(parents=True)
        (self.shared_out / "2").mkdir()
        (self.shared_out / "2" / "other.txt").write_text("남의 방")
        (self.shared_out / "1" / "sa" / "2026-10-15" / "r.txt").write_text("결과")
        (self.shared_out / "1" / "sa" / "2026-10-15" / "link.txt").symlink_to(self.shared_out / "2" / "other.txt")
        (self.shared_out / "1" / ".hidden").write_text("h")
        self.assertEqual(slurp(mf.open_out(1, "sa/2026-10-15/r.txt")), "결과".encode())
        for bad in ("../2/other.txt", "/etc/passwd", "sa/2026-10-15/link.txt", ".hidden", "sa/..", "sa/2026-10-15", "x.upload"):
            with self.assertRaises(FileError, msg=bad):
                mf.open_out(1, bad)

    def test_scan_out_lists_agent_files_from_disk(self):
        base = self.shared_out / "3"
        (base / "sa" / "2026-10-14").mkdir(parents=True)
        (base / "doc" / "2026-10-15").mkdir(parents=True)
        (base / "sa" / "2026-10-14" / "a.md").write_text("aaa")
        (base / "doc" / "2026-10-15" / "b.csv").write_text("bb")
        (base / "doc" / "2026-10-15" / ".tmp").write_text("x")
        (base / "doc" / "2026-10-15" / "c.csv.upload").write_text("x")
        (base / "doc" / "2026-10-15" / "link").symlink_to(base / "sa" / "2026-10-14" / "a.md")
        (self.shared_out / "4").mkdir()
        (self.shared_out / "4" / "other.txt").write_text("다른 방")
        out, truncated = mf.scan_out(3)
        self.assertFalse(truncated)
        self.assertEqual({(f["path"], f["alias"], f["date"], f["name"], f["size"]) for f in out},
                         {("sa/2026-10-14/a.md", "sa", "2026-10-14", "a.md", 3), ("doc/2026-10-15/b.csv", "doc", "2026-10-15", "b.csv", 2)})
        self.assertTrue(all(isinstance(f["mtime"], float) for f in out))
        self.assertEqual(mf.scan_out(99), ([], False))

    def test_listing_carries_files_agents_made_in_their_own_workspace(self):
        """에이전트가 공유 출력 폴더가 아니라 자기 작업 폴더에 쓴 파일(결과 칩 행)도 「자료」 서랍에 보인다(2026-10-20 OKE 실화면)."""
        chip = lambda room, alias, files: meeting._append(room, "system", alias, "", meeting.CHIP_NOTE, {"pod": "w", "files": files})  # noqa: E731
        first = chip(3, "aas-user1", [{"path": "workspace/aas-product-features.md", "name": "aas-product-features.md", "size": 6300}])
        meeting._append(3, "system", "aas-user1", "경고 행")                                              # 칩이 아닌 시스템 행
        meeting._append(3, "agent", "aas-user1", "작성했습니다")
        chip(4, "doc", [{"path": "workspace/other.md", "name": "other.md", "size": 1}])                   # 다른 방
        last = chip(3, "aas-user1", [{"path": "workspace/aas-product-features.md", "name": "aas-product-features.md", "size": 6400},
                                     {"path": "workspace/notes/a.csv", "name": "a.csv", "size": 9},
                                     {"path": "state.db", "name": "state.db", "size": 1}])                # workspace 밖은 받을 수 없다
        made = mf.listing(3)["made"]
        self.assertEqual([(f["msg"], f["n"], f["alias"], f["name"], f["size"], f["path"]) for f in made],
                         [(last, 0, "aas-user1", "aas-product-features.md", 6400, "workspace/aas-product-features.md"),
                          (last, 1, "aas-user1", "a.csv", 9, "workspace/notes/a.csv")])
        self.assertTrue(all(f["ts"] for f in made))
        self.assertNotEqual(first, last)
        chip(3, "doc", [{"path": "workspace/put.md", "name": "put.md", "size": 1, "room": "abc"},          # 자동으로 방에 올라간 것은 「올린 파일」에 보인다
                        {"path": "workspace/big.zip", "name": "big.zip", "size": 1, "skip": "too_large"}])
        self.assertEqual([(f["alias"], f["name"]) for f in mf.listing(3)["made"]][:1], [("doc", "big.zip")])
        self.assertEqual(mf.listing(99)["made"], [])

    def test_scan_out_is_capped(self):
        d = self.shared_out / "1" / "sa" / "2026-10-15"
        d.mkdir(parents=True)
        for i in range(7):
            (d / f"f{i}").write_text("x")
        old = mf.OUT_LIMIT
        mf.OUT_LIMIT = 5
        try:
            out, truncated = mf.scan_out(1)
        finally:
            mf.OUT_LIMIT = old
        self.assertEqual((len(out), truncated), (5, True))


class AttachNoticeTest(unittest.TestCase):
    def test_meeting_note_is_added_only_when_asked_and_parse_removes_it(self):
        f = [{"name": "a.xlsx", "size": 1024, "path": "workspace/uploads/aas-shared/1/2026-10-15/ab12-a.xlsx"}]
        plain = attach_notice.build("봐 줘", f)
        noted = attach_notice.build("봐 줘", f, note=True)
        self.assertNotIn(attach_notice.MEETING_NOTE, plain)
        self.assertEqual(noted, "봐 줘\n\n" + attach_notice.MEETING_NOTE + "\n" + plain.split("\n\n", 1)[1])
        self.assertEqual(attach_notice.parse(noted), attach_notice.parse(plain))
        self.assertEqual(attach_notice.build("그대로", [], note=True), "그대로")           # 파일이 없으면 글 그대로


# ---- 라우트 -----------------------------------------------------------------------------------------
class FakeAuth:
    enabled = True

    def user(self, cookie):
        for part in (cookie or "").split(";"):
            if part.strip().startswith("u="):
                email = part.strip()[2:]
                return {"email": email, "admin": email == "admin@x.com"}
        return None


MEMBER, OTHER, ADMIN, STRANGER = "kim@x.com", "lee@x.com", "admin@x.com", "out@x.com"


class RoutesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.old = {k: os.environ.get(k) for k in ENV_KEYS + ("AAS_USERS_FILE", "AAS_ALLOWED_HOSTS", "AAS_PODS_FILE", "AAS_TRUSTED_PROXY", "AAS_SIDECAR_TOKEN")}
        for k in cls.old:
            os.environ.pop(k, None)
        cls.tmp = tempfile.TemporaryDirectory()
        base = Path(cls.tmp.name)
        cls.shared_in, cls.shared_out = base / "in", base / "out"
        cls.shared_in.mkdir()
        cls.shared_out.mkdir()
        cls.root = base / "agent"
        (cls.root / "workspace" / "outputs").mkdir(parents=True)
        (cls.root / "state.db").write_bytes(b"SQLITE-CHAT-HISTORY")
        (cls.root / "workspace" / "outputs" / "report.txt").write_bytes("에이전트 보고서".encode())
        (cls.root / "workspace" / "outputs" / "db-link").symlink_to(cls.root / "state.db")
        os.environ.update(AAS_SIDECAR_TOKEN=TOKEN, AAS_MEETING_SHARED_IN=str(cls.shared_in), AAS_MEETING_SHARED_OUT=str(cls.shared_out))
        cls.sidecar = sc_server.make_server("127.0.0.1", 0, sc_ops.Ops(cls.root), TOKEN)
        threading.Thread(target=cls.sidecar.serve_forever, daemon=True).start()
        reg = base / "pods.json"
        reg.write_text(json.dumps({"pods": [{"id": "w", "owner": "owner@x.com", "hermes_home": "/nonexistent",
                                             "sidecar_url": f"http://127.0.0.1:{cls.sidecar.server_address[1]}",
                                             "dashboard_url": "http://127.0.0.1:9"}]}))
        cls.saved = (server._auth, server._registry, server.auth)
        server._registry = pods.Registry(reg)
        fake = FakeAuth()
        server.auth = lambda: fake
        server._hubs.clear()
        server._workspaces.clear()
        mf._marked.clear()
        clean_tables()
        office.set_seat({"pod": "w", "profile": "sa"}, "me", {"w": {"sa"}})
        cls.room = office.set_room({"name": "제안", "seats": ["sa"], "members": [MEMBER, OTHER]}, "me")["id"]
        cls.room2 = office.set_room({"name": "다른 방", "seats": ["sa"], "members": [MEMBER]}, "me")["id"]
        cls.httpd = aasserver.start()
        cls.port = cls.httpd.server_port

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.sidecar.shutdown()
        clean_tables()
        server._auth, server._registry, server.auth = cls.saved
        server._hubs.clear()
        server._workspaces.clear()
        for k, v in cls.old.items():
            os.environ.pop(k, None)
            if v is not None:
                os.environ[k] = v
        cls.tmp.cleanup()

    def setUp(self):
        with mf._db() as conn:
            conn.execute("DELETE FROM office_files")
        for d in (self.shared_in, self.shared_out):
            for p in d.iterdir():
                if p.is_dir():
                    import shutil
                    shutil.rmtree(p)
        with meeting._db() as conn:
            conn.execute("DELETE FROM office_messages")
        for k in ENV_KEYS[2:]:
            os.environ.pop(k, None)

    def req(self, method, path, body=None, who=MEMBER, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        h = {"X-AAS": "1"} if method != "GET" else {}
        if who:
            h["Cookie"] = f"u={who}"
        h.update(headers or {})
        c.request(method, path, body=body, headers=h)
        r = c.getresponse()
        data = r.read()
        c.close()
        return r, data

    def put(self, name="a.txt", data=b"hello", room=None, who=MEMBER):
        return self.req("PUT", f"/api/office/meeting/files?room={room or self.room}&name={urllib.parse.quote(name)}", body=data, who=who)

    def jput(self, *a, **k):
        r, raw = self.put(*a, **k)
        return r.status, json.loads(raw)

    def test_upload_list_download_delete_roundtrip(self):
        status, out = self.jput("매출 표.csv", b"a,b\n1,2\n")
        self.assertEqual(status, 200, out)
        self.assertEqual((out["name"], out["size"], out["status"]), ("매출 표.csv", 8, "ready"))
        on_disk = self.shared_in / str(self.room) / out["date"] / f"{out['id']}-매출 표.csv"
        self.assertEqual(on_disk.read_bytes(), b"a,b\n1,2\n")
        self.assertEqual(stat.S_IMODE(on_disk.stat().st_mode), 0o644)
        r, raw = self.req("GET", f"/api/office/meeting/files?room={self.room}", who=OTHER)                # 같은 방의 다른 구성원도 본다
        listing = json.loads(raw)
        self.assertEqual(r.status, 200)
        self.assertEqual([(f["id"], f["name"], f["uploader"], f["msg"]) for f in listing["files"]], [(out["id"], "매출 표.csv", MEMBER, None)])
        self.assertEqual(listing["used"], {"room": 8, "total": 8})
        self.assertEqual((listing["out"], listing["out_truncated"]), ([], False))
        r, raw = self.req("GET", f"/api/office/meeting/files/{out['id']}?room={self.room}", who=OTHER)
        self.assertEqual((r.status, raw), (200, b"a,b\n1,2\n"))
        self.assertIn("attachment", r.getheader("Content-Disposition"))
        self.assertIn(urllib.parse.quote("매출 표.csv"), r.getheader("Content-Disposition"))
        self.assertEqual(r.getheader("X-Content-Type-Options"), "nosniff")
        r, raw = self.req("DELETE", f"/api/office/meeting/files/{out['id']}?room={self.room}", who=OTHER)   # 올린 사람이 아니면 거절
        self.assertEqual((r.status, json.loads(raw)), (403, {"error": "forbidden"}))
        r, raw = self.req("DELETE", f"/api/office/meeting/files/{out['id']}?room={self.room}", who=MEMBER)
        self.assertEqual((r.status, json.loads(raw)), (200, {"ok": True}))
        self.assertFalse(on_disk.exists())
        r, raw = self.req("GET", f"/api/office/meeting/files/{out['id']}?room={self.room}")
        self.assertEqual((r.status, json.loads(raw)), (404, {"error": "no_file"}))

    def test_admin_can_delete_anyones_file(self):
        _, out = self.jput()
        r, _ = self.req("DELETE", f"/api/office/meeting/files/{out['id']}?room={self.room}", who=ADMIN)
        self.assertEqual(r.status, 200)

    def test_non_members_and_anonymous_are_refused(self):
        r, raw = self.put(who=STRANGER)
        self.assertEqual((r.status, json.loads(raw)), (403, {"error": "forbidden"}))
        self.assertEqual(list(self.shared_in.glob("*/*/*")), [])
        _, out = self.jput()
        for method, path in (("GET", f"/api/office/meeting/files?room={self.room}"), ("GET", f"/api/office/meeting/files/{out['id']}?room={self.room}"),
                             ("DELETE", f"/api/office/meeting/files/{out['id']}?room={self.room}"),
                             ("GET", f"/api/office/meeting/out?room={self.room}&path=sa/x/y"), ("GET", f"/api/office/meeting/agent-file?room={self.room}&msg=1&n=0")):
            r, raw = self.req(method, path, who=STRANGER)
            self.assertEqual((r.status, json.loads(raw)), (403, {"error": "forbidden"}), path)
            r, raw = self.req(method, path, who=None)
            self.assertEqual((r.status, json.loads(raw)), (401, {"error": "login"}), path)
        r, raw = self.req("GET", "/api/office/meeting/files?room=9999")
        self.assertEqual((r.status, json.loads(raw)), (404, {"error": "no_room"}))
        r, raw = self.req("GET", "/api/office/meeting/files?room=abc")
        self.assertEqual((r.status, json.loads(raw)), (400, {"error": "bad_request"}))

    def test_write_requests_need_the_same_origin_header(self):
        r, raw = self.req("PUT", f"/api/office/meeting/files?room={self.room}&name=a", body=b"x", headers={"X-AAS": ""})
        self.assertEqual((r.status, json.loads(raw)), (403, {"error": "forbidden"}))
        r, raw = self.req("GET", f"/api/office/meeting/files?room={self.room}", headers={"Sec-Fetch-Site": "cross-site"})
        self.assertEqual(r.status, 403)

    def test_another_rooms_file_id_is_not_readable_even_for_a_member_of_both(self):
        _, out = self.jput("secret.txt", b"s")
        r, raw = self.req("GET", f"/api/office/meeting/files/{out['id']}?room={self.room2}")           # MEMBER 는 두 방 모두 구성원
        self.assertEqual((r.status, json.loads(raw)), (404, {"error": "no_file"}))
        r, raw = self.req("DELETE", f"/api/office/meeting/files/{out['id']}?room={self.room2}")
        self.assertEqual(r.status, 404)
        r, raw = self.req("GET", f"/api/office/meeting/files/{out['id']}?room={self.room2}", who=OTHER)  # OTHER 는 room2 구성원이 아니다
        self.assertEqual(r.status, 403)

    def test_closed_room_refuses_uploads(self):
        closed = office.set_room({"name": "끝난 방", "seats": ["sa"], "members": [MEMBER], "status": "closed"}, "me")["id"]
        status, out = self.jput(room=closed)
        self.assertEqual((status, out), (409, {"error": "room_closed"}))

    def test_limits_return_413_and_nothing_is_left_behind(self):
        os.environ["AAS_MEETING_FILE_MAX"] = "4"
        self.assertEqual(self.jput("big", b"12345"), (413, {"error": "too_large"}))
        del os.environ["AAS_MEETING_FILE_MAX"]
        os.environ["AAS_MEETING_ROOM_QUOTA"] = "6"
        self.assertEqual(self.jput("a", b"1234")[0], 200)
        self.assertEqual(self.jput("b", b"1234"), (413, {"error": "room_quota"}))
        del os.environ["AAS_MEETING_ROOM_QUOTA"]
        os.environ["AAS_MEETING_FILES_QUOTA"] = "6"
        self.assertEqual(self.jput("c", b"1234", room=self.room2), (413, {"error": "total_quota"}))
        with mf._db() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM office_files").fetchone()[0], 1)

    def test_not_configured_returns_501_everywhere(self):
        os.environ.pop("AAS_MEETING_SHARED_IN")
        try:
            for method, path in (("GET", f"/api/office/meeting/files?room={self.room}"), ("GET", f"/api/office/meeting/files/x?room={self.room}")):
                r, raw = self.req(method, path)
                self.assertEqual((r.status, json.loads(raw)), (501, {"error": "not_configured"}))
            self.assertEqual(self.jput(), (501, {"error": "not_configured"}))
        finally:
            os.environ["AAS_MEETING_SHARED_IN"] = str(self.shared_in)

    def test_busy_when_all_transfer_slots_are_taken(self):
        taken = 0
        while web_files.SLOTS.take():
            taken += 1
        try:
            self.assertEqual(self.jput(), (429, {"error": "busy"}))
        finally:
            for _ in range(taken):
                web_files.SLOTS.give()
        self.assertEqual(web_files.SLOTS.used, 0)
        self.assertEqual(self.jput()[0], 200)
        self.assertEqual(web_files.SLOTS.used, 0)

    def test_dropped_connection_leaves_no_part_file_and_no_row(self):
        s = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        s.sendall((f"PUT /api/office/meeting/files?room={self.room}&name=cut.bin HTTP/1.1\r\nHost: 127.0.0.1\r\nX-AAS: 1\r\nCookie: u={MEMBER}\r\n"
                   "Content-Length: 100000\r\n\r\n").encode() + b"x" * 1000)
        time.sleep(0.5)
        s.close()
        end = time.time() + 5
        while time.time() < end:
            with mf._db() as conn:
                n = conn.execute("SELECT COUNT(*) FROM office_files").fetchone()[0]
            if n == 0:
                break
            time.sleep(0.1)
        self.assertEqual(n, 0)
        self.assertEqual([p for p in self.shared_in.rglob("*") if p.is_file() and p.name != wsp.SHARED_MARKER], [])
        self.assertEqual(web_files.SLOTS.used, 0)

    def test_agent_output_is_listed_from_disk_and_downloadable(self):
        d = self.shared_out / str(self.room) / "sa" / "2026-10-15"
        d.mkdir(parents=True)
        (d / "분석.md").write_text("결과 본문")
        (d / "x.upload").write_text("임시")
        (self.shared_out / str(self.room2)).mkdir()
        (self.shared_out / str(self.room2) / "other.txt").write_text("다른 방")
        (d / "peek").symlink_to(self.shared_out / str(self.room2) / "other.txt")
        r, raw = self.req("GET", f"/api/office/meeting/files?room={self.room}")
        out = json.loads(raw)["out"]
        self.assertEqual([(f["path"], f["alias"], f["date"], f["name"], f["size"]) for f in out], [("sa/2026-10-15/분석.md", "sa", "2026-10-15", "분석.md", len("결과 본문".encode()))])
        q = urllib.parse.quote
        r, raw = self.req("GET", f"/api/office/meeting/out?room={self.room}&path={q('sa/2026-10-15/분석.md')}")
        self.assertEqual((r.status, raw.decode()), (200, "결과 본문"))
        self.assertIn("attachment", r.getheader("Content-Disposition"))
        for bad in ("../2/other.txt", f"../{self.room2}/other.txt", "/etc/passwd", "sa/2026-10-15/peek", "sa/2026-10-15/x.upload", "sa/2026-10-15"):
            r, raw = self.req("GET", f"/api/office/meeting/out?room={self.room}&path={q(bad)}")
            self.assertIn(r.status, (400, 404), bad)
            self.assertNotIn("다른 방", raw.decode(), bad)

    def chip(self, room=None, path="workspace/outputs/report.txt", pod="w", alias="sa", extra=None) -> int:
        files = [{"path": path, "name": path.rsplit("/", 1)[-1], "size": 10}] + (extra or [])
        return meeting._append(room or self.room, "system", alias, "", "files", {"pod": pod, "files": files})

    def test_agent_file_downloads_only_recorded_paths(self):
        mid = self.chip(extra=[{"path": "state.db", "name": "state.db", "size": 1}, {"path": "workspace/outputs/db-link", "name": "db-link", "size": 1}])
        r, raw = self.req("GET", f"/api/office/meeting/agent-file?room={self.room}&msg={mid}&n=0", who=OTHER)     # 방 구성원 모두(결정 R2)
        self.assertEqual((r.status, raw.decode()), (200, "에이전트 보고서"))
        self.assertIn("attachment", r.getheader("Content-Disposition"))
        for n in (1, 5, -1, "x"):                                                         # 기록에 있어도 workspace 밖·없는 순번은 안 된다
            r, raw = self.req("GET", f"/api/office/meeting/agent-file?room={self.room}&msg={mid}&n={n}")
            self.assertIn(r.status, (400, 404), n)
            self.assertNotIn(b"SQLITE", raw)
        r, raw = self.req("GET", f"/api/office/meeting/agent-file?room={self.room}&msg={mid}&n=2")           # 심링크는 사이드카가 거절
        self.assertNotEqual(r.status, 200)
        self.assertNotIn(b"SQLITE", raw)
        r, raw = self.req("GET", f"/api/office/meeting/agent-file?room={self.room}&msg=99999&n=0")
        self.assertEqual((r.status, json.loads(raw)), (404, {"error": "no_file"}))

    def test_agent_file_refuses_another_rooms_record_and_non_file_rows(self):
        other = self.chip(room=self.room2)
        r, raw = self.req("GET", f"/api/office/meeting/agent-file?room={self.room}&msg={other}&n=0")
        self.assertEqual((r.status, json.loads(raw)), (404, {"error": "no_file"}))           # 다른 방 번호의 기록
        r, raw = self.req("GET", f"/api/office/meeting/agent-file?room={self.room2}&msg={other}&n=0", who=OTHER)
        self.assertEqual(r.status, 403)
        plain = meeting._append(self.room, "system", "sa", "경고 행")
        r, raw = self.req("GET", f"/api/office/meeting/agent-file?room={self.room}&msg={plain}&n=0")
        self.assertEqual(r.status, 404)

    def test_from_agent_copies_the_agent_file_into_the_room(self):
        mid = self.chip()
        r, raw = self.req("POST", "/api/office/meeting/files/from-agent", body=json.dumps({"room": self.room, "msg": mid, "n": 0}).encode())
        out = json.loads(raw)
        self.assertEqual((r.status, out["name"], out["status"], out["size"]), (200, "report.txt", "ready", len("에이전트 보고서".encode())))
        self.assertEqual((self.shared_in / str(self.room) / out["date"] / f"{out['id']}-report.txt").read_text(), "에이전트 보고서")
        with mf._db() as conn:
            self.assertEqual(conn.execute("SELECT from_alias, uploader, msg FROM office_files WHERE id=?", (out["id"],)).fetchone()[:], ("sa", MEMBER, mid))  # 칩 행에 연결해 24시간 정리에서 빠진다
        r, raw = self.req("POST", "/api/office/meeting/files/from-agent", body=json.dumps({"room": self.room, "msg": mid, "n": 0}).encode())
        again = json.loads(raw)
        self.assertEqual([f["id"] for f in mf.listing(self.room)["files"]], [again["id"]])          # 같은 파일을 다시 올리면 바꿔 넣는다
        r, raw = self.req("GET", f"/api/office/meeting/files?room={self.room}")
        self.assertEqual([f["id"] for f in json.loads(raw)["files"]], [again["id"]])
        self.assertEqual(web_files.SLOTS.used, 0)

    def test_agent_files_are_put_in_the_room_and_a_newer_copy_replaces_the_older(self):
        """턴이 끝나면 결과 파일을 방 자료에 자동으로 올리고, 같은 설치본·경로는 최신판 하나만 둔다(2026-10-20 결정 A)."""
        ws = server._workspace_for_pod_id("w")
        report = self.root / "workspace" / "rooms" / str(self.room) / "report.txt"           # 결과는 방 폴더 아래만 올린다(스펙 2026-10-20-026 R1b)
        report.parent.mkdir(parents=True, exist_ok=True)
        report.write_bytes("에이전트 보고서".encode())
        rel = f"workspace/rooms/{self.room}/report.txt"
        snap = lambda mtime: {rel: (report.stat().st_size, mtime, 1)}   # noqa: E731
        meeting.Meeting._append_chips(self.room, "sa", "w", {}, snap(2.0), ws)
        listing = mf.listing(self.room)
        (first,) = listing["files"]
        with meeting._db() as conn:
            row = conn.execute("SELECT id, data FROM office_messages WHERE room=? AND kind='files'", (self.room,)).fetchone()
        self.assertEqual(json.loads(row["data"])["files"][0]["room"], first["id"])
        self.assertEqual((first["name"], first["uploader"], first["msg"]), ("report.txt", "sa", row["id"]))   # 말에 연결돼 24시간 정리 대상이 아니다
        try:
            report.write_bytes("고친 보고서 둘째 판".encode())
            meeting.Meeting._append_chips(self.room, "sa", "w", snap(2.0), snap(3.0), ws)
            (second,) = mf.listing(self.room)["files"]                                          # 옛 사본은 지워지고 새 판 하나
            self.assertNotEqual(second["id"], first["id"])
            self.assertEqual(slurp(mf.open_file(self.room, second["id"])).decode(), "고친 보고서 둘째 판")
            self.assertEqual(list((self.shared_in / str(self.room)).glob(f"*/{first['id']}-*")), [])
            os.environ["AAS_MEETING_FILE_MAX"] = "3"                                             # 한도를 넘으면 건너뛰고 이유를 남긴다. 옛 판은 그대로
            meeting.Meeting._append_chips(self.room, "sa", "w", snap(3.0), snap(4.0), ws)
            with meeting._db() as conn:
                last = conn.execute("SELECT data FROM office_messages WHERE room=? AND kind='files' ORDER BY id DESC", (self.room,)).fetchone()
            self.assertEqual(json.loads(last["data"])["files"][0]["skip"], "too_large")
            self.assertEqual([f["id"] for f in mf.listing(self.room)["files"]], [second["id"]])
        finally:
            report.write_bytes("에이전트 보고서".encode())
        self.assertEqual(web_files.SLOTS.used, 0)

    def test_from_agent_checks_membership_room_and_record(self):
        mid = self.chip()
        body = lambda **kw: json.dumps({"room": self.room, "msg": mid, "n": 0, **kw}).encode()   # noqa: E731
        r, raw = self.req("POST", "/api/office/meeting/files/from-agent", body=body(), who=STRANGER)
        self.assertEqual((r.status, json.loads(raw)), (403, {"error": "forbidden"}))
        r, raw = self.req("POST", "/api/office/meeting/files/from-agent", body=body(room=self.room2))   # 다른 방 번호로는 기록을 찾지 못한다
        self.assertEqual((r.status, json.loads(raw)), (404, {"error": "no_file"}))
        r, raw = self.req("POST", "/api/office/meeting/files/from-agent", body=body(n=3))
        self.assertEqual(r.status, 404)
        r, raw = self.req("POST", "/api/office/meeting/files/from-agent", body=b"not json")
        self.assertEqual((r.status, json.loads(raw)), (400, {"error": "bad_request"}))
        os.environ["AAS_MEETING_FILE_MAX"] = "3"
        r, raw = self.req("POST", "/api/office/meeting/files/from-agent", body=body())
        self.assertEqual((r.status, json.loads(raw)), (413, {"error": "too_large"}))
        self.assertEqual(list(self.shared_in.glob("*/*/*")), [])

    def test_meeting_view_carries_the_files_key(self):
        view = meeting.Meeting(None).view(self.room)
        self.assertEqual(view["files"], mf.info())
        self.assertTrue(view["files"]["enabled"])


if __name__ == "__main__":
    unittest.main()
