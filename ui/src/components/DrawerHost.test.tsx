/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clampDetailDrawerWidth, DETAIL_DRAWER_KEY_STEP, initialDetailDrawerWidth } from '@/lib/detailDrawer';

import { ScreenLoading } from './bits';
import { DrawerHost } from './DrawerHost';
import { UiProvider, useUi } from './UiContext';

describe('detailDrawer 폭 규칙', () => {
  it('처음 폭은 1100px 와 화면의 55% 중 작은 값이다', () => {
    expect(initialDetailDrawerWidth(2560)).toBe(1100);
    expect(initialDetailDrawerWidth(1280)).toBe(704);
  });

  it('끈 폭은 500px 이상, 화면의 80% 이하로 맞춘다', () => {
    expect(clampDetailDrawerWidth(200, 1600)).toBe(500);
    expect(clampDetailDrawerWidth(1500, 1600)).toBe(1280);
    expect(clampDetailDrawerWidth(900, 1600)).toBe(900);
  });

  it('화면이 좁아 80% 가 500px 보다 작으면 화면 밖으로 나가지 않게 80% 를 따른다', () => {
    expect(clampDetailDrawerWidth(700, 600)).toBe(480);
  });
});

// jsdom 에는 PointerEvent 가 없어 fireEvent.pointer* 가 clientX·button 을 버린다. MouseEvent 로 대신한다.
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

describe('DrawerHost', () => {
  const innerWidth = window.innerWidth;
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 });
  });
  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
    document.body.style.removeProperty('cursor');
    document.body.style.removeProperty('user-select');
  });

  function Opener() {
    const { openDrawer } = useUi();
    return (
      <button onClick={() => openDrawer({ title: '게이트웨이 변경', sub: '프로파일', body: <p>본문</p> })}>열기</button>
    );
  }

  async function open() {
    const user = userEvent.setup();
    render(
      <UiProvider>
        <Opener />
        <DrawerHost />
      </UiProvider>
    );
    await user.click(screen.getByRole('button', { name: '열기' }));
    return user;
  }

  it('제목·부제·닫기 단추를 머리에 둔다', async () => {
    const user = await open();
    const dialog = screen.getByRole('dialog', { name: '게이트웨이 변경' });
    expect(dialog).toHaveTextContent('프로파일');
    expect(dialog).toHaveTextContent('본문');
    await user.click(screen.getByRole('button', { name: '닫기' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('왼쪽 손잡이를 끌면 폭이 바뀌고, 놓으면 커서가 돌아온다', async () => {
    await open();
    const handle = screen.getByRole('separator', { name: '상세 패널 폭 조절' });
    expect(handle).toHaveAttribute('aria-valuenow', String(initialDetailDrawerWidth(1600)));

    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 720 });
    expect(document.body.style.cursor).toBe('ew-resize');
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 600 });
    expect(handle).toHaveAttribute('aria-valuenow', '1000');
    // 너무 왼쪽으로 끌면 화면의 80% 에서 멈춘다
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 10 });
    expect(handle).toHaveAttribute('aria-valuenow', '1280');
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(document.body.style.cursor).toBe('');

    // 놓은 뒤에는 움직여도 바뀌지 않는다
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 900 });
    expect(handle).toHaveAttribute('aria-valuenow', '1280');
  });

  it('키보드 ←·→ 로도 폭을 바꾼다', async () => {
    await open();
    const handle = screen.getByRole('separator');
    const start = Number(handle.getAttribute('aria-valuenow'));
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(handle).toHaveAttribute('aria-valuenow', String(start + DETAIL_DRAWER_KEY_STEP));
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(handle).toHaveAttribute('aria-valuenow', String(start - DETAIL_DRAWER_KEY_STEP));
  });

  // 처음 그릴 때 한 번만 화면 폭으로 계산해, 좁은 창에서 연 뒤 넓히면 215px(390px 의 55%) 서랍이 남았다(2026-10-23 OKE 확인)
  const resizeTo = (w: number) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
  };

  it('창 크기가 바뀌면, 끌어서 정하지 않은 폭은 새 화면의 처음 폭으로 다시 맞춘다', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    await open();
    resizeTo(1600);
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', String(initialDetailDrawerWidth(1600)));
  });

  it('끌어서 정한 폭은 창 크기가 바뀌어도 남기되 허용 범위(500px~화면의 80%) 안으로 맞춘다', async () => {
    await open();
    const handle = screen.getByRole('separator');
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 720 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 600 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(handle).toHaveAttribute('aria-valuenow', '1000');
    resizeTo(2000);
    expect(handle).toHaveAttribute('aria-valuenow', '1000');
    resizeTo(1000);
    expect(handle).toHaveAttribute('aria-valuenow', '800');
  });

  it('바꾼 폭은 닫았다 다시 열어도 유지된다', async () => {
    const user = await open();
    const handle = screen.getByRole('separator');
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 720 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 800 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    await user.click(screen.getByRole('button', { name: '닫기' }));
    await user.click(screen.getByRole('button', { name: '열기' }));
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '800');
  });
});

