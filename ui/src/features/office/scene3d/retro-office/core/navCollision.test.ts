/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 에이전트가 가구를 통과해 걷지 않는다(사용자 보고 2026-10-13: 휴게 공간 탁자·의자를 지나 다님).
// 한국 사무실 배치에서 여러 출발점→목표의 astar 경로를 만들고, 각 구간이 길을 막는 가구의 몸체(통행 여유를 뺀 상자)를
// 지나는지 본다. 출발점·목표가 들어 있는 가구(앉는 소파 등)는 그 끝 구간에서만 봐준다.

import { describe, expect, it } from "vitest";

import { buildAasKoreanOffice } from "./aasKoreanOffice";
import { getItemBounds, ITEM_METADATA } from "./geometry";
import {
  astar,
  awayTargetOf,
  buildNavGrid,
  deskSeatOf,
  getMeetingSeatLocations,
  isNavFree,
  ROAM_POINTS,
  socialTargetsOf,
} from "./navigation";

type Pt = { x: number; y: number };

const items = buildAasKoreanOffice();
const grid = buildNavGrid(items);
// 의자(softBlock)는 아래 별도 시험에서 본다 — 회의실 윗줄 의자는 이웃 의자를 지나야 닿는 배치라 이 시험의 「끝 구간만 봐준다」 규칙에 맞지 않는다
const solids = items
  .filter((i) => ITEM_METADATA[i.type]?.blocksNavigation && !ITEM_METADATA[i.type]?.softBlock)
  .map((i) => ({ item: i, b: getItemBounds(i) }));

const inside = (b: { x: number; y: number; w: number; h: number }, p: Pt, grow = 0) =>
  p.x > b.x - grow && p.x < b.x + b.w + grow && p.y > b.y - grow && p.y < b.y + b.h + grow;

/** 경로가 지나간 가구 몸체. 첫 구간은 출발점을, 마지막 구간은 목표를 품은 가구를 봐준다. */
function crossings(from: Pt, to: Pt, path: Pt[], boxes: { item: (typeof items)[number]; b: ReturnType<typeof getItemBounds> }[] = solids): string[] {
  const pts = [from, ...path];
  const hits = new Set<string>();
  for (let k = 0; k + 1 < pts.length; k += 1) {
    const a = pts[k];
    const b = pts[k + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(len / 3));
    for (let s = 0; s <= steps; s += 1) {
      const p = { x: a.x + ((b.x - a.x) * s) / steps, y: a.y + ((b.y - a.y) * s) / steps };
      for (const { item, b: box } of boxes) {
        if (!inside(box, p, -1)) continue;
        // 출발점·목표가 앉은 자기 의자는 어느 구간에서든 봐준다(앉고 일어서는 걸음). 의자 자리 점은 상자 2 바깥에 놓인다
        if (item.type === "chair" && (inside(box, from, 7) || inside(box, to, 7))) continue;
        if (k === 0 && inside(box, from, 1)) continue;
        if (k === pts.length - 2 && inside(box, to, 1)) continue;
        hits.add(`${item.type}@${Math.round(box.x)},${Math.round(box.y)}`);
      }
    }
  }
  return [...hits];
}

const rooms = items.filter((i) => i.type === "room");
const deskSeats = items.filter((i) => i.type === "desk_cubicle").map(deskSeatOf);
const meetingSeats = rooms.flatMap((r) => getMeetingSeatLocations(items, getItemBounds(r)));
const social = items.filter((i) => ["couch", "couch_v", "beanbag", "coffee_machine", "water_cooler"].includes(i.type));
const away = social.filter((i) => ["couch", "couch_v", "beanbag"].includes(i.type));

const starts: Pt[] = [...ROAM_POINTS, ...deskSeats.filter((_, n) => n % 4 === 0), ...meetingSeats.filter((_, n) => n % 4 === 0)];

function check(targets: Pt[], boxes = solids) {
  const bad: string[] = [];
  for (const s of starts) {
    for (const t of targets) {
      const path = astar(s.x, s.y, t.x, t.y, grid);
      if (!path.length) continue;
      const hit = crossings(s, t, path, boxes);
      if (hit.length) bad.push(`(${Math.round(s.x)},${Math.round(s.y)})→(${Math.round(t.x)},${Math.round(t.y)}): ${hit.join(" ")}`);
    }
  }
  return bad;
}

describe("에이전트 경로가 가구를 통과하지 않는다", () => {
  it("휴게 공간 소파·탕비 집기 옆으로 가는 길(socialTargetsOf)은 가구 바깥에서 끝나고 가구를 지나지 않는다", () => {
    const targets = social.flatMap((f) => socialTargetsOf(f, (x, y) => isNavFree(grid, x, y)));
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) {
      for (const { b } of solids) expect(inside(b, t), `목표 (${t.x},${t.y}) 가 가구 안`).toBe(false);
    }
    expect(check(targets).slice(0, 5)).toEqual([]);
  });

  it("소파에 앉으러 가는 길(awayTargetOf)은 다른 가구를 지나지 않는다", () => {
    expect(check(away.map(awayTargetOf)).slice(0, 5)).toEqual([]);
  });

  it("책상 자리·회의 의자·배회 지점으로 가는 길은 가구를 지나지 않는다", () => {
    expect(check([...deskSeats, ...meetingSeats, ...ROAM_POINTS]).slice(0, 5)).toEqual([]);
  });

  // 사용자 보고 2026-10-16: 각 섹션 팀장 자리 의자를 캐릭터가 통과해 지나간다. 의자는 blocksNavigation 이 false 라 길이 의자를 지났다.
  // 자기 자리(출발·목표를 품은 의자)는 봐준다 — 앉으러 가는 마지막 걸음은 의자 안으로 들어간다.
  it("책상 자리·회의 의자·배회 지점으로 가는 길은 다른 사람의 의자를 지나지 않는다(팀장 의자 포함)", () => {
    const chairs = items.filter((i) => i.type === "chair").map((item) => ({ item, b: getItemBounds(item) }));
    expect(chairs.length).toBeGreaterThan(0);
    // 회의실 윗줄은 벽과 탁자 사이 한 칸 폭 통로에 의자가 빈틈없이 붙어 있어 이웃 의자를 지나야 한다(astar 의 되돌림 길). 책상 자리·배회 지점만 본다
    const walkers = [...ROAM_POINTS, ...deskSeats];
    const bad: string[] = [];
    for (const s of walkers) {
      for (const t of [...deskSeats, ...ROAM_POINTS]) {
        const path = astar(s.x, s.y, t.x, t.y, grid);
        const hit = path.length ? crossings(s, t, path, chairs) : [];
        if (hit.length) bad.push(`(${Math.round(s.x)},${Math.round(s.y)})→(${Math.round(t.x)},${Math.round(t.y)}): ${hit.join(" ")}`);
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it("의자를 길로 막아도 책상 자리·회의 의자·배회 지점 사이에 갈 수 없게 되는 쌍이 없다", () => {
    const targets = [...deskSeats, ...meetingSeats, ...ROAM_POINTS];
    const unreachable: string[] = [];
    for (const s of starts) {
      for (const t of targets) {
        if (!astar(s.x, s.y, t.x, t.y, grid).length) unreachable.push(`(${Math.round(s.x)},${Math.round(s.y)})→(${Math.round(t.x)},${Math.round(t.y)})`);
      }
    }
    expect(unreachable.slice(0, 5)).toEqual([]);
  });
});
