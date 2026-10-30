/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { screen, waitFor, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { watchChatPopup } from '@/test/chatPopup';
import { HistoryBack, ME_ADMIN, ME_USER, mountScreen, rowByName, stubApi } from '@/test/mountScreen';

import { Channels } from './Channels';

const DATA = {
  services_known: true,
  totals: { gateways_up: 1, profiles: 3, gateways_down_with_jobs: 1, channels_connected: 2, needs_attention: 1 },
  profiles: [
    {
      name: 'ma',
      running: false,
      service: { status: 'inactive', disabled: false },
      jobs_active: 4,
      platforms: [
        { name: 'telegram', state: 'connected', needs_attention: true, updated_at: '2026-10-10T09:30:00+09:00' },
      ],
      issues: [
        { level: 'bad', text: '게이트웨이가 꺼져 있어 크론 4개가 돌지 않습니다' },
        { level: 'warn', text: '재시도 기록' },
      ],
    },
    {
      name: 'ops',
      running: true,
      jobs_active: 1,
      platforms: [
        { name: 'buzz', state: 'connected' },
        { name: 'slack', state: 'fatal', error: 'invalid_auth' },
      ],
      issues: [],
    },
    { name: 'idle', running: null, jobs_active: 0, platforms: [], issues: [] },
  ],
};

afterEach(() => vi.unstubAllGlobals());

function mount(initial = '/channels') {
  stubApi({
    '/api/channels': DATA,
    '/api/health': { collected_at: '', totals: {}, dashboard_url: 'http://hermes.local' },
  });
  return mountScreen(<Channels />, initial);
}

describe('Channels', () => {
  it('첫 탭은 전체, 그다음이 확인할 것이다', async () => {
    mount();
    await screen.findByRole('tablist');
    // 보기 카드(2026-10-17-011)의 접근 이름은 「라벨, 숫자」다
    const names = screen.getAllByRole('tab').map((t) => t.getAttribute('aria-label')?.split(', ')[0]);
    expect(names.slice(0, 2)).toEqual(['전체', '확인할 것']);
    expect(screen.getAllByRole('tab')[0]).toHaveAttribute('aria-selected', 'true'); // 주소에 tab 이 없으면 전체
  });

  it('제목, 보기 카드 둘(지표는 둘째 줄)과 숫자만 카드 둘, 확인할 것 보기의 행을 보인다', async () => {
    mount('/channels?tab=issue');
    // 보기 카드(2026-10-17-011): 실행 중 게이트웨이와 「중지됐는데 작업이 있는」 수는 보기 카드의 둘째 줄이다
    expect(await screen.findByText('게이트웨이 실행 1/3')).toBeInTheDocument(); // 데이터가 온 뒤의 화면
    expect(screen.getByRole('heading', { level: 1, name: '메신저 연결' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '전체, 3' })).toHaveAccessibleDescription('게이트웨이 실행 1/3');
    expect(screen.getByRole('tab', { name: /^확인할 것, \d+$/ })).toHaveAccessibleDescription(/^작업 멈춘 게이트웨이 \d+$/);
    expect(screen.getByText('연결된 채널')).toBeInTheDocument();
    expect(screen.getByText('주의 채널')).toBeInTheDocument();
    // 확인할 것 탭은 문제가 있는 프로파일만
    expect(screen.getByText('ma')).toBeInTheDocument();
    expect(screen.queryByText('ops')).not.toBeInTheDocument();
    expect(screen.getByText(/게이트웨이가 꺼져 있어 크론 4개가 돌지 않습니다 외 1건/)).toBeInTheDocument();
    expect(within(await rowByName(/^ma /)).getByText('4')).toBeInTheDocument(); // 활성 크론 작업 칸
  });

  it('게이트웨이와 채널 상태를 태그로 보인다', async () => {
    mount('/channels?tab=all');
    await screen.findByText('ops');
    // 「게이트웨이」 열 머리 옆이라 상태만 적는다(2026-10-20)
    expect(screen.getByText('실행 중')).toBeInTheDocument();
    expect(screen.getByText('중지됨')).toBeInTheDocument();
    expect(screen.getByText('알 수 없음')).toBeInTheDocument();
    expect(screen.queryByText(/^게이트웨이 (실행 중|중지됨)/)).toBeNull();
    expect(screen.getByText('텔레그램 연결됨 · 주의')).toBeInTheDocument();
    expect(screen.getByText('슬랙 fatal')).toBeInTheDocument();
    expect(screen.getByText('버즈 연결됨')).toBeInTheDocument();
  });

  it('프로파일 행을 누르면 서랍에 서비스·크론·채널·이어보기를 보인다', async () => {
    const user = userEvent.setup();
    mount('/channels?tab=all');
    await user.click(await rowByName(/^ma /));
    const dlg = await screen.findByRole('dialog', { name: 'ma' });
    // 서랍 본문은 페이지 등록부의 늦게 불러오는 본문이다(스펙 2026-10-28-014 D8) — 그려질 때까지 기다린다
    expect(await within(dlg).findByText('inactive')).toBeInTheDocument();
    expect(within(dlg).getByText(/4개, 게이트웨이가 중지되어 있어 실행되지 않습니다/)).toBeInTheDocument();
    expect(within(dlg).getByRole('heading', { name: '채널 1' })).toBeInTheDocument(); // 개수는 제목 옆 뱃지
    expect(within(dlg).getByText(/갱신 2026-10-10 09:30/)).toBeInTheDocument();
    expect(within(dlg).getByRole('link', { name: 'ma 프로파일 설정' })).toHaveAttribute('href', '/profiles?name=ma');
    expect(within(dlg).getByRole('link', { name: 'ma 채널 연결' })).toHaveAttribute('href', '/profiles?name=ma&pane=channels');
    expect(within(dlg).getByRole('link', { name: 'ma 의 예약 작업' })).toHaveAttribute('href', '/cron?tab=profiles&q=ma');
    expect(within(dlg).getByRole('link', { name: 'ma 의 API 키·토큰' })).toHaveAttribute(
      'href',
      '/credentials?tab=all&profile=ma'
    );
    const popup = watchChatPopup();
    fireEvent.click(within(dlg).getByRole('button', { name: 'ma 대화 열기' }));
    expect(popup()).toMatchObject({ kind: 'chat', agent: 'ma' }); // 대화 팝업(OMAI-1115)
    expect(within(dlg).queryByRole('link', { name: /에이전트 대시보드/ })).not.toBeInTheDocument(); // 에이전트 대시보드로 나가는 링크는 두지 않는다(OMAI-1117)
    expect(within(dlg).queryByText(/에이전트 대시보드에서 합니다/)).not.toBeInTheDocument();
  });

  it('서버가 서비스 상태를 읽지 못했다고 하면 안내를 알림으로 보인다', async () => {
    stubApi({ '/api/channels': { ...DATA, services_known: false }, '/api/health': { collected_at: '', totals: {} } });
    mountScreen(<Channels />, '/channels');
    expect(await screen.findByRole('alert')).toHaveTextContent('메신저 연결(게이트웨이) 동작 여부는 상태 파일로만 판단했습니다');
  });

  it('수집에 실패하면 오류를 알림으로 보인다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: '수집 실패' }), { status: 500 })))
    );
    mountScreen(<Channels />, '/channels');
    expect(await screen.findByRole('alert')).toHaveTextContent('수집 실패');
  });

  describe('편집 열(OMAI-1210)', () => {
    const mountAs = (me: unknown, back = false) => {
      stubApi({ '/api/me': me, '/api/channels': DATA, '/api/health': { collected_at: '', totals: {} } });
      mountScreen(
        <>
          <Channels />
          {back && <HistoryBack />}
        </>,
        '/channels'
      );
    };

    it('관리자에게는 행마다 「편집」이 있고 그 프로파일의 채널 탭으로 간다', async () => {
      mountAs(ME_ADMIN);
      const row = await rowByName(/^ma/);
      expect(within(row).getByRole('link', { name: 'ma 편집' })).toHaveAttribute('href', '/profiles?name=ma&pane=channels');
    });

    it('주인에게도 보이고, 관리자도 주인도 아니면 열이 없다', async () => {
      mountAs({ ...ME_USER, owner: true });
      expect(within(await rowByName(/^ma/)).getByRole('link', { name: 'ma 편집' })).toBeInTheDocument();
    });

    it('채널이 없으면 서랍에 「메신저 연결하기」 단추가 있고 그 프로파일의 채널 탭으로 간다', async () => {
      const user = userEvent.setup();
      mountAs(ME_ADMIN);
      await user.click(await rowByName(/^idle/));
      const dlg = await screen.findByRole('dialog', { name: 'idle' });
      expect(await within(dlg).findByText('연결된 채널이 없습니다')).toBeInTheDocument(); // 늦게 불러오는 본문(스펙 2026-10-28-014 D8)
      expect(within(dlg).getByRole('link', { name: '메신저 연결하기' })).toHaveAttribute('href', '/profiles?name=idle&pane=channels&add=1');
    });

    it('채널이 있거나 고칠 권한이 없으면 「메신저 연결하기」 단추가 없다', async () => {
      const user = userEvent.setup();
      mountAs(ME_ADMIN);
      await user.click(await rowByName(/^ma /));
      const dlg = await screen.findByRole('dialog', { name: 'ma' });
      await within(dlg).findByText('inactive'); // 본문이 그려진 뒤에 본다(늦게 불러오는 본문, 스펙 2026-10-28-014 D8)
      expect(within(dlg).queryByRole('link', { name: '메신저 연결하기' })).toBeNull();
    });

    it('관리자도 주인도 아니면 채널이 없어도 「메신저 연결하기」 단추가 없다', async () => {
      const user = userEvent.setup();
      mountAs(ME_USER);
      await user.click(await rowByName(/^idle/));
      const dlg = await screen.findByRole('dialog', { name: 'idle' });
      await within(dlg).findByText('연결된 채널이 없습니다'); // 본문이 그려진 뒤에 본다
      expect(within(dlg).queryByRole('link', { name: '메신저 연결하기' })).toBeNull();
    });

    // 예약 작업 화면처럼 제목 옆 + 아이콘과 표 위 글자 단추
    it('제목 옆과 표 위에 「메신저 연결하기」가 있고, 프로파일이 여럿이면 고른 프로파일의 채널 탭으로 간다', async () => {
      const user = userEvent.setup();
      mountAs(ME_ADMIN);
      await rowByName(/^ma/);
      const adds = screen.getAllByRole('button', { name: '메신저 연결하기' });
      expect(adds).toHaveLength(2);
      await user.click(adds[0]);
      const dlg = await screen.findByRole('dialog', { name: '메신저를 연결할 프로파일' });
      expect(within(dlg).getByRole('link', { name: 'idle' })).toHaveAttribute('href', '/profiles?name=idle&pane=channels&add=1');
    });

    it('프로파일이 하나면 바로 그 프로파일의 채널 탭에서 연결 대화 상자를 연다', async () => {
      const user = userEvent.setup();
      stubApi({ '/api/me': ME_ADMIN, '/api/channels': { ...DATA, profiles: [DATA.profiles[2]] }, '/api/health': { collected_at: '', totals: {} } });
      mountScreen(<Channels />, '/channels');
      await rowByName(/^idle/);
      await user.click(screen.getAllByRole('button', { name: '메신저 연결하기' })[1]);
      expect(screen.getByTestId('loc')).toHaveTextContent('/profiles?name=idle&pane=channels&add=1');
    });

    // 스펙 2026-10-28-014 D8·D9·D13: 행 서랍은 주소 ?open=<프로파일> 과 묶인 keep 서랍이라, 그 위에서 연 고르기 서랍은 쌓였다가 닫으면 상세로 돌아온다
    it('행을 누르면 주소에 open 이 생기고, 그 위에서 연 「메신저를 연결할 프로파일」 서랍을 닫으면 상세 서랍으로 돌아온다', async () => {
      const user = userEvent.setup();
      mountAs(ME_ADMIN, true);
      await user.click(await rowByName(/^ma /));
      const detail = await screen.findByRole('dialog', { name: 'ma' });
      await within(detail).findByText('inactive');
      expect(screen.getByTestId('loc')).toHaveTextContent(/^\/channels\?open=ma$/);
      fireEvent.click(screen.getAllByRole('button', { name: '메신저 연결하기', hidden: true })[0]);
      const pick = await screen.findByRole('dialog', { name: '메신저를 연결할 프로파일' });
      await user.click(within(pick).getByRole('button', { name: '닫기' }));
      expect(await screen.findByRole('dialog', { name: 'ma' })).toHaveTextContent('inactive');
      expect(screen.getByTestId('loc')).toHaveTextContent(/^\/channels\?open=ma$/);
      fireEvent.click(screen.getByRole('button', { name: '뒤로 가기', hidden: true }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(screen.getByTestId('loc')).toHaveTextContent(/^\/channels$/);
    });

    it('없는 프로파일의 링크는 서랍 안에 찾지 못했다고 알린다', async () => {
      stubApi({ '/api/me': ME_ADMIN, '/api/channels': DATA, '/api/health': { collected_at: '', totals: {} } });
      mountScreen(<Channels />, '/channels?open=gone');
      expect(await screen.findByText('프로파일 gone 을(를) 찾지 못했습니다. 지워졌거나 이름이 바뀌었을 수 있습니다.')).toBeInTheDocument();
    });

    it('관리자도 주인도 아니면 「메신저 연결하기」 추가 단추가 없다', async () => {
      mountAs(ME_USER);
      await rowByName(/^ma/);
      expect(screen.queryByRole('button', { name: '메신저 연결하기' })).toBeNull();
    });

    it('관리자도 주인도 아니면 「편집」 열이 없다', async () => {
      mountAs(ME_USER);
      await rowByName(/^ma/);
      expect(screen.queryByRole('link', { name: /편집/ })).toBeNull();
      expect(screen.queryByRole('columnheader', { name: '편집' })).toBeNull();
    });
  });
});

// 프로파일 이름 옆에 누구의 것인지 사람 이름(스펙 2026-10-18-010)
describe('Channels: 프로파일 주인 이름', () => {
  it('서버가 주인 이름을 주면 프로파일 이름 옆에 보인다', async () => {
    stubApi({ '/api/channels': { ...DATA, owner_name: 'AAS 관리자' }, '/api/health': { collected_at: '', totals: {}, dashboard_url: '' } });
    mountScreen(<Channels />, '/channels');
    const row = await rowByName(/^ma /);
    expect(within(row).getAllByText('AAS 관리자')).toHaveLength(1); // 이름 칸에 한 번만(검색용 합친 값이 화면에 두 번 나오면 안 된다)
    expect(within(row).getByText('ma')).toBeInTheDocument();
  });

  it('주인 이름이 없으면(로컬·주인 없는 설치본) 프로파일 이름만 보인다', async () => {
    stubApi({ '/api/channels': DATA, '/api/health': { collected_at: '', totals: {}, dashboard_url: '' } });
    mountScreen(<Channels />, '/channels');
    const row = await rowByName(/^ma /);
    expect(row).not.toHaveTextContent('AAS 관리자');
  });
});
