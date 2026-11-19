/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 차트 툴팁을 화면 테마에 맞춰 그린다(OMAI-1863, 2026-11-08).
// Chart MCP 의 Query Execution Plan 트리는 노드마다 HTML 툴팁(Cost·Rows·Table·조건·Severity)을 보내지만, 여기서는
// HTML 을 그리지 않으므로(chartOption.ts) formatter 가 버려지고 ECharts 기본 표시가 조상 노드 경로를 마침표로 이어
// 붙여 보였다("SELECT STATEMENT cost=8.0 rows=2.HASH GROUP BY …"). 버리기 전에 HTML 에서 글자만 뽑아 두고(tipLines),
// 툴팁은 DOM 요소를 직접 만들어 textContent 로만 글자를 넣는다. 받은 HTML·CSS(extraCssText)는 어디에도 쓰지 않는다.
// richText 툴팁은 직접 준 rich 글자 모양을 무시해서(ECharts 가 자체 표기만 씀) 열 정렬·색을 낼 수 없었다.

type Node = { tooltip?: unknown; children?: Node[]; [k: string]: unknown };
export type TipPalette = { paper: string; border: string; text: string; muted: string; font: string; dark: boolean };

const ENTITIES: Record<string, string> = { nbsp: ' ', lt: '<', gt: '>', amp: '&', quot: '"', '#39': "'", apos: "'" };

// htmlToLines 는 HTML 조각을 글자 줄로 바꾼다. <br>·<hr> 은 줄바꿈, 나머지 태그는 지운다.
export function htmlToLines(html: string): string[] {
  const text = html
    .replace(/<\s*\/?\s*(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#?\w+);/g, (m, e: string) => ENTITIES[e.toLowerCase()] ?? m);
  return text
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '');
}

function walk(nodes: unknown, fn: (n: Node) => void): void {
  if (!Array.isArray(nodes)) return;
  for (const n of nodes as Node[]) {
    if (!n || typeof n !== 'object') continue;
    fn(n);
    walk(n.children, fn);
  }
}

// attachTreeTips 는 트리 노드의 문자열 툴팁 formatter 를 글자 줄(tipLines)로 옮긴다. sanitizeOption 보다 먼저 부른다.
export function attachTreeTips(option: Record<string, unknown>): void {
  const series = Array.isArray(option.series) ? option.series : [option.series];
  for (const s of series as Record<string, unknown>[]) {
    if (s?.type !== 'tree') continue;
    walk(s.data, (n) => {
      const f =
        n.tooltip && typeof n.tooltip === 'object' ? (n.tooltip as Record<string, unknown>).formatter : undefined;
      if (typeof f === 'string') n.tipLines = htmlToLines(f);
    });
  }
}

// 심각도 색은 Chart MCP 가 노드 점에 쓰는 색과 같다(query_plan_chart.go).
export const SEVERITY: Record<string, string> = {
  low: '#7eb26d',
  moderate: '#eab839',
  high: '#e24d42',
  critical: '#c4162a',
};
const CODE_KEY = /pred|cond|filter|condition|sort key/i;

export type TipRow =
  | { kind: 'pair'; key: string; value: string; indent: boolean; code: boolean; severity?: string }
  | { kind: 'group'; text: string }
  | { kind: 'note'; text: string };
export type TipModel = { title: string; severity?: string; rows: TipRow[] };

// treeTipModel 은 노드 하나의 툴팁 내용을 정한다. 첫 줄은 연산 이름, 나머지는 「항목: 값」 줄이다.
export function treeTipModel(data: { name?: unknown; tipLines?: unknown }): TipModel {
  const lines = Array.isArray(data.tipLines)
    ? (data.tipLines as unknown[]).map(String)
    : String(data.name ?? '').split('\n');
  const rows: TipRow[] = [];
  let severity: string | undefined;
  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    const kv = /^([^:]{1,24}):\s*(.*)$/.exec(line);
    if (!kv) {
      rows.push({ kind: 'note', text: line });
      continue;
    }
    const [, key, value] = kv;
    if (value === '') {
      rows.push({ kind: 'group', text: key });
      continue;
    }
    const lvl = key.toLowerCase() === 'severity' && SEVERITY[value.toLowerCase()] ? value.toLowerCase() : undefined;
    if (lvl) severity = lvl;
    rows.push({ kind: 'pair', key, value, indent: /^\s/.test(raw), code: CODE_KEY.test(key), severity: lvl });
  }
  return { title: (lines[0] ?? '').trim(), severity, rows };
}

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

