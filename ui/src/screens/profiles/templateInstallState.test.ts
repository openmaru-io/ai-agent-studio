/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  consentReady,
  consentsOf,
  defaultName,
  keyGroups,
  keysReady,
  laterMcpCount,
  phaseOf,
  refusalStep,
  type TemplateMcp,
  timedOut,
} from './templateInstallState';

const mcp: TemplateMcp[] = [
  { name: 'jira', keys: ['JIRA_TOKEN', 'JIRA_USER'], stdio: false, url: 'https://jira/mcp' },
  { name: 'fs', keys: [], stdio: true, command: 'npx', args: ['-y', '@s/fs@1.0.0'], consent_hash: 'h1' },
  { name: 'docs', keys: [], stdio: false, url: 'https://docs/mcp' },
];
const env = [
  { name: 'JIRA_TOKEN', description: '토큰', required: true, used_by: ['mcp:jira'] },
  { name: 'JIRA_USER', description: '', required: false, used_by: [] },
  { name: 'DEEPL_KEY', description: '번역', required: true, used_by: ['skill:translate'] },
  { name: 'EXTRA', description: '', required: false, used_by: [] },
];

describe('templateInstall', () => {
  it('KEY 칸을 쓰는 곳별로 묶고 한 KEY 는 한 번만 보인다', () => {
    const groups = keyGroups({ env_requires: env, mcp });
    expect(groups.map((g) => [g.kind, g.label, g.fields.map((f) => f.name)])).toEqual([
      ['mcp', 'jira', ['JIRA_TOKEN', 'JIRA_USER']],
      ['skill', 'translate', ['DEEPL_KEY']],
      ['other', '', ['EXTRA']],
    ]);
  });

  it('필수 칸이 비면 만들기를 막고, 값이나 「나중에」가 있으면 켠다', () => {
    const groups = keyGroups({ env_requires: env, mcp });
    expect(keysReady(groups, {}, {})).toBe(false);
    expect(keysReady(groups, { JIRA_TOKEN: 'x' }, {})).toBe(false);
    expect(keysReady(groups, { JIRA_TOKEN: 'x' }, { DEEPL_KEY: true })).toBe(true);
    expect(keysReady(groups, { JIRA_TOKEN: '  ', DEEPL_KEY: 'y' }, {})).toBe(false);
  });

  it('값이 빈 KEY 를 쓰는 MCP 수를 센다(꺼진 채로 만들어질 것)', () => {
    expect(laterMcpCount(mcp, {})).toBe(1);
    expect(laterMcpCount(mcp, { JIRA_TOKEN: 'a' })).toBe(1);
    expect(laterMcpCount(mcp, { JIRA_TOKEN: 'a', JIRA_USER: 'b' })).toBe(0);
  });

  it('stdio MCP 는 모두 동의해야 하고 판 고정 문제가 있으면 막는다', () => {
    expect(consentReady(mcp, {})).toBe(false);
    expect(consentReady(mcp, { fs: true })).toBe(true);
    expect(consentReady([{ ...mcp[1], problem: '판 없음' }], { fs: true })).toBe(false);
    expect(consentsOf(mcp)).toEqual(['h1']);
  });

  it('요청 상태는 done 일 때만 만들어진 것으로 본다', () => {
    expect(phaseOf(undefined)).toBe('waiting');
    expect(phaseOf({ id: 'a', status: 'running' })).toBe('waiting');
    expect(phaseOf({ id: 'a', status: 'done' })).toBe('created');
    expect(phaseOf({ id: 'a', status: 'failed' })).toBe('failed');
    expect(phaseOf({ id: 'a', status: 'failed', needs: { modified: [] } })).toBe('needs');
  });

  it('거절 코드에 따라 돌아갈 단계를 고른다', () => {
    expect(refusalStep('consent_mismatch')).toBe('confirm');
    expect(refusalStep('hidden')).toBe('pick');
    expect(refusalStep('profile_limit')).toBe('keys');
    expect(refusalStep('env_ref_blocked')).toBe('result');
  });

  it('10분이 지나면 기다리기를 멈춘다', () => {
    expect(timedOut(0, 599_000)).toBe(false);
    expect(timedOut(0, 601_000)).toBe(true);
  });

  it('기본 이름은 템플릿 이름, 있으면 번호를 붙이고 규칙에 맞지 않으면 비운다', () => {
    expect(defaultName('sales', ['main'])).toBe('sales');
    expect(defaultName('sales', ['sales', 'sales-2'])).toBe('sales-3');
    expect(defaultName('Sales!', [])).toBe('');
  });
});
