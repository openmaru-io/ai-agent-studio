#!/usr/bin/env bash
# Copyright 2026 The OPENMARU Authors.
# 이미지 하나를 여러 아키텍처로 빌드해 올린다(make push 가 부른다, 스펙 2026-11-17-001 R1).
#
#   bin/push-image.sh <이미지 이름> <빌드 폴더> [docker buildx build 인자…]
#
# AAS_BUILD_NUM 이 있으면 지워지지 않는 고유 태그 <VERSION>-b<번호>-<커밋 앞 7자> 로 먼저 올리고, 같은 digest 로 <VERSION> 태그를 옮긴다.
# 그래서 <VERSION> 만 새 digest 로 덮여 옛 digest 가 태그를 잃는 일이 없다(옛 digest 에는 자기 고유 태그가 남는다).
# 2026-11-17 운영 COP: 같은 태그를 다시 빌드하자 Harbor 가 태그 없는 옛 이미지를 지워, 롤아웃이 고정한 digest 를 다시 받지 못했다.
#
# 환경변수: REGISTRY·VERSION(필수), AAS_BUILD_NUM(Jenkins BUILD_NUMBER), GIT_SHA7(비우면 git rev-parse HEAD | cut -c1-7),
#   PLATFORMS, BUILDER, ALLOW_NO_UNIQUE_TAG=1(고유 태그 없이, 이미 있는 <VERSION> 을 덮기),
#   AAS_IMAGE_FILE(끝 줄 「AAS_IMAGE <server|sidecar>=<저장소>:<고유 태그>@sha256:<64자>」를 덧붙일 파일).
set -euo pipefail

name=${1:?이미지 이름}
context=${2:?빌드 폴더}
shift 2
: "${REGISTRY:?REGISTRY 를 정하세요}" "${VERSION:?VERSION 을 정하세요}"
PLATFORMS=${PLATFORMS:-linux/amd64,linux/arm64}
BUILDER=${BUILDER:-aas-multi}
repo="$REGISTRY/$name"

err() { echo "ERROR: $*" >&2; exit 1; }
# 태그가 가리키는 index digest. --format '{{.Manifest.Digest}}' 는 Jenkins 의 buildx 가 무시하고 기본 텍스트를 내서(2026-11-17 #631)
# 기본 텍스트의 맨 위 「Digest:」 줄을 읽는다. 하위 manifest 줄은 들여 써 있고 「Digest:」 칸이 없다.
index_digest() { docker buildx imagetools inspect "$1" | awk '$1 == "Digest:" { print $2; exit }'; }

build=(docker buildx build --builder "$BUILDER" --platform "$PLATFORMS" "$@")

if [ -z "${AAS_BUILD_NUM:-}" ]; then
	# 고유 태그 없이 이미 있는 <VERSION> 을 덮으면 옛 digest 가 태그를 잃어 레지스트리 정리에 지워질 수 있다. 롤아웃이 그 digest 를
	# 고정했으면 파드가 다시 받지 못한다. 그래서 덮을 태그가 있으면 멈춘다(처음 올리는 태그는 그대로 올린다).
	if docker buildx imagetools inspect "$repo:$VERSION" >/dev/null 2>&1; then
		[ "${ALLOW_NO_UNIQUE_TAG:-}" = 1 ] ||
			err "$repo:$VERSION 이 이미 있습니다. 고유 태그 없이 덮으면 옛 digest 가 태그를 잃어 지워질 수 있습니다. AAS_BUILD_NUM 을 주거나(고유 태그), 꼭 덮어야 하면 ALLOW_NO_UNIQUE_TAG=1"
		echo "WARN: 고유 태그 없이 $repo:$VERSION 을 덮습니다" >&2
	fi
	"${build[@]}" -t "$repo:$VERSION" --push "$context"
	exit 0
fi

sha=${GIT_SHA7:-$(git rev-parse HEAD 2>/dev/null | cut -c1-7 || true)}
unique="$VERSION-b$AAS_BUILD_NUM-$sha"
# --short=7 은 최소 길이라 해시가 겹치면 길어진다. 그래서 cut 으로 자르고 꼴을 검사한다(Eng H4).
if ! [[ "$AAS_BUILD_NUM" =~ ^[0-9]+$ && "$unique" =~ -b[0-9]+-[0-9a-f]{7}$ ]]; then
	err "unique tag '$unique' 형식 오류 (AAS_BUILD_NUM='$AAS_BUILD_NUM', GIT_SHA='$sha')"
fi

meta=$(mktemp)
log=$(mktemp)
trap 'rm -f "$meta" "$log"' EXIT
if ! "${build[@]}" -t "$repo:$unique" --metadata-file "$meta" --push "$context" 2>&1 | tee "$log"; then
	if grep -qi 'immutable' "$log"; then
		old=$(index_digest "$repo:$unique" 2>/dev/null || true)
		err "tag $unique 는 이미 digest ${old:7:12} 에 고정됨 — Jenkins 빌드를 새로 돌리세요(새 BUILD_NUMBER)"
	fi
	err "$repo:$unique 를 올리지 못했습니다"
fi
digest=$(tr -d ' \n' <"$meta" | grep -o '"containerimage.digest":"sha256:[0-9a-f]\{64\}"' | grep -o 'sha256:[0-9a-f]\{64\}' || true)
[ -n "$digest" ] || err "metadata 파일에서 containerimage.digest 를 읽지 못했습니다($repo:$unique)"

# 다시 빌드하지 않고 같은 digest 에 <VERSION> 태그를 단다. 원본이 index 하나면 buildx 는 그대로 옮긴다 — 판·옵션에 따라 index 를
# 새로 만들 수 있으므로 옮긴 뒤 digest 를 비교한다(Eng H7).
docker buildx imagetools create -t "$repo:$VERSION" "$repo@$digest"
moved=$(index_digest "$repo:$VERSION" || true)
[ "$moved" = "$digest" ] || err "$repo:$VERSION 이 $moved 를 가리킵니다(고유 태그 digest $digest 와 다름)"

line="AAS_IMAGE ${name#cogentai-aas-}=$repo:$unique@$digest"
echo "$line"
[ -n "${AAS_IMAGE_FILE:-}" ] && echo "$line" >>"$AAS_IMAGE_FILE"
exit 0
