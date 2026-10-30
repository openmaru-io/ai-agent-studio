"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import * as THREE from "three";
import {
  DOOR_LENGTH,
  DOOR_THICKNESS,
  SCALE,
  WALL_THICKNESS,
} from "@/features/office/scene3d/retro-office/core/constants";
import { BASEBOARD, wallBaseboardDepth } from "@/features/office/scene3d/retro-office/core/baseboard";
import { doorTouched } from "@/features/office/scene3d/retro-office/core/doorTouch";
import { getItemBaseSize, getItemRotationRadians, toWorld } from "@/features/office/scene3d/retro-office/core/geometry";
import type { FurnitureItem, RenderAgent } from "@/features/office/scene3d/retro-office/core/types";
import type {
  BasicFurnitureModelProps,
  InteractiveFurnitureModelProps,
} from "@/features/office/scene3d/retro-office/objects/types";
import { useScenePalette } from "@/features/office/scenePaletteContext";

type DoorModelProps = InteractiveFurnitureModelProps & {
  agentsRef?: RefObject<RenderAgent[]>;
  /** AAS: 사람 아바타 목록(AasPeopleLayer). Claw3D 에이전트와 따로 움직인다 */
  peopleRef?: RefObject<RenderAgent[]>;
};

/**
 * AAS: 편집 모드의 선택·호버 외곽선(스펙 2026-10-20-012 E1). 원본은 재질 emissive 로 강조했는데, emissive 는 색을 더하기만 해
 * 라이트 테마의 어두운 선택색(#111827)이 보이지 않았다. box 는 그 객체의 로컬 좌표 상자다. 깊이 검사를 꺼 가구에 가려지지 않는다.
 */
export function SelectionOutline({ box, selected, hovered }: { box: THREE.Box3; selected: boolean; hovered: boolean }) {
  const { palette } = useScenePalette();
  const geometry = useMemo(() => {
    const size = box.getSize(new THREE.Vector3());
    return new THREE.EdgesGeometry(new THREE.BoxGeometry(Math.max(size.x * 1.02, 0.01), Math.max(size.y * 1.02, 0.01), Math.max(size.z * 1.02, 0.01)));
  }, [box]);
  const center = useMemo(() => box.getCenter(new THREE.Vector3()), [box]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  if (!selected && !hovered) return null;
  return (
    <lineSegments geometry={geometry} position={center} renderOrder={10}>
      <lineBasicMaterial color={palette.selection.color} transparent opacity={selected ? 1 : palette.selection.hoverOpacity} depthTest={false} toneMapped={false} />
    </lineSegments>
  );
}

/** 너비·높이·깊이(가운데가 원점, 바닥이 0) 상자. 코드로 그리는 객체의 선택 외곽선에 쓴다. */
export const boxOf = (width: number, height: number, depth: number, centerY = height / 2) =>
  new THREE.Box3(new THREE.Vector3(-width / 2, centerY - height / 2, -depth / 2), new THREE.Vector3(width / 2, centerY + height / 2, depth / 2));

export function InstancedWallSegmentsModel({
  items,
  height = 1,
  color,
  opacity = 1,
}: {
  items: FurnitureItem[];
  /** AAS: 칸막이(낮은 벽)·유리벽도 같은 함수로 그린다(계획 2026-10-13-001). */
  height?: number;
  color?: string;
  opacity?: number;
}) {
  const { palette } = useScenePalette();
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const matrices = useMemo(() => {
    const tempQuaternion = new THREE.Quaternion();
    const tempPosition = new THREE.Vector3();
    const tempScale = new THREE.Vector3();
    return items.map((item) => {
      const [wx, , wz] = toWorld(item.x, item.y);
      const width = (item.w ?? 80) * SCALE;
      const depth = (item.h ?? WALL_THICKNESS) * SCALE;
      const rotY = getItemRotationRadians(item);
      tempPosition.set(wx + width / 2, (item.elevation ?? 0) + height / 2, wz + depth / 2);
      tempQuaternion.setFromEuler(new THREE.Euler(0, rotY, 0));
      tempScale.set(width, height, depth);
      return new THREE.Matrix4().compose(
        tempPosition.clone(),
        tempQuaternion.clone(),
        tempScale.clone(),
      );
    });
  }, [items, height]);

  useLayoutEffect(() => {
    if (!meshRef.current) return;
    for (let index = 0; index < matrices.length; index += 1) {
      meshRef.current.setMatrixAt(index, matrices[index]);
    }
    meshRef.current.instanceMatrix.needsUpdate = true;
    meshRef.current.computeBoundingSphere();
  }, [matrices]);

  if (items.length === 0) return null;

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, items.length]} receiveShadow>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial
        color={color ?? palette.innerWall}
        roughness={opacity < 1 ? 0.1 : 0.92}
        transparent={opacity < 1}
        opacity={opacity}
        depthWrite={opacity >= 1}
      />
    </instancedMesh>
  );
}

