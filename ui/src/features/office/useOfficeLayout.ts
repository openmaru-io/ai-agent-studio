/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 서버 레이아웃(계획 007 P−1). 모두가 같은 가구 배치를 본다 — 브라우저 저장소를 쓰지 않는다.
// 판은 서버가 배포 때 실린 기본 배치로 만든다(계획 2026-10-13-001). 화면은 읽기만 한다(관리자 편집은 EditPanel).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import type { FurnitureItem } from '@/features/office/scene3d/retro-office/core/types';
import { get } from '@/lib/api';

export interface ServerLayout {
  version: number;
  items: FurnitureItem[] | null;
  desks: Record<string, string>;
}

export function useOfficeLayout(version: number | undefined) {
  const qc = useQueryClient();
  const q = useQuery<ServerLayout>({
    queryKey: ['office-layout', version ?? -1],
    queryFn: () => get<ServerLayout>('/api/office/layout'),
    staleTime: Infinity,
  });
  // 기본 배치는 서버가 만든다(계획 2026-10-13-001 §3-5) — 브라우저가 판을 올리지 않는다. 판이 아직 없으면 잠시 뒤 다시 읽는다
  const bootstrap = useCallback(() => {
    window.setTimeout(() => void qc.invalidateQueries({ queryKey: ['office-layout'] }), 3000);
  }, [qc]);
  return { layout: q.data, error: q.error as Error | null, bootstrap };
}
