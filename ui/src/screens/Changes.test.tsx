/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ME_USER, mountScreen, rowByName, stubApi } from '@/test/mountScreen';

import { Changes } from './Changes';

// 「바꾸기」는 상단 고르개와 같은 동작(switchPod → 그 화면으로 새로 고침)이다. jsdom 은 새로 고침을 못 해 둘 다 대역으로 본다(DD8)
const pod = vi.hoisted(() => ({ switchPod: vi.fn(() => Promise.resolve()), reloadAtView: vi.fn() }));
vi.mock('@/lib/pod', () => pod);

const today = new Date().toISOString().slice(0, 10);
const ROWS = [
  {
    ts: `${today}T10:00:00+09:00`,
    group: '크론',
    kind: 'cron_update',
    failed: false,
    who: 'kim',
    what: '크론 수정',
    detail: 'ma/abc',
  },
  {
    ts: '2026-09-01T09:00:00+09:00',
    group: '스킬',
    kind: 'skill',
    failed: false,
    who: 'lee',
    what: '스킬 저장',
    detail: 'ma/x',
  },
  {
    ts: '2026-09-02T09:00:00+09:00',
    group: '비밀값',
    kind: 'cred',
    failed: true,
    who: 'kim',
    what: '키 교체',
    detail: 'ma/OPENAI',
  },
  {
    ts: '2026-09-03T09:00:00+09:00',
    group: '접속',
    kind: 'login',
    failed: false,
    who: 'kim',
    what: '로그인',
    detail: '',
  },
  {
    ts: '2026-09-03T09:05:00+09:00',
    group: '접속',
    kind: 'login_failed',
    failed: true,
    who: '',
    actor: 'guest',
    what: '로그인 실패',
    detail: '',
  },
];

afterEach(() => vi.unstubAllGlobals());

function mount(initial = '/changes') {
  const fn = stubApi({ '/api/changes': { days: 30, rows: ROWS } });
  mountScreen(<Changes />, initial);
  return fn;
}

describe('Changes 누가 칸(2026-10-17-012)', () => {
  const rows = [
    { ts: `${today}T11:00:00+09:00`, group: '프로파일', kind: 'profile_config', failed: false, who: '', actor: 'aas', what: '설정을 고침', detail: 'main curator.prune_builtins=false' },
    { ts: `${today}T11:01:00+09:00`, group: '스킬', kind: 'skill_agent_edit', failed: false, who: '', actor: 'agent', what: 'Hermes 가 스킬 문서를 고침', detail: 'main zz-skill' },
    { ts: `${today}T11:02:00+09:00`, group: '프로파일', kind: 'profile_soul', failed: false, who: '', what: 'SOUL 을 고침', detail: 'own-a 옛 기록' },
  ];

  it('사람이 아니면 원인별로 짧게 보인다: AAS 자동·에이전트·기록 없음(마우스를 올리면 이유)', async () => {
    const user = userEvent.setup();
    stubApi({ '/api/changes': { days: 30, rows } });
    mountScreen(<Changes />, '/changes');
    const row = async (detail: string) => (await screen.findByText(detail)).closest('[role=row]') as HTMLElement;
    expect(within(await row('main curator.prune_builtins=false')).getByText('AAS 자동')).toBeInTheDocument();
    expect(within(await row('main zz-skill')).getByText('AI 에이전트')).toBeInTheDocument();
    const old = within(await row('own-a 옛 기록')).getByText('기록 없음');
    expect(screen.queryByText('(누가 했는지 기록 없음)')).toBeNull();
    // 사람 칩과 같은 원형 표시 + 이름이고, 주체마다 색이 다르다
    const aas = within(await row('main curator.prune_builtins=false')).getByText('AAS 자동').closest('[data-actor-chip]') as HTMLElement;
    const agent = within(await row('main zz-skill')).getByText('AI 에이전트').closest('[data-actor-chip]') as HTMLElement;
    expect(aas).toHaveAttribute('data-actor-chip', 'aas');
    expect(agent).toHaveAttribute('data-actor-chip', 'agent');
    const markBg = (el: HTMLElement) => getComputedStyle(el.querySelector('[aria-hidden]') as HTMLElement).backgroundColor;
    expect(markBg(aas)).not.toBe(markBg(agent));
    expect(old.closest('[data-actor-chip]')).toBeNull();
    await user.hover(old);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('누가 했는지 남기기 전의 기록입니다');
  });
});

