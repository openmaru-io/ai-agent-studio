/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// AAS: 방 이름표(계획 2026-10-13-001 R3·R4·R6). 배치의 방 표시(room) 가운데, 벽 높이 위에 띄운다.
// 이름은 서버가 정한다 — TFT 회의실은 구성원·관리자에게만 TFT 이름, 나머지에게는 「… · 사용 중」.
// 디자인: 둥근 판 + 윤곽선, 오른쪽 ›, 글자 앞에 회의 중 표시(초록 점과 천천히 퍼지는 고리 / 비어 있으면 속 빈 회색 고리). onSelect 가 있으면 눌러서 그 방의 회의실 채팅을 연다(올리면 판이 밝아지고 손가락 커서).
// 2026-10-20-003: 이름표와 같이 작고 옅게 — 판 폭은 글자에 맞추고(0.70~1.40, 전에는 1.5 고정), 글자 0.16 → 0.12, 판 #1b1f26·0.62.
// 2026-10-20-008: 사람 이름표(알약)와 구분되는 안내판 — 모서리 0.03, 왼쪽 문 아이콘(「○」 대신), 회의 중이면 둘째 줄 「● 회의 중」(점 둘레 고리만 움직임), › 는 마우스를 올렸을 때만.
import { Billboard } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { memo, useRef, useState } from "react";
import type * as THREE from "three";

import { Text } from "@/features/office/scene3d/Text";
import { toWorld } from "@/features/office/scene3d/retro-office/core/geometry";
import { roomLabelLayout } from "@/features/office/scene3d/retro-office/core/nameplate";
import { useScenePalette } from "@/features/office/scenePaletteContext";
import type { FurnitureItem } from "@/features/office/scene3d/retro-office/core/types";
import { RoundedPlate } from "@/features/office/scene3d/retro-office/objects/RoundedPlate";
import { RoomHighlight } from "@/features/office/scene3d/retro-office/objects/RoomHighlight";
import { mineLabel, SCENE_PALETTE } from "@/features/office/tokens";

/** 누른 자리와 뗀 자리가 이 픽셀 안이면 누른 것으로 본다(끌어서 돌린 것은 제외) */
const CLICK_SLOP = 5;
/** 문 테두리 두께 */
const DOOR_STROKE = 0.009;

/** 방을 뜻하는 문 아이콘: 테두리 네 변과 손잡이 점(2026-10-20-008). 예전 빈 방 표시 「○」 를 대신한다 */
function DoorIcon({ x, y, w, h, color }: { x: number; y: number; w: number; h: number; color: string }) {
  const t = DOOR_STROKE;
  const bars: [number, number, number, number][] = [
    [0, h / 2 - t / 2, w, t],
    [0, -h / 2 + t / 2, w, t],
    [-w / 2 + t / 2, 0, t, h],
    [w / 2 - t / 2, 0, t, h],
  ];
  return (
    <group position={[x, y, 0.001]}>
      {bars.map(([bx, by, bw, bh], i) => (
        <mesh key={i} position={[bx, by, 0]}>
          <planeGeometry args={[bw, bh]} />
          <meshBasicMaterial color={color} />
        </mesh>
      ))}
      <mesh position={[w / 2 - t - 0.012, -0.004, 0]}>
        <circleGeometry args={[0.008, 10]} />
        <meshBasicMaterial color={color} />
      </mesh>
    </group>
  );
}

