/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 스킬 화면 머리의 「AI 에이전트별 | 전체 스킬」 두 칸 전환(스펙 2026-11-06-003 R2·D4·D11).
// 에이전트 화면(PageTitle action)과 표 화면(ListView titleAction)이 같은 부품을 같은 자리(머리 오른쪽 끝)에 둔다.
// 주소 동작은 예전 「전체 표」(onTable)·「AI 에이전트별로 보기」(AgentViewButton) 그대로이고, 둘 다 주소를 쌓아 브라우저 「뒤로」가 된다.
import { Box, ToggleButton, ToggleButtonGroup, useMediaQuery } from '@mui/material';
import { useSearchParams } from 'react-router-dom';

import { ALL_PROFILES } from '@/components/ProfileScopeSelect';
import { t } from '@/i18n';

export type SkillsView = 'agent' | 'all';

export function SkillsViewToggle({ value }: { value: SkillsView }) {
  const [, setParams] = useSearchParams();
  // 900px 미만은 제목 줄 아래 한 줄 전체 폭(D11). PageTitle 의 wrap 과 함께 쓴다
  const narrow = useMediaQuery('(max-width:899.98px)');
  const go = (v: SkillsView) =>
    setParams((prev) => {
      if (v === 'all') {
        const next = new URLSearchParams(prev);
        ['skill', 'pane', 'f'].forEach((k) => next.delete(k));
        next.set('view', 'table');
        next.set('profile', ALL_PROFILES);
        return next;
      }
      // 표에서 고른 에이전트만 남긴다(「전체 프로파일」 * 는 뺀다)
      const next = new URLSearchParams();
      const p = prev.get('profile');
      if (p && p !== ALL_PROFILES) next.set('profile', p);
      return next;
    });
  return (
    <Box
      data-skills-view={value}
      sx={narrow ? { flexBasis: '100%', order: 1, mt: 1 } : { ml: 'auto', display: 'inline-flex' }}
    >
      <ToggleButtonGroup
        exclusive
        size="small"
        fullWidth={narrow}
        value={value}
        // 눌린 칸을 다시 누르면 null 이 온다 — 무시한다(LazyFileViewer 와 같다, OV-H3)
        onChange={(_e, v: SkillsView | null) => v && v !== value && go(v)}
        aria-label={t('skillsAgent.viewMode')}
        sx={{
          '& .MuiToggleButton-root': { px: 1.5, minHeight: narrow ? 44 : 32, whiteSpace: 'nowrap' },
          '@media (pointer: coarse)': { '& .MuiToggleButton-root': { minHeight: 44 } },
        }}
      >
        <ToggleButton value="agent">{t('skillsAgent.byAgent')}</ToggleButton>
        <ToggleButton value="all">{t('skillsAgent.viewAll')}</ToggleButton>
      </ToggleButtonGroup>
    </Box>
  );
}
