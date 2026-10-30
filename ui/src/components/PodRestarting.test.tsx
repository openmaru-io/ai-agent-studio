/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { meRefetchMs } from '@/lib/data';

import { PodRestarting } from './PodRestarting';

const qc = new QueryClient();
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;

describe('PodRestarting(스펙 2026-10-23-006)', () => {
  it('지금 작업공간이 다시 뜨는 중이면 이름과 함께 띠를 보이고, 아니면 아무것도 그리지 않는다', () => {
    const { rerender, container } = render(<PodRestarting pod={{ id: 'aas-agent-a', owner: 'a@x.com', name: '마케팅 도우미', restarting: true }} />, { wrapper });
    expect(screen.getByRole('status')).toHaveTextContent('마케팅 도우미 AI 에이전트 작업공간을 다시 시작하는 중입니다');
    rerender(<PodRestarting pod={{ id: 'aas-agent-a', owner: 'a@x.com', name: '' , restarting: true }} />);
    expect(screen.getByRole('status')).toHaveTextContent('aas-agent-a');                              // 이름이 없으면 id
    rerender(<PodRestarting pod={{ id: 'aas-agent-a', owner: 'a@x.com', name: '마케팅 도우미' }} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<PodRestarting pod={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('롤아웃이 새 버전으로 바꾸는 중이면 왜·얼마나·무엇이 남는지 말한다(스펙 2026-10-28-015 DD13)', () => {
    render(<PodRestarting pod={{ id: 'aas-agent-a', owner: 'a@x.com', name: '마케팅 도우미', restarting: true, restart_reason: 'update' }} />, { wrapper });
    expect(screen.getByRole('status')).toHaveTextContent('Hermes 를 새 버전으로 바꾸는 중입니다. 보통 1~2분, 길면 15분 걸립니다. 대화와 파일은 그대로 있습니다.');
  });

  it('다시 뜨는 중으로 바뀌면 열린 프로파일 서랍을 다시 읽게 한다(스펙 2026-10-23-008)', () => {
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { rerender } = render(<PodRestarting pod={{ id: 'aas-agent-a', owner: 'a@x.com' }} />, { wrapper });
    expect(spy).not.toHaveBeenCalled();
    rerender(<PodRestarting pod={{ id: 'aas-agent-a', owner: 'a@x.com', restarting: true }} />);
    expect(spy).toHaveBeenCalledWith({ queryKey: ['profile'] });
    spy.mockRestore();
  });
});

// 다시 시작 전에 연 화면도 알아채게 평소에도 30초마다 읽는다(스펙 2026-10-23-008). OKE 에서 띠가 끝까지 나오지 않았다
describe('meRefetchMs', () => {
  it('다시 뜨는 중 5초, main 준비 중 15초, 평소 30초', () => {
    expect(meRefetchMs({ pod: { id: 'a', owner: '', restarting: true } } as never)).toBe(5000);
    expect(meRefetchMs({ pod: { id: 'a', owner: '' }, primary: { profile: 'main', ready: false } } as never)).toBe(15000);
    expect(meRefetchMs({ pod: { id: 'a', owner: '' } } as never)).toBe(30000);
    expect(meRefetchMs(undefined)).toBe(30000);
  });
});
