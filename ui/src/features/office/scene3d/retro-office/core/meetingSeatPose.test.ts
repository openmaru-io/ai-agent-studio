/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 사용자 보고(2026-10-26, 회의 중 화면): 에이전트가 책상 위에 있거나 의자에 바른 자세로 앉아 있지 않다. 회의 자리 점이 의자 가운데에서
// 「모든 의자의 가운데」 반대쪽으로 14 당긴 점이라 탁자 끝 의자에서는 의자 옆으로 벗어났고, 방향도 그 가운데를 봐 끝 의자일수록 비스듬했다.
// 사용자: 큰 회의실(팀 회의실 3개)은 10명, 작은 회의실(TFT 회의실)은 6명까지 앉는다.

import { describe, expect, it } from "vitest";

import { buildAasKoreanOffice } from "./aasKoreanOffice";
import { getItemBounds } from "./geometry";
import { astar, buildNavGrid, getMeetingSeatLocations, ROAM_POINTS } from "./navigation";

const items = buildAasKoreanOffice();
const grid = buildNavGrid(items);
const rooms = items.filter((i) => i.type === "room");

describe("회의 자리(getMeetingSeatLocations, 스펙 2026-10-26-009)", () => {
  it("팀 회의실은 10자리, TFT 회의실은 6자리다", () => {
    for (const r of rooms) {
      const n = getMeetingSeatLocations(items, getItemBounds(r)).length;
      expect(n, r.label).toBe(r.kind === "team" ? 10 : 6);
    }
  });

  for (const r of rooms) {
    it(`${r.label}: 자리 점은 의자 가운데이고, 의자 정면(탁자 쪽)을 본다`, () => {
      const rb = getItemBounds(r);
      const table = items.map((i) => ({ i, b: getItemBounds(i) })).find(({ i, b }) => i.type === "table_rect" && b.x > rb.x && b.x < rb.x + rb.w && b.y > rb.y && b.y < rb.y + rb.h)!.b;
      const chairs = items.filter((i) => i.type === "chair" && i.x >= rb.x && i.x <= rb.x + rb.w && i.y >= rb.y && i.y <= rb.y + rb.h);
      const seats = getMeetingSeatLocations(items, rb);
      for (const s of seats) {
        const c = chairs.map(getItemBounds).find((b) => Math.abs(b.x + b.w / 2 - s.x) < 0.5 && Math.abs(b.y + b.h / 2 - s.y) < 0.5);
        expect(c, `(${s.x}, ${s.y}) 가 의자 가운데`).toBeDefined();
        // 보는 방향(atan2(dx, dy))이 탁자 긴 변에 수직이고 탁자 쪽이다
        const look = { x: Math.sin(s.facing), y: Math.cos(s.facing) };
        expect(Math.abs(look.x), `(${s.x}, ${s.y}) 정면`).toBeLessThan(1e-6);
        expect(Math.sign(look.y), `(${s.x}, ${s.y}) 탁자 쪽`).toBe(Math.sign(table.y + table.h / 2 - s.y));
      }
    });
  }

  it("업무 구역에서 모든 회의 자리까지 길이 있고 길 끝이 그 자리다", () => {
    const from = ROAM_POINTS[0];
    for (const r of rooms) {
      for (const s of getMeetingSeatLocations(items, getItemBounds(r))) {
        const path = astar(from.x, from.y, s.x, s.y, grid);
        expect(path.length, `${r.label} (${s.x}, ${s.y})`).toBeGreaterThan(0);
        expect(path.at(-1), `${r.label} (${s.x}, ${s.y})`).toEqual({ x: s.x, y: s.y });
      }
    }
  });
});
