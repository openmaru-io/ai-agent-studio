/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 오피스에 있다는 신호를 보내고 지금 있는 사람 목록을 받는다(계획 007 P6a). 서버는 30초 동안 신호가 없으면 뺀다.
// 웹소켓이 살아 있으면 사람 목록은 토픽 office:people 로 받고, 신호는 들어올 때와 탭·얼굴이 바뀔 때만 pub 으로 보낸다 —
// 10초 신호는 서버가 연결을 보고 대신 쓴다(스펙 2026-10-26-001 §4-2, 리뷰 D15). 웹소켓이 없거나 옛 서버(unknown_topic)면
// 지금처럼 POST /api/office/presence 를 10초마다 보낸다. 탭을 바꿀 때 leave 를 보내지 않는다 — 보냈더니 다른 사람 화면에서
// 잠깐 사라졌다 다시 나타났다(2026-10-26 OKE 캡처). leave 는 오피스 화면을 떠날 때만 보낸다.
import { useCallback, useEffect, useRef, useState } from 'react';

import { post } from '@/lib/api';
import { useWsState, wsClient } from '@/lib/ws';

export interface Person {
  id: string;
  name: string;
  seed: string;
  viewing: string;
  me: boolean;
  email?: string;
  /** 그 사람의 부서. 관리자에게만 온다(스펙 2026-10-22-002, 「볼 부서」로 거를 때 쓴다). */
  department?: string;
}

export const PRESENCE_EVERY_MS = 10_000;
export const PEOPLE_TOPIC = 'office:people';

export function usePresence(viewing: string) {
  const [people, setPeople] = useState<Person[]>([]);
  // 옛 서버가 토픽을 모르면(unknown_topic) 이 화면에서는 POST 로 돌아간다(외부 검토 M2 — bad_pub 은 판별에 쓰지 않는다)
  const [refused, setRefused] = useState(false);
  const useWs = useWsState() === 'live' && !refused;
  const viewingRef = useRef(viewing);
  viewingRef.current = viewing;
  const wsRef = useRef(useWs);
  wsRef.current = useWs;

  const postBeat = useCallback(
    () =>
      post<{ people: Person[] }>('/api/office/presence', { viewing: viewingRef.current })
        .then((r) => setPeople(r.people ?? []))
        .catch(() => undefined),
    []
  );

  // 웹소켓: 들어올 때(다시 붙을 때 포함)와 탭이 바뀔 때만 신호를 보낸다. 구독보다 먼저 보낸다 — 서버는 연결의 메시지를
  // 차례로 처리하므로 첫 사람 목록에 내가 들어 있다. 구독을 먼저 보내면 첫 읽기가 신호보다 먼저 돌아 나 없는 목록을 받고,
  // 그 읽기 중에 온 다시 읽기는 허브가 건너뛰어 보조 주기(10초)까지 내가 안 보였다(2026-10-26 로컬 E2E, 0~10.5초)
  useEffect(() => {
    if (useWs) wsClient.publish(PEOPLE_TOPIC, { beat: viewing });
  }, [useWs, viewing]);

  // 웹소켓: 사람 목록 토픽을 구독한다(신호 뒤에). 다시 붙으면 다시 구독한다
  useEffect(() => {
    if (!useWs) return;
    return wsClient.subscribe(
      PEOPLE_TOPIC,
      (data) => setPeople(((data as { people?: Person[] }) ?? {}).people ?? []),
      (code) => {
        if (code === 'unknown_topic') setRefused(true);
      }
    );
  }, [useWs]);

  // HTTP: 지금처럼 10초마다. 탭이 바뀌면 바로 한 번 보낸다(반복은 다시 만들지 않는다)
  useEffect(() => {
    if (useWs) return;
    void postBeat();
    const id = window.setInterval(() => void postBeat(), PRESENCE_EVERY_MS);
    return () => window.clearInterval(id);
  }, [useWs, postBeat]);
  const firstView = useRef(true);
  useEffect(() => {
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    if (!wsRef.current) void postBeat();
  }, [viewing, postBeat]);

  // 오피스 화면을 떠날 때만 leave
  useEffect(
    () => () => {
      if (wsRef.current) wsClient.publish(PEOPLE_TOPIC, { leave: true });
      else void post('/api/office/presence', { leave: true }).catch(() => undefined);
    },
    []
  );

  const changeFace = useCallback(
    (seed: string) =>
      post('/api/office/face', { seed })
        // 얼굴은 office_people 에만 적힌다 — 신호를 한 번 보내야 사람 목록의 seed 가 바뀌어 모두에게 알려진다(외부 검토 M1)
        .then(() => (wsRef.current ? void wsClient.publish(PEOPLE_TOPIC, { beat: viewingRef.current }) : postBeat()))
        .catch(() => undefined),
    [postBeat]
  );
  return { people, changeFace };
}
