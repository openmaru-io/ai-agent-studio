/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 프로파일 서랍 개요의 「들어 있는 에이전트」·「같은 이름이 있는 에이전트」 줄과 같은 이름 칩으로 에이전트를 바꾸는 흐름(스펙 2026-10-19-011).
// 프로파일은 에이전트마다 데이터 볼륨 안에 따로 있다. 이름이 같아도 다른 프로파일이라 「같은 이름」으로만 묶어 보이고, 누르면 그 에이전트로 바꿔 연다.
// 목록은 006 의 /api/agents(토픽 agents)가 주는 에이전트별 프로파일 이름을 화면에서 거른다 — 서버를 새로 두지 않는다(리뷰 D8).
import { Alert, Box, Button, Typography } from '@mui/material';
import { visuallyHidden } from '@mui/utils';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type SnackbarKey, useSnackbar } from 'notistack';
import { MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { AgentDot } from '@/components/AgentChip';
import { useOpenInDrawer } from '@/components/bits';
import { Pill } from '@/components/DataGrid';
import { useUi } from '@/components/UiContext';
import { t } from '@/i18n';
import { get, post } from '@/lib/api';
import { useMe } from '@/lib/data';
import { switchPod } from '@/lib/pod';
import { useTopic } from '@/lib/ws';

import { useProfileSpot } from './spot';

interface AgentRow {
  name: string;
  owner: string;
  display_name: string;
  profiles?: string[] | null;
  /** 채팅이 먼저 여는 프로파일(006) */
  chat_default?: string;
}

/** 프로파일 서랍의 주소 서랍 id(useRouteDrawer('name')). 저장 안 한 편집 확인을 여기서 부른다(리뷰 2회차 R7) */
const DRAWER_ID = 'route:name';

/** 에이전트 목록(006). 웹소켓이면 토픽 agents 가 바뀐 목록을 보낸다. 쿠버네티스가 아니면 빈 목록이다 */
export function useAgentList(): AgentRow[] | undefined {
  const qc = useQueryClient();
  useTopic<{ agents?: AgentRow[] }>('agents', (d) => qc.setQueryData(['hermes-agents'], d));
  const q = useQuery<{ agents?: AgentRow[] }>({ queryKey: ['hermes-agents'], queryFn: () => get('/api/agents'), staleTime: 5000 });
  return q.data?.agents;
}

/** 지금 에이전트가 목록에 있는가 */
export function useAgentScope() {
  const pod = useMe().data?.pod?.id ?? '';
  const list = useAgentList();
  return useMemo(() => ({ inList: (list ?? []).some((a) => a.name === pod) }), [list, pod]);
}

/** 바꾸기 알림의 [되돌리기]. 알림 안에 마우스나 초점이 있는 동안은 8초 타이머를 멈춘다(스펙 2026-10-19-018 디자인 DD12).
 *  notistack 은 마우스만 멈추고 초점은 보지 않아, 알림을 persist 로 띄우고 여기서 직접 닫는다 */
function UndoAction({ id, onUndo }: { id: SnackbarKey; onUndo: () => void }) {
  const { closeSnackbar } = useSnackbar();
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const root = ref.current?.closest('[role="alert"]') ?? ref.current?.parentElement;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hover = false;
    let focus = false;
    const arm = () => {
      clearTimeout(timer);
      if (!hover && !focus) timer = setTimeout(() => closeSnackbar(id), UNDO_MS);
    };
    const on = (e: Event) => {
      if (e.type === 'mouseenter') hover = true;
      else if (e.type === 'mouseleave') hover = false;
      else if (e.type === 'focusin') focus = true;
      else if (e.type === 'focusout') focus = root?.contains((e as FocusEvent).relatedTarget as Node | null) ?? false;
      arm();
    };
    const kinds = ['mouseenter', 'mouseleave', 'focusin', 'focusout'];
    kinds.forEach((k) => root?.addEventListener(k, on));
    arm();
    return () => {
      clearTimeout(timer);
      kinds.forEach((k) => root?.removeEventListener(k, on));
    };
  }, [id, closeSnackbar]);
  return (
    <Button
      ref={ref}
      color="inherit"
      size="small"
      onClick={() => {
        closeSnackbar(id);
        onUndo();
      }}
    >
      {t('profiles.switchUndo')}
    </Button>
  );
}

