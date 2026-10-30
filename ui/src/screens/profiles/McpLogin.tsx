/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// OAuth MCP 서버 행의 상태 표시와 로그인 팝업(스펙 2026-10-16-010 11-3·V1·V9·V10·V13·V17, OMAI-1263).
// 상태 판정은 서버(mcp_oauth_relay.decide)가 하고, 여기서는 그 값을 알약·주 단추·설명 줄로 바꾼다.
// 로그인은 AAS 의 팝업 시작 경로(/oauth/mcp/start)를 연다. 끝은 상태 묻기로만 판단한다 — 인가 서버의 COOP 로
// pop.closed 를 믿을 수 없다(V10).
import { useCallback, useEffect, useRef, useState } from 'react';

import type { PillTone } from '@/components/StatusPill';
import { t } from '@/i18n';
import { get, post } from '@/lib/api';

import type { McpItem } from './types';

export type LoginAction = 'login' | 'relogin' | 'cancel' | 'test' | 'none';

export interface LoginView {
  tone: PillTone;
  label: string;
  primary: LoginAction;
  note: string;
}

/** 서버가 준 login_state 를 행 모습으로(11-3). 보기 권한자는 단추 없이 「에이전트 주인이 로그인해야 합니다」(V17) */
export function loginView(m: McpItem, mayEdit: boolean): LoginView {
  const ls = m.login_state ?? { state: 'unknown' as const };
  const plain = `${m.target} · OAuth`;
  let v: LoginView;
  switch (ls.state) {
    case 'login_required':
      v = {
        tone: 'warn',
        label: t('profiles.mcp.login.required'),
        primary: 'login',
        note: t('profiles.mcp.login.requiredNote'),
      };
      break;
    case 'logging_in':
      v = ls.connecting
        ? {
            tone: 'neutral',
            label: t('profiles.mcp.login.connecting'),
            primary: 'none',
            note: t('profiles.mcp.login.connectingNote'),
          }
        : ls.mine
        ? {
            tone: 'neutral',
            label: t('profiles.mcp.login.inProgress'),
            primary: 'cancel',
            note: t('profiles.mcp.login.inProgressNote'),
          }
        : {
            tone: 'neutral',
            label: t('profiles.mcp.login.inProgress'),
            primary: 'none',
            note: t('profiles.mcp.login.otherNote'),
          };
      break;
    case 'disabled_logged_in':
      v = {
        tone: 'neutral',
        label: t('profiles.mcp.login.offLoggedIn'),
        primary: 'none',
        note: t('profiles.mcp.login.offLoggedInNote'),
      };
      break;
    case 'connected':
      v = {
        tone: 'good',
        label:
          ls.tools != null
            ? t('profiles.mcp.login.connectedTools', { count: ls.tools })
            : t('profiles.mcp.login.connected'),
        primary: 'test',
        note: plain,
      };
      break;
    case 'reauth_required':
      v = {
        tone: 'warn',
        label: t('profiles.mcp.login.reauth'),
        primary: 'relogin',
        note: t('profiles.mcp.login.reauthNote'),
      };
      break;
    case 'connect_failed':
      v = { tone: 'bad', label: t('profiles.mcp.login.failed'), primary: 'test', note: ls.message || plain };
      break;
    case 'unavailable':
      v = { tone: 'neutral', label: t('profiles.mcp.login.unavailable'), primary: 'none', note: ls.message || '' };
      break;
    default:
      v = { tone: 'neutral', label: t('profiles.mcp.login.unknown'), primary: 'login', note: plain };
  }
  if (!mayEdit && v.primary !== 'test') {
    const needsOwner = v.primary === 'login' || v.primary === 'relogin';
    v = { ...v, primary: 'none', note: needsOwner ? t('profiles.mcp.login.ownerMust') : v.note };
  }
  if (!mayEdit && v.primary === 'test') v = { ...v, primary: 'none' };
  return v;
}

interface FlowStatus {
  status: 'none' | 'waiting' | 'approved' | 'error' | 'cancelled' | 'expired';
  error?: string;
  reason?: string;
}

export type LoginEnd = 'approved' | 'error' | 'cancelled' | 'expired';

const POLL_MS = 2000;
const GIVE_UP_MS = 660_000; // 서버 기록을 받는 시간과 같다(R7)

/**
 * 로그인 팝업을 열고 끝날 때까지 2초마다 상태를 묻는다.
 * 이전 로그인의 끝난 기록을 새 결과로 읽지 않도록, 흐름이 진행 중(waiting)인 것을 한 번 본 뒤의 끝 상태만 받는다.
 * resume: 서버가 「내가 시작한 로그인 중」이라고 알려 준 행(새로고침 뒤 이어서 묻는다).
 */
export function useMcpLogin({
  pod,
  profile,
  server,
  resume,
  onEnd,
}: {
  pod: string;
  profile: string;
  server: string;
  resume: boolean;
  onEnd: (end: LoginEnd, error?: string) => void;
}) {
  const [active, setActive] = useState(false);
  const seen = useRef(false);
  const startedAt = useRef(0);
  const endRef = useRef(onEnd);
  endRef.current = onEnd;
  const qs = new URLSearchParams({ pod, profile, server }).toString();

  const finish = useCallback((end: LoginEnd, error?: string) => {
    setActive(false);
    seen.current = false;
    endRef.current(end, error);
  }, []);

  useEffect(() => {
    if (resume && !active) {
      seen.current = true;
      startedAt.current = Date.now();
      setActive(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resume]);

  useEffect(() => {
    if (!active) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (stop) return;
      if (Date.now() - startedAt.current > GIVE_UP_MS) {
        finish('expired');
        return;
      }
      try {
        const s = await get<FlowStatus>(`/api/mcp/oauth/status?${qs}`);
        if (stop) return;
        if (s.status === 'waiting') seen.current = true;
        else if (seen.current && s.status !== 'none') {
          finish(s.status as LoginEnd, s.error);
          return;
        }
      } catch {
        // 잠깐 못 읽으면 다음 차례에 다시 묻는다
      }
      timer = setTimeout(tick, POLL_MS);
    };
    // 팝업의 마무리 화면이 보내는 알림. 창 사이 연결이 끊겨도(COOP) 상태 묻기가 같은 결과를 낸다
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { aasMcpLogin?: string; server?: string } | null;
      if (e.origin === window.location.origin && data?.aasMcpLogin === 'approved' && data.server === server)
        finish('approved');
    };
    window.addEventListener('message', onMessage);
    void tick();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener('message', onMessage);
    };
  }, [active, qs, server, finish]);

  const start = useCallback(() => {
    const url = `/oauth/mcp/start?${qs}`;
    seen.current = false;
    startedAt.current = Date.now();
    const w = window.open(url, `aas-mcp-oauth-${server}`, 'popup,width=520,height=720');
    if (!w) {
      window.location.assign(url); // 팝업이 막히면 같은 창에서 시작한다(V10)
      return;
    }
    setActive(true);
  }, [qs, server]);

  const cancel = useCallback(async () => {
    try {
      await post('/api/mcp/oauth/cancel', { pod, profile, server });
    } finally {
      finish('cancelled');
    }
  }, [pod, profile, server, finish]);

  return { active, start, cancel };
}
