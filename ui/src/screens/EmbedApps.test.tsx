/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 관리 › 임베드 앱(OMAI-1873): 목록·등록·고치기·지우기, keycloak 정책 확인 칸, 서버가 짚은 칸, 붙여 넣을 코드
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountScreen, postedTo, rowByName, stubApi } from '@/test/mountScreen';

import { claimsExample, type EmbedApp, EmbedApps, type EmbedAppsResp, hostSnippet, missingLoginClaim } from './EmbedApps';

afterEach(() => vi.unstubAllGlobals());

const PATH = '/api/admin/embed-apps';
const app = (over: Partial<EmbedApp> = {}): EmbedApp => ({
  app_id: 'emb_1',
  name: 'COP Console',
  origins: ['https://cop.example.com'],
  mode: 'keycloak',
  issuer: 'https://sso.example.com/realms/cop',
  jwks_url: 'http://keycloak:8080/realms/cop/protocol/openid-connect/certs',
  audience: 'aas-embed',
  public_jwk: '',
  default_agent: '',
  created: 1_800_000_000,
  ...over,
});
const LIST = (apps: EmbedApp[], over: Partial<EmbedAppsResp> = {}): EmbedAppsResp => ({
  apps,
  modes: ['keycloak', 'host-signed'],
  auth_enabled: true,
  ws_enabled: true,
  aas_url: 'https://aas.example.com',
  audiences: ['https://aas.example.com'],
  host_ttl_max: 300,
  agents: ['pod-a', 'pod-b'],
  ...over,
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function stub(list: () => unknown, onPost?: (b: Record<string, unknown>) => unknown) {
  return stubApi({ [PATH]: (_u: string, b: Record<string, unknown>) => (b.action ? (onPost?.(b) ?? { ok: true, app: app({ name: String(b.name ?? 'x') }) }) : list()) });
}
const saves = (fn: ReturnType<typeof stubApi>) => postedTo(fn, PATH).filter((b) => b.action === 'save');

describe('임베드 앱 관리', () => {
  it('목록에 이름·인증 모드·허용 출처를 보이고, 비면 안내, 로그인을 끈 AAS 면 경고 띠', async () => {
    stub(() => LIST([app(), app({ app_id: 'emb_2', name: '고객 포털', mode: 'host-signed', origins: ['https://portal.example.com'] })]));
    const first = mountScreen(<EmbedApps />, '/embed-apps');
    const row = await rowByName('COP Console');
    expect(within(row).getByText('Keycloak 토큰')).toBeInTheDocument();
    expect(within(row).getByText('https://cop.example.com')).toBeInTheDocument();
    expect(within(await rowByName('고객 포털')).getByText('호스트 서버 서명')).toBeInTheDocument();
    first.unmount();
    stub(() => LIST([], { auth_enabled: false }));
    mountScreen(<EmbedApps />, '/embed-apps');
    expect(await screen.findByText(/등록한 임베드 앱이 없습니다/)).toBeInTheDocument();
    expect(screen.getByText(/로그인을 꺼서 위젯이 연결하지 못합니다/)).toBeInTheDocument();
  });

  it('keycloak 모드는 호스트 realm 정책 확인 칸을 고르지 않으면 보내지 않고, 고르면 출처를 줄마다 나눠 보낸다', async () => {
    const user = userEvent.setup();
    const fn = stub(() => LIST([]));
    mountScreen(<EmbedApps />, '/embed-apps');
    await user.click(await screen.findByRole('button', { name: /새 임베드 앱/ }));
    fireEvent.change(await screen.findByRole('textbox', { name: '이름' }), { target: { value: 'COP' } });
    fireEvent.change(screen.getByRole('textbox', { name: '허용 출처' }), { target: { value: 'https://cop.example.com\nhttps://cop2.example.com' } });
    fireEvent.change(screen.getByRole('textbox', { name: '믿을 발급자(issuer)' }), { target: { value: 'https://sso.example.com/realms/cop' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'JWKS 내부 주소' }), { target: { value: 'http://kc/certs' } });
    fireEvent.change(screen.getByRole('textbox', { name: '필수 audience' }), { target: { value: 'aas-embed' } });
    await user.click(screen.getByRole('button', { name: '저장' }));
    expect(await screen.findByText('확인한 뒤 이 칸을 고르세요.')).toBeInTheDocument();
    expect(saves(fn)).toEqual([]);
    await user.click(screen.getByRole('checkbox', { name: /이메일 변경과 자가 가입을 막는지 확인했습니다/ }));
    await user.click(screen.getByRole('button', { name: '저장' }));
    await vi.waitFor(() => expect(saves(fn)).toHaveLength(1));
    expect(saves(fn)[0]).toEqual({
      action: 'save',
      name: 'COP',
      origins: ['https://cop.example.com', 'https://cop2.example.com'],
      mode: 'keycloak',
      issuer: 'https://sso.example.com/realms/cop',
      jwks_url: 'http://kc/certs',
      audience: 'aas-embed',
      idp_policy_checked: true,
      login_client_id: '',
      login_client_secret: '',
      default_agent: '',
    });
  });

  it('keycloak 칸 아래 팝업 로그인 클라이언트 ID·비밀을 받아 keycloak 모드에서만 보낸다(OMAI-1911)', async () => {
    const user = userEvent.setup();
    const fn = stub(() => LIST([app({ login_client_id: 'aas-embed-login', login_client_secret_set: true })]));
    mountScreen(<EmbedApps />, '/embed-apps');
    await user.click(await rowByName('COP Console'));
    const id = await screen.findByRole('textbox', { name: '팝업 로그인 클라이언트 ID(선택)' });
    expect(id).toHaveValue('aas-embed-login');
    const secret = screen.getByLabelText('클라이언트 비밀');
    expect(secret).toHaveAttribute('type', 'password');
    expect(secret).toHaveValue(''); // 저장된 비밀은 화면에 오지 않는다
    expect(secret).toHaveAttribute('placeholder', '등록됨 — 바꿀 때만 입력');
    await user.click(screen.getByRole('checkbox', { name: /이메일 변경과 자가 가입을 막는지 확인했습니다/ }));
    await user.click(screen.getByRole('button', { name: '저장' }));
    await vi.waitFor(() => expect(saves(fn)).toHaveLength(1));
    expect(saves(fn)[0]).toMatchObject({ login_client_id: 'aas-embed-login', login_client_secret: '' }); // 빈 비밀은 서버가 기존 값을 둔다
    await user.click(await rowByName('COP Console'));
    fireEvent.change(await screen.findByLabelText('클라이언트 비밀'), { target: { value: 's3cret' } });
    await user.click(screen.getByRole('checkbox', { name: /이메일 변경과 자가 가입을 막는지 확인했습니다/ }));
    await user.click(screen.getByRole('button', { name: '저장' }));
    await vi.waitFor(() => expect(saves(fn)).toHaveLength(2));
    expect(saves(fn)[1]).toMatchObject({ login_client_id: 'aas-embed-login', login_client_secret: 's3cret' });
  });

  it('로그인 도메인 처리를 켰는데 AAS 영역의 위젯 로그인 client 에 claim 이 오지 않았으면 경고한다(스펙 2026-11-15-005)', async () => {
    const user = userEvent.setup();
    const on = { login_alias_on: true, aas_issuer: 'https://sso.example.com/realms/cop/', login_claim_clients: ['aas'] };
    stub(() => LIST([app({ login_client_id: 'aas-embed-login' })], on));
    mountScreen(<EmbedApps />, '/embed-apps');
    await user.click(await rowByName('COP Console'));
    expect(await screen.findByTestId('embed-login-claim')).toHaveTextContent('aas-embed-login');
    const meta = LIST([], on);
    expect(missingLoginClaim(meta, 'https://sso.example.com/realms/cop', 'aas-embed-login')).toBe(true);
    expect(missingLoginClaim({ ...meta, login_claim_clients: ['aas-embed-login'] }, 'https://sso.example.com/realms/cop', 'aas-embed-login')).toBe(false);
    expect(missingLoginClaim(meta, 'https://other/realms/x', 'aas-embed-login')).toBe(false); // 다른 영역의 앱은 처리하지 않는다
    expect(missingLoginClaim({ ...meta, login_alias_on: false }, 'https://sso.example.com/realms/cop', 'aas-embed-login')).toBe(false);
    expect(missingLoginClaim(meta, 'https://sso.example.com/realms/cop', '')).toBe(false);
  });

  it('비밀이 등록되지 않은 앱은 placeholder 를 두지 않고, host-signed 모드는 로그인 칸을 보이지도 보내지도 않는다', async () => {
    const user = userEvent.setup();
    const fn = stub(() => LIST([app({ login_client_id: '', login_client_secret_set: false })]));
    mountScreen(<EmbedApps />, '/embed-apps');
    await user.click(await rowByName('COP Console'));
    expect(await screen.findByLabelText('클라이언트 비밀')).not.toHaveAttribute('placeholder', '등록됨 — 바꿀 때만 입력');
    await user.click(screen.getByRole('radio', { name: /호스트 서버 서명/ }));
    expect(screen.queryByLabelText('클라이언트 비밀')).toBeNull();
    expect(screen.queryByRole('textbox', { name: '팝업 로그인 클라이언트 ID(선택)' })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: '공개 키(JWK)' }), { target: { value: '{"kty":"RSA","n":"x","e":"AQAB"}' } });
    await user.click(screen.getByRole('button', { name: '저장' }));
    await vi.waitFor(() => expect(saves(fn)).toHaveLength(1));
    expect(saves(fn)[0]).not.toHaveProperty('login_client_id');
    expect(saves(fn)[0]).not.toHaveProperty('login_client_secret');
  });

  it('host-signed 로 바꾸면 공개 키 칸이 나오고, 서버가 짚은 칸(400 field) 아래에 오류를 보인다', async () => {
    const user = userEvent.setup();
    const fn = stub(
      () => LIST([]),
      () => json(400, { error: '개인 키가 들어 있습니다. 공개 키만 넣으세요', field: 'public_jwk' })
    );
    mountScreen(<EmbedApps />, '/embed-apps');
    await user.click(await screen.findByRole('button', { name: /새 임베드 앱/ }));
    await user.click(await screen.findByRole('radio', { name: /호스트 서버 서명/ }));
    expect(screen.queryByRole('textbox', { name: '믿을 발급자(issuer)' })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: '이름' }), { target: { value: 'Portal' } });
    fireEvent.change(screen.getByRole('textbox', { name: '허용 출처' }), { target: { value: 'https://portal.example.com' } });
    fireEvent.change(screen.getByRole('textbox', { name: '공개 키(JWK)' }), { target: { value: '{"kty":"RSA","d":"x"}' } });
    await user.click(screen.getByRole('button', { name: '저장' }));
    expect(await screen.findByText('개인 키가 들어 있습니다. 공개 키만 넣으세요')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '공개 키(JWK)' })).toHaveAttribute('aria-invalid', 'true');
    expect(saves(fn)[0]).toMatchObject({ mode: 'host-signed', public_jwk: '{"kty":"RSA","d":"x"}' });
    expect(saves(fn)[0]).not.toHaveProperty('idp_policy_checked');
    expect(screen.getByTestId('embed-claims').textContent).toContain('"aud": "https://aas.example.com"');
  });

  it('행을 누르면 고치기 서랍(app_id 를 실어 보낸다), 지우기는 확인한 뒤 보낸다', async () => {
    const user = userEvent.setup();
    const fn = stub(() => LIST([app({ default_agent: 'pod-a' })]));
    mountScreen(<EmbedApps />, '/embed-apps');
    await user.click(await rowByName('COP Console'));
    expect(await screen.findByText('emb_1')).toBeInTheDocument();
    expect(screen.getByTestId('embed-code').textContent).toContain("var AAS_URL = 'https://aas.example.com';");
    await user.click(screen.getByRole('checkbox', { name: /이메일 변경과 자가 가입을 막는지 확인했습니다/ }));
    await user.click(screen.getByRole('button', { name: '저장' }));
    await vi.waitFor(() => expect(saves(fn)).toHaveLength(1));
    expect(saves(fn)[0]).toMatchObject({ app_id: 'emb_1', default_agent: 'pod-a', origins: ['https://cop.example.com'] });
    await user.click(await rowByName('COP Console'));
    await user.click(await screen.findByRole('button', { name: '지우기' }));
    const dialog = await screen.findByRole('dialog', { name: /「COP Console」을\(를\) 지울까요/ });
    await user.click(within(dialog).getByRole('button', { name: '지우기' }));
    await vi.waitFor(() => expect(postedTo(fn, PATH).filter((b) => b.action === 'remove')).toEqual([{ action: 'remove', app_id: 'emb_1' }]));
  });
});

