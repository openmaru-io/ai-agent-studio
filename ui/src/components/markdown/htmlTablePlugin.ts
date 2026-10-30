/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 마크다운 블록 자리의 HTML <table> 덩어리를 표로 그리는 remark 플러그인(스펙 2026-10-27-005).
// 문서 변환 도구(kordoc·hwpforge·OCR)는 병합 칸이 있는 표를 HTML 로 쓴다. 렌더러는 HTML 을 열지 않으므로(Markdown.tsx)
// 이 덩어리만 DOMParser 로 읽어 허용 목록 요소·속성으로 hast 를 새로 만든다. 원래 DOM·innerHTML 은 화면에 넣지 않는다.

interface MdNode {
  type: string;
  value?: string;
  lang?: string | null;
  position?: { start: { offset?: number } };
  children?: MdNode[];
  data?: { hName?: string; hChildren?: HastNode[] };
}

type HastNode = { type: 'text'; value: string } | { type: 'element'; tagName: string; properties: Record<string, number>; children: HastNode[] };

const TABLE_START = /^\s*<table[\s>]/i;
// 인라인 html(문단 안 태그)은 건드리지 않는다 — 블록을 담는 부모만 본다(리뷰 F4)
const BLOCK_PARENTS = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition']);
const ALLOWED = new Set(['table', 'caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'br']);
// 안의 글까지 버린다(표 밖에서도)
const DROP = new Set(['script', 'style', 'template', 'iframe', 'object', 'embed', 'img', 'svg', 'math', 'noscript', 'head', 'title']);
// 바로 안의 공백 글을 버린다(React 의 DOM 중첩 경고, 리뷰 F6)
const STRUCTURE = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'colgroup']);
const MAX_DEPTH = 8; // 칸 안 표 겹침 상한(리뷰 R7)
const MAX_SPAN = 100;
const GAP = 'data-aas-gap';

const countOf = (s: string, re: RegExp) => (s.match(re) ?? []).length;
const openDepth = (s: string) => countOf(s, /<table[\s>]/gi) - countOf(s, /<\/table\s*>/gi);

