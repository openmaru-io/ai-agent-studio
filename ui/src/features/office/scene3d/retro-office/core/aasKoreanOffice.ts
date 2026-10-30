/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// AAS: 한국의 일반 사무실 기본 배치(계획 2026-10-13-001). 원본 Claw3D 배치(DEFAULT_FURNITURE)는 고치지 않고 따로 둔다.
//
//  x 0       360      600      840      1080     1320        1520        1800
//  y0 ┌────────┬────────┬────────┬────────┬────────┐  상황판   ┌──────────┐ 북쪽 외벽(창)
//     │대회의실  │팀회의실1│팀회의실2│팀회의실3│팀회의실4│  통로     │[문] TFT1  │
//  200├─[문]───┴─[문]───┴─[문]───┴─[문]───┴─[문]───┘           ├──────────┤
//     │                                                            │[문] TFT2  │
//     │  [팀장석]            [팀장석]             [팀장석]            ├──────────┤
//     │  [구역1 섬]          [구역2 섬]           [구역3 섬]          │[문] TFT3  │
//     │  [팀장석]                                                720├──────────┤ (TFT3 남쪽 벽을 탕비실과 함께 씀, kr-19)
//     │  [구역4 섬]          [구역5 섬]           [구역6 섬]          │[문] 탕비실 │
//     │집중실        휴게        입구     복합기·문서함·사물함·게시판 │           │
// 1080└──────────────────────[입구]─────────────────────────────────┴───────────┘ 남쪽 외벽
//
// 규칙: 방은 외벽에 붙인다. 문 폭은 100(격자 25 에 벽 여유 15 씩을 빼도 두 칸이 남는다, 독립 검토 O10).
// 남쪽 외벽에는 입구를 그리기만 하고 길은 막는다(바닥 밖으로 나가지 않게, O8).
import { AAS_OUTER_WALL_THICKNESS, SCALE } from "@/features/office/scene3d/retro-office/core/constants";
import { getItemBounds } from "@/features/office/scene3d/retro-office/core/geometry";
import type { FurnitureItem } from "@/features/office/scene3d/retro-office/core/types";

/** 배치 판본 이름. 서버가 저장된 판본과 다르면 이 배치로 자동으로 바꾼다(계획 §3-5, D6). 배치를 크게 바꾸면 올린다. */
export const AAS_LAYOUT_PRESET = "kr-21"; // kr-21: 북쪽을 10석 팀 회의실 3개로 나누고 대회의실을 없앴으며, 북쪽 방 깊이를 240 으로, 책상 섬 6개를 25 내렸다(2026-10-26). kr-20: 탕비실 서쪽 벽을 유리벽으로 바꿨다(2026-10-26). kr-19: 탕비실 벽을 TFT 회의실 벽 줄에 맞추고 TFT 회의실 3 과 벽을 함께 쓰며 문을 서쪽으로 냈다(2026-10-26). kr-18: 탕비실 탁자를 키우고 의자를 4개로 늘렸고, 휴게 공간 소파를 남쪽 벽에 붙이고, 아래 줄 책상 섬을 50 내렸다(2026-10-26). kr-17: 회의실 탁자를 넓히고 의자 간격을 50 으로 벌려 가운데 의자에도 앉을 수 있게 했다(2026-10-21). kr-16: 서로 겹치던 벽·유리벽 상자를 떼어 z-fighting 깜빡임을 없앴다(2026-10-20). kr-15: 회의실·탕비실 유리문 너비를 100 → 65 로 줄였다(2026-10-20)

const T = 8; // 벽 두께
/** 외벽은 바닥 경계선을 가운데로 두께 0.12 로 그려져 안쪽 면이 경계선에서 이만큼 들어와 있다. 이 값보다 가까이 놓으면 가구가 벽 안으로 들어간다. */
const OUTER_WALL_INSET = Math.ceil((AAS_OUTER_WALL_THICKNESS / 2 / SCALE) * 10) / 10;
const DOOR = 100; // 입구(나무문)
/** 유리문(회의실·탕비실) 너비(kr-15, 2026-10-20 — 회의실 문을 줄이고 탕비실 유리문도 같은 크기로). 길찾기 격자(25)는 벽마다 양쪽 15 를 막으므로
 *  문 가운데를 격자 칸 가운데에 맞춰야 이 너비에서 가운데 한 칸이 열린다(55 이하면 그 칸도 막힌다). */
