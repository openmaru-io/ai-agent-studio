/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { isAutoProfile } from './mindwikiAuto';

describe('isAutoProfile', () => {
  it('서버 is_auto_profile 과 같은 경계', () => {
    for (const n of ['mindwiki-auto', 'mindwiki-auto-web', 'mwauto-x', 'mwauto-web-x', 'mwauto-team-alpha', `mwauto-${'a'.repeat(30)}`]) {
      expect(isAutoProfile(n)).toBe(true);
    }
    for (const n of ['mindwiki-autox', 'mwautox', 'x-mwauto', 'mwauto-', 'mwauto-X', 'main', `mwauto-${'a'.repeat(31)}`]) {
      expect(isAutoProfile(n)).toBe(false);
    }
  });
});
