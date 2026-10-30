/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { AWAY_OPACITY, applyAwayLook } from "@/features/office/scene3d/retro-office/core/awayLook";

function figure() {
  const body = new THREE.Group();
  const shirt = new THREE.MeshLambertMaterial();
  // 머리 상자는 면마다 재질이 다른 배열이다(앞면은 얼굴 그림)
  const head = [new THREE.MeshLambertMaterial(), new THREE.MeshLambertMaterial({ map: new THREE.Texture() })];
  // 얼굴 그림은 원래 반투명(PNG 알파)인 MeshBasicMaterial 이다
  const face = new THREE.MeshBasicMaterial({ transparent: true });
  const tool = new THREE.MeshStandardMaterial();
  body.add(
    new THREE.Mesh(new THREE.BoxGeometry(), shirt),
    new THREE.Mesh(new THREE.BoxGeometry(), head),
    new THREE.Mesh(new THREE.PlaneGeometry(), face),
    new THREE.Mesh(new THREE.BoxGeometry(), tool),
  );
  return { body, shirt, head, face, tool };
}

describe("applyAwayLook", () => {
  // three 는 transparent=false 로 컴파일한 재질에 #define OPAQUE(알파 1 고정)를 넣고, transparent 만 바꿔서는 다시 컴파일하지 않는다.
  // 그래서 도중에 자리 비움이 된 인물은 opacity 0.45 여도 불투명하게 보였다(2026-10-27 OKE, 처음부터 자리 비움이던 인물만 반투명).
  it("recompiles the materials when the figure becomes away and when it comes back", () => {
    const { body, shirt } = figure();
    const v0 = shirt.version;
    applyAwayLook(body, true);
    expect(shirt.transparent).toBe(true);
    expect(shirt.opacity).toBe(AWAY_OPACITY);
    expect(shirt.version).toBeGreaterThan(v0);

    const v1 = shirt.version;
    applyAwayLook(body, false);
    expect(shirt.transparent).toBe(false);
    expect(shirt.opacity).toBe(1);
    expect(shirt.version).toBeGreaterThan(v1);
  });

  it("does not recompile every frame while the state stays the same", () => {
    const { body, shirt } = figure();
    applyAwayLook(body, true);
    const v = shirt.version;
    for (let i = 0; i < 5; i++) applyAwayLook(body, true);
    expect(shirt.version).toBe(v);
    expect(shirt.opacity).toBe(AWAY_OPACITY);
  });

  // 2026-10-27 OKE: 몸은 반투명해졌는데 머리(재질 배열)·얼굴(MeshBasicMaterial)은 불투명하게 남았다
  it("fades the head (a material array), the face and held tools too", () => {
    const { body, head, face, tool } = figure();
    applyAwayLook(body, true);
    for (const m of [...head, face, tool]) {
      expect(m.transparent).toBe(true);
      expect(m.opacity).toBe(AWAY_OPACITY);
    }
  });

  it("puts materials that were transparent to begin with back as they were", () => {
    const { body, face } = figure();
    face.opacity = 0.9;
    applyAwayLook(body, true);
    expect(face.opacity).toBeCloseTo(0.9 * AWAY_OPACITY);
    const v = face.version;
    applyAwayLook(body, false);
    expect(face.transparent).toBe(true); // 얼굴은 원래 반투명 — 다시 불투명으로 컴파일하지 않는다
    expect(face.opacity).toBe(0.9);
    expect(face.version).toBe(v);
  });

  it("also fades materials that appear later while away", () => {
    const { body } = figure();
    applyAwayLook(body, true);
    const late = new THREE.MeshLambertMaterial();
    body.add(new THREE.Mesh(new THREE.BoxGeometry(), late));
    const v = late.version;
    applyAwayLook(body, true);
    expect(late.transparent).toBe(true);
    expect(late.version).toBeGreaterThan(v);
  });
});
