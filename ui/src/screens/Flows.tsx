/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 흐름: 스킬이 어디서 불려서 무엇을, 어떤 코드로, 어떤 인증값과 라이브러리로 부르는지. 시작점을 고르면 그림을 보인다.
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';

import { ScreenLoading } from '@/components/bits';
import { GridColumn, nameColumn, Pill } from '@/components/DataGrid';
import type { PageOf } from '@/components/drawerPages';
import { useDrawerGuard, useDrawerHead } from '@/components/drawerScope';
import { ListView } from '@/components/ListView';
import { TagBar, tagCounts, tagLabel, tagMatches } from '@/components/TagBar';
import { useUi } from '@/components/UiContext';
import { useOpenParam, useParamPatch, useRouteDrawer } from '@/components/useRouteDrawer';
import { t } from '@/i18n';
import { get } from '@/lib/api';
import { badgeTone, isOffBadge, serverTerm } from '@/lib/serverTerms';

import { GraphView } from './flows/GraphView';

interface Start {
  id: string;
  label: string;
  profile: string;
  status: string;
  badges: string[];
  sub: string;
  skills: string[];
  scripts: string[];
  /** 이 작업이 부르는 스킬의 태그 합집합(화면에서 계산한다, OMAI-1283) */
  tags?: string[];
}
interface SkillRow {
  id: string;
  name: string;
  description?: string;
  profile: string;
  n_cron: number;
  n_scripts: number;
  n_mcp: number;
  n_rest: number;
  /** 서버가 LLM 으로 붙인 태그 id(스킬 화면과 같은 값, OMAI-1283) */
  tags?: string[];
}
type Item =
  | (Start & { kind: 'cron' })
  | (SkillRow & { kind: 'skill'; label: string; sub?: string; skills?: string[]; scripts?: string[] });

