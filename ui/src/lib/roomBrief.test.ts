/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';

import { setLang } from '@/i18n';

import { briefSummary, buildBrief, parseBrief } from './roomBrief';

afterEach(() => setLang('ko'));

describe('TFT 방 목적 항목(스펙 2026-10-18-004)', () => {
  it('빈 항목은 넣지 않고 ### 머리로 정해진 순서로 만든다', () => {
    expect(buildBrief({ due: ' 10월 25일 ', goal: '제안서 초안 확정', how: '' })).toBe('### 목표\n제안서 초안 확정\n\n### 기한\n10월 25일');
    expect(buildBrief({})).toBe('');
    setLang('en');
    expect(buildBrief({ goal: 'Finish the draft' })).toBe('### Goal\nFinish the draft');
  });

  it('만든 글을 다시 항목으로 읽고, 다른 언어의 머리도 알아본다', () => {
    const b = { goal: '확정', result: '- 초안 1부\n- 비교표', refs: 'https://x' };
    expect(parseBrief(buildBrief(b))).toEqual(b);
    expect(parseBrief('### Goal\nFinish\n\n### Due\nFriday')).toEqual({ goal: 'Finish', due: 'Friday' });
  });

  it('머리가 없는 옛 글은 통째로 추가 설명에, 모르는 ### 줄은 앞 항목의 글로 둔다', () => {
    expect(parseBrief('결제 지연 대응\n둘째 줄')).toEqual({ notes: '결제 지연 대응\n둘째 줄' });
    expect(parseBrief('### 목표\n확정\n### 세부\n하나')).toEqual({ goal: '확정\n### 세부\n하나' });
    expect(parseBrief('앞 글\n### 목표\n확정')).toEqual({ notes: '앞 글', goal: '확정' });
    expect(parseBrief('')).toEqual({});
  });

  it('요약은 목표의 첫 줄, 없으면 글의 첫 줄', () => {
    expect(briefSummary('### 목표\n- 제안서 확정\n둘째')).toBe('제안서 확정');
    expect(briefSummary('### 기한\n금요일')).toBe('금요일');
    expect(briefSummary('결제 지연')).toBe('결제 지연');
    expect(briefSummary('')).toBe('');
  });
});
