/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 대화 파일 화면 부품(OMAI-1153 D5·D6·D19·D20·D22 → 스펙 2026-10-20-002): 결과 뱃지 접기, 받을 수 없는 뱃지의 이유, 보낼 첨부 줄의 「+N」·접근성 이름,
// 「파일」 서랍 → 파일 뷰어(경로 복사·AI에게 묻기·지우기), 말풍선의 옛 「경로:」 줄(DD2)과 글 안 경로(DD1·R6·R14).
// 리뷰 R8: 칩·서랍 단추를 뱃지·뷰어로 옮기며 지키던 동작(받을 수 없음의 이유, 지운 파일 취소선, 경로 복사 값, 클립보드 실패 안내, 폴더 줄)은 같은 단언으로,
// 바뀐 동작(누르면 바로 받기 → 뷰어, AI 단추가 글 대신 첨부 뱃지, aria-disabled → 이름에 상태)은 새 단언으로 적는다.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { closeViewer } from '@/components/files/viewerStore';
import { Item } from '@/lib/chat';
import { Upload } from '@/lib/chatFiles';
import { ChatStore } from '@/lib/chatStore';
import { mountScreen, stubApi } from '@/test/mountScreen';

import { AnswerMarkdown, FileChip, FilesBlock, FilesDrawerBody, UploadRow, UserMessageBody } from './files';

const store = () => {
  const s = new ChatStore();
  s.status = { configured: true, agents: [], files: true, pod: 'p1' };
  return s;
};

afterEach(() => {
  act(() => closeViewer(false));
  vi.unstubAllGlobals();
  sessionStorage.clear(); // 펼친 폴더 기억이 다른 시험에 섞이지 않게(스펙 2026-10-27-012 R5)
});

describe('FilesBlock', () => {
  it('처음 5개만 보이고 「N개 더」로 펼치며, 서버가 자른 나머지는 「파일」로 안내한다', async () => {
    const files = Array.from({ length: 8 }, (_, i) => ({ name: `f${i}.txt`, path: `workspace/f${i}.txt`, size: 10, status: 'new' as const }));
    const item: Item = { kind: 'files', files, total: 12, turn: 1 };
    mountScreen(<FilesBlock item={item} store={store()} />, '/chat');
    expect(screen.getByRole('group', { name: '이번 답에서 바뀐 파일' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^f\d\.txt 열기/ })).toHaveLength(5);
    await userEvent.click(screen.getByRole('button', { name: '3개 더' }));
    expect(screen.getAllByRole('button', { name: /^f\d\.txt 열기/ })).toHaveLength(8);
    expect(screen.getByText('외 4개는 「파일」에서 받을 수 있습니다')).toBeTruthy();
  });

  it('목록이 잘렸으면 뱃지 대신 안내만', () => {
    render(<FilesBlock item={{ kind: 'files', files: [], truncated: true }} store={store()} />);
    expect(screen.getByText('파일이 많아 「파일」에서 확인하세요')).toBeTruthy();
  });
});

describe('FileChip(뱃지)', () => {
  it('누르면 바로 받지 않고 뷰어를 연다 — 이름·크기·출처가 머리에 보이고 전체 경로는 「자세히」 안에만(의도된 변경)', async () => {
    stubApi({ '/api/chat/files': new Response('hello', { status: 200, headers: { 'Content-Length': '5' } }) });
    mountScreen(<FileChip file={{ name: 'a.txt', path: 'workspace/uploads/2026-10-19/a.txt', size: 5 }} store={store()} />, '/chat');
    const badge = screen.getByRole('button', { name: 'a.txt 열기' });
    expect(badge.getAttribute('aria-haspopup')).toBe('dialog');
    expect(badge.textContent).not.toContain('/opt/data');
    await userEvent.click(badge);
    const dlg = await screen.findByRole('dialog', { name: 'a.txt' });
    expect(within(dlg).getByText(/5 B · 내 작업 폴더 · 올린 파일/)).toBeTruthy();
    expect(within(dlg).queryByText('/opt/data/workspace/uploads/2026-10-19/a.txt')).toBeNull();
  });

  it('받을 수 없는 뱃지도 눌리고, 이유는 접근 이름과 뷰어 본문에 보인다(DD4 — aria-disabled 대신)', async () => {
    mountScreen(<FileChip file={{ name: 'x.db', path: 'workspace/x.db', size: 3, downloadable: false, reason: 'hardlink' }} store={store()} />, '/chat');
    const b = screen.getByRole('button', { name: 'x.db 열기, 받을 수 없음: 링크된 파일은 받거나 지울 수 없습니다' });
    expect(b.getAttribute('aria-disabled')).toBeNull();
    await userEvent.click(b);
    const dlg = await screen.findByRole('dialog', { name: 'x.db' });
    expect(await within(dlg).findByText('링크된 파일은 받거나 지울 수 없습니다')).toBeTruthy();
    expect(within(dlg).getByRole('button', { name: '받기' }).hasAttribute('disabled')).toBe(true);
  });

  it('지운 파일의 뱃지는 취소선이고 이름에 「지운 파일입니다」(D22)', () => {
    const s = store();
    s.markDeleted('workspace/r.docx', 48);
    mountScreen(<FileChip file={{ name: 'r.docx', path: 'workspace/r.docx', size: 48 }} store={s} />, '/chat');
    const b = screen.getByRole('button', { name: /지운 파일입니다/ });
    expect(getComputedStyle(b).textDecoration).toContain('line-through');
  });
});

