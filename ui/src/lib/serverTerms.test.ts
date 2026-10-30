/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';

import { setLang } from '@/i18n';

import { badgeTone, isOffBadge, serverTerm } from './serverTerms';

afterEach(() => setLang('ko'));

describe('serverTerm', () => {
  it('한국어에서는 서버 값 그대로 나온다', () => {
    for (const v of ['꺼짐', '등록됨', '실패 3회', '30일 뒤 만료', '같은 값이 2곳에', '환경마다 버전이 다름 (2가지)', '경로'])
      expect(serverTerm(v)).toBe(v);
  });

  it('영어에서는 고정 값과 숫자가 든 값을 모두 영어로 바꾼다', () => {
    setLang('en');
    expect(serverTerm('꺼짐')).toBe('Off');
    expect(serverTerm('등록됨')).toBe('Registered');
    expect(serverTerm('실패 3회')).toBe('Failed 3 times');
    expect(serverTerm('30일 뒤 만료')).toBe('Expires in 30 days');
    expect(serverTerm('같은 값이 2곳에')).toBe('Same value in 2 places');
    expect(serverTerm('환경마다 버전이 다름 (2가지)')).toBe('Versions differ across environments (2)');
    expect(serverTerm('경로')).toBe('Path');
  });

  it('「전달 실패」는 실행 실패가 아니라 결과 전달 실패다(OMAI-1292) — 영어로 바꾸고 주의 색이다', () => {
    expect(serverTerm('전달 실패')).toBe('전달 실패');
    setLang('en');
    expect(serverTerm('전달 실패')).toBe('Delivery failed');
    expect(badgeTone('전달 실패')).toBe('warn');                      // 빨강(bad)이 아니다
  });

  it('모르는 값은 그대로 돌려준다', () => {
    setLang('en');
    expect(serverTerm('Already English')).toBe('Already English');
    expect(serverTerm('처음 보는 값')).toBe('처음 보는 값');
  });
});

describe('badgeTone · isOffBadge', () => {
  it('색은 언어와 상관없이 서버의 한국어 값으로 정한다', () => {
    setLang('en');
    expect(badgeTone('실패 2회')).toBe('bad');
    expect(badgeTone('만료됨')).toBe('bad');
    expect(badgeTone('비어 있음')).toBe('bad');
    expect(badgeTone('설치되지 않음')).toBe('bad');
    expect(badgeTone('등록됨')).toBe('good');
    expect(badgeTone('알림 없음')).toBe('warn');
    expect(badgeTone('30일 뒤 만료')).toBe('warn');
  });

  it('꺼짐 배지만 거른다', () => {
    expect(isOffBadge('꺼짐')).toBe(true);
    expect(isOffBadge('알림 없음')).toBe(false);
  });
});
