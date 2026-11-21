/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 위젯 답 저장(스펙 2026-11-18-012 D2·D8·D9·D18·D20·D21·D23·D25·§6-1): 설정 검사, onSave 부르기, 판의 채우기 → 고치기 → 저장, 형식 없음 경로
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls: { url: string; init?: RequestInit }[] = [];
let answers: Record<string, { status: number; body: unknown } | (() => Promise<Response>)> = {};
vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const a = answers[`${init?.method ?? 'GET'} ${url.split('?')[0]}`] ?? { status: 404, body: { code: 'format.not_found' } };
    if (typeof a === 'function') return a();
    return new Response(JSON.stringify(a.body), { status: a.status });
  }),
}));

import { SnackbarProvider } from 'notistack';

import { EmbedContext } from '@/lib/embedContext';

import { resolveConfig } from '../../embed/config';
import { callOnSave, fill, type SaveAnswerConfig, validateSaveAnswer } from '../../embed/saveAnswer';
import { createWidgetStore, type WidgetStore } from '../../embed/state';
import { editedCount, fieldName, fromLocalInput, SaveAnswerButton, SaveAnswerPanel, toLocalInput } from './SaveAnswerFormat';

const SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string', title: '제목', maxLength: 80 }, category: { title: '분류', enum: ['질문', '공지'] } },
  required: ['title', 'category'],
  additionalProperties: false,
};
const LABEL = { ko: '게시판에 저장', en: 'Save to board' };
const FILLED = { payload: { title: '디스크 정리', category: '질문' }, errors: [], truncated: false, format: 'board-post', version: 2, schemaHash: 'abc', source: 'registered', schema: SCHEMA, filledAt: '2026-11-18T09:00:00Z', requestId: 'r1' };
const target = { markdown: '디스크가 찼습니다.\n로그를 지우세요.\n셋째 줄', question: '디스크가 찼어요', answerKey: 'k1', session: 's1', agent: 'main', pod: 'pod-a', profile: 'main' };

function storeWith(saveAnswer: Partial<SaveAnswerConfig>, state: 'ready' | 'pending' | 'disabled' = 'ready', source: 'registered' | 'page' | 'none' = 'registered'): WidgetStore {
  const s = createWidgetStore(resolveConfig({ backendUrl: 'https://aas.example', saveAnswer: saveAnswer as SaveAnswerConfig }));
  s.set({ status: 'ready', saveAnswer: { state, gen: 1, label: LABEL, source } });
  return s;
}

function mount(store: WidgetStore) {
  return render(
    <SnackbarProvider>
      <EmbedContext.Provider value={{ backendUrl: 'https://aas.example', widgetStore: store }}>
        <SaveAnswerButton target={target} />
        <SaveAnswerPanel store={store} />
      </EmbedContext.Provider>
    </SnackbarProvider>
  );
}

