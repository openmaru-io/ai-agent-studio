/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 말풍선 규칙(계획 007 P1, §3-3 G6). 동시에 최대 6개 — 내 에이전트 → 따라가는 에이전트 → 최근 활동 순.
// 답 글이 없는(비공개) 대화는 「답하는 중 · 대화 비공개」로 보인다. 이모지는 쓰지 않는다(번들 글꼴에 없으면 외부 글꼴을 받는다).
import type { Activity, ServerAgent } from '@/features/office/model';

export const MAX_BUBBLES = 6;
export const AWAY_AFTER_S = 30 * 60;

export interface BubbleWords {
  tool: (name: string) => string;
  private: string;
  /** 사람의 답을 기다릴 때(받은편지함의 승인·되묻기) */
  needsAnswer?: string;
}

export function bubbleText(a: Activity, words: BubbleWords): string {
  if (a.text) return a.text;
  if (a.tool) return words.tool(a.tool);
  return words.private;
}

/** 말풍선 고르기: 응답 필요 → 내 에이전트 → 따라가는 에이전트 → 최근 활동 순으로 최대 6개. */
export function bubbles(
  agents: ServerAgent[],
  activity: Record<string, Activity> | undefined,
  words: BubbleWords,
  following: string | null,
  needsAnswer: Set<string> = new Set()
): Record<string, string> {
  const mine = new Set(agents.filter((a) => a.mine).map((a) => a.alias));
  const known = new Set(agents.map((a) => a.alias));
  const aliases = new Set([...Object.keys(activity ?? {}), ...needsAnswer].filter((a) => known.has(a)));
  const rank = (alias: string) => (needsAnswer.has(alias) ? 0 : mine.has(alias) ? 1 : alias === following ? 2 : 3);
  const at = (alias: string) => activity?.[alias]?.at ?? 0;
  const picked = [...aliases].sort((a, b) => rank(a) - rank(b) || at(b) - at(a)).slice(0, MAX_BUBBLES);
  return Object.fromEntries(
    picked.map((alias) => [
      alias,
      needsAnswer.has(alias) && words.needsAnswer ? words.needsAnswer : bubbleText(activity?.[alias] ?? { at: 0 }, words),
    ])
  );
}

/** 마지막 활동 뒤 30분이 지났으면 부재. 시각을 모르면(서버를 다시 띄운 직후 등) 부재로 보지 않는다. */
export function isAway(a: ServerAgent, nowS: number): boolean {
  return a.status === 'idle' && typeof a.last_seen === 'number' && nowS - a.last_seen > AWAY_AFTER_S;
}
