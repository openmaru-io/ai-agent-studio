/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountScreen, postedTo, stubApi } from '@/test/mountScreen';

import { TemplateUpdate } from './TemplateUpdate';

const DIFF = {
  profile: 'sales',
  namespace: 'paid',
  name: 'sales',
  from: '1.0.0',
  to: '1.1.0',
  added: [{ name: 'wiki', url: 'https://w/mcp', stdio: false, keys: ['WIKI_KEY'] }],
  changed: [{ name: 'fs', stdio: true, keys: [], command: 'npx', args: ['-y', '@s/fs@2.0.0'], consent_hash: 'c'.repeat(64) }],
  kept: ['mine'],
  new_keys: [{ name: 'WIKI_KEY', description: '위키 키', required: true, used_by: [] }],
  stdio: [{ name: 'fs', stdio: true, keys: [], command: 'npx', args: ['-y', '@s/fs@2.0.0'], consent_hash: 'c'.repeat(64) }],
  hub_skills: [],
};

describe('TemplateUpdate', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('MCP 차이·남겨 둘 것을 보이고, 동의와 새 KEY 가 있어야 올리며, done 이 된 뒤에 KEY 를 넣는다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = stubApi({
      '/api/market/template/diff': DIFF,
      '/api/market/install': { ok: true, request: { id: '20261118110000000000-abcdef', status: 'queued' } },
      '/api/market/request': { id: '20261118110000000000-abcdef', status: 'done' },
      '/api/profile/action': { ok: true },
    });
    mountScreen(<TemplateUpdate profile="sales" />, '/');
    expect(await screen.findByText('더함 · wiki')).toBeTruthy();
    expect(screen.getByText('바뀜 · fs')).toBeTruthy();
    expect(screen.getByText(/이 프로파일에만 있는 MCP 는 그대로 둡니다: mine/)).toBeTruthy();
    const start = screen.getByRole('button', { name: '1.1.0 으로 올리기' }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /fs: 이 명령을 실행하는 데 동의합니다/ }));
    expect(start.disabled).toBe(true);                              // 필수 KEY 가 비어 있다
    fireEvent.change(screen.getByLabelText(/WIKI_KEY/, { selector: 'input' }), { target: { value: 'k-1' } });
    expect(start.disabled).toBe(false);
    fireEvent.click(start);
    expect(await screen.findByText('1.1.0 으로 올리는 중입니다')).toBeTruthy();
    const sent = postedTo(api, '/api/market/install')[0];
    expect(sent).toMatchObject({ mode: 'update', version: '1.1.0', profile: 'sales', consents: ['c'.repeat(64)] });
    expect(JSON.stringify(sent)).not.toContain('k-1');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(await screen.findByText(/1.1.0 으로 올렸습니다/)).toBeTruthy();
    expect(postedTo(api, '/api/profile/action')).toEqual([{ name: 'sales', action: 'env_set', target: 'WIKI_KEY', value: 'k-1' }]);
  });
});
