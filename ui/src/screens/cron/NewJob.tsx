/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 새 크론 작업: 어느 프로파일이, 언제, 어떤 스킬(또는 지시문)을, 결과를 어디로.
import AddIcon from '@mui/icons-material/Add';
import { Alert, Box, Button, Link, NativeSelect, Stack, TextField, Typography } from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { MouseEvent, useEffect, useState } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';

import { AgentPicker } from '@/components/AgentPicker';
import { Section, useOpenInDrawer } from '@/components/bits';
import { SkillPicker } from '@/components/SkillPicker';
import { useUi } from '@/components/UiContext';
import { t } from '@/i18n';
import { get, post } from '@/lib/api';
import { nextRuns } from '@/lib/cronmath';
import { summaryLine } from '@/lib/schedule';
import { useFocusOnMount } from '@/lib/useFocusOnMount';

import { Explain, ScheduleEditor } from './JobDrawer';

export function NewJobBody({
  profiles,
  preset,
  fixedProfile,
  onDone,
  officeAlias,
  agent,
}: {
  profiles: string[];
  preset?: { profile?: string; skill?: string };
  /** 에이전트 화면에서 열면 프로파일을 고정하고 고르는 칸을 숨긴다 */
  fixedProfile?: string;
  /** 있으면 만든 뒤 서랍을 닫고 운영 > Cron 으로 가는 대신 이것을 부른다 */
  onDone?: () => void;
  /** 있으면 /api/cron/action 대신 오피스 크론 라우트로 만든다(관리자가 남의 에이전트에 만들 때) */
  officeAlias?: string;
  /** 작업이 생길 에이전트의 화면 이름. 있으면 요약 문장의 주어를 「<에이전트>의 <프로파일>」로 쓰고 에이전트를 바꾸는 법을 안내한다(2026-10-19-010) */
  agent?: string;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { closeDrawer } = useUi();
  const openHere = useOpenInDrawer();
  const { enqueueSnackbar } = useSnackbar();
  const first = useFocusOnMount<HTMLInputElement | HTMLSelectElement>();
  const [profile, setProfile] = useState(
    fixedProfile ?? (preset?.profile && profiles.includes(preset.profile) ? preset.profile : profiles[0] ?? '')
  );
  const [name, setName] = useState('');
  const [skill, setSkill] = useState(preset?.skill ?? '');
  const [prompt, setPrompt] = useState('');
  const [deliverPick, setDeliverPick] = useState('local');
  // 결과를 보낼 곳: 이 프로파일에 연결된(켜짐·설정 끝) 채널. 읽지 못하면(주인·관리자가 아님 등) 예전 고정 목록을 쓴다
  const chans = useQuery<{ platforms: { id: string; name: string; enabled: boolean; configured: boolean; home_channel: boolean }[] }>({
    queryKey: ['channels-platforms', profile],
    queryFn: () => get(`/api/channels/platforms?profile=${encodeURIComponent(profile)}`),
    retry: false,
    staleTime: 15000,
  });
  const targets: { id: string; label: string }[] = chans.data
    ? [
        { id: 'local', label: t('cronJob.newDeliverLocal') },
        ...chans.data.platforms
          .filter((p) => p.enabled && p.configured)
          .map((p) => ({ id: p.id, label: p.home_channel ? p.name : `${p.name} (${t('cronJob.newNoHome')})` })),
      ]
    : [
        { id: 'local', label: t('cronJob.newDeliverLocal') },
        { id: 'telegram', label: t('schedule.targetTelegram') },
        { id: 'buzz', label: t('schedule.targetBuzz') },
      ];
  const deliver = targets.some((x) => x.id === deliverPick) ? deliverPick : 'local';
  const setDeliver = setDeliverPick;
  const [expr, setExpr] = useState('0 9 * * *');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // 설명 조회는 입력이 멎은 뒤에 한 번만 한다
  const [asked, setAsked] = useState({ profile, skill: skill.trim(), deliver });
  useEffect(() => {
    const id = setTimeout(() => setAsked({ profile, skill: skill.trim(), deliver }), 350);
    return () => clearTimeout(id);
  }, [profile, skill, deliver]);

  const tooOften = minutesBetween(expr);
  const who = (p: string) => (agent ? t('cronJob.profileOfAgent', { agent, profile: p }) : p);

  const create = async () => {
    setBusy(true);
    try {
      if (officeAlias)
        await post(`/api/office/cron/${encodeURIComponent(officeAlias)}/jobs`, {
          name: name.trim(),
          schedule: expr,
          skills: skill.trim() ? [skill.trim()] : null,
          prompt,
          deliver,
        });
      else
        await post('/api/cron/action', {
          action: 'create',
          profile,
          job_name: name.trim(),
          schedule: expr,
          skill: skill.trim(),
          prompt,
          deliver,
        });
      enqueueSnackbar(t('cronJob.newCreated', { name: name.trim() }), { variant: 'success' });
      await Promise.all(
        ['flows', 'cron-jobs', 'health', 'profiles'].map((k) => qc.invalidateQueries({ queryKey: [k] }))
      );
      if (onDone) {
        onDone();
        return;
      }
      closeDrawer();
      navigate(`/cron?tab=jobs&q=${encodeURIComponent(name.trim())}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Stack spacing={1.5}>
      {!fixedProfile && (
        <AgentPicker
          label={t('cronJob.newProfile')}
          value={profile}
          onChange={setProfile}
          options={profiles.map((p) => ({ value: p, label: p }))}
          inputRef={first as React.Ref<HTMLInputElement>}
        />
      )}
      {agent && !fixedProfile && (
        <Typography variant="caption" color="text.secondary">
          {t('cronJob.newOtherAgent')}
        </Typography>
      )}
      <TextField
        size="small"
        inputRef={fixedProfile ? first : undefined}
        label={t('cronJob.newName')}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t('cronJob.newNamePlaceholder')}
        slotProps={{ htmlInput: { spellCheck: false } }}
      />
      <SkillPicker value={skill} onChange={setSkill} profile={profile} />
      <TextField
        size="small"
        multiline
        minRows={3}
        label={t('cronJob.prompt')}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder={t('cronJob.newPromptPlaceholder')}
      />
      <NativeSelect
        value={deliver}
        onChange={(e) => setDeliver(e.target.value)}
        inputProps={{ 'aria-label': t('cron.deliverLabel') }}
      >
        {targets.map((x) => (
          <option key={x.id} value={x.id}>
            {x.label}
          </option>
        ))}
      </NativeSelect>
      <Typography variant="caption" color="text.secondary">
        {t('cronJob.newDeliverHint')}{' '}
        <Link component={RouterLink} to={`/profiles?${new URLSearchParams({ name: profile, pane: 'channels' })}`}
          onClick={(e: MouseEvent) => openHere(e, { kind: 'profile', name: profile, pane: 'channels' }) || void closeDrawer()}
        >
          {t('cronJob.newConnectChannel')}
        </Link>
      </Typography>
      <Section title={t('cronJob.period')}>
        <ScheduleEditor current="0 9 * * *" canEdit onChange={setExpr} />
      </Section>
      <Section title={t('cronJob.newWillDo')}>
        <Explain
          query={asked}
          ctx={{ profile: who(asked.profile), schedule: expr, skill: asked.skill, deliver: asked.deliver }}
        />
      </Section>
      <Section title={t('cronJob.newReview')}>
        <Typography>{summaryLine({ profile: who(profile), schedule: expr, skill: skill.trim(), deliver })}</Typography>
      </Section>
      {tooOften !== null && <Alert severity="warning">{t('cronJob.newTooOften', { n: tooOften })}</Alert>}
      {error && <Alert severity="error">{error}</Alert>}
      <Box>
        <Button startIcon={<AddIcon />} variant="contained" disabled={busy} onClick={create}>
          {t('cronJob.newCreate')}
        </Button>
      </Box>
      <Typography variant="caption" color="text.secondary">
        {t('cronJob.newNote')}
      </Typography>
    </Stack>
  );
}

/** 실행 간격이 5분 미만이면 그 분 수(경고용, 스펙 2026-10-15-003 R5). 해석하지 못하거나 5분 이상이면 null */
export function minutesBetween(expr: string): number | null {
  const runs = nextRuns(expr, 2);
  if (!runs || runs.length < 2) return null;
  const gap = Math.round((runs[1].getTime() - runs[0].getTime()) / 60000);
  return gap < 5 ? Math.max(gap, 1) : null;
}
