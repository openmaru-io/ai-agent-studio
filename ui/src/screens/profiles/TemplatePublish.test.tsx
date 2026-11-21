/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { mountScreen, postedTo, stubApi } from '@/test/mountScreen';

import { TemplatePublish } from './TemplatePublish';
import { choicesAfterToggle, zoneDefault } from './templatePublishState';

const PREVIEW = (over: Record<string, unknown> = {}) => ({
  status: 'preview',
  name: 'sales',
  version: '1.0.0',
  namespace: 'paid',
  update: false,
  from_version: '',
  items: {
    skills: [{ id: 'skills/local/proposal', label: 'proposal', included: true, origin: 'local' }],
    mcp: [
      { id: 'jira', label: 'jira', included: true, stdio: false },
      { id: 'fs', label: 'fs', included: true, stdio: true },
    ],
    cron: [],
  },
  env_requires: [{ name: 'JIRA_TOKEN', description: '', required: true, used_by: ['mcp:jira'] }],
  hub_skills: [],
  errors: [],
  warnings: [],
  stdio: [{ name: 'fs' }],
  model_hint: 'm',
  soul: '나는 영업 도우미',
  files: [],
  limit: 10,
  used: 0,
  ...over,
});
const MINE = { items: [], limit: 10, used: 0, namespaces: ['free', 'paid'], namespace_labels: { free: '공용', paid: '제한' }, public: ['free'] };

describe('templatePublishState', () => {
  it('기본 구역은 제한 구역이다', () => {
    expect(zoneDefault(['free', 'paid'], ['free'])).toBe('paid');
    expect(zoneDefault(['free'], ['free'])).toBe('free');
  });
  it('처음 끄면 미리 보기의 담긴 것에서 하나를 뺀다', () => {
    const items = PREVIEW().items;
    expect(choicesAfterToggle(null, items, 'mcp', 'fs')).toEqual({ skills: ['skills/local/proposal'], mcp: ['jira'], cron: [] });
    expect(choicesAfterToggle({ skills: [], mcp: ['jira'], cron: [] }, items, 'mcp', 'fs').mcp).toEqual(['jira', 'fs']);
  });
});

