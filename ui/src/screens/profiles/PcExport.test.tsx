/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountScreen, stubApi } from '@/test/mountScreen';

import { ProfileActions } from './Detail';
import { exportFileName, PcExport } from './PcExport';
import type { ProfileDetailData } from './types';

afterEach(() => vi.unstubAllGlobals());

// jsdom 은 a[href] 를 눌러 옮겨 가지 못해 오류를 찍는다 — 받기 자체는 브라우저 일이라 여기서는 막는다
const noNavigate = (e: MouseEvent) => {
  if ((e.target as HTMLElement).closest?.('a[download]')) e.preventDefault();
};

describe('main 내보내기 결과 서랍(§10-3)', () => {
  it('내려받기 단추(크기)·한 번만·경고 한 줄·PC 적용 단계, 1·2단계는 「꼭 먼저」', async () => {
    stubApi({});
    mountScreen(<PcExport pod="p1" initial={{ id: 'e1', size: 84 * 1024 * 1024, profile: 'main' }} />, '/profiles');
    const dl = screen.getByRole('link', { name: '내려받기(84 MB)' });
    expect(dl).toHaveAttribute('href', '/api/profile/pc-export?pod=p1&id=e1');
    expect(dl).toHaveAttribute('download');
    expect(screen.getByText('한 번만 받을 수 있습니다')).toBeInTheDocument();
    expect(screen.getByText('대화 기록이 들어 있습니다 · 비밀값은 없습니다')).toBeInTheDocument();
    expect(screen.getAllByText('꼭 먼저')).toHaveLength(2);
    expect(screen.getByText(/--strip-components=1/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(exportFileName('main').replace(/\./g, '\\.')))).toBeInTheDocument();
  });

  it('한 번 누르면 단추를 막고 「다시 내보내기」로 새 묶음을 만든다', async () => {
    const user = userEvent.setup();
    const fn = stubApi({ '/api/profile/pc-export': { id: 'e2', size: 1024, profile: 'main' } });
    document.addEventListener('click', noNavigate);
    try {
      mountScreen(<PcExport pod="p1" initial={{ id: 'e1', size: 2048, profile: 'main' }} />, '/profiles');
      await user.click(screen.getByRole('link', { name: '내려받기(2 KB)' }));
      await waitFor(() => expect(screen.getByRole('link', { name: '내려받기(2 KB)' })).toHaveAttribute('aria-disabled', 'true'));
      await user.click(screen.getByRole('button', { name: '다시 내보내기' }));
      const again = await screen.findByRole('link', { name: '내려받기(1 KB)' });
      expect(again).toHaveAttribute('href', '/api/profile/pc-export?pod=p1&id=e2');
      expect(again).not.toHaveAttribute('aria-disabled');
      expect(fn.mock.calls.some((c) => String(c[0]) === '/api/profile/pc-export?pod=p1&profile=main' && (c[1] as RequestInit)?.method === 'POST')).toBe(true);
    } finally {
      document.removeEventListener('click', noNavigate);
    }
  });
});

const D = (over: Partial<ProfileDetailData['profile']> = {}, top: Partial<ProfileDetailData> = {}) =>
  ({
    profile: { name: 'main', is_default: false, ...over },
    can_edit: false,
    owner: true,
    secure: true,
    notes: [],
    models: [],
    pod: 'p1',
    mcp: [],
    ...top,
  }) as unknown as ProfileDetailData;

const ME = (primary: string) => ({ auth_enabled: true, admin: false, owner: true, user: { email: 'o@x.com' }, primary: { profile: primary, ready: true } });

const labels = () => screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));

