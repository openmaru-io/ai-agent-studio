/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 따라하기(진행 카드)의 상태(OMAI-1274). lib/chatPopup.ts 처럼 모듈 store 다: 카드·도움말 서랍·캐릭터 단추·서랍이 같은 값을 구독한다.
// - 진행 중인 가이드는 언제나 하나다(재검토 D12). 다른 가이드를 시작하면 앞 가이드는 「안 함」으로 돌아간다.
// - 진행 상태는 sessionStorage 에 사용자 이메일과 함께 둔다. 새로고침 뒤에는 이어지고, 같은 탭에서 다른 사용자로 들어오면 버린다.
// - 끝낸 가이드·시작하기 띠 숨김·관리자의 마지막 탭은 localStorage 에 이메일별로 둔다(디자인 리뷰 13A). 로그인을 끈 설치는 'anon'.
// - 저장소를 쓸 수 없는 브라우저에서도 따라하기는 동작한다(기록만 남지 않는다).
import { useSyncExternalStore } from 'react';

import { guideById } from './guides';

export interface GuideRun {
  id: string;
  step: number;
  /** 사용자가 카드를 알약으로 접었다 */
  collapsed: boolean;
}

interface State {
  run: GuideRun | null;
  /** 화면을 옮기는 중(저장 확인·이동). 이 동안 「이전」·「다음」을 막는다(재검토 외부 5) */
  busy: boolean;
  /** 마지막 단계를 끝냈다(완료 카드) */
  finished: string | null;
  /** 카드로 포커스를 옮겨 달라는 요청 번호(Alt+Shift+H) */
  focusSeq: number;
  /** 지금 단계의 화면을 열어 달라는 요청 번호(따라하기 시작·이어서 하기). 카드가 받아 화면을 옮긴다 */
  navSeq: number;
  /** 이번 진행에서 권한 때문에 막힌 단계가 있었다(완료 카드에 「일부는 관리자에게」를 보인다) */
  blocked: boolean;
  user: string;
}

const RUN_KEY = 'aas-guide-run';
const doneKey = (user: string) => `aas-guide-done:${user}`;
const bannerKey = (user: string) => `aas-guide-banner:${user}`;
const tabKey = (user: string) => `aas-guide-tab:${user}`;

let state: State = { run: null, busy: false, finished: null, focusSeq: 0, navSeq: 0, blocked: false, user: '' };
const listeners = new Set<() => void>();

function set(next: Partial<State>) {
  state = { ...state, ...next };
  listeners.forEach((fn) => fn());
}

function read(store: 'local' | 'session', key: string): string | null {
  try {
    return (store === 'local' ? localStorage : sessionStorage).getItem(key);
  } catch {
    return null;
  }
}

function write(store: 'local' | 'session', key: string, value: string | null) {
  try {
    const s = store === 'local' ? localStorage : sessionStorage;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    /* 저장소를 못 쓰면 이번 화면에서만 기억한다 */
  }
}

function saveRun(run: GuideRun | null) {
  write('session', RUN_KEY, run ? JSON.stringify({ ...run, user: state.user }) : null);
}

/** 로그인한 사람을 알린다. 사용자가 없는 설치(auth_enabled=false)는 'anon'. 저장된 진행 상태가 다른 사람 것이거나 없는 가이드면 버린다 */
export function setGuideUser(user: string) {
  if (state.user === user) return;
  let run: GuideRun | null = null;
  try {
    const raw = read('session', RUN_KEY);
    const v = raw ? (JSON.parse(raw) as GuideRun & { user?: string }) : null;
    const g = v && guideById(v.id);
    if (v && g && v.user === user && Number.isInteger(v.step) && v.step >= 0 && v.step < g.steps.length)
      run = { id: v.id, step: v.step, collapsed: !!v.collapsed };
  } catch {
    run = null;
  }
  if (!run) write('session', RUN_KEY, null);
  set({ user, run, finished: null, busy: false });
}

