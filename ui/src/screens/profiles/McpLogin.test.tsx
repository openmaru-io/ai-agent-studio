/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountScreen } from '@/test/mountScreen';

import { loginView } from './McpLogin';
import { AddServerDialog } from './McpServers';
import { ToolsPane } from './Panes';
import { detailRefetchMs, MCP_SETTLE_POLL_MS, mergeMcpLogin } from './shared';
import type { McpItem, McpLoginState, ProfileDetailData } from './types';

const spies: { mockRestore: () => void }[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  spies.splice(0).forEach((s) => s.mockRestore());
});
const openSpy = (ret: Window | null) => {
  const s = vi.spyOn(window, 'open').mockReturnValue(ret);
  spies.push(s);
  return s;
};

const row = (login_state: McpLoginState | null, over: Partial<McpItem> = {}): McpItem => ({
  name: 'jira',
  transport: 'http',
  target: 'https://mcp.example.com/mcp',
  env_names: [],
  enabled: true,
  auth: 'oauth',
  login_state,
  ...over,
});

const D = (over: Partial<ProfileDetailData> = {}) =>
  ({
    profile: { name: 'ma' },
    pod: 'p1',
    can_edit: true,
    owner: false,
    secure: true,
    mcp: [],
    ...over,
  } as unknown as ProfileDetailData);

/** 상태 묻기는 차례대로 statuses 를 돌려주고, 마지막 값을 계속 준다 */
function fakeApi(statuses: unknown[] = [{ status: 'none' }]) {
  let i = 0;
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith('/api/mcp/oauth/status'))
      return new Response(JSON.stringify(statuses[Math.min(i++, statuses.length - 1)]), { status: 200 });
    if (u.startsWith('/api/mcp/oauth/cancel'))
      return new Response(JSON.stringify({ ok: true, cancelled: 1 }), { status: 200 });
    if (u.startsWith('/api/profile/action')) {
      // 대화 상자가 카탈로그로 열리며 곧바로 읽는다(2026-10-23)
      const action = init?.body ? (JSON.parse(String(init.body)) as { action?: string }).action : '';
      return new Response(JSON.stringify(action === 'mcp_catalog' ? { entries: [], hidden: { oauth: 0, install: 0, unknown: 0 } } : { ok: true }), { status: 200 });
    }
    if (u.split('?')[0] === '/api/me')
      return new Response(JSON.stringify({ auth_enabled: false, admin: true, user: null }), { status: 200 });
    return new Response(JSON.stringify({ error: '없는 주소 ' + u }), { status: 404 });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}
const calls = (fn: ReturnType<typeof fakeApi>, prefix: string) =>
  fn.mock.calls.filter((c) => String(c[0]).startsWith(prefix));

describe('OAuth 서버 행 모습(loginView, 11-3)', () => {
  it('상태마다 알약·주 단추가 정해진다', () => {
    const cases: [McpLoginState | null, string, string, string][] = [
      [null, '확인 전', 'login', 'neutral'],
      [{ state: 'login_required' }, '로그인 필요', 'login', 'warn'],
      [{ state: 'logging_in', mine: true }, '로그인 중', 'cancel', 'neutral'],
      [{ state: 'logging_in', mine: false }, '로그인 중', 'none', 'neutral'],
      [{ state: 'logging_in', connecting: true }, '연결하는 중', 'none', 'neutral'],
      [{ state: 'disabled_logged_in' }, '꺼짐 · 로그인됨', 'none', 'neutral'],
      [{ state: 'connected', tools: 3 }, '연결됨 · 도구 3개', 'test', 'good'],
      [{ state: 'reauth_required' }, '다시 로그인 필요', 'relogin', 'warn'],
      [{ state: 'connect_failed', message: 'refused' }, '연결 실패', 'test', 'bad'],
      [{ state: 'unavailable', message: '에어갭' }, '이 환경에서 쓸 수 없음', 'none', 'neutral'],
    ];
    for (const [ls, label, primary, tone] of cases) {
      const v = loginView(row(ls), true);
      expect([v.label, v.primary, v.tone], JSON.stringify(ls)).toEqual([label, primary, tone]);
    }
    expect(loginView(row({ state: 'connect_failed', message: 'refused' }), true).note).toBe('refused');
  });

  it('보기 권한자는 단추가 없고 로그인이 필요하면 「에이전트 주인이 로그인해야 합니다」를 본다(V17)', () => {
    const v = loginView(row({ state: 'login_required' }), false);
    expect([v.primary, v.note]).toEqual(['none', 'AI 에이전트 작업공간 소유자가 로그인해야 합니다']);
    expect(loginView(row({ state: 'connected', tools: 1 }), false).primary).toBe('none');
  });
});

