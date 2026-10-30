/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// Cron 작업: 열린 사건, 실패, 멈춤, 알림 없음, 전체 작업, 프로파일별. 작업 서랍에서 일정과 실행을 바꾼다.
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined';
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import ScheduleOutlinedIcon from '@mui/icons-material/ScheduleOutlined';
import { Alert, Box, Button, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useSearchParams } from 'react-router-dom';

import { AddAction, AddIconButton } from '@/components/AddIconButton';
import { ProfileChip } from '@/components/AgentChip';
import { ChatChip, KV, LinkChip, ScreenLoading, Section, Tag } from '@/components/bits';
import { ageColumn, GridColumn, nameColumn, Pill, profileNameColumn, statusColumn } from '@/components/DataGrid';
import type { PageOf } from '@/components/drawerPages';
import { useDrawerHead } from '@/components/drawerScope';
import { ListTab, ListView, tabOf, Tone } from '@/components/ListView';
import { TeamTargetNote } from '@/components/TeamTargetNote';
import { useUi } from '@/components/UiContext';
import { useRoutePage } from '@/components/useRoutePage';
import { t } from '@/i18n';
import { viewerAgentLabel } from '@/lib/agentLabel';
import { get } from '@/lib/api';
import { openChat } from '@/lib/chatPopup';
import { describe } from '@/lib/cronmath';
import { useHealth, useMe } from '@/lib/data';
import { useEditColumn } from '@/lib/editLink';
import { fmtTs } from '@/lib/format';
import { MONO_FONT } from '@/lib/monoFont';
import { badgeTone, isOffBadge, serverTerm } from '@/lib/serverTerms';

import { jobDrawerSpec } from './cron/JobDrawer';
import { NewJobBody } from './cron/NewJob';
import type { CronHealth, FailedJob, Incident, MutedJob, ProfileCron, SilentJob, StalledJob } from './cron/types';
const short = (s: unknown, n = 90) => {
  const t = String(s || '').replace(/\s+/g, ' ');
  return t.length > n ? t.slice(0, n) + '…' : t;
};
const dur = (h: number) =>
  h >= 48 ? t('cron.days', { count: Math.round(h / 24) }) : t('cron.hours', { count: Math.round(h) });
const nowInfo = (now: string): [string, Tone | undefined, string] =>
  (
    ({
      ok: [t('cron.nowOk'), 'good', t('cron.nowOkNote')],
      off: [t('cron.nowOff'), undefined, t('cron.nowOffNote')],
      gone: [t('cron.nowGone'), undefined, t('cron.nowGoneNote')],
      failing: [t('cron.nowFailing'), 'bad', ''],
    }) as Record<string, [string, Tone | undefined, string]>
  )[now];

function Block({ text, onCopy }: { text?: string; onCopy: () => void }) {
  if (!text) return null;
  return (
    <Section title={t('cron.errorTitle')}>
      <Box
        component="pre"
        sx={{ whiteSpace: 'pre-wrap', fontFamily: MONO_FONT, fontSize: 13, p: 1, bgcolor: 'action.hover' }}
      >
        {text}
      </Box>
      <Button startIcon={<ContentCopyOutlinedIcon />} size="small" onClick={onCopy}>
        {t('cron.copyError')}
      </Button>
    </Section>
  );
}

function useCopy() {
  const { enqueueSnackbar } = useSnackbar();
  return async (text: string, done: string) => {
    try {
      await navigator.clipboard.writeText(text);
      enqueueSnackbar(done, { variant: 'success' });
    } catch {
      enqueueSnackbar(t('cron.copyFailed'), { variant: 'error' });
    }
  };
}

// 서랍을 닫지 않고 대화 팝업에 물을 글을 채워 연다(OMAI-1115). 예전에는 서랍을 닫고 채팅 화면으로 갔다.
function AskLink({ profile, text }: { profile: string; text: string }) {
  return (
    <Button startIcon={<AutoAwesomeOutlinedIcon />}
      variant="contained"
      size="small"
      onClick={() => openChat({ kind: 'chat', agent: profile, text })}
      title={t('cron.askTitle')}
    >
      {t('cron.askButton')}
    </Button>
  );
}

function Manage({ r }: { r: { profile: string; job_id?: string; job: string } }) {
  const { openDrawer } = useUi();
  if (!r.job_id) return null;
  return (
    <Section title={t('cron.manage')}>
      <Button startIcon={<ScheduleOutlinedIcon />} variant="outlined" onClick={() => openDrawer(jobDrawerSpec(r.profile, r.job_id as string, r.job))}>
        {t('cron.manageButton')}
      </Button>
    </Section>
  );
}

