import { walkSwing } from "@/features/office/scene3d/retro-office/core/walkPose";
import { Text } from "@/features/office/scene3d/Text";
import { labelStatusColor, mineLabel, prefersReducedMotion, sceneRingColor } from "@/features/office/tokens";
import { useScenePalette } from "@/features/office/scenePaletteContext";
import { Billboard, Html, useCursor } from "@react-three/drei";
import { fitLabel, nameplateLayout, nameplateZones, textWidthEm } from "@/features/office/scene3d/retro-office/core/nameplate";
import { labelAnchor } from "@/features/office/scene3d/retro-office/core/labelAnchor";
import { highlightFrame, MINE_RING, mineIntroFrame, SELECT_RING } from "@/features/office/scene3d/retro-office/core/selectHighlight";
import { applyAwayLook } from "@/features/office/scene3d/retro-office/core/awayLook";
import { sittingPose } from "@/features/office/scene3d/retro-office/core/sittingPose";
import { speechBubbleLayout } from "@/features/office/scene3d/retro-office/core/speechBubble";
import { mutterAt } from "@/features/office/greetings";
import { BubbleActions } from "@/features/office/scene3d/retro-office/objects/BubbleActions";
import { RoundedPlate, SpeechBubbleShape } from "@/features/office/scene3d/retro-office/objects/RoundedPlate";
import { useFrame } from "@react-three/fiber";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { createDefaultAgentAvatarProfile } from "@/features/office/scene3d/lib/avatars/profile";
import {
  AGENT_SCALE,
  WALK_ANIM_SPEED,
} from "@/features/office/scene3d/retro-office/core/constants";
import { toWorld } from "@/features/office/scene3d/retro-office/core/geometry";
import type {
  JanitorActor,
  RenderAgent,
} from "@/features/office/scene3d/retro-office/core/types";
import { AgentModelProps } from "@/features/office/scene3d/retro-office/objects/types";

const MAX_NAMEPLATE_TEXT_LENGTH = 10;
const MAX_SPEECH_BUBBLE_TEXT_LENGTH = 180;
const MAX_SPEECH_BUBBLE_LINES = 4;
/** 2026-10-20-007: 이름표 묶음 배율·높이(캐릭터를 줄여도 이름표·말풍선 크기와 머리 위 간격을 지킨다) */
const LABEL_ANCHOR = labelAnchor(AGENT_SCALE);
/** 2026-10-20: 앉은 자세(다리를 앞으로 눕히고 몸을 좌석 높이로 올림). 원본은 다리를 편 채 뒤로 기울기만 했다 */
const SIT = sittingPose(AGENT_SCALE);

const formatAgentNameplateText = (value: string): string => {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= MAX_NAMEPLATE_TEXT_LENGTH) return normalized;
  const [firstName] = normalized.split(" ");
  return firstName || normalized;
};

const flattenSpeechBubbleMarkdown = (value: string) =>
  value
    .replace(/```[\s\S]*?```/g, " [code] ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^>\s*/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const clampSpeechBubbleText = (value: string) => {
  if (value.length <= MAX_SPEECH_BUBBLE_TEXT_LENGTH) {
    return { text: value, truncated: false };
  }
  const slice = value.slice(0, MAX_SPEECH_BUBBLE_TEXT_LENGTH - 1).trimEnd();
  return { text: `${slice}…`, truncated: true };
};

// AAS: 머리 앞면에 붙는 얼굴 그림(DiceBear Pixel Art, 스펙 2026-10-21-016)의 한 변. 머리 상자(0.16)는 그대로 두고 그림만 키운다
const AAS_FACE_SIZE = 0.21;

// AAS: 얼굴(avatars/face.ts) 텍스처. 같은 얼굴은 한 장만 만든다(계획 007 R3). data: URL 이라 외부 요청이 없다.
const faceTextures = new Map<string, THREE.Texture>();
// SVG 를 바로 텍스처로 올리면 크기(width·height)가 없어 WebGL 이 거절한다 — 128×128 캔버스에 그려서 쓴다.
function aasFaceTexture(url: string): THREE.Texture {
  let tex = faceTextures.get(url);
  if (!tex) {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 128;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const img = new Image(128, 128);
    img.onload = () => {
      canvas.getContext("2d")?.drawImage(img, 0, 0, 128, 128);
      texture.needsUpdate = true;
    };
    img.src = url;
    tex = texture;
    faceTextures.set(url, tex);
  }
  return tex;
}

