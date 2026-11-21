/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 「제한 스킬·템플릿 설치 허용」 보기 카드와 그리로 가는 길(스펙 2026-11-18-015)
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountScreen, postedTo, stubApi } from '@/test/mountScreen';

import { Market } from '../Market';
import { TemplateInstall } from '../profiles/TemplateInstall';

vi.mock('@/lib/ws', async (orig) => ({ ...(await orig<typeof import('@/lib/ws')>()), useTopic: () => false }));

const LABELS = { free: 'shared', paid: '제한' };
const PKG = { id: 'paid/tuner', namespace: 'paid', name: 'tuner', summary: '튜너', version: '2.0', paid: true, restricted: true, allowed: false, update: false, origin: { kind: 'own' }, installed: [] };
const MARKET = { configured: true, namespace_labels: LABELS, admin: true, helper: { alive: true }, packages: [PKG], installed: [], requests: [] };
const POD = (id: string, name: string, grants = {}) => ({ id, name, owner: `${id}@x.io`, owner_name: `${id.toUpperCase()}님`, grants });
const VIEW = (over = {}) => ({
  namespaces: [{ slug: 'paid', label: '제한', packages: 2, items: [{ name: 'tuner', kind: 'skill', summary: '튜너' }, { name: 'my-template', kind: 'template', summary: '마케팅 템플릿' }] }],
  all: {},
  limit: 200,
  pods: [POD('kim', '마케팅', { paid: { by: 'admin@x.io', ts: '2026-11-18T16:55:00+09:00' } }), POD('lee', '시험')],
  ...over,
});
const ME_USER = { auth_enabled: true, admin: false, user: { email: 'kim@x.io' }, pod: { id: 'kim' } };

afterEach(() => vi.unstubAllGlobals());

function mount(view: unknown = VIEW(), extra: Record<string, unknown> = {}, initial = '/market?tab=grants') {
  // 앞부분으로 고르므로 /api/market/grants 를 /api/market/grant 보다 먼저 둔다
  const fn = stubApi({
    '/api/market/grants': view,
    '/api/market/grant': { ok: true },
    '/api/market/package': { kind: 'agent', paid: true, restricted: true, owner: 'o', files: [], version: '2.0', versions: [{ version: '2.0' }], allowed: false },
    '/api/market/templates': {},
    '/api/market/publish': { admin: true, can: true, items: [] },
    '/api/market/archived': { items: [] },
    '/api/market/updates': { rows: [], hub_ok: true, configured: true, pods_failed: [], scope: 'pod', managed_count: 1, admin: true, can: true, auto: false },
    '/api/market': MARKET,
    '/api/chat/status': { agents: [] },
    '/api/requests': { waiting: [] },
    ...extra,
  });
  mountScreen(<Market />, initial);
  return fn;
}
const grantPosts = (fn: ReturnType<typeof stubApi>) => postedTo(fn, '/api/market/grants');

