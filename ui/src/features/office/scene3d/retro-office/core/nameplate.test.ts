/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";

import { fitLabel, nameplateLayout, nameplateZones, roomLabelLayout, textWidthEm } from "./nameplate";

describe("textWidthEm", () => {
  it("한글은 영문보다 넓게 센다", () => {
    expect(textWidthEm("관리자")).toBeGreaterThan(textWidthEm("abc") * 1.5);
  });
});

describe("fitLabel", () => {
  const MAX = 0.68;

  it("짧은 이름은 기본 크기 그대로", () => {
    expect(fitLabel("kim0", MAX, 0.144, 0.08)).toEqual({ text: "kim0", fontSize: 0.144 });
  });

  it("한글이 섞인 이름은 상자 폭에 맞게 글자를 줄인다", () => {
    const out = fitLabel("관리자 Hermes", MAX, 0.144, 0.08);
    expect(out.text).toBe("관리자 Hermes");
    expect(out.fontSize).toBeLessThan(0.144);
    expect(textWidthEm(out.text) * out.fontSize).toBeLessThanOrEqual(MAX + 1e-9);
  });

  it("가장 작은 크기로도 넘치면 끝을 … 로 줄인다(여러 줄로 접히지 않는다)", () => {
    const out = fitLabel("aas-agent-aas-test-a5f9-very-long-name", MAX, 0.144, 0.08);
    expect(out.fontSize).toBe(0.08);
    expect(out.text.endsWith("…")).toBe(true);
    expect(textWidthEm(out.text) * out.fontSize).toBeLessThanOrEqual(MAX + 1e-9);
  });

  it("빈 글자는 그대로", () => {
    expect(fitLabel("", MAX, 0.144, 0.08)).toEqual({ text: "", fontSize: 0.144 });
  });
});

describe('nameplateZones (OMAI-1259, 2026-10-16 위=대화·아래=상세로 바꿈)', () => {
  it('눌러 쓸 수 있으면 위 구역과 아래 구역이 판 전체 폭·높이를 틈 없이 나눈다', () => {
    const p = nameplateZones(0.5, 0.24, true);
    expect(p.width).toBeCloseTo(0.5, 5);
    expect(p.height).toBeCloseTo(0.24, 5);
    const [top, bottom] = p.zones;
    expect([top.id, bottom.id]).toEqual(['top', 'bottom']);
    expect(top.y).toBeGreaterThan(0);
    expect(bottom.y).toBeLessThan(0);
    // 두 구역이 이어지고(틈·겹침 없음) 판 위·아래 끝에 맞는다
    expect(top.y - top.h / 2).toBeCloseTo(bottom.y + bottom.h / 2, 5);
    expect(top.y + top.h / 2).toBeCloseTo(p.height / 2, 5);
    expect(bottom.y - bottom.h / 2).toBeCloseTo(-p.height / 2, 5);
  });

  it('누를 곳이 없으면(청소부 등) 나누지 않는다', () => {
    expect(nameplateZones(0.5, 0.24, false).zones).toEqual([]);
  });
});

// 2026-10-20-003: 판 폭을 글자에 맞추고 글자 크기는 고정한다(전에는 고정 폭 0.82 에 맞춰 짧은 이름일수록 글자가 컸다)
describe('nameplateLayout (2026-10-20-003)', () => {
  it('짧은 이름은 기본 글자 크기에 작은 판, 긴 이름도 글자 크기가 같다', () => {
    const short = nameplateLayout('시험계정', '');
    const mid = nameplateLayout('AAS 관리자', '');
    expect(short.name.fontSize).toBeCloseTo(0.095, 5);
    expect(mid.name.fontSize).toBeCloseTo(0.095, 5);
    expect(short.width).toBeLessThan(mid.width);
    expect(short.width).toBeLessThan(0.82 * 0.7);
  });

  it('부제가 없으면 한 줄 높이(0.16), 있으면 두 줄 높이(0.24)', () => {
    expect(nameplateLayout('관리자 Hermes', '').height).toBeCloseTo(0.16, 5);
    const two = nameplateLayout('관리자 Hermes', '관리자 AAS');
    expect(two.height).toBeCloseTo(0.24, 5);
    expect(two.subtitle?.text).toBe('관리자 AAS');
    expect(two.name.y).toBeGreaterThan(two.subtitle!.y);
  });

  it('판 폭은 0.30~0.72 안이고, 최대 폭을 넘는 이름만 글자를 줄이거나 끝을 … 로 줄인다', () => {
    expect(nameplateLayout('a', '').width).toBeCloseTo(0.3, 5);
    const long = nameplateLayout('omai1295-seed2', '');
    expect(long.width).toBeCloseTo(0.72, 5);
    expect(long.name.fontSize).toBeLessThan(0.095);
    const veryLong = nameplateLayout('aas-agent-aas-test-a5f9-very-long-name', '');
    expect(veryLong.width).toBeCloseTo(0.72, 5);
    expect(veryLong.name.text.endsWith('…')).toBe(true);
  });

  it('글자는 색 막대 오른쪽에서 시작해 상태 점 앞에서 끝난다', () => {
    const p = nameplateLayout('omai1295-seed2', 'AAS 관리자');
    const right = p.name.x + textWidthEm(p.name.text) * p.name.fontSize;
    expect(p.name.x).toBeGreaterThan(p.bar.x);
    expect(right).toBeLessThanOrEqual(p.dot.x - p.dot.r + 1e-9);
    expect(p.dot.x + p.dot.r).toBeLessThan(p.width / 2);
  });
});

