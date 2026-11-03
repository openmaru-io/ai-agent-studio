/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 프로파일: 한 에이전트의 모델·성격·채널·스킬·도구·크론을 한곳에서 보고 관리한다. 목록과 상세(?name=)를 한 주소에서 나눈다.
import AddIcon from '@mui/icons-material/Add';
import NotificationsNoneOutlinedIcon from '@mui/icons-material/NotificationsNoneOutlined';
import SwapHorizRoundedIcon from '@mui/icons-material/SwapHorizRounded';
import type { Theme } from '@mui/material';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  Stack,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
} from '@mui/material';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { AddIconButton } from '@/components/AddIconButton';
import { AgentChip, AgentDot } from '@/components/AgentChip';
import { AgentPicker } from '@/components/AgentPicker';
import { actionable, issueOrder, ScreenLoading } from '@/components/bits';
import { ageColumn, GridColumn, Pill, profileNameColumn, statusColumn } from '@/components/DataGrid';
import { type PageOf, profilePage } from '@/components/drawerPages';
import { useDrawerGuard, useDrawerHead, useDrawerPage } from '@/components/drawerScope';
import { ListView } from '@/components/ListView';
import { useUi } from '@/components/UiContext';
import { useOpenParam, useParamPatch, useRouteDrawer } from '@/components/useRouteDrawer';
import { InboxPanel } from '@/features/office/InboxPanel';
import { useInbox } from '@/features/office/useInbox';
import { RequestAdminButton } from '@/features/requests/RequestAdminButton';
import { t } from '@/i18n';
import { agentLabel, agentProfileLabel } from '@/lib/agentLabel';
import { get, post } from '@/lib/api';
import { useMe } from '@/lib/data';
import { useFocusOnMount } from '@/lib/useFocusOnMount';

import { AgentAnnouncer, useAgentList, useMakeChatDefault, useSwitchToSameName } from './profiles/AgentScope';
import { ProfileDetail } from './profiles/Detail';
import { DoNotUsePill } from './profiles/DoNotUse';
import { channelText, channelTone, gatewayText, gatewayTone, modelLabel } from './profiles/shared';
import type { ProfileSpot } from './profiles/spot';
import type { ProfileRow } from './profiles/types';

/** 모은 목록(/api/profiles?all=1)의 에이전트 묶음(스펙 2026-10-19-018 A1·리뷰 D3). 프로파일이 0개인 에이전트·멈춘 에이전트도 묶음으로 온다 */
export interface ProfileGroup {
  pod: string;
  name?: string;
  owner_name?: string;
  current?: boolean;
  shared?: boolean;
  state: 'ok' | 'error' | 'stopped' | 'starting';
  error?: string;
  can_create?: boolean;
  profile_limit?: { used: number; max: number };
  primary?: string;
  chat_default?: string;
  owner?: boolean;
  count?: number;
}
type AllRow = ProfileRow & { pod: string; pod_name?: string; pod_owner_name?: string };
interface AllList {
  profiles: AllRow[];
  groups: ProfileGroup[];
  can_edit: boolean;
  default_model?: string;
}
/** 옛 모양(에이전트 하나: 위쪽 primary·chat_default·profile_limit)도 받는다 — 묶음 하나로 바꾼다 */
type RawList = Partial<AllList> & {
  profiles: ProfileRow[];
  can_edit: boolean;
  can_create?: boolean;
  primary?: string;
  chat_default?: string;
  profile_limit?: { used: number; max: number };
  owner?: boolean;
  owner_name?: string;
};

/** 응답 없는(error) 작업공간 묶음이 있으면 이 간격으로 다시 읽는다(스펙 2026-11-02-003). 서버 재기동 직후 첫 읽기(사이드카 묶음 받기)가
 *  10초를 넘겨 「응답 없음」이 와도, 서버가 뒤에서 읽기를 끝내면 다음 읽기에서 정상이 된다(2026-11-02-002). 멈춘·뜨는 중은 다시 읽지 않는다 */
export function profilesRetryMs(data: RawList | undefined): number | false {
  return data?.groups?.some((g) => g.state === 'error') ? 5000 : false;
}

function normalize(raw: RawList, pod: string, podName: string | undefined, fallbackPrimary: string | undefined): AllList {
  if (raw.groups) return raw as AllList;
  const group: ProfileGroup = {
    pod,
    name: podName,
    current: true,
    state: 'ok',
    can_create: raw.can_edit || raw.can_create,
    profile_limit: raw.profile_limit,
    primary: raw.primary ?? fallbackPrimary,
    chat_default: raw.chat_default,
    owner: raw.owner,
    owner_name: raw.owner_name,
    count: raw.profiles.length,
  };
  return { profiles: raw.profiles.map((r) => ({ ...r, pod })), groups: [group], can_edit: raw.can_edit, default_model: raw.default_model };
}