const GLASS_DOOR = 65;
const GRID = 25;
/** 문 가운데를 center 에서 가장 가까운 격자 칸 가운데로 옮겨 유리문(GLASS_DOOR)의 시작 좌표를 돌려준다 */
const glassDoorGap = (center: number) => Math.floor(center / GRID) * GRID + GRID / 2 - GLASS_DOOR / 2;
const NORTH = 240; // 북쪽 방들의 깊이. kr-21: 200 → 240(TFT 회의실 한 칸과 같은 깊이)
/** 탕비실 서쪽 벽(TFT 회의실 서쪽 벽과 같은 줄)과 북쪽 벽(TFT 회의실 3 의 남쪽 벽) — kr-19 */
const PANTRY_X = 1520;
const PANTRY_TOP = 720;
const SOUTH = 1080; // 남쪽 외벽 안쪽 — 벽에 붙이는 가구는 여기까지 닿는다
/** 주방 상판 윗면 높이(장면 단위) — objects/kitchen.tsx 의 AAS_COUNTER_HEIGHT 와 같다. 상판 위 물건의 elevation 기준 */
const COUNTER_TOP = 0.504;
const DESK_W = 56; // 책상 너비(모델을 이 크기에 맞춰 그린다)
const DESK_D = 40; // 책상 깊이

type Seed = Omit<FurnitureItem, "_uid">;

const wall = (x: number, y: number, w: number, h: number, type = "wall"): Seed => ({ type, x, y, w, h });
/** 가로 벽에 문 하나를 낸다. gapX 부터 door 만큼 비운다. */
function hWallWithDoor(x0: number, x1: number, y: number, gapX: number, type = "glass_wall", glassDoor = type === "glass_wall", door = DOOR): Seed[] {
  return [
    wall(x0, y, gapX - x0, T, type),
    wall(gapX + door, y, x1 - gapX - door, T, type),
    { type: "door", x: gapX, y, w: door, h: T, ...(glassDoor ? { glass: true } : {}) }, // 회의실(유리벽)·탕비실 문은 유리문
  ];
}
/** 세로 벽에 문 하나를 낸다. 문 항목은 가운데를 축으로 90도 돌린다. */
function vWallWithDoor(x: number, y0: number, y1: number, gapY: number, type = "glass_wall", door = DOOR, glassDoor = type === "glass_wall"): Seed[] {
  return [
    wall(x, y0, T, gapY - y0, type),
    wall(x, gapY + door, T, y1 - gapY - door, type),
    { type: "door", x: x + T / 2 - door / 2, y: gapY + door / 2 - T / 2, w: door, h: T, facing: 90, ...(glassDoor ? { glass: true } : {}) },
  ];
}

/** 바닥 좌표에서 (cx, cy) 를 축으로 facing 만큼 돈 국소 벡터 (a, b). 장면의 회전 규칙과 같다(+b 가 모델 앞). */
function turn(facing: number, a: number, b: number): [number, number] {
  const r = (facing * Math.PI) / 180;
  return [a * Math.cos(r) + b * Math.sin(r), -a * Math.sin(r) + b * Math.cos(r)];
}

/** 모델을 상자에 맞춰(fit) 가운데 (cx, cy) 에 놓는다. 상자는 돌리기 전 크기 w×h 다. */
function placed(type: string, cx: number, cy: number, w: number, h: number, facing: number, extra: Partial<Seed> = {}): Seed {
  return { type, x: cx - w / 2, y: cy - h / 2, w, h, facing, fit: true, ...extra };
}

/** 책상 한 벌. (cx, cy) 는 책상 가운데, facing 은 앉는 쪽(0 남·90 동·180 북·270 서). 의자는 앉는 쪽, 모니터는 반대쪽. */
function deskSet(cx: number, cy: number, facing: number, zone: number, lead = false): Seed[] {
  const at = (a: number, b: number): [number, number] => {
    const [dx, dy] = turn(facing, a, b);
    return [cx + dx, cy + dy];
  };
  const [mx, my] = at(0, -DESK_D / 2 + 9);
  const [kx, ky] = at(-4, DESK_D / 2 - 9); // 키보드는 모니터 앞 가운데, 마우스는 그 오른쪽
  const [ox, oy] = at(12, DESK_D / 2 - 9);
  const [chx, chy] = at(0, DESK_D / 2 + 16);
  return [
    placed("desk_cubicle", cx, cy, DESK_W, DESK_D, facing, { zone, ...(lead ? { lead: true } : {}) }),
    placed("computer", mx, my, 26, 12, facing),
    placed("keyboard", kx, ky, 22, 8, facing),
    placed("mouse", ox, oy, 6, 8, facing),
    placed("chair", chx, chy, 24, 24, (facing + 180) % 360),
  ];
}

