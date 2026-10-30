/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 스킬 허브 「새 버전 있음」 탭의 줄 상태와 문구(스펙 docs-plan/marketplace/skill-update-notice.md 2026-10-24-003 §10).
// 화면 조각 없이 순수 함수만 둔다 — 상태표(10-3)와 확인 창 문구를 Vitest 로 본다.
import type { Tone } from '@/components/ListView';
import { t } from '@/i18n';

export type UpdState = 'update' | 'pending' | 'installing' | 'failed' | 'auto_failed' | 'kept' | 'blocked' | 'unreadable' | 'skipped' | 'done';

export interface UpdRow {
  pod: string;
  pod_name?: string;
  pod_owner_name?: string;
  profile: string;
  package: string;
  namespace: string;
  name: string;
  skill: string;
  kind: 'skill' | 'agent';
  current: string;
  latest: string;
  basis: 'record' | 'folder';
  mode: 'update' | 'skills';
  state: UpdState;
  reason?: 'root' | 'grant' | '';
  modified?: 'same' | 'changed' | 'unknown' | 'checking';
  message?: string;
}

export interface UpdData {
  rows: UpdRow[];
  hub_ok: boolean;
  hub_error?: string;
  configured?: boolean;
  pods_failed: { pod: string; name?: string; owner_name?: string }[];
  checked_at: string;
  scope: 'pod' | 'managed';
  managed_count: number;
  admin: boolean;
  can: boolean;
  auto: boolean;
  defaults?: string[];
  affected?: number;
}

export const rowKey = (r: Pick<UpdRow, 'pod' | 'profile' | 'package'>) => `${r.pod}/${r.profile}/${r.package}`;

/** 「선택하여 업그레이드」로 고를 수 있는 줄: 새 버전이 있고 고친 내용이 없다고 확인된 줄(D7·R6) */
export const selectable = (r: UpdRow) => r.state === 'update' && r.modified === 'same';

/** 기본으로 숨기는 줄(「건너뛴 것 보기」를 켜면 보인다, D18) */
export const hiddenByDefault = (r: UpdRow) => r.state === 'skipped' || r.state === 'kept';

/** 줄 상태의 글자와 색(10-3 상태표). 색이 없으면 회색 점이다 */
export function stateOf(r: UpdRow): [string, Tone | undefined] {
  switch (r.state) {
    case 'update':
      if (r.modified === 'changed') return [t('market.upd.state.changed'), 'warn'];
      if (r.modified === 'unknown') return [t('market.upd.state.unknown'), 'warn'];
      if (r.modified === 'checking') return [t('market.upd.state.checking'), undefined];
      return [t('market.upd.state.update'), 'warn'];
    case 'failed':
      return [t('market.upd.state.failed'), 'bad'];
    case 'auto_failed':
      return [t('market.upd.state.autoFailed'), 'bad'];
    case 'pending':
      return [t('market.upd.state.pending'), undefined];
    case 'installing':
      return [t('market.upd.state.installing'), undefined];
    case 'blocked':
      return [t(r.reason === 'root' ? 'market.upd.state.blockedRoot' : 'market.upd.state.blockedGrant'), undefined];
    case 'unreadable':
      return [t('market.upd.state.unreadable'), undefined];
    case 'kept':
      return [t('market.upd.state.kept'), undefined];
    case 'skipped':
      return [t('market.upd.state.skipped'), undefined];
    case 'done':
      return [t('market.upd.state.done'), undefined];
  }
}

/** 고를 수 없는 줄의 이유(체크 칸 도움말). 고를 수 있으면 undefined */
export function reasonOf(r: UpdRow): string | undefined {
  if (selectable(r)) return undefined;
  if (r.state === 'update' && (r.modified === 'changed' || r.modified === 'unknown')) return t('market.upd.why.modified');
  if (r.state === 'update' && r.modified === 'checking') return t('market.upd.why.checking');
  return stateOf(r)[0];
}

/** 줄을 눌러 하나씩 올릴 때 「로컬 사본」·「덮기」를 물어야 하나(고친 내용 있음·모름·폴더 이름으로 찾음, R21) */
export const needsChoice = (r: UpdRow) => r.state === 'update' && r.modified !== 'same' && r.modified !== 'checking';

/** 선택하여 업그레이드의 확인 문구. 고른 줄 가운데 지금 고를 수 없는 줄(그사이 고친 내용이 확인됨)은 빠진다 */
export function batchPlan(rows: UpdRow[], selected: Set<string>): { go: UpdRow[]; left: number; text: string } {
  const picked = rows.filter((r) => selected.has(rowKey(r)));
  const go = picked.filter(selectable);
  const left = picked.length - go.length;
  return { go, left, text: left ? t('market.upd.batchConfirmSome', { n: go.length, m: left }) : t('market.upd.batchConfirm', { n: go.length }) };
}

/** 이번에 넣은 줄의 진행. 목록에서 사라졌거나 다른 상태가 된 줄은 끝난 것으로 센다 */
export function progressOf(batch: Set<string>, rows: UpdRow[]): { total: number; done: number; failed: number; waiting: number } {
  const byKey = new Map(rows.map((r) => [rowKey(r), r]));
  let done = 0;
  let failed = 0;
  let waiting = 0;
  for (const key of batch) {
    const r = byKey.get(key);
    if (r && (r.state === 'failed' || r.state === 'auto_failed')) failed++;
    else if (r && (r.state === 'pending' || r.state === 'installing' || r.state === 'update')) waiting++;
    else done++;
  }
  return { total: batch.size, done, failed, waiting };
}

/** 표에 보일 줄: 숨김 규칙을 걸고, 이번에 넣어 끝난 줄은 「완료」로 남긴다(D9) */
export function shownRows(rows: UpdRow[], showHidden: boolean, batch: Map<string, UpdRow>): UpdRow[] {
  const keys = new Set(rows.map(rowKey));
  const finished = [...batch.entries()].filter(([k]) => !keys.has(k)).map(([, r]) => ({ ...r, state: 'done' as const }));
  return [...rows.filter((r) => showHidden || !hiddenByDefault(r)), ...finished];
}

/** 줄을 하나씩 올릴 때의 확인 문구(D10) */
export const oneConfirm = (r: UpdRow) => t('market.upd.oneConfirm', { profile: r.profile, skill: r.skill, from: r.current, to: r.latest });