/** 묶음의 화면 글자: 내 것은 이름, 나눠 받은 것은 「주인 · 에이전트」(스펙 2026-10-19-003) */
const groupLabel = (g: ProfileGroup) => agentLabel({ id: g.pod, name: g.name, owner_name: g.shared ? g.owner_name : '' });
const isFull = (g?: ProfileGroup) => !!g?.profile_limit && g.profile_limit.used >= g.profile_limit.max;
/** 만들 수 있는 묶음(만들 권한이 있고 읽힌 것) */
const creatable = (groups: ProfileGroup[]) => groups.filter((g) => g.can_create && g.state === 'ok');

/** 새 프로파일 서랍. 맨 위에서 만들 에이전트를 고르고(스펙 2026-10-19-018 B1), 아래 칸(복제 원본·상한·가져오기 후보)은 고른 에이전트 기준이다(B2·리뷰 I6·I7).
 *  owner: 관리자가 아닌 주인 — 주 프로파일 복제만, 스킬 포함, 에이전트마다 상한(스펙 2026-10-15-011 D5) */
function CreateBody({ groups, rows, current, owner, initial }: { groups: ProfileGroup[]; rows: AllRow[]; current: string; owner?: boolean; initial?: string }) {
  const { closeDrawer } = useUi();
  const { enqueueSnackbar } = useSnackbar();
  const patchParams = useParamPatch();
  const go = useSwitchToSameName();
  const choices0 = creatable(groups);
  // 기본은 지금 에이전트. 지금 에이전트에 만들 수 없거나 가득 찼으면 만들 수 있는 첫 묶음(리뷰 I9)
  const fallback = choices0.find((g) => g.pod === current && !isFull(g)) ?? choices0.find((g) => !isFull(g)) ?? choices0[0];
  const [target, setTarget] = useState(initial ?? fallback?.pod ?? current);
  const g = groups.find((x) => x.pod === target);
  const primary = g?.primary;
  const limit = g?.profile_limit;
  // 숨긴 루트(default)는 복제 원본으로도 고르지 않는다(사용자 2026-10-19, 목록에서 빼는 결정과 같이)
  const names = rows.filter((r) => r.pod === target && !r.hidden_root).map((r) => r.name);
  const [name, setName] = useState('');
  const [from, setFrom] = useState('');
  const [noSkills, setNoSkills] = useState(false);
  const [share, setShare] = useState(false);
  const [imported, setImported] = useState(''); // '<파드>|<프로파일>' 또는 ''(가져오지 않음, 스펙 2026-10-15-011 단계 4)
  const [reset, setReset] = useState(false);
  const sources = useQuery<{ sources: { pod: string; profiles: string[]; name?: string; owner_name?: string }[] }>({
    // 고른 에이전트를 빼고 지금 에이전트는 넣는다 — 만드는 곳에서는 가져오지 않는다(리뷰 I6)
    queryKey: ['profiles-importable', target],
    queryFn: () => get(target ? `/api/profiles/importable?target=${encodeURIComponent(target)}` : '/api/profiles/importable'),
    retry: false,
  });
  // 「주인 이름 · 에이전트 이름 › 프로파일」. id 는 이름이 없을 때만 보인다(스펙 2026-10-19-003)
  const choices = (sources.data?.sources ?? []).flatMap((s) =>
    s.profiles.map((p) => ({ key: `${s.pod}|${p}`, label: agentProfileLabel({ id: s.pod, name: s.name, owner_name: s.owner_name }, p) }))
  );
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const first = useFocusOnMount<HTMLInputElement>();
  const full = isFull(g);
  const label = g ? groupLabel(g) : '';
  // 에이전트를 바꾸면 앞 에이전트 기준으로 고른 값을 비운다 — 남으면 서버가 거절했다(디자인 DD7)
  const pick = (pod: string) => {
    if (pod === target || !pod) return;
    setTarget(pod);
    setFrom('');
    setImported('');
    setShare(false);
    setNoSkills(false);
    setReset(true);
  };
  const create = async () => {
    setBusy(true);
    try {
      const [impPod, impProfile] = imported.split('|');
      const r = await post<{ name: string; share_error?: string; copy_error?: string; import_error?: string }>('/api/profile/action', {
        name: name.trim(),
        action: 'create',
        clone_from: owner ? primary ?? '' : from,
        no_skills: owner ? false : noSkills && !share && !imported,
        share_skills: !imported && share && (owner || !!from),
        ...(imported ? { import_from: { pod: impPod, profile: impProfile } } : {}),
        description,
        // 지금 에이전트를 골라도 보낸다 — 만드는 사이 다른 탭에서 에이전트를 바꿔도 고른 곳에 만든다(리뷰 I8)
        ...(target ? { target_pod: target } : {}),
      });
      closeDrawer();
      enqueueSnackbar(t('profiles.created', { name: r.name }), { variant: 'success' });
      if (r.share_error) enqueueSnackbar(t('profiles.shareFailed', { error: r.share_error }), { variant: 'warning' });
      if (r.copy_error) enqueueSnackbar(t('profiles.copyFailed', { error: r.copy_error }), { variant: 'warning' });
      if (r.import_error) enqueueSnackbar(t('profiles.importFailed', { error: r.import_error }), { variant: 'warning' });
      const here = groups.find((x) => x.pod === current);
      // 다른 에이전트에 만들었으면 그 에이전트로 바꾼 뒤 서랍을 연다(B4). 순서는 바꾸기 → 내 정보 → 서랍(디자인 DD6)
      if (target && current && target !== current) await go({ pod: target, label }, here ? { pod: current, label: groupLabel(here) } : undefined, { open: r.name });
      else patchParams({ name: r.name, pane: null });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Stack spacing={1.5}>
      {choices0.length > 1 ? (
        <Box>
          <AgentPicker
            label={t('profiles.createTarget')}
            value={target}
            onChange={pick}
            options={choices0.map((x) => ({
              value: x.pod,
              label: groupLabel(x),
              disabledReason: isFull(x) && x.profile_limit ? t('profiles.targetFull', x.profile_limit) : undefined,
            }))}
          />
          {reset && (
            <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.5 }}>
              {t('profiles.targetChanged')}
            </Typography>
          )}
        </Box>
      ) : (
        g?.pod && (
          // 고를 곳이 하나뿐이면 고르개 대신 읽기 전용 줄(디자인 DD7)
          <Typography variant="body2" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }} data-create-where="">
            <Box component="span" sx={{ color: 'text.secondary' }}>
              {t('profiles.createWhere')}
            </Box>
            <AgentDot name={g.pod} />
            <span>{label}</span>
          </Typography>
        )
      )}
      <TextField
        size="small"
        inputRef={first}
        label={t('profiles.nameLabel')}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t('profiles.namePlaceholder')}
        slotProps={{ htmlInput: { spellCheck: false } }}
      />
      {owner ? (
        <>
          <Typography variant="body2">{t('profiles.cloneMainOnly', { name: primary ?? '' })}</Typography>
          <FormControlLabel
            control={<Checkbox checked={share} onChange={(e) => setShare(e.target.checked)} />}
            label={t('profiles.shareSkills', { name: primary ?? '' })}
          />
          {share && <Typography variant="caption" color="text.secondary">{t('profiles.shareSkillsNote')}</Typography>}
        </>
      ) : (
        <>
          <AgentPicker
            label={t('profiles.startFromLabel')}
            value={from}
            onChange={setFrom}
            options={names.map((n) => ({ value: n, label: t('profiles.cloneOf', { name: n }) }))}
            emptyLabel={t('profiles.startEmpty')}
          />
          <FormControlLabel
            control={<Checkbox checked={noSkills && !share} disabled={share} onChange={(e) => setNoSkills(e.target.checked)} />}
            label={t('profiles.noSkills')}
          />
          {from && (
            <FormControlLabel
              control={<Checkbox checked={share} onChange={(e) => setShare(e.target.checked)} />}
              label={t('profiles.shareSkills', { name: from })}
            />
          )}
          {from && share && <Typography variant="caption" color="text.secondary">{t('profiles.shareSkillsNote')}</Typography>}
        </>
      )}
      {choices.length > 0 && (
        <>
          <AgentPicker
            label={t('profiles.importLabel')}
            value={imported}
            onChange={setImported}
            options={choices.map((c) => ({ value: c.key, label: t('profiles.importFrom', { name: c.label }) }))}
            emptyLabel={t('profiles.importNone')}
          />
          {imported && <Typography variant="caption" color="text.secondary">{t('profiles.importNote')}</Typography>}
        </>
      )}
      {limit && (
        <>
          <Typography variant="body2" color="text.secondary">
            {full ? t('profiles.limitFull', { max: limit.max }) : t('profiles.limitUsed', { used: limit.used, max: limit.max })}
          </Typography>
          {full && primary && <RequestAdminButton profile={primary} kind="profile_limit" label={t('requests.askLimit')} />}
        </>
      )}
      <TextField
        size="small"
        label={t('profiles.about')}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder={t('profiles.aboutPlaceholder')}
      />
      {error && <Alert severity="error">{error}</Alert>}
      <Box>
        <Button startIcon={<AddIcon />} variant="contained" disabled={busy || full} onClick={create}>
          {!label || !choices0.length ? t('profiles.create') : t('profiles.createIn', { agent: label })}
        </Button>
      </Box>
      <Typography variant="caption" color="text.secondary">
        {t('profiles.createNoteSecrets')}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {t('profiles.createNotePort')}
      </Typography>
    </Stack>
  );
}

