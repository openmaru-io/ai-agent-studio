import type { AgentAvatarProfile } from "@/features/office/scene3d/lib/avatars/profile";
import type { OfficeInteractionTargetId } from "@/features/office/scene3d/lib/office/places";
import type { RestSeat } from "@/features/office/scene3d/retro-office/core/idleRest";

export type OfficeAgent = {
  id: string;
  name: string;
  subtitle?: string | null;
  status: "working" | "idle" | "error";
  color: string;
  item: string;
  avatarProfile?: AgentAvatarProfile | null;
  /** AAS: 얼굴(avatars/face.ts, DiceBear Pixel Art)의 data: URL. 있으면 아바타 머리 앞면에 붙인다(계획 007 R3). */
  faceUrl?: string | null;
  /** AAS(스펙 2026-10-21-012): 보는 사람의 에이전트. 발밑 고리와 반대 테마 색 이름표로 그린다. */
  mine?: boolean;
};

export type JanitorTool = "broom" | "vacuum" | "floor_scrubber";

export type JanitorActor = {
  id: string;
  name: string;
  role: "janitor";
  status: "working";
  color: string;
  item: "cleaning";
  janitorTool: JanitorTool;
  janitorRoute: FacingPoint[];
  janitorPauseMs: number;
  janitorDespawnAt: number;
};

export type SceneActor = OfficeAgent | JanitorActor;

export type RenderAgent = SceneActor & {
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  path: { x: number; y: number }[];
  facing: number;
  frame: number;
  walkSpeed: number;
  phaseOffset: number;
  state: "walking" | "sitting" | "standing" | "away" | "working_out" | "dancing";
  awayUntil?: number;
  separationReplanAt?: number;
  bumpedUntil?: number;
  /** AAS(스펙 2026-10-21-021): 마주친 짝과 주고받는 인사. greetFrom ≤ 지금 < greetUntil 동안 보인다(답은 0.7초 늦게). 전에는 bumpTalkUntil 동안 「...」였다 */
  greetText?: string;
  greetFrom?: number;
  greetUntil?: number;
  collisionCooldownUntil?: number;
  pingPongUntil?: number;
  pingPongTargetX?: number;
  pingPongTargetY?: number;
  pingPongFacing?: number;
  pingPongPartnerId?: string;
  pingPongTableUid?: string;
  pingPongSide?: 0 | 1;
  pingPongPreviousWalkSpeed?: number;
  interactionTarget?: OfficeInteractionTargetId;
  smsBoothStage?: "door_outer" | "door_inner" | "typing";
  phoneBoothStage?: "door_outer" | "door_inner" | "receiver";
  serverRoomStage?: "door_outer" | "door_inner" | "terminal";
  gymStage?: "door_outer" | "door_inner" | "workout";
  qaLabStage?: "door_outer" | "door_inner" | "station";
  qaLabStationType?: QaLabStationType;
  workoutStyle?: "run" | "lift" | "bike" | "box" | "row" | "stretch";
  janitorRouteIndex?: number;
  janitorPauseUntil?: number;
  /** AAS(스펙 2026-10-21-023): 대기 에이전트가 자기 책상에 앉아 머무는 마지막 시각(core/idleDesk.ts) */
  idleSeatUntil?: number;
  /** AAS(스펙 2026-10-21-023): 대기 에이전트가 책상에서 막 일어나 서 있다. 다음 걸음 전까지 다시 앉지 않는다 */
  idleStoodUp?: boolean;
  /** AAS(스펙 2026-10-26-012): 자리 비움(30분 넘게 대기)으로 자기 책상·쉬는 자리에 앉아 있다. 반투명하게 그린다(objects/agents.tsx) */
  away?: boolean;
  /** AAS(스펙 2026-10-26-009): 회의 자리에 앉을 때 볼 방향(회의 자리의 facing). 이동 틱은 걷는 동안 facing 을 걸음 방향으로 바꾼다 */
  seatFacing?: number;
  /** AAS(스펙 2026-10-26-004): 대기 에이전트가 쉬러 가거나 앉아 있는 소파·탕비실 자리(core/idleRest.ts) */
  restSeat?: RestSeat;
};

export type FurnitureItem = {
  _uid: string;
  type: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  r?: number;
  color?: string;
  id?: string;
  facing?: number;
  vertical?: boolean;
  elevation?: number;
  /** AAS: 한국 사무실 배치(계획 2026-10-13-001). 책상·팀 회의실의 구역 번호(팀 구역). */
  zone?: number;
  /** AAS: 방 표시(type "room")의 종류 — 대회의실·팀 회의실·TFT 회의실. */
  kind?: "meeting" | "team" | "tft";
  /** AAS: 방 표시의 기본 이름(문 위에 보인다). */
  label?: string;
  /** AAS: 팀장석 — 에이전트에게 배정하지 않고 사람이 앉는다. */
  lead?: boolean;
  /** AAS: 모델을 자리 상자(w×h)에 맞춰 늘려 그린다. 원본은 고정 배율이라 책상 모델(약 61×33)이 상자(100×55) 북쪽 밖에
   *  그려지고, 탁자는 w·h 를 바꿔도 크기가 같았다. 켜면 그림과 길 막기·앉는 자리가 같은 상자를 쓴다. */
  fit?: boolean;
  /** AAS: 유리문(회의실 문). 틀은 금속, 문짝은 반투명 유리로 그린다. */
  glass?: boolean;
  /** AAS: 칸반 보드를 벽에 거는 판으로 그린다(원본 모델은 ㄴ자 책상이라 탁자로 보였다, 2026-10-13). */
  wall?: boolean;
};

export type FurnitureSeed = Omit<FurnitureItem, "_uid">;

export type CanvasPoint = {
  x: number;
  y: number;
};

export type FacingPoint = CanvasPoint & {
  facing: number;
};

export type QaLabStationType = "console" | "device_rack" | "bench";

export type GymWorkoutLocation = FacingPoint & {
  workoutStyle: "run" | "lift" | "bike" | "box" | "row" | "stretch";
};

export type QaLabStationLocation = FacingPoint & {
  stationType: QaLabStationType;
};

export type ServerRoomRoute = {
  stage: "door_outer" | "door_inner" | "terminal";
  targetX: number;
  targetY: number;
  facing: number;
};

export type QaLabRoute = {
  stage: "door_outer" | "door_inner" | "station";
  targetX: number;
  targetY: number;
  facing: number;
};

export type GymRoute = {
  stage: "door_outer" | "door_inner" | "workout";
  targetX: number;
  targetY: number;
  facing: number;
};

export type PhoneBoothRoute = {
  stage: "door_outer" | "door_inner" | "receiver";
  targetX: number;
  targetY: number;
  facing: number;
};

export type SmsBoothRoute = {
  stage: "door_outer" | "door_inner" | "typing";
  targetX: number;
  targetY: number;
  facing: number;
};
