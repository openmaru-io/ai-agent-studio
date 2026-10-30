/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";

import { EDIT_ITEMS } from "@/features/office/EditPanel";
import { MODEL_URL } from "@/features/office/scene3d/assets";
import { FURNITURE_GLB, FURNITURE_SCALE } from "@/features/office/scene3d/retro-office/objects/furniture";
import { t } from "@/i18n";

import { buildAasKoreanOffice } from "./aasKoreanOffice";
import { getItemBounds, getItemBaseSize, ITEM_FOOTPRINT, ITEM_METADATA } from "./geometry";

// 화분 종류를 늘린다: 기존 화분(plant)은 모양이 하나뿐이었다. Kenney Nature Kit(CC0)의 모델을 더했다.
const NEW_PLANTS = ["plant_cactus", "plant_cactus_short", "plant_palm", "plant_tree"] as const;
const ALL_PLANTS = ["plant", ...NEW_PLANTS];

describe("화분 종류", () => {
  it("새 화분마다 모델·배율·발자국이 있고 길을 막는다", () => {
    for (const type of NEW_PLANTS) {
      expect(FURNITURE_GLB[type], `${type} 모델`).toBeTruthy();
      expect(Object.values(MODEL_URL), `${type} 모델 파일`).toContain(FURNITURE_GLB[type]);
      expect(FURNITURE_SCALE[type], `${type} 배율`).toHaveLength(3);
      expect(ITEM_FOOTPRINT[type], `${type} 발자국`).toBeDefined();
      expect(ITEM_METADATA[type]?.blocksNavigation, `${type} 길 막힘`).toBe(true);
    }
  });

  it("종류마다 다른 모델을 쓴다(모두 같은 모양이 아니다)", () => {
    const urls = ALL_PLANTS.map((type) => FURNITURE_GLB[type]);
    expect(new Set(urls).size).toBe(ALL_PLANTS.length);
  });

  it("편집 패널에서 고를 수 있고 한국어·영어 이름이 있다", () => {
    for (const type of NEW_PLANTS) {
      expect(EDIT_ITEMS as readonly string[], type).toContain(type);
      expect(t(`office.item.${type}`), `${type} 이름`).not.toBe(`office.item.${type}`);
    }
  });
});

describe("한국 사무실 배치의 화분", () => {
  const items = buildAasKoreanOffice();
  const plants = items.filter((i) => ALL_PLANTS.includes(i.type));

  // kr-21: 북쪽 방이 다섯에서 셋이 되어 방 경계 앞 화분이 둘 줄었다(25 → 23)
  it("기존 모양 화분 23개(통로 가운데 8개 포함)와, 모양이 다른 화분을 종류마다 놓는다", () => {
    expect(items.filter((i) => i.type === "plant")).toHaveLength(23);
    for (const type of NEW_PLANTS) expect(items.filter((i) => i.type === type).length, type).toBeGreaterThanOrEqual(2);
    expect(plants.length).toBeGreaterThanOrEqual(30);
  });

  it("새 화분은 다른 가구·벽·문과 겹치지 않고 바닥 안에 있다", () => {
    const others = items.filter((i) => !ALL_PLANTS.includes(i.type) && i.type !== "rug" && i.type !== "room" && i.type !== "boundary");
    const overlap = (a: ReturnType<typeof getItemBounds>, b: ReturnType<typeof getItemBounds>) =>
      a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    for (const p of items.filter((i) => NEW_PLANTS.includes(i.type as (typeof NEW_PLANTS)[number]))) {
      const b = getItemBounds(p);
      expect(b.x, `${p._uid} 왼쪽`).toBeGreaterThanOrEqual(0);
      expect(b.y + b.h, `${p._uid} 남쪽`).toBeLessThanOrEqual(1080);
      for (const o of others) expect(overlap(b, getItemBounds(o)), `${p.type} ${p._uid} 와 ${o.type} ${o._uid}`).toBe(false);
      for (const q of plants.filter((x) => x._uid !== p._uid)) expect(overlap(b, getItemBounds(q)), `${p._uid} 와 화분 ${q._uid}`).toBe(false);
    }
  });

  it("발자국 기본값이 놓인 크기와 맞다(편집 패널로 만든 것과 같은 크기)", () => {
    for (const type of NEW_PLANTS) {
      const [w, h] = ITEM_FOOTPRINT[type];
      const placed = items.filter((i) => i.type === type);
      for (const p of placed) {
        const base = getItemBaseSize(p);
        expect([base.width, base.height], `${p._uid}`).toEqual([w, h]);
      }
    }
  });
});