describe('서랍 안 불러오는 중(사용자 보고 2026-10-14)', () => {
  // 서랍 머리에 이미 제목이 있는데 본문의 ScreenLoading 이 같은 제목(아이콘 붙은 h1)을 한 번 더 그렸다. 서랍 안에서는 진행 막대만
  function Opener({ error }: { error?: string }) {
    const { openDrawer } = useUi();
    return (
      <button onClick={() => openDrawer({ title: 'test1', sub: '프로파일 상세', body: <ScreenLoading title="test1" error={error} /> })}>
        열기
      </button>
    );
  }
  const mount = (error?: string) =>
    render(
      <MemoryRouter initialEntries={['/profiles']}>
        <UiProvider>
          <Opener error={error} />
          <DrawerHost />
        </UiProvider>
      </MemoryRouter>
    );

  it('서랍 안에서는 제목 없이 진행 막대만 보인다', async () => {
    mount();
    await userEvent.setup().click(screen.getByRole('button', { name: '열기' }));
    const dialog = screen.getByRole('dialog', { name: 'test1' });
    expect(within(dialog).queryByRole('heading', { level: 1 })).toBeNull();
    expect(within(dialog).getAllByText('test1')).toHaveLength(1); // 서랍 머리의 제목 하나
    expect(within(dialog).getByRole('progressbar')).toBeInTheDocument();
  });

  it('서랍 안에서도 오류는 알림으로 보인다', async () => {
    mount('읽지 못했습니다');
    await userEvent.setup().click(screen.getByRole('button', { name: '열기' }));
    expect(within(screen.getByRole('dialog')).getByRole('alert')).toHaveTextContent('읽지 못했습니다');
  });

  it('서랍 밖(화면)에서는 지금처럼 제목과 진행 막대를 보인다', () => {
    render(
      <MemoryRouter initialEntries={['/profiles']}>
        <ScreenLoading title="프로파일" />
      </MemoryRouter>
    );
    expect(screen.getByRole('heading', { level: 1, name: '프로파일' })).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });
});

describe('서랍 제목 앞 아이콘', () => {
  function Opener() {
    const { openDrawer } = useUi();
    return <button onClick={() => openDrawer({ title: 'test1', sub: '프로파일 상세', body: <p>본문</p> })}>열기</button>;
  }

  it('지금 화면의 아이콘을 서랍 제목 앞에 두고, 아이콘은 읽는 이름에 섞이지 않는다', async () => {
    render(
      <MemoryRouter initialEntries={['/profiles?name=test1']}>
        <UiProvider>
          <Opener />
          <DrawerHost />
        </UiProvider>
      </MemoryRouter>
    );
    await userEvent.setup().click(screen.getByRole('button', { name: '열기' }));
    const dialog = screen.getByRole('dialog', { name: 'test1' }); // 읽는 이름은 제목 그대로
    const title = within(dialog).getByRole('heading', { level: 2, name: 'test1' });
    const icon = dialog.querySelector('[data-drawer-icon] svg') as SVGElement;
    expect(icon).toHaveAttribute('data-testid', 'BadgeOutlinedIcon'); // 프로파일 화면 아이콘(본문 제목과 같은 것)
    expect(icon).toHaveAttribute('aria-hidden', 'true');
    expect(icon.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // 제목보다 앞
  });

  it('라우터 밖이나 모르는 주소에서는 아이콘 없이 그린다', async () => {
    render(
      <UiProvider>
        <Opener />
        <DrawerHost />
      </UiProvider>
    );
    await userEvent.setup().click(screen.getByRole('button', { name: '열기' }));
    expect(screen.getByRole('dialog').querySelector('[data-drawer-icon]')).toBeNull();
  });
});


describe('DrawerHost 부제 앞 요소·제목 초점(스펙 2026-10-19-011 D5·D7)', () => {
  function Reopen() {
    const { openDrawer } = useUi();
    const open = (pod: string) =>
      openDrawer({ id: 'route:name', keep: true, title: 'main', sub: `${pod}의 프로파일`, subLead: <i data-lead={pod} />, focusKey: pod, body: <p>본문</p> });
    return (
      <>
        <button onClick={() => open('p1')}>p1</button>
        <button onClick={() => open('p2')}>p2</button>
        <button onClick={() => openDrawer({ title: '보통 서랍', sub: '부제', body: <p>본문</p> })}>보통</button>
      </>
    );
  }
  const mountHost = () =>
    render(
      <MemoryRouter>
        <UiProvider>
          <Reopen />
          <DrawerHost />
        </UiProvider>
      </MemoryRouter>
    );

  it('인자가 없는 서랍은 지금과 같다 — 제목은 초점을 받지 않고 부제 앞 요소가 없다', () => {
    mountHost();
    fireEvent.click(screen.getByText('보통'));
    const title = screen.getByRole('heading', { name: '보통 서랍' });
    expect(title).not.toHaveAttribute('tabindex');
    expect(document.querySelector('[data-lead]')).toBeNull();
  });

  it('부제 앞에 요소를 두고, 같은 서랍을 다른 focusKey 로 다시 열면 제목에 초점을 옮긴다(처음 열 때는 아님)', () => {
    mountHost();
    fireEvent.click(screen.getByText('p1'));
    expect(document.querySelector('[data-lead="p1"]')).not.toBeNull();
    const title = screen.getByRole('heading', { name: 'main' });
    expect(title).toHaveAttribute('tabindex', '-1');
    expect(document.activeElement).not.toBe(title);
    fireEvent.click(screen.getByText('p2', { selector: 'button' }));
    expect(document.querySelector('[data-lead="p2"]')).not.toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'main' }));
  });
});
