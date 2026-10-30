#!/bin/sh
# Copyright 2026 The OPENMARU Authors.
# 화면 대조(옛 화면과 새 화면)용으로 Hermes 3개에 크론 작업·실행 기록·대화 세션을 채운다. seed-multi.sh 다음에 돌린다.
#   - 크론: 설치본마다 정상·멈춤·실패(실행하면 exit 1 인 스크립트) 작업을 섞는다.
#   - 실패 기록: 1분 일정의 실패 작업을 만들고 한 번 실행시켜(`hermes cron tick`) 사건이 생기게 한다. 1분 넘게 걸린다.
#   - 대화 세션: 모델이 연결돼 있으면(`oke-litellm.sh up`) 프로파일마다 한 번씩 말을 걸어 세션 기록을 만든다.
# 사용: ./seed-data-multi.sh [--no-chat]
set -eu
cd "$(dirname "$0")"
F="-f docker-compose.multi.yml"
H() { pod="$1"; shift; docker compose $F exec -T "hermes-$pod" hermes "$@"; }
add() {   # 설치본 프로파일 이름 일정 [옵션…] — 같은 이름의 작업이 이미 있으면 건너뛴다
  pod="$1"; prof="$2"; name="$3"; sched="$4"; shift 4
  if H "$pod" -p "$prof" cron list 2>/dev/null | grep -q "Name: *$name\$"; then echo "$pod/$prof $name: 이미 있음"
  else H "$pod" -p "$prof" cron create "$sched" "$@" --name "$name" >/dev/null && echo "$pod/$prof $name: 만들었습니다"; fi
}
add one ma  daily-report 'every 6h'   "어제 실적을 세 줄로 요약해 줘" --deliver local
# 상류 Hermes 는 없는 스크립트로는 작업을 만들지 못한다. 실행하면 실패하는(exit 1) 스크립트를 먼저 둔다
docker compose $F exec -T -u hermes hermes-one sh -c 'mkdir -p /opt/data/profiles/ops/scripts && printf "#!/bin/sh\nexit 1\n" > /opt/data/profiles/ops/scripts/failing-check.sh && chmod 755 /opt/data/profiles/ops/scripts/failing-check.sh'
add one ops health-check '1m'         --script failing-check.sh --no-agent --deliver local
add one ops weekly-digest '0 9 * * 1' "한 주 요약" --deliver local --paused --paused-reason "시험: 멈춰 둠"
add two qa  nightly-scan 'every 12h'  "시험 결과를 점검해 줘" --deliver local
add two doc stale-docs   '0 8 * * *'  "오래된 문서를 찾아 줘" --deliver local --paused --paused-reason "시험: 멈춰 둠"
add three sa sync-check  'every 3h'   "동기화 상태를 확인해 줘" --deliver local
echo "실패 기록을 만들기 위해 70초를 기다린 뒤 한 번 실행합니다..."
sleep 70
H one -p ops cron tick >/dev/null 2>&1 || true
if [ "${1:-}" != "--no-chat" ]; then
  for pair in "one:ma" "one:ops" "two:qa" "three:sa"; do
    pod="${pair%%:*}"; prof="${pair##*:}"
    H "$pod" -p "$prof" -z "한 줄로 인사해" >/dev/null 2>&1 && echo "$pod/$prof: 대화 세션 만들었습니다" || echo "$pod/$prof: 대화 실패(모델 연결을 확인하세요)"
  done
fi
