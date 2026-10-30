# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""시험 하네스: 실제 uvicorn + Starlette 앱(aas.web.app)을 빈 포트에 띄운다(OMAI-1100).

옛 시험은 ThreadingHTTPServer(("127.0.0.1", 0), server.Handler) 로 띄웠다. 그 자리를 start() 로 바꾸면
같은 server_port·server_address·shutdown() 으로 새 서버를 거친다. 반복 스레드는 띄우지 않는다(background=False).
"""
from __future__ import annotations

import asyncio
import os
import threading
import time

# 미리 만든 스킬 설명 번역(스펙 2026-10-19-017)을 시험에서는 쓰지 않는다 — Accept-Language 없는 요청이 기본 한국어라 기대값이 바뀐다
os.environ.setdefault("AAS_SKILL_DESC_SEED", os.devnull + ".skill-desc-seed.json")


class AppServer:
    def __init__(self, ssl_certfile: str = "", ssl_keyfile: str = "", background: bool = False):
        from aas.web import app as web_app
        extra = {"ssl_certfile": ssl_certfile, "ssl_keyfile": ssl_keyfile} if ssl_certfile else {}
        self.app = web_app.create_app(background=background)
        self.server = web_app.AASServer(web_app._config(self.app, "127.0.0.1", 0, **extra))
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self._run, daemon=True, name="aas-test-server")
        self.thread.start()
        deadline = time.time() + 10
        while not self.server.started:
            if time.time() > deadline or not self.thread.is_alive():
                raise RuntimeError("시험 서버가 뜨지 않았습니다")
            time.sleep(0.01)
        self.server_address = self.server.servers[0].sockets[0].getsockname()[:2]
        self.server_port = self.server_address[1]

    def _run(self):
        asyncio.set_event_loop(self.loop)
        self.loop.run_until_complete(self.server.serve())

    def shutdown(self):
        self.server.should_exit = True
        self.thread.join(timeout=15)

    def server_close(self):
        pass


def start(**kw) -> AppServer:
    return AppServer(**kw)
