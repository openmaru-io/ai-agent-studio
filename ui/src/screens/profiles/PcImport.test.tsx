/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountScreen, stubApi } from '@/test/mountScreen';

import { PcImport } from './PcImport';
import type { Job } from './pcImportApi';

// 전역 matchMedia 흉내(test/setup)를 지우지 않도록 restoreAllMocks 대신 바꾼 것만 되돌린다
let restore: (() => void)[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  restore.forEach((f) => f());
  restore = [];
});

const JOB = (over: Partial<Job> = {}): Job => ({
  id: 'abc123def456',
  profile: 'main',
  state: 'uploaded',
  stage: 'check',
  name: 'hermes-default.tar.gz',
  size: 3 * 1024 * 1024,
  by_admin: false,
  owner: 'kim@x.com',
  summary: {
    ok: true,
    reason: '',
    root: 'default',
    counts: { skills: 4, cron: 7, sessions: 12, memories: 3, soul: true },
    os_only_skills: [],
    pc_path_jobs: [],
    env_refs: [],
    unpacked: 0,
    members: 0,
  },
  result: {},
  reason: '',
  error: '',
  created: '2026-10-17T01:00:00+00:00',
  updated: '2026-10-17T01:05:00+00:00',
  backup_days: 14,
  stages: ['import', 'config', 'replace', 'restart'],
  keeps: { env: 5, channels: ['telegram'], shared_with: ['ops', 'qa'] },
  ...over,
});

/** 시작·취소 경로가 기본 경로보다 먼저 맞도록 순서를 둔다(stubApi 는 앞에서부터 접두사로 찾는다) */
function mount(job: Job | null | (() => Job | null), extra: Record<string, unknown> = {}) {
  const fn = stubApi({
    ...extra,
    '/api/profile/pc-import/start': { job: JOB({ state: 'running', stage: 'import' }) },
    '/api/profile/pc-import/cancel': { ok: true },
    '/api/profile/pc-import': () => ({ job: typeof job === 'function' ? job() : job, profile: 'main', owner: 'kim@x.com' }),
  });
  const out = mountScreen(<PcImport pod="p1" profile="main" mcpLogins={2} />, '/profiles?name=main');
  return { fn, ...out };
}

class FakeXhr {
  static last: FakeXhr;
  upload: { onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void } = {};
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  status = 0;
  responseText = '';
  url = '';
  headers: Record<string, string> = {};
  open(_m: string, url: string) {
    this.url = url;
    FakeXhr.last = this;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  send() {}
  abort() {
    this.onabort?.();
  }
  respond(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
}

describe('PC 에서 가져오기 ① 내보내고 올리기(§10-2)', () => {
  it('브라우저로 OS 를 미리 고르고, 프로파일 이름 칸 값으로 명령과 파일 위치를 만들며, 복사 단추에 이름이 있다', async () => {
    const ua = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    restore.push(() => ua.mockRestore());
    const user = userEvent.setup();
    mount(null);
    expect(await screen.findByRole('tab', { name: '윈도우' })).toHaveAttribute('aria-selected', 'true');
    const field = screen.getByLabelText('PC 에서 내보낼 프로파일');
    await user.clear(field);
    await user.type(field, 'work');
    expect(screen.getByText('hermes profile export work -o $env:USERPROFILE\\hermes-work.tar.gz')).toBeInTheDocument();
    expect(screen.getByText('만들어질 파일: %USERPROFILE%\\hermes-work.tar.gz')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: '맥' }));
    const cmd = screen.getByText('hermes profile export work -o ~/hermes-work.tar.gz');
    expect(getComputedStyle(cmd).alignItems).toBe('center');                       // 44px 복사 단추 옆에서 글이 세로 가운데(OMAI-1444 실화면 지적)
    await user.click(screen.getByRole('button', { name: '명령 복사' }));
    expect(await navigator.clipboard.readText()).toBe('hermes profile export work -o ~/hermes-work.tar.gz');
    expect(await screen.findByText('복사했습니다', { selector: '[role=status]' })).toHaveAttribute('aria-live', 'polite');
    // 끌어다 놓기 영역 안에 키보드로 닿는 「파일 고르기」 단추
    expect(within(screen.getByTestId('pc-drop')).getByRole('button', { name: '파일 고르기' })).toBeInTheDocument();
    expect(screen.getByTestId('pc-file')).toHaveAttribute('accept', '.tar.gz,.tgz');
  });

  it('다른 형식을 놓으면 영역 아래에 안내하고 올리지 않는다', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    FakeXhr.last = undefined as unknown as FakeXhr;
    mount(null);
    const drop = await screen.findByTestId('pc-drop');
    fireEvent.drop(drop, { dataTransfer: { files: [new File(['x'], 'notes.zip')] } });
    expect(await screen.findByText('.tar.gz 묶음만 올릴 수 있습니다')).toBeInTheDocument();
    expect(FakeXhr.last).toBeUndefined();
  });

