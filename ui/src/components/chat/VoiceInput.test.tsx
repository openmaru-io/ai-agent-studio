/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 말로 입력(스펙 2026-10-22-005 §3-10·§3-10-1, §9-5·§11-2 시험 표). 실제 마이크·코덱은 Playwright E2E(R4)가 본다.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeMedia, FakeRecorder, installFakeMedia, uninstallFakeMedia } from '@/test/fakeMedia';
import { postedTo, stubApi } from '@/test/mountScreen';

import { Composer, ComposerProps } from './Composer';
import { pickMime, resetVoice, VoiceTarget } from './VoiceInput';

const VOICE: VoiceTarget = { pod: 'p1', profile: 'main', stt: true };

function Harness(p: Partial<ComposerProps> & { initial?: string; label?: string }) {
  const [v, setV] = useState(p.initial ?? '');
  return (
    <Composer
      value={v}
      onChange={setV}
      onSend={p.onSend ?? (() => undefined)}
      sendOn="enter"
      canSend={!!v.trim()}
      inputLabel={p.label ?? '메시지'}
      sendLabel="보내기"
      voice={VOICE}
      {...p}
    />
  );
}
const box = (name = '메시지') => screen.getByRole('textbox', { name }) as HTMLTextAreaElement;
const mic = () => screen.getByRole('button', { name: '말로 입력' });
const finishBtn = () => screen.getAllByRole('button', { name: '녹음 끝내기' }).at(-1)!;
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

let m: FakeMedia;
beforeEach(() => {
  m = installFakeMedia();
  try {
    localStorage.clear();
  } catch {
    // 없어도 된다
  }
});
afterEach(() => {
  act(() => resetVoice());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  uninstallFakeMedia();
});

async function record() {
  fireEvent.click(mic());
  await screen.findByText(/0:00 \/ 1:00/);
}

describe('VoiceInput 단추 표시', () => {
  it('stt 값이 오기 전·거짓이면 단추가 없고, 참이면 「말로 입력」 단추가 있다(R2·23A)', () => {
    const { rerender } = render(<Harness voice={{ profile: 'main' }} />);
    expect(screen.queryByRole('button', { name: '말로 입력' })).toBeNull();
    rerender(<Harness voice={{ profile: 'main', stt: false }} />);
    expect(screen.queryByRole('button', { name: '말로 입력' })).toBeNull();
    rerender(<Harness voice={{ profile: 'main', stt: true }} />);
    expect(mic()).toBeInTheDocument();
  });

  it('voice 를 주지 않으면 지금과 같다(마이크 없음)', () => {
    render(<Harness voice={undefined} />);
    expect(screen.queryByRole('button', { name: '말로 입력' })).toBeNull();
  });

  it('MediaRecorder 가 없으면 단추가 없다', () => {
    vi.stubGlobal('MediaRecorder', undefined);
    render(<Harness />);
    expect(screen.queryByRole('button', { name: '말로 입력' })).toBeNull();
  });

  it('녹음 형식은 webm/opus → mp4 순서이고 둘 다 없으면 숨긴다(22A)', () => {
    expect(pickMime()).toBe('audio/webm;codecs=opus');
    installFakeMedia({ mimes: ['audio/mp4'] });
    expect(pickMime()).toBe('audio/mp4');
    installFakeMedia({ mimes: [] });
    expect(pickMime()).toBeNull();
    render(<Harness />);
    expect(screen.queryByRole('button', { name: '말로 입력' })).toBeNull();
  });

  it('연결이 끊기면 aria-disabled 와 이유를 보이고, 누르면 녹음하지 않고 상태만 다시 읽는다(11A·M3)', async () => {
    const refresh = vi.fn();
    render(
      <Harness voice={{ ...VOICE, blockedReason: '내 AI 에이전트 작업공간이 연결되지 않아 말로 입력을 쓸 수 없습니다', refresh }} />
    );
    const b = mic();
    expect(b).toHaveAttribute('aria-disabled', 'true');
    expect(b).not.toBeDisabled(); // 포커스를 받아 이유를 들을 수 있게 진짜 disabled 는 쓰지 않는다
    fireEvent.click(b);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(m.getUserMedia).not.toHaveBeenCalled();
    fireEvent.mouseOver(b);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('내 AI 에이전트 작업공간이 연결되지 않아');
  });
});

