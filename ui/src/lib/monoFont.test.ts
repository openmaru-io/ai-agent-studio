/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MONO_FONT } from './monoFont';

const SRC = join(__dirname, '..');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

describe('고정폭 글꼴', () => {
  it('JetBrains Mono 가 첫째이고 고정폭이 마지막 대체다', () => {
    expect(MONO_FONT.startsWith("'JetBrains Mono'")).toBe(true);
    expect(MONO_FONT.endsWith('monospace')).toBe(true);
  });

  it('fonts.css 가 폐쇄망용으로 번들한 파일만 가리킨다(외부 주소 없음)', () => {
    const css = readFileSync(join(SRC, 'fonts.css'), 'utf8');
    const urls = [...css.matchAll(/url\('([^']+)'\)/g)].map((m) => m[1]).filter((u) => u.includes('jetbrains-mono'));
    expect(urls.length).toBe(2);
    for (const u of urls) {
      expect(u.startsWith('./assets/fonts/jetbrains-mono/')).toBe(true);
      expect(statSync(join(SRC, u)).size).toBeGreaterThan(1000);
    }
  });

  it("화면 코드가 'monospace' 를 직접 쓰지 않는다 — MONO_FONT 를 쓴다(3D 장면 원본·시험 제외)", () => {
    const bad = walk(SRC)
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes('scene3d') && !/\.test\./.test(f) && !f.endsWith('monoFont.ts'))
      .filter((f) => /fontFamily:\s*['"]monospace['"]/.test(readFileSync(f, 'utf8')));
    expect(bad).toEqual([]);
  });
});
