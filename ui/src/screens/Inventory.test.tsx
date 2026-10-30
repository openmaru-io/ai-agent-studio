/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { screen, waitFor, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { watchChatPopup } from '@/test/chatPopup';
import { ME_ADMIN, ME_USER, mountScreen, postedTo, rowByName, stubApi } from '@/test/mountScreen';
import { listAgents } from '@/test/pickAgent';

import { Credentials, Libraries, Tools } from './Inventory';

const CREDS = {
  totals: { items: 3, global: 1, profile: 2, expiring: 1, empty: 1, backups: 0, shared_groups: 1, registered: 1 },
  items: [
    {
      id: 'c1',
      name: 'OPENAI_API_KEY',
      scope: '프로파일',
      profile: 'ma',
      set: true,
      flags: ['만료됨'],
      interface: 'REST',
      target: 'openai',
      location: '/data/profiles/ma/.env',
      source: '.env',
      expires: '2026-09-30T00:00:00Z',
      used_count: 2,
      used_by: ['스킬 report/x', '크론 ma/daily'],
      shared: 2,
    },
    {
      id: 'c2',
      name: 'SLACK_TOKEN',
      scope: '전역',
      set: false,
      flags: ['비어 있음'],
      interface: 'WebSocket',
      location: '/data/.env',
      source: '.env',
      used_count: 0,
      used_by: [],
    },
    {
      id: 'c3',
      name: 'OK_KEY',
      scope: '전역',
      set: true,
      flags: [],
      interface: 'MCP',
      location: 'docker/compose.yml',
      source: 'compose',
      used_count: 0,
      used_by: [],
      reg: { status: 'registered', owner: 'kim', updated: '2026-10-01T00:00:00Z', note: '**중요** 키' },
    },
  ],
};
const TOOLS = {
  totals: { items: 1, global: 0, profile: 1, languages: { python: 1 }, unreferenced: 1, registered: 0 },
  items: [
    {
      id: 't1',
      name: 'sync.py',
      scope: '프로파일',
      profile: 'ma',
      language: 'python',
      kind: 'script',
      path: 'profiles/ma/scripts/sync.py',
      modified: '2026-10-02T00:00:00Z',
      summary: '동기화',
      imports: ['requests'],
      flags: ['부르는 곳을 찾지 못함'],
      used_count: 0,
      used_by: [],
    },
  ],
};
const LIBS = {
  totals: { items: 1, envs: 1, global: 1, profile: 0, used: 1, version_conflicts: 0, registered: 0 },
  items: [
    {
      id: 'l1',
      name: 'requests',
      version: '2.32',
      scope: '전역',
      kind: 'python',
      env: 'image',
      flags: [],
      used_count: 1,
      used_by: ['스크립트 sync.py'],
    },
  ],
  envs: [{ env: 'image', kind: 'python', scope: '전역', packages: 120, path: '/usr/lib', note: '스냅샷' }],
};

afterEach(() => vi.unstubAllGlobals());

/** API 키·토큰은 처음에 프로파일 하나로 연다(스펙 2026-10-28-006). 표 내용을 보는 시험은 「전체 프로파일」(=예전 화면)로 연다 */
const allProfiles = (initial: string) =>
  initial.startsWith('/credentials') && !/[?&]profile=/.test(initial) ? initial + (initial.includes('?') ? '&' : '?') + 'profile=*' : initial;

function mount(ui: ReactElement, initial: string) {
  const fn = stubApi({
    '/api/registry': (u: string) => ({
      reg: { status: 'review', owner: 'park', updated: '2026-10-10T00:00:00Z', note: u },
    }),
    '/api/credentials': CREDS,
    '/api/tools': TOOLS,
    '/api/libraries': LIBS,
    '/api/users': { users: [{ email: 'park@x.com', name: '박민수', department: '개발팀', enabled: true }] },
  });
  mountScreen(ui, allProfiles(initial));
  return fn;
}

describe('Inventory: 자격증명', () => {
  it('첫 탭은 전체, 그다음이 확인할 것이다', async () => {
    mount(<Credentials />, '/credentials');
    await screen.findByRole('tablist');
    const names = screen.getAllByRole('tab').map((t) => t.getAttribute('aria-label')?.split(', ')[0]);
    expect(names.slice(0, 2)).toEqual(['전체', '확인할 것']);
    expect(screen.getAllByRole('tab')[0]).toHaveAttribute('aria-selected', 'true'); // 주소에 tab 이 없으면 전체
  });

  it('MCP OAuth 토큰 행은 「비어 있음」 대신 「로그인 필요」를 보이고 빈 값 수에 넣지 않는다(스펙 2026-10-16-010 T7)', async () => {
    const items = [
      { id: 'o1', name: 'jira (OAuth)', scope: '프로파일', profile: 'main', set: false, oauth: true, flags: ['로그인 필요'], interface: 'MCP: jira', location: 'profiles/main/mcp-tokens/jira.json', source: 'MCP OAuth 토큰', used_count: 0, used_by: [] },
      { id: 'o2', name: 'wiki (OAuth)', scope: '프로파일', profile: 'main', set: true, oauth: true, flags: [], interface: 'MCP: wiki', location: 'profiles/main/mcp-tokens/wiki.json', source: 'MCP OAuth 토큰', used_count: 0, used_by: [] },
    ];
    stubApi({ '/api/credentials': { ...CREDS, items } });
    mountScreen(<Credentials />, '/credentials?profile=*');
    const row = await rowByName(/jira \(OAuth\)/);
    expect(within(row).getByText('로그인 필요')).toBeInTheDocument();
    expect(within(row).queryByText('비어 있음')).not.toBeInTheDocument();
    let card: HTMLElement | null = screen.getByText('빈 값');
    while (card && !/^\d/.test(card.textContent ?? '')) card = card.parentElement;     // 숫자로 시작하는 카드까지 올라간다
    expect(card?.textContent).toMatch(/^0빈 값/);
  });

  it('카드·확인할 것 탭(플래그가 있는 것)·행 태그를 보인다', async () => {
    mount(<Credentials />, '/credentials?tab=flag');
    expect(await screen.findByText('OPENAI_API_KEY')).toBeInTheDocument();
    expect(screen.getByText('SLACK_TOKEN')).toBeInTheDocument();
    expect(screen.queryByText('OK_KEY')).not.toBeInTheDocument();
    expect(screen.getByText('만료됨')).toBeInTheDocument();
    expect(screen.getByText('비어 있음')).toBeInTheDocument();
    // 두 줄 목록의 「만료 …」·「쓰는 곳 N」 칩은 열이 됐다(OMAI-1127)
    const row = await rowByName(/OPENAI_API_KEY/);
    expect(within(row).getByText('2026-09-30')).toBeInTheDocument();
    expect(within(row).getByText('2')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /만료/ })).toBeInTheDocument();
    expect(screen.getByText('복사된 값')).toBeInTheDocument();
    expect(screen.getByText(/값은 보여 주지 않습니다/)).toBeInTheDocument();
  });

  it('등록됨 탭은 등록한 것만, 서랍은 관리 기록의 메모를 마크다운으로 보인다', async () => {
    const user = userEvent.setup();
    mount(<Credentials />, '/credentials?tab=reg');
    await user.click(await rowByName(/OK_KEY/));
    const dlg = await screen.findByRole('dialog', { name: 'OK_KEY' });
    expect(within(dlg).getByText('중요').tagName).toBe('STRONG');
    expect(within(dlg).getByText(/등록됨 · kim · 2026-10-01/)).toBeInTheDocument();
  });

  it('등록 해제는 확인을 받고, 취소하면 보내지 않는다(OMAI-1135)', async () => {
    const user = userEvent.setup();
    const fn = mount(<Credentials />, '/credentials?tab=reg');
    await user.click(await rowByName(/OK_KEY/));
    const dlg = await screen.findByRole('dialog', { name: 'OK_KEY' });
    await user.selectOptions(within(dlg).getByRole('combobox', { name: '상태' }), 'none');
    await user.click(within(dlg).getByRole('button', { name: '고쳐 저장' }));
    expect(await screen.findByText(/OK_KEY 의 관리 기록을 지웁니다/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '취소' }));
    const sent = () => fn.mock.calls.filter((x) => String(x[0]).startsWith('/api/registry') && (x[1] as RequestInit | undefined)?.body);
    expect(sent()).toHaveLength(0);
    await user.click(await within(dlg).findByRole('button', { name: '고쳐 저장' }));
    await user.click(await screen.findByRole('button', { name: '확인' }));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(JSON.parse((sent()[0][1] as RequestInit).body as string)).toMatchObject({ status: 'none' });
  });

  it('서랍: 사실 표, 확인할 것, 쓰는 곳 링크(스킬·크론), 값 바꾸기 링크', async () => {
    const user = userEvent.setup();
    mount(<Credentials />, '/credentials');
    await user.click(await rowByName(/OPENAI_API_KEY/));
    const dlg = await screen.findByRole('dialog', { name: 'OPENAI_API_KEY' });
    expect(within(dlg).getByText('2곳에 복사돼 있음')).toBeInTheDocument();
    expect(within(dlg).getByRole('link', { name: '스킬 report/x' })).toHaveAttribute('href', '/skills?tab=all&q=x');
    expect(within(dlg).getByRole('link', { name: '크론 ma/daily' })).toHaveAttribute(
      'href',
      '/cron?tab=profiles&q=daily'
    );
    expect(within(dlg).getByRole('link', { name: 'ma 프로파일의 비밀값에서 바꾸기' })).toHaveAttribute(
      'href',
      '/profiles?name=ma&pane=env'
    );
  });

  it('담당: 사용자 목록에서 고르면 표시 이름이 저장된다(이메일이 아니다, OMAI-1229)', async () => {
    const user = userEvent.setup();
    const fn = mount(<Credentials />, '/credentials');
    await user.click(await rowByName(/SLACK_TOKEN/));
    const dlg = await screen.findByRole('dialog', { name: 'SLACK_TOKEN' });
    const box = within(dlg).getByRole('combobox', { name: '담당' });
    await user.click(box);
    await user.click(await screen.findByRole('option', { name: /박민수/ }));
    expect(box).toHaveValue('박민수');
    await user.click(within(dlg).getByRole('button', { name: '등록' }));
    await waitFor(() => {
      const c = fn.mock.calls.find((x) => String(x[0]).startsWith('/api/registry'))!;
      expect(JSON.parse((c[1] as RequestInit).body as string)).toMatchObject({ owner: '박민수' });
    });
  });

  it('관리 기록을 저장하면 POST /api/registry 로 종류·키·상태·담당·메모를 보낸다', async () => {
    const user = userEvent.setup();
    const fn = mount(<Credentials />, '/credentials');
    await user.click(await rowByName(/SLACK_TOKEN/));
    const dlg = await screen.findByRole('dialog', { name: 'SLACK_TOKEN' });
    await user.selectOptions(within(dlg).getByRole('combobox', { name: '상태' }), 'review');
    await user.type(within(dlg).getByRole('combobox', { name: '담당' }), 'park'); // 목록에 없는 글자도 그대로 저장한다
    await user.type(within(dlg).getByRole('textbox', { name: '용도·메모' }), '바꿔야 함');
    await user.click(within(dlg).getByRole('button', { name: '등록' }));
    await waitFor(() => {
      const c = fn.mock.calls.find((x) => String(x[0]).startsWith('/api/registry'))!;
      expect(JSON.parse((c[1] as RequestInit).body as string)).toEqual({
        kind: 'credential',
        key: 'c2',
        status: 'review',
        owner: 'park',
        note: '바꿔야 함',
      });
    });
    expect(await within(dlg).findByText('고쳐 저장')).toBeInTheDocument();
  });

  it('메모 칸의 미리 보기는 마크다운으로 그린다', async () => {
    const user = userEvent.setup();
    mount(<Credentials />, '/credentials');
    await user.click(await rowByName(/SLACK_TOKEN/));
    const dlg = await screen.findByRole('dialog', { name: 'SLACK_TOKEN' });
    await user.type(within(dlg).getByRole('textbox', { name: '용도·메모' }), '**굵게**');
    await user.click(within(dlg).getByRole('button', { name: '미리 보기' }));
    expect(within(dlg).getByText('굵게').tagName).toBe('STRONG');
  });
});

