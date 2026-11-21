/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 스킬 화면의 에이전트 중심 보기: AI 에이전트 | 그 에이전트의 스킬 | 동작·필요한 것·파일·게시
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountScreen, postedTo, stubApi } from '@/test/mountScreen';
import { pickProfile } from '@/test/pickProfile';

import { Skills } from '../Skills';

const base = { n_mcp: 0, n_rest: 0, n_scripts: 0, n_cron: 0, shared_from: '' }; // 서버(skill_graph)는 전용 스킬에 shared_from: '' 를 준다 — 실제 모양 그대로
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
      delete_block: 'in_use',
      dependents_n: 1,
    },
    {
      ...base,
      id: 'ma:profiles/ma/skills/gif',
      name: 'gif',
      dependents_n: 0,
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
// 연결도 탭: weekly 를 부르는 공용 스킬 digest 가 왼쪽(depth -1)에 있다. 다른 뿌리는 그 스킬 하나만 그린다
const FLOW_W = {
  ...FLOW,
  nodes: [
    ...FLOW.nodes,
    { id: 'skill:default:skills/digest', kind: 'skill', label: 'digest', sub: '', badges: [], depth: -1, meta: {} },
  ],
  edges: [
    ...FLOW.edges,
    {
      from: 'skill:default:skills/digest',
      to: 'skill:ma:profiles/ma/skills/weekly',
      kind: 'refers',
      conf: 'doc',
      meta: {},
      evidence: [],
    },
  ],
};
const flowFor = (url: string) => {
  const root = decodeURIComponent(new URL(url, 'http://x').searchParams.get('root') ?? '');
  if (root === FLOW.root) return FLOW_W;
  const label = root.split('/').pop() ?? root;
  return {
    root,
    nodes: [{ id: root, kind: root.split(':')[0], label, sub: '', badges: [], depth: 0, meta: {} }],
    edges: [],
  };
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

const SUM = {
  one_line: '주간 보고서를 만든다',
  use_when: ['금요일 보고'],
  what_it_does: ['일정을 모은다'],
  strengths: [],
  requires: [],
  cautions: [],
};
/** /api/skill/summary 응답. 요약이 켜져 있어야(enabled) AiSummary 가 보인다(스펙 2026-11-06-003 OV-C2) */
const sumView = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  lang: 'ko',
  summary: SUM,
  at: '2026-11-06T10:00:00+0900',
  model: 'cogentai-aas',
  stale: false,
  src: '',
  other: null,
  ...over,
});
/** 머리말 + 빈 줄이 섞인 본문 20줄. 개요의 대신 보기는 머리말을 떼고 빈 줄을 뺀 15줄만 보인다 */
const SKILL_MD = [
  '---',
  'name: weekly',
  'description: 머리말 설명',
  '---',
  '',
  '# 주간 보고',
  ...Array.from({ length: 19 }, (_, i) => (i % 2 ? '' : `본문 ${i + 1}`)).flatMap((x, i) => [x, `줄 ${i + 1}`]),
];

afterEach(() => vi.unstubAllGlobals());

