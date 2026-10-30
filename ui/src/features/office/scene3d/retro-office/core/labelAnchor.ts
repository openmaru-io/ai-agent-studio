/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// AAS(2026-10-20-007): 캐릭터(몸 그룹 배율 bodyScale) 안에 있는 이름표 묶음의 배율과 높이.
// 이름표·말풍선은 AGENT_LABEL_SCALE 크기를 지키고, 머리 꼭대기에서 이름표까지의 거리도 바꾸기 전과 같게 한다.
// 몸 그룹 안의 높이 y 는 장면에서 bodyScale × (offsetY + scale × y) 다. 이것이 머리 꼭대기 + AGENT_LABEL_SCALE × (y − HEAD_TOP) 이 되도록 정한다.
import { AGENT_LABEL_SCALE } from "@/features/office/scene3d/retro-office/core/constants";

/** 머리 꼭대기 높이(몸 기준). 머리 상자 가운데 0.47 + 반 높이 0.08, 모자는 0.59~0.62 */
export const HEAD_TOP = 0.6;

export function labelAnchor(bodyScale: number): { scale: number; offsetY: number } {
  const scale = AGENT_LABEL_SCALE / bodyScale;
  return { scale, offsetY: HEAD_TOP * (1 - scale) };
}
