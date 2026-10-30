/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 접고 펼치는 글자 단추(스펙 2026-10-19-005). 화면마다 Button 에 aria-expanded·아이콘을 따로 붙이던 것을 한 곳에서 정한다.
// - 펼침 아이콘(ExpandMore)은 글자 앞, 펼치면 180°. 동작 줄이기 설정이면 전환만 끄고 회전은 한다(펼친 상태가 보이게, G3)
// - aria-expanded·aria-controls 는 부품이 마지막에 넣는다 — 호출처가 덮지 못한다
// - 모양(variant·size·아이콘·글자)은 부품이 정한다. 호출처는 색·여백(sx)·접근 이름·disabled 만 넘긴다(G2)
// - 키보드 포커스는 포커스 링 토큰(DESIGN.md §1-1.5, G4, 무채색 2026-10-19-014), 손가락 화면은 누르기 높이 44(G11). emotion 이 @media 를 기본 규칙 뒤에 써서 호출처 minHeight 를 덮는다
// 펼친 상태 글자는 무엇을 접는지 말한다(「닫기」는 쓰지 않는다). 「접기」 한 단어는 영역 바로 아래이거나 목록 줄 머리일 때만(G7·R15).
// - 만들기 모양(look="create"): 탭 밑 줄 오른쪽 끝의 만들기 단추(「새 MCP 서버」 등)와 같은 테두리 단추에 + 아이콘. 펼치면 아이콘을 뺀다(2026-10-17-019 §5)
import AddIcon from '@mui/icons-material/Add';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Button, type ButtonProps, type Theme } from '@mui/material';
import type { ReactNode, Ref } from 'react';

import { coarseTouch } from '@/lib/chatTokens';
import { FOCUS_RING } from '@/lib/shellTokens';

/** 켜고 끄는 글자 단추(aria-pressed: 「내용 보기」·「미리 보기」)가 켜졌을 때의 모양. DESIGN.md Icon Button Active 와 같은 무채색 wash(스펙 2026-10-19-005 G5) */
export const pressedSx = (th: Theme) => ({
  '&[aria-pressed="true"]': th.palette.mode === 'dark' ? { backgroundColor: 'rgba(255,255,255,0.06)', color: '#f7f8f8' } : { backgroundColor: 'rgba(17,24,39,0.04)', color: '#111827' },
});

type Fixed = 'variant' | 'size' | 'startIcon' | 'endIcon' | 'children' | 'onClick' | 'aria-expanded' | 'aria-controls';

export interface DisclosureButtonProps extends Omit<ButtonProps, Fixed> {
  open: boolean;
  onToggle: () => void;
  label: ReactNode;
  /** 펼쳐지는 영역의 id(필수) */
  controls: string;
  /** 모양: 글자 단추와 펼침 아이콘(기본) 또는 만들기 단추(테두리, + 아이콘) */
  look?: 'text' | 'create';
  ref?: Ref<HTMLButtonElement>;
}

const base = {
  '&.Mui-focusVisible': { boxShadow: `0 0 0 2px ${FOCUS_RING}` },
} as const;

export function DisclosureButton({ open, onToggle, label, controls, look = 'text', sx, color = 'inherit', ref, ...rest }: DisclosureButtonProps) {
  const callerSx = Array.isArray(sx) ? sx : sx ? [sx] : [];
  return (
    <Button
      {...rest}
      ref={ref}
      color={color}
      variant={look === 'create' ? 'outlined' : 'text'}
      size="small"
      onClick={onToggle}
      sx={[base, ...callerSx, coarseTouch]}
      startIcon={
        look === 'create' ? (
          open ? undefined : <AddIcon />
        ) : (
          <ExpandMoreIcon
          sx={{ transition: 'transform 160ms ease', transform: open ? 'rotate(180deg)' : 'none', '@media (prefers-reduced-motion: reduce)': { transition: 'none' } }}
          />
        )
      }
      aria-expanded={open}
      aria-controls={controls}
    >
      {label}
    </Button>
  );
}
