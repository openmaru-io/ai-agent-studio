/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 「MindWiki 에 저장」(스펙 2026-11-15-002 A4·D19): 위젯 안에서는 없음, 기억한 위치로 바로 저장, 같은 키, 실패 이유는 문장, 위치를 다시 고르기
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EmbedContext } from '@/lib/embedContext';

const calls: { url: string; init?: RequestInit }[] = [];
let answers: Record<string, { status: number; body: unknown }> = {};
vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const key = `${init?.method ?? 'GET'} ${url.split('?')[0]}`;
    const a = answers[key] ?? { status: 404, body: { ok: false, reason: 'invalid' } };
    return new Response(JSON.stringify(a.body), { status: a.status });
  }),
}));

import { SnackbarProvider } from 'notistack';

import { defaultTitle, forgetSaveState, reasonText, SaveFileToMindwiki, saveKey,SaveToMindwiki } from './MindwikiSave';

const target = { teamspace: 'ts1', parent_id: 'p1', parent_title: '메모', path: '개발' };
const props = { pod: 'pod-a', profile: 'main', conversation: 'conv1', message: 'msg1', markdown: '# 배포 절차\n\n본문', agent: 'main' };

beforeEach(() => {
  calls.length = 0;
  forgetSaveState();
  answers = { 'GET /api/mindwiki/save/state': { status: 200, body: { available: true, hidden: false, reason: '', target } } };
});
afterEach(cleanup);

describe('도우미', () => {
  it('제목은 답의 첫 제목 줄, 없으면 「<에이전트> 답 <날짜>」', () => {
    expect(defaultTitle('앞말\n## 회의 요약 ##\n본문', 'main')).toBe('회의 요약');
    expect(defaultTitle('제목 없는 답', 'main', new Date(2026, 10, 15))).toBe('main 답 2026-11-15');
  });
  it('요청 키는 (대화, 메시지, 저장 위치)', () => {
    expect(saveKey('c', 'm', 'p')).toBe('c:m:p');
    expect(saveKey('c'.repeat(300), 'm', 'p')).toHaveLength(200);
  });
  it('모르는 이유는 「저장하지 못했습니다」', () => {
    expect(reasonText('write_disabled')).toBe('관리자가 MindWiki 쓰기를 막았습니다.');
    expect(reasonText('what')).toBe('저장하지 못했습니다.');
  });
});

