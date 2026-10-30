/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// Subtle Badge(무채색, DESIGN §4): 「지금 에이전트」·「내 팀」·「팀」처럼 상태가 아닌 설명. 뜻은 글자로 말하고 색에 기대지 않는다(스펙 2026-10-22-001 DD11).
// 채팅 화면에만 있던 것을 상단 고르개도 쓰도록 옮겼다. 상단 막대는 테마와 상관없이 늘 어두워 mode 로 다크 토큰을 고른다.
import { Box, useTheme } from '@mui/material';
import type { ReactNode } from 'react';

import { chatTokens } from '@/lib/chatTokens';

export function SubtleBadge({ children, mode }: { children: ReactNode; mode?: 'light' | 'dark' }) {
  const themeMode = useTheme().palette.mode;
  const tk = chatTokens[mode ?? themeMode];
  return (
    <Box
      component="span"
      sx={{
        px: 0.75,
        borderRadius: '2px',
        border: `1px solid ${tk.line}`,
        bgcolor: tk.monoTile,
        color: tk.text,
        fontSize: 10,
        fontWeight: 500,
        whiteSpace: 'nowrap',
        lineHeight: '16px',
      }}
    >
      {children}
    </Box>
  );
}
