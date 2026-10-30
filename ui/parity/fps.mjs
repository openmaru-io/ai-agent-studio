/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 오피스 3D 장면의 프레임 속도를 에이전트 수별로 잰다(계획 003 §6). 사용: npm run build && node parity/fps.mjs [3 20 50] [--seconds 6]
// 기본은 소프트웨어 렌더링(SwiftShader, GPU 없음)이라 절대값이 실제 장비보다 낮다. `--gpu` 를 주면 이 장비의 GPU 를 쓴다(렌더러 이름을 함께 찍는다).
// 사용: node parity/fps.mjs [에이전트 수…] [--seconds 6] [--gpu]
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { chromium } from 'playwright-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const GPU = args.includes('--gpu');
const secs = Number(args.includes('--seconds') ? args[args.indexOf('--seconds') + 1] : 6);
const counts = args.filter((a) => /^\d+$/.test(a)).map(Number);
const SIZES = counts.length ? counts : [3, 20, 50];

async function run(n, port) {
  const server = spawn('python3', [path.join(HERE, 'mock_aas.py'), String(port)], { stdio: 'ignore', env: { ...process.env, MOCK_AGENTS: String(n) } });
  try {
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break;
      } catch { /* 서버가 뜰 때까지 기다린다 */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    const browser = await chromium.launch({ channel: 'chrome', args: GPU ? ['--ignore-gpu-blocklist', '--enable-gpu-rasterization'] : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();
    // 그리기 호출 수는 GPU 와 상관없는 값이다. 프레임당 몇 번 그리는지 센다.
    await page.addInitScript(() => {
      window.__draws = 0;
      for (const C of [WebGL2RenderingContext, WebGLRenderingContext])
        for (const k of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
          const orig = C.prototype[k];
          if (orig)
            C.prototype[k] = function (...a) {
              window.__draws++;
              return orig.apply(this, a);
            };
        }
    });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Performance.enable');
    const metric = async (name) => (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === name)?.value ?? 0;
    await page.goto(`http://127.0.0.1:${port}/#/office`);
    await page.waitForSelector('canvas', { timeout: 20000 });
    await page.waitForTimeout(5000); // 모델 적재와 첫 장면이 끝나길 기다린다
    const draws0 = await page.evaluate(() => window.__draws);
    const [script0, task0] = [await metric('ScriptDuration'), await metric('TaskDuration')];
    const r = await page.evaluate(
      (ms) =>
        new Promise((resolve) => {
          const stamps = [];
          const t0 = performance.now();
          const tick = (t) => {
            stamps.push(t);
            if (t - t0 < ms) requestAnimationFrame(tick);
            else {
              const gaps = stamps.slice(1).map((x, i) => x - stamps[i]).sort((a, b) => a - b);
              resolve({ frames: stamps.length, fps: (stamps.length - 1) / ((stamps.at(-1) - stamps[0]) / 1000), p50: gaps[Math.floor(gaps.length * 0.5)], p95: gaps[Math.floor(gaps.length * 0.95)], max: gaps.at(-1) });
            }
          };
          requestAnimationFrame(tick);
        }),
      secs * 1000
    );
    const script = ((await metric('ScriptDuration')) - script0) / secs; // 초당 자바스크립트 실행 시간(초)
    const task = ((await metric('TaskDuration')) - task0) / secs; // 초당 메인 스레드 작업 시간(초)
    const renderer = await page.evaluate(() => {
      const g = document.createElement('canvas').getContext('webgl2');
      const x = g?.getExtension('WEBGL_debug_renderer_info');
      return x ? g.getParameter(x.UNMASKED_RENDERER_WEBGL) : '알 수 없음';
    });
    const drawsPerFrame = ((await page.evaluate(() => window.__draws)) - draws0) / r.frames;
    const agents = await page.evaluate(() => document.querySelectorAll('canvas').length);
    await browser.close();
    return { agents: n, canvases: agents, ...r, scriptMs: script * 1000, taskMs: task * 1000, drawsPerFrame, renderer };
  } finally {
    server.kill();
  }
}

console.log(GPU ? '(GPU 사용)' : '(소프트웨어 렌더링)');
console.log('에이전트 수 · fps · 프레임 간격 중앙값/95%/최대(ms) · 초당 스크립트/메인 스레드 작업(ms) · 프레임당 그리기 호출');
for (const [i, n] of SIZES.entries()) {
  const r = await run(n, 17970 + i);
  if (i === 0) console.log(`렌더러: ${r.renderer}`);
  console.log(`${String(r.agents).padStart(4)}명 · ${r.fps.toFixed(1).padStart(5)} fps · ${r.p50.toFixed(0)} / ${r.p95.toFixed(0)} / ${r.max.toFixed(0)} ms · ${r.scriptMs.toFixed(0)} / ${r.taskMs.toFixed(0)} ms · ${r.drawsPerFrame.toFixed(0)}회`);
}
