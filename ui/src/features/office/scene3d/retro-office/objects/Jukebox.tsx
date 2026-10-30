"use client";
import { Text } from "@/features/office/scene3d/Text";

import { Billboard } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useRef, useState } from "react";
import * as THREE from "three";
import { SCALE } from "@/features/office/scene3d/retro-office/core/constants";
import {
  getItemBaseSize,
  getItemRotationRadians,
  toWorld,
} from "@/features/office/scene3d/retro-office/core/geometry";
import type { InteractiveFurnitureModelProps } from "@/features/office/scene3d/retro-office/objects/types";
import { useScenePalette } from "@/features/office/scenePaletteContext";
import type { ScenePalette } from "@/features/office/tokens";

export type JukeboxModelProps = InteractiveFurnitureModelProps & {
  active?: boolean;
  /** False when the soundclaw skill is not installed. */
  enabled?: boolean;
};

// AAS(2026-10-20-012 D18): 주크박스는 지금 배치에 없지만 장면 색 표의 역할 색으로 칠한다. 원본은 청록 몸체·분홍 네온·원색 단추였다.
// 꺼진 상태(enabled=false)의 회색과 강조 표시(초록 점·노란 고리)는 없애고 편집 외곽선(ItemSelectionOutlines)을 쓴다.
const jukeboxColors = (p: ScenePalette) => ({
  cabinet: p.props.body,
  cabinetHover: p.props.metal,
  cabinetDark: p.props.dark,
  metal: p.props.metal,
  metalDark: p.props.body,
  neon: p.light.aux.color,
  neonActive: p.light.spot,
  display: p.props.dark,
  displayText: p.label.text,
  record: p.props.dark,
  recordLabel: p.props.metal,
  off: p.props.dark,
  buttons: p.art.colors,
  sign: p.label.text,
});

