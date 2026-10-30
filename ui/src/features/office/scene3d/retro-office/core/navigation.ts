import { CANVAS_H, CANVAS_W, SNAP_GRID } from "@/features/office/scene3d/retro-office/core/constants";
import {
  getItemBounds,
  ITEM_FOOTPRINT,
  ITEM_METADATA,
  snap,
} from "@/features/office/scene3d/retro-office/core/geometry";
import type {
  FacingPoint,
  FurnitureItem,
  GymWorkoutLocation,
  QaLabStationLocation,
} from "@/features/office/scene3d/retro-office/core/types";
export {
  GYM_DEFAULT_TARGET,
  resolveGymRoute,
} from "@/features/office/scene3d/retro-office/core/navigation/gymRoute";
export { getJanitorCleaningStops } from "@/features/office/scene3d/retro-office/core/navigation/janitorStops";
export {
  resolveSmsBoothRoute,
  SMS_BOOTH_DEFAULT_TARGET,
} from "@/features/office/scene3d/retro-office/core/navigation/smsBoothRoute";
export {
  PHONE_BOOTH_DEFAULT_TARGET,
  resolvePhoneBoothRoute,
} from "@/features/office/scene3d/retro-office/core/navigation/phoneBoothRoute";
export {
  QA_LAB_DEFAULT_TARGET,
  resolveQaLabRoute,
} from "@/features/office/scene3d/retro-office/core/navigation/qaLabRoute";
export {
  resolveServerRoomRoute,
  SERVER_ROOM_TARGET,
} from "@/features/office/scene3d/retro-office/core/navigation/serverRoomRoute";

export const resolvePingPongTargets = (
  item: FurnitureItem,
): [FacingPoint, FacingPoint] => {
  const width = item.w ?? 100;
  const depth = item.h ?? 60;
  const centerY = snap(item.y + depth / 2);
  return [
    { x: snap(item.x - 40), y: centerY, facing: Math.PI / 2 },
    { x: snap(item.x + width + 20), y: centerY, facing: -Math.PI / 2 },
  ];
};

// AAS: 한국 사무실 배치(계획 2026-10-13-001)의 통로로 바꿨다. 원본 점은 새 회의실 벽·책상 섬 위에 걸린다(독립 검토 O9).
// 시험: aasKoreanOffice.test.ts 가 모든 점이 열린 칸이고 입구에서 닿는지 본다
export const ROAM_POINTS = [
  // kr-21(2026-10-26-007): 책상 섬 두 줄이 25 내려와 두 줄 사이 통로(634~737)의 가운데로 옮겼다(600 → 675)
  { x: 540, y: 675 },
  { x: 1000, y: 675 },
  { x: 1470, y: 420 },
  { x: 1470, y: 820 },
  // kr-21: 북쪽 회의실 유리벽이 240 으로 내려와 벽 통행 여유(263) 밖으로 옮겼다(250 → 300)
  { x: 540, y: 300 },
  { x: 1000, y: 300 },
  { x: 90, y: 620 },
];

export const JANITOR_ENTRY_POINTS: FacingPoint[] = [
  { x: 80, y: 360, facing: Math.PI / 2 },
  { x: 820, y: 70, facing: Math.PI },
  { x: 1540, y: 360, facing: -Math.PI / 2 },
];

export const JANITOR_EXIT_POINTS: FacingPoint[] = [
  { x: 110, y: 680, facing: Math.PI / 2 },
  { x: 820, y: 680, facing: Math.PI },
  { x: 1510, y: 680, facing: -Math.PI / 2 },
];

const GRID_CELL = 25;
const GRID_COLS = Math.ceil(CANVAS_W / GRID_CELL);
const GRID_ROWS = Math.ceil(CANVAS_H / GRID_CELL);

export type NavGrid = Uint8Array;

/**
 * Returns true if the given item type should block pathfinding cells.
 * Driven by ITEM_METADATA.blocksNavigation — the single source of truth for
 * nav-blocking behaviour. Unknown types default to false (non-blocking) so
 * newly added decorative items never accidentally block navigation.
 */
