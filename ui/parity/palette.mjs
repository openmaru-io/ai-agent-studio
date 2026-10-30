/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 3D 오피스 색의 회귀 계약(스펙 2026-10-20-012 §10 E4)을 실제 브라우저 화면 픽셀로 잰다.
//  ② 편집 선택 외곽선이 두 테마에서 보인다  ③ 오류 상태 고리가 보인다  ④ 테마를 바꿔도 카메라(건물 윤곽 상자)가 그대로다
//  ⑤ 화면 대비: 외벽 대 배경 3:1 이상 4.5:1 이하(C5), 바닥 대 외벽 1.5:1 이상(C6)
// 배치는 parity/fixtures/office-layout.json(kr 기본 배치를 Vitest 로 뽑은 것)을 가짜 서버 대신 돌려준다. 배치 판본이 바뀌면 다시 뽑는다.
// 사용: npm run build && node parity/palette.mjs [--shots 디렉터리] [--prefix before|after] [--wait 6000]
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const PORT = Number(process.env.PARITY_PORT || 17964);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const shots = arg('--shots', '');
const prefix = arg('--prefix', 'after');
const wait = Number(arg('--wait', '6000'));
const LAYOUT = readFileSync(resolve(HERE, 'fixtures/office-layout.json'), 'utf8');

const server = spawn('python3', [resolve(HERE, 'mock_aas.py'), String(PORT)], { stdio: 'ignore' });
process.on('exit', () => server.kill());
for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(ORIGIN + '/')).ok) break;
  } catch { /* 서버가 뜰 때까지 기다린다 */ }
  await new Promise((r) => setTimeout(r, 100));
}

const browser = await chromium.launch({ channel: 'chrome', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
if (shots) mkdirSync(resolve(shots), { recursive: true });

const open = async (theme) => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addInitScript((t) => localStorage.setItem('aas-theme', t), theme);
  await ctx.route('**/api/office/layout', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ status: 200, contentType: 'application/json', body: LAYOUT }) : route.continue(),
  );
  const page = await ctx.newPage();
  await page.goto(`${ORIGIN}/#/office`);
  await page.waitForSelector('canvas', { timeout: 20000 });
  return { ctx, page };
};

const save = async (page, name) => {
  if (shots) await page.screenshot({ path: resolve(shots, `office-palette-${prefix}-${name}.png`) });
};

