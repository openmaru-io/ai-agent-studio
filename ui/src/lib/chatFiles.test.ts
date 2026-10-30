/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 대화 파일(OMAI-1153) — 안내 문구 파서(서버와 같은 기준 파일), 크기·이름 표시, 사전 검사, 이벤트 처리, 보내기 판정.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLang } from '@/i18n';

import { parseNotice } from './attachNotice';
import fixture from './attachNotice.fixture.json';
import { applyEvent, groupItems, newSession } from './chat';
import { humanSize, MAX_SIZE, middleEllipsis, precheck, reasonText, Upload } from './chatFiles';
import { ChatStore } from './chatStore';

const sess = () => newSession({ session_id: 's1', profile: 'ma', title: '', running: false });
const ev = (type: string, payload: Record<string, unknown> = {}) => ({ type, payload });

afterEach(() => setLang('ko'));

describe('parseNotice', () => {
  it('서버가 만든 문구를 같은 기준 파일대로 칩으로 되돌린다', () => {
    for (const c of fixture.cases) {
      const out = parseNotice(c.built);
      expect(out.text).toBe(c.parsed.text);
      // 고른 파일(작업 폴더, 스펙 2026-10-20-002 D2)은 picked 가 붙는다 — 기준 파일과 같은 모양으로 꺼낸다
      expect(out.files.map((f) => ({ name: f.name, size_label: f.sizeLabel, path: f.path, ...(f.picked ? { picked: true } : {}) }))).toEqual(c.parsed.files);
    }
  });
  it('안내 줄이 아닌 글은 그대로 둔다', () => {
    expect(parseNotice('그냥 글 [사용자가 파일을 올렸습니다: 흉내]')).toEqual({
      text: '그냥 글 [사용자가 파일을 올렸습니다: 흉내]',
      files: [],
    });
  });
});

describe('표시·검사', () => {
  it('크기는 서버와 같은 규칙으로 읽는다', () => {
    expect([humanSize(512), humanSize(49152), humanSize(1258291)]).toEqual(['512 B', '48 KB', '1.2 MB']);
  });
  it('긴 이름은 가운데를 줄이고 확장자를 남긴다', () => {
    const out = middleEllipsis('아주아주긴보고서이름_2026년_3분기_최종_최최종.xlsx', 20);
    expect(out.length).toBe(20);
    expect(out.endsWith('.xlsx')).toBe(true);
    expect(out).toContain('…');
    expect(middleEllipsis('a.txt')).toBe('a.txt');
  });
  it('올리기 전에 개수·빈 파일·크기를 막는다(D7)', () => {
    const f = (size: number) => ({ size }) as File;
    expect(precheck(f(10), 10)).toBe('too_many');
    expect(precheck(f(0), 0)).toBe('empty');
    expect(precheck(f(MAX_SIZE + 1), 0)).toBe('too_large');
    expect(precheck(f(10), 0)).toBe('');
  });
  it('이유 코드는 번역 문구로, 모르는 코드는 일반 문구로', () => {
    expect(reasonText('link')).toContain('링크');
    expect(reasonText('zzz')).toBe(reasonText('unknown'));
    setLang('en');
    expect(reasonText('quota')).toContain('full');
  });
});

describe('이벤트', () => {
  it('보낸 말풍선에 첨부를 싣고, 글이 없으면 첫 파일 이름이 제목(D4)', () => {
    const S = sess();
    applyEvent(S, ev('aas.user', { text: '', turn: 1, files: [{ name: 'a.pdf', size: 10, path: 'workspace/uploads/d/a.pdf' }] }));
    expect(S.items[0]).toMatchObject({ kind: 'user', text: '', turn: 1, files: [{ name: 'a.pdf' }] });
    expect(S.title).toBe('a.pdf');
  });

  it('다시 연 대화의 안내 줄은 칩으로 바뀌고 글에는 남지 않는다(D14)', () => {
    const S = sess();
    applyEvent(S, ev('aas.history', { messages: [{ role: 'user', text: fixture.cases[0].built, timestamp: 1 }] }));
    expect(S.items[0].text).toBe(fixture.cases[0].text);
    expect(S.items[0].files?.[0].name).toBe('3분기_매출.xlsx');
    expect(S.items[1]).toMatchObject({ kind: 'divider', code: 'past' });
  });

  it('결과 칩은 그 턴의 답 뒤에 붙는다 — 다음 턴이 이미 시작됐어도(재검토 O-10)', () => {
    const S = sess();
    applyEvent(S, ev('aas.user', { text: '첫째', turn: 1 }));
    applyEvent(S, ev('message.complete', { text: '답1' }));
    applyEvent(S, ev('aas.user', { text: '둘째', turn: 2 }));
    applyEvent(S, ev('aas.files', { turn: 1, files: [{ name: 'r.docx', path: 'workspace/r.docx', size: 48, status: 'new' }], total: 1 }));
    expect(S.items.map((x) => x.kind)).toEqual(['user', 'assistant', 'files', 'user']);
  });

  it('작업 폴더 안내는 notice 항목으로(D12)', () => {
    const S = sess();
    expect(applyEvent(S, ev('aas.notice', { code: 'cwd_unchanged' }))).toBe(true);
    expect(S.items[0]).toMatchObject({ kind: 'notice', code: 'cwd_unchanged' });
  });

  it('첨부가 있는 턴의 단계 묶음은 펼친 채 시작한다(D15)', () => {
    const S = sess();
    applyEvent(S, ev('aas.user', { text: '', turn: 1, files: [{ name: 'a', size: 1, path: 'workspace/uploads/d/a' }] }));
    applyEvent(S, ev('tool.start', { tool_id: 't', name: 'read_file' }));
    applyEvent(S, ev('message.complete', { text: '답' }));
    applyEvent(S, ev('aas.user', { text: '글만', turn: 2 }));
    applyEvent(S, ev('tool.start', { tool_id: 't2', name: 'terminal' }));
    const steps = groupItems(S).filter((b) => b.type === 'steps') as { attach: boolean }[];
    expect(steps.map((b) => b.attach)).toEqual([true, false]);
  });
});

