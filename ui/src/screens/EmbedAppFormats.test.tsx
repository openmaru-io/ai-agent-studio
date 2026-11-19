/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 관리 › 임베드 앱 › 답 저장 형식(스펙 2026-11-18-012 §6-1·D15·D17·D22·D25⑨): 목록·통계·「—」, 빈 상태, 스위치, 예시 코드, 등록 대화 상자
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls: { method: string; url: string; body?: unknown }[] = [];
let listResp: unknown;
let failNext: { status: number; data: Record<string, unknown> } | null = null;
vi.mock('@/lib/api', async () => {
  const real = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  const rec = (method: string) => async (url: string, body?: unknown) => {
    calls.push({ method, url, body });
    if (failNext) {
      const f = failNext;
      failNext = null;
      throw new real.ApiError('err', f.status, '', '', false, f.data);
    }
    if (url.endsWith('/formats') && method === 'GET') return listResp;
    if (url.endsWith('/formats-try')) return { payload: { title: '시험' }, errors: [], truncated: false, elapsedMs: 1234 };
    return { id: 'work-log', version: 1, label: { ko: '작업 기록에 저장', en: 'Save' } };
  };
  // 목록은 apiFetch(HTTP)로 읽어야 한다 — get 은 웹소켓 req 로 레거시 처리기를 불러 Starlette 경로가 404 다
  const apiFetch = async (url: string, init?: RequestInit) => new Response(JSON.stringify(await rec(init?.method ?? 'GET')(url)), { status: 200 });
  return { ...real, get: () => Promise.reject(new Error('get(웹소켓) 을 쓰면 안 된다')), apiFetch, post: rec('POST'), put: rec('PUT'), del: rec('DELETE') };
});

import { SnackbarProvider } from 'notistack';

import { ConfirmProvider } from '@/components/ConfirmDialog';

import { EmbedAppFormats, snippets } from './EmbedAppFormats';

const SCHEMA = { type: 'object', properties: { title: { type: 'string', title: '제목', maxLength: 80 } }, required: ['title'], additionalProperties: false };
const FMT = {
  id: 'board-post',
  label: { ko: '게시판에 저장', en: 'Save to board' },
  schema: SCHEMA,
  instructions: '',
  version: 3,
  schemaHash: 'abc123',
  updated: 0,
  updatedBy: '',
  warnings: [{ path: '/title', keyword: 'title', message: 'x' }],
  stats: { fills: 4, failed: 1, outcomes: 2, saved: 1, edited: 3, saveRate: 0.5, editedAvg: 1.5 },
};

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SnackbarProvider>
        <ConfirmProvider>
          <EmbedAppFormats appId="emb_1" aasUrl="https://aas.example" />
        </ConfirmProvider>
      </SnackbarProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  calls.length = 0;
  failNext = null;
  listResp = { formats: [FMT, { ...FMT, id: 'idle', stats: null, warnings: [] }], page_schema: true, pageStats: null };
});
afterEach(cleanup);

describe('목록', () => {
  it('통계 열과 0건의 「—」, 경고 수, 페이지 형식 줄', async () => {
    mount();
    const row = await screen.findByTestId('embed-format-board-post');
    expect(row.textContent).toContain('게시판에 저장');
    expect(row.textContent).toContain('50%');
    expect(row.textContent).toContain('1.5');
    expect(row.textContent).toContain('경고 1개');
    expect(screen.getByTestId('embed-format-idle').textContent).toContain('—');
    expect(screen.getByText('페이지가 보낸 형식')).toBeTruthy();
  });

  it('형식이 없으면 빈 상태와 첫 동작', async () => {
    listResp = { formats: [], page_schema: false, pageStats: null };
    mount();
    expect(await screen.findByText('아직 저장 형식이 없습니다.')).toBeTruthy();
    expect(screen.queryByText('페이지가 보낸 형식')).toBeNull(); // 스위치가 꺼져 있으면 숨긴다
    fireEvent.click(screen.getByRole('button', { name: '예시 JSON 으로 만들기' }));
    expect(await screen.findByLabelText('예시 JSON')).toBeTruthy();
  });

  it('스위치는 formats-settings 로 저장한다', async () => {
    listResp = { formats: [FMT], page_schema: false, pageStats: null };
    mount();
    fireEvent.click(await screen.findByLabelText('페이지가 형식을 넘길 수 있음'));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')).toEqual({ method: 'PUT', url: '/api/admin/embed-apps/emb_1/formats-settings', body: { page_schema: true } }));
  });
});

