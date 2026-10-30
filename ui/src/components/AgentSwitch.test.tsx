/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { AgentSwitch, AgentSwitchProps } from './AgentSwitch';

const ME = 'dana@corp.example';
const MINE = { id: 'one', owner: ME, name: '운영' };
const MINE2 = { id: 'zed', owner: ME, name: '개발' };
const LEE = { id: 'two', owner: 'lee@x.com', owner_name: '이사용', name: '시험' };
const KIM = { id: 'three', owner: 'kim@x.com', owner_name: '김철수', name: '분석' };
const PARK = { id: 'four', owner: 'park@x.com', owner_name: '박팀원', name: '영업', team: true };

function mount(over: Partial<AgentSwitchProps> = {}) {
  const onPick = vi.fn();
  const r = render(<AgentSwitch pods={[MINE, LEE, KIM, MINE2]} pod={MINE} viewerEmail={ME} onPick={onPick} {...over} />);
  return { onPick, ...r };
}

describe('AgentSwitch(스펙 2026-10-19-019)', () => {
  it('지금 에이전트를 단추 글자로 보이고, 열면 지금 줄에 체크와 포커스가 있다(O1)', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: 'AI 에이전트 작업공간: 운영' }));
    const items = screen.getAllByRole('menuitemradio');
    expect(items).toHaveLength(4);
    const current = screen.getByRole('menuitemradio', { name: 'AI 에이전트 작업공간 운영' });
    expect(current).toHaveAttribute('aria-checked', 'true');
    expect(items.filter((i) => i.getAttribute('aria-checked') === 'true')).toHaveLength(1);
    await waitFor(() => expect(current).toHaveFocus());
  });

  it('줄은 내 것(이름순) → 남의 것(주인 이름순)이다(DD3)', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: 'AI 에이전트 작업공간: 운영' }));
    expect(screen.getAllByRole('menuitemradio').map((i) => i.getAttribute('aria-label'))).toEqual([
      'AI 에이전트 작업공간 개발',
      'AI 에이전트 작업공간 운영',
      'AI 에이전트 작업공간 김철수 · 분석',
      'AI 에이전트 작업공간 이사용 · 시험',
    ]);
  });

  it('다른 줄을 고르면 한 번 부르고 메뉴를 닫는다. 지금 줄은 닫기만 한다(R9)', async () => {
    const user = userEvent.setup();
    const { onPick } = mount();
    await user.click(screen.getByRole('button', { name: 'AI 에이전트 작업공간: 운영' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'AI 에이전트 작업공간 운영' }));
    expect(onPick).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    await user.click(screen.getByRole('button', { name: 'AI 에이전트 작업공간: 운영' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'AI 에이전트 작업공간 이사용 · 시험' }));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith('two');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('남의 에이전트는 주인과 이름을 나눠 그리고, 풍선말에 「에이전트 바꾸기」·전체 이름·id 가 있다. 열려도 이름은 그대로다(DD1·O2)', async () => {
    const user = userEvent.setup();
    mount({ pod: LEE });
    const btn = screen.getByRole('button', { name: 'AI 에이전트 작업공간: 이사용 · 시험' });
    expect(within(btn).getByText(/이사용/)).not.toBe(within(btn).getByText('시험')); // 주인이 먼저 줄어들도록 두 글자
    await user.hover(btn);
    const tip = await screen.findByRole('tooltip');
    for (const line of ['AI 에이전트 작업공간 바꾸기', '이사용 · 시험', 'two']) expect(within(tip).getByText(line)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'AI 에이전트 작업공간: 이사용 · 시험' })).toBe(btn);
  });

  it('바꾸는 중이면 고른 에이전트 글자로 막히고 aria-busy 다(DD4)', () => {
    mount({ pendingId: 'two' });
    const btn = screen.getByRole('button', { name: 'AI 에이전트 작업공간: 이사용 · 시험' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-busy', 'true');
  });

  it('지금 에이전트가 없으면 목록이 1개여도 「에이전트 고르기」 단추이고 체크가 없다(R7·R10)', async () => {
    const user = userEvent.setup();
    for (const pods of [[LEE], [LEE, KIM]]) {
      const { unmount } = mount({ pod: null, pods });
      await user.click(screen.getByRole('button', { name: 'AI 에이전트 작업공간 고르기' }));
      expect(screen.getAllByRole('menuitemradio')).toHaveLength(pods.length);
      expect(screen.getAllByRole('menuitemradio').every((i) => i.getAttribute('aria-checked') === 'false')).toBe(true);
      unmount();
    }
  });

  it('지금 것 하나뿐이면 단추가 아니라 흐린 이름 글자다(D2·DD12)', () => {
    mount({ pods: [MINE] });
    expect(screen.queryByRole('button')).toBeNull();
    expect(within(screen.getByTestId('agent-current')).getByText('운영')).toBeInTheDocument();
  });

  it('지금 것은 있는데 목록을 못 읽었으면 이름 글자를 두고 풍선말로 알린다(DD6)', async () => {
    const user = userEvent.setup();
    mount({ pods: [], registryError: 'registry down' });
    const cur = screen.getByTestId('agent-current');
    expect(within(cur).getByText('운영')).toBeInTheDocument();
    await user.hover(cur);
    expect(await screen.findByText('AI 에이전트 작업공간 목록을 읽지 못했습니다')).toBeInTheDocument();
  });

  it('지금 것도 목록도 없으면(로컬 모드) 아무것도 그리지 않는다', () => {
    const { container } = mount({ pod: null, pods: [] });
    expect(container).toBeEmptyDOMElement();
  });
});

