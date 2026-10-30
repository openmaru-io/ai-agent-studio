/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// AAS(2026-10-20): 벽 아래 걸레받이의 크기와 자리. 원본은 바깥벽 걸레받이 앞면을 벽 안쪽 면과 같은 평면에 두고
// (벽 중심 + 0.04, 두께 0.04 → 앞면 = 벽 중심 + 0.06 = 벽 안쪽 면), 실내 벽 걸레받이 두께를 벽 두께와 같게 했다.
// 같은 평면의 두 면은 깊이값이 같아 카메라를 움직일 때마다 픽셀마다 번갈아 그려져 벽 아래가 깜빡였다(z-fighting).
// 거의 검은 색(#0c0c10)이라 그 띠가 벽과 바닥 사이의 틈처럼 보였다. 걸레받이를 벽 면보다 protrude 만큼 앞으로 내밀고
// 뒤쪽은 벽 안에 묻어 겹치는 면을 없애고, 색은 벽보다 어두운 갈색으로 바꿨다.
// 2026-10-20-012: 색은 테마별 장면 색(tokens.ts SCENE_PALETTE.baseboard)으로 옮겼다. 여기는 크기와 자리만 둔다.

export const BASEBOARD = { height: 0.06, depth: 0.04, protrude: 0.02 } as const;

/** 벽 중심선에서 걸레받이 중심까지(방 안쪽 방향). 앞면은 벽 면보다 protrude 앞, 뒷면은 벽 안에 있다. */
export const baseboardOffset = (wallThickness: number) => wallThickness / 2 + BASEBOARD.protrude - BASEBOARD.depth / 2;

/** 실내 벽(가운데 기준) 걸레받이의 두께. 벽보다 양쪽으로 protrude 만큼 두껍다. */
export const wallBaseboardDepth = (wallDepth: number) => wallDepth + BASEBOARD.protrude * 2;
