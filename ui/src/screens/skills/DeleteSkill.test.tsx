/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
// 스킬 지우기 화면 판정·확인 창(스펙 2026-10-29-005 DD1~DD10)
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountScreen, postedTo, stubApi } from '@/test/mountScreen';

import { DeletableSkill, DeleteMode, deleteMode, SkillRowDelete, useSkillDelete } from './DeleteSkill';

const why = (m: DeleteMode) => ('disabled' in m ? m.disabled : undefined);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const MINE: DeletableSkill = { id: 'ma:profiles/ma/skills/uploaded/weekly', name: 'weekly', profile: 'ma', origin: 'local', delete_block: '' };
const HUB: DeletableSkill = { id: 'ma:profiles/ma/skills/market/cards', name: 'business-card-ocr', profile: 'ma', origin: 'market', delete_block: 'origin' };
const MARKET = { admin: true, can_install: true, install: { enabled: true }, installed: [{ profile: 'ma', name: 'cards', namespace: 'free', kind: 'skill' }] };

describe('deleteMode — 숨김과 비활성+이유(DD3)', () => {
  const ctx = { admin: false, market: MARKET, pending: false };
  it('기본·허브·외부 폴더·출처 모름은 숨긴다', () => {
    for (const s of [{ ...MINE, origin: 'bundled', delete_block: 'origin' }, { ...MINE, origin: 'aas', delete_block: 'origin' }, { ...MINE, origin: 'hub', delete_block: 'origin' },
                     { ...MINE, shared_from: 'default' }, { ...MINE, origin: undefined }])
      expect(deleteMode(s, ctx).kind).toBe('none');
    expect(deleteMode(HUB, { ...ctx, market: undefined }).kind).toBe('none');            // 스킬 허브 기록을 아직 못 읽었다
  });
  it('내 스킬은 보관, 공용·같은 이름·이름 규칙은 이유와 함께 잠근다', () => {
    expect(deleteMode(MINE, ctx)).toEqual({ kind: 'archive' });
    expect(deleteMode({ ...MINE, profile: 'default' }, ctx)).toEqual({ kind: 'archive', disabled: '공용 스킬은 관리자만 지울 수 있습니다' });
    expect(deleteMode({ ...MINE, profile: 'default' }, { ...ctx, admin: true })).toEqual({ kind: 'archive' });
    expect(why(deleteMode({ ...MINE, delete_block: 'same_name' }, ctx))).toBe('같은 이름의 스킬이 둘 있어 지울 수 없습니다');
    expect(why(deleteMode({ ...MINE, delete_block: 'name' }, ctx))).toBe('이 이름의 스킬은 화면에서 지울 수 없습니다');
  });
  it('스킬 허브 스킬은 설치 기록으로 요청하고, 기록 없음·설치 꺼짐·지우는 중이면 잠근다', () => {
    expect(deleteMode(HUB, ctx)).toEqual({ kind: 'hub', folder: 'cards', namespace: 'free' });
    expect(why(deleteMode(HUB, { ...ctx, market: { ...MARKET, installed: [] } }))).toBe('설치 기록이 없어 스킬 허브에서 지울 수 없습니다');
    expect(why(deleteMode(HUB, { ...ctx, market: { ...MARKET, install: { enabled: false } } }))).toBe('이 설치본에서는 스킬 허브 설치·지우기를 쓰지 않습니다');
    expect(why(deleteMode(HUB, { ...ctx, pending: true }))).toBe('지우기를 요청했습니다');
  });
});

function Harness({ rows, narrow = false }: { rows: DeletableSkill[]; narrow?: boolean }) {
  const del = useSkillDelete(rows);
  return (
    <>
      {rows.map((r) => (
        <div key={r.id}>
          <span>{r.name}</span>
          {del.pendingOf(r) && <span>지우는 중 표시</span>}
          <SkillRowDelete name={r.name} mode={del.modeOf(r)} narrow={narrow} onOpen={() => del.open(r)} />
        </div>
      ))}
      {del.dialog}
    </>
  );
}

const api = (extra: Record<string, unknown> = {}) =>
  stubApi({
    '/api/skill/delete': { ok: true },
    '/api/market/remove': { ok: true },
    '/api/market': MARKET,
    '/api/skills': { skills: [MINE, HUB] },
    '/api/skill?': { path: 'profiles/ma/skills/uploaded/weekly', cron: [{ profile: 'ma', job: '아침 보고' }] },
    ...extra,
  });

