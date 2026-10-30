/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { furnitureTints, SCENE_PALETTE } from "@/features/office/tokens";
import { FURNITURE_GLB } from "@/features/office/scene3d/retro-office/objects/furniture";

/** GLB 의 재질 이름. 파일 머리의 JSON 덩어리에서 materials[].name 을 읽는다. */
function materialNames(glbUrl: string): string[] {
  const file = /([^/]+\.glb)/.exec(glbUrl)?.[1];
  if (!file) throw new Error(`GLB 파일 이름을 찾지 못함: ${glbUrl}`);
  const b = readFileSync(join(__dirname, "../../assets/models", file));
  const json = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString("utf8")) as { materials?: { name?: string }[] };
  return (json.materials ?? []).map((m) => m.name ?? "");
}

// 스펙 2026-10-20-012 §10 E3: 재질 이름별로 칠하는 가구는 모델의 모든 재질 이름이 색 표에 있어야 한다.
// 모델을 바꾸거나 더해 이름이 달라지면 그 재질이 GLB 원래 색(옅은 민트·베이지)으로 조용히 돌아간다.
describe("가구 재질 색 표", () => {
  const tints = furnitureTints(SCENE_PALETTE.dark);
  for (const [type, tint] of Object.entries(tints)) {
    if (tint === null || typeof tint === "string") continue;
    const kind = type === "kanban_wall" ? "notice_board" : type;
    it(`${type}: GLB 재질 이름이 모두 표에 있다`, () => {
      const glb = FURNITURE_GLB[kind];
      expect(glb, `${type} 의 GLB`).toBeTruthy();
      const missing = materialNames(glb).filter((n) => !(n in tint));
      expect(missing).toEqual([]);
    });
  }

  it("화분은 잎과 화분이 다른 색이다(사용자 지적: 화분이 너무 옅다)", () => {
    for (const p of Object.values(SCENE_PALETTE)) {
      const plant = furnitureTints(p).plant as Record<string, string>;
      expect(plant.plant).not.toBe(plant.wood);
      expect(plant.wood).toBe(p.pot);
    }
  });
});