export function RoundTableModel({
  item,
  isSelected,
  isHovered,
  editMode,
  onPointerDown,
  onPointerOver,
  onPointerOut,
  onClick,
}: InteractiveFurnitureModelProps) {
  const [wx, , wz] = toWorld(item.x, item.y);
  const radius = (item.r ?? 60) * SCALE;
  const height = 0.5;
  const topThickness = 0.04;
  const { palette } = useScenePalette();
  const outline = useMemo(() => boxOf(radius * 2, height + topThickness, radius * 2), [radius]);

  return (
    <group
      position={[wx, item.elevation ?? 0, wz]}
      onPointerDown={(event) => {
        event.stopPropagation();
        onPointerDown(item._uid);
      }}
      onPointerOver={(event) => {
        event.stopPropagation();
        onPointerOver(item._uid);
      }}
      onPointerOut={(event) => {
        event.stopPropagation();
        onPointerOut();
      }}
      onClick={(event) => {
        event.stopPropagation();
        onClick?.(item._uid);
      }}
    >
      <group position={[radius, 0, radius]}>
        <mesh position={[0, height, 0]} receiveShadow castShadow>
          <cylinderGeometry args={[radius, radius, topThickness, 64]} />
          <meshStandardMaterial color={palette.wood.oak} roughness={0.6} metalness={0.1} />
        </mesh>
        <mesh position={[0, height / 2, 0]} castShadow>
          <cylinderGeometry args={[0.06, 0.06, height, 16]} />
          <meshStandardMaterial color={palette.metalLeg} roughness={0.8} />
        </mesh>
        <mesh position={[0, 0.02, 0]}>
          <cylinderGeometry args={[radius * 0.4, radius * 0.45, 0.04, 32]} />
          <meshStandardMaterial color={palette.metalLeg} roughness={0.8} />
        </mesh>
        <SelectionOutline box={outline} selected={isSelected} hovered={isHovered && editMode} />
      </group>
    </group>
  );
}

