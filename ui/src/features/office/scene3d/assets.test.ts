/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('가구 모델 라이선스', () => {
  it('assets/models 의 모든 모델이 THIRD_PARTY_NOTICES.md 에 적혀 있다', () => {
    const models = readdirSync(join(__dirname, 'assets/models')).filter((f) => f.endsWith('.glb'));
    const notices = readFileSync(join(__dirname, '../../../../../THIRD_PARTY_NOTICES.md'), 'utf8');
    const missing = models.map((f) => f.replace(/\.glb$/, '')).filter((n) => !notices.includes(`\`${n}\``));
    expect(missing).toEqual([]);
  });
});
