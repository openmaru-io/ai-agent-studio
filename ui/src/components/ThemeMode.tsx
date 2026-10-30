/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 다크·라이트 전환. 고른 값은 이 브라우저에 기억한다(저장소를 못 쓰는 환경에서는 기억 없이 동작한다).
import { CssBaseline, ThemeProvider } from '@mui/material';
import { createContext, ReactNode, useCallback, useContext, useMemo, useState } from 'react';

import { makeTheme, ThemeMode } from '@/theme';

export const THEME_KEY = 'aas-theme';

function readMode(): ThemeMode {
  try {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

interface ModeCtx {
  mode: ThemeMode;
  toggle: () => void;
  /** 설정 › 일반의 테마 카드(스펙 2026-10-14-013) */
  setMode: (mode: ThemeMode) => void;
}

const Ctx = createContext<ModeCtx>({ mode: 'dark', toggle: () => undefined, setMode: () => undefined });

function remember(mode: ThemeMode) {
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    /* 저장소를 못 쓰면 이번 방문에서만 바뀐다 */
  }
}

export function ThemeModeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(readMode);
  const toggle = useCallback(() => {
    setMode((cur) => {
      const next: ThemeMode = cur === 'dark' ? 'light' : 'dark';
      remember(next);
      return next;
    });
  }, []);
  const choose = useCallback((next: ThemeMode) => {
    remember(next);
    setMode(next);
  }, []);
  const theme = useMemo(() => makeTheme(mode), [mode]);
  const value = useMemo(() => ({ mode, toggle, setMode: choose }), [mode, toggle, choose]);
  return (
    <Ctx.Provider value={value}>
      <ThemeProvider theme={theme}>
        <CssBaseline enableColorScheme />
        {children}
      </ThemeProvider>
    </Ctx.Provider>
  );
}

export const useThemeMode = (): ModeCtx => useContext(Ctx);
