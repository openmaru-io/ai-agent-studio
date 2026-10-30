/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 마켓: 따로 설치된 SkillHub 의 패키지를 골라 프로파일에 설치한다.
// 스킬 패키지는 있는 프로파일에 얹고, 에이전트 패키지는 그 스킬만 있는 프로파일에 넣거나 이미 만든 프로파일을 올린다. 설치는 요청으로 남고 서버의 배달기와 오퍼레이터가 처리한다.
import BadgeOutlinedIcon from '@mui/icons-material/BadgeOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import LockOpenOutlinedIcon from '@mui/icons-material/LockOpenOutlined';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import RestoreFromTrashOutlinedIcon from '@mui/icons-material/RestoreFromTrashOutlined';
import { Alert, Box, Button, Checkbox, CircularProgress, FormControlLabel, NativeSelect, Stack, Switch, TextField, Tooltip, Typography } from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SnackbarKey, useSnackbar } from 'notistack';
import { MouseEvent, ReactNode, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { AddIconButton } from '@/components/AddIconButton';
import { AgentPicker } from '@/components/AgentPicker';
import { AiSummary } from '@/components/AiSummary';
import { ChatChip, KV, Labeled, ScreenLoading, Section, Tag, useOpenInDrawer } from '@/components/bits';
import { useConfirm } from '@/components/ConfirmDialog';
import { ageColumn, GridColumn, nameColumn, Pill, statusColumn } from '@/components/DataGrid';
import { DescTranslation } from '@/components/DescTranslation';
import { DrawerAction, DrawerActions } from '@/components/DrawerActions';
import { ListView, tabOf, Tone } from '@/components/ListView';
import { Markdown } from '@/components/Markdown';
import { TagBar, tagCounts, tagLabel, tagMatches } from '@/components/TagBar';
import { tier1, tier2 } from '@/components/tierButton';
import { useUi } from '@/components/UiContext';
import { t } from '@/i18n';
import { get, post } from '@/lib/api';
import { useAgents, useMe } from '@/lib/data';
import { fmtTs, profileName } from '@/lib/format';
import { useNameOfEmail } from '@/lib/people';
import { useTopic } from '@/lib/ws';
import { HiddenBody, HiddenRow, HubPublishDrawer, useHubPackageActions } from '@/screens/market/HubPublish';

import { batchPlan, needsChoice, oneConfirm, progressOf, reasonOf, rowKey, selectable, shownRows, stateOf, UpdData, UpdRow } from './marketUpdates';
import { DeleteBody } from './profiles/DeleteProfile';

export interface Origin {
  kind: 'clawhub' | 'github' | 'own' | 'unknown';
  url?: string;
  license?: string;
}
interface Pkg {
  id: string;
  namespace: string;
  name: string;
  summary: string;
  /** 요약을 번역했을 때 원문과 출처("llm" | "seed"). 영어 화면이나 번역 전이면 없다(스펙 2026-10-19-017 §9) */
  summary_src?: string;
  summary_by?: string;
  version: string;
  paid: boolean;
  /** 관리자가 작업공간마다 허용해야 받는 네임스페이스(paid 와 같은 값). 옛 서버는 보내지 않아 paid 로 대체한다 */
  restricted?: boolean;
  allowed: boolean;
  update: boolean;
  /** 이 작업공간에서 이 패키지의 새 버전을 건너뛰었다(스펙 2026-10-24-003 R3) */
  skipped?: boolean;
  /** 출처(2026-10-14-026 C4): 미러 항목은 clawhub·github, 사용자가 올린 것은 own */
  origin?: Origin;
  /** LLM 이 매긴 태그 id(OMAI-1275). 없으면 비어 있다 */
  tags?: string[];
  /** mode=skills: 에이전트 패키지의 스킬만 넣은 프로파일(2026-10-14-002) */
  installed: { profile: string; version: string; mode?: string; skills_version?: string }[];
  /** 관리자 검토 없이(주인 스킬 자동 승인) 게시된 판과 올린 사람(스펙 2026-10-28-001 D6) */
  auto_versions?: { version: string; by: string }[];
}
interface Installed {
  profile: string;
  package: string;
  name: string;
  namespace: string;
  kind: 'skill' | 'agent';
  version: string;
  ts: string;
  latest?: string;
}
interface Req {
  status: string;
  mode: string;
  profile: string;
  name: string;
  package?: string;
  version?: string;
  kind: 'skill' | 'agent';
  who: string;
  /** who 의 사람 이름(2026-10-30) */
  who_name?: string;
  message?: string;
  ts: string;
  finished?: string;
  /** 고친 스킬·직접 만든 같은 경로의 스킬 때문에 멈춘 요청: 사용자가 「지키기/덮기」를 고르면 같은 요청을 다시 보낸다(스펙 2026-10-14-015) */
  needs?: { modified?: string[]; occupied?: string[] };
  /** 덮기 전에 남긴 백업(AAS 서버, 30일) */
  backup?: string;
}
interface MarketData {
  configured: boolean;
  error?: string;
  admin: boolean;
  /** 설치·지우기를 할 수 있는가(관리자나 이 POD 의 주인, OMAI-1126). 옛 서버는 보내지 않는다 */
  can_install?: boolean;
  helper: { alive: boolean };
  install?: { enabled: boolean; reason: string };
  packages: Pkg[];
  installed: Installed[];
  requests: Req[];
  /** slug → 화면에 보일 네임스페이스 이름(free → shared). 옛 서버는 보내지 않는다 → slug 를 보인다 */
  namespace_labels?: Record<string, string>;
}
/** 설치·지우기 단추를 쓸 수 있는가. 허용이 필요한 네임스페이스의 허용 단추는 계속 admin 만 본다 */
export const canInstall = (m: Pick<MarketData, 'admin' | 'can_install'>) => m.can_install ?? m.admin;

interface PkgDetail {
  kind: 'skill' | 'agent';
  paid: boolean;
  restricted?: boolean;
  owner: string;
  files: { path: string; size: number }[];
  scripts?: number;
  body?: string;
  version: string;
  versions: { version: string }[];
  allowed: boolean;
  origin?: Origin;
  tags?: string[];
  /** 파일 합계·묶음 한도(바이트)와, 눌러도 한도에 들 수 없는 크기인지(C5) */
  bytes?: number;
  limit?: number;
  too_big?: boolean;
}

/** 에이전트 패키지 안의 스킬 폴더(agent/skills/ 아래 SKILL.md 가 있는 곳, 안쪽 SKILL.md 는 빼고). 서버 marketplace.agent_skills 와 같다 */
export function agentSkills(d: Pick<PkgDetail, 'files'>): string[] {
  const dirs = [
    ...new Set(
      d.files
        .map((f) => f.path)
        .filter((x) => x.startsWith('agent/skills/') && x.endsWith('/SKILL.md'))
        .map((x) => x.slice(0, x.lastIndexOf('/')))
    ),
  ].sort();
  return dirs.filter((x) => !dirs.some((o) => x.startsWith(o + '/')));
}

// 네임스페이스 slug(free·paid)는 그대로 두고 사람에게 보이는 글에서만 서버가 준 이름(shared·restricted)을 쓴다.
// 이름 표는 서버 한 곳에만 있다(namespace_labels). 표가 없거나 표에 없는 slug(community 등)는 slug 를 보인다
const nsLabel = (ns: string, labels?: Record<string, string>) => labels?.[ns] || ns;
/** 패키지 ID(free/x@1.0)의 첫 / 앞(네임스페이스)만 이름으로 바꾼다 */
const pkgLabel = (id: string, labels?: Record<string, string>) => {
  const i = id.indexOf('/');
  return i < 0 ? id : nsLabel(id.slice(0, i), labels) + id.slice(i);
};
/** 허용이 필요한 네임스페이스인가. 옛 서버는 restricted 를 보내지 않으므로 paid 를 읽는다 */
const isRestricted = (x: { restricted?: boolean; paid: boolean }) => x.restricted ?? x.paid;

const kindLabel = (k: 'skill' | 'agent') => t(k === 'agent' ? 'market.kindAgent' : 'market.kindSkill');
const statusOf = (s: string): [string, Tone | undefined] => {
  switch (s) {
    case 'queued':
      return [t('market.statusQueued'), 'warn'];
    case 'running':
      return [t('market.statusRunning'), 'warn'];
    case 'done':
      return [t('market.statusDone'), 'good'];
    case 'failed':
      return [t('market.statusFailed'), 'bad'];
    default:
      return [s, undefined];
  }
};
const modeLabel = (mode: string): string => {
  switch (mode) {
    case 'update':
      return t('market.modeUpdate');
    case 'remove':
      return t('market.modeRemove');
    case 'forget':
      return t('market.modeForget');
    case 'rename':
      return t('market.modeRename');
    case 'skills':
      return t('market.modeSkills');
    case 'restore':
      return t('market.modeRestore');
    default:
      return t('market.modeInstall');
  }
};
const waiting = (d?: MarketData) => !!d && d.requests.some((r) => r.status === 'queued' || r.status === 'running');
const StatusTag = ({ s }: { s: string }) => <Tag tone={statusOf(s)[1]}>{statusOf(s)[0]}</Tag>;
const requestTitle = (r: Req) =>
  r.mode === 'forget' || r.mode === 'rename'
    ? `${profileName(r.profile)} — ${r.name}`
    : `${r.name} ${r.mode === 'remove' ? '✕' : '→'} ${profileName(r.profile)}`;
const hasNew = (r: Installed) => !!r.latest && r.latest !== r.version;

const originLabel = (o?: Origin) => t(`market.origin.${o?.kind ?? 'unknown'}` as Parameters<typeof t>[0]);
// 사내 마켓이라 「허용이 필요한」 여부 대신 출처로 나눈다(OMAI-1189): 사내에서 올린 것(own)과 GitHub·ClawHub 에서 가져온 것
const isExternal = (o?: Origin) => o?.kind === 'github' || o?.kind === 'clawhub';
const sourceGroup = (o?: Origin) => t(o?.kind === 'own' ? 'market.srcOwn' : isExternal(o) ? 'market.srcExternal' : 'market.origin.unknown');
const needsGrantNow = (p: Pick<Pkg, 'paid' | 'restricted' | 'allowed'>) => isRestricted(p) && !p.allowed;

// 공통 표의 열(OMAI-1127). 두 줄 목록의 태그 → 요금·버전·상태 칸, 둘째 줄 → 설명·프로파일·결과, 오른쪽 → 버전·시각
// 설치한 패키지는 이름 옆 「설치됨」으로 알린다. 어느 프로파일인지는 「설치한 패키지」 탭과 상세 창이 보인다
// (예전 「설치된 곳」 열은 대부분 비어 폭만 차지해 뺐다)
const pkgNameColumn = (): GridColumn<Pkg> => {
  const base = nameColumn<Pkg>({ label: t('market.package'), value: (p) => p.name });
  return {
    ...base,
    render: (p) => (
      <Box sx={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
        {base.render!(p)}
        {p.installed.length > 0 && <Pill tone="good">{t('market.installedBadge')}</Pill>}
        {p.auto_versions?.some((v) => v.version === p.version) && <Pill>{t('market.autoPill')}</Pill>}
      </Box>
    ),
  };
};
const pkgColumns = (showInstall: boolean, showTags: boolean): GridColumn<Pkg>[] => [
  pkgNameColumn(),
  {
    id: 'origin',
    label: t('market.grid.origin'),
    value: (p) => [sourceGroup(p.origin), isExternal(p.origin) ? originLabel(p.origin) : ''].filter(Boolean).join(' '),
    width: 'minmax(176px, auto)',
    render: (p) => (
      <>
        <Pill tone={p.origin?.kind === 'own' ? 'good' : undefined}>{sourceGroup(p.origin)}</Pill>
        {isExternal(p.origin) && <Pill>{originLabel(p.origin)}</Pill>}
      </>
    ),
  },
  // 관리자 허용이 필요한 패키지가 하나라도 있을 때만 보인다
  ...(showInstall
    ? [
        {
          id: 'install',
          label: t('market.grid.install'),
          value: (p) => (needsGrantNow(p) ? t('market.needsGrant') : t('market.installDirect')),
          width: 'minmax(128px, auto)',
          // 두 값 모두 칩으로 — 「바로 설치」만 맨 글자면 칩의 왼쪽 여백만큼 시작점이 어긋난다(2026-10-29 사용자 지적)
          render: (p) => (needsGrantNow(p) ? <Pill tone="bad">{t('market.needsGrant')}</Pill> : <Pill>{t('market.installDirect')}</Pill>),
        } as GridColumn<Pkg>,
      ]
    : []),
  // 태그가 하나라도 있을 때만 보인다(OMAI-1275). 알약 둘까지 + 「+N」, 정렬·검색은 태그 이름 글자로 한다
  ...(showTags
    ? [
        {
          id: 'tags',
          label: t('market.grid.tags'),
          value: (p) => (p.tags ?? []).map(tagLabel).join(' '),
          width: 'minmax(176px, auto)',
          render: (p) => (
            <>
              {(p.tags ?? []).slice(0, 2).map((id, i) => (
                <Pill key={id} flush={i === 0}>
                  {tagLabel(id)}
                </Pill>
              ))}
              {(p.tags ?? []).length > 2 && <Pill>{`+${(p.tags ?? []).length - 2}`}</Pill>}
            </>
          ),
        } as GridColumn<Pkg>,
      ]
    : []),
  {
    id: 'summary',
    label: t('market.grid.summary'),
    value: (p) => p.summary,
    width: 'minmax(200px, 3fr)',
  },
  {
    id: 'version',
    label: t('market.version'),
    value: (p) => p.version,
    width: 'minmax(96px, auto)',
    render: (p) => (
      <>
        {'v' + p.version}
        {p.update && <Pill tone="warn">{t('market.newVersion')}</Pill>}
      </>
    ),
  },
];
const installedColumns = (source: (r: Installed) => string): GridColumn<Installed>[] => [
  nameColumn<Installed>({ label: t('market.grid.name'), value: (r) => r.name }),
  { id: 'kind', label: t('market.kind'), value: (r) => kindLabel(r.kind), width: 'minmax(80px, auto)' },
  { id: 'profile', label: t('market.profile'), value: (r) => profileName(r.profile), width: 'minmax(96px, 1fr)' },
  { id: 'origin', label: t('market.grid.origin'), value: source, width: 'minmax(96px, 1fr)' },
  {
    id: 'version',
    label: t('market.version'),
    value: (r) => r.version,
    width: 'minmax(96px, auto)',
    render: (r) => (
      <>
        {'v' + r.version}
        {hasNew(r) && <Pill tone="warn">{t('market.newVersionV', { v: r.latest })}</Pill>}
      </>
    ),
  },
  ageColumn<Installed>({ id: 'ts', label: t('market.grid.installedTs'), value: (r) => r.ts }),
];
const requestColumns = (): GridColumn<Req>[] => [
  nameColumn<Req>({ label: t('market.request'), value: requestTitle }),
  statusColumn<Req>({ label: t('market.status'), value: (r) => statusOf(r.status)[0], tone: (r) => statusOf(r.status)[1] }),
  { id: 'message', label: t('market.result'), value: (r) => r.message || t('market.requestedBy', { who: r.who_name || r.who }), width: 'minmax(200px, 3fr)' },
  { id: 'version', label: t('market.version'), value: (r) => (r.version ? 'v' + r.version : ''), width: 'minmax(80px, auto)' },
  ageColumn<Req>({ id: 'ts', label: t('market.grid.requestedTs'), value: (r) => r.ts }),
];

function PackageDetail({ p, market, onDone, onPublishNew }: { p: Pkg; market: MarketData; onDone: (toLog: boolean) => void; onPublishNew?: (expected: string) => void }) {
  const hubActions = useHubPackageActions({
    admin: !!market.admin && !!onPublishNew,
    namespace: p.namespace,
    name: p.name,
    openPublish: (expected) => onPublishNew?.(expected),
    onHidden: () => onDone(false),
  });
  const q = useQuery<PkgDetail>({
    queryKey: ['market-package', p.namespace, p.name],
    queryFn: () =>
      get<PkgDetail>(`/api/market/package?ns=${encodeURIComponent(p.namespace)}&name=${encodeURIComponent(p.name)}`),
  });
  const d = q.data;
  return (
    <>
      <Typography>{p.summary}</Typography>
      <DescTranslation src={p.summary_src} by={p.summary_by} />
      {!d ? (
        q.error ? (
          <Alert severity="error">{q.error.message}</Alert>
        ) : (
          <Typography color="text.secondary">{t('market.loading')}</Typography>
        )
      ) : (
        <>
          <Grant p={p} d={d} market={market} onDone={onDone} extra={hubActions} />
          {/* 무엇을 하는 스킬인지 먼저 읽히게 기본 정보 위에 둔다. 스킬 서랍과 같은 순서 */}
          <Section title={t('market.summary.title')}>
            <AiSummary
              target={{ ns: p.namespace, name: p.name }}
              actions={
                <ChatChip
                  agent="default"
                  text={t('market.aiExplainPrompt', {
                    name: p.name,
                    version: d.version,
                    kind: kindLabel(d.kind),
                    files: d.files.slice(0, 60).map((f) => f.path).join('\n'),
                    body: (d.body ?? '').slice(0, 4000) || '-',
                  })}
                >
                  {t('market.aiExplainAction')}
                </ChatChip>
              }
            />
          </Section>
          <KV
            pairs={[
              [
                t('market.kind'),
                <Tag key="k" tone={d.kind === 'agent' ? 'warn' : undefined}>
                  {kindLabel(d.kind)}
                </Tag>,
              ],
              [t('market.owner'), d.owner],
              ...((d.tags ?? p.tags ?? []).length ? ([[t('market.tags'), (d.tags ?? p.tags ?? []).map(tagLabel).join(', ')]] as [string, ReactNode][]) : []),
              [t('market.origin'), isExternal(d.origin) ? `${sourceGroup(d.origin)} · ${originLabel(d.origin)}` : sourceGroup(d.origin)],
              ...(d.origin?.url
                ? ([
                    [
                      t('market.originUrl'),
                      <a key="u" href={d.origin.url} target="_blank" rel="noopener noreferrer">
                        {d.origin.url}
                      </a>,
                    ],
                  ] as [string, ReactNode][])
                : []),
              ...(d.origin?.license ? ([[t('market.license'), d.origin.license]] as [string, ReactNode][]) : []),
              ...(d.bytes != null && d.limit
                ? ([[t('market.bundleSize'), `${Math.ceil(d.bytes / 1024)} KiB / ${Math.round(d.limit / 1024)} KiB`]] as [string, ReactNode][])
                : []),
              [
                t('market.files'),
                t('market.filesCount', { n: d.files.length }) +
                  (d.scripts ? t('market.scriptsSuffix', { n: d.scripts }) : ''),
              ],
              ...(isRestricted(d)
                ? ([
                    [
                      t('market.paidNamespace'),
                      <Tag key="g" tone={d.allowed ? 'good' : 'bad'}>
                        {d.allowed ? t('market.allowedForHermes') : t('market.notAllowed')}
                      </Tag>,
                    ],
                  ] as [string, ReactNode][])
                : []),
            ]}
          />
          <Section title={t('market.install')}>
            <InstallForm p={p} d={d} market={market} onDone={onDone} />
          </Section>
          <Places p={p} d={d} market={market} onDone={onDone} />
          {d.body && (
            <Section title={t('market.description')}>
              <Markdown text={d.body} />
            </Section>
          )}
          <Section title={t('market.includedFiles')}>
            <ul style={{ fontSize: 13 }}>
              {d.files.slice(0, 60).map((f) => (
                <li key={f.path}>
                  <code>{f.path}</code>
                  {` ${f.size}B`}
                </li>
              ))}
            </ul>
          </Section>
        </>
      )}
    </>
  );
}


/** 설치할 프로파일이 없을 때(2026-10-19-001 R6·디자인 D9). 주 프로파일(main)을 만드는 중이면 기다리라고, 아니면 프로파일을 만들라고 한다 */
function NoProfiles() {
  const primary = useMe().data?.primary;
  if (primary?.ready === false)
    return (
      <Typography variant="body2" color="text.secondary" role="status">
        {t('common.primaryPreparing', { name: primary.profile })}
      </Typography>
    );
  return (
    <Typography variant="body2" color="text.secondary">
      {t('market.noProfiles')} <Link to="/profiles">{t('market.createProfile')}</Link>
    </Typography>
  );
}

function InstallForm({
  p,
  d,
  market,
  onDone,
}: {
  p: Pkg;
  d: PkgDetail;
  market: MarketData;
  onDone: (toLog: boolean) => void;
}) {
  const { enqueueSnackbar } = useSnackbar();
  const confirm = useConfirm();
  const agents = useAgents();
  const pod = useMe().data?.pod;
  const profiles = (agents.data ?? []).map((a) => a.name).filter((n) => n !== 'default');
  // 이 패키지로 만든 프로파일(올리기 대상). 스킬만 넣은 프로파일은 올리면 SOUL 을 덮으므로 뺀다(2026-10-14-002)
  const mine = p.installed.filter((r) => r.mode !== 'skills').map((r) => r.profile);
  const skillDirs = agentSkills(d);
  // 패키지로 만든 프로파일에도 스킬만 새로 넣을 수 있다(SOUL 은 그대로). default 는 Hermes 가 설치를 거절한다
  const skillTargets = profiles;
  // 어느 에이전트의 프로파일인지 보이게 「에이전트 이름 · 프로파일」로 적는다. 에이전트를 모르면(로컬 모드) 프로파일만
  const agentName = pod?.name || pod?.id || '';
  const targetLabel = (n: string) => (agentName ? `${agentName} · ${profileName(n)}` : profileName(n));
  const [skillPick, setSkillPick] = useState('');
  const skillTarget = skillPick || skillTargets[0] || '';
  const [version, setVersion] = useState(d.version);
  const [pick, setPick] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const target = pick || profiles[0] || '';

  const send = async (profile: string, mode: string) => {
    // 설치·올리기·스킬만 설치는 프로파일 내용을 바꾸므로 확인한다(OMAI-1135)
    const ask = {
      install: 'market.installConfirm',
      update: 'market.upgradeConfirm',
      skills: 'market.skillsOnlyConfirm',
    }[mode];
    const auto = p.auto_versions?.find((v) => v.version === version);   // 확인 창 둘째 줄: 관리자 검토 없이 게시된 판(D6)
    if (ask && !(await confirm(t(ask, { name: p.name, version, profile }) + (auto ? '\n' + t('market.autoInstallNote', { by: auto.by }) : '')))) return;
    setBusy(true);
    try {
      await post('/api/market/install', { namespace: p.namespace, name: p.name, version, profile, mode });
      enqueueSnackbar(t('market.installRequested', { name: p.name, version, profile }), { variant: 'success' });
      onDone(true);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const installOff = market.install?.enabled === false;
  const blocked = installOff
    ? market.install?.reason ?? ''
    : !canInstall(market)
    ? t('market.adminOnly')
    : d.too_big
    ? t('market.tooBig', { size: Math.ceil((d.bytes ?? 0) / 1024), limit: Math.round((d.limit ?? 0) / 1024) })
    : !d.allowed
    ? t('market.paidNotAllowed', { ns: nsLabel(p.namespace, market.namespace_labels) })
    : !market.helper.alive
    ? t('market.helperDownQueued')
    : '';
  const off = installOff || !canInstall(market) || !d.allowed || !!d.too_big || busy;

  return (
    <Stack spacing={1.5}>
      {blocked && (
        <Alert severity={canInstall(market) && d.allowed && !d.too_big ? 'info' : 'warning'} role="alert">
          {blocked}
        </Alert>
      )}
      {!d.too_big && d.bytes != null && d.limit != null && d.bytes > d.limit && (
        <Alert severity="info">{t('market.mayBeTooBig', { size: Math.ceil(d.bytes / 1024), limit: Math.round(d.limit / 1024) })}</Alert>
      )}
      <Labeled label={t('market.version')}>
        <NativeSelect
          value={version}
          onChange={(e) => setVersion(e.target.value)}
          inputProps={{ 'aria-label': t('market.version') }}
        >
          {d.versions.map((v) => (
            <option key={v.version} value={v.version}>
              {'v' + v.version + (v.version === d.version ? ' ' + t('market.latestSuffix') : '')}
            </option>
          ))}
        </NativeSelect>
      </Labeled>
      {p.auto_versions?.some((v) => v.version === version) && (
        <Typography variant="caption" color="text.secondary">
          {t('market.autoInstallNote', { by: p.auto_versions.find((v) => v.version === version)?.by ?? '' })}
        </Typography>
      )}
      {/* 에이전트 패키지는 새 프로파일로 설치하지 않는다 — 스킬만 넣거나 이미 만든 프로파일을 올린다(2026-10-14-002 §8) */}
      {d.kind === 'agent' ? (
        mine.length > 0 && (
          <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
            {mine.map((n) => (
              <Button key={n} disabled={off} onClick={() => send(n, 'update')}>{t('market.upgradeProfile', { name: n })}</Button>
            ))}
          </Stack>
        )
      ) : (
        <>
          {profiles.length ? (
            <AgentPicker
              label={t('market.profileToInstall')}
              value={pick || profiles[0] || ''}
              onChange={setPick}
              options={profiles.map((n) => ({ value: n, label: targetLabel(n) + (mine.includes(n) ? t('market.installedSuffix') : '') }))}
            />
          ) : (
            <NoProfiles />
          )}
          <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
            {/* 설치할 프로파일이 없으면 빈 이름으로 보내지 않는다. 막은 이유는 툴팁으로(2026-10-19-001 R6) */}
            <Tooltip title={!target ? t('market.noProfilesTip') : ''}>
              <span>
                <Button variant="contained" disabled={off || !target} onClick={() => send(target, 'install')}>
                  {t('market.installToProfile')}
                </Button>
              </span>
            </Tooltip>
          </Stack>
        </>
      )}
      {/* 에이전트 패키지의 스킬만 이미 쓰는 프로파일에 넣는다 — SOUL·설정·크론·MCP 는 그대로(2026-10-14-002) */}
      {d.kind === 'agent' && skillDirs.length > 0 && (
        <Stack spacing={1} sx={{ pt: 1 }}>
          <AgentPicker
            label={t('market.skillsOnlyLabel')}
            value={skillTarget}
            onChange={setSkillPick}
            options={skillTargets.map((n) => ({ value: n, label: targetLabel(n) }))}
          />
          <Box>
            <Button variant="outlined" disabled={off || !skillTarget} onClick={() => send(skillTarget, 'skills')}>
              {t('market.skillsOnlyInstall')}
            </Button>
          </Box>
          <Typography variant="caption" color="text.secondary">
            {t('market.skillsOnlyNote', { count: skillDirs.length })}
          </Typography>
        </Stack>
      )}
      {error && <Alert severity="error">{error}</Alert>}
      {(d.kind !== 'agent' || mine.length > 0) && (
        <Typography variant="caption" color="text.secondary">
          {d.kind === 'agent' ? t('market.agentNote') : t('market.skillNote', { name: p.name })}
        </Typography>
      )}
      {/* 관리자가 아닌 주인은 설치 뒤 바꿀 수 없는 것을 미리 안다(OMAI-1126 디자인 결정 21A) */}
      {d.kind === 'agent' && !market.admin && canInstall(market) && (
        <Typography variant="caption" color="text.secondary">
          {t('market.ownerAgentNote')}
        </Typography>
      )}
    </Stack>
  );
}

function Places({
  p,
  d,
  market,
  onDone,
}: {
  p: Pkg;
  d: PkgDetail;
  market: MarketData;
  onDone: (toLog: boolean) => void;
}) {
  const confirm = useConfirm();
  const { enqueueSnackbar } = useSnackbar();
  const { closeDrawer, openDrawer } = useUi();
  const openHere = useOpenInDrawer();
  if (!p.installed.length) return null;
  const drop = async (profile: string) => {
    if (
      !(await confirm(
        t('market.confirmRemove', { profile, name: p.name })
      ))
    )
      return;
    try {
      await post('/api/market/remove', { namespace: p.namespace, name: p.name, profile });
      enqueueSnackbar(t('market.removeRequested', { name: p.name, profile }), { variant: 'success' });
      onDone(true);
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
    }
  };
  return (
    <Section title={t('market.installedPlaces')}>
      {p.installed.map((r) => (
        <Stack key={r.profile} direction="row" spacing={1} alignItems="center" sx={{ py: 0.5 }}>
          <Box sx={{ flex: 1 }}>
            {profileName(r.profile)} <Tag tone={r.version === d.version ? 'good' : 'warn'}>{'v' + r.version}</Tag>
            {r.mode === 'skills' && <Tag>{t('market.skillsOnlyTag')}</Tag>}
            {r.skills_version && <Tag>{t('market.skillsVersionTag', { version: r.skills_version })}</Tag>}
          </Box>
          {d.kind === 'skill' ? (
            <Button startIcon={<DeleteOutlineIcon />}
              size="small"
              color="error"
              disabled={!canInstall(market) || market.install?.enabled === false}
              onClick={() => drop(r.profile)}
            >
              {t('market.remove')}
            </Button>
          ) : (
            <>
              <Button startIcon={<BadgeOutlinedIcon />}
                size="small"
                component={Link}
                to={`/profiles?name=${encodeURIComponent(r.profile)}`}
                onClick={(e: MouseEvent) => openHere(e, { kind: 'profile', name: r.profile }) || void closeDrawer()}
              >
                {t('market.openProfile')}
              </Button>
              {/* 에이전트 패키지는 지우기 대신 프로파일을 지운다. 주인도 마켓으로 만든 프로파일은 지운다(OMAI-1126 디자인 결정 11A) */}
              {canInstall(market) && r.mode !== 'skills' && (
                <Button startIcon={<DeleteOutlineIcon />}
                  size="small"
                  color="error"
                  onClick={() =>
                    openDrawer({ title: t('profiles.deleteTitle'), sub: r.profile, body: <DeleteBody name={r.profile} /> })
                  }
                >
                  {t('market.deleteProfile')}
                </Button>
              )}
            </>
          )}
        </Stack>
      ))}
      {d.kind === 'skill' && (
        <Typography variant="caption" color="text.secondary">
          {t('market.removeNote')}
        </Typography>
      )}
    </Section>
  );
}

// 허용이 필요한 네임스페이스의 허용은 서랍 머리의 단추로 둔다(COP Drawer 처럼, OMAI-1135). 허용 상태는 기본 정보 표에 보인다
function Grant({
  p,
  d,
  market,
  onDone,
  extra = [],
}: {
  p: Pkg;
  d: PkgDetail;
  market: MarketData;
  onDone: (toLog: boolean) => void;
  /** 같은 서랍 머리에 함께 둘 관리자 동작(새 판 게시·허브에서 숨기기, 스펙 2026-10-29-002 DD4) — 머리 자리에 한 번만 그린다 */
  extra?: DrawerAction[];
}) {
  const { enqueueSnackbar } = useSnackbar();
  if (!isRestricted(p) || !market.admin) return extra.length ? <DrawerActions actions={extra} /> : null;
  const on = d.allowed;
  const toggle = async () => {
    try {
      await post('/api/market/grant', { namespace: p.namespace, allow: !on });
      enqueueSnackbar(on ? t('market.grantRevoked', { name: p.name }) : t('market.grantAllowed', { name: p.name }), { variant: 'success' });
      onDone(false);
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
    }
  };
  const ns = nsLabel(p.namespace, market.namespace_labels);
  const label = on ? t('market.revokeGrant') : t('market.allowNs', { ns });
  return (
    <DrawerActions
      actions={[
        {
          id: 'grant',
          label,
          description: t('market.grantNote'),
          icon: on ? LockOutlinedIcon : LockOpenOutlinedIcon,
          confirm: {
            message: t(on ? 'market.grantRevokeConfirm' : 'market.grantAllowConfirm', { ns }),
            okLabel: label,
            onConfirm: toggle,
          },
        },
        ...extra,
      ]}
    />
  );
}

/** 내가 고쳤거나 직접 만든 스킬이 있어 멈춘 요청: 지킬지 덮을지 고르면 같은 요청을 on_modified 와 함께 다시 보낸다. 덮기는 백업을 남기고 확인을 받는다. */
function NeedsChoice({ r, market, onDone }: { r: Req; market: MarketData; onDone: (toLog: boolean) => void }) {
  const confirm = useConfirm();
  const { enqueueSnackbar } = useSnackbar();
  const [busy, setBusy] = useState(false);
  const paths = [...(r.needs?.modified ?? []), ...(r.needs?.occupied ?? [])];
  if (r.status !== 'failed' || !paths.length || !canInstall(market)) return null;
  const [namespace] = (r.package ?? '').split('/');
  const copyable = r.kind === 'skill' && r.needs?.modified?.length === 1 && !r.needs?.occupied?.length && r.needs.modified[0].startsWith('skills/market/');
  const send = async (choice: 'keep' | 'overwrite' | 'copy') => {
    if (choice === 'overwrite' && !(await confirm(t('market.overwriteConfirm', { name: r.name, profile: r.profile })))) return;
    setBusy(true);
    try {
      await post('/api/market/install', { namespace, name: r.name, version: r.version, profile: r.profile, mode: r.mode, on_modified: choice });
      enqueueSnackbar(t('market.installRequested', { name: r.name, version: r.version, profile: r.profile }), { variant: 'success' });
      onDone(true);
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
      setBusy(false);
    }
  };
  return (
    <Section title={t('market.needsTitle')}>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        {t('market.needsBody')}
        {copyable && ` ${t('market.needsCopyNote')}`}
      </Typography>
      <Box component="ul" sx={{ m: 0, mb: 1.5, pl: 3 }}>
        {paths.map((p) => (
          <li key={p}>
            <code>{p}</code>
          </li>
        ))}
      </Box>
      <Stack direction="row" spacing={1}>
        <Button variant="contained" disabled={busy} onClick={() => void send('keep')}>
          {t('market.needsKeep')}
        </Button>
        <Button variant="outlined" color="warning" disabled={busy} onClick={() => void send('overwrite')}>
          {t('market.needsOverwrite')}
        </Button>
        {copyable && (
          <Button variant="outlined" disabled={busy} onClick={() => void send('copy')}>
            {t('market.needsCopy')}
          </Button>
        )}
      </Stack>
    </Section>
  );
}

interface Archived {
  profile: string;
  skill: string;
  dir: string;
}

interface PublishReq {
  id: string;
  ts: string;
  who: string;
  profile: string;
  path: string;
  name: string;
  version: string;
  origin: string;
  derived_from?: string;
  description?: string;
  files: { path: string; size: number }[];
  status: string;
  namespace?: string;
  message?: string;
  decided_by?: string;
  /** who·decided_by 의 사람 이름 — 관리자가 아닌 주인도 이름으로 본다(2026-10-30) */
  who_name?: string;
  decided_by_name?: string;
  /** 주인 스킬 자동 승인으로 게시됐다(스펙 2026-10-28-001 Q14) */
  auto?: boolean;
  auto_failed?: boolean;
  /** 사내 도메인·사설 IP 가 든 곳 「파일:줄」 — 공개 네임스페이스면 거절, 구성원이면 경고(R18) */
  internal_refs?: string[];
  /** 오래된 게시 중(publishing) — 결과를 모르는 실패로 보인다(스펙 2026-10-29-002 R9) */
  stale?: boolean;
  scripts?: number;
}
interface PublishList {
  items: PublishReq[];
  admin?: boolean;
  can?: boolean;
  namespaces?: string[];
  /** slug → 화면에 보일 이름. 옛 서버는 보내지 않는다 */
  namespace_labels?: Record<string, string>;
  /** 주인 스킬 자동 승인 설정(관리자가 바꾼다) */
  auto?: { auto: boolean; namespace: string; domains: string[] };
}

/** 관리자: 주인 스킬 자동 승인 켜고 끄기와 대상 네임스페이스(스펙 2026-10-28-001 Q14). 게시 탭 위 띠에 둔다 */
function AutoControl({ list }: { list: PublishList }) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const cfg = list.auto;
  if (!cfg) return null;
  const save = async (body: { auto?: boolean; namespace?: string }) => {
    try {
      await post('/api/market/publish/auto', body);
      await qc.invalidateQueries({ queryKey: ['market', 'publish'] });
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
    }
  };
  return (
    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
      {/* 알림 띠 안이라 FormControlLabel 기본 왼쪽 여백(-11px)이 스위치를 자른다 — 0 으로 둔다. 크기는 갱신 탭 스위치(small)와 맞춘다 */}
      <FormControlLabel
        sx={{ ml: 0 }}
        control={<Switch size="small" checked={cfg.auto} onChange={(e) => void save({ auto: e.target.checked })} />}
        label={<Typography variant="body2">{t('market.autoSwitch')}</Typography>}
      />
      <NativeSelect value={cfg.namespace} disabled={!cfg.auto} onChange={(e) => void save({ namespace: e.target.value })} inputProps={{ 'aria-label': t('market.autoNamespace') }}>
        {(list.namespaces ?? []).map((n) => (
          <option key={n} value={n}>
            {nsLabel(n, list.namespace_labels)}
          </option>
        ))}
      </NativeSelect>
      <Typography variant="caption" color="text.secondary">
        {t('market.autoHelp')}
      </Typography>
    </Stack>
  );
}

const publishStatus = (st: string): [string, Tone | undefined] => {
  switch (st) {
    case 'requested':
      return [t('skills.publishStatus.requested'), 'warn'];
    case 'published':
      return [t('skills.publishStatus.published'), 'good'];
    case 'pending_review':
      return [t('skills.publishStatus.pending_review'), 'warn'];
    case 'rejected':
      return [t('skills.publishStatus.rejected'), undefined];
    case 'publishing': // 관리자 직접 게시 진행 중 — 무채색, 탭 경고색에 영향 없음(스펙 2026-10-29-002 DD6)
      return [t('skills.publishStatus.publishing'), undefined];
    default:
      return [t('skills.publishStatus.failed'), 'bad'];
  }
};

/** 올리기 요청 하나: 관리자는 네임스페이스를 골라 승인하거나 사유와 함께 반려하고, 올린 묶음을 내려받는다. */
function PublishBody({ r, list, onDone }: { r: PublishReq; list: PublishList; onDone: () => void }) {
  const confirm = useConfirm();
  const nameOf = useNameOfEmail();
  const { enqueueSnackbar } = useSnackbar();
  const spaces = list.namespaces ?? [];
  const [ns, setNs] = useState(r.namespace || spaces[0] || 'free');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const direct = r.origin === 'admin_upload'; // 관리자 직접 게시: 승인·반려 없음, 「같은 묶음으로 다시 게시」(DD11·R9)
  const decidable = !!list.admin && !direct && (r.status === 'requested' || r.status === 'failed');
  const [confirmed, setConfirmed] = useState(false);
  const installed = useQuery({
    queryKey: ['market', 'hub', 'installed', r.namespace, r.name],
    queryFn: () => get<{ count: number }>(`/api/market/hub/installed?${new URLSearchParams({ namespace: r.namespace ?? '', name: r.name })}`),
    enabled: !!list.admin && r.status === 'published' && !!r.namespace,
  });
  const republish = async () => {
    setBusy(true);
    try {
      const out = await post<{ request: PublishReq; how: string }>('/api/market/publish/retry', { id: r.id, confirm_scripts: confirmed });
      enqueueSnackbar(out.how === 'reconciled' ? t('market.hub.reconciled') : publishStatus(out.request.status)[0], { variant: out.request.status === 'failed' ? 'error' : 'success' });
      onDone();
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const decide = async (approve: boolean) => {
    if (approve && !(await confirm(t('market.publishApproveConfirm', { name: r.name, version: r.version, ns: nsLabel(ns, list.namespace_labels) })))) return;
    setBusy(true);
    try {
      await post('/api/market/publish/decide', { id: r.id, approve, namespace: ns, reason });
      enqueueSnackbar(approve ? t('market.publishApproved', { name: r.name, version: r.version }) : t('market.publishRejected', { name: r.name, version: r.version }), { variant: 'success' });
      onDone();
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack spacing={1.5}>
      <KV
        pairs={[
          [t('market.who'), nameOf(r.who) ?? r.who_name ?? r.who],
          ...(direct ? [] : ([[t('market.profile'), r.profile]] as [string, ReactNode][])),
          [
            t('market.status'),
            <Stack key="s" direction="row" spacing={0.5} alignItems="center">
              <Tag tone={publishStatus(r.status)[1]}>{publishStatus(r.status)[0]}</Tag>
              {r.status === 'publishing' && <CircularProgress size={12} color="inherit" aria-hidden />}
            </Stack>,
          ],
          [
            t('market.publishDecision'),
            direct ? <Pill key="d">{t('market.hub.directPill')}</Pill> : r.auto ? <Pill key="a">{t('market.autoApproved')}</Pill> : (r.decided_by && nameOf(r.decided_by)) || r.decided_by_name || r.decided_by || '—',
          ],
          [t('market.publishOrigin'), t(`skills.origin.${r.origin}` as Parameters<typeof t>[0])],
          ...(r.derived_from ? ([[t('market.publishDerived'), <code key="d">{pkgLabel(r.derived_from, list.namespace_labels)}</code>]] as [string, ReactNode][]) : []),
          [t('market.result'), r.message ?? ''],
        ]}
      />
      {r.description && <Typography variant="body2">{r.description}</Typography>}
      {r.status === 'pending_review' && <Alert severity="info">{t('market.hub.pending')}</Alert>}
      {installed.data && installed.data.count > 0 && <Typography variant="caption" color="text.secondary">{t('market.hub.installed', { n: installed.data.count })}</Typography>}
      {!!r.internal_refs?.length && <Alert severity="warning">{t('market.internalRefs', { list: r.internal_refs.join(', ') })}</Alert>}
      <Box component="ul" sx={{ m: 0, pl: 3, fontSize: 13 }}>
        {r.files.map((f) => (
          <li key={f.path}>
            <code>{f.path}</code> {`${f.size}B`}
          </li>
        ))}
      </Box>
      {list.admin && (
        <Button startIcon={<DownloadOutlinedIcon />} size="small" component="a" href={`/api/market/publish/bundle?id=${encodeURIComponent(r.id)}`} sx={{ alignSelf: 'flex-start' }}>
          {t('market.publishDownload')}
        </Button>
      )}
      {direct && !!list.admin && r.status === 'failed' && (
        <Stack spacing={1}>
          {!!r.scripts && <FormControlLabel control={<Checkbox size="small" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />} label={t('skills.zipConfirm')} />}
          <Box>
            <Button variant="outlined" color="inherit" sx={tier1} disabled={busy || (!!r.scripts && !confirmed)} onClick={() => void republish()}>
              {t('market.hub.retry')}
            </Button>
          </Box>
        </Stack>
      )}
      {decidable && (
        <Stack spacing={1}>
          <Labeled label={t('market.category')}>
            <NativeSelect value={ns} onChange={(e) => setNs(e.target.value)} inputProps={{ 'aria-label': t('market.category') }}>
              {spaces.map((n) => (
                <option key={n} value={n}>
                  {nsLabel(n, list.namespace_labels)}
                </option>
              ))}
            </NativeSelect>
          </Labeled>
          <TextField size="small" label={t('market.publishReason')} value={reason} onChange={(e) => setReason(e.target.value)} />
          <Stack direction="row" spacing={1}>
            <Button variant="contained" disabled={busy} onClick={() => void decide(true)}>
              {t('market.publishApprove')}
            </Button>
            <Button variant="outlined" color="warning" disabled={busy} onClick={() => void decide(false)}>
              {t('market.publishReject')}
            </Button>
          </Stack>
        </Stack>
      )}
    </Stack>
  );
}

/** 큐레이터가 보관한 스킬 하나: 되살리기 요청을 보낸다(오퍼레이터가 hermes curator restore 를 돌린다). */
function ArchivedBody({ a, onDone }: { a: Archived; onDone: (toLog: boolean) => void }) {
  const confirm = useConfirm();
  const { enqueueSnackbar } = useSnackbar();
  const [busy, setBusy] = useState(false);
  const restore = async () => {
    if (!(await confirm(t('market.restoreConfirm', { name: a.skill, profile: a.profile })))) return;
    setBusy(true);
    try {
      await post('/api/market/restore', { profile: a.profile, name: a.skill });
      enqueueSnackbar(t('market.restoreRequested', { name: a.skill, profile: a.profile }), { variant: 'success' });
      onDone(true);
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
      setBusy(false);
    }
  };
  return (
    <Stack spacing={1.5}>
      <Typography variant="body2" color="text.secondary">
        {t('market.archivedNote')}
      </Typography>
      <KV pairs={[[t('market.profile'), a.profile], [t('market.archivedFolder'), <code key="d">{a.dir}</code>]]} />
      <Box>
        <Button startIcon={<RestoreFromTrashOutlinedIcon />} variant="contained" disabled={busy} onClick={() => void restore()}>
          {t('market.restore')}
        </Button>
      </Box>
    </Stack>
  );
}

// ── 새 버전 있음 탭(스펙 2026-10-24-003 §10) ──

const updColumns = (managed: boolean): GridColumn<UpdRow>[] => [
  { id: 'profile', label: t('market.upd.col.profile'), value: (r) => profileName(r.profile), width: 'minmax(120px, 1fr)', hideable: false },
  {
    id: 'skill',
    label: t('market.upd.col.skill'),
    value: (r) => r.skill,
    width: 'minmax(140px, 1.5fr)',
    render: (r) => (
      <>
        <span>{r.skill}</span>
        {r.basis === 'folder' && (
          <Tooltip title={t('market.upd.estimatedHelp')}>
            <span>
              <Pill>{t('market.upd.estimated')}</Pill>
            </span>
          </Tooltip>
        )}
      </>
    ),
  },
  { id: 'version', label: t('market.upd.col.version'), value: (r) => `v${r.current || '?'} → v${r.latest}`, width: 'minmax(140px, auto)', mono: true },
  ...(managed
    ? [{ id: 'pod', label: t('market.upd.col.pod'), value: (r: UpdRow) => r.pod_name || r.pod, width: 'minmax(120px, 1fr)' } as GridColumn<UpdRow>]
    : []),
  { id: 'basis', label: t('market.upd.col.basis'), value: (r) => t(r.basis === 'folder' ? 'market.upd.basis.folder' : 'market.upd.basis.record'), hidden: true },
  statusColumn<UpdRow>({ label: t('market.upd.col.state'), value: (r) => stateOf(r)[0], tone: (r) => stateOf(r)[1] }),
];

function UpdateDetail({ r, p, market, onQueued }: { r: UpdRow; p?: Pkg; market?: MarketData; onQueued: () => void }) {
  const confirm = useConfirm();
  const { enqueueSnackbar } = useSnackbar();
  const [busy, setBusy] = useState(false);
  const send = async (choice: '' | 'copy' | 'overwrite') => {
    if (choice === 'overwrite' && !(await confirm(t('market.upd.overwriteConfirm', { profile: r.profile, skill: r.skill, to: r.latest })))) return;
    if (choice === '' && !(await confirm(oneConfirm(r)))) return;
    setBusy(true);
    try {
      await post('/api/market/updates/queue', { items: [{ pod: r.pod, profile: r.profile, package: r.package, version: r.latest, on_modified: choice }] });
      enqueueSnackbar(t('market.upd.queued'), { variant: 'success' });
      onQueued();
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const ask = needsChoice(r);
  return (
    <Stack spacing={1.5}>
      <Typography>{oneConfirm(r)}</Typography>
      {r.message && <Alert severity="error">{r.message}</Alert>}
      {r.state === 'update' && (
        <>
          {ask && (
            <Typography variant="body2" color="text.secondary">
              {t('market.upd.choiceNote')}
            </Typography>
          )}
          <Stack direction="row" spacing={1}>
            {ask ? (
              <>
                <Button variant="contained" disabled={busy} onClick={() => void send('copy')}>
                  {t('market.upd.copy')}
                </Button>
                <Button variant="outlined" color="warning" disabled={busy} onClick={() => void send('overwrite')}>
                  {t('market.upd.overwrite')}
                </Button>
              </>
            ) : (
              <Button variant="contained" disabled={busy || r.modified === 'checking'} onClick={() => void send('')}>
                {t('market.upd.upgrade')}
              </Button>
            )}
          </Stack>
        </>
      )}
      {/* 같은 작업공간이면 패키지 상세(변경 내용·버전)를 함께 보인다(D10). 다른 작업공간 줄은 설치 단추가 그 작업공간을 가리키지 않아 뺀다 */}
      {p && market && <PackageDetail p={p} market={market} onDone={() => onQueued()} />}
    </Stack>
  );
}

export function Market() {
  const qc = useQueryClient();
  // 요청한 사람은 이메일 대신 이름으로 보인다(스펙 2026-10-28-010 §6-3). 사용자 목록은 관리자만 읽으므로 그 밖에는 이메일 그대로
  const nameOf = useNameOfEmail();
  const { closeDrawer, openDrawer } = useUi();
  const { enqueueSnackbar } = useSnackbar();
  const [params, setParams] = useSearchParams();
  const me = useMe();
  const pod = me.data?.pod?.id ?? '';
  // 조회 키에 POD 를 넣는다 — 설치 권한(can_install)이 POD 마다 달라 POD 를 바꾼 뒤 앞 POD 의 값을 잠깐이라도 보이면 안 된다(OMAI-1126 T5)
  const key = ['market', pod];
  // 웹소켓이면 서버가 설치 진행 상태를 보낸다(OMAI-1100). 아니면 기다리는 요청이 있을 때 5초마다 읽는다
  const live = useTopic<MarketData>(me.data?.ws && pod ? `pod:${pod}:market` : null, (v) => qc.setQueryData(key, v));
  const q = useQuery<MarketData>({
    queryKey: key,
    queryFn: () => get<MarketData>('/api/market'),
    enabled: !me.isPending,                                  // POD 를 알기 전에 빈 키로 한 번 더 받지 않는다
    refetchInterval: (query) => (!live && waiting(query.state.data) ? 5000 : false),
  });
  const d = q.data;
  // 큐레이터가 보관한 스킬(되살리기 후보). 못 읽으면 탭만 없다(스펙 2026-10-14-015 R6)
  const arch = useQuery<{ items?: Archived[] }>({
    queryKey: ['market', pod, 'archived'],
    queryFn: () => get<{ items?: Archived[] }>('/api/market/archived'),
    enabled: !me.isPending && !!d && canInstall(d),
  });
  const pubq = useQuery<PublishList>({
    queryKey: ['market', 'publish'],
    queryFn: () => get<PublishList>('/api/market/publish'),
    enabled: !me.isPending && !!d && canInstall(d),
  });
  // 관리자 직접 게시·허브에서 숨기기(스펙 2026-10-29-002). 허브가 설정된 설치에서 관리자에게만
  const hubAdmin = !!pubq.data?.admin && (pubq.data.namespaces ?? []).length > 0;
  const hiddenq = useQuery<{ items?: HiddenRow[] }>({
    queryKey: ['market', 'hub', 'hidden'],
    queryFn: () => get<{ items?: HiddenRow[] }>('/api/market/hub/hidden'),
    enabled: hubAdmin,
  });
  const hiddenRows = hiddenq.data?.items ?? [];
  // 새 버전 있음(스펙 2026-10-24-003 §10). 범위는 주소 scope= 에 둔다(D17)
  const confirm = useConfirm();
  const { closeSnackbar } = useSnackbar();
  const scope = params.get('scope') === 'managed' ? 'managed' : 'pod';
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [batch, setBatch] = useState<Map<string, UpdRow>>(() => new Map());
  const [showHidden, setShowHidden] = useState(false);
  const updq = useQuery<UpdData>({
    queryKey: ['market', pod, 'updates', scope],
    queryFn: () => get<UpdData>(`/api/market/updates?scope=${scope}`),
    enabled: !me.isPending && !!d && canInstall(d),
    // 대기·설치 중인 줄이 있거나 방금 넣은 것이 끝나지 않았으면 5초마다 다시 읽는다(D9)
    refetchInterval: (query) => {
      const rows = query.state.data?.rows ?? [];
      return rows.some((r) => r.state === 'pending' || r.state === 'installing') || progressOf(new Set(batch.keys()), rows).waiting ? 5000 : false;
    },
  });
  if (!d) return <ScreenLoading title={t('market.title')} error={q.error?.message} />;
  const publishes = pubq.data?.items ?? [];
  const archived = arch.data?.items ?? [];

  const pk = d.packages;
  // 태그 거르기(OMAI-1275): 주소 ?tag=a,b 가 정본이다. 지금 어떤 패키지도 갖지 않은 태그는 켜져 있어도 무시한다
  const tagCount = tagCounts(pk);
  const activeTags = (params.get('tag') ?? '').split(',').filter((id) => tagCount.some((c) => c.id === id));
  const setTags = (next: string[]) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (next.length) p.set('tag', next.join(','));
        else p.delete('tag');
        return p;
      },
      { replace: true }
    );
  const pkShown = pk.filter((x) => tagMatches(x, activeTags));
  const refreshTags = async () => {
    try {
      await post('/api/market/tags/refresh', {});
      enqueueSnackbar(t('market.tagsRefreshing'), { variant: 'info' });
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
    }
  };
  const groupById = new Map(pk.map((x) => [x.id, sourceGroup(x.origin)]));
  const inst: Installed[] = d.installed.map((r) => ({ ...r, latest: pk.find((p) => p.id === r.package)?.version }));
  // 설치를 끈 환경(docker compose)이면 그 이유가 먼저다 — 주소를 넣어도 설치는 되지 않으므로 「주소를 설정하세요」는 잘못 이끈다(2026-10-22)
  const notice =
    d.install?.enabled === false
      ? d.install.reason
      : !d.configured
      ? t('market.notConfigured')
      : d.error || (!d.helper.alive ? t('market.helperDownList') : '');

  const done = (toLog: boolean) => {
    closeDrawer();
    if (toLog)
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('tab', 'log');
          return next;
        },
        { replace: true }
      );
    qc.invalidateQueries({ queryKey: ['market'] });
  };
  const toTab = (tab: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('tab', tab);
        return next;
      },
      { replace: true }
    );
  const openPublish = (expected = '') =>
    openDrawer({
      title: expected ? t('market.hub.publishNew') : t('market.hub.publish'),
      sub: expected ? pkgLabel(expected, d.namespace_labels) : undefined,
      body: (
        <HubPublishDrawer
          spaces={pubq.data?.namespaces ?? []}
          labels={(ns) => nsLabel(ns, d.namespace_labels)}
          expected={expected}
          onOpenPkg={(ns, name) => {
            const p = pk.find((x) => x.namespace === ns && x.name === name);
            if (p) openDrawer(packageSpec(p));
            else toTab('pub'); // 허브 목록에 아직 없다(DD14)
          }}
          onOpenPub={() => {
            closeDrawer();
            toTab('pub');
          }}
        />
      ),
    });
  const packageSpec = (p: Pkg) => ({
    title: p.name,
    sub: `${nsLabel(p.namespace, d.namespace_labels)} · v${p.version}`,
    body: <PackageDetail p={p} market={d} onDone={done} onPublishNew={hubAdmin ? openPublish : undefined} />,
  });

  const failedReqs = d.requests.filter((r) => r.status === 'failed').length;

  const ud = updq.data;
  const updRows = ud?.rows ?? [];
  const updShown = shownRows(updRows, showHidden, batch);
  const prog = progressOf(new Set(batch.keys()), updRows);
  const reloadUpd = () => {
    if (!prog.waiting) setBatch(new Map());          // 손으로 다시 읽으면 끝난 줄(완료)을 치운다(D9)
    void updq.refetch();
  };
  const queueSelected = async () => {
    const plan = batchPlan(updRows, picked);
    if (!plan.go.length || !(await confirm(plan.text))) return;
    try {
      await post('/api/market/updates/queue', { items: plan.go.map((r) => ({ pod: r.pod, profile: r.profile, package: r.package, version: r.latest })) });
      setBatch((prev) => new Map([...prev, ...plan.go.map((r): [string, UpdRow] => [rowKey(r), r])]));
      setPicked(new Set());
      enqueueSnackbar(t('market.upd.queued'), { variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['market'] });
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
    }
  };
  const skip = async (r: UpdRow, undo: boolean) => {
    try {
      await post('/api/market/updates/skip', { items: [{ pod: r.pod, profile: r.profile, package: r.package, version: r.latest, undo }] });
      void qc.invalidateQueries({ queryKey: ['market'] });
      if (!undo)
        enqueueSnackbar(t('market.upd.skipped', { v: r.latest }), {
          variant: 'info',
          action: (key: SnackbarKey) => (
            <Button color="inherit" size="small" onClick={() => (closeSnackbar(key), void skip(r, true))}>
              {t('market.upd.undo')}
            </Button>
          ),
        });
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
    }
  };
  const setAuto = async (on: boolean) => {
    if (!(await confirm(on ? t('market.upd.autoOnConfirm', { n: ud?.affected ?? 0 }) : t('market.upd.autoOffConfirm')))) return;
    try {
      await post('/api/market/updates/auto', { enabled: on });
      void updq.refetch();
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
    }
  };
  const setScope = (v: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (v === 'managed') next.set('scope', 'managed');
        else next.delete('scope');
        return next;
      },
      { replace: true }
    );
  const updBanners = ud ? (
    <>
      {ud.hub_ok === false && ud.configured !== false && (
        <Alert severity="warning" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={reloadUpd}>{t('market.upd.reload')}</Button>}>
          {t('market.upd.hubFailed')}
        </Alert>
      )}
      {(ud.pods_failed ?? []).length > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={reloadUpd}>{t('market.upd.reload')}</Button>}>
          {t('market.upd.podsFailed', { n: (ud.pods_failed ?? []).length })}
        </Alert>
      )}
      {batch.size > 0 && (
        <Alert severity="info" role="status" sx={{ mb: 2 }} data-upd-progress="">
          {t('market.upd.progress', prog)}
        </Alert>
      )}
    </>
  ) : null;
  const updToolbar = ud ? (
    <>
      {(ud.managed_count ?? 0) > 1 && (
        <NativeSelect value={scope} onChange={(e) => setScope(e.target.value)} inputProps={{ 'aria-label': t('market.upd.scope') }} sx={{ fontSize: 13 }}>
          <option value="pod">{`${t('market.upd.scope')}: ${t('market.upd.scopePod')}`}</option>
          <option value="managed">{`${t('market.upd.scope')}: ${t('market.upd.scopeManaged', { n: ud.managed_count })}`}</option>
        </NativeSelect>
      )}
      <FormControlLabel
        control={<Checkbox size="small" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />}
        label={<Typography variant="body2">{t('market.upd.showHidden')}</Typography>}
      />
      {ud.admin && (
        <Tooltip title={t('market.upd.auto')}>
          <FormControlLabel
            control={<Switch size="small" checked={ud.auto} onChange={(e) => void setAuto(e.target.checked)} />}
            label={<Typography variant="body2">{t('market.upd.autoShort')}</Typography>}
          />
        </Tooltip>
      )}
      {picked.size > 0 && (
        <Button size="small" color="inherit" onClick={() => setPicked(new Set())}>
          {t('market.upd.clearSelection')}
        </Button>
      )}
      <Button size="small" variant="contained" disabled={!picked.size} onClick={() => void queueSelected()}>
        {t('market.upd.queueSelected', { n: picked.size })}
      </Button>
    </>
  ) : null;
  return (
    <ListView<unknown>
      guide="market.list"
      title={t('market.title')}
      sub={t('market.sub')}
      error={q.error?.message || notice || null}
      // 패키지 서랍(PackageDetail)이 행 밖의 설치 가능 여부·도우미 상태·관리자 여부를 읽는다
      detailKey={[pk, d.install?.enabled, d.install?.reason, d.helper.alive, d.admin, d.can_install]}
      // 보기 카드(2026-10-17-011)가 탭 줄을 대신한다. 「실패한 요청」 수와 대기 안내는 「요청 기록」 보기 카드의 둘째 줄로 옮겼다(§4-1).
      // 게시 요청·보관한 스킬은 따로 받는 조회가 끝난 뒤에야 붙는 조건부 탭이라 거기에도 카드를 단다(§5-4)
      tabs={[
        tabOf<Pkg>({
          id: 'all',
          label: t('market.package'),
          items: pkShown,
          count: pk.length, // 태그로 거르기 전 수(D9)
          card: {
            sub: t('market.srcCount', {
              own: pk.filter((p) => p.origin?.kind === 'own').length,
              ext: pk.filter((p) => isExternal(p.origin)).length,
            }),
          },
          above: (
            <TagBar
              counts={tagCount}
              total={pk.length}
              active={activeTags}
              onToggle={(id) => setTags(activeTags.includes(id) ? activeTags.filter((x) => x !== id) : [...activeTags, id])}
              onClear={() => setTags([])}
              action={
                d.admin ? (
                  <Button startIcon={<RefreshIcon />} size="small" variant="outlined" color="inherit" sx={tier2 as object} onClick={() => void refreshTags()}>
                    {t('market.tagsRefresh')}
                  </Button>
                ) : undefined
              }
            />
          ),
          empty: t('market.emptyPackages'),
          columns: pkgColumns(pk.some(needsGrantNow), tagCount.length > 0),
          rowId: (p) => p.id,
          detail: packageSpec,
        }),
        tabOf<Installed>({
          id: 'inst',
          label: t('market.installedItems'),
          items: inst,
          // 새 버전 수는 서버의 판 비교 결과(update)로 센다(D3, R19)
          card: { sub: t('market.newVersionCount', { n: pk.filter((p) => p.update).length }) },
          empty: t('market.emptyInstalled'),
          columns: installedColumns((r) => groupById.get(r.package) ?? ''),
          rowId: (r) => `${r.profile}/${r.package}`,
          // 설치된 행을 눌러도 같은 패키지 서랍을 연다. 행(r.package)으로 패키지를 다시 찾으므로 목록이 갱신되면 서랍도 따라간다
          detail: (r) => {
            const p = pk.find((x) => x.id === r.package);
            if (p) return packageSpec(p);
            // 허브 목록에 없는 패키지(숨김·삭제): 설치 정보와 「허브에서 내려짐」을 보인다. 관리자가 숨긴 것이면 다시 보이기(DD9)
            const hid = hiddenRows.find((h) => `${h.namespace}/${h.name}` === r.package);
            return {
              title: pkgLabel(r.package, d.namespace_labels),
              sub: profileName(r.profile),
              body: hid ? (
                <Stack spacing={1.5}>
                  <Alert severity="info">{t('market.hub.withdrawn')}</Alert>
                  <HiddenBody r={hid} onDone={() => done(false)} />
                </Stack>
              ) : (
                <Alert severity="info">{t('market.hub.withdrawn')}</Alert>
              ),
            };
          },
        }),
        ...(canInstall(d)
          ? [
              tabOf<UpdRow>({
                id: 'updates',
                label: t('market.upd.tab'),
                tone: updRows.some((r) => r.state === 'failed' || r.state === 'auto_failed') ? 'warn' : undefined,
                items: updShown,
                count: ud ? updRows.filter((r) => r.state === 'update').length : null,
                card: { sub: t('market.upd.cardSub', { n: updRows.filter(selectable).length }) },
                above: updBanners,
                empty: ud ? t('market.upd.empty', { at: fmtTs(ud.checked_at) }) : t('common.loading'),
                columns: updColumns(scope === 'managed'),
                rowId: rowKey,
                select: { selectable, reason: reasonOf, selected: picked, onChange: setPicked },
                actions: [
                  { id: 'skip', label: t('market.upd.skip'), visible: (r) => r.state === 'update' || r.state === 'failed' || r.state === 'auto_failed', onClick: (r) => void skip(r, false) },
                  { id: 'unskip', label: t('market.upd.unskip'), visible: (r) => r.state === 'skipped', onClick: (r) => void skip(r, true) },
                ],
                detail: (r) => ({
                  title: r.skill,
                  sub: `${profileName(r.profile)} · v${r.current || '?'} → v${r.latest}`,
                  body: (
                    <UpdateDetail
                      r={r}
                      p={r.pod === pod ? pk.find((x) => x.id === r.package) : undefined}
                      market={d}
                      onQueued={() => {
                        setBatch((prev) => new Map([...prev, [rowKey(r), r]]));
                        done(false);
                      }}
                    />
                  ),
                }),
              }),
            ]
          : []),
        tabOf<Req>({
          id: 'log',
          label: t('market.requestLog'),
          // 숫자는 요청 기록 전체라, 실패가 있을 때만 경고 색을 쓴다
          tone: failedReqs ? 'warn' : undefined,
          items: d.requests,
          card: { sub: [t('market.failedN', { n: failedReqs }), waiting(d) ? t('market.hasPending') : ''].filter(Boolean).join(' · ') },
          empty: t('market.emptyRequests'),
          columns: requestColumns(),
          // 요청에는 식별자가 없다. 같은 사람이 같은 것을 두 번 요청해도 시각이 다르다
          rowId: (r) => `${r.ts}|${r.mode}|${r.profile}|${r.name}`,
          detail: (r) => ({
            title: `${r.name} → ${r.profile}`,
            sub: fmtTs(r.ts),
            body: (
              <>
              <KV
                pairs={[
                  [t('market.package'), r.package ? <code key="p">{`${pkgLabel(r.package, d.namespace_labels)}@${r.version}`}</code> : ''],
                  [t('market.kind'), kindLabel(r.kind)],
                  [t('market.profile'), r.profile],
                  [t('market.request'), modeLabel(r.mode)],
                  [t('market.who'), nameOf(r.who) ?? r.who_name ?? r.who],
                  [t('market.status'), <StatusTag key="s" s={r.status} />],
                  [t('market.finishedAt'), r.finished ? fmtTs(r.finished) : ''],
                  [t('market.result'), r.message ?? ''],
                  ...(r.backup ? ([[t('market.backup'), <code key="b">{r.backup}</code>]] as [string, ReactNode][]) : []),
                ]}
              />
              <NeedsChoice r={r} market={d} onDone={done} />
              </>
            ),
          }),
        }),
        ...(publishes.length || pubq.data?.admin
          ? [
              tabOf<PublishReq>({
                id: 'pub',
                label: t('market.publishTab'),
                tone: publishes.some((r) => r.status === 'requested') ? 'warn' : undefined,
                items: publishes,
                card: {},
                empty: t('market.publishEmpty'),
                banner: pubq.data?.admin && pubq.data.auto ? { severity: 'info', message: <AutoControl list={pubq.data} /> } : null,
                columns: [
                  nameColumn<PublishReq>({ label: t('market.grid.name'), value: (r) => `${r.name}@${r.version}` }),
                  statusColumn<PublishReq>({ label: t('market.status'), value: (r) => publishStatus(r.status)[0], tone: (r) => publishStatus(r.status)[1] }),
                  { id: 'who', label: t('market.who'), value: (r) => nameOf(r.who) ?? r.who_name ?? r.who, width: 'minmax(120px, 1fr)' },
                  ageColumn<PublishReq>({ id: 'ts', label: t('market.grid.requestedTs'), value: (r) => r.ts }),
                ],
                rowId: (r) => r.id,
                detail: (r) => ({
                  title: r.name,
                  sub: `v${r.version} · ${fmtTs(r.ts)}`,
                  body: <PublishBody r={r} list={pubq.data as PublishList} onDone={() => void qc.invalidateQueries({ queryKey: ['market', 'publish'] })} />,
                }),
              }),
            ]
          : []),
        ...(archived.length
          ? [
              tabOf<Archived>({
                id: 'arch',
                label: t('market.archived'),
                items: archived,
                card: {},
                empty: '',
                columns: [
                  nameColumn<Archived>({ label: t('market.grid.name'), value: (r) => r.skill }),
                  { id: 'profile', label: t('market.profile'), value: (r) => profileName(r.profile), width: 'minmax(96px, 1fr)' },
                ],
                rowId: (r) => `${r.profile}/${r.dir}`,
                detail: (r) => ({ title: r.skill, sub: profileName(r.profile), body: <ArchivedBody a={r} onDone={done} /> }),
              }),
            ]
          : []),
        ...(hubAdmin && hiddenRows.length
          ? [
              tabOf<HiddenRow>({
                id: 'hub',
                label: t('market.hub.hiddenTab'),
                items: hiddenRows,
                card: { sub: t('market.hub.hiddenSub') },
                empty: '',
                columns: [
                  nameColumn<HiddenRow>({ label: t('market.grid.name'), value: (r) => r.name }),
                  { id: 'ns', label: t('market.category'), value: (r) => nsLabel(r.namespace, d.namespace_labels), width: 'minmax(96px, 1fr)' },
                  { id: 'by', label: t('market.hub.hiddenBy'), value: (r) => nameOf(r.by) ?? r.by, width: 'minmax(120px, 1fr)' },
                  ageColumn<HiddenRow>({ id: 'ts', label: t('market.hub.hiddenTs'), value: (r) => r.ts }),
                ],
                rowId: (r) => `${r.namespace}/${r.name}`,
                detail: (r) => ({ title: r.name, sub: nsLabel(r.namespace, d.namespace_labels), body: <HiddenBody r={r} onDone={() => done(false)} /> }),
              }),
            ]
          : []),
      ]}
      id="market"
      titleAction={hubAdmin ? <AddIconButton label={t('market.hub.publish')} onClick={() => openPublish()} /> : undefined}
      gridAction={({ tab }) => (hubAdmin && tab === 'all' ? { label: t('market.hub.publish'), onClick: () => openPublish() } : null)}
      toolbar={({ tab }) => (tab === 'updates' ? updToolbar : null)}
      onRefresh={() => {
        void q.refetch();
        reloadUpd();
      }}
      isFetching={q.isFetching}
      filters={[
        {
          key: 'source',
          label: t('market.grid.origin'),
          // 패키지 행은 자기 출처, 설치한 패키지·요청 행은 패키지 id 로 찾는다
          get: (i) => {
            const x = i as Partial<Pkg & Installed & Req>;
            return groupById.get(x.package ?? x.id ?? `${x.namespace}/${x.name}`) ?? '';
          },
        },
      ]}
      text={(i) => {
        const x = i as Partial<Pkg & Req>;
        // 화면에 보이는 이름(shared)으로도 찾는다
        return [x.name, x.summary, x.summary_src, x.namespace, x.namespace && nsLabel(x.namespace, d.namespace_labels), x.profile, x.message, (x.tags ?? []).map(tagLabel).join(' ')].filter(Boolean).join(' ');
      }}
    />
  );
}
