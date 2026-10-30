/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// COP Console 의 셸 토큰(openmaru-cop-console/frontend/src/lib/shellTokens.ts)을 옮긴 것이다.
// 이름과 값을 COP 과 같게 두어 `git grep` 한 번으로 두 제품을 대조할 수 있게 한다. 값을 바꾸지 않는다.
// 셸(Topbar·좌측 메뉴)은 라이트 모드에서도 어둡다. 제품 정체성이 테마와 무관하게 일정하다.

/** 셸 색: 라이트·다크 공통 */
export const shellColors = {
  shellBg: '#0f1011',
  shellBorder: 'rgba(255, 255, 255, 0.05)',
  shellUserBg: '#08090a',
  menuText: '#d0d6e0',
  menuActiveBg: 'rgba(255, 255, 255, 0.05)',
  menuActiveText: '#f7f8f8',
  /** 메뉴 active 좌측 accent. 길잡이 표시에만 쓴다. 상태 표시에 쓰지 않는다. */
  menuActiveAccent: '#DA291C',
  menuHoverBg: 'rgba(255, 255, 255, 0.03)',
} as const;

/** 셸 치수 */
export const shellMetrics = {
  topbarHeight: 48,
  /** 접힌 사이드바 폭 */
  sidebarRailWidth: 64,
  /** 펼친 사이드바 폭(COP 의 drawerWidth) */
  sidebarWidth: 240,
  menuFontSize: 13,
  menuFontWeight: 400,
  menuActiveFontWeight: 500,
  topbarFontSize: 13,
  iconButtonSize: 20,
  menuActiveAccentWidth: 2,
  shellBorderWidth: 0.5,
} as const;

/** 본문(표·입력·폼) 글자 크기. 셸보다 0.5px 작다. */
export const contentFontSize = 12.5;

/** 칩·뱃지 글자 크기 */
export const badgeFontSize = 12;

/** 본문 배경은 셸과 달리 테마를 따른다. 값은 COP 의 contentBackground 와 같다. */
export const contentBackground = {
  light: { default: '#edeef2', surface: '#fafbfd', muted: '#e6e7eb' },
  dark: { default: '#08090a', surface: '#191a1b', muted: '#131415' },
} as const;

/** 표 헤더 띠: 담긴 표면 위에 얹는 반투명 오버레이 */
export const tableHeaderOverlay = {
  light: 'rgba(0, 0, 0, 0.03)',
  dark: 'rgba(255, 255, 255, 0.05)',
} as const;

/** 표 헤더 글자: 배경이 아니라 글자 밝기로 구분한다 */
export const tableHeaderText = {
  dark: { color: 'rgba(255, 255, 255, 0.5)', hoverColor: 'rgba(255, 255, 255, 0.75)' },
  light: { color: 'rgba(0, 0, 0, 0.6)', hoverColor: 'rgba(0, 0, 0, 0.8)' },
} as const;

/**
 * 키보드 포커스 링 색(스펙 2026-10-19-014). 예전에는 브랜드 레드 #DA291C 였다. 서랍을 ESC 로 닫으면 포커스가 연 단추로 돌아오며
 * 키보드 포커스로 판정돼 마우스 사용자도 링을 보는데, 빨강은 이 제품에서 오류·실패·삭제의 색이라 경고처럼 읽혔다.
 * 그래서 무채색(본문 글자색)으로 바꿨다. 화면은 테마가 :root 에 거는 CSS 변수 --aas-focus-ring 을 FOCUS_RING 으로 읽는다.
 * 늘 어두운 면(상단 막대·오피스 편집 패널)은 이 값을 따르지 않고 흰색을 쓴다.
 */
export const focusRingColor = { dark: '#f7f8f8', light: '#111827' } as const;
export const FOCUS_RING = 'var(--aas-focus-ring)';

