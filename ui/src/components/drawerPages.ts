/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 서랍 안에서 열 수 있는 대상(「페이지」) 등록부(스펙 2026-10-26-003 §5-1, COP Console 의 kindComponentMap 과 같은 역할).
// - 서랍 안 기록에는 본문(ReactNode)이 아니라 이 설명(DrawerPage)을 둔다. 이전·이후로 돌아가면 설명으로 본문을 다시 만든다(D2).
// - 본문은 화면 모듈을 늦게 불러오는 컴포넌트다. 제목·부제는 본문이 useDrawerHead 로 채운다(리뷰 외부 검토 C1).
//   저장 확인은 본문이 useDrawerGuard 로 그 서랍에 건다(M3 — 인자 대신 서랍 문맥으로 넘긴다).
// - 등록부에 없는 대상은 서랍 안에서 열지 않고 지금처럼 메뉴를 옮긴다.
import { ComponentType, createElement, lazy } from 'react';

import { t } from '@/i18n';

import type { DrawerContent, DrawerSpec } from './UiContext';

export type DrawerPage =
  // 스킬 서랍(SkillDetail). id 는 스킬 id 또는 이름. prefer 는 이름이 여러 프로파일에 있을 때 먼저 고를 프로파일(주소 profile, 없으면 주 프로파일)
  | { kind: 'skill'; id: string; prefer?: string }
  | { kind: 'skillMap'; root: string } // 스킬 연결도(GraphView)
  | { kind: 'cronJob'; profile: string; id: string; label?: string } // 작업 서랍(JobDrawer)
  // 프로파일 서랍(ProfileDetail). pane 은 탭, extra 는 탭이 읽는 값(비밀값 key·MCP server·인증 파일 file·채널 add, 2단계)
  | { kind: 'profile'; name: string; pane?: string; extra?: Record<string, string> }
  | { kind: 'agent'; pod: string; focus?: 'size' } // AI 에이전트 작업공간 서랍(에이전트 화면). focus=size 면 「이 사람의 설정 → 크기」로 스크롤(스펙 2026-11-06-005 D14)
  // 목록 서랍(스펙 2026-10-28-014 D8): 모델 화면의 모델·채널 화면의 프로파일·사람 관리의 사람(행 id)
  | { kind: 'model'; id: string }
  | { kind: 'channel'; name: string }
  | { kind: 'user'; key: string }
  // 크론 화면의 사고 탭(실패 중·이미 해결) 서랍과 프로파일 탭 서랍(2단계 T7). settled 는 「이미 해결된 문제」 탭에서 연 것
  | { kind: 'cronIncident'; id: string; settled?: boolean }
  | { kind: 'cronProfile'; name: string };

type Kind = DrawerPage['kind'];
export type PageOf<K extends Kind> = Extract<DrawerPage, { kind: K }>;
type PageBody<K extends Kind> = ComponentType<{ page: PageOf<K> }>;

const BODIES: { [K in Kind]: PageBody<K> } = {
  skill: lazy(() => import('@/screens/Skills').then((m) => ({ default: m.SkillPage }))),
  skillMap: lazy(() => import('@/screens/Flows').then((m) => ({ default: m.SkillMapPage }))),
  cronJob: lazy(() => import('@/screens/cron/JobDrawer').then((m) => ({ default: m.JobPage }))),
  profile: lazy(() => import('@/screens/Profiles').then((m) => ({ default: m.ProfilePage }))),
  agent: lazy(() => import('@/screens/Agents').then((m) => ({ default: m.AgentPage }))),
  model: lazy(() => import('@/screens/Models').then((m) => ({ default: m.ModelPage }))),
  channel: lazy(() => import('@/screens/Channels').then((m) => ({ default: m.ChannelPage }))),
  user: lazy(() => import('@/screens/users/KeycloakUsers').then((m) => ({ default: m.UserPage }))),
  cronIncident: lazy(() => import('@/screens/Cron').then((m) => ({ default: m.IncidentPage }))),
  cronProfile: lazy(() => import('@/screens/Cron').then((m) => ({ default: m.CronProfilePage }))),
};

