/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 부서 슬로건·목표 현수막(스펙 2026-10-15-018)의 순수 계산: 어떤 문구를 보일지, 건물 위에 띠를 남기는 처음 구도, 천 안의 글자 배치.
// 3D 그리기(DepartmentBanner.tsx)와 분리해 jsdom 시험으로 확인한다.
import { textWidthEm } from '@/features/office/scene3d/retro-office/core/nameplate';

export interface Banner {
  team: string;
  goal: string;
}

/** 여러 부서 문구를 돌리는 간격(밀리초) */
export const BANNER_ROTATE_MS = 12_000;
/** 캔버스 폭이 이보다 좁으면 현수막을 그리지 않는다(CSS 픽셀) */
export const BANNER_MIN_CANVAS_W = 640;
/** 현수막 띠가 쓰는 높이(캔버스 높이 비율)와 최소·최대(CSS 픽셀) */
export const BAND_FRACTION = 0.14;
export const BAND_MIN_PX = 64;
export const BAND_MAX_PX = 120;
/** 현수막이 쓰는 폭(캔버스 폭 비율) */
export const BANNER_WIDTH_FRACTION = 0.6;
/** 현수막과 건물 사이의 틈(캔버스 높이 비율) */
export const BAND_GAP_FRACTION = 0.02;
/** 오른쪽 위 명단 상자가 가리는 폭(CSS 픽셀). 현수막 전체가 이 안으로 들어가지 않으면 현수막을 왼쪽으로 옮긴다 */
export const ROSTER_RESERVE_PX = 332;
/** 사용자가 처음 구도보다 이 배율 넘게 확대하면 현수막을 숨긴다 */
export const BANNER_HIDE_ZOOM_RATIO = 1.12;

/** 내 부서 문구를 맨 앞에 둔다. 나머지는 주어진 순서(부서 이름 순)를 지킨다. */
export function orderBanners(banners: Banner[], mine: string): Banner[] {
  const own = banners.filter((b) => b.team === mine);
  return [...own, ...banners.filter((b) => b.team !== mine)];
}

/** 지금 보일 문구. 없으면 null. nowMs 는 화면을 연 뒤 지난 시간이라 내 부서 문구부터 보인다. 움직임 줄이기가 켜져 있으면 돌리지 않고 맨 앞(내 부서)을 고정한다. */
export function pickBanner(banners: Banner[], mine: string, nowMs: number, reducedMotion: boolean): Banner | null {
  const ordered = orderBanners(banners, mine);
  if (!ordered.length) return null;
  if (reducedMotion || ordered.length === 1) return ordered[0];
  return ordered[Math.floor(nowMs / BANNER_ROTATE_MS) % ordered.length];
}

export function bandHeight(canvasH: number): number {
  return Math.round(Math.min(BAND_MAX_PX, Math.max(BAND_MIN_PX, canvasH * BAND_FRACTION)));
}

// ---- 처음 구도: 건물 위에 띠를 남긴다 ---------------------------------------------------------------------------------
type Vec3 = [number, number, number];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** 카메라가 target 을 바라볼 때 화면의 오른쪽·위쪽 단위 벡터(월드 좌표). */
export function screenAxes(pos: Vec3, target: Vec3): { right: Vec3; up: Vec3 } {
  const dir = norm(sub(target, pos));
  const right = norm(cross(dir, [0, 1, 0]));
  return { right, up: cross(right, dir) };
}

export interface Fit {
  zoom: number;
  /** 카메라(위치와 목표)를 화면 위쪽으로 옮길 월드 거리. 건물이 아래로 내려가 위에 띠가 생긴다. */
  shiftUp: number;
}

/**
 * 건물 상자(월드 좌표 모서리 8개)가 캔버스 안에서 현수막 띠 아래에 들어오는 처음 구도.
 * 확대는 baseZoom 보다 커지지 않는다(띠가 이미 있으면 그대로). 건물 한가운데를 (띠 아래 남은 영역)의 가운데에 놓는다.
 */
export function fitOverview(args: { corners: Vec3[]; pos: Vec3; target: Vec3; canvasW: number; canvasH: number; baseZoom: number; marginFraction?: number }): Fit {
  const { corners, pos, target, canvasW, canvasH, baseZoom } = args;
  const margin = args.marginFraction ?? 0.02;
  const { right, up } = screenAxes(pos, target);
  const xs = corners.map((c) => dot(sub(c, target), right));
  const ys = corners.map((c) => dot(sub(c, target), up));
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const band = bandHeight(canvasH);
  const topReserve = band + canvasH * BAND_GAP_FRACTION;
  const availW = canvasW * (1 - 2 * margin);
  const availH = canvasH - topReserve - canvasH * margin;
  const zoom = Math.min(baseZoom, availW / (x1 - x0), availH / (y1 - y0));
  // 카메라를 화면 위쪽(up)으로 s 만큼 옮기면 건물이 zoom*s 픽셀 내려간다. 건물 가운데(월드 단위 cy)를 남은 영역의 가운데에 놓는다.
  // 남은 영역 가운데의 화면 높이(캔버스 가운데 기준, 위가 +) = (아래 여백 - 위 예약)/2
  const cy = (y0 + y1) / 2;
  const regionCenterPx = (canvasH * margin - topReserve) / 2;
  return { zoom, shiftUp: cy - regionCenterPx / zoom };
}