describe('Changes 대상 칸(2026-10-18)', () => {
  it('관리자 기록은 대상 앞에 그 에이전트 주인 이름을 붙여 누구의 main 인지 보인다', async () => {
    const rows = [
      { ts: `${today}T10:35:00+09:00`, group: '프로파일', kind: 'profile_config', failed: false, who: '', actor: 'aas', what: '설정을 고침', detail: 'main skills.external_dirs+=/opt/aas-skills', pod: 'hermes-kim', owner: '김철수' },
      { ts: `${today}T10:36:00+09:00`, group: '프로파일', kind: 'profile_config', failed: false, who: '', actor: 'aas', what: '설정을 고침', detail: 'default curator.prune_builtins=false', pod: 'base', owner: 'base' },
    ];
    stubApi({ '/api/changes': { days: 30, rows } });
    mountScreen(<Changes />, '/changes');
    expect(await screen.findByText('김철수 · main skills.external_dirs+=/opt/aas-skills')).toBeInTheDocument();
    expect(screen.getByText('base · default curator.prune_builtins=false')).toBeInTheDocument(); // 주인이 없으면 서버가 POD 이름을 준다
  });

  it('에이전트 이름이 오면 「주인 · 에이전트 이름」을 붙이고, 상세의 에이전트 칸도 같고 id 는 풍선말이다(스펙 2026-10-19-003)', async () => {
    const user = userEvent.setup();
    const rows = [
      { ts: `${today}T10:35:00+09:00`, group: '스킬 허브', kind: 'market_install', failed: false, who: '', actor: 'aas', what: '설치 요청', detail: 'ns/pkg@1 → main', pod: 'aas-agent-kim-1a2b', owner: '김철수', owner_name: '김철수', pod_name: '영업 도우미' },
      { ts: `${today}T10:36:00+09:00`, group: '프로파일', kind: 'profile_config', failed: false, who: '', actor: 'aas', what: '설정을 고침', detail: 'default x=1', pod: 'base', owner: 'base', owner_name: '', pod_name: '공용' },
    ];
    stubApi({ '/api/changes': { days: 30, rows } });
    mountScreen(<Changes />, '/changes');
    expect(await screen.findByText('김철수 · 영업 도우미 · ns/pkg@1 → main')).toBeInTheDocument();
    expect(screen.getByText('공용 · default x=1')).toBeInTheDocument(); // 주인이 없으면 에이전트 이름만
    await user.click(screen.getByText('김철수 · 영업 도우미 · ns/pkg@1 → main'));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText('김철수 · 영업 도우미')).toHaveAttribute('title', 'aas-agent-kim-1a2b');
  });
});