/** 책상 섬(위에서 본 모양, 북쪽이 위):
 *        [팀장 의자]
 *        [팀장 책상]
 *   ─────────────────  가로 칸막이
 *  의자 [책상]│[책상] 의자
 *  의자 [책상]│[책상] 의자
 *  의자 [책상]│[책상] 의자
 *  가운데 세로 칸막이에 양쪽 책상을 맞대고 의자는 책상 바깥쪽이라 서로 마주 본다. (cx, top) 은 가로 칸막이 가운데 위. */
function island(cx: number, top: number, zone: number): Seed[] {
  const P = 6; // 칸막이 두께
  const out: Seed[] = [];
  out.push(...deskSet(cx, top - DESK_D / 2, 180, zone, true));
  out.push(wall(cx - P / 2 - DESK_D, top, 2 * DESK_D + P, P, "partition"));
  const y0 = top + P;
  for (let i = 0; i < 3; i += 1) {
    const cy = y0 + DESK_W / 2 + i * DESK_W;
    out.push(...deskSet(cx - P / 2 - DESK_D / 2, cy, 270, zone));
    out.push(...deskSet(cx + P / 2 + DESK_D / 2, cy, 90, zone));
  }
  out.push(wall(cx - P / 2, y0, P, 3 * DESK_W, "partition"));
  return out;
}

/** 회의 의자 간격(가운데 사이). 격자(25) 두 칸이다 — 의자(24)가 한 칸에 들어가게 놓으면 의자 사이에 빈 칸이 하나 남아
 *  사람이 그 칸으로 들어와 앉는다(kr-17). 간격 33~43 일 때는 의자 칸이 붙어 벽 쪽 줄 가운데 의자에 들어올 칸이 없었다(사용자 보고 2026-10-21). */
const CHAIR_PITCH = 2 * GRID;

/** 탁자 하나와 둘레 의자. 의자는 탁자에서 14 띄운다(가운데가 26 밖) — 탁자 여유(15)와 겹치면 격자 25 에서 의자 칸이 막힌다.
 *  cx 는 격자 칸 가운데(25k + 12.5)로 옮긴다: 의자 상자(24)가 칸 하나에만 걸쳐 의자 사이 칸이 비게 한다. */
function meetingTable(cx: number, cy: number, w: number, h: number, perSide: number, ends: boolean): Seed[] {
  cx = Math.floor(cx / GRID) * GRID + GRID / 2;
  const out: Seed[] = [placed("table_rect", cx, cy, w, h, 0)];
  for (let i = 0; i < perSide; i += 1) {
    const sx = cx + (i - (perSide - 1) / 2) * CHAIR_PITCH;
    out.push(placed("chair", sx, cy - h / 2 - 26, 24, 24, 0));
    out.push(placed("chair", sx, cy + h / 2 + 26, 24, 24, 180));
  }
  if (ends) {
    out.push(placed("chair", cx - w / 2 - 26, cy, 24, 24, 90));
    out.push(placed("chair", cx + w / 2 + 26, cy, 24, 24, 270));
  }
  return out;
}

/** 회의실 빔 프로젝터 스크린(type tv_meeting). 모든 회의실에 같은 기준으로 건다: 탁자 긴 축 끝의 벽에, 탁자 가운데 줄에 맞춰,
 *  너비 150. wallX 는 벽 안쪽 면의 x, facing 은 화면 앞면 방향(90 동쪽·270 서쪽)이다(판본 kr-5). */
const SCREEN_W = 150;
const SCREEN_D = 6;
function screen(wallX: number, cy: number, facing: 90 | 270): Seed {
  const cx = facing === 90 ? wallX + SCREEN_D / 2 : wallX - SCREEN_D / 2;
  return placed("tv_meeting", cx, cy, SCREEN_W, SCREEN_D, facing);
}

