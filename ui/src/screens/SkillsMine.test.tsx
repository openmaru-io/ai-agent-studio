/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 「스킬 목록」 내 스킬 먼저(스펙 2026-10-27-011 R1~R8, 디자인 리뷰 D4·D6~D8·D14·D18·D19, 재검토 D1)
import { cleanup as cleanupScreen, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountScreen, rowByName, stubApi } from '@/test/mountScreen';

import { isMySkill } from './profiles/skillOrigin';
import { Skills } from './Skills';

const row = (id: string, name: string, profile: string, origin: string | undefined, over: object = {}) => ({
  id,
  name,
  description: '',
  profile,
  origin,
  n_cron: 0,
  n_mcp: 0,
  n_rest: 0,
  n_scripts: 0,
  ...over,
});

// 출처 일곱 가지 + 출처 없음 한 줄: 내 스킬 6(local·agent·market·hub·bundled_modified·없음), 기본 제공 2(bundled·aas)
const ROWS = [
  row('ma:local', 'mine-local', 'ma', 'local', { tags: ['dev-workflow'] }),
  row('ma:agent', 'mine-agent', 'ma', 'agent', { n_mcp: 1 }),
  row('ma:market', 'mine-market', 'ma', 'market'),
  row('ma:hub', 'mine-hub', 'ma', 'hub'),
  row('ma:mod', 'mine-mod', 'ma', 'bundled_modified', { n_rest: 1, urls: ['https://api.example.com/a'] }),
  row('ma:none', 'mine-none', 'ma', undefined),
  row('ma:bundled', 'base-pdf', 'ma', 'bundled', { tags: ['dev-workflow'] }),
  row('ma:aas', 'base-aas', 'ma', 'aas'),
];
const data = (skills = ROWS, over: object = {}) => ({
  totals: { skills: skills.length, with_cron: 0, with_mcp: 1, with_rest: 1 },
  skills,
  by_mcp: { chart: ['ma:agent'] },
  by_host: { 'api.example.com': ['ma:mod'] },
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

const mount = (at = '/skills', body: object = data()) => {
  stubApi({ '/api/market/publish': { items: [], can: false }, '/api/skills': body, '/api/me': { pod: { id: 'pod1' } } });
  mountScreen(<Skills />, at);
};

describe('스킬 목록 — 내 스킬 먼저', () => {
  it('isMySkill: 기본 제공 둘만 아니고 나머지 다섯과 빈 값은 내 스킬', () => {
    expect(['bundled', 'aas'].map(isMySkill)).toEqual([false, false]);
    expect(['local', 'agent', 'market', 'hub', 'bundled_modified', undefined, ''].map((o) => isMySkill(o))).toEqual([true, true, true, true, true, true, true]);
  });

  it('주소 없이 열면 내 스킬 보기이고 카드 수는 거르기 전 6 · 2 · 8', async () => {
    mount();
    expect(await rowByName(/^mine-none/)).toBeInTheDocument();
    expect(screen.queryByText('base-pdf')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /직접 만든 스킬, 6/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /Hermes 기본 제공, 2/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /모두, 8/ })).toBeInTheDocument();
  });

  it('기본 제공 카드를 누르면 bundled·aas 두 줄만', async () => {
    const user = userEvent.setup();
    mount();
    await rowByName(/^mine-local/);
    await user.click(screen.getByRole('tab', { name: /Hermes 기본 제공/ }));
    expect(await rowByName(/^base-pdf/)).toBeInTheDocument();
    expect(await rowByName(/^base-aas/)).toBeInTheDocument();
    expect(screen.queryByText('mine-local')).not.toBeInTheDocument();
  });

  it('기본 제공 카드 둘째 줄은 프로파일이 둘 이상일 때 서로 다른 이름 수와 프로파일 수(D4)', async () => {
    mount('/skills?profile=*', data([...ROWS, row('ra:bundled', 'base-pdf', 'ra', 'bundled')])); // 여러 프로파일은 전체 프로파일에서(2026-10-27-013 D3)
    await rowByName(/^mine-local/);
    expect(screen.getByRole('tab', { name: /Hermes 기본 제공, 3/ })).toHaveAccessibleDescription('서로 다른 2개 · 프로파일 2개');
  });

  it('배지는 지금 보기 안에서 거르고, 외부 URL 배지면 호출 URL 열이 생기며 URL 없는 줄은 「—」(D19)', async () => {
    const user = userEvent.setup();
    mount();
    await rowByName(/^mine-local/);
    await user.click(screen.getByRole('button', { name: /MCP 호출/ }));
    expect(screen.getByTestId('loc')).toHaveTextContent('chip=mcp');
    expect(await rowByName(/^mine-agent/)).toBeInTheDocument();
    expect(screen.queryByText('mine-local')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /외부 URL 호출/ }));
    expect(screen.getByRole('columnheader', { name: /호출 URL/ })).toBeInTheDocument();
    const agent = await rowByName(/^mine-agent/);
    expect([...agent.querySelectorAll('[role="cell"]')][1]).toHaveTextContent('—');
  });

  it('보기를 바꾸면 배지는 풀린다(ListView 동작 그대로)', async () => {
    const user = userEvent.setup();
    mount('/skills?chip=mcp');
    await rowByName(/^mine-agent/);
    await user.click(screen.getByRole('tab', { name: /^모두/ }));
    expect(screen.getByTestId('loc')).not.toHaveTextContent('chip=');
  });

  it('옛 주소 ?tab=mcp 는 전체 보기 + MCP 배지로 바뀐다(R5)', async () => {
    mount('/skills?tab=mcp');
    await rowByName(/^mine-agent/);
    expect(screen.getByTestId('loc')).toHaveTextContent('tab=all');
    expect(screen.getByTestId('loc')).toHaveTextContent('chip=mcp');
  });

  it('내 스킬에서 q 만 있는 주소는 내 스킬 보기 그대로(R5 — 자동 전환 없음)', async () => {
    mount('/skills?q=mine');
    expect(await rowByName(/^mine-local/)).toBeInTheDocument();
    expect(screen.getByTestId('loc')).not.toHaveTextContent('tab=');
    expect(screen.queryByText('base-pdf')).not.toBeInTheDocument();
  });

  it('태그 칩 수는 지금 보기 기준이고 순서는 그대로, 거른 0 줄이면 거르기를 지우라는 문구(D6·D7)', async () => {
    mount('/skills?tag=dev-workflow&lens=mcp%3Achart');
    expect(await screen.findByText(/맞는 항목이 없습니다\. 위의 태그·호출 대상 거르기를 지우세요/)).toBeInTheDocument();
    expect(screen.queryByTestId('skills-mine-empty')).not.toBeInTheDocument();       // 거른 0 은 빈 화면이 아니다
    const chip = within(screen.getByRole('group', { name: '태그로 거르기' })).getByRole('button', { name: /^개발 절차/ });
    expect(chip).toHaveTextContent('1');                                            // 전체로는 2, 내 스킬 보기로는 1
  });

  it('내 스킬이 하나도 없으면 빈 화면에 새 스킬 단추와 기본 제공 링크(D8)', async () => {
    const user = userEvent.setup();
    mount('/skills', data([row('ma:bundled', 'base-pdf', 'ma', 'bundled')]));
    const empty = await screen.findByTestId('skills-mine-empty');
    expect(within(empty).getByText('아직 내 스킬이 없습니다')).toBeInTheDocument();
    expect(within(empty).getByRole('button', { name: '새 스킬' })).toBeInTheDocument();
    await user.click(within(empty).getByRole('button', { name: '기본 제공 1개 보기' }));
    expect(await rowByName(/^base-pdf/)).toBeInTheDocument();
  });

  it('올릴 수 있으면 빈 화면 「새 스킬」 옆에 「zip 올리기」가 있고, 누르면 새 스킬 서랍이 zip 탭으로 열린다', async () => {
    const user = userEvent.setup();
    mount('/skills', data([row('ma:bundled', 'base-pdf', 'ma', 'bundled')], { profiles: ['ma'], can_upload: true }));
    const empty = await screen.findByTestId('skills-mine-empty');
    await user.click(within(empty).getByRole('button', { name: 'zip 올리기' }));
    const drawer = await screen.findByRole('dialog', { name: '새 스킬' });
    expect(within(drawer).getByRole('tab', { name: 'zip 올리기' })).toHaveAttribute('aria-selected', 'true');
  });

  it('올릴 수 없으면 빈 화면에 「zip 올리기」가 없다', async () => {
    mount('/skills', data([row('ma:bundled', 'base-pdf', 'ma', 'bundled')], { profiles: ['ma'] }));
    const empty = await screen.findByTestId('skills-mine-empty');
    expect(within(empty).queryByRole('button', { name: 'zip 올리기' })).not.toBeInTheDocument();
  });

  it('자동 복구 기록이 있으면 회색 띠가 한 번 보이고 닫으면 다시 안 보인다(D14)', async () => {
    const user = userEvent.setup();
    const body = data(ROWS, { bundled_repaired: [{ profile: 'ma', n: 12, at: '2026-10-27T10:00:00+00:00' }, { profile: 'ra', n: 3, at: '2026-10-27T11:00:00+00:00' }] });
    mount('/skills', body);
    const note = await screen.findByTestId('bundled-repair-note');
    expect(note).toHaveAttribute('role', 'status');
    expect(note).toHaveTextContent('내보내기 때 가려진 기본 스킬 15개를 서버 기본 버전으로 되돌렸습니다');
    await user.click(within(note).getByRole('button', { name: '안내 닫기' }));
    expect(screen.queryByTestId('bundled-repair-note')).not.toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem('aas.bundledRepairSeen') || '[]')).toEqual([
      'pod1:ma:2026-10-27T10:00:00+00:00',
      'pod1:ra:2026-10-27T11:00:00+00:00',
    ]);
  });
});

