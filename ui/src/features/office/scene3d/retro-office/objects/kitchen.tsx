import { SCALE } from "@/features/office/scene3d/retro-office/core/constants";
import { getItemBaseSize, getItemRotationRadians, toWorld } from "@/features/office/scene3d/retro-office/core/geometry";
import type { FurnitureItem } from "@/features/office/scene3d/retro-office/core/types";
import { BasicFurnitureModelProps } from "@/features/office/scene3d/retro-office/objects/types";
import { useScenePalette } from "@/features/office/scenePaletteContext";

// AAS: 탕비실 가구 색은 장면 색 표의 역할 색이다(스펙 2026-10-20-012 §3-2·§3-7) — 흰 무광 수납장, 짙은 상판, 금속, 짙은 부품.
// 원본의 빨간 자판기 앞판·청록 유리·초록 표시등은 쓰지 않는다.

export function VendingMachineModel({
  item,
  onPointerDown,
  onPointerOver,
  onPointerOut,
  editMode,
}: BasicFurnitureModelProps) {
  const { palette } = useScenePalette();
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
      <mesh position={[0, 0.4, 0]}>
        <boxGeometry args={[0.35, 0.8, 0.26]} />
        <meshStandardMaterial
          color={palette.props.dark}
          roughness={0.7}
          metalness={0.22}
        />
      </mesh>
      <mesh position={[0, 0.46, 0.132]}>
        <boxGeometry args={[0.29, 0.58, 0.01]} />
        <meshStandardMaterial color={palette.props.body} roughness={0.5} metalness={0.1} />
      </mesh>
      <mesh position={[0, 0.57, 0.138]}>
        <boxGeometry args={[0.22, 0.26, 0.006]} />
        <meshStandardMaterial
          color={palette.glass.color}
          roughness={0.1}
          metalness={0.3}
          transparent
          opacity={0.75}
        />
      </mesh>
      <mesh position={[0, 0.29, 0.138]}>
        <boxGeometry args={[0.18, 0.1, 0.006]} />
        <meshStandardMaterial color={palette.props.dark} roughness={0.7} />
      </mesh>
      <mesh position={[0.09, 0.3, 0.142]}>
        <boxGeometry args={[0.038, 0.013, 0.005]} />
        <meshStandardMaterial color={palette.props.metal} metalness={0.5} roughness={0.4} />
      </mesh>
      <mesh position={[0, 0.07, 0.132]}>
        <boxGeometry args={[0.2, 0.055, 0.02]} />
        <meshStandardMaterial color={palette.props.dark} roughness={0.9} />
      </mesh>
    </group>
  );
}

export function DishwasherModel({
  item,
  onPointerDown,
  onPointerOver,
  onPointerOut,
  editMode,
}: BasicFurnitureModelProps) {
  const { palette } = useScenePalette();
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
      <mesh position={[0, 0.19, 0]}>
        <boxGeometry args={[0.44, 0.38, 0.32]} />
        <meshStandardMaterial
          color={palette.props.light}
          roughness={0.3}
          metalness={0.6}
        />
      </mesh>
      <mesh position={[0, 0.39, 0]}>
        <boxGeometry args={[0.44, 0.04, 0.32]} />
        <meshStandardMaterial
          color={palette.kitchen.counter}
          roughness={0.6}
          metalness={0.05}
        />
      </mesh>
      <mesh position={[0, 0.25, 0.165]}>
        <boxGeometry args={[0.42, 0.28, 0.01]} />
        <meshStandardMaterial color={palette.props.metal} roughness={0.2} metalness={0.5} />
      </mesh>
      <mesh position={[0, 0.36, 0.165]}>
        <boxGeometry args={[0.42, 0.06, 0.01]} />
        <meshStandardMaterial color={palette.props.dark} />
      </mesh>
      <mesh position={[0.15, 0.36, 0.17]}>
        <circleGeometry args={[0.006, 8]} />
        <meshBasicMaterial color={palette.props.metal} />
      </mesh>
    </group>
  );
}

