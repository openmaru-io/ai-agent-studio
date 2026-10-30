/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { agentLabel, agentLabels, agentProfileLabel, viewerAgentLabel, viewerAgentParts } from './agentLabel';

describe('agentLabel(스펙 2026-10-19-003)', () => {
  const nameOf = (e: string) => ({ 'lee@x.com': '이사용' })[e];
  it('주인이 있으면 「주인 이름 · 에이전트 이름」', () => {
    expect(agentLabel({ id: 'a', name: '이사용 에이전트', owner: 'lee@x.com' }, nameOf)).toBe('이사용 · 이사용 에이전트');
    expect(agentLabel({ id: 'a', name: '운영', owner_name: '김철수', owner: 'lee@x.com' }, nameOf)).toBe('김철수 · 운영'); // 서버가 준 이름이 먼저
  });
  it('주인 이름을 모르면 이메일, 에이전트 이름이 없으면 id', () => {
    expect(agentLabel({ id: 'b', owner: 'park@x.com' }, nameOf)).toBe('park@x.com · b');
    expect(agentLabel({ id: 'b', owner: 'park@x.com' })).toBe('park@x.com · b');
  });
  it('주인이 없거나 로컬 모드(*)면 에이전트 이름만', () => {
    expect(agentLabel({ id: 'c', name: '공용' }, nameOf)).toBe('공용');
    expect(agentLabel({ id: 'd', owner: '*' }, nameOf)).toBe('d');
  });
  it('보는 사람 기준: 내 것은 이름만, 남의 것은 서버가 준 주인 이름만 붙인다(이메일을 대신 쓰지 않는다)', () => {
    expect(viewerAgentLabel({ id: 'a', name: '운영', owner: 'Me@x.com', owner_name: '나' }, 'me@x.com')).toBe('운영');
    expect(viewerAgentLabel({ id: 'b', name: '시험', owner: 'lee@x.com', owner_name: '이사용' }, 'me@x.com')).toBe('이사용 · 시험');
    expect(viewerAgentLabel({ id: 'c', owner: 'lee@x.com' }, 'me@x.com')).toBe('c');
  });
  it('두 조각으로 나눠도 이으면 viewerAgentLabel 과 같다(스펙 2026-10-19-019 DD1)', () => {
    const pods = [
      { id: 'a', name: '운영', owner: 'Me@x.com', owner_name: '나' },
      { id: 'b', name: '시험', owner: 'lee@x.com', owner_name: '이사용' },
      { id: 'c', owner: 'lee@x.com' },
    ];
    expect(viewerAgentParts(pods[1], 'me@x.com')).toEqual({ owner: '이사용', agent: '시험' });
    for (const p of pods) {
      const { owner, agent } = viewerAgentParts(p, 'me@x.com');
      expect(owner ? `${owner} · ${agent}` : agent).toBe(viewerAgentLabel(p, 'me@x.com'));
    }
  });
  it('프로파일까지, 목록을 id 로 찾는 표', () => {
    expect(agentProfileLabel({ id: 'aas-agent-aas-admin-fa8a', name: '관리', owner_name: 'AAS 관리자' }, 'main')).toBe('AAS 관리자 · 관리 › main');
    expect(agentLabels([{ id: 'x', name: 'X', owner_name: '홍' }, { id: 'y' }])).toEqual({ x: '홍 · X', y: 'y' });
  });
});
