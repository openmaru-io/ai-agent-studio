/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getLang, setLang as storeLang } from '@/i18n';
import { wsClient } from '@/lib/ws';

import { I18nProvider, useI18n } from './I18n';

// 서버가 언어별로 번역해 주는 응답(비밀값·스킬 설명)을 흉내 낸다. 요청할 때의 언어를 그대로 돌려준다
let release: (() => void) | null = null;
function Probe() {
  const q = useQuery({
    queryKey: ['probe'],
    queryFn: async () => {
      const lang = getLang();
      if (lang === 'en') await new Promise<void>((r) => (release = r)); // 서버가 새 언어 응답을 늦게 준다
      return `served:${lang}`;
    },
    staleTime: 60_000,
  });
  const { setLang } = useI18n();
  return (
    <>
      <span data-testid="data">{q.data ?? ''}</span>
      <button onClick={() => setLang('en')}>en</button>
    </>
  );
}

afterEach(() => {
  storeLang('ko');
  vi.restoreAllMocks();
});

describe('언어 바꾸기와 서버 데이터(스펙 2026-10-21-007)', () => {
  it('언어를 바꾸면 받아 둔 서버 응답을 새 언어로 다시 읽고, 웹소켓도 새 언어로 다시 연다', async () => {
    const relang = vi.spyOn(wsClient, 'changeLang').mockImplementation(() => {});
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <I18nProvider>
          <Probe />
        </I18nProvider>
      </QueryClientProvider>
    );
    expect(await screen.findByText('served:ko')).toBeInTheDocument();
    await act(async () => screen.getByRole('button', { name: 'en' }).click());
    expect(screen.queryByText('served:ko')).toBeNull(); // 새 응답을 기다리는 동안에도 옛 언어 응답을 보이지 않는다
    await act(async () => release?.());
    expect(await screen.findByText('served:en')).toBeInTheDocument(); // staleTime 안이라도 새 언어로 다시 읽는다
    expect(relang).toHaveBeenCalledTimes(1);
  });

  it('같은 언어를 다시 고르면 아무것도 다시 읽지 않는다', async () => {
    const relang = vi.spyOn(wsClient, 'changeLang').mockImplementation(() => {});
    function Same() {
      const { setLang } = useI18n();
      return <button onClick={() => setLang('ko')}>ko</button>;
    }
    render(
      <QueryClientProvider client={new QueryClient()}>
        <I18nProvider>
          <Same />
        </I18nProvider>
      </QueryClientProvider>
    );
    await act(async () => screen.getByRole('button', { name: 'ko' }).click());
    expect(relang).not.toHaveBeenCalled();
  });
});
