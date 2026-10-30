/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 활동: 세션·토큰 사용량. 세션 DB 의 집계 값만 읽고 대화 내용은 읽지 않는다.
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { ChatChip, DataTable, KV, LinkChip, PeriodSelect, ScreenLoading, Section } from '@/components/bits';
import { ageColumn, GridColumn, nameColumn, Pill, profileNameColumn, statusColumn } from '@/components/DataGrid';
import { ListView, tabOf } from '@/components/ListView';
import { t } from '@/i18n';
import { get } from '@/lib/api';
import { useEditColumn } from '@/lib/editLink';
import { big, fmtTs } from '@/lib/format';
import { SRC } from '@/lib/labels';
import { useDays } from '@/lib/useDays';

interface SourceCount {
  source: string;
  sessions: number;
}
/** 프로파일 이름 옆에 「내 전용」·「<이름>님 전용」을 붙인다(프로파일 목록과 같은 글, 2026-10-18) */
function withOwnerTag(col: GridColumn<ProfileActivity>, tag?: string): GridColumn<ProfileActivity> {
  if (!tag) return col;
  return {
    ...col,
    render: (r: ProfileActivity) => (
      <>
        {col.render?.(r)}
        <Pill>{tag}</Pill>
      </>
    ),
  };
}

interface ProfileActivity {
  name: string;
  status: string;
  sessions: number;
  messages: number;
  tool_calls: number;
  input_tokens: number;
  output_tokens: number;
  last_activity?: string | null;
  sources: SourceCount[];
}
interface ModelActivity {
  model: string;
  sessions: number;
  input_tokens: number;
  output_tokens: number;
}
interface ActivityData {
  days: number;
  /** 프로파일 이름 옆 뱃지(프로파일 목록과 같은 규칙, 2026-10-18): 주인이면 owner, 주인이 아닌 관리자에게는 owner_name */
  owner?: boolean;
  owner_name?: string;
  totals: {
    sessions: number;
    messages: number;
    tool_calls: number;
    input_tokens: number;
    output_tokens: number;
    idle_profiles: number;
  };
  by_source: SourceCount[];
  by_model: ModelActivity[];
  profiles: ProfileActivity[];
}

const pct = (n: number, of: number) => (of ? Math.round((100 * n) / of) + '%' : '—');
const srcName = (s: string) => SRC[s] || s;

// 공통 표의 열(OMAI-1127). 두 줄 목록의 둘째 줄 숫자·오른쪽 입력 토큰·마지막 활동 → 숫자 열, 출처 태그 → 세션 출처 칸.
// 숫자 칸은 줄여 쓴 값(12k)을 보이고 정렬은 원래 수로 한다
const numColumn = <T,>(id: string, label: string, get: (r: T) => number, o: Partial<GridColumn<T>> = {}): GridColumn<T> => ({
  id,
  label,
  value: get,
  render: (r) => big(get(r)),
  width: '96px',
  num: true,
  ...o,
});
const shareColumn = <T,>(get: (r: T) => number, total: number): GridColumn<T> => ({
  id: 'share',
  label: t('activity.share'),
  value: get,
  render: (r) => pct(get(r), total),
  width: '72px',
  num: true,
});

