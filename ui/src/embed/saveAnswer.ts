/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 위젯 답 저장(cogentai-aas-docs security/chat-embed-save-answer 2026-11-18-012). 페이지가 saveAnswer 를 주면 답 말풍선에 저장 단추가 생긴다.
// 형식이 있으면 서버가 형식대로 채우고(/api/chat/answer-format/fill) 사람이 위젯 판에서 확인한 뒤 페이지의 onSave 를 부른다.
// 형식이 없으면 서버를 부르지 않고 원문 답을 바로 넘긴다(D2·D4). 이 파일은 화면 밖의 규칙(설정 검사·조회·onSave 부르기)만 둔다.
import { apiFetch } from '@/lib/api';

import { checkSchema, codePointLength, cutCodePoints } from '../components/chat/schemaForm/validate';

export const LABEL_MAX = 40;
export const MESSAGE_MAX = 200;
export const TIMEOUT_DEFAULT = 30_000;
export const TIMEOUT_MAX = 120_000;
export const MARKDOWN_MAX = 32_000;
export const QUESTION_MAX = 4_000;

export type SaveSource = 'registered' | 'page' | 'none';

export interface SaveAnswerResult {
  format: string | null;
  version: number | null;
  schemaHash: string | null;
  source: SaveSource;
  payload: unknown;
  markdown: string;
  session: string;
  answerKey: string;
  agent: string;
  filledAt: string | null;
  attemptId: string;
}

export interface SaveAnswerError {
  code: string;
  detail?: Record<string, unknown>;
  path?: string;
  keyword?: string;
}

export interface SaveAnswerConfig {
  /** 등록 형식 id(관리자가 임베드 앱에 등록). schema 와 함께 줄 수 없다 */
  format?: string;
  /** 페이지 형식(JSON Schema). 임베드 앱이 허용할 때만 받는다 */
  schema?: Record<string, unknown>;
  /** 페이지 형식의 채우는 법(선택) */
  instructions?: string;
  /** 단추 이름. 페이지 형식·형식 없음일 때 필요하다(등록 형식은 관리자 이름을 쓴다) */
  label?: { ko: string; en: string };
  /** 사람이 「저장」을 누르면 부른다. {message} 를 돌려주면 그 문구를 보인다. {message, retryable:false} 로 거부하면 「다시 저장」을 숨긴다 */
  onSave: (r: SaveAnswerResult) => unknown;
  /** 설정 검사·형식 조회 실패를 알린다(D21) */
  onError?: (e: SaveAnswerError) => void;
  /** onSave 를 기다리는 시간(기본 30,000, 최대 120,000 ms, D23) */
  timeoutMs?: number;
  /** false 면 페이지 문맥(setContext)을 채우기에 보내지 않는다(D23) */
  sendContext?: boolean;
}

export type SaveAnswerStateName = 'ready' | 'pending' | 'disabled';

export interface SaveAnswerRuntime {
  state: SaveAnswerStateName;
  code?: string;
  detail?: Record<string, unknown>;
  path?: string;
  /** 단추에 쓸 이름(등록 형식이면 서버가 준 관리자 이름) */
  label?: { ko: string; en: string };
  source?: SaveSource;
  /** 조회한 판(등록 형식). onSave 에는 채우기 응답의 판을 넘긴다(D24⑥) */
  version?: number;
  /** 설정이 바뀔 때마다 오른다 — 열린 판·늦은 결과를 가른다(D18·D25⑥) */
  gen: number;
}

