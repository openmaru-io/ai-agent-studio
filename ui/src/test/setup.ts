/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import '@testing-library/jest-dom';

import type { EmotionCache } from '@emotion/cache';
import { __unsafe_useEmotionCache as useEmotionCache } from '@emotion/react';
import { cleanup, configure, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, vi } from 'vitest';

import { closeViewer } from '@/components/files/viewerStore';

// GitHub Actions(CI=true) 러너가 느려 findBy* 가 기본 1초 안에 요소를 못 찾았다(2026-10-30, vitest.config.ts 의 testTimeout 과 같은 이유)
if (process.env.CI) configure({ asyncUtilTimeout: 5000 });

// MUI 가 쓰는 Emotion 의 기본 캐시는 모듈 하나라, 시험이 끝나도 넣은 <style> 이 document.head 에 남는다(cleanup 은 body 만 치운다).
// 쌓이면 jsdom 의 getComputedStyle 이 스타일시트 수만큼 느려져 getByRole·findByRole 을 쓰는 뒤 시험이 시간 초과·요소 못 찾음으로 실패했다
// (Office 시험 한 파일에서 158 → 1,872개, 같은 시험이 혼자 1.5초 → 뒤에서 8초, 2026-10-22). 시험마다 캐시를 비워 그 시험의 스타일만 남긴다.
let emotionCache: EmotionCache | null = null;
function GrabEmotionCache() {
  emotionCache = useEmotionCache();
  return null;
}
render(createElement(GrabEmotionCache)).unmount();

afterEach(() => {
  cleanup();
  if (emotionCache) {
    emotionCache.sheet.flush();                      // 넣은 <style> 을 지운다
    for (const key of Object.keys(emotionCache.inserted)) delete emotionCache.inserted[key]; // 다음 시험이 같은 규칙을 다시 넣게
  }
  // 파일 뷰어는 화면 전체가 함께 쓰는 모듈 상태다 — 시험 사이에 남으면 다음 화면을 가린다(스펙 2026-10-20-002)
  closeViewer(false);
});

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// jsdom 에는 없다. 서랍·팔레트가 쓰는 스크롤 보조를 막지 않게 한다.
window.scrollTo = vi.fn();

// jsdom 에서는 Monaco 가 돌지 않는다. 글 편집 칸을 같은 약속을 지키는 입력칸으로 바꾼다(src/test/PlainEditor.tsx).
vi.mock('@/components/LazyCodeEditor', async () => ({ LazyCodeEditor: (await import('./PlainEditor')).PlainEditor }));
