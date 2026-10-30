/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 「사용자·권한」 Keycloak 방식의 상태 로직(2026-10-14-011 §5-3). 화면과 따로 두어 Vitest 로 시험한다.
// - userActions: 행 메뉴와 서랍이 함께 쓰는 동작별 보이기·잠금(V12). 서버도 같은 규칙으로 409 를 준다
// - validateUserForm: 추가·고치기 폼 입력 검사(V6)
// - writeErrorView: 쓰기 실패(409·400·403·500 일부만)를 칸 오류·띠·잠금으로 나눈다(V6)
// - makePassword: 임시 비밀번호(crypto.getRandomValues, K4)
import { t } from '@/i18n';
import { ApiError } from '@/lib/api';

import { teamKey } from './departments';

export type UserStatus = 'ok' | 'no_access' | 'no_account' | 'unmigrated';

/** GET /api/users 의 mode=keycloak 행(서버 계약 OMAI-1151) */
export interface KcUser {
  key: string;
  id: string;
  username: string;
  email: string;
  first_name: string;
  last_name: string;
  name: string;
  department: string;
  enabled: boolean;
  member: boolean;
  admin: boolean;
  admin_group: boolean;
  fixed: boolean;
  status: UserStatus;
  pods: string[];
  own_pods: string[];
  shared_pods: string[];
  sessions: number;
  logins: number;
  last_login: string | null;
  until: string | null;
  password: boolean;
  agents_running: number;
  agents_suspended: number;
}

export type KcReason = '' | 'unconfigured' | 'unreachable' | 'forbidden';

export interface KcUsersData {
  auth_enabled: boolean;
  domain?: string;
  me: string;
  mode: 'keycloak';
  keycloak: { ok: boolean; reason: KcReason; message: string };
  login_url: string;
  admin_count: number;
  unmigrated: string[];
  registry_file?: string;
  registry_error?: string;
  pods: { id: string; owner?: string; name?: string }[];
  users: KcUser[];
}

/** 한 동작의 상태. visible 이 거짓이면 그리지 않는다. locked 가 있으면 잠그고 그 이유를 보인다 */
export interface ActionState {
  visible: boolean;
  locked?: string;
}

export interface UserActionSet {
  edit: ActionState;
  /** 고치기 폼 안의 권한 칸(관리자 올리기·내리기) */
  role: ActionState;
  password: ActionState;
  access: ActionState;
  createAccount: ActionState;
  /** 사용 중지(행이 사용 중일 때) 또는 다시 사용(사용 중지일 때) */
  enable: ActionState;
  logout: ActionState;
  delete: ActionState;
}

const same = (a: string, b: string) => !!a && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * 행 하나에서 할 수 있는 동작(V12). 행 메뉴와 상세 서랍이 함께 부른다.
 * - 나: 사용 중지·삭제·관리자 빼기를 잠근다
 * - 마지막 관리자(사용 중인 관리자가 1명): 사용 중지·삭제·관리자 빼기를 잠근다
 * - 설치 때 지정됨(AAS_ADMINS): 권한·사용 중지·삭제를 잠근다. 비밀번호 재설정·로그인 끊기·정보 고치기는 허용
 * - writeLock(Keycloak 장애·쓰기 권한 없음): Keycloak 에 쓰는 동작을 모두 잠근다. 로그인 끊기는 AAS 세션이라 남긴다
 */
export function userActions(row: KcUser, me: string, adminCount: number, writeLock?: string): UserActionSet {
  const account = !!row.id;
  const self = same(row.email, me);
  const lastAdmin = row.admin && row.enabled && adminCount <= 1;
  const fixed = !!row.fixed;
  const lockFor = (what: 'disable' | 'delete' | 'demote'): string | undefined => {
    if (writeLock) return writeLock;
    if (fixed) return t('users.lock.fixed');
    if (self) return t('users.lock.self');
    if (lastAdmin) return t(`users.lock.last.${what}`);
    return undefined;
  };
  const disabling = row.enabled;
  return {
    edit: { visible: account, locked: writeLock },
    role: { visible: account, locked: row.admin ? lockFor('demote') : writeLock || (fixed ? t('users.lock.fixed') : undefined) },
    password: { visible: account, locked: writeLock },
    access: { visible: account && row.status === 'no_access', locked: writeLock },
    createAccount: { visible: row.status === 'no_account', locked: writeLock },
    enable: { visible: account, locked: disabling ? lockFor('disable') : writeLock },
    logout: { visible: (row.sessions ?? 0) > 0 },
    delete: { visible: account, locked: lockFor('delete') },
  };
}

