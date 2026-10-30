/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 오른쪽 상세 서랍(DrawerHost)의 위치와 폭 규칙.
// COP Console 의 `frontend/src/components/common/detailDrawer.ts` 와 리소스 상세 Drawer
// (`common/Resource/DetailsDrawer.tsx`)의 값을 옮겼다. 두 제품의 서랍이 같은 자리에 같은 폭으로 뜨게 값을 바꾸지 않는다.
import { useEffect, useState } from 'react';

import { shellMetrics } from './shellTokens';

/** 본문 영역 엘리먼트. `AppShell` 의 `<Box component="main" id="main">` 이다. */
const MAIN_ELEMENT_ID = 'main';

/** 처음 열 때 폭 상한(px). 표·글을 함께 보여 줘야 해서 좁으면 읽기 어렵다. */
export const DETAIL_DRAWER_MAX_WIDTH = 1100;

/**
 * 처음 열 때 화면 폭 대비 상한(%). px 상한만 두면 1280px 노트북에서 뒤의 목록이 거의 가려진다.
 * 소수가 아니라 정수 %로 둔다(`0.55 * 100` 은 `55.00000000000001` 이 된다).
 */
export const DETAIL_DRAWER_VIEWPORT_PERCENT = 55;

/** 끌어서 줄일 수 있는 최소 폭(px). COP 리소스 상세 Drawer 와 같다. */
export const DETAIL_DRAWER_MIN_WIDTH = 500;

/** 끌어서 넓힐 수 있는 화면 폭 대비 상한(%). 뒤의 목록이 조금은 보이게 남긴다. */
export const DETAIL_DRAWER_RESIZE_MAX_PERCENT = 80;

/** 키보드(←·→)로 한 번에 바꾸는 폭(px). */
export const DETAIL_DRAWER_KEY_STEP = 32;

/** 처음 열 때 폭. 넓은 화면은 px 상한, 좁은 화면은 화면 비율이 이긴다. */
export function initialDetailDrawerWidth(viewport: number = window.innerWidth): number {
  return Math.round(Math.min(DETAIL_DRAWER_MAX_WIDTH, (viewport * DETAIL_DRAWER_VIEWPORT_PERCENT) / 100));
}

/**
 * 끌거나 키보드로 바꾼 폭을 허용 범위 안으로 맞춘다.
 * 화면이 최소 폭보다 좁아 상한이 하한보다 작으면 상한을 따른다(서랍이 화면 밖으로 나가지 않게).
 */
export function clampDetailDrawerWidth(width: number, viewport: number = window.innerWidth): number {
  const max = Math.floor((viewport * DETAIL_DRAWER_RESIZE_MAX_PERCENT) / 100);
  return Math.round(Math.min(max, Math.max(DETAIL_DRAWER_MIN_WIDTH, width)));
}

/**
 * 본문 영역이 시작하는 화면 세로 위치(px).
 *
 * 서랍은 화면 위에 겹쳐 뜨는데(포털) 상단 막대가 서랍보다 위에 있다(`zIndex.drawer + 1`).
 * 서랍을 화면 맨 위에서 시작하면 제목과 닫기 단추가 상단 막대에 가려진다. 그래서 본문 영역의
 * 위치를 재서 그 아래에서 시작한다. 연결 상태 띠가 뜨고 지면 본문 위치가 바뀌므로 상수로 박지 않는다.
 */
export function useContentTopOffset(): number {
  // `shellMetrics` 는 `as const` 라 타입 인자를 주지 않으면 리터럴 48 로 좁혀진다.
  const [top, setTop] = useState<number>(shellMetrics.topbarHeight);

  useEffect(() => {
    const main = document.getElementById(MAIN_ELEMENT_ID);
    if (!main) return;
    const measure = () => setTop(Math.round(main.getBoundingClientRect().top));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(main);
    return () => observer.disconnect();
  }, []);

  return top;
}
