// Copyright 2026 OPENMARU, Inc.
// SPDX-License-Identifier: Apache-2.0
// pdf.js 가 필요할 때 받는 부가 파일(cmaps·standard_fonts·wasm)을 빌드 산출물로 복사한다(스펙 2026-10-20-005 §5-2).
// 이름에 해시가 없어 /assets/ 의 1년 캐시를 받으므로 폴더에 pdfjs-dist 버전을 넣는다(외부 검토 OV6).
// vite build(emptyOutDir) 뒤, 에어갭 검사 앞에 돈다(package.json build). quickjs-eval(PDF 안 스크립트 실행)은 쓰지 않아 빼고, LICENSE 는 함께 둔다.
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const SRC = dirname(require.resolve('pdfjs-dist/package.json'));
const VERSION = require('pdfjs-dist/package.json').version;
const SKIP = /^quickjs-eval\./;

export function copyPdfjsAssets(outDir) {
  const dest = join(outDir, 'assets', `pdfjs-${VERSION}`);
  let n = 0;
  for (const sub of ['cmaps', 'standard_fonts', 'wasm']) {
    mkdirSync(join(dest, sub), { recursive: true });
    for (const name of readdirSync(join(SRC, sub))) {
      if (SKIP.test(name)) continue;
      cpSync(join(SRC, sub, name), join(dest, sub, name));
      n++;
    }
  }
  return { dest, n };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out || !existsSync(out)) {
    console.error('사용법: node scripts/copy-pdfjs-assets.mjs <빌드 폴더>');
    process.exit(2);
  }
  const { dest, n } = copyPdfjsAssets(out);
  console.log(`pdf.js 부가 파일 ${n}개 복사: ${dest}`);
}
