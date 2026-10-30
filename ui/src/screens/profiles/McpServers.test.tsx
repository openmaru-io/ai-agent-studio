/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountScreen } from '@/test/mountScreen';

import { AddServerDialog } from './McpServers';
import { ToolsPane } from './Panes';
import { useProfileAct } from './shared';
import type { ProfileDetailData } from './types';

afterEach(() => vi.unstubAllGlobals());

type Reply = [number, unknown];
/** 주소별 응답표 대신 요청 하나마다 [상태, 본문] 을 정한다(거절 코드·field 시험용) */
function fakeApi(onAction: (body: Record<string, unknown>) => Reply, extra: Record<string, unknown> = {}) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (u.startsWith('/api/profile/action')) {
      const [status, reply] = onAction(body);
      let out = reply;
      // 대화 상자가 카탈로그로 열리며 곧바로 읽는다. 카탈로그를 정하지 않은 시험에는 빈 카탈로그를 준다
      if (body.action === 'mcp_catalog' && status === 200 && !(out as { entries?: unknown }).entries) out = { entries: [], hidden: { oauth: 0, install: 0, unknown: 0 } };
      return new Response(JSON.stringify(out), { status });
    }
    const key = Object.keys(extra).find((k) => u.startsWith(k));
    if (key) return new Response(JSON.stringify(extra[key]), { status: 200 });
    if (u.split('?')[0] === '/api/me') return new Response(JSON.stringify({ auth_enabled: false, admin: true, user: null }), { status: 200 });
    return new Response(JSON.stringify({ error: '없는 주소 ' + u }), { status: 404 });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}
const posted = (fn: ReturnType<typeof fakeApi>) =>
  fn.mock.calls.filter((c) => String(c[0]).startsWith('/api/profile/action')).map((c) => JSON.parse(String((c[1] as RequestInit).body)) as Record<string, unknown>).filter((b) => b.action !== 'mcp_catalog');

const D = (over: Partial<ProfileDetailData> = {}) =>
  ({ profile: { name: 'ma' }, can_edit: true, owner: false, secure: true, mcp: [], ...over }) as unknown as ProfileDetailData;

function dialog(secure = true, onAdded = vi.fn(), onClose = vi.fn(), onChanged = vi.fn()) {
  mountScreen(<AddServerDialog open name="ma" secure={secure} onClose={onClose} onAdded={onAdded} onChanged={onChanged} />, '/profiles');
  return { onAdded, onClose, onChanged };
}

// 대화 상자는 카탈로그로 열린다(2026-10-23). 원격 주소·프로그램 실행 시험은 원격 주소로 옮긴 뒤 시작한다
async function urlDialog(secure = true, onAdded = vi.fn(), onClose = vi.fn()) {
  const r = dialog(secure, onAdded, onClose);
  await userEvent.click(await screen.findByRole('button', { name: '원격 주소' }));
  return r;
}

const submitBtn = () => screen.getByRole('button', { name: '추가' });

