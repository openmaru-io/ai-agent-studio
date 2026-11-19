/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 차트·다이어그램 블록의 고정 크기 보기(확대·축소·이동)에 쓰는 계산이다. CogentAI 위젯(ChartRenderer·MermaidRenderer)과
// 같은 동작을 낸다: 다이어그램은 380px 상자에 맞춰 그리고, 트리 차트(Query Execution Plan)는 확대·축소·화면 맞춤·모두 펼치기를 쓴다.
// Plan 트리는 320px 에 작게, ERD(mermaid erDiagram)는 원래 크기로 크게 나와 읽기 어려웠다(2026-11-08).

export const CHART_HEIGHT = 400;
export const DIAGRAM_HEIGHT = 380;
export const MIN_SCALE = 0.1; // 세로로 긴 ERD 도 처음에는 다 보이게 한다
export const MAX_SCALE = 5;
export const ZOOM_FACTOR = 1.2;
const FIT_MAX = 1.5; // 작은 다이어그램을 맞출 때 글자가 지나치게 커지지 않게 한다
const FIT_PAD = 24;

export function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

export interface View {
  scale: number;
  x: number;
  y: number;
}

// fitView 는 w×h 그림을 boxW×boxH 상자 가운데에 다 보이게 놓는 보기다.
export function fitView(w: number, h: number, boxW: number, boxH: number): View {
  if (!(w > 0 && h > 0 && boxW > 0 && boxH > 0)) return { scale: 1, x: 0, y: 0 };
  const scale = clampScale(Math.min((boxW - FIT_PAD) / w, (boxH - FIT_PAD) / h, FIT_MAX));
  return { scale, x: (boxW - w * scale) / 2, y: (boxH - h * scale) / 2 };
}

// zoomAt 은 상자 안의 점(px, py)을 그대로 두고 factor 배 확대·축소한다(휠은 마우스 위치, 버튼은 상자 가운데).
export function zoomAt(v: View, factor: number, px: number, py: number): View {
  const scale = clampScale(v.scale * factor);
  const k = scale / v.scale;
  return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
}

type Series = Record<string, unknown>;

function seriesOf(option: Record<string, unknown>): Series[] {
  const s = option.series;
  if (Array.isArray(s)) return s as Series[];
  return s && typeof s === 'object' ? [s as Series] : [];
}

export function isTreeChart(option: Record<string, unknown>): boolean {
  return seriesOf(option).some((s) => s?.type === 'tree');
}

// withTreeDefaults 는 트리 계열을 끌어 옮기고 확대할 수 있게 하고(roam), 지나친 확대·축소를 막는다(위젯 patchTreeScaleLimit).
// 제목이 있으면 트리를 제목 아래(64px)에서 시작한다. Chart MCP 의 Plan 트리는 top 이 작아 루트 노드가 제목과 겹쳤다(2026-11-08).
const TITLE_GAP = 64;
// 노드 글자를 노드 위에 붙이는 트리(Chart MCP 의 Plan 트리)는 루트 글자 두세 줄이 노드 위로 올라가 제목과 겹친다.
const LABEL_ABOVE_GAP = 40;

function titleGap(s: Series): number {
  const label = s.label && typeof s.label === 'object' ? (s.label as Series) : {};
  return label.position === 'top' ? TITLE_GAP + LABEL_ABOVE_GAP : TITLE_GAP;
}

function hasTitle(option: Record<string, unknown>): boolean {
  const t = option.title as Record<string, unknown> | Record<string, unknown>[] | undefined;
  return (Array.isArray(t) ? t : [t]).some((x) => !!x && typeof x.text === 'string' && x.text !== '');
}

// 트리 노드 글자는 테마 글자색으로, 외곽선 없이 그린다. ECharts 다크 테마 기본값은 글자에 어두운 외곽선을 둘러
// 글자가 번져 보였다(위젯도 테마별 글자색을 직접 정한다).
function treeLabel(label: unknown, dark: boolean): Series {
  const base = label && typeof label === 'object' ? (label as Series) : {};
  return { color: dark ? '#d4d4d4' : '#333333', textBorderWidth: 0, ...base };
}

export function withTreeDefaults(option: Record<string, unknown>, dark = false): Record<string, unknown> {
  if (!isTreeChart(option)) return option;
  const titled = hasTitle(option);
  const series = seriesOf(option).map((s) => {
    if (s?.type !== 'tree') return s;
    const out: Series = { roam: true, scaleLimit: { min: 0.3, max: 5 }, ...s };
    const gap = titleGap(s);
    if (titled && !(typeof s.top === 'number' && s.top >= gap)) out.top = gap;
    out.label = treeLabel(s.label, dark);
    const leaves = s.leaves && typeof s.leaves === 'object' ? (s.leaves as Series) : {};
    out.leaves = { ...leaves, label: treeLabel(leaves.label, dark) };
    return out;
  });
  return { ...option, series: Array.isArray(option.series) ? series : series[0] };
}

// treeZoom 은 트리 계열의 zoom 을 한 단계 바꾼 series 를 돌려준다(setOption 에 넘긴다).
export function treeZoom(series: Series[], zoomIn: boolean): Series[] {
  return series.map((s) => {
    if (s?.type !== 'tree') return s;
    const cur = typeof s.zoom === 'number' ? s.zoom : 1;
    const next = zoomIn ? Math.min(5, cur * ZOOM_FACTOR) : Math.max(0.3, cur / ZOOM_FACTOR);
    return { ...s, zoom: next };
  });
}

