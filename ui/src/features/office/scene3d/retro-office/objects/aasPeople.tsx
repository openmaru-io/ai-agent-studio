/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// AAS: 사람 아바타 층(계획 007 P6b). Claw3D 원본에는 플레이어 이동 코드가 없어 새로 만들었다.
// 바닥을 두 번 누르면 내 아바타가 그곳으로 걷는다(경로는 원본의 astar). 빈 책상·의자 가까이를 누르면 앉는다.
// 한 번 누르기는 에이전트 고르기·카메라 끌기와 겹쳐 두 번 누르기를 쓴다. 다른 사람은 받은 위치로 걸어간다.
import { useGLTF } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { memo, useCallback, useEffect, useMemo, useRef, type MutableRefObject } from "react";
import * as THREE from "three";

import {
  agentSeats,
  freeSeats,
  PERSON_SPEED,
  type PersonPos,
  pickTarget,
  seatOnRay,
  seatRefused,
  shouldPublish,
} from "@/features/office/people";
import { CANVAS_H, CANVAS_W, SCALE } from "@/features/office/scene3d/retro-office/core/constants";
import { LOCAL_OFFICE_CANVAS_HEIGHT, LOCAL_OFFICE_CANVAS_WIDTH } from "@/features/office/scene3d/retro-office/core/district";
import { getItemBaseSize, getItemBounds, getItemRotationRadians } from "@/features/office/scene3d/retro-office/core/geometry";
import { astar, buildNavGrid } from "@/features/office/scene3d/retro-office/core/navigation";
import { approachPoint, clampToOffice, detour, gridAround, planRoute, seatFurniture, spreadFrom } from "@/features/office/scene3d/retro-office/core/personPath";
import type { FurnitureItem, RenderAgent } from "@/features/office/scene3d/retro-office/core/types";
import { AgentModel } from "@/features/office/scene3d/retro-office/objects/agents";
import { FURNITURE_GLB, FURNITURE_SCALE } from "@/features/office/scene3d/retro-office/objects/furniture";
import type { Seat, SeatGeometry } from "@/features/office/people";

export type AasScenePerson = {
  id: string;
  name: string;
  subtitle: string;
  faceUrl: string;
  pos: PersonPos | null;
  me: boolean;
};

const PERSON_COLOR = "#8a8f98"; // 사람은 회색 몸 — 상태색을 쓰는 에이전트와 섞이지 않게
const GRID_CELL = 25;
const GRID_COLS = Math.ceil(CANVAS_W / GRID_CELL);
const OFFICE_MARGIN = 30; // 바깥 벽 두께만큼 안쪽

/** 원본 격자 + 오피스 바닥 밖을 막는다. 원본 격자는 장면 전체(1800×1800)를 덮어 남쪽 벽(1080) 밖이 빈 칸이었다 —
 *  에이전트는 그쪽으로 갈 일이 없지만 사람은 바깥을 누르면 벽을 지나 나갔다. */
function officeGrid(furniture: FurnitureItem[]): Uint8Array {
  const grid = buildNavGrid(furniture);
  const rows = grid.length / GRID_COLS;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < GRID_COLS; c += 1) {
      const x = c * GRID_CELL + GRID_CELL / 2;
      const y = r * GRID_CELL + GRID_CELL / 2;
      if (x > LOCAL_OFFICE_CANVAS_WIDTH - OFFICE_MARGIN / 2 || y > LOCAL_OFFICE_CANVAS_HEIGHT - OFFICE_MARGIN / 2) grid[r * GRID_COLS + c] = 1;
    }
  }
  return grid;
}

// 자리를 정할 때 실제 모양을 재는 가구. 첫 로딩 때는 아직 받는 중일 수 있어 멈춘다 — 장면이 이 층을 Suspense 로 감싼다
const MEASURED = ["chair", "couch", "beanbag", "desk_cubicle", "round_table", "table_rect", "executive_desk"] as const;

/** 실제 모델 크기로 자리 모양을 만든다. 모델은 항목 좌표 모서리에 놓이고 항목 크기의 가운데를 축으로 돈다
 *  (objects/furniture.tsx 의 buildFurnitureItemMatrix 와 같은 계산). */
