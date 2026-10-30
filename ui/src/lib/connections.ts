/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 「Claude Code 연결」 화면의 상태 로직(스펙 2026-10-28-001 §3-7 ②). 화면 밖에서 시험한다.
// 줄 하나 = 연결 하나: 수동 토큰(pat)은 토큰 하나, OAuth 는 refresh 계보 하나(서버 tokens.list_for).

export type TokenKind = 'pat' | 'oauth';
export type TokenState = 'active' | 'expired' | 'revoked';

export interface TokenRow {
  id: string;
  kind: TokenKind;
  name: string;
  bundle: string;
  scopes: string[];
  prefix: string;
  /** 초(epoch) */
  created: number;
  expires: number;
  last_used: number | null;
  last_ip: string;
  state: TokenState;
  ended: number | null;
  revoked_by?: string;
  revoke_reason?: string;
}

export interface TokensData {
  tokens: TokenRow[];
  bundles: Record<string, string[]>;
  expiry_days: number[];
  default_days: number;
  max: number;
  mcp_url: string;
}

/** 7일 안에 끝나는 것을 호박색으로(디자인 D10). 메뉴 배지와 같은 기준 — 서버 tokens.EXPIRING_DAYS */
export const EXPIRING_DAYS = 7;
const DAY = 86400;

export const expiringSoon = (row: TokenRow, now: number): boolean =>
  row.state === 'active' && row.expires - now <= EXPIRING_DAYS * DAY;

/** 살아 있는 연결 수 — 상한(max)을 넘으면 만들기를 막는다 */
export const activeCount = (rows: TokenRow[]): number => rows.filter((r) => r.state === 'active').length;

/** 구역별로 나눈다: 위 OAuth, 아래 수동. 각 구역은 살아 있는 것 먼저, 그 안에서 최근에 쓴(없으면 만든) 순 */
export function splitRows(rows: TokenRow[]): { oauth: TokenRow[]; pat: TokenRow[] } {
  const order = (a: TokenRow, b: TokenRow) =>
    Number(b.state === 'active') - Number(a.state === 'active') || (b.last_used ?? b.created) - (a.last_used ?? a.created);
  return {
    oauth: rows.filter((r) => r.kind === 'oauth').sort(order),
    pat: rows.filter((r) => r.kind === 'pat').sort(order),
  };
}

/** OAuth 연결 명령(빈 상태의 주 행동). 이름 aas 는 Claude Code 안에서 도구 이름 앞에 붙는다(mcp__aas__…).
 *  --scope user: 범위를 빼면 local(그 폴더만)이라 다른 폴더의 /mcp 에 aas 가 나오지 않았다(2026-10-28 사용자 질문) */
export const addCommand = (mcpUrl: string): string => `claude mcp add --scope user --transport http aas ${mcpUrl}`;

/** add 는 등록만 한다. 브라우저 로그인·동의는 이 명령(또는 Claude Code 안의 /mcp)에서 시작한다 */
export const loginCommand = (): string => 'claude mcp login aas';

/** 수동 토큰 연결 — 원문을 설정 파일에 적지 않고 환경변수에서 읽게 한다(§3-1-2 B) */
export const addWithTokenCommand = (mcpUrl: string): string =>
  `claude mcp add --scope user --transport http aas ${mcpUrl} --header "Authorization: Bearer \${AAS_TOKEN}"`;

/** 원문은 키체인에 한 번 넣고(macOS), 쓸 때 환경변수로 꺼낸다 — 설정 파일·레포에 원문이 남지 않게(§3-1-2 B).
 *  -w 를 값 없이 끝에 두면 security 가 값을 물어본다 — 원문이 셸 기록에 남지 않는다(붙여 넣기로 넣는다) */
export const KEYCHAIN_SERVICE = 'cogentai-aas';
export const keychainCommand = (): string => `security add-generic-password -U -a "$USER" -s ${KEYCHAIN_SERVICE} -w`;
export const envFromKeychainCommand = (): string =>
  `export AAS_TOKEN="$(security find-generic-password -a "$USER" -s ${KEYCHAIN_SERVICE} -w)"`;

/** 사설 CA 안내(인증서 오류 때). https 가 아니면 필요 없다(로컬 시험 http://localhost). 호스트·포트는 연결 주소에서 읽는다 */
export const CA_FILE = '~/.config/aas/aas-ca.pem';
export function caHostPort(mcpUrl: string): string | null {
  try {
    const u = new URL(mcpUrl);
    return u.protocol === 'https:' ? `${u.hostname}:${u.port || '443'}` : null;
  } catch {
    return null;
  }
}
export type CaOs = 'mac' | 'linux' | 'windows';
/** 처음 고를 탭: 접속한 PC 의 운영체제 */
export const detectCaOs = (platform: string): CaOs => (/mac|darwin|iphone|ipad/i.test(platform) ? 'mac' : /win/i.test(platform) ? 'windows' : 'linux');
const WIN_CA = '$HOME\\.config\\aas\\aas-ca.pem';