const itemBlocksNavigation = (type: string): boolean =>
  ITEM_METADATA[type]?.blocksNavigation ?? false;

/** 격자 칸 값: 0 빈 칸, 1 막힌 칸, 2 의자 칸(출발점·목표가 그 의자 안일 때만 열린다). */
const CELL_FREE = 0;
const CELL_BLOCKED = 1;
const CELL_SEAT = 2;
/** 앉는 자리 점이 의자 상자에서 이만큼 바깥이어도 그 의자의 자리로 본다. */
const SEAT_REACH = 6;
/** 다른 사람의 의자 칸 하나를 지날 때 더하는 비용(보통 걸음 1). 돌아가는 길이 이보다 짧으면 돌아간다. */
const SEAT_COST = 60;

type Rect = { x: number; y: number; w: number; h: number };
/** 격자마다 의자 몸체 상자. 길 찾기가 출발점·목표를 품은 의자만 열 때 쓴다. */
const SEAT_RECTS = new WeakMap<NavGrid, Rect[]>();

/** 상자가 덮는 격자 칸의 범위(buildNavGrid 가 칸을 막는 식과 같다, 통행 여유 0). */
const cellRange = (b: Rect) => ({
  c1: Math.max(0, Math.floor(b.x / GRID_CELL)),
  c2: Math.min(GRID_COLS - 1, Math.floor((b.x + b.w) / GRID_CELL)),
  r1: Math.max(0, Math.floor(b.y / GRID_CELL)),
  r2: Math.min(GRID_ROWS - 1, Math.floor((b.y + b.h) / GRID_CELL)),
});

export function buildNavGrid(furniture: FurnitureItem[]): NavGrid {
  const grid = new Uint8Array(GRID_COLS * GRID_ROWS);
  const seatRects: Rect[] = [];
  SEAT_RECTS.set(grid, seatRects);
  const defaultPad = GRID_CELL * 0.6;
  for (const item of furniture) {
    if (!itemBlocksNavigation(item.type)) continue;
    const itemPad = ITEM_METADATA[item.type]?.navPadding ?? defaultPad;
    const bounds = getItemBounds(item);
    const x1 = bounds.x - itemPad;
    const y1 = bounds.y - itemPad;
    const x2 = bounds.x + bounds.w + itemPad;
    const y2 = bounds.y + bounds.h + itemPad;
    const c1 = Math.max(0, Math.floor(x1 / GRID_CELL));
    const c2 = Math.min(GRID_COLS - 1, Math.floor(x2 / GRID_CELL));
    const r1 = Math.max(0, Math.floor(y1 / GRID_CELL));
    const r2 = Math.min(GRID_ROWS - 1, Math.floor(y2 / GRID_CELL));
    const soft = ITEM_METADATA[item.type]?.softBlock ?? false;
    if (soft) seatRects.push({ x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h });
    for (let row = r1; row <= r2; row += 1) {
      for (let column = c1; column <= c2; column += 1) {
        const at = row * GRID_COLS + column;
        // 의자 칸은 다른 가구가 이미 막은 칸을 덮어쓰지 않는다. 막는 가구가 겹치면 막힌 칸이다
        if (soft) {
          if (grid[at] === CELL_FREE) grid[at] = CELL_SEAT;
        } else {
          grid[at] = CELL_BLOCKED;
        }
      }
    }
  }

  for (let column = 0; column < GRID_COLS; column += 1) {
    grid[column] = 1;
    grid[(GRID_ROWS - 1) * GRID_COLS + column] = 1;
  }
  for (let row = 0; row < GRID_ROWS; row += 1) {
    grid[row * GRID_COLS] = 1;
    grid[row * GRID_COLS + GRID_COLS - 1] = 1;
  }
  return grid;
}

/**
 * 길 찾기. 다른 사람의 의자 칸은 지날 수 있지만 칸마다 SEAT_COST 를 더해 거의 돌아간다 — 팀장 의자가 통로에 놓여 있어 캐릭터가 뚫고 다녔다(사용자 보고 2026-10-16).
 * 막아 버리지 않는 까닭: 회의실 윗줄은 벽과 탁자 사이 한 칸 폭 통로에 의자가 빈틈없이 붙어 있어 가운데 자리는 이웃 의자를 지나야만 닿는다.
 * 출발점·목표를 품은 의자는 비용 없이 연다(자기 자리에 앉고 일어서는 걸음).
 */