// 4칸 들여쓴 HTML 은 빈 줄 뒤에서 들여쓰기 코드 블록이 된다(리뷰 R3). 울타리(``` ~~~) 코드는 잇지 않는다
function isIndentedHtml(node: MdNode, source: string): boolean {
  if (node.type !== 'code' || node.lang || !node.value?.startsWith('<')) return false;
  const at = node.position?.start.offset;
  return at != null && !/^\s*(```|~~~)/.test(source.slice(at, at + 16));
}

/** 표 단계(어느 칸 안도 아닌 자리)의 글을 전체 폭 표시 행으로 감싼다. 파서가 칸 밖 글을 표 바깥으로 옮기지 않게(리뷰 R4) */
export function wrapGapText(html: string): string {
  const stack: ('table' | 'cell')[] = [];
  const tag = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)(?:"[^"]*"|'[^']*'|[^'">])*>/g;
  let out = '';
  let at = 0;
  const text = (s: string) => (stack[stack.length - 1] === 'table' && s.trim() ? `<tr ${GAP}><td>${s.trim()}</td></tr>` : s);
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    out += text(html.slice(at, m.index)) + m[0];
    at = m.index + m[0].length;
    const close = m[1] === '/';
    const name = (m[2] ?? '').toLowerCase();
    if (name === 'table') {
      if (!close) stack.push('table');
      else while (stack.length && stack.pop() !== 'table');
    } else if (name === 'td' || name === 'th' || name === 'caption') {
      if (stack[stack.length - 1] === 'cell') stack.pop(); // 닫지 않은 앞 칸
      if (!close) stack.push('cell');
    } else if (name === 'tr' && stack[stack.length - 1] === 'cell') {
      stack.pop(); // <tr> 은 열린 칸을 닫는다
    }
  }
  return out + text(html.slice(at));
}

function span(el: Element, name: string): number | undefined {
  const raw = el.getAttribute(name)?.trim() ?? '';
  if (!/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return n >= 1 ? Math.min(n, MAX_SPAN) : undefined;
}

// 표의 열 수: 각 행 칸의 colspan 합에 위 행 rowspan 이 차지한 칸을 더한 값 중 가장 큰 것(표시 행 제외)
function columnCount(table: HTMLTableElement): number {
  const taken: Set<number>[] = [];
  let width = 1;
  Array.from(table.rows)
    .filter((r) => !r.hasAttribute(GAP))
    .forEach((row, y) => {
      const here = (taken[y] ??= new Set());
      let x = 0;
      for (const cell of Array.from(row.cells)) {
        while (here.has(x)) x++;
        const cs = span(cell, 'colspan') ?? 1;
        const rs = Math.min(span(cell, 'rowspan') ?? 1, MAX_SPAN);
        for (let dy = 0; dy < rs; dy++) for (let dx = 0; dx < cs; dx++) (taken[y + dy] ??= new Set()).add(x + dx);
        x += cs;
      }
      if (here.size) width = Math.max(width, Math.max(...here) + 1);
    });
  return Math.min(width, MAX_SPAN);
}

const textOf = (node: Node) => (node.nodeType === Node.ELEMENT_NODE && DROP.has((node as Element).localName) ? '' : (node.textContent ?? ''));

function convert(node: Node, depth: number, gapWidth: number, parent: string): HastNode[] {
  if (node.nodeType === Node.TEXT_NODE) {
    const value = node.textContent ?? '';
    return STRUCTURE.has(parent) && !value.trim() ? [] : [{ type: 'text', value }];
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return [];
  const el = node as Element;
  const name = el.localName;
  if (DROP.has(name)) return [];
  if (name === 'table') {
    if (depth >= MAX_DEPTH) return [{ type: 'text', value: el.textContent ?? '' }];
    return [tableOf(el as HTMLTableElement, depth + 1)];
  }
  const kids = (next: number) => Array.from(el.childNodes).flatMap((c) => convert(c, depth, next, name));
  if (!ALLOWED.has(name)) return kids(gapWidth);
  const properties: Record<string, number> = {};
  if (name === 'td' || name === 'th') {
    const gap = el.parentElement?.hasAttribute(GAP);
    const cs = gap ? gapWidth : span(el, 'colspan');
    const rs = gap ? undefined : span(el, 'rowspan');
    if (cs && cs > 1) properties.colSpan = cs;
    if (rs && rs > 1) properties.rowSpan = rs;
  } else if (name === 'col') {
    const s = span(el, 'span');
    if (s) properties.span = s;
  }
  return [{ type: 'element', tagName: name, properties, children: kids(gapWidth) }];
}

function tableOf(table: HTMLTableElement, depth: number): HastNode {
  const width = columnCount(table);
  return { type: 'element', tagName: 'table', properties: {}, children: Array.from(table.childNodes).flatMap((c) => convert(c, depth, width, 'table')) };
}

/** 모은 HTML 을 읽어 마크다운 노드 목록으로: 표는 허용 목록 표, 그 밖은 태그를 뺀 글 문단(리뷰 R2) */
function toNodes(html: string): MdNode[] {
  const body = new DOMParser().parseFromString(wrapGapText(html), 'text/html').body;
  const out: MdNode[] = [];
  let pending = '';
  const flush = () => {
    const value = pending.trim();
    if (value) out.push({ type: 'paragraph', children: [{ type: 'text', value }] });
    pending = '';
  };
  for (const child of Array.from(body.childNodes)) {
    if (child.nodeType === Node.ELEMENT_NODE && (child as Element).localName === 'table') {
      flush();
      const t = tableOf(child as HTMLTableElement, 1) as Extract<HastNode, { type: 'element' }>;
      out.push({ type: 'htmlTable', data: { hName: 'table', hChildren: t.children } });
    } else pending += textOf(child);
  }
  flush();
  return out;
}

export function remarkHtmlTables() {
  return (tree: MdNode, file: { value?: unknown }) => {
    const source = typeof file.value === 'string' ? file.value : '';
    const walk = (node: MdNode) => {
      const kids = node.children;
      if (!kids) return;
      if (BLOCK_PARENTS.has(node.type)) {
        for (let i = 0; i < kids.length; i++) {
          const first = kids[i];
          if (first.type !== 'html' || !TABLE_START.test(first.value ?? '')) continue;
          // 열린 표가 남아 있는 동안 바로 뒤의 html·들여쓴 HTML 조각만 잇는다 — 다른 노드에서 멈춰 문서를 삼키지 않는다(리뷰 R1)
          const parts = [first.value ?? ''];
          let open = openDepth(parts[0]);
          let j = i + 1;
          while (open > 0 && j < kids.length && (kids[j].type === 'html' || isIndentedHtml(kids[j], source))) {
            parts.push(kids[j].value ?? '');
            open += openDepth(kids[j].value ?? '');
            j++;
          }
          // 원문 위치가 아니라 노드 값을 잇는다 — 인용의 > 와 목록 들여쓰기가 섞이지 않게(리뷰 F1)
          const nodes = toNodes(parts.join('\n'));
          kids.splice(i, j - i, ...nodes);
          i += nodes.length - 1;
        }
      }
      kids.forEach(walk);
    };
    walk(tree);
  };
}