describe('프로파일 서랍 머리의 PC 가져오기·내보내기(§10-1, OMAI-1444 DD1)', () => {
  it('main 이고 주인이면 「내 PC 로 내보내기」·「PC 에서 가져오기」 순서이고 작업 폴더 내보내기는 없다', async () => {
    stubApi({ '/api/me': ME('main'), '/api/profile/pc-import': { job: null, profile: 'main', owner: 'o@x.com' } });
    mountScreen(<ProfileActions d={D()} />, '/profiles?name=main');
    await screen.findByRole('button', { name: 'PC 에서 가져오기' });
    expect(labels().slice(0, 3)).toEqual(['내 PC 로 내보내기', 'PC 에서 가져오기', '이름 바꾸기']);
    expect(screen.queryByRole('button', { name: '내보내기' })).not.toBeInTheDocument();
  });

  it('main 이 아닌 주인의 프로파일에도 두 단추가 있다. 관리자에게도 작업 폴더 내보내기는 없다(R7 → 2026-10-23 뺌)', async () => {
    stubApi({ '/api/me': ME('main'), '/api/profile/pc-import': { job: null, profile: 'work', owner: 'o@x.com' } });
    const { unmount } = mountScreen(<ProfileActions d={D({ name: 'work' })} />, '/profiles?name=work');
    await screen.findByRole('button', { name: 'PC 에서 가져오기' });
    expect(labels()).toEqual(['내 PC 로 내보내기', 'PC 에서 가져오기', '이름 바꾸기']);
    unmount();
    mountScreen(<ProfileActions d={D({ name: 'work' }, { can_edit: true, owner: false })} />, '/profiles?name=work');
    await screen.findByRole('button', { name: 'PC 에서 가져오기' });
    expect(labels()).toEqual(['내 PC 로 내보내기', 'PC 에서 가져오기', '이름 바꾸기', '삭제']);
  });

  it('루트(default)·가져오기 임시 프로파일(pcimp-)에는 보이지 않는다(OV10)', async () => {
    stubApi({ '/api/me': ME('main') });
    const { unmount } = mountScreen(<ProfileActions d={D({ name: 'default', is_default: true }, { can_edit: true, owner: false })} />, '/profiles?name=default');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('button', { name: '내보내기' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'PC 에서 가져오기' })).not.toBeInTheDocument();
    unmount();
    mountScreen(<ProfileActions d={D({ name: 'pcimp-ab12' })} />, '/profiles?name=pcimp-ab12');
    await screen.findByRole('button', { name: '이름 바꾸기' });
    expect(screen.queryByRole('button', { name: 'PC 에서 가져오기' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '내 PC 로 내보내기' })).not.toBeInTheDocument();
  });

  it('주인도 관리자도 아니면 main 이어도 보이지 않는다', async () => {
    stubApi({ '/api/me': ME('main') });
    mountScreen(<ProfileActions d={D({}, { owner: false })} />, '/profiles?name=main');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('button', { name: 'PC 에서 가져오기' })).not.toBeInTheDocument();
  });

  it('가져오기가 진행 중이면 두 단추와 삭제도 보이되 누를 수 없고 이유를 읽는다(DD7)', async () => {
    stubApi({ '/api/me': ME('main'), '/api/profile/pc-import': { job: { id: 'x', state: 'running', stage: 'import' }, profile: 'work', owner: '' } });
    mountScreen(<ProfileActions d={D({ name: 'work' }, { can_edit: true, owner: false })} />, '/profiles?name=work');
    await waitFor(() => expect(screen.getByRole('button', { name: 'PC 에서 가져오기' })).toHaveAttribute('aria-disabled', 'true'));
    expect(screen.getByRole('button', { name: 'PC 에서 가져오기' })).toHaveAccessibleDescription('가져오기가 진행 중입니다');
    for (const name of ['내 PC 로 내보내기', '이름 바꾸기', '삭제']) expect(screen.getByRole('button', { name })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: '삭제' })).toHaveAccessibleDescription('가져오기가 진행 중입니다');
  });

  it('누르면 가져오기 서랍을 열고 부제목에 단계를 보인다. main 이 아니면 PC 쪽 프로파일 칸을 그 이름으로 채운다(DD14)', async () => {
    const user = userEvent.setup();
    stubApi({ '/api/me': ME('main'), '/api/profile/pc-import': { job: null, profile: 'work', owner: '' } });
    mountScreen(<ProfileActions d={D({ name: 'work' })} />, '/profiles?name=work');
    await user.click(await screen.findByRole('button', { name: 'PC 에서 가져오기' }));
    expect(await screen.findByText('work · 1/2 내보내고 올리기')).toBeInTheDocument();
    expect(screen.getByLabelText('PC 에서 내보낼 프로파일')).toHaveValue('work');
  });

  it('main 은 PC 쪽 프로파일 칸이 지금처럼 default', async () => {
    const user = userEvent.setup();
    stubApi({ '/api/me': ME('main'), '/api/profile/pc-import': { job: null, profile: 'main', owner: '' } });
    mountScreen(<ProfileActions d={D()} />, '/profiles?name=main');
    await user.click(await screen.findByRole('button', { name: 'PC 에서 가져오기' }));
    expect(await screen.findByLabelText('PC 에서 내보낼 프로파일')).toHaveValue('default');
  });

  it('「내 PC 로 내보내기」는 확인한 뒤 pc-export 로 만들고 내려받기 서랍을 연다', async () => {
    const user = userEvent.setup();
    const fn = stubApi({
      '/api/me': ME('main'),
      '/api/profile/pc-export': { id: 'e9', size: 5 * 1024 * 1024, profile: 'main' },
      '/api/profile/pc-import': { job: null, profile: 'main', owner: '' },
    });
    mountScreen(<ProfileActions d={D()} />, '/profiles?name=main');
    await user.click(await screen.findByRole('button', { name: '내 PC 로 내보내기' }));
    const box = await screen.findByRole('dialog', { name: '내 PC 로 내보내기' });
    expect(box).toHaveTextContent('main 프로파일을 내 PC 로 받을 묶음 파일로 내보낼까요?');
    await user.click(within(box).getByRole('button', { name: '내 PC 로 내보내기' }));
    expect(await screen.findByRole('link', { name: '내려받기(5 MB)' })).toHaveAttribute('href', '/api/profile/pc-export?pod=p1&id=e9');
    expect(fn.mock.calls.some((c) => String(c[0]).startsWith('/api/profile/action'))).toBe(false); // 옛 내보내기(컨테이너 안 경로)를 쓰지 않는다
  });

  it('확인 단계 묶음이 있으면 이름 바꾸기 창에 함께 취소된다고 알리고, 409 busy_import 는 화면 문장으로(DD7)', async () => {
    const user = userEvent.setup();
    const base = stubApi({
      '/api/me': ME('main'),
      '/api/profile/pc-import': { job: { id: 'x', state: 'uploaded', stage: 'check', name: 'hermes-work.tar.gz' }, profile: 'work', owner: '' },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) =>
        url.startsWith('/api/profile/action')
          ? Promise.resolve(new Response(JSON.stringify({ error: 'busy', reason: 'busy_import' }), { status: 409 }))
          : base(url, init)
      )
    );
    mountScreen(<ProfileActions d={D({ name: 'work' })} />, '/profiles?name=work');
    await waitFor(() => expect(screen.getByRole('button', { name: '이름 바꾸기' })).not.toHaveAttribute('aria-disabled'));
    await user.click(screen.getByRole('button', { name: '이름 바꾸기' }));
    const dlg = await screen.findByRole('dialog', { name: '이름 바꾸기' });
    expect(within(dlg).getByText('확인 중인 PC 가져오기 묶음(hermes-work.tar.gz)도 취소됩니다.')).toBeInTheDocument();
    await user.click(within(dlg).getByRole('button', { name: '바꾸기' }));
    expect(await within(dlg).findByText('가져오기가 진행 중이라 지금은 할 수 없습니다')).toBeInTheDocument();
  });

  it('확인 단계 묶음이 있으면 삭제 창에도 같은 줄', async () => {
    const user = userEvent.setup();
    stubApi({
      '/api/me': ME('main'),
      '/api/profile/pc-import': { job: { id: 'x', state: 'uploaded', stage: 'check', name: 'hermes-work.tar.gz' }, profile: 'work', owner: '' },
      '/api/profile?': D({ name: 'work', jobs_total: 0 } as never, { can_edit: true, owner: false }),
    });
    mountScreen(<ProfileActions d={D({ name: 'work' }, { can_edit: true, owner: false })} />, '/profiles?name=work');
    await user.click(await screen.findByRole('button', { name: '삭제' }));
    const dlg = await screen.findByRole('dialog', { name: '프로파일 삭제' });
    expect(await within(dlg).findByText('확인 중인 PC 가져오기 묶음(hermes-work.tar.gz)도 취소됩니다.')).toBeInTheDocument();
  });
});

