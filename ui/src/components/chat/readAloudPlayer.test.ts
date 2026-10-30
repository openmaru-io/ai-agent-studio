/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 「읽어 주기」 재생기(스펙 2026-10-28-012 §3-9·§3-9-1·§7-1 화면 시험): 차례대로 받기·두 조각 앞서 받기(D21)·429 다시 시도(D18·D19)·
// 멈춤의 요청 중단·실패한 조각부터 다시 시도(DD7)·204·잘림. 실제 소리는 단계 7 Playwright 가 본다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AudioLike, EMPTY_MS, FIRST_RETRIES, ReadAloudPlayer, RETRY_MS, SLOW_MS, SpeakRequest } from './readAloudPlayer';

interface Call {
  part: number;
  body: Record<string, unknown>;
  signal: AbortSignal;
  resolve: (r: Response) => void;
  reject: (e: unknown) => void;
}

class FakeAudio implements AudioLike {
  src = '';
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  plays: string[] = [];
  paused = 0;
  play() {
    this.plays.push(this.src);
    return Promise.resolve();
  }
  pause() {
    this.paused++;
  }
  /** 지금 조각 재생이 끝났다 */
  end() {
    this.onended?.();
  }
}

const REQ: SpeakRequest = { conv: 'c1', msg: 'm1', name: 'main', pod: 'p1', profile: 'main', text: '답 전체', voice: 'ko-female-calm-a' };

const ok = (part: number, parts: number, extra: Record<string, string> = {}) =>
  new Response(new Blob([`mp3-${part}`], { type: 'audio/mpeg' }), { status: 200, headers: { 'X-Speak-Parts': String(parts), ...extra } });
const status = (code: number) => new Response(code === 204 ? null : '{}', { status: code, headers: code === 204 ? { 'X-Speak-Parts': '0' } : {} });

let calls: Call[];
let audio: FakeAudio;
let revoked: string[];
let p: ReadAloudPlayer;
const tick = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  revoked = [];
  audio = new FakeAudio();
  let n = 0;
  p = new ReadAloudPlayer({
    fetch: (_url, init) =>
      new Promise<Response>((resolve, reject) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        const signal = init.signal as AbortSignal;
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        calls.push({ part: Number(body.part), body, signal, resolve, reject });
      }),
    makeAudio: () => audio,
    createUrl: () => `blob:${++n}`,
    revokeUrl: (u) => void revoked.push(u),
  });
});
afterEach(() => {
  p.stop();
  vi.useRealTimers();
});

/** 마지막 요청에 답하고 비동기 처리를 흘려보낸다 */
async function answer(r: Response) {
  calls[calls.length - 1].resolve(r);
  await tick();
  await tick();
}