function Picker() {
  const patchParams = useParamPatch();
  // 행을 눌러 여는 서랍은 기록을 한 칸 쌓고, 닫으면 그 칸을 되감는다(스펙 2026-10-28-014 D9)
  const openRoot = useOpenParam('root');
  const [params] = useSearchParams();
  const flows = useQuery<{ starts: Start[]; totals: { nodes: number; edges: number } }>({
    queryKey: ['flows'],
    queryFn: () => get('/api/flows'),
    staleTime: 120000,
  });
  const skills = useQuery<{ skills: SkillRow[]; totals: { skills: number } }>({
    queryKey: ['skills'],
    queryFn: () => get('/api/skills'),
    staleTime: 120000,
  });
  if (!flows.data || !skills.data) return <ScreenLoading title={t('flows.title')} error={(flows.error ?? skills.error)?.message} />;
  const starts = flows.data;
  const sk = skills.data;
  // 크론 작업의 태그: 그 작업이 부르는 스킬의 태그 합집합. 스킬 이름만 알 수 있어 같은 프로파일의 스킬을 먼저, 없으면 같은 이름의 다른 스킬(공용)을 쓴다
  const skillTags = (profile: string, name: string) =>
    (sk.skills.find((x) => x.name === name && x.profile === profile) ?? sk.skills.find((x) => x.name === name))?.tags ?? [];
  const cronItems = starts.starts.map((s) => ({
    ...s,
    kind: 'cron' as const,
    tags: [...new Set(s.skills.flatMap((name) => skillTags(s.profile, name)))],
  }));
  const skillItems = sk.skills.map((s) => ({ ...s, kind: 'skill' as const, id: 'skill:' + s.id, label: s.name }));
  // 태그 거르기: 주소 ?tag=a,b 가 정본이다. 탭마다 그 탭의 항목이 가진 태그만 칩이 되고, 이 탭에 없는 태그는 켜져 있어도 무시한다
  const wanted = (params.get('tag') ?? '').split(',').filter(Boolean);
  const setTags = (next: string[]) => patchParams({ tag: next.length ? next.join(',') : null }, { replace: true });
  const bar = (items: { tags?: string[] }[]) => {
    const counts = tagCounts(items);
    const active = wanted.filter((id) => counts.some((c) => c.id === id));
    return {
      active,
      above: (
        <TagBar
          counts={counts}
          total={items.length}
          active={active}
          onToggle={(id) => setTags(active.includes(id) ? active.filter((x) => x !== id) : [...active, id])}
          onClear={() => setTags([])}
        />
      ),
      show: counts.length > 0,
    };
  };
  const skillBar = bar(skillItems);
  const cronBar = bar(cronItems);
  const tagColumn = (): GridColumn<Item> => ({
    id: 'tags',
    label: t('market.grid.tags'),
    value: (i) => (i.tags ?? []).map(tagLabel).join(' '),
    width: 'minmax(176px, auto)',
    render: (i) => (
      <>
        {(i.tags ?? []).slice(0, 2).map((id, k) => (
          <Pill key={id} flush={k === 0}>
            {tagLabel(id)}
          </Pill>
        ))}
        {(i.tags ?? []).length > 2 && <Pill>{`+${(i.tags ?? []).length - 2}`}</Pill>}
      </>
    ),
  });
  // 상태 글자. 'bad' 는 서버 배지(실패 등)가 대신 말한다
  const statusText = (r: Start) =>
    r.status === 'bad' ? '' : r.status === 'off' ? t('flows.statusOff') : r.status === 'ok' ? t('flows.statusOk') : t('flows.statusNotRun');
  const shown = (r: Start) => r.badges.filter((b) => !isOffBadge(b));
  // 서버의 sub 는 「<프로파일> · <주기>」다. 프로파일은 열이 따로 있어 앞부분을 뗀다
  const schedule = (r: Start) => (r.sub.startsWith(r.profile + ' · ') ? r.sub.slice(r.profile.length + 3) : r.sub);
  const profileText = (p: string) => (p === 'default' ? t('flows.shared') : p);
  // 공통 표의 열(OMAI-1127). 두 줄 목록의 태그 → 상태, 둘째 줄 → 주기·설명, 오른쪽 이름 목록·개수 → 열
  const cronColumns: GridColumn<Item>[] = [
    nameColumn<Item>({ label: t('flows.grid.cronJob'), value: (i) => i.label }),
    {
      id: 'status',
      label: t('flows.grid.status'),
      value: (i) => [statusText(i as Start), ...shown(i as Start).map(serverTerm)].filter(Boolean).join(' '),
      width: 'minmax(120px, auto)',
      render: (i) => (
        <>
          {statusText(i as Start) && <Pill tone={(i as Start).status === 'ok' ? 'good' : undefined}>{statusText(i as Start)}</Pill>}
          {shown(i as Start).map((b) => (
            <Pill key={b} tone={badgeTone(b)}>
              {serverTerm(b)}
            </Pill>
          ))}
        </>
      ),
    },
    { id: 'profile', label: t('flows.profile'), value: (i) => profileText(i.profile), width: 'minmax(96px, auto)' },
    { id: 'schedule', label: t('flows.grid.schedule'), value: (i) => schedule(i as Start), width: 'minmax(120px, 1fr)' },
    { id: 'skills', label: t('flows.col.skill'), value: (i) => (i.skills ?? []).join(', '), width: 'minmax(140px, 1.5fr)' },
    ...(cronBar.show ? [tagColumn()] : []),
    { id: 'scripts', label: t('flows.col.script'), value: (i) => (i.scripts ?? []).join(', '), width: 'minmax(140px, 1.5fr)' },
  ];
  const count = (id: string, label: string, get: (s: SkillRow) => number): GridColumn<Item> => ({
    id,
    label,
    value: (i) => get(i as SkillRow),
    width: '80px',
    num: true,
  });
  const skillColumns: GridColumn<Item>[] = [
    nameColumn<Item>({ label: t('flows.col.skill'), value: (i) => i.label }),
    { id: 'profile', label: t('flows.profile'), value: (i) => profileText(i.profile), width: 'minmax(96px, auto)' },
    ...(skillBar.show ? [tagColumn()] : []),
    {
      id: 'description',
      label: t('flows.grid.description'),
      value: (i) => (i as SkillRow).description || t('flows.noDescription'),
      width: 'minmax(200px, 3fr)',
    },
    count('n_cron', t('flows.grid.cron'), (s) => s.n_cron),
    count('n_scripts', t('flows.col.script'), (s) => s.n_scripts),
    count('n_mcp', t('flows.grid.mcp'), (s) => s.n_mcp),
    count('n_rest', t('flows.grid.url'), (s) => s.n_rest),
  ];

  return (
    <ListView<Item>
      title={t('flows.title')}
      sub={t('flows.pickerSub')}
      // 스킬에서가 첫 탭, 크론 작업에서가 둘째. 보기 카드(2026-10-17-011)의 숫자는 태그로 거르기 전 수다(D9)
      cards={[
        {
          n: starts.totals.nodes,
          label: t('flows.cardNodes'),
          sub: t('flows.cardNodesSub', { n: starts.totals.edges }),
        },
      ]}
      tabs={[
        {
          id: 'skill',
          label: t('flows.tabSkill'),
          items: skillItems.filter((i) => tagMatches(i, skillBar.active)),
          count: sk.totals.skills,
          columns: skillColumns,
          above: skillBar.above,
          card: { sub: t('flows.cardSkillsSub') },
        },
        {
          id: 'cron',
          label: t('flows.tabCron'),
          items: cronItems.filter((i) => tagMatches(i, cronBar.active)),
          count: starts.starts.length,
          empty: t('flows.emptyCron'),
          columns: cronColumns,
          above: cronBar.above,
          card: { sub: t('flows.cardCronFlowsSub') },
        },
      ]}
      filters={[{ key: 'profile', label: t('flows.profile'), get: (i) => i.profile }]}
      text={(i) =>
        [
          i.label,
          i.sub,
          (i as { description?: string }).description,
          (i.skills ?? []).join(' '),
          (i.scripts ?? []).join(' '),
          (i.tags ?? []).map(tagLabel).join(' '),
        ]
          .filter(Boolean)
          .join(' ')
      }
      id="flows"
      rowId={(i) => i.id}
      openId={params.get('root')}
      onRow={(i) => openRoot({ root: i.id })}
      onRefresh={() => {
        void flows.refetch();
        void skills.refetch();
      }}
      isFetching={flows.isFetching || skills.isFetching}
      note={t('flows.pickerNote')}
    />
  );
}

// 호출 흐름 그림은 목록 위 넓은 서랍으로 연다(주소 `?root=` 는 그대로)
export function Flows() {
  useRouteDrawer(
    'root',
    (root, guard) => ({
      title: t('flows.title'),
      sub: root,
      body: <GraphView key={root} root={root} inDrawer onGuard={guard} />,
      wide: true,
    }),
    ['view', 'mentions']
  );
  return <Picker />;
}

/** 서랍 안에서 연 스킬 연결도(스펙 2026-10-26-003 §5-1). 머리는 메뉴에서 연 서랍과 같다. 중심 보기는 이 서랍 기록을 쌓는다(T7) */
export function SkillMapPage({ page }: { page: PageOf<'skillMap'> }) {
  const { navigateDrawer } = useUi();
  useDrawerHead({ title: t('flows.title'), sub: page.root });
  return <GraphView key={page.root} root={page.root} inDrawer onGuard={useDrawerGuard()} onCenter={(root) => void navigateDrawer({ kind: 'skillMap', root })} />;
}
