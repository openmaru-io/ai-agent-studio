/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
// 위젯 Shadow DOM 의 포털 층(OMAI-1873): 툴팁·메뉴가 폭 0 컨테이너를 기준으로 그려져 한 글자씩 줄바꿈되던 회귀를 막는다
import { describe, expect, it } from 'vitest';

import { createShadowParts } from './shadowDom';

describe('createShadowParts 포털 층', () => {
  it('포털 층은 화면 전체 크기의 고정 층이고 클릭은 안에 그려진 것만 받는다', () => {
    const parts = createShadowParts(document);
    const s = parts.portalRoot.style;
    // 컨테이너는 호스트 화면을 가리지 않게 폭·높이 0 이다 — 포털이 이 크기를 기준으로 삼으면 안 된다
    expect(parts.container.style.width).toBe('0px');
    expect(s.position).toBe('fixed');
    expect([s.top, s.right, s.bottom, s.left]).toEqual(['0px', '0px', '0px', '0px']);
    expect(s.pointerEvents).toBe('none');
    expect(Number(s.zIndex)).toBeGreaterThan(2); // 위젯 창(zIndex 2) 위에 그린다
    const rules = [...parts.shadowRoot.querySelectorAll('style')].map((x) => x.textContent ?? '').join('\n');
    expect(rules).toContain('#cogentai-aas-widget-portal > * { pointer-events: auto; }');
  });
});
