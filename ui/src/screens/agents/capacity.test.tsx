/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountScreen, postedTo, stubApi } from '@/test/mountScreen';

import { capacityAvailable, capacityCard, CapacityData, CapacityPanel, ownerSizeChanges, SizeForm, sizeKv, SizesData,sizeShort } from './capacity';

afterEach(() => vi.unstubAllGlobals());

const NOW = Date.parse('2026-10-30T10:00:30Z');
const node = (name: string, slots: number, limited_by = 'memory') => ({
  name, slots, free_cpu: 8, free_memory: 2 ** 30, cpu_request_pct: 50, memory_request_pct: 97, memory_limit_pct: 294, limited_by,
});
function cap(over: Partial<CapacityData> = {}): CapacityData {
  return {
    state: 'ok', slots: 15, by_node: [node('oke-worker-1', 0), node('oke-worker-2', 1), node('oke-worker-5', 14)], top_node: { name: 'oke-worker-5', slots: 14 },
    pending: { count: 0, slots: 0 }, quota_limited: false, computed_at: '2026-10-30T10:00:00Z', checked_at: '2026-10-30T10:00:00Z',
    pod: { cpu: 0.51, memory: 1344 * 2 ** 20 }, short: { memory: 1 }, ...over,
  };
}
const NONE = { cpu_request: null, memory_request: null, cpu_limit: null, memory_limit: null, storage: null };

describe('숫자 카드 「더 만들 수 있는 작업공간」(스펙 2026-10-30-003 §4-7 상태 표)', () => {
  const open = vi.fn();
  it('성공: 숫자와 몰린 노드, 접근 이름은 「… 15개, …, 노드별 보기」(R8)', () => {
    const c = capacityCard(cap(), false, NOW, open);
    expect([c.n, c.sub, c.tone]).toEqual([15, '14개가 oke-worker-5', undefined]);
    expect(c.ariaLabel).toBe('더 만들 수 있는 작업공간 15개, 14개가 oke-worker-5, 노드별 보기');
    c.onClick?.();
    expect(open).toHaveBeenCalled();
  });

  it('불러오는 중·모름·오류는 「—」와 이유', () => {
    expect([capacityCard(undefined, false, NOW, open).n, capacityCard(undefined, false, NOW, open).sub]).toEqual(['—', undefined]);
    expect(capacityCard(cap({ state: 'unknown', slots: null }), false, NOW, open).sub).toBe('아직 모릅니다');
    expect(capacityCard(cap(), true, NOW, open).sub).toBe('읽지 못했습니다');
    expect(capacityCard(cap({ state: 'error' }), false, NOW, open).n).toBe('—');
  });

  it('오래됨·0개·총량 상한은 amber 와 글(5B, 색만으로 전하지 않음)', () => {
    const stale = capacityCard(cap({ state: 'stale', checked_at: '2026-10-30T09:57:00Z' }), false, NOW, open);
    expect([stale.n, stale.tone, stale.sub]).toEqual([15, 'warn', '3분 전 값 · 14개가 oke-worker-5']);
    const zero = capacityCard(cap({ slots: 0, top_node: null, short: { memory: 3 } }), false, NOW, open);
    expect([zero.n, zero.tone, zero.sub]).toEqual([0, 'warn', '메모리 부족(노드 3대)']);
    expect(capacityCard(cap({ slots: 2, quota_limited: true }), false, NOW, open).sub).toBe('네임스페이스 총량 상한 때문');
    expect(capacityCard(cap({ slots: 0, by_node: [], top_node: null, short: {} }), false, NOW, open).sub).toContain('노드가 없습니다');
  });

  it('사용자 만들기 서랍은 available 만 본다(D10)', () => {
    expect(capacityAvailable({ available: false } as CapacityData)).toBe(false);
    expect(capacityAvailable({ available: null } as CapacityData)).toBeNull();
    expect(capacityAvailable(cap({ slots: 0 }))).toBe(false);
    expect(capacityAvailable(cap({ state: 'unknown', slots: null }))).toBeNull();
    expect(capacityAvailable(undefined)).toBeNull();
  });
});

