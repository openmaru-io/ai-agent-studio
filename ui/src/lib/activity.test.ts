/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startActivity, TOUCH_EVERY_MS } from './activity';

describe('activity (OMAI-1112)', () => {
  let stop: () => void = () => {};
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  const start = (send = vi.fn(() => Promise.resolve({}))) => {
    stop = startActivity({ send });
    return send;
  };

  it('조작하면 바로 한 번 보내고, 5분 안의 조작은 5분이 되는 시점에 한 번 더 보낸다', async () => {
    const send = start();
    window.dispatchEvent(new KeyboardEvent('keydown'));
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    window.dispatchEvent(new MouseEvent('pointerdown'));
    window.dispatchEvent(new Event('input'));
    expect(send).toHaveBeenCalledTimes(1); // 5분 제한
    await vi.advanceTimersByTimeAsync(TOUCH_EVERY_MS - 60_000);
    expect(send).toHaveBeenCalledTimes(2); // 끝 무렵 조작이 빠지지 않는다
    await vi.advanceTimersByTimeAsync(TOUCH_EVERY_MS * 3);
    expect(send).toHaveBeenCalledTimes(2); // 조작이 없으면 보내지 않는다
  });

  it('전파를 막는 요소 안의 조작도 capture 단계에서 잡는다', () => {
    const send = start();
    const box = document.createElement('div');
    box.addEventListener('keydown', (e) => e.stopPropagation());
    document.body.appendChild(box);
    box.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
    expect(send).toHaveBeenCalledTimes(1);
    box.remove();
  });

  it('보내기에 실패하면 보낸 것으로 치지 않고 다음 조작 때 다시 보낸다', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({});
    start(send);
    window.dispatchEvent(new MouseEvent('pointerdown'));
    await vi.advanceTimersByTimeAsync(0);
    window.dispatchEvent(new MouseEvent('pointerdown'));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('멈추면 더 듣지 않는다', () => {
    const send = start();
    stop();
    window.dispatchEvent(new KeyboardEvent('keydown'));
    expect(send).not.toHaveBeenCalled();
  });
});