  it('올리는 동안 진행 막대와 「n MB / m MB」를 보이고, 검사를 통과하면 ② 확인으로 간다', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    mount(null);
    const input = await screen.findByTestId('pc-file');
    fireEvent.change(input, { target: { files: [new File(['x'.repeat(20)], 'hermes-default.tar.gz')] } });
    const xhr = FakeXhr.last;
    expect(xhr.url).toBe('/api/profile/pc-import?pod=p1&profile=main&name=hermes-default.tar.gz');
    expect(xhr.headers['X-AAS']).toBe('1');
    act(() => xhr.upload.onprogress?.({ lengthComputable: true, loaded: 1024 * 1024, total: 2 * 1024 * 1024 }));
    expect(screen.getByText('1.0 MB / 2.0 MB')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: '묶음을 올리는 중' })).toHaveAttribute('aria-valuenow', '50');
    act(() => xhr.respond(200, JOB()));
    expect(await screen.findByRole('heading', { name: '2/2 확인' })).toHaveFocus();         // 단계가 바뀌면 단계 제목에 커서
  });

  it('100MB 를 넘는 묶음은 올리지 않고 다시 묶는 명령과 한도 요청을 보인다', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    FakeXhr.last = undefined as unknown as FakeXhr;
    mount(null, { '/api/requests': { waiting: [] } });
    const input = await screen.findByTestId('pc-file');
    const big = new File(['x'], 'hermes-default.tar.gz');
    Object.defineProperty(big, 'size', { value: 101 * 1024 * 1024 });
    fireEvent.change(input, { target: { files: [big] } });
    expect(await screen.findByText('main 프로파일은 바뀌지 않았습니다.')).toBeInTheDocument();
    expect(screen.getByText(/sessions 폴더를 빼고/)).toBeInTheDocument();
    expect(screen.getByText(/hermes-default-small\.tar\.gz/)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '관리자에게 한도 요청' })).toBeInTheDocument();
    expect(FakeXhr.last).toBeUndefined();
  });
});

describe('PC 에서 가져오기 ② 확인(§10-2)', () => {
  it('바뀌는 것·그대로 남는 것 두 목록, 공용 스킬 영향, Danger 단추. 관리자 대행이면 주인 고지', async () => {
    mount(JOB({ by_admin: true }));
    expect(await screen.findByRole('heading', { name: '2/2 확인' })).toBeInTheDocument();
    const note = screen.getByText(/^프로파일의 성격·기억·스킬·예약 작업·대화 기록이 PC 묶음의 것으로 바뀝니다/);
    expect(note).toHaveTextContent(/^main 프로파일의 성격/);                           // 첫 낱말은 굵은 대상 이름(OMAI-1444 DD2)
    expect(within(note).getByText('main').tagName).toBe('STRONG');
    expect(screen.getByText('이 AI 에이전트 작업공간의 소유자는 kim@x.com입니다. 바꾸면 소유자에게 알림이 갑니다.')).toBeInTheDocument();
    const changes = screen.getByRole('list', { name: '바뀌는 것' });
    expect(within(changes).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'SOUL·MEMORY·USER',
      '기억 3개',
      '스킬 4개',
      '예약 작업 7개 (모두 일시정지로 들어옵니다)',
      '대화 기록 12개',
    ]);
    const keeps = screen.getByRole('list', { name: '그대로 남는 것' });
    expect(within(keeps).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'main 프로파일의 비밀값 5개 · 없는 키만 더합니다',
      'MCP 로그인 2개',
      '채널 연결(telegram)',
      '모델·게이트웨이·실행 위치 설정',
    ]);
    expect(screen.getByTestId('pc-columns')).toContainElement(changes);
    expect(screen.getByTestId('pc-columns')).toContainElement(keeps);
    expect(screen.getByText('같은 스킬을 쓰는 다른 프로파일 2개(ops, qa)도 바뀐 스킬을 봅니다.')).toBeInTheDocument();
    expect(screen.getByText('검사 통과')).toBeInTheDocument();
    // 단추 줄: 뒤로·취소(2단계) 다음 오른쪽 끝에 바꾸기(3단계 Danger)
    const replace = screen.getByRole('button', { name: 'main 내용 바꾸기' });
    const row = replace.closest('.MuiStack-root') as HTMLElement;
    expect(within(row).getAllByRole('button').map((b) => b.textContent)).toEqual(['뒤로', '취소', 'main 내용 바꾸기']);
    expect(getComputedStyle(replace).backgroundColor).toMatch(/218, 41, 28/);                 // tier3(Danger) 의 브랜드 빨강 바탕
  });

  it('주인이 직접 하면 주인 고지가 없고, 공용 스킬이 없으면 그 줄도 없다', async () => {
    mount(JOB({ keeps: { env: 0, channels: [], shared_with: [] } }));
    await screen.findByRole('heading', { name: '2/2 확인' });
    expect(screen.queryByText(/이 AI 에이전트의 주인은/)).not.toBeInTheDocument();
    expect(screen.queryByText(/같은 스킬을 쓰는/)).not.toBeInTheDocument();
    expect(screen.getByText('채널 연결')).toBeInTheDocument();
  });

  it('「main 내용 바꾸기」를 누르면 시작하고 진행 화면으로 간다. 열린 대화가 있으면 그 이유를 보인다', async () => {
    const user = userEvent.setup();
    const { fn } = mount(JOB());
    await user.click(await screen.findByRole('button', { name: 'main 내용 바꾸기' }));
    expect(await screen.findByRole('heading', { name: '가져오는 중' })).toBeInTheDocument();
    expect(fn.mock.calls.some((c) => String(c[0]) === '/api/profile/pc-import/start?pod=p1&id=abc123def456')).toBe(true);
  });

  it('시작이 409 open_chats 로 거절되면 대화를 닫으라는 문장을 보인다', async () => {
    const user = userEvent.setup();
    const fetchFn = vi.fn((url: string) => {
      if (url.startsWith('/api/profile/pc-import/start'))
        return Promise.resolve(new Response(JSON.stringify({ code: 'open_chats' }), { status: 409 }));
      if (url.startsWith('/api/profile/pc-import')) return Promise.resolve(new Response(JSON.stringify({ job: JOB(), profile: 'main', owner: '' })));
      return Promise.resolve(new Response(JSON.stringify({ auth_enabled: false, admin: true, user: null })));
    });
    vi.stubGlobal('fetch', fetchFn);
    mountScreen(<PcImport pod="p1" profile="main" mcpLogins={0} />, '/profiles');
    await user.click(await screen.findByRole('button', { name: 'main 내용 바꾸기' }));
    expect(await screen.findByText('이 프로파일과 열려 있는 대화를 닫고 다시 해 주세요.')).toBeInTheDocument();
  });

  it('「뒤로」는 올린 묶음을 취소하고 ① 로 돌아간다', async () => {
    const user = userEvent.setup();
    const { fn } = mount(JOB());
    await user.click(await screen.findByRole('button', { name: '뒤로' }));
    expect(await screen.findByRole('heading', { name: '1/2 내보내고 올리기' })).toBeInTheDocument();
    await waitFor(() => expect(fn.mock.calls.some((c) => String(c[0]).startsWith('/api/profile/pc-import/cancel?pod=p1&id=abc123def456'))).toBe(true));
  });
});

