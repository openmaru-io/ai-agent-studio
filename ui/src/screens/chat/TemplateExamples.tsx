/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 템플릿에서 만든 프로파일의 첫 대화 빈 화면: 만든 사람이 적은 예시(aas.examples)를 단추로 보인다(스펙 2026-11-18-002 §4-5 첫 일 안내).
// 누르면 입력칸에만 채운다 — 보내기는 사람이 누른다. 예시가 없거나 읽지 못하면 아무것도 그리지 않는다.

import { Box, Button, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';

import { t } from '@/i18n';
import { get } from '@/lib/api';

export function TemplateExamples({ pod, profile, onPick }: { pod?: string; profile: string; onPick: (text: string) => void }) {
  const q = useQuery<{ examples: string[] }>({
    queryKey: ['template-examples', pod ?? '', profile],
    queryFn: () => get(`/api/market/template/examples?profile=${encodeURIComponent(profile)}${pod ? `&pod=${encodeURIComponent(pod)}` : ''}`),
    enabled: !!profile,
    retry: false,
    staleTime: 5 * 60_000,
  });
  const examples = q.data?.examples ?? [];
  if (!examples.length) return null;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.75 }} data-template-examples="">
      <Typography variant="caption" color="text.secondary">
        {t('chat.templateExamples')}
      </Typography>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 0.75 }}>
        {examples.map((x) => (
          <Button key={x} size="small" variant="outlined" color="inherit" sx={{ textTransform: 'none' }} onClick={() => onPick(x)}>
            {x}
          </Button>
        ))}
      </Box>
    </Box>
  );
}