const SkillLinks = ({ r }: { r: { profile: string; skills?: string[] } }) =>
  r.skills?.length ? (
    <Section title={t('cron.skillsUsed')}>
      {r.skills.map((s) => (
        <LinkChip key={s} to="skills" params={{ tab: 'all', profile: r.profile, q: s }}>
          {s}
        </LinkChip>
      ))}
    </Section>
  ) : null;

const Also = ({ r }: { r: { profile: string; job_id?: string } }) => (
  <Section title={t('cron.alsoSee')}>
    {r.job_id && (
      <LinkChip to="flows" params={{ root: `cron:${r.profile}/${r.job_id}` }} page={{ kind: 'skillMap', root: `cron:${r.profile}/${r.job_id}` }}>
        {t('cron.flowPicture')}
      </LinkChip>
    )}
    <LinkChip to="profiles" params={{ name: r.profile }} page>{t('cron.profileSettings', { profile: r.profile })}</LinkChip>
    <LinkChip to="cron" params={{ tab: 'profiles', q: r.profile }}>{t('cron.otherJobs', { profile: r.profile })}</LinkChip>
    <LinkChip to="channels" params={{ tab: 'all', q: r.profile }}>{t('cron.channelsGateways', { profile: r.profile })}</LinkChip>
    <ChatChip agent={r.profile}>{t('cron.chatWith', { profile: r.profile })}</ChatChip>
  </Section>
);

const code = (v?: string | null) => (v ? <code>{v}</code> : '');

function IncidentDetail({ r }: { r: Incident }) {
  const copy = useCopy();
  return (
    <>
      {r.now !== 'failing' && <Alert severity="info">{nowInfo(r.now)[2] + t('cron.closeWithAck')}</Alert>}
      <KV
        pairs={[
          [t('cron.profile'), r.profile],
          [
            t('cron.nowLabel'),
            <Tag key="n" tone={nowInfo(r.now)[1]}>
              {nowInfo(r.now)[0]}
            </Tag>,
          ],
          [
            t('cron.noticeLabel'),
            r.state === 'detected' ? t('cron.noticeDetectedOnly') : t('cron.noticeSent'),
          ],
          [t('cron.openFor'), r.age_days == null ? '—' : t('cron.days', { count: r.age_days })],
          [t('cron.lastSeen'), fmtTs(r.last_seen_at)],
          [t('cron.jobId'), code(r.job_id)],
          [t('cron.incidentId'), code(r.id)],
        ]}
      />
      <Block text={r.error} onCopy={() => copy(r.error ?? '', t('cron.errorCopied'))} />
      <Section title={t('cron.todo')}>
        {r.now === 'failing' && (
          <AskLink
            profile={r.profile}
            text={
              t('cron.askIncident', {
                job: r.job,
                jobId: r.job_id,
                id: r.id,
                days: r.age_days ?? '?',
                error: r.error,
              }) + t('cron.askTail')
            }
          />
        )}{' '}
        {r.ack && (
          <Button
            startIcon={<ContentCopyOutlinedIcon />}
            variant={r.now === 'failing' ? 'outlined' : 'contained'}
            size="small"
            title={r.ack}
            onClick={() => copy(r.ack as string, t('cron.ackCopied'))}
          >
            {t('cron.copyAck')}
          </Button>
        )}
        <Typography variant="caption" color="text.secondary" component="p">
          {t('cron.noAutoAck')}
        </Typography>
      </Section>
      {r.now !== 'gone' && <Manage r={r} />}
      <Also r={r} />
    </>
  );
}

// 주소(?tab=incidents|settled&open=<사고 id>)로 연 사고 서랍(스펙 2026-10-28-014 T7). 무시한 작업의 사고도 찾는다 — 링크는 탭과 관계없이 그 사고를 연다
export function IncidentPage({ page }: { page: PageOf<'cronIncident'> }) {
  const health = useHealth();
  const r = (health.data as unknown as CronHealth | undefined)?.incidents.find((x) => x.id === page.id);
  useDrawerHead(r ? { title: r.job, sub: t('cron.subOpenIncident', { profile: r.profile }) } : null);
  if (!r)
    return health.data ? (
      <Alert severity="warning">{t('cron.incidentNotFound', { id: page.id })}</Alert>
    ) : (
      <ScreenLoading title={page.id} error={health.error?.message} />
    );
  return <IncidentDetail r={r} />;
}

