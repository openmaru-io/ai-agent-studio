/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSnackbar, VariantType } from 'notistack';
import { describe, expect, it } from 'vitest';

import { AppProviders } from '@/components/AppProviders';

function Fire({ variant, text, persist }: { variant: VariantType; text: string; persist?: boolean }) {
  const { enqueueSnackbar } = useSnackbar();
  return (
    <button type="button" onClick={() => enqueueSnackbar(text, { variant, persist })}>
      띄우기
    </button>
  );
}

async function fire(variant: VariantType, text: string, persist?: boolean) {
  const user = userEvent.setup();
  render(
    <AppProviders>
      <Fire variant={variant} text={text} persist={persist} />
    </AppProviders>,
  );
  await user.click(screen.getByRole('button', { name: '띄우기' }));
  return { user, toast: (await screen.findByText(text)).closest('.notistack-MuiContent') as HTMLElement };
}

describe('AppToast', () => {
  it.each(['success', 'error', 'warning', 'info', 'default'] as const)('%s 알림은 아이콘과 notistack 클래스를 가진다', async (variant) => {
    const { toast } = await fire(variant, `${variant} 알림`);
    expect(toast).toHaveClass(`notistack-MuiContent-${variant}`);
    expect(toast.querySelector('svg')).not.toBeNull();
  });

  it('실패 알림은 alert, 나머지는 status 역할이다', async () => {
    const { toast } = await fire('error', '저장하지 못했습니다');
    expect(toast).toHaveAttribute('role', 'alert');
  });

  it('성공 알림은 status 역할이다', async () => {
    const { toast } = await fire('success', '저장했습니다');
    expect(toast).toHaveAttribute('role', 'status');
  });

  it('닫기 단추를 누르면 알림이 사라진다', async () => {
    const { user } = await fire('success', '저장했습니다');
    await user.click(screen.getByRole('button', { name: '알림 닫기' }));
    await waitFor(() => expect(screen.queryByText('저장했습니다')).toBeNull(), { timeout: 3000 });
  });

  it('시간이 있는 알림에는 남은 시간 막대가 있고 계속 남는 알림에는 없다', async () => {
    const timed = await fire('info', '곧 사라짐');
    expect(timed.toast.querySelector('.toast-drain')).not.toBeNull();
  });

  it('persist 알림에는 남은 시간 막대가 없다', async () => {
    const { toast } = await fire('warning', '계속 남음', true);
    expect(toast.querySelector('.toast-drain')).toBeNull();
  });
});

describe('AppToast 바로가기 단추', () => {
  it('action 이 있으면 글 아래에 그려 누를 수 있다', async () => {
    let clicked = 0;
    function WithAction() {
      const { enqueueSnackbar } = useSnackbar();
      return (
        <button
          type="button"
          onClick={() =>
            enqueueSnackbar('지웠습니다', {
              variant: 'success',
              action: () => (
                <button type="button" onClick={() => clicked++}>
                  이동
                </button>
              ),
            })
          }
        >
          띄우기
        </button>
      );
    }
    const user = userEvent.setup();
    render(
      <AppProviders>
        <WithAction />
      </AppProviders>,
    );
    await user.click(screen.getByRole('button', { name: '띄우기' }));
    await user.click(await screen.findByRole('button', { name: '이동' }));
    expect(clicked).toBe(1);
  });
});
