/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { Suspense, useEffect } from 'react';
import { Navigate, Route, Routes, useParams } from 'react-router-dom';

import { AppShell } from '@/components/AppShell';
import { ScreenLoading } from '@/components/bits';
import { ScreenBoundary } from '@/components/ScreenBoundary';
import { viewById } from '@/lib/views';
import { SCREENS } from '@/pages/screens';

function ViewPage() {
  const { viewId = '' } = useParams();
  const view = viewById(viewId);
  useEffect(() => {
    if (view) document.title = `${view.label} — AAS`;
  }, [view]);
  if (!view) return <Navigate to="/dashboard" replace />; // 옛 주소 #/home 도 여기로 온다
  const Screen = SCREENS[view.id];
  if (!Screen) return <Navigate to="/dashboard" replace />;
  // 목록 화면은 지연 로딩이라(pages/screens.ts) 받는 동안 화면 제목과 진행 막대를 보인다.
  // 묶음을 받지 못하거나 화면이 오류를 내면 그 화면 자리에만 안내를 보인다(ScreenBoundary). key 로 메뉴를 옮기면 경계를 새로 둔다
  return (
    <ScreenBoundary key={view.id} title={view.label}>
      <Suspense fallback={<ScreenLoading title={view.label} />}>
        <Screen />
      </Suspense>
    </ScreenBoundary>
  );
}

export function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/:viewId/*" element={<ViewPage />} />
      </Routes>
    </AppShell>
  );
}
