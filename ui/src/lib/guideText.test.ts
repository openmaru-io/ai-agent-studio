/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';

import { setLang } from '@/i18n';

import { guideById, resolveTarget } from './guides';
import { askText, stepBody, stepTitle } from './guideText';

// 「AI에게 묻기」가 채우는 글(스펙 2026-10-18-001 A). 에이전트는 AAS 화면을 모르므로 단계 내용·화면을 함께 넘긴다
describe('askText', () => {
  afterEach(() => setLang('ko'));

  it('가이드·단계 번호·단계 제목·단계 설명·지금 화면을 넣고 「막힌 점」으로 끝난다', () => {
    const g = guideById('user.messenger')!;
    const text = askText(g, 0, resolveTarget(g.steps[0].to!, 'main'));
    expect(text).toContain('메신저(텔레그램·디스코드·슬랙)로 대화하기');
    expect(text).toContain('1/3');
    expect(text).toContain(stepTitle(g, 0));
    expect(text).toContain(stepBody(g, 0));
    expect(text).toContain('프로파일 > main > 메신저 연결');
    expect(text).toContain('aas-help'); // 사용자 가이드는 AAS 사용법 스킬을 가리킨다
    expect(text.trimEnd().endsWith('막힌 점:')).toBe(true);
    expect(text).not.toMatch(/\{[a-z_]+\}/); // 자리 표시가 남지 않는다
  });

  it('화면이 없는 단계는 화면 줄을 빼고, 긴 설명은 400자로 자른다', () => {
    const g = guideById('user.messenger')!;
    const text = askText(g, 1, null);
    expect(text).not.toContain('지금 화면');
    const body = text.split('\n').find((l) => l.includes(stepBody(g, 1).slice(0, 20)))!;
    expect(body.length).toBeLessThanOrEqual(420);
  });

  it('관리자 가이드는 스킬을 가리키지 않는다(스킬에 관리자 가이드가 없다, D2)', () => {
    const g = guideById('admin.users')!;
    const text = askText(g, 0, null);
    expect(text).toContain('관리자 가이드');
    expect(text).not.toContain('aas-help');
  });

  it('영어 화면에서는 영어로 채운다', () => {
    setLang('en');
    const g = guideById('user.messenger')!;
    const text = askText(g, 0, null);
    expect(text).toContain('Step: 1/3');
    expect(text.trimEnd().endsWith('Where I am stuck:')).toBe(true);
  });
});
