/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { watchChatPopup } from '@/test/chatPopup';
import { HistoryBack, mountScreen, postedTo, rowByName, stubApi } from '@/test/mountScreen';

import { Flows } from './Flows';

const STARTS = {
  totals: { nodes: 40, edges: 55 },
  starts: [
    {
      id: 'cron:ma/j1',
      label: 'nightly',
      profile: 'ma',
      status: 'bad',
      badges: ['실패'],
      sub: 'ma · 30 9 * * *',
      skills: ['report'],
      scripts: ['run.py'],
    },
    {
      id: 'cron:ops/j2',
      label: 'cleanup',
      profile: 'ops',
      status: 'off',
      badges: ['꺼짐'],
      sub: 'ops · 30m',
      skills: [],
      scripts: [],
    },
  ],
};
const SKILLS = {
  totals: { skills: 2 },
  skills: [
    {
      id: 'ma:report',
      name: 'report',
      description: '보고',
      profile: 'ma',
      n_cron: 1,
      n_scripts: 1,
      n_mcp: 1,
      n_rest: 0,
    },
  ],
};
const n = (id: string, kind: string, label: string, over = {}) => ({
  id,
  kind,
  label,
  sub: '',
  badges: [] as string[],
  depth: 0,
  meta: {} as Record<string, string>,
  ...over,
});
const GRAPH = (over = {}) => ({
  root: 'cron:ma/j1',
  nodes: [
    n('cron:ma/j1', 'cron', 'nightly', { meta: { 프로파일: 'ma', 일정: '30 9 * * *' } }),
    n('skill:ma:report', 'skill', 'report', {
      depth: 1,
      profile: 'ma',
      badges: ['등록됨'],
      meta: { 경로: 'skills/report' },
      path: 'skills/report/SKILL.md',
      more: 2,
    }),
    n('script:run.py', 'script', 'run.py', {
      depth: 2,
      path: 'skills/report/run.py',
      link: { view: 'tools', params: { tab: 'all', q: 'run.py' } },
    }),
    n('mcp:chart', 'mcp', 'chart', { depth: 2 }),
  ],
  edges: [
    { from: 'cron:ma/j1', to: 'skill:ma:report', kind: 'runs', conf: 'config', meta: {}, evidence: [] },
    {
      from: 'skill:ma:report',
      to: 'script:run.py',
      kind: 'calls',
      conf: 'code',
      meta: {},
      evidence: [{ file: 'skills/report/SKILL.md', line: 3, text: 'python run.py' }],
    },
    {
      from: 'skill:ma:report',
      to: 'mcp:chart',
      kind: 'calls',
      conf: 'observed',
      meta: { observed: 4, tools: ['render'] },
      evidence: [],
    },
  ],
  observed: { days: 14, scope: '이 작업', runs: 6, matched: 1 },
  hidden_mentions: 2,
  ...over,
});
const FILE = (over = {}) => ({
  name: 'SKILL.md',
  path: 'skills/report/SKILL.md',
  lines: ['# report', '설명', 'python run.py', '끝'],
  sha: 'f1',
  versions: 1,
  masked_lines: [],
  modified: '2026-10-01T00:00:00',
  editable: true,
  siblings: ['skills/report/SKILL.md', 'skills/report/run.py'],
  ...over,
});

