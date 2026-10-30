/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { ThemeProvider } from '@mui/material/styles';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { makeTheme } from '@/theme';

import { DeskDeleteDialog, deskOccupant, EditPanel, EditPanelProps } from './EditPanel';

const desk = { _uid: 'office_1', type: 'desk_cubicle', x: 0, y: 0 };

function props(over: Partial<EditPanelProps> = {}): EditPanelProps {
  return {
    version: 3,
    selected: null,
    placing: null,
    dirty: false,
    saving: false,
    error: null,
    onPlace: vi.fn(),
    onRotate: vi.fn(),
    onRaise: vi.fn(),
    onDelete: vi.fn(),
    onSave: vi.fn(),
    onCancel: vi.fn(),
    ...over,
  };
}

describe('deskOccupant', () => {
  it('에이전트가 앉은 책상만 확인이 필요하다', () => {
    expect(deskOccupant(desk, { office_1: 'kim0' })).toBe('kim0');
    expect(deskOccupant(desk, {})).toBeNull();
    expect(deskOccupant({ ...desk, type: 'plant' }, { office_1: 'kim0' })).toBeNull();
  });
});

describe('EditPanel', () => {
  it('바뀐 것이 없으면 저장할 수 없고, 가구를 고르면 돌리기·지우기가 보인다', async () => {
    const p = props();
    const { rerender } = render(<EditPanel {...p} />);
    expect(screen.getByText('배치 편집 · 버전 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '저장' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: '책상' }));
    expect(p.onPlace).toHaveBeenCalledWith('desk_cubicle');
    rerender(<EditPanel {...p} dirty selected={desk} />);
    await userEvent.click(screen.getByRole('button', { name: '오른쪽으로 돌리기' }));
    expect(p.onRotate).toHaveBeenCalledWith(15);
    await userEvent.click(screen.getByRole('button', { name: '지우기' }));
    expect(p.onDelete).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '저장' }));
    expect(p.onSave).toHaveBeenCalled();
  });

  // 패널은 테마와 상관없이 늘 어둡다. 밝은 테마의 단추 글자색(#111827)을 그대로 받으면 취소·저장이 검은 바탕에 묻힌다(2026-10-21)
  it.each(['light', 'dark'] as const)('%s 테마에서도 취소·저장 단추 글자가 밝다', (mode) => {
    render(
      <ThemeProvider theme={makeTheme(mode)}>
        <EditPanel {...props()} />
      </ThemeProvider>,
    );
    for (const name of ['취소', '저장']) {
      expect(getComputedStyle(screen.getByRole('button', { name })).color).not.toBe('rgb(17, 24, 39)');
    }
    expect(getComputedStyle(screen.getByRole('button', { name: '취소' })).color).toBe('rgb(208, 214, 224)');
    expect(getComputedStyle(screen.getByRole('button', { name: '저장' })).color).toBe('rgb(247, 248, 248)');
  });

  it('책상 지우기 확인 창에 앉은 에이전트 이름이 보인다', async () => {
    const onConfirm = vi.fn();
    render(<DeskDeleteDialog alias="kim0" onConfirm={onConfirm} onClose={vi.fn()} />);
    expect(screen.getByText(/kim0 의 배정이 풀립니다/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '지우기' }));
    expect(onConfirm).toHaveBeenCalled();
  });
});
