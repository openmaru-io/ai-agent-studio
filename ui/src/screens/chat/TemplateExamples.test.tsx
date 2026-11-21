/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountScreen, stubApi } from '@/test/mountScreen';

import { TemplateExamples } from './TemplateExamples';

describe('TemplateExamples', () => {
  afterEach(cleanup);

  it('템플릿 예시를 단추로 보이고 누르면 입력칸 채우기만 한다', async () => {
    const api = stubApi({ '/api/market/template/examples': { profile: 'sales', template: 'paid/sales', examples: ['견적 요청을 정리해 줘'] } });
    const onPick = vi.fn();
    mountScreen(<TemplateExamples pod="p1" profile="sales" onPick={onPick} />, '/');
    fireEvent.click(await screen.findByRole('button', { name: '견적 요청을 정리해 줘' }));
    expect(onPick).toHaveBeenCalledWith('견적 요청을 정리해 줘');
    expect(String(api.mock.calls[0][0])).toContain('profile=sales');
  });

  it('예시가 없으면 아무것도 그리지 않는다', async () => {
    const api = stubApi({ '/api/market/template/examples': { profile: 'main', template: '', examples: [] } });
    mountScreen(<TemplateExamples profile="main" onPick={() => {}} />, '/');
    await waitFor(() => expect(api).toHaveBeenCalled());
    expect(screen.queryByText(/이렇게 시작해 보세요/)).toBeNull();
  });
});
