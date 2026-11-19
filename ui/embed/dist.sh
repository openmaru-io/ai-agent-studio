#!/bin/bash
# Copyright 2026 The OPENMARU Authors.
#
# 빌드한 AAS 채팅 위젯(aas-widget.js·aas-widget-init.js)을 위젯을 붙이는 호스트 레포로 복사한다(OMAI-1873).
# CogentAI 위젯의 cogentai-ui/widget/dist.sh 와 같은 규칙이고, 대상도 같은 세 레포의 /cogentai/ 자리다.
# 먼저 위젯을 굽는다: cd ui && npm run build:widget (npm run build 도 끝에 굽는다). 산출물은 aas/static/js/ 에 있다.
#
#   ./dist.sh              # 워크스페이스의 호스트 레포로 복사
#   ./dist.sh --dry-run    # 무엇을 어디로 복사할지만 출력
#   ./dist.sh --init-only  # aas-widget-init.js 만 복사. 위젯 본체는 init 이 AAS 서버에서 불러온다(사설 인증서 현장, 2026-11-14)
#   WORKSPACE_ROOT=/data/sources ./dist.sh   # 레포 배치가 다른 환경
#
# 경로는 이 스크립트 위치 기준 상대 경로로 잡는다. 컴퓨터 이름으로 나누거나 절대 경로를 적지 않는다.
# 실패를 삼키지 않는다. 결과를 줄마다 찍고, 레포가 있는데 복사하지 못하면 0 이 아닌 코드로 끝난다.
# 레포가 없으면(체크아웃하지 않은 개발자) 건너뛰되 그 사실을 찍는다.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# embed → ui → cogentai-aas(레포) → cogentai-aas(워크스페이스) → openmaru-ai → Workspaces (5단계 위)
WORKSPACE_ROOT="${WORKSPACE_ROOT:-$(cd ../../../../.. && pwd)}"

DIST_DIR="$(cd ../.. && pwd)/aas/static/js"
FILES=("aas-widget.js" "aas-widget-init.js")
DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    # init 만 두면 브라우저가 AAS 인증서를 믿지 않을 때 init 이 「연결 설정 필요」 안내를 띄운다. 위젯 태그는 호스트에서 뺀다
    --init-only) FILES=("aas-widget-init.js") ;;
    *) echo "[error] 모르는 옵션: $arg (--dry-run, --init-only)"; exit 2 ;;
  esac
done

# "레포 경로|레포 안의 복사 대상 디렉터리" — 호스트 웹 루트의 /cogentai/ 에서 내보내는 자리(CogentAI 위젯 파일과 같은 곳).
# 셋 다 소스 디렉터리다(빌드 산출물이 아니라 커밋되는 자리). 레포 경로가 / 로 시작하면 절대 경로, 아니면 WORKSPACE_ROOT 기준이다.
TARGETS=(
  "openmaru-apm/khan-monitoring|src/main/webapp/console/js/plugin/cogentai"
  "openmaru-observ/openmaru-observ-ui|public/cogentai"
  "openmaru-cop/openmaru-cop-console|frontend/public/cogentai"
)

# 레포 배치가 다른 환경은 DIST_TARGETS 로 통째로 바꾼다 — 줄마다 "레포경로|하위경로".
#   DIST_TARGETS=$'/srv/apm|src/main/webapp/console/js/plugin/cogentai\n/srv/ui|public/cogentai' ./dist.sh
if [ -n "${DIST_TARGETS:-}" ]; then
  TARGETS=()
  while IFS= read -r line; do
    [ -n "$line" ] && TARGETS+=("$line")
  done <<< "$DIST_TARGETS"
fi

for f in "${FILES[@]}"; do
  if [ ! -f "$DIST_DIR/$f" ]; then
    echo "[error] $DIST_DIR/$f 가 없습니다. 먼저 cd ui && npm run build:widget 을 실행하세요."
    exit 1
  fi
done

for f in "${FILES[@]}"; do
  echo "[file] aas/static/js/$f ($(du -h "$DIST_DIR/$f" | cut -f1))"
done
echo "[workspace] $WORKSPACE_ROOT"
$DRY_RUN && echo "[dry-run] 실제로 복사하지 않습니다"
echo

copied=0
skipped=0
failed=0

copy_to() {
  # $1 = 표시용 경로, $2 = 대상 디렉터리(절대)
  local label="$1" dest="$2" f
  if $DRY_RUN; then
    for f in "${FILES[@]}"; do echo "   -> $label/$f"; done
    return 0
  fi
  if ! mkdir -p "$dest"; then
    echo "   [fail] $label — 디렉터리를 만들 수 없습니다"
    return 1
  fi
  for f in "${FILES[@]}"; do
    if ! cp "$DIST_DIR/$f" "$dest/"; then
      echo "   [fail] $label/$f — 복사 실패"
      return 1
    fi
    echo "   [ok] $label/$f"
  done
  return 0
}

for entry in "${TARGETS[@]}"; do
  repo="${entry%%|*}"
  subdir="${entry#*|}"
  case "$repo" in
    /*) repo_path="$repo" ;;
    *)  repo_path="$WORKSPACE_ROOT/$repo" ;;
  esac

  echo "$repo"
  if [ ! -d "$repo_path" ]; then
    echo "   [skip] 레포 없음: $repo_path"
    skipped=$((skipped + 1))
    echo
    continue
  fi

  if copy_to "$repo/$subdir" "$repo_path/$subdir"; then
    copied=$((copied + 1))
  else
    failed=$((failed + 1))
  fi

  # khan-monitoring 은 Maven 산출물(target/)에도 넣으면 다시 빌드하지 않고 확인할 수 있다. 이미 있을 때만 바꾸고 새로 만들지 않는다.
  for built in "$repo_path"/target/*/console/js/plugin/cogentai; do
    [ -d "$built" ] || continue
    rel="${built#"$WORKSPACE_ROOT"/}"
    for f in "${FILES[@]}"; do
      if $DRY_RUN; then
        echo "   -> $rel/$f (빌드 산출물)"
      elif cp "$DIST_DIR/$f" "$built/"; then
        echo "   [ok] $rel/$f (빌드 산출물)"
      else
        echo "   [fail] $rel/$f (빌드 산출물) — 복사 실패"
        failed=$((failed + 1))
      fi
    done
  done
  echo
done

echo "복사 $copied · 건너뜀 $skipped · 실패 $failed"
[ "$failed" -gt 0 ] && exit 1
exit 0
