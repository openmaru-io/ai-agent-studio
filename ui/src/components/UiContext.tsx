/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 화면 어디서나 쓰는 서랍(오른쪽 상세)과 검색 팔레트의 열림 상태.
//
// 서랍은 쌓인다. 주소로 여는 상세 서랍(`keep`, 프로파일·호출 흐름 — `useRouteDrawer`) 위에서 다른 서랍(이름 바꾸기·삭제 등)을
// 열면 그 위에 얹히고, 닫으면 아래 상세 서랍으로 돌아간다. `keep` 이 아닌 서랍끼리는 지금처럼 서로 바꿔 낀다.
//
// 서랍 안 기록(스펙 2026-10-26-003): 서랍 안 링크는 메뉴를 옮기지 않고 같은 서랍 안에서 대상을 바꾼다(navigateDrawer).
// 기록은 서랍마다 따로 들고(D1), 페이지 설명(DrawerPage)을 둔다(D2). 서랍 자리(_k·id·keep·onClose)는 그대로 두고 내용만 바꾼다 —
// id 를 바꾸면 「같은 id 는 그 자리 교체, 위는 버림」 규칙 때문에 쌓인 서랍이 사라진다(§9).
import type { SvgIconComponent } from '@mui/icons-material';
import { createContext, ReactNode, useCallback, useContext, useMemo, useRef, useState } from 'react';

import { DrawerPage, drawerSpecFor, pageKey } from './drawerPages';

export interface DrawerSpec {
  title: string;
  sub?: string;
  /** 부제목 앞에 붙는 작은 요소(에이전트 색 점 등, 스펙 2026-10-19-011 D5). 부제목 글자(title 속성)는 sub 그대로다. */
  subLead?: ReactNode;
  /** 이 값이 바뀌면 서랍 제목에 초점을 옮긴다(처음 열 때는 옮기지 않는다). 같은 이름으로 다른 에이전트를 열었을 때 쓴다(D7). */
  focusKey?: string;
  body: ReactNode;
  /** 같은 id 로 다시 열면 쌓지 않고 그 자리를 바꾼다. `keep` 서랍만 쓴다. */
  id?: string;
  /** 이 서랍 위에서 연 서랍은 바꿔 끼우지 않고 위에 얹는다(닫으면 이 서랍으로 돌아온다). */
  keep?: boolean;
  /** 사용자가 이 서랍을 닫았을 때(닫기 단추·Esc·바깥 누르기·closeDrawer) 부른다. dismissDrawer 로 치울 때는 부르지 않는다. */
  onClose?: () => void;
  /** 넓은 서랍(호출 흐름 그림). 폭을 따로 기억한다. */
  wide?: boolean;
  /** 머리 아이콘. 없으면 지금 화면의 아이콘을 쓴다(도움말 서랍은 HelpOutline, OMAI-1274) */
  icon?: SvgIconComponent;
  /** 서랍 안 기록. 있으면 그 안의 링크(LinkChip page)가 같은 서랍에서 열리고 제목 옆에 이전·이후 단추가 생긴다 */
  history?: DrawerHistory;
  /** 서랍마다 붙는 번호(React key). openDrawer 가 붙인다. */
  _k?: number;
}

/** 서랍 한 페이지의 내용(머리·폭·본문) */
export type DrawerContent = Pick<DrawerSpec, 'title' | 'sub' | 'subLead' | 'focusKey' | 'body' | 'wide'>;

/** 기록의 한 칸. page 는 등록부 대상(설명 값), root 는 화면이 만든 내용(주소 서랍의 첫 페이지·목록이 연 첫 페이지).
 * root 가 있으면 그것을 그리고, 없으면 page 로 다시 만든다 */
export interface DrawerEntry {
  page?: DrawerPage;
  root?: DrawerContent;
}
export interface DrawerHistory {
  pages: DrawerEntry[];
  index: number;
}

/** 기록 길이(앞쪽부터 버린다, §5-2) */
export const DRAWER_HISTORY_MAX = 30;

const contentOf = (e: DrawerEntry): DrawerContent => e.root ?? drawerSpecFor(e.page as DrawerPage);
const contentFields = (d: DrawerSpec): DrawerContent => ({ title: d.title, sub: d.sub, subLead: d.subLead, focusKey: d.focusKey, body: d.body, wide: d.wide });
/** 기록의 index 칸을 맨 앞에 그린다. 없는 값(subLead 등)은 지운다 */
const showAt = (d: DrawerSpec, history: DrawerHistory): DrawerSpec => {
  const c = contentOf(history.pages[history.index]);
  return { ...d, title: c.title, sub: c.sub, subLead: c.subLead, focusKey: c.focusKey, body: c.body, wide: c.wide, history };
};
/** 서랍 d 의 첫 페이지 내용을 next 로 바꾼 서랍 */
const withRoot = (d: DrawerSpec, next: Partial<DrawerContent>): DrawerSpec => {
  if (!d.history) return { ...d, ...next };
  const [first, ...rest] = d.history.pages;
  const history = { ...d.history, pages: [{ ...first, root: { ...contentOf(first), ...next } }, ...rest] };
  return d.history.index === 0 ? showAt(d, history) : { ...d, history };
};

