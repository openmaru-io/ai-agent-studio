/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 번들 글꼴로 그릴 수 있는 글자만 남기는 순수 함수. 3D 글자(Text.tsx)와 설정 화면의 안내(부서 문구)가 함께 쓴다.
// three·drei 를 끌어오지 않도록 Text.tsx 에서 나눴다.
// 번들 글꼴(NotoSansKR-Regular-subset.woff)이 가진 글자 구간. 이 밖의 글자(이모지 등)가 섞이면 troika 가
// 대체 글꼴을 찾으려고 외부 저장소(cdn.jsdelivr.net)에 요청하므로, 그리기 전에 빼 둔다.
const COVERED: ReadonlyArray<readonly [number, number]> = [
  [0x0a, 0x0a], [0x20, 0x7e], [0xa0, 0xff], [0x2002, 0x2003], [0x2010, 0x2016], [0x2018, 0x201a],
  [0x201c, 0x201e], [0x2020, 0x2022], [0x2025, 0x2027], [0x2030, 0x2030], [0x2032, 0x2033],
  [0x2035, 0x2035], [0x2039, 0x203c], [0x2042, 0x2042], [0x2047, 0x2049], [0x2051, 0x2051],
  [0x20a9, 0x20a9], [0x2190, 0x2199], [0x2713, 0x2713], [0x3000, 0x303f], [0x3131, 0x3163],
  [0xac00, 0xd7a3],
];

function covered(cp: number): boolean {
  return COVERED.some(([a, b]) => cp >= a && cp <= b);
}

export function keepCoveredGlyphs(text: string): string {
  let out = "";
  for (const ch of text) if (covered(ch.codePointAt(0) as number)) out += ch;
  return out;
}
