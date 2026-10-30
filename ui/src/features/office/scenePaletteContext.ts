/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 3D 장면 색을 Canvas 안으로 넘긴다(스펙 2026-10-20-012 §4-2). Canvas 안은 바깥 React 컨텍스트(useThemeMode)를 받지 못해
// RetroOffice3D 가 aasTheme 을 받아 Canvas 안쪽에 이 Provider 를 둔다. 테마는 Canvas key 에 넣지 않는다(넣으면 카메라·아바타가 처음으로 돌아간다).
import { createContext, useContext } from 'react';

import { SCENE_PALETTE, type ScenePalette, type SceneTheme } from './tokens';

export type ScenePaletteValue = { theme: SceneTheme; palette: ScenePalette };

export const ScenePaletteContext = createContext<ScenePaletteValue>({ theme: 'dark', palette: SCENE_PALETTE.dark });

export const scenePaletteValue = (theme: SceneTheme): ScenePaletteValue => SCENE_PALETTE_VALUES[theme];
const SCENE_PALETTE_VALUES: Record<SceneTheme, ScenePaletteValue> = {
  dark: { theme: 'dark', palette: SCENE_PALETTE.dark },
  light: { theme: 'light', palette: SCENE_PALETTE.light },
};

export const useScenePalette = (): ScenePaletteValue => useContext(ScenePaletteContext);
