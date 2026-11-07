/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HistoryBack, mountScreen, postedTo, rowByName, stubApi } from '@/test/mountScreen';

import { agentPreparing, Agents } from './Agents';

const AGENTS = [
  {
    name: 'hag-kim-1',
    owner: 'kim@x.com',
    display_name: '마케팅',
    phase: 'Ready',
    message: '',
    ready: true,
    suspended: false,
    created: '2026-10-10T09:00:00+09:00',
  },
  {
    name: 'hag-kim-2',
    owner: 'kim@x.com',
    display_name: '',
    phase: 'Failed',
    message: 'pods is forbidden: exceeded quota',
    ready: false,
    suspended: false,
    created: '2026-10-10T10:00:00+09:00',
  },
];
const BASE = { enabled: true, limit: 3, count: 2, default_limit: 3, can_create: true, admin: false, agents: AGENTS };

afterEach(() => vi.unstubAllGlobals());

function mount(data: object, extra: Record<string, unknown> = {}) {
  // 주소는 앞에서부터 맞춘다 — 더 긴 주소(/api/agents/profiles 등)가 /api/agents 보다 먼저 와야 한다
  const fn = stubApi({
    ...extra,
    '/api/agents/limit': { ok: true },
    '/api/agents/delete': { ok: true },
    '/api/agents/resume': { ok: true },
    '/api/agents': (_u: string, body: Record<string, unknown>) => (Object.keys(body).length ? { ok: true } : data),
    ...extra,
  });
  mountScreen(<Agents />, '/agents');
  return fn;
}