// jsdom 에는 PointerEvent 가 없어 fireEvent.pointer* 가 clientX·button 을 버린다. MouseEvent 로 대신한다(DrawerHost.test 와 같음).
if (typeof window.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

afterEach(() => vi.unstubAllGlobals());

/** 마지막으로 올린 화면의 조회 캐시 */
let lastQc: ReturnType<typeof mountScreen>['qc'];

function mount(initial: string, graph: unknown = GRAPH(), file: unknown = FILE(), back = false) {
  const fn = stubApi({
    '/api/flow?': graph,
    '/api/flows': STARTS,
    '/api/skills': SKILLS,
    '/api/file/preview': { problem: '' },
    '/api/file/save': { ok: true },
    '/api/file/revert': { ok: true },
    '/api/file/diff': { lines: [], added: 0, removed: 0, same: true },
    '/api/file': file,
    '/api/cron/job': {
      can_edit: true,
      job: { id: 'j1', enabled: true },
      runs: [],
      prompt_doc: { lines: [], sha: 'p' },
    },
    '/api/cron/explain': { checks: [], groups: [] },
    '/api/text/versions': { versions: [] },
  });
  lastQc = mountScreen(
    <>
      <Flows />
      {back && <HistoryBack />}
    </>,
    initial
  ).qc;
  return fn;
}
const sidebar = () => screen.getByRole('complementary', { name: '살펴보기' });

describe('Flows: 시작점 고르기', () => {
  it('첫 탭은 「스킬에서」, 그다음이 「크론 작업에서」다. 카드도 같은 순서', async () => {
    mount('/flows');
    expect(await screen.findByRole('tab', { name: /스킬에서/ })).toHaveAttribute('aria-selected', 'true');
    // 보기 카드(2026-10-17-011)가 탭 줄을 대신한다. 접근 이름은 「라벨, 숫자」
    expect(screen.getAllByRole('tab').map((t) => t.getAttribute('aria-label')?.split(', ')[0])).toEqual(['스킬에서', '예약 작업에서']);
    expect(await rowByName(/report/)).toBeInTheDocument();
  });

  it('카드와 크론에서 시작하는 흐름 행', async () => {
    mount('/flows?tab=cron');
    expect(await screen.findByText('nightly')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^예약 작업에서, \d+$/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('연결 55개')).toBeInTheDocument();
    expect(within(await rowByName(/nightly/)).getByText('report')).toBeInTheDocument(); // 스킬 칸
    expect(screen.getByText('꺼짐')).toBeInTheDocument(); // 꺼진 작업
  });

  it('행을 누르면 그 흐름의 그림으로 간다. 스킬 탭(첫 탭)은 skill: 로 시작한다', async () => {
    const user = userEvent.setup();
    mount('/flows');
    await user.click(await rowByName(/report/));
    expect(screen.getByTestId('loc')).toHaveTextContent('/flows?root=skill%3Ama%3Areport');
  });

  it('크론 작업에서 탭: 행을 눌러 서랍을 열어도, 닫아도 보던 탭이 남는다', async () => {
    // 주소를 새로 만들면 tab= 이 사라져 뒤의 목록이 첫 탭으로 돌아갔다(2026-10-13 사용자 보고). 첫 탭이 아닌 탭으로 확인한다
    const user = userEvent.setup();
    mount('/flows?tab=cron');
    await user.click(await rowByName(/nightly/));
    expect(screen.getByTestId('loc')).toHaveTextContent('/flows?tab=cron&root=cron%3Ama%2Fj1');
    const dlg = await screen.findByRole('dialog', { name: '스킬 연결도' });
    await user.click(within(dlg).getAllByRole('button', { name: '닫기' })[0]);
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/flows\?tab=cron$/));
    expect(screen.getByRole('tab', { name: /예약 작업에서/ })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('Flows: 그림 화면', () => {
  it('중심 이름·노드/연결 수·종류 칩·실행 기록 안내', async () => {
    mount('/flows?root=cron:ma/j1');
    expect(await screen.findByText('예약 작업 · 노드 4 · 연결 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^스킬 1$/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('실행 기록 6회 · 확인된 연결 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '예약 작업 nightly, 이 흐름의 중심' })).toBeInTheDocument();
  });

  it('종류 칩과 실행 기록은 한 줄에 있고, 그림/목록 탭은 36px 로 낮다(2026-10-17-017 컴팩트)', async () => {
    mount('/flows?root=cron:ma/j1');
    const runs = await screen.findByText('실행 기록 6회 · 확인된 연결 1');
    const group = screen.getByRole('group', { name: '종류로 거르기' });
    expect(runs.parentElement?.parentElement).toBe(group.parentElement);
    const tabs = screen.getByRole('tablist', { name: '보기 방식' }).closest('.MuiTabs-root') as HTMLElement;
    expect(getComputedStyle(tabs).minHeight).toBe('36px');
  });

  it('종류 표시(스·코·M 등)는 그림 노드처럼 종류 색 동그라미다 — 종류 칩·읽는 법·살펴보기 모두', async () => {
    const user = userEvent.setup();
    mount('/flows?root=cron:ma/j1');
    const chip = await screen.findByRole('button', { name: /^스킬 1$/ });
    const mark = (el: Element, kind: string) => el.querySelector(`[data-kind-mark="${kind}"]`) as HTMLElement;
    const skillColor = 'rgb(79, 107, 237)'; // 노드 왼쪽 띠와 같은 #4f6bed
    expect(mark(chip, 'skill')).toHaveAttribute('aria-hidden', 'true');
    expect(getComputedStyle(mark(chip, 'skill')).backgroundColor).toBe(skillColor);
    expect(getComputedStyle(mark(chip, 'skill')).borderRadius).toBe('50%');
    const node = screen.getByRole('button', { name: /^스킬 report/ });
    expect(getComputedStyle(mark(node, 'skill')).backgroundColor).toBe(skillColor);
    await user.click(node);
    const side = sidebar();
    await within(side).findByText('여기서 나가는 연결 2');
    expect(side.querySelectorAll('[data-kind-mark]').length).toBeGreaterThan(1); // 머리와 연결 목록
  });

  it('살펴보기와 그림 사이 세로 선을 끌거나 ←·→ 로 살펴보기 폭을 바꾼다', async () => {
    const user = userEvent.setup();
    localStorage.removeItem('aas.flows.sideWidth');
    mount('/flows?root=cron:ma/j1');
    const bar = await screen.findByRole('separator', { name: '살펴보기 폭 조절' });
    expect(bar).toHaveAttribute('aria-orientation', 'vertical');
    expect(bar).toHaveAttribute('aria-valuenow', '380');
    bar.focus();
    await user.keyboard('{ArrowLeft}');
    expect(bar).toHaveAttribute('aria-valuenow', '412'); // 왼쪽으로 = 살펴보기가 넓어진다
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(bar).toHaveAttribute('aria-valuenow', '348');
    for (let i = 0; i < 10; i++) await user.keyboard('{ArrowRight}');
    expect(bar).toHaveAttribute('aria-valuenow', '300'); // 최소 폭
    // 끌기: 그림 영역 오른쪽 끝에서 포인터까지가 새 폭
    const grid = bar.parentElement as HTMLElement;
    grid.getBoundingClientRect = () => ({ left: 0, right: 1200, width: 1200, top: 0, bottom: 600, height: 600, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(bar, { button: 0, pointerId: 1, clientX: 900 });
    fireEvent.pointerMove(bar, { pointerId: 1, clientX: 700 });
    fireEvent.pointerUp(bar, { pointerId: 1, clientX: 700 });
    expect(bar).toHaveAttribute('aria-valuenow', '500');
    fireEvent.pointerDown(bar, { button: 0, pointerId: 1, clientX: 700 });
    fireEvent.pointerMove(bar, { pointerId: 1, clientX: 100 });
    fireEvent.pointerUp(bar, { pointerId: 1, clientX: 100 });
    expect(bar).toHaveAttribute('aria-valuenow', '880'); // 그림 자리 320px 은 남긴다
  });

  it('처음에는 중심 노드가 선택돼 있고 살펴보기에 메타가 나온다', async () => {
    mount('/flows?root=cron:ma/j1');
    const side = await screen.findByRole('complementary', { name: '살펴보기' });
    expect(within(side).getByText('예약 작업 · 이 흐름의 중심')).toBeInTheDocument();
    expect(within(side).getByText('30 9 * * *')).toBeInTheDocument();
    // 중심 노드는 연결을 종류별 소제목으로 기본 정보보다 먼저 보인다(디자인 D12)
    expect(within(side).queryByText('여기서 나가는 연결 1')).not.toBeInTheDocument();
    const order = within(side).getByRole('button', { name: 'report 연결의 근거 펼치기' });
    expect(order.compareDocumentPosition(within(side).getByText('30 9 * * *')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('종류 칩을 끄면 그 종류가 그림에서 빠진다', async () => {
    const user = userEvent.setup();
    mount('/flows?root=cron:ma/j1');
    await screen.findByRole('button', { name: /^MCP 서버 chart/ });
    await user.click(screen.getByRole('button', { name: /^MCP 서버 1$/ }));
    expect(screen.queryByRole('button', { name: /^MCP 서버 chart/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'MCP 서버 1, 숨김' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('이름만 언급된 것도 를 켜면 mentions=1 로 다시 받는다', async () => {
    const user = userEvent.setup();
    const fn = mount('/flows?root=cron:ma/j1');
    await user.click(await screen.findByRole('checkbox', { name: /이름만 언급된 것도 \(2\)/ }));
    await waitFor(() =>
      expect(
        fn.mock.calls.some((c) => String(c[0]).includes('/api/flow?') && String(c[0]).includes('mentions=1'))
      ).toBe(true)
    );
    expect(screen.getByTestId('loc')).toHaveTextContent('mentions=1');
  });

  it('노드를 누르면 나가는 연결·들어오는 연결과 근거가 나온다', async () => {
    const user = userEvent.setup();
    mount('/flows?root=cron:ma/j1');
    await user.click(await screen.findByRole('button', { name: /^스킬 report/ }));
    const side = sidebar();
    expect(await within(side).findByText('여기서 나가는 연결 2')).toBeInTheDocument();
    expect(within(side).getByText('여기로 들어오는 연결 1')).toBeInTheDocument();
    // 연결 줄은 접혀 있고 꺾쇠로 근거를 편다(디자인 D13)
    expect(within(side).queryByText('SKILL.md:3')).not.toBeInTheDocument();
    const chevron = within(side).getByRole('button', { name: 'run.py 연결의 근거 펼치기' });
    expect(chevron).toHaveAttribute('aria-expanded', 'false');
    await user.click(chevron);
    expect(within(side).getByRole('button', { name: 'run.py 연결의 근거 접기' })).toHaveAttribute('aria-expanded', 'true');
    await user.click(within(side).getByRole('button', { name: 'chart 연결의 근거 펼치기' }));
    expect(within(side).getByText('SKILL.md:3')).toBeInTheDocument();
    expect(within(side).getByText('python run.py')).toBeInTheDocument();
    expect(within(side).getByText('최근 실행 기록에 4회 남아 있습니다', { exact: false })).toBeInTheDocument();
    expect(within(side).getByText('이 스킬 아래에 2개가 더 있습니다.', { exact: false })).toBeInTheDocument();
  });

  it('이것을 중심으로 보기는 그 노드를 root 로 한 주소로 간다', async () => {
    const user = userEvent.setup();
    mount('/flows?tab=skill&root=cron:ma/j1');
    await user.click(await screen.findByRole('button', { name: /^스킬 report/ }));
    await user.click(await within(sidebar()).findByRole('button', { name: '이것을 중심으로 보기' }));
    expect(screen.getByTestId('loc')).toHaveTextContent('/flows?tab=skill&root=skill%3Ama%3Areport'); // 목록 탭은 남는다
  });

  it('크론 노드의 주기 바꾸기 단추는 작업 서랍을 연다', async () => {
    const user = userEvent.setup();
    mount('/flows?root=cron:ma/j1');
    await user.click(
      await within(await screen.findByRole('complementary', { name: '살펴보기' })).findByRole('button', {
        name: '주기 바꾸기 · 켜기/끄기 · 실행',
      })
    );
    expect(await screen.findByRole('dialog', { name: 'nightly' })).toBeInTheDocument();
  });

  it('다른 화면에서 열기 링크와 AI 설명 받기 단추', async () => {
    const user = userEvent.setup();
    mount('/flows?root=cron:ma/j1');
    await user.click(await screen.findByRole('button', { name: /^스크립트 run.py/ }));
    const side = sidebar();
    expect(await within(side).findByRole('link', { name: '도구 화면에서 열기' })).toHaveAttribute(
      'href',
      '/tools?tab=all&q=run.py'
    );
    const popup = watchChatPopup(); // 채팅 화면으로 가지 않고 대화 팝업을 연다(OMAI-1115)
    fireEvent.click(within(side).getByRole('button', { name: 'AI 설명 받기' }));
    expect(popup()).toMatchObject({ kind: 'chat', agent: 'default', text: expect.any(String) });
  });

  it('선을 누르면 연결 패널이 나온다: 관계·확실한 정도·도구', async () => {
    const user = userEvent.setup();
    const { container } = { container: document.body };
    mount('/flows?root=cron:ma/j1');
    await screen.findByRole('button', { name: /^스킬 report/ });
    const hit = container.querySelector('[data-edge="skill:ma:report>mcp:chart"] .fc-hit') as Element;
    await user.click(hit);
    const side = sidebar();
    expect(await within(side).findByText('report → chart')).toBeInTheDocument();
    expect(within(side).getByText('호출한다')).toBeInTheDocument();
    expect(within(side).getByText('실행에서만 보임', { selector: '.MuiChip-label' })).toBeInTheDocument();
    expect(within(side).getByText('render')).toBeInTheDocument();
  });

  it('목록 보기로 바꾸면 view=tree 가 주소에 담기고 트리가 나온다', async () => {
    const user = userEvent.setup();
    mount('/flows?root=cron:ma/j1');
    await user.click(await screen.findByRole('tab', { name: '목록' }));
    expect(screen.getByTestId('loc')).toHaveTextContent('view=tree');
    expect((await screen.findAllByRole('button', { name: /nightly/ })).length).toBeGreaterThan(0);
    await user.click(screen.getAllByRole('button', { name: /report/ })[0]);
    expect(await within(sidebar()).findByRole('heading', { name: 'report' })).toBeInTheDocument();
  });

  it('목록의 한 줄은 점·이름·종류·관계 사이를 띄운다(글자 사이 공백이 아니라 gap)', async () => {
    const user = userEvent.setup();
    mount('/flows?root=cron:ma/j1');
    await user.click(await screen.findByRole('tab', { name: '목록' }));
    const row = (await screen.findAllByRole('button', { name: /nightly/ })).find((b) => b.querySelector('[data-kind-mark]'))!;
    const style = getComputedStyle(row);
    expect(style.display).toMatch(/flex/);
    expect(parseFloat(style.columnGap)).toBeGreaterThanOrEqual(8);
    expect(parseFloat(style.paddingLeft)).toBeGreaterThan(0);
  });

  it('읽지 못하면 오류와 시작점 목록으로 돌아가는 단추', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: '그래프를 못 읽음' }), { status: 500 })))
    );
    mountScreen(<Flows />, '/flows?root=cron:x/y');
    expect(await screen.findByRole('alert')).toHaveTextContent('그래프를 못 읽음');
    expect(screen.getByRole('button', { name: '시작점 목록으로' })).toBeInTheDocument();
  });
});

// 스펙 2026-10-28-013: 중심 스킬 패널의 「외부 호스트 N」(디자인 D5·D12, 재검토 D3), 라이브러리 칩(D10), 실행 기록(D9), AAS 기본(D11)
const SKILL_GRAPH = (over = {}) => ({
  root: 'skill:main:p5',
  nodes: [
    n('skill:main:p5', 'skill', 'p5js', { profile: 'main', meta: { 경로: 'skills/p5' }, path: 'skills/p5/SKILL.md' }),
    n('script:export.js', 'script', 'export-frames.js', { depth: 1, sub: 'JavaScript · 스킬 내부 스크립트' }),
    n('script:setup.sh', 'script', 'setup.sh', { depth: 1 }),
    n('host:cdn', 'host', 'cdn.jsdelivr.net', { depth: 1, sub: '외부 호스트' }),
    n('host:nodejs', 'host', 'nodejs.org', { depth: 2, sub: '외부 호스트' }),
    n('host:p5org', 'host', 'p5js.org', { depth: 1, sub: '외부 호스트' }),
    n('lib:puppeteer', 'lib', 'puppeteer', { depth: 2, sub: 'Node 패키지 · 설치 확인 안 함' }),
    n('lib:yamlx', 'lib', 'yamlx', { depth: 2, status: 'warn', badges: ['설치 목록에 없음'] }),
  ],
  edges: [
    { from: 'skill:main:p5', to: 'script:export.js', kind: 'runs', conf: 'doc', meta: {}, evidence: [] },
    { from: 'skill:main:p5', to: 'script:setup.sh', kind: 'runs', conf: 'doc', meta: {}, evidence: [] },
    { from: 'skill:main:p5', to: 'host:cdn', kind: 'calls', conf: 'doc', meta: {}, evidence: [] },
    { from: 'skill:main:p5', to: 'host:p5org', kind: 'calls', conf: 'mention', meta: {}, evidence: [] },
    { from: 'script:setup.sh', to: 'host:nodejs', kind: 'calls', conf: 'code', meta: {}, evidence: [] },
    { from: 'script:export.js', to: 'lib:puppeteer', kind: 'imports', conf: 'code', meta: {}, evidence: [] },
    { from: 'script:export.js', to: 'lib:yamlx', kind: 'imports', conf: 'code', meta: {}, evidence: [] },
  ],
  observed: { days: 14, scope: '이 프로파일', runs: 10, matched: 1 },
  root_hosts: 2,
  ...over,
});

describe('Flows: 스킬 연결도 정리 (2026-10-28-013)', () => {
  it('중심 스킬 패널은 「외부 호스트 N」을 기본 정보보다 먼저, 스크립트를 거친 호스트까지 보인다(이름만 언급은 수에서 뺀다)', async () => {
    mount('/flows?root=skill:main:p5', SKILL_GRAPH());
    const side = await screen.findByRole('complementary', { name: '살펴보기' });
    const head = within(side).getByRole('heading', { name: /^외부 호스트/ });
    expect(head).toHaveTextContent('외부 호스트2');
    expect(within(side).getByText('setup.sh 에서')).toBeInTheDocument();
    expect(within(side).getByRole('button', { name: 'p5js.org 연결의 근거 펼치기' })).toBeInTheDocument();
    expect(head.compareDocumentPosition(within(side).getByText('skills/p5')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(side).queryByText(/그림에는/)).not.toBeInTheDocument();
  });

  it('그림이 잘려 그려진 호스트가 서버 수보다 적으면 「그림에는 M개만」을 덧붙인다', async () => {
    mount('/flows?root=skill:main:p5', SKILL_GRAPH({ root_hosts: 5, truncated: true }));
    const side = await screen.findByRole('complementary', { name: '살펴보기' });
    expect(within(side).getByRole('heading', { name: /^외부 호스트/ })).toHaveTextContent('외부 호스트5');
    expect(within(side).getByText('그림에는 2개만 있습니다(그림이 커서 잘렸습니다).')).toBeInTheDocument();
  });

  it('라이브러리는 처음에 숨기고 칩에 경고 수를 호박색 글자로, 접근 이름에 경고·숨김을 넣는다', async () => {
    const user = userEvent.setup();
    mount('/flows?root=skill:main:p5', SKILL_GRAPH());
    const chip = await screen.findByRole('button', { name: '라이브러리 2, 경고 1, 숨김' });
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    expect(within(chip).getByText('· 경고 1')).toHaveStyle({ color: 'rgb(245, 158, 11)' });
    expect(screen.queryByRole('button', { name: /^라이브러리 puppeteer/ })).not.toBeInTheDocument();
    await user.click(chip);
    expect(await screen.findByRole('button', { name: /^라이브러리 puppeteer/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '라이브러리 2, 경고 1' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('실행 기록 줄은 못 읽음·서버 안내도 같은 자리에 보이고, 도움말 단추(포커스 가능한 버튼)가 설명 풍선말을 연다', async () => {
    const user = userEvent.setup();
    mount('/flows?root=skill:main:p5', SKILL_GRAPH({ observed: { error: 'x', runs: 0, matched: 0 } }));
    expect(await screen.findByText('실행 기록을 읽지 못했습니다.')).toBeInTheDocument();
    await user.hover(screen.getByRole('button', { name: '실행 기록 설명' }));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('도구 이름, 스킬 이름, 스크립트 경로만 읽어');
    cleanup();
    mount('/flows?root=skill:main:p5', SKILL_GRAPH({ observed: { hint: '이 프로파일은 실행 기록이 없습니다', runs: 0, matched: 0 } }));
    expect(await screen.findByText('이 프로파일은 실행 기록이 없습니다')).toBeInTheDocument();
  });
});

describe('Flows: 코드 창', () => {
  const openCode = async () => {
    const user = userEvent.setup();
    const fn = mount('/flows?root=cron:ma/j1');
    await user.click(await screen.findByRole('button', { name: /^스킬 report/ }));
    await user.click(await within(sidebar()).findByRole('button', { name: 'run.py 연결의 근거 펼치기' }));
    await user.click(await within(sidebar()).findByRole('button', { name: /SKILL.md:3/ }));
    return { user, fn };
  };

  it('근거 줄을 누르면 파일을 읽어 코드를 보이고 근거 줄을 표시한다', async () => {
    const { fn } = await openCode();
    const side = sidebar();
    expect((await within(side).findByRole('textbox', { name: 'SKILL.md 코드' }) as HTMLTextAreaElement).value).toContain('python run.py');
    expect(String(fn.mock.calls.find((c) => String(c[0]).startsWith('/api/file?'))![0])).toContain(
      'path=skills%2Freport%2FSKILL.md'
    );
    expect(within(side).getByText('4줄 · 수정 2026-10-01 00:00')).toBeInTheDocument();
    expect(within(side).getByRole('button', { name: '3' })).toBeInTheDocument(); // 근거 줄 바로가기
    // 고치기는 위(경로 줄 오른쪽 끝)와 아래(편집기 밑) 두 곳에 있다(2026-10-17-025)
    const edits = within(side).getAllByRole('button', { name: '고치기' });
    expect(edits).toHaveLength(2);
    expect(edits[0].parentElement).toBe(within(side).getByRole('button', { name: '경로 복사' }).parentElement);
    expect(within(side).getByRole('button', { name: '이전 버전 1' })).toBeInTheDocument();
  });

  it('고치기 전 보기도 고칠 때와 같은 편집기를 읽기 전용으로 보이고, 근거 줄을 칠해 그 줄로 옮긴다(2026-10-17-022)', async () => {
    const { user } = await openCode();
    const side = sidebar();
    const view = await within(side).findByRole('textbox', { name: 'SKILL.md 코드' });
    expect(view).toHaveAttribute('readonly');
    expect(view).toHaveValue('# report\n설명\npython run.py\n끝');
    expect(view).toHaveAttribute('data-marks', '3');
    expect(view).toHaveAttribute('data-focus-line', '3');
    expect(within(side).queryByRole('list', { name: 'SKILL.md 코드' })).not.toBeInTheDocument();
    await user.click(within(side).getByRole('button', { name: '3' }));
    expect(view).toHaveAttribute('data-focus-line', '3');
  });

  it('같은 폴더의 다른 파일을 고를 수 있다', async () => {
    const { user, fn } = await openCode();
    const sel = await within(sidebar()).findByRole('combobox', { name: '같은 폴더의 파일' });
    await user.selectOptions(sel, 'skills/report/run.py');
    await waitFor(() =>
      expect(fn.mock.calls.some((c) => String(c[0]).includes('path=skills%2Freport%2Frun.py'))).toBe(true)
    );
  });

  it('고치기 → 저장은 preview 검사 뒤 /api/file/save 로 간다', async () => {
    const { user, fn } = await openCode();
    await user.click((await within(sidebar()).findAllByRole('button', { name: '고치기' }))[0]); // 위쪽 단추로도 고친다
    await user.type(await screen.findByRole('textbox', { name: /SKILL.md 고치기/ }), '!');
    await user.click(screen.getByRole('button', { name: /바뀐 줄 확인/ }));
    await user.click(await screen.findByRole('button', { name: '이대로 저장' }));
    await waitFor(() =>
      expect(postedTo(fn, '/api/file/save')).toEqual([
        { path: 'skills/report/SKILL.md', content: '# report\n설명\npython run.py\n끝!', base_sha: 'f1', note: '' },
      ])
    );
    expect(postedTo(fn, '/api/file/preview')[0]).toMatchObject({ path: 'skills/report/SKILL.md' });
  });

  // 스펙 2026-10-28-014 D6: 묻는 동안 그림이 바뀐 주소(mentions 없음)로 다시 받느라 사라져 고치던 코드가 없어졌다(OKE 2026-10-29 프로파일과 같은 결함)
  it('코드를 고치는 중에 뒤로 가기를 눌러 묻는 창에서 취소하면 편집기와 고친 글이 그대로다', async () => {
    const user = userEvent.setup();
    mount('/flows?tab=cron', GRAPH(), FILE(), true);
    await user.click(await rowByName(/nightly/));
    await user.click(await screen.findByRole('checkbox', { name: /이름만 언급된 것도 \(2\)/ }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/flows\?tab=cron&root=cron%3Ama%2Fj1&mentions=1$/));
    // mentions=1 이 든 링크로 들어온 것처럼 mentions 없는 그림은 아직 받지 않은 상태로 둔다
    lastQc.removeQueries({ queryKey: ['flow', 'cron:ma/j1', false] });
    await user.click(await screen.findByRole('button', { name: /^스킬 report/ }));
    await user.click(await within(sidebar()).findByRole('button', { name: 'run.py 연결의 근거 펼치기' }));
    await user.click(await within(sidebar()).findByRole('button', { name: /SKILL.md:3/ }));
    await user.click((await within(sidebar()).findAllByRole('button', { name: '고치기' }))[0]);
    await user.type(await screen.findByRole('textbox', { name: /SKILL.md 고치기/ }), '!');
    fireEvent.click(screen.getByRole('button', { name: '뒤로 가기', hidden: true }));
    expect(await screen.findByText('저장하지 않은 수정이 있습니다. 버리고 넘어갈까요?')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: '취소' }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('mentions=1'));
    expect(await screen.findByRole('textbox', { name: /SKILL.md 고치기/ })).toHaveValue('# report\n설명\npython run.py\n끝!');
  });

  it('고칠 수 없는 파일은 이유를 보인다', async () => {
    const user = userEvent.setup();
    mount(
      '/flows?root=cron:ma/j1',
      GRAPH(),
      FILE({ editable: false, why_not: '관리자만 고칠 수 있습니다', versions: 0 })
    );
    await user.click(await screen.findByRole('button', { name: /^스킬 report/ }));
    await user.click(await within(sidebar()).findByRole('button', { name: 'run.py 연결의 근거 펼치기' }));
    await user.click(await within(sidebar()).findByRole('button', { name: /SKILL.md:3/ }));
    expect(await within(sidebar()).findByText('관리자만 고칠 수 있습니다')).toBeInTheDocument();
    expect(within(sidebar()).queryByRole('button', { name: '고치기' })).not.toBeInTheDocument();
  });
});

describe('Flows: 태그(OMAI-1283)', () => {
  const TAGGED_SKILLS = {
    totals: { skills: 2 },
    skills: [
      { ...SKILLS.skills[0], tags: ['dev-workflow', 'docs'] },
      { id: 'ops:sweep', name: 'sweep', description: '청소', profile: 'ops', n_cron: 0, n_scripts: 0, n_mcp: 0, n_rest: 0, tags: ['automation'] },
    ],
  };
  const mountTagged = (initial: string, skills: unknown = TAGGED_SKILLS) => {
    stubApi({ '/api/flows': STARTS, '/api/skills': skills });
    mountScreen(<Flows />, initial);
  };

  it('스킬에서 탭: 「태그」 열과 칩 줄(개수 포함)이 보이고 태그를 켜면 그 스킬만 남는다. 주소에 담긴다', async () => {
    const user = userEvent.setup();
    mountTagged('/flows');
    await screen.findByText('report');
    expect(screen.getByRole('columnheader', { name: '태그' })).toBeInTheDocument();
    const grp = screen.getByRole('group', { name: '태그로 거르기' });
    expect(within(grp).getByRole('button', { name: /^전체\s*2$/ })).toBeInTheDocument();
    await user.click(within(grp).getByRole('button', { name: /^자동화·도구/ }));
    expect(screen.queryByText('report')).not.toBeInTheDocument();
    expect(screen.getByText('sweep')).toBeInTheDocument();
    expect(screen.getByTestId('loc')).toHaveTextContent('tag=automation');
  });

  it('크론 작업에서 탭: 그 작업이 부르는 스킬의 태그를 보이고 같은 칩으로 거른다', async () => {
    const user = userEvent.setup();
    mountTagged('/flows?tab=cron');
    const row = await rowByName(/nightly/);
    expect(within(row).getByText('개발 절차')).toBeInTheDocument();        // nightly 는 report(ma)를 부른다
    const grp = screen.getByRole('group', { name: '태그로 거르기' });
    expect(within(grp).getByRole('button', { name: /^전체\s*2$/ })).toBeInTheDocument();
    expect(within(grp).queryByRole('button', { name: /^자동화·도구/ })).not.toBeInTheDocument();   // 이 탭의 작업이 가진 태그만 칩이 된다
    await user.click(within(grp).getByRole('button', { name: /^문서·글쓰기/ }));
    expect(screen.getByText('nightly')).toBeInTheDocument();
    expect(screen.queryByText('cleanup')).not.toBeInTheDocument();         // cleanup 은 부르는 스킬이 없다
  });

  it('주소 ?tag= 는 탭에 없는 태그면 그 탭에서는 무시한다', async () => {
    mountTagged('/flows?tab=cron&tag=automation');
    expect(await screen.findByText('nightly')).toBeInTheDocument();
    expect(screen.getByText('cleanup')).toBeInTheDocument();
  });

  it('태그가 하나도 없으면 열도 칩 줄도 없다', async () => {
    mountTagged('/flows', SKILLS);
    await screen.findByText('report');
    expect(screen.queryByRole('columnheader', { name: '태그' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '태그로 거르기' })).not.toBeInTheDocument();
  });
});
