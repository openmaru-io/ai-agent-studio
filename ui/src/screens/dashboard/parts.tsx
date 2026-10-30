/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 대시보드 부품. 테두리 있는 상자를 쓰지 않는다(디자인 DD8): 구역은 DESIGN.md §4 Section Headers, 숫자는 테두리 없는 한 줄.
import type { SvgIconComponent } from '@mui/icons-material';
import RefreshIcon from '@mui/icons-material/Refresh';
import { Alert, Box, Button, ButtonBase, Skeleton, Typography } from '@mui/material';
import { ReactNode } from 'react';

import { StatusPill } from '@/components/StatusPill';
import { t } from '@/i18n';
import { MONO_FONT } from '@/lib/monoFont';
const MONO = MONO_FONT;

export { StatusPill };
export type { PillTone } from '@/components/StatusPill';

/** DESIGN.md §4 Section Headers: 빨간 줄 + 두 자리 번호 + / + (아이콘) + 제목 + 오른쪽 부속 정보. 아이콘은 제목 글자색을 따른다(§1-3, MUI SVG). */
export function SectionHeader({
  index,
  caption,
  trail,
  id,
  icon: Icon,
}: {
  index: number;
  caption: string;
  trail?: ReactNode;
  id?: string;
  icon?: SvgIconComponent;
}) {
  return (
    <Box
      component="h2"
      id={id}
      sx={(th) => {
        const dark = th.palette.mode === 'dark';
        return {
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '10px',
          m: 0,
          mb: '12px',
          fontFamily: MONO,
          fontSize: 10,
          fontWeight: 500,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          fontFeatureSettings: '"tnum" 1',
          '&::before': {
            content: "''",
            width: 20,
            height: 2,
            borderRadius: '1px',
            background: '#DA291C',
            boxShadow: '0 0 6px rgba(218, 41, 28, 0.25)',
          },
          '& .idx': { color: dark ? '#8a8f98' : '#9ca3af' },
          '& .sep': { color: dark ? '#3e3e44' : '#d1d5db', fontWeight: 400 },
          '& .cap': { color: dark ? '#d0d6e0' : '#1f2937', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '6px' },
          '& .trail': { ml: 'auto', letterSpacing: '0.08em', textTransform: 'none', color: 'text.disabled', fontWeight: 500 },
        };
      }}
    >
      <span className="idx">{String(index).padStart(2, '0')}</span>
      <span className="sep">/</span>
      <span className="cap">
        {Icon && <Icon aria-hidden sx={{ fontSize: 15, flexShrink: 0 }} />}
        {caption}
      </span>
      {trail && <span className="trail">{trail}</span>}
    </Box>
  );
}

/** 구역 안의 작은 제목(표·추이·확인할 것). 아이콘이 있으면 제목 앞에 둔다(§1-3). */
export function SubHead({ children, right, icon: Icon }: { children: ReactNode; right?: ReactNode; icon?: SvgIconComponent }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 3, mb: 1 }}>
      <Typography variant="subtitle2" component="h3" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
        {Icon && <Icon aria-hidden sx={{ fontSize: '1.2em', color: 'text.secondary', flexShrink: 0 }} />}
        {children}
      </Typography>
      {right && <Box sx={{ ml: 'auto' }}>{right}</Box>}
    </Box>
  );
}

/** 구역 제목 아래 내용을 제목 글자 자리(아이콘 폭만큼)로 들여 제목과 구분한다. 제목은 SubHead, 내용은 이것으로 감싼다. */
export function SubBody({ children }: { children: ReactNode }) {
  return <Box sx={{ pl: 3 }}>{children}</Box>;
}

export type KpiTone = 'bad' | 'warn';

/** 숫자 하나: 큰 숫자 + 작은 이름. 0 이면 기본 글자색, 아니면 상태색. 누르면 go. */
export function Kpi({ n, label, sub, tone, go }: { n: ReactNode; label: string; sub?: string; tone?: KpiTone; go?: () => void }) {
  const color = tone && n !== 0 && n !== '0' ? (tone === 'bad' ? 'error.main' : 'warning.main') : 'text.primary';
  const body = (
    <>
      <Typography variant="h4" component="div" data-kpi-n="" sx={{ color, fontVariantNumeric: 'tabular-nums', lineHeight: 1.15 }}>
        {n}
      </Typography>
      <Typography variant="body2" component="div" color="text.secondary" data-kpi-label="">
        {label}
      </Typography>
      {sub && (
        <Typography variant="caption" component="div" color="text.disabled">
          {sub}
        </Typography>
      )}
    </>
  );
  // 부제가 있는 칸과 없는 칸의 숫자 높이를 맞춘다(위에서부터 쌓는다)
  const sx = { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'flex-start', textAlign: 'left', p: 1, borderRadius: 1, minWidth: 0 } as const;
  if (!go) return <Box sx={sx}>{body}</Box>;
  return (
    <ButtonBase
      onClick={go}
      data-kpi=""
      sx={{ ...sx, '&:hover': { bgcolor: 'action.hover' }, '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main' } }}
    >
      {body}
    </ButtonBase>
  );
}

/** 숫자 줄. 960px 이상은 4열, 아래는 2열(디자인 §19-6). */
export function KpiRow({ children }: { children: ReactNode }) {
  return <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', md: 'repeat(4, minmax(0, 1fr))' } }}>{children}</Box>;
}

/** 불러오는 동안 자리를 지킨다(높이 고정 — 값이 들어와도 아래가 밀리지 않는다, DD4). */
export function Placeholder({ height }: { height: number }) {
  return <Skeleton variant="rounded" height={height} aria-busy="true" />;
}

/** 그 구역만의 오류와 다시 시도(다른 구역은 그대로, DD4). */
export function LoadError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <Alert
      severity="error"
      action={
        <Button startIcon={<RefreshIcon />} color="inherit" size="small" onClick={retry}>
          {t('dashboard.retry')}
        </Button>
      }
    >
      {t('dashboard.loadFailed', { error: error instanceof Error ? error.message : String(error) })}
    </Alert>
  );
}
