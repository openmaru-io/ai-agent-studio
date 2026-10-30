/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HistoryBack, ME_ADMIN, ME_USER, mountScreen, postedTo, rowByName, stubApi } from '@/test/mountScreen';

import { Users } from './Users';

const DATA = {
  auth_enabled: true,
  domain: 'corp.example',
  me: 'kim@corp.example',
  registry_file: '/etc/aas/users.json',
  pods: [{ id: 'one', name: '첫째 에이전트', owner: 'lee@corp.example' }, { id: 'two' }],
  users: [
    {
      email: 'kim@corp.example',
      admin: true,
      pods: ['one', 'two'],
      sessions: 1,
      logins: 5,
      last_login: '2026-10-10T09:00:00+09:00',
      until: '2026-10-11T09:00:00+09:00',
      password: false,
      fixed: true,
    },
    {
      email: 'lee@corp.example',
      admin: false,
      pods: ['one'],
      sessions: 0,
      logins: 0,
      password: true,
      fixed: false,
      grant: { ts: '2026-10-01T10:00:00+09:00', by: 'kim' },
    },
    {
      email: 'park@corp.example',
      admin: false,
      pods: [],
      sessions: 2,
      logins: 3,
      last_login: '2026-10-09T09:00:00+09:00',
      until: '2026-10-10T20:00:00+09:00',
      password: false,
      fixed: false,
    },
    {
      email: 'choi@corp.example',
      admin: true,
      pods: ['one', 'two'],
      sessions: 0,
      logins: 1,
      last_login: '2026-10-08T09:00:00+09:00',
      password: false,
      fixed: false,
      grant: { ts: '2026-10-02T10:00:00+09:00', by: 'kim' },
    },
  ],
};

afterEach(() => vi.unstubAllGlobals());

function mount(initial = '/users') {
  const fn = stubApi({ '/api/users/set': { ok: true }, '/api/users/logout': { ended: 2 }, '/api/users': DATA });
  mountScreen(<Users />, initial);
  return fn;
}
const posts = (fn: ReturnType<typeof mount>, path: string) =>
  fn.mock.calls
    .filter((c) => String(c[0]).startsWith(path))
    .map((c) => JSON.parse((c[1] as RequestInit).body as string));

