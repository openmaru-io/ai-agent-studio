/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 칸반 접은 칸(OMAI-1163, 계획 2026-10-14-020): 기본은 다섯 칸, 분류 대기·예약·준비는 접은 줄에서 「더 보기」로 연다.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLang } from '@/i18n';
import { ME_USER, mountScreen, postedTo, stubApi } from '@/test/mountScreen';
import { pickAgent } from '@/test/pickAgent';

import type { Seat } from './forms';
import { blockReason, FOLDED_COLUMNS, Kanban, latestRunIndex, readFolded, runOutcomeLabel } from './Kanban';

const card = (id: string, status: string, over: object = {}) => ({ id, title: `카드 ${id}`, assignee: 'sa', status, ...over });
const NAMES = ['triage', 'todo', 'scheduled', 'ready', 'running', 'blocked', 'review', 'done', 'archived'];
const board = (extra: { name: string; tasks: object[] }[] = [], tasks: Record<string, object[]> = {}) => ({
  columns: [
    ...NAMES.map((name) => ({ name, tasks: tasks[name] ?? [] })),
    ...extra,
  ],
});
const SEATS = [{ alias: 'sa', pod: 'kim', profile: 'sa', enabled: true, title: '', role: '', team: '', note: '' }] as Seat[];

function mount(view: unknown, create?: (url: string, body: Record<string, unknown>) => unknown) {
  const fn = stubApi({
    '/api/office/kanban/boards': { boards: [{ slug: 'b1', name: '보드', total: 3, archived: false }] },
    '/api/office/kanban/board': view,
    '/api/office/kanban/tasks': create ?? { task: { status: 'ready' } },
  });
  mountScreen(<Kanban seats={SEATS} canAct />, '/office?tab=kanban');
  return fn;
}
const sections = () => screen.queryAllByRole('region').map((s) => s.getAttribute('aria-label'));

