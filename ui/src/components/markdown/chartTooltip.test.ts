/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';

import { buildOption } from './chartOption';
import { htmlToLines, treeTipElement, treeTipModel } from './chartTooltip';

const HTML =
  "<b>HASH JOIN</b><br/><b>Cost:</b> 7.00<br/><b>Est. Rows:</b> 7<br/><hr style='margin:3px 0'/>" +
  '<b>Cost Detail:</b><br/>&nbsp;&nbsp;CPU: 1<br/><b>Access Pred:</b> <code>&quot;A&quot;.&quot;NO&quot;=&quot;B&quot;.&quot;NO&quot;</code><br/>' +
  '<b>Severity:</b> <span style="color:#eab839">Moderate</span>';
const PALETTE = { paper: '#fff', border: '#ddd', text: '#111', muted: '#666', font: 'sans-serif', dark: false };

describe('차트 툴팁', () => {
  it('HTML 툴팁에서 글자만 줄로 뽑는다', () => {
    expect(htmlToLines(HTML)).toEqual([
      'HASH JOIN',
      'Cost: 7.00',
      'Est. Rows: 7',
      'Cost Detail:',
      '  CPU: 1',
      'Access Pred: "A"."NO"="B"."NO"',
      'Severity: Moderate',
    ]);
  });

  it('트리 노드 formatter 는 버리고 글자 줄만 남긴다', () => {
    const opt = buildOption(
      JSON.stringify({
        series: [
          {
            type: 'tree',
            data: [
              {
                name: 'a',
                tooltip: { formatter: '<img src=x onerror=alert(1)><b>A</b>' },
                children: [{ name: 'b', tooltip: { formatter: HTML } }],
              },
            ],
          },
        ],
      })
    ) as { series: { data: Record<string, unknown>[] }[] };
    const root = opt.series[0].data[0];
    expect(root.tooltip).toEqual({});
    expect(root.tipLines).toEqual(['A']);
    expect(((root.children as Record<string, unknown>[])[0].tipLines as string[])[0]).toBe('HASH JOIN');
  });

  it('노드 하나의 정보를 항목·값 줄로 나누고 심각도를 읽는다', () => {
    const m = treeTipModel({ tipLines: htmlToLines(HTML) });
    expect(m.title).toBe('HASH JOIN');
    expect(m.severity).toBe('moderate');
    expect(m.rows).toContainEqual({ kind: 'group', text: 'Cost Detail' });
    expect(m.rows).toContainEqual({
      kind: 'pair',
      key: 'CPU',
      value: '1',
      indent: true,
      code: false,
      severity: undefined,
    });
    expect(m.rows.find((r) => r.kind === 'pair' && r.key === 'Access Pred')).toMatchObject({ code: true });
  });

  it('툴팁이 없으면 노드 이름 줄을 쓰고 경로를 잇지 않는다', () => {
    expect(treeTipModel({ name: 'HASH JOIN\ncost=7.0 rows=7' })).toEqual({
      title: 'HASH JOIN',
      severity: undefined,
      rows: [{ kind: 'note', text: 'cost=7.0 rows=7' }],
    });
  });

  it('글자는 textContent 로만 넣어 태그가 요소가 되지 않는다', () => {
    const e = treeTipElement(treeTipModel({ tipLines: ['<img src=x onerror=alert(1)>', 'Filter: <b>x</b>'] }), PALETTE);
    expect(e.querySelector('img')).toBeNull();
    expect(e.querySelector('b')).toBeNull();
    expect(e.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
