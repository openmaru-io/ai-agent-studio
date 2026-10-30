/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";

import { freeSeats, type SeatGeometry } from "@/features/office/people";

import { buildAasKoreanOffice } from "./aasKoreanOffice";
import { CANVAS_W } from "./constants";
import { getItemBaseSize, getItemBounds, getItemRotationRadians } from "./geometry";
import { buildNavGrid } from "./navigation";
import { approachPoint, seatFurniture } from "./personPath";
import type { FurnitureItem } from "./types";

// 휴게 공간 소파는 fit 가구라 자리 상자가 모델 크기다 — 장면(aasPeople.tsx useSeatGeometry)과 같은 계산
const geometry: SeatGeometry = {
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

const GRID_CELL = 25; // navigation.ts 의 격자 한 칸
const cols = Math.ceil(CANVAS_W / GRID_CELL);
const freeIn = (grid: Uint8Array) => (x: number, y: number) => {
  const c = Math.floor(x / GRID_CELL);
  const r = Math.floor(y / GRID_CELL);
  return c >= 0 && r >= 0 && c < cols && !grid[r * cols + c];
};

// 붙여 놓은 두 소파의 안쪽 자리에 앉을 수 없었다(사용자 보고 2026-10-16). 옆 소파의 통행 여유가 안쪽 자리 앞 칸을 막고,
// 탁자의 통행 여유가 그 앞 칸을 막아 들어올 칸이 없었다(approachPoint 가 null → 앉지 않고 옆에 선다).
describe("휴게 공간 소파", () => {
  const items = buildAasKoreanOffice();
  const grid = buildNavGrid(items);
  const couches = items.filter((i) => i.type === "couch");
  const seats = freeSeats(items, {}, new Set(), geometry).filter((s) => couches.some((c) => c._uid === s.item));

  it("소파 자리마다 들어올 칸이 있다", () => {
    expect(seats.length).toBe(4);
    for (const s of seats) {
      const skip = seatFurniture(items, s.item, getItemBounds);
      const without = buildNavGrid(items.filter((f) => !skip.has(f._uid)));
      expect(approachPoint(s, freeIn(grid), freeIn(without)), s.uid).not.toBeNull();
    }
  });

  it("양탄자 위는 걸어다닐 수 있다(탁자 밖 칸)", () => {
    const rug = items.find((i) => i.type === "rug")!;
    const table = getItemBounds(items.find((i) => i.type === "table_rect" && i.y > 900)!);
    const b = getItemBounds(rug);
    let open = 0;
    for (let y = b.y + GRID_CELL / 2; y < b.y + b.h; y += GRID_CELL) {
      for (let x = b.x + GRID_CELL / 2; x < b.x + b.w; x += GRID_CELL) {
        const nearTable = x > table.x - GRID_CELL && x < table.x + table.w + GRID_CELL && y > table.y - GRID_CELL && y < table.y + table.h + GRID_CELL;
        if (!nearTable && freeIn(grid)(x, y)) open += 1;
      }
    }
    expect(open).toBeGreaterThan(0);
    // 양탄자 자체는 길을 막지 않는다(있든 없든 격자가 같다)
    expect(buildNavGrid(items.filter((i) => i !== rug)).join("")).toBe(grid.join(""));
  });
});
