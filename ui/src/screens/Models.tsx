/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 모델: 프로파일이 쓰는 모델과 LiteLLM 이 내놓는 모델. 서랍에서 모델에 1토큰짜리 호출을 보내 점검한다.
import NetworkCheckOutlinedIcon from '@mui/icons-material/NetworkCheckOutlined';
import { Alert, Button, Typography } from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import { ChatChip, Issue, IssueList, KV, LinkChip, ScreenLoading, Section, Tag } from '@/components/bits';
import { GridColumn, nameColumn, Pill, profileNameColumn, statusColumn } from '@/components/DataGrid';
import type { PageOf } from '@/components/drawerPages';
import { useDrawerHead } from '@/components/drawerScope';
import { ListView, tabOf, Tone } from '@/components/ListView';
import { useRoutePage } from '@/components/useRoutePage';
import { t } from '@/i18n';
import { get, post } from '@/lib/api';
import { useIsAdmin } from '@/lib/data';

interface ModelRef {
  model: string;
  provider?: string;
}
interface ModelInfo {
  id: string;
  in_litellm: boolean | null;
  aas_model?: boolean;
  /** 프로파일 하나라도 AAS LiteLLM 이 아닌 주소로 이 모델을 부른다(OMAI-1857 D5·D19). 가드가 막는다 */
  blocked_route?: boolean;
  blocked_profiles?: { profile: string; host: string }[];
  primary: string[];
  fallback: string[];
  auxiliary: string[];
  cron: string[];
}
interface ProfileModels {
  name: string;
  has_config: boolean;
  primary?: ModelRef | null;
  fallbacks?: ModelRef[];
  auxiliary?: { task: string; model: string }[];
  cron_overrides?: { jobs: string[]; model: string }[];
  issues: Issue[];
}
interface ModelsData {
  /** AAS 기본 모델 이름(서버 설정). 그 모델 옆에 「기본 모델」 뱃지 */
  default_model?: string;
  litellm: {
    url: string;
    reachable: boolean;
    auth: string;
    error?: string;
    key_source?: string;
    prefix?: string;
    hidden?: number;
  };
  totals: {
    litellm_models: number;
    profiles_with_bad: number;
    profiles_with_warn: number;
    fallback_trace_jobs: number;
    unused_models: number;
    blocked_routes?: number;
  };
  models: ModelInfo[];
  profiles: ProfileModels[];
}
interface Probe {
  pending?: boolean;
  ok?: boolean;
  ms?: number;
  error?: string;
}

const who = (a: string[]) =>
  a.length ? (a.length > 4 ? t('models.profileCount', { count: a.length }) : a.join(', ')) : t('models.none');
const seconds = (p: Probe) => t('models.responseSeconds', { seconds: ((p.ms ?? 0) / 1000).toFixed(1) });

/** 허용되지 않은 경로가 「LiteLLM 에 없음」·「AAS 모델 아님」보다 앞선다 — 경고 하나만(D5) */
const InLitellm = ({ m }: { m: ModelInfo }) =>
  m.blocked_route ? (
    <span title={t('models.blockedRouteTip', { hosts: blockedHosts(m) })}>
      <Tag tone="bad">{t('models.blockedRoute')}</Tag>
    </span>
  ) : m.in_litellm === true ? (
    <Tag tone="good">{t('models.inLitellm')}</Tag>
  ) : m.in_litellm === false ? (
    <Tag tone="bad">{t('models.notInLitellm')}</Tag>
  ) : (
    <Tag>{t('models.litellmUnknown')}</Tag>
  );

const blockedHosts = (m: ModelInfo) => [...new Set((m.blocked_profiles ?? []).map((b) => b.host))].join(', ');
const litellmText = (m: ModelInfo) =>
  m.blocked_route ? t('models.blockedRoute') : m.in_litellm === true ? t('models.inLitellm') : m.in_litellm === false ? t('models.notInLitellm') : t('models.litellmUnknown');
const litellmTone = (m: ModelInfo): Tone | undefined =>
  m.blocked_route ? 'bad' : m.in_litellm === true ? 'good' : m.in_litellm === false ? 'bad' : undefined;
const levelOf = (p: ProfileModels): [string, Tone] =>
  p.issues.some((i) => i.level === 'bad')
    ? [t('models.levelBad'), 'bad']
    : p.issues.length
    ? [t('models.levelWarn'), 'warn']
    : [t('models.levelOk'), 'good'];

const NotAas = ({ m }: { m: ModelInfo }) =>
  m.aas_model === false && !m.blocked_route ? <Tag tone="warn">{t('models.notAasModel')}</Tag> : null;

