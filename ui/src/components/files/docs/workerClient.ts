/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 문서 작업 스레드(hwp.worker·xlsx.worker)와 주고받는 공통 부분(스펙 2026-10-20-005 리뷰 D4·D8·D14, 재검토 D8).
// 요청마다 번호를 붙이고 시간 한도를 둔다. 스레드가 죽으면(onerror·메모리 부족) 기다리던 요청을 모두 실패로 돌린다.
// 문서마다 새 스레드를 만들고 닫으면 terminate 한다(리뷰 D8) — 부르는 쪽이 terminate 를 부른다.

/** 해석 한도(리뷰 D14). wasm 초기화가 끝난 뒤부터 센다(디자인 DV3) */
export const OPEN_TIMEOUT = 30_000;
/** 쪽 하나 그리기 한도와 받기 멈춤 감지(재검토 D8) */
export const PAGE_TIMEOUT = 15_000;
export const STALL_TIMEOUT = 15_000;

export type WorkerFailCode = 'timeout' | 'workerError' | 'stall' | 'gone' | 'failed';

export class DocWorkerError extends Error {
  constructor(public code: WorkerFailCode) {
    super(code);
  }
}

/** 작업 스레드 쪽 응답 모양 */
export type Reply = { id: number; ok: true; data: unknown } | { id: number; ok: false; code: WorkerFailCode } | { event: string; data: unknown };

type Port = Pick<Worker, 'postMessage' | 'terminate'> & {
  onmessage: ((e: MessageEvent<Reply>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  onmessageerror?: ((e: MessageEvent) => void) | null;
};

export interface DocWorker {
  request<T>(msg: Record<string, unknown>, timeout: number, transfer?: Transferable[]): Promise<T>;
  /** 요청 번호 없이 오는 알림(받기 진행 등) */
  on(event: string, cb: (data: unknown) => void): void;
  terminate(): void;
}

export function connect(port: Port): DocWorker {
  let seq = 0;
  let dead = false;
  const pending = new Map<number, { ok: (v: unknown) => void; fail: (e: DocWorkerError) => void; timer: ReturnType<typeof setTimeout> }>();
  const listeners = new Map<string, (data: unknown) => void>();
  const failAll = (code: WorkerFailCode) => {
    dead = true;
    pending.forEach((p) => {
      clearTimeout(p.timer);
      p.fail(new DocWorkerError(code));
    });
    pending.clear();
  };
  port.onmessage = (e) => {
    const r = e.data;
    if ('event' in r) return listeners.get(r.event)?.(r.data);
    const p = pending.get(r.id);
    if (!p) return;
    pending.delete(r.id);
    clearTimeout(p.timer);
    if (r.ok) p.ok(r.data);
    else p.fail(new DocWorkerError(r.code));
  };
  port.onerror = (e) => {
    e.preventDefault?.();
    failAll('workerError');
  };
  port.onmessageerror = () => failAll('workerError');
  return {
    request<T>(msg: Record<string, unknown>, timeout: number, transfer: Transferable[] = []) {
      if (dead) return Promise.reject(new DocWorkerError('workerError'));
      const id = ++seq;
      return new Promise<T>((ok, fail) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          fail(new DocWorkerError('timeout'));
        }, timeout);
        pending.set(id, { ok: ok as (v: unknown) => void, fail, timer });
        port.postMessage({ ...msg, id }, transfer);
      });
    },
    on(event, cb) {
      listeners.set(event, cb);
    },
    terminate() {
      failAll('gone');
      port.terminate();
    },
  };
}

/** 받기 진행 문구(재검토 D2): 압축 응답이면 받은 양만, 아니면 받은 양 / 전체 */
export function progressText(got: number, total: number, encoded: boolean): { known: boolean; text: string } {
  const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);
  if (encoded || !total) return { known: false, text: `${mb(got)} MB` };
  return { known: true, text: `${mb(got)} / ${mb(total)} MB` };
}