export function StoveModel({
  item,
  onPointerDown,
  onPointerOver,
  onPointerOut,
  editMode,
}: BasicFurnitureModelProps) {
  const { palette } = useScenePalette();
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
      <mesh position={[0, 0.19, 0]}>
        <boxGeometry args={[0.44, 0.38, 0.32]} />
        <meshStandardMaterial
          color={palette.props.dark}
          roughness={0.4}
          metalness={0.6}
        />
      </mesh>
      <mesh position={[0, 0.39, 0]}>
        <boxGeometry args={[0.44, 0.04, 0.32]} />
        <meshStandardMaterial
          color={palette.props.dark}
          roughness={0.2}
          metalness={0.8}
        />
      </mesh>
      {[
        [-0.1, -0.08],
        [0.1, -0.08],
        [-0.1, 0.08],
        [0.1, 0.08],
      ].map(([burnerX, burnerZ], index) => (
        <mesh key={index} position={[burnerX, 0.415, burnerZ]}>
          <cylinderGeometry args={[0.06, 0.06, 0.01, 16]} />
          <meshStandardMaterial color={palette.props.dark} roughness={0.5} />
        </mesh>
      ))}
      <mesh position={[0, 0.2, 0.165]}>
        <boxGeometry args={[0.38, 0.24, 0.01]} />
        <meshStandardMaterial color={palette.props.dark} roughness={0.1} metalness={0.9} />
      </mesh>
      <mesh position={[0, 0.3, 0.18]}>
        <boxGeometry args={[0.3, 0.015, 0.015]} />
        <meshStandardMaterial color={palette.props.metal} metalness={0.8} roughness={0.2} />
      </mesh>
    </group>
  );
}

/** AAS: fit 이 켜진 주방 도형은 자리 상자 가운데에 놓고 방향(facing)으로 돌린다. 원본은 항목 좌표(모서리)를 가운데 삼아
 *  방향 없이 그려, 상판 옆 개수대가 상자 밖으로 튀어나와 보였다(판본 kr-8). */
// 주방 상판 윗면 높이: kitchenCabinet 윗면 0.42 × 배율 1.2. 모델 최고점 0.45 는 벽 쪽 턱(깊이 0.03)이라 상판이 아니다
// (kr-9 — 0.54 로 잡아 개수대가 상판보다 솟고 전자레인지·커피 머신이 떠 보였다)
export const AAS_COUNTER_HEIGHT = 0.504;
function kitchenPlacement(item: FurnitureItem): { position: [number, number, number]; rotY: number } {
  if (!item.fit) {
    const [wx, , wz] = toWorld(item.x, item.y);
    return { position: [wx, 0, wz], rotY: 0 };
  }
  const { width, height } = getItemBaseSize(item);
  const [wx, , wz] = toWorld(item.x + width / 2, item.y + height / 2);
  return { position: [wx, 0, wz], rotY: getItemRotationRadians(item) };
}

export function MicrowaveModel({
  item,
  onPointerDown,
  onPointerOver,
  onPointerOut,
  editMode,
}: BasicFurnitureModelProps) {
  const { palette } = useScenePalette();
  const { position, rotY } = kitchenPlacement(item);
  const yBase = (item.elevation ?? 0) + 0.42;

  return (
    <group
      position={[position[0], yBase, position[2]]}
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
      <mesh position={[0, 0.1, 0]}>
        <boxGeometry args={[0.35, 0.2, 0.25]} />
        <meshStandardMaterial
          color={palette.props.light}
          roughness={0.3}
          metalness={0.4}
        />
      </mesh>
      <mesh position={[-0.05, 0.1, 0.13]}>
        <planeGeometry args={[0.2, 0.14]} />
        <meshStandardMaterial color={palette.props.dark} roughness={0.1} metalness={0.8} />
      </mesh>
      <mesh position={[0.12, 0.1, 0.13]}>
        <planeGeometry args={[0.08, 0.14]} />
        <meshStandardMaterial color={palette.props.metal} roughness={0.5} />
      </mesh>
    </group>
  );
}

