import type { AgentAvatarProfile } from "@/features/office/scene3d/lib/avatars/profile";
import type { MutterLine } from "@/features/office/greetings";
import type { RefObject } from "react";
import type {
  FurnitureItem,
  OfficeAgent,
  RenderAgent,
} from "@/features/office/scene3d/retro-office/core/types";

export type BasicFurnitureModelProps = {
  item: FurnitureItem;
  onPointerDown?: (uid: string) => void;
  onPointerOver?: (uid: string) => void;
  onPointerOut?: () => void;
  editMode?: boolean;
};

export type InteractiveFurnitureModelProps = {
  item: FurnitureItem;
  isSelected: boolean;
  isHovered: boolean;
  editMode: boolean;
  kanbanTaskCount?: number;
  doorOpen?: boolean;
  onPointerDown: (uid: string) => void;
  onPointerOver: (uid: string) => void;
  onPointerOut: () => void;
  onClick?: (uid: string) => void;
};

export type AgentModelProps = {
  /** AAS: 얼굴(avatars/face.ts)의 data: URL. */
  faceUrl?: string | null;
  agentId: string;
  name: string;
  subtitle?: string | null;
  status: OfficeAgent["status"];
  color: string;
  appearance?: AgentAvatarProfile | null;
  agentsRef: RefObject<RenderAgent[]>;
  agentLookupRef?: RefObject<Map<string, RenderAgent>>;
  onHover?: (id: string) => void;
  onUnhover?: () => void;
  onClick?: (id: string) => void;
  onContextMenu?: (id: string, x: number, y: number) => void;
  showSpeech?: boolean;
  speechText?: string | null;
  suppressSpeechBubble?: boolean;
  /** AAS(OMAI-1115): 말풍선 위 '대화'·'상세' 단추. 없으면 단추를 두지 않는다. */
  onBubbleAction?: (id: string, action: "chat" | "detail") => void;
  /** AAS: 말풍선 단추·잘림 안내 문구(i18n). scene3d 폴더는 i18n 검사 밖이라 문구를 받아 쓴다. */
  bubbleLabels?: { chat: string; detail: string; more: string; meeting?: string };
  /** AAS(스펙 2026-10-21-021): 혼자 서 있을 때 보일 혼잣말(번역한 문구). 없으면 혼잣말 풍선이 없다 */
  mutterLines?: MutterLine[];
  /** AAS(2026-10-20-003): 부제를 늘 펼친다(따라가는 에이전트·「나」). 그 밖에는 올렸을 때·작업 중·오류일 때만 펼친다. */
  subtitlePinned?: boolean;
  /** AAS(스펙 2026-10-21-012): 보는 사람의 에이전트 — 발밑 고리와 반대 테마 색 이름표. */
  mine?: boolean;
  /** AAS(스펙 2026-10-21-012 §3-4): 상태판에서 골랐을 때의 시각(performance.now). 2.5초 동안 줄어드는 고리와 커지는 이름표로 표시한다. */
  highlightAt?: number | null;
};