const RoomLabel = memo(function RoomLabel({
  position,
  text,
  inMeeting,
  meetingLabel,
  statusText = "",
  moved = false,
  picked = false,
  onSelect,
}: {
  position: [number, number, number];
  text: string;
  inMeeting: boolean;
  meetingLabel: string;
  /** 둘째 줄 글(번역됨). 비우면 회의 중일 때 meetingLabel(「회의 중」). 2026-10-20-017 디자인 리뷰 이슈 1·2 */
  statusText?: string;
  /** 이 방의 회의가 다른 회의실로 옮겨 감 — 회색 문·회색 둘째 줄, 점·고리 없음(이슈 1) */
  moved?: boolean;
  /** 상태판에서 막 고른 방(스펙 2026-10-21-012 §3-4) — 2.5초 동안 내 이름표처럼 반대 테마 색으로 그린다 */
  picked?: boolean;
  onSelect?: () => void;
}) {
  const [hover, setHover] = useState(false);
  const halo = useRef<THREE.Mesh>(null);
  const downAt = useRef<{ x: number; y: number } | null>(null);
  const interactive = !!onSelect;
  // 눌러 열 수 있을 때만 오른쪽에 › 를 두므로 판이 그만큼 넓다
  const twoLine = inMeeting || (moved && !!statusText);
  const fit = roomLabelLayout(text, interactive, twoLine, inMeeting || moved ? statusText : "");
  // AAS: 판·글자·회의 초록은 테마를 따른다(스펙 2026-10-20-012 D17). 라이트 판 위 #4ade80 은 1.6:1 이라 진한 초록을 쓴다
  const { theme, palette } = useScenePalette();
  const lab = picked ? mineLabel(theme) : palette.label;
  const meetingGreen = picked ? SCENE_PALETTE[mineLabel(theme).theme].label.meeting : palette.label.meeting;
  const iconColor = inMeeting ? meetingGreen : lab.icon;
  // 회의 중일 때만 고리가 천천히 퍼졌다 사라진다(2.4초 주기). 시선을 끄는 곳은 이 하나뿐이다
  useFrame(({ clock }) => {
    const m = halo.current;
    if (!m) return;
    const k = (clock.elapsedTime % 2.4) / 2.4;
    m.scale.setScalar(1 + k * 1.1);
    (m.material as THREE.MeshBasicMaterial).opacity = 0.5 * (1 - k);
  });
  return (
    <Billboard
      position={position}
      // R3F 의 onClick 은 이 장면(OrbitControls 가 포인터를 붙잡는다)에서 오지 않아, 누른 자리와 뗀 자리가 거의 같으면 선택으로 본다
      onPointerDown={
        interactive
          ? (e) => {
              e.stopPropagation();
              downAt.current = { x: e.nativeEvent.clientX, y: e.nativeEvent.clientY };
            }
          : undefined
      }
      onPointerUp={
        interactive
          ? (e) => {
              e.stopPropagation();
              const d = downAt.current;
              downAt.current = null;
              if (d && Math.hypot(e.nativeEvent.clientX - d.x, e.nativeEvent.clientY - d.y) <= CLICK_SLOP) onSelect();
            }
          : undefined
      }
      onPointerOver={
        interactive
          ? (e) => {
              e.stopPropagation();
              setHover(true);
              document.body.style.cursor = "pointer";
            }
          : undefined
      }
      onPointerOut={
        interactive
          ? () => {
              setHover(false);
              document.body.style.cursor = "";
            }
          : undefined
      }
    >
      <RoundedPlate
        width={fit.width}
        height={fit.height}
        radius={fit.radius}
        color={lab.plate}
        opacity={hover ? Math.max(0.86, lab.plateOpacity) : lab.plateOpacity}
        outline={lab.outline.color}
        outlineOpacity={hover ? 0.4 : lab.outline.opacity}
      />
      <DoorIcon x={fit.icon.x} y={fit.icon.y} w={fit.icon.w} h={fit.icon.h} color={iconColor} />
      <Text
        position={[fit.textX, fit.nameY, 0.001]}
        fontSize={fit.fontSize}
        color={inMeeting ? lab.text : lab.textSub}
        anchorX="left"
        anchorY="middle"
        whiteSpace="nowrap"
      >
        {fit.text}
      </Text>
      {fit.status && !inMeeting ? (
        <Text
          position={[fit.status.x, fit.status.y, 0.001]}
          fontSize={fit.status.fontSize}
          color={lab.icon}
          anchorX="left"
          anchorY="middle"
          whiteSpace="nowrap"
        >
          {fit.status.text}
        </Text>
      ) : fit.status ? (
        <>
          <mesh ref={halo} position={[fit.status.x + fit.status.dotR, fit.status.y, 0.0008]}>
            <ringGeometry args={[fit.status.dotR, fit.status.dotR * 1.35, 24]} />
            <meshBasicMaterial color={meetingGreen} transparent opacity={0.5} depthWrite={false} />
          </mesh>
          <mesh position={[fit.status.x + fit.status.dotR, fit.status.y, 0.001]}>
            <circleGeometry args={[fit.status.dotR, 16]} />
            <meshBasicMaterial color={meetingGreen} />
          </mesh>
          <Text
            position={[fit.status.x + fit.status.dotR * 2 + 0.03, fit.status.y, 0.001]}
            fontSize={fit.status.fontSize}
            color={meetingGreen}
            anchorX="left"
            anchorY="middle"
            whiteSpace="nowrap"
          >
            {fit.status.text || meetingLabel}
          </Text>
        </>
      ) : null}
      {/* › 는 마우스를 올렸을 때만. 자리는 미리 잡아 판 크기는 그대로다 */}
      {interactive && hover ? (
        <Text position={[fit.chevronX, fit.nameY, 0.001]} fontSize={0.13} color={lab.text} anchorX="center" anchorY="middle">
          ›
        </Text>
      ) : null}
    </Billboard>
  );
});

export const AasRoomLabels = memo(function AasRoomLabels({
  furniture,
  labels,
  inMeeting,
  status,
  onSelect,
  meetingLabel = "In meeting",
  highlight = null,
}: {
  furniture: FurnitureItem[];
  labels: Record<string, string>;
  /** 지금 회의 중인 방 표시 uid. */
  inMeeting?: Set<string>;
  /** 방 표시 uid → 둘째 줄 글(번역됨)과 옮겨 감 여부(2026-10-20-017 디자인 리뷰 이슈 1·2). */
  status?: Record<string, { text: string; moved: boolean }>;
  /** 주면 명패를 눌러 열 수 있다. 방 표시 항목의 uid 를 알린다. */
  onSelect?: (roomUid: string) => void;
  /** 회의 중 줄 문구(번역, office.roomInMeeting). scene3d 는 번역 검사 밖이라 받아 쓴다 */
  meetingLabel?: string;
  /** 상태판에서 막 고른 대상과 그 시각(스펙 2026-10-21-012 §3-4). 방 표시 uid 면 바닥 테두리와 명패를 표시한다 */
  highlight?: { target: string; at: number } | null;
}) {
  const picked = highlight ? furniture.find((it) => it.type === "room" && it._uid === highlight.target) : undefined;
  return (
    <>
      {picked && highlight ? <RoomHighlight key={`${picked._uid}:${highlight.at}`} room={picked} at={highlight.at} /> : null}
      {furniture
        .filter((it) => it.type === "room")
        .map((it) => {
          const text = labels[it._uid] ?? it.label ?? "";
          if (!text) return null;
          const [wx, , wz] = toWorld(it.x + (it.w ?? 0) / 2, it.y + (it.h ?? 0) / 2);
          return <RoomLabel key={it._uid} position={[wx, 1.35, wz]} text={text} inMeeting={!!inMeeting?.has(it._uid)} meetingLabel={meetingLabel} statusText={status?.[it._uid]?.text} moved={!!status?.[it._uid]?.moved} picked={picked?._uid === it._uid} onSelect={onSelect ? () => onSelect(it._uid) : undefined} />;
        })}
    </>
  );
});
