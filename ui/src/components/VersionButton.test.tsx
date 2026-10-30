/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { VersionButton } from '@/components/VersionButton';
import type { BuildInfo } from '@/lib/buildInfo';

const info: BuildInfo = {
  version: '1.0.4',
  gitCommit: '58c40e7b9e084f2e20eaeb53964ae973425d54af',
  gitCommitDate: '2026-10-17 19:06:43 +0900',
  buildDate: '2026-10-17 20:00:00 +0900',
};

afterEach(() => {
  delete window.__RUNTIME_CONFIG__;
});

describe('VersionButton', () => {
  it('펼친 메뉴에서는 로고 옆에 버전·짧은 커밋·커밋 날짜를 보인다', () => {
    render(<VersionButton collapsed={false} info={info} />);
    const btn = screen.getByRole('button', { name: /v1\.0\.4/ });
    expect(btn).toHaveTextContent('v1.0.4 | #58c40e7b');
    expect(btn).toHaveTextContent('2026-10-17 19:06:43 +0900');
    expect(within(btn).getByRole('img')).toHaveAttribute('alt', 'OPENMARU CogentAI AAS');
  });

  it('접힌 메뉴에서는 로고만 보인다', () => {
    render(<VersionButton collapsed info={info} />);
    const btn = screen.getByRole('button', { name: /v1\.0\.4/ });
    expect(btn).not.toHaveTextContent('58c40e7b');
    expect(within(btn).getByRole('img')).toBeInTheDocument();
  });

  it('누르면 버전 정보 창이 열리고 닫기 버튼으로 닫힌다', async () => {
    window.__RUNTIME_CONFIG__ = { PRODUCT_NAME: 'MSAP_CogentAI' };
    render(<VersionButton collapsed={false} info={info} />);
    fireEvent.click(screen.getByRole('button', { name: /v1\.0\.4/ }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('MSAP CogentAI AAS');
    expect(dialog).toHaveTextContent('58c40e7b9e084f2e20eaeb53964ae973425d54af');
    expect(dialog).toHaveTextContent('2026-10-17 20:00:00 +0900');
    expect(dialog).toHaveTextContent('Copyright (c) 2026. OPENMARU, Inc.');
    const home = within(dialog).getByRole('link', { name: 'https://www.openmaru.io/' });
    expect(home).toHaveAttribute('href', 'https://www.openmaru.io/');
    expect(home).toHaveAttribute('target', '_blank');
    expect(home).toHaveAttribute('rel', 'noopener');
    fireEvent.click(within(dialog).getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
