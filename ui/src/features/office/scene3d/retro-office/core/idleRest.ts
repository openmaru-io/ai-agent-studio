/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// AAS(2026-10-26-004): 대기 에이전트가 쉴 때 휴게 공간 소파와 탕비실 의자에도 앉는다. 원본(2026-10-21-023 까지)은 책상이
// 아니면 사무실 곳곳·휴게 가구 옆에 서기만 했고, 소파에는 30분 넘게 대기한 「자리 비움」만 갔다.
// 자리는 사람 아바타와 같은 계산(people.ts freeSeats, personPath.ts approachPoint)으로 정한다.
import { freeSeats, type SeatGeometry } from "@/features/office/people";
import { CANVAS_W } from "@/features/office/scene3d/retro-office/core/constants";
import { getItemBaseSize, getItemBounds, getItemRotationRadians } from "@/features/office/scene3d/retro-office/core/geometry";
import { buildNavGrid, type NavGrid } from "@/features/office/scene3d/retro-office/core/navigation";
import { approachPoint, seatFurniture } from "@/features/office/scene3d/retro-office/core/personPath";
import type { FurnitureItem } from "@/features/office/scene3d/retro-office/core/types";

/** 쉬는 자리 하나. (x, y) 는 앉는 점, (approachX, approachY) 는 들어오고 나가는 빈 칸, facing 은 앉아서 볼 방향(atan2(dx, dy)) */
export type RestSeat = { uid: string; x: number; y: number; facing: number; approachX: number; approachY: number };

/** 다른 캐릭터가 이만큼(장면 픽셀) 안에 앉아 있거나 그곳으로 걸어가면 그 자리를 쓰는 것으로 본다. 소파 한 자리 폭(33)보다 좁다 */
export const REST_SEAT_NEAR = 20;

/** 쉬는 자리로 치는 의자: 방(회의실) 밖에서 가장 가까운 탁자가 이 종류인 의자. 책상 의자는 가장 가까운 것이 책상이라 빠진다 */
const REST_TABLES = new Set(["table_rect", "round_table"]);
const TABLES = new Set(["table_rect", "round_table", "desk_cubicle", "executive_desk"]);
const GRID_CELL = 25; // navigation.ts 의 격자 한 칸
const GRID_COLS = Math.ceil(CANVAS_W / GRID_CELL);

/** 배치 상자로 자리 모양을 만든다(fit 가구는 모델이 상자를 채운다). 장면의 useSeatGeometry 는 모델을 재지만 이동 틱에는 모델이 없다 */
export const layoutSeatGeometry: SeatGeometry = {
  box: (it) => {
    const { width, height } = getItemBaseSize(it as FurnitureItem);
    return { minX: 0, maxX: width, minZ: 0, maxZ: height };
  },
  rotation: (it) => getItemRotationRadians(it as FurnitureItem),
  place: (it, lx, lz) => {
    const { width, height } = getItemBaseSize(it as FurnitureItem);
    const r = getItemRotationRadians(it as FurnitureItem);
    const dx = lx - width / 2;
    const dz = lz - height / 2;
    return { x: it.x + width / 2 + Math.cos(r) * dx + Math.sin(r) * dz, y: it.y + height / 2 - Math.sin(r) * dx + Math.cos(r) * dz };
  },
};

const freeIn = (grid: NavGrid) => (x: number, y: number) => {
  const c = Math.floor(x / GRID_CELL);
  const r = Math.floor(y / GRID_CELL);
  return c >= 0 && r >= 0 && c < GRID_COLS && r * GRID_COLS + c < grid.length && !grid[r * GRID_COLS + c];
};

const cache = new WeakMap<FurnitureItem[], RestSeat[]>();

/** 배치의 쉬는 자리: 소파·빈백 자리와 회의실 밖 탁자(탕비실 등)의 의자. 들어올 칸이 없는 자리는 뺀다. 배치(배열)마다 한 번 계산한다 */
export function restSeatsOf(items: FurnitureItem[]): RestSeat[] {
  const hit = cache.get(items);
  if (hit) return hit;
  const grid = buildNavGrid(items);
  const rooms = items.filter((it) => it.type === "room").map(getItemBounds);
  const inRoom = (x: number, y: number) => rooms.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
  const tables = items.filter((it) => TABLES.has(it.type)).map((it) => {
    const b = getItemBounds(it);
    return { type: it.type, x: b.x + b.w / 2, y: b.y + b.h / 2 };
  });
  const byUid = new Map(items.map((it) => [it._uid, it]));
  const out: RestSeat[] = [];
  for (const s of freeSeats(items, {}, new Set(), layoutSeatGeometry)) {
    const it = byUid.get(s.item);
    if (!it) continue;
    if (it.type === "chair") {
      if (inRoom(s.x, s.y)) continue;
      let near: (typeof tables)[number] | null = null;
      let nd = 140; // freeSeats 가 의자 방향을 정할 때 보는 거리와 같다
      for (const t of tables) {
        const d = Math.hypot(t.x - s.x, t.y - s.y);
        if (d < nd) {
          near = t;
          nd = d;
        }
      }
      if (!near || !REST_TABLES.has(near.type)) continue;
    }
    const skip = seatFurniture(items, s.item, getItemBounds);
    const without = buildNavGrid(items.filter((f) => !skip.has(f._uid)));
    const a = approachPoint(s, freeIn(grid), freeIn(without));
    if (!a) continue;
    // 소파는 앉는 쪽(모델 앞)을 본다. 사람 아바타와 같이 들어온 칸 쪽으로 돌린다(aasPeople.tsx 의 faceOut)
    const facing = s.faceOut ? Math.atan2(a.x - s.x, a.y - s.y) : s.f;
    out.push({ uid: s.uid, x: s.x, y: s.y, facing, approachX: a.x, approachY: a.y });
  }
  cache.set(items, out);
  return out;
}

/** 쉴 자리 하나를 고른다. occupied 는 다른 캐릭터가 앉아 있거나 가는 점이다. 빈 자리가 없으면 null. rand 는 [0, 1) */
export function pickRestSeat(seats: RestSeat[], occupied: { x: number; y: number }[], rand: number): RestSeat | null {
  const free = seats.filter((s) => occupied.every((o) => Math.hypot(o.x - s.x, o.y - s.y) > REST_SEAT_NEAR));
  return free[Math.floor(rand * free.length)] ?? null;
}

/** 캐릭터가 쓰는 자리 점: 쉬는 자리를 맡았으면 그 자리, 앉아 있거나 자리 비움이면 지금 자리, 걷는 중이면 목적지. 서 있으면 쓰지 않는다.
 *  쉬는 자리는 상태와 관계없이 본다 — 걷다 부딪힌 에이전트는 잠깐 서 있어(standing) 그 사이 다른 에이전트가 같은 자리를 골랐다 */
export function occupiedPoint(a: { x: number; y: number; targetX: number; targetY: number; state: string; restSeat?: RestSeat }): { x: number; y: number } | null {
  if (a.restSeat) return { x: a.restSeat.x, y: a.restSeat.y };
  if (a.state === "sitting" || a.state === "away") return { x: a.x, y: a.y };
  if (a.state === "walking") return { x: a.targetX, y: a.targetY };
  return null;
}
