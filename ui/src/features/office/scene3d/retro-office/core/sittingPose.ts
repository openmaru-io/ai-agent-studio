/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// AAS(2026-10-20): 의자·소파에 앉은 자세. 원본은 앉은 상태에도 다리를 편 채 몸만 뒤로 0.15 기울여,
// 캐릭터가 의자·소파 자리에 선 채로 의자를 뚫고 서 있는 것처럼 보였다. 다리를 앞으로 눕혀(허벅지가 좌석 위)
// 몸을 좌석 높이만큼 들어 올리고, 몸통은 세우고, 팔은 책상 쪽으로 든다.

/** 좌석 윗면 높이(장면 단위). 장면에서 잰 값: 책상 의자 0.297, 휴게 소파 0.28. 둘 다 이 값으로 앉힌다 */
export const SEAT_TOP = 0.29;
/** 몸통 아랫면 높이(캐릭터 기준, objects/agents.tsx 의 몸통 상자 가운데 0.28 − 반 높이 0.1) */
export const TORSO_BOTTOM = 0.18;
/** 다리 상자 깊이(objects/agents.tsx 의 다리 상자 0.07 × 0.14 × 0.08). 앞으로 눕히면 이 깊이가 두께가 된다 */
export const LEG = { depth: 0.08 } as const;

export function sittingPose(scale: number): {
  /** 몸 그룹을 들어 올리는 높이(장면 단위) */
  lift: number;
  /** 다리 그룹 자리(캐릭터 기준). 선 자세는 y 0.1, z 0 */
  legY: number;
  legZ: number;
  legRotX: number;
  torsoRotX: number;
  armRotX: number;
} {
  // 다리를 −90° 돌리면 다리 상자는 회전축(다리 그룹 자리)을 가운데로 앞뒤로 눕는다. 허벅지 윗면이 몸통 아래에 붙게 축을 올리고,
  // 다리가 몸통 아래에서 앞으로 나오게 조금 앞으로 옮긴다
  const legY = TORSO_BOTTOM - LEG.depth / 2;
  const lift = SEAT_TOP - (legY - LEG.depth / 2) * scale;
  return { lift, legY, legZ: 0.035, legRotX: -Math.PI / 2, torsoRotX: 0, armRotX: -0.9 };
}