describe('읽어 주기 재생기', () => {
  it('클릭 처리 안에서 첫 요청 전에 같은 <audio> 로 무음을 틀어 Safari 잠금을 푼다(OV-M6)', () => {
    p.press(REQ);
    expect(audio.plays[0]).toMatch(/^data:audio\/wav;base64,/);
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ pod: 'p1', profile: 'main', text: '답 전체', voice: 'ko-female-calm-a', part: 0 });
    expect(p.snap.phase).toBe('preparing');
  });

  it('조각 0 을 받으면 재생하고, X-Speak-Parts 대로 번호를 올리며 하나씩 요청한다. 재생 중 조각 뒤로 두 조각까지만 받아 둔다(D21)', async () => {
    p.press(REQ);
    await answer(ok(0, 5));
    expect(p.snap.phase).toBe('playing');
    expect(audio.src).toMatch(/^blob:1/);
    // 요청은 하나씩: 조각 1 을 받기 전에는 조각 2 를 요청하지 않는다
    expect(calls.map((c) => c.part)).toEqual([0, 1]);
    await answer(ok(1, 5));
    expect(calls.map((c) => c.part)).toEqual([0, 1, 2]);
    await answer(ok(2, 5));
    // 조각 0 재생 중, 1·2 를 받아 둠 → 3 은 아직 요청하지 않는다
    expect(calls.map((c) => c.part)).toEqual([0, 1, 2]);
    audio.end(); // 0 끝 → 1 재생, 3 요청
    await tick();
    expect(audio.src).toMatch(/^blob:2/);
    expect(calls.map((c) => c.part)).toEqual([0, 1, 2, 3]);
    expect(revoked).toContain('blob:1');
  });

  it('짧은 조각 뒤 긴 조각: 받아 둔 조각으로 이어 재생해 빈틈이 없다', async () => {
    p.press(REQ);
    await answer(ok(0, 3));
    await answer(ok(1, 3));
    await answer(ok(2, 3));
    audio.end();
    await tick();
    expect(p.snap.phase).toBe('playing');
    expect(audio.src).toMatch(/^blob:2/);
    audio.end();
    await tick();
    expect(audio.src).toMatch(/^blob:3/);
  });

  it('마지막 조각이 끝나면 문구 없이 대기로 돌아가고 화면 읽기에만 「읽기를 마쳤습니다」를 알린다(DD8)', async () => {
    p.press(REQ);
    await answer(ok(0, 1));
    audio.end();
    await tick();
    expect(p.snap.phase).toBe('idle');
    expect(p.snap.announce).toMatchObject({ text: '읽기를 마쳤습니다', conv: 'c1' });
  });

  it('3초가 지나도 첫 조각이 없으면 「준비하는 중…」 표시(slow)', async () => {
    p.press(REQ);
    await vi.advanceTimersByTimeAsync(SLOW_MS - 1);
    expect(p.snap.slow).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(p.snap.slow).toBe(true);
    await answer(ok(0, 1));
    expect(p.snap).toMatchObject({ phase: 'playing', slow: false });
  });

  it('204 면 「읽을 글이 없습니다」 상태를 4초 보이고 대기로', async () => {
    p.press(REQ);
    await answer(status(204));
    expect(p.snap.phase).toBe('empty');
    await vi.advanceTimersByTimeAsync(EMPTY_MS);
    expect(p.snap.phase).toBe('idle');
  });

  it('X-Speak-Truncated: 1 이면 재생 내내 잘림 표시', async () => {
    p.press(REQ);
    await answer(ok(0, 2, { 'X-Speak-Truncated': '1' }));
    expect(p.snap).toMatchObject({ phase: 'playing', truncated: true });
    expect(p.snap.announce.text).toBe('앞부분 약 15분만 읽습니다');
  });

  it('첫 조각 429 는 1초 간격으로 8번까지 다시 요청하고, 그래도 429 면 「지금 읽기 요청이 많습니다」(D19)', async () => {
    p.press(REQ);
    for (let i = 0; i < FIRST_RETRIES; i++) {
      await answer(status(429));
      expect(calls).toHaveLength(i + 1); // 1초를 기다리기 전에는 다시 보내지 않는다
      await vi.advanceTimersByTimeAsync(RETRY_MS);
      expect(calls).toHaveLength(i + 2);
    }
    await answer(status(429));
    expect(calls).toHaveLength(FIRST_RETRIES + 1);
    expect(p.snap.phase).toBe('busy');
  });

  it('첫 조각 429 뒤 자리가 나면 이어서 읽는다', async () => {
    p.press(REQ);
    await answer(status(429));
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    await answer(ok(0, 1));
    expect(p.snap.phase).toBe('playing');
  });

  it('둘째 조각부터의 429 는 재생 중에 1초 간격으로 계속, 재생이 끝난 뒤 한 번 더 요청하고 실패로 본다(D18)', async () => {
    p.press(REQ);
    await answer(ok(0, 3));
    expect(calls.at(-1)!.part).toBe(1);
    // 재생 중: 여러 번 429 여도 계속 다시 요청한다(8번 상한 없음)
    for (let i = 0; i < 12; i++) {
      await answer(status(429));
      await vi.advanceTimersByTimeAsync(RETRY_MS);
    }
    expect(calls.filter((c) => c.part === 1)).toHaveLength(13);
    expect(p.snap.phase).toBe('playing');
    audio.end(); // 조각 0 끝, 조각 1 이 없다
    await tick();
    await answer(status(429)); // 재생 중에 보낸 요청의 429 — 끝난 뒤 한 번 더
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(calls.filter((c) => c.part === 1)).toHaveLength(14);
    await answer(status(429));
    expect(p.snap.phase).toBe('busy');
    expect(calls.filter((c) => c.part === 1)).toHaveLength(14);
  });

  it('[다시 시도]는 실패한 조각부터 읽는다(DD7)', async () => {
    p.press(REQ);
    await answer(ok(0, 4));
    await answer(ok(1, 4));
    await answer(status(500)); // 조각 2 실패 — 받아 둔 1 까지는 재생한다
    expect(p.snap.phase).toBe('playing');
    audio.end();
    await tick();
    expect(p.snap.phase).toBe('playing');
    audio.end();
    await tick();
    expect(p.snap.phase).toBe('failed');
    expect(p.snap.announce.text).toBe('읽어 주지 못했습니다');
    p.retry();
    expect(calls.at(-1)!.part).toBe(2);
    expect(p.snap.phase).toBe('preparing');
    await answer(ok(2, 4));
    expect(p.snap.phase).toBe('playing');
    expect(calls.at(-1)!.part).toBe(3);
  });

  it('네트워크 오류도 실패로 보이고 다시 시도할 수 있다', async () => {
    p.press(REQ);
    calls[0].reject(new TypeError('network'));
    await tick();
    expect(p.snap.phase).toBe('failed');
    p.retry();
    expect(calls.at(-1)!.part).toBe(0);
  });

  it('멈추면 진행 중 요청을 끊고(AbortController), 받아 둔 조각과 다시 시도를 버린다', async () => {
    p.press(REQ);
    await answer(ok(0, 5));
    await answer(ok(1, 5));
    const inflight = calls.at(-1)!;
    expect(inflight.part).toBe(2);
    p.press(REQ); // 같은 행을 다시 누르면 멈춤
    expect(inflight.signal.aborted).toBe(true);
    expect(p.snap.phase).toBe('idle');
    expect(revoked).toEqual(expect.arrayContaining(['blob:1', 'blob:2']));
    audio.end(); // 늦은 끝 이벤트는 무시한다
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(3);
  });

  it('429 다시 시도를 기다리는 중에 멈추면 다시 요청하지 않는다', async () => {
    p.press(REQ);
    await answer(status(429));
    p.stop();
    await vi.advanceTimersByTimeAsync(RETRY_MS * 10);
    expect(calls).toHaveLength(1);
    expect(p.snap.phase).toBe('idle');
  });

  it('다른 답을 누르면 앞 읽기를 멈추고 새 답을 처음부터 읽는다(재생기 하나)', async () => {
    p.press(REQ);
    await answer(ok(0, 3));
    const first = calls.at(-1)!;
    p.press({ ...REQ, msg: 'm2', text: '다른 답' });
    expect(first.signal.aborted).toBe(true);
    expect(p.snap).toMatchObject({ msg: 'm2', phase: 'preparing' });
    expect(calls.at(-1)!.body).toMatchObject({ text: '다른 답', part: 0 });
  });

  it('stopConv 는 그 대화의 읽기만 멈춘다(대화 바꾸기·창 닫기, DD11)', async () => {
    p.press(REQ);
    p.stopConv('other');
    expect(p.snap.phase).toBe('preparing');
    p.stopConv('c1');
    expect(p.snap.phase).toBe('idle');
  });

  it('미리 듣기는 채팅 읽기를 멈추고 /api/tts/preview 로 받은 소리를 튼다', async () => {
    p.press(REQ);
    const reading = calls[0];
    void p.preview('ko-male-calm-b');
    expect(reading.signal.aborted).toBe(true);
    expect(p.snap).toMatchObject({ phase: 'idle', preview: 'ko-male-calm-b' });
    expect(p.audible()).toBe(true);
    await answer(ok(0, 1));
    expect(audio.src).toMatch(/^blob:/);
    audio.end();
    expect(p.snap.preview).toBe('');
    expect(p.audible()).toBe(false);
  });
});