describe('꼴이 다른 응답', () => {
  it('formats 가 없는 응답이면 이 묶음만 오류로 보이고 깨지지 않는다', async () => {
    listResp = { apps: [] };
    mount();
    expect(await screen.findByText('이 AAS 서버는 답 저장 형식을 지원하지 않습니다')).toBeTruthy();
  });
});

describe('예시 코드', () => {
  it('등록 형식은 실제 id·schemaHash, 페이지 형식은 앱이 허용할 때만', () => {
    const all = snippets('https://aas.example', FMT, true);
    expect(all.map((s) => s.id)).toEqual(['none', 'registered', 'page']);
    expect(all[1].code).toContain("format: \"board-post\"");
    expect(all[1].code).toContain('"abc123"');
    expect(snippets('https://aas.example', FMT, false).map((s) => s.id)).toEqual(['none', 'registered']);
  });
});

describe('등록 대화 상자', () => {
  it('예시 JSON → 초안 → 저장 본문', async () => {
    listResp = { formats: [], page_schema: false, pageStats: null };
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '형식 추가' }));
    fireEvent.change(screen.getByLabelText('형식 id'), { target: { value: 'work-log' } });
    fireEvent.change(screen.getByLabelText('버튼 이름(한국어)'), { target: { value: '작업 기록에 저장' } });
    fireEvent.change(screen.getByLabelText('버튼 이름(영어)'), { target: { value: 'Save to work log' } });
    fireEvent.click(screen.getByRole('tab', { name: '예시 JSON 으로 만들기' }));
    fireEvent.change(screen.getByLabelText('예시 JSON'), { target: { value: '{"title":"장애","count":2,"owner":null}' } });
    fireEvent.click(screen.getByRole('button', { name: '스키마 초안 만들기' }));
    expect(await screen.findByText('형식 확인 필요: /owner')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/formats'))).toBeTruthy());
    const body = calls.find((c) => c.method === 'POST' && c.url.endsWith('/formats'))!.body as Record<string, unknown>;
    expect(body).toMatchObject({ id: 'work-log', label: { ko: '작업 기록에 저장', en: 'Save to work log' }, instructions: '' });
    expect((body.schema as Record<string, unknown>).properties).toMatchObject({ count: { type: 'integer' } });
  });

  it('틀린 스키마는 저장을 막고 서버 오류 코드는 문장으로', async () => {
    mount();
    fireEvent.click((await screen.findAllByRole('button', { name: '고치기' }))[0]);
    const editor = screen.getByLabelText('JSON Schema');
    fireEvent.change(editor, { target: { value: '{"type":"object","properties":{"a":{"pattern":"x"}}}' } });
    expect(screen.getByText(/keyword "pattern" is not supported/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '저장' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(editor, { target: { value: JSON.stringify(SCHEMA) } });
    failNext = { status: 400, data: { code: 'format.text_too_long' } };
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    expect(await screen.findByText('버튼 이름은 40자, 채우는 법은 4,000자까지입니다')).toBeTruthy();
  });

  it('예시로 채워 보기는 결과를 읽기 전용 양식과 걸린 시간으로 보인다', async () => {
    mount();
    fireEvent.click((await screen.findAllByRole('button', { name: '고치기' }))[0]);
    fireEvent.click(screen.getByRole('tab', { name: '예시로 채워 보기' }));
    fireEvent.change(screen.getByLabelText('시험할 답 글'), { target: { value: '디스크 정리 절차' } });
    fireEvent.click(screen.getByRole('button', { name: '채워 보기' }));
    expect(await screen.findByText('1.2초 걸림')).toBeTruthy();
    expect(((screen.getByLabelText('제목 *') as HTMLInputElement).disabled)).toBe(true);
    expect(calls.find((c) => c.url.endsWith('/formats-try'))!.body).toMatchObject({ markdown: '디스크 정리 절차' });
  });
});