function useSeatGeometry(): SeatGeometry {
  const gltfs = useGLTF(MEASURED.map((t) => FURNITURE_GLB[t]), false);
  return useMemo(() => {
    const boxes = new Map<string, { minX: number; maxX: number; minZ: number; maxZ: number }>();
    MEASURED.forEach((t, i) => {
      const b = new THREE.Box3().setFromObject(gltfs[i].scene);
      const [sx, , sz] = FURNITURE_SCALE[t] ?? [1, 1, 1];
      boxes.set(t, { minX: (b.min.x * sx) / SCALE, maxX: (b.max.x * sx) / SCALE, minZ: (b.min.z * sz) / SCALE, maxZ: (b.max.z * sz) / SCALE });
    });
    return {
      box: (it) => {
        if ((it as FurnitureItem).fit) {
          // fit 가구는 모델이 자리 상자를 채운다(furniture.tsx 의 fitModelTransform)
          const { width, height } = getItemBaseSize(it as FurnitureItem);
          return { minX: 0, maxX: width, minZ: 0, maxZ: height };
        }
        const known = boxes.get(it.type);
        if (known) return known;
        const { width, height } = getItemBaseSize(it as FurnitureItem);
        return { minX: 0, maxX: width, minZ: 0, maxZ: height };
      },
      rotation: (it) => getItemRotationRadians(it as FurnitureItem),
      place: (it, lx, lz) => {
        const { width, height } = getItemBaseSize(it as FurnitureItem);
        const r = getItemRotationRadians(it as FurnitureItem);
        const dx = lx - width / 2;
        const dz = lz - height / 2;
        return {
          x: it.x + width / 2 + Math.cos(r) * dx + Math.sin(r) * dz,
          y: it.y + height / 2 - Math.sin(r) * dx + Math.cos(r) * dz,
        };
      },
    };
  }, [gltfs]);
}

const SEAT_MODELS = ["chair", "couch", "beanbag"] as const;
/** 누른 광선을 자리 높이에서 바닥까지 몇 토막으로 나눠 볼지. */
const RAY_STEPS = 12;

/** 앉는 가구 중 가장 높은 모델 윗면(월드 높이). 누른 광선이 이 높이 아래에서 자리 가까이를 지나면 그 자리를 누른 것이다. */
function useSeatTop(): number {
  const gltfs = useGLTF(SEAT_MODELS.map((t) => FURNITURE_GLB[t]), false);
  return useMemo(
    () =>
      Math.max(
        ...SEAT_MODELS.map((t, i) => new THREE.Box3().setFromObject(gltfs[i].scene).max.y * (FURNITURE_SCALE[t]?.[1] ?? 1)),
      ),
    [gltfs],
  );
}

/** 앞길을 이 간격(ms)마다 살핀다. */
const AVOID_EVERY_MS = 150;
/** 이만큼(ms) 막혀 있으면 기다리기를 그만두고 그 자리에 선다. */
const AVOID_GIVE_UP_MS = 2000;

function freeAt(grid: Uint8Array, x: number, y: number): boolean {
  const c = Math.floor(x / GRID_CELL);
  const r = Math.floor(y / GRID_CELL);
  return c >= 0 && r >= 0 && c < GRID_COLS && r * GRID_COLS + c < grid.length && !grid[r * GRID_COLS + c];
}

/** 막히지 않은 가장 가까운 칸의 가운데(처음 들어온 곳이 가구 위면 옆으로 옮긴다). */
function nearestFree(grid: Uint8Array, x: number, y: number): { x: number; y: number } {
  const cols = Math.ceil(CANVAS_W / GRID_CELL);
  const rows = Math.ceil(CANVAS_H / GRID_CELL);
  const c0 = Math.floor(x / GRID_CELL);
  const r0 = Math.floor(y / GRID_CELL);
  for (let d = 0; d < 20; d += 1) {
    for (let dr = -d; dr <= d; dr += 1) {
      for (let dc = -d; dc <= d; dc += 1) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== d) continue;
        const r = r0 + dr;
        const c = c0 + dc;
        if (r < 0 || c < 0 || r >= rows || c >= cols || grid[r * cols + c]) continue;
        return { x: c * GRID_CELL + GRID_CELL / 2, y: r * GRID_CELL + GRID_CELL / 2 };
      }
    }
  }
  return { x, y };
}

function actorOf(p: AasScenePerson, at: { x: number; y: number; f: number }): RenderAgent {
  return {
    id: p.id,
    name: p.name,
    status: "idle",
    color: PERSON_COLOR,
    item: "",
    faceUrl: p.faceUrl,
    x: at.x,
    y: at.y,
    targetX: at.x,
    targetY: at.y,
    path: [],
    facing: at.f,
    frame: 0,
    walkSpeed: 1,
    phaseOffset: 0,
    state: "standing",
  };
}

