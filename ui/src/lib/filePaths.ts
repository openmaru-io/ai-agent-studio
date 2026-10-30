/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 글 안의 파일 경로를 찾아 뱃지로 바꿀 자리를 돌려준다(스펙 2026-10-20-002 §3-4, 리뷰 R6·D14·R14, 디자인 리뷰 DD2).
// 절대 경로는 /opt/data/workspace/ 로 시작하는 것만, 상대 경로는 서랍 목록에 있는 것만 잡는다. 코드 블록·링크 제외는 부르는 쪽 일이다.

export const DATA_ROOT = '/opt/data/';
const ABS = '/opt/data/workspace/';

/** 찾은 경로. path 는 데이터 폴더 기준(workspace/…) */
export interface PathHit {
  start: number;
  end: number;
  path: string;
}

const LEGACY_PREFIX = '경로: '; // i18n-ignore: 옛 「AI」 단추 문구(chat.files.askPrompt) — 저장된 대화를 읽는다
const STOP = new Set([' ', '\t', '\n', '\r', ')', ']', '」', ',', '"', "'", '<', '>', '`', '（', '）']);
const HANGUL_AFTER_EXT = /\.([A-Za-z0-9]{1,8})(?=[ㄱ-ㆎ가-힣])/;
const TAIL_PUNCT = /[.:。!?]+$/;

/** 낱말 끝의 붙은 조사·문장부호를 뗀다(D14): 마지막 조각의 .확장자 바로 뒤가 한글이면 확장자 끝에서 자르고, 끝의 . : 。 ! ? 는 뗀다 */
export function cutPath(token: string): string {
  const slash = token.lastIndexOf('/');
  const last = token.slice(slash + 1);
  const m = HANGUL_AFTER_EXT.exec(last);
  let out = m ? token.slice(0, slash + 1 + m.index + m[0].length) : token;
  out = out.replace(TAIL_PUNCT, '');
  return out;
}

function lineAt(text: string, i: number): { start: number; end: number } {
  const start = text.lastIndexOf('\n', i - 1) + 1;
  const nl = text.indexOf('\n', i);
  return { start, end: nl < 0 ? text.length : nl };
}

/** 절대 경로(/opt/data/workspace/…)와, known 이 있으면 그 목록에 있는 상대 경로(report/summary.md)를 찾는다 */
export function findPaths(text: string, known?: ReadonlySet<string>): PathHit[] {
  const hits: PathHit[] = [];
  let from = 0;
  for (;;) {
    const i = text.indexOf(ABS, from);
    if (i < 0) break;
    const line = lineAt(text, i);
    let end: number;
    // 옛 「AI」 단추 글(「경로: …」 한 줄)은 공백 있는 이름도 줄 끝까지(R6 예외 ②)
    if (text.slice(line.start, i) === LEGACY_PREFIX) end = line.end;
    else {
      end = i;
      while (end < text.length && !STOP.has(text[end])) end++;
    }
    const token = cutPath(text.slice(i, end).trimEnd());
    if (token.length > ABS.length && !token.endsWith('/')) hits.push({ start: i, end: i + token.length, path: token.slice(DATA_ROOT.length) });
    from = Math.max(end, i + ABS.length);
  }
  if (known?.size) {
    const re = /[^\s"'`<>()[\]「」（）,]+/g;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const raw = m[0];
      const at = m.index;
      if (raw.startsWith('/') || raw.includes('://') || hits.some((h) => at < h.end && at + raw.length > h.start)) continue;
      const cut = cutPath(raw);
      const lead = cut.startsWith('./') ? 2 : 0;
      const token = cut.slice(lead);
      if (!token || (!token.includes('/') && !/\.[A-Za-z0-9]{1,8}$/.test(token))) continue;
      const path = `workspace/${token}`;
      if (!known.has(path)) continue;
      hits.push({ start: at + lead, end: at + cut.length, path });
    }
    hits.sort((a, b) => a.start - b.start);
  }
  return hits;
}

/** 글 안 경로를 글 조각과 경로로 나눈다 — 일반 글(사용자 말풍선) 표시용 */
export function splitPaths(text: string, known?: ReadonlySet<string>): (string | PathHit)[] {
  const out: (string | PathHit)[] = [];
  let at = 0;
  for (const h of findPaths(text, known)) {
    if (h.start > at) out.push(text.slice(at, h.start));
    out.push(h);
    at = h.end;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

const LEGACY_LINE = /^경로: \/opt\/data\/(workspace\/.+?)\s*$/; // i18n-ignore: 옛 「AI」 단추 문구(서버에 저장된 글)를 읽는다

/** 옛 「AI」 단추 글의 「경로: /opt/data/workspace/…」 줄을 떼고 그 경로들을 돌려준다(DD2 — 뱃지는 본문 위 줄로 간다) */
export function takeLegacyPathLines(text: string): { text: string; paths: string[] } {
  const paths: string[] = [];
  const kept = text.split('\n').filter((line) => {
    const m = LEGACY_LINE.exec(line);
    if (!m) return true;
    paths.push(m[1]);
    return false;
  });
  return paths.length ? { text: kept.join('\n').replace(/\n+$/, ''), paths } : { text, paths };
}
