/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { t } from '@/i18n';
import { mountScreen } from '@/test/mountScreen';

import { CredentialFiles, type CredList, fmtWhen, MAX_BYTES, normalizeName, pickProblem, reasonText } from './CredentialFiles';

afterEach(() => vi.unstubAllGlobals());

const ROWS: CredList['rows'] = [
  { slot: 'google_client_secret', path: 'google_client_secret.json', exists: false },
  {
    slot: 'google_token',
    path: 'google_token.json',
    exists: true,
    type: 'file',
    mtime: 1_761_200_000,
    changed_by: { name: '김민수', who: 'kim@x.com', role: 'team', ts: 't' },
    by_other: true,
    outside_after: true,
  },
  { slot: 'secret:omdm', path: 'secrets/omdm.json', exists: true, type: 'file', mtime: 1_761_200_000, changed_by: null, outside: true },
  { slot: '', path: 'secrets/Bad.json', exists: true, type: 'unknown' },
];
const LIST = (over: Partial<CredList> = {}): CredList => ({ rows: ROWS, reason: '', can_edit: true, admin: false, ...over });

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
function stub(list: () => CredList, write?: Handler) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.startsWith('/api/profile/credential-files')) return Promise.resolve(new Response(JSON.stringify(list()), { status: 200 }));
    if (url.startsWith('/api/profile/credential-file') && write) return Promise.resolve(write(url, init));
    if (url.split('?')[0] === '/api/me') return Promise.resolve(new Response(JSON.stringify({ auth_enabled: false, admin: true }), { status: 200 }));
    return Promise.resolve(new Response('{}', { status: 404 }));
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

const jsonFile = (name = 'client_secret_1.json', body = '{"installed": {}}') => new File([body], name, { type: 'application/json' });

describe('도우미', () => {
  it('새 파일 이름은 .json 을 떼고 소문자로, 규칙에 안 맞으면 null(D17)', () => {
    expect(normalizeName(' OMDM.json ')).toBe('omdm');
    expect(normalizeName('my_conf-1')).toBe('my_conf-1');
    for (const bad of ['', 'a.b', '한글', 'a b', '-a', 'a'.repeat(64)]) expect(normalizeName(bad), bad).toBeNull();
  });
  it('고른 파일 검사: .json 만, 64KB 이하, 빈 파일 거절', () => {
    expect(pickProblem({ name: 'a.json', size: 10 })).toBe('');
    expect(pickProblem({ name: 'a.txt', size: 10 })).toBe('not_json_file');
    expect(pickProblem({ name: 'a.json', size: MAX_BYTES + 1 })).toBe('too_large');
    expect(pickProblem({ name: 'a.json', size: 0 })).toBe('empty');
  });
  it('시각은 올해면 MM-DD HH:mm, 아니면 연도를 붙인다(D18)', () => {
    const now = new Date(2026, 9, 23, 12, 0);
    expect(fmtWhen(new Date(2026, 9, 23, 14, 2).getTime() / 1000, now)).toBe('10-23 14:02');
    expect(fmtWhen(new Date(2025, 0, 2, 3, 4).getTime() / 1000, now)).toBe('2025-01-02 03:04');
  });
  it('사유 문구는 역할별이다(D19)', () => {
    expect(reasonText('operator_outdated', true)).toBe(t('profiles.cred.why.operator_outdatedAdmin'));
    expect(reasonText('operator_outdated', false)).toBe(t('profiles.cred.why.unavailable'));
    expect(reasonText('grant', false)).toBe(t('profiles.cred.why.grant'));
    expect(reasonText('', true)).toBe('');
  });
});