describe('Agents', () => {
  it('관리자에게 주인 칸은 사용자 목록의 사람 이름이고 이메일은 풍선말이다(2026-10-18)', async () => {
    mount({ ...BASE, admin: true, limits: {} }, { '/api/users': { users: [{ email: 'kim@x.com', name: '김철수' }] } });
    const chip = (await screen.findAllByText('김철수'))[0].closest('[data-user-chip]');
    expect(chip).toHaveAttribute('title', 'kim@x.com');
  });

  it('목록이 없는 응답(쿠버네티스가 아닐 때)에서도 다시 읽기 판단이 오류를 내지 않는다', async () => {
    // refetchInterval 이 data.agents.some 을 부르다 「Cannot read properties of undefined」 를 내던 것(OKE 에서 콘솔 오류로 발견)
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mount({ enabled: false });
    await waitFor(() => expect(screen.queryByText(/불러오는 중|읽는 중/)).not.toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 50));
    expect(err.mock.calls.flat().join(' ')).not.toMatch(/reading 'some'/);
    err.mockRestore();
  });

  it('내 에이전트 개수와 한도, 실패 이유를 보인다', async () => {
    mount(BASE);
    expect(await screen.findByText('마케팅')).toBeInTheDocument();
    expect(screen.getByText('2 / 3')).toBeInTheDocument();
    expect(screen.getByText('실패')).toBeInTheDocument();
    expect(screen.getByText('pods is forbidden: exceeded quota')).toBeInTheDocument();
  });

  it('오퍼레이터의 NotReady 단계는 「연결 끊김」과 이유로 보인다(스펙 agent-dashboard-self-kill-recovery §3-4)', async () => {
    const down = { ...AGENTS[0], name: 'hag-kim-3', display_name: '보고서', phase: 'NotReady', ready: false, message: '대시보드 9119 에 연결되지 않습니다' };
    mount({ ...BASE, count: 3, agents: [...AGENTS, down] });
    expect(await screen.findByText('연결 끊김')).toBeInTheDocument();
    expect(screen.getByText('대시보드 9119 에 연결되지 않습니다')).toBeInTheDocument();
    expect(screen.queryByText('NotReady')).not.toBeInTheDocument();
  });

  it('만들기는 이름을 보내고, 서버가 한도 초과(409)로 거절하면 이유를 보인다', async () => {
    const user = userEvent.setup();
    const sent: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        if (!init?.body) return Promise.resolve(new Response(JSON.stringify(BASE), { status: 200 }));
        sent.push(JSON.parse(String(init.body)));
        return Promise.resolve(
          new Response(JSON.stringify({ error: '만들 수 있는 Hermes 는 3개까지입니다' }), { status: 409 })
        );
      })
    );
    mountScreen(<Agents />, '/agents');
    await user.click((await screen.findAllByRole('button', { name: 'AI 에이전트 작업공간 만들기' }))[0]);
    const dlg = await screen.findByRole('dialog');
    await user.type(within(dlg).getByRole('textbox', { name: '이름' }), '새 에이전트');
    await user.click(within(dlg).getByRole('button', { name: '만들기' }));
    expect(await within(dlg).findByText(/3개까지입니다/)).toBeInTheDocument(); // 서버가 준 거절 이유
    expect(sent).toEqual([{ display_name: '새 에이전트' }]);
  });

  it('만들기가 성공하면 서랍을 닫고 목록을 다시 읽는다', async () => {
    const user = userEvent.setup();
    const fn = mount(BASE);
    await user.click((await screen.findAllByRole('button', { name: 'AI 에이전트 작업공간 만들기' }))[0]);
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '만들기' }));
    await waitFor(() => expect(postedTo(fn, '/api/agents')).toEqual([{ display_name: '' }]));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('만들기 칸에 서버가 준 추천 이름을 미리 넣고, 그대로 만들면 그 이름을 보낸다(2026-10-21-019)', async () => {
    const user = userEvent.setup();
    const fn = mount({ ...BASE, suggested_name: '김철수의 에이전트 2' });
    await user.click((await screen.findAllByRole('button', { name: 'AI 에이전트 작업공간 만들기' }))[0]);
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByRole('textbox', { name: '이름' })).toHaveValue('김철수의 에이전트 2');
    await user.click(within(dlg).getByRole('button', { name: '만들기' }));
    await waitFor(() => expect(postedTo(fn, '/api/agents')).toEqual([{ display_name: '김철수의 에이전트 2' }]));
  });

  it('한도에 도달하면 만들기 버튼이 꺼진다', async () => {
    mount({ ...BASE, count: 3, can_create: false });
    // 제목 옆 + 와 표 툴바의 글자 단추가 같이 꺼진다(2026-10-21-020)
    for (const b of await screen.findAllByRole('button', { name: 'AI 에이전트 작업공간 만들기' })) expect(b).toBeDisabled();
    expect(screen.getByText('한도에 도달함')).toBeInTheDocument();
  });

  // 서랍 「기본 정보」에 이름과 ID 를 둘 다 보인다. 예전에는 「이름」 행이 ID 였고 이름은 제목에만 있었다
  const kv = (dlg: HTMLElement) =>
    Object.fromEntries(
      Array.from(dlg.querySelectorAll('.aas-kv dt:not([data-kv-head] dt)'))
        .filter((dt) => !dt.closest('[data-kv-head]'))
        .map((dt) => [dt.textContent ?? '', dt.nextElementSibling?.textContent ?? ''])
    );

  // 스펙 2026-11-06-005 화면 설계 U1(D3·D4·D20): 메모리 초과 안내
  const OOM = { id: 'oom|hag-kim-1|2026-11-06T11:00:00Z', finished_at: '2026-11-06T11:00:00Z', limit_memory: '4Gi' };

  it('메모리 초과 안내가 있으면 상태 칸에 알약, 서랍에 세 줄 안내와 요청 단추(사용자)', async () => {
    const user = userEvent.setup();
    mount({ ...BASE, agents: [{ ...AGENTS[0], oom: OOM }, AGENTS[1]] }, { '/api/requests': { waiting: [] } });
    expect(await screen.findByText('메모리 초과로 재시작')).toBeInTheDocument();
    await user.click(await rowByName(/마케팅/));
    const dlg = await screen.findByRole('dialog', { name: '마케팅' });
    expect(within(dlg).getByText(/메모리 한도 4Gi를 넘어/)).toBeInTheDocument();
    expect(within(dlg).getByText('그때 진행 중이던 대화·작업은 중단되었습니다.')).toBeInTheDocument();
    expect(within(dlg).getByRole('button', { name: /작업공간의 메모리 늘리기를 관리자에게 요청/ })).toBeInTheDocument();
  });

  it('관리자에게는 요청 대신 크기 바꾸기, [닫기]는 받은편지함 확인으로 보낸다(D21)', async () => {
    const user = userEvent.setup();
    const fn = mount({ ...BASE, admin: true, limits: {}, agents: [{ ...AGENTS[0], oom: OOM }, AGENTS[1]] }, { '/api/office/inbox/answer': { ok: true } });
    await user.click(await rowByName(/마케팅/));
    const dlg = await screen.findByRole('dialog', { name: '마케팅' });
    expect(within(dlg).getByRole('button', { name: '크기 바꾸기' })).toBeInTheDocument();
    expect(within(dlg).queryByRole('button', { name: /메모리 늘리기를 관리자에게 요청/ })).toBeNull();
    await user.click(within(dlg).getByRole('button', { name: '메모리 초과 안내 닫기' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/inbox/answer')).toEqual([{ id: OOM.id, choice: 'ack' }]));
  });

  it('서랍의 기본 정보에 에이전트 이름과 ID 가 따로 있다', async () => {
    const user = userEvent.setup();
    mount({ ...BASE, admin: true });
    await user.click(await rowByName(/마케팅/));
    const pairs = kv(await screen.findByRole('dialog', { name: '마케팅' }));
    expect(pairs['이름']).toBe('마케팅');
    expect(pairs['ID']).toBe('hag-kim-1');
  });

  it('이름을 짓지 않은 에이전트는 이름 행에도 ID 를 보인다', async () => {
    const user = userEvent.setup();
    mount({ ...BASE, admin: true });
    await user.click(await rowByName(/hag-kim-2/));
    const pairs = kv(await screen.findByRole('dialog', { name: 'hag-kim-2' }));
    expect(pairs['이름']).toBe('hag-kim-2');
    expect(pairs['ID']).toBe('hag-kim-2');
  });

  it('관리자는 사람별 한도를 바꾸고 기본값으로 되돌린다', async () => {
    const user = userEvent.setup();
    const fn = mount({ ...BASE, admin: true, limits: { 'kim@x.com': 5 } });
    await user.click(await rowByName(/마케팅/));
    const dlg = await screen.findByRole('dialog', { name: '마케팅' });
    const box = within(dlg).getByRole('spinbutton', { name: '한도' });
    expect(box).toHaveValue(5);
    await user.clear(box);
    await user.type(box, '4');
    await user.click(within(dlg).getByRole('button', { name: '저장' }));
    expect(await screen.findByText('kim@x.com 의 AI 에이전트 작업공간 개수 한도를 4개로 바꿉니다.')).toBeInTheDocument(); // 확인을 거친다(OMAI-1135)
    expect(postedTo(fn, '/api/agents/limit')).toEqual([]);
    await user.click(screen.getByRole('button', { name: '확인' }));
    await waitFor(() => expect(postedTo(fn, '/api/agents/limit')).toEqual([{ email: 'kim@x.com', limit: 4 }]));
    await user.click(await within(dlg).findByRole('button', { name: /기본값\(3개\)으로/ })); // 확인 창이 닫힐 때까지 기다린다
    await user.click(await screen.findByRole('button', { name: '확인' }));
    await waitFor(() => expect(postedTo(fn, '/api/agents/limit')[1]).toEqual({ email: 'kim@x.com', limit: null }));
  });

  it('사용자에게는 한도 변경과 소유권 이전이 보이지 않는다', async () => {
    const user = userEvent.setup();
    mount(BASE);
    await user.click(await rowByName(/마케팅/));
    const dlg = await screen.findByRole('dialog', { name: '마케팅' });
    expect(within(dlg).queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(within(dlg).queryByRole('button', { name: '소유권 이전' })).not.toBeInTheDocument(); // 머리 단추도 관리자만
  });

  it('지우기는 이름을 그대로 다시 입력해야 켜지고, 그 이름을 함께 보낸다', async () => {
    const user = userEvent.setup();
    const fn = mount(BASE, { '/api/agents/delete': { ok: true, export: 'hag-kim-1-20261010.tar.gz' } });
    await user.click(await rowByName(/마케팅/));
    const drawer = await screen.findByRole('dialog', { name: '마케팅' });
    await user.click(within(drawer.querySelector('[data-drawer-head]') as HTMLElement).getByRole('button', { name: '지우기' }));
    const dlg = await screen.findByRole('dialog', { name: '지우기' });
    const del = within(dlg).getByRole('button', { name: '지우기' });
    expect(del).toBeDisabled();
    await user.type(within(dlg).getByRole('textbox', { name: 'AI 에이전트 작업공간 id 다시 입력' }), 'hag-kim-');
    expect(del).toBeDisabled(); // 일부만 맞아도 안 된다
    await user.type(within(dlg).getByRole('textbox', { name: 'AI 에이전트 작업공간 id 다시 입력' }), '1');
    expect(del).toBeEnabled();
    await user.click(del);
    await waitFor(() =>
      expect(postedTo(fn, '/api/agents/delete')).toEqual([{ name: 'hag-kim-1', confirm_name: 'hag-kim-1' }])
    );
  });

  it('주 프로파일(main)을 만드는 중인 에이전트는 상태 옆에 「main 준비 중」을 보인다(2026-10-19-001 디자인 D11)', async () => {
    mount({ ...BASE, agents: [{ ...AGENTS[0], primary_preparing: true }, { ...AGENTS[1], primary_preparing: true }] });
    expect(await screen.findAllByText('main 준비 중')).toHaveLength(1); // 파드가 아직 준비되지 않은(실패) 에이전트에는 붙이지 않는다
  });

  // 2026-10-19-001 R5·R3, 디자인 D6·D10: 내 에이전트인데 서랍에 「수정」이 없고 「소유권 이전」만 보였다(캡처 7)
  it('서랍의 「수정」(글자 단추)에서 이름과 채팅 기본 프로파일을 바꿔 저장한다', async () => {
    const user = userEvent.setup();
    const fn = mount(BASE, {
      '/api/agents/profiles': { profiles: ['main', 'ops'], primary: 'main', chat_default: 'main' },
      '/api/agents/update': { ok: true },
    });
    await user.click(await rowByName(/마케팅/));
    const drawer = await screen.findByRole('dialog', { name: '마케팅' });
    const edit = within(drawer.querySelector('[data-drawer-head]') as HTMLElement).getByRole('button', { name: '수정' });
    expect(edit).toHaveTextContent('수정'); // 아이콘만이 아니라 글자도 보인다
    await user.click(edit);
    const box = await screen.findByRole('dialog', { name: '수정' });
    const nameBox = within(box).getByRole('textbox', { name: '이름' });
    await user.clear(nameBox);
    expect(within(box).getByRole('button', { name: '저장' })).toBeDisabled(); // 빈 이름은 저장하지 못한다
    await user.type(nameBox, '마케팅 도우미');
    await user.selectOptions(await within(box).findByRole('combobox', { name: '채팅 기본 프로파일' }), 'ops');
    await user.click(within(box).getByRole('button', { name: '저장' }));
    await waitFor(() => expect(postedTo(fn, '/api/agents/update')).toEqual([{ name: 'hag-kim-1', display_name: '마케팅 도우미', chat_default: 'ops' }]));
  });

  it('고를 프로파일이 하나뿐이면 선택 칸 대신 글자로 알린다(디자인 D10 8A)', async () => {
    const user = userEvent.setup();
    mount(BASE, { '/api/agents/profiles': { profiles: ['main'], primary: 'main', chat_default: 'main' } });
    await user.click(await rowByName(/마케팅/));
    const drawer = await screen.findByRole('dialog', { name: '마케팅' });
    await user.click(within(drawer.querySelector('[data-drawer-head]') as HTMLElement).getByRole('button', { name: '수정' }));
    const box = await screen.findByRole('dialog', { name: '수정' });
    expect(await within(box).findByText('main · 다른 프로파일을 만들면 고를 수 있습니다')).toBeInTheDocument();
    expect(within(box).queryByRole('combobox')).toBeNull();
  });

  it('멈춘 에이전트는 이유를 태그로 보이고 다시 시작할 수 있다', async () => {
    const user = userEvent.setup();
    const stopped = {
      ...AGENTS[0],
      phase: 'Suspended',
      ready: false,
      suspended: true,
      suspended_reason: 'idle',
      suspended_since: '2026-10-01T00:00:00Z',
    };
    const fn = mount({ ...BASE, agents: [stopped] });
    expect(await screen.findByText('오래 쓰지 않아 멈춤')).toBeInTheDocument();
    await user.click(await rowByName(/마케팅/));
    const drawer = await screen.findByRole('dialog', { name: '마케팅' });
    expect(within(drawer).getByText(/오래 쓰지 않아 멈춤.*데이터는 그대로입니다/)).toBeInTheDocument(); // 멈춘 이유는 기본 정보 표
    await user.click(within(drawer.querySelector('[data-drawer-head]') as HTMLElement).getByRole('button', { name: '다시 시작' }));
    const box = await screen.findByRole('dialog', { name: '다시 시작' });
    expect(postedTo(fn, '/api/agents/resume')).toEqual([]); // 머리 단추는 확인을 거친다
    await user.click(within(box).getByRole('button', { name: '다시 시작' }));
    await waitFor(() => expect(postedTo(fn, '/api/agents/resume')).toEqual([{ name: 'hag-kim-1' }]));
  });

  it('행 「…」 메뉴의 다시 시작은 멈춘 에이전트에만 보이고 서랍과 같은 요청을 보낸다(OMAI-1127 검토 D17)', async () => {
    const user = userEvent.setup();
    const stopped = { ...AGENTS[0], phase: 'Suspended', ready: false, suspended: true, suspended_reason: 'idle' };
    const running = { ...AGENTS[0], name: 'hag-kim-2', display_name: '영업', phase: 'Ready', ready: true, suspended: false, message: '' };
    const fn = mount({ ...BASE, agents: [stopped, running] });
    await user.click(await screen.findByRole('button', { name: '마케팅 동작' }));
    await user.click(screen.getByRole('menuitem', { name: '다시 시작' }));
    await waitFor(() => expect(postedTo(fn, '/api/agents/resume')).toEqual([{ name: 'hag-kim-1' }]));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '영업 동작' }));
    expect(screen.queryByRole('menuitem', { name: '다시 시작' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '상세 보기' })).toBeInTheDocument();
  });

  it('관리자는 소유권을 이메일로 옮긴다(직접 적은 이메일)', async () => {
    const user = userEvent.setup();
    const fn = mount({ ...BASE, admin: true, limits: {} }, { '/api/agents/owner': { ok: true } });
    await user.click(await rowByName(/마케팅/));
    const drawer = await screen.findByRole('dialog', { name: '마케팅' });
    await user.click(within(drawer.querySelector('[data-drawer-head]') as HTMLElement).getByRole('button', { name: '소유권 이전' }));
    const dlg = await screen.findByRole('dialog', { name: '소유권 이전' });
    const box = within(dlg).getByRole('combobox', { name: '새 소유자 이메일' });
    const go = within(dlg).getAllByRole('button', { name: '소유권 이전' }).at(-1)!;
    expect(go).toBeDisabled();
    await user.type(box, 'lee@x.com');
    await user.click(go);
    await waitFor(() =>
      expect(postedTo(fn, '/api/agents/owner')).toEqual([{ name: 'hag-kim-1', owner_email: 'lee@x.com' }])
    );
  });

  it('소유권 이전: 사용자 목록에서 고르면 이메일이 입력 칸에 들어가고 그 이메일을 보낸다(OMAI-1229)', async () => {
    const user = userEvent.setup();
    const fn = mount(
      { ...BASE, admin: true, limits: {} },
      {
        '/api/agents/owner': { ok: true },
        '/api/users': { users: [{ email: 'park@x.com', name: '박민수', department: '개발팀', enabled: true }, { email: 'off@x.com', name: '쉬는 사람', enabled: false }] },
      }
    );
    await user.click(await rowByName(/마케팅/));
    const drawer = await screen.findByRole('dialog', { name: '마케팅' });
    await user.click(within(drawer.querySelector('[data-drawer-head]') as HTMLElement).getByRole('button', { name: '소유권 이전' }));
    const dlg = await screen.findByRole('dialog', { name: '소유권 이전' });
    const box = within(dlg).getByRole('combobox', { name: '새 소유자 이메일' });
    // 입력 칸에 처음부터 초점이 있어(열 때 자동) 목록은 사용자 목록이 도착하면 바로 열린다. 다시 누르면 닫힌다
    expect(within(await screen.findByRole('listbox')).getAllByRole('option')).toHaveLength(1); // 비활성 사용자는 목록에 없다
    await user.click(await screen.findByRole('option', { name: /박민수/ }));
    expect(box).toHaveValue('park@x.com');
    await user.click(within(dlg).getAllByRole('button', { name: '소유권 이전' }).at(-1)!);
    await waitFor(() =>
      expect(postedTo(fn, '/api/agents/owner')).toEqual([{ name: 'hag-kim-1', owner_email: 'park@x.com' }])
    );
  });

  it('관리자에게는 마지막 전체 수집의 POD 수와 실패한 POD 를 보인다', async () => {
    mount({
      ...BASE,
      admin: true,
      limits: {},
      collect: {
        ts: '2026-10-10T12:00:00+09:00',
        seconds: 61.5,
        pods: { ok: 1, total: 3, failed: [{ pod: 'hag-b', reason: '시간 초과(60초)' }, { pod: 'hag-kim-1', reason: '연결 안 됨' }] },
      },
    });
    expect(await screen.findByText('1 / 3')).toBeInTheDocument();
    // 목록에 있는 에이전트는 「주인 · 에이전트 이름」(사람 이름을 모르면 이메일), 목록에 없는 것은 id(스펙 2026-10-19-003)
    expect(screen.getByText('실패 hag-b, kim@x.com · 마케팅')).toBeInTheDocument();
  });

  it('쿠버네티스 모드가 아니면 안내만 보인다', async () => {
    mount({ ...BASE, enabled: false, agents: [] });
    expect(await screen.findByText(/쿠버네티스에 설치했을 때만/)).toBeInTheDocument();
  });
  it('서랍을 연 채 목록이 바뀌면(웹소켓) 만들기 서랍의 개수 안내·소유자 한도 서랍의 기본값 단추가 따라간다', async () => {
    const user = userEvent.setup();
    stubApi({ '/api/agents': BASE });
    const { qc } = mountScreen(<Agents />, '/agents');
    await user.click((await screen.findAllByRole('button', { name: 'AI 에이전트 작업공간 만들기' }))[0]);
    const create = await screen.findByRole('dialog', { name: 'AI 에이전트 작업공간 만들기' });
    expect(within(create).getByText(/지금 2개입니다/)).toBeInTheDocument();
    act(() => qc.setQueryData(['hermes-agents'], { ...BASE, count: 3, can_create: false }));
    expect(await within(create).findByText(/지금 3개입니다/)).toBeInTheDocument();
    expect(within(create).getByRole('button', { name: '만들기' })).toBeDisabled();
  });

  it('관리자가 연 에이전트 서랍은 행 밖의 기본 한도가 바뀌면 새 값으로 바뀐다', async () => {
    const user = userEvent.setup();
    stubApi({ '/api/agents': { ...BASE, admin: true, limits: { 'kim@x.com': 5 } } });
    const { qc } = mountScreen(<Agents />, '/agents');
    await user.click(await rowByName(/마케팅/));
    const dlg = await screen.findByRole('dialog', { name: '마케팅' });
    expect(await within(dlg).findByRole('button', { name: /기본값\(3개\)으로/ })).toBeInTheDocument();
    act(() => qc.setQueryData(['hermes-agents'], { ...BASE, admin: true, limits: { 'kim@x.com': 5 }, default_limit: 4 }));
    expect(await within(screen.getByRole('dialog', { name: '마케팅' })).findByRole('button', { name: /기본값\(4개\)으로/ })).toBeInTheDocument();
  });
});