describe('OAuth 서버 행의 로그인(T6·V9·V10)', () => {
  it('로그인 필요 행은 「로그인」 하나를 보이고, 누르면 시작 경로를 팝업으로 연다. 진행 중을 본 뒤의 approved 만 끝으로 받는다', async () => {
    const fn = fakeApi([{ status: 'approved' }, { status: 'waiting' }, { status: 'approved' }]); // 첫 approved 는 이전 로그인 기록
    const open = openSpy({} as Window);
    mountScreen(<ToolsPane d={D({ mcp: [row({ state: 'login_required' })] })} />, '/profiles');
    expect(await screen.findByText('로그인 필요')).toBeInTheDocument();
    expect(screen.getByText('로그인해야 AI 에이전트가 이 서버의 도구를 씁니다')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '연결 시험' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'jira 로그인' }));
    expect(open).toHaveBeenCalledWith(
      '/oauth/mcp/start?pod=p1&profile=ma&server=jira',
      'aas-mcp-oauth-jira',
      expect.stringContaining('popup')
    );
    expect(await screen.findByText('로그인 중')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '취소' })).toBeInTheDocument();
    expect(await screen.findByText('jira 서버에 로그인했습니다', undefined, { timeout: 6000 })).toBeInTheDocument();
    expect(calls(fn, '/api/mcp/oauth/status').length).toBeGreaterThanOrEqual(3);
    expect(String(calls(fn, '/api/mcp/oauth/status')[0][0])).toBe(
      '/api/mcp/oauth/status?pod=p1&profile=ma&server=jira'
    );
  }, 10000);

  it('팝업이 막히면 같은 창에서 시작 경로로 간다', async () => {
    fakeApi();
    openSpy(null);
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign, origin: window.location.origin });
    mountScreen(<ToolsPane d={D({ mcp: [row({ state: 'reauth_required' })] })} />, '/profiles');
    await userEvent.click(await screen.findByRole('button', { name: 'jira 다시 로그인' }));
    expect(assign).toHaveBeenCalledWith('/oauth/mcp/start?pod=p1&profile=ma&server=jira');
  });

  it('새로고침 뒤 내가 시작한 로그인 중이면 「취소」로 끝낼 수 있다', async () => {
    const fn = fakeApi([{ status: 'waiting' }]);
    mountScreen(<ToolsPane d={D({ mcp: [row({ state: 'logging_in', mine: true })] })} />, '/profiles');
    await userEvent.click(await screen.findByRole('button', { name: '취소' }));
    await waitFor(() => expect(calls(fn, '/api/mcp/oauth/cancel')).toHaveLength(1));
    expect(JSON.parse(String((calls(fn, '/api/mcp/oauth/cancel')[0][1] as RequestInit).body))).toEqual({
      pod: 'p1',
      profile: 'ma',
      server: 'jira',
    });
    expect(await screen.findByText('jira 로그인을 취소했습니다')).toBeInTheDocument();
  });

  it('연결된 행은 알약과 「연결 시험」, 보기 권한자는 단추 없이 안내만 본다', async () => {
    fakeApi();
    const { unmount } = mountScreen(<ToolsPane d={D({ mcp: [row({ state: 'connected', tools: 2 })] })} />, '/profiles');
    expect(await screen.findByText('연결됨 · 도구 2개')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '연결 시험' })).toBeInTheDocument();
    unmount();
    mountScreen(
      <ToolsPane d={D({ can_edit: false, owner: false, mcp: [row({ state: 'login_required' })] })} />,
      '/profiles'
    );
    expect(await screen.findByText('AI 에이전트 작업공간 소유자가 로그인해야 합니다')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'jira 로그인' })).not.toBeInTheDocument();
  });

  it('헤더 서버 행은 예전 모습 그대로다(알약 없음, 연결 시험)', async () => {
    fakeApi();
    mountScreen(<ToolsPane d={D({ mcp: [row(null, { name: 'docs', auth: 'header' })] })} />, '/profiles');
    expect(await screen.findByRole('button', { name: '연결 시험' })).toBeInTheDocument();
    expect(screen.queryByText('확인 전')).not.toBeInTheDocument();
  });
});

