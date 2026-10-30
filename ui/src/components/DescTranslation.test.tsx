/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { createTheme, ThemeProvider } from '@mui/material';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { DescTranslation } from './DescTranslation';

const mount = (ui: React.ReactElement) => render(<ThemeProvider theme={createTheme()}>{ui}</ThemeProvider>);
const SRC = 'Box manages cloud files, sharing, search, and metadata.';

describe('DescTranslation(스펙 2026-10-19-017 DD1~DD4)', () => {
  it('원문이 없으면(영어 화면·번역 전) 아무것도 그리지 않는다', () => {
    const { container } = mount(<DescTranslation />);
    expect(container).toBeEmptyDOMElement();
  });

  it('출처에 따라 「자동 번역」·「번역」을 보인다', () => {
    const { unmount } = mount(<DescTranslation src={SRC} by="llm" />);
    expect(screen.getByText('자동 번역')).toBeInTheDocument();
    unmount();
    mount(<DescTranslation src={SRC} by="seed" />);
    expect(screen.getByText('번역')).toBeInTheDocument();
  });

  it('「원문 보기」를 누르면 lang="en" 원문을 펼치고 aria-expanded 가 바뀐다', async () => {
    mount(<DescTranslation src={SRC} by="llm" />);
    const btn = screen.getByRole('button', { name: '원문 보기' });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(SRC)).toBeNull();
    await userEvent.click(btn);
    expect(screen.getByRole('button', { name: '원문 접기' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(SRC)).toHaveAttribute('lang', 'en');
  });

  it('관리자가 아니면 「다시 번역」이 없다', () => {
    mount(<DescTranslation src={SRC} by="llm" />);
    expect(screen.queryByRole('button', { name: '다시 번역' })).toBeNull();
  });

  it('「다시 번역」을 누르면 단추를 숨기고 대기 안내를 role=status 로 보인다', async () => {
    const onRetranslate = vi.fn().mockResolvedValue({ ok: true });
    mount(<DescTranslation src={SRC} by="seed" onRetranslate={onRetranslate} />);
    await userEvent.click(screen.getByRole('button', { name: '다시 번역' }));
    expect(onRetranslate).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('status')).toHaveTextContent('최대 10분 뒤에 바뀝니다');
    expect(screen.queryByRole('button', { name: '다시 번역' })).toBeNull();
  });

  it('요청이 실패하면 오류 문구와 단추가 돌아온다', async () => {
    const onRetranslate = vi.fn().mockRejectedValue(new Error('403'));
    mount(<DescTranslation src={SRC} by="llm" onRetranslate={onRetranslate} />);
    await userEvent.click(screen.getByRole('button', { name: '다시 번역' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('다시 번역을 요청하지 못했습니다');
    expect(screen.getByRole('button', { name: '다시 번역' })).toBeEnabled();
  });
});
