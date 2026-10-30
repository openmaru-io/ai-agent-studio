/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { batchPlan, needsChoice, oneConfirm, progressOf, reasonOf, rowKey, selectable, shownRows, stateOf, UpdRow } from './marketUpdates';

const row = (over: Partial<UpdRow> = {}): UpdRow => ({
  pod: 'p1',
  profile: 'work',
  package: 'free/outline',
  namespace: 'free',
  name: 'outline',
  skill: 'outline',
  kind: 'skill',
  current: '0.1.1',
  latest: '0.1.2',
  basis: 'record',
  mode: 'update',
  state: 'update',
  modified: 'same',
  ...over,
});

describe('새 버전 줄 상태(스펙 2026-10-24-003 10-3)', () => {
  it('고친 내용이 없다고 확인된 새 버전만 고를 수 있다', () => {
    expect(selectable(row())).toBe(true);
    for (const r of [row({ modified: 'changed' }), row({ modified: 'unknown' }), row({ modified: 'checking' }), row({ state: 'pending' }), row({ state: 'blocked', reason: 'root' })])
      expect(selectable(r)).toBe(false);
  });

  it('상태 글자·색과 고를 수 없는 이유', () => {
    expect(stateOf(row())).toEqual(['새 버전 있음', 'warn']);
    expect(stateOf(row({ modified: 'changed' }))).toEqual(['직접 고친 내용 있음', 'warn']);
    expect(stateOf(row({ modified: 'checking' }))).toEqual(['고친 내용 확인 중', undefined]);
    expect(stateOf(row({ state: 'auto_failed' }))).toEqual(['자동 업그레이드 실패', 'bad']);
    expect(stateOf(row({ state: 'blocked', reason: 'grant' }))[0]).toBe('업그레이드할 수 없음: 관리자 허용 필요');
    expect(stateOf(row({ state: 'kept' }))[0]).toBe('내가 고친 버전 사용 중');
    expect(reasonOf(row({ modified: 'changed' }))).toBe('직접 고친 내용이 있어 한꺼번에 업그레이드할 수 없습니다. 줄을 눌러 하나씩 업그레이드 하세요');
    expect(reasonOf(row())).toBeUndefined();
    expect(needsChoice(row({ modified: 'unknown', basis: 'folder' }))).toBe(true);
    expect(needsChoice(row())).toBe(false);
  });

  it('선택하여 업그레이드 확인 문구는 빠지는 줄 수를 말한다', () => {
    const a = row();
    const b = row({ profile: 'other', modified: 'changed' });
    expect(batchPlan([a, b], new Set([rowKey(a), rowKey(b)]))).toMatchObject({ go: [a], left: 1, text: '스킬 1개를 새 버전으로 업그레이드 합니다. 직접 고친 내용이 있는 1개는 빠집니다. 그 스킬은 줄을 눌러 하나씩 업그레이드 하세요.' });
    expect(batchPlan([a, b], new Set([rowKey(a)])).text).toBe('스킬 1개를 새 버전으로 업그레이드 합니다.');
  });

  it('넣은 줄의 진행: 사라진 줄은 완료로 남고 실패·대기를 센다', () => {
    const a = row();
    const b = row({ profile: 'b' });
    const c = row({ profile: 'c' });
    const batch = new Map([a, b, c].map((r): [string, UpdRow] => [rowKey(r), r]));
    const now = [row({ profile: 'b', state: 'failed' }), row({ profile: 'c', state: 'pending' })];
    expect(progressOf(new Set(batch.keys()), now)).toEqual({ total: 3, done: 1, failed: 1, waiting: 1 });
    expect(shownRows(now, false, batch).map((r) => [r.profile, r.state])).toEqual([
      ['b', 'failed'],
      ['c', 'pending'],
      ['work', 'done'],
    ]);
  });

  it('건너뜀·유지 중 줄은 「건너뛴 것 보기」를 켤 때만 보인다', () => {
    const rows = [row(), row({ profile: 's', state: 'skipped' }), row({ profile: 'k', state: 'kept' })];
    expect(shownRows(rows, false, new Map())).toHaveLength(1);
    expect(shownRows(rows, true, new Map())).toHaveLength(3);
  });

  it('한 줄 확인 문구(D10)', () => {
    expect(oneConfirm(row())).toBe('work 프로파일의 outline 스킬을 v0.1.1 에서 v0.1.2 로 업그레이드 합니다. 새 버전은 다음 대화부터 적용됩니다.');
  });
});
