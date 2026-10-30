/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 3D 장면의 글자. 로컬 한글 글꼴을 기본으로 준다. 글꼴을 주지 않으면 troika 가 기본 글꼴을 외부에서 받는다(에어갭에서 깨진다).
// drei <Text> 를 쓰지 않는다: drei 는 글꼴을 받는 동안 멈추고(suspend), <Canvas> 안에서 멈춘 것은 바깥 DOM 의 Suspense 까지
// 올라가 오피스 화면이 장면을 「장면을 불러오는 중…」으로 다시 가린다(로딩 때 두 번 깜빡임). troika 는 글꼴이 오면 스스로 그린다.
import type { Text as DreiText } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import type { ComponentProps, ReactNode } from "react";
import { Children, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Text as TroikaText } from "troika-three-text";

import { FONT_URL } from "@/features/office/scene3d/assets";

import { keepCoveredGlyphs } from "@/features/office/scene3d/glyphs";

export { keepCoveredGlyphs };

function sanitize(node: ReactNode): ReactNode {
  if (typeof node === "string") return keepCoveredGlyphs(node);
  if (typeof node === "number") return node;
  if (Array.isArray(node)) return Children.toArray(node).map((n) => sanitize(n));
  return node;
}

// props 는 drei <Text> 와 같다. font 는 항상 번들 글꼴이다(원본 장면의 font={undefined} 도 덮는다).
export function Text({
  children,
  sdfGlyphSize = 64,
  anchorX = "center",
  anchorY = "middle",
  fontSize = 1,
  characters: _characters, // drei 가 미리 받을 글자로 쓰던 값 — 미리 받지 않으므로 버린다
  onSync,
  ...rest
}: ComponentProps<typeof DreiText>) {
  const invalidate = useThree((s) => s.invalidate);
  const [mesh] = useState(() => new TroikaText());
  // 글자는 troika 의 text 로, 그 밖의 자식(재질 등)은 그대로 붙인다(drei 와 같다)
  const [nodes, text] = useMemo(() => {
    const n: ReactNode[] = [];
    let t = "";
    Children.forEach(sanitize(children), (child) => {
      if (typeof child === "string" || typeof child === "number") t += child;
      else n.push(child);
    });
    return [n, t];
  }, [children]);
  useLayoutEffect(() => {
    mesh.sync(() => {
      invalidate();
      onSync?.(mesh);
    });
  });
  useEffect(() => () => mesh.dispose(), [mesh]);
  return (
    <primitive
      object={mesh}
      {...rest}
      font={FONT_URL}
      text={text}
      anchorX={anchorX}
      anchorY={anchorY}
      fontSize={fontSize}
      sdfGlyphSize={sdfGlyphSize}
    >
      {nodes}
    </primitive>
  );
}
