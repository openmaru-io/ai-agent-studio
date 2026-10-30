/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Text } from '@/features/office/scene3d/Text';

// 글꼴이 끝내 오지 않는 상황. drei <Text> 는 preloadFont 를 기다리며 멈춰(suspend) 바깥 Suspense 대기 화면을 띄운다.
// node_modules 안의 import 에는 모의가 닿지 않아 drei <Text> 자리를 같은 방식으로 멈추는 구현으로 바꿔 둔다
vi.mock('@react-three/drei', () => ({
  Text: () => {
    throw new Promise(() => {});
  },
}));
vi.mock('troika-three-text', () => ({
  Text: class {
    sync() {}
    dispose() {}
  },
  preloadFont: () => {},
}));
vi.mock('@react-three/fiber', () => ({
  useThree: (sel: (s: { invalidate: () => void }) => unknown) => sel({ invalidate: () => {} }),
}));

describe('3D 장면 글자', () => {
  it('글꼴을 받는 동안 멈추지 않는다 — 멈추면 오피스 화면의 대기 문구가 장면을 다시 가린다', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {}); // jsdom 은 <primitive> 를 모른다
    render(
      <Suspense fallback={<span>대기</span>}>
        <Text>회의실</Text>
      </Suspense>
    );
    expect(screen.queryByText('대기')).toBeNull();
  });
});
