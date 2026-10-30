/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { resetReadAloud } from '@/components/chat/readAloudPlayer';
import { resetVoice } from '@/components/chat/VoiceInput';
import { installFakeMedia, uninstallFakeMedia } from '@/test/fakeMedia';
import { ME_USER, mountScreen, postedTo, stubApi } from '@/test/mountScreen';

import { AgentChat, applyItems, resetChats } from './AgentChat';

afterEach(() => {
  vi.unstubAllGlobals();
  resetChats();
});

const words = { tool: (n: string) => `도구: ${n}`, approval: '승인 대기' };

describe('applyItems', () => {
  // 스펙 2026-10-23-005 재리뷰 R18: 선택지는 마지막 답 말풍선에 붙는다 — 따로 된 줄이면 final 이 말풍선을 새로 만들어 같은 글이 두 번 나온다
  it('되묻기 선택지는 답 말풍선 하나에 붙는다', () => {
    const lines = applyItems(
      [{ role: 'user', text: 'q' }],
      [
        { kind: 'delta', text: '형식?' },
        { kind: 'choices', questions: [{ question: '형식?', choices: ['PDF', 'Word'], multi: false }] },
        { kind: 'final', text: '형식?' },
      ],
      words
    );
    expect(lines.map((l) => l.role)).toEqual(['user', 'assistant']);
    expect(lines[1].choices).toEqual([{ question: '형식?', choices: ['PDF', 'Word'], multi: false }]);
  });

  it('조각을 이어 붙이고 끝나면 최종 글로 바꾼다', () => {
    let lines = applyItems(
      [{ role: 'user', text: 'q' }],
      [
        { kind: 'delta', text: '안' },
        { kind: 'tool_start', text: 'web' },
      ],
      words
    );
    lines = applyItems(
      lines,
      [
        { kind: 'delta', text: '녕' },
        { kind: 'final', text: '안녕하세요' },
      ],
      words
    );
    expect(lines.map((l) => [l.role, l.text])).toEqual([
      ['user', 'q'],
      ['assistant', '안'],
      ['tool', '도구: web'],
      ['assistant', '안녕하세요'],
    ]);
  });

  it('승인을 기다리면 받은편지함으로 안내한다', () => {
    expect(applyItems([], [{ kind: 'approval' }], words)).toEqual([{ role: 'note', text: '승인 대기' }]);
  });
});

