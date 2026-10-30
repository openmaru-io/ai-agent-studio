/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 「스킬」 화면의 첫 보기는 「내 스킬」이다(스펙 2026-10-27-011 R2). 다른 화면에서 스킬로 가는 링크는 기본 스킬도 가리키므로
// 보기를 직접 적어야 한다(R5·D2) — tab 없이 q·lens·open 만 넘기면 기본 스킬이 「없음」으로 보인다. 새 링크가 빠뜨리지 않게 소스를 훑는다.
import { describe, expect, it } from 'vitest';

const SOURCES = import.meta.glob(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const LINK = /to="skills"|to: 'skills'|`\/skills\?|'\/skills\?/;

describe('스킬 화면으로 가는 링크', () => {
  it('보기(tab)와 프로파일(profile 또는 open)을 적는다', () => {
    const missing: string[] = [];
    const noProfile: string[] = [];
    let seen = 0;
    for (const [file, text] of Object.entries(SOURCES)) {
      text.split('\n').forEach((line, i) => {
        if (!LINK.test(line)) return;
        seen += 1;
        if (!/tab[=:]/.test(line) && !/tab: '/.test(line)) missing.push(`${file}:${i + 1}: ${line.trim()}`);
        // 프로파일도 넘긴다(스펙 2026-10-27-013 §4-5·OV7). open 만 넘기는 링크는 화면이 찾은 줄의 프로파일을 고른다(R4)
        else if (!/profile[=:,\s}]/.test(line) && !/open[=:]/.test(line)) noProfile.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(seen).toBeGreaterThan(5);                                                  // 훑기가 실제로 링크를 찾았다
    expect(missing).toEqual([]);
    expect(noProfile).toEqual([]);
  });
});
