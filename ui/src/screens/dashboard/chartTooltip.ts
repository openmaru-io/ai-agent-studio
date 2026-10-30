/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 대시보드 추이 그래프의 툴팁. echarts 기본 툴팁(14px 글자, 둥근 회색 상자) 대신 다이얼로그·알림과 같은 표면(dialogTokens)에
// 11px 글자로 그린다: 날짜 한 줄, 그 아래 시리즈마다 「색 점 · 이름 ········ 값」. 값은 숫자 폭이 같은 글꼴(tabular-nums)로 오른쪽 맞춤한다.
import { dialogTokens, toastTokens } from '@/lib/shellTokens';

import type { Series } from './trendData';

type Mode = 'dark' | 'light';

export interface TipRow {
  axisValueLabel?: string;
  seriesName?: string;
  value?: number | null | string;
  color?: string;
}

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

const fmt = (v: TipRow['value']) => (typeof v === 'number' ? v.toLocaleString('ko-KR') : v == null || v === '' ? '—' : esc(v));

/** 툴팁 한 장의 HTML. 날짜(첫 줄) + 시리즈 줄들 */
export function formatTrendTooltip(rows: TipRow[], mode: Mode): string {
  const tk = dialogTokens[mode];
  const label = rows[0]?.axisValueLabel ?? '';
  const head = `<div style="font-size:10px;line-height:14px;color:${tk.body};margin-bottom:4px;letter-spacing:.02em">${esc(label)}</div>`;
  const body = rows
    .map(
      (r) =>
        `<div data-row style="display:flex;align-items:center;gap:8px;line-height:18px"><span style="width:6px;height:6px;border-radius:50%;flex:none;background:${esc(r.color)}"></span>` +
        `<span style="color:${tk.body}">${esc(r.seriesName)}</span>` +
        `<span style="margin-left:auto;padding-left:16px;font-weight:600;color:${tk.title};font-variant-numeric:tabular-nums">${fmt(r.value)}</span></div>`
    )
    .join('');
  return head + body;
}

/** echarts tooltip 옵션. 표면·테두리·글자색은 다이얼로그 토큰, 그림자는 알림과 같은 값 */
export function trendTooltip(mode: Mode) {
  const tk = dialogTokens[mode];
  return {
    trigger: 'axis' as const,
    confine: true,
    backgroundColor: tk.surface,
    borderColor: tk.edge,
    borderWidth: 1,
    borderRadius: 8,
    padding: [8, 10] as [number, number],
    textStyle: { fontSize: 11, color: tk.body, fontFamily: '"Noto Sans KR", sans-serif' },
    extraCssText: `box-shadow:${toastTokens[mode].shadow};`,
    transitionDuration: 0.12,
  };
}

/** 세로 가이드 선: 가는 점선 */
export function trendAxisPointer(mode: Mode) {
  return { type: 'line' as const, lineStyle: { color: mode === 'dark' ? 'rgba(255,255,255,0.28)' : 'rgba(17,24,39,0.28)', type: 'dashed' as const, width: 1 } };
}

/**
 * Y축 눈금 글자. 1,000 이상은 K·M·B 로 줄이고(3,500,000 → 3.5M) 소수 .0 은 뗀다. 툴팁은 줄이지 않고 전체 숫자를 보인다(formatTrendTooltip).
 * 눈금이 줄어야 사용량처럼 값이 큰 그래프에서 축 글자가 그래프를 밀어내지 않는다.
 */
export function compactAxis(v: number | null | undefined): string {
  if (v == null) return '';
  const a = Math.abs(v);
  const cut = (n: number, unit: string) => `${Number(n.toFixed(1))}${unit}`;
  if (a >= 1e9) return cut(v / 1e9, 'B');
  if (a >= 1e6) return cut(v / 1e6, 'M');
  if (a >= 1e3) return cut(v / 1e3, 'K');
  return String(v);
}

/**
 * 시리즈 한 줄의 echarts 옵션. 막대는 위쪽 모서리를 3px 둥글게(아래는 축에 붙임), 선은 부드러운 곡선(smooth 0.25)으로 잇는다.
 * smoothMonotone 'x' 는 값 사이에서 선이 위아래로 튀어 0 아래로 내려가거나 실제보다 높아 보이는 것을 막는다. 선 끝·꺾임은 둥글게 한다.
 */
export function trendSeries(s: Series, color: string) {
  const base = { name: s.name, yAxisIndex: s.axis ?? 0, data: s.values, connectNulls: false };
  if (s.kind === 'bar') {
    return { ...base, type: 'bar' as const, itemStyle: { color, opacity: 0.55, borderRadius: [3, 3, 0, 0] } };
  }
  return {
    ...base,
    type: 'line' as const,
    showSymbol: false,
    smooth: 0.25,
    smoothMonotone: 'x' as const,
    itemStyle: { color, opacity: 1 },
    lineStyle: { color, width: 2, cap: 'round' as const, join: 'round' as const },
  };
}

