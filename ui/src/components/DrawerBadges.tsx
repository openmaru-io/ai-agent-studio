/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 서랍 본문의 상태 뱃지(기본·게이트웨이 실행 중 등)를 서랍 머리의 제목 바로 옆에 그린다.
// 본문이 <DrawerBadges>…</DrawerBadges> 를 그리면 뱃지는 포털로 머리의 `[data-drawer-badges]` 자리에 간다.
// 뱃지는 본문의 React 트리에 남아 본문의 자료를 그대로 쓴다. 서랍 밖(화면)에서는 놓인 자리에 그대로 그린다.
import { ReactNode, useContext } from 'react';
import { createPortal } from 'react-dom';

import { DrawerHeadSlotContext } from './drawerScope';

export function DrawerBadges({ children }: { children: ReactNode }) {
  const slot = useContext(DrawerHeadSlotContext);
  if (!slot) return <>{children}</>;
  if (!slot.active || !slot.badges) return null; // 쌓인 아래 서랍이거나 머리 자리가 아직 없다
  return createPortal(children, slot.badges);
}

/** 본문의 짧은 설명(권한 안내 등)을 서랍 머리의 부제목 옆에 그린다. 탭 줄 옆에 두면 탭이 다 보이지 않고 넘겼다.
 *  서랍 밖(화면)에서는 놓인 자리에 그대로 그린다. */
export function DrawerNote({ children }: { children: ReactNode }) {
  const slot = useContext(DrawerHeadSlotContext);
  if (!slot) return <>{children}</>;
  if (!slot.active || !slot.note) return null;
  return createPortal(children, slot.note);
}
