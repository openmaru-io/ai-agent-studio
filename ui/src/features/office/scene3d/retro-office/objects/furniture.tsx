"use client";

import { useGLTF } from "@react-three/drei";
import { MODEL_URL } from "@/features/office/scene3d/assets";
import type { ThreeEvent } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { AAS_WALL_HEIGHT, SCALE } from "@/features/office/scene3d/retro-office/core/constants";
import {
  FURNITURE_ROTATION,
  getItemBaseSize,
  getItemRotationRadians,
  resolveItemTypeKey,
  toWorld,
} from "@/features/office/scene3d/retro-office/core/geometry";
import type { FurnitureItem } from "@/features/office/scene3d/retro-office/core/types";
import type { InteractiveFurnitureModelProps } from "@/features/office/scene3d/retro-office/objects/types";
import { SelectionOutline } from "@/features/office/scene3d/retro-office/objects/primitives";
import { useScenePalette } from "@/features/office/scenePaletteContext";
import { furnitureTints, SCENE_PALETTE, type FurnitureTint, type SceneTheme } from "@/features/office/tokens";

export const FURNITURE_GLB: Record<string, string> = {
  desk_cubicle: MODEL_URL.desk,
  executive_desk: MODEL_URL.deskCorner,
  chair: MODEL_URL.chairDesk,
  round_table: MODEL_URL.tableRound,
  couch: MODEL_URL.loungeSofa,
  couch_v: MODEL_URL.loungeDesignChair,
  bookshelf: MODEL_URL.bookcaseClosed,
  plant: MODEL_URL.pottedPlant,
  // 화분 종류: 기존 화분과 모양이 다른 선인장·야자수·나무
  plant_cactus: MODEL_URL.cactusTall,
  plant_cactus_short: MODEL_URL.cactusShort,
  plant_palm: MODEL_URL.treePalmShort,
  plant_tree: MODEL_URL.treeSmall,
  beanbag: MODEL_URL.loungeDesignChair,
  pingpong: MODEL_URL.tableCoffee,
  table_rect: MODEL_URL.table,
  coffee_machine: MODEL_URL.kitchenCoffeeMachine,
  fridge: MODEL_URL.kitchenFridgeSmall,
  // AAS: 한국 사무실 배치(계획 2026-10-13-001). Kenney Furniture Kit 2.0(CC0) 모델로 바꾸거나 더했다
  water_cooler: MODEL_URL.kitchenFridgeSmall,
  whiteboard: MODEL_URL.paneling,
  notice_board: MODEL_URL.paneling,
  tv_status: MODEL_URL.televisionModern,
  tv_meeting: MODEL_URL.televisionModern,
  locker: MODEL_URL.bookcaseClosedDoors,
  file_cabinet: MODEL_URL.bookcaseClosedWide,
  rug: MODEL_URL.rugRectangle,
  coat_rack: MODEL_URL.coatRackStanding,
  kanban_board: MODEL_URL.deskCorner,
  cabinet: MODEL_URL.kitchenCabinet,
  computer: MODEL_URL.computerScreen,
  lamp: MODEL_URL.lampRoundFloor,
  printer: MODEL_URL.kitchenMicrowave,
};