describe('지우기 확인 창(DD1·DD4~DD7)', () => {
  it('내 스킬: 순서대로 예약 작업 경고·되살리기 안내·내려받기, 처음 초점은 취소, 지우기는 /api/skill/delete', async () => {
    const user = userEvent.setup();
    const fn = api();
    mountScreen(<Harness rows={[MINE, HUB]} />, '/skills');
    await user.click(await screen.findByRole('button', { name: 'weekly 스킬 지우기' }));
    const dlg = await screen.findByRole('dialog', { name: 'weekly 스킬 지우기' });
    expect(within(dlg).getByText('ma 프로파일에서 지웁니다.')).toBeInTheDocument();
    expect(await within(dlg).findByText(/예약 작업 1개가 다음 실행부터 이 스킬 없이 돕니다: 아침 보고/)).toBeInTheDocument();
    expect(within(dlg).getByText('스킬 허브 › 보관됨에서 되살릴 수 있습니다.')).toBeInTheDocument();
    expect(within(dlg).getByRole('button', { name: /내려받기/ })).toBeInTheDocument();
    await waitFor(() => expect(within(dlg).getByRole('button', { name: '취소' })).toHaveFocus());
    await user.click(within(dlg).getByRole('button', { name: '지우기' }));
    await waitFor(() => expect(postedTo(fn, '/api/skill/delete')).toEqual([{ id: MINE.id }]));
    expect(await screen.findByText('weekly 스킬을 지웠습니다')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '보관됨 보기' })).toBeInTheDocument();          // 되살릴 곳으로 바로(DD6)
  });

  it('실패하면 창을 열어 둔 채 한국어 문장과 접힌 원문을 보인다(DD5)', async () => {
    const user = userEvent.setup();
    api({ '/api/skill/delete': () => new Response(JSON.stringify({ error: '고정된 스킬입니다. 고정을 푼 뒤 지우세요', reason: 'pinned', detail: "'weekly' is pinned" }), { status: 409 }) });
    mountScreen(<Harness rows={[MINE]} />, '/skills');
    await user.click(await screen.findByRole('button', { name: 'weekly 스킬 지우기' }));
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('button', { name: '지우기' }));
    expect(await within(dlg).findByText('고정된 스킬입니다. 고정을 푼 뒤 지우세요')).toBeInTheDocument();
    expect(within(dlg).queryByText("'weekly' is pinned")).toBeNull();
    await user.click(within(dlg).getByRole('button', { name: '자세히' }));
    expect(within(dlg).getByText("'weekly' is pinned")).toBeInTheDocument();
  });

  it('스킬 허브 스킬: 다시 설치 안내, /api/market/remove 로 요청, 그 뒤 「지우는 중」으로 잠긴다(DD2·DD7)', async () => {
    const user = userEvent.setup();
    const fn = api();
    mountScreen(<Harness rows={[MINE, HUB]} />, '/skills');
    await user.click(await screen.findByRole('button', { name: 'business-card-ocr 스킬 지우기' }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText('스킬 허브에서 다시 설치할 수 있습니다.')).toBeInTheDocument();
    expect(within(dlg).queryByRole('button', { name: /내려받기/ })).toBeNull();
    await user.click(within(dlg).getByRole('button', { name: '지우기' }));
    await waitFor(() => expect(postedTo(fn, '/api/market/remove')).toEqual([{ namespace: 'free', name: 'cards', profile: 'ma' }]));
    expect(await screen.findByText('지우는 중 표시')).toBeInTheDocument();
    const locked = screen.getByRole('button', { name: 'business-card-ocr 스킬 지우기' });
    expect(locked).toHaveAttribute('aria-disabled', 'true');
    expect(locked).toHaveAccessibleDescription('지우기를 요청했습니다');
  });
});

describe('패널 줄 단추(DD9)', () => {
  it('지울 수 없는 줄은 단추 없이 자리만, 좁은 화면은 ⋮ 메뉴', async () => {
    const user = userEvent.setup();
    api();
    const builtin: DeletableSkill = { id: 'ma:skills/plan', name: 'plan', profile: 'ma', origin: 'bundled', delete_block: 'origin' };
    mountScreen(<Harness rows={[MINE, builtin]} narrow />, '/skills');
    expect(screen.queryByRole('button', { name: 'plan 스킬 지우기' })).toBeNull();
    // 빈 자리도 단추와 같은 44px 높이라 단추가 있는 줄과 없는 줄의 높이가 같다(OKE T4)
    const slot = document.querySelector('[data-skill-del-slot]');
    expect(slot && getComputedStyle(slot)).toMatchObject({ width: '44px', height: '44px' });
    await user.click(await screen.findByRole('button', { name: 'weekly 스킬 지우기' }));
    await user.click(await screen.findByRole('menuitem', { name: '지우기' }));
    expect(await screen.findByRole('dialog', { name: 'weekly 스킬 지우기' })).toBeInTheDocument();
  });
});