function ProfileSummary({ p }: { p: ProfileCron }) {
  return (
    <>
      <KV
        pairs={[
          [t('cron.jobsLabel'), t('cron.jobsValue', { total: p.jobs_total, active: p.jobs_active })],
          [t('cron.openIncidents'), p.open_incidents],
          [t('cron.tabFailed'), p.failed_jobs],
          [t('cron.tabStalled'), p.stalled_jobs],
          [t('cron.tabSilent'), p.silent_jobs],
          [t('cron.runs7d'), t('cron.times', { count: p.runs_7d })],
          [
            t('cron.failed7d'),
            p.runs_7d
              ? t('cron.failed7dValue', {
                  n: p.runs_failed_7d,
                  pct: Math.round((100 * p.runs_failed_7d) / p.runs_7d),
                })
              : '—',
          ],
          [
            t('cron.remarks'),
            [
              (
                {
                  no_incident_table: t('cron.noIncidentTable'),
                  no_db: t('cron.noDb'),
                  error: t('cron.readFailed'),
                } as Record<string, string>
              )[p.exec_status ?? ''],
              p.stale ? t('cron.stale') : '',
              p.detail,
            ]
              .filter(Boolean)
              .join(' · '),
          ],
        ]}
      />
      <Section title={t('cron.thisProfileOnly')}>
        {(
          [
            ['incidents', t('cron.openIncidents')],
            ['failed_jobs', t('cron.failedShort')],
            ['stalled', t('cron.stalledShort')],
            ['silent', t('cron.noNotice')],
          ] as const
        ).map(([tab, l]) => (
          <LinkChip key={tab} to="cron" params={{ tab, profile: p.name }}>
            {l}
          </LinkChip>
        ))}
      </Section>
      <Also r={{ profile: p.name }} />
    </>
  );
}

// 주소(?tab=profiles&open=<프로파일>)로 연 프로파일 요약 서랍(T7). 프로파일 화면의 서랍이 아니라 이 화면의 「예약 작업 요약」이다
export function CronProfilePage({ page }: { page: PageOf<'cronProfile'> }) {
  const health = useHealth();
  const p = (health.data as unknown as CronHealth | undefined)?.profiles.find((x) => x.name === page.name);
  useDrawerHead(p ? { title: p.name, sub: t('cron.profileSummary') } : null);
  if (!p)
    return health.data ? (
      <Alert severity="warning">{t('cron.profileNotFound', { id: page.name })}</Alert>
    ) : (
      <ScreenLoading title={page.name} error={health.error?.message} />
    );
  return <ProfileSummary p={p} />;
}

// ── 공통 표의 열(OMAI-1127). 두 줄 목록의 태그 → 상태·이유 칸, 둘째 줄의 프로파일·일정·오류 → 열, 오른쪽 기간·시각 → 열 ──
// 프로파일 열 id 는 필터 키와 같은 'profile' 이다
const jobCol = <T extends { job: string }>(): GridColumn<T> => nameColumn<T>({ id: 'job', label: t('cron.grid.job'), value: (r) => r.job });
const profileCol = <T extends { profile: string }>(): GridColumn<T> => ({
  id: 'profile',
  label: t('cron.profile'),
  value: (r) => r.profile,
  width: 'minmax(96px, auto)',
  render: (r) => (r.profile ? <ProfileChip name={r.profile} size="sm" /> : null),
});
const scheduleCol = <T extends { schedule?: string }>(): GridColumn<T> => ({
  id: 'schedule',
  label: t('cron.schedule'),
  value: (r) => r.schedule,
  width: 'minmax(96px, auto)',
});
const errorCol = <T,>(get: (r: T) => string | undefined): GridColumn<T> => ({
  id: 'error',
  label: t('cron.grid.error'),
  value: (r) => short(get(r), 200),
  width: 'minmax(200px, 3fr)',
});

