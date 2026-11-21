/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { dictionaries } from '@/i18n';

// 화면 용어(스펙 2026-10-23-003, OMAI-1443): Hermes 설치는 「AI 에이전트 작업공간」, 대화 상대는 「AI 에이전트」.
// 혼자 쓰인 「에이전트」를 남기지 않는다. 용어를 바꾸며 나던 조사·겹침·관사 오류를 함께 막는다(OMAI-1313·1314 §12 구현시 주의사항).
const strip = (v: string) => v.replace(/\{[^}]*\}/g, '');
const found = (dict: Record<string, string>, test: (v: string) => boolean) =>
  Object.entries(dict)
    .filter(([, v]) => test(strip(v)))
    .map(([k]) => k);

describe('화면 용어', () => {
  it('한국어 값에 혼자 쓰인 「에이전트」가 없다', () => {
    expect(found(dictionaries.ko, (v) => /(?<!AI )에이전트/.test(v))).toEqual([]);
  });

  it('영어 값에 혼자 쓰인 agent 가 없다(AGENTS.md 파일 이름은 뺀다)', () => {
    expect(found(dictionaries.en, (v) => /(?<!AI )\bagents?\b/i.test(v.replace(/AGENTS(\.md)?/g, '')))).toEqual([]);
  });

  // 「작업공간」·workspace 만 쓰는 줄임도 막는다(스펙 2026-11-18-009, WRITING_STYLE §6-b).
  // 대화 목록 둘째 줄의 짧은 칩(chat.currentAgentShort)은 이름을 밀어내지 않게 줄였다(2026-11-06). en 의 MindWiki workspace 는 MindWiki 쪽 개념이다.
  const SHORT_OK = new Set(['chat.currentAgentShort']);
  it('한국어 값에 「작업공간」만 쓴 줄임이 없다', () => {
    expect(found(dictionaries.ko, (v) => /(?<!AI 에이전트 )작업공간/.test(v)).filter((k) => !SHORT_OK.has(k))).toEqual([]);
  });

  it('영어 값에 workspace 만 쓴 줄임이 없다', () => {
    const short = (v: string) => /(?<!AI Agent )(?<![\w-])workspaces?\b(?!-)/i.test(v.replace(/MindWiki workspaces?|several workspaces/g, ''));
    expect(found(dictionaries.en, short).filter((k) => !SHORT_OK.has(k))).toEqual([]);
  });

  it('조사·겹침·관사 오류가 없다', () => {
    const ko = /작업공간(가|를|는|와|로\b)|에이전트(을|은|과)|에이전트이 |AI AI|작업공간 작업공간/;
    expect(found(dictionaries.ko, (v) => ko.test(v))).toEqual([]);
    expect(found(dictionaries.en, (v) => /\b[Aa] AI\b|AI AI/.test(v))).toEqual([]);
  });
});