export function JukeboxModel({
  item,
  isSelected,
  isHovered,
  active = false,
  enabled = true,
  onPointerDown,
  onPointerOver,
  onPointerOut,
  onClick,
}: JukeboxModelProps) {
  const C = jukeboxColors(useScenePalette().palette);
  const [localHovered, setLocalHovered] = useState(false);
  const recordRef = useRef<THREE.Mesh>(null);
  const glowRef = useRef<THREE.PointLight>(null);

  const [wx, , wz] = toWorld(item.x, item.y);
  const { width, height } = getItemBaseSize(item);
  const rotY = getItemRotationRadians(item);

  // Scale the model so it fills the furniture footprint.
  const scaleX = (width * SCALE) / 0.9;
  const scaleZ = (height * SCALE) / 0.7;

  const highlighted = isSelected || isHovered;
  const playing = active && enabled;

  // When the skill isn't installed, desaturate everything to grey.
  const tint = (enabledColor: string, disabledColor: string) =>
    enabled ? enabledColor : disabledColor;

  useFrame((_state, delta) => {
    if (recordRef.current) {
      recordRef.current.rotation.y += playing ? delta * 2 : delta * 0.3;
    }
    if (glowRef.current && playing) {
      const pulse = Math.sin(_state.clock.elapsedTime * 4) * 0.3 + 0.7;
      glowRef.current.intensity = pulse * 2;
    }
  });

  return (
    <group
      position={[wx, 0, wz]}
      onPointerDown={(e) => { e.stopPropagation(); onPointerDown(item._uid); }}
      onPointerOver={(e) => { e.stopPropagation(); setLocalHovered(true); onPointerOver(item._uid); document.body.style.cursor = "pointer"; }}
      onPointerOut={(e) => { e.stopPropagation(); setLocalHovered(false); onPointerOut(); document.body.style.cursor = ""; }}
      onClick={(e) => { e.stopPropagation(); onClick?.(item._uid); }}
    >
      <group rotation={[0, rotY, 0]} scale={[scaleX, 1, scaleZ]}>

        {/* Main cabinet body. */}
        <mesh position={[0, 0.75, 0]} castShadow receiveShadow>
          <boxGeometry args={[0.8, 1.2, 0.6]} />
          <meshStandardMaterial
            color={tint(highlighted ? C.cabinetHover : C.cabinet, C.off)}
            roughness={0.6}
            metalness={0.1}
          />
        </mesh>

        {/* Cabinet top dome (tapered cylinder). */}
        <mesh position={[0, 1.4, 0]} castShadow>
          <cylinderGeometry args={[0.45, 0.5, 0.2, 32]} />
          <meshStandardMaterial color={tint(C.cabinetDark, C.off)} roughness={0.5} metalness={0.2} />
        </mesh>

        {/* Chrome dome cap. */}
        <mesh position={[0, 1.55, 0]} castShadow>
          <sphereGeometry args={[0.15, 16, 16, 0, Math.PI * 2, 0, Math.PI / 2]} />
          <meshStandardMaterial color={tint(C.metal, C.off)} roughness={0.3} metalness={0.8} />
        </mesh>

        {/* Display screen. */}
        <mesh position={[0, 1.1, 0.31]}>
          <planeGeometry args={[0.6, 0.35]} />
          <meshStandardMaterial
            color={tint(C.display, C.off)}
            emissive={enabled ? (playing ? C.neonActive : C.neon) : C.off}
            emissiveIntensity={enabled ? (localHovered || isHovered ? 0.5 : 0.2) : 0.08}
          />
        </mesh>

        {/* Track status / disabled text on display. */}
        <Billboard position={[0, 1.1, 0.32]} follow={false}>
          <Text
            fontSize={0.07}
            color={enabled ? C.displayText : C.metalDark}
            anchorX="center"
            anchorY="middle"
            maxWidth={0.55}
            textAlign="center"
          >
            {enabled ? (playing ? "♪  NOW PLAYING" : "SOUNDCLAW") : "NOT INSTALLED"}
          </Text>
        </Billboard>

        {/* Speaker grill (replaces record slot). */}
        <mesh position={[0, 0.7, 0.31]}>
          <planeGeometry args={[0.52, 0.38]} />
          <meshStandardMaterial color={C.display} roughness={0.9} metalness={0.1} />
        </mesh>
        {/* Horizontal grill lines. */}
        {[-0.14, -0.07, 0, 0.07, 0.14].map((y) => (
          <mesh key={y} position={[0, 0.7 + y, 0.315]}>
            <boxGeometry args={[0.48, 0.01, 0.005]} />
            <meshStandardMaterial color={C.metalDark} metalness={0.6} roughness={0.4} />
          </mesh>
        ))}

        {/* Spinning vinyl disc (small, subtle). */}
        <mesh
          ref={recordRef}
          position={[0, 0.75, 0.315]}
          rotation={[Math.PI / 2, 0, 0]}
        >
          <cylinderGeometry args={[0.1, 0.1, 0.008, 32]} />
          <meshStandardMaterial color={C.record} roughness={0.6} metalness={0.3} />
        </mesh>
        {/* Record label. */}
        <mesh position={[0, 0.75, 0.32]} rotation={[Math.PI / 2, 0, 0]}>
          <circleGeometry args={[0.04, 32]} />
          <meshStandardMaterial color={C.recordLabel} emissive={C.neon} emissiveIntensity={playing ? 0.8 : 0.3} />
        </mesh>

        {/* Coloured selection buttons (grey when disabled). */}
        <group position={[0, 0.5, 0.31]}>
          {C.buttons.map((color, i) => (
            <mesh key={i} position={[-0.15 + i * 0.075, 0, 0.01]}>
              <cylinderGeometry args={[0.025, 0.025, 0.02, 16]} />
              <meshStandardMaterial
                color={enabled ? color : C.off}
                emissive={enabled ? color : C.off}
                emissiveIntensity={enabled ? 0.5 : 0.05}
              />
            </mesh>
          ))}
        </group>

        {/* Side grilles (translucent). */}
        <mesh position={[-0.35, 0.75, 0]} rotation={[0, Math.PI / 2, 0]}>
          <planeGeometry args={[0.8, 0.6]} />
          <meshStandardMaterial color={tint(C.metalDark, C.off)} roughness={0.5} metalness={0.4} transparent opacity={0.8} />
        </mesh>
        <mesh position={[0.35, 0.75, 0]} rotation={[0, -Math.PI / 2, 0]}>
          <planeGeometry args={[0.8, 0.6]} />
          <meshStandardMaterial color={tint(C.metalDark, C.off)} roughness={0.5} metalness={0.4} transparent opacity={0.8} />
        </mesh>

        {/* Base plinth. */}
        <mesh position={[0, 0.05, 0]} receiveShadow>
          <boxGeometry args={[0.9, 0.1, 0.7]} />
          <meshStandardMaterial color={tint(C.cabinetDark, C.off)} roughness={0.7} metalness={0.1} />
        </mesh>

        {/* Floating "Install skill" hint above the machine when disabled and hovered. */}
        {!enabled && (localHovered || isHovered) && (
          <Billboard position={[0, 2.0, 0]} follow={false}>
            <Text fontSize={0.07} color={C.sign} anchorX="center" anchorY="middle" outlineWidth={0.01} outlineColor={C.display}>
              Click to install SOUNDCLAW
            </Text>
          </Billboard>
        )}

        {/* Green point light when a song is playing. */}
        {playing && (
          <pointLight
            ref={glowRef}
            position={[0, 1.2, 0.5]}
            color={C.neonActive}
            intensity={1}
            distance={3}
          />
        )}

      </group>
    </group>
  );
}