const SAMPLE = board([], { triage: [card('t1', 'triage')], ready: [card('r1', 'ready'), card('r2', 'ready')], running: [card('x1', 'running')] });

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe('칸반 접은 칸', () => {
  it('기본은 다섯 칸만 그리고, 접은 줄에 숨긴 칸의 카드 수를 보인다', async () => {
    mount(SAMPLE);
    await screen.findByRole('group', { name: '접은 칸' });
    expect(sections()).toEqual(['할 일', '진행 중', '막힘', '검토', '완료']);
    const strip = screen.getByRole('group', { name: '접은 칸' });
    expect(within(strip).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['분류 대기 1', '예약 0', '준비 2']);
    expect(screen.queryByText('보관 1')).not.toBeInTheDocument();
  });

  it('「더 보기」를 누르면 여덟 칸이 서버 순서로 나오고 값이 저장되며, 「세 칸 접기」로 되돌린다', async () => {
    mount(SAMPLE);
    await userEvent.click(await screen.findByRole('button', { name: /접은 칸 3개 보기/ }));
    expect(sections()).toEqual(['분류 대기', '할 일', '예약', '준비', '진행 중', '막힘', '검토', '완료']);
    expect(localStorage.getItem('aas.kanban.folded')).toBe('0');
    expect(within(screen.getByRole('group', { name: '접은 칸' })).queryAllByRole('listitem')).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: '세 칸 접기' }));
    expect(sections()).toEqual(['할 일', '진행 중', '막힘', '검토', '완료']);
    expect(localStorage.getItem('aas.kanban.folded')).toBeNull();
  });

  it('저장값이 「0」이면 펼친 채 시작하고, 없으면 접힌 채 시작한다', async () => {
    expect(readFolded()).toBe(true);
    localStorage.setItem('aas.kanban.folded', '0');
    expect(readFolded()).toBe(false);
    mount(SAMPLE);
    await screen.findByRole('button', { name: '세 칸 접기' });
    expect(sections()).toHaveLength(8);
  });

  it('저장소를 읽고 쓰지 못해도 접힌 채 동작하고 오류가 나지 않는다', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      mount(SAMPLE);
      expect(readFolded()).toBe(true);
      await userEvent.click(await screen.findByRole('button', { name: /접은 칸 3개 보기/ }));
      expect(sections()).toHaveLength(8);
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });

  it('서버가 모르는 칸을 주면 접지 않고 보이고, 보관 칸은 계속 뺀다', async () => {
    mount(board([{ name: 'waiting', tasks: [card('w1', 'waiting')] }], { archived: [card('a1', 'archived')] }));
    await screen.findByRole('group', { name: '접은 칸' });
    expect(sections()).toEqual(['할 일', '진행 중', '막힘', '검토', '완료', 'waiting']);
    expect(FOLDED_COLUMNS).toEqual(['triage', 'scheduled', 'ready']);
    expect(screen.queryByText('카드 a1')).not.toBeInTheDocument();
  });

  it('분류 대기에 카드가 있으면 그 숫자만 앰버(경고)이고, 없으면 아니다', async () => {
    mount(SAMPLE);
    const strip = await screen.findByRole('group', { name: '접은 칸' });
    const item = (name: string) => within(strip).getAllByRole('listitem').find((li) => li.textContent?.startsWith(name)) as HTMLElement;
    expect(item('분류 대기')).toHaveAttribute('data-tone', 'warn');
    expect(item('분류 대기').querySelector('b')).toHaveStyle({ color: '#f59e0b' });
    expect(item('준비')).not.toHaveAttribute('data-tone');
    expect(item('예약')).not.toHaveAttribute('data-tone');
  });

  it('접근성: 단추가 보드 영역을 제어하고, 접힌 이름에 숨긴 칸과 수가 들어 있다', async () => {
    mount(SAMPLE);
    const btn = await screen.findByRole('button', { name: '접은 칸 3개 보기: 분류 대기 1, 예약 0, 준비 2' });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    const target = document.getElementById(btn.getAttribute('aria-controls') as string);
    expect(target).not.toBeNull();
    expect(target).toContainElement(screen.getAllByRole('region')[0]);
    await userEvent.click(btn);
    expect(screen.getByRole('button', { name: '세 칸 접기' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('카드를 만들면 어느 칸인지 알리고, 접힌 칸이면 「더 보기」를 안내한다', async () => {
    const create = async (status?: string) => {
      const fn = mount(SAMPLE, () => (status ? { task: { status } } : {}));
      await userEvent.click(await screen.findByRole('button', { name: '카드 추가' }));
      await userEvent.type(await screen.findByLabelText('제목'), '새 일');
      await userEvent.click(screen.getByRole('button', { name: '자유 입력' })); // 기본은 항목별 입력이라 제목만 쓰는 흐름은 자유 입력에서 한다(스펙 2026-10-18-002 R3)
      await pickAgent(userEvent.setup(), screen.getByRole('combobox', { name: '담당' }), /^sa/);
      await userEvent.click(screen.getByRole('button', { name: '만들기' }));
      return fn;
    };
    await create('ready');
    expect(await screen.findByText('카드 「새 일」 을(를) 만들었습니다 (준비 칸). 위의 「더 보기」로 볼 수 있습니다')).toBeInTheDocument();
  });

  it('펼친 상태에서 만들면 「더 보기」 안내 없이 칸 이름만, 응답에 상태가 없으면 지금 문구', async () => {
    localStorage.setItem('aas.kanban.folded', '0');
    mount(SAMPLE, () => ({ task: { status: 'ready' } }));
    await userEvent.click(await screen.findByRole('button', { name: '카드 추가' }));
    await userEvent.type(await screen.findByLabelText('제목'), '새 일');
    await userEvent.click(screen.getByRole('button', { name: '자유 입력' })); // 기본은 항목별 입력이라 제목만 쓰는 흐름은 자유 입력에서 한다(스펙 2026-10-18-002 R3)
    await userEvent.click(screen.getByRole('button', { name: '만들기' }));
    expect(await screen.findByText('카드 「새 일」 을(를) 만들었습니다 (준비 칸)')).toBeInTheDocument();
    expect(screen.queryByText(/더 보기/)).not.toBeInTheDocument();
  });

  it('응답에 상태가 없으면 지금 문구를 그대로 쓴다', async () => {
    mount(SAMPLE, () => ({}));
    await userEvent.click(await screen.findByRole('button', { name: '카드 추가' }));
    await userEvent.type(await screen.findByLabelText('제목'), '새 일');
    await userEvent.click(screen.getByRole('button', { name: '자유 입력' })); // 기본은 항목별 입력이라 제목만 쓰는 흐름은 자유 입력에서 한다(스펙 2026-10-18-002 R3)
    await userEvent.click(screen.getByRole('button', { name: '만들기' }));
    await waitFor(() => expect(screen.getByText('카드 「새 일」 을(를) 만들었습니다')).toBeInTheDocument());
  });
});

describe('칸반을 바로 쓰는 기본값(OMAI-1286)', () => {
  const setup = (o: { view?: unknown; mySeat?: string; user?: boolean; boards?: object[] } = {}) => {
    const fn = stubApi({
      ...(o.user ? { '/api/me': ME_USER } : {}),
      '/api/office/kanban/boards': { boards: o.boards ?? [{ slug: 'b1', name: '보드', total: 3, archived: false }] },
      '/api/office/kanban/board': o.view ?? SAMPLE,
      '/api/office/kanban/tasks': { task: { status: 'ready' } },
    });
    mountScreen(<Kanban seats={SEATS} canAct mySeat={o.mySeat} />, '/office?tab=kanban');
    return fn;
  };
  const addCard = async (title: string) => {
    await userEvent.click(await screen.findByRole('button', { name: '카드 추가' }));
    await userEvent.type(await screen.findByLabelText('제목'), title);
    await userEvent.click(screen.getByRole('button', { name: '자유 입력' })); // 기본은 항목별 입력이라 제목만 쓰는 흐름은 자유 입력에서 한다(스펙 2026-10-18-002 R3)
  };

  it('카드 추가의 담당은 내 자리로 미리 골라져 있다', async () => {
    const fn = setup({ mySeat: 'sa' });
    await addCard('새 일');
    await userEvent.click(screen.getByRole('button', { name: '만들기' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/kanban/tasks')[0]?.assignee).toBe('sa'));
  });

  it('내 자리가 없으면 담당은 비어 있다(관리자는 담당 없이 만들 수 있다)', async () => {
    const fn = setup();
    await addCard('새 일');
    expect(screen.getByText('담당이 없으면 분류 대기 칸에 들어가 실행되지 않습니다. 실행하려면 담당을 고르세요.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '만들기' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/kanban/tasks')).toHaveLength(1));
    expect(postedTo(fn, '/api/office/kanban/tasks')[0].assignee).toBeUndefined();
  });

  it('일반 사용자는 담당을 고르기 전에는 만들 수 없다', async () => {
    setup({ user: true });
    await addCard('새 일');
    expect(screen.getByRole('button', { name: '만들기' })).toBeDisabled();
    await pickAgent(userEvent.setup(), screen.getByRole('combobox', { name: '담당' }), /^sa/);
    expect(screen.getByRole('button', { name: '만들기' })).toBeEnabled();
  });

  it('보드가 없으면 일반 사용자에게는 관리자에게 요청하라고 안내하고 「새 보드」가 없다', async () => {
    setup({ user: true, boards: [] });
    expect(await screen.findByText('보드가 없습니다. 관리자에게 보드를 만들어 달라고 요청하세요.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '새 보드' })).not.toBeInTheDocument();
  });

  it('보드가 없으면 관리자에게는 지금 안내와 「새 보드」를 보인다', async () => {
    setup({ boards: [] });
    expect(await screen.findByRole('button', { name: '새 보드' })).toBeInTheDocument();
    expect(screen.getByText(/아직 보드가 없습니다/)).toBeInTheDocument();
  });

  it('카드가 하나도 없는 보드에는 첫 카드 안내를 보인다', async () => {
    setup({ view: board() });
    expect(await screen.findByText('제목과 할 일을 적어 카드를 만들면 담당 AI 에이전트가 20초 안에 시작합니다.')).toBeInTheDocument();
  });

  it('카드가 있으면 첫 카드 안내가 없다', async () => {
    setup();
    await screen.findByRole('group', { name: '접은 칸' });
    expect(screen.queryByText(/20초 안에 시작합니다/)).not.toBeInTheDocument();
  });
});

describe('칸반 모양(OMAI-1168)', () => {
  const dot = (label: string) => screen.getByRole('region', { name: label }).firstElementChild as HTMLElement;

  it('칸의 점은 실행 중만 초록, 막힘만 앰버, 나머지는 무채색이고 실행 중 카드가 있을 때만 맥박친다', async () => {
    mount(SAMPLE);
    await screen.findByRole('group', { name: '접은 칸' });
    expect(dot('진행 중')).toHaveStyle({ backgroundColor: '#27a644' });
    expect(screen.getByRole('region', { name: '진행 중' })).toHaveAttribute('data-live');
    expect(dot('막힘')).toHaveStyle({ backgroundColor: '#f59e0b' });
    expect(screen.getByRole('region', { name: '막힘' })).not.toHaveAttribute('data-live');
    for (const name of ['할 일', '검토', '완료']) {
      expect(dot(name)).not.toHaveStyle({ backgroundColor: '#27a644' });
      expect(dot(name)).not.toHaveStyle({ backgroundColor: '#f59e0b' });
    }
  });

  it('실행 중 카드가 없으면 초록 점이어도 맥박치지 않는다', async () => {
    mount(board([], { review: [card('r1', 'review')] }));
    await screen.findByRole('group', { name: '접은 칸' });
    expect(screen.getByRole('region', { name: '진행 중' })).not.toHaveAttribute('data-live');
  });

  it('빈 칸은 「카드 없음」 자리를 보이고, 카드가 있는 칸은 보이지 않는다', async () => {
    mount(SAMPLE);
    await screen.findByRole('group', { name: '접은 칸' });
    expect(within(screen.getByRole('region', { name: '할 일' })).getByText('카드 없음')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: '진행 중' })).queryByText('카드 없음')).not.toBeInTheDocument();
  });

  it('카드는 제목·담당 이니셜과 이름, 우선순위·댓글 수를 보이고 담당이 없으면 앰버 「담당 없음」을 보인다', async () => {
    mount(
      board([], {
        running: [card('x1', 'running', { priority: 3, comment_count: 2 })],
        review: [card('x2', 'review', { assignee: null })],
      })
    );
    const running = await screen.findByRole('region', { name: '진행 중' });
    expect(within(running).getByText('카드 x1')).toBeInTheDocument();
    // 담당은 「● 이름」 칩이다(이니셜 상자를 없앴다)
    expect(within(running).queryByText('S')).not.toBeInTheDocument();
    expect(within(running).getByText('sa').closest('[data-agent-chip]')).not.toBeNull();
    expect(within(running).getByText('우선 3')).toBeInTheDocument();
    expect(within(running).getByLabelText('댓글 2')).toBeInTheDocument();
    const none = within(screen.getByRole('region', { name: '검토' })).getByText('담당 없음');
    expect(none).toHaveStyle({ color: '#f59e0b' });
  });

  it('우선순위 0·댓글 0 은 아무것도 보이지 않는다', async () => {
    mount(board([], { running: [card('x1', 'running', { priority: 0, comment_count: 0 })] }));
    const running = await screen.findByRole('region', { name: '진행 중' });
    expect(within(running).queryByText(/우선/)).not.toBeInTheDocument();
    expect(within(running).queryByLabelText(/댓글/)).not.toBeInTheDocument();
  });

  it('카드를 누르면 서랍이 열린다', async () => {
    mount(SAMPLE, (url) => (url.includes('/tasks/x1') ? { task: card('x1', 'running'), comments: [], runs: [] } : {}));
    await userEvent.click(await screen.findByText('카드 x1'));
    expect(await screen.findByRole('dialog', { name: '카드 x1' })).toBeInTheDocument();
  });
});

describe('카드의 담당은 에이전트 이름으로 보인다(스펙 2026-10-18-012)', () => {
  const NAMED = [{ ...SEATS[0], alias: 'aas-agent-kim', label: 'AAS 관리자' }] as Seat[];
  const mountNamed = () => {
    stubApi({
      '/api/office/kanban/boards': { boards: [{ slug: 'b1', name: '보드', total: 1, archived: false }] },
      '/api/office/kanban/board': board([], { running: [card('x1', 'running', { assignee: 'aas-agent-kim' }), card('x2', 'running', { assignee: 'gone' })] }),
      '/api/office/kanban/tasks/x1': {
        task: card('x1', 'running', { assignee: 'aas-agent-kim' }),
        comments: [
          { id: 1, author: 'aas-agent-kim', body: '## 진행 상황 보고\n\n**현재 상태:** 막힘\n\n- 첫째\n- 둘째', created_at: 1791965600 },
          { id: 2, author: 'aas', body: '사람 메모', created_at: 1791965601 },
        ],
        runs: [{ id: 1, profile: 'aas-agent-kim', status: 'blocked', outcome: 'blocked', started_at: 1791965600 }],
        attachments: [],
      },
    });
    mountScreen(<Kanban seats={NAMED} canAct />, '/office?tab=kanban');
  };

  it('카드 칩에 이름을 보이고 별칭은 풍선말에 둔다. 자리가 없는 담당은 별칭 그대로', async () => {
    mountNamed();
    const running = await screen.findByRole('region', { name: '진행 중' });
    expect(within(running).getByText('AAS 관리자').closest('[title]')).toHaveAttribute('title', 'aas-agent-kim');
    expect(within(running).queryByText('aas-agent-kim')).toBeNull();
    expect(within(running).getByText('gone')).toBeInTheDocument();
  });

  it('카드 서랍의 부제와 담당 행도 이름이다', async () => {
    mountNamed();
    await userEvent.click(await screen.findByText('카드 x1'));
    const dlg = await screen.findByRole('dialog', { name: '카드 x1' });
    expect(dlg).toHaveTextContent('AAS 관리자');
    expect(dlg).not.toHaveTextContent('aas-agent-kim');
  });

  it('댓글 작성자와 실행 기록의 이름·상태는 기본 정보 표처럼 칩이고, 자리가 아닌 작성자는 글자 그대로', async () => {
    mountNamed();
    await userEvent.click(await screen.findByText('카드 x1'));
    const dlg = await screen.findByRole('dialog', { name: '카드 x1' });
    const comments = (await within(dlg).findByText('댓글 2')).parentElement!;
    expect(within(comments).getByText('AAS 관리자').closest('[title]')).toHaveAttribute('title', 'aas-agent-kim');
    expect(within(comments).getByText('aas').closest('.MuiChip-root')).toBeNull();
    const runs = within(dlg).getByText('실행 기록 1').parentElement!;
    expect(within(runs).getByText('AAS 관리자').closest('[title]')).toHaveAttribute('title', 'aas-agent-kim');
    expect(within(runs).getByText('막힘').closest('.MuiChip-root')).not.toBeNull();
    expect(dlg).not.toHaveTextContent('aas-agent-kim');
  });

  it('댓글 본문은 마크다운으로 그린다', async () => {
    mountNamed();
    await userEvent.click(await screen.findByText('카드 x1'));
    const dlg = await screen.findByRole('dialog', { name: '카드 x1' });
    expect(await within(dlg).findByRole('heading', { name: '진행 상황 보고' })).toBeInTheDocument();
    expect(within(dlg).getByText('현재 상태:').tagName).toBe('STRONG');
    expect(within(dlg).getByText('첫째').tagName).toBe('LI');
    expect(dlg).not.toHaveTextContent('## 진행');
  });
});

const NO_COMMANDS = { run_id: 1, state: 'none', read_mode: 'ro', commands: [], more: false };

describe('카드 서랍의 막힘 사유(OMAI-1172)', () => {
  const run = (over: object = {}) => ({ id: 1, profile: 'sa', status: 'blocked', outcome: 'blocked', started_at: 1791965600, summary: null, error: null, ...over });
  const open = async (status: 'blocked' | 'review' | 'triage', runs: object[]) => {
    mount(board([], { [status]: [card('b1', status)] }), (url) =>
      // 최근 실행의 「실행한 명령」은 서랍을 열 때 따로 읽는다(스펙 2026-11-03-001 DD1) — 빈 목록으로 답한다
      url.includes('/commands') ? NO_COMMANDS : url.includes('/tasks/b1') ? { task: card('b1', status), comments: [], runs } : {}
    );
    if (status === 'triage') await userEvent.click(await screen.findByRole('button', { name: /접은 칸 3개 보기/ })); // 분류 대기 칸은 기본으로 접혀 있다
    await userEvent.click(await screen.findByText('카드 b1'));
    return screen.findByRole('dialog', { name: '카드 b1' });
  };

  it('막힌 카드는 서랍 위쪽 경고 상자에 최근 실행의 사유를 보인다', async () => {
    const dlg = await open('blocked', [run({ summary: '작업 본문(body)이 null 이고 작업 공간이 비어 있음' })]);
    const box = await within(dlg).findByRole('status');
    expect(box).toHaveTextContent('막힌 사유');
    expect(box).toHaveTextContent('작업 본문(body)이 null 이고 작업 공간이 비어 있음');
  });

  it('실행 기록 줄은 Hermes 상태 값(running·blocked)을 화면 언어의 이름으로 보인다', async () => {
    const dlg = await open('review', [run({ id: 1, status: 'running', outcome: null }), run({ id: 2, status: 'blocked', outcome: 'blocked', started_at: 1791965700 })]);
    const runs = (await within(dlg).findByText('실행 기록 2')).parentElement!;
    expect(within(runs).getByText('진행 중').closest('.MuiChip-root')).not.toBeNull();
    expect(within(runs).getByText('막힘').closest('.MuiChip-root')).not.toBeNull();
    expect(within(runs).queryByText(/^(running|blocked)$/)).toBeNull();
  });

  it('사유가 상자와 실행 기록에 두 번 나오지 않는다', async () => {
    const dlg = await open('blocked', [run({ summary: '범위를 알려 주세요' })]);
    await within(dlg).findByRole('status');
    expect(within(dlg).getAllByText('범위를 알려 주세요')).toHaveLength(1);
  });

  it('요약이 없고 오류만 있으면 오류를 사유로 보인다', async () => {
    const dlg = await open('blocked', [run({ error: 'worker exited 137' })]);
    expect(await within(dlg).findByRole('status')).toHaveTextContent('worker exited 137');
  });

  it('실행이 여럿이면 가장 최근(시작 시각이 큰) 실행의 사유가 상자에, 앞선 실행의 요약은 기록 줄 아래에 보인다', async () => {
    const dlg = await open('blocked', [
      run({ id: 2, started_at: 1791965700, summary: '두 번째 사유' }),
      run({ id: 1, started_at: 1791965600, summary: '첫 번째 사유' }),
    ]);
    expect(await within(dlg).findByRole('status')).toHaveTextContent('두 번째 사유');
    expect(within(dlg).getByText('첫 번째 사유')).toBeInTheDocument();
    expect(within(dlg).getAllByText('두 번째 사유')).toHaveLength(1);
  });

  it('막히지 않은 카드에는 상자가 없고 실행 기록 아래에 요약만 보인다', async () => {
    const dlg = await open('review', [run({ status: 'done', outcome: 'completed', summary: '결과: 2' })]);
    expect(await within(dlg).findByText('결과: 2')).toBeInTheDocument();
    expect(within(dlg).queryByRole('status')).not.toBeInTheDocument();
    expect(within(dlg).queryByText('막힌 사유')).not.toBeInTheDocument();
  });

  it('막힌 카드라도 실행 기록이 없거나 사유가 비었으면 상자가 없다', async () => {
    const dlg = await open('blocked', [run({ summary: '', error: null })]);
    await within(dlg).findByText('실행 기록 1');
    expect(within(dlg).queryByRole('status')).not.toBeInTheDocument();
  });

  it('사유 글은 HTML·마크다운으로 해석하지 않고 그대로 보인다', async () => {
    const dlg = await open('blocked', [run({ summary: '<b>굵게</b> **별표**' })]);
    const box = await within(dlg).findByRole('status');
    expect(box).toHaveTextContent('<b>굵게</b> **별표**');
    expect(box.querySelector('b')).toBeNull();
  });
  // ── 리뷰 R2·R4·R5·R6·R8(승인된 범위) ──
  it('R2: 최근 실행에 요약과 오류가 둘 다 있으면 요약은 상자에, 오류는 실행 기록 줄 아래에 한 번 보인다', async () => {
    const dlg = await open('blocked', [run({ summary: '범위를 알려 주세요', error: 'worker exited 137' })]);
    expect(await within(dlg).findByRole('status')).toHaveTextContent('범위를 알려 주세요');
    expect(within(dlg).getAllByText('범위를 알려 주세요')).toHaveLength(1);
    expect(within(dlg).getAllByText('worker exited 137')).toHaveLength(1);
    expect(within(dlg).getByRole('status')).not.toHaveTextContent('worker exited 137');
    // 실행 기록 줄 아래의 오류는 요약(보조 글자색)과 다른 오류 색이다(의미 신호)
    expect(within(dlg).getByText('worker exited 137')).toHaveStyle({ color: 'rgb(244, 67, 54)' }); // 테마의 error 색(다크)
  });

  it('R2: 오류가 사유로 쓰였으면 줄 아래에서는 오류 중복만 빼고 요약(다른 필드)은 계속 보인다', async () => {
    const dlg = await open('blocked', [run({ outcome: 'failed', summary: '이전 시도의 결과 요약', error: '워커가 죽음' })]);
    expect(await within(dlg).findByRole('status')).toHaveTextContent('워커가 죽음');
    expect(within(dlg).getAllByText('워커가 죽음')).toHaveLength(1);
    expect(within(dlg).getByText('이전 시도의 결과 요약')).toBeInTheDocument();
  });

  it('R4: 같은 사유로 두 번 막혀 분류 대기(triage)로 간 카드도 최근 실행의 사유를 상자에 보인다', async () => {
    const dlg = await open('triage', [run({ summary: '같은 이유로 또 막힘' })]);
    const box = await within(dlg).findByRole('status');
    expect(box).toHaveTextContent('막힌 사유');
    expect(box).toHaveTextContent('같은 이유로 또 막힘');
  });

  it('R4: 담당 없이 만든 분류 대기 카드(실행 기록 없음)에는 상자가 없다', async () => {
    const dlg = await open('triage', []);
    expect(await within(dlg).findByText(/기본 정보/)).toBeInTheDocument();
    expect(within(dlg).queryByRole('status')).not.toBeInTheDocument();
  });

  it('R5: 최근 실행이 completed 이고 summary 만 있는 막힌 카드에는 상자가 없다(이전 시도의 요약을 사유로 오인하지 않는다)', async () => {
    const dlg = await open('blocked', [run({ outcome: 'completed', status: 'done', summary: '지난번 결과: 2' })]);
    expect(await within(dlg).findByText('지난번 결과: 2')).toBeInTheDocument(); // 실행 기록 줄 아래에는 보인다
    expect(within(dlg).queryByRole('status')).not.toBeInTheDocument();
  });

  it('R5: outcome 이 blocked 가 아니어도 error 는 사유로 보인다', async () => {
    const dlg = await open('blocked', [run({ outcome: 'failed', status: 'failed', error: '연결 끊김' })]);
    expect(await within(dlg).findByRole('status')).toHaveTextContent('연결 끊김');
  });

  it('R6: started_at 이 같으면 id 가 큰 실행의 사유가 상자에 보이고, 배열 순서에 기대지 않는다', async () => {
    const dlg = await open('blocked', [
      run({ id: 7, started_at: 1791965600, summary: 'id 7 의 사유' }),
      run({ id: 5, started_at: 1791965600, summary: 'id 5 의 사유' }),
    ]);
    expect(await within(dlg).findByRole('status')).toHaveTextContent('id 7 의 사유');
    expect(within(dlg).getByText('id 5 의 사유')).toBeInTheDocument();
    expect(within(dlg).getAllByText('id 7 의 사유')).toHaveLength(1);
  });

  it('R6: id 가 없고 started_at 도 같으면 배열 뒤쪽 실행이 최근이다', async () => {
    const dlg = await open('blocked', [
      run({ id: undefined, started_at: 1791965600, summary: '앞쪽 실행' }),
      run({ id: undefined, started_at: 1791965600, summary: '뒤쪽 실행' }),
    ]);
    expect(await within(dlg).findByRole('status')).toHaveTextContent('뒤쪽 실행');
    expect(within(dlg).getAllByText('뒤쪽 실행')).toHaveLength(1);
    expect(within(dlg).getByText('앞쪽 실행')).toBeInTheDocument();
  });

  it('R8: 긴 사유는 상자 안에서 스크롤되고(최대 높이·overflow), 키보드로 닿을 수 있다', async () => {
    const long = Array.from({ length: 60 }, (_, i) => `줄 ${i + 1}: 아주 긴 사유`).join('\n');
    const dlg = await open('blocked', [run({ summary: long })]);
    const box = await within(dlg).findByRole('status');
    const text = within(box).getByText(/줄 1: 아주 긴 사유/);
    expect(text).toHaveStyle({ maxHeight: '180px', overflowY: 'auto' });
    expect(text).toHaveAttribute('tabindex', '0');
    expect(text.textContent).toContain('줄 60: 아주 긴 사유'); // 잘리지 않고 전부 들어 있다
  });

  it('R8: 사유 상자는 오류(role=alert)가 아니라 안내(role=status)다', async () => {
    const dlg = await open('blocked', [run({ summary: '사유' })]);
    await within(dlg).findByRole('status');
    expect(within(dlg).queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('막힘 사유 규칙 함수(OMAI-1172 R2·R4·R5·R6)', () => {
  it('latestRunIndex: 비어 있으면 -1, 하나면 0', () => {
    expect(latestRunIndex([])).toBe(-1);
    expect(latestRunIndex([{ id: 1 }])).toBe(0);
  });

  it('latestRunIndex: started_at 이 큰 것 → 같으면 id 가 큰 것 → 그래도 같거나 id 가 없으면 배열 뒤쪽', () => {
    expect(latestRunIndex([{ id: 1, started_at: 9 }, { id: 2, started_at: 5 }])).toBe(0);
    expect(latestRunIndex([{ id: 5, started_at: 9 }, { id: 7, started_at: 9 }])).toBe(1);
    expect(latestRunIndex([{ id: 7, started_at: 9 }, { id: 5, started_at: 9 }])).toBe(0);
    expect(latestRunIndex([{ started_at: 9 }, { started_at: 9 }])).toBe(1);
    expect(latestRunIndex([{ id: 3, started_at: 9 }, { started_at: 9 }, { id: 3, started_at: 9 }])).toBe(2);
    expect(latestRunIndex([{ id: 'x', started_at: 9 }, { id: 2, started_at: 9 }])).toBe(1); // 숫자가 아닌 id 는 비교하지 않는다
    expect(latestRunIndex([{ id: '12', started_at: 9 }, { id: 3, started_at: 9 }])).toBe(0); // 숫자로 읽히는 문자열 id 는 숫자로 비교
    expect(latestRunIndex([{ id: 1 }, { id: 2 }])).toBe(1); // started_at 이 없으면 0 으로 보고 id 로
  });

  it('runOutcomeLabel: Hermes 실행 상태·결과 값을 화면 언어의 이름으로, 모르는 값은 그대로', () => {
    expect(runOutcomeLabel('running')).toBe('진행 중');
    expect(runOutcomeLabel('completed')).toBe('완료');
    expect(runOutcomeLabel('timed_out')).toBe('시간 초과');
    expect(runOutcomeLabel('spawn_failed')).toBe('시작 실패');
    expect(runOutcomeLabel('new_value')).toBe('new_value');
    expect(runOutcomeLabel(undefined)).toBe('진행 중');
    setLang('en');
    try {
      expect(runOutcomeLabel('running')).toBe('In progress');
      expect(runOutcomeLabel('crashed')).toBe('Crashed');
    } finally {
      setLang('ko');
    }
    for (const v of ['running', 'done', 'completed', 'blocked', 'crashed', 'timed_out', 'failed', 'released', 'spawn_failed', 'gave_up', 'reclaimed']) {
      expect(runOutcomeLabel(v), v).not.toBe(v);
    }
  });

  it('blockReason: 막힘 상태(blocked·triage)만, 그 밖의 상태는 사유가 없다', () => {
    const run = { outcome: 'blocked', summary: '사유' };
    expect(blockReason('blocked', run)).toEqual({ text: '사유', field: 'summary' });
    expect(blockReason('triage', run)).toEqual({ text: '사유', field: 'summary' });
    for (const status of ['todo', 'ready', 'running', 'review', 'done', 'scheduled', 'archived']) expect(blockReason(status, run)).toBeNull();
    expect(blockReason('blocked', undefined)).toBeNull();
  });

  it('blockReason: outcome 이 blocked 일 때만 summary, 아니면 error 만. 둘 다 없으면 null', () => {
    expect(blockReason('blocked', { outcome: 'blocked', summary: '', error: 'E' })).toEqual({ text: 'E', field: 'error' });
    expect(blockReason('blocked', { outcome: 'completed', summary: 'S' })).toBeNull();
    expect(blockReason('blocked', { outcome: 'completed', summary: 'S', error: 'E' })).toEqual({ text: 'E', field: 'error' });
    expect(blockReason('blocked', { summary: 'S' })).toBeNull(); // outcome 을 주지 않으면 요약을 사유로 쓰지 않는다
    expect(blockReason('blocked', { outcome: 'blocked' })).toBeNull();
    expect(blockReason('blocked', { outcome: 'blocked', summary: 'S', error: 'E' })).toEqual({ text: 'S', field: 'summary' });
  });
});

describe('카드 실행의 「실행한 명령」(스펙 2026-11-03-001 DD1~DD5·DD11·R14·R15)', () => {
  const run = (id: number, over: object = {}) => ({ id, profile: 'sa', status: 'done', outcome: 'completed', started_at: 1791965600 + id * 100, ended_at: 1791965650 + id * 100, ...over });
  const cmd = (command: string, over: object = {}) => ({ command, time: 1791965700, blocked: false, truncated: false, ...over });
  const ok = (commands: object[], over: object = {}) => ({ state: 'ok', read_mode: 'ro', commands, more: false, ...over });
  type Reply = object | Response | ((n: number) => object | Response);
  const open = async (runs: object[], replies: Record<number, Reply>, over: { comments?: object[]; status?: string } = {}) => {
    const status = over.status ?? 'done';
    const fn = mount(board([], { [status]: [card('c1', status)] }), (url) => {
      const m = /\/runs\/(\d+)\/commands/.exec(url);
      if (m) {
        const n = Number(m[1]);
        const r = replies[n] ?? NO_COMMANDS;
        return typeof r === 'function' ? r(fn.mock.calls.filter((c) => String(c[0]).includes(`/runs/${n}/commands`)).length) : r;
      }
      return url.includes('/tasks/c1') ? { task: card('c1', status), comments: over.comments ?? [], runs } : {};
    });
    await userEvent.click(await screen.findByText('카드 c1'));
    return { dlg: await screen.findByRole('dialog', { name: '카드 c1' }), fn };
  };
  const fetched = (fn: ReturnType<typeof stubApi>, n: number) => fn.mock.calls.filter((c) => String(c[0]).includes(`/runs/${n}/commands`)).length;

  it('DD1·DD4: 가장 최근 실행만 펼쳐 서랍을 열 때 읽고, 앞선 실행은 접힌 채 펼칠 때 따로 읽는다', async () => {
    const { dlg, fn } = await open([run(1), run(2)], { 2: ok([cmd('ls ./build'), cmd('cat a.txt')]), 1: ok([cmd('pwd')]) });
    const latest = await within(dlg).findByRole('button', { name: '실행한 명령 (2)' });
    expect(latest).toHaveAttribute('aria-expanded', 'true');
    const older = within(dlg).getByRole('button', { name: '실행한 명령' });
    expect(older).toHaveAttribute('aria-expanded', 'false');
    expect(fetched(fn, 1)).toBe(0);
    expect(fn.mock.calls.some((c) => String(c[0]).startsWith('/api/office/kanban/tasks/c1/runs/2/commands?board=b1'))).toBe(true);
    await userEvent.click(older);
    expect(await within(dlg).findByRole('button', { name: '실행한 명령 (1)' })).toHaveAttribute('aria-expanded', 'true');
    expect(within(dlg).getByText('pwd')).toBeInTheDocument();
    expect(fetched(fn, 1)).toBe(1);
  });

  it('DD4·DD11: 실패하면 칸 안 오류 줄(role=status)과 「다시 시도」, 누르면 다시 읽는다', async () => {
    const { dlg } = await open([run(1)], {
      1: (n: number) => (n <= 1 ? new Response(JSON.stringify({ error: 'hermes_unavailable', detail: '사이드카 안 닿음' }), { status: 503 }) : ok([cmd('ls')])),
    });
    const line = await within(dlg).findByText(/실행한 명령을 불러오지 못했습니다/);
    expect(line.closest('[role="status"]')).not.toBeNull();
    await userEvent.click(within(dlg).getByRole('button', { name: '다시 시도' }));
    expect(await within(dlg).findByText('ls')).toBeInTheDocument();
  });

  it('DD11: 불러오는 중 줄은 칸 안 한 줄이고 role=status 다', async () => {
    mount(board([], { done: [card('c1', 'done')] }), (url) => (url.includes('/tasks/c1') ? { task: card('c1', 'done'), comments: [], runs: [run(1)] } : {}));
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', (u: string, i?: RequestInit) => (String(u).includes('/commands') ? new Promise(() => {}) : real(u, i))); // 답이 오지 않는 읽기
    await userEvent.click(await screen.findByText('카드 c1'));
    const dlg = await screen.findByRole('dialog', { name: '카드 c1' });
    const line = await within(dlg).findByText('불러오는 중…');
    expect(line.closest('[role="status"]')).not.toBeNull();
  });

  it.each([
    ['none', '이 실행은 터미널 명령을 쓰지 않았습니다'],
    ['lost', '실행 기록을 찾지 못했습니다(로그가 지워졌거나 없음)'],
    ['running', '실행 중입니다'],
    ['pending', '아직 대화 기록에 반영되지 않았을 수 있습니다'],
  ])('DD3·R15: 상태 %s 는 원인 문구를 보이고, pending 만 「다시 읽기」로 다시 묻는다', async (state, text) => {
    const { dlg, fn } = await open([run(1)], { 1: { state, read_mode: state === 'pending' ? 'immutable' : 'ro', commands: [], more: false } });
    expect(await within(dlg).findByText(text)).toBeInTheDocument();
    const reload = within(dlg).queryByRole('button', { name: '다시 읽기' });
    if (state !== 'pending') return void expect(reload).toBeNull();
    const before = fetched(fn, 1);
    await userEvent.click(reload!);
    await waitFor(() => expect(fetched(fn, 1)).toBe(before + 1));
  });

  it('DD3: 영어 문구도 상태마다 있다', async () => {
    setLang('en');
    try {
      const { dlg } = await open([run(1)], { 1: { state: 'lost', read_mode: 'ro', commands: [], more: false } });
      expect(await within(dlg).findByText('The run history was not found (the log was deleted or is missing)')).toBeInTheDocument();
    } finally {
      setLang('ko');
    }
  });

  it('DD5·R14·DD11: 고정폭 12px 로 줄바꿈해 다 보이고, 잘린 명령은 「… (잘림)」, 막힌 줄은 앰버 「막힘」 글자 태그, 200개를 넘으면 안내', async () => {
    const long = 'curl -H «가림» ' + 'x'.repeat(185);
    const { dlg } = await open([run(1)], {
      1: ok([cmd(long, { truncated: true }), cmd('find ./build -delete', { blocked: true }), cmd('ls')], { more: true }),
    });
    const list = await within(dlg).findByRole('list', { name: '실행한 명령' });
    expect(list.tagName).toBe('UL');
    const box = list.parentElement!;
    expect(box).toHaveAttribute('tabindex', '0');
    expect(box).toHaveStyle({ maxHeight: '240px', overflowY: 'auto' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    const text = within(items[0]).getByText(/curl -H «가림»/);
    expect(text).toHaveStyle({ fontSize: '12px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' });
    expect(getComputedStyle(text).fontFamily).toContain('JetBrains Mono');
    expect(items[0]).toHaveTextContent('… (잘림)');
    expect(items[2]).not.toHaveTextContent('잘림');
    const tag = within(items[1]).getByText('막힘');
    expect(tag.closest('.MuiChip-root')).toBeNull();                 // 글자 태그(칩이 아님)
    expect(within(items[2]).queryByText('막힘')).toBeNull();
    expect(within(dlg).getByText('명령이 많아 처음 200개만 보입니다')).toBeInTheDocument();
  });

  it('DD11: 접기 단추는 펼치는 영역을 가리키고(aria-controls) 높이가 44px 이상이다', async () => {
    const { dlg } = await open([run(1)], { 1: ok([cmd('ls')]) });
    const btn = await within(dlg).findByRole('button', { name: '실행한 명령 (1)' });
    const panel = document.getElementById(btn.getAttribute('aria-controls') ?? '');
    expect(panel).not.toBeNull();
    expect(within(panel!).getByRole('list', { name: '실행한 명령' })).toBeInTheDocument();
    expect(btn).toHaveStyle({ minHeight: '44px' });
    await userEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(within(dlg).queryByRole('list', { name: '실행한 명령' })).toBeNull();
  });
});

describe('보안 검사가 막은 명령(스펙 2026-11-03-001 DD2·DD10)', () => {
  const guard = (id: number) => ({ id, author: 'hermes-guard', body: '보안 검사가 위험 명령을 막았습니다: find -delete\n\n```\nfind ./b -delete\n```', created_at: 1791965600 + id });
  const open = async (status: string, comments: object[], runs: object[] = []) => {
    mount(board([], { [status]: [card('g1', status)] }), (url) =>
      url.includes('/commands') ? NO_COMMANDS : url.includes('/tasks/g1') ? { task: card('g1', status), comments, runs } : {}
    );
    await userEvent.click(await screen.findByText('카드 g1'));
    return screen.findByRole('dialog', { name: '카드 g1' });
  };

  it('DD2: 완료 카드라도 보안 검사 댓글이 있으면 맨 위 앰버 알림(role=status)에 막은 명령 수, 누르면 댓글로 가서 포커스', async () => {
    const dlg = await open('done', [guard(1), { id: 2, author: 'aas', body: '사람 메모', created_at: 1 }, guard(3)]);
    const alert = (await within(dlg).findByText('보안 검사가 막은 명령 2개')).closest('[role="status"]') as HTMLElement;
    expect(alert).toHaveClass('MuiAlert-standardWarning');
    expect(within(alert).queryByText('막힌 사유')).toBeNull();
    await userEvent.click(within(alert).getByRole('button', { name: '댓글 보기' }));
    expect(within(dlg).getByText('댓글 3').parentElement).toHaveFocus();
  });

  it('DD2: 막힌 사유가 있으면 같은 알림 안에 둘 다', async () => {
    const dlg = await open('blocked', [guard(1)], [{ id: 1, profile: 'sa', status: 'blocked', outcome: 'blocked', started_at: 1, summary: '명령이 막혀 멈춤' }]);
    const alert = (await within(dlg).findByText('막힌 사유')).closest('[role="status"]') as HTMLElement;
    expect(alert).toHaveTextContent('명령이 막혀 멈춤');
    expect(alert).toHaveTextContent('보안 검사가 막은 명령 1개');
    expect(dlg.querySelectorAll('.MuiAlert-root')).toHaveLength(1);
  });

  it('DD2: 보안 검사 댓글도 사유도 없으면 알림이 없다', async () => {
    const dlg = await open('done', [{ id: 2, author: 'aas', body: '사람 메모', created_at: 1 }]);
    await within(dlg).findByText('댓글 1');
    expect(dlg.querySelector('.MuiAlert-root')).toBeNull();
  });

  it('DD10: 작성자 hermes-guard 는 방패 아이콘과 「보안 검사」, 접근 이름에 「자동 기록」, 칩·앰버가 아니다', async () => {
    const dlg = await open('done', [guard(1)]);
    const who = await within(dlg).findByLabelText(/자동 기록/);
    expect(who).toHaveTextContent('보안 검사');
    expect(who.querySelector('[data-testid="ShieldOutlinedIcon"]')).not.toBeNull();
    expect(who.closest('.MuiChip-root')).toBeNull();
    expect(within(dlg).queryByText('hermes-guard')).toBeNull();
  });
});
