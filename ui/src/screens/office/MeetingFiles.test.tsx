/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 회의 파일 올리기·내려받기 화면(스펙 2026-10-15-015 §4-5). 가짜 fetch 와 가짜 XHR 로 서버 계약(meeting-files-api-contract)을 흉내 낸다.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fmtWhen } from '@/components/files/viewerParts';
import { ApiError } from '@/lib/api';
import { FakeES } from '@/test/fakeEventSource';
import { ME_ADMIN, mountScreen } from '@/test/mountScreen';

import { Office } from '../Office';
import { fileErrorText } from './MeetingFiles';

vi.mock('@/features/office/OfficeScene', () => ({ default: () => <div /> }));

const seat = (alias: string, pod: string) => ({
  alias,
  pod,
  profile: alias,
  enabled: true,
  title: '',
  role: '',
  team: '',
  note: '',
});
const OFFICE = {
  seats: [seat('sa', 'yj'), seat('doc', 'scdf')],
  rooms: [
    {
      id: 1,
      name: '제안 TFT',
      purpose: 'RFP 대응',
      owner: 'kim',
      seats: ['sa', 'doc'],
      people: ['kim'],
      status: 'open',
    },
  ],
  pods: [],
  problems: [],
  can_edit: true,
};
const FILES = {
  enabled: true,
  limits: { file: 25 * 1024 * 1024, room: 500 * 1024 * 1024, total: 5 * 1024 ** 3 },
  max_per_message: 10,
};
const view = (over: Record<string, unknown> = {}) => ({
  room: { id: 1, name: '제안 TFT', purpose: 'RFP 대응', status: 'open' },
  participants: [
    { alias: 'sa', title: '영업', pod: 'yj', enabled: true },
    { alias: 'doc', title: '', pod: 'scdf', enabled: true },
  ],
  messages: [{ id: 1, role: 'user', author: 'kim', content: '일정 어떻게 돼?', ts: '2026-10-10T10:00:00+09:00' }],
  pending: [],
  files: FILES,
  ...over,
});
const LIST = {
  files: [
    {
      id: 'f1',
      name: 'rfp.pdf',
      size: 2048,
      uploader: 'kim',
      ts: '2026-10-10T10:00:00+09:00',
      date: '2026-10-10',
      status: 'ready',
      msg: 1,
    },
    {
      id: 'f2',
      name: 'other.txt',
      size: 10,
      uploader: 'park',
      ts: '2026-10-10T11:00:00+09:00',
      date: '2026-10-10',
      status: 'ready',
      msg: null,
    },
  ],
  out: [
    {
      path: 'sa/2026-10-10/report.md',
      name: 'report.md',
      size: 300,
      mtime: 1760056200,
      alias: 'sa',
      date: '2026-10-10',
    },
    { path: 'doc/2026-10-09/old.csv', name: 'old.csv', size: 5, mtime: 1759970000, alias: 'doc', date: '2026-10-09' },
  ],
  used: { room: 2058, total: 9999 },
  out_truncated: false,
};

class FakeXHR {
  static all: FakeXHR[] = [];
  method = '';
  url = '';
  headers: Record<string, string> = {};
  upload: { onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void } = {};
  status = 0;
  responseText = '';
  body: unknown;
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  constructor() {
    FakeXHR.all.push(this);
  }
  open(m: string, u: string) {
    this.method = m;
    this.url = u;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  send(b: unknown) {
    this.body = b;
  }
  abort() {
    this.onabort?.();
  }
  respond(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    act(() => this.onload?.());
  }
}

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown };
let calls: { url: string; init?: RequestInit }[] = [];

