# Copyright 2026 The OPENMARU Authors.
"""카탈로그 항목에 딸린 Hermes 플러그인을 프로파일에 넣고 뺀다(OMAI-1850).

  자리   원본은 aas/assets/hermes_plugins/<이름>/. 프로파일 폴더의 plugins/<이름>/ 에 같은 파일을 쓴다(Hermes 파일 API).
  켜기   사용자 플러그인은 config 의 plugins.enabled 에 이름이 있어야 읽힌다. `hermes plugins enable` 은 OKE 판에서 다른 검사
         (pm-runtime)에 걸려 실패하므로 PUT /api/config 로 목록을 쓴다. 깊은 병합이지만 목록은 통째로 바뀐다.
  적용   게이트웨이가 다시 시작해야 읽힌다. 카탈로그 설치 뒤 화면이 이미 「적용」을 안내한다.
  실패   어느 단계든 실패하면 결과에 이유만 적고 설치·삭제는 그대로 둔다(작업 지침 블록과 같다).
"""
from __future__ import annotations

import posixpath
from pathlib import Path

from ..hermes.hermes_api import HermesAPI, HermesError

PLUGINS_DIR = Path(__file__).resolve().parent.parent / "assets" / "hermes_plugins"
FILES = ("plugin.yaml", "__init__.py")


def plugin_files(name: str) -> dict[str, str]:
    return {f: (PLUGINS_DIR / name / f).read_text(encoding="utf-8") for f in FILES}


def enabled_list(api: HermesAPI, prof: str | None) -> list[str]:
    res = api.call("GET", "/api/config", query={"profile": prof, "include_defaults": "false"})
    plugins = res.get("plugins") if isinstance(res, dict) else None
    got = plugins.get("enabled") if isinstance(plugins, dict) else None
    return [str(x) for x in got] if isinstance(got, list) else []


def _set_enabled(api: HermesAPI, prof: str | None, names: list[str]) -> None:
    api.call("PUT", "/api/config", {"config": {"plugins": {"enabled": names}}, "profile": prof}, {"profile": prof})


def install(api: HermesAPI, prof: str | None, profile_dir: str, name: str) -> dict:
    """파일을 쓰고 켠다. profile_dir 은 Hermes 프로파일 목록의 path(절대 경로)."""
    target = posixpath.join(profile_dir, "plugins", name)
    try:
        api.call("POST", "/api/files/mkdir", {"path": target})
        for f, text in plugin_files(name).items():
            path = posixpath.join(target, f)
            res = api.call("POST", "/api/fs/write-text", {"path": path, "content": text})
            if str((res or {}).get("path") or "") != path:            # Hermes 가 링크를 따라가 다른 곳에 썼다
                return {"ok": False, "reason": "link"}
        names = enabled_list(api, prof)
        if name not in names:
            _set_enabled(api, prof, [*names, name])
    except (HermesError, OSError) as exc:
        return {"ok": False, "reason": str(exc)[:200]}
    return {"ok": True}


def remove(api: HermesAPI, prof: str | None, profile_dir: str, name: str) -> dict:
    """끄고 파일을 지운다. 이미 없으면 그대로 둔다."""
    try:
        names = enabled_list(api, prof)
        if name in names:
            _set_enabled(api, prof, [n for n in names if n != name])
        try:
            api.call("DELETE", "/api/files", {"path": posixpath.join(profile_dir, "plugins", name), "recursive": True})
        except HermesError as exc:
            if exc.code != 404:
                raise
    except HermesError as exc:
        return {"ok": False, "reason": str(exc)[:200]}
    return {"ok": True}
