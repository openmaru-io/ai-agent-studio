/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 입력창 고르기 목록(「/」 스킬·「@」 에이전트)의 글자 계산(스펙 2026-10-19-012 P3·DD2). 화면 없이 시험한다.
// - 「/」(where: 'start')는 글 맨 앞(회의실은 앞의 @이름 들 뒤)에서만 연다 — 글 중간의 경로·분수에는 열지 않는다.
// - 「@」(where: 'word')는 글 맨 앞이나 공백 바로 뒤에서 연다.
// - 커서 앞 낱말이 trigger 로 시작하고 그 사이에 공백이 없을 때만 열린 것으로 본다(공백을 치면 닫힌다).

export interface SuggestItem {
  /** 고르면 입력창에 들어갈 글자(「/요약」, 「@관리자 에이전트」) */
  value: string;
  /** 윗줄(굵게) */
  label: string;
  /** 아랫줄(한 줄 말줄임표) */
  detail?: string;
  /** 오른쪽 작은 글자(「2/3 에이전트」, 「꺼짐」) */
  hint?: string;
  /** 줄 title(마우스 올림) */
  title?: string;
  /** 거르기에만 쓰는 글(화면에 보이지 않는다). 번역된 스킬 설명의 원문 등(스펙 2026-10-19-017 P6) */
  search?: string;
  /** 화면 읽기 프로그램용 이름(hint 를 말로 풀어 쓴 것) */
  ariaLabel?: string;
  /** 줄 앞 색 점(회의실 @ 목록 — 칩과 같은 색) */
  dot?: string;
  /** 묶음 이름(「명령」·「스킬」, 스펙 2026-10-26-010 DC1). 바뀌는 곳에 머리줄을 그린다 */
  group?: string;
  /** 묶음 안 상태 줄(읽는 중·실패·빈·권한 없음, DC1·DC13). 입력창에 넣지 않는다. 글자를 거르면 숨긴다 */
  note?: boolean;
  /** 이 줄의 묶음은 GROUP_LIMIT 로 자르지 않는다 — 명령은 정해진 몇 개라 모두 보인다(스펙 2026-10-27-002, 2단계 16개 중 6개가 잘렸다) */
  whole?: boolean;
  /** 상태 줄을 고르면 할 일(「다시 시도」). 없으면 고를 수 없는 줄이다 */
  action?: () => void;
}

/** 위·아래 키로 고를 수 있는 줄인가 — 할 일이 없는 상태 줄은 건너뛴다 */
export const pickable = (it: SuggestItem | undefined): boolean => !!it && (!it.note || !!it.action);

export interface SuggestToken {
  start: number; // trigger 글자 위치
  end: number; // 낱말 끝(커서 뒤 공백 전까지)
  query: string; // trigger 뒤부터 커서까지
}

export type SuggestWhere = 'start' | 'word';

const SPACE = /\s/;

/** 글 맨 앞(공백 건너뜀)의 위치. from 은 회의실의 「앞의 @이름 들 뒤」 */
function firstNonSpace(value: string, from: number): number {
  let i = Math.max(0, from);
  while (i < value.length && SPACE.test(value[i])) i++;
  return i;
}

function wordEnd(value: string, from: number): number {
  let i = from;
  while (i < value.length && !SPACE.test(value[i])) i++;
  return i;
}

/** 지금 커서가 고르기 목록을 열 낱말 안에 있으면 그 낱말. 아니면 null */
export function activeToken(value: string, caret: number, trigger: string, where: SuggestWhere, startAt = 0): SuggestToken | null {
  if (caret < 1 || caret > value.length) return null;
  let start = -1;
  if (where === 'start') {
    const i = firstNonSpace(value, startAt);
    if (value[i] === trigger && caret > i) start = i;
  } else {
    for (let i = caret - 1; i >= 0; i--) {
      if (value[i] === trigger) {
        if (i === 0 || SPACE.test(value[i - 1])) start = i;
        break;
      }
      if (SPACE.test(value[i])) break;
    }
  }
  if (start < 0) return null;
  const query = value.slice(start + 1, caret);
  if (SPACE.test(query)) return null;
  return { start, end: wordEnd(value, caret), query };
}

/** 친 글자로 거른다. label·value·detail·search 에 들어 있는지(대소문자 무시), 앞부분이 맞는 것을 위로. 최대 limit 줄.
 *  묶음(group)이 있으면 묶음마다 거르고 묶음 순서를 지킨다 — 앞부분이 맞는 스킬이 명령 위로 섞여 올라가지 않게(DC1).
 *  묶음마다 최대 GROUP_LIMIT 줄, 상태 줄은 글자를 치지 않았을 때만 */
export const GROUP_LIMIT = 10;
export function filterItems(items: SuggestItem[], query: string, limit = 8): SuggestItem[] {
  if (items.some((it) => it.group)) {
    const order: string[] = [];
    for (const it of items) if (!order.includes(it.group ?? '')) order.push(it.group ?? '');
    return order.flatMap((g) => {
      const mine = items.filter((it) => (it.group ?? '') === g);
      const notes = query ? [] : mine.filter((it) => it.note);
      return [...notes, ...filterFlat(mine.filter((it) => !it.note), query, mine.some((it) => it.whole) ? mine.length : GROUP_LIMIT)];
    });
  }
  return filterFlat(items, query, limit);
}

