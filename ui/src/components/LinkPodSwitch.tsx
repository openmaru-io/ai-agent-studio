/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 바깥에서 받은 화면 링크에 ?pod= 가 있고 지금 보는 AI 에이전트 작업공간과 다르면 바꿀지 묻는다(스펙 2026-10-28-001 §3-7 ⑥, 디자인 D11).
// Claude Code 의 secret_request·credential_request 링크가 이 꼴이다. 바꾸면 pod 를 뺀 같은 주소(name·pane·key)로 새로 고치고,
// 바꾸지 않으면 pod 만 지운다 — 다시 묻지 않게. 볼 수 없는 에이전트(내 목록에 없음)면 묻지 않는다.
// 묻는 곳은 그 링크(`#/profiles?pod=…&name=…`, 서버 mcp_server._screen_link)뿐이다(사용자 결정 D14, 2026-10-29). 채팅·목록 서랍 등
// 다른 화면의 pod 는 화면이 스스로 처리한다 — 채팅은 그 묶음을 열고, 목록 서랍(useRoutePage)은 열지 않고 알린 뒤 지운다.
import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { t } from '@/i18n';
import { agentLabel } from '@/lib/agentLabel';
import type { Me } from '@/lib/data';
import { switchPod } from '@/lib/pod';

import { useConfirm } from './ConfirmDialog';

/** 링크의 pod 가 바꿀 대상인가. 같거나 모르는(볼 수 없는) 에이전트면 null */
export function linkPodTarget(search: string, me: Pick<Me, 'pod' | 'pods'> | undefined): Me['pods'][number] | null {
  const wanted = new URLSearchParams(search).get('pod') ?? '';
  if (!wanted || !me?.pod || wanted === me.pod.id) return null;
  return me.pods.find((p) => p.id === wanted) ?? null;
}

/** pod 를 뺀 같은 화면 주소(해시 라우터 기준) */
export function withoutPod(pathname: string, search: string): string {
  const q = new URLSearchParams(search);
  q.delete('pod');
  const rest = q.toString();
  return pathname + (rest ? `?${rest}` : '');
}

export function LinkPodSwitch({ me }: { me: Me | undefined }) {
  const loc = useLocation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const asked = useRef('');
  const target = loc.pathname === '/profiles' && new URLSearchParams(loc.search).get('name') ? linkPodTarget(loc.search, me) : null;
  useEffect(() => {
    if (!target || asked.current === target.id + loc.search) return;
    asked.current = target.id + loc.search;
    const next = withoutPod(loc.pathname, loc.search);
    void confirm(t('shell.linkPodAsk', { agent: agentLabel(target) }), { title: t('shell.linkPodTitle'), confirmLabel: t('shell.linkPodOk') }).then(
      async (ok) => {
        if (!ok) {
          navigate(next, { replace: true });
          return;
        }
        await switchPod(target.id);
        window.history.replaceState(null, '', `#${next}`);
        window.location.reload();
      }
    );
  }, [target, loc.pathname, loc.search, confirm, navigate]);
  return null;
}