export function Activity() {
  const [days, setDays] = useDays([7, 30], 7);
  const q = useQuery<ActivityData>({
    queryKey: ['activity', days],
    queryFn: () => get<ActivityData>('/api/activity?days=' + days),
    placeholderData: keepPreviousData,
  });
  const d = q.data;
  // 「편집」 열(스펙 ui/ops-edit-links.md, OMAI-1210): 프로파일 행 → 그 프로파일 서랍, 모델 행 → 모델 화면의 그 모델. 권한이 없으면 열이 없다
  const editProfile = useEditColumn<ProfileActivity>((p) => ({ to: 'profiles', params: { name: p.name } }), (p) => p.name);
  const editModel = useEditColumn<ModelActivity>((m) => (m.model ? { to: 'models', params: { tab: 'models', q: m.model } } : null), (m) => m.model);
  if (!d) return <ScreenLoading title={t('activity.title')} error={q.error?.message} />;

  const tot = d.totals;
  const cron = d.by_source.find((s) => s.source === 'cron')?.sessions ?? 0;
  const range = t('activity.range', { days: d.days });

  return (
    <ListView<unknown>
      guide="activity.list"
      title={t('activity.title')}
      sub={t('activity.sub', { range })}
      error={q.error?.message}
      toolbar={<PeriodSelect days={days} options={[7, 30]} onChange={setDays} />}
      // 모델·출처 상세가 행 밖의 전체 세션 수·프로파일별 출처를 읽는다
      detailKey={[range, tot.sessions, d.profiles]}
      // 보기 카드(2026-10-17-011, D3 사용자 결정): 묶는 기준(프로파일별·모델별·출처별)도 같은 보기 카드다. 크론 비율은 「출처별」 카드의 둘째 줄로 옮겼다
      cards={[
        { n: tot.sessions, label: t('activity.sessionsInRange', { range }),
          sub: t('activity.messagesTools', { messages: big(tot.messages), tools: big(tot.tool_calls) }),
        },
        { n: big(tot.input_tokens), label: t('activity.inputTokens'), sub: t('activity.outputN', { n: big(tot.output_tokens) }) },
        {
          n: tot.idle_profiles,
          label: t('activity.idleProfiles'),
          sub: t('activity.noSessionsInRange', { range }),
          tone: tot.idle_profiles ? 'warn' : 'good',
        },
      ]}
      tabs={[
        tabOf<ProfileActivity>({
          id: 'profiles',
          card: {},
          label: t('activity.byProfile'),
          items: d.profiles,
          rowId: (p) => p.name,
          columns: [
            withOwnerTag(
              profileNameColumn<ProfileActivity>({ label: t('activity.profile'), value: (p) => p.name }),
              d.owner ? t('profiles.mineTag') : d.owner_name ? t('profiles.ownedByTag', { name: d.owner_name }) : undefined
            ),
            // 공통 표의 상태 칸(점 + 글자, OMAI-1288). 예전에는 예외만 알약으로 보이고 활동이 있는 프로파일은 빈칸이었다
            statusColumn<ProfileActivity>({
              label: t('activity.grid.status'),
              value: (p) =>
                p.status === 'no_db' ? t('activity.noRecord') : p.status !== 'ok' ? p.status : p.sessions ? t('activity.active') : t('activity.noActivity'),
              tone: (p) => (p.status === 'no_db' ? undefined : p.status !== 'ok' ? 'bad' : p.sessions ? 'good' : 'warn'),
            }),
            {
              id: 'sources',
              label: t('activity.whereFrom'),
              value: (p) => p.sources.map((s) => srcName(s.source)).join(' '),
              width: 'minmax(160px, 2fr)',
              sort: false,
              render: (p) => p.sources.slice(0, 3).map((s) => <Pill key={s.source}>{`${srcName(s.source)} ${s.sessions}`}</Pill>),
            },
            numColumn<ProfileActivity>('sessions', t('activity.sessions'), (p) => p.sessions, { width: '72px' }),
            numColumn<ProfileActivity>('messages', t('activity.messages'), (p) => p.messages),
            numColumn<ProfileActivity>('tool_calls', t('activity.toolCalls'), (p) => p.tool_calls),
            numColumn<ProfileActivity>('input_tokens', t('activity.inputTokens'), (p) => p.input_tokens),
            numColumn<ProfileActivity>('output_tokens', t('activity.outputTokens'), (p) => p.output_tokens, { hidden: true }),
            ageColumn<ProfileActivity>({ id: 'last_activity', label: t('activity.lastActivity'), value: (p) => p.last_activity }),
            ...editProfile,
          ],
          detail: (p) => ({
            title: p.name,
            sub: t('activity.activityInRange', { range }),
            body: (
              <>
                <KV
                  pairs={[
                    [t('activity.sessions'), p.sessions],
                    [t('activity.messages'), big(p.messages)],
                    [t('activity.toolCalls'), big(p.tool_calls)],
                    [t('activity.inputTokens'), big(p.input_tokens)],
                    [t('activity.outputTokens'), big(p.output_tokens)],
                    [t('activity.lastActivity'), p.last_activity ? fmtTs(p.last_activity) : t('activity.none')],
                  ]}
                />
                <Section title={t('activity.whereFrom')}>
                  {p.sources.length ? (
                    <DataTable
                      columns={[
                        { label: t('activity.source') },
                        { label: t('activity.sessions'), num: true },
                        { label: t('activity.share'), num: true },
                      ]}
                      rows={p.sources.map((s) => [srcName(s.source), s.sessions, pct(s.sessions, p.sessions)])}
                    />
                  ) : (
                    t('activity.noSessions')
                  )}
                </Section>
                <Section title={t('activity.seeNext')}>
                  <LinkChip to="cron" params={{ tab: 'profiles', q: p.name }}>{t('activity.cronOf', { name: p.name })}</LinkChip>
                  <LinkChip to="channels" params={{ tab: 'all', q: p.name }}>{t('activity.channelsOf', { name: p.name })}</LinkChip>
                  <ChatChip agent={p.name}>{t('activity.chatWith', { name: p.name })}</ChatChip>
                </Section>
              </>
            ),
          }),
        }),
        tabOf<ModelActivity>({
          id: 'models',
          card: {},
          label: t('activity.byModel'),
          items: d.by_model,
          rowId: (m) => m.model || '',
          columns: [
            nameColumn<ModelActivity>({ id: 'model', label: t('activity.grid.model'), value: (m) => m.model || t('activity.modelUnrecorded') }),
            numColumn<ModelActivity>('sessions', t('activity.sessions'), (m) => m.sessions, { width: '72px' }),
            shareColumn<ModelActivity>((m) => m.sessions, tot.sessions),
            numColumn<ModelActivity>('input_tokens', t('activity.inputTokens'), (m) => m.input_tokens),
            numColumn<ModelActivity>('output_tokens', t('activity.outputTokens'), (m) => m.output_tokens),
            ...editModel,
          ],
          detail: (m) => ({
            title: m.model || t('activity.modelUnrecorded'),
            sub: range,
            body: (
              <>
                <KV
                  pairs={[
                    [t('activity.sessions'), `${m.sessions} (${pct(m.sessions, tot.sessions)})`],
                    [t('activity.inputTokens'), big(m.input_tokens)],
                    [t('activity.outputTokens'), big(m.output_tokens)],
                  ]}
                />
                <Section title={t('activity.seeNext')}>
                  <LinkChip to="models" params={{ tab: 'models', q: m.model }}>
                    {t('activity.modelSettings')}
                  </LinkChip>
                </Section>
              </>
            ),
          }),
        }),
        tabOf<SourceCount>({
          id: 'sources',
          card: { sub: t('activity.cronShareN', { pct: pct(cron, tot.sessions) }) },
          label: t('activity.bySource'),
          items: d.by_source,
          rowId: (s) => s.source,
          columns: [
            nameColumn<SourceCount>({ id: 'source', label: t('activity.source'), value: (s) => srcName(s.source) }),
            numColumn<SourceCount>('sessions', t('activity.sessions'), (s) => s.sessions, { width: '72px' }),
            shareColumn<SourceCount>((s) => s.sessions, tot.sessions),
          ],
          detail: (s) => ({
            title: srcName(s.source),
            sub: range,
            body: (
              <>
                <KV pairs={[[t('activity.sessions'), `${s.sessions} (${pct(s.sessions, tot.sessions)})`]]} />
                <Section title={t('activity.byProfile')}>
                  <DataTable
                    columns={[{ label: t('activity.profile') }, { label: t('activity.sessions'), num: true }]}
                    rows={d.profiles
                      .map((p): [string, number] => [
                        p.name,
                        p.sources.find((x) => x.source === s.source)?.sessions ?? 0,
                      ])
                      .filter((x) => x[1])
                      .sort((a, b) => b[1] - a[1])}
                  />
                </Section>
              </>
            ),
          }),
        }),
      ]}
      id="activity"
      onRefresh={() => void q.refetch()}
      isFetching={q.isFetching}
      text={(i) =>
        String(
          (i as { name?: string; model?: string; source?: string }).name ??
            (i as { model?: string }).model ??
            srcName((i as { source: string }).source)
        )
      }
    />
  );
}
