/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 보호 스킬 설치 규칙(cogentai-aas-docs 스펙 2026-11-24-001)의 화면 쪽 값과 글 검사.
// 검사는 서버(aas/market/protected_skills.check_rules_text)와 같은 정규식이고, 비밀값 판정만 서버 미리보기가 한다.
// 두 검사가 갈라지지 않게 tests/fixtures/protected_rules_cases.json 을 Python 시험과 Vitest 가 함께 읽는다.
import { get, post } from '@/lib/api';

export const RULES_API = '/api/protected-skills/rules';

export type ApplyState = 'pending' | 'applied' | 'failed' | 'off';

export interface RulesVersion {
  rev: number;
  author: string;
  ts: string;
  chars: number;
  note: string;
}

export interface RulesView {
  rev: number;
  text: string;
  base_version: string;
  author: string;
  ts: string;
  note: string;
  source_version: string;
  versions: RulesVersion[];
  applied_rev: number;
  apply_state: ApplyState;
  clone_of: string;
  base_stale: boolean;
  can_edit: boolean;
  enabled: boolean;
  reads_rules: boolean;
  fixed_rules: string;
  limits: { max_chars: number; keep: number; note_max: number; poll_s: number; poll_max_s: number };
}

export interface RulesPreview {
  rev: number;
  tail: string;
  source_tail: string;
}

export type RulesCheck = 'heading' | 'setext' | 'hr' | 'comment' | 'redaction' | 'nul' | 'length' | 'secret';

const HEADING = /^ {0,3}#{1,2}(\s|$)/;
const SETEXT = /^ {0,3}(=+|-+)\s*$/;
const HR = /^ {0,3}([-*_]\s*){3,}$/;
const REDACTED = '«가림»'; // i18n-ignore: 서버 files.mask_line 이 넣는 가림 표시를 맞대어 보는 값(화면 문장이 아니다)
export const RULES_MAX = 8000;

/** 서버와 같은 순서의 구조 검사. 걸리면 [검사, 줄 번호(1부터 · 줄과 상관없으면 0)]. 비밀값은 서버가 본다 */
export function checkRulesText(text: string, max = RULES_MAX): [RulesCheck, number] | null {
  if (text.includes('\u0000')) return ['nul', 0];
  if ([...text].length > max) return ['length', 0];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (HEADING.test(line)) return ['heading', i + 1];
    if (SETEXT.test(line)) return ['setext', i + 1];
    if (HR.test(line)) return ['hr', i + 1];
    if (line.includes('<!--') || line.includes('-->')) return ['comment', i + 1];
    if (line.includes(REDACTED)) return ['redaction', i + 1];
  }
  return null;
}

const q = (profile: string, skill: string) => `profile=${encodeURIComponent(profile)}&skill=${encodeURIComponent(skill)}`;

export const rulesApi = (profile: string, skill: string) => ({
  view: () => get<RulesView>(`${RULES_API}?${q(profile, skill)}`),
  at: (rev: number) => get<{ rev: number; text: string }>(`${RULES_API}?${q(profile, skill)}&rev=${rev}`),
  save: (text: string, baseRev: number, note: string) => post(RULES_API, { profile, skill, text, base_rev: baseRev, note }),
  restore: (rev: number, baseRev: number) => post(`${RULES_API}/restore`, { profile, skill, rev, base_rev: baseRev }),
  preview: (text: string) => post<RulesPreview>(`${RULES_API}/preview`, { profile, skill, text }),
  ack: (rev: number) => post(`${RULES_API}/ack`, { profile, skill, rev }),
});
