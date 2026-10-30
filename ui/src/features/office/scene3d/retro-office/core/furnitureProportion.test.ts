/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { COUCH_SEAT } from "@/features/office/people";
import { FURNITURE_SCALE } from "@/features/office/scene3d/retro-office/objects/furniture";

import { buildAasKoreanOffice } from "./aasKoreanOffice";
import { SCALE } from "./constants";
import { ITEM_FOOTPRINT } from "./geometry";

/** GLB 의 정점 범위(모델 단위). 파일의 JSON 덩어리에서 VEC3 접근자의 min·max 를 모은다. */
function modelSize(name: string): [number, number, number] {
  const b = readFileSync(join(__dirname, "../../assets/models", `${name}.glb`));
  const len = b.readUInt32LE(12);
  const j = JSON.parse(b.subarray(20, 20 + len).toString("utf8")) as { accessors: { type: string; min?: number[]; max?: number[] }[] };
  const acc = j.accessors.filter((a) => a.type === "VEC3" && a.min && a.max);
  const lo = [0, 1, 2].map((i) => Math.min(...acc.map((a) => a.min![i])));
  const hi = [0, 1, 2].map((i) => Math.max(...acc.map((a) => a.max![i])));
  return [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
}

// 소파에 앉으면 사람이 방석에 파묻혀 보였다(사용자 보고 2026-10-16). 사람은 앉아도 바닥에 선 채 자리에 놓이므로(agents.tsx),
// 가구가 의자와 같은 비율이어야 앉은 모습이 맞는다. 소파가 의자보다 1.5배(배율 1.8 대 1.2) 크고 자리 상자(100×40)에 맞춰 더 늘어나 있었다.
describe("소파와 의자의 비율", () => {
  const sofa = modelSize("loungeSofa");
  const chair = modelSize("chairDesk");

  it("소파 높이(등받이)는 의자 높이와 비슷하다(0.9~1.25 배)", () => {
    const ratio = (sofa[1] * FURNITURE_SCALE.couch[1]) / (chair[1] * FURNITURE_SCALE.chair[1]);
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.25);
  });

  it("한국 사무실 배치의 소파는 늘어나지 않는다(가로·깊이 배율이 높이 배율과 10% 안)", () => {
    const sy = FURNITURE_SCALE.couch[1];
    const couches = buildAasKoreanOffice().filter((i) => i.type === "couch");
    expect(couches.length).toBeGreaterThan(0);
    for (const c of couches) {
      const sx = ((c.w ?? 0) * SCALE) / sofa[0];
      const sz = ((c.h ?? 0) * SCALE) / sofa[2];
      expect(Math.abs(sx / sy - 1), `${c._uid} 가로`).toBeLessThan(0.1);
      expect(Math.abs(sz / sy - 1), `${c._uid} 깊이`).toBeLessThan(0.1);
    }
  });

  it("편집으로 새로 놓는 소파의 기본 자리 상자도 모델 크기와 같다", () => {
    const [w, h] = ITEM_FOOTPRINT.couch;
    expect(Math.abs((w * SCALE) / (sofa[0] * FURNITURE_SCALE.couch[0]) - 1)).toBeLessThan(0.1);
    expect(Math.abs((h * SCALE) / (sofa[2] * FURNITURE_SCALE.couch[2]) - 1)).toBeLessThan(0.1);
  });

  it("소파 하나에 두 사람이 앉는다", () => {
    for (const c of buildAasKoreanOffice().filter((i) => i.type === "couch")) {
      expect(Math.max(1, Math.round((c.w ?? 0) / COUCH_SEAT)), c._uid).toBe(2);
    }
  });
});

// 소파 앞 탁자도 같은 비율로 맞춘다. 80×36 자리 상자에 맞춰 가로가 높이보다 1.4배 늘어나 있었다.
describe("휴게 공간 탁자의 비율", () => {
  it("가로·깊이 배율이 높이 배율과 10% 안이고, 높이 배율은 의자와 같다", () => {
    const table = modelSize("table");
    const sy = FURNITURE_SCALE.table_rect[1];
    expect(sy).toBe(FURNITURE_SCALE.chair[1]);
    const t = buildAasKoreanOffice().find((i) => i.type === "table_rect" && i.y > 900 && i.x < 700)!;
    expect(Math.abs(((t.w ?? 0) * SCALE) / table[0] / sy - 1)).toBeLessThan(0.1);
    expect(Math.abs(((t.h ?? 0) * SCALE) / table[2] / sy - 1)).toBeLessThan(0.1);
  });
});

describe("휴게 공간 소파 배치(2026-10-16: 붙여서 놓는다)", () => {
  it("두 소파가 빈틈 없이 붙어 있고 앞 탁자 가운데에 맞춰져 있다", () => {
    const items = buildAasKoreanOffice();
    const [a, b] = items.filter((i) => i.type === "couch").sort((p, q) => p.x - q.x);
    expect(a.x + (a.w ?? 0)).toBe(b.x); // 붙어 있다
    expect(a.y).toBe(b.y);
    const table = items.find((i) => i.type === "table_rect" && i.y > 900 && i.x < 700)!;
    expect((a.x + b.x + (b.w ?? 0)) / 2).toBe(table.x + (table.w ?? 0) / 2); // 두 소파의 가운데 = 탁자 가운데
  });
});