export function astar(
  sx: number,
  sy: number,
  ex: number,
  ey: number,
  grid: NavGrid,
): { x: number; y: number }[] {
  const clamp = (value: number, low: number, high: number) =>
    Math.min(high, Math.max(low, value));
  const toCell = (x: number, y: number) => ({
    c: clamp(Math.floor(x / GRID_CELL), 0, GRID_COLS - 1),
    r: clamp(Math.floor(y / GRID_CELL), 0, GRID_ROWS - 1),
  });
  const cellCx = (column: number) => column * GRID_CELL + GRID_CELL / 2;
  const cellCy = (row: number) => row * GRID_CELL + GRID_CELL / 2;

  // 출발점·목표를 품은 의자(상자에서 SEAT_REACH 떨어진 곳까지)만 이 길 찾기에서 연다. 이웃 의자 칸은 열지 않는다(CELL_SEAT).
  // 회의 자리는 의자 가운데에서 바깥으로 14 당긴 점이라(getMeetingSeatLocations) 의자 상자(반 12) 2 바깥에 놓인다
  const openSeat = new Set<number>();
  const openSeatsAround = (x: number, y: number) => {
    for (const r of SEAT_RECTS.get(grid) ?? []) {
      if (x < r.x - SEAT_REACH || x > r.x + r.w + SEAT_REACH || y < r.y - SEAT_REACH || y > r.y + r.h + SEAT_REACH) continue;
      const { c1, c2, r1, r2 } = cellRange(r);
      for (let row = r1; row <= r2; row += 1) for (let column = c1; column <= c2; column += 1) openSeat.add(row * GRID_COLS + column);
    }
  };
  openSeatsAround(sx, sy);
  openSeatsAround(ex, ey);
  const isBlocked = (at: number) => grid[at] === CELL_BLOCKED;
  const seatPenalty = (at: number) => (grid[at] === CELL_SEAT && !openSeat.has(at) ? SEAT_COST : 0);
  const findFree = (column: number, row: number) => {
    if (!isBlocked(row * GRID_COLS + column)) return { c: column, r: row };
    for (let distance = 1; distance < 10; distance += 1) {
      for (let rowOffset = -distance; rowOffset <= distance; rowOffset += 1) {
        for (
          let columnOffset = -distance;
          columnOffset <= distance;
          columnOffset += 1
        ) {
          if (
            Math.abs(rowOffset) !== distance &&
            Math.abs(columnOffset) !== distance
          ) {
            continue;
          }
          const nextRow = row + rowOffset;
          const nextColumn = column + columnOffset;
          if (
            nextRow < 0 ||
            nextRow >= GRID_ROWS ||
            nextColumn < 0 ||
            nextColumn >= GRID_COLS
          ) {
            continue;
          }
          if (!isBlocked(nextRow * GRID_COLS + nextColumn)) {
            return { c: nextColumn, r: nextRow };
          }
        }
      }
    }
    return null;
  };

  let { c: sc, r: sr } = toCell(sx, sy);
  let { c: ec, r: er } = toCell(ex, ey);
  const startFree = findFree(sc, sr);
  const endFree = findFree(ec, er);
  if (!startFree || !endFree) return [];
  sc = startFree.c;
  sr = startFree.r;
  ec = endFree.c;
  er = endFree.r;
  // Same nav cell: start and end are close enough that A* has no grid edges
  // to traverse. The destination is still reachable — return a single-waypoint
  // path to the exact target pixel so the movement layer can make the final
  // fine-grained adjustment instead of staying put.
  if (sc === ec && sr === er) return [{ x: ex, y: ey }];

  const nodeCount = GRID_COLS * GRID_ROWS;
  const gCost = new Float32Array(nodeCount).fill(Infinity);
  const parent = new Int32Array(nodeCount).fill(-1);
  const visited = new Uint8Array(nodeCount);
  const startIndex = sr * GRID_COLS + sc;
  const endIndex = er * GRID_COLS + ec;
  gCost[startIndex] = 0;

  const open: [number, number][] = [];
  const pushOpen = (entry: [number, number]) => {
    open.push(entry);
    let index = open.length - 1;
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      if (open[parentIndex][1] <= entry[1]) break;
      open[index] = open[parentIndex];
      index = parentIndex;
    }
    open[index] = entry;
  };
  const popOpen = (): [number, number] | null => {
    if (open.length === 0) return null;
    const first = open[0];
    const last = open.pop();
    if (!last || open.length === 0) return first;
    let index = 0;
    while (true) {
      const leftIndex = index * 2 + 1;
      const rightIndex = leftIndex + 1;
      if (leftIndex >= open.length) break;
      let smallestIndex = leftIndex;
      if (
        rightIndex < open.length &&
        open[rightIndex][1] < open[leftIndex][1]
      ) {
        smallestIndex = rightIndex;
      }
      if (open[smallestIndex][1] >= last[1]) break;
      open[index] = open[smallestIndex];
      index = smallestIndex;
    }
    open[index] = last;
    return first;
  };
  pushOpen([startIndex, Math.hypot(ec - sc, er - sr)]);
  const directions: [number, number, number][] = [
    [1, 0, 1],
    [-1, 0, 1],
    [0, 1, 1],
    [0, -1, 1],
    [1, 1, 1.414],
    [1, -1, 1.414],
    [-1, 1, 1.414],
    [-1, -1, 1.414],
  ];

  while (open.length) {
    const next = popOpen();
    if (!next) break;
    const [current] = next;
    if (visited[current]) continue;
    visited[current] = 1;

    if (current === endIndex) {
      const path: { x: number; y: number }[] = [];
      let node = current;
      while (node !== startIndex) {
        path.push({
          x: cellCx(node % GRID_COLS),
          y: cellCy(Math.floor(node / GRID_COLS)),
        });
        node = parent[node];
      }
      path.reverse();
      if (path.length) path[path.length - 1] = { x: ex, y: ey };
      else path.push({ x: ex, y: ey });
      return path;
    }

    const currentColumn = current % GRID_COLS;
    const currentRow = Math.floor(current / GRID_COLS);
    for (const [columnOffset, rowOffset, cost] of directions) {
      const nextColumn = currentColumn + columnOffset;
      const nextRow = currentRow + rowOffset;
      if (
        nextColumn < 0 ||
        nextColumn >= GRID_COLS ||
        nextRow < 0 ||
        nextRow >= GRID_ROWS
      ) {
        continue;
      }
      const nextIndex = nextRow * GRID_COLS + nextColumn;
      if (visited[nextIndex] || isBlocked(nextIndex)) continue;

      // For diagonal moves, require both orthogonal neighbours to be free so
      // agents cannot clip through the corner of a blocked cell (issue #6).
      // E.g. moving NE (dc=+1, dr=-1) requires N (dc=0, dr=-1) and E (dc=+1, dr=0) to be clear.
      if (columnOffset !== 0 && rowOffset !== 0) {
        const orthogonalA =
          (currentRow + rowOffset) * GRID_COLS + currentColumn;
        const orthogonalB =
          currentRow * GRID_COLS + (currentColumn + columnOffset);
        if (isBlocked(orthogonalA) || isBlocked(orthogonalB)) continue;
      }
      const nextCost = gCost[current] + cost + seatPenalty(nextIndex);
      if (nextCost < gCost[nextIndex]) {
        gCost[nextIndex] = nextCost;
        parent[nextIndex] = current;
        pushOpen([
          nextIndex,
          nextCost + Math.hypot(ec - nextColumn, er - nextRow),
        ]);
      }
    }
  }

  return [];
}