describe('PC 에서 가져오기 ③ 가져오는 중(§10-2, D6)', () => {
  it('replace 단계면 검사·가져오기는 끝남, 사본·바꾸기는 진행 중, 재시작은 대기이고 닫아도 계속된다고 알린다', async () => {
    mount(JOB({ state: 'running', stage: 'replace' }));
    expect(await screen.findByRole('heading', { name: '가져오는 중' })).toBeInTheDocument();
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('data-state'))).toEqual(['done', 'done', 'now', 'now', 'wait', 'wait']);   // 기본 스킬 맞추기·재시작
    expect(within(rows[0]).getByText('끝남')).toBeInTheDocument();                              // 색만이 아니라 글로도 상태
    expect(screen.getByText('지금 단계: 사본 · 바꾸기')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByText('서랍을 닫아도 계속됩니다. 끝나면 받은편지함으로 알립니다.')).toBeInTheDocument();
  });

  it('진행 중이면 다시 읽어 끝나면 결과로 바꾸고, 그 뒤로는 다시 읽지 않는다', async () => {
    let n = 0;
    const { fn } = mount(() => (++n < 2 ? JOB({ state: 'running', stage: 'restart' }) : JOB({ state: 'done', stage: 'cleanup', result: { done_at: '2026-10-17T01:10:00+00:00' } })));
    expect(await screen.findByRole('heading', { name: '가져오는 중' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '결과' }, { timeout: 6000 })).toBeInTheDocument();
    const reads = () => fn.mock.calls.filter((c) => String(c[0]).startsWith('/api/profile/pc-import?')).length;
    const after = reads();
    await new Promise((r) => setTimeout(r, 3000));
    expect(reads()).toBe(after);
  }, 15000);
});

describe('PC 에서 가져오기 실패·결과(§10-4, §10-2 ④)', () => {
  it('failed: main 은 그대로(warning) · 실패한 단계 · 다시 시도', async () => {
    const user = userEvent.setup();
    mount(JOB({ state: 'failed', stage: 'config', reason: 'import_failed', error: 'boom' }));
    const alert = (await screen.findByText('main 프로파일은 바뀌지 않았습니다.')).closest('.MuiAlert-root') as HTMLElement;
    expect(alert).toHaveClass('MuiAlert-standardWarning');
    expect(within(alert).getByText('실패한 단계: 가져오기')).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(await screen.findByRole('heading', { name: '1/2 내보내고 올리기' })).toBeInTheDocument();
  });

  it('rolled_back: 되돌림(warning) · 실패한 단계 · 다시 시도', async () => {
    mount(JOB({ state: 'rolled_back', stage: 'restart', reason: 'restart_failed' }));
    const alert = (await screen.findByText('가져오지 못해 main 프로파일을 원래대로 되돌렸습니다.')).closest('.MuiAlert-root') as HTMLElement;
    expect(alert).toHaveClass('MuiAlert-standardWarning');
    expect(within(alert).getByText('실패한 단계: 재시작')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeInTheDocument();
  });

  it('rollback_failed: 중간 상태(error) · 관리자에게 알림 · 단추 없음', async () => {
    mount(JOB({ state: 'rollback_failed', stage: 'replace', reason: 'replace_failed' }));
    const alert = (await screen.findByText('main 프로파일이 중간 상태일 수 있습니다.')).closest('.MuiAlert-root') as HTMLElement;
    expect(alert).toHaveClass('MuiAlert-standardError');
    expect(within(alert).getByText(/^관리자에게 알렸습니다 · 사본 /)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '다시 시도' })).not.toBeInTheDocument();
  });

  it('옛 규칙으로 거절된 기록은 「다시 올리면 걸러서 받습니다」와 「다른 묶음 올리기」(R3)', async () => {
    mount(JOB({ state: 'rejected', summary: { ...JOB().summary, ok: false, reason: 'credential' } }));
    expect(await screen.findByText('예전 규칙으로 거절된 묶음입니다. 같은 파일을 다시 올리면 걸러서 받습니다.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '다른 묶음 올리기' })).toBeInTheDocument();
  });

  it('저장 실패는 다시 올리라고, 내용이 없으면 묶음 안 이름 3개를 보인다(R2·DD17)', async () => {
    mount(JOB({ state: 'rejected', summary: { ...JOB().summary, ok: false, reason: 'store_failed' } }));
    expect(await screen.findByText('AI 에이전트 작업공간에 묶음을 저장하지 못했습니다. 잠시 뒤 같은 파일을 다시 올려 주세요.')).toBeInTheDocument();
  });

  it('no_content 는 전용 문구와 최상위 이름', async () => {
    mount(JOB({ state: 'rejected', summary: { ...JOB().summary, ok: false, reason: 'no_content', top_names: ['logs', 'state.db', 'workspace'] } }));
    expect(await screen.findByText(/묶음 안: logs · state\.db · workspace$/)).toBeInTheDocument();
  });

  it('결과: 성공 한 줄과 「아직 할 일 N개」, 항목마다 해당 탭 링크, 보관 기간', async () => {
    mount(
      JOB({
        state: 'done',
        stage: 'cleanup',
        result: { done_at: '2026-10-17T01:10:00+00:00', secrets_needed: ['OPENAI_API_KEY', 'SLACK_BOT_TOKEN'], paused_cron: 3, pc_path_jobs: ['backup'], os_only_skills: ['imessage'], mcp_relogin: 0 },
      }),
      { '/api/requests': { waiting: [] } }
    );
    expect(await screen.findByText(/^PC 의 Hermes 를 main 프로파일에 넣었습니다 · /)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '아직 할 일 2개' })).toBeInTheDocument();
    expect(screen.getByText('비밀값 2개 필요')).toBeInTheDocument();
    expect(screen.getByText('OPENAI_API_KEY, SLACK_BOT_TOKEN')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '비밀값(.env) 탭' })).toHaveAttribute('href', '/profiles?name=main&pane=env');
    expect(screen.getByRole('link', { name: '예약 작업 탭' })).toHaveAttribute('href', '/profiles?name=main&pane=cron');
    expect(screen.queryByText(/^다시 로그인할 MCP \d+개$/)).not.toBeInTheDocument();          // 0개인 할 일은 줄을 두지 않는다
    expect(screen.getByText('PC 경로를 쓰는 작업 1개: backup')).toBeInTheDocument();
    expect(screen.getByText('컨테이너에서 읽히지 않는 스킬 1개')).toBeInTheDocument();
    expect(screen.getByText('바꾸기 전 내용은 14일 동안 보관됩니다. 되돌리려면 관리자에게 요청하세요.')).toBeInTheDocument();
  });
});