describe('Inventory: 거르기 배지(OMAI-1127 검토 D11)', () => {
  it('자격증명의 만료·빈 값 배지는 서버 합계와 같은 식으로 행을 거른다', async () => {
    const user = userEvent.setup();
    mount(<Credentials />, '/credentials?tab=all');
    await rowByName(/OK_KEY/);
    await user.click(screen.getByRole('button', { name: /만료·만료 임박/ }));
    await waitFor(() => expect(screen.queryByRole('row', { name: /OK_KEY/ })).not.toBeInTheDocument());
    expect(screen.getByRole('row', { name: /OPENAI_API_KEY/ })).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: /SLACK_TOKEN/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /만료·만료 임박/ }));
    await user.click(screen.getByRole('button', { name: /빈 값/ }));
    await waitFor(() => expect(screen.queryByRole('row', { name: /OPENAI_API_KEY/ })).not.toBeInTheDocument());
    expect(screen.getByRole('row', { name: /SLACK_TOKEN/ })).toBeInTheDocument();
  });

  it('도구의 「부르는 곳 없음」 배지는 그 플래그가 있는 행만 남긴다', async () => {
    const user = userEvent.setup();
    const fn = stubApi({
      '/api/tools': {
        ...TOOLS,
        items: [...TOOLS.items, { ...TOOLS.items[0], id: 't2', name: 'used.py', flags: [], used_count: 1 }],
      },
    });
    mountScreen(<Tools />, '/tools?tab=all');
    await rowByName(/used\.py/);
    expect(fn).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /부르는 곳 없음/ }));
    await waitFor(() => expect(screen.queryByRole('row', { name: /used\.py/ })).not.toBeInTheDocument());
    expect(screen.getByRole('row', { name: /sync\.py/ })).toBeInTheDocument();
  });
});

