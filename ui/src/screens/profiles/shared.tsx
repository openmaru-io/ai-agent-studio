/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { Typography } from '@mui/material';
import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useCallback } from 'react';

import { Tag } from '@/components/bits';
import type { Tone } from '@/components/ListView';
import { t } from '@/i18n';
import { ApiError, get, post } from '@/lib/api';
import { useMe } from '@/lib/data';
import { CH } from '@/lib/labels';

import type { Channel, McpLoginState, ProfileDetailData, ProfileRow } from './types';

// 글자와 색을 따로 내보낸다. 목록 표의 칸(OMAI-1127)과 상세의 태그가 같은 판정을 쓴다
/** 오퍼레이터가 에이전트 설정의 주 모델 칸에 적는 자리표시자 — 「AAS 기본 모델을 따른다」.
 * 화면에는 이 글자 대신 「<지금 이름> (AAS 기본 모델)」로 보이고, 고르면 이 글자 그대로 저장한다(이름으로 저장하면 그 모델에 고정된다). */
export const DEFAULT_MODEL_REF = '${HERMES_LLM_MODEL}';
export const modelLabel = (model: string | undefined, defaultName?: string): string =>
  model === DEFAULT_MODEL_REF
    ? defaultName
      ? t('profiles.defaultModelNamed', { name: defaultName })
      : t('profiles.defaultModel')
    : model || '';

/** short: 「게이트웨이」 열·줄 머리 옆이라 상태만(「실행 중」). 머리글 없이 놓이는 서랍 배지는 「게이트웨이 실행 중」 */
export const gatewayText = (r: ProfileRow, short = false) =>
  r.running === true
    ? t(short ? 'profiles.gw.running' : 'profiles.gatewayRunning')
    : r.running === false
    ? r.service_disabled
      ? t(short ? 'profiles.gw.disabled' : 'profiles.gatewayDisabled')
      : t(short ? 'profiles.gw.stopped' : 'profiles.gatewayStopped')
    : t(short ? 'profiles.gw.unknown' : 'profiles.gatewayUnknown');
export const gatewayTone = (r: ProfileRow): Tone | undefined =>
  r.running === true ? 'good' : r.running === false && r.jobs_active ? 'bad' : undefined;

export const GatewayTag = ({ r, short }: { r: ProfileRow; short?: boolean }) => <Tag tone={gatewayTone(r)}>{gatewayText(r, short)}</Tag>;

export const channelTone = (c: Channel): Tone | undefined =>
  c.stale ? undefined : c.state === 'connected' ? (c.attention ? 'warn' : 'good') : c.state ? 'bad' : undefined;
export const channelText = (c: Channel) =>
  `${CH[c.name] || c.name} ${
    c.stale ? t('profiles.channelStale') : c.state === 'connected' ? t('profiles.channelConnected') : c.state || '—'
  }`;

export const ChannelTag = ({ c }: { c: Channel }) => <Tag tone={channelTone(c)}>{channelText(c)}</Tag>;

/** 프로파일에 바꾸는 요청을 보낸다(모두 Hermes API 로 간다). 바뀐 뒤에는 관련 조회를 다시 받는다. */
/** 프로파일 상세 조회. 상세 화면과 삭제 확인 창(마켓에서도 연다)이 같은 키를 쓴다 */
export const profileQuery = (name: string) => ({
  queryKey: ['profile', name],
  queryFn: () => get<ProfileDetailData>('/api/profile?name=' + encodeURIComponent(name)),
});

/** MCP 로그인이 끝나 가는 동안(서버의 logging_in) 상세를 다시 읽는 간격 */
export const MCP_SETTLE_POLL_MS = 3000;

/**
 * 상세 조회를 다시 읽는 간격. 읽지 못한 부분이 있으면 15초마다(에이전트 파드가 다시 뜨는 중 등).
 * OAuth MCP 행이 「로그인 중」이면 3초마다 — 로그인 성공 뒤 서버는 게이트웨이가 붙을 때까지 60초까지 「연결하는 중」을 주고
 * (mcp_oauth_relay.CONNECT_GRACE), 다른 사람의 로그인은 이 창이 끝을 알 수 없다. 다시 읽지 않으면 연결된 뒤에도 그 상태에 머문다
 * (OKE 2026-10-17, 스펙 2026-10-16-010 14-14).
 */
export function detailRefetchMs(d: ProfileDetailData | undefined, mcpLive = false): number | false {
  if (!d) return false;
  if (d.restarting) return 5000; // 작업공간이 다시 뜨는 중: 띠(useMe)와 같은 간격으로 읽어 끝나면 바로 채운다(스펙 2026-10-23-008)
  if (mcpLive) return (d.notes?.length ?? 0) > 0 ? 15000 : false; // 로그인 상태는 웹소켓 토픽으로 받는다(14-22)
  // 내가 이 창에서 시작한 로그인(mine)은 useMcpLogin 이 상태를 묻고 끝나면 다시 읽는다
  const settling = (d.mcp ?? []).some((m) => m.login_state?.state === 'logging_in' && (m.login_state.connecting || !m.login_state.mine));
  if (settling) return MCP_SETTLE_POLL_MS;
  return (d.notes?.length ?? 0) > 0 ? 15000 : false;
}