// ---- 2026-10-22-003: 걸러서 받기·비밀 옮기기(DD1~DD23) ----------------------------------------------------------
const PLAN = {
  known: true,
  files_replace: ['google_token.json'],
  files_replace_count: 1,
  files_new: ['google_client_secret.json', 'mcp-tokens/a.json', 'mcp-tokens/b.json'],
  files_new_count: 3,
  env_add: ['SERP_API_KEY'],
  env_add_count: 1,
  env_exists: ['EXISTING_KEY'],
  env_exists_count: 1,
  env_blocked: ['OPENAI_API_KEY'],
  env_blocked_count: 1,
  mcp_files: 2,
  channel_files: 0,
};

const FILTERED = (over: Partial<Job['summary']> = {}, keeps: Partial<NonNullable<Job['keeps']>> = {}): Job =>
  JOB({
    size: 90 * 1024 * 1024,
    summary: {
      ...JOB().summary,
      kept: 399,
      kept_size: 1024 * 1024,
      secrets_enabled: true,
      secrets_bundle: true,
      secrets_supported: true,
      secrets: {
        files: ['google_client_secret.json', 'google_token.json', 'mcp-tokens/a.json', 'mcp-tokens/b.json'],
        files_count: 4,
        env_keys: ['EXISTING_KEY', 'OPENAI_API_KEY', 'SERP_API_KEY'],
        env_keys_count: 3,
        env_unreadable: [],
        size: 1290,
        model_files: ['auth.json'],
        mcp_files: 2,
        channel_files: 0,
      },
      dropped: {
        links: 15,
        link_skills: ['direct', 'google-workspace', 'gstack', 'yjops'],
        link_skills_count: 4,
        credential: 8268,
        credential_groups: [
          { name: '.env.bak-1', files: 1 },
          { name: 'auth.json', files: 1 },
          { name: 'home', files: 8260 },
        ],
        credential_groups_count: 3,
        other: 308,
        other_groups: [
          { name: 'logs', files: 41 },
          { name: 'workspace', files: 1 },
        ],
        other_groups_count: 56,
        secrets_off: 0,
        secrets_off_names: [],
        secrets_off_count: 0,
      },
      ...over,
    },
    stages: ['import', 'config', 'replace', 'secrets', 'env', 'restart'],
    keeps: { env: 7, channels: ['telegram'], shared_with: [], skills_main: 6, secrets_plan: PLAN, ...keeps },
  });

