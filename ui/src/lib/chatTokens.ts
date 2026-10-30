/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 채팅·회의·오피스 장면 대화가 함께 쓰는 토큰(스펙 2026-10-15-010 §3).
// shellTokens.ts 는 COP Console 복사본이라 값을 바꾸지 않는다. 그래서 대화 화면 값은 이 파일에 둔다.
// 색은 DESIGN.md §1-1.2 의 단색 wash 체계를 따른다. 파랑·브랜드 빨강을 상태 표시에 쓰지 않는다.

export interface ChatTokens {
  /** 대화 영역 바탕. 페이지 배경과 같다. 컴포넌트는 칠하지 않고 대비 시험에서만 쓴다. */
  canvas: string;
  /** 목록 바탕·머리줄 바탕 */
  rail: string;
  line: string;
  /** 내 말 판 */
  mine: string;
  mineLine: string;
  text: string;
  muted: string;
  /** 입력 카드 */
  composer: string;
  composerFocus: string;
  hover: string;
  selected: string;
  selectedAccent: string;
  /** 경고 아이콘·글자 색(DESIGN.md 호박색: 어두운 #f59e0b, 밝은 #ca8a04 — 밝은 바탕 대비용 한 단계 어두운 값) */
  warn: string;
  warnWash: string;
  warnLine: string;
  errWash: string;
  errLine: string;
  /** 단색 아바타 타일 바탕(채팅·AgentChat). 색조 타일은 회의에서만 쓴다. */
  monoTile: string;
  /** 움푹한 칸(승인 카드의 명령) */
  sunken: string;
  /** 화면 위에 떠 있는 대화 창(FloatingChatShell, OMAI-1265). 서랍·페이지와 같은 색이라 구분되지 않던 것을 면·테두리·그림자로 가른다. */
  popup: {
    /** 창 면(불투명). 다크는 서랍(#191a1b)보다 한 단계 위, 라이트는 흰색 */
    surface: string;
    /** 테두리(뒤에 있거나 혼자일 때) */
    edge: string;
    /** 테두리(마지막으로 누른 앞 창) — 창이 둘일 때 어느 쪽이 활성인지 보인다 */
    edgeFront: string;
    /** 머리줄 바탕 */
    head: string;
    /** 바깥 그림자: 외곽 1px 링 + 넓게 퍼지는 그림자 + 가까운 그림자 */
    shadow: string;
    /** 위쪽 안쪽 빛 한 줄(면이 떠 있는 느낌) */
    highlight: string;
  };
}

export const chatTokens: { dark: ChatTokens; light: ChatTokens } = {
  dark: {
    canvas: '#08090a',
    rail: 'rgba(255, 255, 255, 0.025)',
    line: 'rgba(255, 255, 255, 0.08)',
    mine: 'rgba(255, 255, 255, 0.06)',
    mineLine: 'rgba(255, 255, 255, 0.08)',
    text: '#f7f8f8',
    muted: '#8a8f98',
    composer: 'rgba(255, 255, 255, 0.03)',
    composerFocus: 'rgba(255, 255, 255, 0.30)',
    hover: 'rgba(255, 255, 255, 0.04)',
    selected: 'rgba(255, 255, 255, 0.06)',
    selectedAccent: 'rgba(255, 255, 255, 0.85)',
    warn: '#f59e0b',
    warnWash: 'rgba(245, 158, 11, 0.06)',
    warnLine: 'rgba(245, 158, 11, 0.28)',
    errWash: 'rgba(239, 83, 80, 0.06)',
    errLine: 'rgba(239, 83, 80, 0.30)',
    monoTile: 'rgba(255, 255, 255, 0.08)',
    sunken: 'rgba(0, 0, 0, 0.25)',
    popup: {
      surface: '#222325',
      edge: 'rgba(255, 255, 255, 0.14)',
      edgeFront: 'rgba(255, 255, 255, 0.26)',
      head: 'rgba(255, 255, 255, 0.03)',
      shadow: '0 0 0 1px rgba(0, 0, 0, 0.65), 0 28px 64px -12px rgba(0, 0, 0, 0.78), 0 10px 24px -6px rgba(0, 0, 0, 0.55)',
      highlight: 'inset 0 1px 0 rgba(255, 255, 255, 0.07)',
    },
  },
  light: {
    canvas: '#edeef2',
    rail: 'rgba(17, 24, 39, 0.02)',
    line: 'rgba(17, 24, 39, 0.10)',
    mine: 'rgba(17, 24, 39, 0.05)',
    mineLine: 'rgba(17, 24, 39, 0.08)',
    text: '#111827',
    // 처음 계획의 #6b7280 은 #edeef2 위에서 4.17:1 이라 11px 글자 AA(4.5:1)에 못 미쳤다(디자인 리뷰). chatTokens.test.ts 가 고정한다.
    muted: '#4b5563',
    composer: 'rgba(17, 24, 39, 0.03)',
    composerFocus: 'rgba(17, 24, 39, 0.35)',
    hover: 'rgba(17, 24, 39, 0.025)',
    selected: 'rgba(17, 24, 39, 0.04)',
    selectedAccent: 'rgba(17, 24, 39, 0.70)',
    warn: '#ca8a04',
    warnWash: 'rgba(245, 158, 11, 0.08)',
    warnLine: 'rgba(245, 158, 11, 0.35)',
    errWash: 'rgba(239, 83, 80, 0.06)',
    errLine: 'rgba(239, 83, 80, 0.30)',
    monoTile: 'rgba(17, 24, 39, 0.08)',
    sunken: 'rgba(17, 24, 39, 0.06)',
    popup: {
      surface: '#ffffff',
      edge: 'rgba(17, 24, 39, 0.16)',
      edgeFront: 'rgba(17, 24, 39, 0.30)',
      head: 'rgba(17, 24, 39, 0.025)',
      shadow: '0 0 0 1px rgba(17, 24, 39, 0.05), 0 28px 64px -12px rgba(17, 24, 39, 0.32), 0 10px 24px -6px rgba(17, 24, 39, 0.18)',
      highlight: 'inset 0 1px 0 rgba(255, 255, 255, 0.9)',
    },
  },
};

