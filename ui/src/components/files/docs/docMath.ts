/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 문서 뷰어(스펙 2026-10-20-005)가 쓰는 계산. 상태가 없어 시험하기 쉽게 따로 둔다.
// 그릴 쪽 범위(리뷰 D5·재검토 E1), 캔버스 상한(재검토 D4), 확대 단계(재검토 D5), 찾기(재검토 D1·E2·외부 검토 OV2-H3),
// Office 파일 미리 거르기(리뷰 D7 CFB 서명, D13 압축 폭탄).

/** 보이는 쪽과 앞뒤로 더 그리는 쪽 수, 그려 둘 쪽 수 상한(리뷰 D5) */
export const AROUND = 2;
export const KEEP_MAX = 7;
/** 쪽 캔버스 하나와 그린 쪽 전체의 화소 상한(재검토 D4) */
export const PAGE_PIXELS = 8_000_000;
export const TOTAL_PIXELS = 40_000_000;
/** 맞춤 폭 상한(디자인 DV1) */
export const FIT_MAX = 960;
export const ZOOM_MIN = 50;
export const ZOOM_MAX = 300;
export const ZOOM_STEP = 25;
/** 찾기 결과 상한(재검토 D1) */
export const FIND_CAP = 1000;
/** 압축 폭탄 판정(리뷰 D13) */
export const UNZIP_MAX = 200 * 1024 * 1024;
export const RATIO_MAX = 100;

/** 보이는 쪽(1부터) → 그릴 쪽 범위 [시작, 끝]. 끝은 전체 쪽 수를 넘지 않는다 */
export function pageRange(visible: number, total: number, around = AROUND): [number, number] {
  if (total <= 0) return [0, -1];
  const v = Math.min(Math.max(1, visible), total);
  return [Math.max(1, v - around), Math.min(total, v + around)];
}

/** 쪽 위쪽 위치(px, 오름차순)와 스크롤 위치 → 보이는 영역 가운데에 걸친 쪽(1부터). iframe 안을 관찰할 수 없어 계산한다(재검토 E1) */
export function pageAt(tops: number[], scrollTop: number, viewport: number): number {
  if (!tops.length) return 0;
  const mid = scrollTop + viewport / 2;
  let lo = 0;
  let hi = tops.length - 1;
  while (lo < hi) {
    const m = Math.ceil((lo + hi) / 2);
    if (tops[m] <= mid) lo = m;
    else hi = m - 1;
  }
  return lo + 1;
}

/** 캔버스 배율. 쪽 하나가 PAGE_PIXELS 를 넘으면 배율을 낮춘다(dpr 은 최대 2, 디자인 DV1) */
export function canvasRatio(cssWidth: number, cssHeight: number, dpr: number): number {
  const want = Math.min(Math.max(dpr || 1, 1), 2);
  const area = cssWidth * cssHeight;
  if (area <= 0) return want;
  const fit = Math.sqrt(PAGE_PIXELS / area);
  return Math.max(0.25, Math.min(want, fit));
}

/** 그려 둘 쪽 수. 쪽 하나의 화소 × 쪽 수가 TOTAL_PIXELS 를 넘으면 줄인다(최소 1) */
export function keepCount(pagePixels: number): number {
  if (pagePixels <= 0) return KEEP_MAX;
  return Math.max(1, Math.min(KEEP_MAX, Math.floor(TOTAL_PIXELS / pagePixels)));
}

/** 맞춤 폭: 본문 폭에서 여백을 뺀 값과 FIT_MAX 중 작은 것 */
export function fitWidth(bodyWidth: number, narrow: boolean): number {
  return Math.max(120, Math.min(bodyWidth - (narrow ? 16 : 48), FIT_MAX));
}

export function zoomStep(zoom: number, dir: 1 | -1): number {
  const next = Math.round((zoom + dir * ZOOM_STEP) / ZOOM_STEP) * ZOOM_STEP;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
}

// ---- 찾기 --------------------------------------------------------------------

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/** 한 쪽의 글자 덩어리를 이어 붙인 원문과 덩어리 시작 위치 */
export interface PageText {
  text: string;
  starts: number[];
}

export function pageText(items: string[]): PageText {
  const starts: number[] = [];
  let text = '';
  for (const s of items) {
    starts.push(text.length);
    text += s;
  }
  return { text, starts };
}

/** 원문에서 찾은 곳 [시작, 끝)(원문 위치). 대소문자와 띄어쓰기를 무시한다(재검토 D1). 상한을 넘으면 거기서 멈춘다 */
export function findIn(text: string, query: string, cap = FIND_CAP): [number, number][] {
  const q = query.replace(/\s+/g, '').toLowerCase();
  if (!q) return [];
  const norm: string[] = [];
  const at: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (/\s/.test(c)) continue;
    norm.push(c.toLowerCase());
    at.push(i);
  }
  const hay = norm.join('');
  const out: [number, number][] = [];
  for (let from = hay.indexOf(q); from >= 0 && out.length < cap; from = hay.indexOf(q, from + q.length)) {
    out.push([at[from], at[from + q.length - 1] + 1]);
  }
  return out;
}