describe('크기 표기(4A)', () => {
  const install = { cpu_request: '500m', memory_request: '1280Mi', cpu_limit: '4', memory_limit: '4Gi', storage: '5Gi' };
  it('표 칸은 정한 칸만, 없으면 「기본」', () => {
    expect(sizeShort(NONE)).toBe('기본');
    expect(sizeShort({ ...NONE, memory_limit: '8Gi' })).toBe('메모리 한도 8GiB');
  });

  it('서랍 KV 는 요청·한도를 나누고 빈 칸은 설치값, PVC 는 실제 크기를 함께', () => {
    expect(sizeKv({ ...NONE, memory_limit: '8Gi' }, install, '5Gi')).toBe('CPU 요청 0.5개 · 한도 4개 / 메모리 요청 1.25GiB · 한도 8GiB / PVC 5GiB(실제 5GiB)');
    expect(sizeKv(NONE, null)).toBe('CPU 요청 — · 한도 — / 메모리 요청 — · 한도 — / PVC —');
  });

  it('주인을 바꿀 때 새 주인의 크기가 다르면 다시 만들어짐을 알린다(D8)', () => {
    const sizes: SizesData = { install, admin: { ...NONE, cpu_request: '1' }, people: { 'lee@x.com': { ...NONE, memory_limit: '8Gi' } }, agents: {} };
    expect(ownerSizeChanges(sizes, 'lee@x.com', { ...NONE, cpu_request: '1', memory_limit: '8Gi' })).toBe(false);
    expect(ownerSizeChanges(sizes, 'lee@x.com', { ...NONE, cpu_request: '1' })).toBe(true);
    expect(ownerSizeChanges(sizes, 'park@x.com', { ...NONE, cpu_request: '1000m' })).toBe(false); // 관리자 기본값 1 = 1000m
    expect(ownerSizeChanges(sizes, 'park', NONE)).toBe(false);
  });
});

