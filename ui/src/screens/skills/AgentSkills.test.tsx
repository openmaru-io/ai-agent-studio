/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 스킬 화면의 에이전트 중심 보기: AI 에이전트 | 그 에이전트의 스킬 | 동작·필요한 것·파일·게시
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountScreen, postedTo, stubApi } from '@/test/mountScreen';

import { Skills } from '../Skills';

const base = { n_mcp: 0, n_rest: 0, n_scripts: 0, n_cron: 0 };
const LIST = {
  totals: { skills: 5, with_cron: 1, with_mcp: 0, with_rest: 1 },
  primary: 'ma',
  profiles: ['default', 'ma', 'ops'],
  agents: [
    {
      profile: 'default',
      skills: 1,
      enabled: 1,
      setup: 0,
      unused: 1,
      shared: 0,
      cron: 0,
      runs: 0,
      last_run: '',
      last_used: '',
    },
    {
      profile: 'ma',
      skills: 4,
      enabled: 3,
      setup: 1,
      unused: 1,
      shared: 2,
      cron: 1,
      runs: 12,
      last_run: '2026-11-05T10:00',
      last_used: '2026-11-05T09:00:00',
    },
    {
      profile: 'ops',
      skills: 0,
      enabled: 0,
      setup: 0,
      unused: 0,
      shared: 0,
      cron: 0,
      runs: 0,
      last_run: '',
      last_used: '',
    },
  ],
  skills: [
    {
      ...base,
      id: 'default:skills/digest',
      name: 'digest',
      profile: 'default',
      origin: 'local',
      enabled: true,
      uses: 0,
      readiness: 'unused',
      modes: ['script'],
    },
    {
      ...base,
      id: 'ma:profiles/ma/skills/weekly',
      name: 'weekly',
      profile: 'ma',
      origin: 'local',
      n_cron: 1,
      enabled: true,
      uses: 7,
      last_used: '2026-11-05T09:00:00',
      readiness: 'ok',
      modes: ['cron', 'script', 'rest'],
    },
    {
      ...base,
      id: 'ma:profiles/ma/skills/gif',
      name: 'gif',
      profile: 'ma',
      origin: 'local',
      enabled: true,
      uses: 0,
      readiness: 'setup',
      missing_env: ['GIF_KEY'],
      modes: ['rest'],
    },
    {
      ...base,
      id: 'ma:profiles/ma/skills/old',
      name: 'old',
      profile: 'ma',
      origin: 'agent',
      enabled: false,
      uses: 0,
      readiness: 'off',
      modes: ['chat'],
    },
    {
      ...base,
      id: 'ma:skills/digest',
      name: 'digest',
      profile: 'ma',
      shared_from: 'default',
      origin: 'local',
      enabled: true,
      uses: 3,
      readiness: 'ok',
      modes: ['script'],
    },
    {
      ...base,
      id: 'ma:skills/unused-shared',
      name: 'unused-shared',
      profile: 'ma',
      shared_from: 'default',
      origin: 'bundled',
      enabled: true,
      uses: 0,
      readiness: 'unused',
      modes: ['chat'],
    },
  ],
  by_mcp: {},
  by_host: {},
};
const ONE = {
  name: 'weekly',
  profile: 'ma',
  path: 'profiles/ma/skills/weekly',
  origin: 'local',
  files: 2,
  modified: '2026-11-01T00:00:00',
  required_env: [{ name: 'REPORT_TOKEN', set: false }],
};
const FLOW = {
  root: 'skill:ma:profiles/ma/skills/weekly',
  nodes: [
    {
      id: 'skill:ma:profiles/ma/skills/weekly',
      kind: 'skill',
      label: 'weekly',
      sub: '',
      badges: [],
      depth: 0,
      meta: {},
    },
    { id: 'cron:ma/abc', kind: 'cron', label: 'weekly-report', sub: '0 9 * * 1', badges: [], depth: -1, meta: {} },
    {
      id: 'script:profiles/ma/skills/weekly/run.py',
      kind: 'script',
      label: 'run.py',
      sub: 'python',
      badges: [],
      depth: 1,
      meta: {},
    },
    {
      id: 'host:api.example.com',
      kind: 'host',
      label: 'api.example.com',
      sub: 'External host',
      badges: [],
      depth: 2,
      meta: {},
    },
    {
      id: 'cred:.env:REPORT_TOKEN',
      kind: 'cred',
      label: 'REPORT_TOKEN',
      sub: '.env',
      badges: ['비어 있음'],
      status: 'bad',
      depth: 3,
      meta: {},
    }, // i18n-ignore: 서버 배지 값
    { id: 'lib:requests', kind: 'lib', label: 'requests', sub: '2.32', badges: [], depth: 3, meta: {} },
  ],
  edges: [
    {
      from: 'cron:ma/abc',
      to: 'skill:ma:profiles/ma/skills/weekly',
      kind: 'runs',
      conf: 'config',
      meta: { observed: 4 },
      evidence: [],
    },
    {
      from: 'skill:ma:profiles/ma/skills/weekly',
      to: 'script:profiles/ma/skills/weekly/run.py',
      kind: 'runs',
      conf: 'doc',
      meta: {},
      evidence: [{ file: 'profiles/ma/skills/weekly/SKILL.md', line: 12, text: 'python run.py' }],
    },
    {
      from: 'script:profiles/ma/skills/weekly/run.py',
      to: 'host:api.example.com',
      kind: 'calls',
      conf: 'code',
      meta: {},
      evidence: [],
    },
  ],
  observed: { days: 14, runs: 4, matched: 1 },
};
const CHECK = {
  ok: true,
  name: 'weekly',
  version: '1.0.0',
  checks: [
    { id: 'origin', level: 'pass', message: 'origin ok' },
    { id: 'env', level: 'warn', message: 'REPORT_TOKEN undeclared' },
  ],
  files: [
    { path: 'SKILL.md', size: 300 },
    { path: 'run.py', size: 2048 },
  ],
  excluded: [],
  env: { declared: [], reads: { REPORT_TOKEN: ['run.py'] }, undeclared: ['REPORT_TOKEN'] },
  header: {
    before: 'name: weekly\ndescription: x',
    after: 'name: weekly\ndescription: x\nversion: 1.0.0\nrequired_environment_variables: [REPORT_TOKEN]',
  },
};

