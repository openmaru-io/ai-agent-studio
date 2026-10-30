/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// AAS: 이름표·방 명패의 바탕. 모서리가 둥근 판과 그 뒤의 가는 윤곽선(판보다 한 줄 큰 같은 모양)으로 그린다.
// 평평한 직사각형 하나이던 것을 바꿨다. 판 위의 글자·점은 z 0.001 이상에 둔다.
import { memo, type RefObject, useMemo } from "react";
import * as THREE from "three";

import { SPEECH_TAIL } from "@/features/office/scene3d/retro-office/core/speechBubble";

export function roundedRectShape(w: number, h: number, r: number): THREE.Shape {
  const rr = Math.min(r, w / 2, h / 2);
  const x = -w / 2;
  const y = -h / 2;
  const s = new THREE.Shape();
  s.moveTo(x + rr, y);
  s.lineTo(x + w - rr, y);
  s.absarc(x + w - rr, y + rr, rr, -Math.PI / 2, 0, false);
  s.lineTo(x + w, y + h - rr);
  s.absarc(x + w - rr, y + h - rr, rr, 0, Math.PI / 2, false);
  s.lineTo(x + rr, y + h);
  s.absarc(x + rr, y + h - rr, rr, Math.PI / 2, Math.PI, false);
  s.lineTo(x, y + rr);
  s.absarc(x + rr, y + rr, rr, Math.PI, Math.PI * 1.5, false);
  return s;
}

export const RoundedPlate = memo(function RoundedPlate({
  width,
  height,
  radius,
  color = "#0f1114",
  opacity = 0.88,
  outline = "#ffffff",
  outlineOpacity = 0.14,
  outlineWidth = 0.01,
}: {
  width: number;
  height: number;
  radius: number;
  color?: string;
  opacity?: number;
  outline?: string;
  outlineOpacity?: number;
  outlineWidth?: number;
}) {
  const body = useMemo(() => new THREE.ShapeGeometry(roundedRectShape(width, height, radius), 8), [width, height, radius]);
  const edge = useMemo(
    () => new THREE.ShapeGeometry(roundedRectShape(width + outlineWidth * 2, height + outlineWidth * 2, radius + outlineWidth), 8),
    [width, height, radius, outlineWidth]
  );
  return (
    <>
      <mesh geometry={edge} position={[0, 0, -0.0015]}>
        <meshBasicMaterial color={outline} transparent opacity={outlineOpacity} depthWrite={false} />
      </mesh>
      <mesh geometry={body} position={[0, 0, -0.001]}>
        <meshBasicMaterial color={color} transparent opacity={opacity} />
      </mesh>
    </>
  );
});

/** 말풍선 모서리 반지름: 높이에 비례하되 0.14 를 넘지 않는다. 작은 풍선(높이 0.2)은 알약에 가깝고 큰 풍선은 너무 둥글지 않다. */
export const bubbleRadius = (height: number) => Math.min(0.14, height * 0.4);

/** 말풍선 꼬리. 위쪽 가장자리가 y=0 이고 아래로 뻗는다. 끝은 뾰족하지 않게 작은 곡선으로 마무리한다. */
export function bubbleTailShape(width: number, height: number): THREE.Shape {
  const tip = 0.012;
  const s = new THREE.Shape();
  s.moveTo(-width / 2, 0);
  s.lineTo(-tip, -height + 0.025);
  s.quadraticCurveTo(0, -height - 0.025, tip, -height + 0.025); // 곡선의 가장 아랫점이 정확히 -height 가 되는 조절점
  s.lineTo(width / 2, 0);
  s.closePath();
  return s;
}

// 2026-10-20-004: 꼬리를 작게(0.22 × 0.15 → 0.12 × 0.08), 판 가운데 아래(머리 바로 위)로. 예전에는 판 폭의 −18% 자리였다
const TAIL_W = SPEECH_TAIL.w;
const TAIL_H = SPEECH_TAIL.h;

/**
 * AAS: 에이전트 말풍선의 바탕·윤곽선·꼬리. 평평한 직사각형 두 장과 돌린 마름모이던 것을 둥근 판으로 바꿨다.
 * 장면 위에 항상 보이도록 깊이 검사를 끄고 renderOrder 로 순서를 정한다: 꼬리 윤곽 < 바탕 윤곽 < 꼬리 < 바탕.
 * 꼬리가 바탕 윤곽을 덮어 풍선 윤곽이 꼬리 둘레로 이어진다. 바탕·꼬리의 색과 투명도는 매 프레임 상태에 따라 바뀌어 ref 로 받는다.
 */
export const SpeechBubbleShape = memo(function SpeechBubbleShape({
  width,
  height,
  bodyRef,
  tailRef,
  bodyColor = "#1a2030",
  bodyOpacity = 0.76,
  outline,
  outlineOpacity = 0.88,
  outlineWidth = 0.03,
  tail = false,
}: {
  width: number;
  height: number;
  bodyRef?: RefObject<THREE.MeshBasicMaterial | null>;
  tailRef?: RefObject<THREE.MeshBasicMaterial | null>;
  bodyColor?: string;
  bodyOpacity?: number;
  /** 없으면 윤곽선을 그리지 않는다 */
  outline?: string;
  outlineOpacity?: number;
  outlineWidth?: number;
  tail?: boolean;
}) {
  const radius = bubbleRadius(height);
  const body = useMemo(() => new THREE.ShapeGeometry(roundedRectShape(width, height, radius), 10), [width, height, radius]);
  const edge = useMemo(
    () => new THREE.ShapeGeometry(roundedRectShape(width + outlineWidth, height + outlineWidth, radius + outlineWidth / 2), 10),
    [width, height, radius, outlineWidth]
  );
  const tailGeo = useMemo(() => new THREE.ShapeGeometry(bubbleTailShape(TAIL_W, TAIL_H), 6), []);
  const tailEdge = useMemo(() => new THREE.ShapeGeometry(bubbleTailShape(TAIL_W + outlineWidth * 2.4, TAIL_H + outlineWidth * 1.4), 6), [outlineWidth]);
  const tailX = 0;
  const tailY = -height / 2 + 0.004; // 바탕과 맞닿게 살짝 겹친다
  const flat = { depthTest: false, depthWrite: false, transparent: true } as const;
  return (
    <>
      {tail && outline ? (
        <mesh geometry={tailEdge} position={[tailX, tailY + outlineWidth * 0.6, -0.0016]} renderOrder={99996}>
          <meshBasicMaterial color={outline} opacity={outlineOpacity} {...flat} />
        </mesh>
      ) : null}
      {outline ? (
        <mesh geometry={edge} position={[0, 0, -0.0015]} renderOrder={99997}>
          <meshBasicMaterial color={outline} opacity={outlineOpacity} {...flat} />
        </mesh>
      ) : null}
      {tail ? (
        <mesh geometry={tailGeo} position={[tailX, tailY, -0.0012]} renderOrder={99998}>
          <meshBasicMaterial ref={tailRef} color={bodyColor} opacity={bodyOpacity} {...flat} />
        </mesh>
      ) : null}
      <mesh geometry={body} position={[0, 0, -0.001]} renderOrder={99999}>
        <meshBasicMaterial ref={bodyRef} color={bodyColor} opacity={bodyOpacity} {...flat} />
      </mesh>
    </>
  );
});
