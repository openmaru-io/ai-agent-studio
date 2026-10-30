/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

import {
  createBody,
  grantableFor,
  handoffText,
  KcUser,
  makePassword,
  roleOf,
  rolePills,
  updateBody,
  userActions,
  UserFormValues,
  validateUserForm,
  writeErrorView,
} from './logic';

const kcUser = (o: Partial<KcUser>): KcUser => ({
  key: o.id ?? 'k',
  id: 'k',
  username: 'hong',
  email: 'hong@corp.example',
  first_name: '길동',
  last_name: '홍',
  name: '홍길동',
  department: '',
  enabled: true,
  member: true,
  admin: false,
  admin_group: false,
  fixed: false,
  status: 'ok',
  pods: [],
  own_pods: [],
  shared_pods: [],
  sessions: 0,
  logins: 0,
  last_login: null,
  until: null,
  password: false,
  agents_running: 0,
  agents_suspended: 0,
  ...o,
});

const ME = 'kim@corp.example';

describe('userActions — 잠금 규칙(V12)', () => {
  it('나: 사용 중지·삭제·관리자 빼기를 잠그고, 비밀번호 재설정·고치기·로그인 끊기는 허용한다', () => {
    const a = userActions(kcUser({ email: ME, admin: true, sessions: 1 }), ME, 3);
    expect(a.enable.locked).toBe('내 계정은 다른 관리자가 바꿔야 합니다');
    expect(a.delete.locked).toBe('내 계정은 다른 관리자가 바꿔야 합니다');
    expect(a.role.locked).toBe('내 계정은 다른 관리자가 바꿔야 합니다');
    expect(a.password.locked).toBeUndefined();
    expect(a.edit.locked).toBeUndefined();
    expect(a.logout).toEqual({ visible: true });
  });

  it('이메일 대소문자가 달라도 나로 본다', () => {
    expect(userActions(kcUser({ email: 'KIM@corp.example' }), ME, 3).delete.locked).toBeTruthy();
  });

  it('마지막 관리자(사용 중인 관리자 1명): 사용 중지·삭제·관리자 빼기를 잠근다', () => {
    const a = userActions(kcUser({ admin: true }), ME, 1);
    expect(a.enable.locked).toBe('마지막 관리자는 사용 중지할 수 없습니다');
    expect(a.delete.locked).toBe('마지막 관리자는 삭제할 수 없습니다');
    expect(a.role.locked).toBe('마지막 관리자는 관리자에서 내릴 수 없습니다');
    // 관리자가 둘이면 풀린다
    const b = userActions(kcUser({ admin: true }), ME, 2);
    expect([b.enable.locked, b.delete.locked, b.role.locked]).toEqual([undefined, undefined, undefined]);
  });

  it('사용 중지된 관리자는 마지막 관리자로 세지 않고, 다시 사용은 잠그지 않는다', () => {
    const a = userActions(kcUser({ admin: true, enabled: false }), ME, 1);
    expect(a.enable.locked).toBeUndefined();
    expect(a.delete.locked).toBeUndefined();
  });

  it('설치 때 지정됨(AAS_ADMINS): 권한·사용 중지·삭제는 잠그고 비밀번호·로그인 끊기·고치기는 허용', () => {
    const a = userActions(kcUser({ admin: true, fixed: true, sessions: 2 }), ME, 5);
    expect(a.role.locked).toMatch(/AAS_ADMINS/);
    expect(a.enable.locked).toMatch(/AAS_ADMINS/);
    expect(a.delete.locked).toMatch(/AAS_ADMINS/);
    expect(a.password.locked).toBeUndefined();
    expect(a.edit.locked).toBeUndefined();
    expect(a.logout.locked).toBeUndefined();
  });

  it('쓰기 잠금(Keycloak 장애·권한 없음)은 Keycloak 에 쓰는 동작을 모두 잠그고 로그인 끊기는 남긴다', () => {
    const a = userActions(kcUser({ sessions: 1 }), ME, 2, '잠김');
    for (const k of ['edit', 'role', 'password', 'enable', 'delete'] as const) expect(a[k].locked).toBe('잠김');
    expect(a.logout.locked).toBeUndefined();
  });

  it('보이는 동작: 계정이 있으면 비밀번호·사용 여부·삭제, AAS 접근 없음이면 AAS 에 추가, 계정 없음이면 계정 만들기만', () => {
    const ok = userActions(kcUser({}), ME, 2);
    expect([ok.password.visible, ok.enable.visible, ok.delete.visible, ok.access.visible, ok.createAccount.visible]).toEqual([
      true, true, true, false, false,
    ]);
    expect(ok.logout.visible).toBe(false); // 세션이 없으면 없다
    const noAccess = userActions(kcUser({ status: 'no_access', member: false }), ME, 2);
    expect(noAccess.access.visible).toBe(true);
    const none = userActions(kcUser({ id: '', key: 'email:x@corp.example', status: 'no_account' }), ME, 2);
    expect([none.edit.visible, none.password.visible, none.enable.visible, none.delete.visible, none.createAccount.visible]).toEqual([
      false, false, false, false, true,
    ]);
  });
});

