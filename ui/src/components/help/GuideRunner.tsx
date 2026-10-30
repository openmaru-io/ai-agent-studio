/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 따라하기 진행 카드(OMAI-1274). 스펙 cogentai-aas-docs docs-plan/ui/in-app-help-guide.md §4-4·§9·§10·§11.
// - 「다음」이 다음 단계의 화면까지 연다(4A). 같은 프로파일 서랍의 다른 탭이면 서랍을 닫지 않고 저장 확인 뒤 탭만 바꾸고(D8),
//   다른 화면이면 쌓인 서랍의 저장 확인을 모두 거친 뒤 옮긴다(D2). 옮기는 동안 단추를 막는다(재검토 외부 5).
// - 강조는 단색 outline 이고 단계 동안 남는다(6A). 주소·맨 위 서랍이 단계와 맞은 뒤에만 찾고(외부 6), 가려진 서랍의 요소는 고르지 않는다.
// - 카드는 서랍 위에서도 누를 수 있다: body 직속 Portal + useKeepVisible, 서랍 높이 위 zIndex, 서랍 왼쪽 배치(D5·9A).
// - 대화·회의 팝업이 있으면 본문 왼쪽 아래 알약으로 접는다(D4·D10). 좁은 화면은 아래 한 줄이고, 팝업이 펴지면 숨는다(10A·D9).
// - 화면이 열리면 포커스는 카드 단계 제목에 두고 강조 칸은 aria-describedby 로 잇는다(D11). 단계는 늘 그려진 라이브 영역이 읽는다.
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined';
import CheckIcon from '@mui/icons-material/Check';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CloseIcon from '@mui/icons-material/Close';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { Box, Button, Chip, GlobalStyles, IconButton, Link, Portal, Tooltip, Typography, useMediaQuery, useTheme } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { t } from '@/i18n';
import { openChat, useChatPopup } from '@/lib/chatPopup';
import { PRIMARY } from '@/lib/chatStore';
import { useIsAdmin, useMe } from '@/lib/data';
import {
  closeFinished,
  doneGuides,
  finishGuide,
  markGuideBlocked,
  pauseGuide,
  setGuideBusy,
  setGuideCollapsed,
  setGuideStep,
  setGuideUser,
  startGuide,
  useGuideRun,
} from '@/lib/guideRun';
import { atTarget, guideById, GUIDES, resolveTarget, routeDrawerId, sameDrawer, targetHref } from '@/lib/guides';
import { askText, guideTitle, stepBody, stepTitle } from '@/lib/guideText';
import { useRoomChatPopup } from '@/lib/roomChatPopup';
import { dialogTokens, guideTokens, tabTokens, toastTokens } from '@/lib/shellTokens';
import { Viewer, viewVisible } from '@/lib/views';
import { capWhy, profileQuery } from '@/screens/profiles/shared';
import type { ProfileDetailData } from '@/screens/profiles/types';

import { VIEW_ICONS } from '../PageTitle';
import { tier1, tier2 } from '../tierButton';
import { useUi } from '../UiContext';
import { useKeepVisible } from '../useKeepVisible';

const CARD_W = 360;
const GAP = 24;
const SPOT_WAIT_MS = 3000;
const ROUTE_DRAWER = 'route:name';
const OPEN_DRAWER = 'route:open';

/**
 * 그 자리에서 가이드를 바로 시작하는 작은 도움말 단추(스펙 §4-2 (다), T4). 지금 화면·탭과 맞는 첫 단계부터 시작하고, 없으면 1단계부터다.
 * 관리자 가이드는 관리자에게만 보인다.
 */