type Node = { collapsed?: boolean; children?: Node[]; [k: string]: unknown };

function expandNodes(nodes: Node[]): Node[] {
  return nodes.map((n) => ({ ...n, collapsed: false, children: n.children ? expandNodes(n.children) : n.children }));
}

// expandAll 은 트리 계열의 모든 노드를 펼친 series 를 돌려준다.
export function expandAll(series: Series[]): Series[] {
  return series.map((s) =>
    s?.type === 'tree' && Array.isArray(s.data) ? { ...s, data: expandNodes(s.data as Node[]) } : s
  );
}

// chartHeight 는 옵션에 높이(px)가 있으면 그 값(200~1200), 없으면 400 이다(위젯과 같다).
export function chartHeight(option: Record<string, unknown>): number {
  const h = option.height;
  return typeof h === 'number' && h >= 200 && h <= 1200 ? h : CHART_HEIGHT;
}

// 제목 자리(트리가 아닌 차트). Chart MCP 의 막대·선 차트는 제목을 왼쪽 위 한 줄로 두고 폭을 정하지 않으며, 그래프 위 여백(grid.top)이
// 30px 이라 긴 제목이 오른쪽 위 ECharts 도구 아이콘·AAS 전체 화면 버튼과, 아래로는 Y축 맨 위 숫자와 겹쳤다(2026-11-08).
// 차트 폭에서 오른쪽 아이콘 자리를 빼고 제목을 줄바꿈하고, 그래프는 제목 줄 수만큼 아래에서 시작한다.
const VIEWER_BAR = 52; // AAS 버튼 막대(ViewerToolbar) 자리
const TOOLBOX_ITEM = 25; // ECharts 도구 아이콘 하나(15px + 간격)
const TITLE_LEFT = 12;
const TITLE_TOP = 8;

type Measure = (text: string, font: string) => number;

function firstOf(v: unknown): Record<string, unknown> | undefined {
  const x = Array.isArray(v) ? v[0] : v;
  return x && typeof x === 'object' ? (x as Record<string, unknown>) : undefined;
}

// wrapLines 는 글자를 폭 안에서 줄로 나눈다. 공백이 있으면 공백에서, 없으면 글자 단위로 나눈다.
export function wrapLines(text: string, width: number, font: string, measure: Measure): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const ch of para.split(/(?<=\s)/).flatMap((w) => (measure(w, font) > width ? [...w] : [w]))) {
      if (line && measure(line + ch, font) > width) {
        out.push(line.trimEnd());
        line = ch.trimStart();
      } else line += ch;
    }
    out.push(line.trimEnd());
  }
  return out;
}

// titleLayout 은 차트 폭에 맞춘 제목·도구·그래프 위 여백 패치를 돌려준다. 바꿀 것이 없으면 null.
export function titleLayout(
  option: Record<string, unknown>,
  width: number,
  measure: Measure
): Record<string, unknown> | null {
  if (isTreeChart(option) || width <= 0) return null;
  const title = firstOf(option.title);
  const text = typeof title?.text === 'string' ? title.text : '';
  if (!title || !text || title.show === false) return null;
  const toolbox = firstOf(option.toolbox);
  // dataZoom 기능은 아이콘이 둘(구간 확대·되돌리기)이다
  const names = toolbox && toolbox.show !== false ? Object.keys(firstOf(toolbox.feature) ?? {}) : [];
  const features = names.reduce((n, k) => n + (k === 'dataZoom' ? 2 : 1), 0);
  // 잰 폭과 그린 폭의 차이(굵기 bold·bolder)를 여유 폭으로 흡수한다
  const reserve = VIEWER_BAR + features * TOOLBOX_ITEM + (features ? 28 : 12);
  const style = firstOf(title.textStyle) ?? {};
  const size = typeof style.fontSize === 'number' ? style.fontSize : 18;
  const font = `bold ${size}px sans-serif`;
  const textWidth = Math.max(80, width - TITLE_LEFT - reserve);
  const lines = wrapLines(text, textWidth, font, measure);
  const lineHeight = Math.round(size * 1.3);
  const subtext = typeof title.subtext === 'string' && title.subtext ? 1 : 0;
  const bottom = TITLE_TOP + lines.length * lineHeight + subtext * 18;
  const patch: Record<string, unknown> = {
    title: { ...title, text: lines.join('\n'), left: TITLE_LEFT, top: TITLE_TOP, textStyle: { ...style, lineHeight } },
  };
  if (features) patch.toolbox = { ...toolbox, right: VIEWER_BAR, top: TITLE_TOP };
  const grid = firstOf(option.grid);
  if (grid) {
    const top = typeof grid.top === 'number' ? grid.top : 0;
    patch.grid = { ...grid, top: Math.max(top, bottom + 20) };
  }
  return patch;
}

let canvas: HTMLCanvasElement | null = null;

// measureText 는 캔버스로 글자 폭을 잰다(ECharts 와 같은 방식).
export function measureText(text: string, font: string): number {
  canvas ??= document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return text.length * 10;
  ctx.font = font;
  return ctx.measureText(text).width;
}
