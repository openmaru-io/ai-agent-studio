/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 오류 줄: 무엇이 잘못됐는지와 복구 단추를 한 줄에(스펙 §4-3). 채팅·회의·오피스 장면 대화가 같이 쓴다.
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import { Box } from '@mui/material';
import { ReactNode } from 'react';

import { chatMetrics, chatType } from '@/lib/chatTokens';

import { useChatTokens } from './useChatTokens';

export function ErrorRow({ children, action, inset }: { children: ReactNode; action?: ReactNode; inset?: boolean }) {
  const tk = useChatTokens();
  return (
    <Box
      role="alert"
      sx={{
        ml: inset ? 5 : 0,
        my: 1,
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 1.5,
        py: 1,
        bgcolor: tk.errWash,
        border: `1px solid ${tk.errLine}`,
        borderRadius: `${chatMetrics.tileRadius}px`,
        fontSize: chatType.name,
      }}
    >
      <ErrorOutlineIcon aria-hidden="true" sx={{ fontSize: 18, color: '#ef5350', flexShrink: 0 }} />
      <Box sx={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', color: tk.text }}>{children}</Box>
      {action}
    </Box>
  );
}
