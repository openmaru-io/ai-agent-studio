/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';

import en from '@/i18n/en/profiles';
import ko from '@/i18n/ko/profiles';

import { accountView, autoReasonText, reasonText } from './MindwikiAccount';

// 서버 aas/ops/mindwiki_connect.py 의 REASONS 와 같아야 한다(test_mindwiki_reasons_match_ui 가 반대쪽을 본다)
const REASONS = ['iss_or_client_rejected', 'no_workspace', 'need_workspace', 'token_limit', 'token_request_rejected', 'write_disabled', 'daily_limit', 'guest',
  'account_disabled', 'connector_scope', 'no_refresh_token', 'session_ended', 'keycloak_unavailable', 'timeout', 'mindwiki_5xx', 'tls',
  'forbidden', 'hermes_not_ready', 'hermes_reload', 'lease_busy', 'expired', 'internal', 'idp_token_rejected', 'internal_error'];

describe('MindWiki 계정으로 연결 상태 줄(스펙 2026-11-14-001 2단계)', () => {
  it('상태마다 문구와 버튼', () => {
    const base = { enabled: true, tool_count: 18, expires_at: '2027-02-12T00:00:00+00:00' };
    expect(accountView({ ...base, status: 'connected' })).toMatchObject({ tone: 'success', text: '연결됨 · 읽기 전용 · 도구 18개 · 2027-02-12 까지', button: '다시 연결' });
    expect(accountView({ ...base, status: 'soon', write: true }).text).toMatch(/쓰기 .* 곧 만료/);
    expect(accountView({ ...base, status: 'pending' })).toMatchObject({ busy: true, text: 'MindWiki 에 연결하는 중…' });
    expect(accountView({ ...base, status: 'failed', reason: 'daily_limit' }).button).toBe('MindWiki 계정으로 연결');
    expect(accountView({ ...base, status: 'failed', reason: 'daily_limit', connected: true }).button).toBe('다시 연결');
    expect(reasonText({ reason: 'token_limit', detail: ['AAS a main', 'AAS a ops'] })).toMatch(/\(AAS a main, AAS a ops\)$/);
  });

  it('이유 코드마다 ko·en 문구가 있다', () => {
    for (const code of REASONS) {
      expect((ko as Record<string, string>)[`profiles.mcp.mindwikiReason.${code}`], code).toBeTruthy();
      expect((en as Record<string, string>)[`profiles.mcp.mindwikiReason.${code}`], code).toBeTruthy();
    }
  });
});

describe('MindWiki 상태 줄 순위(스펙 2026-11-14-012 3-4)', () => {
  const NOW = Date.parse('2026-12-01T00:00:00Z');
  const base = { enabled: true, tool_count: 18, status: 'connected' as const, connected: true, expires_at: '2027-02-12T00:00:00+00:00' };
  it('순위 0~6', () => {
    expect(accountView({ ...base, expires_at: '2026-11-30T00:00:00+00:00' }, NOW)).toMatchObject({ rank: 0, tone: 'error' });
    expect(accountView({ ...base, needs_apply: true, prev_expires_at: '2026-11-30T00:00:00+00:00' }, NOW)).toMatchObject({ rank: 0, apply: true });
    expect(accountView({ ...base, status: 'revoked', connected: false }, NOW)).toMatchObject({ rank: 1, text: 'MindWiki 설정에서 이 연결의 토큰이 지워졌습니다.' });
    expect(accountView({ ...base, needs_apply: true, prev_expires_at: '2026-12-11T00:00:00+00:00' }, NOW)).toMatchObject({ rank: 2, apply: true });
    expect(accountView({ ...base, needs_apply: true, prev_expires_at: '2026-12-11T00:00:00+00:00' }, NOW).text).toContain('2026-12-11(10일 뒤)');
    expect(accountView({ ...base, needs_apply: true }, NOW)).toMatchObject({ rank: 3, apply: true });
    expect(accountView({ ...base, auto_reason: 'daily_limit', next_check_at: '2026-12-01T03:00:00Z' }, NOW)).toMatchObject({ rank: 4, tone: 'warning' });
    expect(accountView({ ...base, expires_at: '2026-12-10T00:00:00+00:00' }, NOW)).toMatchObject({ rank: 5 });
    expect(accountView(base, NOW)).toMatchObject({ rank: 6, tone: 'success' });
  });
  it('겹치면 앞 순위, 지금 적용이 아니면 예전 키 기한으로 곧 만료를 내지 않는다', () => {
    expect(accountView({ ...base, needs_apply: true, auto_reason: 'timeout', prev_expires_at: '2026-12-11T00:00:00+00:00' }, NOW).rank).toBe(2);
    expect(accountView({ ...base, auto_reason: 'timeout', expires_at: '2026-12-10T00:00:00+00:00' }, NOW).note).toContain('2026-12-10');
    expect(accountView({ ...base, prev_expires_at: '2026-12-02T00:00:00+00:00' }, NOW).rank).toBe(6);
  });
  it('자동 점검 이유 문구', () => {
    expect(autoReasonText('internal_error:ab12')).toBe('MindWiki 점검 중 오류가 났습니다 (ab12)');
    expect(autoReasonText('something_new')).toBe('MindWiki 를 확인하지 못했습니다(something_new).');
    expect(autoReasonText('no_workspace')).toMatch(/관리자/);
  });
});

