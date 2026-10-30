"use client";

import { presetZoomCamera } from "@/features/office/scene3d/retro-office/core/cameraFocus";
import { useFrame, useThree } from "@react-three/fiber";
import { prefersReducedMotion } from "@/features/office/tokens";
import { useEffect, useMemo, useRef, type MutableRefObject, type RefObject } from "react";
import * as THREE from "three";
import { WORLD_H, WORLD_W } from "@/features/office/scene3d/retro-office/core/constants";
import {
  DISTRICT_CAMERA_POSITION,
  DISTRICT_CAMERA_TARGET,
  DISTRICT_CAMERA_ZOOM,
} from "@/features/office/scene3d/retro-office/core/district";
import { toWorld } from "@/features/office/scene3d/retro-office/core/geometry";
import type { RenderAgent } from "@/features/office/scene3d/retro-office/core/types";

export type CameraPreset = {
  pos: [number, number, number];
  target: [number, number, number];
  zoom?: number;
};

export const CAMERA_PRESETS = {
  overview: {
    pos: DISTRICT_CAMERA_POSITION,
    target: DISTRICT_CAMERA_TARGET,
    zoom: DISTRICT_CAMERA_ZOOM,
  },
  frontDesk: {
    pos: [-2, 8, 4],
    target: [-3, 0, -2],
    zoom: 70,
  },
  lounge: {
    pos: [7, 7, -5],
    target: [5, 0, -3],
    zoom: 62,
  },
} satisfies Record<string, CameraPreset>;

type OrbitControllerLike = {
  target: THREE.Vector3;
  update: () => void;
};

export function CameraAnimator({
  presetRef,
  orbitRef,
}: {
  presetRef: MutableRefObject<CameraPreset | null>;
  orbitRef: RefObject<OrbitControllerLike | null>;
}) {
  const { camera } = useThree();
  const targetPositionRef = useRef(new THREE.Vector3());
  const targetLookAtRef = useRef(new THREE.Vector3());

  const reducedMotion = useMemo(() => prefersReducedMotion(), []);
  useFrame(() => {
    const preset = presetRef.current;
    const orbit = orbitRef.current;
    if (!preset || !orbit) return;
    // AAS(2026-10-20): 프리셋은 직교 화면용이다. 따라가기(원근 카메라) 중이면 버린다 — 예전에는 한 번 본 원근 카메라를 계속 기억해
    // 직교 화면에서 건 확대가 숨은 원근 카메라에 들어갔고, 따라가기 중에는 위치가 끝내 맞지 않아 프리셋이 끝나지 않았다
    const activeCamera = presetZoomCamera(camera);
    if (!activeCamera) {
      presetRef.current = null;
      return;
    }

    targetPositionRef.current.set(...preset.pos);
    targetLookAtRef.current.set(...preset.target);
    // AAS: 움직임 줄이기 설정이면 부드럽게 옮기지 않고 바로 옮긴다(계획 007 G8)
    const step = reducedMotion ? 1 : 0.06;
    camera.position.lerp(targetPositionRef.current, step);
    orbit.target.lerp(targetLookAtRef.current, step);

    if (activeCamera && typeof preset.zoom === "number") {
      activeCamera.zoom += (preset.zoom - activeCamera.zoom) * (reducedMotion ? 1 : 0.08);
      activeCamera.updateProjectionMatrix();
    }

    orbit.update();
    const zoomSettled =
      !activeCamera ||
      typeof preset.zoom !== "number" ||
      Math.abs(activeCamera.zoom - preset.zoom) < 0.5;

    if (camera.position.distanceTo(targetPositionRef.current) < 0.05 && zoomSettled) {
      presetRef.current = null;
    }
  });

  return null;
}

// AAS: 따라가기 카메라의 거리·각도 한도. 원본(거리 0.8~10, 기본 2.0, 각도 최대 82°)은 가까이 붙으면 카메라가 벽·가구 안으로
// 들어가 화면이 한 가지 색으로 덮였다. 가장 가까워도 카메라 높이가 0.4 + 2.5·cos(60°) = 1.65 로 벽 위에 있게 한다.
export const FOLLOW_RADIUS = { min: 2.5, max: 9, start: 4 };
export const FOLLOW_PHI = { start: Math.PI / 4, max: Math.PI / 3 };

