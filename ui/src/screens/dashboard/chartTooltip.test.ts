/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { dialogTokens } from '@/lib/shellTokens';

import { compactAxis, formatTrendTooltip, trendAxisPointer, trendSeries, trendTooltip } from './chartTooltip';
import type { Series } from './trendData';

const rows = [
  { axisValueLabel: '10-12', seriesName: '7일 실행', value: 5, color: '#8a8f98' },
  { axisValueLabel: '10-12', seriesName: '실패', value: 0, color: '#DA291C' },
  { axisValueLabel: '10-12', seriesName: '멈춤', value: 1234, color: '#f59e0b' },
];

describe('대시보드 차트 툴팁', () => {
  it('날짜 한 줄과 시리즈별 점·이름·값 줄을 그린다. 값은 천 단위 쉼표', () => {
    const html = formatTrendTooltip(rows, 'dark');
    expect(html).toContain('10-12');
    for (const r of rows) {
      expect(html).toContain(r.seriesName);
      expect(html).toContain(`background:${r.color}`); // 색 점
    }
    expect(html).toContain('1,234');
    expect((html.match(/data-row/g) ?? []).length).toBe(3);
  });

  it('이름은 이스케이프한다', () => {
    const html = formatTrendTooltip([{ axisValueLabel: '<b>', seriesName: '<img src=x onerror=1>', value: 1, color: '#fff' }], 'light');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;img');
  });

  it('값이 없으면(null) 줄표로 보인다', () => {
    expect(formatTrendTooltip([{ axisValueLabel: '10-11', seriesName: '실패', value: null, color: '#fff' }], 'dark')).toContain('—');
  });

  it('글자는 11px 이하이고 다이얼로그와 같은 표면·테두리를 쓴다(다크·라이트)', () => {
    for (const mode of ['dark', 'light'] as const) {
      const t = trendTooltip(mode);
      const tk = dialogTokens[mode];
      expect(t.backgroundColor).toBe(tk.surface);
      expect(t.borderColor).toBe(tk.edge);
      expect(t.textStyle.fontSize).toBeLessThanOrEqual(11);
      expect(t.borderRadius).toBe(8);
      expect(t.confine).toBe(true);
    }
  });

  it('가이드 선은 가는 점선이다', () => {
    const p = trendAxisPointer('dark');
    expect(p.type).toBe('line');
    expect(p.lineStyle.type).toBe('dashed');
    expect(p.lineStyle.width).toBe(1);
  });
});

describe('Y축 눈금 줄임(compactAxis)', () => {
  it('1,000 미만은 그대로, 이상은 K·M·B 로 줄이고 .0 은 떼며 소수는 한 자리까지', () => {
    const cases: [number, string][] = [
      [0, '0'],
      [15, '15'],
      [999, '999'],
      [1000, '1K'],
      [1500, '1.5K'],
      [500_000, '500K'],
      [1_000_000, '1M'],
      [2_000_000, '2M'],
      [3_500_000, '3.5M'],
      [2_000_000_000, '2B'],
    ];
    for (const [n, out] of cases) expect(compactAxis(n)).toBe(out);
  });
  it('값이 없으면 빈 글자', () => {
    expect(compactAxis(null)).toBe('');
    expect(compactAxis(undefined)).toBe('');
  });
  it('툴팁은 줄이지 않고 전체 숫자를 쉼표로 보인다', () => {
    const html = formatTrendTooltip([{ axisValueLabel: '10-14', seriesName: '토큰', value: 3_500_000, color: '#8a8f98' }], 'dark');
    expect(html).toContain('3,500,000');
    expect(html).not.toContain('3.5M');
  });
});

describe('시리즈 모양(trendSeries)', () => {
  const bar: Series = { name: '토큰', kind: 'bar', tone: 'plain', values: [1, 2] };
  const line: Series = { name: '실패', kind: 'line', tone: 'bad', axis: 1, values: [0, 3] };

  it('막대는 위쪽 모서리만 살짝 둥글게(3px) 하고 아래는 축에 붙인다', () => {
    const o = trendSeries(bar, '#8a8f98');
    expect(o.type).toBe('bar');
    expect(o.itemStyle.borderRadius).toEqual([3, 3, 0, 0]);
    expect(o.itemStyle.opacity).toBe(0.55); // 옛 불투명도 유지
  });

  it('선은 부드러운 곡선이되 값 사이에서 위아래로 튀지 않게 x 방향 단조로 잇고, 끝·꺾임은 둥글게 한다', () => {
    const o = trendSeries(line, '#DA291C');
    if (o.type !== 'line') throw new Error('선 시리즈여야 한다');
    expect(o.smooth).toBeGreaterThan(0);
    expect(o.smooth).toBeLessThanOrEqual(0.4); // 너무 휘면 값이 달라 보인다
    expect(o.smoothMonotone).toBe('x');
    expect(o.lineStyle).toMatchObject({ width: 2, cap: 'round', join: 'round', color: '#DA291C' });
    expect(o.itemStyle.opacity).toBe(1);
  });

  it('이름·값·축·색은 그대로 넘긴다. 빈 값은 이어 그리지 않는다', () => {
    const o = trendSeries(line, '#DA291C');
    expect(o).toMatchObject({ name: '실패', yAxisIndex: 1, data: [0, 3], connectNulls: false });
    expect(trendSeries(bar, '#fff').yAxisIndex).toBe(0);
  });
});