/** 바꾸기 알림이 떠 있는 시간(011 디자인 D13) */
const UNDO_MS = 8000;

/** 주소의 서랍 값(name·pane). 바꾸기 직전 값을 기억했다가 [되돌리기] 때 함께 되돌린다(디자인 DD6) */
type DrawerSpot = { name: string | null; pane: string | null };

/** 같은 이름 칩·모은 목록의 다른 에이전트 줄·되돌리기가 함께 쓰는 바꾸기(리뷰 2회차 R7, 디자인 D7·D8·D13, 2026-10-19-018 A3·B4).
 *  확인 → 바꾸기 → 내 정보 → 서랍 주소 → 나머지 무효화 순서다. open 은 바꾼 뒤 열 프로파일, restore 는 되돌릴 때의 주소다.
 *  되돌리기는 바꾸기 직전의 name·pane 을 함께 되돌린다 — 에이전트만 되돌리면 다른 에이전트의 main 을 열고 되돌렸을 때
 *  원래 에이전트의 main 이 아무 안내 없이 서랍에 떴다(디자인 DD6) */
export function useSwitchToSameName() {
  const qc = useQueryClient();
  const { runGuard, confirmAll, dismissDrawer } = useUi();
  const { enqueueSnackbar } = useSnackbar();
  const [params, setParams] = useSearchParams();
  // 서랍 안에서 연 프로파일 페이지에서 바꾸면 다른 메뉴 위일 수 있다 — 바꾼 뒤 프로파일 메뉴로 옮겨 연다(스펙 2026-10-26-003 2단계).
  // 에이전트가 바뀌면 주소 서랍도 새로 열리므로(resetOn) 서랍 안 기록을 이어 갈 수 없다
  const inPage = useProfileSpot().page;
  const navigate = useNavigate();
  const latest = useRef(params);
  latest.current = params;
  const go = useCallback(
    async (to: { pod: string; label: string }, back?: { pod: string; label: string }, opts?: { open?: string; restore?: DrawerSpot }): Promise<boolean> => {
      if (!(await (inPage ? confirmAll() : runGuard(DRAWER_ID)))) return false; // 저장 안 한 편집이 있고 취소했다
      const before: DrawerSpot = { name: latest.current.get('name'), pane: latest.current.get('pane') };
      try {
        await switchPod(to.pod);
      } catch (e) {
        enqueueSnackbar(t('profiles.switchFailed', { agent: to.label, reason: (e as Error).message }), { variant: 'error' });
        return false;
      }
      // 내 정보(지금 에이전트)를 먼저 받아 서랍 머리가 곧바로 새 에이전트를 가리키게 하고, 나머지는 기다리지 않고 다시 읽는다(Fleet 과 같다, R6)
      await qc.refetchQueries({ queryKey: ['me'] });
      // 서랍 주소는 에이전트가 바뀐 뒤에 바꾼다 — 먼저 열면 옛 에이전트에서 찾다가 「없음」이 잠깐 보였다(디자인 DD6, B4)
      const spot = opts?.restore ?? (opts?.open !== undefined ? { name: opts.open, pane: null } : null);
      if (spot && inPage) {
        dismissDrawer();
        navigate(`/profiles?${new URLSearchParams(Object.entries(spot).filter((e): e is [string, string] => !!e[1]))}`);
      } else if (spot)
        setParams((prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(spot)) {
            if (v) next.set(k, v);
            else next.delete(k);
          }
          return next;
        });
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
      enqueueSnackbar(t('profiles.switched', { agent: to.label }), {
        variant: 'success',
        ...(back
          ? { persist: true, action: (key: SnackbarKey) => <UndoAction id={key} onUndo={() => void go(back, undefined, { restore: before })} /> }
          : { autoHideDuration: UNDO_MS }),
      });
      return true;
    },
    [qc, runGuard, confirmAll, dismissDrawer, inPage, navigate, enqueueSnackbar, setParams]
  );
  return go;
}