afterEach(() => vi.unstubAllGlobals());

function mount(at = '/skills', over: Record<string, unknown> = {}) {
  const fn = stubApi({
    '/api/skills': LIST,
    '/api/skill?': ONE,
    '/api/flow?': FLOW,
    '/api/file?': {
      name: 'SKILL.md',
      path: 'profiles/ma/skills/weekly/SKILL.md',
      lines: ['---', 'name: weekly', '---'],
      siblings: ['run.py'],
    },
    '/api/market/publish/check': CHECK,
    '/api/market/publish': (url: string, body: Record<string, unknown>) =>
      body.name ? { ok: true, request: { id: 'r1' } } : { items: [], can: true },
    '/api/profile/action': { ok: true },
    '/api/skill/summary': { state: 'none' },
    ...over,
  });
  mountScreen(<Skills />, at);
  return fn;
}

describe('스킬 — AI 에이전트 중심 보기', () => {
  it('왼쪽에 AI 에이전트, 처음에는 주 에이전트의 스킬이 자기 것과 공용으로 나뉘어 보인다', async () => {
    mount();
    const nav = await screen.findByRole('navigation', { name: 'AI 에이전트' });
    expect(within(nav).getByRole('button', { name: /ma/ })).toHaveAttribute('aria-current', 'true');
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('profile=ma'));
    const own = screen.getByRole('region', { name: '이 AI 에이전트의 스킬' });
    expect(within(own).getByText('weekly')).toBeInTheDocument();
    expect(within(own).getByText('설정 필요')).toBeInTheDocument(); // gif: 필요한 환경변수에 값이 없다
    const shared = screen.getByRole('region', { name: '공용에서 가져온 스킬' });
    expect(within(shared).getByText('digest')).toBeInTheDocument(); // 이 에이전트가 쓴 공용 스킬
    expect(within(shared).queryByText('unused-shared')).not.toBeInTheDocument();
    await userEvent.setup().click(within(shared).getByRole('button', { name: '쓰지 않은 공용 스킬 1개 더 보기' }));
    expect(within(shared).getByText('unused-shared')).toBeInTheDocument();
  });

  it('동작 형태와 상태로 거른다', async () => {
    const user = userEvent.setup();
    mount('/skills?profile=ma');
    const own = await screen.findByRole('region', { name: '이 AI 에이전트의 스킬' });
    expect(within(own).getByText('예약 작업')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^설정 필요 1$/ }));
    expect(
      within(screen.getByRole('region', { name: '이 AI 에이전트의 스킬' })).queryByText('weekly')
    ).not.toBeInTheDocument();
    // 스킬을 고르기 전 오른쪽 요약(G15)에도 gif 가 있어 가운데 칸에서 찾는다
    expect(within(screen.getByRole('region', { name: '이 AI 에이전트의 스킬' })).getByText('gif')).toBeInTheDocument();
    expect(screen.getByTestId('loc')).toHaveTextContent('f=setup');
  });

  it('스킬을 고르면 동작 띠(시작 → 코드 → 도구 → 자격증명)와 근거가 보인다', async () => {
    const user = userEvent.setup();
    mount('/skills?profile=ma');
    await user.click(await screen.findByRole('button', { name: /weekly/ }));
    const panel = await screen.findByTestId('skill-panel');
    expect(await within(panel).findByRole('region', { name: '시작' })).toHaveTextContent('weekly-report');
    expect(within(panel).getByRole('region', { name: '코드' })).toHaveTextContent('run.py');
    expect(within(panel).getByRole('region', { name: '부르는 도구' })).toHaveTextContent('api.example.com');
    expect(within(panel).getByRole('region', { name: '자격증명' })).toHaveTextContent('REPORT_TOKEN');
    await user.click(within(panel).getByRole('button', { name: '근거 1줄' }));
    expect(within(panel).getByText('profiles/ma/skills/weekly/SKILL.md:12')).toBeInTheDocument();
    expect(screen.getByTestId('loc')).toHaveTextContent('skill=ma%3Aprofiles%2Fma%2Fskills%2Fweekly');
  });

  it('필요한 것: 이 에이전트 기준으로 비어 있는 값이 먼저, 채우러 가는 링크', async () => {
    const user = userEvent.setup();
    mount('/skills?profile=ma&skill=ma%3Aprofiles%2Fma%2Fskills%2Fweekly&pane=needs');
    const panel = await screen.findByTestId('skill-panel');
    const item = await within(panel).findByText('REPORT_TOKEN');
    const li = item.closest('li') as HTMLElement;
    expect(within(li).getByText('비밀값 탭에서 넣기')).toBeInTheDocument();
    expect(within(panel).getByText('requests')).toBeInTheDocument();
    await user.click(within(panel).getByRole('tab', { name: '파일' }));
    expect(await within(panel).findByText(/name: weekly/)).toBeInTheDocument();
  });

  it('게시: 점검 결과·파일·머리말 미리보기 뒤 빠진 선언과 함께 게시를 요청한다', async () => {
    const user = userEvent.setup();
    const fn = mount('/skills?profile=ma&skill=ma%3Aprofiles%2Fma%2Fskills%2Fweekly&pane=publish');
    const panel = await screen.findByTestId('skill-panel');
    await user.click(await within(panel).findByRole('button', { name: '점검' }));
    const checks = await within(panel).findByTestId('publish-checks');
    expect(within(checks).getByText('REPORT_TOKEN undeclared')).toBeInTheDocument();
    expect(within(panel).getByText(/required_environment_variables: \[REPORT_TOKEN\]/)).toBeInTheDocument();
    expect(postedTo(fn, '/api/market/publish/check')[0]).toMatchObject({ profile: 'ma', path: 'skills/weekly' });
    await user.click(within(panel).getByRole('button', { name: '게시 요청' }));
    await waitFor(() => expect(postedTo(fn, '/api/market/publish').filter((b) => b.declare_env).length).toBe(1));
    expect(postedTo(fn, '/api/market/publish').find((b) => b.declare_env)).toMatchObject({
      name: 'weekly',
      version: '1.0.0',
      declare_env: ['REPORT_TOKEN'],
    });
  });

  it('켜기/끄기는 그 에이전트의 스킬 토글로 보낸다', async () => {
    const user = userEvent.setup();
    const fn = mount('/skills?profile=ma');
    await screen.findByRole('region', { name: '이 AI 에이전트의 스킬' });
    await user.click(screen.getByRole('switch', { name: /old/ }));
    await waitFor(() =>
      expect(postedTo(fn, '/api/profile/action')[0]).toMatchObject({
        name: 'ma',
        action: 'skill',
        target: 'old',
        enabled: true,
      })
    );
  });

  it('「전체 표」는 POD 전체 표로 바꾸고, 표에서 다시 에이전트별 보기로 돌아온다', async () => {
    const user = userEvent.setup();
    mount('/skills?profile=ma');
    await user.click(await screen.findByRole('button', { name: '전체 표' }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('view=table'));
    await user.click(await screen.findByRole('button', { name: 'AI 에이전트별로 보기' }));
    await waitFor(() => expect(screen.getByTestId('agent-skills')).toBeInTheDocument());
  });

  it('옛 주소(lens·tab·open)는 표로 연다', async () => {
    mount('/skills?tab=all');
    await screen.findByRole('button', { name: 'AI 에이전트별로 보기' });
    expect(screen.queryByTestId('agent-skills')).not.toBeInTheDocument();
  });
});