describe('Users', () => {
  it('카드와 행 배지를 보인다', async () => {
    mount();
    expect(await screen.findByText('kim@corp.example')).toBeInTheDocument();
    expect(screen.getByText('corp.example 계정만 로그인할 수 있습니다')).toBeInTheDocument();
    expect(screen.getByText('세션 3개')).toBeInTheDocument();
    expect(screen.getByText('첫째 에이전트, two', { selector: '[data-card] *' })).toBeInTheDocument(); // 연결된 에이전트 카드
    expect(screen.getByText('나')).toBeInTheDocument();
    expect(screen.getByText('파일에서 지정됨')).toBeInTheDocument();
    expect(screen.getByText('AAS 비밀번호 있음')).toBeInTheDocument();
    expect(screen.getByText('연결된 AI 에이전트 작업공간 없음')).toBeInTheDocument();
    expect(screen.getByText('최근 31일 로그인 없음')).toBeInTheDocument();
    expect(screen.getByText('관리자만 이 화면을 볼 수 있습니다.', { exact: false })).toBeInTheDocument();
  });

  it('볼 수 있는 에이전트는 「주인 · 에이전트 이름」으로 보이고 id 는 풍선말에 둔다. 이름이 없으면 id 다(스펙 2026-10-19-003)', async () => {
    const user = userEvent.setup();
    mount();
    const row = await rowByName(/^lee@/);
    const chip = within(row).getByText('lee@corp.example · 첫째 에이전트'); // 옛 방식은 사람 이름이 없어 주인 이메일
    expect(chip.closest('[title]')).toHaveAttribute('title', 'one');
    expect(within(row).queryByText('one')).toBeNull();
    const kim = await rowByName(/^kim@/);
    expect(within(kim).getByText('two')).toBeInTheDocument(); // 이름을 짓지 않은 에이전트는 id
    await user.click(row);
    const dlg = await screen.findByRole('dialog', { name: 'lee@corp.example' });
    expect(within(dlg).getAllByText('lee@corp.example · 첫째 에이전트').length).toBeGreaterThan(0); // 칩과 권한 체크 글자
    expect(within(dlg).queryByText('one')).toBeNull();
  });

  it('관리자·지금 로그인됨 탭이 거른다', async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText('lee@corp.example');
    await user.click(screen.getByRole('tab', { name: /^관리자/ }));
    expect(screen.queryByText('lee@corp.example')).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /지금 로그인됨/ }));
    expect(screen.getByText('park@corp.example')).toBeInTheDocument();
    expect(screen.queryByText('lee@corp.example')).not.toBeInTheDocument();
  });

  it('파일에서 지정됨된 사람은 권한 폼 대신 안내를 보인다', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await rowByName(/^kim@/));
    const dlg = await screen.findByRole('dialog', { name: 'kim@corp.example' });
    expect(within(dlg).getByText(/\/etc\/aas\/users.json/)).toBeInTheDocument();
    expect(within(dlg).queryByRole('button', { name: '저장' })).not.toBeInTheDocument();
  });

  it('사용자 권한으로 저장하면 고른 에이전트와 함께 보낸다. 볼 수 있는 에이전트가 바뀌면 확인을 받는다', async () => {
    const user = userEvent.setup();
    const fn = mount();
    await user.click(await rowByName(/^park@/));
    const dlg = await screen.findByRole('dialog', { name: 'park@corp.example' });
    await user.click(within(dlg).getByRole('checkbox', { name: 'two' }));
    await user.click(within(dlg).getByRole('button', { name: '저장' }));
    expect(await screen.findByText('park@corp.example 이(가) 볼 수 있는 AI 에이전트 작업공간을 two(으)로 바꿉니다.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '확인' }));
    await waitFor(() =>
      expect(posts(fn, '/api/users/set')).toEqual([{ email: 'park@corp.example', role: 'user', pods: ['two'] }])
    );
  });

  it('관리자로 올릴 때는 확인을 받고, 취소하면 보내지 않는다', async () => {
    const user = userEvent.setup();
    const fn = mount();
    await user.click(await rowByName(/^lee@/));
    const dlg = await screen.findByRole('dialog', { name: 'lee@corp.example' });
    await user.selectOptions(within(dlg).getByRole('combobox', { name: '권한' }), 'admin');
    expect(within(dlg).queryByRole('checkbox')).not.toBeInTheDocument(); // 관리자는 에이전트를 고르지 않는다
    await user.click(within(dlg).getByRole('button', { name: '저장' }));
    expect(await screen.findByText(/관리자로 만듭니다/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '취소' }));
    expect(posts(fn, '/api/users/set')).toEqual([]);
    await user.click(await within(dlg).findByRole('button', { name: '저장' })); // 확인 창이 닫힌 뒤에야 서랍이 다시 보인다
    await user.click(await screen.findByRole('button', { name: '확인' }));
    await waitFor(() =>
      expect(posts(fn, '/api/users/set')).toEqual([{ email: 'lee@corp.example', role: 'admin', pods: [] }])
    );
  });

  it('바뀐 것이 없으면 확인 없이 저장하고, 관리자를 사용자로 내릴 때는 확인을 받는다', async () => {
    const user = userEvent.setup();
    const fn = mount();
    await user.click(await rowByName(/^lee@/));
    let dlg = await screen.findByRole('dialog', { name: 'lee@corp.example' });
    await user.click(within(dlg).getByRole('button', { name: '저장' }));
    await waitFor(() => expect(posts(fn, '/api/users/set')).toHaveLength(1));
    expect(screen.queryByRole('button', { name: '확인' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(await rowByName(/^choi@/));
    dlg = await screen.findByRole('dialog', { name: 'choi@corp.example' });
    await user.selectOptions(within(dlg).getByRole('combobox', { name: '권한' }), 'user');
    await user.click(within(dlg).getByRole('button', { name: '저장' }));
    expect(await screen.findByText(/관리자에서 사용자로 내립니다/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '취소' }));
    expect(posts(fn, '/api/users/set')).toHaveLength(1);
    await user.click(await within(dlg).findByRole('button', { name: '저장' }));
    await user.click(await screen.findByRole('button', { name: '확인' }));
    await waitFor(() =>
      expect(posts(fn, '/api/users/set')[1]).toEqual({ email: 'choi@corp.example', role: 'user', pods: ['one', 'two'] })
    );
  });

  it('접근 빼기는 부여 기록이 있는 사람에게만 보인다', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await rowByName(/^lee@/));
    let dlg = await screen.findByRole('dialog', { name: 'lee@corp.example' });
    expect(
      within(within(dlg).getByRole('combobox', { name: '권한' })).getByRole('option', { name: '접근 빼기' })
    ).toBeInTheDocument();
    expect(within(dlg).getByText(/부여: kim \(2026-10-01\)/)).toBeInTheDocument();
    await user.click(within(dlg).getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(await rowByName(/^park@/));
    dlg = await screen.findByRole('dialog', { name: 'park@corp.example' });
    expect(
      within(within(dlg).getByRole('combobox', { name: '권한' })).queryByRole('option', { name: '접근 빼기' })
    ).not.toBeInTheDocument();
  });

  it('사용자 추가: 이메일과 권한을 보내고 도메인 안내를 자리표시자로 쓴다', async () => {
    const user = userEvent.setup();
    const fn = mount();
    await user.click((await screen.findAllByRole('button', { name: '사용자 추가' }))[0]);
    const dlg = await screen.findByRole('dialog', { name: '사용자 추가' });
    const email = within(dlg).getByRole('textbox', { name: '이메일' });
    expect(email).toHaveAttribute('placeholder', '이름@corp.example');
    await user.type(email, ' new@corp.example ');
    await user.click(within(dlg).getByRole('checkbox', { name: 'lee@corp.example · 첫째 에이전트' }));
    await user.click(within(dlg).getByRole('button', { name: '저장' }));
    await waitFor(() =>
      expect(posts(fn, '/api/users/set')).toEqual([{ email: 'new@corp.example', role: 'user', pods: ['one'] }])
    );
  });

  it('저장이 거절되면 서랍 안에 오류를 알린다', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(
          new Response(JSON.stringify(url.startsWith('/api/users/set') ? { error: '도메인이 다릅니다' } : url.startsWith('/api/me') ? ME_ADMIN : DATA), {
            status: url.startsWith('/api/users/set') ? 400 : 200,
          })
        )
      )
    );
    mountScreen(<Users />, '/users');
    await user.click((await screen.findAllByRole('button', { name: '사용자 추가' }))[0]);
    const dlg = await screen.findByRole('dialog', { name: '사용자 추가' });
    await user.type(within(dlg).getByRole('textbox', { name: '이메일' }), 'x@other.com');
    await user.click(within(dlg).getByRole('button', { name: '저장' }));
    expect(await within(dlg).findByRole('alert')).toHaveTextContent('도메인이 다릅니다');
  });

  it('로그인 끊기는 서랍 머리의 단추이고, 확인을 받고 남의 세션이면 목록을 다시 받는다', async () => {
    const user = userEvent.setup();
    const fn = mount();
    await user.click(await rowByName(/^lee@/));
    let dlg = await screen.findByRole('dialog', { name: 'lee@corp.example' });
    expect(within(dlg).queryByRole('button', { name: '이 사람의 로그인 끊기' })).not.toBeInTheDocument(); // 세션이 없으면 없다
    await user.click(within(dlg).getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(await rowByName(/^park@/));
    dlg = await screen.findByRole('dialog', { name: 'park@corp.example' });
    const head = dlg.querySelector('[data-drawer-head]') as HTMLElement;
    await user.click(within(head).getByRole('button', { name: '이 사람의 로그인 끊기' }));
    const box = await screen.findByRole('dialog', { name: '이 사람의 로그인 끊기' });
    expect(box).toHaveTextContent('park@corp.example 의 로그인을 모두 끊습니다.');
    await user.click(within(box).getByRole('button', { name: '이 사람의 로그인 끊기' }));
    await waitFor(() => expect(posts(fn, '/api/users/logout')).toEqual([{ email: 'park@corp.example' }]));
    await waitFor(() => expect(fn.mock.calls.filter((c) => c[0] === '/api/users').length).toBeGreaterThan(1));
  });
});

describe('Users — 관리자가 아닌 사람', () => {
  it('주소로 들어오면 서버를 부르지 않고 빨간 오류 대신 안내와 대시보드로 가기를 보인다', async () => {
    const user = userEvent.setup();
    const fn = stubApi({ '/api/me': ME_USER, '/api/users': () => { throw new Error('부르면 안 된다'); } });
    mountScreen(<Users />, '/users');
    expect(await screen.findByText(/관리자만 볼 수 있는 화면입니다/)).toBeInTheDocument();
    expect(screen.queryByText('관리자만 볼 수 있습니다')).not.toBeInTheDocument();
    expect(fn.mock.calls.some((c) => String(c[0]).startsWith('/api/users'))).toBe(false);
    await user.click(screen.getByRole('button', { name: '대시보드로 가기' }));
    expect(screen.getByTestId('loc')).toHaveTextContent('/dashboard');
  });
});