/** 지금 에이전트가 바뀌면 서랍 안에서 「지금 에이전트: <이름>」을 한 번 읽어 준다(디자인 DD12).
 *  서랍이 열려 있으면 서랍 밖의 알림은 낭독기에서 가려진다(aria-hidden). 서랍이 새로 그려져도 앞 값을 기억하도록 모듈에 둔다 */
let announcedPod = '';
/** silent: 읽지 않고 처음 에이전트만 기억한다(목록 화면). 바꾼 뒤의 값은 서랍 쪽이 비교하고 적는다 —
 *  목록이 먼저 새 값을 적으면 뒤에 열리는 서랍이 바뀐 것을 몰랐다 */
export function AgentAnnouncer({ silent }: { silent?: boolean }) {
  const pod = useMe().data?.pod;
  const [text, setText] = useState('');
  useEffect(() => {
    if (!pod?.id) return;
    if (silent) {
      if (!announcedPod) announcedPod = pod.id;
      return;
    }
    if (announcedPod && announcedPod !== pod.id) setText(t('profiles.nowAgent', { agent: pod.name || pod.id }));
    announcedPod = pod.id;
  }, [pod?.id, pod?.name, silent]);
  if (silent) return null;
  return (
    <Box aria-live="polite" data-agent-announcer="" sx={visuallyHidden}>
      {text}
    </Box>
  );
}

/** 「채팅 기본으로」(스펙 2026-10-19-018 C·리뷰 D2·디자인 DD5). 에이전트 「수정」 창과 같은 /api/agents/update 로 저장하고,
 *  성공 알림의 [되돌리기]는 앞 값으로 같은 요청을 다시 보낸다. busy 는 저장 중인 줄(에이전트:프로파일) */
export function useMakeChatDefault() {
  const qc = useQueryClient();
  const { enqueueSnackbar, closeSnackbar } = useSnackbar();
  const [busy, setBusy] = useState('');
  const save = useCallback(
    async (pod: string, name: string, agent: string, before?: string): Promise<void> => {
      setBusy(`${pod}:${name}`);
      try {
        await post('/api/agents/update', { name: pod, chat_default: name });
        void qc.invalidateQueries({ queryKey: ['profiles'] });
        void qc.invalidateQueries({ queryKey: ['hermes-agents'] });
        enqueueSnackbar(t('profiles.chatDefaultSet', { agent, name }), {
          variant: 'success',
          autoHideDuration: 8000,
          action:
            before && before !== name
              ? (key) => (
                  <Button
                    color="inherit"
                    size="small"
                    onClick={() => {
                      closeSnackbar(key);
                      void save(pod, before, agent);
                    }}
                  >
                    {t('profiles.switchUndo')}
                  </Button>
                )
              : undefined,
        });
      } catch (e) {
        enqueueSnackbar(t('profiles.chatDefaultFailed', { reason: (e as Error).message }), { variant: 'error' });
      } finally {
        setBusy('');
      }
    },
    [qc, enqueueSnackbar, closeSnackbar]
  );
  return { save, busy };
}

/** 서랍 개요의 「채팅 기본」 값(스펙 2026-10-19-018 C2): 이 프로파일이면 「채팅 기본」, 아니면 주인·관리자에게 [채팅 기본으로] 작은 단추.
 *  에이전트 목록(006, /api/agents)의 chat_default 를 본다 — 쿠버네티스가 아닌 구성은 목록이 없어 줄을 두지 않는다 */
