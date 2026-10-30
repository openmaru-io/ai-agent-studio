/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef } from 'react';

/**
 * 서랍(MUI 모달)이 열리면 body 의 다른 자식에 aria-hidden 을 건다. 서랍과 함께 쓰는 창(대화 팝업·가이드 카드)은 그것만 푼다.
 * 이 요소는 Portal 로 body 의 직속 자식이어야 한다. 앱 루트 안에 있으면 앱 루트째 가려져 풀 수 없다(OMAI-1274 재검토).
 */
export function useKeepVisible<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const unhide = () => {
      if (el.getAttribute('aria-hidden') === 'true') el.removeAttribute('aria-hidden');
    };
    unhide();
    const mo = new MutationObserver(unhide);
    mo.observe(el, { attributes: true, attributeFilter: ['aria-hidden'] });
    return () => mo.disconnect();
  });
  return ref;
}
