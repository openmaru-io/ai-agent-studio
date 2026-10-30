/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 다시 시도 간격(스펙 2026-10-20-030 R2). 웹소켓 연결(ws.ts)·채팅 대화 다시 열기·오피스 대화·회의실이 같은 식을 쓴다.
// 서버가 다시 시작되면 모든 탭이 같은 순간에 끊기므로 ±jitter 를 꼭 넣는다.

export interface BackoffOptions {
  base?: number;
  max?: number;
  jitter?: number;
  random?: () => number;
}

/** tries 번째 실패 뒤 기다릴 시간(ms): min(max, base × 2^(tries−1)) × (1 ± jitter). */
export function backoffDelay(tries: number, { base = 1000, max = 30000, jitter = 0.2, random = Math.random }: BackoffOptions = {}): number {
  const raw = Math.min(max, base * 2 ** Math.max(0, tries - 1));
  return raw * (1 - jitter + 2 * jitter * random());
}

/** 포기 한도(Q1): 처음 끊긴 때부터 5분 또는 12번. */
export const RETRY_MAX_TRIES = 12;
export const RETRY_MAX_MS = 5 * 60000;

export class RetryBudget {
  tries = 0;
  since: number;

  constructor(now = Date.now(), private maxTries = RETRY_MAX_TRIES, private maxMs = RETRY_MAX_MS) {
    this.since = now;
  }

  /** 실패를 하나 센다. 한도를 넘으면 false. */
  fail(now = Date.now()): boolean {
    this.tries += 1;
    return !this.exhausted(now);
  }

  exhausted(now = Date.now()): boolean {
    return this.tries >= this.maxTries || now - this.since >= this.maxMs;
  }

  /** 사람이 직접 다시 시도하면 한도를 새로 시작한다(DR10). */
  reset(now = Date.now()) {
    this.tries = 0;
    this.since = now;
  }

  /** 다음 시도까지 기다릴 시간 */
  delay(opts?: BackoffOptions): number {
    return backoffDelay(this.tries, opts);
  }
}