export function ChatDefaultValue({ name, canChange }: { name: string; canChange: boolean }) {
  const pod = useMe().data?.pod;
  const row = useAgentList()?.find((a) => a.name === pod?.id);
  const chat = useMakeChatDefault();
  if (!pod || !row) return null;
  if (row.chat_default === name) return <Pill>{t('profiles.chatDefaultYes')}</Pill>;
  if (!canChange) return <span>—</span>;
  return (
    <Button
      size="small"
      variant="outlined"
      disabled={chat.busy === `${pod.id}:${name}`}
      onClick={() => void chat.save(pod.id, name, pod.name || pod.id, row.chat_default)}
    >
      {t('profiles.makeChatDefault')}
    </Button>
  );
}

/** 「들어 있는 에이전트」 값: 목록에 있으면 그 에이전트 서랍을 여는 글자 링크(D15·R5), 없으면 글자만. 아래에 안내를 단다 */
export function AgentRowValue({ inList }: { inList: boolean }) {
  const pod = useMe().data?.pod;
  const openHere = useOpenInDrawer();
  if (!pod) return null;
  const label = pod.name || pod.id;
  const body = (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
      <AgentDot name={pod.id} />
      <span>{label}</span>
      {inList && <span aria-hidden="true">›</span>}
    </Box>
  );
  return (
    <Box>
      {inList ? (
        // 글자 색은 표의 다른 값과 같게 둔다. 맨 Link 는 브라우저 기본 링크 색(방문 뒤 보라)이 나온다
        <Box
          component={Link}
          to={`/agents?open=${encodeURIComponent(pod.id)}`}
          // 프로파일 서랍 안이면 같은 서랍에 그 작업공간을 연다(스펙 2026-10-26-003 2단계)
          onClick={(e: MouseEvent) => openHere(e, { kind: 'agent', pod: pod.id })}
          title={pod.id}
          sx={{ color: 'inherit', textDecoration: 'none', '&:hover, &:focus-visible': { textDecoration: 'underline' } }}
        >
          {body}
        </Box>
      ) : (
        <Box component="span" title={pod.id}>
          {body}
        </Box>
      )}
      <Typography variant="caption" color="text.secondary" component="p" data-agent-row-hint="">
        {t('profiles.agentRowHint')}
      </Typography>
    </Box>
  );
}

/** 같은 이름 칩으로 왔는데 그 에이전트에 이 이름의 프로파일이 없다(서버 404, 리뷰 2회차 R8·디자인 D9). 서랍을 닫고 목록으로 갈 수 있다 */
export function NotInAgent({ name }: { name: string }) {
  const pod = useMe().data?.pod;
  const spot = useProfileSpot();
  return (
    <Box data-not-in-agent="" sx={{ py: 2 }}>
      <Typography variant="body2" sx={{ mb: 1.5 }}>
        {t('profiles.notInAgent', { agent: pod?.name || pod?.id || '', name })}
      </Typography>
      <Button
        variant="outlined"
        size="small"
        onClick={() => spot.patch({ name: null, pane: null })}
      >
        {t('profiles.viewProfiles')}
      </Button>
    </Box>
  );
}

/** 저장 요청이 「다른 에이전트로 바뀜」(409)으로 거절됐는가. useProfileAct 가 세운다(R1 ③) */
export const AGENT_CHANGED_KEY = ['profile-agent-changed'] as const;

/** 다른 탭에서 에이전트가 바뀐 뒤 저장했을 때의 서랍 안 경고(디자인 D10). 고치던 글은 임시 저장본으로 남는다(디자인 D6) */
export function AgentChangedAlert() {
  const changed = useQuery<boolean>({ queryKey: AGENT_CHANGED_KEY, queryFn: () => false, staleTime: Infinity, initialData: false }).data;
  if (!changed) return null;
  return (
    <Alert
      severity="warning"
      data-agent-changed=""
      sx={{ mb: 1.5 }}
      action={
        <Button color="inherit" size="small" onClick={() => window.location.reload()}>
          {t('profiles.reload')}
        </Button>
      }
    >
      {t('profiles.agentChanged')}
    </Alert>
  );
}
