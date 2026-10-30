/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 오피스 서버 상태를 웹소켓 토픽(켜져 있으면) 또는 SSE 로 따라간다. 끊기면 EventSource 가 Last-Event-ID 로 이어 받고, 자리가 바뀌면 상태를 다시 받는다.
import { useEffect, useRef, useState } from 'react';

import { applyOfficeEvent, OfficeEvent, OfficeState } from '@/features/office/model';
import { get } from '@/lib/api';
import { topicSource, wsClient } from '@/lib/ws';

export interface OfficeLive {
  state: OfficeState | null;
  /** 스트림이 이어져 있는지. false 면 화면은 마지막으로 받은 상태를 보여 준다. */
  live: boolean;
  error: string;
  /** 마지막으로 상태나 이벤트를 받은 시각(ms). 끊김 표시 「마지막 갱신 n초 전」에 쓴다(G4). */
  updatedAt: number;
}

/** onRefresh: 자리·책상이 바뀌어 상태를 다시 받을 때 함께 부른다. 관리자 화면이 `/api/office`(방 구성원 부서)를 다시 읽는 데 쓴다(스펙 2026-10-22-002 리뷰 R3). */
export function useOfficeState(onRefresh?: () => void): OfficeLive {
  const refreshed = useRef(onRefresh);
  refreshed.current = onRefresh;
  const [state, setState] = useState<OfficeState | null>(null);
  const [live, setLive] = useState(false);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState(0);

  useEffect(() => {
    let closed = false;
    let current: OfficeState = { agents: [], seq: 0 };
    const set = (next: OfficeState) => {
      current = next;
      if (!closed) {
        setState(next);
        setUpdatedAt(Date.now());
      }
    };
    const reload = () =>
      get<OfficeState & { layout_version?: number }>('/api/office/state')
        .then((s) => {
          setError('');
          // 방 이름표(rooms)도 함께 받는다. 빼면 웹소켓 첫 상태(snapshot) 뒤에 이 응답이 오는 순서일 때 이름표가 사라져
          // 장면이 「팀 회의실 N」·「TFT 회의실 N」 기본 이름으로 돌아간다(계획 2026-10-13-011 §8, OKE 에서 확인)
          set({
            agents: s.agents,
            seq: Math.max(s.seq, current.seq),
            desks: s.desks ?? {},
            layoutVersion: s.layout_version ?? 0,
            rooms: s.rooms ?? current.rooms,
          });
        })
        .catch((e: Error) => !closed && setError(e.message));

    // 웹소켓이 켜져 있으면 토픽 office:state 로, 아니면 SSE 로 받는다(OMAI-1100). 이벤트 모양은 같다
    const es = wsClient.usable ? topicSource('office:state') : new EventSource('/api/office/stream');
    es.onopen = () => setLive(true);
    es.onmessage = (m: { data: string; lastEventId: string }) => {
      let ev: OfficeEvent;
      try {
        ev = JSON.parse(m.data) as OfficeEvent;
      } catch {
        return;
      }
      setLive(true);
      setError('');
      const out = applyOfficeEvent(current, Number(m.lastEventId) || current.seq, ev);
      set(out.state);
      if (out.refresh) {
        void reload();
        refreshed.current?.();
      }
    };
    es.onerror = () => setLive(false);
    void reload();
    return () => {
      closed = true;
      es.close();
    };
  }, []);

  return { state, live, error, updatedAt };
}
