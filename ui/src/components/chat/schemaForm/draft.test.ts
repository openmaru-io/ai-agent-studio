/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 예시 JSON → 스키마 초안(웹훅 스펙 2026-11-18-008 E9 규칙): 정수·소수·null·빈 배열·섞인 배열, 초안은 검사기를 통과한다
import { describe, expect, it } from 'vitest';

import { draftSchema } from './draft';
import { checkSchema } from './validate';

describe('예시 JSON 으로 스키마 만들기', () => {
  it('꼴을 짐작하고 짐작한 곳을 「형식 확인 필요」로 남긴다', () => {
    const out = draftSchema(JSON.stringify({ title: '장애', count: 3, ratio: 0.5, ok: true, when: '2026-11-18T09:00:00+09:00', owner: null, tags: [], mix: [1, 'a'], nums: [1, 2.5], nested: { name: 'x' } }));
    if ('error' in out) throw new Error(out.error);
    const p = out.schema.properties as Record<string, Record<string, unknown>>;
    expect(p.title).toMatchObject({ type: 'string' });
    expect(p.count).toEqual({ type: 'integer' });
    expect(p.ratio).toEqual({ type: 'number' });
    expect(p.ok).toEqual({ type: 'boolean' });
    expect(p.when).toEqual({ type: 'string', format: 'date-time' });
    expect(p.owner).toEqual({ type: ['string', 'null'] });
    expect(p.tags).toEqual({ type: 'array', items: { type: 'string' } });
    expect(p.mix).toEqual({ type: 'array', items: { type: 'integer' } });
    expect(p.nums).toEqual({ type: 'array', items: { type: 'number' } });
    expect(p.nested).toEqual({ type: 'object', properties: { name: { type: 'string', maxLength: 80 } }, required: ['name'] });
    expect(out.schema.required).not.toContain('owner'); // null 값 키는 required 에서 뺀다
    expect(out.schema.additionalProperties).toBe(false);
    expect(out.checks.sort()).toEqual(['/mix', '/owner', '/tags']);
    expect(checkSchema(out.schema).code).toBeNull();
  });

  it('객체가 아니거나 읽을 수 없으면 오류', () => {
    expect('error' in draftSchema('[1]')).toBe(true);
    expect('error' in draftSchema('{')).toBe(true);
  });
});
