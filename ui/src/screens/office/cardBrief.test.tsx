/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 칸반 카드 항목별 입력(스펙 2026-10-18-002): 본문 만들기·나누기와 카드 추가 서랍, 카드 서랍 첨부.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dictionaries, setLang } from '@/i18n';
import { ME_USER, mountScreen, postedTo, stubApi } from '@/test/mountScreen';
import { pickAgent } from '@/test/pickAgent';

import { BODY_WARN, BriefFields, buildCardBrief, CARD_BRIEF_KEYS, type CardBrief, missingRequired, parseCardBrief } from './cardBrief';
import type { Seat } from './forms';
import { Kanban } from './Kanban';

const FOOTER_KO = dictionaries.ko['office.cardBriefFooter'];
const SEATS = [{ alias: 'sa', pod: 'kim', profile: 'sa', enabled: true, title: '', role: '', team: '', note: '' }] as Seat[];
const EMPTY = { columns: [{ name: 'todo', tasks: [] }] };

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  setLang('ko');
});

describe('본문 만들기와 나누기', () => {
  it('빈 항목은 넣지 않고 정한 순서로 ### 머리를 붙인다. 추가 설명은 마지막이다', () => {
    const out = buildCardBrief({ notes: '메모', result: '보고서 1개', goal: '보고서를 만든다', how: '  ' });
    expect(out).toBe(`### 목표\n보고서를 만든다\n\n### 결과물과 완료 기준\n보고서 1개\n\n### 추가 설명\n메모\n\n---\n${FOOTER_KO}`);
    expect(buildCardBrief({ goal: '  ' })).toBe('');
  });

  it('끝의 첨부 안내 줄은 다시 나눌 때 떼어 낸다(두 언어 모두)', () => {
    expect(parseCardBrief(buildCardBrief({ goal: 'g', result: 'r' }))).toEqual({ goal: 'g', result: 'r' });
    expect(parseCardBrief(`### Goal\ng\n\n---\n${dictionaries.en['office.cardBriefFooter']}`)).toEqual({ goal: 'g' });
    expect(FOOTER_KO).toContain('kanban_complete(artifacts=');
  });

  it('머리는 화면 언어로 쓴다', () => {
    setLang('en');
    expect(buildCardBrief({ goal: 'g', location: 'repo' })).toBe(`### Goal\ng\n\n### Location\nrepo\n\n---\n${dictionaries.en['office.cardBriefFooter']}`);
  });

  it('필수는 목표·결과물과 완료 기준이고 작업 위치는 아니다', () => {
    expect(missingRequired({})).toEqual(['goal', 'result']);
    expect(missingRequired({ goal: 'g', result: 'r' })).toEqual([]);
    expect(missingRequired({ goal: 'g', location: '' })).toEqual(['result']);
  });

  it('만든 글을 다시 나누면 같은 값이 되고, 영어 머리 글도 읽는다', () => {
    const values = { goal: '목표 글', location: '저장소 a', result: '결과', ifStuck: '막힘으로 둔다' };
    expect(parseCardBrief(buildCardBrief(values))).toEqual(values);
    expect(parseCardBrief('### Goal\nship it\n\n### Do not\nprod')).toEqual({ goal: 'ship it', avoid: 'prod' });
  });

  it('머리가 없는 글은 추가 설명으로 가고, 모르는 ### 줄은 앞 항목의 글로 남는다', () => {
    expect(parseCardBrief('그냥 한 줄')).toEqual({ notes: '그냥 한 줄' });
    expect(parseCardBrief('### 목표\nA\n### 모르는 머리\nB')).toEqual({ goal: 'A\n### 모르는 머리\nB' });
  });

  it('같은 뜻의 머리 글은 TFT 방(office.brief.*)과 값이 같다(디자인 리뷰 C1)', () => {
    for (const lang of ['ko', 'en'] as const)
      for (const k of ['goal', 'result', 'how', 'avoid', 'refs', 'notes'])
        expect(dictionaries[lang][`office.cardBrief.${k}.head`]).toBe(dictionaries[lang][`office.brief.${k}.head`]);
    for (const k of CARD_BRIEF_KEYS)
      for (const f of ['q', 'head', 'example']) expect(dictionaries.en[`office.cardBrief.${k}.${f}`]).toBeTruthy();
  });
});

