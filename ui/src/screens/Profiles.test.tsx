/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useUi } from '@/components/UiContext';
import { watchChatPopup } from '@/test/chatPopup';
import { HistoryBack, mountScreen, postedTo, rowByName, stubApi } from '@/test/mountScreen';
import { listAgents, pickAgent } from '@/test/pickAgent';

import { minutesBetween } from './cron/NewJob';
import { Profiles, profilesRetryMs } from './Profiles';

const ROW = (over = {}) => ({
  name: 'ma',
  title: '마케팅',
  description: '마케팅 담당',
  model: 'qwen3',
  is_default: false,
  running: false,
  service_disabled: false,
  jobs_active: 4,
  jobs_total: 5,
  failed_jobs: 1,
  sessions_7d: 3,
  skills: 6,
  mcp: ['chart'],
  creds: 2,
  creds_expiring: 1,
  last_activity: '2026-10-10T08:00:00+09:00',
  channels: [
    { name: 'telegram', state: 'connected', attention: true },
    { name: 'slack', state: 'fatal' },
  ],
  issues: [
    { level: 'bad', text: '게이트웨이가 꺼져 있음' },
    { level: 'warn', text: '재시도 기록' },
  ],
  ...over,
});
const LIST = (canEdit = true) => ({
  can_edit: canEdit,
  profiles: [
    ROW(),
    ROW({
      name: 'default',
      title: '',
      is_default: true,
      running: true,
      issues: [],
      channels: [],
      jobs_active: 0,
      description: '',
      sessions_7d: 0,
    }),
  ],
});
const DETAIL = (over = {}) => ({
  profile: ROW(),
  can_edit: true,
  secure: true,
  notes: [],
  models: ['qwen3', 'gemma'],
  soul: { lines: ['# 성격', '친절하게'], sha: 'ss1', versions: 1, masked_lines: [] },
  config: { lines: ['model: qwen3'], sha: 'cs1', versions: 0, masked_lines: [] },
  env: [
    { name: 'OPENAI_API_KEY', set: true, description: 'OpenAI 키', channel: false, category: 'LLM' },
    { name: 'SLACK_TOKEN', set: false, description: '슬랙', channel: true, category: '' },
  ],
  skills: [
    { name: 'report', description: '보고', enabled: true, usage: 3, provenance: 'market' },
    { name: 'alert', description: '', enabled: false },
  ],
  mcp: [{ name: 'chart', transport: 'http', target: 'http://chart', env_names: ['CHART_KEY'], enabled: true }],
  toolsets: [
    { name: 'web', label: '웹', description: '웹 도구', tools: 4, enabled: true, configured: false },
  ],
  ...over,
});
const CRON_JOBS = [
  { id: 'j1', name: 'daily', enabled: true, state: 'scheduled', schedule_display: '30 9 * * *', skills: ['report'], last_status: 'ok' },
  { id: 'j3', name: 'prompt-only', enabled: false, state: 'paused', schedule_display: '30m', skills: [], last_status: null },
];
const SKILL_GRAPH = {
  root: 'skill:ma:report',
  nodes: [{ id: 'skill:ma:report', kind: 'skill', label: 'report', sub: '', badges: [], depth: 0, meta: {} }],
  edges: [],
  observed: { days: 14, scope: '', runs: 0, matched: 0 },
};
const FLOWS = {
  starts: [
    {
      id: 'ma/j1',
      label: 'daily',
      profile: 'ma',
      status: 'ok',
      badges: [],
      sub: 'ma · 30 9 * * *',
      skills: ['report'],
      scripts: ['run.py'],
    },
    {
      id: 'ops/j2',
      label: 'other',
      profile: 'ops',
      status: 'ok',
      badges: [],
      sub: 'ops · 30m',
      skills: [],
      scripts: [],
    },
  ],
};

afterEach(() => vi.unstubAllGlobals());

function mount(initial: string, detail: unknown = DETAIL(), list: unknown = LIST(), extra: Record<string, unknown> = {}, back = false) {
  const fn = stubApi({
    ...extra,
    '/api/profile/action': (_u: string, b: Record<string, unknown>) =>
      b.action === 'create'
        ? { name: b.name }
        : b.action === 'rename'
        ? { name: b.new_name }
        : b.action === 'mcp_test'
        ? { test: { ok: true, tools: 5 } }
        : b.action === 'delete'
        ? { archive: '/data/x.tgz' }
        : b.action === 'soul_preview' || b.action === 'config_preview'
        ? { problem: '' }
        : { ok: true },
    '/api/profile?': detail,
    '/api/profiles': list,
    '/api/flows': FLOWS,
    '/api/cron/jobs': { profile: 'ma', can_edit: true, jobs: CRON_JOBS },
    '/api/cron/action': { ok: true },
    // extra 가 같은 열쇠를 주면 그것을 쓴다(같은 이름 열쇠는 뒤 값이 이기므로 여기서 고른다)
    '/api/skills': extra['/api/skills'] ?? { skills: [{ id: 'ma:report', name: 'report', profile: 'ma' }] },
    '/api/models': {},
    '/api/text/versions': { versions: [] },
  });
  mountScreen(
    <>
      <Profiles />
      {back && <HistoryBack />}
    </>,
    initial
  );
  return fn;
}

describe('Profiles 주 프로파일(스펙 2026-10-14-003)', () => {
  it('숨긴 루트는 「루트(숨김)」으로 보이고, main 이 준비 중이면 안내한다', async () => {
    const base = LIST();
    const list = { ...base, profiles: base.profiles.map((r) => (r.is_default ? { ...r, hidden_root: true } : r)) };
    stubApi({
      '/api/me': { auth_enabled: true, admin: true, user: { email: 'a@x.com' }, primary: { profile: 'main', ready: false } },
      '/api/profiles': list,
      '/api/flows': FLOWS,
    });
    mountScreen(<Profiles />, '/profiles');
    expect(await screen.findByText('루트(숨김)')).toBeInTheDocument();
    expect(await screen.findByText(/주 프로파일\(main\)을 만들고 있습니다/)).toBeInTheDocument();
  });

  it('숨긴 루트에는 이름 옆에 「사용 금지」 표식이 하나 더 있고, 다른 프로파일에는 없다(OMAI-1268)', async () => {
    const base = LIST();
    const list = { ...base, profiles: base.profiles.map((r) => (r.is_default ? { ...r, hidden_root: true } : r)) };
    stubApi({
      '/api/me': { auth_enabled: true, admin: true, user: { email: 'a@x.com' }, primary: { profile: 'main', ready: true } },
      '/api/profiles': list,
      '/api/flows': FLOWS,
    });
    mountScreen(<Profiles />, '/profiles');
    const marks = await screen.findAllByText('사용 금지');
    expect(marks).toHaveLength(1); // 루트 한 줄에만
    // 이름 옆(같은 칸)에 있다: 이름 글자와 표식이 같은 부모 아래에 있다
    const name = screen.getByText('default');
    let box: HTMLElement | null = name;
    while (box && !box.contains(marks[0])) box = box.parentElement;
    expect(box).not.toBeNull();
    expect(box!.querySelectorAll('[data-pill]').length).toBeGreaterThanOrEqual(1);
  });

  it('숨긴 루트의 상세 머리에도 「루트(숨김)」 옆에 「사용 금지」 표식이 있다(OMAI-1268)', async () => {
    mount('/profiles?name=ma', DETAIL({ profile: { ...ROW(), is_default: true, hidden_root: true } }));
    expect(await screen.findByText('루트(숨김)')).toBeInTheDocument();
    expect((await screen.findAllByText('사용 금지')).length).toBeGreaterThanOrEqual(1);
  });

  it('숨기지 않은 기본 프로파일(로컬 시험 환경)에는 「사용 금지」 표식이 없다', async () => {
    mount('/profiles');
    await screen.findByText('루트(숨김)').catch(() => null);
    expect(screen.queryByText('사용 금지')).toBeNull();
  });
});

describe('Profiles 응답 없는 작업공간 다시 읽기(스펙 2026-11-02-003)', () => {
  const g = (state: string) => ({ pod: 'p', state });
  it('응답 없는(error) 묶음이 있으면 5초마다 다시 읽는다 — 서버 재기동 직후 첫 읽기가 10초를 넘겨도 저절로 정상 화면이 된다', () => {
    expect(profilesRetryMs({ profiles: [], can_edit: true, groups: [g('ok'), g('error')] } as never)).toBe(5000);
  });
  it('모두 읽혔거나, 멈춘·뜨는 중인 것뿐이거나, 자료가 없으면 다시 읽지 않는다', () => {
    expect(profilesRetryMs({ profiles: [], can_edit: true, groups: [g('ok'), g('stopped'), g('starting')] } as never)).toBe(false);
    expect(profilesRetryMs({ profiles: [], can_edit: true } as never)).toBe(false);
    expect(profilesRetryMs(undefined)).toBe(false);
  });
});

describe('Profiles 관리자 요청 알림(스펙 2026-11-02-001)', () => {
  const AREQ = { id: 'areq|1', kind: 'admin_request', alias: 'ma', text: '모델을 바꿔 주세요', requester: 'kim@example.com', requester_name: '김영주', req_kind: 'model_change', profile: 'ma', waiting_days: 2 };

  it('처리 대기 요청이 있으면 목록 위에 건수와 [받은편지함 열기]를 보이고, 누르면 받은편지함 서랍에 그 요청이 있다', async () => {
    mount('/profiles', DETAIL(), LIST(), { '/api/office/inbox': { items: [AREQ, { id: 'c1', kind: 'cron_done', alias: 'ma', text: '끝남' }] } });
    expect(await screen.findByText('관리자에게 온 요청 1건이 처리를 기다리고 있습니다.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '받은편지함 열기' }));
    expect(await screen.findByText(/모델을 바꿔 주세요/)).toBeInTheDocument();
  });

  it('처리 대기 요청이 없으면 알림이 없다', async () => {
    mount('/profiles', DETAIL(), LIST(), { '/api/office/inbox': { items: [{ id: 'c1', kind: 'cron_done', alias: 'ma', text: '끝남' }] } });
    await screen.findByRole('tablist');
    expect(screen.queryByRole('button', { name: '받은편지함 열기' })).toBeNull();
  });
});

describe('Profiles 목록', () => {
  it('첫 탭은 전체, 그다음이 확인할 것이다', async () => {
    mount('/profiles');
    await screen.findByRole('tablist');
    // 보기 카드(2026-10-17-011)의 접근 이름은 「라벨, 숫자」다
    const names = screen.getAllByRole('tab').map((t) => t.getAttribute('aria-label')?.split(', ')[0]);
    expect(names.slice(0, 2)).toEqual(['전체', '확인할 것']);
    expect(screen.getAllByRole('tab')[0]).toHaveAttribute('aria-selected', 'true'); // 주소에 tab 이 없으면 전체
  });

  it('카드와 행: 제목(이름)·배지·첫 문제 외 N건·모델·크론/스킬', async () => {
    mount('/profiles?tab=issue');
    expect(await screen.findByText('마케팅 (ma)')).toBeInTheDocument();
    expect(screen.getByText('2개 · AI 에이전트 작업공간 하나에 프로파일을 여러 개 둘 수 있습니다')).toBeInTheDocument();
    expect(screen.getByText('게이트웨이가 꺼져 있음 외 1건')).toBeInTheDocument();
    expect(screen.getByText('중지됨')).toBeInTheDocument(); // 「게이트웨이」 열이라 상태만(2026-10-20)
    expect(screen.queryByText('게이트웨이 중지됨')).toBeNull();
    expect(screen.getByText('텔레그램 연결됨')).toBeInTheDocument();
    expect(screen.getByText('슬랙 fatal')).toBeInTheDocument();
    expect(screen.getByText('문제')).toBeInTheDocument();
    expect(screen.getByText('qwen3')).toBeInTheDocument();
    const row = await rowByName(/^마케팅 \(ma\)/);
    expect(within(row).getByText('4')).toBeInTheDocument(); // 활성 크론 칸
    expect(within(row).getByText('6')).toBeInTheDocument(); // 스킬 칸
    expect(screen.queryByText('default')).not.toBeInTheDocument(); // 문제 없는 프로파일은 확인할 것 탭에 없다
  });

  it('전체 탭에서 루트 프로파일 태그와 소개 없음을 보이고 행을 누르면 상세 주소로 간다', async () => {
    const user = userEvent.setup();
    mount('/profiles?tab=all');
    expect(await screen.findByText('루트')).toBeInTheDocument(); // Hermes 루트 — 예전 이름 「기본」은 채팅 기본과 헷갈렸다(2026-10-19-001 디자인 D10)
    expect(screen.getByText('소개 없음')).toBeInTheDocument();
    await user.click(await rowByName(/^마케팅/));
    expect(screen.getByTestId('loc')).toHaveTextContent('/profiles?tab=all&name=ma'); // 목록 탭은 남는다
  });

  it('머리 문구에 에이전트 이름, 프로파일이 둘 이상이면 채팅 기본 뱃지(2026-10-19-001 R4·디자인 D12)', async () => {
    mount('/profiles?tab=all', DETAIL(), { ...LIST(), chat_default: 'ma' }, {
      '/api/me': { auth_enabled: true, admin: false, pod: { id: 'p', name: '마케팅 도우미' }, user: { email: 'k@x.com' } },
    });
    expect(await screen.findByText('마케팅 도우미의 프로파일 2개')).toBeInTheDocument();
    expect(screen.getByText('채팅 기본')).toBeInTheDocument();
  });

  it('프로파일이 하나뿐이어도 채팅 기본 뱃지를 단다 — 모은 목록에서는 어느 에이전트의 기본인가가 정보다(2026-10-19-018 리뷰 D5)', async () => {
    mount('/profiles?tab=all', DETAIL(), { ...LIST(), profiles: [LIST().profiles[0]], chat_default: 'ma' });
    await rowByName(/^마케팅/);
    expect(screen.getByText('채팅 기본')).toBeInTheDocument();
  });

  it('새 프로파일: 복제 원본과 옵션을 보내고 만든 프로파일 상세로 간다', async () => {
    const user = userEvent.setup();
    const fn = mount('/profiles');
    await user.click((await screen.findAllByRole('button', { name: '새 프로파일' }))[0]);
    const dlg = await screen.findByRole('dialog', { name: '새 프로파일' });
    await user.type(within(dlg).getByRole('textbox', { name: /이름/ }), 'research');
    await pickAgent(user, within(dlg).getByRole('combobox', { name: '어디서 시작할까요' }), 'ma 을(를) 복제');
    await user.click(within(dlg).getByRole('checkbox', { name: '스킬은 가져오지 않기' }));
    await user.type(within(dlg).getByRole('textbox', { name: '소개' }), '조사');
    await user.click(within(dlg).getByRole('button', { name: '만들기' }));
    await waitFor(() =>
      expect(postedTo(fn, '/api/profile/action')).toEqual([
        { name: 'research', action: 'create', clone_from: 'ma', no_skills: true, share_skills: false, description: '조사' },
      ])
    );
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/profiles?name=research'));
  });

  it('주인: 「새 프로파일」은 주 에이전트 복제로만, 원본 고르기·스킬 빼기가 없다(스펙 2026-10-15-011 단계 2)', async () => {
    const user = userEvent.setup();
    const fn = mount('/profiles', DETAIL(), { ...LIST(false), can_create: true, primary: 'ma', profile_limit: { used: 2, max: 3 } });
    await user.click((await screen.findAllByRole('button', { name: '새 프로파일' }))[0]);
    const dlg = await screen.findByRole('dialog', { name: '새 프로파일' });
    expect(within(dlg).queryByRole('combobox', { name: '어디서 시작할까요' })).not.toBeInTheDocument();
    expect(within(dlg).queryByRole('checkbox', { name: '스킬은 가져오지 않기' })).not.toBeInTheDocument();
    expect(within(dlg).getByText(/주 프로파일\(ma\)을 복제/)).toBeInTheDocument();
    expect(within(dlg).getByText(/2\/3/)).toBeInTheDocument();
    await user.type(within(dlg).getByRole('textbox', { name: /이름/ }), 'research');
    await user.click(within(dlg).getByRole('button', { name: '만들기' }));
    await waitFor(() =>
      expect(postedTo(fn, '/api/profile/action')).toEqual([{ name: 'research', action: 'create', clone_from: 'ma', no_skills: false, share_skills: false, description: '' }])
    );
  });

  it('다른 에이전트에서 가져오기: 내 다른 에이전트의 프로파일을 고르면 import_from 을 보내고 스킬 함께 쓰기와 함께 쓰지 않는다(스펙 2026-10-15-011 단계 4)', async () => {
    const user = userEvent.setup();
    const fn = mount('/profiles', DETAIL(), { ...LIST(false), can_create: true, primary: 'ma', profile_limit: { used: 1, max: 3 } }, {
      '/api/profiles/importable': { sources: [{ pod: 'kim-2', profiles: ['main', 'ops'], name: '영업 도우미', owner_name: '김철수' }] },
    });
    await user.click((await screen.findAllByRole('button', { name: '새 프로파일' }))[0]);
    const dlg = await screen.findByRole('dialog', { name: '새 프로파일' });
    await user.type(within(dlg).getByRole('textbox', { name: /이름/ }), 'imp');
    await user.click(within(dlg).getByRole('checkbox', { name: /ma의 스킬을 복사하지 않고 함께 쓰기/ }));
    // 에이전트는 id(kim-2) 대신 「주인 이름 · 에이전트 이름」으로 보인다(스펙 2026-10-19-003)
    await pickAgent(user, await within(dlg).findByRole('combobox', { name: '다른 AI 에이전트 작업공간에서 가져오기' }), /^김철수 · 영업 도우미 › ops 의 성격·설정 가져오기$/);
    expect(within(dlg).queryByText(/kim-2/)).toBeNull();
    expect(within(dlg).getByText(/성격\(SOUL\)과 안전한 설정만 복사합니다/)).toBeInTheDocument();
    await user.click(within(dlg).getByRole('button', { name: '만들기' }));
    await waitFor(() =>
      expect(postedTo(fn, '/api/profile/action')).toEqual([
        { name: 'imp', action: 'create', clone_from: 'ma', no_skills: false, share_skills: false, import_from: { pod: 'kim-2', profile: 'ops' }, description: '' },
      ])
    );
  });

  it('스킬 함께 쓰기: 주인은 주 에이전트의 스킬을, 관리자는 고른 원본의 스킬을 복사하지 않고 쓴다(스펙 2026-10-15-011 D6)', async () => {
    const user = userEvent.setup();
    const fn = mount('/profiles', DETAIL(), { ...LIST(false), can_create: true, primary: 'ma', profile_limit: { used: 1, max: 3 } });
    await user.click((await screen.findAllByRole('button', { name: '새 프로파일' }))[0]);
    const dlg = await screen.findByRole('dialog', { name: '새 프로파일' });
    await user.type(within(dlg).getByRole('textbox', { name: /이름/ }), 'side');
    await user.click(within(dlg).getByRole('checkbox', { name: /ma의 스킬을 복사하지 않고 함께 쓰기/ }));
    expect(within(dlg).getByText(/이 프로파일에서는 그 스킬을 고칠 수 없고/)).toBeInTheDocument();
    await user.click(within(dlg).getByRole('button', { name: '만들기' }));
    await waitFor(() =>
      expect(postedTo(fn, '/api/profile/action')).toEqual([{ name: 'side', action: 'create', clone_from: 'ma', no_skills: false, share_skills: true, description: '' }])
    );
  });

  it('스킬 함께 쓰기: 관리자는 원본을 골라야 체크 상자가 보이고, 켜면 「스킬은 가져오지 않기」는 꺼진다', async () => {
    const user = userEvent.setup();
    const fn = mount('/profiles');
    await user.click((await screen.findAllByRole('button', { name: '새 프로파일' }))[0]);
    const dlg = await screen.findByRole('dialog', { name: '새 프로파일' });
    expect(within(dlg).queryByRole('checkbox', { name: /함께 쓰기/ })).not.toBeInTheDocument();       // 원본 없이 시작하면 쓸 곳이 없다
    await user.type(within(dlg).getByRole('textbox', { name: /이름/ }), 'research');
    await pickAgent(user, within(dlg).getByRole('combobox', { name: '어디서 시작할까요' }), 'ma 을(를) 복제');
    await user.click(within(dlg).getByRole('checkbox', { name: '스킬은 가져오지 않기' }));
    await user.click(within(dlg).getByRole('checkbox', { name: /ma의 스킬을 복사하지 않고 함께 쓰기/ }));
    expect(within(dlg).getByRole('checkbox', { name: '스킬은 가져오지 않기' })).toBeDisabled();
    await user.click(within(dlg).getByRole('button', { name: '만들기' }));
    await waitFor(() =>
      expect(postedTo(fn, '/api/profile/action')).toEqual([{ name: 'research', action: 'create', clone_from: 'ma', no_skills: false, share_skills: true, description: '' }])
    );
  });

  it('주인: 프로파일이 상한에 닿으면 추가 단추가 비활성이 되고 이유와 「관리자에게 요청」을 목록 위에서 바로 보인다(디자인 결정 7A·7B)', async () => {
    mount('/profiles', DETAIL(), { ...LIST(false), can_create: true, primary: 'ma', profile_limit: { used: 3, max: 3 } });
    // 제목 옆 + 와 표 툴바의 글자 단추가 같이 꺼지고 같은 이유를 준다(2026-10-21-020)
    const adds = await screen.findAllByRole('button', { name: '새 프로파일' });
    expect(adds).toHaveLength(2);
    for (const add of adds) {
      expect(add).toBeDisabled();
      expect(add).toHaveAccessibleDescription(/3개까지/);
    }
    expect(screen.getByText('이 작업 프로파일 3/3개')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '관리자에게 프로파일 상한 늘리기 요청' })).toBeInTheDocument();
  });

  it('주인: 상한 아래에서는 사용량을 단추 옆에 보이고 단추가 켜져 있다', async () => {
    mount('/profiles', DETAIL(), { ...LIST(false), can_create: true, primary: 'ma', profile_limit: { used: 1, max: 3 } });
    expect(await screen.findByText('이 작업 프로파일 1/3개')).toBeInTheDocument();
    for (const b of screen.getAllByRole('button', { name: '새 프로파일' })) expect(b).toBeEnabled();
    expect(screen.queryByRole('button', { name: '관리자에게 프로파일 상한 늘리기 요청' })).toBeNull();
  });


  it('관리자가 아니면 새 프로파일 버튼이 없다', async () => {
    mount('/profiles', DETAIL(), LIST(false));
    await screen.findByText('마케팅 (ma)');
    expect(screen.queryByRole('button', { name: '새 프로파일' })).not.toBeInTheDocument();
  });
});