function room(x: number, y: number, w: number, h: number, kind: "meeting" | "team" | "tft", label: string, zone?: number): Seed {
  return { type: "room", x, y, w, h, kind, label, ...(zone ? { zone } : {}) };
}

/** 북쪽 팀 회의실(x0, x1, 이름, 구역). kr-21 부터 셋이다 */
export const NORTH_ROOMS: readonly (readonly [number, number, string, number])[] = [
  [0, 440, "팀 회의실 1", 1],
  [440, 880, "팀 회의실 2", 2],
  [880, 1320, "팀 회의실 3", 3],
];

/** 북쪽 회의실마다 북쪽 벽 가운데의 x(장면 픽셀) — 방 항목(room, x0+T ~ x1)의 가운데.
 *  벽 액자를 회의실마다 하나씩 가운데에 건다(OMAI-1510) */
export function northRoomWallCenters(): number[] {
  return NORTH_ROOMS.map(([x0, x1]) => (x0 + T + x1) / 2);
}

let southPictureX: number | null = null;

/** 남쪽 벽 출입문 옆 액자의 x(장면 픽셀) — 휴게 소파 동쪽 끝과 알림판 서쪽 끝 사이 벽의 가운데(OMAI-1510).
 *  전에는 알림판과 출입문 사이(830)에 붙어 있었다. 배치에서 계산하므로 소파·알림판을 옮기면 따라간다 */
export function southLoungePictureX(): number {
  if (southPictureX !== null) return southPictureX;
  const south = buildAasKoreanOffice().filter((i) => i.type !== "boundary" && getItemBounds(i).y + getItemBounds(i).h > 1040);
  const sofaRight = Math.max(...south.filter((i) => i.type === "couch").map((i) => getItemBounds(i).x + getItemBounds(i).w));
  const board = south.find((i) => i.type === "notice_board");
  southPictureX = board ? (sofaRight + getItemBounds(board).x) / 2 : 830;
  return southPictureX;
}