describe('Changes', () => {
  it('접속 기록을 뺀 바꾼 일 수와 오늘 건수, 바꾼 사람 수를 카드에 보인다', async () => {
    mount();
    expect(await screen.findByText('오늘 1건')).toBeInTheDocument();
    expect(screen.getByText('바꾼 사람').closest('[data-card]')).toHaveTextContent('2'); // kim, lee
    // 보기 카드(2026-10-17-011): 로그인 수와 실패 수는 「접속」 보기 카드의 둘째 줄이다
    expect(screen.getByRole('tab', { name: /^접속, \d+$/ })).toHaveAccessibleDescription('로그인 1 · 실패 1');
  });

  it('첫 탭은 실패하지 않은 변경만 보인다', async () => {
    mount();
    expect(await screen.findByText('크론 수정')).toBeInTheDocument();
    expect(screen.getByText('스킬 저장')).toBeInTheDocument();
    expect(screen.queryByText('키 교체')).not.toBeInTheDocument();
    expect(screen.queryByText('로그인 실패')).not.toBeInTheDocument();
  });

  it('거절·실패 탭과 접속 탭이 각자의 행을 보인다', async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText('크론 수정');
    await user.click(screen.getByRole('tab', { name: /거절·실패/ }));
    expect(screen.getByText('키 교체')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /접속/ }));
    const row = await rowByName(/로그인 실패/);
    expect(within(row).getByText('실패')).toBeInTheDocument(); // 결과 칸
    expect(within(row).getByText('로그인 전')).toBeInTheDocument(); // 누가 칸: 로그인 실패는 IP 만 남는다(2026-10-17-012)
  });

  // (2026-10-17): 「누가」도 에이전트 화면의 소유자 칸처럼 머리글자·한 줄로 보인다
  it('누가 칸은 에이전트 소유자 칸과 같은 사용자 칩(머리글자, 마우스를 올리면 전체 주소)이고 local 은 글자 그대로다', async () => {
    const today = new Date().toISOString().slice(0, 10);
    stubApi({
      '/api/changes': {
        days: 30,
        rows: [
          { ts: `${today}T10:00:00+09:00`, group: '크론', kind: 'cron_update', failed: false, who: 'kim@x.com', what: '크론 수정', detail: 'ma/abc' },
          { ts: `${today}T09:00:00+09:00`, group: '크론', kind: 'cron_update', failed: false, who: 'local', what: '크론 멈춤', detail: 'ma/def' },
        ],
      },
    });
    mountScreen(<Changes />, '/changes');
    const chip = (await rowByName(/크론 수정/)).querySelector('[data-user-chip]');
    expect(chip).toHaveTextContent('Kkim@x.com');
    expect(chip).toHaveAttribute('title', 'kim@x.com');
    const local = await rowByName(/크론 멈춤/);
    expect(local.querySelector('[data-user-chip]')).toBeNull();
    expect(within(local).getByText('local')).toBeInTheDocument();
    // 서랍의 「누가」도 같은 칩이다
    await userEvent.click(await rowByName(/크론 수정/));
    const dlg = await screen.findByRole('dialog', { name: '크론 수정' });
    const inDrawer = dlg.querySelector('[data-user-chip]');
    expect(inDrawer).toHaveTextContent('Kkim@x.com');
    expect(inDrawer).toHaveAttribute('title', 'kim@x.com');
  });

  it('기간은 7·30일이고(기록 보관 31일, 스펙 2026-10-24-006) 30일이 기본이라 주소에 days 가 없다', async () => {
    const user = userEvent.setup();
    const fn = mount();
    await screen.findByText('크론 수정');
    const sel = screen.getByRole('combobox', { name: '기간' });
    expect(
      within(sel)
        .getAllByRole('option')
        .map((o) => o.textContent)
    ).toEqual(['최근 7일', '최근 30일']);
    expect(fn.mock.calls.map((c) => String(c[0])).find((u) => u.startsWith('/api/changes'))).toContain('days=30');
    await user.selectOptions(sel, '7');
    expect(screen.getByTestId('loc')).toHaveTextContent('days=7');
  });

  it('서랍은 시각·누가·대상·결과를 보이고 값 비기록 안내를 단다', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await rowByName(/크론 수정/));
    const dlg = await screen.findByRole('dialog', { name: '크론 수정' });
    expect(within(dlg).getByText('ma/abc')).toBeInTheDocument();
    expect(within(dlg).getByText('kim')).toBeInTheDocument();
    expect(within(dlg).getByText('성공')).toBeInTheDocument();
    expect(within(dlg).getByText(/비밀값과 글 내용은 기록하지 않습니다/)).toBeInTheDocument();
  });

  it('필터 종류로 거르고 주소의 group 으로 시작한다', async () => {
    mount('/changes?group=스킬');
    expect(await screen.findByText('스킬 저장')).toBeInTheDocument();
    expect(screen.queryByText('크론 수정')).not.toBeInTheDocument();
  });

  it('주인에게는 내 에이전트 기록만: 관리자 변경은 Amber 태그·「관리자」, 설치 요청 상태, 접속 탭 없음(OMAI-1126 DT2)', async () => {
    stubApi({
      '/api/me': { auth_enabled: true, admin: false, owner: true, pod: { id: 'kim', owner: 'kim@x.com' }, user: { email: 'kim@x.com' } },
      '/api/changes': {
        days: 30,
        owner: true,
        pod: 'kim',
        pod_name: '김의 에이전트',
        since: '2026-10-01T00:00:00+09:00',
        rows: [
          { ts: `${today}T10:00:00+09:00`, group: '프로파일', kind: 'profile_model', failed: false, who: '', by_admin: true, what: '주 모델을 바꿈', detail: 'ma model=m2' },
          { ts: `${today}T09:00:00+09:00`, group: '스킬 허브', kind: 'market_install', failed: false, who: 'kim@x.com', what: '설치 요청', detail: 'free/x@1 → kim/ma', request_status: 'failed' },
        ],
      },
    });
    mountScreen(<Changes />, '/changes');
    expect(await screen.findByRole('heading', { name: '내 AI 에이전트 작업공간 변경 기록' })).toBeInTheDocument();
    expect(screen.getByText('김의 에이전트 · 최근 30일')).toBeInTheDocument(); // id 대신 에이전트 이름(스펙 2026-10-19-003)
    expect(screen.queryByRole('tab', { name: /접속/ })).not.toBeInTheDocument();
    expect(screen.getByText('관리자가 바꿈')).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /주 모델을 바꿈.*관리자가 바꿈.*ma model=m2/ })).toBeInTheDocument(); // 행이 한 일·누가·대상을 글로 읽힌다
    expect(screen.getByText('실패')).toBeInTheDocument();                             // 설치 요청 상태 태그
    expect(screen.getByText('설치 진행 중')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '프로파일 열기' })).toHaveAttribute('href', '/profiles');
  });

  it('주인의 기록이 비면 기준 날짜와 함께 안내한다', async () => {
    stubApi({
      '/api/me': { auth_enabled: true, admin: false, owner: true, pod: { id: 'kim', owner: 'kim@x.com' }, user: { email: 'kim@x.com' } },
      '/api/changes': { days: 7, owner: true, pod: 'kim', since: '2026-10-01T00:00:00+09:00', rows: [] },
    });
    mountScreen(<Changes />, '/changes?days=7');
    expect(await screen.findByText(/최근 7일 동안 이 AI 에이전트 작업공간에서 바뀐 일이 없습니다.*2026-10-01 이후 기록부터/)).toBeInTheDocument();
  });

  it('주인이 아닌 사람에게는 서버의 안내 문구를 보인다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(
          url.startsWith('/api/changes')
            ? new Response(JSON.stringify({ error: '이 AI 에이전트의 소유자가 아니어서 기록을 볼 수 없습니다.' }), { status: 403 })
            : new Response(JSON.stringify({ auth_enabled: true, admin: false, pod: { id: 'kim', owner: 'kim@x.com' }, user: { email: 'lee@x.com' } }), { status: 200 })
        )
      )
    );
    mountScreen(<Changes />, '/changes');
    expect(await screen.findByText('이 AI 에이전트의 소유자가 아니어서 기록을 볼 수 없습니다.')).toBeInTheDocument();
  });

  it('POD 를 바꾸면 앞 POD 의 기록을 보이지 않는다(조회 키에 POD, 디자인 결정 5A)', async () => {
    let pod = 'kim';
    const fn = vi.fn((url: string) => {
      const body = url.startsWith('/api/me')
        ? { auth_enabled: true, admin: false, owner: true, pod: { id: pod, owner: 'x@x.com' }, user: { email: 'x@x.com' } }
        : pod === 'kim'
        ? { days: 30, owner: true, pod: 'kim', since: '', rows: [{ ...ROWS[0], what: 'kim 의 변경', kind: 'x_kim' }] }
        : new Promise(() => undefined);                                                  // 새 POD 기록은 아직 오지 않았다
      return body instanceof Promise ? body : Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    });
    vi.stubGlobal('fetch', fn);
    const { qc } = mountScreen(<Changes />, '/changes');
    expect(await screen.findByText('kim 의 변경')).toBeInTheDocument();
    pod = 'lee';
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ['me'] });
    });
    await waitFor(() => expect(screen.queryByText('kim 의 변경')).not.toBeInTheDocument());
  });
  it('새 기록이 앞에 붙어 순서가 밀려도 열린 서랍은 같은 기록을 따라간다', async () => {
    const user = userEvent.setup();
    const first = [{ ...ROWS[0], request_status: 'queued' }, ...ROWS.slice(1)];
    stubApi({ '/api/changes': { days: 30, rows: first } });
    const { qc } = mountScreen(<Changes />, '/changes');
    await user.click(await rowByName(/크론 수정/));
    const dlg = await screen.findByRole('dialog', { name: '크론 수정' });
    expect(within(dlg).getByText('기다리는 중')).toBeInTheDocument();
    // 새 기록이 맨 앞에 붙고, 열어 둔 기록의 설치 요청이 끝났다
    const fresh = { ...ROWS[1], ts: `${today}T11:00:00+09:00`, detail: 'ma/new' };
    act(() =>
      qc.setQueryData(['changes', '', 30], { days: 30, rows: [fresh, { ...first[0], request_status: 'done' }, ...first.slice(1)] })
    );
    expect(await within(screen.getByRole('dialog', { name: '크론 수정' })).findByText('완료')).toBeInTheDocument();
    expect(await screen.findByRole('row', { name: /크론 수정/, hidden: true })).toHaveAttribute('aria-current', 'true'); // 선택 표시도 같은 기록에 남는다
  });

  describe('편집 열(OMAI-1210)', () => {
    it('프로파일 이름을 읽을 수 있는 변경만 그 설정으로 가는 「편집」이 있다', async () => {
      mount();
      const cron = await rowByName(/크론 수정/);
      expect(within(cron).getByRole('link', { name: '크론 수정 편집' })).toHaveAttribute('href', '/profiles?name=ma&pane=cron');
    });

    it('열 곳을 모르는 종류의 변경은 빈 칸이다', async () => {
      mount('/changes?days=90');
      const row = await rowByName(/스킬 저장/);
      expect(within(row).queryByRole('link', { name: /편집/ })).toBeNull();
    });

    it('관리자도 주인도 아니면 「편집」 열이 없다', async () => {
      stubApi({ '/api/me': ME_USER, '/api/changes': { days: 30, rows: ROWS } });
      mountScreen(<Changes />, '/changes');
      await rowByName(/크론 수정/);
      expect(screen.queryByRole('link', { name: /편집/ })).toBeNull();
    });
  });
});

