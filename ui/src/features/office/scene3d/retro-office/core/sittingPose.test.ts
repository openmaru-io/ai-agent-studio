/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";

import { AGENT_SCALE } from "./constants";
import { LEG, SEAT_TOP, sittingPose, TORSO_BOTTOM } from "./sittingPose";

// 2026-10-20: 앉은 상태에도 다리를 편 채 몸만 뒤로 기울여, 의자·소파 자리에 선 채 의자를 뚫고 서 있었다
describe("sittingPose", () => {
  const pose = sittingPose(AGENT_SCALE);

  it("허벅지 아랫면이 좌석 윗면(의자 0.297·소파 0.28 을 잰 값 0.29)에 닿는다", () => {
    const thighBottom = pose.lift + (pose.legY - LEG.depth / 2) * AGENT_SCALE;
    expect(thighBottom).toBeCloseTo(SEAT_TOP, 9);
  });

  it("다리가 앞으로 누워(발이 앞) 허벅지 윗면이 몸통 아래에 붙는다", () => {
    expect(pose.legRotX).toBeCloseTo(-Math.PI / 2, 9);
    expect(pose.legY + LEG.depth / 2).toBeCloseTo(TORSO_BOTTOM, 9);
    expect(pose.legZ).toBeGreaterThan(0);
  });

  it("몸을 들어 올리고, 몸통은 세우고, 팔은 책상 쪽(앞)으로 든다", () => {
    expect(pose.lift).toBeGreaterThan(0);
    expect(pose.torsoRotX).toBe(0);
    expect(pose.armRotX).toBeLessThan(0);
  });
});