export function WallCabinetModel({
  item,
  onPointerDown,
  onPointerOver,
  onPointerOut,
  editMode,
}: BasicFurnitureModelProps) {
  const { palette } = useScenePalette();
  const [wx, , wz] = toWorld(item.x, item.y);
  const width = (item.w ?? 80) * SCALE;
  const elevation = item.elevation ?? 0;
  const yPos = elevation > 0 ? elevation : 0.9;

  return (
    <group
      position={[wx, yPos, wz]}
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
        <boxGeometry args={[width, 0.4, 0.25]} />
        <meshStandardMaterial color={palette.kitchen.cabinet} roughness={0.6} metalness={0.1} />
      </mesh>
      <mesh position={[0, 0, 0.13]}>
        <boxGeometry args={[width - 0.02, 0.38, 0.01]} />
        <meshStandardMaterial color={palette.props.body} roughness={0.6} />
      </mesh>
      {width > 0.4 ? (
        <mesh position={[0, 0, 0.135]}>
          <boxGeometry args={[0.005, 0.38, 0.002]} />
          <meshStandardMaterial color={palette.props.dark} />
        </mesh>
      ) : null}
      <mesh position={[0.02, -0.1, 0.14]}>
        <boxGeometry args={[0.01, 0.06, 0.01]} />
        <meshStandardMaterial color={palette.props.metal} metalness={0.8} />
      </mesh>
      {width > 0.4 ? (
        <mesh position={[-0.02, -0.1, 0.14]}>
          <boxGeometry args={[0.01, 0.06, 0.01]} />
          <meshStandardMaterial color={palette.props.metal} metalness={0.8} />
        </mesh>
      ) : null}
    </group>
  );
}

export function SinkModel({
  item,
  onPointerDown,
  onPointerOver,
  onPointerOut,
  editMode,
}: BasicFurnitureModelProps) {
  const { palette } = useScenePalette();
  const { position, rotY } = kitchenPlacement(item);
  // fit 이면 자리 상자(w×h)와 상판 높이에 맞춰 늘린다(원본 크기 0.44×0.42×0.32)
  const size = item.fit ? getItemBaseSize(item) : null;
  const scale: [number, number, number] = size
    ? [(size.width * SCALE) / 0.44, AAS_COUNTER_HEIGHT / 0.42, (size.height * SCALE) / 0.32]
    : [1, 1, 1];

  return (
    <group
      position={position}
      rotation={[0, rotY, 0]}
      scale={scale}
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
      <mesh position={[0, 0.19, 0]}>
        <boxGeometry args={[0.44, 0.38, 0.32]} />
        <meshStandardMaterial
          color={palette.kitchen.cabinet}
          roughness={0.7}
          metalness={0.02}
        />
      </mesh>
      <mesh position={[0, 0.39, 0]}>
        <boxGeometry args={[0.44, 0.04, 0.32]} />
        <meshStandardMaterial
          color={palette.kitchen.counter}
          roughness={0.6}
          metalness={0.05}
        />
      </mesh>
      <mesh position={[0, 0.385, 0]}>
        <boxGeometry args={[0.27, 0.04, 0.22]} />
        <meshStandardMaterial
          color={palette.props.metal}
          roughness={0.3}
          metalness={0.12}
        />
      </mesh>
      <mesh position={[0, 0.44, -0.1]}>
        <boxGeometry args={[0.03, 0.06, 0.03]} />
        <meshStandardMaterial color={palette.props.metal} roughness={0.4} metalness={0.5} />
      </mesh>
      <mesh position={[0, 0.48, -0.04]}>
        <boxGeometry args={[0.025, 0.025, 0.1]} />
        <meshStandardMaterial color={palette.props.metal} roughness={0.4} metalness={0.5} />
      </mesh>
    </group>
  );
}
