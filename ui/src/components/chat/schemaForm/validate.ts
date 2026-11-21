/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 답 저장 형식의 작은 JSON Schema 검사기(cogentai-aas-docs security/chat-embed-save-answer 2026-11-18-012 D3·D25⑦).
// 서버 aas/ops/answer_format.py 와 같은 결과를 낸다 — 두 쪽 시험이 tests/fixtures/answer_schema_vectors.json 을 함께 읽고
// 모든 id 를 돌렸는지 확인한다. 받는 키워드만 다루고 그 밖은 키워드와 JSON 경로를 담아 거절한다.
// 글자 수는 코드 포인트로 센다(Array.from). JS 의 .length·.slice 는 UTF-16 단위라 이모지를 반으로 자른다.

export const SCHEMA_MAX_BYTES = 16 * 1024;
export const DEPTH_MAX = 32;

export type SchemaError = { path: string; keyword: string; message: string };
export type SchemaCode = 'format.schema_invalid' | 'format.too_deep';

const TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'] as const;
const CHECKED = new Set(['type', 'properties', 'required', 'items', 'enum', 'maxLength', 'minLength', 'minimum', 'maximum',
  'additionalProperties', 'format', 'description']);
const IGNORED = new Set(['$schema', '$comment', 'title', 'examples', 'default']);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNonNegInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const err = (path: string, keyword: string, message: string): SchemaError => ({ path, keyword, message });
const ptr = (path: string, key: string | number) => `${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;

/** 앞 n 코드 포인트. */
export function cutCodePoints(text: string, n: number): string {
  return Array.from(text ?? '').slice(0, Math.max(0, n)).join('');
}

export function codePointLength(text: string): number {
  return Array.from(text ?? '').length;
}

/** 그릇(object·array) 겹 수. 재귀 대신 쌓기로 센다. */
export function depth(value: unknown): number {
  let best = 0;
  const stack: Array<[unknown, number]> = [[value, 1]];
  while (stack.length) {
    const [v, d] = stack.pop()!;
    if (Array.isArray(v)) {
      best = Math.max(best, d);
      for (const x of v) stack.push([x, d + 1]);
    } else if (isObj(v)) {
      best = Math.max(best, d);
      for (const x of Object.values(v)) stack.push([x, d + 1]);
    }
  }
  return best;
}

export function checkSchema(schema: unknown): { code: SchemaCode | null; errors: SchemaError[] } {
  if (!isObj(schema)) return { code: 'format.schema_invalid', errors: [err('', 'type', 'schema must be a JSON object')] };
  if (depth(schema) > DEPTH_MAX) return { code: 'format.too_deep', errors: [err('', 'depth', `schema is deeper than ${DEPTH_MAX}`)] };
  if (new TextEncoder().encode(JSON.stringify(schema)).length > SCHEMA_MAX_BYTES) {
    return { code: 'format.too_deep', errors: [err('', 'size', `schema is larger than ${SCHEMA_MAX_BYTES} bytes`)] };
  }
  const errors: SchemaError[] = [];
  if (schema.type !== 'object') errors.push(err('/type', 'type', 'the top level must be "type": "object"'));
  const stack: Array<[unknown, string]> = [[schema, '']];
  while (stack.length) {
    const [node, path] = stack.pop()!;
    if (!isObj(node)) {
      errors.push(err(path, 'type', 'must be a schema object'));
      continue;
    }
    for (const [key, val] of Object.entries(node)) {
      const here = ptr(path, key);
      if (IGNORED.has(key)) continue;
      if (!CHECKED.has(key)) {
        errors.push(err(here, key, `keyword "${key}" is not supported`));
      } else if (key === 'type') {
        const names = Array.isArray(val) ? val : [val];
        if (!names.length || names.some((n) => !(TYPES as readonly unknown[]).includes(n)) || new Set(names.map(String)).size !== names.length) {
          errors.push(err(here, 'type', `type must be one of ${TYPES.join(', ')} or a list of them`));
        }
      } else if (key === 'properties') {
        if (!isObj(val)) errors.push(err(here, 'properties', 'properties must be an object'));
        else for (const [k, sub] of Object.entries(val)) stack.push([sub, ptr(here, k)]);
      } else if (key === 'required') {
        if (!Array.isArray(val) || val.some((x) => typeof x !== 'string')) errors.push(err(here, 'required', 'required must be a list of strings'));
      } else if (key === 'items') {
        if (!isObj(val)) errors.push(err(here, 'items', 'items must be one schema object'));
        else stack.push([val, here]);
      } else if (key === 'enum') {
        if (!Array.isArray(val) || !val.length) errors.push(err(here, 'enum', 'enum must be a non-empty list'));
      } else if (key === 'maxLength' || key === 'minLength') {
        if (!isNonNegInt(val)) errors.push(err(here, key, `${key} must be a non-negative integer`));
      } else if (key === 'minimum' || key === 'maximum') {
        if (!isNum(val)) errors.push(err(here, key, `${key} must be a number`));
      } else if (key === 'additionalProperties') {
        if (val !== false) errors.push(err(here, key, 'only additionalProperties: false is supported'));
      } else if (key === 'format') {
        if (val !== 'date-time') errors.push(err(here, key, 'only format: "date-time" is supported'));
      } else if (key === 'description') {
        if (typeof val !== 'string') errors.push(err(here, key, 'description must be a string'));
      }
    }
  }
  return { code: errors.length ? 'format.schema_invalid' : null, errors };
}

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

function dateTimeOk(s: string): boolean {
  const m = DATE_TIME.exec(s);
  if (!m) return false;
  const [y, mo, d, h, mi, sec] = m.slice(1, 7).map(Number);
  const zone = m[8];
  if (zone !== 'Z' && zone !== 'z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59)) return false;
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || sec > 60) return false;
  const day = new Date(Date.UTC(y, mo - 1, d));
  return day.getUTCFullYear() === y && day.getUTCMonth() === mo - 1 && day.getUTCDate() === d;
}

function typeOk(name: string, v: unknown): boolean {
  switch (name) {
    case 'object': return isObj(v);
    case 'array': return Array.isArray(v);
    case 'string': return typeof v === 'string';
    case 'number': return isNum(v);
    case 'integer': return isNum(v) && Number.isInteger(v);
    case 'boolean': return typeof v === 'boolean';
    case 'null': return v === null;
    default: return false;
  }
}

function same(a: unknown, b: unknown): boolean {
  if (typeof a === 'boolean' || typeof b === 'boolean') return a === b;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && same(a[k], b[k]));
  }
  return a === b;
}

/** 검사된 스키마로 값을 본다. 깊이 초과는 오류 하나(depth)만. */
export function checkValue(schema: Obj, value: unknown): SchemaError[] {
  if (depth(value) > DEPTH_MAX) return [err('', 'depth', `value is deeper than ${DEPTH_MAX}`)];
  const errors: SchemaError[] = [];
  const stack: Array<[unknown, unknown, string]> = [[schema, value, '']];
  while (stack.length) {
    const [s, v, path] = stack.pop()!;
    if (!isObj(s)) continue;
    if (s.type !== undefined) {
      const names = (Array.isArray(s.type) ? s.type : [s.type]).map(String);
      if (!names.some((n) => typeOk(n, v))) {
        errors.push(err(path, 'type', `expected ${names.join(' or ')}`));
        continue;
      }
    }
    if (Array.isArray(s.enum) && !s.enum.some((e) => same(v, e))) errors.push(err(path, 'enum', 'must be one of the listed values'));
    if (typeof v === 'string') {
      const len = codePointLength(v);
      if (typeof s.maxLength === 'number' && len > s.maxLength) errors.push(err(path, 'maxLength', `at most ${s.maxLength} characters`));
      if (typeof s.minLength === 'number' && len < s.minLength) errors.push(err(path, 'minLength', `at least ${s.minLength} characters`));
      if (s.format === 'date-time' && !dateTimeOk(v)) {
        errors.push(err(path, 'format', 'must be a date-time with a time zone, e.g. 2026-11-18T09:30:00+09:00'));
      }
    }
    if (isNum(v)) {
      if (isNum(s.minimum) && v < s.minimum) errors.push(err(path, 'minimum', `at least ${s.minimum}`));
      if (isNum(s.maximum) && v > s.maximum) errors.push(err(path, 'maximum', `at most ${s.maximum}`));
    }
    if (isObj(v)) {
      const props = isObj(s.properties) ? s.properties : {};
      for (const k of Array.isArray(s.required) ? s.required : []) {
        if (typeof k === 'string' && !(k in v)) errors.push(err(ptr(path, k), 'required', 'required'));
      }
      for (const [k, sub] of Object.entries(v)) {
        if (Object.prototype.hasOwnProperty.call(props, k)) stack.push([props[k], sub, ptr(path, k)]);
        else if (s.additionalProperties === false) errors.push(err(ptr(path, k), 'additionalProperties', 'not in the format'));
      }
    }
    if (Array.isArray(v) && isObj(s.items)) v.forEach((x, i) => stack.push([s.items, x, ptr(path, i)]));
  }
  return errors;
}