/** 프로파일 페이지의 주소 값(name·pane·extra). 빈 값은 뺀다 */
const profileParams = (page: PageOf<'profile'>) =>
  Object.entries({ name: page.name, pane: page.pane, ...page.extra }).filter((e): e is [string, string] => !!e[1]);

/** 본문이 제목을 채우기 전의 머리와 폭. 스킬 연결도는 넓은 서랍이다(§5-5) */
function frame(page: DrawerPage): Pick<DrawerContent, 'title' | 'sub' | 'wide'> {
  switch (page.kind) {
    case 'skill':
      return { title: page.id.split('/').pop() || page.id };
    case 'skillMap':
      return { title: t('flows.title'), sub: page.root, wide: true };
    case 'cronJob':
      return { title: page.label || page.id, sub: t('cronJob.drawerSub', { profile: page.profile }) };
    case 'profile':
      return { title: page.name };
    case 'agent':
      return { title: page.pod };
    case 'model':
      return { title: page.id, sub: t('models.title') };
    case 'channel':
      return { title: page.name, sub: t('channels.profileGatewayChannels') };
    case 'user':
      return { title: page.key };
    case 'cronIncident':
      return { title: page.id, sub: t('cron.tabIncidents') };
    case 'cronProfile':
      return { title: page.name, sub: t('cron.profileSummary') };
  }
}

/** 페이지 → 서랍 내용(머리·폭·본문). head 를 주면 본문이 채우기 전의 머리로 쓴다 */
export function drawerSpecFor(page: DrawerPage, head?: Pick<DrawerContent, 'title' | 'sub'>): DrawerContent {
  const Body = BODIES[page.kind] as PageBody<Kind>;
  return { ...frame(page), ...head, body: createElement(Body, { page }) };
}

/** 「같은 대상」 비교용 문자열. 보이는 이름(label)은 넣지 않는다 */
export function pageKey(page: DrawerPage): string {
  switch (page.kind) {
    case 'skill':
      return `skill:${page.id}`;
    case 'skillMap':
      return `skillMap:${page.root}`;
    case 'cronJob':
      return `cronJob:${page.profile}/${page.id}`;
    case 'profile':
      // 탭·값까지 같아야 같은 대상이다. 값 순서는 맞춘다
      return `profile:${new URLSearchParams(profileParams(page).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))}`;
    case 'agent':
      return `agent:${page.pod}`;
    case 'model':
      return `model:${page.id}`;
    case 'channel':
      return `channel:${page.name}`;
    case 'user':
      return `user:${page.key}`;
    case 'cronIncident':
      return `cronIncident:${page.id}`;
    case 'cronProfile':
      return `cronProfile:${page.name}`;
  }
}

/** 주소 값에서 빈 값을 뺀다 */
const qs = (o: Record<string, string | undefined>) => new URLSearchParams(Object.entries(o).filter((e): e is [string, string] => !!e[1]));

/**
 * 그 페이지를 메뉴에서 여는 주소(「이 화면으로 열기」·새 탭으로 열기, §5-7). pod 를 주면 목록 서랍 주소에 함께 쓴다 —
 * 프로파일 이름(main 등)은 POD 마다 겹쳐, 다른 POD 의 링크가 내 POD 의 같은 이름을 열지 않게 한다(스펙 2026-10-28-014 D10).
 * 에이전트(값이 POD id)·사람 관리(POD 와 관계없음)·프로파일·스킬 연결도 주소에는 쓰지 않는다. 주소 꼴은 pageFromLink 와 짝이다
 */
export function pageHref(page: DrawerPage, pod?: string): string {
  switch (page.kind) {
    case 'skill':
      return `/skills?${qs({ tab: 'all', profile: page.prefer, open: page.id, pod })}`;
    case 'skillMap':
      return `/flows?${new URLSearchParams({ root: page.root })}`;
    case 'cronJob':
      return `/cron?${qs({ open: `${page.profile}/${page.id}`, pod })}`;
    case 'profile':
      return `/profiles?${new URLSearchParams(profileParams(page))}`;
    case 'agent':
      return `/agents?${new URLSearchParams({ open: page.pod })}`;
    case 'model':
      return `/models?${qs({ open: page.id, pod })}`;
    case 'channel':
      return `/channels?${qs({ open: page.name, pod })}`;
    case 'user':
      return `/users?${new URLSearchParams({ open: page.key })}`;
    case 'cronIncident':
      return `/cron?${qs({ tab: page.settled ? 'settled' : 'incidents', open: page.id, pod })}`;
    case 'cronProfile':
      return `/cron?${qs({ tab: 'profiles', open: page.name, pod })}`;
  }
}

