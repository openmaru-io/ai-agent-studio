/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';

import { setLang } from '@/i18n';

import { buildMenus } from './menu';
import { VIEWS } from './views';

const health = { totals: { live_incidents: 2, settled_incidents: 3, failed_jobs: 1, stalled: 0, silent: 4 } };
const ids = (admin: boolean, group: string) => buildMenus({ admin }).find((g) => g.id === group)?.items.map((i) => i.id);

afterEach(() => setLang('ko'));

describe('메뉴 모델 — 할 일 기준 8묶음(OMAI-1313, 스펙 2026-10-17-026)', () => {
  it('묶음은 대시보드·대화·내 AI 에이전트·스킬·자동화·기록·관리·설정 순서이고 대시보드는 화면 하나다', () => {
    expect(buildMenus({}).map((g) => g.id)).toEqual(['dashboard', 'talk', 'agent', 'skill', 'automation', 'records', 'admin', 'settings']);
    expect(buildMenus({}).map((g) => g.label)).toEqual(['대시보드', '대화', '내 AI 에이전트', '스킬', '자동화', '기록', '관리', '설정']);
    expect(buildMenus({})[0].items.map((i) => [i.id, i.label])).toEqual([['dashboard', '대시보드']]);
  });

  it('묶음마다 화면이 정해진 순서로 있다', () => {
    expect(ids(true, 'talk')).toEqual(['chat', 'office']);
    expect(ids(true, 'agent')).toEqual(['profiles', 'agents', 'models']);
    expect(ids(true, 'skill')).toEqual(['skills', 'market', 'flows']);
    expect(ids(true, 'automation')).toEqual(['cron', 'channels']);
    expect(ids(true, 'records')).toEqual(['activity', 'changes']);
    expect(ids(true, 'admin')).toEqual(['users', 'soul-templates', 'notices']);
    expect(ids(true, 'settings')).toEqual(['preferences', 'credentials', 'connections', 'settings']);
  });

  it('화면 이름은 사용자 말로 쓴다 — Hermes 프로파일은 「프로파일」, Hermes 설치는 「AI 에이전트 작업공간」(2026-10-23, OMAI-1443)', () => {
    const label = (id: string) => buildMenus({}).flatMap((g) => g.items).find((i) => i.id === id)!.label;
    expect(['profiles', 'agents', 'skills', 'flows', 'cron', 'channels', 'activity', 'soul-templates', 'preferences', 'credentials'].map(label)).toEqual([
      '프로파일',
      'AI 에이전트 작업공간',
      '스킬 목록',
      '스킬 연결도',
      '예약 작업',
      '메신저 연결',
      '사용량',
      '역할 템플릿',
      '내 화면',
      'API 키·토큰',
    ]);
  });

  it('관리자가 아니면 「관리」 묶음을 통째로 빼고 전체 변경 기록도 뺀다(OMAI-1122)', () => {
    const menus = buildMenus({ admin: false });
    expect(menus.map((g) => g.id)).toEqual(['dashboard', 'talk', 'agent', 'skill', 'automation', 'records', 'settings']);
    expect(ids(false, 'records')).toEqual(['activity']);
    expect(ids(false, 'settings')).toEqual(['preferences', 'credentials', 'connections', 'settings']);
  });

  it('관리자가 아닌 주인에게는 기록 묶음에 「변경 기록」을 둔다(OMAI-1126 디자인 결정 2A, 2026-10-24 메뉴 이름 줄임)', () => {
    const item = buildMenus({ admin: false, owner: true, pod: 'kim' })
      .find((g) => g.id === 'records')!
      .items.find((i) => i.id === 'changes')!;
    expect([item.label, item.sub]).toEqual(['변경 기록', 'kim · 최근 30일']);
    const admin = buildMenus({ admin: true, owner: true }).find((g) => g.id === 'records')!.items.find((i) => i.id === 'changes')!;
    expect(admin.label).toBe('변경 기록');
  });

  it('관리자도 주인도 아닌 팀 관리자에게도 변경 기록을 둔다(스펙 2026-10-22-001 DD8)', () => {
    const item = buildMenus({ admin: false, owner: false, teamManager: true, pod: '김철수 · 영업 도우미' })
      .find((g) => g.id === 'records')!
      .items.find((i) => i.id === 'changes')!;
    expect([item.label, item.sub]).toEqual(['변경 기록', '김철수 · 영업 도우미 · 최근 30일']);
    expect(ids(false, 'records')).toEqual(['activity']);
  });

  it('관리자에게 온 처리 대기 요청 수를 프로파일 메뉴와 내 에이전트 묶음에 붙인다(스펙 2026-10-15-011 단계 5)', () => {
    const g = buildMenus({ adminRequests: 3 }).find((x) => x.id === 'agent')!;
    const profiles = g.items.find((i) => i.id === 'profiles')!;
    expect([g.badge, g.tone, profiles.badge, profiles.tone, profiles.sub]).toEqual([3, 'warn', 3, 'warn', '처리 대기 3건']);
    const none = buildMenus({}).find((x) => x.id === 'agent')!;
    expect([none.badge, none.items.find((i) => i.id === 'profiles')!.badge]).toEqual([undefined, undefined]);
  });

  it('언어를 바꾸면 묶음과 화면 이름이 영어로 나온다', () => {
    setLang('en');
    const groups = buildMenus({});
    expect(groups.map((g) => g.label)).toEqual(['Dashboard', 'Chat', 'My AI Agents', 'Skills', 'Automation', 'Records', 'Admin', 'Settings']);
    expect(groups.find((g) => g.id === 'automation')!.items.find((i) => i.id === 'cron')!.label).toBe('Scheduled jobs');
    expect(groups.find((g) => g.id === 'agent')!.items.map((i) => i.label)).toEqual(['Profiles', 'AI Agent Workspaces', 'Models']);
  });

  it('자동화 묶음의 숫자는 지금도 실패하는 문제와 마지막 실행 실패의 합이다', () => {
    const g = buildMenus({ health }).find((x) => x.id === 'automation')!;
    expect([g.badge, g.tone, g.items.find((i) => i.id === 'cron')!.badge]).toEqual([3, 'bad', 3]);
  });

  it('live_incidents 가 없으면 open_incidents 를 쓴다(옛 수집 결과 호환)', () => {
    expect(buildMenus({ health: { totals: { open_incidents: 5, failed_jobs: 0 } } }).find((g) => g.id === 'automation')!.badge).toBe(5);
  });

  it('수집 결과가 없으면 숫자를 달지 않는다', () => {
    for (const g of buildMenus({})) expect(g.badge).toBeUndefined();
  });

  it('API 키·토큰 목록이 있으면 백업 파일을 뺀 만료 수를 설정 묶음과 API 키·토큰에 단다(대시보드 숫자와 같게, R4)', () => {
    const items = [{ flags: ['만료됨'] }, { flags: ['만료됨', '백업 파일'] }, { flags: [] }];
    const g = buildMenus({ creds: { totals: { expiring: 2 }, items } }).find((x) => x.id === 'settings')!;
    expect([g.badge, g.tone, g.items.find((i) => i.id === 'credentials')!.badge]).toEqual([1, 'bad', 1]);
    expect(buildMenus({ creds: { totals: { expiring: 2 } } }).find((x) => x.id === 'settings')!.badge).toBe(2);
    // 7일 안에 끝나는 수동 토큰은 「Claude Code 연결」과 설정 묶음 머리에 더한다(스펙 2026-10-28-001 §3-7 ②)
    const both = buildMenus({ creds: { totals: { expiring: 2 } }, connectionsExpiring: 1 }).find((x) => x.id === 'settings')!;
    expect(both.badge).toBe(3);
    expect(both.items.find((i) => i.id === 'connections')).toMatchObject({ badge: 1, tone: 'bad' });
    expect(buildMenus({}).find((x) => x.id === 'settings')!.items.find((i) => i.id === 'connections')!.badge).toBeUndefined();
  });

  it('대화 묶음에 답을 기다리는 대화 수를 단다', () => {
    const talk = buildMenus({ waiting: 2 }).find((g) => g.id === 'talk')!;
    expect([talk.badge, talk.tone, talk.items.find((i) => i.id === 'chat')!.badge]).toEqual([2, 'warn', 2]);
    expect(buildMenus({}).find((g) => g.id === 'talk')!.badge).toBeUndefined();
  });

  it('모든 화면이 메뉴에 한 번씩 있다(숨긴 라이브러리 제외)', () => {
    const all = buildMenus({}).flatMap((g) => g.items).map((i) => i.id);
    expect(all.length).toBe(new Set(all).size);
    expect(all.sort()).toEqual([...new Set(VIEWS.map((v) => v.id))].sort());
  });

  it('화면이 놓인 묶음과 메뉴 묶음이 같다(검색창·도움말 경로가 메뉴와 어긋나지 않게)', () => {
    for (const g of buildMenus({})) for (const i of g.items) expect(VIEWS.find((v) => v.id === i.id)!.groupId, i.id).toBe(g.id);
  });
});

describe('스킬 허브 새 버전 배지(스펙 2026-10-24-003 D4)', () => {
  it('화면 항목에만 회색(neutral) 수를 달고 묶음 머리에는 달지 않는다', () => {
    const skill = buildMenus({ marketUpdates: 3 }).find((g) => g.id === 'skill');
    expect(skill?.items.find((i) => i.id === 'market')).toMatchObject({ badge: 3, tone: 'neutral' });
    expect(skill?.badge).toBeUndefined();
    expect(buildMenus({}).find((g) => g.id === 'skill')?.items.find((i) => i.id === 'market')?.badge).toBeUndefined();
  });
});
