import {
  AGENT_RADIUS,
  BUMP_FREEZE_MS,
  SEPARATION_STRENGTH,
} from "@/features/office/scene3d/retro-office/core/constants";
import {
  isRemoteOfficeAgentId,
  REMOTE_ROAM_POINTS,
} from "@/features/office/scene3d/retro-office/core/district";
import { ROAM_POINTS } from "@/features/office/scene3d/retro-office/core/navigation";
import type { RenderAgent } from "@/features/office/scene3d/retro-office/core/types";
import {
  GREET_COOLDOWN_MS,
  GREET_REPLY_DELAY_MS,
  GREET_SHOW_MS,
  greetKind,
  pickGreeting,
  type GreetPair,
} from "@/features/office/greetings";

/** AAS(스펙 2026-10-21-021): 누가 언제 누구와 인사했는지. 장면이 있는 동안만 기억한다 */
export type GreetMemory = {
  /** 에이전트별 인사 쉼(이 안에는 새 인사 대신 부딪힘 문구) */
  cooldownUntil: Map<string, number>;
  /** 짝(두 id 를 정렬해 이은 키)별 마지막 인사·부딪힘 문구 시각 */
  pairGreetAt: Map<string, number>;
  pairBumpAt: Map<string, number>;
  /** 먼저 말한 에이전트가 바로 앞에 쓴 쌍 */
  lastPair: Map<string, string>;
};

export const createGreetMemory = (): GreetMemory => ({
  cooldownUntil: new Map(),
  pairGreetAt: new Map(),
  pairBumpAt: new Map(),
  lastPair: new Map(),
});

type ApplyAgentCollisionBumpsArgs = {
  agents: RenderAgent[];
  now: number;
  /** 없으면 인사하지 않는다(풍선 없이 1.5초 멈춤) */
  greetings?: { pairs: GreetPair[]; memory: GreetMemory; date?: Date; rand?: () => number };
};

export function applyAgentCollisionBumps({
  agents,
  now,
  greetings,
}: ApplyAgentCollisionBumpsArgs): RenderAgent[] {
  const moved = [...agents];
  const collisionCellSize = AGENT_RADIUS * 4;
  const collisionBuckets = new Map<string, number[]>();
  for (let index = 0; index < moved.length; index += 1) {
    const agent = moved[index];
    if ("role" in agent && agent.role === "janitor") continue;
    const bucketKey = `${Math.floor(agent.x / collisionCellSize)}:${Math.floor(
      agent.y / collisionCellSize,
    )}`;
    const bucket = collisionBuckets.get(bucketKey);
    if (bucket) bucket.push(index);
    else collisionBuckets.set(bucketKey, [index]);
  }

  for (let i = 0; i < moved.length; i += 1) {
    const mi = moved[i];
    if ("role" in mi && mi.role === "janitor") continue;
    if (
      moved[i].state === "sitting" ||
      moved[i].state === "working_out" ||
      moved[i].state === "dancing"
    )
      continue;
    if (moved[i].pingPongUntil !== undefined && moved[i].state !== "walking")
      continue;
    if (moved[i].bumpedUntil !== undefined) continue;
    if ((moved[i].collisionCooldownUntil ?? 0) > now) continue;
    let sx = 0,
      sy = 0,
      fx = 0,
      fy = 0;
    // AAS(2026-10-21-021): 인사 짝은 부딪힌 상대 가운데 가장 가까운 에이전트
    let partner = -1;
    let partnerD = Infinity;
    // AAS(2026-10-26-012): 목적지가 있는 에이전트는 앞(걷는 쪽)에 있는 상대와 부딪혔을 때만 멈춘다. 목적지를 지키게 한 뒤(2026-10-26-009)
    // 같은 길로 나란히 걷는 둘이 1.2초마다 함께 멈추기를 되풀이했다 — 뒤따르는 쪽만 멈춰야 간격이 벌어진다
    const keepTarget = mi.interactionTarget !== undefined || mi.restSeat !== undefined;
    const step = mi.path[0] ? { x: mi.path[0].x - mi.x, y: mi.path[0].y - mi.y } : { x: Math.sin(mi.facing), y: Math.cos(mi.facing) };
    let aheadHit = false;
    const bucketX = Math.floor(mi.x / collisionCellSize);
    const bucketY = Math.floor(mi.y / collisionCellSize);
    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        const bucket = collisionBuckets.get(
          `${bucketX + offsetX}:${bucketY + offsetY}`,
        );
        if (!bucket) continue;
        for (const j of bucket) {
          if (i === j) continue;
          const mj = moved[j];
          if ("role" in mj && mj.role === "janitor") continue;
          // AAS(2026-10-26-012): 자리로 가는 에이전트(목적지 있음)에게 앉아 있는 캐릭터는 길을 막지 않는다. 회의실 의자 줄 뒤 좁은 통로로
          // 가운데 자리에 가는 에이전트가 앉은 옆 사람마다 멈췄다. 돌아다니던 에이전트는 그대로 앉은 사람과 인사한다(2026-10-21-021)
          if (keepTarget && mj.state === "sitting") continue;
          let ddx = moved[i].x - moved[j].x;
          let ddy = moved[i].y - moved[j].y;
          const d = Math.hypot(ddx, ddy);
          const minDist = AGENT_RADIUS * 2;
          if (d < minDist) {
            if (step.x * (moved[j].x - mi.x) + step.y * (moved[j].y - mi.y) > 0) aheadHit = true;
            if (d < partnerD) {
              partnerD = d;
              partner = j;
            }
            if (d === 0) {
              ddx = Math.random() - 0.5;
              ddy = Math.random() - 0.5;
            }
            const effD = Math.max(d, 0.01);
            const effNorm = Math.hypot(ddx, ddy) || 1;
            const push = (1 - effD / minDist) * SEPARATION_STRENGTH;
            sx += (ddx / effNorm) * push;
            sy += (ddy / effNorm) * push;
            fx += (-ddx / effNorm) * push;
            fy += (-ddy / effNorm) * push;
          }
        }
      }
    }
    if (sx === 0 && sy === 0) continue;
    if (keepTarget && !aheadHit) continue;
    const pushMag = Math.hypot(sx, sy);
    const norm = pushMag || 1;
    let bestDot = -Infinity;
    const roamCandidates = isRemoteOfficeAgentId(moved[i].id)
      ? REMOTE_ROAM_POINTS
      : ROAM_POINTS;
    let escapeTarget = roamCandidates[0];
    for (const rp of roamCandidates) {
      const rdx = rp.x - moved[i].x,
        rdy = rp.y - moved[i].y;
      const rdist = Math.hypot(rdx, rdy) || 1;
      const dot = (rdx / rdist) * (sx / norm) + (rdy / rdist) * (sy / norm);
      if (dot > bestDot) {
        bestDot = dot;
        escapeTarget = rp;
      }
    }
    // AAS(2026-10-26-009): 목적지가 있는 에이전트(회의 자리·책상 등 interactionTarget, 쉬는 자리 restSeat)는 멈추기만 하고 목적지를
    // 그대로 둔다. 풀리면 이동 틱이 같은 목적지로 길을 다시 낸다. 원본처럼 배회 지점으로 바꾸면 회의실에 들어간 에이전트가 복도의
    // 배회 지점으로 걸어 나가, 거기서 「회의 자리에 닿았다」로 보고 의자 없이 앉았다(사용자 보고 2026-10-26)
    moved[i] = {
      ...moved[i],
      facing: Math.atan2(fx || sx, fy || sy),
      state: "standing",
      path: [],
      ...(keepTarget ? {} : { targetX: escapeTarget.x, targetY: escapeTarget.y }),
      bumpedUntil: now + BUMP_FREEZE_MS,
    };
    if (greetings && partner >= 0) greetPartner(moved, i, partner, now, greetings);
  }

  return moved;
}