describe('스킬 — 화면 다듬기(스펙 2026-11-06-002 G13~G19)', () => {
  const WEEKLY = '/skills?profile=ma&skill=ma%3Aprofiles%2Fma%2Fskills%2Fweekly';

  it('G14: 단계 표시, 게시 단추는 점검 결과 아래, 바뀌는 머리말을 단추 위에, 경고만 있으면 게시할 수 있고 성공 뒤 요청 상태가 남는다', async () => {
    const user = userEvent.setup();
    mount(WEEKLY + '&pane=publish');
    const panel = await screen.findByTestId('skill-panel');
    const steps = await within(panel).findByRole('list', { name: '게시 단계' });
    expect(within(steps).getByText('1 점검')).toHaveAttribute('aria-current', 'step');
    expect(within(panel).queryByRole('button', { name: '게시 요청' })).toBeNull(); // 점검 전에는 단추가 없다
    await user.click(within(panel).getByRole('button', { name: '점검' }));
    const checks = await within(panel).findByTestId('publish-checks');
    const ask = within(panel).getByRole('button', { name: '게시 요청' });
    expect(checks.compareDocumentPosition(ask) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(panel).getByTestId('publish-files').querySelectorAll('li')).toHaveLength(2); // 파일마다 한 줄
    expect(within(panel).getByTestId('publish-header-change')).toHaveTextContent('REPORT_TOKEN');
    expect(ask).toBeEnabled(); // 경고(warn)만 있다
    expect(within(steps).getByText('2 확인')).toHaveAttribute('aria-current', 'step');
    await user.click(ask);
    expect(await within(panel).findByTestId('publish-sent')).toHaveTextContent('weekly');
    expect(within(panel).getByTestId('publish-checks')).toBeInTheDocument(); // 결과가 사라지지 않는다
    expect(within(steps).getByText('3 요청')).toHaveAttribute('aria-current', 'step');
  });

  it('G14: 실패가 있으면 게시 단추를 막고 「실패 n건 — 고친 뒤 다시 점검」', async () => {
    const user = userEvent.setup();
    mount(WEEKLY + '&pane=publish', {
      '/api/market/publish/check': { ...CHECK, ok: false, checks: [...CHECK.checks, { id: 'name', level: 'fail', message: 'bad name' }] },
    });
    const panel = await screen.findByTestId('skill-panel');
    await user.click(await within(panel).findByRole('button', { name: '점검' }));
    expect(await within(panel).findByTestId('publish-blocked')).toHaveTextContent('실패 1건 — 고친 뒤 다시 점검');
    expect(within(panel).getByRole('button', { name: '게시 요청' })).toBeDisabled();
  });

  it('G13: 상세 탭은 넘치면 가로로 밀리고 게시 탭 이름은 「게시」', async () => {
    mount(WEEKLY);
    const panel = await screen.findByTestId('skill-panel');
    expect(within(panel).getByRole('tab', { name: '게시' })).toBeInTheDocument();
    expect(panel.querySelector('.MuiTabs-scrollableX')).not.toBeNull();
  });

  it('G15: 스킬을 고르지 않으면 오른쪽에 「설정이 필요한 스킬」 요약, 누르면 그 스킬의 필요한 것을 연다', async () => {
    const user = userEvent.setup();
    mount('/skills?profile=ma');
    const box = await screen.findByTestId('agent-overview');
    expect(box).toHaveTextContent('GIF_KEY');
    await user.click(within(box).getByRole('button', { name: /gif/ }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('pane=needs'));
    expect(screen.getByTestId('loc')).toHaveTextContent('skill=ma%3Aprofiles%2Fma%2Fskills%2Fgif');
  });

  it('G16: 채팅과 같은 에이전트 이름, 「주」 대신 「기본」, 표로 가는 길은 머리 「전체 표」 하나', async () => {
    mount('/skills?profile=ma', {
      '/api/chat/status': { configured: true, pod: 'p1', agents: [{ name: 'ma', title: '마케팅 도우미' }, { name: 'ops', title: '' }] },
    });
    const nav = await screen.findByRole('navigation', { name: 'AI 에이전트' });
    const ma = await within(nav).findByRole('button', { name: /마케팅 도우미/ });
    expect(within(ma).getByText('기본')).toBeInTheDocument();
    expect(within(nav).queryByText('주')).toBeNull();
    expect(await screen.findByText('마케팅 도우미의 스킬')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '모든 AI 에이전트의 스킬 표' })).toBeNull();
    expect(screen.getAllByRole('button', { name: '전체 표' })).toHaveLength(1);
  });

  it('G17: 켜고 끄기가 실패하면 스위치를 원래대로 두고 오류를 알린다', async () => {
    const user = userEvent.setup();
    mount('/skills?profile=ma', {
      '/api/profile/action': () => new Response(JSON.stringify({ error: '거절됨' }), { status: 500 }),
    });
    await screen.findByRole('region', { name: '이 AI 에이전트의 스킬' });
    const sw = screen.getByRole('switch', { name: /old/ });
    expect(sw).not.toBeChecked();
    await user.click(sw);
    expect(await screen.findByText(/old 을\(를\) 바꾸지 못해 원래대로 두었습니다/)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /old/ })).not.toBeChecked();
  });

  it('G18: 비었거나 만료된 자격증명 카드와 「설정 필요」 줄에 API 키·토큰 화면 링크', async () => {
    mount(WEEKLY);
    const panel = await screen.findByTestId('skill-panel');
    const card = (await within(panel).findByRole('region', { name: '자격증명' })).querySelector('[data-node="cred:.env:REPORT_TOKEN"]') as HTMLElement;
    expect(within(card).getByRole('link', { name: 'API 키·토큰 화면에서 고치기' })).toHaveAttribute('href', '/credentials?tab=all&profile=ma');
  });

  it('G18: 필요한 것 탭의 값 없는 환경변수 줄에도 같은 링크', async () => {
    mount(WEEKLY + '&pane=needs');
    const panel = await screen.findByTestId('skill-panel');
    const li = (await within(panel).findByText('REPORT_TOKEN')).closest('li') as HTMLElement;
    expect(within(li).getByRole('link', { name: 'API 키·토큰 화면에서 고치기' })).toHaveAttribute('href', '/credentials?tab=all&profile=ma');
  });

  it('G19: 「등록됨」 근거 칩은 중립색(호박색 아님)', async () => {
    mount(WEEKLY, {
      '/api/flow?': {
        ...FLOW,
        nodes: [...FLOW.nodes, { id: 'skill:report', kind: 'skill', label: 'report', sub: '', badges: ['등록됨'], depth: 2, meta: {} }], // i18n-ignore: 서버 배지 값
      },
    });
    const panel = await screen.findByTestId('skill-panel');
    const card = (await within(panel).findByRole('region', { name: '부르는 도구' })).querySelector('[data-node="skill:report"]') as HTMLElement;
    const chip = within(card).getByText('등록됨').closest('.MuiChip-root') as HTMLElement;
    expect(chip).not.toHaveClass('MuiChip-colorWarning');
    expect(chip).toHaveClass('MuiChip-colorDefault');
  });
});
