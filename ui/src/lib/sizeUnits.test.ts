/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { displayQty, draftToQty, fromUnit, parseQty, sameQty, toUnit } from './sizeUnits';

describe('작업공간 크기 단위(스펙 2026-10-30-003 §4-7 4A)', () => {
  it('화면 단위와 쿠버네티스 수량을 오간다: 0.5개 ↔ 500m, 1.25GiB ↔ 1280Mi', () => {
    expect(fromUnit('cpu', 0.5)).toBe('500m');
    expect(displayQty('cpu', '500m')).toBe('0.5');
    expect(fromUnit('memory', 1.25)).toBe('1280Mi');
    expect(displayQty('memory', '1280Mi')).toBe('1.25');
    expect(fromUnit('cpu', 2)).toBe('2');
    expect(fromUnit('memory', 4)).toBe('4Gi');
    expect(fromUnit('memory', 0.25)).toBe('256Mi');
    expect(fromUnit('cpu', 0.15)).toBe('150m'); // 0.05 단위 입력의 부동소수 오차
    for (const v of [0.05, 0.25, 0.5, 1, 1.5, 4]) expect(toUnit('cpu', fromUnit('cpu', v))).toBeCloseTo(v, 9);
    for (const v of [0.25, 1, 1.25, 2.5, 8, 50]) expect(toUnit('memory', fromUnit('memory', v))).toBeCloseTo(v, 9);
  });

  it('설치값 250m 은 0.25개로, 나누어 떨어지지 않는 1300Mi 는 1.27GiB 로 보인다(R13)', () => {
    expect(displayQty('cpu', '250m')).toBe('0.25');
    expect(displayQty('memory', '1300Mi')).toBe('1.27');
    expect(displayQty('memory', '4Gi')).toBe('4');
    expect(displayQty('cpu', null)).toBe('');
  });

  it('고치지 않은 칸은 원래 수량을 그대로 보내고, 고친 칸만 바꾼다', () => {
    expect(draftToQty('memory', '1.27', '1300Mi')).toBe('1300Mi');
    expect(draftToQty('memory', '1.5', '1300Mi')).toBe('1536Mi');
    expect(draftToQty('cpu', '0.5', null)).toBe('500m');
    expect(draftToQty('cpu', '  ', '2')).toBeNull(); // 비우면 그 칸을 지운다
    expect(draftToQty('cpu', 'abc', null)).toBeUndefined();
    expect(draftToQty('memory', '0', null)).toBeUndefined();
    expect(draftToQty('memory', '-1', null)).toBeUndefined();
  });

  it('수량 읽기는 서버와 같은 접미사를 안다', () => {
    expect(parseQty('14070m')).toBeCloseTo(14.07, 9);
    expect(parseQty('31881Mi')).toBe(31881 * 2 ** 20);
    expect(parseQty('1e3')).toBe(1000);
    expect(parseQty('2k')).toBe(2000);
    expect(parseQty('x')).toBeNull();
    expect(sameQty('500m', '0.5')).toBe(true);
    expect(sameQty('4096Mi', '4Gi')).toBe(true);
    expect(sameQty('1Gi', null)).toBe(false);
    expect(sameQty(null, undefined)).toBe(true);
  });
});