describe('VoiceInput 자리', () => {
  // 2026-10-23: 마이크는 [첨부] 다음이 아니라 전송 단추 바로 앞(디자인 1A 를 바꿈)
  it('마이크는 전송 단추 바로 앞에 있고 앞쪽(leading) 단추 뒤에 있다', () => {
    render(<Harness leading={<button type="button">첨부</button>} />);
    const buttons = screen.getAllByRole('button');
    const send = buttons.findIndex((b) => b.getAttribute('aria-label') === '보내기');
    expect(buttons[send - 1]).toBe(mic());
    const after = (a: Node, b: Node) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(after(screen.getByRole('button', { name: '첨부' }), mic())).toBe(true);
    // 첨부 바로 옆이 아니라 오른쪽 묶음: 아래 줄의 안내 글(AI 답 주의)보다 뒤다
    expect(after(screen.getByText('AI는 실수를 할 수 있습니다', { exact: false }), mic())).toBe(true);
  });

  it('녹음 중에도 마이크는 전송 단추 바로 앞이고 녹음 띠는 그 앞에 있다', async () => {
    render(<Harness />);
    await record();
    const buttons = screen.getAllByRole('button');
    const send = buttons.findIndex((b) => b.getAttribute('aria-label') === '보내기');
    expect(buttons[send - 1].getAttribute('aria-label')).toBe('녹음 끝내기');
    // 띠(✕ 취소·✓ 끝내기)가 먼저, 그다음 마이크 자리 단추 — 「녹음 끝내기」 둘 다 취소 단추 뒤다
    const cancel = screen.getByRole('button', { name: '녹음 취소' });
    for (const b of screen.getAllByRole('button', { name: '녹음 끝내기' }))
      expect(!!(cancel.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });
});

describe('VoiceInput 녹음과 받아쓰기', () => {
  it('녹음 → 끝내기 → 받은 글이 커서 자리에 공백 하나와 함께 들어가고 마이크 트랙이 멈춘다', async () => {
    const fn = stubApi({ '/api/chat/transcribe': { transcript: '안녕하세요' } });
    const refresh = vi.fn();
    render(<Harness initial="메모" voice={{ ...VOICE, refresh }} />);
    fireEvent.click(mic());
    expect(m.audioContexts).toHaveLength(1); // 첫 await 전에 만든다(M5)
    expect(m.audioContexts[0].resume).toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
    await screen.findByText('0:00 / 1:00');
    expect(m.recorders[0].options).toEqual({ mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 32000 });
    expect(screen.queryByText('AI는 실수를 할 수 있습니다', { exact: false })).toBeNull(); // 띠가 아래 줄 가운데를 대신한다(1A)
    fireEvent.click(finishBtn());
    await waitFor(() => expect(box()).toHaveValue('메모 안녕하세요'));
    expect(m.tracks[0].stop).toHaveBeenCalled();
    const [body] = postedTo(fn, '/api/chat/transcribe');
    expect(body).toMatchObject({ pod: 'p1', profile: 'main', mime_type: 'audio/webm', seconds: 1 });
    expect(String(body.data_url)).toMatch(/^data:audio\/webm;base64,/);
    expect(await screen.findByText('받아쓴 글을 확인하고 Enter 로 보내세요')).toBeInTheDocument();
  });

  it('mp4 만 되는 브라우저는 audio/mp4 로 보낸다(22A)', async () => {
    installFakeMedia({ mimes: ['audio/mp4'] });
    const fn = stubApi({ '/api/chat/transcribe': { transcript: '네' } });
    render(<Harness />);
    await record();
    fireEvent.click(finishBtn());
    await waitFor(() => expect(box()).toHaveValue('네'));
    expect(postedTo(fn, '/api/chat/transcribe')[0].mime_type).toBe('audio/mp4');
  });

  it('선택 영역이 있으면 덮어쓰지 않고 선택 끝에 넣는다(17A, 대안 넣기 경로 E4)', async () => {
    stubApi({ '/api/chat/transcribe': { transcript: '둘' } });
    render(<Harness initial="하나 셋" />);
    box().setSelectionRange(0, 2);
    fireEvent.select(box());
    await record();
    fireEvent.click(finishBtn());
    await waitFor(() => expect(box()).toHaveValue('하나 둘 셋'));
    expect(box().selectionStart).toBe(4); // 넣은 글 끝
    expect(document.activeElement).toBe(box()); // 포커스를 돌려준다
  });

  it('빈 글이면 「말소리를 알아듣지 못했습니다」를 4초 보이고 입력칸은 그대로다(4A)', async () => {
    stubApi({ '/api/chat/transcribe': { transcript: '' } });
    render(<Harness initial="그대로" />);
    await record();
    fireEvent.click(finishBtn());
    expect(await screen.findByText('말소리를 알아듣지 못했습니다')).toBeInTheDocument();
    expect(box()).toHaveValue('그대로');
    await waitFor(() => expect(screen.queryByText('말소리를 알아듣지 못했습니다')).toBeNull(), { timeout: 5000 });
  });

  // 서버가 무음 환각(「감사합니다」·「안녕하세요」)을 거를 때 쓰는 값(스펙 2026-10-22-005 §8-12, 사용자 결정 2026-10-23 A)
  it('녹음 중 소리가 들렸는지(heard)를 함께 보낸다', async () => {
    const fn = stubApi({ '/api/chat/transcribe': { transcript: '가' } });
    render(<Harness />);
    await record();
    await new Promise((r) => setTimeout(r, 250)); // 음량 재기(100ms 마다)가 한 번 이상 돌게
    fireEvent.click(finishBtn());
    await waitFor(() => expect(box()).toHaveValue('가'));
    expect(postedTo(fn, '/api/chat/transcribe')[0].heard).toBe(true);
  });

  it('무음이면 heard 가 거짓이다', async () => {
    m.level = 0;
    const fn = stubApi({ '/api/chat/transcribe': { transcript: '', silent: true } });
    render(<Harness />);
    await record();
    await new Promise((r) => setTimeout(r, 250));
    fireEvent.click(finishBtn());
    expect(await screen.findByText('말소리를 알아듣지 못했습니다')).toBeInTheDocument();
    expect(postedTo(fn, '/api/chat/transcribe')[0].heard).toBe(false);
  });

  it('음량을 잴 수 없는 브라우저는 heard 를 보내지 않는다(서버가 들은 것으로 본다)', async () => {
    vi.stubGlobal('AudioContext', undefined);
    const fn = stubApi({ '/api/chat/transcribe': { transcript: '감사합니다' } });
    render(<Harness />);
    await record();
    fireEvent.click(finishBtn());
    await waitFor(() => expect(box()).toHaveValue('감사합니다'));
    expect(postedTo(fn, '/api/chat/transcribe')[0]).not.toHaveProperty('heard');
  });

  it('첫 사용 안내는 처음 3번만 보인다(8A)', async () => {
    stubApi({ '/api/chat/transcribe': { transcript: '가' } });
    localStorage.setItem('aas-voice-hint-count', '3');
    render(<Harness />);
    await record();
    fireEvent.click(finishBtn());
    await waitFor(() => expect(box()).toHaveValue('가'));
    expect(screen.queryByText('받아쓴 글을 확인하고 Enter 로 보내세요')).toBeNull();
  });
});

describe('VoiceInput 취소·Esc', () => {
  it('녹음 중 Esc 는 요청을 보내지 않고 녹음을 버린다(14A)', async () => {
    const fn = stubApi({ '/api/chat/transcribe': { transcript: '안 와야 함' } });
    render(<Harness />);
    await record();
    fireEvent.keyDown(box(), { key: 'Escape' });
    await flush();
    expect(postedTo(fn, '/api/chat/transcribe')).toHaveLength(0);
    expect(m.tracks[0].stop).toHaveBeenCalled();
    expect(screen.queryByText('0:00 / 1:00')).toBeNull();
  });

  it('한글 조합 중 Esc 와 다른 대화상자가 열린 동안의 Esc 는 가로채지 않는다(E2·M6)', async () => {
    render(<Harness />);
    await record();
    fireEvent.keyDown(box(), { key: 'Escape', isComposing: true });
    expect(screen.getByText('0:00 / 1:00')).toBeInTheDocument();
    const dlg = document.createElement('div');
    dlg.className = 'MuiModal-root';
    document.body.appendChild(dlg);
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(screen.getByText('0:00 / 1:00')).toBeInTheDocument();
    dlg.remove();
  });

  it('「/」 고르기 목록이 열려 있으면 Esc 는 목록만 닫고 녹음은 남는다(E2)', async () => {
    render(
      <Harness
        initial="/"
        suggest={[
          {
            trigger: '/',
            where: 'start',
            title: '스킬',
            items: [{ value: '/요약', label: '요약' }],
            noMatchText: '없음',
            countText: (n) => `${n}개`,
          },
        ]}
      />
    );
    fireEvent.focus(box());
    box().setSelectionRange(1, 1);
    fireEvent.select(box());
    expect(await screen.findByRole('listbox')).toBeInTheDocument();
    await record();
    fireEvent.keyDown(box(), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(screen.getByText('0:00 / 1:00')).toBeInTheDocument();
    fireEvent.keyDown(box(), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('0:00 / 1:00')).toBeNull());
  });

  it('받아쓰는 중 ✕ 는 요청을 중단하고 결과를 버린다(2A)', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Promise(() => undefined);
      })
    );
    render(<Harness />);
    await record();
    fireEvent.click(finishBtn());
    expect(await screen.findByText('받아쓰는 중…')).toBeInTheDocument();
    await waitFor(() => expect(signal).toBeDefined());
    fireEvent.click(screen.getAllByRole('button', { name: '받아쓰기 취소' }).at(-1)!);
    expect(signal?.aborted).toBe(true);
    expect(screen.queryByText('받아쓰는 중…')).toBeNull();
  });

  it('대화 상대를 바꾸면 녹음을 버리고 늦게 온 결과는 넣지 않는다(21A)', async () => {
    let answer: (r: Response) => void = () => undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((r) => (answer = r)))
    );
    const { rerender } = render(<Harness />);
    await record();
    fireEvent.click(finishBtn());
    await screen.findByText('받아쓰는 중…');
    rerender(<Harness voice={{ ...VOICE, profile: 'other' }} />);
    await act(async () => answer(new Response(JSON.stringify({ transcript: '늦은 글' }), { status: 200 })));
    await flush();
    expect(box()).toHaveValue('');
    expect(m.tracks[0].stop).toHaveBeenCalled();
  });
});

