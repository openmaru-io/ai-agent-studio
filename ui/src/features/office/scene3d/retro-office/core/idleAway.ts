/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// AAS(2026-10-26-012): 30분 넘게 일이 없는 「자리 비움」 에이전트는 자기 책상에 앉아 있는다(사용자 결정 2026-10-26). 원본(Claw3D)은
// 소파 하나를 골라 그 가운데로 보내, 모두 자리 비움이 되는 저녁에는 전원이 소파 두 개 앞에 몰렸다. 게다가 가끔 돌아다니러 나갔다가
// 길 끝에서 다시 소파로 돌아와 소파 둘레를 벗어나지 못했다.
import type { RestSeat } from "@/features/office/scene3d/retro-office/core/idleRest";
import { SEAT_REACH } from "@/features/office/scene3d/retro-office/core/seatArrival";

export type AwayStep =
  /** 자리에 닿았다 — 앉고 facing 을 본다(모르면 undefined) */
  | { kind: "sit"; facing: number | undefined }
  /** 자리로 걷는다. rest 가 있으면 그 쉬는 자리를 맡는다(들어오는 칸을 거쳐 간다) */
  | { kind: "go"; x: number; y: number; rest?: RestSeat }
  /** 갈 자리가 없거나 가 봤는데 닿지 못했다 — 그 자리에 선다 */
  | { kind: "stand" };

/**
 * 길 끝에 선 자리 비움 에이전트가 할 일. 자리는 자기 책상 → 이미 맡은 쉬는 자리 → 빈 쉬는 자리(pick) 순서다.
 * 목적지가 이미 그 자리인데 닿지 못했으면(길이 없거나 끊김) 다시 길을 내지 않고 선다 — 매 틱 길 찾기를 되풀이하지 않게.
 */
export function awayStep(
  agent: { x: number; y: number; targetX: number; targetY: number; restSeat?: RestSeat },
  desk: { x: number; y: number; facing?: number } | null,
  pick: () => RestSeat | null,
): AwayStep {
  const near = (p: { x: number; y: number }) => Math.hypot(agent.x - p.x, agent.y - p.y) < SEAT_REACH;
  const tried = (p: { x: number; y: number }) => agent.targetX === p.x && agent.targetY === p.y;
  if (desk) {
    if (near(desk)) return { kind: "sit", facing: desk.facing };
    return tried(desk) ? { kind: "stand" } : { kind: "go", x: desk.x, y: desk.y };
  }
  const rest = agent.restSeat ?? pick();
  if (!rest) return { kind: "stand" };
  if (near(rest)) return { kind: "sit", facing: rest.facing };
  if (agent.restSeat && tried(rest)) return { kind: "stand" };
  return { kind: "go", x: rest.x, y: rest.y, rest };
}