const titleOf = (r: ProfileRow) => (r.title && r.title.toLowerCase() !== r.name ? `${r.title} (${r.name})` : r.name);
// 안내(스킬 새 버전 등)는 고칠 것 뒤에 쓴다(스펙 2026-10-24-003 D13)
const reviewText = (r: ProfileRow) =>
  r.issues.length
    ? issueOrder(r.issues)[0].text + (r.issues.length > 1 ? ' ' + t('profiles.issuesMore', { n: r.issues.length - 1 }) : '')
    : r.description || t('profiles.noAbout');

// 공통 표의 열(OMAI-1127). 두 줄 목록의 게이트웨이·채널 태그 → 열, 둘째 줄(문제 또는 소개) → 확인할 것 · 소개,
// 오른쪽 모델·개수 → 열. 「기본」과 문제 수준 태그는 확인할 것 칸 앞에 둔다.
// 뱃지 값(주 프로파일·채팅 기본·전용)은 에이전트마다 다르므로 줄의 pod 로 묶음을 찾아 그린다(스펙 2026-10-19-018 리뷰 I10).
// 채팅 기본은 모은 목록에서 늘 붙인다 — 에이전트가 섞이면 「어느 에이전트의 기본인가」가 정보다(리뷰 D5. 예전 001 디자인 D12 는 「프로파일 2개 이상일 때만」)
interface ColumnCtx {
  defaultModel?: string;
  groupOf: (pod: string) => ProfileGroup | undefined;
  current: string;
  /** 「에이전트」 칸을 그리는가(에이전트를 아는 구성). 좁은 화면에서는 칸 대신 첫 칸에 둔다(디자인 DD10) */
  agentColumn: boolean;
  narrow: boolean;
}
const ownerTagOf = (g?: ProfileGroup) => (g?.owner ? t('profiles.mineTag') : g?.owner_name ? t('profiles.ownedByTag', { name: g.owner_name }) : undefined);