describe('PC 에서 가져오기 ② 확인 — 걸러서 받기·옮기는 비밀(2026-10-22-003 §4-7)', () => {
  it('경고 문장·걸러서 받음·스킬 감소·옮기는 비밀·가져오지 않는 것 순서로 보인다(DD1~DD7·DD18·DD19)', async () => {
    const user = userEvent.setup();
    mount(FILTERED(), { '/api/requests': { waiting: [] } });
    await screen.findByRole('heading', { name: '2/2 확인' });
    expect(screen.getByText(/인증 파일 4개가 묶음의 것으로 바뀝니다/)).toBeInTheDocument();
    expect(screen.getByText('걸러서 받음')).toBeInTheDocument();
    expect(screen.getByText('90 MB → 남김 1 MB')).toBeInTheDocument();
    const changes = screen.getByRole('list', { name: '바뀌는 것' });
    expect(within(changes).getByText(/스킬 지금 6개 → 4개/)).toBeInTheDocument();
    expect(within(changes).getByText('main 프로파일에만 있는 스킬은 없어집니다')).toBeInTheDocument();
    const keeps = screen.getByRole('list', { name: '그대로 남는 것' });
    expect(within(keeps).queryByText(/MCP 로그인/)).not.toBeInTheDocument();          // 비밀 묶음에 mcp-tokens/ 가 있으면 옮기는 쪽으로(DD2)
    const moving = screen.getByRole('list', { name: '옮기는 비밀' });
    expect(within(moving).getByText(/인증 파일: 바뀜 1 · 새로 3/)).toBeInTheDocument();
    expect(within(moving).getByText('MCP 로그인 파일 2개')).toBeInTheDocument();
    expect(within(moving).getByText(/비밀값: 새로 넣음 1 · main 프로파일에 있어 건너뜀 1 · 넣을 수 없음 1/)).toBeInTheDocument();
    // 처음 3개만, 「외 1개」를 누르면 모두
    const more = within(moving).getByRole('button', { name: '외 1개' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    await user.click(more);
    expect(within(moving).getByRole('button', { name: '접기' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('모델 연결 파일(auth.json 등)은 가져오지 않습니다. 필요하면 관리자에게 요청하세요.')).toBeInTheDocument();
    const fold = screen.getByRole('button', { name: '가져오지 않는 것 · 링크 스킬 4개 · 비밀 정보 3곳 · 그 밖 56곳' });
    expect(fold).toHaveAttribute('aria-expanded', 'false');                              // 기본 닫힘
    await user.click(fold);
    expect(screen.getByText(/외 54개\(이름 생략\)/)).toBeInTheDocument();             // 서버가 담은 이름(2개)보다 많은 수
    expect(screen.getByText('묶음에 내용이 없어 가져오지 않습니다. 마켓이나 스킬 올리기로 따로 넣으세요.')).toBeInTheDocument();
  });

  it('비밀 묶음이 없으면 「옮기는 비밀」이 없고 경고는 지금 문장(DD13)', async () => {
    mount(JOB());
    await screen.findByRole('heading', { name: '2/2 확인' });
    expect(screen.queryByRole('list', { name: '옮기는 비밀' })).not.toBeInTheDocument();
    expect(screen.getByText(/대화 기록이 PC 묶음의 것으로 바뀝니다/)).toBeInTheDocument();
  });

  it('http 판정이면 info 와 빠지는 비밀 이름(DD12)', async () => {
    mount(
      FILTERED({
        secrets_enabled: false,
        secrets_bundle: false,
        dropped: { ...FILTERED().summary.dropped!, secrets_off: 3, secrets_off_names: ['.env', 'google_token.json', 'mcp-tokens', 'vault'], secrets_off_count: 4 },
      })
    );
    expect(await screen.findByText(/암호화된 주소\(https\)에서 올리면/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '외 1개' })).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: '옮기는 비밀' })).not.toBeInTheDocument();
    expect(screen.getByText(/대화 기록이 PC 묶음의 것으로 바뀝니다/)).toBeInTheDocument();     // 경고는 지금 문장
  });

  it('오퍼레이터가 지원하지 않으면 info(DD8)', async () => {
    mount(FILTERED({ secrets_supported: false }), { '/api/requests': { waiting: [] } });
    expect(await screen.findByText('이번에는 비밀값·인증 파일을 옮길 수 없습니다. 내용만 가져옵니다.')).toBeInTheDocument();
  });

  it('미리 나누지 못하면 숫자 대신 info 와 묶음 쪽 전체 수(R23)', async () => {
    mount(FILTERED({}, { secrets_plan: { ...PLAN, known: false } }));
    expect(await screen.findByText(/main 프로파일의 비밀값과 파일을 확인하지 못했습니다/)).toBeInTheDocument();
    expect(screen.getByText('인증 파일 4개 · 비밀값 3개')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: '옮기는 비밀' })).not.toBeInTheDocument();
  });
});

describe('PC 에서 가져오기 ③·④ — 비밀 단계와 결과(DD6·DD9·DD10·DD14~DD16)', () => {
  it('비밀 묶음이 있으면 진행 단계가 여덟 줄(기본 스킬 맞추기 포함)', async () => {
    mount(JOB({ ...FILTERED(), state: 'running', stage: 'env' }));
    await screen.findByRole('heading', { name: '가져오는 중' });
    expect(screen.getAllByRole('listitem').map((r) => r.getAttribute('data-state'))).toEqual(['done', 'done', 'done', 'done', 'done', 'now', 'wait', 'wait']);
    expect(screen.getByText('지금 단계: 비밀값')).toBeInTheDocument();
  });

  it('일부 실패면 앰버 첫 줄, 할 일 다섯 종류, 옮긴 비밀과 확인 뒤 바뀜, 건너뛴 비밀값', async () => {
    const user = userEvent.setup();
    mount(
      JOB({
        ...FILTERED(),
        state: 'done',
        stage: 'cleanup',
        result: {
          done_at: '2026-10-22T01:10:00+00:00',
          secrets_needed: [],
          env_failed: [{ name: 'SERP_API_KEY', reason: 'HermesError' }],
          env_added: ['SEARXNG_URL'],
          env_skipped: [
            { name: 'EXISTING_KEY', reason: 'exists' },
            { name: 'OPENAI_API_KEY', reason: 'blocked' },
          ],
          secrets_replaced: ['google_token.json'],
          secrets_added: ['google_client_secret.json'],
          link_skills: ['gstack'],
          paused_cron: 2,
          mcp_relogin: 1,
          changed_after_confirm: true,
        },
      }),
      { '/api/requests': { waiting: [] } }
    );
    const first = (await screen.findByText('PC 의 Hermes 를 main 프로파일에 넣었습니다 · 비밀값 1개는 넣지 못했습니다')).closest('.MuiAlert-root') as HTMLElement;
    expect(first).toHaveClass('MuiAlert-standardWarning');
    expect(screen.getByRole('heading', { name: '아직 할 일 4개' })).toBeInTheDocument();
    expect(screen.getByText('비밀값 1개 필요')).toBeInTheDocument();
    expect(screen.getByText('따로 넣을 스킬 1개')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '스킬 탭' })).toHaveAttribute('href', '/profiles?name=main&pane=skills');
    const moved = screen.getByRole('list', { name: '옮긴 비밀' });
    expect(within(moved).getByText(/^바꾼 인증 파일: google/)).toBeInTheDocument();
    expect(within(moved).getByText(/^더한 인증 파일: google/)).toBeInTheDocument();
    expect(within(moved).getByText('넣은 비밀값: SEARXNG_URL')).toBeInTheDocument();
    expect(screen.getByText('확인 뒤 바뀜')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '건너뛴 비밀값 2개' }));
    expect(screen.getByText('main 프로파일에 있음')).toBeInTheDocument();
    expect(screen.getByText('채널 토큰은 메신저 연결 화면에서, 모델 키는 관리자가 넣습니다.')).toBeInTheDocument();
    expect(screen.getByText('바꾸기 전 내용과 인증 파일은 14일 동안 보관됩니다.')).toBeInTheDocument();
  });

  it('미지원이면 「옮기지 못했습니다」 할 일(R22)', async () => {
    mount(JOB({ ...FILTERED(), state: 'done', stage: 'cleanup', result: { secrets_unsupported: true } }), { '/api/requests': { waiting: [] } });
    expect(await screen.findByText('비밀값·인증 파일을 옮기지 못했습니다')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: '옮긴 비밀' })).not.toBeInTheDocument();
  });

  it('바꾼 파일 목록을 읽지 못하면 그 문장(DD16)', async () => {
    mount(JOB({ ...FILTERED(), state: 'done', stage: 'cleanup', result: { secrets_list_unreadable: true } }), { '/api/requests': { waiting: [] } });
    expect(await screen.findByText('바꾼 파일 목록을 읽지 못했습니다. 바꾸기 전 파일은 14일 동안 보관됩니다.')).toBeInTheDocument();
  });

  it('비밀 단계 뒤 되돌림은 한 줄을 더하고 실패한 단계 이름을 일곱 줄 기준으로', async () => {
    mount(JOB({ ...FILTERED(), state: 'rolled_back', stage: 'secrets', reason: 'secrets_failed', result: { secrets_rolled_back: true } }));
    expect(await screen.findByText('실패한 단계: 인증 파일')).toBeInTheDocument();
    expect(screen.getByText('인증 파일과 비밀값도 원래대로 되돌렸습니다.')).toBeInTheDocument();
  });
});

