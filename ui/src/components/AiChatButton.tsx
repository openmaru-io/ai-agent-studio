/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 상단 막대의 「AI」 단추(OMAI-1218). 검색창 옆에서 내 에이전트(지금 POD 의 주 에이전트)와의 대화 팝업을 열고 닫는다.
// 새 창을 만들지 않고 기존 대화 팝업(ChatPopup)을 연다 — 이름 PRIMARY 는 chatStore.resolve 가 채팅 기본 → 주 에이전트로 바꾼다(2026-10-19-001 L5).
// 팝업 상태만 구독한다(대화 저장소의 갱신마다 상단 막대가 다시 그려지지 않게).
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined';
import { Box, Tooltip } from '@mui/material';

import { t } from '@/i18n';
import { closeChat, openChat, setChatMinimized, useChatPopup } from '@/lib/chatPopup';
import { chatStore, PRIMARY } from '@/lib/chatStore';
import { shellMetrics } from '@/lib/shellTokens';

import { topbarButtonSx } from './topbarButton';

const MINE = PRIMARY;

export function AiChatButton() {
  const { target, minimized } = useChatPopup();
  const mine = target?.kind === 'chat' && chatStore.resolve(target.agent) === chatStore.resolve(MINE);
  const pressed = mine && !minimized;
  const onClick = () => {
    if (pressed) closeChat(); // 대화는 chatStore 에 남는다
    else if (mine) setChatMinimized(false);
    else openChat({ kind: 'chat', agent: MINE });
  };
  return (
    <Tooltip title={t('topbar.ai')}>
      <Box
        component="button"
        type="button"
        onClick={onClick}
        aria-label={t('topbar.ai')}
        aria-pressed={pressed}
        sx={topbarButtonSx(pressed)}
      >
        <AutoAwesomeOutlinedIcon sx={{ fontSize: shellMetrics.iconButtonSize }} />
      </Box>
    </Tooltip>
  );
}
