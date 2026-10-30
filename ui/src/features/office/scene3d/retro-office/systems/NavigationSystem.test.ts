/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 걷다 마주친 두 에이전트가 「...」 대신 인사를 주고받는다(스펙 2026-10-21-021, OMAI-1429).
import { describe, expect, it } from "vitest";

import {
  BUMP_LINE_COOLDOWN_MS,
  GREET_COOLDOWN_MS,
  GREET_REPLY_DELAY_MS,
  GREET_SHOW_MS,
  type GreetPair,
} from "@/features/office/greetings";
import { BUMP_FREEZE_MS } from "../core/constants";
import type { RenderAgent } from "../core/types";
import { applyAgentCollisionBumps, createGreetMemory } from "./NavigationSystem";

const pairs: GreetPair[] = [
  { id: "hello", when: "any", open: "{name}님, 안녕하세요!", reply: "네, 안녕하세요!" },
  { id: "again", when: "again", open: "또 뵙네요!", reply: "그러게요!" },
  { id: "oops", when: "bump", open: "앗, 죄송해요!", reply: "괜찮아요~" },
];

const agent = (id: string, name: string, x: number, state: RenderAgent["state"] = "walking"): RenderAgent => ({
  id,
  name,
  status: "idle",
  color: "#888",
  item: "",
  x,
  y: 500,
  targetX: 900,
  targetY: 500,
  path: [{ x: 900, y: 500 }],
  facing: 0,
  frame: 0,
  walkSpeed: 0.3,
  phaseOffset: 0,
  state,
});

const date = new Date(2026, 9, 21, 12);
const rand = () => 0;

function meet(memory = createGreetMemory(), now = 1_000_000, b: RenderAgent = agent("b", "관리자 Hermes", 505)) {
  const moved = applyAgentCollisionBumps({
    agents: [agent("a", "YJBot", 500), b],
    now,
    greetings: { pairs, memory, date, rand },
  });
  return { a: moved[0], b: moved[1], memory };
}

describe("applyAgentCollisionBumps 인사", () => {
  it("id 가 작은 쪽이 먼저 말하고, 다른 쪽은 0.7초 뒤 답한다. 둘 다 2.4초 서 있다", () => {
    const now = 1_000_000;
    const { a, b } = meet(createGreetMemory(), now);
    expect(a.greetText).toBe("관리자 Her…님, 안녕하세요!");
    expect(a.greetFrom).toBe(now);
    expect(b.greetText).toBe("네, 안녕하세요!");
    expect(b.greetFrom).toBe(now + GREET_REPLY_DELAY_MS);
    expect(a.greetUntil).toBe(now + GREET_SHOW_MS);
    expect(b.greetUntil).toBe(now + GREET_SHOW_MS);
    expect(a.bumpedUntil).toBe(now + GREET_SHOW_MS);
    expect(b.bumpedUntil).toBe(now + GREET_SHOW_MS);
    expect(a.state).toBe("standing");
    expect(b.state).toBe("standing");
    // 서로 바라본다(a 는 +x 쪽, b 는 -x 쪽)
    expect(a.facing).toBeCloseTo(Math.PI / 2);
    expect(b.facing).toBeCloseTo(-Math.PI / 2);
  });

  it("인사 쉼 안에 다시 부딪히면 부딪힘 문구, 같은 짝 8초 안이면 풍선이 없다", () => {
    const memory = createGreetMemory();
    const now = 1_000_000;
    meet(memory, now);
    const second = meet(memory, now + 5_000);
    expect(second.a.greetText).toBe("앗, 죄송해요!");
    expect(second.b.greetText).toBe("괜찮아요~");
    const third = meet(memory, now + 5_000 + BUMP_LINE_COOLDOWN_MS - 1);
    expect(third.a.greetText).toBeUndefined();
    expect(third.a.bumpedUntil).toBe(now + 5_000 + BUMP_LINE_COOLDOWN_MS - 1 + BUMP_FREEZE_MS);
  });

  it("쉼이 끝난 뒤 10분 안에 다시 마주치면 다시 만남 문구", () => {
    const memory = createGreetMemory();
    meet(memory, 1_000_000);
    const again = meet(memory, 1_000_000 + GREET_COOLDOWN_MS);
    expect(again.a.greetText).toBe("또 뵙네요!");
  });

  it("앉아 있는 상대도 답하지만 멈추거나 돌아서지 않는다", () => {
    const sitting = agent("b", "관리자 Hermes", 505, "sitting");
    const { a, b } = meet(createGreetMemory(), 1_000_000, sitting);
    expect(a.greetText).toBeDefined();
    expect(b.greetText).toBe("네, 안녕하세요!");
    expect(b.state).toBe("sitting");
    expect(b.bumpedUntil).toBeUndefined();
    expect(b.facing).toBe(0);
  });

  it("문구를 받지 않으면 인사하지 않고 1.5초만 멈춘다", () => {
    const now = 1_000_000;
    const [a] = applyAgentCollisionBumps({ agents: [agent("a", "A", 500), agent("b", "B", 505)], now });
    expect(a.greetText).toBeUndefined();
    expect(a.bumpedUntil).toBe(now + BUMP_FREEZE_MS);
  });
});

