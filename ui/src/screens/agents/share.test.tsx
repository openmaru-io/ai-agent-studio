/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 작업공간 서랍의 「공유」 구역(스펙 2026-11-17-008 §3-4)과 채팅 시작 안내, 설정의 공유 스위치(§3-6)
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedWorkspaceNote } from '@/components/SharedWorkspaceNote';
import { mountScreen, postedTo, stubApi } from '@/test/mountScreen';

import { SharingSettings } from '../settings/Sharing';
import { SharePanel, type SharingData } from './share';

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => localStorage.clear());

const DATA = (over: Partial<SharingData> = {}): SharingData => ({
  pod: 'kim',
  enabled: true,
  can_manage: true,
  owner: 'kim@x.com',
  owner_name: '김소유',
  my_role: 'owner',
  members: [],
  granted: [],
  note: '',
  since: '',
  hide_before: '',
  note_max: 200,
  ...over,
});

describe('공유 구역', () => {
  it('설치에서 공유를 끄면 그리지 않는다', async () => {
    const fn = stubApi({ '/api/agents/members': DATA({ enabled: false }) });
    mountScreen(<SharePanel pod="kim" />, '/');
    await waitFor(() => expect(fn).toHaveBeenCalled());
    expect(screen.queryByRole('heading', { name: '공유' })).not.toBeInTheDocument();
  });

  it('처음 공유하면 확인 창을 띄우고, 기본으로 공유 이전 대화를 숨긴다', async () => {
    const user = userEvent.setup();
    const fn = stubApi({ '/api/agents/members/search': { people: [] }, '/api/agents/members': (_u: string, b: Record<string, unknown>) => (b.op ? { ok: true } : DATA()) });
    mountScreen(<SharePanel pod="kim" />, '/');
    expect(await screen.findByText('아직 공유한 사람이 없습니다.')).toBeInTheDocument();
    await user.type(screen.getByRole('combobox', { name: '팀원' }), 'park@x.com');
    await user.click(within(screen.getByRole('group', { name: '권한' })).getByRole('button', { name: '편집' }));
    await user.click(screen.getByRole('button', { name: '팀원 추가' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/API 키·봇 토큰을 볼 수 있고/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '공유' }));
    await waitFor(() =>
      expect(postedTo(fn, '/api/agents/members')).toEqual([{ pod: 'kim', op: 'set', email: 'park@x.com', role: 'edit', hide_before: true }])
    );
  });

  it('이미 공유한 작업공간은 확인 없이 넣고, 체크로 이전 대화를 보이게 할 수 없다(처음에만 고른다)', async () => {
    const user = userEvent.setup();
    const fn = stubApi({
      '/api/agents/members/search': { people: [] },
      '/api/agents/members': (_u: string, b: Record<string, unknown>) => (b.op ? { ok: true } : DATA({ since: '2026-11-17T10:00:00+09:00' })),
    });
    mountScreen(<SharePanel pod="kim" />, '/');
    await user.type(await screen.findByRole('combobox', { name: '팀원' }), 'lee@x.com');
    await user.click(screen.getByRole('button', { name: '팀원 추가' }));
    await waitFor(() => expect(postedTo(fn, '/api/agents/members')).toHaveLength(1));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('이메일이 아니면 보내지 않는다', async () => {
    const user = userEvent.setup();
    const fn = stubApi({ '/api/agents/members/search': { people: [] }, '/api/agents/members': DATA({ since: 'x' }) });
    mountScreen(<SharePanel pod="kim" />, '/');
    await user.type(await screen.findByRole('combobox', { name: '팀원' }), '박팀원');
    await user.click(screen.getByRole('button', { name: '팀원 추가' }));
    expect(await screen.findByText('목록에서 고르거나 이메일 주소를 적으세요.')).toBeInTheDocument();
    expect(postedTo(fn, '/api/agents/members')).toEqual([]);
  });

  it('공유 해제는 위험 확인을 거쳐 role none 을 보낸다', async () => {
    const user = userEvent.setup();
    const members = [{ email: 'lee@x.com', name: '이팀원', department: '영업팀', role: 'use' as const }];
    const fn = stubApi({ '/api/agents/members': (_u: string, b: Record<string, unknown>) => (b.op ? { ok: true } : DATA({ since: 'x', members })) });
    mountScreen(<SharePanel pod="kim" />, '/');
    await user.click(await screen.findByRole('button', { name: '이팀원 공유 해제' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: '공유 해제' }));
    await waitFor(() => expect(postedTo(fn, '/api/agents/members')).toEqual([{ pod: 'kim', op: 'set', email: 'lee@x.com', role: 'none' }]));
  });

  it('목록 첫 줄은 소유자이고, 구성원 권한은 대화·편집 두 칸으로 바로 바꾼다', async () => {
    const user = userEvent.setup();
    const members = [{ email: 'lee@x.com', name: '이팀원', role: 'use' as const }];
    const fn = stubApi({ '/api/agents/members': (_u: string, b: Record<string, unknown>) => (b.op ? { ok: true } : DATA({ since: 'x', members })) });
    mountScreen(<SharePanel pod="kim" />, '/');
    const list = await screen.findByRole('list', { name: '공유받은 사람' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('김소유');
    expect(rows[0]).toHaveTextContent('소유자');
    const group = within(list).getByRole('group', { name: '이팀원 의 권한' });
    expect(within(group).getByRole('button', { name: '대화' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(group).getByRole('button', { name: '편집' }));
    await waitFor(() => expect(postedTo(fn, '/api/agents/members')).toEqual([{ pod: 'kim', op: 'set', email: 'lee@x.com', role: 'edit' }]));
  });

  it('안내 저장 단추는 글을 고쳤을 때만 칸 안에 나온다', async () => {
    const user = userEvent.setup();
    const fn = stubApi({ '/api/agents/members': (_u: string, b: Record<string, unknown>) => (b.op ? { ok: true } : DATA({ since: 'x', note: '옛 안내' })) });
    mountScreen(<SharePanel pod="kim" />, '/');
    const field = await screen.findByRole('textbox', { name: '팀원에게 보일 안내' });
    expect(screen.queryByRole('button', { name: '안내 저장' })).not.toBeInTheDocument();
    await user.clear(field);
    await user.type(field, '새 안내');
    await user.click(screen.getByRole('button', { name: '안내 저장' }));
    await waitFor(() => expect(postedTo(fn, '/api/agents/members')).toEqual([{ pod: 'kim', op: 'note', note: '새 안내' }]));
  });

  it('바꿀 수 없는 사람에게는 목록·권한·안내만 보인다', async () => {
    const members = [{ email: 'lee@x.com', name: '이팀원', role: 'edit' as const }];
    stubApi({
      '/api/agents/members': DATA({ can_manage: false, my_role: 'use', since: 'x', members, note: '주간 보고는 여기서', granted: [{ email: 'v@x.com', name: '보기만' }] }),
    });
    mountScreen(<SharePanel pod="kim" />, '/');
    const list = await screen.findByRole('list', { name: '공유받은 사람' });
    expect(within(list).getByText('편집')).toBeInTheDocument();
    expect(within(list).getByText('관리자가 줌')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '팀원 추가' })).not.toBeInTheDocument();
    expect(screen.getByText('김소유 님의 안내: 주간 보고는 여기서')).toBeInTheDocument();
  });

  it('소유자가 없는 작업공간은 관리자만 바꾼다고 알린다', async () => {
    stubApi({ '/api/agents/members': DATA({ can_manage: false, owner: '', my_role: 'use' }) });
    mountScreen(<SharePanel pod="kim" />, '/');
    expect(await screen.findByText(/관리자만 공유를 바꿀 수 있습니다/)).toBeInTheDocument();
  });
});

describe('채팅의 공유 시작 안내', () => {
  it('공유받은 사람에게만, 닫으면 다시 보이지 않는다', async () => {
    const user = userEvent.setup();
    stubApi({});
    const { unmount } = mountScreen(<SharedWorkspaceNote pod="kim" access="use" owner="김소유" note="주간 보고는 여기서" />, '/');
    expect(screen.getByTestId('shared-workspace-note')).toHaveTextContent('김소유 님이 공유한 AI 에이전트 작업공간입니다 — 주간 보고는 여기서');
    await user.click(screen.getByRole('button', { name: '안내 닫기' }));
    expect(screen.queryByTestId('shared-workspace-note')).not.toBeInTheDocument();
    unmount();
    mountScreen(<SharedWorkspaceNote pod="kim" access="use" owner="김소유" note="주간 보고는 여기서" />, '/');
    expect(screen.queryByTestId('shared-workspace-note')).not.toBeInTheDocument();
  });

  it('소유자·관리자에게는 그리지 않는다', () => {
    stubApi({});
    mountScreen(<SharedWorkspaceNote pod="kim" access="owner" owner="김소유" note="x" />, '/');
    expect(screen.queryByTestId('shared-workspace-note')).not.toBeInTheDocument();
  });
});

describe('설정 › AI 에이전트 작업공간 공유', () => {
  it('현황을 보이고, 끌 때는 확인을 거친다', async () => {
    const user = userEvent.setup();
    const rows = [{ pod: 'kim', owner_name: '김소유', email: 'lee@x.com', name: '이팀원', department: '영업팀', role: 'edit', source: 'owner', ts: '' }];
    const fn = stubApi({ '/api/admin/sharing': { enabled: true, rows }, '/api/settings/sharing': { ok: true, enabled: false } });
    mountScreen(<SharingSettings />, '/');
    const table = await screen.findByRole('table', { name: '공유 현황' });
    expect(within(table).getByText('이팀원 (영업팀)')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'CSV 내려받기' })).toHaveAttribute('href', expect.stringContaining('/api/admin/sharing?format=csv'));
    await user.click(screen.getByRole('checkbox', { name: '소유자 공유 허용' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '끄기' }));
    await waitFor(() => expect(postedTo(fn, '/api/settings/sharing')).toEqual([{ enabled: false }]));
  });
});

describe('알림 전달 화면(스펙 2026-11-17-008 §6)', () => {
  it('설정: 웹훅 길이 열린 설치에서만 메신저 알림 전달을 켜고 끈다', async () => {
    const user = userEvent.setup();
    const fn = stubApi({
      '/api/admin/sharing': { enabled: true, rows: [], notify: { installed: true, enabled: true } },
      '/api/settings/sharing': { ok: true },
    });
    mountScreen(<SharingSettings />, '/');
    await user.click(await screen.findByRole('checkbox', { name: '받는 사람의 메신저로도 알림 전달' }));
    await waitFor(() => expect(postedTo(fn, '/api/settings/sharing')).toEqual([{ notify: false }]));
  });

  it('설정: 길이 없으면 스위치를 막고 이유를 보인다', async () => {
    stubApi({ '/api/admin/sharing': { enabled: true, rows: [], notify: { installed: false, enabled: true } } });
    mountScreen(<SharingSettings />, '/');
    expect(await screen.findByRole('checkbox', { name: '받는 사람의 메신저로도 알림 전달' })).toBeDisabled();
    expect(screen.getByText(/agents.notifyWebhook/)).toBeInTheDocument();
  });

  it('공유 구역: 소유자가 팀 공지 대화방을 고른다', async () => {
    const user = userEvent.setup();
    const fn = stubApi({
      '/api/messenger/links': { pod: 'kim', can_link: true, owner_name: '김소유', restart_needed: [], mine: [],
        bots: [{ profile: 'main', platform: 'telegram', state: 'connected', connected: true }] },
      '/api/agents/members': (_u: string, b: Record<string, unknown>) => (b.op ? { ok: true } : DATA({ since: 'x' })),
    });
    mountScreen(<SharePanel pod="kim" />, '/');
    await user.selectOptions(await screen.findByRole('combobox', { name: '팀 공지 대화방' }), 'main|telegram');
    await waitFor(() =>
      expect(postedTo(fn, '/api/agents/members')).toEqual([{ pod: 'kim', op: 'team', profile: 'main', platform: 'telegram' }])
    );
  });
});