export const FURNITURE_SCALE: Record<string, [number, number, number]> = {
  desk_cubicle: [1.5, 1.5, 1.5],
  executive_desk: [1.8, 1.8, 1.8],
  chair: [1.2, 1.2, 1.2],
  round_table: [3.2, 3.2, 3.2],
  // AAS: 의자(1.2)와 같은 배율. 1.8 이면 소파 높이가 의자의 1.65 배라 앉은 사람이 방석에 파묻혀 보였다(2026-10-16 사용자 보고)
  couch: [1.2, 1.2, 1.2],
  couch_v: [1.4, 1.4, 1.4],
  bookshelf: [1.5, 2, 1.5],
  plant: [1.2, 1.8, 1.2],
  // 높이는 기존 화분(0.97)보다 낮거나 비슷하게, 벽 높이(1)를 넘지 않게 한다. fit 로 놓으면 가로·세로는 자리 상자에 맞고 높이만 이 값을 쓴다
  plant_cactus: [1, 1.2, 1],
  plant_cactus_short: [1.25, 1.3, 1.25],
  plant_palm: [0.75, 0.75, 0.75],
  plant_tree: [1, 0.85, 1],
  beanbag: [1, 1, 1],
  pingpong: [2.4, 1.2, 1.6],
  table_rect: [1.4, 1.2, 1.0],
  coffee_machine: [0.8, 0.8, 0.8],
  fridge: [1, 1.4, 1],
  water_cooler: [0.9, 1.4, 0.9], // AAS: 냉장고(같은 모델, 높이 1.4)와 높이를 맞춘다(kr-8)
  whiteboard: [2.4, 1.8, 1],
  notice_board: [2.4, 1.8, 1],
  tv_status: [1.6, 1.6, 1.6],
  tv_meeting: [1.6, 1.6, 1.6],
  locker: [1.4, AAS_WALL_HEIGHT / 0.85, 1.4], // AAS: 모델 높이 0.85 × 배율 = 벽 높이(1). 1.3 배는 1.105 로 벽보다 높았다
  file_cabinet: [1.3, 1.2, 1.3],
  rug: [1.6, 1, 1.6],
  coat_rack: [1.4, 1.4, 1.4],
  kanban_board: [1.8, 1.8, 1.8],
  cabinet: [2.6, 1.2, 1],
  computer: [1.1, 1.1, 1.1],
  lamp: [1.2, 1.2, 1.2],
  printer: [2.6, 4.5, 2.6],
};

export const FURNITURE_Y_OFFSET: Record<string, number> = {
  computer: 0.61,
};

/** Global offset for all kanban desk clutter (papers, monitor, mug, etc.). */
export const KANBAN_CLUTTER_OFFSET = { x: -1, y: 1, z: -2 };

// AAS: 가구 색은 tokens.ts 의 furnitureTints(SCENE_PALETTE[테마]) 가 정한다(스펙 2026-10-20-012). 원본의 FURNITURE_TINT 표는 없앴다.
const TINTS: Record<SceneTheme, Record<string, FurnitureTint>> = {
  dark: furnitureTints(SCENE_PALETTE.dark),
  light: furnitureTints(SCENE_PALETTE.light),
};
const THEMES: SceneTheme[] = ["dark", "light"];

const SHADOW_CASTING_FURNITURE_TYPES = new Set([
  "desk_cubicle",
  "executive_desk",
  "round_table",
  "table_rect",
  "couch",
  "couch_v",
  "bookshelf",
  "cabinet",
  "fridge",
]);

const furnitureTemplateCache = new Map<string, THREE.Object3D>();

type InstancedFurnitureMeshDef = {
  castShadow: boolean;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  matrixWorld: THREE.Matrix4;
  receiveShadow: boolean;
};

/** 재질 하나에 섞을 색. 표가 재질 이름별이면 그 이름의 색, 없으면 섞지 않는다(furnitureMaterials.test.ts 가 이름 누락을 막는다). */
const tintFor = (tint: FurnitureTint | undefined, materialName: string): string | null => {
  if (!tint) return null;
  if (typeof tint === "string") return tint;
  return tint[materialName] ?? null;
};

export const furnitureTemplateKey = (glbPath: string, itemType: string, itemColor: string | undefined, theme: SceneTheme) =>
  `${glbPath}:${itemType}:${itemColor ?? ""}:${theme}`;

const resolveFurnitureTemplate = (params: {
  glbPath: string;
  itemColor: string | undefined;
  itemType: string;
  scene: THREE.Object3D;
  theme: SceneTheme;
}) => {
  // AAS: 열쇠에 테마를 넣는다. 넣지 않으면 테마를 바꿔도 처음 만든 재질이 계속 쓰인다(스펙 2026-10-20-012 §4-3)
  const cacheKey = furnitureTemplateKey(params.glbPath, params.itemType, params.itemColor, params.theme);
  const cached = furnitureTemplateCache.get(cacheKey);
  if (cached) return cached;

  const tint: FurnitureTint | undefined =
    params.itemType === "beanbag" && params.itemColor ? params.itemColor : TINTS[params.theme][params.itemType];
  const template = params.scene.clone(true);
  const castShadow = SHADOW_CASTING_FURNITURE_TYPES.has(params.itemType);

  template.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return;
    const mesh = child as THREE.Mesh;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const templateMats = mats.map((material) => {
      const nextMaterial = material.clone() as THREE.MeshStandardMaterial;
      const tintHex = tintFor(tint, material.name);
      // AAS(2026-10-20-012): 표의 색을 그대로 쓴다. 원본은 80% 만 섞어 의자 천(빨강)·깔개(분홍)의 원래 색이 20% 남아 붉게 보였다.
      // Kenney 모델은 재질마다 평면 색 하나라 면의 명암은 조명이 만든다
      if (tintHex && "color" in nextMaterial) {
        nextMaterial.color.set(tintHex);
      }
      if ("roughness" in nextMaterial) nextMaterial.roughness = 0.65;
      if ("metalness" in nextMaterial) nextMaterial.metalness = 0.08;
      nextMaterial.userData = {
        ...nextMaterial.userData,
        furnitureSharedMaterial: true,
      };
      return nextMaterial;
    });
    mesh.material = Array.isArray(mesh.material)
      ? templateMats
      : templateMats[0];
  });

  furnitureTemplateCache.set(cacheKey, template);
  return template;
};