/** AAS: 책상 자리(앉는 곳). 원본은 방향과 관계없이 (x+40, y-5) 였다 — 마주 보는 섬에서 남쪽을 보는 책상(facing 180)의
 *  에이전트가 칸막이 쪽에 섰다(계획 2026-10-13-001 독립 검토 O1). 책상 가운데를 축으로 책상 방향만큼 돌린다. */
export const deskSeatOf = (item: FurnitureItem): { x: number; y: number } => {
  const w = item.w ?? 100;
  const h = item.h ?? 55;
  const cx = item.x + w / 2;
  const cy = item.y + h / 2;
  // fit 책상은 모델이 상자를 채우고 앉는 쪽이 모델 앞(+z)이다: 상자 앞 가장자리에서 의자 가운데(16)만큼 밖
  const dx = item.fit ? 0 : 40 - w / 2;
  const dz = item.fit ? h / 2 + 16 : -5 - h / 2;
  const r = ((item.facing ?? 0) * Math.PI) / 180;
  return { x: Math.round(cx + Math.cos(r) * dx + Math.sin(r) * dz), y: Math.round(cy - Math.sin(r) * dx + Math.cos(r) * dz) };
};

/** AAS: 쉬는 에이전트가 들르는 가구(소파·정수기 등) 옆 지점 넷 — 가구 상자 가장자리에서 30 바깥. 원본은 왼쪽 위 모서리
 *  (x, y)에 ±30 을 더해 목표가 가구 안이나 옆 탁자 안에 떨어졌고, astar 가 마지막 구간을 목표로 곧장 이어 에이전트가
 *  휴게 공간 탁자를 지나 그 안에 섰다(2026-10-13 사용자 보고). 막힌 칸의 지점은 부르는 쪽에서 거른다(isFree). */
