/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 문서 뷰어 머리(LazyFileViewer)와 본문(PdfBody·DocxBody)이 주고받는 상태(스펙 2026-10-20-005 §6-1, 외부 검토 OV2-H2).
// 본문이 쪽 수·지금 쪽을 올리고, 머리가 명령(쪽 이동·확대·맞춤·찾기 열기)을 내린다. 뷰어는 화면에 하나라 저장소도 하나다.
import { useSyncExternalStore } from 'react';

import { ZOOM_MAX, ZOOM_MIN } from './docMath';

export interface DocState {
  /** 쪽 수. 0 이면 모름(쪽 번호를 숨긴다) */
  pages: number;
  /** 지금 쪽(1부터) */
  page: number;
  /** 맞춤 폭 기준 배율(%). 100 = 맞춤 */
  zoom: number;
  /** 원래 크기에 해당하는 배율(%). 본문이 첫 쪽 크기를 알면 넣는다 */
  natural: number;
  findOpen: boolean;
  /** 머리가 낸 쪽 이동. seq 가 바뀔 때만 본문이 움직인다 */
  goto: { page: number; seq: number };
}

const INIT: DocState = { pages: 0, page: 0, zoom: 100, natural: 0, findOpen: false, goto: { page: 0, seq: 0 } };
let state: DocState = INIT;
const subs = new Set<() => void>();
const set = (patch: Partial<DocState>) => {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
};

export const docStore = {
  get: () => state,
  reset: () => set(INIT),
  setPages: (pages: number) => set({ pages, page: pages ? Math.max(1, Math.min(state.page || 1, pages)) : 0 }),
  setPage: (page: number) => page !== state.page && set({ page }),
  setNatural: (natural: number) => set({ natural }),
  setZoom: (zoom: number) => set({ zoom: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(zoom))) }),
  goto: (page: number) => {
    if (!state.pages) return;
    const p = Math.min(state.pages, Math.max(1, page));
    set({ page: p, goto: { page: p, seq: state.goto.seq + 1 } });
  },
  openFind: () => set({ findOpen: true }),
  closeFind: () => set({ findOpen: false }),
};

export function useDoc(): DocState {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => void subs.delete(f);
    },
    () => state
  );
}
