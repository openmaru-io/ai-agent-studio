/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 메모리 초과로 다시 시작해 중단된 대화의 원인 줄(cogentai-aas-docs docs-plan/deploy/chat-oom-blocked-session-close-followups.md ①, 디자인 2B·3A·5A·6A·6B·7A).
// LostReplyRow 와 같은 호박색 줄. 단추는 작업공간 서랍의 안내(OomAlert)와 같다: 사용자는 메모리 늘리기 요청, 관리자는 크기 바꾸기.
// 좁은 곳(팝업·480px 미만)에서는 단추가 글 아래 한 줄 전체 폭이다(6B).
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded';
import { Box, Button, useMediaQuery } from '@mui/material';

import { tier2 } from '@/components/tierButton';
import { RequestAdminButton } from '@/features/requests/RequestAdminButton';
import { t } from '@/i18n';
import type { OomInfo } from '@/lib/chat';
import { chatMetrics, chatType, coarseTouch } from '@/lib/chatTokens';
import { fmtTs } from '@/lib/format';

import { useChatTokens } from './useChatTokens';

/** pod: 이 대화의 작업공간(없으면 지금 작업공간). label: 단추 낭독 이름의 작업공간 이름(6A, 없으면 단추 글자). onSize: 관리자의 [크기 바꾸기] */
export function OomRow({ oom, pod, label, admin, compact, onSize }: { oom: OomInfo; pod?: string; label: string; admin: boolean; compact?: boolean; onSize: () => void }) {
  const tk = useChatTokens();
  const phone = useMediaQuery('(max-width:479.98px)');
  const narrow = !!compact || phone;
  const at = fmtTs(oom.finished_at);
  const btnSx = [tier2 as object, coarseTouch, narrow ? { width: '100%', minHeight: chatMetrics.touch } : {}];
  return (
    <Box
      role="status"
      data-testid="oom-row"
      sx={{
        my: 1,
        display: 'flex',
        alignItems: narrow ? 'flex-start' : 'center',
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
      <WarningAmberRoundedIcon aria-hidden="true" sx={{ fontSize: 18, color: tk.warn, flexShrink: 0, mt: narrow ? '1px' : 0 }} />
      <Box sx={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', color: tk.text }}>
        <Box sx={{ fontWeight: 600 }}>{oom.limit_memory ? t('chat.oomLine1', { limit: oom.limit_memory, at }) : t('chat.oomLine1NoLimit', { at })}</Box>
        <Box>{admin ? t('chat.oomLine2Admin') : t('chat.oomLine2')}</Box>
      </Box>
      <Box sx={narrow ? { flexBasis: '100%' } : { flexShrink: 0 }}>
        {admin ? (
          <Button size="small" variant="outlined" color="inherit" sx={btnSx} onClick={onSize}>
            {t('agents.oomSizeLink')}
          </Button>
        ) : (
          // pod 가 없으면(작업공간 하나) 쿠키로 고른 작업공간에 요청한다
          <RequestAdminButton
            profile="_workspace"
            pod={pod}
            kind="workspace_size"
            label={t('requests.askSize')}
            ariaLabel={label ? t('requests.askSizeFor', { name: label }) : undefined}
            detail={t('requests.sizeDetail', { at, limit: oom.limit_memory || '?' })}
            color="inherit"
            sx={btnSx}
          />
        )}
      </Box>
    </Box>
  );
}
