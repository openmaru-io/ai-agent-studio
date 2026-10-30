/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// AAS(2026-10-26-012 후속, OMAI-1509): 자리 비움 인물의 반투명.
// three 는 transparent=false 로 컴파일한 재질의 셰이더에 `#define OPAQUE`(알파 1 고정)를 넣고, transparent 만 바꿔서는 다시
// 컴파일하지 않는다(WebGLRenderer 의 프로그램 교체 조건에 없다). 그래서 매 프레임 opacity 를 0.45 로 줘도 도중에 자리 비움이 된
// 인물은 불투명하게 남고, 처음 그려질 때부터 자리 비움이던 인물만 반투명했다. transparent 가 바뀌는 재질에만 needsUpdate 를 건다.
// 첫 수정은 Lambert 재질만 봐서 머리(재질 배열)·얼굴(MeshBasicMaterial)이 불투명하게 남았다 — 몸 묶음(bodyRef) 안의 재질을 모두 다룬다.
import * as THREE from "three";

export const AWAY_OPACITY = 0.45;

type AwayBase = { transparent: boolean; opacity: number };

/**
 * 인물 몸 묶음(다리~얼굴, 들고 있는 도구 포함) 안의 모든 재질을 자리 비움이면 반투명, 아니면 원래대로 맞춘다.
 * 머리 상자처럼 재질 배열인 것과 얼굴·눈 같은 MeshBasicMaterial 도 다룬다(2026-10-27: 몸만 반투명하고 머리·얼굴은 불투명했다).
 * 이름표·말풍선은 몸 묶음 밖이라 건드리지 않는다. 원래 반투명이던 재질(얼굴 그림)은 처음 본 값을 기억했다가 되돌린다.
 */
export function applyAwayLook(body: THREE.Object3D, isAway: boolean): void {
  body.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const mats: THREE.Material[] = Array.isArray(child.material) ? child.material : [child.material];
    for (const mat of mats) {
      const base = (mat.userData.awayBase ??= { transparent: mat.transparent, opacity: mat.opacity }) as AwayBase;
      const transparent = isAway || base.transparent;
      if (mat.transparent !== transparent) {
        mat.transparent = transparent;
        mat.needsUpdate = true; // OPAQUE 정의를 빼거나 넣으려면 다시 컴파일해야 한다
      }
      mat.opacity = isAway ? base.opacity * AWAY_OPACITY : base.opacity;
    }
  });
}
