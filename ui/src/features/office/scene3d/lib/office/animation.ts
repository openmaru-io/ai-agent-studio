/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 장면이 받는 행동 입력. Claw3D 원본(eventTriggers.ts, MIT)의 OfficeAnimationState 와 같은 모양이다.
// 원본은 OpenClaw 게이트웨이 이벤트에서 이 값을 만들었고, AAS 는 서버 이벤트(office_state)에서 만든다.
import type { OfficeCleaningCue } from "@/features/office/scene3d/lib/office/janitorReset";

type BooleanByAgentId = Record<string, boolean>;
type NumberByAgentId = Record<string, number>;

export type OfficePhoneCallRequest = {
  key: string;
  callee: string;
  message: string | null;
  phase: "needs_message" | "ready_to_call";
  requestedAt: number;
};
export type OfficeTextMessageRequest = {
  key: string;
  recipient: string;
  message: string | null;
  phase: "needs_message" | "ready_to_send";
  requestedAt: number;
};
export type OfficeStandupTriggerRequest = {
  key: string;
  message: string;
  requestedAt: number;
};

export type OfficeAnimationState = {
  awaitingApprovalByAgentId: BooleanByAgentId;
  cleaningCues: OfficeCleaningCue[];
  danceUntilByAgentId: NumberByAgentId;
  deskHoldByAgentId: BooleanByAgentId;
  githubHoldByAgentId: BooleanByAgentId;
  gymHoldByAgentId: BooleanByAgentId;
  jukeboxHoldByAgentId: BooleanByAgentId;
  manualGymUntilByAgentId: NumberByAgentId;
  pendingStandupRequest: OfficeStandupTriggerRequest | null;
  phoneBoothHoldByAgentId: BooleanByAgentId;
  phoneCallByAgentId: Record<string, OfficePhoneCallRequest>;
  qaHoldByAgentId: BooleanByAgentId;
  smsBoothHoldByAgentId: BooleanByAgentId;
  skillGymHoldByAgentId: BooleanByAgentId;
  streamingByAgentId: BooleanByAgentId;
  textMessageByAgentId: Record<string, OfficeTextMessageRequest>;
  thinkingByAgentId: BooleanByAgentId;
  workingUntilByAgentId: NumberByAgentId;
};

export const emptyAnimationState = (): OfficeAnimationState => ({
  awaitingApprovalByAgentId: {},
  cleaningCues: [],
  danceUntilByAgentId: {},
  deskHoldByAgentId: {},
  githubHoldByAgentId: {},
  gymHoldByAgentId: {},
  jukeboxHoldByAgentId: {},
  manualGymUntilByAgentId: {},
  pendingStandupRequest: null,
  phoneBoothHoldByAgentId: {},
  phoneCallByAgentId: {},
  qaHoldByAgentId: {},
  smsBoothHoldByAgentId: {},
  skillGymHoldByAgentId: {},
  streamingByAgentId: {},
  textMessageByAgentId: {},
  thinkingByAgentId: {},
  workingUntilByAgentId: {},
});