// 내 에이전트 전체의 프로파일(스펙 2026-10-19-018)
const ME_KIM = { auth_enabled: true, admin: false, pod: { id: 'a', name: '마케팅' }, user: { email: 'kim@x.com' } };
const MAIN = (pod: string, pod_name: string) => ROW({ name: 'main', title: '', issues: [], description: '', pod, pod_name });
const GROUP = (over = {}) => ({ state: 'ok', can_create: true, primary: 'main', chat_default: 'main', owner: true, ...over });
const ALL = (over: Record<string, unknown> = {}) => ({
  can_edit: false,
  profiles: [MAIN('a', '마케팅'), ROW({ pod: 'a', pod_name: '마케팅' }), MAIN('b', '시험')],
  groups: [
    GROUP({ pod: 'a', name: '마케팅', current: true, count: 2, profile_limit: { used: 2, max: 5 } }),
    GROUP({ pod: 'b', name: '시험', count: 1, profile_limit: { used: 1, max: 1 } }),
  ],
  ...over,
});
const MY_AGENTS = { agents: [{ name: 'a', owner: 'kim@x.com', display_name: '마케팅', profiles: ['main', 'ma'] }, { name: 'b', owner: 'kim@x.com', display_name: '시험', profiles: ['main'] }] };
function mountAll(initial = '/profiles', list: unknown = ALL(), extra: Record<string, unknown> = {}, detail: unknown = DETAIL({ profile: ROW({ name: 'main' }) })) {
  // 에이전트를 바꾸면 내 정보의 지금 에이전트도 바뀐다
  let now = { id: 'a', name: '마케팅' };
  return mount(initial, detail, list, {
    '/api/me': () => ({ ...ME_KIM, pod: now }),
    '/api/pod': (_u: string, b: Record<string, unknown>) => {
      now = b.id === 'b' ? { id: 'b', name: '시험' } : { id: String(b.id), name: '마케팅' };
      return { ok: true };
    },
    '/api/agents/update': { ok: true },
    '/api/agents': MY_AGENTS,
    '/api/office': { agents: [] },
    ...extra,
  });
}

describe('Profiles 내 에이전트 전체(스펙 2026-10-19-018)', () => {
  it('에이전트 칸·「지금」·부제, 같은 이름 main 두 줄은 에이전트로 구분된다(A2·리뷰 I1·디자인 DD2·DD11)', async () => {
    const fn = mountAll();
    expect(await screen.findByText('내 AI 에이전트 작업공간 2개의 프로파일 3개')).toBeInTheDocument();
    expect(fn.mock.calls.some((c) => String(c[0]) === '/api/profiles?all=1')).toBe(true);
    const here = await rowByName(/^main.*마케팅/);
    expect(within(here).getByText('지금')).toBeInTheDocument();
    const there = await rowByName(/^main.*시험/);
    expect(within(there).queryByText('지금')).toBeNull();
    expect(there).toHaveAccessibleDescription('누르면 지금 AI 에이전트 작업공간이 시험(으)로 바뀝니다');
    expect(here).not.toHaveAccessibleDescription(/바뀝니다/);
    expect(screen.getByRole('button', { name: '시험의 main 동작' })).toBeInTheDocument();
  });

  it('다른 에이전트의 줄: 메뉴 이름은 「바꿔 열기」, 누르면 에이전트를 바꾼 뒤 서랍을 열고 [되돌리기]는 주소까지 되돌린다(A3·디자인 DD6·DD11)', async () => {
    const user = userEvent.setup();
    const fn = mountAll('/profiles?tab=all');
    await user.click(await screen.findByRole('button', { name: '시험의 main 동작' }));
    expect(await screen.findByRole('menuitem', { name: '시험(으)로 바꿔 열기' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.click(await rowByName(/^main.*시험/));
    await waitFor(() => expect(postedTo(fn, '/api/pod')).toEqual([{ id: 'b' }]));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/profiles?tab=all&name=main'));
    // 서랍이 열려 있으면 서랍 밖 알림은 낭독기에서 가려진다 — 서랍 안에서 한 번 읽는다(디자인 DD12)
    await waitFor(() => expect(document.querySelector('[data-agent-announcer]')).toHaveTextContent('지금 AI 에이전트 작업공간: 시험'));
    fireEvent.click(await screen.findByText('되돌리기'));
    await waitFor(() => expect(postedTo(fn, '/api/pod')).toEqual([{ id: 'b' }, { id: 'a' }]));
    // 바꾸기 전에는 서랍이 닫혀 있었다 — 원래 에이전트의 main 을 열지 않고 닫는다
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/profiles\?tab=all$/));
  });

  it('바꾸기 알림은 초점이 있는 동안 8초가 지나도 남고, 초점이 떠나면 닫힌다(디자인 DD12)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      mountAll('/profiles?tab=all');
      await user.click(await rowByName(/^main.*시험/));
      const undo = await screen.findByText('되돌리기');
      undo.closest('button')?.focus();
      await act(async () => void vi.advanceTimersByTime(9000));
      expect(screen.getByText('되돌리기')).toBeInTheDocument();
      undo.closest('button')?.blur();
      await act(async () => void vi.advanceTimersByTime(9000));
      await waitFor(() => expect(screen.queryByText('되돌리기')).toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });

  it('지금 에이전트의 줄은 바꾸지 않고 바로 연다', async () => {
    const user = userEvent.setup();
    const fn = mountAll();
    await user.click(await rowByName(/^main.*마케팅/));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/profiles?name=main'));
    expect(postedTo(fn, '/api/pod')).toEqual([]);
  });

  it('줄이 없는 묶음은 표 위에 상태별 한 줄과 동작으로 보인다(디자인 DD3)', async () => {
    const user = userEvent.setup();
    const list = ALL({
      groups: [
        ...ALL().groups,
        GROUP({ pod: 'c', name: '남의 것', owner_name: '이영희', shared: true, state: 'error', error: 'x', can_create: false }),
        GROUP({ pod: 'd', name: '빈 것', count: 0, profile_limit: { used: 0, max: 5 } }),
        { pod: 'z', name: '멈춘 것', state: 'stopped' },
      ],
    });
    mountAll('/profiles', list);
    expect(await screen.findByText('응답 없음: 이영희 · 남의 것')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '다시 읽기' })).toBeInTheDocument();
    expect(screen.getByText('멈춤 · 준비 중: 멈춘 것')).toBeInTheDocument();
    expect(screen.getByText('프로파일 없음: 빈 것')).toBeInTheDocument();
    expect(screen.getByText('내 AI 에이전트 작업공간 2개의 프로파일 3개')).toBeInTheDocument(); // 줄이 있는 에이전트만 센다
    await user.click(screen.getByRole('button', { name: '여기에 만들기' }));
    const dlg = await screen.findByRole('dialog', { name: '새 프로파일' });
    expect(within(dlg).getByRole('combobox', { name: '만들 AI 에이전트 작업공간' })).toHaveValue('빈 것');
  });

  it('「채팅 기본으로」는 /api/agents/update 로 저장하고 [되돌리기]는 앞 값으로 다시 보낸다(C·리뷰 D2·디자인 DD5)', async () => {
    const user = userEvent.setup();
    const fn = mountAll();
    await user.click(await screen.findByRole('button', { name: '마케팅의 마케팅 (ma) 동작' }));
    await user.click(await screen.findByRole('menuitem', { name: '채팅 기본으로' }));
    await waitFor(() => expect(postedTo(fn, '/api/agents/update')).toEqual([{ name: 'a', chat_default: 'ma' }]));
    expect(await screen.findByText('채팅이 이제 마케팅의 ma을(를) 먼저 엽니다')).toBeInTheDocument();
    fireEvent.click(await screen.findByText('되돌리기'));
    await waitFor(() => expect(postedTo(fn, '/api/agents/update')).toEqual([{ name: 'a', chat_default: 'ma' }, { name: 'a', chat_default: 'main' }]));
  });

  it('채팅 기본인 줄과 나눠 받은 에이전트의 줄에는 「채팅 기본으로」가 없다(리뷰 I3)', async () => {
    const user = userEvent.setup();
    const list = ALL({
      profiles: [...ALL().profiles, MAIN('c', '남의 것')],
      groups: [...ALL().groups, GROUP({ pod: 'c', name: '남의 것', owner_name: '이영희', shared: true, can_create: false, chat_default: 'other', owner: false })],
    });
    mountAll('/profiles', list, { '/api/agents': { agents: [...MY_AGENTS.agents, { name: 'c', owner: 'lee@x.com', display_name: '남의 것', profiles: ['main'] }] } });
    await user.click(await screen.findByRole('button', { name: '마케팅의 main 동작' }));
    expect(screen.queryByRole('menuitem', { name: '채팅 기본으로' })).toBeNull();
    await user.keyboard('{Escape}');
    await user.click(await screen.findByRole('button', { name: '이영희 · 남의 것의 main 동작' }));
    expect(screen.queryByRole('menuitem', { name: '채팅 기본으로' })).toBeNull();
  });

  it('만들기: 만들 에이전트를 고르면 값을 비우고 알린다, 가득 찬 에이전트는 이유와 함께 막힌다, target_pod 를 보내고 그 에이전트로 바꿔 연다(B·디자인 DD7·DD8·리뷰 I8)', async () => {
    const user = userEvent.setup();
    const list = ALL({
      can_edit: true,
      groups: [GROUP({ pod: 'a', name: '마케팅', current: true, count: 2 }), GROUP({ pod: 'b', name: '시험', count: 1 }), GROUP({ pod: 'e', name: '꽉 찬 것', count: 1, profile_limit: { used: 3, max: 3 } })],
    });
    const fn = mountAll('/profiles', list);
    await user.click((await screen.findAllByRole('button', { name: '새 프로파일' }))[0]);
    const dlg = await screen.findByRole('dialog', { name: '새 프로파일' });
    const target = within(dlg).getByRole('combobox', { name: '만들 AI 에이전트 작업공간' });
    expect(target).toHaveValue('마케팅'); // 기본은 지금 에이전트
    await pickAgent(user, within(dlg).getByRole('combobox', { name: '어디서 시작할까요' }), 'ma 을(를) 복제');
    await user.click(target);
    expect(await screen.findByRole('option', { name: /꽉 찬 것.*가득 참 3\/3/ })).toHaveAttribute('aria-disabled', 'true');
    await user.click(screen.getByRole('option', { name: '시험' }));
    expect(within(dlg).getByText('AI 에이전트 작업공간이 바뀌어 시작점을 다시 골랐습니다')).toBeInTheDocument();
    expect(within(dlg).getByRole('combobox', { name: '어디서 시작할까요' })).toHaveValue('');
    await user.type(within(dlg).getByRole('textbox', { name: /이름/ }), 'research');
    await user.click(within(dlg).getByRole('button', { name: '시험에 만들기' }));
    await waitFor(() =>
      expect(postedTo(fn, '/api/profile/action')).toEqual([
        { name: 'research', action: 'create', clone_from: '', no_skills: false, share_skills: false, description: '', target_pod: 'b' },
      ])
    );
    await waitFor(() => expect(postedTo(fn, '/api/pod')).toEqual([{ id: 'b' }]));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/profiles?name=research'));
  });

  it('숨긴 루트(default)는 복제 원본 목록에 없다(사용자 2026-10-19)', async () => {
    const user = userEvent.setup();
    const list = ALL({ can_edit: true, profiles: [...ALL().profiles, ROW({ name: 'default', title: '', is_default: true, hidden_root: true, pod: 'a', pod_name: '마케팅' })] });
    mountAll('/profiles', list);
    await user.click((await screen.findAllByRole('button', { name: '새 프로파일' }))[0]);
    const dlg = await screen.findByRole('dialog', { name: '새 프로파일' });
    expect(await listAgents(user, within(dlg).getByRole('combobox', { name: '어디서 시작할까요' }))).toEqual(['main 을(를) 복제', 'ma 을(를) 복제']);
  });

  it('만들 수 있는 에이전트가 하나면 고르개 대신 「만들 곳」 줄이고, 지금 에이전트에 만들면 바꾸지 않는다(디자인 DD7)', async () => {
    const user = userEvent.setup();
    const list = ALL({ can_edit: true, groups: [GROUP({ pod: 'a', name: '마케팅', current: true, count: 2 }), GROUP({ pod: 'b', name: '시험', count: 1, can_create: false, shared: true })] });
    const fn = mountAll('/profiles', list);
    await user.click((await screen.findAllByRole('button', { name: '새 프로파일' }))[0]);
    const dlg = await screen.findByRole('dialog', { name: '새 프로파일' });
    expect(within(dlg).queryByRole('combobox', { name: '만들 AI 에이전트 작업공간' })).toBeNull();
    expect(within(dlg).getByText('만들 곳')).toBeInTheDocument();
    await user.type(within(dlg).getByRole('textbox', { name: /이름/ }), 'x1');
    await user.click(within(dlg).getByRole('button', { name: '마케팅에 만들기' }));
    await waitFor(() => expect(postedTo(fn, '/api/profile/action')[0]).toMatchObject({ target_pod: 'a' }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/profiles?name=x1'));
    expect(postedTo(fn, '/api/pod')).toEqual([]);
  });

  it('가져오기 후보는 고른 에이전트 기준으로 다시 묻는다(리뷰 I6)', async () => {
    const user = userEvent.setup();
    const groups = [GROUP({ pod: 'a', name: '마케팅', current: true, count: 2 }), GROUP({ pod: 'b', name: '시험', count: 1 })];
    const fn = mountAll('/profiles', ALL({ can_edit: true, groups }), { '/api/profiles/importable': { sources: [] } });
    await user.click((await screen.findAllByRole('button', { name: '새 프로파일' }))[0]);
    const dlg = await screen.findByRole('dialog', { name: '새 프로파일' });
    await waitFor(() => expect(fn.mock.calls.some((c) => String(c[0]) === '/api/profiles/importable?target=a')).toBe(true));
    await pickAgent(user, within(dlg).getByRole('combobox', { name: '만들 AI 에이전트 작업공간' }), '시험');
    await waitFor(() => expect(fn.mock.calls.some((c) => String(c[0]) === '/api/profiles/importable?target=b')).toBe(true));
  });

  it('서랍 개요의 「채팅 기본」: 이 프로파일이면 표시만, 아니면 [채팅 기본으로]로 저장한다(C2)', async () => {
    const user = userEvent.setup();
    const agents = { agents: MY_AGENTS.agents.map((a) => ({ ...a, chat_default: 'main' })) };
    const fn = mountAll('/profiles?name=ma', ALL(), { '/api/agents': agents }, DETAIL());
    const dlg = await screen.findByRole('dialog');
    await user.click(await within(dlg).findByRole('button', { name: '채팅 기본으로' }));
    await waitFor(() => expect(postedTo(fn, '/api/agents/update')).toEqual([{ name: 'a', chat_default: 'ma' }]));
  });

  it('서랍 개요의 「채팅 기본」: 채팅 기본인 프로파일은 단추 없이 「채팅 기본」', async () => {
    const agents = { agents: MY_AGENTS.agents.map((a) => ({ ...a, chat_default: 'ma' })) };
    mountAll('/profiles?name=ma', ALL(), { '/api/agents': agents }, DETAIL());
    const dlg = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dlg).getAllByText('채팅 기본').length).toBeGreaterThan(0));
    expect(within(dlg).queryByRole('button', { name: '채팅 기본으로' })).toBeNull();
  });

  it('에이전트로 거르기(디자인 DD1)와 두 뱃지 설명 글(디자인 DD9)', async () => {
    mountAll('/profiles?tab=all&agent=시험');
    await rowByName(/^main.*시험/);
    expect(screen.queryByRole('row', { name: /^main.*마케팅/ })).toBeNull();
    // 두 뱃지의 뜻은 풍선말 밖에도 목록 아래 설명 글로 보인다(터치·키보드)
    expect(screen.getByText(/주 프로파일: AI 에이전트 작업공간이 처음 만들어질 때 생긴 프로파일입니다.*채팅 기본: 채팅을 열면 먼저 열리는 프로파일입니다/)).toBeInTheDocument();
  });
});

