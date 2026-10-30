/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 따라하기 진행 상태(OMAI-1274 V7·V8·V22·V24). 진행 중인 가이드는 하나이고, 기록은 사용자별이다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bannerHidden,
  doneGuides,
  finishGuide,
  guideRunState,
  hideBanner,
  pauseGuide,
  resetGuideRunForTest,
  resumable,
  resumeGuide,
  setGuideStep,
  setGuideUser,
  startGuide,
} from './guideRun';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetGuideRunForTest();
});
afterEach(() => vi.restoreAllMocks());

describe('따라하기 진행 상태', () => {
  it('시작하면 1단계이고 화면 이동 요청 번호가 올라간다', () => {
    setGuideUser('kim@x');
    const before = guideRunState().navSeq;
    startGuide('user.my-agents');
    expect(guideRunState().run).toEqual({ id: 'user.my-agents', step: 0, collapsed: false });
    expect(guideRunState().navSeq).toBe(before + 1);
  });

  it('없는 가이드는 시작하지 않고, 범위 밖 단계로는 옮기지 않는다', () => {
    setGuideUser('kim@x');
    startGuide('nope');
    expect(guideRunState().run).toBeNull();
    startGuide('user.my-agents');
    setGuideStep(5);
    expect(guideRunState().run?.step).toBe(0);
  });

  it('× 로 멈추면 「이어서 하기」로 같은 단계부터 다시 시작한다', () => {
    setGuideUser('kim@x');
    startGuide('user.first-chat');
    setGuideStep(2);
    pauseGuide();
    expect(guideRunState().run).toBeNull();
    expect(resumable()).toMatchObject({ id: 'user.first-chat', step: 2 });
    resumeGuide();
    expect(guideRunState().run).toMatchObject({ id: 'user.first-chat', step: 2 });
  });

  it('V24 진행 중인 가이드는 하나다: 다른 가이드를 시작하면 앞 가이드는 이어서 할 수 없다(「안 함」)', () => {
    setGuideUser('kim@x');
    startGuide('user.first-chat');
    setGuideStep(1);
    startGuide('user.my-agents');
    pauseGuide();
    expect(resumable()?.id).toBe('user.my-agents');
  });

  it('V7 새로고침 뒤 같은 사용자면 이어지고, 다른 사용자나 없는 가이드면 버린다', () => {
    setGuideUser('kim@x');
    startGuide('user.first-chat');
    setGuideStep(1);
    resetGuideRunForTest(); // 새로고침: 모듈 상태가 비고 sessionStorage 만 남는다
    setGuideUser('kim@x');
    expect(guideRunState().run).toMatchObject({ id: 'user.first-chat', step: 1 });

    resetGuideRunForTest();
    setGuideUser('lee@x');
    expect(guideRunState().run).toBeNull();
    expect(sessionStorage.getItem('aas-guide-run')).toBeNull();

    sessionStorage.setItem('aas-guide-run', JSON.stringify({ id: 'gone.guide', step: 0, user: 'lee@x' }));
    resetGuideRunForTest();
    setGuideUser('lee@x');
    expect(guideRunState().run).toBeNull();
  });

  it('V24 끝내면 끝냄으로 기록하고 완료 카드를 띄운다. 요청 안내만 하는 가이드는 기록하지 않는다', () => {
    setGuideUser('kim@x');
    startGuide('user.my-agents');
    finishGuide();
    expect(guideRunState().finished).toBe('user.my-agents');
    expect(doneGuides().has('user.my-agents')).toBe(true);
    expect(resumable()).toBeNull();

    startGuide('user.change-model');
    finishGuide();
    expect(doneGuides().has('user.change-model')).toBe(false);
  });

  it('V7·13A 끝냄 표시와 띠 숨김은 사용자별이다', () => {
    setGuideUser('kim@x');
    startGuide('user.my-agents');
    finishGuide();
    hideBanner();
    setGuideUser('lee@x');
    expect(doneGuides().size).toBe(0);
    expect(bannerHidden()).toBe(false);
    setGuideUser('kim@x');
    expect(doneGuides().has('user.my-agents')).toBe(true);
    expect(bannerHidden()).toBe(true);
  });

  it('V22 로그인을 끈 설치는 anon 으로 기록한다', () => {
    setGuideUser('anon');
    startGuide('user.my-agents');
    finishGuide();
    expect(localStorage.getItem('aas-guide-done:anon')).toContain('user.my-agents');
  });

  it('V8 저장소가 예외를 던져도 따라하기는 동작한다', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    setGuideUser('kim@x');
    startGuide('user.first-chat');
    setGuideStep(1);
    expect(guideRunState().run?.step).toBe(1);
    finishGuide();
    expect(guideRunState().finished).toBe('user.first-chat');
    expect(doneGuides().size).toBe(0);
  });
});