function mount(extra: Record<string, unknown> = {}) {
  const fn = stubApi({
    '/api/office/kanban/boards': { boards: [{ slug: 'b1', name: '보드', total: 0, archived: false }] },
    '/api/office/kanban/board': EMPTY,
    '/api/office/kanban/tasks': { task: { status: 'todo' } },
    ...extra,
  });
  mountScreen(<Kanban seats={SEATS} canAct mySeat="sa" />, '/office?tab=kanban');
  return fn;
}
const open = async () => userEvent.click(await screen.findByRole('button', { name: '카드 추가' }));
const field = (q: RegExp) => screen.getByLabelText(q);
const toggle = (name: string) => screen.getByRole('button', { name });

describe('카드 추가 서랍', () => {
  it('처음 방문에는 항목별 입력이 골라져 있고, 저장값을 읽지 못해도 항목별이다', async () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    mount();
    await open();
    expect(toggle('항목별 입력')).toHaveAttribute('aria-pressed', 'true');
    spy.mockRestore();
    expect(field(/무엇을 끝내야 하나요/)).toBeInTheDocument();
    expect(field(/어디에서 하나요/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/왜 필요한가요/)).not.toBeInTheDocument();
  });

  it('항목별로 만들면 본문은 buildCardBrief 결과이고, 우선순위는 더 자세히 적기 안에 있다', async () => {
    const fn = mount();
    await open();
    await userEvent.type(screen.getByLabelText('제목'), '주간 보고서');
    await userEvent.type(field(/무엇을 끝내야 하나요/), '보고서를 만든다');
    await userEvent.type(field(/결과는 무엇이고/), '보고서 1개 첨부');
    expect(screen.queryByLabelText('우선순위')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '더 자세히 적기' }));
    expect(screen.getByLabelText('우선순위')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '만들기' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/kanban/tasks')).toHaveLength(1));
    expect(postedTo(fn, '/api/office/kanban/tasks')[0]).toMatchObject({
      title: '주간 보고서',
      assignee: 'sa',
      body: `### 목표\n보고서를 만든다\n\n### 결과물과 완료 기준\n보고서 1개 첨부\n\n---\n${FOOTER_KO}`,
    });
  });

  it('필수가 비면 만들기가 꺼지고 빈 것을 모두 알리며, 「자유 입력으로 바꾸기」로 방식을 바꾼다', async () => {
    mount();
    await open();
    await userEvent.type(screen.getByLabelText('제목'), '새 일');
    expect(screen.getByRole('button', { name: '만들기' })).toBeDisabled();
    expect(screen.getByText(/목표, 결과물과 완료 기준을\(를\) 적어 주세요/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '또는 자유 입력으로 바꾸기' }));
    expect(toggle('자유 입력')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '만들기' })).toBeEnabled();
  });

  it('방식을 오가도 같은 내용이 두 번 들어가지 않고, 포커스는 토글에 남는다(J2·D19)', async () => {
    const fn = mount();
    await open();
    await userEvent.type(screen.getByLabelText('제목'), '왕복');
    await userEvent.type(field(/무엇을 끝내야 하나요/), 'A');
    await userEvent.type(field(/결과는 무엇이고/), 'B');
    await userEvent.click(toggle('자유 입력'));
    expect(toggle('자유 입력')).toHaveFocus();
    expect(screen.getByLabelText('내용')).toHaveValue(`### 목표\nA\n\n### 결과물과 완료 기준\nB\n\n---\n${FOOTER_KO}`);
    await userEvent.click(toggle('항목별 입력'));
    expect(field(/무엇을 끝내야 하나요/)).toHaveValue('A');
    await userEvent.click(screen.getByRole('button', { name: '만들기' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/kanban/tasks')).toHaveLength(1));
    const body = String(postedTo(fn, '/api/office/kanban/tasks')[0].body);
    expect(body.match(/### 목표/g)).toHaveLength(1);
    expect(body).not.toContain('### 추가 설명');
    expect(body.split(FOOTER_KO)).toHaveLength(2); // 안내 줄도 한 번만
  });

  it('자유 칸을 고친 뒤 항목별로 가면 값이 다를 때 묻고, 거절하면 항목 값이 그대로다', async () => {
    mount();
    await open();
    await userEvent.type(field(/무엇을 끝내야 하나요/), 'A');
    await userEvent.click(toggle('자유 입력'));
    const body = screen.getByLabelText('내용');
    await userEvent.clear(body);
    await userEvent.type(body, '### 목표{enter}Z');
    await userEvent.click(toggle('항목별 입력'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('항목에 적은 값을 자유 입력의 글로 바꿀까요?')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: '취소' }));
    await waitFor(() => expect(field(/무엇을 끝내야 하나요/)).toHaveValue('A'));
  });

  it('마지막으로 고른 방식을 기억한다', async () => {
    mount();
    await open();
    await userEvent.click(toggle('자유 입력'));
    expect(localStorage.getItem('aas.kanban.cardMode')).toBe('free');
  });

  it('「내용 보기」는 보낼 제목과 본문을 보이고 다시 누르면 입력으로 돌아간다', async () => {
    mount();
    await open();
    await userEvent.type(screen.getByLabelText('제목'), '미리보기');
    await userEvent.type(field(/무엇을 끝내야 하나요/), '끝 상태');
    const btn = screen.getByRole('button', { name: '내용 보기' });
    await userEvent.click(btn);
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { name: '목표' })).toBeInTheDocument();
    expect(screen.getByText('끝 상태')).toBeInTheDocument();
    expect(screen.queryByLabelText(/무엇을 끝내야 하나요/)).not.toBeInTheDocument();
    await userEvent.click(btn);
    expect(field(/무엇을 끝내야 하나요/)).toHaveValue('끝 상태');
  });

  it('글자 수를 늘 보이고 8,000자를 넘으면 경고하되 만들기는 막지 않는다', async () => {
    mount();
    await open();
    expect(screen.getByText('0 / 8,192자')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('제목'), '긴 글');
    await userEvent.click(toggle('자유 입력'));
    const long = 'a'.repeat(BODY_WARN + 1);
    await userEvent.click(screen.getByLabelText('내용'));
    await userEvent.paste(long);
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('8,001 / 8,192자');
    expect(status).toHaveTextContent('AI 에이전트는 8,192자 뒤를 읽지 못합니다');
    expect(screen.getByRole('button', { name: '만들기' })).toBeEnabled();
  });

  it('적은 내용이 있으면 닫을 때 묻고, 비어 있으면 바로 닫는다', async () => {
    mount();
    await open();
    await userEvent.click(screen.getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(screen.queryByLabelText('제목')).not.toBeInTheDocument());
    await open();
    await userEvent.type(screen.getByLabelText('제목'), '버릴 글');
    await userEvent.click(screen.getByRole('button', { name: '닫기' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('적은 내용을 버리고 닫을까요?')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: '취소' }));
    expect(screen.getByLabelText('제목')).toHaveValue('버릴 글');
  });
});