export const caMkdirCommand = (os: CaOs = 'mac'): string =>
  os === 'windows' ? 'New-Item -ItemType Directory -Force "$HOME\\.config\\aas" | Out-Null' : 'mkdir -p ~/.config/aas';
/** 서버가 보내는 인증서 묶음의 마지막 것(CA)을 저장한다. 시스템 신뢰 저장소는 건드리지 않는다.
 *  Windows 는 openssl·awk 가 기본으로 없어 .NET(SslStream)으로 받는다 — 이 맥에는 PowerShell 이 없어 실행해 보지 못했다 */
export function caFetchCommand(hostPort: string, os: CaOs = 'mac'): string {
  if (os === 'windows') {
    const [h, p] = [hostPort.slice(0, hostPort.lastIndexOf(':')), hostPort.slice(hostPort.lastIndexOf(':') + 1)];
    return [
      `$h = '${h}'; $p = ${p}`,
      '$tcp = New-Object Net.Sockets.TcpClient($h, $p)',
      '$ssl = New-Object Net.Security.SslStream($tcp.GetStream(), $false, { param($s, $c, $ch, $e) $global:aasCa = $ch.ChainElements[$ch.ChainElements.Count - 1].Certificate; $true })',
      '$ssl.AuthenticateAsClient($h)',
      '$tcp.Close()',
      '$pem = "-----BEGIN CERTIFICATE-----`n" + [Convert]::ToBase64String($global:aasCa.RawData, \'InsertLineBreaks\') + "`n-----END CERTIFICATE-----`n"',
      `Set-Content -Path "${WIN_CA}" -Value $pem -Encoding ascii`,
    ].join('\n');
  }
  return `openssl s_client -showcerts -connect ${hostPort} </dev/null 2>/dev/null \\\n  | awk '/BEGIN CERTIFICATE/{c=""} {c=c $0 "\\n"} /END CERTIFICATE/{last=c} END{printf "%s", last}' \\\n  > ${CA_FILE}`;
}
export const caCheckCommand = (os: CaOs = 'mac'): string =>
  os === 'windows'
    ? `New-Object Security.Cryptography.X509Certificates.X509Certificate2("${WIN_CA}") | Format-List Subject, Issuer`
    : `openssl x509 -in ${CA_FILE} -noout -subject -issuer`;
/** PC 전체(OS 신뢰 저장소)에 CA 를 등록한다 — 관리자 권한이 필요하다. Claude Code 는 기본으로 OS 저장소를 읽는다
 *  (네이티브 설치판, npm 설치는 Node 22.15 이상 — 공식 문서 network-config). Linux 는 배포판별로 둘이다(Debian 계열, RHEL 계열).
 *  이 명령들은 어느 OS 에서도 실행해 보지 못했다(저장소를 바꾸는 명령이라 개발 PC 에서 돌리지 않았다) */
export interface CaRegister {
  /** 배포판 이름(Linux 만) */
  name?: string;
  cmd: string;
}
export const caRegisterCommands = (os: CaOs): CaRegister[] => {
  if (os === 'mac') return [{ cmd: `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${CA_FILE}` }];
  if (os === 'windows') return [{ cmd: `Import-Certificate -FilePath "${WIN_CA}" -CertStoreLocation Cert:\\LocalMachine\\Root` }];
  return [
    { name: 'Ubuntu · Debian', cmd: `sudo cp ${CA_FILE} /usr/local/share/ca-certificates/aas-ca.crt && sudo update-ca-certificates` },
    { name: 'RHEL · Rocky · Fedora', cmd: `sudo cp ${CA_FILE} /etc/pki/ca-trust/source/anchors/aas-ca.pem && sudo update-ca-trust` },
  ];
};
/** macOS 의 curl(/usr/bin/curl, LibreSSL)은 키체인이 아니라 /etc/ssl/cert.pem 을 읽어 OS 저장소 등록만으로는 막힌다(2026-10-30 실측).
 *  AAS 의 1회용 주소 호출(curl)을 위해 CA 파일을 알려 준다. Linux 는 배포판 저장소 갱신으로, Windows 는 Schannel 이 Windows 저장소를 읽어 필요 없다 */
export const caCurlEnvLine = (): string => 'export CURL_CA_BUNDLE="$HOME/.config/aas/aas-ca.pem"';
