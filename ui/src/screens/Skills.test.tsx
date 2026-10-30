/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { watchChatPopup } from '@/test/chatPopup';
import { mountScreen, postedTo, rowByName, stubApi } from '@/test/mountScreen';

import { Skills } from './Skills';

const LIST = {
  totals: { skills: 3, with_cron: 1, with_mcp: 2, with_rest: 1 },
  skills: [
    {
      id: 'default:report',
      name: 'report',
      description: '주간 보고',
      profile: 'default',
      origin: 'bundled_modified',
      n_cron: 1,
      n_mcp: 1,
      n_rest: 0,
      n_scripts: 2,
    },
    {
      id: 'ma:alert',
      name: 'alert',
      description: '',
      profile: 'ma',
      n_cron: 0,
      n_mcp: 1,
      n_rest: 1,
      n_scripts: 0,
      urls: ['https://api.example.com/a', 'https://api.example.com/b', 'https://hooks.example.org/x'],
    },
    { id: 'ma:plain', name: 'plain', description: '그냥', profile: 'ma', n_cron: 0, n_mcp: 0, n_rest: 0, n_scripts: 0 },
  ],
  by_mcp: { chart: ['default:report', 'ma:alert'] },
  by_host: { 'api.example.com': ['ma:alert'] },
};
const ONE = {
  name: 'report',
  description: '주간 보고를 만든다',
  profile: 'default',
  path: 'skills/report',
  origin: 'bundled_modified',
  modified: '2026-10-01T00:00:00Z',
  files: 4,
  cron: [
    { profile: 'ma', job: 'weekly', enabled: true, last_status: 'ok' },
    { profile: 'ops', job: 'daily', enabled: false },
  ],
  mcp: [{ server: 'chart', tools: ['render', 'save'], evidence: '' }],
  rest: [{ host: 'api.example.com', urls: ['https://api.example.com/a'] }],
  skills: ['alert'],
  scripts: ['skills/report/run.py'],
  external_scripts: ['/opt/x/ext.sh'],
};

let PUBLISH: unknown = { items: [], can: false };
afterEach(() => {
  PUBLISH = { items: [], can: false };
  vi.unstubAllGlobals();
});

