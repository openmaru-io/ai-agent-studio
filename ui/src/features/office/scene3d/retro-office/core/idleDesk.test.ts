/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";

import { IDLE_DESK_CHANCE, IDLE_REST_CHANCE, IDLE_SEAT_MS, idleAtDesk, idleNextTrip, idleSeatDeadline, idleSpawnDeadline } from "./idleDesk";
import { deskSeatFacing, deskSeatOf } from "./navigation";
import { SEAT_REACH } from "./seatArrival";
import type { FurnitureItem } from "./types";

// 2026-10-21-023: 대기 상태의 에이전트가 책상에 가지 않고 평균 3초마다 다른 곳으로 걸어, 대기가 많으면 자리에 앉은 사람이 없었다
const desk = { x: 100, y: 200 };

describe("idleAtDesk", () => {
  it("책상에 막 닿았으면 앉고 머물 시각을 정한다", () => {
    const step = idleAtDesk({ x: 100, y: 200, state: "walking" }, desk, 1_000, 0);
    expect(step).toEqual({ kind: "sit", until: 1_000 + IDLE_SEAT_MS.min });
  });

  it("머물 시각 전에는 앉아 있고, 지나면 일어난다", () => {
    const sitting = { x: 100, y: 200, state: "sitting" as const, idleSeatUntil: 5_000 };
    expect(idleAtDesk(sitting, desk, 4_999, 0.5)).toEqual({ kind: "stay" });
    expect(idleAtDesk(sitting, desk, 5_000, 0.5)).toEqual({ kind: "leave" });
  });

  it("일어나 서 있는 동안은 다시 앉지 않는다 — 다음 걸음은 idleNextTrip 이 정한다", () => {
    expect(idleAtDesk({ x: 100, y: 200, state: "standing", idleStoodUp: true }, desk, 0, 0)).toEqual({ kind: "none" });
  });

  it("책상에서 떨어진 곳에서는 앉지 않는다(시작 지점·복도)", () => {
    expect(idleAtDesk({ x: 100 + SEAT_REACH, y: 200, state: "standing" }, desk, 0, 0)).toEqual({ kind: "none" });
  });

  it("책상이 없으면 앉지 않는다", () => {
    expect(idleAtDesk({ x: 100, y: 200, state: "standing" }, null, 0, 0)).toEqual({ kind: "none" });
  });
});

describe("idleSeatDeadline", () => {
  it("앉아 있는 시간은 최소~최대 사이다", () => {
    expect(idleSeatDeadline(0, 0)).toBe(IDLE_SEAT_MS.min);
    expect(idleSeatDeadline(0, 0.999_999)).toBeLessThan(IDLE_SEAT_MS.max);
    expect(idleSeatDeadline(0, 0.999_999)).toBeGreaterThan(IDLE_SEAT_MS.max - 1);
  });

  it("처음 앉힐 때는 0~최대 사이로 흩어 한꺼번에 일어나지 않게 한다", () => {
    expect(idleSpawnDeadline(1_000, 0)).toBe(1_000);
    expect(idleSpawnDeadline(1_000, 0.5)).toBe(1_000 + IDLE_SEAT_MS.max / 2);
  });
});

describe("idleNextTrip", () => {
  it("책상이 있으면 대부분 책상으로 간다", () => {
    expect(idleNextTrip(true, 0)).toBe("desk");
    expect(idleNextTrip(true, IDLE_DESK_CHANCE - 0.001)).toBe("desk");
    expect(idleNextTrip(true, IDLE_DESK_CHANCE)).toBe("rest");
    expect(idleNextTrip(true, IDLE_DESK_CHANCE + IDLE_REST_CHANCE - 0.001)).toBe("rest");
    expect(idleNextTrip(true, IDLE_DESK_CHANCE + IDLE_REST_CHANCE)).toBe("roam");
  });

  it("책상이 없으면 책상 몫은 돌아다니고, 쉬는 자리 몫은 같다(2026-10-26-004)", () => {
    expect(idleNextTrip(false, 0)).toBe("roam");
    expect(idleNextTrip(false, IDLE_DESK_CHANCE)).toBe("rest");
  });
});

describe("deskSeatFacing", () => {
  // 처음부터 책상에 앉힐 때 책상 쪽을 보게 한다. 방향 값은 이동 틱과 같이 atan2(dx, dy)
  const towardCenter = (item: FurnitureItem) => {
    const seat = deskSeatOf(item);
    const cx = item.x + (item.w ?? 100) / 2;
    const cy = item.y + (item.h ?? 55) / 2;
    return { dx: cx - seat.x, dy: cy - seat.y };
  };

  it.each([0, 90, 180, 270])("fit 책상(방향 %i°)에서는 책상 가운데를 본다", (facing) => {
    const item: FurnitureItem = { _uid: "d", type: "desk_cubicle", x: 300, y: 300, w: 80, h: 50, fit: true, facing };
    const f = deskSeatFacing(item);
    const { dx, dy } = towardCenter(item);
    expect(Math.sin(f)).toBeCloseTo(dx / Math.hypot(dx, dy), 5);
    expect(Math.cos(f)).toBeCloseTo(dy / Math.hypot(dx, dy), 5);
  });

  it("원본 책상은 의자에서 책상 쪽(앞뒤 축)을 본다", () => {
    const item: FurnitureItem = { _uid: "d", type: "desk_cubicle", x: 300, y: 300, facing: 0 };
    expect(Math.cos(deskSeatFacing(item))).toBeCloseTo(1, 5); // 의자가 책상 위쪽(−y)에 있어 +y 를 본다
  });
});
