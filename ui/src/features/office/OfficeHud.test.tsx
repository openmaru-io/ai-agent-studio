/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ThemeModeProvider } from '@/components/ThemeMode';

import type { HudRoom } from './hud';
import type { ServerAgent } from './model';
import { OfficeHud } from './OfficeHud';

const agent = (alias: string, title: string): ServerAgent =>
  ({ alias, pod: 'p', profile: 'default', status: 'idle', title, role: '', team: '' }) as unknown as ServerAgent;

const hud = (extra: Partial<React.ComponentProps<typeof OfficeHud>> = {}) =>
  render(
    <OfficeHud
      agents={[agent('aas-agent-aas-admin-test-8c07', '관리자 Hermes'), agent('omai1112-verify', '')]}
      selected={null}
      following={null}
      view="3d"
      live
      staleSeconds={0}
      ownerOf={() => 'aas-admin-test'}
      isMine={(a) => a.alias.startsWith('aas-agent')}
      onSelect={vi.fn()}
      onChat={vi.fn()}
      onFocus={vi.fn()}
      onFollow={vi.fn()}
      onView={vi.fn()}
      {...extra}
    />
  );

describe('보기 전환 단추', () => {
  it('3D 보기에는 「2D 보기」 단추가 없다', () => {
    hud({ view: '3d' });
    expect(screen.queryByRole('button', { name: '2D 보기' })).not.toBeInTheDocument();
  });

  it('2D 보기(좁은 화면·WebGL 없음)에서는 3D 로 돌아가는 단추가 있다', async () => {
    const onView = vi.fn();
    hud({ view: '2d', onView });
    await userEvent.click(screen.getByRole('button', { name: '3D 보기' }));
    expect(onView).toHaveBeenCalledWith('3d');
  });
});

// 왼쪽 아래 도구 막대 위의 카메라 조작(스펙 2026-10-21-006)
describe('카메라 조작 단추', () => {
  it('3D 에서 단추마다 그 조작으로 onCamera 를 부른다', async () => {
    const onCamera = vi.fn();
    hud({ onCamera });
    const group = screen.getByRole('group', { name: '카메라 조작' });
    const names: [string, string][] = [
      ['위로 이동', 'up'],
      ['아래로 이동', 'down'],
      ['왼쪽으로 이동', 'left'],
      ['오른쪽으로 이동', 'right'],
      ['처음 구도', 'reset'],
      ['확대', 'zoomIn'],
      ['축소', 'zoomOut'],
      ['왼쪽으로 돌리기', 'rotateLeft'],
      ['오른쪽으로 돌리기', 'rotateRight'],
    ];
    for (const [name] of names) await userEvent.click(within(group).getByRole('button', { name }));
    expect(onCamera.mock.calls.map((c) => c[0])).toEqual(names.map(([, kind]) => kind));
  });

  it('따라가기 중에는 모두 끈다(따라가기 카메라가 덮어쓴다)', () => {
    hud({ onCamera: vi.fn(), following: 'aas-agent-aas-admin-test-8c07' });
    const buttons = within(screen.getByRole('group', { name: '카메라 조작' })).getAllByRole('button');
    expect(buttons).toHaveLength(9);
    buttons.forEach((b) => expect(b).toBeDisabled());
  });

  it('회의 보기로 돌아가기 단추는 카메라 조작과 같은 오른쪽 아래 묶음에 둔다', async () => {
    const onBackToMeeting = vi.fn();
    hud({ onCamera: vi.fn(), onBackToMeeting });
    const group = screen.getByRole('group', { name: '카메라 조작' });
    const back = screen.getByRole('button', { name: '회의 보기로 돌아가기' });
    expect(back.parentElement!.contains(group)).toBe(true);
    await userEvent.click(back);
    expect(onBackToMeeting).toHaveBeenCalled();
  });

  it('2D 보기와 onCamera 가 없을 때는 보이지 않는다', () => {
    const { unmount } = hud({ view: '2d', onCamera: vi.fn() });
    expect(screen.queryByRole('group', { name: '카메라 조작' })).not.toBeInTheDocument();
    unmount();
    hud();
    expect(screen.queryByRole('group', { name: '카메라 조작' })).not.toBeInTheDocument();
  });
});