/** AAS(스펙 2026-10-21-021): i 와 짝 j 가 인사를 주고받게 한다. id 가 작은 쪽이 먼저 말하고, 다른 쪽은 0.7초 뒤 답한다.
 *  걷거나 서 있던 짝은 함께 2.4초 서서 서로 바라본다. 앉아 있거나 운동·춤 중인 짝은 답만 한다. */
function greetPartner(
  moved: RenderAgent[],
  i: number,
  j: number,
  now: number,
  greetings: NonNullable<ApplyAgentCollisionBumpsArgs["greetings"]>,
): void {
  const a = moved[i];
  const b = moved[j];
  if (b.state === "away") return;
  // 이미 다른 짝과 말하는 중이면 끼어들지 않는다
  if ((a.greetUntil ?? 0) > now || (b.greetUntil ?? 0) > now) return;
  const { memory } = greetings;
  const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
  const kind = greetKind({
    now,
    cooldown: (memory.cooldownUntil.get(a.id) ?? 0) > now || (memory.cooldownUntil.get(b.id) ?? 0) > now,
    pairGreetAt: memory.pairGreetAt.get(key),
    pairBumpAt: memory.pairBumpAt.get(key),
  });
  if (!kind) return;
  const [opener, replier] = a.id < b.id ? [a, b] : [b, a];
  const picked = pickGreeting({
    pairs: greetings.pairs,
    kind,
    date: greetings.date ?? new Date(now),
    rand: greetings.rand ?? Math.random,
    names: { opener: opener.name, replier: replier.name },
    avoid: memory.lastPair.get(opener.id),
  });
  if (!picked) return;
  if (kind === "bump") {
    memory.pairBumpAt.set(key, now);
  } else {
    memory.pairGreetAt.set(key, now);
    memory.cooldownUntil.set(a.id, now + GREET_COOLDOWN_MS);
    memory.cooldownUntil.set(b.id, now + GREET_COOLDOWN_MS);
  }
  memory.lastPair.set(opener.id, picked.id);
  const until = now + GREET_SHOW_MS;
  const line = (who: RenderAgent) =>
    who === opener
      ? { greetText: picked.open, greetFrom: now, greetUntil: until }
      : { greetText: picked.reply, greetFrom: now + GREET_REPLY_DELAY_MS, greetUntil: until };
  moved[i] = { ...a, ...line(a), facing: Math.atan2(b.x - a.x, b.y - a.y), bumpedUntil: until };
  const canStop =
    (b.state === "walking" || b.state === "standing") &&
    b.pingPongUntil === undefined &&
    b.bumpedUntil === undefined;
  moved[j] = canStop
    ? { ...b, ...line(b), state: "standing", path: [], facing: Math.atan2(a.x - b.x, a.y - b.y), bumpedUntil: until }
    : { ...b, ...line(b) };
}
