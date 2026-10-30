/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 3D 장면 색 표의 규칙(스펙 2026-10-20-012 §2-2 C1~C11). 값은 재질 바탕색이고, 화면 색은 parity/palette.mjs 가 잰다.
import { describe, expect, it } from 'vitest';

import { buildAasKoreanOffice } from './scene3d/retro-office/core/aasKoreanOffice';
import { resolveItemTypeKey } from './scene3d/retro-office/core/geometry';
import { furnitureTints, labelStatusColor, mineLabel, SCENE_BACKDROP, SCENE_PALETTE, type ScenePalette, sceneRingColor,type SceneTheme } from './tokens';

const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const hsl = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return { h: (h + 360) % 360, s, l };
};

const THEMES: SceneTheme[] = ['dark', 'light'];
const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

/** 가구·건물 색(이름표·상태·조명은 빼고). 식물·벽 그림은 따로 센다. */
const objectColors = (p: ScenePalette) => {
  const decor = [p.leaf, ...p.art.colors, p.art.paper];
  const building = [p.floor, p.wall, p.innerWall, p.baseboard, p.partition, p.glass.color, p.glassFrame, ...p.doorHandle];
  const furniture = [
    p.wood.oak, p.wood.walnut, p.wood.trunk, p.chair, p.metalLeg, p.couch, p.rug, p.rugEdge, p.monitor, p.coffee, p.fridge, p.cooler,
    p.cabinet, p.printer, p.lamp, p.lampShade, p.coat, p.booth, p.board, p.pot, p.kitchen.cabinet, p.kitchen.counter,
    p.props.body, p.props.metal, p.props.dark, p.props.light, p.art.frame, p.art.clockHand,
  ];
  return { decor, solid: [...building, ...furniture] };
};
/** 바닥과 3:1 을 넘어도 되는 짙은 작은 소품(C10 예외, 검토 D3·D9). */
const smallDark = (p: ScenePalette) => new Set([p.chair, p.metalLeg, p.monitor, p.coffee, p.printer, p.coat, p.leaf, p.pot, p.wood.trunk, p.kitchen.counter, p.props.dark, p.art.frame, p.art.clockHand, p.glassFrame, p.baseboard, p.booth, ...p.doorHandle]);
const backdropEdge: Record<SceneTheme, string> = { dark: '#08090a', light: '#dcdfe8' };

