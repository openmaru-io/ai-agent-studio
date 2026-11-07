/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 받은편지함(계획 007 P4, G2). 어느 화면에서나 머리줄 종에 개수가 보인다.
// 웹소켓이면 신호 토픽 office:inbox:<이메일> 의 번호가 바뀔 때 곧바로 다시 읽고, 크론·MCP 로그인 항목 때문에 30초마다도 읽는다.
// 토픽이 살아 있지 않으면 15초마다 읽는다(스펙 2026-10-17-004 D9).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { inboxTopic, useSignalTopic } from '@/features/office/signalTopic';
import { get, post } from '@/lib/api';
import { useMe } from '@/lib/data';

export interface InboxItem {
  id: string;
  kind:
    | 'approval'
    | 'clarify'
    | 'review'
    | 'blocked'
    | 'cron_failed'
    | 'cron_done'
    | 'admin_request'
    | 'admin_request_result'
    | 'mcp_login'
    | 'retained_volume'
    | 'pc_import'
    | 'connection'
    | 'workspace_oom'
    | 'size_failed'
    | 'blocked_route';
  /** workspace_oom·size_failed·workspace_size(스펙 2026-11-06-005 O2): 메모리 초과 때 한도, 결과의 이전·새 메모리(바이트). 작업공간은 pod */
  limit_memory?: string;
  /** blocked_route(OMAI-1857 D10): 막힌 주소(host:port)와 그 주소로 부르는 모델 */
  host?: string;
  models?: string[];
  memory_from?: number;
  memory_to?: number;
  alias: string;
  /** 화면에 보일 이름(서버가 준다). 자동 별칭(설치본 id)이면 에이전트 이름(스펙 2026-10-19-003). alias 는 이동·검색에 쓴다 */
  label?: string;
  text: string;
  command?: string;
  choices?: string[];
  question_id?: string;
  /** 승인·되묻기를 받은 시각(초) */
  at?: number;
  board?: string;
  task_id?: string;
  error?: string;
  /** 관리자에게 요청(단계 5): 요청 종류·요청자·프로파일·기다린 날수. 결과 항목은 status(handled·declined)와 관리자가 적은 사유 */
  req_kind?: string;
  requester?: string;
  requester_name?: string; // 사람 이름(모르면 이메일 앞부분). 이메일은 풍선말로
  /** 요청 항목과 크론 항목이 함께 쓴다(요청이 가리키는 프로파일, 크론 작업의 프로파일) */
  profile?: string;
  waiting_days?: number;
  stale?: boolean;
  /** pc_import(OMAI-1136 D11): by_admin(관리자가 대행해 끝남)·done·rolled_back·rollback_failed */
  status?: 'handled' | 'declined' | 'by_admin' | 'done' | 'rolled_back' | 'rollback_failed' | 'expiring' | 'revoked';
  /** connection(스펙 2026-10-28-001 §3-7 ③): 연결 이름·종류(pat 수동·oauth)·만료 시각(초). 끊은 사람·사유는 위 by·reason */
  name?: string;
  token_kind?: 'pat' | 'oauth';
  expires?: number;
  /** pc_import: 가져오기를 한 사람(이메일) */
  by?: string;
  /** by 의 사람 이름(모르면 이메일 앞부분). 화면은 이것을 보인다(2026-10-30) */
  by_name?: string;
  /** pc_import: 옮긴 인증 파일 수·더한 비밀값 수(스펙 2026-10-22-003 DD20·OV-11). 비밀을 옮기지 않았으면 없다 */
  secrets?: { files: number; env: number };
  reason?: string;
  /** 크론 항목: 작업의 POD·작업 id. 「크론 보기」가 그 작업의 서랍을 연다(프로파일은 위 profile) */
  pod?: string;
  job_id?: string;
  /** MCP 로그인 필요(스펙 2026-10-16-010 T8·V14): 서버 이름, 로그인이 만료됐는가(아니면 아직 로그인 전) */
  server?: string;
  reauth?: boolean;
  /** 지운 에이전트의 남은 데이터 볼륨(OMAI-1291): 알림 기간(일)과 볼륨 목록. 지울 명령은 위 command */
  days?: number;
  volumes?: RetainedVolume[];
}

export interface RetainedVolume {
  pvc: string;
  agent: string;
  /** 지운 에이전트의 옛 주인(기록이 없으면 빈 값) */
  owner: string;
  /** 지울 때 적은 에이전트 이름·주인 이름(그 전에 지운 것은 빈 값, 스펙 2026-10-19-003) */
  agent_name?: string;
  owner_name?: string;
  since: string;
  /** 지운 시각을 아는가(아니면 서버가 처음 본 시각부터 센다) */
  known: boolean;
  days: number;
  size: string;
  export: string;
}

export const INBOX_EVERY_MS = 15_000;
/** 신호 토픽이 살아 있을 때. 토픽에 오지 않는 크론·MCP 로그인 항목을 이 주기로 읽는다. */
export const INBOX_LIVE_EVERY_MS = 30_000;
/** 이 시간이 지난 승인·되묻기는 개수 배지를 앰버(경고)로 바꾼다(G2). */
export const INBOX_OLD_S = 5 * 60;

const INBOX_KEY = ['office-inbox'] as const;

export function useInbox() {
  const qc = useQueryClient();
  const live = useSignalTopic(inboxTopic(useMe().data), INBOX_KEY);
  const q = useQuery<{ items: InboxItem[] }>({
    queryKey: INBOX_KEY,
    queryFn: () => get<{ items: InboxItem[] }>('/api/office/inbox'),
    refetchInterval: live ? INBOX_LIVE_EVERY_MS : INBOX_EVERY_MS,
    retry: false,
  });
  const answer = useCallback(
    (id: string, body: { choice?: string; answer?: string; reason?: string }) =>
      post('/api/office/inbox/answer', { id, ...body }).finally(
        () => void qc.invalidateQueries({ queryKey: ['office-inbox'] })
      ),
    [qc]
  );
  return { items: q.data?.items ?? [], error: q.error as Error | null, loading: q.isLoading, answer };
}

/** 사람이 답해야 에이전트가 움직이는 항목(승인·되묻기). 장면의 「응답 필요」 표식에 쓴다. */
export const waiting = (items: InboxItem[]) => items.filter((i) => i.kind === 'approval' || i.kind === 'clarify');

export function hasOld(items: InboxItem[], nowS: number): boolean {
  return waiting(items).some((i) => typeof i.at === 'number' && nowS - i.at > INBOX_OLD_S);
}
