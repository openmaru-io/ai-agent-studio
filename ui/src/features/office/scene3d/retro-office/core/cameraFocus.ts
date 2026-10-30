/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 객체를 더블클릭하면 그 객체를 화면 중앙에 두고 조금 확대한다. 카메라가 보는 방향은 지금 그대로 두고 중심만 옮긴다.
import * as THREE from "three";

import type { CameraPreset } from "@/features/office/scene3d/retro-office/systems/cameraLighting";

/** 처음 구도의 확대 배율. 원본은 56 이었는데 바닥을 남쪽으로 넓혀(계획 007) 40 으로 줄였고, 조금 더 가까이 보고 싶다는 요청으로 46 으로 올렸다(2026-10-16). */
export const OVERVIEW_ZOOM = 46;
/** 확대 한도. 휠(OrbitControls minZoom·maxZoom)과 카메라 조작 단추가 같이 쓴다. 최대는 120 이었는데 더 가까이 보고 싶다는 요청으로 240 으로 올렸다(2026-10-21).
 *  직교 카메라라 확대해도 카메라가 벽 안으로 들어가지 않고 화면만 커진다. */
export const MIN_ZOOM = 25;
export const MAX_ZOOM = 240;
/** 확대 배율. */
export const FOCUS_ZOOM = 85;
/** 상태판에서 에이전트 이름을 누를 때의 확대 배율. 가구 확대(85)로는 사람이 작게 보여 더 가까이 보고 싶다는 요청으로 따로 두었다(2026-10-21). */
export const AGENT_FOCUS_ZOOM = 115;
/** 상태판에서 회의실 이름을 누를 때의 확대 배율. 방 전체가 화면에 들어오도록 에이전트보다 덜 확대한다(2026-10-21). */
export const ROOM_FOCUS_ZOOM = 105;
/** 객체를 보는 높이(월드 단위). 부스·ATM 처럼 키가 큰 객체의 가운데쯤을 중앙에 둔다. */
export const FOCUS_HEIGHT = 0.7;
/** 더블클릭으로 보는 두 번째 클릭이 객체 클릭과 같은 객체로 이어지는 시간 */
export const RECENT_CLICK_MS = 800;

type Vec3 = [number, number, number];

/** center 를 중앙에 두고, 카메라는 지금 중심(currentTarget)에서 떨어진 만큼(currentPosition) 그대로 따라온다. */
export function focusPreset(center: Vec3, currentPosition: Vec3, currentTarget: Vec3, zoom = FOCUS_ZOOM): CameraPreset {
  const offset: Vec3 = [
    currentPosition[0] - currentTarget[0],
    currentPosition[1] - currentTarget[1],
    currentPosition[2] - currentTarget[2],
  ];
  const target: Vec3 = [center[0], FOCUS_HEIGHT, center[2]];
  return {
    pos: [target[0] + offset[0], target[1] + offset[1], target[2] + offset[2]],
    target,
    zoom,
  };
}

/** 카메라 조작 단추(스펙 2026-10-21-006). 처음 구도는 장면이 가진 프리셋을 그대로 쓰므로 여기서 계산하지 않는다. */
export type CameraNudge = "zoomIn" | "zoomOut" | "up" | "down" | "left" | "right" | "rotateLeft" | "rotateRight";
/** 확대 한 번의 배율, 이동 한 번의 화면 거리(px), 회전 한 번의 각도. 확대 한도는 OrbitControls 의 minZoom·maxZoom 과 같다. */
export const NUDGE = { zoomStep: 1.25, panPx: 120, rotate: Math.PI / 8, minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM } as const;

/** 지금 카메라(pos·target·zoom)에서 단추 하나만큼 옮긴 프리셋. 보는 각도는 회전 단추만 바꾼다. */
export function nudgePreset(kind: CameraNudge, pos: Vec3, target: Vec3, zoom: number): CameraPreset {
  const offset: Vec3 = [pos[0] - target[0], pos[1] - target[1], pos[2] - target[2]];
  if (kind === "zoomIn" || kind === "zoomOut") {
    const next = kind === "zoomIn" ? zoom * NUDGE.zoomStep : zoom / NUDGE.zoomStep;
    return { pos, target, zoom: Math.min(NUDGE.maxZoom, Math.max(NUDGE.minZoom, next)) };
  }
  if (kind === "rotateLeft" || kind === "rotateRight") {
    // 중심을 축으로 수평으로만 돌린다 — 높이와 거리가 그대로라 내려다보는 각이 바뀌지 않는다
    const a = kind === "rotateLeft" ? -NUDGE.rotate : NUDGE.rotate;
    const [ox, oy, oz] = offset;
    const rotated: Vec3 = [ox * Math.cos(a) - oz * Math.sin(a), oy, ox * Math.sin(a) + oz * Math.cos(a)];
    return { pos: [target[0] + rotated[0], target[1] + rotated[1], target[2] + rotated[2]], target, zoom };
  }
  // 바닥 위에서 화면 방향으로 옮긴다. 직교 카메라에서 화면 1px 은 월드 1/zoom, 화면 위아래는 비스듬히 본 바닥이라 1/sin(각) 배 길다
  const len = Math.hypot(...offset) || 1;
  const flat = Math.hypot(offset[0], offset[2]) || 1;
  const forward: Vec3 = [-offset[0] / flat, 0, -offset[2] / flat];
  const right: Vec3 = [-forward[2], 0, forward[0]];
  const step = NUDGE.panPx / Math.max(zoom, 1);
  const sinElev = Math.max(0.3, Math.abs(offset[1]) / len);
  const [dir, dist] =
    kind === "up" ? [forward, step / sinElev] : kind === "down" ? [forward, -step / sinElev] : kind === "right" ? [right, step] : [right, -step];
  const move = (v: Vec3): Vec3 => [v[0] + dir[0] * dist, v[1], v[2] + dir[2] * dist];
  return { pos: move(pos), target: move(target), zoom };
}

/** 방금(RECENT_CLICK_MS 안에) 클릭한 객체의 uid. 없으면 null. */
export function recentClickUid(last: { uid: string; t: number } | null, now: number): string | null {
  return last && now - last.t <= RECENT_CLICK_MS ? last.uid : null;
}

/** AAS(2026-10-20): 카메라 프리셋의 확대(zoom)를 적용할 카메라. 프리셋은 직교 화면(기본 구도·초점 이동)용이라 지금 카메라가 직교일 때만 준다.
 *  예전에는 한 번 본 따라가기용 원근 카메라를 계속 골라, 직교 화면에서 건 확대(약 24.7)가 숨은 원근 카메라에 들어갔다.
 *  그 뒤 따라가기를 켜면 원근 카메라 zoom 이 24 라 캐릭터 안을 비췄다(화면 가득 확대). */
export function presetZoomCamera(camera: THREE.Camera): THREE.OrthographicCamera | null {
  return camera instanceof THREE.OrthographicCamera ? camera : null;
}