function mount(opts: { view?: Record<string, unknown>; say?: Handler; extra?: Record<string, Handler> } = {}) {
  calls = [];
  const defaults: Record<string, Handler> = {
    '/api/office/meeting/say':
      opts.say ?? (() => ({ body: { ok: true, message: 9, targets: ['sa', 'doc'], skipped: [] } })),
    '/api/office/meeting/files': (url, init) =>
      (init?.method ?? 'GET') === 'GET' ? { body: LIST } : { body: { ok: true } },
    '/api/office/meeting': () => ({ body: opts.view ?? view() }),
    '/api/office/state': () => ({ body: { agents: [], seq: 0 } }),
    '/api/me': () => ({ body: ME_ADMIN }),
    '/api/office': () => ({ body: OFFICE }),
  };
  // 시험이 준 경로가 먼저 맞고(더 긴 접두사가 앞), 같은 경로는 기본값을 덮어쓴다
  const routes: Record<string, Handler> = { ...(opts.extra ?? {}) };
  for (const [k, v] of Object.entries(defaults)) if (!(k in routes)) routes[k] = v;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const key = Object.keys(routes).find((k) => url.startsWith(k));
      const r = key ? routes[key](url, init) : { status: 404, body: { error: 'no_route' } };
      return Promise.resolve(new Response(JSON.stringify(r.body), { status: r.status ?? 200 }));
    })
  );
  return mountScreen(<Office />, '/office?tab=meeting');
}

const posted = (path: string) =>
  calls
    .filter((c) => c.url.startsWith(path) && c.init?.body)
    .map((c) => JSON.parse(String(c.init!.body)) as Record<string, unknown>);

const fileInput = () => screen.getByTestId('meeting-file-input') as HTMLInputElement;
const pick = (...files: File[]) => fireEvent.change(fileInput(), { target: { files } });
const doc = (name = 'rfp.pdf', size = 1000) => new File([new Uint8Array(size)], name, { type: 'application/pdf' });

beforeEach(() => {
  FakeES.all = [];
  FakeXHR.all = [];
  localStorage.clear();
  vi.stubGlobal('EventSource', FakeES);
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
});
afterEach(() => vi.unstubAllGlobals());

