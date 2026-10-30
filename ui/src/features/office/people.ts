/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 내 아바타로 걷기(계획 007 P6b). 장면과 상관없는 계산만 둔다 — 의자 고르기, 위치 이벤트 반영, 보낼지 판단.
// 위치는 웹소켓 토픽 office:presence 로 주고받는다. 서버는 같은 의자를 먼저 요청한 사람에게 준다.
import { useEffect, useState } from 'react';

import { wsClient } from '@/lib/ws';

export interface PersonPos {
  x: number;
  y: number;
  /** 바라보는 방향(라디안). */
  f: number;
  /** 앉은 의자의 _uid. 서 있으면 빈 문자열. */
  sit: string;
}

export interface Seat {
  uid: string;
  x: number;
  y: number;
  /** 앉았을 때 바라보는 방향(라디안, 장면의 facing 과 같은 규칙: atan2(dx, dy)). */
  f: number;
  /** 들어오고 나가는 쪽(단위 벡터, 먼저 살필 쪽). 이쪽부터 빈 칸을 찾아 걸어온 뒤 마지막 짧은 구간만 자리로 들어간다. */
  out: { x: number; y: number };
  /** 자리가 속한 가구의 _uid(소파는 한 가구에 자리가 여럿). 들어오는 길을 검사할 때 이 가구만 뺀다. */
  item: string;
  /** 앉으면 들어온 쪽(트인 쪽)을 본다 — 소파·빈백. 모델마다 앞면 방향 규칙이 달라 모델 회전에 기대지 않는다. */
  faceOut?: boolean;
}

interface LayoutItem {
  _uid: string;
  type: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  r?: number;
  facing?: number;
  vertical?: boolean;
}

/** 0.25초에 한 번까지 보낸다 — 서버는 1초 4번을 넘으면 버린다. */
export const PUB_EVERY_MS = 250;
/** 자리에서 이만큼(장면 픽셀) 안을 두 번 누르면 그 자리로 간다. 책상을 눌러도 그 앞 의자가 잡히게 넉넉히 둔다. */
export const SEAT_PICK_RADIUS = 70;
/** 걷는 빠르기(장면 픽셀/초). */
export const PERSON_SPEED = 140;
/** 소파 한 자리 폭(장면 픽셀). 소파 길이를 이 폭으로 나눠 자리 수를 정한다. */
export const COUCH_SEAT = 33; // AAS: 소파를 의자 비율로 줄여(길이 66) 한 자리 폭도 줄였다. 소파 하나에 두 사람(2026-10-16)

/** 가구의 모양(장면 픽셀). 장면이 실제 모델 크기로 채운다 — 가구 모델은 항목 좌표 모서리에 놓여 항목 크기의 가운데와 다르다. */
export interface SeatGeometry {
  /** 회전하기 전 모델의 상자(항목 모서리 기준, 장면 픽셀). */
  box: (it: LayoutItem) => { minX: number; maxX: number; minZ: number; maxZ: number };
  /** 모델 안의 한 점(회전 전)을 바닥 좌표로. */
  place: (it: LayoutItem, lx: number, lz: number) => { x: number; y: number };
  rotation: (it: LayoutItem) => number;
}

const TABLES = new Set(['round_table', 'table_rect', 'desk_cubicle', 'executive_desk']);
const dir = (f: number) => ({ x: Math.sin(f), y: Math.cos(f) });