describe('Inventory: 도구', () => {
  it('언어 카드와 행, 서랍의 대화 링크(라이브러리 화면으로 가는 링크는 없다)', async () => {
    const user = userEvent.setup();
    mount(<Tools />, '/tools');
    // 언어 카드: 숫자 자리에는 언어 개수를 크게, 언어별 개수는 설명(작은 글씨)에
    const card = (await screen.findByText('python 1')).closest('[data-card]') as HTMLElement;
    expect(card.querySelector('[data-card-n]')).toHaveTextContent(/^1$/);
    expect(card.querySelector('[data-card-label]')).toHaveTextContent('언어');
    expect(within(await rowByName(/sync\.py/)).getByText('부르는 곳을 찾지 못함')).toBeInTheDocument(); // 확인할 것 칸(서버 플래그 글 그대로)
    await user.click(await rowByName(/sync\.py/));
    const dlg = await screen.findByRole('dialog', { name: 'sync.py' });
    // 라이브러리 화면은 메뉴에서 숨겼다. 서랍은 불러 쓰는 라이브러리를 보이거나 그 화면으로 보내지 않는다(OMAI-1175 후속)
    expect(within(dlg).queryByText('불러 쓰는 라이브러리')).toBeNull();
    expect(within(dlg).queryByRole('link', { name: 'requests' })).toBeNull();
    const popup = watchChatPopup();
    fireEvent.click(within(dlg).getByRole('button', { name: 'AI 설명 받기' }));
    expect(popup()).toMatchObject({ kind: 'chat', agent: 'ma', text: expect.any(String) }); // 대화 팝업(OMAI-1115)
  });
});

// ── 도구 화면의 MCP 서버 탭(OMAI-1249, 스펙 2026-10-16-002 3-2절, 디자인 결정 V1~V17) ──
const MCP_ROWS = [
  { id: 'default:github', name: 'github', scope: '전역', profile: '', transport: 'stdio', enabled: true, auth: '', target: 'npx -y server-github',
    env_names: ['GITHUB_TOKEN', 'LOG_LEVEL'], env_count: 2, header_names: [], header_count: 0, modified: '2026-10-16T01:00:00+09:00' },
  { id: 'ma:docs', name: 'docs', scope: '프로파일', profile: 'ma', transport: 'http', enabled: true, auth: 'header', target: 'https://docs.example.com/…',
    env_names: [], env_count: 0, header_names: ['Authorization'], header_count: 1, modified: '2026-10-16T01:00:00+09:00' },
  { id: 'sa:memory', name: 'memory', scope: '프로파일', profile: 'sa', transport: 'sse', enabled: false, auth: '', target: 'https://memory.example.io/…',
    env_names: [], env_count: 0, header_names: [], header_count: 0, modified: '2026-10-16T01:00:00+09:00' },
  { id: 'ma:big', name: 'big', scope: '프로파일', profile: 'ma', transport: 'stdio', enabled: true, auth: '', target: 'big-cmd',
    env_names: Array.from({ length: 20 }, (_, i) => `K${String(i).padStart(2, '0')}`), env_count: 22, header_names: [], header_count: 0, modified: '2026-10-16T01:00:00+09:00' },
];
const TOOLS_MCP = {
  ...TOOLS,
  totals: { ...TOOLS.totals, mcp: 4, mcp_off: 1 },
  mcp: MCP_ROWS,
  mcp_skipped: [],
};
const mountMcp = (initial: string, over: Record<string, unknown> = {}) => {
  stubApi({ '/api/tools': { ...TOOLS_MCP, ...over }, '/api/registry': { reg: null } });
  return mountScreen(<Tools />, initial);
};

