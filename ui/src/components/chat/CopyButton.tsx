/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 답 아래 행동 줄의 [복사]. 채팅의 복사 단추(Chat.tsx)와 같은 모양으로 오피스 대화·회의실에 둔다(스펙 2026-10-28-012 DD13).
import CheckIcon from '@mui/icons-material/Check';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { Box, IconButton, Tooltip } from '@mui/material';
import { useEffect, useRef, useState } from 'react';

import { t } from '@/i18n';
import { chatMetrics } from '@/lib/chatTokens';

import { useChatTokens } from './useChatTokens';

export function CopyButton({ text }: { text: string }) {
  const tk = useChatTokens();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 복사하지 못해도 대화는 계속된다. 확인 아이콘이 안 바뀌어 복사가 안 된 것을 알 수 있다 */
    }
  };
  return (
    <>
      <Tooltip title={t('chat.copyReplyLabel')}>
        <IconButton
          size="small"
          aria-label={t('chat.copyReplyLabel')}
          onClick={() => void copy()}
          sx={{ color: tk.muted, '&:hover': { color: tk.text }, '@media (pointer: coarse)': { minWidth: chatMetrics.touch, minHeight: chatMetrics.touch } }}
        >
          {copied ? <CheckIcon sx={{ fontSize: 16 }} /> : <ContentCopyIcon sx={{ fontSize: 16 }} />}
        </IconButton>
      </Tooltip>
      <Box role="status" sx={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>
        {copied ? t('chat.copiedLive') : ''}
      </Box>
    </>
  );
}