function el(tag: string, css: Partial<CSSStyleDeclaration>, text?: string): HTMLElement {
  const e = document.createElement(tag);
  Object.assign(e.style, css);
  if (text !== undefined) e.textContent = text;
  return e;
}

// treeTipElement 는 툴팁 DOM 을 만든다. 글자는 모두 textContent 로 넣는다.
export function treeTipElement(model: TipModel, p: TipPalette): HTMLElement {
  const root = el('div', { minWidth: '180px', maxWidth: '340px', whiteSpace: 'normal' });
  const head = el('div', { display: 'flex', alignItems: 'center', gap: '8px' });
  if (model.severity)
    head.appendChild(
      el('span', {
        width: '8px',
        height: '8px',
        borderRadius: '2px',
        flex: '0 0 auto',
        background: SEVERITY[model.severity],
      })
    );
  head.appendChild(el('span', { fontSize: '13px', fontWeight: '600', letterSpacing: '0.01em' }, model.title));
  root.appendChild(head);
  if (model.rows.length === 0) return root;

  const grid = el('div', {
    display: 'grid',
    gridTemplateColumns: 'auto 1fr',
    columnGap: '14px',
    rowGap: '3px',
    marginTop: '8px',
    paddingTop: '8px',
    borderTop: `1px solid ${p.border}`,
  });
  for (const r of model.rows) {
    if (r.kind !== 'pair') {
      grid.appendChild(
        el(
          'div',
          {
            gridColumn: '1 / -1',
            fontSize: '11px',
            color: p.muted,
            fontWeight: r.kind === 'group' ? '600' : '400',
            marginTop: r.kind === 'group' ? '4px' : '0',
          },
          r.text
        )
      );
      continue;
    }
    grid.appendChild(
      el('div', { fontSize: '11px', color: p.muted, paddingLeft: r.indent ? '10px' : '0', lineHeight: '18px' }, r.key)
    );
    grid.appendChild(
      el(
        'div',
        {
          fontSize: r.code ? '11px' : '12px',
          lineHeight: '18px',
          fontFamily: r.code ? MONO : 'inherit',
          fontVariantNumeric: 'tabular-nums',
          overflowWrap: 'anywhere', // 공백에서 먼저 나누고, 긴 이름만 중간에서 나눈다
          color: r.severity ? SEVERITY[r.severity] : p.text,
          fontWeight: r.severity ? '600' : '400',
        },
        r.value
      )
    );
  }
  root.appendChild(grid);
  return root;
}

// tooltipStyle 은 화면 테마에 맞춘 툴팁 상자다. 모든 차트에 쓴다(트리 아닌 차트는 richText 그대로 이 상자만 바뀐다).
export function tooltipStyle(p: TipPalette): Record<string, unknown> {
  const shadow = p.dark ? 'rgba(0, 0, 0, 0.45)' : 'rgba(15, 23, 42, 0.12)';
  return {
    backgroundColor: p.paper,
    borderColor: p.border,
    borderWidth: 1,
    borderRadius: 8,
    padding: [10, 12],
    shadowBlur: 18,
    shadowOffsetY: 6,
    shadowColor: shadow,
    textStyle: { color: p.text, fontSize: 12, fontFamily: p.font },
    extraCssText: `box-shadow: 0 6px 18px ${shadow}; border-radius: 8px;`,
  };
}