describe('회의 파일: 입력 카드', () => {
  it('files 키가 없거나 enabled 가 거짓이면 첨부 단추와 「자료」 단추가 없다', async () => {
    mount({ view: view({ files: undefined }) });
    await screen.findByText('일정 어떻게 돼?');
    expect(screen.queryByRole('button', { name: '파일 첨부' })).toBeNull();
    expect(screen.queryByRole('button', { name: '자료' })).toBeNull();
  });

  it('enabled=false 여도 같다', async () => {
    mount({ view: view({ files: { ...FILES, enabled: false } }) });
    await screen.findByText('일정 어떻게 돼?');
    expect(screen.queryByRole('button', { name: '파일 첨부' })).toBeNull();
    expect(screen.queryByRole('button', { name: '자료' })).toBeNull();
  });

  it('파일을 고르면 칩이 생기고 올리는 동안 보내기가 막히며, 끝나면 files 를 실어 보낸다', async () => {
    mount();
    expect(await screen.findByRole('button', { name: '파일 첨부' })).toBeInTheDocument();
    pick(doc());
    expect(await screen.findByRole('group', { name: '보낼 첨부 1개' })).toBeInTheDocument();
    const xhr = FakeXHR.all[0];
    expect(xhr.method).toBe('PUT');
    expect(xhr.url).toBe('/api/office/meeting/files?room=1&name=rfp.pdf');
    expect(xhr.headers['X-AAS']).toBe('1');
    act(() => xhr.upload.onprogress?.({ lengthComputable: true, loaded: 500, total: 1000 }));
    expect(screen.getByRole('progressbar', { name: 'rfp.pdf 올리는 중' })).toBeInTheDocument();
    expect(screen.getByText(/파일을 올리는 중입니다/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '보내기' })).toBeDisabled();
    xhr.respond(200, { id: 'f9', name: 'rfp.pdf', size: 1000, date: '2026-10-15', status: 'ready' });
    // 본문이 비어도 파일이 있으면 보낼 수 있다
    const send = await screen.findByRole('button', { name: '보내기' });
    await waitFor(() => expect(send).toBeEnabled());
    await userEvent.click(send);
    await waitFor(() => expect(posted('/api/office/meeting/say')).toHaveLength(1));
    expect(posted('/api/office/meeting/say')[0]).toEqual({ room: 1, text: '', targets: ['sa', 'doc'], files: ['f9'] });
    await waitFor(() => expect(screen.queryByRole('group', { name: /보낼 첨부/ })).toBeNull());
  });

  it('올리기 성공 알림에 파일 이름이 들어간다', async () => {
    mount();
    await screen.findByRole('button', { name: '파일 첨부' });
    pick(doc('안건.docx'));
    FakeXHR.all[0].respond(200, { id: 'f9', name: '안건.docx', size: 1000, date: 'x', status: 'ready' });
    expect(await screen.findByText('파일 안건.docx 을(를) 올렸습니다')).toBeInTheDocument();
  });

  it('칩의 ×는 올린 파일을 서버에서도 지운다', async () => {
    mount();
    await screen.findByRole('button', { name: '파일 첨부' });
    pick(doc());
    FakeXHR.all[0].respond(200, { id: 'f9', name: 'rfp.pdf', size: 1000, date: 'x', status: 'ready' });
    await userEvent.click(await screen.findByRole('button', { name: 'rfp.pdf 첨부 빼기' }));
    await waitFor(() =>
      expect(calls.some((c) => c.init?.method === 'DELETE' && c.url === '/api/office/meeting/files/f9?room=1')).toBe(
        true
      )
    );
    expect(screen.queryByRole('group', { name: /보낼 첨부/ })).toBeNull();
  });

  it.each([
    [413, 'too_large', '파일당 25 MB 까지 올릴 수 있습니다'],
    [413, 'room_quota', /이 방의 파일 용량\(500 MB\)이 가득 찼습니다/],
    [413, 'total_quota', /서버의 회의 파일 저장 공간이 가득 찼습니다/],
    [403, 'forbidden', '이 방에 파일을 올릴 권한이 없습니다'],
    [409, 'room_closed', '끝난 방에는 파일을 올릴 수 없습니다'],
    [501, 'not_configured', '이 서버는 회의 파일을 쓰지 않습니다'],
    [502, 'io_error', '서버가 파일을 저장하지 못했습니다'],
  ])('%i %s 오류는 칩에 이유 한 줄을 보인다', async (status, code, text) => {
    mount();
    await screen.findByRole('button', { name: '파일 첨부' });
    pick(doc());
    FakeXHR.all[0].respond(status, { error: code });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(text as string);
    expect(screen.getByRole('button', { name: '보내기' })).toBeDisabled(); // 실패한 칩만 있으면 보낼 파일이 없다
  });

  it('429 는 한 번 자동으로 다시 시도한다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mount();
      await screen.findByRole('button', { name: '파일 첨부' });
      pick(doc());
      FakeXHR.all[0].respond(429, { error: 'busy' });
      act(() => {
        vi.advanceTimersByTime(1600);
      });
      expect(FakeXHR.all).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('파일당 한도를 넘는 파일은 올리지 않고 칩에 이유를 보인다', async () => {
    mount({ view: view({ files: { ...FILES, limits: { ...FILES.limits, file: 500 } } }) });
    await screen.findByRole('button', { name: '파일 첨부' });
    pick(doc('big.bin', 1000));
    expect(await screen.findByRole('alert')).toHaveTextContent('파일당 500 B 까지 올릴 수 있습니다');
    expect(FakeXHR.all).toHaveLength(0);
  });

  it('한 말에는 최대 개수까지만 붙인다', async () => {
    mount({ view: view({ files: { ...FILES, max_per_message: 2 } }) });
    await screen.findByRole('button', { name: '파일 첨부' });
    pick(doc('a.txt'), doc('b.txt'), doc('c.txt'));
    expect(await screen.findByRole('alert')).toHaveTextContent('한 번에 2개까지 붙일 수 있습니다');
    expect(FakeXHR.all).toHaveLength(2);
  });

  it('처음 올릴 때만 폐쇄 환경 안내를 보이고, 저장소를 못 써도 동작한다', async () => {
    mount();
    await screen.findByRole('button', { name: '파일 첨부' });
    pick(doc());
    expect(await screen.findByRole('note')).toHaveTextContent('이 회사의 모든 AI 에이전트가 이 파일을 읽을 수 있습니다');
    expect(localStorage.getItem('aas.meetingFileNotice')).toBe('1');
    await userEvent.click(screen.getByRole('button', { name: 'rfp.pdf 첨부 빼기' }));
    pick(doc('b.pdf'));
    await screen.findByRole('group', { name: '보낼 첨부 1개' });
    expect(screen.queryByRole('note')).toBeNull(); // 이미 봤다
  });

  it('localStorage 가 throw 해도 올릴 수 있다', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      mount();
      await screen.findByRole('button', { name: '파일 첨부' });
      pick(doc());
      expect(await screen.findByRole('group', { name: '보낼 첨부 1개' })).toBeInTheDocument();
      expect(FakeXHR.all).toHaveLength(1);
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });

  it('받지 못한 에이전트(skipped)를 입력 카드 위에 알린다', async () => {
    mount({
      say: () => ({
        body: {
          ok: true,
          message: 9,
          targets: ['sa'],
          skipped: [
            { alias: 'doc', reason: 'unsupported' },
            { alias: 'ops', reason: 'not_visible' },
          ],
        },
      }),
    });
    await userEvent.type(await screen.findByLabelText('메시지'), '봐 줘');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    const note = await screen.findByRole('status');
    expect(note).toHaveTextContent(
      '이 말을 받지 못한 AI 에이전트: doc(파일을 받을 수 없음), ops(공유 폴더에서 파일이 보이지 않음)'
    );
    await userEvent.click(within(note).getByRole('button', { name: '안내 닫기' }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('409 no_receiver 는 보내지 못했다는 오류 줄이고 입력을 남긴다', async () => {
    mount({ say: () => ({ status: 409, body: { error: 'no_receiver' } }) });
    await userEvent.type(await screen.findByLabelText('메시지'), '봐 줘');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    expect(await screen.findByText(/이 말을 받을 수 있는 AI 에이전트가 없어 보내지 못했습니다/)).toBeInTheDocument();
    expect(screen.getByLabelText('메시지')).toHaveValue('봐 줘');
  });

  it('끌어다 놓은 파일도 첨부하고, 폴더는 이유를 보인다', async () => {
    mount();
    await screen.findByRole('button', { name: '파일 첨부' });
    const pane = screen.getByRole('log').parentElement as HTMLElement;
    const f = doc('d.txt');
    const dir = doc('폴더');
    fireEvent.drop(pane, {
      dataTransfer: {
        types: ['Files'],
        files: [f, dir],
        items: [
          { webkitGetAsEntry: () => ({ isDirectory: false }) },
          { webkitGetAsEntry: () => ({ isDirectory: true }) },
        ],
      },
    });
    expect(await screen.findByRole('group', { name: '보낼 첨부 2개' })).toBeInTheDocument();
    expect(FakeXHR.all).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent('폴더는 올릴 수 없습니다');
  });
});

describe('회의 파일: 방 기록', () => {
  const MSGS = [
    {
      id: 5,
      role: 'user',
      author: 'kim',
      content: '이거 봐 줘',
      ts: '2026-10-10T10:00:00+09:00',
      kind: 'attach',
      data: { files: [{ id: 'f1', name: 'rfp.pdf', size: 2048 }], undelivered: ['doc'] },
    },
    {
      id: 6,
      role: 'system',
      author: 'sa',
      content: '',
      ts: '2026-10-10T10:00:09+09:00',
      kind: 'files',
      data: { pod: 'yj', files: [{ path: 'workspace/out/report.md', name: 'report.md', size: 300 }] },
    },
    {
      id: 7,
      role: 'system',
      author: 'doc',
      content: 'doc 가 답하지 못했습니다: 시간 초과',
      ts: '2026-10-10T10:00:12+09:00',
    },
  ];

  // 스펙 2026-10-20-002 R8: 칩(바로 받기 링크) → 뱃지(누르면 뷰어). 받기 주소·크기·안내는 그대로 지킨다
  it('attach 말풍선은 첨부 뱃지(누르면 뷰어가 그 받기 주소를 읽는다)와 받지 않은 에이전트 안내를 보인다', async () => {
    mount({ view: view({ messages: MSGS }) });
    const badge = await screen.findByRole('button', { name: 'rfp.pdf 열기' });
    expect(badge).toHaveTextContent('2 KB');
    expect(within(badge.parentElement as HTMLElement).getByText('회의')).toBeInTheDocument(); // 회의 표지(DD13)
    await userEvent.click(badge);
    const dlg = await screen.findByRole('dialog', { name: 'rfp.pdf' });
    expect(within(dlg).getByRole('button', { name: '받기' })).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.url === '/api/office/meeting/files/f1?room=1')).toBe(true));
    expect(screen.getByText('doc 는 이 말을 받지 않았습니다')).toBeInTheDocument();
  });

  it('kind=files 행은 경고 행이 아니라 에이전트 파일 칩이다. 일반 시스템 행은 그대로 경고 행이다', async () => {
    mount({ view: view({ messages: MSGS }) });
    await userEvent.click(await screen.findByRole('button', { name: 'report.md 열기' }));
    await screen.findByRole('dialog', { name: 'report.md' });
    await waitFor(() => expect(calls.some((c) => c.url === '/api/office/meeting/agent-file?room=1&msg=6&n=0')).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: '닫기' }));
    const group = screen.getByRole('group', { name: 'sa 가 만든 파일' });
    expect(within(group).queryByRole('alert')).toBeNull();
    // 경고 행(role=alert)은 일반 시스템 행 하나뿐이다
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent('doc 가 답하지 못했습니다');
  });

  it('에이전트 파일 칩 행의 머리는 글쓴이 이름(labels)이다', async () => {
    mount({ view: view({ messages: MSGS, labels: { sa: '김에이 · AAS 관리자' } }) });
    expect(await screen.findByRole('group', { name: '김에이 · AAS 관리자 가 만든 파일' })).toHaveTextContent('report.md');
  });

  it('「방에 올리기」는 뷰어 머리의 주 단추(DD3) — from-agent 를 부르고 파일 이름이 든 알림을 띄운다', async () => {
    mount({
      view: view({ messages: MSGS }),
      extra: {
        '/api/office/meeting/files/from-agent': () => ({
          body: { id: 'f7', name: 'report.md', size: 300, date: 'x', status: 'ready' },
        }),
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'report.md 열기' }));
    const dlg = await screen.findByRole('dialog', { name: 'report.md' });
    await userEvent.click(within(dlg).getByRole('button', { name: '방에 올리기' }));
    await waitFor(() => expect(posted('/api/office/meeting/files/from-agent')).toEqual([{ room: 1, msg: 6, n: 0 }]));
    expect(await screen.findByText('파일 report.md 을(를) 방에 올렸습니다')).toBeInTheDocument();
  });
});