// ---- OMAI-1511: 내보내기 때 가려진 기본 스킬 되돌리기(스펙 2026-10-27-011 디자인 D3·D11·D12·D15) ------------------------------
describe('PC 에서 가져오기 ④ — 기본 스킬 되돌리기 결과', () => {
  const done = (result: Record<string, unknown>) =>
    JOB({ state: 'done', stage: 'cleanup', result: { done_at: '2026-10-27T01:10:00+00:00', secrets_needed: [], ...result } as Job['result'] });

  it('되돌린 수는 성공 알림 아래 회색 한 줄, 가려졌을 수 있는 목록은 할 일이고 이름은 그 사본을 연다', async () => {
    const kept = Array.from({ length: 12 }, (_, i) => `profiles/main/skills/productivity/s${i}`);
    mount(done({ bundled_repaired_n: 3, bundled_repaired: ['profiles/main/skills/productivity/airtable'], bundled_kept: kept }));
    expect(await screen.findByText('기본 스킬 3개를 서버 기본 버전으로 되돌렸습니다.')).toBeInTheDocument();
    expect(screen.getByText(/내보낼 때 가려졌을 수 있는 기본 스킬 12개/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 's0' })).toHaveAttribute('href', '/skills?tab=all&open=main%3Aprofiles%2Fmain%2Fskills%2Fproductivity%2Fs0');
    expect(screen.queryByRole('link', { name: 's10' })).toBeNull();                   // 앞 10개만
    expect(screen.getByText('외 2개')).toBeInTheDocument();
  });

  it('되돌린 것도 남긴 것도 없으면 줄이 없다', async () => {
    mount(done({ bundled_repaired_n: 0, bundled_repaired: [], bundled_kept: [] }));
    await screen.findByText(/넣었습니다/);
    expect(screen.queryByTestId('pc-repair-lines')).toBeNull();
    expect(screen.queryByText(/가려졌을 수 있는/)).toBeNull();
  });

  it('미지원·실패·목록 못 읽음은 각각 사실대로, 호박색 할 일이 아니라 회색 줄', async () => {
    mount(done({ bundled_repair_unsupported: true }));
    expect(await screen.findByText(/아직 지원하지 않습니다\. 관리자가 업데이트하면 자동으로 되돌립니다/)).toBeInTheDocument();
    cleanup();
    mount(done({ bundled_repair_error: '[TIMEOUT] x' }));
    expect(await screen.findByText(/되돌리기를 하지 못했습니다\. 자동으로 다시 시도합니다/)).toBeInTheDocument();
    cleanup();
    mount(done({ bundled_repaired_n: 2, bundled_list_unreadable: true }));
    expect(await screen.findByText('기본 스킬 2개를 서버 기본 버전으로 되돌렸습니다.')).toBeInTheDocument();   // 수는 작업 결과로 안다
    expect(screen.getByText(/이름 목록을 읽지 못했습니다/)).toBeInTheDocument();
  });
});

// ---- OMAI-1444: main 이 아닌 프로파일(스펙 pc-import-any-profile §10) -----------------------------------------------
/** 대상 이름과 상태 응답을 정해 그린다. status 가 함수면 읽을 때마다 부른다(다시 읽기 시험) */
function mountFor(profile: string, status: Record<string, unknown> | (() => Record<string, unknown>), extra: Record<string, unknown> = {}) {
  const fn = stubApi({
    ...extra,
    '/api/profile/pc-import/start': { job: JOB({ profile, state: 'running', stage: 'import' }) },
    '/api/profile/pc-import/cancel': { ok: true },
    '/api/profile/pc-import': () => ({ job: null, profile, owner: '', ...(typeof status === 'function' ? status() : status) }),
  });
  const out = mountScreen(<PcImport pod="p1" profile={profile} main={profile === 'main'} mcpLogins={0} />, `/profiles?name=${profile}`);
  return { fn, ...out };
}

