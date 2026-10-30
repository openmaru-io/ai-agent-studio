/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 네트워크를 막은(127.0.0.1 만 허용) Chrome 으로 화면을 열어 외부 요청이 0건인지, 콘솔 오류가 없는지, WebGL 장면이 그려지는지 본다.
// 사용: npm run build && node parity/offline.mjs [해시 경로, 기본 #/office] [--shot 파일.png] [--wait 4000]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const hash = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '#/office';
const PORT = Number(process.env.PARITY_PORT || 17963);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const shot = arg('--shot', '');
const wait = Number(arg('--wait', '4000'));
const [vw, vh] = arg('--size', '1400x900').split('x').map(Number);

const server = spawn('python3', [resolve(HERE, 'mock_aas.py'), String(PORT)], { stdio: 'ignore' });
process.on('exit', () => server.kill());
for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(ORIGIN + '/')).ok) break;
  } catch { /* 서버가 뜰 때까지 기다린다 */ }
  await new Promise((r) => setTimeout(r, 100));
}

const browser = await chromium.launch({ channel: 'chrome', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: vw, height: vh } });
const external = [];
await ctx.route('**/*', (route) => {
  const url = route.request().url();
  if (url.startsWith(ORIGIN) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
  external.push(url);
  return route.abort();
});
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 200)));
page.on('pageerror', (e) => errors.push('PAGEERR ' + String(e).slice(0, 200)));
const failed = [];
page.on('requestfailed', (r) => failed.push(r.url().slice(0, 120)));

await page.goto(`${ORIGIN}/${hash}`);
await page.waitForTimeout(wait);
const info = await page.evaluate(() => {
  const c = document.querySelector('canvas');
  let gl = false;
  let nonBlank = false;
  if (c) {
    const g = c.getContext('webgl2') || c.getContext('webgl');
    gl = !!g;
  }
  return { canvas: !!c, w: c?.width, h: c?.height, gl, title: document.title };
});
if (shot) {
  mkdirSync(dirname(resolve(shot)), { recursive: true });
  await page.screenshot({ path: resolve(shot) });
}
await browser.close();
server.kill();

console.log(JSON.stringify({ hash, ...info, externalRequests: external.length, external: external.slice(0, 10), consoleErrors: errors.slice(0, 10), failedRequests: failed.slice(0, 10), shot: shot || null }, null, 2));
process.exit(external.length === 0 && info.canvas && errors.length === 0 ? 0 : 1);