/** 지금 테마의 가구 템플릿. 다른 테마 것도 함께 만들어 두어 테마를 바꿀 때 복제를 기다리지 않는다(스펙 2026-10-20-012 D6). */
const useFurnitureTemplate = (glbPath: string, itemType: string, itemColor: string | undefined, scene: THREE.Object3D) => {
  const { theme } = useScenePalette();
  return useMemo(() => {
    for (const t of THEMES) resolveFurnitureTemplate({ glbPath, itemColor, itemType, scene, theme: t });
    return resolveFurnitureTemplate({ glbPath, itemColor, itemType, scene, theme });
  }, [glbPath, itemColor, itemType, scene, theme]);
};

/** AAS: fit 가 켜진 가구는 모델 바닥 상자를 자리 상자(w×h)에 맞춘다(types.ts 의 fit). 높이는 원래 배율을 둔다. */
const templateFootprint = new WeakMap<THREE.Object3D, { minX: number; minZ: number; sizeX: number; sizeZ: number }>();
export const fitModelTransform = (
  item: FurnitureItem,
  itemType: string,
  template: THREE.Object3D,
): { offset: [number, number, number]; scale: [number, number, number] } => {
  const scale = FURNITURE_SCALE[itemType] ?? [1, 1, 1];
  if (!item.fit) return { offset: [0, 0, 0], scale };
  let fp = templateFootprint.get(template);
  if (!fp) {
    const box = new THREE.Box3().setFromObject(template);
    fp = { minX: box.min.x, minZ: box.min.z, sizeX: box.max.x - box.min.x || 1, sizeZ: box.max.z - box.min.z || 1 };
    templateFootprint.set(template, fp);
  }
  const { width, height } = getItemBaseSize(item);
  const sx = (width * SCALE) / fp.sizeX;
  const sz = (height * SCALE) / fp.sizeZ;
  return { offset: [-fp.minX * sx, 0, -fp.minZ * sz], scale: [sx, scale[1], sz] };
};

const buildFurnitureItemMatrix = (item: FurnitureItem, itemType: string, template?: THREE.Object3D) => {
  const [wx, , wz] = toWorld(item.x, item.y);
  const yOffset = (FURNITURE_Y_OFFSET[itemType] ?? 0) + (item.elevation ?? 0);
  const fitted = template ? fitModelTransform(item, itemType, template) : null;
  const scale = fitted?.scale ?? FURNITURE_SCALE[itemType] ?? [1, 1, 1];
  const offset = fitted?.offset ?? [0, 0, 0];
  const rotY = getItemRotationRadians(item);
  const { width, height } = getItemBaseSize(item);
  const pivotX = width * SCALE * 0.5;
  const pivotZ = height * SCALE * 0.5;

  const containerMatrix = new THREE.Matrix4().makeTranslation(wx, yOffset, wz);
  const pivotMatrix = new THREE.Matrix4().makeTranslation(pivotX, 0, pivotZ);
  const rotationMatrix = new THREE.Matrix4().makeRotationY(rotY);
  const unpivotMatrix = new THREE.Matrix4().makeTranslation(
    -pivotX + offset[0],
    0,
    -pivotZ + offset[2],
  );
  const scaleMatrix = new THREE.Matrix4().makeScale(
    scale[0],
    scale[1],
    scale[2],
  );

  return containerMatrix
    .multiply(pivotMatrix)
    .multiply(rotationMatrix)
    .multiply(unpivotMatrix)
    .multiply(scaleMatrix);
};