/** 새 스킬 본문의 「언제 쓰나」만 채운다. 틀을 그대로 두면 만들지 않는다(2026-10-28-004) */
function fillBody(dlg: HTMLElement) {
  const box = within(dlg).getByLabelText('스킬 본문') as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: box.value.replace(/(## When to Use \(언제 쓰나\)\n<!--.*-->\n)- \n/, '$1- 「주간 보고서 만들어 줘」\n') } });
}

function mount(initial = '/skills') {
  const fn = stubApi({ '/api/skill/create': { name: 'newone' }, '/api/skill?': ONE, '/api/market/publish': PUBLISH, '/api/skills': LIST });
  mountScreen(<Skills />, initial);
  return fn;
}

describe('Skills', () => {
  it('출처 열에서 Hermes 허브에서 받은 스킬은 「Hermes 허브」, 옛 마켓에서 설치한 스킬은 「스킬 허브」로 구분해 보인다(2026-10-18)', async () => {
    const rows = [
      { id: 'ma:a', name: 'fromhub', description: '', profile: 'ma', origin: 'hub', n_cron: 0, n_mcp: 0, n_rest: 0, n_scripts: 0 },
      { id: 'ma:b', name: 'frommarket', description: '', profile: 'ma', origin: 'market', n_cron: 0, n_mcp: 0, n_rest: 0, n_scripts: 0 },
    ];
    stubApi({ '/api/market/publish': PUBLISH, '/api/skills': { ...LIST, skills: rows, by_mcp: {}, by_host: {} } });
    mountScreen(<Skills />, '/skills');
    const hub = await rowByName(/^fromhub/);
    expect(within(hub).getByText('Hermes 허브')).toBeInTheDocument();
    expect(within(await rowByName(/^frommarket/)).getByText('스킬 허브')).toBeInTheDocument();
  });

  it('올릴 수 있는 스킬은 서랍에서 이름·버전을 보내 올리기를 요청한다. 권한이 없으면 구역이 없다(2026-10-14-015)', async () => {
    const user = userEvent.setup();
    PUBLISH = { items: [{ id: 'r1', ts: 't', who: 'kim', profile: 'default', path: 'skills/report', name: 'report-kr', version: '1.0.0', status: 'requested' }], can: true };
    const fn = mount();
    await user.click(await rowByName(/^report/));
    const dlg = await screen.findByRole('dialog', { name: 'report' });
    expect(await within(dlg).findByText(/report-kr@1.0.0 — 승인 기다림/)).toBeInTheDocument();
    expect(within(dlg).getByText('스킬 허브에 게시')).toBeInTheDocument(); // 2026-10-18: 「스킬 허브에 올리기」 → 「스킬 허브에 올리기」
    await user.click(within(dlg).getByRole('button', { name: '게시 요청' }));
    await waitFor(() =>
      expect(fn.mock.calls.filter((c) => String(c[0]) === '/api/market/publish' && (c[1] as RequestInit | undefined)?.body).map((c) => JSON.parse((c[1] as RequestInit).body as string))).toEqual([
        { profile: 'default', path: 'skills/report', name: 'report', version: '1.0.0' },
      ])
    );
  });

  // 네임스페이스는 서버가 준 이름(auto_namespace_label)으로 보이고, 옛 서버라 없으면 slug 를 보인다(스펙 skillhub-namespace-shared-restricted §4-3)
  it.each([
    ['이름이 있으면 이름', { auto_namespace_label: 'restricted' }, 'restricted'],
    ['이름이 없으면 slug', {}, 'paid'],
  ])('주인 스킬 자동 승인이면 「관리자 검토 없이 게시」와 네임스페이스·공개 범위를 알린다(스펙 2026-10-28-001 D6) — %s', async (_c, extra, shown) => {
    const user = userEvent.setup();
    const list = { items: [], can: true };
    stubApi({
      '/api/skill?': ONE,
      '/api/market/publish': (_u: string, b: Record<string, unknown>) =>
        b.name ? { ok: true, request: { id: 'r2', auto: 'pending', auto_namespace: 'paid', auto_public: false, ...extra } } : list,
      '/api/skills': LIST,
    });
    mountScreen(<Skills />, '/skills');
    await user.click(await rowByName(/^report/));
    const dlg = await screen.findByRole('dialog', { name: 'report' });
    await user.click(await within(dlg).findByRole('button', { name: '게시 요청' }));
    expect(await screen.findByText(`스킬 report 을 관리자 검토 없이 게시합니다 · ${shown}(구성원만 보임)`)).toBeInTheDocument();
  });

  it('스킬이 선언한 필요한 비밀값을 서랍에 보이고, 없는 값은 비밀값 탭으로 가는 링크를 준다(스펙 2026-10-16-010 2단계)', async () => {
    const user = userEvent.setup();
    stubApi({
      '/api/skill?': { ...ONE, required_env: [
        { name: 'GOOGLE_CLIENT_ID', prompt: '클라이언트 ID', set: true },
        { name: 'GOOGLE_CLIENT_SECRET', prompt: '클라이언트 비밀', required_for: '메일 보내기', set: false },
        { name: 'GWS_DOMAIN', optional: true, set: false },
      ] },
      '/api/market/publish': PUBLISH,
      '/api/skills': LIST,
    });
    mountScreen(<Skills />, '/skills');
    await user.click(await rowByName(/^report/));
    const dlg = await screen.findByRole('dialog', { name: 'report' });
    expect(await within(dlg).findByText('필요한 비밀값')).toBeInTheDocument();
    expect(within(dlg).getByText('설정됨')).toBeInTheDocument();
    expect(within(dlg).getByText('필요')).toBeInTheDocument();
    expect(within(dlg).getByText('선택')).toBeInTheDocument();
    expect(within(dlg).getByText('클라이언트 비밀 · 메일 보내기에 필요')).toBeInTheDocument();
    const links = within(dlg).getAllByRole('link', { name: '비밀값 탭에서 넣기' });
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute('href', '/profiles?name=default&pane=env&key=GOOGLE_CLIENT_SECRET');
    expect(within(dlg).getByText(/주소창의 주소 전체를 채팅에 붙여넣으세요/)).toBeInTheDocument();
  });

  it('올리기 권한이 없으면 서랍에 「스킬 허브에 올리기」가 없다', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await rowByName(/^report/));
    const dlg = await screen.findByRole('dialog', { name: 'report' });
    await within(dlg).findByText(/새 버전을 받지 않고/);
    expect(within(dlg).queryByText('스킬 허브에 게시')).toBeNull();
  });

  it('출처를 열에 보이고, 고친 기본 스킬은 서랍에 새 버전을 받지 않는다는 안내를 보인다(2026-10-14-015)', async () => {
    const user = userEvent.setup();
    mount();
    expect(await rowByName(/^report/)).toHaveTextContent('기본(바뀜)');   // 행위자를 빼고 사실만(스펙 2026-10-27-011 D17)
    await user.click(await rowByName(/^report/));
    const dlg = await screen.findByRole('dialog', { name: /report/ });
    expect(await within(dlg).findByText(/새 버전을 받지 않고/)).toBeInTheDocument();
  });

  it('다른 프로파일에서 가져온 스킬: 위치 칸에 가져온 곳을 보이고 서랍에는 고칠 수 없다는 안내만 있다(스펙 2026-10-15-011 D6)', async () => {
    const user = userEvent.setup();
    PUBLISH = { items: [], can: true };
    const row = { id: 'side:report', name: 'report', description: '주간 보고', profile: 'side', origin: 'local', shared_from: 'main', n_cron: 0, n_mcp: 0, n_rest: 0, n_scripts: 0 };
    stubApi({
      '/api/skill?': { ...ONE, id: 'side:report', profile: 'side', path: 'profiles/main/skills/report', origin: 'local', shared_from: 'main' },
      '/api/market/publish': PUBLISH,
      '/api/skills': { ...LIST, totals: { skills: 1, with_cron: 0, with_mcp: 0, with_rest: 0 }, skills: [row], by_mcp: {}, by_host: {} },
    });
    mountScreen(<Skills />, '/skills');
    expect(await rowByName(/^report/)).toHaveTextContent('side (main에서 가져옴)');
    await user.click(await rowByName(/^report/));
    const dlg = await screen.findByRole('dialog', { name: /report/ });
    expect(await within(dlg).findByText(/main 프로파일의 스킬을 함께 쓰고 있습니다/)).toBeInTheDocument();
    expect(within(dlg).queryByRole('button', { name: /내려받기/ })).toBeNull();
    expect(within(dlg).queryByText('스킬 허브에 게시')).toBeNull();
  });

  it('AAS 기본 스킬: 출처 열에 「AAS 기본」, 서랍에는 끄는 곳 안내만 있고 내려받기·게시가 없다(스펙 2026-10-27-007)', async () => {
    const user = userEvent.setup();
    PUBLISH = { items: [], can: true };
    const row = { id: 'ma:aas/doc-to-markdown', name: 'doc-to-markdown', description: '문서를 Markdown 으로', profile: 'ma', origin: 'aas', n_cron: 0, n_mcp: 0, n_rest: 0, n_scripts: 0 };
    stubApi({
      '/api/skill?': { ...ONE, name: 'doc-to-markdown', id: row.id, profile: 'ma', path: '/opt/aas-skills/doc-to-markdown', origin: 'aas', cron: [], mcp: [], rest: [] },
      '/api/market/publish': PUBLISH,
      '/api/skills': { ...LIST, totals: { skills: 1, with_cron: 0, with_mcp: 0, with_rest: 0 }, skills: [row], by_mcp: {}, by_host: {} },
    });
    mountScreen(<Skills />, '/skills?tab=builtin');                       // AAS 기본은 「기본 제공」 보기에 있다(2026-10-27-011 R1)
    expect(await rowByName(/^doc-to-markdown/)).toHaveTextContent('AAS 기본');
    await user.click(await rowByName(/^doc-to-markdown/));
    const dlg = await screen.findByRole('dialog', { name: /doc-to-markdown/ });
    expect(await within(dlg).findByText(/끄기는 프로파일의 스킬 패널에서 합니다/)).toBeInTheDocument();
    expect(within(dlg).queryByRole('button', { name: /내려받기/ })).toBeNull();
    expect(within(dlg).queryByText('스킬 허브에 게시')).toBeNull();
  });

  it('카드와 행: 위치·설명·cron 배지·호출 수', async () => {
    mount();
    expect(await screen.findByText('report')).toBeInTheDocument();
    expect(screen.queryByText('정적 분석')).not.toBeInTheDocument();    // 부제의 「정적 분석」은 뺐다(2026-10-27-013 디자인 2A). 수는 보기 카드가 말한다
    // 둘째 줄·오른쪽 개수는 열이 됐다(OMAI-1127)
    const report = await rowByName(/^report/);
    expect(report).toHaveTextContent(/공용.*주간 보고/);
    expect([...report.querySelectorAll('[role="cell"]')].slice(-4).map((c) => c.textContent)).toEqual(['1', '2', '1', '0']);
    const alert = await rowByName(/^alert/);
    expect(alert).toHaveTextContent(/ma.*설명 없음/);
  });

  it('배지: 예약 작업·MCP·외부 URL 로 거른다(2026-10-27-011 R3·D18)', async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText('report');
    await user.click(screen.getByRole('button', { name: /MCP 호출/ }));
    expect(screen.getByTestId('loc')).toHaveTextContent('chip=mcp');
    expect(screen.getByText('alert')).toBeInTheDocument();
    expect(screen.queryByText('plain')).not.toBeInTheDocument();
  });

  it('외부 URL 탭은 스킬 다음 열에 대표 URL 과 나머지 개수를 보이고, 올리면 전체 URL 을 보인다', async () => {
    const user = userEvent.setup();
    mount('/skills?tab=rest');
    const alert = await rowByName(/^alert/);
    const cells = [...alert.querySelectorAll('[role="cell"]')];
    const urlCell = cells[1] as HTMLElement;
    expect(urlCell).toHaveTextContent('https://api.example.com/a');
    expect(urlCell).toHaveTextContent('+2');
    await user.hover(within(urlCell).getByText('https://api.example.com/a'));
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent('https://api.example.com/a');
    expect(tip).toHaveTextContent('https://api.example.com/b');
    expect(tip).toHaveTextContent('https://hooks.example.org/x');
    // 행의 읽는 이름은 툴팁이 열려도 그대로다(행 이름으로 다시 찾는다)
    expect(await rowByName(/^alert/)).toBe(alert);
  });

  it('URL 열은 외부 URL 탭에만 있다', async () => {
    mount();
    await screen.findByText('report');
    expect(screen.queryByRole('columnheader', { name: /호출 URL/ })).not.toBeInTheDocument();
  });

  it('호출 대상 선택은 lens 를 주소에 담고 그 스킬만 보인다. 전체 보기로 풀린다', async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText('report');
    await user.selectOptions(screen.getByRole('combobox', { name: '호출 대상으로 거르기' }), 'host:api.example.com');
    expect(screen.getByTestId('loc')).toHaveTextContent('lens=host%3Aapi.example.com');
    expect(screen.getByText('alert')).toBeInTheDocument();
    expect(screen.queryByText('report')).not.toBeInTheDocument();
    expect(screen.getByText('api.example.com', { selector: 'code' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '전체 보기' }));
    expect(screen.getByTestId('loc')).not.toHaveTextContent('lens=');
    expect(screen.getByText('report')).toBeInTheDocument();
  });

  it('서랍: 스킬 정보와 호출 관계를 보이고 화면 링크로 잇는다', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await rowByName(/^report/));
    const dlg = await screen.findByRole('dialog', { name: 'report' });
    expect(await within(dlg).findByText('주간 보고를 만든다')).toBeInTheDocument();
    expect(within(dlg).getByText('skills/report')).toBeInTheDocument();
    expect(within(dlg).getByRole('link', { name: '스킬 연결도 보기' })).toHaveAttribute(
      'href',
      '/flows?root=skill%3Adefault%3Areport'
    );
    const popup = watchChatPopup();
    fireEvent.click(within(dlg).getByRole('button', { name: 'AI 에게 더 묻기' }));
    expect(popup()).toMatchObject({ kind: 'chat', agent: 'ma', text: expect.any(String) }); // 공용이면 첫 cron 의 프로파일
    expect(within(dlg).getByRole('link', { name: 'ma/weekly' })).toHaveAttribute('href', '/cron?tab=profiles&q=ma');
    expect(within(dlg).getByText('꺼짐')).toBeInTheDocument();
    expect(within(dlg).getByText('ok')).toBeInTheDocument();
    expect(within(dlg).getByRole('link', { name: 'chart' })).toHaveAttribute('href', '/credentials?tab=all&q=chart');
    expect(within(dlg).getByRole('link', { name: '같은 MCP 를 부르는 스킬' })).toHaveAttribute(
      'href',
      '/skills?tab=all&profile=*&lens=mcp%3Achart'                          // 공용 스킬은 모든 프로파일이 쓰므로 전체 프로파일(2026-10-27-013 §4-5)
    );
    expect(within(dlg).getByText('render, save')).toBeInTheDocument();
    expect(within(dlg).getByRole('link', { name: 'alert' })).toHaveAttribute('href', '/skills?tab=all&profile=*&q=alert');
    // 외부 호스트·스크립트 칸은 없고 「스킬 연결도와 대화」 칸 안 요약 한 줄이다(스펙 2026-10-28-013 디자인 D3·D14)
    const sum = dlg.querySelector('[data-call-summary]') as HTMLElement;
    expect(sum).toHaveTextContent('외부 호스트 1·스크립트 2·스킬 폴더 밖 1');
    expect(within(dlg).queryByRole('heading', { name: /부르는 외부 호스트/ })).not.toBeInTheDocument();
    expect(within(dlg).queryByRole('link', { name: 'api.example.com' })).not.toBeInTheDocument();
    expect(within(dlg).queryByRole('link', { name: 'run.py' })).not.toBeInTheDocument();
    expect(within(dlg).getAllByRole('link', { name: '스킬 연결도 보기' })).toHaveLength(1);
    // 폴더 밖 스크립트는 경고 Tag + 경로 한 줄(D4), 복사 단추(D15)
    const outside = dlg.querySelector('[data-outside-path]') as HTMLElement;
    expect(outside).toHaveTextContent('스킬 폴더 밖/opt/x/ext.sh');
    expect(within(outside).getByRole('button', { name: '/opt/x/ext.sh 경로 복사' })).toBeInTheDocument();
  });

  it('서랍 요약 줄: 문서에만 나온 호스트는 풍선말로 파일을 보이고, 모두 0 이면 「없음」, 0 인 칸은 그리지 않는다(2026-10-28-013)', async () => {
    const user = userEvent.setup();
    stubApi({ '/api/skill?': { ...ONE, rest_doc: [{ host: 'p5js.org', files: ['README.md'] }] }, '/api/skills': LIST, '/api/market/publish': PUBLISH });
    mountScreen(<Skills />, '/skills');
    await user.click(await rowByName(/^report/));
    let dlg = await screen.findByRole('dialog', { name: 'report' });
    const doc = await within(dlg).findByRole('button', { name: '문서에만 1' });
    await user.hover(doc);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('p5js.org — README.md');
    cleanup();
    const none = { ...ONE, cron: [], mcp: [], rest: [], skills: [], scripts: [], external_scripts: [] };
    stubApi({ '/api/skill?': none, '/api/skills': LIST, '/api/market/publish': PUBLISH });
    mountScreen(<Skills />, '/skills');
    await user.click(await rowByName(/^report/));
    dlg = await screen.findByRole('dialog', { name: 'report' });
    expect(await within(dlg).findByText('외부 호스트·스크립트 없음')).toBeInTheDocument();
    for (const h of [/이 스킬을 실행하는 예약 작업/, /부르는 MCP 서버/, /부르는 다른 스킬/])
      expect(within(dlg).queryByRole('heading', { name: h })).not.toBeInTheDocument();
    cleanup();
    const many = { ...ONE, external_scripts: ['/opt/data/a/1.sh', '/opt/data/a/2.sh', '/opt/data/a/3.sh', '/opt/data/a/4.sh', '/opt/data/a/5.sh', '/opt/data/a/6.sh', '/opt/data/a/7.sh'] };
    stubApi({ '/api/skill?': many, '/api/skills': LIST, '/api/market/publish': PUBLISH });
    mountScreen(<Skills />, '/skills');
    await user.click(await rowByName(/^report/));
    dlg = await screen.findByRole('dialog', { name: 'report' });
    await within(dlg).findByText('외 2개는 스킬 연결도에서 봅니다');
    expect(dlg.querySelectorAll('[data-outside-path]')).toHaveLength(5);
  });

  it('새 스킬(OMAI-1195): 루트가 숨겨진 POD 는 서버가 준 위치 목록만 보이고 공용이 없으며 처음 값이 주 에이전트다', async () => {
    const user = userEvent.setup();
    const fn = stubApi({ '/api/skill/create': { name: 'newone' }, '/api/skill?': ONE, '/api/market/publish': PUBLISH, '/api/skills': { ...LIST, profiles: ['main', 'ma'], primary: 'main' } });
    mountScreen(<Skills />, '/skills');
    await user.click((await screen.findAllByRole('button', { name: '새 스킬' }))[0]);
    const dlg = await screen.findByRole('dialog', { name: '새 스킬' });
    const where = within(dlg).getByRole('combobox', { name: '누가 쓰나' }) as HTMLSelectElement;
    expect(within(where).getAllByRole('option').map((o) => o.textContent)).toEqual(['main 전용', 'ma 전용']); // 공용(default)이 없다
    expect(where.value).toBe('main');
    fillBody(dlg);
    await user.type(within(dlg).getByRole('textbox', { name: /이름/ }), 'newone');
    await user.type(within(dlg).getByRole('textbox', { name: '설명' }), '새로 만든다');
    await user.click(within(dlg).getByRole('button', { name: '스킬 만들기' }));
    await waitFor(() => {
      const c = fn.mock.calls.find((x) => String(x[0]).startsWith('/api/skill/create'))!;
      expect(JSON.parse((c[1] as RequestInit).body as string)).toMatchObject({ name: 'newone', profile: 'main' });
    });
  });

  it('새 스킬(OMAI-1195): 루트가 보이는 POD 는 공용이 목록 맨 앞이고 처음 값이다', async () => {
    const user = userEvent.setup();
    stubApi({ '/api/skill/create': { name: 'newone' }, '/api/skill?': ONE, '/api/market/publish': PUBLISH, '/api/skills': { ...LIST, profiles: ['default', 'ma'], primary: 'default' } });
    mountScreen(<Skills />, '/skills');
    await user.click((await screen.findAllByRole('button', { name: '새 스킬' }))[0]);
    const dlg = await screen.findByRole('dialog', { name: '새 스킬' });
    const where = within(dlg).getByRole('combobox', { name: '누가 쓰나' }) as HTMLSelectElement;
    expect(within(where).getAllByRole('option')[0]).toHaveTextContent('공용');
    expect(where.value).toBe('default');
  });

  describe('내려받기(zip) (OMAI-1195)', () => {
    function mountDownload(reply: (url: string) => Promise<Response>) {
      const base = stubApi({ '/api/skill?': ONE, '/api/market/publish': PUBLISH, '/api/skills': LIST });
      const fetchMock = vi.fn((url: string, init?: RequestInit) => (url.startsWith('/api/skill/download') ? reply(url) : base(url, init)));
      vi.stubGlobal('fetch', fetchMock);
      const created = vi.fn(() => 'blob:zip');
      vi.stubGlobal('URL', { ...URL, createObjectURL: created, revokeObjectURL: vi.fn() });
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
      mountScreen(<Skills />, '/skills');
      return { fetchMock, created, click };
    }
    const zip = (headers: Record<string, string> = {}) => Promise.resolve(new Response(new Blob(['zip']), { status: 200, headers }));
    const openDrawer = async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(await rowByName(/^report/));
      return screen.findByRole('dialog', { name: 'report' });
    };

    it('「파일 N개」 아래의 글자 단추를 누르면 그 스킬 폴더를 받아 zip 으로 저장한다', async () => {
      const user = userEvent.setup();
      const { fetchMock, created, click } = mountDownload(() => zip());
      const dlg = await openDrawer(user);
      await user.click(await within(dlg).findByRole('button', { name: '내려받기(zip)' }));
      await waitFor(() => expect(click).toHaveBeenCalled());
      expect(String(fetchMock.mock.calls.find((c) => String(c[0]).startsWith('/api/skill/download'))![0])).toBe(
        '/api/skill/download?profile=default&path=' + encodeURIComponent('skills/report')
      );
      expect(created).toHaveBeenCalled();
      expect(within(dlg).queryByText(/zip 에 넣지 않은 파일/)).toBeNull(); // 빠진 파일이 없으면 경고가 없다
    });

    it('비밀값 때문에 뺀 파일이 있으면 닫을 때까지 남는 경고에 이름과 영향을 보인다', async () => {
      const user = userEvent.setup();
      mountDownload(() => zip({ 'X-AAS-Excluded': JSON.stringify(['scripts/leaky.py', 'references/key.md']) }));
      const dlg = await openDrawer(user);
      await user.click(await within(dlg).findByRole('button', { name: '내려받기(zip)' }));
      const warn = (await within(dlg).findByText(/zip 에 넣지 않은 파일/)).closest('[role="alert"]') as HTMLElement;
      expect(warn).toHaveTextContent('scripts/leaky.py');
      expect(warn).toHaveTextContent('references/key.md');
      expect(warn).toHaveTextContent('이 파일이 없으면 스킬이 동작하지 않을 수 있습니다');
      expect(warn).toHaveTextContent('EXCLUDED.txt');
    });

    it('받는 동안 단추가 잠기고 aria-busy 이며, 실패하면 서랍 안에 서버 메시지를 보인다', async () => {
      const user = userEvent.setup();
      let fail: (r: Response) => void = () => {};
      mountDownload(() => new Promise<Response>((res) => (fail = res)));
      const dlg = await openDrawer(user);
      const btn = await within(dlg).findByRole('button', { name: '내려받기(zip)' });
      await user.click(btn);
      await waitFor(() => expect(btn).toBeDisabled());
      expect(btn).toHaveAttribute('aria-busy', 'true');
      fail(new Response(JSON.stringify({ error: '스킬 폴더를 읽지 못했습니다' }), { status: 503 }));
      expect(await within(dlg).findByText('스킬 폴더를 읽지 못했습니다')).toBeInTheDocument();
      await waitFor(() => expect(btn).toBeEnabled());
    });
  });

  describe('zip 올리기 (OMAI-1195)', () => {
    const PREVIEW = {
      hash: 'a'.repeat(64),
      name: 'weekly',
      name_valid: true,
      description: '주간 보고를 만든다',
      files: [
        { path: 'SKILL.md', size: 120 },
        { path: 'references/note.md', size: 30 },
        { path: 'scripts/run.py', size: 80 },
      ],
      scripts: [{ path: 'scripts/run.py', summary: '주간 보고 데이터를 모은다', hosts: ['api.example.com'] }],
      only_skill_md: false,
      conflict: false,
    };
    type Reply = (url: string, init?: RequestInit) => Promise<Response>;
    const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
    function mountUpload(opts: { can?: boolean; upload?: Reply; apply?: Reply } = {}) {
      const base = stubApi({ '/api/skills': { ...LIST, profiles: ['default', 'ma'], primary: 'default', can_upload: opts.can ?? true }, '/api/skill?': ONE, '/api/market/publish': PUBLISH });
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url.startsWith('/api/skill/upload')) return (opts.upload ?? (() => json(PREVIEW)))(url, init);
        if (url.startsWith('/api/skill/apply')) return (opts.apply ?? (() => json({ ok: true, name: 'weekly', profile: 'default', state: 'done', scripts: 1 })))(url, init);
        return base(url, init);
      });
      vi.stubGlobal('fetch', fetchMock);
      mountScreen(<Skills />, '/skills');
      return fetchMock;
    }
    const zipFile = (name = 'weekly.zip', size = 1000) => {
      const f = new File(['zip'], name, { type: 'application/zip' });
      Object.defineProperty(f, 'size', { value: size });
      return f;
    };
    const openNew = async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click((await screen.findAllByRole('button', { name: '새 스킬' }))[0]);
      return screen.findByRole('dialog', { name: '새 스킬' });
    };
    const calls = (fn: ReturnType<typeof mountUpload>, prefix: string) => fn.mock.calls.filter((c) => String(c[0]).startsWith(prefix));
    const pick = async (dlg: HTMLElement, file: File) => {
      fireEvent.change(within(dlg).getByLabelText('스킬 zip 파일'), { target: { files: [file] } });
    };

    it('올릴 권한이 없으면 「zip 올리기」 탭을 그리지 않는다', async () => {
      const user = userEvent.setup();
      mountUpload({ can: false });
      const dlg = await openNew(user);
      expect(within(dlg).queryByRole('tab', { name: 'zip 올리기' })).toBeNull();
    });

    it('기본은 「직접 쓰기」이고 탭을 바꿔도 쓰던 입력이 남는다', async () => {
      const user = userEvent.setup();
      mountUpload();
      const dlg = await openNew(user);
      expect(within(dlg).getByRole('tab', { name: '직접 쓰기' })).toHaveAttribute('aria-selected', 'true');
      await user.type(within(dlg).getByRole('textbox', { name: /이름/ }), 'abc-skill');
      await user.click(within(dlg).getByRole('tab', { name: 'zip 올리기' }));
      expect(within(dlg).getByText('스킬 zip 을 여기로 끌어 놓거나 파일을 고르세요')).toBeInTheDocument();
      await user.click(within(dlg).getByRole('tab', { name: '직접 쓰기' }));
      expect(within(dlg).getByRole('textbox', { name: /이름/ })).toHaveValue('abc-skill');
    });

    it('zip 이 아니거나 512KiB 를 넘는 파일은 보내기 전에 인라인 오류로 거른다', async () => {
      const user = userEvent.setup();
      const fn = mountUpload();
      const dlg = await openNew(user);
      await user.click(within(dlg).getByRole('tab', { name: 'zip 올리기' }));
      await pick(dlg, new File(['x'], 'a.txt'));
      expect(await within(dlg).findByText('zip 파일이 아닙니다.')).toBeInTheDocument();
      await pick(dlg, zipFile('big.zip', 513 * 1024));
      expect(await within(dlg).findByText(/512KiB 를 넘습니다/)).toBeInTheDocument();
      expect(calls(fn, '/api/skill/upload')).toHaveLength(0);
    });

    it('파일을 고르면 바로 검사해 미리 보기를 보이고, 스크립트를 확인해야 「올리고 적용」이 켜진다', async () => {
      const user = userEvent.setup();
      const fn = mountUpload();
      const dlg = await openNew(user);
      await user.click(within(dlg).getByRole('tab', { name: 'zip 올리기' }));
      await pick(dlg, zipFile());
      expect(await within(dlg).findByText('weekly')).toBeInTheDocument();
      const sent = calls(fn, '/api/skill/upload')[0];
      expect(String(sent[0])).toBe('/api/skill/upload?profile=default');
      expect((sent[1] as RequestInit).body).toBeInstanceOf(File);
      expect(within(dlg).getByText(/이 스킬은 스크립트 1개를 실행할 수 있습니다/)).toBeInTheDocument();
      expect(within(dlg).getByText(/주간 보고 데이터를 모은다/)).toBeInTheDocument();
      expect(within(dlg).getByText(/api\.example\.com/)).toBeInTheDocument();
      const apply = within(dlg).getByRole('button', { name: '올리고 적용' });
      expect(apply).toBeDisabled();
      await user.click(within(dlg).getByRole('checkbox', { name: '스크립트를 확인했습니다' }));
      expect(apply).toBeEnabled();
      await user.click(apply);
      await waitFor(() => {
        const c = calls(fn, '/api/skill/apply')[0];
        expect(JSON.parse((c[1] as RequestInit).body as string)).toEqual({ hash: PREVIEW.hash, profile: 'default', name: 'weekly', confirm_scripts: true });
      });
      await waitFor(() => expect(screen.queryByRole('dialog', { name: '새 스킬' })).toBeNull());
      expect(await screen.findByText('스킬 폴더에 놓았습니다')).toBeInTheDocument();
    });

    it('스크립트가 없는 SKILL.md 한 장은 확인 체크 없이 바로 적용한다', async () => {
      const user = userEvent.setup();
      mountUpload({ upload: () => json({ ...PREVIEW, files: [{ path: 'SKILL.md', size: 10 }], scripts: [], only_skill_md: true }) });
      const dlg = await openNew(user);
      await user.click(within(dlg).getByRole('tab', { name: 'zip 올리기' }));
      await pick(dlg, zipFile());
      expect(await within(dlg).findByRole('button', { name: '올리고 적용' })).toBeEnabled();
      expect(within(dlg).queryByRole('checkbox')).toBeNull();
    });

    it('이름이 겹치면 이름 칸이 편집 가능해지고 고친 이름으로 적용한다', async () => {
      const user = userEvent.setup();
      const fn = mountUpload({ upload: () => json({ ...PREVIEW, conflict: true, scripts: [], only_skill_md: false }) });
      const dlg = await openNew(user);
      await user.click(within(dlg).getByRole('tab', { name: 'zip 올리기' }));
      await pick(dlg, zipFile());
      expect(await within(dlg).findByText('같은 이름의 스킬이 이미 있습니다. 다른 이름을 입력하세요.')).toBeInTheDocument();
      const nameBox = within(dlg).getByRole('textbox', { name: '스킬 이름' });
      await user.clear(nameBox);
      await user.type(nameBox, 'weekly-two');
      await user.click(within(dlg).getByRole('button', { name: '올리고 적용' }));
      await waitFor(() => expect(JSON.parse((calls(fn, '/api/skill/apply')[0][1] as RequestInit).body as string)).toMatchObject({ name: 'weekly-two' }));
    });

    it('검사 결과가 만료되면 미리 보기를 유지한 채 경고와 「다시 시도」를 보이고, 누르면 같은 파일을 다시 올린다', async () => {
      const user = userEvent.setup();
      const fn = mountUpload({ upload: () => json({ ...PREVIEW, scripts: [], only_skill_md: false }), apply: () => json({ error: '올린 파일의 검사 결과가 만료되었습니다' }, 410) });
      const dlg = await openNew(user);
      await user.click(within(dlg).getByRole('tab', { name: 'zip 올리기' }));
      await pick(dlg, zipFile());
      await user.click(await within(dlg).findByRole('button', { name: '올리고 적용' }));
      expect(await within(dlg).findByText('올린 파일의 검사 결과가 만료되었습니다')).toBeInTheDocument();
      expect(within(dlg).getByText('weekly')).toBeInTheDocument();
      await user.click(within(dlg).getByRole('button', { name: '다시 시도' }));
      await waitFor(() => expect(calls(fn, '/api/skill/upload')).toHaveLength(2));
    });
  });

  // 스펙 2026-10-26-003 T7·T14·T15: 목록이 연 스킬 서랍 안의 링크는 같은 서랍에서 열리고 주소(메뉴)는 그대로다
  it('스킬 서랍 → 스킬 연결도 → 중심 보기 → 노드의 스킬, 이전으로 차례로 돌아온다', async () => {
    const user = userEvent.setup();
    const node = (id: string, label: string, over = {}) => ({ id, kind: 'skill', label, sub: '', badges: [], depth: 0, meta: {}, ...over });
    const graph = {
      root: 'skill:default:report',
      nodes: [node('skill:default:report', 'report'), node('skill:ma:alert', 'alert', { depth: 1, link: { view: 'skills', params: { open: 'ma:alert' } } })],
      edges: [{ from: 'skill:default:report', to: 'skill:ma:alert', kind: 'calls', conf: 'code', meta: {}, evidence: [] }],
      observed: { days: 14, scope: '', runs: 0, matched: 0 },
    };
    stubApi({ '/api/skill?': ONE, '/api/market/publish': PUBLISH, '/api/skills': LIST, '/api/flow?': graph });
    mountScreen(<Skills />, '/skills');
    await user.click(await rowByName(/^report/));
    const dlg = await screen.findByRole('dialog', { name: 'report' });
    await user.click(await within(dlg).findByRole('link', { name: '스킬 연결도 보기' }));
    expect(await screen.findByRole('dialog', { name: '스킬 연결도' })).toHaveTextContent('skill:default:report');
    // 행 클릭은 주소에 open 을 쓴다(스펙 2026-10-28-014 의도한 변경). 서랍 안에서 옮겨도 주소는 그대로다
    expect(screen.getByTestId('loc')).toHaveTextContent(/^\/skills\?open=default%3Areport$/);
    const side = () => screen.getByRole('complementary', { name: '살펴보기' });
    await user.click(await screen.findByRole('button', { name: /^스킬 alert/ }));
    await user.click(await within(side()).findByRole('button', { name: '이것을 중심으로 보기' }));
    expect(await screen.findByRole('dialog', { name: '스킬 연결도' })).toHaveTextContent('skill:ma:alert');
    expect(screen.getByTestId('loc')).toHaveTextContent(/^\/skills\?open=default%3Areport$/); // 서랍 안 그림은 주소 root 를 바꾸지 않는다(T7)
    await user.click(await screen.findByRole('button', { name: /^스킬 alert/ }));
    await user.click(await within(side()).findByRole('link', { name: '스킬 화면에서 열기' }));
    expect(await screen.findByRole('dialog', { name: 'alert' })).toBeInTheDocument(); // skills{open} → 스킬 페이지(H3)
    for (const sub of ['skill:ma:alert', 'skill:default:report']) {
      await user.click(screen.getByRole('button', { name: '이전' }));
      expect(await screen.findByRole('dialog', { name: '스킬 연결도' })).toHaveTextContent(sub);
    }
    await user.click(screen.getByRole('button', { name: '이전' }));
    expect(await screen.findByRole('dialog', { name: 'report' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '이전' })).toBeDisabled();
  });

  it('내 스킬 서랍의 「지우기」: 보관한 뒤 서랍을 닫고 주소의 open 을 지운다(스펙 2026-10-29-005 DT3·DD10)', async () => {
    const user = userEvent.setup();
    const mine = { id: 'ma:profiles/ma/skills/uploaded/weekly', name: 'weekly', description: '', profile: 'ma', origin: 'local', delete_block: '', n_cron: 0, n_mcp: 0, n_rest: 0, n_scripts: 0 };
    const fn = stubApi({
      '/api/skill/delete': { ok: true },
      '/api/skill?': { ...ONE, name: 'weekly', profile: 'ma', path: 'profiles/ma/skills/uploaded/weekly', origin: 'local', cron: [] },
      '/api/market/publish': PUBLISH,
      '/api/market': { admin: true, can_install: true, installed: [] },
      '/api/skills': { ...LIST, skills: [...LIST.skills, mine] },
    });
    mountScreen(<Skills />, '/skills?open=ma:profiles/ma/skills/uploaded/weekly');
    await screen.findByRole('dialog', { name: 'weekly' });
    await user.click(await screen.findByRole('button', { name: 'weekly 스킬 지우기' }));
    const confirmDlg = await screen.findByRole('dialog', { name: 'weekly 스킬 지우기' });
    await user.click(within(confirmDlg).getByRole('button', { name: '지우기' }));
    await waitFor(() => expect(postedTo(fn, '/api/skill/delete')).toEqual([{ id: mine.id }]));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'weekly' })).toBeNull());
    expect(screen.getByTestId('loc')).not.toHaveTextContent('open=');
  });

  it('스킬 허브 스킬 서랍의 「지우기」: 요청 뒤 실제로 없어지면 「찾을 수 없음」 대신 서랍을 닫고 알린다(스펙 2026-10-29-005 T4)', async () => {
    const user = userEvent.setup();
    let asked = false;
    let reads = 0;
    const hub = { id: 'ma:profiles/ma/skills/market/cards', name: 'cards', description: '', profile: 'ma', origin: 'market', delete_block: 'origin', n_cron: 0, n_mcp: 0, n_rest: 0, n_scripts: 0 };
    const fn = stubApi({
      '/api/market/remove': () => {
        asked = true;
        return { ok: true };
      },
      '/api/skill?': { ...ONE, name: 'cards', profile: 'ma', path: 'profiles/ma/skills/market/cards', origin: 'market', cron: [] },
      '/api/market/publish': PUBLISH,
      '/api/market': { admin: true, can_install: true, install: { enabled: true }, installed: [{ profile: 'ma', name: 'cards', namespace: 'free', kind: 'skill' }] },
      // OKE 처럼 요청 직후 다시 읽을 때는 아직 남아 있고, 다음 읽기(5초 타이머)에서 사라진다
      '/api/skills': () => ({ ...LIST, skills: asked && ++reads > 1 ? LIST.skills : [...LIST.skills, hub] }),
    });
    mountScreen(<Skills />, '/skills?open=ma:profiles/ma/skills/market/cards');
    await screen.findByRole('dialog', { name: 'cards' });
    await user.click(await screen.findByRole('button', { name: 'cards 스킬 지우기' }));
    const confirmDlg = await screen.findByRole('dialog', { name: 'cards 스킬 지우기' });
    await user.click(within(confirmDlg).getByRole('button', { name: '지우기' }));
    await waitFor(() => expect(postedTo(fn, '/api/market/remove')).toEqual([{ namespace: 'free', name: 'cards', profile: 'ma' }]));
    expect(await screen.findByText('지우는 중')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'cards' })).toBeNull(), { timeout: 8000 });
    expect(screen.queryByText(/찾지 못했습니다/)).toBeNull();
    expect(await screen.findByText('cards 스킬을 지웠습니다')).toBeInTheDocument();
    expect(screen.getByTestId('loc')).not.toHaveTextContent('open=');
  }, 15000);

  it('지우기를 요청하지 않은 스킬이 목록에서 사라지면 서랍 안에 찾지 못했다고 알린다(스펙 2026-10-29-005 §7-5)', async () => {
    let gone = false;
    const hub = { id: 'ma:profiles/ma/skills/market/cards', name: 'cards', description: '', profile: 'ma', origin: 'market', delete_block: 'origin', n_cron: 0, n_mcp: 0, n_rest: 0, n_scripts: 0 };
    stubApi({
      '/api/skill?': { ...ONE, name: 'cards', profile: 'ma', path: 'profiles/ma/skills/market/cards', origin: 'market', cron: [] },
      '/api/market/publish': PUBLISH,
      '/api/market': { admin: true, can_install: true, installed: [] },
      '/api/skills': () => ({ ...LIST, skills: gone ? LIST.skills : [...LIST.skills, hub] }),
    });
    const { qc } = mountScreen(<Skills />, '/skills?open=ma:profiles/ma/skills/market/cards');
    const dlg = await screen.findByRole('dialog', { name: 'cards' });
    gone = true;
    await qc.invalidateQueries({ queryKey: ['skills'] });
    expect(await within(dlg).findByText(/cards 을\(를\) 찾지 못했습니다/)).toBeInTheDocument();
  });

  it('?open= 으로 들어오면 그 스킬의 서랍이 열린다', async () => {
    mount('/skills?open=ma:alert');
    expect(await screen.findByRole('dialog', { name: 'alert' })).toBeInTheDocument();
  });

  // 스펙 2026-10-28-014 D7: 스킬 이름 링크는 주소의 프로파일 범위를 먼저 고른다(서랍을 연 뒤 open 을 지우지 않는 것은 의도한 변경)
  it('?tab=all&profile=<프로파일>&open=<이름> 은 그 프로파일의 같은 이름 스킬을 열고, open 이 주소에 남는다', async () => {
    const dup = (profile: string) => ({ id: `${profile}:dup`, name: 'dup', description: '', profile, n_cron: 0, n_mcp: 0, n_rest: 0, n_scripts: 0 });
    const fn = stubApi({ '/api/skill?': ONE, '/api/market/publish': PUBLISH, '/api/skills': { ...LIST, skills: [dup('default'), dup('ma'), dup('ops')] } });
    mountScreen(<Skills />, '/skills?tab=all&profile=ops&open=dup');
    expect(await screen.findByRole('dialog', { name: 'dup' })).toBeInTheDocument();
    await waitFor(() => expect(fn.mock.calls.some((c) => String(c[0]) === '/api/skill?id=ops%3Adup')).toBe(true));
    expect(screen.getByTestId('loc')).toHaveTextContent('open=dup');
  });

  it('행을 누르면 주소에 open 이 생기고, 닫으면 지워진다(스펙 2026-10-28-014 D8·D9)', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await rowByName(/^report/));
    const dlg = await screen.findByRole('dialog', { name: 'report' });
    expect(screen.getByTestId('loc')).toHaveTextContent(/open=default%3Areport/);
    await user.click(within(dlg).getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByTestId('loc')).not.toHaveTextContent(/open=/);
  });

  it('새 스킬: 이름·본문을 보내 만들고 그 스킬 검색으로 간다', async () => {
    const user = userEvent.setup();
    const fn = mount();
    await user.click((await screen.findAllByRole('button', { name: '새 스킬' }))[0]);
    const dlg = await screen.findByRole('dialog', { name: '새 스킬' });
    fillBody(dlg);
    await user.type(within(dlg).getByRole('textbox', { name: /이름/ }), 'newone');
    await user.selectOptions(within(dlg).getByRole('combobox', { name: '누가 쓰나' }), 'ma');
    await user.type(within(dlg).getByRole('textbox', { name: '설명' }), '새로 만든다');
    await user.click(within(dlg).getByRole('button', { name: '스킬 만들기' }));
    await waitFor(() => {
      const c = fn.mock.calls.find((x) => String(x[0]).startsWith('/api/skill/create'))!;
      const body = JSON.parse((c[1] as RequestInit).body as string);
      expect(body).toMatchObject({ name: 'newone', profile: 'ma', category: '', description: '새로 만든다' });
      expect(body.body).toContain('# newone'); // 이름을 따라 제목이 바뀐다
      // 틀의 안내 주석과 빈 절은 지워 보낸다(2026-10-28-004)
      expect(body.body).toBe('# newone\n\n## When to Use (언제 쓰나)\n- 「주간 보고서 만들어 줘」\n');
    });
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/skills?tab=mine&profile=ma&q=newone')); // 만든 프로파일로(2026-10-27-013 §4-5)
  });

  it('만들기가 거절되면 서랍 안에 오류를 알린다', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(
          new Response(JSON.stringify(url.startsWith('/api/skill/create') ? { error: '이름이 겹칩니다' } : LIST), {
            status: url.startsWith('/api/skill/create') ? 400 : 200,
          })
        )
      )
    );
    mountScreen(<Skills />, '/skills');
    await user.click((await screen.findAllByRole('button', { name: '새 스킬' }))[0]);
    const dlg = await screen.findByRole('dialog', { name: '새 스킬' });
    fillBody(dlg);
    await user.type(within(dlg).getByRole('textbox', { name: /이름/ }), 'dup');
    await user.click(within(dlg).getByRole('button', { name: '스킬 만들기' }));
    expect(await within(dlg).findByRole('alert')).toHaveTextContent('이름이 겹칩니다');
  });

  it('새 스킬(2026-10-28-004): 틀을 채우지 않으면 보내지 않고 오류를 보인다', async () => {
    const user = userEvent.setup();
    const fn = mount();
    await user.click((await screen.findAllByRole('button', { name: '새 스킬' }))[0]);
    const dlg = await screen.findByRole('dialog', { name: '새 스킬' });
    expect((within(dlg).getByLabelText('스킬 본문') as HTMLTextAreaElement).value).toContain('## When to Use (언제 쓰나)');
    await user.type(within(dlg).getByRole('textbox', { name: /이름/ }), 'newone');
    await user.click(within(dlg).getByRole('button', { name: '스킬 만들기' }));
    expect(await within(dlg).findByRole('alert')).toHaveTextContent('본문의 「언제 쓰나」와 「절차」를 적어 주세요');
    expect(fn.mock.calls.some((x) => String(x[0]).startsWith('/api/skill/create'))).toBe(false);
  });

  it('새 스킬(2026-10-28-004 §9): 추가 정보의 관련 스킬·환경 변수·태그를 목록으로 보낸다', async () => {
    const user = userEvent.setup();
    const fn = mount();
    await user.click((await screen.findAllByRole('button', { name: '새 스킬' }))[0]);
    const dlg = await screen.findByRole('dialog', { name: '새 스킬' });
    fillBody(dlg);
    await user.type(within(dlg).getByRole('textbox', { name: /이름/ }), 'newone');
    await user.type(within(dlg).getByRole('textbox', { name: '설명' }), '새로 만든다');
    expect(within(dlg).getByRole('button', { name: '추가 정보 (선택)' })).toHaveAttribute('aria-expanded', 'true'); // 처음부터 펼쳐 있다
    await user.click(within(dlg).getByRole('combobox', { name: '관련 스킬' }));
    await user.click(await screen.findByRole('option', { name: 'report' })); // 공용 스킬도 고를 수 있다
    await user.type(within(dlg).getByRole('textbox', { name: '필요한 환경 변수' }), 'NOTION_API_KEY, SLACK_TOKEN');
    await user.type(within(dlg).getByRole('textbox', { name: '태그' }), '보고, ');
    await user.click(within(dlg).getByRole('button', { name: '스킬 만들기' }));
    await waitFor(() => {
      const c = fn.mock.calls.find((x) => String(x[0]).startsWith('/api/skill/create'))!;
      expect(JSON.parse((c[1] as RequestInit).body as string)).toMatchObject({ env: ['NOTION_API_KEY', 'SLACK_TOKEN'], tags: ['보고'], related: ['report'] });
    });
  });

  it('새 스킬(2026-10-28-004): 설명이 60자를 넘으면 글자 수를 보이고 막지는 않는다', async () => {
    const user = userEvent.setup();
    mount();
    await user.click((await screen.findAllByRole('button', { name: '새 스킬' }))[0]);
    const dlg = await screen.findByRole('dialog', { name: '새 스킬' });
    expect(within(dlg).getByText('앞 60자만 AI 에이전트의 스킬 목록에 보입니다')).toBeInTheDocument();
    fireEvent.change(within(dlg).getByRole('textbox', { name: '설명' }), { target: { value: '가'.repeat(61) } });
    expect(within(dlg).getByText('61자 — 앞 60자만 AI 에이전트의 스킬 목록에 보입니다')).toBeInTheDocument();
  });

  it('에이전트에게 맡기기는 스킬 제작 요청 글을 채워 대화 팝업을 연다', async () => {
    mount();
    const popup = watchChatPopup();
    fireEvent.click(await screen.findByRole('button', { name: 'AI 에이전트에게 맡기기' }));
    expect(popup()).toMatchObject({ kind: 'chat', agent: 'default' });
    expect((popup() as { text?: string }).text).toContain('새 스킬을 만들고 싶어.');
  });
  describe('태그(OMAI-1283)', () => {
    const TAGGED = {
      ...LIST,
      skills: LIST.skills.map((x, i) => ({ ...x, tags: [['dev-workflow', 'docs'], ['automation'], ['dev-workflow']][i] })),
    };
    const ADMIN = { auth_enabled: true, admin: true, ws: true, pod: { id: 'kim' }, user: { email: 'kim@x.com', name: 'kim' } };
    const mountTagged = (initial = '/skills', me: object = ADMIN) => {
      const fn = stubApi({ '/api/me': me, '/api/skills': TAGGED, '/api/skill?': { ...ONE, tags: ['dev-workflow', 'docs'] }, '/api/market/publish': PUBLISH });
      mountScreen(<Skills />, initial);
      return fn;
    };

    it('태그가 있으면 「태그」 열과 칩 줄(개수 포함)이 보인다', async () => {
      mountTagged();
      await screen.findByText('report');
      expect(screen.getByRole('columnheader', { name: '태그' })).toBeInTheDocument();
      const grp = screen.getByRole('group', { name: '태그로 거르기' });
      expect(within(grp).getByRole('button', { name: /^전체\s*3$/ })).toBeInTheDocument();
      expect(within(grp).getByRole('button', { name: /^개발 절차\s*2$/ })).toBeInTheDocument();
      expect(within(grp).getByRole('button', { name: /^자동화·도구\s*1$/ })).toBeInTheDocument();
    });

    it('태그를 켜면 그 태그를 가진 스킬만 남고, 둘을 켜면 둘 다 가진 것만 남는다. 주소에 담긴다', async () => {
      const user = userEvent.setup();
      mountTagged();
      await screen.findByText('report');
      const grp = screen.getByRole('group', { name: '태그로 거르기' });
      await user.click(within(grp).getByRole('button', { name: /^개발 절차/ }));
      expect(screen.queryByText('alert')).not.toBeInTheDocument();
      expect(screen.getByText('plain')).toBeInTheDocument();
      await user.click(within(grp).getByRole('button', { name: /^문서·글쓰기/ }));
      expect(screen.queryByText('plain')).not.toBeInTheDocument();
      expect(screen.getByText('report')).toBeInTheDocument();
    });

    it('주소 ?tag= 로 시작하면 켜져 있고, 다른 탭으로 가도 칩 줄과 거르기가 이어진다', async () => {
      const user = userEvent.setup();
      mountTagged('/skills?tag=dev-workflow');
      await screen.findByText('report');
      expect(screen.queryByText('alert')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^개발 절차/ })).toHaveAttribute('aria-pressed', 'true');
      await user.click(screen.getByRole('button', { name: /MCP 호출/ }));
      expect(screen.getByRole('group', { name: '태그로 거르기' })).toBeInTheDocument();
      expect(screen.getByText('report')).toBeInTheDocument();        // MCP 를 부르고 개발 절차 태그가 있는 것
      expect(screen.queryByText('alert')).not.toBeInTheDocument();    // MCP 는 부르지만 태그가 다르다
    });

    it('검색은 태그 이름도 훑는다', async () => {
      const user = userEvent.setup();
      mountTagged();
      await screen.findByText('report');
      await user.type(screen.getByRole('searchbox'), '자동화');
      expect(screen.getByText('alert')).toBeInTheDocument();
      expect(screen.queryByText('plain')).not.toBeInTheDocument();
    });

    it('서랍에 태그 줄이 있다', async () => {
      const user = userEvent.setup();
      mountTagged();
      await user.click(await screen.findByText('report'));
      const dlg = await screen.findByRole('dialog');
      expect(await within(dlg).findByText('개발 절차, 문서·글쓰기')).toBeInTheDocument();
    });

    it('태그가 없으면 열도 칩 줄도 없다. 관리자에게는 다시 매기기만 남는다', async () => {
      stubApi({ '/api/me': ADMIN, '/api/skills': LIST, '/api/market/publish': PUBLISH });
      mountScreen(<Skills />, '/skills');
      await screen.findByText('report');
      expect(screen.queryByRole('columnheader', { name: '태그' })).not.toBeInTheDocument();
      expect(screen.queryByRole('group', { name: '태그로 거르기' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'AI 태그 다시 분류' })).toBeInTheDocument();
    });

    it('「AI 태그 다시 분류」는 관리자에게만 보이고 누르면 refresh 를 부른다', async () => {
      const user = userEvent.setup();
      const fn = mountTagged();
      await user.click(await screen.findByRole('button', { name: 'AI 태그 다시 분류' }));
      await waitFor(() => expect(fn.mock.calls.some((c) => String(c[0]).startsWith('/api/market/tags/refresh'))).toBe(true));
    });

    it('관리자가 아니면 다시 매기기가 없다', async () => {
      mountTagged('/skills', { auth_enabled: true, admin: false, ws: true, pod: { id: 'kim' }, user: { email: 'kim@x.com', name: 'kim' } });
      await screen.findByText('report');
      expect(screen.queryByRole('button', { name: 'AI 태그 다시 분류' })).not.toBeInTheDocument();
    });
  });
});