/**
 * 공통 표(DataGrid)와 대시보드 표의 토큰. DESIGN.md 「Data Grid」 절의 값이다(OMAI-1127, 계획 2026-10-13-015 §4-9).
 * 표는 COP Console 처럼 **페이지 배경(contentBackground.<모드>.default) 위에 직접** 놓인다. 본문 행은 투명이고, 헤더 줄만 반투명 오버레이를 얹는다
 * (COP Table.tsx 의 tableHeaderOverlay: 다크 흰색 5%, 라이트 검정 3%). 이전에는 패널 색(다크 #191a1b·라이트 #fafbfd)을 칠해 COP 보다 밝았다
 * (다크 OMAI-1165, 라이트 OMAI-1171). 헤더 글자는 COP tableHeaderText 처럼 흐리게 두고 hover 에서 진해진다.
 * 고정(sticky) 칸은 아래 칸이 비치지 않게 그 바탕 위에 합성한 불투명 값(…Solid)을 쓴다.
 * 위의 tableHeaderOverlay·tableHeaderText 는 다른 표(서랍·오피스)가 계속 쓴다.
 */
export const gridTokens = {
  dark: {
    surface: contentBackground.dark.default, // #08090a — 페이지 배경과 같다
    bar: 'rgba(255, 255, 255, 0.025)', // 도구줄·필터줄·푸터
    head: 'rgba(255, 255, 255, 0.05)', // 헤더 줄. COP 의 tableHeaderOverlay 와 같다
    headSolid: '#141516', // head 를 #08090a 위에 합성한 값(고정 칸용)
    barLine: 'rgba(255, 255, 255, 0.06)',
    headText: 'rgba(255, 255, 255, 0.5)', // COP tableHeaderText.dark
    headHover: 'rgba(255, 255, 255, 0.75)',
    rowLine: 'rgba(255, 255, 255, 0.05)',
    hover: 'rgba(255, 255, 255, 0.04)',
    hoverSolid: '#121314', // hover 를 #08090a 위에 합성한 값
    selected: 'rgba(255, 255, 255, 0.06)',
    selectedSolid: '#171819', // selected 를 #08090a 위에 합성한 값
    selectedAccent: 'rgba(255, 255, 255, 0.85)',
    selectedText: '#f7f8f8',
    searchBg: 'rgba(0, 0, 0, 0.25)',
    searchLine: 'rgba(255, 255, 255, 0.08)',
    searchFocus: 'rgba(255, 255, 255, 0.30)',
    badgeBg: 'rgba(255, 255, 255, 0.06)',
    toggleLine: 'rgba(255, 255, 255, 0.08)',
    focusRing: focusRingColor.dark,
  },
  light: {
    surface: contentBackground.light.default, // #edeef2 — 페이지 배경과 같다(COP 와 같다)
    bar: 'rgba(17, 24, 39, 0.02)', // 도구줄·필터줄·푸터
    head: 'rgba(0, 0, 0, 0.03)', // 헤더 줄. COP 의 tableHeaderOverlay.light 와 같다
    headSolid: '#e6e7eb', // head 를 #edeef2 위에 합성한 값(COP 가 Observ 라이트 실측값이라고 적은 값)
    barLine: 'rgba(17, 24, 39, 0.06)',
    headText: 'rgba(0, 0, 0, 0.6)', // COP tableHeaderText.light
    headHover: 'rgba(0, 0, 0, 0.8)',
    rowLine: '#e5e6ec',
    hover: 'rgba(17, 24, 39, 0.025)',
    hoverSolid: '#e8e9ed', // hover 를 #edeef2 위에 합성한 값
    selected: 'rgba(17, 24, 39, 0.04)',
    selectedSolid: '#e4e5ea', // selected 를 #edeef2 위에 합성한 값
    selectedAccent: 'rgba(17, 24, 39, 0.70)',
    selectedText: '#111827',
    searchBg: 'rgba(17, 24, 39, 0.04)',
    searchLine: 'rgba(17, 24, 39, 0.10)',
    searchFocus: 'rgba(17, 24, 39, 0.35)',
    badgeBg: 'rgba(17, 24, 39, 0.06)',
    toggleLine: '#e5e7eb',
    focusRing: focusRingColor.light,
  },
} as const;

