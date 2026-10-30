/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// TFT 방의 목적을 항목별로 받는다(스펙 2026-10-18-004). 칸반 카드 항목 입력(2026-10-18-002)과 같은 짜임:
// 빈 항목은 넣지 않고, 머리는 `###`, 머리 글은 화면 언어. 저장 모양은 지금의 purpose 글자 하나(Markdown)다.
import { dictionaries, LANGS, t } from '@/i18n';

export const BRIEF_KEYS = ['goal', 'result', 'due', 'how', 'avoid', 'refs', 'notes'] as const;
export type BriefKey = (typeof BRIEF_KEYS)[number];
export type Brief = Partial<Record<BriefKey, string>>;

/** 늘 보이는 항목. 나머지는 「더 자세히 적기」 */
export const BRIEF_SHOWN: BriefKey[] = ['goal', 'result', 'due'];
export const BRIEF_REQUIRED: BriefKey[] = ['goal'];

const head = (k: BriefKey) => t(`office.brief.${k}.head`);

/** 항목 값을 Markdown 하나로. 빈 항목은 넣지 않는다 */
export function buildBrief(b: Brief): string {
  return BRIEF_KEYS.filter((k) => b[k]?.trim())
    .map((k) => `### ${head(k)}\n${b[k]!.trim()}`)
    .join('\n\n');
}

/** 두 언어의 머리 글 → 항목. 화면 언어가 바뀌어도 저장된 글을 읽는다 */
function headIndex(): Map<string, BriefKey> {
  const m = new Map<string, BriefKey>();
  for (const lang of LANGS) for (const k of BRIEF_KEYS) {
    const h = dictionaries[lang][`office.brief.${k}.head`];
    if (h) m.set(h.trim().toLowerCase(), k);
  }
  return m;
}

/** 저장된 목적을 항목으로 나눈다. 아는 머리가 없는 글(옛 방·팀 방)은 통째로 「추가 설명」에 둔다.
 *  아는 머리가 아닌 `###` 줄은 앞 항목의 글로 남긴다(사람이 적은 Markdown 을 잃지 않게) */
export function parseBrief(text: string): Brief {
  const src = (text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!src) return {};
  const heads = headIndex();
  const out: Brief = {};
  let cur: BriefKey | null = null;
  const buf: string[] = [];
  const flush = () => {
    const v = buf.join('\n').trim();
    if (v) {
      const k = cur ?? 'notes';
      out[k] = out[k] ? `${out[k]}\n\n${v}` : v;
    }
    buf.length = 0;
  };
  for (const line of src.split('\n')) {
    const m = /^###\s+(.+?)\s*$/.exec(line);
    const k = m ? heads.get(m[1].toLowerCase()) : undefined;
    if (k) {
      flush();
      cur = k;
    } else buf.push(line);
  }
  flush();
  return out;
}

/** 목록·회의실 머리에 보일 한 줄: 「목표」의 첫 줄, 없으면 글의 첫 줄(머리 줄 제외) */
export function briefSummary(text: string): string {
  const b = parseBrief(text);
  const first = (s?: string) => (s ?? '').split('\n').map((x) => x.replace(/^#+\s*/, '').replace(/^[-*]\s+/, '').trim()).find(Boolean) ?? '';
  return first(b.goal) || first(BRIEF_KEYS.map((k) => b[k] ?? '').join('\n'));
}
