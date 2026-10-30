/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 다시 배포 중 메뉴를 누르면 옛 화면 묶음이 404 라 앱 전체가 빈 화면이 되던 문제(사용자 보고 2026-10-21).
// 화면 오류 경계가 한 번 새로 고치고, 짧은 사이에 또 실패하면 안내와 「새로 고침」 단추를 보인다.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { lazy } from 'react';
import { HashRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '@/App';
import { page, RELOAD_KEY, reloadOnce } from '@/lib/chunkError';
import { SCREENS } from '@/pages/screens';

import { AppProviders } from './AppProviders';
import { ScreenBoundary } from './ScreenBoundary';

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <HashRouter>
        <AppProviders>
          <App />
        </AppProviders>
      </HashRouter>
    </QueryClientProvider>
  );
}

const original = SCREENS.profiles;
// 셸에는 공지 읽기 영역(role=alert, 비어 있음)이 늘 붙어 있다(스펙 2026-10-24-007 E4). 그 글을 가진 alert 가 있는지 본다
const alertWith = (text: string) => waitFor(() => expect(screen.getAllByRole('alert').map((a) => a.textContent).join('\n')).toContain(text));
// vi.restoreAllMocks 는 setup.ts 의 matchMedia 대역(vi.fn)까지 비워 쓰지 않는다. 여기서 만든 spy 만 되돌린다
const spies: { mockRestore: () => void }[] = [];
const spy = <T extends { mockRestore: () => void }>(s: T) => (spies.push(s), s);

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{"error":"시험"}', { status: 500 }))));
  sessionStorage.clear();
});

afterEach(() => {
  SCREENS.profiles = original;
  spies.splice(0).forEach((s) => s.mockRestore());
});

describe('화면 묶음을 받지 못하면(다시 배포)', () => {
  const gone = () => lazy(() => Promise.reject(new TypeError('Failed to fetch dynamically imported module: /assets/Profiles-old.js')));

  it('빈 화면 대신 화면 제목과 새 버전 안내를 보이고 한 번 새로 고친다', async () => {
    const reload = spy(vi.spyOn(page, 'reload').mockImplementation(() => {}));
    spy(vi.spyOn(console, 'error').mockImplementation(() => {})); // React 가 잡힌 오류를 찍는다
    SCREENS.profiles = gone();
    window.location.hash = '#/profiles';
    mount();
    await alertWith('새 버전이 배포되었습니다');
    expect(screen.getByRole('heading', { level: 1, name: '프로파일' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '새로 고침' })).toBeInTheDocument();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('30초 안에 이미 새로 고쳤으면 바로 새로 고치지 않는다(배포 중 옛·새 파드가 섞여도 끝없이 돌지 않는다)', async () => {
    const reload = spy(vi.spyOn(page, 'reload').mockImplementation(() => {}));
    spy(vi.spyOn(console, 'error').mockImplementation(() => {}));
    sessionStorage.setItem(RELOAD_KEY, String(Date.now() - 5000));
    SCREENS.profiles = gone();
    window.location.hash = '#/profiles';
    mount();
    await alertWith('새 버전이 배포되었습니다');
    expect(reload).not.toHaveBeenCalled();
  });

  it('묶음 오류가 아닌 화면 오류도 앱 전체를 내리지 않고 그 화면에 오류를 보인다', async () => {
    const reload = spy(vi.spyOn(page, 'reload').mockImplementation(() => {}));
    spy(vi.spyOn(console, 'error').mockImplementation(() => {}));
    SCREENS.profiles = () => {
      throw new Error('그리기 실패');
    };
    window.location.hash = '#/profiles';
    mount();
    await alertWith('그리기 실패');
    expect(screen.getByRole('navigation')).toBeInTheDocument(); // 왼쪽 메뉴는 남는다
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('배포가 끝나지 않아 또 실패하면 30초마다 다시 새로 고친다', () => {
  function Gone(): never {
    throw new TypeError('Failed to fetch dynamically imported module: /assets/Profiles-old.js');
  }

  afterEach(() => vi.useRealTimers());

  it('앞 새로 고침에서 30초가 지나면 다시 새로 고치고, 화면을 떠나면 멈춘다', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(1_000_000);
    const reload = spy(vi.spyOn(page, 'reload').mockImplementation(() => {}));
    spy(vi.spyOn(console, 'error').mockImplementation(() => {}));
    sessionStorage.setItem(RELOAD_KEY, String(1_000_000 - 5000)); // 5초 전에 새로 고친 뒤 또 실패
    const { unmount } = render(
      <ScreenBoundary title="프로파일">
        <Gone />
      </ScreenBoundary>
    );
    expect(screen.getByRole('alert')).toHaveTextContent('30초마다 자동으로 새로 고칩니다');
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(24_000);
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_001); // 앞 새로 고침에서 30초가 지난 첫 순간
    expect(reload).toHaveBeenCalledTimes(1);
    unmount();
    sessionStorage.setItem(RELOAD_KEY, '0');
    vi.advanceTimersByTime(60_000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('새로 고친 시각을 적지 못하면 다시 부르지 않는다(끝없이 돌지 않게)', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const reload = spy(vi.spyOn(page, 'reload').mockImplementation(() => {}));
    spy(vi.spyOn(console, 'error').mockImplementation(() => {}));
    spy(
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('quota');
      })
    );
    render(
      <ScreenBoundary title="프로파일">
        <Gone />
      </ScreenBoundary>
    );
    vi.advanceTimersByTime(120_000);
    expect(reload).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('reloadOnce', () => {
  it('처음에는 새로 고치고 시각을 적는다. 30초가 지나면 다시 새로 고친다', () => {
    const reload = spy(vi.spyOn(page, 'reload').mockImplementation(() => {}));
    expect(reloadOnce(100_000)).toBe(true);
    expect(sessionStorage.getItem(RELOAD_KEY)).toBe('100000');
    expect(reloadOnce(120_000)).toBe(false);
    expect(reloadOnce(130_001)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('저장소를 쓸 수 없으면 새로 고치지 않는다(끝없이 새로 고치지 않게)', () => {
    const reload = spy(vi.spyOn(page, 'reload').mockImplementation(() => {}));
    spy(
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('blocked');
      })
    );
    expect(reloadOnce()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
