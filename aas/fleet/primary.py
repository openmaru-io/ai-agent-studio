# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""주 프로파일 — 새 사용자의 주 에이전트를 Hermes 루트(default) 대신 이름 있는 프로파일(main)로 둔다(스펙 2026-10-14-003).

- 대상: 쿠버네티스에서 첫 로그인으로 Hermes 가 새로 생긴 사용자만(리뷰 D13). 기존 사용자는 루트를 그대로 쓴다.
- 대상 기록은 영구다(리뷰 D15). 설정(AAS_PRIMARY_MAIN)은 「새 사용자에게 main 을 줄지」만 정한다.
- Hermes 의 활성 프로파일은 바꾸지 않는다. AAS 는 주 프로파일을 늘 이름으로 부른다(리뷰 D4).
- 상태: target(기록만) → created(main 을 만듦) → templated(첫 SOUL 템플릿까지 끝). 서버가 중간에 죽어도 다음 주기에 이어 한다(리뷰 L1).
"""
from __future__ import annotations

import os
from datetime import datetime
from urllib.parse import quote

from ..common import config, db, settings, soul_templates, store, table_cache

SCHEMA = ("CREATE TABLE IF NOT EXISTS pod_primary (pod TEXT PRIMARY KEY, profile TEXT NOT NULL, state TEXT NOT NULL, "
          "ts TEXT NOT NULL, hermes_version TEXT NOT NULL DEFAULT '')")
ROOT = "default"
STATES = ("target", "created", "templated")


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def enabled() -> bool:
    """새 사용자에게 main 을 줄지. 쿠버네티스 구성에서 설정을 켰을 때만(기본 끔, 리뷰 D6·D11)."""
    return bool(config.get("AAS_K8S_NAMESPACE")) and os.environ.get("AAS_PRIMARY_MAIN", "").strip().lower() in ("1", "true", "yes")


def name() -> str:
    """새로 만들 주 프로파일 이름(리뷰 D5). 이미 기록된 POD 는 기록의 이름을 쓴다."""
    return (os.environ.get("AAS_PRIMARY_PROFILE") or "main").strip() or "main"


def _connect():
    conn = store.connect()
    conn.execute(SCHEMA)
    return conn


def state(pod_id: str, fresh: bool = False) -> dict | None:
    """이 POD 의 기록. 읽기만 하는 곳은 records()(표 캐시)에서 꺼낸다 — 에이전트 목록의 루트 숨김 판단이 에이전트마다 DB 를 읽었다
    (OKE 2026-10-26, 에이전트 화면을 연 동안 초당 약 0.5건, 스펙 2026-10-26-002 §9-11). 읽은 값으로 쓰기를 정하는 곳은 fresh 로 DB 를 읽는다."""
    if not fresh:
        row = records().get(pod_id)
        return dict(row) if row else None
    with _connect() as conn:
        row = conn.execute("SELECT pod, profile, state, ts, hermes_version FROM pod_primary WHERE pod=?", (pod_id,)).fetchone()
    return dict(row) if row else None


def records() -> dict[str, dict]:
    def read() -> dict[str, dict]:
        with _connect() as conn:
            return {r["pod"]: dict(r) for r in conn.execute("SELECT pod, profile, state, ts, hermes_version FROM pod_primary")}
    return table_cache.get("primary.records", ("pod_primary",), read)   # 표 바뀜 알림으로 버리는 캐시(스펙 2026-10-26-002 R10)


def primary_of(pod_id: str, known: dict[str, dict] | None = None) -> str:
    """이 POD 의 주 프로파일. 대상 기록이 있으면 그 이름, 없으면 루트(default) — 기록이 없는 POD 는 지금과 같다(리뷰 D11·D15)."""
    row = known.get(pod_id) if known is not None else state(pod_id)
    return str(row["profile"]) if row else ROOT


def is_target(pod_id: str) -> bool:
    return state(pod_id) is not None


_cache: dict = {"at": 0.0, "ids": frozenset()}


def target_ids(ttl: float = 10.0) -> frozenset:
    """대상 POD id 들. 읽기 경로(hermes_reader)가 자주 불러 짧게 캐시한다. DB 에 닿지 않으면 빈 집합(지금 동작)."""
    import time
    now = time.monotonic()
    if now - _cache["at"] > ttl:
        try:
            _cache.update(at=now, ids=frozenset(records()))
        except Exception:
            _cache.update(at=now, ids=frozenset())
    return _cache["ids"]


def forget_cache() -> None:
    _cache["at"] = 0.0


def mark(pod_id: str) -> bool:
    """새 사용자의 POD 를 대상으로 기록한다. 설정이 꺼져 있으면 기록하지 않는다. 이미 있으면 그대로 둔다."""
    if not enabled() or not pod_id:
        return False
    with _connect() as conn:
        conn.execute("INSERT INTO pod_primary (pod, profile, state, ts) VALUES (?,?,?,?) ON CONFLICT (pod) DO NOTHING",
                     (pod_id, name(), "target", _now()))
    return True


def adopt(pod_id: str) -> str:
    """기존 사용자의 POD 를 main 대상으로 옮긴다(관리자 명령, 사용자 결정 2026-10-14 — 리뷰 D13 을 고침). 설정과 상관없이 기록한다.
    AAS 기록은 여기서 옮긴다: 오피스 자리는 별칭·책상을 두고 profile 만 main 으로, SOUL 판(soul:default)은 main 에 복사(루트 판은 남김).
    main 만들기와 첫 템플릿은 다음 주기의 ensure 가 한다. 루트의 대화·크론·기억은 복제가 옮기지 않아 루트에 남는다. 이미 대상이면 그대로 둔다."""
    from ..assets import files
    from ..office import office
    row = state(pod_id, fresh=True)
    if row:
        return str(row["profile"])
    profile = name()
    with office.connect() as conn:
        if not conn.execute("SELECT 1 FROM office_seats WHERE pod=? AND profile=?", (pod_id, profile)).fetchone():
            conn.execute("UPDATE office_seats SET profile=? WHERE pod=? AND profile=?", (profile, pod_id, ROOT))
        conn.execute("UPDATE office_seat_optout SET profile=? WHERE pod=? AND profile=?", (profile, pod_id, ROOT))
    with _connect() as conn:
        files.ensure_schema(conn)
        conn.execute("INSERT INTO file_versions (pod, path, sha, content, saved_at, by, note) SELECT pod, ?, sha, content, saved_at, by, note "
                     "FROM file_versions WHERE pod=? AND path=? ORDER BY id", (f"soul:{profile}", pod_id, f"soul:{ROOT}"))
        conn.execute("INSERT INTO pod_primary (pod, profile, state, ts) VALUES (?,?,?,?) ON CONFLICT (pod) DO NOTHING",
                     (pod_id, profile, "target", _now()))
    forget_cache()
    return profile


def set_state(pod_id: str, new_state: str, hermes_version: str | None = None) -> None:
    assert new_state in STATES
    with _connect() as conn:
        if hermes_version is None:
            conn.execute("UPDATE pod_primary SET state=?, ts=? WHERE pod=?", (new_state, _now(), pod_id))
        else:
            conn.execute("UPDATE pod_primary SET state=?, ts=?, hermes_version=? WHERE pod=?", (new_state, _now(), hermes_version, pod_id))


def pending() -> list[dict]:
    """아직 첫 템플릿까지 끝나지 않은 대상 POD."""
    return [r for r in records().values() if r["state"] != "templated"]


def pick_template(department: str) -> dict | None:
    """첫 SOUL 템플릿: 부서 추천 → 관리자가 정한 기본 템플릿 → 없음(Hermes 기본 문장 그대로, 리뷰 D9)."""
    items = soul_templates.templates()
    item = soul_templates.recommend(department, items, "ko") or soul_templates.recommend(department, items)
    if item:
        return item
    tid, _, lang = settings.default_template().partition(".")
    return soul_templates.get(tid, lang) if tid and lang else None


def first_soul(pod, api, profile: str, alias: str, save_text) -> dict | None:
    """주 프로파일의 SOUL 이 아직 Hermes 기본 문장이면 템플릿으로 바꾼다. 사람이 고친 SOUL 은 덮지 않는다.
    save_text(pod_id, key, current, new, base_sha, who, write, read, note) 는 판 관리(files.save_text)다. 적용한 템플릿을 돌려준다."""
    n = quote(profile, safe="")
    read = lambda: str(api.call("GET", f"/api/profiles/{n}/soul").get("content") or "")     # noqa: E731
    write = lambda text: api.call("PUT", f"/api/profiles/{n}/soul", {"content": text})      # noqa: E731
    current = read()
    if not soul_templates.is_default_soul(current):
        return None
    department = settings.departments().get(str(pod.owner or "").lower(), "")
    item = pick_template(department)
    if not item:
        return None
    new = soul_templates.render(item, {"department": department, "agent": alias})
    from ..assets import files
    save_text(pod.id, f"soul:{profile}", current, new, files.text_sha(current), "aas", write, read,
              f"템플릿 「{item['name']}」 버전 {item['rev']} 에서 시작")   # i18n-ignore: 판 기록에 저장되는 메모
    soul_templates.record_use(pod.id, profile, item["id"], item["lang"], int(item["rev"]), "aas")
    return item


def ensure(pod, api, alias: str, save_text) -> str:
    """대상 POD 의 주 프로파일을 만들고 첫 템플릿을 입힌다. 한 단계라도 실패하면 예외를 그대로 올리고 상태는 마지막 성공 단계에 남는다.
    한 일을 짧게 돌려준다(아무것도 안 했으면 빈 문자열)."""
    row = state(pod.id, fresh=True)
    if not row or row["state"] == "templated":
        return ""
    profile = str(row["profile"])
    done = ""
    if row["state"] == "target":
        listed = {str(p.get("name") or "") for p in api.call("GET", "/api/profiles").get("profiles", [])}
        if profile not in listed:                                  # 대시보드 복제는 설정·SOUL·스킬을 복사하고 채널은 뺀다(clone_config)
            api.call("POST", "/api/profiles", {"name": profile, "clone_from": ROOT})
            done = "created"
        set_state(pod.id, "created")
    item = first_soul(pod, api, profile, alias, save_text)
    set_state(pod.id, "templated")
    return (done + (" templated" if item else "")).strip() or "checked"


def skill_sync_task(pod_id: str, profile: str, version: str, namespace: str, group: str, api_version: str) -> dict:
    """주 프로파일의 기본 스킬을 지금 Hermes 이미지에 맞추는 HermesTask(오퍼레이터 SkillSync, 리뷰 D14)."""
    import hashlib
    tag = hashlib.sha1(f"{pod_id}|{profile}|{version}".encode()).hexdigest()[:12]
    return {"apiVersion": f"{group}/{api_version}", "kind": "HermesTask",
            "metadata": {"name": f"skillsync-{tag}", "namespace": namespace, "labels": {"aas.openmaru.io/agent": pod_id}},
            "spec": {"agent": pod_id, "profile": profile, "type": "SkillSync", "requestedBy": "aas"}}


def pod_version_changed(pod_id: str, version: str) -> bool:
    """이 POD 의 Hermes 버전을 기록하고, 전에 기록한 버전과 달라졌으면 True. 처음 기록할 때는 False — 컨테이너가 뜰 때 Hermes 가
    루트를 맞추고 이름 있는 프로파일은 그 루트를 복제한 것이라 이미 지금 판이다. 대상 기록(pod_primary)이 없는 POD 도 센다(스펙 2026-10-14-015)."""
    if not version:
        return False
    key = f"hermes_version:{pod_id}"
    where = (os.environ.get("AAS_DATA_DIR", ""), db._tl_schema() if db.backend() == "postgres" else "", pod_id)
    if table_cache.enabled() and _versions_seen.get(where) == version:                  # 이미 기록한 판 — 주기마다 에이전트마다 meta 를 읽었다(스펙 2026-10-26-002 §9-12)
        return False
    with store.connect() as conn:
        row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        before = str(row["value"]) if row else ""
        if before != version:
            conn.execute("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value=excluded.value", (key, version))
    if table_cache.enabled():
        _versions_seen[where] = version
    return bool(before) and before != version


_versions_seen: dict[tuple, str] = {}                         # (데이터 폴더, 스키마, POD) → 이 프로세스가 기록·확인한 Hermes 판


def sync_profiles(home) -> list[str]:
    """기본 스킬 맞추기(SkillSync)를 요청할 이름 있는 프로파일: 기본 스킬 목록(skills/.bundled_manifest)이 이미 있는 것만.
    마켓 패키지로 만든 프로파일처럼 목록이 없는 곳에 돌리면 기본 스킬 약 50개가 새로 깔린다(스펙 2026-10-14-015 D3)."""
    root = home / "profiles"
    try:
        names = sorted(p.name for p in root.iterdir() if p.is_dir()) if root.is_dir() else []
        return [n for n in names if (root / n / "skills" / ".bundled_manifest").is_file()]
    except OSError:
        return []


def curator_patch(text: str) -> str | None:
    """config.yaml 글에 `curator.prune_builtins: false` 한 줄만 더한 새 글을 돌려준다. 바꿀 것이 없거나 안전하게 못 고치면 None.
    큐레이터는 30일 안 쓴 기본 스킬을 보관함으로 옮겨 「없어진 것처럼」 보이게 한다. 사람이 정한 값은 존중한다(스펙 2026-10-14-015 D4)."""
    return _false_flag_patch(text, "curator", "prune_builtins")


def nous_guest_patch(text: str) -> str | None:
    """config.yaml 글에 `nous.guest: false` 한 줄만 더한 새 글. 바꿀 것이 없거나 안전하게 못 고치면 None.
    Hermes 는 이 값이 없으면(기본 true) 호스팅 커넥터를 처음 쓸 때 외부 포털에 Nous 익명 계정을 만든다(스펙 2026-10-28-006 §4-4).
    사람이 정한 값은 true 라도 그대로 둔다."""
    return _false_flag_patch(text, "nous", "guest")


def _false_flag_patch(text: str, section: str, key: str) -> str | None:
    """`section.key: false` 를 한 줄만 더한다. 키가 이미 있거나, 글을 읽을 수 없거나, 줄 안에 적은 절(`section: {…}`)이면 None."""
    import re

    import yaml
    try:
        doc = yaml.safe_load(text) or {}
    except yaml.YAMLError:
        return None
    if not isinstance(doc, dict):
        return None
    cur = doc.get(section)
    if isinstance(cur, dict) and key in cur:
        return None
    body = text if text.endswith("\n") or not text else text + "\n"
    head = re.search(rf"^{section}[ \t]*:[ \t]*(#.*)?$", body, re.M)
    if head:
        out = body[:head.end()] + f"\n  {key}: false" + body[head.end():]
    elif section in doc:
        return None                                              # `section: {…}` 처럼 줄 안에 적은 모양은 글을 안전하게 고칠 수 없다
    else:
        out = body + ("\n" if body else "") + f"{section}:\n  {key}: false\n"
    try:
        ok = (yaml.safe_load(out) or {}).get(section, {}).get(key) is False
    except (yaml.YAMLError, AttributeError):
        ok = False
    return out if ok else None


def hide_root(pod_id: str, admin: bool, known: dict[str, dict] | None = None) -> str:
    """프로파일 목록에서 루트를 어떻게 다룰지: 'show'(지금처럼), 'hidden'(관리자에게 「루트(숨김)」 읽기 전용), 'drop'(빼기).
    대상 기록이 없는 POD 는 지금처럼 보인다(리뷰 D8·D11)."""
    target = (pod_id in known) if known is not None else is_target(pod_id)
    if not target:
        return "show"
    return "hidden" if admin else "drop"


__all__ = ["enabled", "name", "state", "records", "primary_of", "is_target", "mark", "adopt", "set_state", "pending", "pick_template",
           "first_soul", "ensure", "pod_version_changed", "sync_profiles", "curator_patch", "nous_guest_patch", "hide_root", "ROOT", "SCHEMA"]


if __name__ == "__main__":                                      # 관리자 명령: python -m aas.fleet.primary adopt <POD id>...
    import sys
    if len(sys.argv) < 3 or sys.argv[1] != "adopt":
        sys.exit("사용법: python -m aas.fleet.primary adopt <POD id>...")   # i18n-ignore: 관리자 명령
    for pod_arg in sys.argv[2:]:
        print(pod_arg, adopt(pod_arg))
