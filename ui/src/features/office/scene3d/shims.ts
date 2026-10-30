/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// Claw3D 원본이 앱의 다른 곳에서 가져오던 타입 중 장면이 실제로 쓰는 모양만 남긴 것.
// 원본의 게이트웨이·스킬·스튜디오 설정은 가져오지 않았다(CLAW3D_CHANGES.md).
export type AgentState = Record<string, unknown>;
export type CronJobSummary = { id: string; name?: string; enabled?: boolean };
export type SkillStatusEntry = Record<string, unknown>;
export type StudioGatewayAdapterType = string;
export type TaskBoardStatus = "todo" | "in_progress" | "blocked" | "review" | "done";
export type TaskBoardCard = {
  id: string;
  title: string;
  description: string;
  status: TaskBoardStatus;
  assignedAgentId: string | null;
  updatedAt: string;
};
export const extractSpeechImage = (text: string, _id?: string): { cleanText: string; imageUrl: string | null } => ({ cleanText: text, imageUrl: null });