describe('붙여 넣을 코드', () => {
  it('위젯 파일은 AAS 서버의 /static/js/aas-widget.js 에서 불러 init, 모드별 신원 값, HTML 에 그대로 넣는 일반 script', () => {
    const kc = hostSnippet('https://aas.corp/', 'keycloak');
    expect(kc).toContain("var AAS_URL = 'https://aas.corp';"); // 끝의 / 는 뗀다
    expect(kc).toContain("script.src = AAS_URL + '/static/js/aas-widget.js';");
    expect(kc).not.toContain('/cogentai/aas-widget.js');
    expect(kc).toContain('window.aasWidget = window.CogentAIAASWidget.init({');
    expect(kc).toContain('backendUrl: AAS_URL,');
    expect(kc).toContain("accessTokenCookie: 'COGENTAI_TOKEN'");
    // 일반 <script> 에 붙여도 문법 오류가 없도록 TypeScript 꼴·최상위 await·화살표 함수를 쓰지 않는다
    expect(kc.startsWith('<script>') && kc.endsWith('</script>')).toBe(true);
    for (const bad of ['Promise<void>', 'await ', '=>', ': string']) expect(kc).not.toContain(bad);
    const body = kc.replace(/^<script>|<\/script>$/g, '');
    expect(() => new Function(body)).not.toThrow();
    const hs = hostSnippet('', 'host-signed');
    expect(hs).toContain('getAccessToken: function () {');
    expect(hs).toContain("return r.ok ? r.text() : '';"); // 실패 응답(로그인 페이지 HTML)을 토큰으로 넘기지 않는다
    expect(hs).not.toContain('accessToken: hostSignedJwt'); // 한 장을 다시 쓰면 약 14분 뒤 끊긴다
    expect(() => new Function(hs.replace(/^<script>|<\/script>$/g, ''))).not.toThrow();
    expect(JSON.parse(claimsExample('emb_1', 'https://aas.corp'))).toMatchObject({ iss: 'emb_1', aud: 'https://aas.corp' });
  });
});
