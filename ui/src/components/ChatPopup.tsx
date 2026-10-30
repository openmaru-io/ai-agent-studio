/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 화면 위 공통 대화 팝업(OMAI-1115). CogentAI 위젯처럼 떠 있는 창으로, 메뉴를 옮겨도 남는다.
// 창 껍데기(끌기·크기·최소화·칩)는 FloatingChatShell 이고, 여기서는 에이전트 대화를 안에 넣는다.
// 최소화해도 대화를 언마운트하지 않는다 — 오피스 대화(AgentChat)는 마운트돼 있을 때만 답을 받아 온다.
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import { IconButton, Tooltip, Typography } from '@mui/material';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { AgentChat } from '@/features/office/AgentChat';
import { t } from '@/i18n';
import { closeChat, setChatMinimized, useChatPopup } from '@/lib/chatPopup';
import { chatStore, targetTitle, useChat } from '@/lib/chatStore';
import { useRoomChatPopup } from '@/lib/roomChatPopup';
import { Conversation } from '@/screens/Chat';

import { FloatingChatShell } from './FloatingChatShell';
import { useUiOptional } from './UiContext';

const KEY = 'aas.chatPopup.rect';

export function ChatPopup() {
  const { target, minimized, openedAt } = useChatPopup();
  const ui = useUiOptional();
  const navigate = useNavigate();
  const store = useChat(chatStore);
  const roomChat = useRoomChatPopup();
  // 최소화한 동안 다시 잇다 포기한 대화는 칩에 알린다(DR14). 다시 잇는 중에는 더하지 않는다 — 할 일이 없는 일시 상태다
  const [officeLost, setOfficeLost] = useState(false);

  if (!target) return null;
  const S = target.kind === 'chat' ? store.current() : null;
  const lost = target.kind === 'chat' ? !!S?.closed && !S.reconnect && !!S.items.at(-1)?.kind && (!!S.items.at(-1)?.reopen || !!S.items.at(-1)?.newChat) : officeLost;
  const agentName = target.kind === 'chat' ? store.resolve(target.agent) : '';
  // 채팅 화면의 대화 머리와 같은 이름(2026-10-19-013 C5): 프로파일이 하나뿐이면 에이전트 이름, 여럿이면 「에이전트 / 프로파일」(디자인 D4).
  // 묶음을 읽기 전에는 틀린 이름(main)을 잠깐 보이지 않고 「대화」만 보인다(DD6)
  const loading = target.kind === 'chat' && !store.status;
  const name =
    target.kind === 'chat'
      ? loading
        ? ''
        : targetTitle(store.group() ?? store.status, store.agent(store.profile || agentName), store.groups.length > 1)
      : target.title;

  const expand = () => {
    if (target.kind !== 'chat') return;
    ui?.dismissDrawer();
    closeChat();
    // 팝업이 보이는 그 대화를 연다 — 에이전트·묶음·저장된 대화를 함께 넘긴다(스펙 2026-10-28-014 외부 검토 M4).
    // 묶음을 읽기 전(이름이 아직 없음)이면 팝업을 연 대상을 넘긴다
    const p = new URLSearchParams({ agent: store.profile || target.agent });
    const pod = store.profile ? store.status?.pod : target.pod;
    const session = store.profile ? store.current()?.storedId : undefined;
    if (pod) p.set('pod', pod);
    if (session) p.set('session', session);
    navigate('/chat?' + p);
  };

  return (
    <FloatingChatShell
      rectKey={KEY}
      slot={roomChat.target && roomChat.openedAt < openedAt ? 1 : 0} // 회의실 채팅 창이 먼저 떠 있었으면 그 왼쪽 옆에 놓는다
      title={loading ? t('shell.chatWith') : t('chat.popupLabel', { name })}
      ariaLabel={loading ? t('shell.chatWith') : t('chat.popupLabel', { name })}
      chipLabel={loading ? t('shell.chatWith') : name}
      restoreLabel={t('chat.popupRestore', { name: loading ? '' : name }).trim()}
      alert={lost ? t('chat.chipLost') : undefined}
      minimized={minimized}
      onMinimize={() => setChatMinimized(true)}
      onRestore={() => setChatMinimized(false)}
      onClose={closeChat}
      bodyPadding={target.kind === 'office' ? 1.5 : 0}
      actions={
        target.kind === 'chat' ? (
          <Tooltip title={t('chat.popupExpand')}>
            <IconButton size="small" aria-label={t('chat.popupExpand')} onClick={expand}>
              <OpenInFullIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        ) : undefined
      }
    >
      {target.kind === 'chat' ? (
        store.status?.configured === false ? (
          <Typography color="text.secondary" sx={{ p: 2 }}>
            {t('chat.notConfigured')}
          </Typography>
        ) : (
          <Conversation store={store} compact />
        )
      ) : (
        <AgentChat key={target.alias} alias={target.alias} fill onLost={setOfficeLost} />
      )}
    </FloatingChatShell>
  );
}
