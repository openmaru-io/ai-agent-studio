/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 상단 막대 메뉴(계정 메뉴·에이전트 고르개)의 줄 모양(스펙 2026-10-19-019 O8). 두 메뉴가 같은 줄을 그려 여기에 둔다.
// 손가락 화면에서는 줄을 44px 로 키운다(DD15).
import { chatMetrics, ChatTokens } from '@/lib/chatTokens';

export function menuItemSx(tk: ChatTokens) {
  return {
    minHeight: 36,
    mx: 0.75,
    px: 1.25,
    gap: 1.25,
    borderRadius: '8px',
    fontSize: 13,
    color: tk.text,
    '& .MuiListItemIcon-root': { minWidth: 0, color: tk.muted },
    '&:hover': { bgcolor: tk.hover },
    '&.Mui-selected, &.Mui-selected:hover': { bgcolor: tk.selected },
    '&.Mui-focusVisible': { bgcolor: tk.selected, outline: `1px solid ${tk.popup.edgeFront}`, outlineOffset: -1 },
    '@media (pointer: coarse)': { minHeight: chatMetrics.touch },
  } as const;
}