/** 프로파일 링크 값({name, pane, key…})을 페이지로. 이름이 없으면 null */
export function profilePage(params: Record<string, string | number | null | undefined>): PageOf<'profile'> | null {
  const { name, pane, ...rest } = params;
  if (!name) return null;
  const extra = Object.fromEntries(Object.entries(rest).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)]));
  return { kind: 'profile', name: String(name), ...(pane ? { pane: String(pane) } : {}), ...(Object.keys(extra).length ? { extra } : {}) };
}

/**
 * 서버가 준 화면 링크(스킬 연결도 노드의 `link`)·목록 화면의 주소 값을 페이지로 바꾼다. 목록 필터로 가는 링크(`cron{tab,q}`·`tools`·`credentials`,
 * `skills{lens}`)는 서랍이 없어 null — 지금처럼 메뉴를 옮긴다(리뷰 외부 검토 H3).
 * `open` 은 지금 탭(`tab`)과 함께 읽는다 — 탭마다 id 공간이 다른 화면이 있다(스펙 2026-10-28-014 D12): 모델 화면은 모델 탭이 모델 id,
 * 프로파일별 탭이 프로파일 이름이다. 크론은 1단계에 작업 탭(첫 탭)만 서랍을 연다. `pod` 는 읽지 않는다(useRoutePage 가 본다)
 */
export function pageFromLink(view: string, params?: Record<string, string | number | null | undefined>): DrawerPage | null {
  const p = (k: string) => (params?.[k] == null ? '' : String(params[k]));
  const open = p('open');
  const tab = p('tab');
  if (view === 'skills' && open) {
    const prefer = p('profile');
    return { kind: 'skill', id: open, ...(prefer && prefer !== '*' ? { prefer } : {}) };
  }
  if (view === 'flows' && p('root')) return { kind: 'skillMap', root: p('root') };
  if (view === 'cron' && (!tab || tab === 'jobs') && open.indexOf('/') > 0)
    return { kind: 'cronJob', profile: open.slice(0, open.indexOf('/')), id: open.slice(open.indexOf('/') + 1) };
  // 크론 2단계(T7): 사고 탭(사고 id)·프로파일 탭(프로파일 이름). 실패·멈춤·알림 없음·무시 탭은 주소 서랍이 없다
  if (view === 'cron' && (tab === 'incidents' || tab === 'settled') && open) return { kind: 'cronIncident', id: open, ...(tab === 'settled' ? { settled: true } : {}) };
  if (view === 'cron' && tab === 'profiles' && open) return { kind: 'cronProfile', name: open };
  if (view === 'profiles' && params) return profilePage(params);
  if (view === 'agents' && open) return { kind: 'agent', pod: open, ...(p('focus') === 'size' ? { focus: 'size' as const } : {}) };
  if (view === 'models' && open) return tab === 'profiles' ? { kind: 'profile', name: open } : !tab || tab === 'models' ? { kind: 'model', id: open } : null;
  if (view === 'channels' && open) return { kind: 'channel', name: open };
  if (view === 'users' && open) return { kind: 'user', key: open };
  return null;
}

let pageSeq = 0;

/**
 * 페이지로 여는 임시 서랍. 기록을 가진 서랍이라 그 안의 링크가 같은 서랍에서 열린다(리뷰 외부 검토 H2).
 * content 를 주면 첫 페이지 내용으로 쓴다(목록이 이미 읽은 행으로 바로 그린다). id 는 저장 확인을 걸 자리다(§5-6)
 */
export function pageDrawer(page: DrawerPage, content?: DrawerContent): DrawerSpec {
  return { ...(content ?? drawerSpecFor(page)), id: `page:${(pageSeq += 1)}`, history: { pages: [{ page, root: content }], index: 0 } };
}
