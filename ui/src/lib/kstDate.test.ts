/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { formatKst } from './kstDate';

describe('formatKst', () => {
  it('실행 환경의 시간대와 무관하게 한국 시간(+0900)으로 git --date=iso 와 같은 모양을 만든다', () => {
    expect(formatKst(new Date('2026-10-18T09:08:19Z'))).toBe('2026-10-18 18:08:19 +0900');
  });

  it('날짜가 넘어가는 시각도 맞다', () => {
    expect(formatKst(new Date('2026-12-31T15:00:05Z'))).toBe('2027-01-01 00:00:05 +0900');
  });
});
