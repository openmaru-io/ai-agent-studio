/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 가이드 문장(OMAI-1274). 화면·탭 이름은 화면에 보이는 글자의 사전 키를 끼워 넣는다: 화면 문구가 바뀌면 가이드도 따라 바뀐다.
import { hasKey, t } from '@/i18n';

import type { Guide, GuideTarget } from './guides';
import { GroupId, VIEWS } from './views';

const GROUP_IDS: GroupId[] = ['dashboard', 'talk', 'agent', 'skill', 'automation', 'records', 'admin', 'settings'];

/**
 * 가이드 문장의 {자리}에 들어갈 화면 이름. 읽는 때에 현재 언어로 만든다.
 * v_<화면 id>(하이픈은 _), g_<묶음 id>, p_<프로파일 탭> 은 모든 화면·묶음·탭에 대해 만든다.
 */
export const guideVars = (): Record<string, string> => {
  const vars: Record<string, string> = {
    chat: t('views.chat.label'),
    soulTab: t('profiles.pane.soul'),
    overviewTab: t('profiles.pane.overview'),
    mainModel: t('profiles.mainModel'),
    askModel: t('requests.askModel'),
    p_env: t('profiles.pane.env'),
    p_tools: t('profiles.pane.tools'),
    p_channels: t('profiles.pane.channels'),
    p_skills: t('profiles.skills'),
    p_cron: t('profiles.cron'),
    pcImport: t('profiles.pcImport.action'),
    pcProfile: t('profiles.pcImport.profileLabel'),
    pcPick: t('profiles.pcImport.pick'),
    pcReplace: t('profiles.pcImport.replace', { name: t('profiles.pcImport.nameHolder') }),   // 「<프로파일 이름> 내용 바꾸기」(OMAI-1444)
    newProfile: t('profiles.newProfile'),
    importLabel: t('profiles.importLabel'),
  };
  for (const v of VIEWS) vars[`v_${v.id.replace(/-/g, '_')}`] = v.label;
  for (const g of GROUP_IDS) vars[`g_${g}`] = t(`views.group.${g}`);
  return vars;
};

export const guideTitle = (g: Guide) => t(`guides.${g.id}.title`, guideVars());
export const guideSub = (g: Guide) => t(`guides.${g.id}.sub`, guideVars());
export const guideWhat = (g: Guide) => t(`guides.${g.id}.what`, guideVars());
export const guideWhen = (g: Guide) => t(`guides.${g.id}.when`, guideVars());
export const stepTitle = (g: Guide, i: number) => t(`guides.${g.id}.${g.steps[i].id}.title`, guideVars());
export const stepBody = (g: Guide, i: number) => t(`guides.${g.id}.${g.steps[i].id}.body`, guideVars());

const ASK_BODY_MAX = 400;

/** 가이드 단계가 여는 화면을 사람이 읽는 이름으로(예: 프로파일 > main > 메신저 연결). 모르면 빈 값 */
export function targetLabel(to: GuideTarget | null | undefined): string {
  if (!to) return '';
  const vars = guideVars();
  const parts = [vars[`v_${to.view.replace(/-/g, '_')}`] ?? to.view];
  const name = to.params?.name;
  const pane = to.params?.pane;
  if (name) parts.push(name);
  if (pane) parts.push(vars[`p_${pane}`] ?? (hasKey(`profiles.pane.${pane}`) ? t(`profiles.pane.${pane}`) : pane));
  return parts.join(' > ');
}

/**
 * 「AI에게 묻기」가 대화창에 채우는 글(스펙 2026-10-18-001 A). 에이전트(Hermes)는 AAS 화면과 가이드를 모르므로
 * 가이드·단계 제목·단계 설명·지금 화면을 함께 넘긴다. 사용자 가이드는 AAS 사용법 스킬(aas-help)을 가리킨다(관리자 가이드는 스킬에 없다, D2).
 */
export function askText(g: Guide, i: number, to: GuideTarget | null | undefined): string {
  const body = stepBody(g, i);
  const where = targetLabel(to);
  const lines = [
    t(g.audience === 'user' ? 'guides.ask.headSkill' : 'guides.ask.head'),
    t('guides.ask.guide', { name: guideTitle(g), audience: t(`guides.ask.audience.${g.audience}`) }),
    t('guides.ask.step', { step: i + 1, total: g.steps.length, title: stepTitle(g, i) }),
    t('guides.ask.body', { body: body.length > ASK_BODY_MAX ? body.slice(0, ASK_BODY_MAX) + '…' : body }),
    ...(where ? [t('guides.ask.where', { where })] : []),
    t('guides.ask.stuck'),
  ];
  return lines.join('\n');
}
