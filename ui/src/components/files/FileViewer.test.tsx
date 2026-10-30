/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 파일 뷰어 본문(스펙 2026-10-20-002 §3-5): 한도는 Content-Length 로(R3), 글은 앞부분만, 그 밖은 받지 않음, 실패는 X-AAS-Code(F2),
// HTML 은 빈 sandbox + 정리한 srcdoc(R5), 그림은 종류 형식의 Blob(F1), 닫으면 요청을 끊고 Blob 주소를 놓는다.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountScreen, stubApi } from '@/test/mountScreen';

import { decodeText } from './FileViewer';
import { closeViewer, openViewer, type ViewerFile } from './viewerStore';

const file = (name: string, over: Partial<ViewerFile> = {}): ViewerFile => ({ name, url: `/api/chat/files?pod=p&path=workspace%2F${name}`, source: 'agent', path: `workspace/${name}`, ...over });

const created: Blob[] = [];
beforeEach(() => {
  created.length = 0;
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn((b: Blob) => (created.push(b), `blob:${created.length}`)), revokeObjectURL: vi.fn() }));
});
afterEach(() => vi.unstubAllGlobals());

function open(f: ViewerFile, body: BodyInit | null, headers: Record<string, string> = {}, status = 200) {
  const fn = stubApi({ '/api/chat/files': () => new Response(body, { status, headers }) });
  mountScreen(<div />, '/chat');
  act(() => openViewer(f));
  return fn;
}

describe('FileViewer', () => {
  it('받기 요청은 X-AAS 머리를 보낸다(F12)', async () => {
    const fn = open(file('a.txt'), 'hi', { 'Content-Length': '2' });
    await screen.findByRole('dialog', { name: 'a.txt' });
    await waitFor(() => expect(fn).toHaveBeenCalled());
    expect((fn.mock.calls[0][1] as RequestInit).headers).toMatchObject({ 'X-AAS': '1' });
  });

  it('머리의 크기는 응답 Content-Length 로 채운다(크기 모르는 뱃지, DD9)', async () => {
    open(file('a.txt'), 'hello', { 'Content-Length': '5' });
    const dlg = await screen.findByRole('dialog', { name: 'a.txt' });
    expect(await within(dlg).findByText(/^5 B · /)).toBeTruthy();
  });

  it('2 MB 를 넘는 글은 앞부분만 보이고 「일부만 보입니다」 띠(R3, DD7)', async () => {
    const big = 'a'.repeat(2 * 1024 * 1024 + 10);
    open(file('big.log'), big, { 'Content-Length': String(big.length) });
    const dlg = await screen.findByRole('dialog', { name: 'big.log' });
    expect(await within(dlg).findByRole('status')).toHaveTextContent('일부만 보입니다');
  });

  it('20 MB 를 넘는 그림은 받지 않고 「너무 커서 미리 볼 수 없습니다」(DD8)', async () => {
    open(file('p.png'), 'x', { 'Content-Length': String(21 * 1024 * 1024) });
    const dlg = await screen.findByRole('dialog', { name: 'p.png' });
    expect(await within(dlg).findByText('너무 커서 미리 볼 수 없습니다')).toBeTruthy();
    expect(created).toHaveLength(0);
  });

  it('실패는 X-AAS-Code 의 이유와 다시 시도·받기(DD6)', async () => {
    open(file('a.txt'), null, { 'X-AAS-Code': 'busy' }, 429);
    const dlg = await screen.findByRole('dialog', { name: 'a.txt' });
    expect(await within(dlg).findByText('잠시 뒤 다시 시도하세요')).toBeTruthy();
    expect(within(dlg).getByRole('button', { name: '다시 시도' })).toBeTruthy();
  });

  it('빈 파일은 「빈 파일입니다」', async () => {
    open(file('e.txt'), '', { 'Content-Length': '0' });
    expect(await screen.findByText('빈 파일입니다')).toBeTruthy();
  });

  it('그림은 종류 형식으로 다시 감싼 Blob 을 쓰고, 닫으면 Blob 주소를 놓는다(F1)', async () => {
    open(file('p.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>', { 'Content-Length': '40' });
    const dlg = await screen.findByRole('dialog', { name: 'p.svg' });
    expect(await within(dlg).findByRole('img', { name: 'p.svg' })).toBeTruthy();
    expect(created[0].type).toBe('image/svg+xml');
    act(() => closeViewer(false));
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalled());
  });

  it('HTML 보기는 권한 없는 sandbox iframe 에 정리한 문서(R5) — 원문으로 바꿀 수 있다', async () => {
    open(file('x.html'), '<meta http-equiv="refresh" content="0;url=http://evil"><p>본문</p>', { 'Content-Length': '60' });
    const dlg = await screen.findByRole('dialog', { name: 'x.html' });
    await within(dlg).findByRole('status');
    const frame = dlg.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toContain('Content-Security-Policy');
    expect(frame.getAttribute('srcdoc')).not.toContain('refresh');
    await userEvent.click(within(dlg).getByRole('button', { name: '원문' }));
    expect(dlg.querySelector('iframe')).toBeNull();
  });

  it('Markdown 보기는 바깥 그림을 그리지 않고 글로(F8)', async () => {
    open(file('r.md'), '# 제목\n\n![로고](http://x/a.png)', { 'Content-Length': '30' });
    const dlg = await screen.findByRole('dialog', { name: 'r.md' });
    expect(await within(dlg).findByText(/바깥 그림은 보이지 않습니다: http:\/\/x\/a.png/)).toBeTruthy();
    expect(dlg.querySelector('img')).toBeNull();
  });

  it('글이 아닌 바이트(NUL·깨진 글자)는 글로 보이지 않는다', () => {
    expect(decodeText(new Uint8Array([104, 0, 105]), false)).toBeNull();
    expect(decodeText(new TextEncoder().encode('한글'), false)).toBe('한글');
  });
});
