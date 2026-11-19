/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 스킬 화면 「값 넣기」 창(스펙 2026-11-18-004): 여는 곳·넣을 곳 표시·저장 순서·거절 이유별 문구·결과 모름
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import { ME_ADMIN, ME_USER, mountScreen, postedTo, stubApi } from '@/test/mountScreen';

import { Skills } from '../Skills';
import { saveKeys, SkillEnvDialog } from './SkillEnvDialog';

const base = { n_mcp: 0, n_rest: 0, n_scripts: 0, n_cron: 0, origin: 'local', enabled: true, uses: 0, modes: ['rest'] };
const GIF = {
  ...base,
  id: 'ma:profiles/ma/skills/gif',
  name: 'gif',
  profile: 'ma',
  readiness: 'setup',
  missing_env: ['GIF_KEY', 'GIF_SECRET'],
};
const PIC = {
  ...base,
  id: 'ma:profiles/ma/skills/pic',
  name: 'pic',
  profile: 'ma',
  readiness: 'setup',
  missing_env: ['GIF_KEY'],
};
const ROOT = {
  ...base,
  id: 'default:skills/root',
  name: 'root',
  profile: 'default',
  readiness: 'setup',
  missing_env: ['ROOT_KEY'],
};
const LIST = {
  totals: { skills: 3, with_cron: 0, with_mcp: 0, with_rest: 3 },
  primary: 'ma',
  profiles: ['ma'], // 숨긴 루트: default 가 빠져 있다
  agents: ['default', 'ma'].map((profile) => ({
    profile,
    skills: 1,
    enabled: 1,
    setup: 1,
    unused: 0,
    shared: 0,
    cron: 0,
    runs: 0,
    last_run: '',
    last_used: '',
  })),
  skills: [GIF, PIC, ROOT],
};
const ONE_GIF = {
  name: 'gif',
  path: 'profiles/ma/skills/gif',
  profile: 'ma',
  files: 1,
  required_env: [
    { name: 'GIF_KEY', prompt: 'GIF API 키', help: 'https://developers.example.com/keys' },
    { name: 'GIF_SECRET', prompt: '비밀', help: '관리 화면 https://x.example.com 에서 만드세요' },
    { name: 'gif_region', optional: true },
  ],
};
const OWNER = {
  ...ME_USER,
  user: { email: 'kim@x.com', name: 'kim' },
  owner: true,
  secure: true,
  pod: { id: 'pod-kim', owner: 'kim@x.com', name: '김 에이전트', owner_name: '김영주' },
  pods: [],
};

afterEach(() => vi.unstubAllGlobals());

function mount(at: string, over: Record<string, unknown> = {}) {
  const fn = stubApi({
    '/api/me': OWNER,
    '/api/skills': LIST,
    '/api/skill?': ONE_GIF,
    '/api/profile/action': { ok: true, was_set: 'false' },
    ...over,
  });
  mountScreen(<Skills />, at);
  return fn;
}
const reply = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status });

/** env_set 요청을 붙잡아 두었다가 release 로 답한다. stubApi 는 함수가 돌려준 Promise 를 기다리지 않아 「보내는 중」을 만들 수 없다 */
function holdAction() {
  const held: { target: unknown; resolve: (r: Response) => void }[] = [];
  const inner = globalThis.fetch;
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    if (!String(url).startsWith('/api/profile/action')) return inner(url, init);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return new Promise<Response>((resolve) => held.push({ target: body.target, resolve }));
  });
  return {
    targets: () => held.map((h) => h.target),
    release: (i: number) => held[i].resolve(reply(200, { ok: true, was_set: 'false' })),
  };
}

