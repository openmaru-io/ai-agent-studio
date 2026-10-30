/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 작업공간 크기의 단위 바꾸기(스펙 2026-10-30-003 §4-7 4A). 화면은 CPU 를 「개」, 메모리·디스크를 「GiB」로 보이고 받는다.
// 서버와 설정에는 쿠버네티스 수량(500m·1280Mi)으로 보낸다. 이 단위로 나누어 떨어지지 않는 값(1300Mi 등)은 반올림해 보이되,
// 고치지 않았으면 원래 수량을 그대로 돌려보낸다.

export type SizeField = 'cpu_request' | 'memory_request' | 'cpu_limit' | 'memory_limit' | 'storage';
export type SizeValues = Record<SizeField, string | null>;
export type SizeKind = 'cpu' | 'memory';

export const SIZE_FIELDS: SizeField[] = ['cpu_request', 'cpu_limit', 'memory_request', 'memory_limit', 'storage'];
export const kindOf = (f: SizeField): SizeKind => (f.startsWith('cpu') ? 'cpu' : 'memory');
export const GIB = 2 ** 30;

const SUFFIX: Record<string, number> = {
  '': 1, n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
  Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60,
};
const QTY = /^([0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE]([+-]?[0-9]+))?(n|u|m|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei)?$/;

/** 쿠버네티스 수량 → 기본 단위(CPU 는 개, 메모리는 바이트). 읽을 수 없으면 null(서버 agents.qty 와 같은 규칙) */
export function parseQty(q?: string | null): number | null {
  const m = QTY.exec(String(q ?? '').trim());
  if (!m) return null;
  return Number(m[1]) * (m[2] ? 10 ** Number(m[2]) : 1) * SUFFIX[m[3] ?? ''];
}

/** 수량 → 화면 단위의 수(CPU 개, 메모리 GiB) */
export function toUnit(kind: SizeKind, q?: string | null): number | null {
  const v = parseQty(q);
  return v == null ? null : kind === 'cpu' ? v : v / GIB;
}

/** 소수 둘째 자리까지, 뒤의 0 은 뺀다(0.25·4·1.27) */
export const fmtUnit = (n: number): string => String(Number(n.toFixed(2)));

/** 수량을 입력 칸에 넣을 글로. 값이 없으면 빈 글 */
export function displayQty(kind: SizeKind, q?: string | null): string {
  const v = toUnit(kind, q);
  return v == null ? '' : fmtUnit(v);
}

/** 화면 단위의 수 → 수량. CPU 는 1000m 단위로 나누어 떨어지면 개수(2), 아니면 m(500m). 메모리는 Gi 또는 Mi(1280Mi) */
export function fromUnit(kind: SizeKind, n: number): string {
  if (kind === 'cpu') {
    const m = Math.round(n * 1000);
    return m % 1000 === 0 ? String(m / 1000) : `${m}m`;
  }
  const mi = Math.round(n * 1024);
  return mi % 1024 === 0 ? `${mi / 1024}Gi` : `${mi}Mi`;
}

/** 입력 칸의 글 → 보낼 수량. 비면 null(그 칸을 비운다), 숫자가 아니거나 0 이하면 undefined(칸 오류).
 *  고치지 않은 글(원래 수량을 보인 그대로)이면 원래 수량을 돌려준다 — 1300Mi 를 1.27GiB 로 바꾸지 않게 */
export function draftToQty(kind: SizeKind, text: string, original: string | null): string | null | undefined {
  const s = text.trim();
  if (!s) return null;
  if (original && s === displayQty(kind, original)) return original;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return fromUnit(kind, n);
}

/** 두 수량이 같은 양인가(500m 와 0.5) */
export function sameQty(a?: string | null, b?: string | null): boolean {
  const x = parseQty(a);
  const y = parseQty(b);
  if (x == null || y == null) return (a || null) === (b || null);
  return Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x));
}
