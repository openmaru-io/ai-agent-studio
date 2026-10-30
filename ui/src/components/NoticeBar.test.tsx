/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 공지 띠(스펙 2026-10-24-007 1B·1C·2A·3E·5B·5C·6B)
import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Notice } from '@/lib/useNotices';

import { NoticeBarView, noticeLink, noticeRange, noticeUntil } from './NoticeBar';

const N = (id: number, kind: Notice['kind'], extra: Partial<Notice> = {}): Notice => ({
  id,
  kind,
  title: `제목${id}`,
  body: '',
  link: '',
  starts_at: '2026-10-24T00:00:00+00:00',
  ends_at: '2099-01-01T00:00:00+00:00',
  dismissible: kind !== 'outage',
  updated_ts: 't',
  reshow_ts: 'r',
  ...extra,
});

/** 닫기를 실제로 반영하는 틀(닫은 공지를 목록에서 뺀다) */
function Harness({ initial, narrow }: { initial: Notice[]; narrow?: boolean }) {
  const [items, setItems] = useState(initial);
  return (
    <>
      <NoticeBarView items={items} narrow={narrow} onDismiss={(n) => setItems((l) => l.filter((x) => x.id !== n.id))} />
      <button onClick={() => setItems((l) => l.slice(0, -1))}>마지막 빼기</button>
    </>
  );
}

const bar = () => screen.getByRole('complementary', { name: '공지' });
const pos = () => bar().querySelector('[data-notice-pos]')?.textContent;

afterEach(() => vi.restoreAllMocks());