describe('추가 대화 상자의 OAuth(V7)', () => {
  // OAuth 서버는 게이트웨이가 다시 시작 없이 설정을 읽고, 로그인하면 바로 붙는다(14-2·14-5, OKE 2026-10-17 14-16).
  // 「다시 시작해야 씁니다」 안내를 띄우면 「연결됨」 옆에 맞지 않는 안내가 남는다
  const addVia = async (oauth: boolean) => {
    fakeApi();
    mountScreen(<ToolsPane d={D({ mcp: [] })} />, '/profiles');
    await userEvent.click((await screen.findByRole('button', { name: '새 MCP 서버' })));
    await userEvent.click(await screen.findByRole('button', { name: '원격 주소' }));   // 대화 상자는 카탈로그로 열린다(2026-10-23)
    await userEvent.type(await screen.findByLabelText(/이름/), 'jira');
    await userEvent.type(screen.getByLabelText(/주소/), 'https://mcp.example.com/mcp');
    if (oauth) await userEvent.click(screen.getByRole('button', { name: 'OAuth', pressed: false }));
    await userEvent.click(screen.getByRole('button', { name: '추가' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: /MCP 서버 추가/ })).toBeNull());
  };
  it('OAuth 로 추가하면 게이트웨이를 다시 시작하라는 안내를 띄우지 않는다', async () => {
    await addVia(true);
    expect(screen.queryByText(/MCP 서버 설정을 바꿨습니다/)).toBeNull();
  });
  it('인증 없이 추가하면 지금처럼 안내를 띄운다', async () => {
    await addVia(false);
    expect(await screen.findByText(/MCP 서버 설정을 바꿨습니다/)).toBeInTheDocument();
  });

  it('OAuth 를 고르면 콜백 주소와 복사 단추를 보이고, 토큰 없이 auth=oauth 로 추가한다', async () => {
    const fn = fakeApi();
    const onAdded = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    mountScreen(
      <AddServerDialog
        open
        name="ma"
        secure={false}
        callbackUrl="https://aas.example.com/oauth/mcp/callback"
        onClose={vi.fn()}
        onAdded={onAdded}
      />,
      '/profiles'
    );
    await userEvent.click(await screen.findByRole('button', { name: '원격 주소' }));   // 대화 상자는 카탈로그로 열린다(2026-10-23)
    await userEvent.type(await screen.findByLabelText(/이름/), 'jira');
    await userEvent.type(screen.getByLabelText(/주소/), 'https://mcp.example.com/mcp');
    await userEvent.click(screen.getByRole('button', { name: 'OAuth', pressed: false }));
    expect(screen.getByDisplayValue('https://aas.example.com/oauth/mcp/callback')).toHaveAttribute('readonly');
    await userEvent.click(screen.getByRole('button', { name: '복사' }));
    expect(writeText).toHaveBeenCalledWith('https://aas.example.com/oauth/mcp/callback');
    expect(screen.queryByText(/암호화되지 않은 주소/)).not.toBeInTheDocument(); // 비밀값이 없어 http 화면에서도 된다
    await userEvent.click(screen.getByRole('button', { name: '추가' }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith('jira', { oauth: true }));
    // 첫 요청이 주소 확인(mcp_url_check, 입력이 300ms 멈추면 나간다)일 수 있어 추가 요청을 찾는다(2026-10-22)
    const body = calls(fn, '/api/profile/action')
      .map((c) => JSON.parse(String((c[1] as RequestInit).body)) as Record<string, unknown>)
      .find((b) => b.action === 'mcp_add');
    expect(body).toEqual({
      name: 'ma',
      action: 'mcp_add',
      kind: 'url',
      server: 'jira',
      url: 'https://mcp.example.com/mcp',
      auth: 'oauth',
    });
  });
});

