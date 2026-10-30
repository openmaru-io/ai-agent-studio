/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// AAS(2026-10-20-004): 대화 말풍선의 크기와 글자 자리. 말풍선은 이름표가 펼쳐진 모양이다 — 머리 줄에 색 막대·이름·상태 점, 그 아래 말한 글.
// 전에는 폭을 글자 수로 1.8~4.6 에서 정하고(배율 1.75 를 곱하면 장면 단위 약 8) 글은 180자까지 그대로 그려 판 밖으로 넘쳤다.
import { fitLabel, textWidthEm } from "@/features/office/scene3d/retro-office/core/nameplate";

const MIN_W = 0.9;
const MAX_W = 2.2;
const PAD_X = 0.12;
const PAD_TOP = 0.08;
const PAD_BOTTOM = 0.1;
const HEADER_H = 0.1;
const HEADER_GAP = 0.04;
const BODY_SIZE = 0.105;
const LINE_HEIGHT = 1.4;
const MAX_LINES = 5;
const NAME_SIZE = 0.068;
const MORE_SIZE = 0.062;
const MORE_H = 0.11;
/** troika 는 단어 단위로 줄을 나눠 어림보다 줄이 늘 수 있다. 한 줄 폭을 이만큼만 쓴다고 보고 센다 */
const WRAP_SLACK = 0.92;

/** 꼬리 크기(판 가운데 아래). 전에는 0.22 × 0.15 를 판 왼쪽에 달았다 */
export const SPEECH_TAIL = { w: 0.12, h: 0.08 };
/** 꼬리 끝의 높이. 이름표 자리(1.05 − 반 높이)와 같아 말풍선이 이름표 자리에서 위로 자란다 */
export const SPEECH_BUBBLE_BOTTOM = 0.98;

type Line = { text: string; fontSize: number; x: number; y: number };

export function speechBubbleLayout(text: string, name: string): {
  width: number;
  height: number;
  /** 판 가운데 높이(이름표 묶음 기준) */
  y: number;
  text: string;
  truncated: boolean;
  body: { x: number; y: number; fontSize: number; maxWidth: number; lineHeight: number; lines: number };
  header: { name: Line; bar: { x: number; y: number; w: number; h: number }; dot: { x: number; y: number; r: number } };
  more: { y: number; fontSize: number } | null;
} {
  const capAt = (w: number) => (w - PAD_X * 2) * WRAP_SLACK;
  const em = textWidthEm(text) * BODY_SIZE;
  const nameW = textWidthEm(name) * NAME_SIZE + 0.08;
  // 한 줄에 들어가면 글 폭(또는 이름 폭)에 맞춰 좁히고, 아니면 최대 폭에서 줄을 바꾼다
  const width = em <= capAt(MAX_W) ? Math.min(MAX_W, Math.max(MIN_W, Math.max(em / WRAP_SLACK, nameW) + PAD_X * 2)) : MAX_W;
  const cap = capAt(width);
  const budget = cap * MAX_LINES;
  let shown = text;
  let truncated = false;
  if (em > budget) {
    const chars = Array.from(text);
    while (chars.length > 1 && textWidthEm(chars.join("").trimEnd() + "…") * BODY_SIZE > budget) chars.pop();
    shown = chars.join("").trimEnd() + "…";
    truncated = true;
  }
  const lines = Math.min(MAX_LINES, Math.max(1, Math.ceil((textWidthEm(shown) * BODY_SIZE) / cap - 1e-9)));
  const bodyH = lines * BODY_SIZE * LINE_HEIGHT;
  const height = PAD_TOP + HEADER_H + HEADER_GAP + bodyH + (truncated ? MORE_H : 0) + PAD_BOTTOM;
  const top = height / 2;
  const left = -width / 2 + PAD_X;
  const headerY = top - PAD_TOP - HEADER_H / 2;
  const bodyY = top - PAD_TOP - HEADER_H - HEADER_GAP;
  const n = fitLabel(name, width - PAD_X * 2 - 0.08, NAME_SIZE, 0.055);
  return {
    width,
    height,
    y: SPEECH_BUBBLE_BOTTOM + SPEECH_TAIL.h + height / 2,
    text: shown,
    truncated,
    body: { x: left, y: bodyY, fontSize: BODY_SIZE, maxWidth: width - PAD_X * 2, lineHeight: LINE_HEIGHT, lines },
    header: {
      name: { ...n, x: left, y: headerY },
      bar: { x: left - 0.045, y: headerY, w: 0.016, h: 0.08 },
      dot: { x: width / 2 - 0.08, y: headerY, r: 0.022 },
    },
    more: truncated ? { y: bodyY - bodyH - MORE_H / 2, fontSize: MORE_SIZE } : null,
  };
}
