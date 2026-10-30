/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// AAS(2026-10-21): 일하는 중인 에이전트가 길 끝에 닿았을 때의 자세. 원본은 sms·전화 부스·서버실·QA 가 아니면 모두 앉혔다.
// 길이 비어 있어도(자리 미배정이라 목표 = 지금 자리, 또는 길을 찾지 못함) 「닿았다」로 쳐서, 의자가 없는 복도에서 허공에 앉았다.
import type { OfficeInteractionTargetId } from "@/features/office/scene3d/lib/office/places";

/** 자리에 닿았다고 보는 거리(배치 좌표). 상태를 정할 때 쓰는 값(RetroOffice3D 의 `< 15`)과 같다 */
export const SEAT_REACH = 15;

/** 앉을 의자가 있는 목표: 내 책상, 회의 자리 */
const SEAT_TARGETS: ReadonlySet<OfficeInteractionTargetId> = new Set(["desk", "meeting_room"]);

/** 일하는 중인 에이전트가 길 끝에서 앉을지 설지. 의자가 있는 목표에 실제로 닿았을 때만 앉는다 */
export function arrivedState(
  target: OfficeInteractionTargetId | undefined,
  x: number,
  y: number,
  targetX: number,
  targetY: number,
): "sitting" | "standing" {
  if (!target || !SEAT_TARGETS.has(target)) return "standing";
  return Math.hypot(x - targetX, y - targetY) < SEAT_REACH ? "sitting" : "standing";
}