/** 닫기 전에 물어볼 것(저장하지 않은 편집). false 면 닫지 않는다. */
export type CloseGuard = () => boolean | Promise<boolean>;

interface Ui {
  drawer: DrawerSpec | null;
  /** 쌓인 서랍 전체(아래부터). 서랍 본문은 가려진 동안에도 상태(편집 중인 글)를 지키도록 모두 그린다. */
  drawers: DrawerSpec[];
  /** 서랍을 연다. 돌려주는 번호로 `updateDrawer` 가 그 서랍을 찾는다. */
  openDrawer: (spec: DrawerSpec) => number;
  /** 열려 있는 서랍(번호)의 제목·부제·본문을 제자리에서 바꾼다. 같은 서랍이라 본문의 상태(편집 중인 글)는 지켜진다. 이미 닫혔으면 아무것도 하지 않는다.
   * 기록을 가진 서랍은 첫 페이지 내용을 바꾸고, 지금 첫 페이지를 보고 있을 때만 화면에도 반영한다(목록이 행을 다시 읽었을 때) */
  updateDrawer: (key: number, next: Pick<DrawerSpec, 'title' | 'sub' | 'body'>) => void;
  /** 그 id 서랍의 첫 페이지 내용을 바꾼다(주소 서랍의 deps 가 바뀜, 리뷰 D3·외부 검토 H5). 서랍 안에서 옮긴 페이지·기록·위 서랍은 그대로다.
   * 그 서랍이 없으면 false */
  refreshRoot: (id: string, content: DrawerContent) => boolean;
  /** 맨 위 서랍 안에서 대상을 바꾼다. 지금 페이지의 저장 확인을 먼저 묻고, 앞으로 갈 기록은 버린다. 지금 대상과 같으면 아무것도 하지 않는다 */
  navigateDrawer: (page: DrawerPage) => Promise<void>;
  /** 맨 위 서랍 기록의 이전·이후 페이지로 간다(저장 확인을 먼저 묻는다) */
  drawerBack: () => Promise<void>;
  drawerForward: () => Promise<void>;
  /** 그 id 서랍을 첫 페이지로 되돌린다. 거절되면 false(가이드가 프로파일 탭으로 돌아갈 때, 외부 검토 H4) */
  drawerHome: (id: string) => Promise<boolean>;
  /** 지금 페이지를 기록을 쌓지 않고 바꿔 넣는다(같은 대상의 탭만 바뀜 등) */
  replacePage: (page: DrawerPage) => void;
  /** 본문이 채운 머리(useDrawerHead). 그 서랍이 아직 그 페이지를 보이고 있을 때만 바꾼다 */
  setDrawerHead: (key: number, index: number, head: Pick<DrawerSpec, 'title' | 'sub' | 'subLead' | 'focusKey'>) => void;
  /** 맨 위 서랍을 닫는다. 아래에 쌓인 서랍이 있으면 그것이 다시 보인다. */
  closeDrawer: () => Promise<void>;
  /** 묻지 않고 치운다. id 를 주면 그 서랍만(위에 얹힌 서랍은 남는다), 없으면 모두. onClose 를 부르지 않는다(다른 화면으로 옮겨 갈 때). */
  dismissDrawer: (id?: string) => void;
  /** 주소에 묶이지 않은(keep 이 아닌) 서랍만 치운다. 링크로 옮겨 갈 때 쓴다 — 주소에 묶인 서랍은 그 화면이 내려가면 스스로 닫히고,
   * 같은 값으로 다시 오면 그대로 남아야 한다(받은편지함의 「MCP 탭 열기」가 열려 있던 같은 프로파일 서랍을 닫아 버리던 것, 스펙 2026-10-16-010 14-10) */
  dismissTransient: () => void;
  /** `keep` 서랍(id)이 닫히기 전에 물어볼 것을 건다. null 이면 뗀다. */
  setCloseGuard: (id: string, guard: CloseGuard | null) => void;
  /** 그 서랍에 저장 확인이 걸려 있는가. 주소 서랍이 값이 사라지거나 바뀔 때 물을지 고른다(스펙 2026-10-28-014 D6·D11) */
  hasCloseGuard: (id: string) => boolean;
  /** 그 서랍의 저장 확인만 실행한다(닫지 않는다). 확인이 없으면 true. 가이드가 같은 서랍의 탭만 바꿀 때 쓴다(OMAI-1274 재검토 D8) */
  runGuard: (id: string) => Promise<boolean>;
  /** 쌓인 서랍의 저장 확인을 위에서부터 모두 실행한다(닫지 않는다). 하나라도 거절하면 false. 가이드가 다른 화면으로 옮기기 전에 쓴다 */
  confirmAll: () => Promise<boolean>;
  paletteOpen: boolean;
  openPalette: () => void;
  closePalette: () => void;
  togglePalette: () => void;
}

