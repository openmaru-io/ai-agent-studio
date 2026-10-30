/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 한글(HWP·HWPX) 작업 스레드(스펙 2026-10-20-005 리뷰 D4·D8, @rhwp/core 0.8.7).
// init: wasm 을 직접 받아 받은 양을 알린다(디자인 DV3). 15초 동안 받은 양이 없으면 stall(재검토 D8).
// open: 문서를 열어 쪽 수와 쪽 크기를 돌려준다. page: 쪽 하나를 SVG 로 그린다(id 는 쪽마다 따로, scopeSvgIds).
// rhwp 는 글자 폭을 캔버스로 잰다. Worker 에는 window·document 가 없지만 2026-10-20 시험에서 HWP 6쪽·HWPX 30쪽의 SVG 가
// 메인 스레드와 바이트까지 같았다(외부 검토 OV3 확인).
import init, { HwpDocument } from '@rhwp/core';

import { scopeSvgIds } from './docMath';
import { STALL_TIMEOUT } from './workerClient';

type Msg = { id: number; type: 'init'; wasmUrl: string } | { id: number; type: 'open'; bytes: ArrayBuffer } | { id: number; type: 'page'; page: number };

const post = (m: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);
let doc: HwpDocument | null = null;

async function fetchWasm(url: string): Promise<Uint8Array | null> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(String(res.status));
  const total = Number(res.headers.get('Content-Length')) || 0;
  const encoded = !!res.headers.get('Content-Encoding');
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stall = new Promise<'stall'>((ok) => (timer = setTimeout(() => ok('stall'), STALL_TIMEOUT)));
    const next = await Promise.race([reader.read(), stall]);
    clearTimeout(timer);
    if (next === 'stall') {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    if (next.done) break;
    parts.push(next.value);
    got += next.value.length;
    post({ event: 'progress', data: { got, total, encoded } });
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

self.onmessage = async (e: MessageEvent<Msg>) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      const wasm = await fetchWasm(m.wasmUrl);
      if (!wasm) return post({ id: m.id, ok: false, code: 'stall' });
      await init({ module_or_path: wasm });
      return post({ id: m.id, ok: true, data: null });
    }
    if (m.type === 'open') {
      doc = new HwpDocument(new Uint8Array(m.bytes));
      const pages = doc.pageCount();
      const sizes = Array.from({ length: pages }, (_, i) => {
        const info = JSON.parse(doc!.getPageInfo(i)) as { width: number; height: number };
        return { w: info.width, h: info.height };
      });
      return post({ id: m.id, ok: true, data: { pages, sizes } });
    }
    if (m.type === 'page') {
      if (!doc) return post({ id: m.id, ok: false, code: 'failed' });
      // 쪽 SVG 를 한 문서에 함께 넣으므로 쪽마다 id 를 따로 둔다(scopeSvgIds, OMAI-1508)
      return post({ id: m.id, ok: true, data: scopeSvgIds(doc.renderPageSvg(m.page - 1), m.page) });
    }
  } catch {
    post({ id: m.id, ok: false, code: 'failed' });
  }
};
