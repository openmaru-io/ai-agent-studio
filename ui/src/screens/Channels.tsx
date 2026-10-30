/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 채널·게이트웨이: 프로파일마다 게이트웨이가 도는지, 텔레그램·버즈 등이 붙어 있는지 본다(읽기 전용).
import AddLinkOutlinedIcon from '@mui/icons-material/AddLinkOutlined';
import { Alert, Box, Button, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { AddAction, AddIconButton } from '@/components/AddIconButton';
import { ChatChip, Issue, IssueList, KV, LinkChip, RowList, ScreenLoading, Section, Tag, useOpenInDrawer } from '@/components/bits';
import { GridColumn, nameColumn, Pill, statusColumn } from '@/components/DataGrid';
import { type PageOf, profilePage } from '@/components/drawerPages';
import { useDrawerHead } from '@/components/drawerScope';
import { ListView, Tone } from '@/components/ListView';
import { useUiOptional } from '@/components/UiContext';
import { useRoutePage } from '@/components/useRoutePage';
import { t } from '@/i18n';
import { get } from '@/lib/api';
import { useCanEditSettings, useEditColumn } from '@/lib/editLink';
import { fmtTs } from '@/lib/format';
import { CH } from '@/lib/labels';
import { MONO_FONT } from '@/lib/monoFont';
interface Platform {
  name: string;
  state?: string;
  stale?: boolean;
  needs_attention?: boolean;
  updated_at?: string;
  error?: string;
}

interface ProfileChannels {
  name: string;
  running: boolean | null;
  service?: { status?: string; disabled?: boolean } | null;
  gateway_state?: string;
  jobs_active: number;
  platforms: Platform[];
  issues: Issue[];
}

interface ChannelsData {
  /** 이 POD 주인의 사람 이름. 프로파일 이름 옆에 누구의 것인지 보인다(2026-10-18-010) */
  owner_name?: string;
  services_known: boolean;
  totals: {
    gateways_up: number;
    profiles: number;
    gateways_down_with_jobs: number;
    channels_connected: number;
    needs_attention: number;
  };
  profiles: ProfileChannels[];
}

const gatewayText = (r: ProfileChannels) =>
  r.running === true
    ? t('channels.gatewayUp')
    : r.running === false
    ? r.service?.disabled
      ? t('channels.gatewayDisabled')
      : t('channels.gatewayDown')
    : t('channels.gatewayUnknown');
const gatewayTone = (r: ProfileChannels): Tone | undefined =>
  r.running === true ? 'good' : r.running === false && r.jobs_active ? 'bad' : undefined;

const gateway = (r: ProfileChannels) =>
  r.running === true ? (
    <Tag tone="good">{t('channels.gatewayUp')}</Tag>
  ) : r.running === false ? (
    <Tag tone={r.jobs_active ? 'bad' : undefined}>{r.service?.disabled ? t('channels.gatewayDisabled') : t('channels.gatewayDown')}</Tag>
  ) : (
    <Tag>{t('channels.gatewayUnknown')}</Tag>
  );

const channelState = (p: Platform): [string, Tone | undefined] =>
  p.stale
    ? [t('channels.stale'), undefined]
    : p.state === 'connected'
    ? p.needs_attention
      ? [t('channels.connectedWarn'), 'warn']
      : [t('channels.connected'), 'good']
    : [p.state || '—', p.state ? 'bad' : undefined];

// 그 프로파일의 채널 탭에서 「메신저 연결」 대화 상자를 열고 시작하는 주소(ChannelPane 의 ?add=1)
const connectHref = (name: string) => '/profiles?' + new URLSearchParams({ name, pane: 'channels', add: '1' }).toString();
/** 서랍 안에서 누르면 같은 서랍에 그 프로파일의 채널 탭을 열고 연결 대화 상자를 띄운다(스펙 2026-10-26-003 2단계) */
const connectPage = (name: string) => profilePage({ name, pane: 'channels', add: '1' });

const channel = (p: Platform) => {
  const [text, tone] = channelState(p);
  return (
    <Tag key={p.name} tone={tone}>
      {`${CH[p.name] || p.name} ${text}`}
    </Tag>
  );
};

// 프로파일 이름 칸: 주인 이름이 있으면 이름 옆에 보인다(2026-10-18-010). 검색은 이름과 주인 이름 둘 다 맞는다
const profileColumn = (owner: string): GridColumn<ProfileChannels> => {
  const base = nameColumn<ProfileChannels>({ label: t('channels.grid.profile'), value: (r) => r.name });
  return {
    ...base,
    value: (r) => (owner ? `${r.name} ${owner}` : r.name), // 검색·정렬용. 기본 이름 셀은 위 value 가 아니라 r.name 으로 그린다
    render: (r) => (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
        <Box sx={{ minWidth: 0, flex: '0 1 auto' }}>{base.render?.(r)}</Box>
        {owner && (
          <Typography component="span" variant="caption" color="text.secondary" noWrap title={t('chat.ownerOf', { name: owner })}>
            {owner}
          </Typography>
        )}
      </Box>
    ),
  };
};

// 공통 표의 열(OMAI-1127). 두 줄 목록의 게이트웨이·채널 태그 → 열, 둘째 줄의 문제 → 확인할 것, 오른쪽 크론 수 → 열
const COLUMNS = (owner = ''): GridColumn<ProfileChannels>[] => [
  profileColumn(owner),
  statusColumn<ProfileChannels>({ id: 'gateway', label: t('channels.gateway'), value: gatewayText, tone: gatewayTone }),
  {
    id: 'platforms',
    label: t('channels.channelsTitle'),
    value: (r) => r.platforms.map((p) => CH[p.name] || p.name).join(' '),
    width: 'minmax(240px, 2fr)', // Pill 두 개가 잘리지 않는 폭
    render: (r) =>
      r.platforms.map((p) => {
        const [text, tone] = channelState(p);
        return <Pill key={p.name} tone={tone}>{`${CH[p.name] || p.name} ${text}`}</Pill>;
      }),
  },
  {
    id: 'issues',
    label: t('channels.review'),
    value: (r) =>
      r.issues.length
        ? r.issues[0].text + (r.issues.length > 1 ? t('channels.moreIssues', { count: r.issues.length - 1 }) : '')
        : t('channels.noIssues'),
    width: 'minmax(200px, 3fr)',
  },
  { id: 'jobs_active', label: t('channels.activeCronLabel'), value: (r) => r.jobs_active, width: '104px', num: true },
];

/** 채널 행 서랍 본문. 고칠 권한이 있으면 채널이 없을 때 「메신저 연결」로 그 프로파일의 채널 탭을 연다 */
function ChannelDetail({ r }: { r: ProfileChannels }) {
  const canEdit = useCanEditSettings();
  const ui = useUiOptional();
  const openHere = useOpenInDrawer();
  return (
    <>
      <KV
        pairs={[
          [t('channels.gateway'), gateway(r)],
          [t('channels.serviceStatus'), r.service ? r.service.status : r.gateway_state || t('channels.unknown')],
          [
            t('channels.activeCronLabel'),
            t('channels.jobsCount', { count: r.jobs_active }) +
              (r.running === false && r.jobs_active ? t('channels.jobsStopped') : ''),
          ],
        ]}
      />
      <Section title={t('channels.review')}>
        <IssueList issues={r.issues} />
      </Section>
      <Section title={t('channels.channelsTitle')} count={r.platforms.length}>
        {r.platforms.length ? (
          <RowList>
            {r.platforms.map((p) => (
              <li key={p.name}>
                {channel(p)}
                {p.updated_at && (
                  <Typography component="span" variant="caption" color="text.secondary">
                    {t('channels.updatedAt', { time: fmtTs(p.updated_at) })}
                  </Typography>
                )}
                {p.error && (
                  <Typography
                    component="pre"
                    variant="caption"
                    sx={{ fontFamily: MONO_FONT, whiteSpace: 'pre-wrap' }}
                  >
                    {p.error}
                  </Typography>
                )}
              </li>
            ))}
          </RowList>
        ) : (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
            <Typography color="text.secondary">{t('channels.noChannels')}</Typography>
            {/* 채널이 없으면 그 프로파일의 채널 탭에서 「메신저 연결」 대화 상자를 열어 보낸다. 고칠 권한이 있을 때만 */}
            {canEdit && (
              <Button
                size="small"
                variant="outlined"
                startIcon={<AddLinkOutlinedIcon />}
                component={Link}
                to={connectHref(r.name)}
                onClick={(e: MouseEvent) => openHere(e, connectPage(r.name)) || ui?.dismissTransient()}
              >
                {t('channels.connectMessenger')}
              </Button>
            )}
          </Box>
        )}
      </Section>
      <Section title={t('channels.seeNext')}>
        <LinkChip to="profiles" params={{ name: r.name }} page>{t('channels.profileSettings', { name: r.name })}</LinkChip>
        <LinkChip to="profiles" params={{ name: r.name, pane: 'channels' }} page>{t('channels.connect', { name: r.name })}</LinkChip>
        <LinkChip to="cron" params={{ tab: 'profiles', q: r.name }}>{t('channels.profileCron', { name: r.name })}</LinkChip>
        <LinkChip to="credentials" params={{ tab: 'all', profile: r.name }}>{t('channels.profileCredentials', { name: r.name })}</LinkChip>
        <ChatChip agent={r.name}>{t('channels.profileChat', { name: r.name })}</ChatChip>
      </Section>
    </>
  );
}

/** 채널 행 서랍(스펙 2026-10-28-014 D8). 행 클릭·주소 ?open=<프로파일> 이 이 페이지로 연다. 목록과 같은 조회를 스스로 읽는다 */
export function ChannelPage({ page }: { page: PageOf<'channel'> }) {
  const q = useQuery<ChannelsData>({ queryKey: ['channels'], queryFn: () => get<ChannelsData>('/api/channels') });
  const r = q.data?.profiles.find((x) => x.name === page.name);
  useDrawerHead(r ? { title: r.name, sub: t('channels.profileGatewayChannels') } : null);
  if (!r) return q.data ? <Alert severity="warning">{t('channels.notFound', { id: page.name })}</Alert> : <ScreenLoading title={page.name} error={q.error?.message} />;
  return <ChannelDetail r={r} />;
}

export function Channels() {
  const q = useQuery<ChannelsData>({ queryKey: ['channels'], queryFn: () => get<ChannelsData>('/api/channels') });
  // 「편집」 열: 그 프로파일의 채널 탭(스펙 ui/ops-edit-links.md, OMAI-1210). 권한이 없으면 열이 없다
  const canEdit = useCanEditSettings();
  const ui = useUiOptional();
  const openHere = useOpenInDrawer();
  const navigate = useNavigate();
  const editCol = useEditColumn<ProfileChannels>((r) => ({ to: 'profiles', params: { name: r.name, pane: 'channels' } }), (r) => r.name);
  // 행 서랍은 주소 ?open=<프로파일>(+pod)과 묶인다(스펙 2026-10-28-014 D8). 이 위에서 연 「메신저 연결」 고르기 서랍은 쌓인다(D13)
  const route = useRoutePage('channels');
  const title = t('channels.title');
  const d = q.data;
  if (!d) return <ScreenLoading title={title} error={q.error?.message} />;

  const tot = d.totals;
  const bad = d.profiles.filter((r) => r.issues.length);
  const warning = d.services_known
    ? ''
    : t('channels.servicesUnknown');
  // 제목 옆 + 아이콘과 표 위 글자 단추: 예약 작업 화면과 같은 자리. 프로파일이 하나면 바로 그 채널 탭으로,
  // 여럿이면 서랍에서 프로파일을 고른다. 행 서랍의 「메신저 연결하기」와 같이 고칠 권한이 있을 때만 보인다
  const add: AddAction | null =
    canEdit && d.profiles.length
      ? {
          label: t('channels.connectMessenger'),
          onClick: () => {
            if (d.profiles.length === 1 || !ui) {
              navigate(connectHref(d.profiles[0].name));
              return;
            }
            ui.openDrawer({
              title: t('channels.pickProfileTitle'),
              sub: t('channels.pickProfileSub'),
              body: (
                <RowList>
                  {d.profiles.map((r) => (
                    <li key={r.name}>
                      <Button size="small" variant="outlined" startIcon={<AddLinkOutlinedIcon />} component={Link} to={connectHref(r.name)} onClick={(e: MouseEvent) => openHere(e, connectPage(r.name)) || ui.dismissTransient()}>
                        {r.name}
                      </Button>
                      <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1.5 }}>
                        {r.platforms.length ? r.platforms.map((p) => CH[p.name] || p.name).join(', ') : t('channels.noChannels')}
                      </Typography>
                    </li>
                  ))}
                </RowList>
              ),
            });
          },
        }
      : null;

  return (
    <ListView<ProfileChannels>
      guide="channels.list"
      title={title}
      titleAction={add ? <AddIconButton {...add} /> : undefined}
      gridAction={add}
      sub={t('channels.sub')}
      error={warning || null}
      // 보기 카드(2026-10-17-011): 카드 숫자는 그 보기의 행 수다. 실행 중 게이트웨이 수와 「중지됐는데 작업이 있는」 수는 둘째 줄 지표로 옮겼다(§4-1)
      cards={[
        { n: tot.channels_connected, label: t('channels.connectedChannels'), sub: t('channels.connectedChannelsSub') },
        {
          n: tot.needs_attention,
          label: t('channels.needsAttention'),
          sub: t('channels.needsAttentionSub'),
          tone: tot.needs_attention ? 'warn' : 'good',
        },
      ]}
      tabs={[
        { id: 'all', label: t('channels.all'), items: d.profiles, card: { sub: t('channels.cardAllSub', { up: tot.gateways_up, total: tot.profiles }) } },
        {
          id: 'issue',
          label: t('channels.review'),
          tone: 'bad',
          items: bad,
          empty: t('channels.reviewEmpty'),
          card: { sub: t('channels.cardReviewSub', { n: tot.gateways_down_with_jobs }) },
        },
      ]}
      text={(r) => [r.name, r.platforms.map((p) => p.name).join(' '), r.issues.map((i) => i.text).join(' ')].join(' ')}
      id="channels"
      columns={[...COLUMNS(d.owner_name), ...editCol]}
      rowId={(r) => r.name}
      onRefresh={() => void q.refetch()}
      isFetching={q.isFetching}
      openId={route.open}
      clearOnTab={route.clearOnTab}
      onRow={(r) => route.openRow(r.name)}
    />
  );
}
