/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 공유받은 AI 에이전트 작업공간의 시작 안내(스펙 2026-11-17-008 §3-4). 채팅 입력 칸 위 회색 상태 줄 —
// 「○○ 님이 공유한 AI 에이전트 작업공간입니다 — <소유자가 적은 안내>」. 닫으면 그 안내 글이 바뀔 때까지 이 브라우저에서 다시 보이지 않는다.
import CloseIcon from '@mui/icons-material/Close';
import ShareOutlinedIcon from '@mui/icons-material/ShareOutlined';
import { Box, IconButton } from '@mui/material';
import { useState } from 'react';

import { statusRowSx } from '@/components/chat/ReconnectRow';
import { useChatTokens } from '@/components/chat/useChatTokens';
import { t } from '@/i18n';

const KEY = 'aas.sharedNote.closed';

function closedSet(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) || '[]') as string[]);
  } catch {
    return new Set();
  }
}

/** access(그 사람의 자격)가 use·edit(공유받은 사람)일 때만 그린다 */
export function SharedWorkspaceNote({ pod, access, owner, note }: { pod?: string; access?: string; owner?: string; note?: string }) {
  const tk = useChatTokens();
  const id = `${pod ?? ''}:${note ?? ''}`;
  const [closed, setClosed] = useState(() => closedSet().has(id));
  if (!pod || (access !== 'use' && access !== 'edit') || closed) return null;
  const close = () => {
    setClosed(true);
    try {
      localStorage.setItem(KEY, JSON.stringify([...closedSet(), id].slice(-50)));
    } catch {
      // 저장하지 못해도 이번 화면에서는 닫힌다
    }
  };
  const text = note ? t('agents.share.bannerNote', { name: owner || '', note }) : t('agents.share.banner', { name: owner || '' });
  return (
    <Box role="status" data-testid="shared-workspace-note" sx={statusRowSx(tk)}>
      <ShareOutlinedIcon aria-hidden="true" sx={{ fontSize: 14, color: tk.muted, flexShrink: 0 }} />
      <Box sx={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{text}</Box>
      <IconButton size="small" aria-label={t('agents.share.bannerClose')} onClick={close} sx={{ ml: 'auto', p: 0.25 }}>
        <CloseIcon sx={{ fontSize: 14 }} />
      </IconButton>
    </Box>
  );
}
