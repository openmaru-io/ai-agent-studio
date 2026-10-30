/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";

import { AGENT_LABEL_SCALE, AGENT_SCALE } from "./constants";
import { HEAD_TOP, labelAnchor } from "./labelAnchor";

// 2026-10-20-007: 캐릭터를 1.75 → 1.5 로 줄이되 이름표·말풍선은 크기와 머리 위 간격을 그대로 둔다
describe("labelAnchor", () => {
  it("캐릭터가 바꾸기 전(1.75)보다 작다", () => {
    expect(AGENT_SCALE).toBeLessThan(AGENT_LABEL_SCALE);
  });

  it("이름표 묶음 배율을 곱하면 이름표 크기가 바꾸기 전과 같다", () => {
    const { scale } = labelAnchor(AGENT_SCALE);
    expect(AGENT_SCALE * scale).toBeCloseTo(AGENT_LABEL_SCALE, 9);
  });

  it("머리 꼭대기에서 이름표까지의 거리가 바꾸기 전과 같다", () => {
    const { scale, offsetY } = labelAnchor(AGENT_SCALE);
    for (const y of [1.05, 1.3, 1.6]) {
      const world = AGENT_SCALE * (offsetY + scale * y);
      const head = AGENT_SCALE * HEAD_TOP;
      expect(world - head).toBeCloseTo(AGENT_LABEL_SCALE * (y - HEAD_TOP), 9);
    }
  });
});
