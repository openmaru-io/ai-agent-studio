/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { t as tr } from '@/i18n';

// 마크다운 편집 도구: 선택한 글 감싸기, 줄 머리 붙이기, 목록 이어 쓰기, 들여쓰기, 줄 단위 차이 계산.
// 모두 (글, 선택 시작, 선택 끝)을 받아 새 (글, 선택)을 돌려주는 순수 함수다. 화면 쪽이 textarea 에 반영한다.
export interface Edit {
  value: string;
  start: number;
  end: number;
}

const splice = (v: string, a: number, b: number, text: string, start = a + text.length, end = start): Edit => ({
  value: v.slice(0, a) + text + v.slice(b),
  start,
  end,
});

const lineRange = ({ value: v, start, end }: Edit): [number, number] => {
  const a = v.lastIndexOf('\n', start - 1) + 1;
  let b = v.indexOf('\n', end);
  if (b < 0) b = v.length;
  return [a, b];
};

export function wrap(e: Edit, before: string, after = before, placeholder = tr('mdtools.text')): Edit {
  const { value: v, start: s, end: t } = e;
  const sel = v.slice(s, t);
  if (sel && v.slice(s - before.length, s) === before && v.slice(t, t + after.length) === after)
    return splice(v, s - before.length, t + after.length, sel, s - before.length, t - before.length); // 다시 누르면 푼다
  const body = sel || placeholder;
  return splice(v, s, t, before + body + after, s + before.length, s + before.length + body.length);
}

export function linePrefix(e: Edit, prefix: string, numbered = false): Edit {
  const [a, b] = lineRange(e);
  const lines = e.value.slice(a, b).split('\n');
  const strip = /^(\s*)(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/;
  const all = lines.every(
    (l) =>
      !l.trim() ||
      (l.replace(/^\s*/, '').startsWith(numbered ? '' : prefix) && (numbered ? /^\s*\d+[.)]\s/.test(l) : true))
  );
  const out = lines
    .map((l, i) => {
      if (!l.trim() && lines.length > 1) return l;
      const bare = l.replace(strip, '$1');
      return all ? bare : bare.replace(/^(\s*)/, `$1${numbered ? `${i + 1}. ` : prefix}`);
    })
    .join('\n');
  return splice(e.value, a, b, out, a, a + out.length);
}

export function block(e: Edit, text: string, selectFrom?: number, selectTo?: number): Edit {
  const { value: v, start: s, end: t } = e;
  const pre = s && v[s - 1] !== '\n' ? '\n\n' : s > 1 && v[s - 2] !== '\n' ? '\n' : '';
  const post = v[t] === '\n' ? '\n' : '\n\n';
  const at = s + pre.length;
  return splice(
    v,
    s,
    t,
    pre + text + post,
    at + (selectFrom ?? text.length),
    at + (selectTo ?? selectFrom ?? text.length)
  );
}

export function link(e: Edit): Edit {
  const sel = e.value.slice(e.start, e.end) || tr('mdtools.linkText');
  const t = `[${sel}](https://)`;
  return splice(e.value, e.start, e.end, t, e.start + sel.length + 3, e.start + t.length - 1);
}

export const table = (e: Edit): Edit => block(e, `| ${tr('mdtools.tableItem')} | ${tr('mdtools.tableContent')} |\n| --- | --- |\n|  |  |`, 2, 4);

export function codeBlock(e: Edit): Edit {
  const sel = e.value.slice(e.start, e.end) || tr('mdtools.code');
  return block(e, '```\n' + sel + '\n```', 4, 4 + sel.length);
}

/** Enter: 목록·인용·체크 줄에서는 다음 항목을 잇고, 빈 항목에서는 목록을 끝낸다. 해당하지 않으면 null. */
export function enter(e: Edit): Edit | null {
  if (e.start !== e.end) return null;
  const { value: v, start: pos } = e;
  const a = v.lastIndexOf('\n', pos - 1) + 1;
  const m = /^(\s*)([-*+]\s+(?:\[[ xX]\]\s+)?|\d+([.)])\s+|>\s?)(.*)$/.exec(v.slice(a, pos));
  if (!m) return null;
  if (!m[4].trim()) return splice(v, a, pos, '');
  const num = /^\d+/.exec(m[2]);
  const next = num ? `${Number(num[0]) + 1}${m[3]} ` : m[2].replace(/\[[xX]\]/, '[ ]');
  return splice(v, pos, pos, '\n' + m[1] + next);
}

export function indent(e: Edit, out = false): Edit {
  const [a, b] = lineRange(e);
  const lines = e.value.slice(a, b).split('\n');
  const res = lines.map((l) => (out ? l.replace(/^( {1,2}|\t)/, '') : '  ' + l)).join('\n');
  const single = lines.length === 1;
  return splice(
    e.value,
    a,
    b,
    res,
    single ? Math.max(a, e.start + (out ? res.length - (b - a) : 2)) : a,
    single ? undefined : a + res.length
  );
}

export function headings(text: string): { level: number; text: string; line: number }[] {
  const out: { level: number; text: string; line: number }[] = [];
  let fence = false;
  text.split('\n').forEach((l, i) => {
    if (/^\s*```/.test(l)) fence = !fence;
    const m = fence ? null : /^(#{1,4})\s+(.+)$/.exec(l);
    if (m) out.push({ level: m[1].length, text: m[2].trim(), line: i });
  });
  return out;
}

export interface LineDiff {
  lines: string[];
  added: number;
  removed: number;
  same: boolean;
}

/** 줄 단위 차이(가장 긴 공통 줄 찾기). 저장 전 「바뀐 줄 확인」에 쓴다. 서버에 묻지 않고 바로 낸다. */
export function lineDiff(oldText: string, newText: string, ctx = 2): LineDiff {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  if (oldText === newText) return { lines: [], added: 0, removed: 0, same: true };
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  const A = a.slice(p, a.length - q);
  const B = b.slice(p, b.length - q);
  const n = A.length;
  const m = B.length;
  const ops: [string, string][] = [];
  if (n * m > 4e6) {
    A.forEach((x) => ops.push(['-', x])); // 너무 크면 통째로 바뀐 것으로 본다
    B.forEach((x) => ops.push(['+', x]));
  } else {
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) {
        ops.push([' ', A[i]]);
        i++;
        j++;
      } else if (L[i + 1][j] >= L[i][j + 1]) ops.push(['-', A[i++]]);
      else ops.push(['+', B[j++]]);
    }
    while (i < n) ops.push(['-', A[i++]]);
    while (j < m) ops.push(['+', B[j++]]);
  }
  const head: [string, string][] = a.slice(Math.max(0, p - ctx), p).map((x) => [' ', x]);
  const tail: [string, string][] = a.slice(a.length - q, a.length - q + ctx).map((x) => [' ', x]);
  const all = [...head, ...ops, ...tail];
  const lines = [tr('mdtools.hunk', { line: Math.max(1, p - head.length + 1) })];
  let gap = 0;
  all.forEach((op, k) => {
    const near = all.slice(Math.max(0, k - ctx), k + ctx + 1).some((x) => x[0] !== ' ');
    if (near) {
      if (gap) lines.push('@@ … @@');
      gap = 0;
      lines.push(op[0] + op[1]);
    } else gap++;
  });
  return {
    lines,
    added: ops.filter((o) => o[0] === '+').length,
    removed: ops.filter((o) => o[0] === '-').length,
    same: false,
  };
}