describe('VoiceInput 같은 프로파일의 대화 바꾸기', () => {
  it('프로파일이 같아도 대화(conversation)가 바뀌면 녹음을 버리고 마이크를 닫는다(21A)', async () => {
    const fn = stubApi({ '/api/chat/transcribe': { transcript: '안 와야 함' } });
    const { rerender } = render(<Harness voice={{ ...VOICE, conversation: 'c1' }} />);
    await record();
    rerender(<Harness voice={{ ...VOICE, conversation: 'c2' }} />);
    await flush();
    expect(screen.queryByText('0:00 / 1:00')).toBeNull();
    expect(m.tracks[0].stop).toHaveBeenCalled();
    expect(postedTo(fn, '/api/chat/transcribe')).toHaveLength(0);
  });
});

describe('VoiceInput 오류·다시 시도', () => {
  it('MediaRecorder.start() 가 던지면 마이크·AudioContext 를 닫고 마이크 오류를 보인다(처리되지 않은 거절 없음)', async () => {
    const spy = vi.spyOn(FakeRecorder.prototype, 'start').mockImplementationOnce(() => {
      throw Object.assign(new Error('nope'), { name: 'NotSupportedError' });
    });
    render(<Harness />);
    fireEvent.click(mic());
    expect(await screen.findByText('마이크를 열지 못했습니다')).toHaveAttribute('role', 'status');
    expect(m.tracks[0].stop).toHaveBeenCalled();
    expect(m.audioContexts[0].close).toHaveBeenCalled();
    expect(screen.queryByText('0:00 / 1:00')).toBeNull();
    spy.mockRestore();
  });

  const failWith = (status: number, error?: string) =>
    stubApi({
      '/api/chat/transcribe': () =>
        new Response(JSON.stringify(error === undefined ? {} : { error }), { status, statusText: 'Status Text' }),
    });

  it('413 은 서버 글(too large) 대신 「녹음이 너무 깁니다」를 보이고 다시 시도는 없다', async () => {
    failWith(413, 'too large');
    render(<Harness />);
    await record();
    fireEvent.click(finishBtn());
    expect(await screen.findByText('녹음이 너무 깁니다. 짧게 나눠 말해 주세요')).toBeInTheDocument();
    expect(screen.queryByText('too large')).toBeNull();
    expect(screen.queryByRole('button', { name: '다시 시도' })).toBeNull();
  });

  it.each([
    [502, '음성 인식을 쓸 수 없습니다. 관리자에게 음성 인식 설정을 확인해 달라고 하세요'],
    [400, '녹음 형식이 올바르지 않습니다'],
    [403, '권한이 없습니다'],
  ])('%i 은 서버 문구를 보이고 다시 시도는 없다', async (status, text) => {
    failWith(status, text);
    render(<Harness />);
    await record();
    fireEvent.click(finishBtn());
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '다시 시도' })).toBeNull();
  });

  it.each([
    [503, '에이전트에 연결할 수 없어 받아쓰지 못했습니다'],
    [504, '받아쓰기가 시간 안에 끝나지 않았습니다'],
  ])('%i 은 서버 문구와 [다시 시도]를 보인다', async (status, text) => {
    failWith(status, text);
    render(<Harness />);
    await record();
    fireEvent.click(finishBtn());
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeInTheDocument();
  });

  it('본문에 error 가 없는 5xx 는 statusText 대신 우리 문구를 보인다', async () => {
    failWith(504);
    render(<Harness />);
    await record();
    fireEvent.click(finishBtn());
    expect(await screen.findByText('받아쓰지 못했습니다. 다시 시도를 눌러 주세요')).toBeInTheDocument();
    expect(screen.queryByText('Status Text')).toBeNull();
  });

  it('네트워크 오류는 [다시 시도]를 보인다', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    render(<Harness />);
    await record();
    fireEvent.click(finishBtn());
    expect(await screen.findByText('받아쓰지 못했습니다. 다시 시도를 눌러 주세요')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeInTheDocument();
  });


  it.each([
    ['NotAllowedError', '주소창 왼쪽의 사이트 정보 아이콘에서 마이크를 허용하세요'],
    ['NotFoundError', '마이크를 찾지 못했습니다'],
    ['NotReadableError', '다른 프로그램이 마이크를 쓰고 있습니다'],
  ])('마이크 오류 %s 는 그 안내를 보인다(5A)', async (name, text) => {
    m.fail = name;
    render(<Harness />);
    fireEvent.click(mic());
    expect(await screen.findByText(text)).toHaveAttribute('role', 'status');
    expect(m.recorders).toHaveLength(0);
  });

  it('권한을 묻는 동안 안내를 보이고 타이머는 허용 뒤부터 센다(5A)', async () => {
    m.holdPermission = true;
    render(<Harness />);
    fireEvent.click(mic());
    expect(await screen.findByText('브라우저 알림에서 마이크를 허용하세요')).toBeInTheDocument();
    await act(async () => m.release());
    await screen.findByText('0:00 / 1:00');
    expect(screen.queryByText('브라우저 알림에서 마이크를 허용하세요')).toBeNull();
  });

  it('429 면 녹음을 두고 다시 시도로 같은 소리를 다시 보낸다(3A·R10)', async () => {
    let n = 0;
    const fn = stubApi({
      '/api/chat/transcribe': () =>
        ++n === 1 ? new Response(JSON.stringify({ error: '지금 받아쓰기가 많습니다. 다시 시도를 눌러 주세요' }), { status: 429 }) : { transcript: '두 번째' },
    });
    const refresh = vi.fn();
    render(<Harness voice={{ ...VOICE, refresh }} />);
    await record();
    fireEvent.click(finishBtn());
    expect(await screen.findByText('지금 받아쓰기가 많습니다. 다시 시도를 눌러 주세요')).toBeInTheDocument();
    refresh.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(refresh).toHaveBeenCalled(); // 다시 시도도 연결 상태를 다시 읽는다(M3)
    await waitFor(() => expect(box()).toHaveValue('두 번째'));
    const sent = postedTo(fn, '/api/chat/transcribe');
    expect(sent).toHaveLength(2);
    expect(sent[1].data_url).toBe(sent[0].data_url);
  });

  it('녹음 중 연결이 끊기면 녹음을 들고 「연결되면 다시 시도」를 보인다(3A)', async () => {
    const fn = stubApi({ '/api/chat/transcribe': { transcript: '연결 뒤' } });
    const { rerender } = render(<Harness />);
    await record();
    rerender(<Harness voice={{ ...VOICE, blockedReason: '끊김' }} />);
    expect(await screen.findByText('AI 에이전트 작업공간 연결이 끊겼습니다. 연결되면 다시 시도를 눌러 주세요')).toBeInTheDocument();
    expect(m.tracks[0].stop).toHaveBeenCalled();
    expect(postedTo(fn, '/api/chat/transcribe')).toHaveLength(0);
    rerender(<Harness voice={VOICE} />);
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    await waitFor(() => expect(box()).toHaveValue('연결 뒤'));
  });
});

