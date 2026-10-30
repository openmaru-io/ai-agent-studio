/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 공지 띠와 계정 메뉴가 함께 쓰는 공지 목록과 닫은 공지(스펙 2026-10-24 공지 바 §4-5·9-14 E7).
// 목록은 토픽 `notices` 가 live 면 그 값을, 아니면 /api/me 의 notices 를 쓴다(R4). 배열이 아닌 값({error})은 버리고 지난 값을 둔다(O8).
// 닫은 공지는 localStorage 에 `공지 id:reshow_ts` 로 적는다. 관리자가 「닫은 사람에게 다시 보이기」로 고치면 reshow_ts 가 바뀌어 다시 보인다(3C).
// 저장소를 쓸 수 없으면(사생활 모드 등) 이번 탭의 메모리에만 둔다.
import { useEffect, useSyncExternalStore } from 'react';

import { useMe } from './data';
import { useTopic } from './ws';

export type NoticeKind = 'info' | 'feature' | 'maintenance' | 'deprecation' | 'outage';

export interface Notice {
  id: number;
  kind: NoticeKind;
  title: string;
  body: string;
  link: string;
  /** 시간대를 붙인 ISO 8601(UTC) */
  starts_at: string;
  ends_at: string;
  dismissible: boolean;
  updated_ts: string;
  reshow_ts: string;
}

export const NOTICE_KINDS: NoticeKind[] = ['outage', 'maintenance', 'deprecation', 'feature', 'info'];

/** 서버와 같은 순서: 장애 → 작업 → 중단 예정 → 새 기능 → 안내, 같은 종류는 시작이 늦은(새) 것 먼저 */
export function sortNotices(list: Notice[]): Notice[] {
  return [...list].sort((a, b) => NOTICE_KINDS.indexOf(a.kind) - NOTICE_KINDS.indexOf(b.kind) || Date.parse(b.starts_at) - Date.parse(a.starts_at));
}

export const DISMISSED_KEY = 'aas.notice.dismissed';
export const dismissKey = (n: Pick<Notice, 'id' | 'reshow_ts'>) => `${n.id}:${n.reshow_ts}`;

function load(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    const arr: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function save(set: Set<string>) {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...set]));
  } catch {
    // 저장소를 쓸 수 없으면 이번 탭에서만 숨긴다
  }
}

interface Snapshot {
  dismissed: Set<string>;
  /** 토픽으로 마지막에 받은 목록(배열일 때만) */
  topic: Notice[] | null;
}

let snap: Snapshot = { dismissed: load(), topic: null };
const subs = new Set<() => void>();
const emit = (next: Partial<Snapshot>) => {
  snap = { ...snap, ...next };
  subs.forEach((f) => f());
};
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};

export const noticeStore = {
  dismiss(n: Notice) {
    const next = new Set(snap.dismissed).add(dismissKey(n));
    save(next);
    emit({ dismissed: next });
  },
  restore(n: Notice) {
    const next = new Set(snap.dismissed);
    next.delete(dismissKey(n));
    save(next);
    emit({ dismissed: next });
  },
  /** 지금 목록에 없는 공지(끝났거나 다시 보이기로 키가 바뀐 것)의 닫은 기록을 지운다(Q-b) */
  prune(list: Notice[]) {
    const keep = new Set(list.map(dismissKey));
    const next = new Set([...snap.dismissed].filter((k) => keep.has(k)));
    if (next.size === snap.dismissed.size) return;
    save(next);
    emit({ dismissed: next });
  },
  setTopic(d: unknown) {
    if (Array.isArray(d)) emit({ topic: d as Notice[] });
  },
  /** 시험용: 저장소에서 다시 읽고 토픽 값을 비운다 */
  reset() {
    emit({ dismissed: load(), topic: null });
  },
};

export interface NoticesState {
  /** 이 사람에게 지금 보일 공지 전체(닫은 것 포함). 아직 받지 못했으면 undefined */
  all: Notice[] | undefined;
  /** 띠에 보일 공지(닫은 것 빼고) */
  visible: Notice[];
  isDismissed: (n: Notice) => boolean;
  dismiss: (n: Notice) => void;
  restore: (n: Notice) => void;
}

export function useNotices(): NoticesState {
  const live = useTopic<unknown>('notices', (d) => noticeStore.setTopic(d));
  const me = useMe();
  const s = useSyncExternalStore(subscribe, () => snap);
  const fromMe = me.data?.notices;
  const raw = live && s.topic ? s.topic : Array.isArray(fromMe) ? fromMe : (s.topic ?? undefined);
  const all = raw ? sortNotices(raw) : undefined;
  const isDismissed = (n: Notice) => s.dismissed.has(dismissKey(n));
  const sig = all ? all.map(dismissKey).join(',') : null;
  useEffect(() => {
    if (all) noticeStore.prune(all);
    // 목록의 키가 바뀔 때만 정리한다(all 은 그릴 때마다 새 배열이다)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  return {
    all,
    visible: all ? all.filter((n) => !(n.dismissible && isDismissed(n))) : [],
    isDismissed,
    dismiss: noticeStore.dismiss,
    restore: noticeStore.restore,
  };
}
