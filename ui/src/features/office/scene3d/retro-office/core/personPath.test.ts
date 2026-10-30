/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";

import { astar, buildNavGrid } from "./navigation";
import { approachPoint, clampToOffice, detour, gridAround, PASS_GAP, planRoute, spreadFrom } from "./personPath";
import type { FurnitureItem } from "./types";

// 가운데 책상(x 100~200, y 100~160)만 막힌 바닥
const blocked = (x: number, y: number) => x >= 100 && x <= 200 && y >= 100 && y <= 160;
const isFree = (x: number, y: number) => !blocked(x, y);
const straight = (fx: number, fy: number, tx: number, ty: number) => [{ x: (fx + tx) / 2, y: (fy + ty) / 2 }, { x: tx, y: ty }];

describe("approachPoint", () => {
  it("들어오는 쪽의 빈 칸을 고른다", () => {
    const p = approachPoint({ x: 150, y: 95, out: { x: 0, y: -1 } }, isFree)!;
    expect(p.y).toBeLessThan(95);
    expect(isFree(p.x, p.y)).toBe(true);
  });

  it("들어오는 쪽이 막혔으면 옆의 빈 칸을 고른다(책상을 가로지르지 않는다)", () => {
    const p = approachPoint({ x: 150, y: 165, out: { x: 0, y: -1 } }, isFree)!;    // 위쪽은 책상
    expect(isFree(p.x, p.y)).toBe(true);
    expect(p.y).toBeGreaterThan(160);
  });
});

describe("벽에 붙은 소파", () => {
  // 방 서쪽 벽(x 255~270)에 소파(x 270~310, y 90~170)가 붙어 있다. 벽 바깥(x<255)도 빈 칸이다
  const wall = (x: number, y: number) => x >= 255 && x <= 270 && y >= 30 && y <= 280;
  const couch = { x: 270, y: 90, w: 40, h: 80 };
  const inCouch = (x: number, y: number) => x >= couch.x && x <= couch.x + couch.w && y >= couch.y && y <= couch.y + couch.h;
  const free = (x: number, y: number) => !wall(x, y) && !inCouch(x, y);

  it("벽을 지나는 칸은 고르지 않는다(앞쪽 추정이 벽을 가리켜도)", () => {
    const p = approachPoint({ x: 290, y: 130, out: { x: -1, y: 0 } }, free, (x, y) => !wall(x, y)); // 소파만 뺀 격자
    expect(p).not.toBeNull();
    expect(p!.x).toBeGreaterThan(270);                                              // 방 안
  });

  it("들어올 칸이 없으면 앉지 않는다", () => {
    expect(approachPoint({ x: 290, y: 130, out: { x: -1, y: 0 } }, () => false)).toBeNull();
  });
});

describe("planRoute", () => {
  it("자리에 앉으러 갈 때는 들어오는 칸까지 걷고 마지막에만 자리로 들어간다", () => {
    const seat = { x: 150, y: 95, out: { x: 0, y: -1 } };
    const path = planRoute({ x: 150, y: 300 }, null, seat, approachPoint(seat, isFree), isFree, straight);
    const approach = path[path.length - 2];
    expect(path[path.length - 1]).toEqual({ x: 150, y: 95 });
    expect(approach.y).toBeLessThan(95);                                           // 책상 반대편(위)에서 들어간다
  });

  it("앉아 있다가 일어나면 들어온 칸으로 먼저 나간다", () => {
    const path = planRoute({ x: 150, y: 95 }, { x: 150, y: 60 }, { x: 400, y: 400 }, null, isFree, straight);
    expect(path[0]).toEqual({ x: 150, y: 60 });
  });

  it("막힌 곳을 누르면 그 옆 빈 칸까지만 간다", () => {
    const path = planRoute({ x: 0, y: 0 }, null, { x: 150, y: 130 }, null, isFree, straight);
    const end = path[path.length - 1];
    expect(isFree(end.x, end.y)).toBe(true);
  });
});

describe("clampToOffice", () => {
  it("오피스 바닥 밖은 안쪽으로 당긴다", () => {
    expect(clampToOffice(2000, 1500, 1800, 1080, 30)).toEqual({ x: 1770, y: 1050 });
    expect(clampToOffice(-5, 500, 1800, 1080, 30)).toEqual({ x: 30, y: 500 });
  });
});