describe('Profiles 상세: 개요', () => {
  it('머리말과 탭, 사실 표, 확인할 것', async () => {
    mount('/profiles?name=ma');
    // 상세는 목록 위 서랍으로 연다. 서랍 머리는 프로파일 이름, 제목(마케팅)은 본문 머리에 있다
    const dlg = await screen.findByRole('dialog', { name: 'ma' });
    expect(await within(dlg).findByText('마케팅')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /스킬/ })).toHaveTextContent('2');
    // 탭 숫자는 작업 목록을 읽으면 그 길이로 바뀐다(처음에는 크론 상태의 jobs_total)
    await waitFor(() => expect(screen.getByRole('tab', { name: /예약 작업/ })).toHaveTextContent('2'));
    expect(screen.getByText('5개 (활성 4개, 실패 1개)')).toBeInTheDocument();
    expect(screen.getByText('사용할 수 있는 스킬 2개 (켜진 것 1개, 이 프로파일 전용 6개)')).toBeInTheDocument();
    expect(screen.getByText('게이트웨이가 꺼져 있음', { selector: 'li' })).toBeInTheDocument();
    const popup = watchChatPopup();
    fireEvent.click(screen.getByRole('button', { name: '대화' }));
    expect(popup()).toMatchObject({ kind: 'chat', agent: 'ma' }); // 대화 팝업(OMAI-1115)
    expect(screen.getByRole('link', { name: '사용량' })).toHaveAttribute('href', '/activity?tab=profiles&q=ma');
  });

  it('확인할 것: 주의·안내는 하나씩 또는 「모두 확인」으로 확인하고, 문제에는 버튼이 없다(2026-10-30)', async () => {
    const issues = [
      { level: 'bad', text: '게이트웨이가 꺼져 있음' },
      { level: 'warn', code: 'pc_import_skills', n: 4, text: '컨테이너에서 읽히지 않는 스킬 4개', ack: true, sig: 'aaaaaaaaaaaaaaaa' },
      { level: 'info', code: 'market_auto_done', text: 'x 스킬을 v1.0.1 로 자동 업그레이드 했습니다', ack: true, sig: 'bbbbbbbbbbbbbbbb' },
    ];
    const fn = mount('/profiles?name=ma', DETAIL({ profile: ROW({ issues }) }), LIST(), { '/api/profile/issue/ack': { ok: true, n: 2 } });
    const dlg = await screen.findByRole('dialog', { name: 'ma' });
    expect(await within(dlg).findAllByRole('button', { name: '확인했습니다' })).toHaveLength(2);
    await userEvent.click(within(dlg).getByRole('button', { name: '모두 확인' }));
    const confirmBox = await screen.findByRole('dialog', { name: /확인/ });
    expect(confirmBox).toHaveTextContent('주의·안내 2건을 모두 확인 처리합니다');
    await userEvent.click(within(confirmBox).getByRole('button', { name: /확인|계속/ }));
    await waitFor(() => expect(postedTo(fn, '/api/profile/issue/ack')).toEqual([{ profile: 'ma', sigs: ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'], code: 'all' }]));
  });

  it('프로파일 제목(마케팅)과 상태 뱃지(게이트웨이)는 본문이 아니라 서랍 머리의 제목 줄에 있다', async () => {
    mount('/profiles?name=ma');
    const dlg = await screen.findByRole('dialog', { name: 'ma' }); // 서랍의 읽는 이름은 그대로 프로파일 이름
    const head = dlg.querySelector('[data-drawer-head]') as HTMLElement;
    const slot = head.querySelector('[data-drawer-badges]') as HTMLElement;
    expect(await within(slot).findByText('마케팅')).toBeInTheDocument();
    expect(slot).toHaveTextContent('게이트웨이 중지됨');
    expect(slot.textContent?.indexOf('마케팅')).toBeLessThan(slot.textContent?.indexOf('게이트웨이') ?? 0); // 제목이 뱃지보다 앞
    // 본문(탭 위)에는 제목·뱃지가 남지 않는다(기본 정보 표의 「게이트웨이」 줄은 그대로 둔다)
    expect(within(dlg).getAllByText('마케팅').every((el) => head.contains(el))).toBe(true);
  });

  it('주 모델을 바꾸면 확인 뒤 model 동작을 보낸다. 같은 모델이면 보내지 않는다', async () => {
    const user = userEvent.setup();
    const fn = mount('/profiles?name=ma');
    const select = await screen.findByRole('combobox', { name: '주 모델' });
    await user.click(screen.getByRole('button', { name: '모델 바꾸기' }));
    expect(await screen.findByText('현재 모델과 같습니다')).toBeInTheDocument();
    expect(postedTo(fn, '/api/profile/action')).toEqual([]);
    await user.selectOptions(select, 'gemma');
    await user.click(screen.getByRole('button', { name: '모델 바꾸기' }));
    expect(await screen.findByText(/주 모델을 qwen3에서 gemma\(으\)로 바꿉니다/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '확인' }));
    await waitFor(() =>
      expect(postedTo(fn, '/api/profile/action')).toEqual([{ name: 'ma', action: 'model', model: 'gemma' }])
    );
  });

  it('LiteLLM 에 없는 현재 모델은 표시를 붙인다', async () => {
    mount('/profiles?name=ma', DETAIL({ models: ['gemma'] }));
    const select = await screen.findByRole('combobox', { name: '주 모델' });
    expect(within(select).getByRole('option', { name: 'qwen3 (LiteLLM 에 없음)' })).toBeInTheDocument();
  });

  it('${HERMES_LLM_MODEL} 은 「이름 (AAS 기본 모델)」 한 줄로 보이고, 같은 이름 모델은 목록에 다시 나오지 않는다', async () => {
    const user = userEvent.setup();
    const REF = '${HERMES_LLM_MODEL}';
    const fn = mount('/profiles?name=ma', DETAIL({ profile: ROW({ model: REF }), default_model: 'qwen3' }));
    const select = await screen.findByRole('combobox', { name: '주 모델' });
    const names = within(select).getAllByRole('option').map((o) => o.textContent);
    expect(names).toEqual(['qwen3 (AAS 기본 모델)', 'gemma']); // qwen3 이 두 번 나오지 않고, LiteLLM 에 없음 표시도 없다
    expect(select).toHaveValue(REF);
    expect(screen.getAllByText('qwen3 (AAS 기본 모델)').length).toBeGreaterThan(0);
    expect(screen.queryByText(REF)).not.toBeInTheDocument(); // 자리표시자 글자는 어디에도 보이지 않는다
    await user.selectOptions(select, 'gemma');
    await user.click(screen.getByRole('button', { name: '모델 바꾸기' }));
    expect(await screen.findByText(/주 모델을 qwen3 \(AAS 기본 모델\)에서 gemma\(으\)로 바꿉니다/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '확인' }));
    await waitFor(() =>
      expect(postedTo(fn, '/api/profile/action')).toEqual([{ name: 'ma', action: 'model', model: 'gemma' }])
    );
  });

  it('고정한 모델에서 「AAS 기본 모델」을 고르면 자리표시자로 되돌린다', async () => {
    const user = userEvent.setup();
    const fn = mount('/profiles?name=ma', DETAIL({ profile: ROW({ model: 'gemma' }), default_model: 'qwen3' }));
    const select = await screen.findByRole('combobox', { name: '주 모델' });
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['qwen3 (AAS 기본 모델)', 'gemma']);
    await user.selectOptions(select, 'qwen3 (AAS 기본 모델)');
    await user.click(screen.getByRole('button', { name: '모델 바꾸기' }));
    await user.click(await screen.findByRole('button', { name: '확인' }));
    await waitFor(() =>
      expect(postedTo(fn, '/api/profile/action')).toEqual([{ name: 'ma', action: 'model', model: '${HERMES_LLM_MODEL}' }])
    );
  });

  it('서버가 기본 모델 이름을 모르면 「AAS 기본 모델」만 보인다', async () => {
    mount('/profiles?name=ma', DETAIL({ profile: ROW({ model: '${HERMES_LLM_MODEL}' }), default_model: '' }));
    const select = await screen.findByRole('combobox', { name: '주 모델' });
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['AAS 기본 모델', 'qwen3', 'gemma']);
  });

  it('기본 모델 이름도 모르고 자리표시자도 쓰지 않으면 「AAS 기본 모델」 줄을 두지 않는다(풀지 못할 글자를 저장하지 않게)', async () => {
    mount('/profiles?name=ma', DETAIL({ default_model: '' }));
    const select = await screen.findByRole('combobox', { name: '주 모델' });
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['qwen3', 'gemma']);
  });

  it('목록 표의 모델 열도 「이름 (AAS 기본 모델)」로 보인다', async () => {
    mount('/profiles', DETAIL(), { ...LIST(), profiles: [ROW({ model: '${HERMES_LLM_MODEL}' })], default_model: 'qwen3' });
    const row = await rowByName(/^마케팅 \(ma\)/);
    expect(row).toHaveTextContent('qwen3 (AAS 기본 모델)');
    expect(row).not.toHaveTextContent('${HERMES_LLM_MODEL}');
  });

  it('게이트웨이가 꺼져 있으면 시작을 확인 뒤 보낸다', async () => {
    const user = userEvent.setup();
    const fn = mount('/profiles?name=ma');
    await user.click(await screen.findByRole('button', { name: '시작' }));
    expect(await screen.findByText('게이트웨이를 시작합니다. 예약 작업과 채널이 다시 실행됩니다.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '확인' }));
    await waitFor(() =>
      expect(postedTo(fn, '/api/profile/action')).toEqual([{ name: 'ma', action: 'gateway', op: 'start' }])
    );
  });

  it('돌고 있는 프로파일은 재시작과 멈추기를 낸다', async () => {
    mount('/profiles?name=ma', DETAIL({ profile: ROW({ running: true }) }));
    expect(await screen.findByRole('button', { name: '재시작' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '중지' })).toBeInTheDocument();
    // 단추 앞 아이콘
    expect(screen.getByRole('button', { name: '재시작' }).querySelector('[data-testid="RestartAltIcon"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: '중지' }).querySelector('[data-testid="StopCircleOutlinedIcon"]')).not.toBeNull();
  });

  it('쿠버네티스의 이름 있는 프로파일은 기본 게이트웨이가 함께 돌린다고 알리고 재시작만 낸다(2026-10-14)', async () => {
    const user = userEvent.setup();
    for (const running of [false, true]) {
      const fn = mount('/profiles?name=ma', DETAIL({ profile: ROW({ running }), gateway_shared: true }));
      expect(await screen.findByText(/AI 에이전트 작업공간의 기본 게이트웨이가 이 프로파일의 예약 작업·채널도 함께 돌립니다/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '시작' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '중지' })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: '재시작' }));
      expect(await screen.findByText(/이 AI 에이전트 작업공간의 모든 프로파일/)).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: '확인' }));
      await waitFor(() =>
        expect(postedTo(fn, '/api/profile/action')).toEqual([{ name: 'ma', action: 'gateway', op: 'restart' }])
      );
      cleanup();
    }
  });

  it('관리자가 아니면 보기 전용 안내만 있고 바꾸는 버튼이 없다', async () => {
    mount('/profiles?name=ma', DETAIL({ can_edit: false }));
    expect(await screen.findByText('보기 전용입니다. 관리자만 바꿀 수 있습니다')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '모델 바꾸기' })).not.toBeInTheDocument();
    for (const name of ['내보내기', '이름 바꾸기', '삭제']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument(); // 머리 동작 단추 없음
  });

  it('서랍 머리 태그: 주인에게는 「내 전용」, 관리자가 남의 에이전트를 열면 「<이름>님 전용」과 설정 링크(스펙 2026-10-15-011 단계 1a)', async () => {
    mount('/profiles?name=ma&pane=soul', DETAIL({ can_edit: false, owner: true }));
    expect(await screen.findByText('내 전용')).toBeInTheDocument();
    expect(screen.queryByText(/님 전용/)).not.toBeInTheDocument();
    cleanup();
    mount('/profiles?name=ma&pane=soul', DETAIL({ can_edit: true, owner: false, owner_name: '김민수' }));
    expect(await screen.findByText('김민수님 전용')).toBeInTheDocument();
    expect(screen.queryByText('내 전용')).not.toBeInTheDocument();
    expect(screen.getByText(/이 사용자에게만 적용됩니다/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '설정' })).toHaveAttribute('href', '/settings');
  });

  it('주인 이름이 없으면(관리자가 아닌 사람·자기 에이전트) 「님 전용」 태그가 없다', async () => {
    mount('/profiles?name=ma&pane=soul', DETAIL({ can_edit: false, owner: false }));
    await screen.findByText('보기 전용입니다. 관리자만 바꿀 수 있습니다');
    expect(screen.queryByText(/님 전용/)).not.toBeInTheDocument();
    expect(screen.queryByText('내 전용')).not.toBeInTheDocument();
  });

  it('에이전트 주인은 SOUL·설정 파일을 고치고 스킬·도구·MCP 를 켜고 끄지만 모델은 못 바꾼다(OMAI-1126, OMAI-1193, 스펙 2026-10-15-011 단계 1b)', async () => {
    const user = userEvent.setup();
    mount('/profiles?name=ma&pane=soul', DETAIL({ can_edit: false, owner: true }));
    const scope = await screen.findByText(/내 AI 에이전트 작업공간의 프로파일입니다/);
    // 머리말은 실제 권한을 말한다: 설정 파일·MCP 도 주인이 고치고, 관리자만 바꾸는 것은 모델·제공자·게이트웨이·터미널 실행 위치다
    expect(scope).toHaveTextContent('MCP');
    expect(scope).toHaveTextContent('설정 파일');
    expect(scope).toHaveTextContent('모델·제공자·게이트웨이·터미널 실행 위치는 관리자만');
    expect(scope).not.toHaveTextContent('나머지는 관리자');
    expect(await screen.findByRole('button', { name: '고치기' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /설정\(config\)/ }));
    expect(await screen.findByRole('button', { name: '고치기' })).toBeInTheDocument();           // 주인도 설정 파일을 고친다
    expect(screen.getByText(/터미널 실행 위치\(backend 등\)/)).toBeInTheDocument();                         // 잠긴 설정 안내
    expect(screen.getByText(/명령 승인\(approvals\)/)).toBeInTheDocument();                                  // 승인 설정도 관리자만(스펙 2026-10-24-001 D2)
    expect(screen.queryByText('관리자만 고칠 수 있습니다')).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /스킬/ }));
    expect(await screen.findByRole('switch', { name: 'report 스킬 켜기' })).toBeEnabled();
    await user.click(screen.getByRole('tab', { name: /도구 묶음/ }));
    expect(await screen.findByRole('switch', { name: '웹 도구 묶음 켜기' })).toBeEnabled();      // OMAI-1193: 주인에게 도구 스위치를 연다
    expect(screen.getByRole('switch', { name: 'chart MCP 서버 켜기' })).toBeEnabled();           // 단계 1b: MCP 켜고 끄기도
    expect(screen.getByRole('button', { name: '연결 시험' })).toBeEnabled();
  });

  it('팀 관리자는 팀원 프로파일을 주인처럼 고치지만 「내 전용」 태그는 없다(스펙 2026-10-22-001, OKE 실화면 확인에서 찾음)', async () => {
    const user = userEvent.setup();
    mount('/profiles?name=ma&pane=soul', DETAIL({ can_edit: false, owner: false, manages: true }));
    const scope = await screen.findByText(/팀원 AI 에이전트 작업공간의 프로파일입니다/);
    expect(scope).toHaveTextContent('모델·제공자·게이트웨이·터미널 실행 위치는 관리자만');
    expect(screen.queryByText('보기 전용입니다. 관리자만 바꿀 수 있습니다')).not.toBeInTheDocument();
    expect(screen.queryByText('내 전용')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '고치기' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /스킬/ }));
    expect(await screen.findByRole('switch', { name: 'report 스킬 켜기' })).toBeEnabled();
    await user.click(screen.getByRole('tab', { name: /도구 묶음/ }));
    expect(await screen.findByRole('switch', { name: '웹 도구 묶음 켜기' })).toBeEnabled();
    expect(screen.getByRole('switch', { name: 'chart MCP 서버 켜기' })).toBeEnabled();
  });

  it('주인도 관리자도 아닌 사람은 도구 스위치를 못 바꾼다(OMAI-1193)', async () => {
    mount('/profiles?name=ma&pane=tools', DETAIL({ can_edit: false, owner: false }));
    expect(await screen.findByRole('switch', { name: '웹 도구 묶음 켜기' })).toBeDisabled();
  });

  it('꺼진 도구에 「사용할 수 없음」을 붙이지 않고 설정이 필요한 것만 「설정 필요」를 붙인다(OMAI-1193)', async () => {
    mount(
      '/profiles?name=ma&pane=tools',
      DETAIL({
        toolsets: [
          { name: 'kanban', label: 'Kanban', description: '보드', tools: 14, enabled: false, configured: true },
          { name: 'homeassistant', label: 'Home Assistant', description: '집', tools: 4, enabled: false, configured: false },
        ],
      })
    );
    expect(await screen.findByRole('switch', { name: 'Kanban 도구 묶음 켜기' })).not.toBeChecked();
    expect(screen.queryByText('사용할 수 없음')).not.toBeInTheDocument();
    expect(screen.getAllByText('설정 필요')).toHaveLength(1);
  });

  it('MCP · 도구 묶음 탭은 이름·주소·설명으로 찾고 켜짐·꺼짐으로 거른다(스펙 2026-10-23-007)', async () => {
    const user = userEvent.setup();
    mount(
      '/profiles?name=ma&pane=tools',
      DETAIL({
        mcp: [
          { name: 'outline', transport: 'http', target: 'https://opsknow.example/mcp', env_names: [], enabled: true },
          { name: 'chart', transport: 'stdio', target: 'npx chart', env_names: [], enabled: false },
        ],
        toolsets: [
          { name: 'web', label: 'Web Search', description: 'web_search, web_extract', tools: 2, enabled: true, configured: true },
          { name: 'browser', label: 'Browser Automation', description: 'navigate, click', tools: 14, enabled: false, configured: true },
        ],
      })
    );
    const search = await screen.findByRole('searchbox', { name: 'MCP 서버·도구 묶음 검색' });
    await user.type(search, 'opsknow');                                                    // 주소로 찾는다
    expect(screen.getByRole('switch', { name: 'outline MCP 서버 켜기' })).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'chart MCP 서버 켜기' })).not.toBeInTheDocument();
    expect(screen.getByText('해당하는 도구 묶음이 없습니다')).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, 'CLICK');                                                      // 설명으로, 대소문자 없이
    expect(screen.getByRole('switch', { name: 'Browser Automation 도구 묶음 켜기' })).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Web Search 도구 묶음 켜기' })).not.toBeInTheDocument();
    expect(screen.getByText('해당하는 MCP 서버가 없습니다')).toBeInTheDocument();
    await user.clear(search);
    await user.click(screen.getByRole('button', { name: '꺼짐' }));
    expect(screen.getByRole('switch', { name: 'chart MCP 서버 켜기' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Browser Automation 도구 묶음 켜기' })).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'outline MCP 서버 켜기' })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Web Search 도구 묶음 켜기' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '켜짐' }));
    expect(screen.getByRole('switch', { name: 'Web Search 도구 묶음 켜기' })).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'chart MCP 서버 켜기' })).not.toBeInTheDocument();
  });

  it('읽지 못한 부분이 있으면 안내한다', async () => {
    mount('/profiles?name=ma', DETAIL({ notes: ['env 를 읽지 못했습니다'] }));
    expect(await screen.findByText('일부를 읽지 못했습니다:')).toBeInTheDocument();
    expect(screen.getByText('env 를 읽지 못했습니다')).toBeInTheDocument();
  });

  it('작업공간이 다시 뜨는 중이면 연결 오류 목록 대신 「다시 시작하는 중」을 알린다(스펙 2026-10-23-008)', async () => {
    const down = 'Hermes API 서버에 연결할 수 없습니다: URLError';
    mount('/profiles?name=ma', DETAIL({ restarting: true, notes: [`soul: ${down}`, `mcp: ${down}`] }));
    expect(await screen.findByText(/AI 에이전트 작업공간을 다시 시작하는 중이라 프로파일을 읽지 못했습니다/)).toBeInTheDocument();
    expect(screen.queryByText('일부를 읽지 못했습니다:')).not.toBeInTheDocument();
    expect(screen.queryByText(/URLError/)).not.toBeInTheDocument();
  });

  it('작업공간이 다시 뜨는 중이면 탭 본문도 노란 「읽지 못했습니다」 대신 회색 한 줄을 보인다(스펙 2026-10-23-008)', async () => {
    const user = userEvent.setup();
    const down = 'Hermes API 서버에 연결할 수 없습니다: URLError';
    mount(
      '/profiles?name=ma&pane=soul',
      DETAIL({ restarting: true, notes: [`soul: ${down}`], soul: null, config: null, skills: null, env: null, mcp: null, toolsets: null, agents: { readonly_reason: 'read_error' } })
    );
    expect(await screen.findByText('다시 시작이 끝나면 보입니다.')).toBeInTheDocument();
    expect(screen.queryByText(/성격\(SOUL\)을 읽지 못했습니다/)).not.toBeInTheDocument();
    for (const [tab, gone] of [
      [/설정\(config\)/, /설정을 읽지 못했습니다/],
      [/작업지침/, '파일을 읽지 못했습니다.'],                                          // 문장 그대로(위 안내의 「프로파일을 읽지 못했습니다」와 겹치지 않게)
      [/비밀값/, /비밀값 목록을 읽지 못했습니다/],
      [/스킬/, /스킬 목록을 읽지 못했습니다/],
      [/도구 묶음/, /목록을 읽지 못했습니다/],
    ] as const) {
      await user.click(screen.getByRole('tab', { name: tab }));
      expect((await screen.findAllByText('다시 시작이 끝나면 보입니다.')).length).toBeGreaterThan(0);
      expect(screen.queryByText(gone)).not.toBeInTheDocument();
    }
  });

  it('같은 이유로 읽지 못한 부분은 한 줄로 묶어 목록으로 보인다', async () => {
    const down = 'Hermes API 서버에 연결할 수 없습니다: URLError';
    mount('/profiles?name=ma', DETAIL({ notes: [`soul: ${down}`, `config: ${down}`, 'skills: 권한이 없습니다', `env: ${down}`] }));
    const items = within(await screen.findByRole('list', { name: '일부를 읽지 못했습니다:' })).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([`soul · config · env: ${down}`, 'skills: 권한이 없습니다']);
  });

  it('읽지 못한 부분이 있으면 다시 읽어 회복되면 안내를 지운다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let calls = 0;
      mount('/profiles?name=ma', () => DETAIL({ notes: calls++ === 0 ? ['soul: Hermes API 서버에 연결할 수 없습니다: URLError'] : [] }));
      expect(await screen.findByText('일부를 읽지 못했습니다:')).toBeInTheDocument();
      await vi.advanceTimersByTimeAsync(15000);
      await waitFor(() => expect(screen.queryByText('일부를 읽지 못했습니다:')).not.toBeInTheDocument());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Profiles 상세 서랍', () => {
  it('상세는 목록 위 서랍으로 열고, 닫으면 주소에서 name·pane 을 지운다', async () => {
    const user = userEvent.setup();
    mount('/profiles?name=ma&pane=cron');
    const dlg = await screen.findByRole('dialog', { name: 'ma' });
    expect(await within(dlg).findByRole('tab', { name: /예약 작업/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { level: 1, name: '프로파일', hidden: true })).toBeInTheDocument(); // 뒤에 목록이 있다(서랍이 열린 동안 보조기기에서 가려진다)
    await user.click(within(dlg).getAllByRole('button', { name: '닫기' })[0]);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByTestId('loc')).toHaveTextContent(/^\/profiles$/);
  });

  it('목록의 탭을 둔 채 행을 눌러 서랍을 열고, 서랍 안에서 탭을 바꾸고, 닫아도 목록 탭이 남는다', async () => {
    const user = userEvent.setup();
    mount('/profiles?tab=all');
    await user.click(await rowByName(/^마케팅/));
    expect(screen.getByTestId('loc')).toHaveTextContent('/profiles?tab=all&name=ma');
    const dlg = await screen.findByRole('dialog', { name: 'ma' });
    await user.click(await within(dlg).findByRole('tab', { name: /예약 작업/ }));
    expect(screen.getByTestId('loc')).toHaveTextContent('/profiles?tab=all&name=ma&pane=cron');
    await user.click(within(dlg).getAllByRole('button', { name: '닫기' })[0]);
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/profiles\?tab=all$/));
  });

  it('머리의 「이름 바꾸기」 대화 상자를 취소하면 상세 서랍이 그대로다', async () => {
    const user = userEvent.setup();
    mount('/profiles?name=ma');
    await user.click(await screen.findByRole('button', { name: '이름 바꾸기' }));
    const rename = await screen.findByRole('dialog', { name: '이름 바꾸기' });
    await user.click(within(rename).getByRole('button', { name: '취소' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '이름 바꾸기' })).toBeNull());
    expect(await screen.findByRole('dialog', { name: 'ma' })).toBeInTheDocument();
    expect(screen.getByTestId('loc')).toHaveTextContent('name=ma');
  });

  it('저장하지 않은 편집이 있으면 서랍을 닫기 전에 묻고, 취소하면 닫지 않는다', async () => {
    const user = userEvent.setup();
    mount('/profiles?name=ma&pane=soul');
    await user.click(await screen.findByRole('button', { name: '고치기' }));
    await user.type(screen.getByRole('textbox', { name: /ma 의 SOUL.md 고치기/ }), '!');
    await user.click(screen.getAllByRole('button', { name: '닫기', hidden: true }).find((b) => b.closest('[role=dialog]'))!);
    expect(await screen.findByText('저장하지 않은 수정이 있습니다. 버리고 넘어갈까요?')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: '취소' }));
    expect(await screen.findByRole('dialog', { name: 'ma' })).toBeInTheDocument();
    expect(screen.getByTestId('loc')).toHaveTextContent('name=ma');
  });

  // 스펙 2026-10-28-014 D6: 뒤로 가기는 주소가 바뀐 뒤에 묻는다. 묻는 동안 본문이 바뀐 주소(pane 없음)로 다시 그려져
  // 편집기가 닫히고 고친 글이 사라졌다(OKE 2026-10-29). 취소하면 고치던 편집이 그대로 남아야 한다
  it('성격을 고치는 중에 뒤로 가기를 눌러 묻는 창에서 취소하면 편집기와 고친 글·「저장하지 않음」이 그대로다', async () => {
    const user = userEvent.setup();
    mount('/profiles', DETAIL(), LIST(), {}, true);
    await user.click(await rowByName(/^마케팅/));
    const dlg = await screen.findByRole('dialog', { name: 'ma' });
    await user.click(await within(dlg).findByRole('tab', { name: /성격\(SOUL\)/ }));
    expect(screen.getByTestId('loc')).toHaveTextContent(/^\/profiles\?name=ma&pane=soul$/);
    await user.click(await within(dlg).findByRole('button', { name: '고치기' }));
    await user.type(within(dlg).getByRole('textbox', { name: /ma 의 SOUL.md 고치기/ }), '!');
    expect(within(dlg).getByText(/저장하지 않음/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '뒤로 가기', hidden: true }));
    expect(await screen.findByText('저장하지 않은 수정이 있습니다. 버리고 넘어갈까요?')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: '취소' }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/profiles\?name=ma&pane=soul$/));
    const after = await screen.findByRole('dialog', { name: 'ma' });
    expect(within(after).getByRole('textbox', { name: /ma 의 SOUL.md 고치기/ })).toHaveValue('# 성격\n친절하게!');
    expect(within(after).getByText(/저장하지 않음/)).toBeInTheDocument();
  });
});

