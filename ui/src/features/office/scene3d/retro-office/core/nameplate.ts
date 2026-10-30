/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// AAS: 3D 이름표 글자를 상자 폭에 맞춘다. 원본은 글자 수로만 크기를 정해 한글(영문의 약 두 배 폭)이나
// 띄어쓰기 없는 긴 이름이 상자를 넘거나 여러 줄로 접혔다. 글자 폭을 어림해 줄이고, 가장 작게 해도 넘치면 끝을 … 로 줄인다.

/** 이름표 위·아래 클릭 구역(OMAI-1259, 2026-10-16 바꿈: 위=대화 창·아래=상세 서랍).
 *  y 는 판 가운데 기준 구역 가운데, h 는 구역 높이다. 눌러 쓸 수 있으면(actionable) 판 전체 폭·높이를 위·아래 반씩 틈 없이 나눈다.
 *  누를 곳이 없는 이름표(청소부 등)는 나누지 않는다. 판 폭은 이름마다 다르므로(2026-10-20-003) 판 크기를 받는다. */
export function nameplateZones(width: number, height: number, actionable: boolean): {
  width: number;
  height: number;
  zones: { id: "top" | "bottom"; y: number; h: number }[];
} {
  return {
    width,
    height,
    zones: actionable
      ? [
          { id: "top", y: height / 4, h: height / 2 },
          { id: "bottom", y: -height / 4, h: height / 2 },
        ]
      : [],
  };
}

/** 글자 폭 어림(글꼴 크기 1 기준). 번들 글꼴 Noto Sans KR 을 넉넉하게 잡은 값이다. */
function glyphEm(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if ((cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0x3131 && cp <= 0x318e) || (cp >= 0x3000 && cp <= 0x9fff)) return 0.95;
  if (ch === " ") return 0.26;
  if ("-_.,:;'|!iIl()[]".includes(ch)) return 0.36;
  if (ch >= "A" && ch <= "Z") return 0.66;
  if (ch === "m" || ch === "w" || ch === "M" || ch === "W") return 0.85;
  return 0.57;
}

export function textWidthEm(text: string): number {
  let w = 0;
  for (const ch of text) w += glyphEm(ch);
  return w;
}

/** 상자 폭(maxWidth, 장면 단위)에 한 줄로 들어가는 글자와 크기. */
export function fitLabel(text: string, maxWidth: number, base: number, min: number): { text: string; fontSize: number } {
  if (!text) return { text, fontSize: base };
  const em = textWidthEm(text);
  if (em * base <= maxWidth) return { text, fontSize: base };
  if (em * min <= maxWidth) return { text, fontSize: maxWidth / em };
  const chars = Array.from(text);
  while (chars.length > 1 && textWidthEm(chars.join("") + "…") * min > maxWidth) chars.pop();
  return { text: chars.join("") + "…", fontSize: min };
}

// 2026-10-20-003: 이름표·방 명패를 작고 옅게. 판 폭을 글자에 맞추고 글자 크기는 고정한다.
// 전에는 판 폭이 고정이라 긴 이름만 줄어, 짧은 이름일수록 글자가 크게 보였다.
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const PLATE_MIN_W = 0.3;
const PLATE_MAX_W = 0.72;
const NAME_SIZE = 0.095;
const NAME_MIN = 0.06;
const SUB_SIZE = 0.058;
const SUB_MIN = 0.045;
/** 판 왼쪽 끝 → 글자 시작(색 막대 포함) */
const TEXT_INSET = 0.07;
const DOT_R = 0.028;
/** 판 오른쪽 끝 → 상태 점 가운데 */
const DOT_INSET = 0.058;
/** 글자 끝과 상태 점 사이 */
const DOT_GAP = 0.03;
const PLATE_PAD = TEXT_INSET + DOT_INSET + DOT_R + DOT_GAP;

type Line = { text: string; fontSize: number; x: number; y: number };