export function WallSegmentModel({
  item,
  isSelected,
  isHovered,
  editMode,
  onPointerDown,
  onPointerOver,
  onPointerOut,
  onClick,
}: InteractiveFurnitureModelProps) {
  const [wx, , wz] = toWorld(item.x, item.y);
  const width = (item.w ?? 80) * SCALE;
  const depth = (item.h ?? WALL_THICKNESS) * SCALE;
  const rotY = getItemRotationRadians(item);
  const { palette } = useScenePalette();
  // AAS: 편집 모드 벽도 일반 장면과 같은 색이다 — 벽 종류별로 안쪽 벽·칸막이·유리(스펙 2026-10-20-012 D7)
  const glassWall = item.type === "glass_wall";
  const wallColor = glassWall ? palette.glass.color : item.type === "partition" ? palette.partition : palette.innerWall;
  const wallOpacity = glassWall ? palette.glass.opacity : 1;
  const outline = useMemo(() => boxOf(width, 1, depth), [width, depth]);

  return (
    <group
      position={[wx, item.elevation ?? 0, wz]}
      onPointerDown={(event) => {
        event.stopPropagation();
        onPointerDown(item._uid);
      }}
      onPointerOver={(event) => {
        event.stopPropagation();
        onPointerOver(item._uid);
      }}
      onPointerOut={(event) => {
        event.stopPropagation();
        onPointerOut();
      }}
      onClick={(event) => {
        event.stopPropagation();
        onClick?.(item._uid);
      }}
    >
      <group position={[width / 2, 0, depth / 2]} rotation={[0, rotY, 0]}>
        <mesh position={[0, 0.5, 0]} receiveShadow>
          <boxGeometry args={[width, 1, depth]} />
          <meshStandardMaterial
            color={wallColor}
            roughness={glassWall ? 0.1 : 0.92}
            transparent={glassWall}
            opacity={wallOpacity}
            depthWrite={!glassWall}
          />
        </mesh>
        {/* AAS(2026-10-20): 걸레받이를 벽보다 양쪽으로 조금 두껍게(core/baseboard.ts). 벽 두께와 같으면 앞뒤 면이 겹쳐 깜빡였다 */}
        <mesh position={[0, BASEBOARD.height / 2, 0]}>
          <boxGeometry args={[width + 0.02, BASEBOARD.height, wallBaseboardDepth(depth)]} />
          <meshStandardMaterial color={palette.baseboard} roughness={0.8} />
        </mesh>
        <SelectionOutline box={outline} selected={isSelected} hovered={isHovered && editMode} />
      </group>
    </group>
  );
}

export function DoorModel({
  item,
  isSelected,
  isHovered,
  editMode,
  agentsRef,
  peopleRef,
  onPointerDown,
  onPointerOver,
  onPointerOut,
  onClick,
}: DoorModelProps) {
  const [wx, , wz] = toWorld(item.x, item.y);
  const width = (item.w ?? DOOR_LENGTH) * SCALE;
  const depth = Math.max((item.h ?? DOOR_THICKNESS) * SCALE, 0.04);
  const rotY = getItemRotationRadians(item);
  const { palette } = useScenePalette();
  const outline = useMemo(() => boxOf(width, 1.05, depth), [width, depth]);
  const handleX = width - 0.09;
  const handleZ = Math.max(depth * 0.28, 0.035);
  const leafPivotRef = useRef<THREE.Group>(null);
  const openAmountRef = useRef(0);
  // AAS: 회의실 문은 유리문이다(glass). 틀은 짙은 금속, 문짝은 반투명 유리
  const glass = item.glass === true;
  const frameColor = glass ? palette.glassFrame : palette.wood.walnut;

  useFrame(() => {
    if (!leafPivotRef.current) return;
    // AAS: 바닥 두 번 누르기로 걷는 사람 아바타(peopleRef)도 문을 연다(2026-10-20, 그전에는 문을 뚫고 지나갔다)
    const shouldOpen = doorTouched(item, agentsRef?.current, peopleRef?.current);
    const targetOpen = shouldOpen ? 1 : 0;
    openAmountRef.current = THREE.MathUtils.lerp(openAmountRef.current, targetOpen, 0.14);
    leafPivotRef.current.rotation.y = -openAmountRef.current * Math.PI * 0.55;
  });

  return (
    <group
      position={[wx, item.elevation ?? 0, wz]}
      onPointerDown={(event) => {
        event.stopPropagation();
        onPointerDown(item._uid);
      }}
      onPointerOver={(event) => {
        event.stopPropagation();
        onPointerOver(item._uid);
      }}
      onPointerOut={(event) => {
        event.stopPropagation();
        onPointerOut();
      }}
      onClick={(event) => {
        event.stopPropagation();
        onClick?.(item._uid);
      }}
    >
      <group position={[width / 2, 0, depth / 2]} rotation={[0, rotY, 0]}>
        <mesh position={[0, 1.01, 0]}>
          <boxGeometry args={[width + 0.05, 0.08, depth + 0.04]} />
          <meshStandardMaterial color={frameColor} roughness={glass ? 0.5 : 0.88} metalness={glass ? 0.4 : 0} />
        </mesh>
        <mesh position={[-width / 2 + 0.02, 0.5, 0]}>
          <boxGeometry args={[0.04, 1, depth + 0.03]} />
          <meshStandardMaterial color={frameColor} roughness={glass ? 0.5 : 0.88} metalness={glass ? 0.4 : 0} />
        </mesh>
        <mesh position={[width / 2 - 0.02, 0.5, 0]}>
          <boxGeometry args={[0.04, 1, depth + 0.03]} />
          <meshStandardMaterial color={frameColor} roughness={glass ? 0.5 : 0.88} metalness={glass ? 0.4 : 0} />
        </mesh>
        <group ref={leafPivotRef} position={[-width / 2 + 0.025, 0, 0]}>
          <mesh position={[width / 2 - 0.035, 0.5, 0]} receiveShadow>
            <boxGeometry args={[Math.max(width - 0.09, 0.08), 0.94, depth * 0.68]} />
            {glass ? (
              <meshStandardMaterial
                color={palette.glass.color}
                roughness={0.1}
                metalness={0.1}
                transparent
                opacity={palette.glass.opacity}
                depthWrite={false}
              />
            ) : (
              <meshStandardMaterial color={palette.wood.walnut} roughness={0.74} />
            )}
          </mesh>
          <mesh position={[handleX, 0.52, 0]}>
            <cylinderGeometry args={[0.008, 0.008, handleZ * 2.1, 10]} />
            <meshStandardMaterial color={palette.doorHandle[0]} roughness={0.4} metalness={0.45} />
          </mesh>
          <mesh position={[handleX, 0.52, handleZ]}>
            <sphereGeometry args={[0.025, 12, 12]} />
            <meshStandardMaterial color={palette.doorHandle[1]} roughness={0.36} metalness={0.35} />
          </mesh>
          <mesh position={[handleX, 0.52, -handleZ]}>
            <sphereGeometry args={[0.025, 12, 12]} />
            <meshStandardMaterial color={palette.doorHandle[1]} roughness={0.36} metalness={0.35} />
          </mesh>
        </group>
        <SelectionOutline box={outline} selected={isSelected} hovered={isHovered && editMode} />
      </group>
    </group>
  );
}

