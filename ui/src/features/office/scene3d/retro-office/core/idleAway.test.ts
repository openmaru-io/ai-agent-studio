/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 사용자 보고(2026-10-26, OKE 저녁 화면): 모든 에이전트가 소파 근처에만 있다. 30분 넘게 일이 없는 자리 비움 에이전트를 원본처럼 소파
// 가운데로 보냈다. 결정: 자리 비움은 자기 책상에 앉아 있는다
import { describe, expect, it } from "vitest";

import { awayStep } from "./idleAway";

const seat = { uid: "s", x: 500, y: 1060, facing: Math.PI, approachX: 500, approachY: 1010 };
const at = (x: number, y: number, extra: Partial<{ targetX: number; targetY: number; restSeat: typeof seat }> = {}) => ({ x, y, targetX: x, targetY: y, ...extra });

describe("awayStep (스펙 2026-10-26-012)", () => {
  const desk = { x: 200, y: 300, facing: 0.5 };

  it("책상이 있으면 책상으로 가고, 닿으면 책상 방향으로 앉는다", () => {
    expect(awayStep(at(800, 600), desk, () => seat)).toEqual({ kind: "go", x: 200, y: 300 });
    expect(awayStep(at(205, 302), desk, () => seat)).toEqual({ kind: "sit", facing: 0.5 });
  });

  it("책상으로 가 봤는데 닿지 못했으면 다시 길을 내지 않고 선다", () => {
    expect(awayStep(at(260, 300, { targetX: 200, targetY: 300 }), desk, () => seat)).toEqual({ kind: "stand" });
  });

  it("책상이 없으면 빈 쉬는 자리 하나를 맡아 간다. 닿으면 그 자리 방향으로 앉는다", () => {
    expect(awayStep(at(800, 600), null, () => seat)).toEqual({ kind: "go", x: 500, y: 1060, rest: seat });
    expect(awayStep(at(500, 1060, { restSeat: seat }), null, () => null)).toEqual({ kind: "sit", facing: Math.PI });
  });

  it("맡은 쉬는 자리에 닿지 못했거나 빈 쉬는 자리가 없으면 그 자리에 선다", () => {
    expect(awayStep(at(500, 900, { targetX: 500, targetY: 1060, restSeat: seat }), null, () => null)).toEqual({ kind: "stand" });
    expect(awayStep(at(800, 600), null, () => null)).toEqual({ kind: "stand" });
  });

  it("소파 가운데로 모두 몰리지 않는다: 책상이 있는 에이전트는 쉬는 자리를 고르지 않는다", () => {
    let picked = 0;
    awayStep(at(800, 600), desk, () => {
      picked += 1;
      return seat;
    });
    expect(picked).toBe(0);
  });
});