export function GuideHint({ guide }: { guide: string }) {
  const g = guideById(guide);
  const admin = useIsAdmin();
  const loc = useLocation();
  const primary = useMe().data?.primary;
  if (!g || (g.audience === 'admin' && !admin)) return null;
  const mine = primary?.ready ? primary.profile : null;
  const startHere = () => {
    const i = g.steps.findIndex((s) => {
      const to = s.to && resolveTarget(s.to, mine);
      return !!to && atTarget(loc.pathname, loc.search, to);
    });
    startGuide(g.id, i < 0 ? 0 : i);
  };
  const label = t('guides.hint', { name: guideTitle(g) });
  return (
    <Tooltip title={label}>
      <IconButton aria-label={label} onClick={startHere} data-guide-hint={g.id} sx={{ width: 32, height: 32, color: 'text.secondary', '&:hover': { color: 'text.primary' } }}>
        <HelpOutlineIcon sx={{ fontSize: 20 }} />
      </IconButton>
    </Tooltip>
  );
}

/** 강조 대상: 가려진 서랍(hidden) 안의 같은 data-guide 는 고르지 않는다(재검토 외부) */
export function findSpot(spot: string): HTMLElement | null {
  const all = Array.from(document.querySelectorAll<HTMLElement>(`[data-guide="${spot}"]`));
  return all.find((el) => !el.closest('[hidden]')) ?? null;
}

