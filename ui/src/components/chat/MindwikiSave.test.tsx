/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 「MindWiki 에 저장」(스펙 2026-11-15-002 A4·D19): 위젯 안에서는 없음, 기억한 위치로 바로 저장, 같은 키, 실패 이유는 문장, 위치를 다시 고르기
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '@/i18n';
import { EmbedContext } from '@/lib/embedContext';

const calls: { url: string; init?: RequestInit }[] = [];
type Answer = { status: number; body: unknown };
// 값 대신 함수를 두면 질의 문자열(teamspace·parent·q)마다 다른 답을 줄 수 있다
let answers: Record<string, Answer | ((params: URLSearchParams, body: Record<string, unknown>) => Answer)> = {};
vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const [path, query = ''] = url.split('?');
    const v = answers[`${init?.method ?? 'GET'} ${path}`];
    const a = typeof v === 'function' ? v(new URLSearchParams(query), JSON.parse(String(init?.body ?? '{}'))) : (v ?? { status: 404, body: { ok: false, reason: 'invalid' } });
    return new Response(JSON.stringify(a.body), { status: a.status });
  }),
}));

// 브라우저용 MindWiki 주소(/api/me)와 탭 열기(스펙 2026-11-23-019 G4·L3b)는 대역으로
vi.mock('@/lib/data', () => ({ useMe: () => ({ data: { mindwiki_url: 'https://wiki.example.com' } }) }));
const opened: { url: string; navigate?: boolean }[] = [];
vi.mock('@/lib/productTab', () => ({
  MINDWIKI_TAB: 'cogentai-mindwiki',
  openProductTab: vi.fn(async (url: string, _base: string, opts?: { navigate?: boolean }) => {
    opened.push({ url, navigate: opts?.navigate });
    return { kind: 'navigated' };
  }),
}));

import { SnackbarProvider } from 'notistack';

import { browserUrl, defaultTitle, forgetSaveState, reasonText, SaveFileToMindwiki, SaveToMindwiki, shortPath, TargetDialog } from './MindwikiSave';

const target = { teamspace: 'ts1', parent_id: 'p1', parent_title: '메모', path: '개발' };
const props = { pod: 'pod-a', profile: 'main', conversation: 'conv1', message: 'msg1', markdown: '# 배포 절차\n\n본문', agent: 'main' };

beforeEach(() => {
  calls.length = 0;
  opened.length = 0;
  forgetSaveState();
  answers = { 'GET /api/mindwiki/save/state': { status: 200, body: { available: true, hidden: false, reason: '', target } } };
});
afterEach(cleanup);

describe('도우미', () => {
  it('제목은 답의 첫 제목 줄, 없으면 「<에이전트> 답 <날짜>」', () => {
    expect(defaultTitle('앞말\n## 회의 요약 ##\n본문', 'main')).toBe('회의 요약');
    expect(defaultTitle('제목 없는 답', 'main', new Date(2026, 10, 15))).toBe('main 답 2026-11-15');
  });
  it('긴 경로는 가운데를 줄인다(S1)', () => {
    expect(shortPath(['팀', '회의록'])).toBe('팀 › 회의록');
    expect(shortPath(['팀', '2026', '11월', '주간'])).toBe('팀 › … › 주간');
  });
  it('저장 결과 주소는 경로만 쓰고 출처는 브라우저용 MindWiki 로(L3b)', () => {
    expect(browserUrl('http://mindwiki-api.ns.svc:8080/p/p9?x=1', 'https://wiki.example.com')).toBe('https://wiki.example.com/p/p9?x=1');
    expect(browserUrl('/p/p9', 'https://wiki.example.com')).toBe('https://wiki.example.com/p/p9');
  });
  it('모르는 이유는 「저장하지 못했습니다」', () => {
    expect(reasonText('write_disabled')).toBe('관리자가 MindWiki 쓰기를 막았습니다.');
    expect(reasonText('what')).toBe('저장하지 못했습니다.');
  });
});

