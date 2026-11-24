/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { isMySkill, skillOriginLabel } from './skillOrigin';

const ROWS = [
  { name: 'doc-to-markdown', profile: 'main', origin: 'aas' },
  { name: 'report', profile: 'side', origin: 'local' },
];

describe('프로파일 패널 스킬 출처 이름표(스펙 2026-10-27-007 R6)', () => {
  it('「스킬」 탭 목록의 같은 프로파일 줄이 있으면 그 출처 이름표를 쓴다', () => {
    expect(skillOriginLabel(ROWS, 'main', 'doc-to-markdown', 'external')).toBe('AAS 기본');
  });

  it('다른 프로파일의 같은 이름 줄은 쓰지 않고 Hermes 값으로 대신한다', () => {
    expect(skillOriginLabel(ROWS, 'main', 'report', 'agent')).toBe('agent');
  });

  it('목록에 없으면 bundled·hub 만 같은 이름표로, 값이 없으면 빈 문자열', () => {
    expect(skillOriginLabel([], 'main', 'docx', 'bundled')).toBe('Hermes 기본');
    expect(skillOriginLabel([], 'main', 'x', 'hub')).toBe('Hermes 허브');
    expect(skillOriginLabel([], 'main', 'x', undefined)).toBe('');
  });
});

describe('보호 스킬(스펙 2026-11-21-003 §3-2)', () => {
  it('「보호」 이름표 — 목록 줄의 출처 또는 아직 쓰지 않은 줄의 provenance', () => {
    expect(skillOriginLabel([{ name: 'p', profile: 'side', origin: 'protected' }], 'side', 'p', 'agent')).toBe('보호');
    expect(skillOriginLabel([], 'side', 'p', 'protected')).toBe('보호');
  });

  it('내 스킬로 세지 않는다', () => {
    expect(isMySkill('protected')).toBe(false);
  });
});