/** 글자(px)·줄 높이. DESIGN.md §3 표의 값만 쓴다(Body Large·Body Medium·XX-Small·Micro). */
export const chatType = {
  body: 14,
  bodyLine: 1.75,
  name: 13,
  meta: 11,
  micro: 10, // DESIGN.md §3 Micro. 입력 카드의 「실수를 할 수 있습니다」 안내처럼 눈에 덜 띄어야 하는 글
  tool: 12,
} as const;

/** 치수(px). 반경은 DESIGN.md §5 척도(8·12)만 쓴다. */
export const chatMetrics = {
  /** 본문 열 폭의 최소(좁은 화면). 14px 한글에서 한 줄이 약 48자다 */
  column: 720,
  /** 넓은 화면에서 본문 열이 넓어지는 한계. 이보다 넓으면 한 줄이 너무 길어 읽기 어렵다 */
  columnMax: 960,
  frameRadius: 12,
  panelRadius: 12,
  tileRadius: 8,
  bigTileRadius: 12,
  rowAvatar: 28,
  listAvatar: 36,
  emptyAvatar: 56,
  /** 눈이 가는 면적을 터치(pointer: coarse)에서 이 값 이상으로 한다 */
  touch: 44,
  chipMax: 180,
} as const;

/**
 * 본문 열(메시지·입력 카드) 폭. 좁은 화면은 720px 그대로 두고, 넓은 화면(1286px 이상)에서는 화면 폭의 56% 로 넓혀 960px 에서 멈춘다.
 * 넓은 화면에서 본문이 가운데 좁은 띠로만 보이던 것을 고친다(OMAI-1224). 표·코드 같은 넓은 내용도 더 읽힌다.
 */
export const chatColumn = `clamp(${chatMetrics.column}px, 56vw, ${chatMetrics.columnMax}px)`;
/** 승인·되묻기 카드 줄처럼 열 폭 양옆에 16px 여백을 더 두는 곳의 폭 */
export const chatColumnPad = `calc(${chatColumn} + 32px)`;

/** 회의에서만 쓰는 에이전트 구분 색(스펙 §3-3). 별칭의 해시로 고른다. */
export const AVATAR_HUES = [
  '#4f6bed',
  '#0e9f6e',
  '#d9480f',
  '#9c36b5',
  '#1c7ed6',
  '#c2255c',
  '#5f3dc4',
  '#2b8a3e',
  '#e67700',
  '#087f5b',
  '#364fc7',
  '#a61e4d',
] as const;

/**
 * 색조 아바타 타일: 바탕은 그 색의 알파 0.18, 글자는 그 색에 다크는 흰색·라이트는 검정을 섞은 값.
 * 채도 높은 채움을 없애고 글자 대비는 4.5:1 이상으로 맞춘다(chatTokens.test.ts 가 12색 모두 고정한다).
 */
export function avatarTile(color: string, mode: 'dark' | 'light'): { bg: string; fg: string } {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  const to = mode === 'dark' ? 255 : 0;
  const k = 0.72;
  const mix = (v: number) => Math.round(v + (to - v) * k);
  return { bg: `rgba(${r}, ${g}, ${b}, 0.18)`, fg: `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})` };
}

/** 별칭 해시로 고른 색 번호(AVATAR_HUES 의 위치). 회의의 아바타·칩 점이 같은 에이전트에 같은 색을 쓴다. */
export function hueOf(name: string): string {
  let n = 0;
  for (const c of name) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_HUES[n % AVATAR_HUES.length];
}

/** 손가락으로 누르는 화면에서만 누르기 높이 44(스펙 2026-10-19-005 D2·R3). 마우스 화면은 탭 36·토글 약 33. 테마의 탭·토글, 오피스 얼굴 줄, DisclosureButton 이 함께 쓴다 */
export const coarseTouch = { '@media (pointer: coarse)': { minHeight: chatMetrics.touch } } as const;