const Names = ({ names }: { names: string[] }) =>
  names.length ? (
    <>
      {names.map((n) => (
        <LinkChip key={n} to="models" params={{ tab: 'profiles', q: n }}>
          {n}
        </LinkChip>
      ))}
    </>
  ) : (
    <Typography color="text.secondary">{t('models.none')}</Typography>
  );

const Ref = ({ r }: { r?: ModelRef | null }) =>
  r ? (
    <>
      <code>{r.model}</code>
      {r.provider && (
        <Typography component="span" variant="caption" color="text.secondary">
          {' ' + r.provider}
        </Typography>
      )}
    </>
  ) : (
    <Typography component="span" color="text.secondary">
      {t('models.none')}
    </Typography>
  );

function ProbePanel({
  m,
  initial,
  onResult,
}: {
  m: ModelInfo;
  initial?: Probe;
  onResult: (id: string, p: Probe) => void;
}) {
  const [p, setP] = useState<Probe | undefined>(initial);
  const run = async () => {
    setP({ pending: true });
    let res: Probe;
    try {
      res = await post<Probe>('/api/models/probe', { model: m.id });
    } catch (e) {
      res = { ok: false, error: (e as Error).message };
    }
    setP(res);
    onResult(m.id, res);
  };
  return (
    <>
      {/* 막히는 경로는 시험 호출이 AAS LiteLLM 으로 가서 프로파일의 실제 경로를 보지 못한다 — 누르지 못하게 하고 이유를 보인다(D19) */}
      <span title={m.blocked_route ? t('models.probeBlockedTip') : undefined}>
        <Button
          startIcon={<NetworkCheckOutlinedIcon />}
          variant="contained"
          size="small"
          disabled={m.in_litellm === false || !!m.blocked_route || !!p?.pending}
          onClick={run}
        >
          {t('models.probe')}
        </Button>
      </span>
      <div>
        {p?.pending ? (
          <Typography color="text.secondary">{t('models.calling')}</Typography>
        ) : p?.ok ? (
          <Tag tone="good">{seconds(p)}</Tag>
        ) : p ? (
          <>
            <Tag tone="bad">{t('models.failed')}</Tag>
            <pre style={{ whiteSpace: 'pre-wrap' }}>{p.error || t('models.error')}</pre>
          </>
        ) : null}
      </div>
      <Typography variant="caption" color="text.secondary" component="p">
        {t('models.probeNote')}
      </Typography>
    </>
  );
}

// 시험 호출 결과는 목록의 배지와 모델 서랍(ModelPage)이 함께 본다. 서랍 본문은 화면 밖(DrawerHost)에서 그려 화면 상태를 받지 못해
// 조회 캐시에 둔다. 서버에서 읽는 값이 아니라 조회는 하지 않는다(enabled: false)
const PROBES = ['models-probes'];
function useProbes(): [Record<string, Probe>, (id: string, p: Probe) => void] {
  const qc = useQueryClient();
  const q = useQuery<Record<string, Probe>>({ queryKey: PROBES, queryFn: () => ({}), initialData: {}, enabled: false });
  const set = useCallback((id: string, p: Probe) => qc.setQueryData<Record<string, Probe>>(PROBES, (prev) => ({ ...prev, [id]: p })), [qc]);
  return [q.data, set];
}

/** 모델 서랍 본문 */
function ModelDetail({ m }: { m: ModelInfo }) {
  const [probes, setProbe] = useProbes();
  const admin = useIsAdmin();
  return (
    <>
      <KV
        pairs={[
          [
            'LiteLLM',
            <>
              <InLitellm m={m} />
              <NotAas m={m} />
            </>,
          ],
          [t('models.auxCron'), [...m.auxiliary, ...m.cron].join(', ')],
        ]}
      />
      {m.blocked_route && (
        <Section title={t('models.blockedRoute')}>
          <Typography variant="body2" sx={{ mb: 1 }}>
            {t('models.blockedRouteText')}
          </Typography>
          {(m.blocked_profiles ?? []).map((b) => (
            <Typography key={b.profile} variant="body2">
              <LinkChip to="models" params={{ tab: 'profiles', q: b.profile }}>
                {b.profile}
              </LinkChip>{' '}
              <code>{b.host}</code>
            </Typography>
          ))}
        </Section>
      )}
      <Section title={t('models.primaryProfiles')}>
        <Names names={m.primary} />
      </Section>
      <Section title={t('models.fallbackProfiles')}>
        <Names names={m.fallback} />
      </Section>
      {admin && ( // 모델 시험 호출은 관리자만(OMAI-1122)
        <Section title={t('models.probe')}>
          <ProbePanel m={m} initial={probes[m.id]} onResult={setProbe} />
        </Section>
      )}
    </>
  );
}

