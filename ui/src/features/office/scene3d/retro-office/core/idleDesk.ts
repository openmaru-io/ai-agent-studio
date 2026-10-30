/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// AAS(2026-10-21-023): 대기 상태의 에이전트도 대부분 자기 책상에 앉아 있게 한다. 원본은 대기 상태면 책상에 가지 않고,
// 서 있는 동안 매 틱(초당 약 60번) 0.5% 확률로 다른 곳으로 걸어(평균 3초마다) 대기가 많으면 자리에 앉은 사람이 없었다.
import { SEAT_REACH } from "@/features/office/scene3d/retro-office/core/seatArrival";

/** 대기 에이전트가 다음에 걸을 때 책상을 고를 확률. 2026-10-26-004 에서 쉬는 자리(IDLE_REST_CHANCE)를 떼어 0.8 → 0.6 으로 줄였다 */
export const IDLE_DESK_CHANCE = 0.6;

/** 다음 걸음에 휴게 공간 소파·탕비실 의자에 앉으러 갈 확률(2026-10-26-004). 나머지는 원본처럼 사무실 곳곳·휴게 가구 옆으로 간다 */
export const IDLE_REST_CHANCE = 0.25;

/** 대기 에이전트가 책상에 한 번 앉아 머무는 시간(밀리초). 이 사이에서 고르게 고른다 */
export const IDLE_SEAT_MS = { min: 60_000, max: 180_000 } as const;

export type IdleDeskStep =
  | { kind: "sit"; until: number }
  | { kind: "stay" }
  | { kind: "leave" }
  | { kind: "none" };

/** 앉아서 머물 마지막 시각. rand 는 [0, 1) */
export function idleSeatDeadline(now: number, rand: number): number {
  return now + IDLE_SEAT_MS.min + rand * (IDLE_SEAT_MS.max - IDLE_SEAT_MS.min);
}

/** 처음 나타나 책상에 앉은 채 시작할 때 머물 마지막 시각. 0~최대로 흩어 모두가 한꺼번에 일어나지 않게 한다 */
export function idleSpawnDeadline(now: number, rand: number): number {
  return now + rand * IDLE_SEAT_MS.max;
}

/**
 * 길 끝에 선 대기 에이전트가 자기 책상에서 할 일. 책상 좌표와의 거리로만 정한다 — 처음 나타난 에이전트는
 * interactionTarget 이 "desk" 인데 목표가 다른 곳일 수 있어, 목표 좌표를 보면 엉뚱한 곳에서 허공에 앉는다.
 * 일어난 뒤(idleStoodUp)에는 다시 앉지 않는다. 그 자리에 잠깐 서 있다가 다음 걸음(idleNextTrip)에 따라
 * 다시 앉거나 돌아다닌다. 일어나자마자 멀리 보내면 넓은 사무실을 오가느라 앉아 있는 시간만큼 걸었다.
 */
export function idleAtDesk(
  agent: { x: number; y: number; state: string; idleSeatUntil?: number; idleStoodUp?: boolean },
  desk: { x: number; y: number } | null,
  now: number,
  rand: number,
): IdleDeskStep {
  if (!desk || Math.hypot(agent.x - desk.x, agent.y - desk.y) >= SEAT_REACH) return { kind: "none" };
  if (agent.state === "sitting" && agent.idleSeatUntil !== undefined)
    return now < agent.idleSeatUntil ? { kind: "stay" } : { kind: "leave" };
  if (agent.idleStoodUp) return { kind: "none" };
  return { kind: "sit", until: idleSeatDeadline(now, rand) };
}

/** 대기 에이전트가 다음에 걸어갈 곳의 종류. 책상이 없으면 책상 몫은 돌아다니기로 간다. rand 는 [0, 1) */
export function idleNextTrip(hasDesk: boolean, rand: number): "desk" | "rest" | "roam" {
  if (rand < IDLE_DESK_CHANCE) return hasDesk ? "desk" : "roam";
  return rand < IDLE_DESK_CHANCE + IDLE_REST_CHANCE ? "rest" : "roam";
}
