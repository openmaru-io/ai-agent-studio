/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 「템플릿에서」 탭의 상태 계산(스펙 2026-11-18-002 §4-2·§4-4). 화면과 떼어 Vitest 로 본다.

export interface TemplateEnv {
  name: string;
  description: string;
  required: boolean;
  used_by: string[];
}

export interface TemplateMcp {
  name: string;
  keys: string[];
  stdio: boolean;
  url?: string;
  command?: string;
  args?: string[];
  consent_hash?: string;
  problem?: string;
}

export interface TemplateCard {
  id: string;
  namespace: string;
  name: string;
  version: string;
  public: boolean;
  description: string;
  author: string;
  summary?: string;
  owner?: string;
  tags?: string[];
  env_requires: TemplateEnv[];
  mcp: TemplateMcp[];
  skills: number;
  hub_skills: { namespace?: string; name?: string; version?: string }[];
  cron: number;
  files: number;
  model_hint: string;
  examples: string[];
  installs?: number;
  /** 이 작업공간이 그 구역을 받을 수 있는가(허용이 필요한 구역, 관리자가 허용). false 면 고를 수 없다 */
  allowed?: boolean;
  /** 구역의 표시 이름(「제한」). 허용 안내 문구에 쓴다(스펙 2026-11-18-015 §3-4) */
  namespace_label?: string;
}

export interface TemplateDetail extends Omit<TemplateCard, 'cron' | 'files'> {
  cron: { name: string; schedule: string; prompt: string; script: string }[];
  files: string[];
  soul: string;
  agents: string;
  readme: string;
}

export interface KeyField {
  name: string;
  description: string;
  required: boolean;
}

export interface KeyGroup {
  /** 「MCP: jira」·「스킬: x」·「그 밖」 — 쓰는 곳별로 묶는다(디자인 리뷰) */
  kind: 'mcp' | 'skill' | 'other';
  label: string;
  fields: KeyField[];
}

/** KEY 칸을 쓰는 곳별로 묶는다. MCP 가 쓰는 KEY 는 MCP 참조로, 그 밖은 매니페스트 used_by 로 정한다. 한 KEY 는 처음 묶음 하나에만 보인다. */
export function keyGroups(d: Pick<TemplateDetail, 'env_requires' | 'mcp'>): KeyGroup[] {
  const byName = new Map(d.env_requires.map((e) => [e.name, e]));
  const seen = new Set<string>();
  const groups: KeyGroup[] = [];
  const take = (kind: KeyGroup['kind'], label: string, names: string[]) => {
    const fields = names
      .filter((n) => byName.has(n) && !seen.has(n))
      .map((n) => {
        seen.add(n);
        const e = byName.get(n) as TemplateEnv;
        return { name: n, description: e.description, required: e.required };
      });
    if (fields.length) groups.push({ kind, label, fields });
  };
  for (const m of d.mcp) take('mcp', m.name, m.keys);
  const bySkill = new Map<string, string[]>();
  for (const e of d.env_requires)
    for (const u of e.used_by) {
      if (!u.startsWith('skill:')) continue;
      const s = u.slice('skill:'.length);
      bySkill.set(s, [...(bySkill.get(s) ?? []), e.name]);
    }
  for (const [s, names] of bySkill) take('skill', s, names);
  take(
    'other',
    '',
    d.env_requires.map((e) => e.name)
  );
  return groups;
}

/** 칸마다 값이 있거나 「나중에」면 된다. 필수 칸은 둘 중 하나가 있어야 「만들기」가 켜진다. */
export function keysReady(groups: KeyGroup[], values: Record<string, string>, later: Record<string, boolean>): boolean {
  return groups.every((g) => g.fields.every((f) => !f.required || !!later[f.name] || !!values[f.name]?.trim()));
}

/** 「나중에」 때문에 꺼진 채로 만들어질 MCP 수 — KEY 를 쓰는 MCP 가운데 값이 빈 KEY 가 하나라도 있는 것. */
export function laterMcpCount(mcp: TemplateMcp[], values: Record<string, string>): number {
  return mcp.filter((m) => m.keys.length && m.keys.some((k) => !values[k]?.trim())).length;
}

/** stdio MCP 동의: 모두 체크해야 다음으로 간다. 판 고정 문제(problem)가 있으면 서버가 거절하므로 막는다. */
export function consentReady(mcp: TemplateMcp[], agreed: Record<string, boolean>): boolean {
  return mcp.filter((m) => m.stdio).every((m) => !m.problem && !!agreed[m.name]);
}

export const consentsOf = (mcp: TemplateMcp[]): string[] => mcp.filter((m) => m.stdio && m.consent_hash).map((m) => m.consent_hash as string);

export interface RequestRow {
  id: string;
  status: string;
  message?: string;
  code?: string;
  needs?: unknown;
}

/** 요청 상태를 화면 단계로. done 일 때만 KEY 를 넣는다(E14). */
export type Phase = 'waiting' | 'created' | 'failed' | 'needs';
export function phaseOf(r?: RequestRow): Phase {
  if (!r || r.status === 'queued' || r.status === 'running') return 'waiting';
  if (r.status === 'done') return 'created';
  return r.needs ? 'needs' : 'failed';
}

/** 서버 거절 코드 → 화면 문구 키. 템플릿이 바뀜(해시 불일치)은 ② 로, 내려짐은 ① 로 돌아간다(§4-4). */
export function refusalStep(code?: string): 'pick' | 'confirm' | 'keys' | 'result' {
  if (code === 'hidden') return 'pick';
  if (code === 'consent_mismatch' || code === 'consent_required') return 'confirm';
  if (code === 'name_taken' || code === 'profile_limit' || code === 'pending') return 'keys';
  return 'result';
}

/** 「3초마다 10분까지」 읽기: 기다림 한도(초)를 넘었는가. */
export const POLL_MS = 3000;
export const WAIT_S = 600;
export const timedOut = (startedAt: number, now: number, waitS = WAIT_S): boolean => now - startedAt > waitS * 1000;

/** 프로파일 이름 규칙(서버 marketplace.PROFILE 과 같다). 템플릿 이름이 규칙에 맞지 않으면 기본값을 비운다. */
export const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
export const defaultName = (name: string, taken: string[]): string => {
  if (!PROFILE_RE.test(name)) return '';
  if (!taken.includes(name)) return name;
  for (let i = 2; i < 100; i++) if (!taken.includes(`${name}-${i}`)) return `${name}-${i}`;
  return '';
};
