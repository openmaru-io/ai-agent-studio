/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// ```echarts 블록의 JSON 옵션을 안전하게 고친다(OMAI-1115).
// CogentAI 위젯은 툴팁 formatter 에 이름을 이스케이프 없이 HTML 로 넣었고, 'function' 이 든 formatter 와 link 만 막아
// HTML 이 든 문자열 템플릿·sublink 는 통과했다. 여기서는 문자열 formatter 를 모두 버리고(ECharts 기본 표시를 쓴다),
// 링크는 http(s) 만 남기며, 툴팁은 HTML 이 아닌 richText 로 그린다.
import { attachTreeTips } from './chartTooltip';

type Json = unknown;

const LINK_KEYS = new Set(['link', 'sublink']);

export function sanitizeOption(value: Json): Json {
  if (Array.isArray(value)) return value.map(sanitizeOption);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, Json> = {};
  for (const [key, v] of Object.entries(value as Record<string, Json>)) {
    if (key === 'formatter' && typeof v !== 'object') continue;
    if (LINK_KEYS.has(key) && !(typeof v === 'string' && /^https?:\/\//i.test(v))) continue;
    out[key] = sanitizeOption(v);
  }
  return out;
}

// 글자·축·가로선 색은 화면의 라이트·다크 테마가 정한다(OMAI-1863). CogentAI Chart MCP 는 글자 #333333·가로선 #222222 를
// 박아 보내서 다크 모드에서 글자가 안 보이고 라이트 모드 가로선이 검었다. 계열 색(color·itemStyle)은 그대로 둔다.
const THEMED: Record<string, string[][]> = {
  title: [['textStyle'], ['subtextStyle']],
  legend: [['textStyle']],
  xAxis: [['axisLabel'], ['axisLine', 'lineStyle'], ['splitLine', 'lineStyle'], ['nameTextStyle']],
  yAxis: [['axisLabel'], ['axisLine', 'lineStyle'], ['splitLine', 'lineStyle'], ['nameTextStyle']],
};

function dropColor(obj: unknown, path: string[]): void {
  let cur = obj as Record<string, unknown> | undefined;
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return;
    cur = cur[key] as Record<string, unknown> | undefined;
  }
  if (cur && typeof cur === 'object') delete cur.color;
}

// 계열의 글자색도 테마가 정한다. Chart MCP 의 Query Execution Plan 트리는 노드 글자 #333 을 박아 보내 다크 모드에서
// 보이지 않았다(2026-11-08). 점·선·막대 색(itemStyle·lineStyle)은 계열 색이라 그대로 둔다.
const SERIES_TEXT: string[][] = [['label'], ['leaves', 'label'], ['emphasis', 'label'], ['endLabel']];

export function themeColors(opt: Record<string, unknown>): Record<string, unknown> {
  for (const [key, paths] of Object.entries(THEMED)) {
    const v = opt[key];
    for (const item of Array.isArray(v) ? v : [v]) for (const path of paths) dropColor(item, path);
  }
  const series = opt.series;
  for (const item of Array.isArray(series) ? series : [series]) for (const path of SERIES_TEXT) dropColor(item, path);
  return opt;
}

export function buildOption(json: string): Record<string, unknown> {
  const parsed = JSON.parse(json) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
  attachTreeTips(parsed as Record<string, unknown>); // 노드 HTML 툴팁의 글자만 남긴다(formatter 는 아래에서 버린다)
  const opt = themeColors(sanitizeOption(parsed) as Record<string, unknown>);
  const tooltip = opt.tooltip && typeof opt.tooltip === 'object' ? (opt.tooltip as Record<string, unknown>) : {};
  return { ...opt, backgroundColor: 'transparent', tooltip: { ...tooltip, renderMode: 'richText' } };
}
