/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { activeCount, addCommand, addWithTokenCommand, caFetchCommand, caHostPort, caRegisterCommands, detectCaOs, envFromKeychainCommand, expiringSoon, keychainCommand, loginCommand, splitRows, TokenRow } from './connections';

const NOW = 1_000_000;
const row = (over: Partial<TokenRow>): TokenRow => ({
  id: 'x',
  kind: 'pat',
  name: 'n',
  bundle: 'read',
  scopes: [],
  prefix: 'abcd1234',
  created: NOW - 100,
  expires: NOW + 30 * 86400,
  last_used: null,
  last_ip: '',
  state: 'active',
  ended: null,
  ...over,
});

describe('Claude Code 연결 상태 로직', () => {
  it('7일 안에 끝나는 살아 있는 연결만 곧 끝남', () => {
    expect(expiringSoon(row({ expires: NOW + 7 * 86400 }), NOW)).toBe(true);
    expect(expiringSoon(row({ expires: NOW + 8 * 86400 }), NOW)).toBe(false);
    expect(expiringSoon(row({ expires: NOW + 86400, state: 'revoked' }), NOW)).toBe(false);
  });

  it('구역을 나누고 살아 있는 것·최근에 쓴 것 먼저', () => {
    const rows = [
      row({ id: 'old', last_used: NOW - 500 }),
      row({ id: 'gone', state: 'revoked', last_used: NOW }),
      row({ id: 'new', last_used: NOW - 10 }),
      row({ id: 'o1', kind: 'oauth' }),
    ];
    const { oauth, pat } = splitRows(rows);
    expect(oauth.map((r) => r.id)).toEqual(['o1']);
    expect(pat.map((r) => r.id)).toEqual(['new', 'old', 'gone']);
    expect(activeCount(rows)).toBe(3);
  });

  it('명령: 원문 토큰은 명령에 넣지 않는다(키체인은 값을 물어보고, 연결은 환경변수로)', () => {
    const url = 'https://aas.example/mcp';
    expect(addCommand(url)).toBe('claude mcp add --scope user --transport http aas https://aas.example/mcp');   // 어느 폴더에서나 /mcp 에 보이게(2026-10-28)
    expect(loginCommand()).toBe('claude mcp login aas');   // add 는 등록만 한다 — 브라우저는 로그인에서 열린다
    expect(addWithTokenCommand(url)).toBe('claude mcp add --scope user --transport http aas https://aas.example/mcp --header "Authorization: Bearer ${AAS_TOKEN}"');
    expect(keychainCommand()).toMatch(/-w$/);
    expect(envFromKeychainCommand()).toContain('security find-generic-password');
  });

  it('사설 CA 안내: https 주소에서 호스트·포트를 읽고, http·잘못된 주소는 안내를 숨긴다', () => {
    expect(caHostPort('https://aas.example/mcp')).toBe('aas.example:443');
    expect(caHostPort('https://aas.example:8443/mcp')).toBe('aas.example:8443');
    expect(caHostPort('http://localhost:8080/mcp')).toBeNull();
    expect(caHostPort('not a url')).toBeNull();
    const cmd = caFetchCommand('aas.example:443');
    expect(cmd).toContain('-connect aas.example:443');
    expect(cmd).toContain('> ~/.config/aas/aas-ca.pem');
    expect(cmd).toContain('c=c $0 "\\n"');   // awk 안의 \n 이 그대로 남아야 한다
  });

  it('사설 CA 안내: Windows 는 openssl·awk 없이 PowerShell 명령으로 받고, 등록은 OS 저장소에 한다', () => {
    const cmd = caFetchCommand('aas.example:8443', 'windows');
    expect(cmd).toContain("$h = 'aas.example'; $p = 8443");
    expect(cmd).toContain('SslStream');
    expect(cmd).not.toMatch(/openssl|awk|\/dev\/null/);
    expect(caRegisterCommands('windows')[0].cmd).toContain('Import-Certificate');
    expect(caRegisterCommands('windows')[0].cmd).toContain('Cert:\\LocalMachine\\Root');
    expect(caRegisterCommands('mac')[0].cmd).toContain('security add-trusted-cert');
    expect(caRegisterCommands('mac')[0].cmd).toContain('/Library/Keychains/System.keychain');
    expect(caRegisterCommands('linux').map((r) => r.name)).toEqual(['Ubuntu · Debian', 'RHEL · Rocky · Fedora']);
    expect(caRegisterCommands('linux')[0].cmd).toContain('update-ca-certificates');
    expect(caRegisterCommands('linux')[1].cmd).toContain('update-ca-trust');
    expect(detectCaOs('Win32')).toBe('windows');
    expect(detectCaOs('MacIntel')).toBe('mac');
    expect(detectCaOs('Linux x86_64')).toBe('linux');
  });
});
