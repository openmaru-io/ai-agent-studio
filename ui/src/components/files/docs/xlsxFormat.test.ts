/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { cellText, colName, isNumeric, serialToDate } from './xlsxFormat';

describe('엑셀 칸 글자(재검토 D6)', () => {
  it.each([
    [0.083, '0.0%', '8.3%'],
    [0.5, '0%', '50%'],
    [1234567.891, '#,##0', '1,234,568'],
    [1234.5, '#,##0.00', '1,234.50'],
    [3.14159, '0.00', '3.14'],
    [0.1 + 0.2, 'General', '0.3'],
    [42, undefined, '42'],
    [1234.5, '"₩"#,##0;[Red]-"₩"#,##0', '1,235'],
  ])('%s · %s → %s', (v, fmt, want) => {
    expect(cellText(v, fmt)).toBe(want);
  });

  it('날짜는 표시 형식에 따라 날짜만 또는 시각까지', () => {
    const d = new Date(Date.UTC(2026, 9, 20, 9, 5, 7));
    expect(cellText(d, 'yyyy-mm-dd')).toBe('2026-10-20');
    expect(cellText(d, 'yyyy-mm-dd hh:mm')).toBe('2026-10-20 09:05');
    expect(cellText(d, 'hh:mm:ss')).toBe('2026-10-20 09:05:07');
    expect(cellText(d)).toBe('2026-10-20');
  });

  it('날짜 형식인데 일련번호로 오면 날짜로 바꾼다', () => {
    expect(serialToDate(46315).toISOString().slice(0, 10)).toBe('2026-10-20');
    expect(cellText(46315, 'yyyy-mm-dd')).toBe('2026-10-20');
    expect(cellText(46315.5, 'm/d/yy h:mm')).toBe('2026-10-20 12:00');
  });

  it('수식은 저장된 결과값, 결과가 없으면 수식 글자([object Object] 가 아니다)', () => {
    expect(cellText({ formula: 'B2*2', result: 4 })).toBe('4');
    expect(cellText({ formula: 'SUM(A1:A3)', result: 0.25 }, '0%')).toBe('25%');
    expect(cellText({ formula: 'B2*2' })).toBe('=B2*2');
    expect(cellText({ sharedFormula: 'C2', result: 'x' })).toBe('x');
  });

  it('서식 글자·링크·오류·참거짓·빈 칸', () => {
    expect(cellText({ richText: [{ text: '굵은 ' }, { text: '글자' }] })).toBe('굵은 글자');
    expect(cellText({ text: '사이트', hyperlink: 'https://x' })).toBe('사이트');
    expect(cellText({ error: '#DIV/0!' })).toBe('#DIV/0!');
    expect(cellText(true)).toBe('TRUE');
    expect(cellText(null)).toBe('');
    expect(cellText('<b>그대로</b>')).toBe('<b>그대로</b>');
  });

  it('숫자·날짜·수식 결과 숫자는 오른쪽 정렬', () => {
    expect(isNumeric(1)).toBe(true);
    expect(isNumeric(new Date())).toBe(true);
    expect(isNumeric({ formula: 'A1', result: 3 })).toBe(true);
    expect(isNumeric('1')).toBe(false);
  });

  it('열 이름', () => {
    expect([1, 26, 27, 52, 100].map(colName)).toEqual(['A', 'Z', 'AA', 'AZ', 'CV']);
  });
});