describe('Profiles 상세: 성격과 설정', () => {
  it('SOUL 을 고쳐 저장하면 미리 보기 검사 뒤 soul 동작에 sha 와 메모를 보낸다', async () => {
    const user = userEvent.setup();
    const fn = mount('/profiles?name=ma&pane=soul');
    await user.click(await screen.findByRole('button', { name: '고치기' }));
    await user.type(screen.getByRole('textbox', { name: /ma 의 SOUL.md 고치기/ }), '!');
    await user.click(screen.getByRole('button', { name: /바뀐 줄 확인/ }));
    await user.type(await screen.findByRole('textbox', { name: '저장 메모' }), '말투');
    await user.click(screen.getByRole('button', { name: '이대로 저장' }));
    await waitFor(() => {
      const acts = postedTo(fn, '/api/profile/action');
      expect(acts[0]).toMatchObject({ name: 'ma', action: 'soul_preview' });
      expect(acts[1]).toEqual({
        name: 'ma',
        action: 'soul',
        content: '# 성격\n친절하게!',
        base_sha: 'ss1',
        note: '말투',
      });
    });
  });

  it('SOUL 을 고치는 중에 설정(config) 탭으로 가면 설정 글을 보기 상태로 보인다(SOUL 편집 상태를 넘기지 않는다)', async () => {
    const user = userEvent.setup();
    mount('/profiles?name=ma&pane=soul');
    await user.click(await screen.findByRole('button', { name: '고치기' }));
    expect(screen.getByRole('textbox', { name: /ma 의 SOUL.md 고치기/ })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /설정\(config\)/ }));
    expect(await screen.findByText('model: qwen3')).toBeInTheDocument();
    expect(screen.queryByText('친절하게')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /고치기/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '고치기' })).toBeInTheDocument();
  });

  it('SOUL 이 쓰이는 열린 방을 편집기 위에 알리고, 저장하면 알린 방 수를 스낵바로 보인다(OMAI-1126 DT5·ET4)', async () => {
    const user = userEvent.setup();
    const base = mount('/profiles?name=ma&pane=soul', DETAIL({ rooms: { names: ['제안 TFT'], others: 1 } }));
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) =>
        url.startsWith('/api/profile/action') && String(init?.body).includes('"action":"soul"')
          ? Promise.resolve(new Response(JSON.stringify({ ok: true, notice: { rooms: 2 } }), { status: 200 }))
          : base(url, init)
      )
    );
    expect(await screen.findByText(/열린 방 2곳\(제안 TFT, 이름을 볼 수 없는 방 1곳\)에서 쓰입니다/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '고치기' }));
    await user.type(screen.getByRole('textbox', { name: /ma 의 SOUL.md 고치기/ }), '!');
    await user.click(screen.getByRole('button', { name: /바뀐 줄 확인/ }));
    expect(await screen.findByText('방 알림에 함께 보입니다')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '이대로 저장' }));
    expect(await screen.findByText('ma 의 SOUL.md 을(를) 저장했습니다 · 열린 방 2곳에 알렸습니다')).toBeInTheDocument();
  });

  it('방 알림만 실패하면 저장은 성공으로 두고 따로 알린다', async () => {
    const user = userEvent.setup();
    const base = mount('/profiles?name=ma&pane=soul');
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) =>
        url.startsWith('/api/profile/action') && String(init?.body).includes('"action":"soul"')
          ? Promise.resolve(new Response(JSON.stringify({ ok: true, notice: { rooms: 0, failed: true } }), { status: 200 }))
          : base(url, init)
      )
    );
    expect(screen.queryByText(/에서 쓰입니다/)).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: '고치기' }));
    await user.type(screen.getByRole('textbox', { name: /ma 의 SOUL.md 고치기/ }), '!');
    await user.click(screen.getByRole('button', { name: /바뀐 줄 확인/ }));
    await user.click(await screen.findByRole('button', { name: '이대로 저장' }));
    expect(await screen.findByText('ma 의 SOUL.md 을(를) 저장했습니다')).toBeInTheDocument();
    expect(await screen.findByText('방 알림을 남기지 못했습니다')).toBeInTheDocument();
  });

  it('비밀값처럼 보이는 줄이 있으면 고칠 수 없고 이유를 보인다', async () => {
    mount(
      '/profiles?name=ma&pane=config',
      DETAIL({ config: { lines: ['key: sk-xxx'], sha: 'c', versions: 0, masked_lines: [1] } })
    );
    expect(await screen.findByText('비밀값으로 보이는 줄이 있어 여기서는 고칠 수 없습니다')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '고치기' })).not.toBeInTheDocument();
  });

  it('SOUL·config 는 줄·글자 수 앞에 실제 파일 위치(데이터 폴더 기준)를 보인다. 기본 프로파일은 폴더 바로 아래다(2026-10-17-016)', async () => {
    mount('/profiles?name=ma&pane=config');
    expect(await screen.findByText('profiles/ma/config.yaml')).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('기본(루트) 프로파일의 SOUL 은 데이터 폴더 바로 아래 SOUL.md 다', async () => {
    mount('/profiles?name=default&pane=soul', DETAIL({ profile: ROW({ name: 'default', is_default: true }) }));
    expect(await screen.findByText('SOUL.md')).toBeInTheDocument();
  });

  it('config 는 코드 방식으로 열린다', async () => {
    const user = userEvent.setup();
    mount('/profiles?name=ma&pane=config');
    await user.click(await screen.findByRole('button', { name: '고치기' }));
    expect(screen.getByText(/코드 모드/)).toBeInTheDocument();
  });
});

