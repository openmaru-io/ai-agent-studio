/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 대화 영역의 바깥 틀: 12px 모서리·1px 테두리. 높이는 틀의 위쪽 끝에서 화면 아래까지를 재서 채운다(useFillHeight).
// offset 은 재기 전에 쓰는 값이다 — 채팅 168px, 회의는 같은 탭 아래의 오피스 장면과 같은 230px(스펙 §4-8).
import { Box, SxProps, Theme } from '@mui/material';
import { ReactNode } from 'react';

import { useFillHeight } from '@/components/useFillHeight';
import { chatMetrics } from '@/lib/chatTokens';

import { useChatTokens } from './useChatTokens';

export function ChatFrame({
  offset,
  minHeight = 420,
  sx,
  children,
}: {
  /** CSS 길이. 예: '168px' */
  offset: string;
  minHeight?: number;
  sx?: SxProps<Theme>;
  children: ReactNode;
}) {
  const tk = useChatTokens();
  const fill = useFillHeight<HTMLDivElement>();
  return (
    <Box
      ref={fill.ref}
      sx={[
        {
          ...(fill.height !== undefined
            ? { height: fill.height }
            : { height: `calc(100vh - ${offset})`, '@supports (height: 100dvh)': { height: `calc(100dvh - ${offset})` } }),
          minHeight,
          border: `1px solid ${tk.line}`,
          borderRadius: `${chatMetrics.frameRadius}px`,
          overflow: 'hidden',
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
        },
        ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
      ]}
    >
      {children}
    </Box>
  );
}
