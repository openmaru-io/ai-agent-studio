/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 번역된 스킬 설명 아래의 캡션 줄(스펙 2026-10-19-017 DD1~DD4).
// - 출처: LLM 번역은 「자동 번역」, 미리 만든(사람 검토) 번역은 「번역」(DD1)
// - 「원문 보기」: 공통 DisclosureButton. 펼친 원문은 lang="en"(화면 읽기 프로그램이 영어로 읽는다, DD2)
// - 「다시 번역」: 관리자에게만. 누르면 숨기고 role=status 안내, 실패하면 오류 문구와 단추를 되돌린다(DD3)
// - 좁은 화면은 줄을 바꾸고, 안내는 늘 자기 줄에 둔다. 줄임표로 자르지 않는다(DD4)
import { Box, Button, Stack, Typography } from '@mui/material';
import { useId, useState } from 'react';

import { DisclosureButton } from '@/components/DisclosureButton';
import { t } from '@/i18n';
import { coarseTouch } from '@/lib/chatTokens';
import { FOCUS_RING } from '@/lib/shellTokens';

export interface DescTranslationProps {
  /** 원문(서버의 description_src). 없으면 아무것도 그리지 않는다 */
  src?: string;
  /** "llm" | "seed" */
  by?: string;
  /** 있으면 「다시 번역」 단추를 보인다(관리자만 넘긴다) */
  onRetranslate?: () => Promise<unknown>;
}

export function DescTranslation({ src, by, onRetranslate }: DescTranslationProps) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<'idle' | 'busy' | 'sent' | 'failed'>('idle');
  const id = useId();
  if (!src) return null;
  const retry = async () => {
    if (!onRetranslate) return;
    setState('busy');
    try {
      await onRetranslate();
      setState('sent');
    } catch {
      setState('failed');
    }
  };
  return (
    <Box sx={{ mt: 0.5, mb: 1 }}>
      <Stack direction="row" alignItems="center" sx={{ flexWrap: 'wrap', columnGap: 1, rowGap: 0.25 }}>
        <Typography variant="caption" color="text.secondary">
          {by === 'seed' ? t('skills.descTranslated.seed') : t('skills.descTranslated.llm')}
        </Typography>
        <DisclosureButton
          open={open}
          onToggle={() => setOpen((v) => !v)}
          controls={id}
          label={open ? t('skills.descSource.hide') : t('skills.descSource.show')}
        />
        {onRetranslate && state !== 'sent' && (
          <Button
            variant="text"
            size="small"
            color="inherit"
            disabled={state === 'busy'}
            onClick={retry}
            sx={[{ '&.Mui-focusVisible': { boxShadow: `0 0 0 2px ${FOCUS_RING}` } }, coarseTouch]}
          >
            {t('skills.descRetranslate')}
          </Button>
        )}
      </Stack>
      {open && (
        <Typography id={id} lang="en" variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
          {src}
        </Typography>
      )}
      {!open && <span id={id} hidden />}
      {state === 'sent' && (
        <Typography role="status" variant="caption" color="text.secondary" sx={{ display: 'block', width: '100%', mt: 0.25 }}>
          {t('skills.descRetranslate.sent')}
        </Typography>
      )}
      {state === 'failed' && (
        <Typography role="alert" variant="caption" color="error" sx={{ display: 'block', width: '100%', mt: 0.25 }}>
          {t('skills.descRetranslate.failed')}
        </Typography>
      )}
    </Box>
  );
}