describe('Users — mode 갈림(V5)', () => {
  it('legacy 는 옛 화면에 info 안내 띠를 단다', async () => {
    stubApi({ '/api/users': { ...DATA, mode: 'legacy' } });
    mountScreen(<Users />, '/users');
    await screen.findByText('kim@corp.example');
    const band = document.querySelector('[data-banner]') as HTMLElement;
    expect(band).toHaveAttribute('data-banner', 'info');
    expect(band).toHaveTextContent('OIDC 관리 설정이 없어 화면 권한만 줍니다');
  });
});

// ── Keycloak 방식(2026-10-14-011 §5-3) ──

const kc = (o: Record<string, unknown>) => ({
  key: o.id,
  username: '',
  email: '',
  first_name: '',
  last_name: '',
  name: '',
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

const KC = {
  auth_enabled: true,
  domain: 'corp.example',
  me: 'kim@corp.example',
  mode: 'keycloak',
  keycloak: { ok: true, reason: '', message: '' },
  login_url: 'https://aas.corp.example',
  admin_count: 1,
  unmigrated: [],
  pods: [
    { id: 'one', owner: 'lee@corp.example', name: '이사용 에이전트' },
    { id: 'two', owner: 'park@corp.example' },
  ],
  users: [
    kc({ id: 'k1', username: 'kim', email: 'kim@corp.example', name: '김관리', admin: true, admin_group: true, sessions: 1, pods: ['one', 'two'] }),
    kc({ id: 'k2', username: 'lee', email: 'lee@corp.example', name: '이사용', last_name: '이', first_name: '사용', pods: ['one'], own_pods: ['one'], department: '개발', agents_running: 2 }),
    kc({ id: 'k3', username: 'park', email: 'park@corp.example', name: '박중지', enabled: false, own_pods: ['two'], pods: ['two'], agents_suspended: 1 }),
    kc({ id: 'k4', username: 'choi', email: 'choi@corp.example', name: '최없음', member: false, status: 'no_access' }),
    kc({ id: '', key: 'email:old@corp.example', email: 'old@corp.example', status: 'no_account', enabled: false }),
  ],
};

const DEPTS = {
  departments: [
    { name: '개발팀', goal: '함께 만든다', ts: '2026-10-13T10:00:00+09:00' },
    { name: '영업팀', goal: '', ts: '2026-10-14T10:00:00+09:00' },
  ],
};

type Route = unknown | ((body: Record<string, unknown>) => unknown);
/** 주소별 응답. [상태, 본문] 을 주면 그 상태로 답한다(409·403·500 시험) */
function stubKc(routes: Record<string, Route> = {}, data: unknown = KC) {
  const table: Record<string, Route> = { '/api/departments': DEPTS, ...routes, '/api/users': data };
  const fn = vi.fn((url: string, init?: RequestInit) => {
    const key = Object.keys(table)
      .sort((a, b) => b.length - a.length)
      .find((k) => url.split('?')[0] === k);
    if (!key) {
      if (url.split('?')[0] === '/api/me') return Promise.resolve(new Response(JSON.stringify({ auth_enabled: false, admin: true }), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify({ error: 'no ' + url }), { status: 404 }));
    }
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const v = table[key];
    const out = typeof v === 'function' ? (v as (b: Record<string, unknown>) => unknown)(body) : v;
    const [status, payload] = Array.isArray(out) && typeof out[0] === 'number' ? (out as [number, unknown]) : [200, out];
    return Promise.resolve(new Response(JSON.stringify(payload), { status }));
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

async function openAdd(user: ReturnType<typeof userEvent.setup>) {
  await user.click((await screen.findAllByRole('button', { name: '사용자 추가' }))[0]);
  return screen.findByRole('dialog', { name: '사용자 추가' });
}

async function fillAdd(user: ReturnType<typeof userEvent.setup>, dlg: HTMLElement, o: { username?: string; email?: string } = {}) {
  await user.type(within(dlg).getByLabelText(/^아이디/), o.username ?? 'hong');
  await user.type(within(dlg).getByLabelText(/^이메일/), o.email ?? 'hong@corp.example');
  await user.type(within(dlg).getByLabelText(/^성/), '홍');
  await user.type(within(dlg).getByLabelText(/^이름/), '길동');
}

describe('Users — Keycloak 방식', () => {
  // 스펙 2026-10-28-014 D8·D9·D13: 행 서랍은 주소 ?open=<행 id> 와 묶이고(POD 와 관계없어 pod 는 쓰지 않음), 그 위에서 연 편집 서랍은 쌓인다
  it('행을 누르면 주소에 open 이 생기고, 「고치기」 편집 서랍은 위에 쌓여 저장 뒤 상세 서랍으로 돌아온다. 뒤로 가기는 상세를 닫는다', async () => {
    const user = userEvent.setup();
    const fn = stubKc({ '/api/users/update': { ok: true } });
    mountScreen(
      <>
        <Users />
        <HistoryBack />
      </>,
      '/users'
    );
    await user.click(await rowByName(/^lee\b/));
    const detail = await screen.findByRole('dialog', { name: 'lee' });
    expect(screen.getByTestId('loc')).toHaveTextContent(/^\/users\?open=k2$/);
    await user.click(await within(detail).findByRole('button', { name: '고치기' }));
    const form = await screen.findByRole('dialog', { name: 'lee 고치기' });
    await user.click(within(form).getByRole('button', { name: '저장' }));
    await waitFor(() => expect(postedTo(fn, '/api/users/update')).toHaveLength(1));
    expect(await screen.findByRole('dialog', { name: 'lee' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'lee 고치기' })).toBeNull();
    expect(screen.getByTestId('loc')).toHaveTextContent(/^\/users\?open=k2$/);
    fireEvent.click(screen.getByRole('button', { name: '뒤로 가기', hidden: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByTestId('loc')).toHaveTextContent(/^\/users$/);
  });

  it('없는 사람의 링크는 서랍 안에 찾지 못했다고 알린다', async () => {
    stubKc();
    mountScreen(<Users />, '/users?open=k-gone');
    expect(await screen.findByText('사람 k-gone 을(를) 찾지 못했습니다. 지워졌을 수 있습니다.')).toBeInTheDocument();
  });

  it('아이디가 첫 열이고, 보기 카드 일곱(확인할 두 보기는 경고 색), 무채색 권한 점과 뱃지를 보인다', async () => {
    stubKc();
    mountScreen(<Users />, '/users');
    await screen.findByText('김관리');
    const heads = screen.getAllByRole('columnheader').map((h) => h.textContent?.trim());
    expect(heads[0]).toMatch(/^아이디/);
    // 보기 카드(2026-10-17-011)가 탭 줄을 대신한다. 예전 「확인 필요 N」 카드는 두 보기 카드(AAS 접근 없음·OIDC 계정 없음)의 숫자로 나뉜다
    expect(document.querySelectorAll('[data-card]:not([data-toggle]):not([data-view-card])')).toHaveLength(0);
    const names = screen.getAllByRole('tab').map((x) => x.getAttribute('aria-label')?.split(', ')[0]);
    expect(names).toEqual(['전체', '관리자', '지금 로그인됨', 'AAS 접근 없음', 'OIDC 계정 없음', '부서', 'Claude Code 연결']);   // 연결 탭(스펙 2026-10-28-001 D19)
    expect(screen.getByRole('tab', { name: 'AAS 접근 없음, 1' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'OIDC 계정 없음, 1' })).toBeInTheDocument();
    // 관리자도 초록이 아닌 무채색 점
    const kimRow = await rowByName(/^kim\b/);
    expect(getComputedStyle(kimRow.querySelector('[data-dot]') as HTMLElement).backgroundColor).toBe('rgb(138, 143, 152)');
    expect(within(kimRow).getByText('나')).toBeInTheDocument();
    const parkRow = await rowByName(/^park\b/);
    expect(within(parkRow).getByText('사용 중지')).toBeInTheDocument();
    expect(parkRow.querySelector('[data-dim]')).not.toBeNull();
    // 사용 중지 거르기 배지
    expect(document.querySelector('[data-toggle]')).toHaveTextContent('1사용 중지');
  });

  it('「AAS 접근 없음」 보기 카드를 누르면 그 보기로 가고, 빈 보기는 보기마다 문구가 있다', async () => {
    const user = userEvent.setup();
    stubKc({}, { ...KC, users: KC.users.filter((x) => x.status === 'ok') });
    mountScreen(<Users />, '/users');
    await screen.findByText('김관리');
    await user.click(screen.getByRole('tab', { name: /^AAS 접근 없음, / }));
    expect(screen.getByRole('tab', { name: /^AAS 접근 없음/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('확인할 사람이 없습니다')).toBeInTheDocument();
  });

  it('볼 수 있는 에이전트는 「주인 · 에이전트 이름」, 본인 에이전트는 에이전트 이름으로 보인다. 이름이 없으면 id 다(스펙 2026-10-19-003)', async () => {
    const user = userEvent.setup();
    stubKc();
    mountScreen(<Users />, '/users');
    const row = await rowByName(/^lee\b/);
    const chip = within(row).getByText('이사용 · 이사용 에이전트');
    expect(chip.closest('[title]')).toHaveAttribute('title', 'one');
    expect(within(row).queryByText('one')).toBeNull();
    expect(within(await rowByName(/^park\b/)).getByText('박중지 · two')).toBeInTheDocument();
    await user.click(row);
    const dlg = await screen.findByRole('dialog');
    // 서랍 본문은 페이지 등록부의 늦게 불러오는 본문이다(스펙 2026-10-28-014 D8) — 그려질 때까지 기다린다
    expect(await within(dlg).findByText('이사용 · 이사용 에이전트')).toBeInTheDocument(); // 볼 수 있는 에이전트
    expect(within(dlg).getByText('이사용 에이전트')).toBeInTheDocument(); // 본인 에이전트: 주인이 이 사람이라 이름만
    expect(within(dlg).queryByText('one')).toBeNull();
  });

  it('행 메뉴는 상세 보기·고치기만 있다(V3)', async () => {
    const user = userEvent.setup();
    stubKc();
    mountScreen(<Users />, '/users');
    await user.click(await screen.findByRole('button', { name: 'lee 동작' }));
    const items = (await screen.findAllByRole('menuitem')).map((m) => m.textContent);
    expect(items).toEqual(['상세 보기', '고치기']);
  });

  it('OIDC 를 읽지 못하면 warning 띠를 달고 사용자 추가를 잠근다(이유는 설명으로 읽힌다)', async () => {
    stubKc({}, { ...KC, keycloak: { ok: false, reason: 'unreachable', message: '' } });
    mountScreen(<Users />, '/users');
    await screen.findByText('김관리');
    const band = document.querySelector('[data-banner]') as HTMLElement;
    expect(band).toHaveAttribute('data-banner', 'warning');
    expect(band).toHaveTextContent('OIDC 에 연결하지 못했습니다');
    for (const add of screen.getAllByRole('button', { name: '사용자 추가' })) {
      // 제목 옆 + 와 표 툴바의 글자 단추가 같이 잠긴다(2026-10-21-020)
      expect(add).toBeDisabled();
      expect(add).toHaveAccessibleDescription('OIDC 에 연결하지 못해 바꿀 수 없습니다');
    }
  });

  it('「사용자 추가」는 제목 옆의 + 아이콘이고, 표 툴바 오른쪽 끝에도 글자 단추가 있다(OMAI-1223 의 Keycloak 화면, 2026-10-21-020)', async () => {
    stubKc();
    mountScreen(<Users />, '/users');
    await screen.findByText('김관리');
    const [add, grid] = screen.getAllByRole('button', { name: '사용자 추가' });
    expect(add.textContent).toBe(''); // 글자 없이 아이콘만
    expect(screen.getByRole('heading', { level: 1 }).parentElement).toBe(add.parentElement?.parentElement); // 제목과 같은 줄
    expect(add.closest('[data-grid-toolbar]')).toBeNull();
    expect(grid.closest('[data-grid-toolbar]')).not.toBeNull();
  });

  it('서랍에 부서 행이 항상 있다: 부서가 있으면 이름, 비었으면 「지정 안 함」(OMAI-1270)', async () => {
    const user = userEvent.setup();
    stubKc();
    mountScreen(<Users />, '/users');
    await user.click(await rowByName(/^lee\b/));
    let dlg = await screen.findByRole('dialog');
    const row = (d: HTMLElement) => within(d).getByText('부서', { selector: 'dt' }).nextElementSibling;
    expect(row(dlg)).toHaveTextContent('개발');
    await user.click(within(dlg).getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(await rowByName(/^kim\b/)); // 부서가 없는 사용자도 행이 보인다
    dlg = await screen.findByRole('dialog');
    expect(row(dlg)).toHaveTextContent('지정 안 함');
  });

  it('나·마지막 관리자는 사용 중지·삭제가 잠기고, 이유를 설명으로 읽는다', async () => {
    const user = userEvent.setup();
    stubKc();
    mountScreen(<Users />, '/users');
    await user.click(await rowByName(/^kim\b/));
    const dlg = await screen.findByRole('dialog', { name: 'kim' });
    const head = dlg.querySelector('[data-drawer-head]') as HTMLElement;
    const del = within(head).getByRole('button', { name: '삭제' });
    expect(del).toHaveAttribute('aria-disabled', 'true');
    expect(del).toHaveAccessibleDescription('내 계정은 다른 관리자가 바꿔야 합니다');
    expect(within(head).getByRole('button', { name: '사용 중지' })).toHaveAttribute('aria-disabled', 'true');
    expect(within(head).getByRole('button', { name: '비밀번호 재설정' })).not.toHaveAttribute('aria-disabled');
    await user.click(del);
    expect(screen.queryByRole('dialog', { name: '삭제' })).not.toBeInTheDocument();
  });

  it('사용자 추가: 칸 검사(8자 비밀번호 포함) → 보내기 → 닫히지 않는 결과 창 → 닫으면 그 행을 연다', async () => {
    const user = userEvent.setup();
    const fn = stubKc({ '/api/users/create': { ok: true, id: 'k9', username: 'hong', email: 'hong@corp.example', agent: 'created' } });
    mountScreen(<Users />, '/users');
    const dlg = await openAdd(user);
    // 첫 칸에 커서
    await waitFor(() => expect(within(dlg).getByLabelText(/^아이디/)).toHaveFocus());
    const pw = within(dlg).getByLabelText(/^임시 비밀번호/) as HTMLInputElement;
    expect(pw).toHaveAttribute('type', 'password'); // 폼에서는 가린다
    const generated = pw.value;
    expect(generated.length).toBeGreaterThanOrEqual(8);
    expect(within(dlg).getByText('본인 AI 에이전트 작업공간(새로 만듦)')).toBeInTheDocument();
    await user.click(within(dlg).getByRole('button', { name: '저장' }));
    expect(within(dlg).getAllByText('입력합니다').length).toBe(4); // 아이디·이메일·성·이름
    await fillAdd(user, dlg);
    await user.clear(pw);
    await user.type(pw, '1234567');
    await user.click(within(dlg).getByRole('button', { name: '저장' }));
    expect(within(dlg).getByText('8자 이상이어야 합니다')).toBeInTheDocument();
    expect(postedTo(fn, '/api/users/create')).toEqual([]);
    await user.click(within(dlg).getByRole('button', { name: '다시 만들기' }));
    const pw2 = pw.value;
    await user.click(within(dlg).getByRole('checkbox', { name: '박중지 · two' }));
    await user.click(within(dlg).getByRole('button', { name: '저장' }));
    await waitFor(() =>
      expect(postedTo(fn, '/api/users/create')).toEqual([
        {
          username: 'hong',
          email: 'hong@corp.example',
          first_name: '길동',
          last_name: '홍',
          department: '',
          role: 'user',
          pods: ['two'],
          password: pw2,
          create_agent: true,
        },
      ])
    );
    const result = await screen.findByRole('dialog', { name: '계정을 만들었습니다' });
    expect(within(result).queryByText(pw2)).not.toBeInTheDocument(); // 보이기 전에는 가린다
    expect(within(result).getByText('https://aas.corp.example')).toBeInTheDocument();
    expect(within(result).getByText('만들었음')).toBeInTheDocument();
    await waitFor(() => expect(within(result).getByRole('button', { name: '전달용 문구 복사' })).toHaveFocus());
    await user.click(within(result).getByRole('button', { name: '보이기' }));
    expect(within(result).getByText(pw2)).toBeInTheDocument();
    // Esc·바깥 누르기로 닫히지 않는다
    await user.keyboard('{Escape}');
    await user.click(document.querySelector('.MuiBackdrop-root:last-of-type') as HTMLElement);
    expect(screen.getByRole('dialog', { name: '계정을 만들었습니다' })).toBeInTheDocument();
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    await user.click(within(result).getByRole('button', { name: '전달용 문구 복사' }));
    expect(write.mock.calls[0][0]).toContain('임시 비밀번호: ' + pw2);
    expect(within(result).getByRole('status')).toHaveTextContent('복사했습니다');
    await user.click(within(result).getByRole('button', { name: '전달했습니다, 닫기' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '계정을 만들었습니다' })).not.toBeInTheDocument());
    expect(screen.queryByText(pw2)).not.toBeInTheDocument(); // 닫으면 값을 버린다
    expect(screen.getByTestId('loc')).toHaveTextContent('open=k9');
    expect(generated).not.toBe(pw2);
  });

  it('409 아이디·이메일 겹침은 그 칸에 보이고, 겹친 사람이 AAS 접근 없음이면 접근 주기 링크를 준다', async () => {
    const user = userEvent.setup();
    const fn = stubKc({
      '/api/users/create': [409, { error: 'exists', field: 'email' }],
      '/api/users/access': { ok: true },
    });
    mountScreen(<Users />, '/users');
    const dlg = await openAdd(user);
    await fillAdd(user, dlg, { username: 'choi2', email: 'choi@corp.example' });
    await user.click(within(dlg).getByRole('button', { name: '저장' }));
    expect(await within(dlg).findByText('이미 쓰는 이메일입니다')).toBeInTheDocument();
    expect(within(dlg).getByLabelText(/^이메일/)).toHaveAttribute('aria-invalid', 'true');
    await user.click(within(dlg).getByRole('button', { name: '그 사람에게 AAS 접근 주기' }));
    const ask = await screen.findByRole('dialog', { name: 'AAS 에 추가' });
    await user.click(within(ask).getByRole('button', { name: 'AAS 에 추가' }));
    await waitFor(() => expect(postedTo(fn, '/api/users/access')).toEqual([{ id: 'k4' }]));
  });

  it('500 일부만 만들어짐은 폼에 남는 오류이고, 403 쓰기 권한 없음은 띠를 띄우고 쓰기를 잠근다', async () => {
    const user = userEvent.setup();
    let call = 0;
    stubKc({
      '/api/users/create': () => (++call === 1 ? [500, { error: 'rollback failed', partial: true }] : [403, { error: 'no', reason: 'forbidden' }]),
    });
    mountScreen(<Users />, '/users');
    const dlg = await openAdd(user);
    await fillAdd(user, dlg);
    await user.click(within(dlg).getByRole('button', { name: '저장' }));
    expect(await within(dlg).findByText(/OIDC 에 아이디 hong 이\(가\) 남았을 수 있습니다/)).toBeInTheDocument();
    await user.click(within(dlg).getByRole('button', { name: '저장' }));
    await waitFor(() => expect(within(dlg).getByRole('button', { name: '저장' })).toBeDisabled());
    expect(within(dlg).getByText(/남았을 수 있습니다/)).toBeInTheDocument(); // 일부만 오류는 남는다
    const band = document.querySelector('[data-banner]') as HTMLElement;
    expect(band).toHaveAttribute('data-banner', 'warning');
    expect(band).toHaveTextContent('manage-users');
    expect(screen.getAllByRole('button', { name: '사용자 추가', hidden: true })[0]).toBeDisabled(); // 서랍 뒤(가려진) 툴바
  });

  it('고치기는 아이디·이메일이 잠기고, 이메일 없이 보낸다. 부서를 바꾸지 않았으면 department 도 보내지 않는다(목록 밖 「개발」 이 지워지지 않게, OMAI-1242)', async () => {
    const user = userEvent.setup();
    const fn = stubKc({ '/api/users/update': { ok: true } });
    mountScreen(<Users />, '/users');
    await user.click(await screen.findByRole('button', { name: 'lee 동작' }));
    await user.click(await screen.findByRole('menuitem', { name: '고치기' }));
    const dlg = await screen.findByRole('dialog', { name: 'lee 고치기' });
    expect(within(dlg).getByLabelText(/^아이디/)).toBeDisabled();
    expect(within(dlg).getByLabelText(/^이메일/)).toBeDisabled();
    expect(within(dlg).queryByLabelText(/^임시 비밀번호/)).not.toBeInTheDocument();
    expect(within(dlg).getByText('본인 AI 에이전트 작업공간 이사용 에이전트')).toBeInTheDocument();
    expect(within(dlg).getByRole('checkbox', { name: '박중지 · two' })).toBeInTheDocument(); // 다른 사람의 에이전트: 「주인 이름 · 에이전트 이름」(2026-10-18-016)
    // lee 의 부서 「개발」 은 목록(개발팀·영업팀)에 없다: 값은 지우지 않고 보이며 칸 아래에 안내가 있다
    const box = await within(dlg).findByRole('combobox', { name: /^부서/ });
    expect(box).toHaveValue('개발');
    expect(within(dlg).getByText('이 부서는 목록에 없습니다. 그대로 두거나 목록에서 다시 고르세요.')).toBeInTheDocument();
    await user.click(within(dlg).getByRole('button', { name: '저장' }));
    await waitFor(() =>
      expect(postedTo(fn, '/api/users/update')).toEqual([{ id: 'k2', first_name: '사용', last_name: '이', role: 'user', pods: [] }])
    );
  });

  it('고치기에서 부서를 목록에서 고르면 그 부서가 간다', async () => {
    const user = userEvent.setup();
    const fn = stubKc({ '/api/users/update': { ok: true } });
    mountScreen(<Users />, '/users');
    await user.click(await screen.findByRole('button', { name: 'lee 동작' }));
    await user.click(await screen.findByRole('menuitem', { name: '고치기' }));
    const dlg = await screen.findByRole('dialog', { name: 'lee 고치기' });
    await user.click(await within(dlg).findByRole('combobox', { name: /^부서/ }));
    await user.click(await screen.findByRole('option', { name: '영업팀' }));
    await user.click(within(dlg).getByRole('button', { name: '저장' }));
    await waitFor(() => expect(postedTo(fn, '/api/users/update')[0]).toMatchObject({ id: 'k2', department: '영업팀' }));
  });

  it('추가에서 부서 목록이 비면 칸을 끄고 부서 탭 링크(새 탭)와 「목록 새로 고침」을 보인다', async () => {
    const user = userEvent.setup();
    stubKc({ '/api/departments': { departments: [] } });
    mountScreen(<Users />, '/users');
    const dlg = await openAdd(user);
    const box = await within(dlg).findByRole('combobox', { name: /^부서/ });
    expect(box).toBeDisabled();
    expect(within(dlg).getByRole('link', { name: '부서 목록' })).toHaveAttribute('target', '_blank');
    expect(within(dlg).getByRole('button', { name: '목록 새로 고침' })).toBeInTheDocument();
  });

  it('서버가 부서를 거절하면(400 department) 칸 옆 오류로 보인다', async () => {
    const user = userEvent.setup();
    stubKc({ '/api/users/create': () => [400, { error: '목록에 없는 부서입니다. 사용자 메뉴의 「부서」 카드에서 먼저 만드세요.', field: 'department' }] });
    mountScreen(<Users />, '/users');
    const dlg = await openAdd(user);
    await fillAdd(user, dlg);
    await user.click(await within(dlg).findByRole('combobox', { name: /^부서/ }));
    await user.click(await screen.findByRole('option', { name: '개발팀' }));
    await user.click(within(dlg).getByRole('button', { name: '저장' }));
    expect(await within(dlg).findByText('목록에 없는 부서입니다. 사용자 메뉴의 「부서」 카드에서 먼저 만드세요.')).toBeInTheDocument();
  });

  it('비밀번호 재설정은 확인 뒤 같은 결과 창을 띄운다', async () => {
    const user = userEvent.setup();
    const fn = stubKc({ '/api/users/password': { ok: true } });
    mountScreen(<Users />, '/users');
    await user.click(await rowByName(/^lee\b/));
    const dlg = await screen.findByRole('dialog', { name: 'lee' });
    await user.click(within(dlg.querySelector('[data-drawer-head]') as HTMLElement).getByRole('button', { name: '비밀번호 재설정' }));
    const box = await screen.findByRole('dialog', { name: '비밀번호 재설정' });
    await user.click(within(box).getByRole('button', { name: '비밀번호 재설정' }));
    const result = await screen.findByRole('dialog', { name: '비밀번호를 바꿨습니다' });
    const sent = postedTo(fn, '/api/users/password')[0] as { id: string; password: string };
    expect(sent.id).toBe('k2');
    expect(sent.password.length).toBeGreaterThanOrEqual(8);
    await user.click(within(result).getByRole('button', { name: '보이기' }));
    expect(within(result).getByText(sent.password)).toBeInTheDocument();
  });

  it('삭제는 아이디를 다시 입력해야 하고, 실패하면 창 안에 오류를 보이며, 성공하면 멈춘 에이전트로 가는 링크를 준다', async () => {
    const user = userEvent.setup();
    let call = 0;
    const fn = stubKc({
      '/api/users/delete': () => (++call === 1 ? [502, { error: 'Keycloak 연결 실패', reason: 'unreachable' }] : { ok: true, agents: ['one'] }),
    });
    mountScreen(<Users />, '/users');
    await user.click(await rowByName(/^lee\b/));
    const dlg = await screen.findByRole('dialog', { name: 'lee' });
    await user.click(within(dlg.querySelector('[data-drawer-head]') as HTMLElement).getByRole('button', { name: '삭제' }));
    const box = await screen.findByRole('dialog', { name: '삭제' });
    expect(box).toHaveTextContent('이 사람의 AI 에이전트 작업공간 2개가 멈춥니다');
    const ok = within(box).getByRole('button', { name: '삭제' });
    expect(ok).toBeDisabled();
    await user.type(within(box).getByLabelText('아이디 lee 을(를) 다시 입력'), 'lee');
    expect(ok).toBeEnabled();
    await user.click(ok);
    expect(await within(box).findByText('Keycloak 연결 실패')).toBeInTheDocument(); // 창을 닫지 않는다
    await user.click(within(box).getByRole('button', { name: '삭제' }));
    await waitFor(() => expect(postedTo(fn, '/api/users/delete')).toEqual([{ id: 'k2' }, { id: 'k2' }]));
    await user.click(await screen.findByRole('button', { name: 'AI 에이전트 작업공간에서 소유권 옮기기' }));
    expect(screen.getByTestId('loc')).toHaveTextContent('/agents?q=one');
  });

  it('사용 중지된 사람은 다시 사용(Tier 1 확인)으로 에이전트 수를 알린다', async () => {
    const user = userEvent.setup();
    const fn = stubKc({ '/api/users/enable': { ok: true, agents: 1 } });
    mountScreen(<Users />, '/users');
    await user.click(await rowByName(/^park\b/));
    const dlg = await screen.findByRole('dialog', { name: 'park' });
    await user.click(within(dlg.querySelector('[data-drawer-head]') as HTMLElement).getByRole('button', { name: '다시 사용' }));
    const box = await screen.findByRole('dialog', { name: '다시 사용' });
    expect(box).toHaveTextContent('멈춘 AI 에이전트 작업공간 1개를 다시 켭니다');
    await user.click(within(box).getByRole('button', { name: '다시 사용' }));
    await waitFor(() => expect(postedTo(fn, '/api/users/enable')).toEqual([{ id: 'k3', enabled: true }]));
  });
});

// ── 부서 탭(스펙 2026-10-15-026, 디자인 리뷰) ──
describe('Users — 부서 탭', () => {
  beforeEach(() => localStorage.clear());

  async function openTab(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('tab', { name: /^부서/ }));
    return screen.findByRole('table', { name: '부서' });
  }
  const names = (table: HTMLElement) => within(table).getAllByRole('row').slice(1).map((r) => r.textContent ?? '');

  it('탭 배지는 목록 + 목록 밖 줄 수이고, 목록 밖이 있으면 호박색이다. 목록 밖 줄이 맨 위에 경고 알약과 함께 있다', async () => {
    const user = userEvent.setup();
    stubKc();
    mountScreen(<Users />, '/users');
    const tab = await screen.findByRole('tab', { name: /^부서/ });
    expect(tab).toHaveAttribute('data-count', '3');                                     // 개발팀·영업팀 + lee 의 목록 밖 「개발」
    // 보기 카드(2026-10-17-011)의 숫자 색: 목록 밖이 있으면 호박색이라 색이 없는 「관리자」 보기 카드의 숫자와 다르다
    const color = (x: HTMLElement) => getComputedStyle(x.querySelector('[data-card-n]') as HTMLElement).color;
    expect(color(tab)).not.toBe(color(screen.getByRole('tab', { name: /^관리자, / })));
    const table = await openTab(user);
    const rows = names(table);
    expect(rows[0]).toContain('개발');
    expect(rows[0]).toContain('목록에 없음');
    expect(rows[1]).toContain('개발팀');
    expect(rows[2]).toContain('영업팀');
  });

  it('부서 상세 창의 슬로건 줄에서 AI 추천을 고르면 그 부서 슬로건으로 바로 저장한다(2026-10-17-015)', async () => {
    const user = userEvent.setup();
    const saved: Record<string, unknown>[] = [];
    stubKc({
      '/api/settings/goal/suggest': { suggestions: ['영업은 신뢰다', '고객 곁에서', '한 번 더 듣는다'] },
      '/api/settings/goal': (b: Record<string, unknown>) => (saved.push(b), { ok: true, ...b }),
    });
    mountScreen(<Users />, '/users');
    const table = await openTab(user);
    await user.click(await within(table).findByRole('row', { name: /^영업팀/ }));
    await user.click(await screen.findByRole('button', { name: '영업팀 슬로건을 AI 로 추천받기' }));
    const dialog = await screen.findByRole('dialog', { name: '영업팀 슬로건 AI 추천' });
    await user.click((await within(dialog).findAllByRole('option'))[2]);
    await user.click(within(dialog).getByRole('button', { name: '이 슬로건으로 저장' }));
    await waitFor(() => expect(saved).toEqual([{ team: '영업팀', goal: '한 번 더 듣는다' }]));
    expect(await screen.findByText('영업팀 문구를 저장했습니다')).toBeInTheDocument();
  });

  it('표에는 사람 수(Keycloak 기준)와 슬로건 글자가 있고, 안내 띠는 닫으면 다시 보이지 않는다', async () => {
    const user = userEvent.setup();
    stubKc();
    mountScreen(<Users />, '/users');
    const table = await openTab(user);
    const dev = await within(table).findByRole('row', { name: /^개발팀/ });
    expect(within(dev).getByText('함께 만든다')).toBeInTheDocument();
    const off = await within(table).findByRole('row', { name: /^개발\s*목록에 없음/ });
    expect(within(off).getByText('1')).toBeInTheDocument();                           // lee 한 명
    expect(screen.getByText(/기존 사용자·슬로건·오피스에서 부서를 가져왔습니다/)).toBeInTheDocument();
    await user.click(within(screen.getByRole('status')).getByRole('button', { name: /close|닫기/i }));
    expect(screen.queryByText(/기존 사용자·슬로건·오피스에서 부서를 가져왔습니다/)).not.toBeInTheDocument();
    expect(localStorage.getItem('aas.dept.seedNote')).toBe('1');
  });

  it('제목 옆 + 는 부서 탭에서 「부서 추가」, 다른 탭에서 「사용자 추가」다', async () => {
    const user = userEvent.setup();
    stubKc();
    mountScreen(<Users />, '/users');
    expect((await screen.findAllByRole('button', { name: '사용자 추가' }))[0]).toBeInTheDocument();
    await openTab(user);
    expect(screen.getAllByRole('button', { name: '부서 추가' })[0]).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '사용자 추가' })).not.toBeInTheDocument();
  });

  it('부서가 하나도 없으면 이유와 행동이 든 한 문장을 보인다', async () => {
    const user = userEvent.setup();
    stubKc({ '/api/departments': { departments: [] } }, { ...KC, users: KC.users.map((x) => ({ ...x, department: '' })) });
    mountScreen(<Users />, '/users');
    await openTab(user);
    expect(await screen.findByText('아직 부서가 없습니다. 제목 옆 + 로 부서를 추가하면 사용자를 추가·수정할 때 목록에서 고를 수 있습니다.')).toBeInTheDocument();
  });

  it('부서 추가: 이름을 보내고, 겹치면(409) 칸 아래 오류를 보인다', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const fn = stubKc({ '/api/departments/create': () => (++calls === 1 ? { ok: true, name: '기획팀' } : [409, { error: 'dup', field: 'name' }]) });
    mountScreen(<Users />, '/users');
    await openTab(user);
    await user.click(screen.getAllByRole('button', { name: '부서 추가' })[0]);
    let dlg = await screen.findByRole('dialog', { name: '부서 추가' });
    await user.type(within(dlg).getByLabelText('부서 이름'), '  기획   팀 ');
    expect(within(dlg).getByText('4/80')).toBeInTheDocument();
    await user.click(within(dlg).getByRole('button', { name: '추가' }));
    await waitFor(() => expect(postedTo(fn, '/api/departments/create')).toEqual([{ name: '기획 팀' }]));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '부서 추가' })).not.toBeInTheDocument());
    await user.click(screen.getAllByRole('button', { name: '부서 추가' })[0]);
    dlg = await screen.findByRole('dialog', { name: '부서 추가' });
    await user.type(within(dlg).getByLabelText('부서 이름'), '기획팀{Enter}');
    expect(await within(dlg).findByText('이미 있는 부서입니다')).toBeInTheDocument();
  });

  it('사람이 있는 부서의 삭제는 이유 대화상자를 띄우고 「구성원 보기」가 서랍을 연다', async () => {
    const user = userEvent.setup();
    const data = { ...KC, users: KC.users.map((x) => (x.username === 'lee' ? { ...x, department: '개발팀' } : x)) };
    const fn = stubKc({ '/api/departments/delete': { ok: true } }, data);
    mountScreen(<Users />, '/users');
    const table = await openTab(user);
    await user.click(within(table).getByRole('button', { name: /개발팀/ }));
    await user.click(await screen.findByRole('menuitem', { name: '삭제' }));
    const dlg = await screen.findByRole('dialog', { name: '삭제할 수 없습니다' });
    expect(dlg).toHaveTextContent('이 부서에는 사람이 1명 있어 삭제할 수 없습니다. 먼저 사용자의 부서를 바꾸세요.');
    expect(postedTo(fn, '/api/departments/delete')).toEqual([]);
    await user.click(within(dlg).getByRole('button', { name: '구성원 보기' }));
    const drawer = await screen.findByRole('dialog', { name: '개발팀' });
    expect(drawer).toHaveTextContent('이사용');
  });

  it('사람이 없는 부서는 확인 뒤 지운다(슬로건이 있으면 문구에 알린다)', async () => {
    const user = userEvent.setup();
    const fn = stubKc({ '/api/departments/delete': { ok: true } });
    mountScreen(<Users />, '/users');
    const table = await openTab(user);
    await user.click(within(table).getByRole('button', { name: /개발팀/ }));
    await user.click(await screen.findByRole('menuitem', { name: '삭제' }));
    const box = await screen.findByRole('dialog', { name: '부서 삭제' });
    expect(box).toHaveTextContent('「개발팀」 부서를 삭제합니다. 슬로건도 함께 지워집니다.');
    await user.click(within(box).getByRole('button', { name: '삭제' }));
    await waitFor(() => expect(postedTo(fn, '/api/departments/delete')).toEqual([{ name: '개발팀' }]));
  });

  it('목록 밖 줄은 「목록에 추가」와 이름 바꾸기가 있고 삭제는 없다. 목록에 추가는 만들기를 보낸다', async () => {
    const user = userEvent.setup();
    const fn = stubKc({ '/api/departments/create': { ok: true, name: '개발' } });
    mountScreen(<Users />, '/users');
    const table = await openTab(user);
    await user.click(within(table).getByRole('button', { name: '개발 동작' }));
    expect(screen.queryByRole('menuitem', { name: '삭제' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '이름 바꾸기' })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: '목록에 추가' }));
    await waitFor(() => expect(postedTo(fn, '/api/departments/create')).toEqual([{ name: '개발' }]));
  });

  it('이름 바꾸기가 일부만 되면 결과 대화상자가 명단과 「다시 시도」를 보이고 Esc 로 닫히지 않는다', async () => {
    const user = userEvent.setup();
    let n = 0;
    const fn = stubKc({
      '/api/departments/rename': () =>
        ++n === 1
          ? { ok: true, partial: true, name: '영업본부', changed: 1, total: 2, failed: [{ name: '박중지', username: 'park' }] }
          : { ok: true, name: '영업본부', changed: 1, total: 1 },
    });
    mountScreen(<Users />, '/users');
    const table = await openTab(user);
    await user.click(within(table).getByRole('button', { name: /영업팀/ }));
    await user.click(await screen.findByRole('menuitem', { name: '이름 바꾸기' }));
    const dlg = await screen.findByRole('dialog', { name: '부서 이름 바꾸기' });
    expect(dlg).toHaveTextContent('이 부서의 사람 0명의 부서도 함께 바뀝니다.');
    const input = within(dlg).getByLabelText('부서 이름');
    await user.clear(input);
    await user.type(input, '영업본부');
    await user.click(within(dlg).getByRole('button', { name: '바꾸기' }));
    const res = await screen.findByRole('dialog', { name: '일부만 바꿨습니다' });
    expect(res).toHaveTextContent('2명 중 1명만 바꿨습니다.');
    expect(res).toHaveTextContent('박중지 (park)');
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: '일부만 바꿨습니다' })).toBeInTheDocument();
    await user.click(within(res).getByRole('button', { name: '다시 시도' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '일부만 바꿨습니다' })).not.toBeInTheDocument());
    expect(postedTo(fn, '/api/departments/rename')).toEqual([
      { name: '영업팀', new_name: '영업본부' },
      { name: '영업팀', new_name: '영업본부' },
    ]);
  });

  it('Keycloak 에 닿지 않으면 사람 수는 0 이 아니라 「알 수 없음」이고 목록 밖 줄은 만들지 않으며 삭제는 확인하지 못했다고 알린다', async () => {
    const user = userEvent.setup();
    const down = { ...KC, keycloak: { ok: false, reason: 'unreachable', message: '' }, users: [] };
    const fn = stubKc({ '/api/departments/delete': { ok: true } }, down);
    mountScreen(<Users />, '/users');
    const table = await openTab(user);
    expect(names(table).every((r) => !r.includes('목록에 없음'))).toBe(true);
    expect(within(await within(table).findByRole('row', { name: /^개발팀/ })).getByText('알 수 없음')).toBeInTheDocument();
    await user.click(within(table).getByRole('button', { name: /개발팀/ }));
    await user.click(await screen.findByRole('menuitem', { name: '삭제' }));
    const dlg = await screen.findByRole('dialog', { name: '삭제할 수 없습니다' });
    expect(dlg).toHaveTextContent('사람 수를 확인하지 못했습니다. 잠시 뒤 다시 시도하세요.');
    expect(within(dlg).queryByRole('button', { name: '구성원 보기' })).not.toBeInTheDocument();
    expect(postedTo(fn, '/api/departments/delete')).toEqual([]);
  });
});
