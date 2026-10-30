/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 화면 어디서나 여는 오른쪽 상세 서랍. 모양과 폭 규칙은 COP Console 의 상세 Drawer 를 따른다(`lib/detailDrawer`).
// - 본문 영역 위쪽(상단 막대·연결 상태 띠 아래)에서 시작해 화면 아래까지 채운다.
// - 넓은 화면에서는 왼쪽 모서리를 둥글게 하고, 왼쪽 가장자리를 끌어 폭을 바꾼다. 바꾼 폭은 다시 열어도 유지된다.
// - 좁은 화면에서는 본문 영역 폭 전체를 덮고 손잡이를 두지 않는다.
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import CloseIcon from '@mui/icons-material/Close';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { Box, Drawer, IconButton, Tooltip, Typography, useMediaQuery, useTheme } from '@mui/material';
import { QueryClientContext } from '@tanstack/react-query';
import { KeyboardEvent, PointerEvent, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { t } from '@/i18n';
import { useChatPopup } from '@/lib/chatPopup';
import type { Me } from '@/lib/data';
import {
  clampDetailDrawerWidth,
  DETAIL_DRAWER_KEY_STEP,
  DETAIL_DRAWER_MIN_WIDTH,
  initialDetailDrawerWidth,
  useContentTopOffset,
} from '@/lib/detailDrawer';
import { useGuideRun } from '@/lib/guideRun';

import { ScreenLoading } from './bits';
import { drawerBodySx } from './drawerBodySx';
import { DrawerPage, pageHref } from './drawerPages';
import { DrawerHead, DrawerHeadSlot, DrawerHeadSlotContext, DrawerPageContext, InDrawerContext } from './drawerScope';
import { useViewIcon } from './PageTitle';
import { ScreenBoundary } from './ScreenBoundary';
import { CloseGuard, DrawerSpec, useUi } from './UiContext';

/** 끌기 손잡이 폭(px). COP 리소스 상세 Drawer 와 같다. */
const HANDLE_WIDTH = 10;

export function DrawerHost() {
  const { drawer, drawers, closeDrawer, drawerBack, drawerForward } = useUi();
  const ScreenIcon = useViewIcon();
  const ViewIcon = drawer?.icon ?? ScreenIcon;
  const guide = useGuideRun();
  const [headSlot, setHeadSlot] = useState<HTMLElement | null>(null);
  const [badgeSlot, setBadgeSlot] = useState<HTMLElement | null>(null);
  const [noteSlot, setNoteSlot] = useState<HTMLElement | null>(null);
  const popup = useChatPopup();
  const theme = useTheme();
  const small = useMediaQuery(theme.breakpoints.down('sm'));
  const contentTop = useContentTopOffset();
  const [normalWidth, setNormalWidth] = useState(() => initialDetailDrawerWidth());
  // 넓은 서랍(호출 흐름 그림)은 처음부터 끌 수 있는 최대 폭(화면의 80%)으로 열고 폭을 따로 기억한다
  const [wideWidth, setWideWidth] = useState(() => clampDetailDrawerWidth(window.innerWidth));
  // 사용자가 끌거나 키보드로 정한 폭인지(보통·넓은 서랍 따로). 정하지 않았으면 창 크기가 바뀔 때 새 화면의 처음 폭으로 다시 맞춘다
  const userSized = useRef({ normal: false, wide: false });
  const width = drawer?.wide ? wideWidth : normalWidth;
  const setWidth = (next: number | ((w: number) => number)) => {
    userSized.current[drawer?.wide ? 'wide' : 'normal'] = true;
    (drawer?.wide ? setWideWidth : setNormalWidth)(next);
  };
  // 폭은 처음 그릴 때 화면 폭으로 정해져, 좁은 창(390px → 215px)에서 연 뒤 넓히면 최소 폭보다 좁은 서랍이 남았다(2026-10-23).
  // 정한 폭은 남기되 허용 범위 안으로만 맞춘다
  useEffect(() => {
    const onResize = () => {
      setNormalWidth((w) => (userSized.current.normal ? clampDetailDrawerWidth(w) : initialDetailDrawerWidth()));
      setWideWidth((w) => clampDetailDrawerWidth(userSized.current.wide ? w : window.innerWidth));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  // 가이드 카드가 서랍 왼쪽에 따라붙도록 지금 폭을 CSS 변수로 내보낸다(OMAI-1274 재검토 E3). 상태를 Context 로 올리면 끄는 동안 앱 전체가 다시 그려진다
  const shownWidth = drawer ? (small ? window.innerWidth : width) : 0;
  useEffect(() => {
    document.documentElement.style.setProperty('--aas-drawer-w', `${shownWidth}px`);
  }, [shownWidth]);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef(false);
  // focusKey 가 바뀌면 제목에 초점(스펙 2026-10-19-011 D7). 같은 id 의 서랍을 다시 열면 _k 는 새로 붙으므로 id 로 같은 서랍인지 가린다.
  // 처음 열 때와 다른 서랍으로 바뀔 때는 옮기지 않는다
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const lastFocus = useRef<{ id?: string; key?: string }>({});
  useEffect(() => {
    const prev = lastFocus.current;
    lastFocus.current = { id: drawer?.id, key: drawer?.focusKey };
    if (drawer?.id && drawer.focusKey && prev.id === drawer.id && prev.key !== undefined && prev.key !== drawer.focusKey) titleRef.current?.focus();
  }, [drawer?.id, drawer?.focusKey]);
  // 서랍 안에서 페이지를 옮기면 제목에 초점을 둔다 — 누른 단추·링크가 사라져 초점이 문서 처음으로 가지 않게(리뷰 외부 검토 M4)
  const lastPage = useRef<{ k?: number; index?: number }>({});
  const pageIndex = drawer ? (drawer.history?.index ?? 0) : undefined;
  useEffect(() => {
    const prev = lastPage.current;
    lastPage.current = { k: drawer?._k, index: pageIndex };
    if (drawer && prev.k === drawer._k && prev.index !== undefined && prev.index !== pageIndex) titleRef.current?.focus();
  }, [drawer, pageIndex]);
  const history = drawer?.history;
  const current = history?.pages[history.index]?.page;

  const endDrag = useCallback(() => {
    if (!dragRef.current) return;
    dragRef.current = false;
    setDragging(false);
    document.body.style.removeProperty('cursor');
    document.body.style.removeProperty('user-select');
  }, []);

  // 끄는 중에 서랍이 닫히거나 화면을 떠나도 커서·글자 선택 막음이 남지 않게 한다.
  useEffect(() => {
    if (!drawer) endDrag();
  }, [drawer, endDrag]);
  useEffect(() => endDrag, [endDrag]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button > 0) return; // 가운데·오른쪽 단추는 끌기로 보지 않는다
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = true;
    setDragging(true);
    // 끄는 동안 손잡이 밖으로 나가도 커서가 바뀌지 않고, 본문 글자가 선택되지 않게 한다.
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    // 서랍은 화면 오른쪽 끝에 붙어 있다. 포인터에서 오른쪽 끝까지가 새 폭이다.
    setWidth(clampDetailDrawerWidth(window.innerWidth - e.clientX));
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    endDrag();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowLeft' ? DETAIL_DRAWER_KEY_STEP : e.key === 'ArrowRight' ? -DETAIL_DRAWER_KEY_STEP : 0;
    if (!step) return;
    e.preventDefault();
    setWidth((w) => clampDetailDrawerWidth(w + step));
  };

  return (
    <Drawer
      anchor="right"
      open={!!drawer}
      onClose={() => void closeDrawer()}
      // 대화 팝업이 떠 있으면 서랍이 포커스를 붙잡지 않는다 — 서랍을 보며 팝업에 입력한다(OMAI-1115)
      // 가이드가 진행 중이면 서랍 옆 카드의 단추를 누를 수 있어야 한다(OMAI-1274 D5). 탭 순서는 카드가 #root 에 inert 를 걸어 묶는다
      disableEnforceFocus={(!!popup.target && !popup.minimized) || !!guide.run}
      slotProps={{
        // 뒤의 목록이 읽히도록 옅게 가린다(COP 리소스 상세 Drawer 와 같은 값).
        backdrop: { sx: { backgroundColor: 'rgba(0, 0, 0, 0.2)' } },
        paper: {
          role: 'dialog',
          'aria-label': drawer?.title,
          elevation: 0,
          sx: {
            // 좁은 화면도 상단 막대 아래에서 시작한다. 맨 위에서 시작하면 머리가 상단 막대에 가려진다.
            top: `${contentTop}px`,
            // 좁은 화면에서 가이드 카드가 아래 한 줄로 뜨면 그만큼 서랍을 줄여 저장 단추가 가려지지 않게 한다(OMAI-1274 재검토)
            height: `calc(100% - ${contentTop}px - var(--aas-guide-offset, 0px))`,
            width: { xs: '100vw', sm: `${width}px` },
            maxWidth: '100vw',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            backgroundColor: 'background.paper',
            backgroundImage: 'none',
            boxShadow: '-5px 0 20px rgba(0,0,0,0.08)',
            border: { sm: 1 },
            borderRight: { sm: 0 },
            borderColor: { sm: 'divider' },
            borderRadius: { sm: '10px 0 0 10px' },
          },
        },
      }}
    >
      {drawer && (
        <>
          {!small && (
            <Box
              role="separator"
              aria-orientation="vertical"
              aria-label={t('common.resizePanel')}
              aria-valuenow={width}
              aria-valuemin={DETAIL_DRAWER_MIN_WIDTH}
              aria-valuemax={clampDetailDrawerWidth(Number.MAX_SAFE_INTEGER)}
              tabIndex={0}
              data-dragging={dragging || undefined}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onLostPointerCapture={endDrag}
              onKeyDown={onKeyDown}
              sx={{
                position: 'absolute',
                top: 0,
                left: 0,
                bottom: 0,
                width: HANDLE_WIDTH,
                zIndex: 1,
                cursor: 'ew-resize',
                touchAction: 'none',
                outline: 'none',
                // 손잡이 자리를 알 수 있게 올리거나 끌 때, 키보드로 왔을 때만 가장자리에 선을 그린다.
                '&::after': {
                  content: '""',
                  position: 'absolute',
                  top: 0,
                  bottom: 0,
                  left: 0,
                  width: 2,
                  bgcolor: 'primary.main',
                  opacity: 0,
                  transition: 'opacity 120ms',
                },
                '&:hover::after, &[data-dragging]::after': { opacity: 0.5 },
                '&:focus-visible::after': { opacity: 1 },
                '@media (prefers-reduced-motion: reduce)': { '&::after': { transition: 'none' } },
              }}
            />
          )}
          <Box
            data-drawer-head=""
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              px: 2,
              py: 1.5,
              borderBottom: 1,
              borderColor: 'divider',
              flexShrink: 0,
            }}
          >
            {/* 제목 앞 화면 아이콘(본문 제목과 같은 것). SVG 라 에어갭에서도 보인다 */}
            {ViewIcon && (
              <Box data-drawer-icon="" sx={{ display: 'flex', alignSelf: 'flex-start', pt: 0.5, color: 'text.secondary', flexShrink: 0 }}>
                <ViewIcon aria-hidden sx={{ fontSize: 22 }} />
              </Box>
            )}
            {/* 제목 옆 이전·이후(스펙 2026-10-26-003 §5-4). 기록이 둘 이상일 때만, 끝에서는 막는다. 단축키는 두지 않는다(D7) */}
            {history && history.pages.length > 1 && (
              <Box data-drawer-nav="" sx={{ display: 'flex', alignItems: 'center', flexShrink: 0, ml: -0.5 }}>
                <Tooltip title={t('common.drawerBack')}>
                  <span>
                    <IconButton aria-label={t('common.drawerBack')} size="small" disabled={history.index <= 0} onClick={() => void drawerBack()}>
                      <ArrowBackIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
                <Tooltip title={t('common.drawerForward')}>
                  <span>
                    <IconButton
                      aria-label={t('common.drawerForward')}
                      size="small"
                      disabled={history.index >= history.pages.length - 1}
                      onClick={() => void drawerForward()}
                    >
                      <ArrowForwardIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
              </Box>
            )}
            <Box sx={{ flex: 1, minWidth: 0 }}>
              {/* 제목 줄: 제목 + 상태 뱃지(DrawerBadges). 뱃지는 h2 밖이라 제목의 읽는 이름은 그대로다 */}
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
                <Typography
                  variant="h6"
                  component="h2"
                  noWrap
                  title={drawer.title}
                  ref={titleRef}
                  tabIndex={drawer.focusKey || history ? -1 : undefined}
                  sx={{ minWidth: 0, '&:focus': { outline: 'none' } }}
                >
                  {drawer.title}
                </Typography>
                <Box
                  ref={setBadgeSlot}
                  data-drawer-badges=""
                  sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0, '& .MuiChip-root': { mr: 0, flexShrink: 0 }, '&:empty': { display: 'none' } }}
                />
              </Box>
              {/* 부제목 줄: 부제목 + 본문의 설명(DrawerNote). 설명은 길면 다음 줄로 넘어간다 */}
              <Box sx={{ display: 'flex', alignItems: 'baseline', columnGap: 1, flexWrap: 'wrap', minWidth: 0 }}>
                {drawer.sub && (
                  <Typography variant="caption" color="text.secondary" component="p" noWrap title={drawer.sub} sx={{ flexShrink: 0 }}>
                    {drawer.subLead}
                    {drawer.sub}
                  </Typography>
                )}
                <Box
                  ref={setNoteSlot}
                  data-drawer-note=""
                  sx={{ minWidth: 0, color: 'text.secondary', typography: 'caption', '&:empty': { display: 'none' } }}
                />
              </Box>
            </Box>
            {/* 본문이 넘긴 동작 단추(DrawerActions)가 여기 그려진다 — COP Drawer 처럼 닫기 앞 */}
            <Box ref={setHeadSlot} data-drawer-actions="" sx={{ display: 'flex', alignItems: 'center', gap: 0.5, '&:empty': { display: 'none' } }} />
            {/* 서랍 안에서 옮겨 온 페이지는 그 메뉴에서 넓게 볼 수 있다(§5-7) */}
            {current && history.index > 0 && <OpenScreen page={current} />}
            <Tooltip title={t('common.close')}>
              <IconButton aria-label={t('common.close')} onClick={() => void closeDrawer()} size="small">
                <CloseIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Box>
          {/* 쌓인 서랍의 본문을 모두 그리고 맨 위만 보인다. 아래 서랍(프로파일 상세)의 편집 중인 글이 지워지지 않게 한다 */}
          {/* 본문 상자의 key 에 페이지 번호를 넣어 페이지마다 새로 만든다 — 이전으로 와도 스크롤이 처음이다(외부 검토 M1) */}
          {drawers.map((d) => (
            <Box
              key={`${d._k}:${d.history?.index ?? 0}`}
              data-drawer-body=""
              hidden={d !== drawer}
              sx={[{ flexGrow: 1, minHeight: 0, overflow: 'auto', px: 2, pt: 2, pb: 3 }, drawerBodySx]}
            >
              <DrawerBody d={d} slot={{ el: headSlot, badges: badgeSlot, note: noteSlot, active: d === drawer }} />
            </Box>
          ))}
        </>
      )}
    </Drawer>
  );
}