describe('VoiceInput 시간·음량', () => {
  it('처음 3초 무음 경고, 50초 예고, 60초에 저절로 끝내고 받아쓴다(6A·7A)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    m.level = 0;
    const fn = stubApi({ '/api/chat/transcribe': { transcript: '끝' } });
    render(<Harness />);
    await record();
    await act(async () => void (await vi.advanceTimersByTimeAsync(3200)));
    expect(screen.getByText('소리가 들리지 않습니다. 마이크를 확인하세요')).toBeInTheDocument();
    await act(async () => void (await vi.advanceTimersByTimeAsync(47000)));
    expect(screen.getByText('10초 남았습니다', { exact: false })).toBeInTheDocument(); // 화면 읽기 알림
    await act(async () => void (await vi.advanceTimersByTimeAsync(10000)));
    vi.useRealTimers();
    await waitFor(() => expect(box()).toHaveValue('끝'));
    expect(postedTo(fn, '/api/chat/transcribe')).toHaveLength(1);
  });
});

describe('VoiceInput 보내기 막기·조합·녹음기 하나', () => {
  it('녹음·받아쓰는 동안 Enter 와 단추로 보내지 않고 이유를 띠 아래에 보인다(16A·E3)', async () => {
    const onSend = vi.fn();
    render(<Harness initial="보낼 글" onSend={onSend} />);
    await record();
    expect(screen.getByRole('button', { name: '보내기' })).toBeDisabled();
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByText('받아쓰기가 끝나면 보낼 수 있습니다')).toBeInTheDocument();
    // 조합이 끝난 뒤 늦게 보내는 길도 막는다
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true });
    fireEvent.compositionEnd(box());
    await new Promise((r) => setTimeout(r, 50));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('한글 조합 중에 도착한 글은 조합이 끝난 뒤 넣는다(15A)', async () => {
    stubApi({ '/api/chat/transcribe': { transcript: '받은 글' } });
    render(<Harness initial="가" />);
    await record();
    fireEvent.compositionStart(box());
    fireEvent.click(finishBtn());
    await screen.findByText('받아쓴 글을 확인하고 Enter 로 보내세요');
    expect(box()).toHaveValue('가');
    fireEvent.compositionEnd(box());
    await waitFor(() => expect(box()).toHaveValue('가 받은 글'));
  });

  it('녹음기는 하나다: 다른 입력칸의 마이크는 이유와 함께 막히고 결과는 시작한 칸에만 들어간다(20A)', async () => {
    stubApi({ '/api/chat/transcribe': { transcript: '첫 칸' } });
    render(
      <>
        <Harness label="A" />
        <Harness label="B" />
      </>
    );
    fireEvent.click(screen.getAllByRole('button', { name: '말로 입력' })[0]);
    await screen.findByText('0:00 / 1:00');
    const other = screen.getByRole('button', { name: '말로 입력' });
    expect(other).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(other);
    expect(m.getUserMedia).toHaveBeenCalledTimes(1);
    fireEvent.click(finishBtn());
    await waitFor(() => expect(box('A')).toHaveValue('첫 칸'));
    expect(box('B')).toHaveValue('');
  });

  it('녹음을 시작·끝내면 화면 읽기 알림을 하고 경과 시간은 aria-hidden 이다(18A)', async () => {
    stubApi({ '/api/chat/transcribe': { transcript: '가' } });
    render(<Harness />);
    await record();
    expect(screen.getByText('녹음을 시작했습니다', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('0:00 / 1:00')).toHaveAttribute('aria-hidden', 'true');
    expect(box().getAttribute('aria-describedby')).toBeTruthy();
    fireEvent.click(finishBtn());
    expect(await screen.findByText('받아쓴 글을 입력칸에 넣었습니다', { exact: false })).toBeInTheDocument();
  });
});