describe('Inventory: 도구의 MCP 서버 탭(OMAI-1249)', () => {
  it('제목 옆에 스크립트와 MCP 서버 수가 함께 보이고, 카드를 누르면 MCP 탭으로 간다(V1)', async () => {
    const user = userEvent.setup();
    mountMcp('/tools');
    expect(await screen.findByText('스크립트 1 · MCP 서버 4')).toBeInTheDocument();
    const card = screen.getAllByText('MCP 서버').map((e) => e.closest('[data-card]')).find(Boolean) as HTMLElement;
    expect(card.querySelector('[data-card-n]')).toHaveTextContent(/^4$/);
    expect(card).toHaveTextContent('설정 파일 기준 · 켜짐 3 · 꺼짐 1');
    expect(screen.getByRole('tab', { name: /MCP 서버/ })).toHaveTextContent('4');                 // 탭 배지는 서버 수
    await user.click(card);
    await rowByName(/github/);
    expect(screen.getByTestId('loc')).toHaveTextContent('tab=mcp');
  });

  it('표 열은 이름·범위·연결·주소·명령·설정이고 수정 날짜 열이 없다. 켜짐은 글자, 꺼짐만 알약이다(V8·V12·V14)', async () => {
    mountMcp('/tools?tab=mcp');
    const gh = await rowByName(/github/);
    const heads = screen.getAllByRole('columnheader').map((h) => h.textContent);
    for (const label of ['이름', '범위', '연결', '주소·명령', '설정']) expect(heads).toContain(label);
    expect(heads).not.toContain('수정');
    expect(screen.getByRole('columnheader', { name: '설정' })).toHaveAccessibleDescription(/enabled/);                  // 이름은 「설정」 그대로, 설명은 설명으로
    expect(within(gh).getByText('stdio')).toBeInTheDocument();
    expect(within(gh).getByText('npx -y server-github')).toBeInTheDocument();
    expect(within(gh).getByText('켜짐')).toBeInTheDocument();
    expect(gh.querySelector('[data-pill]')).toBeNull();                                          // 켜짐은 알약이 아니라 본문 글자
    const memory = await rowByName(/memory/);
    expect(within(memory).getByText('꺼짐').closest('[data-pill]')).not.toBeNull();             // 꺼짐만 알약
    expect(within(memory).getByText('sse')).toBeInTheDocument();                                // 알려지지 않은 연결 값은 원문 그대로
    expect(within(await rowByName(/docs/)).getByText('HTTP')).toBeInTheDocument();             // 알려진 값은 정규화
    expect(within(gh).getByText('전역')).toBeInTheDocument();                                    // 기본 프로파일은 다른 표와 같이 전역(V11)
  });

  it('서랍은 사실 줄, 링크, 환경변수·헤더 이름 순이고 빈 값도 줄을 유지하며 값은 없다(V2·V3·V7·V13·V17)', async () => {
    const user = userEvent.setup();
    mountMcp('/tools?tab=mcp');
    await user.click(await rowByName(/github/));
    const dlg = await screen.findByRole('dialog', { name: 'github' });
    const text = dlg.textContent ?? '';
    expect(text.indexOf('프로파일의 MCP 탭 열기')).toBeGreaterThan(-1);
    expect(text.indexOf('프로파일의 MCP 탭 열기')).toBeLessThan(text.indexOf('설정된 환경변수 이름'));        // 링크가 이름 목록보다 앞
    expect(within(dlg).getByText('설정된 환경변수 이름 (전체 2)')).toBeInTheDocument();
    expect(within(dlg).getByText('GITHUB_TOKEN, LOG_LEVEL')).toBeInTheDocument();                  // 쉼표로 이은 글자 한 덩어리
    expect(within(dlg).getByText('설정된 헤더 이름 (전체 0)')).toBeInTheDocument();
    expect(within(dlg).getByText('없음')).toBeInTheDocument();                                     // 빈 이름 목록
    expect(within(dlg).getByText('지정 안 함')).toBeInTheDocument();                              // 빈 인증 방식도 줄을 유지
    expect(within(dlg).getByText('켜짐 (설정 기준)')).toBeInTheDocument();
    expect(within(dlg).getByText('설정 파일 수정')).toBeInTheDocument();
    expect(within(dlg).getByText('값은 여기서 보이지 않습니다')).toBeInTheDocument();
    expect(within(dlg).getByRole('link', { name: '프로파일의 MCP 탭 열기' })).toHaveAttribute('href', '/profiles?name=default&pane=tools&server=github');
  });

  it('프로파일 서버의 링크는 그 프로파일 이름과 서버를 넘기고, 이름이 20개를 넘으면 「외 N개」를 보인다(V6·V17)', async () => {
    const user = userEvent.setup();
    mountMcp('/tools?tab=mcp');
    await user.click(await rowByName(/docs/));
    expect(within(await screen.findByRole('dialog', { name: 'docs' })).getByRole('link', { name: '프로파일의 MCP 탭 열기' })).toHaveAttribute('href', '/profiles?name=ma&pane=tools&server=docs');
    await user.keyboard('{Escape}');
    await user.click(await rowByName(/big/));
    const dlg = await screen.findByRole('dialog', { name: 'big' });
    expect(within(dlg).getByText('설정된 환경변수 이름 (전체 22)')).toBeInTheDocument();
    expect(within(dlg).getByText(/K19 외 2개/)).toBeInTheDocument();
    expect(dlg.textContent).not.toContain('K20');
  });

  it('검색은 환경변수 이름·헤더 이름·상태 글자에 걸린다(V10)', async () => {
    const user = userEvent.setup();
    mountMcp('/tools?tab=mcp');
    await rowByName(/github/);
    const box = screen.getByRole('searchbox');
    await user.type(box, 'GITHUB_TOKEN');
    await waitFor(() => expect(screen.queryByRole('row', { name: /docs/ })).not.toBeInTheDocument());
    expect(screen.getByRole('row', { name: /github/ })).toBeInTheDocument();
    await user.clear(box);
    await user.type(box, 'Authorization');
    await waitFor(() => expect(screen.queryByRole('row', { name: /github/ })).not.toBeInTheDocument());
    expect(screen.getByRole('row', { name: /docs/ })).toBeInTheDocument();
    await user.clear(box);
    await user.type(box, '꺼짐');
    await waitFor(() => expect(screen.queryByRole('row', { name: /github/ })).not.toBeInTheDocument());
    expect(screen.getByRole('row', { name: /memory/ })).toBeInTheDocument();
  });

  it('「꺼짐 N」 배지는 꺼진 서버만 남기고, 스크립트용 토글은 MCP 행을 거르지 않는다. 꺼진 서버가 없으면 배지가 없다(V9)', async () => {
    const user = userEvent.setup();
    mountMcp('/tools?tab=mcp');
    await rowByName(/github/);
    expect(screen.queryByRole('button', { name: /부르는 곳 없음/ })).toBeNull();
    const badge = document.querySelector('[data-toggle]') as HTMLElement;                          // 카드의 「꺼짐 1」 설명 줄과 헷갈리지 않게 배지로 찾는다
    expect(badge).toHaveTextContent('꺼짐');
    await user.click(badge);
    await waitFor(() => expect(screen.queryByRole('row', { name: /github/ })).not.toBeInTheDocument());
    expect(screen.getByRole('row', { name: /memory/ })).toBeInTheDocument();
  });

  it('꺼진 서버가 없으면 꺼짐 배지를 보이지 않는다(V9)', async () => {
    mountMcp('/tools?tab=mcp', { totals: { ...TOOLS.totals, mcp: 1, mcp_off: 0 }, mcp: [MCP_ROWS[0]] });
    await rowByName(/github/);
    expect(document.querySelector('[data-toggle]')).toBeNull();
  });

  it('읽지 못한 프로파일 안내는 MCP 탭에서만, 있을 때만 보인다(V5)', async () => {
    const skipped = [{ profile: 'bad', reason: 'unreadable' }, { profile: 'ma2', reason: 'partial' }];
    const { unmount } = mountMcp('/tools?tab=mcp', { mcp_skipped: skipped });
    expect(await screen.findByText('프로파일 2개의 설정 파일을 읽지 못해 일부 서버가 빠졌습니다: bad, ma2')).toBeInTheDocument();
    unmount();
    mountMcp('/tools?tab=all', { mcp_skipped: skipped });
    await rowByName(/sync\.py/);
    expect(screen.queryByText(/설정 파일을 읽지 못해/)).toBeNull();
  });

  it('건너뛴 것이 없으면 안내가 없고, 전체 실패는 따로 알린다(V5)', async () => {
    const { unmount } = mountMcp('/tools?tab=mcp');
    await rowByName(/github/);
    expect(screen.queryByText(/설정 파일을 읽지 못해/)).toBeNull();
    unmount();
    mountMcp('/tools?tab=mcp', { mcp: [], totals: { ...TOOLS.totals, mcp: 0, mcp_off: 0 }, mcp_skipped: [{ profile: '*', reason: 'error' }] });
    expect(await screen.findByText('설정 파일을 읽지 못해 MCP 서버 목록을 만들지 못했습니다')).toBeInTheDocument();
  });

  it('옛 서버 응답(mcp 없음)이면 카드와 탭을 그리지 않고 오류도 없다(V4)', async () => {
    stubApi({ '/api/tools': TOOLS, '/api/registry': { reg: null } });
    mountScreen(<Tools />, '/tools');
    await rowByName(/sync\.py/);
    expect(screen.queryByRole('tab', { name: /MCP 서버/ })).toBeNull();
    expect(screen.queryByText('MCP 서버')).toBeNull();
    expect(screen.queryByText(/MCP 서버 \d/)).toBeNull();                                          // 제목 옆 문구는 지금 그대로(스크립트 수만)
  });

  it('mcp 가 빈 배열이면 빈 문구가 나온다(V4)', async () => {
    mountMcp('/tools?tab=mcp', { mcp: [], totals: { ...TOOLS.totals, mcp: 0, mcp_off: 0 } });
    expect(await screen.findByText(/설정된 MCP 서버가 없습니다/)).toBeInTheDocument();
  });

  it('서랍을 닫으면 포커스가 그 행으로 돌아온다(V15)', async () => {
    const user = userEvent.setup();
    mountMcp('/tools?tab=mcp');
    const row = await rowByName(/github/);
    await user.click(row);
    await screen.findByRole('dialog', { name: 'github' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'github' })).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement === row || row.contains(document.activeElement)).toBe(true));
  });
});

