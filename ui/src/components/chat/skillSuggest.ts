/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 「/」 스킬 목록을 Composer 의 고르기 목록으로 바꾼다(스펙 2026-10-19-012 P4·P5, DD1·DD3·DD7·DD9).
// 대화·오피스 1:1·회의실이 같이 쓴다. 회의실은 받는 대상(targets)이 가진 스킬만 보이고 「2/3 에이전트」를 단다.
import { t } from '@/i18n';
import { leadingCommand, type SuggestItem } from '@/lib/composerSuggest';
import type { SkillList, SkillSuggest } from '@/lib/useSkillSuggest';

import type { ComposerSuggest } from './Composer';

export interface MeetingSkillOpts {
  /** 지금 받는 대상 별칭 */
  targets: string[];
  /** 별칭 → 칩에 보이는 이름 */
  label: (alias: string) => string;
}

/** null 은 아직 읽지 않았거나 읽는 중 */
export function skillSuggestItems(data: SkillList | null, meeting?: MeetingSkillOpts): SuggestItem[] | null {
  if (!data) return null;
  const rows = meeting ? data.skills.filter((r) => (r.agents ?? []).some((a) => meeting.targets.includes(a))) : data.skills;
  return rows.map((r) => {
    // 번역된 설명이면 마우스 올림에 원문을, 거르기에는 원문 낱말도 쓴다(스펙 2026-10-19-017 P6). 아랫줄(detail)에는 번역만
    const src = r.description_src || undefined;
    if (!meeting) return { value: r.command, label: r.command, detail: r.description || undefined, title: src ?? (r.description || undefined), search: src };
    const has = (r.agents ?? []).filter((a) => meeting.targets.includes(a));
    const missing = meeting.targets.filter((a) => !has.includes(a)).map(meeting.label);
    const hint = t('office.suggest.has', { n: has.length, total: meeting.targets.length });
    const lack = missing.length ? t('office.suggest.missing', { names: missing.join(', ') }) : '';
    return {
      value: r.command,
      label: r.command,
      detail: r.description || undefined,
      hint,
      search: src,
      title: [src ?? r.description, lack].filter(Boolean).join('\n') || undefined,
      ariaLabel: [t('office.suggest.hasAria', { skill: r.command, n: has.length, total: meeting.targets.length }), lack, r.description]
        .filter(Boolean)
        .join(', '),
    };
  });
}

/** 받는 대상 중 고른 스킬이 없는 에이전트 이름(DD9). 목록을 아직 읽지 않았으면 빈 배열 */
export function missingFor(data: SkillList | null, command: string, targets: string[], label: (alias: string) => string): string[] {
  const row = data?.skills.find((r) => r.command.toLowerCase() === command.toLowerCase());
  if (!row) return [];
  return targets.filter((a) => !(row.agents ?? []).includes(a)).map(label);
}

export function skillSource(s: SkillSuggest, items: SuggestItem[] | null, extra: Partial<ComposerSuggest> = {}): ComposerSuggest {
  const failed = s.data?.failed?.length ? s.data.failed : [];
  return {
    trigger: '/',
    where: 'start',
    title: t('chat.suggest.skills'),
    items: s.error ? [] : items,
    error: s.error,
    onRetry: s.retry,
    onOpen: s.open,
    loadingText: t('chat.suggest.skillsLoading'),
    errorText: t('chat.suggest.skillsFailed'),
    emptyText: t('chat.suggest.skillsEmpty'),
    emptyLink: { href: '#/skills', label: t('chat.suggest.skillsLink') },
    noMatchText: t('chat.suggest.skillsNoMatch'),
    countText: (n) => t('chat.suggest.skillsCount', { count: n }),
    touchButton: t('chat.suggest.slash'),
    anywhere: true, // 글 중간 「/」도 열고 고르면 맨 앞으로(스펙 2026-10-26-010 12-7)
    ...(failed.length ? { warning: t('office.suggest.failed', { names: failed.join(', ') }) } : {}),
    ...extra,
  };
}

// ---- 「/」 Hermes 내장 명령(스펙 2026-10-26-010 §11) ----

/** 「/」 목록 줄: 「명령」 묶음 → 「스킬」 묶음(DC1). 답하는 중이면 명령은 답하는 중에도 되는 것(steer·queue)만, 스킬은 숨긴다(DC6).
 *  관리하지 않는 사람은 명령 자리에 상태 줄 하나(DC13). 스킬이 없으면 스킬 묶음 안 상태 줄(DD3 문구) — 명령은 가리지 않는다.
 *  명령 칸이 없는 응답(회의실)은 지금처럼 스킬만. null 은 아직 읽지 않았거나 읽는 중 */