const incidentColumns = (): GridColumn<Incident>[] => [
  jobCol<Incident>(),
  profileCol<Incident>(),
  statusColumn<Incident>({
    id: 'now',
    label: t('cron.nowLabel'),
    value: (r) => nowInfo(r.now)[0],
    tone: (r) => nowInfo(r.now)[1],
    extra: (r) => (
      <>
        {r.new && <Pill tone="bad">{t('cron.new')}</Pill>}
        {r.now === 'failing' && (
          <Pill tone={r.state === 'detected' ? 'warn' : undefined}>{r.state === 'detected' ? t('cron.notSent') : t('cron.sent')}</Pill>
        )}
      </>
    ),
  }),
  errorCol<Incident>((r) => r.error),
  {
    id: 'age_days',
    label: t('cron.openFor'),
    value: (r) => r.age_days ?? undefined,
    width: '88px',
    num: true,
    render: (r) => (r.age_days == null ? '' : t('cron.daysOpen', { count: r.age_days })),
  },
  ageColumn<Incident>({ id: 'last_seen_at', label: t('cron.lastSeen'), value: (r) => r.last_seen_at }),
];
const failPct = (p: ProfileCron) => (p.runs_7d ? Math.round((100 * p.runs_failed_7d) / p.runs_7d) : undefined);
const profileColumns = (): GridColumn<ProfileCron>[] => [
  profileNameColumn<ProfileCron>({ label: t('cron.profile'), value: (p) => p.name }),
  {
    id: 'status',
    label: t('cron.grid.status'),
    value: (p) => p.open_incidents + p.failed_jobs + p.stalled_jobs + p.silent_jobs,
    width: 'minmax(140px, 1.5fr)',
    render: (p) => (
      <>
        {!!p.open_incidents && <Pill tone="bad">{t('cron.tagIncidents', { n: p.open_incidents })}</Pill>}
        {!!p.failed_jobs && <Pill tone="bad">{t('cron.tagFailed', { n: p.failed_jobs })}</Pill>}
        {!!p.stalled_jobs && <Pill tone="bad">{t('cron.tagStalled', { n: p.stalled_jobs })}</Pill>}
        {!!p.silent_jobs && <Pill tone="warn">{t('cron.tagSilent', { n: p.silent_jobs })}</Pill>}
        {!(p.open_incidents || p.failed_jobs || p.stalled_jobs || p.silent_jobs) &&
          (p.jobs_total ? <Pill tone="good">{t('cron.allClear')}</Pill> : t('cron.noJobs'))}
      </>
    ),
  },
  { id: 'jobs_total', label: t('cron.grid.jobs'), value: (p) => p.jobs_total, width: '72px', num: true },
  { id: 'jobs_active', label: t('cron.grid.active'), value: (p) => p.jobs_active, width: '72px', num: true },
  { id: 'runs_7d', label: t('cron.runs7d'), value: (p) => p.runs_7d, width: '88px', num: true },
  {
    id: 'fail_pct',
    label: t('cron.grid.failRate'),
    value: failPct,
    width: '104px',
    num: true,
    render: (p) => (failPct(p) == null ? '' : `${failPct(p)}%`),
  },
  {
    id: 'remarks',
    label: t('cron.remarks'),
    value: (p) => [p.stale ? t('cron.stale') : '', p.exec_status === 'error' ? t('cron.readFailed') : ''].filter(Boolean).join(' · '),
    width: 'minmax(140px, 1fr)',
  },
];
// 서버의 sub 는 「<프로파일> · <주기>」다
const flowSchedule = (j: FlowStart) => j.sub.slice(j.sub.indexOf(' · ') + 3);
const jobKey = (r: { profile: string; job_id?: string; job: string }) => `${r.profile}/${r.job_id ?? r.job}`;
// 작업 서랍의 주소 값 「프로파일/작업」. 흐름 행의 id 는 「cron:프로파일/작업」 꼴일 수 있어 앞의 종류 글자를 뗀다
const flowKey = (j: { id: string; profile: string }) => `${j.profile}/${j.id.slice(j.id.indexOf('/') + 1)}`;

interface FlowStart {
  id: string;
  label: string;
  sub: string;
  profile: string;
  status: string;
  badges: string[];
  skills: string[];
  scripts: string[];
  note?: string;
}

export function Cron() {
  const { openDrawer } = useUi();
  const health = useHealth();
  const flows = useQuery<{ starts: FlowStart[] }>({
    queryKey: ['flows'],
    queryFn: () => get('/api/flows'),
    staleTime: 60000,
  });
  // 행 서랍은 주소 ?open=(+pod)과 묶인다(스펙 2026-10-28-014 D8·D12). open 은 탭과 함께 읽는다 — 작업 탭은 「프로파일/작업」,
  // 사고 탭(실패 중·이미 해결)은 사고 id, 프로파일 탭은 프로파일 이름(T7). 실패·멈춤·알림 없음·무시 탭의 서랍은 주소에 넣지 않는다
  const route = useRoutePage('cron');

  return (
    <CronBody
      health={health.data as unknown as CronHealth | undefined}
      error={health.error?.message}
      flows={flows.data?.starts}
      openDrawer={openDrawer}
      route={route}
    />
  );
}

