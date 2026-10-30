/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// AAS: 사람 아바타의 걸음 경로(계획 007 P6b). 원본 astar 는 막힌 칸 근처의 빈 칸까지 찾은 뒤 마지막 지점을 목표 좌표로
// 바꾸므로, 그 빈 칸이 책상 반대편이면 마지막 구간이 책상을 가로질렀다. 자리마다 들어오는 쪽의 빈 칸(approach)까지
// 걸은 뒤 마지막 짧은 구간만 자리로 들어가고, 일어날 때는 그 칸으로 먼저 나간다.

type Pt = { x: number; y: number };
type IsFree = (x: number, y: number) => boolean;
type Astar = (fx: number, fy: number, tx: number, ty: number) => Pt[];

const ANGLES = [0, 45, -45, 90, -90, 135, -135, 180].map((d) => (d * Math.PI) / 180);
const DISTANCES = [35, 50, 65];
const SEAT_REACH = 26; // 격자 한 칸(25)
const REACHED = 30; // 이만큼 가까우면 이미 그 칸에 있다

function rotate(v: Pt, a: number): Pt {
  return { x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) };
}

/** 자리 가까운 빈 칸(들어오고 나가는 곳). out 쪽부터 살핀다. 그 칸에서 자리까지 가는 길은 pathFree(자리 가구만 뺀 격자)
 *  에서 모두 비어 있어야 한다 — 벽에 붙은 소파에서 벽과 소파가 이어져 막혀 있으면 벽 바깥 칸이 뽑혀 벽을 지나 들어갔다.
 *  마땅한 칸이 없으면 null(앉지 않는다). */
export function approachPoint(seat: Pt & { out: Pt }, isFree: IsFree, pathFree: IsFree = isFree): Pt | null {
  for (const a of ANGLES) {
    const d = rotate(seat.out, a);
    for (const dist of DISTANCES) {
      const p = { x: seat.x + d.x * dist, y: seat.y + d.y * dist };
      if (!isFree(p.x, p.y)) continue;
      // 자리 바로 앞 한 칸(SEAT_REACH)은 보지 않는다 — 벽에 붙은 자리는 그 칸이 벽의 통행 여유에 걸린다
      let ok = true;
      for (let t = 0.1; t < 1 && ok; t += 0.1) {
        if (dist * (1 - t) < SEAT_REACH) break;
        ok = pathFree(p.x + (seat.x - p.x) * t, p.y + (seat.y - p.y) * t);
      }
      if (ok) return p;
    }
  }
  return null;
}

/** 지금 자리(from, 앉아 있었으면 그 자리에서 나갈 칸 leaveVia)에서 목표까지의 경로. 목표가 자리면 approach(들어오는 칸)를
 *  주고, 그 칸까지 걸은 뒤 마지막 짧은 구간만 자리로 들어간다. approach 가 없는 목표는 그냥 그 점(막혔으면 옆 빈 칸)까지. */
export function planRoute(from: Pt, leaveVia: Pt | null, target: Pt, approach: Pt | null, isFree: IsFree, astar: Astar): Pt[] {
  const start = leaveVia ?? from;
  const head = leaveVia ? [leaveVia] : [];
  const near = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y) < REACHED;
  if (approach) {
    const walk = astar(start.x, start.y, approach.x, approach.y);
    // 길이 없으면(닫힌 방 등) 움직이지 않는다. 빈 경로에 마지막 구간만 붙이면 벽을 뚫고 직선으로 걸었다(Image #12)
    if (!walk.length && !near(start, approach)) return [];
    return [...head, ...walk, { x: target.x, y: target.y }];
  }
  const path = astar(start.x, start.y, target.x, target.y);
  if (!path.length) return [];
  if (path.length && !isFree(target.x, target.y)) {
    path.pop();                                                     // 막힌 곳 한가운데로 들어가지 않는다(그 옆 빈 칸에서 멈춘다)
    if (!path.length) return head;
  }
  return [...head, ...path];
}

/** 다른 캐릭터와 이만큼(가운데 사이, 장면 픽셀) 안으로 스치면 막힌 것으로 본다. 에이전트끼리 부딪힘 거리(AGENT_RADIUS 2배)보다 조금 좁다. */
export const PASS_GAP = 30;
/** 걷는 길을 이만큼 앞까지 살핀다. */
export const LOOK_AHEAD = 60;

/** 앞길을 막은 캐릭터를 피해 다시 낸 길. 고정 격자로 낸 길은 에이전트·다른 사람을 보지 않아 그대로 뚫고 지나갔다
 *  (2026-10-20 사용자 보고). path 의 앞 LOOK_AHEAD 안에서 다른 캐릭터와 PASS_GAP 안으로 스치면, 그 캐릭터들을 지난 첫
 *  경유점까지 그들 주변을 막고 길을 찾아(astarAround) 나머지 길을 잇는다. 등 뒤의 캐릭터는 보지 않는다.
 *  막힌 것이 없으면 null(그대로 간다), 지날 경유점이나 돌아갈 길이 없으면 [](멈춰 기다린다). */