describe("팀장석 뒤와 통로의 화분(2026-10-16: 통로 화분 8개만 두고 벽에 붙인다)", () => {
  const items = buildAasKoreanOffice();
  const rect = (a: ReturnType<typeof getItemBounds>) => a;
  // 팀장석은 북쪽(facing 180)을 보고 앉는다. 뒤 = 북쪽. 그 자리 폭(양옆 40)과 북쪽 120 안은 통로라 화분을 두지 않는다.
  const leads = items.filter((i) => i.type === "desk_cubicle" && (i as { lead?: boolean }).lead);
  const plants = items.filter((i) => ["plant", ...NEW_PLANTS].includes(i.type));

  it("팀장석 6개가 있다", () => {
    expect(leads).toHaveLength(6);
    expect(leads.every((d) => d.facing === 180)).toBe(true);
  });

  it("팀장석 바로 뒤(북쪽 120 안)에는 화분이 없다", () => {
    for (const d of leads) {
      const back = { x: d.x - 40, y: d.y - 120, w: (d.w ?? 0) + 80, h: 120 };
      for (const p of plants) {
        const b = rect(getItemBounds(p));
        const hit = b.x < back.x + back.w && b.x + b.w > back.x && b.y < back.y + back.h && b.y + b.h > back.y;
        expect(hit, `${p.type} ${p._uid} 가 팀장석 ${d._uid} 뒤에 있다`).toBe(false);
      }
    }
  });

  it("두 통로(1열~2열, 2열~3열)의 화분 8개를 빼고 나머지 화분은 모두 벽에 붙어 있다", () => {
    const walls = items.filter((i) => i.type === "wall" || i.type === "glass_wall" || i.type === "boundary");
    const gap = (a: ReturnType<typeof getItemBounds>, b: ReturnType<typeof getItemBounds>) =>
      Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w))) + Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)));
    // 통로 가운데: 책상 섬 열(구역 1·2·3, 가운데 x 230·700·1170) 사이 통로의 가운데: x 465(1열~2열)·935(2열~3열)
    const centre = (p: (typeof items)[number]) => {
      const b = getItemBounds(p);
      const cx = b.x + b.w / 2;
      return ((cx > 440 && cx < 490) || (cx > 910 && cx < 960)) && b.y > 400 && b.y < 960; // kr-21: 섬 두 줄을 25 내림
    };
    const kept = plants.filter(centre);
    expect(kept.map((p) => p.type)).toEqual(Array(8).fill("plant")); // 통로마다 4개
    for (const p of plants.filter((x) => !centre(x))) {
      const b = getItemBounds(p);
      const edge = Math.min(b.x, 1076 - (b.y + b.h)); // 서쪽 바깥 벽·남쪽 바깥 벽
      const near = Math.min(edge, ...walls.map((w) => gap(b, getItemBounds(w))));
      expect(near, `${p.type} ${p._uid} (${Math.round(b.x)},${Math.round(b.y)}) 의 벽까지 거리`).toBeLessThanOrEqual(14);
    }
  });
});

describe("책상 섬 열 사이 통로의 화분(2026-10-16: 통로마다 같은 화분 4개를 한 줄로)", () => {
  const items = buildAasKoreanOffice();
  const plants = items.filter((i) => i.type === "plant");
  // 섬 열(구역 1·2·3)의 책상 바깥 가장자리 사이 가운데: 1열~2열 x 465, 2열~3열 x 935
  const aisle = (cx: number) => plants.filter((p) => { const b = getItemBounds(p); return Math.abs(b.x + b.w / 2 - cx) < 20 && b.y > 400 && b.y < 960; });

  it("통로마다 같은 모양(기존 화분) 4개가 같은 x 에 한 줄로 서 있다", () => {
    for (const cx of [465, 935]) {
      const row = aisle(cx);
      expect(row, `x ${cx} 통로`).toHaveLength(4);
      expect(new Set(row.map((p) => Math.round(getItemBounds(p).x))).size, `x ${cx} 한 줄`).toBe(1);
      expect(new Set(row.map((p) => FURNITURE_GLB[p.type])).size, `${cx} 같은 모델`).toBe(1);
    }
  });

  // kr-21: 두 묶음이 y 405~615·765~975 다(kr-18 에서 아래 묶음 50, kr-21 에서 둘 다 25 내림)
  it("양쪽(북쪽 섬 묶음 옆 y 405~615, 남쪽 섬 묶음 옆 y 765~975)에 2개씩, 간격이 같다", () => {
    for (const cx of [465, 935]) {
      const ys = aisle(cx).map((p) => getItemBounds(p).y + 12).sort((a, b) => a - b);
      expect(ys.filter((y) => y > 405 && y < 615), `${cx} 북쪽 묶음`).toHaveLength(2);
      expect(ys.filter((y) => y > 765 && y < 975), `${cx} 남쪽 묶음`).toHaveLength(2);
      expect(ys[1] - ys[0], `${cx} 북쪽 간격`).toBe(ys[3] - ys[2]);   // 두 묶음의 간격이 같다
      expect(ys[2] - ys[0] - (ys[3] - ys[1]), `${cx} 묶음 사이`).toBe(0); // 두 묶음이 같은 모양으로 놓였다
    }
  });

  it("1열~2열 통로와 2열~3열 통로가 같은 모양이다(x 만 다르다)", () => {
    const ys = (cx: number) => aisle(cx).map((p) => getItemBounds(p).y).sort((a, b) => a - b);
    expect(ys(935)).toEqual(ys(465));
  });
});
