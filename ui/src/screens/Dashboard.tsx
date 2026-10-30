/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 대시보드(첫 화면, 계획 2026-10-14-014 §19). 관리자는 위 「전체 에이전트」와 아래 「지금 에이전트」 두 구역, 그 밖은 「지금 에이전트」만.
// 갱신 주기는 값마다 다르다(R9): 전체 요약은 5분(+창에 다시 들어올 때), 지금 에이전트는 웹소켓 토픽(없으면 60초).
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import { Alert, Box, Button, Stack, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useRef } from 'react';
import { useNavigate } from 'react-router-dom';

import { PageTitle } from '@/components/PageTitle';
import { tier1 } from '@/components/tierButton';
import { t } from '@/i18n';
import { viewerAgentLabel } from '@/lib/agentLabel';
import { get } from '@/lib/api';
import { Dashboard as DashboardData } from '@/lib/dashboard';
import { isAdmin, useHealth, useMe } from '@/lib/data';
import { fmtTs } from '@/lib/format';
import { bannerHidden, doneGuides, hideBanner, startGuide, useGuideRun } from '@/lib/guideRun';
import { GUIDES } from '@/lib/guides';

import { CurrentAgent } from './dashboard/CurrentAgent';
import { Fleet } from './dashboard/Fleet';
import { LoadError, Placeholder, SectionHeader } from './dashboard/parts';

const FIVE_MINUTES = 5 * 60_000;

export function Dashboard() {
  const nav = useNavigate();
  const me = useMe();
  const admin = isAdmin(me.data);
  const health = useHealth();
  const dash = useQuery<DashboardData>({
    queryKey: ['dashboard'],
    queryFn: () => get<DashboardData>('/api/dashboard'),
    enabled: admin,
    refetchInterval: FIVE_MINUTES,
    refetchOnWindowFocus: true,
  });
  const current = useRef<HTMLDivElement>(null);
  const toCurrent = () => current.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const m = me.data;
  const pod = m?.pod?.id;
  const preparing = m?.primary?.ready === false;
  const times = [
    admin && dash.data?.collected_at ? t('dashboard.fleetCollected', { ts: fmtTs(dash.data.collected_at) }) : '',
    health.data ? t('dashboard.currentCollected', { ts: fmtTs(health.data.collected_at) }) : '',
  ]
    .filter(Boolean)
    .join(' · ');

  // 시작하기 띠: 사용자를 알고(기록이 사용자별), 숨기지 않았고, 시작하기 묶음을 다 끝내지 않았을 때만
  const guide = useGuideRun();
  const startDone = GUIDES.filter((g) => g.group === 'start' && g.audience === 'user').every((g) => doneGuides().has(g.id));
  const showBanner = !!guide.user && !!m && !!pod && !preparing && !bannerHidden() && !startDone;

  let body;
  if (m && !pod) {
    body = (
      <Alert
        severity="info"
        action={
          <Stack direction="row" spacing={1}>
            {/* 에이전트가 없으면 시작하기 띠 대신 이 안내에 따라하기를 더한다(OMAI-1274 디자인 리뷰 5A) */}
            <Button onClick={() => startGuide('user.my-agents')}>{t('guides.banner.myAgents')}</Button>
            <Button startIcon={<SmartToyOutlinedIcon />} onClick={() => nav('/agents')}>{t('dashboard.toAgents')}</Button>
          </Stack>
        }
      >
        {t('dashboard.noAgents')}
      </Alert>
    );
  } else if (preparing) {
    body = (
      <Alert severity="info">
        <strong>{t('dashboard.preparingAgent')}</strong> {t('dashboard.preparingSub')}
      </Alert>
    );
  } else {
    body = <CurrentAgent admin={admin} owner={!!m?.owner} />;
  }

  return (
    <Box>
      <Stack direction="row" alignItems="baseline" spacing={2} useFlexGap flexWrap="wrap" sx={{ mb: 3 }}>
        <PageTitle>{t('dashboard.title')}</PageTitle>
        <Typography variant="body2" color="text.secondary" sx={{ ml: 'auto' }} data-times="">
          {times}
        </Typography>
      </Stack>
      {showBanner && (
        // 시작하기 띠(OMAI-1274 §4-5, 5A): 강제 투어 대신 한 줄. 준비 중·에이전트 없음이면 그리지 않는다
        <Alert
          severity="info"
          data-guide-banner=""
          sx={{ mb: 3 }}
          action={
            <Stack direction="row" spacing={1} alignItems="center">
              <Button size="small" variant="outlined" color="inherit" sx={tier1} onClick={() => startGuide('user.first-chat')}>
                {t('guides.banner.start')}
              </Button>
              <Button size="small" color="inherit" onClick={hideBanner}>
                {t('guides.banner.hide')}
              </Button>
            </Stack>
          }
        >
          {t('guides.banner.text')}
        </Alert>
      )}
      {admin && (
        <Box component="section" aria-labelledby="dash-fleet" data-guide="dashboard.fleet" sx={{ mb: 5 }}>
          <SectionHeader index={1} id="dash-fleet" icon={DnsOutlinedIcon} caption={t('dashboard.fleetSection')} />
          {dash.data ? (
            <Fleet data={dash.data} currentPod={pod} onCurrent={toCurrent} />
          ) : dash.isError ? (
            <LoadError error={dash.error} retry={() => void dash.refetch()} />
          ) : (
            <Placeholder height={360} />
          )}
        </Box>
      )}
      <Box component="section" aria-labelledby="dash-current" ref={current} sx={{ scrollMarginTop: 16 }}>
        <SectionHeader index={admin ? 2 : 1} id="dash-current" icon={SmartToyOutlinedIcon} caption={t('dashboard.currentSection', { name: m?.pod ? viewerAgentLabel(m.pod, m.user?.email) : pod || '—' })} />
        {/* 에이전트를 바꾼 직후 새 값을 받는 동안은 옛 값이 새 제목 아래 그대로 보이므로 옅게 한다(2026-10-18) */}
        <Box aria-busy={health.isFetching && !health.isLoading} sx={{ opacity: health.isFetching && !health.isLoading ? 0.5 : 1, transition: 'opacity 150ms' }}>
          {me.isLoading ? <Placeholder height={240} /> : body}
        </Box>
      </Box>
    </Box>
  );
}