const form = (o: Partial<UserFormValues> = {}): UserFormValues => ({
  username: 'hong',
  email: 'hong@corp.example',
  last_name: '홍',
  first_name: '길동',
  department: '',
  role: 'user',
  pods: ['one'],
  create_agent: true,
  password: 'abcd-efgh',
  ...o,
});

describe('validateUserForm', () => {
  it('맞는 값이면 오류가 없다', () => {
    expect(validateUserForm(form(), 'create', 'corp.example')).toEqual({});
  });

  it('임시 비밀번호는 8자 이상이어야 한다', () => {
    expect(validateUserForm(form({ password: '1234567' }), 'create').password).toBe('8자 이상이어야 합니다');
    expect(validateUserForm(form({ password: '12345678' }), 'create').password).toBeUndefined();
  });

  it('아이디: 비우면 안 되고, 이메일 모양·허용하지 않는 글자를 거른다', () => {
    expect(validateUserForm(form({ username: ' ' }), 'create').username).toBe('입력합니다');
    expect(validateUserForm(form({ username: 'hong@corp.example' }), 'create').username).toBe('이메일이 아닌 아이디를 씁니다');
    expect(validateUserForm(form({ username: 'hong gil' }), 'create').username).toBe('영문·숫자·. _ - 만 씁니다');
    expect(validateUserForm(form({ username: 'hong.gil_d-1' }), 'create').username).toBeUndefined();
  });

  it('이메일: 모양과 허용 도메인(쉼표로 여럿)을 본다', () => {
    expect(validateUserForm(form({ email: 'hong' }), 'create').email).toBe('이메일 모양이 아닙니다');
    expect(validateUserForm(form({ email: 'hong@other.com' }), 'create', 'corp.example').email).toBe('corp.example 이메일만 쓸 수 있습니다');
    expect(validateUserForm(form({ email: 'hong@b.com' }), 'create', 'a.com, b.com').email).toBeUndefined();
    expect(validateUserForm(form({ email: 'hong@other.com' }), 'create', '').email).toBeUndefined();
  });

  it('성·이름은 필수다(Keycloak 사용자 프로필, O3)', () => {
    const e = validateUserForm(form({ last_name: '', first_name: ' ' }), 'create');
    expect(e.last_name).toBe('입력합니다');
    expect(e.first_name).toBe('입력합니다');
  });

  it('고치기는 아이디·이메일·비밀번호를 보지 않는다(R2)', () => {
    expect(validateUserForm(form({ username: '', email: '', password: '' }), 'edit')).toEqual({});
  });
});

describe('보내는 본문', () => {
  it('관리자는 공유 에이전트를 보내지 않고, 고치기는 이메일·아이디를 보내지 않는다', () => {
    expect(createBody(form({ role: 'admin', username: ' hong ' }))).toMatchObject({ username: 'hong', role: 'admin', pods: [], create_agent: true });
    const u = updateBody('k1', form());
    expect(u).toEqual({ id: 'k1', first_name: '길동', last_name: '홍', department: '', role: 'user', pods: ['one'] });
    expect(u).not.toHaveProperty('email');
    expect(u).not.toHaveProperty('username');
  });

  it('부서를 바꾸지 않았으면 department 키를 보내지 않는다(목록 밖 부서가 지워지지 않게, OMAI-1242)', () => {
    const same = updateBody('k1', form({ department: ' 옛   부서 ' }), '옛 부서');
    expect(same).not.toHaveProperty('department');                                       // 띄어쓰기만 다른 것도 같은 부서
    expect(updateBody('k1', form({ department: 'Dev' }), 'dev')).not.toHaveProperty('department');   // 대소문자만 다른 것도 같은 부서
    expect(updateBody('k1', form({ department: '영업팀' }), '개발팀')).toMatchObject({ department: '영업팀' });
    expect(updateBody('k1', form({ department: '' }), '개발팀')).toMatchObject({ department: '' });  // 비워서 지우기
    expect(updateBody('k1', form({ department: '' }), '')).not.toHaveProperty('department');
  });
});