export const AasPeopleLayer = memo(function AasPeopleLayer({
  people,
  furniture,
  sceneAgentsRef,
  walk,
  instant,
  spawn,
  onMove,
  actorsRef,
}: {
  people: AasScenePerson[];
  furniture: FurnitureItem[];
  /** 장면의 에이전트. 에이전트가 앉아 있거나 앉으러 오는 자리에는 앉지 않고, 앉은 자리에 에이전트가 오면 비킨다 */
  sceneAgentsRef: MutableRefObject<RenderAgent[]>;
  /** 내 아바타를 걷게 한다(900px 이상·웹소켓 연결, 계획 007 G9). */
  walk: boolean;
  /** prefers-reduced-motion: 걷지 않고 바로 옮긴다. */
  instant: boolean;
  spawn: { x: number; y: number };
  onMove: (pos: PersonPos) => void;
  /** 배우 목록. 장면이 갖고 있어 문(DoorModel)도 같은 목록으로 열림을 정한다 */
  actorsRef: MutableRefObject<RenderAgent[]>;
}) {
  const { camera, raycaster, gl } = useThree();
  const lookupRef = useRef(new Map<string, RenderAgent>());
  const grid = useMemo(() => officeGrid(furniture), [furniture]);
  const geometry = useSeatGeometry();
  const seatTop = useSeatTop();
  // 모든 자리(남이 앉은 자리 포함). 앉을 수 있는지는 누를 때 사람·에이전트를 보고 가린다
  const allSeats = useMemo(() => freeSeats(furniture, {}, new Set(), geometry), [furniture, geometry]);
  // 자리로 들어오는 길은 그 자리 가구(붙여 놓은 소파는 함께)만 뺀 격자로 본다 — 벽 등 다른 가구를 지나면 안 된다
  const approachOf = useCallback(
    (s: Seat) => {
      const skip = seatFurniture(furniture, s.item, getItemBounds);
      const without = officeGrid(furniture.filter((f) => !skip.has(f._uid)));
      return approachPoint(s, (x, y) => freeAt(grid, x, y), (x, y) => freeAt(without, x, y));
    },
    [furniture, grid],
  );
  const goal = useRef<PersonPos | null>(null); // 내가 가려는 곳(앉을 의자 포함)
  const sent = useRef<{ pos: PersonPos | null; at: number }>({ pos: null, at: 0 });
  const avoid = useRef({ next: 0, waitSince: 0 }); // 앞길 살피기(다음 살필 때, 막혀 기다리기 시작한 때)
  const meId = people.find((p) => p.me)?.id ?? null;
  const shown = useMemo(() => people.filter((p) => (p.me ? walk : p.pos)), [people, walk]);

  // 받은 사람 목록을 장면 배우로 바꾼다. 다른 사람은 받은 위치까지 걸어간다(1초 4번 받으므로 짧은 걸음이다)
  useEffect(() => {
    const next = new Map<string, RenderAgent>();
    for (const p of shown) {
      let a = lookupRef.current.get(p.id);
      if (!a) {
        // 처음 들어온 사람이 모두 같은 시작 칸에 서면 이름표가 겹친다 — 이미 선 사람과 떨어진 곳에서 시작한다
        const others: { x: number; y: number }[] = [];
        for (const o of shown) {
          const at = o.id === p.id ? null : (lookupRef.current.get(o.id) ?? o.pos);
          if (at) others.push({ x: at.x, y: at.y });
        }
        const start = p.pos ?? (p.me ? { ...spreadFrom(nearestFree(grid, spawn.x, spawn.y), others, (x, y) => freeAt(grid, x, y)), f: 0 } : null);
        if (!start) continue;
        a = actorOf(p, start);
        if (p.me && p.pos) {
          goal.current = p.pos; // 다시 열었을 때 앉아 있던 자리를 지킨다
          if (p.pos.sit) a.state = "sitting";
        }
      }
      a.name = p.name;
      if (!p.me && p.pos) {
        if (Math.hypot(p.pos.x - a.x, p.pos.y - a.y) >= 1) a.path = [{ x: p.pos.x, y: p.pos.y }];
        a.targetX = p.pos.x;
        a.targetY = p.pos.y;
        (a as RenderAgent & { aasSit?: string }).aasSit = p.pos.sit;
        if (!a.path.length) a.facing = p.pos.f;
      }
      if (p.me && p.pos && goal.current && seatRefused(goal.current, p.pos)) {
        goal.current = { ...goal.current, sit: "" }; // 먼저 앉은 사람이 있다 — 그 자리에 선다
        a.state = "standing";
      }
      next.set(p.id, a);
    }
    lookupRef.current = next;
    actorsRef.current = [...next.values()];
  }, [shown, grid, spawn.x, spawn.y]);

  // 바닥 두 번 누르기 → 내 아바타 목적지
  useEffect(() => {
    if (!walk || !meId) return undefined;
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hit = new THREE.Vector3();
    const ndc = new THREE.Vector2();
    const onDbl = (e: MouseEvent) => {
      const rect = gl.domElement.getBoundingClientRect();
      ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      if (!raycaster.ray.intersectPlane(plane, hit)) return;
      const { x: cx, y: cy } = clampToOffice(
        (hit.x + CANVAS_W * SCALE * 0.5) / SCALE,
        (hit.z + CANVAS_H * SCALE * 0.5) / SCALE,
        LOCAL_OFFICE_CANVAS_WIDTH,
        LOCAL_OFFICE_CANVAS_HEIGHT,
        OFFICE_MARGIN,
      );
      // 광선을 자리 높이부터 바닥까지 나눠 바닥 좌표로 옮긴다 — 의자·소파를 누르면 바닥 점은 그 뒤로 밀린다
      const samples: { x: number; y: number }[] = [];
      for (let i = 0; i <= RAY_STEPS; i += 1) {
        const t = (seatTop * (1 - i / RAY_STEPS) - raycaster.ray.origin.y) / raycaster.ray.direction.y;
        if (!(t > 0)) continue;
        const p = raycaster.ray.at(t, new THREE.Vector3());
        samples.push({ x: (p.x + CANVAS_W * SCALE * 0.5) / SCALE, y: (p.z + CANVAS_H * SCALE * 0.5) / SCALE });
      }
      const me = lookupRef.current.get(meId);
      if (!me) return;
      // 다른 사람이 앉은 자리와 에이전트가 쓰는 자리는 뺀다. 책상을 배정받았어도 비운 에이전트의 의자에는 앉는다
      const taken = agentSeats(allSeats, sceneAgentsRef.current);
      for (const a of actorsRef.current) {
        const sit = a.id === meId ? "" : (a as RenderAgent & { aasSit?: string }).aasSit;
        if (sit) taken.add(sit);
      }
      const seats = allSeats.filter((s) => !taken.has(s.uid));
      const isFree = (x: number, y: number) => freeAt(grid, x, y);
      const tables = furniture
        .filter((it) => ["desk_cubicle", "round_table", "table_rect", "executive_desk"].includes(it.type))
        .map((it) => getItemBounds(it));
      const onSeat = seatOnRay(samples, seats, allSeats);
      let target = onSeat ?? pickTarget(cx, cy, seats, undefined, tables);
      const seat = target.sit ? seats.find((s) => s.uid === target.sit) : undefined;
      const sitting = goal.current?.sit ? allSeats.find((s) => s.uid === goal.current?.sit) : undefined;
      const approach = seat ? approachOf(seat) : null;
      if (seat && !approach) target = { ...target, sit: "" }; // 들어올 칸이 없다 — 앉지 않고 그 옆에 선다
      if (seat?.faceOut && approach) target = { ...target, f: Math.atan2(approach.x - seat.x, approach.y - seat.y) };
      const before = goal.current;
      goal.current = target;
      if (instant) {
        Object.assign(me, { x: target.x, y: target.y, path: [], facing: target.f, state: target.sit ? "sitting" : "standing" });
      } else {
        const path = planRoute(
          { x: me.x, y: me.y },
          sitting && me.state === "sitting" ? approachOf(sitting) : null, // 앉아 있었으면 들어온 쪽으로 먼저 나간다
          { x: target.x, y: target.y },
          target.sit ? approach : null,
          isFree,
          (fx, fy, tx, ty) => astar(fx, fy, tx, ty, grid),
        );
        if (!path.length) {
          goal.current = before; // 갈 길이 없다(닫힌 방 등) — 그 자리에 머문다
          return;
        }
        const end = path[path.length - 1];
        if (!target.sit && end) goal.current = { ...target, x: end.x, y: end.y }; // 막힌 곳을 눌렀으면 그 옆 빈 칸에 선다
        Object.assign(me, { path, targetX: target.x, targetY: target.y, state: "walking" });
      }
    };
    gl.domElement.addEventListener("dblclick", onDbl);
    return () => gl.domElement.removeEventListener("dblclick", onDbl);
  }, [walk, meId, gl, camera, raycaster, furniture, grid, instant, seatTop, allSeats, approachOf, actorsRef, sceneAgentsRef]);

  useFrame((_, dt) => {
    const step = PERSON_SPEED * Math.min(dt, 0.1);
    const nowMs = performance.now();
    // 내 앞길을 서 있거나 걷는 에이전트·다른 사람이 막으면 돌아간다. 고정 격자 길은 캐릭터를 보지 않아 뚫고 지나갔다.
    // 앉은 캐릭터는 의자 칸에 있어 길을 막지 않는다(소파 옆자리로 갈 때 멈추지 않게 뺀다)
    const meNow = meId && walk && !instant ? lookupRef.current.get(meId) : undefined;
    if (meNow?.path.length && nowMs >= avoid.current.next) {
      avoid.current.next = nowMs + AVOID_EVERY_MS;
      const others = [...sceneAgentsRef.current, ...actorsRef.current.filter((a) => a.id !== meId)]
        .filter((a) => a.state !== "sitting" && a.state !== "away")
        .map((a) => ({ x: a.x, y: a.y }));
      const next = detour(meNow, meNow.path, others, (fx, fy, tx, ty, blockers) => astar(fx, fy, tx, ty, gridAround(grid, blockers, GRID_COLS, GRID_CELL)));
      if (!next) avoid.current.waitSince = 0;
      else if (next.length) {
        meNow.path = next;
        avoid.current.waitSince = 0;
      } else if (!avoid.current.waitSince) avoid.current.waitSince = nowMs;
      else if (nowMs - avoid.current.waitSince > AVOID_GIVE_UP_MS) {
        // 오래 막혀 있으면(목적지에 누가 서 있다) 그 자리에 선다
        meNow.path = [];
        goal.current = { x: meNow.x, y: meNow.y, f: meNow.facing, sit: "" };
        avoid.current.waitSince = 0;
      }
    }
    const waiting = !!avoid.current.waitSince;
    if (meNow && waiting) meNow.state = "standing";
    for (const a of actorsRef.current) {
      if (waiting && a === meNow) continue; // 막혀서 기다린다
      const wp = a.path[0];
      if (wp) {
        const dx = wp.x - a.x;
        const dy = wp.y - a.y;
        const dist = Math.hypot(dx, dy);
        if (dist > step) {
          a.x += (dx / dist) * step;
          a.y += (dy / dist) * step;
          a.facing = Math.atan2(dx, dy);
          a.state = "walking";
        } else {
          a.x = wp.x;
          a.y = wp.y;
          a.path = a.path.slice(1);
        }
        a.frame += 1;
      }
      if (!a.path.length && a.state === "walking") {
        const sit = a.id === meId ? goal.current?.sit : (a as RenderAgent & { aasSit?: string }).aasSit;
        a.state = sit ? "sitting" : "standing";
        if (a.id === meId && goal.current) a.facing = goal.current.f;
      }
    }
    if (!walk || !meId) return;
    const me = lookupRef.current.get(meId);
    if (!me) return;
    // 내가 앉은 자리에 그 자리 에이전트가 앉으러 오면(또는 앉았으면) 들어온 쪽으로 일어나 비킨다
    const mine = me.state === "sitting" && goal.current?.sit ? allSeats.find((s) => s.uid === goal.current?.sit) : undefined;
    if (mine && agentSeats([mine], sceneAgentsRef.current).size) {
      const out = approachOf(mine) ?? { x: mine.x + mine.out.x * 25, y: mine.y + mine.out.y * 25 };
      goal.current = { x: out.x, y: out.y, f: me.facing, sit: "" };
      if (instant) Object.assign(me, { x: out.x, y: out.y, path: [], state: "standing" });
      else Object.assign(me, { path: [out], targetX: out.x, targetY: out.y, state: "walking" });
    }
    const arrived = !me.path.length;
    const now: PersonPos = { x: me.x, y: me.y, f: me.facing, sit: arrived ? goal.current?.sit ?? "" : "" };
    const at = performance.now();
    if (shouldPublish(sent.current.pos, now, sent.current.at, at)) {
      sent.current = { pos: now, at };
      onMove(now);
    }
  });

  return (
    <>
      {shown.map((p) => (
        <AgentModel
          key={p.id}
          agentId={p.id}
          name={p.name}
          subtitle={p.subtitle}
          subtitlePinned={p.me}
          status="idle"
          color={PERSON_COLOR}
          faceUrl={p.faceUrl}
          agentsRef={actorsRef}
          agentLookupRef={lookupRef}
        />
      ))}
    </>
  );
});
