/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 레지스트리 확인 띠·서랍·판 칸(스펙 2026-11-17-001 §4-3)
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { t } from '@/i18n';
import { mountScreen } from '@/test/mountScreen';

import { bandKind, bandSeverity, bandText, deletedDigests, RegistryStatus, rolloutBanner, RolloutInfo, RolloutLive, RolloutStartForm, VersionCell } from './rollout';

const D = (c: string) => `sha256:${c.repeat(64)}`;
const NOW = Date.parse('2026-11-17T10:00:00Z');
const SIDE = 'reg.local/images/cogentai-aas-sidecar';

function info(over: Partial<RolloutInfo> = {}): RolloutInfo {
  return {
    name: 'hro-1', version: '1.0.6', phase: 'Rolling', message: '', image: '', sidecar_image: `${SIDE}@${D('2')}`, rollback_of: '',
    canary: [], canary_info: null, batch: 1, batch_size: 2, skip_busy: true, paused: false, approved: false, aborted: false, blocking: true,
    total: 7, done: 4, updating: [], waiting: 1, next_batch: [], deferred_busy: 0, suspended: 0, excluded: [],
    reverted: [], failed: [], started: '2026-11-17T09:00:00Z', completed: '', created_by: 'admin@x.com', agents: [],
    ...over,
  };
}

function reg(over: Partial<RegistryStatus> = {}): RegistryStatus {
  return { check: 'ok', missing_images: [], last_checked: '2026-11-17T09:55:00Z', last_error: null, stalled: false, ...over };
}

const missing = (agents: string[], repo = SIDE, digest = D('1')) => ({ repo, digest, agents, since: '2026-11-17T09:00:00Z', namespace: 'agents' });
const noop = () => undefined;
const on = { pause: noop, resume: noop, rollback: noop, retry: noop, detail: noop, openCanary: noop, close: noop, start: noop, reload: noop };

describe('레지스트리 띠 우선순위·색', () => {
  it('missing 은 진행 중보다 먼저, registryUnavailable 은 실패 다음이다. 둘 다 닫기 목록과 상관없다', () => {
    const m = reg({ missing_images: [missing(['a1'])] });
    expect(bandKind({ rollout: info(), registry: m }, NOW, [])).toBe('missing');
    expect(bandKind({ rollout: info({ phase: 'Failed' }), registry: m }, NOW, ['hro-1'])).toBe('missing');
    const un = reg({ check: 'unavailable' });
    expect(bandKind({ rollout: info(), registry: un }, NOW, [])).toBe('progress');
    expect(bandKind({ rollout: info({ phase: 'Failed' }), registry: un }, NOW, [])).toBe('failed');
    expect(bandKind({ rollout: info({ phase: 'Failed' }), registry: un }, NOW, ['hro-1'])).toBe('registryUnavailable');
    expect(bandKind({ rollout: null, ever: true, registry: reg({ check: 'disabled' }) }, NOW, [])).toBeNull(); // 일부러 끈 것은 띠 없음
    expect(bandKind({ rollout: null, ever: true, registry: reg({ check: 'unknown' }) }, NOW, [])).toBeNull();
    expect(bandSeverity('missing')).toBe('warning');
    expect(bandSeverity('registryUnavailable')).toBe('info');
  });

  it('missing 첫 줄은 저장소가 하나면 컨테이너 이름, 여럿이면 개수. 작업공간 수는 겹치지 않게 센다', () => {
    const one = reg({ missing_images: [missing(['a1', 'a2'])] });
    expect(bandText('missing', null, (n) => n, NOW, one)).toBe(t('rollout.band.missing', { container: t('rollout.container.sidecar'), n: 2 }));
    const two = reg({ missing_images: [missing(['a1', 'a2']), missing(['a2', 'a3'], 'reg.local/images/cogentai-aas-hermes', D('3'))] });
    expect(bandText('missing', null, (n) => n, NOW, two)).toBe(t('rollout.band.missingMany', { count: 2, n: 3 }));
    expect(bandText('registryUnavailable', null, (n) => n, NOW, reg({ check: 'unavailable', stalled: true }))).toBe(t('rollout.band.registryStalled'));
  });

  it('ImageMissing 실패는 개수만 적고 「다시 시도」 대신 「digest 고쳐서 새로 만들기」', () => {
    const r = info({ phase: 'Failed', reason: 'ImageMissing', unavailable_targets: [
      { repo: SIDE, digest: D('1'), container: 'sidecar', field: 'target', agents: ['a1'] },
      { repo: SIDE, digest: D('1'), container: 'sidecar', field: 'default', agents: [] },
    ] });
    expect(bandText('failed', r, (n) => n, NOW)).toBe(t('rollout.band.failedImageMissing', { n: 1 }));
    const b = rolloutBanner({ rollout: r }, { now: NOW, dismissed: [], labelOf: (n) => n, readError: false, on });
    mountScreen(<>{b?.action}</>, '/');
    expect(screen.getAllByRole('button', { name: t('rollout.action.fixAndCreate') }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: t('rollout.retry') })).toBeNull();
    expect(deletedDigests({ rollout: r, registry: reg({ missing_images: [missing(['a1'], SIDE, D('9'))] }) }).sort()).toEqual([D('1'), D('9')].sort());
  });

  it('missing 띠에는 닫기가 없고 「자세히」 → 「새 롤아웃 만들기」 순서다', () => {
    const b = rolloutBanner({ rollout: null, registry: reg({ missing_images: [missing(['a1'])] }) }, { now: NOW, dismissed: [], labelOf: (n) => n, readError: false, on: { ...on, registryDetail: noop } });
    mountScreen(<>{b?.action}</>, '/');
    const names = screen.getAllByRole('button').map((x) => x.textContent);
    expect(names).toEqual([t('rollout.detail'), t('rollout.action.newRollout')]);
    expect(b?.severity).toBe('warning');
  });
});

