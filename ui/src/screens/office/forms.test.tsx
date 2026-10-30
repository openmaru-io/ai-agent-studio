/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useUi } from '@/components/UiContext';
import { mountScreen, postedTo, stubApi } from '@/test/mountScreen';

import { primarySeats, Room, RoomForm, RoomPod, Seat, SeatForm } from './forms';

const SEAT: Seat = { alias: 'ma', pod: 'one', profile: 'ma', enabled: true, title: '', role: '', team: '', note: '' };
const ROOM: Room = { id: 7, name: '제안 TFT', purpose: '', owner: '', seats: ['ma'], people: [], status: 'open' };

afterEach(() => vi.unstubAllGlobals());

function mount(title: string, body: ReactElement) {
  const fn = stubApi({ '/api/office/action': { ok: true }, '/api/office': { seats: [SEAT], rooms: [ROOM] } });
  function Opener() {
    const { openDrawer } = useUi();
    return <button onClick={() => openDrawer({ title, body })}>열기</button>;
  }
  mountScreen(<Opener />, '/office');
  return fn;
}

async function open(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.click(screen.getByRole('button', { name: '열기' }));
  const dlg = await screen.findByRole('dialog', { name: title });
  return { dlg, head: dlg.querySelector('[data-drawer-head]') as HTMLElement };
}