describe('Inventory: 라이브러리', () => {
  it('설치 환경 탭과 환경 서랍의 패키지 링크', async () => {
    const user = userEvent.setup();
    mount(<Libraries />, '/libraries?tab=envs');
    await user.click(await rowByName(/image/));
    const dlg = await screen.findByRole('dialog', { name: 'image' });
    expect(within(dlg).getByText('120개')).toBeInTheDocument();
    expect(within(dlg).getByRole('link', { name: '이 환경의 패키지' })).toHaveAttribute(
      'href',
      '/libraries?tab=all&env=image'
    );
  });

  it('패키지 행은 버전·종류·설치 환경을 열로 보인다', async () => {
    mount(<Libraries />, '/libraries?tab=all');
    const row = await rowByName(/requests/);
    for (const v of ['2.32', 'python', 'image']) expect(within(row).getByText(v)).toBeInTheDocument();
  });
});

// ── 값 넣기(스펙 2026-10-14-025, 변경 A) ──
const WCRED = (location: string, o: Record<string, unknown> = {}) => ({
  scope: '프로파일', profile: 'ma', set: true, flags: [], interface: 'REST', used_count: 0, used_by: [], source: '.env', location, ...o,
});
const WRITE_CREDS = {
  name_pattern: 'key|token|secret|password',
  totals: { items: 6, global: 3, profile: 3, expiring: 0, empty: 0, backups: 0, shared_groups: 0, registered: 0 },
  items: [
    { id: 'w1', name: 'OPENAI_API_KEY', ...WCRED('profiles/ma/.env') },
    { id: 'w2', name: 'SLACK_TOKEN', ...WCRED('.env', { scope: '전역', profile: '', set: false }) },
    { id: 'w3', name: 'api_key', ...WCRED('profiles/ma/config.yaml › providers.x', { source: 'config.yaml › providers' }) },
    { id: 'w4', name: 'omdm.json', ...WCRED('profiles/ma/secrets/omdm.json', { source: 'secrets 파일' }) },
    { id: 'w5', name: 'auth.json', ...WCRED('auth.json', { scope: '전역', profile: '', source: '파일' }) },
    { id: 'w6', name: 'HOST_KEY', ...WCRED('docker/.env', { scope: '전역', profile: '', source: '컨테이너 env (compose .env)' }) },
  ],
};
const PROFILES = (hiddenRoot = false) => ({
  profiles: [
    { name: 'default', is_default: true, hidden_root: hiddenRoot },
    { name: 'ma', is_default: false },
  ],
});
const creds = (fn: ReturnType<typeof stubApi>) => fn.mock.calls.filter((c) => String(c[0]).startsWith('/api/credentials')).length;

