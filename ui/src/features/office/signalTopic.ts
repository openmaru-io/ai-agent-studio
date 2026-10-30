/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 신호 토픽(스펙 2026-10-17-004 D9·D10): 토픽은 「바뀌었다」는 번호만 싣고, 번호가 바뀌면 기존 HTTP 조회를 다시 읽는다.
// 받은편지함(office:inbox:<이메일>)과 3D 카드(office:cards)가 쓴다. 웹소켓이 꺼졌거나 토픽이 살아 있지 않으면 거짓을 돌려
// 화면은 지금 주기로 HTTP 를 다시 읽는다(R6).
import { useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';

import type { Me } from '@/lib/data';
import { useTopic } from '@/lib/ws';

/** 받은편지함 신호 토픽 이름. 서버(server.inbox_topic)와 같다: 이메일은 소문자, 로그인을 끈 실행은 local. 내 정보를 아직 모르면 null. */
export function inboxTopic(me: Pick<Me, 'auth_enabled' | 'user'> | undefined): string | null {
  if (!me) return null;
  if (!me.auth_enabled) return 'office:inbox:local';
  const email = (me.user?.email ?? '').trim().toLowerCase();
  return email ? `office:inbox:${email}` : null;
}

/** 앞에서 본 번호와 다르면 참. 처음 받은 번호는 HTTP 가 이미 읽은 값과 같다고 보고 다시 읽지 않는다. */
export function signalChanged(prev: string | null, next: string): boolean {
  return prev !== null && prev !== next;
}

/** topic 의 값이 바뀔 때마다 queryKey 조회를 다시 읽는다. 돌려주는 값이 참이면 토픽이 살아 있다. */
export function useSignalTopic(topic: string | null, queryKey: readonly unknown[]): boolean {
  const qc = useQueryClient();
  const seen = useRef<string | null>(null);
  return useTopic<unknown>(topic, (data) => {
    const next = JSON.stringify(data);
    if (signalChanged(seen.current, next)) void qc.invalidateQueries({ queryKey });
    seen.current = next;
  });
}