describe('UploadRow', () => {
  const up = (name: string, over: Partial<Upload> = {}): Upload =>
    ({ key: name, file: new File(['x'], name), name, size: 1, state: 'done', pct: 100, path: `workspace/uploads/d/${name}`, ...over }) as Upload;

  it('실패·올리는 중을 앞에 두고 나머지는 「+N」, 각 뱃지에 빼기 단추 이름', () => {
    const s = store();
    s.uploads = [up('a.txt'), up('b.txt'), up('c.txt', { state: 'fail', code: 'too_large', path: undefined }), up('d.txt', { state: 'up', pct: 40, path: undefined })];
    mountScreen(<UploadRow store={s} />, '/chat');
    const removes = screen.getAllByRole('button', { name: /첨부 빼기/ }).map((b) => b.getAttribute('aria-label'));
    expect(removes).toEqual(['c.txt 첨부 빼기', 'd.txt 첨부 빼기']);
    expect(screen.getByText('100MB 까지 올릴 수 있습니다')).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'd.txt 올리는 중' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '첨부 2개 더 보기' }).textContent).toBe('+2');
  });

  it('고른 파일이 보낼 때 거절되면 그 뱃지만 실패, 다시 시도 없이 ✕ 만(DD5)', () => {
    const s = store();
    s.uploads = [up('big.log', { picked: true, state: 'fail', code: 'too_large' })];
    mountScreen(<UploadRow store={s} />, '/chat');
    expect(screen.queryByRole('button', { name: '다시' })).toBeNull();
    expect(screen.getByRole('button', { name: 'big.log 첨부 빼기' })).toBeTruthy();
  });
});