export function FollowCamController({
  followRef,
  agentsRef,
  agentLookupRef,
}: {
  followRef: MutableRefObject<string | null>;
  agentsRef: RefObject<RenderAgent[]>;
  agentLookupRef?: RefObject<Map<string, RenderAgent>>;
}) {
  const { camera, set, size, gl } = useThree();
  const perspectiveCameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  // AAS: 원래 카메라는 종류와 상관없이 기억한다. 원본은 원근 카메라일 때만 기억해, 기본 카메라가 직교인 이 장면에서
  // 따라가기를 끄면 원근 카메라가 남았다 — 그 상태에서는 확대 한도(maxZoom)가 걸리지 않아 벽 안까지 들어갔다.
  const originalCameraRef = useRef<typeof camera | null>(camera);
  const wasFollowingRef = useRef(false);
  const lastAgentIdRef = useRef<string | null>(null);
  const thetaRef = useRef(0);
  const phiRef = useRef(FOLLOW_PHI.start);
  const radiusRef = useRef(FOLLOW_RADIUS.start);
  const isDraggingRef = useRef(false);
  const lastMouseRef = useRef({ x: 0, y: 0 });
  const cameraPositionRef = useRef(new THREE.Vector3());
  const lookAtRef = useRef(new THREE.Vector3());

  useEffect(() => {
    if (camera !== perspectiveCameraRef.current) {
      originalCameraRef.current = camera;
    }
  }, [camera]);

  useEffect(() => {
    const element = gl.domElement;

    const handleMouseDown = (event: MouseEvent) => {
      if (!followRef.current || event.button !== 0) return;
      isDraggingRef.current = true;
      lastMouseRef.current = { x: event.clientX, y: event.clientY };
    };

    const handleMouseMove = (event: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const dx = event.clientX - lastMouseRef.current.x;
      const dy = event.clientY - lastMouseRef.current.y;
      lastMouseRef.current = { x: event.clientX, y: event.clientY };
      thetaRef.current -= dx * 0.006;
      phiRef.current = Math.max(
        0.05,
        Math.min(FOLLOW_PHI.max, phiRef.current + dy * 0.006),
      );
    };

    const handleMouseUp = () => {
      isDraggingRef.current = false;
    };

    const handleWheel = (event: WheelEvent) => {
      if (!followRef.current) return;
      radiusRef.current = Math.max(
        FOLLOW_RADIUS.min,
        Math.min(FOLLOW_RADIUS.max, radiusRef.current + event.deltaY * 0.005),
      );
    };

    element.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    element.addEventListener("wheel", handleWheel, { passive: true });

    return () => {
      element.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      element.removeEventListener("wheel", handleWheel);
    };
  }, [gl, followRef]);

  useFrame(() => {
    const agentId = followRef.current;
    const isFollowing = agentId !== null;

    if (isFollowing && !wasFollowingRef.current) {
      const agent =
        (agentId ? agentLookupRef?.current?.get(agentId) : undefined) ??
        agentsRef.current?.find((candidate) => candidate.id === agentId);
      if (!agent) return;

      if (!perspectiveCameraRef.current) {
        perspectiveCameraRef.current = new THREE.PerspectiveCamera(
          65,
          size.width / size.height,
          0.1,
          100,
        );
      }

      thetaRef.current = agent.facing + Math.PI;
      lastAgentIdRef.current = agentId;
      // AAS(2026-10-20): 따라가기 카메라는 확대를 쓰지 않는다. 다른 코드가 바꿨더라도 켤 때 1 로 되돌린다(화면 가득 확대 방지)
      perspectiveCameraRef.current.zoom = 1;
      set({ camera: perspectiveCameraRef.current });
      wasFollowingRef.current = true;
    }

    if (!isFollowing && wasFollowingRef.current) {
      if (originalCameraRef.current) {
        set({ camera: originalCameraRef.current });
      }
      wasFollowingRef.current = false;
      return;
    }

    if (!isFollowing || !perspectiveCameraRef.current) return;

    const agent =
      (agentId ? agentLookupRef?.current?.get(agentId) : undefined) ??
      agentsRef.current?.find((candidate) => candidate.id === agentId);
    if (!agent) return;

    if (agentId !== lastAgentIdRef.current) {
      thetaRef.current = agent.facing + Math.PI;
      lastAgentIdRef.current = agentId;
    }

    const [wx, , wz] = toWorld(agent.x, agent.y);
    const radius = radiusRef.current;
    const theta = thetaRef.current;
    const phi = phiRef.current;

    cameraPositionRef.current.set(
      wx + radius * Math.sin(phi) * Math.sin(theta),
      0.4 + radius * Math.cos(phi),
      wz + radius * Math.sin(phi) * Math.cos(theta),
    );
    perspectiveCameraRef.current.position.copy(cameraPositionRef.current);

    lookAtRef.current.set(wx, 0.5, wz);
    perspectiveCameraRef.current.lookAt(lookAtRef.current);
    perspectiveCameraRef.current.aspect = size.width / size.height;
    perspectiveCameraRef.current.updateProjectionMatrix();
  });

  return null;
}