describe('인증 파일 구역(스펙 2026-10-22-004 §4-7)', () => {
  it('목록: 칸 설명·태그·바꾼 사람·화면 밖 변경, 알 수 없는 항목은 버튼이 없다', async () => {
    stub(() => LIST());
    mountScreen(<CredentialFiles pod="p1" profile="ma" />, '/profiles?name=ma&pane=env');
    expect(await screen.findByText('google_token.json')).toBeInTheDocument();
    expect(screen.getByText(t('profiles.cred.desc.googleClientSecret'))).toBeInTheDocument();
    expect(screen.getByText(t('profiles.cred.byOther'))).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`김민수 \\(${t('profiles.cred.roleTeam')}\\) · ${t('profiles.cred.outsideAfter')}`))).toBeInTheDocument();
    expect(screen.queryByText(/kim@x\.com/)).not.toBeInTheDocument();   // 이메일은 글자로 보이지 않고 title 에만
    expect(screen.getByText(new RegExp('\\d{2}:\\d{2} · ' + t('profiles.cred.outside') + '$'))).toBeInTheDocument();
    expect(screen.getByText(t('profiles.cred.unknown'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('profiles.cred.uploadOf', { path: 'google_client_secret.json' }) })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('profiles.cred.replaceOf', { path: 'secrets/Bad.json' }) })).not.toBeInTheDocument();
    expect(screen.queryByText('auth.json')).not.toBeInTheDocument();
  });

  it('불러오는 중에는 Skeleton, 실패하면 다시 읽기', async () => {
    let fail = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(fail ? new Response('{"code":"sidecar_unreachable"}', { status: 502 }) : new Response(JSON.stringify(LIST()), { status: 200 }))),
    );
    mountScreen(<CredentialFiles pod="p1" profile="ma" />, '/profiles?name=ma&pane=env');
    expect(screen.getByTestId('cred-loading')).toBeInTheDocument();
    expect(await screen.findByText(t('profiles.cred.listFailed'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('profiles.cred.uploadOf', { path: 'google_client_secret.json' }) })).not.toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: t('profiles.cred.reload') }));
    expect(await screen.findByText('google_token.json')).toBeInTheDocument();
  });

  it('바꿀 수 없으면 줄은 보이고 버튼은 없으며 사유 한 줄', async () => {
    stub(() => LIST({ reason: 'operator_outdated', can_edit: false, admin: true }));
    mountScreen(<CredentialFiles pod="p1" profile="ma" />, '/profiles?name=ma&pane=env');
    expect(await screen.findByText(t('profiles.cred.why.operator_outdatedAdmin'))).toBeInTheDocument();
    expect(screen.getByText('google_token.json')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /google_token.json/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('profiles.cred.newButton') })).not.toBeInTheDocument();
  });

  it('고르면 이름·크기만 보이고 [저장]을 눌러야 보낸다. 성공하면 다음 단계 안내', async () => {
    const calls = stub(() => LIST(), () => new Response('{"ok":true,"mtime_ns":5}', { status: 200 }));
    mountScreen(<CredentialFiles pod="p1" profile="ma" />, '/profiles?name=ma&pane=env');
    await screen.findByText('google_client_secret.json');
    fireEvent.change(screen.getByTestId('cred-file-google_client_secret.json'), { target: { files: [jsonFile()] } });
    expect(screen.getByText(/선택: client_secret_1.json · 17 B|Selected: client_secret_1.json · 17 B/)).toBeInTheDocument();
    expect(calls.filter((c) => c.init?.method === 'PUT')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: t('profiles.cred.save') }));
    expect(await screen.findByText(t('profiles.cred.savedNextGoogle'))).toBeInTheDocument();
    const put = calls.find((c) => c.init?.method === 'PUT');
    expect(put?.url).toContain('slot=google_client_secret');
    expect((put?.init?.headers as Record<string, string>)['X-AAS']).toBe('1');
  });

  it('이미 있는 파일을 바꾸면 「되살릴 수 없습니다」를 함께 보인다', async () => {
    stub(() => LIST());
    mountScreen(<CredentialFiles pod="p1" profile="ma" />, '/profiles?name=ma&pane=env');
    await screen.findByText('google_token.json');
    fireEvent.change(screen.getByTestId('cred-file-google_token.json'), { target: { files: [jsonFile('t.json', '{}')] } });
    expect(screen.getByText(t('profiles.cred.noUndo'))).toBeInTheDocument();
  });

  it('64KB 넘거나 .json 이 아니면 보내기 전에 그 줄 아래 오류', async () => {
    const calls = stub(() => LIST());
    mountScreen(<CredentialFiles pod="p1" profile="ma" />, '/profiles?name=ma&pane=env');
    await screen.findByText('google_client_secret.json');
    fireEvent.change(screen.getByTestId('cred-file-google_client_secret.json'), { target: { files: [jsonFile('x.json', 'x'.repeat(MAX_BYTES + 1))] } });
    expect(await screen.findByRole('alert')).toHaveTextContent(t('profiles.cred.err.too_large'));
    expect(calls.filter((c) => c.init?.method === 'PUT')).toHaveLength(0);
  });

  it('서버 오류는 그 줄 아래 role=alert, PC 가져오기 중이면 그 문구', async () => {
    stub(() => LIST(), () => new Response('{"code":"busy_import"}', { status: 409 }));
    mountScreen(<CredentialFiles pod="p1" profile="ma" />, '/profiles?name=ma&pane=env');
    await screen.findByText('google_client_secret.json');
    fireEvent.change(screen.getByTestId('cred-file-google_client_secret.json'), { target: { files: [jsonFile()] } });
    fireEvent.click(screen.getByRole('button', { name: t('profiles.cred.save') }));
    expect(await screen.findByRole('alert')).toHaveTextContent(t('profiles.cred.err.busy_import'));
  });

  it('시간 초과면 「결과를 아직 모릅니다」와 다시 확인 → 바뀌었으면 저장됨', async () => {
    let mtime = 1_761_200_000;
    stub(
      () => LIST({ rows: ROWS.map((r) => (r.path === 'google_token.json' ? { ...r, mtime } : r)) }),
      () => new Response('{"code":"timeout"}', { status: 504 }),
    );
    mountScreen(<CredentialFiles pod="p1" profile="ma" />, '/profiles?name=ma&pane=env');
    await screen.findByText('google_token.json');
    fireEvent.change(screen.getByTestId('cred-file-google_token.json'), { target: { files: [jsonFile('t.json', '{}')] } });
    fireEvent.click(screen.getByRole('button', { name: t('profiles.cred.save') }));
    expect(await screen.findByText(t('profiles.cred.err.timeout'))).toBeInTheDocument();
    mtime += 10;
    fireEvent.click(screen.getByRole('button', { name: t('profiles.cred.recheck') }));
    expect(await screen.findByText(t('profiles.cred.recheckSaved'))).toBeInTheDocument();
  });

  it('지우기는 경로를 그대로 적어야 누를 수 있고 「되살릴 수 없습니다」를 보인다', async () => {
    const calls = stub(() => LIST(), () => new Response('{"ok":true}', { status: 200 }));
    mountScreen(<CredentialFiles pod="p1" profile="ma" />, '/profiles?name=ma&pane=env');
    await screen.findByText('secrets/omdm.json');
    fireEvent.click(screen.getByRole('button', { name: t('profiles.cred.clearOf', { path: 'secrets/omdm.json' }) }));
    expect(screen.getByText(t('profiles.cred.noUndoClear'))).toBeInTheDocument();
    const go = screen.getAllByRole('button', { name: t('profiles.cred.clear') }).at(-1) as HTMLElement;
    expect(go).toBeDisabled();
    fireEvent.change(screen.getByLabelText(t('profiles.cred.clearTypePath')), { target: { value: 'omdm.json' } });
    expect(go).toBeDisabled();
    fireEvent.change(screen.getByLabelText(t('profiles.cred.clearTypePath')), { target: { value: 'secrets/omdm.json' } });
    fireEvent.click(go);
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'DELETE')).toBe(true));
    expect(calls.find((c) => c.init?.method === 'DELETE')?.url).toContain('confirm=secrets%2Fomdm.json');
  });

  it('새 JSON 파일: 이름을 바꿔 미리 보이고, 이미 있는 이름이면 바꾸기 확인이 된다', async () => {
    stub(() => LIST());
    mountScreen(<CredentialFiles pod="p1" profile="ma" />, '/profiles?name=ma&pane=env');
    await screen.findByText('google_token.json');
    const box = screen.getByLabelText(t('profiles.cred.newLabel'));
    fireEvent.change(box, { target: { value: 'a.b' } });
    expect(screen.getByText(t('profiles.cred.newRule'))).toBeInTheDocument();
    fireEvent.change(box, { target: { value: 'OMDM.json' } });
    expect(screen.getByText(t('profiles.cred.newPreview', { path: 'secrets/omdm.json' }))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t('profiles.cred.newButton') }));
    fireEvent.change(screen.getAllByTestId('cred-file-secrets/omdm.json').at(-1) as HTMLElement, { target: { files: [jsonFile('o.json', '[1]')] } });
    expect(screen.getByText(t('profiles.cred.noUndo'))).toBeInTheDocument();
  });

  it('?file= 로 열면 그 줄의 첫 버튼에 포커스(D12)', async () => {
    stub(() => LIST());
    mountScreen(<CredentialFiles pod="p1" profile="ma" />, '/profiles?name=ma&pane=env&file=google_token.json');
    const btn = await screen.findByRole('button', { name: t('profiles.cred.replaceOf', { path: 'google_token.json' }) });
    await waitFor(() => expect(btn).toHaveFocus());
  });
});