// 화면을 찍어 브라우저 안에서 픽셀을 센다(PNG 해독에 의존성을 더하지 않는다).
const measure = async (page) => {
  const png = (await page.screenshot()).toString('base64');
  const rect = await page.evaluate(() => {
    const r = document.querySelector('canvas').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  return page.evaluate(
    async ({ png, rect }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const data = g.getImageData(0, 0, c.width, c.height).data;
      const px = (x, y) => {
        const i = (Math.round(y) * c.width + Math.round(x)) * 4;
        return [data[i], data[i + 1], data[i + 2]];
      };
      const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      const hex = (p) => '#' + p.map((v) => v.toString(16).padStart(2, '0')).join('');
      // 배경: 캔버스 왼쪽 가운데(건물 밖). 배경은 둥근 그라데이션이라 배경과의 차이로는 건물을 가르지 못한다.
      // 바닥: 캔버스 가운데 부근(책상 섬 사이 통로)에서 가장 흔한 색 묶음. 건물 윤곽: 바닥 색에 가까운 픽셀의 상자
      // 외벽: 바닥 윤곽 맨 아래 꼭짓점에서 조금 아래(남쪽 외벽 바깥면)
      const backdrop = px(rect.x + 8, rect.y + rect.h * 0.55);
      const q = (p) => hex(p.map((v) => v & 0xf0));
      const counts = new Map();
      for (let y = rect.y + rect.h * 0.5; y < rect.y + rect.h * 0.8; y += 3)
        for (let x = rect.x + rect.w * 0.3; x < rect.x + rect.w * 0.7; x += 3) counts.set(q(px(x, y)), (counts.get(q(px(x, y))) ?? 0) + 1);
      const floorQ = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const fl = [0, 0, 0];
      let fn = 0;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, bottom = null;
      for (let y = rect.y + rect.h * 0.2; y < rect.y + rect.h - 4; y += 2)
        for (let x = rect.x + 4; x < rect.x + rect.w - 4; x += 2) {
          const p = px(x, y);
          if (q(p) !== floorQ) continue;
          fl[0] += p[0]; fl[1] += p[1]; fl[2] += p[2]; fn++;
          minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y);
          if (y > maxY) { maxY = y; bottom = [x, y]; }
        }
      const floor = fl.map((v) => Math.round(v / Math.max(fn, 1)));
      // 외벽 바깥면: 바닥 윤곽 맨 아래 꼭짓점에서 배경이 나올 때까지 내려가며 모은 픽셀의 가운데 값
      const face = [];
      if (bottom)
        for (let y = bottom[1] + 1; y < bottom[1] + 40; y++) {
          const p = px(bottom[0], y);
          if (dist(p, backdrop) < 14) break;
          face.push(p);
        }
      const wall = face.length ? face[Math.floor(face.length / 2)] : backdrop;
      // 카메라 비교용 윤곽 상자: 배경과 다른 픽셀(배경 그라데이션 가장자리를 피해 차이 40 이상)
      let bx0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (let y = rect.y + rect.h * 0.45; y < rect.y + rect.h - 4; y += 2)
        for (let x = rect.x + 4; x < rect.x + rect.w - 120; x += 2)
          if (dist(px(x, y), px(rect.x + 4, y)) > 40) { bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y); }
      // 오류 고리: 붉은 픽셀(현수막·명단 패널·도우미 그림 자리는 뺀다)
      let red = 0;
      for (let y = rect.y + rect.h * 0.18; y < rect.y + rect.h - 4; y += 1)
        for (let x = rect.x + 4; x < rect.x + rect.w - 4; x += 1) {
          if (x > rect.x + rect.w - 310 && y < rect.y + rect.h * 0.36) continue;
          if (x > rect.x + rect.w - 120 && y > rect.y + rect.h * 0.8) continue;
          const [r, g2, b] = px(x, y);
          if (r > 140 && r > g2 * 2 && r > b * 2) red++;
        }
      return { backdrop: hex(backdrop), floor: hex(floor), wall: hex(wall), floorBox: [minX, minY, maxX, maxY], box: [bx0, by1, bx1], redPixels: red };
    },
{ png, rect },
  );
};

const lum = (h) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
};

const report = { checks: [] };
const check = (name, ok, detail) => report.checks.push({ name, ok, ...detail });