beforeEach(() => {
  calls.length = 0;
  answers = { 'POST /api/chat/answer-format/fill': { status: 200, body: FILLED }, 'POST /api/chat/answer-format/outcome': { status: 200, body: { ok: true } } };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('설정 검사(D21④)', () => {
  it('틀린 설정마다 코드 하나, 서버를 부르지 않는다', () => {
    const f = () => undefined;
    expect(validateSaveAnswer({ format: 'board-post', onSave: f }).ok).toBe(true);
    expect(validateSaveAnswer({ label: LABEL, onSave: f }).ok).toBe(true);
    const codes = (c: unknown) => validateSaveAnswer(c).errors.map((e) => e.code);
    expect(codes({ format: 'x' })).toEqual(['saveAnswer.on_save_not_function']);
    expect(codes({ format: 'x', schema: SCHEMA, onSave: f })).toEqual(['saveAnswer.format_and_schema']);
    expect(codes({ onSave: f })).toEqual(['saveAnswer.label_missing']);
    expect(codes({ onSave: f, label: { ko: '가'.repeat(41), en: 'x' } })).toEqual(['saveAnswer.label_too_long']);
    expect(codes({ onSave: f, label: { ko: '😀'.repeat(40), en: 'x' } })).toEqual([]); // 코드 포인트로 센다
    const bad = validateSaveAnswer({ onSave: f, label: LABEL, schema: { type: 'object', properties: { a: { pattern: 'x' } } } });
    expect(bad.errors).toEqual([{ code: 'saveAnswer.schema_invalid', path: '/properties/a/pattern', keyword: 'pattern' }]);
    expect(calls).toEqual([]);
  });
});

describe('onSave 부르기(D9·D18·D22⑤·D23)', () => {
  const r = { format: 'board-post', version: 1, schemaHash: 'h', source: 'registered' as const, payload: { a: { b: 1 } }, markdown: 'm', session: 's', answerKey: 'k', agent: 'a', filledAt: null, attemptId: 'x' };

  it('이행·거부·예외·문구 200자·retryable·깊은 복사', async () => {
    const seen: unknown[] = [];
    const ok = await callOnSave({ onSave: (x) => { seen.push(x); (x.payload as { a: { b: number } }).a.b = 9; return { message: '가'.repeat(300) }; } }, r);
    expect(ok).toEqual({ ok: true, message: '가'.repeat(200) });
    expect(r.payload.a.b).toBe(1); // 페이지가 고쳐도 위젯 값 그대로
    expect(await callOnSave({ onSave: () => Promise.reject({ message: '<b>안 됨</b>', retryable: false }) }, r)).toEqual({ ok: false, message: '<b>안 됨</b>', retryable: false, timedOut: false });
    expect(await callOnSave({ onSave: () => { throw new Error('boom'); } }, r)).toEqual({ ok: false, message: 'boom', retryable: true, timedOut: false });
  });

  it('timeoutMs 가 지나면 시간 초과, 늦은 결과는 late 로, 최대 120초', async () => {
    vi.useFakeTimers();
    let resolve: (v: unknown) => void = () => undefined;
    const late = vi.fn();
    const p = callOnSave({ timeoutMs: 999_999, onSave: () => new Promise((res) => (resolve = res)) }, r, late);
    await vi.advanceTimersByTimeAsync(119_999);
    let done = false;
    void p.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toEqual({ ok: false, message: '', retryable: true, timedOut: true });
    resolve({ message: '늦게' });
    await vi.advanceTimersByTimeAsync(0);
    expect(late).toHaveBeenCalledWith({ ok: true, message: '늦게' });
  });
});

describe('채우기 요청(D7·D14·D23)', () => {
  it('답 글은 32,000 코드 포인트로 잘라 원래 길이와 함께, sendContext:false 면 문맥 없음', async () => {
    const md = '😀'.repeat(32_001);
    await fill({ format: 'board-post', onSave: () => undefined }, { pod: 'p', profile: 'main', markdown: md, question: '가'.repeat(5000), context: { title: 't' } });
    let body = JSON.parse(String(calls[0].init?.body));
    expect(Array.from(body.markdown as string).length).toBe(32_000);
    expect(body.markdownLength).toBe(32_001);
    expect(Array.from(body.question as string).length).toBe(4_000);
    expect(body.context).toEqual({ title: 't' });
    expect(calls[0].url).toBe('/api/chat/answer-format/fill?pod=p');
    await fill({ format: 'board-post', sendContext: false, onSave: () => undefined }, { pod: 'p', profile: 'main', markdown: 'x', context: { title: 't' } });
    body = JSON.parse(String(calls[1].init?.body));
    expect(body.context).toBeUndefined();
  });
});

describe('도우미(§6-1)', () => {
  it('칸 이름은 title → description 첫 줄 → 키', () => {
    expect(fieldName({ title: '제목', description: '설명' }, 'k')).toBe('제목');
    expect(fieldName({ description: '첫 줄\n둘째' }, 'k')).toBe('첫 줄');
    expect(fieldName({}, 'k')).toBe('k');
  });
  it('고친 칸 수와 날짜 칸 변환', () => {
    expect(editedCount({ a: 1, b: [1, 2] }, { a: 1, b: [1, 3], c: 'x' })).toBe(2);
    const iso = fromLocalInput('2026-11-18T09:30');
    expect(iso).toMatch(/^2026-11-18T09:30:00[+-]\d{2}:\d{2}$/);
    expect(toLocalInput(iso)).toBe('2026-11-18T09:30');
  });
});

describe('판(§6·§6-1)', () => {
  it('단추 → 채우기 → 양식에서 고침 → 저장 → onSave 인자 → 체크·결과 신호', async () => {
    const onSave = vi.fn(async () => ({ message: '게시글 #7 로 저장했습니다' }));
    const store = storeWith({ format: 'board-post', onSave });
    store.set({ context: { source: 'mindwiki', title: '시험 게시판', url: 'https://board.example/7', pageId: '7' } });
    mount(store);
    fireEvent.click(screen.getByTestId('aas-save-answer'));
    expect(await screen.findByDisplayValue('디스크 정리')).toBeTruthy();
    expect(screen.getByText('게시판에 저장 · 시험 게시판 으로 넘깁니다')).toBeTruthy();
    const fillBody = JSON.parse(String(calls.find((c) => c.url.startsWith('/api/chat/answer-format/fill'))!.init?.body));
    expect(fillBody).toMatchObject({ format: 'board-post', profile: 'main', question: '디스크가 찼어요', context: { title: '시험 게시판', pageId: '7' } });
    fireEvent.change(screen.getByDisplayValue('디스크 정리'), { target: { value: '디스크 비우기' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const arg = (onSave.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(arg).toMatchObject({ format: 'board-post', version: 2, schemaHash: 'abc', source: 'registered', payload: { title: '디스크 비우기', category: '질문' }, session: 's1', answerKey: 'k1', agent: 'main', filledAt: '2026-11-18T09:00:00Z' });
    expect(String(arg.attemptId)).toMatch(/^[0-9a-f]{24}$/);
    expect(await screen.findByText('게시글 #7 로 저장했습니다')).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId('aas-save-answer-panel')).toBeNull());
    expect(store.get().savedKeys).toEqual(['k1']);
    const outcome = calls.filter((c) => c.url.startsWith('/api/chat/answer-format/outcome'));
    expect(outcome).toHaveLength(1);
    expect(JSON.parse(String(outcome[0].init?.body))).toEqual({ format: 'board-post', source: 'registered', outcome: 'saved', edited: 1 });
  });

  it('칸마다 이름이 이어져 있다(label·htmlFor, 스위치 포함)', async () => {
    const schema = { ...SCHEMA, properties: { ...SCHEMA.properties, important: { type: 'boolean', title: '중요 표시' }, dueAt: { type: 'string', title: '기한', format: 'date-time' } } };
    answers['POST /api/chat/answer-format/fill'] = { status: 200, body: { ...FILLED, schema, payload: { ...FILLED.payload, important: true } } };
    mount(storeWith({ format: 'board-post', onSave: vi.fn() }));
    fireEvent.click(screen.getByTestId('aas-save-answer'));
    expect(((await screen.findByLabelText('제목 *')) as HTMLInputElement).value).toBe('디스크 정리');
    expect((screen.getByLabelText('중요 표시') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByLabelText('기한')).toBeTruthy();
  });

  it('오류가 남으면 「저장 (오류 n)」이 꺼지고, 고치면 켜진다', async () => {
    answers['POST /api/chat/answer-format/fill'] = { status: 200, body: { ...FILLED, payload: { title: '', category: '기타' }, errors: [{ path: '/category', keyword: 'enum', message: 'x' }] } };
    mount(storeWith({ format: 'board-post', onSave: vi.fn() }));
    fireEvent.click(screen.getByTestId('aas-save-answer'));
    const save = await screen.findByRole('button', { name: '저장 (오류 1)' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('고칠 곳 1개')).toBeTruthy();
  });

  it('믿을 수 없는 글은 글자로 그린다(D25③)', async () => {
    const evil = { ...SCHEMA, properties: { title: { type: 'string', title: '<img src=x onerror=alert(1)>' }, category: SCHEMA.properties.category } };
    answers['POST /api/chat/answer-format/fill'] = { status: 200, body: { ...FILLED, schema: evil } };
    const { container } = mount(storeWith({ format: 'board-post', onSave: vi.fn() }));
    fireEvent.click(screen.getByTestId('aas-save-answer'));
    await screen.findByDisplayValue('디스크 정리');
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getAllByText(/<img src=x onerror=alert\(1\)>/).length).toBeGreaterThan(0);
  });

  it('429 는 남은 초를 보이고 그 뒤에 「새로 채우기」가 켜진다', async () => {
    answers['POST /api/chat/answer-format/fill'] = { status: 429, body: { code: 'format.rate_limited', retry_after: 2 } };
    mount(storeWith({ format: 'board-post', onSave: vi.fn() }));
    fireEvent.click(screen.getByTestId('aas-save-answer'));
    expect(await screen.findByText(/초 뒤 다시 하세요/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '새로 채우기' }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect((screen.getByRole('button', { name: '새로 채우기' }) as HTMLButtonElement).disabled).toBe(false), { timeout: 4000 });
  });

  it('onSave 가 retryable:false 로 거부하면 「다시 저장」이 없다', async () => {
    mount(storeWith({ format: 'board-post', onSave: () => Promise.reject({ message: '형식이 바뀌었습니다', retryable: false }) }));
    fireEvent.click(screen.getByTestId('aas-save-answer'));
    fireEvent.click(await screen.findByRole('button', { name: '저장' }));
    expect(await screen.findByText('형식이 바뀌었습니다')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '다시 저장' })).toBeNull();
  });

  it('판이 열린 동안 설정이 바뀌면 「페이지가 저장 설정을 바꿨습니다」(D18)', async () => {
    const store = storeWith({ format: 'board-post', onSave: vi.fn() });
    mount(store);
    fireEvent.click(screen.getByTestId('aas-save-answer'));
    await screen.findByDisplayValue('디스크 정리');
    act(() => store.set({ saveAnswer: { ...store.get().saveAnswer, gen: 2 } }));
    expect(await screen.findByText('페이지가 저장 설정을 바꿨습니다')).toBeTruthy();
  });

  it('400px 미만이면 「새로 채우기」가 판 머리의 아이콘으로 간다', async () => {
    const observers: Array<() => void> = [];
    class RO {
      constructor(private cb: () => void) {}
      observe() {
        observers.push(this.cb);
      }
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', RO);
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(360);
    try {
      mount(storeWith({ format: 'board-post', onSave: vi.fn() }));
      fireEvent.click(screen.getByTestId('aas-save-answer'));
      await screen.findByDisplayValue('디스크 정리');
      act(() => observers.forEach((f) => f()));
      const refill = await screen.findByRole('button', { name: '새로 채우기' });
      expect(refill.closest('h3')).toBeNull();
      expect(refill.textContent).toBe(''); // 아이콘 단추(이름은 aria-label)
    } finally {
      width.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('형식 없음은 서버를 부르지 않고 원문으로 onSave 를 한 번 부른다', async () => {
    const onSave = vi.fn(() => undefined);
    mount(storeWith({ label: LABEL, onSave }, 'ready', 'none'));
    fireEvent.click(screen.getByTestId('aas-save-answer'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect((onSave.mock.calls[0] as unknown[])[0]).toMatchObject({ source: 'none', format: null, payload: null, markdown: target.markdown });
    expect(calls).toEqual([]);
    expect(await screen.findByText('저장했습니다')).toBeTruthy();
  });

  it('조회 전에는 단추 자리만, 꺼지면 단추 없음', () => {
    const { unmount } = mount(storeWith({ format: 'board-post', onSave: vi.fn() }, 'pending'));
    expect(screen.queryByTestId('aas-save-answer')).toBeNull();
    unmount();
    mount(storeWith({ format: 'board-post', onSave: vi.fn() }, 'disabled'));
    expect(screen.queryByTestId('aas-save-answer')).toBeNull();
  });
});
