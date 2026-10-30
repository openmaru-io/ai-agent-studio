/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { activeToken, afterLeadingMentions, applyPick, filterItems, findMentions, leadingCommand, SuggestItem } from './composerSuggest';

const skills: SuggestItem[] = [
  { value: '/web-research', label: '/web-research', detail: '웹 검색' },
  { value: '/요약', label: '/요약', detail: '주간 업무를 요약합니다' },
  { value: '/보고서-요약', label: '/보고서-요약', detail: '보고서' },
];
const people = [
  { alias: 'admin', label: '관리자' },
  { alias: 'admin2', label: '관리자 에이전트' },
  { alias: 'doc', label: 'doc' },
];

describe('activeToken — 목록을 여는 낱말(스펙 2026-10-19-012 P3)', () => {
  it('「/」는 글 맨 앞(앞 공백 건너뜀)에서만 연다. 글 중간의 경로·분수는 아니다', () => {
    expect(activeToken('/요', 2, '/', 'start')).toEqual({ start: 0, end: 2, query: '요' });
    expect(activeToken('  /', 3, '/', 'start')).toEqual({ start: 2, end: 3, query: '' });
    expect(activeToken('경로 /etc', 7, '/', 'start')).toBeNull();
    expect(activeToken('1/2', 2, '/', 'start')).toBeNull();
  });

  it('공백을 치면 닫힌다(DD2). 커서가 낱말 밖이면 닫힌다', () => {
    expect(activeToken('/요약 ', 4, '/', 'start')).toBeNull();
    expect(activeToken('/요약 정리', 6, '/', 'start')).toBeNull();
    expect(activeToken('/요약', 0, '/', 'start')).toBeNull();
  });

  it('회의실은 앞의 @이름 들 뒤가 시작이다', () => {
    const v = '@관리자 에이전트 /요';
    expect(activeToken(v, v.length, '/', 'start', afterLeadingMentions(v, people))).toEqual({ start: 10, end: 12, query: '요' });
  });

  it('「@」는 맨 앞이나 공백 뒤에서 연다. 이메일 같은 글자 사이 @ 는 아니다', () => {
    expect(activeToken('@관', 2, '@', 'word')).toEqual({ start: 0, end: 2, query: '관' });
    expect(activeToken('안녕 @d', 5, '@', 'word')).toEqual({ start: 3, end: 5, query: 'd' });
    expect(activeToken('a@b.com', 3, '@', 'word')).toBeNull();
    expect(activeToken('@doc ', 5, '@', 'word')).toBeNull();
  });

  it('낱말 가운데서 고치면 end 는 낱말 끝이다', () => {
    expect(activeToken('/요약정리 글', 2, '/', 'start')).toEqual({ start: 0, end: 5, query: '요' });
  });
});

describe('filterItems', () => {
  it('들어 있는 것을 고르고 앞부분이 맞는 것을 위로, 최대 8줄', () => {
    expect(filterItems(skills, '요약').map((x) => x.value)).toEqual(['/요약', '/보고서-요약']);
    expect(filterItems(skills, 'WEB').map((x) => x.value)).toEqual(['/web-research']);
    expect(filterItems(skills, '검색').map((x) => x.value)).toEqual(['/web-research']); // 설명도 본다
    expect(filterItems(skills, 'zzz')).toEqual([]);
    const many = Array.from({ length: 12 }, (_, i) => ({ value: `/s${i}`, label: `/s${i}` }));
    expect(filterItems(many, '')).toHaveLength(8);
  });

  it('search 필드(번역된 설명의 원문)로도 맞는다 — 화면에는 보이지 않는 글(스펙 2026-10-19-017 P6)', () => {
    const box = { value: '/box', label: '/box', detail: '클라우드 파일을 관리한다', search: 'Box manages cloud files' };
    expect(filterItems([box], 'cloud').map((x) => x.value)).toEqual(['/box']);
    expect(filterItems([box], '클라우드').map((x) => x.value)).toEqual(['/box']);
  });
});

describe('applyPick', () => {
  it('낱말을 바꾸고 공백 하나 뒤에 커서를 둔다', () => {
    expect(applyPick('/요', { start: 0, end: 2, query: '요' }, skills[1])).toEqual({ value: '/요약 ', caret: 4 });
    expect(applyPick('/요 정리', { start: 0, end: 2, query: '요' }, skills[1])).toEqual({ value: '/요약 정리', caret: 4 });
    expect(applyPick('안녕 @관', { start: 3, end: 5, query: '관' }, { value: '@관리자 에이전트', label: '' })).toEqual({
      value: '안녕 @관리자 에이전트 ',
      caret: 13,
    });
  });
});

describe('leadingCommand — 보낼 때 스킬로 떼는 낱말(R7·DD6)', () => {
  it('맨 앞 /낱말이 목록에 있을 때만', () => {
    expect(leadingCommand('/요약 이번 주', skills)?.value).toBe('/요약');
    expect(leadingCommand('/없는것 글', skills)).toBeNull();
    expect(leadingCommand('그냥 /요약', skills)).toBeNull();
    expect(leadingCommand('/요약', null)).toBeNull(); // 목록을 아직 읽지 않았으면 글로 간다
    expect(leadingCommand('@doc /요약 해 줘', skills, afterLeadingMentions('@doc /요약 해 줘', people))?.value).toBe('/요약');
  });
});

describe('findMentions — 회의실 받는 대상(P5)', () => {
  it('한글·띄어쓰기 이름, 별칭, 여러 명', () => {
    expect(findMentions('@관리자 에이전트 확인해 줘', people)).toEqual(['admin2']); // 긴 이름이 이긴다
    expect(findMentions('@관리자 확인', people)).toEqual(['admin']);
    expect(findMentions('@doc 일정 확인해 줘', people)).toEqual(['doc']); // 별칭 그대로(R6 회귀)
    expect(findMentions('@관리자, @doc 둘 다', people)).toEqual(['admin', 'doc']);
  });

  it('이름 뒤에 글자가 붙거나 @ 앞에 글자가 있으면 아니다', () => {
    expect(findMentions('@관리자님 확인', people)).toEqual([]);
    expect(findMentions('mail@doc', people)).toEqual([]);
  });

  it('afterLeadingMentions 는 앞에 이어진 @이름 뒤 위치', () => {
    expect(afterLeadingMentions('@doc @관리자 /요', people)).toBe(10);
    expect(afterLeadingMentions('/요', people)).toBe(0);
    expect(afterLeadingMentions('@모름 /요', people)).toBe(0);
  });
});