describe('SaveToMindwiki', () => {
  it('위젯 안에서는 그리지 않고 상태도 묻지 않는다(D19)', async () => {
    render(
      <EmbedContext.Provider value={{ backendUrl: 'https://aas' }}>
        <SaveToMindwiki {...props} />
      </EmbedContext.Provider>
    );
    await act(async () => undefined);
    expect(screen.queryByTestId('mw-save')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('Keycloak 로그인이 아닌 설치에서는 숨긴다', async () => {
    answers['GET /api/mindwiki/save/state'] = { status: 200, body: { available: false, hidden: true, reason: 'no_keycloak', target: null } };
    render(<SaveToMindwiki {...props} />);
    await act(async () => undefined);
    expect(screen.queryByTestId('mw-save')).toBeNull();
  });

  it('쓰기가 막혔으면 단추를 막고 이유를 툴팁으로', async () => {
    answers['GET /api/mindwiki/save/state'] = { status: 200, body: { available: false, hidden: false, reason: 'write_disabled', target } };
    render(<SaveToMindwiki {...props} />);
    const btn = await screen.findByTestId('mw-save');
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('기억한 위치로 바로 저장하고 (대화, 메시지)를 보낸다(키는 서버가 만든다). 저장됨과 「MindWiki 에서 열기」는 같은 탭으로', async () => {
    answers['POST /api/mindwiki/save/answer'] = { status: 200, body: { ok: true, page_id: 'p9', url: 'https://wiki/p/p9' } };
    render(<SaveToMindwiki {...props} />);
    expect(await screen.findByText(/저장 위치: 개발 › 메모/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('mw-save'));
    await waitFor(() => expect(screen.getByTestId('mw-saved').textContent).toContain('「배포 절차」 에 저장했습니다'));
    fireEvent.click(screen.getByTestId('mw-open'));
    await waitFor(() => expect(opened).toEqual([{ url: 'https://wiki.example.com/p/p9', navigate: true }]));
    const post = calls.find((c) => c.init?.method === 'POST')!;
    const sent = JSON.parse(String(post.init!.body));
    expect(sent).toMatchObject({ pod: 'pod-a', profile: 'main', conversation: 'conv1', message: 'msg1', parent_id: 'p1', title: '배포 절차', markdown: props.markdown });
    expect(sent.key).toBeUndefined();
  });

  it('위치가 지워졌으면 이유를 보이고 위치 고르기를 연다', async () => {
    answers['POST /api/mindwiki/save/answer'] = { status: 404, body: { ok: false, reason: 'parent_not_found' } };
    answers['GET /api/mindwiki/save/teamspaces'] = { status: 200, body: { teamspaces: [{ id: 'ts1', name: '개발' }] } };
    answers['GET /api/mindwiki/save/pages'] = { status: 200, body: { pages: [] } };
    render(<SaveToMindwiki {...props} />);
    fireEvent.click(await screen.findByTestId('mw-save'));
    expect((await screen.findByTestId('mw-failed')).textContent).toBe('저장 위치의 페이지가 지워졌습니다. 위치를 다시 고르세요.');
    expect(await screen.findByRole('dialog', { name: 'MindWiki 에 저장할 곳' })).toBeTruthy();
    // 실패로 열렸으니 맨 위 경고 줄에 이유, 서버가 지운 기억 위치는 「최근」에서도 빠진다(4-6 D4, R3)
    expect(screen.getByTestId('mw-fail-alert').textContent).toContain('저장 위치의 페이지가 지워졌습니다');
    expect(screen.queryByTestId('mw-recent')).toBeNull();
    expect(await screen.findByText('하위 페이지를 만들 수 있는 페이지가 없습니다.')).toBeTruthy();
  });

  it('처음이면 위치를 고르고 기억한 뒤 저장한다', async () => {
    answers['GET /api/mindwiki/save/state'] = { status: 200, body: { available: true, hidden: false, reason: '', target: null } };
    answers['GET /api/mindwiki/save/teamspaces'] = { status: 200, body: { teamspaces: [{ id: 'ts1', name: '개발' }] } };
    answers['GET /api/mindwiki/save/pages'] = { status: 200, body: { pages: [{ id: 'p7', title: '회의록', path: '' }] } };
    answers['PUT /api/mindwiki/save/target'] = { status: 200, body: { ok: true } };
    answers['POST /api/mindwiki/save/answer'] = { status: 200, body: { ok: true, page_id: 'p8', url: 'https://wiki/p/p8' } };
    render(<SaveToMindwiki {...props} />);
    fireEvent.click(await screen.findByTestId('mw-save'));
    fireEvent.click(await screen.findByTestId('mw-page'));
    fireEvent.click(screen.getByTestId('mw-pick-save'));
    await waitFor(() => expect(screen.getByTestId('mw-saved')).toBeTruthy());
    const put = calls.find((c) => c.init?.method === 'PUT')!;
    expect(JSON.parse(String(put.init!.body))).toMatchObject({ pod: 'pod-a', profile: 'main', parent_id: 'p7', parent_title: '회의록', path: '개발', kind: 'page' });
    const post = calls.find((c) => c.init?.method === 'POST')!;
    expect(JSON.parse(String(post.init!.body))).toMatchObject({ conversation: 'conv1', message: 'msg1', parent_id: 'p7', kind: 'page' });
  });
});

describe('SaveFileToMindwiki', () => {
  it('기억한 위치의 「AAS 파일」 페이지로 파일을 보내고 결과를 알린다', async () => {
    answers['POST /api/mindwiki/save/file'] = { status: 200, body: { ok: true, page_id: 'pf', name: '보고서.pdf', url: 'https://wiki/p/pf' } };
    render(
      <SnackbarProvider>
        <SaveFileToMindwiki pod="pod-a" profile="main" path="/workspace/보고서.pdf" name="보고서.pdf" />
      </SnackbarProvider>
    );
    fireEvent.click(await screen.findByTestId('mw-save-file'));
    expect(await screen.findByText('「보고서.pdf」 에 저장했습니다')).toBeTruthy();
    const post = calls.find((c) => c.init?.method === 'POST')!;
    const sent = JSON.parse(String(post.init!.body));
    expect(sent).toMatchObject({ pod: 'pod-a', profile: 'main', path: '/workspace/보고서.pdf', parent_id: 'p1' });
    expect(sent.key).toBeUndefined(); // 파일 키는 서버가 (경로, 크기, 수정 시각)으로 만든다(리뷰 Eng H2)
    fireEvent.click(screen.getByRole('button', { name: 'MindWiki 에서 열기' })); // 파일 알림에도 링크(Design D9)
    await waitFor(() => expect(opened).toEqual([{ url: 'https://wiki.example.com/p/pf', navigate: true }]));
  });

  it('너무 큰 파일은 MindWiki 의 이유를 그대로 문장으로', async () => {
    answers['POST /api/mindwiki/save/file'] = { status: 413, body: { ok: false, reason: 'attachment_too_large' } };
    render(
      <SnackbarProvider>
        <SaveFileToMindwiki pod="pod-a" profile="main" path="/workspace/big.zip" name="big.zip" />
      </SnackbarProvider>
    );
    fireEvent.click(await screen.findByTestId('mw-save-file'));
    expect(await screen.findByText('파일이 MindWiki 첨부 한도보다 큽니다.')).toBeTruthy();
  });
});

describe('저장 위치 글자와 툴팁(스펙 2026-11-23-019 S1·S3)', () => {
  it('마지막 답이 아니면 「저장 위치」 글자를 그리지 않는다', async () => {
    render(<SaveToMindwiki {...props} latest={false} />);
    await screen.findByTestId('mw-save');
    expect(screen.queryByTestId('mw-target')).toBeNull();
  });
  it('MindWiki 를 함께 설치하지 않았으면(no_mindwiki) 단추가 없다', async () => {
    answers['GET /api/mindwiki/save/state'] = { status: 200, body: { available: false, hidden: true, reason: 'no_mindwiki' } };
    render(<SaveToMindwiki {...props} />);
    await act(async () => undefined);
    expect(screen.queryByTestId('mw-save')).toBeNull();
  });
});

// 고르기 창(스펙 2026-11-23-019 4-4·4-6). 판 2(데이터베이스·새로 만들기 가능)를 기본으로 두고 경우마다 바꾼다
describe('고르기 창(4-6)', () => {
  const dbTarget = { teamspace: 'ts1', parent_id: 'db1', parent_title: '회의록', path: '개발', kind: 'database' as const };
  const pagesAnswer = (p: URLSearchParams): Answer => {
    if (p.get('q')) return { status: 200, body: { pages: p.get('q') === '없음' ? [] : [{ id: 'p9', title: '주간 보고', path: '개발 › 2026', kind: 'page' }] } };
    if (p.get('teamspace') === 'ts1')
      return {
        status: 200,
        body: {
          pages: [
            { id: 'p7', title: '설계 문서', path: '', kind: 'page', has_children: true },
            { id: 'db1', title: '회의록', path: '', kind: 'database', has_children: false },
          ],
        },
      };
    if (p.get('parent') === 'p7') return { status: 200, body: { pages: [{ id: 'p71', title: '화면', path: '', kind: 'page', has_children: false }] } };
    return { status: 200, body: { pages: [] } };
  };
  const level = (save_level: number, make_database = true) => {
    answers['GET /api/mindwiki/save/teamspaces'] = {
      status: 200,
      body: {
        teamspaces: [
          { id: 'ts1', name: '개발', can_create_top: true },
          { id: 'ts2', name: '운영', can_create_top: false },
        ],
        save_level,
        make_database,
      },
    };
  };
  beforeEach(() => {
    level(2);
    answers['GET /api/mindwiki/save/pages'] = pagesAnswer;
  });
  const open = (extra: Partial<Parameters<typeof TargetDialog>[0]> = {}) => {
    const onPicked = vi.fn();
    render(<TargetDialog pod="pod-a" profile="main" initialTitle="배포 절차" onClose={() => undefined} onPicked={onPicked} {...extra} />);
    return onPicked;
  };
  const row = async (title: string) => (await screen.findByText(title)).closest('[role="treeitem"]') as HTMLElement;
  const dest = () => screen.getByTestId('mw-dest').textContent;
  const after = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  it('배치: 경고 → 최근 → 찾기 → 목록 → 저장할 곳 → 결과 → 제목 → 기억, 기억한 위치가 없으면 「최근」 칸이 없다', async () => {
    open({ remembered: target, failReason: 'row_rejected' });
    const order = [
      screen.getByTestId('mw-fail-alert'),
      screen.getByTestId('mw-recent'),
      screen.getByTestId('mw-search'),
      screen.getByRole('tree'),
      screen.getByTestId('mw-dest'),
    ];
    fireEvent.click(await row('설계 문서'));
    order.push(screen.getByTestId('mw-result'), screen.getByLabelText('새 페이지 제목'), screen.getByLabelText('이 위치 기억'));
    for (let i = 1; i < order.length; i++) expect(after(order[i - 1], order[i])).toBe(true);
    expect(screen.getByTestId('mw-recent').textContent).toContain('기억한 위치');
    cleanup();
    open();
    await row('설계 문서');
    expect(screen.queryByTestId('mw-recent')).toBeNull();
    expect(screen.queryByTestId('mw-fail-alert')).toBeNull(); // 실패로 열린 것이 아니면 경고 줄도 없다
  });

  it('찾기 글자가 있으면 결과가 목록 자리를 대신하고, 없으면 「찾는 페이지가 없습니다」', async () => {
    open();
    await row('설계 문서');
    fireEvent.change(screen.getByTestId('mw-search'), { target: { value: '주간' } });
    expect(await screen.findByText('주간 보고')).toBeTruthy();
    expect(screen.queryByText('설계 문서')).toBeNull();
    expect(screen.queryAllByTestId('mw-ts')).toHaveLength(0);
    expect(calls.some((c) => c.url.includes('q=%EC%A3%BC%EA%B0%84'))).toBe(true);
    fireEvent.change(screen.getByTestId('mw-search'), { target: { value: '없음' } });
    expect(await screen.findByText('찾는 페이지가 없습니다.')).toBeTruthy();
    fireEvent.change(screen.getByTestId('mw-search'), { target: { value: '' } });
    expect(await row('설계 문서')).toBeTruthy();
  });

  it('결과 안내 한 줄은 위치 종류마다 다르고, 고르기 전에는 [저장]이 막힌다', async () => {
    open();
    expect(dest()).toBe('저장할 곳을 고르세요');
    expect((screen.getByTestId('mw-pick-save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(await row('설계 문서'));
    expect(screen.getByTestId('mw-result').textContent).toBe('이 페이지 아래에 새 하위 페이지를 만듭니다.');
    expect(dest()).toBe('저장할 곳: 개발 › 설계 문서');
    fireEvent.click(await row('회의록'));
    expect(screen.getByTestId('mw-result').textContent).toBe('이 데이터베이스에 새 행을 더합니다.');
    fireEvent.click(await row('개발'));
    expect(screen.getByTestId('mw-result').textContent).toBe('팀스페이스 맨 위에 새 페이지를 만듭니다.');
    expect((screen.getByTestId('mw-pick-save') as HTMLButtonElement).disabled).toBe(false);
    cleanup();
    open({ noTitle: true });
    fireEvent.click(await row('설계 문서'));
    expect(screen.getByTestId('mw-result').textContent).toBe('이 위치의 「AAS 파일」 페이지에 첨부합니다.');
    fireEvent.click(await row('회의록'));
    expect(screen.getByTestId('mw-result').textContent).toBe('이 데이터베이스의 새 행에 첨부합니다.');
  });

  it('can_create_top 이 거짓인 팀스페이스 줄은 고르지 못한다', async () => {
    open();
    const ts2 = await row('운영');
    expect(ts2.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(ts2);
    expect(dest()).toBe('저장할 곳을 고르세요');
  });

  it('새로 만들기: 이름이 비면 막히고, 실패하면 이유와 이름이 남고, 만들면 골라질 뿐 저장하지 않는다. 누를 때마다 nonce 가 다르다', async () => {
    const sent: Record<string, unknown>[] = [];
    let fail = true;
    answers['POST /api/mindwiki/save/create'] = (_p, body) => {
      sent.push(body);
      return fail ? { status: 403, body: { ok: false, reason: 'forbidden_parent' } } : { status: 200, body: { ok: true, id: 'p8', kind: 'page', title: String(body.title), url: '/p/p8' } };
    };
    const onPicked = open();
    const p7 = await row('설계 문서');
    expect((screen.getByTestId('mw-new-page') as HTMLButtonElement).disabled).toBe(true); // 고르기 전에는 막힘
    fireEvent.click(p7);
    fireEvent.click(screen.getByTestId('mw-new-page'));
    expect((screen.getByTestId('mw-make') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('mw-new-name'), { target: { value: '새 설계' } });
    fireEvent.click(screen.getByTestId('mw-make'));
    expect((await screen.findByTestId('mw-make-failed')).textContent).toContain('저장 위치에 페이지를 만들 권한이 없습니다');
    expect((screen.getByTestId('mw-new-name') as HTMLInputElement).value).toBe('새 설계');
    fail = false;
    fireEvent.click(screen.getByTestId('mw-make'));
    await waitFor(() => expect(dest()).toBe('저장할 곳: 개발 › 설계 문서 › 새 설계'));
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ pod: 'pod-a', profile: 'main', make: 'page', parent_id: 'p7', parent_kind: 'page', title: '새 설계' });
    expect(sent[0].nonce).toBeTruthy();
    expect(sent[1].nonce).not.toBe(sent[0].nonce);
    const made = await row('새 설계');
    expect(made.getAttribute('aria-selected')).toBe('true');
    expect(onPicked).not.toHaveBeenCalled();
    expect(calls.some((c) => c.url.includes('/save/answer'))).toBe(false);
  });

  it('새로 만들기 결과를 모르면 확인 안내와 [다시 시도], 다시 시도는 같은 nonce', async () => {
    const sent: Record<string, unknown>[] = [];
    answers['POST /api/mindwiki/save/create'] = (_p, body) => {
      sent.push(body);
      return { status: 504, body: { ok: false, reason: 'timeout' } };
    };
    open();
    fireEvent.click(await row('개발'));
    fireEvent.click(screen.getByTestId('mw-new-db'));
    fireEvent.change(screen.getByTestId('mw-new-name'), { target: { value: '회의 기록' } });
    fireEvent.click(screen.getByTestId('mw-make'));
    expect((await screen.findByTestId('mw-make-failed')).textContent).toContain('만들어졌는지 확인하지 못했습니다');
    fireEvent.click(screen.getByTestId('mw-make-retry'));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[0]).toMatchObject({ make: 'database', parent_id: 'ts1', parent_kind: 'teamspace' });
    expect(sent[1].nonce).toBe(sent[0].nonce);
  });

  it('데이터베이스를 골랐으면 새 페이지·새 데이터베이스가 막힌다', async () => {
    open();
    fireEvent.click(await row('회의록'));
    expect((screen.getByTestId('mw-new-page') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('mw-new-db') as HTMLButtonElement).disabled).toBe(true);
  });

  it('make_database 가 거짓이면 「새 데이터베이스」만 없다', async () => {
    level(2, false);
    open();
    fireEvent.click(await row('설계 문서'));
    expect(screen.getByTestId('mw-new-page')).toBeTruthy();
    expect(screen.queryByTestId('mw-new-db')).toBeNull();
  });

  it('save_level < 2 면 새로 만들기가 없고 팀스페이스 줄은 펼치기만, 페이지가 아닌 기억 위치는 막힌다', async () => {
    level(1);
    answers['GET /api/mindwiki/save/pages'] = { status: 200, body: { pages: [{ id: 'p7', title: '설계 문서', path: '' }] } };
    open({ remembered: dbTarget });
    const ts1 = await row('개발');
    await row('설계 문서');
    expect(screen.queryByTestId('mw-new-page')).toBeNull();
    expect(screen.queryByTestId('mw-new-db')).toBeNull();
    expect(screen.getByLabelText('페이지 찾기')).toBeTruthy();
    expect(ts1.getAttribute('aria-selected')).toBeNull();
    fireEvent.click(ts1); // 고르지 않고 접는다
    expect(dest()).toBe('저장할 곳을 고르세요');
    expect(ts1.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('mw-recent-item').getAttribute('aria-disabled')).toBe('true');
  });

  it('목록 키보드: ↓ 이동, → 펼치기, ← 접기, Enter 고르기(WAI-ARIA tree)', async () => {
    open();
    const p7 = await row('설계 문서');
    expect(screen.getByRole('tree')).toBeTruthy();
    expect(p7.getAttribute('aria-expanded')).toBe('false');
    p7.focus();
    fireEvent.keyDown(p7, { key: 'ArrowRight' });
    expect(await screen.findByText('화면')).toBeTruthy();
    expect(p7.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(p7, { key: 'ArrowLeft' });
    expect(p7.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('화면')).toBeNull();
    fireEvent.keyDown(p7, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(await row('회의록'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(p7);
    fireEvent.keyDown(p7, { key: 'Enter' });
    expect(p7.getAttribute('aria-selected')).toBe('true');
    expect(dest()).toBe('저장할 곳: 개발 › 설계 문서');
  });

  it('펼치기가 실패하면 그 줄 아래 「불러오지 못했습니다 · 다시 시도」', async () => {
    let n = 0;
    answers['GET /api/mindwiki/save/pages'] = (p) => (p.get('parent') === 'p7' && n++ === 0 ? { status: 502, body: { ok: false, reason: 'mindwiki_5xx' } } : pagesAnswer(p));
    open();
    fireEvent.click(within(await row('설계 문서')).getByRole('button', { name: '펼치기' }));
    expect((await screen.findByTestId('mw-row-failed')).textContent).toContain('불러오지 못했습니다');
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(await screen.findByText('화면')).toBeTruthy();
  });

  it('고른 위치의 kind 를 기억·저장 요청에 보낸다', async () => {
    answers['PUT /api/mindwiki/save/target'] = { status: 200, body: { ok: true } };
    const onPicked = open();
    fireEvent.click(await row('회의록'));
    fireEvent.click(screen.getByTestId('mw-pick-save'));
    await waitFor(() => expect(onPicked).toHaveBeenCalled());
    const put = calls.find((c) => c.init?.method === 'PUT')!;
    expect(JSON.parse(String(put.init!.body))).toMatchObject({ teamspace: 'ts1', parent_id: 'db1', parent_title: '회의록', path: '개발', kind: 'database' });
    expect(onPicked.mock.calls[0][0]).toMatchObject({ parent_id: 'db1', kind: 'database' });
  });
});

describe('최근 저장 위치(스펙 2026-11-23-019 R2~R4)', () => {
  const r = (parent_id: string, parent_title: string, kind: 'page' | 'database' | 'teamspace' = 'page') => ({ teamspace: 'ts1', parent_id, parent_title, path: kind === 'teamspace' ? '' : '개발', kind });
  beforeEach(() => {
    answers['GET /api/mindwiki/save/teamspaces'] = { status: 200, body: { teamspaces: [{ id: 'ts1', name: '개발', can_create_top: true }], save_level: 2, make_database: false } };
    answers['GET /api/mindwiki/save/pages'] = { status: 200, body: { pages: [] } };
  });
  const open = (extra: Partial<Parameters<typeof TargetDialog>[0]> = {}) => {
    const onPicked = vi.fn();
    render(<TargetDialog pod="pod-a" profile="main" initialTitle="배포 절차" onClose={() => undefined} onPicked={onPicked} {...extra} />);
    return onPicked;
  };
  const recentIds = () => screen.getAllByTestId('mw-recent-item').map((e) => e.getAttribute('data-id'));

  it('저장한 시각 순서 그대로, 「기억한 위치」 표시는 기억한 위치와 같은 줄에만(맨 앞이 아니어도)', async () => {
    open({ remembered: target, recent: [r('p3', '회의록'), r('p1', '메모'), r('p2', '설계')] });
    expect(recentIds()).toEqual(['p3', 'p1', 'p2']);
    const marked = screen.getAllByTestId('mw-recent-item').filter((e) => e.getAttribute('data-remembered'));
    expect(marked.map((e) => e.getAttribute('data-id'))).toEqual(['p1']);
    expect(within(marked[0]).getByTestId('mw-remembered').textContent).toContain('기억한 위치');
    expect(screen.getAllByTestId('mw-remembered')).toHaveLength(1);
    await act(async () => undefined);
  });

  it('기억한 위치가 최근에 없으면 맨 앞 줄로 더하고, 기억한 위치가 없으면 표시도 없다', async () => {
    open({ remembered: target, recent: [r('p3', '회의록')] });
    expect(recentIds()).toEqual(['p1', 'p3']);
    expect(screen.getAllByTestId('mw-recent-item')[0].getAttribute('data-remembered')).toBe('true');
    cleanup();
    open({ recent: [r('p3', '회의록'), r('p2', '설계')] });
    expect(recentIds()).toEqual(['p3', 'p2']);
    expect(screen.queryByTestId('mw-remembered')).toBeNull();
    await act(async () => undefined);
  });

  it('save_level < 2 면 페이지가 아닌 최근 줄은 막고 이유를 툴팁으로, 페이지 줄은 고를 수 있다', async () => {
    answers['GET /api/mindwiki/save/teamspaces'] = { status: 200, body: { teamspaces: [{ id: 'ts1', name: '개발' }], save_level: 1 } };
    open({ recent: [r('db1', '회의록', 'database'), r('p2', '설계'), r('ts1', '개발', 'teamspace')] });
    await screen.findByText('개발', { selector: '[role="treeitem"] span' });
    const [db, page, ts] = screen.getAllByTestId('mw-recent-item');
    await waitFor(() => expect(db.getAttribute('aria-disabled')).toBe('true'));
    expect(ts.getAttribute('aria-disabled')).toBe('true');
    expect(page.getAttribute('aria-disabled')).toBeNull();
    fireEvent.mouseOver(db);
    expect((await screen.findByRole('tooltip')).textContent).toBe(reasonText('need_upgrade'));
    fireEvent.click(db);
    expect(screen.getByTestId('mw-dest').textContent).toBe('저장할 곳을 고르세요');
    fireEvent.click(page);
    expect(screen.getByTestId('mw-dest').textContent).toBe('저장할 곳: 개발 › 설계');
  });

  it('최근 줄을 누르면 고른 것이 되고 [저장]이 그 위치를 넘긴다', async () => {
    const onPicked = open({ recent: [r('db1', '회의록', 'database'), r('p2', '설계')] });
    await screen.findByText('개발', { selector: '[role="treeitem"] span' });
    const db = screen.getAllByTestId('mw-recent-item')[0];
    fireEvent.click(db);
    expect(db.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('mw-result').textContent).toBe(t('chat.mwSave.result.database'));
    fireEvent.click(screen.getByLabelText('이 위치 기억')); // 기억하지 않아도 저장은 된다
    fireEvent.click(screen.getByTestId('mw-pick-save'));
    await waitFor(() => expect(onPicked).toHaveBeenCalled());
    expect(onPicked.mock.calls[0][0]).toMatchObject({ parent_id: 'db1', kind: 'database', parent_title: '회의록', path: '개발' });
    expect(onPicked.mock.calls[0][2]).toBe(false);
    expect(calls.some((c) => c.init?.method === 'PUT')).toBe(false);
  });

  it('저장 요청에 위치의 제목·경로·팀스페이스를 보내고, 저장한 위치가 다음 고르기 창의 최근 맨 앞에 온다', async () => {
    answers['GET /api/mindwiki/save/state'] = { status: 200, body: { available: true, hidden: false, reason: '', target, recent: [r('p3', '회의록'), r('p1', '메모')] } };
    answers['POST /api/mindwiki/save/answer'] = { status: 200, body: { ok: true, page_id: 'n1', url: 'https://wiki/p/n1' } };
    render(<SaveToMindwiki {...props} />);
    fireEvent.click(await screen.findByTestId('mw-save'));
    await screen.findByTestId('mw-saved');
    const sent = JSON.parse(String(calls.find((c) => c.init?.method === 'POST')!.init!.body));
    expect(sent).toMatchObject({ parent_id: 'p1', kind: 'page', parent_title: '메모', parent_path: '개발', teamspace: 'ts1' });
  });

  it('위치가 지워지면 그 최근 줄도 빠진다(R3)', async () => {
    answers['GET /api/mindwiki/save/state'] = { status: 200, body: { available: true, hidden: false, reason: '', target, recent: [r('p1', '메모'), r('p3', '회의록')] } };
    answers['POST /api/mindwiki/save/answer'] = { status: 404, body: { ok: false, reason: 'parent_not_found' } };
    render(<SaveToMindwiki {...props} />);
    fireEvent.click(await screen.findByTestId('mw-save'));
    await screen.findByTestId('mw-fail-alert');
    expect(recentIds()).toEqual(['p3']);
    expect(screen.queryByTestId('mw-remembered')).toBeNull();
  });
});

describe('부분 결과와 실패로 열기(4-4 P6·P8)', () => {
  const dbTarget = { teamspace: 'ts1', parent_id: 'db1', parent_title: '회의록', path: '개발', kind: 'database' };
  beforeEach(() => {
    answers['GET /api/mindwiki/save/state'] = { status: 200, body: { available: true, hidden: false, reason: '', target: dbTarget } };
    answers['GET /api/mindwiki/save/teamspaces'] = { status: 200, body: { teamspaces: [{ id: 'ts1', name: '개발', can_create_top: true }], save_level: 2, make_database: true } };
    answers['GET /api/mindwiki/save/pages'] = { status: 200, body: { pages: [{ id: 'db1', title: '회의록', path: '', kind: 'database' }] } };
  });

  it('body_failed 면 「행은 만들었지만 본문을 쓰지 못했습니다」, [본문 복사]는 답 마크다운을 복사한다', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    answers['POST /api/mindwiki/save/answer'] = { status: 200, body: { ok: true, page_id: 'r1', url: 'https://wiki/p/r1', body_failed: true } };
    render(<SaveToMindwiki {...props} />);
    fireEvent.click(await screen.findByTestId('mw-save'));
    const part = await screen.findByTestId('mw-partial');
    expect(part.textContent).toContain('행은 만들었지만 본문을 쓰지 못했습니다.');
    expect(part.textContent).toContain('다시 저장해도 본문은 채워지지 않습니다');
    const post = calls.find((c) => c.init?.method === 'POST')!;
    expect(JSON.parse(String(post.init!.body))).toMatchObject({ parent_id: 'db1', kind: 'database' });
    fireEvent.click(screen.getByTestId('mw-copy-body'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(props.markdown));
    expect(await screen.findByText('복사했습니다')).toBeTruthy();
    fireEvent.click(screen.getByTestId('mw-open'));
    await waitFor(() => expect(opened).toEqual([{ url: 'https://wiki.example.com/p/r1', navigate: true }]));
  });

  it('row_rejected 면 기억 위치를 남긴 채 고르기 창을 열고 그 데이터베이스를 막는다', async () => {
    answers['POST /api/mindwiki/save/answer'] = { status: 422, body: { ok: false, reason: 'row_rejected' } };
    render(<SaveToMindwiki {...props} />);
    fireEvent.click(await screen.findByTestId('mw-save'));
    expect((await screen.findByTestId('mw-fail-alert')).textContent).toBe('이 데이터베이스에는 행을 더할 수 없습니다. 다른 위치를 고르세요.');
    expect(screen.getByTestId('mw-recent-item').getAttribute('aria-disabled')).toBe('true');
    const db = (await screen.findByText('회의록', { selector: '[role="treeitem"] span' })).closest('[role="treeitem"]')!;
    expect(db.getAttribute('aria-disabled')).toBe('true');
  });

  it('파일: 행은 만들었지만 첨부가 실패하면(attach_failed) 그렇게 알린다', async () => {
    answers['POST /api/mindwiki/save/file'] = { status: 200, body: { ok: true, page_id: 'r2', name: '보고서.pdf', url: 'https://wiki/p/r2', attach_failed: true } };
    render(
      <SnackbarProvider>
        <SaveFileToMindwiki pod="pod-a" profile="main" path="/workspace/보고서.pdf" name="보고서.pdf" />
      </SnackbarProvider>
    );
    fireEvent.click(await screen.findByTestId('mw-save-file'));
    expect(await screen.findByText('「보고서.pdf」 행은 만들었지만 파일을 첨부하지 못했습니다.')).toBeTruthy();
    const post = calls.find((c) => c.init?.method === 'POST')!;
    expect(JSON.parse(String(post.init!.body))).toMatchObject({ parent_id: 'db1', kind: 'database' });
  });
});