describe('FilesDrawerBody → 파일 뷰어(§3-7, DD3·DD10·DD11)', () => {
  const LIST = {
    entries: [
      { path: 'workspace/uploads/2026-10-14/스크린샷 1.png', name: '스크린샷 1.png', size: 1500, mtime: 1760000000, kind: 'file', downloadable: true, reason: '' },
      { path: 'workspace/uploads/2026-10-14', name: '2026-10-14', size: 0, mtime: 1760000000, kind: 'dir', downloadable: false, reason: '' },
      { path: 'workspace/report', name: 'report', size: 0, mtime: 1760000400, kind: 'dir', downloadable: false, reason: '' },
      { path: 'workspace/report/summary.md', name: 'summary.md', size: 300, mtime: 1760000500, kind: 'file', downloadable: true, reason: '' },
      { path: 'workspace/uploads/aas-shared/7/2026-10-14/f1-회의록.md', name: 'f1-회의록.md', size: 200, mtime: 1760000100, kind: 'file', downloadable: true, reason: '', shared: true, room: '7' },
    ],
    truncated: false,
    used: 1800,
    quota: 2 * 1024 ** 3,
    shared_used: 200,
  };

  function mountDrawer(s: ChatStore, extra: Record<string, unknown> = {}) {
    const fn = stubApi({ '/api/chat/files/list': LIST, '/api/chat/files?': new Response('x', { status: 200, headers: { 'Content-Length': '1' } }), ...extra });
    mountScreen(<FilesDrawerBody store={s} />, '/chat');
    return fn;
  }
  const openRow = async (name: string) => {
    await userEvent.click(await screen.findByRole('button', { name: `${name} 열기` }));
    return screen.findByRole('dialog', { name });
  };

  it('묶음 셋(올린 파일·회의 공유 파일·에이전트가 만든 파일)과 한도 밖 회의 공유 크기(R10)', async () => {
    mountDrawer(store());
    expect(await screen.findByRole('region', { name: '올린 파일' })).toBeTruthy();
    expect(screen.getByRole('region', { name: '회의 공유 파일' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'AI 에이전트가 만든 파일' })).toBeTruthy();
    expect(screen.getByText(/200 B\(한도 밖\)/)).toBeTruthy();
    expect(within(screen.getByRole('region', { name: '회의 공유 파일' })).getByText('방 7')).toBeTruthy();
  });

  it('경로 복사는 뷰어에서 — 에이전트가 보는 절대 경로(/opt/data/…)를 클립보드에 넣고 알려 준다', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    mountDrawer(store());
    const dlg = await openRow('스크린샷 1.png');
    await userEvent.click(within(dlg).getByRole('button', { name: '경로 복사' }));
    expect(writeText).toHaveBeenCalledWith('/opt/data/workspace/uploads/2026-10-14/스크린샷 1.png');
    expect(await screen.findByText('경로를 복사했습니다')).toBeTruthy();
  });

  it('클립보드를 쓸 수 없으면 안내를 보이고 오류로 번지지 않는다', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: () => Promise.reject(new Error('denied')) } });
    mountDrawer(store());
    const dlg = await openRow('스크린샷 1.png');
    await userEvent.click(within(dlg).getByRole('button', { name: '경로 복사' }));
    expect(await screen.findByText('복사하지 못했습니다')).toBeTruthy();
  });

  it('「AI에게 묻기」는 글 대신 첨부 뱃지로 붙이고, 뷰어를 닫고, 입력 칸에 묻는 글을 제안한다(새 대화를 만들지 않는다)', async () => {
    const s = store();
    s.profile = 'main';
    mountDrawer(s);
    const dlg = await openRow('스크린샷 1.png');
    await userEvent.click(within(dlg).getByRole('button', { name: 'AI에게 묻기' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(s.uploads.map((u) => [u.path, u.state, u.picked])).toEqual([['workspace/uploads/2026-10-14/스크린샷 1.png', 'done', true]]);
    expect(s.composeOffer).toBe('이 파일의 내용을 알려 줘.');
    expect(s.draft).not.toContain('/opt/data');
    expect(s.currentId).toBeNull();
  });

  it('같은 파일을 다시 붙이면 「이미 붙어 있습니다」', async () => {
    const s = store();
    s.attachExisting({ name: '스크린샷 1.png', path: 'workspace/uploads/2026-10-14/스크린샷 1.png', size: 1500 });
    mountDrawer(s);
    const dlg = await openRow('스크린샷 1.png');
    await userEvent.click(within(dlg).getByRole('button', { name: 'AI에게 묻기' }));
    expect(await screen.findByText('이미 붙어 있습니다')).toBeTruthy();
    expect(s.uploads).toHaveLength(1);
  });

  it('지우기는 뷰어 「…」 안에서 확인을 거쳐 DELETE, 지운 뒤 뷰어를 닫고 알린다(DD11)', async () => {
    const fn = mountDrawer(store(), { '/api/chat/files?pod=p1&path=workspace%2Freport': (url: string) => new Response('{}', { status: 200 }) });
    await userEvent.click(await screen.findByRole('button', { name: /^report 폴더/ })); // 폴더는 처음에 접혀 있다(스펙 2026-10-27-012 D2)
    const dlg = await openRow('summary.md');
    await userEvent.click(within(dlg).getByRole('button', { name: '더 보기' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: '지우기' }));
    await userEvent.click(await screen.findByRole('button', { name: /지우기|확인/ }));
    await waitFor(() => expect(fn.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'DELETE')).toBe(true));
    expect(await screen.findByText('summary.md 을 지웠습니다')).toBeTruthy();
  });

  it('줄의 「AI에게 묻기」 단추는 뷰어를 열지 않고 첨부 뱃지로 붙인 뒤 입력 칸에 묻는 글을 제안한다', async () => {
    const s = store();
    mountDrawer(s);
    await userEvent.click(await screen.findByRole('button', { name: '스크린샷 1.png 에 대해 AI에게 묻기' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(s.uploads.map((u) => [u.path, u.state, u.picked])).toEqual([['workspace/uploads/2026-10-14/스크린샷 1.png', 'done', true]]);
    expect(s.composeOffer).toBe('이 파일의 내용을 알려 줘.');
  });

  it('줄의 지우기 단추는 확인을 거쳐 DELETE 하고 알린다. 회의 공유 파일 줄에는 지우기 단추가 없다', async () => {
    const fn = mountDrawer(store(), { '/api/chat/files?pod=p1&path=workspace%2Freport': () => new Response('{}', { status: 200 }) });
    expect(await screen.findByRole('button', { name: 'f1-회의록.md 에 대해 AI에게 묻기' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'f1-회의록.md 지우기' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /^report 폴더/ }));
    await userEvent.click(screen.getByRole('button', { name: 'summary.md 지우기' }));
    await userEvent.click(await screen.findByRole('button', { name: /지우기|확인/ }));
    await waitFor(() => expect(fn.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'DELETE')).toBe(true));
    expect(await screen.findByText('summary.md 을 지웠습니다')).toBeTruthy();
  });

  it('묶음 머리를 누르면 접히고 다시 누르면 펼친다. 찾는 동안에는 접힌 묶음도 맞는 줄을 보인다', async () => {
    mountDrawer(store());
    const up = await screen.findByRole('region', { name: '올린 파일' });
    const head = within(up).getByRole('button', { name: /^올린 파일/ });
    expect(head.getAttribute('aria-expanded')).toBe('true');
    await userEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(within(up).queryByRole('button', { name: '스크린샷 1.png 열기' })).toBeNull();
    await userEvent.type(screen.getByRole('searchbox', { name: '파일·폴더 이름으로 찾기' }), '스크린');
    expect(within(up).getByRole('button', { name: '스크린샷 1.png 열기' })).toBeTruthy();
    await userEvent.clear(screen.getByRole('searchbox', { name: '파일·폴더 이름으로 찾기' }));
    expect(within(up).queryByRole('button', { name: '스크린샷 1.png 열기' })).toBeNull();
    await userEvent.click(head);
    expect(within(up).getByRole('button', { name: '스크린샷 1.png 열기' })).toBeTruthy();
  });

  it('회의 공유 파일은 개인 서랍에서 지우지 않는다(「…」 메뉴에 지우기 없음)', async () => {
    mountDrawer(store());
    const dlg = await openRow('f1-회의록.md');
    expect(within(dlg).queryByRole('button', { name: '더 보기' })).toBeNull();
  });

  it('첨부 단추로 고른 파일은 보낼 첨부에 붙어 올라가고, 다 올리면 목록을 다시 읽는다', async () => {
    const s = store();
    const add = vi.spyOn(s, 'addFiles').mockImplementation(() => undefined);
    const fn = mountDrawer(s);
    await screen.findByRole('region', { name: '올린 파일' });
    expect(screen.getByRole('button', { name: '파일 첨부' })).toBeTruthy();
    const f = new File(['x'], 'new.txt');
    fireEvent.change(screen.getByTestId('drawer-file-input'), { target: { files: [f] } });
    expect(add).toHaveBeenCalledWith([f]);
    const lists = () => fn.mock.calls.filter((c) => String(c[0]).startsWith('/api/chat/files/list')).length;
    const before = lists();
    act(() => {
      s.uploads = [{ key: 'k', file: f, name: 'new.txt', size: 1, state: 'done', pct: 100, path: 'workspace/uploads/d/new.txt' } as Upload];
      s.notify();
    });
    await waitFor(() => expect(lists()).toBeGreaterThan(before));
  });

  it('파일이 하나도 없어도 첨부 단추가 보인다', async () => {
    mountDrawer(store(), { '/api/chat/files/list': { entries: [], truncated: false, used: 0, quota: 2 * 1024 ** 3 } });
    expect(await screen.findByRole('button', { name: '파일 첨부' })).toBeTruthy();
  });

  // ---- 폴더 트리(스펙 2026-10-27-012) ----
  const f = (path: string, mtime = 1760000000, size = 100) => ({ path, name: path.split('/').pop()!, size, mtime, kind: 'file', downloadable: true, reason: '' });
  const listing = (entries: object[], truncated = false) => ({ entries, truncated, used: 1000, quota: 2 * 1024 ** 3, shared_used: 0 });
  /** 목록 응답을 시험 중에 바꿀 수 있게 한다(다시 읽기·지운 뒤 읽기) */
  function mountTree(entries: object[], { truncated = false, reveal, s = store(), extra = {} }: { truncated?: boolean; reveal?: string; s?: ChatStore; extra?: Record<string, unknown> } = {}) {
    const box = { list: listing(entries, truncated) };
    const fn = stubApi({ '/api/chat/files/list': () => box.list, ...extra });
    const out = mountScreen(<FilesDrawerBody store={s} reveal={reveal} />, '/chat');
    return { fn, box, out };
  }
  const folderBtn = (name: string) => screen.findByRole('button', { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} 폴더`) });

  it('폴더 줄은 처음에 접힌 펼침 단추이고 「파일 N개」를 보인다. 누르면 펴고 다시 누르면 접는다(D2, 의도된 변경)', async () => {
    mountDrawer(store());
    const report = await folderBtn('report');
    expect(report.getAttribute('aria-expanded')).toBe('false');
    expect(report.getAttribute('aria-label')).toBe('report 폴더, 파일 1개');
    expect(screen.getAllByText('report')).toHaveLength(1); // 폴더 경로는 폴더 줄에 한 번만
    expect(screen.queryByRole('button', { name: 'summary.md 열기' })).toBeNull();
    await userEvent.click(report);
    expect(report.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: 'summary.md 열기' })).toBeTruthy();
    await userEvent.click(report);
    expect(screen.queryByRole('button', { name: 'summary.md 열기' })).toBeNull();
    expect(screen.getByRole('region', { name: 'AI 에이전트가 만든 파일' }).textContent).toContain('1'); // 묶음 개수는 파일 수(폴더 줄은 세지 않는다)
  });

  it('한 갈래 폴더는 한 줄로 합치고, 폴더가 먼저·최근 순이다(D1·D4)', async () => {
    mountTree([f('workspace/old.md', 1760000005), f('workspace/.hermes/plans/p.md', 1760000001), f('workspace/rooms/13/k.html', 1760000009)]);
    await folderBtn('rooms/13');
    const agent = screen.getByRole('region', { name: 'AI 에이전트가 만든 파일' });
    const names = within(agent).getAllByRole('button').map((b) => b.getAttribute('aria-label')).filter((n) => n && !n.endsWith('지우기') && !n.endsWith('AI에게 묻기') && !n.startsWith('AI'));
    expect(names).toEqual(['rooms/13 폴더, 파일 1개', '.hermes/plans 폴더, 파일 1개', 'old.md 열기']);
  });

  it('→ 는 접힌 폴더를 펴고 펼친 폴더에서는 첫 자식으로, ← 는 펼친 폴더를 접고 그 밖은 부모 줄로(7A·R11)', async () => {
    mountTree([f('workspace/r/s/b.md'), f('workspace/r/a.md')]);
    const r = await folderBtn('r');
    r.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(r.getAttribute('aria-expanded')).toBe('true');
    await userEvent.keyboard('{ArrowRight}');
    const s = await folderBtn('r/s');
    expect(document.activeElement).toBe(s);
    await userEvent.keyboard('{ArrowLeft}'); // 접힌 하위 폴더 → 부모로
    expect(document.activeElement).toBe(r);
    await userEvent.keyboard('{ArrowLeft}'); // 펼친 폴더 → 접기
    expect(r.getAttribute('aria-expanded')).toBe('false');
    await userEvent.keyboard('{ArrowLeft}'); // 맨 위 깊이의 접힌 폴더 → 아무 일도 없음
    expect(document.activeElement).toBe(r);
  });

  it('찾는 중에는 평평한 목록 + 폴더 경로, 폴더 이름으로도 찾고, 비우면 펼침 상태가 돌아온다(D3·4A)', async () => {
    mountDrawer(store());
    await userEvent.type(await screen.findByRole('searchbox', { name: '파일·폴더 이름으로 찾기' }), 'report');
    expect(screen.getByRole('button', { name: 'summary.md 열기' })).toBeTruthy();
    expect(screen.getByText('report/')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^report 폴더/ })).toBeNull();
    await userEvent.clear(screen.getByRole('searchbox', { name: '파일·폴더 이름으로 찾기' }));
    expect((await folderBtn('report')).getAttribute('aria-expanded')).toBe('false');
  });

  it('찾기 결과가 없으면 묶음 머리 대신 한 줄 안내(3A)', async () => {
    mountDrawer(store());
    await userEvent.type(await screen.findByRole('searchbox', { name: '파일·폴더 이름으로 찾기' }), 'zzz');
    expect(screen.getByText('‘zzz’ 와 맞는 파일이 없습니다.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: '올린 파일' })).toBeNull();
  });

  it('서랍을 닫았다 열어도 펼친 폴더가 그대로다. 저장소가 오류를 내도 서랍이 그려진다(§4-4)', async () => {
    const { out } = mountTree([f('workspace/r/a.md')]);
    await userEvent.click(await folderBtn('r'));
    out.unmount();
    mountTree([f('workspace/r/a.md')]);
    expect((await folderBtn('r')).getAttribute('aria-expanded')).toBe('true');
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const second = mountTree([f('workspace/q/a.md')]);
    await userEvent.click(await folderBtn('q'));
    expect(within(second.out.container).getByRole('button', { name: 'a.md 열기' })).toBeTruthy();
    get.mockRestore();
    set.mockRestore();
  });

  it('합치기가 풀려도(다시 열 때·연 채 새로 고칠 때) 펼쳐 둔 폴더가 보인다(R2·R6)', async () => {
    const { box, out } = mountTree([f('workspace/rooms/13/k.html')]);
    await userEvent.click(await folderBtn('rooms/13'));
    box.list = listing([f('workspace/rooms/13/k.html'), f('workspace/rooms/x.md')]);
    await userEvent.click(screen.getByRole('button', { name: '다시 읽기' }));
    expect(await screen.findByRole('button', { name: 'k.html 열기' })).toBeTruthy();
    out.unmount();
    mountTree([f('workspace/rooms/13/k.html'), f('workspace/rooms/x.md')]);
    expect(await screen.findByRole('button', { name: 'k.html 열기' })).toBeTruthy();
  });

  it('위 폴더를 접으면 다음에 열 때도 접혀 있고, 잘린 목록에서 빠진 폴더의 기억은 남는다(R3)', async () => {
    const one = mountTree([f('workspace/r/s/b.md'), f('workspace/r/a.md'), f('workspace/t/c.md')]);
    await userEvent.click(await folderBtn('r'));
    await userEvent.click(await folderBtn('r/s'));
    await userEvent.click(await folderBtn('t'));
    await userEvent.click(await folderBtn('r')); // 위 폴더 접기 → r·r/s 기억을 지운다
    one.box.list = listing([f('workspace/r/a.md')], true); // 잘린 목록: t 가 빠짐
    await userEvent.click(screen.getByRole('button', { name: '다시 읽기' }));
    one.out.unmount();
    mountTree([f('workspace/r/s/b.md'), f('workspace/r/a.md'), f('workspace/t/c.md')]);
    expect((await folderBtn('r')).getAttribute('aria-expanded')).toBe('false');
    expect((await folderBtn('t')).getAttribute('aria-expanded')).toBe('true');
  });

  it('reveal 은 처음 한 번 계획 폴더를 펴고 그 줄을 목록 맨 위로 올려 포커스, 접은 뒤 다시 읽어도 접혀 있다(§4-9·8-1)', async () => {
    // jsdom 에는 scrollIntoView 가 없다. 폴더 줄만 보이게(nearest) 하면 OKE 에서 계획 파일이 화면 아래로 밀렸다(2026-10-28)
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const { box } = mountTree([f('workspace/.hermes/plans/p.md'), f('workspace/a.md')], { reveal: 'workspace/.hermes/plans' });
    const plans = await folderBtn('.hermes/plans');
    await waitFor(() => expect(plans.getAttribute('aria-expanded')).toBe('true'));
    await waitFor(() => expect(document.activeElement).toBe(plans));
    expect(scroll).toHaveBeenCalledWith({ block: 'start' });
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    await userEvent.click(plans);
    box.list = listing([f('workspace/.hermes/plans/p.md'), f('workspace/a.md'), f('workspace/b.md')]);
    await userEvent.click(screen.getByRole('button', { name: '다시 읽기' }));
    await screen.findByRole('button', { name: 'b.md 열기' });
    expect(plans.getAttribute('aria-expanded')).toBe('false');
  });

  it('계획 폴더가 없으면 안내, 목록이 잘렸으면 「찾지 못했습니다」(6A·R10)', async () => {
    const one = mountTree([f('workspace/a.md')], { reveal: 'workspace/.hermes/plans' });
    expect(await screen.findByText('아직 계획 파일이 없습니다. AI 에이전트가 계획을 다 쓰면 여기에 보입니다.')).toBeTruthy();
    one.out.unmount();
    mountTree([f('workspace/a.md')], { reveal: 'workspace/.hermes/plans', truncated: true });
    expect(await screen.findByText('파일이 많아 계획 폴더를 찾지 못했습니다. 찾기 칸에 plans 를 입력하세요.')).toBeTruthy();
  });

  it('목록이 잘리면 묶음 머리 「N+」·「—」, 폴더 줄 「파일 N개 이상」·「—」(2A·R7)', async () => {
    mountTree([f('workspace/r/a.md'), f('workspace/top.md')], { truncated: true });
    const r = await folderBtn('r');
    expect(r.getAttribute('aria-label')).toBe('r 폴더, 파일 1개 이상');
    expect(screen.getByRole('button', { name: 'AI 에이전트가 만든 파일, 파일 2개 이상' })).toBeTruthy();
    expect(within(r).getAllByText('—').length).toBeGreaterThan(0);
  });

  it('폴더 줄 지우기는 파일 수·숨은 파일 안내로 확인한 뒤 recursive=1 로 지우고 알린다. 취소하면 요청이 없다(스펙 2026-10-28-002)', async () => {
    const del = (c: unknown[]) => (c[1] as RequestInit | undefined)?.method === 'DELETE';
    const { fn, box } = mountTree([f('workspace/r/a.md', 1760000009), f('workspace/r/s/b.md', 1760000008), f('workspace/z.md', 1760000001)], {
      extra: { '/api/chat/files?pod=p1&path=workspace%2Fr&recursive=1': () => new Response('{}', { status: 200 }) },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'r 지우기' }));
    const dlg = await screen.findByRole('dialog');
    expect(dlg).toHaveTextContent('r 폴더와 안의 파일 2개를 지웁니다. 서랍에 보이지 않는 파일(점 파일·node_modules 등)도 함께 지워집니다.');
    await userEvent.click(within(dlg).getByRole('button', { name: /취소|아니/ }));
    expect(fn.mock.calls.some(del)).toBe(false);
    await userEvent.click(await screen.findByRole('button', { name: 'r 지우기' })); // 확인 창이 닫히는 동안은 나머지가 aria-hidden
    box.list = listing([f('workspace/z.md', 1760000001)]);
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /지우기|확인/ }));
    await waitFor(() => expect(fn.mock.calls.some((c) => del(c) && String(c[0]).endsWith('path=workspace%2Fr&recursive=1'))).toBe(true));
    expect(await screen.findByText('r 폴더를 지웠습니다')).toBeTruthy();
    const z = await screen.findByRole('button', { name: 'z.md 열기' });
    await waitFor(() => expect(document.activeElement).toBe(z));
  });

  it('서버가 지울 수 없는 폴더라고 하면(protected) 이유를 알린다', async () => {
    mountTree([f('workspace/r/a.md')], { extra: { '/api/chat/files?pod=p1&path=workspace%2Fr&recursive=1': () => new Response(JSON.stringify({ code: 'protected' }), { status: 403 }) } });
    await userEvent.click(await screen.findByRole('button', { name: 'r 지우기' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /지우기|확인/ }));
    expect(await screen.findByText('이 폴더는 지울 수 없습니다')).toBeTruthy();
  });

  it('올린 파일은 날짜 폴더 트리이고 가장 최근 날짜 폴더만 펴져 있다(F3)', async () => {
    mountTree([f('workspace/uploads/2026-10-19/old.png', 1760000001), f('workspace/uploads/2026-10-27/new.png', 1760000009)]);
    const up = await screen.findByRole('region', { name: '올린 파일' });
    const newest = await within(up).findByRole('button', { name: /^uploads\/2026-10-27 폴더/ });
    await waitFor(() => expect(newest.getAttribute('aria-expanded')).toBe('true'));
    expect(within(up).getByRole('button', { name: /^uploads\/2026-10-19 폴더/ }).getAttribute('aria-expanded')).toBe('false');
    expect(within(up).getByRole('button', { name: 'new.png 열기' })).toBeTruthy();
    expect(within(up).queryByRole('button', { name: 'old.png 열기' })).toBeNull();
    expect(within(up).getByRole('button', { name: 'uploads/2026-10-19 지우기' })).toBeTruthy();
  });

  it('긴 합친 폴더 이름도 접근 이름에는 전체 경로가 있다(14A)', async () => {
    mountTree([f('workspace/output/reports/2026/10/r.hwpx')]);
    expect(await folderBtn('output/reports/2026/10')).toBeTruthy();
  });

  it('뷰어로 연 파일이 접힌 폴더 안에 있으면 위 폴더 줄에 Inactive 표시(5A)', async () => {
    mountTree([f('workspace/r/a.md')]);
    const r = await folderBtn('r');
    await userEvent.click(r);
    await openRow('a.md');
    fireEvent.click(r); // 뷰어(대화 상자)가 열린 동안이라 포인터 대신 클릭 이벤트로 접는다
    expect(r.getAttribute('aria-expanded')).toBe('false');
    expect(r.parentElement).toHaveStyle({ boxShadow: 'inset 2px 0 0 rgba(255,255,255,0.50)' }); // 시험 화면은 어두운 테마
  });

  it('폴더 줄만 있는 목록은 빈 서랍이고, 잘린 목록은 빈 서랍으로 보지 않는다(재검토 12-3)', async () => {
    const dir = (path: string) => ({ path, name: path.split('/').pop(), size: 0, mtime: 1, kind: 'dir', downloadable: false, reason: 'dir' });
    const one = mountTree([dir('workspace/empty')]);
    expect(await screen.findByText(/아직 파일이 없습니다/)).toBeTruthy();
    one.out.unmount();
    mountTree([dir('workspace/empty')], { truncated: true });
    expect(await screen.findByText('파일이 많아 일부만 보입니다. 이름으로 찾으세요')).toBeTruthy();
  });

  it('폴더의 마지막 파일을 지우면 곧 사라질 폴더 줄을 건너뛰고 다음 줄로 포커스(§4-8)', async () => {
    const { box } = mountTree([f('workspace/r/a.md', 1760000009), f('workspace/z.md', 1760000001)], {
      extra: { '/api/chat/files?pod=p1&path=workspace%2Fr%2Fa.md': () => new Response('{}', { status: 200 }) },
    });
    await userEvent.click(await folderBtn('r'));
    box.list = listing([f('workspace/z.md', 1760000001)]);
    await userEvent.click(screen.getByRole('button', { name: 'a.md 지우기' }));
    await userEvent.click(await screen.findByRole('button', { name: /지우기|확인/ }));
    const z = await screen.findByRole('button', { name: 'z.md 열기' });
    await waitFor(() => expect(document.activeElement).toBe(z));
  });
});

describe('말풍선·답 안 경로', () => {
  it('옛 「AI」 단추 글의 「경로:」 줄은 떼어 본문 위 뱃지 줄로(DD2)', () => {
    mountScreen(<UserMessageBody text={'다음 파일을 열어 내용을 알려 줘.\n경로: /opt/data/workspace/uploads/2026-10-19/스크린샷 2026-10-19 10.05.32-2.png'} store={store()} />, '/chat');
    expect(screen.getByRole('button', { name: '스크린샷 2026-10-19 10.05.32-2.png 열기' })).toBeTruthy();
    expect(screen.queryByText(/\/opt\/data/)).toBeNull();
    expect(screen.getByText(/다음 파일을 열어 내용을 알려 줘\./)).toBeTruthy();
  });

  it('답 본문의 절대 경로는 글 안 뱃지(이름만 접근 이름, DD16), 코드 블록 안은 그대로', () => {
    mountScreen(<AnswerMarkdown text={'/opt/data/workspace/report.md에 저장했습니다\n\n```\n/opt/data/workspace/x.md\n```'} store={store()} />, '/chat');
    const b = screen.getByRole('button', { name: 'report.md' });
    expect(b.getAttribute('aria-describedby')).toBe('aas-file-badge-hint');
    expect(screen.getByText('/opt/data/workspace/x.md')).toBeTruthy();
  });

  it('상대 경로는 서랍 목록에 있을 때만 뱃지(R14)', async () => {
    stubApi({ '/api/chat/files/list': { entries: [{ path: 'workspace/out/plan.md', name: 'plan.md', size: 1, mtime: 1, kind: 'file', downloadable: true, reason: '' }], truncated: false, used: 1, quota: 1 } });
    const s = store();
    s.status = { configured: true, agents: [], files: true, pod: 'p-rel' };
    mountScreen(<AnswerMarkdown text="out/plan.md 와 out/none.md" store={s} />, '/chat');
    expect(await screen.findByRole('button', { name: 'plan.md' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'none.md' })).toBeNull();
  });
});

// 뷰어 단독(머리 영역) — 파일 이름이 창 이름이고, 처음 받는 동안에도 머리가 보인다(DD6)
describe('LazyFileViewer', () => {
  it('미리 볼 수 없는 형식은 작은 창과 「받기」(DD8)', async () => {
    // xlsx 는 OMAI-1364 부터 뷰어가 그린다. 받기만 하는 옛 형식(xls·doc·ppt, 스펙 2026-10-20-005 §7 D6)으로 본다
    mountScreen(<FileChip file={{ name: 'q.xls', path: 'workspace/q.xls', size: 10 }} store={store()} />, '/chat');
    await userEvent.click(screen.getByRole('button', { name: 'q.xls 열기' }));
    const dlg = await screen.findByRole('dialog', { name: 'q.xls' });
    expect(await within(dlg).findByText('미리 볼 수 없는 형식입니다')).toBeTruthy();
    expect(within(dlg).getByRole('button', { name: '받기' })).toBeTruthy();
  });
});
