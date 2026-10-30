/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 사람·에이전트 얼굴(DiceBear Pixel Art — 그림 CC0 1.0, 코드 MIT, 스펙 2026-10-21-016). 같은 시드는 어디서나 같은 얼굴이다 —
// 명단·서랍·3D 가 같은 함수를 쓴다. 예전에는 Multiavatar 였다(계획 007 U2·R3).
import { createAvatar } from '@dicebear/core';
import * as pixelArt from '@dicebear/pixel-art';

// 둥근 바탕 색(DiceBear 문서의 예시 파스텔 색). 시드로 하나를 고른다
const BACKGROUND = ['b6e3f4', 'c0aede', 'd1d4f9', 'ffd5dc', 'ffdfbf'];

const cache = new Map<string, string>();

/** 얼굴 SVG 의 data: URL. img src 로 쓴다(외부 요청 없음). bare 면 둥근 바탕을 뺀다(3D 머리 앞면용). */
export function faceUrl(seed: string, bare = false): string {
  const key = (bare ? 'bare:' : '') + (seed || '?');
  let url = cache.get(key);
  if (!url) {
    const svg = createAvatar(pixelArt, { seed: seed || '?', ...(bare ? {} : { backgroundColor: BACKGROUND, radius: 50 }) })
      .toString()
      // 라이선스 메타데이터(출처·라이선스 주소)는 뺀다. CC0 라 표기 의무가 없고, 3D 텍스처마다 1KB 가량 줄어든다
      .replace(/<metadata[\s\S]*?<\/metadata>/, '');
    url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    cache.set(key, url);
  }
  return url;
}

/** 에이전트 얼굴 시드: 자리의 avatar 값, 없으면 별칭. */
export const agentSeed = (a: { avatar?: string; alias: string }) => a.avatar || a.alias;
