/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 예시 JSON 에서 답 저장 형식의 스키마 초안을 만든다(cogentai-aas-docs 웹훅 스펙 2026-11-18-008 E9 규칙, 답 저장 스펙 2026-11-18-012 §2-1).
// LLM 을 쓰지 않는다. 정수만 있는 값은 integer, 소수는 number, 원소 꼴이 섞인 배열은 첫 원소 꼴, null 값 키는 required 에서 빼고
// 문자열·null 로 둔다. 짐작한 곳(섞인 배열·빈 배열·null)은 checks 에 경로를 담아 「형식 확인 필요」로 보인다.
// 만든 초안은 검사기(validate.ts)를 통과한다. title·description 은 비워 두고 관리자가 채운다.

type Obj = Record<string, unknown>;

export interface Draft {
  schema: Obj;
  /** 형식 확인이 필요한 JSON 경로 */
  checks: string[];
}

const ptr = (path: string, key: string | number) => `${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;

function kind(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v === 'object' ? 'object' : typeof v;
}

function node(v: unknown, path: string, checks: string[], depth: number): Obj {
  const k = kind(v);
  if (depth >= 30) {
    checks.push(path);
    return { type: 'string' };
  }
  if (k === 'object') {
    const o = v as Obj;
    const properties: Obj = {};
    const required: string[] = [];
    for (const [key, x] of Object.entries(o)) {
      properties[key] = node(x, ptr(path, key), checks, depth + 2);
      if (x !== null) required.push(key);
    }
    return { type: 'object', properties, ...(required.length ? { required } : {}) };
  }
  if (k === 'array') {
    const a = v as unknown[];
    if (!a.length) {
      checks.push(path);
      return { type: 'array', items: { type: 'string' } };
    }
    const kinds = new Set(a.map(kind).map((x) => (x === 'integer' ? 'number' : x)));
    if (kinds.size > 1) checks.push(path);
    // 정수와 소수가 섞이면 number 로 넓힌다
    const first = a.every((x) => typeof x === 'number') && a.some((x) => !Number.isInteger(x)) ? 1.5 : a[0];
    return { type: 'array', items: node(first, ptr(path, 'items'), checks, depth + 1) };
  }
  if (k === 'null') {
    checks.push(path);
    return { type: ['string', 'null'] };
  }
  if (k === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:\d{2})$/.test(v as string)) return { type: 'string', format: 'date-time' };
  if (k === 'string') return { type: 'string', maxLength: Math.max(80, Math.min(4000, (v as string).length * 4)) };
  return { type: k };
}

/** 예시 JSON 글 → 초안. 맨 위가 객체가 아니면 오류 */
export function draftSchema(exampleText: string): Draft | { error: string } {
  let v: unknown;
  try {
    v = JSON.parse(exampleText);
  } catch (e) {
    return { error: (e as Error).message };
  }
  if (kind(v) !== 'object') return { error: 'the example must be a JSON object' };
  const checks: string[] = [];
  const schema = node(v, '', checks, 1);
  return { schema: { ...schema, additionalProperties: false }, checks };
}