/** AAS: fit 이 켜진 책상 소품(키보드·마우스)은 자리 상자 가운데에 놓고 책상 방향(facing)으로 돌린다.
 *  원본은 항목 좌표(모서리)에 방향 없이 그려, 세로로 놓인 책상에서도 키보드가 가로로 놓이고 상자에서 비켜 보였다. */
function deskItemPlacement(item: FurnitureItem): { position: [number, number]; rotY: number } {
  if (!item.fit) {
    const [wx, , wz] = toWorld(item.x, item.y);
    return { position: [wx, wz], rotY: 0 };
  }
  const { width, height } = getItemBaseSize(item);
  const [wx, , wz] = toWorld(item.x + width / 2, item.y + height / 2);
  return { position: [wx, wz], rotY: getItemRotationRadians(item) };
}

export function KeyboardModel({
  item,
  onPointerDown,
  onPointerOver,
  onPointerOut,
  editMode,
}: BasicFurnitureModelProps) {
  const { position: [wx, wz], rotY } = deskItemPlacement(item);
  const yBase = 0.621;

  return (
    <group
      position={[wx, yBase, wz]}
      rotation={[0, rotY, 0]}
      onPointerDown={(event) => {
        if (!editMode) return;
        event.stopPropagation();
        onPointerDown?.(item._uid);
      }}
      onPointerOver={(event) => {
        if (!editMode) return;
        event.stopPropagation();
        onPointerOver?.(item._uid);
      }}
      onPointerOut={(event) => {
        if (!editMode) return;
        event.stopPropagation();
        onPointerOut?.();
      }}
    >
      <mesh>
        <boxGeometry args={[0.27, 0.022, 0.105]} />
        <meshStandardMaterial color="#b2bac4" roughness={0.7} metalness={0.05} />
      </mesh>
      <mesh position={[0, 0.018, 0]}>
        <boxGeometry args={[0.23, 0.008, 0.08]} />
        <meshStandardMaterial color="#2e333d" roughness={0.85} metalness={0.02} />
      </mesh>
    </group>
  );
}

