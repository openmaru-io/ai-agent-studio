#!/bin/sh
# Copyright 2026 The OPENMARU Authors.
# Hermes 여러 개 시험 환경에 프로파일을 만든다(설치본마다 둘). AAS 의 「오피스 › 자리」에서 앉힐 대상이다.
# 기본 프로파일의 설정(모델 연결 포함)을 복제해 만든다. 이미 있는 프로파일은 건너뛴다. 사용: ./seed-multi.sh
set -eu
cd "$(dirname "$0")"
F="-f docker-compose.multi.yml"
for pair in "one:ma" "one:ops" "two:qa" "two:doc" "three:sa" "three:dev"; do
  pod="${pair%%:*}"; name="${pair##*:}"
  if docker compose $F exec -T -u hermes "hermes-$pod" hermes profile list 2>/dev/null | grep -q "^ *[◆ ]*$name "; then
    echo "$pod/$name: 이미 있음"
  else
    docker compose $F exec -T -u hermes "hermes-$pod" hermes profile create --clone "$name" >/dev/null && echo "$pod/$name: 만들었습니다"
  fi
done