function AgentCell({ g, current }: { g?: ProfileGroup; current: string }) {
  if (!g) return null;
  const here = g.pod === current;
  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, minWidth: 0 }} title={g.pod}>
      <AgentChip name={groupLabel(g)} colorKey={g.pod} size="sm" />
      {here ? <Pill>{t('profiles.currentTag')}</Pill> : <SwapHorizRoundedIcon aria-hidden sx={{ fontSize: 14, color: 'text.secondary' }} />}
    </Box>
  );
}

const COLUMNS = ({ defaultModel, groupOf, current, agentColumn, narrow }: ColumnCtx): GridColumn<AllRow>[] => [
  (() => {
    const base = profileNameColumn<AllRow>({ label: t('profiles.grid.profile'), value: titleOf, colorKey: (r) => r.name });
    // 숨겨진 루트는 이름 바로 옆에 「사용 금지」 표식을 더한다(OMAI-1268)
    return {
      ...base,
      // 모은 목록은 뱃지가 늘어(채팅 기본이 에이전트마다 붙음) 200px 에서 뒤 뱃지가 잘렸다 — 넓은 화면에서는 칸을 넓힌다
      ...(agentColumn && !narrow ? { width: 'minmax(320px, 2fr)' } : {}),
      render: (r: AllRow) => {
        const g = groupOf(r.pod);
        const owner = ownerTagOf(g);
        const shown = !r.hidden_root;
        const pills = [
          // 가져오는 중(OMAI-1444 DD4): 잠깐 있는 상태라 좁은 화면에서도 보이게 맨 앞, 무채색
          r.importing && <Pill key="importing">{t('profiles.pcImport.stepRunning')}</Pill>,
          shown && g?.primary === r.name && (
            <Tooltip key="primary" title={t('profiles.defaultTip')}>
              <span>
                <Pill>{t('profiles.primaryTag')}</Pill>
              </span>
            </Tooltip>
          ),
          shown && g?.chat_default === r.name && (
            <Tooltip key="chat" title={t('profiles.chatDefaultTip')}>
              <span>
                <Pill>{t('profiles.chatDefaultTag')}</Pill>
              </span>
            </Tooltip>
          ),
          // 누구 전용 에이전트인가(2026-10-17-016). 상세 서랍 머리의 태그와 같은 글
          shown && owner && <Pill key="owner">{owner}</Pill>,
          r.is_default && shown && (
            <Tooltip key="root" title={t('profiles.rootTip')}>
              <span>
                <Pill>{t('profiles.default')}</Pill>
              </span>
            </Tooltip>
          ),
        ].filter(Boolean);
        // 좁은 화면: 주 프로파일·채팅 기본만 보이고 나머지는 「+N」(디자인 DD10)
        const visible = narrow ? pills.slice(0, 2) : pills;
        return (
          <>
            {/* 이름은 줄이지 않는다. 뱃지가 늘어 칸(200px)을 넘으면 이름이 폭 0 으로 사라졌다(OKE 2026-10-19, 주 프로파일 뱃지를 더한 뒤) — 넘치는 쪽은 뒤의 뱃지다 */}
            <Box component="span" sx={{ flexShrink: 0, display: 'inline-flex' }}>
              {base.render?.(r)}
            </Box>
            {r.hidden_root && <DoNotUsePill />}
            {/* 좁은 화면: 「에이전트」 칸 대신 이름 바로 뒤에 에이전트(디자인 DD10). 뱃지보다 앞에 둬야 칸(200px) 안에서 잘리지 않는다 */}
            {narrow && agentColumn && g && (
              <Box component="span" data-agent-inline="" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, fontSize: 12, color: 'text.secondary', flexShrink: 0 }}>
                <AgentDot name={g.pod} />
                {groupLabel(g)}
                {g.pod === current && ` · ${t('profiles.currentTag')}`}
              </Box>
            )}
            {/* 뱃지 순서: (가져오는 중) → 주 프로파일 → 채팅 기본 → 내 전용 → 루트, 모두 무채색(2026-10-19-001 디자인 D10·D12) */}
            {visible}
            {narrow && pills.length > visible.length && <Pill>{`+${pills.length - visible.length}`}</Pill>}
          </>
        );
      },
    };
  })(),
  ...(agentColumn && !narrow
    ? [
        {
          id: 'agent',
          label: t('profiles.grid.agent'),
          value: (r: AllRow) => (groupOf(r.pod) ? groupLabel(groupOf(r.pod) as ProfileGroup) : r.pod),
          width: 'minmax(220px, 1.2fr)',
          render: (r: AllRow) => <AgentCell g={groupOf(r.pod)} current={current} />,
        } as GridColumn<AllRow>,
      ]
    : []),
  statusColumn<AllRow>({ id: 'gateway', label: t('profiles.grid.gateway'), value: (r) => gatewayText(r, true), tone: gatewayTone }),
  {
    id: 'channels',
    label: t('profiles.grid.channels'),
    value: (r) => r.channels.map(channelText).join(' '),
    width: 'minmax(240px, 2fr)', // Pill 두 개(「텔레그램 연결됨」 등)가 잘리지 않는 폭
    render: (r) =>
      r.channels.map((c) => (
        <Pill key={c.name} tone={channelTone(c)}>
          {channelText(c)}
        </Pill>
      )),
  },
  {
    id: 'issues',
    label: t('profiles.grid.review'),
    value: reviewText,
    width: 'minmax(200px, 3fr)',
    render: (r) => (
      <>
        {r.hidden_root && <Pill tone="warn">{t('profiles.hiddenRoot')}</Pill>}
        {r.issues.some((i) => i.level === 'bad') ? (
          <Pill tone="bad">{t('profiles.levelBad')}</Pill>
        ) : actionable(r.issues).length ? (
          <Pill tone="warn">{t('profiles.levelWarn')}</Pill>
        ) : null}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{reviewText(r)}</span>
      </>
    ),
  },
  { id: 'model', label: t('profiles.grid.model'), value: (r) => modelLabel(r.model, defaultModel) || t('profiles.noModel'), width: 'minmax(120px, 1fr)' },
  { id: 'jobs_active', label: t('profiles.grid.cron'), value: (r) => r.jobs_active, width: '88px', num: true },
  { id: 'skills', label: t('profiles.grid.skills'), value: (r) => r.skills, width: '72px', num: true },
  ageColumn<AllRow>({ id: 'last_activity', label: t('profiles.grid.lastActivity'), value: (r) => r.last_activity }),
];