describe('roomLabelLayout (2026-10-20-003)', () => {
  it('글자 고정(2026-10-20-008 에 0.14), 판 폭은 글자에 맞추고 0.70~1.60 안', () => {
    const a = roomLabelLayout('AAS 개발팀 회의실', true);
    const b = roomLabelLayout('대회의실', true);
    expect(a.fontSize).toBeCloseTo(0.14, 5);
    expect(b.fontSize).toBeCloseTo(0.14, 5);
    expect(b.width).toBeLessThan(a.width);
    expect(b.width).toBeGreaterThanOrEqual(0.7);
    expect(a.width).toBeLessThanOrEqual(1.6);
    expect(a.height).toBeCloseTo(0.22, 5);
  });

  it('눌러 열 수 있으면 › 자리만큼 판이 넓고, 글자가 › 앞에서 끝난다', () => {
    const on = roomLabelLayout('오픈마루 회의실', true);
    const off = roomLabelLayout('오픈마루 회의실', false);
    expect(on.width).toBeGreaterThan(off.width);
    expect(on.textX + textWidthEm(on.text) * on.fontSize).toBeLessThan(on.chevronX);
  });
});

// 2026-10-20-008: 회의실 팻말은 안내판 모양(사람 이름표는 알약)
describe("roomLabelLayout 안내판 (2026-10-20-008)", () => {
  it("모서리가 사람 이름표보다 덜 둥글다", () => {
    const room = roomLabelLayout("오픈마루 회의실", true);
    expect(room.radius).toBeLessThan(nameplateLayout("마케팅", "").radius);
  });

  it("문 아이콘이 글자 왼쪽, 판 안에 있다", () => {
    const r = roomLabelLayout("오픈마루 회의실", true);
    expect(r.icon.x + r.icon.w / 2).toBeLessThan(r.textX);
    expect(r.icon.x - r.icon.w / 2).toBeGreaterThan(-r.width / 2);
  });

  it("회의 중이면 둘째 줄(「회의 중」)이 생겨 판이 높아지고, 줄은 이름 아래·판 안에 있다", () => {
    const empty = roomLabelLayout("AAS 개발팀 회의실", true, false);
    const busy = roomLabelLayout("AAS 개발팀 회의실", true, true);
    expect(empty.status).toBeNull();
    expect(busy.height).toBeGreaterThan(empty.height);
    expect(busy.status).not.toBeNull();
    expect(busy.status!.y).toBeLessThan(busy.nameY);
    expect(busy.status!.y - busy.status!.fontSize / 2).toBeGreaterThan(-busy.height / 2);
    expect(busy.nameY + busy.fontSize / 2).toBeLessThan(busy.height / 2);
    // 회의 중이어도 폭은 같다(이름 기준)
    expect(busy.width).toBeCloseTo(empty.width, 9);
  });
});

// 2026-10-20-017 디자인 리뷰 이슈 1·2: 둘째 줄 글(「→ 대회의실에서 회의 중」, 「마케팅팀 회의 중」)
describe("roomLabelLayout 둘째 줄 글 (2026-10-20-017)", () => {
  it("둘째 줄이 이름보다 길면 판이 넓어지고 글이 판 안에서 끝난다", () => {
    const plain = roomLabelLayout("대회의실", true, true);
    const named = roomLabelLayout("대회의실", true, true, "마케팅팀 회의 중");
    expect(named.width).toBeGreaterThan(plain.width);
    expect(named.status?.text).toBe("마케팅팀 회의 중");
    expect(named.status!.x + named.status!.dotR * 2 + 0.03 + textWidthEm(named.status!.text) * named.status!.fontSize).toBeLessThan(named.chevronX);
  });

  it("최대 폭을 넘는 둘째 줄은 … 로 자른다", () => {
    const out = roomLabelLayout("대회의실", true, true, "아주아주아주 긴 이름의 영업 기획 마케팅 연합 태스크포스 회의 중");
    expect(out.width).toBeLessThanOrEqual(1.6);
    expect(out.status?.text.endsWith("…")).toBe(true);
  });

  it("둘째 줄 글을 주지 않으면 지금과 같다", () => {
    expect(roomLabelLayout("대회의실", true, true)).toEqual(roomLabelLayout("대회의실", true, true, ""));
    expect(roomLabelLayout("대회의실", true, true).status?.text).toBe("");
  });
});