describe('스킬 「값 넣기」 창', () => {
  it('오른쪽 개요 줄에서 열면 넣을 곳(작업공간·프로파일)을 채워 보이고, 앞뒤 줄바꿈을 지워 키마다 expect_pod 와 함께 보낸다', async () => {
    const user = userEvent.setup();
    const fn = mount('/skills?profile=ma');
    const box = await screen.findByTestId('agent-overview');
    await user.click(await within(box).findByRole('button', { name: 'gif 스킬 값 넣기' }));
    const dlg = await screen.findByTestId('skill-env-dialog');
    expect(within(dlg).getByText('gif 스킬에 필요한 값')).toBeInTheDocument();
    expect(within(dlg).getByTestId('skill-env-workspace')).toHaveTextContent('김 에이전트');
    expect(within(dlg).getByText('ma')).toBeInTheDocument();
    const key = await within(dlg).findByLabelText('GIF_KEY');
    await waitFor(() => expect(key).toHaveFocus()); // 첫 칸에 포커스
    expect(key).toHaveAttribute('type', 'password');
    await user.type(key, 'tok-1');
    await user.type(within(dlg).getByLabelText('GIF_SECRET'), 'sec-2 ');
    await user.click(within(dlg).getByRole('button', { name: '저장' }));
    await waitFor(() => expect(postedTo(fn, '/api/profile/action')).toHaveLength(2));
    expect(postedTo(fn, '/api/profile/action')).toEqual([
      { name: 'ma', action: 'env_set', target: 'GIF_KEY', value: 'tok-1', expect_pod: 'pod-kim' },
      { name: 'ma', action: 'env_set', target: 'GIF_SECRET', value: 'sec-2', expect_pod: 'pod-kim' },
    ]);
    // 창은 스스로 닫히지 않고 주 단추가 「완료」가 된다
    expect(await within(dlg).findByRole('button', { name: '완료' })).toBeInTheDocument();
    expect(within(dlg).getAllByText('저장됨')).toHaveLength(2);
    expect(within(dlg).getByLabelText('GIF_KEY')).toHaveValue('');
  });

  it('「필요한 것」 키 줄에서 열면 그 키 칸에 포커스, 같은 키를 쓰는 다른 스킬을 알린다. 소문자 이름은 칸 대신 이유를 보인다', async () => {
    const user = userEvent.setup();
    mount('/skills?profile=ma&skill=ma%3Aprofiles%2Fma%2Fskills%2Fgif&pane=needs');
    const panel = await screen.findByTestId('skill-panel');
    await user.click(await within(panel).findByRole('button', { name: 'GIF_SECRET 값 넣기' }));
    const dlg = await screen.findByTestId('skill-env-dialog');
    await waitFor(() => expect(within(dlg).getByLabelText('GIF_SECRET')).toHaveFocus());
    expect(within(dlg).getByText('이 키를 넣으면 pic 스킬의 같은 항목도 채워집니다')).toBeInTheDocument();
    expect(within(dlg).getByText(/지금 AAS 에서 넣을 방법이 없습니다/)).toBeInTheDocument();
    expect(within(dlg).queryByLabelText('gif_region')).toBeNull();
    // help: 주소만 있으면 링크(호스트), 문장이면 글자 그대로
    expect(within(dlg).getByRole('link', { name: /developers\.example\.com/ })).toHaveAttribute(
      'rel',
      'noopener noreferrer'
    );
    expect(within(dlg).queryByRole('link', { name: /x\.example\.com/ })).toBeNull();
    expect(within(dlg).getByText(/관리 화면 https:\/\/x\.example\.com 에서 만드세요/)).toBeInTheDocument();
  });

  it('주인이 넣을 수 없는 이름(provider_key)은 관리자에게 알리라는 문구와 맥락 줄을 보이고, 다른 칸은 저장한다', async () => {
    const user = userEvent.setup();
    mount('/skills?profile=ma', {
      '/api/profile/action': (_u: string, b: Record<string, unknown>) =>
        b.target === 'GIF_KEY' ? reply(403, { error: '거절', reason: 'provider_key' }) : { ok: true, was_set: 'true' },
    });
    await user.click(await screen.findByRole('button', { name: 'gif 스킬 값 넣기' }));
    const dlg = await screen.findByTestId('skill-env-dialog');
    await user.type(await within(dlg).findByLabelText('GIF_KEY'), 'a');
    await user.type(within(dlg).getByLabelText('GIF_SECRET'), 'b');
    await user.click(within(dlg).getByRole('button', { name: '저장' }));
    expect(await within(dlg).findByText(/관리자만 넣을 수 있습니다/)).toBeInTheDocument();
    expect(within(dlg).getByText(/김 에이전트 · ma · GIF_KEY ·/)).toBeInTheDocument();
    expect(within(dlg).getByText('저장됨 — 이전 값을 바꿈')).toBeInTheDocument();
    expect(within(dlg).getByRole('button', { name: '저장' })).toBeInTheDocument(); // 다 끝나지 않아 「완료」가 아니다
  });

  it('다른 탭에서 작업공간이 바뀌면(409 agent_changed) 남은 키를 보내지 않고 알린다', async () => {
    const user = userEvent.setup();
    const fn = mount('/skills?profile=ma', {
      '/api/profile/action': reply(409, { error: '바뀜', reason: 'agent_changed' }),
    });
    await user.click(await screen.findByRole('button', { name: 'gif 스킬 값 넣기' }));
    const dlg = await screen.findByTestId('skill-env-dialog');
    await user.type(await within(dlg).findByLabelText('GIF_KEY'), 'a');
    await user.type(within(dlg).getByLabelText('GIF_SECRET'), 'b');
    await user.click(within(dlg).getByRole('button', { name: '저장' }));
    expect(await within(dlg).findByText(/다른 탭에서 AI 에이전트 작업공간이 바뀌었습니다/)).toBeInTheDocument();
    expect(postedTo(fn, '/api/profile/action')).toHaveLength(1);
    expect(within(dlg).getByRole('button', { name: '저장' })).toBeDisabled();
  });

  it('주인·관리자가 아니면 단추 없이 지금 링크, 숨긴 루트(default)는 단추가 없다', async () => {
    mount('/skills?profile=ma&skill=ma%3Aprofiles%2Fma%2Fskills%2Fgif&pane=needs', {
      '/api/me': { ...OWNER, owner: false },
    });
    const panel = await screen.findByTestId('skill-panel');
    expect((await within(panel).findAllByText('비밀값 탭에서 넣기')).length).toBeGreaterThan(0);
    expect(within(panel).queryByRole('button', { name: /값 넣기$/ })).toBeNull();
  });

  it('숨긴 루트의 스킬에는 단추를 두지 않는다', async () => {
    mount('/skills?profile=default');
    const box = await screen.findByTestId('agent-overview');
    expect(await within(box).findByText('root')).toBeInTheDocument();
    expect(within(box).queryByRole('button', { name: 'root 스킬 값 넣기' })).toBeNull();
  });

  it('암호화되지 않은 연결이면 단추를 끈다', async () => {
    mount('/skills?profile=ma', { '/api/me': { ...OWNER, secure: false } });
    const box = await screen.findByTestId('agent-overview');
    expect(await within(box).findByRole('button', { name: 'gif 스킬 값 넣기' })).toBeDisabled();
  });
  // ── §5 의 나머지 갈래 ──
  const openGif = async (user: ReturnType<typeof userEvent.setup>, over: Record<string, unknown> = {}) => {
    const fn = mount('/skills?profile=ma', over);
    await user.click(await screen.findByRole('button', { name: 'gif 스킬 값 넣기' }));
    return { fn, dlg: await screen.findByTestId('skill-env-dialog') };
  };
  const sent = (fn: ReturnType<typeof stubApi>) => postedTo(fn, '/api/profile/action').map((b) => b.target);

  it('설명을 못 읽으면 missing_env 이름만으로 칸을 만들고 한 줄로 알린다. 하나만 적으면 그 키만 보낸다', async () => {
    const user = userEvent.setup();
    const { fn, dlg } = await openGif(user, { '/api/skill?': reply(500, { error: 'x' }) });
    expect(await within(dlg).findByText('설명을 불러오지 못했습니다')).toBeInTheDocument();
    await user.type(within(dlg).getByLabelText('GIF_SECRET'), 's');
    await user.click(within(dlg).getByRole('button', { name: '저장' }));
    await waitFor(() => expect(sent(fn)).toEqual(['GIF_SECRET']));
  });

  it('A 를 저장하고 B 를 다음에 저장하면 그때 「완료」가 되고 완료 알림은 한 번. 「이전 값」 알림은 was_set=true 일 때만', async () => {
    const user = userEvent.setup();
    const { dlg } = await openGif(user, {
      '/api/profile/action': (_u: string, b: Record<string, unknown>) => ({
        ok: true,
        was_set: b.target === 'GIF_KEY' ? 'unknown' : 'true',
      }),
    });
    await user.type(await within(dlg).findByLabelText('GIF_KEY'), 'a');
    await user.click(within(dlg).getByRole('button', { name: '저장' }));
    expect(await within(dlg).findByText('저장됨')).toBeInTheDocument();
    expect(within(dlg).getByRole('button', { name: '저장' })).toBeInTheDocument();
    expect(screen.queryByText(/이전 값 .개를 바꿨습니다/)).toBeNull(); // unknown 은 알리지 않는다
    await user.type(within(dlg).getByLabelText('GIF_SECRET'), 'b');
    await user.click(within(dlg).getByRole('button', { name: '저장' }));
    expect(await within(dlg).findByRole('button', { name: '완료' })).toBeInTheDocument();
    expect(within(dlg).queryByRole('button', { name: '닫기' })).toBeNull();
    expect(await screen.findByText('이전 값 1개를 바꿨습니다')).toBeInTheDocument();
    expect(await screen.findAllByText(/gif 스킬에 필요한 값을 넣었습니다/)).toHaveLength(1);
  });

  it('「결과 모름」 뒤 다시 보내 was_set=true 가 와도 「이전 값을 바꿈」으로 알리지 않는다', async () => {
    const user = userEvent.setup();
    let n = 0;
    const { dlg } = await openGif(user, {
      '/api/profile/action': () => (n++ === 0 ? reply(502, { error: 'bad gateway' }) : { ok: true, was_set: 'true' }),
    });
    await user.type(await within(dlg).findByLabelText('GIF_KEY'), 'a');
    await user.click(within(dlg).getByRole('button', { name: '저장' }));
    expect(await within(dlg).findByText(/저장됐는지 확인하지 못했습니다/)).toBeInTheDocument();
    await user.click(within(dlg).getByRole('button', { name: '저장' })); // 값이 남아 있어 다시 보낸다
    expect(await within(dlg).findByText('저장됨')).toBeInTheDocument();
    expect(within(dlg).queryByText('저장됨 — 이전 값을 바꿈')).toBeNull();
  });

  it('보내는 동안 「저장」·「닫기」가 꺼지고 Esc 로 닫히지 않는다. 닫았다 다시 열면 칸이 비어 있다', async () => {
    const user = userEvent.setup();
    mount('/skills?profile=ma');
    const hold = holdAction();
    await user.click(await screen.findByRole('button', { name: 'gif 스킬 값 넣기' }));
    const dlg = await screen.findByTestId('skill-env-dialog');
    await user.type(await within(dlg).findByLabelText('GIF_KEY'), 'a');
    await user.click(within(dlg).getByRole('button', { name: '저장' }));
    await waitFor(() => expect(hold.targets()).toEqual(['GIF_KEY']));
    expect(within(dlg).getByRole('button', { name: '저장' })).toBeDisabled();
    expect(within(dlg).getByRole('button', { name: '닫기' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.getByTestId('skill-env-dialog')).toBeInTheDocument();
    hold.release(0);
    expect(await within(dlg).findByText('저장됨')).toBeInTheDocument();
    await user.type(within(dlg).getByLabelText('GIF_SECRET'), 'zz');
    await user.click(within(dlg).getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(screen.queryByTestId('skill-env-dialog')).toBeNull());
    await user.click(screen.getByRole('button', { name: 'gif 스킬 값 넣기' }));
    expect(await screen.findByLabelText('GIF_SECRET')).toHaveValue('');
  });

  it('필요한 값이 모두 들어 있으면 칸 없이 안내하고 목록을 다시 읽는다', async () => {
    const user = userEvent.setup();
    const { fn, dlg } = await openGif(user, {
      '/api/skill?': { ...ONE_GIF, required_env: ONE_GIF.required_env.map((e) => ({ ...e, set: true })) },
    });
    expect(await within(dlg).findByText('필요한 값이 모두 들어 있습니다')).toBeInTheDocument();
    expect(within(dlg).queryByLabelText('GIF_KEY')).toBeNull();
    await waitFor(() =>
      expect(fn.mock.calls.filter((c) => String(c[0]).startsWith('/api/skills')).length).toBeGreaterThan(1)
    );
    expect(fn.mock.calls.some((c) => String(c[0]).startsWith('/api/profiles'))).toBe(false); // 스킬 화면은 프로파일 목록을 읽지 않는다
  });

  it('거절 이유별 안내: channel_var 는 채널 링크, list_unreadable 는 다시 시도, 이유 없음은 서버 문구', async () => {
    const user = userEvent.setup();
    const { dlg } = await openGif(user, {
      '/api/profile/action': (_u: string, b: Record<string, unknown>) =>
        b.target === 'GIF_KEY'
          ? reply(400, { error: '채널 값입니다', reason: 'channel_var' })
          : reply(409, { error: '목록', reason: 'list_unreadable' }),
    });
    await user.type(await within(dlg).findByLabelText('GIF_KEY'), 'a');
    await user.type(within(dlg).getByLabelText('GIF_SECRET'), 'b');
    await user.click(within(dlg).getByRole('button', { name: '저장' }));
    expect(await within(dlg).findByText('채널 값입니다')).toBeInTheDocument();
    expect(within(dlg).getByText('채널 탭에서 바꾸세요')).toBeInTheDocument();
    expect(within(dlg).getByText('잠시 뒤 다시 저장하세요')).toBeInTheDocument();
  });

  it('작업공간 표시: 남의 작업공간이면 안내 줄, 작업공간이 없으면 「—」', async () => {
    const user = userEvent.setup();
    const admin = { ...OWNER, admin: true, owner: false, user: { email: 'admin@x.com', name: 'admin' } };
    const { dlg } = await openGif(user, { '/api/me': admin });
    expect(within(dlg).getByTestId('skill-env-workspace')).toHaveTextContent('김영주');
    expect(within(dlg).getByText('다른 사람의 AI 에이전트 작업공간입니다')).toBeInTheDocument();
  });

  it('작업공간이 없으면 이름표가 「—」', async () => {
    const user = userEvent.setup();
    const { dlg } = await openGif(user, { '/api/me': { ...OWNER, pod: null } });
    expect(within(dlg).getByTestId('skill-env-workspace')).toHaveTextContent('—');
  });

  it('보내는 도중 화면이 사라지면 남은 키는 보내지 않는다', async () => {
    const user = userEvent.setup();
    stubApi({ '/api/me': OWNER, '/api/skills': LIST, '/api/skill?': ONE_GIF });
    const view = mountScreen(<Skills />, '/skills?profile=ma');
    const hold = holdAction();
    await user.click(await screen.findByRole('button', { name: 'gif 스킬 값 넣기' }));
    const dlg = await screen.findByTestId('skill-env-dialog');
    await user.type(await within(dlg).findByLabelText('GIF_KEY'), 'a');
    await user.type(within(dlg).getByLabelText('GIF_SECRET'), 'b');
    await user.click(within(dlg).getByRole('button', { name: '저장' }));
    await waitFor(() => expect(hold.targets()).toEqual(['GIF_KEY']));
    view.unmount();
    hold.release(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(hold.targets()).toEqual(['GIF_KEY']);
  });
});

describe('saveKeys — 키마다 차례로, 결과 분류', () => {
  const items = [
    { key: 'A_KEY', value: '1' },
    { key: 'B_KEY', value: '2' },
    { key: 'C_KEY', value: '3' },
  ];
  it('5xx·네트워크 오류는 「결과 모름」, 4xx 는 거절, 나머지는 계속 보낸다', async () => {
    const post = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('서버', 502))
      .mockRejectedValueOnce(new ApiError('거절', 400, 'platform_var'))
      .mockResolvedValueOnce({ was_set: 'true', mcp_enabled: ['m1'] });
    const out = await saveKeys(items, { post, isAlive: () => true });
    expect(out.map((r) => r.kind)).toEqual(['unknown', 'refused', 'saved']);
    expect(out[1].reason).toBe('platform_var');
    expect(out[2]).toMatchObject({ wasSet: 'true', mcp: ['m1'] });
  });
  it('작업공간이 바뀌면 멈추고, 창이 사라지면 남은 키를 보내지 않는다', async () => {
    const post = vi.fn().mockRejectedValue(new ApiError('바뀜', 409, 'agent_changed'));
    expect((await saveKeys(items, { post, isAlive: () => true })).map((r) => r.kind)).toEqual([
      'pod',
      'skipped',
      'skipped',
    ]);
    expect(post).toHaveBeenCalledTimes(1);
    let alive = true;
    const post2 = vi.fn(async () => {
      alive = false;
      return {};
    });
    expect((await saveKeys(items, { post: post2, isAlive: () => alive })).map((r) => r.kind)).toEqual([
      'saved',
      'skipped',
      'skipped',
    ]);
  });
  it('제한 시간이 지나면 요청을 끊고 「결과 모름」으로 둔다', async () => {
    const post = vi.fn(
      (_k: string, _v: string, signal: AbortSignal) =>
        new Promise<never>((_, rej) =>
          signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))
        )
    );
    const out = await saveKeys(items.slice(0, 1), { post, isAlive: () => true, timeoutMs: 10 });
    expect(out[0].kind).toBe('unknown');
  });
});

