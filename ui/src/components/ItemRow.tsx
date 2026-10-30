/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 항목 한 줄(이름 + 뱃지 / 설명 + 오른쪽 조작)과 작은 스위치. 프로파일 서랍의 스킬·MCP·도구 묶음·비밀값·크론 탭,
// 지난 대화 서랍, 글 편집기의 판 기록이 같이 쓴다. 값은 DESIGN.md 를 따른다:
// 이름 14px/500 본문 글자색, 설명 13px 보조 글자색, 줄 사이 1px 선, 올리면 옅은 바탕(§1-1.2 Hover), 스위치 §4 Toggle Switch.
import type { SvgIconComponent } from '@mui/icons-material';
import { Box, Stack, Typography } from '@mui/material';
import { alpha, Theme } from '@mui/material/styles';
import type { SystemStyleObject } from '@mui/system';
import { ReactNode, useEffect, useRef } from 'react';

import { FOCUS_RING } from '@/lib/shellTokens';

import { monoFont } from './bits';

/** DESIGN.md §4 Toggle Switch: 트랙 22x12·손잡이 9px, 켜짐도 회색 바탕(파란색·브랜드 빨강 금지, §1-1). 누르는 자리는 34x24 로 둔다 */
export const compactSwitchSx = (th: Theme): SystemStyleObject<Theme> => {
  const dark = th.palette.mode === 'dark';
  const ink = dark ? '255,255,255' : '17,24,39';
  return {
    width: 34,
    height: 24,
    p: '6px',
    '& .MuiSwitch-switchBase': {
      p: '7.5px',
      '&:hover': { bgcolor: 'transparent' },
      '&.Mui-checked': { transform: 'translateX(10px)' },
      '&.Mui-checked + .MuiSwitch-track': {
        opacity: 1,
        bgcolor: `rgba(${ink},${dark ? 0.18 : 0.55})`,
        borderColor: `rgba(${ink},${dark ? 0.28 : 0.65})`,
      },
      '&.Mui-disabled + .MuiSwitch-track': { opacity: 0.4 },
      '&.Mui-disabled .MuiSwitch-thumb': { opacity: 0.6 },
      '&.Mui-focusVisible .MuiSwitch-thumb': { outline: `2px solid ${FOCUS_RING}`, outlineOffset: 2 },
    },
    '& .MuiSwitch-thumb': {
      width: 9,
      height: 9,
      boxShadow: '0 1px 2px rgba(0,0,0,0.18)',
      bgcolor: dark ? '#9ba1ad' : '#9ca3af',
    },
    '& .Mui-checked .MuiSwitch-thumb': { bgcolor: dark ? '#f7f8f8' : '#ffffff' },
    '& .MuiSwitch-track': {
      boxSizing: 'border-box',
      borderRadius: 9999,
      opacity: 1,
      bgcolor: `rgba(${ink},${dark ? 0.08 : 0.06})`,
      border: `1px solid rgba(${ink},0.10)`,
    },
  };
};

// 키보드 포커스 링은 화면 공통 토큰(스펙 2026-10-19-014). 예전 70% 글자색은 선택 표시(selectedAccent)와 겹쳐 구분이 약했다
const focusRing = () => ({ outline: `2px solid ${FOCUS_RING}`, outlineOffset: 2 });

export interface ItemRowProps {
  icon?: SvgIconComponent;
  /** 아이콘 자리에 둘 다른 것(판 비교의 체크박스 등). 있으면 icon 대신 그린다 */
  lead?: ReactNode;
  name: ReactNode;
  /** 이름을 고정폭 글자로(환경변수 이름 등) */
  mono?: boolean;
  /** 이름만 누를 수 있게(스킬 → 호출 흐름). 올리면 밑줄 */
  onName?: () => void;
  /** 줄 전체를 누를 수 있게(크론 작업 → 작업 서랍, 지난 대화 → 이어서 하기). control 은 함께 쓰지 않는다 */
  onRow?: () => void;
  /** 줄 전체 단추의 툴팁(지난 대화 미리 보기 전문 등) */
  rowTitle?: string;
  /** 이름 옆 보조 표기(도구 묶음의 내부 이름 등) */
  meta?: string;
  tags?: ReactNode;
  description?: ReactNode;
  off?: boolean;
  /** 오른쪽(스위치·단추·작은 글) */
  control?: ReactNode;
  /** 줄 아래 전체 폭(연결 시험 결과·입력 칸 등) */
  below?: ReactNode;
  /** 다른 화면의 링크가 이 줄을 가리킨다: 한 번 가운데로 스크롤하고 선택 줄과 같은 옅은 바탕으로 강조한다(OMAI-1249 V17) */
  focused?: boolean;
  /** 한 줄 행: 이름·뱃지·설명을 한 줄에 두고 설명은 말줄임(마우스를 올리면 전체). 긴 목록(스킬 56개 등)용(2026-10-17-017) */
  dense?: boolean;
}

