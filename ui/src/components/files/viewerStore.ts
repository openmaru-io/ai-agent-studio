/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 파일 뷰어 하나를 화면 전체가 함께 쓴다(스펙 2026-10-20-002 §3-1). 뱃지·서랍 줄이 open 을 부르고, AppShell 의 LazyFileViewer 가 그린다.
import { useSyncExternalStore } from 'react';

import type { FileSource } from '@/lib/fileKinds';

/** 뷰어가 여는 파일. url 은 GET 으로 바이트를 주는 주소(개인·오피스 대화창·회의·칸반이 다르다) */
export interface ViewerFile {
  name: string;
  url: string;
  source: FileSource;
  /** 데이터 폴더 기준 경로(workspace/…). 「자세히」·경로 복사에 쓴다. 회의·칸반은 없다 */
  path?: string;
  size?: number;
  /** 초 단위 */
  mtime?: number;
  /** 회의 방 이름·칸반 보드 이름 */
  place?: string;
  /** 받을 수 없는 이유 코드(지움·링크 등) */
  blocked?: string;
  /** 이유 코드 → 문구. 없으면 채팅 파일 문구(chatFiles.reasonText). 칸반처럼 자기 이유 문구가 있는 곳이 넘긴다 */
  reasonOf?: (code: string) => string;
}

/** 자리마다 가능한 동작만 넘긴다(DD3) */
export interface ViewerActions {
  /** 「AI 에게 묻기」(DD10) — 부르는 쪽이 첨부·포커스를 맡는다. 뷰어는 먼저 닫힌다 */
  onAsk?: () => void;
  /** 지우기(서랍에서만). 지웠으면 참 — 뷰어는 닫히고 afterDelete 로 포커스를 넘긴다(DD11) */
  onDelete?: () => Promise<boolean>;
  afterDelete?: () => void;
  /** 회의 에이전트 결과의 주 단추(DD3) */
  onToRoom?: () => Promise<void>;
}

interface State {
  file: ViewerFile | null;
  actions: ViewerActions;
  /** 닫을 때 포커스를 돌려줄 곳(연 뱃지·줄) */
  back: HTMLElement | null;
  seq: number;
}

let state: State = { file: null, actions: {}, back: null, seq: 0 };
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export function openViewer(file: ViewerFile, actions: ViewerActions = {}, back?: HTMLElement | null) {
  const active = back ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  state = { file, actions, back: active, seq: state.seq + 1 };
  emit();
}

export function closeViewer(restoreFocus = true) {
  const back = state.back;
  state = { ...state, file: null, actions: {}, back: null };
  emit();
  if (restoreFocus && back?.isConnected) setTimeout(() => back.focus(), 0);
}

export function useViewer(): State {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => void subs.delete(f);
    },
    () => state
  );
}

/** 글 안 뱃지의 aria-describedby 대상(DD16). LazyFileViewer 가 한 번 그린다 */
export const INLINE_HINT_ID = 'aas-file-badge-hint';