interface BodyProps {
  health?: CronHealth;
  error?: string;
  flows?: FlowStart[];
  openDrawer: ReturnType<typeof useUi>['openDrawer'];
  route: ReturnType<typeof useRoutePage>;
}

function CronBody({ health: d, error, flows, openDrawer, route }: BodyProps) {
  const [qs] = useSearchParams();
  const me = useMe();
  const copy = useCopy();
  const openJob = (profile: string, id: string, label?: string) => openDrawer(jobDrawerSpec(profile, id, label));
  // 「편집」 열(스펙 ui/ops-edit-links.md, OMAI-1210). 작업 행 → 그 작업의 서랍(켜기·끄기·기간·메모를 고치는 곳, ?open=<프로파일>/<작업>),
  // 프로파일 행 → 그 프로파일 서랍의 크론 탭. 권한이 없으면 열이 없다
  const editJob = useEditColumn<{ profile: string; job_id?: string; job: string }>(
    (r) => (r.job_id ? { to: 'cron', params: { open: `${r.profile}/${r.job_id}` } } : null),
    (r) => r.job
  );
  // 「전체 작업·일정」 탭(처음 열리는 탭)의 행: 행 번호가 「프로파일/작업」이라 그 작업의 서랍을 연다(OMAI-1210 후속)
  // 작업 서랍 주소는 「프로파일/작업」이다. 흐름 행의 id 는 「cron:프로파일/작업」 꼴일 수 있어(OKE 확인) 앞의 종류 글자를 떼고 쓴다
  const editFlow = useEditColumn<FlowStart>((j) => ({ to: 'cron', params: { open: `${j.profile}/${j.id.slice(j.id.indexOf('/') + 1)}` } }), (j) => j.label);
  const editProfile = useEditColumn<ProfileCron>((p) => ({ to: 'profiles', params: { name: p.name, pane: 'cron' } }), (p) => p.name);
  if (!d) return <ScreenLoading title={t('cron.title')} error={error ? t('cron.collectFailed', { error }) : null} />;
  const tot = d.totals;
  const live = <T extends { muted?: boolean }>(x: T[]) => x.filter((r) => !r.muted);
  const incidents = live(d.incidents);
  const broken = d.profiles.filter((p) => p.jobs_status === 'error' || p.exec_status === 'error');
  const notes = [
    broken.length
      ? t('cron.brokenNote', { list: broken.map((p) => `${p.name} (${p.detail})`).join(', ') })
      : '',
    tot.stale_profiles?.length ? t('cron.staleNote', { list: tot.stale_profiles.join(', ') }) : '',
  ]
    .filter(Boolean)
    .join(' ');
  const failing = incidents.filter((r) => r.now === 'failing');
  const settled = incidents.filter((r) => r.now !== 'failing');
  const tabs: ListTab<unknown>[] = [
    // 처음 열면 「전체 작업·일정」이 먼저 보인다. 주소에 탭이 없으면 ListView 가 맨 앞 탭을 연다
    tabOf<FlowStart>({
      id: 'jobs',
      label: t('cron.tabJobs'),
      items: flows ?? [],
      count: flows ? undefined : null, // 받기 전에는 0 이 아니라 「—」(2026-10-17-011 원칙 8)
      empty: flows ? t('cron.emptyJobs') : t('cron.loadingJobs'),
      onRow: (j) => route.openRow(flowKey(j)),
      rowId: (j) => j.id,
      columns: [
        nameColumn<FlowStart>({ id: 'job', label: t('cron.grid.job'), value: (j) => j.label }),
        {
          id: 'status',
          label: t('cron.grid.status'),
          value: (j) => (j.status === 'off' ? t('cron.off') : j.status === 'bad' ? '' : t('cron.on')),
          width: 'minmax(96px, auto)',
          render: (j) => (
            <>
              {j.status === 'off' ? <Pill>{t('cron.off')}</Pill> : j.status === 'bad' ? null : <Pill tone="good">{t('cron.on')}</Pill>}
              {j.badges
                .filter((b) => !isOffBadge(b))
                .map((b) => (
                  <Pill key={b} tone={badgeTone(b)}>
                    {serverTerm(b)}
                  </Pill>
                ))}
            </>
          ),
        },
        profileCol<FlowStart>(),
        {
          id: 'schedule',
          label: t('cron.schedule'),
          value: (j) => {
            const sched = flowSchedule(j);
            const words = describe(sched);
            return sched + (words ? ` (${words})` : '');
          },
          width: 'minmax(160px, 1.5fr)',
        },
        { id: 'skills', label: t('cron.grid.skills'), value: (j) => j.skills.join(', '), width: 'minmax(120px, 1fr)' },
        { id: 'scripts', label: t('cron.grid.scripts'), value: (j) => j.scripts.join(', '), width: 'minmax(120px, 1fr)' },
        { id: 'note', label: t('cron.grid.note'), value: (j) => j.note, width: 'minmax(120px, 1fr)' },
      ],
    }),
    tabOf<Incident>({
      id: 'incidents',
      label: t('cron.tabIncidents'),
      tone: 'bad',
      items: failing,
      empty: t('cron.emptyIncidents'),
      columns: incidentColumns(),
      rowId: (r) => r.id,
      onRow: (r) => route.openRow(r.id),
    }),
    tabOf<Incident>({
      id: 'settled',
      label: t('cron.tabSettled'),
      tone: 'warn',
      items: settled,
      empty: t('cron.emptySettled'),
      columns: incidentColumns(),
      rowId: (r) => r.id,
      onRow: (r) => route.openRow(r.id),
    }),
    tabOf<FailedJob>({
      id: 'failed_jobs',
      label: t('cron.tabFailed'),
      tone: 'bad',
      items: live(d.failed_jobs),
      empty: t('cron.emptyFailed'),
      rowId: jobKey,
      columns: [
        jobCol<FailedJob>(),
        profileCol<FailedJob>(),
        scheduleCol<FailedJob>(),
        {
          id: 'streak',
          label: t('cron.streakLabel'),
          value: (r) => r.streak,
          width: 'minmax(96px, auto)',
          num: true,
          render: (r) => <Pill tone="bad">{t('cron.streakTag', { count: r.streak })}</Pill>,
        },
        {
          id: 'deliver',
          label: t('cron.deliverLabel'),
          value: (r) => r.deliver,
          width: 'minmax(96px, auto)',
          render: (r) => (r.deliver === 'local' ? <Pill tone="warn">{t('cron.noNotice')}</Pill> : r.deliver),
        },
        errorCol<FailedJob>((r) => r.error),
        ageColumn<FailedJob>({ id: 'last_run_at', label: t('cron.lastRun'), value: (r) => r.last_run_at }),
      ],
      detail: (r) => ({
        title: r.job,
        sub: t('cron.subLastFailed', { profile: r.profile }),
        body: (
          <>
            <KV
              pairs={[
                [t('cron.profile'), r.profile],
                [t('cron.schedule'), code(r.schedule)],
                [t('cron.streakLabel'), t('cron.times', { count: r.streak })],
                [t('cron.lastRun'), fmtTs(r.last_run_at)],
                [t('cron.deliverLabel'), r.deliver ?? ''],
                [t('cron.jobId'), code(r.job_id)],
              ]}
            />
            <Block text={r.error} onCopy={() => copy(r.error ?? '', t('cron.errorCopied'))} />
            <SkillLinks r={r} />
            <Manage r={r} />
            <Section title={t('cron.todo')}>
              <AskLink
                profile={r.profile}
                text={
                  t('cron.askFailed', { job: r.job, jobId: r.job_id, streak: r.streak, error: r.error }) +
                  t('cron.askTail')
                }
              />
            </Section>
            <Also r={r} />
          </>
        ),
      }),
    }),
    tabOf<StalledJob>({
      id: 'stalled',
      label: t('cron.tabStalled'),
      tone: 'bad',
      items: live(d.stalled),
      empty: t('cron.emptyStalled'),
      rowId: jobKey,
      columns: [
        jobCol<StalledJob>(),
        profileCol<StalledJob>(),
        scheduleCol<StalledJob>(),
        { id: 'kind', label: t('cron.kind'), value: (r) => r.kind, width: 'minmax(80px, auto)' },
        {
          id: 'cause',
          label: t('cron.cause'),
          value: (r) => r.cause,
          width: 'minmax(140px, 2fr)',
          render: (r) => (r.cause ? <Pill tone="warn">{r.cause}</Pill> : null),
        },
        {
          id: 'hours',
          label: t('cron.elapsed'),
          value: (r) => r.hours,
          width: '96px',
          num: true,
          render: (r) => t('cron.overdue', { dur: dur(r.hours) }),
        },
        ageColumn<StalledJob>({ id: 'since', label: t('cron.since'), value: (r) => r.since }),
      ],
      detail: (r) => ({
        title: r.job,
        sub: t('cron.subStalled', { profile: r.profile }),
        body: (
          <>
            <KV
              pairs={[
                [t('cron.profile'), r.profile],
                [t('cron.schedule'), code(r.schedule)],
                [t('cron.kind'), r.kind],
                [t('cron.cause'), r.cause ?? ''],
                [t('cron.since'), fmtTs(r.since)],
                [t('cron.elapsed'), dur(r.hours)],
                [t('cron.jobId'), code(r.job_id)],
              ]}
            />
            <SkillLinks r={r} />
            <Manage r={r} />
            <Section title={t('cron.todo')}>
              <AskLink
                profile={r.profile}
                text={
                  t('cron.askStalled', { job: r.job, jobId: r.job_id, kind: r.kind, since: r.since }) +
                  t('cron.askTail')
                }
              />
            </Section>
            <Also r={r} />
          </>
        ),
      }),
    }),
    tabOf<SilentJob>({
      id: 'silent',
      label: t('cron.tabSilent'),
      tone: 'warn',
      items: live(d.silent),
      empty: t('cron.emptySilent'),
      rowId: jobKey,
      columns: [
        jobCol<SilentJob>(),
        profileCol<SilentJob>(),
        scheduleCol<SilentJob>(),
        {
          id: 'reason',
          label: t('cron.reason'),
          value: (r) => r.reason,
          width: 'minmax(140px, 1.5fr)',
          render: (r) => <Pill tone="warn">{r.reason}</Pill>,
        },
        errorCol<SilentJob>((r) => r.delivery_error),
      ],
      detail: (r) => ({
        title: r.job,
        sub: t('cron.subSilent', { profile: r.profile }),
        body: (
          <>
            <KV
              pairs={[
                [t('cron.profile'), r.profile],
                [t('cron.schedule'), code(r.schedule)],
                [t('cron.reason'), r.reason],
                [t('cron.jobId'), code(r.job_id)],
              ]}
            />
            {r.delivery_error && (
              <Section title={t('cron.deliveryError')}>
                <Box component="pre" sx={{ whiteSpace: 'pre-wrap', fontFamily: MONO_FONT }}>
                  {r.delivery_error}
                </Box>
              </Section>
            )}
            <Typography variant="caption" color="text.secondary" component="p">
              {t('cron.silentNote')}
            </Typography>
            <SkillLinks r={r} />
            <Manage r={{ ...r, job_id: r.job_id }} />
            <Also r={r} />
          </>
        ),
      }),
    }),
  ] as ListTab<unknown>[];
  if (d.muted?.length)
    tabs.push(
      tabOf<MutedJob>({
        id: 'muted',
        label: t('cron.tabMuted'),
        items: d.muted,
        onRow: (m) => openJob(m.profile, m.job_id, m.job),
        rowId: jobKey,
        columns: [
          jobCol<MutedJob>(),
          profileCol<MutedJob>(),
          {
            id: 'status',
            label: t('cron.grid.status'),
            value: (m) => [t('cron.mutedTag'), m.failing ? t('cron.nowFailing') : ''].filter(Boolean).join(' '),
            width: 'minmax(120px, auto)',
            render: (m) => (
              <>
                <Pill>{t('cron.mutedTag')}</Pill>
                {m.failing && <Pill tone="bad">{t('cron.nowFailing')}</Pill>}
                {!!m.incidents && <Pill>{t('cron.openIncidentsTag', { n: m.incidents })}</Pill>}
              </>
            ),
          },
          { id: 'note', label: t('cron.grid.note'), value: (m) => m.note || t('cron.noReasonNote'), width: 'minmax(200px, 3fr)' },
          { id: 'by', label: t('cron.grid.mutedBy'), value: (m) => m.by_name || m.by, width: 'minmax(120px, 1fr)' },
          ageColumn<MutedJob>({ id: 'ts', label: t('cron.grid.mutedAt'), value: (m) => m.ts }),
        ],
      })
    );
  tabs.push(
    tabOf<ProfileCron>({
      id: 'profiles',
      label: t('cron.tabProfiles'),
      items: d.profiles,
      rowId: (p) => p.name,
      columns: profileColumns(),
      onRow: (p) => route.openRow(p.name),
    })
  );

  const JOB_TABS = new Set(['incidents', 'settled', 'failed_jobs', 'stalled', 'silent', 'muted']);
  for (const tab of tabs) {
    if (JOB_TABS.has(tab.id)) tab.columns = [...(tab.columns ?? []), ...editJob] as typeof tab.columns;
    else if (tab.id === 'jobs') tab.columns = [...(tab.columns ?? []), ...editFlow] as typeof tab.columns;
    else if (tab.id === 'profiles') tab.columns = [...(tab.columns ?? []), ...editProfile] as typeof tab.columns;
  }

  const profiles = d.profiles.map((p) => p.name);
  const presetProfile = qs.get('profile') ?? undefined;
  // 예약 작업은 지금 에이전트(오른쪽 위에서 고른 것)의 프로파일에서 돈다. 모든 에이전트가 main 을 쓰게 된 뒤로
  // 프로파일 이름만으로는 어느 에이전트인지 알 수 없어 이름을 함께 보인다(2026-10-19-010). 이름이 없는 구성(compose)은 지금 문구
  const pod = me.data?.pod;
  const agent = pod?.name ? viewerAgentLabel(pod, me.data?.user?.email) : '';
  // 보기 카드(2026-10-17-011)가 탭 줄을 대신한다. 예전 카드의 설명은 그 보기 카드의 둘째 줄이다. 조건부 「알림 끈 작업」에도 카드를 단다
  const subs: Record<string, string> = {
    jobs: t('cron.cardJobsSub', { n: tot.jobs_active }),
    incidents: t('cron.cardIncidentsSub', { newCount: tot.new_incidents, open: tot.open_incidents }),
    settled: t('cron.cardSettledSub'),
    failed_jobs: t('cron.cardFailedSub'),
    stalled: t('cron.cardStalledSub'),
    silent: t('cron.cardSilentSub'),
  };
  for (const tb of tabs) tb.card = { sub: subs[tb.id] };

  const add: AddAction = {
    label: t('cron.newJob'),
    guide: 'cron.add',
    onClick: () =>
      openDrawer({
        title: t('cron.newJobTitle'),
        sub: agent ? t('cron.newJobSubAgent', { agent }) : t('cron.newJobSub'),
        body: <NewJobBody profiles={profiles} preset={{ profile: presetProfile }} agent={agent} />,
      }),
  };

  return (
    <>
      {/* 팀원 에이전트의 예약 작업을 다룰 때만 화면 머리에 회색 상태 줄(스펙 2026-10-22-001 DD5) */}
      <TeamTargetNote />
      <ListView<unknown>
        guide="cron.list"
        title={t('cron.title')}
        titleAction={<AddIconButton {...add} />}
        gridAction={add}
        sub={t(agent ? 'cron.subAgent' : 'cron.sub', { agent, jobs: tot.jobs, active: tot.jobs_active, at: fmtTs(d.collected_at) })}
        error={notes || null}
        tabs={tabs}
        id="cron"
        // 선택 행 표시: 작업 탭은 주소 값(「프로파일/작업」)을 행 id 로 바꾸고, 사고·프로파일 탭은 주소 값이 곧 행 id 다(사고 id·프로파일 이름)
        openId={!route.open ? null : (qs.get('tab') ?? 'jobs') === 'jobs' ? (flows?.find((j) => flowKey(j) === route.open)?.id ?? null) : route.open}
        clearOnTab={route.clearOnTab}
        filters={[{ key: 'profile', label: t('cron.profile'), get: (i) => (i as { profile?: string }).profile }]}
        toolbar={({ tab, filters }) => {
          const list = settled.filter((r) => r.ack && (!filters.profile || r.profile === filters.profile));
          return (
            <>
              {tab === 'settled' && list.length > 0 && (
                <Button
                  startIcon={<ContentCopyOutlinedIcon />}
                  size="small"
                  variant="outlined"
                  onClick={() => copy(list.map((r) => r.ack).join('\n'), t('cron.ackLinesCopied', { n: list.length }))}
                >
                  {t('cron.copyAllAck', { n: list.length })}
                </Button>
              )}
            </>
          );
        }}
        text={(i) => {
          const x = i as Record<string, unknown>;
          return [x.job, x.profile, x.error, x.reason, x.schedule, x.note, ((x.skills as string[]) ?? []).join(' ')]
            .filter(Boolean)
            .join(' ');
        }}
      />
    </>
  );
}