/** 공통 표 치수(px). §4-9 치수표 */
export const gridMetrics = { toolbar: 44, head: 32, row: 36, footer: 40, cellX: 12, firstCellX: 16 } as const;

/**
 * 탭 줄. DESIGN.md 「Tabs — Bordered Tabs」·§1-1.2: 켠 탭은 interaction state 라 단색(primary 글자·600·2px 단색 밑줄·옅은 wash).
 * theme primary 파랑이나 브랜드 빨강을 쓰지 않는다(OMAI-1127).
 */
export const tabTokens = {
  dark: {
    text: '#8a8f98',
    hoverText: '#d0d6e0',
    hoverLine: 'rgba(255, 255, 255, 0.15)',
    hoverBg: 'rgba(255, 255, 255, 0.04)',
    activeText: '#f7f8f8',
    activeBg: 'rgba(255, 255, 255, 0.06)',
    accent: 'rgba(255, 255, 255, 0.85)',
    line: '#23252a',
  },
  light: {
    text: '#6b7280',
    hoverText: '#374151',
    hoverLine: 'rgba(0, 0, 0, 0.10)',
    hoverBg: 'rgba(17, 24, 39, 0.025)',
    activeText: '#111827',
    activeBg: 'rgba(17, 24, 39, 0.04)',
    accent: 'rgba(17, 24, 39, 0.70)',
    line: '#e5e7eb',
  },
} as const;

/**
 * 다이얼로그(확인창 포함). DESIGN.md 「Example Component Prompts」의 destructive confirm dialog 와 §4 「3-Tier 버튼」 값이다(OMAI-1181).
 * 표면·테두리·글자는 12px 둥근 패널, 단추는 Tier 1(단색 반투명)·Tier 2(윤곽선)·Tier 3(위험, 되돌릴 수 없는 삭제만).
 * 빨강은 Tier 3 와 위험 아이콘에만 쓴다(Hue Discipline).
 */
export const dialogTokens = {
  dark: {
    surface: '#191a1b',
    edge: 'rgba(255, 255, 255, 0.08)',
    title: '#f7f8f8',
    body: '#d0d6e0',
    tier1: { bg: 'rgba(255, 255, 255, 0.06)', border: 'rgba(255, 255, 255, 0.14)', text: '#f7f8f8', glow: 'rgba(255, 255, 255, 0.04)', hoverBg: 'rgba(255, 255, 255, 0.10)', hoverBorder: 'rgba(255, 255, 255, 0.22)' },
    tier2: { border: 'rgba(255, 255, 255, 0.10)', text: '#d0d6e0', hoverBg: 'rgba(255, 255, 255, 0.04)', hoverBorder: 'rgba(255, 255, 255, 0.18)', hoverText: '#f7f8f8' },
    tier3: { bg: 'rgba(218, 41, 28, 0.16)', border: 'rgba(218, 41, 28, 0.55)', text: '#f5f6f7', hoverBg: 'rgba(218, 41, 28, 0.28)', hoverBorder: 'rgba(218, 41, 28, 0.75)', hoverText: '#ffffff' },
    dangerIcon: '#ef5350',
  },
  light: {
    surface: '#fafbfd',
    edge: 'rgba(17, 24, 39, 0.10)',
    title: '#111827',
    body: '#4b5563',
    tier1: { bg: 'rgba(17, 24, 39, 0.05)', border: 'rgba(17, 24, 39, 0.14)', text: '#111827', glow: 'rgba(17, 24, 39, 0.03)', hoverBg: 'rgba(17, 24, 39, 0.10)', hoverBorder: 'rgba(17, 24, 39, 0.24)' },
    tier2: { border: 'rgba(17, 24, 39, 0.10)', text: '#4b5563', hoverBg: 'rgba(17, 24, 39, 0.04)', hoverBorder: 'rgba(17, 24, 39, 0.18)', hoverText: '#111827' },
    tier3: { bg: 'rgba(218, 41, 28, 0.08)', border: 'rgba(218, 41, 28, 0.45)', text: '#da291c', hoverBg: 'rgba(218, 41, 28, 0.16)', hoverBorder: 'rgba(218, 41, 28, 0.65)', hoverText: '#b01e0a' },
    dangerIcon: '#da291c',
  },
} as const;

