/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// Claw3D 의 3D 장면을 AAS 가 쓰는 만큼의 입력으로 줄인 감싸개(계획 003 §4-1, 007 P0).
// 나머지 props 는 원본의 기본값을 그대로 쓴다. 오피스 화면이 React.lazy 로 불러온다(three·R3F·drei 묶음을 이 화면에서만 받는다).
import { useThemeMode } from '@/components/ThemeMode';
import type { Banner } from '@/features/office/banner';
import type { GreetingLines } from '@/features/office/greetings';
import type { PersonPos } from '@/features/office/people';
import type { StandupMeeting } from '@/features/office/scene3d/lib/office/standup/types';
import type { CameraNudge } from '@/features/office/scene3d/retro-office/core/cameraFocus';
import type { AasDevice } from '@/features/office/scene3d/retro-office/core/overlayOnly';
import type { FurnitureItem, OfficeAgent } from '@/features/office/scene3d/retro-office/core/types';
import type { AasScenePerson } from '@/features/office/scene3d/retro-office/objects/aasPeople';
import type { AasEditorApi, AasEditorState } from '@/features/office/scene3d/retro-office/RetroOffice3D';
import { RetroOffice3D } from '@/features/office/scene3d/retro-office/RetroOffice3D';
import type { TaskBoardCard, TaskBoardStatus } from '@/features/office/scene3d/shims';
import { SCENE_BACKDROP } from '@/features/office/tokens';

export interface OfficeSceneProps {
  agents: OfficeAgent[];
  /** 서버 레이아웃. null 이면 아직 판이 없어 장면이 기본 배치를 만들고 onLayoutMissing 으로 알린다. */
  furniture: FurnitureItem[] | null;
  /** 책상 _uid → 자리 별칭(서버가 정한다). */
  desks: Record<string, string>;
  onLayoutMissing?: (items: FurnitureItem[]) => void;
  /** 명단에서 고른 에이전트로 카메라를 옮긴다(n 이 바뀔 때마다). */
  /** at 이 있으면 에이전트 대신 그 점(배치 좌표)으로 옮긴다(상태판 회의실 행, 스펙 2026-10-20-021 R12). */
  focusRequest?: { id: string; n: number; at?: { x: number; y: number }; zoom?: boolean; highlight?: string } | null;
  /** 카메라 조작 단추(스펙 2026-10-21-006). n 이 바뀔 때마다 한 번. */
  cameraCommand?: { kind: CameraNudge | 'reset'; n: number } | null;
  /** 따라가는 에이전트(HUD 가 정한다). */
  followAgentId?: string | null;
  /** 별칭 → 말풍선 글(계획 007 P1). */
  speech?: Record<string, string>;
  /** 별칭 → 마지막 활동 시각(ms). 30분이 지나면 소파로 간다. */
  lastSeen?: Record<string, number>;
  /** 3D 칸반 보드의 카드(계획 007 P4). */
  boardCards?: Record<TaskBoardStatus, TaskBoardCard[]>;
  /** 회의마다 참가 에이전트가 앉을 회의실 자리(계획 2026-10-13-001 R4). */
  meetingSeats?: Record<string, { x: number; y: number; facing: number }>;
  /** 방 표시 uid → 문 위 이름. */
  roomLabels?: Record<string, string>;
  /** 지금 회의 중인 방 표시 uid. 명패 앞에 회의 중 표시를 단다. */
  roomsInMeeting?: Set<string>;
  /** 방 표시 uid → 명패 둘째 줄 글(번역됨). moved 면 회색 「→ … 에서 회의 중」(스펙 2026-10-20-017 디자인 리뷰 이슈 1·2). */
  roomStatus?: Record<string, { text: string; moved: boolean }>;
  /** 진행 중인 회의(참가 에이전트가 회의실로 모인다, P3). */
  meeting?: StandupMeeting | null;
  /** 서버 단말·QA 단말·칸반 보드·회의 탁자를 눌렀다(P5). */
  onDevice?: (device: AasDevice) => void;
  /** 회의실 빔 스크린을 눌렀다(OMAI-1257). 스크린 항목의 uid. */
  onMeetingScreen?: (screenUid: string) => void;
  /** 회의실 명패를 눌렀다. 방 표시 항목의 uid. */
  onRoomLabel?: (roomUid: string) => void;
  onSelectAgent?: (id: string) => void;
  /** 말풍선 위 '대화'(팝업)·'상세'(서랍) 단추(OMAI-1115). */
  onBubbleAction?: (id: string, action: 'chat' | 'detail') => void;
  bubbleLabels?: { chat: string; detail: string; more: string; meeting?: string };
  /** 마주친 에이전트의 인사와 혼잣말 문구(스펙 2026-10-21-021). 언어가 바뀔 때만 새로 만들어 준다 */
  greetings?: GreetingLines;
  /** 부서 슬로건·목표 현수막(스펙 2026-10-15-018). 문구가 있고 사용자가 끄지 않았을 때만 준다. */
  banner?: { banners: Banner[]; mine: string } | null;
  /** 오피스에 있는 사람과 내 아바타 걷기(계획 007 P6b). */
  people?: { people: AasScenePerson[]; walk: boolean; instant: boolean; onMove: (pos: PersonPos) => void };
  /** 관리자 배치 편집(계획 007 P7). */
  editor?: {
    active: boolean;
    apiRef: React.MutableRefObject<AasEditorApi | null>;
    onChange: (state: AasEditorState) => void;
    onDeleteRequest: (item: FurnitureItem) => void;
  };
}

export default function OfficeScene({
  agents,
  furniture,
  desks,
  onLayoutMissing,
  focusRequest = null,
  cameraCommand = null,
  followAgentId = null,
  speech,
  lastSeen,
  boardCards,
  meeting = null,
  meetingSeats,
  roomLabels,
  roomsInMeeting,
  roomStatus,
  onDevice,
  onMeetingScreen,
  onRoomLabel,
  onSelectAgent,
  onBubbleAction,
  bubbleLabels,
  greetings,
  people,
  banner = null,
  editor,
}: OfficeSceneProps) {
  const { mode } = useThemeMode();
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <RetroOffice3D
        agents={agents}
        readOnly
        storageNamespace="aas"
        serverFurniture={furniture}
        onServerFurnitureMissing={onLayoutMissing}
        deskAssignmentByDeskUid={desks}
        focusRequest={focusRequest}
        cameraCommand={cameraCommand}
        followAgentId={followAgentId}
        streamingTextByAgentId={speech}
        lastSeenByAgentId={lastSeen}
        taskBoardCardsByStatus={boardCards}
        standupMeeting={meeting}
        aasMeetingSeats={meetingSeats}
        aasRoomLabels={roomLabels}
        aasRoomsInMeeting={roomsInMeeting}
        aasRoomStatus={roomStatus}
        onDeviceSelect={onDevice}
        onMeetingScreenSelect={onMeetingScreen}
        onRoomLabelSelect={onRoomLabel}
        onStandupStartRequested={onDevice ? () => onDevice('meeting') : undefined}
        onAgentChatSelect={onSelectAgent}
        onAgentBubbleAction={onBubbleAction}
        agentBubbleLabels={bubbleLabels}
        aasGreetings={greetings}
        aasPeople={people}
        aasBanner={banner ? { ...banner, theme: mode } : null}
        aasEditor={editor}
        aasBackdrop={SCENE_BACKDROP[mode]}
        aasTheme={mode}
      />
    </div>
  );
}
