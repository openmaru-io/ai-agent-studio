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