export function InstancedFurnitureItems({
  itemType,
  items,
  onItemClick,
}: {
  itemType: string;
  items: FurnitureItem[];
  onItemClick?: (itemUid: string) => void;
}) {
  const glbPath = FURNITURE_GLB[itemType] ?? FURNITURE_GLB.table_rect;
  const { scene } = useGLTF(glbPath, false);
  const template = useFurnitureTemplate(glbPath, itemType, undefined, scene);
  const meshRefs = useRef<Array<THREE.InstancedMesh | null>>([]);
  const meshDefs = useMemo<InstancedFurnitureMeshDef[]>(() => {
    template.updateMatrixWorld(true);
    const nextDefs: InstancedFurnitureMeshDef[] = [];
    template.traverse((child) => {
      if (!(child as THREE.Mesh).isMesh) return;
      const mesh = child as THREE.Mesh;
      nextDefs.push({
        castShadow: mesh.castShadow,
        geometry: mesh.geometry,
        material: mesh.material as THREE.Material,
        matrixWorld: mesh.matrixWorld.clone(),
        receiveShadow: mesh.receiveShadow,
      });
    });
    return nextDefs;
  }, [template]);
  const itemMatrices = useMemo(
    () => items.map((item) => buildFurnitureItemMatrix(item, itemType, template)),
    [itemType, items, template],
  );
  const itemUidByInstanceId = useMemo(
    () => items.map((item) => item._uid),
    [items],
  );

  const handleClick = useMemo(
    () =>
      onItemClick
        ? (event: ThreeEvent<MouseEvent>) => {
            event.stopPropagation();
            const instanceId = event.instanceId;
            if (typeof instanceId !== "number") return;
            const itemUid = itemUidByInstanceId[instanceId];
            if (!itemUid) return;
            onItemClick(itemUid);
          }
        : undefined,
    [itemUidByInstanceId, onItemClick],
  );

  useLayoutEffect(() => {
    meshDefs.forEach((def, meshIndex) => {
      const instancedMesh = meshRefs.current[meshIndex];
      if (!instancedMesh) return;
      const worldMatrix = new THREE.Matrix4();
      for (let itemIndex = 0; itemIndex < itemMatrices.length; itemIndex += 1) {
        worldMatrix.multiplyMatrices(itemMatrices[itemIndex], def.matrixWorld);
        instancedMesh.setMatrixAt(itemIndex, worldMatrix);
      }
      instancedMesh.instanceMatrix.needsUpdate = true;
      instancedMesh.computeBoundingSphere();
    });
  }, [itemMatrices, meshDefs]);

  if (items.length === 0) return null;

  return (
    <>
      {meshDefs.map((def, meshIndex) => (
        <instancedMesh
          key={`${itemType}-${meshIndex}`}
          ref={(node) => {
            meshRefs.current[meshIndex] = node;
          }}
          args={[def.geometry, def.material, items.length]}
          castShadow={def.castShadow}
          receiveShadow={def.receiveShadow}
          onClick={handleClick}
        />
      ))}
    </>
  );
}

