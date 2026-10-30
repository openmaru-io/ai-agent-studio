/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 프로파일 상세가 보는 「위치」(탭 pane·비밀값 key·MCP server·인증 파일 file·채널 add)와 그 위치를 바꾸는 법(스펙 2026-10-26-003 §5-8, 외부 검토 M2).
// - 메뉴에서 연 서랍(주소 서랍)은 지금처럼 주소 검색 값을 읽고 쓴다.
// - 서랍 안에서 연 프로파일 페이지는 페이지 값을 읽고, 바꿀 때는 지금 페이지를 바꿔 넣는다(기록을 쌓지 않는다). 주소를 쓰면 뒤의 메뉴 서랍이 바뀐다.
import { createContext, useContext } from 'react';

import { useParamPatch, useRouteDrawerParams } from '@/components/useRouteDrawer';

export type SpotChanges = Record<string, string | null | undefined>;

export interface ProfileSpot {
  /** 서랍 안 페이지인가(주소를 쓰지 않는다) */
  page: boolean;
  get: (key: string) => string | null;
  /** 값을 바꾼다. name 을 null 로 주면 이 상세를 떠난다(지운 뒤 등) */
  patch: (changes: SpotChanges, opts?: { replace?: boolean }) => void;
}

export const ProfileSpotContext = createContext<ProfileSpot | null>(null);

/** 지금 프로파일 상세의 위치. 서랍 안 페이지가 아니면 주소다 — 뒤로 가기로 저장 확인을 묻는 동안은 묻기 전 주소다(useRouteDrawerParams) */
export function useProfileSpot(): ProfileSpot {
  const ctx = useContext(ProfileSpotContext);
  const params = useRouteDrawerParams('name');
  const patchParams = useParamPatch();
  return ctx ?? { page: false, get: (k) => params.get(k), patch: patchParams };
}