/** 서버·LLM 을 부르지 않는 동기 검사(D21④). 틀린 곳마다 코드 하나 */
export function validateSaveAnswer(config: unknown): { ok: boolean; errors: SaveAnswerError[] } {
  const errors: SaveAnswerError[] = [];
  const c = (config ?? {}) as Partial<SaveAnswerConfig>;
  if (typeof c.onSave !== 'function') errors.push({ code: 'saveAnswer.on_save_not_function' });
  const hasFormat = typeof c.format === 'string' && c.format !== '';
  const hasSchema = c.schema !== undefined && c.schema !== null;
  if (hasFormat && hasSchema) errors.push({ code: 'saveAnswer.format_and_schema' });
  if (!hasFormat) {
    const l = c.label;
    if (!l || typeof l.ko !== 'string' || typeof l.en !== 'string' || !l.ko.trim() || !l.en.trim()) errors.push({ code: 'saveAnswer.label_missing' });
    else if (codePointLength(l.ko) > LABEL_MAX || codePointLength(l.en) > LABEL_MAX) errors.push({ code: 'saveAnswer.label_too_long' });
  }
  if (hasSchema && !hasFormat) {
    const out = checkSchema(c.schema);
    for (const e of out.errors) errors.push({ code: 'saveAnswer.schema_invalid', path: e.path, keyword: e.keyword });
    if (out.code && !out.errors.length) errors.push({ code: 'saveAnswer.schema_invalid', keyword: 'size' });
  }
  return { ok: errors.length === 0, errors };
}

export const sourceOf = (c: SaveAnswerConfig): SaveSource => (c.format ? 'registered' : c.schema ? 'page' : 'none');

/** 콘솔 한 줄(D21③). 토큰·답 글은 넣지 않는다 */
export function consoleLine(e: SaveAnswerError, app: string, format: string): string {
  const fix: Record<string, string> = {
    'saveAnswer.on_save_not_function': 'onSave must be a function',
    'saveAnswer.label_missing': 'give label.ko and label.en',
    'saveAnswer.label_too_long': `keep label.ko and label.en within ${LABEL_MAX} characters`,
    'saveAnswer.format_and_schema': 'give either format or schema, not both',
    'saveAnswer.schema_invalid': `fix the schema at ${e.path ?? ''} (${e.keyword ?? ''})`,
    'saveAnswer.lookup_failed': `the server answered ${String(e.detail?.code ?? '')}; for format.page_schema_off turn on "pages can send a format" in Settings > Embed apps`,
  };
  return `[AAS saveAnswer] ${e.code} app=${app || '-'} format=${format || '-'}: ${fix[e.code] ?? 'see the widget manual'}`;
}

export interface ProblemBody {
  code?: string;
  retry_after?: number;
  requestId?: string;
  detail?: Record<string, unknown>;
  errors?: Array<{ path: string; keyword: string; message: string }>;
}

