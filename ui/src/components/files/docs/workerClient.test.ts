/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { connect, DocWorkerError, progressText, type Reply } from './workerClient';

/** 가짜 작업 스레드 — 보낸 요청을 모으고, 시험이 답을 흉내 낸다 */
function fake() {
  const sent: Record<string, unknown>[] = [];
  const port = {
    onmessage: null as ((e: MessageEvent<Reply>) => void) | null,
    onerror: null as ((e: ErrorEvent) => void) | null,
    postMessage: (m: Record<string, unknown>) => void sent.push(m),
    terminate: vi.fn(),
  };
  const reply = (r: Reply) => port.onmessage?.({ data: r } as MessageEvent<Reply>);
  return { port, sent, reply };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('작업 스레드 요청(리뷰 D14·재검토 D8)', () => {
  it('번호로 답을 맞춘다', async () => {
    const f = fake();
    const w = connect(f.port);
    const a = w.request<number>({ type: 'open' }, 1000);
    const b = w.request<number>({ type: 'page', page: 1 }, 1000);
    f.reply({ id: f.sent[1].id as number, ok: true, data: 2 });
    f.reply({ id: f.sent[0].id as number, ok: true, data: 1 });
    await expect(a).resolves.toBe(1);
    await expect(b).resolves.toBe(2);
  });

  it('시간 안에 답이 없으면 timeout', async () => {
    const w = connect(fake().port);
    const p = w.request({ type: 'open' }, 30_000);
    vi.advanceTimersByTime(30_001);
    await expect(p).rejects.toMatchObject({ code: 'timeout' });
  });

  it('스레드가 죽으면(onerror) 기다리던 요청을 모두 실패로, 그 뒤 요청도 실패', async () => {
    const f = fake();
    const w = connect(f.port);
    const a = w.request({ type: 'open' }, 1000);
    const b = w.request({ type: 'page' }, 1000);
    f.port.onerror?.({ preventDefault: () => undefined } as ErrorEvent);
    await expect(a).rejects.toBeInstanceOf(DocWorkerError);
    await expect(b).rejects.toMatchObject({ code: 'workerError' });
    await expect(w.request({ type: 'x' }, 10)).rejects.toMatchObject({ code: 'workerError' });
  });

  it('스레드 쪽 실패 코드를 그대로 넘긴다(받기 멈춤 등)', async () => {
    const f = fake();
    const w = connect(f.port);
    const p = w.request({ type: 'init' }, 1000);
    f.reply({ id: f.sent[0].id as number, ok: false, code: 'stall' });
    await expect(p).rejects.toMatchObject({ code: 'stall' });
  });

  it('알림은 요청과 따로 받고, 닫으면 terminate', () => {
    const f = fake();
    const w = connect(f.port);
    const seen: unknown[] = [];
    w.on('progress', (d) => seen.push(d));
    f.reply({ event: 'progress', data: { got: 1 } });
    expect(seen).toEqual([{ got: 1 }]);
    w.terminate();
    expect(f.port.terminate).toHaveBeenCalled();
  });
});

describe('받기 진행 문구(재검토 D2)', () => {
  it('압축 응답이면 받은 양만', () => {
    expect(progressText(4.3 * 1024 * 1024, 4.4 * 1024 * 1024, true)).toEqual({ known: false, text: '4.3 MB' });
  });
  it('아니면 받은 양 / 전체', () => {
    expect(progressText(4.1 * 1024 * 1024, 11.9 * 1024 * 1024, false)).toEqual({ known: true, text: '4.1 / 11.9 MB' });
    expect(progressText(1024 * 1024, 0, false).known).toBe(false);
  });
});
