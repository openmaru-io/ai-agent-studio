/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 사용자 보고 2026-10-21: 회의실 가운데 의자에는 사람이 앉을 수 없다. 사람은 의자 뒤쪽 빈 칸(approachPoint)까지 걸어 와서
// 앉는데, 가운데 의자는 뒤가 벽이고 양옆이 이웃 의자 칸이라 들어올 칸이 없었다. 기본 배치의 모든 회의실 의자에 들어올 칸이 있고 그 칸까지 길이 있어야 한다.

import { describe, expect, it } from "vitest";

import { buildAasKoreanOffice } from "./aasKoreanOffice";
import { getItemBounds } from "./geometry";
import { astar, buildNavGrid, ROAM_POINTS } from "./navigation";
import { approachPoint, seatFurniture } from "./personPath";

const CELL = 25;
const COLS = Math.ceil(1800 / CELL);
const freeIn = (grid: Uint8Array) => (x: number, y: number) => {
  const c = Math.floor(x / CELL);
  const r = Math.floor(y / CELL);
  return c >= 0 && r >= 0 && c < COLS && r * COLS + c < grid.length && !grid[r * COLS + c];
};

const items = buildAasKoreanOffice();
const grid = buildNavGrid(items);
const center = (b: { x: number; y: number; w: number; h: number }) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const rooms = items.filter((i) => i.type === "room");

describe("회의실 의자에 모두 앉을 수 있다", () => {
  for (const room of rooms) {
    const rb = getItemBounds(room);
    const inRoom = (i: (typeof items)[number]) => {
      const c = center(getItemBounds(i));
      return c.x > rb.x && c.x < rb.x + rb.w && c.y > rb.y && c.y < rb.y + rb.h;
    };
    const table = items.find((i) => i.type === "table_rect" && inRoom(i));
    if (!table) continue;
    const tc = center(getItemBounds(table));
    const chairs = items.filter((i) => i.type === "chair" && inRoom(i));
    it(`${room.label}: 의자 ${chairs.length}개 모두 들어올 칸이 있고 업무 구역에서 그 칸까지 걸어갈 수 있다`, () => {
      const stuck: string[] = [];
      for (const ch of chairs) {
        const c = center(getItemBounds(ch));
        const f = Math.atan2(tc.x - c.x, tc.y - c.y);
        const skip = seatFurniture(items, ch._uid, getItemBounds);
        const without = buildNavGrid(items.filter((i) => !skip.has(i._uid)));
        const p = approachPoint({ ...c, out: { x: -Math.sin(f), y: -Math.cos(f) } }, freeIn(grid), freeIn(without));
        const from = ROAM_POINTS[0];
        if (!p || !astar(from.x, from.y, p.x, p.y, grid).length) stuck.push(`(${Math.round(c.x)},${Math.round(c.y)})`);
      }
      expect(stuck).toEqual([]);
    });
  }
});