/** 줄이 없는 묶음(응답 없음·멈춤·준비 중·프로파일 0개)을 상태별 한 줄과 동작으로(디자인 DD3) */
function GroupNotes({ groups, onRetry, onCreate }: { groups: ProfileGroup[]; onRetry: () => void; onCreate?: (pod: string) => void }) {
  const names = (xs: ProfileGroup[]) => xs.map(groupLabel).join(', ');
  const failed = groups.filter((g) => g.state === 'error');
  const offline = groups.filter((g) => g.state === 'stopped' || g.state === 'starting');
  const empty = groups.filter((g) => g.state === 'ok' && g.count === 0);
  return (
    <Stack spacing={0.5} data-group-notes="">
      {failed.length > 0 && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }} title={failed.map((g) => g.error).join('\n')}>
          <span>{t('profiles.groupsError', { names: names(failed) })}</span>
          <Button size="small" onClick={onRetry}>
            {t('profiles.groupsRetry')}
          </Button>
        </Box>
      )}
      {offline.length > 0 && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <span>{t('profiles.groupsOffline', { names: names(offline) })}</span>
          <Button size="small" component={Link} to="/agents">
            {t('profiles.groupsGoAgents')}
          </Button>
        </Box>
      )}
      {empty.length > 0 && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <span>{t('profiles.groupsEmpty', { names: names(empty) })}</span>
          {onCreate && empty.some((g) => g.can_create) && (
            <Button size="small" onClick={() => onCreate((empty.find((g) => g.can_create) as ProfileGroup).pod)}>
              {t('profiles.groupsCreateHere')}
            </Button>
          )}
        </Box>
      )}
    </Stack>
  );
}