describe('추가 대화 상자의 가능 여부·그래도 추가·미리 등록한 클라이언트(V2·V16·V7)', () => {
  const BLOCKED = {
    verdict: 'blocked',
    reason: 'airgap',
    message: '이 환경에서 쓸 수 없음: 외부 인터넷 연결이 필요합니다. 이 설치는 에어갭입니다',
  };
  function api(check: unknown) {
    const fn = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (u.startsWith('/api/profile/action')) {
        if (body.action === 'mcp_url_check') return new Response(JSON.stringify(check), { status: 200 });
        if (body.action === 'mcp_catalog') return new Response(JSON.stringify({ entries: [], hidden: { oauth: 0, install: 0, unknown: 0 } }), { status: 200 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (u.startsWith('/api/requests')) return new Response(JSON.stringify({ waiting: [] }), { status: 200 });
      if (u.split('?')[0] === '/api/me')
        return new Response(JSON.stringify({ auth_enabled: false, admin: true, user: null }), { status: 200 });
      return new Response(JSON.stringify({ error: u }), { status: 404 });
    });
    vi.stubGlobal('fetch', fn);
    return fn;
  }
  const actions = (fn: ReturnType<typeof api>) =>
    calls(fn as never, '/api/profile/action').map(
      (c) => JSON.parse(String((c[1] as RequestInit).body)) as Record<string, unknown>
    );
  const fill = async (url: string) => {
    await userEvent.click(await screen.findByRole('button', { name: '원격 주소' }));   // 대화 상자는 카탈로그로 열린다(2026-10-23)
    await userEvent.type(await screen.findByRole('textbox', { name: '이름' }), 'jira');
    await userEvent.type(screen.getByRole('textbox', { name: /주소/ }), url);
  };

  it('주소를 멈추면 칸 아래에 판정을 보인다', async () => {
    api({ verdict: 'internal', reason: 'internal', message: '사내 주소 · 추가 뒤 확인' });
    mountScreen(<AddServerDialog open name="ma" secure onClose={vi.fn()} onAdded={vi.fn()} />, '/profiles');
    await fill('http://mcp.corp.svc/mcp');
    expect(await screen.findByText('사내 주소 · 추가 뒤 확인')).toBeInTheDocument();
  });

  it('쓸 수 없는 주소: 주인은 추가할 수 없고 「관리자에게 요청」을 본다', async () => {
    api(BLOCKED);
    mountScreen(<AddServerDialog open name="ma" secure onClose={vi.fn()} onAdded={vi.fn()} />, '/profiles');
    await fill('https://mcp.example.com/mcp');
    expect(await screen.findByText(BLOCKED.message)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '추가' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '관리자에게 요청' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '그래도 추가' })).not.toBeInTheDocument();
  });

  it('쓸 수 없는 주소: 관리자는 확인을 받고 force 로 추가한다', async () => {
    const fn = api(BLOCKED);
    const onAdded = vi.fn();
    mountScreen(<AddServerDialog open admin name="ma" secure onClose={vi.fn()} onAdded={onAdded} />, '/profiles');
    await fill('https://mcp.example.com/mcp');
    await userEvent.click(await screen.findByRole('button', { name: '그래도 추가' }));
    expect(await screen.findByRole('dialog', { name: /./ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '확인' }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith('jira', { oauth: false }));
    expect(actions(fn).find((b) => b.action === 'mcp_add')).toMatchObject({ server: 'jira', force: true });
  });

  it('미리 등록한 클라이언트를 넣으면 oauth_client 로 보낸다', async () => {
    const fn = api({ verdict: 'external', reason: 'external', message: '외부 주소 · 추가 뒤 확인' });
    const onAdded = vi.fn();
    mountScreen(<AddServerDialog open name="ma" secure onClose={vi.fn()} onAdded={onAdded} />, '/profiles');
    await fill('https://mcp.example.com/mcp');
    await userEvent.click(screen.getByRole('button', { name: 'OAuth', pressed: false }));
    await userEvent.click(screen.getByRole('button', { name: '미리 등록한 클라이언트' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'client_id' }), 'aas-console');
    await userEvent.type(screen.getByLabelText('client_secret', { selector: 'input' }), 'shh');
    await userEvent.click(screen.getByRole('button', { name: '추가' }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith('jira', { oauth: true }));
    expect(actions(fn).find((b) => b.action === 'mcp_add')?.oauth_client).toEqual({
      client_id: 'aas-console',
      client_secret: 'shh',
    });
  });
});

describe('헤더 서버를 OAuth 로 바꾸기와 좁은 화면(V15·V12)', () => {
  it('헤더 인증 원격 서버는 더보기에 「OAuth 로 바꾸기」가 있고, 확인 뒤 mcp_to_oauth 를 보낸다', async () => {
    const fn = fakeApi();
    mountScreen(<ToolsPane d={D({ mcp: [row(null, { name: 'docs', auth: 'header' })] })} />, '/profiles');
    await userEvent.click(await screen.findByRole('button', { name: 'docs 더보기' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'OAuth 로 바꾸기' }));
    const box = await screen.findByRole('dialog');
    expect(box).toHaveTextContent('MCP_DOCS_API_KEY');
    await userEvent.click(screen.getByRole('button', { name: '확인' }));
    await waitFor(() =>
      expect(
        calls(fn, '/api/profile/action').map((c) => JSON.parse(String((c[1] as RequestInit).body)))
      ).toContainEqual({ name: 'ma', action: 'mcp_to_oauth', target: 'docs' })
    );
    expect(await screen.findByText('docs 서버를 OAuth 로 바꿨습니다. 로그인하세요')).toBeInTheDocument();
  });

  it('OAuth·stdio 서버의 넓은 화면에는 더보기가 없다(넣을 항목이 없을 때)', async () => {
    fakeApi();
    mountScreen(<ToolsPane d={D({ mcp: [row({ state: 'connected', tools: 1 })] })} />, '/profiles');
    expect(await screen.findByRole('button', { name: 'jira 삭제' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'jira 더보기' })).not.toBeInTheDocument();
  });

  it('좁은 화면에서는 주 단추가 설명 아래로 가고, 삭제는 더보기 안에 있다', async () => {
    fakeApi();
    const mm = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    try {
      mountScreen(<ToolsPane d={D({ mcp: [row({ state: 'login_required' })] })} />, '/profiles');
      const login = await screen.findByRole('button', { name: 'jira 로그인' });
      expect(login.className).toMatch(/fullWidth/);
      expect(screen.queryByRole('button', { name: 'jira 삭제' })).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'jira 더보기' }));
      expect(screen.getByRole('menuitem', { name: 'jira 삭제' })).toBeInTheDocument();
    } finally {
      window.matchMedia = mm;
    }
  });
});

