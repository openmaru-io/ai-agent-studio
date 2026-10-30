/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";

import { FURNITURE_SCALE } from "../objects/furniture";
import { PHONE_BOOTH_HEIGHT_SCALE, PHONE_BOOTH_MODEL_TOP } from "../objects/machines";
import { buildAasKoreanOffice } from "./aasKoreanOffice";
import { AAS_OUTER_WALL_THICKNESS, AAS_WALL_HEIGHT, SCALE } from "./constants";
import { getItemBounds } from "./geometry";

// 사물함 모델(bookcaseClosedDoors.glb)의 원래 높이. 파일의 최고점이다.
const LOCKER_MODEL_HEIGHT = 0.85;

describe("벽과 맞춘 가구", () => {
  it("사물함 윗면이 벽 높이와 같다(전에는 1.105 로 벽보다 높았다)", () => {
    expect(FURNITURE_SCALE.locker[1] * LOCKER_MODEL_HEIGHT).toBeCloseTo(AAS_WALL_HEIGHT, 3);
  });

  it("전화 부스 지붕 윗면이 벽 높이와 같다(전에는 1.15 로 벽보다 높았다)", () => {
    expect(PHONE_BOOTH_MODEL_TOP * PHONE_BOOTH_HEIGHT_SCALE).toBeCloseTo(AAS_WALL_HEIGHT, 3);
  });

  it("전화 부스는 서쪽·남쪽 외벽의 안쪽 면에 닿고 벽 안으로 들어가지 않는다", () => {
    const booth = buildAasKoreanOffice().find((i) => i.type === "phone_booth")!;
    const b = getItemBounds(booth);
    const inset = AAS_OUTER_WALL_THICKNESS / 2 / SCALE; // 외벽은 경계선을 가운데로 두께 0.12 로 그려진다
    expect(b.x).toBeGreaterThanOrEqual(inset);
    expect(b.x).toBeLessThan(inset + 1);
    expect(b.y + b.h).toBeLessThanOrEqual(1080 - inset);
    expect(b.y + b.h).toBeGreaterThan(1080 - inset - 1);
  });
});
