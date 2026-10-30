/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 오피스 장면의 상태 색(계획 007 §3-3 G7, DESIGN.md §1-1·§2). Claw3D 원본 색을 이 한 곳에서 덮어쓴다.
// 앰버는 경고 전용이라 '쉼'에 쓰지 않는다. 선택·따라가기는 빨강이 아니라 흰 고리다(빨강은 장애·삭제 전용).
export type SceneStatus = 'working' | 'idle' | 'error' | 'away' | 'unknown';

export const STATUS_COLOR: Record<SceneStatus, string> = {
  working: '#27a644',
  idle: '#8a8f98',
  error: '#DA291C',
  away: '#62666d',
  unknown: '#62666d',
};

export const SELECTION_RING = 'rgba(255,255,255,0.85)';

/** 장면 아바타의 상태 점 색. working 표시는 앉아 일하는 자세도 포함한다(원본 규칙). */
export function statusDotColor(opts: { error: boolean; working: boolean; away: boolean }): string {
  if (opts.error) return STATUS_COLOR.error;
  if (opts.working) return STATUS_COLOR.working;
  if (opts.away) return STATUS_COLOR.away;
  return STATUS_COLOR.idle;
}

/** 움직임 줄이기 설정(prefers-reduced-motion)이면 카메라·걷기를 즉시 옮긴다(G8). */
export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * 3D 장면 뒤 배경(테마를 따른다). 바닥·벽이 따뜻한 갈색이라 배경은 차가운 청회색으로 두어 건물이 떠 보이게 한다.
 * 가장자리 값은 콘솔 본문 배경(DESIGN.md contentBackground: 다크 #08090a, 라이트 #edeef2)에 이어진다.
 */
export const SCENE_BACKDROP = {
  dark: 'radial-gradient(ellipse at 50% 45%, #171b24 0%, #0d0f14 55%, #08090a 100%)',
  light: 'radial-gradient(ellipse at 50% 45%, #f6f7fa 0%, #e8eaf0 55%, #dcdfe8 100%)',
} as const;

/**
 * 장면 위 상태판·명단·하단 단추의 색(DESIGN.md §1-1.2 상호작용 상태, §2 다크·§2-1 라이트 토큰).
 * 라이트 테마에서는 패널도 밝은 카드 표면(#f5f6f9)이고, 선택·호버는 #111827 투명도 단계다.
 * solid 는 반투명 패널 위에서 아바타 상태 점의 테두리가 패널과 같은 색으로 보이게 하는 불투명 근사값이다.
 */
export const HUD_PALETTE = {
  dark: {
    surface: 'rgba(15,16,17,0.82)',
    solid: '#0f1011',
    line: 'rgba(255,255,255,0.08)',
    lineSoft: 'rgba(255,255,255,0.05)',
    fg: '#f7f8f8',
    fg2: '#d0d6e0',
    fg3: '#8a8f98',
    fg4: '#62666d',
    wash: 'rgba(255,255,255,0.06)',
    washHover: 'rgba(255,255,255,0.04)',
    accent: 'rgba(255,255,255,0.85)',
    shadow: '0 8px 24px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.04)',
    warn: '#f59e0b',
    error: '#ef5350',
  },
  light: {
    surface: 'rgba(245,246,249,0.88)',
    solid: '#f5f6f9',
    line: 'rgba(17,24,39,0.10)',
    lineSoft: 'rgba(17,24,39,0.06)',
    fg: '#111827',
    fg2: '#4b5563',
    fg3: '#6a717f', // #f5f6f9 위 4.5:1 이상인 가장 밝은 값(#6b7280 은 4.47:1, 스펙 2026-10-20-021 DR17)
    fg4: '#9ca3af',
    wash: 'rgba(17,24,39,0.05)',
    washHover: 'rgba(17,24,39,0.03)',
    accent: 'rgba(17,24,39,0.70)',
    shadow: '0 4px 12px rgba(0,0,0,0.08), 0 2px 4px rgba(0,0,0,0.04)',
    warn: '#ca8a04',
    error: '#dc2626',
  },
} as const;

/** 패널 안 상태 점. 라이트에서는 밝은 표면 위 대비를 위해 DESIGN.md §2-1 의 한 단계 어두운 짝을 쓴다. */
export const HUD_STATUS_COLOR: Record<'dark' | 'light', Record<SceneStatus, string>> = {
  dark: STATUS_COLOR,
  light: { working: '#16a34a', idle: '#9ca3af', error: '#dc2626', away: '#b4b9c2', unknown: '#b4b9c2' },
};

/**
 * 부서 현수막 천·글자·줄의 색(DESIGN.md 모노크롬 + 브랜드 레드 #DA291C). 천은 장면 배경과 같은 방향이다:
 * 다크는 어두운 패널색 천에 밝은 글자, 라이트는 흰 천에 먹색 글자. 부서 이름과 천 위쪽 띠는 브랜드 레드다(로그인 카드의 윗선과 같은 쓰임).
 * 다크 부서 이름은 어두운 천 위 대비(4.5:1)를 위해 브랜드 레드를 한 단계 밝힌다. 값은 tokens.test.ts 가 대비를 지킨다.
 */
export const BANNER_PALETTE = {
  dark: { clothA: '#16181c', clothB: '#0f1011', text: '#f7f8f8', team: '#f0594d', edge: '#DA291C', line: '#2a2d33', rope: '#8a8f98' },
  light: { clothA: '#ffffff', clothB: '#f8f9fb', text: '#111827', team: '#DA291C', edge: '#DA291C', line: '#d7dae1', rope: '#6b7280' },
} as const;

/** 애드벌룬 모델(balloon.glb)의 색 판. 원본은 청록·회색·갈색의 평면 색 네 칸이라 같은 칸 배치로 바꿔 칠한다. 두 테마가 같다. */
export const BALLOON_PALETTE = {
  stripe: '#f4f4f2',
  trim: '#9aa0a8',
  envelope: '#DA291C',
  basket: '#3a3a40',
  ink: '#1c1c20',
} as const;

/**
 * 3D 장면 객체 색(스펙 2026-10-20-012). 밝은 오크·월넛·따뜻한 회색·차콜의 사무실이다.
 * 색 계열은 두 테마가 같고 명도만 다르다 — 다크는 어두운 바닥·한 단계 밝은 벽, 라이트는 밝은 바닥·짙은 회색 벽.
 * 규칙(C1~C11: 빨강·앰버 금지, 채도 상한, 바닥·벽·가구·의자 대비)은 tokens.test.ts 가 지킨다.
 * 값은 재질 바탕색이다. GLB 가구는 원래 색과 80% 섞이고 조명을 받아 화면 색은 조금 다르다(parity/palette.mjs 가 화면에서 잰다).
 */
export type SceneTheme = 'dark' | 'light';

type Wood = { oak: string; walnut: string; trunk: string };
export type ScenePalette = {
  floor: string;
  floorLine: { color: string; opacity: number };
  wall: string;
  innerWall: string;
  baseboard: string;
  partition: string;
  glass: { color: string; opacity: number };
  glassFrame: string;
  doorHandle: [string, string];
  wood: Wood;
  chair: string;
  /** 책상·의자 다리 같은 짙은 금속 */
  metalLeg: string;
  couch: string;
  rug: string;
  rugEdge: string;
  monitor: string;
  coffee: string;
  fridge: string;
  cooler: string;
  cabinet: string;
  printer: string;
  lamp: string;
  lampShade: string;
  coat: string;
  booth: string;
  board: string;
  leaf: string;
  pot: string;
  kitchen: { cabinet: string; counter: string };
  /** 벽 그림. paper 는 그림 바탕, colors 는 그림 색(원본 색을 휘도가 가까운 색으로 바꾼다) */
  art: { colors: string[]; paper: string; frame: string; clockHand: string };
  /** 지금 배치에 없는 객체(서버실·ATM 등)의 역할 색 */
  props: { body: string; metal: string; dark: string; light: string };
  status: { ringOpacity: number; halo: { color: string; opacity: number } };
  selection: { color: string; hoverOpacity: number };
  /** 내 에이전트 발밑 고리·고른 대상 표시(스펙 2026-10-21-012). 흑백이다 — 장면의 빨강은 오류다. plateOpacity 는 반대 테마 색 이름표의 판 */
  mine: { ring: string; ringOpacity: number; plateOpacity: number };
  /** 아바타 이름표·말풍선·방 명패. 라이트는 밝은 판에 먹색 글자(검토 D17) */
  label: {
    plate: string;
    plateOpacity: number;
    outline: { color: string; opacity: number };
    hoverWash: { color: string; opacity: number };
    text: string;
    textSub: string;
    icon: string;
    meeting: string;
    errorPlate: string;
    errorText: string;
  };
  light: {
    ambient: { color: string; intensity: number };
    hemi: { sky: string; ground: string; intensity: number };
    aux: { color: string; intensity: number };
    spot: string;
  };
};

const ART = { colors: ['#57705f', '#9a8a80', '#4b5d73', '#d8cbb0', '#2f3134'], frame: '#1f2124', clockHand: '#2f3134' };

/** 원본 색을 휘도가 가장 가까운 그림 색으로 바꾼다. 그림의 명암 구성은 남기고 원색만 없앤다. */
export function artTone(p: ScenePalette, hex: string): string {
  const tones = [...p.art.colors, p.art.paper];
  const l = relLum(hex);
  return tones.reduce((best, t) => (Math.abs(relLum(t) - l) < Math.abs(relLum(best) - l) ? t : best), tones[0]);
}
function relLum(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export const SCENE_PALETTE: Record<SceneTheme, ScenePalette> = {
  dark: {
    floor: '#57524c',
    floorLine: { color: '#000000', opacity: 0.12 },
    wall: '#a39e95',
    innerWall: '#7f7a73',
    baseboard: '#2e2c29',
    partition: '#7b828a',
    glass: { color: '#c9d6dc', opacity: 0.18 },
    glassFrame: '#1f2124',
    doorHandle: ['#a9adb2', '#c7cacf'],
    wood: { oak: '#a5825f', walnut: '#3e3029', trunk: '#3e3029' },
    chair: '#1f2023',
    metalLeg: '#2e3035',
    couch: '#2f3a48',
    rug: '#3a3734',
    rugEdge: '#2e2c29',
    monitor: '#232528',
    coffee: '#2b2c2f',
    fridge: '#8f9499',
    cooler: '#9da1a5',
    cabinet: '#6f747a',
    printer: '#2e3035',
    lamp: '#8e939a',
    lampShade: '#a19d96',
    coat: '#2e3035',
    booth: '#3a3d43',
    board: '#a19d96',
    leaf: '#4d7556',
    pot: '#2a2c30',
    kitchen: { cabinet: '#9a958e', counter: '#3a3a3d' },
    art: { ...ART, paper: '#a19d96' },
    props: { body: '#6f747a', metal: '#a9adb2', dark: '#2b2c2f', light: '#9a958e' },
    status: { ringOpacity: 0.85, halo: { color: '#0f1011', opacity: 0.6 } },
    selection: { color: '#f7f8f8', hoverOpacity: 0.5 },
    mine: { ring: '#f7f8f8', ringOpacity: 0.9, plateOpacity: 0.95 },
    label: {
      plate: '#1b1f26',
      plateOpacity: 0.62,
      outline: { color: '#ffffff', opacity: 0.14 },
      hoverWash: { color: '#ffffff', opacity: 0.12 },
      text: '#f7f8f8',
      textSub: '#c3c8d0',
      icon: '#8a919c',
      meeting: '#4ade80',
      errorPlate: '#3a1016',
      errorText: '#ff9aa5',
    },
    light: {
      ambient: { color: '#e6e1d8', intensity: 0.62 },
      hemi: { sky: '#ffffff', ground: '#3a3836', intensity: 0.5 },
      aux: { color: '#d8dce2', intensity: 0.3 },
      spot: '#ffffff',
    },
  },
  light: {
    floor: '#c6c1b9',
    floorLine: { color: '#8a847c', opacity: 0.18 },
    wall: '#9b968f',
    innerWall: '#a9a49c',
    baseboard: '#4a4744',
    partition: '#9aa1a9',
    glass: { color: '#9fb0b8', opacity: 0.22 },
    glassFrame: '#1f2124',
    doorHandle: ['#a9adb2', '#c7cacf'],
    wood: { oak: '#b39672', walnut: '#806654', trunk: '#5d4433' },
    chair: '#3a3d43',
    metalLeg: '#3a3d43',
    couch: '#617286',
    rug: '#9c958b',
    rugEdge: '#8a847c',
    monitor: '#232528',
    coffee: '#2b2c2f',
    fridge: '#e0e2e5',
    cooler: '#e2e4e7',
    cabinet: '#8e939a',
    printer: '#d9dbde',
    lamp: '#8e939a',
    lampShade: '#ece9e4',
    coat: '#3a3d43',
    booth: '#8e939a',
    board: '#f4f2ee',
    leaf: '#3f6b4a',
    pot: '#34363a',
    kitchen: { cabinet: '#e6e3de', counter: '#3a3a3d' },
    art: { ...ART, paper: '#e6e1d8' },
    props: { body: '#8e939a', metal: '#a9adb2', dark: '#2b2c2f', light: '#e6e3de' },
    status: { ringOpacity: 0.85, halo: { color: '#ffffff', opacity: 0.8 } },
    selection: { color: '#111827', hoverOpacity: 0.5 },
    mine: { ring: '#111827', ringOpacity: 0.85, plateOpacity: 0.92 },
    label: {
      plate: '#f5f6f9',
      plateOpacity: 0.9,
      outline: { color: '#111827', opacity: 0.1 },
      hoverWash: { color: '#111827', opacity: 0.06 },
      text: '#111827',
      textSub: '#4b5563',
      icon: '#6b7280',
      meeting: '#16a34a',
      errorPlate: '#fdecec',
      errorText: '#b91c1c',
    },
    light: {
      ambient: { color: '#f2f1ee', intensity: 0.8 },
      hemi: { sky: '#ffffff', ground: '#9a958e', intensity: 0.6 },
      aux: { color: '#d8dce2', intensity: 0.3 },
      spot: '#ffffff',
    },
  },
};

/** 이름표 판 위 상태 점 색. 라이트는 밝은 판 위 대비를 위해 HUD 와 같은 짝을 쓴다. */
export const labelStatusColor = (theme: SceneTheme, opts: { error: boolean; working: boolean; away: boolean }): string => {
  const c = HUD_STATUS_COLOR[theme];
  if (opts.error) return c.error;
  if (opts.working) return c.working;
  if (opts.away) return c.away;
  return c.idle;
};

/** 내 에이전트 이름표·고른 회의실 명패의 색(스펙 2026-10-21-012): 반대 테마의 이름표 판·글자를 쓴다.
 *  판 불투명도만 높여 바닥이 비치지 않게 한다. 상태 점은 판 밝기에 맞게 labelStatusColor(theme 자리에 반환값 theme) 로 칠한다. */
export function mineLabel(theme: SceneTheme): {
  theme: SceneTheme;
  plate: string;
  plateOpacity: number;
  text: string;
  textSub: string;
  icon: string;
  outline: { color: string; opacity: number };
  hoverWash: { color: string; opacity: number };
} {
  const other: SceneTheme = theme === 'dark' ? 'light' : 'dark';
  const l = SCENE_PALETTE[other].label;
  return {
    theme: other,
    plate: l.plate,
    plateOpacity: SCENE_PALETTE[theme].mine.plateOpacity,
    text: l.text,
    textSub: l.textSub,
    icon: l.icon,
    outline: l.outline,
    hoverWash: l.hoverWash,
  };
}

/** 바닥 위 상태 고리 색. 라이트는 밝은 테두리 위 대비를 위해 한 단계 어두운 짝을 쓴다(HUD_STATUS_COLOR 와 같다). */
export const sceneRingColor = (theme: SceneTheme, status: SceneStatus): string => HUD_STATUS_COLOR[theme][status];

/**
 * GLB 가구의 색. 값이 문자열이면 모델의 모든 재질에, 객체면 재질 이름별로 칠한다(잎과 화분, 소파 천과 다리를 따로).
 * 재질 이름은 GLB 안의 이름이다(furnitureMaterials.test.ts 가 모델 파일과 대조한다). null 은 원래 색을 둔다(화면 내용).
 */
export type FurnitureTint = string | Record<string, string> | null;
export function furnitureTints(p: ScenePalette): Record<string, FurnitureTint> {
  const { oak, walnut, trunk } = p.wood;
  return {
    desk_cubicle: { wood: oak, metal: p.metalLeg },
    round_table: oak,
    executive_desk: { wood: walnut, metal: p.metalLeg },
    table_rect: walnut,
    bookshelf: walnut,
    chair: { carpet: p.chair, metalMedium: p.metalLeg },
    couch: { carpet: p.couch, wood: walnut },
    couch_v: { carpetBlue: p.couch, metal: p.metalLeg },
    beanbag: { carpetBlue: p.couch, metal: p.metalLeg },
    rug: { carpet: p.rug, carpetDarker: p.rugEdge },
    computer: p.monitor,
    pingpong: walnut,
    coffee_machine: { metalMedium: p.coffee, metal: p.coffee, carpetWhite: p.kitchen.cabinet },
    fridge: { metalLight: p.fridge, metal: p.fridge, metalDark: p.coffee, glass: p.coffee },
    water_cooler: { metalLight: p.cooler, metal: p.cooler, metalDark: p.coffee, glass: p.coffee },
    whiteboard: p.board,
    notice_board: p.board,
    kanban_wall: p.board,
    kanban_board: { wood: p.board, metal: p.metalLeg },
    tv_status: null,
    tv_meeting: null,
    locker: { wood: p.cabinet, metal: p.metalLeg },
    file_cabinet: p.cabinet,
    cabinet: { wood: p.cabinet, woodDark: p.kitchen.counter, metal: p.metalLeg },
    coat_rack: p.coat,
    lamp: { metal: p.lamp, lamp: p.lampShade },
    printer: { metalMedium: p.printer, carpetWhite: p.printer, metalDark: p.coffee, glass: p.coffee },
    plant: { plant: p.leaf, wood: p.pot, woodDark: p.pot },
    plant_cactus: { leafsGreen: p.leaf },
    plant_cactus_short: { leafsGreen: p.leaf },
    plant_palm: { leafsGreen: p.leaf, woodBark: trunk },
    plant_tree: { leafsGreen: p.leaf, woodBark: trunk },
  };
}