// 명단 이름을 누르면 상세 서랍 대신 카메라가 그 에이전트로 확대해 옮긴다. 서랍은 「상세」 단추로 연다(스펙 2026-10-21-004)
describe('명단 이름 클릭', () => {
  it('이름은 카메라 이동(onFocus)만 부르고 상세(onSelect)는 부르지 않는다', async () => {
    const onFocus = vi.fn();
    const onSelect = vi.fn();
    hud({ onFocus, onSelect });
    const row = screen.getByRole('list', { name: 'AI 에이전트' }).querySelector<HTMLElement>('[data-alias="aas-agent-aas-admin-test-8c07"]');
    await userEvent.click(row!);
    expect(onFocus).toHaveBeenCalledWith('aas-agent-aas-admin-test-8c07');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('「상세」 단추는 그대로 서랍을 연다', async () => {
    const onFocus = vi.fn();
    const onSelect = vi.fn();
    hud({ onFocus, onSelect });
    await userEvent.click(screen.getAllByRole('button', { name: /상세/ })[0]);
    expect(onSelect).toHaveBeenCalledWith('aas-agent-aas-admin-test-8c07');
  });
});

// 명단 행 = [이름 단추][대화][상세]. 이름 단추가 100% 폭이면 아이콘 둘만큼 넘쳐 좌우 스크롤이 생겼다(2026-10-13 OKE 화면).
describe('오피스 명단의 폭', () => {
  it('목록은 좌우로 스크롤하지 않는다', () => {
    hud();
    const list = screen.getByRole('list', { name: 'AI 에이전트' });
    expect(getComputedStyle(list).overflowX).toBe('hidden');
    expect(getComputedStyle(list).overflowY).toBe('auto');
  });

  it('이름 단추는 남는 폭만 쓰고 줄어들 수 있다(아이콘 단추 자리를 남긴다)', () => {
    hud();
    const row = screen.getAllByRole('listitem')[0];
    const name = row.querySelector('[data-roster-item]') as HTMLElement;
    const style = getComputedStyle(name);
    expect(style.width).not.toBe('100%');
    expect(style.minWidth).toBe('0');
    expect(style.flexGrow).toBe('1');
  });

  it('상태 글자는 줄바꿈하지 않고 넘치면 말줄임표로 줄인다(이름 칸은 상태 때문에 줄어들지 않는다)', () => {
    hud();
    const label = screen.getAllByText(/^내 AI 에이전트/)[0];
    expect(getComputedStyle(label).whiteSpace).toBe('nowrap');
    expect(getComputedStyle(label).textOverflow).toBe('ellipsis');
  });
});

// 비활성 '따라가기' 글자가 MUI 기본(테마를 따라 라이트에서 어두운 회색)이면 패널 위에서 안 보인다(2026-10-15).
// 그래서 글자색을 패널 색 변수로 정하고, 변수 값이 테마마다 패널 위에서 읽히는 값인지 본다.
describe('오피스 하단 단추의 비활성 글자색', () => {
  it('따라가기가 비활성일 때 글자색은 패널 변수(--hud-fg4)를 따른다', () => {
    hud();
    const btn = screen.getByRole('button', { name: '따라가기' });
    expect(btn).toBeDisabled();
    expect(getComputedStyle(btn).color).toBe('var(--hud-fg4)');
    // 변수는 왼쪽 아래 묶음의 바깥 상자에 있다(카메라 조작이 그 위에 들어가 한 단계 깊어졌다, 스펙 2026-10-21-006)
    let el: HTMLElement | null = btn;
    while (el && !getComputedStyle(el).getPropertyValue('--hud-fg4')) el = el.parentElement;
    expect(el && getComputedStyle(el).getPropertyValue('--hud-fg4')).toBe('#62666d');
  });
});

describe('오피스 패널의 테마 색', () => {
  const asLight = () => {
    localStorage.setItem('aas-theme', 'light');
    return render(
      <ThemeModeProvider>
        <OfficeHud
          agents={[agent('a1', '관리자 Hermes')]}
          selected={null}
          following={null}
          view="3d"
          live
          staleSeconds={0}
          onSelect={vi.fn()}
          onFocus={vi.fn()}
          onFollow={vi.fn()}
          onView={vi.fn()}
        />
      </ThemeModeProvider>
    );
  };

  it('라이트에서는 밝은 카드 표면과 어두운 글자를 쓴다(다크 패널을 그대로 두지 않는다)', () => {
    asLight();
    const region = screen.getByRole('region');
    expect(region.style.getPropertyValue('--hud-solid') || getComputedStyle(region).getPropertyValue('--hud-solid')).toBe('#f5f6f9');
    expect(getComputedStyle(region).getPropertyValue('--hud-fg')).toBe('#111827');
    localStorage.removeItem('aas-theme');
  });

  it('다크에서는 기존 다크 패널 값을 쓴다', () => {
    hud();
    expect(getComputedStyle(screen.getByRole('region')).getPropertyValue('--hud-fg')).toBe('#f7f8f8');
  });
});

describe('현수막 켜고 끄기 단추(스펙 2026-10-15-018)', () => {
  it('문구가 있을 때만 3D 보기 단추 줄에 보이고, 누르면 켜짐 상태를 바꾼다', async () => {
    const toggle = vi.fn();
    const { unmount } = hud({ slogan: { on: true, toggle } });
    const off = screen.getByRole('button', { name: '현수막 끄기' });
    expect(off).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(off);
    expect(toggle).toHaveBeenCalledTimes(1);
    unmount();
    hud({ slogan: { on: false, toggle } });
    expect(screen.getByRole('button', { name: '현수막 켜기' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('문구가 없으면 단추가 없고, 2D 보기에도 없다', () => {
    const { unmount } = hud();
    expect(screen.queryByRole('button', { name: /현수막/ })).toBeNull();
    unmount();
    hud({ slogan: { on: true, toggle: vi.fn() }, view: '2d' });
    expect(screen.queryByRole('button', { name: /현수막/ })).toBeNull();
  });
});

// 스펙 2026-10-20-021: 명단 옆 「회의실」 탭. 행 = 카메라(장면 자리가 있는 방), 말풍선 = 회의실 채팅 창
describe('상태판 회의실 탭', () => {
  const R = (id: number, name: string, extra: Partial<HudRoom> = {}): HudRoom => ({
    id,
    name,
    kind: 'tft',
    state: 'idle',
    placeLabel: null,
    agents: 1,
    purpose: '',
    place: true,
    ...extra,
  });
  const ROOMS = [
    R(5, 'AAS 개발팀', { kind: 'team', state: 'live', agents: 3 }),
    R(3, 'AAS 개발팀'),
    R(4, '제안 TFT', { place: false, purpose: '### 목표\n3분기 제안서' }),
  ];
  const withRooms = (extra: Partial<React.ComponentProps<typeof OfficeHud>> = {}) => {
    const fns = { onRoomChat: vi.fn(), onRoomFocus: vi.fn(), onRoomsTab: vi.fn(), onFocus: vi.fn(), onFollow: vi.fn() };
    const out = hud({ rooms: ROOMS, meetingsReady: true, ...fns, ...extra });
    return { ...out, ...fns };
  };
  const openRooms = async () => userEvent.click(screen.getByRole('tab', { name: /^회의실/ }));
  afterEach(() => vi.useRealTimers());

  it('rooms 를 주지 않으면 탭 없이 지금처럼 명단만 보인다', () => {
    hud();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByRole('button', { name: 'AI 에이전트 목록 접기·펴기' })).toBeInTheDocument();
  });

  it('탭 묶음은 「상태판 목록」, 탭 이름에 개수와 회의 중 수가 들어가 화면 탭 「회의실」 과 이름이 겹치지 않는다(R6·DR2)', () => {
    withRooms();
    const list = screen.getByRole('tablist', { name: '상태판 목록' });
    expect(within(list).getAllByRole('tab').map((x) => x.getAttribute('aria-label'))).toEqual(['AI 에이전트 2', '회의실 3, 회의 중 1']);
    expect(screen.queryByRole('tab', { name: '회의실' })).toBeNull();
  });

  it('회의실 탭을 누르면 회의실 목록이 보이고 방 목록을 다시 읽는다(R9)', async () => {
    const { onRoomsTab } = withRooms();
    await openRooms();
    expect(onRoomsTab).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('tabpanel', { name: /^회의실/ })).toBeVisible();
    expect(screen.getByRole('list', { name: '회의실' })).toBeInTheDocument();
  });

  it('좌우 방향키로 탭을 옮기면 목록도 바로 바뀐다(selectionFollowsFocus, R5)', async () => {
    const { onRoomsTab } = withRooms();
    screen.getByRole('tab', { name: 'AI 에이전트 2' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: /^회의실/ })).toHaveAttribute('aria-selected', 'true');
    expect(onRoomsTab).toHaveBeenCalled();
  });

  it('접힌 상태에서 이미 고른 탭을 눌러도 펼친다(F8)', async () => {
    withRooms();
    const toggle = screen.getByRole('button', { name: '목록 접기·펴기' });
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(screen.getByRole('tab', { name: 'AI 에이전트 2' }));
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('자리가 있는 방의 행은 카메라를, 없는 방의 행과 말풍선은 채팅 창을 연다(R12·DR5)', async () => {
    const { onRoomFocus, onRoomChat } = withRooms();
    await openRooms();
    await userEvent.click(screen.getByRole('button', { name: 'AAS 개발팀 위치 보기' }));
    expect(onRoomFocus).toHaveBeenCalledWith(3);
    // 자리 없는 방은 행이 채팅 창을 열고, 같은 일을 하는 말풍선은 정지점에서 빠져 이름이 하나뿐이다(DR16)
    const noPlace = screen.getByRole('button', { name: '제안 TFT 채팅 열기' });
    expect(noPlace).toHaveAttribute('title', '장면에 자리가 없어 채팅 창을 엽니다');
    await userEvent.click(noPlace);
    expect(onRoomChat).toHaveBeenCalledWith(4);
    await userEvent.click(screen.getByRole('button', { name: 'AAS 개발팀 · 팀 회의 채팅 열기' }));
    expect(onRoomChat).toHaveBeenCalledWith(5);
    expect(onRoomFocus).toHaveBeenCalledTimes(1);
  });

  it('같은 이름의 팀 방과 TFT 방은 접근 이름이 다르다(R8)', async () => {
    withRooms();
    await openRooms();
    expect(screen.getByRole('button', { name: 'AAS 개발팀 · 팀 회의 위치 보기' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'AAS 개발팀 위치 보기' })).toBeInTheDocument();
  });

  it('회의실 목록의 위·아래 방향키는 초점만 옮기고 카메라·따라가기를 부르지 않는다. 명단 방향키는 그대로(R3)', async () => {
    const { onRoomFocus, onFocus, onFollow } = withRooms();
    await openRooms();
    const rows = screen.getByRole('list', { name: '회의실' }).querySelectorAll<HTMLElement>('[data-room-item]');
    rows[0].focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(rows[1]);
    await userEvent.keyboard('f');
    expect(onRoomFocus).not.toHaveBeenCalled();
    expect(onFocus).not.toHaveBeenCalled();
    expect(onFollow).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('tab', { name: 'AI 에이전트 2' }));
    const roster = screen.getByRole('list', { name: 'AI 에이전트' }).querySelectorAll<HTMLElement>('[data-roster-item]');
    roster[0].focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(onFocus).toHaveBeenCalledWith('omai1112-verify');
  });

  it('둘째 줄: 회의 중·에이전트 0·대회의실로 옮겨 감·목적·목적 없음(DR7)', async () => {
    withRooms({
      rooms: [
        R(1, 'a', { state: 'live', agents: 3 }),
        R(2, 'b', { state: 'live', agents: 0 }),
        R(3, 'c', { state: 'moved', placeLabel: '대회의실', agents: 2 }),
        R(4, 'd', { purpose: '### 목표\n3분기 제안서' }),
        R(6, 'e', { agents: 2 }),
      ],
    });
    await openRooms();
    const lines = [...document.querySelectorAll('[data-second-line]')].map((x) => x.textContent);
    expect(lines).toEqual(['회의 중 · AI 에이전트 3', '회의 중', '회의 중 · 대회의실 · AI 에이전트 2', '3분기 제안서', 'AI 에이전트 2']);
  });

  it('회의 목록 첫 응답 전에는 점을 고리로, 둘째 줄을 비우고, 탭 회의 수를 말하지 않는다(DR6)', async () => {
    withRooms({ meetingsReady: false });
    expect(screen.getByRole('tab', { name: '회의실 3' })).toBeInTheDocument();
    await openRooms();
    expect(document.querySelectorAll('[data-ring]')).toHaveLength(3);
    expect([...document.querySelectorAll('[data-second-line]')].every((x) => x.textContent === '\u00a0')).toBe(true);
  });

  it('회의 목록·방 목록 읽기 실패를 원인에 맞는 문구로 알린다(DR6·N7)', async () => {
    const { unmount } = withRooms({ meetingsFailed: true });
    await openRooms();
    expect(screen.getByRole('status')).toHaveTextContent('회의 상태를 읽지 못했습니다');
    unmount();
    withRooms({ meetingsFailed: true, roomsStale: true });
    await openRooms();
    expect(screen.getByRole('status')).toHaveTextContent('회의실 목록을 새로 읽지 못했습니다');
  });

  it('방이 없으면 안내를 보이고, 관리자에게만 그 아래 「새 TFT 방」 단추가 있다(R13·DR3)', async () => {
    const onNewRoom = vi.fn();
    const { unmount } = withRooms({ rooms: [], onNewRoom });
    await openRooms();
    expect(screen.getByText('볼 수 있는 회의실이 없습니다')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '새 TFT 방' }));
    expect(onNewRoom).toHaveBeenCalledTimes(1);
    unmount();
    withRooms({ rooms: [] });
    await openRooms();
    expect(screen.queryByRole('button', { name: '새 TFT 방' })).toBeNull();
  });

  it('회의실 탭에서 상태 칩을 누르면 명단 탭으로 넘어가 거른다(DR1)', async () => {
    withRooms();
    await openRooms();
    await userEvent.click(screen.getByRole('button', { name: /^대기/ }));
    expect(screen.getByRole('tab', { name: 'AI 에이전트 2' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: /^대기/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('창이 열린 방의 말풍선은 눌린 상태다(DR8)', async () => {
    withRooms({ openRoomId: 3 });
    await openRooms();
    expect(screen.getByRole('button', { name: 'AAS 개발팀 채팅 열기' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'AAS 개발팀 · 팀 회의 채팅 열기' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('카메라를 옮긴 행은 1.2초 동안 표시되고 사라진다. 움직임 줄이기면 표시하지 않는다(DR9·G2)', async () => {
    withRooms();
    await openRooms();
    vi.useFakeTimers();
    const row = screen.getByRole('button', { name: 'AAS 개발팀 위치 보기' });
    fireEvent.click(row);
    expect(getComputedStyle(row).backgroundColor).toBe('var(--hud-wash)');
    act(() => void vi.advanceTimersByTime(1200));
    expect(getComputedStyle(row).backgroundColor).not.toBe('var(--hud-wash)');
    vi.useRealTimers();
    const mm = vi.spyOn(window, 'matchMedia').mockImplementation((q: string) => ({ matches: q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
    fireEvent.click(row);
    expect(getComputedStyle(row).backgroundColor).not.toBe('var(--hud-wash)');
    mm.mockRestore();
  });
});

// 2D(좁은 화면·WebGL 없음): 명단은 3D 전용이라 탭 없이 회의실 목록만(R15·DR14)
describe('상태판 회의실 목록 — 2D', () => {
  const R = (id: number, name: string): HudRoom => ({ id, name, kind: 'tft', state: 'idle', placeLabel: null, agents: 1, purpose: '', place: true });
  const two = (extra: Partial<React.ComponentProps<typeof OfficeHud>> = {}) => {
    const fns = { onRoomChat: vi.fn(), onRoomFocus: vi.fn(), onRoomsTab: vi.fn() };
    const out = hud({ view: '2d', rooms: [R(3, '제안 TFT'), R(4, '긴급 TFT')], meetingsReady: true, ...fns, ...extra });
    return { ...out, ...fns };
  };

  it('탭이 없고, 행을 누르면 카메라가 아니라 채팅 창을 연다. 말풍선은 키보드 정지점이 아니다(DR16)', async () => {
    const { onRoomChat, onRoomFocus, container } = two();
    expect(screen.queryByRole('tablist')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '제안 TFT 채팅 열기' }));
    expect(onRoomChat).toHaveBeenCalledWith(3);
    expect(onRoomFocus).not.toHaveBeenCalled();
    const bubbles = container.querySelectorAll('li [aria-hidden="true"][tabindex="-1"]');
    expect(bubbles).toHaveLength(2);
  });

  it('창이 열린 방은 행 이름에 「채팅 창 열림」 을 붙인다(N10)', () => {
    two({ openRoomId: 4 });
    expect(screen.getByRole('button', { name: '긴급 TFT 채팅 열기, 채팅 창 열림' })).toBeInTheDocument();
  });

  it('펼친 채로 뜨면 방 목록을 한 번 다시 읽는다(N8)', () => {
    const { onRoomsTab } = two();
    expect(onRoomsTab).toHaveBeenCalledTimes(1);
  });

  it('좁은 화면이면 처음에 접혀 있고, 펼칠 때 방 목록을 다시 읽는다(DR14·N8)', async () => {
    const { onRoomsTab } = two({ narrow: true });
    const toggle = screen.getByRole('button', { name: '목록 접기·펴기' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(onRoomsTab).not.toHaveBeenCalled();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(onRoomsTab).toHaveBeenCalledTimes(1);
  });

  it('좁은 2D 에서 접힌 채로 3D 로 바꾸면 펼친다(N9)', () => {
    const { rerender } = two({ narrow: true });
    const props = {
      agents: [agent('a1', '관리자 Hermes')],
      selected: null,
      following: null,
      live: true,
      staleSeconds: 0,
      onSelect: vi.fn(),
      onFocus: vi.fn(),
      onFollow: vi.fn(),
      onView: vi.fn(),
      rooms: [R(3, '제안 TFT')],
      narrow: true,
    };
    rerender(<OfficeHud {...props} view="3d" />);
    expect(screen.getByRole('button', { name: '목록 접기·펴기' })).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('단추 풍선말', () => {
  const WALK = '바닥을 두 번 누르면 내 아바타가 걸어갑니다. 빈 책상·의자 가까이를 누르면 앉습니다.';

  it('걷기 안내는 글로 띄우지 않고 ? 단추의 풍선말로 보인다', async () => {
    hud({ walkHint: WALK });
    expect(screen.queryByText(WALK)).not.toBeInTheDocument();
    const help = screen.getByRole('button', { name: '오피스 조작 도움말' });
    await userEvent.hover(help);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(WALK);
    expect(help).toHaveAccessibleDescription(WALK);
  });

  it('걷기 안내가 없으면 ? 단추도 없다', () => {
    hud();
    expect(screen.queryByRole('button', { name: '오피스 조작 도움말' })).not.toBeInTheDocument();
  });

  it('하단 단추는 이름을 그대로 두고 하는 일을 설명으로 붙인다', async () => {
    hud({ selected: 'omai1112-verify', ambient: { on: false, toggle: vi.fn(), track: 'menu-music', setTrack: vi.fn() }, slogan: { on: true, toggle: vi.fn() }, onEdit: vi.fn() });
    const cases: [string, string][] = [
      ['따라가기', '선택한 AI 에이전트를 카메라가 계속 따라갑니다.'],
      ['배경음 켜기', '사무실 배경 소리를 들려줍니다.'],
      ['현수막 끄기', '3D 오피스에서 슬로건·목표 현수막을 숨깁니다.'],
      ['배치 편집', '책상·의자 같은 가구의 자리를 옮기거나 더합니다.'],
    ];
    for (const [name, tip] of cases) {
      const button = screen.getByRole('button', { name });
      await userEvent.hover(button);
      expect(await screen.findByRole('tooltip', { name: tip })).toBeInTheDocument();
      await userEvent.unhover(button);
    }
  });

  it('선택한 에이전트가 없으면 따라가기 풍선말이 먼저 선택하라고 알린다', async () => {
    hud();
    await userEvent.hover(screen.getByRole('button', { name: '따라가기' }).parentElement!);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('AI 에이전트 목록이나 오피스 화면에서 AI 에이전트를 먼저 선택하면 따라갈 수 있습니다.');
  });

  it('상태 칩은 누르면 무엇이 걸러지는지 설명한다', async () => {
    hud();
    const chip = screen.getByRole('button', { name: /^대기/ });
    await userEvent.hover(chip);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('「대기」 AI 에이전트만 명단에 보입니다.');
  });

  describe('배경음악 고르기(스펙 2026-10-21-014)', () => {
    it('배경음 단추 옆 ♫ 단추가 분위기별 곡 메뉴를 열고, 지금 곡에 표시한다', async () => {
      hud({ ambient: { on: true, toggle: vi.fn(), track: 'carefree', setTrack: vi.fn() } });
      const pick = screen.getByRole('button', { name: '배경음악 고르기' });
      await userEvent.hover(pick);
      expect(await screen.findByRole('tooltip', { name: '지금 곡: Carefree. 눌러서 다른 곡을 고릅니다.' })).toBeInTheDocument();
      await userEvent.click(pick);
      const menu = await screen.findByRole('menu');
      for (const mood of ['잔잔·집중', '로파이', '밝고 경쾌', '자연 소리', '클래식']) expect(within(menu).getByText(mood)).toBeInTheDocument();
      const items = within(menu).getAllByRole('menuitemradio');
      expect(items).toHaveLength(5);
      expect(within(menu).getByRole('menuitemradio', { checked: true })).toHaveTextContent('Carefree');
      expect(within(menu).getByRole('menuitemradio', { checked: true })).toHaveTextContent('Kevin MacLeod · CC BY 4.0');
    });

    it('곡을 고르면 켜기와 함께 고른 곡을 알리고 메뉴를 닫는다', async () => {
      const setTrack = vi.fn();
      hud({ ambient: { on: false, toggle: vi.fn(), track: 'menu-music', setTrack } });
      await userEvent.click(screen.getByRole('button', { name: '배경음악 고르기' }));
      await userEvent.click(screen.getByRole('menuitemradio', { name: /Goldberg/ }));
      expect(setTrack).toHaveBeenCalledWith('goldberg-aria', { turnOn: true });
      await vi.waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    });

    it('배경음을 쓸 수 없으면(ambient 없음) ♫ 단추도 없다', () => {
      hud();
      expect(screen.queryByRole('button', { name: '배경음악 고르기' })).not.toBeInTheDocument();
    });
  });
});
