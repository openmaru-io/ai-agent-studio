/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { skillSuggestItems } from './skillSuggest';

const SRC = 'Box manages cloud files, sharing, search, and metadata.';
const row = { command: '/box', name: 'box', description: '클라우드 파일을 관리한다', description_src: SRC, usage: 0, agents: ['sa'] };

describe('skillSuggestItems — 번역된 설명(스펙 2026-10-19-017 P6)', () => {
  it('아랫줄에는 번역만, 마우스 올림에는 원문, 거르기에는 원문 낱말', () => {
    const [it0] = skillSuggestItems({ skills: [row] } as never)!;
    expect(it0.detail).toBe('클라우드 파일을 관리한다');
    expect(it0.title).toBe(SRC);
    expect(it0.search).toBe(SRC);
  });

  it('회의실도 같은 규칙이고, 빠진 에이전트 안내는 그대로 붙는다', () => {
    const [it0] = skillSuggestItems({ skills: [row] } as never, { targets: ['sa', 'scdf'], label: (a) => a })!;
    expect(it0.detail).toBe('클라우드 파일을 관리한다');
    expect(it0.search).toBe(SRC);
    expect(it0.title?.startsWith(SRC)).toBe(true);
  });

  it('번역이 없으면 지금처럼 설명이 title 이다', () => {
    const [it0] = skillSuggestItems({ skills: [{ ...row, description: SRC, description_src: undefined }] } as never)!;
    expect(it0.title).toBe(SRC);
    expect(it0.search).toBeUndefined();
  });
});
