/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";

import { buildAasKoreanOffice } from "./aasKoreanOffice";
import { getItemBounds } from "./geometry";
import { occupiedPoint, pickRestSeat, REST_SEAT_NEAR, restSeatsOf } from "./idleRest";
import { astar, buildNavGrid } from "./navigation";
import { planRoute } from "./personPath";

const items = buildAasKoreanOffice();
const grid = buildNavGrid(items);
const COLS = Math.ceil(1800 / 25);
const free = (x: number, y: number) => !grid[Math.floor(y / 25) * COLS + Math.floor(x / 25)];
const ENTRANCE = { x: 910, y: 1000 }; // 입구 안쪽(aasKoreanOffice.test.ts 와 같다)
const inPantry = (p: { x: number; y: number }) => p.x > 1520 && p.y > 728 && p.y < 1080; // kr-19 탕비실(1520~1800 × 720~1080)

// 2026-10-26: 탕비실 탁자를 키워 의자 4개를 놓고, 에이전트가 쉴 때 소파와 탕비실도 쓴다
describe("탕비실 탁자와 의자(kr-18)", () => {
  const pantry = items.filter((i) => inPantry({ x: i.x, y: i.y }));
  const table = pantry.find((i) => i.type === "table_rect")!;
  const chairs = pantry.filter((i) => i.type === "chair");

  it("탁자 하나에 의자 4개: 북쪽 2개는 남쪽을, 남쪽 2개는 북쪽을 본다", () => {
    expect(pantry.filter((i) => i.type === "table_rect")).toHaveLength(1);
    expect(chairs).toHaveLength(4);
    const t = getItemBounds(table);
    expect(t.w).toBeGreaterThan(35);
    const north = chairs.filter((c) => getItemBounds(c).y + 24 <= t.y);
    const south = chairs.filter((c) => getItemBounds(c).y >= t.y + t.h);
    expect([north.length, south.length]).toEqual([2, 2]);
    expect(north.every((c) => c.facing === 0) && south.every((c) => c.facing === 180)).toBe(true);
    for (const c of chairs) {
      const cx = getItemBounds(c).x + 12;
      expect(cx > t.x && cx < t.x + t.w, c._uid).toBe(true); // 의자가 탁자 긴 쪽 안에 있다
    }
  });
});

describe("쉬는 자리(restSeatsOf)", () => {
  const seats = restSeatsOf(items);

  it("소파 4자리와 탕비실 의자 4자리이고, 책상·회의실 의자는 들지 않는다", () => {
    const couches = new Set(items.filter((i) => i.type === "couch").map((i) => i._uid));
    expect(seats.filter((s) => couches.has(s.uid.split(":")[0]))).toHaveLength(4);
    expect(seats.filter((s) => inPantry(s))).toHaveLength(4);
    expect(seats).toHaveLength(8);
  });

  it("들어오는 칸은 빈 칸이고, 입구에서 그 칸을 거쳐 자리까지 가는 길이 있다", () => {
    for (const s of seats) {
      expect(free(s.approachX, s.approachY), s.uid).toBe(true);
      const path = planRoute(ENTRANCE, null, s, { x: s.approachX, y: s.approachY }, free, (fx, fy, tx, ty) => astar(fx, fy, tx, ty, grid));
      expect(path.length, s.uid).toBeGreaterThan(0);
      expect(path.at(-1), s.uid).toEqual({ x: s.x, y: s.y });
    }
  });

  it("소파 자리는 앞(북쪽, 휴게 공간 탁자 쪽)을, 탕비실 의자는 탁자를 본다", () => {
    const table = getItemBounds(items.find((i) => i.type === "table_rect" && inPantry(i))!);
    for (const s of seats) {
      const look = { x: Math.sin(s.facing), y: Math.cos(s.facing) };
      if (inPantry(s)) {
        const ty = table.y + table.h / 2;
        expect(Math.sign(look.y), s.uid).toBe(Math.sign(ty - s.y));
      } else {
        expect(look.y, s.uid).toBeLessThan(-0.9);
      }
    }
  });

  it("같은 배치는 한 번만 계산한다", () => {
    expect(restSeatsOf(items)).toBe(seats);
  });
});

describe("pickRestSeat·occupiedPoint", () => {
  const seats = restSeatsOf(items);

  it("다른 캐릭터가 앉았거나 가는 자리는 고르지 않는다", () => {
    const occupied = seats.slice(1).map((s) => ({ x: s.x + REST_SEAT_NEAR / 2, y: s.y }));
    for (const r of [0, 0.5, 0.99]) expect(pickRestSeat(seats, occupied, r)?.uid).toBe(seats[0].uid);
    expect(pickRestSeat(seats, seats, 0.5)).toBeNull();
  });

  it("앉아 있거나 자리 비움이면 지금 자리, 걷는 중이면 목적지, 서 있으면 없음", () => {
    const a = { x: 1, y: 2, targetX: 3, targetY: 4 };
    expect(occupiedPoint({ ...a, state: "sitting" })).toEqual({ x: 1, y: 2 });
    expect(occupiedPoint({ ...a, state: "away" })).toEqual({ x: 1, y: 2 });
    expect(occupiedPoint({ ...a, state: "walking" })).toEqual({ x: 3, y: 4 });
    expect(occupiedPoint({ ...a, state: "standing" })).toBeNull();
  });

  // 가짜 서버 화면(2026-10-26): 두 에이전트가 같은 소파 자리로 걸었다. 먼저 고른 에이전트가 걷다 부딪혀 잠깐 서 있는(standing) 사이에
  // 다른 에이전트가 그 자리를 빈자리로 봤다
  it("쉬는 자리를 맡은 캐릭터는 서 있어도 그 자리를 쓴다", () => {
    const seat = restSeatsOf(items)[0];
    const a = { x: 1, y: 2, targetX: seat.x, targetY: seat.y, state: "standing", restSeat: seat };
    expect(occupiedPoint(a)).toEqual({ x: seat.x, y: seat.y });
  });
});