describe('크기 입력과 저장(2B·3A·4B·5A)', () => {
  const install = { cpu_request: '500m', memory_request: '1300Mi', cpu_limit: '4', memory_limit: '4Gi', storage: '5Gi' };
  const sizes: SizesData = { install, admin: { ...NONE }, people: { 'kim@x.com': { ...NONE, memory_request: '1300Mi' } }, agents: {} };
  const targets = [{ name: 'hag-1', label: '김 · 마케팅', busy: true }, { name: 'hag-2', label: '김 · 연구' }];
  const blocked = { error: '도는 작업공간 1개가 …', blocked: { reason: '도는 AI 에이전트 작업공간 1개가 이 크기로 다시 뜰 노드 자리가 없습니다', agents: ['hag-1'], nodes: [{ name: 'oke-worker-5', free_cpu: 8, free_memory: 2 ** 30 }] }, warnings: ['이 값이면 노드 oke-worker-1 의 메모리 한도 합이 359% 가 됩니다'] };

  it('칩·칸은 화면 단위로 받고 수량으로 보낸다. 고치지 않은 1300Mi 는 그대로, 확인 창에 다시 만들어질 작업공간과 대화 중 표시', async () => {
    const user = userEvent.setup();
    const fn = stubApi({ '/api/agents/capacity': { state: 'ok', slots: 4 }, '/api/agents/size': { ok: true, warnings: [], targets: ['hag-1', 'hag-2'], rollout: 'hro-1' } });
    mountScreen(<SizeForm scope="kim@x.com" sizes={sizes} targets={targets} owner="김" />, '/agents');
    expect(screen.getByRole('spinbutton', { name: '메모리 요청, GiB' })).toHaveValue(1.27);
    expect(screen.getByRole('spinbutton', { name: 'CPU 요청, 개' })).toHaveAttribute('placeholder', '기본 0.5');
    // 「비우면 …」은 맨 위 한 줄, 줄마다 따라갈 값(2026-10-30 디자인 다시 짬)
    expect(screen.getByText(/빈 칸은 관리자 기본값을, 그것도 없으면 설치값을 따릅니다/)).toBeInTheDocument();
    expect(screen.getByText('기본 0.5 / 4개')).toBeInTheDocument();
    // 막대의 한도 손잡이를 8 눈금(log2 8 = 3)으로 옮기면 메모리 한도 칸이 8 이 된다
    const thumb = screen.getByRole('slider', { name: '메모리 한도' });
    expect(thumb).toHaveAttribute('aria-valuetext', '4GiB');
    fireEvent.change(thumb, { target: { value: 3 } });
    expect(screen.getByRole('spinbutton', { name: '메모리 한도, GiB' })).toHaveValue(8);
    const chip = within(screen.getByRole('group', { name: 'PVC 크기 빠른 값' })).getByRole('button', { name: '10GiB' });
    await user.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    await user.click(chip); // 다시 누르면 비운다
    await user.type(screen.getByRole('spinbutton', { name: 'CPU 요청, 개' }), '0.5');
    expect(await screen.findByText('이 크기로 4개 더')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '크기 저장' }));
    const dlg = await screen.findByRole('dialog', { name: '크기 저장' });
    expect(within(dlg).getByText(/2개가 모두 다시 만들어집니다/)).toBeInTheDocument();
    expect(within(dlg).getByText('대화 중')).toBeInTheDocument();
    await user.click(within(dlg).getByRole('button', { name: '크기 저장' }));
    await waitFor(() => expect(postedTo(fn, '/api/agents/size')).toHaveLength(1));
    expect(postedTo(fn, '/api/agents/size')[0]).toEqual({ email: 'kim@x.com', cpu_request: '500m', cpu_limit: null, memory_request: '1300Mi', memory_limit: '8Gi', storage: null });
  });

  it('요청 > 한도는 그 칸 오류로 막고 첫 오류 칸에 초점을 옮긴다', async () => {
    const user = userEvent.setup();
    const fn = stubApi({ '/api/agents/capacity': { state: 'unknown', slots: null } });
    mountScreen(<SizeForm scope="*" sizes={sizes} />, '/agents');
    await user.type(screen.getByRole('spinbutton', { name: 'CPU 요청, 개' }), '8');
    await user.click(screen.getByRole('button', { name: '크기 저장' }));
    expect(await screen.findByText('요청이 한도보다 큽니다')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('spinbutton', { name: 'CPU 요청, 개' })).toHaveFocus());
    expect(postedTo(fn, '/api/agents/size')).toHaveLength(0);
  });

  it('막히면 저장 버튼 위에 이유·노드별 여유·경고와 「그래도 저장」(Tier 3), 확인하면 force 로 다시 보낸다', async () => {
    const user = userEvent.setup();
    const fn = stubApi({
      '/api/agents/capacity': { state: 'ok', slots: 0 },
      '/api/agents/size': (_u: string, b: Record<string, unknown>) => (b.force ? { ok: true, warnings: [], targets: ['hag-1'] } : new Response(JSON.stringify(blocked), { status: 409 })),
    });
    mountScreen(<SizeForm scope="*" sizes={sizes} />, '/agents');
    await user.type(screen.getByRole('spinbutton', { name: '메모리 요청, GiB' }), '{selectall}2');
    await user.click(screen.getByRole('button', { name: '크기 저장' }));
    expect(await screen.findByText(/다시 뜰 노드 자리가 없습니다/)).toBeInTheDocument();
    expect(screen.getByRole('table', { name: '노드별 여유' })).toHaveTextContent('oke-worker-5');
    expect(screen.getByText(/359%/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '그래도 저장(대기 상태 감수)' }));
    const dlg = await screen.findByRole('dialog', { name: '그래도 저장(대기 상태 감수)' });
    await user.click(within(dlg).getByRole('button', { name: '그래도 저장(대기 상태 감수)' }));
    await waitFor(() => expect(postedTo(fn, '/api/agents/size').map((b) => b.force)).toEqual([undefined, true]));
  });

  it('값은 저장했는데 크기 롤아웃을 못 만들면 창을 닫지 않고 오류와 「다시 적용」', async () => {
    const user = userEvent.setup();
    const fn = stubApi({
      '/api/agents/capacity': { state: 'ok', slots: 3 },
      '/api/agents/size/apply': { ok: true, targets: ['hag-1'] },
      '/api/agents/size': new Response(JSON.stringify({ error: '값은 저장했지만 크기 롤아웃을 만들지 못했습니다: boom', saved: true, targets: ['hag-1'] }), { status: 500 }),
    });
    mountScreen(<SizeForm scope="kim@x.com" sizes={sizes} targets={[targets[0]]} />, '/agents');
    await user.click(screen.getByRole('button', { name: '크기 저장' }));
    await user.click(within(await screen.findByRole('dialog', { name: '크기 저장' })).getByRole('button', { name: '크기 저장' }));
    expect(await screen.findByText(/크기 롤아웃을 만들지 못했습니다/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); // 확인 창이 닫힌 뒤 오류가 서랍 본문에 남는다
    await user.click(screen.getByRole('button', { name: '다시 적용' }));
    await waitFor(() => expect(postedTo(fn, '/api/agents/size/apply')).toEqual([{ names: ['hag-1'] }]));
  });
});

