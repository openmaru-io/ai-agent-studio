/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 시험용 EventSource. 서버가 보내는 이벤트를 emit 으로 흉내 낸다.
export class FakeES {
  static all: FakeES[] = [];
  onmessage: ((m: { data: string; lastEventId: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void | Promise<void>) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeES.all.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, payload: Record<string, unknown> = {}, id = '') {
    this.onmessage?.({ data: JSON.stringify({ type, payload }), lastEventId: id });
  }
}