const DAY_NIGHT_PERIOD = 300;

const DAY_NIGHT_POSITIONS = [0, 0.2, 0.45, 0.65, 0.8, 0.95];

const DAY_NIGHT_KEYFRAMES = [
  {
    ambient: "#c8a870",
    sun: "#ffe8b0",
    sunIntensity: 0.8,
    ambientIntensity: 0.55,
  },
  {
    ambient: "#c8d0e0",
    sun: "#f0f4ff",
    sunIntensity: 1.3,
    ambientIntensity: 0.75,
  },
  {
    ambient: "#c8d0e0",
    sun: "#f0f4ff",
    sunIntensity: 1.3,
    ambientIntensity: 0.75,
  },
  {
    ambient: "#c87840",
    sun: "#ff9050",
    sunIntensity: 0.9,
    ambientIntensity: 0.5,
  },
  {
    ambient: "#1a2040",
    sun: "#2040a0",
    sunIntensity: 0.3,
    ambientIntensity: 0.25,
  },
  {
    ambient: "#101828",
    sun: "#182038",
    sunIntensity: 0.2,
    ambientIntensity: 0.2,
  },
];

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const lerpColor = (fromColor: string, toColor: string, t: number) => {
  const parse = (color: string) => {
    const value = parseInt(color.slice(1), 16);
    return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
  };

  const [fromR, fromG, fromB] = parse(fromColor);
  const [toR, toG, toB] = parse(toColor);
  const red = Math.round(lerp(fromR, toR, t));
  const green = Math.round(lerp(fromG, toG, t));
  const blue = Math.round(lerp(fromB, toB, t));

  return `rgb(${red},${green},${blue})`;
};

export function DayNightCycle({
  externalTimeRef,
}: {
  externalTimeRef?: MutableRefObject<number>;
}) {
  const ambientRef = useRef<THREE.AmbientLight>(null);
  const sunRef = useRef<THREE.DirectionalLight>(null);
  const timeRef = useRef(0.25);

  useFrame((_, delta) => {
    timeRef.current = (timeRef.current + delta / DAY_NIGHT_PERIOD) % 1;
    if (externalTimeRef) externalTimeRef.current = timeRef.current;
    const time = timeRef.current;

    let indexA = 0;
    for (let index = 0; index < DAY_NIGHT_POSITIONS.length - 1; index += 1) {
      if (time >= DAY_NIGHT_POSITIONS[index] && time < DAY_NIGHT_POSITIONS[index + 1]) {
        indexA = index;
        break;
      }
      if (time >= DAY_NIGHT_POSITIONS[DAY_NIGHT_POSITIONS.length - 1]) {
        indexA = DAY_NIGHT_POSITIONS.length - 1;
      }
    }

    const indexB = (indexA + 1) % DAY_NIGHT_KEYFRAMES.length;
    const positionA = DAY_NIGHT_POSITIONS[indexA];
    const positionB = indexB === 0 ? 1 : DAY_NIGHT_POSITIONS[indexB];
    const span = positionB - positionA;
    const localT = span > 0 ? (time - positionA) / span : 0;
    const keyframeA = DAY_NIGHT_KEYFRAMES[indexA];
    const keyframeB = DAY_NIGHT_KEYFRAMES[indexB];

    if (ambientRef.current) {
      ambientRef.current.color.set(
        lerpColor(keyframeA.ambient, keyframeB.ambient, localT),
      );
      ambientRef.current.intensity = lerp(
        keyframeA.ambientIntensity,
        keyframeB.ambientIntensity,
        localT,
      );
    }

    if (sunRef.current) {
      sunRef.current.color.set(lerpColor(keyframeA.sun, keyframeB.sun, localT));
      sunRef.current.intensity = lerp(
        keyframeA.sunIntensity,
        keyframeB.sunIntensity,
        localT,
      );
    }
  });

  return (
    <>
      <ambientLight ref={ambientRef} intensity={0.75} color="#c8d0e0" />
      <directionalLight
        ref={sunRef}
        position={[8, 14, 6]}
        intensity={1.3}
        color="#f0f4ff"
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-bias={-0.0002}
        shadow-normalBias={0.02}
        shadow-camera-left={-WORLD_W * 0.7}
        shadow-camera-right={WORLD_W * 0.7}
        shadow-camera-top={WORLD_H * 0.7}
        shadow-camera-bottom={-WORLD_H * 0.7}
      />
    </>
  );
}
