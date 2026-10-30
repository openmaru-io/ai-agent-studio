/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { CARDS_EVERY_MS, CARDS_LIVE_EVERY_MS } from './cards';
import { type ActiveMeeting,activeMeetingsRefetchMs } from './meetings';
import { inboxTopic, signalChanged } from './signalTopic';
import { INBOX_EVERY_MS, INBOX_LIVE_EVERY_MS } from './useInbox';

// 신호 토픽과 HTTP 대비 주기(스펙 2026-10-17-004 D6·D9·D10·R6)
describe('받은편지함 토픽 이름', () => {
  it('서버와 같이 소문자 이메일, 로그인을 끈 실행은 local, 모르면 구독하지 않는다', () => {
    expect(inboxTopic({ auth_enabled: true, user: { email: ' Alice@Example.com ' } })).toBe('office:inbox:alice@example.com');
    expect(inboxTopic({ auth_enabled: false, user: null })).toBe('office:inbox:local');
    expect(inboxTopic({ auth_enabled: true, user: null })).toBeNull();
    expect(inboxTopic(undefined)).toBeNull();
  });
});

describe('신호가 바뀌었는가', () => {
  it('처음 받은 값은 다시 읽지 않고, 그 뒤 달라질 때만 다시 읽는다', () => {
    expect(signalChanged(null, 'a')).toBe(false);
    expect(signalChanged('a', 'a')).toBe(false);
    expect(signalChanged('a', 'b')).toBe(true);
  });
});

describe('HTTP 대비 주기', () => {
  it('토픽이 살아 있으면 받은편지함 30초·카드 60초, 아니면 지금처럼 15초·20초', () => {
    expect([INBOX_EVERY_MS, INBOX_LIVE_EVERY_MS]).toEqual([15_000, 30_000]);
    expect([CARDS_EVERY_MS, CARDS_LIVE_EVERY_MS]).toEqual([20_000, 60_000]);
  });

  it('진행 중인 회의는 토픽이 살아 있으면 HTTP 를 끄고, 아니면 답 대기 1.5초·평소 5초', () => {
    const waiting = { meetings: [{ room: 1, pending: ['a'] } as unknown as ActiveMeeting] };
    expect(activeMeetingsRefetchMs(waiting, true)).toBe(false);
    expect(activeMeetingsRefetchMs(waiting, false)).toBe(1500);
    expect(activeMeetingsRefetchMs({ meetings: [] }, false)).toBe(5000);
    expect(activeMeetingsRefetchMs(undefined, false)).toBe(5000);
  });
});