describe('TemplatePublish', () => {
  afterEach(cleanup);

  it('제한 구역이 기본이고, 막는 오류가 있으면 올리기를 끄며, 담을 것을 빼면 다시 검사한다', async () => {
    const api = stubApi({
      '/api/market/templates/mine': MINE,
      '/api/market/template/publish': (_u: string, b: Record<string, unknown>) =>
        (b.choices as { mcp?: string[] } | undefined)?.mcp?.includes('fs') === false
          ? PREVIEW()
          : PREVIEW({ errors: b.namespace === 'free' ? [{ code: 'stdio_public', message: '공용 구역에는 명령 MCP 를 담을 수 없습니다' }] : [] }),
    });
    mountScreen(<TemplatePublish profile="sales" />, '/');
    const member = await screen.findByRole('radio', { name: /제한 구역 — 관리자가 허용한/ });
    await waitFor(() => expect((member as HTMLInputElement).checked).toBe(true));
    fireEvent.change(screen.getByLabelText('설명'), { target: { value: '영업 제안서와 견적을 돕는 프로파일입니다' } });
    expect(await screen.findByLabelText('JIRA_TOKEN 설명', {}, { timeout: 3000 })).toBeTruthy();
    expect(postedTo(api, '/api/market/template/publish').every((b) => b.dry_run === true)).toBe(true);
    const publish = screen.getByRole('button', { name: '올리기' }) as HTMLButtonElement;
    await waitFor(() => expect(publish.disabled).toBe(false));

    fireEvent.click(screen.getByRole('radio', { name: /공용 구역 — 모든/ }));
    expect(await screen.findByText('공용 구역에는 명령 MCP 를 담을 수 없습니다', {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByText(/AAS 밖에서도 누구나 봅니다/)).toBeTruthy();
    await waitFor(() => expect((screen.getByRole('button', { name: '올리기' }) as HTMLButtonElement).disabled).toBe(true));

    fireEvent.click(screen.getByRole('checkbox', { name: /fs/ }));
    await waitFor(() => expect(screen.queryByText('공용 구역에는 명령 MCP 를 담을 수 없습니다')).toBeNull(), { timeout: 3000 });
    const last = postedTo(api, '/api/market/template/publish').at(-1);
    expect(last).toMatchObject({ namespace: 'free', choices: { mcp: ['jira'] }, dry_run: true });
  });

  it('「내가 올린」 목록에서 허브에서 내린 템플릿은 「내림」만 보이고 「내리기」를 두지 않는다', async () => {
    stubApi({
      '/api/market/templates/mine': {
        ...MINE,
        items: [
          { id: '1', name: 'live-one', version: '1.0.0', namespace: 'paid', status: 'published', ts: '', profile: 'a' },
          { id: '2', name: 'old-one', version: '1.0.1', namespace: 'paid', status: 'hidden', ts: '', profile: 'a' },
        ],
      },
      '/api/market/template/publish': PREVIEW(),
    });
    mountScreen(<TemplatePublish profile="sales" />, '/');
    const live = (await screen.findByText(/live-one 1.0.0/)).closest('li') as HTMLElement;
    const old = screen.getByText(/old-one 1.0.1/).closest('li') as HTMLElement;
    expect(within(live).getByRole('button', { name: '내리기' })).toBeTruthy();
    expect(within(old).queryByRole('button', { name: '내리기' })).toBeNull();
    expect(within(old).getByText('내림')).toBeTruthy();
  });

  it('KEY 마다 받는 사람에게 보일 설명을 적으면 key_notes 로 보낸다', async () => {
    const api = stubApi({ '/api/market/templates/mine': MINE, '/api/market/template/publish': PREVIEW() });
    mountScreen(<TemplatePublish profile="sales" />, '/');
    fireEvent.change(await screen.findByLabelText('설명'), { target: { value: '영업 제안서와 견적을 돕는 프로파일입니다' } });
    const note = await screen.findByLabelText('JIRA_TOKEN 설명', {}, { timeout: 3000 });
    fireEvent.change(note, { target: { value: 'Jira 프로필 › 보안 › API 토큰에서 발급' } });
    await waitFor(
      () => expect(postedTo(api, '/api/market/template/publish').at(-1)).toMatchObject({ key_notes: { JIRA_TOKEN: 'Jira 프로필 › 보안 › API 토큰에서 발급' } }),
      { timeout: 3000 }
    );
  });

  it('공용 구역의 사내 주소는 확인 칸을 체크하면 경고로 바뀌어 올릴 수 있다(스펙 2026-11-18-010)', async () => {
    const api = stubApi({
      '/api/market/templates/mine': MINE,
      '/api/market/template/publish': (_u: string, b: Record<string, unknown>) =>
        b.namespace !== 'free'
          ? PREVIEW()
          : b.allow_internal === true
            ? PREVIEW({ warnings: [{ code: 'internal_ref_ok', message: '사내 주소·사설 IP 가 있지만 확인하고 올립니다: agent/config.yaml:20' }] })
            : PREVIEW({ errors: [{ code: 'internal_ref', message: '사내 주소·사설 IP 가 있어 공용 구역에 올릴 수 없습니다: agent/config.yaml:20' }] }),
    });
    mountScreen(<TemplatePublish profile="sales" />, '/');
    await screen.findByRole('radio', { name: /제한 구역/ });
    fireEvent.change(screen.getByLabelText('설명'), { target: { value: '영업 제안서와 견적을 돕는 프로파일입니다' } });
    await screen.findByLabelText('JIRA_TOKEN 설명', {}, { timeout: 3000 });
    expect(screen.queryByRole('checkbox', { name: /사내 주소·사설 IP 가 있어도 올립니다/ })).toBeNull();     // 오류가 없으면 칸도 없다
    fireEvent.click(screen.getByRole('radio', { name: /공용 구역 — 모든/ }));
    const ask = await screen.findByRole('checkbox', { name: /사내 주소·사설 IP 가 있어도 올립니다/ }, { timeout: 3000 });
    await waitFor(() => expect((screen.getByRole('button', { name: '올리기' }) as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(ask);
    expect(await screen.findByText(/확인하고 올립니다/, {}, { timeout: 3000 })).toBeTruthy();
    await waitFor(() => expect((screen.getByRole('button', { name: '올리기' }) as HTMLButtonElement).disabled).toBe(false));
    expect(postedTo(api, '/api/market/template/publish').at(-1)).toMatchObject({ namespace: 'free', allow_internal: true, dry_run: true });
  });

  it('올리면 결과와 내가 올린 템플릿을 보인다', async () => {
    let published = false;
    stubApi({
      '/api/market/templates/mine': () => (published ? { ...MINE, items: [{ id: 'r', name: 'sales', version: '1.0.0', namespace: 'paid', status: 'published', ts: '', profile: 'sales' }] } : MINE),
      '/api/market/template/publish': (_u: string, b: Record<string, unknown>) => {
        if (b.dry_run) return PREVIEW();
        published = true;
        return PREVIEW({ status: 'published' });
      },
    });
    mountScreen(<TemplatePublish profile="sales" />, '/');
    await screen.findByRole('radio', { name: /제한 구역/ });
    fireEvent.change(screen.getByLabelText('설명'), { target: { value: '영업 제안서와 견적을 돕는 프로파일입니다' } });
    await screen.findByLabelText('JIRA_TOKEN 설명', {}, { timeout: 3000 });
    const publish = screen.getByRole('button', { name: '올리기' }) as HTMLButtonElement;
    await waitFor(() => expect(publish.disabled).toBe(false));
    fireEvent.click(publish);
    expect(await screen.findByText('AI 에이전트 템플릿 sales 1.0.0 을 올렸습니다.')).toBeTruthy();
    expect(await screen.findByRole('button', { name: '내리기' })).toBeTruthy();
  });

  it('글이 아닌 참고 파일은 파일마다 확인해야 올리기가 켜진다', async () => {
    const api = stubApi({
      '/api/market/templates/mine': MINE,
      '/api/market/template/files': { items: [{ path: '양식/견적서.xlsx', size: 4096 }, { path: '안내.md', size: 100 }], max_files: 30, max_bytes: 10485760 },
      '/api/market/template/publish': (_u: string, b: Record<string, unknown>) => {
        const files = (b.files as { path: string; confirmed: boolean }[]) ?? [];
        const x = files.find((f) => f.path === '양식/견적서.xlsx');
        return PREVIEW({
          needs_confirmation: x && !x.confirmed ? ['양식/견적서.xlsx'] : [],
          items: { ...PREVIEW().items, files: x?.confirmed ? [{ id: '양식/견적서.xlsx', label: '양식/견적서.xlsx', included: true, text: false, confirmed: true, size: 4096 }] : [] },
        });
      },
    });
    mountScreen(<TemplatePublish profile="sales" />, '/');
    await screen.findByRole('radio', { name: /제한 구역/ });
    fireEvent.change(screen.getByLabelText('설명'), { target: { value: '영업 제안서와 견적을 돕는 프로파일입니다' } });
    await screen.findByLabelText('JIRA_TOKEN 설명', {}, { timeout: 3000 });
    fireEvent.click(await screen.findByRole('checkbox', { name: /양식\/견적서.xlsx/ }));
    const confirmBox = await screen.findByRole('checkbox', { name: '이 파일에 개인정보·고객 자료가 없음을 확인했습니다' }, { timeout: 3000 });
    await waitFor(() => expect((screen.getByRole('button', { name: '올리기' }) as HTMLButtonElement).disabled).toBe(true));
    expect(screen.queryByRole('button', { name: /모두 확인/ })).toBeNull();
    fireEvent.click(confirmBox);
    await waitFor(() => expect((screen.getByRole('button', { name: '올리기' }) as HTMLButtonElement).disabled).toBe(false), { timeout: 3000 });
    expect(postedTo(api, '/api/market/template/publish').at(-1)).toMatchObject({ files: [{ path: '양식/견적서.xlsx', confirmed: true }] });
  });
});