// 팀 관리자(스펙 2026-10-22-001 DD5): 다루는 에이전트가 팀원 것일 때만 화면 머리에 대상 표시
describe('Skills: 팀원 에이전트 표시', () => {
  const mountMe = (pod: Record<string, unknown>) => {
    stubApi({ '/api/me': { auth_enabled: true, admin: false, user: { email: 'kim@x.com' }, pod }, '/api/skill?': ONE, '/api/market/publish': PUBLISH, '/api/skills': LIST });
    mountScreen(<Skills />, '/skills');
  };

  it('지금 에이전트가 팀원 것이면 「팀원 <주인>의 에이전트를 바꿉니다」 상태 줄이 있다', async () => {
    mountMe({ id: 'p9', owner: 'park@x.com', owner_name: '박팀원', name: '영업', team: true });
    const note = await screen.findByText('팀원 박팀원의 AI 에이전트 작업공간을 바꿉니다');
    expect(note.closest('[role="status"]')).not.toBeNull();
  });

  it('내 에이전트면 표시가 없다', async () => {
    mountMe({ id: 'p1', owner: 'kim@x.com', name: '마케팅', team: false });
    await screen.findByRole('heading', { name: '스킬' });
    expect(screen.queryByText(/에이전트를 바꿉니다/)).toBeNull();
  });
});