/** 덩어리 하나를 그릴 HTML. 원문 위치로 찾은 곳을 덩어리 안 조각으로 나누고, 조각마다 이스케이프한 뒤 결과만 mark 로 감싼다(OV2-H3·E2) */
export function markItem(page: PageText, index: number, hits: [number, number][], current?: [number, number]): string {
  const start = page.starts[index] ?? 0;
  const end = index + 1 < page.starts.length ? page.starts[index + 1] : page.text.length;
  const str = page.text.slice(start, end);
  let out = '';
  let pos = start;
  for (const [a, b] of hits) {
    if (b <= start || a >= end) continue;
    const s = Math.max(a, start);
    const e = Math.min(b, end);
    out += escapeHtml(page.text.slice(pos, s));
    const cur = current && current[0] === a && current[1] === b;
    out += `<mark${cur ? ' data-current="1"' : ''}>${escapeHtml(page.text.slice(s, e))}</mark>`;
    pos = e;
  }
  return out + escapeHtml(str.slice(pos - start));
}

// ---- Office 파일 미리 거르기 ---------------------------------------------------

export type OfficeCheck = 'ok' | 'encrypted' | 'bomb' | 'corrupt';

/** 암호 걸린 Office·옛 형식(doc·xls·ppt)은 OLE 복합 파일(CFB)이다(리뷰 D7) */
export function isCfb(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;
}

export interface ZipEntry {
  name: string;
  compressed: number;
  size: number;
}

/** zip 끝의 목차(central directory)만 읽는다. 목차를 못 찾으면 null */
export function zipEntries(b: Uint8Array): ZipEntry[] | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const min = Math.max(0, b.length - 65557);
  let eocd = -1;
  for (let i = b.length - 22; i >= min; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out: ZipEntry[] = [];
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (p + 46 > b.length || dv.getUint32(p, true) !== 0x02014b50) return null;
    const compressed = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extra = dv.getUint16(p + 30, true);
    const comment = dv.getUint16(p + 32, true);
    out.push({ name: dec.decode(b.subarray(p + 46, p + 46 + nameLen)), compressed, size });
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

/** 라이브러리에 넘기기 전에 거른다. ZIP64(크기 0xFFFFFFFF)는 크기를 알 수 없어 폭탄으로 본다 */
export function checkOffice(b: Uint8Array): OfficeCheck {
  if (isCfb(b)) return 'encrypted';
  const entries = zipEntries(b);
  if (!entries) return 'corrupt';
  let size = 0;
  let packed = 0;
  for (const e of entries) {
    if (e.size === 0xffffffff || e.compressed === 0xffffffff) return 'bomb';
    size += e.size;
    packed += e.compressed;
  }
  if (size > UNZIP_MAX) return 'bomb';
  if (packed > 0 && size / packed > RATIO_MAX && size > 10 * 1024 * 1024) return 'bomb';
  return 'ok';
}

/** 슬라이드 상한(디자인 DV15). pptx-preview 는 한꺼번에 그린다 */
export const SLIDE_MAX = 100;

export type PreCheck = OfficeCheck | 'tooManySlides';

/** 형식별로 라이브러리를 받기 전에 거른다(리뷰 D7·D13, 재검토 E6). HWP 5 는 원래 CFB 라 암호 판정을 하지 않고, HWPX 는 압축 폭탄만 본다 */
export function preCheck(kind: string, name: string, b: Uint8Array): PreCheck {
  if (kind === 'docx' || kind === 'xlsx' || kind === 'pptx') {
    const c = checkOffice(b);
    if (c !== 'ok' || kind !== 'pptx') return c;
    const slides = (zipEntries(b) ?? []).filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name)).length;
    return slides > SLIDE_MAX ? 'tooManySlides' : 'ok';
  }
  if (kind === 'hwp' && /\.hwpx$/i.test(name)) return checkOffice(b) === 'bomb' ? 'bomb' : 'ok';
  return 'ok';
}

/**
 * 쪽 SVG 의 id 에 쪽 번호를 붙이고 그 id 를 가리키는 참조(url(#…)·href="#…")도 맞춘다.
 * 한글 뷰어는 여러 쪽 SVG 를 한 iframe 문서에 넣는데, rhwp 는 쪽마다 칸 잘라내기 id(cell-clip-N)를 같은 번호로 다시 매긴다.
 * 그대로 두면 뒤쪽의 url(#cell-clip-N) 이 앞쪽 영역을 가리켜 표 칸 글자가 잘려 안 보였다(2026-10-27, OMAI-1508).
 * 태그 안만 바꾼다 — 글자에 같은 문자열이 있어도 건드리지 않는다. 이 쪽에 없는 id 를 가리키는 참조도 그대로 둔다.
 */
export function scopeSvgIds(svg: string, page: number): string {
  const ids = new Set<string>();
  for (const tag of svg.match(/<[^>]+>/g) ?? []) for (const m of tag.matchAll(/\sid="([^"]+)"/g)) ids.add(m[1]);
  if (!ids.size) return svg;
  const scoped = (id: string) => (ids.has(id) ? `p${page}-${id}` : id);
  return svg.replace(/<[^>]+>/g, (tag) =>
    tag
      .replace(/(\sid=")([^"]+)"/g, (_, a: string, id: string) => `${a}${scoped(id)}"`)
      .replace(/url\(#([^)]+)\)/g, (_, id: string) => `url(#${scoped(id)})`)
      .replace(/(href=")#([^"]+)"/g, (_, a: string, id: string) => `${a}#${scoped(id)}"`),
  );
}
