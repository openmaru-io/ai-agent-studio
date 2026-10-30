/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { agentSeed, faceUrl } from './face';

describe('faceUrl', () => {
  it('같은 시드는 같은 얼굴, 다른 시드는 다른 얼굴이다', () => {
    expect(faceUrl('kim')).toBe(faceUrl('kim'));
    expect(faceUrl('kim')).not.toBe(faceUrl('lee'));
  });

  it('외부 주소를 넣지 않은 SVG data URL 이다(에어갭)', () => {
    const svg = decodeURIComponent(faceUrl('kim').split(',')[1]);
    expect(faceUrl('kim')).toMatch(/^data:image\/svg\+xml/);
    expect(svg.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, '')).not.toMatch(/https?:\/\//);
  });

  it('DiceBear Pixel Art(CC0) 얼굴이고 라이선스 메타데이터는 뺀다(스펙 2026-10-21-016)', () => {
    for (const bare of [false, true]) {
      const svg = decodeURIComponent(faceUrl('kim', bare).split(',')[1]);
      expect(svg).toContain('viewBox="0 0 16 16"');
      expect(svg).toContain('shape-rendering="crispEdges"');
      expect(svg).not.toContain('<metadata');
    }
  });

  it('3D 용(bare)은 둥근 바탕을 뺀 다른 그림이다', () => {
    expect(faceUrl('kim', true)).not.toBe(faceUrl('kim'));
    expect(faceUrl('kim', true)).toBe(faceUrl('kim', true));
  });

  it('에이전트는 자리 얼굴 값, 없으면 별칭을 시드로 쓴다', () => {
    expect(agentSeed({ alias: 'ma', avatar: '' })).toBe('ma');
    expect(agentSeed({ alias: 'ma', avatar: 'cat' })).toBe('cat');
  });
});
