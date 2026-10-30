/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { setLang } from '@/i18n';

import { changeGroupLabel, changeGroupOf, changeWhat, isAccess } from './changeLabels';

afterEach(() => setLang('ko'));

describe('변경 기록 라벨', () => {
  it('서버가 보내는 코드(kind)로 한 일과 묶음 이름을 현재 언어로 찾는다', () => {
    const row = { kind: 'profile_soul_revert', group: '프로파일', what: '서버가 보낸 문장' };
    expect(changeWhat(row)).toBe('성격을 이전 버전으로 되돌림');
    expect(changeGroupLabel(row)).toBe('프로파일');
    setLang('en');
    expect(changeWhat(row)).toBe('Reverted the personality to an earlier version');
    expect(changeGroupLabel(row)).toBe('Profiles');
  });

  it('사전에 없는 코드는 서버가 보낸 문장을 그대로 보인다', () => {
    const row = { kind: 'something_new', group: '새 묶음', what: '새로 생긴 일' };
    setLang('en');
    expect(changeWhat(row)).toBe('새로 생긴 일');
    expect(changeGroupLabel(row)).toBe('새 묶음');
    expect(changeWhat({ group: '크론', what: '옛 기록' })).toBe('옛 기록'); // kind 가 없는 옛 응답
  });

  it('묶음은 코드의 앞부분으로 정한다. 비밀값은 프로파일과 따로, 로그인류는 접속이다', () => {
    expect(changeGroupOf('cron_pause')).toBe('cron');
    expect(changeGroupOf('profile_env_set')).toBe('secret');
    expect(changeGroupOf('profile_credential_put')).toBe('secret');
    expect(changeGroupOf('profile_credential_clear')).toBe('secret');
    expect(changeGroupOf('profile_model')).toBe('profile');
    expect(changeGroupOf('skill_create')).toBe('skill');
    expect(changeGroupOf('office_change')).toBe('office');
    expect(changeGroupOf('market_install')).toBe('market');
    for (const k of ['user_grant', 'user_create', 'user_delete', 'login', 'login_failed', 'session_revoke']) expect(changeGroupOf(k)).toBe('access');
    expect(isAccess({ kind: 'login', group: '', what: '' })).toBe(true);
    expect(isAccess({ kind: 'cron_pause', group: '', what: '' })).toBe(false);
  });

  it('서버의 변경 종류를 빠짐없이 사전이 가지고 있다', () => {
    // aas/ops/changes.py 의 LABELS 키와 같아야 한다. 서버에 종류를 더하면 이 시험이 사전도 더하라고 알려 준다.
    const py = readFileSync(join(__dirname, '../../../aas/ops/changes.py'), 'utf-8');
    const kinds = [...py.matchAll(/"([a-z_]+)":\s*\("/g)].map((m) => m[1]);
    expect(kinds.length).toBeGreaterThan(30);
    const missing = kinds.filter((k) => changeWhat({ kind: k, group: '', what: '(없음)' }) === '(없음)');
    expect(missing).toEqual([]);
  });
});