/** 머리 위 이름표의 판 크기와 글자·막대·상태 점 자리(판 가운데 기준). 부제가 빈 글자면 한 줄 판이다. */
export function nameplateLayout(name: string, subtitle: string): {
  width: number;
  height: number;
  radius: number;
  name: Line;
  subtitle: Line | null;
  bar: { x: number; w: number; h: number };
  dot: { x: number; y: number; r: number };
} {
  const two = subtitle.length > 0;
  const need = Math.max(textWidthEm(name) * NAME_SIZE, two ? textWidthEm(subtitle) * SUB_SIZE : 0) + PLATE_PAD;
  const width = clamp(need, PLATE_MIN_W, PLATE_MAX_W);
  const height = two ? 0.24 : 0.16;
  const room = width - PLATE_PAD;
  const x = -width / 2 + TEXT_INSET;
  const nameY = two ? 0.045 : 0;
  const n = fitLabel(name, room, NAME_SIZE, NAME_MIN);
  const sub = two ? fitLabel(subtitle, room, SUB_SIZE, SUB_MIN) : null;
  return {
    width,
    height,
    radius: two ? 0.06 : 0.05,
    name: { ...n, x, y: nameY },
    subtitle: sub ? { ...sub, x, y: -0.052 } : null,
    bar: { x: -width / 2 + 0.035, w: 0.016, h: two ? 0.15 : 0.08 },
    dot: { x: width / 2 - DOT_INSET, y: nameY, r: DOT_R },
  };
}

const ROOM_MIN_W = 0.7;
const ROOM_MAX_W = 1.6;
// 2026-10-20-008: 0.12 → 0.14. 방 이름이 사람 이름(0.095 × 배율 1.75 ≈ 0.166)보다 많이 작아 회의 중 줄을 읽기 어려웠다
const ROOM_SIZE = 0.14;
const ROOM_MIN = 0.09;
/** 판 왼쪽 끝 → 문 아이콘 가운데, → 글자 시작 */
const ROOM_DOT_INSET = 0.12;
const ROOM_TEXT_INSET = 0.2;
/** 판 오른쪽 끝 → › 가운데 */
const ROOM_CHEVRON_INSET = 0.11;
/** 둘째 줄 글자 크기와, 글 앞의 점·간격 폭(점 지름 0.04 + 0.03) */
const ROOM_STATUS_SIZE = 0.09;
const ROOM_STATUS_LEAD = 0.07;

/** 방 명패의 판 크기와 글자·문 아이콘·› 자리(판 가운데 기준). 눌러 열 수 있으면 오른쪽에 › 자리를 둔다.
 *  2026-10-20-008: 사람 이름표(알약)와 구분되게 모서리를 덜 둥글게(안내판), 왼쪽은 문 아이콘, 회의 중이면 둘째 줄 「회의 중」.
 *  2026-10-20-017: 둘째 줄 글(statusText, 예: 「마케팅팀 회의 중」·「→ 대회의실에서 회의 중」)이 이름보다 길면 판을 넓히고,
 *  최대 폭을 넘으면 … 로 자른다. 비우면 부르는 쪽이 기본 문구(「회의 중」)를 그린다. */
export function roomLabelLayout(
  text: string,
  interactive: boolean,
  inMeeting = false,
  statusText = "",
): {
  width: number;
  height: number;
  radius: number;
  text: string;
  fontSize: number;
  textX: number;
  nameY: number;
  icon: { x: number; y: number; w: number; h: number };
  status: { x: number; y: number; fontSize: number; dotR: number; text: string } | null;
  chevronX: number;
} {
  const pad = ROOM_TEXT_INSET + (interactive ? 0.2 : 0.1);
  const statusNeed = statusText ? textWidthEm(statusText) * ROOM_STATUS_SIZE + ROOM_STATUS_LEAD : 0;
  const width = clamp(Math.max(textWidthEm(text) * ROOM_SIZE, statusNeed) + pad, ROOM_MIN_W, ROOM_MAX_W);
  const fit = fitLabel(text, width - pad, ROOM_SIZE, ROOM_MIN);
  const status = statusText ? fitLabel(statusText, width - pad - ROOM_STATUS_LEAD, ROOM_STATUS_SIZE, ROOM_STATUS_SIZE).text : "";
  const height = inMeeting ? 0.33 : 0.22;
  const nameY = inMeeting ? 0.055 : 0;
  const textX = -width / 2 + ROOM_TEXT_INSET;
  return {
    width,
    height,
    radius: 0.03,
    text: fit.text,
    fontSize: fit.fontSize,
    textX,
    nameY,
    icon: { x: -width / 2 + ROOM_DOT_INSET, y: nameY, w: 0.066, h: 0.096 },
    status: inMeeting ? { x: textX, y: -0.08, fontSize: ROOM_STATUS_SIZE, dotR: 0.02, text: status } : null,
    chevronX: width / 2 - ROOM_CHEVRON_INSET,
  };
}

// 이름표·방 명패 판 색은 2026-10-20-003 에서 #1b1f26·0.62 로 정했고, 2026-10-20-012 에서 테마별 장면 색(tokens.ts SCENE_PALETTE.label)으로 옮겼다.