export type RoleLabel = 'admin' | 'user' | 'none';

/** 권한 칸의 글(V9). 관리자 · 사용자 · 없음 — 점은 늘 무채색이다 */
export function roleOf(u: KcUser): RoleLabel {
  if (u.admin) return 'admin';
  if (u.status === 'no_access' || u.status === 'no_account') return 'none';
  return 'user';
}

/** 권한 칸 뱃지 순서(V9): ① 사용 중지 ② 손볼 상태(호박색) ③ 나 · 설치 때 지정됨 */
export function rolePills(u: KcUser, me: string): { key: string; tone?: 'warn' }[] {
  const out: { key: string; tone?: 'warn' }[] = [];
  if (u.id && !u.enabled) out.push({ key: 'users.pill.disabled' });
  if (u.status === 'no_access') out.push({ key: 'users.pill.noAccess', tone: 'warn' });
  if (u.status === 'no_account') out.push({ key: 'users.pill.noAccount', tone: 'warn' });
  if (u.status === 'unmigrated') out.push({ key: 'users.pill.unmigrated', tone: 'warn' });
  if (same(u.email, me)) out.push({ key: 'users.me' });
  if (u.fixed) out.push({ key: 'users.pill.fixed' });
  return out;
}

// ── 폼 ──

export interface UserFormValues {
  username: string;
  email: string;
  last_name: string;
  first_name: string;
  department: string;
  role: 'user' | 'admin';
  pods: string[];
  create_agent: boolean;
  password: string;
}

export type FormField = 'username' | 'email' | 'first_name' | 'last_name' | 'department' | 'password';
export type FieldErrors = Partial<Record<FormField, string>>;