export function FurnitureModel({
  item,
  isSelected,
  isHovered,
  editMode,
  kanbanTaskCount = 0,
  onPointerDown,
  onPointerOver,
  onPointerOut,
  onClick,
}: InteractiveFurnitureModelProps) {
  const itemType = resolveItemTypeKey(item);
  // AAS: 벽에 거는 칸반 보드는 게시판과 같은 판(paneling) 모델·배율·색으로 그리고, 책상 위 소품 대신 메모지를 붙인다
  const wallKanban = itemType === "kanban_board" && item.wall === true;
  const modelType = wallKanban ? "notice_board" : itemType;
  const glbPath = FURNITURE_GLB[modelType] ?? FURNITURE_GLB.table_rect;
  const { scene } = useGLTF(glbPath, false);
  const template = useFurnitureTemplate(glbPath, wallKanban ? "kanban_wall" : modelType, item.color, scene);
  const cloned = useMemo(() => template.clone(true), [template]);
  const [wx, , wz] = toWorld(item.x, item.y);
  const yOffset = (FURNITURE_Y_OFFSET[itemType] ?? 0) + (item.elevation ?? 0);
  const { offset: fitOffset, scale } = fitModelTransform(item, modelType, template);
  const rotY = getItemRotationRadians(item);
  const { width, height } = getItemBaseSize(item);
  const pivotX = width * SCALE * 0.5;
  const pivotZ = height * SCALE * 0.5;
  const boardHeight = useMemo(
    () => (wallKanban ? new THREE.Box3().setFromObject(template).getSize(new THREE.Vector3()).y * scale[1] : 0),
    [wallKanban, template, scale],
  );
  const kanbanDeskLoadout = useMemo(() => {
    const visibleTaskCount = Math.max(0, Math.min(kanbanTaskCount, 12));
    if (visibleTaskCount === 0) {
      return {
        papers: [] as Array<{
          x: number;
          y: number;
          z: number;
          w: number;
          h: number;
          r: number;
          color: string;
        }>,
        folders: [] as Array<{
          x: number;
          y: number;
          z: number;
          w: number;
          h: number;
          d: number;
          color: string;
          r: number;
        }>,
        stickyNotes: [] as Array<{
          x: number;
          y: number;
          z: number;
          color: string;
          r: number;
        }>,
        binders: [] as Array<{
          x: number;
          y: number;
          z: number;
          w: number;
          h: number;
          d: number;
          color: string;
          r: number;
        }>,
      };
    }

    const cx = KANBAN_CLUTTER_OFFSET.x;
    const cy = KANBAN_CLUTTER_OFFSET.y;
    const cz = KANBAN_CLUTTER_OFFSET.z;

    const papers = Array.from(
      { length: Math.min(visibleTaskCount + 2, 14) },
      (_, index) => {
        const row = index % 4;
        const stack = Math.floor(index / 4);
        return {
          x: cx + -0.22 + row * 0.16 + (stack % 2) * 0.03,
          z: cz + 0.06 - stack * 0.12 + (row % 2) * 0.02,
          y: cy + stack * 0.007 + index * 0.0015,
          w: 0.17 + (index % 3) * 0.02,
          h: 0.12 + ((index + 1) % 2) * 0.02,
          r: -0.2 + row * 0.08 + stack * 0.03,
          color: ["#fff7df", "#f6edd2", "#efe4c7", "#fffaf0"][index % 4]!,
        };
      },
    );

    const folders = [
      {
        x: cx + 0.28,
        y: cy + 0.013,
        z: cz + 0.0,
        w: 0.24,
        h: 0.17,
        d: 0.035,
        color: "#d6a447",
        r: 0.16,
      },
      ...(visibleTaskCount >= 5
        ? [
            {
              x: cx + 0.06,
              y: cy + 0.018,
              z: cz + 0.14,
              w: 0.22,
              h: 0.16,
              d: 0.04,
              color: "#9d5f3f",
              r: -0.08,
            },
          ]
        : []),
    ];

    const stickyNotes = Array.from(
      { length: Math.min(2 + Math.floor(visibleTaskCount / 3), 5) },
      (_, index) => ({
        x: cx + -0.1 + index * 0.08,
        y: cy + 0.012 + index * 0.002,
        z: cz + -0.14 - (index % 2) * 0.04,
        color: ["#f7db5e", "#ffb35c", "#97d7f6", "#c0e56e", "#ff8fa3"][
          index % 5
        ]!,
        r: -0.15 + index * 0.08,
      }),
    );

    const binders =
      visibleTaskCount >= 7
        ? [
            {
              x: cx + -0.24,
              y: cy + 0.04,
              z: cz + -0.06,
              w: 0.12,
              h: 0.12,
              d: 0.18,
              color: "#5d7bb0",
              r: -0.08,
            },
            {
              x: cx + -0.14,
              y: cy + 0.047,
              z: cz + -0.1,
              w: 0.12,
              h: 0.13,
              d: 0.19,
              color: "#6f8b3d",
              r: 0.03,
            },
          ]
        : [];

    return {
      papers,
      folders,
      stickyNotes,
      binders,
    };
  }, [kanbanTaskCount]);

  // AAS: 선택·호버는 재질 emissive 대신 외곽선으로 그린다. emissive 는 색을 더하기만 해 라이트 테마의 어두운 선택색이 보이지 않았다(스펙 2026-10-20-012 E1)
  const outlineBox = useMemo(() => new THREE.Box3().setFromObject(template), [template]);

  return (
    <group
      position={[wx, yOffset, wz]}
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
      <group position={[pivotX, 0, pivotZ]} rotation={[0, rotY, 0]}>
        <group position={[-pivotX + fitOffset[0], 0, -pivotZ + fitOffset[2]]} scale={scale}>
          {itemType === "tv_meeting" ? null : <primitive object={cloned} />}
          <SelectionOutline box={outlineBox} selected={isSelected} hovered={isHovered && editMode} />
        </group>
        {itemType === "tv_meeting" ? <ProjectorScreen width={pivotX * 2} front={pivotZ} base={yOffset} /> : null}
        {wallKanban ? (
          <KanbanWallNotes width={pivotX * 2} front={pivotZ} boardHeight={boardHeight} taskCount={kanbanTaskCount} />
        ) : null}
        {itemType === "kanban_board" && !wallKanban ? (
          <>
            {kanbanTaskCount > 0 ? (
              <>
                {/* Monitor. */}
                <mesh
                  position={[
                    KANBAN_CLUTTER_OFFSET.x + 0.02,
                    KANBAN_CLUTTER_OFFSET.y + 0.1,
                    KANBAN_CLUTTER_OFFSET.z + -0.16,
                  ]}
                  rotation={[0, -0.28, 0]}
                  castShadow
                  receiveShadow
                >
                  <boxGeometry args={[0.22, 0.16, 0.03]} />
                  <meshStandardMaterial
                    color="#30374a"
                    roughness={0.48}
                    metalness={0.18}
                  />
                </mesh>
                {/* Keyboard. */}
                <mesh
                  position={[
                    KANBAN_CLUTTER_OFFSET.x + 0.02,
                    KANBAN_CLUTTER_OFFSET.y + 0.01,
                    KANBAN_CLUTTER_OFFSET.z + -0.03,
                  ]}
                  rotation={[-Math.PI / 2, -0.1, 0]}
                  castShadow
                >
                  <boxGeometry args={[0.22, 0.018, 0.09]} />
                  <meshStandardMaterial
                    color="#d8dce4"
                    roughness={0.82}
                    metalness={0.08}
                  />
                </mesh>
                {/* Mug. */}
                <mesh
                  position={[
                    KANBAN_CLUTTER_OFFSET.x + 0.24,
                    KANBAN_CLUTTER_OFFSET.y + 0.03,
                    KANBAN_CLUTTER_OFFSET.z + -0.17,
                  ]}
                  rotation={[-Math.PI / 2, 0.14, 0]}
                  castShadow
                >
                  <cylinderGeometry args={[0.04, 0.04, 0.09, 18]} />
                  <meshStandardMaterial
                    color="#2d4f73"
                    roughness={0.68}
                    metalness={0.12}
                  />
                </mesh>
                {/* Book stack. */}
                <mesh
                  position={[
                    KANBAN_CLUTTER_OFFSET.x + 0.34,
                    KANBAN_CLUTTER_OFFSET.y + 0.04,
                    KANBAN_CLUTTER_OFFSET.z + -0.06,
                  ]}
                  rotation={[0, 0.2, 0]}
                  castShadow
                  receiveShadow
                >
                  <boxGeometry args={[0.17, 0.05, 0.24]} />
                  <meshStandardMaterial
                    color="#bcc5d0"
                    roughness={0.78}
                    metalness={0.12}
                  />
                </mesh>
                <mesh
                  position={[
                    KANBAN_CLUTTER_OFFSET.x + 0.34,
                    KANBAN_CLUTTER_OFFSET.y + 0.07,
                    KANBAN_CLUTTER_OFFSET.z + -0.06,
                  ]}
                  rotation={[0, 0.2, 0]}
                  castShadow
                >
                  <boxGeometry args={[0.17, 0.012, 0.24]} />
                  <meshStandardMaterial
                    color="#eef2f4"
                    roughness={0.92}
                    metalness={0.03}
                  />
                </mesh>
                <mesh
                  position={[
                    KANBAN_CLUTTER_OFFSET.x + 0.34,
                    KANBAN_CLUTTER_OFFSET.y + 0.095,
                    KANBAN_CLUTTER_OFFSET.z + -0.06,
                  ]}
                  rotation={[0, 0.2, 0]}
                  castShadow
                  receiveShadow
                >
                  <boxGeometry args={[0.17, 0.05, 0.24]} />
                  <meshStandardMaterial
                    color="#cbd3db"
                    roughness={0.8}
                    metalness={0.1}
                  />
                </mesh>
                <mesh
                  position={[
                    KANBAN_CLUTTER_OFFSET.x + 0.34,
                    KANBAN_CLUTTER_OFFSET.y + 0.125,
                    KANBAN_CLUTTER_OFFSET.z + -0.06,
                  ]}
                  rotation={[0, 0.2, 0]}
                  castShadow
                >
                  <boxGeometry args={[0.17, 0.012, 0.24]} />
                  <meshStandardMaterial
                    color="#fffdf7"
                    roughness={0.94}
                    metalness={0.02}
                  />
                </mesh>
              </>
            ) : null}
            {kanbanDeskLoadout.papers.map((paper, index) => (
              <mesh
                key={`kanban-paper-${index}`}
                position={[paper.x, paper.y, paper.z]}
                rotation={[-Math.PI / 2, paper.r, 0]}
                castShadow
                receiveShadow
              >
                <boxGeometry args={[paper.w, 0.018, paper.h]} />
                <meshStandardMaterial
                  color={paper.color}
                  roughness={0.94}
                  metalness={0.02}
                />
              </mesh>
            ))}
            {kanbanDeskLoadout.folders.map((folder, index) => (
              <mesh
                key={`kanban-folder-${index}`}
                position={[folder.x, folder.y, folder.z]}
                rotation={[-Math.PI / 2, folder.r, 0]}
                castShadow
                receiveShadow
              >
                <boxGeometry args={[folder.w, folder.d, folder.h]} />
                <meshStandardMaterial
                  color={folder.color}
                  roughness={0.84}
                  metalness={0.06}
                />
              </mesh>
            ))}
            {kanbanDeskLoadout.stickyNotes.map((note, index) => (
              <mesh
                key={`kanban-sticky-${index}`}
                position={[note.x, note.y, note.z]}
                rotation={[-Math.PI / 2, note.r, 0]}
                castShadow
              >
                <boxGeometry args={[0.075, 0.014, 0.075]} />
                <meshStandardMaterial
                  color={note.color}
                  roughness={0.95}
                  metalness={0.01}
                />
              </mesh>
            ))}
            {kanbanDeskLoadout.binders.map((binder, index) => (
              <mesh
                key={`kanban-binder-${index}`}
                position={[binder.x, binder.y, binder.z]}
                rotation={[0, binder.r, 0]}
                castShadow
                receiveShadow
              >
                <boxGeometry args={[binder.w, binder.h, binder.d]} />
                <meshStandardMaterial
                  color={binder.color}
                  roughness={0.74}
                  metalness={0.08}
                />
              </mesh>
            ))}
          </>
        ) : null}
      </group>
    </group>
  );
}