// ── AAS 가 주는 LLM 접속값(스펙 2026-11-19-002 §4-3) ──
// sa-crm 꼴: LLM 셋이 선언의 앞쪽에 있고, 다른 필수 하나·선택 하나
const LLM3 = ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'];
const managed = (name: string, src: 'aas' | 'profile' = 'aas', extra: Record<string, unknown> = {}) => ({
  name,
  prompt: '',
  set: true,
  managed: 'aas',
  managed_source: src,
  ...extra,
});
const CRM_ROW = {
  id: 'ma:profiles/ma/skills/sa-crm',
  name: 'sa-crm',
  profile: 'ma',
  readiness: 'setup',
  missing_env: ['CRM_TOKEN'],
};
const crmOne = (llm = LLM3.map((n) => managed(n)), more: Record<string, unknown> = {}) => ({
  name: 'sa-crm',
  path: 'profiles/ma/skills/sa-crm',
  profile: 'ma',
  files: 1,
  required_env: [
    ...llm,
    { name: 'CRM_TOKEN', prompt: 'CRM 토큰', set: false },
    { name: 'LLM_INTENT_MODEL', optional: true, set: false },
  ],
  ...more,
});

function mountDialog(one: Record<string, unknown>, opts: { focusKey?: string; me?: Record<string, unknown> } = {}) {
  const fn = stubApi({
    '/api/me': opts.me ?? OWNER,
    '/api/skill?': one,
    '/api/profile/action': { ok: true, was_set: 'false' },
  });
  mountScreen(<SkillEnvDialog row={CRM_ROW} rows={[CRM_ROW]} focusKey={opts.focusKey} onClose={() => {}} />, '/skills');
  return fn;
}
const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('값 넣기 창 — AAS 가 주는 LLM 접속값', () => {
  it('LLM 셋은 입력 칸 아래 info 한 줄로 묶이고 칸·꼬리표·「관리자만」이 없다. 순서는 빠진 필수 → 선택 → 관리 묶음', async () => {
    mountDialog(crmOne());
    const dlg = await screen.findByTestId('skill-env-dialog');
    const group = await within(dlg).findByText(
      'LLM_BASE_URL·LLM_API_KEY·LLM_MODEL — AAS 의 LLM 접속값을 씁니다. 넣지 않아도 됩니다'
    );
    for (const n of LLM3) expect(within(dlg).queryByLabelText(n)).toBeNull();
    expect(within(dlg).queryByText(/관리자만/)).toBeNull();
    expect(within(dlg).getAllByText('필수')).toHaveLength(1); // CRM_TOKEN 만
    const crm = within(dlg).getByLabelText('CRM_TOKEN');
    const intent = within(dlg).getByLabelText('LLM_INTENT_MODEL');
    expect(before(crm, intent)).toBe(true);
    expect(before(intent, group)).toBe(true);
    expect(group.closest('[data-tone]')).toHaveAttribute('data-tone', 'info'); // 초록 금지(DESIGN.md)
    expect(within(dlg).queryByText('프로파일 값을 씀(AAS 값 대신)')).toBeNull();
  });

  it('저장 대상은 나머지만이다', async () => {
    const user = userEvent.setup();
    const fn = mountDialog(crmOne());
    const dlg = await screen.findByTestId('skill-env-dialog');
    await user.type(await within(dlg).findByLabelText('CRM_TOKEN'), 'tok');
    await user.type(within(dlg).getByLabelText('LLM_INTENT_MODEL'), 'm1');
    await user.click(within(dlg).getByRole('button', { name: '저장' }));
    await waitFor(() => expect(postedTo(fn, '/api/profile/action')).toHaveLength(2));
    expect(postedTo(fn, '/api/profile/action').map((b) => b.target)).toEqual(['CRM_TOKEN', 'LLM_INTENT_MODEL']);
  });

  it('focusKey 가 관리 이름이어도(예전 링크) 첫 입력 칸에 포커스가 간다', async () => {
    mountDialog(crmOne(), { focusKey: 'LLM_API_KEY' });
    const dlg = await screen.findByTestId('skill-env-dialog');
    await waitFor(() => expect(within(dlg).getByLabelText('CRM_TOKEN')).toHaveFocus());
  });

  it('profile 인 이름은 「프로파일 값을 씀(AAS 값 대신)」(good)·「지우면 AAS 값을 따릅니다」와 비밀값 화면 링크', async () => {
    mountDialog(crmOne([managed('LLM_BASE_URL'), managed('LLM_API_KEY', 'profile'), managed('LLM_MODEL')]));
    const dlg = await screen.findByTestId('skill-env-dialog');
    const line = (await within(dlg).findByText('프로파일 값을 씀(AAS 값 대신)')).closest(
      '[data-managed-profile]'
    ) as HTMLElement;
    expect(line).toHaveAttribute('data-managed-profile', 'LLM_API_KEY');
    expect(line.querySelector('.MuiChip-colorSuccess')).not.toBeNull();
    expect(within(line).getByText('지우면 AAS 값을 따릅니다')).toBeInTheDocument();
    expect(within(line).getByRole('link', { name: '비밀값 탭에서 넣기' })).toHaveAttribute(
      'href',
      '/profiles?name=ma&pane=env&key=LLM_API_KEY'
    );
    // 묶음 한 줄에는 AAS 값을 쓰는 이름만
    expect(
      within(dlg).getByText('LLM_BASE_URL·LLM_MODEL — AAS 의 LLM 접속값을 씁니다. 넣지 않아도 됩니다')
    ).toBeInTheDocument();
  });

  it('출처가 갈리면(managed_mixed) 관리 묶음 위에 warn 한 줄', async () => {
    mountDialog(
      crmOne([managed('LLM_BASE_URL'), managed('LLM_API_KEY', 'profile'), managed('LLM_MODEL')], {
        managed_mixed: true,
      })
    );
    const dlg = await screen.findByTestId('skill-env-dialog');
    const warn = await within(dlg).findByText(
      'LLM 접속값의 출처가 다릅니다(LLM_API_KEY 는 프로파일 값, LLM_BASE_URL·LLM_MODEL 는 AAS 값). 다른 제공자의 값이면 실패합니다'
    );
    expect(warn.closest('[data-tone]')).toHaveAttribute('data-tone', 'warn');
    expect(before(warn, within(dlg).getByText(/AAS 의 LLM 접속값을 씁니다/))).toBe(true);
  });

  it('주인이 지울 수 없는 이름(owner_locked)은 링크 대신 「관리자가 지우면 AAS 값을 씁니다」, 관리자에게는 링크', async () => {
    const one = crmOne([
      managed('LLM_BASE_URL', 'profile', { owner_locked: true }),
      managed('LLM_API_KEY'),
      managed('LLM_MODEL'),
    ]);
    mountDialog(one);
    const dlg = await screen.findByTestId('skill-env-dialog');
    const line = (await within(dlg).findByText('프로파일 값을 씀(AAS 값 대신)')).closest(
      '[data-managed-profile]'
    ) as HTMLElement;
    expect(within(line).getByText('관리자가 지우면 AAS 값을 씁니다')).toBeInTheDocument();
    expect(within(line).queryByRole('link')).toBeNull();
  });

  it('관리자는 owner_locked 줄에도 링크를 받는다', async () => {
    const one = crmOne([
      managed('LLM_BASE_URL', 'profile', { owner_locked: true }),
      managed('LLM_API_KEY'),
      managed('LLM_MODEL'),
    ]);
    mountDialog(one, { me: { ...ME_ADMIN, secure: true } });
    const dlg = await screen.findByTestId('skill-env-dialog');
    const line = (await within(dlg).findByText('프로파일 값을 씀(AAS 값 대신)')).closest(
      '[data-managed-profile]'
    ) as HTMLElement;
    expect(within(line).getByRole('link', { name: '비밀값 탭에서 넣기' })).toBeInTheDocument();
    expect(within(line).queryByText('관리자가 지우면 AAS 값을 씁니다')).toBeNull();
  });

  it('관리 이름만 선언한 스킬: 「필요한 값이 모두 들어 있습니다」 위에 같은 한 줄', async () => {
    mountDialog({ name: 'sa-crm', path: 'p', profile: 'ma', files: 1, required_env: LLM3.map((n) => managed(n)) });
    const dlg = await screen.findByTestId('skill-env-dialog');
    const all = await within(dlg).findByText('필요한 값이 모두 들어 있습니다');
    expect(before(within(dlg).getByText(/AAS 의 LLM 접속값을 씁니다/), all)).toBe(true);
    expect(within(dlg).queryByRole('textbox')).toBeNull();
  });
});
