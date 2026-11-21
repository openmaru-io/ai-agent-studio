/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 호스트 개발자가 서버 로그를 보지 않고 원인을 알 수 있게, 위젯의 오류는 모두 콘솔에 한 줄로 낸다(OMAI-1873).
// 형식: [CogentAIAASWidget] <코드> <설명>. 설명은 개발자용이라 영어 한 문장이다.

export type ErrorCode =
  | 'origin_not_registered'
  | 'token_invalid'
  | 'token_mismatch'
  | 'user_unknown'
  | 'idp_unreachable'
  | 'cert_required'
  | 'mixed_content'
  | 'rate_limited'
  | 'version_mismatch'
  | 'ws_unsupported'
  | 'unreachable'
  | 'auth_disabled'
  | 'login_callback_failed'
  | 'login_callback_timeout'
  | 'login_popup_blocked'
  | 'login_expired'
  | 'no_agent'
  | 'internal_error';

const TEXT: Record<ErrorCode, string> = {
  origin_not_registered: 'this page origin is not registered as an AAS embed app',
  token_invalid: 'the host token is missing, expired or failed verification; sign in to the host page again',
  token_mismatch: 'the host token does not match the embed app settings (signature, iss, aud, key or token rules); signing in again does not help, fix the host or the embed app',
  user_unknown: 'the signed-in user is not an AAS user (or not in the AAS user group)',
  idp_unreachable: 'AAS cannot reach the identity provider (JWKS) of this embed app',
  cert_required: 'the browser does not trust the AAS certificate; accept it in the setup window',
  mixed_content: 'an https page cannot call an http backendUrl; use https for AAS',
  rate_limited: 'AAS rejected the request because of the request limit (429)',
  version_mismatch: 'this widget version is outside the protocol range AAS accepts; update the widget file on the host',
  ws_unsupported: 'this AAS has WebSocket disabled; the widget needs WebSocket',
  unreachable: 'AAS did not answer (CORS preflight failed or the network is down); check backendUrl and the embed app settings',
  auth_disabled: 'this AAS has sign-in disabled, so it does not accept embed widgets',
  login_callback_failed: 'the host onLoginRequired callback threw or rejected; the widget tried the exchange again anyway',
  login_callback_timeout: 'the Promise from onLoginRequired did not settle in time; the widget tried the exchange again',
  login_popup_blocked: 'the browser did not open the AAS sign-in window (pop-up blocked); allow pop-ups for this page and press Sign in again',
  login_expired: 'sign-in in the AAS pop-up window did not finish within 5 minutes; press Sign in again. If the window showed the retry message, the host page or the identity provider may send Cross-Origin-Opener-Policy: same-origin',
  no_agent: 'the signed-in user has no main AI agent in AAS; pick one in AAS first',
  internal_error: 'the widget hit an unexpected error while handling a failed connection; try again',
};

export const PREFIX = '[CogentAIAASWidget]';

export function logError(code: ErrorCode, detail?: string): void {
  console.error(`${PREFIX} ${code} ${TEXT[code]}${detail ? ` (${detail})` : ''}`);
}
