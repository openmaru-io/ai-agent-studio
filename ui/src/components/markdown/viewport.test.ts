/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  CHART_HEIGHT,
  chartHeight,
  expandAll,
  fitView,
  isTreeChart,
  MAX_SCALE,
  MIN_SCALE,
  titleLayout,
  treeZoom,
  withTreeDefaults,
  wrapLines,
  zoomAt,
} from './viewport';

describe('diagram viewport', () => {
  it('큰 ERD 는 380px 상자에 다 들어가게 줄여 가운데에 둔다', () => {
    const v = fitView(800, 2000, 700, 380);
    expect(v.scale).toBeCloseTo((380 - 24) / 2000);
    expect(v.y).toBeCloseTo((380 - 2000 * v.scale) / 2);
    expect(v.x).toBeGreaterThan(0);
  });

  it('작은 그림은 1.5 배까지만 키운다', () => {
    expect(fitView(100, 50, 700, 380).scale).toBe(1.5);
  });

  it('크기를 모르면 원래 크기로 둔다', () => {
    expect(fitView(0, 0, 700, 380)).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it('확대·축소는 고정점을 지키고 범위를 넘지 않는다', () => {
    const v = zoomAt({ scale: 1, x: 10, y: 20 }, 2, 100, 100);
    expect(v.scale).toBe(2);
    expect(v.x).toBe(100 - (100 - 10) * 2);
    expect(zoomAt({ scale: 4.5, x: 0, y: 0 }, 2, 0, 0).scale).toBe(MAX_SCALE);
    expect(zoomAt({ scale: 0.15, x: 0, y: 0 }, 0.5, 0, 0).scale).toBe(MIN_SCALE);
  });
});

describe('tree chart', () => {
  const plan = {
    title: { text: 'Query Execution Plan' },
    series: [
      { type: 'tree', data: [{ name: 'SELECT', collapsed: true, children: [{ name: 'HASH', collapsed: true }] }] },
    ],
  };

  it('트리 차트를 알아보고 roam·scaleLimit 을 기본으로 넣는다', () => {
    expect(isTreeChart(plan)).toBe(true);
    expect(isTreeChart({ series: [{ type: 'bar' }] })).toBe(false);
    const s = (withTreeDefaults(plan).series as Record<string, unknown>[])[0];
    expect(s.roam).toBe(true);
    expect(s.scaleLimit).toEqual({ min: 0.3, max: 5 });
    const own = { series: { type: 'tree', roam: 'move' } };
    expect((withTreeDefaults(own).series as Record<string, unknown>).roam).toBe('move');
  });

  it('제목이 있는 트리는 제목과 겹치지 않게 위 여백을 둔다', () => {
    const s = (
      withTreeDefaults({ ...plan, series: [{ type: 'tree', top: '5%' }] }).series as Record<string, unknown>[]
    )[0];
    expect(s.top).toBe(64);
    expect((withTreeDefaults({ series: [{ type: 'tree', top: 10 }] }).series as Record<string, unknown>[])[0].top).toBe(
      10
    );
  });

  it('노드 위에 글자를 붙인 트리는 제목 아래 여백을 글자 높이만큼 더 둔다', () => {
    const top = (o: Record<string, unknown>) => (withTreeDefaults(o).series as Record<string, unknown>[])[0].top;
    expect(
      top({ title: { text: 'Query Execution Plan' }, series: [{ type: 'tree', label: { position: 'top' } }] })
    ).toBe(104);
    expect(top({ title: { text: 'Plan' }, series: [{ type: 'tree' }] })).toBe(64);
  });

  it('트리 노드 글자는 테마 글자색으로, 외곽선 없이 그린다', () => {
    const s = (
      withTreeDefaults({ series: [{ type: 'tree', label: { fontSize: 11 } }] }, true).series as Record<
        string,
        Record<string, unknown>
      >[]
    )[0];
    expect(s.label).toEqual({ color: '#d4d4d4', textBorderWidth: 0, fontSize: 11 });
    expect((s.leaves.label as Record<string, unknown>).color).toBe('#d4d4d4');
    const light = (
      withTreeDefaults({ series: [{ type: 'tree' }] }, false).series as Record<string, Record<string, unknown>>[]
    )[0];
    expect((light.label as Record<string, unknown>).color).toBe('#333333');
  });

  it('확대·축소는 tree 계열의 zoom 만 바꾼다', () => {
    const out = treeZoom([{ type: 'tree' }, { type: 'bar' }], true);
    expect(out[0].zoom).toBeCloseTo(1.2);
    expect(out[1].zoom).toBeUndefined();
    expect(treeZoom([{ type: 'tree', zoom: 0.31 }], false)[0].zoom).toBe(0.3);
  });

  it('모두 펼치기는 모든 노드의 collapsed 를 끈다', () => {
    const data = (expandAll(plan.series)[0].data as { collapsed: boolean; children: { collapsed: boolean }[] }[])[0];
    expect(data.collapsed).toBe(false);
    expect(data.children[0].collapsed).toBe(false);
  });

  it('차트 높이는 옵션의 height 가 있으면 그 값, 없으면 400', () => {
    expect(chartHeight({})).toBe(CHART_HEIGHT);
    expect(chartHeight({ height: 520 })).toBe(520);
    expect(chartHeight({ height: 9999 })).toBe(CHART_HEIGHT);
  });

  // 글자 하나를 10px 로 재는 가짜 측정
  const m = (t: string) => t.length * 10;

  it('긴 제목은 오른쪽 아이콘 자리를 비우고 줄을 나누며, 그래프는 제목 아래에서 시작한다', () => {
    const opt = {
      title: { text: '시도별 공급세대수(전체)·신청건(전체) (합성 데이터)' },
      toolbox: { show: true, right: 36, feature: { dataZoom: {}, restore: {}, saveAsImage: {} } },
      grid: { top: 30, bottom: 45 },
      xAxis: {},
      series: [{ type: 'bar' }],
    };
    const p = titleLayout(opt, 300, m) as Record<string, Record<string, unknown>>;
    const lines = String(p.title.text).split('\n');
    expect(lines.length).toBeGreaterThan(1);
    // 300 - 12 - (52 + 4*25 + 28) = 108px → 한 줄 10자 이하 (dataZoom 아이콘 둘)
    for (const l of lines) expect(l.length * 10).toBeLessThanOrEqual(108);
    expect(lines.join('').replace(/\s/g, '')).toBe(opt.title.text.replace(/\s/g, ''));
    expect(p.toolbox.right).toBe(52);
    expect(p.grid.top as number).toBeGreaterThan(8 + lines.length * 23 + 16);
  });

  it('짧은 제목도 그래프 위 여백을 제목 아래로 내린다', () => {
    const p = titleLayout({ title: { text: '월별' }, grid: { top: 30 }, series: [{ type: 'line' }] }, 800, m) as Record<
      string,
      Record<string, unknown>
    >;
    expect(p.title.text).toBe('월별');
    expect(p.grid.top).toBe(8 + 23 + 20);
    expect(p.toolbox).toBeUndefined();
  });

  it('트리·제목 없는 차트는 건드리지 않는다', () => {
    expect(titleLayout({ series: [{ type: 'tree' }], title: { text: 'Plan' } }, 800, m)).toBeNull();
    expect(titleLayout({ series: [{ type: 'bar' }] }, 800, m)).toBeNull();
  });

  it('공백 없는 긴 낱말은 글자 단위로 나눈다', () => {
    expect(wrapLines('ABCDEFGHIJ', 40, '', m)).toEqual(['ABCD', 'EFGH', 'IJ']);
  });
});