// 「스킬 목록」에서 프로파일을 먼저 고른다(스펙 2026-10-27-013 R1~R7, 엔지니어링 D2·D4~D8, 디자인 1A~13A)
describe('스킬 목록 — 프로파일 먼저', () => {
  const P = [
    row('main:mine', 'm-mine', 'main', 'local', { tags: ['dev-workflow'], n_mcp: 1 }),
    row('main:pdf', 'pdf', 'main', 'bundled'),
    row('p2:mine', 'p2-mine', 'p2', 'local', { n_mcp: 1 }),
    row('p2:pdf', 'pdf', 'p2', 'bundled'),
    row('p2:air', 'airtable', 'p2', 'bundled'),
  ];
  const D = (skills = P, over: object = {}) => ({
    totals: { skills: skills.length, with_cron: 0, with_mcp: 2, with_rest: 0 },
    skills,
    profiles: ['main', 'p2'],
    primary: 'main',
    by_mcp: { chart: ['main:mine', 'p2:mine'], other: ['p2:mine'] },
    by_host: {},
    ...over,
  });
  const ME = { pod: { id: 'pod1' } };
  const open = (at: string, body: object = D(), me: unknown = ME) => {
    stubApi({ '/api/market/publish': { items: [], can: false }, '/api/skills': body, '/api/me': me });
    mountScreen(<Skills />, at);
  };
  const picker = () => screen.findByRole('combobox', { name: '프로파일' }) as Promise<HTMLSelectElement>;

  it('주소 없이 열면 주 프로파일을 골라 주소에 채우고, 수는 그 프로파일 기준이며 부제에 정적 분석이 없다(R3·D8·2A·3A·9A)', async () => {
    open('/skills?tab=all');
    const sel = await picker();
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('profile=main'));
    expect(sel.value).toBe('main');
    expect(within(sel).getAllByRole('option').map((o) => o.textContent)).toEqual(['main · 주 프로파일', 'p2', '모든 AI 에이전트']);
    expect(sel.querySelector('optgroup')?.getAttribute('label')).toBe('프로파일');
    expect(screen.getByRole('tab', { name: /모두, 2/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Hermes 기본 제공, 1/ })).not.toHaveAccessibleDescription(/프로파일/); // 둘째 줄 없음
    expect(screen.queryByText('정적 분석')).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'AI 에이전트' })).not.toBeInTheDocument();       // 위치 값이 하나(12A)
  });

  it('다른 프로파일을 고르면 lens·open 은 지우고 tag·q·chip 은 남기며, 저장하고 한 번 읽어 주고 선택 상자에 포커스를 둔다(D5·6A·11A)', async () => {
    const user = userEvent.setup();
    open('/skills?tab=all&profile=main&tag=dev-workflow&q=m&chip=mcp&lens=mcp%3Achart');
    await user.selectOptions(await picker(), 'p2');
    const loc = screen.getByTestId('loc');
    await waitFor(() => expect(loc).toHaveTextContent('profile=p2'));
    expect(loc).toHaveTextContent('tag=dev-workflow');
    expect(loc).toHaveTextContent('q=m');
    expect(loc).toHaveTextContent('chip=mcp');
    expect(loc).not.toHaveTextContent('lens=');
    expect(window.localStorage.getItem('aas.skillsProfile:pod1')).toBe('p2');
    expect(await screen.findByText('p2: 스킬 3개')).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('combobox', { name: '프로파일' })));
  });

  it('마지막 고른 값으로 열고, 주소의 없는 프로파일은 알림 뒤 다음 값으로, 저장값의 없는 프로파일은 조용히(R3·7A)', async () => {
    window.localStorage.setItem('aas.skillsProfile:pod1', 'p2');
    open('/skills?tab=all');
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('profile=p2'));
    cleanupScreen();
    window.localStorage.setItem('aas.skillsProfile:pod1', 'gone');
    open('/skills?tab=all&profile=deleted');
    expect(await screen.findByText('deleted 프로파일이 없어 main · 주 프로파일 을 보입니다')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('profile=main'));
    cleanupScreen();
    open('/skills?tab=all');                                                       // 저장값 gone 은 없는 프로파일 — 알림 없이 주 프로파일
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('profile=main'));
    expect(screen.queryByText(/프로파일이 없어/)).not.toBeInTheDocument();
  });

  it('localStorage 가 예외를 던져도 주 프로파일로 열리고 고를 수 있다', async () => {
    const user = userEvent.setup();
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    open('/skills?tab=all');
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('profile=main'));
    await user.selectOptions(await picker(), 'p2');
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('profile=p2'));
    get.mockRestore();                                                              // restoreAllMocks 는 공통 matchMedia 대역까지 되돌린다
    set.mockRestore();
  });

  it('me 가 2초 넘게 오지 않으면 저장값 없이 주 프로파일로 그린다(8A)', async () => {
    window.localStorage.setItem('aas.skillsProfile:pod1', 'p2');
    const fn = vi.fn((url: string) =>
      url.startsWith('/api/me')
        ? new Promise<Response>(() => {})
        : Promise.resolve(new Response(JSON.stringify(url.startsWith('/api/skills') ? D() : { items: [], can: false }), { status: 200 }))
    );
    vi.stubGlobal('fetch', fn);
    mountScreen(<Skills />, '/skills?tab=all');
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('profile=main'), { timeout: 4000 });
  });

  it('open 만 있으면 찾은 줄의 프로파일을 고른다 — id 면 그 프로파일, 이름이 여럿이면 주 프로파일(D2)', async () => {
    open('/skills?open=p2%3Amine');
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('profile=p2'));
    expect(await screen.findByRole('dialog', { name: 'p2-mine' })).toBeInTheDocument();
    cleanupScreen();
    open('/skills?open=pdf');
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('profile=main'));
  });

  it('프로파일 P 는 P 와 같은 이름이 없는 공용 줄을 함께 보이고 위치 열이 생긴다. 「공용」은 공용만(D6·13A)', async () => {
    const user = userEvent.setup();
    const skills = [...P, row('default:pdf', 'pdf', 'default', 'bundled'), row('default:share', 'shared-one', 'default', 'local')];
    open('/skills?tab=all&profile=main', D(skills, { profiles: ['default', 'main', 'p2'] }));
    expect(await rowByName(/^shared-one/)).toHaveTextContent('공용');
    expect(screen.getAllByRole('row', { name: /^pdf/ })).toHaveLength(1);         // main 의 pdf 만, 공용 pdf 는 빠진다
    expect(screen.getByRole('columnheader', { name: 'AI 에이전트' })).toBeInTheDocument();
    const sel = await picker();
    expect(within(sel).getAllByRole('option').map((o) => o.textContent)).toEqual(['main · 주 프로파일', 'p2', '공용 스킬', '모든 AI 에이전트']);
    await user.selectOptions(sel, 'default');
    await waitFor(() => expect(screen.getByRole('tab', { name: /모두, 2/ })).toBeInTheDocument());
  });

  it('공용 + 프로파일 하나뿐이면 선택이 없고 지금처럼 전부 보인다(R5)', async () => {
    const skills = [row('main:pdf', 'pdf', 'main', 'bundled'), row('default:x', 'x', 'default', 'local')];
    open('/skills?tab=all', D(skills, { profiles: ['default', 'main'] }));
    expect(await rowByName(/^x/)).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: '프로파일' })).not.toBeInTheDocument();
    expect(screen.getByTestId('loc')).not.toHaveTextContent('profile=');
  });

  it('고른 프로파일에서 0 줄인데 다른 프로파일에 있으면 그 수와 「전체 프로파일에서 보기」(5A)', async () => {
    const user = userEvent.setup();
    open('/skills?tab=all&profile=main&q=airtable');
    expect(await screen.findByText(/main · 주 프로파일 에는 없습니다\. 다른 프로파일에 1개/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '전체 프로파일에서 보기' }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('profile=*'));
    expect(await rowByName(/^airtable/)).toBeInTheDocument();
  });

  it('호출 대상 목록은 고른 프로파일로 다시 세고 0 인 것은 뺀다(OV9)', async () => {
    open('/skills?tab=all&profile=main');
    const lens = await screen.findByRole('combobox', { name: '호출 대상으로 거르기' });
    expect(within(lens).getAllByRole('option').map((o) => o.textContent)).toEqual(['호출 대상: 전체', 'chart (1)']);
  });
});