export function ItemRow({ icon: Icon, lead, name, mono, onName, onRow, rowTitle, meta, tags, description, off, control, below, focused, dense }: ItemRowProps) {
  const rootRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (focused) rootRef.current?.scrollIntoView?.({ block: 'center' });
  }, [focused]);
  const nameSx = {
    fontFamily: mono ? monoFont : 'inherit',
    fontSize: mono ? 13 : 14,
    fontWeight: 500,
    lineHeight: 1.6,
    color: off ? 'text.secondary' : 'text.primary',
    overflowWrap: 'anywhere',
  } as const;
  const grid = (th: Theme) => ({
    display: 'grid',
    gridTemplateColumns: lead || Icon ? 'auto minmax(0, 1fr) auto' : 'minmax(0, 1fr) auto',
    columnGap: 1.5,
    alignItems: 'center',
    width: '100%',
    px: 1.5,
    py: dense ? 0.5 : 1.25,
    '&:hover': { bgcolor: alpha(th.palette.text.primary, 0.04) },
  });
  const inner = (
    <>
      {lead ??
        (Icon && (
          <Icon
            data-item-icon=""
            aria-hidden
            sx={{ fontSize: dense ? 16 : 18, alignSelf: dense ? 'center' : 'start', mt: dense ? 0 : '3px', color: off ? 'text.disabled' : 'text.secondary' }}
          />
        ))}
      <Box sx={{ minWidth: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: dense ? 'nowrap' : 'wrap', columnGap: 1, rowGap: 0.5, '& .MuiChip-root': { mr: 0 } }}>
          {onName ? (
            <Box
              component="button"
              type="button"
              onClick={onName}
              sx={() => ({
                ...nameSx,
                p: 0,
                border: 0,
                bgcolor: 'transparent',
                cursor: 'pointer',
                textAlign: 'left',
                '&:hover': { textDecoration: 'underline', color: 'text.primary' },
                '&:focus-visible': { ...focusRing(), borderRadius: '2px' },
              })}
            >
              {name}
            </Box>
          ) : (
            <Box component="span" sx={nameSx}>
              {name}
            </Box>
          )}
          {meta && (
            <Typography component="span" sx={{ fontFamily: monoFont, fontSize: 12, color: 'text.secondary' }}>
              {meta}
            </Typography>
          )}
          {tags}
          {dense && description ? (
            <Typography
              component="span"
              title={typeof description === 'string' ? description : undefined}
              sx={{ flex: '1 1 0', minWidth: 0, fontSize: 13, color: off ? 'text.disabled' : 'text.secondary', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
            >
              {description}
            </Typography>
          ) : null}
        </Box>
        {!dense && description ? (
          <Typography
            component="div"
            sx={{ fontSize: 13, lineHeight: 1.6, color: off ? 'text.disabled' : 'text.secondary', mt: 0.25, overflowWrap: 'anywhere' }}
          >
            {description}
          </Typography>
        ) : null}
      </Box>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ justifySelf: 'end' }}>
        {control}
      </Stack>
    </>
  );
  return (
    <Box
      component="li"
      ref={rootRef}
      data-item-row=""
      data-off={off ? '' : undefined}
      data-focused={focused ? '' : undefined}
      aria-current={focused ? 'true' : undefined}
      sx={(th) => ({ borderBottom: `1px solid ${th.palette.divider}`, ...(focused ? { bgcolor: alpha(th.palette.text.primary, th.palette.mode === 'dark' ? 0.06 : 0.04) } : {}) })}
    >
      {onRow ? (
        <Box
          component="button"
          type="button"
          title={rowTitle}
          onClick={onRow}
          sx={(th) => ({
            ...grid(th),
            border: 0,
            bgcolor: 'transparent',
            color: 'inherit',
            font: 'inherit',
            textAlign: 'left',
            cursor: 'pointer',
            '&:focus-visible': { ...focusRing(), outlineOffset: -2 },
          })}
        >
          {inner}
        </Box>
      ) : (
        <Box sx={grid}>{inner}</Box>
      )}
      {below && <Box sx={{ px: 1.5, pb: 1.25, pl: lead || Icon ? 'calc(12px + 18px + 12px)' : 1.5 }}>{below}</Box>}
    </Box>
  );
}

export function ItemList({ children }: { children: ReactNode }) {
  return (
    <Box component="ul" sx={(th) => ({ listStyle: 'none', m: 0, p: 0, borderTop: `1px solid ${th.palette.divider}` })}>
      {children}
    </Box>
  );
}

/** 목록이 비었을 때의 한 줄 */
export function ItemEmpty({ children }: { children: ReactNode }) {
  return (
    <Box component="li" sx={{ px: 1.5, py: 1.25 }}>
      <Typography color="text.secondary">{children}</Typography>
    </Box>
  );
}
