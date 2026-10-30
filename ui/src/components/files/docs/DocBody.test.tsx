/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 문서 본문의 공통 틀(스펙 2026-10-20-005): 라이브러리를 받기 전 거르기(리뷰 D7·D13) → 작은 창 + 받기 포커스(재검토 D3),
// 묶음을 못 받으면 「새 버전」 + 새로 고침(리뷰 D12), 그 밖의 실패는 다시 시도(리뷰 D3).
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { isChunkError } from '@/lib/chunkError';
import { mountScreen, stubApi } from '@/test/mountScreen';

import { openViewer, type ViewerFile } from '../viewerStore';

vi.mock('./PdfBody', () => {
  throw new TypeError('Failed to fetch dynamically imported module: /assets/PdfBody-old.js');
});

const file = (name: string): ViewerFile => ({ name, url: `/api/chat/files?pod=p&path=workspace%2F${name}`, source: 'agent', path: `workspace/${name}` });

function open(f: ViewerFile, body: Uint8Array, headers: Record<string, string> = {}) {
  stubApi({ '/api/chat/files': () => new Response(body, { status: 200, headers: { 'Content-Length': String(body.length), ...headers } }) });
  mountScreen(<div />, '/chat');
  act(() => openViewer(f));
}

/** 목차만 있는 zip — 풀면 커지는 크기를 적어 압축 폭탄을 흉내 낸다 */
function bombZip(): Uint8Array {
  const name = new TextEncoder().encode('word/document.xml');
  const out = new Uint8Array(46 + name.length + 22);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x02014b50, true);
  dv.setUint32(20, 1000, true);
  dv.setUint32(24, 300 * 1024 * 1024, true);
  dv.setUint16(28, name.length, true);
  out.set(name, 46);
  const end = 46 + name.length;
  dv.setUint32(end, 0x06054b50, true);
  dv.setUint16(end + 10, 1, true);
  return out;
}

describe('DocBody', () => {
  it('암호가 걸린 docx(CFB)는 라이브러리를 받지 않고 작은 창 + 받기에 포커스', async () => {
    open(file('secret.docx'), new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    const dlg = await screen.findByRole('dialog', { name: 'secret.docx' });
    expect(await within(dlg).findByText('암호가 걸렸거나 옛 형식(doc·xls·ppt)이라 미리 볼 수 없습니다')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(within(dlg).getByRole('button', { name: '받기' })));
  });

  it('풀면 너무 커지는 docx 는 압축 폭탄으로 거른다', async () => {
    open(file('bomb.docx'), bombZip());
    const dlg = await screen.findByRole('dialog', { name: 'bomb.docx' });
    expect(await within(dlg).findByText('압축을 풀면 너무 커서 미리 볼 수 없습니다')).toBeTruthy();
  });

  it('본문 묶음을 받지 못하면(다시 배포) 「새 버전」과 새로 고침', async () => {
    open(file('a.pdf'), new TextEncoder().encode('%PDF-1.4'));
    const dlg = await screen.findByRole('dialog', { name: 'a.pdf' });
    expect(await within(dlg).findByText('새 버전이 배포되었습니다. 새로 고침하세요')).toBeTruthy();
    expect(within(dlg).getByRole('button', { name: '새로 고침' })).toBeTruthy();
    expect(within(dlg).queryByRole('button', { name: '다시 시도' })).toBeNull();
  });

  it('002 형식도 열린 뒤 작은 창으로 줄면 받기에 포커스(재검토 D3 — 공통 코드에서 고침)', async () => {
    // 응답을 늦춰 창이 다 열린 뒤에 작은 창으로 줄게 한다(처음 포커스는 onEntered 가 이미 옮긴 뒤)
    stubApi({ '/api/chat/files': () => new Response('x', { status: 200, headers: { 'Content-Length': String(21 * 1024 * 1024) } }) });
    mountScreen(<div />, '/chat');
    const quick = globalThis.fetch;
    vi.stubGlobal('fetch', async (u: string, i?: RequestInit) => {
      if (String(u).startsWith('/api/chat/files')) await new Promise((r) => setTimeout(r, 600));
      return quick(u, i);
    });
    act(() => openViewer(file('p.png')));
    const dlg = await screen.findByRole('dialog', { name: 'p.png' });
    await within(dlg).findByText('너무 커서 미리 볼 수 없습니다');
    await waitFor(() => expect(document.activeElement).toBe(within(dlg).getByRole('button', { name: '받기' })));
  });

  it('동적 import 실패 문구를 브라우저마다 알아본다', () => {
    expect(isChunkError(new TypeError('Failed to fetch dynamically imported module: x'))).toBe(true);
    expect(isChunkError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkError(new Error('error loading dynamically imported module'))).toBe(true);
    expect(isChunkError(new Error('Invalid PDF structure'))).toBe(false);
  });
});
