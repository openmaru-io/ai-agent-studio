/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';

import { BRAND_LOGOS, brandKey, brandLogos, brandProduct } from './brand';

type W = Window & { __RUNTIME_CONFIG__?: { PRODUCT_NAME?: string | null } };

afterEach(() => {
  delete (window as W).__RUNTIME_CONFIG__;
});

describe('설치 브랜드(OMAI-1299)', () => {
  it('서버가 넣은 PRODUCT_NAME 을 COP 콘솔과 같은 규칙으로 읽는다', () => {
    const cases: [string | null | undefined, string][] = [
      [undefined, 'OPENMARU'],
      [null, 'OPENMARU'],
      ['', 'OPENMARU'],
      ['%PRODUCT_NAME%', 'OPENMARU'],
      ['MSAP_CogentAI', 'MSAP'],
      ['AINP CogentAI', 'AINP'],
      ['msap_cogentai', 'MSAP'],
      ['FOO_CogentAI', 'OPENMARU'],
    ];
    for (const [raw, key] of cases) {
      (window as W).__RUNTIME_CONFIG__ = raw === undefined ? undefined : { PRODUCT_NAME: raw };
      expect(brandKey(), String(raw)).toBe(key);
    }
  });

  it('브랜드마다 다른 로고 묶음과 이름을 준다', () => {
    (window as W).__RUNTIME_CONFIG__ = { PRODUCT_NAME: 'AINP_CogentAI' };
    expect(brandLogos()).toBe(BRAND_LOGOS.AINP);
    expect(brandProduct()).toBe('AINP CogentAI');
    const all = new Set(Object.values(BRAND_LOGOS).map((l) => l.rwh));
    expect(all.size).toBe(3);
    for (const l of Object.values(BRAND_LOGOS)) expect(Object.keys(l).sort()).toEqual(['h', 'rwh', 'rwv', 'v', 'wh', 'wv']);
  });
});