describe('회의 파일: 결과 파일 자동 올리기', () => {
  const AUTO = [
    {
      id: 8,
      role: 'system',
      author: 'sa',
      content: '',
      ts: '2026-10-20T16:32:00+09:00',
      kind: 'files',
      data: {
        pod: 'yj',
        files: [
          { path: 'workspace/plan.md', name: 'plan.md', size: 30, room: 'f8' },
          { path: 'workspace/big.zip', name: 'big.zip', size: 99, skip: 'too_large' },
        ],
      },
    },
  ];

  it('방에 올라간 파일은 「방에 올리기」가 없고, 건너뛴 파일은 이유를 보이며 손으로 올릴 수 있다', async () => {
    mount({ view: view({ messages: AUTO }) });
    expect(await screen.findByText(/big\.zip 은\(는\) 방에 올리지 못했습니다: 파일당 25 MB 까지 올릴 수 있습니다/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'plan.md 열기' }));
    let dlg = await screen.findByRole('dialog', { name: 'plan.md' });
    expect(within(dlg).queryByRole('button', { name: '방에 올리기' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '닫기' }));
    await userEvent.click(screen.getByRole('button', { name: 'big.zip 열기' }));
    dlg = await screen.findByRole('dialog', { name: 'big.zip' });
    expect(within(dlg).getByRole('button', { name: '방에 올리기' })).toBeInTheDocument();
  });
});

