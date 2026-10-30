/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";

import { doorTouched } from "./doorTouch";
import type { FurnitureItem } from "./types";

// 회의실 북쪽 유리문(가로, 너비 65, 두께 8). 가운데는 (x 532.5, y 104)
const hDoor: FurnitureItem = { _uid: "d1", type: "door", x: 500, y: 100, w: 65, h: 8, glass: true };
// 세로벽 유리문(facing 90). 가운데는 (x 1524, y 362.5)
const vDoor: FurnitureItem = { _uid: "d2", type: "door", x: 1491.5, y: 358.5, w: 65, h: 8, facing: 90, glass: true };

describe("doorTouched", () => {
  it("문 앞에 선 사람이 있으면 연다", () => {
    expect(doorTouched(hDoor, [{ x: 532, y: 95 }])).toBe(true);
    expect(doorTouched(vDoor, [{ x: 1515, y: 362 }])).toBe(true);
  });

  it("멀리 있으면 열지 않는다", () => {
    expect(doorTouched(hDoor, [{ x: 532, y: 160 }])).toBe(false);
    expect(doorTouched(vDoor, [{ x: 1524, y: 460 }])).toBe(false); // 세로문은 문 길이가 y 방향이다
  });

  it("에이전트 목록이 비어 있어도 사람 아바타 목록에 문 앞 사람이 있으면 연다", () => {
    // 바닥 두 번 누르기로 걷는 내 아바타는 Claw3D 에이전트와 다른 목록에 있다(2026-10-20 문이 안 열리던 원인)
    expect(doorTouched(hDoor, [], [{ x: 532, y: 108 }])).toBe(true);
  });

  it("목록이 없으면 닫는다", () => {
    expect(doorTouched(hDoor)).toBe(false);
    expect(doorTouched(hDoor, [], [])).toBe(false);
  });
});