describe("실제 배치: 벽 방 안 소파(Image #12)", () => {
  // 로컬 판 1 의 왼쪽 위 방(벽 4개·문 1개)과 서쪽 벽에 붙은 소파. 소파의 앞쪽 추정(out)은 벽 쪽(서쪽)이다
  const items = [
    { _uid: "w1", type: "wall", x: 260, y: 40, w: 8, h: 230 },
    { _uid: "w2", type: "wall", x: 260, y: 40, w: 178, h: 8 },
    { _uid: "w3", type: "wall", x: 260, y: 262, w: 178, h: 8 },
    { _uid: "w4", type: "wall", x: 430, y: 40, w: 8, h: 90 },
    { _uid: "door", type: "door", x: 420, y: 150, w: 40, h: 8, facing: 90 },
    { _uid: "w5", type: "wall", x: 430, y: 170, w: 8, h: 100 },
    { _uid: "sofa", type: "couch", x: 270, y: 90, w: 40, h: 80, vertical: true, facing: 180 },
  ] as FurnitureItem[];
  const walls = items.filter((i) => i.type === "wall");
  const inWall = (x: number, y: number) => walls.some((w) => x >= w.x && x <= w.x + (w.w ?? 0) && y >= w.y && y <= w.y + (w.h ?? 0));
  const cellFree = (g: Uint8Array) => (x: number, y: number) => !g[Math.floor(y / 25) * Math.ceil(1800 / 25) + Math.floor(x / 25)];

  it("방 밖에서 소파로 가는 길이 없으면 벽을 뚫지 않고 움직이지 않는다", () => {
    const grid = buildNavGrid(items);
    const without = buildNavGrid(items.filter((i) => i._uid !== "sofa"));
    const seat = { x: 290, y: 130, out: { x: -1, y: 0 } };
    const ap = approachPoint(seat, cellFree(grid), cellFree(without));
    expect(ap).not.toBeNull();
    const path = planRoute({ x: 150, y: 400 }, null, seat, ap, cellFree(grid), (fx, fy, tx, ty) => astar(fx, fy, tx, ty, grid));
    const pts = [{ x: 150, y: 400 }, ...path];
    for (let i = 1; i < pts.length; i += 1) {
      for (let t = 0; t <= 1; t += 0.05) {
        const x = pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t;
        const y = pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t;
        expect(inWall(x, y), `구간 ${i} (${Math.round(x)},${Math.round(y)})`).toBe(false);
      }
    }
    // 이 방은 문 틈(40)에서 양쪽 벽 여유(15씩)를 빼면 10 이라 25 격자로는 닫혀 있다 — 길이 없으니 움직이지 않는다
    expect(path).toEqual([]);
  });

  it("방 안에서는 소파에 앉는다(마지막 구간만 자리로)", () => {
    const grid = buildNavGrid(items);
    const without = buildNavGrid(items.filter((i) => i._uid !== "sofa"));
    const seat = { x: 290, y: 130, out: { x: -1, y: 0 } };
    const ap = approachPoint(seat, cellFree(grid), cellFree(without))!;
    const path = planRoute({ x: 380, y: 220 }, null, seat, ap, cellFree(grid), (fx, fy, tx, ty) => astar(fx, fy, tx, ty, grid));
    const pts = [{ x: 380, y: 220 }, ...path];
    for (let i = 1; i < pts.length; i += 1)
      for (let t = 0; t <= 1; t += 0.05)
        expect(inWall(pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t)).toBe(false);
    expect(pts[pts.length - 1]).toEqual({ x: 290, y: 130 });
  });
});