const Ctx = createContext<Ui | null>(null);
let drawerSeq = 0;

export function UiProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<DrawerSpec[]>([]);
  const stackRef = useRef<DrawerSpec[]>([]);
  stackRef.current = stack;
  const guards = useRef(new Map<string, CloseGuard>());
  const [paletteOpen, setPaletteOpen] = useState(false);

  const openDrawer = useCallback((input: DrawerSpec) => {
    const spec = { ...input, _k: (drawerSeq += 1) };
    setStack((cur) => {
      if (spec.id) {
        const at = cur.findIndex((d) => d.id === spec.id);
        // 같은 상세 서랍을 다시 열면(다른 프로파일로 바뀜) 그 위에 얹힌 서랍은 치운다
        if (at >= 0) return [...cur.slice(0, at), spec];
      }
      const top = cur[cur.length - 1];
      // 기록을 가진 서랍 위에서 연 서랍도 쌓는다 — 바꿔 끼우면 그 서랍의 기록이 사라진다(외부 검토 H1)
      if (!top || top.keep || top.history) return [...cur, spec];
      return [...cur.slice(0, -1), spec];
    });
    return spec._k;
  }, []);

  const updateDrawer = useCallback((key: number, next: Pick<DrawerSpec, 'title' | 'sub' | 'body'>) => {
    setStack((cur) => (cur.some((d) => d._k === key) ? cur.map((d) => (d._k === key ? withRoot(d, next) : d)) : cur));
  }, []);

  const refreshRoot = useCallback((id: string, content: DrawerContent) => {
    if (!stackRef.current.some((d) => d.id === id)) return false;
    setStack((cur) => cur.map((d) => (d.id === id ? withRoot(d, content) : d)));
    return true;
  }, []);

  /** 맨 위 서랍의 기록을 바꾼다. 지금 페이지의 저장 확인을 먼저 묻고, 통과하면 그 확인을 지운다 — 새 본문이 같은 id 로 다시 건다(§5-6 P7) */
  const moveTop = useCallback(async (next: (h: DrawerHistory) => DrawerHistory | null, target?: DrawerSpec) => {
    const top = target ?? stackRef.current[stackRef.current.length - 1];
    if (!top) return false;
    const h = top.history ?? { pages: [{ root: contentFields(top) }], index: 0 };
    const to = next(h);
    if (!to) return true;
    const guard = top.id ? guards.current.get(top.id) : undefined;
    if (guard && !(await guard())) return false;
    if (top.id) guards.current.delete(top.id);
    // id 가 없는 임시 서랍은 저장 확인을 걸 자리가 없어 붙인다(자리는 그대로라 쌓기 규칙에 영향이 없다)
    const id = top.id ?? `page:k${top._k}`;
    setStack((cur) => cur.map((d) => (d._k === top._k ? showAt({ ...d, id }, to) : d)));
    return true;
  }, []);

  const navigateDrawer = useCallback(
    async (page: DrawerPage) => {
      await moveTop((h) => {
        const at = h.pages[h.index];
        if (at.page && pageKey(at.page) === pageKey(page)) return null;
        const pages = [...h.pages.slice(0, h.index + 1), { page }].slice(-DRAWER_HISTORY_MAX);
        return { pages, index: pages.length - 1 };
      });
    },
    [moveTop]
  );
  const drawerBack = useCallback(async () => {
    await moveTop((h) => (h.index > 0 ? { ...h, index: h.index - 1 } : null));
  }, [moveTop]);
  const drawerForward = useCallback(async () => {
    await moveTop((h) => (h.index < h.pages.length - 1 ? { ...h, index: h.index + 1 } : null));
  }, [moveTop]);
  const drawerHome = useCallback(
    async (id: string) => {
      const d = stackRef.current.find((x) => x.id === id);
      if (!d?.history?.index) return true;
      return moveTop((h) => ({ ...h, index: 0 }), d);
    },
    [moveTop]
  );
  const replacePage = useCallback((page: DrawerPage) => {
    setStack((cur) => {
      const top = cur[cur.length - 1];
      if (!top?.history) return cur;
      const pages = top.history.pages.map((e, i) => (i === top.history!.index ? { page } : e));
      // 머리는 그대로 둔다 — 본문이 같은 머리를 다시 채우지 않는다(useDrawerHead 는 값이 바뀔 때만 채운다)
      const { title, sub, subLead, focusKey } = top;
      return [...cur.slice(0, -1), { ...showAt(top, { ...top.history, pages }), title, sub, subLead, focusKey }];
    });
  }, []);
  const setDrawerHead = useCallback((key: number, index: number, head: Pick<DrawerSpec, 'title' | 'sub' | 'subLead' | 'focusKey'>) => {
    setStack((cur) =>
      cur.some((d) => d._k === key && (d.history?.index ?? 0) === index) ? cur.map((d) => (d._k === key ? { ...d, ...head } : d)) : cur
    );
  }, []);

  const closeDrawer = useCallback(async () => {
    const top = stackRef.current[stackRef.current.length - 1];
    if (!top) return;
    const guard = top.id ? guards.current.get(top.id) : undefined;
    if (guard && !(await guard())) return;
    setStack((cur) => (cur[cur.length - 1] === top ? cur.slice(0, -1) : cur));
    if (top.id) guards.current.delete(top.id);
    top.onClose?.();
  }, []);

  const dismissDrawer = useCallback((id?: string) => {
    if (id) guards.current.delete(id);
    else guards.current.clear();
    setStack((cur) => {
      if (!id) return cur.length ? [] : cur;
      // 그 서랍만 뺀다. 위에 얹힌 서랍은 둔다(프로파일을 지운 뒤 띄운 「보관 파일」 안내가 같이 사라지지 않게)
      return cur.some((d) => d.id === id) ? cur.filter((d) => d.id !== id) : cur;
    });
  }, []);

  const dismissTransient = useCallback(() => {
    // 빼는 서랍의 저장 확인도 지운다 — 남으면 같은 id 를 쓰는 다음 서랍이 옛 확인을 부른다
    for (const d of stackRef.current) if (!d.keep && d.id) guards.current.delete(d.id);
    setStack((cur) => (cur.some((d) => !d.keep) ? cur.filter((d) => d.keep) : cur));
  }, []);

  const setCloseGuard = useCallback((id: string, guard: CloseGuard | null) => {
    if (guard) guards.current.set(id, guard);
    else guards.current.delete(id);
  }, []);

  const hasCloseGuard = useCallback((id: string) => guards.current.has(id), []);

  const runGuard = useCallback(async (id: string) => {
    const guard = guards.current.get(id);
    return !guard || (await guard());
  }, []);

  const confirmAll = useCallback(async () => {
    for (const d of [...stackRef.current].reverse()) {
      const guard = d.id ? guards.current.get(d.id) : undefined;
      if (guard && !(await guard())) return false;
    }
    return true;
  }, []);

  const openPalette = useCallback(() => {
    guards.current.clear();
    setStack([]);
    setPaletteOpen(true);
  }, []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const togglePalette = useCallback(() => setPaletteOpen((v) => !v), []);
  const drawer = stack.length ? stack[stack.length - 1] : null;
  const value = useMemo<Ui>(
    () => ({
      drawer,
      drawers: stack,
      openDrawer,
      updateDrawer,
      refreshRoot,
      navigateDrawer,
      drawerBack,
      drawerForward,
      drawerHome,
      replacePage,
      setDrawerHead,
      closeDrawer,
      dismissDrawer,
      dismissTransient,
      setCloseGuard,
      hasCloseGuard,
      runGuard,
      confirmAll,
      paletteOpen,
      openPalette,
      closePalette,
      togglePalette,
    }),
    [
      drawer,
      stack,
      openDrawer,
      updateDrawer,
      refreshRoot,
      navigateDrawer,
      drawerBack,
      drawerForward,
      drawerHome,
      replacePage,
      setDrawerHead,
      closeDrawer,
      dismissDrawer,
      dismissTransient,
      setCloseGuard,
      hasCloseGuard,
      runGuard,
      confirmAll,
      paletteOpen,
      openPalette,
      closePalette,
      togglePalette,
    ]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useUi(): Ui {
  const v = useContext(Ctx);
  if (!v) throw new Error('UiProvider 안에서만 쓸 수 있습니다'); // i18n-ignore: 개발자용 오류
  return v;
}

/** UiProvider 밖에서도 부를 수 있는 판. 없으면 null. */
export const useUiOptional = (): Ui | null => useContext(Ctx);