describe('판정과 다르게 추가한 서버(V16)', () => {
  it('행 설명 끝에 「판정과 다르게 추가함」을 붙인다', async () => {
    fakeApi();
    mountScreen(
      <ToolsPane
        d={D({ mcp: [row(null, { name: 'ext', auth: 'none', forced: true, target: 'https://mcp.example.com/…' })] })}
      />,
      '/profiles'
    );
    expect(await screen.findByText('https://mcp.example.com/… · 판정과 다르게 추가함')).toBeInTheDocument();
  });
});

// 로그인 성공 뒤 서버는 게이트웨이가 붙기를 60초까지 「연결하는 중」으로 준다(CONNECT_GRACE). 상세 조회가 다시 읽지 않으면
// 연결된 뒤에도 행이 「연결하는 중」에 머문다(OKE 2026-10-17 C4 에서 1분이 지나도 바뀌지 않았다)
describe('detailRefetchMs', () => {
  const detail = (mcp: McpItem[], notes: string[] = []) => ({ notes, mcp }) as unknown as ProfileDetailData;
  it('「연결하는 중」 행이 있으면 짧은 간격으로 다시 읽는다', () => {
    expect(detailRefetchMs(detail([row({ state: 'logging_in', mine: false, connecting: true })]))).toBe(MCP_SETTLE_POLL_MS);
  });
  it('다른 사람이 로그인 중인 행도 끝날 때까지 다시 읽는다', () => {
    expect(detailRefetchMs(detail([row({ state: 'logging_in', mine: false })]))).toBe(MCP_SETTLE_POLL_MS);
  });
  it('내가 시작한 로그인 중은 로그인 창의 상태 묻기에 맡긴다', () => {
    expect(detailRefetchMs(detail([row({ state: 'logging_in', mine: true })]))).toBe(false);
  });
  it('작업공간이 다시 뜨는 중이면 5초마다 — 띠(useMe)와 같은 간격(스펙 2026-10-23-008)', () => {
    expect(detailRefetchMs({ ...detail([], ['soul']), restarting: true } as ProfileDetailData)).toBe(5000);
    expect(detailRefetchMs({ ...detail([], ['soul']), restarting: true } as ProfileDetailData, true)).toBe(5000);
  });
  it('읽지 못한 부분이 있으면 예전처럼 15초마다', () => {
    expect(detailRefetchMs(detail([row({ state: 'connected', tools: 1 })], ['mcp']))).toBe(15000);
  });
  it('웹소켓 토픽으로 로그인 상태를 받는 동안은 다시 읽지 않는다(14-22)', () => {
    expect(detailRefetchMs(detail([row({ state: 'logging_in', mine: false, connecting: true })]), true)).toBe(false);
    expect(detailRefetchMs(detail([row({ state: 'connected', tools: 1 })], ['mcp']), true)).toBe(15000);   // 읽지 못한 부분은 그대로
  });
  it('끝난 상태만 있으면 다시 읽지 않는다', () => {
    expect(detailRefetchMs(detail([row({ state: 'connected', tools: 1 }), row({ state: 'login_required' }, { name: 'b' })]))).toBe(false);
    expect(detailRefetchMs(undefined)).toBe(false);
  });
});

