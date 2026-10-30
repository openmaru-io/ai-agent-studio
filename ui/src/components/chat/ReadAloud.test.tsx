/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 답 「읽어 주기」 화면(스펙 2026-10-28-012 §3-9-1 상태표·§7-1): tts 값에 따른 단추, 상태별 이름·문구, 녹음 중 막힘,
// 행동 줄 고정(pinActions), 읽는 중 띠의 멈추기·Esc, 녹음 시작 때 읽기 멈춤, 재생 상태 키.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installFakeMedia, uninstallFakeMedia } from '@/test/fakeMedia';

import { Composer } from './Composer';
import { MessageRow } from './MessageRow';
import { answerKeys, ReadAloudButton, readPinned, ReadTarget, useReadScope, useReadSnap } from './ReadAloud';
import { AudioLike, readAloud, resetReadAloud } from './readAloudPlayer';
import { resetVoice, voiceRecorder } from './VoiceInput';

const ON: ReadTarget = { pod: 'p1', profile: 'main', tts: true, voices: [{ id: 'v1', name: { ko: '차분한 여성', en: 'Calm female' }, gender: 'female' }] };

let resolvers: ((r: Response) => void)[];
let bodies: Record<string, unknown>[];
const audio: AudioLike & { end(): void } = {
  src: '',
  onended: null,
  onerror: null,
  play: () => Promise.resolve(),
  pause: () => undefined,
  end() {
    this.onended?.();
  },
};
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
async function answer(r: Response) {
  await act(async () => {
    resolvers.shift()!(r);
    await new Promise((x) => setTimeout(x, 0));
    await new Promise((x) => setTimeout(x, 0));
  });
}
const ok = (parts: number, extra: Record<string, string> = {}) =>
  new Response(new Blob(['mp3']), { status: 200, headers: { 'X-Speak-Parts': String(parts), ...extra } });

beforeEach(() => {
  resolvers = [];
  bodies = [];
  resetReadAloud({
    fetch: (_u, init) =>
      new Promise<Response>((resolve, reject) => {
        bodies.push(JSON.parse(String(init.body)));
        (init.signal as AbortSignal).addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        resolvers.push(resolve);
      }),
    makeAudio: () => audio,
    createUrl: () => 'blob:x',
    revokeUrl: () => undefined,
  });
});
afterEach(() => {
  act(() => {
    resetReadAloud();
    resetVoice();
  });
  vi.useRealTimers();
});

function Row({ target = ON, conv = 'c1', msg = 'm1', text = '답 글', streaming }: { target?: ReadTarget; conv?: string; msg?: string; text?: string; streaming?: boolean }) {
  const rs = useReadSnap();
  return (
    <MessageRow
      side="agent"
      pinActions={readPinned(rs, conv, msg)}
      actions={<ReadAloudButton target={target} conv={conv} msg={msg} name="main" text={text} streaming={streaming} />}
    >
      <p>{text}</p>
    </MessageRow>
  );
}

const actionsOf = (el: HTMLElement) => el.closest('.chat-row')!.querySelector('.chat-row-actions') as HTMLElement;

