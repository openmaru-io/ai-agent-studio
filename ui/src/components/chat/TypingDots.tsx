/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 에이전트가 쓰는 중이라는 표시: 점 셋 + 글자. 점은 장식이라 읽지 않고 글자(label)가 이름이다.
// 움직임은 상태(쓰는 중)를 뜻할 때만 쓰고, prefers-reduced-motion 에서는 멈춘 점 셋이다.
import { Box, keyframes } from '@mui/material';

import { chatType } from '@/lib/chatTokens';

import { useChatTokens } from './useChatTokens';

const bob = keyframes`
  0%, 80%, 100% { opacity: 0.25; }
  40% { opacity: 1; }
`;

export function TypingDots({ label }: { label: string }) {
  const tk = useChatTokens();
  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, color: tk.muted, fontSize: 12 }}>
      <Box component="span" aria-hidden="true" sx={{ display: 'inline-flex', gap: '3px' }}>
        {[0, 1, 2].map((i) => (
          <Box
            key={i}
            component="span"
            sx={{
              width: 5,
              height: 5,
              borderRadius: '50%',
              bgcolor: 'currentColor',
              opacity: 0.6,
              animation: `${bob} 1.2s ease-in-out ${i * 0.16}s infinite`,
              '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
            }}
          />
        ))}
      </Box>
      <span style={{ fontSize: chatType.tool }}>{label}</span>
    </Box>
  );
}
