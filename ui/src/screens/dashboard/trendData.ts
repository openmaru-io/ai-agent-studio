/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 추이 그래프 3장의 값(디자인 DD9). 그래프와 「표로 보기」가 같은 값을 쓴다. echarts 를 부르지 않는다.
import { t } from '@/i18n';
import { TrendDay, UsageDay } from '@/lib/dashboard';
import { big } from '@/lib/format';

export interface Series {
  name: string;
  kind: 'bar' | 'line';
  tone: 'bad' | 'warn' | 'plain';
  /** 1 이면 오른쪽 축(단위가 다른 값) */
  axis?: 0 | 1;
  values: (number | null)[];
}

export interface ChartSpec {
  title: string;
  days: string[];
  series: Series[];
  /** 화면 낭독기용 요약(마지막 날 값) */
  aria: string;
}

/** 작업(7일 실행 막대 + 실패·멈춤 선), 문제(열린 문제 + 수집 오류), 사용량(토큰 막대). 날짜 축은 셋이 같다. */
export function chartSpecs(trend: TrendDay[], usage: UsageDay[]): ChartSpec[] {
  const days = [...new Set([...trend.map((r) => r.day), ...usage.map((r) => r.day)])].sort();
  const byDay = new Map(trend.map((r) => [r.day, r]));
  const useDay = new Map(usage.map((r) => [r.day, r]));
  const col = (key: keyof TrendDay) => days.map((d) => (byDay.has(d) ? Number(byDay.get(d)![key] ?? 0) : null));
  const tokens = days.map((d) => (useDay.has(d) ? useDay.get(d)!.input_tokens + useDay.get(d)!.output_tokens : null));
  const make = (title: string, series: Series[]): ChartSpec => {
    const last = series.map((s) => `${s.name} ${s.values.length ? big(s.values[s.values.length - 1] ?? 0) : '—'}`).join(', ');
    return { title, days, series, aria: t('dashboard.chartAria', { title, days: days.length, summary: last }) };
  };
  return [
    make(t('dashboard.trendJobs'), [
      { name: t('dashboard.trendRuns'), kind: 'bar', tone: 'plain', axis: 1, values: col('runs_7d') },
      { name: t('dashboard.trendFailed'), kind: 'line', tone: 'bad', values: col('failed_jobs') },
      { name: t('dashboard.trendStalled'), kind: 'line', tone: 'warn', values: col('stalled') },
    ]),
    make(t('dashboard.trendIssues'), [
      { name: t('dashboard.trendIssues'), kind: 'line', tone: 'plain', values: col('open_incidents') },
      { name: t('dashboard.trendCollectErrors'), kind: 'line', tone: 'warn', values: col('collect_errors') },
    ]),
    make(t('dashboard.trendUsage'), [{ name: t('dashboard.trendTokens'), kind: 'bar', tone: 'plain', values: tokens }]),
  ];
}