/** 모델 행 서랍(스펙 2026-10-28-014 D8). 행 클릭·주소 ?open=<모델 id> 가 이 페이지로 연다. 목록과 같은 조회를 스스로 읽는다 */
export function ModelPage({ page }: { page: PageOf<'model'> }) {
  const q = useQuery<ModelsData>({ queryKey: ['models'], queryFn: () => get<ModelsData>('/api/models') });
  const m = q.data?.models.find((x) => x.id === page.id);
  useDrawerHead(m ? { title: m.id, sub: t('models.title') } : null);
  if (!m) return q.data ? <Alert severity="warning">{t('models.notFound', { id: page.id })}</Alert> : <ScreenLoading title={page.id} error={q.error?.message} />;
  return <ModelDetail m={m} />;
}

// 공통 표의 열(OMAI-1127). 두 줄 목록의 LiteLLM·점검 태그 → LiteLLM 칸, 둘째 줄의 주 모델·폴백 → 열
/** 기본 모델(서버 설정 HERMES_LLM_MODEL) 이름 옆에 「기본 모델」 뱃지(2026-10-18) */
function withDefaultTag(col: GridColumn<ModelInfo>, defaultModel?: string): GridColumn<ModelInfo> {
  if (!defaultModel) return col;
  return {
    ...col,
    render: (m: ModelInfo) => (
      <>
        {col.render ? col.render(m) : m.id}
        {m.id === defaultModel && <Pill tone="good">{t('models.defaultModel')}</Pill>}
      </>
    ),
  };
}

const modelColumns = (probes: Record<string, Probe>, defaultModel?: string): GridColumn<ModelInfo>[] => [
  withDefaultTag(nameColumn<ModelInfo>({ label: t('models.grid.model'), value: (m) => m.id }), defaultModel),
  statusColumn<ModelInfo>({
    id: 'litellm',
    label: 'LiteLLM',
    value: litellmText,
    tone: litellmTone,
    extra: (m) => {
      const p = probes[m.id];
      return (
        <>
          {m.aas_model === false && !m.blocked_route && <Pill tone="warn">{t('models.notAasModel')}</Pill>}
          {m.primary.length + m.fallback.length === 0 && <Pill>{t('models.unused')}</Pill>}
          {p &&
            (p.pending ? (
              <Pill>{t('models.probing')}</Pill>
            ) : p.ok ? (
              <Pill tone="good">{seconds(p)}</Pill>
            ) : (
              <Pill tone="bad">{t('models.probeFailed')}</Pill>
            ))}
        </>
      );
    },
  }),
  { id: 'primary', label: t('models.primaryProfiles'), value: (m) => (m.primary.length ? who(m.primary) : ''), width: 'minmax(140px, 1.5fr)' },
  { id: 'fallback', label: t('models.fallbackProfiles'), value: (m) => (m.fallback.length ? who(m.fallback) : ''), width: 'minmax(140px, 1.5fr)' },
  { id: 'aux', label: t('models.auxCron'), value: (m) => [...m.auxiliary, ...m.cron].join(', '), width: 'minmax(140px, 1fr)', hidden: true },
];
const profileColumns = (): GridColumn<ProfileModels>[] => [
  profileNameColumn<ProfileModels>({ label: t('models.grid.profile'), value: (p) => p.name }),
  statusColumn<ProfileModels>({ label: t('models.grid.status'), value: (p) => levelOf(p)[0], tone: (p) => levelOf(p)[1] }),
  {
    id: 'primary',
    label: t('models.primary'),
    value: (p) => (p.has_config ? p.primary?.model || t('models.none') : t('models.noConfigFile')),
    width: 'minmax(140px, 1.5fr)',
  },
  {
    id: 'fallback',
    label: t('models.fallback'),
    value: (p) => (p.has_config ? (p.fallbacks ?? []).map((f) => f.model).join(', ') : ''),
    width: 'minmax(140px, 1.5fr)',
  },
  {
    id: 'issues',
    label: t('models.review'),
    value: (p) => p.issues.map((i) => i.text).join(' · '),
    width: 'minmax(200px, 2fr)',
  },
];

