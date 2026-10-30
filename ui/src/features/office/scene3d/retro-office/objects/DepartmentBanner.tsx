/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// AAS: 부서 슬로건·목표 현수막(스펙 2026-10-15-018). 애드벌룬 두 개의 바구니에 매단 천에 문구를 크게 쓴다. 천의 양끝은 일자로 자른다.
// 천은 쪼갠 평면을 정점 셰이더로 흔든다(바람에 펄럭임: 가운데는 크게, 바구니에 묶인 네 모서리는 작게). 문구는 캔버스 그림으로 천에 붙여 천과 함께 굽이친다.
// 색은 DESIGN.md 모노크롬 + 브랜드 레드다(tokens.ts BANNER_PALETTE·BALLOON_PALETTE, 스펙 OMAI-1246). 애드벌룬은 Poly Pizza 의 「Hot air balloon」(Poly by Google, CC BY 3.0, THIRD_PARTY_NOTICES.md)이다.
// 카메라 앞 화면 위쪽 띠에 고정한다 — 사용자가 장면을 회전·이동해도 건물 위로 내려오지 않는다. 크기는 화면 픽셀로 정한다.
// 처음 구도는 RetroOffice3D 가 건물 위에 이 띠만큼 비워 둔다(banner.ts fitOverview). 사용자가 처음보다 많이 확대하면 숨는다.
import { useGLTF } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { memo, Suspense, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

import {
  type Banner,
  BANNER_HIDE_ZOOM_RATIO,
  BANNER_MIN_CANVAS_W,
  bandHeight,
  bannerShift,
  layoutBanner,
  pickBanner,
} from "@/features/office/banner";
import { BALLOON_URL, FONT_URL } from "@/features/office/scene3d/assets";
import { BALLOON_PALETTE, BANNER_PALETTE, prefersReducedMotion } from "@/features/office/tokens";

const FADE_S = 0.2;
const DISTANCE = 4; // 카메라 앞 거리(직교라 크기와 무관). 장면의 가장 가까운 물체보다 앞이라 깊이 검사를 켠 채로 위에 그려진다
type Palette = (typeof BANNER_PALETTE)[keyof typeof BANNER_PALETTE];

// ---- 글꼴: 번들 한글 글꼴을 캔버스에 쓰려고 한 번만 등록한다 -------------------------------------------------------------
const FONT_FAMILY = "AasBannerFont";
let fontPromise: Promise<void> | null = null;
function loadFont(): Promise<void> {
  if (fontPromise) return fontPromise;
  fontPromise =
    typeof FontFace === "undefined"
      ? Promise.resolve()
      : new FontFace(FONT_FAMILY, `url(${FONT_URL})`)
          .load()
          .then((f) => {
            document.fonts.add(f);
          })
          .catch(() => undefined);
  return fontPromise;
}

// ---- 천 셰이더 -----------------------------------------------------------------------------------------------------------
// 위치 P(u,v): 픽셀 단위 평면을 (1) 가운데가 처지는 곡선, (2) 진행하는 물결로 바꾼다. 양끝은 리본처럼 가늘어지거나 V 로 파이지 않고 일자로 자른다(사용자 2026-10-15).
// 물결 크기는 가운데가 크고 바구니에 묶인 끝은 작다. 법선은 P 를 u·v 로 조금씩 옮겨 구해 빛을 받는 정도를 정한다.
const VERT = /* glsl */ `
uniform vec2 uSize;
uniform float uTime;
uniform float uWave;
varying vec2 vUv;
varying vec3 vN;
vec3 P(vec2 uv) {
  float u = uv.x, v = uv.y;
  float ends = sin(3.14159265 * u);
  float env = mix(0.22, 1.0, pow(max(ends, 0.0), 0.8));
  float ph = 6.2831853 * (1.45 * u + 0.12 * v) - uTime * 2.3;
  float sag = -uSize.y * 0.07 * (1.0 - pow(2.0 * u - 1.0, 2.0));
  float x = (u - 0.5) * uSize.x + uWave * uSize.y * 0.05 * sin(ph * 0.5 + 1.0) * env;
  float y = (v - 0.5) * uSize.y + sag + uWave * uSize.y * 0.085 * sin(ph + 0.6) * env;
  float z = uWave * uSize.y * 0.22 * sin(ph) * env;
  return vec3(x, y, z);
}
void main() {
  vUv = uv;
  vec3 p = P(uv);
  float e = 0.004;
  vec3 du = P(uv + vec2(e, 0.0)) - P(uv - vec2(e, 0.0));
  vec3 dv = P(uv + vec2(0.0, e)) - P(uv - vec2(0.0, e));
  vN = normalize(cross(du, dv));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform float uOpacity;
varying vec2 vUv;
varying vec3 vN;
void main() {
  vec4 tex = texture2D(uMap, vUv);
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  float lit = 0.68 + 0.32 * max(dot(n, normalize(vec3(-0.35, 0.45, 0.82))), 0.0);
  gl_FragColor = vec4(tex.rgb * lit, uOpacity);
  #include <colorspace_fragment>
}`;

function drawCloth(
  canvas: HTMLCanvasElement,
  layout: { clothW: number; clothH: number; lines: string[]; fontPx: number; teamPx: number },
  team: string,
  pal: Palette
) {
  const k = canvas.width / layout.clothW;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width: w, height: h } = canvas;
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, pal.clothA);
  g.addColorStop(1, pal.clothB);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // 윗단은 브랜드 레드 띠(로그인 카드의 윗선과 같다), 아랫단은 가는 회색 선. 박음질 점선은 두지 않는다
  ctx.fillStyle = pal.edge;
  ctx.fillRect(0, 0, w, 5 * k);
  ctx.fillStyle = pal.line;
  ctx.fillRect(0, h - 2 * k, w, 2 * k);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const fam = `"${FONT_FAMILY}", "Noto Sans KR", sans-serif`;
  ctx.fillStyle = pal.team;
  ctx.font = `${layout.teamPx * k}px ${fam}`;
  ctx.fillText(team, w / 2, h * 0.2);
  ctx.fillStyle = pal.text;
  ctx.font = `${layout.fontPx * k}px ${fam}`;
  const lh = layout.fontPx * 1.2 * k;
  const top = h * 0.58 - ((layout.lines.length - 1) * lh) / 2;
  layout.lines.forEach((ln, i) => ctx.fillText(ln, w / 2, top + i * lh));
}