describe('노드별 남은 자리 서랍(2026-10-30 다시 짬)', () => {
  const node = (name: string, slots: number, over: Record<string, unknown> = {}) => ({
    name, slots, free_cpu: 2.42, free_memory: 3.58 * 2 ** 30, total_cpu: 16, total_memory: 31.13 * 2 ** 30,
    cpu_request_pct: 85, memory_request_pct: 89, memory_limit_pct: 238, limited_by: 'memory', ...over,
  });
  const cap = (nodes: unknown[]) => ({ state: 'ok', slots: 1, by_node: nodes, top_node: null, pending: { count: 0, slots: 0 }, quota_limited: false, computed_at: '', checked_at: new Date().toISOString(), pod: { cpu: 1.01, memory: 2.06 * 2 ** 30 }, short: { memory: 1 } });

  it('노드마다 「남음 / 전체」와 요청·한도 합, 맨 위는 모든 노드의 합, 자리 0 은 이유를 글로', async () => {
    stubApi({ '/api/agents/capacity': cap([node('oke-worker-1', 1), node('oke-worker-2', 0, { total_cpu: 32, memory_request_pct: 95 })]) });
    mountScreen(<CapacityPanel />, '/agents');
    const list = await screen.findByRole('list', { name: '노드별 남은 자리' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((x) => within(x).getByRole('heading').textContent)).toEqual(['모든 노드', 'oke-worker-1', 'oke-worker-2']);
    expect(within(items[1]).getByText('2.42 남음 / 전체 16개')).toBeInTheDocument();
    expect(within(items[1]).getByText('3.58 남음 / 전체 31.13GiB')).toBeInTheDocument();
    expect(within(items[0]).getByText('4.84 남음 / 전체 48개')).toBeInTheDocument();
    expect(within(items[2]).getByText('메모리가 모자랍니다')).toBeInTheDocument();
    expect(within(items[2]).getByText('95%')).toBeInTheDocument();
  });

  it('전체를 주지 않는 옛 서버면 남은 양만', async () => {
    stubApi({ '/api/agents/capacity': cap([node('oke-worker-1', 1, { total_cpu: undefined, total_memory: undefined })]) });
    mountScreen(<CapacityPanel />, '/agents');
    expect(await screen.findAllByText('2.42개 남음')).toHaveLength(2);
  });
});
