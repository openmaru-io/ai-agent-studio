/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 끌어서 옮기고 크기를 바꾸는 떠 있는 창(OMAI-1115, 대화 팝업). pointer capture 로 마우스·터치를 함께 받고,
// 화면 밖으로 나가지 않게 막는다. 위치·크기는 localStorage 에 기억한다(실패해도 기본값으로 동작).
// transform 이 아니라 left/top 으로 옮긴다 — transform 을 쓰면 안쪽의 position:fixed(차트 전체화면 등)가 창 안에 갇힌다.
import { KeyboardEvent, PointerEvent, useCallback, useEffect, useRef, useState } from 'react';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MIN_W = 320;
export const MIN_H = 360;
const MARGIN = 8;
const STEP = 24;

export function clampRect(r: Rect, vw: number = window.innerWidth, vh: number = window.innerHeight): Rect {
  const w = Math.max(MIN_W, Math.min(r.w, vw - MARGIN * 2));
  const h = Math.max(MIN_H, Math.min(r.h, vh - MARGIN * 2));
  const x = Math.max(MARGIN, Math.min(r.x, vw - w - MARGIN));
  const y = Math.max(MARGIN, Math.min(r.y, vh - h - MARGIN));
  return { x, y, w, h };
}

function load(key: string, fallback: () => Rect): Rect {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null') as Rect | null;
    if (v && [v.x, v.y, v.w, v.h].every((n) => typeof n === 'number' && Number.isFinite(n))) return clampRect(v);
  } catch {
    // 저장소를 못 쓰면 기본값
  }
  return clampRect(fallback());
}

type Mode = 'move' | 'resize';

export function useFloatingWindow(key: string, fallback: () => Rect) {
  const [rect, setRect] = useState<Rect>(() => load(key, fallback));
  const drag = useRef<{ mode: Mode; px: number; py: number; start: Rect } | null>(null);
  // 사용자가 옮기거나 크기를 바꾼 뒤에만 저장한다. 기본 자리를 저장하면 다른 창 옆에 놓였던 자리가 굳어 혼자 열어도 그 자리에 뜬다.
  const touched = useRef(false);

  useEffect(() => {
    if (!touched.current) return;
    try {
      localStorage.setItem(key, JSON.stringify(rect));
    } catch {
      // 저장 못 해도 동작에는 영향 없음
    }
  }, [key, rect]);

  useEffect(() => {
    const onResize = () => setRect((r) => clampRect(r));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const begin = (mode: Mode) => (e: PointerEvent<HTMLElement>) => {
    if (e.button > 0) return;
    if (mode === 'move' && (e.target as HTMLElement).closest('button')) return; // 머리의 단추를 누른 것은 끌기가 아니다
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { mode, px: e.clientX, py: e.clientY, start: rect };
  };
  const onMove = useCallback((e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    touched.current = true;
    setRect(
      clampRect(
        d.mode === 'move'
          ? { ...d.start, x: d.start.x + dx, y: d.start.y + dy }
          : { ...d.start, w: d.start.w + dx, h: d.start.h + dy }
      )
    );
  }, []);
  const end = useCallback(() => {
    drag.current = null;
  }, []);
  const keys = (mode: Mode) => (e: KeyboardEvent<HTMLElement>) => {
    const dx = e.key === 'ArrowLeft' ? -STEP : e.key === 'ArrowRight' ? STEP : 0;
    const dy = e.key === 'ArrowUp' ? -STEP : e.key === 'ArrowDown' ? STEP : 0;
    if (!dx && !dy) return;
    e.preventDefault();
    touched.current = true;
    setRect((r) => clampRect(mode === 'move' ? { ...r, x: r.x + dx, y: r.y + dy } : { ...r, w: r.w + dx, h: r.h + dy }));
  };

  const handle = (mode: Mode) => ({
    onPointerDown: begin(mode),
    onPointerMove: onMove,
    onPointerUp: end,
    onPointerCancel: end,
    onKeyDown: keys(mode),
  });
  return { rect, setRect, moveHandle: handle('move'), resizeHandle: handle('resize') };
}