describe('main 이 아닌 프로파일의 내보내기 결과(OMAI-1444 DD11·R13·R16)', () => {
  it('기본은 새 이름으로 넣는 명령이고, 이름 칸({name}-aas)을 고치면 명령이 바뀐다. 바꾸기·default 는 접혀 있다', async () => {
    const user = userEvent.setup();
    stubApi({});
    mountScreen(<PcExport pod="p1" main={false} initial={{ id: 'e1', size: 1024, profile: 'research' }} />, '/profiles');
    const file = exportFileName('research');
    const field = screen.getByLabelText('PC 에 만들 프로파일 이름');
    expect(field).toHaveValue('research-aas');
    expect(getComputedStyle(screen.getByText(`hermes profile import ~/Downloads/${file} --name research-aas`)).alignItems).toBe('center');   // 명령 칸 글을 세로 가운데(OMAI-1444 실화면 지적)
    await user.clear(field);
    await user.type(field, 'lab');
    expect(screen.getByText(`hermes profile import ~/Downloads/${file} --name lab`)).toBeInTheDocument();
    expect(screen.getByText('hermes -p lab config')).toBeInTheDocument();
    expect(screen.getByText('PC 에 새 프로파일로 넣기')).toBeInTheDocument();
    // 접힌 영역: 기존 프로파일 바꾸기(보관이 꼭 먼저 → 지우기 → 넣기)와 default 에 넣기
    await user.click(screen.getByRole('button', { name: '기존 프로파일을 바꾸려면' }));
    expect(screen.getByText('hermes profile export research -o ~/hermes-research-backup.tar.gz')).toBeInTheDocument();
    expect(screen.getByText('hermes profile delete research')).toBeInTheDocument();
    expect(screen.getByText(`hermes profile import ~/Downloads/${file} --name research`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'default 에 넣으려면' })).toBeInTheDocument();
  });

  it('공용 스킬이 있으면 묶음에 들어가지 않는다고 한 줄, 없으면 없다(R16). main 은 지금 절차 그대로', async () => {
    stubApi({});
    const { unmount } = mountScreen(
      <PcExport pod="p1" main={false} initial={{ id: 'e1', size: 1024, profile: 'research', shared_skills: { n: 3, sources: ['main'] } }} />,
      '/profiles'
    );
    expect(screen.getByText('공용 스킬 3개(main 프로파일)는 묶음에 들어가지 않습니다')).toBeInTheDocument();
    unmount();
    mountScreen(<PcExport pod="p1" initial={{ id: 'e1', size: 1024, profile: 'main', shared_skills: { n: 0, sources: [] } }} />, '/profiles');
    expect(screen.queryByText(/공용 스킬/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('PC 에 만들 프로파일 이름')).not.toBeInTheDocument();
    expect(screen.getByText('PC 의 default 에 넣기')).toBeInTheDocument();
  });
});