export const socialTargetsOf = (
  f: FurnitureItem,
  isFree: (x: number, y: number) => boolean = () => true,
): { x: number; y: number }[] => {
  const b = getItemBounds(f);
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  return [
    { x: b.x + b.w + 30, y: cy },
    { x: b.x - 30, y: cy },
    { x: cx, y: b.y + b.h + 30 },
    { x: cx, y: b.y - 30 },
  ]
    .map((p) => ({
      x: Math.max(SNAP_GRID, Math.min(CANVAS_W - SNAP_GRID, Math.round(p.x / SNAP_GRID) * SNAP_GRID)),
      y: Math.max(SNAP_GRID, Math.min(CANVAS_H - SNAP_GRID, Math.round(p.y / SNAP_GRID) * SNAP_GRID)),
    }))
    .filter((p) => isFree(p.x, p.y));
};

/** 격자에서 그 점이 지나갈 수 있는 칸인가. */
export const isNavFree = (grid: NavGrid, x: number, y: number): boolean => {
  const column = Math.floor(x / GRID_CELL);
  const row = Math.floor(y / GRID_CELL);
  if (column < 0 || column >= GRID_COLS || row < 0 || row >= GRID_ROWS) return false;
  return grid[row * GRID_COLS + column] === CELL_FREE;
};

/** 오래 자리를 비운 에이전트가 앉는 소파 위 지점. AAS: 가구 상자 가운데. 원본은 모서리에서 (20, 20)이라 작은 소파(66×28)에서는
 *  뒤쪽 벽 경계 칸에 찍혔고, 길 찾기가 고른 빈 칸이 옆 소파 너머면 마지막 걸음이 옆 소파를 가로질렀다(2026-10-16). */
export const awayTargetOf = (f: FurnitureItem): { x: number; y: number } => {
  const b = getItemBounds(f);
  return {
    x: Math.max(SNAP_GRID, Math.min(CANVAS_W - SNAP_GRID, Math.round((b.x + b.w / 2) / SNAP_GRID) * SNAP_GRID)),
    y: Math.max(SNAP_GRID, Math.min(CANVAS_H - SNAP_GRID, Math.round((b.y + b.h / 2) / SNAP_GRID) * SNAP_GRID)),
  };
};

/** AAS(2026-10-21-023): 책상 자리에 앉은 에이전트가 볼 방향(이동 틱과 같은 atan2(dx, dy)). 의자에서 책상 쪽, 곧 deskSeatOf 의
 *  앞뒤 축(dz)의 반대다. 처음부터 책상에 앉힐 때 쓴다 — 걸어와 앉으면 마지막 걸음 방향을 본다 */
