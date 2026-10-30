/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// AAS(스펙 2026-10-21-012 §3-4): 상태판에서 고른 회의실의 바닥 테두리. 방 항목 사각형(x·y·w·h)을 따라 얇은 띠 네 개를 깔고,
// 0.3초 동안 나타나 2.5초에 사라진다(highlightFrame). 카메라만 옮기면 확대한 화면에 옆 회의실도 들어와 어느 방인지 몰랐다.
import { useFrame } from "@react-three/fiber";
import { memo, useEffect, useMemo } from "react";
import * as THREE from "three";

import { toWorld } from "@/features/office/scene3d/retro-office/core/geometry";
import { highlightFrame } from "@/features/office/scene3d/retro-office/core/selectHighlight";
import type { FurnitureItem } from "@/features/office/scene3d/retro-office/core/types";
import { useScenePalette } from "@/features/office/scenePaletteContext";
import { prefersReducedMotion } from "@/features/office/tokens";

/** 띠 두께(장면 단위) */
const LINE = 0.04;
/** 벽 안쪽에 그리도록 방 가장자리에서 띄우는 거리(배치 단위) */
const INSET = 6;
/** 바닥(0)·바닥선 위, 상태 고리보다 조금 위 */
const Y = 0.006;

export const RoomHighlight = memo(function RoomHighlight({ room, at }: { room: FurnitureItem; at: number }) {
  const { palette } = useScenePalette();
  const reducedMotion = useMemo(() => prefersReducedMotion(), []);
  // 네 띠가 재질 하나를 함께 쓴다(불투명도를 한 번만 바꾼다)
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }), []);
  useEffect(() => () => mat.dispose(), [mat]);
  useEffect(() => {
    mat.color.set(palette.mine.ring);
  }, [mat, palette.mine.ring]);
  const [x0, , z0] = toWorld(room.x + INSET, room.y + INSET);
  const [x1, , z1] = toWorld(room.x + (room.w ?? 0) - INSET, room.y + (room.h ?? 0) - INSET);
  const w = x1 - x0;
  const d = z1 - z0;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  // [가운데 x, 가운데 z, 폭, 깊이] — 위·아래 변은 모서리까지, 왼쪽·오른쪽 변은 그 사이
  const bars: [number, number, number, number][] = [
    [cx, z0 + LINE / 2, w, LINE],
    [cx, z1 - LINE / 2, w, LINE],
    [x0 + LINE / 2, cz, LINE, d - LINE * 2],
    [x1 - LINE / 2, cz, LINE, d - LINE * 2],
  ];
  useFrame(() => {
    mat.opacity = palette.mine.ringOpacity * highlightFrame(performance.now() - at, reducedMotion).roomOpacity;
  });
  return (
    <group>
      {bars.map(([bx, bz, bw, bd], i) => (
        <mesh key={i} position={[bx, Y, bz]} rotation={[-Math.PI / 2, 0, 0]} material={mat}>
          <planeGeometry args={[bw, bd]} />
        </mesh>
      ))}
    </group>
  );
});