/** 서랍 본문 하나. 페이지 본문이 늦게 불러와져도(lazy) 그 서랍 안에서만 기다리고, 묶음을 받지 못하면 그 서랍 안에만 오류를 보인다(외부 검토 C2) */
function DrawerBody({ d, slot }: { d: DrawerSpec; slot: DrawerHeadSlot }) {
  const { setDrawerHead, setCloseGuard } = useUi();
  const index = d.history?.index ?? 0;
  const k = d._k as number;
  const id = d.id;
  const setHead = useCallback((head: DrawerHead) => setDrawerHead(k, index, head), [setDrawerHead, k, index]);
  const guard = useCallback((fn: CloseGuard | null) => (id ? setCloseGuard(id, fn) : undefined), [setCloseGuard, id]);
  const scope = useMemo(() => ({ index, setHead, guard }), [index, setHead, guard]);
  return (
    <InDrawerContext.Provider value>
      <DrawerHeadSlotContext.Provider value={slot}>
        <DrawerPageContext.Provider value={scope}>
          <ScreenBoundary title={d.title}>
            <Suspense fallback={<ScreenLoading title={d.title} />}>{d.body}</Suspense>
          </ScreenBoundary>
        </DrawerPageContext.Provider>
      </DrawerHeadSlotContext.Provider>
    </InDrawerContext.Provider>
  );
}

/** 「이 화면으로 열기」: 저장 확인을 거친 뒤 서랍을 치우고 그 페이지의 메뉴로 옮긴다. 그 화면이 주소 값으로 서랍을 다시 연다.
 *  목록 서랍 주소에는 지금 POD 를 함께 쓴다(스펙 2026-10-28-014 D10). 내 정보는 받아 둔 것만 읽는다 — 서랍만 띄우는 시험에는 조회 제공자가 없다 */
function OpenScreen({ page }: { page: DrawerPage }) {
  const ui = useUi();
  const navigate = useNavigate();
  const qc = useContext(QueryClientContext);
  return (
    <Tooltip title={t('common.drawerOpenScreen')}>
      <IconButton
        aria-label={t('common.drawerOpenScreen')}
        size="small"
        onClick={async () => {
          if (!(await ui.confirmAll())) return;
          ui.dismissDrawer();
          navigate(pageHref(page, qc?.getQueryData<Me>(['me'])?.pod?.id));
        }}
      >
        <OpenInNewIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  );
}