describe('SaveToMindwiki', () => {
  it('위젯 안에서는 그리지 않고 상태도 묻지 않는다(D19)', async () => {
    render(
      <EmbedContext.Provider value={{ backendUrl: 'https://aas' }}>
        <SaveToMindwiki {...props} />
      </EmbedContext.Provider>
    );
    await act(async () => undefined);
    expect(screen.queryByTestId('mw-save')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('Keycloak 로그인이 아닌 설치에서는 숨긴다', async () => {
    answers['GET /api/mindwiki/save/state'] = { status: 200, body: { available: false, hidden: true, reason: 'no_keycloak', target: null } };
    render(<SaveToMindwiki {...props} />);
    await act(async () => undefined);
    expect(screen.queryByTestId('mw-save')).toBeNull();
  });

  it('쓰기가 막혔으면 단추를 막고 이유를 툴팁으로', async () => {
    answers['GET /api/mindwiki/save/state'] = { status: 200, body: { available: false, hidden: false, reason: 'write_disabled', target } };
    render(<SaveToMindwiki {...props} />);
    const btn = await screen.findByTestId('mw-save');
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('기억한 위치로 바로 저장하고 같은 키를 보낸다. 저장됨과 「MindWiki 에서 열기」', async () => {
    answers['POST /api/mindwiki/save/answer'] = { status: 200, body: { ok: true, page_id: 'p9', url: 'https://wiki/p/p9' } };
    render(<SaveToMindwiki {...props} />);
    expect(await screen.findByText(/저장 위치: 개발 › 메모/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('mw-save'));
    await waitFor(() => expect(screen.getByTestId('mw-saved').textContent).toContain('「배포 절차」 에 저장했습니다'));
    expect(screen.getByRole('link', { name: 'MindWiki 에서 열기' }).getAttribute('href')).toBe('https://wiki/p/p9');
    const post = calls.find((c) => c.init?.method === 'POST')!;
    expect(JSON.parse(String(post.init!.body))).toMatchObject({ pod: 'pod-a', profile: 'main', key: 'conv1:msg1:p1', parent_id: 'p1', title: '배포 절차', markdown: props.markdown });
  });

  it('위치가 지워졌으면 이유를 보이고 위치 고르기를 연다', async () => {
    answers['POST /api/mindwiki/save/answer'] = { status: 404, body: { ok: false, reason: 'parent_not_found' } };
    answers['GET /api/mindwiki/save/teamspaces'] = { status: 200, body: { teamspaces: [{ id: 'ts1', name: '개발' }] } };
    answers['GET /api/mindwiki/save/pages'] = { status: 200, body: { pages: [] } };
    render(<SaveToMindwiki {...props} />);
    fireEvent.click(await screen.findByTestId('mw-save'));
    expect(await screen.findByText('저장 위치의 페이지가 지워졌습니다. 위치를 다시 고르세요.')).toBeTruthy();
    expect(await screen.findByRole('dialog', { name: 'MindWiki 저장 위치' })).toBeTruthy();
    expect(await screen.findByText('하위 페이지를 만들 수 있는 페이지가 없습니다.')).toBeTruthy();
  });

  it('처음이면 위치를 고르고 기억한 뒤 저장한다', async () => {
    answers['GET /api/mindwiki/save/state'] = { status: 200, body: { available: true, hidden: false, reason: '', target: null } };
    answers['GET /api/mindwiki/save/teamspaces'] = { status: 200, body: { teamspaces: [{ id: 'ts1', name: '개발' }] } };
    answers['GET /api/mindwiki/save/pages'] = { status: 200, body: { pages: [{ id: 'p7', title: '회의록', path: '' }] } };
    answers['PUT /api/mindwiki/save/target'] = { status: 200, body: { ok: true } };
    answers['POST /api/mindwiki/save/answer'] = { status: 200, body: { ok: true, page_id: 'p8', url: 'https://wiki/p/p8' } };
    render(<SaveToMindwiki {...props} />);
    fireEvent.click(await screen.findByTestId('mw-save'));
    fireEvent.click(await screen.findByTestId('mw-page'));
    fireEvent.click(screen.getByTestId('mw-pick-save'));
    await waitFor(() => expect(screen.getByTestId('mw-saved')).toBeTruthy());
    const put = calls.find((c) => c.init?.method === 'PUT')!;
    expect(JSON.parse(String(put.init!.body))).toMatchObject({ pod: 'pod-a', profile: 'main', parent_id: 'p7', parent_title: '회의록', path: '개발' });
    const post = calls.find((c) => c.init?.method === 'POST')!;
    expect(JSON.parse(String(post.init!.body)).key).toBe('conv1:msg1:p7');
  });
});

describe('SaveFileToMindwiki', () => {
  it('기억한 위치의 「AAS 파일」 페이지로 파일을 보내고 결과를 알린다', async () => {
    answers['POST /api/mindwiki/save/file'] = { status: 200, body: { ok: true, page_id: 'pf', name: '보고서.pdf', url: 'https://wiki/p/pf' } };
    render(
      <SnackbarProvider>
        <SaveFileToMindwiki pod="pod-a" profile="main" path="/workspace/보고서.pdf" name="보고서.pdf" />
      </SnackbarProvider>
    );
    fireEvent.click(await screen.findByTestId('mw-save-file'));
    expect(await screen.findByText('「보고서.pdf」 에 저장했습니다')).toBeTruthy();
    const post = calls.find((c) => c.init?.method === 'POST')!;
    expect(JSON.parse(String(post.init!.body))).toMatchObject({ pod: 'pod-a', profile: 'main', path: '/workspace/보고서.pdf', parent_id: 'p1', key: 'file:/workspace/보고서.pdf:p1' });
  });

  it('너무 큰 파일은 MindWiki 의 이유를 그대로 문장으로', async () => {
    answers['POST /api/mindwiki/save/file'] = { status: 413, body: { ok: false, reason: 'attachment_too_large' } };
    render(
      <SnackbarProvider>
        <SaveFileToMindwiki pod="pod-a" profile="main" path="/workspace/big.zip" name="big.zip" />
      </SnackbarProvider>
    );
    fireEvent.click(await screen.findByTestId('mw-save-file'));
    expect(await screen.findByText('파일이 MindWiki 첨부 한도보다 큽니다.')).toBeTruthy();
  });
});