function Cloth({ banner, layout, reduced, alpha, pal }: { banner: Banner; layout: ReturnType<typeof layoutBanner>; reduced: boolean; alpha: React.MutableRefObject<number>; pal: Palette }) {
  const [fontReady, setFontReady] = useState(false);
  useEffect(() => {
    let live = true;
    void loadFont().then(() => live && setFontReady(true));
    return () => {
      live = false;
    };
  }, []);
  const tex = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = Math.min(2048, Math.round(layout.clothW * 2));
    c.height = Math.round((c.width * layout.clothH) / layout.clothW);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }, [layout.clothW, layout.clothH]);
  useEffect(() => {
    drawCloth(tex.image as HTMLCanvasElement, layout, banner.team, pal);
    tex.needsUpdate = true;
  }, [tex, layout, banner.team, fontReady, pal]);
  useEffect(() => () => tex.dispose(), [tex]);
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: { uMap: { value: tex }, uSize: { value: new THREE.Vector2(1, 1) }, uTime: { value: 0 }, uWave: { value: 1 }, uOpacity: { value: 1 } },
        transparent: true,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    [tex]
  );
  useEffect(() => () => mat.dispose(), [mat]);
  mat.uniforms.uSize.value.set(layout.clothW, layout.clothH);
  useFrame((state) => {
    mat.uniforms.uTime.value = reduced ? 0.9 : state.clock.elapsedTime; // 움직임 줄이기: 한 장면에 멈춘 물결
    mat.uniforms.uWave.value = reduced ? 0.7 : 1;
    mat.uniforms.uOpacity.value = alpha.current;
  });
  return (
    <mesh frustumCulled={false}>
      <planeGeometry args={[1, 1, 80, 14]} />
      <primitive object={mat} attach="material" />
    </mesh>
  );
}

