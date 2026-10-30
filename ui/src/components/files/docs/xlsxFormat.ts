/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 엑셀 칸 값 → 화면 글자(스펙 2026-10-20-005 재검토 D6). exceljs 는 표시 형식(numFmt)을 적용해 주지 않는다.
// 자주 쓰는 날짜·시간·퍼센트·천 단위·소수 자릿수만 바꾸고, 모르는 형식은 값 그대로 둔다. xlsx.worker 와 시험이 함께 쓴다.

type Rich = { richText: { text: string }[] };
type Formula = { formula?: string; sharedFormula?: string; result?: unknown };
export type CellValue = null | undefined | string | number | boolean | Date | Rich | Formula | { text: string; hyperlink?: string } | { error: string };

const pad = (n: number) => String(n).padStart(2, '0');

/** 형식 문자열의 첫 구역에서 따옴표 글자·[Red] 같은 괄호를 뺀다 */
function core(fmt: string): string {
  return (fmt.split(';')[0] || '').replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
}

function decimals(fmt: string): number {
  const m = /\.(0+)/.exec(fmt);
  return m ? m[1].length : 0;
}

const isDateFmt = (c: string) => /[yd]/i.test(c) || (/m/i.test(c) && /[hs:]/i.test(c)) || /^m+$/i.test(c);
const hasTime = (c: string) => /[hs]/i.test(c);

/** 엑셀 날짜 일련번호(1900 체계) → Date(UTC) */
export function serialToDate(serial: number): Date {
  return new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86400000));
}

function fmtDate(d: Date, time: boolean, seconds: boolean): string {
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  if (!time) return day;
  return `${day} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${seconds ? `:${pad(d.getUTCSeconds())}` : ''}`;
}

function fmtNumber(v: number, fmt: string | undefined): string {
  const c = core(fmt || '');
  if (!c || /^general$/i.test(c.trim())) return String(Number(v.toPrecision(15)));
  if (isDateFmt(c)) return fmtDate(serialToDate(v), hasTime(c), /s/i.test(c));
  const d = decimals(c);
  if (c.includes('%')) return `${(v * 100).toFixed(d)}%`;
  if (c.includes(',')) return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  if (/^[0#.]+$/.test(c.trim())) return v.toFixed(d);
  return String(Number(v.toPrecision(15)));
}

/** 칸 하나를 글자로. 수식은 저장된 결과값, 결과가 없으면 수식 글자 */
export function cellText(value: CellValue, fmt?: string): string {
  if (value == null) return '';
  if (value instanceof Date) {
    const c = core(fmt || '');
    return fmtDate(value, hasTime(c), /s/i.test(c));
  }
  if (typeof value === 'number') return fmtNumber(value, fmt);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'string') return value;
  if ('richText' in value) return value.richText.map((r) => r.text).join('');
  if ('error' in value) return value.error;
  if ('formula' in value || 'sharedFormula' in value) {
    const f = value as Formula;
    return f.result !== undefined && f.result !== null ? cellText(f.result as CellValue, fmt) : `=${f.formula ?? f.sharedFormula ?? ''}`;
  }
  if ('text' in value) return value.text;
  return '';
}

/** 오른쪽 정렬할 값인가(숫자·날짜, 수식이면 결과로) */
export function isNumeric(value: CellValue): boolean {
  if (typeof value === 'number' || value instanceof Date) return true;
  if (value && typeof value === 'object' && 'result' in value) return typeof value.result === 'number' || value.result instanceof Date;
  return false;
}

/** 열 번호(1부터) → A, B, …, Z, AA */
export function colName(n: number): string {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}