async function readJson(r: Response): Promise<Record<string, unknown>> {
  try {
    return (await r.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 형식 조회(D16). 등록 형식은 이름·판, 페이지 형식은 앱 허용 여부를 본다 */
export async function lookupFormat(c: SaveAnswerConfig): Promise<{ ok: true; label?: { ko: string; en: string }; version?: number } | { ok: false; code: string; requestId?: string }> {
  const source = sourceOf(c);
  if (source === 'none') return { ok: true };
  const url = source === 'registered' ? `/api/chat/answer-format/info?format=${encodeURIComponent(c.format!)}` : '/api/chat/answer-format/info?pageSchema=1';
  let r: Response;
  try {
    r = await apiFetch(url, {});
  } catch {
    return { ok: false, code: 'network' };
  }
  const body = await readJson(r);
  if (!r.ok) return { ok: false, code: String(body.code ?? `http_${r.status}`), requestId: body.requestId as string | undefined };
  if (source === 'page') return body.page_schema ? { ok: true } : { ok: false, code: 'format.page_schema_off' };
  return { ok: true, label: body.label as { ko: string; en: string }, version: Number(body.version) };
}

export interface FillRequest {
  pod: string;
  profile: string;
  markdown: string;
  question?: string;
  context?: Record<string, unknown> | null;
}

export interface FillResponse {
  payload: unknown;
  errors: Array<{ path: string; keyword: string; message: string }>;
  truncated: boolean;
  format: string | null;
  version: number | null;
  schemaHash: string;
  source: SaveSource;
  /** 채운 스키마(등록 형식도 돌려준다 — 위젯이 양식을 그리고 같은 규칙으로 검사한다) */
  schema: Record<string, unknown>;
  filledAt: string;
  requestId: string;
}

/** 채우기(D7: 답 글은 앞 32,000 코드 포인트로 잘라 원래 길이와 함께, 질문은 4,000). 실패는 ProblemBody 를 담은 FillFailure */
export class FillFailure extends Error {
  constructor(
    readonly status: number,
    readonly body: ProblemBody
  ) {
    super(body.code ?? `http_${status}`);
  }
}

export async function fill(c: SaveAnswerConfig, req: FillRequest, signal?: AbortSignal): Promise<FillResponse> {
  const body: Record<string, unknown> = {
    profile: req.profile,
    markdown: cutCodePoints(req.markdown, MARKDOWN_MAX),
    markdownLength: codePointLength(req.markdown),
  };
  if (req.question) body.question = cutCodePoints(req.question, QUESTION_MAX);
  if (c.format) body.format = c.format;
  else {
    body.schema = c.schema;
    if (c.instructions) body.instructions = c.instructions;
  }
  if (req.context && c.sendContext !== false) body.context = req.context;
  let r: Response;
  try {
    r = await apiFetch(`/api/chat/answer-format/fill?pod=${encodeURIComponent(req.pod)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    throw new FillFailure(0, { code: 'network' });
  }
  const out = await readJson(r);
  if (!r.ok) throw new FillFailure(r.status, out as ProblemBody);
  return out as unknown as FillResponse;
}

/** 판을 닫을 때 한 번(D20). 실패해도 위젯 동작은 그대로다 */
export function sendOutcome(pod: string, v: { format: string | null; source: SaveSource; outcome: 'saved' | 'cancelled' | 'save_failed'; edited: number }): void {
  const body = { format: v.source === 'registered' ? v.format : v.source === 'page' ? 'page' : 'none', source: v.source, outcome: v.outcome, edited: Math.max(0, Math.min(10_000, v.edited | 0)) };
  void apiFetch(`/api/chat/answer-format/outcome?pod=${encodeURIComponent(pod)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => undefined);
}

export type SaveOutcome = { ok: true; message: string } | { ok: false; message: string; retryable: boolean; timedOut: boolean };

const clip = (s: unknown): string => cutCodePoints(String(s ?? ''), MESSAGE_MAX);

/** 저장 한 번마다 새로 만든다. 같은 payload 의 「다시 저장」은 같은 값을 쓴다(D8) */
export function newAttemptId(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b); // http 사이트에서도 된다(randomUUID 는 보안 컨텍스트에서만)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** onSave 를 부르고 기다린다(D9). 페이지가 고쳐도 위젯 값이 바뀌지 않게 payload 를 깊이 복사한다(D18). 예외는 밖으로 내보내지 않는다.
 *  timeoutMs 가 지나면 timedOut 으로 끝나고, 늦게 온 결과는 late 콜백으로 알린다 */
export function callOnSave(c: SaveAnswerConfig, r: SaveAnswerResult, late?: (o: SaveOutcome) => void): Promise<SaveOutcome> {
  const timeout = Math.min(TIMEOUT_MAX, Math.max(1000, Number(c.timeoutMs) || TIMEOUT_DEFAULT));
  const arg: SaveAnswerResult = { ...r, payload: r.payload === null ? null : structuredClone(r.payload) };
  let settled = false;
  return new Promise<SaveOutcome>((resolve) => {
    const finish = (o: SaveOutcome) => {
      if (settled) {
        late?.(o);
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(o);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, message: '', retryable: true, timedOut: true });
    }, timeout);
    let ret: unknown;
    try {
      ret = c.onSave(arg);
    } catch (e) {
      const err = (e ?? {}) as { message?: unknown; retryable?: unknown };
      finish({ ok: false, message: clip(err.message), retryable: err.retryable !== false, timedOut: false });
      return;
    }
    Promise.resolve(ret).then(
      (v) => finish({ ok: true, message: clip((v as { message?: unknown } | undefined)?.message) }),
      (e) => {
        const err = (e ?? {}) as { message?: unknown; retryable?: unknown };
        finish({ ok: false, message: clip(err.message), retryable: err.retryable !== false, timedOut: false });
      }
    );
  });
}
