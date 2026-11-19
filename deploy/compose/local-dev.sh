#!/bin/sh
# Copyright 2026 The OPENMARU Authors.
# 화면 개발 환경을 한 번에 띄우고 끈다: LiteLLM 터널(oke-litellm.sh) → (리눅스) 브리지 터널 → compose(서버) → Vite 개발 서버(3000).
#   사용: ./local-dev.sh start [--build] | stop | status
#   --build : Python 서버 코드(aas/)를 고쳤을 때 서버 이미지를 다시 만든다. 화면 코드는 개발 서버가 바로 반영한다.
# .env 에 OKE_BASTION 과 AAS_ALLOWED_HOSTS(localhost:3000,127.0.0.1:3000 포함)가 있어야 한다(README.md).
set -eu
cd "$(dirname "$0")"
[ -f .env ] || { echo ".env 가 없습니다. cp .env.example .env 로 만드세요." >&2; exit 1; }
get() { sed -n "s/^$1=//p" .env | tail -1; }
BASTION=$(get OKE_BASTION)
PORT=$(get LITELLM_LOCAL_PORT); PORT=${PORT:-14400}
# 나만 쓰는 폴더(여러 사용자가 함께 쓰는 /tmp 의 정해진 이름은 남이 먼저 만들어 링크·PID 파일을 심을 수 있다)
RUN="${XDG_RUNTIME_DIR:-$HOME/.cache}/aas-local-dev"
mkdir -p "$RUN"
chmod 700 "$RUN"
[ -O "$RUN" ] || { echo "$RUN 의 소유자가 내가 아닙니다." >&2; exit 1; }
BRIDGE_PID="$RUN/bridge-$PORT.pid"
UI_PID="$RUN/ui.pid"
UI_LOG="$RUN/ui.log"

# 우리가 띄운 명령줄 — PID 파일의 번호가 재부팅 뒤 다른 프로세스(sshd·pnpm 등)에 다시 쓰였으면 우리 것이 아니다
BRIDGE_CMD=":$PORT:127.0.0.1:$PORT"
UI_CMD="npm run dev"
# alive PID파일 명령줄: 살아 있고, 내 프로세스이고, 명령줄에 그 글이 있을 때만 참
alive() {
  [ -f "$1" ] || return 1
  pid=$(cat "$1")
  [ "$(ps -p "$pid" -o user= 2>/dev/null | tr -d ' ')" = "$(id -un)" ] || return 1
  ps -p "$pid" -o args= 2>/dev/null | grep -qF -- "$2"
}

# 리눅스의 컨테이너는 host.docker.internal(docker 브리지 주소)로 오는데, oke-litellm.sh 의 터널은 127.0.0.1 에만 열린다.
# 브리지 주소에도 같은 터널 입구를 연다(맥 Docker Desktop 은 필요 없다).
bridge_up() {
  [ "$(uname)" = Linux ] || return 0
  alive "$BRIDGE_PID" "$BRIDGE_CMD" && { echo "브리지 터널: 이미 열림"; return 0; }
  GW=$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}')
  # 빈 값이면 터널이 모든 주소에 열려 LiteLLM 이 사내망에 드러난다
  case "$GW" in
    "" | *[!0-9.]*) echo "docker 브리지 주소를 읽지 못했습니다('$GW')." >&2; exit 1 ;;
  esac
  ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
    -L "$GW:$PORT:127.0.0.1:$PORT" "$BASTION" </dev/null >/dev/null 2>&1 &
  echo $! > "$BRIDGE_PID"
  sleep 2
  alive "$BRIDGE_PID" "$BRIDGE_CMD" || { echo "브리지 터널이 열리지 않습니다($GW:$PORT)." >&2; rm -f "$BRIDGE_PID"; exit 1; }
  echo "브리지 터널: $GW:$PORT"
}

# stop_pid PID파일 명령줄 이름: 그 프로세스가 묶음의 머리(setsid 로 띄움)면 묶음 전체(npm 과 vite)를, 아니면 그것만 끈다
stop_pid() {
  if alive "$1" "$2"; then
    pid=$(cat "$1")
    if [ "$(ps -p "$pid" -o pgid= | tr -d ' ')" = "$pid" ]; then
      kill -TERM -"$pid" 2>/dev/null || true
    else
      kill "$pid" 2>/dev/null || true
    fi
    echo "$3: 끔"
  fi
  rm -f "$1"
}

case "${1:-}" in
  start)
    [ -n "$BASTION" ] || { echo ".env 에 OKE_BASTION=사용자@주소 를 적으세요." >&2; exit 1; }
    ./oke-litellm.sh up
    bridge_up
    if [ "${2:-}" = --build ]; then docker compose up -d --build; else docker compose up -d; fi
    if alive "$UI_PID" "$UI_CMD"; then echo "개발 서버: 이미 돎"
    else
      # 새 세션으로 띄워 stop 이 npm 과 vite 를 함께 끈다(setsid 가 없는 맥은 npm 만). 입출력을 모두 떼야 start 가 끝난다
      SETSID=$(command -v setsid || true)
      (cd ../../ui && exec $SETSID npm run dev </dev/null >"$UI_LOG" 2>&1) &
      echo $! > "$UI_PID"
      sleep 2
      alive "$UI_PID" "$UI_CMD" || { echo "개발 서버가 뜨지 않습니다. $UI_LOG 를 보세요." >&2; rm -f "$UI_PID"; exit 1; }
      echo "개발 서버: http://127.0.0.1:3000 (기록 $UI_LOG)"
    fi
    ;;
  stop)
    stop_pid "$UI_PID" "$UI_CMD" "개발 서버"
    docker compose down || echo "compose 를 내리지 못했습니다. 터널은 이어서 닫습니다." >&2
    stop_pid "$BRIDGE_PID" "$BRIDGE_CMD" "브리지 터널"
    ./oke-litellm.sh down
    ;;
  status)
    ./oke-litellm.sh status || true
    if alive "$BRIDGE_PID" "$BRIDGE_CMD"; then echo "브리지 터널: 열림"; else echo "브리지 터널: 닫힘"; fi
    docker compose ps --format 'table {{.Service}}\t{{.Status}}'
    if alive "$UI_PID" "$UI_CMD"; then echo "개발 서버: 돎 (http://127.0.0.1:3000)"; else echo "개발 서버: 꺼짐"; fi
    ;;
  *) echo "사용: $0 start [--build] | stop | status" >&2; exit 2 ;;
esac
