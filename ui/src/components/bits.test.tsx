/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box } from '@mui/material';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { actionable, ChatChip, IssueList, KV, LinkChip, Mono, RowList, Section, Tag, UsedByLinks } from './bits';
import { drawerBodySx } from './drawerBodySx';
import { InDrawerContext } from './drawerScope';
import { UiProvider, useUi } from './UiContext';

describe('bits', () => {
  it('Tag 는 글자를 보인다', () => {
    render(<Tag tone="bad">꺼짐</Tag>);
    expect(screen.getByText('꺼짐')).toBeInTheDocument();
  });

  it('Section 의 개수는 제목과 떨어진 뱃지로 보인다(서랍 모양이 aas-* 클래스를 쓴다)', () => {
    render(
      <Section title="부르는 MCP 서버" count={0}>
        <RowList>
          <li>
            <Mono block>skills/a/run.py</Mono>
          </li>
        </RowList>
      </Section>
    );
    const head = screen.getByRole('heading', { name: /부르는 MCP 서버/ });
    expect(head).toHaveClass('aas-section-head');
    expect(head.querySelector('.aas-count')).toHaveTextContent('0');
    expect(screen.getByRole('list')).toHaveClass('aas-list');
    expect(screen.getByText('skills/a/run.py')).toHaveClass('aas-mono');
  });

  it('Section indent: 제목 아래 내용을 제목 글자 자리(아이콘 16px + 6px = 22px)에서 시작한다. 기본은 들여 쓰지 않는다', () => {
    const body = (title: string, indent?: boolean) => {
      const { container, unmount } = render(
        <Section title={title} indent={indent}>
          <p>내용</p>
        </Section>
      );
      const el = container.querySelector('.aas-section-body') as HTMLElement;
      const pl = getComputedStyle(el).paddingLeft;
      unmount();
      return pl;
    };
    expect(body('부르는 MCP 서버', true)).toBe('22px');
    expect(body('부르는 MCP 서버')).not.toBe('22px');
    expect(body('아이콘 없는 제목 xyz', true)).not.toBe('22px'); // 아이콘이 없으면 제목 글자가 바로 시작하므로 들이지 않는다
  });

  it('KV 는 값이 없거나 빈 문자열인 쌍을 건너뛴다', () => {
    render(
      <KV
        pairs={[
          ['이름', 'ma'],
          ['비움', ''],
          ['없음', null],
          ['영', 0],
        ]}
      />
    );
    expect(screen.getByText('이름')).toBeInTheDocument();
    expect(screen.queryByText('비움')).not.toBeInTheDocument();
    expect(screen.queryByText('없음')).not.toBeInTheDocument();
    expect(screen.getByText('영')).toBeInTheDocument(); // 0 은 값이다
  });

  it('Section 은 제목을 소제목으로 보인다', () => {
    render(<Section title="확인할 것">내용</Section>);
    expect(screen.getByRole('heading', { name: '확인할 것' })).toBeInTheDocument();
    expect(screen.getByText('내용')).toBeInTheDocument();
  });

  it('서랍 안 Section 은 제목은 그대로 두고 내용만 제목 글자 자리만큼 안쪽에서 시작한다', () => {
    render(
      <Box sx={drawerBodySx}>
        <Section title="부르는 MCP 서버">
          <p>없음</p>
        </Section>
        <Section>
          <p>제목 없음</p>
        </Section>
      </Box>
    );
    const head = screen.getByRole('heading', { name: '부르는 MCP 서버' });
    const body = screen.getByText('없음').parentElement as HTMLElement;
    expect(body).toHaveClass('aas-section-body');
    expect(getComputedStyle(body).paddingLeft).toBe('22px');
    expect(getComputedStyle(head).paddingLeft).not.toBe('22px');
    // 제목이 없으면 들여 쓸 기준이 없어 그대로 둔다
    expect(screen.getByText('제목 없음').parentElement).not.toHaveClass('aas-section-body');
  });

  it('서랍 밖 Section 내용은 들여 쓰지 않는다', () => {
    render(<Section title="확인할 것"><p>내용</p></Section>);
    expect(getComputedStyle(screen.getByText('내용').parentElement as HTMLElement).paddingLeft).not.toBe('22px');
  });

  it('IssueList 는 문제와 주의를 구분해 보이고 비면 이상 없음', () => {
    const { rerender } = render(
      <IssueList
        issues={[
          { level: 'bad', text: '꺼져 있음' },
          { level: 'warn', text: '재시도 기록' },
        ]}
      />
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('문제')).toBeInTheDocument();
    expect(screen.getByText('주의')).toBeInTheDocument();
    rerender(<IssueList issues={[]} />);
    expect(screen.getByText('이상 없음')).toBeInTheDocument();
  });

  it('IssueList 는 ack 안내에만 확인 버튼을 두고, onAck 가 없으면 두지 않는다', async () => {
    const onAck = vi.fn();
    const issues = [
      { level: 'bad', text: '올리지 못함', code: 'market_auto_failed' },
      { level: 'info', text: '자동 업그레이드 했습니다', code: 'market_auto_done', ack: true, package: 'free/x', version: '1.0.1' },
    ];
    const { rerender } = render(<IssueList issues={issues} onAck={onAck} />);
    const buttons = screen.getAllByRole('button', { name: '확인했습니다' });
    expect(buttons).toHaveLength(1);
    await userEvent.click(buttons[0]);
    expect(onAck).toHaveBeenCalledWith(expect.objectContaining({ package: 'free/x', version: '1.0.1' }));
    rerender(<IssueList issues={issues} />);
    expect(screen.queryByRole('button', { name: '확인했습니다' })).toBeNull();
  });

  it('LinkChip 은 화면 경로로 이동하고 params 를 주소에 담는다', async () => {
    const user = userEvent.setup();
    function Where() {
      const l = useLocation();
      return <div data-testid="loc">{l.pathname + l.search}</div>;
    }
    render(
      <MemoryRouter>
        <LinkChip to="cron" params={{ tab: 'profiles', q: 'ma' }}>
          ma 의 크론
        </LinkChip>
        <Where />
      </MemoryRouter>
    );
    await user.click(screen.getByRole('link', { name: 'ma 의 크론' }));
    expect(screen.getByTestId('loc')).toHaveTextContent('/cron?tab=profiles&q=ma');
  });

  it('다른 화면으로 가는 칩은 앞에 그 화면의 제목 아이콘을 단다', () => {
    render(
      <MemoryRouter>
        <LinkChip to="cron">크론으로</LinkChip>
        <LinkChip view="profiles" onClick={() => {}}>
          프로파일로
        </LinkChip>
        <LinkChip onClick={() => {}}>실행</LinkChip>
        <ChatChip agent="ma">대화</ChatChip>
      </MemoryRouter>
    );
    const icon = (name: string) => screen.getByText(name).closest('.MuiChip-root')?.querySelector('svg')?.getAttribute('data-testid');
    expect(icon('크론으로')).toBe('ScheduleOutlinedIcon');
    expect(icon('프로파일로')).toBe('BadgeOutlinedIcon');
    expect(icon('대화')).toBe('ChatBubbleOutlineIcon');
    // 가는 화면이 없는 동작 칩은 아이콘이 없다
    expect(icon('실행')).toBeUndefined();
  });

  it('LinkChip 의 onClick 은 이동 대신 실행할 일이 있을 때 쓴다', async () => {
    const user = userEvent.setup();
    const run = vi.fn();
    render(
      <MemoryRouter>
        <LinkChip onClick={run}>실행</LinkChip>
      </MemoryRouter>
    );
    await user.click(screen.getByRole('button', { name: '실행' }));
    expect(run).toHaveBeenCalledOnce();
  });

  it('LinkChip 으로 이동하면 열려 있던 서랍이 닫힌다', async () => {
    const user = userEvent.setup();
    function Probe() {
      const { drawer, openDrawer } = useUi();
      return (
        <>
          <button onClick={() => openDrawer({ title: 't', body: null })}>열기</button>
          <div data-testid="open">{String(!!drawer)}</div>
        </>
      );
    }
    render(
      <MemoryRouter>
        <UiProvider>
          <Probe />
          <LinkChip to="cron">크론으로</LinkChip>
        </UiProvider>
      </MemoryRouter>
    );
    await user.click(screen.getByRole('button', { name: '열기' }));
    expect(screen.getByTestId('open')).toHaveTextContent('true');
    await user.click(screen.getByRole('link', { name: '크론으로' }));
    expect(screen.getByTestId('open')).toHaveTextContent('false');
  });

  it('LinkChip 은 주소에 묶인(keep) 서랍은 남긴다 — 같은 프로파일로 가는 링크가 그 서랍을 닫지 않게(스펙 2026-10-16-010 14-10)', async () => {
    const user = userEvent.setup();
    function Probe() {
      const { drawers, openDrawer } = useUi();
      return (
        <>
          <button onClick={() => openDrawer({ id: 'route:name', keep: true, title: '프로파일', body: null })}>상세</button>
          <button onClick={() => openDrawer({ title: '받은편지함', body: null })}>받은편지함</button>
          <div data-testid="stack">{drawers.map((d) => d.title).join(',')}</div>
        </>
      );
    }
    render(
      <MemoryRouter>
        <UiProvider>
          <Probe />
          <LinkChip to="profiles" params={{ name: 'main', server: 'jira' }}>
            MCP 탭 열기
          </LinkChip>
        </UiProvider>
      </MemoryRouter>
    );
    await user.click(screen.getByRole('button', { name: '상세' }));
    await user.click(screen.getByRole('button', { name: '받은편지함' }));
    expect(screen.getByTestId('stack')).toHaveTextContent('프로파일,받은편지함');
    await user.click(screen.getByRole('link', { name: 'MCP 탭 열기' }));
    expect(screen.getByTestId('stack')).toHaveTextContent('프로파일');
    expect(screen.getByTestId('stack')).not.toHaveTextContent('받은편지함');
  });
});