// 「누가」는 이메일 대신 사람 이름(서버가 who_name 을 준다), 이메일은 풍선말(스펙 2026-10-18-010)
describe('Changes: 누가는 사람 이름', () => {
  const row = { ts: `${today}T12:00:00+09:00`, group: '크론', kind: 'cron_update', failed: false, what: '크론 수정', detail: 'ma/abc' };

  it('이메일이 있으면 사람 이름을 칩으로 보이고 이메일은 풍선말에만 둔다', async () => {
    stubApi({ '/api/changes': { days: 30, rows: [{ ...row, who: 'kim@x.com', who_name: '김철수' }] } });
    mountScreen(<Changes />, '/changes');
    const chip = await screen.findByText('김철수', { selector: '[data-user-chip] *' });
    expect(chip.closest('[data-user-chip]')).toHaveAttribute('title', 'kim@x.com');
    expect(screen.queryByText('kim@x.com')).not.toBeInTheDocument();
  });

  it('Claude Code 연결로 한 일은 사람 칩 옆에 「Claude Code」 배지(스펙 2026-10-28-001 §3-7 ⑦)', async () => {
    stubApi({
      '/api/changes': {
        days: 30,
        rows: [
          { ...row, who: 'kim@x.com', who_name: '김철수', via: 'token', detail: 'ma/token' },
          { ...row, who: 'lee@x.com', who_name: '이영희', detail: 'ma/screen' },
        ],
      },
    });
    mountScreen(<Changes />, '/changes');
    const kim = (await screen.findByText('김철수', { selector: '[data-user-chip] *' })).closest('[role="row"]') as HTMLElement;
    expect(within(kim).getByText('Claude Code')).toBeInTheDocument();
    const lee = screen.getByText('이영희', { selector: '[data-user-chip] *' }).closest('[role="row"]') as HTMLElement;
    expect(within(lee).queryByText('Claude Code')).toBeNull();
  });

  it('이름을 주지 않는 예전 서버는 이메일을 그대로 보인다', async () => {
    stubApi({ '/api/changes': { days: 30, rows: [{ ...row, who: 'kim@x.com' }] } });
    mountScreen(<Changes />, '/changes');
    expect(await screen.findByText('kim@x.com', { selector: '[data-user-chip] *' })).toBeInTheDocument();
  });
});