function ProfileList() {
  // 행을 눌러 여는 서랍은 기록을 한 칸 쌓고, 닫으면 그 칸을 되감는다(스펙 2026-10-28-014 D9)
  const openName = useOpenParam('name');
  const { openDrawer } = useUi();
  const [params] = useSearchParams();
  const me = useMe().data;
  const current = me?.pod?.id ?? '';
  const narrow = useMediaQuery((th: Theme) => th.breakpoints.down('sm'));
  const go = useSwitchToSameName();
  const chat = useMakeChatDefault();
  const agents = useAgentList();
  // 내 에이전트 전체(스펙 2026-10-19-018 A1). 다시 읽는 동안 이전 줄을 그대로 둔다(디자인 DD4)
  const q = useQuery<RawList>({
    queryKey: ['profiles', 'all'],
    queryFn: () => get('/api/profiles?all=1'),
    placeholderData: keepPreviousData,
    refetchInterval: (query) => profilesRetryMs(query.state.data),
  });
  // 「지금 에이전트 먼저」의 기준은 화면에 들어올 때의 에이전트로 고정한다 — 줄을 눌러 바꾼 뒤 다시 정렬하면 서랍 뒤에서 표가 뒤섞였다(디자인 DD4)
  const anchor = useRef('');
  if (!anchor.current && current) anchor.current = current;
  if (!q.data) return <ScreenLoading title={t('profiles.title')} error={q.error?.message} />;
  const d = normalize(q.data, current, me?.pod?.name, me?.primary?.profile);
  const groupOf = (pod: string) => d.groups.find((g) => g.pod === pod);
  const first = anchor.current || current;
  const order = [
    ...d.groups.filter((g) => g.pod === first),
    ...d.groups.filter((g) => g.pod !== first).sort((a, b) => groupLabel(a).localeCompare(groupLabel(b), 'ko')),
  ];
  // 에이전트 순서대로, 그 안에서 주 프로파일(main)을 맨 위에(O8). 사용자가 열을 눌러 정렬하면 그 정렬이 이긴다
  const rows = order.flatMap((g) => {
    const mine = d.profiles.filter((r) => r.pod === g.pod);
    return [...mine.filter((r) => r.name === g.primary), ...mine.filter((r) => r.name !== g.primary)];
  });
  const here = groupOf(current) ?? d.groups[0];
  const canAdd = creatable(d.groups);
  // (+) 는 만들 수 있고 가득 차지 않은 묶음이 하나라도 있으면 켠다(리뷰 I9). 상한 안내는 지금 에이전트 기준
  const atLimit = canAdd.length > 0 && canAdd.every(isFull);
  const limit = here?.profile_limit;
  const bad = rows.filter((r) => actionable(r.issues).length);     // 안내만 있는 줄은 「확인할 것」 탭에 넣지 않는다(D13)
  const sum = (f: (r: ProfileRow) => number) => rows.reduce((a, r) => a + f(r), 0);
  const agentColumn = d.groups.some((g) => !!g.pod);
  const withRows = d.groups.filter((g) => rows.some((r) => r.pod === g.pod)).length;
  const other = (r: AllRow) => !!r.pod && !!current && r.pod !== current;
  const labelOf = (r: AllRow) => (groupOf(r.pod) ? groupLabel(groupOf(r.pod) as ProfileGroup) : r.pod);
  const agentKnown = (pod: string) => !!agents?.some((a) => a.name === pod);
  const openCreate = (initial?: string) =>
    openDrawer({
      title: t('profiles.newProfile'),
      sub: t('profiles.newProfileSub'),
      body: <CreateBody groups={d.groups} rows={rows} current={current} owner={!d.can_edit} initial={initial} />,
    });
  const open = (r: AllRow) => {
    if (!other(r)) return openName({ name: r.name, pane: null });
    // 다른 에이전트의 줄: 그 에이전트로 바꾼 뒤 서랍을 연다(A3). 서랍 안 쓰기는 쿠키의 에이전트로 가기 때문이다(2026-10-19-011 R1)
    const h = groupOf(current);
    void go({ pod: r.pod, label: labelOf(r) }, h ? { pod: current, label: groupLabel(h) } : undefined, { open: r.name });
  };
  const notes = d.groups.some((g) => g.state !== 'ok' || g.count === 0);

  return (
    <ListView<AllRow>
      guide="profiles.list"
      title={t('profiles.title')}
      // 어느 에이전트의 프로파일인가. 에이전트가 하나면 지금 문구(2026-10-19-001 R4), 이름이 없는 구성(compose)은 처음 문구
      sub={
        withRows > 1
          ? t('profiles.listSubAll', { agents: withRows, n: rows.length })
          : here?.name
          ? t('profiles.listSubAgent', { agent: here.name, n: rows.length })
          : t('profiles.listSub', { n: rows.length })
      }
      error={q.error?.message}
      banner={notes ? { severity: 'info', message: <GroupNotes groups={d.groups} onRetry={() => void q.refetch()} onCreate={canAdd.length ? openCreate : undefined} /> } : null}
      // 보기 카드(탭)가 앞, 숫자만 카드는 뒤(2026-10-17-011)
      cards={[
        {
          n: sum((r) => r.jobs_active),
          label: t('profiles.cardActiveCron'),
          sub: t('profiles.cardActiveCronSub', { n: sum((r) => r.failed_jobs) }),
        },
        {
          n: rows.filter((r) => !r.sessions_7d).length,
          label: t('profiles.cardIdle'),
          sub: t('profiles.cardIdleSub'),
        },
      ]}
      tabs={[
        // 전체가 첫 탭, 확인할 것은 그다음. 확인할 것으로 바로 가는 카드·링크는 tab 을 적는다
        {
          id: 'all',
          label: t('profiles.tabAll'),
          items: rows,
          card: { sub: t('profiles.cardGatewayRunning', { n: rows.filter((r) => r.running).length }) },
        },
        {
          id: 'issue',
          label: t('profiles.issuesTitle'),
          tone: 'warn',
          items: bad,
          empty: t('profiles.issuesEmpty'),
          card: { sub: t('profiles.cardIssuesSub') },
        },
      ]}
      // 에이전트로 거르기는 기존 고르기 칸(디자인 DD1). 주소 열쇠는 name 과 겹치지 않게 agent
      filters={agentColumn ? [{ key: 'agent', label: t('profiles.grid.agent'), get: labelOf }] : []}
      titleAction={
        canAdd.length ? (
          <AddIconButton label={t('profiles.newProfile')} disabled={atLimit} describedBy={atLimit ? 'profile-limit-why' : undefined} onClick={() => openCreate()} />
        ) : undefined
      }
      gridAction={
        canAdd.length
          ? { label: t('profiles.newProfile'), disabled: atLimit, describedBy: atLimit ? 'profile-limit-why' : undefined, onClick: () => openCreate() }
          : null
      }
      toolbar={
        canAdd.length ? (
          <Stack direction="row" spacing={1.5} alignItems="center" useFlexGap flexWrap="wrap">
            {limit && (
              <Typography variant="caption" color="text.secondary">
                {t('profiles.limitUsed', limit)}
              </Typography>
            )}
            {atLimit && here?.primary && <RequestAdminButton profile={here.primary} kind="profile_limit" label={t('requests.askLimit')} />}
            {atLimit && limit && (
              <Typography id="profile-limit-why" variant="caption" color="text.secondary">
                {t('profiles.limitFull', { max: limit.max })}
              </Typography>
            )}
          </Stack>
        ) : undefined
      }
      text={(r) =>
        [r.name, r.title, r.description, r.model, r.channels.map((c) => c.name).join(' '), r.mcp.join(' '), r.pod_name].join(' ')
      }
      onRow={open}
      // 다른 에이전트의 줄은 누르면 에이전트가 바뀐다 — 메뉴 이름·줄 이름·보조 설명에 미리 알린다(디자인 DD11)
      openLabel={(r) => (other(r) ? t('profiles.openSwitch', { agent: labelOf(r) }) : t('common.grid.openDetail'))}
      rowName={(r) => (agentColumn ? t('profiles.rowNameIn', { agent: labelOf(r), name: titleOf(r) }) : titleOf(r))}
      rowDescription={(r) => (other(r) ? t('profiles.rowSwitchDesc', { agent: labelOf(r) }) : undefined)}
      actions={[
        {
          id: 'chat-default',
          label: t('profiles.makeChatDefault'),
          // 그 에이전트의 채팅 기본이 아니고, 숨긴 루트가 아니고, 주인·관리자이고(나눠 받은 것 제외), 에이전트 API 가 있는 구성만(리뷰 I3)
          visible: (r) => {
            const g = groupOf(r.pod);
            return !!g && !r.hidden_root && g.chat_default !== r.name && !!g.can_create && agentKnown(r.pod);
          },
          disabled: (r) => chat.busy === `${r.pod}:${r.name}`,
          onClick: (r) => void chat.save(r.pod, r.name, labelOf(r), groupOf(r.pod)?.chat_default),
        },
      ]}
      id="profiles"
      columns={COLUMNS({ defaultModel: d.default_model, groupOf, current, agentColumn, narrow })}
      // 같은 이름(main)이 에이전트마다 있어 줄은 에이전트까지 넣어 가린다(리뷰 I1)
      rowId={(r) => `${r.pod}:${r.name}`}
      openId={params.get('name') ? `${current}:${params.get('name')}` : null}
      onRefresh={() => void q.refetch()}
      isFetching={q.isFetching}
      // 두 뱃지의 뜻을 풍선말 밖에도 글로 둔다 — 터치·키보드에서도 읽힌다(디자인 DD9)
      note={`${t('profiles.listNote')} ${t('profiles.badgeNote')}`}
    />
  );
}