describe('ChatStore 보내기', () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal('EventSource', class {
      onmessage = null;
      onerror = null;
      close() {}
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        calls.push({ url, body });
        if (url.startsWith('/api/chat/send') && body.text === 'reject')
          return Promise.resolve(new Response(JSON.stringify({ code: 'too_large', path: 'workspace/big.log', error: '크다' }), { status: 400 }));
        const out = url.startsWith('/api/chat/status')
          ? { configured: true, agents: [{ name: 'ma' }], files: true, pod: 'p1' }
          : url.startsWith('/api/chat/session')
            ? { session_id: 's1', profile: 'ma' }
            : url.startsWith('/api/chat/history')
              ? { sessions: [] }
              : url.startsWith('/api/chat/send') && body.text === 'fail'
                ? null
                : { ok: true };
        return Promise.resolve(new Response(JSON.stringify(out ?? { error: '안 됨' }), { status: out ? 200 : 400 }));
      })
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const up = (over: Partial<Upload>): Upload =>
    ({ key: Math.random().toString(), file: new File(['x'], 'a'), name: 'a', size: 1, state: 'done', pct: 100, ...over }) as Upload;
  const sends = () => calls.filter((c) => c.url === '/api/chat/send').map((c) => c.body);

  it('파일이 없으면 보내는 본문이 지금과 같다(R7)', async () => {
    const s = new ChatStore();
    await s.openAgent('ma');
    await s.send('안녕');
    expect(sends()).toEqual([{ session_id: 's1', text: '안녕', pod: 'p1' }]);
  });

  it('올리는 중이면 보내지 않고, 끝난 첨부의 경로만 싣고 보낸 뒤 비운다(D8)', async () => {
    const s = new ChatStore();
    await s.openAgent('ma');
    s.uploads = [up({ state: 'up' })];
    expect(await s.send('요약')).toBe('uploading');
    expect(sends()).toEqual([]);
    s.uploads = [up({ path: 'workspace/uploads/d/a' }), up({ state: 'fail', code: 'too_large' })];
    expect(await s.send('')).toBe('sent');
    expect(sends()).toEqual([{ session_id: 's1', text: '', files: ['workspace/uploads/d/a'], pod: 'p1' }]);
    expect(s.uploads.map((u) => u.state)).toEqual(['fail']);
  });

  it('실패한 메시지를 다시 보내면 첨부도 함께 간다(D21)', async () => {
    const s = new ChatStore();
    await s.openAgent('ma');
    s.uploads = [up({ path: 'workspace/uploads/d/a' })];
    expect(await s.send('fail')).toBe('failed');
    const err = s.current()?.items.find((x) => x.kind === 'error');
    expect(err?.retryFiles).toEqual(['workspace/uploads/d/a']);
    await s.send('again', err?.retryFiles);
    expect(sends().at(-1)).toEqual({ session_id: 's1', text: 'again', files: ['workspace/uploads/d/a'], pod: 'p1' });
  });

  it('고른 파일이 보낼 때 거절되면 보내지 않은 것으로 보고 글·첨부를 두고 그 뱃지만 실패로(스펙 2026-10-20-002 DD5)', async () => {
    const s = new ChatStore();
    await s.openAgent('ma');
    s.attachExisting({ name: 'a.md', path: 'workspace/a.md', size: 3 });
    s.attachExisting({ name: 'big.log', path: 'workspace/big.log', size: 200 * 1024 * 1024 });
    expect(await s.send('reject')).toBe('rejected');
    expect(s.draft).toBe('reject');
    expect(s.uploads.map((u) => [u.path, u.state, u.code])).toEqual([
      ['workspace/a.md', 'done', undefined],
      ['workspace/big.log', 'fail', 'too_large'],
    ]);
    expect(s.current()?.items.some((x) => x.kind === 'error')).toBe(false);
  });

  it('작업 폴더 파일 붙이기: 같은 경로는 다시 붙이지 않고, 10개를 넘지 않는다(F14)', async () => {
    const s = new ChatStore();
    await s.openAgent('ma');
    expect(s.attachExisting({ name: 'a', path: 'workspace/a' })).toBe('ok');
    expect(s.attachExisting({ name: 'a', path: 'workspace/a' })).toBe('dup');
    for (let i = 0; i < 9; i++) s.attachExisting({ name: `f${i}`, path: `workspace/f${i}` });
    expect(s.attachExisting({ name: 'x', path: 'workspace/x' })).toBe('too_many');
    expect(s.uploads).toHaveLength(10);
  });

  it('지운 파일은 POD·경로·크기로 기억한다(D22)', async () => {
    const s = new ChatStore();
    await s.preload();
    s.markDeleted('workspace/r.docx', 48);
    expect(s.isDeleted('workspace/r.docx', 48)).toBe(true);
    expect(s.isDeleted('workspace/r.docx', 49)).toBe(false);
  });
});
