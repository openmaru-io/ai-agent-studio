// Copyright 2026 OPENMARU, Inc.
// SPDX-License-Identifier: Apache-2.0
// 큰 wasm 을 미리 gzip 으로 압축해 옆에 둔다(스펙 2026-10-20-005 §7 D7). 한글 보기 wasm 이 11.9 MB → 약 4.4 MB.
// 서버(aas/web/static_assets.py)는 Accept-Encoding 에 gzip 이 있으면 .gz 를 Content-Encoding: gzip 으로 낸다.
// vite build 뒤, 에어갭 검사 앞에 돈다(package.json build). 원본은 그대로 둔다(gzip 을 받지 않는 클라이언트용).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

export function compressAssets(outDir) {
  const dir = join(outDir, 'assets');
  const done = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.wasm')) continue;
    const raw = readFileSync(join(dir, name));
    const gz = gzipSync(raw, { level: 9 });
    writeFileSync(join(dir, `${name}.gz`), gz);
    done.push(`${name} ${(raw.length / 1048576).toFixed(1)} MB → ${(gz.length / 1048576).toFixed(1)} MB`);
  }
  return done;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) {
    console.error('사용법: node scripts/compress-assets.mjs <빌드 폴더>');
    process.exit(2);
  }
  for (const line of compressAssets(out)) console.log(`미리 압축: ${line}`);
}
