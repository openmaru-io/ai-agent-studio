/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";

import { AAS_OUTER_WALL_THICKNESS, SCALE, WALL_THICKNESS } from "./constants";
import { BASEBOARD, baseboardOffset, wallBaseboardDepth } from "./baseboard";

// 2026-10-20: 걸레받이 앞면이 벽 안쪽 면과 같은 평면이라 카메라를 움직일 때 깜빡였다(z-fighting)
describe("걸레받이 자리", () => {
  const half = AAS_OUTER_WALL_THICKNESS / 2;

  it("바깥벽: 앞면이 벽 안쪽 면보다 앞에 있다(같은 평면이 아니다)", () => {
    const front = baseboardOffset(AAS_OUTER_WALL_THICKNESS) + BASEBOARD.depth / 2;
    expect(front - half).toBeGreaterThanOrEqual(0.01);
  });

  it("바깥벽: 뒷면은 벽 안에 묻혀 벽과 걸레받이 사이에 틈이 없다", () => {
    const back = baseboardOffset(AAS_OUTER_WALL_THICKNESS) - BASEBOARD.depth / 2;
    expect(half - back).toBeGreaterThanOrEqual(0.01);
  });

  it("실내 벽: 걸레받이가 벽보다 양쪽으로 두꺼워 앞뒤 면이 벽 면과 겹치지 않는다", () => {
    const wall = WALL_THICKNESS * SCALE;
    expect((wallBaseboardDepth(wall) - wall) / 2).toBeGreaterThanOrEqual(0.01);
  });
});
