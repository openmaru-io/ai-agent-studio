/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 대시보드 「지금 에이전트」 구역. 예전 홈(운영 › 오늘 확인할 것)의 숫자·확인할 것·최근 바뀐 것을 그대로 옮겼다(계획 2026-10-14-014 D1).
// 모든 값이 지금 고른 에이전트(쿠키 POD) 하나의 것이다. 새로 모으는 것은 「내 사용량」(/api/activity, 활동 화면과 같은 캐시)뿐이다.
import BarChartOutlinedIcon from '@mui/icons-material/BarChartOutlined';
import ChecklistOutlinedIcon from '@mui/icons-material/ChecklistOutlined';
import HistoryOutlinedIcon from '@mui/icons-material/HistoryOutlined';
import { Box, Button, Chip, List, ListItem, ListItemButton, ListItemText, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { Tag } from '@/components/bits';
import { t } from '@/i18n';
import { get } from '@/lib/api';
import { changeGroupLabel, changeWhat, isAccess } from '@/lib/changeLabels';
import { chatStore, useChat } from '@/lib/chatStore';
import { useHealth } from '@/lib/data';
import { big, fmtTs } from '@/lib/format';
import { expiringCreds, failedStalled, fixableBy, IssueKind } from '@/lib/issueCounts';
import { badgeTone, serverTerm } from '@/lib/serverTerms';

import { Kpi, KpiRow, LoadError, Placeholder, SubBody, SubHead } from './parts';

interface FailedJob {
  job: string;
  job_id: string;
  profile: string;
  error?: string;
  streak: number;
  muted?: boolean;
}
interface StalledJob {
  job: string;
  job_id: string;
  profile: string;
  kind: string;
  cause?: string;
  hours: number;
  muted?: boolean;
}
interface HomeHealth {
  collected_at: string;
  totals: Record<string, number>;
  failed_jobs?: FailedJob[];
  stalled?: StalledJob[];
}
interface ProfileIssue {
  level: string;
  text: string;
  from?: string;
  code?: string;
  n?: number;
}
interface ProfileRow {
  name: string;
  title?: string;
  running?: boolean | null;
  issues: ProfileIssue[];
}
interface CredItem {
  name: string;
  scope: string;
  profile?: string;
  location: string;
  expires?: string;
  flags?: string[];
}
interface ChangeRow {
  ts: string;
  group: string;
  kind: string;
  failed?: boolean;
  who?: string;
  who_name?: string;
  what: string;
  detail?: string;
}
interface Usage {
  totals: { sessions: number; messages: number; input_tokens: number; output_tokens: number };
}

const SHOW = 5;

interface RowProps {
  title: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
  badges?: ReactNode;
  go: () => void;
  /** 관리자만 고칠 수 있는 항목을 관리자가 아닌 사람이 볼 때: 누를 수 없고 「관리자 조치 필요」(디자인 DD7) */
  locked?: boolean;
}
function Row({ title, sub, right, badges, go, locked }: RowProps) {
  const text = (
    <ListItemText
      primary={
        <>
          <span data-row-title="">{title}</span>
          {badges && (
            <Box component="span" sx={{ ml: 1 }}>
              {badges}
            </Box>
          )}
        </>
      }
      secondary={sub}
    />
  );
  if (locked)
    return (
      <ListItem divider sx={{ pr: 2 }}>
        {text}
        {right && <Chip size="small" variant="outlined" label={right} sx={{ mr: 1 }} />}
        <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
          {t('dashboard.adminOnly')}
        </Typography>
      </ListItem>
    );
  return (
    <ListItem disablePadding divider>
      <ListItemButton onClick={go}>
        {text}
        {right && <Chip size="small" variant="outlined" label={right} sx={{ mr: 1 }} />}
        <span aria-hidden="true">›</span>
      </ListItemButton>
    </ListItem>
  );
}

/** 확인할 것의 한 묶음. 테두리 없이 제목 줄과 평평한 목록(DD8). */
function Block({ title, tone, count, children, foot }: { title: string; tone?: 'bad' | 'warn'; count: number; children: ReactNode; foot?: ReactNode }) {
  return (
    <Box component="section">
      <Typography variant="body2" component="h4" sx={{ fontWeight: 600, mb: 0.5 }}>
        {title}{' '}
        <Chip size="small" label={count} color={count && tone ? (tone === 'bad' ? 'error' : 'warning') : 'default'} />
      </Typography>
      <List disablePadding dense>
        {children}
      </List>
      {foot}
    </Box>
  );
}

export function CurrentAgent({ admin, owner }: { admin: boolean; owner: boolean }) {
  const nav = useNavigate();
  const waiting = useChat(chatStore).waiting();
  const go = (path: string, params?: Record<string, string>) => () =>
    nav('/' + path + (params ? '?' + new URLSearchParams(params).toString() : ''));
  const locked = (kind: IssueKind) => !admin && fixableBy(kind) === 'admin';
  const health = useHealth();
  const profilesQ = useQuery<{ profiles: ProfileRow[] }>({ queryKey: ['profiles'], queryFn: () => get('/api/profiles') });
  const credsQ = useQuery<{ items: CredItem[] }>({ queryKey: ['credentials'], queryFn: () => get('/api/credentials') });
  const usageQ = useQuery<Usage>({ queryKey: ['activity', 7], queryFn: () => get('/api/activity?days=7') });
  // 전체 변경 기록은 관리자만, 주인은 지금 에이전트의 자기 기록만(OMAI-1122·1126, 계획 R7). 보기 권한자는 없음
  const changesQ = useQuery<{ rows: ChangeRow[] }>({
    queryKey: ['changes', 7],
    queryFn: () => get('/api/changes?days=7'),
    enabled: admin || owner,
  });

  const d = health.data as unknown as HomeHealth | undefined;
  const tot = d?.totals;
  // 한쪽을 못 읽어도 나머지 확인할 것은 보인다(못 읽은 쪽은 위의 오류 알림과 숫자 「—」)
  const profs = profilesQ.data?.profiles ?? (profilesQ.isError ? [] : null);
  const creds = credsQ.data?.items ?? (credsQ.isError ? [] : null);
  const expiring = creds ? expiringCreds(creds) : null;
  const changes = (changesQ.data?.rows ?? []).filter((r) => !isAccess(r));

  const more = (n: number, to: () => void) =>
    n > SHOW ? <Button size="small" onClick={to}>{t('home.showMore', { n: n - SHOW })}</Button> : null;

  const blocks: ReactNode[] = [];
  if (waiting)
    blocks.push(
      <Block key="waiting" title={t('home.waitingTitle')} tone="warn" count={waiting}>
        <Row title={t('home.waitingRow')} sub={t('home.waitingSub')} go={go('chat')} locked={locked('waiting')} />
      </Block>
    );
  const failed = (d?.failed_jobs ?? []).filter((r) => !r.muted);
  const stalled = (d?.stalled ?? []).filter((r) => !r.muted);
  if (failed.length)
    blocks.push(
      <Block key="failed" title={t('home.failedTitle')} tone="bad" count={failed.length} foot={more(failed.length, go('cron', { tab: 'failed_jobs' }))}>
        {failed.slice(0, SHOW).map((r) => (
          <Row
            key={r.profile + r.job_id}
            title={r.job}
            sub={`${r.profile} · ${String(r.error ?? '')
              .replace(/\s+/g, ' ')
              .slice(0, 90)}`}
            right={t('home.streak', { n: r.streak })}
            go={go('cron', { tab: 'failed_jobs', open: `${r.profile}/${r.job_id}` })}
            locked={locked('failed')}
          />
        ))}
      </Block>
    );
  if (stalled.length)
    blocks.push(
      <Block key="stalled" title={t('home.stalledTitle')} tone="bad" count={stalled.length} foot={more(stalled.length, go('cron', { tab: 'stalled' }))}>
        {stalled.slice(0, SHOW).map((r) => (
          <Row
            key={r.profile + r.job_id}
            title={r.job}
            sub={`${r.profile} · ${r.kind}` + (r.cause ? ` · ${r.cause}` : '')}
            right={t('home.hours', { n: Math.round(r.hours) })}
            go={go('cron', { tab: 'stalled', open: `${r.profile}/${r.job_id}` })}
            locked={locked('stalled')}
          />
        ))}
      </Block>
    );
  if (profs) {
    const bad = profs.filter((p) => p.issues.some((i) => i.level === 'bad' && i.from !== '크론')); // i18n-ignore: 서버가 보내는 문제 출처 이름과 맞대어 본다
    if (bad.length)
      blocks.push(
        <Block key="profiles" title={t('home.profilesTitle')} tone="bad" count={bad.length}>
          {bad.slice(0, SHOW).map((p) => (
            <Row
              key={p.name}
              title={p.title || p.name}
              badges={
                p.title ? (
                  <Typography component="span" variant="caption" color="text.secondary">
                    {p.name}
                  </Typography>
                ) : null
              }
              // i18n-ignore: 서버가 보내는 문제 출처 이름과 맞대어 본다
              sub={p.issues.find((i) => i.level === 'bad' && i.from !== '크론')?.text}
              right={p.running === false ? t('home.gatewayOff') : undefined}
              go={go('profiles', { name: p.name })}
              locked={locked('profiles')}
            />
          ))}
        </Block>
      );
  }
  if (expiring?.length)
    blocks.push(
      <Block key="creds" title={t('home.credsTitle')} tone="warn" count={expiring.length} foot={more(expiring.length, go('credentials', { tab: 'flag' }))}>
        {expiring.slice(0, SHOW).map((i) => (
          <Row
            key={i.name + i.location}
            title={i.name}
            // i18n-ignore: 서버가 보내는 범위 값('전역')과 맞대어 본다
            sub={`${i.scope === '전역' ? t('home.global') : i.profile} · ${i.location}`}
            right={i.expires ? i.expires.slice(0, 10) : undefined}
            badges={(i.flags ?? [])
              .filter((f) => /만료/.test(f))
              .map((f) => (
                <Tag key={f} tone={badgeTone(f)}>
                  {serverTerm(f)}
                </Tag>
              ))}
            go={go('credentials', { tab: 'flag', q: i.name })}
            locked={locked('creds')}
          />
        ))}
      </Block>
    );
  const tidy: ReactNode[] = [];
  if (tot?.settled_incidents)
    tidy.push(
      <Row key="s" title={t('home.settledTitle', { n: tot.settled_incidents })} sub={t('home.settledSub')} go={go('cron', { tab: 'settled' })} locked={locked('tidy')} />
    );
  if (tot?.silent)
    tidy.push(<Row key="n" title={t('home.silentTitle', { n: tot.silent })} sub={t('home.silentSub')} go={go('cron', { tab: 'silent' })} locked={locked('tidy')} />);
  if (tot?.muted_jobs)
    tidy.push(<Row key="m" title={t('home.mutedTitle', { n: tot.muted_jobs })} sub={t('home.mutedSub')} go={go('cron', { tab: 'muted' })} locked={locked('tidy')} />);
  // 스킬 새 버전은 정리할 것(긴급 아님, 스펙 2026-10-24-003 D6). 서버가 올릴 수 있는 사람에게만 항목을 준다(R7)
  const skillUpdates = (profs ?? []).reduce((a, p) => a + p.issues.filter((i) => i.code === 'market_update').reduce((b, i) => b + (i.n ?? 1), 0), 0);
  if (skillUpdates)
    tidy.push(
      <Row key="u" title={t('home.skillUpdatesTitle', { n: skillUpdates })} sub={t('home.skillUpdatesSub')} go={go('market', { tab: 'updates', scope: 'pod' })} locked={locked('tidy')} />
    );
  if (tidy.length)
    blocks.push(
      <Block key="tidy" title={t('home.tidyTitle')} count={tidy.length}>
        {tidy}
      </Block>
    );

  const urgent = blocks.length - (tidy.length ? 1 : 0);
  const issues = tot ? failedStalled(tot) : null;
  // 값이 없을 때: 받는 중이면 자리 표시, 실패했으면 「—」(예전 홈은 「…」 를 끝없이 보였다, 디자인 §19-4)
  const num = (ready: boolean, failedQ: boolean, value: () => ReactNode) => (ready ? value() : failedQ ? '—' : <Placeholder height={36} />);
  const errorOf = health.error ?? profilesQ.error ?? credsQ.error;
  const retry = () => {
    if (health.isError) void health.refetch();
    if (profilesQ.isError) void profilesQ.refetch();
    if (credsQ.isError) void credsQ.refetch();
  };
  const u = usageQ.data?.totals;

  return (
    <Box>
      {errorOf && <LoadError error={errorOf} retry={retry} />}
      <KpiRow>
        <Kpi
          n={num(!!profilesQ.data, profilesQ.isError, () => `${profs!.filter((p) => p.running).length}/${profs!.length}`)}
          label={t('home.cardGateway')}
          go={go('profiles')}
        />
        <Kpi
          n={num(!!tot, health.isError, () => tot!.jobs_active ?? 0)}
          label={t('home.cardActive')}
          sub={tot ? t('home.cardTotal', { n: tot.jobs ?? 0 }) : undefined}
          go={go('cron', { tab: 'jobs' })}
        />
        <Kpi n={num(issues != null, health.isError, () => issues)} label={t('home.cardIssues')} tone="bad" go={go('cron', { tab: 'failed_jobs' })} />
        <Kpi
          n={num(!!credsQ.data, credsQ.isError, () => expiring!.length)}
          label={t('home.cardCreds')}
          sub={t('home.cardCredsSub')}
          tone="warn"
          go={go('credentials', { tab: 'flag' })}
        />
      </KpiRow>

      <SubHead icon={ChecklistOutlinedIcon}>{t('dashboard.issuesTitle')}</SubHead>
      <SubBody>
      {!d || !profs || !creds ? (
        health.isError ? null : <Placeholder height={96} />
      ) : (
        <>
          {urgent <= 0 && (
            <Typography variant="body2" color="text.secondary" data-all-clear="" sx={{ mb: 1 }}>
              {t('dashboard.allClearAt', { ts: fmtTs(d.collected_at) })}
            </Typography>
          )}
          {blocks.length > 0 && (
            <Box sx={{ display: 'grid', gap: 2.5, gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' } }}>{blocks}</Box>
          )}
        </>
      )}
      </SubBody>

      <SubHead icon={BarChartOutlinedIcon}>{t('dashboard.usageTitle')}</SubHead>
      <SubBody>
      {usageQ.isError ? (
        <LoadError error={usageQ.error} retry={() => void usageQ.refetch()} />
      ) : (
        <KpiRow>
          <Kpi n={u ? big(u.sessions) : <Placeholder height={36} />} label={t('dashboard.usageSessions')} go={go('activity')} />
          <Kpi n={u ? big(u.messages) : <Placeholder height={36} />} label={t('dashboard.usageMessages')} go={go('activity')} />
          <Kpi n={u ? big(u.input_tokens) : <Placeholder height={36} />} label={t('dashboard.usageIn')} go={go('activity')} />
          <Kpi n={u ? big(u.output_tokens) : <Placeholder height={36} />} label={t('dashboard.usageOut')} go={go('activity')} />
        </KpiRow>
      )}
      </SubBody>

      {changes.length > 0 && (
        <>
          <SubHead icon={HistoryOutlinedIcon}>{admin ? t('home.changesTitle') : t('changes.ownerTitle')}</SubHead>
          <SubBody>
          <List disablePadding dense>
            {changes.slice(0, SHOW).map((c, n) => (
              <Row
                key={n}
                title={changeWhat(c)}
                sub={[c.who_name || c.who, c.detail].filter(Boolean).join(' · ')}
                right={fmtTs(c.ts)}
                badges={
                  <>
                    <Tag>{changeGroupLabel(c)}</Tag>
                    {c.failed && <Tag tone="bad">{t('home.rejectedFailed')}</Tag>}
                  </>
                }
                go={go('changes')}
              />
            ))}
          </List>
          {more(changes.length, go('changes'))}
          </SubBody>
        </>
      )}
    </Box>
  );
}
