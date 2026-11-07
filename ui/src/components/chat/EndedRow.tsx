/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 프로파일이 없어져 끝난 대화의 줄(cogentai-aas-docs docs-plan/deploy/chat-oom-blocked-session-close-followups.md ③, 디자인 3C·5B·6A·6B).
// LostReplyRow 와 같은 모양에 Sky(정보) 색. 할 일은 다른 에이전트를 골라 새 대화를 여는 것 하나다 — 같은 프로파일로 새로 열면 실패한다.
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { Box, Button, useMediaQuery } from '@mui/material';

import { tier2 } from '@/components/tierButton';
import { t } from '@/i18n';
import { chatMetrics, chatType, coarseTouch } from '@/lib/chatTokens';

import { useChatTokens } from './useChatTokens';

export function EndedRow({ onNewChat, compact }: { onNewChat: () => void; compact?: boolean }) {
  const tk = useChatTokens();
  const phone = useMediaQuery('(max-width:479.98px)');
  const narrow = !!compact || phone;
  return (
    <Box
      role="status"
      data-testid="ended-row"
      sx={{
        my: 1,
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 1,
        px: 1.5,
        py: 1,
        bgcolor: tk.infoWash,
        border: `1px solid ${tk.infoLine}`,
        borderRadius: `${chatMetrics.tileRadius}px`,
        fontSize: chatType.name,
      }}
    >
      <InfoOutlinedIcon aria-hidden="true" sx={{ fontSize: 18, color: tk.info, flexShrink: 0 }} />
      <Box component="span" sx={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', color: tk.text }}>
        {t('chat.profileEnded')}
      </Box>
      <Box sx={narrow ? { flexBasis: '100%' } : { flexShrink: 0 }}>
        <Button size="small" variant="outlined" color="inherit" sx={[tier2 as object, coarseTouch, narrow ? { width: '100%', minHeight: chatMetrics.touch } : {}]} onClick={onNewChat}>
          {t('chat.newChatShort')}
        </Button>
      </Box>
    </Box>
  );
}