describe('writeErrorView — 상태 표(V6)', () => {
  it('409 + field 는 그 칸의 인라인 오류다', () => {
    expect(writeErrorView(new ApiError('dup', 409, '', 'email'))).toEqual({ fields: { email: '이미 쓰는 이메일입니다' } });
    expect(writeErrorView(new ApiError('dup', 409, '', 'username'))).toEqual({ fields: { username: '이미 쓰는 아이디입니다' } });
  });

  it('400 + field 는 서버 문장을 그 칸에 보인다', () => {
    expect(writeErrorView(new ApiError('도메인이 다릅니다', 400, '', 'email'))).toEqual({ fields: { email: '도메인이 다릅니다' } });
  });

  it('403 forbidden 은 쓰기 잠금, 500 partial 은 남는 오류, 칸 없는 409 는 알림이다', () => {
    expect(writeErrorView(new ApiError('x', 403, 'forbidden'))).toMatchObject({ forbidden: true });
    expect(writeErrorView(new ApiError('x', 500, '', '', true), 'hong').partial).toBe(
      'OIDC 에 아이디 hong 이(가) 남았을 수 있습니다. 목록에서 확인한 뒤 지우십시오.'
    );
    expect(writeErrorView(new ApiError('마지막 관리자', 409))).toEqual({ fields: {}, alert: '마지막 관리자' });
    expect(writeErrorView(new Error('net'))).toEqual({ fields: {}, alert: 'net' });
  });

  it('409 로 겹친 사람이 「AAS 접근 없음」이면 그 사람을 찾는다', () => {
    const users = [kcUser({ id: 'a', key: 'a', email: 'x@corp.example', status: 'no_access' }), kcUser({ id: 'b', key: 'b', username: 'y' })];
    expect(grantableFor('email', 'X@corp.example', users)?.id).toBe('a');
    expect(grantableFor('username', 'y', users)).toBeUndefined(); // 이미 접근이 있다
  });
});

describe('표시', () => {
  it('권한은 관리자·사용자·없음이고, 뱃지는 사용 중지 → 손볼 상태 → 나·설치 때 지정됨 순서다', () => {
    expect(roleOf(kcUser({ admin: true }))).toBe('admin');
    expect(roleOf(kcUser({ status: 'no_access' }))).toBe('none');
    expect(roleOf(kcUser({}))).toBe('user');
    const pills = rolePills(kcUser({ email: ME, enabled: false, status: 'unmigrated', fixed: true, admin: true }), ME);
    expect(pills).toEqual([
      { key: 'users.pill.disabled' },
      { key: 'users.pill.unmigrated', tone: 'warn' },
      { key: 'users.me' },
      { key: 'users.pill.fixed' },
    ]);
  });
});

describe('임시 비밀번호', () => {
  it('crypto.getRandomValues 로 넷씩 네 묶음을 만든다(헷갈리는 글자 없음)', () => {
    const spy = vi.spyOn(crypto, 'getRandomValues');
    const p = makePassword();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    expect(p).toMatch(/^[A-HJ-NP-Za-km-z2-9]{4}(-[A-HJ-NP-Za-km-z2-9]{4}){3}$/);
    expect(p.length).toBeGreaterThanOrEqual(8);
    expect(makePassword()).not.toBe(p);
  });

  it('전달용 문구에 아이디·임시 비밀번호·로그인 주소·절차가 들어 있다', () => {
    const s = handoffText({ username: 'hong', password: 'Ab12-Cd34', loginUrl: 'https://aas.example.com' });
    expect(s).toContain('아이디: hong');
    expect(s).toContain('임시 비밀번호: Ab12-Cd34');
    expect(s).toContain('로그인 주소: https://aas.example.com');
    expect(s).toContain('첫 로그인 때 비밀번호를 바꿉니다');
  });
});