describe('NoticeBarView', () => {
  it('한 번에 하나를 보이고 「1/3」과 이전·다음 단추로 넘긴다. 하나면 넘기기가 없다', () => {
    const { rerender } = render(<NoticeBarView items={[N(1, 'maintenance'), N(2, 'feature'), N(3, 'info')]} />);
    expect(within(bar()).getByText('제목1')).toBeInTheDocument();
    expect(pos()).toBe('1/3');
    fireEvent.click(screen.getByRole('button', { name: '다음 공지(2/3)' }));
    expect(within(bar()).getByText('제목2')).toBeInTheDocument();
    expect(pos()).toBe('2/3');
    fireEvent.click(screen.getByRole('button', { name: '이전 공지' }));
    expect(pos()).toBe('1/3');
    rerender(<NoticeBarView items={[N(1, 'maintenance')]} />);
    expect(screen.queryByRole('button', { name: '이전 공지' })).toBeNull();
    expect(pos()).toBeUndefined();
  });

  it('종류 이름이 글자로 보이고(1B) 닫을 수 있는 공지만 닫기 단추가 있다', () => {
    const { rerender } = render(<NoticeBarView items={[N(1, 'deprecation')]} />);
    expect(within(bar()).getByText('중단 예정')).toBeVisible();
    expect(screen.getByRole('button', { name: '이 공지 닫기' })).toBeInTheDocument();
    rerender(<NoticeBarView items={[N(2, 'outage')]} />);
    expect(screen.queryByRole('button', { name: '이 공지 닫기' })).toBeNull();
  });

  it('닫으면 같은 순번에 다음 공지가 오고, 보던 공지가 빠지면 같은 순번(넘치면 마지막)을 보인다(2A)', () => {
    render(<Harness initial={[N(1, 'maintenance'), N(2, 'feature'), N(3, 'info')]} />);
    fireEvent.click(screen.getByRole('button', { name: '다음 공지(2/3)' }));
    fireEvent.click(screen.getByRole('button', { name: '이 공지 닫기' }));
    expect(within(bar()).getByText('제목3')).toBeInTheDocument();
    expect(pos()).toBe('2/2');
    fireEvent.click(screen.getByText('마지막 빼기'));
    expect(within(bar()).getByText('제목1')).toBeInTheDocument();
    expect(pos()).toBeUndefined();
  });

  it('다른 공지를 보는 동안 장애 공지가 있으면 빨간 점 단추가 있고 누르면 장애 공지로 간다. 자동으로 넘기지 않는다(3E)', () => {
    render(<NoticeBarView items={[N(1, 'outage'), N(2, 'maintenance')]} />);
    expect(screen.queryByRole('button', { name: '장애 공지 있음' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '다음 공지(2/2)' }));
    expect(bar()).toHaveAttribute('data-notice-kind', 'maintenance');
    fireEvent.click(screen.getByRole('button', { name: '장애 공지 있음' }));
    expect(bar()).toHaveAttribute('data-notice-kind', 'outage');
  });

  it('넓은 화면은 띠에 제목만 두고 「자세히」가 없으며, 제목에 올리거나 포커스하면 풍선말에 제목·내용 전체·기간이 보인다', async () => {
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(500);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100);
    const item = N(1, 'feature', { body: '마이크 단추로 말하면 글이 됩니다', link: '#/chat' });
    render(<NoticeBarView items={[item]} />);
    expect(screen.queryByRole('button', { name: '자세히' })).toBeNull();
    expect(screen.queryByRole('tooltip')).toBeNull();
    const title = bar().querySelector<HTMLElement>('[data-notice-title]')!;
    expect(title).toHaveAttribute('tabindex', '0');
    fireEvent.mouseOver(title);
    const tip = await screen.findByRole('tooltip');
    expect(within(tip).getByText('마이크 단추로 말하면 글이 됩니다')).toBeInTheDocument();
    expect(tip.querySelector('[data-notice-range]')?.textContent).toBe(noticeRange(item));
    expect(within(bar()).getByRole('link', { name: '바로 가기' })).toHaveAttribute('href', '#/chat');
  });

  it('닫기 단추가 없어도 가운데 묶음 양옆에 같은 폭의 칸이 있다', () => {
    const { rerender } = render(<NoticeBarView items={[N(1, 'info')]} />);
    const row = () => bar().querySelector('[data-notice-center]')!.parentElement!;
    expect(row().children).toHaveLength(3);
    rerender(<NoticeBarView items={[N(2, 'outage')]} />);
    expect(row().children).toHaveLength(3);
    expect(screen.queryByRole('button', { name: '이 공지 닫기' })).toBeNull();
  });

  it('좁은 화면은 아이콘·제목만 보이고 글·기간·바로 가기는 「자세히」에서 본다', () => {
    render(<Harness narrow initial={[N(1, 'maintenance', { body: '오늘 밤 작업', link: '#/skills' })]} />);
    expect(bar().querySelector('[data-notice-kind-name]')).toBeNull();
    expect(within(bar()).queryByText('오늘 밤 작업')).toBeNull();
    expect(bar().querySelector('[data-notice-until]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '자세히' }));
    expect(within(bar()).getByText('오늘 밤 작업')).toBeInTheDocument();
    expect(within(bar()).getByRole('link', { name: '바로 가기' })).toHaveAttribute('href', '#/skills');
  });

  it('바로 가기: AAS 안 경로는 같은 탭, 바깥 주소는 새 탭(noopener noreferrer), 그 밖의 주소는 그리지 않는다', () => {
    const { rerender } = render(<NoticeBarView items={[N(1, 'info', { link: 'https://wiki.example/x' })]} />);
    const a = within(bar()).getByRole('link', { name: '바로 가기' });
    expect(a).toHaveAttribute('target', '_blank');
    expect(a).toHaveAttribute('rel', 'noopener noreferrer');
    rerender(<NoticeBarView items={[N(1, 'info', { link: '#/skills' })]} />);
    expect(within(bar()).getByRole('link', { name: '바로 가기' })).not.toHaveAttribute('target');
    rerender(<NoticeBarView items={[N(1, 'info', { link: 'javascript:alert(1)' })]} />);
    expect(within(bar()).queryByRole('link')).toBeNull();
    expect(noticeLink('javascript:alert(1)')).toBeNull();
  });

  it('미리 보기는 닫기·넘기기가 동작하지 않는다', () => {
    const onDismiss = vi.fn();
    render(<NoticeBarView preview items={[N(1, 'info'), N(2, 'info')]} onDismiss={onDismiss} />);
    expect(screen.getByRole('button', { name: '이 공지 닫기' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '이전 공지' })).toBeDisabled();
  });
});

describe('기간 표기(5C)', () => {
  const now = new Date(2026, 9, 25, 9, 0); // 10/25(일) 09:00, 브라우저 시간대
  it('작업·장애만, 같은 날이면 시각만', () => {
    expect(noticeUntil({ kind: 'maintenance', ends_at: new Date(2026, 9, 25, 22, 0).toISOString() }, now)).toBe('~22:00까지');
  });
  it('다른 날이면 날짜·요일, 자정은 다음 날 00:00 으로 적는다', () => {
    expect(noticeUntil({ kind: 'outage', ends_at: new Date(2026, 9, 26, 0, 0).toISOString() }, now)).toBe('~10/26(월) 00:00까지');
  });
  it('다른 종류는 띠에 기간을 적지 않는다', () => {
    expect(noticeUntil({ kind: 'info', ends_at: new Date(2026, 9, 25, 22, 0).toISOString() }, now)).toBe('');
  });
  it('펼친 판에는 시작 ~ 끝 전체', () => {
    expect(noticeRange({ starts_at: new Date(2026, 9, 24, 22, 0).toISOString(), ends_at: new Date(2026, 9, 25, 0, 0).toISOString() })).toBe(
      '10/24(토) 22:00 ~ 10/25(일) 00:00'
    );
  });
});