export function detour(
  me: Pt,
  path: Pt[],
  others: Pt[],
  astarAround: (fx: number, fy: number, tx: number, ty: number, blockers: Pt[]) => Pt[],
  gap = PASS_GAP,
  look = LOOK_AHEAD,
): Pt[] | null {
  const first = path[0];
  if (!first) return null;
  const dir = { x: first.x - me.x, y: first.y - me.y };
  const ahead = others.filter((o) => dir.x * (o.x - me.x) + dir.y * (o.y - me.y) > 0);
  if (!ahead.length) return null;
  // 길을 따라 5 씩 걸으며 처음 스치는 곳(hitAt, 길 위 거리)과 막은 캐릭터를 찾는다
  const blockers = new Set<Pt>();
  let hitAt = -1;
  let walked = 0;
  let from = me;
  for (const to of path) {
    const len = Math.hypot(to.x - from.x, to.y - from.y);
    for (let s = 5; s <= len && walked + s <= look; s += 5) {
      const p = { x: from.x + ((to.x - from.x) * s) / len, y: from.y + ((to.y - from.y) * s) / len };
      for (const o of ahead) {
        if (Math.hypot(p.x - o.x, p.y - o.y) < gap) {
          blockers.add(o);
          if (hitAt < 0) hitAt = walked + s;
        }
      }
    }
    walked += len;
    if (walked >= look) break;
    from = to;
  }
  if (!blockers.size) return null;
  const list = [...blockers];
  // 스친 곳을 지났고 막은 캐릭터들과 넉넉히(gap 1.5배) 떨어진 첫 경유점
  let along = 0;
  let prev = me;
  for (let i = 0; i < path.length; i += 1) {
    along += Math.hypot(path[i].x - prev.x, path[i].y - prev.y);
    prev = path[i];
    if (along < hitAt || list.some((b) => Math.hypot(path[i].x - b.x, path[i].y - b.y) < gap * 1.5)) continue;
    const walk = astarAround(me.x, me.y, path[i].x, path[i].y, list);
    return walk.length ? [...walk, ...path.slice(i + 1)] : [];
  }
  return [];
}

/** 캐릭터 둘레(PASS_GAP 안)의 칸을 막은 격자 사본. 돌아가는 길을 찾을 때만 쓴다(원본 격자는 그대로 둔다). */
export function gridAround(grid: Uint8Array, blockers: Pt[], cols: number, cell: number, gap = PASS_GAP): Uint8Array {
  const out = grid.slice();
  for (const b of blockers) {
    for (let r = Math.max(0, Math.floor((b.y - gap) / cell)); r <= Math.floor((b.y + gap) / cell); r += 1) {
      for (let c = Math.max(0, Math.floor((b.x - gap) / cell)); c <= Math.min(cols - 1, Math.floor((b.x + gap) / cell)); c += 1) {
        const at = r * cols + c;
        if (at < out.length && Math.hypot(c * cell + cell / 2 - b.x, r * cell + cell / 2 - b.y) < gap + cell / 2) out[at] = 1;
      }
    }
  }
  return out;
}

type Rect = { x: number; y: number; w: number; h: number };

/** 자리 가구와, 그 가구에 맞닿은 같은 종류 가구(붙여 놓은 소파)의 _uid. 자리로 들어오는 길은 이 가구들을 뺀 격자로 본다 —
 *  소파 둘을 붙이면 옆 소파의 통행 여유가 안쪽 자리 앞 칸을 막아 앉을 수 없었다(2026-10-16 사용자 보고). */
export function seatFurniture<T extends { _uid: string; type: string }>(items: T[], uid: string, bounds: (it: T) => Rect): Set<string> {
  const out = new Set([uid]);
  const self = items.find((it) => it._uid === uid);
  if (!self) return out;
  const a = bounds(self);
  for (const it of items) {
    if (it._uid === uid || it.type !== self.type) continue;
    const b = bounds(it);
    // 1 픽셀까지는 맞닿은 것으로 본다(모서리 좌표가 정수가 아닐 수 있다)
    if (b.x <= a.x + a.w + 1 && a.x <= b.x + b.w + 1 && b.y <= a.y + a.h + 1 && a.y <= b.y + b.h + 1) out.add(it._uid);
  }
  return out;
}

/** 오피스 바닥 안으로 당긴다(바닥 밖은 장면 격자에서 빈 칸이라 걸어 나갈 수 있었다). */
export function clampToOffice(x: number, y: number, width: number, height: number, margin: number): Pt {
  return { x: Math.min(width - margin, Math.max(margin, x)), y: Math.min(height - margin, Math.max(margin, y)) };
}

const SPREAD_GAP = 30; // 이름표 상자(0.82)가 겹치지 않을 만큼 떨어뜨리는 거리, 격자 한 칸(25)보다 조금 크다
const SPREAD_RINGS = [SPREAD_GAP, SPREAD_GAP * 2, SPREAD_GAP * 3];

/** 이미 다른 사람이 선 자리면 옆의 빈 곳으로 옮긴다. 두 사람이 같은 시작 칸에 서면 몸과 이름표가 겹쳐 글자가 뭉개졌다.
 *  가까운 쪽부터 살피고, 마땅한 곳이 없으면 원래 자리를 돌려준다. */
export function spreadFrom(p: Pt, others: Pt[], isFree: IsFree): Pt {
  const clear = (q: Pt) => isFree(q.x, q.y) && others.every((o) => Math.hypot(o.x - q.x, o.y - q.y) >= SPREAD_GAP);
  if (clear(p)) return p;
  for (const r of SPREAD_RINGS) {
    for (let deg = 0; deg < 360; deg += 45) {
      const a = (deg * Math.PI) / 180;
      const q = { x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r };
      if (clear(q)) return q;
    }
  }
  return p;
}