/** 웹소켓 토픽 pod:<id>:mcp:<프로파일> 이 보내는 값. 서버가 바뀌면 보낸다(14-22) */
export interface McpLoginTopic {
  servers: Record<string, McpLoginState>;
}

/** 토픽으로 받은 로그인 상태를 상세의 같은 이름 행에 덮어쓴다. 바뀐 것이 없으면 같은 객체를 돌려준다(다시 그리지 않게). */
export function mergeMcpLogin(d: ProfileDetailData | undefined, v: McpLoginTopic): ProfileDetailData | undefined {
  if (!d?.mcp) return d;
  let changed = false;
  const mcp = d.mcp.map((m) => {
    const ls = v.servers?.[m.name];
    if (!ls || JSON.stringify(ls) === JSON.stringify(m.login_state ?? null)) return m;
    changed = true;
    return { ...m, login_state: ls };
  });
  return changed ? { ...d, mcp } : d;
}

/** 서버가 _forget(pod) 로 그 작업공간의 캐시를 모두 버리는 동작(server.py profile action) — 화면도 프로파일 목록 쿼리를 다시 읽는다 */
const PROFILE_SET_ACTIONS = new Set(['create', 'rename', 'delete']);

export function useProfileAct(name: string) {
  const qc = useQueryClient();
  // 화면이 보던 에이전트를 함께 보낸다. 다른 탭에서 에이전트가 바뀌었으면 서버가 409 로 거절한다(스펙 2026-10-19-011 R1 ③)
  const pod = useMe().data?.pod?.id;
  const act = useCallback(
    <T = unknown,>(action: string, extra?: Record<string, unknown>) =>
      post<T>('/api/profile/action', { name, action, ...extra, ...(pod ? { expect_pod: pod } : {}) }).then(
        (r) => {
          // 프로파일 목록이 바뀌는 동작은 스킬 화면 목록도 다시 읽는다(OMAI-1855, 스펙 2026-11-06-005 §4 R2). ['skills'] 는 staleTime 120초라
          // 무효화하지 않으면 이름을 바꾼 옛 프로파일이 스킬 화면 프로파일 고르기에 「중지」로 남았다(서버·Hermes 는 이미 새 이름).
          if (PROFILE_SET_ACTIONS.has(action)) {
            void qc.invalidateQueries({ queryKey: ['skills'] });
            void qc.invalidateQueries({ queryKey: ['profiles'] });
          }
          return r;
        },
        (e: unknown) => {
          // 서랍 안 경고를 띄운다(디자인 D10). 오류는 그대로 던져 부른 쪽의 알림·편집기 처리를 바꾸지 않는다
          if (e instanceof ApiError && e.status === 409 && e.reason === 'agent_changed') qc.setQueryData(['profile-agent-changed'], true);
          throw e;
        }
      ),
    [name, pod, qc]
  );
  const refresh = useCallback(async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['profile', name] }),
      qc.invalidateQueries({ queryKey: ['profiles'] }),
      qc.invalidateQueries({ queryKey: ['flows'] }),
      qc.invalidateQueries({ queryKey: ['inventory', 'tools'] }), // 도구 화면의 MCP 서버 목록(서버는 같은 동작에서 tools 캐시를 비운다, OMAI-1249 V16)
    ]);
  }, [qc, name]);
  return { act, refresh };
}

/** 관리자가 아닌 사람이 이 프로파일을 고칠 수 있는가: 주인이나 팀 관리자(스펙 2026-10-22-001). 옛 서버는 manages 가 없어 owner 로 본다 */
export const mayManage = (d: ProfileDetailData): boolean => !!(d.manages ?? d.owner);

/** 서버 caps 의 막힌 이유 코드 → 화면 문장. 코드를 모르면 빈 문자열(옛 서버는 caps 가 없어 화면이 예전 규칙으로 가린다) */
export function capWhy(d: ProfileDetailData, tab: string): string {
  const reason = d.caps?.[tab]?.reason;
  if (!reason) return '';
  const key = `profiles.why.${reason}` as Parameters<typeof t>[0];
  const text = t(key);
  return text === key ? '' : text;
}

/** 거절·안내 문구의 글자는 기본 글자색으로 두고 색은 아이콘과 테두리에만 쓴다(디자인 결정 6A, TD9) */
/** 탭 본문의 읽기 오류. 작업공간이 다시 뜨는 중이면 노란 경고 대신 회색 한 줄 — 이유는 서랍 위 안내가 말한다(스펙 2026-10-23-008) */
export function PaneUnreadable({ d, children }: { d: ProfileDetailData; children: ReactNode }) {
  if (d.restarting) return <Typography color="text.secondary">{t('profiles.restartingPane')}</Typography>;
  return <>{children}</>;
}

export const calmAlertSx = { color: 'text.primary', border: '1px solid', borderColor: 'divider' } as const;

/** 프로파일 파일의 실제 위치(Hermes 데이터 폴더 기준). 기본(루트) 프로파일은 폴더 바로 아래, 이름 있는 프로파일은 profiles/<이름>/ 아래다.
 *  OKE 의 사용자 Hermes(HERMES_HOME=/opt/data)에서 확인했다(2026-10-17-016). 데이터 폴더 경로는 설치마다 달라 앞부분은 빼고 보인다 */
export const profileFilePath = (name: string, isRoot: boolean, file: string) => (isRoot ? file : `profiles/${name}/${file}`);
