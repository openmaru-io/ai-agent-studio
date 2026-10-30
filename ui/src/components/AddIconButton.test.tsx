/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { Drawer } from '@mui/material';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { AddIconButton } from '@/components/AddIconButton';
import { ListView } from '@/components/ListView';
import { mountScreen } from '@/test/mountScreen';

describe('AddIconButton', () => {
  it('아이콘만 보이고 이름은 aria-label 로 읽힌다. 누르면 onClick 이 불린다', async () => {
    const onClick = vi.fn();
    render(<AddIconButton label="새 프로파일" onClick={onClick} />);
    const b = screen.getByRole('button', { name: '새 프로파일' });
    expect(b.textContent).toBe(''); // 글자 없이 아이콘(svg)만
    expect(b.querySelector('svg')).not.toBeNull();
    await userEvent.click(b);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('비활성일 때 이유를 설명으로 읽을 수 있게 하고 눌러도 동작하지 않는다', async () => {
    const onClick = vi.fn();
    render(<AddIconButton label="새 프로파일" onClick={onClick} disabled disabledReason="상한 3개에 도달했습니다" />);
    const b = screen.getByRole('button', { name: '새 프로파일' });
    expect(b).toBeDisabled();
    expect(screen.getByText('상한 3개에 도달했습니다', { selector: '[hidden], .visually-hidden, span' })).toBeInTheDocument();
    await userEvent.setup({ pointerEventsCheck: 0 }).click(b);   // 비활성 단추는 pointer-events 가 꺼져 있어 검사를 끄고 눌러 본다
    expect(onClick).not.toHaveBeenCalled();
  });

  // 서랍을 ESC 로 닫으면 포커스가 이 단추로 돌아와야 한다 — 링이 보기 싫다고 돌려주기를 끄면 키보드 사용자가 위치를 잃는다(2026-10-19-014 R4)
  it('서랍을 열고 ESC 로 닫으면 포커스가 단추로 돌아온다', async () => {
    const user = userEvent.setup();
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <AddIconButton label="새 프로파일" onClick={() => setOpen(true)} />
          <Drawer open={open} onClose={() => setOpen(false)} anchor="right">
            <input aria-label="이름" />
          </Drawer>
        </>
      );
    }
    render(<Host />);
    const b = screen.getByRole('button', { name: '새 프로파일' });
    await user.click(b);
    await waitFor(() => expect(screen.getByRole('textbox', { name: '이름' }).closest('.MuiDrawer-root')).toContainElement(document.activeElement as HTMLElement));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(b).toHaveFocus());
  });

  it('키보드 포커스 링은 포커스 링 토큰(무채색)을 쓴다', () => {
    render(<AddIconButton label="새 프로파일" onClick={() => undefined} />);
    const b = screen.getByRole('button', { name: '새 프로파일' });
    const css = [...document.querySelectorAll('style')].map((s) => s.textContent).join('\n');
    const cls = [...b.classList].find((c) => /^css-/.test(c))!;
    expect(css).toMatch(new RegExp(`\\.${cls}\\.Mui-focusVisible\\{[^}]*box-shadow:0 0 0 2px var\\(--aas-focus-ring\\)`));
  });

  it('활성일 때는 이유 글을 그리지 않는다', () => {
    render(<AddIconButton label="새 스킬" onClick={() => undefined} disabledReason="안 보여야 함" />);
    expect(screen.queryByText('안 보여야 함')).toBeNull();
  });
});

describe('ListView titleAction', () => {
  it('제목 바로 옆(같은 줄)에 놓인다', () => {
    mountScreen(
      <ListView<{ id: string }>
        title="프로파일"
        id="t"
        titleAction={<AddIconButton label="새 프로파일" onClick={() => undefined} />}
        tabs={[{ id: 'a', label: '전체', items: [], columns: [], rowId: (r: { id: string }) => r.id } as never]}
      />,
      '/x'
    );
    const h1 = screen.getByRole('heading', { level: 1 });
    const add = screen.getByRole('button', { name: '새 프로파일' });
    expect(h1.parentElement).toBe(add.parentElement?.parentElement); // 한 줄 묶음(Stack) 안에서 제목 다음에 온다(툴팁 span 이 단추를 감싼다)
    expect(h1.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
