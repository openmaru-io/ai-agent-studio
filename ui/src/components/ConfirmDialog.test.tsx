/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Dialog, DialogActions, DialogTitle } from '@mui/material';
import { ThemeProvider } from '@mui/material/styles';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { dialogTokens } from '@/lib/shellTokens';
import { makeTheme } from '@/theme';

import { ConfirmProvider, useConfirm } from './ConfirmDialog';

// 확인창의 모양·포커스(OMAI-1181, 스펙 ui/common-dialog-redesign.md). 답을 돌려주는 동작은 이전과 같아야 한다.
function Opener({ danger, onAnswer }: { danger?: boolean; onAnswer: (ok: boolean) => void }) {
  const confirm = useConfirm();
  return <Button onClick={() => confirm('claude-code 스킬을 끕니다.', { danger }).then(onAnswer)}>열기</Button>;
}

const mount = (props: { danger?: boolean; onAnswer: (ok: boolean) => void }, mode: 'dark' | 'light' = 'dark') =>
  render(
    <ThemeProvider theme={makeTheme(mode)}>
      <ConfirmProvider>
        <Opener {...props} />
      </ConfirmProvider>
    </ThemeProvider>
  );

describe('확인창(ConfirmDialog)', () => {
  it('위험 확인은 경고 아이콘이 있고 처음 포커스가 취소 단추에 있다', async () => {
    mount({ danger: true, onAnswer: () => undefined });
    await userEvent.click(screen.getByRole('button', { name: '열기' }));
    expect(await screen.findByTestId('confirm-danger-icon')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '취소' })).toHaveFocus();
  });

  it('일반 확인은 아이콘이 없고 처음 포커스가 확인 단추에 있다', async () => {
    mount({ onAnswer: () => undefined });
    await userEvent.click(screen.getByRole('button', { name: '열기' }));
    const ok = await screen.findByRole('button', { name: '확인' });
    expect(screen.queryByTestId('confirm-danger-icon')).toBeNull();
    expect(ok).toHaveFocus();
  });

  it('확인·취소·ESC 가 이전과 같이 답한다', async () => {
    const answers: boolean[] = [];
    mount({ onAnswer: (ok) => answers.push(ok) });
    await userEvent.click(await screen.findByRole('button', { name: '열기' }));
    await userEvent.click(await screen.findByRole('button', { name: '확인' }));
    await userEvent.click(await screen.findByRole('button', { name: '열기' })); // 닫히는 동안은 aria-hidden 이라 findBy 로 기다린다
    await userEvent.click(await screen.findByRole('button', { name: '취소' }));
    await userEvent.click(await screen.findByRole('button', { name: '열기' }));
    await screen.findByRole('button', { name: '취소' });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(answers).toEqual([true, false, false]));
  });

  // 서랍(모달) 안 단추로 확인창을 열면, 확인창이 바깥 모달에 aria-hidden 을 붙이는 순간 포커스가 그 안에 남아 있었다
  // (브라우저 경고 「Blocked aria-hidden on an element because its descendant retained focus」, 공지 「지금 내리기」 2026-10-24).
  describe('바깥 모달 안에서 열 때', () => {
    afterEach(() => vi.restoreAllMocks());

    function InDrawer() {
      const confirm = useConfirm();
      return (
        <Dialog open aria-labelledby="outer">
          <DialogTitle id="outer">서랍</DialogTitle>
          <DialogActions>
            <Button onClick={() => void confirm('공지를 내릴까요?', { danger: true })}>지금 내리기</Button>
          </DialogActions>
        </Dialog>
      );
    }

    it('포커스가 남은 요소를 aria-hidden 으로 가리지 않고, 닫으면 연 단추로 포커스를 돌려준다', async () => {
      const hidFocused: string[] = [];
      const real = Element.prototype.setAttribute;
      vi.spyOn(Element.prototype, 'setAttribute').mockImplementation(function (this: Element, name: string, value: string) {
        if (name === 'aria-hidden' && value === 'true' && document.activeElement && this.contains(document.activeElement) && document.activeElement !== document.body) {
          hidFocused.push(document.activeElement.textContent ?? '');
        }
        return real.call(this, name, value);
      });
      render(
        <ThemeProvider theme={makeTheme('dark')}>
          <ConfirmProvider>
            <InDrawer />
          </ConfirmProvider>
        </ThemeProvider>
      );
      const opener = await screen.findByRole('button', { name: '지금 내리기' });
      opener.focus();
      await userEvent.click(opener);
      expect(await screen.findByRole('button', { name: '취소' })).toHaveFocus();
      expect(hidFocused).toEqual([]);
      await userEvent.click(screen.getByRole('button', { name: '취소' }));
      await waitFor(() => expect(screen.getByRole('button', { name: '지금 내리기' })).toHaveFocus());
    });
  });
});

// 다이얼로그 단추는 DialogActions 안에서 3단계로 칠한다(DESIGN.md §4). 다이얼로그 밖 단추는 바뀌지 않는다.
// jsdom 은 CSS 우선순위 없이 선언 순서로 적용해 단추 색을 계산값으로 시험할 수 없다. 테마 설정값을 직접 본다. 실제 모양은 Playwright 로 확인한다.
describe('다이얼로그 테마', () => {
  it.each(['dark', 'light'] as const)('%s: 종이 12px·표면·테두리, DialogActions 의 Tier 1·2·3 값이 토큰과 같다', (mode) => {
    const tk = dialogTokens[mode];
    const c = makeTheme(mode).components!;
    const paper = (c.MuiDialog!.styleOverrides as Record<string, Record<string, unknown>>).paper;
    expect(paper).toMatchObject({ borderRadius: 12, backgroundColor: tk.surface, borderColor: tk.edge });
    const actions = (c.MuiDialogActions!.styleOverrides as Record<string, Record<string, Record<string, unknown>>>).root;
    expect(actions['& .MuiButton-text']).toMatchObject({ color: tk.tier2.text, borderColor: tk.tier2.border });
    expect(actions['& .MuiButton-contained']).toMatchObject({ color: tk.tier1.text, borderColor: tk.tier1.border, backgroundColor: tk.tier1.bg });
    expect(actions['& .MuiButton-containedError']).toMatchObject({ color: tk.tier3.text, borderColor: tk.tier3.border, backgroundColor: tk.tier3.bg });
    // 선택자는 모두 DialogActions 안(root 의 자손)에 걸려 다이얼로그 밖 단추는 바뀌지 않는다
    for (const k of Object.keys(actions).filter((k) => k.startsWith('& .MuiButton'))) expect(k.startsWith('& .')).toBe(true);
  });

  it('다이얼로그 종이는 실제로 12px 모서리로 그려진다', () => {
    render(
      <ThemeProvider theme={makeTheme('dark')}>
        <Dialog open>
          <DialogTitle>제목</DialogTitle>
          <DialogActions>
            <Button>취소</Button>
          </DialogActions>
        </Dialog>
      </ThemeProvider>
    );
    expect(getComputedStyle(document.querySelector('.MuiDialog-paper') as HTMLElement).borderRadius).toBe('12px');
  });
});