type OfficeSeats = { agents?: { alias: string; pod?: string; profile: string; title?: string; mine?: boolean }[] };

/** 프로파일 서랍의 머리. 메뉴에서 연 서랍과 서랍 안 페이지가 함께 써서 같은 프로파일이면 제목이 같다(스펙 2026-10-26-003 Q1·C1) */
function useProfileHead() {
  // 오피스 자리에 앉은 내 에이전트면 그 자리 이름을 제목으로 쓰고 프로파일 이름은 부제에 둔다(스펙 2026-10-15-003 D2)
  const office = useQuery<OfficeSeats>({
    queryKey: ['office'],
    queryFn: () => get('/api/office'),
    retry: false,
    staleTime: 60000,
  });
  const me = useMe().data;
  const pod = me?.pod?.id ?? '';
  const agentName = me?.pod?.name ?? '';
  const head = (name: string) => {
    // 지금 에이전트의 자리만 본다 — 내 에이전트 여럿이 같은 이름(main)을 쓰면 다른 에이전트의 직함을 골랐다(스펙 2026-10-19-011 R2)
    // 지금 에이전트를 모르면(로그인 꺼진 구성 등) 예전처럼 내 자리 중에서 고른다
    const seat = office.data?.agents?.find((a) => (pod ? a.pod === pod : a.mine) && a.profile === name);
    const scope = agentName ? t('profiles.drawerSubIn', { agent: agentName }) : t('profiles.drawerSub');
    return {
      title: seat?.title || name,
      sub: seat?.title && seat.title !== name ? `${name} · ${scope}` : scope,
      // 부제 앞 에이전트 색 점(D5). 색 기준은 006 목록과 같은 pod id(D16)
      subLead: agentName && pod ? (
        <Box component="span" sx={{ display: 'inline-flex', verticalAlign: 'middle', mr: 0.5 }}>
          <AgentDot name={pod} />
        </Box>
      ) : undefined,
      // 같은 이름으로 다른 에이전트를 열면 머리·편집기를 새로 만들고 제목에 초점을 둔다(R1 ①·D7)
      focusKey: pod || undefined,
    };
  };
  return { head, pod, agentName, office: office.data };
}

