/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 「/」 명령 결과 카드(스펙 2026-10-26-010 DC2). 모델 답과 구별되게 아바타·이름 없이 오류 줄과 같은 들여쓰기에 둔다.
// Hermes 의 출력은 터미널용 글이라 고정폭으로 그린다. 이 화면에만 있다 — 기록에 남지 않아 다시 열거나 되감으면 사라진다(카드 아래에 알린다).
// 색은 회색만(사용법·턴 없음 안내도 이 카드). 빨강·호박은 쓰지 않는다(DC11).
import CheckIcon from '@mui/icons-material/Check';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { Box, IconButton, Tooltip } from '@mui/material';
import { useId, useLayoutEffect, useRef, useState } from 'react';

import { DisclosureButton } from '@/components/DisclosureButton';
import { t } from '@/i18n';
import { chatMetrics, chatType, coarseTouch } from '@/lib/chatTokens';
import { MONO_FONT } from '@/lib/monoFont';

import { useChatTokens } from './useChatTokens';

/** 본문 최대 높이(px). 넘으면 「펼치기」 */
export const COMMAND_MAX = 320;

export function CommandCard({
  command,
  text,
  time,
  inset = true,
  background,
}: {
  command: string;
  text: string;
  time?: string;
  inset?: boolean;
  /** review·refine — 결과는 뒤에서 돌고 나중에 대화에 붙는다(스펙 2026-10-27-002 §4-3) */
  background?: boolean;
}) {
  const tk = useChatTokens();
  const body = useRef<HTMLPreElement>(null);
  const [tall, setTall] = useState(false);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const bodyId = useId();
  useLayoutEffect(() => {
    const el = body.current;
    if (el) setTall(el.scrollHeight > COMMAND_MAX + 1);
  }, [text]);
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <Box role="status" data-testid="command-card" sx={{ ml: inset ? 5 : 0, my: 1 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5, fontSize: chatType.meta, color: tk.muted }}>
        <Box component="span" sx={{ fontFamily: MONO_FONT, fontSize: chatType.tool }}>
          {command}
        </Box>
        {time && <span>{time}</span>}
        <Tooltip title={t('chat.cmd.copy')}>
          <IconButton size="small" aria-label={t('chat.cmd.copy')} onClick={copy} sx={[{ ml: 'auto', color: tk.muted, '&:hover': { color: tk.text } }, coarseTouch]}>
            {copied ? <CheckIcon sx={{ fontSize: 16 }} /> : <ContentCopyIcon sx={{ fontSize: 16 }} />}
          </IconButton>
        </Tooltip>
      </Box>
      <Box
        component="pre"
        id={bodyId}
        ref={body}
        sx={{
          m: 0,
          px: 1.5,
          py: 1,
          maxHeight: open ? 'none' : COMMAND_MAX,
          overflow: open ? 'visible' : 'hidden',
          bgcolor: tk.sunken,
          border: `1px solid ${tk.line}`,
          borderRadius: `${chatMetrics.tileRadius}px`,
          fontFamily: MONO_FONT,
          fontSize: chatType.tool,
          lineHeight: 1.6,
          color: tk.text,
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
        }}
      >
        {text.trim() ? text : t('chat.cmd.empty')}
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5, fontSize: chatType.meta, color: tk.muted }}>
        <span>{background ? `${t('chat.cmd.background')} · ${t('chat.cmd.screenOnly')}` : t('chat.cmd.screenOnly')}</span>
        {(tall || open) && (
          <DisclosureButton
            open={open}
            onToggle={() => setOpen((o) => !o)}
            controls={bodyId}
            label={open ? t('chat.cmd.collapse') : t('chat.cmd.expand')}
            sx={{ fontSize: chatType.meta }}
          />
        )}
      </Box>
    </Box>
  );
}
