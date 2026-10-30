/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { bubbleRadius, bubbleTailShape, roundedRectShape } from "./RoundedPlate";

describe("roundedRectShape", () => {
  it("판 크기만큼의 범위 안에서 모서리만 깎인다", () => {
    const g = new THREE.ShapeGeometry(roundedRectShape(1.5, 0.27, 0.07), 8);
    g.computeBoundingBox();
    const b = g.boundingBox!;
    expect(b.max.x - b.min.x).toBeCloseTo(1.5, 5);
    expect(b.max.y - b.min.y).toBeCloseTo(0.27, 5);
    // 모서리 점(±0.75, ±0.135)은 정점에 없다 — 둥글게 깎였다
    const pos = g.getAttribute("position");
    const hasCorner = Array.from({ length: pos.count }, (_, i) => [pos.getX(i), pos.getY(i)]).some(
      ([x, y]) => Math.abs(Math.abs(x) - 0.75) < 1e-6 && Math.abs(Math.abs(y) - 0.135) < 1e-6
    );
    expect(hasCorner).toBe(false);
  });

  it("반지름이 판보다 크면 판 절반으로 줄인다", () => {
    const g = new THREE.ShapeGeometry(roundedRectShape(0.2, 0.1, 5), 8);
    g.computeBoundingBox();
    expect(g.boundingBox!.max.y - g.boundingBox!.min.y).toBeCloseTo(0.1, 5);
  });
});

describe("말풍선 모양(2026-10-16: 테두리를 둥글게)", () => {
  it("반지름은 높이에 비례하되 0.14 를 넘지 않는다(작은 풍선은 알약, 큰 풍선은 너무 둥글지 않게)", () => {
    expect(bubbleRadius(0.2)).toBeCloseTo(0.08, 5);
    expect(bubbleRadius(0.72)).toBeCloseTo(0.14, 5);
    expect(bubbleRadius(2)).toBeCloseTo(0.14, 5);
    expect(bubbleRadius(0.2)).toBeLessThanOrEqual(0.2 / 2); // 판 절반(알약 한계)을 넘지 않는다
  });

  it("꼬리는 위쪽(0)에서 아래로 뻗고 끝이 뾰족하지 않게 둥글다", () => {
    const g = new THREE.ShapeGeometry(bubbleTailShape(0.2, 0.14), 8);
    g.computeBoundingBox();
    const b = g.boundingBox!;
    expect(b.max.y).toBeCloseTo(0, 5); // 풍선 아래 가장자리에 붙는 쪽
    expect(b.min.y).toBeCloseTo(-0.14, 5); // 끝
    expect(b.max.x - b.min.x).toBeCloseTo(0.2, 5);
    // 끝 한 점(0, -0.14)에서 가장 가까운 정점도 x 가 0.012 이내로 퍼져 있다 = 곡선으로 마무리된 끝
    const pos = g.getAttribute("position");
    const tip = Array.from({ length: pos.count }, (_, i) => [pos.getX(i), pos.getY(i)]).filter(([, y]) => y < -0.14 + 0.003);
    expect(tip.length).toBeGreaterThan(0);
    expect(tip.every(([x]) => Math.abs(x) <= 0.0121)).toBe(true);
  });
});
