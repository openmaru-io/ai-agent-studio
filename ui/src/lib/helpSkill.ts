/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 「AAS 사용법」 스킬(aas-help)의 SKILL.md 를 화면 가이드 문장으로 만든다(스펙 2026-10-18-001 B).
// 화면 카드와 같은 함수(guideTitle·stepBody 등)로 만들어, 가이드 문구를 고치면 스킬도 같이 바뀐다.
// 결과는 서버 이미지에 들어가는 aas/assets/aas_skill_packages/aas-help/SKILL.md 이고, 서버가 스킬 허브 기본 스킬로 게시한다(스펙 2026-10-29-001 §10-9).
// 판(version)은 파일에 있는 판을 이어 쓰고, 내용이 바뀌면 `npm run help-skill` 이 끝자리를 올린다(같은 판으로는 허브에 다시 게시되지 않는다).
// 다시 만들기: `npm run help-skill`. helpSkill.test.ts 가 파일이 최신인지 본다.
// 사용자 가이드만 넣는다(관리자 가이드는 넣지 않는다, D2). 한국어·영어를 한 파일에 둔다(D3).
import { getLang, hasKey, Lang, setLang, t } from '@/i18n';

import { GUIDES } from './guides';
import { guideSub, guideTitle, guideWhat, guideWhen, stepBody, stepTitle } from './guideText';
import { VIEWS, viewVisible } from './views';

function section(): string {
  const out: string[] = [`## ${t('helpSkill.title')} (${t('helpSkill.lang')})`, '', t('helpSkill.intro'), '', t('helpSkill.notices'), '', `### ${t('helpSkill.menu')}`, ''];
  const user = { admin: false };
  const groups = new Map<string, string[]>();
  for (const v of VIEWS) {
    if (!viewVisible(v.id, user)) continue;
    groups.set(v.group, [...(groups.get(v.group) ?? []), `${v.label}: ${v.sub}`]);
  }
  for (const [g, items] of groups) out.push(`- ${g}`, ...items.map((x) => `  - ${x}`));
  out.push('', `### ${t('helpSkill.guides')}`, '');
  for (const g of GUIDES.filter((x) => x.audience === 'user')) {
    out.push(`#### ${guideTitle(g)}`, '', guideSub(g));
    if (hasKey(`guides.${g.id}.what`)) out.push('', guideWhat(g));
    if (hasKey(`guides.${g.id}.when`)) out.push('', `${t('helpSkill.when')}: ${guideWhen(g)}`);
    out.push('', `${t('helpSkill.steps')}:`, '');
    g.steps.forEach((_, i) => out.push(`${i + 1}. ${stepTitle(g, i)} — ${stepBody(g, i)}`));
    out.push('');
  }
  return out.join('\n');
}

export function buildHelpSkill(version = '1.0.0'): string {
  const before = getLang();
  try {
    const head = [
      '---',
      'name: aas-help',
      // i18n-ignore: 스킬 설명은 한 줄에 한국어·영어를 함께 둔다(에이전트가 어느 언어 질문에도 이 스킬을 고르게, D3)
      'description: "CogentAI AAS 화면 사용법(메뉴·하고 싶은 일별 단계). AAS 화면에서 무엇을 어디서 하는지 물으면 쓴다. / How to use the CogentAI AAS screens; use when asked where or how to do something in AAS."',
      `version: ${version}`,
      'author: OPENMARU, Inc.',
      '---',
      '',
      // i18n-ignore: 생성 파일의 안내 주석(사람이 손으로 고치지 않게)
      '<!-- 자동 생성: cogentai-aas/ui/src/lib/helpSkill.ts (npm run help-skill). 손으로 고치지 않는다. -->',
      '',
    ].join('\n');
    const parts: string[] = [];
    for (const lang of ['ko', 'en'] as Lang[]) {
      setLang(lang);
      parts.push(section());
    }
    return head + parts.join('\n') + '\n';
  } finally {
    setLang(before);
  }
}

/** 생성한 스킬에 남으면 안 되는 자리 표시({v_profiles} 등) */
export const unfilled = (text: string): string[] => text.match(/\{[a-z_]+\}/g) ?? [];