function centerOf(it: LayoutItem, g: SeatGeometry) {
  const b = g.box(it);
  return g.place(it, (b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2);
}

/** 사람이 앉을 수 있는 자리: 의자(책상 앞 의자·회의 의자), 소파(길이만큼 여러 자리), 빈백. 남이 앉은 자리와
 *  에이전트에게 배정된 책상의 의자는 뺀다(에이전트가 그 책상에 앉는다). */
export function freeSeats(items: LayoutItem[], desks: Record<string, string>, taken: Set<string>, g: SeatGeometry): Seat[] {
  const out: Seat[] = [];
  const tables = items.filter((it) => TABLES.has(it.type)).map((it) => ({ it, c: centerOf(it, g) }));
  for (const it of items) {
    if (it.type === 'chair') {
      const c = centerOf(it, g);
      // 가장 가까운 탁자·책상(140 안)을 바라보고 의자 뒤에서 들어온다. 없으면 의자가 놓인 방향
      let near: (typeof tables)[number] | null = null;
      let nd = 140;
      for (const t of tables) {
        const d = Math.hypot(t.c.x - c.x, t.c.y - c.y);
        if (d < nd) {
          near = t;
          nd = d;
        }
      }
      if (near && near.it.type === 'desk_cubicle' && desks[near.it._uid]) continue;
      const f = near ? Math.atan2(near.c.x - c.x, near.c.y - c.y) : g.rotation(it);
      const face = dir(f);
      out.push({ uid: it._uid, x: c.x, y: c.y, f, out: { x: -face.x, y: -face.y }, item: it._uid });
    } else if (it.type === 'couch' || it.type === 'beanbag') {
      const b = g.box(it);
      const r = g.rotation(it);
      const front = dir(r);
      // 모델의 긴 쪽(회전 전 x)을 따라 자리를 나눈다. 앉는 깊이는 상자 가운데
      const len = b.maxX - b.minX;
      const n = it.type === 'beanbag' ? 1 : Math.max(1, Math.round(len / COUCH_SEAT));
      const mz = (b.minZ + b.maxZ) / 2;
      for (let i = 0; i < n; i += 1) {
        const p = g.place(it, b.minX + (len * (i + 0.5)) / n, mz);
        out.push({ uid: n === 1 ? it._uid : `${it._uid}:${i}`, x: p.x, y: p.y, f: r, out: front, item: it._uid, faceOut: true });
      }
    }
  }
  return out.filter((s) => !taken.has(s.uid));
}

/** 누른 곳을 목적지로 바꾼다. 빈 자리 가까이를 눌렀으면 그 자리에 앉으러 간다.
 *  책상·탁자(tables, 바닥 상자)를 눌렀으면 그 가구에서 가장 가까운 빈 자리로 간다 — 윗면이 바닥보다 높아 누른 점이
 *  바닥에서는 가구 뒤쪽으로 계산되기 때문이다. */
export function pickTarget(
  x: number,
  y: number,
  seats: Seat[],
  radius = SEAT_PICK_RADIUS,
  tables: { x: number; y: number; w: number; h: number }[] = []
): PersonPos {
  const pad = 70; // 책상 윗면 높이(약 42) 때문에 바닥에서 계산한 점이 가구 뒤로 40~60 밀린다
  // 판정 여유 안에 든 가구가 여럿이면(위아래 책상) 누른 점에서 상자까지 가장 가까운 것
  const gap = (t: { x: number; y: number; w: number; h: number }) =>
    Math.hypot(Math.max(t.x - x, 0, x - t.x - t.w), Math.max(t.y - y, 0, y - t.y - t.h));
  const hitTable = tables.filter((t) => gap(t) <= pad).sort((a, b) => gap(a) - gap(b))[0];
  const at = hitTable ? { x: hitTable.x + hitTable.w / 2, y: hitTable.y + hitTable.h / 2 } : { x, y };
  const reach = hitTable ? Math.max(radius, Math.hypot(hitTable.w, hitTable.h) / 2 + 60) : radius;
  let best: Seat | null = null;
  let bestD = reach;
  for (const s of seats) {
    const d = Math.hypot(s.x - at.x, s.y - at.y);
    if (d <= bestD) {
      best = s;
      bestD = d;
    }
  }
  return best ? { x: best.x, y: best.y, f: best.f, sit: best.uid } : { x, y, f: 0, sit: '' };
}

/** 누른 광선이 이만큼(장면 픽셀) 안으로 자리 가운데를 지나면 그 자리를 누른 것으로 본다. 의자 상자(24)의 반쯤. */
export const SEAT_HIT_RADIUS = 16;

/** 누른 광선이 지나간 자리. samples 는 광선 위 점을 카메라 쪽(자리 높이)부터 바닥까지 차례로 바닥 좌표로 옮긴 것이다.
 *  바닥 점만 보면 의자·소파를 눌러도 점이 가구 뒤(옆 책상·탁자)로 밀려 pickTarget 이 그 책상에서 가까운 다른 자리를
 *  골랐다(2026-10-20 에이전트 책상 의자를 눌렀는데 팀장석에 앉음). 먼저 지나간 자리를 고르고, 남의 자리면(all 에만 있다)
 *  앉지 않고 그 옆에 선다. 지나간 자리가 없으면 null. */
export function seatOnRay(samples: { x: number; y: number }[], free: Seat[], all: Seat[], radius = SEAT_HIT_RADIUS): PersonPos | null {
  for (const p of samples) {
    let best: Seat | null = null;
    let bestD = radius;
    for (const s of all) {
      const d = Math.hypot(s.x - p.x, s.y - p.y);
      if (d <= bestD) {
        best = s;
        bestD = d;
      }
    }
    if (best) {
      const uid = best.uid;
      return { x: best.x, y: best.y, f: best.f, sit: free.some((s) => s.uid === uid) ? uid : '' };
    }
  }
  return null;
}

/** 에이전트가 이만큼(장면 픽셀) 안에 앉아 있거나 그곳으로 걸어가면 그 자리를 쓰는 것으로 본다. 책상 자리(deskSeatOf)는 의자 가운데와 같다. */
export const AGENT_SEAT_NEAR = 12;

/** 에이전트가 지금 쓰는 자리: 앉아 있는 곳, 또는 앉으러 걸어가는 목적지. 책상을 배정받았어도 자리를 비운 에이전트의 의자는
 *  비어 있다 — 사람이 앉을 수 있고, 에이전트가 돌아오면 사람이 비킨다(2026-10-20 사용자 결정). */
export function agentSeats(
  seats: Seat[],
  agents: { x: number; y: number; targetX: number; targetY: number; state: string }[],
  near = AGENT_SEAT_NEAR
): Set<string> {
  const out = new Set<string>();
  for (const a of agents) {
    const at = a.state === 'sitting' ? { x: a.x, y: a.y } : a.state === 'walking' ? { x: a.targetX, y: a.targetY } : null;
    if (!at) continue;
    for (const s of seats) if (Math.hypot(s.x - at.x, s.y - at.y) <= near) out.add(s.uid);
  }
  return out;
}

/** 지금 위치를 보낼 때인가. 바뀌지 않았으면 보내지 않는다. */
export function shouldPublish(last: PersonPos | null, now: PersonPos, lastAt: number, at: number): boolean {
  if (last && at - lastAt < PUB_EVERY_MS) return false;
  if (!last) return true;
  return Math.abs(last.x - now.x) >= 1 || Math.abs(last.y - now.y) >= 1 || last.sit !== now.sit || Math.abs(last.f - now.f) >= 0.1;
}

/** 내 의자 요청을 서버가 거절했는가: 의자 자리에 선 채로 sit 이 비어 돌아왔다(먼저 앉은 사람이 있다). */
export function seatRefused(asked: PersonPos, echo: PersonPos): boolean {
  return asked.sit !== '' && echo.sit === '' && Math.abs(echo.x - asked.x) < 1 && Math.abs(echo.y - asked.y) < 1;
}

type PresenceEvent =
  | { type: 'snapshot'; payload: { people: { id: string; pos?: PersonPos }[] } }
  | { type: 'person.move'; payload: PersonPos & { id: string } }
  | { type: 'person.leave'; payload: { id: string } };

/** office:presence 이벤트 하나를 위치 표에 반영한다. */
export function applyPresence(prev: Record<string, PersonPos>, ev: PresenceEvent): Record<string, PersonPos> {
  if (ev.type === 'snapshot') {
    const next: Record<string, PersonPos> = {};
    for (const p of ev.payload.people ?? []) if (p.pos) next[p.id] = p.pos;
    return next;
  }
  if (ev.type === 'person.move') {
    const { id, ...pos } = ev.payload;
    return { ...prev, [id]: pos };
  }
  if (ev.type === 'person.leave') {
    const next = { ...prev };
    delete next[ev.payload.id];
    return next;
  }
  return prev;
}

/** 사람들의 위치(id → 위치). enabled 가 거짓이면 구독하지 않는다(좁은 화면·2D·웹소켓 없음). */
export function usePeoplePositions(enabled: boolean): Record<string, PersonPos> {
  const [pos, setPos] = useState<Record<string, PersonPos>>({});
  useEffect(() => {
    if (!enabled) return undefined;
    return wsClient.subscribe('office:presence', (data) => setPos((prev) => applyPresence(prev, data as PresenceEvent)));
  }, [enabled]);
  return enabled ? pos : {};
}

export function publishPosition(pos: PersonPos): boolean {
  return wsClient.publish('office:presence', { ...pos });
}
