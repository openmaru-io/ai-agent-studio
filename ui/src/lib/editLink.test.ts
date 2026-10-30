/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { changeEditTarget, editHref } from './editLink';

describe('editHref', () => {
  it('화면과 인자로 주소를 만들고 빈 값은 뺀다', () => {
    expect(editHref({ to: 'profiles', params: { name: 'ma', pane: 'soul', extra: undefined, empty: '' } })).toBe('/profiles?name=ma&pane=soul');
    expect(editHref({ to: 'models' })).toBe('/models');
  });
});

describe('changeEditTarget (스펙 2026-10-15-016 §3-3)', () => {
  const row = (kind: string, detail?: string) => ({ kind, detail });

  it('프로파일 변경은 그 프로파일 서랍의 탭으로 간다', () => {
    const cases: [string, string, string | undefined][] = [
      ['profile_soul', 'ma', 'soul'],
      ['profile_soul_revert', 'ma', 'soul'],
      ['profile_agents', 'ma', 'agents'],
      ['profile_agents_revert', 'ma', 'agents'],
      ['profile_agents_ack', 'ma', 'agents'],
      ['profile_config', 'ma', 'config'],
      ['profile_config_revert', 'ma', 'config'],
      ['profile_env_set', 'ma target=LAW_OC', 'env'],
      ['profile_env_clear', 'ma target=LAW_OC', 'env'],
      ['profile_skill', 'ma target=ga4 enabled=True', 'skills'],
      ['profile_toolset', 'ma target=web', 'tools'],
      ['profile_mcp', 'ma target=OMDM', 'tools'],
      ['profile_gateway', 'ma op=restart', 'channels'],
      ['profile_model', 'ma model=m2', undefined],
      ['profile_describe', 'ma', undefined],
      ['profile_create', 'newone', undefined],
      ['profile_rename', 'ma new_name=mb', undefined],
    ];
    for (const [kind, detail, pane] of cases) {
      expect(changeEditTarget(row(kind, detail)), kind).toEqual({ to: 'profiles', params: { name: detail.split(' ')[0], pane } });
    }
  });

  it('인증 파일 변경은 비밀값 탭의 그 파일로, 실패한 줄은 링크가 없다(2026-10-22-004 R12)', () => {
    expect(changeEditTarget(row('profile_credential_put', 'ma secrets/omdm.json'))).toEqual({
      to: 'profiles',
      params: { name: 'ma', pane: 'env', file: 'secrets/omdm.json' },
    });
    expect(changeEditTarget(row('profile_credential_clear', 'ma google_token.json'))).toEqual({
      to: 'profiles',
      params: { name: 'ma', pane: 'env', file: 'google_token.json' },
    });
    expect(changeEditTarget({ kind: 'profile_credential_put', detail: 'ma google_token.json', failed: true })).toBeNull();
    expect(changeEditTarget(row('profile_credential_put', 'ma'))).toBeNull();
  });

  it('크론 변경은 그 프로파일의 크론 탭으로, 스킬 변경은 스킬 화면의 그 스킬로 간다', () => {
    expect(changeEditTarget(row('cron_pause', 'ma/주간 보고'))).toEqual({ to: 'profiles', params: { name: 'ma', pane: 'cron' } });
    expect(changeEditTarget(row('cron_mute', 'ma/abc123'))).toEqual({ to: 'profiles', params: { name: 'ma', pane: 'cron' } });
    // 스킬 링크는 프로파일을 함께 넘긴다. 경로로 프로파일을 모르면 전체(*)(스펙 2026-10-27-013 §4-5)
    expect(changeEditTarget(row('skill_create', 'ma/weekly-report'))).toEqual({ to: 'skills', params: { tab: 'all', profile: 'ma', q: 'weekly-report' } });
    expect(changeEditTarget(row('skill_upload', 'ma/weekly-report abcdef123456 scripts=1'))).toEqual({ to: 'skills', params: { tab: 'all', profile: 'ma', q: 'weekly-report' } });
    expect(changeEditTarget(row('skill_save', 'skills/ops/weekly/SKILL.md'))).toEqual({ to: 'skills', params: { tab: 'all', profile: '*', q: 'weekly' } });
    expect(changeEditTarget(row('skill_revert', 'skills/ops/weekly/SKILL.md'))).toEqual({ to: 'skills', params: { tab: 'all', profile: '*', q: 'weekly' } });
    expect(changeEditTarget(row('skill_save', 'profiles/ma/skills/ops/weekly/SKILL.md'))).toEqual({ to: 'skills', params: { tab: 'all', profile: 'ma', q: 'weekly' } });
  });

  it('열 곳이 없거나 읽을 수 없는 행은 null 이다(추측으로 엉뚱한 곳을 열지 않는다)', () => {
    for (const r of [
      row('profile_delete', 'ma'),
      row('profile_export', 'ma'),
      row('profile_soul', ''),
      row('profile_soul', undefined),
      row('profile_soul', 'ma/oops'),
      row('cron_pause', 'nonsense'),
      row('cron_office_post', 'alias'),
      row('skill_save', ''),
      row('office_change', 'room'),
      row('market_install', 'pkg'),
      row('user_create', 'a@b.c'),
      row('login', ''),
      row('unknown_kind', 'x'),
    ])
      expect(changeEditTarget(r), `${r.kind} ${r.detail}`).toBeNull();
  });
});