/** 애드벌룬 한 개의 폭(화면 픽셀)과 천 양쪽에 붙는 애드벌룬 때문에 늘어나는 폭(천 폭 + 이 값 = 현수막 전체 폭). */
export function balloonSpan(canvasH: number): { balloonW: number; extra: number } {
  const balloonW = bandHeight(canvasH) * 0.92 * 0.82;
  return { balloonW, extra: balloonW * 0.92 * 2 };
}

/**
 * 천이 쓸 수 있는 최대 폭. 캔버스 폭의 60% 이하이고, 현수막 전체(천 + 애드벌룬)가 명단 상자를 뺀 영역 안에 든다.
 */
export function bannerFrame(canvasW: number, canvasH: number): { maxCloth: number } {
  const { extra } = balloonSpan(canvasH);
  const room = canvasW - ROSTER_RESERVE_PX - 24;
  return { maxCloth: Math.max(canvasW * 0.18, Math.min(canvasW * BANNER_WIDTH_FRACTION, room - extra)) };
}

/**
 * 현수막 가운데를 캔버스 가운데에서 옮길 거리(CSS 픽셀, 왼쪽이 음수). 가운데에 두어도 전체가 명단 상자를 피하면 0 이고,
 * 아니면 오른쪽 끝이 명단 상자 왼쪽 12 픽셀에 닿게 옮기되 왼쪽 끝이 캔버스 밖으로 나가지 않게 한다.
 */
export function bannerShift(canvasW: number, canvasH: number, clothW: number): number {
  const total = clothW + balloonSpan(canvasH).extra;
  const overlap = canvasW / 2 + total / 2 - (canvasW - ROSTER_RESERVE_PX - 12);
  if (overlap <= 0) return 0;
  return -Math.min(overlap, Math.max(0, canvasW / 2 - total / 2 - 12));
}

// ---- 천 안의 글자 -------------------------------------------------------------------------------------------------------
export interface BannerLayout {
  /** 천 크기(CSS 픽셀) */
  clothW: number;
  clothH: number;
  /** 문구 줄과 글자 크기(픽셀) */
  lines: string[];
  fontPx: number;
  /** 천 위쪽의 작은 부서 이름 글자 크기 */
  teamPx: number;
}

const MIN_FONT_PX = 12;

/** 문구를 가운데쯤의 띄어쓰기(없으면 글자 수 가운데)에서 두 줄로 나눈다. */
export function splitTwo(text: string): [string, string] {
  const chars = [...text];
  const mid = Math.floor(chars.length / 2);
  let best = -1;
  for (let i = 0; i < chars.length; i++) if (chars[i] === ' ' && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  const at = best > 0 ? best : mid;
  return [chars.slice(0, at).join('').trim(), chars.slice(best > 0 ? at + 1 : at).join('').trim()];
}

/** 천 크기와 글자 배치. 띠 높이 안에서 한 줄 → 작게 한 줄 → 두 줄 → 끝 줄임 순으로 맞춘다. */
export function layoutBanner(goal: string, canvasW: number, canvasH: number): BannerLayout {
  const band = bandHeight(canvasH);
  const clothH = Math.round(band * 0.62);
  const teamPx = Math.max(9, Math.round(band * 0.13));
  const areaH = clothH - teamPx * 1.3 - band * 0.06;
  const maxW = bannerFrame(canvasW, canvasH).maxCloth;
  const pad = (f: number) => f * 1.6;
  const fontMax = Math.min(band * 0.34, areaH / 1.25);
  const fitOne = (f: number) => textWidthEm(goal) * f + pad(f) <= maxW;
  let lines = [goal];
  let fontPx = fontMax;
  if (!fitOne(fontMax)) {
    const small = (maxW) / (textWidthEm(goal) + 1.6);
    if (small >= Math.max(MIN_FONT_PX, fontMax * 0.6)) fontPx = small;
    else {
      lines = splitTwo(goal);
      fontPx = Math.min(fontMax * 0.8, areaH / 2.5);
      const widest = Math.max(...lines.map(textWidthEm));
      if (widest * fontPx + pad(fontPx) > maxW) fontPx = Math.max(MIN_FONT_PX, maxW / (widest + 1.6));
      if (widest * fontPx + pad(fontPx) > maxW) {
        // 그래도 넘치면 끝을 …로 줄인다
        const fit = (s: string) => {
          let t = s;
          while (t.length > 1 && textWidthEm(t + '…') * fontPx + pad(fontPx) > maxW) t = t.slice(0, -1);
          return t === s ? s : t + '…';
        };
        lines = lines.map(fit);
      }
    }
  }
  const textW = Math.max(...lines.map(textWidthEm)) * fontPx + pad(fontPx);
  return { clothW: Math.round(Math.min(maxW, Math.max(Math.min(canvasW * 0.18, maxW), textW))), clothH, lines, fontPx, teamPx };
}

// ---- 이 브라우저의 끄기 선택 ---------------------------------------------------------------------------------------------
const PREF_KEY = 'aas.office.banner';

export function readBannerOff(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) === 'off';
  } catch {
    return false;
  }
}

export function writeBannerOff(off: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, off ? 'off' : 'on');
  } catch {
    /* 저장소가 막혀 있으면 이번 화면에서만 기억한다 */
  }
}