/** 서랍 안에서 연 프로파일(스펙 2026-10-26-003 2단계). 탭·비밀값 등은 페이지 값으로 읽고, 바꾸면 지금 페이지를 바꿔 넣는다(기록을 쌓지 않는다).
 *  지우거나 「없음」에서 나가면 이전 페이지로 돌아간다 */
export function ProfilePage({ page }: { page: PageOf<'profile'> }) {
  const { head, pod } = useProfileHead();
  useDrawerHead(head(page.name));
  const guard = useDrawerGuard();
  const { replacePage, drawerBack, closeDrawer } = useUi();
  const at = useDrawerPage()?.index ?? 0;
  const spot = useMemo<ProfileSpot>(
    () => ({
      page: true,
      get: (k) => (k === 'name' ? page.name : k === 'pane' ? page.pane ?? null : page.extra?.[k] ?? null),
      patch: (changes) => {
        if ('name' in changes && !changes.name) return void (at > 0 ? drawerBack() : closeDrawer());
        const next = profilePage({ name: page.name, pane: page.pane, ...page.extra, ...changes });
        if (next) replacePage(next);
      },
    }),
    [page, at, replacePage, drawerBack, closeDrawer]
  );
  return (
    <>
      <AgentAnnouncer />
      <ProfileDetail key={`${pod}:${page.name}`} name={page.name} inDrawer onGuard={guard} spot={spot} />
    </>
  );
}

// 관리자에게 온 처리 대기 요청(스펙 2026-11-02-001). 사이드바의 「프로파일」 배지가 이 건수라, 배지를 보고 들어온 화면에서 이유와
// 처리할 곳(받은편지함)을 바로 보인다. 요청은 관리자에게만 오므로 따로 권한을 보지 않는다
function AdminRequestsNotice() {
  const { openDrawer } = useUi();
  const n = useInbox().items.filter((i) => i.kind === 'admin_request').length;
  if (!n) return null;
  return (
    <Alert
      severity="warning"
      sx={{ mb: 1 }}
      action={
        <Button color="inherit" size="small" onClick={() => openDrawer({ title: t('office.inbox'), icon: NotificationsNoneOutlinedIcon, body: <InboxPanel /> })}>
          {t('profiles.adminRequestsOpen')}
        </Button>
      }
    >
      {t('profiles.adminRequests', { n })}
    </Alert>
  );
}

// 상세는 목록 위 오른쪽 서랍으로 연다(주소 `?name=` 는 그대로라 다른 화면의 링크가 동작한다)
export function Profiles() {
  const { head, pod, agentName, office } = useProfileHead();
  const me = useMe().data;
  useRouteDrawer(
    'name',
    (name, guard) => {
      return {
        ...head(name),
        body: (
          <>
            <AgentAnnouncer />
            <ProfileDetail key={`${pod}:${name}`} name={name} inDrawer onGuard={guard} />
          </>
        ),
      };
    },
    ['pane'],
    [office, agentName],
    // 에이전트가 바뀌면 다른 대상이라 서랍을 새로 연다(기록도 첫 페이지 하나로, 스펙 2026-10-26-003 외부 검토 M5)
    [pod]
  );
  const primary = me?.primary;
  return (
    <>
      {/* 새 사용자의 주 에이전트(main)를 만들고 첫 SOUL 을 입히는 중(스펙 2026-10-14-003 리뷰 D6) */}
      {primary && !primary.ready && (
        <Alert severity="info" sx={{ mb: 1 }}>
          {t('common.primaryPreparing', { name: primary.profile })}
        </Alert>
      )}
      <AdminRequestsNotice />
      <AgentAnnouncer silent />
      <ProfileList />
    </>
  );
}
