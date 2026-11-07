/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 세션 칸(screens/chat/SessionList.tsx)의 줄 형식과 폰 에이전트 고르기(스펙 2026-11-06-002 G2·G7·G8)
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatStore, SessionRow } from '@/lib/chatStore';
import { mountScreen, stubApi } from '@/test/mountScreen';

import { rowMeta, SessionList } from './SessionList';

const row = (over: Partial<SessionRow>): SessionRow => ({ id: 'r1', profile: 'ma', title: 't', state: 'idle', unread: 0, at: Date.now(), ...over });
const texts = (r: SessionRow, o: { oneAgent: boolean; done: boolean }) => rowMeta(r, o).map((p) => p.text);

describe('rowMeta — 세션 줄 둘째 줄', () => {
  it('G7: 완료 줄은 채널 · 메시지 n · 마지막 활동이고 상태 라벨(대기)을 넣지 않는다', () => {
    const tg = texts(row({ stored: true, source: 'telegram', count: 6 }), { oneAgent: true, done: true });
    expect(tg.slice(0, 2)).toEqual(['텔레그램', '메시지 6']);
    expect(tg).toHaveLength(3);
    // 이 서버가 연 세션(출처 없음)은 AAS, 메시지 수를 모르면 그 조각을 뺀다
    const local = texts(row({ state: 'idle' }), { oneAgent: true, done: true });
    expect(local[0]).toBe('AAS');
    expect(local).toHaveLength(2);
    expect(local).not.toContain('대기');
  });

  it('프로파일이 없어져 끝난 세션은 완료 줄에도 「끝남」(2026-11-07-001 디자인 3C, G7 의 예외)', () => {
    const p = rowMeta(row({ state: 'ended' }), { oneAgent: false, done: true });
    expect(p.map((x) => x.text)).toContain('끝남');
    expect(rowMeta(row({ state: 'closed' }), { oneAgent: true, done: true }).map((x) => x.key)).not.toContain('state');
  });

  it('G8: 빈 조각은 빼고 잇는다 — 답 필요만 있으면 조각 하나, 앞 구분점이 없다', () => {
    const p = rowMeta(row({ state: 'waiting' }), { oneAgent: true, done: false });
    expect(p).toEqual([{ key: 'state', text: '답 필요', tone: 'warn' }]);
    expect(p.every((x) => !x.text.startsWith('·'))).toBe(true);
    // 저장 세션이 아닌 완료 줄의 마지막 활동이 없으면(0) 그 조각도 뺀다
    expect(texts(row({ at: 0 }), { oneAgent: true, done: true })).toEqual(['AAS']);
  });
});

describe('SessionList — 폰 에이전트 고르기(G2)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('머리의 「모든 AI 에이전트 ▾」로 에이전트를 고르고, 고를 수 있으니 「AI 에이전트를 고르면…」 안내는 숨긴다', async () => {
    stubApi({
      '/api/chat/status': { configured: true, pod: 'p1', agents: [{ name: 'ma', title: '마케팅' }, { name: 'ops', title: '' }] },
      '/api/chat/sessions': { sessions: [] },
      '/api/chat/history': { sessions: [] },
    });
    const store = new ChatStore();
    await store.preload();
    const user = userEvent.setup();
    mountScreen(<SessionList store={store} onPick={() => undefined} onNew={() => undefined} agentPicker />, '/chat');
    const nav = screen.getByRole('navigation', { name: '세션 목록' });
    expect(within(nav).queryByText('AI 에이전트를 고르면 그 AI 에이전트의 지난 1주일 세션이 보입니다.')).toBeNull();
    await user.click(within(nav).getByRole('button', { name: 'AI 에이전트 고르기, 지금 모든 AI 에이전트' }));
    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('모든 AI 에이전트');
    expect(items[1]).toHaveTextContent(/마케팅$/);
    expect(items[2]).toHaveTextContent(/ops$/);
    await user.click(within(menu).getByRole('menuitem', { name: /마케팅/ }));
    expect(store.agentFilter).toEqual({ pod: 'p1', profile: 'ma' });
    expect(await within(nav).findByRole('button', { name: 'AI 에이전트 고르기, 지금 마케팅' })).toBeInTheDocument();
  });
});
