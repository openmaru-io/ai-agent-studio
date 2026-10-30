"use client";

import {
  Pencil,
  Check,
  Map as MapIcon,
  Maximize,
  Monitor,
  Armchair,
  Settings2,
  Camera,
  UserPlus,
  Trash2,
  Users,
  X,
} from "lucide-react";
import {
  type ComponentProps,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
export type PhoneCallStep = string;
export type TextMessageStep = string;
type OfficeUsageAnalyticsParams = Record<string, unknown>;
import type { AgentState } from "@/features/office/scene3d/shims";
import type { CronJobSummary } from "@/features/office/scene3d/shims";
import { buildMockPhoneCallScenario } from "@/features/office/scene3d/lib/office/call/mock";
import type { MockPhoneCallScenario } from "@/features/office/scene3d/lib/office/call/types";
import { buildMockTextMessageScenario } from "@/features/office/scene3d/lib/office/text/mock";
import type { MockTextMessageScenario } from "@/features/office/scene3d/lib/office/text/types";
import type { OfficeDeskMonitor } from "@/features/office/scene3d/lib/office/deskMonitor";
import type { OfficeAnimationState } from "@/features/office/scene3d/lib/office/animation";
import type { StandupMeeting } from "@/features/office/scene3d/lib/office/standup/types";
import type { SkillStatusEntry } from "@/features/office/scene3d/shims";
import type { StudioGatewayAdapterType } from "@/features/office/scene3d/shims";
import type {
  TaskBoardCard,
  TaskBoardStatus,
} from "@/features/office/scene3d/shims";
import { extractSpeechImage } from "@/features/office/scene3d/shims";
import {
  AGENT_RADIUS,
  BUMP_FREEZE_MS,
  BUMP_RECOVERY_MS,
  CANVAS_H,
  CANVAS_W,
  DESK_STICKY_MS,
  DOOR_LENGTH,
  DOOR_THICKNESS,
  ELEVATION_STEP,
  PING_PONG_APPROACH_SPEED,
  PING_PONG_SESSION_MS,
  ROTATION_STEP_DEG,
  SCALE,
  SEPARATION_STRENGTH,
  SNAP_GRID,
  WALK_SPEED,
  WALL_THICKNESS,
  WORKING_WALK_SPEED_MULTIPLIER,
} from "@/features/office/scene3d/retro-office/core/constants";
import {
  ensureOfficeAtm,
  ensureOfficeKanbanBoard,
  ensureOfficePhoneBooth,
  ensureOfficePingPongTable,
  ensureOfficeQaLab,
  ensureOfficeSmsBooth,
  ensureOfficeJukebox,
  ensureOfficeServerRoom,
  isRetiredPingPongLamp,
  materializeDefaults,
  type OfficeLayoutPreset,
} from "@/features/office/scene3d/retro-office/core/furnitureDefaults";
import {
  clampPointToZone,
  DISTRICT_CAMERA_POSITION,
  DISTRICT_CAMERA_TARGET,
  DISTRICT_CAMERA_ZOOM,
  LOCAL_OFFICE_CANVAS_HEIGHT,
  isRemoteOfficeAgentId,
  LOCAL_OFFICE_CANVAS_WIDTH,
  projectFurnitureIntoRemoteOfficeZone,
  REMOTE_OFFICE_ZONE,
  REMOTE_ROAM_POINTS,
} from "@/features/office/scene3d/retro-office/core/district";
import { arrivedState, SEAT_REACH } from "@/features/office/scene3d/retro-office/core/seatArrival";
import { idleAtDesk, idleNextTrip, idleSeatDeadline, idleSpawnDeadline } from "@/features/office/scene3d/retro-office/core/idleDesk";
import { awayStep } from "@/features/office/scene3d/retro-office/core/idleAway";
import { occupiedPoint, pickRestSeat, REST_SEAT_NEAR, restSeatsOf } from "@/features/office/scene3d/retro-office/core/idleRest";
import { planRoute } from "@/features/office/scene3d/retro-office/core/personPath";
import { AGENT_FOCUS_ZOOM, type CameraNudge, focusPreset, MAX_ZOOM, MIN_ZOOM, nudgePreset, OVERVIEW_ZOOM, recentClickUid, ROOM_FOCUS_ZOOM } from "@/features/office/scene3d/retro-office/core/cameraFocus";
import { HIGHLIGHT_MS } from "@/features/office/scene3d/retro-office/core/selectHighlight";
import {
  AAS_WITHOUT_IMMERSIVE_SCREENS,
  aasDeviceOf,
  type AasDevice,
  isOverlayOnlyType,
} from "@/features/office/scene3d/retro-office/core/overlayOnly";
import {
  buildJanitorActorsForCue,
  pruneExpiredJanitorActors,
} from "@/features/office/scene3d/retro-office/core/janitors";
import {
  createWallItem,
  getItemBaseSize,
  getItemRotationRadians,
  nextUid,
  normalizeDegrees,
  resolveItemTypeKey,
  snap,
  toWorld,
} from "@/features/office/scene3d/retro-office/core/geometry";
import {
  astar,
  buildNavGrid,
  getDeskLocations,
  getGymWorkoutLocations,
  getJanitorCleaningStops,
  getMeetingSeatLocations,
  getQaLabStations,
  GYM_DEFAULT_TARGET,
  isNavFree,
  MEETING_OVERFLOW_LOCATIONS,
  QA_LAB_DEFAULT_TARGET,
  resolveDeskIndexForItem,
  resolveGymRoute,
  resolvePhoneBoothRoute,
  resolvePingPongTargets,
  resolveQaLabRoute,
  resolveSmsBoothRoute,
  resolveServerRoomRoute,
  ROAM_POINTS,
  SERVER_ROOM_TARGET,
  socialTargetsOf,
} from "@/features/office/scene3d/retro-office/core/navigation";
import {
  loadFurniture,
  markAtmMigrationApplied,
  markGymRoomMigrationApplied,
  markPhoneBoothMigrationApplied,
  markQaLabMigrationApplied,
  markSmsBoothMigrationApplied,
  markServerRoomMigrationApplied,
  saveFurniture,
} from "@/features/office/scene3d/retro-office/core/persistence";
import type {
  FurnitureItem,
  JanitorActor,
  OfficeAgent,
  QaLabStationLocation,
  RenderAgent,
  SceneActor,
} from "@/features/office/scene3d/retro-office/core/types";
import type { NavGrid } from "@/features/office/scene3d/retro-office/core/navigation";
import type { OfficeLayoutSnapshot } from "@/features/office/scene3d/lib/office/layoutSnapshot";
import { AgentModel as AgentObjectModel } from "@/features/office/scene3d/retro-office/objects/agents";
import { AasPeopleLayer, type AasScenePerson } from "@/features/office/scene3d/retro-office/objects/aasPeople";
import { DepartmentBanner } from "@/features/office/scene3d/retro-office/objects/DepartmentBanner";
import { type Banner, BANNER_MIN_CANVAS_W, fitOverview, screenAxes } from "@/features/office/banner";
import { AasRoomLabels } from "@/features/office/scene3d/retro-office/objects/aasRoomLabels";
import { buildAasKoreanOffice } from "@/features/office/scene3d/retro-office/core/aasKoreanOffice";
import type { PersonPos } from "@/features/office/people";
import { JukeboxModel as InteractiveJukeboxModel } from "@/features/office/scene3d/retro-office/objects/Jukebox";
import {
  FurnitureModel as GenericFurnitureModel,
  InstancedFurnitureItems as InstancedFurnitureItemsModel,
  PlacementGhost as FurniturePlacementGhost,
} from "@/features/office/scene3d/retro-office/objects/furniture";
import {
  DishwasherModel as KitchenDishwasherModel,
  MicrowaveModel as KitchenMicrowaveModel,
  SinkModel as KitchenSinkModel,
  StoveModel as KitchenStoveModel,
  VendingMachineModel as KitchenVendingMachineModel,
  WallCabinetModel as KitchenWallCabinetModel,
} from "@/features/office/scene3d/retro-office/objects/kitchen";
import {
  AtmMachineModel as InteractiveAtmMachineModel,
  DeviceRackModel as InteractiveDeviceRackModel,
  DumbbellRackModel as InteractiveDumbbellRackModel,
  ExerciseBikeModel as InteractiveExerciseBikeModel,
  KettlebellRackModel as InteractiveKettlebellRackModel,
  PingPongTableModel as MachinePingPongTableModel,
  PhoneBoothModel as InteractivePhoneBoothModel,
  PunchingBagModel as InteractivePunchingBagModel,
  QaTerminalModel as InteractiveQaTerminalModel,
  RowingMachineModel as InteractiveRowingMachineModel,
  ServerRackModel as InteractiveServerRackModel,
  ServerTerminalModel as InteractiveServerTerminalModel,
  SmsBoothModel as InteractiveSmsBoothModel,
  TestBenchModel as InteractiveTestBenchModel,
  TreadmillModel as InteractiveTreadmillModel,
  WeightBenchModel as InteractiveWeightBenchModel,
  YogaMatModel as InteractiveYogaMatModel,
} from "@/features/office/scene3d/retro-office/objects/machines";
import {
  ClockModel as PrimitiveClockModel,
  DoorModel as PrimitiveDoorModel,
  ItemSelectionOutlines as PrimitiveItemSelectionOutlines,
  InstancedWallSegmentsModel as PrimitiveInstancedWallSegmentsModel,
  KeyboardModel as PrimitiveKeyboardModel,
  MouseModel as PrimitiveMouseModel,
  MugModel as PrimitiveMugModel,
  RoundTableModel as PrimitiveRoundTableModel,
  TrashCanModel as PrimitiveTrashCanModel,
  WallSegmentModel as PrimitiveWallSegmentModel,
} from "@/features/office/scene3d/retro-office/objects/primitives";
import {
  FloorAndWalls as SceneFloorAndWalls,
  WallPictures as SceneWallPictures,
} from "@/features/office/scene3d/retro-office/scene/environment";
import {
  CAMERA_PRESETS as CAMERA_PRESET_MAP,
  CameraAnimator as CameraPresetAnimator,
  FollowCamController as FollowCamSystem,
} from "@/features/office/scene3d/retro-office/systems/cameraLighting";
import {
  FloorRaycaster as SceneFloorRaycaster,
  GameLoop as SceneGameLoop,
  PingPongBall as ScenePingPongBall,
  SpotlightEffect as SceneSpotlightEffect,
} from "@/features/office/scene3d/retro-office/systems/sceneRuntime";
import { applyAgentCollisionBumps, createGreetMemory } from "@/features/office/scene3d/retro-office/systems/NavigationSystem";
import type { GreetingLines } from "@/features/office/greetings";
import {
  HeatmapSystem as AgentHeatmapSystem,
  TrailSystem as AgentTrailSystem,
} from "@/features/office/scene3d/retro-office/systems/visualSystems";
import type { OfficeCleaningCue } from "@/features/office/scene3d/lib/office/janitorReset";
import { ScenePaletteContext, scenePaletteValue, useScenePalette } from "@/features/office/scenePaletteContext";
import { SCENE_PALETTE } from "@/features/office/tokens";

type OfficeDeskMonitorMap = Record<string, OfficeDeskMonitor>;
type RenderAgentUiSnapshot = Pick<RenderAgent, "state" | "status">;
type FeedEvent = {
  id: string;
  name: string;
  text: string;
  ts: number;
  kind?: "status" | "reply";
};

const EMPTY_STRING_RECORD: Record<string, string> = {};
const EMPTY_BOOLEAN_RECORD: Record<string, boolean> = {};
const EMPTY_NUMBER_RECORD: Record<string, number> = {};
const EMPTY_MONITOR_MAP: OfficeDeskMonitorMap = {};
const EMPTY_CLEANING_CUES: OfficeCleaningCue[] = [];
const EMPTY_FEED_EVENTS: FeedEvent[] = [];

// AAS: 한국 사무실 배치(계획 2026-10-13-001). 벽처럼 상자로 그리는 종류와, 그리지 않는 종류(방 표시·경계).
const AAS_WALL_LIKE = new Set(["wall", "partition", "glass_wall"]);
const EMPTY_AAS_MEETING_SEATS: Record<string, { x: number; y: number; facing: number }> = {};
const AAS_HIDDEN_TYPES = new Set(["room", "boundary"]);
// 책상 섬 칸막이 높이: 모니터 윗끝(약 0.93)보다 조금 높게(kr-6). 0.45 이면 모니터가 칸막이 위로 나왔다
const AAS_PARTITION_HEIGHT = 1.0;

// AAS: 관리자 배치 편집(계획 007 P7). 편집 패널은 바깥(MUI)에 두고 장면은 명령만 받는다.
export type AasEditorApi = {
  palette: { type: string; label: string }[];
  place: (type: string) => void;
  rotate: (deg: number) => void;
  raise: (delta: number) => void;
  remove: () => void;
  deselect: () => void;
  items: () => FurnitureItem[];
};
export type AasEditorState = { selected: FurnitureItem | null; dirty: boolean; placing: string | null };

type DragState =
  | { kind: "idle" }
  | { kind: "moving"; uid: string }
  | { kind: "placing"; itemType: string };

const SMS_CONTACT_SEED_NAMES = [
  "Avery",
  "Maya",
  "Theo",
  "Lena",
  "Miles",
  "Nina",
  "Owen",
  "Priya",
  "Marco",
  "Sofia",
  "Daniel",
  "Chloe",
  "Gabriel",
  "Zoe",
] as const;

const normalizeSmsContactName = (value: string): string =>
  value.replace(/\s+/g, " ").trim() || "Joseph";

const buildSmsContactList = (
  recipient: string,
): { contacts: string[]; targetIndex: number } => {
  const normalizedRecipient = normalizeSmsContactName(recipient);
  const availableNames = SMS_CONTACT_SEED_NAMES.filter(
    (name) => name.toLowerCase() !== normalizedRecipient.toLowerCase(),
  );
  const recipientHash = [...normalizedRecipient].reduce(
    (total, character) => total + character.charCodeAt(0),
    0,
  );
  const beforeCount = 2 + (recipientHash % 3);
  const afterCount = 4;
  const contacts = [
    ...availableNames.slice(0, beforeCount),
    normalizedRecipient,
    ...availableNames.slice(beforeCount, beforeCount + afterCount),
  ];

  return {
    contacts,
    targetIndex: beforeCount,
  };
};

type PaletteEntry = {
  type: string;
  label: string;
  icon: string;
  defaults: Partial<FurnitureItem>;
};

// ============================================================
// LAYOUT DATA
// ============================================================

const PALETTE: PaletteEntry[] = [
  {
    type: "wall",
    label: "Wall",
    icon: "🧱",
    defaults: { w: 80, h: WALL_THICKNESS },
  },
  {
    type: "door",
    label: "Door",
    icon: "🚪",
    defaults: { w: DOOR_LENGTH, h: DOOR_THICKNESS, facing: 0 },
  },
  {
    type: "desk_cubicle",
    label: "Desk",
    icon: "🖥️",
    defaults: { w: 100, h: 55 },
  },
  { type: "chair", label: "Chair", icon: "🪑", defaults: { facing: 0 } },
  {
    type: "round_table",
    label: "Round Table",
    icon: "⭕",
    defaults: { r: 60 },
  },
  {
    type: "executive_desk",
    label: "Exec Desk",
    icon: "📋",
    defaults: { w: 130, h: 65 },
  },
  { type: "couch", label: "Couch", icon: "🛋️", defaults: { w: 100, h: 40 } },
  {
    type: "couch_v",
    label: "Couch (V)",
    icon: "🛋️",
    defaults: { w: 40, h: 80, vertical: true },
  },
  {
    type: "bookshelf",
    label: "Bookshelf",
    icon: "📚",
    defaults: { w: 80, h: 120 },
  },
  { type: "plant", label: "Plant", icon: "🪴", defaults: {} },
  { type: "plant_cactus", label: "Cactus", icon: "🌵", defaults: { w: 22, h: 20, fit: true } },
  { type: "plant_cactus_short", label: "Small cactus", icon: "🌵", defaults: { w: 24, h: 20, fit: true } },
  { type: "plant_palm", label: "Palm", icon: "🌴", defaults: { w: 44, h: 44, fit: true } },
  { type: "plant_tree", label: "Tree", icon: "🌲", defaults: { w: 20, h: 24, fit: true } },
  {
    type: "beanbag",
    label: "Beanbag",
    icon: "🟠",
    defaults: { color: "#e65100" },
  },
  {
    type: "pingpong",
    label: "Ping Pong",
    icon: "🏓",
    defaults: { w: 100, h: 60 },
  },
  {
    type: "table_rect",
    label: "Table",
    icon: "🟫",
    defaults: { w: 80, h: 40 },
  },
  { type: "coffee_machine", label: "Coffee", icon: "☕", defaults: {} },
  { type: "fridge", label: "Fridge", icon: "🧊", defaults: { w: 40, h: 80 } },
  { type: "water_cooler", label: "Water", icon: "💧", defaults: {} },
  { type: "atm", label: "ATM", icon: "🏧", defaults: { facing: 270 } },
  { type: "jukebox", label: "Jukebox", icon: "🎵", defaults: { facing: 0 } },
  {
    type: "kanban_board",
    label: "Kanban Board",
    icon: "📌",
    defaults: { w: 130, h: 65, facing: 90 },
  },
  {
    type: "whiteboard",
    label: "Whiteboard",
    icon: "📝",
    defaults: { w: 10, h: 60 },
  },
  {
    type: "cabinet",
    label: "Cabinet",
    icon: "🗄️",
    defaults: { w: 200, h: 40 },
  },
  {
    type: "dishwasher",
    label: "Dishwasher",
    icon: "🧼",
    defaults: { w: 40, h: 40 },
  },
  {
    type: "stove",
    label: "Stove",
    icon: "🍳",
    defaults: { w: 40, h: 40 },
  },
  {
    type: "microwave",
    label: "Microwave",
    icon: "⏲️",
    defaults: { w: 30, h: 20 },
  },
  {
    type: "wall_cabinet",
    label: "Wall Cabinet",
    icon: "🗄️",
    defaults: { w: 80, h: 20, elevation: 0.9 },
  },
  { type: "computer", label: "Computer", icon: "🖥️", defaults: {} },
  { type: "lamp", label: "Lamp", icon: "💡", defaults: {} },
];

// ============================================================
// CAMERA SETUP — sets lookAt after mount
// ============================================================

function CameraRig({ target }: { target: [number, number, number] }) {
  const { camera } = useThree();
  useEffect(() => {
    camera.lookAt(...target);
    camera.updateProjectionMatrix();
  }, [camera, target]);
  return null;
}

const NOOP_FURNITURE_UID_HANDLER = () => {};
const NOOP_FURNITURE_HANDLER = () => {};
const EMPTY_FURNITURE_ITEMS: FurnitureItem[] = [];

const ReadOnlyFurnitureClone = memo(function ReadOnlyFurnitureClone({
  furniture,
}: {
  furniture: FurnitureItem[];
}) {
  const deskItems = useMemo(
    () => furniture.filter((item) => item.type === "desk_cubicle"),
    [furniture],
  );
  const chairItems = useMemo(
    () => furniture.filter((item) => item.type === "chair"),
    [furniture],
  );
  const wallItems = useMemo(
    () => furniture.filter((item) => item.type === "wall"),
    [furniture],
  );
  const partitionItems = useMemo(() => furniture.filter((item) => item.type === "partition"), [furniture]);
  const glassItems = useMemo(() => furniture.filter((item) => item.type === "glass_wall"), [furniture]);
  const { palette } = useScenePalette();

  return (
    <Suspense fallback={null}>
      <PrimitiveInstancedWallSegmentsModel items={wallItems} />
      <PrimitiveInstancedWallSegmentsModel items={partitionItems} height={AAS_PARTITION_HEIGHT} color={palette.partition} />
      <PrimitiveInstancedWallSegmentsModel items={glassItems} color={palette.glass.color} opacity={palette.glass.opacity} />
      <InstancedFurnitureItemsModel itemType="desk_cubicle" items={deskItems} />
      <InstancedFurnitureItemsModel itemType="chair" items={chairItems} />
      {furniture.map((item) =>
        AAS_WALL_LIKE.has(item.type) ||
        AAS_HIDDEN_TYPES.has(item.type) ||
        item.type === "desk_cubicle" ||
        item.type === "chair" ? null : item.type === "door" ? (
          <PrimitiveDoorModel
            key={item._uid}
            item={item}
            isSelected={false}
            isHovered={false}
            editMode={false}
            onPointerDown={NOOP_FURNITURE_UID_HANDLER}
            onPointerOver={NOOP_FURNITURE_UID_HANDLER}
            onPointerOut={NOOP_FURNITURE_HANDLER}
          />
        ) : item.type === "round_table" ? (
          <PrimitiveRoundTableModel
            key={item._uid}
            item={item}
            isSelected={false}
            isHovered={false}
            editMode={false}
            onPointerDown={NOOP_FURNITURE_UID_HANDLER}
            onPointerOver={NOOP_FURNITURE_UID_HANDLER}
            onPointerOut={NOOP_FURNITURE_HANDLER}
          />
        ) : item.type === "keyboard" ? (
          <PrimitiveKeyboardModel
            key={item._uid}
            item={item}
            editMode={false}
            onPointerDown={NOOP_FURNITURE_UID_HANDLER}
            onPointerOver={NOOP_FURNITURE_UID_HANDLER}
            onPointerOut={NOOP_FURNITURE_HANDLER}
          />
        ) : item.type === "mouse" ? (
          <PrimitiveMouseModel
            key={item._uid}
            item={item}
            editMode={false}
            onPointerDown={NOOP_FURNITURE_UID_HANDLER}
            onPointerOver={NOOP_FURNITURE_UID_HANDLER}
            onPointerOut={NOOP_FURNITURE_HANDLER}
          />
        ) : item.type === "trash" ? (
          <PrimitiveTrashCanModel
            key={item._uid}
            item={item}
            editMode={false}
            onPointerDown={NOOP_FURNITURE_UID_HANDLER}
            onPointerOver={NOOP_FURNITURE_UID_HANDLER}
            onPointerOut={NOOP_FURNITURE_HANDLER}
          />
        ) : item.type === "mug" ? (
          <PrimitiveMugModel
            key={item._uid}
            item={item}
            editMode={false}
            onPointerDown={NOOP_FURNITURE_UID_HANDLER}
            onPointerOver={NOOP_FURNITURE_UID_HANDLER}
            onPointerOut={NOOP_FURNITURE_HANDLER}
          />
        ) : item.type === "clock" ? (
          <PrimitiveClockModel
            key={item._uid}
            item={item}
            editMode={false}
            onPointerDown={NOOP_FURNITURE_UID_HANDLER}
            onPointerOver={NOOP_FURNITURE_UID_HANDLER}
            onPointerOut={NOOP_FURNITURE_HANDLER}
          />
        ) : item.type === "atm" ? (
          <InteractiveAtmMachineModel
            key={item._uid}
            item={item}
            isSelected={false}
            isHovered={false}
            editMode={false}
            onPointerDown={NOOP_FURNITURE_UID_HANDLER}
            onPointerOver={NOOP_FURNITURE_UID_HANDLER}
            onPointerOut={NOOP_FURNITURE_HANDLER}
          />
        ) : item.type === "sms_booth" ? (
          <InteractiveSmsBoothModel
            key={item._uid}
            item={item}
            isSelected={false}
            isHovered={false}
            editMode={false}
            doorOpen={false}
            onPointerDown={NOOP_FURNITURE_UID_HANDLER}
            onPointerOver={NOOP_FURNITURE_UID_HANDLER}
            onPointerOut={NOOP_FURNITURE_HANDLER}
          />
        ) : item.type === "phone_booth" ? (
          <InteractivePhoneBoothModel
            key={item._uid}
            item={item}
            isSelected={false}
            isHovered={false}
            editMode={false}
            doorOpen={false}
            onPointerDown={NOOP_FURNITURE_UID_HANDLER}
            onPointerOver={NOOP_FURNITURE_UID_HANDLER}
            onPointerOut={NOOP_FURNITURE_HANDLER}
          />
        ) : item.type === "server_rack" ? (
          <InteractiveServerRackModel
            key={item._uid}
            item={item}
            isSelected={false}
            isHovered={false}
            editMode={false}
            onPointerDown={NOOP_FURNITURE_UID_HANDLER}
            onPointerOver={NOOP_FURNITURE_UID_HANDLER}
            onPointerOut={NOOP_FURNITURE_HANDLER}
          />
        ) : item.type === "server_terminal" ? (
          <InteractiveServerTerminalModel
            key={item._uid}
            item={item}
            isSelected={false}
            isHovered={false}
            editMode={false}
            onPointerDown={NOOP_FURNITURE_UID_HANDLER}
            onPointerOver={NOOP_FURNITURE_UID_HANDLER}
            onPointerOut={NOOP_FURNITURE_HANDLER}
          />
        ) : item.type === "vending" ? (
          <KitchenVendingMachineModel
            key={item._uid}
            item={item}
            editMode={false}
            onPointerDown={NOOP_FURNITURE_UID_HANDLER}
            onPointerOver={NOOP_FURNITURE_UID_HANDLER}
            onPointerOut={NOOP_FURNITURE_HANDLER}
          />
        ) : item.type === "sink" ? (
          <KitchenSinkModel
            key={item._uid}
            item={item}
            editMode={false}
            onPointerDown={NOOP_FURNITURE_UID_HANDLER}
            onPointerOver={NOOP_FURNITURE_UID_HANDLER}
            onPointerOut={NOOP_FURNITURE_HANDLER}
          />
        ) : item.type === "dishwasher" ? (
          <KitchenDishwasherModel
            key={item._uid}
            item={item}
            editMode={false}
            onPointerDown={NOOP_FURNITURE_UID_HANDLER}
            onPointerOver={NOOP_FURNITURE_UID_HANDLER}
            onPointerOut={NOOP_FURNITURE_HANDLER}
          />
        ) : item.type === "pingpong" ? (
          <MachinePingPongTableModel
            key={item._uid}
            item={item}
            isSelected={false}
            isHovered={false}
            editMode={false}
            onPointerDown={NOOP_FURNITURE_UID_HANDLER}
            onPointerOver={NOOP_FURNITURE_UID_HANDLER}
            onPointerOut={NOOP_FURNITURE_HANDLER}
          />
        ) : item.type === "qa_terminal" ? (
          <InteractiveQaTerminalModel
            key={item._uid}
            item={item}
            isSelected={false}
            isHovered={false}
            editMode={false}
            onPointerDown={NOOP_FURNITURE_UID_HANDLER}
            onPointerOver={NOOP_FURNITURE_UID_HANDLER}
            onPointerOut={NOOP_FURNITURE_HANDLER}
          />
        ) : item.type === "device_rack" ? (
          <InteractiveDeviceRackModel
            key={item._uid}
            item={item}
            isSelected={false}
            isHovered={false}
            editMode={false}
            onPointerDown={NOOP_FURNITURE_UID_HANDLER}
            onPointerOver={NOOP_FURNITURE_UID_HANDLER}
            onPointerOut={NOOP_FURNITURE_HANDLER}
          />
        ) : item.type === "test_bench" ? (
          <InteractiveTestBenchModel
            key={item._uid}
            item={item}
            isSelected={false}
            isHovered={false}
            editMode={false}
            onPointerDown={NOOP_FURNITURE_UID_HANDLER}
            onPointerOver={NOOP_FURNITURE_UID_HANDLER}
            onPointerOut={NOOP_FURNITURE_HANDLER}
          />
        ) : item.type === "treadmill" ? (
          <InteractiveTreadmillModel
            key={item._uid}
            item={item}
            isSelected={false}
            isHovered={false}
            editMode={false}
            onPointerDown={NOOP_FURNITURE_UID_HANDLER}
            onPointerOver={NOOP_FURNITURE_UID_HANDLER}
            onPointerOut={NOOP_FURNITURE_HANDLER}
          />
        ) : item.type === "weight_bench" ? (
          <InteractiveWeightBenchModel
            key={item._uid}
            item={item}
            isSelected={false}
            isHovered={false}
            editMode={false}
            onPointerDown={NOOP_FURNITURE_UID_HANDLER}
            onPointerOver={NOOP_FURNITURE_UID_HANDLER}
            onPointerOut={NOOP_FURNITURE_HANDLER}
          />
        ) : item.type === "dumbbell_rack" ? (
          <InteractiveDumbbellRackModel
            key={item._uid}
            item={item}
            isSelected={false}
            isHovered={false}
            editMode={false}
            onPointerDown={NOOP_FURNITURE_UID_HANDLER}
            onPointerOver={NOOP_FURNITURE_UID_HANDLER}
            onPointerOut={NOOP_FURNITURE_HANDLER}
          />
        ) : item.type === "exercise_bike" ? (
          <InteractiveExerciseBikeModel
            key={item._uid}
            item={item}
            isSelected={false}
            isHovered={false}
            editMode={false}
            onPointerDown={NOOP_FURNITURE_UID_HANDLER}
            onPointerOver={NOOP_FURNITURE_UID_HANDLER}
            onPointerOut={NOOP_FURNITURE_HANDLER}
          />
        ) : item.type === "rowing_machine" ? (
          <InteractiveRowingMachineModel
            key={item._uid}
            item={item}
            isSelected={false}
            isHovered={false}
            editMode={false}
            onPointerDown={NOOP_FURNITURE_UID_HANDLER}
            onPointerOver={NOOP_FURNITURE_UID_HANDLER}
            onPointerOut={NOOP_FURNITURE_HANDLER}
          />
        ) : item.type === "kettlebell_rack" ? (
          <InteractiveKettlebellRackModel
            key={item._uid}
            item={item}
            isSelected={false}
            isHovered={false}
            editMode={false}
            onPointerDown={NOOP_FURNITURE_UID_HANDLER}
            onPointerOver={NOOP_FURNITURE_UID_HANDLER}
            onPointerOut={NOOP_FURNITURE_HANDLER}
          />
        ) : item.type === "punching_bag" ? (
          <InteractivePunchingBagModel
            key={item._uid}
            item={item}
            isSelected={false}
            isHovered={false}
            editMode={false}
            onPointerDown={NOOP_FURNITURE_UID_HANDLER}
            onPointerOver={NOOP_FURNITURE_UID_HANDLER}
            onPointerOut={NOOP_FURNITURE_HANDLER}
          />
        ) : item.type === "yoga_mat" ? (
          <InteractiveYogaMatModel
            key={item._uid}
            item={item}
            isSelected={false}
            isHovered={false}
            editMode={false}
            onPointerDown={NOOP_FURNITURE_UID_HANDLER}
            onPointerOver={NOOP_FURNITURE_UID_HANDLER}
            onPointerOut={NOOP_FURNITURE_HANDLER}
          />
        ) : item.type === "stove" ? (
          <KitchenStoveModel
            key={item._uid}
            item={item}
            editMode={false}
            onPointerDown={NOOP_FURNITURE_UID_HANDLER}
            onPointerOver={NOOP_FURNITURE_UID_HANDLER}
            onPointerOut={NOOP_FURNITURE_HANDLER}
          />
        ) : item.type === "microwave" ? (
          <KitchenMicrowaveModel
            key={item._uid}
            item={item}
            editMode={false}
            onPointerDown={NOOP_FURNITURE_UID_HANDLER}
            onPointerOver={NOOP_FURNITURE_UID_HANDLER}
            onPointerOut={NOOP_FURNITURE_HANDLER}
          />
        ) : item.type === "wall_cabinet" ? (
          <KitchenWallCabinetModel
            key={item._uid}
            item={item}
            editMode={false}
            onPointerDown={NOOP_FURNITURE_UID_HANDLER}
            onPointerOver={NOOP_FURNITURE_UID_HANDLER}
            onPointerOut={NOOP_FURNITURE_HANDLER}
          />
        ) : (
          <GenericFurnitureModel
            key={item._uid}
            item={item}
            isSelected={false}
            isHovered={false}
            editMode={false}
            onPointerDown={NOOP_FURNITURE_UID_HANDLER}
            onPointerOver={NOOP_FURNITURE_UID_HANDLER}
            onPointerOut={NOOP_FURNITURE_HANDLER}
          />
        ),
      )}
    </Suspense>
  );
});

function AdaptiveDprController() {
  const { gl, setDpr } = useThree();
  const currentDprRef = useRef(1.25);
  const frameCounterRef = useRef(0);
  const avgDeltaRef = useRef(1 / 60);

  useEffect(() => {
    const initialDpr = Math.min(window.devicePixelRatio || 1, 1.5);
    currentDprRef.current = initialDpr;
    setDpr(initialDpr);
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        currentDprRef.current = 0.85;
        setDpr(0.85);
        return;
      }
      const restoredDpr = Math.min(window.devicePixelRatio || 1, 1.5);
      currentDprRef.current = restoredDpr;
      setDpr(restoredDpr);
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [setDpr]);

  useFrame((_, delta) => {
    if (document.visibilityState !== "visible") return;
    avgDeltaRef.current = avgDeltaRef.current * 0.92 + delta * 0.08;
    frameCounterRef.current += 1;
    if (frameCounterRef.current < 45) return;
    frameCounterRef.current = 0;

    const maxDpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const minDpr = 0.85;
    let nextDpr = currentDprRef.current;
    if (avgDeltaRef.current > 1 / 42) {
      nextDpr = Math.max(minDpr, currentDprRef.current - 0.1);
    } else if (avgDeltaRef.current < 1 / 57) {
      nextDpr = Math.min(maxDpr, currentDprRef.current + 0.05);
    }
    if (Math.abs(nextDpr - currentDprRef.current) < 0.025) return;
    currentDprRef.current = nextDpr;
    setDpr(Number(nextDpr.toFixed(2)));
    gl.info.reset();
  });

  return null;
}

// Asset model definitions live in `src/features/retro-office/objects`.

// ============================================================
// AGENT TICK HOOK — pure-ref, zero React re-renders per frame
// ============================================================

// `useAgentTick()` is the scene-side consumer of derived office state. Upstream modules decide
// which room an agent should prefer; this hook turns those holds plus authored furniture into
// concrete targets, paths, and per-frame actor motion.
function useAgentTick(
  agents: SceneActor[],
  deskLocations: { x: number; y: number; facing?: number }[],
  assignedDeskIndexByAgentId: Record<string, number> = {},
  gymWorkoutLocations: {
    x: number;
    y: number;
    facing: number;
    workoutStyle: "run" | "lift" | "bike" | "box" | "row" | "stretch";
  }[],
  qaLabStations: QaLabStationLocation[],
  meetingSeatLocations: { x: number; y: number; facing: number }[],
  furnitureRef: React.RefObject<FurnitureItem[]>,
  lastSeenByAgentId: Record<string, number> = {},
  deskHoldByAgentId: Record<string, boolean> = {},
  danceUntilByAgentId: Record<string, number> = {},
  gymHoldByAgentId: Record<string, boolean> = {},
  smsBoothHoldByAgentId: Record<string, boolean> = {},
  phoneBoothHoldByAgentId: Record<string, boolean> = {},
  qaHoldByAgentId: Record<string, boolean> = {},
  githubReviewByAgentId: Record<string, boolean> = {},
  standupMeeting: StandupMeeting | null = null,
  aasMeetingSeats: Record<string, { x: number; y: number; facing: number }> = EMPTY_AAS_MEETING_SEATS,
  aasGreetings: GreetingLines | undefined = undefined,
  // AAS(2026-10-26-004): 사람 아바타. 쉬러 갈 자리를 고를 때 사람이 앉은 자리를 뺀다
  aasPeopleRef: React.RefObject<RenderAgent[]> | undefined = undefined,
) {
  const renderAgentsRef = useRef<RenderAgent[]>([]);
  // AAS(2026-10-21-021): 누가 누구와 언제 인사했는지. 장면이 내려가면 함께 사라진다
  const greetMemoryRef = useRef(createGreetMemory());
  const renderAgentLookupRef = useRef<Map<string, RenderAgent>>(new Map());
  const deskByAgentRef = useRef<Map<string, number>>(new Map());
  const gymByAgentRef = useRef<Map<string, number>>(new Map());
  const qaByAgentRef = useRef<Map<string, number>>(new Map());
  const stickyUntilRef = useRef<Map<string, number>>(new Map());
  const nextGymRef = useRef(0);
  const nextQaRef = useRef(0);

  // Nav grid is rebuilt lazily whenever the furniture array reference changes.
  const navGridRef = useRef<NavGrid | null>(null);
  const gridSourceRef = useRef<FurnitureItem[]>([]);

  const getNavGrid = useCallback((): NavGrid => {
    const furniture = furnitureRef.current ?? [];
    if (navGridRef.current === null || gridSourceRef.current !== furniture) {
      navGridRef.current = buildNavGrid(furniture);
      gridSourceRef.current = furniture;
    }
    return navGridRef.current;
  }, [furnitureRef]);

  const planPath = useCallback(
    (fx: number, fy: number, tx: number, ty: number) =>
      astar(fx, fy, tx, ty, getNavGrid()),
    [getNavGrid],
  );
  const pickRoamPoint = useCallback((agentId: string) => {
    if (isRemoteOfficeAgentId(agentId)) {
      return REMOTE_ROAM_POINTS[
        Math.floor(Math.random() * REMOTE_ROAM_POINTS.length)
      ];
    }
    return ROAM_POINTS[Math.floor(Math.random() * ROAM_POINTS.length)];
  }, []);
  const pickSpawnPoint = useCallback((agentId: string) => {
    if (isRemoteOfficeAgentId(agentId)) {
      return REMOTE_ROAM_POINTS[
        Math.floor(Math.random() * REMOTE_ROAM_POINTS.length)
      ];
    }
    return {
      x: Math.random() * 800 + 100,
      y: Math.random() * 500 + 100,
    };
  }, []);

  const standupActive =
    standupMeeting?.phase === "gathering" ||
    standupMeeting?.phase === "in_progress";
  // AAS: 진행 중인 회의마다 짝지어진 회의실 자리(계획 2026-10-13-001 R4, O3). 원본 스탠드업은 회의 하나뿐이라,
  // 다른 회의의 참가자도 자기 회의실로 모이게 밖에서 자리를 넘긴다
  const meetingParticipants = useMemo(
    () =>
      new Set([
        ...(standupActive ? (standupMeeting?.participantOrder ?? []) : []),
        ...Object.keys(aasMeetingSeats),
      ]),
    [standupActive, standupMeeting?.participantOrder, aasMeetingSeats],
  );
  const resolveMeetingTarget = useCallback(
    (agentId: string) => {
      const aasSeat = aasMeetingSeats[agentId];
      if (aasSeat) return aasSeat;
      const participantOrder = standupMeeting?.participantOrder ?? [];
      const targetIndex = participantOrder.indexOf(agentId);
      const seats = [...meetingSeatLocations, ...MEETING_OVERFLOW_LOCATIONS];
      const fallbackSeat = seats[0] ?? { x: 145, y: 118, facing: Math.PI };
      if (targetIndex < 0) return fallbackSeat;
      return seats[targetIndex] ?? fallbackSeat;
    },
    [meetingSeatLocations, standupMeeting?.participantOrder, aasMeetingSeats],
  );

  useEffect(() => {
    const activeIds = new Set(agents.map((a) => a.id));
    for (const id of deskByAgentRef.current.keys())
      if (!activeIds.has(id)) deskByAgentRef.current.delete(id);
    for (const id of gymByAgentRef.current.keys())
      if (!activeIds.has(id)) gymByAgentRef.current.delete(id);
    for (const id of qaByAgentRef.current.keys())
      if (!activeIds.has(id)) qaByAgentRef.current.delete(id);
    for (const id of stickyUntilRef.current.keys())
      if (!activeIds.has(id)) stickyUntilRef.current.delete(id);

    const currentMap = new Map(renderAgentsRef.current.map((a) => [a.id, a]));
    const next: RenderAgent[] = [];

    agents.forEach((agent, idx) => {
      const now = Date.now();
      const existing = currentMap.get(agent.id);
      const isJanitor = "role" in agent && agent.role === "janitor";
      if (isJanitor) {
        const route = agent.janitorRoute;
        const spawn = route[0] ?? { x: 400, y: 400, facing: Math.PI / 2 };
        const initialRouteIndex = route.length > 1 ? 1 : 0;
        const initialTarget = route[initialRouteIndex] ?? spawn;
        if (existing) {
          next.push({
            ...existing,
            ...agent,
            targetX: existing.targetX,
            targetY: existing.targetY,
            janitorRouteIndex: existing.janitorRouteIndex ?? initialRouteIndex,
            janitorPauseUntil: existing.janitorPauseUntil,
          } as RenderAgent);
          return;
        }
        next.push({
          ...agent,
          x: spawn.x,
          y: spawn.y,
          targetX: initialTarget.x,
          targetY: initialTarget.y,
          path:
            initialRouteIndex === 0
              ? []
              : planPath(spawn.x, spawn.y, initialTarget.x, initialTarget.y),
          frame: 0,
          walkSpeed: WALK_SPEED * 0.82,
          phaseOffset: Math.random() * Math.PI * 2,
          state: initialRouteIndex === 0 ? "standing" : "walking",
          facing: spawn.facing,
          janitorRouteIndex: initialRouteIndex,
        } as RenderAgent);
        return;
      }
      const assignedDeskIndex = assignedDeskIndexByAgentId[agent.id];
      if (
        typeof assignedDeskIndex === "number" &&
        assignedDeskIndex >= 0 &&
        assignedDeskIndex < Math.max(deskLocations.length, 1)
      ) {
        deskByAgentRef.current.set(agent.id, assignedDeskIndex);
      } else {
        deskByAgentRef.current.delete(agent.id);
      }
      if (!gymByAgentRef.current.has(agent.id)) {
        gymByAgentRef.current.set(
          agent.id,
          nextGymRef.current % Math.max(gymWorkoutLocations.length, 1),
        );
        nextGymRef.current += 1;
      }
      if (!qaByAgentRef.current.has(agent.id)) {
        qaByAgentRef.current.set(
          agent.id,
          nextQaRef.current % Math.max(qaLabStations.length, 1),
        );
        nextQaRef.current += 1;
      }
      const explicitDeskHold = Boolean(deskHoldByAgentId[agent.id]);
      const explicitGymHold = Boolean(gymHoldByAgentId[agent.id]);
      const explicitSmsBoothHold = Boolean(smsBoothHoldByAgentId[agent.id]);
      const explicitPhoneBoothHold = Boolean(phoneBoothHoldByAgentId[agent.id]);
      const explicitQaHold = Boolean(qaHoldByAgentId[agent.id]);
      const explicitGithubHold = Boolean(githubReviewByAgentId[agent.id]);
      if (
        explicitGymHold &&
        gymWorkoutLocations.length > 0 &&
        existing?.interactionTarget !== "gym"
      ) {
        gymByAgentRef.current.set(
          agent.id,
          nextGymRef.current % Math.max(gymWorkoutLocations.length, 1),
        );
        nextGymRef.current += 1;
      }
      if (
        explicitQaHold &&
        qaLabStations.length > 0 &&
        existing?.interactionTarget !== "qa_lab"
      ) {
        qaByAgentRef.current.set(
          agent.id,
          nextQaRef.current % Math.max(qaLabStations.length, 1),
        );
        nextQaRef.current += 1;
      }
      const deskIdx = deskByAgentRef.current.get(agent.id);
      const gymIdx =
        gymByAgentRef.current.get(agent.id) ??
        idx % Math.max(gymWorkoutLocations.length, 1);
      const qaIdx =
        qaByAgentRef.current.get(agent.id) ??
        idx % Math.max(qaLabStations.length, 1);
      const deskPos =
        typeof deskIdx === "number" ? (deskLocations[deskIdx] ?? null) : null;
      // Unassigned agents intentionally have no synthetic desk fallback. Desk routing is now
      // driven by persisted workspace assignments instead of sequential scene-local ownership.
      if (!deskPos) {
        stickyUntilRef.current.delete(agent.id);
      }
      const gymWorkoutPos = gymWorkoutLocations[gymIdx] ?? GYM_DEFAULT_TARGET;
      const qaStationPos = qaLabStations[qaIdx] ?? {
        ...QA_LAB_DEFAULT_TARGET,
        stationType: "console" as const,
      };
      const explicitMeetingHold =
        meetingParticipants.has(agent.id);
      const meetingTarget = explicitMeetingHold
        ? resolveMeetingTarget(agent.id)
        : null;
      const smsBoothItem =
        (furnitureRef.current ?? []).find(
          (item) => item.type === "sms_booth",
        ) ?? null;
      const phoneBoothItem =
        (furnitureRef.current ?? []).find(
          (item) => item.type === "phone_booth",
        ) ?? null;

      if (agent.status === "working" && !explicitDeskHold && deskPos)
        stickyUntilRef.current.set(agent.id, now + DESK_STICKY_MS);
      const stickyUntil = stickyUntilRef.current.get(agent.id) ?? 0;
      const effectiveStatus: OfficeAgent["status"] =
        agent.status === "error"
          ? "error"
          : explicitMeetingHold ||
              explicitDeskHold ||
              explicitGymHold ||
              explicitSmsBoothHold ||
              explicitPhoneBoothHold ||
              explicitQaHold ||
              explicitGithubHold ||
              agent.status === "working" ||
              stickyUntil > now
            ? "working"
            : "idle";

      let ns: Partial<RenderAgent> = {};
      if (existing) {
        ns = { ...existing };
        if (explicitMeetingHold && meetingTarget) {
          ns.pingPongUntil = undefined;
          ns.pingPongTargetX = undefined;
          ns.pingPongTargetY = undefined;
          ns.pingPongFacing = undefined;
          ns.pingPongPartnerId = undefined;
          ns.pingPongTableUid = undefined;
          ns.pingPongSide = undefined;
          ns.walkSpeed =
            existing.pingPongPreviousWalkSpeed ?? existing.walkSpeed;
          ns.pingPongPreviousWalkSpeed = undefined;
          ns.interactionTarget = "meeting_room";
          ns.phoneBoothStage = undefined;
          ns.serverRoomStage = undefined;
          ns.gymStage = undefined;
          ns.qaLabStage = undefined;
          ns.qaLabStationType = undefined;
          ns.workoutStyle = undefined;
          const targetChanged =
            existing.targetX !== meetingTarget.x ||
            existing.targetY !== meetingTarget.y ||
            existing.interactionTarget !== "meeting_room";
          ns.targetX = meetingTarget.x;
          ns.targetY = meetingTarget.y;
          if (targetChanged) {
            ns.path = planPath(
              existing.x,
              existing.y,
              meetingTarget.x,
              meetingTarget.y,
            );
          }
          ns.state =
            Math.hypot(
              existing.x - meetingTarget.x,
              existing.y - meetingTarget.y,
            ) < 15
              ? "sitting"
              : "walking";
          ns.facing = meetingTarget.facing;
          ns.seatFacing = meetingTarget.facing; // AAS(2026-10-26-009): 걸어와 앉을 때도 이 방향을 본다
        } else if (explicitGymHold) {
          const gymRoute = resolveGymRoute(
            existing.x,
            existing.y,
            gymWorkoutPos,
          );
          ns.pingPongUntil = undefined;
          ns.pingPongTargetX = undefined;
          ns.pingPongTargetY = undefined;
          ns.pingPongFacing = undefined;
          ns.pingPongPartnerId = undefined;
          ns.pingPongTableUid = undefined;
          ns.pingPongSide = undefined;
          ns.walkSpeed =
            existing.pingPongPreviousWalkSpeed ?? existing.walkSpeed;
          ns.pingPongPreviousWalkSpeed = undefined;
          ns.interactionTarget = "gym";
          ns.phoneBoothStage = undefined;
          ns.serverRoomStage = undefined;
          ns.gymStage = gymRoute.stage;
          ns.qaLabStage = undefined;
          ns.qaLabStationType = undefined;
          ns.workoutStyle = gymWorkoutPos.workoutStyle;
          const targetChanged =
            existing.targetX !== gymRoute.targetX ||
            existing.targetY !== gymRoute.targetY ||
            existing.gymStage !== gymRoute.stage;
          ns.targetX = gymRoute.targetX;
          ns.targetY = gymRoute.targetY;
          if (targetChanged) {
            ns.path = planPath(
              existing.x,
              existing.y,
              gymRoute.targetX,
              gymRoute.targetY,
            );
          }
          ns.state =
            Math.hypot(
              existing.x - gymRoute.targetX,
              existing.y - gymRoute.targetY,
            ) < 15
              ? gymRoute.stage === "workout"
                ? "working_out"
                : "standing"
              : "walking";
          ns.facing = gymRoute.facing;
        } else if (explicitQaHold) {
          const qaLabRoute = resolveQaLabRoute(
            existing.x,
            existing.y,
            qaStationPos,
          );
          ns.pingPongUntil = undefined;
          ns.pingPongTargetX = undefined;
          ns.pingPongTargetY = undefined;
          ns.pingPongFacing = undefined;
          ns.pingPongPartnerId = undefined;
          ns.pingPongTableUid = undefined;
          ns.pingPongSide = undefined;
          ns.walkSpeed =
            existing.pingPongPreviousWalkSpeed ?? existing.walkSpeed;
          ns.pingPongPreviousWalkSpeed = undefined;
          ns.interactionTarget = "qa_lab";
          ns.phoneBoothStage = undefined;
          ns.serverRoomStage = undefined;
          ns.gymStage = undefined;
          ns.qaLabStage = qaLabRoute.stage;
          ns.qaLabStationType = qaStationPos.stationType;
          ns.workoutStyle = undefined;
          const targetChanged =
            existing.targetX !== qaLabRoute.targetX ||
            existing.targetY !== qaLabRoute.targetY ||
            existing.qaLabStage !== qaLabRoute.stage;
          ns.targetX = qaLabRoute.targetX;
          ns.targetY = qaLabRoute.targetY;
          if (targetChanged) {
            ns.path = planPath(
              existing.x,
              existing.y,
              qaLabRoute.targetX,
              qaLabRoute.targetY,
            );
          }
          ns.state =
            Math.hypot(
              existing.x - qaLabRoute.targetX,
              existing.y - qaLabRoute.targetY,
            ) < 15
              ? "standing"
              : "walking";
          ns.facing = qaLabRoute.facing;
        } else if (explicitGithubHold) {
          const serverRoomRoute = resolveServerRoomRoute(
            existing.x,
            existing.y,
          );
          ns.pingPongUntil = undefined;
          ns.pingPongTargetX = undefined;
          ns.pingPongTargetY = undefined;
          ns.pingPongFacing = undefined;
          ns.pingPongPartnerId = undefined;
          ns.pingPongTableUid = undefined;
          ns.pingPongSide = undefined;
          ns.walkSpeed =
            existing.pingPongPreviousWalkSpeed ?? existing.walkSpeed;
          ns.pingPongPreviousWalkSpeed = undefined;
          ns.interactionTarget = "server_room";
          ns.phoneBoothStage = undefined;
          ns.serverRoomStage = serverRoomRoute.stage;
          ns.gymStage = undefined;
          ns.qaLabStage = undefined;
          ns.qaLabStationType = undefined;
          ns.workoutStyle = undefined;
          const targetChanged =
            existing.targetX !== serverRoomRoute.targetX ||
            existing.targetY !== serverRoomRoute.targetY ||
            existing.serverRoomStage !== serverRoomRoute.stage;
          ns.targetX = serverRoomRoute.targetX;
          ns.targetY = serverRoomRoute.targetY;
          if (targetChanged) {
            ns.path = planPath(
              existing.x,
              existing.y,
              serverRoomRoute.targetX,
              serverRoomRoute.targetY,
            );
          }
          ns.state =
            Math.hypot(
              existing.x - serverRoomRoute.targetX,
              existing.y - serverRoomRoute.targetY,
            ) < 15
              ? "standing"
              : "walking";
          ns.facing = serverRoomRoute.facing;
        } else if (explicitSmsBoothHold) {
          const smsBoothRoute = resolveSmsBoothRoute(
            smsBoothItem,
            existing.x,
            existing.y,
          );
          ns.pingPongUntil = undefined;
          ns.pingPongTargetX = undefined;
          ns.pingPongTargetY = undefined;
          ns.pingPongFacing = undefined;
          ns.pingPongPartnerId = undefined;
          ns.pingPongTableUid = undefined;
          ns.pingPongSide = undefined;
          ns.walkSpeed =
            existing.pingPongPreviousWalkSpeed ?? existing.walkSpeed;
          ns.pingPongPreviousWalkSpeed = undefined;
          ns.interactionTarget = "sms_booth";
          ns.smsBoothStage = smsBoothRoute.stage;
          ns.phoneBoothStage = undefined;
          ns.serverRoomStage = undefined;
          ns.gymStage = undefined;
          ns.qaLabStage = undefined;
          ns.qaLabStationType = undefined;
          ns.workoutStyle = undefined;
          const targetChanged =
            existing.targetX !== smsBoothRoute.targetX ||
            existing.targetY !== smsBoothRoute.targetY ||
            existing.smsBoothStage !== smsBoothRoute.stage;
          ns.targetX = smsBoothRoute.targetX;
          ns.targetY = smsBoothRoute.targetY;
          if (targetChanged) {
            ns.path = planPath(
              existing.x,
              existing.y,
              smsBoothRoute.targetX,
              smsBoothRoute.targetY,
            );
          }
          ns.state =
            Math.hypot(
              existing.x - smsBoothRoute.targetX,
              existing.y - smsBoothRoute.targetY,
            ) < 15
              ? "standing"
              : "walking";
          ns.facing = smsBoothRoute.facing;
        } else if (explicitPhoneBoothHold) {
          const phoneBoothRoute = resolvePhoneBoothRoute(
            phoneBoothItem,
            existing.x,
            existing.y,
          );
          ns.pingPongUntil = undefined;
          ns.pingPongTargetX = undefined;
          ns.pingPongTargetY = undefined;
          ns.pingPongFacing = undefined;
          ns.pingPongPartnerId = undefined;
          ns.pingPongTableUid = undefined;
          ns.pingPongSide = undefined;
          ns.walkSpeed =
            existing.pingPongPreviousWalkSpeed ?? existing.walkSpeed;
          ns.pingPongPreviousWalkSpeed = undefined;
          ns.interactionTarget = "phone_booth";
          ns.phoneBoothStage = phoneBoothRoute.stage;
          ns.serverRoomStage = undefined;
          ns.gymStage = undefined;
          ns.qaLabStage = undefined;
          ns.qaLabStationType = undefined;
          ns.workoutStyle = undefined;
          const targetChanged =
            existing.targetX !== phoneBoothRoute.targetX ||
            existing.targetY !== phoneBoothRoute.targetY ||
            existing.phoneBoothStage !== phoneBoothRoute.stage;
          ns.targetX = phoneBoothRoute.targetX;
          ns.targetY = phoneBoothRoute.targetY;
          if (targetChanged) {
            ns.path = planPath(
              existing.x,
              existing.y,
              phoneBoothRoute.targetX,
              phoneBoothRoute.targetY,
            );
          }
          ns.state =
            Math.hypot(
              existing.x - phoneBoothRoute.targetX,
              existing.y - phoneBoothRoute.targetY,
            ) < 15
              ? "standing"
              : "walking";
          ns.facing = phoneBoothRoute.facing;
        } else if (effectiveStatus === "working" && deskPos) {
          ns.pingPongUntil = undefined;
          ns.pingPongTargetX = undefined;
          ns.pingPongTargetY = undefined;
          ns.pingPongFacing = undefined;
          ns.pingPongPartnerId = undefined;
          ns.pingPongTableUid = undefined;
          ns.pingPongSide = undefined;
          ns.walkSpeed =
            existing.pingPongPreviousWalkSpeed ?? existing.walkSpeed;
          ns.pingPongPreviousWalkSpeed = undefined;
          ns.interactionTarget = "desk";
          ns.phoneBoothStage = undefined;
          ns.serverRoomStage = undefined;
          ns.gymStage = undefined;
          ns.qaLabStage = undefined;
          ns.qaLabStationType = undefined;
          ns.workoutStyle = undefined;
          const targetChanged =
            existing.targetX !== deskPos.x || existing.targetY !== deskPos.y;
          ns.targetX = deskPos.x;
          ns.targetY = deskPos.y;
          if (targetChanged)
            ns.path = planPath(existing.x, existing.y, deskPos.x, deskPos.y);
          ns.state =
            Math.hypot(existing.x - deskPos.x, existing.y - deskPos.y) < 15
              ? "sitting"
              : "walking";
        } else if (effectiveStatus === "working") {
          ns.pingPongUntil = undefined;
          ns.pingPongTargetX = undefined;
          ns.pingPongTargetY = undefined;
          ns.pingPongFacing = undefined;
          ns.pingPongPartnerId = undefined;
          ns.pingPongTableUid = undefined;
          ns.pingPongSide = undefined;
          ns.walkSpeed =
            existing.pingPongPreviousWalkSpeed ?? existing.walkSpeed;
          ns.pingPongPreviousWalkSpeed = undefined;
          ns.interactionTarget = undefined;
          ns.phoneBoothStage = undefined;
          ns.serverRoomStage = undefined;
          ns.gymStage = undefined;
          ns.qaLabStage = undefined;
          ns.qaLabStationType = undefined;
          ns.workoutStyle = undefined;
          ns.targetX = existing.x;
          ns.targetY = existing.y;
          ns.path = [];
          ns.state = "standing";
        } else if (effectiveStatus === "error") {
          ns.pingPongUntil = undefined;
          ns.pingPongTargetX = undefined;
          ns.pingPongTargetY = undefined;
          ns.pingPongFacing = undefined;
          ns.pingPongPartnerId = undefined;
          ns.pingPongTableUid = undefined;
          ns.pingPongSide = undefined;
          ns.walkSpeed =
            existing.pingPongPreviousWalkSpeed ?? existing.walkSpeed;
          ns.pingPongPreviousWalkSpeed = undefined;
          ns.interactionTarget = undefined;
          ns.phoneBoothStage = undefined;
          ns.serverRoomStage = undefined;
          ns.gymStage = undefined;
          ns.qaLabStage = undefined;
          ns.qaLabStationType = undefined;
          ns.workoutStyle = undefined;
          ns.targetX = existing.x;
          ns.targetY = existing.y;
          ns.path = [];
          ns.state = "standing";
        }
        if (effectiveStatus !== existing.status) {
          if (effectiveStatus === "working") {
            const serverRoomRoute = resolveServerRoomRoute(
              existing.x,
              existing.y,
            );
            const smsBoothRoute = resolveSmsBoothRoute(
              smsBoothItem,
              existing.x,
              existing.y,
            );
            const phoneBoothRoute = resolvePhoneBoothRoute(
              phoneBoothItem,
              existing.x,
              existing.y,
            );
            const gymRoute = resolveGymRoute(
              existing.x,
              existing.y,
              gymWorkoutPos,
            );
            const qaLabRoute = resolveQaLabRoute(
              existing.x,
              existing.y,
              qaStationPos,
            );
            const nextTarget =
              explicitMeetingHold && meetingTarget
                ? { x: meetingTarget.x, y: meetingTarget.y }
                : explicitGymHold
                  ? { x: gymRoute.targetX, y: gymRoute.targetY }
                  : explicitSmsBoothHold
                    ? {
                        x: smsBoothRoute.targetX,
                        y: smsBoothRoute.targetY,
                      }
                    : explicitPhoneBoothHold
                      ? {
                          x: phoneBoothRoute.targetX,
                          y: phoneBoothRoute.targetY,
                        }
                      : explicitQaHold
                        ? { x: qaLabRoute.targetX, y: qaLabRoute.targetY }
                        : explicitGithubHold
                          ? {
                              x: serverRoomRoute.targetX,
                              y: serverRoomRoute.targetY,
                            }
                          : deskPos;
            if (!nextTarget) {
              ns.interactionTarget = undefined;
              ns.serverRoomStage = undefined;
              ns.gymStage = undefined;
              ns.qaLabStage = undefined;
              ns.qaLabStationType = undefined;
              ns.workoutStyle = undefined;
              ns.targetX = existing.x;
              ns.targetY = existing.y;
              ns.path = [];
              ns.state = "standing";
              next.push({
                ...agent,
                ...ns,
                status: effectiveStatus,
              } as RenderAgent);
              return;
            }
            ns.interactionTarget = explicitMeetingHold
              ? "meeting_room"
              : explicitGymHold
                ? "gym"
                : explicitSmsBoothHold
                  ? "sms_booth"
                  : explicitPhoneBoothHold
                    ? "phone_booth"
                    : explicitQaHold
                      ? "qa_lab"
                      : explicitGithubHold
                        ? "server_room"
                        : "desk";
            ns.phoneBoothStage =
              explicitMeetingHold ||
              explicitGymHold ||
              explicitSmsBoothHold ||
              !explicitPhoneBoothHold
                ? undefined
                : phoneBoothRoute.stage;
            ns.smsBoothStage =
              explicitMeetingHold || explicitGymHold || !explicitSmsBoothHold
                ? undefined
                : smsBoothRoute.stage;
            ns.serverRoomStage = explicitMeetingHold
              ? undefined
              : explicitGymHold
                ? undefined
                : explicitSmsBoothHold
                  ? undefined
                  : explicitPhoneBoothHold
                    ? undefined
                    : explicitGithubHold
                      ? serverRoomRoute.stage
                      : undefined;
            ns.gymStage = explicitMeetingHold
              ? undefined
              : explicitGymHold
                ? gymRoute.stage
                : undefined;
            ns.qaLabStage = explicitMeetingHold
              ? undefined
              : explicitSmsBoothHold
                ? undefined
                : explicitPhoneBoothHold
                  ? undefined
                  : explicitQaHold
                    ? qaLabRoute.stage
                    : undefined;
            ns.qaLabStationType = explicitQaHold
              ? qaStationPos.stationType
              : undefined;
            ns.workoutStyle = explicitGymHold
              ? gymWorkoutPos.workoutStyle
              : undefined;
            ns.targetX = nextTarget.x;
            ns.targetY = nextTarget.y;
            ns.path = planPath(
              existing.x,
              existing.y,
              nextTarget.x,
              nextTarget.y,
            );
            ns.state = "walking";
          } else if (effectiveStatus === "error") {
            ns.interactionTarget = undefined;
            ns.smsBoothStage = undefined;
            ns.phoneBoothStage = undefined;
            ns.serverRoomStage = undefined;
            ns.gymStage = undefined;
            ns.qaLabStage = undefined;
            ns.qaLabStationType = undefined;
            ns.workoutStyle = undefined;
            ns.targetX = existing.x;
            ns.targetY = existing.y;
            ns.path = [];
            ns.state = "standing";
          } else if (existing.status === "working") {
            ns.interactionTarget = undefined;
            ns.smsBoothStage = undefined;
            ns.phoneBoothStage = undefined;
            ns.serverRoomStage = undefined;
            ns.gymStage = undefined;
            ns.qaLabStage = undefined;
            ns.qaLabStationType = undefined;
            ns.workoutStyle = undefined;
            // AAS(2026-10-21-023): 일을 마친 에이전트는 자기 책상으로 간다(이미 앉아 있으면 그대로 1~3분 더 앉아 있다).
            // 원본은 늘 사무실 곳곳으로 걸어 나갔다
            if (deskPos && !isRemoteOfficeAgentId(agent.id)) {
              ns.interactionTarget = "desk";
              ns.targetX = deskPos.x;
              ns.targetY = deskPos.y;
              ns.idleStoodUp = undefined;
              if (existing.state === "sitting" && Math.hypot(existing.x - deskPos.x, existing.y - deskPos.y) < SEAT_REACH) {
                ns.path = [];
                ns.state = "sitting";
                ns.idleSeatUntil = idleSeatDeadline(now, Math.random());
              } else {
                ns.path = planPath(existing.x, existing.y, deskPos.x, deskPos.y);
                ns.state = "walking";
                ns.idleSeatUntil = undefined;
              }
            } else {
              const r = pickRoamPoint(agent.id);
              ns.targetX = r.x;
              ns.targetY = r.y;
              ns.path = planPath(existing.x, existing.y, r.x, r.y);
              ns.state = "walking";
            }
          }
        }
        // AAS(2026-10-26-004): 쉬는 자리(소파·탕비실 의자)에서 일을 받거나 오류가 나면 들어온 칸으로 먼저 나간다.
        // 소파 안에서 바로 길을 찾으면 소파를 지나 걷고, 오류는 제자리에 서서 소파 속에 선 채로 남았다
        if (effectiveStatus !== "idle") ns.away = undefined; // AAS(2026-10-26-012): 일을 받으면 자리 비움 표시를 지운다
        if (existing.restSeat && effectiveStatus !== "idle") {
          const r = existing.restSeat;
          ns.restSeat = undefined;
          if (Math.hypot(existing.x - r.x, existing.y - r.y) < SEAT_REACH) {
            const a = { x: r.approachX, y: r.approachY };
            const tx = ns.targetX ?? a.x;
            const ty = ns.targetY ?? a.y;
            const stay = Math.hypot(tx - r.x, ty - r.y) < SEAT_REACH;
            ns.path = stay ? [a] : [a, ...planPath(a.x, a.y, tx, ty)];
            if (stay) {
              ns.targetX = a.x;
              ns.targetY = a.y;
            }
            ns.state = "walking";
          }
        }
      } else {
        // New agent — spawn at a random position and plan path to first target.
        const { x: sx, y: sy } = pickSpawnPoint(agent.id);
        const serverRoomRoute = resolveServerRoomRoute(sx, sy);
        const smsBoothRoute = resolveSmsBoothRoute(smsBoothItem, sx, sy);
        const phoneBoothRoute = resolvePhoneBoothRoute(phoneBoothItem, sx, sy);
        const gymRoute = resolveGymRoute(sx, sy, gymWorkoutPos);
        const qaLabRoute = resolveQaLabRoute(sx, sy, qaStationPos);
        // AAS(2026-10-26-009): 회의 참가자는 상태(「문제 있음」 포함)와 관계없이 회의 자리가 첫 목적지다. 원본은 일하는 중일 때만 그랬는데
        // interactionTarget 은 상태와 관계없이 meeting_room 이라, 오류 에이전트가 나타난 자리를 회의 자리로 알고 그 자리(복도)에 앉았다
        const initialTarget =
          explicitMeetingHold && meetingTarget
            ? { x: meetingTarget.x, y: meetingTarget.y }
            : effectiveStatus === "working"
              ? explicitGymHold
                ? {
                    x: gymRoute.targetX,
                    y: gymRoute.targetY,
                  }
                : explicitSmsBoothHold
                  ? {
                      x: smsBoothRoute.targetX,
                      y: smsBoothRoute.targetY,
                    }
                  : explicitPhoneBoothHold
                    ? {
                        x: phoneBoothRoute.targetX,
                        y: phoneBoothRoute.targetY,
                      }
                    : explicitQaHold
                      ? {
                          x: qaLabRoute.targetX,
                          y: qaLabRoute.targetY,
                        }
                      : explicitGithubHold
                        ? {
                            x: serverRoomRoute.targetX,
                            y: serverRoomRoute.targetY,
                          }
                        : (deskPos ?? { x: sx, y: sy })
            : // AAS(2026-10-21-023): 대기 에이전트도 처음에 자기 책상에 있다. 원본은 시작 지점에 섰다
              effectiveStatus === "idle" && deskPos && !isRemoteOfficeAgentId(agent.id)
              ? deskPos
              : { x: sx, y: sy };
        // AAS(2026-10-21-023): 처음 목표가 자기 책상이면 걸어오지 않고 책상에 앉은 채 시작한다. 원본은 사무실 아무 곳에서
        // 나타나 걸어와, 화면을 연 뒤 1~2분은 모두 걷고 있었다
        const startSeated = deskPos !== null && initialTarget === deskPos;
        ns = {
          x: startSeated ? deskPos.x : sx,
          y: startSeated ? deskPos.y : sy,
          targetX: initialTarget.x,
          targetY: initialTarget.y,
          path: startSeated ? [] : planPath(sx, sy, initialTarget.x, initialTarget.y),
          frame: 0,
          walkSpeed: WALK_SPEED * (0.7 + Math.random() * 0.6),
          phaseOffset: Math.random() * Math.PI * 2,
          state: startSeated
            ? "sitting"
            : initialTarget.x !== sx || initialTarget.y !== sy
              ? "walking"
              : "standing",
          idleSeatUntil:
            startSeated && effectiveStatus === "idle"
              ? idleSpawnDeadline(now, Math.random())
              : undefined,
          interactionTarget: explicitMeetingHold
            ? "meeting_room"
            : explicitGymHold
              ? "gym"
              : explicitSmsBoothHold
                ? "sms_booth"
                : explicitPhoneBoothHold
                  ? "phone_booth"
                  : explicitQaHold
                    ? "qa_lab"
                    : explicitGithubHold
                      ? "server_room"
                      : deskPos
                        ? "desk"
                        : undefined,
          smsBoothStage:
            explicitMeetingHold || explicitGymHold || !explicitSmsBoothHold
              ? undefined
              : smsBoothRoute.stage,
          phoneBoothStage:
            explicitMeetingHold ||
            explicitGymHold ||
            explicitSmsBoothHold ||
            !explicitPhoneBoothHold
              ? undefined
              : phoneBoothRoute.stage,
          serverRoomStage:
            explicitMeetingHold ||
            explicitGymHold ||
            explicitSmsBoothHold ||
            explicitPhoneBoothHold ||
            !explicitGithubHold
              ? undefined
              : serverRoomRoute.stage,
          gymStage:
            explicitMeetingHold || !explicitGymHold
              ? undefined
              : gymRoute.stage,
          qaLabStage:
            explicitMeetingHold ||
            explicitSmsBoothHold ||
            explicitPhoneBoothHold ||
            !explicitQaHold
              ? undefined
              : qaLabRoute.stage,
          qaLabStationType: explicitQaHold
            ? qaStationPos.stationType
            : undefined,
          workoutStyle: explicitGymHold
            ? gymWorkoutPos.workoutStyle
            : undefined,
          facing:
            explicitMeetingHold && meetingTarget
              ? meetingTarget.facing
              : startSeated
                ? (deskPos.facing ?? Math.PI / 2)
                : Math.PI / 2,
          seatFacing: explicitMeetingHold && meetingTarget ? meetingTarget.facing : undefined,
        };
      }
      next.push({ ...agent, ...ns, status: effectiveStatus } as RenderAgent);
    });
    renderAgentsRef.current = next;
    const renderAgentLookup = renderAgentLookupRef.current;
    renderAgentLookup.clear();
    for (const agent of next) {
      renderAgentLookup.set(agent.id, agent);
    }
  }, [
    agents,
    assignedDeskIndexByAgentId,
    deskHoldByAgentId,
    deskLocations,
    furnitureRef,
    gymHoldByAgentId,
    gymWorkoutLocations,
    smsBoothHoldByAgentId,
    phoneBoothHoldByAgentId,
    qaHoldByAgentId,
    qaLabStations,
    githubReviewByAgentId,
    meetingParticipants,
    meetingSeatLocations,
    pickRoamPoint,
    pickSpawnPoint,
    planPath,
    resolveMeetingTarget,
    standupActive,
    standupMeeting,
  ]);

  // Tick called each frame — follows A* waypoints, no React state.
  const tick = () => {
    const grid = getNavGrid();
    const now = Date.now();
    const furnitureItems = furnitureRef.current ?? [];
    const smsBoothItem =
      furnitureItems.find((item) => item.type === "sms_booth") ?? null;
    const phoneBoothItem =
      furnitureItems.find((item) => item.type === "phone_booth") ?? null;
    const socialFurniture = furnitureItems.filter((item) =>
      [
        "couch",
        "couch_v",
        "beanbag",
        "coffee_machine",
        "water_cooler",
      ].includes(item.type),
    );
    // AAS(2026-10-26-012): 다른 캐릭터(에이전트·사람)가 쓰지 않는 쉬는 자리 하나(core/idleRest.ts). 점유는 지난 틱의 위치로 보므로
    // 같은 틱에 고른 자리(claimedThisTick)도 뺀다 — 자리 비움이 한꺼번에 시작되면 두 에이전트가 같은 소파 자리를 골랐다
    const claimedThisTick: { x: number; y: number }[] = [];
    const pickFreeRestSeat = (selfId: string) => {
      const occupied: { x: number; y: number }[] = [...claimedThisTick];
      for (const other of [...renderAgentsRef.current, ...(aasPeopleRef?.current ?? [])]) {
        if (other.id === selfId) continue;
        const p = occupiedPoint(other);
        if (p) occupied.push(p);
      }
      const picked = pickRestSeat(restSeatsOf(furnitureItems), occupied, Math.random());
      if (picked) claimedThisTick.push({ x: picked.x, y: picked.y });
      return picked;
    };
    /** 그 쉬는 자리에 다른 캐릭터가 이미 앉아 있는가 — 먼저 앉은 쪽이 자리를 갖고, 늦은 쪽은 자리를 푼다 */
    const restSeatSatBy = (seat: { x: number; y: number }, selfId: string) =>
      [...renderAgentsRef.current, ...(aasPeopleRef?.current ?? [])].some(
        (o) => o.id !== selfId && o.state === "sitting" && Math.hypot(o.x - seat.x, o.y - seat.y) <= REST_SEAT_NEAR,
      );
    const moved = renderAgentsRef.current.map((agent) => {
      const isJanitor = "role" in agent && agent.role === "janitor";
      if (isJanitor && agent.janitorPauseUntil !== undefined) {
        if (now < agent.janitorPauseUntil) {
          return {
            ...agent,
            state: "standing" as const,
            frame: agent.frame + 1,
          };
        }
        const nextRouteIndex = (agent.janitorRouteIndex ?? 0) + 1;
        const nextTarget = agent.janitorRoute[nextRouteIndex];
        if (!nextTarget) {
          return {
            ...agent,
            janitorPauseUntil: undefined,
            state: "standing" as const,
            frame: agent.frame + 1,
          };
        }
        return {
          ...agent,
          janitorPauseUntil: undefined,
          janitorRouteIndex: nextRouteIndex,
          targetX: nextTarget.x,
          targetY: nextTarget.y,
          path: astar(agent.x, agent.y, nextTarget.x, nextTarget.y, grid),
          facing: nextTarget.facing,
          state: "walking" as const,
          frame: agent.frame + 1,
        };
      }
      if (agent.pingPongUntil !== undefined && now >= agent.pingPongUntil) {
        return {
          ...agent,
          walkSpeed: agent.pingPongPreviousWalkSpeed ?? agent.walkSpeed,
          pingPongUntil: undefined,
          pingPongTargetX: undefined,
          pingPongTargetY: undefined,
          pingPongFacing: undefined,
          pingPongPartnerId: undefined,
          pingPongTableUid: undefined,
          pingPongSide: undefined,
          pingPongPreviousWalkSpeed: undefined,
          targetX: agent.x,
          targetY: agent.y,
          path: [],
          state: "standing" as const,
          frame: agent.frame + 1,
        };
      }
      // Bumped agents are frozen: legs stop, no movement.
      // When the timer expires, resume walking from the same spot and briefly
      // ignore further collisions so both agents can peel away cleanly.
      if (agent.bumpedUntil !== undefined) {
        if (now < agent.bumpedUntil) {
          return {
            ...agent,
            state: "standing" as const,
            frame: agent.frame + 1,
          };
        }
        // AAS(2026-10-26-004): 쉬러 가던 대기 에이전트는 비켜 갈 배회 지점(부딪힘이 바꾼 목적지) 대신 다시 자기 쉬는 자리로 간다.
        // 그대로 두면 배회 지점에 닿아 자리를 풀었고, 사람이 많으면 자리 쪽으로 가다 되돌아가기를 되풀이해 앉지 못했다
        const rest = agent.status === "idle" ? agent.restSeat : undefined;
        const restPath = rest
          ? planRoute(
              { x: agent.x, y: agent.y },
              null,
              rest,
              { x: rest.approachX, y: rest.approachY },
              (x, y) => isNavFree(grid, x, y),
              (fx, fy, tx, ty) => astar(fx, fy, tx, ty, grid),
            )
          : [];
        if (rest && restPath.length > 0) {
          return {
            ...agent,
            bumpedUntil: undefined,
            collisionCooldownUntil: now + BUMP_RECOVERY_MS,
            state: "walking" as const,
            targetX: rest.x,
            targetY: rest.y,
            path: restPath,
            frame: agent.frame + 1,
          };
        }
        return {
          ...agent,
          bumpedUntil: undefined,
          collisionCooldownUntil: now + BUMP_RECOVERY_MS,
          state: "walking" as const,
          path: astar(agent.x, agent.y, agent.targetX, agent.targetY, grid),
          frame: agent.frame + 1,
        };
      }
      const baseSpeed = agent.walkSpeed ?? WALK_SPEED;
      const speed =
        agent.status === "working" && agent.state !== "sitting"
          ? baseSpeed * WORKING_WALK_SPEED_MULTIPLIER
          : baseSpeed;
      // Move toward the first waypoint. An empty path means astar found no route —
      // the agent stays put instead of walking through walls toward the raw target.
      const path = agent.path ?? [];
      const wpX = path.length > 0 ? path[0].x : agent.x;
      const wpY = path.length > 0 ? path[0].y : agent.y;
      const dx = wpX - agent.x,
        dy = wpY - agent.y;
      const dist = Math.hypot(dx, dy);

      let ns = agent.state,
        nx = agent.x,
        ny = agent.y,
        nf = agent.facing,
        npath = path;

      if (dist > speed) {
        nx = agent.x + (dx / dist) * speed;
        ny = agent.y + (dy / dist) * speed;
        // atan2(dx, dy) gives the rotation.y angle for the direction of travel
        // (local +Z aligns with the movement vector when rotation.y = atan2(dx, dy)).
        nf = Math.atan2(dx, dy);
        ns = "walking";
      } else {
        // Reached current waypoint — advance or finalise.
        nx = wpX;
        ny = wpY;
        if (path.length > 1) {
          npath = path.slice(1);
          ns = "walking";
        } else {
          npath = [];
          if (isJanitor) {
            const routeIndex = agent.janitorRouteIndex ?? 0;
            const currentStop =
              agent.janitorRoute[routeIndex] ?? agent.janitorRoute.at(-1);
            return {
              ...agent,
              x: nx,
              y: ny,
              facing: currentStop?.facing ?? nf,
              state: "standing" as const,
              path: [],
              janitorPauseUntil:
                routeIndex < agent.janitorRoute.length - 1
                  ? now + agent.janitorPauseMs
                  : undefined,
              frame: agent.frame + 1,
            };
          }
          if (agent.pingPongUntil !== undefined) {
            nx = agent.pingPongTargetX ?? nx;
            ny = agent.pingPongTargetY ?? ny;
            nf = agent.pingPongFacing ?? nf;
            ns = "standing";
          } else if (agent.status === "working") {
            if (
              agent.interactionTarget === "sms_booth" &&
              agent.smsBoothStage !== "typing"
            ) {
              const nextSmsBoothRoute = resolveSmsBoothRoute(
                smsBoothItem,
                nx,
                ny,
              );
              return {
                ...agent,
                x: nx,
                y: ny,
                targetX: nextSmsBoothRoute.targetX,
                targetY: nextSmsBoothRoute.targetY,
                path: astar(
                  nx,
                  ny,
                  nextSmsBoothRoute.targetX,
                  nextSmsBoothRoute.targetY,
                  grid,
                ),
                facing: nextSmsBoothRoute.facing,
                state: "walking" as const,
                smsBoothStage: nextSmsBoothRoute.stage,
                frame: agent.frame + 1,
              };
            }
            if (
              agent.interactionTarget === "phone_booth" &&
              agent.phoneBoothStage !== "receiver"
            ) {
              const nextPhoneBoothRoute = resolvePhoneBoothRoute(
                phoneBoothItem,
                nx,
                ny,
              );
              return {
                ...agent,
                x: nx,
                y: ny,
                targetX: nextPhoneBoothRoute.targetX,
                targetY: nextPhoneBoothRoute.targetY,
                path: astar(
                  nx,
                  ny,
                  nextPhoneBoothRoute.targetX,
                  nextPhoneBoothRoute.targetY,
                  grid,
                ),
                facing: nextPhoneBoothRoute.facing,
                state: "walking" as const,
                phoneBoothStage: nextPhoneBoothRoute.stage,
                frame: agent.frame + 1,
              };
            }
            if (
              agent.interactionTarget === "server_room" &&
              agent.serverRoomStage !== "terminal"
            ) {
              const nextServerRoomRoute = resolveServerRoomRoute(nx, ny);
              return {
                ...agent,
                x: nx,
                y: ny,
                targetX: nextServerRoomRoute.targetX,
                targetY: nextServerRoomRoute.targetY,
                path: astar(
                  nx,
                  ny,
                  nextServerRoomRoute.targetX,
                  nextServerRoomRoute.targetY,
                  grid,
                ),
                facing: nextServerRoomRoute.facing,
                state: "walking" as const,
                serverRoomStage: nextServerRoomRoute.stage,
                frame: agent.frame + 1,
              };
            }
            if (
              agent.interactionTarget === "gym" &&
              agent.gymStage !== "workout"
            ) {
              const gymIdx = gymByAgentRef.current.get(agent.id) ?? 0;
              const workoutTarget =
                gymWorkoutLocations[gymIdx] ?? GYM_DEFAULT_TARGET;
              const nextGymRoute = resolveGymRoute(nx, ny, workoutTarget);
              return {
                ...agent,
                x: nx,
                y: ny,
                targetX: nextGymRoute.targetX,
                targetY: nextGymRoute.targetY,
                path: astar(
                  nx,
                  ny,
                  nextGymRoute.targetX,
                  nextGymRoute.targetY,
                  grid,
                ),
                facing: nextGymRoute.facing,
                state: "walking" as const,
                gymStage: nextGymRoute.stage,
                frame: agent.frame + 1,
              };
            }
            if (
              agent.interactionTarget === "qa_lab" &&
              agent.qaLabStage !== "station"
            ) {
              const qaIdx = qaByAgentRef.current.get(agent.id) ?? 0;
              const qaTarget = qaLabStations[qaIdx] ?? {
                ...QA_LAB_DEFAULT_TARGET,
                stationType: "console" as const,
              };
              const nextQaLabRoute = resolveQaLabRoute(nx, ny, qaTarget);
              return {
                ...agent,
                x: nx,
                y: ny,
                targetX: nextQaLabRoute.targetX,
                targetY: nextQaLabRoute.targetY,
                path: astar(
                  nx,
                  ny,
                  nextQaLabRoute.targetX,
                  nextQaLabRoute.targetY,
                  grid,
                ),
                facing: nextQaLabRoute.facing,
                state: "walking" as const,
                qaLabStage: nextQaLabRoute.stage,
                qaLabStationType: qaTarget.stationType,
                frame: agent.frame + 1,
              };
            }
            ns =
              agent.interactionTarget === "sms_booth"
                ? "standing"
                : agent.interactionTarget === "phone_booth"
                  ? "standing"
                  : agent.interactionTarget === "server_room"
                    ? "standing"
                    : agent.interactionTarget === "gym"
                      ? "working_out"
                      : agent.interactionTarget === "qa_lab"
                        ? "standing"
                        : // AAS(2026-10-21): 책상·회의 자리에 실제로 닿았을 때만 앉는다. 원본은 여기서 늘 앉혀, 자리가 없거나
                          // 길을 찾지 못한(빈 길) 에이전트가 복도에서 허공에 앉았다(core/seatArrival.ts)
                          arrivedState(agent.interactionTarget, nx, ny, agent.targetX, agent.targetY);
            if (agent.interactionTarget === "sms_booth") {
              nf = agent.facing;
            } else if (agent.interactionTarget === "phone_booth") {
              nf = agent.facing;
            } else if (agent.interactionTarget === "server_room") {
              nf = SERVER_ROOM_TARGET.facing;
            } else if (agent.interactionTarget === "gym") {
              nf = agent.facing;
            } else if (agent.interactionTarget === "qa_lab") {
              nf = agent.facing;
            } else if (agent.interactionTarget === "meeting_room") {
              // AAS(2026-10-26-009): 앉으면 의자 정면(회의 자리 방향)을 본다. 원본은 마지막 걸음 방향이라 옆이나 뒤를 보고 앉았다
              nf = ns === "sitting" ? (agent.seatFacing ?? agent.facing) : agent.facing;
            }
          } else if (agent.status === "error") {
            // AAS(2026-10-26-009): 「문제 있음」 에이전트도 회의 참가자면 회의 자리에 닿았을 때 앉는다(「최대한 착석」).
            // 원본은 오류면 늘 서게 해 회의실 의자 옆에 서 있었다
            ns = arrivedState(agent.interactionTarget === "meeting_room" ? "meeting_room" : undefined, nx, ny, agent.targetX, agent.targetY);
            if (ns === "sitting") nf = agent.seatFacing ?? agent.facing;
          } else {
            // New Idea 9: away state — if idle for > AWAY_THRESHOLD_MS, send to nearest couch.
            const lastSeen = lastSeenByAgentId[agent.id] ?? 0;
            const isAway = lastSeen > 0 && now - lastSeen > AWAY_THRESHOLD_MS;
            // AAS(2026-10-26-012): 자리 비움 에이전트는 자기 책상에 앉아 있는다(책상이 없으면 빈 쉬는 자리, 그것도 없으면 그 자리에 선다,
            // core/idleAway.ts). 원본은 소파 하나를 골라 그 가운데로 보내 저녁에는 전원이 소파 앞에 몰렸고, 거기서 돌아다니다 다시 소파로
            // 돌아왔다. 자리 비움에서는 다음 걸음(돌아다니기·쉬러 가기)을 하지 않는다
            if (isAway) {
              const awayDeskIdx = deskByAgentRef.current.get(agent.id);
              const remote = isRemoteOfficeAgentId(agent.id);
              const awayDesk = remote || typeof awayDeskIdx !== "number" ? null : (deskLocations[awayDeskIdx] ?? null);
              const ownRest = agent.restSeat && !restSeatSatBy(agent.restSeat, agent.id) ? agent.restSeat : undefined;
              const step = awayStep(
                { x: nx, y: ny, targetX: agent.targetX, targetY: agent.targetY, restSeat: ownRest },
                awayDesk,
                () => (remote ? null : pickFreeRestSeat(agent.id)),
              );
              if (step.kind === "sit") {
                return { ...agent, x: nx, y: ny, facing: step.facing ?? nf, state: "sitting" as const, away: true, path: [], frame: agent.frame + 1 };
              }
              if (step.kind === "go") {
                const goPath = step.rest
                  ? planRoute(
                      { x: nx, y: ny },
                      null,
                      step.rest,
                      { x: step.rest.approachX, y: step.rest.approachY },
                      (x, y) => isNavFree(grid, x, y),
                      (fx, fy, tx, ty) => astar(fx, fy, tx, ty, grid),
                    )
                  : astar(nx, ny, step.x, step.y, grid);
                return {
                  ...agent,
                  x: nx,
                  y: ny,
                  targetX: step.x,
                  targetY: step.y,
                  path: goPath,
                  restSeat: step.rest ?? ownRest,
                  interactionTarget: step.rest ? undefined : ("desk" as const),
                  idleSeatUntil: undefined,
                  idleStoodUp: undefined,
                  away: undefined,
                  // 길이 없으면 목적지만 적어 두고 선다 — 다음 틱 awayStep 이 「가 봤다」로 보고 선 채 둔다
                  state: goPath.length > 0 ? ("walking" as const) : ("away" as const),
                  frame: agent.frame + 1,
                };
              }
              return { ...agent, x: nx, y: ny, facing: nf, state: "away" as const, path: [], restSeat: ownRest, frame: agent.frame + 1 };
            }
            // AAS(2026-10-21-023): 자기 책상에 닿은 대기 에이전트는 1~3분 앉아 있다가 일어나 잠깐 선다. 다음 걸음은
            // 80% 가 다시 책상(제자리면 다시 앉음), 20% 가 원본처럼 돌아다니기다(core/idleDesk.ts).
            // 자리 비움(30분 넘게 대기)은 위에서 자기 책상으로 보낸다(2026-10-26-012, 전에는 원본처럼 소파로 갔다)
            // AAS(2026-10-26-004): 쉬는 자리(소파·탕비실 의자)에 닿으면 책상처럼 1~3분 앉았다가, 일어나면 들어온 칸으로 나간다
            const rest = isAway ? undefined : agent.restSeat;
            // 맡은 자리에 다른 캐릭터가 먼저 앉았으면 자리를 풀고 선다(다음 걸음을 기다린다). 앉아 있던 쪽이면 그대로다
            if (rest && agent.state !== "sitting" && restSeatSatBy(rest, agent.id)) {
              return { ...agent, x: nx, y: ny, facing: nf, state: "standing" as const, path: [], restSeat: undefined, frame: agent.frame + 1 };
            }
            if (rest) {
              const step = idleAtDesk({ x: nx, y: ny, state: agent.state, idleSeatUntil: agent.idleSeatUntil }, rest, now, Math.random());
              if (step.kind === "sit" || step.kind === "stay") {
                return {
                  ...agent,
                  x: nx,
                  y: ny,
                  facing: rest.facing,
                  state: "sitting" as const,
                  path: [],
                  idleSeatUntil: step.kind === "sit" ? step.until : agent.idleSeatUntil,
                  frame: agent.frame + 1,
                };
              }
              if (step.kind === "leave") {
                return {
                  ...agent,
                  x: nx,
                  y: ny,
                  targetX: rest.approachX,
                  targetY: rest.approachY,
                  path: [{ x: rest.approachX, y: rest.approachY }],
                  restSeat: undefined,
                  idleSeatUntil: undefined,
                  state: "walking" as const,
                  frame: agent.frame + 1,
                };
              }
              // 길 끝이 자리가 아니다(닿지 못했다). 맡은 자리를 풀어야 다른 에이전트가 쓴다(occupiedPoint 는 맡은 자리를 본다)
              return {
                ...agent,
                x: nx,
                y: ny,
                facing: nf,
                state: "standing" as const,
                path: [],
                restSeat: undefined,
                frame: agent.frame + 1,
              };
            }
            const deskIdx = deskByAgentRef.current.get(agent.id);
            const idleDesk =
              isAway || isRemoteOfficeAgentId(agent.id) || typeof deskIdx !== "number"
                ? null
                : (deskLocations[deskIdx] ?? null);
            const seat = idleAtDesk({ x: nx, y: ny, state: agent.state, idleSeatUntil: agent.idleSeatUntil, idleStoodUp: agent.idleStoodUp }, idleDesk, now, Math.random());
            if (seat.kind === "sit" || seat.kind === "stay") {
              return {
                ...agent,
                x: nx,
                y: ny,
                facing: nf,
                state: "sitting" as const,
                path: [],
                idleSeatUntil: seat.kind === "sit" ? seat.until : agent.idleSeatUntil,
                idleStoodUp: undefined,
                frame: agent.frame + 1,
              };
            }
            if (seat.kind === "leave") {
              return {
                ...agent,
                x: nx,
                y: ny,
                facing: nf,
                state: "standing" as const,
                path: [],
                idleSeatUntil: undefined,
                idleStoodUp: true,
                frame: agent.frame + 1,
              };
            }
            ns = isAway ? ("away" as const) : "standing";
            if (Math.random() < 0.005) {
              const trip = idleNextTrip(idleDesk !== null, Math.random());
              if (idleDesk && trip === "desk") {
                return {
                  ...agent,
                  x: nx,
                  y: ny,
                  targetX: idleDesk.x,
                  targetY: idleDesk.y,
                  path: astar(nx, ny, idleDesk.x, idleDesk.y, grid),
                  interactionTarget: "desk" as const,
                  idleSeatUntil: undefined,
                  idleStoodUp: undefined,
                  restSeat: undefined,
                  state: "walking" as const,
                  frame: agent.frame + 1,
                };
              }
              // AAS(2026-10-26-004): 쉬러 간다 — 다른 에이전트·사람이 쓰지 않는 소파·탕비실 자리로, 들어오는 칸을 거쳐 앉는다.
              // 빈 자리나 길이 없으면 원본처럼 돌아다닌다
              if (trip === "rest" && !isAway && !isRemoteOfficeAgentId(agent.id)) {
                const restPick = pickFreeRestSeat(agent.id);
                const restPath = restPick
                  ? planRoute(
                      { x: nx, y: ny },
                      null,
                      restPick,
                      { x: restPick.approachX, y: restPick.approachY },
                      (x, y) => isNavFree(grid, x, y),
                      (fx, fy, tx, ty) => astar(fx, fy, tx, ty, grid),
                    )
                  : [];
                if (restPick && restPath.length > 0) {
                  return {
                    ...agent,
                    x: nx,
                    y: ny,
                    targetX: restPick.x,
                    targetY: restPick.y,
                    path: restPath,
                    interactionTarget: undefined,
                    idleSeatUntil: undefined,
                    idleStoodUp: undefined,
                    restSeat: restPick,
                    state: "walking" as const,
                    frame: agent.frame + 1,
                  };
                }
              }
              // Idea 6: 15% chance to walk to a social furniture item instead of a random roam point.
              let target: { x: number; y: number } | null = null;
              const socialCandidates = isRemoteOfficeAgentId(agent.id)
                ? []
                : socialFurniture;
              if (socialCandidates.length > 0 && Math.random() < 0.15) {
                const f =
                  socialCandidates[
                    Math.floor(Math.random() * socialCandidates.length)
                  ];
                // AAS: 가구 상자 바깥의 빈 칸만 고른다(socialTargetsOf). 원본은 가구 안·옆 탁자 안을 목표로 잡아 가구를 지나 걸었다
                const spots = socialTargetsOf(f, (x, y) =>
                  isNavFree(grid, x, y),
                );
                const spot = spots[Math.floor(Math.random() * spots.length)];
                if (spot) {
                  target = isRemoteOfficeAgentId(agent.id)
                    ? clampPointToZone(spot.x, spot.y, REMOTE_OFFICE_ZONE)
                    : spot;
                }
              }
              if (!target) {
                target = pickRoamPoint(agent.id);
              }
              return {
                ...agent,
                x: nx,
                y: ny,
                targetX: target.x,
                targetY: target.y,
                path: astar(nx, ny, target.x, target.y, grid),
                interactionTarget: undefined,
                idleSeatUntil: undefined,
                idleStoodUp: undefined,
                restSeat: undefined,
                state: "walking" as const,
                frame: agent.frame + 1,
              };
            }
          }
        }
      }

      if ((danceUntilByAgentId[agent.id] ?? 0) > now && ns !== "away") {
        ns = "dancing";
        npath = [];
      }

      return {
        ...agent,
        x: nx,
        y: ny,
        facing: nf,
        state: ns,
        path: npath,
        frame: agent.frame + 1,
      };
    });

    // AAS(2026-10-26-012): 자리 비움이 풀린 에이전트(다시 말을 걸었다 등)는 자리 비움 표시를 지운다
    for (let k = 0; k < moved.length; k += 1) {
      const a = moved[k];
      if (!a.away) continue;
      const seen = lastSeenByAgentId[a.id] ?? 0;
      if (!(seen > 0 && now - seen > AWAY_THRESHOLD_MS)) moved[k] = { ...a, away: undefined };
    }

    // Collision bump — when agents overlap, stop them briefly and reroute them
    // in different directions without the old hard shove.
    // AAS(2026-10-21-021): 마주친 짝은 「...」 대신 인사를 주고받는다
    const movedWithCollisions = applyAgentCollisionBumps({
      agents: moved,
      now,
      greetings: aasGreetings ? { pairs: aasGreetings.pairs, memory: greetMemoryRef.current } : undefined,
    });

    renderAgentsRef.current = movedWithCollisions;
    const renderAgentLookup = renderAgentLookupRef.current;
    renderAgentLookup.clear();
    for (const agent of movedWithCollisions) {
      renderAgentLookup.set(agent.id, agent);
    }
  };

  return {
    renderAgentsRef,
    renderAgentLookupRef,
    tick,
    deskByAgentRef,
    planPath,
  };
}

// ============================================================
// NEW IDEA 2 — CAMERA PRESETS
// ============================================================

// AAS: 부재 기준을 30분으로(계획 007 D2, 원본 15분). 화면의 명단(bubbles.ts 의 AWAY_AFTER_S)과 같아야 한다
const AWAY_THRESHOLD_MS = 30 * 60 * 1000;
const COMPACT_AGENT_BADGE_LIMIT = 6;

const estimatePhoneSpeechDurationMs = (
  text: string | null | undefined,
): number => {
  const normalized = text?.trim() ?? "";
  if (!normalized) return 5_000;
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  return Math.max(5_000, Math.min(12_000, 1_800 + wordCount * 380));
};

const getAgentInitials = (name: string | null | undefined): string => {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
};

// AAS: serverMode 이면 브라우저 저장소를 읽지 않는다 — 레이아웃은 서버(판 번호)가 정본이다(계획 007 P−1).
const buildInitialFurnitureLayout = (
  storageNamespace: string,
  layoutPreset: OfficeLayoutPreset,
  serverMode = false,
): FurnitureItem[] =>
  // AAS: 서버 모드의 기본 배치는 한국 사무실 배치다(계획 2026-10-13-001). 원본의 ensureOffice*(ATM·부스·서버실·QA 실험실·
  // 주크박스·탁구대·칸반 보드를 다시 넣는다)는 부르지 않는다. 실제 판은 서버가 같은 배치(default_layout.json)로 만든다
  serverMode ? buildAasKoreanOffice() :
  ensureOfficeKanbanBoard(
    ensureOfficeJukebox(
      ensureOfficeQaLab(
        // AAS: ensureOfficeGymRoom 을 부르지 않는다 — 헬스장을 뺀 배치에 다시 넣지 않게(계획 007)
        ensureOfficeServerRoom(
          ensureOfficePhoneBooth(
            ensureOfficeSmsBooth(
              ensureOfficeAtm(
                ensureOfficePingPongTable(
                  (serverMode ? null : loadFurniture(storageNamespace)) ?? materializeDefaults(layoutPreset),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );

// AAS: 내 아바타가 처음 들어오는 곳 — 오피스 가운데(막혀 있으면 가장 가까운 빈 칸, 계획 007 P6b)
const AAS_PERSON_SPAWN = { x: LOCAL_OFFICE_CANVAS_WIDTH / 2, y: LOCAL_OFFICE_CANVAS_HEIGHT / 2 };

export function RetroOffice3D({
  agents,
  officeCenterSignal = 0,
  animationState = null,
  readOnly = false,
  storageNamespace = "default",
  layoutPreset = "office",
  deskAssignmentByDeskUid = EMPTY_STRING_RECORD,
  serverFurniture,
  onServerFurnitureMissing,
  focusRequest = null,
  cameraCommand = null,
  followAgentId: controlledFollowAgentId,
  onDeviceSelect,
  onMeetingScreenSelect,
  onRoomLabelSelect,
  aasPeople,
  aasBanner = null,
  aasEditor,
  aasBackdrop,
  aasTheme = "dark",
  aasMeetingSeats = EMPTY_AAS_MEETING_SEATS,
  aasGreetings,
  aasRoomLabels,
  aasRoomsInMeeting,
  aasRoomStatus,
  cleaningCues = EMPTY_CLEANING_CUES,
  deskHoldByAgentId = EMPTY_BOOLEAN_RECORD,
  gymHoldByAgentId = EMPTY_BOOLEAN_RECORD,
  githubReviewAgentId = null,
  phoneBoothAgentId = null,
  phoneCallScenario = null,
  smsBoothAgentId = null,
  textMessageScenario = null,
  qaHoldByAgentId = EMPTY_BOOLEAN_RECORD,
  qaTestingAgentId = null,
  standupMeeting = null,
  standupAutoOpenBoard = true,
  monitorAgentId = null,
  monitorByAgentId = EMPTY_MONITOR_MAP,
  githubSkill = null,
  taskManagerEnabled = false,
  soundclawEnabled = false,
  officeTitle = "Luke Headquarters",
  officeTitleLoaded = false,
  remoteOfficeEnabled = false,
  remoteOfficeSourceKind = "presence_endpoint",
  remoteOfficeLabel = "Remote Office",
  remoteOfficePresenceUrl = "",
  remoteOfficeGatewayUrl = "",
  remoteOfficeStatusText = "Remote office disabled.",
  remoteLayoutSnapshot = null,
  remoteOfficeTokenConfigured = false,
  voiceRepliesEnabled = false,
  voiceRepliesVoiceId = null,
  voiceRepliesSpeed = 1,
  voiceRepliesLoaded = false,
  onOfficeTitleChange,
  onRemoteOfficeEnabledChange,
  onRemoteOfficeSourceKindChange,
  onRemoteOfficeLabelChange,
  onRemoteOfficePresenceUrlChange,
  onRemoteOfficeGatewayUrlChange,
  onRemoteOfficeTokenChange,
  onVoiceRepliesToggle,
  onVoiceRepliesVoiceChange,
  onVoiceRepliesSpeedChange,
  onVoiceRepliesPreview,
  onGatewayDisconnect,
  onGatewayConnect,
  onGatewayUrlChange,
  onGatewayTokenChange,
  onGatewayAdapterTypeChange,
  onOpenOnboarding,
  atmAnalytics = null,
  feedEvents = EMPTY_FEED_EVENTS,
  gatewayStatus = "disconnected",
  gatewayUrl = "",
  gatewayToken = "",
  selectedAdapterType = "openclaw",
  activeAdapterType = "openclaw",
  runCountByAgentId = EMPTY_NUMBER_RECORD,
  lastSeenByAgentId = EMPTY_NUMBER_RECORD,
  streamingTextByAgentId = {},
  onStandupArrivalsChange,
  onStandupStartRequested,
  onMonitorSelect,
  onAgentChatSelect,
  onAgentBubbleAction,
  agentBubbleLabels,
  onAddAgent,
  onAgentEdit,
  onAgentDelete,
  onDeskAssignmentChange,
  onDeskAssignmentsReset,
  onGithubReviewDismiss,
  onPhoneCallComplete,
  onPhoneCallSpeak,
  onTextMessageComplete,
  onQaLabDismiss,
  onOpenGithubSkillSetup,
  onJukeboxInteract,
  onKanbanInteract,
  taskBoardAgents = [],
  taskBoardCardsByStatus = {
    todo: [],
    in_progress: [],
    blocked: [],
    review: [],
    done: [],
  },
  taskBoardSelectedCard = null,
  taskBoardActiveRuns = [],
  taskBoardCronJobs = [],
  taskBoardCronLoading = false,
  taskBoardCronError = null,
  taskBoardCaptureDebug,
  onTaskBoardCreateCard,
  onTaskBoardMoveCard,
  onTaskBoardSelectCard,
  onTaskBoardUpdateCard,
  onTaskBoardDeleteCard,
  onTaskBoardRefreshCronJobs,
}: {
  agents: OfficeAgent[];
  officeCenterSignal?: number;
  animationState?: Pick<
    OfficeAnimationState,
    | "cleaningCues"
    | "danceUntilByAgentId"
    | "deskHoldByAgentId"
    | "githubHoldByAgentId"
    | "gymHoldByAgentId"
    | "phoneBoothHoldByAgentId"
    | "smsBoothHoldByAgentId"
    | "qaHoldByAgentId"
    | "jukeboxHoldByAgentId"
  > | null;
  readOnly?: boolean;
  storageNamespace?: string;
  layoutPreset?: OfficeLayoutPreset;
  deskAssignmentByDeskUid?: Record<string, string>;
  /** AAS: 서버 레이아웃. undefined 면 원본처럼 브라우저 저장소, null 이면 아직 서버에 판이 없음(기본 배치를 만들어 onServerFurnitureMissing 으로 알린다). */
  serverFurniture?: FurnitureItem[] | null;
  onServerFurnitureMissing?: (items: FurnitureItem[]) => void;
  /** AAS: 명단에서 고른 에이전트로 카메라 중심을 옮긴다. n 이 바뀔 때마다 한 번(같은 에이전트를 다시 눌러도 옮긴다).
   *  at 이 있으면 에이전트 대신 그 점(배치 좌표, 상태판 회의실 행 — 스펙 2026-10-20-021 R12)으로 옮긴다. */
  /** highlight: 잠깐 표시할 대상 — 에이전트 별칭 또는 방 표시 uid(스펙 2026-10-21-012). 상태판에서 고를 때만 온다 */
  focusRequest?: { id: string; n: number; at?: { x: number; y: number }; zoom?: boolean; highlight?: string } | null;
  /** AAS: 카메라 조작 단추(스펙 2026-10-21-006). n 이 바뀔 때마다 한 번. reset 은 처음 구도. */
  cameraCommand?: { kind: CameraNudge | "reset"; n: number } | null;
  /** AAS: 따라가기를 바깥(HUD)에서 정한다. undefined 면 원본처럼 장면 안에서만 정한다. */
  followAgentId?: string | null;
  /** AAS: 서버 단말·QA 단말·칸반 보드를 누르면 알린다(계획 007 P5). */
  onDeviceSelect?: (device: AasDevice) => void;
  /** AAS: 회의실 빔 프로젝터 스크린(tv_meeting)을 누르면 그 스크린 항목의 uid 를 알린다(OMAI-1257). 주지 않으면 누를 때 아무 일도 없다 */
  onMeetingScreenSelect?: (screenUid: string) => void;
  /** AAS: 방 명패를 누르면 그 방 표시 항목의 uid 를 알린다. 주지 않으면 명패는 누를 수 없다 */
  onRoomLabelSelect?: (roomUid: string) => void;
  /** AAS: 장면 뒤 배경(CSS background 값). 캔버스는 투명이라 이 값이 비쳐 보인다. 없으면 원본의 어두운 갈색. */
  aasBackdrop?: string;
  /** AAS: 콘솔 테마. 장면 객체 색(SCENE_PALETTE)을 고른다(스펙 2026-10-20-012). Canvas key 에는 넣지 않는다. */
  aasTheme?: "dark" | "light";
  /** AAS: 관리자 배치 편집(계획 007 P7). active 동안 편집 모드, 끄면 서버 판으로 되돌린다. */
  aasEditor?: {
    active: boolean;
    apiRef: React.MutableRefObject<AasEditorApi | null>;
    onChange: (state: AasEditorState) => void;
    /** 지우기 키를 눌렀다 — 확인은 바깥이 한다(책상이면 배정이 풀린다). */
    onDeleteRequest: (item: FurnitureItem) => void;
  };
  /** AAS: 진행 중인 회의마다 참가 에이전트가 앉을 회의실 자리(별칭 → 자리, 계획 2026-10-13-001 R4). */
  aasMeetingSeats?: Record<string, { x: number; y: number; facing: number }>;
  /** AAS(스펙 2026-10-21-021): 마주친 에이전트의 인사와 혼자 서 있는 에이전트의 혼잣말(번역한 문구, {name} 은 상대 이름 자리) */
  aasGreetings?: GreetingLines;
  /** AAS: 배치의 방 표시(room)마다 문 위 이름(uid → 이름). */
  aasRoomLabels?: Record<string, string>;
  /** AAS: 지금 회의 중인 방 표시 uid. 방 명패 앞에 회의 중 표시를 단다 */
  aasRoomsInMeeting?: Set<string>;
  /** AAS: 방 표시 uid → 명패 둘째 줄 글(번역됨). moved 면 회색 이동 안내(스펙 2026-10-20-017 디자인 리뷰 이슈 1·2) */
  aasRoomStatus?: Record<string, { text: string; moved: boolean }>;
  /** AAS: 부서 슬로건·목표 현수막(스펙 2026-10-15-018). 문구가 있고 사용자가 끄지 않았을 때만 준다. */
  aasBanner?: { banners: Banner[]; mine: string; theme: "dark" | "light" } | null;
  /** AAS: 오피스에 있는 사람 아바타와 내 아바타 걷기(계획 007 P6b). */
  aasPeople?: { people: AasScenePerson[]; walk: boolean; instant: boolean; onMove: (pos: PersonPos) => void };
  cleaningCues?: OfficeCleaningCue[];
  deskHoldByAgentId?: Record<string, boolean>;
  gymHoldByAgentId?: Record<string, boolean>;
  githubReviewAgentId?: string | null;
  phoneBoothAgentId?: string | null;
  phoneCallScenario?: MockPhoneCallScenario | null;
  smsBoothAgentId?: string | null;
  textMessageScenario?: MockTextMessageScenario | null;
  qaHoldByAgentId?: Record<string, boolean>;
  qaTestingAgentId?: string | null;
  standupMeeting?: StandupMeeting | null;
  standupAutoOpenBoard?: boolean;
  monitorAgentId?: string | null;
  monitorByAgentId?: OfficeDeskMonitorMap;
  githubSkill?: SkillStatusEntry | null;
  taskManagerEnabled?: boolean;
  soundclawEnabled?: boolean;
  officeTitle?: string;
  officeTitleLoaded?: boolean;
  remoteOfficeEnabled?: boolean;
  remoteOfficeSourceKind?: "presence_endpoint" | "openclaw_gateway";
  remoteOfficeLabel?: string;
  remoteOfficePresenceUrl?: string;
  remoteOfficeGatewayUrl?: string;
  remoteOfficeStatusText?: string;
  remoteLayoutSnapshot?: OfficeLayoutSnapshot | null;
  remoteOfficeTokenConfigured?: boolean;
  voiceRepliesEnabled?: boolean;
  voiceRepliesVoiceId?: string | null;
  voiceRepliesSpeed?: number;
  voiceRepliesLoaded?: boolean;
  onOfficeTitleChange?: (title: string) => void;
  onRemoteOfficeEnabledChange?: (enabled: boolean) => void;
  onRemoteOfficeSourceKindChange?: (
    kind: "presence_endpoint" | "openclaw_gateway",
  ) => void;
  onRemoteOfficeLabelChange?: (label: string) => void;
  onRemoteOfficePresenceUrlChange?: (url: string) => void;
  onRemoteOfficeGatewayUrlChange?: (url: string) => void;
  onRemoteOfficeTokenChange?: (token: string) => void;
  onVoiceRepliesToggle?: (enabled: boolean) => void;
  onVoiceRepliesVoiceChange?: (voiceId: string | null) => void;
  onVoiceRepliesSpeedChange?: (speed: number) => void;
  onVoiceRepliesPreview?: (voiceId: string | null, voiceName: string) => void;
  onGatewayDisconnect?: () => void;
  onGatewayConnect?: () => void;
  onGatewayUrlChange?: (value: string) => void;
  onGatewayTokenChange?: (value: string) => void;
  onGatewayAdapterTypeChange?: (value: StudioGatewayAdapterType) => void;
  onOpenOnboarding?: () => void;
  atmAnalytics?: OfficeUsageAnalyticsParams | null;
  feedEvents?: FeedEvent[];
  gatewayStatus?: string;
  gatewayUrl?: string;
  gatewayToken?: string;
  selectedAdapterType?: StudioGatewayAdapterType;
  activeAdapterType?: StudioGatewayAdapterType;
  runCountByAgentId?: Record<string, number>;
  lastSeenByAgentId?: Record<string, number>;
  streamingTextByAgentId?: Record<string, string | null>;
  onStandupArrivalsChange?: (arrivedAgentIds: string[]) => void;
  onStandupStartRequested?: () => void;
  onMonitorSelect?: (agentId: string | null) => void;
  onAgentChatSelect?: (agentId: string) => void;
  /** AAS(OMAI-1115): 말풍선 위 '대화'·'상세' 단추. */
  onAgentBubbleAction?: (agentId: string, action: "chat" | "detail") => void;
  agentBubbleLabels?: { chat: string; detail: string; more: string; meeting?: string };
  onAddAgent?: () => void;
  onAgentEdit?: (agentId: string) => void;
  onAgentDelete?: (agentId: string) => void;
  onDeskAssignmentChange?: (deskUid: string, agentId: string | null) => void;
  onDeskAssignmentsReset?: (deskUids: string[]) => void;
  onGithubReviewDismiss?: () => void;
  onPhoneCallComplete?: (agentId: string) => void;
  onPhoneCallSpeak?: (payload: {
    agentId: string;
    requestKey: string;
    scenario: MockPhoneCallScenario;
  }) => void;
  onTextMessageComplete?: (agentId: string) => void;
  onQaLabDismiss?: () => void;
  onOpenGithubSkillSetup?: () => void;
  onJukeboxInteract?: () => void;
  onKanbanInteract?: () => void;
  taskBoardAgents?: AgentState[];
  taskBoardCardsByStatus?: Record<TaskBoardStatus, TaskBoardCard[]>;
  taskBoardSelectedCard?: TaskBoardCard | null;
  taskBoardActiveRuns?: Array<{
    runId: string;
    agentId: string;
    label: string;
  }>;
  taskBoardCronJobs?: CronJobSummary[];
  taskBoardCronLoading?: boolean;
  taskBoardCronError?: string | null;
  taskBoardCaptureDebug?: unknown;
  onTaskBoardCreateCard?: () => void;
  onTaskBoardMoveCard?: (cardId: string, status: TaskBoardStatus) => void;
  onTaskBoardSelectCard?: (cardId: string | null) => void;
  onTaskBoardUpdateCard?: (
    cardId: string,
    patch: Partial<TaskBoardCard>,
  ) => void;
  onTaskBoardDeleteCard?: (cardId: string) => void;
  onTaskBoardRefreshCronJobs?: () => void;
}) {
  const resolvedCleaningCues = animationState?.cleaningCues ?? cleaningCues;
  const resolvedDanceUntilByAgentId =
    animationState?.danceUntilByAgentId ?? EMPTY_NUMBER_RECORD;
  const kanbanDeskTaskCount = useMemo(
    () =>
      Object.entries(taskBoardCardsByStatus).reduce(
        (total, [status, cards]) =>
          status === "done" ? total : total + cards.length,
        0,
      ),
    [taskBoardCardsByStatus],
  );
  const resolvedDeskHoldByAgentId =
    animationState?.deskHoldByAgentId ?? deskHoldByAgentId;
  const resolvedGymHoldByAgentId =
    animationState?.gymHoldByAgentId ?? gymHoldByAgentId;
  const resolvedSmsBoothHoldByAgentId =
    animationState?.smsBoothHoldByAgentId ?? EMPTY_BOOLEAN_RECORD;
  const resolvedPhoneBoothHoldByAgentId =
    animationState?.phoneBoothHoldByAgentId ?? EMPTY_BOOLEAN_RECORD;
  const resolvedQaHoldByAgentId =
    animationState?.qaHoldByAgentId ?? qaHoldByAgentId;
  const resolvedGithubReviewByAgentId =
    animationState?.githubHoldByAgentId ??
    (githubReviewAgentId
      ? { [githubReviewAgentId]: true }
      : EMPTY_BOOLEAN_RECORD);
  const resolvedJukeboxHoldByAgentId =
    animationState?.jukeboxHoldByAgentId ?? EMPTY_BOOLEAN_RECORD;
  const isJukeboxActive = Object.values(resolvedJukeboxHoldByAgentId).some(
    Boolean,
  );

  const serverMode = serverFurniture !== undefined;
  const [furniture, setFurniture] = useState<FurnitureItem[]>(() =>
    serverFurniture
      ? serverFurniture
      : buildInitialFurnitureLayout(storageNamespace, layoutPreset, serverMode).filter(
          (item) => !isRetiredPingPongLamp(item),
        ),
  );
  const defaultRemoteLayoutFurniture = useMemo(
    () =>
      remoteOfficeEnabled
        ? projectFurnitureIntoRemoteOfficeZone({
            furniture: furniture.filter((item) => !isRetiredPingPongLamp(item)),
            sourceWidth: LOCAL_OFFICE_CANVAS_WIDTH,
            sourceHeight: LOCAL_OFFICE_CANVAS_HEIGHT,
          })
        : EMPTY_FURNITURE_ITEMS,
    [furniture, remoteOfficeEnabled],
  );
  const remoteLayoutFurniture = useMemo(
    () =>
      !remoteOfficeEnabled
        ? EMPTY_FURNITURE_ITEMS
        : remoteLayoutSnapshot
          ? projectFurnitureIntoRemoteOfficeZone({
              furniture: remoteLayoutSnapshot.furniture,
              sourceWidth: remoteLayoutSnapshot.width,
              sourceHeight: remoteLayoutSnapshot.height,
            })
          : defaultRemoteLayoutFurniture,
    [defaultRemoteLayoutFurniture, remoteLayoutSnapshot, remoteOfficeEnabled],
  );
  useEffect(() => {
    if (serverFurniture) {
      setFurniture(serverFurniture);
    } else {
      const built = buildInitialFurnitureLayout(storageNamespace, layoutPreset, serverMode).filter(
        (item) => !isRetiredPingPongLamp(item),
      );
      setFurniture(built);
      if (serverMode) onServerFurnitureMissing?.(built);
    }
    setSelectedUid(null);
    setDeskActionUid(null);
    setDeskAssignPickerOpen(false);
    setDrag({ kind: "idle" });
    setGhostPos(null);
    setWallDrawStart(null);
    // onServerFurnitureMissing 은 판이 없을 때 한 번만 부르면 된다 — 콜백이 바뀌어도 다시 만들지 않는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutPreset, storageNamespace, serverFurniture, serverMode]);
  const [editMode, setEditMode] = useState(false);
  const [selectedUid, setSelectedUid] = useState<string | null>(null);
  const [hoverUid, setHoverUid] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState>({ kind: "idle" });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [ghostPos, setGhostPos] = useState<[number, number, number] | null>(
    null,
  );
  const [wallDrawStart, setWallDrawStart] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [spaceDragging, setSpaceDragging] = useState(false);
  const [standupBoardOpen, setStandupBoardOpen] = useState(false);
  const [activeKanbanUid, setActiveKanbanUid] = useState<string | null>(null);
  const [agentRosterOpen, setAgentRosterOpen] = useState(false);
  const autoOpenedStandupIdRef = useRef<string | null>(null);
  // Idea 1 (original): hovered agent for tooltip overlay.
  const [hoveredAgentId, setHoveredAgentId] = useState<string | null>(null);
  const [renderAgentUiById, setRenderAgentUiById] = useState<
    Record<string, RenderAgentUiSnapshot>
  >({});
  // New Idea 1: right-click context menu.
  const [contextMenu, setContextMenu] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const [deskActionUid, setDeskActionUid] = useState<string | null>(null);
  const [deskAssignPickerOpen, setDeskAssignPickerOpen] = useState(false);
  // New Idea 3: speech bubble agent IDs.
  const [speechAgentIds, setSpeechAgentIds] = useState<Set<string>>(new Set());
  const statusFeedEvents = useMemo(
    () => feedEvents.filter((event) => event.kind !== "reply"),
    [feedEvents],
  );
  const { speechTextByAgentId, speechImageUrlByAgentId } = useMemo(() => {
    const texts: Record<string, string> = {};
    const images: Record<string, string> = {};
    for (const event of feedEvents) {
      const text = event.text.trim();
      if (event.kind !== "reply" || !text || texts[event.id]) continue;
      const { cleanText, imageUrl } = extractSpeechImage(text, event.id);
      texts[event.id] = cleanText;
      if (imageUrl) images[event.id] = imageUrl;
    }
    return { speechTextByAgentId: texts, speechImageUrlByAgentId: images };
  }, [feedEvents]);
  const standupSpeechTextByAgentId = useMemo(() => {
    if (!standupMeeting || standupMeeting.phase !== "in_progress") return {};
    const currentCard =
      standupMeeting.cards.find(
        (card) => card.agentId === standupMeeting.currentSpeakerAgentId,
      ) ?? null;
    if (!currentCard) return {};
    return { [currentCard.agentId]: currentCard.speech };
  }, [standupMeeting]);
  const suppressSceneSpeechBubbles =
    standupMeeting?.phase === "gathering" ||
    standupMeeting?.phase === "in_progress";
  // New Idea 2: camera preset target ref (shared into Canvas).
  const cameraPresetRef = useRef<{
    pos: [number, number, number];
    target: [number, number, number];
    zoom?: number;
  } | null>(null);
  // AAS: 처음 구도. 카메라 조작 단추의 「처음 구도」가 읽는다(스펙 2026-10-21-006)
  const overviewPresetRef = useRef<typeof cameraPresetRef.current>(null);
  const LOCAL_CAMERA_TARGET = useMemo(
    () =>
      toWorld(LOCAL_OFFICE_CANVAS_WIDTH / 2, LOCAL_OFFICE_CANVAS_HEIGHT / 2),
    [],
  );
  const BASE_CAM_POS = useMemo<[number, number, number]>(() => {
    if (remoteOfficeEnabled) return DISTRICT_CAMERA_POSITION;
    return [
      LOCAL_CAMERA_TARGET[0] +
        (DISTRICT_CAMERA_POSITION[0] - DISTRICT_CAMERA_TARGET[0]),
      LOCAL_CAMERA_TARGET[1] +
        (DISTRICT_CAMERA_POSITION[1] - DISTRICT_CAMERA_TARGET[1]),
      LOCAL_CAMERA_TARGET[2] +
        (DISTRICT_CAMERA_POSITION[2] - DISTRICT_CAMERA_TARGET[2]),
    ];
  }, [LOCAL_CAMERA_TARGET, remoteOfficeEnabled]);
  const baseCameraTarget = remoteOfficeEnabled
    ? DISTRICT_CAMERA_TARGET
    : LOCAL_CAMERA_TARGET;
  // AAS: 바닥을 남쪽으로 넓혀(720 → 1080) 처음 구도에 오피스 전체가 들어오게 확대를 줄였다(원본 56, 계획 007)
  const baseCameraZoom = remoteOfficeEnabled ? DISTRICT_CAMERA_ZOOM : OVERVIEW_ZOOM;
  // AAS: 현수막이 있으면 건물 위에 띠를 남긴다(스펙 2026-10-15-018). 캔버스 크기를 알아야 해서 바깥 상자의 크기를 잰다.
  const stageRef = useRef<HTMLDivElement>(null);
  // AAS: 사람 아바타 배우 목록. AasPeopleLayer 가 움직이고 문(DoorModel)이 읽어 열린다
  const aasPeopleRef = useRef<RenderAgent[]>([]);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setStage({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setStage({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  const bannerFit = useMemo(() => {
    if (!aasBanner?.banners.length || remoteOfficeEnabled || stage.w < BANNER_MIN_CANVAS_W || !stage.h) return null;
    const [x0, , z0] = toWorld(0, 0);
    const [x1, , z1] = toWorld(LOCAL_OFFICE_CANVAS_WIDTH, LOCAL_OFFICE_CANVAS_HEIGHT);
    const corners: [number, number, number][] = [];
    for (const x of [x0, x1]) for (const y of [0, 1.5]) for (const z of [z0, z1]) corners.push([x, y, z]);
    return fitOverview({ corners, pos: BASE_CAM_POS, target: baseCameraTarget, canvasW: stage.w, canvasH: stage.h, baseZoom: baseCameraZoom });
  }, [aasBanner?.banners.length, remoteOfficeEnabled, stage.w, stage.h, BASE_CAM_POS, baseCameraTarget, baseCameraZoom]);
  const [CAM_POS, cameraTarget, cameraZoom] = useMemo<[[number, number, number], [number, number, number], number]>(() => {
    if (!bannerFit) return [BASE_CAM_POS, baseCameraTarget, baseCameraZoom];
    const { up } = screenAxes(BASE_CAM_POS, baseCameraTarget);
    const move = (v: [number, number, number]): [number, number, number] => [
      v[0] + up[0] * bannerFit.shiftUp,
      v[1] + up[1] * bannerFit.shiftUp,
      v[2] + up[2] * bannerFit.shiftUp,
    ];
    return [move(BASE_CAM_POS), move(baseCameraTarget), bannerFit.zoom];
  }, [bannerFit, BASE_CAM_POS, baseCameraTarget, baseCameraZoom]);
  const overviewPreset = useMemo(
    () => ({ pos: CAM_POS, target: cameraTarget, zoom: cameraZoom }),
    [CAM_POS, cameraTarget, cameraZoom]
  );
  // AAS: Canvas 밖(이 함수 몸통)에서 쓰는 장면 색. Canvas 안 구성 요소는 useScenePalette() 로 읽는다
  const scenePalette = SCENE_PALETTE[aasTheme];
  const canvasResetKey = useMemo(
    () =>
      [
        remoteOfficeEnabled ? "remote" : "local",
        gatewayStatus ?? "unknown",
        String(agents.length),
        String(officeCenterSignal),
      ].join(":"),
    [agents.length, gatewayStatus, officeCenterSignal, remoteOfficeEnabled],
  );
  // New Idea 7: heatmap mode.
  const [heatmapMode, setHeatmapMode] = useState(false);
  const [trailMode, setTrailMode] = useState(false);
  const heatGridRef = useRef<Uint16Array | null>(null);
  // E3 Idea 1: mood emoji reactions above agent chips.
  const [moodByAgentId, setMoodByAgentId] = useState<
    Record<string, { emoji: string; ts: number }>
  >({});
  const [janitorActors, setJanitorActors] = useState<JanitorActor[]>([]);
  const seenCleaningCueIdsRef = useRef<Set<string>>(new Set());
  // E3 Idea 3: spotlight.
  const [spotlightAgentId, setSpotlightAgentId] = useState<string | null>(null);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orbitRef = useRef<any>(null);
  // 더블클릭이 어느 객체에 대한 것인지 알기 위해 마지막으로 클릭한 객체를 기억한다.
  const lastClickedItemRef = useRef<{ uid: string; t: number } | null>(null);
  // Follow cam: which agent to trail with a third-person perspective camera.
  const [followAgentId, setFollowAgentId] = useState<string | null>(null);
  const followAgentIdRef = useRef<string | null>(null);
  const prevMonitorAgentIdRef = useRef<string | null>(null);
  const prevAtmUidRef = useRef<string | null>(null);
  const prevKanbanUidRef = useRef<string | null>(null);
  const prevSmsBoothViewRef = useRef<string | null>(null);
  const prevPhoneBoothViewRef = useRef<string | null>(null);
  const prevGithubViewRef = useRef<string | null>(null);
  const prevQaViewRef = useRef<string | null>(null);
  const [monitorImmersiveReady, setMonitorImmersiveReady] = useState(false);
  const [activeAtmUid, setActiveAtmUid] = useState<string | null>(null);
  const [atmImmersiveReady, setAtmImmersiveReady] = useState(false);
  const [phoneBoothCommandArrived, setPhoneBoothCommandArrived] =
    useState(false);
  const [phoneBoothImmersiveReady, setPhoneBoothImmersiveReady] =
    useState(false);
  const [phoneBoothDoorOpen, setPhoneBoothDoorOpen] = useState(false);
  const [phoneCallStep, setPhoneCallStep] = useState<PhoneCallStep>("dialing");
  const [dialedDigits, setDialedDigits] = useState("");
  const [smsBoothCommandArrived, setSmsBoothCommandArrived] = useState(false);
  const [smsBoothImmersiveReady, setSmsBoothImmersiveReady] = useState(false);
  const [smsBoothDoorOpen, setSmsBoothDoorOpen] = useState(false);
  const [textMessageStep, setTextMessageStep] =
    useState<TextMessageStep>("selecting_contact");
  const [typedMessageText, setTypedMessageText] = useState("");
  const [activeTextKey, setActiveTextKey] = useState<string | null>(null);
  const [textContacts, setTextContacts] = useState<string[]>([]);
  const [activeTextContactIndex, setActiveTextContactIndex] = useState<
    number | null
  >(null);
  const [manualPhoneBoothOpen, setManualPhoneBoothOpen] = useState(false);
  const [manualPhoneCallScenario, setManualPhoneCallScenario] =
    useState<MockPhoneCallScenario | null>(null);
  const [manualSmsBoothOpen, setManualSmsBoothOpen] = useState(false);
  const [manualTextMessageScenario, setManualTextMessageScenario] =
    useState<MockTextMessageScenario | null>(null);
  const activePhoneCallFlowKeyRef = useRef<string | null>(null);
  const activeTextMessageFlowKeyRef = useRef<string | null>(null);
  const boothAudioCtxRef = useRef<AudioContext | null>(null);
  const effectivePhoneBoothAgentIdRef = useRef<string | null>(null);
  const effectivePhoneCallScenarioRef = useRef<MockPhoneCallScenario | null>(
    null,
  );
  const phoneBoothAgentIdRef = useRef<string | null>(null);
  const onPhoneCallSpeakRef = useRef(onPhoneCallSpeak);
  const onPhoneCallCompleteRef = useRef(onPhoneCallComplete);
  const onStandupArrivalsChangeRef = useRef(onStandupArrivalsChange);
  const lastStandupArrivalKeyRef = useRef<string | null>(null);
  const effectiveSmsBoothAgentIdRef = useRef<string | null>(null);
  const effectiveTextMessageScenarioRef =
    useRef<MockTextMessageScenario | null>(null);
  const smsBoothAgentIdRef = useRef<string | null>(null);
  const onTextMessageCompleteRef = useRef(onTextMessageComplete);
  const [activeGithubTerminalUid, setActiveGithubTerminalUid] = useState<
    string | null
  >(null);
  const [activeQaTerminalUid, setActiveQaTerminalUid] = useState<string | null>(
    null,
  );
  const [githubImmersiveReady, setGithubImmersiveReady] = useState(false);
  const [qaImmersiveReady, setQaImmersiveReady] = useState(false);

  useEffect(() => {
    markAtmMigrationApplied(storageNamespace);
  }, [storageNamespace]);

  useEffect(() => {
    markPhoneBoothMigrationApplied(storageNamespace);
  }, [storageNamespace]);

  useEffect(() => {
    markSmsBoothMigrationApplied(storageNamespace);
  }, [storageNamespace]);

  useEffect(() => {
    markServerRoomMigrationApplied(storageNamespace);
  }, [storageNamespace]);

  useEffect(() => {
    markGymRoomMigrationApplied(storageNamespace);
  }, [storageNamespace]);

  useEffect(() => {
    markQaLabMigrationApplied(storageNamespace);
  }, [storageNamespace]);

  useEffect(() => {
    followAgentIdRef.current = followAgentId;
  }, [followAgentId]);

  // Derive per-agent colors from the agents prop (stable, no state needed).
  const agentColorMap = useMemo(
    () =>
      new Map(
        [...agents, ...janitorActors].map((actor) => [actor.id, actor.color]),
      ),
    [agents, janitorActors],
  );

  const deskItems = useMemo(
    () => furniture.filter((item) => item.type === "desk_cubicle"),
    [furniture],
  );
  const deskLocations = useMemo(() => getDeskLocations(furniture), [furniture]);
  const assignedDeskIndexByAgentId = useMemo(() => {
    const next: Record<string, number> = {};
    deskItems.forEach((item, index) => {
      const agentId = deskAssignmentByDeskUid[item._uid];
      if (!agentId) return;
      next[agentId] = index;
    });
    return next;
  }, [deskAssignmentByDeskUid, deskItems]);
  const janitorCleaningStops = useMemo(
    () => getJanitorCleaningStops(furniture),
    [furniture],
  );
  const gymWorkoutLocations = useMemo(
    () => getGymWorkoutLocations(furniture),
    [furniture],
  );
  const qaLabStations = useMemo(() => getQaLabStations(furniture), [furniture]);
  const meetingSeatLocations = useMemo(
    () => getMeetingSeatLocations(furniture),
    [furniture],
  );

  // Keep a stable ref to furniture so the tick callback can read it without
  // being recreated every time furniture changes.
  const furnitureRef = useRef<FurnitureItem[]>(furniture);
  useEffect(() => {
    furnitureRef.current = furniture;
  }, [furniture]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      const now = Date.now();
      setJanitorActors((previous) => {
        const next = pruneExpiredJanitorActors(previous, now);
        return next.length === previous.length ? previous : next;
      });
    }, 1000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    if (resolvedCleaningCues.length === 0) return;
    const unseenCues = resolvedCleaningCues.filter(
      (cue) => !seenCleaningCueIdsRef.current.has(cue.id),
    );
    if (unseenCues.length === 0) return;
    for (const cue of unseenCues) {
      seenCleaningCueIdsRef.current.add(cue.id);
    }
    const maxSeenCueIds = Math.max(resolvedCleaningCues.length * 4, 24);
    while (seenCleaningCueIdsRef.current.size > maxSeenCueIds) {
      const oldestCueId = seenCleaningCueIdsRef.current.values().next().value;
      if (!oldestCueId) break;
      seenCleaningCueIdsRef.current.delete(oldestCueId);
    }
    const spawnedActors = unseenCues.flatMap((cue) =>
      buildJanitorActorsForCue(cue, janitorCleaningStops),
    );
    if (spawnedActors.length === 0) return;
    setJanitorActors((previous) => {
      const now = Date.now();
      return [...pruneExpiredJanitorActors(previous, now), ...spawnedActors];
    });
  }, [janitorCleaningStops, resolvedCleaningCues]);

  const sceneAgents = useMemo<SceneActor[]>(
    () => [...agents, ...janitorActors],
    [agents, janitorActors],
  );

  const {
    renderAgentsRef,
    renderAgentLookupRef,
    tick,
    deskByAgentRef,
    planPath,
  } = useAgentTick(
    sceneAgents,
    deskLocations,
    assignedDeskIndexByAgentId,
    gymWorkoutLocations,
    qaLabStations,
    meetingSeatLocations,
    furnitureRef,
    lastSeenByAgentId,
    resolvedDeskHoldByAgentId,
    resolvedDanceUntilByAgentId,
    resolvedGymHoldByAgentId,
    resolvedSmsBoothHoldByAgentId,
    resolvedPhoneBoothHoldByAgentId,
    resolvedQaHoldByAgentId,
    resolvedGithubReviewByAgentId,
    standupMeeting,
    aasMeetingSeats,
    aasGreetings,
    aasPeopleRef,
  );
  useEffect(() => {
    const syncRenderAgentUi = () => {
      const next: Record<string, RenderAgentUiSnapshot> = {};
      for (const agent of renderAgentsRef.current) {
        next[agent.id] = {
          state: agent.state,
          status: agent.status,
        };
      }
      setRenderAgentUiById(next);
    };

    syncRenderAgentUi();
    const timer = window.setInterval(syncRenderAgentUi, 250);
    return () => {
      window.clearInterval(timer);
    };
  }, [renderAgentsRef]);
  const activeMonitor = monitorAgentId
    ? (monitorByAgentId[monitorAgentId] ?? null)
    : null;
  const agentStatusLookup = useMemo(
    () =>
      agents.reduce<Record<string, { isError: boolean; working: boolean }>>(
        (acc, agent) => {
          const renderAgent = renderAgentUiById[agent.id];
          acc[agent.id] = {
            isError:
              renderAgent?.status === "error" || agent.status === "error",
            // AAS(2026-10-21-023): 대기 에이전트도 책상에 앉으므로 앉음을 일하는 중으로 보지 않는다
            working:
              renderAgent?.state === "dancing" ||
              renderAgent?.status === "working" ||
              agent.status === "working",
          };
          return acc;
        },
        {},
      ),
    [agents, renderAgentUiById],
  );
  const hoveredAgent = useMemo(
    () =>
      hoveredAgentId
        ? (agents.find((agent) => agent.id === hoveredAgentId) ?? null)
        : null,
    [agents, hoveredAgentId],
  );
  const hoveredAgentStatus = hoveredAgentId
    ? (agentStatusLookup[hoveredAgentId] ?? null)
    : null;
  const handleAgentHover = useCallback((agentId: string) => {
    setHoveredAgentId(agentId);
  }, []);
  const handleAgentUnhover = useCallback(() => {
    setHoveredAgentId(null);
  }, []);
  const handleAgentClick = useCallback(
    (agentId: string) => {
      const agent = renderAgentLookupRef.current.get(agentId);
      if (!agent || !orbitRef.current) return;
      const [wx, , wz] = toWorld(agent.x, agent.y);
      orbitRef.current.target.set(wx, 0, wz);
      orbitRef.current.update();
      onAgentChatSelect?.(agentId);
    },
    [onAgentChatSelect, renderAgentLookupRef],
  );
  // AAS: 명단·HUD 에서 온 요청(계획 007 P0). 카메라 우선순위는 사용자 조작이 앞선다(G10) — 이 요청 자체가 사용자 조작이다.
  useEffect(() => {
    if (!focusRequest) return;
    // 점 요청(상태판 회의실 행)과 zoom 요청(명단 행)은 가구를 두 번 누를 때와 같은 focusPreset 으로 각도를 지킨 채 그 자리로 옮기고 확대한다.
    // 목표만 옮기면 카메라 자리가 그대로라 먼 방은 비스듬히 내려다보고 화면 가운데에 오지 않았다(스펙 2026-10-20-021 화면 확인).
    // 명단 행도 예전에는 목표만 옮겨 확대 없이 화면이 조금 밀리기만 했다(스펙 2026-10-21-004). 첫 방문 안내·회의 발언자는 그대로 목표만 옮긴다
    const orbit = orbitRef.current;
    if (!orbit?.object) return;
    const spot = focusRequest.at ?? renderAgentLookupRef.current.get(focusRequest.id);
    if (!spot) return;
    const [px, , pz] = toWorld(spot.x, spot.y);
    if (!focusRequest.at && !focusRequest.zoom) {
      orbit.target.set(px, 0, pz);
      orbit.update();
      return;
    }
    const cam = orbit.object.position;
    // 가구 확대(FOCUS_ZOOM)보다 더 가까이 본다 — 회의실은 방이 화면에 들어오게, 에이전트는 사람이 크게 보이게(2026-10-21)
    const zoom = focusRequest.at ? ROOM_FOCUS_ZOOM : AGENT_FOCUS_ZOOM;
    cameraPresetRef.current = focusPreset([px, 0, pz], [cam.x, cam.y, cam.z], [orbit.target.x, orbit.target.y, orbit.target.z], zoom);
  }, [focusRequest, renderAgentLookupRef]);
  // AAS(스펙 2026-10-21-012 §3-4): 상태판에서 고른 에이전트·회의실을 2.5초 동안 표시한다. 카메라만 옮기면 확대한 화면의 어느 것을 골랐는지 몰랐다.
  // 시작 시각(performance.now)을 넘기고 표시 값은 각 객체의 useFrame 이 계산한다. 새 요청이 오면 앞 표시는 바로 바뀐다
  const [aasHighlight, setAasHighlight] = useState<{ target: string; at: number } | null>(null);
  useEffect(() => {
    if (!focusRequest?.highlight) return;
    setAasHighlight({ target: focusRequest.highlight, at: performance.now() });
    const id = window.setTimeout(() => setAasHighlight(null), HIGHLIGHT_MS);
    return () => window.clearTimeout(id);
  }, [focusRequest]);
  // AAS: 카메라 조작 단추(스펙 2026-10-21-006). 진행 중인 프리셋이 있으면 그 끝을 기준으로 계산한다 —
  // 애니메이터는 매 프레임 조금씩 다가가므로 지금 카메라를 기준으로 하면 빠르게 두 번 눌러도 한 번 남짓만 움직인다.
  // 처음 구도(overviewPreset)는 아래에서 정해져 ref 로 읽는다.
  useEffect(() => {
    if (!cameraCommand) return;
    if (cameraCommand.kind === "reset") {
      cameraPresetRef.current = overviewPresetRef.current;
      return;
    }
    const orbit = orbitRef.current;
    const camera = orbit?.object;
    if (!orbit || !(camera instanceof THREE.OrthographicCamera)) return;
    const pending = cameraPresetRef.current;
    const pos: [number, number, number] = pending?.pos ?? [camera.position.x, camera.position.y, camera.position.z];
    const target: [number, number, number] = pending?.target ?? [orbit.target.x, orbit.target.y, orbit.target.z];
    cameraPresetRef.current = nudgePreset(cameraCommand.kind, pos, target, pending?.zoom ?? camera.zoom);
  }, [cameraCommand]);
  useEffect(() => {
    if (controlledFollowAgentId !== undefined) setFollowAgentId(controlledFollowAgentId);
  }, [controlledFollowAgentId]);
  const handleAgentContextMenu = useCallback(
    (agentId: string, x: number, y: number) => {
      if (isRemoteOfficeAgentId(agentId)) return;
      setContextMenu({ id: agentId, x, y });
    },
    [],
  );
  const monitorImmersive = Boolean(activeMonitor && monitorImmersiveReady);
  const serverTerminal = useMemo(
    () => furniture.find((item) => item.type === "server_terminal") ?? null,
    [furniture],
  );
  const qaTerminal = useMemo(
    () => furniture.find((item) => item.type === "qa_terminal") ?? null,
    [furniture],
  );
  const wallItems = useMemo(
    () => furniture.filter((item) => item.type === "wall"),
    [furniture],
  );
  const partitionItems = useMemo(() => furniture.filter((item) => item.type === "partition"), [furniture]);
  const glassItems = useMemo(() => furniture.filter((item) => item.type === "glass_wall"), [furniture]);
  const chairItems = useMemo(
    () => furniture.filter((item) => item.type === "chair"),
    [furniture],
  );
  const activeAtm = useMemo(
    () =>
      activeAtmUid
        ? (furniture.find(
            (item) => item._uid === activeAtmUid && item.type === "atm",
          ) ?? null)
        : null,
    [activeAtmUid, furniture],
  );
  const activeKanbanBoard = useMemo(
    () =>
      activeKanbanUid
        ? (furniture.find(
            (item) =>
              item._uid === activeKanbanUid && item.type === "kanban_board",
          ) ?? null)
        : null,
    [activeKanbanUid, furniture],
  );
  const kanbanBoardItem = useMemo(
    () => furniture.find((item) => item.type === "kanban_board") ?? null,
    [furniture],
  );
  const atmImmersive = Boolean(activeAtm && atmImmersiveReady);
  const activeSmsBooth = useMemo(
    () => furniture.find((item) => item.type === "sms_booth") ?? null,
    [furniture],
  );
  const activePhoneBooth = useMemo(
    () => furniture.find((item) => item.type === "phone_booth") ?? null,
    [furniture],
  );
  const effectivePhoneCallScenario =
    phoneCallScenario ??
    (manualPhoneBoothOpen ? manualPhoneCallScenario : null);
  const effectivePhoneBoothAgentId =
    phoneBoothAgentId ??
    (manualPhoneBoothOpen ? "__manual_phone_booth__" : null);
  const phoneBoothViewActive =
    manualPhoneBoothOpen ||
    Boolean(phoneBoothAgentId && phoneBoothCommandArrived);
  const activePhoneCallFlowKey = useMemo(() => {
    if (!effectivePhoneBoothAgentId || !effectivePhoneCallScenario) return null;
    return [
      effectivePhoneBoothAgentId,
      effectivePhoneCallScenario.dialNumber,
      effectivePhoneCallScenario.spokenText ?? "",
      effectivePhoneCallScenario.recipientReply ?? "",
    ].join("|");
  }, [effectivePhoneBoothAgentId, effectivePhoneCallScenario]);
  const phoneBoothImmersive = Boolean(
    activePhoneBooth &&
    effectivePhoneBoothAgentId &&
    effectivePhoneCallScenario &&
    phoneBoothViewActive &&
    phoneBoothImmersiveReady,
  );
  const effectiveTextMessageScenario =
    textMessageScenario ??
    (manualSmsBoothOpen ? manualTextMessageScenario : null);
  const effectiveSmsBoothAgentId =
    smsBoothAgentId ?? (manualSmsBoothOpen ? "__manual_sms_booth__" : null);
  const smsBoothViewActive =
    manualSmsBoothOpen || Boolean(smsBoothAgentId && smsBoothCommandArrived);
  const activeTextMessageFlowKey = useMemo(() => {
    if (!effectiveSmsBoothAgentId || !effectiveTextMessageScenario) return null;
    return [
      effectiveSmsBoothAgentId,
      effectiveTextMessageScenario.recipient,
      effectiveTextMessageScenario.messageText ?? "",
      effectiveTextMessageScenario.confirmationText ?? "",
    ].join("|");
  }, [effectiveSmsBoothAgentId, effectiveTextMessageScenario]);
  const smsBoothImmersive = Boolean(
    activeSmsBooth &&
    effectiveSmsBoothAgentId &&
    effectiveTextMessageScenario &&
    smsBoothViewActive &&
    smsBoothImmersiveReady,
  );
  const meetingTable = useMemo(
    () =>
      furniture.find(
        (item) =>
          item.type === "round_table" &&
          item.x >= 0 &&
          item.x <= 290 &&
          item.y >= 0 &&
          item.y <= 235,
      ) ?? null,
    [furniture],
  );
  const activeGithubTerminal = useMemo(
    () =>
      activeGithubTerminalUid
        ? (furniture.find(
            (item) =>
              item._uid === activeGithubTerminalUid &&
              item.type === "server_terminal",
          ) ?? null)
        : serverTerminal,
    [activeGithubTerminalUid, furniture, serverTerminal],
  );
  const activeQaTerminal = useMemo(
    () =>
      activeQaTerminalUid
        ? (furniture.find(
            (item) =>
              item._uid === activeQaTerminalUid && item.type === "qa_terminal",
          ) ?? null)
        : qaTerminal,
    [activeQaTerminalUid, furniture, qaTerminal],
  );
  const [githubCommandArrived, setGithubCommandArrived] = useState(false);
  const [qaCommandArrived, setQaCommandArrived] = useState(false);
  const githubImmersive =
    Boolean(
      activeGithubTerminal &&
      (activeGithubTerminalUid ||
        (githubReviewAgentId && githubCommandArrived)),
    ) && githubImmersiveReady;
  const qaImmersive =
    Boolean(
      activeQaTerminal &&
      (activeQaTerminalUid || (qaTestingAgentId && qaCommandArrived)),
    ) && qaImmersiveReady;
  const standupImmersive = Boolean(standupBoardOpen && standupMeeting);
  const kanbanImmersive = Boolean(activeKanbanBoard);
  // AAS 에는 몰입 화면이 없다(core/overlayOnly.ts). 어떤 경로로 몰입 상태가 켜져도 3D 캔버스를 내리지 않는다.
  const immersiveOverlayActive =
    !AAS_WITHOUT_IMMERSIVE_SCREENS &&
    (monitorImmersive ||
      atmImmersive ||
      smsBoothImmersive ||
      phoneBoothImmersive ||
      githubImmersive ||
      qaImmersive ||
      standupImmersive ||
      kanbanImmersive);
  const compactRosterAgents = useMemo(
    () => agents.slice(0, COMPACT_AGENT_BADGE_LIMIT),
    [agents],
  );
  const hiddenAgentCount = Math.max(
    0,
    agents.length - compactRosterAgents.length,
  );
  const standupActive =
    standupMeeting?.phase === "gathering" ||
    standupMeeting?.phase === "in_progress";
  const standupSpeakerCard =
    standupMeeting?.cards.find(
      (card) => card.agentId === standupMeeting.currentSpeakerAgentId,
    ) ?? null;
  const activeMonitorComputer = useMemo(() => {
    if (!monitorAgentId) return null;
    const deskIdx = assignedDeskIndexByAgentId[monitorAgentId];
    if (typeof deskIdx !== "number") return null;
    const computerItems = furniture.filter((item) => item.type === "computer");
    return (
      computerItems.find(
        (item) => resolveDeskIndexForItem(item, deskLocations) === deskIdx,
      ) ?? null
    );
  }, [assignedDeskIndexByAgentId, deskLocations, furniture, monitorAgentId]);
  const agentRosterVisible = agentRosterOpen && !immersiveOverlayActive;
  const selectedItem = useMemo(
    () => furniture.find((item) => item._uid === selectedUid) ?? null,
    [furniture, selectedUid],
  );
  const selectedDeskAssignmentAgentId =
    selectedItem?.type === "desk_cubicle"
      ? (deskAssignmentByDeskUid[selectedItem._uid] ?? "")
      : "";
  const selectedDeskActionItem = useMemo(
    () =>
      deskActionUid
        ? (furniture.find(
            (item) => item._uid === deskActionUid && item.type === "desk_cubicle",
          ) ?? null)
        : null,
    [deskActionUid, furniture],
  );
  const selectedDeskActionAssignedAgentId =
    selectedDeskActionItem ? (deskAssignmentByDeskUid[selectedDeskActionItem._uid] ?? "") : "";
  const selectedDeskActionAssignedAgent = useMemo(
    () =>
      selectedDeskActionAssignedAgentId
        ? (agents.find((agent) => agent.id === selectedDeskActionAssignedAgentId) ?? null)
        : null,
    [agents, selectedDeskActionAssignedAgentId],
  );

  useEffect(() => {
    if (serverMode) return undefined;                // AAS: 서버 레이아웃이면 브라우저에 저장하지 않는다
    const timeoutId = window.setTimeout(() => {
      saveFurniture(furniture, storageNamespace);
    }, 300);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [furniture, storageNamespace, serverMode]);

  // claw3d: 레이아웃을 게이트웨이로 올리던 효과는 가져오지 않았다.

  useEffect(() => {
    if (followAgentId && monitorAgentId) {
      const timer = window.setTimeout(() => {
        setFollowAgentId(null);
      }, 0);
      return () => {
        window.clearTimeout(timer);
      };
    }
  }, [followAgentId, monitorAgentId]);

  useEffect(() => {
    if (followAgentId && activeAtmUid) {
      const timer = window.setTimeout(() => {
        setFollowAgentId(null);
      }, 0);
      return () => {
        window.clearTimeout(timer);
      };
    }
  }, [activeAtmUid, followAgentId]);

  useEffect(() => {
    if (followAgentId && smsBoothAgentId) {
      const timer = window.setTimeout(() => {
        setFollowAgentId(null);
      }, 0);
      return () => {
        window.clearTimeout(timer);
      };
    }
  }, [followAgentId, smsBoothAgentId]);

  useEffect(() => {
    if (followAgentId && phoneBoothAgentId) {
      const timer = window.setTimeout(() => {
        setFollowAgentId(null);
      }, 0);
      return () => {
        window.clearTimeout(timer);
      };
    }
  }, [followAgentId, phoneBoothAgentId]);

  useEffect(() => {
    if (manualSmsBoothOpen && smsBoothAgentId) {
      const timer = window.setTimeout(() => {
        setManualSmsBoothOpen(false);
        setManualTextMessageScenario(null);
      }, 0);
      return () => {
        window.clearTimeout(timer);
      };
    }
  }, [manualSmsBoothOpen, smsBoothAgentId]);

  useEffect(() => {
    if (manualPhoneBoothOpen && phoneBoothAgentId) {
      const timer = window.setTimeout(() => {
        setManualPhoneBoothOpen(false);
        setManualPhoneCallScenario(null);
      }, 0);
      return () => {
        window.clearTimeout(timer);
      };
    }
  }, [manualPhoneBoothOpen, phoneBoothAgentId]);

  useEffect(() => {
    effectiveSmsBoothAgentIdRef.current = effectiveSmsBoothAgentId;
    effectiveTextMessageScenarioRef.current = effectiveTextMessageScenario;
    smsBoothAgentIdRef.current = smsBoothAgentId;
    onTextMessageCompleteRef.current = onTextMessageComplete;
    effectivePhoneBoothAgentIdRef.current = effectivePhoneBoothAgentId;
    effectivePhoneCallScenarioRef.current = effectivePhoneCallScenario;
    phoneBoothAgentIdRef.current = phoneBoothAgentId;
    onPhoneCallSpeakRef.current = onPhoneCallSpeak;
    onPhoneCallCompleteRef.current = onPhoneCallComplete;
    onStandupArrivalsChangeRef.current = onStandupArrivalsChange;
  }, [
    effectiveSmsBoothAgentId,
    effectiveTextMessageScenario,
    onTextMessageComplete,
    smsBoothAgentId,
    effectivePhoneBoothAgentId,
    effectivePhoneCallScenario,
    onPhoneCallComplete,
    onPhoneCallSpeak,
    onStandupArrivalsChange,
    phoneBoothAgentId,
  ]);

  const closeManualPhoneBoothView = useCallback(() => {
    activePhoneCallFlowKeyRef.current = null;
    setManualPhoneBoothOpen(false);
    setManualPhoneCallScenario(null);
    setPhoneBoothImmersiveReady(false);
    setPhoneBoothDoorOpen(false);
    setPhoneBoothCommandArrived(false);
    setPhoneCallStep("dialing");
    setDialedDigits("");
    if (
      !followAgentId &&
      !monitorAgentId &&
      !activeAtmUid &&
      !activeGithubTerminalUid &&
      !activeQaTerminalUid
    ) {
      cameraPresetRef.current = overviewPreset;
    }
  }, [
    activeAtmUid,
    activeGithubTerminalUid,
    activeQaTerminalUid,
    followAgentId,
    monitorAgentId,
    overviewPreset,
  ]);

  const closeManualSmsBoothView = useCallback(() => {
    activeTextMessageFlowKeyRef.current = null;
    setManualSmsBoothOpen(false);
    setManualTextMessageScenario(null);
    setSmsBoothImmersiveReady(false);
    setSmsBoothDoorOpen(false);
    setSmsBoothCommandArrived(false);
    setTextMessageStep("selecting_contact");
    setTypedMessageText("");
    setActiveTextKey(null);
    setTextContacts([]);
    setActiveTextContactIndex(null);
    if (
      !followAgentId &&
      !monitorAgentId &&
      !activeAtmUid &&
      !activeGithubTerminalUid &&
      !activeQaTerminalUid
    ) {
      cameraPresetRef.current = overviewPreset;
    }
  }, [
    activeAtmUid,
    activeGithubTerminalUid,
    activeQaTerminalUid,
    followAgentId,
    monitorAgentId,
    overviewPreset,
  ]);

  const getBoothAudioContext = useCallback(async () => {
    if (typeof window === "undefined") return null;
    const AudioContextCtor =
      window.AudioContext ||
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((window as any).webkitAudioContext as typeof AudioContext | undefined);
    if (!AudioContextCtor) return null;
    if (!boothAudioCtxRef.current) {
      boothAudioCtxRef.current = new AudioContextCtor();
    }
    if (boothAudioCtxRef.current.state === "suspended") {
      await boothAudioCtxRef.current.resume();
    }
    return boothAudioCtxRef.current;
  }, []);

  const playPhoneKeyTone = useCallback(async () => {
    const audioContext = await getBoothAudioContext();
    if (!audioContext) return;
    const now = audioContext.currentTime;
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    oscillator.type = "square";
    oscillator.frequency.setValueAtTime(1320, now);
    gainNode.gain.setValueAtTime(0.0001, now);
    gainNode.gain.exponentialRampToValueAtTime(0.028, now + 0.006);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.09);
  }, [getBoothAudioContext]);

  const playTextKeyTone = useCallback(
    async (options?: {
      frequency?: number;
      durationMs?: number;
      gain?: number;
    }) => {
      const audioContext = await getBoothAudioContext();
      if (!audioContext) return;
      const now = audioContext.currentTime;
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();
      const frequency = options?.frequency ?? 920;
      const duration = (options?.durationMs ?? 58) / 1000;
      const peakGain = options?.gain ?? 0.018;
      oscillator.type = "triangle";
      oscillator.frequency.setValueAtTime(frequency, now);
      gainNode.gain.setValueAtTime(0.0001, now);
      gainNode.gain.exponentialRampToValueAtTime(peakGain, now + 0.004);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, now + duration);
      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);
      oscillator.start(now);
      oscillator.stop(now + duration + 0.01);
    },
    [getBoothAudioContext],
  );

  const playPhoneRingTone = useCallback(async () => {
    const audioContext = await getBoothAudioContext();
    if (!audioContext) return 1400;
    const now = audioContext.currentTime;
    const gainNode = audioContext.createGain();
    gainNode.gain.setValueAtTime(0.0001, now);
    gainNode.connect(audioContext.destination);

    const oscillatorA = audioContext.createOscillator();
    oscillatorA.type = "sine";
    oscillatorA.frequency.setValueAtTime(440, now);
    oscillatorA.connect(gainNode);

    const oscillatorB = audioContext.createOscillator();
    oscillatorB.type = "sine";
    oscillatorB.frequency.setValueAtTime(480, now);
    oscillatorB.connect(gainNode);

    gainNode.gain.exponentialRampToValueAtTime(0.05, now + 0.04);
    gainNode.gain.exponentialRampToValueAtTime(0.05, now + 0.44);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, now + 0.64);
    gainNode.gain.setValueAtTime(0.0001, now + 0.86);
    gainNode.gain.exponentialRampToValueAtTime(0.05, now + 0.9);
    gainNode.gain.exponentialRampToValueAtTime(0.05, now + 1.24);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, now + 1.36);

    oscillatorA.start(now);
    oscillatorB.start(now);
    oscillatorA.stop(now + 1.38);
    oscillatorB.stop(now + 1.38);
    return 1400;
  }, [getBoothAudioContext]);

  // claw3d: 음성 응답(ElevenLabs)은 가져오지 않았다. 부스 연출은 소리 없이 진행한다.
  const playBoothVoice = useCallback(async (_text: string): Promise<void> => {}, []);

  useEffect(() => {
    if (followAgentId && (activeGithubTerminalUid || githubReviewAgentId)) {
      const timer = window.setTimeout(() => {
        setFollowAgentId(null);
      }, 0);
      return () => {
        window.clearTimeout(timer);
      };
    }
  }, [activeGithubTerminalUid, followAgentId, githubReviewAgentId]);

  useEffect(() => {
    if (followAgentId && (activeQaTerminalUid || qaTestingAgentId)) {
      const timer = window.setTimeout(() => {
        setFollowAgentId(null);
      }, 0);
      return () => {
        window.clearTimeout(timer);
      };
    }
  }, [activeQaTerminalUid, followAgentId, qaTestingAgentId]);

  useEffect(() => {
    if (monitorAgentId && activeAtmUid) {
      const timer = window.setTimeout(() => {
        setActiveAtmUid(null);
      }, 0);
      return () => {
        window.clearTimeout(timer);
      };
    }
  }, [activeAtmUid, monitorAgentId]);

  useEffect(() => {
    if (monitorAgentId && activeGithubTerminalUid) {
      const timer = window.setTimeout(() => {
        setActiveGithubTerminalUid(null);
      }, 0);
      return () => {
        window.clearTimeout(timer);
      };
    }
  }, [activeGithubTerminalUid, monitorAgentId]);

  useEffect(() => {
    if (monitorAgentId && activeQaTerminalUid) {
      const timer = window.setTimeout(() => {
        setActiveQaTerminalUid(null);
      }, 0);
      return () => {
        window.clearTimeout(timer);
      };
    }
  }, [activeQaTerminalUid, monitorAgentId]);

  useEffect(() => {
    if (activeAtmUid && activeGithubTerminalUid) {
      const timer = window.setTimeout(() => {
        setActiveGithubTerminalUid(null);
      }, 0);
      return () => {
        window.clearTimeout(timer);
      };
    }
  }, [activeAtmUid, activeGithubTerminalUid]);

  useEffect(() => {
    if (activeAtmUid && activeQaTerminalUid) {
      const timer = window.setTimeout(() => {
        setActiveQaTerminalUid(null);
      }, 0);
      return () => {
        window.clearTimeout(timer);
      };
    }
  }, [activeAtmUid, activeQaTerminalUid]);

  useEffect(() => {
    if (!smsBoothAgentId) return;
    const timer = window.setTimeout(() => {
      if (activeAtmUid) {
        setActiveAtmUid(null);
      }
      if (activeGithubTerminalUid) {
        setActiveGithubTerminalUid(null);
      }
      if (activeQaTerminalUid) {
        setActiveQaTerminalUid(null);
      }
      if (monitorAgentId) {
        onMonitorSelect?.(null);
      }
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [
    activeAtmUid,
    activeGithubTerminalUid,
    activeQaTerminalUid,
    monitorAgentId,
    onMonitorSelect,
    smsBoothAgentId,
  ]);

  useEffect(() => {
    if (!phoneBoothAgentId) return;
    const timer = window.setTimeout(() => {
      if (activeAtmUid) {
        setActiveAtmUid(null);
      }
      if (activeGithubTerminalUid) {
        setActiveGithubTerminalUid(null);
      }
      if (activeQaTerminalUid) {
        setActiveQaTerminalUid(null);
      }
      if (monitorAgentId) {
        onMonitorSelect?.(null);
      }
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [
    activeAtmUid,
    activeGithubTerminalUid,
    activeQaTerminalUid,
    monitorAgentId,
    onMonitorSelect,
    phoneBoothAgentId,
  ]);

  useEffect(() => {
    if (activeGithubTerminalUid && activeQaTerminalUid) {
      const timer = window.setTimeout(() => {
        setActiveQaTerminalUid(null);
      }, 0);
      return () => {
        window.clearTimeout(timer);
      };
    }
  }, [activeGithubTerminalUid, activeQaTerminalUid]);

  useEffect(() => {
    const syncArrivalState = () => {
      const agentLookup = renderAgentLookupRef.current;

      if (!githubReviewAgentId) {
        setGithubCommandArrived(false);
      } else {
        const agent = agentLookup.get(githubReviewAgentId);
        const arrived = Boolean(
          agent &&
          Math.hypot(
            agent.x - SERVER_ROOM_TARGET.x,
            agent.y - SERVER_ROOM_TARGET.y,
          ) < 16,
        );
        setGithubCommandArrived((current) =>
          current === arrived ? current : arrived,
        );
      }

      if (!qaTestingAgentId) {
        setQaCommandArrived(false);
      } else {
        const agent = agentLookup.get(qaTestingAgentId);
        const arrived = Boolean(
          agent &&
          agent.interactionTarget === "qa_lab" &&
          agent.qaLabStage === "station" &&
          Math.hypot(agent.x - agent.targetX, agent.y - agent.targetY) < 16,
        );
        setQaCommandArrived((current) =>
          current === arrived ? current : arrived,
        );
      }

      if (!phoneBoothAgentId) {
        setPhoneBoothCommandArrived(false);
        if (!manualPhoneBoothOpen) {
          setPhoneBoothDoorOpen(false);
        }
      } else {
        const agent = agentLookup.get(phoneBoothAgentId);
        const arrived = Boolean(
          agent &&
          agent.interactionTarget === "phone_booth" &&
          agent.phoneBoothStage === "receiver" &&
          Math.hypot(agent.x - agent.targetX, agent.y - agent.targetY) < 16,
        );
        const doorOpen = Boolean(
          agent &&
          agent.interactionTarget === "phone_booth" &&
          agent.phoneBoothStage !== undefined &&
          agent.phoneBoothStage !== "door_outer",
        );
        setPhoneBoothCommandArrived((current) =>
          current === arrived ? current : arrived,
        );
        setPhoneBoothDoorOpen((current) =>
          current === doorOpen ? current : doorOpen,
        );
      }

      if (!smsBoothAgentId) {
        setSmsBoothCommandArrived(false);
        if (!manualSmsBoothOpen) {
          setSmsBoothDoorOpen(false);
        }
      } else {
        const agent = agentLookup.get(smsBoothAgentId);
        const arrived = Boolean(
          agent &&
          agent.interactionTarget === "sms_booth" &&
          agent.smsBoothStage === "typing" &&
          Math.hypot(agent.x - agent.targetX, agent.y - agent.targetY) < 16,
        );
        const doorOpen = Boolean(
          agent &&
          agent.interactionTarget === "sms_booth" &&
          agent.smsBoothStage !== undefined &&
          agent.smsBoothStage !== "door_outer",
        );
        setSmsBoothCommandArrived((current) =>
          current === arrived ? current : arrived,
        );
        setSmsBoothDoorOpen((current) =>
          current === doorOpen ? current : doorOpen,
        );
      }

      if (!standupActive || !standupMeeting) {
        const nextArrivalsKey = "";
        if (lastStandupArrivalKeyRef.current === nextArrivalsKey) return;
        lastStandupArrivalKeyRef.current = nextArrivalsKey;
        onStandupArrivalsChangeRef.current?.([]);
        return;
      }

      const arrivedParticipants = standupMeeting.participantOrder.filter(
        (agentId) => {
          const agent = agentLookup.get(agentId);
          if (!agent || agent.interactionTarget !== "meeting_room")
            return false;
          return (
            Math.hypot(agent.x - agent.targetX, agent.y - agent.targetY) < 18
          );
        },
      );
      const nextArrivalsKey = arrivedParticipants.join("|");
      if (lastStandupArrivalKeyRef.current === nextArrivalsKey) return;
      lastStandupArrivalKeyRef.current = nextArrivalsKey;
      onStandupArrivalsChangeRef.current?.(arrivedParticipants);
    };

    syncArrivalState();
    const intervalId = window.setInterval(syncArrivalState, 150);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [
    githubReviewAgentId,
    manualSmsBoothOpen,
    manualPhoneBoothOpen,
    phoneBoothAgentId,
    qaTestingAgentId,
    renderAgentLookupRef,
    smsBoothAgentId,
    standupActive,
    standupMeeting,
  ]);

  useEffect(() => {
    const resetTimer = window.setTimeout(() => {
      setSmsBoothImmersiveReady(false);
    }, 0);
    if (!smsBoothViewActive || !effectiveTextMessageScenario) {
      return () => {
        window.clearTimeout(resetTimer);
      };
    }
    const timer = window.setTimeout(() => {
      setSmsBoothImmersiveReady(true);
    }, 900);
    return () => {
      window.clearTimeout(resetTimer);
      window.clearTimeout(timer);
    };
  }, [effectiveTextMessageScenario, smsBoothViewActive]);

  useEffect(() => {
    if (!smsBoothImmersive || !activeTextMessageFlowKey) {
      activeTextMessageFlowKeyRef.current = null;
      const timer = window.setTimeout(() => {
        setTextMessageStep("selecting_contact");
        setTypedMessageText("");
        setActiveTextKey(null);
        setTextContacts([]);
        setActiveTextContactIndex(null);
      }, 0);
      return () => {
        window.clearTimeout(timer);
      };
    }
    if (activeTextMessageFlowKeyRef.current === activeTextMessageFlowKey) {
      return;
    }
    activeTextMessageFlowKeyRef.current = activeTextMessageFlowKey;
    const scenario = effectiveTextMessageScenarioRef.current;
    if (!scenario?.messageText?.trim()) {
      return;
    }
    const { contacts, targetIndex } = buildSmsContactList(scenario.recipient);
    const initTimer = window.setTimeout(() => {
      setTextMessageStep("selecting_contact");
      setTypedMessageText("");
      setActiveTextKey(null);
      setTextContacts(contacts);
      setActiveTextContactIndex(0);
    }, 0);
    let index = 0;
    let contactIndex = 0;
    let contactTimer: number | null = null;
    let typingTimer: number | null = null;
    let stageTimer: number | null = null;
    let keyResetTimer: number | null = null;

    const resolveKeyboardKey = (character: string): string | null => {
      if (!character) return null;
      if (character === " ") return "space";
      if (character === "\n") return "return";
      const normalized = character.toLowerCase();
      if (/^[a-z]$/.test(normalized)) return normalized;
      if ([",", ".", "?", "!"].includes(normalized)) return normalized;
      if (normalized === "'") return "'";
      return null;
    };

    const clearActiveKey = () => {
      if (keyResetTimer !== null) {
        window.clearTimeout(keyResetTimer);
        keyResetTimer = null;
      }
      setActiveTextKey(null);
    };

    const pulseKeyboardKey = (
      key: string,
      options?: { frequency?: number; durationMs?: number; gain?: number },
    ) => {
      setActiveTextKey(key);
      void playTextKeyTone(options);
      if (keyResetTimer !== null) {
        window.clearTimeout(keyResetTimer);
      }
      keyResetTimer = window.setTimeout(() => {
        setActiveTextKey(null);
        keyResetTimer = null;
      }, 110);
    };

    const finishTextFlow = () => {
      stageTimer = window.setTimeout(() => {
        setTextMessageStep("delivered");
        stageTimer = window.setTimeout(() => {
          setTextMessageStep("reply");
          stageTimer = window.setTimeout(() => {
            setTextMessageStep("complete");
            stageTimer = window.setTimeout(() => {
              if (smsBoothAgentIdRef.current) {
                onTextMessageCompleteRef.current?.(smsBoothAgentIdRef.current);
              } else {
                closeManualSmsBoothView();
              }
            }, 1800);
          }, 1400);
        }, 1200);
      }, 700);
    };

    const startTyping = () => {
      setTextMessageStep("composing");
      typingTimer = window.setInterval(() => {
        index += 1;
        const nextChunk = scenario.messageText?.slice(0, index) ?? "";
        const typedCharacter = scenario.messageText?.charAt(index - 1) ?? "";
        setTypedMessageText(nextChunk);
        const pressedKey = resolveKeyboardKey(typedCharacter);
        if (pressedKey) {
          pulseKeyboardKey(pressedKey);
        }
        if (
          index >= (scenario.messageText?.length ?? 0) &&
          typingTimer !== null
        ) {
          window.clearInterval(typingTimer);
          typingTimer = null;
          clearActiveKey();
          pulseKeyboardKey("return", {
            frequency: 760,
            durationMs: 84,
            gain: 0.022,
          });
          setTextMessageStep("sending");
          finishTextFlow();
        }
      }, 80);
    };

    const openConversation = () => {
      void playTextKeyTone({
        frequency: 1020,
        durationMs: 70,
        gain: 0.02,
      });
      stageTimer = window.setTimeout(() => {
        startTyping();
      }, 280);
    };

    if (targetIndex <= 0) {
      openConversation();
    } else {
      contactTimer = window.setInterval(() => {
        contactIndex = Math.min(contactIndex + 1, targetIndex);
        setActiveTextContactIndex(contactIndex);
        void playTextKeyTone({
          frequency: 840,
          durationMs: 42,
          gain: 0.012,
        });
        if (contactIndex >= targetIndex && contactTimer !== null) {
          window.clearInterval(contactTimer);
          contactTimer = null;
          stageTimer = window.setTimeout(() => {
            openConversation();
          }, 260);
        }
      }, 180);
    }

    return () => {
      window.clearTimeout(initTimer);
      if (contactTimer !== null) {
        window.clearInterval(contactTimer);
      }
      if (typingTimer !== null) {
        window.clearInterval(typingTimer);
      }
      clearActiveKey();
      if (stageTimer !== null) {
        window.clearTimeout(stageTimer);
      }
    };
  }, [
    activeTextMessageFlowKey,
    closeManualSmsBoothView,
    playTextKeyTone,
    smsBoothImmersive,
  ]);

  useEffect(() => {
    const activeViewKey = manualSmsBoothOpen
      ? "manual"
      : smsBoothAgentId && smsBoothCommandArrived
        ? `agent:${smsBoothAgentId}`
        : null;
    if (!activeViewKey && prevSmsBoothViewRef.current) {
      cameraPresetRef.current = overviewPreset;
    }
    if (!activeViewKey || !activeSmsBooth) {
      prevSmsBoothViewRef.current = activeViewKey;
      return;
    }
    const { width, height } = getItemBaseSize(activeSmsBooth);
    const [wx, , wz] = toWorld(
      activeSmsBooth.x + width / 2,
      activeSmsBooth.y + height / 2,
    );
    cameraPresetRef.current = {
      pos: [wx + 0.08, 1.05, wz + 0.72],
      target: [wx, 0.92, wz - 0.02],
      zoom: 228,
    };
    prevSmsBoothViewRef.current = activeViewKey;
  }, [
    activeSmsBooth,
    manualSmsBoothOpen,
    overviewPreset,
    smsBoothAgentId,
    smsBoothCommandArrived,
  ]);

  useEffect(() => {
    const resetTimer = window.setTimeout(() => {
      setPhoneBoothImmersiveReady(false);
    }, 0);
    if (!phoneBoothViewActive || !effectivePhoneCallScenario) {
      return () => {
        window.clearTimeout(resetTimer);
      };
    }
    const timer = window.setTimeout(() => {
      setPhoneBoothImmersiveReady(true);
    }, 900);
    return () => {
      window.clearTimeout(resetTimer);
      window.clearTimeout(timer);
    };
  }, [effectivePhoneCallScenario, phoneBoothViewActive]);

  useEffect(() => {
    if (!phoneBoothImmersive || !activePhoneCallFlowKey) {
      activePhoneCallFlowKeyRef.current = null;
      const timer = window.setTimeout(() => {
        setPhoneCallStep("dialing");
        setDialedDigits("");
      }, 0);
      return () => {
        window.clearTimeout(timer);
      };
    }
    if (activePhoneCallFlowKeyRef.current === activePhoneCallFlowKey) {
      return;
    }
    activePhoneCallFlowKeyRef.current = activePhoneCallFlowKey;
    const scenario = effectivePhoneCallScenarioRef.current;
    const boothAgentId = effectivePhoneBoothAgentIdRef.current;
    if (!scenario || !boothAgentId) {
      return;
    }
    const digits = scenario.dialNumber.replace(/\s+/g, "");
    const initTimer = window.setTimeout(() => {
      setPhoneCallStep("dialing");
      setDialedDigits("");
    }, 0);
    let digitIndex = 0;
    let digitTimer: number | null = null;
    let stageTimer: number | null = null;
    let cancelled = false;

    const advanceDigits = () => {
      digitTimer = window.setInterval(() => {
        digitIndex += 1;
        const nextChunk = digits.slice(0, digitIndex);
        const nextCharacter = digits[digitIndex - 1] ?? "";
        setDialedDigits(nextChunk);
        if (/\d/.test(nextCharacter)) {
          void playPhoneKeyTone();
        }
        if (digitIndex >= digits.length && digitTimer !== null) {
          window.clearInterval(digitTimer);
          digitTimer = null;
          setPhoneCallStep("ringing");
          void playPhoneRingTone().then((ringDurationMs) => {
            if (cancelled) return;
            stageTimer = window.setTimeout(() => {
              if (cancelled) return;
              setPhoneCallStep("speaking");
              if (scenario.spokenText?.trim()) {
                void playBoothVoice(scenario.spokenText);
              }
              onPhoneCallSpeakRef.current?.({
                agentId: boothAgentId,
                requestKey: `${boothAgentId}:${scenario.dialNumber}:${scenario.spokenText ?? ""}`,
                scenario,
              });
              const speechDurationMs =
                estimatePhoneSpeechDurationMs(scenario.spokenText) + 2_500;
              stageTimer = window.setTimeout(() => {
                setPhoneCallStep("reply");
                stageTimer = window.setTimeout(() => {
                  setPhoneCallStep("complete");
                  stageTimer = window.setTimeout(() => {
                    if (phoneBoothAgentIdRef.current) {
                      onPhoneCallCompleteRef.current?.(
                        phoneBoothAgentIdRef.current,
                      );
                    } else {
                      closeManualPhoneBoothView();
                    }
                  }, 2000);
                }, 1600);
              }, speechDurationMs);
            }, ringDurationMs);
          });
        }
      }, 170);
    };

    advanceDigits();
    return () => {
      window.clearTimeout(initTimer);
      cancelled = true;
      if (digitTimer !== null) {
        window.clearInterval(digitTimer);
      }
      if (stageTimer !== null) {
        window.clearTimeout(stageTimer);
      }
    };
  }, [
    activePhoneCallFlowKey,
    closeManualPhoneBoothView,
    phoneBoothImmersive,
    playBoothVoice,
    playPhoneKeyTone,
    playPhoneRingTone,
  ]);

  useEffect(() => {
    const activeViewKey = manualPhoneBoothOpen
      ? "manual"
      : phoneBoothAgentId && phoneBoothCommandArrived
        ? `agent:${phoneBoothAgentId}`
        : null;
    if (!activeViewKey && prevPhoneBoothViewRef.current) {
      cameraPresetRef.current = overviewPreset;
    }
    if (!activeViewKey || !activePhoneBooth) {
      prevPhoneBoothViewRef.current = activeViewKey;
      return;
    }
    const { width, height } = getItemBaseSize(activePhoneBooth);
    const [wx, , wz] = toWorld(
      activePhoneBooth.x + width / 2,
      activePhoneBooth.y + height / 2,
    );
    cameraPresetRef.current = {
      pos: [wx + 0.1, 1.18, wz + 0.86],
      target: [wx, 1.08, wz - 0.04],
      zoom: 210,
    };
    prevPhoneBoothViewRef.current = activeViewKey;
  }, [
    activePhoneBooth,
    manualPhoneBoothOpen,
    overviewPreset,
    phoneBoothAgentId,
    phoneBoothCommandArrived,
  ]);

  useEffect(() => {
    const resetTimer = window.setTimeout(() => {
      setMonitorImmersiveReady(false);
    }, 0);
    if (!monitorAgentId) {
      return () => {
        window.clearTimeout(resetTimer);
      };
    }
    const timer = window.setTimeout(() => {
      setMonitorImmersiveReady(true);
    }, 900);
    return () => {
      window.clearTimeout(resetTimer);
      window.clearTimeout(timer);
    };
  }, [monitorAgentId]);

  useEffect(() => {
    const resetTimer = window.setTimeout(() => {
      setAtmImmersiveReady(false);
    }, 0);
    if (!activeAtmUid) {
      return () => {
        window.clearTimeout(resetTimer);
      };
    }
    const timer = window.setTimeout(() => {
      setAtmImmersiveReady(true);
    }, 900);
    return () => {
      window.clearTimeout(resetTimer);
      window.clearTimeout(timer);
    };
  }, [activeAtmUid]);

  useEffect(() => {
    const resetTimer = window.setTimeout(() => {
      setGithubImmersiveReady(false);
    }, 0);
    const githubViewActive =
      Boolean(activeGithubTerminalUid) ||
      Boolean(githubReviewAgentId && githubCommandArrived);
    if (!githubViewActive) {
      return () => {
        window.clearTimeout(resetTimer);
      };
    }
    const timer = window.setTimeout(() => {
      setGithubImmersiveReady(true);
    }, 900);
    return () => {
      window.clearTimeout(resetTimer);
      window.clearTimeout(timer);
    };
  }, [activeGithubTerminalUid, githubCommandArrived, githubReviewAgentId]);

  useEffect(() => {
    const resetTimer = window.setTimeout(() => {
      setQaImmersiveReady(false);
    }, 0);
    const qaViewActive =
      Boolean(activeQaTerminalUid) ||
      Boolean(qaTestingAgentId && qaCommandArrived);
    if (!qaViewActive) {
      return () => {
        window.clearTimeout(resetTimer);
      };
    }
    const timer = window.setTimeout(() => {
      setQaImmersiveReady(true);
    }, 900);
    return () => {
      window.clearTimeout(resetTimer);
      window.clearTimeout(timer);
    };
  }, [activeQaTerminalUid, qaCommandArrived, qaTestingAgentId]);

  useEffect(() => {
    if (!standupMeeting) {
      const timer = window.setTimeout(() => {
        setStandupBoardOpen(false);
      }, 0);
      autoOpenedStandupIdRef.current = null;
      return () => {
        window.clearTimeout(timer);
      };
    }
    const everyoneArrived =
      standupMeeting.participantOrder.length > 0 &&
      standupMeeting.participantOrder.every((agentId) =>
        standupMeeting.arrivedAgentIds.includes(agentId),
      );
    if (
      !standupAutoOpenBoard ||
      standupMeeting.phase !== "in_progress" ||
      !everyoneArrived ||
      autoOpenedStandupIdRef.current === standupMeeting.id
    ) {
      return;
    }
    autoOpenedStandupIdRef.current = standupMeeting.id;
    if (meetingTable) {
      const radius = meetingTable.r ?? 60;
      const centerX = meetingTable.x + radius;
      const centerY = meetingTable.y + radius;
      const [wx, , wz] = toWorld(centerX, centerY);
      cameraPresetRef.current = {
        pos: [wx + 1.8, 1.35, wz + 1.55],
        target: [wx, 0.62, wz],
        zoom: 180,
      };
    }
    const timer = window.setTimeout(() => {
      setStandupBoardOpen(true);
    }, 900);
    return () => {
      window.clearTimeout(timer);
    };
  }, [meetingTable, standupAutoOpenBoard, standupMeeting]);

  useEffect(() => {
    if (!monitorAgentId && prevMonitorAgentIdRef.current) {
      cameraPresetRef.current = overviewPreset;
    }
    if (!monitorAgentId || !activeMonitorComputer) {
      prevMonitorAgentIdRef.current = monitorAgentId;
      return;
    }
    const [wx, , wz] = toWorld(
      activeMonitorComputer.x,
      activeMonitorComputer.y,
    );
    cameraPresetRef.current = {
      pos: [wx + 0.004, 0.835, wz + 0.135],
      target: [wx + 0.002, 0.81, wz - 0.055],
      zoom: 330,
    };
    prevMonitorAgentIdRef.current = monitorAgentId;
  }, [activeMonitorComputer, monitorAgentId, overviewPreset]);

  useEffect(() => {
    if (activeAtmUid && !activeAtm) {
      const timer = window.setTimeout(() => {
        setActiveAtmUid(null);
      }, 0);
      return () => {
        window.clearTimeout(timer);
      };
    }
  }, [activeAtm, activeAtmUid, overviewPreset]);

  useEffect(() => {
    if (activeKanbanUid && !activeKanbanBoard) {
      const timer = window.setTimeout(() => {
        setActiveKanbanUid(null);
      }, 0);
      return () => {
        window.clearTimeout(timer);
      };
    }
  }, [activeKanbanBoard, activeKanbanUid]);

  useEffect(() => {
    if (activeGithubTerminalUid && !activeGithubTerminal) {
      const timer = window.setTimeout(() => {
        setActiveGithubTerminalUid(null);
      }, 0);
      return () => {
        window.clearTimeout(timer);
      };
    }
  }, [activeGithubTerminal, activeGithubTerminalUid]);

  useEffect(() => {
    if (activeQaTerminalUid && !activeQaTerminal) {
      const timer = window.setTimeout(() => {
        setActiveQaTerminalUid(null);
      }, 0);
      return () => {
        window.clearTimeout(timer);
      };
    }
  }, [activeQaTerminal, activeQaTerminalUid]);

  useEffect(() => {
    if (!activeAtmUid && prevAtmUidRef.current) {
      cameraPresetRef.current = overviewPreset;
    }
    if (!activeAtmUid || !activeAtm) {
      prevAtmUidRef.current = activeAtmUid;
      return;
    }
    const { width, height } = getItemBaseSize(activeAtm);
    const [wx, , wz] = toWorld(
      activeAtm.x + width / 2,
      activeAtm.y + height / 2,
    );
    const frontVector = new THREE.Vector3(0, 0, 1).applyAxisAngle(
      new THREE.Vector3(0, 1, 0),
      getItemRotationRadians(activeAtm),
    );
    cameraPresetRef.current = {
      pos: [wx + frontVector.x * 0.72, 0.86, wz + frontVector.z * 0.72],
      target: [wx + frontVector.x * 0.02, 0.72, wz + frontVector.z * 0.02],
      zoom: 250,
    };
    prevAtmUidRef.current = activeAtmUid;
  }, [activeAtm, activeAtmUid, overviewPreset]);

  useEffect(() => {
    prevKanbanUidRef.current = activeKanbanUid;
  }, [activeKanbanUid]);

  useEffect(() => {
    const activeViewKey = activeGithubTerminalUid
      ? `manual:${activeGithubTerminalUid}`
      : githubReviewAgentId && githubCommandArrived
        ? `agent:${githubReviewAgentId}`
        : null;
    if (!activeViewKey && prevGithubViewRef.current) {
      cameraPresetRef.current = overviewPreset;
    }
    if (!activeViewKey || !activeGithubTerminal) {
      prevGithubViewRef.current = activeViewKey;
      return;
    }
    const { width, height } = getItemBaseSize(activeGithubTerminal);
    const [wx, , wz] = toWorld(
      activeGithubTerminal.x + width / 2,
      activeGithubTerminal.y + height / 2,
    );
    const frontVector = new THREE.Vector3(0, 0, 1).applyAxisAngle(
      new THREE.Vector3(0, 1, 0),
      getItemRotationRadians(activeGithubTerminal),
    );
    cameraPresetRef.current = {
      pos: [wx + frontVector.x * 0.74, 0.9, wz + frontVector.z * 0.74],
      target: [wx + frontVector.x * 0.04, 0.74, wz + frontVector.z * 0.04],
      zoom: 260,
    };
    prevGithubViewRef.current = activeViewKey;
  }, [
    activeGithubTerminal,
    activeGithubTerminalUid,
    githubCommandArrived,
    githubReviewAgentId,
    overviewPreset,
  ]);

  useEffect(() => {
    const activeViewKey = activeQaTerminalUid
      ? `manual:${activeQaTerminalUid}`
      : qaTestingAgentId && qaCommandArrived
        ? `agent:${qaTestingAgentId}`
        : null;
    if (!activeViewKey && prevQaViewRef.current) {
      cameraPresetRef.current = overviewPreset;
    }
    if (!activeViewKey || !activeQaTerminal) {
      prevQaViewRef.current = activeViewKey;
      return;
    }
    const { width, height } = getItemBaseSize(activeQaTerminal);
    const [wx, , wz] = toWorld(
      activeQaTerminal.x + width / 2,
      activeQaTerminal.y + height / 2,
    );
    const frontVector = new THREE.Vector3(0, 0, 1).applyAxisAngle(
      new THREE.Vector3(0, 1, 0),
      getItemRotationRadians(activeQaTerminal),
    );
    cameraPresetRef.current = {
      pos: [wx + frontVector.x * 0.8, 0.92, wz + frontVector.z * 0.8],
      target: [wx + frontVector.x * 0.04, 0.74, wz + frontVector.z * 0.04],
      zoom: 245,
    };
    prevQaViewRef.current = activeViewKey;
  }, [
    activeQaTerminal,
    activeQaTerminalUid,
    overviewPreset,
    qaCommandArrived,
    qaTestingAgentId,
  ]);

  // --- Interaction ---
  const handleFurniturePointerDown = useCallback(
    (uid: string) => {
      if (!editMode) return;
      if (drag.kind === "placing") return;
      setSelectedUid(uid);
      setDrawerOpen(false);
      setDrag({ kind: "moving", uid });
    },
    [drag.kind, editMode],
  );

  const resolveAgentIdForDeskItem = useCallback(
    (uid: string) => {
      const item = furniture.find((entry) => entry._uid === uid);
      if (!item) return null;
      const deskIdx = resolveDeskIndexForItem(
        item,
        getDeskLocations(furniture),
      );
      if (deskIdx < 0) return null;
      for (const [id, index] of deskByAgentRef.current) {
        if (index === deskIdx) return id;
      }
      return null;
    },
    [deskByAgentRef, furniture],
  );

  const openKanbanBoard = useCallback(
    (item: FurnitureItem | null) => {
      if (!item || item.type !== "kanban_board") return;
      if (!taskManagerEnabled) {
        setActiveKanbanUid(null);
        onKanbanInteract?.();
        return;
      }
      setFollowAgentId(null);
      setActiveAtmUid(null);
      setActiveGithubTerminalUid(null);
      setActiveQaTerminalUid(null);
      if (manualSmsBoothOpen) {
        closeManualSmsBoothView();
      }
      if (manualPhoneBoothOpen) {
        closeManualPhoneBoothView();
      }
      onMonitorSelect?.(null);
      setActiveKanbanUid(item._uid);
    },
    [
      closeManualPhoneBoothView,
      closeManualSmsBoothView,
      manualPhoneBoothOpen,
      manualSmsBoothOpen,
      onMonitorSelect,
      onKanbanInteract,
      taskManagerEnabled,
    ],
  );

  // E3 Idea 2: click a desk to send its assigned agent to walk and sit there.
  const handleDeskClick = useCallback(
    (uid: string) => {
      if (editMode) return;
      const item = furniture.find((f) => f._uid === uid);
      if (!item) return;
      lastClickedItemRef.current = { uid, t: Date.now() };
      if (item.type !== "desk_cubicle") {
        setDeskActionUid(null);
        setDeskAssignPickerOpen(false);
      }
      if (item.type !== "kanban_board" && activeKanbanUid) {
        setActiveKanbanUid(null);
      }
      if (item.type !== "sms_booth" && manualSmsBoothOpen) {
        closeManualSmsBoothView();
      }
      if (item.type !== "phone_booth" && manualPhoneBoothOpen) {
        closeManualPhoneBoothView();
      }
      if (item.type === "tv_meeting" && onMeetingScreenSelect) {
        onMeetingScreenSelect(uid);
        return;
      }
      if (isOverlayOnlyType(item.type)) {
        // AAS: 몰입 화면은 열지 않고(장면이 비지 않게), 잇는 장치만 바깥에 알린다(계획 007 P5)
        const device = aasDeviceOf(item.type);
        if (device) onDeviceSelect?.(device);
        return;
      }
      if (item.type === "pingpong") {
        const now = Date.now();
        const [tableWx, , tableWz] = toWorld(
          item.x + (item.w ?? 100) / 2,
          item.y + (item.h ?? 60) / 2,
        );
        setFollowAgentId(null);
        setActiveAtmUid(null);
        onMonitorSelect?.(null);
        cameraPresetRef.current = {
          pos: [tableWx + 2.4, 2.8, tableWz + 2.1],
          target: [tableWx, 0.45, tableWz],
          zoom: 105,
        };
        const targets = resolvePingPongTargets(item);
        const activePlayers = [...renderAgentsRef.current]
          .filter((agent) => agent.pingPongTableUid === item._uid)
          .sort(
            (left, right) =>
              (left.pingPongSide ?? 0) - (right.pingPongSide ?? 0),
          );
        const availableAgents =
          activePlayers.length === 2
            ? activePlayers
            : [...renderAgentsRef.current]
                .filter(
                  (agent) =>
                    agent.status === "idle" &&
                    agent.state !== "walking" &&
                    agent.pingPongUntil === undefined,
                )
                .sort((left, right) => {
                  const leftDistance = Math.hypot(
                    left.x - (item.x + (item.w ?? 100) / 2),
                    left.y - (item.y + (item.h ?? 60) / 2),
                  );
                  const rightDistance = Math.hypot(
                    right.x - (item.x + (item.w ?? 100) / 2),
                    right.y - (item.y + (item.h ?? 60) / 2),
                  );
                  return leftDistance - rightDistance;
                })
                .slice(0, 2);
        if (availableAgents.length < 2) return;
        availableAgents.forEach((agent, index) => {
          const target = targets[index];
          if (!target) return;
          Object.assign(agent, {
            targetX: target.x,
            targetY: target.y,
            path: planPath(agent.x, agent.y, target.x, target.y),
            facing: target.facing,
            state: "walking",
            walkSpeed: Math.max(agent.walkSpeed, PING_PONG_APPROACH_SPEED),
            pingPongUntil: now + PING_PONG_SESSION_MS,
            pingPongTargetX: target.x,
            pingPongTargetY: target.y,
            pingPongFacing: target.facing,
            pingPongPartnerId: availableAgents[1 - index]?.id,
            pingPongTableUid: item._uid,
            pingPongSide: index as 0 | 1,
            pingPongPreviousWalkSpeed:
              agent.pingPongPreviousWalkSpeed ?? agent.walkSpeed,
          } satisfies Partial<RenderAgent>);
        });
        setMoodByAgentId((prev) => {
          const next = { ...prev };
          for (const agent of availableAgents) {
            next[agent.id] = { emoji: "🏓", ts: now };
          }
          return next;
        });
        window.setTimeout(() => {
          setMoodByAgentId((prev) => {
            const next = { ...prev };
            for (const agent of availableAgents) {
              if (next[agent.id]?.emoji === "🏓") delete next[agent.id];
            }
            return next;
          });
        }, 3_500);
        return;
      }
      if (item.type === "atm") {
        setFollowAgentId(null);
        setActiveKanbanUid(null);
        setActiveGithubTerminalUid(null);
        setActiveQaTerminalUid(null);
        onMonitorSelect?.(null);
        setActiveAtmUid(uid);
        return;
      }
      if (item.type === "sms_booth") {
        setFollowAgentId(null);
        setActiveKanbanUid(null);
        setActiveAtmUid(null);
        setActiveGithubTerminalUid(null);
        setActiveQaTerminalUid(null);
        onMonitorSelect?.(null);
        setSmsBoothCommandArrived(true);
        setSmsBoothDoorOpen(true);
        setManualTextMessageScenario(
          buildMockTextMessageScenario({
            recipient: "Joseph",
            message: "I will be late for the soccer game.",
          }),
        );
        setManualSmsBoothOpen(true);
        return;
      }
      if (item.type === "phone_booth") {
        setFollowAgentId(null);
        setActiveKanbanUid(null);
        setActiveAtmUid(null);
        setActiveGithubTerminalUid(null);
        setActiveQaTerminalUid(null);
        onMonitorSelect?.(null);
        setPhoneBoothCommandArrived(true);
        setPhoneBoothDoorOpen(true);
        setManualPhoneCallScenario(
          buildMockPhoneCallScenario({
            callee: "my contact",
            message: "This is a demo call from the OpenClaw phone booth.",
            voiceAvailable:
              voiceRepliesLoaded &&
              Boolean(voiceRepliesVoiceId) &&
              voiceRepliesEnabled,
          }),
        );
        setManualPhoneBoothOpen(true);
        return;
      }
      if (item.type === "server_terminal") {
        setFollowAgentId(null);
        setActiveKanbanUid(null);
        setActiveAtmUid(null);
        setActiveQaTerminalUid(null);
        onMonitorSelect?.(null);
        setActiveGithubTerminalUid(uid);
        return;
      }
      if (item.type === "server_rack") {
        setFollowAgentId(null);
        setActiveKanbanUid(null);
        setActiveAtmUid(null);
        setActiveQaTerminalUid(null);
        onMonitorSelect?.(null);
        setActiveGithubTerminalUid(serverTerminal?._uid ?? uid);
        return;
      }
      if (
        item.type === "qa_terminal" ||
        item.type === "device_rack" ||
        item.type === "test_bench"
      ) {
        setFollowAgentId(null);
        setActiveKanbanUid(null);
        setActiveAtmUid(null);
        setActiveGithubTerminalUid(null);
        onMonitorSelect?.(null);
        setActiveQaTerminalUid(
          item.type === "qa_terminal" ? uid : (qaTerminal?._uid ?? uid),
        );
        return;
      }
      if (item.type === "kanban_board") {
        openKanbanBoard(item);
        return;
      }
      if (
        item.type === "round_table" &&
        item.x >= 0 &&
        item.x <= 290 &&
        item.y >= 0 &&
        item.y <= 235
      ) {
        onStandupStartRequested?.();
        return;
      }
      if (item.type === "computer") {
        const agentId = resolveAgentIdForDeskItem(uid);
        if (!agentId) return;
        setActiveGithubTerminalUid(null);
        setActiveQaTerminalUid(null);
        setActiveAtmUid(null);
        onMonitorSelect?.(agentId);
        return;
      }
      if (item.type !== "desk_cubicle") return;
      setDeskActionUid(item._uid);
      setDeskAssignPickerOpen(false);
    },
    [
      closeManualSmsBoothView,
      closeManualPhoneBoothView,
      editMode,
      furniture,
      manualSmsBoothOpen,
      manualPhoneBoothOpen,
      activeKanbanUid,
      openKanbanBoard,
      onMonitorSelect,
      onStandupStartRequested,
      onDeviceSelect,
      onMeetingScreenSelect,
      qaTerminal,
      resolveAgentIdForDeskItem,
      planPath,
      renderAgentsRef,
      serverTerminal,
      voiceRepliesEnabled,
      voiceRepliesLoaded,
      voiceRepliesVoiceId,
    ],
  );

  const sendAssignedAgentToDesk = useCallback(
    (deskItem: FurnitureItem) => {
      const agentId = deskAssignmentByDeskUid[deskItem._uid];
      if (!agentId) return;
      const agent = renderAgentLookupRef.current.get(agentId);
      if (!agent) return;
      const tx = deskItem.x + 40;
      const ty = deskItem.y - 5;
      const path = planPath(agent.x, agent.y, tx, ty);
      Object.assign(agent, {
        targetX: tx,
        targetY: ty,
        path,
        state: "walking",
      });
    },
    [deskAssignmentByDeskUid, planPath, renderAgentLookupRef],
  );

  const handleGoToDesk = useCallback(() => {
    if (!selectedDeskActionItem) return;
    setActiveKanbanUid(null);
    setActiveGithubTerminalUid(null);
    setActiveQaTerminalUid(null);
    setActiveAtmUid(null);
    sendAssignedAgentToDesk(selectedDeskActionItem);
    setDeskActionUid(null);
    setDeskAssignPickerOpen(false);
  }, [selectedDeskActionItem, sendAssignedAgentToDesk]);

  const handleFurniturePointerOver = useCallback(
    (uid: string) => setHoverUid(uid),
    [],
  );
  const handleFurniturePointerOut = useCallback(() => setHoverUid(null), []);
  const closeStandupBoard = useCallback(() => {
    setStandupBoardOpen(false);
    if (
      !followAgentId &&
      !monitorAgentId &&
      !activeAtmUid &&
      !activeGithubTerminalUid &&
      !activeQaTerminalUid
    ) {
      cameraPresetRef.current = overviewPreset;
    }
  }, [
    activeAtmUid,
    activeGithubTerminalUid,
    activeQaTerminalUid,
    followAgentId,
    monitorAgentId,
    overviewPreset,
  ]);

  useEffect(() => {
    const hoveredItem = hoverUid
      ? (furniture.find((item) => item._uid === hoverUid) ?? null)
      : null;
    const hoveredMeetingTable =
      hoveredItem?.type === "round_table" &&
      hoveredItem.x >= 0 &&
      hoveredItem.x <= 290 &&
      hoveredItem.y >= 0 &&
      hoveredItem.y <= 235;
    document.body.style.cursor =
      hoveredItem?.type === "pingpong" ||
      hoveredItem?.type === "atm" ||
      hoveredItem?.type === "sms_booth" ||
      hoveredItem?.type === "phone_booth" ||
      hoveredItem?.type === "server_rack" ||
      hoveredItem?.type === "qa_terminal" ||
      hoveredItem?.type === "device_rack" ||
      hoveredItem?.type === "test_bench" ||
      hoveredItem?.type === "server_terminal" ||
      hoveredItem?.type === "kanban_board" ||
      hoveredMeetingTable
        ? "pointer"
        : "";
    return () => {
      document.body.style.cursor = "";
    };
  }, [furniture, hoverUid]);

  const worldToCanvas = useCallback(
    (wx: number, wz: number) => ({
      cx: snap(Math.round((wx + CANVAS_W * SCALE * 0.5) / SCALE)),
      cy: snap(Math.round((wz + CANVAS_H * SCALE * 0.5) / SCALE)),
    }),
    [],
  );

  const wallGhostItem = useMemo(() => {
    if (drag.kind !== "placing" || drag.itemType !== "wall" || !ghostPos) {
      return null;
    }
    const { cx, cy } = worldToCanvas(ghostPos[0], ghostPos[2]);
    const start = wallDrawStart ?? { x: cx, y: cy };
    return createWallItem(start, { x: cx, y: cy }, "__wall_ghost__");
  }, [drag, ghostPos, wallDrawStart, worldToCanvas]);

  const handleFloorMove = useCallback(
    (wx: number, wz: number) => {
      if (drag.kind === "placing") setGhostPos([wx, 0, wz]);
      if (drag.kind === "moving") {
        const { cx, cy } = worldToCanvas(wx, wz);
        setFurniture((prev) =>
          prev.map((item) =>
            item._uid === drag.uid ? { ...item, x: cx, y: cy } : item,
          ),
        );
      }
    },
    [drag, worldToCanvas],
  );

  const handleFloorClick = useCallback(
    (wx: number, wz: number) => {
      if (drag.kind === "placing") {
        const { cx, cy } = worldToCanvas(wx, wz);
        if (drag.itemType === "wall") {
          if (!wallDrawStart) {
            setWallDrawStart({ x: cx, y: cy });
            setGhostPos([wx, 0, wz]);
            return;
          }
          const newWall = createWallItem(
            wallDrawStart,
            { x: cx, y: cy },
            nextUid(),
          );
          setFurniture((prev) => [...prev, newWall]);
          setSelectedUid(newWall._uid);
          setDrawerOpen(false);
          setDrag({ kind: "idle" });
          setGhostPos(null);
          setWallDrawStart(null);
          return;
        }
        const palEntry = PALETTE.find((p) => p.type === drag.itemType);
        const isCouch = drag.itemType === "couch_v";
        const newItem: FurnitureItem = {
          _uid: nextUid(),
          type: isCouch ? "couch" : drag.itemType,
          x: cx,
          y: cy,
          ...palEntry?.defaults,
          ...(isCouch ? { vertical: true, w: 40, h: 80 } : {}),
        };
        if (drag.itemType === "desk_cubicle") {
          newItem.id = `desk_${furniture.filter((i) => i.type === "desk_cubicle").length}`;
        }
        setFurniture((prev) => [...prev, newItem]);
        setSelectedUid(newItem._uid);
        setDrawerOpen(false);
        setDrag({ kind: "idle" });
        setGhostPos(null);
        setWallDrawStart(null);
      }
      if (drag.kind === "moving") setDrag({ kind: "idle" });
    },
    [drag, furniture, wallDrawStart, worldToCanvas],
  );

  const startPlacing = useCallback((type: string) => {
    setDrag({ kind: "placing", itemType: type });
    setSelectedUid(null);
    setDrawerOpen(true);
    setWallDrawStart(null);
    setGhostPos(null);
  }, []);

  const closeSelectedEditor = useCallback(() => {
    setSelectedUid(null);
    setDrag({ kind: "idle" });
    setDrawerOpen(true);
  }, []);

  const updateSelectedItem = useCallback(
    (updater: (item: FurnitureItem) => FurnitureItem) => {
      if (!selectedUid) return;
      setFurniture((prev) =>
        prev.map((item) => (item._uid === selectedUid ? updater(item) : item)),
      );
    },
    [selectedUid],
  );

  const moveSelectedItem = useCallback(
    (deltaX: number, deltaY: number, deltaElevation = 0) => {
      updateSelectedItem((item) => ({
        ...item,
        x: snap(item.x + deltaX),
        y: snap(item.y + deltaY),
        elevation: Math.max(
          -0.4,
          Math.min(2.5, (item.elevation ?? 0) + deltaElevation),
        ),
      }));
    },
    [updateSelectedItem],
  );

  const rotateSelectedItem = useCallback(
    (deltaDegrees: number) => {
      updateSelectedItem((item) => ({
        ...item,
        facing: normalizeDegrees((item.facing ?? 0) + deltaDegrees),
      }));
    },
    [updateSelectedItem],
  );

  const handleDelete = useCallback(() => {
    if (!selectedUid) return;
    const selectedDeskUid =
      selectedItem?.type === "desk_cubicle" ? selectedItem._uid : null;
    if (selectedDeskUid) {
      onDeskAssignmentChange?.(selectedDeskUid, null);
    }
    setFurniture((prev) => prev.filter((i) => i._uid !== selectedUid));
    setSelectedUid(null);
    setDrawerOpen(true);
  }, [onDeskAssignmentChange, selectedItem, selectedUid]);

  const handleReset = () => {
    if (!window.confirm("Reset the office to the default layout?")) return;
    onDeskAssignmentsReset?.(
      furniture
        .filter((item) => item.type === "desk_cubicle")
        .map((item) => item._uid),
    );
    setFurniture(materializeDefaults(layoutPreset));
    setSelectedUid(null);
    setDrag({ kind: "idle" });
    setGhostPos(null);
    setWallDrawStart(null);
  };

  // AAS: 바깥의 편집 단추를 따른다(계획 007 P7). 저장하지 않고 끄면 서버 판으로 되돌린다.
  const aasEditActive = aasEditor?.active ?? false;
  useEffect(() => {
    if (!aasEditor) return;
    if (aasEditActive !== editMode) toggleEdit();
    if (!aasEditActive && serverFurniture) setFurniture(serverFurniture);
    // 켜고 끌 때만 — toggleEdit·serverFurniture 는 렌더마다 바뀐다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aasEditActive]);
  useEffect(() => {
    if (!aasEditor) return;
    aasEditor.apiRef.current = {
      palette: PALETTE.map((p) => ({ type: p.type, label: p.label })),
      place: (type) => {
        setSelectedUid(null);
        setDrag({ kind: "placing", itemType: type });
      },
      rotate: (deg) => rotateSelectedItem(deg),
      raise: (delta) => moveSelectedItem(0, 0, delta),
      remove: () => handleDelete(),
      deselect: () => setSelectedUid(null),
      items: () => furniture,
    };
  });
  const aasOnEditorChange = aasEditor?.onChange;
  useEffect(() => {
    aasOnEditorChange?.({
      selected: selectedItem,
      dirty: Boolean(serverFurniture) && furniture !== serverFurniture,
      placing: drag.kind === "placing" ? drag.itemType : null,
    });
    // 바깥 콜백은 렌더마다 새로 만들어진다 — 장면 상태가 바뀔 때만 알린다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedItem, furniture, serverFurniture, drag]);

  const toggleEdit = () => {
    setEditMode((prev) => {
      if (prev) {
        setSelectedUid(null);
        setDrag({ kind: "idle" });
        setDrawerOpen(false);
        setHoverUid(null);
        setGhostPos(null);
        setWallDrawStart(null);
      } else {
        setDrawerOpen(true);
        setDeskActionUid(null);
        setDeskAssignPickerOpen(false);
      }
      return !prev;
    });
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (githubImmersive) {
          e.preventDefault();
          if (activeGithubTerminalUid) {
            setActiveGithubTerminalUid(null);
          } else {
            onGithubReviewDismiss?.();
          }
          return;
        }
        if (qaImmersive) {
          e.preventDefault();
          if (activeQaTerminalUid) {
            setActiveQaTerminalUid(null);
          } else {
            onQaLabDismiss?.();
          }
          return;
        }
        if (monitorImmersive) {
          e.preventDefault();
          onMonitorSelect?.(null);
          return;
        }
        if (atmImmersive) {
          e.preventDefault();
          setActiveAtmUid(null);
          return;
        }
      }
      if (!editMode) return;
      if (e.key === "Escape") {
        if (drag.kind === "placing") {
          setDrag({ kind: "idle" });
          setGhostPos(null);
          setWallDrawStart(null);
          setDrawerOpen(true);
        } else {
          setSelectedUid(null);
          setDrawerOpen(true);
        }
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedUid) {
        if (document.activeElement?.tagName === "INPUT") return;
        e.preventDefault();
        if (aasEditor && selectedItem) aasEditor.onDeleteRequest(selectedItem); // AAS: 바깥에서 확인한 뒤 지운다
        else handleDelete();
      }
      if (
        document.activeElement?.tagName === "INPUT" ||
        document.activeElement?.tagName === "TEXTAREA"
      ) {
        return;
      }
      if (selectedUid) {
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          moveSelectedItem(-SNAP_GRID, 0);
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          moveSelectedItem(SNAP_GRID, 0);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          moveSelectedItem(0, -SNAP_GRID);
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          moveSelectedItem(0, SNAP_GRID);
        } else if (e.key === "PageUp") {
          e.preventDefault();
          moveSelectedItem(0, 0, ELEVATION_STEP);
        } else if (e.key === "PageDown") {
          e.preventDefault();
          moveSelectedItem(0, 0, -ELEVATION_STEP);
        } else if (e.key === "[") {
          e.preventDefault();
          rotateSelectedItem(-ROTATION_STEP_DEG);
        } else if (e.key === "]") {
          e.preventDefault();
          rotateSelectedItem(ROTATION_STEP_DEG);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    activeQaTerminalUid,
    activeGithubTerminalUid,
    atmImmersive,
    editMode,
    drag,
    githubImmersive,
    handleDelete,
    monitorImmersive,
    moveSelectedItem,
    onGithubReviewDismiss,
    onMonitorSelect,
    onQaLabDismiss,
    qaImmersive,
    rotateSelectedItem,
    selectedUid,
    aasEditor,
    selectedItem,
  ]);

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      if (
        document.activeElement?.tagName === "INPUT" ||
        document.activeElement?.tagName === "TEXTAREA"
      )
        return;
      e.preventDefault();
      setSpaceDown(true);
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      setSpaceDown(false);
      setSpaceDragging(false);
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, []);

  // New Idea 1: dismiss context menu on outside click.
  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = () => setContextMenu(null);
    window.addEventListener("pointerdown", dismiss);
    return () => window.removeEventListener("pointerdown", dismiss);
  }, [contextMenu]);

  useEffect(() => {
    if (!deskActionUid) return;
    const dismiss = () => {
      setDeskActionUid(null);
      setDeskAssignPickerOpen(false);
    };
    window.addEventListener("pointerdown", dismiss);
    return () => window.removeEventListener("pointerdown", dismiss);
  }, [deskActionUid]);

  // New Idea 3: show speech bubble based on reply length.
  useEffect(() => {
    if (feedEvents.length === 0) return;
    const latest = feedEvents[0];
    if (!latest) return;
    if (latest.kind !== "reply") return;
    const speechBubbleDurationMs = Math.min(
      12_000,
      Math.max(5_500, 2_500 + latest.text.trim().length * 42),
    );
    const addTimer = window.setTimeout(() => {
      setSpeechAgentIds((prev) => new Set([...prev, latest.id]));
    }, 0);
    const timer = window.setTimeout(() => {
      setSpeechAgentIds((prev) => {
        const next = new Set(prev);
        next.delete(latest.id);
        return next;
      });
    }, speechBubbleDurationMs);
    return () => {
      window.clearTimeout(addTimer);
      window.clearTimeout(timer);
    };
  }, [feedEvents]);

  // E3 Idea 1: emoji mood reactions on feed events.
  useEffect(() => {
    if (feedEvents.length === 0) return;
    const latest = feedEvents[0];
    if (!latest) return;
    const emoji =
      latest.kind === "reply"
        ? "💬"
        : latest.text.includes("started")
          ? "💻"
          : "☕";
    const addTimer = window.setTimeout(() => {
      setMoodByAgentId((prev) => ({
        ...prev,
        [latest.id]: { emoji, ts: Date.now() },
      }));
    }, 0);
    const timer = window.setTimeout(() => {
      setMoodByAgentId((prev) => {
        const next = { ...prev };
        delete next[latest.id];
        return next;
      });
    }, 2500);
    return () => {
      window.clearTimeout(addTimer);
      window.clearTimeout(timer);
    };
  }, [feedEvents]);

  // E3 Idea 3: auto-clear spotlight after 2s.
  useEffect(() => {
    if (!spotlightAgentId) return;
    const timer = setTimeout(() => setSpotlightAgentId(null), 2000);
    return () => clearTimeout(timer);
  }, [spotlightAgentId]);

  const lastOfficeCenterSignalRef = useRef(officeCenterSignal);

  useEffect(() => {
    cameraPresetRef.current = overviewPreset;
    overviewPresetRef.current = overviewPreset;
  }, [overviewPreset]);

  useEffect(() => {
    if (officeCenterSignal === lastOfficeCenterSignalRef.current) return;
    lastOfficeCenterSignalRef.current = officeCenterSignal;
    cameraPresetRef.current = overviewPreset;
  }, [officeCenterSignal, overviewPreset]);

  return (
    <div ref={stageRef} style={{ position: "relative", width: "100%", height: "100%", background: aasBackdrop ?? "#1a1008", color: "#fff", overflow: "hidden" }}>
      {/* 3D Canvas — fills everything. */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          cursor: spaceDown ? (spaceDragging ? "grabbing" : "grab") : undefined,
        }}
        onMouseDown={() => {
          if (spaceDown) setSpaceDragging(true);
        }}
        onMouseUp={() => setSpaceDragging(false)}
        onDoubleClick={() => {
          // 객체를 더블클릭하면 그 객체를 중앙에 두고 조금 확대한다. 빈 곳이면 기본 구도로 돌아간다.
          // AAS: 걷기가 켜져 있으면 두 번 누르기는 내 아바타를 옮기는 데만 쓴다 — 가구로 카메라를 모으지 않는다(계획 007 P6b)
          if (aasPeople?.walk) {
            lastClickedItemRef.current = null;
            return;
          }
          const uid = recentClickUid(lastClickedItemRef.current, Date.now());
          const item = uid ? furniture.find((f) => f._uid === uid) : undefined;
          const orbit = orbitRef.current;
          if (item && orbit?.object) {
            const { width, height } = getItemBaseSize(item);
            const [wx, , wz] = toWorld(item.x + width / 2, item.y + height / 2);
            const cam = orbit.object.position;
            cameraPresetRef.current = focusPreset(
              [wx, 0, wz],
              [cam.x, cam.y, cam.z],
              [orbit.target.x, orbit.target.y, orbit.target.z],
            );
          } else if (!aasPeople?.walk) {
            // AAS: 걷기를 켜면 바닥 두 번 누르기는 내 아바타를 옮기는 데 쓴다 — 기본 구도로 돌아가지 않는다(계획 007 P6b)
            cameraPresetRef.current = overviewPreset;
          }
          lastClickedItemRef.current = null;
        }}
      >
        {/*
          Key fixes vs previous version:
          1. `orthographic` prop + `camera` prop on Canvas → R3F creates the camera
             and it defaults to looking at origin, fixing the black screen.
          2. `CameraRig` explicitly calls camera.lookAt(0,0,0) after mount for safety.
          3. `GameLoop` only calls tick() with no setState → zero React re-renders per frame.
          4. Agent components read from `renderAgentsRef` via useFrame → pure Three.js mutations.
          5. Floor/walls render immediately (no Suspense). Only GLB models are suspended.
        */}
        {!immersiveOverlayActive ? (
          <Canvas
            key={canvasResetKey}
            orthographic
            dpr={[0.85, 1.5]}
            camera={{
              position: CAM_POS,
              zoom: cameraZoom,
              near: 0.1,
              far: 100,
            }}
            shadows={{ type: THREE.PCFShadowMap }}
            gl={{ antialias: true, powerPreference: "high-performance" }}
            style={{ width: "100%", height: "100%" }}
            onPointerUp={() => {
              if (drag.kind === "moving") setDrag({ kind: "idle" });
            }}
          >
            <ScenePaletteContext.Provider value={scenePaletteValue(aasTheme)}>
            {/* Ensure camera looks at the active office target after mount. */}
            <CameraRig target={cameraTarget} />
            <AdaptiveDprController />

            {/* Orbit / pan / zoom controls — disabled while follow cam is active or while editing furniture. */}
            <OrbitControls
              ref={orbitRef}
              target={cameraTarget}
              enabled={followAgentId === null && (!editMode || spaceDown)}
              enableDamping
              dampingFactor={0.08}
              rotateSpeed={0.6}
              zoomSpeed={0.8}
              panSpeed={0.6}
              minZoom={MIN_ZOOM}
              maxZoom={MAX_ZOOM} // AAS: 90 으로 줄였다가 원본 값 120 으로 되돌렸고(2026-10-15), 더 가까이 보고 싶다는 요청으로 240 으로 올렸다(2026-10-21, 스펙 2026-10-21-006). 카메라 조작 단추와 같은 값

              maxPolarAngle={Math.PI / 2.2}
              enableRotate={!spaceDown}
              mouseButtons={{
                LEFT: spaceDown ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE,
                MIDDLE: THREE.MOUSE.DOLLY,
                RIGHT: THREE.MOUSE.PAN,
              }}
            />

            {/* Game loop — no React state, pure ref mutations. */}
            <SceneGameLoop tick={tick} />

            {/* New Idea 2: Camera preset animator. */}
            <CameraPresetAnimator
              presetRef={cameraPresetRef}
              orbitRef={orbitRef}
            />

            {/* Follow cam: third-person perspective camera trailing the selected agent. */}
            <FollowCamSystem
              followRef={followAgentIdRef}
              agentsRef={renderAgentsRef}
              agentLookupRef={renderAgentLookupRef}
            />

            {/* E3 Idea 3: Spotlight effect on agent chip click. */}
            <SceneSpotlightEffect
              agentId={spotlightAgentId}
              agentsRef={renderAgentsRef}
              agentLookupRef={renderAgentLookupRef}
            />

            {/* Keep office lighting static to avoid extra scene churn from ambience effects. */}
            {/* AAS: 조명 색·세기는 테마를 따른다(스펙 2026-10-20-012 §3-6). 보조광은 원본의 푸른 #7090ff 가 따뜻한 회색 면을 물들여 중성색으로 */}
            <ambientLight intensity={scenePalette.light.ambient.intensity} color={scenePalette.light.ambient.color} />
            <directionalLight
              position={[8, 14, 6]}
              intensity={1.1}
              color="#f6f1e6"
              castShadow
              shadow-mapSize={[1024, 1024]}
              shadow-bias={-0.0002}
              shadow-normalBias={0.02}
            />
            <directionalLight
              position={[-5, 8, -4]}
              intensity={scenePalette.light.aux.intensity}
              color={scenePalette.light.aux.color}
            />

            {/* Floor + walls — always visible, no async loading. */}
            <SceneFloorAndWalls showRemoteOffice={remoteOfficeEnabled} />

            {/* Wall pictures — procedural, no async loading. */}
            <SceneWallPictures showRemoteOffice={remoteOfficeEnabled} />

            {/* claw3d: 환경맵(HDRI)은 외부 CDN 에서 받아 에어갭에서 깨지므로 쓰지 않는다. 조명만으로 그린다. */}
            <hemisphereLight args={[scenePalette.light.hemi.sky, scenePalette.light.hemi.ground, scenePalette.light.hemi.intensity]} />

            {/* Furniture models — each loads its GLB asynchronously. */}
            <Suspense fallback={null}>
              {!editMode ? (
                <>
                  <PrimitiveInstancedWallSegmentsModel items={wallItems} />
                  <PrimitiveInstancedWallSegmentsModel items={partitionItems} height={AAS_PARTITION_HEIGHT} color={scenePalette.partition} />
                  <PrimitiveInstancedWallSegmentsModel items={glassItems} color={scenePalette.glass.color} opacity={scenePalette.glass.opacity} />
                </>
              ) : null}
              {!editMode ? (
                <InstancedFurnitureItemsModel
                  itemType="desk_cubicle"
                  items={deskItems}
                  onItemClick={handleDeskClick}
                />
              ) : null}
              {!editMode ? (
                <InstancedFurnitureItemsModel
                  itemType="chair"
                  items={chairItems}
                />
              ) : null}
              {furniture.map((item) =>
                AAS_HIDDEN_TYPES.has(item.type) ? null : AAS_WALL_LIKE.has(item.type) ? (
                  editMode ? (
                    <PrimitiveWallSegmentModel
                      key={item._uid}
                      item={item}
                      isSelected={item._uid === selectedUid}
                      isHovered={item._uid === hoverUid}
                      editMode={editMode}
                      onPointerDown={handleFurniturePointerDown}
                      onPointerOver={handleFurniturePointerOver}
                      onPointerOut={handleFurniturePointerOut}
                    />
                  ) : null
                ) : item.type === "desk_cubicle" ? (
                  editMode ? (
                    <GenericFurnitureModel
                      key={item._uid}
                      item={item}
                      isSelected={item._uid === selectedUid}
                      isHovered={item._uid === hoverUid}
                      editMode={editMode}
                      onPointerDown={handleFurniturePointerDown}
                      onPointerOver={handleFurniturePointerOver}
                      onPointerOut={handleFurniturePointerOut}
                      onClick={handleDeskClick}
                    />
                  ) : null
                ) : item.type === "chair" ? (
                  editMode ? (
                    <GenericFurnitureModel
                      key={item._uid}
                      item={item}
                      isSelected={item._uid === selectedUid}
                      isHovered={item._uid === hoverUid}
                      editMode={editMode}
                      onPointerDown={handleFurniturePointerDown}
                      onPointerOver={handleFurniturePointerOver}
                      onPointerOut={handleFurniturePointerOut}
                      onClick={handleDeskClick}
                    />
                  ) : null
                ) : item.type === "door" ? (
                  <PrimitiveDoorModel
                    key={item._uid}
                    item={item}
                    isSelected={item._uid === selectedUid}
                    isHovered={item._uid === hoverUid}
                    editMode={editMode}
                    agentsRef={renderAgentsRef}
                    peopleRef={aasPeopleRef}
                    onPointerDown={handleFurniturePointerDown}
                    onPointerOver={handleFurniturePointerOver}
                    onPointerOut={handleFurniturePointerOut}
                  />
                ) : item.type === "round_table" ? (
                  <PrimitiveRoundTableModel
                    key={item._uid}
                    item={item}
                    isSelected={item._uid === selectedUid}
                    isHovered={item._uid === hoverUid}
                    editMode={editMode}
                    onPointerDown={handleFurniturePointerDown}
                    onPointerOver={handleFurniturePointerOver}
                    onPointerOut={handleFurniturePointerOut}
                    onClick={handleDeskClick}
                  />
                ) : item.type === "keyboard" ? (
                  <PrimitiveKeyboardModel
                    key={item._uid}
                    item={item}
                    editMode={editMode}
                    onPointerDown={handleFurniturePointerDown}
                    onPointerOver={handleFurniturePointerOver}
                    onPointerOut={handleFurniturePointerOut}
                  />
                ) : item.type === "mouse" ? (
                  <PrimitiveMouseModel
                    key={item._uid}
                    item={item}
                    editMode={editMode}
                    onPointerDown={handleFurniturePointerDown}
                    onPointerOver={handleFurniturePointerOver}
                    onPointerOut={handleFurniturePointerOut}
                  />
                ) : item.type === "trash" ? (
                  <PrimitiveTrashCanModel
                    key={item._uid}
                    item={item}
                    editMode={editMode}
                    onPointerDown={handleFurniturePointerDown}
                    onPointerOver={handleFurniturePointerOver}
                    onPointerOut={handleFurniturePointerOut}
                  />
                ) : item.type === "mug" ? (
                  <PrimitiveMugModel
                    key={item._uid}
                    item={item}
                    editMode={editMode}
                    onPointerDown={handleFurniturePointerDown}
                    onPointerOver={handleFurniturePointerOver}
                    onPointerOut={handleFurniturePointerOut}
                  />
                ) : item.type === "clock" ? (
                  <PrimitiveClockModel
                    key={item._uid}
                    item={item}
                    editMode={editMode}
                    onPointerDown={handleFurniturePointerDown}
                    onPointerOver={handleFurniturePointerOver}
                    onPointerOut={handleFurniturePointerOut}
                  />
                ) : item.type === "atm" ? (
                  <InteractiveAtmMachineModel
                    key={item._uid}
                    item={item}
                    isSelected={item._uid === selectedUid}
                    isHovered={item._uid === hoverUid}
                    editMode={editMode}
                    onPointerDown={handleFurniturePointerDown}
                    onPointerOver={handleFurniturePointerOver}
                    onPointerOut={handleFurniturePointerOut}
                    onClick={handleDeskClick}
                  />
                ) : item.type === "jukebox" ? (
                  <InteractiveJukeboxModel
                    key={item._uid}
                    item={item}
                    active={isJukeboxActive}
                    enabled={soundclawEnabled}
                    isSelected={item._uid === selectedUid}
                    isHovered={item._uid === hoverUid}
                    editMode={editMode}
                    onPointerDown={handleFurniturePointerDown}
                    onPointerOver={handleFurniturePointerOver}
                    onPointerOut={handleFurniturePointerOut}
                    onClick={
                      editMode ? handleDeskClick : () => onJukeboxInteract?.()
                    }
                  />
                ) : item.type === "sms_booth" ? (
                  <InteractiveSmsBoothModel
                    key={item._uid}
                    item={item}
                    isSelected={item._uid === selectedUid}
                    isHovered={item._uid === hoverUid}
                    editMode={editMode}
                    doorOpen={smsBoothDoorOpen}
                    onPointerDown={handleFurniturePointerDown}
                    onPointerOver={handleFurniturePointerOver}
                    onPointerOut={handleFurniturePointerOut}
                    onClick={handleDeskClick}
                  />
                ) : item.type === "phone_booth" ? (
                  <InteractivePhoneBoothModel
                    key={item._uid}
                    item={item}
                    isSelected={item._uid === selectedUid}
                    isHovered={item._uid === hoverUid}
                    editMode={editMode}
                    doorOpen={phoneBoothDoorOpen}
                    onPointerDown={handleFurniturePointerDown}
                    onPointerOver={handleFurniturePointerOver}
                    onPointerOut={handleFurniturePointerOut}
                    onClick={handleDeskClick}
                  />
                ) : item.type === "server_rack" ? (
                  <InteractiveServerRackModel
                    key={item._uid}
                    item={item}
                    isSelected={item._uid === selectedUid}
                    isHovered={item._uid === hoverUid}
                    editMode={editMode}
                    onPointerDown={handleFurniturePointerDown}
                    onPointerOver={handleFurniturePointerOver}
                    onPointerOut={handleFurniturePointerOut}
                    onClick={handleDeskClick}
                  />
                ) : item.type === "server_terminal" ? (
                  <InteractiveServerTerminalModel
                    key={item._uid}
                    item={item}
                    isSelected={item._uid === selectedUid}
                    isHovered={item._uid === hoverUid}
                    editMode={editMode}
                    onPointerDown={handleFurniturePointerDown}
                    onPointerOver={handleFurniturePointerOver}
                    onPointerOut={handleFurniturePointerOut}
                    onClick={handleDeskClick}
                  />
                ) : item.type === "vending" ? (
                  <KitchenVendingMachineModel
                    key={item._uid}
                    item={item}
                    editMode={editMode}
                    onPointerDown={handleFurniturePointerDown}
                    onPointerOver={handleFurniturePointerOver}
                    onPointerOut={handleFurniturePointerOut}
                  />
                ) : item.type === "sink" ? (
                  <KitchenSinkModel
                    key={item._uid}
                    item={item}
                    editMode={editMode}
                    onPointerDown={handleFurniturePointerDown}
                    onPointerOver={handleFurniturePointerOver}
                    onPointerOut={handleFurniturePointerOut}
                  />
                ) : item.type === "dishwasher" ? (
                  <KitchenDishwasherModel
                    key={item._uid}
                    item={item}
                    editMode={editMode}
                    onPointerDown={handleFurniturePointerDown}
                    onPointerOver={handleFurniturePointerOver}
                    onPointerOut={handleFurniturePointerOut}
                  />
                ) : item.type === "pingpong" ? (
                  <MachinePingPongTableModel
                    key={item._uid}
                    item={item}
                    isSelected={item._uid === selectedUid}
                    isHovered={item._uid === hoverUid}
                    editMode={editMode}
                    onPointerDown={handleFurniturePointerDown}
                    onPointerOver={handleFurniturePointerOver}
                    onPointerOut={handleFurniturePointerOut}
                    onClick={handleDeskClick}
                  />
                ) : item.type === "qa_terminal" ? (
                  <InteractiveQaTerminalModel
                    key={item._uid}
                    item={item}
                    isSelected={item._uid === selectedUid}
                    isHovered={item._uid === hoverUid}
                    editMode={editMode}
                    onPointerDown={handleFurniturePointerDown}
                    onPointerOver={handleFurniturePointerOver}
                    onPointerOut={handleFurniturePointerOut}
                    onClick={handleDeskClick}
                  />
                ) : item.type === "device_rack" ? (
                  <InteractiveDeviceRackModel
                    key={item._uid}
                    item={item}
                    isSelected={item._uid === selectedUid}
                    isHovered={item._uid === hoverUid}
                    editMode={editMode}
                    onPointerDown={handleFurniturePointerDown}
                    onPointerOver={handleFurniturePointerOver}
                    onPointerOut={handleFurniturePointerOut}
                    onClick={handleDeskClick}
                  />
                ) : item.type === "test_bench" ? (
                  <InteractiveTestBenchModel
                    key={item._uid}
                    item={item}
                    isSelected={item._uid === selectedUid}
                    isHovered={item._uid === hoverUid}
                    editMode={editMode}
                    onPointerDown={handleFurniturePointerDown}
                    onPointerOver={handleFurniturePointerOver}
                    onPointerOut={handleFurniturePointerOut}
                    onClick={handleDeskClick}
                  />
                ) : item.type === "treadmill" ? (
                  <InteractiveTreadmillModel
                    key={item._uid}
                    item={item}
                    isSelected={item._uid === selectedUid}
                    isHovered={item._uid === hoverUid}
                    editMode={editMode}
                    onPointerDown={handleFurniturePointerDown}
                    onPointerOver={handleFurniturePointerOver}
                    onPointerOut={handleFurniturePointerOut}
                    onClick={handleDeskClick}
                  />
                ) : item.type === "weight_bench" ? (
                  <InteractiveWeightBenchModel
                    key={item._uid}
                    item={item}
                    isSelected={item._uid === selectedUid}
                    isHovered={item._uid === hoverUid}
                    editMode={editMode}
                    onPointerDown={handleFurniturePointerDown}
                    onPointerOver={handleFurniturePointerOver}
                    onPointerOut={handleFurniturePointerOut}
                    onClick={handleDeskClick}
                  />
                ) : item.type === "dumbbell_rack" ? (
                  <InteractiveDumbbellRackModel
                    key={item._uid}
                    item={item}
                    isSelected={item._uid === selectedUid}
                    isHovered={item._uid === hoverUid}
                    editMode={editMode}
                    onPointerDown={handleFurniturePointerDown}
                    onPointerOver={handleFurniturePointerOver}
                    onPointerOut={handleFurniturePointerOut}
                    onClick={handleDeskClick}
                  />
                ) : item.type === "exercise_bike" ? (
                  <InteractiveExerciseBikeModel
                    key={item._uid}
                    item={item}
                    isSelected={item._uid === selectedUid}
                    isHovered={item._uid === hoverUid}
                    editMode={editMode}
                    onPointerDown={handleFurniturePointerDown}
                    onPointerOver={handleFurniturePointerOver}
                    onPointerOut={handleFurniturePointerOut}
                    onClick={handleDeskClick}
                  />
                ) : item.type === "rowing_machine" ? (
                  <InteractiveRowingMachineModel
                    key={item._uid}
                    item={item}
                    isSelected={item._uid === selectedUid}
                    isHovered={item._uid === hoverUid}
                    editMode={editMode}
                    onPointerDown={handleFurniturePointerDown}
                    onPointerOver={handleFurniturePointerOver}
                    onPointerOut={handleFurniturePointerOut}
                    onClick={handleDeskClick}
                  />
                ) : item.type === "kettlebell_rack" ? (
                  <InteractiveKettlebellRackModel
                    key={item._uid}
                    item={item}
                    isSelected={item._uid === selectedUid}
                    isHovered={item._uid === hoverUid}
                    editMode={editMode}
                    onPointerDown={handleFurniturePointerDown}
                    onPointerOver={handleFurniturePointerOver}
                    onPointerOut={handleFurniturePointerOut}
                    onClick={handleDeskClick}
                  />
                ) : item.type === "punching_bag" ? (
                  <InteractivePunchingBagModel
                    key={item._uid}
                    item={item}
                    isSelected={item._uid === selectedUid}
                    isHovered={item._uid === hoverUid}
                    editMode={editMode}
                    onPointerDown={handleFurniturePointerDown}
                    onPointerOver={handleFurniturePointerOver}
                    onPointerOut={handleFurniturePointerOut}
                    onClick={handleDeskClick}
                  />
                ) : item.type === "yoga_mat" ? (
                  <InteractiveYogaMatModel
                    key={item._uid}
                    item={item}
                    isSelected={item._uid === selectedUid}
                    isHovered={item._uid === hoverUid}
                    editMode={editMode}
                    onPointerDown={handleFurniturePointerDown}
                    onPointerOver={handleFurniturePointerOver}
                    onPointerOut={handleFurniturePointerOut}
                    onClick={handleDeskClick}
                  />
                ) : item.type === "stove" ? (
                  <KitchenStoveModel
                    key={item._uid}
                    item={item}
                    editMode={editMode}
                    onPointerDown={handleFurniturePointerDown}
                    onPointerOver={handleFurniturePointerOver}
                    onPointerOut={handleFurniturePointerOut}
                  />
                ) : item.type === "microwave" ? (
                  <KitchenMicrowaveModel
                    key={item._uid}
                    item={item}
                    editMode={editMode}
                    onPointerDown={handleFurniturePointerDown}
                    onPointerOver={handleFurniturePointerOver}
                    onPointerOut={handleFurniturePointerOut}
                  />
                ) : item.type === "wall_cabinet" ? (
                  <KitchenWallCabinetModel
                    key={item._uid}
                    item={item}
                    editMode={editMode}
                    onPointerDown={handleFurniturePointerDown}
                    onPointerOver={handleFurniturePointerOver}
                    onPointerOut={handleFurniturePointerOut}
                  />
                ) : (
                  <GenericFurnitureModel
                    key={item._uid}
                    item={item}
                    isSelected={item._uid === selectedUid}
                    isHovered={item._uid === hoverUid}
                    editMode={editMode}
                    kanbanTaskCount={
                      item.type === "kanban_board"
                        ? kanbanDeskTaskCount
                        : undefined
                    }
                    onPointerDown={handleFurniturePointerDown}
                    onPointerOver={handleFurniturePointerOver}
                    onPointerOut={handleFurniturePointerOut}
                    onClick={handleDeskClick}
                  />
                ),
              )}
              {/* AAS(2026-10-20-012 E1): 코드로 그리는 장치·소품의 선택·호버 외곽선. emissive 강조를 대신한다 */}
              {editMode ? <PrimitiveItemSelectionOutlines furniture={furniture} selectedUid={selectedUid} hoverUid={hoverUid} /> : null}
            </Suspense>

            {remoteLayoutFurniture.length > 0 ? (
              <ReadOnlyFurnitureClone furniture={remoteLayoutFurniture} />
            ) : null}

            {/* Removed standalone Jukebox as it's now in the furniture loop */}

            {/* Agents — purely imperative, driven by renderAgentsRef inside useFrame. */}
            {sceneAgents.map((agent) => {
              const isJanitor = "role" in agent && agent.role === "janitor";
              return (
                <AgentObjectModel
                  key={agent.id}
                  agentId={agent.id}
                  name={agent.name}
                  subtitle={"subtitle" in agent ? agent.subtitle ?? null : null}
                  subtitlePinned={followAgentId === agent.id}
                  mine={"mine" in agent ? Boolean(agent.mine) : false}
                  highlightAt={aasHighlight?.target === agent.id ? aasHighlight.at : null}
                  status={agent.status}
                  color={agentColorMap.get(agent.id) ?? "#888"}
                  appearance={
                    "avatarProfile" in agent
                      ? (agent.avatarProfile ?? null)
                      : null
                  }
                  faceUrl={"faceUrl" in agent ? (agent.faceUrl ?? null) : null}
                  agentsRef={renderAgentsRef}
                  agentLookupRef={renderAgentLookupRef}
                  onHover={isJanitor ? undefined : handleAgentHover}
                  onUnhover={isJanitor ? undefined : handleAgentUnhover}
                  onClick={isJanitor ? undefined : handleAgentClick}
                  onContextMenu={isJanitor ? undefined : handleAgentContextMenu}
                  showSpeech={
                    isJanitor
                      ? false
                      : standupMeeting?.phase === "in_progress"
                        ? Boolean(standupSpeechTextByAgentId[agent.id])
                        : speechAgentIds.has(agent.id) ||
                          Boolean(streamingTextByAgentId[agent.id])
                  }
                  speechText={
                    isJanitor
                      ? null
                      : standupMeeting?.phase === "in_progress"
                        ? (standupSpeechTextByAgentId[agent.id] ?? null)
                        : (speechTextByAgentId[agent.id] ??
                            streamingTextByAgentId[agent.id] ??
                            null)
                  }
                  suppressSpeechBubble={
                    suppressSceneSpeechBubbles &&
                    standupMeeting?.currentSpeakerAgentId !== agent.id
                  }
                  onBubbleAction={isJanitor ? undefined : onAgentBubbleAction}
                  bubbleLabels={agentBubbleLabels}
                  mutterLines={isJanitor ? undefined : aasGreetings?.mutters}
                />
              );
            })}

            <ScenePingPongBall agentsRef={renderAgentsRef} />

            {/* New Idea 5: Agent color trails while walking. */}
            {trailMode ? (
              <AgentTrailSystem
                agentsRef={renderAgentsRef}
                colorMap={agentColorMap}
              />
            ) : null}

            {/* New Idea 7: Heatmap overlay when heatmap mode is active. */}
            {heatmapMode ? (
              <AgentHeatmapSystem
                agentsRef={renderAgentsRef}
                heatmapMode={heatmapMode}
                heatGridRef={heatGridRef}
              />
            ) : null}

            {/* Placement ghost. */}
            {editMode &&
              drag.kind === "placing" &&
              drag.itemType !== "wall" &&
              ghostPos && (
                <Suspense fallback={null}>
                  <FurniturePlacementGhost
                    itemType={drag.itemType}
                    position={ghostPos}
                  />
                </Suspense>
              )}
            {editMode &&
            drag.kind === "placing" &&
            drag.itemType === "wall" &&
            wallGhostItem ? (
              <PrimitiveWallSegmentModel
                item={wallGhostItem}
                isSelected={false}
                isHovered={false}
                editMode={false}
                onPointerDown={() => {}}
                onPointerOver={() => {}}
                onPointerOut={() => {}}
              />
            ) : null}
            {editMode &&
            drag.kind === "placing" &&
            drag.itemType === "door" &&
            ghostPos ? (
              <PrimitiveDoorModel
                item={{
                  _uid: "__door_ghost__",
                  type: "door",
                  x: worldToCanvas(ghostPos[0], ghostPos[2]).cx,
                  y: worldToCanvas(ghostPos[0], ghostPos[2]).cy,
                  w: DOOR_LENGTH,
                  h: DOOR_THICKNESS,
                }}
                isSelected={false}
                isHovered={false}
                editMode={false}
                onPointerDown={() => {}}
                onPointerOver={() => {}}
                onPointerOut={() => {}}
              />
            ) : null}

            {/* AAS: 방 이름표(계획 2026-10-13-001) */}
            {aasRoomLabels ? <AasRoomLabels furniture={furniture} labels={aasRoomLabels} inMeeting={aasRoomsInMeeting} status={aasRoomStatus} onSelect={onRoomLabelSelect} meetingLabel={agentBubbleLabels?.meeting} highlight={aasHighlight} /> : null}

            {/* AAS: 부서 슬로건·목표 현수막(스펙 2026-10-15-018). 편집 모드·따라가기에서는 숨긴다 */}
            {aasBanner?.banners.length ? (
              <DepartmentBanner
                banners={aasBanner.banners}
                mine={aasBanner.mine}
                theme={aasBanner.theme}
                overviewZoom={cameraZoom}
                visible={!editMode && followAgentId === null}
              />
            ) : null}

            {/* AAS: 사람 아바타(계획 007 P6b). 자리 모양을 재려고 가구 GLB 를 기다리므로(useGLTF) 자체 Suspense 로 감싼다 —
                감싸지 않으면 <Canvas> 밖 오피스 화면의 Suspense 가 장면 전체를 대기 문구로 가린다(로딩 때 깜빡임) */}
            {aasPeople ? (
              <Suspense fallback={null}>
                <AasPeopleLayer
                  people={aasPeople.people}
                  walk={aasPeople.walk}
                  instant={aasPeople.instant}
                  onMove={aasPeople.onMove}
                  furniture={furniture}
                  sceneAgentsRef={renderAgentsRef}
                  spawn={AAS_PERSON_SPAWN}
                  actorsRef={aasPeopleRef}
                />
              </Suspense>
            ) : null}

            {/* Floor raycaster for edit-mode interaction. */}
            <SceneFloorRaycaster
              enabled={editMode}
              onMove={handleFloorMove}
              onClick={handleFloorClick}
            />
            </ScenePaletteContext.Provider>
          </Canvas>
        ) : null}
      </div>

      {/* claw3d: HUD·전체 화면 패널·편집 도구는 가져오지 않았다(CLAW3D_CHANGES.md). AAS 가 MUI 패널로 대신한다. */}
      <style>{`
        @keyframes eq-bar {
          from { transform: scaleY(0.3); }
          to   { transform: scaleY(1); }
        }
        @keyframes mood-float {
          0%   { transform: translateX(-50%) translateY(0px); opacity: 1; }
          100% { transform: translateX(-50%) translateY(-28px); opacity: 0; }
        }
      `}</style>
    </div>
  );
}
