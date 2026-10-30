/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 대화 한 덩어리. 내 말은 은은한 단색 판에 담고, 에이전트 답은 상자 없이 본문 그대로 놓는다(스펙 §2).
// 채팅·회의·오피스 장면 대화가 같이 쓴다. 에이전트 쪽 가운데 위(머리줄)·아래(actions)는 슬롯이다.
import { Box } from '@mui/material';
import { memo, ReactNode, useRef } from 'react';

import { chatMetrics, chatType } from '@/lib/chatTokens';

import { useChatTokens } from './useChatTokens';

export interface MessageHead {
  avatar?: ReactNode;
  name: string;
  time?: string;
}

export interface MessageRowProps {
  side: 'mine' | 'agent';
  /** 에이전트 쪽 머리줄(아바타·이름·시각). 없으면 머리줄이 없다. */
  head?: MessageHead;
  /** 내 말 판 아래 오른쪽(시각·작성자) */
  foot?: ReactNode;
  /** 에이전트 본문 아래 왼쪽 단추 줄. 마우스를 올리거나 포커스가 들어올 때 보인다(터치 기기는 항상). */
  actions?: ReactNode;
  /** 참이면 actions 줄을 마우스를 올리지 않아도 늘 보인다 — 읽어 주기의 준비·재생·오류 중인 행(스펙 2026-10-28-012 DD3) */
  pinActions?: boolean;
  /** 마운트 때만 120ms 불투명도 전환. 처음 화면을 그릴 때는 주지 않는다. */
  enter?: boolean;
  children: ReactNode;
}

const GUTTER = chatMetrics.rowAvatar + 12;

function Row({ side, head, foot, actions, pinActions, enter, children }: MessageRowProps) {
  const tk = useChatTokens();
  const play = useRef(!!enter).current; // 마운트 때 값만 쓴다. 나중에 prop 이 바뀌어도 다시 재생하지 않는다.
  const fade = play
    ? { animation: 'chatRowIn 120ms ease-out', '@keyframes chatRowIn': { from: { opacity: 0 }, to: { opacity: 1 } }, '@media (prefers-reduced-motion: reduce)': { animation: 'none' } }
    : {};

  if (side === 'mine') {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', ...fade }}>
        <Box
          sx={{
            maxWidth: '70%',
            px: 1.5,
            py: 1,
            bgcolor: tk.mine,
            border: `1px solid ${tk.mineLine}`,
            borderRadius: `${chatMetrics.panelRadius}px ${chatMetrics.panelRadius}px 4px ${chatMetrics.panelRadius}px`,
            color: tk.text,
            fontSize: chatType.body,
            lineHeight: chatType.bodyLine,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
          }}
        >
          {children}
        </Box>
        {foot && <Box sx={{ mt: 0.5, fontSize: chatType.meta, lineHeight: 1.4, color: tk.muted }}>{foot}</Box>}
      </Box>
    );
  }

  // 아바타 열(28px)은 항상 둔다. head 가 없으면 비어 있어 이어 말하는 줄이 앞 줄과 같은 선에 놓인다.
  return (
    <Box
      className="chat-row"
      sx={{
        display: 'grid',
        gridTemplateColumns: `${GUTTER}px minmax(0, 1fr)`,
        '& .chat-row-actions': { opacity: pinActions ? 1 : 0, transition: 'opacity 120ms' },
        '&:hover .chat-row-actions, &:focus-within .chat-row-actions': { opacity: 1 },
        '@media (hover: none)': { '& .chat-row-actions': { opacity: 1 } },
        '@media (prefers-reduced-motion: reduce)': { '& .chat-row-actions': { transition: 'none' } },
        ...fade,
      }}
    >
      <Box sx={{ width: chatMetrics.rowAvatar }}>{head?.avatar}</Box>
      <Box sx={{ minWidth: 0, color: tk.text, fontSize: chatType.body, lineHeight: chatType.bodyLine }}>
        {head && (
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, minWidth: 0, lineHeight: 1.4, mb: 0.5 }}>
            <Box
              component="span"
              title={head.name}
              sx={{ fontSize: chatType.name, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {head.name}
            </Box>
            {head.time && (
              <Box component="span" sx={{ fontSize: chatType.meta, color: tk.muted, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                {head.time}
              </Box>
            )}
          </Box>
        )}
        {children}
        {actions && (
          <Box className="chat-row-actions" sx={{ mt: 0.25, display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
            {actions}
          </Box>
        )}
      </Box>
    </Box>
  );
}

export const MessageRow = memo(Row);
