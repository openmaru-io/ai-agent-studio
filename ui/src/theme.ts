/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// COP Console 의 테마(openmaru-cop-console/frontend/src/lib/themes.ts, components/App/themeSlice.ts)와 같은 값으로 만든
// MUI 테마다. 다크·라이트 두 판이고, 셸(Topbar·좌측 메뉴)은 두 판 모두 어둡다(lib/shellTokens.ts).
import { createTheme, Theme } from '@mui/material/styles';

import { coarseTouch } from '@/lib/chatTokens';
import {
  badgeFontSize,
  contentBackground,
  contentFontSize,
  dialogTokens,
  focusRingColor,
  shellColors,
  shellMetrics,
  tableHeaderOverlay,
  tableHeaderText,
  tabTokens,
} from '@/lib/shellTokens';

export type ThemeMode = 'dark' | 'light';

const content = `${contentFontSize}px`;
const badge = `${badgeFontSize}px`;


export function makeTheme(mode: ThemeMode): Theme {
  const dark = mode === 'dark';
  const bg = contentBackground[mode];
  const dlg = dialogTokens[mode];
  const ring = focusRingColor[mode]; // 키보드 포커스 링(스펙 2026-10-19-014). 화면의 sx 는 같은 값을 CSS 변수로 읽는다
  const tierBase = { borderRadius: '6px', border: '1px solid', padding: '5px 14px', minWidth: 0 } as const;
  return createTheme({
    palette: {
      mode,
      // 동작 색(단추·스위치·체크·링크·입력 포커스)은 파랑이 아니라 모노크롬이다. DESIGN.md §1-1(Hue Discipline)·§4 3-Tier:
      // 빨강은 파괴·경고에만(키보드 포커스는 2026-10-19-014 부터 무채색), 파랑(Sky)은 정보 안내에만 쓴다. 예전의 #1565C0 은 DESIGN.md 에 없는 색이었다(OMAI-1212).
      primary: { main: dark ? '#f7f8f8' : '#111827', contrastText: dark ? '#111827' : '#f7f8f8' },
      info: { main: dark ? '#60a5fa' : '#2563eb' },
      secondary: { main: dark ? '#1b1a19' : '#7d7d7d' },
      text: { primary: dark ? '#faf9f8' : '#1f1f1f' },
      background: { default: bg.default, paper: bg.surface },
    },
    shape: { borderRadius: 4 },
    typography: {
      fontFamily: ['Noto Sans KR', 'sans-serif'].join(', '),
      fontSize: contentFontSize,
      h1: { fontWeight: 600, fontSize: '1.7rem' },
      h6: { fontSize: '1.1rem', fontWeight: 500 },
      body1: { fontSize: content },
      body2: { fontSize: content },
      subtitle1: { fontSize: content, fontWeight: 500 },
      subtitle2: { fontSize: content, fontWeight: 500 },
      caption: { fontSize: badge },
      button: { textTransform: 'none', fontSize: content, fontWeight: 500 },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          ':root': { '--aas-focus-ring': ring },
          body: {
            '&::-webkit-scrollbar, & *::-webkit-scrollbar': { width: '0.3em', height: '0.3em' },
            '&::-webkit-scrollbar-thumb, & *::-webkit-scrollbar-thumb': { backgroundColor: '#c1c1c1', borderRadius: '3px' },
            '&::-webkit-scrollbar-thumb:hover, & *::-webkit-scrollbar-thumb:hover': { backgroundColor: '#a8a8a8' },
          },
        },
      },
      MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } },
      // 다이얼로그(OMAI-1181): 12px 둥근 패널, 제목 17px/700, 본문 13px/1.75, 단추는 3단계(DESIGN.md §4). 단추 색은 DialogActions 안에만 걸어 다른 단추는 바뀌지 않는다.
      MuiDialog: {
        defaultProps: { PaperProps: { variant: 'outlined' as const, elevation: 0 } },
        styleOverrides: { paper: { borderRadius: 12, backgroundColor: dlg.surface, borderColor: dlg.edge } },
      },
      MuiDialogTitle: {
        styleOverrides: { root: { padding: '20px 24px 8px', fontSize: '17px', fontWeight: 700, letterSpacing: '-0.2px', lineHeight: 1.4, color: dlg.title } },
      },
      MuiDialogContent: { styleOverrides: { root: { padding: '8px 24px', color: dlg.body } } },
      MuiDialogContentText: { styleOverrides: { root: { fontSize: '13px', lineHeight: 1.75, color: dlg.body } } },
      MuiDialogActions: {
        styleOverrides: {
          root: {
            padding: '16px 24px 20px',
            gap: '8px',
            '& > :not(style) ~ :not(style)': { marginLeft: 0 },
            // Tier 2: 취소·닫기(윤곽선)
            '& .MuiButton-text': { ...tierBase, color: dlg.tier2.text, borderColor: dlg.tier2.border, backgroundColor: 'transparent',
              '&:hover': { color: dlg.tier2.hoverText, borderColor: dlg.tier2.hoverBorder, backgroundColor: dlg.tier2.hoverBg } },
            // Tier 1: 저장·확인(단색 반투명 + 안쪽 빛)
            '& .MuiButton-contained': { ...tierBase, color: dlg.tier1.text, borderColor: dlg.tier1.border, backgroundColor: dlg.tier1.bg,
              boxShadow: `inset 0 0 0 1px ${dlg.tier1.glow}`,
              '&:hover': { borderColor: dlg.tier1.hoverBorder, backgroundColor: dlg.tier1.hoverBg, boxShadow: `inset 0 0 0 1px ${dlg.tier1.glow}` },
              '&.Mui-disabled': { opacity: 0.45, color: dlg.tier1.text } },
            // Tier 3: 되돌릴 수 없는 삭제(빨강 반투명)
            '& .MuiButton-containedError': { color: dlg.tier3.text, borderColor: dlg.tier3.border, backgroundColor: dlg.tier3.bg,
              boxShadow: 'inset 0 0 0 1px rgba(218, 41, 28, 0.18)',
              '&:hover': { color: dlg.tier3.hoverText, borderColor: dlg.tier3.hoverBorder, backgroundColor: dlg.tier3.hoverBg },
              '&.Mui-disabled': { opacity: 1, color: 'rgba(218, 41, 28, 0.5)', borderColor: 'rgba(218, 41, 28, 0.20)', backgroundColor: 'rgba(218, 41, 28, 0.06)' } },
            // 키보드 포커스 링(DESIGN.md §1-1.5, 무채색 2026-10-19-014)
            '& .MuiButton-root.Mui-focusVisible': { boxShadow: `0 0 0 2px ${ring}` },
          },
        },
      },
      // 다이얼로그 밖의 contained 단추도 3단계로 맞춘다(OMAI-1212). 테두리는 안쪽 그림자로 그려 단추 크기가 변하지 않는다.
      // 다이얼로그 안은 위 MuiDialogActions 의 더 구체적인 규칙이 이긴다.
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          containedPrimary: {
            color: dlg.tier1.text,
            backgroundColor: dlg.tier1.bg,
            boxShadow: `inset 0 0 0 1px ${dlg.tier1.border}, inset 0 0 0 2px ${dlg.tier1.glow}`,
            '&:hover': { backgroundColor: dlg.tier1.hoverBg, boxShadow: `inset 0 0 0 1px ${dlg.tier1.hoverBorder}, inset 0 0 0 2px ${dlg.tier1.glow}` },
            '&.Mui-disabled': { opacity: 0.45, color: dlg.tier1.text, backgroundColor: dlg.tier1.bg },
            // 키보드 포커스 링(DESIGN.md §1-1.5, 무채색 2026-10-19-014)
            '&.Mui-focusVisible': { boxShadow: `0 0 0 2px ${ring}` },
          },
          containedError: {
            color: dlg.tier3.text,
            backgroundColor: dlg.tier3.bg,
            boxShadow: `inset 0 0 0 1px ${dlg.tier3.border}`,
            '&:hover': { color: dlg.tier3.hoverText, backgroundColor: dlg.tier3.hoverBg, boxShadow: `inset 0 0 0 1px ${dlg.tier3.hoverBorder}` },
            '&.Mui-disabled': { opacity: 0.45, color: dlg.tier3.text, backgroundColor: dlg.tier3.bg },
            '&.Mui-focusVisible': { boxShadow: `0 0 0 2px ${ring}` },
          },
        },
      },
      MuiAppBar: {
        styleOverrides: { root: { borderBottom: `${shellMetrics.shellBorderWidth}px solid ${shellColors.shellBorder}` } },
      },
      MuiToolbar: {
        styleOverrides: {
          root: {
            minHeight: shellMetrics.topbarHeight,
            '@media (min-width:600px)': { minHeight: shellMetrics.topbarHeight },
          },
        },
      },
      MuiIconButton: {
        styleOverrides: { root: { '&.MuiIconButton-sizeMedium': { fontSize: shellMetrics.iconButtonSize } } },
      },
      MuiFormControlLabel: { styleOverrides: { label: { fontSize: content, marginLeft: '8px' } } },
      MuiAutocomplete: { styleOverrides: { input: { fontSize: content }, option: { fontSize: content } } },
      MuiInputBase: { styleOverrides: { input: { fontSize: content } } },
      MuiFormLabel: { styleOverrides: { root: { fontSize: content } } },
      MuiSelect: { styleOverrides: { root: { fontSize: content }, select: { fontSize: content } } },
      MuiMenuItem: { styleOverrides: { root: { fontSize: content } } },
      MuiListItemText: { styleOverrides: { primary: { fontSize: content } } },
      MuiTablePagination: { styleOverrides: { root: { fontSize: content } } },
      MuiTableCell: {
        styleOverrides: {
          root: { fontSize: content, paddingTop: '8px', paddingBottom: '8px' },
          head: {
            backgroundColor: tableHeaderOverlay[mode],
            color: tableHeaderText[mode].color,
            fontWeight: 500,
          },
        },
      },
      MuiChip: { styleOverrides: { root: { fontSize: badge }, label: { fontSize: badge } } },
      // 탭 줄: 켠 탭은 단색(DESIGN.md 「Tabs — Bordered Tabs」, §1-1.2). primary 파랑을 쓰지 않는다(OMAI-1127)
      // 높이는 36(MUI 기본 48 은 서랍·본문에서 컸다, 스펙 2026-10-19-005 R1). 손가락 화면만 44
      MuiTabs: { styleOverrides: { root: { minHeight: 36, ...coarseTouch }, indicator: { height: 2, backgroundColor: tabTokens[mode].accent } } },
      // 토글 묶음(항목별·자유 입력 등): 여백 4px 12px, 글자 13px, 높이 약 33. 키보드 포커스는 탭과 같은 안쪽 링(R3·G4·G9)
      MuiToggleButton: {
        styleOverrides: {
          root: {
            padding: '4px 12px',
            fontSize: content,
            ...coarseTouch,
            '&.Mui-focusVisible': { boxShadow: `inset 0 0 0 2px ${ring}` },
          },
        },
      },
      MuiTab: {
        styleOverrides: {
          root: {
            minHeight: 36,
            padding: '6px 12px',
            ...coarseTouch,
            fontSize: content,
            color: tabTokens[mode].text,
            '&:hover': {
              color: tabTokens[mode].hoverText,
              backgroundColor: tabTokens[mode].hoverBg,
              boxShadow: `inset 0 -2px 0 ${tabTokens[mode].hoverLine}`,
            },
            '&.Mui-selected': { color: tabTokens[mode].activeText, fontWeight: 600, backgroundColor: tabTokens[mode].activeBg },
            '&.Mui-selected:hover': { boxShadow: 'none' },
            // 키보드 포커스는 선택과 별개로 링(DESIGN.md §1-1.5). 스크롤 탭에서 잘리지 않게 안쪽에 그린다(표의 행 포커스와 같다)
            '&.Mui-focusVisible': { boxShadow: `inset 0 0 0 2px ${ring}` },
          },
        },
      },
      // 불러오는 중 줄: Observ UI(v-progress-linear :height="1" color="red-darken-4")와 같은 1px·#B71C1C.
      // 바탕은 Vuetify 처럼 같은 색을 옅게(24%) 깐다.
      MuiLinearProgress: {
        styleOverrides: {
          root: { height: 1, backgroundColor: 'rgba(183, 28, 28, 0.24)' },
          bar: { backgroundColor: '#B71C1C' },
        },
      },
      MuiTooltip: { styleOverrides: { tooltip: { fontSize: content, color: '#fff', backgroundColor: '#000' } } },
    },
  });
}

/** 기본 테마(다크). 테마 전환을 쓰지 않는 곳과 시험에서 쓴다. */
export const theme = makeTheme('dark');