export function Models() {
  const q = useQuery<ModelsData>({ queryKey: ['models'], queryFn: () => get<ModelsData>('/api/models') });
  const [probes] = useProbes();
  // 모델 탭의 행 서랍은 주소 ?open=<모델 id>(+pod)와 묶인다(스펙 2026-10-28-014 D8). 프로파일별 탭은 아래 detail 그대로다
  const route = useRoutePage('models');
  const d = q.data;
  if (!d) return <ScreenLoading title={t('models.title')} error={q.error?.message} />;

  const g = d.litellm;
  const tot = d.totals;
  const unreachable =
    !g.reachable || g.auth !== 'ok'
      ? t('models.unreachable', { error: !g.url ? t('models.noUrl') : g.error || t('models.listFailed') })
      : '';

  return (
    <ListView<unknown>
      guide="models.list"
      title={t('models.title')}
      // 주소·키 출처 글자 대신 이름 뱃지를 보인다. 주소와 키 출처는 풍선말
      sub={
        <span title={g.auth === 'ok' ? `${g.url} · ${t('models.keySource', { source: g.key_source })}` : g.url}>
          <Tag>{t('models.litellmBadge')}</Tag>
        </span>
      }
      error={unreachable || null}
      // 보기 카드(2026-10-17-011): 카드 숫자는 표의 행 수다. LiteLLM 모델 수와 문제 프로파일 수는 둘째 줄 지표로 옮겼다(§4-1)
      cards={[
        {
          n: tot.fallback_trace_jobs,
          label: t('models.fallbackJobs'),
          sub: t('models.fallbackJobsSub'),
          tone: tot.fallback_trace_jobs ? 'bad' : 'good',
        },
        { n: tot.unused_models, label: t('models.unusedModels'), sub: t('models.unusedModelsSub') },
      ]}
      tabs={[
        tabOf<ModelInfo>({
          id: 'models',
          label: t('models.title'),
          items: d.models,
          card: {
            sub: t('models.cardModelsSub', {
              n: tot.litellm_models,
              filter:
                g.auth !== 'ok'
                  ? t('models.notQueried')
                  : g.prefix
                    ? t('models.prefixOnly', { prefix: g.prefix, count: g.hidden ?? 0 })
                    : t('models.noFilter'),
            }),
          },
          columns: modelColumns(probes, d.default_model),
          rowId: (m) => m.id,
          onRow: (m) => route.openRow(m.id),
        }),
        tabOf<ProfileModels>({
          id: 'profiles',
          label: t('models.byProfile'),
          items: d.profiles,
          tone: tot.profiles_with_bad ? 'warn' : undefined,
          card: { sub: t('models.cardProfilesSub', { n: tot.profiles_with_bad, warn: tot.profiles_with_warn }) },
          columns: profileColumns(),
          rowId: (p) => p.name,
          detail: (p) => ({
            title: p.name,
            sub: t('models.profileModelConfig'),
            body: (
              <>
                <KV
                  pairs={[
                    [t('models.primary'), p.has_config ? <Ref key="p" r={p.primary} /> : t('models.noConfig')],
                    [
                      t('models.fallback'),
                      p.fallbacks?.length
                        ? p.fallbacks.map((f) => (
                            <div key={f.model}>
                              <Ref r={f} />
                            </div>
                          ))
                        : t('models.noFallback'),
                    ],
                    [t('models.auxTasks'), (p.auxiliary ?? []).map((a) => `${a.task}: ${a.model}`).join(', ')],
                    [
                      t('models.cronOverride'),
                      (p.cron_overrides ?? [])
                        .map((c) => t('models.jobsModel', { count: c.jobs.length, model: c.model }))
                        .join(', '),
                    ],
                  ]}
                />
                <Section title={t('models.review')}>
                  <IssueList issues={p.issues} />
                </Section>
                <Section title={t('models.seeNext')}>
                  <LinkChip to="profiles" params={{ name: p.name }} page>{t('models.profileSettings', { name: p.name })}</LinkChip>
                  <LinkChip to="cron" params={{ tab: 'profiles', q: p.name }}>{t('models.profileCron', { name: p.name })}</LinkChip>
                  <ChatChip agent={p.name}>{t('models.profileChat', { name: p.name })}</ChatChip>
                </Section>
              </>
            ),
          }),
        }),
      ]}
      id="models"
      openId={route.open}
      clearOnTab={route.clearOnTab}
      onRefresh={() => void q.refetch()}
      isFetching={q.isFetching}
      text={(i) => {
        const m = i as ModelInfo;
        const p = i as ProfileModels;
        return [m.id, p.name, p.primary?.model, (p.issues ?? []).map((v) => v.text).join(' ')]
          .filter(Boolean)
          .join(' ');
      }}
    />
  );
}
