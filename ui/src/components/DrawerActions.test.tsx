/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { DrawerAction,DrawerActions } from './DrawerActions';
import { DrawerHost } from './DrawerHost';
import { UiProvider, useUi } from './UiContext';

function mount(actions: DrawerAction[], body = <p>본문</p>) {
  function Opener() {
    const { openDrawer } = useUi();
    return (
      <button
        onClick={() =>
          openDrawer({
            title: 'ma',
            sub: '프로파일 상세',
            body: (
              <>
                <DrawerActions actions={actions} />
                {body}
              </>
            ),
          })
        }
      >
        열기
      </button>
    );
  }
  render(
    <UiProvider>
      <Opener />
      <DrawerHost />
    </UiProvider>
  );
}

describe('서랍 머리 동작 단추(COP Drawer 처럼)', () => {
  it('동작 단추는 서랍 머리의 닫기 앞에 아이콘 단추로 있고, 툴팁에 이름과 설명이 나온다', async () => {
    const user = userEvent.setup();
    mount([{ id: 'export', label: '내보내기', description: '묶음 파일로 저장합니다', icon: DownloadOutlinedIcon, confirm: { message: '내보낼까요?', okLabel: '내보내기', onConfirm: vi.fn() } }]);
    await user.click(screen.getByRole('button', { name: '열기' }));
    const dialog = screen.getByRole('dialog', { name: 'ma' });
    const head = dialog.querySelector('[data-drawer-head]') as HTMLElement;
    const btn = within(head).getByRole('button', { name: '내보내기' });
    const close = within(head).getByRole('button', { name: '닫기' });
    expect(btn.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // 닫기보다 앞
    await user.hover(btn);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('내보내기묶음 파일로 저장합니다');
    expect(btn).toHaveAccessibleName('내보내기'); // 툴팁이 열려도 이름은 그대로, 툴팁은 설명이다
    expect(btn).toHaveAccessibleDescription(/묶음 파일로 저장합니다/);
  });

  it('확인 동작은 대화 상자에서 확인해야 실행하고, 취소하면 실행하지 않는다', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    mount([{ id: 'export', label: '내보내기', icon: DownloadOutlinedIcon, confirm: { message: 'ma 를 내보낼까요?', okLabel: '내보내기', onConfirm } }]);
    await user.click(screen.getByRole('button', { name: '열기' }));
    await user.click(screen.getByRole('button', { name: '내보내기' }));
    let box = await screen.findByRole('dialog', { name: '내보내기' });
    expect(box).toHaveTextContent('ma 를 내보낼까요?');
    await user.click(within(box).getByRole('button', { name: '취소' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '내보내기' })).toBeNull());
    expect(onConfirm).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '내보내기' }));
    box = await screen.findByRole('dialog', { name: '내보내기' });
    await user.click(within(box).getByRole('button', { name: '내보내기' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '내보내기' })).toBeNull());
  });

  it('입력이 필요한 동작은 대화 상자 안에 양식을 그리고, 양식이 닫기를 부르면 닫힌다', async () => {
    const user = userEvent.setup();
    mount([
      {
        id: 'delete',
        label: '삭제',
        icon: DeleteOutlineIcon,
        danger: true,
        dialog: { title: '프로파일 삭제', render: (close) => <button onClick={close}>영구 삭제</button> },
      },
    ]);
    await user.click(screen.getByRole('button', { name: '열기' }));
    const btn = screen.getByRole('button', { name: '삭제' });
    expect(btn.className).toMatch(/colorError/); // 위험한 동작은 빨강 단추
    await user.click(btn);
    const box = await screen.findByRole('dialog', { name: '프로파일 삭제' });
    await user.click(within(box).getByRole('button', { name: '영구 삭제' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '프로파일 삭제' })).toBeNull());
    expect(screen.getByRole('dialog', { name: 'ma' })).toBeInTheDocument(); // 서랍은 그대로
  });

  it('서랍 밖에서는 본문 자리에 단추를 그린다', () => {
    render(<DrawerActions actions={[{ id: 'x', label: '내보내기', icon: DownloadOutlinedIcon, confirm: { message: 'm', okLabel: 'ok', onConfirm: vi.fn() } }]} />);
    expect(screen.getByRole('button', { name: '내보내기' })).toBeInTheDocument();
  });
});
