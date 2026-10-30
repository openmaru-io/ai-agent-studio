/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import {
  canvasRatio,
  checkOffice,
  escapeHtml,
  FIND_CAP,
  findIn,
  fitWidth,
  keepCount,
  markItem,
  PAGE_PIXELS,
  pageAt,
  pageRange,
  pageText,
  preCheck,
  scopeSvgIds,
  zipEntries,
  zoomStep,
} from './docMath';

/** 목차만 있는 zip(본문 없음). 크기 값을 마음대로 넣어 폭탄·ZIP64 를 흉내 낸다 */
function fakeZip(entries: { name: string; compressed: number; size: number }[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  let cdSize = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const h = new Uint8Array(46 + name.length);
    const dv = new DataView(h.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint32(20, e.compressed, true);
    dv.setUint32(24, e.size, true);
    dv.setUint16(28, name.length, true);
    h.set(name, 46);
    parts.push(h);
    cdSize += h.length;
  }
  const end = new Uint8Array(22);
  const dv = new DataView(end.buffer);
  dv.setUint32(0, 0x06054b50, true);
  dv.setUint16(10, entries.length, true);
  dv.setUint32(12, cdSize, true);
  dv.setUint32(16, 0, true);
  const out = new Uint8Array(cdSize + 22);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  out.set(end, at);
  return out;
}

describe('그릴 쪽 범위', () => {
  it.each([
    [1, 20, [1, 3]],
    [10, 20, [8, 12]],
    [20, 20, [18, 20]],
    [1, 1, [1, 1]],
    [99, 3, [1, 3]],
    [0, 5, [1, 3]],
  ])('보이는 쪽 %i / %i → %j', (v, total, want) => {
    expect(pageRange(v, total)).toEqual(want);
  });

  it('쪽이 없으면 빈 범위', () => {
    expect(pageRange(1, 0)).toEqual([0, -1]);
  });

  it('스크롤 위치로 보이는 쪽을 계산한다(iframe 안은 관찰하지 못한다, 재검토 E1)', () => {
    const tops = [0, 1000, 2000, 3000];
    expect(pageAt(tops, 0, 800)).toBe(1);
    expect(pageAt(tops, 700, 800)).toBe(2);
    expect(pageAt(tops, 2900, 800)).toBe(4);
    expect(pageAt([], 0, 800)).toBe(0);
  });
});

describe('캔버스 상한(재검토 D4)', () => {
  it('보통 쪽은 dpr 을 그대로 쓰되 최대 2', () => {
    expect(canvasRatio(800, 1131, 1)).toBe(1);
    expect(canvasRatio(800, 1131, 3)).toBeCloseTo(2, 5);
  });

  it('큰 쪽은 800만 화소를 넘지 않게 배율을 낮춘다', () => {
    const r = canvasRatio(4000, 6000, 2);
    expect(4000 * r * 6000 * r).toBeLessThanOrEqual(PAGE_PIXELS + 1);
  });

  it('그린 쪽 합이 4,000만 화소를 넘으면 유지 쪽 수를 줄인다', () => {
    expect(keepCount(1_000_000)).toBe(7);
    expect(keepCount(8_000_000)).toBe(5);
    expect(keepCount(80_000_000)).toBe(1);
  });

  it('맞춤 폭은 960px 를 넘지 않는다', () => {
    expect(fitWidth(1728, false)).toBe(960);
    expect(fitWidth(600, false)).toBe(552);
    expect(fitWidth(375, true)).toBe(359);
  });

  it('확대는 25% 씩, 50~300%', () => {
    expect(zoomStep(100, 1)).toBe(125);
    expect(zoomStep(50, -1)).toBe(50);
    expect(zoomStep(300, 1)).toBe(300);
    expect(zoomStep(110, -1)).toBe(75);
  });
});

describe('찾기(재검토 D1·E2, 외부 검토 OV2-H3)', () => {
  it('대소문자와 띄어쓰기를 무시하고 원문 위치를 돌려준다', () => {
    expect(findIn('Hello World', 'o w')).toEqual([[4, 7]]);
    expect(findIn('국어 영역 국어', '국어')).toEqual([
      [0, 2],
      [6, 8],
    ]);
    expect(findIn('abc', '')).toEqual([]);
  });

  it('결과는 1,000개에서 멈춘다', () => {
    expect(findIn('a'.repeat(5000), 'a')).toHaveLength(FIND_CAP);
  });

  it('여러 덩어리에 걸친 결과도 덩어리마다 표시한다', () => {
    const page = pageText(['국', '어 영', '역']);
    const hits = findIn(page.text, '어영역');
    expect(hits).toEqual([[1, 5]]);
    expect(markItem(page, 0, hits)).toBe('국');
    expect(markItem(page, 1, hits)).toBe('<mark>어 영</mark>');
    expect(markItem(page, 2, hits)).toBe('<mark>역</mark>');
  });

  it('PDF 글자는 이스케이프한다 — 태그는 mark 만 남는다(E2)', () => {
    const page = pageText(['<img src=x onerror=alert(1)> 비밀']);
    const html = markItem(page, 0, findIn(page.text, '비밀'));
    expect(html).toBe('&lt;img src=x onerror=alert(1)&gt; <mark>비밀</mark>');
    expect(html).not.toContain('<img');
  });

  it('&amp; 같은 글자도 원문 기준으로 찾는다(이스케이프한 문자열을 찾지 않는다)', () => {
    const page = pageText(['R&D 와 amp']);
    expect(findIn(page.text, '&')).toEqual([[1, 2]]);
    expect(findIn(page.text, 'amp')).toEqual([[6, 9]]);
    expect(markItem(page, 0, findIn(page.text, '&'))).toBe('R<mark>&amp;</mark>D 와 amp');
  });

  it('지금 결과에는 표시를 단다', () => {
    const page = pageText(['aa']);
    const hits = findIn(page.text, 'a');
    expect(markItem(page, 0, hits, hits[1])).toBe('<mark>a</mark><mark data-current="1">a</mark>');
    expect(escapeHtml(`"'`)).toBe('&quot;&#39;');
  });
});

describe('Office 파일 미리 거르기(리뷰 D7·D13)', () => {
  it('CFB 서명이면 암호·옛 형식', () => {
    expect(checkOffice(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBe('encrypted');
  });

  it('보통 docx(zip)는 통과하고 목차를 읽는다', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml', '<w:document/>');
    zip.file('ppt/slides/slide1.xml', '<p/>');
    const b = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    expect(checkOffice(b)).toBe('ok');
    expect(zipEntries(b)?.map((e) => e.name).filter((n) => !n.endsWith('/'))).toEqual(['word/document.xml', 'ppt/slides/slide1.xml']);
  });

  it('zip 이 아니면 손상', () => {
    expect(checkOffice(new TextEncoder().encode('hello'))).toBe('corrupt');
    expect(checkOffice(new Uint8Array())).toBe('corrupt');
  });

  it('풀면 200 MB 를 넘거나 압축률이 100배를 넘으면 폭탄', () => {
    expect(checkOffice(fakeZip([{ name: 'a.xml', compressed: 1000, size: 201 * 1024 * 1024 }]))).toBe('bomb');
    expect(checkOffice(fakeZip([{ name: 'a.xml', compressed: 100_000, size: 50 * 1024 * 1024 }]))).toBe('bomb');
    expect(checkOffice(fakeZip([{ name: 'a.xml', compressed: 0xffffffff, size: 0xffffffff }]))).toBe('bomb');
    expect(checkOffice(fakeZip([{ name: 'a.xml', compressed: 100_000, size: 2 * 1024 * 1024 }]))).toBe('ok');
  });
});

describe('형식별 미리 거르기(재검토 E6)', () => {
  it('슬라이드가 100장을 넘는 pptx 는 거른다', () => {
    const slides = (n: number) => fakeZip(Array.from({ length: n }, (_, i) => ({ name: `ppt/slides/slide${i + 1}.xml`, compressed: 100, size: 400 })));
    expect(preCheck('pptx', 'a.pptx', slides(100))).toBe('ok');
    expect(preCheck('pptx', 'a.pptx', slides(101))).toBe('tooManySlides');
  });

  it('HWP 5(CFB)는 암호로 보지 않고, HWPX 는 압축 폭탄만 본다', () => {
    const cfb = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(preCheck('hwp', 'a.hwp', cfb)).toBe('ok');
    expect(preCheck('hwp', 'a.hwpx', fakeZip([{ name: 'Contents/section0.xml', compressed: 1000, size: 300 * 1024 * 1024 }]))).toBe('bomb');
    expect(preCheck('hwp', 'a.hwpx', cfb)).toBe('ok');
    expect(preCheck('xlsx', 'a.xlsx', cfb)).toBe('encrypted');
  });
});

describe('scopeSvgIds', () => {
  // rhwp 는 쪽마다 칸 잘라내기 id 를 같은 번호로 다시 매긴다. 쪽 SVG 를 한 문서에 넣으면 url(#…) 이 앞쪽 것을 가리켜
  // 뒤쪽 표의 글자가 잘려 안 보였다(2026-10-27 OKE hwpx 미리보기, 안괴희 등).
  const page = (n: number) =>
    `<svg><defs><clipPath id="cell-clip-9"><rect x="${n}" y="0" width="10" height="10"/></clipPath></defs>` +
    `<g clip-path="url(#cell-clip-9)"><text>가</text></g><use href="#cell-clip-9"/><use xlink:href="#cell-clip-9"/></svg>`;

  it('gives each page its own ids and points every reference at them', () => {
    const one = scopeSvgIds(page(1), 1);
    const three = scopeSvgIds(page(3), 3);
    expect(one).toContain('id="p1-cell-clip-9"');
    expect(one).toContain('clip-path="url(#p1-cell-clip-9)"');
    expect(one).toContain('href="#p1-cell-clip-9"');
    expect(one).toContain('xlink:href="#p1-cell-clip-9"');
    expect(three).toContain('url(#p3-cell-clip-9)');
    expect(one).not.toMatch(/"cell-clip-9"|#cell-clip-9/);
  });

  it('leaves text and references to ids the page does not define alone', () => {
    const svg = '<svg><g clip-path="url(#outside)"><text>url(#cell-clip-9) id="x"</text></g></svg>';
    expect(scopeSvgIds(svg, 2)).toBe(svg);
  });
});
