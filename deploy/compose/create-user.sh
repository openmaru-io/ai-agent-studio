#!/bin/sh
# Copyright 2026 The OPENMARU Authors.
# AAS 자체 계정(시험·비상용 로그인)의 비밀번호를 정한다. 서버는 로그인 없이는 127.0.0.1 밖으로 열리지 않으므로
# 처음 `up` 하기 전에 한 번 돌린다. 사용: ./create-user.sh admin@example.com
set -eu
[ $# -eq 1 ] || { echo "사용: $0 <이메일>" >&2; exit 2; }
cd "$(dirname "$0")"
[ -f .env ] || { echo ".env 가 없습니다. cp .env.example .env 로 만들고 채우세요." >&2; exit 1; }
# --no-deps: 사이드카를 띄우지 않고 서버 이미지로 계정 파일(aas-config 볼륨의 users.json)만 만든다
exec docker compose run --rm --no-deps -it aas python -m aas user set-password "$1"
