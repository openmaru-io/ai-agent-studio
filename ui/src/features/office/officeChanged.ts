/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 오피스 정보 변경 신호(스펙 2026-10-26-001 §4-1, 리뷰 D8·D9·D13). 토픽 office:changed 는 번호 둘 {n, admin} 만 싣는다.
// 번호가 바뀌면 /api/office 를 자기 권한으로 다시 읽는다. 오피스 화면의 모든 탭(Office())에서 구독한다 — 장면 토픽 office:state 는
// 3D 오피스 탭에서만 구독해, 칸반·회의·TFT 방 탭은 다른 사람이 바꾼 방·핀·현수막을 보지 못했다.
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import { useTopic } from '@/lib/ws';

export interface OfficeChanged {
  /** 모두에게 보이는 오피스 정보가 바뀌면 오른다 */
  n: number;
  /** 관리자에게만 보이는 값(핀·문제 띠·부서)만 바뀌면 오른다 */
  admin: number;
}

/** 이벤트를 묶는 시간. 방 하나를 고칠 때 번호가 연달아 오를 수 있다 */
export const OFFICE_REREAD_BATCH_MS = 500;
/** 묶은 뒤 브라우저마다 더 기다리는 최대 시간. 모든 화면이 같은 신호를 같은 순간에 받아 한꺼번에 읽지 않게 퍼뜨린다(D8) */
export const OFFICE_REREAD_SPREAD_MS = 1000;

/** 다시 읽어야 하나. 처음 받은 값은 HTTP 가 이미 읽은 값과 같다고 본다. 일반 사용자는 admin 번호를 보지 않는다(D13). */
export function officeNeedsReread(prev: OfficeChanged | null, next: OfficeChanged, admin: boolean): boolean {
  if (!prev) return false;
  return prev.n !== next.n || (admin && prev.admin !== next.admin);
}

/** 다시 읽을 때까지 기다릴 시간(ms): 묶기 + 무작위 분산 */
export function officeRereadDelay(random: () => number = Math.random): number {
  return OFFICE_REREAD_BATCH_MS + Math.floor(random() * OFFICE_REREAD_SPREAD_MS);
}

/** office:changed 를 구독해 번호가 바뀌면 ['office'] 를 다시 읽는다. 돌려주는 값이 참이면 토픽이 살아 있다. */
export function useOfficeChanged(admin: boolean, random: () => number = Math.random): boolean {
  const qc = useQueryClient();
  const seen = useRef<OfficeChanged | null>(null);
  const isAdmin = useRef(admin);
  isAdmin.current = admin;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );
  return useTopic<OfficeChanged>('office:changed', (data) => {
    const next = { n: Number(data?.n) || 0, admin: Number(data?.admin) || 0 };
    // 묶는 동안 더 온 신호는 이미 잡힌 한 번의 다시 읽기가 함께 맡는다 — 그 읽기는 신호 뒤에 일어나 새 값을 받는다
    if (officeNeedsReread(seen.current, next, isAdmin.current) && !timer.current) {
      timer.current = setTimeout(() => {
        timer.current = null;
        void qc.invalidateQueries({ queryKey: ['office'] });
      }, officeRereadDelay(random));
    }
    seen.current = next;
  });
}
