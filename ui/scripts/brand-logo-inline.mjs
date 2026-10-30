/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 서버가 그리는 화면(로그인·안내)에 HTML 안으로 넣을 브랜드 로고 사본을 만든다(OMAI-1299, 스펙 2026-10-17-013).
// 원본은 ui/src/assets/logo/<BRAND>_CogentAI_rw_h.svg(빨강+흰 글자). 한 HTML 문서 안에 넣으므로
//  - <style> 의 .cls-N 을 각 요소의 fill 속성으로 풀어 다른 SVG 와 클래스가 겹치지 않게 하고,
//  - 흰색(#fff·#ffffff)은 currentColor 로 바꿔 밝은 테마에서도 글자가 보이게 한다(OMAI-1128 과 같은 손질).
// 실행: node ui/scripts/brand-logo-inline.mjs  (저장소 루트에서) → aas/web/brand/<BRAND>_CogentAI_logo.svg
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BRANDS = ['OPENMARU', 'MSAP', 'AINP'];
const WHITE = new Set(['#fff', '#ffffff', 'white']);

export function inlineLogo(svg, label) {
  const fills = {};
  for (const m of svg.matchAll(/\.(cls-\d+)\s*\{\s*fill:\s*([^;}\s]+)\s*;?\s*\}/g)) fills[m[1]] = m[2].toLowerCase();
  const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1];
  if (!viewBox || !Object.keys(fills).length) throw new Error('viewBox 나 .cls-N 채움이 없습니다');
  const body = svg
    .replace(/^[\s\S]*?<\/defs>/, '')          // xml 선언·<svg> 여는 태그·<defs> 를 버린다
    .replace(/<\/svg>\s*$/, '')
    .replace(/\s(?:id|data-name)="[^"]*"/g, '')
    .replace(/class="(cls-\d+)"/g, (_, c) => {
      const f = fills[c];
      if (!f) throw new Error(`정의되지 않은 클래스: ${c}`);
      return `fill="${WHITE.has(f) ? 'currentColor' : f}"`;
    })
    .replace(/\s+/g, ' ')
    .trim();
  return `<svg role="img" aria-label="${label}" class="brand-logo" xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const brand of BRANDS) {
    const src = join(ROOT, 'ui/src/assets/logo', `${brand}_CogentAI_rw_h.svg`);
    const out = join(ROOT, 'aas/web/brand', `${brand}_CogentAI_logo.svg`);
    const head = `<!-- Copyright 2026 The OPENMARU Authors. ui/src/assets/logo/${brand}_CogentAI_rw_h.svg 에서 ui/scripts/brand-logo-inline.mjs 로 만든 사본. 흰 글자를 currentColor 로 바꿔 밝은 테마에서도 보인다(OMAI-1128·1299) -->\n`;
    writeFileSync(out, head + inlineLogo(readFileSync(src, 'utf8'), `${brand} CogentAI`));
    console.log(out);
  }
}