describe('서랍 안 KV 의 표 머리와 섹션 제목', () => {
  const pairs: [string, string][] = [
    ['세션', '0'],
    ['메시지', '3'],
  ];
  const inDrawer = (ui: React.ReactNode) => render(<InDrawerContext.Provider value>{ui}</InDrawerContext.Provider>);

  it('서랍 안에서는 「기본 정보」 제목과 「항목·값」 머리줄을 둔다', () => {
    const { container } = inDrawer(<KV pairs={pairs} />);
    expect(screen.getByRole('heading', { level: 3, name: '기본 정보' })).toBeInTheDocument();
    const head = container.querySelector('[data-kv-head]') as HTMLElement;
    expect(head).toHaveTextContent('항목');
    expect(head).toHaveTextContent('값');
    expect(head).toHaveAttribute('aria-hidden', 'true'); // 보조기기는 dt·dd 로 이미 쌍을 읽는다
    expect(container.querySelectorAll('dt')).toHaveLength(3); // 머리줄 1 + 쌍 2
  });

  it('이미 Section 안에 있는 KV 는 제목을 더하지 않고 머리줄만 둔다', () => {
    const { container } = inDrawer(
      <Section title="실행">
        <KV pairs={pairs} />
      </Section>
    );
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['실행']);
    expect(container.querySelector('[data-kv-head]')).not.toBeNull();
  });

  it('서랍 밖 화면의 KV 는 지금처럼 머리줄·제목이 없다', () => {
    const { container } = render(<KV pairs={pairs} />);
    expect(screen.queryByRole('heading')).toBeNull();
    expect(container.querySelector('[data-kv-head]')).toBeNull();
  });

  it('보일 쌍이 하나도 없으면 아무것도 그리지 않는다', () => {
    const { container } = inDrawer(<KV pairs={[['빈 값', '']]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('「쓰는 곳」 이름의 접두어로 화면을 고른다 — 옛 「크론」 과 새 「예약 작업」(OMAI-1313) 모두', () => {
    render(
      <MemoryRouter>
        <UsedByLinks labels={['예약 작업 daily', '크론 weekly', 'Scheduled job hourly', '스킬 report', '스크립트 a.py']} />
      </MemoryRouter>
    );
    const href = (name: string) => screen.getByRole('link', { name }).getAttribute('href');
    expect(href('예약 작업 daily')).toBe('/cron?tab=profiles&q=daily');
    expect(href('크론 weekly')).toBe('/cron?tab=profiles&q=weekly');
    expect(href('Scheduled job hourly')).toBe('/cron?tab=profiles&q=hourly');
    expect(href('스킬 report')).toContain('/skills');
    expect(href('스크립트 a.py')).toContain('/tools');
  });
});

describe('IssueList 안내 단계(스펙 2026-10-24-003 D13)', () => {
  it('안내는 맨 뒤에 「안내」로 보이고 to 가 있으면 그 화면으로 가는 칩을 단다', () => {
    render(
      <MemoryRouter>
        <IssueList
          issues={[
            { level: 'info', text: '스킬 새 버전 1개', to: { view: 'market', params: { tab: 'updates', q: 'work' } } },
            { level: 'warn', text: '모델 없음' },
          ]}
        />
      </MemoryRouter>
    );
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('주의');
    expect(items[1]).toHaveTextContent('안내');
    expect(screen.getByRole('link', { name: /열기/ })).toHaveAttribute('href', '/market?tab=updates&q=work');
  });

  it('안내는 고칠 것(주의·문제) 수에 들지 않는다', () => {
    expect(actionable([{ level: 'info' }, { level: 'warn' }, { level: 'bad' }]).map((i) => i.level)).toEqual(['warn', 'bad']);
  });
});
