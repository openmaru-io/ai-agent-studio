/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";

import { walkSwing } from "./walkPose";

describe("walkSwing", () => {
  it("사람처럼 반대쪽 팔과 다리가 함께 앞으로 나간다(같은 쪽 팔·다리는 서로 반대로 흔든다)", () => {
    for (const phase of [-1, -0.5, 0.3, 1]) {
      const s = walkSwing(phase);
      expect(Math.sign(s.leftArm)).toBe(-Math.sign(s.leftLeg));
      expect(Math.sign(s.rightArm)).toBe(-Math.sign(s.rightLeg));
      expect(Math.sign(s.leftArm)).toBe(Math.sign(s.rightLeg));
      expect(Math.sign(s.leftArm)).toBe(-Math.sign(s.rightArm));
    }
  });

  it("서 있을 때(위상 0)는 팔·다리가 모두 곧다", () => {
    const s = walkSwing(0);
    expect([s.leftArm, s.rightArm, s.leftLeg, s.rightLeg].every((v) => Math.abs(v) < 1e-12)).toBe(true);
  });
});
