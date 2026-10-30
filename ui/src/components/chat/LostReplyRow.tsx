/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 서버가 다시 시작돼 답을 받지 못한 줄(스펙 2026-10-20-030 DR6). 가드레일 차단 줄(회의실 GuardRow)과 같은 모양이다 —
// 같은 「답이 오지 않음」에 색과 다시 묻는 방법이 둘이면 헷갈린다. 호박색 줄 + 링크 「다시 묻기」. 회의실과 오피스 대화가 같이 쓴다.
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded';
import { Box, Link as MuiLink } from '@mui/material';

import { t } from '@/i18n';
import { chatMetrics, chatType } from '@/lib/chatTokens';

import { useChatTokens } from './useChatTokens';

export function LostReplyRow({ text, onAskAgain }: { text: string; onAskAgain?: () => void }) {
  const tk = useChatTokens();
  return (
    <Box
      role="note"
      sx={{
        my: 1,
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 1,
        px: 1.5,
        py: 1,
        bgcolor: tk.warnWash,
        border: `1px solid ${tk.warnLine}`,
        borderRadius: `${chatMetrics.tileRadius}px`,
        fontSize: chatType.name,
      }}
    >
      <WarningAmberRoundedIcon aria-hidden="true" sx={{ fontSize: 18, color: tk.warn, flexShrink: 0 }} />
      <Box component="span" sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
        {text}
      </Box>
      {onAskAgain && (
        <MuiLink component="button" type="button" onClick={onAskAgain} sx={{ fontSize: chatType.meta, minHeight: chatMetrics.touch, '@media (pointer: fine)': { minHeight: 0 } }}>
          {t('office.askAgain')}
        </MuiLink>
      )}
    </Box>
  );
}
