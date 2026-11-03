/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountScreen, postedTo, stubApi } from '@/test/mountScreen';

import { InboxButton } from './InboxButton';
import { InboxPanel } from './InboxPanel';

afterEach(() => vi.unstubAllGlobals());

const ITEMS = [
  {
    id: 'a1',
    kind: 'approval',
    alias: 'ops',
    text: '파일 삭제',
    command: 'rm -rf /tmp/x',
    choices: ['once', 'deny'],
    at: 0,
  },
  { id: 'q1', kind: 'clarify', alias: 'ops', text: '어느 쪽?' },
  { id: 'card|b|1', kind: 'review', alias: 'ops', text: '보고서', board: 'b', task_id: '1' },
  { id: 'cron|p|ops|j', kind: 'cron_failed', alias: 'ops', text: '아침 보고', error: 'timeout' },
];

describe('받은편지함(계획 007 P4)', () => {
  it('승인은 그 자리에서 고르고, 질문에는 답을 보낸다', async () => {
    const fn = stubApi({ '/api/office/inbox/answer': { ok: true }, '/api/office/inbox': { items: ITEMS } });
    mountScreen(<InboxPanel />, '/office');
    await userEvent.click(await screen.findByRole('button', { name: '한 번 허용' }));
    // 에이전트가 명령을 실행하게 되므로 확인을 받는다. 확인 창에 명령이 보인다(OMAI-1135)
    const box = await screen.findByRole('dialog');
    expect(box).toHaveTextContent('ops 이(가) 이 명령을 이번 한 번 실행하도록 허용합니다.');
    expect(box).toHaveTextContent('rm -rf /tmp/x');
    await userEvent.click(screen.getByRole('button', { name: '확인' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/inbox/answer')).toEqual([{ id: 'a1', choice: 'once' }]));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); // 확인 창이 닫힌 뒤
    await userEvent.type(screen.getByLabelText('답'), '오른쪽');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/inbox/answer')[1]).toEqual({ id: 'q1', answer: '오른쪽' }));
    expect(screen.getByRole('link', { name: '칸반에서 보기' })).toHaveAttribute('href', '/office?tab=kanban&board=b');
    expect(screen.getByText('timeout')).toBeInTheDocument();
  });

  it('항목 머리와 확인창은 서버가 준 이름(label)을 쓰고 설치본 id 별칭을 보이지 않는다(스펙 2026-10-19-003)', async () => {
    const items = [{ id: 'a9', kind: 'approval', alias: 'aas-agent-kim-1a2b', label: '영업 도우미', text: '파일 삭제', command: 'rm x', choices: ['once'] }];
    stubApi({ '/api/office/inbox/answer': { ok: true }, '/api/office/inbox': { items } });
    mountScreen(<InboxPanel />, '/office');
    expect(await screen.findByText(/· 영업 도우미$/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '한 번 허용' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('영업 도우미 이(가) 이 명령을');
    expect(screen.queryByText(/aas-agent-kim-1a2b/)).toBeNull();
  });

  it('관리자 요청: 누가 무엇을 며칠째 기다리는지 보이고, 처리했습니다는 바로, 거절은 사유를 적어 보낸다(스펙 2026-10-15-011 단계 5)', async () => {
    const items = [
      { id: 'areq|1', kind: 'admin_request', alias: 'ma', text: '모델을 바꿔 주세요', requester: 'kim@example.com', requester_name: '김영주', req_kind: 'model_change', profile: 'ma', waiting_days: 9, stale: true },
      { id: 'areq|2', kind: 'admin_request', alias: 'sa', text: '', requester: 'lee@example.com', req_kind: 'other', profile: 'sa', waiting_days: 0 },
    ];
    const fn = stubApi({ '/api/office/inbox/answer': { ok: true }, '/api/office/inbox': { items } });
    mountScreen(<InboxPanel />, '/office');
    // 요청자는 사람 이름으로, 이메일은 풍선말로(2026-10-30). 이름이 없는 옛 응답은 이메일 그대로
    expect(await screen.findByText('김영주 · 모델 변경 요청 · 대기 9일')).toHaveAttribute('title', 'kim@example.com');
    expect(screen.getByText('lee@example.com · 기타 요청 · 대기 0일')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: '프로파일 열기' })[0]).toHaveAttribute('href', '/profiles?name=ma');
    await userEvent.click(screen.getAllByRole('button', { name: '처리했습니다' })[0]);
    await waitFor(() => expect(postedTo(fn, '/api/office/inbox/answer')).toEqual([{ id: 'areq|1', choice: 'handled' }]));
    const second = screen.getAllByRole('listitem')[1];
    await userEvent.click(within(second).getByRole('button', { name: '거절' }));
    await userEvent.type(within(second).getByLabelText('거절 사유(선택)'), '정책상 어렵습니다');
    await userEvent.click(within(second).getByRole('button', { name: '거절' }));
    await waitFor(() =>
      expect(postedTo(fn, '/api/office/inbox/answer')[1]).toEqual({ id: 'areq|2', choice: 'declined', reason: '정책상 어렵습니다' })
    );
  });

  it('남은 데이터 볼륨: 볼륨마다 에이전트·옛 주인·기간·크기·내보내기를 보이고, 지울 명령과 처리했습니다를 둔다(OMAI-1291)', async () => {
    const items = [
      {
        id: 'rvol|abc',
        kind: 'retained_volume',
        alias: '',
        text: '',
        days: 30,
        command: 'kubectl -n agents delete pvc data-aas-agent-a-1111-0 data-old-0',
        volumes: [
          { pvc: 'data-aas-agent-a-1111-0', agent: 'aas-agent-a-1111', owner: 'a@x.com', agent_name: '영업 도우미', owner_name: '김에이', since: '2026-09-01T09:00:00+09:00', known: true, days: 45, size: '5Gi', export: 'a.tar.gz' },
          { pvc: 'data-old-0', agent: 'old', owner: '', since: '2026-09-15T09:00:00+09:00', known: false, days: 31, size: '10Gi', export: '' },
        ],
      },
    ];
    const fn = stubApi({ '/api/office/inbox/answer': { ok: true }, '/api/office/inbox': { items } });
    mountScreen(<InboxPanel />, '/office');
    expect(await screen.findByText('지운 AI 에이전트 작업공간의 데이터 볼륨 2개가 30일 넘게 남아 있습니다')).toBeInTheDocument();
    expect(screen.getByText('남은 데이터 볼륨')).toBeInTheDocument(); // 에이전트 이름이 없는 항목은 「 · 」를 붙이지 않는다
    // 지울 때 적은 이름이 있으면 「옛 주인 · 에이전트 이름」(스펙 2026-10-19-003)
    expect(screen.getByText('김에이 · 영업 도우미 · 지운 지 45일 · 5Gi · 내보내기 a.tar.gz')).toBeInTheDocument();
    expect(screen.getByText('old · 처음 본 지 31일 · 10Gi')).toBeInTheDocument();
    expect(screen.getByText('kubectl -n agents delete pvc data-aas-agent-a-1111-0 data-old-0')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '처리했습니다' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/inbox/answer')).toEqual([{ id: 'rvol|abc', choice: 'handled' }]));
  });

  it('요청 결과: 처리됨·거절됨과 사유를 보이고 확인하면 id 만 보낸다. 관리자 이름은 없다', async () => {
    const items = [{ id: 'areq_res|3', kind: 'admin_request_result', alias: 'ma', text: '모델을 바꿔 주세요', status: 'declined', reason: '정책상 어렵습니다' }];
    const fn = stubApi({ '/api/office/inbox/answer': { ok: true }, '/api/office/inbox': { items } });
    mountScreen(<InboxPanel />, '/office');
    expect(await screen.findByText('관리자가 요청을 거절했습니다 — 정책상 어렵습니다')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '확인했습니다' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/inbox/answer')).toEqual([{ id: 'areq_res|3' }]));
  });

  it('거절도 확인을 받고, 취소하면 보내지 않는다', async () => {
    const fn = stubApi({ '/api/office/inbox/answer': { ok: true }, '/api/office/inbox': { items: ITEMS } });
    mountScreen(<InboxPanel />, '/office');
    await userEvent.click(await screen.findByRole('button', { name: '거부' }));
    expect(await screen.findByText(/이 명령을 거부합니다/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '취소' }));
    expect(postedTo(fn, '/api/office/inbox/answer')).toEqual([]);
    await userEvent.click(await screen.findByRole('button', { name: '거부' }));
    await userEvent.click(await screen.findByRole('button', { name: '확인' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/inbox/answer')).toEqual([{ id: 'a1', choice: 'deny' }]));
  });

  it('비어 있으면 「답할 일 없음」', async () => {
    stubApi({ '/api/office/inbox': { items: [] } });
    mountScreen(<InboxPanel />, '/office');
    expect(await screen.findByText('답할 일 없음')).toBeInTheDocument();
  });

  it('머리줄 종에 개수를 보이고 누르면 받은편지함을 연다', async () => {
    stubApi({ '/api/office/inbox': { items: ITEMS } });
    mountScreen(<InboxButton />, '/office');
    await userEvent.click(await screen.findByRole('button', { name: '받은편지함 4건' }));
    expect(await screen.findByText('파일 삭제')).toBeInTheDocument();
  });

  it('크론 완료 항목은 결과 보기 링크와 「확인했습니다」를 내고, 확인하면 id 만 보낸다(스펙 2026-10-15-003 R3)', async () => {
    const fn = stubApi({
      '/api/office/inbox/answer': { ok: true },
      '/api/office/inbox': { items: [{ id: 'cron_done|p|main|j1|2026-10-15T01:00:00+00:00', kind: 'cron_done', alias: 'ops', text: '주간 보고' }] },
    });
    mountScreen(<InboxPanel />, '/office');
    expect(await screen.findByText('주간 보고')).toBeInTheDocument();
    expect(screen.getByText(/예약 작업 완료/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /예약 작업 보기/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '확인했습니다' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/inbox/answer')).toEqual([{ id: 'cron_done|p|main|j1|2026-10-15T01:00:00+00:00' }]));
  });

  it('「크론 보기」는 프로파일·작업 id 로 그 작업의 서랍을 연다(오피스 자리 이름으로 검색하면 빈 표였다)', async () => {
    stubApi({
      '/api/office/inbox': {
        items: [
          { id: 'cron|p|main|j1', kind: 'cron_failed', alias: 'aas-agent-x-8c07', profile: 'main', job_id: 'j1', text: '주간 보고', error: 'x' },
          { id: 'cron_done|p|ops|j2|t', kind: 'cron_done', alias: 'aas-agent-y-1a2b', profile: 'ops', job_id: 'j2', text: '아침 보고' },
        ],
      },
    });
    mountScreen(<InboxPanel />, '/office');
    const links = await screen.findAllByRole('link', { name: '예약 작업 보기' });
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/cron?open=main%2Fj1', '/cron?open=ops%2Fj2']);
  });

  it('MCP 로그인 필요 항목은 에이전트·서버를 말하고 그 프로파일의 MCP 탭 서버 행으로 간다(스펙 2026-10-16-010 T8·V14)', async () => {
    stubApi({
      '/api/office/inbox': {
        items: [
          { id: 'mcp_login|p1|main|jira', kind: 'mcp_login', alias: '도우미', pod: '', profile: 'main', server: 'jira', text: 'jira', reauth: true },
          { id: 'mcp_login|p1|main|wiki', kind: 'mcp_login', alias: '도우미', pod: '', profile: 'main', server: 'wiki', text: 'wiki', reauth: false },
        ],
      },
    });
    mountScreen(<InboxPanel />, '/office');
    expect(await screen.findByText('도우미의 MCP 서버 jira에 다시 로그인해야 합니다')).toBeInTheDocument();
    expect(screen.getByText('도우미의 MCP 서버 wiki에 로그인해야 합니다')).toBeInTheDocument();
    expect(screen.getAllByText('MCP 로그인 · 도우미')).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: 'MCP 탭 열기' })[0]).toHaveAttribute('href', '/profiles?name=main&pane=tools&server=jira');
  });

  it('프로파일·작업 id 가 없는 옛 응답은 자리 이름 검색으로 대신한다', async () => {
    stubApi({ '/api/office/inbox': { items: [{ id: 'c', kind: 'cron_failed', alias: 'ops', text: '아침 보고' }] } });
    mountScreen(<InboxPanel />, '/office');
    expect(await screen.findByRole('link', { name: '예약 작업 보기' })).toHaveAttribute('href', '/cron?q=ops');
  });

  it('다른 POD 의 크론 항목은 그 POD 로 전환한 뒤 연다(Cron 화면은 보고 있는 POD 의 작업만 보인다)', async () => {
    const fn = stubApi({
      '/api/me': { auth_enabled: true, admin: true, pod: { id: 'p1', owner: '' }, pods: [{ id: 'p1', owner: '' }, { id: 'p2', owner: '' }], user: { email: 'a@x.com' } },
      '/api/pod': { ok: true },
      '/api/office/inbox': {
        items: [
          { id: 'cron|p2|main|j1', kind: 'cron_failed', alias: 'aas-agent-x-8c07', pod: 'p2', profile: 'main', job_id: 'j1', text: '주간 보고', error: 'x' },
          { id: 'cron|p1|main|j9', kind: 'cron_failed', alias: 'aas-agent-me', pod: 'p1', profile: 'main', job_id: 'j9', text: '내 작업', error: 'x' },
        ],
      },
    });
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload, hash: '' });
    mountScreen(<InboxPanel />, '/office');
    // 지금 보는 POD 의 항목은 링크, 다른 POD 의 항목은 전환 단추
    expect(await screen.findByRole('link', { name: '예약 작업 보기' })).toHaveAttribute('href', '/cron?open=main%2Fj9');
    await userEvent.click(screen.getByRole('button', { name: '예약 작업 보기' }));
    await waitFor(() => expect(postedTo(fn, '/api/pod')).toEqual([{ id: 'p2' }]));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(window.location.hash).toBe('#/cron?open=main%2Fj1');
  });
});

describe('받은편지함의 PC 에서 가져오기 알림(OMAI-1136 §10-5)', () => {
  it('상태마다 문장을 고르고 main 상세로 가는 링크와 「확인했습니다」를 둔다', async () => {
    const items = [
      { id: 'pcimp|a', kind: 'pc_import', status: 'by_admin', pod: 'p1', profile: 'main', alias: 'kim-main', by: 'admin@x.com', text: '', at: 1760662800 },
      { id: 'pcimp|b', kind: 'pc_import', status: 'rollback_failed', pod: 'p1', profile: 'main', alias: 'kim-main', by: 'kim@x.com', text: '' },
      { id: 'pcimp|c', kind: 'pc_import', status: 'done', pod: 'p1', profile: 'main', alias: 'kim-main', by: 'kim@x.com', text: '' },
      { id: 'pcimp|d', kind: 'pc_import', status: 'rolled_back', pod: 'p1', profile: 'main', alias: 'kim-main', by: 'kim@x.com', text: '' },
      { id: 'pcimp|e', kind: 'pc_import', status: 'by_admin', pod: 'p1', profile: 'main', alias: 'kim-main', by: 'boss@x.com', text: '', secrets: { files: 2, env: 3 } },
    ];
    const fn = stubApi({ '/api/office/inbox/answer': { ok: true }, '/api/office/inbox': { items } });
    mountScreen(<InboxPanel />, '/office');
    expect(await screen.findByText(/^관리자 admin@x.com가 main 프로파일에 PC 의 Hermes 를 넣었습니다 · /)).toBeInTheDocument();
    expect(screen.getByText('main 프로파일 가져오기를 되돌리지 못했습니다')).toBeInTheDocument();
    expect(screen.getByText('main 프로파일 가져오기가 끝났습니다')).toBeInTheDocument();
    expect(screen.getByText('main 프로파일 가져오기를 되돌렸습니다')).toBeInTheDocument();
    expect(screen.getByText('boss@x.com 님이 PC 의 Hermes 를 main 프로파일에 넣었습니다 · 인증 파일 2개를 바꾸고 비밀값 3개를 더했습니다')).toBeInTheDocument();   // DD20
    expect(screen.getAllByText('PC 에서 가져오기 · kim-main')).toHaveLength(5);
    expect(screen.getAllByRole('link', { name: '프로파일 열기' })[0]).toHaveAttribute('href', '/profiles?name=main');
    await userEvent.click(screen.getAllByRole('button', { name: '확인했습니다' })[0]);
    await waitFor(() => expect(postedTo(fn, '/api/office/inbox/answer')).toEqual([{ id: 'pcimp|a' }]));
  });

  it('main 이 아닌 프로파일은 그 이름으로 쓰고, 지운 프로파일(profile 빈 값)은 「지운 프로파일의 …」와 링크 대신 안내(OMAI-1444 DD8·DD12)', async () => {
    const items = [
      { id: 'pcimp|r', kind: 'pc_import', status: 'done', pod: 'p1', profile: 'research', alias: 'kim-research', by: 'kim@x.com', text: '' },
      { id: 'pcimp|x', kind: 'pc_import', status: 'done', pod: 'p1', profile: '', alias: 'kim', by: 'kim@x.com', text: '' },
      { id: 'pcimp|y', kind: 'pc_import', status: 'rolled_back', pod: 'p1', profile: '', alias: 'kim', by: 'kim@x.com', text: '' },
      { id: 'pcimp|z', kind: 'pc_import', status: 'rollback_failed', pod: 'p1', profile: '', alias: 'kim', by: 'kim@x.com', text: '' },
      { id: 'pcimp|w', kind: 'pc_import', status: 'by_admin', pod: 'p1', profile: '', alias: 'kim', by: 'admin@x.com', text: '', at: 1760662800 },
    ];
    stubApi({ '/api/office/inbox/answer': { ok: true }, '/api/office/inbox': { items } });
    mountScreen(<InboxPanel />, '/office');
    expect(await screen.findByText('research 프로파일 가져오기가 끝났습니다')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '프로파일 열기' })).toHaveAttribute('href', '/profiles?name=research');   // 지운 것에는 링크가 없다
    expect(screen.getByText('지운 프로파일의 가져오기가 끝났습니다')).toBeInTheDocument();
    expect(screen.getByText('지운 프로파일의 가져오기를 되돌렸습니다')).toBeInTheDocument();
    expect(screen.getByText('지운 프로파일의 가져오기를 되돌리지 못했습니다')).toBeInTheDocument();
    expect(screen.getByText(/^관리자 admin@x.com가 PC 의 Hermes 를 넣은 프로파일은 지워졌습니다 · /)).toBeInTheDocument();
    expect(screen.getAllByText('프로파일을 지웠습니다')).toHaveLength(4);
    expect(screen.getAllByText('PC 에서 가져오기 · kim')).toHaveLength(4);          // 머리 줄은 AI 에이전트 작업공간 이름만
  });
});

describe('받은편지함의 Claude Code 연결 알림(스펙 2026-10-28-001 §3-7 ③)', () => {
  it('OAuth·수동 토큰 만료 예정과 관리자가 끊은 연결을 문장으로 보이고, 수동 토큰은 「새 토큰 만들기」로 간다', async () => {
    const exp = 1767225600; // 2026-01-01T00:00:00Z
    const items = [
      { id: 'conn|exp|o1|1', kind: 'connection', status: 'expiring', name: 'Claude Code (aas)', token_kind: 'oauth', expires: exp, alias: '', text: '' },
      { id: 'conn|exp|p1|1', kind: 'connection', status: 'expiring', name: '빌드 서버', token_kind: 'pat', expires: exp, alias: '', text: '' },
      { id: 'conn|rev|p2', kind: 'connection', status: 'revoked', name: 'CI', token_kind: 'pat', by: 'boss@x.com', reason: '퇴사 정리', alias: '', text: '' },
    ];
    const fn = stubApi({ '/api/office/inbox/answer': { ok: true }, '/api/office/inbox': { items } });
    mountScreen(<InboxPanel />, '/office');
    expect(await screen.findByText(/^Claude Code \(aas\) 연결이 2026-01-0\d 에 끝납니다\. 다음에 Claude Code 가 브라우저를 열면/)).toBeInTheDocument();
    expect(screen.getByText(/^빌드 서버 토큰이 2026-01-0\d 에 끝납니다\. 이 토큰을 쓰는 곳이 멈춥니다\.$/)).toBeInTheDocument();
    expect(screen.getByText('CI 연결을 boss@x.com 가 끊었습니다 — 퇴사 정리')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '새 토큰 만들기' })).toHaveAttribute('href', '/connections');
    expect(screen.getAllByRole('link', { name: 'Claude Code 연결 보기' })).toHaveLength(2);
    await userEvent.click(screen.getAllByRole('button', { name: '확인했습니다' })[2]);
    await waitFor(() => expect(postedTo(fn, '/api/office/inbox/answer')).toEqual([{ id: 'conn|rev|p2' }]));
  });
  describe('답할 일·알림 나눔과 「모두 확인」(스펙 2026-10-30-001)', () => {
    const MIXED = [
      { id: 'a1', kind: 'approval', alias: 'ops', text: '파일 삭제', command: 'rm x', choices: ['once', 'deny'] },
      { id: 'cron_done|p|ops|j1|t', kind: 'cron_done', alias: 'ops', text: '주간 보고' },
      { id: 'pci|1', kind: 'pc_import', status: 'done', profile: 'main', alias: '', text: '' },
    ];

    it('답이 필요한 항목과 확인만 하면 되는 알림을 따로 묶고 개수를 보인다', async () => {
      stubApi({ '/api/office/inbox': { items: MIXED } });
      mountScreen(<InboxPanel />, '/office');
      const needs = await screen.findByRole('region', { name: '답할 일' });
      const notices = screen.getByRole('region', { name: '알림' });
      expect(within(needs).getByRole('heading')).toHaveTextContent('답할 일1');
      expect(within(notices).getByRole('heading')).toHaveTextContent('알림2');
      expect(within(needs).getByText('파일 삭제')).toBeInTheDocument();
      expect(within(needs).queryByRole('button', { name: '확인했습니다' })).toBeNull();
      expect(within(notices).getAllByRole('button', { name: '확인했습니다' })).toHaveLength(2);
    });

    it('서랍 머리줄의 「모두 확인」은 확인을 받은 뒤 알림만 지우고 승인은 남긴다', async () => {
      const fn = stubApi({ '/api/office/inbox/answer': { ok: true }, '/api/office/inbox': { items: MIXED } });
      mountScreen(<InboxButton />, '/office');
      await userEvent.click(await screen.findByRole('button', { name: '받은편지함 3건' }));
      await userEvent.click(await screen.findByRole('button', { name: '모두 확인' }));
      const box = await screen.findByRole('dialog');
      expect(box).toHaveTextContent('알림 2건을 모두 확인 처리합니다');
      expect(postedTo(fn, '/api/office/inbox/answer')).toEqual([]);
      await userEvent.click(within(box).getByRole('button', { name: '모두 확인' }));
      await waitFor(() =>
        expect(postedTo(fn, '/api/office/inbox/answer')).toEqual(expect.arrayContaining([{ id: 'cron_done|p|ops|j1|t' }, { id: 'pci|1' }]))
      );
      expect(postedTo(fn, '/api/office/inbox/answer')).toHaveLength(2);
    });

    it('알림이 없으면 「모두 확인」을 두지 않는다', async () => {
      stubApi({ '/api/office/inbox': { items: [MIXED[0]] } });
      mountScreen(<InboxButton />, '/office');
      await userEvent.click(await screen.findByRole('button', { name: '받은편지함 1건' }));
      expect(await screen.findByText('파일 삭제')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '모두 확인' })).toBeNull();
    });
  });
});