function mountWrite(o: { me?: unknown; profiles?: unknown; creds?: unknown } = {}, initial = '/credentials') {
  const routes: Record<string, unknown> = {
    '/api/me': o.me ?? { ...ME_ADMIN, secure: true },
    '/api/credentials': o.creds ?? WRITE_CREDS,
    '/api/profile/action': { ok: true },
    '/api/registry': { reg: null },
  };
  if (o.profiles !== null) routes['/api/profiles'] = o.profiles ?? PROFILES();
  const fn = stubApi(routes);
  mountScreen(<Credentials />, allProfiles(initial));
  return fn;
}
const openRow = async (name: RegExp, dialogName: string) => {
  await userEvent.setup().click(await rowByName(name));
  return screen.findByRole('dialog', { name: dialogName });
};

describe('Inventory: 자격증명 값 넣기', () => {
  it('관리자+암호화된 연결: .env 행의 서랍에서 덮어쓰기 확인 뒤 env_set 을 보내고 목록을 다시 받는다', async () => {
    const user = userEvent.setup();
    const fn = mountWrite();
    const dlg = await openRow(/OPENAI_API_KEY/, 'OPENAI_API_KEY');
    await user.click(await within(dlg).findByRole('button', { name: '값 바꾸기' }));
    await user.type(within(dlg).getByLabelText('OPENAI_API_KEY 의 새 값'), 'v1');
    const before = creds(fn);
    await user.click(within(dlg).getByRole('button', { name: '저장' }));
    expect(await screen.findByText(/지금 값을 새 값으로 바꿉니다/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '확인' }));
    await waitFor(() => expect(postedTo(fn, '/api/profile/action')).toEqual([{ name: 'ma', action: 'env_set', target: 'OPENAI_API_KEY', value: 'v1' }]));
    await waitFor(() => expect(creds(fn)).toBeGreaterThan(before));
  });

  it('http 연결이면 입력 대신 이유를 보이고, 기존 「비밀값에서 바꾸기」 링크는 남는다', async () => {
    mountWrite({ me: { ...ME_ADMIN, secure: false } });
    const dlg = await openRow(/OPENAI_API_KEY/, 'OPENAI_API_KEY');
    expect(within(dlg).getByText(/암호화되지 않은 주소/)).toBeInTheDocument();
    expect(within(dlg).queryByRole('button', { name: '값 바꾸기' })).toBeNull();
    expect(within(dlg).getByRole('link', { name: 'ma 프로파일의 비밀값에서 바꾸기' })).toBeInTheDocument();
  });

  it('secure 를 아직 모르면(응답에 없음) 막는다 — 모르는 상태는 닫는다', async () => {
    mountWrite({ me: ME_ADMIN });
    const dlg = await openRow(/OPENAI_API_KEY/, 'OPENAI_API_KEY');
    expect(within(dlg).getByRole('link', { name: 'ma 프로파일의 비밀값에서 바꾸기' })).toBeInTheDocument();
    expect(within(dlg).queryByRole('button', { name: '값 바꾸기' })).toBeNull();
    expect(screen.queryByRole('button', { name: '새 비밀값' })).toBeNull();
  });

  it('「새 비밀값」은 제목 옆의 + 아이콘이고, 표 툴바 오른쪽 끝에도 글자 단추가 있다(2026-10-21-020)', async () => {
    const user = userEvent.setup();
    mountWrite({ me: { ...ME_USER, owner: true, secure: true } });
    const [add, grid] = await screen.findAllByRole('button', { name: '새 비밀값' });
    expect(add.textContent).toBe('');
    expect(screen.getByRole('heading', { level: 1 }).parentElement).toBe(add.parentElement?.parentElement);
    expect(add.closest('[data-grid-toolbar]')).toBeNull();
    expect(grid.closest('[data-grid-toolbar]')).not.toBeNull();
    await user.click(grid); // 표 툴바 단추도 같은 창을 연다
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('에이전트 주인(관리자 아님)도 자기 에이전트의 값을 넣고 「새 비밀값」을 만든다(OMAI-1196)', async () => {
    const user = userEvent.setup();
    const fn = mountWrite({ me: { ...ME_USER, owner: true, secure: true } });
    expect((await screen.findAllByRole('button', { name: '새 비밀값' }))[0]).toBeInTheDocument();   // 서랍을 열기 전(서랍이 열리면 뒤 화면은 가려진다)
    const dlg = await openRow(/OPENAI_API_KEY/, 'OPENAI_API_KEY');
    await user.click(await within(dlg).findByRole('button', { name: '값 바꾸기' }));
    await user.type(within(dlg).getByLabelText('OPENAI_API_KEY 의 새 값'), 'v1');
    await user.click(within(dlg).getByRole('button', { name: '저장' }));
    await user.click(await screen.findByRole('button', { name: '확인' }));
    await waitFor(() => expect(postedTo(fn, '/api/profile/action')).toEqual([{ name: 'ma', action: 'env_set', target: 'OPENAI_API_KEY', value: 'v1' }]));
  });

  it('주인이어도 http 연결이면 입력 대신 이유를 보인다', async () => {
    mountWrite({ me: { ...ME_USER, owner: true, secure: false } });
    const dlg = await openRow(/OPENAI_API_KEY/, 'OPENAI_API_KEY');
    expect(within(dlg).queryByRole('button', { name: '값 바꾸기' })).toBeNull();
    expect(screen.queryByRole('button', { name: '새 비밀값' })).toBeNull();
  });

  it('관리자도 주인도 아니면 입력과 「새 비밀값」이 없다', async () => {
    mountWrite({ me: { ...ME_USER, secure: true } });
    const dlg = await openRow(/OPENAI_API_KEY/, 'OPENAI_API_KEY');
    expect(within(dlg).queryByRole('button', { name: '값 바꾸기' })).toBeNull();
    expect(within(dlg).getByRole('link', { name: 'ma 프로파일의 비밀값에서 바꾸기' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '새 비밀값' })).toBeNull();
  });

  it('숨긴 루트의 전역 행은 읽기 전용이다(프로파일 행은 그대로 입력된다)', async () => {
    mountWrite({ profiles: PROFILES(true) });
    const root = await openRow(/SLACK_TOKEN/, 'SLACK_TOKEN');
    expect(await within(root).findByText(/루트.*읽기 전용/)).toBeInTheDocument();
    expect(within(root).queryByRole('button', { name: '값 넣기' })).toBeNull();
  });

  it('프로파일 목록을 아직 못 받았으면(실패) 루트 판정을 못 하므로 입력을 열지 않는다', async () => {
    mountWrite({ profiles: null });
    const dlg = await openRow(/OPENAI_API_KEY/, 'OPENAI_API_KEY');
    expect(within(dlg).getByRole('link', { name: 'ma 프로파일의 비밀값에서 바꾸기' })).toBeInTheDocument();
    expect(within(dlg).queryByRole('button', { name: '값 바꾸기' })).toBeNull();
    expect(screen.queryByRole('button', { name: '새 비밀값' })).toBeNull();
  });

  it.each([
    ['api_key', 'config.yaml 은 프로파일 설정 탭으로 안내한다'],
    ['omdm.json', 'secrets 파일은 아직 바꿀 수 없다고 알린다'],
    ['auth.json', 'auth.json 도 아직 바꿀 수 없다고 알린다'],
    ['HOST_KEY', '컨테이너 env 는 안내가 없다'],
  ])('갈래별 안내: %s — %s', async (name) => {
    mountWrite();
    const dlg = await openRow(new RegExp(name.replace('.', '\\.')), name);
    const link = within(dlg).queryByRole('link', { name: /바꾸기/ });
    const cannot = within(dlg).queryByText(/이 화면에서 아직 바꿀 수 없습니다/);
    expect(within(dlg).queryByRole('button', { name: /값/ })).toBeNull();
    if (name === 'api_key') {
      expect(link).toHaveAttribute('href', '/profiles?name=ma&pane=config');
      expect(link).toHaveTextContent('ma 프로파일의 설정에서 바꾸기');
    } else if (name === 'HOST_KEY') {
      expect([link, cannot]).toEqual([null, null]);
    } else {
      expect(cannot).toBeInTheDocument();
      expect(link).toBeNull();
    }
  });

  it('「새 비밀값」: 이름은 대문자로 맞추고, 표에 안 나타날 이름은 경고하되 저장은 허용한다', async () => {
    const user = userEvent.setup();
    const fn = mountWrite({ profiles: PROFILES(true) });
    await user.click((await screen.findAllByRole('button', { name: '새 비밀값' }))[0]);
    const dlg = await screen.findByRole('dialog', { name: '새 비밀값 추가' });
    expect(await listAgents(user, within(dlg).getByRole('combobox', { name: '프로파일' }))).toEqual(['ma']); // 숨긴 루트는 고를 수 없다
    const name = within(dlg).getByLabelText('이름');
    await user.type(name, 'law_oc');
    expect(name).toHaveValue('LAW_OC');
    expect(within(dlg).getByText(/API 키·토큰 표에 나타나지 않습니다/)).toBeInTheDocument();
    await user.type(within(dlg).getByLabelText('값'), 'x1');
    const before = creds(fn);
    await user.click(within(dlg).getByRole('button', { name: '저장' }));
    await waitFor(() => expect(postedTo(fn, '/api/profile/action')).toEqual([{ name: 'ma', action: 'env_set', target: 'LAW_OC', value: 'x1' }]));
    await waitFor(() => expect(creds(fn)).toBeGreaterThan(before));
  });

  it('「새 비밀값」: 맞지 않는 이름은 저장을 막고, 이미 있는 이름은 덮어쓰기 확인을 거친다', async () => {
    const user = userEvent.setup();
    const fn = mountWrite();
    await user.click((await screen.findAllByRole('button', { name: '새 비밀값' }))[0]);
    const dlg = await screen.findByRole('dialog', { name: '새 비밀값 추가' });
    await user.type(within(dlg).getByLabelText('이름'), 'A');
    await user.type(within(dlg).getByLabelText('값'), 'x');
    expect(within(dlg).getByRole('button', { name: '저장' })).toBeDisabled();
    await user.clear(within(dlg).getByLabelText('이름'));
    await user.type(within(dlg).getByLabelText('이름'), 'OPENAI_API_KEY');
    await user.click(within(dlg).getByRole('button', { name: '저장' }));
    expect(await screen.findByText(/지금 값을 새 값으로 바꿉니다/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '취소' }));
    expect(postedTo(fn, '/api/profile/action')).toHaveLength(0);
  });

  it('응답에 name_pattern 이 없으면 경고하지 않는다', async () => {
    const user = userEvent.setup();
    mountWrite({ creds: { ...WRITE_CREDS, name_pattern: undefined } });
    await user.click((await screen.findAllByRole('button', { name: '새 비밀값' }))[0]);
    const dlg = await screen.findByRole('dialog', { name: '새 비밀값 추가' });
    await user.type(within(dlg).getByLabelText('이름'), 'LAW_OC');
    expect(within(dlg).queryByText(/나타나지 않습니다/)).toBeNull();
  });
});

