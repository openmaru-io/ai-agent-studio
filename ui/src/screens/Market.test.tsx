/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { watchChatPopup } from '@/test/chatPopup';
import { mountScreen, postedTo, rowByName, stubApi } from '@/test/mountScreen';
import { listAgents, pickAgent } from '@/test/pickAgent';

import { Market } from './Market';

// 웹소켓 토픽: 구독한 화면의 받는 함수를 잡아 두고 시험이 pushed.send 로 서버 push 를 흉내 낸다(OMAI-1126 T4)
const pushed = vi.hoisted(() => ({ send: null as ((d: unknown) => void) | null }));
vi.mock('@/lib/ws', async (orig) => ({
  ...(await orig<typeof import('@/lib/ws')>()),
  useTopic: (topic: string | null, onData: (d: unknown) => void) => {
    pushed.send = topic ? onData : null;
    return Boolean(topic);
  },
}));

const PKGS = [
  {
    id: 'free/report',
    namespace: 'free',
    name: 'report',
    summary: '리포트 스킬',
    version: '1.2',
    paid: false,
    allowed: true,
    update: false,
    origin: { kind: 'own' },
    installed: [{ profile: 'ma', version: '1.0' }],
  },
  {
    id: 'paid/tuner',
    namespace: 'paid',
    name: 'tuner',
    summary: '튜너 에이전트',
    version: '2.0',
    paid: true,
    restricted: true,
    allowed: false,
    update: true,
    origin: { kind: 'github' },
    installed: [],
  },
];
// 화면에 보이는 네임스페이스 이름은 서버가 준다(slug free·paid 는 그대로, 스펙 skillhub-namespace-shared-restricted §4-3)
const LABELS = { free: 'shared', paid: 'restricted' };
const MARKET = (over = {}) => ({
  configured: true,
  namespace_labels: LABELS,
  admin: true,
  helper: { alive: true },
  packages: PKGS,
  installed: [
    {
      profile: 'ma',
      package: 'free/report',
      name: 'report',
      namespace: 'free',
      kind: 'skill',
      version: '1.0',
      ts: '2026-10-05T10:00:00+09:00',
    },
    {
      profile: 'x',
      package: 'gone/pkg',
      name: 'pkg',
      namespace: 'gone',
      kind: 'skill',
      version: '1',
      ts: '2026-10-05T10:00:00+09:00',
    },
  ],
  requests: [
    {
      status: 'failed',
      mode: 'install',
      profile: 'ma',
      name: 'report',
      package: 'free/report',
      version: '1.0',
      kind: 'skill',
      who: 'kim',
      message: '디스크 부족',
      ts: '2026-10-06T10:00:00+09:00',
    },
  ],
  ...over,
});
const DETAIL = (kind: string, over = {}) => ({
  kind,
  paid: false,
  owner: 'openmaru',
  files: [{ path: 'SKILL.md', size: 10 }],
  scripts: 1,
  body: '설명 본문',
  version: '1.2',
  versions: [{ version: '1.2' }, { version: '1.1' }],
  allowed: true,
  ...over,
});

// 「새 버전 있음」 목록(스펙 2026-10-24-003 §10)
const UROW = (over = {}) => ({
  pod: 'p1', profile: 'ma', package: 'free/report', namespace: 'free', name: 'report', skill: 'report', kind: 'skill',
  current: '1.0', latest: '1.2', basis: 'record', mode: 'update', state: 'update', reason: '', modified: 'same', ...over,
});
const UPD = (rows: unknown[] = [], over = {}) => ({
  rows, hub_ok: true, configured: true, pods_failed: [], checked_at: '2026-10-24T13:00:00+09:00', scope: 'pod', managed_count: 1,
  admin: true, can: true, auto: false, affected: 0, ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
  pushed.send = null;
});

function mount(market = MARKET(), detail: unknown = DETAIL('skill'), initial = '/market', extra: Record<string, unknown> = {}) {
  const fn = stubApi({
    '/api/market/package': detail,
    '/api/market/install': { ok: true },
    '/api/market/remove': { ok: true },
    '/api/market/restore': { ok: true },
    '/api/market/publish/decide': { ok: true },
    '/api/market/publish': { admin: true, can: true, namespaces: ['free', 'paid'], namespace_labels: LABELS, items: [{ id: '20261014100000000000-abcdef', ts: '2026-10-14T10:00:00+09:00', who: 'kim', profile: 'ma', path: 'skills/local/weekly', name: 'weekly-kr', version: '1.0.0', origin: 'local', description: '매주 보고서를 만든다', files: [{ path: 'SKILL.md', size: 120 }], status: 'requested' }] },
    '/api/market/archived': { items: [{ profile: 'ma', skill: 'old-skill', dir: 'old-skill-20261001120000' }] },
    '/api/market/grant': { ok: true },
    '/api/market/tags/refresh': { ok: true, queued: 2 },
    '/api/market/updates/queue': { ok: true, n: 1 },
    '/api/market/updates/skip': { ok: true, n: 1 },
    '/api/market/updates': extra['/api/market/updates'] ?? UPD(),
    '/api/market': market,
    '/api/chat/status': { agents: [{ name: 'default' }, { name: 'ma', title: '마' }, { name: 'ops' }] },
    ...extra,
  });
  mountScreen(<Market />, initial);
  return fn;
}
const bodies = (fn: ReturnType<typeof mount>, path: string) =>
  fn.mock.calls
    .filter((c) => String(c[0]).startsWith(path) && (c[1] as RequestInit | undefined)?.body)
    .map((c) => JSON.parse((c[1] as RequestInit).body as string));

