/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 회의실의 「말로 입력」(스펙 2026-10-22-005 R9·R11·11A, §11-2 시험 표): 받는 에이전트와 관계없이 내 에이전트(own_pods)의 주 프로파일로 받아쓴다.
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readAloud, resetReadAloud } from '@/components/chat/readAloudPlayer';
import { resetVoice } from '@/components/chat/VoiceInput';
import { FakeES } from '@/test/fakeEventSource';
import { FakeMedia, installFakeMedia, uninstallFakeMedia } from '@/test/fakeMedia';
import { ME_USER, mountScreen, postedTo, stubApi } from '@/test/mountScreen';

import { MeetingRoom } from './MeetingRoom';

const VIEW = {
  room: { id: 1, name: '제안 TFT', purpose: '', status: 'open' },
  participants: [{ alias: 'sa', title: '영업', pod: 'team-pod', enabled: true }],
  messages: [],
  pending: [],
  thread: 0,
  viewing: 0,
};
const ME = (over: Record<string, unknown> = {}) => ({
  ...ME_USER,
  pod: { id: 'team-pod', owner: 'park@x.com', team: true },
  pods: [],
  own_pods: ['zeta', 'alpha'],
  ...over,
});

let m: FakeMedia;
beforeEach(() => {
  FakeES.all = [];
  vi.stubGlobal('EventSource', FakeES);
  m = installFakeMedia();
});
afterEach(() => {
  resetVoice();
  vi.unstubAllGlobals();
  uninstallFakeMedia();
});

function mount(me: Record<string, unknown>, status: Record<string, unknown> | ((url: string) => unknown)) {
  const fn = stubApi({
    '/api/me': me,
    '/api/chat/status': status,
    '/api/chat/transcribe': { transcript: '회의 말' },
    '/api/office/meeting': VIEW,
    '/api/office': { seats: [], rooms: [], pods: [], problems: [] },
  });
  mountScreen(<MeetingRoom roomId={1} canAct />, '/office');
  return fn;
}

describe('회의실 말로 입력', () => {
  it('지금 에이전트가 팀원 것이면 own_pods 의 이름순 첫째와 그 primary 로 받아쓴다(R11·L2·E5)', async () => {
    const fn = mount(ME(), (url: string) => ({
      stt: true,
      primary: url.includes('pod=alpha') ? 'boss' : 'x',
      pod: 'alpha',
    }));
    fireEvent.click(await screen.findByRole('button', { name: '말로 입력' }));
    await screen.findByText('0:00 / 1:00');
    fireEvent.click(screen.getAllByRole('button', { name: '녹음 끝내기' }).at(-1)!);
    await waitFor(() => expect(screen.getByRole('textbox', { name: '메시지' })).toHaveValue('회의 말'));
    expect(postedTo(fn, '/api/chat/transcribe')[0]).toMatchObject({ pod: 'alpha', profile: 'boss' });
    expect(fn.mock.calls.some((c) => String(c[0]) === '/api/chat/status?pod=alpha')).toBe(true);
    expect(m.tracks[0].stop).toHaveBeenCalled();
  });

  it('지금 고른 에이전트가 내 것이면 그것을 쓴다', async () => {
    const fn = mount(ME({ pod: { id: 'zeta', owner: 'lee@x.com' } }), { stt: true, primary: 'main' });
    await screen.findByRole('button', { name: '말로 입력' });
    expect(fn.mock.calls.some((c) => String(c[0]) === '/api/chat/status?pod=zeta')).toBe(true);
  });

  it('내 에이전트가 없으면 단추가 없다(R9)', async () => {
    mount(ME({ own_pods: [] }), { stt: true, primary: 'main' });
    await screen.findByRole('textbox', { name: '메시지' });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('button', { name: '말로 입력' })).toBeNull();
  });

  it('음성 인식이 설정되지 않은 설치(stt:false)면 단추가 없다(R2)', async () => {
    mount(ME(), { stt: false, primary: 'main' });
    await screen.findByRole('textbox', { name: '메시지' });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('button', { name: '말로 입력' })).toBeNull();
  });

  it('connected:false 라도 error 가 없으면 마이크를 막지 않는다 — connected 는 채팅 웹소켓이 열려 있는지일 뿐이다', async () => {
    mount(ME(), { stt: true, connected: false, primary: 'main' });
    const b = await screen.findByRole('button', { name: '말로 입력' });
    await new Promise((r) => setTimeout(r, 50));
    expect(b).not.toHaveAttribute('aria-disabled');
    fireEvent.click(b);
    await screen.findByText('0:00 / 1:00');
  });

  it('상태 읽기 자체가 실패하면 막는다', async () => {
    let reads = 0;
    mount(ME(), () =>
      ++reads === 1 ? { stt: true, primary: 'main' } : new Response(JSON.stringify({ error: 'down' }), { status: 500 })
    );
    const b = await screen.findByRole('button', { name: '말로 입력' });
    expect(b).not.toHaveAttribute('aria-disabled');
    fireEvent.click(b); // 누르면 상태를 다시 읽는다(M3) — 이번에는 실패
    await waitFor(() => expect(screen.getByRole('button', { name: '말로 입력' })).toHaveAttribute('aria-disabled', 'true'));
  });

  it('내 에이전트 상태에 error 가 있으면 aria-disabled 와 이유, 누르면 상태를 다시 읽는다(11A·M3)', async () => {
    let reads = 0;
    const fn = mount(ME(), () => (reads++, { stt: true, connected: false, primary: 'main', error: 'AI 에이전트 작업공간에 연결할 수 없습니다' }));
    const b = await screen.findByRole('button', { name: '말로 입력' });
    await waitFor(() => expect(b).toHaveAttribute('aria-disabled', 'true'));
    const before = reads;
    fireEvent.click(b);
    await waitFor(() => expect(reads).toBeGreaterThan(before));
    expect(m.getUserMedia).not.toHaveBeenCalled();
    fireEvent.mouseOver(b);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      '내 AI 에이전트 작업공간이 연결되지 않아 말로 입력을 쓸 수 없습니다'
    );
    expect(postedTo(fn, '/api/chat/transcribe')).toHaveLength(0);
  });
});

