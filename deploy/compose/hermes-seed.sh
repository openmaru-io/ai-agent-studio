#!/bin/sh
# Copyright 2026 The OPENMARU Authors.
# Hermes 데이터 폴더의 첫 값. compose 의 hermes-seed 서비스가 Hermes 보다 먼저 한 번 돌린다.
#   - config.yaml 이 없을 때만 /seed/config.yaml 을 복사한다. 있으면 건드리지 않는다(Hermes·대시보드가 고친 내용을 지키려고).
#   - 기본 프로파일 .env 에 HERMES_LLM_BASE_URL·HERMES_LLM_MODEL·HERMES_LLM_API_KEY 가 없을 때만 컨테이너 환경변수 값을 넣는다.
#     상류 Hermes 는 채팅·크론 차례에서 설정의 ${HERMES_LLM_*} 를 프로파일 .env 로만 풀기 때문이다. 나중에 바꾸려면 AAS 의 비밀값 화면에서 고친다.
# 파일 주인은 끝에 HERMES_UID:HERMES_GID(기본 10000)로 맞춘다. 상류 이미지는 시작할 때 root 로 다시 고치지만(stage2-hook),
# 패치를 적용한 이미지는 처음부터 hermes 사용자로 돌아 root 소유 .env(0600)를 읽지 못하고 죽었다(2026-10-23).
# 사용: hermes-seed.sh <데이터 폴더>...
set -eu
for d in "$@"; do
  [ -f "$d/config.yaml" ] || cp "${HERMES_SEED_CONFIG:-/seed/config.yaml}" "$d/config.yaml"
  if [ ! -f "$d/.env" ]; then
    : > "$d/.env"
    chmod 600 "$d/.env"
  fi
  for k in HERMES_LLM_BASE_URL HERMES_LLM_MODEL HERMES_LLM_API_KEY; do
    grep -q "^$k=" "$d/.env" || printf '%s=%s\n' "$k" "$(printenv "$k" || true)" >> "$d/.env"
  done
  chown "${HERMES_UID:-10000}:${HERMES_GID:-10000}" "$d/config.yaml" "$d/.env"
done
