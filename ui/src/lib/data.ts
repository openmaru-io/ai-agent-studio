/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 서버에서 받는 공통 데이터(내 정보, 수집 결과). 화면이 같은 키를 쓰면 한 번만 받는다.
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { get } from './api';
import type { Notice } from './useNotices';
import { useTopic } from './ws';

export interface Me {
  auth_enabled: boolean;
  user: { email: string; name?: string } | null;
  admin: boolean;
  /** 지금 POD 의 주인인가(로그인을 켰을 때만). 주인용 변경 기록 메뉴에 쓴다(OMAI-1126) */
  owner?: boolean;
  /** 주인이 아닌 지금 POD 를 팀 관리자로 보는 중인가. 변경 기록 메뉴에 쓴다(스펙 2026-10-22-001 DD8) */
  team_manager?: boolean;
  /** 팀 관리자로 지정된 시각. 지금 팀 관리자일 때만 값이 있다. 처음 지정 안내를 한 번만 보이는 데 쓴다(스펙 2026-10-22-001 DD9) */
  team_manager_since?: string;
  /** 메뉴 「스킬 허브」 배지: 이 작업공간에서 올릴 수 있는 스킬 새 버전 줄 수(스펙 2026-10-24-003 D4). 올리기 권한이 없으면 0 */
  market_updates?: number;
  /** 새 사용자의 주 프로파일(main). ready=false 면 아직 만드는 중(스펙 2026-10-14-003) */
  primary?: { profile: string; ready: boolean } | null;
  /** name: 에이전트 이름(HermesAgent displayName, 없으면 빈 값). 대시보드 「지금 에이전트」 제목이 쓴다.
   *  owner_name: 주인의 사람 이름(없으면 빈 값). 화면은 「주인 · 에이전트 이름」으로 그린다(lib/agentLabel, 스펙 2026-10-19-003)
   *  team: 내가 팀 관리자로 다루는 팀원의 에이전트인가(내 것은 거짓). 상단 고르개의 「내 팀」 구역·대상 표시에 쓴다(스펙 2026-10-22-001 DD2·DD5) */
  pod: { id: string; owner: string; name?: string; owner_name?: string; team?: boolean; restarting?: boolean; restart_reason?: string } | null;
  pods: { id: string; owner: string; name?: string; owner_name?: string; team?: boolean }[];
  /** 내가 주인인 에이전트의 이름(내 정보 서랍의 「내 에이전트」, OMAI-1159). 관리자도 남의 에이전트는 빠진다 */
  own_pods?: string[];
  registry_error?: string;
  ws?: boolean; // 서버가 웹소켓(/ws)을 켰는가(AAS_WS). 꺼져 있으면 HTTP 로 읽는다
  department?: string; // 보는 사람의 Keycloak 부서(없으면 빈 값). 오피스 이름에 쓴다(OMAI-1121)
  company_name?: string; // 설정 화면에 적은 회사명(미설정이면 빈 값)
  /** 비밀번호가 어디 있는가: keycloak · local · none. none 이면 내 정보 서랍은 변경 칸 대신 안내(스펙 2026-10-14-017) */
  account?: { method: 'keycloak' | 'local' | 'none'; can_change_password: boolean };
  /** 비밀값을 넣어도 되는 연결인가(https 이거나 이 맥 안). 없으면 모르는 것이라 입력을 열지 않는다(스펙 2026-10-14-025 D5) */
  secure?: boolean;
  /** 이 사람에게 지금 보일 공지(닫은 것 포함). 웹소켓 토픽 notices 가 없을 때 쓴다(스펙 공지 바 R4) */
  notices?: Notice[];
  /** 「Claude Code 연결」 수와 7일 안 끝나는 수동 토큰 수(스펙 2026-10-28-001 §3-7 ②). 로그인을 끈 설치는 null */
  connections?: { active: number; expiring: number } | null;
}

export interface Health {
  collected_at: string;
  dashboard_url?: string;
  totals: Record<string, number>;
  [k: string]: unknown;
}

// 주 프로파일(main)을 만드는 중이면 15초마다 다시 읽어, 끝나면 화면이 저절로 바뀌게 한다(스펙 2026-10-19-001 디자인 D8).
// 지금 작업공간이 다시 뜨는 중(pod.restarting)이면 5초마다 — 끝나면 띠가 사라진다(스펙 2026-10-23-006).
// 평소에도 30초마다 읽는다. 다시 시작 전에 연 화면은 다시 읽지 않아 띠가 끝까지 나오지 않았다(OKE 2026-10-23, 스펙 2026-10-23-008)
export const meRefetchMs = (me: Me | undefined): number =>
  me?.pod?.restarting ? 5000 : me?.primary?.ready === false ? 15000 : 30000;
export const useMe = () =>
  useQuery<Me>({
    queryKey: ['me'],
    queryFn: () => get<Me>('/api/me'),
    staleTime: 60000,
    refetchInterval: (q) => meRefetchMs(q.state.data),
  });
/** 관리자인가(로그인이 꺼져 있으면 모두 관리자). 아직 모르면 거짓 — 관리자 메뉴·단추를 잠깐 숨겼다가 보인다(OMAI-1122). */
export const isAdmin = (m?: Me | null) => !!m && (!m.auth_enabled || m.admin);
export const useIsAdmin = () => isAdmin(useMe().data);

// 웹소켓이 켜져 있으면 토픽 pod:<id>:health 로 받고(바뀌면 서버가 보낸다), 아니면 60초마다 HTTP 로 읽는다.
export const useHealth = () => {
  const qc = useQueryClient();
  const me = useMe();
  const pod = me.data?.ws ? me.data.pod?.id : undefined;
  const live = useTopic<Health>(pod ? `pod:${pod}:health` : null, (d) => qc.setQueryData(['health'], d));
  return useQuery<Health>({ queryKey: ['health'], queryFn: () => get<Health>('/api/health'), refetchInterval: live ? false : 60000 });
};

export const useCreds = () =>
  useQuery<{ totals: Record<string, number>; items?: { flags?: string[] }[] }>({
    queryKey: ['credentials'],
    queryFn: () => get('/api/credentials'),
    staleTime: 120000,
  });

export interface Agent {
  name: string;
  title?: string;
  description?: string;
  running?: boolean;
  failed_jobs?: number;
}

// 대화할 수 있는 에이전트(프로파일) 목록. 채팅 화면의 상태 응답에 들어 있다.
export const useAgents = () =>
  useQuery<Agent[]>({
    queryKey: ['agents'],
    queryFn: () => get<{ agents?: Agent[] }>('/api/chat/status').then((r) => r.agents ?? []),
    staleTime: 30000,
  });
