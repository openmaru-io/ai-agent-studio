/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// AAS: 걸을 때 팔·다리의 앞뒤 흔들림(rotation.x). walkPhase 는 sin 값(-1~1)이다.
// 사람은 반대쪽 팔·다리가 함께 나간다(왼다리가 앞이면 오른팔이 앞). 팔·다리 모두 위쪽(어깨·엉덩이)을 축으로
// 같은 x 축 회전을 쓰므로, 같은 쪽 팔과 다리는 부호가 반대여야 한다. 원본(Claw3D)은 같은 부호라 같은 쪽 팔·다리가
// 함께 움직였다(측대보, 고침).
export function walkSwing(walkPhase: number) {
  return {
    leftArm: -walkPhase * 0.4,
    rightArm: walkPhase * 0.4,
    leftLeg: walkPhase * 0.35,
    rightLeg: -walkPhase * 0.35,
  };
}