describe('제한 스킬·템플릿 설치 허용', () => {
  it('구역 요약이 표 위에 있고 패키지 수·상태 문장·허용한 사람과 시각을 보인다', async () => {
    mount();
    await screen.findByRole('button', { name: /스킬 1 · 템플릿 1/ });
    const summary = await waitFor(() => {
      const el = document.querySelector('[data-grants-summary]');
      if (!el) throw new Error('요약 없음');
      return el as HTMLElement;
    });
    expect(within(summary).getByText('지금 1곳 허용')).toBeInTheDocument();
    const table = await screen.findByRole('checkbox', { name: "KIM님 · 마케팅 — '제한' 허용" });
    expect(summary.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();   // 요약이 표보다 앞
    expect(table).toBeChecked();
    expect(screen.getByText("'제한' 허용")).toBeInTheDocument();                      // 열 머리는 구역 이름만이 아니라 「'제한' 허용」
    expect(screen.getByRole('tab', { name: /^제한 스킬·템플릿 설치 허용/ })).toBeInTheDocument();
    expect(screen.getByText(/admin@x\.io · 2026-11-18 16:55/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: "LEE님 · 시험 — '제한' 허용" })).not.toBeChecked();
  });

  it('구역 요약의 「스킬 1 · 템플릿 1」을 펼치면 이름 목록이 보이고, 이름을 누르면 그 패키지 서랍이 열린다', async () => {
    const user = userEvent.setup();
    mount();
    const toggle = await screen.findByRole('button', { name: /스킬 1 · 템플릿 1/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const list = await screen.findByRole('list', { name: "'제한' 구역의 스킬·템플릿" });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['스킬tuner튜너', '템플릿my-template마케팅 템플릿']);
    await user.click(within(list).getByRole('button', { name: 'tuner' }));
    expect(await screen.findByRole('dialog', { name: 'tuner' })).toBeInTheDocument();
  });

  it('칸을 누르면 그 작업공간만 보내고, 요청 중에는 다시 눌러도 요청이 하나다', async () => {
    const user = userEvent.setup();
    let release: () => void = () => {};
    const fn = mount(VIEW());
    const base = fn.getMockImplementation()!;
    // 쓰기 응답을 늦춘다 — stubApi 는 값을 바로 돌려주므로 fetch 자체를 붙잡는다
    fn.mockImplementation((url: string, init?: RequestInit) =>
      init?.body ? new Promise<Response>((r) => (release = () => r(new Response(JSON.stringify({ changed: ['lee'], stale: [] }))))) : base(url, init)
    );
    const cell = await screen.findByRole('checkbox', { name: "LEE님 · 시험 — '제한' 허용" });
    await user.click(cell);
    const now = () => screen.getByRole('checkbox', { name: "LEE님 · 시험 — '제한' 허용" });
    await waitFor(() => expect(now()).toBeChecked());                                  // 낙관적 갱신
    expect(now()).toHaveAttribute('aria-disabled', 'true');                             // 요청 중 잠금
    await user.click(now());
    expect(grantPosts(fn)).toEqual([{ namespace: 'paid', pods: ['lee'], allow: true }]);
    release();
    await waitFor(() => expect(fn.mock.calls.filter((c) => String(c[0]) === '/api/market/grants' && !c[1]?.body).length).toBeGreaterThan(1));
  });

  it('칸 요청이 실패하면 원래대로 돌아오고 오류를 보인다', async () => {
    const user = userEvent.setup();
    mount(VIEW(), { '/api/market/grants': (url: string, body: Record<string, unknown>) => (body.pods ? new Response(JSON.stringify({ error: '디스크 오류' }), { status: 500 }) : VIEW()) });
    const cell = await screen.findByRole('checkbox', { name: "LEE님 · 시험 — '제한' 허용" });
    await user.click(cell);
    expect(await screen.findByText('디스크 오류')).toBeInTheDocument();
    await waitFor(() => expect(cell).not.toBeChecked());
  });

  it('전체 허용은 지금 수와 앞으로 생길 곳을 적은 확인 창을 거쳐 "*" 로 보낸다', async () => {
    const user = userEvent.setup();
    const fn = mount(VIEW(), { '/api/market/grants': (url: string, body: Record<string, unknown>) => (body.pods ? { changed: ['*'], stale: [] } : VIEW()) });
    await user.click(await screen.findByRole('checkbox', { name: '전체 허용(새로 생기는 AI 에이전트 작업공간 포함)' }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText(/지금 있는 AI 에이전트 작업공간 2곳과 앞으로 생기는 곳 모두 '제한' 구역/)).toBeInTheDocument();
    await user.click(within(dlg).getByRole('button', { name: '확인' }));
    await waitFor(() => expect(grantPosts(fn)).toEqual([{ namespace: 'paid', pods: '*', allow: true }]));
    expect(await screen.findByText("모든 AI 에이전트 작업공간에 '제한' 을 허용했습니다")).toBeInTheDocument();
  });

  it('전체 허용 중: 칸은 aria-disabled·이유 문구, 눌러도 보내지 않고, 끄는 확인 창에 따로 허용한 이름을 보인다', async () => {
    const user = userEvent.setup();
    const fn = mount(VIEW({ all: { paid: { by: 'admin@x.io', ts: '2026-11-18T17:00:00+09:00' } } }));
    const cell = await screen.findByRole('checkbox', { name: "LEE님 · 시험 — '제한' 허용" });
    expect(cell).toHaveAttribute('aria-disabled', 'true');
    expect(cell).toBeChecked();
    expect(screen.getByText('전체 허용 중 — AI 에이전트 작업공간별 칸은 바꿀 수 없음')).toBeInTheDocument();
    expect(screen.getByText(/따로 허용 · admin@x\.io/)).toBeInTheDocument();
    await user.click(cell);
    expect(grantPosts(fn)).toEqual([]);
    await user.click(screen.getByRole('checkbox', { name: '전체 허용(새로 생기는 AI 에이전트 작업공간 포함)' }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText(/따로 허용한 1곳은 그대로입니다/)).toBeInTheDocument();
    expect(within(dlg).getByText(/KIM님 · 마케팅/)).toBeInTheDocument();
  });

  it('일괄은 개수가 적힌 확인 창을 거치고, 400 unknown_pods 면 목록을 다시 읽었다고 알린다', async () => {
    const user = userEvent.setup();
    const fn = mount(VIEW(), {
      '/api/market/grants': (url: string, body: Record<string, unknown>) =>
        body.pods ? new Response(JSON.stringify({ error: '없는 작업공간', reason: 'unknown_pods', code: 'unknown_pods', pods: ['lee'] }), { status: 400 }) : VIEW(),
    });
    await user.click(await screen.findByRole('checkbox', { name: 'KIM님 · 마케팅 선택' }));
    await user.click(screen.getByRole('checkbox', { name: 'LEE님 · 시험 선택' }));
    await user.click(screen.getByRole('button', { name: '선택한 AI 에이전트 작업공간에 허용' }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText("선택한 2곳에 '제한' 을 허용합니다.")).toBeInTheDocument();
    await user.click(within(dlg).getByRole('button', { name: '확인' }));
    expect(await screen.findByText('목록이 바뀌어 다시 읽었습니다')).toBeInTheDocument();
    expect(grantPosts(fn)).toEqual([{ namespace: 'paid', pods: ['kim', 'lee'], allow: true }]);
  });

  it('구역이 없으면 표 대신 안내, 허브를 못 읽으면 띠와 다시 읽기', async () => {
    mount(VIEW({ namespaces: [], error: { code: 'hub_auth', detail: '거절' } }));
    expect(await screen.findByText(/허용이 필요한 구역이 없습니다\. 스킬 허브에/)).toBeInTheDocument();
    expect(screen.getByText(/스킬 허브를 읽지 못해 일부 구역이 빠졌을 수 있습니다 — 설정의 SkillHub 토큰을 확인하세요/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '다시 읽기' })).toBeInTheDocument();
  });

  it('관리자가 아니면 카드가 없다', async () => {
    mount(VIEW(), { '/api/me': ME_USER, '/api/market': { ...MARKET, admin: false, can_install: true } }, '/market');
    await screen.findByText('tuner');
    expect(screen.queryByRole('tab', { name: /^제한 스킬·템플릿 설치 허용/ })).toBeNull();
  });

  it('서랍: 전체 허용 중이면 자물쇠가 꺼지고 단추 밖에 「제한 스킬·템플릿 설치 허용」 링크가 있다', async () => {
    const user = userEvent.setup();
    mount(VIEW(), { '/api/market/package': { kind: 'skill', paid: true, restricted: true, owner: 'o', files: [], version: '2.0', versions: [{ version: '2.0' }], allowed: true, allowed_by: 'all' } }, '/market');
    await user.click(await screen.findByText('tuner'));
    const dlg = await screen.findByRole('dialog', { name: 'tuner' });
    const link = await within(dlg).findByRole('link', { name: '제한 스킬·템플릿 설치 허용' });
    expect(link).toHaveAttribute('href', '/market?tab=grants');
    expect(within(dlg).getByRole('button', { name: '전체 허용 중' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('서랍: 관리자가 아니면 「관리자에게 허용 요청」으로 구역을 보낸다', async () => {
    const user = userEvent.setup();
    const fn = mount(VIEW(), { '/api/me': ME_USER, '/api/market': { ...MARKET, admin: false, can_install: true }, '/api/requests': (url: string, body: Record<string, unknown>) => (body.kind ? { ok: true, id: 1 } : { waiting: [] }) }, '/market');
    await user.click(await screen.findByText('tuner'));
    const dlg = await screen.findByRole('dialog', { name: 'tuner' });
    await user.click(await within(dlg).findByRole('button', { name: '관리자에게 허용 요청' }));
    await user.click(await screen.findByRole('button', { name: '요청 보내기' }));
    await waitFor(() => expect(postedTo(fn, '/api/requests')).toEqual([{ profile: '_workspace', kind: 'namespace_grant', detail: '', namespace: 'paid' }]));
  });
});

describe('템플릿 카드의 허용 줄', () => {
  const LIST = { items: [{ id: 'paid/tuner', namespace: 'paid', namespace_label: '제한', name: 'tuner', version: '1.0.0', public: false, description: '설명', author: 'a', env_requires: [], mcp: [], skills: 0, hub_skills: [], cron: 0, files: 1, model_hint: '', examples: [], allowed: false }], limit: 10, used: 1, profiles: [] };

  it('관리자: 카드 밖 아래 줄의 「이 작업공간에 허용」이 확인 뒤 허용하고 목록을 다시 읽는다, 「제한 스킬·템플릿 설치 허용」 링크도 있다', async () => {
    const user = userEvent.setup();
    const fn = stubApi({ '/api/market/templates': LIST, '/api/market/grant': { ok: true } });
    mountScreen(<TemplateInstall onDone={() => {}} />, '/profiles');
    const row = await waitFor(() => {
      const el = document.querySelector('[data-not-allowed="paid/tuner"]');
      if (!el) throw new Error('줄 없음');
      return el as HTMLElement;
    });
    expect(await within(row).findByRole('link', { name: "여러 곳은 '제한 스킬·템플릿 설치 허용'에서" })).toHaveAttribute('href', '/market?tab=grants');
    await user.click(within(row).getByRole('button', { name: '이 AI 에이전트 작업공간에 허용' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '이 AI 에이전트 작업공간에 허용' }));
    await waitFor(() => expect(postedTo(fn, '/api/market/grant')).toEqual([{ namespace: 'paid', allow: true }]));
    await waitFor(() => expect(fn.mock.calls.filter((c) => String(c[0]) === '/api/market/templates').length).toBe(2));
  });

  it('관리자가 아니면 안내 문구와 「관리자에게 허용 요청」', async () => {
    stubApi({ '/api/market/templates': LIST, '/api/me': ME_USER, '/api/requests': { waiting: [] } });
    mountScreen(<TemplateInstall onDone={() => {}} />, '/profiles');
    expect(await screen.findByText(/관리자에게 이 AI 에이전트 작업공간에 '제한' 허용을 요청하세요/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '관리자에게 허용 요청' })).toBeInTheDocument();
  });
});
