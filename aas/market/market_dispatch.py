# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""쿠버네티스 모드의 마켓 배달: 파일 큐(data/market/queue)의 요청을 HermesTask 로 바꿔 보내고, 끝난 결과를 done 에 적는다.

요청 기록의 정본은 그대로 AAS(ADR-0025)다 — 화면·installed()·reconcile() 은 queue/done 파일을 읽으므로 바뀌지 않는다.
예전 호스트 도우미(bin/market_agent.py, 없앴다)가 하던 일 중 「받기·배포판 만들기」는 market_stage 가, 「컨테이너 안에서 명령 돌리기」는
오퍼레이터가 HermesTask 로 한다(R4). AAS 서버에는 pods/exec 권한이 없다.
"""
from __future__ import annotations

import json
import re
import time
from datetime import datetime

from ..fleet import k8s
from . import marketplace, market_stage
from ..common import leader, store

TASK_PREFIX = "mkt-"
STUCK_SECONDS = 15 * 60          # 이 시간이 지나도 끝나지 않으면 요청을 실패로 닫는다(오퍼레이터가 멈춰 있을 수 있다)
_RID = re.compile(r"^\d{20}-[0-9a-f]{6}$")


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def task_name(row_id: str) -> str:
    return TASK_PREFIX + row_id.lower()


def _write(directory: str, row: dict) -> None:
    d = marketplace._dir(directory)
    tmp = d / (row["id"] + ".tmp")
    tmp.write_text(json.dumps(row, ensure_ascii=False), encoding="utf-8")
    tmp.rename(d / (row["id"] + ".json"))              # 반쯤 쓰인 파일을 읽지 않게


def _close(row: dict, status: str, message: str) -> dict:
    """요청을 끝낸다: done 에 적고 queue 에서 지운다."""
    row.update(status=status, message=message, finished=_now())
    _write("done", row)
    (marketplace._dir("queue") / (row["id"] + ".json")).unlink(missing_ok=True)
    return row


def _manifest(row: dict, client: k8s.K8s, payload: str = "") -> dict:
    spec = {"agent": row["pod"], "profile": row["profile"], "requestedBy": str(row.get("who") or "")[:200]}
    if row["mode"] == "remove":
        spec.update(type="SkillRemove", skillName=row["name"])
    elif row["mode"] == "restore":
        spec.update(type="SkillRestore", skillName=row["name"])
    else:
        spec.update(type="ProfileInstall", force=row["kind"] == "skill" or row["mode"] in ("update", "skills"), payload=payload)
    return {"apiVersion": f"{k8s.GROUP}/{k8s.VERSION}", "kind": "HermesTask",
            "metadata": {"name": task_name(row["id"]), "namespace": client.namespace, "labels": {"aas.openmaru.io/agent": row["pod"]}}, "spec": spec}


def _copy_manifest(row: dict, client: k8s.K8s) -> dict:
    """고친 마켓 스킬을 skills/local/<이름>-local 로 복사하는 작업(SkillCopy). 새 버전을 덮기 전에 먼저 돌린다."""
    return {"apiVersion": f"{k8s.GROUP}/{k8s.VERSION}", "kind": "HermesTask",
            "metadata": {"name": task_name(row["id"]) + "-copy", "namespace": client.namespace, "labels": {"aas.openmaru.io/agent": row["pod"]}},
            "spec": {"agent": row["pod"], "profile": row["profile"], "type": "SkillCopy", "skillName": row["name"], "requestedBy": str(row.get("who") or "")[:200]}}


def _record(pod: str, row: dict) -> dict | None:
    """이 프로파일에 이 패키지를 설치한 마지막 기록(없으면 None) — 지키기 검사가 원본 버전을 찾는 데 쓴다."""
    return next((r for r in marketplace.installed(pod) if r["profile"] == row.get("profile") and r["package"] == row.get("package")), None)


def pending_for(pod: str, profile: str) -> tuple[list[dict], list[dict]]:
    """그 프로파일의 줄에 선 요청: (아직 보내지 않은 것, HermesTask 로 보내 도는 것). 프로파일 지우기가 본다(스펙 2026-11-07-001 §6)."""
    rows = [r for r in (marketplace._read(p) for p in sorted(marketplace._dir("queue").glob("*.json")))
            if r and r.get("pod") == pod and r.get("profile") == profile]
    return [r for r in rows if not r.get("task")], [r for r in rows if r.get("task")]


def cancel_queued(pod: str, profile: str, message: str) -> int:
    """그 프로파일의 아직 보내지 않은 요청을 끝낸다(지운 프로파일에 배달되면 Hermes CLI 가 폴더를 다시 만든다). 끝낸 수."""
    queued, _ = pending_for(pod, profile)
    for row in queued:
        _close(row, "failed", message)
    return len(queued)


def _dispatch(client: k8s.K8s, row: dict, agent_names: set[str], get_home=None, copied: bool = False, profile_gone=None) -> dict:
    """아직 보내지 않은 요청을 HermesTask 로 만든다. 반환: 갱신한 행.
    get_home(pod 이름) = 그 POD 의 Hermes 데이터 폴더 — 있으면 덮기 전에 고친 스킬·같은 이름을 검사하고 덮일 것을 백업한다(스펙 2026-10-14-015)."""
    if not _RID.match(str(row.get("id") or "")):
        return _close(row, "failed", "요청 번호가 올바르지 않습니다")  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
    if row.get("pod") not in agent_names:
        return _close(row, "failed", f"Hermes {row.get('pod')} 가 없습니다")  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
    # 지운 프로파일에는 보내지 않는다 — Hermes CLI 가 프로파일 폴더를 다시 만들어 지운 폴더가 남았다(OKE 2026-11-07, 스펙 2026-11-07-001 §6).
    # 새 프로파일을 만드는 에이전트 설치는 아직 폴더가 없는 것이 맞다
    if profile_gone and not (row.get("kind") == "agent" and row.get("mode") == "install") and row.get("profile") not in ("", "default") \
            and profile_gone(row["pod"], row["profile"]):
        return _close(row, "failed", f"프로파일 {row['profile']} 이(가) 없어 설치하지 않았습니다")  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
    payload = ""
    if row.get("mode") not in ("remove", "restore"):
        try:
            home = get_home(row["pod"]) if get_home else None
            res = market_stage.prepare({**row, "on_modified": "overwrite"} if copied else row, home, _record(row["pod"], row) if home is not None else None)
        except market_stage.NeedsChoice as exc:
            row["needs"] = exc.needs                          # 화면이 이 목록으로 「내 것 지키기 / 덮기」를 묻고 on_modified 를 담아 다시 요청한다
            return _close(row, "failed", str(exc))
        except market_stage.Refuse as exc:
            return _close(row, "failed", str(exc))
        payload = res["payload"]
        if res["backup"]:
            row["backup"] = res["backup"]                    # 덮기 전 백업(AAS 서버 볼륨, 30일)
        if res["skipped"]:
            row["skipped"] = res["skipped"]
        if not res["manifest"]["distribution_owned"]:         # 사용자가 지키기로 해서 바꿀 것이 없다 — 작업을 만들지 않는다
            return _close(row, "done", "고쳤거나 직접 만든 스킬이라 그대로 두었습니다: " + ", ".join(res["skipped"]))  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
    elif row.get("mode") == "remove":
        try:
            market_stage.validate(row)
        except market_stage.Refuse as exc:
            return _close(row, "failed", str(exc))
    if row.get("on_modified") == "copy" and not copied:        # 먼저 고친 스킬을 -local 로 복사하고, 끝나면 _poll 이 새 판 설치를 이어 보낸다
        return _send(client, row, _copy_manifest(row, client), task_name(row["id"]) + "-copy", stage="copy")
    return _send(client, row, _manifest(row, client, payload), task_name(row["id"]))


def _send(client: k8s.K8s, row: dict, manifest: dict, name: str, stage: str = "") -> dict:
    try:
        client.create_task(manifest)
    except k8s.K8sError as exc:
        if exc.code != 409:                                  # 409 = 이미 만들었다(보낸 뒤 기록하기 전에 멈춘 경우) → 아래에서 이어 간다
            return _close(row, "failed", f"작업을 만들지 못했습니다: {exc}")  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
    row.update(status="running", task=name, dispatched=_now())
    if stage:
        row["stage"] = stage
    else:
        row.pop("stage", None)
    _write("queue", row)
    return row


def _poll(client: k8s.K8s, row: dict, agent_names: set[str] | None = None, get_home=None) -> dict:
    """보낸 요청의 결과를 본다. 끝났으면 done 으로 옮기고 작업을 지운다."""
    name = row["task"]
    try:
        task = client.get_task(name)
    except k8s.K8sError as exc:
        if exc.code == 404:
            return _close(row, "failed", "작업이 사라졌습니다(24시간이 지나 지워졌거나 누가 지웠습니다)")  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
        return row                                           # 쿠버네티스에 잠깐 닿지 않았다 — 다음에 다시 본다
    status = task.get("status") or {}
    phase = status.get("phase")
    if phase == "Succeeded" and row.get("stage") == "copy":      # 복사가 끝났다 — 만든 폴더 이름을 적고 새 판 설치를 이어 보낸다
        row["local_copy"] = str(status.get("message") or "").rsplit("/", 1)[-1]
        try:
            client.delete_task(name)
        except k8s.K8sError:
            pass
        row.pop("task", None)
        row.pop("stage", None)
        return _dispatch(client, row, agent_names or {row.get("pod")}, get_home, copied=True)
    if phase in ("Succeeded", "Failed"):
        msg = str(status.get("message") or ("설치했습니다" if phase == "Succeeded" else "실패했습니다"))  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
        if phase == "Succeeded" and row.get("local_copy"):
            msg += f" (고친 것은 skills/local/{row['local_copy']} 로 남겼습니다)"  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
        out = _close(row, "done" if phase == "Succeeded" else "failed", msg)
        try:
            client.delete_task(name)
        except k8s.K8sError:
            pass                                              # 오퍼레이터가 24시간 뒤 지운다
        return out
    started = row.get("dispatched") or row.get("ts") or ""
    try:
        age = (datetime.now().astimezone() - datetime.fromisoformat(started)).total_seconds()
    except ValueError:
        age = 0
    if age > STUCK_SECONDS:
        try:
            client.delete_task(name)
        except k8s.K8sError:
            pass
        return _close(row, "failed", "시간 안에 끝나지 않았습니다 — 오퍼레이터가 멈춰 있는지 확인하세요")  # i18n-ignore: 배달기가 요청 결과로 기록하는 문장(저장)
    return row


def _notice_update(row: dict) -> None:
    """에이전트 패키지 업데이트는 SOUL 을 바꾼다 — 그 에이전트가 앉은 열린 방에 알린다(OMAI-1126 재검토 M4). 실패해도 배달은 계속한다."""
    try:
        from ..office import meeting
        from ..web import topics
        if meeting.notice_soul(str(row.get("pod") or ""), str(row.get("profile") or ""), str(row.get("who") or ""),
                               package=str(row.get("package") or row.get("name") or ""), version=str(row.get("version") or "")):
            topics.invalidate("office:meeting:")
    except Exception as exc:                                   # noqa: BLE001
        store.log_usage("profile_soul_notice_failed", f"{row.get('who') or ''} {row.get('profile')} {type(exc).__name__}", pod=str(row.get("pod") or ""))


def tick(client: k8s.K8s, agent_names: set[str], get_home=None, on_finished=None, profile_gone=None) -> int:
    """줄에 선 요청을 모두 한 걸음씩 나아가게 하고, 도우미 심장박동을 남긴다. 처리한 요청 수를 돌려준다.
    on_finished(pod id) = 요청이 done·failed 로 끝난 작업공간마다 한 번 — 서버가 그 작업공간의 캐시(판 비교 결과)를 버린다(스펙 2026-10-24-003 R14)."""
    finished: set[str] = set()
    handled, error = 0, ""
    for path in sorted(marketplace._dir("queue").glob("*.json")):
        row = marketplace._read(path)
        if not row:
            continue
        before = row.get("status")
        row = _poll(client, row, agent_names, get_home) if row.get("task") else _dispatch(client, row, agent_names, get_home, profile_gone=profile_gone)
        handled += 1
        if row.get("status") == "failed":
            error = str(row.get("message") or "")
        if row.get("status") != before or row.get("status") in ("done", "failed"):
            store.log_usage("market_dispatch", f"{row.get('id')} {row.get('status')}")
        if row.get("status") in ("done", "failed") and row.get("pod"):
            finished.add(str(row["pod"]))
        if before != "done" and row.get("status") == "done" and row.get("mode") == "update" and row.get("kind") == "agent":
            _notice_update(row)
    beat = store.data_dir() / "market" / "helper.json"
    beat.parent.mkdir(parents=True, exist_ok=True)
    beat.with_suffix(".tmp").write_text(json.dumps({"ts": _now(), "error": error}, ensure_ascii=False), encoding="utf-8")
    beat.with_suffix(".tmp").rename(beat)
    for pod in sorted(finished) if on_finished else ():
        try:
            on_finished(pod)
        except Exception as exc:                             # 캐시 비우기 실패가 배달을 멈추지 않게
            print(f"설치 뒤 캐시 비우기 실패 {pod}: {type(exc).__name__}", flush=True)  # i18n-ignore: 운영자가 읽는 로그
    return handled


def loop(get_client, get_agent_names, every: float = 5.0, get_home=None, on_finished=None, after_tick=None, profile_gone=None) -> None:
    """서버가 띄우는 반복. 쿠버네티스 모드이고 마켓 설치가 꺼져 있지 않을 때만 일한다.
    after_tick() = 리더가 매 주기 끝에 부른다 — 새 버전 대기 표를 요청으로 바꾼다(스펙 2026-10-24-003 R18)."""
    while True:
        try:
            client = get_client()
            # 리더만 HermesTask 를 만든다(OMAI-1105). 이름이 고정이고 409 를 처리해 겹쳐도 안전하지만 같은 일을 두 번 하지 않게
            if client is not None and marketplace.install_state()["enabled"] and leader.is_leader():
                tick(client, get_agent_names(), get_home, on_finished, profile_gone)
                if after_tick:
                    after_tick()
        except Exception as exc:                             # 한 번의 실패가 반복을 멈추지 않게 한다
            print(f"스킬 허브 배달 실패 ({type(exc).__name__}): {str(exc)[:120]}", flush=True)  # i18n-ignore: 운영자가 읽는 로그
        time.sleep(every)
