/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';

import type { Me } from '@/lib/data';

import { canWithdraw, myPublishEmail } from './WithdrawPublishButton';

describe('거두기 단추를 보일 조건(스펙 2026-11-20-009 §3-2 6)', () => {
  it('요청자 이메일은 소문자로, 로그인이 꺼진 설치는 local, 아직 모르면 빈 값', () => {
    expect(myPublishEmail({ auth_enabled: true, user: { email: 'Kim@X.io' } } as Me)).toBe('kim@x.io');
    expect(myPublishEmail({ auth_enabled: false, user: null } as Me)).toBe('local');
    expect(myPublishEmail(undefined)).toBe(''); // 불러오는 중 — 예외 없이 단추를 숨긴다
    expect(myPublishEmail({ auth_enabled: true, user: null } as Me)).toBe('');
  });
  it('기다리는 내 요청에만 — 같은 프로파일이라도 남의 요청·다른 상태·모르는 나는 아니다', () => {
    expect(canWithdraw({ status: 'requested', who: 'KIM@x.io' }, 'kim@x.io')).toBe(true);
    expect(canWithdraw({ status: 'requested', who: 'lee@x.io' }, 'kim@x.io')).toBe(false);
    for (const status of ['published', 'pending_review', 'rejected', 'withdrawn', 'failed', 'publishing'])
      expect(canWithdraw({ status, who: 'kim@x.io' }, 'kim@x.io')).toBe(false);
    expect(canWithdraw({ status: 'requested', who: '' }, '')).toBe(false);
  });
});
