/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 설정 › 회사 정보: 회사 이름을 정하면 모든 에이전트의 SOUL 첫 문장이 `You are CogentAI AAS Agent, built by <회사명>.` 이 된다.
// 회사 이름·소개 문장은 관리자만 보고 고친다. 부서 슬로건·목표는 일반 사용자도 자기 부서 것을 고친다(OMAI-1230). 계획 2026-10-13-008.
import { Box, Button, Stack, TextField, Typography } from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useEffect, useState } from 'react';

import { monoFont, ScreenLoading, Section } from '@/components/bits';
import { PageTitle } from '@/components/PageTitle';
import { t } from '@/i18n';
import { get, post } from '@/lib/api';
import { useIsAdmin } from '@/lib/data';

import { DepartmentGoal, DepartmentGoals } from './settings/DepartmentGoals';

interface SettingsData {
  company_name: string;
  default_company: string;
  effective_company: string;
  identity_sentence: string;
  max: number;
  /** 부서 문구 길이 상한과 부서 목록(관리자만 받는다) */
  goal_max?: number;
  department_goals?: DepartmentGoal[];
  /** all: 관리자가 모든 부서를 본다. own: 일반 사용자는 자기 부서 한 줄만 받는다(OMAI-1230) */
  goal_scope?: 'all' | 'own';
  /** 문구를 고칠 수 있는가(관리자 또는 부서가 있는 사용자). 없으면 can_edit 을 따른다 */
  can_edit_goal?: boolean;
  can_edit: boolean;
}

/** 서버(aas/common/settings.identity_sentence)와 같은 규칙: 마침표로 끝나는 이름에는 마침표를 더 붙이지 않는다. */
export const identitySentence = (company: string): string =>
  `You are CogentAI AAS Agent, built by ${company}${company.endsWith('.') ? '' : '.'}`;

export function Settings() {
  const q = useQuery<SettingsData>({ queryKey: ['settings'], queryFn: () => get<SettingsData>('/api/settings') });
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const d = q.data;
  useEffect(() => {
    if (d) setName(d.company_name);
  }, [d]);

  const admin = useIsAdmin();
  if (!d) return <ScreenLoading title={t('views.settings.label')} error={q.error?.message} />;
  const cleaned = name.split(/\s+/).filter(Boolean).join(' ');
  const preview = identitySentence(cleaned || d.default_company);
  const changed = cleaned !== d.company_name;
  const tooLong = cleaned.length > d.max;
  const save = async () => {
    setBusy(true);
    try {
      await post('/api/settings', { company_name: cleaned });
      enqueueSnackbar(t('settings.saved'), { variant: 'success' });
      await qc.invalidateQueries({ queryKey: ['settings'] });
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box sx={{ maxWidth: 720 }}>
      <PageTitle>{t('views.settings.label')}</PageTitle>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        {admin ? t('views.settings.sub') : t('settings.subOwn')}
      </Typography>

      {admin && (
      <>
      <Section title={t('settings.companyTitle')} guide="settings.company" indent>
        <Stack direction="row" spacing={1} alignItems="flex-start">
          <TextField
            size="small"
            fullWidth
            label={t('settings.companyLabel')}
            value={name}
            placeholder={d.default_company}
            disabled={!d.can_edit || busy}
            error={tooLong}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && changed && !tooLong && d.can_edit) void save();
            }}
            helperText={d.can_edit ? t('settings.companyHelp', { default: d.default_company, max: d.max }) : t('settings.viewOnly')}
          />
          {d.can_edit && (
            <Button variant="contained" disabled={!changed || tooLong || busy} onClick={() => void save()} sx={{ flexShrink: 0 }}>
              {t('settings.save')}
            </Button>
          )}
        </Stack>
      </Section>

      <Section title={t('settings.identityTitle')} indent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          {t('settings.identityLead')}
        </Typography>
        <Box
          component="code"
          data-testid="identity-preview"
          sx={{
            display: 'block',
            fontFamily: monoFont,
            fontSize: 12.5,
            px: 1.5,
            py: 1,
            border: 1,
            borderColor: 'divider',
            borderRadius: 1,
            bgcolor: 'action.hover',
            overflowWrap: 'anywhere',
          }}
        >
          {preview}
        </Box>
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
          {t('settings.identityNote')}
        </Typography>
      </Section>
      </>
      )}

      <Section title={t('settings.goalTitle')} guide="settings.goal" indent>
        <DepartmentGoals rows={d.department_goals ?? []} max={d.goal_max ?? 60} canEdit={d.can_edit_goal ?? d.can_edit} own={d.goal_scope === 'own'} />
      </Section>

      <Section title={t('settings.teamTitle')} indent>
        <Typography variant="body2" color="text.secondary">
          {t('settings.teamNote')}
        </Typography>
      </Section>
    </Box>
  );
}
