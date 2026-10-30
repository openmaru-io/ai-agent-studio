/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountScreen, stubApi } from '@/test/mountScreen';

import { EnvPane } from './Panes';
import type { ProfileDetailData } from './types';

afterEach(() => vi.unstubAllGlobals());

const D = (env: { name: string; set: boolean }[]) =>
  ({ profile: { name: 'ma' }, can_edit: true, owner: false, secure: true, env }) as unknown as ProfileDetailData;

describe('비밀값 탭의 ?key=(스킬 서랍 링크, 스펙 2026-10-16-010 2단계)', () => {
  it('아직 없는 변수면 넣기 칸을 그 이름으로 바로 연다', async () => {
    stubApi({});
    mountScreen(<EnvPane d={D([{ name: 'OTHER_KEY', set: true }])} />, '/profiles?name=ma&pane=env&key=GOOGLE_CLIENT_SECRET');
    expect(await screen.findByText('GOOGLE_CLIENT_SECRET')).toBeInTheDocument();
    expect(screen.queryByText('OTHER_KEY')).toBeInTheDocument();
  });

  it('목록에 있는 변수면 그 변수로 걸러 보인다(값이 비어 있어도)', async () => {
    stubApi({});
    mountScreen(<EnvPane d={D([{ name: 'OTHER_KEY', set: true }, { name: 'GWS_DOMAIN', set: false }])} />, '/profiles?name=ma&pane=env&key=GWS_DOMAIN');
    expect(await screen.findByText('GWS_DOMAIN')).toBeInTheDocument();
    expect(screen.queryByText('OTHER_KEY')).not.toBeInTheDocument();
  });

  it('링크로 와서 비어 있던 변수가 채워지면 「Claude Code 로 돌아가세요」, 처음부터 있던 값이면 띄우지 않는다(스펙 2026-10-28-001 §3-7 ⑥)', async () => {
    stubApi({});
    // 저장 뒤 다시 읽은 목록에서 값이 채워진 것을 흉내 낸다(같은 화면 트리 안에서 d 만 바꾼다)
    function Harness() {
      const [set, setSet] = useState(false);
      return (
        <>
          <button onClick={() => setSet(true)}>fill</button>
          <EnvPane d={D([{ name: 'WEATHER_KEY', set }])} />
        </>
      );
    }
    const view = mountScreen(<Harness />, '/profiles?name=ma&pane=env&key=WEATHER_KEY');
    expect(await screen.findByText('WEATHER_KEY')).toBeInTheDocument();
    expect(screen.queryByText(/Claude Code 로 돌아가세요/)).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'fill' }));
    expect(await screen.findByText('WEATHER_KEY 을 넣었습니다. Claude Code 로 돌아가세요.')).toBeInTheDocument();
    view.unmount();
    mountScreen(<EnvPane d={D([{ name: 'WEATHER_KEY', set: true }])} />, '/profiles?name=ma&pane=env&key=WEATHER_KEY');
    expect(await screen.findByText('WEATHER_KEY')).toBeInTheDocument();
    expect(screen.queryByText(/Claude Code 로 돌아가세요/)).toBeNull();
  });
});
