/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Section } from '@/components/bits';
import { setLang, t } from '@/i18n';

import { SECTION_ICONS, sectionIconFor } from './sectionIcons';

const SRC = join(__dirname, '..');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return files(p);
    return /\.tsx$/.test(f) && !/\.test\.tsx$/.test(f) ? [p] : [];
  });

/** 코드에서 섹션 제목으로 쓰는 번역 키: <Section title={t('…')}> 와 스킬 서랍의 <Group title={t('…')}>, 조건부 제목 */
function sectionKeys(): string[] {
  const keys = new Set<string>();
  for (const f of files(SRC)) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/<(?:Section|Group)\s+title=\{([^}]*)\}/g)) {
      for (const k of m[1].matchAll(/t\('([\w.-]+)'/g)) keys.add(k[1]);
    }
  }
  return [...keys].sort();
}

afterEach(() => setLang('ko'));

describe('섹션 제목 아이콘', () => {
  it('코드에서 섹션 제목으로 쓰는 번역 키는 모두 아이콘이 있다 — 새 섹션도 아이콘 없이 들어오지 않는다', () => {
    const keys = sectionKeys();
    expect(keys.length).toBeGreaterThan(60);
    expect(keys.filter((k) => !SECTION_ICONS[k])).toEqual([]);
  });

  it('번역된 제목(숫자가 들어간 것 포함)으로 아이콘을 찾는다. 한국어·영어 모두', () => {
    expect(sectionIconFor(t('common.kv.title'))).toBe(SECTION_ICONS['common.kv.title']);
    expect(sectionIconFor(t('flows.callersTitle', { n: 3 }))).toBe(SECTION_ICONS['flows.callersTitle']);
    setLang('en');
    expect(sectionIconFor(t('activity.whereFrom'))).toBe(SECTION_ICONS['activity.whereFrom']);
    expect(sectionIconFor('표에 없는 제목')).toBeUndefined();
  });

  it('Section 은 제목 앞에 아이콘을 그리고, 아이콘은 읽는 이름에 섞이지 않는다', () => {
    render(<Section title={t('activity.whereFrom')}>내용</Section>);
    const h = screen.getByRole('heading', { level: 3, name: '세션 출처' });
    const svg = h.querySelector('svg') as SVGElement;
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(h.firstElementChild).toBe(svg);
  });

  it('표에 없는 제목이나 제목 없는 Section 은 아이콘 없이 그린다', () => {
    const { container } = render(
      <>
        <Section title="아무 제목">가</Section>
        <Section>나</Section>
      </>
    );
    expect(container.querySelectorAll('svg')).toHaveLength(0);
  });
});