describe('Inventory: 빈 화면 안내', () => {
  const EMPTY = { name_pattern: 'key', totals: { items: 0 }, items: [] };
  it('항목이 하나도 없을 때만 읽는 곳을 알려 준다', async () => {
    mountWrite({ creds: EMPTY });
    expect(await screen.findByText(/지금은 읽을 것이 없습니다/)).toBeInTheDocument();
  });
  it('항목이 있으면 안 보인다(필터 결과가 0 이어도 안내를 쓰지 않는다)', async () => {
    mountWrite({}, '/credentials?q=nothing-matches');
    await screen.findAllByRole('row');
    expect(screen.queryByText(/지금은 읽을 것이 없습니다/)).toBeNull();
  });
});

// 스펙 2026-10-28-006: 프로파일별로 보고 AAS 기본 값은 서버가 감춘다(수만 온다)
const row = (id: string, name: string, profile: string, extra: Record<string, unknown> = {}) => ({
  id, name, scope: '프로파일', profile, set: true, flags: [], interface: 'MCP', location: `profiles/${profile}/.env`, source: '.env',
  used_count: 0, used_by: [], ...extra,
});
const SCOPED = {
  totals: { items: 4, global: 0, profile: 4, expiring: 0, empty: 0, backups: 0, shared_groups: 1, registered: 0 },
  items: [
    row('p1', 'MCP_OUTLINE_API_KEY', 'profile2', { shared_group: 1, shared_with: 2, flags: ['같은 값이 2곳에'] }),
    row('p2', 'Authorization', 'profile2', { shared_group: 1, shared_with: 2 }),
    row('p3', 'opsknow-oauth (OAuth)', 'profile2'),
    row('t1', 'TEST_TOKEN', 'test-profile'),
  ],
  hidden: { count: 5, by_profile: { main: 2, profile2: 1, 'test-profile': 2 }, kinds: ['llm_default', 'auth_anonymous'] },
};
const ME_PRIMARY = { ...ME_ADMIN, secure: true, primary: { profile: 'main', ready: true }, pod: { id: 'pod-a' } };
function mountScoped(initial: string, creds: unknown = SCOPED) {
  window.localStorage.clear();
  const fn = stubApi({
    '/api/me': ME_PRIMARY,
    '/api/credentials': creds,
    '/api/profiles': { profiles: [{ name: 'default', is_default: true, hidden_root: true }, { name: 'main' }, { name: 'profile2' }, { name: 'test-profile' }] },
    '/api/registry': { reg: null },
  });
  mountScreen(<Credentials />, initial);
  return fn;
}
const loc = () => screen.getByTestId('loc').textContent ?? '';

