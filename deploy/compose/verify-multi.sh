#!/bin/sh
# Copyright 2026 The OPENMARU Authors.
# Hermes 여러 개 시험 환경 점검: AAS 서버 안에서 설치본마다 ① 대시보드 로그인 ② 사이드카로 프로파일 읽기를 해 본다.
# 사용: ./verify-multi.sh   (docker compose -f docker-compose.multi.yml up -d 뒤에)
set -eu
cd "$(dirname "$0")"
docker compose -f docker-compose.multi.yml exec -T aas python - <<'PY'
import sys
from aas.ops import cron_health
from aas.web import server
from aas.hermes.hermes_api import HermesAPI

reg, bad = server.registry(), 0
if reg.error:
    print("등록부 오류:", reg.error); sys.exit(1)
for pod in reg.pods:
    try:
        api = HermesAPI(server.hub(pod).auth)
        profiles = api.call("GET", "/api/profiles").get("profiles", [])
        boards = api.call("GET", "/api/plugins/kanban/boards").get("boards", [])
        read = [p.name for p in cron_health.hr.profiles(pod.hermes_home)]
        print(f"{pod.id}: 대시보드 로그인 ok · 프로파일 {len(profiles)}개 · 칸반 보드 {len(boards)}개 · 사이드카로 읽은 프로파일 {sorted(read)}")
    except Exception as exc:
        bad += 1
        print(f"{pod.id}: 실패 — {type(exc).__name__}: {exc}")
sys.exit(1 if bad else 0)
PY