export const PASSWORD_MIN = 8;
const USERNAME = /^[a-z0-9][a-z0-9._-]*$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 허용 도메인(AAS_ALLOWED_DOMAIN). 쉼표로 여럿일 수 있다. 비어 있으면 거르지 않는다 */
const domainOk = (email: string, domain?: string) => {
  const list = (domain ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  return !list.length || list.some((d) => email.toLowerCase().endsWith('@' + d));
};

/** 추가·고치기 폼 입력 검사. 고치기(edit)는 아이디·이메일·비밀번호를 받지 않는다(R2) */
export function validateUserForm(v: UserFormValues, mode: 'create' | 'edit', domain?: string): FieldErrors {
  const e: FieldErrors = {};
  if (mode === 'create') {
    const u = v.username.trim();
    if (!u) e.username = t('users.err.required');
    else if (u.includes('@')) e.username = t('users.err.usernameEmail');
    else if (!USERNAME.test(u)) e.username = t('users.err.usernameChars');
    const m = v.email.trim();
    if (!m) e.email = t('users.err.required');
    else if (!EMAIL.test(m)) e.email = t('users.err.email');
    else if (!domainOk(m, domain)) e.email = t('users.err.domain', { domain: domain ?? '' });
    if (v.password.length < PASSWORD_MIN) e.password = t('users.err.password', { n: PASSWORD_MIN });
  }
  if (!v.last_name.trim()) e.last_name = t('users.err.required');
  if (!v.first_name.trim()) e.first_name = t('users.err.required');
  return e;
}

/** 서버에 보내는 본문. 관리자는 모든 에이전트를 보므로 공유 목록을 보내지 않는다 */
export function createBody(v: UserFormValues) {
  return {
    username: v.username.trim(),
    email: v.email.trim(),
    first_name: v.first_name.trim(),
    last_name: v.last_name.trim(),
    department: v.department.trim(),
    role: v.role,
    pods: v.role === 'user' ? v.pods : [],
    password: v.password,
    create_agent: v.create_agent,
  };
}

/**
 * 고치기 본문. original(사용자의 지금 부서)과 같은 부서(team_key 기준)면 department 키를 보내지 않는다 — 서버는 키가 없으면 고치지 않는다.
 * 목록 밖 부서를 가진 사용자의 이름·권한만 고쳐도 부서가 지워지지 않게 한다(스펙 2026-10-15-026, 결정 R4 보존 동작 1·4).
 * original 을 주지 않으면 항상 보낸다(옛 호출).
 */
export function updateBody(id: string, v: UserFormValues, original?: string) {
  const dept = v.department.trim();
  return {
    id,
    first_name: v.first_name.trim(),
    last_name: v.last_name.trim(),
    ...(original === undefined || teamKey(dept) !== teamKey(original) ? { department: dept } : {}),
    role: v.role,
    pods: v.role === 'user' ? v.pods : [],
  };
}

// ── 쓰기 실패 ──

export interface WriteErrorView {
  /** 칸 옆에 보일 오류 */
  fields: FieldErrors;
  /** 폼 위 Alert(칸이 없는 오류) */
  alert?: string;
  /** 500 「일부만 만들어짐」: 폼에 남는 오류 */
  partial?: string;
  /** 403(Keycloak 쓰기 권한 없음): 이 뒤로 쓰기를 잠근다 */
  forbidden?: boolean;
}

const FIELDS: FormField[] = ['username', 'email', 'first_name', 'last_name', 'department', 'password'];
const isField = (f: string): f is FormField => (FIELDS as string[]).includes(f);

/** 쓰기 실패를 화면 표시로 나눈다(V6). username 은 「일부만 만들어짐」 문구에 넣는다 */
export function writeErrorView(err: unknown, username = ''): WriteErrorView {
  const e = err instanceof ApiError ? err : null;
  const message = (err as Error)?.message ?? String(err);
  if (!e) return { fields: {}, alert: message };
  if (e.partial) return { fields: {}, partial: t('users.err.partial', { username }) };
  if (e.status === 403 && e.reason === 'forbidden') return { fields: {}, alert: t('users.banner.writeForbidden'), forbidden: true };
  if (e.field && isField(e.field)) {
    if (e.status === 409 && (e.field === 'username' || e.field === 'email'))
      return { fields: { [e.field]: t(`users.err.taken.${e.field}`) } };
    return { fields: { [e.field]: message } };
  }
  return { fields: {}, alert: message };
}

/** 409 로 겹친 값의 주인이 「AAS 접근 없음」이면 그 사람을 돌려준다(「그 사람에게 AAS 접근 주기」 링크) */
export function grantableFor(field: string, value: string, users: KcUser[]): KcUser | undefined {
  const v = value.trim().toLowerCase();
  if (!v) return undefined;
  return users.find(
    (u) => u.status === 'no_access' && !!u.id && (field === 'email' ? u.email.toLowerCase() === v : u.username.toLowerCase() === v)
  );
}

// ── 임시 비밀번호 ──

// 헷갈리는 글자(0 O o 1 l I)를 뺀 56자. 넷씩 끊어 「-」로 잇는다(전달할 때 읽기 쉽게)
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

/** crypto.getRandomValues 로 만든 임시 비밀번호(K4). 나머지 치우침을 피하려고 범위 밖 값은 버린다 */
export function makePassword(groups = 4, size = 4): string {
  const need = groups * size;
  const limit = 256 - (256 % ALPHABET.length);
  const out: string[] = [];
  while (out.length < need) {
    const buf = new Uint8Array(need * 2);
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < limit && out.length < need) out.push(ALPHABET[b % ALPHABET.length]);
    }
  }
  const parts: string[] = [];
  for (let i = 0; i < groups; i += 1) parts.push(out.slice(i * size, (i + 1) * size).join(''));
  return parts.join('-');
}

/** 결과 창의 「전달용 문구 복사」 글(V4) */
export function handoffText(o: { username: string; password: string; loginUrl: string }): string {
  return t('users.result.handoff', { username: o.username, password: o.password, url: o.loginUrl });
}
