/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// AAS 는 원본 장면의 「몰입 화면」(ATM·문자 부스·전화부스·서버 단말·QA 장비·칸반 보드를 누르면 3D 캔버스를 내리고 그 자리에
// 띄우는 화면)을 가져오지 않았다(docs-plan/office/claw3d-office-integration.md). 이 장치들을 눌러 몰입 상태가 켜지면
// 캔버스만 내려가고 그릴 화면이 없어 장면이 통째로 빈다. 그래서 AAS 에서는 이 장치들의 클릭을 무시한다.
/** 몰입 화면이 없으므로 3D 캔버스를 항상 유지한다. */
export const AAS_WITHOUT_IMMERSIVE_SCREENS = true;

export const OVERLAY_ONLY_TYPES: ReadonlySet<string> = new Set([
  "atm",
  "sms_booth",
  "phone_booth",
  "server_terminal",
  "server_rack",
  "qa_terminal",
  "device_rack",
  "test_bench",
  "kanban_board",
  // AAS: 한국 사무실 배치(계획 2026-10-13-001). 서버실·QA 실험실 대신 상황판 TV·게시판이 장치다
  "tv_status",
  "notice_board",
]);

export const isOverlayOnlyType = (type: string): boolean => OVERLAY_ONLY_TYPES.has(type);

/** AAS 기능에 잇는 장치(계획 007 P5). 누르면 몰입 화면 대신 AAS 서랍을 연다. 전화·문자 부스·ATM 은 장식이라 없다. */
export type AasDevice = "server" | "qa" | "kanban" | "meeting";
const DEVICE: Record<string, AasDevice> = {
  server_terminal: "server",
  server_rack: "server",
  device_rack: "server",
  qa_terminal: "qa",
  test_bench: "qa",
  kanban_board: "kanban",
  tv_status: "server",
  notice_board: "qa",
};
// 회의실 TV(tv_meeting)와 화이트보드(whiteboard)는 장치가 아니다 — 상황판과 모델이 같아도 누르면 아무것도 열지 않는다(독립 검토 O7)

export const aasDeviceOf = (type: string): AasDevice | null => DEVICE[type] ?? null;