describe('회의 파일: 「자료」 서랍', () => {
  it('두 구역(올린 파일·에이전트 출력)과 방 사용량을 보인다', async () => {
    mount();
    await userEvent.click(await screen.findByRole('button', { name: '자료' }));
    const up = await screen.findByRole('region', { name: '올린 파일' });
    expect(within(up).getByText('rfp.pdf')).toBeInTheDocument();
    await userEvent.click(within(up).getByRole('button', { name: 'rfp.pdf 열기' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/office/meeting/files/f1?room=1')).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: '닫기' }));
    const out = screen.getByRole('region', { name: 'AI 에이전트 출력' });
    expect(within(out).getByRole('group', { name: 'sa' })).toHaveTextContent('report.md');
    await userEvent.click(within(out).getByRole('button', { name: 'report.md 열기' }));
    const dlg = await screen.findByRole('dialog', { name: 'report.md' });
    await waitFor(() => expect(calls.some((c) => c.url === '/api/office/meeting/out?room=1&path=sa%2F2026-10-10%2Freport.md')).toBe(true));
    expect(within(dlg).queryByRole('button', { name: '더 보기' })).toBeNull(); // 출력은 받기만(지우기 없음)
    await userEvent.click(screen.getByRole('button', { name: '닫기' }));
    expect(screen.getByText('2 KB / 500 MB')).toBeInTheDocument();
  });

  it('줄마다 크기와 시각을 채팅 「파일」 서랍처럼 열로 보인다(올린 파일은 올린 시각, 에이전트 출력은 고친 시각)', async () => {
    mount();
    await userEvent.click(await screen.findByRole('button', { name: '자료' }));
    const up = await screen.findByRole('region', { name: '올린 파일' });
    const rfp = within(up).getByRole('button', { name: 'rfp.pdf 열기' });
    expect(rfp).toHaveTextContent('2 KB');
    expect(rfp).toHaveTextContent(fmtWhen(Date.parse('2026-10-10T10:00:00+09:00') / 1000));
    const out = screen.getByRole('region', { name: 'AI 에이전트 출력' });
    const report = within(out).getByRole('button', { name: 'report.md 열기' });
    expect(report).toHaveTextContent('300 B');
    expect(report).toHaveTextContent(fmtWhen(1760056200));
    expect(screen.getByText('고친 시각')).toBeInTheDocument(); // 열 머리
  });

  it('이름으로 찾으면 두 구역의 줄을 함께 거르고, 맞는 줄이 없는 에이전트 묶음은 숨긴다', async () => {
    mount();
    await userEvent.click(await screen.findByRole('button', { name: '자료' }));
    const up = await screen.findByRole('region', { name: '올린 파일' });
    await userEvent.type(screen.getByRole('searchbox', { name: '파일 이름으로 찾기' }), 'REPORT');
    const out = screen.getByRole('region', { name: 'AI 에이전트 출력' });
    expect(within(up).queryByRole('button', { name: 'rfp.pdf 열기' })).toBeNull();
    expect(within(out).getByRole('button', { name: 'report.md 열기' })).toBeInTheDocument();
    expect(within(out).queryByRole('group', { name: 'doc' })).toBeNull();
    expect(within(out).getByRole('heading', { name: /^AI 에이전트 출력 1$/ })).toBeInTheDocument();
  });

  it('구역 머리를 누르면 접고 편다(첨부 단추는 머리 단추 밖에 그대로)', async () => {
    mount();
    await userEvent.click(await screen.findByRole('button', { name: '자료' }));
    const up = await screen.findByRole('region', { name: '올린 파일' });
    const head = within(up).getByRole('button', { name: /^올린 파일/ });
    expect(head.getAttribute('aria-expanded')).toBe('true');
    await userEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(within(up).queryByRole('button', { name: 'rfp.pdf 열기' })).toBeNull();
    expect(within(up).getByRole('button', { name: '파일 첨부' })).toBeInTheDocument();
    await userEvent.click(head);
    expect(within(up).getByRole('button', { name: 'rfp.pdf 열기' })).toBeInTheDocument();
  });

  it('올린 사람과 에이전트 출력 묶음은 서버가 준 이름(labels)으로 보이고, 없는 값은 그대로다(스펙 2026-10-20-025 §6)', async () => {
    const labels = { kim: '김철수', sa: '김에이 · AAS 관리자' };
    mount({ extra: { '/api/office/meeting/files': (_u, init) => ((init?.method ?? 'GET') === 'GET' ? { body: { ...LIST, labels } } : { body: { ok: true } }) } });
    await userEvent.click(await screen.findByRole('button', { name: '자료' }));
    const up = await screen.findByRole('region', { name: '올린 파일' });
    expect(within(up).getByText('김철수')).toBeInTheDocument();
    expect(within(up).getByText('park')).toBeInTheDocument();
    const out = screen.getByRole('region', { name: 'AI 에이전트 출력' });
    expect(within(out).getByRole('group', { name: '김에이 · AAS 관리자' })).toHaveTextContent('report.md');
    expect(within(out).getByRole('group', { name: 'doc' })).toHaveTextContent('old.csv');
  });

  // 2026-10-20 OKE: 에이전트가 자기 작업 폴더에 쓴 파일(결과 칩)이 대화에는 보이는데 서랍은 「에이전트 출력 (0)」이었다
  it('에이전트가 자기 작업 폴더에 만든 파일(made)도 에이전트 출력에 보이고, 받기·방에 올리기는 그 기록 행으로 한다', async () => {
    mount({
      extra: {
        '/api/office/meeting/files/from-agent': () => ({
          body: { id: 'f9', name: 'aas-product-features.md', size: 6300, date: 'x', status: 'ready' },
        }),
        '/api/office/meeting/files': () => ({
          body: {
            files: [],
            out: [],
            made: [
              {
                msg: 12,
                n: 0,
                alias: 'aas-user1',
                ts: '2026-10-20T16:32:00+09:00',
                path: 'workspace/aas-product-features.md',
                name: 'aas-product-features.md',
                size: 6300,
              },
            ],
            used: { room: 0, total: 0 },
            out_truncated: false,
          },
        }),
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: '자료' }));
    const out = await screen.findByRole('region', { name: 'AI 에이전트 출력' });
    expect(within(out).getByRole('heading', { name: /^AI 에이전트 출력 1$/ })).toBeInTheDocument();
    const group = within(out).getByRole('group', { name: 'aas-user1' });
    expect(group).toHaveTextContent('2026-10-20');
    await userEvent.click(within(group).getByRole('button', { name: 'aas-product-features.md 열기' }));
    const dlg = await screen.findByRole('dialog', { name: 'aas-product-features.md' });
    await waitFor(() => expect(calls.some((c) => c.url === '/api/office/meeting/agent-file?room=1&msg=12&n=0')).toBe(true));
    await userEvent.click(within(dlg).getByRole('button', { name: '방에 올리기' }));
    await waitFor(() => expect(posted('/api/office/meeting/files/from-agent')).toEqual([{ room: 1, msg: 12, n: 0 }]));
  });

  it('out_truncated 면 일부만 보인다고 알리고, 비면 빈 상태 안내를 보인다', async () => {
    mount({
      extra: {
        '/api/office/meeting/files': () => ({
          body: { files: [], out: [], used: { room: 0, total: 0 }, out_truncated: true },
        }),
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: '자료' }));
    expect(await screen.findByText(/아직 올린 파일이 없습니다/)).toBeInTheDocument();
    expect(screen.getByText(/AI 에이전트가 만든 파일이 없습니다/)).toBeInTheDocument();
    expect(screen.getByText('파일이 많아 일부만 보입니다')).toBeInTheDocument();
  });

  it('지우기는 확인을 거쳐 DELETE 하고 목록을 다시 읽는다', async () => {
    mount();
    await userEvent.click(await screen.findByRole('button', { name: '자료' }));
    await userEvent.click(await screen.findByRole('button', { name: 'rfp.pdf 열기' }));
    const dlg = await screen.findByRole('dialog', { name: 'rfp.pdf' });
    await userEvent.click(within(dlg).getByRole('button', { name: '더 보기' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: '지우기' }));
    expect(await screen.findByText('rfp.pdf 을(를) 지웁니다. 되돌릴 수 없습니다.')).toBeInTheDocument();
    expect(calls.some((c) => c.init?.method === 'DELETE')).toBe(false);
    const before = calls.filter((c) => c.url.startsWith('/api/office/meeting/files?room=1') && !c.init?.method).length;
    await userEvent.click(screen.getByRole('button', { name: '확인' }));
    await waitFor(() =>
      expect(calls.some((c) => c.init?.method === 'DELETE' && c.url === '/api/office/meeting/files/f1?room=1')).toBe(
        true
      )
    );
    expect(await screen.findByText('파일 rfp.pdf 을(를) 지웠습니다')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        calls.filter((c) => c.url.startsWith('/api/office/meeting/files?room=1') && !c.init?.method).length
      ).toBeGreaterThan(before)
    );
  });

  it('「올린 파일」 머리의 첨부 단추로 고른 파일은 입력 카드의 보낼 첨부로 붙고, 다 올리면 서랍 목록을 다시 읽는다', async () => {
    mount();
    await userEvent.click(await screen.findByRole('button', { name: '자료' }));
    const up = await screen.findByRole('region', { name: '올린 파일' });
    expect(within(up).getByRole('button', { name: '파일 첨부' })).toBeInTheDocument();
    const before = calls.filter((c) => c.url.startsWith('/api/office/meeting/files?room=1') && !c.init?.method).length;
    fireEvent.change(screen.getByTestId('meeting-drawer-file-input'), { target: { files: [doc('plan.pdf')] } });
    // 서랍이 열려 있는 동안 뒤 화면은 보조 기술에서 숨는다(hidden: true 로 찾는다)
    expect(await screen.findByRole('group', { name: '보낼 첨부 1개', hidden: true })).toBeInTheDocument();
    const xhr = FakeXHR.all[0];
    expect(xhr.url).toBe('/api/office/meeting/files?room=1&name=plan.pdf');
    xhr.respond(200, { id: 'f9', name: 'plan.pdf', size: 1000, date: '2026-10-15', status: 'ready' });
    await waitFor(() =>
      expect(calls.filter((c) => c.url.startsWith('/api/office/meeting/files?room=1') && !c.init?.method).length).toBeGreaterThan(before)
    );
  });

  it('끝난 방의 서랍에는 첨부 단추가 없다', async () => {
    mount({ view: view({ room: { id: 1, name: '제안 TFT', purpose: 'RFP 대응', status: 'closed' } }) });
    await userEvent.click(await screen.findByRole('button', { name: '자료' }));
    const up = await screen.findByRole('region', { name: '올린 파일' });
    expect(within(up).queryByRole('button', { name: '파일 첨부' })).toBeNull();
  });

  it('올린 사람이 아닌 일반 사용자에게는 지우기가 보이지 않는다', async () => {
    mount({
      extra: {
        '/api/me': () => ({ body: { auth_enabled: true, admin: false, user: { email: 'kim@x.com', name: 'kim' } } }),
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: '자료' }));
    // 지우기는 뷰어 머리 「…」 메뉴 안(DD3) — 올린 사람·관리자에게만 메뉴가 있다
    await userEvent.click(await screen.findByRole('button', { name: 'rfp.pdf 열기' }));
    expect(within(await screen.findByRole('dialog', { name: 'rfp.pdf' })).getByRole('button', { name: '더 보기' })).toBeInTheDocument(); // kim 이 올린 파일
    await userEvent.click(screen.getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'rfp.pdf' })).toBeNull());
    await userEvent.click(screen.getByRole('button', { name: 'other.txt 열기' }));
    expect(within(await screen.findByRole('dialog', { name: 'other.txt' })).queryByRole('button', { name: '더 보기' })).toBeNull(); // park 이 올린 파일
  });
});

describe('회의 파일: 오류 글', () => {
  it('말하기 오류는 서버가 error 에 문장, reason 에 코드를 보내므로 reason 을 번역한다', () => {
    const txt = fileErrorText(new ApiError('받을 수 있는 AI 에이전트 작업공간이 없습니다(서버 문장)', 409, 'no_receiver'));
    expect(txt).not.toContain('서버 문장');
    expect(txt.length).toBeGreaterThan(0);
  });
  it('reason 이 없으면 메시지를 그대로 쓴다', () => {
    expect(fileErrorText(new ApiError('서버가 보낸 문장', 400))).toBe('서버가 보낸 문장');
  });
});