/** AAS: 회의실 빔 프로젝터 스크린. 벽에 거는 흰 화면과 위쪽 감는 통. 앞면은 +z 다.
 *  원본 모델(televisionModern)은 작은 TV 라 회의실 화면으로 보이지 않았다(판본 kr-5).
 *  너비는 높이의 16:9 로 하고 항목 가운데에 둔다. 항목 너비(150 → 2.7)를 그대로 쓰면 약 4.7:1 로 가로가 너무 길었다.
 *  항목이 그보다 좁으면 항목 너비를 넘지 않는다. */
const SCREEN_BOTTOM = 0.3; // 바닥에서 화면 아래끝(벽 높이 1)
const SCREEN_HEIGHT = 0.58;
const SCREEN_ASPECT = 16 / 9;
function ProjectorScreen({ width: itemWidth, front, base }: { width: number; front: number; base: number }) {
  const y0 = SCREEN_BOTTOM - base;
  const width = Math.min(itemWidth, SCREEN_HEIGHT * SCREEN_ASPECT);
  return (
    <group>
      <mesh position={[0, y0 + SCREEN_HEIGHT / 2, front - 0.012]}>
        <boxGeometry args={[width, SCREEN_HEIGHT, 0.012]} />
        <meshStandardMaterial color="#f7f7f4" roughness={0.9} emissive="#2a2a28" emissiveIntensity={0.25} />
      </mesh>
      <mesh position={[0, y0 + SCREEN_HEIGHT + 0.03, front - 0.03]} castShadow>
        <boxGeometry args={[width * 1.05, 0.06, 0.06]} />
        <meshStandardMaterial color="#2b2f36" roughness={0.6} metalness={0.2} />
      </mesh>
      <mesh position={[0, y0 + 0.012, front - 0.012]}>
        <boxGeometry args={[width * 0.98, 0.024, 0.016]} />
        <meshStandardMaterial color="#2b2f36" roughness={0.6} />
      </mesh>
    </group>
  );
}