export function startGuide(id: string, step = 0) {
  const g = guideById(id);
  if (!g) return;
  const run = { id, step: Math.min(Math.max(step, 0), g.steps.length - 1), collapsed: false };
  saveRun(run);
  set({ run, finished: null, busy: false, blocked: false, navSeq: state.navSeq + 1 });
}

export function markGuideBlocked() {
  if (!state.blocked) set({ blocked: true });
}

/** 단계를 바꾼다(화면 이동은 카드가 한다). 범위를 벗어나면 아무것도 하지 않는다 */
export function setGuideStep(step: number) {
  const r = state.run;
  const g = r && guideById(r.id);
  if (!r || !g || step < 0 || step >= g.steps.length) return;
  const run = { ...r, step };
  saveRun(run);
  set({ run });
}

export function setGuideCollapsed(collapsed: boolean) {
  if (!state.run) return;
  const run = { ...state.run, collapsed };
  saveRun(run);
  set({ run });
}

export function setGuideBusy(busy: boolean) {
  set({ busy });
}

/** × : 묻지 않고 멈춘다. sessionStorage 의 진행 상태는 남아 「이어서 하기」로 돌아온다 */
export function pauseGuide() {
  if (state.run) saveRun({ ...state.run, collapsed: false });
  set({ run: null, busy: false });
}

/** 마지막 단계에서 「끝냄」: 요청 안내만 있는 가이드가 아니면 끝냄으로 기록하고 완료 카드를 띄운다 */
export function finishGuide() {
  const r = state.run;
  const g = r && guideById(r.id);
  if (!r || !g) return;
  if (!g.requestOnly) markDone(g.id);
  saveRun(null);
  set({ run: null, finished: g.id, busy: false });
}

export function closeFinished() {
  set({ finished: null });
}

/** 이어서 할 가이드(× 로 멈춘 것, 또는 새로고침 전 진행 중이던 것) */
export function resumable(): GuideRun | null {
  if (state.run) return null;
  try {
    const raw = read('session', RUN_KEY);
    const v = raw ? (JSON.parse(raw) as GuideRun & { user?: string }) : null;
    return v && v.user === state.user && guideById(v.id) ? { id: v.id, step: v.step, collapsed: false } : null;
  } catch {
    return null;
  }
}

export function resumeGuide() {
  const r = resumable();
  if (r) startGuide(r.id, r.step);
}

export function requestGuideFocus() {
  if (!state.run) return;
  if (state.run.collapsed) setGuideCollapsed(false);
  set({ focusSeq: state.focusSeq + 1 });
}

export function doneGuides(): Set<string> {
  try {
    const v = JSON.parse(read('local', doneKey(state.user)) || '[]');
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function markDone(id: string) {
  const s = doneGuides();
  s.add(id);
  write('local', doneKey(state.user), JSON.stringify([...s]));
}

export const bannerHidden = () => read('local', bannerKey(state.user)) === '1';
export const hideBanner = () => {
  write('local', bannerKey(state.user), '1');
  set({});
};
export const lastHelpTab = () => read('local', tabKey(state.user));
export const saveHelpTab = (tab: string) => write('local', tabKey(state.user), tab);

// 도움말 서랍을 여는 함수. AppShell 이 등록하고 본문 제목 옆 도움말 단추(PageTitle)가 부른다. AppShell 밖(시험·로그인 화면)에서는 없다
let helpOpener: (() => void) | null = null;
export function setHelpOpener(fn: (() => void) | null) {
  helpOpener = fn;
}
export const canOpenHelp = () => !!helpOpener;
export const openHelp = () => helpOpener?.();

export function guideRunState(): State {
  return state;
}

export function useGuideRun(): State {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    () => state
  );
}

/** 시험용: 상태를 처음으로 되돌린다 */
export function resetGuideRunForTest() {
  state = { run: null, busy: false, finished: null, focusSeq: 0, navSeq: 0, blocked: false, user: '' };
  listeners.forEach((fn) => fn());
}
