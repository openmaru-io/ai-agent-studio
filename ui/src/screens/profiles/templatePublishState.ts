/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 「템플릿으로 올리기」 창의 상태 계산(스펙 2026-11-18-002 §4-4). 화면과 떼어 Vitest 로 본다.

export interface PreviewItem {
  id: string;
  label: string;
  included: boolean;
  stdio?: boolean;
  url?: string;
  origin?: string;
  note?: string;
  size?: number;
  /** 참고 파일: 글 파일이면 자동 검사, 아니면 사람의 확인이 필요하다(D5) */
  text?: boolean;
  confirmed?: boolean;
}

export interface TemplatePreview {
  status: 'preview' | 'published' | 'pending_review' | string;
  name: string;
  version: string;
  namespace: string;
  update: boolean;
  from_version: string;
  items: { skills: PreviewItem[]; mcp: PreviewItem[]; cron: PreviewItem[]; agents?: PreviewItem[]; files?: PreviewItem[] };
  needs_confirmation?: string[];
  env_requires: { name: string; description: string; required: boolean; used_by: string[] }[];
  hub_skills: { namespace: string; name: string; version: string }[];
  errors: { code: string; message: string }[];
  warnings: { code: string; message: string }[];
  stdio: { name: string }[];
  model_hint: string;
  soul: string;
  files: { path: string; size: number }[];
  limit: number;
  used: number;
  request_id?: string;
}

export interface Choices {
  skills: string[];
  mcp: string[];
  cron: string[];
}

/** 기본 구역은 제한 구역(공개가 아닌 첫 네임스페이스). 공용 구역은 고를 때만(§4-4 1). */
export function zoneDefault(namespaces: string[], publicZones: string[]): string {
  return namespaces.find((n) => !publicZones.includes(n)) ?? namespaces[0] ?? '';
}

/** 항목 하나를 켜고 끈 뒤의 choices. 처음(null)은 미리 보기의 지금 담긴 것에서 시작한다 — 서버의 「없는 칸은 모두」와 같다. */
export function choicesAfterToggle(current: Choices | null, items: TemplatePreview['items'] | undefined, kind: keyof Choices, id: string): Choices {
  const base: Choices = current ?? {
    skills: (items?.skills ?? []).filter((i) => i.included).map((i) => i.id),
    mcp: (items?.mcp ?? []).filter((i) => i.included).map((i) => i.id),
    cron: (items?.cron ?? []).filter((i) => i.included).map((i) => i.id),
  };
  const list = base[kind];
  return { ...base, [kind]: list.includes(id) ? list.filter((x) => x !== id) : [...list, id] };
}

export interface PickedFile {
  path: string;
  confirmed: boolean;
}

/** 참고 파일 고르기: 고르면 넣고(확인 없음), 다시 누르면 뺀다. 한도(파일 수)를 넘으면 더하지 않는다. */
export function togglePick(list: PickedFile[], path: string, max: number): PickedFile[] {
  if (list.some((f) => f.path === path)) return list.filter((f) => f.path !== path);
  return list.length >= max ? list : [...list, { path, confirmed: false }];
}

/** 파일 하나의 「개인정보·고객 자료 없음」 확인. 「모두 확인」은 두지 않는다(디자인 리뷰). */
export const setConfirmed = (list: PickedFile[], path: string, on: boolean): PickedFile[] => list.map((f) => (f.path === path ? { ...f, confirmed: on } : f));

export const fmtSize = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);
