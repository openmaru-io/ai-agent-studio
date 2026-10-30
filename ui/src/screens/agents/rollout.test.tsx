/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { bandKind, bandNote, bandSeverity, bandText, changedAgents, dismissedRollouts, dismissRollout, RolloutInfo, shortDigest } from './rollout';

const D = (c: string) => `reg.local/hermes@sha256:${c.repeat(64)}`;
const NOW = Date.parse('2026-10-29T10:00:00Z');

function info(over: Partial<RolloutInfo> = {}): RolloutInfo {
  return {
    name: 'hro-1', version: '1.0.6', phase: 'Rolling', message: '', image: D('2'), sidecar_image: '', rollback_of: '',
    canary: [], canary_info: null, batch: 1, batch_size: 2, skip_busy: true, paused: false, approved: false, aborted: false, blocking: true,
    total: 7, done: 4, updating: ['a5', 'a6'], waiting: 1, next_batch: ['a7'], deferred_busy: 0, suspended: 0, excluded: [],
    reverted: [], failed: [], started: '2026-10-29T09:00:00Z', completed: '', created_by: 'admin@x.com', agents: [],
    ...over,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  try {
    localStorage.clear();
  } catch {
    /* 없음 */
  }
});

describe('롤아웃 띠 판단(스펙 2026-10-28-015 디자인 리뷰)', () => {
  it('띠 하나에 우선순위: 진행 > 실패 > 끝남 24시간 > 차트 값과 다름 > 오래됨 알 수 없음(DD1·DD9)', () => {
    expect(bandKind({ rollout: info(), chart_differs: true }, NOW, [])).toBe('progress');
    expect(bandKind({ rollout: info({ phase: 'Failed', blocking: false }), chart_differs: true }, NOW, [])).toBe('failed');
    expect(bandKind({ rollout: info({ phase: 'Failed' }), chart_differs: true }, NOW, ['hro-1'])).toBe('chart'); // 닫은 실패 띠
    const done = info({ phase: 'Done', blocking: false, completed: '2026-10-29T00:00:00Z' });
    expect(bandKind({ rollout: done, ever: true }, NOW, [])).toBe('done');
    expect(bandKind({ rollout: { ...done, completed: '2026-10-27T00:00:00Z' }, ever: true }, NOW, [])).toBeNull(); // 24시간이 지나면 내린다
    expect(bandKind({ rollout: null, ever: false }, NOW, [])).toBe('unknown');
    expect(bandKind({ rollout: null, ever: true }, NOW, [])).toBeNull();
  });

  it('할 일이 있는 단계(승인 대기·멈춤·실패)만 warning(DD4)', () => {
    expect(['Canary', 'Rolling', 'Pending'].map((p) => bandSeverity('progress', p))).toEqual(['info', 'info', 'info']);
    expect(['WaitingApproval', 'Paused'].map((p) => bandSeverity('progress', p))).toEqual(['warning', 'warning']);
    expect(bandSeverity('failed')).toBe('warning');
    expect(bandSeverity('done')).toBe('info');
  });

  it('단계별 문구: 진행 중 묶음·지금 바꾸는 에이전트, 카나리 확인의 근거(DD4·DD11)', () => {
    const label = (n: string) => `L-${n}`;
    expect(bandText('progress', info(), label, NOW)).toBe('롤아웃 1.0.6 · 묶음 1 · 4/7 끝남 · 지금 L-a5, L-a6');
    const waiting = info({ phase: 'WaitingApproval', canary: ['c1'], canary_info: { name: 'c1', state: 'done', ready_seconds: 180, waiting_seconds: 720 } });
    expect(bandText('progress', waiting, label, NOW)).toBe('카나리 L-c1 이(가) 1.0.6 으로 떴습니다 · 준비까지 3분 · 12분째 기다림');
    expect(bandText('progress', info({ phase: 'Paused' }), label, NOW)).toContain('지금 바꾸던 묶음은 끝까지');
    expect(bandText('progress', info({ rollback_of: 'hro-0' }), label, NOW)).toBe('되돌리는 중 · 4/7 끝남');
    expect(bandText('failed', info({ phase: 'Failed', message: '묶음 2 실패 — a5: 노드 자리가 부족해 뜨지 못했습니다' }), label, NOW)).toContain('노드 자리가 부족');
  });

  it('크기 롤아웃은 우선순위가 같고 글만 다르다(스펙 2026-10-30-003 §4-7 1C·7A·R9)', () => {
    const label = (n: string) => `L-${n}`;
    const resize = info({ kind: 'resize', version: '기본 크기', image: '', done: 2, total: 3, updating: [] });
    expect(bandKind({ rollout: resize, chart_differs: true }, NOW, [])).toBe('progress');
    expect(bandText('progress', resize, label, NOW)).toBe('기본 크기를 적용하는 중 2 / 3');
    expect(bandText('progress', { ...resize, phase: 'Paused', failed: ['a3'] }, label, NOW)).toBe('2 / 3 에서 멈춤 · L-a3 노드 자리 없음');
    expect(bandSeverity('progress', 'Paused')).toBe('warning');
    const done = { ...resize, phase: 'Done', blocking: false, completed: '2026-10-29T09:00:00Z' };
    expect(bandKind({ rollout: done }, NOW, [])).toBe('done');
    expect(bandText('done', done, label, NOW)).toContain('기본 크기 적용을 마쳤습니다');
    expect(bandText('failed', { ...resize, phase: 'Failed', message: 'a3: 노드 자리 없음' }, label, NOW)).toBe('크기 적용이 실패했습니다: a3: 노드 자리 없음');
  });

  it('둘째 줄은 분모에 넣지 않은 것만, 0 은 뺀다(DD19)', () => {
    expect(bandNote(info())).toBe('');
    expect(bandNote(info({ suspended: 1, excluded: ['p'], deferred_busy: 2 }))).toBe('멈춤 1개는 켜질 때 반영 · 따로 지정됨 1개 제외 · 대화 중이라 미룸 2개');
  });

  it('되돌리기 대상은 바뀐(끝남·바꾸는 중·실패) 에이전트만', () => {
    const r = info({ agents: ['done', 'waiting', 'updating', 'reverted', 'failed'].map((s, i) => ({ name: `a${i}`, state: s })) });
    expect(changedAgents(r)).toEqual(['a0', 'a2', 'a4']);
  });

  it('digest 앞 12자', () => {
    expect(shortDigest(D('a'))).toBe('aaaaaaaaaaaa');
    expect(shortDigest('reg/h:1.0')).toBe('');
  });

  it('끝난 띠 닫기는 브라우저 저장이 실패해도 오류 없이 지나간다(DD9)', () => {
    dismissRollout('hro-1');
    expect(dismissedRollouts()).toEqual(['hro-1']);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => dismissRollout('hro-2')).not.toThrow();
    expect(dismissedRollouts()).toEqual([]);
  });
});
