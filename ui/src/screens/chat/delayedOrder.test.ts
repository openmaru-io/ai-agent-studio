/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 진행 중 묶음의 줄 위치를 늦게 바꾸기(screens/chat/delayedOrder.ts, 2026-11-08)
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { keepOrder, useDelayedOrder } from './delayedOrder';

const rows = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = (r: { id: string }[]) => r.map((x) => x.id);

describe('keepOrder', () => {
  it('보이던 순서를 지킨다', () => {
    expect(keepOrder(['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual(['a', 'b', 'c']);
  });
  it('사라진 줄은 빼고 새 줄은 원하는 순서의 앞 줄 뒤에 넣는다', () => {
    expect(keepOrder(['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual(['a', 'x', 'c']);
    expect(keepOrder(['a', 'b'], ['n', 'b', 'a'])).toEqual(['n', 'a', 'b']);
  });
});

describe('useDelayedOrder', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('순서가 바뀌어도 delay 동안 위치를 붙잡고, delay 뒤에 마지막 순서로 옮긴다', () => {
    const { result, rerender } = renderHook(({ r }) => useDelayedOrder(r, 5000), {
      initialProps: { r: rows('a', 'b') },
    });
    expect(ids(result.current)).toEqual(['a', 'b']);
    rerender({ r: rows('b', 'a') });
    expect(ids(result.current)).toEqual(['a', 'b']);
    act(() => vi.advanceTimersByTime(3000));
    // 응답 조각마다 다시 그려도 기다림은 처음 바뀐 때부터 센다
    rerender({ r: rows('b', 'a') });
    expect(ids(result.current)).toEqual(['a', 'b']);
    act(() => vi.advanceTimersByTime(2000));
    expect(ids(result.current)).toEqual(['b', 'a']);
  });

  it('기다리는 동안 보이던 순서로 돌아오면 옮기지 않는다', () => {
    const { result, rerender } = renderHook(({ r }) => useDelayedOrder(r, 5000), {
      initialProps: { r: rows('a', 'b') },
    });
    rerender({ r: rows('b', 'a') });
    act(() => vi.advanceTimersByTime(3000));
    rerender({ r: rows('a', 'b') });
    act(() => vi.advanceTimersByTime(5000));
    expect(ids(result.current)).toEqual(['a', 'b']);
  });

  it('기본 기다림은 2초다', () => {
    const { result, rerender } = renderHook(({ r }) => useDelayedOrder(r), {
      initialProps: { r: rows('a', 'b') },
    });
    rerender({ r: rows('b', 'a') });
    act(() => vi.advanceTimersByTime(1999));
    expect(ids(result.current)).toEqual(['a', 'b']);
    act(() => vi.advanceTimersByTime(1));
    expect(ids(result.current)).toEqual(['b', 'a']);
  });

  it('새 줄과 사라진 줄은 곧바로 반영한다', () => {
    const { result, rerender } = renderHook(({ r }) => useDelayedOrder(r, 5000), {
      initialProps: { r: rows('a', 'b') },
    });
    rerender({ r: rows('n', 'a', 'b') });
    expect(ids(result.current)).toEqual(['n', 'a', 'b']);
    rerender({ r: rows('n', 'b') });
    expect(ids(result.current)).toEqual(['n', 'b']);
  });

  it('줄 내용은 곧바로 새 값이다', () => {
    const { result, rerender } = renderHook(({ r }) => useDelayedOrder(r, 5000), {
      initialProps: {
        r: [
          { id: 'a', s: 'running' },
          { id: 'b', s: 'running' },
        ],
      },
    });
    rerender({
      r: [
        { id: 'b', s: 'waiting' },
        { id: 'a', s: 'running' },
      ],
    });
    expect(result.current).toEqual([
      { id: 'a', s: 'running' },
      { id: 'b', s: 'waiting' },
    ]);
  });
});