describe('Profiles 상세: 비밀값', () => {
  it('채워진 것만 보이고 값은 보이지 않는다. 모두 보기로 빈 것도 본다', async () => {
    const user = userEvent.setup();
    mount('/profiles?name=ma&pane=env');
    expect(await screen.findByText('OPENAI_API_KEY')).toBeInTheDocument();
    expect(screen.queryByText('SLACK_TOKEN')).not.toBeInTheDocument();
    expect(screen.getByText('값이 있는 것 1개')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /Hermes 가 아는 변수 모두 보기 \(2\)/ }));
    expect(screen.getByText('SLACK_TOKEN')).toBeInTheDocument();
    expect(screen.getByText('채널용')).toBeInTheDocument();
  });

  it('번역된 설명은 원문을 풍선말로 보이고, 영어 원문으로도 찾는다. 분류 태그도 번역한다(스펙 2026-10-21-003)', async () => {
    const user = userEvent.setup();
    const env = [
      { name: 'A2A_PORT', set: true, description: 'A2A 서버가 받는 포트(기본값 9900).', description_src: 'Inbound A2A server port (default 9900).', category: 'messaging' },
      { name: 'MY_KEY', set: true, description: '', category: 'unknown-cat' },
    ];
    mount('/profiles?name=ma&pane=env', DETAIL({ env }));
    const desc = await screen.findByText('A2A 서버가 받는 포트(기본값 9900).');
    expect(desc).toHaveAttribute('title', 'Inbound A2A server port (default 9900).');
    expect(screen.getByText('메신저')).toBeInTheDocument();
    expect(screen.getByText('unknown-cat')).toBeInTheDocument(); // 모르는 분류는 원문
    await user.type(screen.getByRole('searchbox', { name: '비밀값 이름 검색' }), 'inbound');
    expect(screen.getByText('A2A_PORT')).toBeInTheDocument();
    expect(screen.queryByText('MY_KEY')).toBeNull();
  });

  it('주인 화면: 잠긴 변수는 기본으로 접히고, 켜면 단추 없이 잠금 사유만 보인다(디자인 결정 2C)', async () => {
    const user = userEvent.setup();
    const env = [
      { name: 'SERPER_API_KEY', set: true, description: '검색', category: 'tool', locked: '' },
      { name: 'OPENAI_API_KEY', set: true, description: 'OpenAI 키', category: 'provider', locked: 'OPENAI_API_KEY 는 모델 제공자·동작 설정 값이라 관리자만 바꿉니다.' },
      { name: 'ANTHROPIC_API_KEY', set: false, description: 'Anthropic 키', category: 'provider', locked: 'ANTHROPIC_API_KEY 는 모델 제공자·동작 설정 값이라 관리자만 바꿉니다.' },
    ];
    mount('/profiles?name=ma&pane=env', DETAIL({ can_edit: false, owner: true, secure: true, env }));
    expect(await screen.findByText('SERPER_API_KEY')).toBeInTheDocument();
    expect(screen.getByText('OPENAI_API_KEY')).toBeInTheDocument();                                // 값이 있는 잠긴 변수는 기본 목록에 남아 잠금 사유와 함께 보인다
    const locked = (await screen.findByText('OPENAI_API_KEY')).closest('[data-item-row]') as HTMLElement;
    expect(within(locked).getByText('잠금')).toBeInTheDocument();
    expect(within(locked).getByText(/관리자만 바꿉니다/)).toBeInTheDocument();
    expect(within(locked).queryByRole('button', { name: '값 바꾸기' })).toBeNull();
    const row = screen.getByText('SERPER_API_KEY').closest('[data-item-row]') as HTMLElement;
    expect(within(row).getByRole('button', { name: '값 바꾸기' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /잠긴 변수도 보기 \(2\)/ })).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /Hermes 가 아는 변수 모두 보기/ }));
    expect(screen.queryByText('ANTHROPIC_API_KEY')).toBeNull();                                    // 비어 있는 잠긴 변수는 기본으로 접혀 있다
    await user.click(screen.getByRole('checkbox', { name: /잠긴 변수도 보기/ }));
    expect(screen.getByText('ANTHROPIC_API_KEY')).toBeInTheDocument();
  });

  it('서버가 값을 거절하면 값을 넣던 칸 아래에 문구를 보이고 칸으로 포커스를 돌린다(디자인 결정 2A)', async () => {
    const user = userEvent.setup();
    const base = mount('/profiles?name=ma&pane=env');
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) =>
        url.startsWith('/api/profile/action') && String(init?.body).includes('env_set')
          ? Promise.resolve(new Response(JSON.stringify({ error: 'OPENAI_API_KEY 는 관리자만 바꿉니다.', reason: 'provider_key', field: 'OPENAI_API_KEY' }), { status: 403 }))
          : base(url, init)
      )
    );
    await user.click(await screen.findByRole('button', { name: '값 바꾸기' }));
    const box = screen.getByLabelText('OPENAI_API_KEY 의 새 값');
    await user.type(box, 'sk-x');
    await user.click(screen.getByRole('button', { name: '저장' }));
    await user.click(await screen.findByRole('button', { name: '확인' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('OPENAI_API_KEY 는 관리자만 바꿉니다.');
    await waitFor(() => expect(box).toHaveFocus());
    expect(box).toHaveAttribute('aria-invalid', 'true');
  });

  it('상세 caps 의 막힌 이유 코드로 비밀값 탭의 안내를 정한다(디자인 결정 1A)', async () => {
    mount('/profiles?name=ma&pane=env', DETAIL({ can_edit: false, owner: true, secure: true, caps: { env: { can: false, reason: 'hidden_root' } } }));
    expect(await screen.findByText(/숨겨진 루트\(default\)는 바꿀 수 없습니다/)).toBeInTheDocument();
  });

  it('비밀값 줄도 스킬 탭과 같은 줄 모양(아이콘·이름·설명·오른쪽 단추)이다', async () => {
    mount('/profiles?name=ma&pane=env');
    const row = (await screen.findByText('OPENAI_API_KEY')).closest('[data-item-row]') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.querySelector('[data-item-icon]')).toHaveAttribute('aria-hidden', 'true');
    expect(within(row).getByText('OpenAI 키')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: '값 바꾸기' })).toBeInTheDocument();
  });

  it('값 바꾸기는 지금 값을 덮어쓴다고 확인을 받은 뒤 env_set 으로 보낸다(OMAI-1135)', async () => {
    const user = userEvent.setup();
    const fn = mount('/profiles?name=ma&pane=env');
    await user.click(await screen.findByRole('button', { name: '값 바꾸기' }));
    await user.type(screen.getByLabelText('OPENAI_API_KEY 의 새 값'), 'sk-new');
    await user.click(screen.getByRole('button', { name: '저장' }));
    expect(await screen.findByText(/OPENAI_API_KEY 의 지금 값을 새 값으로 바꿉니다/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '취소' }));
    expect(postedTo(fn, '/api/profile/action')).toEqual([]);
    await user.click(await screen.findByRole('button', { name: '저장' }));
    await user.click(await screen.findByRole('button', { name: '확인' }));
    await waitFor(() =>
      expect(postedTo(fn, '/api/profile/action')).toEqual([
        { name: 'ma', action: 'env_set', target: 'OPENAI_API_KEY', value: 'sk-new' },
      ])
    );
  });

  it('지우기는 이름을 다시 입력해야 env_clear 로 보낸다', async () => {
    const user = userEvent.setup();
    const fn = mount('/profiles?name=ma&pane=env');
    await user.click(await screen.findByRole('button', { name: '지우기' }));
    await user.type(screen.getByRole('textbox', { name: '확인용 이름' }), 'OPENAI_API_KEY');
    await user.click(screen.getByRole('button', { name: '지우기' }));
    await waitFor(() =>
      expect(postedTo(fn, '/api/profile/action')).toEqual([
        { name: 'ma', action: 'env_clear', target: 'OPENAI_API_KEY', confirm: 'OPENAI_API_KEY' },
      ])
    );
  });

  it('암호화되지 않은 주소에서는 값을 넣을 수 없다고 알리고 버튼을 빼다', async () => {
    mount('/profiles?name=ma&pane=env', DETAIL({ secure: false }));
    expect(await screen.findByText(/암호화되지 않은 주소/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '값 바꾸기' })).not.toBeInTheDocument();
  });

  it('새 변수는 이름 형식을 검사한다', async () => {
    const user = userEvent.setup();
    mount('/profiles?name=ma&pane=env');
    await user.type(await screen.findByRole('textbox', { name: '새 변수 이름' }), 'bad name');
    await user.click(screen.getByRole('button', { name: '새 비밀값 넣기' }));
    expect(await screen.findByText('이름은 영문 대문자, 숫자, _ 로만 적을 수 있습니다')).toBeInTheDocument();
  });
});

describe('Profiles 상세: 스킬·도구·크론', () => {
  it('스킬 탭의 「새 스킬」은 이 프로파일로 새 스킬 서랍을 열고, 만든 뒤 스킬 화면으로 가지 않고 탭에 머문다(2026-10-17-017)', async () => {
    const user = userEvent.setup();
    const fn = mount('/profiles?name=ma&pane=skills', DETAIL(), LIST(), { '/api/skill/create': { name: 'my-skill' } });
    await user.click(await screen.findByRole('button', { name: '새 스킬' }));
    const box = await screen.findByRole('dialog', { name: '새 스킬' });
    const where = within(box).getByRole('combobox', { name: /쓰는 곳|누가 쓰나/ }) as HTMLSelectElement;
    expect([...where.options].map((o) => o.value)).toEqual(['ma']); // 이 프로파일만 고를 수 있다
    // 틀을 그대로 두면 만들지 않으므로 「언제 쓰나」를 채운다(2026-10-28-004)
    const body = within(box).getByLabelText('스킬 본문') as HTMLTextAreaElement;
    fireEvent.change(body, { target: { value: body.value + '\n## 메모\n보고서를 만든다\n' } });
    await user.type(within(box).getByRole('textbox', { name: /이름/ }), 'my-skill');
    await user.click(within(box).getByRole('button', { name: '스킬 만들기' }));
    await waitFor(() => expect(postedTo(fn, '/api/skill/create')[0]).toMatchObject({ profile: 'ma', name: 'my-skill' }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/profiles?name=ma&pane=skills'));
  });

  it('스킬을 바꿀 권한이 없으면 「새 스킬」이 없다', async () => {
    mount('/profiles?name=ma&pane=skills', DETAIL({ can_edit: false, owner: false, caps: { skills: { can: false, reason: 'not_owner' } } }));
    await screen.findByText('report');
    expect(screen.queryByRole('button', { name: '새 스킬' })).toBeNull();
  });

  // 회귀 계약(스펙 2026-10-27-011 R13·D6, 디자인 D9): 「스킬」 화면과 같은 판정. 바꾸지 않을 동작 — 같은 프로파일만 센다·처음엔 꺼짐·검색과 함께 거른다·목록에 없는 줄은 뺀다
  it('「내 스킬만」은 기본 제공(Hermes 기본·AAS 기본)만 빼고, 같은 프로파일만 세며 처음엔 꺼져 있다(2026-10-27-011 R13)', async () => {
    const user = userEvent.setup();
    const skills = ['market', 'hub', 'bundled_modified', 'local', 'agent', 'bundled', 'aas'].map((o) => ({ name: `s-${o}`, description: '', enabled: true }));
    const detail = DETAIL({ skills: [...skills, { name: 's-unknown', description: '', enabled: true }] });
    mount('/profiles?name=ma&pane=skills', detail, LIST(), {
      '/api/skills': {
        skills: [
          ...['market', 'hub', 'bundled_modified', 'local', 'agent', 'bundled', 'aas'].map((o) => ({ id: `ma:${o}`, name: `s-${o}`, profile: 'ma', origin: o })),
          { id: 'other:x', name: 's-bundled', profile: 'other', origin: 'local' },   // 다른 프로파일 줄은 세지 않는다
        ],
      },
    });
    const box = await screen.findByRole('checkbox', { name: '내 스킬만 (5)' });
    expect(box).not.toBeChecked();                                                     // 처음엔 꺼짐
    expect(screen.getByText('s-bundled')).toBeInTheDocument();
    await user.click(box);
    for (const o of ['market', 'hub', 'bundled_modified', 'local', 'agent']) expect(screen.getByText(`s-${o}`)).toBeInTheDocument();
    for (const o of ['bundled', 'aas', 'unknown']) expect(screen.queryByText(`s-${o}`)).toBeNull();   // 목록에 없는 줄(출처 모름)도 뺀다
    await user.type(screen.getByRole('searchbox', { name: /스킬 검색|검색/ }), 'hub');
    expect(screen.getByText('s-hub')).toBeInTheDocument();
    expect(screen.queryByText('s-local')).toBeNull();                                  // 검색어와 함께 거른다
  });

  it('「내 스킬만」: 목록을 받는 중이면 (—)·잠김, 받지 못하면 숨김, 켜서 0개면 사실대로 알린다(디자인 D9)', async () => {
    const user = userEvent.setup();
    let release: (v: unknown) => void = () => {};
    mount('/profiles?name=ma&pane=skills', DETAIL(), LIST(), { '/api/skills': () => new Promise((r) => (release = r)) });
    const box = await screen.findByRole('checkbox', { name: '내 스킬만 (—)' });
    expect(box).toBeDisabled();
    release({ skills: [{ id: 'ma:report', name: 'report', profile: 'ma', origin: 'bundled' }] });
    const ready = await screen.findByRole('checkbox', { name: '내 스킬만 (0)' });
    await user.click(ready);
    expect(await screen.findByText('이 프로파일에는 내 스킬이 없습니다')).toBeInTheDocument();
  });

  it('스킬 줄 「지우기」: 내 스킬은 보관하고 초점을 다음 줄의 지우기 단추로, 결과를 읽어 준다. 기본 스킬 줄에는 단추가 없다(스펙 2026-10-29-005 DT4·DD10)', async () => {
    const user = userEvent.setup();
    let gone = '';
    const skills = ['report', 'alert', 'plain'].map((n) => ({ name: n, description: '', enabled: true }));
    const rows = [
      { id: 'ma:profiles/ma/skills/report', name: 'report', profile: 'ma', origin: 'bundled', delete_block: 'origin' },
      { id: 'ma:profiles/ma/skills/uploaded/alert', name: 'alert', profile: 'ma', origin: 'local', delete_block: '' },
      { id: 'ma:profiles/ma/skills/uploaded/plain', name: 'plain', profile: 'ma', origin: 'agent', delete_block: '' },
    ];
    mount('/profiles?name=ma&pane=skills', () => DETAIL({ skills: skills.filter((x) => x.name !== gone) }), LIST(), {
      '/api/skill/delete': (_u: string, b: Record<string, unknown>) => {
        gone = String(b.id).split('/').pop() ?? '';
        return { ok: true };
      },
      '/api/skill?': { path: 'profiles/ma/skills/uploaded/alert', cron: [] },
      '/api/market': { admin: true, can_install: true, installed: [] },
      '/api/skills': () => ({ skills: rows.filter((r) => r.name !== gone) }),
    });
    expect(await screen.findByRole('button', { name: 'alert 스킬 지우기' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'report 스킬 지우기' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'alert 스킬 지우기' }));
    const dlg = await screen.findByRole('dialog', { name: 'alert 스킬 지우기' });
    await user.click(within(dlg).getByRole('button', { name: '지우기' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'plain 스킬 지우기' })).toHaveFocus());
    expect(screen.getAllByText('alert 스킬을 지웠습니다').length).toBeGreaterThan(0);
  });

  it('「내 스킬만」: 스킬 목록을 받지 못하면 체크 상자를 숨긴다(디자인 D9)', async () => {
    mount('/profiles?name=ma&pane=skills', DETAIL(), LIST(), { '/api/skills': new Response(JSON.stringify({ error: 'down' }), { status: 500 }) });
    expect(await screen.findByText('report')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: /내 스킬만/ })).toBeNull());
  });

  it('스킬 줄은 한 줄이다: 설명이 이름 옆에 말줄임으로 붙는다(2026-10-17-017 컴팩트)', async () => {
    mount('/profiles?name=ma&pane=skills');
    const desc = await screen.findByText('보고');
    expect(desc).toHaveAttribute('title', '보고');
    expect(getComputedStyle(desc).whiteSpace).toBe('nowrap');
    expect(desc.closest('[data-item-row]')?.querySelectorAll('div > div').length).toBeGreaterThan(0);
  });

  it('스킬을 켜고 끄면 skill 동작을 보낸다', async () => {
    const user = userEvent.setup();
    const fn = mount('/profiles?name=ma&pane=skills');
    await user.click(await screen.findByRole('switch', { name: 'alert 스킬 켜기' }));
    await waitFor(() =>
      expect(postedTo(fn, '/api/profile/action')).toEqual([
        { name: 'ma', action: 'skill', target: 'alert', enabled: true },
      ])
    );
    expect(await screen.findByText('스킬 alert 을(를) 켰습니다')).toBeInTheDocument(); // 알림에 무엇을 켰는지 이름이 있다
    expect(screen.getByText('사용 3회')).toBeInTheDocument();
  });

  it('스킬 줄은 아이콘·이름·설명·스위치이고, 꺼진 스킬은 줄에 표시가 붙는다', async () => {
    mount('/profiles?name=ma&pane=skills');
    const name = await screen.findByRole('button', { name: 'report' });
    const row = name.closest('[data-item-row]') as HTMLElement;
    expect(row).not.toBeNull();
    const icon = row.querySelector('[data-item-icon]') as HTMLElement;
    expect(icon).toHaveAttribute('aria-hidden', 'true');
    expect(icon.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // 아이콘이 이름 앞
    expect(within(row).getByText('보고')).toBeInTheDocument();
    expect(within(row).getByRole('switch', { name: 'report 스킬 켜기' })).toBeChecked();
    expect(row).not.toHaveAttribute('data-off');
    const alertRow = screen.getByRole('button', { name: 'alert' }).closest('[data-item-row]') as HTMLElement;
    expect(alertRow).toHaveAttribute('data-off');
  });

  // 스펙 2026-10-26-003 T1·T2: 메뉴를 옮기지 않고 같은 서랍에 스킬 연결도(skill:id)를 열고, 이전으로 스킬 탭에 돌아온다
  it('스킬 이름은 같은 서랍에 스킬 연결도를 열고(목록에 있으면 skill:id), 이전으로 돌아온다', async () => {
    const user = userEvent.setup();
    const fn = mount('/profiles?name=ma&pane=skills', DETAIL(), LIST(), { '/api/flow?': SKILL_GRAPH });
    await user.click(await screen.findByRole('button', { name: 'report' }));
    expect(await screen.findByRole('dialog', { name: '스킬 연결도' })).toHaveTextContent('skill:ma:report');
    expect(screen.getByTestId('loc')).toHaveTextContent('/profiles?name=ma&pane=skills'); // 메뉴 그대로
    await waitFor(() => expect(fn.mock.calls.some((c) => String(c[0]).startsWith('/api/flow?root=skill%3Ama%3Areport'))).toBe(true));
    expect(await screen.findByText(/노드 1/)).toBeInTheDocument(); // 그림 본문이 서랍 안에 그려진다
    expect(screen.getByRole('button', { name: '이후' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '이전' }));
    expect(await screen.findByRole('button', { name: 'report' })).toBeInTheDocument(); // 스킬 탭
    expect(screen.getByRole('dialog', { name: 'ma' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '이후' }));
    expect(await screen.findByRole('dialog', { name: '스킬 연결도' })).toBeInTheDocument();
  });

  it('MCP 연결 시험과 켜기/끄기, 도구묶음 토글', async () => {
    const user = userEvent.setup();
    const fn = mount('/profiles?name=ma&pane=tools');
    await user.click(await screen.findByRole('button', { name: '연결 시험' }));
    expect(await screen.findByText('chart: 연결됨 · 도구 5개')).toBeInTheDocument();
    // 끄기는 에이전트가 도구를 못 쓰게 되므로 확인을 받는다(OMAI-1135). 취소하면 켜진 채로 둔다
    const mcp = screen.getByRole('switch', { name: 'chart MCP 서버 켜기' });
    await user.click(mcp);
    expect(await screen.findByText(/chart MCP 서버를 끕니다/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '취소' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '확인' })).toBeNull());
    expect(mcp).toBeChecked();
    expect(postedTo(fn, '/api/profile/action').filter((a) => a.action === 'mcp')).toEqual([]);
    await user.click(mcp);
    await user.click(await screen.findByRole('button', { name: '확인' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '확인' })).toBeNull());
    await user.click(screen.getByRole('switch', { name: '웹 도구 묶음 켜기' }));
    expect(await screen.findByText(/웹 도구 묶음을 끕니다/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '확인' }));
    await waitFor(() => {
      const a = postedTo(fn, '/api/profile/action');
      expect(a).toContainEqual({ name: 'ma', action: 'mcp', target: 'chart', enabled: false });
      expect(a).toContainEqual({ name: 'ma', action: 'toolset', target: 'web', enabled: false });
    });
    expect(await screen.findByText('MCP 서버 chart 을(를) 껐습니다')).toBeInTheDocument();
    expect(await screen.findByText('도구 묶음 웹 을(를) 껐습니다')).toBeInTheDocument();
    expect(screen.getByText('설정 필요')).toBeInTheDocument();
    expect(screen.getByText(/인증값 이름: CHART_KEY/)).toBeInTheDocument();
  });

  it('크론 탭은 이 프로파일의 작업만 주기 풀이와 함께 보인다', async () => {
    mount('/profiles?name=ma&pane=cron');
    expect(await screen.findByText('daily')).toBeInTheDocument();
    expect(screen.queryByText('other')).not.toBeInTheDocument();
    expect(screen.getByText('30 9 * * * (매일 09:30)')).toBeInTheDocument();
    expect(screen.getByText('스킬 report')).toBeInTheDocument();
  });

  it('크론 줄도 같은 줄 모양이고 줄을 누르면 같은 서랍에 작업을 연다(스펙 2026-10-26-003)', async () => {
    const user = userEvent.setup();
    const fn = mount('/profiles?name=ma&pane=cron');
    const row = (await screen.findByText('daily')).closest('[data-item-row]') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.querySelector('[data-item-icon]')).toHaveAttribute('aria-hidden', 'true');
    await user.click(within(row).getByRole('button'));
    expect(await screen.findByRole('dialog', { name: 'daily' })).toBeInTheDocument();
    expect(screen.getByTestId('loc')).toHaveTextContent('/profiles?name=ma&pane=cron');
    await waitFor(() => expect(fn.mock.calls.some((c) => String(c[0]).startsWith('/api/cron/job?profile=ma&id=j1'))).toBe(true));
  });
});

