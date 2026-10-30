/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 시험 사이에 MUI(Emotion) 스타일이 document.head 에 쌓이지 않는다(setup.ts). 쌓이면 jsdom 의 getComputedStyle 이
// 스타일시트 수만큼 느려져, getByRole·findByRole 을 쓰는 뒤 시험이 시간 초과로 실패했다(Office 시험 158 → 1,872개, 2026-10-22).
import { Box } from '@mui/material';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

const emotionStyles = () => document.head.querySelectorAll('style[data-emotion="css"]').length;

describe('시험 사이 Emotion 스타일 정리', () => {
  it('앞 시험이 스타일을 넣는다', () => {
    render(<Box sx={{ color: 'rgb(1, 2, 3)', padding: '7px' }}>앞</Box>);
    expect(emotionStyles()).toBeGreaterThan(0);
  });

  it('뒤 시험이 시작할 때는 앞 시험의 스타일이 남아 있지 않다', () => {
    expect(emotionStyles()).toBe(0);
  });

  it('지운 뒤에도 같은 스타일을 다시 넣어 그린다', () => {
    render(<Box sx={{ color: 'rgb(1, 2, 3)', padding: '7px' }}>다시</Box>);
    expect(getComputedStyle(screen.getByText('다시')).color).toBe('rgb(1, 2, 3)');
  });
});
