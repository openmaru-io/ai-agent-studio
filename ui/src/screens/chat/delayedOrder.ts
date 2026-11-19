/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 줄 위치를 늦게 바꾸기: 세션 여러 개가 함께 돌면 진행 중 묶음의 줄이 응답 조각마다 자리를 바꿔 고르기 어려웠다(2026-11-08).
// 줄 내용(상태·시각)은 곧바로 바꾸고, 이미 보이던 줄의 순서만 delay 동안 붙잡아 둔다. 새 줄과 사라진 줄은 곧바로 반영한다.
import { useEffect, useRef, useState } from 'react';

/** 진행 중 묶음의 줄 위치를 바꾸기 전에 기다리는 시간. 처음 5초로 넣었다가 사용자 결정으로 2초(2026-11-08) */
export const LIVE_REORDER_MS = 2000;

/**
 * 보이던 순서(shown)를 지키면서 지금 있어야 할 줄(want)을 맞춘다.
 * shown 에서 사라진 줄은 빼고, want 에만 있는 새 줄은 want 에서 바로 앞에 있던 줄 뒤에 넣는다(앞 줄이 없으면 맨 앞).
 */
export function keepOrder(shown: string[], want: string[]): string[] {
  const wantSet = new Set(want);
  const out = shown.filter((id) => wantSet.has(id));
  const placed = new Set(out);
  want.forEach((id, i) => {
    if (placed.has(id)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = out.indexOf(want[j]);
      if (k >= 0) {
        at = k + 1;
        break;
      }
    }
    out.splice(at, 0, id);
    placed.add(id);
  });
  return out;
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * rows 를 보여 줄 순서로 돌려준다. 순서가 바뀌면 delay 뒤에 그때의 순서로 한 번에 옮긴다.
 * 그동안 순서가 계속 바뀌어도(응답 조각마다 시각이 바뀜) 기다림을 다시 시작하지 않으므로, 위치는 delay 에 한 번까지만 바뀐다.
 */
export function useDelayedOrder<T extends { id: string }>(rows: T[], delay = LIVE_REORDER_MS): T[] {
  const want = rows.map((r) => r.id);
  const [shown, setShown] = useState<string[]>(want);
  const wantRef = useRef(want);
  wantRef.current = want;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const merged = keepOrder(shown, want);
  const settled = same(merged, want);
  const wantKey = want.join('\n');
  const shownKey = shown.join('\n');

  useEffect(() => {
    if (settled) {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      if (shownKey !== wantKey) setShown(wantRef.current);
      return;
    }
    if (!timer.current) {
      timer.current = setTimeout(() => {
        timer.current = null;
        setShown(wantRef.current);
      }, delay);
    }
  }, [settled, wantKey, shownKey, delay]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const byId = new Map(rows.map((r) => [r.id, r]));
  return merged.map((id) => byId.get(id)!);
}