export function MouseModel({
  item,
  onPointerDown,
  onPointerOver,
  onPointerOut,
  editMode,
}: BasicFurnitureModelProps) {
  const { position: [wx, wz], rotY } = deskItemPlacement(item);
  const yBase = 0.621;

  return (
    <group
      position={[wx, yBase, wz]}
      rotation={[0, rotY, 0]}
      onPointerDown={(event) => {
        if (!editMode) return;
        event.stopPropagation();
        onPointerDown?.(item._uid);
      }}
      onPointerOver={(event) => {
        if (!editMode) return;
        event.stopPropagation();
        onPointerOver?.(item._uid);
      }}
      onPointerOut={(event) => {
        if (!editMode) return;
        event.stopPropagation();
        onPointerOut?.();
      }}
    >
      <mesh scale={[1, 0.38, 0.72]}>
        <sphereGeometry args={[0.042, 8, 6]} />
        <meshStandardMaterial color="#d0cecc" roughness={0.6} metalness={0.1} />
      </mesh>
      <mesh position={[0, 0.016, -0.008]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.007, 0.007, 0.022, 8]} />
        <meshStandardMaterial color="#444" roughness={0.8} />
      </mesh>
    </group>
  );
}

export function ClockModel({
  item,
  onPointerDown,
  onPointerOver,
  onPointerOut,
  editMode,
}: BasicFurnitureModelProps) {
  const [wx, , wz] = toWorld(item.x, item.y);
  const yBase = 0.72;
  const { palette } = useScenePalette();

  return (
    <group
      position={[wx, yBase, wz]}
      onPointerDown={(event) => {
        if (!editMode) return;
        event.stopPropagation();
        onPointerDown?.(item._uid);
      }}
      onPointerOver={(event) => {
        if (!editMode) return;
        event.stopPropagation();
        onPointerOver?.(item._uid);
      }}
      onPointerOut={(event) => {
        if (!editMode) return;
        event.stopPropagation();
        onPointerOut?.();
      }}
    >
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.09, 0.09, 0.016, 20]} />
        <meshStandardMaterial color="#f5f0e8" roughness={0.55} metalness={0.05} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.09, 0.011, 8, 24]} />
        <meshStandardMaterial color="#2a2a2a" roughness={0.7} />
      </mesh>
      <mesh position={[-0.028, 0.014, -0.012]} rotation={[0, Math.PI / 6, 0]}>
        <boxGeometry args={[0.008, 0.006, 0.052]} />
        <meshStandardMaterial color="#1a1a1a" roughness={0.8} />
      </mesh>
      <mesh position={[0.018, 0.016, -0.018]} rotation={[0, -Math.PI / 5, 0]}>
        <boxGeometry args={[0.006, 0.006, 0.068]} />
        <meshStandardMaterial color="#1a1a1a" roughness={0.8} />
      </mesh>
      <mesh position={[0, 0.018, 0]}>
        <sphereGeometry args={[0.008, 8, 8]} />
        <meshStandardMaterial color={palette.art.clockHand} roughness={0.5} />
      </mesh>
    </group>
  );
}

