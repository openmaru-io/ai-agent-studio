/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 채팅 「파일」 서랍과 회의 「자료」 서랍이 함께 쓰는 부품(스펙 2026-10-20-002 §6-4): 이름 찾기 칸과 접고 펴는 묶음 머리.
// 값은 §3-7 표(찾기 = Sunken input 36px, 묶음 머리 = 13px 500 + 개수 Tertiary). 머리 전체가 하나의 단추이고 옆 동작(첨부 등)은 단추 밖에 둔다.
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import SearchIcon from '@mui/icons-material/Search';
import { Box, ButtonBase, InputBase, Stack, Typography, useTheme } from '@mui/material';
import type { ReactNode, Ref } from 'react';

import { useChatTokens } from '@/components/chat/useChatTokens';
import { FOCUS_RING } from '@/lib/shellTokens';

/** 파일 이름 찾기 칸 */
export function FileSearch({ value, onChange, placeholder, inputRef }: { value: string; onChange: (v: string) => void; placeholder: string; inputRef?: Ref<HTMLInputElement> }) {
  const tk = useChatTokens();
  const dark = useTheme().palette.mode === 'dark';
  return (
    <Box
      sx={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        height: 36,
        px: 1.25,
        borderRadius: '6px',
        bgcolor: dark ? 'rgba(0,0,0,0.25)' : 'rgba(17,24,39,0.04)',
        border: '1px solid transparent',
        '&:focus-within': { borderColor: dark ? 'rgba(255,255,255,0.30)' : 'rgba(17,24,39,0.35)' },
      }}
    >
      <SearchIcon sx={{ fontSize: 18, color: tk.muted }} aria-hidden />
      <InputBase
        inputRef={inputRef}
        type="search"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputProps={{ 'aria-label': placeholder }}
        sx={{ flex: 1, fontSize: 13 }}
      />
    </Box>
  );
}

/** 묶음 머리: 꺾쇠 · 묶음 아이콘 · 이름 · 개수 … 오른쪽 끝(tail). 누르면 접고 편다. action 은 단추 밖 오른쪽(단추 안 단추 방지, F9) */
export function GroupHead({
  icon,
  title,
  count,
  ariaLabel,
  tail,
  action,
  open,
  onToggle,
  controls,
}: {
  icon: ReactNode;
  title: string;
  /** 개수. 목록이 잘린 묶음은 「7+」처럼 글자로 받는다(스펙 2026-10-27-012 2A) */
  count: number | string;
  /** 접근 이름을 따로 줄 때(「…, 파일 7개 이상」). 없으면 단추 안 글자가 이름이다 */
  ariaLabel?: string;
  tail?: ReactNode;
  action?: ReactNode;
  open: boolean;
  onToggle: () => void;
  controls: string;
}) {
  const tk = useChatTokens();
  return (
    <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
      <Typography component="h3" sx={{ flex: 1, minWidth: 0, m: 0, fontSize: 13 }}>
        <ButtonBase
          aria-expanded={open}
          aria-label={ariaLabel}
          aria-controls={controls}
          onClick={onToggle}
          sx={{
            width: '100%',
            minHeight: 32,
            px: 1,
            gap: 0.75,
            justifyContent: 'flex-start',
            borderRadius: '6px',
            font: 'inherit',
            textAlign: 'left',
            '&:hover': { bgcolor: tk.hover },
            '&:focus-visible': { outline: `2px solid ${FOCUS_RING}`, outlineOffset: -2 },
            '@media (pointer: coarse)': { minHeight: 44 },
          }}
        >
          <ChevronRightIcon
            aria-hidden
            sx={{
              fontSize: 16,
              ml: '-2px',
              color: tk.muted,
              transform: open ? 'rotate(90deg)' : 'none',
              transition: 'transform 160ms', // DESIGN §1-3.2(스펙 2026-10-27-012 8A)
              '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
            }}
          />
          <Box component="span" aria-hidden sx={{ display: 'inline-flex', color: tk.muted, '& svg': { fontSize: 16 } }}>
            {icon}
          </Box>
          <Box component="span" sx={{ fontWeight: 500, color: tk.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {title}
          </Box>
          <Box component="span" sx={{ color: tk.muted }}>
            {count}
          </Box>
          {tail && (
            <Box component="span" sx={{ ml: 'auto', display: 'inline-flex', alignItems: 'center', gap: 0.75, fontSize: 12, color: tk.muted, fontVariantNumeric: 'tabular-nums' }}>
              {tail}
            </Box>
          )}
        </ButtonBase>
      </Typography>
      {action}
    </Stack>
  );
}