describe('AgentChat', () => {
  it('말을 보내면 오피스 경로로 가고 답을 이어 받는다', async () => {
    const fn = stubApi({
      '/api/office/chat/send': { turn: 't1' },
      '/api/office/chat/turn': { items: [{ kind: 'final', text: '네, 확인했습니다' }], next: 1, done: true },
    });
    mountScreen(<AgentChat alias="ops" />, '/office');
    await userEvent.type(screen.getByLabelText('메시지'), '상태 알려줘');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    expect(postedTo(fn, '/api/office/chat/send')).toEqual([{ alias: 'ops', text: '상태 알려줘' }]);
    const log = screen.getByRole('log', { name: '대화' });
    expect(await within(log).findByText('네, 확인했습니다', {}, { timeout: 3000 })).toBeInTheDocument();
  });

  // 스펙 2026-10-23-005 디자인 D11: 오피스 대화의 되묻기 선택지는 고를 수 있는 단추다. 고른 것이 다음 말로 가 답이 된다
  it('되묻기 선택지를 누르면 그 글을 보내고, 답한 물음의 단추는 막는다', async () => {
    let n = 0;
    const fn = stubApi({
      '/api/office/chat/send': () => ({ turn: `t${++n}` }),
      '/api/office/chat/turn': (u: string) =>
        u.includes('turn=t1')
          ? {
              items: [
                { kind: 'delta', text: '형식?' },
                { kind: 'choices', questions: [{ question: '형식?', choices: ['PDF', 'Word'], multi: false }] },
                { kind: 'final', text: '형식?' },
              ],
              next: 3,
              done: true,
            }
          : { items: [{ kind: 'final', text: 'Word 로 만들겠습니다' }], next: 1, done: true },
    });
    mountScreen(<AgentChat alias="ops" />, '/office');
    await userEvent.type(screen.getByLabelText('메시지'), '보고서');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    const group = await screen.findByRole('group', { name: '선택지' }, { timeout: 3000 });
    await waitFor(() => expect(within(group).getByRole('button', { name: 'Word' })).toBeEnabled());
    await userEvent.click(within(group).getByRole('button', { name: 'Word' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/chat/send').at(-1)).toEqual({ alias: 'ops', text: 'Word' }));
    expect(await screen.findByText('Word 로 만들겠습니다', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: '선택지' })).getByRole('button', { name: 'PDF' })).toBeDisabled();
  });

  it('여러 개 고르기 물음은 체크한 것을 쉼표로 이어 보낸다', async () => {
    const fn = stubApi({
      '/api/office/chat/send': { turn: 't1' },
      '/api/office/chat/turn': {
        items: [
          { kind: 'choices', questions: [{ question: '항목?', choices: ['매출', '비용', '인원'], multi: true }] },
          { kind: 'final', text: '항목?' },
        ],
        next: 2,
        done: true,
      },
    });
    mountScreen(<AgentChat alias="ops" />, '/office');
    await userEvent.type(screen.getByLabelText('메시지'), '보고서');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    const group = await screen.findByRole('group', { name: '선택지' }, { timeout: 3000 });
    await waitFor(() => expect(within(group).getByRole('checkbox', { name: '매출' })).toBeEnabled());
    expect(within(group).getByRole('button', { name: '답하기' })).toBeDisabled();
    await userEvent.click(within(group).getByRole('checkbox', { name: '매출' }));
    await userEvent.click(within(group).getByRole('checkbox', { name: '인원' }));
    await userEvent.click(within(group).getByRole('button', { name: '답하기' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/chat/send').at(-1)).toEqual({ alias: 'ops', text: '매출, 인원' }));
  });

  it('「/」로 고른 스킬을 붙여 보내고, 붙이지 못한 차례는 안내 줄을 보인다(스펙 2026-10-19-012)', async () => {
    const fn = stubApi({
      '/api/office/chat/skills': { skills: [{ command: '/요약', name: '요약', description: '', usage: 0 }], warning: '' },
      '/api/office/chat/send': { turn: 't1' },
      '/api/office/chat/turn': {
        items: [
          { kind: 'notice', code: 'skill_failed', name: '요약', reason: 'noskill' },
          { kind: 'final', text: '네' },
        ],
        next: 2,
        done: true,
      },
    });
    const user = userEvent.setup();
    mountScreen(<AgentChat alias="ops" />, '/office');
    await user.type(screen.getByLabelText('메시지'), '/요');
    await screen.findByRole('option', { name: /요약/ });
    await user.keyboard('{Enter}정리{Enter}');
    await waitFor(() => expect(postedTo(fn, '/api/office/chat/send')).toEqual([{ alias: 'ops', text: '/요약 정리', skill: '요약' }]));
    expect(await screen.findByText('스킬 /요약 를 붙이지 못해 글만 보냈습니다 · 이 AI 에이전트에 없음', {}, { timeout: 3000 })).toBeInTheDocument();
  });

  // 채팅·회의와 같은 키로 맞췄다(2026-10-16: 「회의실도 채팅창도 같은 방식으로 엔터로 전송」). 전에는 Ctrl+Enter 전송이었다
  it('Enter 로 보내고 Shift+Enter 는 줄바꿈이다(채팅·회의와 같다)', async () => {
    const fn = stubApi({ '/api/office/chat/send': { turn: 't1' }, '/api/office/chat/turn': { items: [], next: 0, done: false } });
    mountScreen(<AgentChat alias="ops" />, '/office');
    const box = screen.getByLabelText('메시지');
    await userEvent.type(box, '한 줄{Shift>}{Enter}{/Shift}두 줄');
    expect(postedTo(fn, '/api/office/chat/send')).toHaveLength(0);
    expect(box).toHaveValue('한 줄\n두 줄');
    await userEvent.type(box, '{Enter}');
    await waitFor(() => expect(postedTo(fn, '/api/office/chat/send')).toHaveLength(1));
    expect(box).toHaveFocus(); // 보낸 뒤에도 입력칸에 머문다(디자인 리뷰 3-1)
  });

  it('내 말은 단색 판, 에이전트 답은 머리줄(이름)이 있는 기록이고 전송 단추는 파랑 채움이 아니다', async () => {
    stubApi({
      '/api/office/chat/send': { turn: 't1' },
      '/api/office/chat/turn': { items: [{ kind: 'final', text: '답' }], next: 1, done: true },
    });
    mountScreen(<AgentChat alias="ops" />, '/office');
    await userEvent.type(screen.getByLabelText('메시지'), '질문');
    expect(screen.getByRole('button', { name: '보내기' }).className).not.toMatch(/contained|colorPrimary/);
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    const log = screen.getByRole('log', { name: '대화' });
    await within(log).findByText('답', {}, { timeout: 3000 });
    expect(within(log).getByTitle('ops')).toBeInTheDocument(); // 머리줄의 이름
  });

  // 응답이 0.7초보다 늦어도 같은 after 로 겹쳐 묻지 않는다 — 겹치면 같은 조각이 두 번 붙었다(스펙 2026-10-17-004 D5)
  it('느린 응답에서도 차례 묻기는 앞 요청이 끝난 뒤에만 보낸다', async () => {
    let inFlight = 0;
    let most = 0;
    const afters: string[] = [];
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.startsWith('/api/office/chat/send')) return Promise.resolve(reply({ turn: 't1' }));
        if (!url.startsWith('/api/office/chat/turn')) return Promise.resolve(reply({}));
        const after = new URL(url, 'http://x').searchParams.get('after') ?? '';
        afters.push(after);
        inFlight += 1;
        most = Math.max(most, inFlight);
        const body = after === '0' ? { items: [{ kind: 'delta', text: '안' }], next: 1, done: false } : { items: [{ kind: 'final', text: '안녕' }], next: 2, done: true };
        return new Promise((resolve) =>
          setTimeout(() => {
            inFlight -= 1;
            resolve(reply(body));
          }, 900)
        );
      })
    );
    mountScreen(<AgentChat alias="ops" />, '/office');
    await userEvent.type(screen.getByLabelText('메시지'), '인사{Enter}');
    const log = screen.getByRole('log', { name: '대화' });
    expect(await within(log).findByText('안녕', {}, { timeout: 6000 })).toBeInTheDocument();
    expect(most).toBe(1);
    expect(afters).toEqual(['0', '1']);
  }, 10000);

  it('보내기 실패는 오류 줄로 보인다', async () => {
    const reply = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
    vi.stubGlobal('fetch', vi.fn(() => reply({ error: '연결 거부' }, 500)));
    mountScreen(<AgentChat alias="ops" />, '/office');
    await userEvent.type(screen.getByLabelText('메시지'), '말{Control>}{Enter}{/Control}');
    expect(await screen.findByRole('alert')).toHaveTextContent('연결 거부');
  });

  // 사용자 보고(2026-10-16): 대화한 뒤 새로 고치면 대화 창이 「아직 나눈 말이 없습니다」만 보였다. 대화는 메모리에만 있었다
  it('처음 열면 서버에서 지난 말을 읽어 보여 준다(새로 고친 뒤)', async () => {
    const fn = stubApi({
      '/api/office/chat/history': {
        messages: [
          { role: 'user', text: '어제 회의 정리해줘' },
          { role: 'assistant', text: '정리했습니다' },
        ],
        turn: null,
      },
    });
    mountScreen(<AgentChat alias="ops" />, '/office');
    const log = screen.getByRole('log', { name: '대화' });
    expect(await within(log).findByText('정리했습니다')).toBeInTheDocument();
    expect(within(log).getByText('어제 회의 정리해줘')).toBeInTheDocument();
    expect(within(log).queryByText('아직 나눈 말이 없습니다')).toBeNull();
    expect(fn.mock.calls.filter((c) => String(c[0]) === '/api/office/chat/history?alias=ops')).toHaveLength(1);
  });

  it('새로 고친 뒤에도 마지막 되묻기 물음의 선택지 단추를 다시 보인다(스펙 2026-10-23-005 §6)', async () => {
    const fn = stubApi({
      '/api/office/chat/history': {
        messages: [
          { role: 'user', text: '보고서 만들어줘' },
          { role: 'assistant', text: '형식?', choices: [{ question: '형식?', choices: ['PDF', 'Word'], multi: false }] },
        ],
        turn: null,
      },
      '/api/office/chat/send': { turn: 't1' },
      '/api/office/chat/turn': { items: [{ kind: 'final', text: 'Word 로 만들겠습니다' }], next: 1, done: true },
    });
    mountScreen(<AgentChat alias="ops" />, '/office');
    const group = await screen.findByRole('group', { name: '선택지' });
    await userEvent.click(within(group).getByRole('button', { name: 'Word' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/chat/send').at(-1)).toEqual({ alias: 'ops', text: 'Word' }));
  });

  it('답하는 중이던 차례가 있으면 이어 받는다', async () => {
    const fn = stubApi({
      '/api/office/chat/history': { messages: [{ role: 'user', text: '천천히' }], turn: 't9' },
      '/api/office/chat/turn': { items: [{ kind: 'final', text: '늦은 답' }], next: 1, done: true },
    });
    mountScreen(<AgentChat alias="ops" />, '/office');
    const log = screen.getByRole('log', { name: '대화' });
    expect(await within(log).findByText('늦은 답', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(fn.mock.calls.some((c) => String(c[0]).includes('/api/office/chat/turn?alias=ops&turn=t9&after=0'))).toBe(true);
  });

  it('지난 말을 못 읽으면 알림 대신 빈 자리에 안내하고, 보내기는 그대로 된다', async () => {
    const fn = stubApi({ '/api/office/chat/send': { turn: 't1' }, '/api/office/chat/turn': { items: [], next: 0, done: false } });
    mountScreen(<AgentChat alias="ops" />, '/office');
    expect(await screen.findByText(/지난 대화를 불러오지 못했습니다/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    await userEvent.type(screen.getByLabelText('메시지'), '말{Enter}');
    await waitFor(() => expect(postedTo(fn, '/api/office/chat/send')).toHaveLength(1));
  });

  // ---- 연결이 끊겼을 때(스펙 2026-10-20-030 4-7) ----
  it('답을 읽다 503 이 나면 그 차례를 버리지 않고 간격을 두어 다시 읽으며, 그동안 보내기·멈춤을 막는다', async () => {
    const rnd = vi.spyOn(Math, 'random').mockReturnValue(0); // 간격 0.8초
    onTestFinished(() => rnd.mockRestore());
    let n = 0;
    const fn = stubApi({
      '/api/office/chat/send': { turn: 't1' },
      '/api/office/chat/turn': () => (++n === 1 ? new Response('{"error":"down"}', { status: 503 }) : { items: [{ kind: 'final', text: '다시 이어진 답' }], next: 1, done: true }),
    });
    mountScreen(<AgentChat alias="ops" />, '/office');
    await userEvent.type(screen.getByLabelText('메시지'), '상태{Enter}');
    const row = await screen.findByTestId('reconnect-row', {}, { timeout: 3000 });
    expect(row).toHaveTextContent('답을 다시 읽는 중입니다');
    expect(screen.getByRole('button', { name: '멈추기' })).toBeDisabled();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(await screen.findByText('다시 이어진 답', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByTestId('reconnect-row')).toBeNull();
    expect(fn.mock.calls.filter((c) => String(c[0]).startsWith('/api/office/chat/turn')).length).toBe(2);
  });

  it('서버가 다시 시작돼 차례를 모르면(404) 기록을 다시 읽어 늦게 끝난 답을 보인다', async () => {
    const rnd = vi.spyOn(Math, 'random').mockReturnValue(0);
    onTestFinished(() => rnd.mockRestore());
    let reads = 0;
    stubApi({
      '/api/office/chat/send': { turn: 't1' },
      '/api/office/chat/turn': () => new Response('{"error":"not_found"}', { status: 404 }),
      '/api/office/chat/history': () => {
        reads += 1;
        if (reads === 1) return { messages: [], turn: null }; // 처음 열 때
        return reads === 2 ? { messages: [{ role: 'user', text: '상태' }], turn: null } : { messages: [{ role: 'user', text: '상태' }, { role: 'assistant', text: '끝난 답' }], turn: null };
      },
    });
    mountScreen(<AgentChat alias="ops" />, '/office');
    await waitFor(() => expect(reads).toBe(1));
    await userEvent.type(screen.getByLabelText('메시지'), '상태{Enter}');
    expect(await screen.findByText('끝난 답', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByTestId('reconnect-row')).toBeNull();
  });

  it('기록에도 답이 끝내 없으면 호박색 「받지 못했습니다」 줄과 「다시 묻기」 — 빈 입력 칸에만 말을 채운다', async () => {
    const real = Date.now.bind(Date);
    let shift = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => real() + shift);
    onTestFinished(() => clock.mockRestore());
    let reads = 0;
    stubApi({
      '/api/office/chat/send': { turn: 't1' },
      '/api/office/chat/turn': () => new Response('{"error":"not_found"}', { status: 404 }),
      '/api/office/chat/history': () => {
        reads += 1;
        if (reads >= 2) shift = 6 * 60000; // 다음 실패에서 5분 한도를 넘는다
        return { messages: reads === 1 ? [] : [{ role: 'user', text: '상태' }], turn: null };
      },
    });
    mountScreen(<AgentChat alias="ops" />, '/office');
    await waitFor(() => expect(reads).toBe(1));
    await userEvent.type(screen.getByLabelText('메시지'), '상태{Enter}');
    expect(await screen.findByText('서버가 다시 시작돼 이 답을 받지 못했습니다', {}, { timeout: 4000 })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '다시 묻기' }));
    expect(screen.getByLabelText('메시지')).toHaveValue('상태');
  });

  it('서랍을 닫았다 열어도 입력 초안이 남는다(G11)', async () => {
    stubApi({});
    const first = mountScreen(<AgentChat alias="ops" />, '/office');
    await userEvent.type(screen.getByLabelText('메시지'), '쓰다 만 말');
    first.unmount();
    mountScreen(<AgentChat alias="ops" />, '/office');
    await waitFor(() => expect(screen.getByLabelText('메시지')).toHaveValue('쓰다 만 말'));
  });
});

// 오피스 대화의 「말로 입력」은 받는 에이전트(alias)가 아니라 내 에이전트의 주 프로파일로 받아쓴다(스펙 2026-10-22-005 R12)
describe('AgentChat 말로 입력', () => {
  afterEach(() => {
    resetVoice();
    uninstallFakeMedia();
  });

  it('내 에이전트(own_pods)와 그 primary 로 받아쓰고 글을 입력칸에 넣는다', async () => {
    installFakeMedia();
    const fn = stubApi({
      '/api/me': { ...ME_USER, pod: { id: 'mine', owner: 'lee@x.com' }, pods: [], own_pods: ['mine'] },
      '/api/chat/status': { stt: true, primary: 'lee-main' },
      '/api/chat/transcribe': { transcript: '오피스 말' },
    });
    mountScreen(<AgentChat alias="ops" />, '/office');
    fireEvent.click(await screen.findByRole('button', { name: '말로 입력' }));
    await screen.findByText('0:00 / 1:00');
    fireEvent.click(screen.getAllByRole('button', { name: '녹음 끝내기' }).at(-1)!);
    await waitFor(() => expect(screen.getByLabelText('메시지')).toHaveValue('오피스 말'));
    expect(postedTo(fn, '/api/chat/transcribe')[0]).toMatchObject({ pod: 'mine', profile: 'lee-main' });
    expect(postedTo(fn, '/api/office/chat/send')).toHaveLength(0); // 자동으로 보내지 않는다(D8)
  });

  it('내 에이전트가 없으면 단추가 없다', async () => {
    installFakeMedia();
    stubApi({
      '/api/me': { ...ME_USER, pod: null, pods: [], own_pods: [] },
      '/api/chat/status': { stt: true, primary: 'main' },
    });
    mountScreen(<AgentChat alias="ops" />, '/office');
    await screen.findByLabelText('메시지');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('button', { name: '말로 입력' })).toBeNull();
  });
});

// 오피스 대화의 답 「읽어 주기」(스펙 2026-10-28-012 DD13): 행동 줄 [복사][읽어 주기], 내 에이전트의 주 프로파일로 읽고, 내 에이전트가 없으면 단추가 없다
describe('AgentChat 읽어 주기', () => {
  const fakeAudio = () => ({ src: '', onended: null, onerror: null, play: () => Promise.resolve(), pause: () => undefined });
  afterEach(() => resetReadAloud());
  const history = { messages: [{ role: 'user', text: '요약해줘' }, { role: 'assistant', text: '요약입니다' }], turn: null };

  it('답 아래에 [복사][읽어 주기]가 있고, 누르면 내 에이전트(own_pods)와 그 primary 로 /api/chat/speak 를 부른다', async () => {
    resetReadAloud({ makeAudio: fakeAudio, createUrl: () => 'blob:x', revokeUrl: () => undefined });
    const fn = stubApi({
      '/api/me': { ...ME_USER, pod: { id: 'mine', owner: 'lee@x.com' }, pods: [], own_pods: ['mine'] },
      '/api/chat/status': { tts: true, tts_voices: [{ id: 'v1', name: { ko: '여성', en: 'F' }, gender: 'female' }], primary: 'lee-main' },
      '/api/office/chat/history': history,
      '/api/chat/speak': () => new Response(new Blob(['mp3']), { status: 200, headers: { 'X-Speak-Parts': '1' } }),
    });
    mountScreen(<AgentChat alias="ops" />, '/office');
    await screen.findByText('요약입니다');
    expect(screen.getByRole('button', { name: '답변 복사' })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: '읽어 주기' }));
    await waitFor(() => expect(postedTo(fn, '/api/chat/speak')).toHaveLength(1));
    expect(postedTo(fn, '/api/chat/speak')[0]).toEqual({ pod: 'mine', profile: 'lee-main', text: '요약입니다', voice: 'v1', part: 0 });
    expect(await screen.findByText('ops의 답 읽는 중')).toBeInTheDocument();
  });

  it('내 에이전트가 없거나 tts:false 면 [읽어 주기]가 없다([복사]는 있다)', async () => {
    stubApi({
      '/api/me': { ...ME_USER, pod: null, pods: [], own_pods: [] },
      '/api/chat/status': { tts: true, primary: 'main' },
      '/api/office/chat/history': history,
    });
    const a = mountScreen(<AgentChat alias="ops" />, '/office');
    await screen.findByText('요약입니다');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByRole('button', { name: '답변 복사' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '읽어 주기' })).toBeNull();
    a.unmount();
    resetChats();
    stubApi({
      '/api/me': { ...ME_USER, pod: { id: 'mine', owner: 'lee@x.com' }, pods: [], own_pods: ['mine'] },
      '/api/chat/status': { tts: false, primary: 'main' },
      '/api/office/chat/history': history,
    });
    mountScreen(<AgentChat alias="ops" />, '/office');
    await screen.findByText('요약입니다');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('button', { name: '읽어 주기' })).toBeNull();
  });
});
