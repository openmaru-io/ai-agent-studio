/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountScreen, stubApi } from '@/test/mountScreen';

import type { Room } from './forms';
import { Meeting } from './Meeting';

afterEach(() => vi.unstubAllGlobals());

const ROOM = { id: 1, name: '제안 TFT', purpose: '', status: 'open', kind: 'tft', seats: ['sa'], people: [] } as unknown as Room;
const NOTICE = {
  id: 7,
  role: 'system',
  author: '',
  content: 'sa 의 SOUL 이 바뀌었습니다(버전 10→12, kim@x.com)',
  ts: '2026-10-13T10:00:00+09:00',
  kind: 'soul_changed',
  data: { alias: 'sa', pod: 'kim', profile: 'sa', who: 'kim@x.com', note: '말투를 바꿈', ts: '2026-10-13T10:05:00+09:00', rev_from: 10, rev_to: 12 },
};

function mount(pods: string[], notice: unknown = NOTICE) {
  const fn = stubApi({
    '/api/me': { auth_enabled: true, admin: false, pod: { id: pods[0] ?? 'lee', owner: '' }, pods: pods.map((id) => ({ id, owner: '' })), user: { email: 'x@x.com' } },
    '/api/office/meeting': {
      room: { id: 1, name: '제안 TFT', purpose: '', status: 'open', seats: ['sa'], people: [] },
      participants: [{ alias: 'sa', title: '', pod: 'kim', enabled: true }],
      messages: [notice, { id: 8, role: 'user', author: 'kim@x.com', content: '확인했습니다', ts: '2026-10-13T10:06:00+09:00' }],
      pending: [],
    },
  });
  mountScreen(<Meeting rooms={[ROOM]} canAct />, '/office');
  return fn;
}

describe('Meeting SOUL 변경 알림(OMAI-1126 DT4·DT7)', () => {
  it('경고가 아니라 role=status 구분선으로, 지금 언어 문장·메모·누가를 보이고 아이콘은 읽지 않는다', async () => {
    mount(['kim']);
    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent('sa 의 성격(SOUL)이 바뀌었습니다(버전 10→12) — 말투를 바꿈');
    expect(notice).toHaveTextContent('kim@x.com');
    expect(notice.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '바뀐 줄 보기' })).toBeInTheDocument();
  });

  it('그 POD 를 볼 수 없는 사람에게는 「바뀐 줄 보기」를 보이지 않는다', async () => {
    const fn = mount(['lee']);
    expect(await screen.findByRole('status')).toHaveTextContent('말투를 바꿈');
    await waitFor(() => expect(fn.mock.calls.some((c) => String(c[0]).startsWith('/api/me'))).toBe(true));
    await act(async () => {});                                                          // /api/me 응답을 그린 뒤에 본다
    expect(screen.queryByRole('button', { name: '바뀐 줄 보기' })).not.toBeInTheDocument();
  });

  it('PC 가져오기로 바뀐 알림은 누가 PC 에서 가져와 바꿨는지 화면 문장으로 쓴다(OMAI-1444 R15)', async () => {
    const data = { alias: 'sa', pod: 'kim', profile: 'sa', who: '김철수', note: '', ts: '2026-10-13T10:05:00+09:00', source: 'pc_import' };
    mount(['kim'], { ...NOTICE, data: { ...data, rev_from: 3, rev_to: 4 } });
    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent('김철수 님이 PC 에서 가져와 sa 의 성격(SOUL)을 바꿨습니다(버전 3→4)');
    expect(notice).not.toHaveTextContent('—');                                          // note 는 비어 온다
  });

  it('PC 가져오기 알림에 버전 번호가 없으면(버전 저장 실패) 번호 없이 쓴다(OMAI-1444 R12)', async () => {
    const data = { alias: 'sa', pod: 'kim', profile: 'sa', who: '관리자', ts: '2026-10-13T10:05:00+09:00', source: 'pc_import' };
    mount(['kim'], { ...NOTICE, data });
    expect(await screen.findByRole('status')).toHaveTextContent(/^관리자 님이 PC 에서 가져와 sa 의 성격\(SOUL\)을 바꿨습니다\d/);
  });
});