describe('PC 에서 가져오기 — main 이 아닌 대상(OMAI-1444)', () => {
  it('올리기는 그 프로파일로 보내고, PC 쪽 프로파일 칸은 그 이름으로 채운다(DD14)', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    mountFor('research', {});
    expect(await screen.findByLabelText('PC 에서 내보낼 프로파일')).toHaveValue('research');
    expect(screen.getByText(/^hermes profile export research -o /)).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('pc-file'), { target: { files: [new File(['x'], 'hermes-research.tar.gz')] } });
    expect(FakeXhr.last.url).toBe('/api/profile/pc-import?pod=p1&profile=research&name=hermes-research.tar.gz');
  });

  it('확인 단계: 경고 첫 낱말은 굵은 대상 이름, 단추는 「{name} 내용 바꾸기」(DD2)', async () => {
    mountFor('research', { job: JOB({ profile: 'research' }) });
    const name = await screen.findByText('research', { selector: 'strong' });
    expect(name.parentElement).toHaveTextContent(/^research 프로파일의 성격·기억·스킬/);
    expect(screen.getByRole('button', { name: 'research 내용 바꾸기' })).toHaveTextContent('research 내용 바꾸기');
    expect(screen.getByRole('list', { name: '그대로 남는 것' })).toHaveTextContent('research 프로파일의 비밀값 5개');
  });

  it('이름이 24자를 넘으면 단추에서 말줄임표로 줄이고, 전체 이름은 읽는 이름과 툴팁에 둔다(DD2)', async () => {
    const user = userEvent.setup();
    const long = 'research-team-quarterly-report';
    mountFor(long, { job: JOB({ profile: long }) });
    const btn = await screen.findByRole('button', { name: `${long} 내용 바꾸기` });
    expect(btn).toHaveTextContent('research-team-quarterly… 내용 바꾸기');
    await user.hover(btn);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(`${long} 내용 바꾸기`);
  });

  it('옮기지 않는 채널 연결 항목은 「그대로 남는 것」에 이름과 한 줄, 실제로 옮기는 채널(Google Chat)은 「옮기는 비밀」에 남는다(DD3·커밋 전 리뷰 3·4)', async () => {
    const f = FILTERED({
      secrets: { ...FILTERED().summary.secrets!, files: [...FILTERED().summary.secrets!.files, 'slack_tokens.json'], files_count: 5, channel_files: 1 },
      channel_files_skipped: ['slack_tokens.json', 'pairing'],
    });
    mountFor('research', { job: { ...f, profile: 'research' } }, { '/api/requests': { waiting: [] } });
    await screen.findByRole('heading', { name: '2/2 확인' });
    expect(screen.getByText(/인증 파일 4개가 묶음의 것으로 바뀝니다/)).toBeInTheDocument();
    const keeps = screen.getByRole('list', { name: '그대로 남는 것' });
    expect(within(keeps).getByText('채널 연결 — PC 의 채널 연결 항목 2개(slack_tokens.json, pairing)는 옮기지 않습니다. 이 프로파일에서 다시 연결하세요')).toBeInTheDocument();
    expect(within(keeps).queryByText('채널 연결(telegram)')).not.toBeInTheDocument();   // 옮기는 채널이 있으면 지금처럼 「옮기는 비밀」 쪽에 보인다
    expect(within(screen.getByRole('list', { name: '옮기는 비밀' })).getByText(/채널 연결 파일/)).toBeInTheDocument();   // 서버는 건너뛴 채널을 channel_files 에 넣지 않는다
  });

  it('keeps 가 비어 있어도(배포 전 기록·저장 전) 확인 화면이 그려진다(커밋 전 리뷰 1)', async () => {
    mount(JOB({ keeps: {} as NonNullable<Job['keeps']> }));
    expect(await screen.findByRole('heading', { name: '2/2 확인' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '취소' })).toBeEnabled();
  });

  it('결과의 「아직 할 일」에 「다시 연결할 채널 n개」와 그 프로파일의 채널 탭 링크(DD3)', async () => {
    mountFor('research', { job: JOB({ profile: 'research', state: 'done', stage: 'cleanup', result: { channels_to_reconnect: 2 } }) }, { '/api/requests': { waiting: [] } });
    expect(await screen.findByText(/^PC 의 Hermes 를 research 프로파일에 넣었습니다 · /)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '아직 할 일 1개' })).toBeInTheDocument();
    expect(screen.getByText('다시 연결할 채널 연결 항목 2개')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '채널 탭' })).toHaveAttribute('href', '/profiles?name=research&pane=channels');
  });

  it('다른 프로파일이 쓰는 게이트웨이를 다시 시작하면 확인 단계에 안내 한 줄, 다른 프로파일이 없으면 없다(DD10)', async () => {
    const { unmount } = mountFor('research', { job: JOB({ profile: 'research', keeps: { env: 0, channels: [], shared_with: [], others: ['main', 'ops'] } }) });
    expect(await screen.findByText('끝에 AI 에이전트 작업공간의 게이트웨이를 다시 시작합니다. 다른 프로파일의 채널·예약 작업도 잠깐 멈춥니다.')).toBeInTheDocument();
    unmount();
    mountFor('research', { job: JOB({ profile: 'research', keeps: { env: 0, channels: [], shared_with: [], others: [] } }) });
    await screen.findByRole('heading', { name: '2/2 확인' });
    expect(screen.queryByText(/게이트웨이를 다시 시작합니다/)).not.toBeInTheDocument();
  });
});

