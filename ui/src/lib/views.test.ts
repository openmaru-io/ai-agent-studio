/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';

import { setLang } from '@/i18n';

import { shortcuts, viewById, viewByKey, VIEWS, viewVisible } from './views';

afterEach(() => setLang('ko'));

describe('화면 목록', () => {
  it('화면 20개가 메뉴 순서(대시보드·대화·내 AI 에이전트·스킬·자동화·기록·관리·설정)로 있고 라이브러리는 빠진다(OMAI-1313)', () => {
    expect(VIEWS.map((v) => v.id)).toEqual([
      'dashboard',
      'chat',
      'office',
      'profiles',
      'agents',
      'models',
      'skills',
      'market',
      'flows',
      'cron',
      'channels',
      'activity',
      'changes',
      'users',
      'soul-templates',
      'notices',
      'preferences',
      'credentials',
      'connections',
      'settings',
    ]);
  });

  it('단축키(g 다음 글자)가 겹치지 않는다', () => {
    const keys = VIEWS.map((v) => v.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('옛 단축키와 같다', () => {
    const want: Record<string, string> = {
      o: 'dashboard',
      c: 'chat',
      e: 'office',
      r: 'cron',
      h: 'channels',
      a: 'activity',
      j: 'changes',
      u: 'users',
      n: 'agents',
      p: 'profiles',
      f: 'flows',
      s: 'skills',
      m: 'models',
      b: 'market',
      k: 'credentials',
      z: 'connections', // Claude Code 연결(스펙 2026-10-28-001)
    };
    for (const [k, id] of Object.entries(want)) expect(viewByKey(k)?.id).toBe(id);
    expect(viewByKey('x')).toBeUndefined();
  });

  it('라이브러리는 메뉴·검색창·단축키에 없다(이미지 패키지 목록을 채울 길이 없어 숨김, 스펙 2026-10-14-025 변경 B)', () => {
    expect(VIEWS.map((v) => v.id)).not.toContain('libraries');
    expect(viewByKey('l')).toBeUndefined();
  });

  it('라이브러리는 주소로만 열린다: 화면 정보는 있고 메뉴·팔레트 목록에는 없다', () => {
    expect(viewById('libraries')?.groupId).toBe('skill');
    expect(viewById('libraries')?.label).toBe('라이브러리');
    expect(VIEWS.some((v) => v.id === 'libraries')).toBe(false);
    expect(viewById('nope')).toBeUndefined();
  });

  it('도구는 메뉴·검색창·단축키에 없고 주소로만 열린다(스펙 2026-10-19-002)', () => {
    expect(VIEWS.some((v) => v.id === 'tools')).toBe(false);
    expect(viewByKey('t')).toBeUndefined();
    expect(viewById('tools')?.groupId).toBe('skill');
    expect(viewById('tools')?.label).toBe('도구');
  });

  it('묶음은 대시보드·대화·내 AI 에이전트·스킬·자동화·기록·관리·설정 여덟이다', () => {
    expect([...new Set(VIEWS.map((v) => v.group))]).toEqual(['대시보드', '대화', '내 AI 에이전트', '스킬', '자동화', '기록', '관리', '설정']);
    expect([...new Set(VIEWS.map((v) => v.groupId))]).toEqual(['dashboard', 'talk', 'agent', 'skill', 'automation', 'records', 'admin', 'settings']);
  });

  it('언어를 바꾸면 화면 이름과 설명, 묶음 이름이 영어로 나온다', () => {
    const cron = viewById('cron')!;
    expect(cron.label).toBe('예약 작업');
    setLang('en');
    expect(cron.label).toBe('Scheduled jobs');
    expect(cron.group).toBe('Automation');
    expect(cron.sub).not.toMatch(/[가-힣]/);
  });

  it('관리자가 아니면 사용자·권한·역할 템플릿이 보이지 않고(회사 정보는 자기 부서 문구용으로 보인다), 변경 기록은 주인에게만 보인다', () => {
    const hidden = (who: { admin: boolean; owner?: boolean; teamManager?: boolean }) => VIEWS.filter((v) => !viewVisible(v.id, who)).map((v) => v.id).sort();
    expect(hidden({ admin: true })).toEqual([]);
    expect(hidden({ admin: false })).toEqual(['changes', 'notices', 'soul-templates', 'users']);
    expect(hidden({ admin: false, owner: true })).toEqual(['notices', 'soul-templates', 'users']);
    expect(hidden({ admin: false, teamManager: true })).toEqual(['notices', 'soul-templates', 'users']); // 팀 관리자도 지금 팀원 에이전트의 기록을 본다(DD8)
  });

  it('단축키 안내표도 보이는 화면만 담는다', () => {
    const row = (who: { admin: boolean; owner?: boolean }) => shortcuts(who).find(([k]) => k.startsWith('g'))![1];
    expect(row({ admin: true })).toContain('사용자·권한');
    expect(row({ admin: false })).not.toContain('사용자·권한');
    expect(row({ admin: false })).toContain('대시보드');
  });

  it('viewById 는 없는 id 에 undefined 를 준다', () => {
    expect(viewById('cron')?.label).toBe('예약 작업');
    expect(viewById('nope')).toBeUndefined();
  });

  it('단축키 안내표가 모든 화면의 키를 담는다', () => {
    const row = shortcuts().find(([k]) => k.startsWith('g'));
    for (const v of VIEWS) expect(row?.[1]).toContain(`${v.key} ${v.label}`);
  });
});