// 팀 관리자 권한(스펙 2026-10-22-001 DD6·DD7·DD8·DD10)
describe('Changes: 팀 관리자', () => {
  const OWNER_ME = { auth_enabled: true, admin: false, owner: true, department: '개발 1팀', pod: { id: 'kim', owner: 'kim@x.com' }, pods: [], user: { email: 'kim@x.com' } };
  const base = { ts: `${today}T12:00:00+09:00`, failed: false, detail: 'main' };
  const teamRow = { ...base, group: '프로파일', kind: 'profile_model', what: '주 모델을 바꿈', detail: 'main model=m2', who: 'lee@x.com', who_name: '이영희', by_team_manager: true };
  const adminRow = { ...base, ts: `${today}T11:00:00+09:00`, group: '프로파일', kind: 'profile_soul', what: '성격을 수정함', detail: 'main soul', who: '', by_admin: true };
  const ownerChanges = (extra: Record<string, unknown> = {}) => ({ days: 30, owner: true, pod: 'kim', pod_name: '영업 도우미', since: '2026-10-01T00:00:00+09:00', rows: [teamRow, adminRow], ...extra });

  it('팀 관리자가 한 줄은 사람 칩과 「팀 관리자」 배지, 관리자가 한 줄은 지금처럼 호박 태그만 보인다(DD10)', async () => {
    stubApi({ '/api/me': OWNER_ME, '/api/changes': ownerChanges() });
    mountScreen(<Changes />, '/changes');
    const team = await rowByName(/main model=m2/);
    expect(team.querySelector('[data-user-chip]')).toHaveTextContent('이영희');
    expect(within(team).getByText('팀 관리자')).toBeInTheDocument();
    expect(within(team).queryByText('관리자가 바꿈')).toBeNull();
    const admin = await rowByName(/main soul/);
    expect(within(admin).getByText('관리자가 바꿈')).toBeInTheDocument();
    expect(within(admin).queryByText('팀 관리자')).toBeNull();
  });

  it('주인·팀 관리자 아닌 사람이 한 줄은 이름 칩과 무채색 「다른 사람」 배지이고 호박 태그가 없다(D15)', async () => {
    const otherRow = { ...base, ts: `${today}T10:00:00+09:00`, group: '일 시키기', kind: 'chat_send', what: '채팅으로 일을 시킴', detail: 'main', who: 'park@x.com', who_name: '박민수', by_other: true, count: 2 };
    stubApi({ '/api/me': OWNER_ME, '/api/changes': ownerChanges({ rows: [teamRow, adminRow, otherRow] }) });
    mountScreen(<Changes />, '/changes');
    const other = await rowByName(/채팅 2회/);
    expect(other.querySelector('[data-user-chip]')).toHaveTextContent('박민수');
    expect(within(other).getByText('다른 사람')).toBeInTheDocument();
    expect(within(other).queryByText('관리자가 바꿈')).toBeNull();
    expect(within(other).queryByText('팀 관리자')).toBeNull();
    expect(screen.getByText(/· 관리자 1$/)).toBeInTheDocument(); // 카드의 관리자 건수는 by_admin 줄만 센다
  });

  it('서랍의 누가는 「팀 관리자 이름 (부서)」 문장이고, 거르기 글(whoOf)은 「팀 관리자 이름」이다(DD10)', async () => {
    const user = userEvent.setup();
    stubApi({ '/api/me': OWNER_ME, '/api/changes': ownerChanges() });
    mountScreen(<Changes />, '/changes?who=' + encodeURIComponent('팀 관리자 이영희'));
    await user.click(await rowByName(/main model=m2/));
    const dlg = await screen.findByRole('dialog', { name: '주 모델을 바꿈' });
    expect(within(dlg).getByText('팀 관리자 이영희 (개발 1팀)')).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: /main soul/ })).toBeNull(); // 거르기가 「팀 관리자 이영희」로 맞는다
  });

  it('부서를 모르면 서랍 문장에서 부서를 뺀다', async () => {
    const user = userEvent.setup();
    stubApi({ '/api/me': { ...OWNER_ME, department: '' }, '/api/changes': ownerChanges() });
    mountScreen(<Changes />, '/changes');
    await user.click(await rowByName(/main model=m2/));
    const dlg = await screen.findByRole('dialog', { name: '주 모델을 바꿈' });
    expect(within(dlg).getByText('팀 관리자 이영희')).toBeInTheDocument();
  });

  it('일 시키기는 묶은 건수로 「채팅 n회」·「오피스 n회」를 보인다(DD7)', async () => {
    const work = [
      { ...base, group: '일 시키기', kind: 'chat_send', what: '채팅으로 일을 시킴', detail: 'main', who: 'kim@x.com', count: 3 },
      { ...base, ts: `${today}T09:00:00+09:00`, group: '일 시키기', kind: 'office_command', what: '오피스에서 일을 시킴', detail: 'desk-1', who: 'kim@x.com', count: 2 },
    ];
    stubApi({ '/api/me': OWNER_ME, '/api/changes': ownerChanges({ rows: work }) });
    mountScreen(<Changes />, '/changes');
    expect(within(await rowByName(/desk-1/)).getByText('오피스 2회')).toBeInTheDocument();
    expect(screen.getByText('채팅 3회')).toBeInTheDocument();
  });

  it('주인 화면 위에 우리 팀 관리자 한 줄을 두고, 팀 관리자가 없으면 두지 않는다(DD6)', async () => {
    stubApi({ '/api/me': OWNER_ME, '/api/changes': ownerChanges({ team_managers: ['이영희', '박민수'] }) });
    const { unmount } = mountScreen(<Changes />, '/changes');
    expect(await screen.findByText('우리 팀 관리자: 이영희, 박민수. 내 AI 에이전트에게 일을 시키고 설정을 바꿀 수 있습니다')).toBeInTheDocument();
    unmount();
    stubApi({ '/api/me': OWNER_ME, '/api/changes': ownerChanges({ team_managers: [] }) });
    mountScreen(<Changes />, '/changes');
    await rowByName(/main model=m2/);
    expect(screen.queryByText(/우리 팀 관리자/)).toBeNull();
  });

  describe('팀 관리자가 보는 화면(DD8)', () => {
    const TM_ME = {
      auth_enabled: true,
      admin: false,
      owner: false,
      team_manager: true,
      pod: { id: 'kim', owner: 'kim@x.com', owner_name: '김철수', name: '영업 도우미', team: true },
      pods: [
        { id: 'lee', owner: 'lee@x.com', owner_name: '이영희', name: '내 도우미' },
        { id: 'kim', owner: 'kim@x.com', owner_name: '김철수', name: '영업 도우미', team: true },
        { id: 'park', owner: 'park@x.com', owner_name: '박민수', name: '공유 도우미' },
      ],
      user: { email: 'lee@x.com' },
    };
    const tmChanges = (rows: unknown[] = []) => ({ days: 30, owner: false, team_manager: true, pod: 'kim', pod_name: '영업 도우미', since: '2026-10-01T00:00:00+09:00', rows });

    it('머리에 대상 에이전트 칩을 두고, 기록이 비면 주인이 된 날짜와 함께 안내한다', async () => {
      stubApi({ '/api/me': TM_ME, '/api/changes': tmChanges() });
      mountScreen(<Changes />, '/changes');
      expect(await screen.findByRole('heading', { name: '팀원 AI 에이전트 작업공간 변경 기록' })).toBeInTheDocument();
      expect(screen.getByText('김철수 · 영업 도우미').closest('[data-agent-chip]')).not.toBeNull();
      expect(screen.getByText('김철수 님이 소유자가 된 2026-10-01 뒤 기록이 없습니다')).toBeInTheDocument();
      expect(screen.queryByRole('tab', { name: /접속/ })).toBeNull();
    });

    it('기록이 있으면 그대로 보인다(주인 화면처럼 지금 에이전트 기록만)', async () => {
      stubApi({ '/api/me': TM_ME, '/api/changes': tmChanges([teamRow]) });
      mountScreen(<Changes />, '/changes');
      expect(within(await rowByName(/main model=m2/)).getByText('팀 관리자')).toBeInTheDocument();
    });

    it('「바꾸기」는 내 것과 팀원 것만 보이고, 고르면 상단 고르개와 같이 지금 에이전트를 바꾼다', async () => {
      const user = userEvent.setup();
      pod.switchPod.mockClear();
      pod.reloadAtView.mockClear();
      stubApi({ '/api/me': TM_ME, '/api/changes': tmChanges() });
      mountScreen(<Changes />, '/changes');
      await user.click(await screen.findByRole('button', { name: '바꾸기' }));
      const items = await screen.findAllByRole('menuitemradio');
      expect(items.map((i) => i.textContent)).toEqual(['내 도우미', expect.stringContaining('김철수 · 영업 도우미')]);
      await user.click(items[0]);
      await waitFor(() => expect(pod.switchPod).toHaveBeenCalledWith('lee'));
      expect(pod.reloadAtView).toHaveBeenCalledWith('changes');
    });
  });
});
