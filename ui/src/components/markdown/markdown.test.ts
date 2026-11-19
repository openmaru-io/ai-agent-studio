/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { buildOption, sanitizeOption } from './chartOption';
import { closePendingDiagram, hidePartialTable } from './preprocess';

describe('closePendingDiagram', () => {
  it('열린 mermaid·echarts 펜스만 -pending 으로 닫는다', () => {
    expect(closePendingDiagram('a\n```mermaid\ngraph TD')).toBe('a\n```mermaid-pending\ngraph TD\n```');
    expect(closePendingDiagram('```echarts\n{"a"')).toBe('```echarts-pending\n{"a"\n```');
    expect(closePendingDiagram('```py\nx = 1')).toBe('```py\nx = 1');
    expect(closePendingDiagram('```mermaid\ngraph\n```')).toBe('```mermaid\ngraph\n```');
  });
});

describe('hidePartialTable', () => {
  it('글 끝 줄이 <table 의 앞부분이면 뺀다(받는 중, 리뷰 R6)', () => {
    expect(hidePartialTable('a\n<tab')).toBe('a');
    expect(hidePartialTable('a\n  <table')).toBe('a');
    expect(hidePartialTable('a\n<')).toBe('a');
    expect(hidePartialTable('a <tab b')).toBe('a <tab b');
    expect(hidePartialTable('a\n<tabular')).toBe('a\n<tabular');
    expect(hidePartialTable('<tab\nb')).toBe('<tab\nb');
  });
});

describe('chart option', () => {
  it('drops the fixed text, axis and grid colors so the light/dark theme decides them (OMAI-1863)', () => {
    // CogentAI Chart MCP 옵션: 글자 #333333·가로선 #222222 가 박혀 다크 모드 글자가 안 보이고 라이트 모드 가로선이 검다
    const opt = buildOption(
      JSON.stringify({
        color: ['#5470c6'],
        title: { text: 'T', textStyle: { color: '#333333', fontSize: 14 } },
        legend: { textStyle: { color: '#333333' } },
        xAxis: { axisLabel: { color: '#333333' }, axisLine: { lineStyle: { color: '#cccccc' } }, nameTextStyle: { color: '#333' } },
        yAxis: [{ axisLabel: { color: '#333333' }, splitLine: { lineStyle: { color: '#222222', type: 'dashed' } } }],
        series: [{ type: 'bar', data: [1], itemStyle: { color: '#ff0000' } }],
      }),
    );
    const at = (...path: (string | number)[]) => path.reduce<unknown>((c, k) => (c as Record<string | number, unknown> | undefined)?.[k], opt);
    expect(at('title', 'textStyle')).toEqual({ fontSize: 14 });
    expect(at('legend', 'textStyle')).toEqual({});
    expect(at('xAxis', 'axisLabel')).toEqual({});
    expect(at('xAxis', 'axisLine', 'lineStyle')).toEqual({});
    expect(at('xAxis', 'nameTextStyle')).toEqual({});
    expect(at('yAxis', 0, 'splitLine', 'lineStyle')).toEqual({ type: 'dashed' });
    expect(at('color')).toEqual(['#5470c6']); // 계열 색은 그대로
    expect(at('series', 0, 'itemStyle', 'color')).toBe('#ff0000');
  });

  it('계열 글자색(label·leaves.label·emphasis.label)도 테마에 맡긴다: 다크 모드에서 Plan 트리 글자가 안 보였다(2026-11-08)', () => {
    const opt = buildOption(
      JSON.stringify({
        series: [
          {
            type: 'tree',
            label: { color: '#333333', fontSize: 11 },
            leaves: { label: { color: '#333' } },
            emphasis: { label: { color: '#000' } },
            lineStyle: { color: '#ccc' },
            itemStyle: { color: '#f5a623' },
          },
        ],
      }),
    );
    const s = (opt.series as Record<string, Record<string, unknown>>[])[0];
    expect(s.label).toEqual({ fontSize: 11 });
    expect((s.leaves as Record<string, unknown>).label).toEqual({});
    expect((s.emphasis as Record<string, unknown>).label).toEqual({});
    expect(s.itemStyle).toEqual({ color: '#f5a623' }); // 점 색은 그대로
  });

  it('문자열 formatter 와 http(s) 가 아닌 링크를 버리고 툴팁은 richText 로 그린다(HTML 주입 막기)', () => {
    const out = sanitizeOption({
      title: { text: 't', link: 'javascript:alert(1)', sublink: 'https://ok' },
      tooltip: { formatter: '<img src=x onerror=alert(1)>{b}' },
      series: [{ label: { formatter: 'function(){}' }, data: [1] }],
    }) as { title: unknown; tooltip: unknown; series: { label: unknown }[] };
    expect(out.title).toEqual({ text: 't', sublink: 'https://ok' });
    expect(out.tooltip).toEqual({});
    expect(out.series[0].label).toEqual({});
    const opt = buildOption('{"tooltip":{"trigger":"axis"},"series":[]}');
    expect(opt.tooltip).toEqual({ trigger: 'axis', renderMode: 'richText' });
    expect(() => buildOption('[1,2]')).toThrow();
    expect(() => buildOption('{bad')).toThrow();
  });
});
