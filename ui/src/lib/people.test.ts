/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { toPeople } from './people';

describe('toPeople(OMAI-1229)', () => {
  it('이메일 없는 사람·비활성·중복을 빼고 이름순으로 정렬한다', () => {
    expect(
      toPeople([
        { email: 'lee@x.com', name: '이영희', username: 'younghee', department: '운영팀' },
        { email: 'kim@x.com', name: '김철수' },
        { email: 'off@x.com', name: '쉬는 사람', enabled: false },
        { name: '이메일 없음' },
        { email: 'kim@x.com', name: '중복' },
      ])
    ).toEqual([
      { email: 'kim@x.com', name: '김철수', username: 'kim', department: undefined },
      { email: 'lee@x.com', name: '이영희', username: 'younghee', department: '운영팀' },
    ]);
  });

  it('옛 방식(이메일만)은 @ 앞부분을 이름·아이디로 쓴다. 읽지 못하면 빈 목록이다', () => {
    expect(toPeople([{ email: 'alice@x.com' }])).toEqual([{ email: 'alice@x.com', name: 'alice', username: 'alice', department: undefined }]);
    expect(toPeople(undefined)).toEqual([]);
  });
});
