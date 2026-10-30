/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";

import { arrivedState, SEAT_REACH } from "./seatArrival";

// 2026-10-21: 일하는 중인 에이전트가 길이 끝나면(빈 길 포함) 의자가 없는 자리에서도 앉아 허공에 앉아 있었다
describe("arrivedState", () => {
  it("책상·회의 자리에 닿았으면 앉는다", () => {
    expect(arrivedState("desk", 100, 200, 100, 200)).toBe("sitting");
    expect(arrivedState("meeting_room", 100, 200, 100 + SEAT_REACH - 1, 200)).toBe("sitting");
  });

  it("책상이 없어 목표가 없으면(일하는 중, 자리 미배정) 서 있는다", () => {
    expect(arrivedState(undefined, 100, 200, 100, 200)).toBe("standing");
  });

  it("길을 찾지 못해 자리에 못 닿았으면 서 있는다", () => {
    expect(arrivedState("desk", 100, 200, 400, 200)).toBe("standing");
    expect(arrivedState("meeting_room", 100, 200, 100, 200 + SEAT_REACH)).toBe("standing");
  });
});