for (const theme of ['dark', 'light']) {
  const { ctx, page } = await open(theme);
  await page.waitForTimeout(300);
  await save(page, `${theme}-loading`);
  await page.waitForTimeout(wait);
  await save(page, `${theme}-overview`);
  const m = await measure(page);
  check(`${theme} C5 외벽 대 배경 3:1 이상 4.5:1 이하`, ratio(m.wall, m.backdrop) >= 3 && ratio(m.wall, m.backdrop) <= 4.5, { wall: m.wall, backdrop: m.backdrop, ratio: ratio(m.wall, m.backdrop) });
  check(`${theme} C6 바닥 대 외벽 1.5:1 이상`, ratio(m.floor, m.wall) >= 1.5, { floor: m.floor, wall: m.wall, ratio: ratio(m.floor, m.wall) });
  check(`${theme} ③ 오류 고리(붉은 픽셀)가 보인다`, m.redPixels >= 6, { redPixels: m.redPixels });

  // ② 편집 선택 외곽선: 배치 편집을 열고 바닥 가운데 근처의 가구를 누른 뒤, 선택색 픽셀이 늘었는지 본다
  const edit = page.getByRole('button', { name: '배치 편집' });
  if ((await edit.count()) === 0) {
    check(`${theme} ② 편집 선택 외곽선`, false, { reason: '배치 편집 단추가 없다' });
  } else {
    await edit.click();
    await page.waitForTimeout(1500);
    const sel = theme === 'dark' ? [247, 248, 248] : [17, 24, 39];
    // 선택색 픽셀은 캔버스 안, 왼쪽 위 편집 패널(폭 300) 밖에서만 센다 — 라이트 패널 글자색이 #111827 이다
    const area = await page.evaluate(() => {
      const b = document.querySelector('canvas').getBoundingClientRect();
      return { x: b.left + 310, y: b.top + 20, x2: b.right - 330, y2: b.bottom - 20 };
    });
    const countSel = async () =>
      page.evaluate(async ({ png, sel, area }) => {
        const img = new Image();
        img.src = `data:image/png;base64,${png}`;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let y = Math.round(area.y); y < area.y2; y++)
          for (let x = Math.round(area.x); x < area.x2; x++) {
            const i = (y * c.width + x) * 4;
            if (Math.abs(d[i] - sel[0]) + Math.abs(d[i + 1] - sel[1]) + Math.abs(d[i + 2] - sel[2]) < 24) n++;
          }
        return n;
      }, { png: (await page.screenshot()).toString('base64'), sel, area });
    const before = await countSel();
    // 책상 섬이 많은 바닥 가운데 위쪽 몇 곳을 차례로 누른다. 가구를 고르면 편집 패널이 이름을 보인다
    const r = await page.evaluate(() => {
      const b = document.querySelector('canvas').getBoundingClientRect();
      return { x: b.left, y: b.top, w: b.width, h: b.height };
    });
    let gained = 0;
    let picked = false;
    const rotate = page.getByRole('button', { name: '왼쪽으로 돌리기' });
    for (let fy = 0.42; fy <= 0.8 && !picked; fy += 0.04)
      for (let fx = 0.42; fx <= 0.72 && !picked; fx += 0.04) {
        await page.mouse.click(r.x + r.w * fx, r.y + r.h * fy);
        await page.waitForTimeout(250);
        picked = (await rotate.count()) > 0;
      }
    if (picked) {
      await page.mouse.move(r.x + 4, r.y + r.h - 4); // 호버 외곽선을 빼고 선택 외곽선만 본다
      await page.waitForTimeout(500);
      gained = (await countSel()) - before;
    }
    if (shots) await save(page, `${theme}-selected`);
    check(`${theme} ② 편집 선택 외곽선 픽셀이 늘었다`, picked && gained >= 30, { picked, gained });
  }
  await ctx.close();

  // ④ 테마를 바꿔도 카메라가 그대로다: 새 화면에서 확대해 처음 구도와 다르게 한 뒤, 테마를 바꿨다가 되돌리고 같은 테마에서 바닥 윤곽 상자를 비교한다.
  // 테마가 Canvas 를 다시 만들면 카메라가 처음 구도로 돌아가 상자가 크게 달라진다. 같은 화면을 두 번 재어 잡음을 먼저 본다
  {
    const { ctx: c2, page: p2 } = await open(theme);
    await p2.waitForTimeout(wait);
    const start = await measure(p2);
    const mid = await p2.evaluate(() => {
      const b = document.querySelector('canvas').getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height * 0.6 };
    });
    await p2.mouse.move(mid.x, mid.y);
    for (let n = 0; n < 4; n++) {
      await p2.mouse.wheel(0, -240);
      await p2.waitForTimeout(150);
    }
    await p2.waitForTimeout(2500);
    const zoomed = await measure(p2);
    await save(p2, `${theme}-zoom`);
    await p2.waitForTimeout(800);
    const zoomed2 = await measure(p2);
    const diff = (a, b) => Math.max(...a.floorBox.map((v, n) => Math.abs(v - b.floorBox[n])));
    const other = theme === 'dark' ? '라이트 모드' : '다크 모드';
    await p2.getByRole('button', { name: other }).click();
    await p2.waitForTimeout(1500);
    const switched = await measure(p2);
    check(`${theme}→전환 ④ 바닥 색이 바뀐다`, switched.floor !== zoomed.floor, { before: zoomed.floor, after: switched.floor });
    await p2.getByRole('button', { name: theme === 'dark' ? '다크 모드' : '라이트 모드' }).click();
    await p2.waitForTimeout(2000);
    const back = await measure(p2);
    const noise = diff(zoomed, zoomed2);
    check(`${theme} ④ 확대한 카메라가 테마 전환 뒤에도 그대로`, diff(start, zoomed) > 30 && diff(zoomed, back) <= noise + 6, {
      zoomChanged: diff(start, zoomed),
      noise,
      moved: diff(zoomed, back),
    });
    await c2.close();
  }
}

await browser.close();
server.kill();
console.log(JSON.stringify(report, null, 2));
process.exit(report.checks.every((c) => c.ok) ? 0 : 1);
