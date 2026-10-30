/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 다시 잇는 중 줄(스펙 2026-10-20-030 4-10 DR11): 사용자가 할 일 없이 기다리는 일시 상태라 회색이다. 할 일이 생긴 줄만 호박(WarnRow)·빨강(ErrorRow).
// 채팅·오피스 대화·회의실이 입력 칸 바로 위에 둔다(DR3). 남은 초는 화면에만 보이고 읽기 프로그램은 읽지 않는다(DR12) —
// 알림은 부르는 쪽이 상태가 바뀔 때 숨은 알림 영역으로 한 번 보낸다.
import SyncRoundedIcon from '@mui/icons-material/SyncRounded';
import { Box, Button, CircularProgress, useMediaQuery } from '@mui/material';
import { ReactNode, useEffect, useState } from 'react';

import { tier2 } from '@/components/tierButton';
import { t } from '@/i18n';
import { chatMetrics, ChatTokens, chatType, coarseTouch } from '@/lib/chatTokens';

import { useChatTokens } from './useChatTokens';

export interface ReconnectRowProps {
  /** 본문(좁은 창이면 short) */
  text: ReactNode;
  short?: ReactNode;
  /** 다음 시도 시각(ms). 0 이면 초를 보이지 않는다(지금 시도 중·연결 대기) */
  nextAt?: number;
  compact?: boolean;
  /** 「지금 다시 열기」·「지금 다시 읽기」 */
  action?: { label: string; onClick: () => void };
}

/** 입력 칸 위 회색 줄의 모양. 팀원 에이전트에게 보낸다는 대상 줄(채팅, 스펙 2026-10-22-001 DD5)도 같은 모양을 쓴다 */
export const statusRowSx = (tk: ChatTokens) =>
  ({
    mb: 1,
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    columnGap: 1,
    rowGap: 0.5,
    px: 1.5,
    py: 1,
    bgcolor: tk.rail,
    border: `1px solid ${tk.line}`,
    borderRadius: `${chatMetrics.tileRadius}px`,
    fontSize: chatType.name,
    color: tk.text,
  }) as const;

export function ReconnectRow({ text, short, nextAt = 0, compact, action }: ReconnectRowProps) {
  const tk = useChatTokens();
  const still = useMediaQuery('(prefers-reduced-motion: reduce)');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!nextAt || nextAt <= Date.now()) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [nextAt]);
  const secs = nextAt > now ? Math.ceil((nextAt - now) / 1000) : 0;
  return (
    <Box data-testid="reconnect-row" sx={statusRowSx(tk)}>
      {still ? (
        <SyncRoundedIcon aria-hidden="true" sx={{ fontSize: 14, color: tk.muted, flexShrink: 0 }} />
      ) : (
        <CircularProgress aria-hidden="true" size={14} thickness={5} sx={{ color: tk.muted, flexShrink: 0 }} />
      )}
      <Box sx={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
        {compact && short ? short : text}
        {secs > 0 && (
          <Box component="span" aria-hidden="true" sx={{ color: tk.muted }}>
            {' · '}
            {compact ? t('chat.reconnect.inShort', { s: secs }) : t('chat.reconnect.in', { s: secs })}
          </Box>
        )}
      </Box>
      {action && (
        <Button size="small" variant="outlined" color="inherit" onClick={action.onClick} sx={[tier2 as object, coarseTouch, { ml: 'auto' }]}>
          {action.label}
        </Button>
      )}
    </Box>
  );
}
