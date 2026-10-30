/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AAS_LAYOUT_PRESET, buildAasKoreanOffice, northRoomWallCenters, southLoungePictureX } from "./aasKoreanOffice";
import { getItemBounds } from "./geometry";
import { astar, buildNavGrid, deskSeatOf, getDeskLocations, ROAM_POINTS } from "./navigation";

const items = buildAasKoreanOffice();
const COLS = Math.ceil(1800 / 25);
const grid = buildNavGrid(items);
const free = (x: number, y: number) => !grid[Math.floor(y / 25) * COLS + Math.floor(x / 25)];
const ENTRANCE = { x: 910, y: 1000 }; // 입구 안쪽
const reach = (x: number, y: number) => {
  const p = astar(ENTRANCE.x, ENTRANCE.y, x, y, grid);
  return p.length > 0;
};

describe("한국 사무실 기본 배치", () => {
  it("판본 이름과 uid 가 정해져 있다(서버 자동 적용의 기준)", () => {
    expect(AAS_LAYOUT_PRESET).toBe("kr-21");
    expect(new Set(items.map((i) => i._uid)).size).toBe(items.length);
    expect(items.every((i) => i._uid.startsWith("kr_"))).toBe(true);
  });

  it("에이전트 책상 36석과 팀장석 6석, 구역 1~6 에 6석씩", () => {
    const desks = items.filter((i) => i.type === "desk_cubicle");
    expect(desks.filter((d) => !d.lead)).toHaveLength(36);
    expect(desks.filter((d) => d.lead)).toHaveLength(6);
    for (let z = 1; z <= 6; z += 1) expect(desks.filter((d) => !d.lead && d.zone === z)).toHaveLength(6);
  });

  it("없앨 것이 없다(ATM·서버실·QA 실험실·문자 부스·주크박스·탁구대)", () => {
    const banned = ["atm", "server_rack", "server_terminal", "qa_terminal", "device_rack", "test_bench", "sms_booth", "jukebox", "pingpong"];
    expect(items.filter((i) => banned.includes(i.type)).map((i) => i.type)).toEqual([]);
  });

  // kr-21: 북쪽을 3등분해 10석 팀 회의실 3개로, 대회의실은 없앤다. 북쪽 방 깊이는 TFT 회의실 한 칸과 같은 240
  it("방은 팀 회의실 3(구역 1·2·3, 10석, 북쪽 0~1320 을 3등분)·TFT 회의실 3, 대회의실 없음", () => {
    const rooms = items.filter((i) => i.type === "room");
    expect(rooms.filter((r) => r.kind === "meeting")).toEqual([]);
    const team = rooms.filter((r) => r.kind === "team");
    expect(team.map((r) => r.zone)).toEqual([1, 2, 3]);
    expect(rooms.filter((r) => r.kind === "tft")).toHaveLength(3);
    // 방 경계가 0·440·880·1320 이고(방 항목은 서쪽 벽 두께 8 을 뺀 안쪽), 깊이 240 은 TFT 회의실 한 칸과 같다
    expect(team.map((r) => [r.x - 8, r.x + r.w!])).toEqual([[0, 440], [440, 880], [880, 1320]]);
    const tft = rooms.filter((r) => r.kind === "tft").map(getItemBounds);
    for (const r of team) expect(r.h, r.label).toBe(240);
    expect(tft[0].y + tft[0].h).toBe(240);
    for (const r of team) {
      const chairs = items.filter((i) => i.type === "chair" && i.x > r.x && i.x < r.x + r.w! && i.y < r.h!);
      expect(chairs, r.label).toHaveLength(10);
    }
  });

  it("벽 액자 자리는 북쪽 회의실마다 하나, 방 가운데다(OMAI-1510)", () => {
    const team = items.filter((i) => i.type === "room" && i.kind === "team");
    expect(northRoomWallCenters()).toEqual(team.map((r) => r.x + r.w! / 2));
  });

  it("북쪽 벽 액자는 회의실 수만큼, northRoomWallCenters 자리에만 건다(OMAI-1510)", () => {
    // 옛 배치(대회의실 + 팀 회의실 4)의 고정 좌표 다섯 개(180·480·720·960·1200)가 kr-21 에서 방 가운데를 벗어나고 한 방에 둘씩 걸렸다
    const src = readFileSync(join(__dirname, "../scene/environment.tsx"), "utf8");
    const north = [...src.matchAll(/position=\{\[(.+?), pictureY, northZ\]\}/g)].map((m) => m[1].trim());
    expect(north).toEqual(["px(wallCenters[0])", "px(wallCenters[1])", "px(wallCenters[2])"]);
    expect(northRoomWallCenters()).toHaveLength(3);
  });

  it("출입문 옆 액자는 휴게 소파와 알림판 사이 벽 가운데다", () => {
    const south = items.filter((i) => { const b = getItemBounds(i); return i.type !== "boundary" && b.y + b.h > 1040; });
    const sofaRight = Math.max(...south.filter((i) => i.type === "couch").map((i) => getItemBounds(i).x + getItemBounds(i).w));
    const board = getItemBounds(south.find((i) => i.type === "notice_board")!);
    const x = southLoungePictureX();
    expect(x).toBe((sofaRight + board.x) / 2);
    // 액자 폭(0.55, 장면 30.6) 안에 다른 남쪽 벽 물건이 없다(옷걸이·화분·선인장을 피한다)
    const half = 0.55 / 0.018 / 2;
    const hits = south.filter((i) => { const b = getItemBounds(i); return b.x < x + half && b.x + b.w > x - half && i.type !== "rug"; });
    expect(hits.map((i) => i.type)).toEqual([]);
    const src = readFileSync(join(__dirname, "../scene/environment.tsx"), "utf8");
    expect(src).toContain("position={[px(southPictureX), pictureY, southZ]}");
    expect(src).not.toContain("px(830)");
  });

  it("유리문(회의실 6·탕비실 1)은 65 이고 가운데가 격자 칸(25) 가운데다, 입구(나무문)는 100(kr-15)", () => {
    const doors = items.filter((i) => i.type === "door");
    const glass = doors.filter((d) => d.glass);
    expect(glass).toHaveLength(7); // 팀 회의실 3·TFT 회의실 3·탕비실 1(kr-21 부터 대회의실 없음)
    for (const d of glass) {
      expect(d.w, d._uid).toBe(65);
      const b = getItemBounds(d);
      const along = d.facing === 90 ? b.y + b.h / 2 : b.x + b.w / 2;
      expect(along % 25, d._uid).toBe(12.5);
    }
    expect(doors.filter((d) => !d.glass).map((d) => d.w)).toEqual([100]);
  });

  it("입구에서 모든 방·책상 자리·회의 의자에 닿는다(닫힌 방이 없다)", () => {
    for (const r of items.filter((i) => i.type === "room")) {
      // 방 가운데는 탁자라 막혀 있다. 방 안의 빈 칸 하나에 닿으면 닫힌 방이 아니다
      const cells: [number, number][] = [];
      for (let y = r.y + 12; y < r.y + (r.h ?? 0); y += 25) for (let x = r.x + 12; x < r.x + (r.w ?? 0); x += 25) if (free(x, y)) cells.push([x, y]);
      expect(cells.some(([x, y]) => reach(x, y)), `${r.label}`).toBe(true);
    }
    for (const seat of getDeskLocations(items)) expect(reach(seat.x, seat.y), `책상 ${seat.x},${seat.y}`).toBe(true);
    const rooms = items.filter((i) => i.type === "room");
    for (const c of items.filter((i) => i.type === "chair")) {
      const inRoom = rooms.some((r) => c.x >= r.x && c.x <= r.x + (r.w ?? 0) && c.y >= r.y && c.y <= r.y + (r.h ?? 0));
      if (inRoom) expect(reach(c.x + 12, c.y + 12), `회의 의자 ${c._uid}`).toBe(true);
    }
  });

  it("책상 자리는 책상 바깥쪽 의자 위다 — 칸막이 쪽이 아니다(O1)", () => {
    const desks = items.filter((i) => i.type === "desk_cubicle");
    const chairs = items.filter((i) => i.type === "chair");
    for (const d of desks) {
      const seat = deskSeatOf(d);
      const cx = d.x + d.w! / 2;
      const cy = d.y + d.h! / 2;
      const want = { 90: [1, 0], 270: [-1, 0], 180: [0, -1], 0: [0, 1] }[d.facing ?? 0]!;
      expect(Math.sign(Math.round(seat.x - cx)), `${d._uid} x`).toBe(want[0]);
      expect(Math.sign(Math.round(seat.y - cy)), `${d._uid} y`).toBe(want[1]);
      expect(chairs.some((c) => Math.hypot(c.x + 12 - seat.x, c.y + 12 - seat.y) < 2), `${d._uid} 의자`).toBe(true);
    }
  });

  it("섬마다 가운데 세로 칸막이에 양쪽 책상 3개씩이 맞닿는다", () => {
    const parts = items.filter((i) => i.type === "partition" && (i.h ?? 0) > (i.w ?? 0));
    expect(parts).toHaveLength(6);
    for (const p of parts) {
      const beside = (i: (typeof items)[number]) => i.y + i.h! / 2 > p.y && i.y + i.h! / 2 < p.y + p.h!;
      const west = items.filter((i) => i.type === "desk_cubicle" && beside(i) && i.facing === 270 && Math.abs(i.x + i.w! / 2 + i.h! / 2 - p.x) < 0.01);
      const east = items.filter((i) => i.type === "desk_cubicle" && beside(i) && i.facing === 90 && Math.abs(i.x + i.w! / 2 - i.h! / 2 - (p.x + p.w!)) < 0.01);
      expect([west.length, east.length]).toEqual([3, 3]);
    }
  });

  it("탕비실(남동쪽)의 의자에 입구에서 닿고, 집기는 남쪽 벽(1080)에 붙어 있다", () => {
    const kitchen = items.filter((i) => i.x >= 1520 && i.y >= 728 && i.y < 1080);
    for (const c of kitchen.filter((i) => i.type === "chair")) expect(reach(c.x + 12, c.y + 12), `탕비실 의자 ${c._uid}`).toBe(true);
    for (const t of ["cabinet", "sink", "water_cooler", "locker", "file_cabinet", "printer"]) { // 전화 부스는 외벽 안쪽 면에 붙인다(aasWallFit.test.ts)
      for (const it of items.filter((i) => i.type === t)) {
        const b = getItemBounds(it);
        expect(b.y + b.h, `${t} ${it._uid}`).toBeCloseTo(1080, 0);
      }
    }
  });

  it("칸반 보드는 하나이고 서쪽 벽에 거는 판이다(ㄴ자 책상 모델이 아니다, kr-4)", () => {
    // 남쪽 벽에 걸면 남쪽에서 보는 기본 카메라에서 벽에 가려 보이지 않았다
    const boards = items.filter((i) => i.type === "kanban_board");
    expect(boards).toHaveLength(1);
    expect(boards[0].wall).toBe(true);
    expect(boards[0].facing).toBe(90);
    const b = getItemBounds(boards[0]);
    expect(b.x).toBeCloseTo(0, 0);
    expect(b.w).toBeLessThan(7); // 얇은 판(깊이 6)
  });

  it("회의실마다 프로젝터 스크린 하나를 같은 기준으로 건다: 너비 150, 벽에 붙고, 탁자 가운데 줄에 맞춘다(kr-5)", () => {
    const inside = (i: (typeof items)[number], r: (typeof items)[number]) => {
      const cx = i.x + (i.w ?? 0) / 2;
      const cy = i.y + (i.h ?? 0) / 2;
      return cx >= r.x - 8 && cx <= r.x + (r.w ?? 0) + 8 && cy >= r.y && cy <= r.y + (r.h ?? 0);
    };
    const walls = items.filter((i) => i.type === "wall" || i.type === "glass_wall");
    for (const r of items.filter((i) => i.type === "room")) {
      const screens = items.filter((i) => i.type === "tv_meeting" && inside(i, r));
      const table = items.find((i) => i.type === "table_rect" && inside(i, r))!;
      expect(screens, `${r.label}`).toHaveLength(1);
      const sc = screens[0];
      const b = getItemBounds(sc);
      expect([sc.w, Math.round(b.w), Math.round(b.h)], `${r.label} 크기`).toEqual([150, 6, 150]);
      expect(b.y + b.h / 2, `${r.label} 탁자 줄`).toBeCloseTo(table.y + table.h! / 2, 5);
      // 벽 면에 붙는다: 바깥 벽(x 0·1800)이거나 벽 항목의 안쪽 면
      const face = Math.round(sc.facing === 90 ? b.x : b.x + b.w);
      const onWall = face === 0 || face === 1800 || walls.some((w) => w.x + (w.w ?? 0) === face || w.x === face);
      expect(onWall, `${r.label} 벽`).toBe(true);
      // 화면이 탁자를 마주 본다
      const tcx = table.x + table.w! / 2;
      expect(sc.facing === 90 ? tcx > b.x : tcx < b.x, `${r.label} 방향`).toBe(true);
    }
  });

  it("kr-7·8: 탕비실은 상판·개수대가 이어지고 냉장고는 동쪽 모서리, 작은 냉장고는 바로 옆, 문은 모두 유리문(입구 제외), 빈백·자판기 없음, 상황판은 통로 벽 가운데", () => {
    const b = (t: string) => getItemBounds(items.find((i) => i.type === t && i.x >= 1520 && i.y > 728)!);
    const [cab, sink, cool, fridge] = [b("cabinet"), b("sink"), b("water_cooler"), b("fridge")];
    for (const x of [cab, sink, cool, fridge]) expect(Math.round(x.y + x.h)).toBe(1080);
    expect(Math.round(sink.x)).toBe(Math.round(cab.x + cab.w)); // 개수대는 상판에 이어 붙는다
    expect(Math.round(fridge.x + fridge.w)).toBe(1800); // 냉장고는 동쪽 벽 모서리
    expect(fridge.x - (cool.x + cool.w)).toBeGreaterThanOrEqual(0);
    expect(fridge.x - (cool.x + cool.w)).toBeLessThanOrEqual(12); // 바로 옆
    expect(items.filter((i) => i.type === "vending" || i.type === "beanbag")).toEqual([]);
    // 전자레인지·커피 머신은 상판 윗면(0.42 × 1.2 = 0.504)에 놓인다. 전자레인지 도형은 이미 0.42 위에 그린다
    const mw = items.find((i) => i.type === "microwave")!;
    expect((mw.elevation ?? 0) + 0.42).toBeCloseTo(0.504, 5);
    expect(items.find((i) => i.type === "coffee_machine")!.elevation).toBeCloseTo(0.504, 5);
    const mwb = getItemBounds(mw);
    expect(mwb.x >= cab.x && mwb.x + mwb.w <= cab.x + cab.w).toBe(true);
    expect(Math.round(mwb.y + mwb.h)).toBe(1080); // 벽에 붙는다(kr-9)
    // 사물함·문서함·복합기는 탕비실 서쪽 벽(kr-19 부터 1520)부터 빈틈 없이 이어지고, 게시판은 소파와 입구 사이(kr-9)
    const store = items.filter((i) => ["locker", "file_cabinet", "printer"].includes(i.type)).map(getItemBounds).sort((p, q) => q.x - p.x);
    expect(Math.round(store[0].x + store[0].w)).toBe(1520);
    for (let k = 1; k < store.length; k += 1) expect(Math.round(store[k].x + store[k].w)).toBe(Math.round(store[k - 1].x));
    const nb = getItemBounds(items.find((i) => i.type === "notice_board")!);
    const sofaRight = Math.max(...items.filter((i) => i.type === "couch").map((i) => getItemBounds(i)).map((b) => b.x + b.w));
    const door = items.find((i) => i.type === "door" && i.y > 1060)!;
    expect(nb.x).toBeGreaterThan(sofaRight);
    expect(nb.x + nb.w).toBeLessThan(door.x);
    const board = items.filter((i) => i.type === "tv_status");
    expect(board).toHaveLength(1);
    const bb = getItemBounds(board[0]);
    expect(bb.x).toBeGreaterThanOrEqual(1328);
    expect(bb.x + bb.w).toBeLessThanOrEqual(1520);
    expect(Math.abs(bb.x + bb.w / 2 - 1424)).toBeLessThan(1);
    const doors = items.filter((i) => i.type === "door");
    for (const r of items.filter((i) => i.type === "room")) {
      const d = doors.find((i) => {
        const b = getItemBounds(i);
        const cx = b.x + b.w / 2;
        const cy = b.y + b.h / 2;
        return cx >= r.x - 10 && cx <= r.x + r.w! + 10 && cy >= r.y - 10 && cy <= r.y + r.h! + 10;
      });
      expect(d?.glass, `${r.label} 문`).toBe(true);
    }
    expect(doors.filter((d) => !d.glass)).toHaveLength(1); // 입구만 나무문
    const couches = items.filter((i) => i.type === "couch").map(getItemBounds);
    const left = Math.min(...couches.map((b) => b.x));
    const right = Math.max(...couches.map((b) => b.x + b.w));
    const lamp = getItemBounds(items.find((i) => i.type === "lamp")!);
    const rack = getItemBounds(items.find((i) => i.type === "coat_rack")!);
    expect(lamp.x + lamp.w).toBeLessThanOrEqual(left);
    expect(left - (lamp.x + lamp.w)).toBeLessThan(10);
    expect(rack.x).toBeGreaterThanOrEqual(right);
    expect(rack.x - right).toBeLessThan(10);
  });

  // 2026-10-26(kr-19): 탕비실 벽을 TFT 회의실 벽 줄에 맞추고, TFT 회의실 3 과의 빈 곳을 없애 벽을 함께 쓰고, 문은 회의실과 같은 방향
  it("탕비실은 TFT 회의실 서쪽 벽 줄(1520)에 맞고, TFT 회의실 3 의 남쪽 벽을 함께 쓰며, 문은 서쪽 벽의 유리문이다(kr-19)", () => {
    const walls = items.filter((i) => i.type === "wall" || i.type === "glass_wall");
    const west = walls.filter((w) => w.x === 1520 && w.w === 8);
    // 서쪽 벽 줄은 북쪽 외벽(0)부터 남쪽 외벽(1080)까지 문 틈만 빼고 이어진다: TFT 회의실 3개 + 탕비실
    const spans = west.map((w) => [w.y, w.y + w.h!] as const).sort((a, b) => a[0] - b[0]);
    expect(spans[0][0]).toBe(0);
    expect(spans.at(-1)![1]).toBe(1080);
    const doors = items.filter((i) => i.type === "door" && i.facing === 90).map(getItemBounds);
    for (let k = 1; k < spans.length; k += 1) {
      const gap = [spans[k - 1][1], spans[k][0]];
      if (gap[0] === gap[1]) continue; // 방 경계(TFT 회의실 3 → 탕비실)는 벽이 이어진다
      expect(doors.some((d) => Math.abs(d.y - gap[0]) < 1 && Math.abs(d.y + d.h - gap[1]) < 1), `문 틈 ${gap}`).toBe(true);
    }
    expect(doors).toHaveLength(4); // TFT 회의실 3 + 탕비실
    const pantryDoor = items.find((i) => i.type === "door" && i.facing === 90 && getItemBounds(i).y > 720)!;
    expect(pantryDoor.glass).toBe(true);
    // kr-20: 탕비실 서쪽 벽은 TFT 회의실 서쪽 벽처럼 유리벽이다
    expect(west.filter((w) => w.y >= 720).map((w) => w.type)).toEqual(["glass_wall", "glass_wall"]);
    // 빈 곳이 없다: TFT 회의실 3 의 남쪽 벽(y 720) 말고는 탕비실 위쪽 가로벽이 없다(kr-18 까지는 y 870)
    expect(walls.filter((w) => w.x >= 1460 && w.y > 728 && w.y < 1080 && w.h === 8)).toEqual([]);
    expect(walls.filter((w) => w.y === 720 && w.x === 1528 && w.w === 272)).toHaveLength(1);
    // 탕비실 집기·탁자·의자는 방 안(1528~1800 × 728~1080)에 있다
    for (const it of items.filter((i) => ["cabinet", "sink", "water_cooler", "fridge", "coffee_machine", "microwave", "chair", "table_rect"].includes(i.type) && i.x >= 1460 && i.y >= 720)) {
      const b = getItemBounds(it);
      expect(b.x >= 1528 && b.x + b.w <= 1800 && b.y >= 728 && b.y + b.h <= 1080.5, `${it.type} ${it._uid}`).toBe(true);
    }
  });

  it("양탄자는 휴게 공간 탁자 밑에 깔린다", () => {
    const rug = getItemBounds(items.find((i) => i.type === "rug")!);
    const table = items.filter((i) => i.type === "table_rect").map(getItemBounds).find((t) => t.y > 900 && t.x < 800)!;
    expect(table.x).toBeGreaterThanOrEqual(rug.x);
    expect(table.x + table.w).toBeLessThanOrEqual(rug.x + rug.w);
    expect(table.y).toBeGreaterThanOrEqual(rug.y);
    expect(table.y + table.h).toBeLessThanOrEqual(rug.y + rug.h);
  });

  it("바닥 밖(남쪽 1080 아래)으로 나가는 길이 없다(O8)", () => {
    expect(free(910, 1100)).toBe(false);
    expect(reach(910, 1300)).toBe(false);
  });

  // 2026-10-20: TFT 회의실 사이 가로벽이 세로 유리벽(1520~1528) 안에서 시작해 두 상자의 서쪽 면·윗면이 같은 평면이었다.
  // 같은 평면은 카메라를 움직일 때 z-fighting 으로 깜빡이고, 멈추면 벽 끝면에 유리 색이 점무늬로 남았다
  it("벽·칸막이·유리벽 상자가 서로 겹치지 않는다(겹치면 같은 평면이 생겨 깜빡인다)", () => {
    const walls = items.filter((i) => ["wall", "partition", "glass_wall"].includes(i.type));
    const overlaps: string[] = [];
    walls.forEach((a, i) =>
      walls.slice(i + 1).forEach((b) => {
        const ox = Math.min(a.x + a.w!, b.x + b.w!) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h!, b.y + b.h!) - Math.max(a.y, b.y);
        if (ox > 0 && oy > 0) overlaps.push(`${a._uid}(${a.type}) × ${b._uid}(${b.type})`);
      }),
    );
    expect(overlaps).toEqual([]);
  });

  it("에이전트 배회 지점은 열린 칸이고 입구에서 닿는다(O9)", () => {
    for (const p of ROAM_POINTS) expect(free(p.x, p.y) && reach(p.x, p.y), `${p.x},${p.y}`).toBe(true);
  });
});

describe("서버에 싣는 배치(aas/office/default_layout.json)", () => {
  // 서버가 배포 때 이 파일로 OKE 의 판을 바꾼다(계획 §3-5, D6). 화면 코드와 다르면 실패한다.
  // 배치를 고쳤으면 `AAS_WRITE_LAYOUT=1 npx vitest run aasKoreanOffice` 로 다시 뽑는다.
  const path = join(__dirname, "../../../../../../../aas/office/default_layout.json");
  const want = { preset: AAS_LAYOUT_PRESET, items: buildAasKoreanOffice() };
  it("화면 코드의 배치와 같다", () => {
    if (process.env.AAS_WRITE_LAYOUT === "1") writeFileSync(path, JSON.stringify(want, null, 1) + "\n");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(want);
  });
});
