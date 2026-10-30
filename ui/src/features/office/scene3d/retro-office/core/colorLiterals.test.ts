/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

// 스펙 2026-10-20-012 §10 E2: 장면 객체 색은 tokens.ts 의 SCENE_PALETTE 에서 읽는다. 색 규칙 시험(C2~C11)은 표만 보므로,
// 장면 코드에 색 문자열(#RRGGBB)이 새로 들어오면 규칙을 피해 간다. 이 시험은 파일마다 남은 색 문자열 수가 아래 상한을 넘지 않는지 본다.
// 상한을 올려야 하면 그 색이 왜 표 밖에 있어야 하는지 이유를 함께 고친다. 벽 그림의 tone("#…") 은 원본 색을 차분한 색으로 바꾸는 입력이라 세지 않는다.
const ROOT = join(__dirname, "..");
const ALLOWED: Record<string, { max: number; why: string }> = {
  "RetroOffice3D.tsx": { max: 5, why: "원본 가구 목록의 빈백 기본색, CSS 배경 대비값, 주 방향광(햇빛) 색, 에이전트 색 대비값" },
  "objects/aasPeople.tsx": { max: 1, why: "사람 아바타 몸 색(회색) — 상태색을 쓰는 에이전트와 구분" },
  "objects/agents.tsx": { max: 40, why: "아바타 옷·피부·머리·손에 든 소품 색 — 사람을 구분하는 색(스펙 §3-8)" },
  "objects/BubbleActions.tsx": { max: 4, why: "drei Html 의 DOM 단추 — Canvas 컨텍스트 밖이라 테마 표를 받지 못한다" },
  "objects/furniture.tsx": { max: 32, why: "칸반 책상 위 종이·메모지·서류철, 벽 칸반 머리 띠, 빔 스크린 — 칸반 상태를 나타내는 소품" },
  "objects/machines.tsx": { max: 17, why: "배치에 없는 장치의 화면·표시등 발광(meshBasicMaterial·emissive)" },
  "objects/primitives.tsx": { max: 12, why: "키보드·마우스·시계 판·휴지통·컵 — 무채색 소품" },
  "objects/RoundedPlate.tsx": { max: 3, why: "판 기본값 — 호출부가 테마 색을 넘긴다" },
  "scene/environment.tsx": { max: 31, why: "바닥 아래에 가려진 땅 판, 원격 오피스·헬스장·QA 구역(AAS 에서 그리지 않음), 액자 기본값" },
  "systems/cameraLighting.tsx": { max: 14, why: "장면에 올라가지 않는 원본 조명(DayNightCycle 등)" },
  "systems/sceneRuntime.tsx": { max: 3, why: "탁구공과 그림자 — 탁구대는 배치에 없다" },
  "systems/visualSystems.tsx": { max: 7, why: "히트맵·이동 경로 보기 — AAS 화면에서 켜지 않는 원본 기능" },
};

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [p] : [];
  });

const countLiterals = (src: string) => (src.match(/(?<!tone\()["']#[0-9a-fA-F]{3,8}["']/g) ?? []).length;

describe("장면 코드의 색 문자열", () => {
  it("파일마다 허용한 수를 넘지 않는다(새 색은 SCENE_PALETTE 에 둔다)", () => {
    const over: string[] = [];
    for (const path of files(ROOT)) {
      const rel = relative(ROOT, path);
      const n = countLiterals(readFileSync(path, "utf8"));
      const max = ALLOWED[rel]?.max ?? 0;
      if (n > max) over.push(`${rel}: ${n} > ${max}`);
    }
    expect(over).toEqual([]);
  });
});