export function GuideRunner({ who, mainLeft }: { who: Viewer; mainLeft: number }) {
  const st = useGuideRun();
  const me = useMe();
  const ui = useUi();
  const loc = useLocation();
  const locRef = useRef(loc);
  locRef.current = loc;
  const navigate = useNavigate();
  const chat = useChatPopup();
  const room = useRoomChatPopup();
  const theme = useTheme();
  const small = useMediaQuery(theme.breakpoints.down('sm'));
  const mode = theme.palette.mode;
  const keep = useKeepVisible();
  const cardRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const wantFocus = useRef(false);
  const [spotId, setSpotId] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [xsOpen, setXsOpen] = useState(false);
  const [, setTick] = useState(0);

  // 누구의 기록인가: 불러오는 중이면 정하지 않는다. 로그인을 끈 설치(user=null)는 anon(재검토 외부 9)
  useEffect(() => {
    if (me.data) setGuideUser(me.data.user?.email ?? 'anon');
  }, [me.data]);

  const g = guideById(st.run?.id);
  const index = st.run?.step ?? 0;
  const step = g?.steps[index];
  const primary = me.data?.primary;
  const mine = primary?.ready ? primary.profile : null;
  const target = step?.to ? resolveTarget(step.to, mine) : null;
  const notReady = !!step?.to && !target;
  const needAdmin = !!target && !viewVisible(target.view, who);
  const capName = step?.cap && target?.params?.name ? target.params.name : '';
  const caps = useQuery<ProfileDetailData>({ ...profileQuery(capName), enabled: !!capName });
  const capBlocked = !!capName && !!caps.data && caps.data.caps?.[step!.cap!]?.can === false;
  const capReason = capBlocked && caps.data ? capWhy(caps.data, step!.cap!) : '';
  // 서랍 안에서 다른 페이지(스킬 연결도 등)로 옮겼으면 주소는 그대로여도 프로파일 탭이 보이지 않는다 — 첫 페이지일 때만 도착이다(스펙 2026-10-26-003 외부 검토 H4).
  // 목록 서랍(`open`, route:open)도 같은 규칙이다(스펙 2026-10-28-014 외부 검토 L3)
  const routeId = routeDrawerId(target);
  const routeHome = (ui.drawers.find((d) => d.id === routeId)?.history?.index ?? 0) === 0;
  const here = !!target && atTarget(loc.pathname, loc.search, target) && (!routeId || routeHome);
  const drawerReady = !routeId || (ui.drawer?.id === routeId && routeHome);
  const blocked = notReady || needAdmin || capBlocked;

  useEffect(() => {
    if (needAdmin || capBlocked) markGuideBlocked();
  }, [needAdmin, capBlocked]);

  /** 단계 i 의 화면을 연다. 거절되면 false(단계를 넘기지 않는다) */
  const go = useCallback(
    async (i: number): Promise<boolean> => {
      const s = g?.steps[i];
      const to = s?.to ? resolveTarget(s.to, mine) : null;
      if (!to || !viewVisible(to.view, who)) return true; // 설명만 보인다(준비 중·권한 없음)
      const { pathname, search } = locRef.current;
      // 같은 프로파일 서랍이면 먼저 첫 페이지로 되돌린다(저장 확인을 묻는다). 같은 목록 서랍(open)도 같다
      if (to.params?.name && sameDrawer(pathname, search, to) && ui.drawer?.id === ROUTE_DRAWER && !(await ui.drawerHome(ROUTE_DRAWER))) return false;
      if (routeDrawerId(to) === OPEN_DRAWER && atTarget(pathname, search, to) && ui.drawer?.id === OPEN_DRAWER && !(await ui.drawerHome(OPEN_DRAWER))) return false;
      if (atTarget(pathname, search, to)) return true;
      if (sameDrawer(pathname, search, to) && ui.drawer?.id === ROUTE_DRAWER) {
        if (!(await ui.runGuard(ROUTE_DRAWER))) return false;
        navigate(targetHref(to), { replace: true });
        return true;
      }
      if (!(await ui.confirmAll())) return false;
      ui.dismissDrawer();
      navigate(targetHref(to));
      return true;
    },
    [g, mine, who, ui, navigate]
  );

  const move = async (delta: number) => {
    if (!g || st.busy) return;
    const i = index + delta;
    if (i >= g.steps.length) return finishGuide();
    if (i < 0) return;
    setGuideBusy(true);
    try {
      if (await go(i)) {
        wantFocus.current = true;
        setGuideStep(i);
      }
    } finally {
      setGuideBusy(false);
    }
  };

  // 따라하기 시작·이어서 하기: 지금 단계의 화면을 연다
  useEffect(() => {
    if (!st.navSeq || !st.run) return;
    let live = true;
    void (async () => {
      setGuideBusy(true);
      try {
        await go(st.run!.step);
        if (live) wantFocus.current = true;
      } finally {
        setGuideBusy(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [st.navSeq]); // eslint-disable-line react-hooks/exhaustive-deps

  // 강조: 주소·맨 위 서랍이 단계와 맞은 뒤에만 찾는다. 3초 안에 없으면 설명만 보인다
  const spot = step?.spot;
  useEffect(() => {
    setSpotId(null);
    setNotFound(false);
    if (!spot || !here || !drawerReady || blocked || st.busy) return;
    let el: HTMLElement | null = null;
    let dismissed = false; // 사용자가 그 칸을 눌렀거나 입력했다: 이 단계에서는 다시 강조하지 않는다
    const started = Date.now();
    const detach = () => {
      el?.removeAttribute('data-guide-active');
      el?.removeEventListener('pointerdown', onUse);
      el?.removeEventListener('input', onUse);
    };
    function onUse() {
      dismissed = true;
      detach();
    }
    const found = (e: HTMLElement, scroll: boolean) => {
      detach();
      el = e;
      if (!e.id) e.id = `guide-spot-${spot.replace(/[^\w-]/g, '-')}`;
      e.setAttribute('data-guide-active', e.closest('[role="tablist"], table, .MuiTabs-root') ? 'inset' : 'out');
      e.addEventListener('pointerdown', onUse);
      e.addEventListener('input', onUse);
      if (scroll) {
        const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        e.scrollIntoView?.({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
      }
      setSpotId(e.id);
    };
    // 찾을 때까지 0.1초마다 보고, 찾은 뒤에도 그 요소가 문서에서 빠지면(서랍 본문이 다시 만들어짐) 새 요소에 다시 붙인다
    const timer = window.setInterval(() => {
      if (dismissed || (el && el.isConnected)) return;
      const e = findSpot(spot);
      if (e) found(e, !el);
      else if (!el && Date.now() - started >= SPOT_WAIT_MS) {
        window.clearInterval(timer);
        console.warn('[guide] spot not found', spot); // i18n-ignore: 개발자용 로그
        setNotFound(true);
      }
    }, 100);
    const first = findSpot(spot);
    if (first) found(first, true);
    return () => {
      window.clearInterval(timer);
      detach();
    };
  }, [spot, here, drawerReady, blocked, st.busy, st.run?.id, index]);

  // 단계가 바뀌거나 Alt+Shift+H 면 카드 단계 제목으로 포커스(D11)
  useEffect(() => {
    if (!wantFocus.current || st.busy) return;
    wantFocus.current = false;
    titleRef.current?.focus();
  }, [index, st.run?.id, st.busy]);
  useEffect(() => {
    if (st.focusSeq) titleRef.current?.focus();
  }, [st.focusSeq]);

  // 접기: 사용자가 접었거나 대화·회의 팝업이 있으면(최소화 칩 포함) 알약, 서랍 옆 자리가 좁아도 알약
  const popupOpen = !!chat.target || !!room.target;
  const popupExpanded = (!!chat.target && !chat.minimized) || (!!room.target && !room.minimized);
  const drawerW = ui.drawer ? Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--aas-drawer-w')) || 0 : 0;
  const tooNarrow = !small && !!ui.drawer && window.innerWidth - drawerW < CARD_W + 2 * GAP;
  const pill = !!st.run && !small && (st.run.collapsed || popupOpen || tooNarrow);
  const hidden = small && popupExpanded; // D9
  const cardShown = (!!st.run && !pill && !hidden) || (!!st.finished && !hidden);

  useEffect(() => {
    const on = () => setTick((n) => n + 1);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);

  // 서랍이 열려 있고 가이드가 진행 중이면 덮개 아래 본문으로 Tab 이 빠지지 않게 한다(재검토 외부 11)
  useEffect(() => {
    const root = document.getElementById('root');
    if (!root || !st.run || !ui.drawer) return;
    root.setAttribute('inert', '');
    return () => root.removeAttribute('inert');
  }, [st.run, ui.drawer]);

  // 알림을 카드 위로 올린다: 카드가 알림 열 아래(서랍이 닫혔거나 좁은 화면)일 때만, 화면 높이의 40% 까지(11A·재검토 외부 7)
  useEffect(() => {
    const rootStyle = document.documentElement.style;
    const el = cardRef.current;
    if (!cardShown || !el || (ui.drawer && !small)) {
      rootStyle.removeProperty('--aas-guide-offset');
      return;
    }
    const apply = () => {
      const h = el.offsetHeight + (small ? 0 : 16);
      rootStyle.setProperty('--aas-guide-offset', `${Math.min(h, Math.round(window.innerHeight * 0.4))}px`);
    };
    apply();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(apply) : null;
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      rootStyle.removeProperty('--aas-guide-offset');
    };
  }, [cardShown, ui.drawer, small, xsOpen, index, st.finished, st.run?.id]); // 진행 카드와 완료 카드가 바뀌면 새 요소를 잰다

  const tk = dialogTokens[mode];
  const total = g?.steps.length ?? 0;
  const live = g && step ? t('guides.card.live', { step: index + 1, total, title: stepTitle(g, index) }) : '';
  const name = g ? guideTitle(g) : '';
  const finished = guideById(st.finished);
  const done = st.finished ? doneGuides() : null;
  const nextGuide = finished && done ? GUIDES.find((x) => x.id !== finished.id && !done.has(x.id) && !x.requestOnly && (who.admin || x.audience === 'user')) : undefined;

  const panelSx = {
    position: 'fixed' as const,
    zIndex: theme.zIndex.drawer + 2,
    bgcolor: tk.surface,
    color: tk.body,
    border: `1px solid ${tk.edge}`,
    boxShadow: toastTokens[mode].shadow,
    ...(small
      ? { left: 0, right: 0, bottom: 0, borderRadius: '12px 12px 0 0', maxHeight: '60vh' }
      : { right: `calc(var(--aas-drawer-w, 0px) + ${GAP}px)`, bottom: GAP, width: CARD_W, borderRadius: '12px', maxHeight: '50vh' }),
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
  };

  const notice = (text: string, action?: ReactNode) => (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.75, mt: 1 }}>
      <LockOutlinedIcon aria-hidden sx={{ fontSize: 16, mt: '2px', color: 'text.secondary' }} />
      <Typography variant="caption" sx={{ flex: 1 }}>
        {text} {action}
      </Typography>
    </Box>
  );

  // 머리: 단계 칸 막대(단계마다 한 칸, 지난 단계는 옅게) · 가이드 이름과 쪽수 · 접기·멈추기. 발: 왼쪽 「AI에게 묻기」, 오른쪽 이전·다음
  const TargetIcon = target ? VIEW_ICONS[target.view] : undefined;
  const showOpen = !!target && !here && !blocked;
  const askAi = () => g && openChat({ kind: 'chat', agent: PRIMARY, text: askText(g, index, target) }); // 단계 내용·화면을 함께 넘긴다(스펙 2026-10-18-001 A)
  const targetIcon = TargetIcon ? <TargetIcon /> : undefined; // 다른 화면으로 가는 단추는 가는 화면의 아이콘(DESIGN.md 아이콘 표)
  const iconBtnSx = { width: 28, height: 28, color: 'text.secondary', '&:hover': { color: tk.title } };
  const card = g && step && (
    <Box ref={cardRef} role="region" aria-label={t('guides.card.label', { name })} data-guide-card="" sx={panelSx}>
      <Box sx={{ px: 2.25, pt: 1.75, flexShrink: 0 }}>
        <Box aria-hidden data-guide-steps="" sx={{ display: 'flex', gap: '4px' }}>
          {g.steps.map((_, i) => (
            <Box
              key={i}
              sx={{
                flex: 1,
                height: 3,
                borderRadius: 2,
                bgcolor: i <= index ? tabTokens[mode].accent : tabTokens[mode].line,
                opacity: i < index ? 0.45 : 1,
                transition: 'background-color 200ms ease, opacity 200ms ease',
                '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
              }}
            />
          ))}
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, mt: 1.25 }}>
          <HelpOutlineIcon aria-hidden sx={{ fontSize: 14, color: 'text.secondary', mr: 0.5 }} />
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ flex: 1, minWidth: 0, fontSize: 12, letterSpacing: '0.01em' }}
            noWrap
          >
            {name}
          </Typography>
          <Typography
            variant="caption"
            data-guide-count=""
            sx={{ color: tk.title, fontSize: 12, fontWeight: 500, fontVariantNumeric: 'tabular-nums', mr: 0.75 }}
          >
            {index + 1}
            <Box component="span" sx={{ color: 'text.secondary', fontWeight: 400 }}>
              {`/${total}`}
            </Box>
          </Typography>
          {small ? (
            <IconButton
              size="small"
              sx={iconBtnSx}
              aria-label={
                xsOpen ? t('guides.card.collapse') : t('guides.card.expand', { name, step: index + 1, total })
              }
              onClick={() => setXsOpen((v) => !v)}
            >
              {xsOpen ? <KeyboardArrowDownIcon sx={{ fontSize: 18 }} /> : <KeyboardArrowUpIcon sx={{ fontSize: 18 }} />}
            </IconButton>
          ) : (
            <Tooltip title={t('guides.card.collapse')}>
              <IconButton
                size="small"
                sx={iconBtnSx}
                aria-label={t('guides.card.collapse')}
                onClick={() => setGuideCollapsed(true)}
              >
                <KeyboardArrowDownIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </Tooltip>
          )}
          <Tooltip title={t('guides.card.close')}>
            <IconButton size="small" sx={iconBtnSx} aria-label={t('guides.card.close')} onClick={pauseGuide}>
              <CloseIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>
      <Box sx={{ px: 2.25, pt: 1, pb: 2, overflow: 'auto' }}>
        <Typography
          ref={titleRef}
          tabIndex={-1}
          variant="subtitle1"
          component="h2"
          aria-describedby={spotId ?? undefined}
          sx={{
            fontSize: 15,
            fontWeight: 600,
            lineHeight: 1.4,
            letterSpacing: '-0.01em',
            color: tk.title,
            outline: 'none',
          }}
        >
          {stepTitle(g, index)}
        </Typography>
        {(!small || xsOpen) && (
          <>
            <Typography
              variant="body2"
              sx={{ mt: 0.75, fontSize: 13.5, lineHeight: 1.65, color: tk.body, wordBreak: 'keep-all' }}
            >
              {stepBody(g, index)}
            </Typography>
            {notReady && notice(t('guides.card.notReady'))}
            {needAdmin && notice(t('guides.card.needAdmin'))}
            {capBlocked && notice(capReason || t('guides.card.needAdmin'))}
            {!!capName &&
              caps.isError &&
              notice(
                t('guides.card.capsFailed'),
                <Link component="button" type="button" variant="caption" onClick={() => void caps.refetch()}>
                  {t('guides.card.retry')}
                </Link>
              )}
            {notFound && (
              <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
                {t('guides.card.notFound')}
              </Typography>
            )}
          </>
        )}
      </Box>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 1.5,
          py: 1.25,
          borderTop: `1px solid ${tk.edge}`,
          flexShrink: 0,
          '& .MuiButton-root': { whiteSpace: 'nowrap' }, // 「다음」이 「다/음」으로 꺾이지 않게
        }}
      >
        {(!small || xsOpen) &&
          (showOpen ? (
            // 「이 화면 열기」까지 넷이면 카드 폭(360)을 넘어 글자가 꺾인다 → 아이콘만 두고 이름은 툴팁·aria-label 로
            <Tooltip title={t('guides.askAi')}>
              <IconButton aria-label={t('guides.askAi')} sx={iconBtnSx} onClick={askAi}>
                <AutoAwesomeOutlinedIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
          ) : (
            <Button
              size="small"
              color="inherit"
              startIcon={<AutoAwesomeOutlinedIcon sx={{ fontSize: '16px !important' }} />}
              sx={{
                color: 'text.secondary',
                px: 1,
                minWidth: 0,
                '&:hover': { color: tk.title, bgcolor: 'action.hover' },
              }}
              onClick={askAi}
            >
              {t('guides.askAi')}
            </Button>
          ))}
        <Box sx={{ flex: 1 }} />
        {showOpen && (
          <Button
            size="small"
            variant="outlined"
            color="inherit"
            sx={tier2}
            startIcon={targetIcon}
            disabled={st.busy}
            onClick={() => void move(0)}
          >
            {t('guides.card.openHere')}
          </Button>
        )}
        {index > 0 && (
          <Button
            size="small"
            color="inherit"
            sx={{ color: 'text.secondary', '&:hover': { color: tk.title } }}
            startIcon={<ChevronLeftIcon />}
            disabled={st.busy}
            onClick={() => void move(-1)}
          >
            {t('guides.card.prev')}
          </Button>
        )}
        <Button
          size="small"
          variant="outlined"
          color="inherit"
          sx={tier1}
          endIcon={index === total - 1 ? <CheckIcon /> : <ChevronRightIcon />}
          disabled={st.busy}
          onClick={() => void move(1)}
        >
          {index === total - 1 ? t('guides.card.finish') : t('guides.card.next')}
        </Button>
      </Box>
    </Box>
  );

  const finishedCard = finished && (
    <Box ref={cardRef} role="region" aria-label={t('guides.card.label', { name: guideTitle(finished) })} data-guide-card="" sx={panelSx}>
      <Box sx={{ p: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          {!finished.requestOnly && <CheckCircleOutlineIcon aria-hidden sx={{ color: toastTokens[mode].accent.success }} />}
          <Typography ref={titleRef} tabIndex={-1} variant="subtitle2" component="h2" sx={{ fontWeight: 600, color: tk.title, outline: 'none', flex: 1 }}>
            {finished.requestOnly ? t('guides.card.requestTitle') : t('guides.card.doneTitle')}
          </Typography>
        </Box>
        {st.blocked && !finished.requestOnly && (
          <Typography variant="caption" component="p" sx={{ mt: 0.5 }}>
            {t('guides.card.doneSome')}
          </Typography>
        )}
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 1.5, flexWrap: 'wrap' }}>
          {nextGuide && !finished.requestOnly && (
            <Button size="small" variant="outlined" color="inherit" sx={tier2} onClick={() => startGuide(nextGuide.id)}>
              {t('guides.card.nextGuide', { name: guideTitle(nextGuide) })}
            </Button>
          )}
          <Button size="small" variant="outlined" color="inherit" sx={tier1} onClick={closeFinished}>
            {t('guides.card.closeDone')}
          </Button>
        </Box>
      </Box>
    </Box>
  );

  const gt = guideTokens[mode];
  return (
    <Portal>
      <GlobalStyles
        styles={{
          // 후광(box-shadow·::after)은 두지 않는다: 탭의 hover·포커스 boxShadow 와 서로 덮고, ::after 는 position 을 바꿔 배치를 흔든다(재검토 외부 3)
          '[data-guide-active]': {
            outline: `2px solid ${gt.line} !important`,
            outlineOffset: '2px',
            animation: 'aas-guide-blink 0.3s ease-in-out 2',
          },
          '[data-guide-active="inset"]': { outlineOffset: '-2px' },
          '@keyframes aas-guide-blink': { '50%': { outlineColor: 'transparent' } },
          '@media (prefers-reduced-motion: reduce)': { '[data-guide-active]': { animation: 'none' } },
          // 알림 더미를 진행 카드 위로 올린다(11A). notistack 3 의 기본 아래 여백은 14px 이다
          '.aas-snack-bottom-right': { bottom: 'calc(14px + var(--aas-guide-offset, 0px)) !important' },
        }}
      />
      <Box ref={keep} data-guide-root="">
        {/* 늘 그려진 라이브 영역: 카드가 접히거나 폭이 바뀌어도 단계 변화를 읽는다(재검토 외부 10) */}
        <Box role="status" aria-live="polite" sx={visuallyHiddenSx}>
          {st.run && !st.busy ? live : ''}
        </Box>
        {!hidden && st.run && !pill && card}
        {!hidden && !st.run && finishedCard}
        {pill && st.run && g && (
          <Chip
            color="primary"
            icon={<HelpOutlineIcon aria-hidden sx={{ fontSize: 18 }} />}
            label={t('guides.card.meta', { name, step: index + 1, total })}
            aria-label={t('guides.card.expand', { name, step: index + 1, total })}
            onClick={() => setGuideCollapsed(false)}
            data-guide-pill=""
            sx={{ position: 'fixed', left: mainLeft + GAP, bottom: GAP, zIndex: theme.zIndex.drawer + 2, height: 32, boxShadow: 4 }}
          />
        )}
      </Box>
    </Portal>
  );
}

const visuallyHiddenSx = {
  border: 0,
  clip: 'rect(0 0 0 0)',
  height: '1px',
  margin: '-1px',
  overflow: 'hidden',
  padding: 0,
  position: 'absolute',
  whiteSpace: 'nowrap',
  width: '1px',
} as const;
