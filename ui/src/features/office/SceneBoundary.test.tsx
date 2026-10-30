/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 다시 배포 뒤 열어 둔 오피스 화면이 옛 3D 장면 묶음(assets/OfficeScene-<해시>.js)을 받지 못하면(404),
// 장면 경계가 「3D 를 그릴 수 없음」으로만 받아 2D 보기에 머물렀다. 화면 오류 경계처럼 새로 고친다(OKE 2026-10-24).
import { render, screen } from '@testing-library/react';
import { lazy, Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { page, RELOAD_KEY } from '@/lib/chunkError';

import { SceneBoundary } from './SceneBoundary';

const spies: { mockRestore: () => void }[] = [];
const spy = <T extends { mockRestore: () => void }>(s: T) => (spies.push(s), s);

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  vi.useRealTimers();
  spies.splice(0).forEach((s) => s.mockRestore());
});

function mount(Child: React.ComponentType) {
  return render(
    <SceneBoundary fallback={(reason) => <div role="alert">2D 보기({reason})</div>}>
      <Suspense fallback={null}>
        <Child />
      </Suspense>
    </SceneBoundary>
  );
}

const gone = () => lazy(() => Promise.reject(new TypeError('Failed to fetch dynamically imported module: /assets/OfficeScene-old.js')));

describe('3D 장면 묶음을 받지 못하면(다시 배포)', () => {
  it('2D 보기에 새 버전 안내를 보이고 한 번 새로 고친다', async () => {
    const reload = spy(vi.spyOn(page, 'reload').mockImplementation(() => {}));
    spy(vi.spyOn(console, 'error').mockImplementation(() => {}));
    mount(gone());
    expect(await screen.findByRole('alert')).toHaveTextContent('새 버전이 배포되었습니다');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('30초 안에 이미 새로 고쳤으면 남은 시간 뒤에 새로 고친다', async () => {
    const reload = spy(vi.spyOn(page, 'reload').mockImplementation(() => {}));
    spy(vi.spyOn(console, 'error').mockImplementation(() => {}));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    sessionStorage.setItem(RELOAD_KEY, String(Date.now() - 5000));
    mount(gone());
    await screen.findByRole('alert');
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(26_000);                    // 앞 새로 고침에서 30초가 지나면
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('묶음 오류가 아닌 그리기 오류는 새로 고치지 않고 그 이유로 2D 보기를 보인다', async () => {
    const reload = spy(vi.spyOn(page, 'reload').mockImplementation(() => {}));
    spy(vi.spyOn(console, 'error').mockImplementation(() => {}));
    mount(() => {
      throw new Error('WebGL 오류');
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('2D 보기(WebGL 오류)');
    expect(reload).not.toHaveBeenCalled();
  });
});