describe('Market', () => {
  it('관리자 검토 없이 게시된 버전: 목록 「관리자 검토 없음」, 설치 칸과 확인 창에 올린 사람(스펙 2026-10-28-001 D6)', async () => {
    const user = userEvent.setup();
    mount(MARKET({ packages: [{ ...PKGS[0], auto_versions: [{ version: '1.2', by: 'kim@x.io' }] }, PKGS[1]] }));
    expect(await screen.findByText('관리자 검토 없음')).toBeInTheDocument();
    await user.click(await rowByName(/^report/));
    const dlg = await screen.findByRole('dialog', { name: 'report' });
    expect(await within(dlg).findByText('올린 사람 kim@x.io · 관리자 검토 없이 게시된 버전입니다')).toBeInTheDocument();
    await user.selectOptions(within(dlg).getByRole('combobox', { name: '버전' }), '1.1');
    expect(within(dlg).queryByText(/관리자 검토 없이 게시된/)).not.toBeInTheDocument();   // 판 단위다
  });

  it('게시 요청의 요청한 사람은 이메일 대신 이름, 이름을 모르면 이메일(스펙 2026-10-28-010 §6-3)', async () => {
    const item = { ts: '2026-10-28T10:00:00+09:00', profile: 'ma', path: 'skills/uploaded/w', version: '1.0.0', origin: 'local', files: [], status: 'requested' };
    mount(MARKET(), DETAIL('skill'), '/market?tab=pub', {
      '/api/me': { auth_enabled: true, admin: true, user: { email: 'admin@x.io' }, pod: { id: 'p1', name: 'p1' }, pods: [] },
      '/api/users': { users: [{ email: 'kim@x.io', name: '김영희' }] },
      '/api/market/publish': {
        admin: true, can: true, namespaces: ['free', 'paid'], namespace_labels: LABELS,
        items: [{ ...item, id: '20261028100000000000-aaaaaa', name: 'known-skill', who: 'kim@x.io' }, { ...item, id: '20261028100000000000-bbbbbb', name: 'other-skill', who: 'nobody@x.io' }],
      },
    });
    expect(await screen.findByText('김영희')).toBeInTheDocument();
    expect(screen.queryByText('kim@x.io')).not.toBeInTheDocument();
    expect(screen.getByText('nobody@x.io')).toBeInTheDocument();
  });

  it('올리기 요청: 자동 승인 표시·사내 주소 경고, 관리자는 자동 승인 스위치를 바꾼다(스펙 2026-10-28-001 Q14)', async () => {
    const user = userEvent.setup();
    const fn = mount(MARKET(), DETAIL('skill'), '/market?tab=pub', {
      '/api/market/publish/auto': { ok: true },
      '/api/market/publish': {
        admin: true, can: true, namespaces: ['free', 'paid'], namespace_labels: LABELS, auto: { auto: true, namespace: 'paid', domains: ['openmaru.io'] },
        items: [{ id: '20261028100000000000-abcdef', ts: '2026-10-28T10:00:00+09:00', who: 'kim', profile: 'ma', path: 'skills/uploaded/weekly', name: 'weekly-kr',
                  version: '1.0.0', origin: 'local', files: [{ path: 'SKILL.md', size: 120 }], status: 'published', namespace: 'paid', auto: true, derived_from: 'free/report@1.0',
                  decided_by: 'auto:kim', internal_refs: ['notes.md:1'] }],
      },
    });
    const sw = await screen.findByRole('checkbox', { name: '주인 스킬 자동 승인' });
    expect(sw).toBeChecked();
    await user.click(sw);
    await waitFor(() => expect(bodies(fn, '/api/market/publish/auto')).toEqual([{ auto: false }]));
    // 선택 목록의 보이는 글은 이름, 보내는 값은 slug
    const pick = screen.getByRole('combobox', { name: '자동 승인 네임스페이스' });
    expect([...pick.querySelectorAll('option')].map((o) => [o.value, o.textContent])).toEqual([['free', 'shared'], ['paid', 'restricted']]);
    await user.selectOptions(pick, 'shared');
    await waitFor(() => expect(bodies(fn, '/api/market/publish/auto')).toEqual([{ auto: false }, { namespace: 'free' }]));
    await user.click(await screen.findByText('weekly-kr@1.0.0'));
    const dlg = await screen.findByRole('dialog', { name: 'weekly-kr' });
    expect(within(dlg).getByText('자동 승인(관리자 검토 없음)')).toBeInTheDocument();
    expect(within(dlg).getByText('shared/report@1.0')).toBeInTheDocument();   // 원본 패키지 ID
    expect(within(dlg).getByText(/notes\.md:1/)).toBeInTheDocument();
  });

  it('카드와 패키지 행의 배지를 보인다', async () => {
    mount();
    expect(await screen.findByText('report')).toBeInTheDocument();
    expect(screen.getByText('사내 1 · 외부 1')).toBeInTheDocument();
    expect(screen.getByText('새 버전 1')).toBeInTheDocument();
    // 무료·유료 대신 출처(사내 등록·외부 가져옴 + 원본 이름)와 설치 방식을 보인다(OMAI-1189)
    expect(screen.getByText('사내 등록')).toBeInTheDocument();
    expect(screen.getByText('외부 가져옴')).toBeInTheDocument();
    expect(screen.getByText('GitHub')).toBeInTheDocument();
    expect(screen.getByText('관리자 허용 필요')).toBeInTheDocument();
    expect(screen.getByText('바로 설치')).toBeInTheDocument();
    expect(screen.queryByText('유료')).not.toBeInTheDocument();
    expect(screen.queryByText('무료')).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: '요금' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: '구분' })).not.toBeInTheDocument();
    expect(screen.getByText('설치됨')).toBeInTheDocument();                             // 설치한 패키지는 이름 옆 표시
    expect(screen.queryByRole('columnheader', { name: '설치된 곳' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /SkillHub/ })).not.toBeInTheDocument(); // SkillHub 는 Ingress 가 없어 화면에서 링크하지 않는다
  });

  it('허용이 필요한 패키지가 없으면 「설치」 열을 숨기고, 출처로 거른다(OMAI-1189)', async () => {
    mount(MARKET({ packages: [PKGS[0], { ...PKGS[1], paid: false, allowed: true }] }));
    expect(await screen.findByText('report')).toBeInTheDocument();
    expect(screen.queryByText('관리자 허용 필요')).not.toBeInTheDocument();
    expect(screen.queryByText('바로 설치')).not.toBeInTheDocument();
    expect(screen.getByText('사내 등록')).toBeInTheDocument();
    expect(screen.getByText('외부 가져옴')).toBeInTheDocument();
  });

  it('늦게 붙는 조건부 보기(올리기 요청·보관됨)가 생겨도 탭 줄이 아니라 보기 카드 줄 하나다(2026-10-17-011 §5-4)', async () => {
    mount(MARKET(), DETAIL('skill'), '/market?tab=arch');
    expect(await screen.findByText('old-skill')).toBeInTheDocument();
    expect(await screen.findByRole('tab', { name: /^보관됨, 1$/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getAllByRole('tablist')).toHaveLength(1);
    expect(document.querySelectorAll('[data-view-card]').length).toBe(screen.getAllByRole('tab').length);
    expect(screen.getByRole('tab', { name: /^요청 기록, \d+$/ })).toHaveAccessibleDescription(/^실패 \d+/);
  });

  it('큐레이터가 보관한 스킬은 「보관됨」 탭에서 되살리기를 요청한다(2026-10-14-015)', async () => {
    const user = userEvent.setup();
    const fn = mount(MARKET(), DETAIL('skill'), '/market?tab=arch');
    await user.click(await screen.findByText('old-skill'));
    const dlg = await screen.findByRole('dialog', { name: 'old-skill' });
    await user.click(within(dlg).getByRole('button', { name: '되살리기' }));
    await user.click(await screen.findByRole('button', { name: '확인' }));
    await waitFor(() => expect(bodies(fn, '/api/market/restore')).toEqual([{ profile: 'ma', name: 'old-skill' }]));
  });

  it('올리기 요청 탭: 관리자가 네임스페이스를 골라 승인하면 decide 를 보낸다(2026-10-14-015)', async () => {
    const user = userEvent.setup();
    const fn = mount(MARKET(), DETAIL('skill'), '/market?tab=pub');
    await user.click(await screen.findByText('weekly-kr@1.0.0'));
    const dlg = await screen.findByRole('dialog', { name: 'weekly-kr' });
    expect(within(dlg).getByText('SKILL.md')).toBeInTheDocument();
    const pick = within(dlg).getByRole('combobox', { name: '네임스페이스' });
    expect([...pick.querySelectorAll('option')].map((o) => [o.value, o.textContent])).toEqual([['free', 'shared'], ['paid', 'restricted']]);
    await user.selectOptions(pick, 'restricted');
    await user.click(within(dlg).getByRole('button', { name: '승인하고 스킬 허브에 게시' }));
    expect(await screen.findByText(/네임스페이스 restricted 에 게시합니다/)).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: '확인' }));
    await waitFor(() => expect(bodies(fn, '/api/market/publish/decide')).toEqual([{ id: '20261014100000000000-abcdef', approve: true, namespace: 'paid', reason: '' }]));
  });

  it('한국어 이름(공용·제한)을 주면 선택 목록·검색이 그 이름을 쓰고, 보내는 값은 slug 다(스펙 2026-10-28-010 §6-3)', async () => {
    const user = userEvent.setup();
    const KO = { free: '공용', paid: '제한' };
    const pub = { admin: true, can: true, namespaces: ['free', 'paid'], namespace_labels: KO,
                  items: [{ id: '20261014100000000000-abcdef', ts: '2026-10-14T10:00:00+09:00', who: 'kim', profile: 'ma', path: 'skills/local/weekly', name: 'weekly-kr',
                            version: '1.0.0', origin: 'local', files: [{ path: 'SKILL.md', size: 120 }], status: 'requested' }] };
    const fn = mount(MARKET({ namespace_labels: KO }), DETAIL('skill'), '/market?tab=pub', { '/api/market/publish': pub });
    await user.click(await screen.findByText('weekly-kr@1.0.0'));
    const dlg = await screen.findByRole('dialog', { name: 'weekly-kr' });
    const pick = within(dlg).getByRole('combobox', { name: '네임스페이스' });
    expect([...pick.querySelectorAll('option')].map((o) => [o.value, o.textContent])).toEqual([['free', '공용'], ['paid', '제한']]);
    await user.selectOptions(pick, '제한');
    await user.click(within(dlg).getByRole('button', { name: '승인하고 스킬 허브에 게시' }));
    expect(await screen.findByText(/네임스페이스 제한 에 게시합니다/)).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: '확인' }));
    await waitFor(() => expect(bodies(fn, '/api/market/publish/decide')).toEqual([{ id: '20261014100000000000-abcdef', approve: true, namespace: 'paid', reason: '' }]));
  });

  it('한국어 이름(공용)으로 찾으면 free 패키지가 걸린다(스펙 2026-10-28-010 §6-3)', async () => {
    const user = userEvent.setup();
    mount(MARKET({ namespace_labels: { free: '공용', paid: '제한' } }));
    expect(await rowByName(/^tuner/)).toBeInTheDocument();
    await user.type(screen.getAllByPlaceholderText('검색')[0], '공용');
    expect(await rowByName(/^report/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('튜너 에이전트')).not.toBeInTheDocument());
  });

  it('설정이 없거나 도우미가 죽었으면 알림을 보인다', async () => {
    mount(MARKET({ configured: false }));
    expect(await screen.findByRole('alert')).toHaveTextContent('AAS_SKILLHUB_URL');
  });

  it('도우미가 응답하지 않으면 설치 요청이 처리되지 않는다는 안내', async () => {
    mount(MARKET({ helper: { alive: false } }));
    expect(await screen.findByRole('alert')).toHaveTextContent('설치 도우미가 응답하지 않습니다');
  });

  it('패키지 서랍은 AI 요약을 기본 정보·설치보다 먼저 보인다', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await rowByName(/^report/));
    const dlg = await screen.findByRole('dialog', { name: 'report' });
    await within(dlg).findByText('기본 정보');
    expect(within(dlg).getByText('shared · v1.2')).toBeInTheDocument();   // 머리 보조 글은 slug 가 아니라 이름
    const order = [...dlg.querySelectorAll('h2, h3, h4, h5, h6, [role="heading"]')].map((h) => h.textContent?.trim()).filter((x) => x === 'AI 요약' || x === '기본 정보' || x === '설치');
    expect(order).toEqual(['AI 요약', '기본 정보', '설치']);
  });

  it('번역된 패키지 요약: 목록은 번역 한 줄, 서랍에 「번역」 캡션과 원문 보기, 검색은 원문 낱말로도(스펙 2026-10-19-017 §9)', async () => {
    const user = userEvent.setup();
    const pkg = { ...PKGS[0], summary: '보고서를 만든다', summary_src: 'Builds weekly reports', summary_by: 'seed' };
    mount(MARKET({ packages: [pkg, PKGS[1]] }));
    expect(await screen.findByText('보고서를 만든다')).toBeInTheDocument();
    expect(screen.queryByText('Builds weekly reports')).toBeNull();
    await user.type(screen.getAllByPlaceholderText('검색')[0], 'weekly');
    expect(await rowByName(/^report/)).toBeInTheDocument();
    await user.click(await rowByName(/^report/));
    const dlg = await screen.findByRole('dialog', { name: 'report' });
    expect(within(dlg).getByText('번역')).toBeInTheDocument();
    await user.click(within(dlg).getByRole('button', { name: '원문 보기' }));
    expect(within(dlg).getByText('Builds weekly reports')).toHaveAttribute('lang', 'en');
    expect(within(dlg).queryByRole('button', { name: '다시 번역' })).toBeNull();
  });

  it('검색어는 네임스페이스 이름(shared·restricted)으로도 찾는다', async () => {
    const user = userEvent.setup();
    mount();
    expect(await rowByName(/^tuner/)).toBeInTheDocument();
    await user.type(screen.getAllByPlaceholderText('검색')[0], 'shared');
    expect(await rowByName(/^report/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('튜너 에이전트')).not.toBeInTheDocument());
  });

  it('「AI 에게 더 묻기」는 default 에이전트의 대화 팝업을 열고 패키지 내용을 질문에 채운다', async () => {
    const user = userEvent.setup();
    mount();
    const popup = watchChatPopup();
    await user.click(await rowByName(/^report/));
    const dlg = await screen.findByRole('dialog', { name: 'report' });
    await user.click(await within(dlg).findByRole('button', { name: 'AI 에게 더 묻기' }));
    const sent = popup() as { kind: string; agent: string; text: string };
    expect(sent).toMatchObject({ kind: 'chat', agent: 'default' });
    expect(sent.text).toContain('report');
    expect(sent.text).toContain('SKILL.md');
    expect(sent.text).toContain('설명 본문');
  });

  it('스킬 설치: 버전과 프로파일(default 제외)을 골라 보내면 요청 기록 탭으로 간다', async () => {
    const user = userEvent.setup();
    const fn = mount();
    await user.click(await rowByName(/^report/));
    const dlg = await screen.findByRole('dialog', { name: 'report' });
    const target = await within(dlg).findByRole('combobox', { name: '설치할 프로파일' });
    expect(await listAgents(user, target)).toEqual(['ma — 설치됨', 'ops']);
    await user.selectOptions(within(dlg).getByRole('combobox', { name: '버전' }), '1.1');
    await pickAgent(user, target, /^ops/);
    await user.click(within(dlg).getByRole('button', { name: '이 프로파일에 설치' }));
    expect(await screen.findByText('report v1.1 을(를) ops 프로파일에 설치합니다.')).toBeInTheDocument(); // 확인을 받는다(OMAI-1135)
    await user.click(screen.getByRole('button', { name: '확인' }));
    await waitFor(() =>
      expect(bodies(fn, '/api/market/install')).toEqual([
        { namespace: 'free', name: 'report', version: '1.1', profile: 'ops', mode: 'install' },
      ])
    );
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('tab=log'));
  });

  it('스킬 설치: 에이전트를 알면 목록을 「에이전트 이름 · 프로파일」로 적고, 보내는 값은 프로파일 이름 그대로다', async () => {
    const user = userEvent.setup();
    const fn = mount(undefined, undefined, '/market', {
      '/api/me': { auth_enabled: false, admin: true, user: null, pod: { id: 'kim', name: '김비서' }, pods: [] },
    });
    await user.click(await rowByName(/^report/));
    const dlg = await screen.findByRole('dialog', { name: 'report' });
    const target = await within(dlg).findByRole('combobox', { name: '설치할 프로파일' });
    expect(await listAgents(user, target)).toEqual(['김비서 · ma — 설치됨', '김비서 · ops']);
    await pickAgent(user, target, / · ops$/);
    await user.click(within(dlg).getByRole('button', { name: '이 프로파일에 설치' }));
    await user.click(await screen.findByRole('button', { name: '확인' }));
    await waitFor(() =>
      expect(bodies(fn, '/api/market/install')).toEqual([
        { namespace: 'free', name: 'report', version: '1.2', profile: 'ops', mode: 'install' },
      ])
    );
  });

  // 「+」로 만든 에이전트에 루트만 있으면 목록이 비고, 빈 선택 칸과 누를 수 있는 단추만 남았다(2026-10-19-001 R6·디자인 D9)
  it('설치할 프로파일이 없으면: main 을 만드는 중이면 그 안내, 아니면 프로파일 만들기 링크를 보이고 설치 단추를 막는다', async () => {
    const user = userEvent.setup();
    mount(MARKET(), DETAIL('skill'), '/market', {
      '/api/chat/status': { agents: [{ name: 'default' }] },
      '/api/me': { auth_enabled: true, admin: true, ws: false, pod: { id: 'kim' }, user: { email: 'kim@x.com' }, primary: { profile: 'main', ready: false } },
    });
    await user.click(await rowByName(/^report/));
    const dlg = await screen.findByRole('dialog', { name: 'report' });
    expect(await within(dlg).findByText(/주 프로파일\(main\)을 만들고 있습니다/)).toBeInTheDocument();
    expect(within(dlg).queryByRole('combobox', { name: '설치할 프로파일' })).toBeNull();
    expect(within(dlg).getByRole('button', { name: '이 프로파일에 설치' })).toBeDisabled();
  });

  it('설치할 프로파일이 없고 main 도 준비 중이 아니면 「프로파일 만들기」 링크', async () => {
    const user = userEvent.setup();
    mount(MARKET(), DETAIL('skill'), '/market', { '/api/chat/status': { agents: [{ name: 'default' }] } });
    await user.click(await rowByName(/^report/));
    const dlg = await screen.findByRole('dialog', { name: 'report' });
    expect(await within(dlg).findByText(/설치할 프로파일이 없습니다/)).toBeInTheDocument();
    expect(within(dlg).getByRole('link', { name: '프로파일 만들기' })).toHaveAttribute('href', '/profiles');
    expect(within(dlg).getByRole('button', { name: '이 프로파일에 설치' })).toBeDisabled();
  });

  it('스킬 설명은 마크다운으로 그린다(제목·코드 블록)', async () => {
    const user = userEvent.setup();
    mount(MARKET(), DETAIL('skill', { body: '# 큰 제목\n\n**굵게** 설명\n\n```bash\nuv run x.py\n```' }));
    await user.click(await rowByName(/^report/));
    const dlg = await screen.findByRole('dialog', { name: 'report' });
    expect(await within(dlg).findByRole('heading', { name: '큰 제목' })).toBeInTheDocument();
    expect(within(dlg).getByText('굵게').tagName).toBe('STRONG');
    expect(within(dlg).queryByText(/^# 큰 제목/)).not.toBeInTheDocument();
  });

  it('출처·라이선스·원본 주소와 묶음 크기를 상세에 보인다(2026-10-14-026 C4)', async () => {
    const user = userEvent.setup();
    mount(
      MARKET(),
      DETAIL('skill', {
        origin: { kind: 'github', url: 'https://github.com/o/r/tree/abc/skills/x', license: 'MIT' },
        bytes: 700 * 1024,
        limit: 512 * 1024,
      })
    );
    await user.click(await rowByName(/^report/));
    const dlg = await screen.findByRole('dialog', { name: 'report' });
    expect(await within(dlg).findByText('외부 가져옴 · GitHub')).toBeInTheDocument();
    expect(within(dlg).queryByText('무료')).not.toBeInTheDocument();
    expect(within(dlg).getByRole('link', { name: 'https://github.com/o/r/tree/abc/skills/x' })).toHaveAttribute('rel', 'noopener noreferrer');
    expect(within(dlg).getByText('MIT')).toBeInTheDocument();
    expect(within(dlg).getByText('700 KiB / 512 KiB')).toBeInTheDocument();
    expect(within(dlg).getByText(/한도 512 KiB 를 넘습니다/)).toBeInTheDocument();           // 넘을 수 있어도 막지는 않는다
    expect(within(dlg).getByRole('button', { name: '이 프로파일에 설치' })).toBeEnabled();
  });

  it('눌러도 한도에 들 수 없는 큰 패키지는 설치 버튼을 막는다(C5)', async () => {
    const user = userEvent.setup();
    mount(MARKET(), DETAIL('skill', { bytes: 11 * 1024 * 1024, limit: 512 * 1024, too_big: true }));
    await user.click(await rowByName(/^report/));
    const dlg = await screen.findByRole('dialog', { name: 'report' });
    expect(await within(dlg).findByRole('alert')).toHaveTextContent('너무 커서');
    expect(within(dlg).getByRole('button', { name: '이 프로파일에 설치' })).toBeDisabled();
  });

  it('에이전트 설치: 「새 프로파일로 설치」와 이름 칸은 없고, 설치된 곳은 올리기 버튼이 있다', async () => {
    const user = userEvent.setup();
    mount(
      MARKET({ packages: [{ ...PKGS[0], installed: [{ profile: 'ma', version: '1.0' }] }] }),
      DETAIL('agent')
    );
    await user.click(await rowByName(/^report/));
    const dlg = await screen.findByRole('dialog', { name: 'report' });
    expect(await within(dlg).findByRole('button', { name: 'ma 프로파일을 이 버전으로 올리기' })).toBeInTheDocument();
    expect(within(dlg).queryByRole('button', { name: '새 프로파일로 설치' })).not.toBeInTheDocument();
    expect(within(dlg).queryByRole('textbox', { name: '새 프로파일 이름' })).not.toBeInTheDocument();
  });

  it('에이전트 올리기는 mode=update 로 그 프로파일에 보낸다', async () => {
    const user = userEvent.setup();
    const fn = mount(MARKET(), DETAIL('agent'));
    await user.click(await rowByName(/^report/));
    const dlg = await screen.findByRole('dialog', { name: 'report' });
    await user.click(await within(dlg).findByRole('button', { name: 'ma 프로파일을 이 버전으로 올리기' }));
    expect(await screen.findByText(/성격·설정이 이 버전의 내용으로 바뀝니다/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '확인' }));
    await waitFor(() => expect(bodies(fn, '/api/market/install')[0]).toMatchObject({ profile: 'ma', mode: 'update' }));
  });

  it('관리자가 아니거나 유료 허용 전이면 설치 버튼이 막히고 이유를 보인다', async () => {
    const user = userEvent.setup();
    mount(MARKET({ admin: false }));
    await user.click(await rowByName(/^report/));
    const dlg = await screen.findByRole('dialog', { name: 'report' });
    expect(await within(dlg).findByText('관리자나 이 AI 에이전트 작업공간의 소유자만 설치할 수 있습니다.')).toBeInTheDocument();
    expect(within(dlg).getByRole('button', { name: '이 프로파일에 설치' })).toBeDisabled();
  });

  it('에이전트 주인은 관리자가 아니어도 설치하지만 유료 허용 단추는 없다(OMAI-1126)', async () => {
    const user = userEvent.setup();
    // 옛 서버(롤링 중): namespace_labels·restricted 가 없으면 slug 를 보이고 paid 로 판단한다
    const old = { ...PKGS[1], restricted: undefined };
    mount(MARKET({ admin: false, can_install: true, namespace_labels: undefined, packages: [PKGS[0], old] }), DETAIL('skill', { paid: true, allowed: false }));
    await user.click(await rowByName(/^tuner/));
    const dlg = await screen.findByRole('dialog', { name: 'tuner' });
    expect(await within(dlg).findByText(/허용이 필요한 네임스페이스 'paid' 를 받을 수 없습니다/)).toBeInTheDocument();
    expect(within(dlg).getByText('paid · v2.0')).toBeInTheDocument();
    expect(within(dlg).queryByRole('button', { name: "'paid' 허용하기" })).not.toBeInTheDocument();
  });

  it('웹소켓으로 받은 값에서도 주인의 설치 단추가 살아 있고, 조회는 POD 를 안 뒤 한 번만 한다(OMAI-1126 T4·T5)', async () => {
    const user = userEvent.setup();
    const owner = { admin: false, can_install: true };
    const fn = stubApi({
      '/api/me': { auth_enabled: true, admin: false, ws: true, pod: { id: 'kim' }, user: { email: 'kim@x.com', name: 'kim' } },
      '/api/market/package': DETAIL('skill'),
      '/api/market': MARKET(owner),
      '/api/chat/status': { agents: [{ name: 'default' }, { name: 'ma', title: '마' }] },
    });
    mountScreen(<Market />, '/market');
    await rowByName(/^report/);
    await waitFor(() => expect(pushed.send).not.toBeNull());
    act(() => pushed.send?.(MARKET({ ...owner, packages: [{ ...PKGS[0], summary: '웹소켓으로 받은 요약' }, PKGS[1]] })));
    expect(await screen.findByText('웹소켓으로 받은 요약')).toBeInTheDocument();     // push 값이 화면이 읽는 키(['market', POD])에 들어갔다
    await user.click(await rowByName(/^report/));
    const dlg = await screen.findByRole('dialog', { name: 'report' });
    expect(await within(dlg).findByRole('button', { name: '이 프로파일에 설치' })).toBeEnabled();
    expect(fn.mock.calls.filter((c) => String(c[0]).split('?')[0] === '/api/market')).toHaveLength(1);
  });

  it('에이전트 패키지의 설치된 곳에서 프로파일 삭제 확인 창을 연다(OMAI-1126 디자인 결정 11A)', async () => {
    const user = userEvent.setup();
    const agentPkgs = [{ ...PKGS[0], installed: [{ profile: 'ma', version: '1.2' }] }];
    stubApi({
      '/api/market/package': DETAIL('agent'),
      '/api/market': MARKET({ admin: false, can_install: true, packages: agentPkgs }),
      '/api/profile?': {
        profile: { name: 'ma', is_default: false, jobs_total: 0 },
        can_edit: false,
        owner: true,
        can_delete: true,
        market_package: 'free/report',
        places: { seats: 0, rooms: 0 },
        secure: true,
        notes: [],
        models: [],
      },
      '/api/chat/status': { agents: [{ name: 'default' }, { name: 'ma', title: '마' }] },
    });
    mountScreen(<Market />, '/market');
    await user.click(await rowByName(/^report/));
    const dlg = await screen.findByRole('dialog', { name: 'report' });
    await user.click(await within(dlg).findByRole('button', { name: '프로파일 삭제…' }));
    const del = await screen.findByRole('dialog', { name: '프로파일 삭제' });
    expect(await within(del).findByText(/묶음 파일은 관리자만 꺼낼 수 있습니다/)).toBeInTheDocument();
    await waitFor(() => expect(within(del).getByRole('textbox', { name: '확인용 이름' })).toHaveFocus());
  });

  it('관리자가 아닌 주인에게 에이전트 패키지 설치 뒤 바꿀 수 없는 것을 알린다(OMAI-1126 디자인 결정 21A)', async () => {
    const user = userEvent.setup();
    mount(MARKET({ admin: false, can_install: true }), DETAIL('agent'));
    await user.click(await rowByName(/^report/));
    const dlg = await screen.findByRole('dialog', { name: 'report' });
    expect(await within(dlg).findByText(/MCP·도구 묶음·예약 작업 음소거는 관리자만 바꿉니다/)).toBeInTheDocument();
  });

  it('에이전트 패키지의 스킬만 기존 프로파일에 설치한다(2026-10-14-002)', async () => {
    const user = userEvent.setup();
    const files = [
      { path: 'agent/SOUL.md', size: 1 },
      { path: 'agent/skills/t/greet/SKILL.md', size: 1 },
      { path: 'agent/skills/t/greet/ex/SKILL.md', size: 1 },
    ];
    const fn = mount(MARKET(), DETAIL('agent', { files }), '/market', {
      '/api/me': { auth_enabled: false, admin: true, user: null, pod: { id: 'kim', name: '김비서' }, pods: [] },
    });
    await user.click(await rowByName(/^report/));
    const dlg = await screen.findByRole('dialog', { name: 'report' });
    const sel = await within(dlg).findByRole('combobox', { name: '기존 프로파일에 스킬만 설치' });
    // 공용(default)은 Hermes 가 거절해 빠지고, 이 패키지로 만든 프로파일(ma)에도 스킬만 넣을 수 있다. 「에이전트 이름 · 프로파일」로 보인다
    expect(await listAgents(user, sel)).toEqual(['김비서 · ma', '김비서 · ops']);
    await pickAgent(user, sel, / · ops$/);
    expect(within(dlg).getByText(/스킬 1개만 넣습니다/)).toBeInTheDocument();
    await user.click(within(dlg).getByRole('button', { name: '이 프로파일에 스킬만 설치' }));
    expect(await screen.findByText(/스킬만 ops 프로파일에 넣습니다/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '확인' }));
    await waitFor(() =>
      expect(bodies(fn, '/api/market/install')).toEqual([
        { namespace: 'free', name: 'report', version: '1.2', profile: 'ops', mode: 'skills' },
      ])
    );
  });

  it('스킬이 없는 에이전트 패키지에는 스킬만 설치 줄이 없고, 스킬만 넣은 곳은 삭제 단추 없이 「스킬만」으로 보인다', async () => {
    const user = userEvent.setup();
    const pkgs = [
      {
        ...PKGS[0],
        installed: [
          { profile: 'ops', version: '1.2', mode: 'skills' },
          { profile: 'ma', version: '1.0', mode: 'install', skills_version: '1.2' },
        ],
      },
    ];
    mount(MARKET({ packages: pkgs }), DETAIL('agent', { files: [{ path: 'agent/SOUL.md', size: 1 }] }));
    await user.click(await rowByName(/^report/));
    const dlg = await screen.findByRole('dialog', { name: 'report' });
    expect(await within(dlg).findByText('스킬만')).toBeInTheDocument();
    expect(within(dlg).queryByRole('button', { name: '이 프로파일에 스킬만 설치' })).not.toBeInTheDocument();
    expect(within(dlg).getAllByRole('button', { name: '프로파일 삭제…' })).toHaveLength(1);          // 스킬만 넣은 ops 에는 없고 패키지 프로파일 ma 에만
    expect(within(dlg).getByText('스킬 v1.2')).toBeInTheDocument();                       // 패키지 프로파일에 스킬만 새로 넣은 판
    expect(within(dlg).getAllByRole('button', { name: /프로파일을 이 버전으로 올리기/ })).toHaveLength(1);   // 올리기는 ma 만
  });

  it('에이전트 주인은 무료 패키지를 설치한다', async () => {
    const user = userEvent.setup();
    mount(MARKET({ admin: false, can_install: true }));
    await user.click(await rowByName(/^report/));
    const dlg = await screen.findByRole('dialog', { name: 'report' });
    expect(await within(dlg).findByRole('button', { name: '이 프로파일에 설치' })).toBeEnabled();
  });

  it('유료 네임스페이스 허용은 서랍 머리 단추이고 확인한 뒤 켠다(OMAI-1135)', async () => {
    const user = userEvent.setup();
    // 새 서버는 restricted 를 준다. 화면은 paid 보다 restricted 를 먼저 읽는다
    const pkg = { ...PKGS[1], paid: false, restricted: true };
    const fn = mount(MARKET({ packages: [PKGS[0], pkg] }), DETAIL('skill', { paid: false, restricted: true, allowed: false }));
    await user.click(await rowByName(/^tuner/));
    const dlg = await screen.findByRole('dialog', { name: 'tuner' });
    expect(await within(dlg).findByText(/허용이 필요한 네임스페이스 'restricted' 를 받을 수 없습니다/)).toBeInTheDocument();
    expect(within(dlg).getByText('허용되지 않음')).toBeInTheDocument(); // 허용 상태는 기본 정보 표에
    const head = dlg.querySelector('[data-drawer-head]') as HTMLElement;
    await user.click(within(head).getByRole('button', { name: "'restricted' 허용하기" }));
    const box = await screen.findByRole('dialog', { name: "'restricted' 허용하기" });
    expect(box).toHaveTextContent("허용이 필요한 네임스페이스 'restricted' 의 패키지를 이 AI 에이전트 작업공간에 설치할 수 있게 허용합니다.");
    await user.click(within(box).getByRole('button', { name: "'restricted' 허용하기" }));
    await waitFor(() => expect(bodies(fn, '/api/market/grant')).toEqual([{ namespace: 'paid', allow: true }]));   // 보내는 값은 slug
  });

  it('설치된 곳 지우기는 확인을 받고 보낸다', async () => {
    const user = userEvent.setup();
    const fn = mount();
    await user.click(await rowByName(/^report/));
    const dlg = await screen.findByRole('dialog', { name: 'report' });
    await user.click(await within(dlg).findByRole('button', { name: '지우기' }));
    expect(await screen.findByText(/skills\/market\/report\/ 폴더가 없어집니다/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '확인' }));
    await waitFor(() =>
      expect(bodies(fn, '/api/market/remove')).toEqual([{ namespace: 'free', name: 'report', profile: 'ma' }])
    );
  });

  it('설치한 것 탭: 새 버전 배지, 허브에서 내려간 패키지는 「허브에서 내려짐」 서랍(스펙 2026-10-29-002 DD9)', async () => {
    const user = userEvent.setup();
    mount(MARKET(), DETAIL('skill'), '/market?tab=inst');
    expect(await screen.findByText('새 버전 v1.2')).toBeInTheDocument();
    await user.click(await rowByName(/^pkg/));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText('허브에서 내려짐 — 설치한 스킬은 그대로')).toBeInTheDocument();
    expect(within(dlg).queryByRole('button', { name: '다시 보이기' })).not.toBeInTheDocument();   // 관리자가 숨긴 기록이 없으면 다시 보이기 없음
  });

  it('요청 기록 탭: 상태 태그와 서랍의 결과', async () => {
    const user = userEvent.setup();
    mount(MARKET(), DETAIL('skill'), '/market?tab=log');
    await user.click(await rowByName(/report → ma/));
    const dlg = await screen.findByRole('dialog', { name: 'report → ma' });
    expect(within(dlg).getByText('디스크 부족')).toBeInTheDocument();
    expect(within(dlg).getByText('실패')).toBeInTheDocument();
    expect(within(dlg).getByText('shared/report@1.0')).toBeInTheDocument();   // 패키지 ID 는 첫 / 앞만 이름으로
  });

  it('고친 스킬 때문에 멈춘 요청: 「내 것 지키기」·「백업 남기고 덮기」를 고르면 같은 요청을 on_modified 를 담아 다시 보낸다(2026-10-14-015)', async () => {
    const user = userEvent.setup();
    const req = {
      status: 'failed',
      mode: 'update',
      profile: 'ma',
      name: 'report',
      package: 'free/report',
      version: '1.2',
      kind: 'skill',
      who: 'kim',
      message: '내가 고쳤거나 직접 만든 스킬이 있습니다: skills/market/report',
      needs: { modified: ['skills/market/report'], occupied: ['skills/mine/x'] },
      ts: '2026-10-14T10:00:00+09:00',
    };
    const fn = mount(MARKET({ requests: [req] }), DETAIL('skill'), '/market?tab=log');
    await user.click(await rowByName(/report → ma/));
    const dlg = await screen.findByRole('dialog', { name: 'report → ma' });
    expect(within(dlg).getByText('skills/market/report')).toBeInTheDocument();
    expect(within(dlg).getByText('skills/mine/x')).toBeInTheDocument();
    await user.click(within(dlg).getByRole('button', { name: '내 것 지키기' }));
    await waitFor(() => expect(bodies(fn, '/api/market/install')).toHaveLength(1));
    expect(bodies(fn, '/api/market/install')[0]).toEqual({ namespace: 'free', name: 'report', version: '1.2', profile: 'ma', mode: 'update', on_modified: 'keep' });
  });

  it('덮기는 확인을 받은 뒤 보낸다. 선택이 필요 없는 실패 요청에는 단추가 없다', async () => {
    const user = userEvent.setup();
    const req = {
      status: 'failed',
      mode: 'update',
      profile: 'ma',
      name: 'report',
      package: 'free/report',
      version: '1.2',
      kind: 'skill',
      who: 'kim',
      message: '고쳤습니다',
      needs: { modified: ['skills/market/report'], occupied: [] },
      ts: '2026-10-14T10:00:00+09:00',
    };
    const fn = mount(MARKET({ requests: [req] }), DETAIL('skill'), '/market?tab=log');
    await user.click(await rowByName(/report → ma/));
    const dlg = await screen.findByRole('dialog', { name: 'report → ma' });
    await user.click(within(dlg).getByRole('button', { name: '백업 남기고 덮기' }));
    await user.click(await screen.findByRole('button', { name: '확인' }));
    await waitFor(() => expect(bodies(fn, '/api/market/install')[0]).toMatchObject({ on_modified: 'overwrite' }));
  });

  it('고친 스킬 허브 스킬이 하나뿐이면 「로컬 사본 남기고 새 버전」이 보이고 copy 로 다시 보낸다', async () => {
    const user = userEvent.setup();
    const req = {
      status: 'failed', mode: 'update', profile: 'ma', name: 'report', package: 'free/report', version: '1.2', kind: 'skill', who: 'kim',
      message: '고쳤습니다', needs: { modified: ['skills/market/report'], occupied: [] }, ts: '2026-10-14T10:00:00+09:00',
    };
    const fn = mount(MARKET({ requests: [req] }), DETAIL('skill'), '/market?tab=log');
    await user.click(await rowByName(/report → ma/));
    const dlg = await screen.findByRole('dialog', { name: 'report → ma' });
    await user.click(within(dlg).getByRole('button', { name: '로컬 사본 남기고 새 버전' }));
    await waitFor(() => expect(bodies(fn, '/api/market/install')[0]).toMatchObject({ on_modified: 'copy' }));
  });

  it('사용자 폴더(occupied)가 섞였거나 고친 것이 여럿이면 사본 단추가 없다', async () => {
    const user = userEvent.setup();
    const req = {
      status: 'failed', mode: 'update', profile: 'ma', name: 'report', package: 'free/report', version: '1.2', kind: 'skill', who: 'kim',
      message: '고쳤습니다', needs: { modified: ['skills/market/report'], occupied: ['skills/mine/x'] }, ts: '2026-10-14T10:00:00+09:00',
    };
    mount(MARKET({ requests: [req] }), DETAIL('skill'), '/market?tab=log');
    await user.click(await rowByName(/report → ma/));
    const dlg = await screen.findByRole('dialog', { name: 'report → ma' });
    expect(within(dlg).queryByRole('button', { name: '로컬 사본 남기고 새 버전' })).toBeNull();
  });

  it('선택이 필요 없는 실패 요청에는 「내 것 지키기」 단추가 없다', async () => {
    const user = userEvent.setup();
    mount(MARKET(), DETAIL('skill'), '/market?tab=log');
    await user.click(await rowByName(/report → ma/));
    const dlg = await screen.findByRole('dialog', { name: 'report → ma' });
    expect(within(dlg).queryByRole('button', { name: '내 것 지키기' })).not.toBeInTheDocument();
  });

  it('처리 중인 요청이 있으면 주기적으로 다시 받는다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const fn = mount(
        MARKET({
          requests: [
            {
              status: 'running',
              mode: 'install',
              profile: 'ma',
              name: 'report',
              version: '1',
              kind: 'skill',
              who: 'k',
              ts: '2026-10-06T10:00:00+09:00',
            },
          ],
        })
      );
      await screen.findByText('report');
      const n = () => fn.mock.calls.filter((c) => c[0] === '/api/market').length;
      const before = n();
      await vi.advanceTimersByTimeAsync(5200);
      await waitFor(() => expect(n()).toBeGreaterThan(before));
    } finally {
      vi.useRealTimers();
    }
  });

  it('설치를 끈 환경이면 이유를 알리고 설치·지우기 버튼을 막는다. 도우미 경고는 내지 않는다', async () => {
    const user = userEvent.setup();
    mount(
      MARKET({
        install: {
          enabled: false,
          reason: '이 환경(compose 시험)에서는 스킬 허브 설치와 지우기를 끕니다. 쿠버네티스에서만 설치할 수 있습니다.',
        },
        helper: { alive: false },
      })
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('쿠버네티스에서만 설치할 수 있습니다');
    expect(alert).not.toHaveTextContent('설치 도우미가 응답하지 않습니다');
    await user.click(await rowByName(/^report/));
    const dlg = await screen.findByRole('dialog', { name: 'report' });
    expect(await within(dlg).findByText(/쿠버네티스에서만 설치할 수 있습니다/)).toBeInTheDocument();
    expect(within(dlg).getByRole('button', { name: '이 프로파일에 설치' })).toBeDisabled();
    expect(within(dlg).getByRole('button', { name: '지우기' })).toBeDisabled();
  });
  it('스킬 허브 주소가 없어도 설치를 끈 환경이면 주소 안내 대신 끈 이유를 알린다(docker compose 빠른 시작)', async () => {
    mount(MARKET({ configured: false, packages: [], install: { enabled: false, reason: '쿠버네티스에서만 설치할 수 있습니다.' } }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('쿠버네티스에서만 설치할 수 있습니다');
    expect(alert).not.toHaveTextContent('AAS_SKILLHUB_URL');
  });
  it('설치한 것 탭에서 연 패키지 서랍은 웹소켓으로 받은 새 값(요약·설치 막힘)을 따라간다', async () => {
    const user = userEvent.setup();
    stubApi({
      '/api/me': { auth_enabled: true, admin: true, ws: true, pod: { id: 'kim' }, user: { email: 'kim@x.com', name: 'kim' } },
      '/api/market/package': DETAIL('skill'),
      '/api/market': MARKET(),
      '/api/chat/status': { agents: [{ name: 'default' }, { name: 'ma', title: '마' }] },
    });
    mountScreen(<Market />, '/market?tab=inst');
    await user.click(await rowByName(/^report/));
    const dlg = await screen.findByRole('dialog', { name: 'report' });
    expect(await within(dlg).findByText('리포트 스킬')).toBeInTheDocument();
    await waitFor(() => expect(pushed.send).not.toBeNull());
    // 패키지 요약이 바뀌고, 같은 때 설치가 막히면(행 밖의 값) 열린 서랍이 둘 다 반영한다
    act(() =>
      pushed.send?.(
        MARKET({ install: { enabled: false, reason: '설치 기능이 꺼졌습니다' }, packages: [{ ...PKGS[0], summary: '바뀐 요약' }, PKGS[1]] })
      )
    );
    expect(await within(screen.getByRole('dialog', { name: 'report' })).findByText('바뀐 요약')).toBeInTheDocument();
    expect(await within(screen.getByRole('dialog', { name: 'report' })).findByText('설치 기능이 꺼졌습니다')).toBeInTheDocument();
  });
});

describe('Market 태그(OMAI-1275)', () => {
  const TAGGED = MARKET({
    packages: [
      { ...PKGS[0], tags: ['docs', 'automation'] },
      { ...PKGS[1], tags: ['code-quality'] },
    ],
  });

  it('표 위에 태그 칩 줄이 개수와 함께 나오고, 표와 서랍에 태그가 보인다', async () => {
    mount(TAGGED, DETAIL('skill', { tags: ['docs', 'automation'] }));
    const bar = await screen.findByRole('group', { name: '태그로 거르기' });
    expect(within(bar).getByRole('button', { name: /코드 품질/ })).toHaveTextContent('1');
    expect(within(bar).getByRole('button', { name: /문서·글쓰기/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '태그' })).toBeInTheDocument();
    expect(within(await rowByName('report')).getByText('문서·글쓰기')).toBeInTheDocument();
  });

  it('칩을 누르면 그 태그를 가진 패키지만 남고, 주소 ?tag= 에 담긴다. 다시 누르면 풀린다', async () => {
    const user = userEvent.setup();
    mount(TAGGED);
    await screen.findByText('report');
    await user.click(within(screen.getByRole('group', { name: '태그로 거르기' })).getByRole('button', { name: /코드 품질/ }));
    await waitFor(() => expect(screen.queryByText('report')).not.toBeInTheDocument());
    expect(screen.getByText('tuner')).toBeInTheDocument();
    await user.click(within(screen.getByRole('group', { name: '태그로 거르기' })).getByRole('button', { name: /코드 품질/ }));
    expect(await screen.findByText('report')).toBeInTheDocument();
  });

  it('여러 태그를 켜면 모두 가진 것만 남는다', async () => {
    const user = userEvent.setup();
    mount(TAGGED);
    await screen.findByText('report');
    const bar = () => within(screen.getByRole('group', { name: '태그로 거르기' }));
    await user.click(bar().getByRole('button', { name: /문서·글쓰기/ }));
    await user.click(bar().getByRole('button', { name: /자동화·도구/ }));
    expect(screen.getByText('report')).toBeInTheDocument();
    expect(screen.queryByText('tuner')).not.toBeInTheDocument();
    await user.click(bar().getByRole('button', { name: /코드 품질/ }));            // report 는 코드 품질이 없다 → 모두 가진 패키지 없음
    expect(screen.queryByText('report')).not.toBeInTheDocument();
  });

  it('주소 ?tag= 로 열면 그 칩이 켜져 있다', async () => {
    mount(TAGGED, DETAIL('skill'), '/market?tag=code-quality');
    await screen.findByText('tuner');
    expect(screen.queryByText('report')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /코드 품질/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('태그가 없으면 칩 줄도 태그 열도 없다', async () => {
    mount();
    await screen.findByText('report');
    expect(screen.queryByRole('group', { name: '태그로 거르기' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: '태그' })).not.toBeInTheDocument();
  });

  it('태그가 하나도 없어도 관리자에게는 「AI 태그 다시 분류」가 보인다(분류가 모두 실패했을 때 다시 시도할 길)', async () => {
    mount();
    await screen.findByText('report');
    expect(screen.queryByRole('group', { name: '태그로 거르기' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'AI 태그 다시 분류' })).toBeInTheDocument();
    cleanup();
    mount(MARKET({ admin: false, can_install: false }));
    await screen.findByText('report');
    expect(screen.queryByRole('button', { name: 'AI 태그 다시 분류' })).not.toBeInTheDocument();
  });

  it('관리자에게만 「AI 태그 다시 분류」가 보이고 누르면 refresh 를 부른다', async () => {
    const user = userEvent.setup();
    const fn = mount(TAGGED);
    await user.click(await screen.findByRole('button', { name: 'AI 태그 다시 분류' }));
    await waitFor(() => expect(fn.mock.calls.some((c) => String(c[0]).startsWith('/api/market/tags/refresh'))).toBe(true));
    cleanup();
    mount(MARKET({ packages: TAGGED.packages, admin: false, can_install: false }));
    await screen.findAllByText('report');
    expect(screen.queryByRole('button', { name: 'AI 태그 다시 분류' })).not.toBeInTheDocument();
  });

  it('새 버전 있음: 고칠 것 없는 줄만 골라 올리고, 고친 줄은 이유와 함께 고를 수 없다(스펙 2026-10-24-003 D7·D9·D16)', async () => {
    const user = userEvent.setup();
    const fn = mount(MARKET(), DETAIL('skill'), '/market?tab=updates', {
      '/api/market/updates': UPD([UROW(), UROW({ profile: 'ops', modified: 'changed' }), UROW({ profile: 'old', state: 'skipped' })]),
    });
    expect(await screen.findByRole('tab', { name: /^새 버전 있음, 2$/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByText('old')).not.toBeInTheDocument();                       // 건너뛴 줄은 숨김
    expect(screen.getByRole('checkbox', { name: 'ops 선택' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'ma 선택' }));
    await user.click(screen.getByRole('button', { name: '선택하여 업그레이드 (1)' }));
    expect(await screen.findByText('스킬 1개를 새 버전으로 업그레이드 합니다.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '확인' }));
    await waitFor(() => expect(bodies(fn, '/api/market/updates/queue')).toEqual([{ items: [{ pod: 'p1', profile: 'ma', package: 'free/report', version: '1.2' }] }]));
    expect(await screen.findByText('업그레이드를 시작했습니다. 이 화면을 닫아도 계속 진행됩니다')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('checkbox', { name: '건너뛴 버전도 보기' }));
    expect(screen.getByText('old')).toBeInTheDocument();
  });

  it('새 버전 있음: 줄이 없으면 마지막 확인 시각, 허브를 못 읽으면 다시 읽기 안내', async () => {
    mount(MARKET(), DETAIL('skill'), '/market?tab=updates', { '/api/market/updates': UPD([], { hub_ok: false }) });
    expect(await screen.findByText('스킬 허브에 연결하지 못해 새 버전을 확인하지 못했습니다')).toBeInTheDocument();
    expect(screen.getByText(/모든 스킬이 최신 버전입니다 · 마지막 확인/)).toBeInTheDocument();
  });
});

// 관리자 직접 게시·허브에서 숨기기(스펙 2026-10-29-002 DD3~DD21)
describe('Market 스킬 허브에 게시', () => {
  afterEach(() => cleanup());
  const PREVIEW = {
    hash: 'h'.repeat(64),
    name: 'report',
    description: '리포트를 만든다',
    files: [{ path: 'SKILL.md', size: 120 }, { path: 'scripts/run.py', size: 30 }],
    scripts: [{ path: 'scripts/run.py', summary: '보고서를 받는다', hosts: [] }],
    hub: { namespace: 'free', version: '1.2.0' },
    next_version: '1.2.1',
    changed: { basis: 'hub', version: '1.2.0', added: ['scripts/run.py'], removed: [], changed: [] },
    refs: { public: [], member: [] },
    installed: 3,
    blockers: [],
    expected_mismatch: '',
    public_namespaces: ['free'],
  };
  const DIRECT = (status: string) => ({ ok: true, request: { id: 'r1', status, version: '1.2.1', namespace: 'free', name: 'report' } });
  const PUB = (items: unknown[]) => ({ admin: true, can: true, namespaces: ['free', 'paid'], namespace_labels: LABELS, items });
  function mountHub(extra: Record<string, unknown> = {}, initial = '/market') {
    // 기존 mount 는 '/api/market' 접두어가 먼저 맞으므로 새 경로는 여기서 먼저 답한다. zip 본문은 JSON 이 아니다
    const routes: Record<string, unknown> = {
      '/api/market/publish/upload': PREVIEW,
      '/api/market/publish/direct': DIRECT('published'),
      '/api/market/publish/retry': { ok: true, how: 'reconciled', request: { status: 'published' } },
      '/api/market/hub/hidden': { items: [] },
      '/api/market/hub/installed': { count: 3, builtin: false },
      '/api/market/hub/show': { ok: true, hidden: false },
      ...extra,
    };
    const base = mount(MARKET(), DETAIL('skill'), initial, extra['/api/market/publish'] ? { '/api/market/publish': extra['/api/market/publish'] } : {});
    const fn = vi.fn((url: string, init?: RequestInit) => {
      const key = Object.keys(routes).find((k) => k !== '/api/market/publish' && url.startsWith(k));
      return key ? Promise.resolve(new Response(JSON.stringify(routes[key]), { status: 200 })) : base(url, init);
    });
    vi.stubGlobal('fetch', fn);
    return fn;
  }

  it('입구에서 zip 을 고르면 판정 줄이 먼저, 스크립트 확인 전에는 게시가 잠기고, 게시는 확인 창 뒤 direct 로 간다', async () => {
    const user = userEvent.setup();
    const fn = mountHub();
    await user.click((await screen.findAllByRole('button', { name: '스킬 허브에 게시' }))[0]);
    const dlg = await screen.findByRole('dialog');
    const input = dlg.querySelector('input[type=file]') as HTMLInputElement;
    await user.upload(input, new File(['x'], 'report.zip', { type: 'application/zip' }));
    expect(await within(dlg).findByText('새 버전 · shared/report v1.2.0 → v1.2.1')).toBeInTheDocument();
    expect(within(dlg).getByText('이 AAS 에서 설치한 프로파일 3개에 새 버전 알림이 갑니다(설치 기록 기준)')).toBeInTheDocument();
    const publish = within(dlg).getByRole('button', { name: '게시' });
    expect(publish).toBeDisabled();
    await user.click(within(dlg).getByLabelText('스크립트를 확인했습니다'));
    expect(publish).toBeEnabled();
    await user.click(publish);
    await user.click(await screen.findByRole('button', { name: /확인|계속/ }));
    await waitFor(() => expect(postedTo(fn, '/api/market/publish/direct')).toEqual([{ hash: 'h'.repeat(64), namespace: 'free', version: '1.2.1', confirm_scripts: true }]));
  });

  it('게시 중 기록은 「게시 실패」가 아니라 「게시 중」, 관리자 직접 게시 실패는 승인 대신 같은 묶음으로 다시 게시', async () => {
    const user = userEvent.setup();
    const rec = { id: '20261029100000000000-abcdef', ts: '2026-10-29T10:00:00+09:00', who: 'admin', profile: '', path: '', name: 'report', version: '1.2.1', origin: 'admin_upload', files: [], namespace: 'free' };
    const fn = mountHub({ '/api/market/publish': PUB([{ ...rec, status: 'publishing' }, { ...rec, id: '20261029090000000000-abcdef', status: 'failed', stale: true }]) }, '/market?tab=pub');
    expect(await screen.findByText('게시 중')).toBeInTheDocument();
    await user.click((await screen.findAllByText('게시 실패'))[0]);
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getAllByText('관리자 직접 게시').length).toBeGreaterThan(0);
    expect(within(dlg).queryByRole('button', { name: '승인하고 스킬 허브에 게시' })).not.toBeInTheDocument();
    await user.click(within(dlg).getByRole('button', { name: '같은 묶음으로 다시 게시' }));
    await waitFor(() => expect(postedTo(fn, '/api/market/publish/retry')).toEqual([{ id: '20261029090000000000-abcdef', confirm_scripts: false }]));
  });

  it('허브에서 숨김 탭: 숨긴 패키지가 있으면 보이고 다시 보이기를 보낸다', async () => {
    const user = userEvent.setup();
    const fn = mountHub({ '/api/market/hub/hidden': { items: [{ namespace: 'free', name: 'old-report', by: 'admin', ts: '2026-10-29T10:00:00+09:00' }] } }, '/market?tab=hub');
    await user.click(await rowByName(/^old-report/));
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('button', { name: '다시 보이기' }));
    await waitFor(() => expect(postedTo(fn, '/api/market/hub/show')).toEqual([{ namespace: 'free', name: 'old-report' }]));
  });
});
