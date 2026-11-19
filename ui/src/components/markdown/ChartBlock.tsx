/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// ```echarts 코드 블록(ECharts 옵션 JSON)을 차트로 그린다. 무거워서 따로 받는 묶음(vendor-echarts)이다.
// 높이는 400px(옵션에 height 가 있으면 그 값)로 고정하고, 오른쪽 위에 CogentAI 위젯과 같은 버튼을 둔다:
// 전체 화면, 그리고 트리 차트(Query Execution Plan)이면 화면 맞춤·모두 펼치기·확대·축소(2026-11-08).
import CloseIcon from '@mui/icons-material/Close';
import FitScreenIcon from '@mui/icons-material/FitScreen';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import UnfoldMoreIcon from '@mui/icons-material/UnfoldMore';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import { Box, Dialog, type Theme, Typography, useTheme } from '@mui/material';
import * as echarts from 'echarts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { t } from '@/i18n';

import { buildOption } from './chartOption';
import { tooltipStyle, treeTipElement, treeTipModel } from './chartTooltip';
import ViewerToolbar, { type ViewerAction, viewerFrameSx } from './ViewerToolbar';
import { chartHeight, expandAll, isTreeChart, measureText, titleLayout, treeZoom, withTreeDefaults } from './viewport';

type Option = Record<string, unknown>;
type Series = Record<string, unknown>;

// useChart 는 el 에 차트를 하나 그리고 그 인스턴스를 돌려준다(인라인·전체 화면이 각각 쓴다).
function useChart(el: HTMLDivElement | null, option: Option | null, dark: boolean) {
  const [chart, setChart] = useState<echarts.ECharts | null>(null);
  useEffect(() => {
    if (!el || !option) return;
    const c = echarts.init(el, dark ? 'dark' : undefined, { renderer: 'canvas' });
    // 제목은 차트 폭에 맞춰 줄을 나누고 오른쪽 아이콘 자리를 비운다. 폭이 바뀌면 다시 맞춘다.
    let lastWidth = -1;
    const layout = () => {
      const w = el.clientWidth;
      if (w === lastWidth) return;
      lastWidth = w;
      const patch = titleLayout(option, w, measureText);
      if (patch) c.setOption(patch, false);
    };
    try {
      c.setOption(option, true);
      layout();
    } catch {
      // 옵션 모양이 틀리면 빈 차트로 둔다(오류 문구는 JSON 해석 실패 때만)
    }
    setChart(c);
    const ro = new ResizeObserver(() => {
      c.resize();
      try {
        layout();
      } catch {
        // 제목 맞춤이 실패해도 차트는 그대로 둔다
      }
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      c.dispose();
      setChart(null);
    };
  }, [el, option, dark]);
  return chart;
}

function seriesOf(c: echarts.ECharts): Series[] {
  const s = (c.getOption() as Option).series;
  return Array.isArray(s) ? (s as Series[]) : [];
}

// withTooltip 은 툴팁 상자를 화면 테마에 맞춘다. 트리 노드는 그 노드의 정보만 DOM 으로 그린다(조상 경로를 잇지 않는다).
function withTooltip(option: Option, theme: Theme): Option {
  const p = theme.palette;
  const palette = {
    paper: p.background.paper,
    border: p.divider,
    text: p.text.primary,
    muted: p.text.secondary,
    font: String(theme.typography.fontFamily ?? 'sans-serif'),
    dark: p.mode === 'dark',
  };
  const base = option.tooltip && typeof option.tooltip === 'object' ? (option.tooltip as Option) : {};
  const tip: Option = { ...base, ...tooltipStyle(palette), confine: true };
  if (isTreeChart(option)) {
    tip.renderMode = 'html';
    tip.formatter = (params: { dataType?: string; data?: { name?: unknown; tipLines?: unknown } }) =>
      params.dataType === 'edge' || !params.data ? '' : treeTipElement(treeTipModel(params.data), palette);
  }
  return { ...option, tooltip: tip };
}

export default function ChartBlock({ code }: { code: string }) {
  const theme = useTheme();
  const dark = theme.palette.mode === 'dark';
  const [inlineEl, setInlineEl] = useState<HTMLDivElement | null>(null);
  const [fullEl, setFullEl] = useState<HTMLDivElement | null>(null);
  const [full, setFull] = useState(false);
  const parsed = useMemo(() => {
    try {
      return { option: withTooltip(withTreeDefaults(buildOption(code), dark), theme), error: '' };
    } catch (e) {
      return { option: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [code, dark, theme]);

  const inline = useChart(inlineEl, parsed.option, dark);
  const fullChart = useChart(full ? fullEl : null, parsed.option, dark);
  const active = useRef<echarts.ECharts | null>(null);
  active.current = full ? fullChart : inline;

  const update = useCallback((change: (s: Series[]) => Series[]) => {
    const c = active.current;
    if (c) c.setOption({ series: change(seriesOf(c)) }, false);
  }, []);

  if (parsed.error)
    return (
      <Box component="pre" sx={{ p: 1.5, bgcolor: 'action.hover', borderRadius: 1, overflow: 'auto' }}>
        <Typography variant="caption" color="error" component="div" sx={{ mb: 1 }}>
          {t('common.chartFailed', { error: parsed.error })}
        </Typography>
        <code>{code}</code>
      </Box>
    );

  const option = parsed.option as Option;
  const tree = isTreeChart(option);
  const treeActions: ViewerAction[] = tree
    ? [
        {
          key: 'fit',
          label: t('common.fitScreen'),
          icon: <FitScreenIcon fontSize="small" />,
          onClick: () => active.current?.dispatchAction({ type: 'restore' }),
        },
        {
          key: 'expand',
          label: t('common.expandAll'),
          icon: <UnfoldMoreIcon fontSize="small" />,
          onClick: () => update(expandAll),
        },
        {
          key: 'in',
          label: t('common.zoomIn'),
          icon: <ZoomInIcon fontSize="small" />,
          onClick: () => update((s) => treeZoom(s, true)),
        },
        {
          key: 'out',
          label: t('common.zoomOut'),
          icon: <ZoomOutIcon fontSize="small" />,
          onClick: () => update((s) => treeZoom(s, false)),
        },
      ]
    : [];

  return (
    <>
      <Box
        sx={{
          ...viewerFrameSx,
          my: 1,
          border: 1,
          borderColor: 'divider',
          borderRadius: 1,
          overflow: 'hidden',
          bgcolor: 'background.paper',
        }}
      >
        <ViewerToolbar
          actions={[
            {
              key: 'full',
              label: t('common.fullscreen'),
              icon: <FullscreenIcon fontSize="small" />,
              onClick: () => setFull(true),
            },
            ...treeActions,
          ]}
        />
        <Box
          ref={setInlineEl}
          role="img"
          aria-label={t('common.chart')}
          sx={{ width: '100%', height: chartHeight(option) }}
        />
      </Box>
      <Dialog fullScreen open={full} onClose={() => setFull(false)} aria-label={t('common.chart')}>
        <Box sx={{ ...viewerFrameSx, height: '100%', bgcolor: 'background.default' }}>
          <ViewerToolbar
            always
            actions={[
              {
                key: 'close',
                label: t('common.exitFullscreen'),
                icon: <CloseIcon fontSize="small" />,
                onClick: () => setFull(false),
              },
              ...treeActions,
            ]}
          />
          <Box ref={setFullEl} role="img" aria-label={t('common.chart')} sx={{ width: '100%', height: '100%' }} />
        </Box>
      </Dialog>
    </>
  );
}
