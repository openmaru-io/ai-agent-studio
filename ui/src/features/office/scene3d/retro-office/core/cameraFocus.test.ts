/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import * as THREE from 'three';

import { AGENT_FOCUS_ZOOM, FOCUS_HEIGHT, FOCUS_ZOOM, focusPreset, MAX_ZOOM, NUDGE, nudgePreset, presetZoomCamera, recentClickUid, ROOM_FOCUS_ZOOM } from './cameraFocus';

describe('focusPreset', () => {
  it('객체를 중심으로 옮기고 카메라는 지금 보는 방향을 그대로 유지한다', () => {
    const p = focusPreset([4, 0, -2], [10, 8, 10], [0, 0, 0]);
    expect(p.target).toEqual([4, FOCUS_HEIGHT, -2]);
    expect(p.pos).toEqual([14, 8 + FOCUS_HEIGHT, 8]);
    expect(p.zoom).toBe(FOCUS_ZOOM);
  });

  it('확대는 기본 구도보다 크고 컨트롤 최대(MAX_ZOOM)를 넘지 않는다', () => {
    expect(FOCUS_ZOOM).toBeGreaterThan(56);
    expect(FOCUS_ZOOM).toBeLessThanOrEqual(MAX_ZOOM);
  });

  it('상태판에서 고른 에이전트·회의실은 가구보다 더 확대하고, 에이전트를 가장 크게 본다', () => {
    expect(ROOM_FOCUS_ZOOM).toBeGreaterThan(FOCUS_ZOOM);
    expect(AGENT_FOCUS_ZOOM).toBeGreaterThan(ROOM_FOCUS_ZOOM);
    expect(AGENT_FOCUS_ZOOM).toBeLessThanOrEqual(MAX_ZOOM);
    expect(focusPreset([0, 0, 0], [10, 8, 10], [0, 0, 0], AGENT_FOCUS_ZOOM).zoom).toBe(AGENT_FOCUS_ZOOM);
  });
});

describe('nudgePreset', () => {
  const pos: [number, number, number] = [10, 10, 10];
  const target: [number, number, number] = [0, 0, 0];

  it('확대·축소는 배율만 바꾸고 컨트롤 한도(25~MAX_ZOOM) 안에 둔다', () => {
    // 최대 확대는 120 → 240 으로 올렸다(2026-10-21) — 상태판에서 고른 에이전트(115)보다 두 배 가까이 더 들어간다
    expect(MAX_ZOOM).toBeGreaterThanOrEqual(2 * AGENT_FOCUS_ZOOM);
    expect(nudgePreset('zoomIn', pos, target, 40).zoom).toBeCloseTo(50);
    expect(nudgePreset('zoomOut', pos, target, 50).zoom).toBeCloseTo(40);
    expect(nudgePreset('zoomIn', pos, target, MAX_ZOOM - 10).zoom).toBe(MAX_ZOOM);
    expect(nudgePreset('zoomOut', pos, target, 28).zoom).toBe(NUDGE.minZoom);
    expect(nudgePreset('zoomIn', pos, target, 40).pos).toEqual(pos);
  });

  it('돌리기는 중심을 그대로 두고 높이·수평 거리를 지킨다', () => {
    const p = nudgePreset('rotateLeft', pos, target, 40);
    expect(p.target).toEqual(target);
    expect(p.pos[1]).toBeCloseTo(10);
    expect(Math.hypot(p.pos[0], p.pos[2])).toBeCloseTo(Math.hypot(10, 10));
    const back = nudgePreset('rotateRight', p.pos, p.target, 40);
    back.pos.forEach((v, i) => expect(v).toBeCloseTo(pos[i]));
  });

  it('이동은 카메라와 중심을 바닥 위에서 같이 옮기고, 위는 보는 쪽(카메라에서 멀어지는 쪽)이다', () => {
    const up = nudgePreset('up', pos, target, 40);
    expect(up.pos[1]).toBe(10);
    expect(up.target[1]).toBe(0);
    expect(up.target[0]).toBeLessThan(0);
    expect(up.target[2]).toBeLessThan(0);
    expect(up.pos[0] - up.target[0]).toBeCloseTo(10);
    const right = nudgePreset('right', pos, target, 40);
    // 카메라가 (+x,+z) 쪽에서 원점을 보면 화면 오른쪽은 (+x,-z) 방향이다
    expect(right.target[0]).toBeGreaterThan(0);
    expect(right.target[2]).toBeLessThan(0);
    expect(Math.hypot(right.target[0], right.target[2])).toBeCloseTo(NUDGE.panPx / 40);
  });

  it('많이 확대했을수록 한 번에 덜 옮긴다(화면에서 같은 거리)', () => {
    const near = nudgePreset('left', pos, target, 100).target;
    const far = nudgePreset('left', pos, target, 25).target;
    expect(Math.hypot(near[0], near[2])).toBeLessThan(Math.hypot(far[0], far[2]));
  });
});

describe('recentClickUid', () => {
  it('800ms 안의 클릭만 같은 객체로 본다', () => {
    expect(recentClickUid({ uid: 'a', t: 1000 }, 1500)).toBe('a');
    expect(recentClickUid({ uid: 'a', t: 1000 }, 1801)).toBeNull();
    expect(recentClickUid(null, 1000)).toBeNull();
  });
});

// 2026-10-20: 직교 화면에서 건 프리셋 확대(약 24.7)가 따라가기용 원근 카메라에 들어가, 다시 따라가기를 켜면 화면 가득 확대됐다
describe('presetZoomCamera', () => {
  it('지금 카메라가 직교면 그 카메라에 확대를 적용한다', () => {
    const ortho = new THREE.OrthographicCamera();
    expect(presetZoomCamera(ortho)).toBe(ortho);
  });

  it('원근 카메라(따라가기 중)에는 확대를 적용하지 않는다', () => {
    expect(presetZoomCamera(new THREE.PerspectiveCamera())).toBeNull();
  });
});