export const AgentModel = memo(function AgentModel({
  faceUrl = null,
  agentId,
  name,
  subtitle,
  status,
  color,
  appearance,
  agentsRef,
  agentLookupRef,
  onHover,
  onUnhover,
  onClick,
  onContextMenu,
  showSpeech = false,
  speechText = null,
  suppressSpeechBubble = false,
  onBubbleAction,
  bubbleLabels,
  mutterLines,
  subtitlePinned = false,
  mine = false,
  highlightAt = null,
}: AgentModelProps) {
  const groupRef = useRef<THREE.Group>(null);
  const bodyRef = useRef<THREE.Group>(null);
  // AAS: 이름표·말풍선·상태 고리 색은 테마를 따른다(스펙 2026-10-20-012 §3-5)
  const { theme, palette } = useScenePalette();
  // AAS(스펙 2026-10-21-012): 내 에이전트 이름표는 반대 테마의 판·글자로 그린다. 상태 점도 그 판 밝기에 맞는 짝을 쓴다
  const mineLab = mine ? mineLabel(theme) : null;
  const plateTheme = mineLab?.theme ?? theme;
  const idleColor = labelStatusColor(theme, { error: false, working: false, away: false });
  const plateIdleColor = labelStatusColor(plateTheme, { error: false, working: false, away: false });
  const reducedMotion = useMemo(() => prefersReducedMotion(), []);
  const floorMarksRef = useRef<THREE.Group>(null);
  const mineIntroRef = useRef<THREE.Mesh>(null);
  const mineIntroMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const mineIntroAt = useRef<number | null>(null);
  const selectRingRef = useRef<THREE.Mesh>(null);
  const selectRingMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const plateBillboardRef = useRef<THREE.Group>(null);
  const talkBillboardRef = useRef<THREE.Group>(null);
  const labelsRef = useRef<THREE.Group>(null);
  const leftArmRef = useRef<THREE.Group>(null);
  const rightArmRef = useRef<THREE.Group>(null);
  const leftLegRef = useRef<THREE.Group>(null);
  const rightLegRef = useRef<THREE.Group>(null);
  const statusDotMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const statusDotRef = useRef<THREE.Mesh>(null);
  const statusRingRef = useRef<THREE.Mesh>(null);
  const bubbleDotMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const bubbleDotRef = useRef<THREE.Mesh>(null);
  const bubbleRingRef = useRef<THREE.Mesh>(null);
  const pulseRingRef = useRef<THREE.Mesh>(null);
  const shadowRef = useRef<THREE.Mesh>(null);
  const pulseRingMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const leftEyeRef = useRef<THREE.Mesh>(null);
  const rightEyeRef = useRef<THREE.Mesh>(null);
  const leftEyeHighlightRef = useRef<THREE.Mesh>(null);
  const rightEyeHighlightRef = useRef<THREE.Mesh>(null);
  const mouthRef = useRef<THREE.Mesh>(null);
  const leftMouthCornerRef = useRef<THREE.Mesh>(null);
  const rightMouthCornerRef = useRef<THREE.Mesh>(null);
  const leftBrowRef = useRef<THREE.Mesh>(null);
  const rightBrowRef = useRef<THREE.Mesh>(null);
  const heldPaddleRef = useRef<THREE.Group>(null);
  const heldPaddleFaceRef = useRef<THREE.MeshStandardMaterial>(null);
  const heldCleaningToolRef = useRef<THREE.Group>(null);
  const heldCleaningHeadRef = useRef<THREE.MeshStandardMaterial>(null);
  const heldBucketRef = useRef<THREE.Group>(null);
  const heldScrubberRef = useRef<THREE.Group>(null);
  const speechBubbleRef = useRef<THREE.Group>(null);
  const speechBubbleMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const speechBubbleTailMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const awayBubbleRef = useRef<THREE.Group>(null);
  // AAS(2026-10-21-021): 알약에 보일 인사·혼잣말. useFrame 이 바뀐 순간에만 고친다
  const [ambientLine, setAmbientLine] = useState<string | null>(null);
  const ambientLineRef = useRef<string | null>(null);
  const pos = useRef(new THREE.Vector3(0, 0, 0));
  const resolvedAppearance = useMemo(
    () => appearance ?? createDefaultAgentAvatarProfile(agentId),
    [agentId, appearance],
  );

  useFrame(() => {
    const agent =
      agentLookupRef?.current?.get(agentId) ??
      agentsRef.current?.find((candidate) => candidate.id === agentId);
    if (!agent || !groupRef.current) return;

    const [wx, , wz] = toWorld(agent.x, agent.y);
    pos.current.set(wx, 0, wz);
    groupRef.current.position.lerp(pos.current, 0.15);

    const targetY = agent.facing;
    let rotDelta = targetY - groupRef.current.rotation.y;
    while (rotDelta > Math.PI) rotDelta -= Math.PI * 2;
    while (rotDelta < -Math.PI) rotDelta += Math.PI * 2;
    groupRef.current.rotation.y += rotDelta * 0.12;
    const isWorkout = agent.state === "working_out";
    const isDancing = agent.state === "dancing";
    const isJanitor = "role" in agent && agent.role === "janitor";
    const janitorTool = isJanitor
      ? (agent as RenderAgent & JanitorActor).janitorTool
      : undefined;
    const workoutStyle = agent.workoutStyle ?? "lift";
    const frameValue = agent.frame + (agent.phaseOffset ?? 0) / WALK_ANIM_SPEED;
    const walkPhase = Math.sin(frameValue * WALK_ANIM_SPEED);
    const swing = walkSwing(walkPhase); // AAS: 팔·다리 흔들림은 core/walkPose.ts 에서 정한다
    const workoutPhase = Math.sin(
      agent.frame * 0.18 + (agent.phaseOffset ?? 0),
    );
    const workoutPushPhase = Math.sin(
      agent.frame * 0.18 + (agent.phaseOffset ?? 0) + Math.PI / 2,
    );
    groupRef.current.rotation.z = 0;
    groupRef.current.rotation.x =
      agent.state === "sitting"
        ? SIT.torsoRotX // AAS: 원본 −0.15(뒤로 기울임). 앉으면 몸통을 세운다
        : isDancing
          ? Math.sin(agent.frame * 0.18 + (agent.phaseOffset ?? 0)) * 0.06
          : isWorkout
            ? workoutStyle === "bike"
              ? 0.18
              : workoutStyle === "row"
                ? -0.12 + Math.max(0, workoutPhase) * 0.08
                : workoutStyle === "stretch"
                  ? -0.08
                  : workoutStyle === "run"
                    ? 0.08
                    : workoutStyle === "box"
                      ? 0.04
                      : 0.02
            : agent.pingPongUntil
              ? 0.08
              : 0;
    const bounce =
      agent.state === "walking"
        ? Math.sin(frameValue * WALK_ANIM_SPEED) * 0.04
        : isDancing
          ? 0.03 +
            Math.abs(Math.sin(agent.frame * 0.22 + (agent.phaseOffset ?? 0))) *
              0.05
          : isWorkout
            ? workoutStyle === "stretch"
              ? 0.012 + Math.abs(workoutPhase) * 0.018
              : workoutStyle === "row"
                ? 0.015 + Math.abs(workoutPhase) * 0.028
                : 0.02 + Math.abs(workoutPhase) * 0.04
            : 0;
    const breathe =
      agent.state === "standing" || isWorkout || agent.pingPongUntil
        ? Math.sin(frameValue * 0.03) * 0.01
        : 0;
    // AAS(2026-10-20): 앉으면 허벅지가 좌석 윗면에 닿게 몸을 들어 올린다
    groupRef.current.position.y = bounce + breathe + (agent.state === "sitting" ? SIT.lift : 0);

    if (leftArmRef.current) {
      leftArmRef.current.rotation.x = 0;
      leftArmRef.current.rotation.y = 0;
      leftArmRef.current.rotation.z = 0;
      if (isJanitor && janitorTool !== "broom") {
        leftArmRef.current.rotation.x = -0.22;
        leftArmRef.current.rotation.z = -0.08;
      } else if (agent.state === "walking") {
        leftArmRef.current.rotation.x = swing.leftArm;
      } else if (isDancing) {
        leftArmRef.current.rotation.x =
          -0.8 + Math.sin(agent.frame * 0.22) * 0.9;
        leftArmRef.current.rotation.z =
          -0.45 + Math.cos(agent.frame * 0.16) * 0.18;
        leftArmRef.current.rotation.y = -0.08;
        groupRef.current.rotation.z = Math.sin(agent.frame * 0.12) * 0.08;
      } else if (isWorkout) {
        if (workoutStyle === "run") {
          leftArmRef.current.rotation.x = -(0.28 + workoutPhase * 1.05);
          leftArmRef.current.rotation.z = -0.08;
        } else if (workoutStyle === "bike") {
          leftArmRef.current.rotation.x = -(1.05 + workoutPushPhase * 0.16);
          leftArmRef.current.rotation.z = -0.18;
          leftArmRef.current.rotation.y = -0.12;
        } else if (workoutStyle === "row") {
          leftArmRef.current.rotation.x = -(
            0.95 -
            Math.max(0, workoutPhase) * 0.7
          );
          leftArmRef.current.rotation.z = -0.16;
          leftArmRef.current.rotation.y = -0.1;
        } else if (workoutStyle === "box") {
          leftArmRef.current.rotation.x = -(
            0.92 +
            Math.max(0, workoutPushPhase) * 0.45
          );
          leftArmRef.current.rotation.z = -0.52;
          leftArmRef.current.rotation.y = -0.06;
          groupRef.current.rotation.z = 0.05;
        } else if (workoutStyle === "stretch") {
          leftArmRef.current.rotation.x = -1.58;
          leftArmRef.current.rotation.z = -0.42;
          leftArmRef.current.rotation.y = -0.08;
        } else {
          leftArmRef.current.rotation.x = -(
            0.28 +
            Math.abs(workoutPhase) * 0.28
          );
          leftArmRef.current.rotation.z = -0.58;
          leftArmRef.current.rotation.y = -0.12;
        }
      } else if (agent.pingPongUntil) {
        leftArmRef.current.rotation.x =
          0.2 + Math.sin(agent.frame * 0.08) * 0.28;
      } else if (agent.state === "sitting") {
        leftArmRef.current.rotation.x = SIT.armRotX; // AAS: 원본 0.3(뒤로). 책상 쪽으로 든다
      }
    }
    if (rightArmRef.current) {
      rightArmRef.current.rotation.x = 0;
      rightArmRef.current.rotation.y = 0;
      rightArmRef.current.rotation.z = 0;
      if (isJanitor && janitorTool !== "broom") {
        rightArmRef.current.rotation.x = -0.95;
        rightArmRef.current.rotation.y = 0.18;
        rightArmRef.current.rotation.z = 0.08;
      } else if (agent.state === "walking") {
        rightArmRef.current.rotation.x = swing.rightArm;
      } else if (isDancing) {
        rightArmRef.current.rotation.x =
          -0.8 - Math.sin(agent.frame * 0.22) * 0.9;
        rightArmRef.current.rotation.z =
          0.45 - Math.cos(agent.frame * 0.16) * 0.18;
        rightArmRef.current.rotation.y = 0.08;
        groupRef.current.rotation.z = Math.sin(agent.frame * 0.12) * 0.08;
      } else if (isWorkout) {
        if (workoutStyle === "run") {
          rightArmRef.current.rotation.x = -(0.28 - workoutPhase * 1.05);
          rightArmRef.current.rotation.z = 0.08;
        } else if (workoutStyle === "bike") {
          rightArmRef.current.rotation.x = -(1.05 - workoutPushPhase * 0.16);
          rightArmRef.current.rotation.z = 0.18;
          rightArmRef.current.rotation.y = 0.12;
        } else if (workoutStyle === "row") {
          rightArmRef.current.rotation.x = -(
            0.95 -
            Math.max(0, -workoutPhase) * 0.7
          );
          rightArmRef.current.rotation.z = 0.16;
          rightArmRef.current.rotation.y = 0.1;
        } else if (workoutStyle === "box") {
          rightArmRef.current.rotation.x = -(
            0.92 +
            Math.max(0, -workoutPushPhase) * 0.45
          );
          rightArmRef.current.rotation.z = 0.52;
          rightArmRef.current.rotation.y = 0.06;
          groupRef.current.rotation.z = -0.05;
        } else if (workoutStyle === "stretch") {
          rightArmRef.current.rotation.x = -1.58;
          rightArmRef.current.rotation.z = 0.42;
          rightArmRef.current.rotation.y = 0.08;
        } else {
          rightArmRef.current.rotation.x = -(
            0.28 +
            Math.abs(workoutPhase) * 0.28
          );
          rightArmRef.current.rotation.z = 0.58;
          rightArmRef.current.rotation.y = 0.12;
        }
      } else if (agent.pingPongUntil) {
        rightArmRef.current.rotation.x =
          0.08 - Math.sin(agent.frame * 0.08) * 0.16;
      } else if (agent.state === "sitting") {
        rightArmRef.current.rotation.x = SIT.armRotX;
      }
    }
    if (leftLegRef.current) {
      leftLegRef.current.rotation.x =
        agent.state === "walking"
          ? swing.leftLeg
          : isDancing
            ? Math.sin(agent.frame * 0.22 + (agent.phaseOffset ?? 0)) * 0.35
            : isWorkout
              ? workoutStyle === "run"
                ? workoutPhase * 0.7
                : workoutStyle === "bike"
                  ? workoutPhase * 0.82
                  : workoutStyle === "row"
                    ? 0.14 + Math.max(0, workoutPhase) * 0.42
                    : workoutStyle === "stretch"
                      ? -0.2 + Math.abs(workoutPhase) * 0.08
                      : workoutStyle === "box"
                        ? 0.06 + workoutPhase * 0.14
                        : workoutPhase * 0.18
              : 0;
    }
    if (rightLegRef.current) {
      rightLegRef.current.rotation.x =
        agent.state === "walking"
          ? swing.rightLeg
          : isDancing
            ? -Math.sin(agent.frame * 0.22 + (agent.phaseOffset ?? 0)) * 0.35
            : isWorkout
              ? workoutStyle === "run"
                ? -workoutPhase * 0.7
                : workoutStyle === "bike"
                  ? -workoutPhase * 0.82
                  : workoutStyle === "row"
                    ? 0.14 + Math.max(0, -workoutPhase) * 0.42
                    : workoutStyle === "stretch"
                      ? -0.12 + Math.abs(workoutPhase) * 0.08
                      : workoutStyle === "box"
                        ? 0.06 - workoutPhase * 0.14
                        : -workoutPhase * 0.18
              : 0;
    }
    // AAS(2026-10-20): 앉으면 다리를 앞으로 눕혀 허벅지가 좌석 위에 오게 한다(원본은 다리를 편 채였다)
    for (const leg of [leftLegRef.current, rightLegRef.current]) {
      if (!leg) continue;
      if (agent.state === "sitting") {
        leg.rotation.x = SIT.legRotX;
        leg.position.y = SIT.legY;
        leg.position.z = SIT.legZ;
      } else {
        leg.position.y = 0.1;
        leg.position.z = 0;
      }
    }
    // 바닥 그림자·상태 고리는 몸이 들리거나 튀어도 바닥에 남긴다(몸 그룹의 높이를 되돌린다)
    const floorY = -groupRef.current.position.y / AGENT_SCALE;
    if (shadowRef.current) shadowRef.current.position.y = 0.001 + floorY;
    if (pulseRingRef.current) pulseRingRef.current.position.y = 0.005 + floorY;
    if (floorMarksRef.current) floorMarksRef.current.position.y = floorY;

    // AAS(스펙 2026-10-21-012): 내 표시 고리는 처음 그려질 때 한 번 퍼지고, 고른 에이전트는 2.5초 동안 줄어드는 고리와 커지는 이름표로 표시한다
    const now = performance.now();
    if (mineIntroRef.current && mineIntroMatRef.current) {
      if (mine && mineIntroAt.current === null) mineIntroAt.current = now;
      const intro = mineIntroFrame(mine ? now - (mineIntroAt.current ?? now) : Infinity, reducedMotion);
      mineIntroRef.current.visible = mine && !intro.done;
      mineIntroRef.current.scale.setScalar(intro.scale);
      mineIntroMatRef.current.opacity = palette.mine.ringOpacity * intro.opacity;
    }
    const pick = highlightAt === null ? null : highlightFrame(now - highlightAt, reducedMotion);
    if (selectRingRef.current && selectRingMatRef.current) {
      selectRingRef.current.visible = !!pick && !pick.done;
      selectRingRef.current.scale.setScalar(pick?.ringScale ?? 1);
      selectRingMatRef.current.opacity = palette.mine.ringOpacity * (pick?.opacity ?? 0);
    }
    const labelScale = pick && !pick.done ? pick.labelScale : 1;
    plateBillboardRef.current?.scale.setScalar(labelScale);
    talkBillboardRef.current?.scale.setScalar(labelScale);

    // AAS(2026-10-21-023): 대기 에이전트·사람도 앉으므로 앉음은 일하는 중의 근거가 아니다. 원본은 앉으면 초록 점·고리를 띄웠다
    const working =
      isWorkout ||
      isDancing ||
      agent.status === "working";
    const isError = agent.status === "error";
    // AAS(2026-10-26-012): 자리 비움 에이전트는 자기 책상에 앉아 있어(sitting + away) 그때도 자리 비움으로 그린다
    const isAway = agent.state === "away" || (agent.state === "sitting" && agent.away === true);

    if (statusDotMatRef.current) {
      statusDotMatRef.current.color.set(
        labelStatusColor(plateTheme, { error: isError, working, away: isAway }), // AAS: DESIGN 토큰(계획 007 G7), 라이트는 HUD 짝. 내 이름표는 반대 테마 판
      );
    }
    bubbleDotMatRef.current?.color.set(labelStatusColor(theme, { error: isError, working, away: isAway }));
    // AAS(2026-10-20-003): 대기 상태는 채운 점 대신 속 빈 고리로 덜 눈에 띄게
    const idleDot = !working && !isError && !isAway;
    if (statusDotRef.current) statusDotRef.current.visible = !idleDot;
    if (statusRingRef.current) statusRingRef.current.visible = idleDot;
    if (bubbleDotRef.current) bubbleDotRef.current.visible = !idleDot;
    if (bubbleRingRef.current) bubbleRingRef.current.visible = idleDot;

    if (pulseRingRef.current && pulseRingMatRef.current) {
      if (working || isError) {
        const pulse = (Math.sin(agent.frame * 0.05) + 1) / 2;
        const scale = isError ? 1.25 + pulse * 0.55 : 1.2 + pulse * 0.8;
        pulseRingRef.current.scale.setScalar(scale);
        pulseRingMatRef.current.color.set(sceneRingColor(theme, isError ? "error" : "working"));
        // AAS(2026-10-20-012 D5): 고리를 더 진하게 하고 테두리(pulseRingHalo)를 둔다. 새 다크 바닥에서 오류 고리가 바닥과 1.04:1 이었다
        pulseRingMatRef.current.opacity = isError
          ? palette.status.ringOpacity - pulse * 0.2
          : palette.status.ringOpacity - pulse * 0.3;
        pulseRingRef.current.visible = true;
      } else {
        pulseRingRef.current.visible = false;
      }
    }

    if (awayBubbleRef.current) awayBubbleRef.current.visible = isAway;
    // AAS(OMAI-1509): transparent 가 바뀔 때 재질을 다시 컴파일한다 — 안 하면 도중에 자리 비움이 된 인물이 불투명하게 남았다.
    // 몸 묶음 안의 재질을 모두(머리 재질 배열·얼굴 MeshBasicMaterial 포함) 다룬다(core/awayLook)
    if (bodyRef.current) applyAwayLook(bodyRef.current, isAway);

    const blinkSeed = agentId
      .split("")
      .reduce((sum, char) => sum + char.charCodeAt(0), 0);
    const blinkCycle = isAway ? 180 : isError ? 120 : working ? 170 : 240;
    const blinkWindow = isAway ? 26 : isError ? 18 : 12;
    const blinkPhase = (agent.frame + blinkSeed * 17) % blinkCycle;
    let eyeOpen = isError ? 0.92 : working ? 0.84 : 1.12;

    if (blinkPhase < blinkWindow) {
      const midpoint = blinkWindow / 2;
      eyeOpen *= Math.min(1, Math.abs(blinkPhase - midpoint) / midpoint);
    }
    if (working) eyeOpen = Math.max(0.48, eyeOpen);
    if (isError) eyeOpen = Math.max(0.28, eyeOpen);
    if (isAway) eyeOpen = Math.min(eyeOpen, 0.2);

    const eyeScaleX = isError ? 1.2 : working ? 1.06 : 1.12;
    const eyeScaleY = Math.max(0.05, eyeOpen);
    const eyeOffsetY =
      (working ? -0.006 : 0) +
      (isError ? -0.004 : 0) +
      (agent.state === "walking" ? 0.004 : 0) +
      (isAway ? -0.008 : 0);

    for (const eyeRef of [leftEyeRef, rightEyeRef]) {
      if (!eyeRef.current) continue;
      eyeRef.current.scale.x = eyeScaleX;
      eyeRef.current.scale.y = eyeScaleY;
      eyeRef.current.position.y = 0.475 + eyeOffsetY;
    }
    for (const highlightRef of [leftEyeHighlightRef, rightEyeHighlightRef]) {
      if (!highlightRef.current) continue;
      highlightRef.current.visible = eyeOpen > 0.45 && !isAway;
      highlightRef.current.position.y = 0.482 + eyeOffsetY;
    }

    if (mouthRef.current) {
      mouthRef.current.rotation.z = 0;
      mouthRef.current.position.set(0, 0.436, 0.074);
      if (isAway) {
        mouthRef.current.scale.set(0.5, 0.12, 1);
        mouthRef.current.position.y = 0.434;
      } else if (isError) {
        mouthRef.current.scale.set(1.28, 0.16, 1);
        mouthRef.current.position.y = 0.43;
      } else if (working) {
        mouthRef.current.scale.set(0.92, 0.14, 1);
        mouthRef.current.position.y = 0.437;
      } else if (agent.state === "walking") {
        const talkPulse =
          0.38 + (Math.sin(agent.frame * 0.14 + blinkSeed) + 1) * 0.22;
        mouthRef.current.scale.set(0.95, talkPulse, 1);
      } else {
        mouthRef.current.scale.set(1.35, 0.34, 1);
        mouthRef.current.position.y = 0.428;
      }
    }

    const showSmileCorners =
      !isAway && !isError && !working && agent.state !== "walking";
    const showFrownCorners = isError;
    if (leftMouthCornerRef.current && rightMouthCornerRef.current) {
      leftMouthCornerRef.current.visible = showSmileCorners || showFrownCorners;
      rightMouthCornerRef.current.visible =
        showSmileCorners || showFrownCorners;
      leftMouthCornerRef.current.position.set(-0.031, 0.434, 0.074);
      rightMouthCornerRef.current.position.set(0.031, 0.434, 0.074);
      if (showFrownCorners) {
        leftMouthCornerRef.current.rotation.z = -0.6;
        rightMouthCornerRef.current.rotation.z = 0.6;
        leftMouthCornerRef.current.position.y = 0.425;
        rightMouthCornerRef.current.position.y = 0.425;
      } else if (showSmileCorners) {
        leftMouthCornerRef.current.rotation.z = 0.62;
        rightMouthCornerRef.current.rotation.z = -0.62;
        leftMouthCornerRef.current.position.y = 0.438;
        rightMouthCornerRef.current.position.y = 0.438;
      }
    }

    if (leftBrowRef.current && rightBrowRef.current) {
      leftBrowRef.current.position.y = 0.52;
      rightBrowRef.current.position.y = 0.52;
      if (isAway) {
        leftBrowRef.current.rotation.z = -0.24;
        rightBrowRef.current.rotation.z = 0.24;
        leftBrowRef.current.position.y = 0.512;
        rightBrowRef.current.position.y = 0.512;
      } else if (isError) {
        leftBrowRef.current.rotation.z = 0.42;
        rightBrowRef.current.rotation.z = -0.42;
        leftBrowRef.current.position.y = 0.516;
        rightBrowRef.current.position.y = 0.516;
      } else if (working) {
        leftBrowRef.current.rotation.z = 0.3;
        rightBrowRef.current.rotation.z = -0.3;
      } else {
        leftBrowRef.current.rotation.z = -0.18;
        rightBrowRef.current.rotation.z = 0.18;
        leftBrowRef.current.position.y = 0.526;
        rightBrowRef.current.position.y = 0.526;
      }
    }

    // AAS(2026-10-21-021): 「...」 대신 마주친 짝과의 인사, 혼자 서 있을 때의 혼잣말. 전에는 부딪힘(bumpTalkUntil)과
    // 프레임 320개 중 42개(약 5.3초마다 0.7초) 동안 「...」였다. 글이 바뀐 순간에만 상태를 바꿔 다시 그린다
    const nowMs = Date.now();
    const greeting =
      agent.greetText && (agent.greetFrom ?? 0) <= nowMs && nowMs < (agent.greetUntil ?? 0)
        ? agent.greetText
        : null;
    const mutter =
      !greeting && mutterLines && !isAway && !working && !isError && agent.state === "standing"
        ? mutterAt(agentId, nowMs, undefined, mutterLines)
        : null;
    const nextAmbientLine = greeting ?? mutter;
    if (nextAmbientLine !== ambientLineRef.current) {
      ambientLineRef.current = nextAmbientLine;
      setAmbientLine(nextAmbientLine);
    }
    const ambientBubbleVisible = isError || nextAmbientLine !== null;

    if (speechBubbleRef.current) {
      const bubbleVisible =
        !suppressSpeechBubble &&
        (showSpeech || ambientBubbleVisible);
      // AAS(2026-10-20-004): 「…」·「오류」 풍선의 크기가 계속 커졌다 작아지던 것을 멈췄다. 오류는 상태 점·바닥 고리가 이미 알린다
      speechBubbleRef.current.visible = bubbleVisible;
    }

    // AAS(2026-10-20-004): 판을 상태색으로 칠하지 않는다(작업 중 진한 초록이던 것). 이름표와 같은 판, 오류만 붉은 판.
    // 대화 말풍선은 글을 읽어야 해 0.9, 「…」는 이름표와 같은 0.62
    const activeBubble = showSpeech && Boolean(speechText?.trim());
    for (const mat of [speechBubbleMatRef.current, speechBubbleTailMatRef.current]) {
      if (!mat) continue; // 꼬리는 바탕과 같은 색·투명도로 함께 바꾼다
      mat.color.set(isError && !activeBubble ? palette.label.errorPlate : palette.label.plate);
      mat.opacity = activeBubble ? 0.9 : isError ? 0.9 : palette.label.plateOpacity;
    }

    if (heldPaddleRef.current) {
      const isPlaying = agent.pingPongUntil !== undefined;
      heldPaddleRef.current.visible = isPlaying;
      if (isPlaying) {
        const swing = Math.sin(agent.frame * 0.08);
        heldPaddleRef.current.position.set(-0.01, -0.21, 0.07 + swing * 0.015);
        heldPaddleRef.current.rotation.set(-0.55 + swing * 0.1, 0.25, -0.35);
      }
    }

    if (heldPaddleFaceRef.current) {
      heldPaddleFaceRef.current.color.set(
        agent.pingPongSide === 0 ? "#1f4fa8" : "#c53b30",
      );
    }

    if (heldCleaningToolRef.current) {
      const showBroom = isJanitor && janitorTool === "broom";
      heldCleaningToolRef.current.visible = showBroom;
      if (showBroom) {
        const sweep =
          agent.state === "walking" ? Math.sin(agent.frame * 0.08) * 0.08 : 0;
        heldCleaningToolRef.current.position.set(
          -0.02,
          -0.2,
          0.08 + sweep * 0.06,
        );
        heldCleaningToolRef.current.rotation.set(-0.8, 0.18, -0.18);
      }
    }

    if (heldCleaningHeadRef.current) {
      heldCleaningHeadRef.current.color.set("#facc15");
    }

    if (heldBucketRef.current) {
      const showVacuum = isJanitor && janitorTool === "vacuum";
      heldBucketRef.current.visible = showVacuum;
      if (showVacuum) {
        heldBucketRef.current.position.set(-0.08, -0.1, 0.18);
        heldBucketRef.current.rotation.set(-0.32, 0.22, -0.38);
      }
    }

    if (heldScrubberRef.current) {
      const showScrubber = isJanitor && janitorTool === "floor_scrubber";
      heldScrubberRef.current.visible = showScrubber;
      if (showScrubber) {
        heldScrubberRef.current.position.set(-0.1, -0.08, 0.2);
        heldScrubberRef.current.rotation.set(-0.28, 0.18, -0.42);
      }
    }
  });

  const skin = resolvedAppearance.body.skinTone;
  const topColor = resolvedAppearance.clothing.topColor;
  const trouserColor = resolvedAppearance.clothing.bottomColor;
  const shoeColor = resolvedAppearance.clothing.shoesColor;
  const hairColor = resolvedAppearance.hair.color;
  const hairStyle = resolvedAppearance.hair.style;
  const topStyle = resolvedAppearance.clothing.topStyle;
  const bottomStyle = resolvedAppearance.clothing.bottomStyle;
  const hatStyle = resolvedAppearance.accessories.hatStyle;
  const showHeadset = resolvedAppearance.accessories.headset;
  const showBackpack = resolvedAppearance.accessories.backpack;
  const accessoryColor = topColor;
  const sleeveColor = topStyle === "jacket" ? "#dbe4ff" : topColor;
  const cuffColor = topStyle === "hoodie" ? "#d1d5db" : sleeveColor;
  const topAccentColor = topStyle === "jacket" ? "#1f2937" : cuffColor;

  // AAS: 몸통 그룹의 튐(y)과 기울기(x·z)를 이름표 묶음에서 되돌려, 이름표가 머리 위 같은 높이에 머문다.
  // 몸통 그룹에 크기(AGENT_SCALE)가 걸려 있어 높이는 그 비율로 나눈다. 위의 useFrame 다음에 돈다(등록 순서).
  useFrame(() => {
    const body = groupRef.current;
    const labels = labelsRef.current;
    if (!body || !labels) return;
    // 2026-10-20-007: 캐릭터를 줄여도 이름표·말풍선의 크기와 머리 위 간격은 그대로(LABEL_ANCHOR)
    labels.position.y = -body.position.y / AGENT_SCALE + LABEL_ANCHOR.offsetY;
    labels.rotation.set(-body.rotation.x, 0, -body.rotation.z);
  });

  const faceTexture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    if (!ctx) return new THREE.CanvasTexture(canvas);

    ctx.fillStyle = skin;
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = "rgba(255,255,255,0.14)";
    ctx.fillRect(0, 0, 64, 10);
    ctx.fillStyle = "rgba(196,122,84,0.18)";
    ctx.beginPath();
    ctx.arc(18, 38, 7, 0, Math.PI * 2);
    ctx.arc(46, 38, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#d8a06e";
    ctx.fillRect(30, 28, 4, 10);
    ctx.fillRect(29, 37, 6, 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  }, [skin]);

  const resolvedSpeechText =
    showSpeech && speechText?.trim()
      ? speechText.trim()
      : status === "error"
        ? "오류"
        : (ambientLine ?? "...");
  const activeSpeechBubble = showSpeech && Boolean(speechText?.trim());
  const normalizedSpeechBubbleText = activeSpeechBubble
    ? flattenSpeechBubbleMarkdown(resolvedSpeechText)
    : resolvedSpeechText;
  const speechBubblePreview = activeSpeechBubble
    ? clampSpeechBubbleText(normalizedSpeechBubbleText)
    : { text: normalizedSpeechBubbleText, truncated: false };
  const speechBubbleDisplayText = speechBubblePreview.text;
  // AAS(2026-10-20-004): 말풍선은 이름표가 펼쳐진 모양 — 크기·자리는 speechBubbleLayout. 전에는 폭 1.8~4.6, 글자 0.188~0.216, 상태색 판이었다
  const bubble = speechBubbleLayout(speechBubbleDisplayText, name ? formatAgentNameplateText(name) : "");
  const speechBubbleWasTruncated = speechBubblePreview.truncated || bubble.truncated;
  // 「…」·「오류」 풍선: 글자에 맞춘 작은 알약, 이름표 바로 위.
  // 2026-10-21-021: 인사·혼잣말은 이름이 들어가 길어지므로 최대 폭 1.4(전에는 0.6). 판 여백 0.1 을 뺀 폭에 글을 맞춘다
  const ambientFit = ambientLine && !activeSpeechBubble && status !== "error"
    ? fitLabel(speechBubbleDisplayText, 1.4 - 0.1, 0.075, 0.06)
    : fitLabel(speechBubbleDisplayText, 0.6, 0.075, 0.06);
  const ambientWidth = Math.max(0.2, textWidthEm(ambientFit.text) * ambientFit.fontSize + 0.1);
  const speechBubbleTextColor = status === "error" ? palette.label.errorText : palette.label.textSub;
  const nameplateText = name ? formatAgentNameplateText(name) : "";
  const [lineHover, setLineHover] = useState<"top" | "bottom" | null>(null);
  const [bodyHover, setBodyHover] = useState(false);
  useCursor(lineHover !== null, "pointer");
  // 2026-10-20-007: 이름표 호버 때 말풍선과 같은 묶음 단추를 붙인다. 이름표에서 단추로 마우스를 옮기는 동안 닫지 않게 150ms 늦게 닫는다
  const [hintOpen, setHintOpen] = useState(false);
  const hintTimer = useRef<number | undefined>(undefined);
  const keepHint = () => {
    window.clearTimeout(hintTimer.current);
    setHintOpen(true);
  };
  const closeHintSoon = () => {
    window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setHintOpen(false), 150);
  };
  useEffect(() => () => window.clearTimeout(hintTimer.current), []);
  // AAS(2026-10-20-003): 부제는 올렸을 때·따라가는 중·「나」(subtitlePinned)·작업 중·오류일 때만 펼친다. 늘 보이면 이름표가 장면을 가린다.
  // 작업 중은 status prop 으로 본다 — useFrame 의 working 은 앉아 있기만 해도 참이라 대부분이 늘 펼쳐진다.
  const subtitleShown =
    subtitlePinned || bodyHover || lineHover !== null || hintOpen || status === "working" || status === "error";
  const subtitleText = subtitleShown && typeof subtitle === "string" ? subtitle.trim() : "";
  // AAS: 판 폭을 글자에 맞추고 글자 크기는 고정한다(2026-10-20-003). 전에는 고정 폭 0.82 에 맞춰 짧은 이름일수록 글자가 컸다
  const label = nameplateLayout(nameplateText, subtitleText);
  // AAS(OMAI-1259, 2026-10-16 뒤집음): 이름표 위쪽을 누르면 대화 창, 아래쪽을 누르면 상세 서랍을 연다. 둘 다 카메라를 옮기지 않고
  // 이벤트가 몸 그룹(따라가기)으로 올라가지 않게 막는다. 말풍선 단추가 없는 에이전트(청소부 등)는 나누지 않아 누르면 몸을 누른 것과 같다.
  const plate = nameplateZones(label.width, label.height, Boolean(onBubbleAction));

  return (
    <group
      ref={groupRef}
      scale={[AGENT_SCALE, AGENT_SCALE, AGENT_SCALE]}
      onPointerOver={(event) => {
        event.stopPropagation();
        setBodyHover(true);
        onHover?.(agentId);
      }}
      onPointerOut={() => {
        setBodyHover(false);
        onUnhover?.();
      }}
      onClick={(event) => {
        event.stopPropagation();
        onClick?.(agentId);
      }}
      onContextMenu={(event) => {
        event.stopPropagation();
        const nativeEvent = event.nativeEvent as MouseEvent;
        onContextMenu?.(agentId, nativeEvent.clientX, nativeEvent.clientY);
      }}
    >
      <mesh ref={shadowRef} position={[0, 0.001, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.12, 12]} />
        <meshBasicMaterial color="#000" transparent opacity={0.2} />
      </mesh>
      {/* AAS(스펙 2026-10-21-012): 바닥 표시. 내 표시 고리는 상태 고리(0.13~0.19)·테두리 띠(0.11~0.21) 바깥의 흑백 고리로 늘 보이고,
          고른 에이전트 고리는 그 바깥에서 줄어든 뒤 사라진다. 상태 고리는 맥동하며 최대 2배(테두리 띠 반지름 0.42)까지 커져
          두 고리를 덮으므로, 두 고리를 상태 고리(y 0.005)보다 위에 두고 나중에 그린다(renderOrder) */}
      <group ref={floorMarksRef}>
        {mine ? (
          <>
            <mesh position={[0, 0.006, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={2}>
              <ringGeometry args={[MINE_RING.inner, MINE_RING.outer, 48]} />
              <meshBasicMaterial color={palette.mine.ring} transparent opacity={palette.mine.ringOpacity} depthWrite={false} />
            </mesh>
            <mesh ref={mineIntroRef} position={[0, 0.006, 0]} rotation={[-Math.PI / 2, 0, 0]} visible={false} renderOrder={2}>
              <ringGeometry args={[MINE_RING.inner, MINE_RING.outer, 48]} />
              <meshBasicMaterial ref={mineIntroMatRef} color={palette.mine.ring} transparent opacity={0} depthWrite={false} />
            </mesh>
          </>
        ) : null}
        <mesh ref={selectRingRef} position={[0, 0.0065, 0]} rotation={[-Math.PI / 2, 0, 0]} visible={false} renderOrder={2}>
          <ringGeometry args={[SELECT_RING.inner, SELECT_RING.outer, 48]} />
          <meshBasicMaterial ref={selectRingMatRef} color={palette.mine.ring} transparent opacity={0} depthWrite={false} />
        </mesh>
      </group>
      {/* AAS(OMAI-1509): 인물 몸(다리~얼굴, 들고 있는 도구). 자리 비움 반투명은 이 묶음 안 재질에만 건다 — 이름표·고리·말풍선은 밖이다 */}
      <group ref={bodyRef}>
      <group ref={rightLegRef} position={[-0.045, 0.1, 0]}>
        {bottomStyle === "shorts" ? (
          <>
            <mesh position={[0, 0.03, 0]}>
              <boxGeometry args={[0.07, 0.08, 0.08]} />
              <meshLambertMaterial color={trouserColor} />
            </mesh>
            <mesh position={[0, -0.045, 0]}>
              <boxGeometry args={[0.05, 0.06, 0.05]} />
              <meshLambertMaterial color={skin} />
            </mesh>
          </>
        ) : (
          <>
            <mesh>
              <boxGeometry args={[0.07, 0.14, 0.08]} />
              <meshLambertMaterial color={trouserColor} />
            </mesh>
            {bottomStyle === "cuffed" ? (
              <mesh position={[0, -0.05, 0]}>
                <boxGeometry args={[0.074, 0.022, 0.084]} />
                <meshLambertMaterial color="#d1d5db" />
              </mesh>
            ) : null}
          </>
        )}
        <mesh position={[0, -0.09, 0]}>
          <boxGeometry args={[0.07, 0.05, 0.12]} />
          <meshLambertMaterial color={shoeColor} />
        </mesh>
      </group>
      <group ref={leftLegRef} position={[0.045, 0.1, 0]}>
        {bottomStyle === "shorts" ? (
          <>
            <mesh position={[0, 0.03, 0]}>
              <boxGeometry args={[0.07, 0.08, 0.08]} />
              <meshLambertMaterial color={trouserColor} />
            </mesh>
            <mesh position={[0, -0.045, 0]}>
              <boxGeometry args={[0.05, 0.06, 0.05]} />
              <meshLambertMaterial color={skin} />
            </mesh>
          </>
        ) : (
          <>
            <mesh>
              <boxGeometry args={[0.07, 0.14, 0.08]} />
              <meshLambertMaterial color={trouserColor} />
            </mesh>
            {bottomStyle === "cuffed" ? (
              <mesh position={[0, -0.05, 0]}>
                <boxGeometry args={[0.074, 0.022, 0.084]} />
                <meshLambertMaterial color="#d1d5db" />
              </mesh>
            ) : null}
          </>
        )}
        <mesh position={[0, -0.09, 0]}>
          <boxGeometry args={[0.07, 0.05, 0.12]} />
          <meshLambertMaterial color={shoeColor} />
        </mesh>
      </group>
      {showBackpack ? (
        <group position={[0, 0.28, -0.08]}>
          <mesh>
            <boxGeometry args={[0.15, 0.18, 0.06]} />
            <meshLambertMaterial color={accessoryColor} />
          </mesh>
          <mesh position={[-0.06, 0.02, 0.02]}>
            <boxGeometry args={[0.018, 0.16, 0.018]} />
            <meshLambertMaterial color="#cbd5e1" />
          </mesh>
          <mesh position={[0.06, 0.02, 0.02]}>
            <boxGeometry args={[0.018, 0.16, 0.018]} />
            <meshLambertMaterial color="#cbd5e1" />
          </mesh>
        </group>
      ) : null}
      <mesh position={[0, 0.28, 0]}>
        <boxGeometry args={[0.18, 0.2, 0.1]} />
        <meshLambertMaterial color={topColor} />
      </mesh>
      {topStyle === "hoodie" ? (
        <>
          <mesh position={[0, 0.35, -0.045]}>
            <boxGeometry args={[0.17, 0.1, 0.03]} />
            <meshLambertMaterial color={topColor} />
          </mesh>
          <mesh position={[0, 0.22, 0.056]}>
            <boxGeometry args={[0.11, 0.03, 0.012]} />
            <meshLambertMaterial color={cuffColor} />
          </mesh>
        </>
      ) : null}
      {topStyle === "jacket" ? (
        <>
          <mesh position={[0, 0.28, 0.056]}>
            <boxGeometry args={[0.182, 0.21, 0.012]} />
            <meshLambertMaterial color={topAccentColor} />
          </mesh>
          <mesh position={[0, 0.28, 0.063]}>
            <boxGeometry args={[0.034, 0.2, 0.01]} />
            <meshLambertMaterial color="#f8fafc" />
          </mesh>
        </>
      ) : null}
      <group ref={rightArmRef} position={[-0.12, 0.28, 0]}>
        <mesh position={[0, -0.08, 0]}>
          <boxGeometry args={[0.06, 0.16, 0.06]} />
          <meshLambertMaterial color={sleeveColor} />
        </mesh>
        {topStyle === "hoodie" ? (
          <mesh position={[0, -0.145, 0]}>
            <boxGeometry args={[0.064, 0.03, 0.064]} />
            <meshLambertMaterial color={cuffColor} />
          </mesh>
        ) : null}
        <mesh position={[0, -0.17, 0]}>
          <boxGeometry args={[0.05, 0.05, 0.05]} />
          <meshLambertMaterial color={skin} />
        </mesh>
        <group
          ref={heldPaddleRef}
          position={[-0.01, -0.21, 0.07]}
          visible={false}
        >
          <mesh rotation={[-Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.042, 0.042, 0.012, 18]} />
            <meshStandardMaterial
              ref={heldPaddleFaceRef}
              color="#c53b30"
              roughness={0.72}
            />
          </mesh>
          <mesh position={[0, -0.045, -0.015]} rotation={[0.12, 0, 0]}>
            <boxGeometry args={[0.014, 0.07, 0.014]} />
            <meshStandardMaterial color="#c59a68" roughness={0.74} />
          </mesh>
        </group>
        <group
          ref={heldCleaningToolRef}
          position={[-0.02, -0.2, 0.08]}
          rotation={[-0.8, 0.18, -0.18]}
          visible={false}
        >
          <mesh position={[0, -0.13, 0]}>
            <boxGeometry args={[0.012, 0.28, 0.012]} />
            <meshStandardMaterial color="#9a6b3c" roughness={0.76} />
          </mesh>
          <mesh position={[0, -0.28, 0.012]}>
            <boxGeometry args={[0.09, 0.028, 0.03]} />
            <meshStandardMaterial
              ref={heldCleaningHeadRef}
              color="#facc15"
              roughness={0.68}
            />
          </mesh>
        </group>
        {/* Vacuum cleaner: larger upright silhouette so it reads clearly in-scene. */}
        <group
          ref={heldBucketRef}
          position={[-0.08, -0.1, 0.18]}
          visible={false}
        >
          <mesh position={[0, -0.02, 0]}>
            <boxGeometry args={[0.015, 0.3, 0.015]} />
            <meshStandardMaterial color="#555" roughness={0.72} />
          </mesh>
          <mesh position={[0.025, -0.16, 0]}>
            <boxGeometry args={[0.08, 0.12, 0.07]} />
            <meshStandardMaterial color="#dc2626" roughness={0.48} />
          </mesh>
          <mesh position={[0.05, -0.24, 0.02]}>
            <boxGeometry args={[0.11, 0.024, 0.06]} />
            <meshStandardMaterial color="#1f2937" roughness={0.65} />
          </mesh>
          <mesh position={[0.02, -0.11, 0.035]} rotation={[0, Math.PI / 2, 0]}>
            <torusGeometry args={[0.03, 0.005, 10, 18, Math.PI]} />
            <meshStandardMaterial
              color="#94a3b8"
              roughness={0.36}
              metalness={0.18}
            />
          </mesh>
        </group>
        {/* Floor scrubber: prominent handle, body, and wide cleaning base. */}
        <group
          ref={heldScrubberRef}
          position={[-0.1, -0.08, 0.2]}
          visible={false}
        >
          <mesh position={[0, -0.02, 0]}>
            <boxGeometry args={[0.015, 0.32, 0.015]} />
            <meshStandardMaterial color="#777" roughness={0.7} />
          </mesh>
          <mesh position={[0.035, -0.17, 0]}>
            <boxGeometry args={[0.085, 0.08, 0.065]} />
            <meshStandardMaterial color="#f59e0b" roughness={0.46} />
          </mesh>
          <mesh position={[0.06, -0.27, 0.02]} rotation={[-Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.075, 0.075, 0.018, 24]} />
            <meshStandardMaterial color="#0ea5e9" roughness={0.52} />
          </mesh>
          <mesh position={[0.06, -0.23, 0.02]}>
            <boxGeometry args={[0.12, 0.018, 0.07]} />
            <meshStandardMaterial color="#1f2937" roughness={0.6} />
          </mesh>
        </group>
      </group>
      <group ref={leftArmRef} position={[0.12, 0.28, 0]}>
        <mesh position={[0, -0.08, 0]}>
          <boxGeometry args={[0.06, 0.16, 0.06]} />
          <meshLambertMaterial color={sleeveColor} />
        </mesh>
        {topStyle === "hoodie" ? (
          <mesh position={[0, -0.145, 0]}>
            <boxGeometry args={[0.064, 0.03, 0.064]} />
            <meshLambertMaterial color={cuffColor} />
          </mesh>
        ) : null}
        <mesh position={[0, -0.17, 0]}>
          <boxGeometry args={[0.05, 0.05, 0.05]} />
          <meshLambertMaterial color={skin} />
        </mesh>
      </group>
      <mesh position={[0, 0.39, 0]}>
        <boxGeometry args={[0.07, 0.05, 0.07]} />
        <meshLambertMaterial color={skin} />
      </mesh>
      <mesh position={[0, 0.47, 0]}>
        <boxGeometry args={[0.16, 0.16, 0.14]} />
        <meshLambertMaterial attach="material-0" color={skin} />
        <meshLambertMaterial attach="material-1" color={skin} />
        <meshLambertMaterial attach="material-2" color={skin} />
        <meshLambertMaterial attach="material-3" color={skin} />
        <meshLambertMaterial attach="material-4" map={faceTexture} />
        <meshLambertMaterial attach="material-5" color={skin} />
      </mesh>
      {hairStyle === "short" ? (
        <mesh position={[0, 0.555, 0]}>
          <boxGeometry args={[0.17, 0.05, 0.15]} />
          <meshLambertMaterial color={hairColor} />
        </mesh>
      ) : null}
      {hairStyle === "parted" ? (
        <>
          <mesh position={[0, 0.555, 0]}>
            <boxGeometry args={[0.17, 0.045, 0.15]} />
            <meshLambertMaterial color={hairColor} />
          </mesh>
          <mesh position={[-0.035, 0.59, 0.01]} rotation={[0.1, 0, -0.2]}>
            <boxGeometry args={[0.12, 0.03, 0.08]} />
            <meshLambertMaterial color={hairColor} />
          </mesh>
        </>
      ) : null}
      {hairStyle === "spiky" ? (
        <>
          <mesh position={[0, 0.55, 0]}>
            <boxGeometry args={[0.16, 0.035, 0.14]} />
            <meshLambertMaterial color={hairColor} />
          </mesh>
          <mesh position={[-0.05, 0.59, 0]} rotation={[0, 0, -0.2]}>
            <boxGeometry args={[0.04, 0.06, 0.04]} />
            <meshLambertMaterial color={hairColor} />
          </mesh>
          <mesh position={[0, 0.605, 0]} rotation={[0, 0, 0]}>
            <boxGeometry args={[0.04, 0.08, 0.04]} />
            <meshLambertMaterial color={hairColor} />
          </mesh>
          <mesh position={[0.05, 0.59, 0]} rotation={[0, 0, 0.2]}>
            <boxGeometry args={[0.04, 0.06, 0.04]} />
            <meshLambertMaterial color={hairColor} />
          </mesh>
        </>
      ) : null}
      {hairStyle === "bun" ? (
        <>
          <mesh position={[0, 0.548, 0]}>
            <boxGeometry args={[0.17, 0.04, 0.15]} />
            <meshLambertMaterial color={hairColor} />
          </mesh>
          <mesh position={[0, 0.6, -0.035]}>
            <sphereGeometry args={[0.042, 14, 14]} />
            <meshLambertMaterial color={hairColor} />
          </mesh>
        </>
      ) : null}
      {hatStyle === "cap" ? (
        <>
          <mesh position={[0, 0.59, 0]}>
            <boxGeometry args={[0.172, 0.03, 0.152]} />
            <meshLambertMaterial color={accessoryColor} />
          </mesh>
          <mesh position={[0, 0.575, 0.07]}>
            <boxGeometry args={[0.09, 0.012, 0.05]} />
            <meshLambertMaterial color={accessoryColor} />
          </mesh>
        </>
      ) : null}
      {hatStyle === "beanie" ? (
        <mesh position={[0, 0.59, 0]}>
          <boxGeometry args={[0.18, 0.06, 0.16]} />
          <meshLambertMaterial color={accessoryColor} />
        </mesh>
      ) : null}
      {showHeadset ? (
        <>
          <mesh position={[0, 0.57, 0]} rotation={[0, 0, Math.PI / 2]}>
            <torusGeometry args={[0.09, 0.008, 8, 24, Math.PI]} />
            <meshLambertMaterial color="#94a3b8" />
          </mesh>
          <mesh position={[-0.1, 0.48, 0]}>
            <boxGeometry args={[0.018, 0.05, 0.028]} />
            <meshLambertMaterial color="#475569" />
          </mesh>
          <mesh position={[0.1, 0.48, 0]}>
            <boxGeometry args={[0.018, 0.05, 0.028]} />
            <meshLambertMaterial color="#475569" />
          </mesh>
          <mesh position={[0.085, 0.43, 0.06]} rotation={[0.25, 0.25, -0.4]}>
            <boxGeometry args={[0.012, 0.06, 0.012]} />
            <meshLambertMaterial color="#94a3b8" />
          </mesh>
        </>
      ) : null}
      <mesh ref={leftBrowRef} position={[-0.04, 0.52, 0.074]}>
        <boxGeometry args={[0.04, 0.01, 0.01]} />
        <meshBasicMaterial color="#342016" />
      </mesh>
      <mesh ref={rightBrowRef} position={[0.04, 0.52, 0.074]}>
        <boxGeometry args={[0.04, 0.01, 0.01]} />
        <meshBasicMaterial color="#342016" />
      </mesh>
      {faceUrl ? (
        // AAS: 얼굴을 머리 앞면에 붙인다. 눈·입보다 앞(z)에 두어 가린다 — 상태 표정 대신 같은 얼굴을 명단·서랍과 맞춘다
        <mesh position={[0, 0.47, 0.082]}>
          <planeGeometry args={[AAS_FACE_SIZE, AAS_FACE_SIZE]} />
          <meshBasicMaterial map={aasFaceTexture(faceUrl)} transparent />
        </mesh>
      ) : null}
      <mesh ref={leftEyeRef} position={[-0.04, 0.475, 0.072]}>
        <boxGeometry args={[0.03, 0.03, 0.01]} />
        <meshBasicMaterial color="#1a1a2e" />
      </mesh>
      <mesh ref={rightEyeRef} position={[0.04, 0.475, 0.072]}>
        <boxGeometry args={[0.03, 0.03, 0.01]} />
        <meshBasicMaterial color="#1a1a2e" />
      </mesh>
      <mesh ref={leftEyeHighlightRef} position={[-0.03, 0.482, 0.074]}>
        <boxGeometry args={[0.008, 0.008, 0.01]} />
        <meshBasicMaterial color="#fff" />
      </mesh>
      <mesh ref={rightEyeHighlightRef} position={[0.05, 0.482, 0.074]}>
        <boxGeometry args={[0.008, 0.008, 0.01]} />
        <meshBasicMaterial color="#fff" />
      </mesh>
      {/* AAS: 안경을 그리지 않는다. 원본은 외모 accessories.glasses 가 참이면 눈 위에 테를 그렸다 */}
      <mesh ref={mouthRef} position={[0, 0.436, 0.074]}>
        <boxGeometry args={[0.05, 0.014, 0.01]} />
        <meshBasicMaterial color="#9c4a4a" />
      </mesh>
      <mesh
        ref={leftMouthCornerRef}
        position={[-0.031, 0.438, 0.074]}
        visible={false}
      >
        <boxGeometry args={[0.014, 0.014, 0.01]} />
        <meshBasicMaterial color="#9c4a4a" />
      </mesh>
      <mesh
        ref={rightMouthCornerRef}
        position={[0.031, 0.438, 0.074]}
        visible={false}
      >
        <boxGeometry args={[0.014, 0.014, 0.01]} />
        <meshBasicMaterial color="#9c4a4a" />
      </mesh>
      </group>
      <mesh
        ref={pulseRingRef}
        position={[0, 0.005, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        visible={false}
      >
        <ringGeometry args={[0.13, 0.19, 24]} />
        <meshBasicMaterial
          ref={pulseRingMatRef}
          color={sceneRingColor(theme, "working")}
          transparent
          opacity={palette.status.ringOpacity}
          depthWrite={false}
        />
        {/* AAS(2026-10-20-012 D5): 고리 테두리. 바닥 색과 상관없이 고리가 보이게 고리 안팎에 0.02 씩 넓은 띠를 고리 아래에 깐다 */}
        <mesh position={[0, 0, -0.001]}>
          <ringGeometry args={[0.11, 0.21, 24]} />
          <meshBasicMaterial color={palette.status.halo.color} transparent opacity={palette.status.halo.opacity} depthWrite={false} />
        </mesh>
      </mesh>
      {/* AAS: 이름표·말풍선은 몸의 튐·기울기를 따라가지 않는다(labelsRef, 걸을 때 위아래로 흔들려 어지러웠다) */}
      <group ref={labelsRef} scale={LABEL_ANCHOR.scale}>
      {!activeSpeechBubble && nameplateText ? (
        <Billboard ref={plateBillboardRef} position={[0, 1.05, 0]}>
          {/* 2026-10-16: 둥근 판 + 윤곽선, 왼쪽 색 막대는 판 안쪽의 짧은 둥근 막대, 상태 점은 작게 */}
          {/* 2026-10-20-003: 작고 옅게 — 판 폭은 글자에 맞추고(0.30~0.72), #1b1f26·0.62, 글자는 막대 옆 왼쪽 정렬 */}
          {/* 2026-10-21-012: 내 에이전트는 반대 테마의 판·글자(mineLab) — 다른 이름표 사이에서 판 밝기로 구분된다 */}
          <RoundedPlate width={label.width} height={label.height} radius={label.radius} color={mineLab?.plate ?? palette.label.plate} opacity={mineLab?.plateOpacity ?? palette.label.plateOpacity} outline={(mineLab ?? palette.label).outline.color} outlineOpacity={(mineLab ?? palette.label).outline.opacity} />
          <mesh position={[label.bar.x, 0, 0.0005]}>
            <planeGeometry args={[label.bar.w, label.bar.h]} />
            <meshBasicMaterial color={color} />
          </mesh>
          <mesh ref={statusDotRef} position={[label.dot.x, label.dot.y, 0.0005]}>
            <circleGeometry args={[label.dot.r, 16]} />
            <meshBasicMaterial ref={statusDotMatRef} color="#ef4444" />
          </mesh>
          <mesh ref={statusRingRef} position={[label.dot.x, label.dot.y, 0.0005]} visible={false}>
            <ringGeometry args={[label.dot.r * 0.62, label.dot.r, 16]} />
            <meshBasicMaterial color={plateIdleColor} />
          </mesh>
          <Text
            position={[label.name.x, label.name.y, 0.001]}
            fontSize={label.name.fontSize}
            color={mineLab?.text ?? palette.label.text}
            anchorX="left"
            anchorY="middle"
            whiteSpace="nowrap"
            font={undefined}
          >
            {label.name.text}
          </Text>
          {label.subtitle ? (
            <Text
              position={[label.subtitle.x, label.subtitle.y, 0.001]}
              fontSize={label.subtitle.fontSize}
              color={mineLab?.textSub ?? palette.label.textSub}
              anchorX="left"
              anchorY="middle"
              whiteSpace="nowrap"
              font={undefined}
            >
              {label.subtitle.text}
            </Text>
          ) : null}
          {plate.zones.map((zone) => (
            <group key={zone.id}>
              {/* 마우스를 올린 줄 바탕을 밝힌다 */}
              {lineHover === zone.id ? (
                <mesh position={[0, zone.y, 0.0005]}>
                  <planeGeometry args={[plate.width, zone.h]} />
                  <meshBasicMaterial color={(mineLab ?? palette.label).hoverWash.color} transparent opacity={(mineLab ?? palette.label).hoverWash.opacity} depthWrite={false} />
                </mesh>
              ) : null}
              {/* 투명한 클릭 영역(판 전체 폭). 위=대화 창, 아래=상세 서랍 */}
              <mesh
                position={[0, zone.y, 0.003]}
                onPointerOver={(event) => {
                  event.stopPropagation();
                  setLineHover(zone.id);
                  keepHint();
                  onHover?.(agentId);
                }}
                onPointerOut={() => {
                  setLineHover(null);
                  closeHintSoon();
                  onUnhover?.();
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  onBubbleAction?.(agentId, zone.id === "top" ? "chat" : "detail");
                }}
              >
                <planeGeometry args={[plate.width, zone.h]} />
                <meshBasicMaterial transparent opacity={0} depthWrite={false} />
              </mesh>
            </group>
          ))}
          {/* 2026-10-20-007: 호버 안내 = 말풍선과 같은 묶음 단추. 이름표 오른쪽 위에 붙이고 마우스가 있는 쪽(위 = 대화, 아래 = 상세) 칸을 밝힌다.
              예전에는 올린 쪽에 글자만 든 각진 WebGL 사각형이 떴다 */}
          {hintOpen && onBubbleAction && bubbleLabels ? (
            <Html position={[plate.width / 2 - 0.04, plate.height / 2, 0.002]} zIndexRange={[20, 0]}>
              <div style={{ transform: "translate(-100%, calc(-100% - 4px))" }}>
                <BubbleActions
                  labels={bubbleLabels}
                  active={lineHover === "top" ? "chat" : lineHover === "bottom" ? "detail" : null}
                  onHoverChange={(hover) => (hover ? keepHint() : closeHintSoon())}
                  onAction={(action) => onBubbleAction(agentId, action)}
                />
              </div>
            </Html>
          ) : null}
        </Billboard>
      ) : null}
      <group ref={awayBubbleRef} visible={false}>
        <Billboard position={[0, 1.3, 0]}>
          <RoundedPlate width={0.32} height={0.18} radius={0.08} color={palette.label.plate} opacity={0.85} outline={palette.label.outline.color} outlineOpacity={palette.label.outline.opacity} outlineWidth={0.008} />
          <Text
            position={[0, 0, 0.001]}
            fontSize={0.11}
            color={palette.label.textSub}
            anchorX="center"
            anchorY="middle"
          >
            z z z
          </Text>
        </Billboard>
      </group>
      <group ref={speechBubbleRef} visible={false}>
        {activeSpeechBubble ? (
        <Billboard ref={talkBillboardRef} position={[0, bubble.y, 0]}>
          {/* AAS: 둥근 판 + 윤곽선 + 둥근 끝의 꼬리.
              2026-10-20-004: 이름표가 펼쳐진 모양 — 이름표와 같은 판·윤곽선, 머리 줄에 색 막대·이름·상태 점, 꼬리는 가운데 작게 */}
          <SpeechBubbleShape
            width={bubble.width}
            height={bubble.height}
            bodyRef={speechBubbleMatRef}
            tailRef={speechBubbleTailMatRef}
            outline={palette.label.outline.color}
            outlineOpacity={palette.label.outline.opacity}
            outlineWidth={0.012}
            tail
          />
          <mesh position={[bubble.header.bar.x, bubble.header.bar.y, 0.001]} renderOrder={100000}>
            <planeGeometry args={[bubble.header.bar.w, bubble.header.bar.h]} />
            <meshBasicMaterial color={color} depthTest={false} depthWrite={false} transparent />
          </mesh>
          <mesh ref={bubbleDotRef} position={[bubble.header.dot.x, bubble.header.dot.y, 0.001]} renderOrder={100000}>
            <circleGeometry args={[bubble.header.dot.r, 16]} />
            <meshBasicMaterial ref={bubbleDotMatRef} color="#ef4444" depthTest={false} depthWrite={false} transparent />
          </mesh>
          <mesh ref={bubbleRingRef} position={[bubble.header.dot.x, bubble.header.dot.y, 0.001]} renderOrder={100000} visible={false}>
            <ringGeometry args={[bubble.header.dot.r * 0.62, bubble.header.dot.r, 16]} />
            <meshBasicMaterial color={idleColor} depthTest={false} depthWrite={false} transparent />
          </mesh>
          <Text
            position={[bubble.header.name.x, bubble.header.name.y, 0.001]}
            fontSize={bubble.header.name.fontSize}
            color={palette.label.textSub}
            anchorX="left"
            anchorY="middle"
            whiteSpace="nowrap"
            renderOrder={100000}
            depthOffset={-10}
            material-depthTest={false}
            material-depthWrite={false}
          >
            {bubble.header.name.text}
          </Text>
          <Text
            position={[bubble.body.x, bubble.body.y, 0.001]}
            fontSize={bubble.body.fontSize}
            color={palette.label.text}
            anchorX="left"
            anchorY="top"
            maxWidth={bubble.body.maxWidth}
            textAlign="left"
            lineHeight={bubble.body.lineHeight}
            renderOrder={100000}
            depthOffset={-10}
            material-depthTest={false}
            material-depthWrite={false}
          >
            {bubble.text}
          </Text>
          {bubble.more && speechBubbleWasTruncated ? (
            <Text
              position={[bubble.body.x, bubble.more.y, 0.001]}
              fontSize={bubble.more.fontSize}
              color={palette.label.textSub}
              anchorX="left"
              anchorY="middle"
              whiteSpace="nowrap"
              renderOrder={100001}
              depthOffset={-10}
              material-depthTest={false}
              material-depthWrite={false}
            >
              {bubbleLabels?.more ?? "click for full chat"}
            </Text>
          ) : null}
          {/* AAS(OMAI-1115): 말풍선 위 HTML 단추 두 개. WebGL 말풍선 안에는 단추를 넣을 수 없어 장면 위 HTML 로 띄운다.
              zIndexRange 를 낮게 둬 서랍·대화 팝업(1200 이상)을 덮지 않는다. 누름이 장면(에이전트 고르기)으로 새지 않게 막는다. */}
          {activeSpeechBubble && !suppressSpeechBubble && onBubbleAction && bubbleLabels ? (
            // 2026-10-20-004 §6: 한 묶음 단추를 말풍선 오른쪽 위 모서리 바로 위에 붙인다(전에는 두 알약이 가운데 위에 떠 있었다)
            <Html position={[bubble.width / 2 - 0.05, bubble.height / 2, 0]} zIndexRange={[20, 0]}>
              <div style={{ transform: "translate(-100%, calc(-100% - 4px))" }}>
                <BubbleActions labels={bubbleLabels} onAction={(action) => onBubbleAction(agentId, action)} />
              </div>
            </Html>
          ) : null}
        </Billboard>
        ) : (
        // 「…」·「오류」 풍선: 글자에 맞춘 작은 알약, 이름표 바로 위(2026-10-20-004, 전에는 0.36 × 0.2·글자 0.13)
        <Billboard position={[0, 1.05 + label.height / 2 + 0.09, 0]}>
          <SpeechBubbleShape
            width={ambientWidth}
            height={0.1}
            bodyRef={speechBubbleMatRef}
            outline={palette.label.outline.color}
            outlineOpacity={palette.label.outline.opacity}
            outlineWidth={0.01}
          />
          <Text
            position={[0, 0, 0.001]}
            fontSize={ambientFit.fontSize}
            color={speechBubbleTextColor}
            anchorX="center"
            anchorY="middle"
            whiteSpace="nowrap"
            renderOrder={100000}
            depthOffset={-10}
            material-depthTest={false}
            material-depthWrite={false}
          >
            {ambientFit.text}
          </Text>
        </Billboard>
        )}
      </group>
      </group>
    </group>
  );
});

AgentModel.displayName = "AgentModel";
