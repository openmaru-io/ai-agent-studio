/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { getLang } from '@/i18n';

import { GUIDES } from './guides';
import { guideTitle, stepBody } from './guideText';
import { buildHelpSkill, unfilled } from './helpSkill';

// 서버 이미지에 들어가는 스킬 파일(스펙 2026-10-18-001 B). `npm run help-skill`(UPDATE_HELP_SKILL=1)이 다시 쓴다
const OUT = join(__dirname, '../../../aas/assets/aas_skill_packages/aas-help/SKILL.md');

// 파일의 판을 이어 쓴다. 내용이 바뀌었으면 끝자리를 올린다(스펙 2026-10-29-001 F11 — 같은 판은 허브에 다시 게시되지 않는다)
function fileVersion(): string {
  const m = existsSync(OUT) ? /^version: (\d+)\.(\d+)\.(\d+)$/m.exec(readFileSync(OUT, 'utf-8')) : null;
  return m ? `${m[1]}.${m[2]}.${m[3]}` : '1.0.0';
}
function bumped(v: string): string {
  const [a, b, c] = v.split('.').map(Number);
  return `${a}.${b}.${c + 1}`;
}

describe('aas-help 스킬', () => {
  let text = buildHelpSkill(fileVersion());

  if (process.env.UPDATE_HELP_SKILL) {
    if (existsSync(OUT) && readFileSync(OUT, 'utf-8') !== text) text = buildHelpSkill(bumped(fileVersion()));
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, text);
  }

  it('사용자 가이드는 모두 단계 설명까지 들어 있고, 관리자 가이드는 없다(D2)', () => {
    for (const g of GUIDES) {
      if (g.audience === 'user') {
        expect(text, g.id).toContain(guideTitle(g));
        g.steps.forEach((_, i) => expect(text, `${g.id}#${i}`).toContain(stepBody(g, i)));
      } else expect(text, g.id).not.toContain(guideTitle(g));
    }
  });

  it('한국어·영어가 모두 있고(D3), 자리 표시가 남지 않으며, 화면 언어를 되돌린다', () => {
    expect(text).toContain('## CogentAI AAS 사용법 (한국어)');
    expect(text).toContain('## How to use CogentAI AAS (English)');
    expect(text.startsWith('---\nname: aas-help\n')).toBe(true);
    expect(unfilled(text)).toEqual([]);
    expect(getLang()).toBe('ko');
  });

  it('서버 이미지에 들어가는 파일이 최신이다 — 다르면 `npm run help-skill` 로 다시 만든다', () => {
    expect(existsSync(OUT)).toBe(true);
    expect(readFileSync(OUT, 'utf-8')).toBe(text);
  });
});