/**
 * 화면 아래 알림(Toast). 표면·테두리·글자는 다이얼로그와 같은 값을 쓰고, 상태 색은 아이콘 칩과 시간 막대에만 건다(글자는 기본 글자색).
 * 의미 색은 DESIGN.md §1-1(Hue Discipline)을 따른다: 초록 성공, 하늘색 안내, 호박색 경고, 빨강 실패.
 * 라이트의 호박색(#ca8a04)과 하늘색은 글자에 쓰면 대비가 모자라 아이콘·막대에만 쓴다.
 */
export const toastTokens = {
  dark: {
    surface: '#191a1b',
    edge: 'rgba(255, 255, 255, 0.10)',
    text: '#f7f8f8',
    muted: '#8a8f98',
    closeHover: 'rgba(255, 255, 255, 0.08)',
    shadow: '0 12px 28px rgba(0, 0, 0, 0.45), 0 2px 6px rgba(0, 0, 0, 0.30)',
    accent: { default: '#8a8f98', success: '#27a644', error: '#ef5350', warning: '#f59e0b', info: '#60a5fa' },
  },
  light: {
    surface: '#fafbfd',
    edge: 'rgba(17, 24, 39, 0.12)',
    text: '#111827',
    muted: '#6b7280',
    closeHover: 'rgba(17, 24, 39, 0.06)',
    shadow: '0 12px 28px rgba(17, 24, 39, 0.16), 0 2px 6px rgba(17, 24, 39, 0.08)',
    accent: { default: '#6b7280', success: '#1f8a3a', error: '#da291c', warning: '#ca8a04', info: '#2563eb' },
  },
} as const;

/**
 * 가이드 강조(OMAI-1274 디자인 리뷰 6A). 탭 밑줄(tabTokens.accent)과 같은 단색이다. 브랜드 빨강은 쓰지 않는다:
 * 앱의 포커스 링이 빨강이라 빌리면 입력칸이 검증 오류처럼 보인다. 스크롤 탭·표처럼 넘침이 잘리는 곳은 안쪽 변형을 쓴다.
 */
export const guideTokens = {
  dark: { line: tabTokens.dark.accent },
  light: { line: tabTokens.light.accent },
} as const;

/**
 * 상단 막대 위 공지 띠(스펙 공지 바 4-2, 디자인 리뷰 1A). 띠는 셸의 일부라 라이트·다크와 관계없이 어둡다.
 * 세기 세 단계: 장애(채운 빨강) · 작업·중단 예정(호박) · 안내·새 기능(낮음). 빨강은 장애에만 쓴다.
 * MUI Alert 를 쓰지 않는다(theme 이 warning 을 덮어쓰지 않아 MUI 기본 주황이 나온다).
 */
export const noticeTokens = {
  height: 36,
  fontSize: 13,
  kindFontSize: 11,
  /** 상단 막대와의 경계 */
  edge: 'rgba(255, 255, 255, 0.08)',
  high: { bg: '#DA291C', text: '#ffffff', icon: '#ffffff', line: 'transparent' },
  mid: { bg: `linear-gradient(rgba(245, 158, 11, 0.15), rgba(245, 158, 11, 0.15)), ${shellColors.shellBg}`, text: '#f7f8f8', icon: '#f59e0b', line: 'rgba(245, 158, 11, 0.35)' },
  low: { bg: `linear-gradient(rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.04)), ${shellColors.shellBg}`, text: '#d0d6e0', icon: { info: '#60a5fa', feature: '#27a644' }, line: 'transparent' },
  /** 다른 공지를 보는 동안 장애 공지가 있음을 알리는 점(3E) */
  outageDot: '#DA291C',
} as const;