describe('Agents 내 에이전트 뱃지(2026-10-17-016)', () => {
  describe('프로파일 칸(2026-10-19-006)', () => {
    const P = (over: object) => ({ ...AGENTS[0], ...over });
    const many = P({ name: 'hag-many', display_name: '많음', profiles: ['research', 'main', 'ops', 'writer', 'reviewer'], chat_default: 'main' });
    const one = P({ name: 'hag-one', display_name: '하나', profiles: ['main'], chat_default: 'main' });
    const unknown = P({ name: 'hag-unknown', display_name: '모름', profiles: null, chat_default: '' });
    const preparing = P({ name: 'hag-prep', display_name: '준비', profiles: [], chat_default: '', primary_preparing: true });
    const stopped = P({ name: 'hag-stop', display_name: '멈춘', ready: false, suspended: true, phase: 'Ready', profiles: null, chat_default: '' });

    it('채팅 기본을 맨 앞 별과, 나머지는 이름 순 3개까지 「+N」, 하나뿐이면 별이 없다(DD6·DD7·DD10)', async () => {
      mount({ ...BASE, agents: [many, one] });
      const row = await rowByName(/많음/);
      const chips = Array.from(row.querySelectorAll('[data-agent-chip="profile"]')).map((c) => c.textContent);
      expect(chips).toEqual(['main', 'ops', 'research']);
      expect(within(row).getByText('채팅 기본 프로파일:')).toBeInTheDocument(); // 낭독용 글
      expect(within(row).getByTestId('chat-default-star')).toHaveAttribute('aria-hidden', 'true');
      expect(within(row).getByText('2개 더: reviewer, writer')).toBeInTheDocument();
      const single = await rowByName(/하나/);
      expect(single.querySelectorAll('[data-agent-chip="profile"]')).toHaveLength(1);
      expect(within(single).queryByTestId('chat-default-star')).toBeNull();
    });

    it('모르는 줄의 「—」에만 「읽는 중이거나 읽지 못했습니다」, 준비 중·멈춘 줄은 설명 없는 「—」(DD3·DD4)', async () => {
      mount({ ...BASE, agents: [unknown, preparing, stopped] });
      expect(within(await rowByName(/모름/)).getByText('프로파일을 읽는 중이거나 읽지 못했습니다')).toBeInTheDocument();
      for (const name of [/준비/, /멈춘/]) {
        const row = await rowByName(name);
        expect(within(row).getByText('—')).toBeInTheDocument();
        expect(within(row).queryByText('프로파일을 읽는 중이거나 읽지 못했습니다')).toBeNull();
      }
    });

    it('표 검색은 프로파일 이름도 본다(C1)', async () => {
      const user = userEvent.setup();
      mount({ ...BASE, agents: [many, one] });
      await rowByName(/많음/);
      await user.type(screen.getAllByPlaceholderText('검색')[0], 'reviewer');
      await waitFor(() => expect(screen.queryByText('하나')).toBeNull());
      expect(screen.getByText('많음')).toBeInTheDocument();
    });

    it('머리를 누르면 프로파일 개수 순, 모르는 줄은 끝(DD11)', async () => {
      const user = userEvent.setup();
      mount({ ...BASE, agents: [unknown, many, one] });
      await rowByName(/많음/);
      await user.click(within(screen.getByRole('columnheader', { name: /프로파일/ })).getByRole('button'));
      const order = screen.getAllByRole('row').slice(1).map((r) => r.textContent ?? '');
      expect(order.map((t) => ['하나', '많음', '모름'].find((n) => t.includes(n)))).toEqual(['하나', '많음', '모름']);
    });

    it('서랍의 「프로파일」 줄은 모든 칩을 줄이지 않고 보인다(DD5)', async () => {
      const user = userEvent.setup();
      mount({ ...BASE, agents: [many] });
      await user.click(await rowByName(/많음/));
      const dlg = await screen.findByRole('dialog', { name: '많음' });
      const dt = Array.from(dlg.querySelectorAll('.aas-kv dt')).find((e) => e.textContent === '프로파일');
      expect(dt?.nextElementSibling?.textContent).toContain('reviewer');
      expect(dlg.querySelectorAll('.aas-kv [data-agent-chip="profile"]')).toHaveLength(5);
    });
  });

  it('내가 주인인 에이전트 이름 옆에만 「내 에이전트」를 보인다(이메일 대소문자 무관)', async () => {
    const theirs = { ...AGENTS[0], name: 'hag-lee-1', owner: 'lee@x.com', display_name: '영업' };
    mount(
      { ...BASE, admin: true, agents: [AGENTS[0], theirs] },
      { '/api/me': { auth_enabled: true, admin: true, user: { email: 'KIM@x.com', name: 'kim' } } }
    );
    expect(within(await rowByName(/마케팅/)).getByText('내 AI 에이전트 작업공간')).toBeInTheDocument();
    expect(within(await rowByName(/영업/)).queryByText('내 AI 에이전트 작업공간')).toBeNull();
  });
});