export function slashItems(data: SkillList | null, busy = false): SuggestItem[] | null {
  if (!data) return null;
  if (!data.command_names) return skillSuggestItems(data);
  const cg = t('chat.suggest.commands');
  const out: SuggestItem[] = [];
  if (data.commands_allowed === false) out.push({ value: '', label: t('chat.cmd.groupManagersOnly'), group: cg, note: true });
  else
    for (const c of (data.commands ?? []).filter((r) => !busy || r.while_busy))
      out.push({
        value: c.command,
        label: c.command,
        detail: c.description || undefined,
        hint: c.hint || undefined,
        group: cg,
        whole: true,
        ariaLabel: [c.command, c.description, c.hint].filter(Boolean).join(', '),
      });
  if (busy) return out;
  const sg = t('chat.suggest.skills');
  const skills = skillSuggestItems(data) ?? [];
  if (skills.length) out.push(...skills.map((s) => ({ ...s, group: sg })));
  else out.push({ value: '', label: t('chat.suggest.skillsEmpty'), group: sg, note: true });
  return out;
}

/** 화면 읽기 개수(DC12): 「명령 10개 · 스킬 12개」. 묶음이 없으면(회의실) 스킬 개수 */
export function slashCount(items: SuggestItem[]): string {
  if (!items.some((i) => i.group)) return t('chat.suggest.skillsCount', { count: items.length });
  const cg = t('chat.suggest.commands');
  const real = items.filter((i) => !i.note);
  const commands = real.filter((i) => i.group === cg).length;
  return t('chat.suggest.slashCount', { commands, skills: real.length - commands });
}

export function slashSource(s: SkillSuggest, items: SuggestItem[] | null, extra: Partial<ComposerSuggest> = {}): ComposerSuggest {
  const grouped = !!s.data?.command_names;
  return skillSource(s, items, {
    ...(grouped ? { title: '', noMatchText: t('chat.suggest.slashNoMatch'), countText: (_n: number, shown?: SuggestItem[]) => slashCount(shown ?? []) } : {}),
    ...extra,
  });
}

/** 보내기 전에 정한 일(DC5·DC6·DC10). command: 명령으로 실행, skill: 스킬을 붙여 보냄, 둘 다 없으면 글.
 *  note: 키 안내 줄 한 줄, warn: 호박색, block: 보내기를 막는다 */
export interface SlashPlan {
  command?: { name: string; arg: string };
  skill?: string;
  note?: string;
  warn?: boolean;
  block?: boolean;
}

/** 글 맨 앞의 「/낱말」로 할 일을 정한다. 명령 이름(서버가 준 10개)과 같으면 명령이다 — 실행할 수 없으면 이유를 보이고 막는다.
 *  목록을 한 번도 받지 못했으면(실패) 지금처럼 글로 보낸다(DC5). 목록을 읽는 중이면 기다린다(글로 잘못 가지 않게). */
export function planSlash(text: string, s: SkillSuggest, skillItems: SuggestItem[] | null, busy: boolean): SlashPlan {
  const m = /^\s*(\/\S+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!m) return {};
  const typed = m[1].toLowerCase();
  const arg = (m[2] ?? '').trim();
  const d = s.data;
  const alias = d?.command_aliases?.[typed]; // /q → /queue(스펙 2026-10-27-004 R10)
  const word = alias ? `/${alias}` : typed;
  if (s.error && !d?.command_names) return { note: t('chat.cmd.listFailedText') };
  if (!d) return { note: t('chat.cmd.listLoading'), block: true };
  if (d.command_names?.includes(word)) {
    const name = word.slice(1);
    if (d.commands_allowed === false) return { note: t('chat.cmd.managersOnly'), warn: true, block: true };
    if (d.commands_blocked?.includes(word)) return { note: t('chat.cmd.collision', { name: word }), warn: true, block: true };
    if (s.error || d.warning) return { note: t('chat.cmd.checkFailed'), warn: true, block: true };
    const row = d.commands?.find((r) => r.command === word);
    if (!row && d.owner_only?.includes(word)) return { note: t('chat.cmd.ownerOnly'), warn: true, block: true };
    if (!row) return { note: t('chat.cmd.unsupported', { name: word }), warn: true, block: true };
    if (row.required && !arg) return { note: t('chat.cmd.needArg', { name: word }), block: true };
    if (busy && !row.while_busy) return { note: t('chat.cmd.afterAnswer'), block: true };
    return { command: { name, arg }, note: t('chat.cmd.willRun', { name: word }) };
  }
  const skill = leadingCommand(text, skillItems);
  return skill ? { skill: skill.value.slice(1), note: t('chat.suggest.willSend', { name: skill.value }) } : {};
}
