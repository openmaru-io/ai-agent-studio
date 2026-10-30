/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { chatTokens } from '@/lib/chatTokens';

import { MessageRow } from './MessageRow';

describe('MessageRow', () => {
  it('내 말은 판에 담기고 아래 오른쪽에 foot 이 놓인다', () => {
    render(
      <MessageRow side="mine" foot={<span>16:01</span>}>
        안녕
      </MessageRow>
    );
    const body = screen.getByText('안녕');
    expect(getComputedStyle(body).whiteSpace).toBe('pre-wrap');
    expect(getComputedStyle(body).borderRadius).toBe('12px 12px 4px 12px');
    expect(screen.getByText('16:01')).toBeInTheDocument();
  });

  it('에이전트 답은 상자(테두리) 없이 본문 그대로이고, 머리줄에 이름과 시각이 있다', () => {
    render(
      <MessageRow side="agent" head={{ avatar: <i data-testid="av" />, name: 'main', time: '16:02' }}>
        <p>답변</p>
      </MessageRow>
    );
    const p = screen.getByText('답변');
    expect(getComputedStyle(p.parentElement as HTMLElement).borderStyle).not.toBe('solid');
    expect(screen.getByText('main')).toHaveAttribute('title', 'main');
    expect(screen.getByText('16:02')).toBeInTheDocument();
    expect(screen.getByTestId('av')).toBeInTheDocument();
  });

  it('머리줄이 없어도(이어 말하는 줄) 본문은 아바타 열 오른쪽 같은 선에 놓인다', () => {
    const { container } = render(
      <MessageRow side="agent">
        <p>이어서</p>
      </MessageRow>
    );
    const row = container.firstElementChild as HTMLElement;
    expect(row.children).toHaveLength(2); // 아바타 열(빈) + 본문
    expect(screen.queryByTitle(/./)).toBeNull();
  });

  it('actions 슬롯은 DOM 에 있어 키보드 포커스를 받을 수 있다(보임은 CSS 가 정한다)', () => {
    render(
      <MessageRow side="agent" actions={<button type="button">복사</button>}>
        본문
      </MessageRow>
    );
    const btn = screen.getByRole('button', { name: '복사' });
    btn.focus();
    expect(btn).toHaveFocus();
  });

  it('actions 줄은 평소 마우스를 올릴 때만 보이고, pinActions 면 늘 보인다(읽어 주기 준비·재생·오류, 스펙 2026-10-28-012 DD3)', () => {
    const { rerender } = render(
      <MessageRow side="agent" actions={<button type="button">복사</button>}>
        본문
      </MessageRow>
    );
    const bar = () => screen.getByRole('button', { name: '복사' }).parentElement as HTMLElement;
    expect(getComputedStyle(bar()).opacity).toBe('0');
    rerender(
      <MessageRow side="agent" pinActions actions={<button type="button">복사</button>}>
        본문
      </MessageRow>
    );
    expect(getComputedStyle(bar()).opacity).toBe('1');
  });

  it('본문 글자색은 대화 토큰의 text 색이다(라이트)', () => {
    render(
      <MessageRow side="mine">
        읽힘
      </MessageRow>
    );
    const hex = chatTokens.light.text; // #111827
    const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ');
    expect(getComputedStyle(screen.getByText('읽힘')).color).toBe(`rgb(${rgb})`);
  });
});