describe('Profiles 상세: 크론 탭 목록과 새 크론(스펙 2026-10-15-003 R2·R5)', () => {
  it('목록은 호출 흐름이 아니라 작업 목록에서 읽어, 호출 흐름에 없는 작업(지시문만 있는 작업)도 보이고 탭 숫자와 같다', async () => {
    mount('/profiles?name=ma&pane=cron');
    expect(await screen.findByText('prompt-only')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /예약 작업 2/ })).toBeInTheDocument();
  });

  it('새 크론은 프로파일을 고정해 만들고, 만든 뒤 목록을 다시 읽는다', async () => {
    const user = userEvent.setup();
    const fn = mount('/profiles?name=ma&pane=cron');
    // 탭 바로 밑 줄 오른쪽 끝(2026-10-17-019)
    expect((await screen.findByRole('button', { name: '새 예약 작업' })).closest('.MuiStack-root')).toHaveStyle({ justifyContent: 'flex-end' });
    await user.click(await screen.findByRole('button', { name: '새 예약 작업' }));
    expect(screen.queryByRole('combobox', { name: /프로파일/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '채널 연결하기' })).toHaveAttribute('href', '/profiles?name=ma&pane=channels');
    await user.type(screen.getByLabelText('작업 이름'), 'weekly');
    await user.type(screen.getByLabelText(/지시문/), '요약해 줘');
    await user.click(screen.getByRole('button', { name: '작업 만들기' }));
    await waitFor(() =>
      expect(postedTo(fn, '/api/cron/action')).toContainEqual(expect.objectContaining({ action: 'create', profile: 'ma', job_name: 'weekly' }))
    );
    await waitFor(() => expect(screen.queryByRole('button', { name: '작업 만들기' })).not.toBeInTheDocument());
  });

  it('작업이 없어도 단추는 「새 MCP 서버」와 같은 오른쪽 위 하나, 만든 뒤 포커스가 그 단추로 돌아온다(스펙 2026-10-17-019 §4, 2026-10-19-005 G8)', async () => {
    const user = userEvent.setup();
    let made = false;
    stubApi({
      '/api/profile?': DETAIL(),
      '/api/profiles': LIST(),
      '/api/flows': FLOWS,
      '/api/cron/action': () => {
        made = true;
        return { ok: true };
      },
      '/api/cron/jobs': () => ({ profile: 'ma', can_edit: true, jobs: made ? CRON_JOBS : [] }),
    });
    mountScreen(<Profiles />, '/profiles?name=ma&pane=cron');
    const open = await screen.findByRole('button', { name: '새 예약 작업' });
    expect(screen.getAllByRole('button', { name: /새 예약 작업/ })).toHaveLength(1);
    expect(open.closest('.MuiStack-root')).toHaveStyle({ justifyContent: 'flex-end' });
    expect(open.closest('.MuiStack-root')).not.toHaveTextContent('이 프로파일의 예약 작업이 없습니다.');
    // 모양도 「새 MCP 서버」와 같은 테두리 단추에 + 아이콘(2026-10-17-019 §5)
    expect(open).toHaveClass('MuiButton-outlined');
    expect(open.querySelector('[data-testid="AddIcon"]')).not.toBeNull();
    expect(screen.getByText('이 프로파일의 예약 작업이 없습니다.')).toBeInTheDocument();
    await user.click(open);
    expect(screen.getByRole('button', { name: '새 예약 작업 접기' })).toHaveAttribute('aria-expanded', 'true');
    await user.type(screen.getByLabelText('작업 이름'), 'weekly');
    await user.type(screen.getByLabelText(/지시문/), '요약해 줘');
    await user.click(screen.getByRole('button', { name: '작업 만들기' }));
    await waitFor(() => expect(screen.queryByText('이 프로파일의 예약 작업이 없습니다.')).toBeNull());
    const top = screen.getByRole('button', { name: '새 예약 작업' });
    expect(screen.getAllByRole('button', { name: /새 예약 작업/ })).toHaveLength(1);
    expect(top).toBe(open); // 같은 자리의 같은 단추
    await waitFor(() => expect(top).toHaveFocus());
  });

  it('전달 대상은 연결된 채널만 고르게 하고 홈 채널이 없으면 표시한다', async () => {
    const user = userEvent.setup();
    stubApi({
      '/api/profile?': DETAIL(),
      '/api/profiles': LIST(),
      '/api/flows': FLOWS,
      '/api/cron/jobs': { profile: 'ma', can_edit: true, jobs: CRON_JOBS },
      '/api/channels/platforms': {
        platforms: [
          { id: 'telegram', name: 'Telegram', enabled: true, configured: true, home_channel: false },
          { id: 'slack', name: 'Slack', enabled: false, configured: false, home_channel: false },
        ],
        pairing: null,
      },
    });
    mountScreen(<Profiles />, '/profiles?name=ma&pane=cron');
    await user.click(await screen.findByRole('button', { name: '새 예약 작업' }));
    const opts = await screen.findAllByRole('option', { name: /Telegram/ });
    expect(opts[0]).toHaveTextContent('Telegram (홈 채널 없음)');
    expect(screen.queryByRole('option', { name: /Slack/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /버즈|Buzz/i })).not.toBeInTheDocument();
  });

  it('서랍 제목은 오피스 자리에 앉은 내 에이전트면 자리 이름이고 프로파일 이름은 부제에 둔다(D2)', async () => {
    stubApi({
      '/api/profile?': DETAIL(),
      '/api/profiles': LIST(),
      '/api/flows': FLOWS,
      '/api/cron/jobs': { profile: 'ma', can_edit: true, jobs: [] },
      '/api/office': { agents: [{ alias: 'mkt', profile: 'ma', title: '마케팅 봇', mine: true }] },
    });
    mountScreen(<Profiles />, '/profiles?name=ma&pane=cron');
    const dlg = await screen.findByRole('dialog', { name: '마케팅 봇' });
    expect(within(dlg).getByText(/^ma · /)).toBeInTheDocument();
  });

  it('5분 미만 주기는 경고하고 저장을 막지 않는다', () => {
    expect(minutesBetween('every 1m')).toBe(1);
    expect(minutesBetween('*/2 * * * *')).toBe(2);
    expect(minutesBetween('30m')).toBeNull();
    expect(minutesBetween('0 9 * * *')).toBeNull();
    expect(minutesBetween('nonsense')).toBeNull();
  });
});

describe('Profiles: PC 가져오기 중 표시(OMAI-1444 DD4)', () => {
  it('목록 줄은 importing 이면 무채색 「가져오는 중」을 이름 옆에 둔다', async () => {
    mount('/profiles', DETAIL(), { ...LIST(), profiles: [ROW({ importing: true }), ROW({ name: 'ops', title: '운영', importing: false })] });
    const pill = within(await rowByName(/^마케팅 \(ma\)/)).getByText('가져오는 중');
    expect(pill).toHaveAttribute('data-pill');
    expect(getComputedStyle(pill).color).not.toMatch(/rgb\(220, 38, 38\)|rgb\(180, 83, 9\)/);      // 빨강·앰버가 아니다
    expect(within(await rowByName(/^운영 \(ops\)/)).queryByText('가져오는 중')).not.toBeInTheDocument();
  });

  it('서랍 머리는 그 프로파일이 가져오는 중이면 무채색 「가져오는 중」', async () => {
    mount('/profiles?name=ma', DETAIL({ pod: 'p1' }), LIST(), {
      '/api/profile/pc-import': { job: { id: 'x', state: 'running', stage: 'import' }, profile: 'ma', owner: '' },
    });
    const drawer = await screen.findByRole('dialog', { name: 'ma' });
    const tag = (await within(drawer).findByText('가져오는 중')).closest('.MuiChip-root') as HTMLElement;
    expect(tag).toHaveClass('MuiChip-colorDefault');
  });
});

describe('Profiles 목록: 누구 전용 뱃지(2026-10-17-016)', () => {
  it('주인에게는 「내 전용」, 관리자가 남의 에이전트를 보면 「<이름>님 전용」. 사용 금지인 숨긴 루트에는 없다', async () => {
    mount('/profiles', DETAIL(), { ...LIST(), owner: true });
    expect(within(await rowByName(/^ma\b|Marketing|마케팅/)).getByText('내 전용')).toBeInTheDocument();
    vi.unstubAllGlobals();
    mount('/profiles', DETAIL(), {
      ...LIST(),
      owner_name: '김철수',
      profiles: [...LIST().profiles, ROW({ name: 'root', hidden_root: true, is_default: true })],
    });
    expect((await screen.findAllByText('김철수님 전용')).length).toBe(2); // ma·default 두 줄, 숨긴 루트 줄은 없다
  });
});

describe('Profiles 상세: 머리 동작 단추(COP Drawer 처럼)', () => {
  it('내 PC 로 내보내기·PC 에서 가져오기·이름 바꾸기·삭제 단추가 서랍 머리의 닫기 앞에 있고, 작업 폴더 「내보내기」는 없다', async () => {
    mount('/profiles?name=ma');
    const drawer = await screen.findByRole('dialog', { name: 'ma' });
    const head = drawer.querySelector('[data-drawer-head]') as HTMLElement;
    await within(head).findByRole('button', { name: '내 PC 로 내보내기' });
    // 관리자가 보는 main 이 아닌 프로파일(OMAI-1444 DD1). 작업 폴더 내보내기는 뺐다(2026-10-23, R7 바꿈)
    expect(within(head).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      '내 PC 로 내보내기', 'PC 에서 가져오기', '이름 바꾸기', '삭제', '닫기',
    ]);
    expect(within(head).queryByRole('button', { name: '내보내기' })).toBeNull();
    expect(screen.queryByRole('button', { name: /더 보기/ })).toBeNull();
  });

  it('이름 바꾸기는 rename 을 보내고 새 이름 상세로 간다', async () => {
    const user = userEvent.setup();
    const fn = mount('/profiles?name=ma');
    await user.click(await screen.findByRole('button', { name: '이름 바꾸기' }));
    const dlg = await screen.findByRole('dialog', { name: '이름 바꾸기' });
    const input = within(dlg).getByRole('textbox');
    await user.clear(input);
    await user.type(input, 'ma2');
    await user.click(within(dlg).getByRole('button', { name: '바꾸기' }));
    await waitFor(() =>
      expect(postedTo(fn, '/api/profile/action')).toEqual([{ name: 'ma', action: 'rename', new_name: 'ma2' }])
    );
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/profiles?name=ma2'));
  });

  it('main(주 프로파일)은 관리자도 이름을 바꾸지 못한다: 단추는 보이되 잠기고 이유를 보인다(2026-10-17-016)', async () => {
    mount('/profiles?name=ma', DETAIL({ caps: { rename: { can: false, reason: 'main_fixed' } } }));
    const btn = await screen.findByRole('button', { name: '이름 바꾸기' });
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('주 프로파일(main)의 이름은 바꿀 수 없습니다')).toBeInTheDocument();
  });

  it('이름 바꾸기 대화 상자는 칸 위에 여백을 둬 떠 있는 라벨이 잘리지 않는다(2026-10-17-016)', async () => {
    const user = userEvent.setup();
    mount('/profiles?name=ma');
    await user.click(await screen.findByRole('button', { name: '이름 바꾸기' }));
    const dlg = await screen.findByRole('dialog', { name: '이름 바꾸기' });
    const stack = within(dlg).getByRole('textbox').closest('.MuiStack-root') as HTMLElement;
    expect(getComputedStyle(stack).paddingTop).toBe('8px');
  });

  it('삭제는 이름을 정확히 입력해야 버튼이 풀리고 delete 를 보낸다', async () => {
    const user = userEvent.setup();
    const fn = mount('/profiles?name=ma');
    await user.click(await screen.findByRole('button', { name: '삭제' }));
    const dlg = await screen.findByRole('dialog', { name: '프로파일 삭제' });
    const go = within(dlg).getByRole('button', { name: '영구 삭제' });
    expect(go).toBeDisabled();
    await user.type(within(dlg).getByRole('textbox', { name: '확인용 이름' }), 'm');
    expect(go).toBeDisabled();
    await user.type(within(dlg).getByRole('textbox', { name: '확인용 이름' }), 'a');
    expect(go).toBeEnabled();
    await user.click(go);
    await waitFor(() =>
      expect(postedTo(fn, '/api/profile/action')).toEqual([
        { name: 'ma', action: 'delete', confirm: 'ma', skip_export: false },
      ])
    );
    expect(await screen.findByText('/data/x.tgz')).toBeInTheDocument();
  });

  it('삭제 전 내보내기가 실패하면(reason 코드) 문장이 영어여도 내보내기 없이 삭제하는 선택지를 보인다', async () => {
    const user = userEvent.setup();
    const base = mount('/profiles?name=ma');
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) =>
        url.startsWith('/api/profile/action') && String(init?.body).includes('"delete"')
          ? Promise.resolve(
              new Response(JSON.stringify({ error: 'The export failed, so nothing was deleted: x', reason: 'export_failed' }), { status: 502 })
            )
          : base(url, init)
      )
    );
    await user.click(await screen.findByRole('button', { name: '삭제' }));
    const dlg = await screen.findByRole('dialog', { name: '프로파일 삭제' });
    await user.type(within(dlg).getByRole('textbox', { name: '확인용 이름' }), 'ma');
    expect(within(dlg).queryByRole('checkbox')).not.toBeInTheDocument();
    await user.click(within(dlg).getByRole('button', { name: '영구 삭제' }));
    expect(await within(dlg).findByRole('checkbox', { name: /내보내기 없이 삭제/ })).toBeInTheDocument();
  });

  it('주인은 스킬 허브로 만든 프로파일을 머리의 「삭제」로 지운다. 내보내기 건너뛰기는 없고 지운 뒤 다시 설치로 간다(OMAI-1126 T6·DT3)', async () => {
    const user = userEvent.setup();
    const owner = { can_edit: false, owner: true, can_delete: true, market_package: 'free/helper', places: { seats: 2, rooms: 1, channels: 2 } };
    const base = mount('/profiles?name=ma', DETAIL(owner));
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) =>
        url.startsWith('/api/profile/action') && String(init?.body).includes('"delete"')
          ? Promise.resolve(new Response(JSON.stringify({ error: '내보내기 실패', reason: 'export_failed' }), { status: 502 }))
          : base(url, init)
      )
    );
    expect(await screen.findByText(/MCP·설정 파일과 채널·비밀값을 바꾸고, 이름 바꾸기와 삭제도 할 수 있습니다/)).toBeInTheDocument();
    const del = await screen.findByRole('button', { name: '삭제' });
    expect(screen.queryByRole('button', { name: '내보내기' })).not.toBeInTheDocument();     // 주인에게는 내보내기가 없다(삭제와 이름 바꾸기만)
    expect(screen.getByRole('button', { name: '이름 바꾸기' })).toBeInTheDocument();
    await user.click(del);
    const dlg = await screen.findByRole('dialog', { name: '프로파일 삭제' });
    expect(within(dlg).getByText(/오피스 자리 2개와 열린 방 1곳에서 빠집니다/)).toBeInTheDocument();
    expect(within(dlg).getByText(/묶음 파일은 관리자만 꺼낼 수 있습니다/)).toBeInTheDocument();
    expect(within(dlg).getByText(/연결된 채널 2개와 허용된 사용자·페어링 기록도 함께 지워집니다/)).toBeInTheDocument();   // 디자인 결정 7A
    const name = within(dlg).getByRole('textbox', { name: '확인용 이름' });
    await waitFor(() => expect(name).toHaveFocus());
    await user.type(name, 'ma');
    await user.click(within(dlg).getByRole('button', { name: '영구 삭제' }));
    expect(await within(dlg).findByText('내보내기 실패')).toBeInTheDocument();
    expect(within(dlg).queryByRole('checkbox')).not.toBeInTheDocument();
    vi.stubGlobal('fetch', base);
    base.mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({ deleted: 'ma', market_package: 'free/helper' }), { status: 200 })));
    await user.click(within(dlg).getByRole('button', { name: '영구 삭제' }));
    const link = await screen.findByRole('link', { name: '스킬 허브에서 다시 설치' });
    expect(link).toHaveAttribute('href', '/market?q=helper');
  });

  it('주인 화면의 주 프로파일(main)은 「삭제」 단추가 보이되 누를 수 없고 이유를 읽는다(디자인 결정 7A)', async () => {
    mount('/profiles?name=ma', DETAIL({ can_edit: false, owner: true, can_delete: false }), LIST(), {
      '/api/me': { auth_enabled: true, admin: false, owner: true, user: { email: 'o@x.com', name: 'o' }, primary: { profile: 'ma', ready: true } },
    });
    const del = await screen.findByRole('button', { name: '삭제' });
    expect(del).toHaveAttribute('aria-disabled', 'true');                                            // 잠긴 동작 단추는 aria-disabled 로 이유를 읽게 한다
    expect(del).toHaveAccessibleDescription(/주 프로파일\(main\)은 지울 수 없습니다/);
  });

  it('주인이라도 스킬 허브 기록이 없는 프로파일에는 머리 동작 단추가 없다', async () => {
    mount('/profiles?name=ma', DETAIL({ can_edit: false, owner: true, can_delete: false }));
    const note = await screen.findByText(/MCP·설정 파일과 채널·비밀값을 바꿀 수 있습니다/);
    // 권한 안내는 탭 줄이 아니라 서랍 머리의 「프로파일 상세」 옆에 있다
    expect(note.closest('[data-drawer-note]')).not.toBeNull();
    expect(screen.getByRole('tablist').parentElement?.textContent).not.toMatch(/SOUL 과 스킬 켜고 끄기만/);
    for (const name of ['내보내기', '삭제']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '이름 바꾸기' })).toBeInTheDocument();     // 단계 1b: 주인은 main 이 아닌 프로파일의 이름을 바꾼다
  });

  it('주인은 주 프로파일(main)의 이름을 바꾸지 못한다: 삭제처럼 단추는 보이되 잠긴다(2026-10-17-016, 예전에는 숨겼다)', async () => {
    stubApi({
      '/api/me': { auth_enabled: true, admin: false, user: { email: 'a@x.com' }, primary: { profile: 'ma', ready: true } },
      '/api/profile?': DETAIL({ can_edit: false, owner: true, can_delete: false }),
      '/api/profiles': LIST(false),
      '/api/flows': FLOWS,
      '/api/cron/jobs': { profile: 'ma', can_edit: true, jobs: [] },
    });
    mountScreen(<Profiles />, '/profiles?name=ma');
    await screen.findByText(/내 AI 에이전트 작업공간의 프로파일입니다/);
    expect(screen.getByRole('button', { name: '이름 바꾸기' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('기본 프로파일에는 이름 바꾸기·삭제가 없다', async () => {
    mount('/profiles?name=default', DETAIL({ profile: ROW({ name: 'default', is_default: true }) }));
    await screen.findByRole('dialog', { name: 'default' });
    expect(screen.queryByRole('button', { name: '내보내기' })).not.toBeInTheDocument();      // 작업 폴더 내보내기는 없다(2026-10-23)
    expect(screen.queryByRole('button', { name: '이름 바꾸기' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '삭제' })).not.toBeInTheDocument();
  });

  it('고치던 글이 있으면 탭을 옮길 때 버릴지 묻는다', async () => {
    const user = userEvent.setup();
    mount('/profiles?name=ma&pane=soul');
    await user.click(await screen.findByRole('button', { name: '고치기' }));
    await user.type(screen.getByRole('textbox', { name: /SOUL.md 고치기/ }), '!');
    await user.click(screen.getByRole('tab', { name: /개요/ }));
    expect(await screen.findByText(/저장하지 않은 수정이 있습니다/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '취소' }));
    expect(await screen.findByRole('tab', { name: /성격/ })).toHaveAttribute('aria-selected', 'true');
  });
});

// 작업 지침(AGENTS.md) 탭(스펙 2026-10-19-004 §4-4·§9·§10). 서버 응답은 계약(상세 agents·동작 agents*)대로 대역으로 준다
const AGENTS = (over = {}) => ({
  lines: ['## 역할', '- 보고서를 쓴다'],
  masked_lines: [],
  sha: 'as1',
  exists: true,
  path: 'profiles/ma/AGENTS.md',
  versions: 2,
  readonly_reason: null,
  limit: 30720,
  chars: 16,
  warnings: [],
  agent_change: null,
  never_saved: false,
  ...over,
});
const CHANGE = (over = {}) => ({ id: 57, at: '2026-10-19 14:02', deleted: false, compare_id: 51, revert_id: 51, ...over });
const narrowScreen = (matches: boolean) => {
  const mm = window.matchMedia;
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  return () => {
    window.matchMedia = mm;
  };
};
/** 동작 응답을 시험마다 바꾼다(mount 의 기본 응답은 그대로 두고 agents* 만 가로챈다) */
function withActions(base: ReturnType<typeof stubApi>, reply: (b: Record<string, unknown>) => unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/profile/action') && init?.body) {
        const b = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (String(b.action).startsWith('agents')) {
          base(url, init); // 보낸 기록은 base 에 남긴다
          const out = reply(b);
          return Promise.resolve(
            out instanceof Response ? out : new Response(JSON.stringify(out ?? { ok: true }), { status: 200 })
          );
        }
      }
      return base(url, init);
    })
  );
}