// 팀 관리자(스펙 2026-10-22-001 DD2·DD5·DD11): 목록을 「내 에이전트 / 내 팀 / 공유받은」 세 구역으로 나누고 팀원 에이전트에 「팀」 배지
describe('AgentSwitch — 내 팀 구역', () => {
  it('구역 머리글이 내 에이전트 → 내 팀 → 공유받은 순서이고 초점이 가지 않으며, 줄은 그 구역 아래에 있다', async () => {
    const user = userEvent.setup();
    mount({ pods: [MINE, LEE, PARK, KIM, MINE2] });
    await user.click(screen.getByRole('button', { name: 'AI 에이전트 작업공간: 운영' }));
    const menu = screen.getByRole('menu');
    const heads = Array.from(menu.querySelectorAll('li.MuiListSubheader-root'));
    expect(heads.map((h) => h.textContent)).toEqual(['내 AI 에이전트 작업공간', '내 팀', '공유받은']);
    for (const h of heads) {
      expect(h).not.toHaveAttribute('tabindex');
      expect(h).not.toHaveAttribute('role', 'menuitemradio');
    }
    // 화면 순서: 머리글과 줄을 차례대로 읽는다
    const order = Array.from(menu.querySelectorAll('li')).map((li) =>
      li.classList.contains('MuiListSubheader-root') ? `#${li.textContent}` : li.getAttribute('aria-label')
    );
    expect(order).toEqual([
      '#내 AI 에이전트 작업공간',
      'AI 에이전트 작업공간 개발',
      'AI 에이전트 작업공간 운영',
      '#내 팀',
      'AI 에이전트 작업공간 박팀원 · 영업, 팀',
      '#공유받은',
      'AI 에이전트 작업공간 김철수 · 분석',
      'AI 에이전트 작업공간 이사용 · 시험',
    ]);
  });

  it('팀원 에이전트 줄에는 「팀」 배지 글자가 있고 다른 줄에는 없다', async () => {
    const user = userEvent.setup();
    mount({ pods: [MINE, LEE, PARK] });
    await user.click(screen.getByRole('button', { name: 'AI 에이전트 작업공간: 운영' }));
    expect(within(screen.getByRole('menuitemradio', { name: /박팀원 · 영업/ })).getByText('팀')).toBeInTheDocument();
    expect(within(screen.getByRole('menuitemradio', { name: 'AI 에이전트 작업공간 이사용 · 시험' })).queryByText('팀')).toBeNull();
  });

  it('지금 에이전트가 팀원 것이면 단추 글자에도 「팀」 배지가 있고 낭독 이름에 들어간다', () => {
    mount({ pods: [MINE, PARK], pod: PARK });
    const btn = screen.getByRole('button', { name: 'AI 에이전트 작업공간: 박팀원 · 영업, 팀' });
    expect(within(btn).getByText('팀')).toBeInTheDocument();
  });

  it('한 구역뿐이면 구역 머리글을 두지 않는다', async () => {
    const user = userEvent.setup();
    mount({ pods: [MINE, MINE2] });
    await user.click(screen.getByRole('button', { name: 'AI 에이전트 작업공간: 운영' }));
    expect(screen.getByRole('menu').querySelectorAll('li.MuiListSubheader-root')).toHaveLength(1); // 「에이전트」 한 줄만
    expect(screen.queryByText('내 AI 에이전트 작업공간')).toBeNull();
  });
});