// 애드벌룬 모델의 색 판(256x256 평면 색 네 칸)을 같은 배치의 새 색으로 바꾼다. 칸: 왼쪽 위 줄무늬(흰), 오른쪽 위 장식(회), 왼쪽 아래 몸통(원본 청록), 오른쪽 아래 바구니(갈색)·그늘(먹색).
let balloonAtlas: THREE.CanvasTexture | null = null;
function balloonTexture(): THREE.CanvasTexture {
  if (balloonAtlas) return balloonAtlas;
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const ctx = c.getContext("2d");
  if (ctx) {
    const cell = (color: string, x: number, y: number, w: number, h: number) => {
      ctx.fillStyle = color;
      ctx.fillRect(x, y, w, h);
    };
    cell(BALLOON_PALETTE.stripe, 0, 0, 128, 128);
    cell(BALLOON_PALETTE.trim, 128, 0, 128, 128);
    cell(BALLOON_PALETTE.envelope, 0, 128, 128, 128);
    cell(BALLOON_PALETTE.basket, 128, 128, 64, 128);
    cell(BALLOON_PALETTE.ink, 192, 128, 64, 128);
  }
  const t = new THREE.CanvasTexture(c);
  t.flipY = false; // glTF 의 UV 규약
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = t.minFilter = THREE.NearestFilter; // 칸 경계가 번지지 않게
  t.generateMipmaps = false;
  balloonAtlas = t;
  return t;
}

function Balloon({ x, y, height, phase, reduced, alpha }: { x: number; y: number; height: number; phase: number; reduced: boolean; alpha: React.MutableRefObject<number> }) {
  const gltf = useGLTF(BALLOON_URL, false);
  const { obj, scale } = useMemo(() => {
    const o = gltf.scene.clone(true);
    o.traverse((m) => {
      const mesh = m as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      const mt = (mesh.material as THREE.Material).clone() as THREE.MeshStandardMaterial;
      mt.map = balloonTexture();
      mt.needsUpdate = true;
      mt.transparent = true;
      mt.userData.base = mt.opacity;
      mesh.material = mt;
    });
    const box = new THREE.Box3().setFromObject(o);
    const c = box.getCenter(new THREE.Vector3());
    o.position.sub(c);
    return { obj: o, scale: height / (box.max.y - box.min.y) };
  }, [gltf, height]);
  const g = useRef<THREE.Group>(null);
  const applied = useRef(-1);
  useFrame((state) => {
    if (g.current) {
      const t = reduced ? 0 : state.clock.elapsedTime;
      g.current.rotation.y = 0.45 + Math.sin(t * 0.7 + phase) * 0.28; // 돌아가며 입체로 보인다
      g.current.rotation.z = Math.sin(t * 0.9 + phase) * 0.035;
      g.current.position.y = y + Math.sin(t * 1.05 + phase) * 2.5;
    }
    if (alpha.current !== applied.current) {
      applied.current = alpha.current;
      obj.traverse((m) => {
        const mt = (m as THREE.Mesh).material as THREE.Material | undefined;
        if (mt && mt.userData.base !== undefined) mt.opacity = (mt.userData.base as number) * alpha.current;
      });
    }
  });
  return (
    <group ref={g} position={[x, y, 0]} scale={scale}>
      <primitive object={obj} />
    </group>
  );
}

function Rope({ a, b, color }: { a: [number, number]; b: [number, number]; color: string }) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
  return (
    <mesh position={[(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, -0.5]} rotation={[0, 0, ang]}>
      <planeGeometry args={[len, 1.6]} />
      <meshBasicMaterial color={color} toneMapped={false} />
    </mesh>
  );
}

