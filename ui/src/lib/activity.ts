/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 사용 중 로그인 유지(OMAI-1112). 서버 세션은 사용자가 조작할 때만 연장된다 — 자동 요청(웹소켓 ping, 주기 조회)은 연장하지 않는다.
// 클릭·입력·스크롤을 감지해 /api/session/touch 를 5분에 한 번까지 보낸다. 5분 안의 조작은 5분이 되는 시점에 한 번 더 보내
// 끝 무렵 조작이 빠지지 않게 한다. 편집기·캔버스가 이벤트 전파를 막으므로 capture 단계에서 듣는다.
import { post } from './api';

export const TOUCH_EVERY_MS = 5 * 60_000;
export const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'input'] as const;

export interface ActivityDeps {
  send: () => Promise<unknown>;
  now: () => number;
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

const defaults = (): ActivityDeps => ({
  send: () => post('/api/session/touch', {}),
  now: () => Date.now(),
  target: window,
});

/** 조작 감지를 시작한다. 돌려준 함수를 부르면 멈춘다. 401 은 api 가 로그인 화면으로 보낸다. */
export function startActivity(deps: Partial<ActivityDeps> = {}): () => void {
  const d = { ...defaults(), ...deps };
  let last = -Infinity; // 마지막으로 보낸 시각(실패하면 되돌린다)
  let inflight = false;
  let pending = false; // 보낸 뒤에 조작이 있었다
  let timer: ReturnType<typeof setTimeout> | undefined;

  const send = () => {
    const prev = last;
    last = d.now();
    inflight = true;
    pending = false;
    d.send()
      .catch(() => {
        last = prev; // 보낸 것으로 치지 않는다 — 다음 조작 때 다시
      })
      .finally(() => {
        inflight = false;
      });
  };

  const onActivity = () => {
    if (inflight) {
      pending = true;
      return;
    }
    const wait = last + TOUCH_EVERY_MS - d.now();
    if (wait <= 0) {
      send();
      return;
    }
    pending = true;
    if (timer === undefined) {
      timer = setTimeout(() => {
        timer = undefined;
        if (pending) onActivity();
      }, wait);
    }
  };

  const opts: AddEventListenerOptions = { capture: true, passive: true };
  for (const type of ACTIVITY_EVENTS) d.target.addEventListener(type, onActivity, opts);
  return () => {
    for (const type of ACTIVITY_EVENTS) d.target.removeEventListener(type, onActivity, opts);
    if (timer !== undefined) clearTimeout(timer);
  };
}