export const deskSeatFacing = (item: FurnitureItem): number => {
  const h = item.h ?? 55;
  const dz = item.fit ? h / 2 + 16 : -5 - h / 2;
  const r = ((item.facing ?? 0) * Math.PI) / 180;
  const s = Math.sign(dz);
  return Math.atan2(-s * Math.sin(r), -s * Math.cos(r));
};

export const getDeskLocations = (items: FurnitureItem[]) =>
  items
    .filter((item) => item.type === "desk_cubicle")
    .map((item) => ({ ...deskSeatOf(item), facing: deskSeatFacing(item) }));

/** AAS: 회의실 경계를 받는다(계획 2026-10-13-001 R4). 원본은 장면 좌표 x 0~290·y 0~235 의 의자로 고정이었다 —
 *  회의실을 옮기면 빈 곳으로 모이고, 회의가 여럿이면 모두 같은 탁자로 모였다. 경계를 주지 않으면 원본과 같다. */
export const getMeetingSeatLocations = (
  items: FurnitureItem[],
  bounds: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: 290, h: 235 },
) => {
  // Meeting seats are inferred from chair placement in the conference area so standup
  // gathering follows the authored layout instead of a hardcoded attendee list.
  const chairs = items
    .filter(
      (item) =>
        item.type === "chair" &&
        item.x >= bounds.x &&
        item.x <= bounds.x + bounds.w &&
        item.y >= bounds.y &&
        item.y <= bounds.y + bounds.h,
    )
    .sort((left, right) => left.y - right.y || left.x - right.x);
  if (chairs.length === 0) return [];

  const chairCenters = chairs.map((item) => ({
    item,
    x: item.x + ITEM_FOOTPRINT.chair[0] / 2,
    y: item.y + ITEM_FOOTPRINT.chair[1] / 2,
  }));
  const centerX =
    chairCenters.reduce((sum, chair) => sum + chair.x, 0) / chairCenters.length;
  const centerY =
    chairCenters.reduce((sum, chair) => sum + chair.y, 0) / chairCenters.length;

  return chairCenters.map((chair) => {
    // AAS(2026-10-26-009): 방향이 정해진 의자는 의자 가운데에 앉고 의자 정면을 본다(책상 자리 deskSeatOf 와 같다). 의자 정면은
    // turn() 과 같이 (sin f, cos f) 라 보는 방향 atan2(dx, dy) 가 곧 f 다. 원본(아래)은 「모든 의자의 가운데」 반대쪽으로 14 당긴 점·그 가운데를
    // 보는 방향이라, 10석 탁자 끝 의자에서는 의자 옆 12 에 비스듬히 앉아 의자 밖이나 탁자 가장자리에 들린 채로 보였다(사용자 보고 2026-10-26)
    if (typeof chair.item.facing === "number") {
      return { x: chair.x, y: chair.y, facing: (chair.item.facing * Math.PI) / 180 };
    }
    const offsetX = chair.x - centerX;
    const offsetY = chair.y - centerY;
    const distance = Math.hypot(offsetX, offsetY) || 1;
    const seatPullback = 14;
    return {
      x: chair.x + (offsetX / distance) * seatPullback,
      y: chair.y + (offsetY / distance) * seatPullback,
      facing: Math.atan2(centerX - chair.x, centerY - chair.y),
    };
  });
};