describe('Profiles 상세: 작업 지침(AGENTS.md)', () => {
  it('탭은 성격 다음 「작업지침(AGENTS)」이고, 본문·파일 위치·회색 도움말을 보인다. 방 알림·템플릿 단추는 없다', async () => {
    mount('/profiles?name=ma&pane=agents', DETAIL({ agents: AGENTS(), rooms: { names: ['제안 TFT'], others: 0 } }));
    const tabs = (await screen.findAllByRole('tab')).map((x) => x.textContent);
    expect(tabs.indexOf('작업지침(AGENTS)')).toBe(tabs.indexOf('성격(SOUL)') + 1);
    expect(screen.getByRole('tab', { name: '작업지침(AGENTS)' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('보고서를 쓴다')).toBeInTheDocument();
    expect(screen.getByText('profiles/ma/AGENTS.md')).toBeInTheDocument();
    expect(screen.getByText(/새 대화와, AI 에이전트가 하위 AI 에이전트에게 맡긴 작업부터 적용됩니다\. 예약 작업에는 적용되지 않습니다/)).toHaveAttribute('data-editor-hint');
    expect(screen.queryByText(/에서 쓰입니다/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /템플릿/ })).not.toBeInTheDocument();
  });

  it('빈 상태: 두 줄 안내와 「예시로 시작」. 누르면 편집기에만 예시를 채우고 저장하지 않으며, 저장 메모 기본값은 「예시로 시작」', async () => {
    const user = userEvent.setup();
    const fn = mount('/profiles?name=ma&pane=agents', DETAIL({ agents: AGENTS({ lines: [], exists: false, sha: '', versions: 0 }) }));
    expect(await screen.findByText('성격(SOUL)은 누구인지, 작업 지침은 어떻게 일할지를 적습니다.')).toBeInTheDocument();
    expect(screen.getByText('아직 파일이 없습니다. 저장하면 만듭니다.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '예시로 시작' }));
    const box = (await screen.findByRole('textbox', { name: /ma 의 AGENTS.md 고치기/ })) as HTMLTextAreaElement;
    for (const h of ['## 역할', '## 일하는 방식', '## 보고 형식', '## 하지 않을 것']) expect(box.value).toContain(h);
    expect(postedTo(fn, '/api/profile/action').filter((b) => b.action === 'agents')).toEqual([]);
    expect(screen.queryByText('아직 파일이 없습니다. 저장하면 만듭니다.')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /바뀐 줄 확인/ }));
    expect(await screen.findByRole('textbox', { name: '저장 메모' })).toHaveValue('예시로 시작');
  });

  it('공백만 있는 파일도 「예시로 시작」을 보이지만 「아직 파일이 없습니다」는 보이지 않는다', async () => {
    mount('/profiles?name=ma&pane=agents', DETAIL({ agents: AGENTS({ lines: ['  ', ''] }) }));
    expect(await screen.findByRole('button', { name: '예시로 시작' })).toBeInTheDocument();
    expect(screen.queryByText('아직 파일이 없습니다. 저장하면 만듭니다.')).not.toBeInTheDocument();
  });

  it('미리 보기의 크기 경고가 있어도 저장할 수 있고, 저장하면 「새 대화부터 적용」 안내와 새 대화에서 확인 단추를 보인다', async () => {
    const user = userEvent.setup();
    const base = mount('/profiles?name=ma&pane=agents', DETAIL({ agents: AGENTS() }));
    withActions(base, (b) =>
      b.action === 'agents_preview'
        ? { same: false, lines: [], added: 1, removed: 0, problem: '', warnings: ['40000자로 한도 30720자를 넘습니다.'] }
        : { agents: { lines: ['x'], sha: 'as2', versions: 3, masked_lines: [] } }
    );
    await user.click(await screen.findByRole('button', { name: '고치기' }));
    await user.type(screen.getByRole('textbox', { name: /ma 의 AGENTS.md 고치기/ }), '!');
    expect(screen.getByText(/\/ 30,720자/)).toBeInTheDocument(); // 상태 줄 글자 수(D6)
    await user.click(screen.getByRole('button', { name: /바뀐 줄 확인/ }));
    expect(await screen.findByText('40000자로 한도 30720자를 넘습니다.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '이대로 저장' }));
    await waitFor(() =>
      expect(postedTo(base, '/api/profile/action').find((b) => b.action === 'agents')).toEqual({
        name: 'ma',
        action: 'agents',
        content: '## 역할\n- 보고서를 쓴다!',
        base_sha: 'as1',
        note: '',
      })
    );
    const ok = await screen.findByText('저장했습니다. 새 대화부터 적용됩니다.');
    expect(ok.closest('[role="status"]')).not.toBeNull();
    const popup = watchChatPopup();
    fireEvent.click(screen.getByRole('button', { name: '새 대화에서 확인' }));
    expect(popup()).toMatchObject({ kind: 'chat', agent: 'ma' });
  });

  it('저장 충돌(409)은 작업 지침 문장으로 알린다', async () => {
    const user = userEvent.setup();
    const base = mount('/profiles?name=ma&pane=agents', DETAIL({ agents: AGENTS() }));
    withActions(base, (b) =>
      b.action === 'agents_preview'
        ? { problem: '', warnings: [] }
        : new Response(JSON.stringify({ error: 'changed' }), { status: 409 })
    );
    await user.click(await screen.findByRole('button', { name: '고치기' }));
    await user.type(screen.getByRole('textbox', { name: /ma 의 AGENTS.md 고치기/ }), '!');
    await user.click(screen.getByRole('button', { name: /바뀐 줄 확인/ }));
    await user.click(await screen.findByRole('button', { name: '이대로 저장' }));
    expect(await screen.findByText('AI 에이전트가 그사이 고쳤습니다. 바뀐 줄을 보고 다시 저장하세요.')).toBeInTheDocument();
  });

  it('보기 화면에서도 상세의 크기 경고를 경고 알림으로 보인다(D6)', async () => {
    mount('/profiles?name=ma&pane=agents', DETAIL({ agents: AGENTS({ warnings: ['31000자로 한도 30720자를 넘습니다.'] }) }));
    const w = await screen.findByText('31000자로 한도 30720자를 넘습니다.');
    expect(w.closest('.MuiAlert-standardWarning')).not.toBeNull();
  });

  it('읽기 오류: 본문 없이 role=alert 오류와 「다시 읽기」(누르면 다시 읽는다)', async () => {
    const user = userEvent.setup();
    const fn = mount('/profiles?name=ma&pane=agents', DETAIL({ agents: AGENTS({ readonly_reason: 'read_error', lines: [] }) }));
    const err = await screen.findByRole('alert');
    expect(err).toHaveTextContent('파일을 읽지 못했습니다.');
    expect(screen.queryByText('보고서를 쓴다')).not.toBeInTheDocument();
    const before = fn.mock.calls.filter((c) => String(c[0]).startsWith('/api/profile?')).length;
    await user.click(within(err).getByRole('button', { name: '다시 읽기' }));
    await waitFor(() => expect(fn.mock.calls.filter((c) => String(c[0]).startsWith('/api/profile?')).length).toBeGreaterThan(before));
  });

  it('기능 꺼짐(unsupported): 사유를 맨 위에 보이고 본문은 보이며 「고치기」는 꺼진 채 사유에 aria-describedby 로 이어진다(D5·D13·D14)', async () => {
    mount('/profiles?name=ma&pane=agents', DETAIL({ agents: AGENTS({ readonly_reason: 'unsupported' }) }));
    const why = await screen.findByText('이 AI 에이전트 작업공간의 Hermes 가 아직 작업 지침을 읽지 않습니다.');
    expect(screen.getByText('보고서를 쓴다')).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: '고치기' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-describedby', why.id);
    // 배치 순서 ①: 사유가 편집기 단추보다 앞
    expect(why.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('읽기 전용 사유는 서버가 고른 하나를 그 문구로 보이고, 기능 꺼짐 밖에는 「고치기」가 없다', async () => {
    const cases: [string, string][] = [
      ['link', '다른 파일을 가리키는 링크라 여기서 고칠 수 없습니다.'],
      ['truncated', '파일이 커서 앞부분만 보입니다. 여기서 고칠 수 없습니다.'],
      ['masked', '비밀값으로 보이는 줄이 있어 여기서는 고칠 수 없습니다'],
      ['hidden_root', '숨겨진 루트(default)는 바꿀 수 없습니다. 주 프로파일(main)을 고르세요.'],
      ['view_only', '관리자나 이 AI 에이전트 작업공간의 소유자만 고칠 수 있습니다'],
    ];
    for (const [reason, text] of cases) {
      mount('/profiles?name=ma&pane=agents', DETAIL({ agents: AGENTS({ readonly_reason: reason }) }));
      const why = await screen.findByText(text);
      expect(why, reason).toHaveAttribute('data-agents-why', reason);
      expect(document.querySelectorAll('[data-agents-why]'), reason).toHaveLength(1); // 사유는 하나만
      expect(screen.getByText('보고서를 쓴다')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '고치기' }), reason).not.toBeInTheDocument();
      cleanup();
      vi.unstubAllGlobals();
    }
  });

  it('에이전트 변경 배너: 시각 문장, 「바뀐 줄 보기」는 마지막 사람 버전(compare_id)과 비교, 되돌리기는 확인 뒤 revert_id 로 보내고 그 배너를 바로 숨긴다', async () => {
    const user = userEvent.setup();
    const fn = mount('/profiles?name=ma&pane=agents', DETAIL({ agents: AGENTS({ agent_change: CHANGE() }) }), LIST(), {
      '/api/profile/soul/diff': { lines: ['-옛 줄', '+새 줄'], added: 1, removed: 1, same: false },
    });
    const banner = (await screen.findByText('AI 에이전트가 2026-10-19 14:02에 이 파일을 고쳤습니다.')).closest('[role="status"]')!;
    expect(banner).toHaveAttribute('data-agents-banner');
    // 배너 단추가 본문 「고치기」보다 Tab 순서가 앞(D13)
    const edit = screen.getByRole('button', { name: '고치기' });
    const diffBtn = within(banner as HTMLElement).getByRole('button', { name: '바뀐 줄 보기' });
    expect(diffBtn.compareDocumentPosition(edit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(diffBtn);
    expect(await screen.findByText('+새 줄')).toBeInTheDocument();
    expect(fn.mock.calls.some((c) => String(c[0]) === '/api/profile/soul/diff?name=ma&id=51&kind=agents')).toBe(true);

    await user.click(within(banner as HTMLElement).getByRole('button', { name: '이전 버전으로 되돌리기' }));
    expect(await screen.findByText(/버전 51 의 내용으로 되돌립니다/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '확인' }));
    await waitFor(() =>
      expect(postedTo(fn, '/api/profile/action')).toContainEqual({ name: 'ma', action: 'agents_revert', id: 51, base_sha: 'as1' })
    );

    // 되돌리기가 성공하면 다시 읽기를 기다리지 않고 그 변경(57)의 배너를 숨긴다 — 대역이 같은 응답(57)을 다시 줘도 다시 뜨지 않는다(OKE 2026-10-19)
    await waitFor(() => expect(screen.queryByText(/이 파일을 고쳤습니다/)).not.toBeInTheDocument());
  });

  it('「확인함」이 성공하면 상세를 다시 읽기 전에 배너를 숨기고, 단추는 문장 아래 한 줄에 있다(OKE 2026-10-19)', async () => {
    const user = userEvent.setup();
    const fn = mount('/profiles?name=ma&pane=agents', DETAIL({ agents: AGENTS({ agent_change: CHANGE() }) }), LIST());
    const banner = (await screen.findByText(/이 파일을 고쳤습니다/)).closest('[role="status"]') as HTMLElement;
    // 단추는 Alert 오른쪽 action 자리가 아니라 문장과 같은 본문 안에 있다(서랍 폭에서 「확인함」만 다음 줄로 넘어가던 것)
    expect(banner.querySelector('.MuiAlert-action')).toBeNull();
    await user.click(within(banner).getByRole('button', { name: '확인함' }));
    await waitFor(() => expect(postedTo(fn, '/api/profile/action')).toContainEqual({ name: 'ma', action: 'agents_ack', version_id: 57 }));
    await waitFor(() => expect(screen.queryByText(/이 파일을 고쳤습니다/)).not.toBeInTheDocument());
  });

  it('사람 버전이 없으면(revert_id null) 되돌리기 단추가 없고, 출처 모름 문장이 같은 배너에 붙는다(D8·D20)', async () => {
    mount('/profiles?name=ma&pane=agents', DETAIL({ agents: AGENTS({ agent_change: CHANGE({ revert_id: null }), never_saved: true }) }));
    const banner = (await screen.findByText(/이 파일을 고쳤습니다/)).closest('[role="status"]') as HTMLElement;
    expect(within(banner).getByText('화면에서 저장한 적이 없는 파일입니다.')).toBeInTheDocument();
    expect(within(banner).queryByRole('button', { name: '이전 버전으로 되돌리기' })).not.toBeInTheDocument();
    expect(within(banner).getByRole('button', { name: '확인함' })).toBeInTheDocument();
  });

  it('출처 모름만이면 문장만 있는 배너다', async () => {
    mount('/profiles?name=ma&pane=agents', DETAIL({ agents: AGENTS({ never_saved: true }) }));
    const banner = (await screen.findByText('화면에서 저장한 적이 없는 파일입니다.')).closest('[role="status"]') as HTMLElement;
    expect(within(banner).queryAllByRole('button')).toHaveLength(0);
  });

  it('지움 배너(D19): 「지웠습니다」 문장, 되돌리기는 파일을 다시 만든다고 묻는다. 빈 상태 안내도 함께', async () => {
    const user = userEvent.setup();
    const fn = mount(
      '/profiles?name=ma&pane=agents',
      DETAIL({ agents: AGENTS({ lines: [], exists: false, sha: '', agent_change: CHANGE({ deleted: true }) }) })
    );
    expect(await screen.findByText('AI 에이전트가 2026-10-19 14:02에 이 파일을 지웠습니다.')).toBeInTheDocument();
    expect(screen.getByText('아직 파일이 없습니다. 저장하면 만듭니다.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '이전 버전으로 되돌리기' }));
    expect(await screen.findByText('버전 51 의 내용으로 파일을 다시 만듭니다.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '확인' }));
    await waitFor(() => expect(postedTo(fn, '/api/profile/action')).toContainEqual({ name: 'ma', action: 'agents_revert', id: 51, base_sha: '' }));
  });

  it('보기 권한만 있으면 배너에 「바뀐 줄 보기」만 있다', async () => {
    mount(
      '/profiles?name=ma&pane=agents',
      DETAIL({ can_edit: false, owner: false, agents: AGENTS({ readonly_reason: 'view_only', agent_change: CHANGE() }) })
    );
    const banner = (await screen.findByText(/이 파일을 고쳤습니다/)).closest('[role="status"]') as HTMLElement;
    expect(within(banner).getAllByRole('button').map((b) => b.textContent)).toEqual(['바뀐 줄 보기']);
  });

  it('600px 미만: 배너 단추는 「바뀐 줄 보기」와 ⋮ 메뉴뿐이고, 메뉴에 되돌리기·확인함이 있다(D12)', async () => {
    const restore = narrowScreen(true);
    try {
      const user = userEvent.setup();
      const fn = mount('/profiles?name=ma&pane=agents', DETAIL({ agents: AGENTS({ agent_change: CHANGE() }) }));
      const banner = (await screen.findByText(/이 파일을 고쳤습니다/)).closest('[role="status"]') as HTMLElement;
      expect(within(banner).getByRole('button', { name: '바뀐 줄 보기' })).toBeInTheDocument();
      expect(within(banner).queryByRole('button', { name: '확인함' })).not.toBeInTheDocument();
      const more = within(banner).getByRole('button', { name: '다른 동작' });
      expect(more).toHaveAttribute('aria-haspopup', 'menu');
      await user.click(more);
      expect(screen.getByRole('menuitem', { name: '이전 버전으로 되돌리기' })).toBeInTheDocument();
      await user.click(screen.getByRole('menuitem', { name: '확인함' }));
      await waitFor(() => expect(postedTo(fn, '/api/profile/action')).toContainEqual({ name: 'ma', action: 'agents_ack', version_id: 57 }));
    } finally {
      restore();
    }
  });

  it('「확인함」이 거절되면(오래된 버전 409) 오류를 알리고 상세를 다시 읽는다', async () => {
    const user = userEvent.setup();
    const base = mount('/profiles?name=ma&pane=agents', DETAIL({ agents: AGENTS({ agent_change: CHANGE() }) }));
    withActions(base, () => new Response(JSON.stringify({ error: '이미 새 버전이 있습니다' }), { status: 409 }));
    const before = base.mock.calls.filter((c) => String(c[0]).startsWith('/api/profile?')).length;
    await user.click(await screen.findByRole('button', { name: '확인함' }));
    expect(await screen.findByText('이미 새 버전이 있습니다')).toBeInTheDocument();
    await waitFor(() => expect(base.mock.calls.filter((c) => String(c[0]).startsWith('/api/profile?')).length).toBeGreaterThan(before));
  });

  it('버전 목록과 버전 비교는 agents 열쇠와 kind=agents 로 묻고, 에이전트가 쓴 버전은 「에이전트」 칩이다', async () => {
    const user = userEvent.setup();
    const fn = mount('/profiles?name=ma&pane=agents', DETAIL({ agents: AGENTS() }), LIST(), {
      '/api/profile/soul/diff': { lines: ['+a'], added: 1, removed: 0, same: false },
    });
    const VERSIONS = [
      { id: 57, sha: 'as1', saved_at: '2026-10-19T14:02:00', by: 'hermes:ma', size: 16 },
      { id: 51, sha: 'h1', saved_at: '2026-10-18T10:00:00', by: 'kim', size: 10 },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url.startsWith('/api/text/versions')) {
          fn(url, init);
          return Promise.resolve(new Response(JSON.stringify({ versions: VERSIONS }), { status: 200 }));
        }
        return fn(url, init);
      })
    );
    await user.click(await screen.findByRole('button', { name: '이전 버전 2' }));
    const agentRow = (await screen.findByText('버전 57')).closest('li')!;
    expect(agentRow.querySelector('[data-actor-chip="agent"]')).toHaveTextContent('에이전트');
    expect(fn.mock.calls.some((c) => String(c[0]) === '/api/text/versions?key=agents%3Ama')).toBe(true);
    await user.click(within(screen.getByText('버전 51').closest('li')!).getByRole('button', { name: '현재와 비교' }));
    await waitFor(() => expect(fn.mock.calls.some((c) => String(c[0]) === '/api/profile/soul/diff?name=ma&id=51&kind=agents')).toBe(true));
  });

  it('서랍 위 읽지 못한 부분 안내(d.notes)는 서버가 준 대로 그대로 보인다(D15)', async () => {
    mount('/profiles?name=ma&pane=agents', DETAIL({ notes: ['agents: 연결 시간 초과'], agents: AGENTS({ readonly_reason: 'read_error', lines: [] }) }));
    expect(await screen.findByText('agents: 연결 시간 초과', { selector: 'li' })).toBeInTheDocument();
    expect(screen.getAllByRole('alert').some((a) => a.textContent?.includes('파일을 읽지 못했습니다.'))).toBe(true);
  });
});

describe('Profiles 목록: 주 프로파일(main) 맨 위(2026-10-19-004 O8)', () => {
  it('main 행이 맨 위이고 「주 프로파일」 뱃지가 붙으며, 들어와도 서랍은 열리지 않는다', async () => {
    const base = LIST();
    mount('/profiles', DETAIL(), { ...base, primary: 'main', profiles: [...base.profiles, ROW({ name: 'main', title: '', issues: [] })] });
    const rows = (await screen.findAllByRole('row')).filter((r) => r.querySelector('[role="cell"], td'));
    expect(within(rows[0]).getByText('main')).toBeInTheDocument();
    expect(within(rows[0]).getByText('주 프로파일')).toBeInTheDocument();
    expect(screen.getAllByText('주 프로파일')).toHaveLength(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('loc')).toHaveTextContent(/^\/profiles$/);
  });
});

// 스펙 2026-10-26-003 2단계: 서랍 안에서 연 프로파일 페이지는 주소를 읽거나 쓰지 않고 페이지 값으로 탭·값을 고른다(외부 검토 M2·T12·T17)
describe('서랍 안 프로파일 페이지', () => {
  let ui: ReturnType<typeof useUi>;
  function Grab() {
    ui = useUi();
    return null;
  }

  it('페이지 값의 탭·비밀값을 열고, 탭을 바꿔도 주소와 기록 길이가 그대로이며, 제목은 메뉴에서 연 서랍과 같다', async () => {
    const user = userEvent.setup();
    stubApi({
      '/api/profile?': DETAIL(),
      '/api/profiles': LIST(),
      '/api/cron/jobs': { profile: 'ma', can_edit: true, jobs: CRON_JOBS },
      '/api/skills': { skills: [{ id: 'ma:report', name: 'report', profile: 'ma' }] },
    });
    mountScreen(
      <>
        <Profiles />
        <Grab />
      </>,
      '/profiles?name=ma'
    );
    const menuTitle = (await screen.findByRole('dialog')).getAttribute('aria-label');
    await act(() => ui.navigateDrawer({ kind: 'profile', name: 'ma', pane: 'env', extra: { key: 'SLACK_TOKEN' } }));
    expect(await screen.findByRole('tab', { name: /비밀값/, selected: true })).toBeInTheDocument();
    expect(await screen.findByText('SLACK_TOKEN')).toBeInTheDocument();
    expect(screen.queryByText('OPENAI_API_KEY')).toBeNull(); // ?key= 와 같이 그 변수로 거른다
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-label', menuTitle); // T12
    await user.click(screen.getByRole('tab', { name: /^스킬/ }));
    expect(await screen.findByRole('button', { name: 'report' })).toBeInTheDocument();
    expect(screen.getByTestId('loc')).toHaveTextContent(/^\/profiles\?name=ma$/); // 주소에 pane 을 쓰지 않는다(T17)
    expect(ui.drawer?.history?.pages).toHaveLength(2); // 탭 바꾸기는 기록을 쌓지 않는다
    expect(ui.drawer?.history?.pages[1].page).toEqual({ kind: 'profile', name: 'ma', pane: 'skills', extra: { key: 'SLACK_TOKEN' } });
    await user.click(screen.getByRole('button', { name: '이전' }));
    expect(await screen.findByRole('tab', { name: /개요/, selected: true })).toBeInTheDocument(); // 첫 페이지(주소 서랍)는 주소의 탭
  });
});

describe('프로파일이 들어 있는 에이전트와 같은 이름의 프로파일(스펙 2026-10-19-011)', () => {
  const ME = (pod = 'p2', name = '관리자 AAS') => ({
    auth_enabled: true,
    admin: false,
    user: { email: 'me@x.com', name: '나' },
    pod: { id: pod, owner: 'me@x.com', name },
    pods: [],
  });
  const AGENTS = {
    agents: [
      { name: 'p2', owner: 'me@x.com', display_name: '관리자 AAS', profiles: ['ma'] },
      { name: 'p1', owner: 'me@x.com', display_name: '마케팅 도우미', profiles: ['ma', 'x'] },
      { name: 'p3', owner: 'other@x.com', display_name: '남의 것', profiles: ['ma'] },
      { name: 'p4', owner: 'me@x.com', display_name: '준비 중', profiles: null },
      { name: 'p5', owner: 'me@x.com', display_name: '다른 이름만', profiles: ['zz'] },
    ],
  };
  afterEach(() => localStorage.clear());

  it('서랍 부제는 「<에이전트>의 프로파일」이고, 제목은 지금 에이전트의 오피스 직함이다(A1·R2)', async () => {
    mount('/profiles?name=ma', DETAIL({ pod: 'p2' }), LIST(), {
      '/api/me': ME(),
      '/api/agents': AGENTS,
      '/api/office': {
        agents: [
          { alias: 'a1', pod: 'p1', profile: 'ma', title: '마케팅 직함', mine: true },
          { alias: 'a2', pod: 'p2', profile: 'ma', title: '관리 직함', mine: true },
        ],
      },
    });
    const dlg = await screen.findByRole('dialog', { name: '관리 직함' });
    expect(within(dlg).getByText(/관리자 AAS의 프로파일/)).toBeInTheDocument();
  });

  it('개요에 「같은 이름이 있는 AI 에이전트 작업공간」 줄이 없고, 「들어 있는」 줄의 이름 링크는 목록의 그 줄을 연다(A3·2026-10-30 줄 제거)', async () => {
    mount('/profiles?name=ma', DETAIL({ pod: 'p2' }), LIST(), { '/api/me': ME(), '/api/agents': AGENTS });
    const dlg = await screen.findByRole('dialog');
    expect(await within(dlg).findByRole('link', { name: /관리자 AAS/ })).toHaveAttribute('href', '/agents?open=p2');
    expect(within(dlg).queryByText('같은 이름이 있는 AI 에이전트 작업공간')).toBeNull();
    expect(dlg.querySelector('[data-same-name]')).toBeNull();
    expect(dlg.querySelector('[data-agent-row-hint]')).not.toBeNull();
  });

  it('「들어 있는 에이전트」 링크는 같은 서랍에 그 작업공간을 열고 이전으로 돌아온다(스펙 2026-10-26-003 2단계)', async () => {
    const user = userEvent.setup();
    mount('/profiles?name=ma', DETAIL({ pod: 'p2' }), LIST(), { '/api/me': ME(), '/api/agents': AGENTS });
    const dlg = await screen.findByRole('dialog');
    await user.click(await within(dlg).findByRole('link', { name: /관리자 AAS/ }));
    expect(await screen.findByRole('dialog', { name: '관리자 AAS' })).toHaveTextContent('p2');
    expect(screen.getByTestId('loc')).toHaveTextContent(/^\/profiles\?name=ma$/);
    await user.click(screen.getByRole('button', { name: '이전' }));
    expect(await within(screen.getByRole('dialog')).findByRole('link', { name: /관리자 AAS/ })).toBeInTheDocument();
  });

  it('첫째 줄 안내가 보인다. 목록에 없는 에이전트는 링크 없이 글자다(D4·R5)', async () => {
    mount('/profiles?name=ma', DETAIL({ pod: 'p9' }), LIST(), { '/api/me': ME('p9', '나눠 받은 것'), '/api/agents': { agents: [] } });
    const dlg = await screen.findByRole('dialog');
    await within(dlg).findByText('프로파일은 AI 에이전트 작업공간마다 따로 있습니다');
    expect(within(dlg).queryByRole('link', { name: /나눠 받은 것/ })).toBeNull();
  });

  it('저장 요청에 지금 에이전트(expect_pod)를 싣고, 409 면 서랍 안에 경고와 「다시 불러오기」를 보인다(R1 ③·D10)', async () => {
    const fn = mount('/profiles?name=ma', DETAIL({ pod: 'p2' }), LIST(), { '/api/me': ME(), '/api/agents': AGENTS });
    const orig = fn.getMockImplementation()!;
    fn.mockImplementation((url: string, init?: RequestInit) =>
      String(url).startsWith('/api/profile/action')
        ? Promise.resolve(new Response(JSON.stringify({ error: '다른 에이전트로 바뀌었습니다', reason: 'agent_changed' }), { status: 409 }))
        : orig(url, init)
    );
    const dlg = await screen.findByRole('dialog');
    fireEvent.click(await within(dlg).findByRole('button', { name: '시작' })); // 게이트웨이 시작 → 확인 창
    fireEvent.click(await screen.findByRole('button', { name: '확인' }));
    await waitFor(() => expect(postedTo(fn, '/api/profile/action').at(-1)).toMatchObject({ expect_pod: 'p2' }));
    expect(await within(dlg).findByText(/다른 AI 에이전트 작업공간으로 바뀌었습니다. 고치던 글은/)).toBeInTheDocument();
    expect(within(dlg).getByText('다시 불러오기').closest('button')).not.toBeNull();
  });

  it('응답의 pod 가 지금 에이전트와 다르면 그 내용을 보이지 않는다(R1 ②)', async () => {
    mount('/profiles?name=ma', DETAIL({ pod: 'p1' }), LIST(), { '/api/me': ME(), '/api/agents': AGENTS });
    const dlg = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dlg).queryByText('게이트웨이')).toBeNull());
  });

  it('그 에이전트에 이 이름이 없으면(404) 안내와 「프로파일 목록 보기」를 보인다(R8·D9)', async () => {
    const notFound = () => new Response(JSON.stringify({ error: '없는 프로파일입니다', reason: 'profile_not_found' }), { status: 404 });
    mount('/profiles?name=ma', notFound, LIST(), { '/api/me': ME(), '/api/agents': AGENTS });
    const dlg = await screen.findByRole('dialog');
    expect(await within(dlg).findByText('관리자 AAS에 ma 프로파일이 없습니다')).toBeInTheDocument();
    expect(within(dlg).getByRole('button', { name: '프로파일 목록 보기' })).toBeInTheDocument();
  });

  it('임시 저장본은 에이전트별이라 다른 에이전트의 같은 이름 글은 「이어쓰기」로 뜨지 않는다(디자인 D6)', async () => {
    localStorage.setItem('aas.draft.p1:soul:ma', JSON.stringify({ text: '마케팅 도우미의 글', sha: 'ss1', ts: Date.now() }));
    mount('/profiles?name=ma&pane=soul', DETAIL({ pod: 'p2' }), LIST(), { '/api/me': ME(), '/api/agents': AGENTS });
    const dlg = await screen.findByRole('dialog');
    await within(dlg).findByText('친절하게');
    expect(within(dlg).queryByText(/이 브라우저에 저장하지 않은 수정이 있습니다/)).toBeNull();
  });
});

// 팀 관리자(스펙 2026-10-22-001 DD5): 서랍이 다루는 에이전트(지금 에이전트)가 팀원 것일 때만 머리에 대상 표시
describe('프로파일 서랍: 팀원 에이전트 표시', () => {
  const ME = (team: boolean) => ({
    auth_enabled: true,
    admin: false,
    user: { email: 'kim@x.com' },
    pod: { id: 'p2', owner: team ? 'park@x.com' : 'kim@x.com', owner_name: team ? '박팀원' : '', name: '영업', team },
    pods: [],
  });

  it('팀원 에이전트의 프로파일이면 서랍 머리에 「팀원 <주인>의 에이전트를 바꿉니다」 상태 줄이 있다', async () => {
    mount('/profiles?name=ma', DETAIL({ pod: 'p2' }), LIST(), { '/api/me': ME(true), '/api/office': { agents: [] } });
    const dlg = await screen.findByRole('dialog');
    const note = await within(dlg).findByText('팀원 박팀원의 AI 에이전트 작업공간을 바꿉니다');
    expect(note.closest('[role="status"]')).not.toBeNull();
  });

  it('내 에이전트의 프로파일이면 표시가 없다', async () => {
    mount('/profiles?name=ma', DETAIL({ pod: 'p2' }), LIST(), { '/api/me': ME(false), '/api/office': { agents: [] } });
    const dlg = await screen.findByRole('dialog');
    await within(dlg).findByRole('tab', { name: /개요/ });
    expect(screen.queryByText(/AI 에이전트 작업공간을 바꿉니다/)).toBeNull();
  });
});