describe('자리·TFT 방 서랍의 동작(OMAI-1135)', () => {
  it('배치 해제는 서랍 머리 단추이고 확인한 뒤 지운다', async () => {
    const user = userEvent.setup();
    const fn = mount('ma', <SeatForm pod="one" profile="ma" seat={SEAT} />);
    const { dlg, head } = await open(user, 'ma');
    expect(within(dlg).getAllByRole('button', { name: '배치 해제' })).toEqual([within(head).getByRole('button', { name: '배치 해제' })]); // 본문에는 없다
    await user.click(within(head).getByRole('button', { name: '배치 해제' }));
    const box = await screen.findByRole('dialog', { name: '배치 해제' });
    expect(box).toHaveTextContent('ma 의 오피스 배치를 해제합니다.');
    await user.click(within(box).getByRole('button', { name: '배치 해제' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/action')).toEqual([{ action: 'seat.delete', alias: 'ma' }]));
  });

  it('「오피스에 배치함」을 끄고 저장하면 확인을 받는다. 그대로 저장하면 묻지 않는다', async () => {
    const user = userEvent.setup();
    const fn = mount('ma', <SeatForm pod="one" profile="ma" seat={SEAT} />);
    const { dlg } = await open(user, 'ma');
    await user.click(within(dlg).getByRole('switch', { name: /오피스에 배치함/ }));
    await user.click(within(dlg).getByRole('button', { name: '저장' }));
    expect(await screen.findByText(/ma 을\(를\) 장면에서 뺍니다/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '취소' }));
    expect(postedTo(fn, '/api/office/action')).toEqual([]);
    await user.click(await within(dlg).findByRole('button', { name: '저장' }));
    await user.click(await screen.findByRole('button', { name: '확인' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/action')[0]).toMatchObject({ action: 'seat.set', enabled: false }));
  });

  it('새 자리에는 머리 단추가 없다', async () => {
    const user = userEvent.setup();
    mount('새 자리', <SeatForm pod="one" profile="ma" seat={null} />);
    const { head } = await open(user, '새 자리');
    expect(within(head).queryByRole('button', { name: '배치 해제' })).toBeNull();
  });

  it('방 기록 지우기는 머리 단추이고, 방을 끝내고 저장하면 확인을 받는다', async () => {
    const user = userEvent.setup();
    const fn = mount('제안 TFT', <RoomForm room={ROOM} seats={[SEAT]} />);
    const { dlg, head } = await open(user, '제안 TFT');
    await user.click(within(dlg).getByRole('checkbox', { name: '끝난 방' }));
    await user.click(within(dlg).getByRole('button', { name: '저장' }));
    expect(await screen.findByText(/제안 TFT 을\(를\) 끝냅니다/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '취소' }));
    expect(postedTo(fn, '/api/office/action')).toEqual([]);
    await user.click(await within(head).findByRole('button', { name: '기록 지우기' }));
    const box = await screen.findByRole('dialog', { name: '기록 지우기' });
    await user.click(within(box).getByRole('button', { name: '기록 지우기' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/action')).toEqual([{ action: 'room.delete', id: 7 }]));
  });
});

describe('TFT 방 「이 방의 에이전트」: 주인별 묶음과 구성원 따라오기(2026-10-18)', () => {
  const S = (alias: string, pod: string, profile = alias): Seat => ({ alias, pod, profile, enabled: true, title: '', role: '', team: '', note: '' });
  const SEATS = [S('kim-main', 'k', 'main'), S('kim-report', 'k', 'report'), S('lee-main', 'l', 'main'), S('park-default', 'p', 'default'), S('doc', 'shared')];
  const PODS: RoomPod[] = [
    { id: 'k', owner: 'kim@x.com', primary: 'main' },
    { id: 'l', owner: 'lee@x.com', primary: 'main' },
    { id: 'p', owner: 'park@x.com', primary: 'default' },
    { id: 'shared', owner: '' },
  ];
  const USERS = { users: [{ email: 'kim@x.com', name: '김철수' }, { email: 'lee@x.com', name: '이영희' }, { email: 'park@x.com', name: '박민수' }] };

  function mountRoom(room: Room | null) {
    const fn = stubApi({
      '/api/me': { auth_enabled: true, admin: true, user: { email: 'kim@x.com', name: '김철수' } },
      '/api/users': USERS,
      '/api/office/action': { ok: true },
    });
    function Opener() {
      const { openDrawer } = useUi();
      return <button onClick={() => openDrawer({ title: '방', body: <RoomForm room={room} seats={SEATS} pods={PODS} /> })}>열기</button>;
    }
    mountScreen(<Opener />, '/office');
    return fn;
  }

  it('주 프로파일 자리: 그 사람 설치본의 주 프로파일, 없으면 자리가 하나뿐일 때 그 자리', () => {
    expect(primarySeats('kim@x.com', SEATS, PODS)).toEqual(['kim-main']);
    expect(primarySeats('PARK@x.com', SEATS, PODS)).toEqual(['park-default']);
    expect(primarySeats('nobody@x.com', SEATS, PODS)).toEqual([]);
    expect(primarySeats('lee@x.com', [S('lee-a', 'l', 'a')], PODS)).toEqual(['lee-a']);
    expect(primarySeats('lee@x.com', [S('lee-a', 'l', 'a'), S('lee-b', 'l', 'b')], PODS)).toEqual([]);
  });

  it('새 방은 내 주 프로파일 자리가 체크돼 있고, 구성원을 넣고 빼면 그 사람의 주 프로파일 자리가 따라온다', async () => {
    const user = userEvent.setup();
    const fn = mountRoom(null);
    await user.click(screen.getByRole('button', { name: '열기' }));
    const dlg = await screen.findByRole('dialog', { name: '방' });
    await waitFor(() => expect(within(dlg).getByRole('checkbox', { name: 'kim-main' })).toBeChecked());
    expect(within(dlg).getByRole('checkbox', { name: 'kim-report' })).not.toBeChecked();
    expect(within(dlg).queryByRole('checkbox', { name: 'lee-main' })).toBeNull(); // 구성원이 아닌 사람의 자리는 접혀 있다
    await user.click(within(dlg).getByRole('button', { name: '다른 사람의 AI 에이전트 3개 보기' }));
    expect(within(dlg).getByRole('checkbox', { name: 'lee-main' })).not.toBeChecked();
    await user.click(within(dlg).getByRole('button', { name: '다른 사람의 AI 에이전트 접기' }));
    await user.type(within(dlg).getByLabelText('구성원'), '이영');
    await user.click(await screen.findByRole('option', { name: /이영희/ }));
    expect(within(dlg).getByRole('checkbox', { name: 'lee-main' })).toBeChecked(); // 구성원으로 들어오면 위 묶음에 체크된 채로
    await user.click(within(dlg).getByRole('checkbox', { name: 'kim-report' })); // 손으로 체크
    const leeChip = (await within(dlg).findByText('이영희', { selector: '.MuiChip-label' })).closest('.MuiChip-root') as HTMLElement;
    await user.click(leeChip.querySelector('.MuiChip-deleteIcon') as Element);
    expect(within(dlg).queryByRole('checkbox', { name: 'lee-main' })).toBeNull(); // 빼면 저절로 체크했던 자리도 빠진다(접힌 묶음으로)
    await user.type(within(dlg).getByLabelText('방 이름'), '새 방');
    await user.type(within(dlg).getByLabelText(/무엇을 끝내려고 모였나요/), '제안서 확정');
    await user.click(within(dlg).getByRole('button', { name: '저장' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/action')).toHaveLength(1));
    expect(postedTo(fn, '/api/office/action')[0]).toMatchObject({ seats: ['kim-main', 'kim-report'], members: ['kim@x.com'] });
  });

  it('주인 이름 칩으로 묶고, 다른 사람의 자리가 이미 체크된 옛 방은 펼쳐서 연다', async () => {
    const user = userEvent.setup();
    mountRoom({ id: 9, name: '옛 방', purpose: '', owner: 'kim@x.com', seats: ['doc', 'lee-main'], people: [], members: ['kim@x.com'], status: 'open' });
    await user.click(screen.getByRole('button', { name: '열기' }));
    const dlg = await screen.findByRole('dialog', { name: '방' });
    expect(await within(dlg).findByText('김철수', { selector: '[data-user-chip] *' })).toBeInTheDocument();
    expect(within(dlg).getByRole('checkbox', { name: 'lee-main' })).toBeChecked();
    expect(within(dlg).getByRole('checkbox', { name: 'doc' })).toBeChecked();
    expect(within(dlg).getByText('소유자 없음')).toBeInTheDocument();
    expect(within(dlg).getByRole('checkbox', { name: 'kim-main' })).not.toBeChecked(); // 옛 방은 열 때 바꾸지 않는다
  });
});

describe('TFT 방 목적 항목별 입력(스펙 2026-10-18-004)', () => {
  function mountRoom(room: Room | null) {
    const fn = stubApi({ '/api/office/action': { ok: true }, '/api/users': { users: [] } });
    function Opener() {
      const { openDrawer } = useUi();
      return <button onClick={() => openDrawer({ title: '방', body: <RoomForm room={room} seats={[SEAT]} /> })}>열기</button>;
    }
    mountScreen(<Opener />, '/office');
    return fn;
  }

  it('새 방은 목표를 적어야 저장되고, 적은 항목만 ### 머리로 묶어 보낸다', async () => {
    const user = userEvent.setup();
    const fn = mountRoom(null);
    await user.click(screen.getByRole('button', { name: '열기' }));
    const dlg = await screen.findByRole('dialog', { name: '방' });
    await user.type(within(dlg).getByLabelText('방 이름'), '제안');
    expect(within(dlg).getByRole('button', { name: '저장' })).toBeDisabled();
    expect(within(dlg).getByText(/「무엇을 끝내려고 모였나요\?」를 적어 주세요/)).toBeInTheDocument();
    expect(within(dlg).queryByLabelText(/어떻게 진행하나요/)).toBeNull(); // 늘 보이는 것은 목표·결과물·기한
    await user.type(within(dlg).getByLabelText(/무엇을 끝내려고 모였나요/), '초안 확정');
    await user.type(within(dlg).getByLabelText(/언제까지인가요/), '금요일');
    await user.click(within(dlg).getByRole('button', { name: '더 자세히 적기' }));
    await user.type(within(dlg).getByLabelText(/하지 말아야 할 것은/), '외부 검색 금지');
    // 접으면 적은 칸도 숨는다. 숨은 글 칸 수를 단추 옆에 보인다(스펙 2026-10-19-005 G13)
    await user.click(within(dlg).getByRole('button', { name: '접기' }));
    expect(within(dlg).getByText('1칸 적음')).toBeInTheDocument();
    await user.click(within(dlg).getByRole('button', { name: '더 자세히 적기' }));
    expect(within(dlg).queryByText(/칸 적음/)).toBeNull();
    await user.click(within(dlg).getByRole('button', { name: '저장' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/action')).toHaveLength(1));
    expect(postedTo(fn, '/api/office/action')[0].purpose).toBe('### 목표\n초안 확정\n\n### 기한\n금요일\n\n### 하지 말 것\n외부 검색 금지');
  });

  it('옛 방의 자유 글은 「추가 설명」에 펼쳐 보이고, 목표 없이도 저장된다', async () => {
    const user = userEvent.setup();
    const fn = mountRoom({ ...ROOM, purpose: '결제 지연 대응' });
    await user.click(screen.getByRole('button', { name: '열기' }));
    const dlg = await screen.findByRole('dialog', { name: '방' });
    expect(within(dlg).getByLabelText(/추가 설명/)).toHaveValue('결제 지연 대응');
    await user.click(within(dlg).getByRole('button', { name: '저장' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/action')).toHaveLength(1));
    expect(postedTo(fn, '/api/office/action')[0].purpose).toBe('### 추가 설명\n결제 지연 대응');
  });
});


// 담당·구성원도 방을 고친다(스펙 2026-10-18-009, 사용자 결정 2026-10-18). 서버 office_access.room_edit 이 같은 규칙으로 다시 거른다
describe('TFT 방 서랍: 담당·구성원 고치기', () => {
  const S = (alias: string, pod: string): Seat => ({ alias, pod, profile: alias, enabled: true, title: '', role: '', team: '', note: '' });
  // 나(kim)는 k 의 주인. lee 의 자리는 이 방에 앉아 있어 보인다(그 pod 는 내 pods 목록에 없다)
  const SEATS = [S('kim-main', 'k'), S('kim-report', 'k'), S('lee-main', 'l')];
  const PODS: RoomPod[] = [{ id: 'k', owner: 'kim@x.com', primary: 'kim-main' }];
  const ROOM_O: Room = { id: 9, name: '제안', purpose: '', owner: '김철수', owner_key: 'p_kim', seats: ['lee-main'], people: [], members: ['p_kim', 'p_lee'], status: 'open', my_role: 'owner' };
  const DIR = { people: [{ key: 'p_kim', name: '김철수' }, { key: 'p_lee', name: '이영희' }, { key: 'p_park', name: '박민수' }] };

  function mountRole(room: Room, role: 'owner' | 'member') {
    const fn = stubApi({
      '/api/me': { auth_enabled: true, admin: false, user: { email: 'kim@x.com', name: '김철수' } },
      '/api/office/people': DIR,
      '/api/office/action': { ok: true },
    });
    function Opener() {
      const { openDrawer } = useUi();
      return <button onClick={() => openDrawer({ title: '방', body: <RoomForm room={room} seats={SEATS} pods={PODS} role={role} /> })}>열기</button>;
    }
    mountScreen(<Opener />, '/office');
    return fn;
  }

  it('담당: 구성원은 이름 목록(열쇠)으로 고르고, 남의 에이전트는 새로 체크하지 못하며, 담당 고르기·지우기는 없다', async () => {
    const user = userEvent.setup();
    const fn = mountRole(ROOM_O, 'owner');
    await user.click(screen.getByRole('button', { name: '열기' }));
    const dlg = await screen.findByRole('dialog', { name: '방' });
    expect(await within(dlg).findByText('이영희', { selector: '.MuiChip-label' })).toBeInTheDocument();
    expect(within(dlg).getByText(/김철수/, { selector: '[data-room-owner]' })).toBeInTheDocument(); // 담당은 글자로만
    expect(within(dlg).queryByRole('combobox', { name: '담당' })).toBeNull();
    expect(within(dlg).queryByRole('button', { name: /기록 지우기|지우기/ })).toBeNull();
    expect(within(dlg).getByRole('checkbox', { name: 'kim-report' })).toBeEnabled();
    expect(within(dlg).getByRole('checkbox', { name: 'lee-main' })).toBeChecked(); // 이미 있던 남의 것은 빼기만
    await user.click(within(dlg).getByRole('checkbox', { name: 'kim-report' }));
    await user.type(within(dlg).getByLabelText('구성원'), '박민');
    await user.click(await screen.findByRole('option', { name: /박민수/ }));
    await user.click(within(dlg).getByRole('button', { name: '저장' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/action')).toHaveLength(1));
    expect(postedTo(fn, '/api/office/action')[0]).toMatchObject({ action: 'room.set', id: 9, members: ['p_kim', 'p_lee', 'p_park'], seats: ['lee-main', 'kim-report'] });
  });

  it('담당: 빠진 남의 에이전트는 다시 체크할 수 없다', async () => {
    const user = userEvent.setup();
    mountRole({ ...ROOM_O, seats: [] }, 'owner');
    await user.click(screen.getByRole('button', { name: '열기' }));
    const dlg = await screen.findByRole('dialog', { name: '방' });
    await user.click(within(dlg).getByRole('button', { name: /다른 사람의 AI 에이전트/ }));
    expect(within(dlg).getByRole('checkbox', { name: 'lee-main' })).toBeDisabled();
    expect(within(dlg).getByRole('checkbox', { name: 'kim-report' })).toBeEnabled(); // 내 것은 넣을 수 있다
  });

  it('구성원: 이름과 목적만 보이고 구성원·에이전트·끝내기는 없다', async () => {
    const user = userEvent.setup();
    const fn = mountRole({ ...ROOM_O, my_role: 'member', members: undefined, owner_key: undefined }, 'member');
    await user.click(screen.getByRole('button', { name: '열기' }));
    const dlg = await screen.findByRole('dialog', { name: '방' });
    expect(within(dlg).getByText('구성원은 방 이름과 목적만 고칠 수 있습니다')).toBeInTheDocument();
    expect(within(dlg).queryByLabelText('구성원')).toBeNull();
    expect(within(dlg).queryByRole('checkbox')).toBeNull();
    const name = within(dlg).getByLabelText('방 이름');
    await user.clear(name);
    await user.type(name, '제안 2');
    await user.click(within(dlg).getByRole('button', { name: '저장' }));
    await waitFor(() => expect(postedTo(fn, '/api/office/action')).toHaveLength(1));
    const sent = postedTo(fn, '/api/office/action')[0] as Record<string, unknown>;
    expect(sent).toMatchObject({ action: 'room.set', id: 9, name: '제안 2' });
    expect(sent).not.toHaveProperty('members');
    expect(sent).not.toHaveProperty('seats');
  });
});
