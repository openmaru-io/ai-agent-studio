/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { Tag } from './bits';
import { DrawerBadges, DrawerNote } from './DrawerBadges';
import { DrawerHost } from './DrawerHost';
import { UiProvider, useUi } from './UiContext';

function Opener({ title, badges }: { title: string; badges: string[] }) {
  const { openDrawer } = useUi();
  return (
    <button
      onClick={() =>
        openDrawer({
          title,
          sub: '프로파일 상세',
          keep: title === 'default', // 아래 서랍으로 남는다(쌓임 시험)
          body: (
            <>
              <DrawerBadges>
                {badges.map((b) => (
                  <Tag key={b}>{b}</Tag>
                ))}
              </DrawerBadges>
              <DrawerNote>{title} 의 권한 안내</DrawerNote>
              <p>{title} 본문</p>
            </>
          ),
        })
      }
    >
      {title} 열기
    </button>
  );
}

function mount() {
  render(
    <UiProvider>
      <Opener title="default" badges={['기본', '게이트웨이 실행 중']} />
      <Opener title="ma" badges={['게이트웨이 꺼짐']} />
      <DrawerHost />
    </UiProvider>
  );
}

describe('서랍 제목 옆 상태 뱃지', () => {
  it('본문의 상태 뱃지는 서랍 머리의 제목 바로 옆에 그려지고, 제목의 읽는 이름은 그대로다', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: 'default 열기' }));
    const dialog = screen.getByRole('dialog', { name: 'default' });
    const head = dialog.querySelector('[data-drawer-head]') as HTMLElement;
    const slot = head.querySelector('[data-drawer-badges]') as HTMLElement;
    expect(within(slot).getByText('기본')).toBeInTheDocument();
    expect(within(slot).getByText('게이트웨이 실행 중')).toBeInTheDocument();
    const title = within(head).getByRole('heading', { name: 'default' });
    expect(title.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // 제목 다음
    expect(slot.parentElement).toBe(title.parentElement); // 제목과 같은 줄
    // 본문에는 남지 않는다
    expect(within(dialog).getByText('default 본문').parentElement?.textContent).not.toContain('기본');
  });

  it('서랍이 쌓이면 맨 위 서랍의 뱃지만 보인다', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: 'default 열기' }));
    await user.click(screen.getByRole('button', { name: 'ma 열기', hidden: true }));
    const slot = document.querySelector('[data-drawer-badges]') as HTMLElement;
    expect(slot).toHaveTextContent('게이트웨이 꺼짐');
    expect(slot).not.toHaveTextContent('기본');
  });

  it('서랍 밖(화면)에서는 놓인 자리에 그대로 그린다', () => {
    render(
      <DrawerBadges>
        <Tag>기본</Tag>
      </DrawerBadges>
    );
    expect(screen.getByText('기본')).toBeInTheDocument();
  });

  it('본문의 설명(DrawerNote)은 머리의 부제목(프로파일 상세) 옆에 가서 탭 줄을 차지하지 않는다', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: 'default 열기' }));
    const dialog = screen.getByRole('dialog', { name: 'default' });
    const head = dialog.querySelector('[data-drawer-head]') as HTMLElement;
    const note = head.querySelector('[data-drawer-note]') as HTMLElement;
    expect(note).toHaveTextContent('default 의 권한 안내');
    expect(note.parentElement).toBe(within(head).getByText('프로파일 상세').parentElement); // 부제목과 같은 줄
    expect(within(dialog).getByText('default 본문').parentElement?.textContent).not.toContain('권한 안내');
  });

  it('서랍 밖에서는 설명도 놓인 자리에 그린다', () => {
    render(<DrawerNote>안내</DrawerNote>);
    expect(screen.getByText('안내')).toBeInTheDocument();
  });
});