function filterFlat(items: SuggestItem[], query: string, limit: number): SuggestItem[] {
  const q = query.toLowerCase();
  if (!q) return items.slice(0, limit);
  const bare = (s: string) => s.replace(/^[/@]/, '').toLowerCase();
  const hits = items.filter((it) => `${it.label}\n${it.value}\n${it.detail ?? ''}\n${it.search ?? ''}`.toLowerCase().includes(q));
  const head = hits.filter((it) => bare(it.label).startsWith(q) || bare(it.value).startsWith(q));
  const rest = hits.filter((it) => !head.includes(it));
  return [...head, ...rest].slice(0, limit);
}

/** 고른 항목으로 낱말을 바꾼다. 뒤에 공백 하나를 두고 커서를 그 뒤에 둔다 */
export function applyPick(value: string, token: SuggestToken, item: SuggestItem): { value: string; caret: number } {
  const after = value.slice(token.end);
  const insert = item.value + (after.startsWith(' ') ? '' : ' ');
  const next = value.slice(0, token.start) + insert + after;
  const caret = token.start + insert.length + (after.startsWith(' ') ? 1 : 0);
  return { value: next, caret };
}

/** 글 중간에서 고른 「/명령·스킬」을 맨 앞(startAt 뒤)으로 옮긴다(스펙 2026-10-26-010 12-7, 사용자 결정 D1 A).
 *  Hermes 는 맨 앞의 「/낱말」만 실행하므로 그 자리에 두면 실행되지 않는다. 앞뒤에 쓴 글은 뒤로 붙어 인자가 된다.
 *  「이 파일을 요약해 줘 /요」 → 「/요약 이 파일을 요약해 줘」. 커서는 글 끝(바로 Enter 로 보낸다) */
export function applyPickToFront(value: string, token: SuggestToken, item: SuggestItem, startAt = 0): { value: string; caret: number } {
  const head = value.slice(0, startAt);
  const body = (value.slice(startAt, token.start) + ' ' + value.slice(token.end)).replace(/\s+/g, (m) => (m.includes('\n') ? m : ' ')).trim();
  const lead = head && !/\s$/.test(head) ? `${head} ` : head;
  const next = `${lead}${item.value} ${body}`;
  return { value: next, caret: next.length };
}

/** 글 맨 앞(startAt 뒤)의 「/낱말」이 목록에 있으면 그 항목(보낼 때 스킬로 떼어 보낸다, R7·DD6). 없으면 null */
export function leadingCommand(value: string, items: SuggestItem[] | null | undefined, startAt = 0): SuggestItem | null {
  if (!items?.length) return null;
  const i = firstNonSpace(value, startAt);
  if (value[i] !== '/') return null;
  const word = value.slice(i, wordEnd(value, i)).toLowerCase();
  return items.find((it) => it.value.toLowerCase() === word) ?? null;
}

export interface Mentionable {
  alias: string;
  label: string;
}

/** 본문의 「@이름」·「@별칭」으로 부른 참가자 별칭(스펙 P5). 글 맨 앞이나 공백 뒤의 @ 에서, 긴 이름부터 맞춘다.
 *  이름 뒤는 공백·글 끝·문장부호여야 한다 — 「@관리자」가 「@관리자에게」를 맞추지 않게. 한글·띄어쓰기 이름도 맞는다. */
export function findMentions(text: string, people: Mentionable[]): string[] {
  const names = people
    .flatMap((p) => [p.label, p.alias].filter(Boolean).map((n) => ({ n, alias: p.alias })))
    .sort((a, b) => b.n.length - a.n.length);
  const found: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '@' || (i > 0 && !SPACE.test(text[i - 1]))) continue;
    for (const { n, alias } of names) {
      if (!text.startsWith(n, i + 1)) continue;
      const next = text[i + 1 + n.length];
      if (next === undefined || SPACE.test(next) || /[.,!?;:)\]」』'"·]/.test(next)) {
        if (!found.includes(alias)) found.push(alias);
        break;
      }
    }
  }
  return found;
}

/** 글 맨 앞에 이어진 「@이름」들 뒤의 위치(회의실에서 「/」 목록을 여는 자리, D2) */
export function afterLeadingMentions(text: string, people: Mentionable[]): number {
  const names = people.flatMap((p) => [p.label, p.alias].filter(Boolean)).sort((a, b) => b.length - a.length);
  let i = firstNonSpace(text, 0);
  for (;;) {
    if (text[i] !== '@') return i;
    const n = names.find((name) => text.startsWith(name, i + 1) && (i + 1 + name.length === text.length || SPACE.test(text[i + 1 + name.length])));
    if (!n) return i;
    i = firstNonSpace(text, i + 1 + n.length);
  }
}
