/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Composer, ComposerHandle, ComposerProps, ComposerSuggest } from './Composer';

function Harness(p: Partial<ComposerProps> & { onSend: () => void }) {
  const [v, setV] = useState(p.value ?? '');
  return (
    <Composer
      value={v}
      onChange={setV}
      sendOn="enter"
      canSend={!!v.trim()}
      inputLabel="메시지"
      sendLabel="보내기"
      {...p}
    />
  );
}
const box = () => screen.getByRole('textbox', { name: '메시지' });

describe('Composer', () => {
  it('Enter 로 보내고 Shift+Enter 는 줄바꿈이다', async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSend={onSend} />);
    await user.type(box(), '가{Shift>}{Enter}{/Shift}나');
    expect(onSend).not.toHaveBeenCalled();
    expect(box()).toHaveValue('가\n나');
    await user.type(box(), '{Enter}');
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('보낼 수 없을 때(canSend=false) Enter 는 아무것도 보내지 않고 줄바꿈도 만들지 않는다', async () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} canSend={false} value="  " />);
    const e = fireEvent.keyDown(box(), { key: 'Enter' });
    expect(e).toBe(false); // preventDefault 됨
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '보내기' })).toBeDisabled();
  });

  it('한글 조합 중 Enter 를 누른 순간에는 보내지 않는다', () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} value="안녕" />);
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  // 사용자 보고(2026-10-16): 「알려줘」처럼 끝 글자가 조합 중일 때 Enter 를 누르면 그 Enter 는 글자 확정에만 쓰여 보내지지 않았다.
  // Ctrl 을 먼저 누르면 조합이 끝나 Ctrl+Enter 만 보내졌다. 조합 중 Enter 는 기억했다가 조합이 끝나면 보낸다.
  it('한글 조합 중 Enter 는 조합이 끝난 뒤 한 번 보낸다', () => {
    vi.useFakeTimers();
    try {
      const onSend = vi.fn();
      render(<Harness onSend={onSend} value="알려줘" />);
      fireEvent.keyDown(box(), { key: 'Enter', isComposing: true });
      expect(onSend).not.toHaveBeenCalled();
      fireEvent.compositionEnd(box());
      vi.advanceTimersByTime(50);
      expect(onSend).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('조합이 끝난 뒤 브라우저가 Enter 를 한 번 더 보내도 두 번 보내지 않는다', () => {
    vi.useFakeTimers();
    try {
      const onSend = vi.fn();
      render(<Harness onSend={onSend} value="알려줘" />);
      fireEvent.keyDown(box(), { key: 'Enter', isComposing: true });
      fireEvent.compositionEnd(box());
      expect(fireEvent.keyDown(box(), { key: 'Enter' })).toBe(false); // 줄바꿈도 막는다
      vi.advanceTimersByTime(200);
      expect(onSend).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('조합 중 Shift+Enter 는 조합이 끝나도 보내지 않는다', () => {
    vi.useFakeTimers();
    try {
      const onSend = vi.fn();
      render(<Harness onSend={onSend} value="가" />);
      fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true, isComposing: true });
      fireEvent.compositionEnd(box());
      vi.advanceTimersByTime(200);
      expect(onSend).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sendOn='enter' 에서 Ctrl+Enter 도 보낸다(회의에서 쓰던 손에 익은 키)", () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} value="말" />);
    fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("sendOn='mod-enter' 는 Enter 로 보내지 않고 Ctrl+Enter 로만 보낸다", () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} sendOn="mod-enter" value="말" />);
    expect(fireEvent.keyDown(box(), { key: 'Enter' })).toBe(true); // 줄바꿈은 브라우저가
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box(), { key: 'Enter', metaKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('답하는 중에는 같은 자리가 중지 단추가 되고 누르면 onStop', async () => {
    const onStop = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSend={vi.fn()} busy onStop={onStop} stopLabel="답변 중단" value="x" />);
    expect(screen.queryByRole('button', { name: '보내기' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '답변 중단' }));
    expect(onStop).toHaveBeenCalled();
  });

  it('focus() 가 입력칸으로 포커스를 돌린다', () => {
    const ref = createRef<ComposerHandle>();
    render(<Composer ref={ref} value="" onChange={() => {}} onSend={() => {}} sendOn="enter" canSend={false} inputLabel="메시지" sendLabel="보내기" />);
    expect(box()).not.toHaveFocus();
    ref.current?.focus();
    expect(box()).toHaveFocus();
  });

  it('compact 에서도 첨부는 왼쪽 끝, 전송은 오른쪽 끝이다(키 안내가 숨어도 안내 글이 사이를 채운다)', () => {
    render(<Harness onSend={vi.fn()} hint="Enter 전송" compact leading={<button type="button">첨부</button>} />);
    const send = screen.getByRole('button', { name: '보내기' });
    const spacer = send.previousElementSibling as HTMLElement; // 전송 바로 앞 = 안내 글 칸
    expect(spacer).not.toBeNull();
    expect(getComputedStyle(spacer).flexGrow).toBe('1');
    expect(getComputedStyle(spacer).position).not.toBe('absolute'); // 숨긴 키 안내(position: absolute)는 flex 자리를 못 채운다
    expect(send.parentElement?.firstElementChild).toContainElement(screen.getByRole('button', { name: '첨부' })); // 줄의 첫 칸이 첨부, 마지막이 전송
  });

  it('키 안내와 추가 설명이 입력칸의 aria-describedby 로 이어진다. compact 는 눈에서만 숨긴다', () => {
    render(<Harness onSend={vi.fn()} hint="Enter 전송" describedBy="why" compact />);
    const ids = (box().getAttribute('aria-describedby') ?? '').split(' ');
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe('why');
    const hint = document.getElementById(ids[0]) as HTMLElement;
    expect(hint).toHaveTextContent('Enter 전송');
    expect(getComputedStyle(hint).position).toBe('absolute'); // 시각적으로 숨김(읽기는 가능)
  });

  it('전송 단추 바로 앞에 작은 글씨로 실수 가능 안내를 둔다(키 안내와 별개라 compact 에서도 보인다)', () => {
    render(<Harness onSend={vi.fn()} hint="Enter 전송" compact />);
    const note = screen.getByText('CogentAI는 실수를 할 수 있습니다. 응답을 다시 확인해 주세요.');
    expect(screen.getByRole('button', { name: '보내기' }).previousElementSibling).toBe(note);
    expect(getComputedStyle(note).fontSize).toBe('10px'); // 키 안내(11px)보다 한 단계 작게
    expect(getComputedStyle(note).position).not.toBe('absolute');
    expect(getComputedStyle(note).whiteSpace).toBe('nowrap'); // 좁으면 줄을 바꾸지 않고 말줄임표
  });

  it('키 안내가 보이는 화면에서는 키 안내는 제 폭만 쓰고 남는 폭은 그 뒤 전송 앞의 안내 글이 쓴다', () => {
    render(<Harness onSend={vi.fn()} hint="Enter 전송" />);
    const note = screen.getByText(/실수를 할 수 있습니다/);
    const hint = screen.getByText('Enter 전송');
    expect(getComputedStyle(hint).flexGrow).toBe('0');
    expect(getComputedStyle(hint).flexShrink).toBe('0'); // 좁을 때 줄어드는 쪽은 안내 글이다
    expect(getComputedStyle(note).flexGrow).toBe('1');
    expect(hint.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

// 「/」 스킬·「@」 에이전트 고르기 목록(스펙 2026-10-19-012 P3, 디자인 DD1~DD12)
describe('Composer 고르기 목록', () => {
  const items = [
    { value: '/요약', label: '/요약', detail: '주간 업무를 요약합니다' },
    { value: '/web-research', label: '/web-research', detail: '웹 검색' },
  ];
  const source = (over: Partial<ComposerSuggest> = {}): ComposerSuggest => ({
    trigger: '/',
    where: 'start',
    title: '스킬',
    items,
    noMatchText: '맞는 스킬이 없습니다',
    countText: (n) => `스킬 ${n}개`,
    loadingText: '스킬 목록을 읽는 중…',
    errorText: '스킬 목록을 읽지 못했습니다',
    emptyText: '쓸 수 있는 스킬이 없습니다',
    emptyLink: { href: '#/skills', label: '스킬 화면' },
    touchButton: '스킬 고르기',
    ...over,
  });
  const list = () => screen.queryByRole('listbox', { name: '스킬' });

  it('글 맨 앞 / 에서 열리고 Enter 는 보내지 않고 고른다. 고른 뒤 공백 하나', async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSend={onSend} suggest={[source()]} />);
    await user.type(box(), '/요');
    expect(list()).toBeInTheDocument();
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['/요약주간 업무를 요약합니다']);
    expect(box()).toHaveAttribute('aria-activedescendant', screen.getByRole('option').id);
    await user.keyboard('{Enter}');
    expect(onSend).not.toHaveBeenCalled();
    expect(box()).toHaveValue('/요약 ');
    expect(list()).toBeNull(); // 공백 뒤에는 닫힌다
    await user.keyboard('정리{Enter}');
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('위/아래로 옮기고 Tab 으로 고른다. 글 중간의 / 에는 열리지 않는다', async () => {
    const user = userEvent.setup();
    render(<Harness onSend={vi.fn()} suggest={[source()]} />);
    await user.type(box(), '/');
    await user.keyboard('{ArrowDown}{Tab}');
    expect(box()).toHaveValue('/web-research ');
    await user.clear(box());
    await user.type(box(), '경로 /etc');
    expect(list()).toBeNull();
  });

  it('맞는 것이 0개면 닫히고 Enter 로 보낸다(DD2). 목록이 열려 있어도 Ctrl+Enter 는 보낸다(R6)', async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSend={onSend} suggest={[source()]} />);
    await user.type(box(), '/zz');
    expect(list()).toBeNull();
    await user.keyboard('{Enter}');
    expect(onSend).toHaveBeenCalledTimes(1);
    await user.clear(box());
    await user.type(box(), '/요');
    expect(list()).toBeInTheDocument();
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(onSend).toHaveBeenCalledTimes(2);
  });

  it('Esc 는 목록만 닫고(바깥으로 전하지 않는다, DD10) 그 낱말이 바뀔 때까지 다시 열지 않는다', async () => {
    const outer = vi.fn();
    const user = userEvent.setup();
    render(
      // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- 서랍·창처럼 바깥에서 Esc 를 받는 자리를 흉내 낸다
      <div onKeyDown={(e) => e.key === 'Escape' && outer()}>
        <Harness onSend={vi.fn()} suggest={[source()]} />
      </div>
    );
    await user.type(box(), '/요');
    await user.keyboard('{Escape}');
    expect(list()).toBeNull();
    expect(outer).not.toHaveBeenCalled();
    await user.keyboard('{ArrowLeft}{ArrowRight}');
    expect(list()).toBeNull();
    await user.keyboard('약');
    expect(list()).toBeInTheDocument();
    await user.keyboard('{Escape}{Escape}');
    expect(outer).toHaveBeenCalledTimes(1); // 닫힌 뒤의 Esc 는 지금처럼 바깥으로 간다
  });

  it('한글 조합을 끝낸 Enter 는 목록이 열려 있으면 고르기다(R6)', async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSend={onSend} suggest={[source()]} />);
    await user.type(box(), '/요');
    expect(list()).toBeInTheDocument();
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true });
    fireEvent.compositionEnd(box());
    await new Promise((r) => setTimeout(r, 60));
    expect(onSend).not.toHaveBeenCalled();
    expect(box()).toHaveValue('/요약 ');
  });

  it('읽는 중·실패(다시 시도)·빈 목록(스킬 화면) 줄. 이때 Enter 는 보내기다(DD3)', async () => {
    const onSend = vi.fn();
    const onRetry = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<Harness onSend={onSend} suggest={[source({ items: null })]} />);
    await user.type(box(), '/');
    expect(screen.getByText('스킬 목록을 읽는 중…')).toBeInTheDocument();
    rerender(<Harness onSend={onSend} suggest={[source({ items: [], error: true, onRetry })]} />);
    await user.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(onRetry).toHaveBeenCalled();
    rerender(<Harness onSend={onSend} suggest={[source({ items: [] })]} />);
    expect(screen.getByRole('link', { name: '스킬 화면' })).toHaveAttribute('href', '#/skills');
    await user.click(box());
    await user.keyboard('{Enter}');
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('처음 열릴 때 onOpen 을 부른다', async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSend={vi.fn()} suggest={[source({ onOpen })]} />);
    await user.type(box(), '그냥 글');
    expect(onOpen).not.toHaveBeenCalled();
    await user.clear(box());
    await user.type(box(), '/');
    expect(onOpen).toHaveBeenCalled();
  });

  it('개수 알림은 300ms 모아 한 번(DD12)', () => {
    vi.useFakeTimers();
    try {
      render(<Harness onSend={vi.fn()} suggest={[source()]} />);
      fireEvent.focus(box());
      fireEvent.change(box(), { target: { value: '/', selectionStart: 1, selectionEnd: 1 } });
      fireEvent.change(box(), { target: { value: '/요', selectionStart: 2, selectionEnd: 2 } });
      const live = document.querySelector('[aria-live="polite"]') as HTMLElement;
      expect(live.textContent).toBe('');
      act(() => vi.advanceTimersByTime(350));
      expect(live.textContent).toBe('스킬 1개');
    } finally {
      vi.useRealTimers();
    }
  });

  it('줄을 눌러 골라도 입력칸이 포커스를 잃지 않는다(DD11). 손가락 화면 「/」 단추는 맨 앞에 / 를 넣는다(DD7)', async () => {
    const user = userEvent.setup();
    render(<Harness onSend={vi.fn()} suggest={[source()]} />);
    await user.type(box(), '정리해 줘');
    fireEvent.click(screen.getByLabelText('스킬 고르기')); // 손가락 화면(pointer: coarse)에서만 보인다 — jsdom 은 숨김으로 본다
    expect(box()).toHaveValue('/ 정리해 줘');
    await user.click(screen.getAllByRole('option')[0]);
    expect(box()).toHaveValue('/요약 정리해 줘');
    expect(box()).toHaveFocus();
  });

  it('note 는 compact 에서도 보인다(DD6)', () => {
    render(<Harness onSend={vi.fn()} compact note="· 스킬 /요약 으로 보냅니다" />);
    expect(screen.getByText('· 스킬 /요약 으로 보냅니다')).toBeVisible();
    expect(box().getAttribute('aria-describedby')).toContain(screen.getByText('· 스킬 /요약 으로 보냅니다').id);
  });
});