export const getGymWorkoutLocations = (
  items: FurnitureItem[],
): GymWorkoutLocation[] =>
  items
    .filter((item) =>
      [
        "treadmill",
        "weight_bench",
        "dumbbell_rack",
        "exercise_bike",
        "punching_bag",
        "rowing_machine",
        "kettlebell_rack",
        "yoga_mat",
      ].includes(item.type),
    )
    .sort((left, right) => left.y - right.y || left.x - right.x)
    .map((item) => {
      // Each workout target is an agent standing point plus a facing direction toward equipment.
      const bounds = getItemBounds(item);
      const equipmentCenterX = bounds.x + bounds.w / 2;
      const equipmentCenterY = bounds.y + bounds.h / 2;
      const facingTowardEquipment = (targetX: number, targetY: number) =>
        Math.atan2(equipmentCenterX - targetX, equipmentCenterY - targetY);
      if (item.type === "treadmill") {
        const x = item.x + 35;
        const y = item.y + 65;
        return {
          x,
          y,
          facing: facingTowardEquipment(x, y),
          workoutStyle: "run",
        };
      }
      if (item.type === "weight_bench") {
        const x = item.x + 38;
        const y = item.y + 20;
        return {
          x,
          y,
          facing: facingTowardEquipment(x, y),
          workoutStyle: "lift",
        };
      }
      if (item.type === "dumbbell_rack" || item.type === "kettlebell_rack") {
        const x = item.x - 18;
        const y = item.y + 14;
        return {
          x,
          y,
          facing: facingTowardEquipment(x, y),
          workoutStyle: "lift",
        };
      }
      if (item.type === "exercise_bike") {
        const x = item.x + 18;
        const y = item.y + 28;
        return {
          x,
          y,
          facing: facingTowardEquipment(x, y),
          workoutStyle: "bike",
        };
      }
      if (item.type === "rowing_machine") {
        const x = item.x + 28;
        const y = item.y + 16;
        return {
          x,
          y,
          facing: facingTowardEquipment(x, y),
          workoutStyle: "row",
        };
      }
      if (item.type === "yoga_mat") {
        const x = item.x + 35;
        const y = item.y + 15;
        return {
          x,
          y,
          facing: facingTowardEquipment(x, y),
          workoutStyle: "stretch",
        };
      }
      const x = item.x - 18;
      const y = item.y + 14;
      return {
        x,
        y,
        facing: facingTowardEquipment(x, y),
        workoutStyle: "box",
      };
    });

export const getQaLabStations = (
  items: FurnitureItem[],
): QaLabStationLocation[] =>
  items
    .filter((item) =>
      ["qa_terminal", "device_rack", "test_bench"].includes(item.type),
    )
    .sort((left, right) => left.y - right.y || left.x - right.x)
    .map((item) => {
      // QA stations follow the same pattern as gym targets: derive a nearby standing point
      // from authored furniture so scene motion stays data-driven.
      const bounds = getItemBounds(item);
      const stationCenterX = bounds.x + bounds.w / 2;
      const stationCenterY = bounds.y + bounds.h / 2;
      const facingTowardStation = (targetX: number, targetY: number) =>
        Math.atan2(stationCenterX - targetX, stationCenterY - targetY);

      if (item.type === "qa_terminal") {
        const x = item.x + 26;
        const y = item.y + 56;
        return {
          x,
          y,
          facing: facingTowardStation(x, y),
          stationType: "console" as const,
        };
      }
      if (item.type === "device_rack") {
        const x = item.x - 18;
        const y = item.y + 18;
        return {
          x,
          y,
          facing: facingTowardStation(x, y),
          stationType: "device_rack" as const,
        };
      }
      const x = item.x + 45;
      const y = item.y + 58;
      return {
        x,
        y,
        facing: facingTowardStation(x, y),
        stationType: "bench" as const,
      };
    });

export const MEETING_OVERFLOW_LOCATIONS = [
  { x: 18, y: 118, facing: Math.PI / 2 },
  { x: 270, y: 118, facing: -Math.PI / 2 },
  { x: 145, y: 24, facing: Math.PI },
  { x: 145, y: 220, facing: 0 },
];

export const resolveDeskIndexForItem = (
  item: FurnitureItem,
  deskLocations: { x: number; y: number }[],
): number => {
  if (deskLocations.length === 0) return -1;
  if (item.type === "desk_cubicle") {
    const seat = deskSeatOf(item);
    return deskLocations.findIndex((desk) => desk.x === seat.x && desk.y === seat.y);
  }

  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < deskLocations.length; index += 1) {
    const desk = deskLocations[index];
    if (!desk) continue;
    const distance = Math.hypot(item.x - desk.x, item.y - desk.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  return bestDistance <= 80 ? bestIndex : -1;
};
