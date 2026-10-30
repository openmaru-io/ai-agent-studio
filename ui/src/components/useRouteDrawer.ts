/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 주소의 검색 값(예: `?name=ma`)이 있으면 목록 화면 위에 상세 서랍을 연다. 프로파일·호출 흐름 상세와 목록 서랍(useRoutePage)이 쓴다.
// - 다른 화면의 링크(`profiles?name=…`)와 뒤로 가기는 그대로 동작한다: 값이 생기면 열고, 바뀌면 바꾸고, 사라지면 치운다.
// - 값이 사라지거나 다른 값으로 바뀔 때 그 서랍에 저장 확인이 걸려 있으면 먼저 묻는다. 취소하면 앞 주소로 되돌려 서랍을 남긴다
//   (스펙 2026-10-28-014 D6·D11). 화면을 떠날 때(viewId 가 바뀜)는 지금처럼 묻지 않고 치운다.
// - 사용자가 서랍을 닫으면: 화면 안에서 열며 쌓은 기록 칸(useOpenParam 의 표시)이면 그 칸을 되감고, 아니면(링크로 들어옴)
//   그 값과 딸린 값(`also`, 예: 탭)을 주소에서 지운다(replace, D9).
// - 값이 같아도 주소가 새로 바뀌었고(location.key) 서랍이 없으면 다시 연다 — 검색 팔레트·「이 화면으로 열기」·가이드가 서랍만 치운 뒤
//   같은 행을 누른 경우다(외부 검토 C2).
import { ReactNode, useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import { CloseGuard, useUi } from './UiContext';

/** 검색 값 일부만 바꾼 새 값(null·빈 값이면 지운다) */
const patched = (prev: URLSearchParams, changes: Record<string, string | null | undefined>) => {
  const next = new URLSearchParams(prev);
  for (const [k, v] of Object.entries(changes)) {
    if (v) next.set(k, v);
    else next.delete(k);
  }
  return next;
};

/**
 * 지금 주소의 검색 값을 일부만 바꾼다(null 이면 지운다). 나머지(목록의 탭·검색·필터)는 그대로 둔다.
 * 🔴 상세 서랍을 열고 닫거나 서랍 안에서 탭을 바꿀 때 `navigate('/flows?root=…')` 처럼 주소를 새로 만들면 뒤의 목록이 보던
 *    탭(`tab=skill`)이 사라져 첫 탭으로 돌아간다(2026-10-13 사용자 보고). 이 함수로 바꾼다.
 */
export function useParamPatch() {
  const [, setParams] = useSearchParams();
  const ref = useRef(setParams);
  ref.current = setParams;
  return useCallback(
    (changes: Record<string, string | null | undefined>, opts?: { replace?: boolean }) => ref.current((prev) => patched(prev, changes), opts),
    []
  );
}

/** 화면 안에서 서랍을 열며 쌓은 기록 칸의 표시(location.state). 닫을 때 이 칸이면 되감는다(스펙 2026-10-28-014 D9) */
const PUSHED = 'aasDrawerPush';
const pushedBy = (state: unknown, param: string) => !!state && typeof state === 'object' && (state as Record<string, unknown>)[PUSHED] === param;

/**
 * 목록 행을 눌러 주소 서랍을 열 때 쓰는 함수(D9). 서랍이 닫혀 있으면(주소에 param 이 없으면) 기록을 한 칸 쌓고 그 칸에 표시를 둔다.
 * 열려 있으면 지금 칸을 바꾼다(replace, 표시는 그대로) — 서랍끼리 바꿔도 기록이 늘지 않고, 닫은 서랍이 뒤로 가기에 되살아나지 않는다.
 */
export function useOpenParam(param: string) {
  const [params, setParams] = useSearchParams();
  const loc = useLocation();
  const ref = useRef({ params, setParams, state: loc.state as unknown });
  ref.current = { params, setParams, state: loc.state };
  return useCallback(
    (changes: Record<string, string | null | undefined>) => {
      const { params: now, setParams: set, state } = ref.current;
      set((prev) => patched(prev, changes), now.get(param) ? { replace: true, state } : { state: { [PUSHED]: param } });
    },
    [param]
  );
}

export interface RouteDrawerContent {
  title: string;
  sub?: string;
  /** 부제목 앞 요소·제목 초점 열쇠(DrawerSpec 과 같다, 스펙 2026-10-19-011 D5·D7) */
  subLead?: ReactNode;
  focusKey?: string;
  body: ReactNode;
  wide?: boolean;
}

type Build = (value: string, guard: (fn: CloseGuard | null) => void) => RouteDrawerContent;

/** 서랍 id 별로 열어 둔 서랍의 주소 값과 그 서랍이 맞던 마지막 주소 검색 값(useRouteDrawerValue 가 쓰고 useRouteDrawerParams 가 읽는다) */
const held = new Map<string, { value: string; search: string }>();

/**
 * 주소 서랍 본문이 읽는 주소 검색 값. 보통은 지금 주소다. 뒤로 가기 등으로 서랍의 값이 사라지거나 바뀌었고 저장 확인이 걸려 있으면
 * (useRouteDrawerValue 가 묻는 조건과 같다) 묻기 전 주소 값을 돌려준다.
 * 🔴 뒤로 가기는 주소가 이미 바뀐 뒤에 묻는다. 본문이 주소를 직접 읽으면 묻는 동안 바뀐 주소(예: pane 없음)로 다시 그려져 편집기가 닫히고,
 *    취소해도 고치던 글과 「저장하지 않음」이 사라진다(OKE 2026-10-29, 스펙 2026-10-28-014 D6·D11). 묻는 결과는 effect 에서 나오므로
 *    그리기 중에 같은 조건으로 판단한다.
 */
export function useRouteDrawerParams(param: string): URLSearchParams {
  const [params] = useSearchParams();
  const { hasCloseGuard } = useUi();
  const id = `route:${param}`;
  const h = held.get(id);
  return h && params.get(param) !== h.value && hasCloseGuard(id) ? new URLSearchParams(h.search) : params;
}

/**
 * @param param 서랍을 여는 검색 값 이름
 * @param build 값으로 서랍 내용을 만든다. `guard` 를 본문에 넘기면 본문이 「저장하지 않은 편집」 확인을 건다.
 * @param also 서랍을 닫을 때 함께 지울 검색 값(탭·보기 방식 등)
 * @param deps 값이 그대로여도 서랍 내용을 다시 만들 때 바뀌는 것(예: 나중에 읽힌 제목). 첫 페이지 내용만 바꾼다 —
 *   서랍 안에서 옮긴 페이지·기록·위에 쌓인 서랍은 그대로다(스펙 2026-10-26-003 리뷰 D3·외부 검토 H5)
 * @param resetOn 바뀌면 주소 값처럼 서랍을 새로 여는 것(기록을 첫 페이지 하나로). 대상이 바뀌는 값이다(프로파일 서랍의 에이전트, 외부 검토 M5)
 */
export function useRouteDrawer(param: string, build: Build, also: string[] = [], deps: unknown[] = [], resetOn: unknown[] = []): string | null {
  const [params] = useSearchParams();
  const value = params.get(param);
  useRouteDrawerValue(param, value, build, also, deps, resetOn);
  return value;
}

/**
 * useRouteDrawer 의 몸통. 서랍을 열 값을 부르는 쪽이 정한다 — 목록 서랍(useRoutePage)은 다른 POD 의 링크면 주소에 값이 있어도 열지 않는다.
 * 서랍 id 는 `route:<param>` 이다.
 */
export function useRouteDrawerValue(param: string, value: string | null, build: Build, also: string[] = [], deps: unknown[] = [], resetOn: unknown[] = []) {
  const [, setParams] = useSearchParams();
  const loc = useLocation();
  const navigate = useNavigate();
  const { openDrawer, refreshRoot, dismissDrawer, setCloseGuard, hasCloseGuard, runGuard, drawers } = useUi();
  const id = `route:${param}`;
  // 닫을 때는 그때의 주소에서 지운다(열 때의 주소로 되돌리면 그 사이 바뀐 탭 값이 되살아난다)
  const setParamsRef = useRef(setParams);
  setParamsRef.current = setParams;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const locRef = useRef(loc);
  locRef.current = loc;
  const buildRef = useRef(build);
  buildRef.current = build;
  const drawersRef = useRef(drawers);
  drawersRef.current = drawers;
  const guard = useCallback((fn: CloseGuard | null) => setCloseGuard(id, fn), [id, setCloseGuard]);

  // 지금 열어 둔 서랍의 주소 값·resetOn. 같으면 deps 만 바뀌었거나 주소의 다른 값이 바뀐 것이다
  const opened = useRef<string | null>(null);
  // 지금 열어 둔 서랍의 주소 값. 저장 확인은 이 값이 사라지거나 바뀔 때만 묻는다 — resetOn(프로파일 서랍의 에이전트)은 주소 값이 아니고,
  // 에이전트를 바꾸는 쪽이 먼저 묻는다(AgentScope). 처음 읽을 때 빈 값에서 채워지는 것도 바뀜이 아니다
  const openedValue = useRef<string | null>(null);
  // 열어 둔 서랍이 맞던 마지막 주소 검색 값. 저장 확인을 취소하면 이 값으로 되돌린다
  const shown = useRef('');
  const lastDeps = useRef<unknown[]>(deps);
  // 저장 확인을 묻는 중인 새 값(같은 값으로 다시 돌면 또 묻지 않는다)과 차례 번호(그 사이 주소가 또 바뀌면 앞 답은 버린다)
  const asking = useRef<{ key: string | null } | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const key = value ? JSON.stringify([value, ...resetOn]) : null;
    const depsChanged = deps.length !== lastDeps.current.length || deps.some((d, i) => !Object.is(d, lastDeps.current[i]));
    lastDeps.current = deps;
    if (asking.current && asking.current.key === key) return;
    const turn = (seq.current += 1);
    const has = drawersRef.current.some((d) => d.id === id);

    // 서랍이 지금 주소와 맞는다: 저장 확인을 취소하면 돌아갈 주소로 둔다(본문도 묻는 동안 이 값을 읽는다)
    const mark = (v: string) => {
      shown.current = locRef.current.search;
      held.set(id, { value: v, search: shown.current });
    };
    const apply = () => {
      if (!value) {
        opened.current = null;
        openedValue.current = null;
        held.delete(id);
        dismissDrawer(id);
        return;
      }
      if (opened.current === key) {
        // 같은 대상: deps 가 바뀌었으면 첫 페이지 내용만 바꾸고, 그대로면 둔다. 서랍이 없으면(검색 팔레트가 치움 등) 아래에서 다시 연다
        if (depsChanged ? refreshRoot(id, buildRef.current(value, guard)) : has) {
          mark(value);
          return;
        }
      }
      const content = buildRef.current(value, guard);
      opened.current = key;
      openedValue.current = value;
      mark(value);
      openDrawer({
        ...content,
        id,
        keep: true,
        onClose: () => {
          if (pushedBy(locRef.current.state, param)) navigateRef.current(-1);
          else
            setParamsRef.current(
              (prev) => {
                const next = new URLSearchParams(prev);
                for (const k of [param, ...also]) next.delete(k);
                return next;
              },
              { replace: true }
            );
        },
      });
    };

    // 열린 서랍의 대상이 사라지거나 바뀌었고 저장 확인이 걸려 있다: 먼저 묻는다(D6·D11)
    if (openedValue.current && openedValue.current !== value && has && hasCloseGuard(id)) {
      const back = shown.current;
      asking.current = { key };
      void runGuard(id).then((ok) => {
        if (asking.current?.key === key) asking.current = null;
        if (turn !== seq.current) return;
        if (ok) {
          setCloseGuard(id, null); // 새 본문이 같은 id 로 다시 건다
          apply();
          return;
        }
        // 취소: 앞 주소로 되돌려 서랍과 값을 남긴다. 앞으로 가기 기록은 한 칸 어긋날 수 있다(§8, D6·D11 에서 받아들임)
        setParamsRef.current(new URLSearchParams(back), { replace: true, state: locRef.current.state });
      });
      return;
    }
    apply();
    // also 는 화면마다 고정이다
  }, [value, ...resetOn, ...deps, loc.key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(
    () => () => {
      held.delete(id);
      dismissDrawer(id);
    },
    [dismissDrawer, id]
  );
}