// 서버가 웹소켓 토픽 pod:<id>:mcp:<프로파일> 로 보낸 로그인 상태를 상세의 행에 덮어쓴다(14-22)
describe('mergeMcpLogin', () => {
  const detail = (mcp: McpItem[]) => ({ notes: [], mcp }) as unknown as ProfileDetailData;
  it('같은 이름의 행만 바꾸고 나머지는 그대로 둔다', () => {
    const before = detail([row({ state: 'logging_in', mine: false, connecting: true }), row(null, { name: 'docs', auth: 'header' })]);
    const after = mergeMcpLogin(before, { servers: { jira: { state: 'connected', tools: 1 }, gone: { state: 'login_required' } } });
    expect(after?.mcp?.[0].login_state).toEqual({ state: 'connected', tools: 1 });
    expect(after?.mcp?.[1]).toBe(before.mcp?.[1]);
    expect(after?.mcp).toHaveLength(2);
  });
  it('바뀐 것이 없으면 같은 객체를 돌려준다(다시 그리지 않게)', () => {
    const before = detail([row({ state: 'connected', tools: 1 })]);
    expect(mergeMcpLogin(before, { servers: { jira: { state: 'connected', tools: 1 } } })).toBe(before);
    expect(mergeMcpLogin(undefined, { servers: {} })).toBeUndefined();
  });
});