describe('[읽어 주기] 단추', () => {
  it('tts:true 면 단추가 있고, false·값이 오기 전·대상이 없으면(내 에이전트 없음) 그리지 않는다', () => {
    const { rerender } = render(<Row />);
    expect(screen.getByRole('button', { name: '읽어 주기' })).toBeInTheDocument();
    rerender(<Row target={{ ...ON, tts: false }} />);
    expect(screen.queryByRole('button', { name: '읽어 주기' })).toBeNull();
    rerender(<Row target={{ ...ON, tts: undefined }} />);
    expect(screen.queryByRole('button', { name: '읽어 주기' })).toBeNull();
    rerender(<ReadAloudButton target={undefined} conv="c1" msg="m1" name="main" text="답 글" />);
    expect(screen.queryByRole('button', { name: '읽어 주기' })).toBeNull();
  });

  it('누르면 답 전체·조각 0·고른 목소리로 요청하고, 준비 → 재생 → 끝 순으로 이름이 바뀐다. 준비·재생 중에는 행동 줄을 늘 보인다(DD3)', async () => {
    render(<Row />);
    const row = screen.getByText('답 글');
    expect(getComputedStyle(actionsOf(row)).opacity).toBe('0');
    fireEvent.click(screen.getByRole('button', { name: '읽어 주기' }));
    expect(bodies[0]).toEqual({ pod: 'p1', profile: 'main', text: '답 글', voice: 'v1', part: 0 });
    expect(screen.getByRole('button', { name: '읽을 준비 중 · 누르면 취소' })).toBeInTheDocument();
    expect(getComputedStyle(actionsOf(row)).opacity).toBe('1');
    await answer(ok(1));
    expect(screen.getByRole('button', { name: '읽기 멈추기' })).toBeInTheDocument();
    act(() => audio.end());
    expect(screen.getByRole('button', { name: '읽어 주기' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull(); // 끝은 조용히(DD8)
    expect(getComputedStyle(actionsOf(row)).opacity).toBe('0');
  });

  it('준비가 3초를 넘으면 「준비하는 중…」, 잘렸으면 「앞부분 약 15분만 읽습니다」', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Row />);
    fireEvent.click(screen.getByRole('button', { name: '읽어 주기' }));
    await act(async () => void (await vi.advanceTimersByTimeAsync(3000)));
    expect(screen.getByRole('status')).toHaveTextContent('준비하는 중…');
    await answer(ok(2, { 'X-Speak-Truncated': '1' }));
    expect(screen.getByRole('status')).toHaveTextContent('앞부분 약 15분만 읽습니다');
    expect(screen.getByRole('status')).toHaveAttribute('title', '앞부분 약 15분만 읽습니다');
  });

  it('204 면 「읽을 글이 없습니다」를 4초 보인다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Row />);
    fireEvent.click(screen.getByRole('button', { name: '읽어 주기' }));
    await answer(new Response(null, { status: 204, headers: { 'X-Speak-Parts': '0' } }));
    expect(screen.getByRole('status')).toHaveTextContent('읽을 글이 없습니다');
    await act(async () => void (await vi.advanceTimersByTimeAsync(4000)));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('실패면 호박색 「읽어 주지 못했습니다」 + [다시 시도], 누르면 실패한 조각부터 다시 요청한다', async () => {
    render(<Row />);
    fireEvent.click(screen.getByRole('button', { name: '읽어 주기' }));
    await answer(new Response('{}', { status: 502 }));
    const st = screen.getByRole('status');
    expect(st).toHaveTextContent('읽어 주지 못했습니다');
    expect(getComputedStyle(st).color).not.toMatch(/rgb\(2[0-9]{2}, [0-9]{1,2}, [0-9]{1,2}\)/); // 빨강이 아니다(DD6)
    expect(screen.getByRole('button', { name: '읽어 주기' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(bodies.at(-1)).toMatchObject({ part: 0 });
  });

  it('429 자동 다시 시도도 실패하면 「지금 읽기 요청이 많습니다」 + [다시 시도]', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Row />);
    fireEvent.click(screen.getByRole('button', { name: '읽어 주기' }));
    for (let i = 0; i < 9; i++) {
      await answer(new Response('{"busy":"user"}', { status: 429 }));
      await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
    }
    expect(screen.getByRole('status')).toHaveTextContent('지금 읽기 요청이 많습니다');
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeInTheDocument();
  });

  it('녹음·받아쓰는 동안은 aria-disabled 와 이유 툴팁으로 막는다(DD9)', async () => {
    installFakeMedia();
    try {
      render(<Row />);
      await act(async () => void (await voiceRecorder.start('o1', { profile: 'main' }, () => undefined)));
      const btn = screen.getByRole('button', { name: '읽어 주기' });
      expect(btn).toHaveAttribute('aria-disabled', 'true');
      fireEvent.click(btn);
      expect(bodies).toHaveLength(0);
      fireEvent.mouseOver(btn);
      expect(await screen.findByRole('tooltip')).toHaveTextContent('녹음 중에는 읽어 줄 수 없습니다');
    } finally {
      act(() => resetVoice());
      uninstallFakeMedia();
    }
  });

  it('녹음을 시작하면 읽기를 곧바로 멈춘다(녹음이 이긴다)', async () => {
    installFakeMedia();
    try {
      render(<Row />);
      fireEvent.click(screen.getByRole('button', { name: '읽어 주기' }));
      expect(readAloud.active()).toBe(true);
      await act(async () => void (await voiceRecorder.start('o1', { profile: 'main' }, () => undefined)));
      expect(readAloud.snap.phase).toBe('idle');
    } finally {
      act(() => resetVoice());
      uninstallFakeMedia();
    }
  });

  it('답이 아직 만들어지는 중이면 막는다', () => {
    render(<Row streaming />);
    const btn = screen.getByRole('button', { name: '읽어 주기' });
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(btn);
    expect(bodies).toHaveLength(0);
  });

  it('재생 상태 키는 (대화, 메시지)라 같은 자리에 다른 답이 그려져도 상태가 붙지 않는다(F11)', () => {
    const { rerender } = render(<Row msg="m1" />);
    fireEvent.click(screen.getByRole('button', { name: '읽어 주기' }));
    rerender(<Row msg="m2" text="다른 답" />);
    expect(screen.getByRole('button', { name: '읽어 주기' })).toBeInTheDocument();
    rerender(<Row conv="c2" msg="m1" />);
    expect(screen.getByRole('button', { name: '읽어 주기' })).toBeInTheDocument();
  });

  it('answerKeys: 같은 글은 같은 키, 같은 글이 두 번이면 순서로 가른다', () => {
    const [a, b, c] = answerKeys(['가', '나', '가']);
    expect(answerKeys(['가'])[0]).toBe(a);
    expect(b).not.toBe(a);
    expect(c).not.toBe(a);
  });
});

function Box1({ conv = 'c1' }: { conv?: string }) {
  const [v, setV] = useState('');
  useReadScope(conv); // 화면(대화 목록)이 하는 일
  return (
    <>
      <Row conv={conv} />
      <Composer value={v} onChange={setV} onSend={() => undefined} sendOn="enter" canSend={false} inputLabel="메시지" sendLabel="보내기" hint="Enter 로 보내기" readConv={conv} />
    </>
  );
}

describe('읽는 중 띠(DD4·DD21)', () => {
  it('읽는 동안 입력칸 아래 줄의 키 안내를 띠가 대신하고, [멈추기]로 멈춘다', async () => {
    render(<Box1 />);
    expect(screen.getByText('Enter 로 보내기')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '읽어 주기' }));
    expect(screen.getByText('main의 답 읽는 중')).toBeInTheDocument();
    expect(screen.queryByText('Enter 로 보내기')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '멈추기' }));
    expect(readAloud.snap.phase).toBe('idle');
    expect(screen.getByText('Enter 로 보내기')).toBeInTheDocument();
  });

  it('「{에이전트}의 답」을 누르면 읽는 답의 행으로 스크롤하고 포커스를 준다', async () => {
    const spy = vi.fn();
    Element.prototype.scrollIntoView = spy;
    render(<Box1 />);
    fireEvent.click(screen.getByRole('button', { name: '읽어 주기' }));
    fireEvent.click(screen.getByRole('button', { name: 'main의 답으로 가기' }));
    expect(spy).toHaveBeenCalled();
    expect(document.activeElement?.classList.contains('chat-row')).toBe(true);
  });

  it('Esc 는 읽기를 멈춘다(서랍·창 닫기보다 먼저)', async () => {
    const outer = vi.fn();
    window.addEventListener('keydown', outer);
    try {
      render(<Box1 />);
      fireEvent.click(screen.getByRole('button', { name: '읽어 주기' }));
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(readAloud.snap.phase).toBe('idle');
      expect(outer).not.toHaveBeenCalled();
      fireEvent.keyDown(window, { key: 'Escape' }); // 멈춘 뒤에는 다음 Esc 가 서랍·창으로 간다
      expect(outer).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', outer);
    }
  });

  it('입력칸을 내리면(대화 바꾸기·창 닫기) 읽기를 멈추고 진행 중 요청을 끊는다', async () => {
    let aborted = false;
    resetReadAloud({
      fetch: (_u, init) =>
        new Promise<Response>(() => {
          (init.signal as AbortSignal).addEventListener('abort', () => (aborted = true));
        }),
    });
    const { rerender } = render(<Box1 />);
    fireEvent.click(screen.getByRole('button', { name: '읽어 주기' }));
    await flush();
    expect(readAloud.active()).toBe(true);
    rerender(<Box1 conv="c2" />);
    expect(readAloud.snap.phase).toBe('idle');
    expect(aborted).toBe(true);
  });

  it('탭이 숨겨져도 계속 읽는다', () => {
    render(<Box1 />);
    fireEvent.click(screen.getByRole('button', { name: '읽어 주기' }));
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(readAloud.active()).toBe(true);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });
});
