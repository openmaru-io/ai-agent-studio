/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// ```echarts 블록의 JSON 옵션을 안전하게 고친다(OMAI-1115).
// CogentAI 위젯은 툴팁 formatter 에 이름을 이스케이프 없이 HTML 로 넣었고, 'function' 이 든 formatter 와 link 만 막아
// HTML 이 든 문자열 템플릿·sublink 는 통과했다. 여기서는 문자열 formatter 를 모두 버리고(ECharts 기본 표시를 쓴다),
// 링크는 http(s) 만 남기며, 툴팁은 HTML 이 아닌 richText 로 그린다.
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

export function buildOption(json: string): Record<string, unknown> {
  const parsed = JSON.parse(json) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
  const opt = sanitizeOption(parsed) as Record<string, unknown>;
  const tooltip = opt.tooltip && typeof opt.tooltip === 'object' ? (opt.tooltip as Record<string, unknown>) : {};
  return { ...opt, backgroundColor: 'transparent', tooltip: { ...tooltip, renderMode: 'richText' } };
}
