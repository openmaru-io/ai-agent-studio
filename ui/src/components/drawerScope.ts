/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, ReactNode, useContext, useLayoutEffect, useRef } from 'react';

/** 서랍(DrawerHost) 본문 안인가. 화면용 부품이 서랍 안에서 모양을 줄일 때 쓴다(서랍 머리에 이미 제목이 있다) */
export const InDrawerContext = createContext(false);
export const useInDrawer = () => useContext(InDrawerContext);

/** 서랍 머리의 자리. `el` 은 동작 단추 자리(닫기 앞, DrawerActions), `badges` 는 상태 뱃지 자리(제목 옆, DrawerBadges),
 * `note` 는 설명 자리(부제목 옆, DrawerNote).
 * `active` 는 이 본문이 맨 위 서랍인가 — 쌓인 아래 서랍의 단추·뱃지는 그리지 않는다 */
export interface DrawerHeadSlot {
  el: HTMLElement | null;
  badges?: HTMLElement | null;
  note?: HTMLElement | null;
  active: boolean;
}
export const DrawerHeadSlotContext = createContext<DrawerHeadSlot | null>(null);

/** 서랍 본문 하나의 자리(DrawerHost 가 본문마다 둔다, 스펙 2026-10-26-003). 서랍 밖이면 null */
export interface DrawerPageScope {
  /** 그 서랍 기록에서 이 본문의 위치(기록이 없으면 0) */
  index: number;
  /** 서랍 머리(제목·부제)를 채운다 */
  setHead: (head: DrawerHead) => void;
  /** 그 서랍에 저장 확인을 건다(null 이면 뗀다) */
  guard: (fn: (() => boolean | Promise<boolean>) | null) => void;
}
export interface DrawerHead {
  title: string;
  sub?: string;
  subLead?: ReactNode;
  focusKey?: string;
}
export const DrawerPageContext = createContext<DrawerPageScope | null>(null);
export const useDrawerPage = () => useContext(DrawerPageContext);
const noGuard = () => {};
/** 페이지 본문이 그 서랍에 저장 확인을 거는 함수(서랍 밖이면 아무것도 하지 않는다) */
export const useDrawerGuard = () => useContext(DrawerPageContext)?.guard ?? noGuard;

/**
 * 페이지 본문이 서랍 머리를 채운다(리뷰 외부 검토 C1 — 제목이 본문이 읽은 값·훅 값에 달려 있어 등록부가 미리 만들 수 없다).
 * 제목·부제·초점 열쇠가 바뀔 때만 다시 채운다(subLead 는 그때의 값)
 */
export function useDrawerHead(head: DrawerHead | null) {
  const scope = useContext(DrawerPageContext);
  const ref = useRef(head);
  ref.current = head;
  const set = scope?.setHead;
  useLayoutEffect(() => {
    if (set && ref.current) set(ref.current);
  }, [set, head?.title, head?.sub, head?.focusKey]);
}
