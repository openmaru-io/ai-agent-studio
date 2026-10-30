/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// ```echarts 코드 블록(ECharts 옵션 JSON)을 차트로 그린다. 무거워서 따로 받는 묶음(vendor-echarts)이다.
import { Box, Typography, useTheme } from '@mui/material';
import * as echarts from 'echarts';
import { useEffect, useMemo, useRef } from 'react';

import { t } from '@/i18n';

import { buildOption } from './chartOption';

export default function ChartBlock({ code }: { code: string }) {
  const dark = useTheme().palette.mode === 'dark';
  const ref = useRef<HTMLDivElement>(null);
  const parsed = useMemo(() => {
    try {
      return { option: buildOption(code), error: '' };
    } catch (e) {
      return { option: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [code]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !parsed.option) return;
    const chart = echarts.init(el, dark ? 'dark' : undefined, { renderer: 'canvas' });
    try {
      chart.setOption(parsed.option, true);
    } catch {
      // 옵션 모양이 틀리면 빈 차트로 둔다(오류 문구는 JSON 해석 실패 때만)
    }
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.dispose();
    };
  }, [parsed, dark]);

  if (parsed.error)
    return (
      <Box component="pre" sx={{ p: 1.5, bgcolor: 'action.hover', borderRadius: 1, overflow: 'auto' }}>
        <Typography variant="caption" color="error" component="div" sx={{ mb: 1 }}>
          {t('common.chartFailed', { error: parsed.error })}
        </Typography>
        <code>{code}</code>
      </Box>
    );
  return <Box ref={ref} role="img" aria-label={t('common.chart')} sx={{ width: '100%', height: 320 }} />;
}
