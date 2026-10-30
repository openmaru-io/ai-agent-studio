/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 에이전트(Hermes 설치본)의 화면 글자(스펙 2026-10-19-003). 이름만으로는 누구의 에이전트인지 구분되지 않아 주인 이름을 앞에 붙인다.
// id 는 글자에 쓰지 않고 풍선말·주소·저장 값에 둔다. 이름을 짓지 않은 설치본(로컬 모드)만 이름 자리에 id 가 들어간다.
import { t } from '@/i18n';

export interface AgentRef {
  id: string;
  /** 에이전트 이름(HermesAgent displayName). 없으면 빈 값 */
  name?: string;
  /** 주인의 사람 이름. 서버가 준 값이 있으면 그것을 쓴다 */
  owner_name?: string;
  /** 주인 이메일. owner_name 이 없을 때 nameOfEmail 로 사람 이름을 찾는다. 로컬 모드 주인은 「*」 */
  owner?: string;
}

/** 「주인 이름 · 에이전트 이름」. 주인이 없으면 「에이전트 이름」. 주인 이름을 모르면 이메일, 에이전트 이름이 없으면 id. */
export function agentLabel(pod: AgentRef, nameOfEmail?: (email: string) => string | undefined): string {
  const agent = pod.name || pod.id;
  const email = pod.owner && pod.owner !== '*' ? pod.owner : '';
  const owner = pod.owner_name || (email ? nameOfEmail?.(email) || email : '');
  return owner ? t('common.agentOwner', { owner, agent }) : agent;
}

/** 보는 사람 기준: 내 에이전트는 이름만(주인이 늘 나라서), 남의 것은 「주인 이름 · 에이전트 이름」(스펙 2026-10-19-003 D1).
 *  주인 이름은 서버가 준 owner_name 만 쓴다 — 이메일을 대신 보이지 않는다. */
export function viewerAgentLabel(pod: AgentRef, viewerEmail?: string): string {
  const mine = !!viewerEmail && (pod.owner ?? '').toLowerCase() === viewerEmail.toLowerCase();
  return mine ? pod.name || pod.id : agentLabel({ id: pod.id, name: pod.name, owner_name: pod.owner_name });
}

/** viewerAgentLabel 을 주인·에이전트 두 조각으로. 상단 막대 고르개가 좁은 폭에서 주인부터 줄이려고 나눠 그린다(스펙 2026-10-19-019 DD1).
 *  내 것이거나 주인 이름을 모르면 owner 는 비고, 두 조각을 「 · 」로 이으면 viewerAgentLabel 과 같다. */
export function viewerAgentParts(pod: AgentRef, viewerEmail?: string): { owner: string; agent: string } {
  const mine = !!viewerEmail && (pod.owner ?? '').toLowerCase() === viewerEmail.toLowerCase();
  return { owner: mine ? '' : pod.owner_name || '', agent: pod.name || pod.id };
}

/** 프로파일까지: 「주인 이름 · 에이전트 이름 › 프로파일」 */
export const agentProfileLabel = (pod: AgentRef, profile: string, nameOfEmail?: (email: string) => string | undefined) =>
  t('common.agentProfile', { agent: agentLabel(pod, nameOfEmail), profile });

/** 설치본 목록 → {id: 화면 글자}. id 만 아는 곳(칩·확인창)이 찾아 쓴다. 목록에 없는 id 는 넣지 않는다(id 를 그대로 보인다). */
export function agentLabels(pods: AgentRef[] | undefined, nameOfEmail?: (email: string) => string | undefined): Record<string, string> {
  return Object.fromEntries((pods ?? []).map((p) => [p.id, agentLabel(p, nameOfEmail)]));
}