// 회의실 답 「읽어 주기」(스펙 2026-10-28-012 DD13): 행동 줄 [복사][읽어 주기], 내 에이전트의 주 프로파일로 읽는다
describe('회의실 읽어 주기', () => {
  afterEach(() => resetReadAloud());

  it('에이전트 답 아래에 [복사][읽어 주기]가 있고, 내 에이전트로 /api/chat/speak 를 부른다. 메시지 키는 id 다', async () => {
    resetReadAloud({
      makeAudio: () => ({ src: '', onended: null, onerror: null, play: () => Promise.resolve(), pause: () => undefined }),
      createUrl: () => 'blob:x',
      revokeUrl: () => undefined,
    });
    const fn = stubApi({
      '/api/me': ME(),
      '/api/chat/status': { tts: true, tts_voices: [{ id: 'v1', name: 'v1', gender: 'male' }], primary: 'boss', pod: 'alpha' },
      '/api/chat/speak': () => new Response(new Blob(['mp3']), { status: 200, headers: { 'X-Speak-Parts': '1' } }),
      '/api/office/meeting': { ...VIEW, messages: [{ id: 7, role: 'assistant', author: 'sa', content: '제안서 초안입니다', ts: '2026-10-29T01:00:00Z' }] },
      '/api/office': { seats: [], rooms: [], pods: [], problems: [] },
    });
    mountScreen(<MeetingRoom roomId={1} canAct />, '/office');
    await screen.findByText('제안서 초안입니다');
    expect(screen.getByRole('button', { name: '답변 복사' })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: '읽어 주기' }));
    await waitFor(() => expect(postedTo(fn, '/api/chat/speak')).toHaveLength(1));
    expect(postedTo(fn, '/api/chat/speak')[0]).toMatchObject({ pod: 'alpha', profile: 'boss', text: '제안서 초안입니다', part: 0 });
    expect(readAloud.snap.msg).toBe('7');
  });

  it('tts:false 면 [읽어 주기]가 없다', async () => {
    mount(ME(), { tts: false, primary: 'boss', pod: 'alpha' });
    await screen.findByRole('textbox', { name: '메시지' });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('button', { name: '읽어 주기' })).toBeNull();
  });
});
