# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""python -m aas_sidecar serve | check

환경: AAS_SIDECAR_ROOT(기본 /opt/data), AAS_SIDECAR_TOKEN 또는 AAS_SIDECAR_TOKEN_FILE(필수), AAS_SIDECAR_PORT(기본 17950).
"""
from __future__ import annotations

import argparse
import http.client
import os
import sys
from pathlib import Path

from .ops import Ops
from .server import make_server


def _token() -> str:
    path = os.environ.get("AAS_SIDECAR_TOKEN_FILE")
    value = Path(path).read_text(encoding="utf-8").strip() if path else os.environ.get("AAS_SIDECAR_TOKEN", "")
    if not value:
        raise SystemExit("AAS_SIDECAR_TOKEN 또는 AAS_SIDECAR_TOKEN_FILE 이 필요합니다(토큰 없이는 시작하지 않습니다).")
    return value


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="aas_sidecar")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sp = sub.add_parser("serve")
    sp.add_argument("--host", default="127.0.0.1")
    sp.add_argument("--port", type=int, default=int(os.environ.get("AAS_SIDECAR_PORT", "17950")))
    cp = sub.add_parser("check", help="exec 프로브용: 같은 파드의 사이드카가 version 에 답하는지 본다")
    cp.add_argument("--port", type=int, default=int(os.environ.get("AAS_SIDECAR_PORT", "17950")))
    args = ap.parse_args(argv)
    if args.cmd == "check":
        c = http.client.HTTPConnection("127.0.0.1", args.port, timeout=3)
        try:
            c.request("GET", "/v1/version", headers={"Authorization": f"Bearer {_token()}"})
            return 0 if c.getresponse().status == 200 else 1
        except OSError:
            return 1
    root = Path(os.environ.get("AAS_SIDECAR_ROOT", "/opt/data"))
    httpd = make_server(args.host, args.port, Ops(root), _token())
    print(f"aas-sidecar: {args.host}:{args.port} root={root}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