export function buildAasKoreanOffice(): FurnitureItem[] {
  const s: Seed[] = [];

  // ── 북쪽 방들: 팀 회의실 1~3(0~440·440~880·880~1320), 10석씩. 방 사이에 빈 칸을 두지 않는다(kr-4 —
  //    팀 회의실 2·3 사이 상황판 자리 840~920 에 벽이 두 겹이었다). 1320~1520 은 통로로 비워 동쪽 TFT 회의실 문에 닿게 한다.
  //    kr-21(2026-10-26, 회의실을 3등분해 10명씩 들어가는 회의실 3개로, 대회의실은 없애고 모두 같은 회의실로):
  //    kr-20 까지는 대회의실(0~360, 10석) + 팀 회의실 1~4(240 씩, 6석, 구역 1·2·3·6)였다. 세 방은 바로 아래 책상 섬 열(구역 1·2·3)에
  //    붙는다. 대회의실이 없으므로 짝 회의실이 없는 회의(팀이 4개 이상일 때 등)는 회의실로 옮기지 않고 제자리에서 한다(meetings.ts 의
  //    meetingPlaces 가 kind "meeting" 이 없으면 장소를 정하지 않는다, 사용자 결정 2026-10-26)
  for (const [x0, x1, label, zone] of NORTH_ROOMS) {
    const left = x0 > 0 ? x0 + T : x0; // 서쪽 벽 안쪽 면(첫 방은 외벽)
    s.push(...hWallWithDoor(x0, x1, NORTH, glassDoorGap((x0 + x1) / 2), "glass_wall", true, GLASS_DOOR));
    if (x0 > 0) s.push(wall(x0, 0, T, NORTH));
    s.push(room(x0 + T, 0, x1 - x0 - T, NORTH, "team", label, zone));
    // 10석(한쪽 5). 탁자는 방 가운데(meetingTable 이 격자 칸 가운데로 옮긴다), 깊이 가운데 120. 스크린은 서쪽 벽(탁자 서쪽 끝을 마주 본다)
    s.push(...meetingTable((left + x1) / 2, NORTH / 2, 240, 56, 5, false));
    s.push(screen(left, NORTH / 2, 90));
  }
  s.push(wall(1320, 0, T, NORTH));
  // 상황판(tv_status, 누르면 서버 패널). 팀 회의실 4 와 TFT 회의실 1 사이 통로의 북쪽 외벽 가운데(1328~1520 의 가운데)에
  //    모델을 자리 상자에 맞춰(fit) 건다. kr-6 까지는 원본 배율로 그려 팀 회의실 4 동쪽 벽에 걸쳐 보였다(kr-7 에서 뺐다가 kr-8 에서 되살림)
  s.push(placed("tv_status", 1424, 4, 90, 8, 0, { elevation: 0.12 }));

  // ── 동쪽 TFT 회의실 3개(1520~1800 × 0~720). 문은 서쪽 벽, 탁자는 방 가운데, TV 는 동쪽 벽
  for (let i = 0; i < 3; i += 1) {
    const y0 = i * 240;
    s.push(...vWallWithDoor(1520, y0, y0 + 240, glassDoorGap(y0 + 120), "glass_wall", GLASS_DOOR)); // 문 가운데는 kr-14 까지와 같은 y0 + 120 근처
    // 방 사이 가로벽은 세로 유리벽의 동쪽 면(1520 + T)에서 시작한다(kr-16). 1520 에서 시작하면 유리벽 상자 안에 들어가
    // 두 상자의 서쪽 면·윗면이 같은 평면이 되어, 카메라를 움직일 때 깜빡이고 멈추면 벽 끝면에 유리 색이 점무늬로 남았다
    s.push(wall(1520 + T, y0 + 240, 280 - T, T));
    s.push(room(1520 + T, y0 + (i === 0 ? 0 : T), 280 - T, 240 - (i === 0 ? 0 : T), "tft", `TFT 회의실 ${i + 1}`));
    s.push(...meetingTable(1655, y0 + 125, 140, 64, 3, false)); // kr-17: 탁자 130 → 140
    s.push(screen(1800, y0 + 125, 270)); // 동쪽 외벽(문은 서쪽 벽)
  }

  // ── 가운데 업무 구역: 책상 섬 3열 × 2행(구역 1~6), 섬마다 팀장석. 북쪽 방에서 떼어 남쪽으로 내린다(kr-4)
  const cols = [230, 700, 1170];
  // kr-18: 아래 줄(구역 4~6)을 730 → 780 으로 남쪽(휴게 공간 소파 쪽 벽)에 50 내렸다(2026-10-26, 책상섬 사이 간격이 좁았다).
  //   두 줄 사이 빈 곳이 68(위 줄 섬 끝 594 ~ 아래 줄 팀장 의자 662) → 118 이 된다. 아래 줄 섬 끝(954)과 남쪽 집기(복합기·사물함 앞 통행 여유 1031)
  //   사이에는 격자 세 칸이 남는다.
  //   kr-21: 두 줄을 모두 25 내렸다(420·780 → 445·805, 2026-10-26, 책상섬 6개를 모두 똑같이 아래로). 북쪽 회의실이 240 으로
  //   깊어져 벽(통행 여유 263)과 위 줄 팀장 의자(377) 사이가 114, 아래 줄 섬 끝 통행 여유(994)와 남쪽 집기 앞(1031) 사이에 격자 한 줄
  //   (1000~1025)이 남는다. 더 내리면 그 줄이 막혀 남쪽 벽을 따라 지나갈 길이 끊긴다
  const rows = [445, 805];
  rows.forEach((y, r) => cols.forEach((x, c) => s.push(...island(x, y, r * 3 + c + 1))));

  // ── 남서쪽 모서리: 1인 집중실(전화 부스)을 서쪽·남쪽 벽에 붙이고, 그 위 서쪽 벽에 칸반 보드를 건다(앞면이 동쪽).
  //    칸반 보드는 원본 모델이 ㄴ자 책상이라 탁자로 보였다. kr-4 에서 게시판 같은 벽 판(wall)으로 바꿨다.
  //    🔴 남쪽 벽에 걸면 안 된다: 기본 카메라가 남쪽에서 보므로 남쪽 벽(높이 1)이 판을 가려 보이지 않았다(OKE 확인)
  s.push(
    { type: "phone_booth", x: OUTER_WALL_INSET, y: SOUTH - 72 - OUTER_WALL_INSET }, // 서쪽·남쪽 외벽의 안쪽 면에 붙인다(벽 안으로 들어가지 않게)
    placed("kanban_board", 3, 880, 130, 6, 90, { wall: true }),
  );

  // ── 휴게 공간(380~720 × 920~1070, 벽 없음)
  s.push(
    placed("rug", 510, 980, 140, 82, 0), // 탁자 밑에 깐다(fit — 원본 배율로 그리면 모델이 상자에서 비켜 그려졌다). 길을 막지 않는다(걸어다닌다)
    // 소파는 의자와 같은 비율(배율 1.2, 66×28)이다. 100×40 일 때는 의자의 1.65 배라 앉은 사람이 방석에 파묻혀 보였다(2026-10-16 사용자 보고).
    //   두 소파는 붙여서 탁자·양탄자 가운데(510)에 맞춘다.
    //   kr-18: 뒷면을 남쪽 외벽 안쪽 면에 붙였다. kr-17 까지는 가운데 선(1040)을 지켜 벽에서 띄웠다 — 소파 옆으로
    //   가는 목표점(socialTargetsOf) 양옆이 남쪽 벽 경계 칸에 걸려 막히기 때문이었다. 벽에 붙여도 앞쪽 목표점 하나씩은 남고, 앉으러
    //   들어오는 칸(approachPoint)은 소파 앞이라 네 자리 모두 앉을 수 있다(loungeSeats.test.ts·idleRest.test.ts).
    { type: "couch", x: 444, y: SOUTH - OUTER_WALL_INSET - 28, w: 66, h: 28, fit: true }, // fit: 모델이 상자 밖(남쪽 벽 너머)에 그려지지 않게
    { type: "couch", x: 510, y: SOUTH - OUTER_WALL_INSET - 28, w: 66, h: 28, fit: true },
    // 탁자도 같은 배율 1.2(모델 0.841×0.447 → 56×30)다. 80×36 은 가로로 1.4배 늘어나 있었다.
    //   소파와 71 이상 떨어뜨린다: 탁자 통행 여유(15)가 소파 앞 칸에 걸리면 붙인 소파의 안쪽 자리로 들어올 칸이 없다(loungeSeats.test.ts).
    //   kr-18: 소파를 벽에 붙이며 탁자(928 → 946)·양탄자(가운데 962 → 980)도 18 내렸다(소파와 72.6)
    { type: "table_rect", x: 482, y: 946, w: 56, h: 30, fit: true },
    // 전등과 옷걸이는 소파 양옆에 둔다. 빈백(하늘색 소파)은 뺐다(kr-7)
    { type: "lamp", x: 414, y: 1046 },
    { type: "coat_rack", x: 576, y: 1056 },
    { type: "plant", x: 702, y: 1048 },
  );

  // ── 입구(남쪽 가운데). 문은 그리기만 하고 길은 경계로 막는다.
  //    안내 데스크(ㄴ자 탁자)와 의자 3개는 kr-4 에서 뺐다
  s.push(
    { type: "door", x: 860, y: 1072, w: DOOR, h: T },
  );

  // ── 사물함·문서함·복합기: 남쪽 벽에 탕비실 서쪽 벽(PANTRY_X)부터 서쪽으로 빈틈 없이 붙인다(kr-9). 앞면 북쪽.
  //    kr-19: 탕비실 서쪽 벽이 1460 → 1520 으로 옮겨 줄도 같이 60 옮겼다
  {
    let right = PANTRY_X;
    const row: [string, number, number][] = [["locker", 44, 20], ["locker", 44, 20], ["locker", 44, 20], ["file_cabinet", 58, 20], ["file_cabinet", 58, 20], ["printer", 44, 34]];
    for (const [type, w, h] of row) {
      s.push(placed(type, right - w / 2, SOUTH - h / 2, w, h, 180));
      right -= w;
    }
  }
  // 게시판(실패한 크론·막힌 카드)은 휴게 공간 소파와 입구 사이 남쪽 벽에 건다(kr-9)
  s.push(placed("notice_board", 770, SOUTH - 3, 60, 6, 180));


  // ── 남동쪽 탕비실(1520~1800 × 720~1080). 탁자·의자를 뺀 집기는 남쪽 벽에 싱크대부터 일렬로 붙인다(kr-7):
  //    상판(커피 머신·전자레인지) · 싱크대 · 정수기 · 냉장고 · 자판기. 앞면은 모두 북쪽(facing 180).
  //    kr-19: 서쪽 벽을 TFT 회의실 서쪽 벽 줄(1520)에 맞추고, TFT 회의실 3 과의 빈 곳(720~870)을 없애
  //    북쪽 벽은 TFT 회의실 3 의 남쪽 벽(720~728)을 함께 쓴다. 문은 TFT 회의실처럼 서쪽 벽의 유리문. kr-18 까지는 1460~1800 × 870~1080,
  //    문은 북쪽 벽이었다. 서쪽 벽은 TFT 회의실 3 의 서쪽 유리벽이 끝나는 720 에서 시작해 모서리(1520~1528 × 720~728)를 채운다
  //    — TFT 회의실 3 의 남쪽 벽은 1528 에서 시작하므로 겹치지 않는다(kr-16, z-fighting)
  //    kr-20: 서쪽 벽을 TFT 회의실 서쪽 벽처럼 유리벽으로 바꿨다. 북쪽 벽은 TFT 회의실 3 과 함께 쓰는 칸막이라
  //    TFT 회의실 사이 벽과 같이 막힌 벽으로 둔다
  s.push(...vWallWithDoor(PANTRY_X, PANTRY_TOP, SOUTH, glassDoorGap(800), "glass_wall", GLASS_DOOR));
  s.push(
    placed("cabinet", PANTRY_X + T + 72, SOUTH - 20, 140, 40, 180), // 상판 1530~1670(서쪽 벽 안쪽 면 1528 에서 2 띄움)
    placed("coffee_machine", PANTRY_X + T + 22, SOUTH - 17, 28, 28, 180, { elevation: COUNTER_TOP }), // 상판 위, 벽 쪽 턱(깊이 약 3) 앞
    placed("microwave", PANTRY_X + T + 107, SOUTH - 10, 30, 20, 180, { elevation: COUNTER_TOP - 0.42 }), // 상판 위 남쪽 벽에 붙인다(kr-9). 도형이 이미 0.42 위에 그린다
    placed("sink", PANTRY_X + T + 162, SOUTH - 20, 40, 40, 180), // 개수대: 상판에 이어 붙이고 높이를 상판(0.54)에 맞춘다(kr-8)
    // 냉장고는 동쪽 벽 모서리에 붙이고, 같은 모델의 작은 냉장고(정수기 자리)를 바로 옆에 높이를 맞춰 둔다(kr-8).
    // 자판기(까만 상자)는 뺐다(kr-8)
    placed("water_cooler", 1744, SOUTH - 11, 24, 22, 180),
    placed("fridge", 1778, SOUTH - 20, 44, 40, 180),
    // kr-18: 탁자를 35×35 에서 84×44 로 키우고 의자를 동·서 2개에서 북·남 2개씩 4개로 늘렸다.
    //   84×44 는 휴게 공간 탁자(56×30)를 1.5 배 한 크기에 가깝다. 의자는 회의실과 같은 간격(50)·거리(26)다.
    //   kr-19: 방이 넓어져 가운데(1662.5, 887.5)로 옮겼다. 탁자 위아래 가장자리는 격자(25) 선과 kr-18 과 같은 자리(가운데 y 가 3칸 위)라
    //   의자 칸 바깥에 빈 줄이 남는다(idleRest.test.ts). 🔴 깊이 45 면 탁자 통행 여유(15)가 격자 선에 닿아 남쪽 의자 칸을 막는다
    ...meetingTable(1662.5, 887.5, 84, 44, 2, false),
  );

  // ── 화분: 섬 사이 통로 끝(문 앞을 막지 않게). kr-4 에서 벽을 따라 더 놓았다 —
  //    북쪽 방 유리벽 사이(문을 피해 방 경계 앞), 서쪽 벽, TFT 회의실 서쪽 벽의 문 사이, 입구 옆
  const plants: [number, number][] = [
    // kr-21: 북쪽 방이 셋(경계 440·880·1320)·깊이 240 이 되어 유리벽(248) 바로 아래로 옮겼다
    [428, 254], [868, 254], [1300, 254],
    [12, 254], [12, 520], [12, 720],
    [1488, 205], [1488, 445], [1488, 685],
    [1005, 1050],
    // kr-8: 사무실 공간에 화분을 더 둔다 — 책상 섬 열 사이 가운데, 동쪽 통로, 남서쪽 벽
    // kr-12: 동쪽 통로 한가운데에서 탕비실 서쪽 벽으로 옮겼다. kr-19: 벽이 1520 으로 옮겨 TFT 회의실 서쪽 벽 화분(1488)과 같은 줄,
    //   탕비실 문(780~845) 남쪽에 둔다
    [1488, 905], [1488, 955], [1488, 1005],
    [228, 1048],
  ];
  for (const [x, y] of plants) s.push({ type: "plant", x, y });

  // kr-12: 책상 섬 열(1열 x 230·2열 x 700·3열 x 1170) 사이 두 통로마다 같은 화분 4개를 한 줄로 놓는다.
  //   통로 가운데 x: 1열~2열 465, 2열~3열 935(섬 바깥 가장자리 281·649·751·1119 의 가운데). 같은 x 에 양쪽 섬 묶음(y 405~615, 765~975 — kr-18 에서 아래 묶음을 50,
  //   kr-21 에서 두 묶음을 25 내림) 옆으로 2개씩, 묶음 가운데(508·868)에서 위아래로 50 씩 떨어뜨려 간격(100)을 맞춘다. 위·아래 묶음 사이 가로 통로(y 625~765)는 비운다.
  for (const x of [453, 923]) for (const y of [446, 546, 806, 906]) s.push({ type: "plant", x, y });

  // kr-11: 모양이 다른 화분. kr-12: 섬 열 사이 두 통로(x 465·935)에는 같은 화분 4개씩을 한 줄로 두고 나머지 화분은 모두 벽에 붙였다 — 선인장은 팀장석 뒤에서, 야자수·나무와 기존 동쪽 통로 화분도 벽으로. 기존 화분은 모두 같은 모양이었다. Kenney Nature Kit 모델을 자리 상자에 맞춰(fit) 가운데 (cx, cy) 에 놓는다.
  //   빈자리는 점유 지도(30px 격자)로 골랐다: 북쪽 방 앞 통로(문 앞 열은 피함), 서쪽·동쪽 벽 옆 빈 곳, 가운데 가로 통로, 남쪽 빈 바닥.
  //   상자 크기는 geometry.ts 의 ITEM_FOOTPRINT 와 같다(편집 패널로 만든 것과 같은 크기). 높이 배율은 objects/furniture.tsx 의 FURNITURE_SCALE.
  const plantAt = (type: string, [w, h]: [number, number], spots: [number, number][]) =>
    spots.forEach(([cx, cy]) => s.push(placed(type, cx, cy, w, h, 0)));
  // 서쪽 벽(x 3~47)에는 칸반 보드(y 815~945)·전화 부스(y 1005~)가 걸려 있어 그 구간을 비웠다. 배회 지점 (90,620)·청소부 출입구 (80,360)도 피했다.
  // kr-21: 북쪽 방이 240 으로 깊어져 벽 화분(12, 254)과 겹치지 않게 (25, 277) → (25, 310)
  plantAt("plant_palm", [44, 44], [[25, 454], [25, 310]]);
  // 선인장은 팀장석 뒤(북쪽)를 비우려고 벽에 붙였다. 팀장석은 북쪽을 보고 앉아 뒤가 통로다.
  //   북쪽: 방 앞 유리벽 바로 아래, 문과 기존 벽 화분 사이. 남쪽: 입구(840~960) 양옆의 남쪽 벽.
  //   동쪽 통로(1470~1520)는 TFT 회의실 길이라 막혀서 쓰지 않았다.
  //   kr-21: 북쪽 방이 셋이 되어 문(180~245·630~695·1080~1145)이 옮겨, 문 동쪽과 다음 방 경계 화분 사이로 옮겼다. 유리벽이 248 까지 내려와 y 도 40 내렸다
  plantAt("plant_cactus", [22, 20], [[330, 262], [770, 262], [1210, 262]]);
  plantAt("plant_cactus_short", [24, 20], [[790, 1062], [1090, 1062]]);
  plantAt("plant_tree", [20, 24], [[13, 602], [13, 782], [13, 967]]); // kr-12: 통로 한가운데에 있던 것을 벽으로

  // ── 바닥 밖 막기: 바닥(1080) 남쪽은 장면 격자에서 빈 칸이라 에이전트가 걸어 나간다(O8)
  s.push(wall(0, 1076, 1800, 724, "boundary"));

  return s.map((item, i) => ({ ...item, _uid: `kr_${i}` }));
}
