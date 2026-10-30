/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { buildInfo, shortHash, versionLabel, versionRows } from '@/lib/buildInfo';

const env = {
  VITE_AAS_VERSION: '1.0.4',
  VITE_AAS_GIT_COMMIT: '58c40e7b9e084f2e20eaeb53964ae973425d54af',
  VITE_AAS_GIT_COMMIT_DATE: '2026-10-17 19:06:43 +0900',
  VITE_AAS_BUILD_DATE: '2026-10-17 20:00:00 +0900',
};

describe('buildInfo', () => {
  it('빌드 때 넣은 VITE_AAS_* 값을 읽는다', () => {
    expect(buildInfo(env)).toEqual({
      version: '1.0.4',
      gitCommit: '58c40e7b9e084f2e20eaeb53964ae973425d54af',
      gitCommitDate: '2026-10-17 19:06:43 +0900',
      buildDate: '2026-10-17 20:00:00 +0900',
    });
  });

  it('값이 없으면 빈 값이고 표에는 N/A 로 보인다', () => {
    const info = buildInfo({});
    expect(info).toEqual({ version: '', gitCommit: '', gitCommitDate: '', buildDate: '' });
    expect(versionLabel(info)).toBe('vN/A');
    expect(versionRows(info, 'OPENMARU CogentAI AAS').slice(1).map((r) => r.value)).toEqual([
      'vN/A',
      'N/A',
      'N/A',
      'N/A',
      'N/A',
    ]);
  });

  it('버전 앞의 v 를 두 번 붙이지 않고, 커밋은 앞 8자로 줄인다', () => {
    expect(versionLabel({ ...buildInfo(env), version: 'v1.0.4' })).toBe('v1.0.4');
    expect(shortHash(env.VITE_AAS_GIT_COMMIT)).toBe('58c40e7b');
  });

  it('표는 제품 이름·버전·커밋(짧게)·커밋 해시·커밋 날짜·빌드 날짜 순이다', () => {
    expect(versionRows(buildInfo(env), 'MSAP CogentAI AAS').map((r) => r.value)).toEqual([
      'MSAP CogentAI AAS',
      'v1.0.4',
      '58c40e7b',
      '58c40e7b9e084f2e20eaeb53964ae973425d54af',
      '2026-10-17 19:06:43 +0900',
      '2026-10-17 20:00:00 +0900',
    ]);
  });
});