describe('AI 로 항목 나누기', () => {
  const answer = { fields: { goal: '보고서를 만든다', how: '로그를 모은다' }, missing: ['result', 'location'] };

  it('채운 칸·빠진 칸을 보이고 접힌 칸을 열며, 빠진 필수 칸으로 포커스를 옮긴다', async () => {
    const fn = mount({ '/api/office/brief/suggest': answer });
    await open();
    await userEvent.click(toggle('자유 입력'));
    await userEvent.type(screen.getByLabelText('내용'), '주간 장애 보고서를 써 줘');
    await userEvent.click(screen.getByRole('button', { name: 'AI 로 항목 나누기' }));
    expect(await screen.findByText('AI 가 2개 항목을 채웠습니다. 확인한 뒤 만드세요')).toBeInTheDocument();
    expect(postedTo(fn, '/api/office/brief/suggest')[0]).toMatchObject({ text: '주간 장애 보고서를 써 줘', lang: 'ko' });
    expect(toggle('항목별 입력')).toHaveAttribute('aria-pressed', 'true');
    expect(field(/무엇을 끝내야 하나요/)).toHaveValue('보고서를 만든다');
    expect(field(/어떻게 하면 되나요/)).toHaveValue('로그를 모은다');
    expect(screen.getAllByText('AI 가 채움')).toHaveLength(2);
    expect(screen.getByText('결과를 어디에 남길지 적혀 있지 않습니다')).toBeInTheDocument();
    expect(screen.getByText('작업 위치가 글에 없습니다. 있으면 적어 주세요')).toBeInTheDocument();
    await waitFor(() => expect(field(/결과는 무엇이고/)).toHaveFocus());
    // 사람이 고치면 「AI 가 채움」이 사라진다
    await userEvent.type(field(/무엇을 끝내야 하나요/), '!');
    expect(screen.getAllByText('AI 가 채움')).toHaveLength(1);
  });

  it('항목에 이미 값이 있으면 덮어쓰기 전에 묻고, 거절하면 부르지 않는다', async () => {
    const fn = mount({ '/api/office/brief/suggest': answer });
    await open();
    await userEvent.type(field(/무엇을 끝내야 하나요/), '내 값');
    await userEvent.click(toggle('자유 입력'));
    await userEvent.type(screen.getByLabelText('내용'), ' 더');
    await userEvent.click(screen.getByRole('button', { name: 'AI 로 항목 나누기' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('항목별로 적은 값을 AI 가 나눈 값으로 바꿀까요?')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: '취소' }));
    expect(postedTo(fn, '/api/office/brief/suggest')).toHaveLength(0);
  });

  it('오류는 단추 아래 경고로 보인다', async () => {
    const fetchFn = vi.fn((url: string) =>
      Promise.resolve(
        url.startsWith('/api/office/brief/suggest')
          ? new Response(JSON.stringify({ error: 'LiteLLM 이 설정되지 않았습니다', reason: 'not_configured' }), { status: 503 })
          : url.startsWith('/api/office/kanban/boards')
            ? new Response(JSON.stringify({ boards: [{ slug: 'b1', name: '보드', total: 0, archived: false }] }))
            : url.startsWith('/api/office/kanban/board')
              ? new Response(JSON.stringify(EMPTY))
              : new Response(JSON.stringify({ email: 'a', admin: true, auth: false }))
      )
    );
    vi.stubGlobal('fetch', fetchFn);
    mountScreen(<Kanban seats={SEATS} canAct mySeat="sa" />, '/office?tab=kanban');
    await open();
    await userEvent.click(toggle('자유 입력'));
    await userEvent.type(screen.getByLabelText('내용'), '글');
    await userEvent.click(screen.getByRole('button', { name: 'AI 로 항목 나누기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('LiteLLM 이 설정되지 않았습니다');
  });
});

describe('카드 서랍 첨부(§3-9)', () => {
  const DETAIL = {
    task: { id: 't1', title: '보고서', assignee: 'sa', status: 'done', body: '### 목표\n끝' },
    comments: [],
    runs: [],
    attachments: [
      { id: 7, filename: 'report.md', size: 2048, uploaded_by: 'sa', created_at: 1760000000 },
      { id: 8, filename: 'big.zip', size: 30 * 1024 * 1024, uploaded_by: 'dashboard', created_at: 1759990000 },
    ],
  };
  const withCard = { columns: [{ name: 'done', tasks: [{ id: 't1', title: '보고서', assignee: 'sa', status: 'done' }] }] };

  function mountDetail(head: (url: string) => Response) {
    const fetchFn = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') return Promise.resolve(head(url));
      const reply = (v: unknown) => Promise.resolve(new Response(JSON.stringify(v)));
      if (url.startsWith('/api/office/kanban/boards')) return reply({ boards: [{ slug: 'b1', name: '보드', total: 1, archived: false }] });
      if (url.startsWith('/api/office/kanban/board')) return reply(withCard);
      if (url.startsWith('/api/office/kanban/tasks/t1')) return reply(DETAIL);
      return reply({ email: 'a', admin: true, auth: false });
    });
    vi.stubGlobal('fetch', fetchFn);
    mountScreen(<Kanban seats={SEATS} canAct mySeat="sa" />, '/office?tab=kanban');
    return fetchFn;
  }

  it('첨부가 있으면 본문 위에 「첨부 (N)」을 보이고, 25MB 를 넘는 첨부는 받을 수 없다', async () => {
    mountDetail(() => new Response(null, { status: 200 }));
    await userEvent.click(await screen.findByText('보고서'));
    const heading = await screen.findByText('첨부 (2)');
    // 본문 머리(목표)보다 앞에 온다
    expect(heading.compareDocumentPosition(screen.getByRole('heading', { name: '목표' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 스펙 2026-10-20-002 R1·R8: 이름은 파일 뱃지(누르면 뷰어). 25MB 를 넘는 첨부는 이름에 이유를 싣고 뷰어의 받기가 막힌다
    expect(screen.getByRole('button', { name: 'report.md 열기' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'big.zip 열기, 받을 수 없음: 25MB 를 넘어 받을 수 없습니다' }));
    const dlg = await screen.findByRole('dialog', { name: 'big.zip' });
    expect(within(dlg).getByRole('button', { name: '받기' })).toBeDisabled();
  });

  it('올린 사람이 자리(프로파일)면 에이전트 칩, 아니면 글자로 보인다(§8-4)', async () => {
    mountDetail(() => new Response(null, { status: 200 }));
    await userEvent.click(await screen.findByText('보고서'));
    await screen.findByText('첨부 (2)');
    const rows = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name} 열기`) }).parentElement!.parentElement!;
    expect(within(rows('report.md')).getByText('sa').closest('[data-agent-chip]')).not.toBeNull();
    expect(within(rows('big.zip')).getByText('dashboard').closest('[data-agent-chip]')).toBeNull();
  });

  it('뷰어가 첨부 주소를 읽고, 받기는 그 주소로 디스크에 받는다. 서버가 거절하면 칸반 이유 문구를 보인다', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    let ok = true;
    const fetchFn = mountDetail(() => new Response(null, { status: 200 }));
    const base = fetchFn.getMockImplementation()!;
    fetchFn.mockImplementation((url: string, init?: RequestInit) => {
      if (!url.startsWith('/api/office/kanban/tasks/t1/attachments/7')) return base(url, init);
      return Promise.resolve(
        ok ? new Response('# r', { status: 200, headers: { 'Content-Length': '3' } }) : new Response(null, { status: 403, headers: { 'X-AAS-Code': 'forbidden' } })
      );
    });
    await userEvent.click(await screen.findByText('보고서'));
    await userEvent.click(await screen.findByRole('button', { name: 'report.md 열기' }));
    let dlg = await screen.findByRole('dialog', { name: 'report.md' });
    expect(fetchFn.mock.calls.some((c) => String(c[0]) === '/api/office/kanban/tasks/t1/attachments/7?board=b1')).toBe(true);
    await userEvent.click(within(dlg).getByRole('button', { name: '받기' }));
    expect(click).toHaveBeenCalledTimes(1);
    await userEvent.click(within(dlg).getByRole('button', { name: '닫기' }));
    ok = false;
    await userEvent.click(screen.getByRole('button', { name: 'report.md 열기' }));
    dlg = await screen.findByRole('dialog', { name: 'report.md' });
    expect(await within(dlg).findByText('이 카드의 첨부를 받을 권한이 없습니다')).toBeInTheDocument();
    click.mockRestore();
  });
});

describe('일반 사용자', () => {
  it('담당과 필수가 모두 비면 둘 다 알린다', async () => {
    stubApi({
      '/api/me': ME_USER,
      '/api/office/kanban/boards': { boards: [{ slug: 'b1', name: '보드', total: 0, archived: false }] },
      '/api/office/kanban/board': EMPTY,
    });
    mountScreen(<Kanban seats={SEATS} canAct />, '/office?tab=kanban');
    await open();
    await userEvent.type(screen.getByLabelText('제목'), '일');
    await waitFor(() => expect(screen.getByText(/담당을 고르고, 목표, 결과물과 완료 기준을\(를\) 적어 주세요/)).toBeInTheDocument());
    await pickAgent(userEvent.setup(), screen.getByRole('combobox', { name: '담당' }), /^sa/);
    expect(screen.getByText(/목표, 결과물과 완료 기준을\(를\) 적어 주세요/)).toBeInTheDocument();
  });
});

// 접고 펼치는 단추와 「N칸 적음」(스펙 2026-10-19-005 O3·G6·G13·R13·R14)
describe('BriefFields 접기', () => {
  const Harness = ({ initial, disabled }: { initial: CardBrief; disabled?: boolean }) => {
    const [values, setValues] = useState<CardBrief>(initial);
    const [more, setMore] = useState(false);
    return (
      <BriefFields
        values={values}
        onChange={(k, v) => setValues((b) => ({ ...b, [k]: v }))}
        more={more}
        onMore={() => setMore((m) => !m)}
        extra={<select aria-label="우선순위" defaultValue="normal" />}
        disabled={disabled}
      />
    );
  };

  it('접힌 칸에 적은 글이 있으면 개수를 보이고, 우선순위 같은 선택 칸은 세지 않는다', async () => {
    mountScreen(<Harness initial={{ goal: '보고서', how: '순서대로', refs: '  ', notes: '메모' }} />, '/office');
    expect(screen.getByText('2칸 적음')).toBeInTheDocument(); // how·notes(빈칸만 있는 refs 와 보이는 goal 은 세지 않음)
    const btn = screen.getByRole('button', { name: '더 자세히 적기' });
    await userEvent.click(btn);
    expect(screen.queryByText(/칸 적음/)).toBeNull();
    const region = document.getElementById(screen.getByRole('button', { name: '접기' }).getAttribute('aria-controls') as string);
    expect(region).toContainElement(screen.getByLabelText('우선순위'));
  });

  it('적은 글이 없으면 개수를 보이지 않는다(우선순위 기본값만 있어도)', () => {
    mountScreen(<Harness initial={{ goal: '보고서' }} />, '/office');
    expect(screen.queryByText(/칸 적음/)).toBeNull();
  });

  it('disabled 를 주면 「더 자세히 적기」가 막힌다(지금 화면에서는 생기지 않는 상태, R14)', () => {
    mountScreen(<Harness initial={{}} disabled />, '/office');
    expect(screen.getByRole('button', { name: '더 자세히 적기' })).toBeDisabled();
  });
});
