# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""Hermes 대시보드 API 호출 — 크론 조작처럼 Hermes 의 상태를 바꾸는 일은 파일을 직접 고치지 않고 여기로 보낸다.
(Hermes 를 올려도 깨지지 않게: Hermes 가 스스로 검증하고 저장한다.)"""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request

from ..assets.files import mask_line
from .hermes_chat import ChatUnavailable, DashboardAuth
from ..common.i18n import tr
from ..common.redact import redact


class HermesError(Exception):
    def __init__(self, message: str, code: int = 502, reason: str = ""):
        super().__init__(message)
        self.code = code
        self.reason = reason      # 화면이 문장 대신 보는 판정용 코드(문장은 언어마다 달라진다)


class HermesAPI:
    def __init__(self, auth: DashboardAuth):
        self.auth = auth

    def call(self, method: str, path: str, body: dict | None = None, query: dict | None = None, timeout: float = 30):
        """timeout: Hermes 를 기다리는 시간(초). MCP 연결 시험처럼 오래 걸리는 호출만 늘린다(스펙 2026-10-15-025 R14)."""
        url = self.auth.s["url"] + path
        if query:
            url += "?" + urllib.parse.urlencode({k: v for k, v in query.items() if v not in (None, "")})
        for attempt in (1, 2):
            try:
                if not self.auth.logged_in:
                    self.auth.login()
                req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None,
                                             headers={"Content-Type": "application/json", "Accept": "application/json"})
                with self.auth.opener.open(req, timeout=timeout) as resp:
                    raw = resp.read()
                return json.loads(raw) if raw else {}
            except ChatUnavailable as exc:
                raise HermesError(str(exc), 503) from None
            except urllib.error.HTTPError as exc:
                if exc.code in (401, 403) and attempt == 1:
                    self.auth.logged_in = False               # 세션 만료 → 한 번만 다시 로그인
                    continue
                detail = ""
                try:
                    detail = str(json.loads(exc.read() or b"{}").get("detail") or "")
                except Exception:
                    pass
                raise HermesError(redact(detail, 300) or tr(f"Hermes 가 거절했습니다 (HTTP {exc.code})", f"Hermes rejected the request (HTTP {exc.code})"), exc.code if exc.code in (400, 404, 409, 422) else 502) from None
            except TimeoutError:
                raise HermesError(tr("Hermes 가 시간 안에 답하지 않았습니다", "Hermes did not answer in time"), 504, "timeout") from None
            except OSError as exc:
                raise HermesError(tr(f"Hermes API 서버에 연결할 수 없습니다: {type(exc).__name__}", f"Cannot reach the Hermes API server: {type(exc).__name__}"), 503) from None
        raise HermesError(tr("Hermes API 서버 로그인이 계속 거절됩니다", "The Hermes API server keeps rejecting the login"), 503)

    def open_stream(self, method: str, path: str, query: dict | None = None, timeout: float = 60):
        """파일을 흘려받는 호출(칸반 첨부 내려받기, 스펙 office/kanban-card-structured-brief §3-9). 본문을 읽지 않은 응답 객체를 돌려준다.
        읽고 닫는 것은 부른 쪽이 한다. 세션이 만료되면(401·403) call() 처럼 한 번만 다시 로그인한다. 404 는 404, 그 밖의 실패는 HermesError."""
        url = self.auth.s["url"] + path
        if query:
            url += "?" + urllib.parse.urlencode({k: v for k, v in query.items() if v not in (None, "")})
        for attempt in (1, 2):
            try:
                if not self.auth.logged_in:
                    self.auth.login()
                req = urllib.request.Request(url, method=method, headers={"Accept": "*/*"})
                return self.auth.opener.open(req, timeout=timeout)
            except ChatUnavailable as exc:
                raise HermesError(str(exc), 503) from None
            except urllib.error.HTTPError as exc:
                exc.close()
                if exc.code in (401, 403) and attempt == 1:
                    self.auth.logged_in = False               # 세션 만료 → 한 번만 다시 로그인
                    continue
                raise HermesError(tr(f"Hermes 가 거절했습니다 (HTTP {exc.code})", f"Hermes rejected the request (HTTP {exc.code})"), 404 if exc.code == 404 else 502) from None
            except TimeoutError:
                raise HermesError(tr("Hermes 가 시간 안에 답하지 않았습니다", "Hermes did not answer in time"), 504, "timeout") from None
            except OSError as exc:
                raise HermesError(tr(f"Hermes API 서버에 연결할 수 없습니다: {type(exc).__name__}", f"Cannot reach the Hermes API server: {type(exc).__name__}"), 503) from None
        raise HermesError(tr("Hermes API 서버 로그인이 계속 거절됩니다", "The Hermes API server keeps rejecting the login"), 503)

    def call_text(self, method: str, path: str, query: dict | None = None, timeout: float = 30) -> tuple[int, str]:
        """(상태 코드, 본문 앞 2000자). HTML 을 돌려주는 공개 경로(MCP OAuth 콜백)용 — 로그인하지 않고, 4xx·5xx 도 예외 없이 돌려준다.
        연결하지 못하거나 시간이 지나면 HermesError(스펙 2026-10-16-010 4-1 5단계, 외부 검토 H2)."""
        url = self.auth.s["url"] + path
        if query:
            url += "?" + urllib.parse.urlencode({k: v for k, v in query.items() if v not in (None, "")})
        req = urllib.request.Request(url, method=method, headers={"Accept": "text/html"})
        try:
            with self.auth.opener.open(req, timeout=timeout) as resp:
                return resp.status, resp.read(2000).decode("utf-8", "replace")
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read(2000).decode("utf-8", "replace")
        except TimeoutError:
            raise HermesError(tr("Hermes 가 시간 안에 답하지 않았습니다", "Hermes did not answer in time"), 504, "timeout") from None
        except OSError as exc:
            raise HermesError(tr(f"Hermes API 서버에 연결할 수 없습니다: {type(exc).__name__}", f"Cannot reach the Hermes API server: {type(exc).__name__}"), 503) from None


JOB_FIELDS = ("id", "name", "enabled", "state", "paused_at", "paused_reason", "schedule_display", "next_run_at", "last_run_at", "last_status",
              "last_error", "failure_streak", "deliver", "no_agent", "skill", "skills", "script", "model", "repeat", "workdir")


def job_view(job: dict) -> dict:
    """화면에 내보낼 만큼만. 프롬프트·오류 글은 비밀값 모양을 가린다."""
    out = {k: job.get(k) for k in JOB_FIELDS}
    sched = job.get("schedule")
    out["schedule"] = sched if isinstance(sched, dict) else {"display": str(sched or "")}
    out["schedule_display"] = out["schedule_display"] or out["schedule"].get("display") or out["schedule"].get("expr") or ""
    out["prompt"] = mask_line(str(job.get("prompt") or ""))[:1200]
    out["last_error"] = redact(job.get("last_error") or "", 600)
    return out


def run_view(run: dict) -> dict:
    keys = ("id", "status", "started_at", "finished_at", "ended_at", "end_reason", "duration_seconds", "trigger", "exit_code", "message_count", "tool_call_count")
    out = {k: run.get(k) for k in keys if k in run}
    if run.get("error"):
        out["error"] = redact(run["error"], 300)
    return out