/** AAS: 벽 칸반 보드의 앞면. 세 칸(할 일·진행·끝남)의 머리 띠와, 할 일 개수만큼(최대 12) 칸마다 2×2 로 메모지를 붙인다.
 *  (width, front) 는 판의 폭과 앞면 z(가운데 기준), boardHeight 는 판 높이(월드 단위)다. */
const KANBAN_HEAD_COLORS = ["#94a3b8", "#60a5fa", "#4ade80"];
const KANBAN_NOTE_COLORS = ["#fde68a", "#fbcfe8", "#bfdbfe", "#bbf7d0"];
function KanbanWallNotes({
  width,
  front,
  boardHeight,
  taskCount,
}: {
  width: number;
  front: number;
  boardHeight: number;
  taskCount: number;
}) {
  if (boardHeight <= 0) return null;
  const colW = (width * 0.9) / 3;
  const left = -width * 0.45;
  const z = front + 0.012;
  const noteW = colW * 0.36;
  const noteH = boardHeight * 0.13;
  const visible = Math.max(0, Math.min(taskCount, 12));
  const notes = Array.from({ length: visible }, (_, i) => {
    const col = i % 3;
    const slot = Math.floor(i / 3); // 칸마다 0~3
    const cx = left + colW * (col + 0.5) + (slot % 2 === 0 ? -1 : 1) * colW * 0.22;
    const cy = boardHeight * 0.66 - Math.floor(slot / 2) * noteH * 1.35;
    return { cx, cy, color: KANBAN_NOTE_COLORS[(i * 7) % KANBAN_NOTE_COLORS.length], r: ((i % 3) - 1) * 0.06 };
  });
  return (
    <group>
      {KANBAN_HEAD_COLORS.map((color, col) => (
        <mesh key={`kanban-head-${col}`} position={[left + colW * (col + 0.5), boardHeight * 0.84, z]}>
          <boxGeometry args={[colW * 0.86, boardHeight * 0.05, 0.01]} />
          <meshStandardMaterial color={color} roughness={0.8} />
        </mesh>
      ))}
      {[1, 2].map((k) => (
        <mesh key={`kanban-line-${k}`} position={[left + colW * k, boardHeight * 0.55, z]}>
          <boxGeometry args={[0.008, boardHeight * 0.62, 0.008]} />
          <meshStandardMaterial color="#64748b" roughness={0.9} />
        </mesh>
      ))}
      {notes.map((n, i) => (
        <mesh key={`kanban-wall-note-${i}`} position={[n.cx, n.cy, z + 0.004]} rotation={[0, 0, n.r]}>
          <boxGeometry args={[noteW, noteH, 0.01]} />
          <meshStandardMaterial color={n.color} roughness={0.95} />
        </mesh>
      ))}
    </group>
  );
}

export function PlacementGhost({
  itemType,
  position,
}: {
  itemType: string;
  position: [number, number, number];
}) {
  const glbPath = FURNITURE_GLB[itemType] ?? FURNITURE_GLB.table_rect;
  const { scene } = useGLTF(glbPath, false);
  const template = useFurnitureTemplate(glbPath, itemType, undefined, scene);
  const cloned = useMemo(() => template.clone(true), [template]);
  const { palette } = useScenePalette();
  const scale = FURNITURE_SCALE[itemType] ?? [1, 1, 1];
  const rotY = FURNITURE_ROTATION[itemType] ?? 0;

  return (
    <group position={position} rotation={[0, rotY, 0]} scale={scale}>
      <primitive object={cloned} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
        <planeGeometry args={[0.8, 0.8]} />
        <meshBasicMaterial color={palette.selection.color} transparent opacity={0.25} />
      </mesh>
    </group>
  );
}

[...new Set(Object.values(FURNITURE_GLB))].forEach((path) =>
  useGLTF.preload(path, false),
);
