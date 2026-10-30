/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box } from '@mui/material';
import type { ReactNode } from 'react';

export type PillTone = 'good' | 'warn' | 'bad' | 'info' | 'neutral';

/** 상태 뱃지(DESIGN.md Badges & Pills): good=정상, warn=경고, bad=실패, info=안내, neutral=태그. 색 쌍은 테마별로 DESIGN.md 값을 쓴다. */
export function StatusPill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return (
    <Box
      component="span"
      data-pill={tone}
      sx={(th) => {
        const dark = th.palette.mode === 'dark';
        const pair = {
          good: dark ? ['rgba(16,185,129,0.15)', '#4ade80', 'rgba(16,185,129,0.25)'] : ['#f0fdf4', '#16a34a', '#bbf7d0'],
          warn: dark ? ['rgba(245,158,11,0.15)', '#f59e0b', 'rgba(245,158,11,0.25)'] : ['#fffbeb', '#b45309', '#fde68a'],
          bad: dark ? ['rgba(239,83,80,0.15)', '#ef5350', 'rgba(239,83,80,0.30)'] : ['#fef2f1', '#da291c', '#f5c6c2'],
          info: dark ? ['rgba(96,165,250,0.15)', '#60a5fa', 'rgba(96,165,250,0.25)'] : ['#eff6ff', '#2563eb', '#bfdbfe'],
          neutral: dark ? ['transparent', '#d0d6e0', '#23252a'] : ['transparent', '#4b5563', '#e5e7eb'],
        }[tone];
        return {
          display: 'inline-flex',
          alignItems: 'center',
          px: '8px',
          height: 20,
          borderRadius: '9999px',
          border: `1px solid ${pair[2]}`,
          bgcolor: pair[0],
          color: pair[1],
          fontSize: 11,
          fontWeight: 500,
          lineHeight: 1,
          whiteSpace: 'nowrap',
          verticalAlign: 'middle',
        };
      }}
    >
      {children}
    </Box>
  );
}