function mount(at = '/skills', over: Record<string, unknown> = {}) {
  const fn = stubApi({
    '/api/skills': LIST,
    '/api/skill?': ONE,
    '/api/flow?': flowFor,
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
    // 기본은 요약이 꺼진 서버(LLM 미설정). 요약을 보는 시험은 sumView 로 바꾼다
    '/api/skill/summary': sumView({ enabled: false, summary: null }),
    '/api/skill/delete': { ok: true },
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
    const own = screen.getByRole('region', { name: '전용 스킬' });
    expect(within(own).getByText('weekly')).toBeInTheDocument();
    expect(within(own).getByText('설정 필요')).toBeInTheDocument(); // gif: 필요한 환경변수에 값이 없다
    const shared = screen.getByRole('region', { name: '가져다 쓰는 공용 스킬' });
    expect(within(shared).getByText('digest')).toBeInTheDocument(); // 이 에이전트가 쓴 공용 스킬
    expect(within(shared).queryByText('unused-shared')).not.toBeInTheDocument();
    await userEvent.setup().click(within(shared).getByRole('button', { name: '쓰지 않은 공용 스킬 1개 더 보기' }));
    expect(within(shared).getByText('unused-shared')).toBeInTheDocument();
  });

  // 스펙 2026-11-18-005: 줄마다 붙던 「안 쓰임」 알약을 상태 점으로. 「설정 필요」만 알약을 두고 점은 읽지 않는다
  it('목록 줄의 상태는 점으로 보이고, 알약은 「설정 필요」에만 붙는다', async () => {
    mount('/skills?profile=ma');
    const own = await screen.findByRole('region', { name: '전용 스킬' });
    const gif = own.querySelector('[data-skill="gif"]') as HTMLElement;
    expect(within(gif).getByText('설정 필요')).toBeInTheDocument();
    expect(gif.querySelector('[data-state="setup"]')).toHaveAttribute('aria-hidden', 'true');
    const shared = screen.getByRole('region', { name: '가져다 쓰는 공용 스킬' });
    await userEvent.setup().click(within(shared).getByRole('button', { name: '쓰지 않은 공용 스킬 1개 더 보기' }));
    const unused = shared.querySelector('[data-skill="unused-shared"]') as HTMLElement;
    expect(within(unused).getByRole('img', { name: '안 쓰임' })).toHaveAttribute('data-state', 'unused');
    expect(within(unused).queryByText('안 쓰임')).toBeNull();
  });

  it('동작 형태와 상태로 거른다', async () => {
    const user = userEvent.setup();
    mount('/skills?profile=ma');
    const own = await screen.findByRole('region', { name: '전용 스킬' });
    expect(within(own).getByText('예약 작업')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^설정 필요 1$/ }));
    expect(within(screen.getByRole('region', { name: '전용 스킬' })).queryByText('weekly')).not.toBeInTheDocument();
    // 스킬을 고르기 전 오른쪽 요약(G15)에도 gif 가 있어 가운데 칸에서 찾는다
    expect(within(screen.getByRole('region', { name: '전용 스킬' })).getByText('gif')).toBeInTheDocument();
    expect(screen.getByTestId('loc')).toHaveTextContent('f=setup');
  });

  // 기본 탭이 「개요」가 되어(스펙 2026-11-06-003 D2) 동작 띠는 「동작」 탭을 눌러 본다. 누르면 주소에 pane=run 이 남는다(OV-M5)
  it('스킬을 고르고 「동작」 탭을 누르면 동작 띠(시작 → 코드 → 도구 → 자격증명)와 근거가 보인다', async () => {
    const user = userEvent.setup();
    mount('/skills?profile=ma');
    await user.click(await screen.findByRole('button', { name: /weekly/ }));
    const panel = await screen.findByTestId('skill-panel');
    await user.click(within(panel).getByRole('tab', { name: '동작' }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('pane=run'));
    expect(await within(panel).findByRole('region', { name: '시작·부르는 곳' })).toHaveTextContent('weekly-report');
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
    // 넣을 수 있는 사람(관리자)이면 링크 대신 「값 넣기」 창 단추. 연결이 암호화됐는지 아직 모르면(secure 없음) 끈 채로 둔다(스펙 2026-11-18-004)
    expect(within(li).getByRole('button', { name: 'REPORT_TOKEN 값 넣기' })).toBeDisabled();
    expect(within(li).queryByText('비밀값 탭에서 넣기')).toBeNull();
    expect(within(panel).getByText('requests')).toBeInTheDocument();
    await user.click(within(panel).getByRole('tab', { name: '파일' }));
    expect(await within(panel).findByText(/name: weekly/)).toBeInTheDocument();
  });

  it('필요한 것: AAS 가 주는 LLM 접속값은 aas 면 「AAS 제공」(info), profile 이면 「프로파일 값」(good), 값 넣기 단추가 없다', async () => {
    const one = {
      ...ONE,
      required_env: [
        { name: 'LLM_BASE_URL', set: true, managed: 'aas', managed_source: 'aas' },
        { name: 'LLM_API_KEY', set: true, managed: 'aas', managed_source: 'profile' },
        { name: 'REPORT_TOKEN', set: false },
      ],
      managed_mixed: true,
    };
    mount('/skills?profile=ma&skill=ma%3Aprofiles%2Fma%2Fskills%2Fweekly&pane=needs', { '/api/skill?': one });
    const panel = await screen.findByTestId('skill-panel');
    const aas = (await within(panel).findByText('LLM_BASE_URL')).closest('li') as HTMLElement;
    const own = within(panel).getByText('LLM_API_KEY').closest('li') as HTMLElement;
    expect(aas).toHaveAttribute('data-state', 'info');
    expect(within(aas).getByText(/AAS 제공/)).toBeInTheDocument();
    expect(aas.querySelector('[data-testid="InfoOutlinedIcon"]')).not.toBeNull();
    expect(aas.querySelector('[data-testid="CheckCircleOutlineIcon"]')).toBeNull(); // 초록 금지
    expect(within(aas).queryByRole('button')).toBeNull();
    expect(own).toHaveAttribute('data-state', 'ok');
    expect(within(own).getByText(/프로파일 값/)).toBeInTheDocument();
    expect(within(panel).getByText(/LLM 접속값의 출처가 다릅니다\(LLM_API_KEY 는 프로파일 값, LLM_BASE_URL 는 AAS 값\)/)).toBeInTheDocument();
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
    await screen.findByRole('region', { name: '전용 스킬' });
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

  // 「전체 표」 단추와 표 도구 줄의 「AI 에이전트별로 보기」를 머리의 두 칸 전환 하나로 바꿨다(스펙 2026-11-06-003 R2·D4)
  it('머리 전환: 「전체 스킬」은 표로, 표의 「AI 에이전트별」은 에이전트 화면으로 돌아오고 표에서 고른 에이전트가 남는다', async () => {
    const user = userEvent.setup();
    mount('/skills?profile=ma&skill=ma%3Aprofiles%2Fma%2Fskills%2Fweekly&pane=needs');
    const group = await screen.findByRole('group', { name: '스킬 보기' });
    const byAgent = within(group).getByRole('button', { name: 'AI 에이전트별' });
    expect(byAgent).toHaveAttribute('aria-pressed', 'true');
    await user.click(byAgent); // 눌린 칸을 다시 눌러도 그대로
    expect(screen.getByTestId('agent-skills')).toBeInTheDocument();
    expect(screen.getByTestId('loc')).toHaveTextContent('pane=needs');
    await user.click(within(group).getByRole('button', { name: '전체 스킬' }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('view=table'));
    expect(screen.getByTestId('loc')).toHaveTextContent('profile=*');
    expect(screen.getByTestId('loc')).not.toHaveTextContent('skill=');
    expect(screen.getByTestId('loc')).not.toHaveTextContent('pane=');
    const tableGroup = await screen.findByRole('group', { name: '스킬 보기' });
    const all = within(tableGroup).getByRole('button', { name: '전체 스킬' });
    expect(all).toHaveAttribute('aria-pressed', 'true');
    await user.click(all);
    expect(screen.getByTestId('loc')).toHaveTextContent('view=table');
    expect(screen.queryByRole('button', { name: 'AI 에이전트별로 보기' })).toBeNull(); // 도구 줄의 옛 단추는 없다
    // 표에서 에이전트를 고른 뒤 돌아오면 그 에이전트가 남는다
    await pickProfile(user, /^ma\b/); // 프로파일 고르기는 MUI 드롭다운(스펙 2026-11-18-007 R7)
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('profile=ma'));
    await user.click(within(screen.getByRole('group', { name: '스킬 보기' })).getByRole('button', { name: 'AI 에이전트별' }));
    await waitFor(() => expect(screen.getByTestId('agent-skills')).toBeInTheDocument());
    expect(screen.getByTestId('loc')).toHaveTextContent('/skills?profile=ma');
  });

  it('왼쪽 칸 맨 위에 「공용 스킬」, 그 아래 AI 에이전트 목록(공용은 섞이지 않는다)', async () => {
    mount('/skills');
    const nav = await screen.findByRole('navigation', { name: 'AI 에이전트' });
    const buttons = within(nav).getAllByRole('button');
    expect(buttons[0]).toHaveAttribute('data-agent', 'default');
    expect(buttons[0]).toHaveTextContent('공용 스킬');
    expect(buttons.slice(1).map((b) => b.getAttribute('data-agent'))).toEqual(['ma', 'ops']);
    expect(within(nav).getByText('설정 필요 1')).toBeInTheDocument(); // ⚠ 숫자 대신 글자로
    expect(screen.queryByRole('button', { name: '전체 표' })).not.toBeInTheDocument();
  });

  it('스킬 머리에 「스킬 연결도 보기」가 늘 보이고, 부르는 곳이 있는 스킬은 지우기가 막힌다', async () => {
    mount('/skills?profile=ma&pane=map&skill=' + encodeURIComponent('ma:profiles/ma/skills/weekly'));
    const panel = await screen.findByTestId('skill-panel');
    const bar = within(panel).getByRole('toolbar', { name: '스킬 동작' });
    // 연결도는 이 화면 안의 탭(기본 탭은 개요, D4) — 메뉴를 옮기지 않는다. 연결도 메뉴는 보조 링크로만
    expect(within(bar).getByRole('button', { name: '스킬 연결도 보기' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(bar).getByRole('link', { name: '연결도 메뉴에서 열기' })).toHaveAttribute(
      'href',
      '/flows?root=' + encodeURIComponent('skill:ma:profiles/ma/skills/weekly')
    );
    expect(within(bar).getByRole('button', { name: '지우기' })).toBeDisabled();
    expect(within(bar).getByText('예약 작업이나 다른 스킬이 부르고 있어 지울 수 없습니다')).toBeInTheDocument();
    // 목록 줄에도 자물쇠와 부르는 곳 수
    expect(within(screen.getByRole('region', { name: '전용 스킬' })).getByText('부르는 곳 1')).toBeInTheDocument();
    // 이 스킬을 부르는 예약 작업은 「부르는 도구」가 아니라 「시작·부르는 곳」 칸
    await userEvent.setup().click(within(panel).getByRole('tab', { name: '동작' }));
    expect(await within(panel).findByRole('region', { name: '시작·부르는 곳' })).toHaveTextContent('weekly-report');
  });

  it('연결도 탭에서 부르는 스킬을 두 번 누르면 이 화면 안에서 그 스킬로 옮겨 가고 연결도 탭에 머문다', async () => {
    const user = userEvent.setup();
    mount('/skills?profile=ma&pane=map&skill=' + encodeURIComponent('ma:profiles/ma/skills/weekly'));
    const map = await screen.findByTestId('skill-map');
    const node = await waitFor(() => {
      const el = map.querySelector('[data-id="skill:default:skills/digest"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    await user.dblClick(node);
    // 공용 스킬 원본이 아니라 지금 AI 에이전트(ma)가 가져다 쓰는 사본으로 — 고른 AI 에이전트가 그대로다
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('skill=ma%3Askills%2Fdigest'));
    expect(screen.getByTestId('loc')).toHaveTextContent('profile=ma');
    expect(screen.getByTestId('loc')).toHaveTextContent('pane=map'); // 기본 탭(개요)으로 돌아가지 않는다(D4)
    const trail = await screen.findByRole('navigation', { name: '지나온 스킬' });
    await user.click(within(trail).getByRole('button', { name: 'weekly' }));
    await waitFor(() =>
      expect(screen.getByTestId('loc')).toHaveTextContent('skill=ma%3Aprofiles%2Fma%2Fskills%2Fweekly')
    );
    expect(
      within(await screen.findByRole('navigation', { name: '지나온 스킬' })).getByRole('button', { name: 'digest' })
    ).toBeInTheDocument();
  });

  // 디자인 F8: 부르는 곳이 없는 스킬의 연결도는 이 스킬 하나뿐이다 — 빈 그림으로 보이지 않게 이유를 적는다
  it('부르는 곳이 없는 스킬의 연결도에는 그 사실을 적고, 부르는 곳이 있으면 적지 않는다', async () => {
    mount('/skills?profile=ma&pane=map&skill=' + encodeURIComponent('ma:profiles/ma/skills/gif'));
    expect(await within(await screen.findByTestId('skill-map')).findByText('이 스킬을 부르는 예약 작업이나 스킬이 없습니다.')).toBeInTheDocument();
    cleanup();
    mount('/skills?profile=ma&pane=map&skill=' + encodeURIComponent('ma:profiles/ma/skills/weekly'));
    expect((await screen.findByTestId('skill-map')).querySelector('[data-map-no-callers]')).toBeNull();
  });

  it('예약 작업 노드는 그림 안에서만 중심을 바꾸고 「원래 스킬로」 돌아온다', async () => {
    const user = userEvent.setup();
    mount('/skills?profile=ma&pane=map&skill=' + encodeURIComponent('ma:profiles/ma/skills/weekly'));
    const map = await screen.findByTestId('skill-map');
    const cron = await waitFor(() => {
      const el = map.querySelector('[data-id="cron:ma/abc"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    await user.dblClick(cron);
    const back = await within(screen.getByTestId('skill-map')).findByRole('button', { name: 'weekly(으)로 돌아가기' });
    expect(screen.getByTestId('loc')).toHaveTextContent('skill=ma%3Aprofiles%2Fma%2Fskills%2Fweekly');
    await user.click(back);
    expect(
      within(screen.getByTestId('skill-map')).queryByRole('button', { name: 'weekly(으)로 돌아가기' })
    ).not.toBeInTheDocument();
  });

  it('동작 탭의 스킬 카드 이름을 누르면 그 스킬로 옮겨 가고, 넓게 보기는 AI 에이전트 칸을 접는다', async () => {
    const user = userEvent.setup();
    mount('/skills?profile=ma&pane=run&skill=' + encodeURIComponent('ma:profiles/ma/skills/weekly'));
    const panel = await screen.findByTestId('skill-panel');
    await user.click(await within(panel).findByRole('button', { name: 'digest' }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('skill=ma%3Askills%2Fdigest'));
    expect(screen.getByRole('navigation', { name: 'AI 에이전트' })).toBeInTheDocument();
    await user.click(within(await screen.findByTestId('skill-panel')).getByRole('button', { name: '넓게 보기' }));
    expect(screen.queryByRole('navigation', { name: 'AI 에이전트' })).not.toBeInTheDocument();
    await user.click(within(screen.getByTestId('skill-panel')).getByRole('button', { name: '원래 크기로' }));
    expect(screen.getByRole('navigation', { name: 'AI 에이전트' })).toBeInTheDocument();
  });

  it('가져다 쓰는 공용 스킬의 사본은 지우기 단추 대신 이유를 보인다', async () => {
    mount('/skills?profile=ma&skill=' + encodeURIComponent('ma:skills/digest'));
    const bar = within(await screen.findByTestId('skill-panel')).getByRole('toolbar', { name: '스킬 동작' });
    expect(within(bar).queryByRole('button', { name: '지우기' })).not.toBeInTheDocument();
    expect(within(bar).getByText('공용 스킬을 가져다 쓰는 사본입니다. 공용 스킬에서 지우세요')).toBeInTheDocument();
  });

  it('정리: 안 쓰임으로 거르고, 지울 수 있는 것만 골라 하나씩 지운다', async () => {
    const user = userEvent.setup();
    const fn = mount('/skills?profile=ma');
    await user.click(await screen.findByRole('button', { name: '정리' }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('f=unused'));
    await user.click(screen.getByRole('button', { name: /^안 쓰임 \d/ })); // 고른 칩을 다시 누르면 풀린다 — 안 쓰임이 아닌 것도 고를 수 있게(R4)
    const own = await screen.findByRole('region', { name: '전용 스킬' });
    expect(within(own).getByRole('checkbox', { name: 'weekly 고르기' })).toBeDisabled(); // 예약 작업이 부른다
    await user.click(screen.getByRole('button', { name: '지울 수 있는 것 모두 고르기' }));
    expect(within(own).getByRole('checkbox', { name: 'gif 고르기' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: '2개 지우기' }));
    const dialog = await screen.findByRole('dialog', { name: '스킬 2개 지우기' });
    await user.click(within(dialog).getByRole('button', { name: '2개 지우기' }));
    await waitFor(() => expect(postedTo(fn, '/api/skill/delete')).toHaveLength(2));
    expect(
      postedTo(fn, '/api/skill/delete')
        .map((b) => (b as { id: string }).id)
        .sort()
    ).toEqual(['ma:profiles/ma/skills/gif', 'ma:profiles/ma/skills/old']);
  });

  it('옛 주소(lens·tab·open)는 표로 연다', async () => {
    mount('/skills?tab=all');
    const group = await screen.findByRole('group', { name: '스킬 보기' });
    expect(within(group).getByRole('button', { name: '전체 스킬' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('agent-skills')).not.toBeInTheDocument();
  });

  it('에이전트 상태 값이 없는 옛 서버는 늘 표로 열고 전환을 숨긴다(OV-H2)', async () => {
    mount('/skills', { '/api/skills': { ...LIST, agents: undefined } });
    expect(await screen.findByRole('heading', { name: /스킬/ })).toBeInTheDocument();
    await screen.findAllByRole('row');
    expect(screen.queryByRole('group', { name: '스킬 보기' })).toBeNull();
    expect(screen.queryByTestId('agent-skills')).not.toBeInTheDocument();
  });

  it('주소의 에이전트가 목록에 없으면 주 에이전트로 바꾸고 한 번 알린다(D10)', async () => {
    mount('/skills?profile=gone');
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('profile=ma'));
    expect(await screen.findAllByText('gone 의 스킬을 찾지 못해 주 AI 에이전트를 보입니다')).toHaveLength(1);
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

  it('거두기: 게시 기록의 내 요청에만 단추, 거둔 뒤 보낸 결과를 지우고 2단계로(스펙 2026-11-20-009 §3-2 6)', async () => {
    const user = userEvent.setup();
    const base = { profile: 'ma', path: 'skills/weekly', name: 'weekly' };
    let items: Record<string, unknown>[] = [{ ...base, id: 'r0', version: '0.9.0', status: 'requested', who: 'lee@x.io' }]; // 같은 스킬, 남의 요청
    const fn = mount(WEEKLY + '&pane=publish', {
      '/api/market/publish': (url: string, body: Record<string, unknown>) => {
        if (url.startsWith('/api/market/publish/withdraw')) {
          items = items.map((r) => (r.id === body.id ? { ...r, status: 'withdrawn' } : r));
          return { ok: true, request: { status: 'withdrawn' } };
        }
        if (body.name) {
          items = [...items, { ...base, id: 'r1', version: '1.0.0', status: 'requested', who: 'local' }]; // 로그인이 꺼진 설치는 local
          return { ok: true, request: { id: 'r1' } };
        }
        return { items, can: true };
      },
    });
    const panel = await screen.findByTestId('skill-panel');
    await user.click(await within(panel).findByRole('button', { name: '점검' }));
    await user.click(await within(panel).findByRole('button', { name: '게시 요청' }));
    expect(await within(panel).findByTestId('publish-sent')).toBeInTheDocument();
    const mine = await within(panel).findByRole('button', { name: 'weekly@1.0.0 거두기' });
    expect(within(panel).getAllByTestId('publish-withdraw')).toHaveLength(1); // 0.9.0(남의 요청)에는 없다
    await user.click(mine);
    await user.click(within(await screen.findByRole('dialog', { name: '게시 요청 거두기' })).getByRole('button', { name: '거두기' }));
    await waitFor(() => expect(postedTo(fn, '/api/market/publish/withdraw')).toEqual([{ id: 'r1' }]));
    await waitFor(() => expect(within(panel).queryByTestId('publish-sent')).not.toBeInTheDocument());
    await waitFor(() => expect(within(within(panel).getByRole('list', { name: '게시 단계' })).getByText('2 확인')).toHaveAttribute('aria-current', 'step')); // 확인 창이 닫히는 동안은 aria-hidden
    expect(await within(panel).findByText('weekly@1.0.0 — 요청자가 거둠')).toBeInTheDocument();
    expect(within(panel).queryByTestId('publish-withdraw')).not.toBeInTheDocument();
  });

  it('자동 승인 미리 알림: 단추 바로 위 한 줄 — 공개면 경고, 이유별 문장, 모르는 코드는 「보낸 뒤 판정」(스펙 2026-11-20-009 §3-3)', async () => {
    const user = userEvent.setup();
    const cases: [Record<string, unknown>, string, string][] = [
      [{ will: true, reason: '', namespace: 'free', namespace_label: '공용', public: true }, '보내면 공용(외부 공개)에 자동 승인을 시도합니다', 'warning'],
      [{ will: true, reason: '', namespace: 'paid', namespace_label: '제한', public: false }, '보내면 제한(구성원만 보임)에 자동 승인을 시도합니다', 'info'],
      [{ will: false, reason: 'no_record' }, '이 AAS 에서 만든 기록이 없어 관리자 승인을 기다립니다', 'info'],
      [{ will: false, reason: 'origin_market' }, '원본이 있는 스킬을 고친 것이라 관리자 승인을 기다립니다', 'info'],
      [{ will: false, reason: 'internal_refs' }, '사내 주소가 있어 공개 네임스페이스에 자동으로 게시할 수 없습니다', 'info'],
      [{ will: false, reason: 'brand_new_code' }, '자동 승인 여부는 보낸 뒤 판정됩니다', 'info'],
    ];
    for (const [auto, text, severity] of cases) {
      mount(WEEKLY + '&pane=publish', { '/api/market/publish/check': { ...CHECK, auto } });
      const panel = await screen.findByTestId('skill-panel');
      await user.click(await within(panel).findByRole('button', { name: '점검' }));
      const line = await within(panel).findByTestId('publish-auto');
      expect(line).toHaveTextContent(text);
      expect(line.className).toContain(severity === 'warning' ? 'Warning' : 'Info');
      expect(line).not.toHaveTextContent('바로 게시됩니다');
      const ask = within(panel).getByRole('button', { name: '게시 요청' });
      expect(line.compareDocumentPosition(ask) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // 단추 바로 위
      cleanup();
    }
  });

  it('자동 승인 미리 알림: 관리자 본인은 없고, 실패 항목이 있으면 숨기고, 보낸 뒤 판정이 다르면 결과 안에 한 줄', async () => {
    const user = userEvent.setup();
    mount(WEEKLY + '&pane=publish', { '/api/market/publish/check': { ...CHECK, auto: { will: false, reason: 'admin' } } });
    let panel = await screen.findByTestId('skill-panel');
    await user.click(await within(panel).findByRole('button', { name: '점검' }));
    await within(panel).findByTestId('publish-checks');
    expect(within(panel).queryByTestId('publish-auto')).not.toBeInTheDocument();
    cleanup();
    mount(WEEKLY + '&pane=publish', {
      '/api/market/publish/check': { ...CHECK, ok: false, checks: [...CHECK.checks, { id: 'name', level: 'fail', message: 'bad' }], auto: { will: true, reason: '' } },
    });
    panel = await screen.findByTestId('skill-panel');
    await user.click(await within(panel).findByRole('button', { name: '점검' }));
    await within(panel).findByTestId('publish-blocked');
    expect(within(panel).queryByTestId('publish-auto')).not.toBeInTheDocument();
    cleanup();
    mount(WEEKLY + '&pane=publish', {
      '/api/market/publish/check': { ...CHECK, auto: { will: true, reason: '', namespace: 'paid', public: false } },
      '/api/market/publish': (url: string, body: Record<string, unknown>) =>
        body.name ? { ok: true, request: { id: 'r1', auto_reason: 'changed_since' } } : { items: [], can: true },
    });
    panel = await screen.findByTestId('skill-panel');
    await user.click(await within(panel).findByRole('button', { name: '점검' }));
    await user.click(await within(panel).findByRole('button', { name: '게시 요청' }));
    expect(await within(panel).findByTestId('publish-differ')).toHaveTextContent('점검 때와 판정이 달라졌습니다(점검 뒤 파일이 바뀌었을 수 있습니다): 만든 뒤 바뀌어 관리자 승인을 기다립니다');
    expect(within(panel).queryByTestId('publish-auto')).not.toBeInTheDocument(); // 보낸 뒤에는 예상 줄을 숨긴다
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
    // 줄 이름 단추(고르기)와 「값 넣기」 단추가 나뉘어 있다(스펙 2026-11-18-004 §3-1)
    expect(within(box).getByRole('button', { name: 'gif 스킬 값 넣기' })).toBeInTheDocument();
    await user.click(within(box).getByRole('button', { name: /^gif.*GIF_KEY/ }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('pane=needs'));
    expect(screen.getByTestId('loc')).toHaveTextContent('skill=ma%3Aprofiles%2Fma%2Fskills%2Fgif');
  });

  it('G16: 채팅과 같은 에이전트 이름, 「주」 대신 「기본」, 표로 가는 길은 머리 「전체 스킬」 하나', async () => {
    mount('/skills?profile=ma', {
      '/api/chat/status': { configured: true, pod: 'p1', agents: [{ name: 'ma', title: '마케팅 도우미' }, { name: 'ops', title: '' }] },
    });
    const nav = await screen.findByRole('navigation', { name: 'AI 에이전트' });
    const ma = await within(nav).findByRole('button', { name: /마케팅 도우미/ });
    expect(within(ma).getByText('기본')).toBeInTheDocument();
    expect(within(nav).queryByText('주')).toBeNull();
    expect(await screen.findByText('마케팅 도우미의 스킬')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '모든 AI 에이전트의 스킬 표' })).toBeNull();
    expect(screen.getAllByRole('button', { name: '전체 스킬' })).toHaveLength(1); // 이름을 「전체 표」에서 바꿨다(스펙 2026-11-06-003 R2)
  });

  it('위치 줄: 누구의 어느 AI 에이전트 작업공간의 어느 프로파일을 보는지 보인다(스펙 2026-11-18-005 §9)', async () => {
    mount('/skills?profile=ma', {
      '/api/chat/status': {
        configured: true,
        groups: [
          { configured: true, pod: 'p0', name: '다른 곳', owner_name: '김철수', agents: [{ name: 'ma' }] },
          { configured: true, pod: 'p1', name: '시험 공간', owner_name: '홍길동', current: true, agents: [{ name: 'ma', title: '마케팅 도우미' }, { name: 'ops' }] },
        ],
      },
    });
    const where = await screen.findByRole('navigation', { name: '보고 있는 AI 에이전트' });
    expect(await within(where).findByText('시험 공간')).toBeInTheDocument();
    expect(within(where).getByText('홍길동님의 AI 에이전트 작업공간')).toBeInTheDocument();
    expect(within(where).getByText('AI 에이전트(프로파일) ma')).toBeInTheDocument();
    expect(within(where).getByText('마케팅 도우미')).toBeInTheDocument();
    expect(within(where).getByText('기본')).toBeInTheDocument();
    expect(within(where).queryByText('다른 곳')).toBeNull();
  });

  it('위치 줄: 작업공간 이름을 읽지 못하면(옛 서버) 프로파일만 보인다', async () => {
    mount('/skills?profile=ops');
    const where = await screen.findByRole('navigation', { name: '보고 있는 AI 에이전트' });
    expect(within(where).getByText('AI 에이전트(프로파일) ops')).toBeInTheDocument();
    expect(within(where).queryByText(/작업공간/)).toBeNull();
  });

  it('G17: 켜고 끄기가 실패하면 스위치를 원래대로 두고 오류를 알린다', async () => {
    const user = userEvent.setup();
    mount('/skills?profile=ma', {
      '/api/profile/action': () => new Response(JSON.stringify({ error: '거절됨' }), { status: 500 }),
    });
    await screen.findByRole('region', { name: '전용 스킬' });
    const sw = screen.getByRole('switch', { name: /old/ });
    expect(sw).not.toBeChecked();
    await user.click(sw);
    expect(await screen.findByText(/old 을\(를\) 바꾸지 못해 원래대로 두었습니다/)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /old/ })).not.toBeChecked();
  });

  it('G18: 비었거나 만료된 자격증명 카드와 「설정 필요」 줄에 API 키·토큰 화면 링크', async () => {
    mount(WEEKLY + '&pane=run'); // 기본 탭이 개요가 되어 동작 탭을 주소로 연다(스펙 2026-11-06-003 D2)
    const panel = await screen.findByTestId('skill-panel');
    const card = (await within(panel).findByRole('region', { name: '자격증명' })).querySelector('[data-node="cred:.env:REPORT_TOKEN"]') as HTMLElement;
    expect(within(card).getByRole('link', { name: 'API 키·토큰 화면 보기' })).toHaveAttribute('href', '/credentials?tab=all&profile=ma');
  });

  it('G18: 필요한 것 탭의 값 없는 환경변수 줄에도 같은 링크', async () => {
    mount(WEEKLY + '&pane=needs');
    const panel = await screen.findByTestId('skill-panel');
    const li = (await within(panel).findByText('REPORT_TOKEN')).closest('li') as HTMLElement;
    expect(within(li).getByRole('link', { name: 'API 키·토큰 화면 보기' })).toHaveAttribute('href', '/credentials?tab=all&profile=ma');
  });

  it('G19: 「등록됨」 근거 칩은 중립색(호박색 아님)', async () => {
    mount(WEEKLY + '&pane=run', {
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

describe('스킬 — 개요 탭(스펙 2026-11-06-003 R1)', () => {
  const WEEKLY = '/skills?profile=ma&skill=ma%3Aprofiles%2Fma%2Fskills%2Fweekly';
  // 기본 탭은 「연결도」라 개요는 주소로 연다
  const OV = WEEKLY + '&pane=overview';
  const GIF_ID = 'ma:profiles/ma/skills/gif';
  const FILE = { name: 'SKILL.md', path: 'profiles/ma/skills/weekly/SKILL.md', lines: SKILL_MD, siblings: ['run.py'] };

  it('파일 탭의 SKILL.md 는 스킬 연결도 「코드」 탭과 같은 편집기를 읽기 전용으로 쓴다(2026-11-06)', async () => {
    mount(WEEKLY + '&pane=files', { '/api/skill/summary': sumView(), '/api/file?': FILE });
    const panel = await screen.findByTestId('skill-panel');
    const viewer = await within(panel).findByRole('textbox', { name: 'SKILL.md 코드' });
    expect(viewer).toHaveAttribute('readonly');
    expect(viewer).toHaveAttribute('data-language', 'markdown');
    expect((viewer as HTMLTextAreaElement).value).toContain('본문 1');
  });

  it('같은 폴더의 파일은 접혀 있다가 누르면 한 줄에 하나, 스킬 폴더 안 경로로 보인다(2026-11-06)', async () => {
    const siblings = ['profiles/ma/skills/weekly/SKILL.md', 'profiles/ma/skills/weekly/scripts/run.py', 'other/x.md'];
    mount(WEEKLY + '&pane=files', { '/api/skill/summary': sumView(), '/api/file?': { ...FILE, siblings } });
    // 처음에는 접혀 있고 「펼치기」를 눌러야 보인다
    const toggle = await screen.findByRole('button', { name: '펼치기' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('folder-files')).toBeNull();
    await userEvent.setup().click(toggle);
    expect(screen.getByRole('button', { name: '접기' })).toHaveAttribute('aria-expanded', 'true');
    const list = await screen.findByTestId('folder-files');
    const items = within(list).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual(['SKILL.md', 'scripts/run.py', 'other/x.md']);
    expect(items[1]).toHaveAttribute('title', 'profiles/ma/skills/weekly/scripts/run.py');
  });

  it('머리의 「새 스킬」은 전체 스킬 화면처럼 제목 옆 아이콘 단추다(2026-11-06)', async () => {
    mount(OV, { '/api/skill/summary': sumView(), '/api/file?': FILE });
    const adds = await screen.findAllByRole('button', { name: '새 스킬' });
    const add = adds.find((b) => !b.textContent?.includes('새 스킬'));
    expect(add).toBeDefined(); // 제목 옆은 글자 없이 아이콘만, 이름은 aria-label
  });

  it('경로 줄 오른쪽 끝의 「새 스킬」은 지금 보는 AI 에이전트를 위치로 새 스킬 서랍을 연다(2026-11-18)', async () => {
    const user = userEvent.setup();
    mount('/skills?profile=ma');
    const where = await screen.findByTestId('skills-where');
    const row = where.parentElement as HTMLElement;
    const btn = within(row).getByRole('button', { name: '새 스킬' });
    expect(btn).toHaveTextContent('새 스킬');
    expect(where.contains(btn)).toBe(false); // 길 안내(nav) 밖의 동작
    await user.click(btn);
    const dlg = await screen.findByRole('dialog', { name: '새 스킬' });
    expect(within(dlg).getByRole('combobox', { name: '누가 쓰나' })).toHaveValue('ma');
  });

  it('스킬을 고르면 기본 탭은 「개요」, 연결도는 그다음 탭이고, 요약은 개요에 있고 파일 탭에는 없다(D4)', async () => {
    const user = userEvent.setup();
    const fn = mount(OV, { '/api/skill/summary': sumView(), '/api/file?': FILE });
    const panel = await screen.findByTestId('skill-panel');
    const tabs = within(panel).getAllByRole('tab').map((x) => x.textContent);
    expect(tabs.slice(0, 2)).toEqual(['개요', '연결도']);
    expect(within(panel).getByRole('tab', { name: '개요' })).toHaveAttribute('aria-selected', 'true');
    const overview = within(panel).getByTestId('skill-overview');
    expect(await within(overview).findByTestId('ai-summary')).toHaveTextContent('주간 보고서를 만든다');
    expect(within(overview).queryByTestId('skill-excerpt')).toBeNull(); // 요약이 있으면 대신 보기는 없다
    expect(postedTo(fn, '/api/skill/summary')).toHaveLength(0);
    await user.click(within(panel).getByRole('tab', { name: '파일' }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('pane=files'));
    expect(await within(panel).findByText(/본문 1/)).toBeInTheDocument();
    expect(within(panel).queryByTestId('ai-summary')).toBeNull();
    // 기본 탭(개요)으로 돌아가면 주소에서 pane 이 지워진다
    await user.click(within(panel).getByRole('tab', { name: '개요' }));
    await waitFor(() => expect(screen.getByTestId('loc')).not.toHaveTextContent('pane='));
  });

  it('pane=files 주소는 파일 탭을 연다', async () => {
    mount(WEEKLY + '&pane=files');
    const panel = await screen.findByTestId('skill-panel');
    expect(within(panel).getByRole('tab', { name: '파일' })).toHaveAttribute('aria-selected', 'true');
  });

  it('요약이 없으면 개요를 1.5초 본 뒤에만 한 번 만들고, 그 전에 다른 스킬로 옮기면 앞 스킬은 만들지 않는다(D3)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const fn = mount(OV, {
        '/api/skill/summary': (_u: string, b: Record<string, unknown>) => (b.id ? sumView() : sumView({ summary: null })),
        '/api/file?': FILE,
      });
      const panel = await screen.findByTestId('skill-panel');
      await within(panel).findByTestId('skill-excerpt');
      await act(() => vi.advanceTimersByTimeAsync(500));
      expect(postedTo(fn, '/api/skill/summary')).toHaveLength(0);
      // 1.5초가 되기 전에 다른 스킬로 옮긴다
      await user.click(within(screen.getByRole('region', { name: '전용 스킬' })).getByRole('button', { name: /gif/ }));
      await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('skill=ma%3Aprofiles%2Fma%2Fskills%2Fgif'));
      await screen.findByTestId('skill-excerpt');
      await act(() => vi.advanceTimersByTimeAsync(800));
      expect(postedTo(fn, '/api/skill/summary')).toHaveLength(0);
      await act(() => vi.advanceTimersByTimeAsync(800));
      await waitFor(() => expect(postedTo(fn, '/api/skill/summary')).toEqual([{ id: GIF_ID, refresh: false }]));
      // 만든 요약이 오면 대신 보기는 사라진다(D8)
      expect(await screen.findByTestId('ai-summary')).toHaveTextContent('주간 보고서를 만든다');
      await waitFor(() => expect(screen.queryByTestId('skill-excerpt')).toBeNull());
      await act(() => vi.advanceTimersByTimeAsync(2000));
      expect(postedTo(fn, '/api/skill/summary')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('1.5초 안에 다른 탭으로 옮기면 요약을 만들지 않는다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const fn = mount(OV, { '/api/skill/summary': sumView({ summary: null }), '/api/file?': FILE });
      const panel = await screen.findByTestId('skill-panel');
      await within(panel).findByTestId('skill-excerpt');
      await user.click(within(panel).getByRole('tab', { name: '필요한 것' }));
      await act(() => vi.advanceTimersByTimeAsync(2000));
      expect(postedTo(fn, '/api/skill/summary')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  const excerptCases: [string, Record<string, unknown>][] = [
    ['요약 꺼짐', { '/api/skill/summary': sumView({ enabled: false, summary: null }) }],
    ['요약 경로가 없는 옛 서버(질의 오류)', { '/api/skill/summary': () => new Response('{}', { status: 404 }) }],
    [
      '만들기 실패',
      {
        '/api/skill/summary': (_u: string, b: Record<string, unknown>) =>
          b.id ? new Response(JSON.stringify({ error: 'x', reason: 'llm_failed' }), { status: 502 }) : sumView({ summary: null }),
      },
    ],
  ];
  it.each(excerptCases)('%s: SKILL.md 앞부분(머리말 없음, 빈 줄 빼고 15줄)과 「파일에서 전체 보기」', async (_name, over) => {
    const user = userEvent.setup();
    mount(OV, { '/api/file?': FILE, ...over });
    const box = await screen.findByTestId('skill-excerpt', {}, { timeout: 4000 });
    const text = await within(box).findByText(/# 주간 보고/);
    const lines = (text.textContent ?? '').split('\n');
    expect(lines).toHaveLength(15);
    expect(lines[0]).toBe('# 주간 보고');
    expect(lines.every((l) => l.trim())).toBe(true);
    expect(box).not.toHaveTextContent('description: 머리말 설명');
    expect(box).not.toHaveTextContent('name: weekly');
    await user.click(within(box).getByRole('button', { name: '파일에서 전체 보기' }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('pane=files'));
  });

  it('요약 만들기가 실패하면 경고와 「다시 요약」이 요약 자리에 남고 SKILL.md 앞부분도 그대로 보인다(D8)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
    try {
      mount(OV, {
        '/api/file?': FILE,
        '/api/skill/summary': (_u: string, b: Record<string, unknown>) =>
          b.id ? new Response(JSON.stringify({ error: 'x', reason: 'llm_failed' }), { status: 502 }) : sumView({ summary: null }),
      });
      await screen.findByTestId('skill-excerpt');
      await act(() => vi.advanceTimersByTimeAsync(1600));
      const sum = await screen.findByTestId('ai-summary');
      expect(await within(sum).findByRole('alert')).toBeInTheDocument();
      expect(within(sum).getByRole('button', { name: '다시 요약' })).toBeInTheDocument();
      expect(screen.getByTestId('skill-excerpt')).toHaveTextContent('# 주간 보고');
    } finally {
      vi.useRealTimers();
    }
  });

  it('SKILL.md 를 읽지 못하면 대신 보기 자리에 경고', async () => {
    mount(OV, { '/api/file?': () => new Response(JSON.stringify({ error: '읽기 실패' }), { status: 500 }) });
    const box = await screen.findByTestId('skill-excerpt');
    expect(await within(box).findByRole('alert')).toBeInTheDocument();
  });

  it('설정 필요 스킬의 개요에 빠진 환경변수와 고치기 링크, 「AI 에게 더 묻기」는 개요에, 「고치기 요청」은 파일 탭에', async () => {
    const user = userEvent.setup();
    mount('/skills?profile=ma&skill=ma%3Aprofiles%2Fma%2Fskills%2Fgif&pane=overview');
    const panel = await screen.findByTestId('skill-panel');
    const setup = await within(panel).findByTestId('skill-setup');
    expect(setup).toHaveTextContent('GIF_KEY');
    expect(within(setup).getByRole('link', { name: 'API 키·토큰 화면 보기' })).toHaveAttribute('href', '/credentials?tab=all&profile=ma');
    const overview = within(panel).getByTestId('skill-overview');
    expect(await within(overview).findByRole('button', { name: 'AI 에게 더 묻기' })).toBeInTheDocument();
    expect(within(overview).queryByRole('button', { name: '고치기 요청' })).toBeNull();
    await user.click(within(panel).getByRole('tab', { name: '파일' }));
    expect(await within(panel).findByRole('button', { name: '고치기 요청' })).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'AI 에게 더 묻기' })).toBeNull();
  });

  it('설정이 필요 없는 스킬에는 설정 필요 줄이 없다', async () => {
    mount(OV);
    const panel = await screen.findByTestId('skill-panel');
    await within(panel).findByRole('button', { name: 'AI 에게 더 묻기' });
    expect(within(panel).queryByTestId('skill-setup')).toBeNull();
  });
});

// 스펙 2026-11-19-005 2단계 R3·R4: 기간 전환(7·30·90일)·정렬·줄 숫자·칩 정리·공용 합 꼬리표·상태 안내
describe('스킬 — 기간 사용(스펙 2026-11-19-005 R3·R4)', () => {
  const day = 86400000;
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19);
  const P = (u: [number, number, number], un: [boolean | null, boolean | null, boolean | null], extra: Record<string, unknown> = {}) => ({
    uses_7: u[0], uses_30: u[1], uses_90: u[2],
    covered_7: un[0] !== null, covered_30: un[1] !== null, covered_90: un[2] !== null,
    unused_7: un[0], unused_30: un[1], unused_90: un[2],
    file_only_7: false, file_only_30: false, file_only_90: false,
    ...extra,
  });
  const by = (id: string) => LIST.skills.find((s) => s.id === id)!;
  const periodList = (agentOver: Record<string, unknown> = {}) => ({
    ...LIST,
    agents: LIST.agents.map((a) =>
      a.profile === 'ma'
        ? { ...a, usage_ready: true, runs_7: 1, runs_30: 8, runs_90: 9, usage_unknown: [], ...agentOver }
        : { ...a, usage_ready: true, runs_7: 0, runs_30: 0, runs_90: 0, usage_unknown: [] }
    ),
    skills: [
      { ...by('default:skills/digest'), ...P([0, 2, 2], [true, false, false]), shared_uses_7: 0, shared_uses_30: 3, shared_uses_90: 3,
        used_by: [{ profile: 'default', n7: 0, n30: 2, n90: 2 }, { profile: 'ma', n7: 0, n30: 1, n90: 1 }] },
      { ...by('ma:profiles/ma/skills/weekly'), ...P([2, 5, 9], [false, false, false]) },
      { ...by('ma:profiles/ma/skills/gif'), ...P([0, 0, 0], [true, true, true]) },
      { ...by('ma:profiles/ma/skills/old'), ...P([0, 0, 0], [true, true, true]) },
      { ...by('ma:profiles/ma/skills/gif'), id: 'ma:profiles/ma/skills/fileonly', name: 'fileonly', readiness: 'ok', missing_env: [],
        last_used: '2026-11-04T09:00:00', ...P([0, 0, 0], [false, false, false], { file_only_7: true, file_only_30: true, file_only_90: true }) },
      { ...by('ma:profiles/ma/skills/gif'), id: 'ma:profiles/ma/skills/unk', name: 'unk', readiness: 'ok', missing_env: [],
        ...P([0, 0, 0], [true, null, null]) },
      { ...by('ma:skills/digest'), ...P([0, 1, 1], [true, false, false]) },
      { ...by('ma:skills/unused-shared'), ...P([0, 0, 0], [true, true, true]) },
    ],
  });
  const own = async () => screen.findByRole('region', { name: /^전용 스킬/ });
  const names = (region: HTMLElement) => Array.from(region.querySelectorAll('[data-skill]')).map((li) => li.getAttribute('data-skill'));
  const numOf = (region: HTMLElement, name: string) => region.querySelector(`[data-skill="${name}"] [data-period-num]`)?.textContent;

  it('기본 30일: 기간 사용 순으로 정렬하고 숫자 칸은 N회·—(사용 파일만)·?(셀 수 없음), 칩은 0이면 숨긴다', async () => {
    mount('/skills?profile=ma', { '/api/skills': periodList() });
    const region = await own();
    expect(names(region)).toEqual(['weekly', 'fileonly', 'gif', 'old', 'unk']);
    expect([numOf(region, 'weekly'), numOf(region, 'fileonly'), numOf(region, 'unk')]).toEqual(['5회', '—', '?']);
    expect(region.querySelector('[data-skill="unk"] [data-period-num]')).toHaveAttribute('aria-label', '일부 기록을 읽지 못해 셀 수 없음');
    const chips = within(screen.getByRole('group', { name: '상태로 거르기' })).getAllByRole('button').map((b) => b.textContent);
    expect(chips).toEqual(['최근 30일 사용 3', '설정 필요 1', '30일 넘게 안 씀 1', '꺼짐 1', '예약 작업 1', '정리']);
    expect(screen.getByText(/최근 30일 · 대화 8건/)).toBeInTheDocument();
  });

  it('7일로 바꾸면 서버를 다시 부르지 않고 숫자·정렬·칩 이름이 바뀌고, 정리는 끈다', async () => {
    const user = userEvent.setup();
    const fn = mount('/skills?profile=ma', { '/api/skills': periodList() });
    await own();
    const calls = fn.mock.calls.filter((c) => String(c[0]).startsWith('/api/skills')).length;
    await user.click(screen.getByRole('button', { name: '7일' }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('p=7'));
    const region = await own();
    expect(numOf(region, 'weekly')).toBe('2회');
    expect(screen.getByRole('button', { name: /^7일 넘게 안 씀/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '정리' })).toBeDisabled();
    expect(fn.mock.calls.filter((c) => String(c[0]).startsWith('/api/skills')).length).toBe(calls);
  });

  it('주소의 기간이 브라우저 저장보다 앞선다', async () => {
    localStorage.setItem('aas.skills.period', '7');
    mount('/skills?profile=ma&p=90', { '/api/skills': periodList() });
    expect(numOf(await own(), 'weekly')).toBe('9회');
    expect(screen.getByRole('button', { name: '90일' })).toHaveAttribute('aria-pressed', 'true');
    localStorage.removeItem('aas.skills.period');
  });

  it('공용 사본은 자기 사용으로 정렬하고 모든 에이전트 합을 꼬리표로, 쓰지 않는 공용 스킬은 접는다', async () => {
    const user = userEvent.setup();
    mount('/skills?profile=ma', { '/api/skills': periodList() });
    const shared = await screen.findByRole('region', { name: /가져다 쓰는 공용 스킬 중 쓰는 것 1 \/ 전체 2/ });
    expect(names(shared)).toEqual(['digest']);
    expect(shared.querySelector('[data-skill="digest"] [data-shared-total]')).toHaveTextContent('모든 AI 에이전트 3회');
    await user.click(within(shared).getByRole('button', { name: '쓰지 않은 공용 스킬 1개 더 보기' }));
    expect(names(await screen.findByRole('region', { name: /^가져다 쓰는 공용 스킬/ }))).toEqual(['digest', 'unused-shared']);
  });

  it('고른 칩은 다시 누르면 풀리고, ?f=all 은 칩 없음으로 연다', async () => {
    const user = userEvent.setup();
    mount('/skills?profile=ma&f=all', { '/api/skills': periodList() });
    await own();
    await user.click(screen.getByRole('button', { name: /^설정 필요 1/ }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('f=setup'));
    expect(names(await own())).toEqual(['gif']);
    await user.click(screen.getByRole('button', { name: /^설정 필요 1/ }));
    await waitFor(() => expect(screen.getByTestId('loc')).not.toHaveTextContent('f='));
  });

  it('처음 모으기 전이면 기간 단추를 끄고 안내를 보이며 지금 정렬을 쓴다', async () => {
    const list = {
      ...LIST,
      agents: LIST.agents.map((a) => ({ ...a, usage_ready: false, usage_unknown: [] })),
      skills: LIST.skills.map((s) => ({ ...s, uses_7: null, uses_30: null, uses_90: null, unused_30: null })),
    };
    mount('/skills?profile=ma', { '/api/skills': list });
    expect(await screen.findByText('사용 기록을 처음 모으는 중입니다. 몇 분 뒤 기간별 사용이 보입니다.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '30일' })).toBeDisabled();
    expect((await own()).querySelector('[data-period-num]')).toBeNull();
    expect(names(await own())[0]).toBe('weekly'); // 예약 작업 먼저(지금 정렬)
  });

  // 2b단계 R5: 「많이 쓴 스킬」 고정 줄과 순위 칸
  const top = {
    '7': [],
    '30': [
      { key: 'default/digest', name: 'digest', origin_profile: 'default', shared: true, n: 3, partial: true,
        profiles: [{ profile: 'default', id: 'default:skills/digest', n: 2 }, { profile: 'ma', id: 'ma:skills/digest', n: 1 }] },
      { key: 'ma/weekly', name: 'weekly', origin_profile: 'ma', shared: false, n: 5, partial: false,
        profiles: [{ profile: 'ma', id: 'ma:profiles/ma/skills/weekly', n: 5 }] },
    ],
    '90': [],
  };
  it('「많이 쓴 스킬」 고정 줄은 순위 칸을 열고, 줄을 누르면 가장 많이 쓴 에이전트의 그 스킬로 간다', async () => {
    const user = userEvent.setup();
    mount('/skills?profile=ma', { '/api/skills': { ...periodList(), top_skills: top } });
    await user.click(await screen.findByRole('button', { name: /^많이 쓴 스킬/ }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('view=top'));
    const region = await screen.findByRole('region', { name: '많이 쓴 스킬' });
    expect(Array.from(region.querySelectorAll('[data-top]')).map((li) => li.getAttribute('data-top'))).toEqual(['default/digest', 'ma/weekly']);
    expect(region.querySelector('[data-top="default/digest"]')).toHaveTextContent('일부');
    await user.click(within(region).getByRole('button', { name: /^digest/ }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('skill=default%3Askills%2Fdigest'));
    expect(screen.getByTestId('loc')).not.toHaveTextContent('view=');
  });

  it('「많이 쓴 스킬」 칸에서 7일에 쓴 것이 없으면 그렇다고 적는다', async () => {
    mount('/skills?profile=ma&view=top&p=7', { '/api/skills': { ...periodList(), top_skills: top } });
    expect(await screen.findByText('최근 7일 동안 쓴 스킬이 없습니다.')).toBeInTheDocument();
  });

  // 2b단계 R7: 많이 쓴 내 스킬(직접 만든 스킬, 고른 기간 5회 이상)은 게시 탭으로, 게시한 것은 「게시됨」
  it('많이 쓴 내 스킬 줄에 「스킬 허브에 게시」, 게시한 스킬은 「게시됨」, 공용 사본에는 없다', async () => {
    const user = userEvent.setup();
    mount('/skills?profile=ma', { '/api/skills': periodList() });
    const region = await own();
    const weekly = region.querySelector('[data-skill="weekly"]') as HTMLElement;
    await user.click(within(weekly).getByRole('button', { name: '스킬 허브에 게시' }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('pane=publish'));
    cleanup();
    const list = periodList();
    list.skills = list.skills.map((s) => (s.name === 'weekly' && !s.shared_from ? { ...s, published: true } : s));
    mount('/skills?profile=ma', { '/api/skills': list });
    const again = (await own()).querySelector('[data-skill="weekly"]') as HTMLElement;
    expect(within(again).getByText('게시됨')).toBeInTheDocument();
    expect(within(again).queryByRole('button', { name: '스킬 허브에 게시' })).toBeNull();
    expect(screen.queryAllByRole('button', { name: '스킬 허브에 게시' })).toHaveLength(0);
  });

  it('고른 기간에 읽지 못한 구간이 있으면 날짜 범위를 알린다', async () => {
    const now = Date.now();
    const range = [iso(now - 5 * day), iso(now - 3 * day)] as [string, string];
    mount('/skills?profile=ma', { '/api/skills': periodList({ usage_unknown: [range] }) });
    const notice = await screen.findByText(/기록이 많아 읽지 못했습니다/);
    expect(notice).toHaveTextContent(`${range[0].slice(5, 10)}~${range[1].slice(5, 10)}`);
  });
});
