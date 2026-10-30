/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 전역 단축키: Ctrl/⌘+K 팔레트, g 다음 글자로 화면 이동, / 검색창, ? 안내표, Esc 닫기.
import { useEffect, useRef } from 'react';

import { viewByKey } from '@/lib/views';

export interface ShortcutHandlers {
  go: (viewId: string) => void;
  togglePalette: () => void;
  closePalette: () => void;
  closeDrawer: () => void;
  paletteOpen: () => boolean;
  drawerOpen: () => boolean;
  showHelp: () => void;
  /** Alt+Shift+H: 진행 중인 가이드 카드로 포커스(OMAI-1274). 입력 중에도 동작한다 */
  focusGuide?: () => void;
}

const G_WINDOW_MS = 1500;

export function useShortcuts(h: ShortcutHandlers): void {
  const ref = useRef(h);
  ref.current = h;
  const gAt = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = ref.current;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        k.togglePalette();
        return;
      }
      // Alt·입력 중 조기 반환보다 앞에서 본다. Mac 의 Option 은 e.key 를 다른 글자(Ó)로 바꾸므로 e.code 로 판정한다(OMAI-1274 재검토 E1)
      if (e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyH' && !e.isComposing && k.focusGuide) {
        e.preventDefault();
        k.focusGuide();
        return;
      }
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if (e.key === 'Escape' && !typing) {
        if (k.paletteOpen()) k.closePalette();
        else if (k.drawerOpen()) k.closeDrawer();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey || e.isComposing || t?.closest('[role=menu],[role=menubar]'))
        return;
      if (Date.now() - gAt.current < G_WINDOW_MS) {
        gAt.current = 0;
        const v = viewByKey(e.key);
        if (v) {
          e.preventDefault();
          k.go(v.id);
        }
        return;
      }
      if (e.key === 'g') {
        gAt.current = Date.now();
        return;
      }
      if (e.key === '/') {
        const el = document.querySelector<HTMLInputElement>('[data-view-search]');
        if (el) {
          e.preventDefault();
          el.focus();
          el.select();
        }
      } else if (e.key === '?') {
        e.preventDefault();
        k.showHelp();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