describe('Inventory: API 키·토큰 프로파일별 보기(스펙 2026-10-28-006)', () => {
  it('주 프로파일에 보일 행이 없으면 행이 있는 프로파일로 연다(R8)', async () => {
    mountScoped('/credentials');
    await waitFor(() => expect(loc()).toContain('profile=profile2'));
    expect(await rowByName(/MCP_OUTLINE_API_KEY/)).toBeInTheDocument();
    expect(screen.queryByText('TEST_TOKEN')).toBeNull();
    expect(screen.getByRole('combobox', { name: '프로파일' })).toHaveValue('profile2');
  });

  it('주소로 고른 프로파일은 0행이어도 그대로 두고 다른 프로파일 수와 「전체 프로파일에서 보기」를 보인다(R8)', async () => {
    mountScoped('/credentials?profile=main');
    expect(await screen.findByText(/main · 주 프로파일 에는 없습니다\. 다른 프로파일에 4개/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: '전체 프로파일에서 보기' }));
    await waitFor(() => expect(loc()).toContain('profile=*'));
    expect(await rowByName(/TEST_TOKEN/)).toBeInTheDocument();
  });

  it('검색어만 있는 링크(스킬 연결도·대화)는 전체 프로파일로 연다(R11)', async () => {
    mountScoped('/credentials?tab=all&q=TEST_TOKEN');
    await waitFor(() => expect(loc()).toContain('profile=*'));
    expect(await rowByName(/TEST_TOKEN/)).toBeInTheDocument();
  });

  it('프로파일 하나면 카드 숫자를 그 행으로 세고, 범위 열과 거르기 줄의 범위를 빼며, 감춘 수는 그 프로파일 것만 알린다', async () => {
    mountScoped('/credentials?profile=profile2');
    await rowByName(/MCP_OUTLINE_API_KEY/);
    expect(screen.getByText(/전역 0 · 프로파일 3/)).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: '범위' })).toBeNull();
    expect(screen.getByText(/LiteLLM 연결 키 등 1개는 보이지 않습니다/)).toBeInTheDocument();
  });

  it('전체 프로파일이면 범위 열이 있고 감춘 수는 전체 합이다', async () => {
    mountScoped('/credentials?profile=*');
    await rowByName(/TEST_TOKEN/);
    expect(screen.getByRole('columnheader', { name: '범위' })).toBeInTheDocument();
    expect(screen.getByText(/LiteLLM 연결 키 등 5개는 보이지 않습니다/)).toBeInTheDocument();
  });

  it('감춘 값이 없으면 안내 줄을 더하지 않는다', async () => {
    mountScoped('/credentials?profile=*', { ...SCOPED, hidden: { count: 0, by_profile: {}, kinds: [] } });
    await rowByName(/TEST_TOKEN/);
    expect(screen.queryByText(/보이지 않습니다/)).toBeNull();
  });

  it('「새 비밀값」 창은 고른 프로파일로 연다', async () => {
    mountScoped('/credentials?profile=test-profile');
    await rowByName(/TEST_TOKEN/);
    await userEvent.setup().click((await screen.findAllByRole('button', { name: '새 비밀값' }))[0]);
    const dlg = await screen.findByRole('dialog', { name: '새 비밀값 추가' });
    expect(within(dlg).getByRole('combobox')).toHaveValue('test-profile');
  });
});

describe('Inventory: 도구는 주소의 profile=* 를 거르지 않음으로 읽는다(외부 검토 OV-13)', () => {
  it('API 키·토큰에서 가져온 profile=* 를 지운다', async () => {
    mount(<Tools />, '/tools?profile=*');
    await waitFor(() => expect(loc()).not.toContain('profile='));
  });
});