describe('MCP 서버 추가 대화 상자(스펙 2026-10-15-025 §11)', () => {
  it('카탈로그가 맨 앞이고 처음 열면 선택돼 있다(2026-10-23)', async () => {
    fakeApi(() => [200, { entries: [], hidden: { oauth: 0, install: 0, unknown: 0 } }]);
    dialog();
    const kinds = within(await screen.findByRole('group', { name: '추가 방식' })).getAllByRole('button');
    expect(kinds.map((b) => b.textContent)).toEqual(['카탈로그', '원격 주소', '프로그램 실행']);
    expect(kinds[0]).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByLabelText(/이름/)).not.toBeInTheDocument();
  });

  it('원격 주소로 옮기면 이름과 주소가 올바를 때 추가할 수 있다. 토큰이 없으면 본문에 토큰이 없다', async () => {
    const fn = fakeApi(() => [200, { ok: true }]);
    const { onAdded } = await urlDialog();
    expect(submitBtn()).toBeDisabled();
    await userEvent.type(await screen.findByLabelText(/이름/), 'docs');
    await userEvent.type(screen.getByLabelText(/주소/), 'https://example.com/mcp');
    expect(submitBtn()).toBeEnabled();
    await userEvent.click(submitBtn());
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith('docs', { oauth: false }));
    expect(posted(fn)).toEqual([{ name: 'ma', action: 'mcp_add', kind: 'url', server: 'docs', url: 'https://example.com/mcp', auth: 'none' }]);
  });

  it('이름 형식이 틀리면 칸 아래에 바로 알리고 추가할 수 없다', async () => {
    await urlDialog();
    await userEvent.type(await screen.findByLabelText(/이름/), 'a.b');
    expect(screen.getByText('영문·숫자·-·_ 로 적고 영문이나 숫자로 시작합니다')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/주소/), 'https://x.io/mcp');
    expect(submitBtn()).toBeDisabled();
  });

  it('토큰은 점으로 가려 받고 보기 단추로만 잠깐 보이며 본문에 실려 간다', async () => {
    const fn = fakeApi(() => [200, { ok: true }]);
    await urlDialog();
    await userEvent.type(await screen.findByLabelText(/이름/), 'docs');
    await userEvent.type(screen.getByLabelText(/주소/), 'https://example.com/mcp');
    await userEvent.click(screen.getByRole('button', { name: '토큰', pressed: false }));            // 인증 = 토큰
    const token = screen.getByLabelText(/^토큰/, { selector: 'input' });
    expect(token).toHaveAttribute('type', 'password');
    expect(token).toHaveAttribute('autocomplete', 'off');
    expect(screen.getByText('저장하면 다시 볼 수 없고 설정에는 ${이름} 참조만 남습니다.')).toBeInTheDocument();
    await userEvent.type(token, 'tok-12345');
    const eye = screen.getByRole('button', { name: '토큰 보기' });
    expect(eye).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(eye);
    expect(token).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: '토큰 가리기' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(submitBtn());
    // 주소 칸은 입력이 300ms 멈추면 mcp_url_check 를 먼저 보낸다 — 부하로 입력 사이가 벌어지면 첫 요청이 그것이라 추가 요청을 찾아 본다(2026-10-22)
    await waitFor(() =>
      expect(posted(fn).find((b) => b.action === 'mcp_add')).toMatchObject({ auth: 'header', bearer_token: 'tok-12345' })
    );
  });

  it('암호화되지 않은 연결에서는 토큰·비밀값이 있으면 추가할 수 없다', async () => {
    await urlDialog(false);
    await userEvent.type(await screen.findByLabelText(/이름/), 'docs');
    await userEvent.type(screen.getByLabelText(/주소/), 'https://example.com/mcp');
    expect(submitBtn()).toBeEnabled();                                                               // 비밀이 없으면 된다
    await userEvent.click(screen.getByRole('button', { name: '토큰', pressed: false }));
    await userEvent.type(screen.getByLabelText(/^토큰/, { selector: 'input' }), 'x');
    expect(submitBtn()).toBeDisabled();
    expect(screen.getByText(/암호화되지 않은 주소/)).toBeInTheDocument();
  });

  it('방식을 바꾸면 이름은 남기고 나머지 칸은 비운다. 프로그램 실행은 인자·환경변수를 보낸다', async () => {
    const fn = fakeApi(() => [200, { ok: true }]);
    await urlDialog();
    await userEvent.type(await screen.findByLabelText(/이름/), 'mem');
    await userEvent.type(screen.getByLabelText(/주소/), 'https://example.com/mcp');
    await userEvent.click(screen.getByRole('button', { name: '프로그램 실행' }));
    expect(screen.getByLabelText(/이름/)).toHaveValue('mem');
    await userEvent.click(screen.getByRole('button', { name: '원격 주소' }));
    expect(screen.getByLabelText(/주소/)).toHaveValue('');
    await userEvent.click(screen.getByRole('button', { name: '프로그램 실행' }));
    const cmd = screen.getByLabelText(/실행 파일/);
    expect(cmd).toHaveValue('uvx');
    await userEvent.type(screen.getByLabelText('인자'), 'mcp-server-time{Enter}--local-timezone=Asia/Seoul');
    await userEvent.click(screen.getByRole('button', { name: '변수 추가' }));
    await userEvent.type(screen.getByLabelText('이름', { selector: 'input[autocomplete="off"]:not([required])' }), 'api_token');
    expect(submitBtn()).toBeDisabled();                                                              // 이름만 있고 값이 없다
    await userEvent.type(screen.getByLabelText('값', { selector: 'input' }), 'secret-1');
    expect(screen.getByLabelText('값', { selector: 'input' })).toHaveAttribute('type', 'password');
    await userEvent.click(submitBtn());
    await waitFor(() =>
      expect(posted(fn)[0]).toEqual({
        name: 'ma', action: 'mcp_add', kind: 'stdio', server: 'mem', command: 'uvx',
        args: ['mcp-server-time', '--local-timezone=Asia/Seoul'], env: { API_TOKEN: 'secret-1' },
      })
    );
  });

  it('칸이 정해진 거절은 그 칸 아래에 보이고 그 칸으로 커서가 간다', async () => {
    fakeApi(() => [409, { error: '이미 같은 이름으로 쓰이는 서버가 있습니다(docs)', reason: 'name_exists', field: 'name' }]);
    await urlDialog();
    const name = await screen.findByLabelText(/이름/);
    await userEvent.type(name, 'docs');
    await userEvent.type(screen.getByLabelText(/주소/), 'https://example.com/mcp');
    await userEvent.click(submitBtn());
    expect(await screen.findByText('이미 같은 이름으로 쓰이는 서버가 있습니다(docs)')).toBeInTheDocument();
    await waitFor(() => expect(name).toHaveFocus());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();                                     // 폼 위 경고는 칸을 특정할 수 없을 때만
    expect(name).toHaveValue('docs');                                                                // 값은 그대로
  });

  it('칸을 특정할 수 없는 거절(상한 등)은 폼 위 경고 한 곳에 보인다', async () => {
    fakeApi(() => [409, { error: '이 에이전트에 켜진 프로그램 실행 MCP 서버가 10개입니다.', reason: 'mcp_limit' }]);
    await urlDialog();
    await userEvent.type(await screen.findByLabelText(/이름/), 'docs');
    await userEvent.type(screen.getByLabelText(/주소/), 'https://example.com/mcp');
    await userEvent.click(submitBtn());
    expect(await screen.findByText('이 에이전트에 켜진 프로그램 실행 MCP 서버가 10개입니다.')).toBeInTheDocument();
  });

  it('입력이 있으면 닫을 때 묻고, 거절하면 열린 채로 값이 남는다', async () => {
    const { onClose } = await urlDialog();
    await userEvent.type(await screen.findByLabelText(/이름/), 'docs');
    await userEvent.click(screen.getByRole('button', { name: '취소' }));
    expect(await screen.findByText('입력한 내용이 사라집니다. 닫을까요?')).toBeInTheDocument();
    const confirmDlg = screen.getByRole('dialog', { name: '확인' });
    await userEvent.click(within(confirmDlg).getByRole('button', { name: '취소' }));
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '확인' })).not.toBeInTheDocument());   // 확인 창이 완전히 닫힌 뒤
    expect(screen.getByLabelText(/이름/)).toHaveValue('docs');
    await userEvent.click(screen.getByRole('button', { name: '취소' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: '확인' })).getByRole('button', { name: '확인' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('입력이 없으면 확인 없이 바로 닫힌다', async () => {
    const { onClose } = dialog();
    await userEvent.click(await screen.findByRole('button', { name: '취소' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

const CATALOG = {
  entries: [
    { name: 'ctx', description: '문서 검색', transport: 'http', auth_type: 'none', installed: false, enabled: false, required_env: [] },
    { name: 'keyed', description: '키가 필요', transport: 'stdio', auth_type: 'api_key', installed: false, enabled: false, required_env: [{ name: 'KEY_TOKEN', prompt: '키를 넣으세요', required: true }] },
    { name: 'done', description: '이미 있음', transport: 'http', auth_type: 'none', installed: true, enabled: true, required_env: [] },
  ],
  hidden: { oauth: 54, install: 1, unknown: 0 },
};

describe('카탈로그', () => {
  it('설치할 수 있는 항목만 행으로 보이고 숨긴 개수를 알린다. 설치된 항목은 단추 대신 태그', async () => {
    fakeApi(() => [200, CATALOG]);
    dialog();
    await userEvent.click(await screen.findByRole('button', { name: '카탈로그' }));
    expect(await screen.findByText('문서 검색')).toBeInTheDocument();
    expect(screen.getByText('프로그램 실행 방식의 OAuth 서버(공급자 계정 로그인) 54개와 설치가 필요한 항목 1개는 이 화면에서 지원하지 않아 숨겼습니다.')).toBeInTheDocument();
    expect(screen.getByText('설치됨')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '추가' })).not.toBeInTheDocument();                  // 카탈로그에는 추가 단추가 없다
  });

  it('검색어로 이름·설명을 대소문자 없이 거르고, 맞는 항목이 없으면 알린다(2026-10-23)', async () => {
    fakeApi(() => [200, CATALOG]);
    dialog();
    const box = await screen.findByRole('searchbox', { name: '카탈로그 검색' });
    expect(box).toHaveFocus();                                                                       // 카탈로그로 열리면 바로 입력한다
    await userEvent.type(box, 'CTX');
    expect(screen.getByText('문서 검색')).toBeInTheDocument();
    expect(screen.queryByText('키가 필요')).not.toBeInTheDocument();
    await userEvent.clear(box);
    await userEvent.type(box, '필요');                                                               // 설명으로도 찾는다
    expect(screen.getByText('키가 필요')).toBeInTheDocument();
    expect(screen.queryByText('문서 검색')).not.toBeInTheDocument();
    await userEvent.clear(box);
    await userEvent.type(box, 'zzz');
    expect(screen.getByText('「zzz」에 맞는 항목이 없습니다')).toBeInTheDocument();
    await userEvent.clear(box);
    expect(screen.getByText('이미 있음')).toBeInTheDocument();
  });

  it('원격 주소 OAuth 항목은 OAuth 태그와 로그인 안내를 보이고, 이 환경에서 쓸 수 없으면 설치할 수 없다(스펙 2026-10-16-010 Q5)', async () => {
    const entries = [
      { name: 'linear', description: '이슈', transport: 'http', installed: false, required_env: [], auth_type: 'oauth', url: 'https://mcp.linear.example/mcp', network: { verdict: 'external', message: '외부 주소' } },
      { name: 'sentry', description: '오류', transport: 'http', installed: false, required_env: [], auth_type: 'oauth', url: 'https://mcp.sentry.example/mcp', network: { verdict: 'blocked', message: '이 환경에서 쓸 수 없음: 에어갭' } },
    ];
    fakeApi(() => [200, { entries, hidden: { oauth: 0, install: 0, unknown: 0 } }]);
    dialog();
    await userEvent.click(await screen.findByRole('button', { name: '카탈로그' }));
    expect(await screen.findByText('이슈 · 설치한 뒤 서버 줄에서 로그인합니다')).toBeInTheDocument();
    expect(screen.getAllByText('OAuth')).toHaveLength(2); // 두 항목의 OAuth 태그
    expect(screen.getByRole('button', { name: 'linear 설치' })).toBeEnabled();
    expect(screen.getByText('이 환경에서 쓸 수 없음: 에어갭')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'sentry 설치' })).toBeDisabled();
  });

  it('필수 환경변수가 비어 있으면 설치할 수 없고, 채우면 값을 가려 보낸다', async () => {
    const fn = fakeApi((b) => (b.action === 'mcp_catalog' ? [200, CATALOG] : [200, { ok: true }]));
    const { onAdded } = dialog();
    await userEvent.click(await screen.findByRole('button', { name: '카탈로그' }));
    const install = await screen.findByRole('button', { name: 'keyed 설치' });
    expect(install).toBeDisabled();
    const key = screen.getByLabelText(/KEY_TOKEN/, { selector: 'input' });
    expect(key).toHaveAttribute('type', 'password');
    await userEvent.type(key, 'k-1');
    expect(install).toBeEnabled();
    await userEvent.click(install);
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith('keyed', { oauth: false }));
    expect(posted(fn)).toContainEqual({ name: 'ma', action: 'mcp_install', server: 'keyed', env: { KEY_TOKEN: 'k-1' } });
  });

  const DOCMOST = {
    name: 'docmost', description: '위키', transport: 'http', auth_type: 'api_key', installed: false, enabled: false, builtin: true, write: false,
    required_env: [
      { name: 'DOCMOST_MCP_URL', prompt: '주소', required: true, secret: false, value: 'https://wiki.example.com/mcp' },
      { name: 'MCP_DOCMOST_API_KEY', prompt: '키', required: true, secret: true },
    ],
  };

  it('Docmost 항목: 주소 칸은 가리지 않고 미리 채우며, 쓰기 도구를 고르면 write 를 함께 보낸다(스펙 2026-10-23-002 12-6)', async () => {
    const fn = fakeApi((b) => (b.action === 'mcp_catalog' ? [200, { entries: [DOCMOST], hidden: { oauth: 0, install: 0, unknown: 0 } }] : [200, { ok: true }]));
    const { onAdded } = dialog();
    await userEvent.click(await screen.findByRole('button', { name: '카탈로그' }));
    const url = await screen.findByLabelText(/DOCMOST_MCP_URL/, { selector: 'input' });
    expect(url).toHaveAttribute('type', 'text');
    expect(url).toHaveValue('https://wiki.example.com/mcp');
    expect(screen.getByLabelText(/MCP_DOCMOST_API_KEY/, { selector: 'input' })).toHaveAttribute('type', 'password');
    await userEvent.type(screen.getByLabelText(/MCP_DOCMOST_API_KEY/, { selector: 'input' }), 'k-1');
    await userEvent.click(screen.getByRole('checkbox', { name: /쓰기 도구도 등록/ }));
    await userEvent.click(screen.getByRole('button', { name: 'docmost 설치' }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith('docmost', { oauth: false }));
    expect(posted(fn)).toContainEqual({ name: 'ma', action: 'mcp_install', server: 'docmost', env: { DOCMOST_MCP_URL: 'https://wiki.example.com/mcp', MCP_DOCMOST_API_KEY: 'k-1' }, write: true });
  });

  it('설치한 Docmost 항목은 쓰기 도구 스위치로 켜고 끈다', async () => {
    const fn = fakeApi((b) => (b.action === 'mcp_catalog' ? [200, { entries: [{ ...DOCMOST, installed: true, enabled: true }], hidden: { oauth: 0, install: 0, unknown: 0 } }] : [200, { ok: true }]));
    const { onChanged } = dialog();
    await userEvent.click(await screen.findByRole('button', { name: '카탈로그' }));
    const sw = await screen.findByRole('switch', { name: '쓰기 도구' });
    expect(sw).not.toBeChecked();
    expect(screen.queryByText(/지금 적용/)).not.toBeInTheDocument();
    await userEvent.click(sw);
    await waitFor(() => expect(posted(fn)).toContainEqual({ name: 'ma', action: 'mcp_docmost_write', write: true }));
    expect(await screen.findByText(/「지금 적용\(게이트웨이 다시 시작\)」 뒤 새 대화부터/)).toBeInTheDocument();   // 도구 범위는 다시 시작해야 반영된다(12-7)
    expect(onChanged).toHaveBeenCalled();
  });

  const OUTLINE = {
    ...DOCMOST,
    name: 'outline',
    required_env: [
      { name: 'OUTLINE_MCP_URL', prompt: '주소', required: true, secret: false, value: '' },
      { name: 'MCP_OUTLINE_API_KEY', prompt: '키', required: true, secret: true },
    ],
  };

  it('Outline 항목: 쓰기 도구 안내는 Outline 문구(삭제 도구 없음)이고, 도구 묶음 끄기·스킬 실패를 설치 뒤 알린다(스펙 2026-10-23-004)', async () => {
    const fn = fakeApi((b) =>
      b.action === 'mcp_catalog'
        ? [200, { entries: [DOCMOST, OUTLINE], hidden: { oauth: 0, install: 0, unknown: 0 } }]
        : [200, { ok: true, browser_off: true, connections_off: false, skill: 'failed' }]
    );
    const { onAdded } = dialog();
    await userEvent.click(await screen.findByRole('button', { name: '카탈로그' }));
    await userEvent.type(await screen.findByLabelText(/OUTLINE_MCP_URL/, { selector: 'input' }), 'https://wiki.example.com/mcp');
    await userEvent.type(screen.getByLabelText(/MCP_OUTLINE_API_KEY/, { selector: 'input' }), 'k-2');
    const boxes = screen.getAllByRole('checkbox', { name: /쓰기 도구도 등록/ });
    expect(boxes.map((x) => x.closest('label')?.textContent)).toEqual([expect.stringMatching(/페이지/), expect.stringMatching(/문서·컬렉션/)]);
    await userEvent.click(boxes[1]);
    expect(screen.getByText(/삭제 도구는 등록하지 않습니다/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'outline 설치' }));
    await waitFor(() =>
      expect(onAdded).toHaveBeenCalledWith('outline', {
        oauth: false,
        notes: ['이 프로파일의 외부 연결 도구를 끄지 못했습니다. 도구 탭에서 끄세요.', '사용 규칙 스킬을 설치하지 못했습니다. 스킬 허브에서 설치하세요.'],
      })
    );
    expect(posted(fn)).toContainEqual({ name: 'ma', action: 'mcp_install', server: 'outline', env: { OUTLINE_MCP_URL: 'https://wiki.example.com/mcp', MCP_OUTLINE_API_KEY: 'k-2' }, write: true });
  });

  it('설치한 Outline 항목의 쓰기 스위치는 mcp_outline_write 를 보내고 「지금 적용」 안내를 부른다', async () => {
    const fn = fakeApi((b) => (b.action === 'mcp_catalog' ? [200, { entries: [{ ...OUTLINE, installed: true, enabled: true }], hidden: { oauth: 0, install: 0, unknown: 0 } }] : [200, { ok: true }]));
    const onChanged = vi.fn();
    mountScreen(<AddServerDialog open name="ma" secure onClose={vi.fn()} onAdded={vi.fn()} onChanged={onChanged} />, '/profiles');
    await userEvent.click(await screen.findByRole('button', { name: '카탈로그' }));
    await userEvent.click(await screen.findByRole('switch', { name: '쓰기 도구' }));
    await waitFor(() => expect(posted(fn)).toContainEqual({ name: 'ma', action: 'mcp_outline_write', write: true }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('목록이 비면 원격 주소로 추가하라고 알리고, 불러오기에 실패하면 다시 불러오기가 있다', async () => {
    fakeApi(() => [200, { entries: [], hidden: { oauth: 3, install: 0, unknown: 0 } }]);
    dialog();
    await userEvent.click(await screen.findByRole('button', { name: '카탈로그' }));
    expect(await screen.findByText('이 환경에서 바로 설치할 수 있는 항목이 없습니다. 원격 주소로 직접 추가하세요.')).toBeInTheDocument();
  });

  it('카탈로그를 읽지 못하면 폼 위가 아니라 목록 자리에 경고와 다시 불러오기를 보인다', async () => {
    fakeApi(() => [502, { error: 'down' }]);
    dialog();
    await userEvent.click(await screen.findByRole('button', { name: '카탈로그' }));
    expect(await screen.findByText('카탈로그를 불러오지 못했습니다')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '다시 불러오기' })).toBeInTheDocument();
  });
});

describe('MCP · 도구 묶음 탭', () => {
  const ROW = { name: 'mem', transport: 'stdio', target: 'uvx mcp-server-time', env_names: [], enabled: true };

  it('탭 바로 밑 줄 오른쪽 끝에 「새 MCP 서버」 단추 하나만 있다(2026-10-17-019)', async () => {
    fakeApi(() => [200, { ok: true }]);
    mountScreen(<ToolsPane d={D({ mcp: [ROW] })} />, '/profiles');
    const btn = await screen.findByRole('button', { name: '새 MCP 서버' });
    expect(btn).toBeEnabled();
    expect(btn.parentElement).toHaveStyle({ marginLeft: 'auto' }); // 검색 줄 오른쪽 끝(2026-10-23-007 에서 검색칸이 왼쪽에 들어옴)
    expect(screen.getAllByRole('button', { name: /새 MCP 서버|서버 추가/ })).toHaveLength(1);
  });

  it('권한이 없으면 단추가 숨지 않고 이유와 함께 비활성이고 행에 삭제 단추가 없다', async () => {
    fakeApi(() => [200, { ok: true }]);
    mountScreen(<ToolsPane d={D({ can_edit: false, owner: false, mcp: [ROW] })} />, '/profiles');
    const btn = await screen.findByRole('button', { name: '새 MCP 서버' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-description', 'MCP 서버를 추가할 권한이 없습니다');
    expect(screen.queryByRole('button', { name: 'mem 삭제' })).not.toBeInTheDocument();
  });

  it('서버가 없으면 안내가 보이고, 「새 MCP 서버」를 누르면 대화 상자가 열린다', async () => {
    fakeApi(() => [200, { ok: true }]);
    mountScreen(<ToolsPane d={D({ mcp: [] })} />, '/profiles');
    expect(await screen.findByText('설정된 MCP 서버가 없습니다.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '새 MCP 서버' }));
    expect(await screen.findByRole('dialog', { name: 'MCP 서버 추가' })).toBeInTheDocument();
  });

  it('삭제는 위험 확인 뒤에 요청하고, 지운 비밀값 개수를 알린다', async () => {
    const fn = fakeApi(() => [200, { ok: true, env_cleared: 2, env_left: 0 }]);
    mountScreen(<ToolsPane d={D({ mcp: [ROW] })} />, '/profiles');
    await userEvent.click(await screen.findByRole('button', { name: 'mem 삭제' }));
    const dlg = await screen.findByRole('dialog', { name: '확인' });
    expect(within(dlg).getByText(/이 서버를 쓰는 스킬·예약 작업이 실패할 수 있습니다/)).toBeInTheDocument();
    expect(posted(fn)).toEqual([]);                                                                  // 확인 전에는 보내지 않는다
    await userEvent.click(within(dlg).getByRole('button', { name: '확인' }));
    await waitFor(() => expect(posted(fn)).toEqual([{ name: 'ma', action: 'mcp_remove', target: 'mem' }]));
    expect(await screen.findByText('mem 서버를 지웠습니다. 비밀값 2개도 지웠습니다')).toBeInTheDocument();
  });

  it('Outline 서버를 지우면 꺼 둔 브라우저·외부 연결 도구가 그대로라고 알린다(스펙 2026-10-23-004 R6)', async () => {
    fakeApi(() => [200, { ok: true, env_cleared: 1, env_left: 0, toolsets_off_notice: true }]);
    mountScreen(<ToolsPane d={D({ mcp: [{ ...ROW, name: 'outline' }] })} />, '/profiles');
    await userEvent.click(await screen.findByRole('button', { name: 'outline 삭제' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: '확인' })).getByRole('button', { name: '확인' }));
    expect(await screen.findByText(/꺼진 채로 있습니다. 필요하면 도구 탭에서 켜세요/)).toBeInTheDocument();
  });

  it('삭제한 뒤에는 게이트웨이를 다시 시작해야 쓴다고 알리고, 확인을 거쳐 mcp_apply 만 보낸다', async () => {
    const fn = fakeApi(() => [200, { ok: true }]);
    mountScreen(<ToolsPane d={D({ mcp: [ROW] })} />, '/profiles');
    expect(screen.queryByText(/MCP 서버 설정을 바꿨습니다/)).toBeNull();           // 바꾸기 전에는 안 보인다
    await userEvent.click(await screen.findByRole('button', { name: 'mem 삭제' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: '확인' })).getByRole('button', { name: '확인' }));
    await userEvent.click(await screen.findByRole('button', { name: /지금 적용/ }));
    const dlg = await screen.findByRole('dialog', { name: '확인' });
    expect(within(dlg).getByText(/게이트웨이를 다시 시작합니다/)).toBeInTheDocument();
    expect(posted(fn)).toEqual([{ name: 'ma', action: 'mcp_remove', target: 'mem' }]);               // 확인 전에는 재시작을 보내지 않는다
    await userEvent.click(within(dlg).getByRole('button', { name: '확인' }));
    await waitFor(() => expect(posted(fn).at(-1)).toEqual({ name: 'ma', action: 'mcp_apply' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /지금 적용/ })).toBeNull());       // 요청한 뒤에는 안내가 사라진다
  });

  it('연결 시험이 실패하면 이유와 설정 탭 링크가 나오고, 시간 초과는 다른 문구다', async () => {
    let n = 0;
    fakeApi(() => (++n === 1 ? [200, { ok: true, test: { ok: false, tools: 0, error: 'Connection closed' } }] : [200, { ok: true, test: { ok: false, tools: 0, timeout: true, error: '' } }]));
    mountScreen(<ToolsPane d={D({ mcp: [ROW] })} />, '/profiles');
    await userEvent.click(await screen.findByRole('button', { name: '연결 시험' }));
    expect(await screen.findByText('mem: 연결 실패: Connection closed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '설정(config) 탭에서 고치기' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '연결 시험' }));
    expect(await screen.findByText(/시험이 시간 안에 끝나지 않았습니다/)).toBeInTheDocument();
  });
});

// ── OMAI-1249: 도구 화면의 MCP 탭 링크(server=) 강조와 화면 캐시 무효화 ──
const MCP_ITEMS = [
  { name: 'alpha', transport: 'stdio', enabled: true, target: 'npx -y pkg', env_names: [], auth: '' },
  { name: 'beta', transport: 'http', enabled: true, target: 'https://b.example.com/…', env_names: [], auth: '' },
];

describe('프로파일 MCP 탭: 도구 화면 링크의 server 파라미터(V17)', () => {
  it('server 가 있으면 그 서버 행으로 스크롤하고 강조한다', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    fakeApi(() => [200, { ok: true }]);
    mountScreen(<ToolsPane d={D({ mcp: MCP_ITEMS as never })} />, '/profiles?name=ma&pane=tools&server=beta');
    const focused = await waitFor(() => {
      const el = document.querySelector('[data-item-row][data-focused]') as HTMLElement | null;
      if (!el) throw new Error('no focused row');
      return el;
    });
    expect(within(focused).getByText('beta')).toBeInTheDocument();
    expect(document.querySelectorAll('[data-item-row][data-focused]')).toHaveLength(1);
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it('없는 서버 이름이거나 server 가 없으면 아무것도 강조하지 않는다(오류도 없다)', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    fakeApi(() => [200, { ok: true }]);
    const { unmount } = mountScreen(<ToolsPane d={D({ mcp: MCP_ITEMS as never })} />, '/profiles?name=ma&pane=tools&server=nope');
    await screen.findByText('alpha');
    expect(document.querySelector('[data-focused]')).toBeNull();
    unmount();
    mountScreen(<ToolsPane d={D({ mcp: MCP_ITEMS as never })} />, '/profiles?name=ma&pane=tools');
    await screen.findByText('alpha');
    expect(document.querySelector('[data-focused]')).toBeNull();
    expect(scroll).not.toHaveBeenCalled();
  });
});

describe('프로파일 동작 뒤 화면 캐시(V16)', () => {
  it('refresh 는 도구 화면의 조회(inventory tools)도 무효화한다', async () => {
    fakeApi(() => [200, { ok: true }]);
    function Probe() {
      const { refresh } = useProfileAct('ma');
      return <button onClick={() => void refresh()}>go</button>;
    }
    const view = mountScreen(<Probe />, '/profiles');
    const spy = vi.spyOn(view.qc, 'invalidateQueries');
    await userEvent.click(screen.getByRole('button', { name: 'go' }));
    await waitFor(() => expect(spy.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey)).toContainEqual(['inventory', 'tools']));
    expect(spy.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey)).toContainEqual(['profile', 'ma']);   // 기존 무효화는 그대로
  });
});