export function TrashCanModel({
  item,
  onPointerDown,
  onPointerOver,
  onPointerOut,
  editMode,
}: BasicFurnitureModelProps) {
  const [wx, , wz] = toWorld(item.x, item.y);

  return (
    <group
      position={[wx, 0, wz]}
      onPointerDown={(event) => {
        if (!editMode) return;
        event.stopPropagation();
        onPointerDown?.(item._uid);
      }}
      onPointerOver={(event) => {
        if (!editMode) return;
        event.stopPropagation();
        onPointerOver?.(item._uid);
      }}
      onPointerOut={(event) => {
        if (!editMode) return;
        event.stopPropagation();
        onPointerOut?.();
      }}
    >
      <mesh position={[0, 0.115, 0]}>
        <cylinderGeometry args={[0.055, 0.042, 0.23, 10]} />
        <meshStandardMaterial color="#4a4e58" roughness={0.8} metalness={0.12} />
      </mesh>
      <mesh position={[0, 0.234, 0]}>
        <cylinderGeometry args={[0.057, 0.057, 0.01, 10]} />
        <meshStandardMaterial color="#363940" roughness={0.7} metalness={0.18} />
      </mesh>
    </group>
  );
}

export function MugModel({
  item,
  onPointerDown,
  onPointerOver,
  onPointerOut,
  editMode,
}: BasicFurnitureModelProps) {
  const [wx, , wz] = toWorld(item.x, item.y);
  const yBase = 0.45;

  return (
    <group
      position={[wx, yBase, wz]}
      onPointerDown={(event) => {
        if (!editMode) return;
        event.stopPropagation();
        onPointerDown?.(item._uid);
      }}
      onPointerOver={(event) => {
        if (!editMode) return;
        event.stopPropagation();
        onPointerOver?.(item._uid);
      }}
      onPointerOut={(event) => {
        if (!editMode) return;
        event.stopPropagation();
        onPointerOut?.();
      }}
    >
      <mesh>
        <cylinderGeometry args={[0.025, 0.022, 0.052, 10]} />
        <meshStandardMaterial color="#e8ded0" roughness={0.6} metalness={0.02} />
      </mesh>
      <mesh position={[0.033, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <torusGeometry args={[0.016, 0.006, 6, 12, Math.PI]} />
        <meshStandardMaterial color="#e8ded0" roughness={0.6} metalness={0.02} />
      </mesh>
    </group>
  );
}

/** AAS(2026-10-20-012 E1): 코드로 그리는 장치·소품(machines·Jukebox·kitchen·책상 소품)의 선택·호버 외곽선.
 *  이 종류들은 원본에서 각자 emissive 로 강조했다. GLB 가구·벽·문·둥근 탁자는 자기 외곽선을 그린다. */
export const SCENE_OUTLINE_TYPES = new Set([
  "atm", "clock", "device_rack", "dishwasher", "dumbbell_rack", "exercise_bike", "jukebox", "kettlebell_rack", "keyboard",
  "microwave", "mouse", "mug", "phone_booth", "pingpong", "punching_bag", "qa_terminal", "rowing_machine", "server_rack",
  "server_terminal", "sink", "sms_booth", "stove", "test_bench", "trash", "treadmill", "vending", "wall_cabinet",
  "weight_bench", "yoga_mat",
]);

function ItemOutline({ item, selected, hovered }: { item: FurnitureItem; selected: boolean; hovered: boolean }) {
  const [wx, , wz] = toWorld(item.x, item.y);
  const { width, height } = getItemBaseSize(item);
  const w = width * SCALE;
  const d = height * SCALE;
  const box = useMemo(() => boxOf(w, 1, d), [w, d]);
  return (
    <group position={[wx, item.elevation ?? 0, wz]}>
      <group position={[w / 2, 0, d / 2]} rotation={[0, getItemRotationRadians(item), 0]}>
        <SelectionOutline box={box} selected={selected} hovered={hovered} />
      </group>
    </group>
  );
}

export function ItemSelectionOutlines({
  furniture,
  selectedUid,
  hoverUid,
}: {
  furniture: FurnitureItem[];
  selectedUid: string | null;
  hoverUid: string | null;
}) {
  const targets = furniture.filter((item) => SCENE_OUTLINE_TYPES.has(item.type) && (item._uid === selectedUid || item._uid === hoverUid));
  return (
    <>
      {targets.map((item) => (
        <ItemOutline key={item._uid} item={item} selected={item._uid === selectedUid} hovered={item._uid === hoverUid} />
      ))}
    </>
  );
}