// 사용자 보고(2026-10-26, OKE 회의 중 화면): 회의실에 들어간 에이전트가 다시 나와 복도에 있고, 의자 없는 복도에서 허공에 앉았다.
// 부딪힘이 목적지를 비켜 갈 배회 지점(ROAM_POINTS)으로 바꿔, 회의 자리로 가던 에이전트가 복도의 배회 지점으로 걸었다. 거기 닿으면
// 이동 틱이 「회의 자리 목적지에 닿았다」로 보고 앉혔다(seatArrival.arrivedState 는 목적지 좌표만 본다)
describe("applyAgentCollisionBumps 목적지(스펙 2026-10-26-009)", () => {
  const towards = (id: string, x: number, target: RenderAgent["interactionTarget"]): RenderAgent => ({
    ...agent(id, id.toUpperCase(), x),
    targetX: 300,
    targetY: 100,
    path: [{ x: 300, y: 100 }],
    interactionTarget: target,
  });

  it("회의 자리·책상으로 가던 에이전트는 부딪혀 멈춰도 목적지를 바꾸지 않는다", () => {
    for (const target of ["meeting_room", "desk"] as const) {
      // b 가 a 의 앞(목적지 쪽)에 있다 — 뒤따르는 a 가 멈춘다
      const [a, b] = applyAgentCollisionBumps({ agents: [towards("a", 500, target), { ...towards("b", 497, target), y: 495 }], now: 1_000_000 });
      expect(a.bumpedUntil, target).toBeDefined();
      expect([a.targetX, a.targetY], target).toEqual([300, 100]);
      expect([b.targetX, b.targetY], target).toEqual([300, 100]);
    }
  });

  it("쉬는 자리로 가던 에이전트도 목적지를 바꾸지 않는다", () => {
    const seat = { uid: "s", x: 300, y: 100, facing: 0, approachX: 300, approachY: 140 };
    const [a] = applyAgentCollisionBumps({ agents: [{ ...towards("a", 500, undefined), restSeat: seat }, agent("b", "B", 505)], now: 1_000_000 });
    expect([a.targetX, a.targetY]).toEqual([300, 100]);
  });

  // 가짜 서버(2026-10-26): 목적지를 지키게 하자, 같은 길로 나란히 걷던 두 에이전트가 1.2초마다 부딪혀 멈추기를 되풀이했다
  it("같은 쪽으로 걷다 부딪히면 뒤따르던 쪽만 멈추고 앞선 쪽은 계속 걷는다", () => {
    const go = (id: string, y: number): RenderAgent => ({ ...towards(id, 413, "desk"), y, targetX: 413, targetY: 1000, path: [{ x: 413, y: 1000 }] });
    const [lead, follow] = applyAgentCollisionBumps({ agents: [go("a", 930), go("b", 925)], now: 1_000_000 });
    expect(lead.bumpedUntil).toBeUndefined();
    expect(lead.state).toBe("walking");
    expect(follow.bumpedUntil).toBeDefined();
  });

  // 가짜 서버 회의(2026-10-26): 의자 줄 뒤 좁은 통로로 가운데 자리에 가던 에이전트가 이미 앉은 옆 의자 에이전트마다 2초씩 멈췄다
  it("앉아 있는 캐릭터와는 부딪히지 않는다(의자 뒤를 지나간다)", () => {
    const walker = { ...towards("a", 100, "meeting_room"), y: 60, targetX: 212, targetY: 66, path: [{ x: 212, y: 66 }] };
    const seated = { ...agent("b", "B", 105), y: 62, state: "sitting" as const, path: [] };
    const [w] = applyAgentCollisionBumps({ agents: [walker, seated], now: 1_000_000 });
    expect(w.bumpedUntil).toBeUndefined();
    expect(w.state).toBe("walking");
  });

  it("마주 오다 부딪히면 둘 다 멈춘다", () => {
    const a = { ...towards("a", 500, "desk"), targetX: 900, targetY: 500, path: [{ x: 900, y: 500 }] };
    const b = { ...towards("b", 505, "desk"), targetX: 100, targetY: 500, path: [{ x: 100, y: 500 }] };
    const [x, y] = applyAgentCollisionBumps({ agents: [a, b], now: 1_000_000 });
    expect(x.bumpedUntil).toBeDefined();
    expect(y.bumpedUntil).toBeDefined();
  });

  it("목적지 없이 돌아다니던 에이전트는 원본처럼 밀린 쪽 배회 지점으로 비켜 간다", () => {
    const [a] = applyAgentCollisionBumps({ agents: [agent("a", "A", 500), agent("b", "B", 505)], now: 1_000_000 });
    expect([a.targetX, a.targetY]).not.toEqual([900, 500]);
  });
});