describe('시작 서랍·판 칸·알림', () => {
  it('지워진 digest 는 미리 채우지 않고, 넣으면 제출을 막는다', async () => {
    const gone = `${SIDE}@${D('1')}`;
    mountScreen(<RolloutStartForm agents={[{ name: 'a1', label: 'a1' }]} prefill={{ version: '1.0.6', sidecar_image: gone }} deleted={[D('1')]} />, '/');
    const side = screen.getByLabelText(t('rollout.form.sidecar')) as HTMLTextAreaElement;
    expect(side.value).toBe('');
    await userEvent.type(side, gone);
    expect(screen.getByText(t('rollout.form.digestDeleted'))).toBeTruthy();
    expect((screen.getByRole('button', { name: t('rollout.form.submit') }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('digest 가 아닌 미리 채움(차트 태그)은 넣지 않는다', () => {
    // 2026-11-18 OKE: missing 띠의 「새 롤아웃 만들기」가 목표 사이드카(차트 태그 …:1.0.5)를 채워 처음부터 형식 오류가 떴다
    mountScreen(<RolloutStartForm agents={[{ name: 'a1', label: 'a1' }]} prefill={{ image: `reg.local/h@${D('5')}`, sidecar_image: `${SIDE}:1.0.5` }} />, '/');
    expect((screen.getByLabelText(t('rollout.form.sidecar')) as HTMLTextAreaElement).value).toBe('');
    expect((screen.getByLabelText(t('rollout.form.image')) as HTMLTextAreaElement).value).toBe(`reg.local/h@${D('5')}`);
    expect(screen.queryByText(t('rollout.form.digestBad'))).toBeNull();
  });

  it('대체 이미지 에이전트는 「오래됨」 대신 「대체 이미지」', () => {
    mountScreen(<VersionCell x={{ image_digest: `reg.local/h@${D('4')}`, version: '1.0.5', outdated: true, image_fallback: 'sidecar' }} />, '/');
    expect(screen.getByText(t('rollout.pill.fallback'))).toBeTruthy();
    expect(screen.queryByText(t('rollout.outdated'))).toBeNull();
  });

  it('missing 띠가 사라질 때 한 번 알린다', async () => {
    function Harness() {
      const [gone, setGone] = useState(false);
      return (
        <>
          <button onClick={() => setGone(true)}>flip</button>
          <RolloutLive r={null} registry={gone ? reg() : reg({ missing_images: [missing(['a1'])] })} />
        </>
      );
    }
    mountScreen(<Harness />, '/');
    expect(screen.getByRole('status').textContent).toBe('');
    await userEvent.click(screen.getByRole('button', { name: 'flip' }));
    expect(screen.getByRole('status').textContent).toBe(t('rollout.live.imageBack'));
  });
});