export const DepartmentBanner = memo(function DepartmentBanner({
  banners,
  mine,
  overviewZoom,
  visible,
  theme,
}: {
  banners: Banner[];
  mine: string;
  /** 처음 구도의 확대 배율. 이보다 많이 확대하면 숨는다. */
  overviewZoom: number;
  visible: boolean;
  /** 콘솔 테마. Canvas 안에서는 React 컨텍스트를 못 받으므로 밖에서 넘겨 준다. */
  theme: "dark" | "light";
}) {
  const pal = BANNER_PALETTE[theme];
  const { camera, size } = useThree();
  const reduced = useMemo(() => prefersReducedMotion(), []);
  const t0 = useRef(Date.now()); // 화면을 연 때. 내 부서 문구가 먼저 보이고 12초마다 다음으로 간다
  const [shown, setShown] = useState<Banner | null>(() => pickBanner(banners, mine, 0, reduced));
  const wantRef = useRef<Banner | null>(shown);
  const root = useRef<THREE.Group>(null);
  const alpha = useRef(0);

  // 목록이나 내 부서가 바뀌면 보일 문구를 다시 정한다. 시간이 지나 문구가 달라질 때도 1초마다 확인한다(바꿈 자체는 useFrame 이 한다)
  useEffect(() => {
    const decide = () => {
      wantRef.current = pickBanner(banners, mine, Date.now() - t0.current, reduced);
    };
    decide();
    const id = window.setInterval(decide, 1000);
    return () => window.clearInterval(id);
  }, [banners, mine, reduced]);

  const key = (b: Banner | null) => (b ? `${b.team}\n${b.goal}` : "");
  const layout = useMemo(() => (shown ? layoutBanner(shown.goal, size.width, size.height) : null), [shown, size.width, size.height]);

  const up = useMemo(() => new THREE.Vector3(), []);
  const fwd = useMemo(() => new THREE.Vector3(), []);
  const right = useMemo(() => new THREE.Vector3(), []);
  useFrame((_state, delta) => {
    const g = root.current;
    if (!g || !(camera instanceof THREE.OrthographicCamera)) return;
    const hide = !visible || camera.zoom > overviewZoom * BANNER_HIDE_ZOOM_RATIO;
    const swapping = key(wantRef.current) !== key(shown);
    const goal = hide || swapping || !wantRef.current ? 0 : 1;
    const step = reduced ? 1 : delta / FADE_S;
    alpha.current = goal > alpha.current ? Math.min(goal, alpha.current + step) : Math.max(goal, alpha.current - step);
    if (alpha.current === 0 && swapping) setShown(wantRef.current);
    g.visible = alpha.current > 0.01 && !!shown;
    if (!g.visible) return;
    // 카메라 앞, 화면 위쪽 띠의 가운데에 둔다(캔버스 높이 H, 띠 높이 band: 가운데에서 위로 (H − band)/2 − 4 픽셀)
    const band = bandHeight(size.height);
    const z = camera.zoom;
    up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    const shiftPx = layout ? bannerShift(size.width, size.height, layout.clothW) : 0; // 명단 상자를 피해 왼쪽으로 옮길 때
    g.position.copy(camera.position).addScaledVector(up, ((size.height - band) / 2 - 9) / z).addScaledVector(right, shiftPx / z).addScaledVector(fwd, DISTANCE);
    g.quaternion.copy(camera.quaternion);
    g.scale.setScalar(1 / z);
  });

  if (!shown || !layout || size.width < BANNER_MIN_CANVAS_W) return null;
  const band = bandHeight(size.height);
  const { clothW, clothH } = layout;
  const balloonH = band * 0.92;
  const balloonW = balloonH * 0.82;
  const by = band * 0.04; // 애드벌룬 가운데 높이: 위 끝이 띠 위쪽, 바구니 끝이 띠의 아래에서 0.08 위
  const bx = clothW / 2 + balloonW * 0.42;
  const clothCy = -band / 2 + clothH / 2;
  const tipTop = clothCy + clothH * 0.5; // 양끝이 일자라 줄은 천 끝의 위·아래 모서리에 묶인다
  const tipBot = clothCy - clothH * 0.5;
  const basketY = by - balloonH / 2 + balloonH * 0.06;
  return (
    <group ref={root} visible={false}>
      <Rope a={[-bx, basketY]} b={[-clothW / 2, tipTop]} color={pal.rope} />
      <Rope a={[-bx, basketY]} b={[-clothW / 2, tipBot]} color={pal.rope} />
      <Rope a={[bx, basketY]} b={[clothW / 2, tipTop]} color={pal.rope} />
      <Rope a={[bx, basketY]} b={[clothW / 2, tipBot]} color={pal.rope} />
      <group position={[0, clothCy, 0]}>
        <Cloth banner={shown} layout={layout} reduced={reduced} alpha={alpha} pal={pal} />
      </group>
      <Suspense fallback={null}>
        <Balloon x={-bx} y={by} height={balloonH} phase={0} reduced={reduced} alpha={alpha} />
        <Balloon x={bx} y={by} height={balloonH} phase={2.1} reduced={reduced} alpha={alpha} />
      </Suspense>
    </group>
  );
});
