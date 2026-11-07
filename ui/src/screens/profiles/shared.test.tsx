/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 프로파일 만들기·이름 바꾸기·지우기 뒤 스킬 화면이 옛 프로파일을 보이지 않는다
// (OMAI-1855, cogentai-aas-docs docs-plan/deploy/field-report-20261105-six-issues.md §4 R2).
// 재현: OKE 시험 에이전트에서 이름을 바꾸면 Hermes 폴더·게이트웨이·서버 캐시는 새 이름만 갖는데,
// 스킬 화면 쿼리 ['skills'](staleTime 120초)는 무효화되지 않아 옛 이름이 「중지」로 남았다.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useProfileAct } from './shared';

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  post: vi.fn(async () => ({ ok: true, name: 'profile-b' })),
}));
vi.mock('@/lib/data', async (orig) => ({
  ...(await orig<typeof import('@/lib/data')>()),
  useMe: () => ({ data: { pod: { id: 'pod-1' } } }),
}));

describe('useProfileAct — 프로파일 목록이 바뀌는 동작', () => {
  let qc: QueryClient;
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  beforeEach(() => {
    qc = new QueryClient();
    qc.setQueryData(['skills'], { profiles: ['profile-a'] });
    qc.setQueryData(['skill', 'x'], { id: 'x' });
  });

  it.each(['rename', 'create', 'delete'])('%s 뒤 스킬 목록 쿼리를 무효화한다', async (action) => {
    const { result } = renderHook(() => useProfileAct('profile-a'), { wrapper });
    await act(async () => {
      await result.current.act(action, { new_name: 'profile-b' });
    });
    expect(qc.getQueryState(['skills'])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(['profiles'])?.isInvalidated ?? true).toBe(true);
  });

  it('다른 동작(env_set)은 스킬 목록을 건드리지 않는다', async () => {
    const { result } = renderHook(() => useProfileAct('profile-a'), { wrapper });
    await act(async () => {
      await result.current.act('env_set', { key: 'A', value: 'b' });
    });
    expect(qc.getQueryState(['skills'])?.isInvalidated).toBe(false);
  });

  it('실패하면 무효화하지 않는다', async () => {
    const api = await import('@/lib/api');
    vi.mocked(api.post).mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useProfileAct('profile-a'), { wrapper });
    await act(async () => {
      await expect(result.current.act('rename', { new_name: 'profile-b' })).rejects.toThrow('boom');
    });
    expect(qc.getQueryState(['skills'])?.isInvalidated).toBe(false);
  });
});
