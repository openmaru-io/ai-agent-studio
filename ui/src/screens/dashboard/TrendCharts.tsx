/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 대시보드 추이 그래프 3장(디자인 DD9). echarts 는 무거워 이 파일을 열 때만 받는다(대화 차트와 같은 vendor-echarts 묶음, R8).
// 색은 DESIGN.md 상태색만 상태 뜻에 쓴다: 실패=빨강, 멈춤·수집 오류=호박, 나머지는 무채색. 범례 대신 그래프 제목.
import { Box, Typography, useTheme } from '@mui/material';
import * as echarts from 'echarts';
import { useEffect, useRef } from 'react';

import { compactAxis, formatTrendTooltip, TipRow, trendAxisPointer, trendSeries, trendTooltip } from './chartTooltip';
import { ChartSpec } from './trendData';

const RED = '#DA291C';
const AMBER = '#f59e0b';

function Chart({ spec, dark }: { spec: ChartSpec; dark: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const grey = dark ? '#8a8f98' : '#9ca3af';
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = echarts.init(el, dark ? 'dark' : undefined, { renderer: 'canvas' });
    const color = (tone: string) => (tone === 'bad' ? RED : tone === 'warn' ? AMBER : grey);
    chart.setOption({
      backgroundColor: 'transparent',
      animation: false,
      grid: { left: 40, right: spec.series.some((s) => s.axis === 1) ? 40 : 12, top: 12, bottom: 22 },
      tooltip: {
        ...trendTooltip(dark ? 'dark' : 'light'),
        axisPointer: trendAxisPointer(dark ? 'dark' : 'light'),
        formatter: (params: unknown) => formatTrendTooltip(params as TipRow[], dark ? 'dark' : 'light'),
      },
      xAxis: { type: 'category', data: spec.days.map((d) => d.slice(5)), axisLabel: { fontSize: 10 } },
      yAxis: [
        { type: 'value', minInterval: 1, axisLabel: { fontSize: 10, formatter: compactAxis }, splitLine: { lineStyle: { opacity: 0.3 } } },
        { type: 'value', minInterval: 1, axisLabel: { fontSize: 10, formatter: compactAxis }, splitLine: { show: false } },
      ],
      series: spec.series.map((s) => trendSeries(s, color(s.tone))),
    });
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.dispose();
    };
  }, [spec, dark, grey]);
  return <Box ref={ref} role="img" aria-label={spec.aria} sx={{ width: '100%', height: 120 }} />;
}

export default function TrendCharts({ specs }: { specs: ChartSpec[] }) {
  const dark = useTheme().palette.mode === 'dark';
  return (
    <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0, 1fr))' } }}>
      {specs.map((s) => (
        <Box key={s.title} component="figure" sx={{ m: 0 }}>
          <Typography variant="caption" component="figcaption" color="text.secondary">
            {s.title}
          </Typography>
          <Chart spec={s} dark={dark} />
        </Box>
      ))}
    </Box>
  );
}
