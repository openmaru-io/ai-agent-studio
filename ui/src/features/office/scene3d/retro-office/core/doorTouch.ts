/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { DOOR_LENGTH, DOOR_THICKNESS, SCALE } from "@/features/office/scene3d/retro-office/core/constants";
import { getItemRotationRadians, toWorld } from "@/features/office/scene3d/retro-office/core/geometry";
import type { FurnitureItem } from "@/features/office/scene3d/retro-office/core/types";

/**
 * 문 둘레(문 길이 방향 반 너비 + 0.2, 두께 방향 반 두께 + 0.2, 월드 단위)에 누가 서 있으면 true.
 * AAS: 장면에는 Claw3D 에이전트 목록과 사람 아바타 목록(AasPeopleLayer)이 따로 있어 둘 다 받는다.
 */
export function doorTouched(
  item: FurnitureItem,
  ...lists: readonly (readonly { x: number; y: number }[] | null | undefined)[]
): boolean {
  const [wx, , wz] = toWorld(item.x, item.y);
  const width = (item.w ?? DOOR_LENGTH) * SCALE;
  const depth = Math.max((item.h ?? DOOR_THICKNESS) * SCALE, 0.04);
  const rotY = getItemRotationRadians(item);
  const centerX = wx + width / 2;
  const centerZ = wz + depth / 2;
  const cos = Math.cos(rotY);
  const sin = Math.sin(rotY);
  const touchPadX = width * 0.5 + 0.2;
  const touchPadZ = depth * 0.5 + 0.2;
  return lists.some((agents) =>
    (agents ?? []).some((agent) => {
      const [ax, , az] = toWorld(agent.x, agent.y);
      const dx = ax - centerX;
      const dz = az - centerZ;
      const localX = dx * cos + dz * sin;
      const localZ = -dx * sin + dz * cos;
      return Math.abs(localX) <= touchPadX && Math.abs(localZ) <= touchPadZ;
    }),
  );
}