describe("spreadFrom", () => {
  const GAP = 30;
  const apart = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

  it("가까운 사람이 없으면 그 자리 그대로", () => {
    expect(spreadFrom({ x: 20, y: 20 }, [{ x: 300, y: 300 }], isFree)).toEqual({ x: 20, y: 20 });
  });

  it("다른 사람이 같은 자리에 서 있으면 이름표가 겹치지 않게 옆 빈 곳으로 옮긴다", () => {
    const others = [{ x: 20, y: 20 }];
    const p = spreadFrom({ x: 20, y: 20 }, others, isFree);
    expect(apart(p, others[0])).toBeGreaterThanOrEqual(GAP);
    expect(isFree(p.x, p.y)).toBe(true);
  });

  it("먼저 온 사람이 여럿이어도 모두와 떨어진 곳을 고른다", () => {
    const others = [{ x: 20, y: 20 }, { x: 55, y: 20 }, { x: 20, y: 55 }];
    const p = spreadFrom({ x: 20, y: 20 }, others, isFree);
    for (const o of others) expect(apart(p, o)).toBeGreaterThanOrEqual(GAP);
  });

  it("옆이 막혀 있으면 막히지 않은 곳만 고른다", () => {
    const p = spreadFrom({ x: 150, y: 95 }, [{ x: 150, y: 95 }], isFree);
    expect(isFree(p.x, p.y)).toBe(true);
  });
});

describe("detour", () => {
  // 장애물 둘레를 돌아가는 가짜 길 찾기: 막은 캐릭터가 있으면 그 위(y-60)로 꺾어 간다
  const around = (fx: number, fy: number, tx: number, ty: number, blockers: { x: number; y: number }[]) =>
    blockers.length ? [{ x: fx, y: fy - 60 }, { x: tx, y: ty - 60 }, { x: tx, y: ty }] : [{ x: tx, y: ty }];
  const path = [{ x: 100, y: 0 }, { x: 200, y: 0 }, { x: 300, y: 0 }];

  it("앞길에 캐릭터가 없으면 null — 길을 그대로 간다", () => {
    expect(detour({ x: 0, y: 0 }, path, [{ x: 50, y: 200 }], around)).toBeNull();
  });

  it("앞길을 막은 캐릭터가 있으면 그를 지난 경유점까지 돌아가는 길을 내고 나머지 길을 잇는다", () => {
    const next = detour({ x: 0, y: 0 }, path, [{ x: 40, y: 3 }], around)!;
    expect(next.length).toBeGreaterThan(0);
    // 막은 캐릭터 곁(30 안)을 지나지 않는다
    expect(next.every((p) => Math.hypot(p.x - 40, p.y - 3) >= 30)).toBe(true);
    expect(next[next.length - 1]).toEqual({ x: 300, y: 0 });
  });

  it("뒤에 있거나 멀리 앞(살피는 거리 밖)에 있는 캐릭터는 보지 않는다", () => {
    expect(detour({ x: 0, y: 0 }, path, [{ x: -15, y: 0 }], around)).toBeNull();
    expect(detour({ x: 0, y: 0 }, path, [{ x: 250, y: 0 }], around)).toBeNull();
  });

  it("목적지에 캐릭터가 서 있어 지날 경유점이 없으면 빈 길 — 멈춰 기다린다", () => {
    expect(detour({ x: 260, y: 0 }, [{ x: 300, y: 0 }], [{ x: 295, y: 0 }], around)).toEqual([]);
  });
});

describe("detour: 실제 길 찾기 격자", () => {
  it("빈 바닥에서 길 한가운데 선 캐릭터를 비켜 돌아가고 목적지에 닿는다", () => {
    const grid = buildNavGrid([]);
    const me = { x: 112, y: 312 };
    const path = astar(me.x, me.y, 512, 312, grid);
    const blocker = { x: 312, y: 312 };
    // 고치기 전: 고정 격자 길이 캐릭터를 그대로 지난다
    expect(path.some((p) => Math.hypot(p.x - blocker.x, p.y - blocker.y) < PASS_GAP)).toBe(true);
    // 앞에 다가갔을 때(살피는 거리 안) 돌아가는 길
    const near = { x: 262, y: 312 };
    const rest = astar(near.x, near.y, 512, 312, grid);
    const next = detour(near, rest, [blocker], (fx, fy, tx, ty, bl) => astar(fx, fy, tx, ty, gridAround(grid, bl, 72, 25)))!;
    expect(next.length).toBeGreaterThan(0);
    const pts = [near, ...next];
    for (let i = 1; i < pts.length; i += 1)
      for (let t = 0; t <= 1; t += 0.05) {
        const x = pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t;
        const y = pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t;
        expect(Math.hypot(x - blocker.x, y - blocker.y), `구간 ${i} (${Math.round(x)},${Math.round(y)})`).toBeGreaterThanOrEqual(PASS_GAP - 1);
      }
    expect(pts[pts.length - 1]).toEqual({ x: 512, y: 312 });
  });
});
