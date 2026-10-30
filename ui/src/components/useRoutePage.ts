/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 목록 화면의 상세 서랍을 주소(`open`, +`tab`·`pod`)와 묶는 공용 훅(스펙 2026-10-28-014 D8·D10·D12).
// 주소 → pageFromLink(화면, 주소 값) → drawerSpecFor(페이지) 로 keep 서랍(id `route:open`)을 연다. 본문(AgentPage·SkillPage 등)이 자료를
// 스스로 읽고 대상이 없으면 notFound 안내를 보인다 — 그래서 화면마다 행 찾기·갱신·없음 처리를 따로 쓰지 않는다.
// 열기·닫기·저장 확인·같은 값 다시 열기는 useRouteDrawer 와 같은 몸통(useRouteDrawerValue)을 쓴다.
// - 행 클릭(openRow)은 주소에 open(+지금 POD)을 쓴다. 서랍이 닫혀 있으면 push, 열려 있으면 replace(D9, useOpenParam).
// - pod 가 지금 POD 와 다른 링크는 지금 POD 의 같은 이름을 열지 않는다(D10). 볼 수 있는 POD 든 아니든 바꿔 열지 않고, 알린 뒤 open·pod 를
//   지운다(사용자 결정 D14, 2026-10-29 — 작업공간 전환 확인(LinkPodSwitch)은 Claude Code 프로파일 링크에서만 묻는다).
//   pod 가 없는 옛 링크·지금 POD 와 같은 링크는 지금 POD 로 연다.
// - 탭을 바꾸면 open·pod 를 지운다(ListView 의 clearOnTab 에 OPEN_PARAMS 를 넘긴다, D12).
import { useSnackbar } from 'notistack';
import { useCallback, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

import { t } from '@/i18n';
import { useMe } from '@/lib/data';

import { drawerSpecFor, pageFromLink } from './drawerPages';
import { useOpenParam, useRouteDrawerValue } from './useRouteDrawer';

/** 목록 서랍의 주소 값. 탭을 바꾸면 함께 지운다(ListView clearOnTab) */
export const OPEN_PARAMS = ['open', 'pod'];

/**
 * @param view 화면 id(pageFromLink 의 view)
 * @param opts.pod 주소에 지금 POD 를 함께 쓰는가. 에이전트(값이 POD id)·사람 관리(POD 와 관계없음)는 false
 * @returns open: 서랍을 연 대상(선택 행 표시, ListView openId) · openRow: 행을 눌렀을 때 · clearOnTab: ListView 에 넘긴다
 */
export function useRoutePage(view: string, opts: { pod?: boolean } = {}) {
  const withPod = opts.pod !== false;
  const [params, setParams] = useSearchParams();
  const me = useMe().data;
  const { enqueueSnackbar } = useSnackbar();
  const open = params.get('open');
  const linkPod = withPod ? params.get('pod') : null;
  const here = me?.pod?.id ?? null;
  // 지금 POD 와 다른 링크인가. 내 정보를 받기 전에는 정하지 않고 열지 않는다. POD 가 없는 설치(me.pod=null)는 보지 않는다
  const foreign = !!linkPod && (!me || (!!here && linkPod !== here));
  const page = open && !foreign ? pageFromLink(view, Object.fromEntries(params)) : null;
  const pageRef = useRef(page);
  pageRef.current = page;

  const clear = useCallback(
    () =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const k of OPEN_PARAMS) next.delete(k);
          return next;
        },
        { replace: true }
      ),
    [setParams]
  );
  useEffect(() => {
    if (!me || !linkPod || !here || linkPod === here) return;
    enqueueSnackbar(t('shell.linkPodHidden'), { variant: 'warning' });
    clear();
  }, [me, linkPod, here, enqueueSnackbar, clear]);

  useRouteDrawerValue('open', page ? open : null, () => drawerSpecFor(pageRef.current!), ['pod'], [], [params.get('tab') ?? '']);

  const write = useOpenParam('open');
  const openRow = useCallback((id: string) => write({ open: id, pod: withPod ? here : null }), [write, withPod, here]);
  return { open: page ? open : null, openRow, clearOnTab: OPEN_PARAMS };
}
