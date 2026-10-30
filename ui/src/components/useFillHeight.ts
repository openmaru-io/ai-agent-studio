/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 요소의 위쪽 끝에서 화면 아래(본문 <main> 의 아래 여백 위)까지의 높이를 잰다.
// 고정 값(calc(100vh - 230px))은 제목·탭·연결 상태 띠 높이가 바뀌면 아래에 빈 곳이 남거나 넘쳤다.
import { useLayoutEffect, useState } from 'react';

export function fillHeight(el: HTMLElement, viewportHeight: number = window.innerHeight): number {
  const main = el.closest('main');
  // 본문이 스크롤된 만큼 위치가 올라가 보이므로 되돌려 잰다
  const top = el.getBoundingClientRect().top + (main?.scrollTop ?? 0);
  const pad = main ? parseFloat(getComputedStyle(main).paddingBottom) || 0 : 0;
  return Math.floor(viewportHeight - top - pad);
}

/** ref 를 붙인 요소가 채울 높이(px). 재기 전이나 잴 수 없으면 undefined — 부르는 쪽이 CSS 값으로 대신한다. */
export function useFillHeight<T extends HTMLElement>() {
  // 콜백 ref 로 받는다 — 부르는 화면이 불러오기 중에는 다른 것을 그리다가 나중에 요소를 붙여도 잰다
  const [el, ref] = useState<T | null>(null);
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => {
      const h = fillHeight(el);
      setHeight(h > 0 ? h : undefined);
    };
    measure();
    window.addEventListener('resize', measure);
    // 위쪽 제목 줄이 바뀌거나 연결 상태 띠가 생기면 본문·부모 크기가 바뀐다
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    const main = el.closest('main');
    if (ro) {
      if (main) ro.observe(main);
      if (el.parentElement) ro.observe(el.parentElement);
    }
    return () => {
      window.removeEventListener('resize', measure);
      ro?.disconnect();
    };
  }, [el]);
  return { ref, height };
}