describe('SCENE_PALETTE', () => {
  it('C1: 두 테마의 키가 같다', () => {
    const keys = (o: object, pre = ''): string[] =>
      Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keys(v, `${pre}${k}.`) : [`${pre}${k}`]));
    expect(keys(SCENE_PALETTE.dark).sort()).toEqual(keys(SCENE_PALETTE.light).sort());
  });

  it('C1: AAS 배치에 나오는 가구 종류는 모두 색이 정해져 있다', () => {
    const tints = furnitureTints(SCENE_PALETTE.dark);
    // GLB 가 아니라 코드로 그리는 종류: 건물(벽·유리·칸막이·문·방 경계), 탕비실(싱크·전자레인지), 키보드·마우스(무채색 소품), 1인 부스(props)
    const drawn = new Set(['wall', 'glass_wall', 'partition', 'door', 'room', 'boundary', 'sink', 'microwave', 'keyboard', 'mouse', 'phone_booth']);
    const types = new Set(buildAasKoreanOffice().map((i) => (i.wall && i.type === 'kanban_board' ? 'kanban_wall' : resolveItemTypeKey(i))));
    const missing = [...types].filter((t) => !drawn.has(t) && !(t in tints));
    expect(missing).toEqual([]);
  });

  for (const theme of THEMES) {
    const p = SCENE_PALETTE[theme];
    const { decor, solid } = objectColors(p);

    it(`${theme} C2: 건물·가구 채도는 0.35, 식물·벽 그림은 0.45 이하다`, () => {
      for (const c of solid) expect({ c, s: hsl(c).s <= 0.35 }).toEqual({ c, s: true });
      for (const c of decor) expect({ c, s: hsl(c).s <= 0.45 }).toEqual({ c, s: true });
    });

    it(`${theme} C3·C4: 빨강(345~15°)·주황(15~35°)·앰버(35~60°)로 읽히는 색이 없다`, () => {
      for (const c of [...solid, ...decor]) {
        const { h, s } = hsl(c);
        const red = (h >= 345 || h < 15) && s > 0.3;
        const orange = h >= 15 && h < 35 && s > 0.3;
        const amber = h >= 35 && h < 60 && s > 0.5;
        expect({ c, bad: red || orange || amber }).toEqual({ c, bad: false });
      }
    });

    // C5(외벽 대 배경 3:1~4.5:1)는 화면에서 잰다(parity/palette.mjs). 외벽 바깥면은 수직이라 빛을 덜 받아 바탕색보다 훨씬 어둡게 그려진다 —
    // 2026-10-20 측정: 바탕 #7a756e 가 화면에서 #443f36(배경 대비 1.85)이었다. 여기서는 방향만 본다: 다크는 벽이 배경보다 밝고, 라이트는 어둡다.
    it(`${theme} C5: 외벽은 배경과 반대쪽 명도다(대비 수치는 parity/palette.mjs)`, () => {
      expect(SCENE_BACKDROP[theme]).toContain(backdropEdge[theme]);
      if (theme === 'dark') expect(lum(p.wall)).toBeGreaterThan(lum(backdropEdge.dark));
      else expect(lum(p.wall)).toBeLessThan(lum(backdropEdge.light));
    });

    it(`${theme} C6: 바닥과 외벽은 1.5:1 이상이다`, () => {
      expect(contrast(p.floor, p.wall)).toBeGreaterThanOrEqual(1.5);
    });

    it(`${theme} C7: 큰 가구(책상·회의 탁자·소파·깔개)는 바닥에서 1.4:1 이상 뜬다`, () => {
      for (const c of [p.wood.oak, p.wood.walnut, p.couch, p.rug]) expect({ c, r: contrast(p.floor, c) >= 1.4 }).toEqual({ c, r: true });
    });

    it(`${theme} C8: 의자는 바닥과 2:1 이상이다`, () => {
      expect(contrast(p.floor, p.chair)).toBeGreaterThanOrEqual(2);
    });

    it(`${theme} C9: 상태 고리와 그 테두리는 3:1 이상이다`, () => {
      for (const s of ['working', 'error'] as const) expect(contrast(sceneRingColor(theme, s), p.status.halo.color)).toBeGreaterThanOrEqual(3);
    });

    it(`${theme} C10: 짙은 작은 소품을 뺀 건물·가구는 바닥과 3:1 이하다`, () => {
      const skip = smallDark(p);
      // 유리는 불투명도 0.18~0.22 로 그려 바탕색 대비가 화면 대비가 아니다
      for (const c of solid.filter((c) => !skip.has(c) && c !== p.floor && c !== p.glass.color)) expect({ c, r: contrast(p.floor, c) <= 3 }).toEqual({ c, r: true });
    });

    it(`${theme} C11: 장식 초록(90~170°)은 채도 0.30·휘도 0.15 이하다`, () => {
      for (const c of [...solid, ...decor]) {
        const { h, s } = hsl(c);
        if (h >= 90 && h <= 170 && s > 0.05) expect({ c, ok: s <= 0.3 && lum(c) <= 0.15 }).toEqual({ c, ok: true });
      }
    });

    it(`${theme}: 이름표 글자는 판 위에서 4.5:1 이상이다`, () => {
      expect(contrast(p.label.text, p.label.plate)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.label.textSub, p.label.plate)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.label.errorText, p.label.errorPlate)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.label.text, p.label.errorPlate)).toBeGreaterThanOrEqual(4.5);
    });

    // 스펙 2026-10-21-012: 내 에이전트·고른 대상 표시
    it(`${theme}: 내 에이전트 이름표(반대 테마 판) 글자는 4.5:1, 상태 점은 3:1 이상이다`, () => {
      const m = mineLabel(theme);
      expect(m.plate).toBe(SCENE_PALETTE[theme === 'dark' ? 'light' : 'dark'].label.plate);
      expect(contrast(m.text, m.plate)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(m.textSub, m.plate)).toBeGreaterThanOrEqual(4.5);
      for (const o of [{ error: true, working: false, away: false }, { error: false, working: true, away: false }]) {
        expect(contrast(labelStatusColor(m.theme, o), m.plate)).toBeGreaterThanOrEqual(3);
      }
    });

    it(`${theme}: 내 표시 고리는 바닥·깔개와 3:1 이상이다`, () => {
      for (const c of [p.floor, p.rug]) expect({ c, r: contrast(p.mine.ring, c) >= 3 }).toEqual({ c, r: true });
    });

    it(`${theme}: 가구 색은 모두 hex 이고 표 안의 값이다`, () => {
      for (const [type, tint] of Object.entries(furnitureTints(p))) {
        const values = tint === null ? [] : typeof tint === 'string' ? [tint] : Object.values(tint);
        for (const v of values) expect({ type, v, hex: isHex(v) }).toEqual({ type, v, hex: true });
      }
    });
  }
});
