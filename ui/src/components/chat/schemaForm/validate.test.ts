/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { checkSchema, checkValue, codePointLength, cutCodePoints, depth, type SchemaError } from './validate';

// 서버 시험(tests/test_answer_format.py VectorsTest)과 같은 파일을 읽는다(스펙 2026-11-18-012 D25⑦)
type Case = { id: string; schema?: unknown; code?: string | null; errors?: Array<[string, string]>; deep?: number; large?: number;
  value?: unknown; deepValue?: number; text?: string; n?: number; out?: string; length?: number };
const VECTORS = JSON.parse(readFileSync(resolve(__dirname, '../../../../../tests/fixtures/answer_schema_vectors.json'), 'utf-8')) as
  Record<'schema' | 'value' | 'cut', Case[]>;

// 서버 시험의 nested_schema·large_schema·nested_value 와 같은 만들기
function nestedSchema(n: number) {
  let [s, d]: [Record<string, unknown>, number] = n % 2 === 0 ? [{ type: 'object', required: ['x'] }, 2] : [{ type: 'object' }, 1];
  while (d < n) [s, d] = [{ type: 'object', properties: { a: s } }, d + 2];
  return s;
}
function largeSchema(n: number) {
  const head = JSON.stringify({ type: 'object', description: '' }).length;
  return { type: 'object', description: 'x'.repeat(n - head) };
}
function nestedValue(n: number) {
  let v: Record<string, unknown> = {};
  for (let i = 0; i < n - 1; i++) v = { a: v };
  return v;
}
const pairs = (errors: SchemaError[]) => errors.map((e) => `${e.path} ${e.keyword}`).sort();
const want = (errors: Array<[string, string]> = []) => errors.map(([p, k]) => `${p} ${k}`).sort();

describe('답 저장 형식 검사기 공용 벡터', () => {
  const ran = new Set<string>();

  afterAll(() => {
    const every = (['schema', 'value', 'cut'] as const).flatMap((k) => VECTORS[k].map((c) => c.id));
    expect(new Set(every).size).toBe(every.length);           // id 중복 없음
    expect([...ran].sort()).toEqual([...every].sort());       // 벡터를 더하고 여기서 빠뜨리면 실패
  });

  it.each(VECTORS.schema.map((c) => [c.id, c] as const))('스키마 %s', (_id, c) => {
    const schema = c.deep !== undefined ? nestedSchema(c.deep) : c.large !== undefined ? largeSchema(c.large) : c.schema;
    const out = checkSchema(schema);
    expect(out.code).toBe(c.code);
    if (c.code !== 'format.too_deep') expect(pairs(out.errors)).toEqual(want(c.errors));
    ran.add(c.id);
  });

  it.each(VECTORS.value.map((c) => [c.id, c] as const))('값 %s', (_id, c) => {
    expect(checkSchema(c.schema).code).toBeNull();
    const value = c.deepValue !== undefined ? nestedValue(c.deepValue) : c.value;
    expect(pairs(checkValue(c.schema as Record<string, unknown>, value))).toEqual(want(c.errors));
    ran.add(c.id);
  });

  it.each(VECTORS.cut.map((c) => [c.id, c] as const))('자르기 %s', (_id, c) => {
    expect(cutCodePoints(c.text!, c.n!)).toBe(c.out);
    if (c.length !== undefined) expect(codePointLength(c.text!)).toBe(c.length);
    ran.add(c.id);
  });

  it('아주 깊은 값도 재귀 없이 센다', () => {
    expect(depth(nestedValue(5000))).toBe(5000);
    expect(pairs(checkValue({ type: 'object' }, nestedValue(5000)))).toEqual([' depth']);
  });
});
