/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { dictionaries } from '@/i18n';

import { cleanSkillBody } from './skillTemplate';

const TEMPLATE = dictionaries.ko['skills.bodyTemplate'];
const fill = (heading: string, line: string, body = TEMPLATE) => {
  const at = body.indexOf(heading);
  const end = body.indexOf('\n', body.indexOf('-->', at)) + 1;
  return body.slice(0, end) + line + '\n' + body.slice(end).replace(/^(- |1\. )\n/, '');
};

describe('cleanSkillBody (2026-10-28-004)', () => {
  it('틀을 그대로 두면 제목만 남아 빈 본문이다', () => {
    expect(cleanSkillBody(TEMPLATE.replace('# 스킬 이름', '# weekly'), TEMPLATE)).toEqual({ body: '# weekly\n', empty: true });
  });

  it('채운 절과 제목은 남기고 틀 주석과 빈 절은 지운다', () => {
    let b = fill('## When to Use (언제 쓰나)', '- 「주간 보고서 만들어 줘」');
    b = fill('## 절차', '1. `web_search` 로 찾는다', b);
    const r = cleanSkillBody(b, TEMPLATE);
    expect(r.empty).toBe(false);
    expect(r.body).toBe('# 스킬 이름\n\n## When to Use (언제 쓰나)\n- 「주간 보고서 만들어 줘」\n\n## 절차\n1. `web_search` 로 찾는다\n');
    expect(r.body).not.toContain('<!--');
    expect(r.body).not.toContain('mcp__');
  });

  it('사용자가 쓴 주석과 한 글자라도 고친 틀 주석은 남긴다', () => {
    const edited = TEMPLATE.replace('두세 문장으로 적습니다.', '두세 문장으로 적습니다!').replace('## 확인\n', '## 확인\n<!-- 내 메모 -->\n');
    const r = cleanSkillBody(edited, TEMPLATE);
    expect(r.body).toContain('두세 문장으로 적습니다!');
    expect(r.body).toContain('<!-- 내 메모 -->');
    expect(r.empty).toBe(false);
  });

  it('제목 없는 글과 빈 줄이 셋 이상인 곳을 정리한다', () => {
    expect(cleanSkillBody('# a\n\n\n\n소개 글\n', TEMPLATE)).toEqual({ body: '# a\n\n소개 글\n', empty: false });
    expect(cleanSkillBody('', TEMPLATE)).toEqual({ body: '\n', empty: true });
  });

  it('영어 틀도 같은 절 수와 주석 수다', () => {
    const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;
    const en = dictionaries.en['skills.bodyTemplate'];
    expect(count(en, /^## /gm)).toBe(count(TEMPLATE, /^## /gm));
    expect(count(en, /<!--/g)).toBe(count(TEMPLATE, /<!--/g));
    expect(en).toMatch(/^## When to Use$/m);
    expect(TEMPLATE).toMatch(/^## When to Use \(언제 쓰나\)$/m); // Hermes lint 가 찾는 제목(D2)
    expect(cleanSkillBody(en, en).empty).toBe(true);
  });
});