describe('PC 에서 가져오기 — 다른 프로파일이 가져오는 중(OMAI-1444 DD6·R3·OV3)', () => {
  it('서랍 위 안내와 그 프로파일 링크, 「파일 고르기」는 Tab 으로 닿되 막히고 놓아도 올리지 않는다. 끝나면 다시 읽어 풀고 알린다', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    FakeXhr.last = undefined as unknown as FakeXhr;
    let busy = 'main';
    mountFor('research', () => (busy ? { busy_profile: busy } : {}));
    const alert = (await screen.findByText(/프로파일에 가져오는 중입니다\. 끝난 뒤 다시 하세요\./)).closest('.MuiAlert-root') as HTMLElement;
    expect(alert).toHaveClass('MuiAlert-standardInfo');
    expect(alert).toHaveTextContent('main 프로파일에 가져오는 중입니다. 끝난 뒤 다시 하세요.');
    expect(within(alert).getByRole('link', { name: 'main' })).toHaveAttribute('href', '/profiles?name=main');
    const pick = screen.getByRole('button', { name: '파일 고르기' });
    expect(pick).toHaveAttribute('aria-disabled', 'true');
    expect(pick).not.toBeDisabled();                                                     // Tab 으로 닿는다
    expect(pick).toHaveAccessibleDescription('다른 프로파일에 가져오는 중입니다');
    fireEvent.drop(screen.getByTestId('pc-drop'), { dataTransfer: { files: [new File(['x'], 'hermes-research.tar.gz')] } });
    expect(FakeXhr.last).toBeUndefined();
    busy = '';                                                                           // main 가져오기가 끝났다 → 2.5초 뒤 다시 읽는다
    await waitFor(() => expect(screen.getByText('이제 가져올 수 있습니다')).toHaveAttribute('role', 'status'), { timeout: 4000 });
    expect(screen.getByRole('button', { name: '파일 고르기' })).not.toHaveAttribute('aria-disabled');
    expect(screen.queryByText(/끝난 뒤 다시 하세요/)).not.toBeInTheDocument();
  });

  it('확인 단계에서는 같은 안내를 단추 위에 두고 「{name} 내용 바꾸기」를 막는다', async () => {
    const user = userEvent.setup();
    const { fn } = mountFor('research', { job: JOB({ profile: 'research' }), busy_profile: 'main' });
    const replace = await screen.findByRole('button', { name: 'research 내용 바꾸기' });
    expect(replace).toHaveAttribute('aria-disabled', 'true');
    expect(replace).toHaveAccessibleDescription('다른 프로파일에 가져오는 중입니다');
    expect(screen.getAllByText(/프로파일에 가져오는 중입니다\. 끝난 뒤 다시 하세요/)).toHaveLength(2);    // 서랍 위·단추 위
    await user.click(replace);
    expect(fn.mock.calls.some((c) => String(c[0]).startsWith('/api/profile/pc-import/start'))).toBe(false);
  });

  it('올리기가 409 busy_import(profile) 로 거절되면 상태를 기다리지 않고 그 이름으로 안내한다', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const { fn } = mountFor('research', {});
    fireEvent.change(await screen.findByTestId('pc-file'), { target: { files: [new File(['x'], 'hermes-research.tar.gz')] } });
    // 그 뒤의 상태 읽기는 끝나지 않게 둔다 — 응답을 기다리지 않고 409 의 profile 로 바로 막는지 본다
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => (url.startsWith('/api/profile/pc-import') ? new Promise(() => {}) : fn(url, init))));
    act(() => FakeXhr.last.respond(409, { code: 'busy_import', profile: 'ops' }));
    expect(await screen.findByText('ops')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'ops' })).toHaveAttribute('href', '/profiles?name=ops');
  });
});

describe('PC 에서 가져오기 — 새 오류 문구(OMAI-1444 DD9)', () => {
  it('no_profile 은 목록을 새로 고치라는 문구와 「서랍 닫기」', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    mountFor('gone', {});
    fireEvent.change(await screen.findByTestId('pc-file'), { target: { files: [new File(['x'], 'hermes-gone.tar.gz')] } });
    act(() => FakeXhr.last.respond(404, { code: 'no_profile' }));
    const alert = (await screen.findByText('이 프로파일을 찾을 수 없습니다. 목록을 새로 고쳐 주세요.')).closest('.MuiAlert-root') as HTMLElement;
    expect(within(alert).getByRole('button', { name: '서랍 닫기' })).toBeInTheDocument();
  });

  it('agent_unreachable 은 「다시 하기」로 같은 파일을 다시 올린다', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    mountFor('research', {});
    fireEvent.change(await screen.findByTestId('pc-file'), { target: { files: [new File(['x'], 'hermes-research.tar.gz')] } });
    const first = FakeXhr.last;
    act(() => first.respond(502, { code: 'agent_unreachable' }));
    expect(await screen.findByText('AI 에이전트 작업공간이 응답하지 않습니다. 잠시 뒤 다시 하세요.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '다시 하기' }));
    expect(FakeXhr.last).not.toBe(first);
    expect(FakeXhr.last.url).toBe('/api/profile/pc-import?pod=p1&profile=research&name=hermes-research.tar.gz');
  });

  it('상태 읽기가 root_profile·bad_profile 로 거절되면 그 문구', async () => {
    const fetchFn = vi.fn((url: string) =>
      url.startsWith('/api/profile/pc-import')
        ? Promise.resolve(new Response(JSON.stringify({ code: 'root_profile' }), { status: 409 }))
        : Promise.resolve(new Response(JSON.stringify({ auth_enabled: false, admin: true, user: null })))
    );
    vi.stubGlobal('fetch', fetchFn);
    mountScreen(<PcImport pod="p1" profile="default" main={false} mcpLogins={0} />, '/profiles');
    expect(await screen.findByText('기본 프로파일에는 가져올 수 없습니다.')).toBeInTheDocument();
  });
});