describe('Agents ?open= (스펙 2026-10-19-011 A3)', () => {
  it('프로파일 서랍의 「들어 있는 에이전트」 링크(#/agents?open=<id>)로 오면 그 줄의 서랍을 연다', async () => {
    stubApi({ '/api/agents': BASE });
    mountScreen(<Agents />, '/agents?open=hag-kim-1');
    const dlg = await screen.findByRole('dialog', { name: '마케팅' });
    expect(within(dlg).getByText('hag-kim-1')).toBeInTheDocument();
  });

  // 스펙 2026-10-28-014 D8·D9: 행 클릭은 주소에 open 을 쓰고(값이 POD id 라 pod 는 쓰지 않음), 뒤로 가기·닫기는 값을 지운다
  it('행을 누르면 주소에 open 이 생기고, 뒤로 가기·닫기로 서랍이 닫히며 값이 지워진다', async () => {
    const user = userEvent.setup();
    stubApi({ '/api/agents': BASE });
    mountScreen(
      <>
        <Agents />
        <HistoryBack />
      </>,
      '/agents'
    );
    await user.click(await rowByName(/마케팅/));
    expect(await screen.findByRole('dialog', { name: '마케팅' })).toBeInTheDocument();
    expect(screen.getByTestId('loc')).toHaveTextContent(/^\/agents\?open=hag-kim-1$/);
    fireEvent.click(screen.getByRole('button', { name: '뒤로 가기', hidden: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByTestId('loc')).toHaveTextContent(/^\/agents$/);
    await user.click(await rowByName(/마케팅/));
    await user.click(within(await screen.findByRole('dialog', { name: '마케팅' })).getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/agents$/));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('없는 작업공간의 링크는 서랍 안에 찾지 못했다고 알린다', async () => {
    stubApi({ '/api/agents': BASE });
    mountScreen(<Agents />, '/agents?open=hag-gone');
    expect(await screen.findByText('AI 에이전트 작업공간 hag-gone 을(를) 찾지 못했습니다. 지워졌을 수 있습니다.')).toBeInTheDocument();
  });
});

describe('agentPreparing', () => {
  it('멈춘 에이전트는 준비 중이 아니다(따라 읽기가 끝나지 않았다)', () => {
    expect(agentPreparing({ ready: false, phase: 'Suspended', suspended: true })).toBe(false);
    expect(agentPreparing({ ready: false, phase: 'Failed', suspended: false })).toBe(false);
    expect(agentPreparing({ ready: true, phase: 'Ready', suspended: false })).toBe(false);
  });
  it('멈추는 중·다시 켜는 중·만드는 중은 준비 중이다', () => {
    expect(agentPreparing({ ready: false, phase: 'NotReady', suspended: true })).toBe(true);
    expect(agentPreparing({ ready: false, phase: 'Suspended', suspended: false })).toBe(true);
    expect(agentPreparing({ ready: false, phase: 'Provisioning', suspended: false })).toBe(true);
  });
});

// 순차 롤아웃(스펙 2026-10-28-015 §4-6, 디자인 리뷰 DD1~DD19)
describe('Agents 롤아웃(관리자)', () => {
  const H = (c: string) => `reg.local/hermes@sha256:${c.repeat(64)}`;
  const ROWS = [
    { ...AGENTS[0], name: 'hag-1', display_name: '하나', image_digest: H('1'), version: '1.0.5', outdated: true, rollout_state: 'waiting' },
    { ...AGENTS[0], name: 'hag-2', display_name: '둘', image_digest: H('2'), version: '1.0.6', outdated: false, rollout_state: 'done' },
    { ...AGENTS[0], name: 'hag-3', display_name: '셋', phase: 'Provisioning', ready: false, message: '파드가 준비되길 기다립니다', updating: true, rollout_state: 'updating' },
  ];
  const ro = (over: Record<string, unknown> = {}) => ({
    name: 'hro-1', version: '1.0.6', phase: 'Rolling', message: '', image: H('2'), sidecar_image: '', rollback_of: '', canary: ['hag-2'],
    canary_info: { name: 'hag-2', state: 'done', ready_seconds: 180, waiting_seconds: 600 }, batch: 1, batch_size: 2, skip_busy: true,
    paused: false, approved: true, aborted: false, blocking: true, total: 3, done: 1, updating: ['hag-3'], waiting: 1, next_batch: ['hag-1'],
    deferred_busy: 0, suspended: 0, excluded: [], reverted: [], failed: [], started: '', completed: '', created_by: '',
    agents: [{ name: 'hag-1', state: 'waiting' }, { name: 'hag-2', state: 'done', previous: H('1') }, { name: 'hag-3', state: 'updating' }],
    ...over,
  });
  const ADMIN = { ...BASE, admin: true, limits: {}, agents: ROWS, ever: true, target: { image: H('2'), sidecar_image: '', version: '1.0.6' } };

  it('관리자는 버전 칸·「오래됨」 보기 카드를 보고, 바꾸는 중인 에이전트는 「문제」가 아니다(DD2·DD6·DD7)', async () => {
    mount({ ...ADMIN, rollout: ro() });
    expect(await screen.findByText('1.0.5')).toBeInTheDocument();
    expect(screen.getAllByText('1111111111111'.slice(0, 12)).length).toBeGreaterThan(0);
    expect(screen.getByText('업데이트 중')).toBeInTheDocument();
    const card = screen.getByRole('tab', { name: /오래됨/ });
    expect(card).toHaveTextContent('1');
    expect(card).toHaveTextContent('목표 1.0.6');
    expect(screen.getByRole('tab', { name: /문제/ })).toHaveTextContent('0');
  });

  it('사용자에게는 버전 칸·오래됨 카드·롤아웃 단추가 없다(DD18)', async () => {
    mount({ ...BASE, agents: [ROWS[0]] });
    expect(await screen.findByText('하나')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /오래됨/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '새 버전 롤아웃' })).not.toBeInTheDocument();
  });

  it('진행 중이면 띠에 묶음과 지금 바꾸는 에이전트, 진행 막대를 보이고 롤아웃 단추는 꺼진다(DD3·DD4)', async () => {
    mount({ ...ADMIN, rollout: ro() });
    const band = await screen.findByText('롤아웃 1.0.6 · 묶음 1 · 1/3 끝남 · 지금 kim@x.com · 셋');
    expect(band.closest('[data-rollout-band]')).toHaveAttribute('data-rollout-band', 'progress');
    expect(screen.getAllByRole('progressbar', { name: '3개 중 1개 끝남' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: '새 버전 롤아웃' })).toBeDisabled();
    expect(band.closest('[role="status"]')).toBeNull(); // 띠는 갱신마다 읽히지 않는다(DD16)
  });

  it('승인 대기 띠의 「계속」은 다음 묶음 이름을 담은 확인 뒤 resume 을 보낸다(DD11·DD12)', async () => {
    const user = userEvent.setup();
    const fn = mount({ ...ADMIN, rollout: ro({ phase: 'WaitingApproval', approved: false }) }, { '/api/agents/rollout/action': { ok: true } });
    expect(await screen.findByText('카나리 kim@x.com · 둘 이(가) 1.0.6 으로 떴습니다 · 준비까지 3분 · 10분째 기다림')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: '계속' })[0]);
    expect(await screen.findByText('다음 묶음 1개(kim@x.com · 하나)를 바꿉니다. 사용자 연결이 잠시 끊깁니다.')).toBeInTheDocument();
    expect(postedTo(fn, '/api/agents/rollout/action')).toEqual([]);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '계속' }));
    await waitFor(() => expect(postedTo(fn, '/api/agents/rollout/action')).toEqual([{ name: 'hro-1', action: 'resume' }]));
  });

  it('멈춤은 확인 없이 바로 보낸다(DD12)', async () => {
    const user = userEvent.setup();
    const fn = mount({ ...ADMIN, rollout: ro() }, { '/api/agents/rollout/action': { ok: true } });
    await user.click((await screen.findAllByRole('button', { name: '멈춤' }))[0]);
    await waitFor(() => expect(postedTo(fn, '/api/agents/rollout/action')).toEqual([{ name: 'hro-1', action: 'pause' }]));
  });

  it('실패 띠: 자동 되돌림 사실과 「바뀐 n개 모두 이전 버전으로」·「같은 목표로 다시 시작」(DD5)', async () => {
    const user = userEvent.setup();
    const failed = ro({ phase: 'Failed', blocking: false, message: '묶음 2 실패 — hag-3: 노드 자리가 부족해 뜨지 못했습니다' });
    const fn = mount({ ...ADMIN, rollout: failed }, { '/api/agents/rollout/action': { ok: true } });
    expect(await screen.findByText(/노드 자리가 부족해/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '새 버전 롤아웃' })).toBeEnabled(); // Failed 는 진행 중이 아니다
    await user.click(screen.getAllByRole('button', { name: '바뀐 2개 모두 이전 버전으로' })[0]);
    expect(await screen.findByText('바뀐 2개(kim@x.com · 둘, kim@x.com · 셋)를 각자의 이전 버전으로 되돌립니다. 사용자 연결이 잠시 끊깁니다.')).toBeInTheDocument();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '되돌리기' }));
    await waitFor(() => expect(postedTo(fn, '/api/agents/rollout/action')).toEqual([{ name: 'hro-1', action: 'rollback' }]));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click((await screen.findAllByRole('button', { name: '같은 목표로 다시 시작' }))[0]);
    expect(await screen.findByRole('textbox', { name: /Hermes 이미지 digest/ })).toHaveValue(H('2'));
  });

  it('상태를 읽지 못하면 띠는 다시 시도만, 롤아웃 단추는 꺼진다(DD8)', async () => {
    let fail = false;
    mount({ ...ADMIN, rollout: null }, { '/api/agents': () => (fail ? new Response(JSON.stringify({ error: 'k8s down' }), { status: 503 }) : { ...ADMIN, rollout: null }) });
    expect(await screen.findByRole('button', { name: '새 버전 롤아웃' })).toBeEnabled();
    fail = true;
    await userEvent.setup().click(screen.getByRole('button', { name: /새로 고침|다시 읽기/ }));
    expect(await screen.findByText('롤아웃 상태를 읽지 못했습니다')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '새 버전 롤아웃' })).toBeDisabled();
    expect(screen.getAllByRole('button', { name: '다시 시도' }).length).toBeGreaterThan(0);
  });

  it('시작 서랍은 형식을 검사하고, 대상 요약을 담은 확인 뒤 보낸다(DD10)', async () => {
    const user = userEvent.setup();
    const fn = mount({ ...ADMIN, rollout: null }, { '/api/agents/rollout/action': { ok: true }, '/api/agents/rollout': { ok: true, rollout: 'hro-2' } });
    await user.click(await screen.findByRole('button', { name: '새 버전 롤아웃' }));
    const dlg = await screen.findByRole('dialog', { name: '새 버전 롤아웃' });
    await user.type(within(dlg).getByRole('textbox', { name: /버전 이름/ }), '1.0.7');
    await user.type(within(dlg).getByRole('textbox', { name: /Hermes 이미지 digest/ }), 'reg.local/hermes:1.0.7');
    expect(within(dlg).getByText('저장소@sha256:<64자> 형식이 아닙니다')).toBeInTheDocument();
    expect(within(dlg).getByRole('button', { name: '시작' })).toBeDisabled();
    const box = within(dlg).getByRole('textbox', { name: /Hermes 이미지 digest/ });
    await user.clear(box);
    await user.click(box);
    await user.paste('other.reg/hermes@sha256:' + '3'.repeat(64));
    expect(within(dlg).getByText(/지금 쓰는 저장소\(reg\.local\/hermes\)와 다릅니다/)).toBeInTheDocument(); // 막지 않는다
    expect(within(dlg).getByText('대상 3 · 따로 지정됨 제외 0 · 멈춤 0(켜질 때 반영)')).toBeInTheDocument();
    await user.click(within(dlg).getByRole('button', { name: '시작' }));
    expect(await screen.findByText(/1\.0\.7 롤아웃을 시작합니다\. 대상 3개/)).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: '시작' }).at(-1)!);
    await waitFor(() =>
      expect(postedTo(fn, '/api/agents/rollout').filter((b) => !('action' in b))).toEqual([
        { version_name: '1.0.7', image: 'other.reg/hermes@sha256:' + '3'.repeat(64), sidecar_image: '', canary: [], batch_size: 2, skip_busy: true },
      ]),
    );
  });

  it('롤아웃을 한 번도 하지 않았으면 「오래됨」 카드는 「—」이고 띠가 알 수 없다고 말한다(DD1·DD2)', async () => {
    mount({ ...ADMIN, ever: false, rollout: null, target: { image: '', sidecar_image: '', version: '' }, agents: [{ ...ROWS[0], outdated: null, version: '' }] });
    expect(await screen.findByText('아직 롤아웃을 한 적이 없어 오래된 AI 에이전트 작업공간을 알 수 없습니다')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /오래됨/ })).toHaveTextContent('—');
  });
});
