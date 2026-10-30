/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 문서 뷰어 브라우저 시험(스펙 2026-10-20-005 §13-3, 외부 검토 OV7). 바깥망을 막은 Chrome 으로 PDF·암호 PDF·DOCX 를 열어 본다.
// offline.mjs 는 해시 주소만 열고 canvas 를 요구해 문서를 열지 못하므로 따로 둔다.
// 개발 서버(vite)는 화면 모듈을 주소로 불러올 수 있어, 화면이 쓰는 그 viewerStore 로 뷰어를 연다(화면 코드에 시험용 문을 두지 않는다).
// 받기 API 는 가짜 서버(mock_aas.py)가 parity/fixtures 의 표본으로 답한다. 정적 파일 형식(.mjs·.wasm)은 tests/test_static.py 가 실제 서버로 본다.
// 사용: node parity/viewer-offline.mjs [--shots[=<폴더>]]   (캡처 폴더를 주지 않으면 ../../cogentai-aas-docs/docs-plan/capture/)
// HWP·HWPX 는 공공 문서 표본이라 레포에 넣지 않는다: VIEWER_EXTRA=<s.hwp·s.hwpx 가 있는 폴더> 를 주면 그 절도 돈다
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK = Number(process.env.VIEWER_MOCK_PORT || 17964);
const DEV = Number(process.env.VIEWER_DEV_PORT || 3017);
const ORIGIN = `http://127.0.0.1:${DEV}`;
const SHOTS_ARG = process.argv.find((a) => a === '--shots' || a.startsWith('--shots='));
const SHOTS = Boolean(SHOTS_ARG);
const CAPTURE = SHOTS_ARG?.startsWith('--shots=')
  ? resolve(SHOTS_ARG.slice('--shots='.length))
  : resolve(HERE, '..', '..', '..', 'cogentai-aas-docs', 'docs-plan', 'capture');

const kids = [
  spawn('python3', [resolve(HERE, 'mock_aas.py'), String(MOCK)], { stdio: 'ignore', env: { ...process.env, VIEWER_EXTRA: process.env.VIEWER_EXTRA || '' } }),
  spawn('npx', ['vite', '--port', String(DEV), '--strictPort', '--host', '127.0.0.1'], {
    cwd: resolve(HERE, '..'),
    env: { ...process.env, AAS_API: `http://127.0.0.1:${MOCK}` },
    stdio: 'ignore',
  }),
];
const stop = () => kids.forEach((k) => k.kill());
process.on('exit', stop);
for (let i = 0; i < 200; i++) {
  try {
    if ((await fetch(ORIGIN + '/')).ok) break;
  } catch {
    /* 서버가 뜰 때까지 기다린다 */
  }
  await new Promise((r) => setTimeout(r, 150));
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({ channel: 'chrome' });
async function session(scheme = 'light', viewport = { width: 1400, height: 900 }) {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme, hasTouch: viewport.width < 600 });
  const external = [];
  // Worker 안 요청도 이 route 로 잡히는지 보려고 요청 주소를 따로 모은다(OV7)
  const seen = [];
  await ctx.route('**/*', (route) => {
    const url = route.request().url();
    seen.push(url);
    if (url.startsWith(ORIGIN) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    external.push(url);
    return route.abort();
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${ORIGIN}/#/`);
  await page.waitForLoadState('networkidle');
  const open = (name) =>
    page.evaluate(async (n) => {
      const m = await import('/src/components/files/viewerStore.ts');
      m.openViewer({ name: n, url: `/api/chat/files?pod=p&path=workspace%2F${n}`, source: 'agent', path: `workspace/${n}` });
    }, name);
  return { ctx, page, external, errors, seen, open };
}
const shot = async (page, name) => {
  if (!SHOTS) return;
  mkdirSync(CAPTURE, { recursive: true });
  await page.screenshot({ path: resolve(CAPTURE, name) });
};

try {
  // ---- 30쪽 PDF ----------------------------------------------------------------
  {
    const { ctx, page, external, errors, seen, open } = await session();
    await open('pages-30.pdf');
    const dlg = page.getByRole('dialog', { name: 'pages-30.pdf' });
    await dlg.getByText('1 / 30쪽').waitFor({ timeout: 20000 });
    check('PDF 쪽 번호가 머리에 보인다', true);
    const pw = await dlg.locator('.react-pdf__Page').first().evaluate((el) => el.getBoundingClientRect().width);
    check('PDF 종이 폭은 맞춤 상한 960px(DV1)', pw <= 961 && pw > 600, `${Math.round(pw)}px`);
    await page.waitForTimeout(800);
    const canvases = await dlg.locator('canvas').count();
    check('보이는 쪽 근처만 그린다(최대 7쪽, 리뷰 D5)', canvases > 0 && canvases <= 7, `canvas ${canvases}개`);
    const focused = await page.evaluate(() => document.activeElement?.hasAttribute('data-doc-scroll'));
    check('처음 포커스는 실제 스크롤 상자(OV2-M1)', !!focused);
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(300);
    const top = await dlg.locator('[data-doc-scroll]').evaluate((el) => el.scrollTop);
    check('PageDown 으로 스크롤된다', top > 0, `scrollTop ${top}`);
    await shot(page, 'file-viewer-pdf-light.png');

    await dlg.getByRole('button', { name: '다음 쪽' }).click();
    await page.waitForTimeout(400);
    check('다음 쪽 단추로 쪽이 바뀐다', (await dlg.getByText(/\d+ \/ 30쪽/).textContent()) !== '1 / 30쪽');

    await dlg.getByRole('button', { name: '확대' }).click();
    check('확대 단추는 25% 씩(재검토 D5)', await dlg.getByText('125%').isVisible());
    await dlg.getByRole('button', { name: '축소' }).click();

    await page.keyboard.press('Control+f');
    const find = dlg.getByRole('textbox', { name: '문서에서 찾기' });
    await find.waitFor({ timeout: 5000 });
    await find.fill('needle');
    await dlg.getByText('1 / 1', { exact: true }).waitFor({ timeout: 15000 });
    check('Ctrl+F 전체 찾기가 25쪽의 낱말을 찾는다(DV16)', true);
    await page.waitForTimeout(800);
    check('찾은 쪽으로 간다', await dlg.getByText('25 / 30쪽').isVisible());
    check('찾은 곳을 표시한다(mark)', (await dlg.locator('mark[data-current]').count()) > 0);
    await shot(page, 'file-viewer-pdf-find.png');
    await find.press('Escape');
    await page.waitForTimeout(300);
    check('Esc 는 찾기 줄만 닫는다(OV2-L1)', (await dlg.isVisible()) && !(await find.isVisible()));

    await dlg.getByRole('button', { name: '이전 쪽' }).waitFor();
    await page.evaluate(async () => {
      const m = await import('/src/components/files/docs/docStore.ts');
      m.docStore.goto(1);
    });
    await page.waitForTimeout(800);
    const ext = dlg.locator('.annotationLayer a[title*="example.com"]');
    check('바깥 링크는 주소만 풍선말로(DV14)', (await ext.count()) > 0);
    if (await ext.count()) {
      const before = page.url();
      await ext.first().click({ force: true });
      await page.waitForTimeout(400);
      check('바깥 링크를 눌러도 이동하지 않는다', page.url() === before && ctx.pages().length === 1);
    }
    check('바깥 요청 0건', external.length === 0, external.slice(0, 3).join(', '));
    check('작업 스레드 요청이 route 에 잡힌다(OV7)', seen.some((u) => u.includes('pdf.worker')));
    check('페이지 오류 없음', errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close();
  }

  // ---- 좁은 화면(390px) ----------------------------------------------------------
  {
    const { ctx, page, external, open } = await session('dark', { width: 390, height: 800 });
    await open('pages-30.pdf');
    const dlg = page.getByRole('dialog', { name: 'pages-30.pdf' });
    await dlg.getByText('1 / 30쪽').waitFor({ timeout: 20000 });
    const pw = await dlg.locator('.react-pdf__Page').first().evaluate((el) => el.getBoundingClientRect().width);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    check('좁은 화면: 폭 맞춤(여백 8px)·가로 넘침 없음(DV13)', pw >= 340 && pw <= 382 && !overflow, `${Math.round(pw)}px`);
    await dlg.getByRole('button', { name: '더 보기' }).click();
    check('좁은 화면: 확대·찾기는 「…」 안(DV1)', await page.getByRole('menuitem', { name: '문서에서 찾기' }).isVisible());
    await page.keyboard.press('Escape');
    await shot(page, 'file-viewer-pdf-narrow.png');
    check('바깥 요청 0건(좁은 화면)', external.length === 0);
    await ctx.close();
  }

  // ---- 암호 PDF ----------------------------------------------------------------
  {
    const { ctx, page, external, open } = await session();
    await open('locked.pdf');
    const dlg = page.getByRole('dialog', { name: 'locked.pdf' });
    await dlg.getByText('암호가 걸린 PDF 입니다').waitFor({ timeout: 20000 });
    const pw = dlg.getByLabel('비밀번호');
    check('비밀번호 칸에 포커스(OV2-L2)', await pw.evaluate((el) => el === document.activeElement));
    await pw.fill('wrong');
    await pw.press('Enter');
    await dlg.getByText('비밀번호가 맞지 않습니다').waitFor({ timeout: 10000 });
    check('틀린 비밀번호는 칸 아래 문구(DV4)', true);
    await shot(page, 'file-viewer-pdf-password.png');
    await dlg.getByLabel('비밀번호').fill('open-sesame');
    await dlg.getByLabel('비밀번호').press('Enter');
    await dlg.getByText('1 / 2쪽').waitFor({ timeout: 10000 });
    check('맞는 비밀번호면 열린다', true);
    check('바깥 요청 0건(암호 PDF)', external.length === 0);
    await ctx.close();
  }

  // ---- DOCX (밝음·어두움) -------------------------------------------------------
  for (const scheme of ['light', 'dark']) {
    const { ctx, page, external, errors, open } = await session(scheme);
    await open('sample.docx');
    const dlg = page.getByRole('dialog', { name: 'sample.docx' });
    const frame = dlg.locator('iframe[title="sample.docx"]');
    await frame.waitFor({ timeout: 20000 });
    await page.waitForTimeout(2000);
    const info = await frame.evaluate((f) => {
      const d = f.contentDocument;
      const wrap = d?.querySelector('.docx-wrapper');
      return {
        sandbox: f.getAttribute('sandbox'),
        sections: d?.querySelectorAll('section.docx').length ?? 0,
        height: f.clientHeight,
        csp: !!d?.querySelector('meta[http-equiv="Content-Security-Policy"]'),
        wrapperBg: wrap ? getComputedStyle(wrap).backgroundColor : '',
        paperWidth: d?.querySelector('section.docx')?.getBoundingClientRect().width ?? 0,
        zoom: d ? Number(getComputedStyle(d.body).zoom) : 0,
        paperShadow: d?.querySelector('section.docx') ? getComputedStyle(d.querySelector('section.docx')).boxShadow : '',
      };
    });
    check(`DOCX iframe 에 CSP 가 남아 있다(${scheme})`, info.csp);
    check(`DOCX 종이 폭은 맞춤 상한 960px 안(DV1, ${scheme})`, info.paperWidth <= 961 && info.paperWidth > 600, `${Math.round(info.paperWidth)}px (zoom ${info.zoom.toFixed(3)})`); // getBoundingClientRect 는 zoom 을 이미 반영한다
    check(`docx-preview 회색 바탕·그림자를 끈다(DV9, ${scheme})`, info.wrapperBg === 'rgba(0, 0, 0, 0)' && info.paperShadow === 'none', `${info.wrapperBg} / ${info.paperShadow}`);
    check(`DOCX 를 격리 iframe 에 그린다(${scheme})`, info.sandbox === 'allow-same-origin' && info.sections > 0, JSON.stringify(info));
    check(`DOCX iframe 높이를 내용에 맞춘다(${scheme})`, info.height > 300, `${info.height}px`);
    check(`바깥 요청 0건(DOCX ${scheme})`, external.length === 0, external.slice(0, 3).join(', '));
    check(`페이지 오류 없음(DOCX ${scheme})`, errors.length === 0, errors.slice(0, 2).join(' | '));
    await shot(page, `file-viewer-docx-${scheme}.png`);
    await ctx.close();
  }
  // ---- XLSX(2단계) ---------------------------------------------------------------
  {
    const { ctx, page, external, errors, open } = await session('dark');
    await open('table.xlsx');
    const dlg = page.getByRole('dialog', { name: 'table.xlsx' });
    await dlg.getByRole('tab', { name: '매출' }).waitFor({ timeout: 30000 });
    const tabs = await dlg.getByRole('tab').allTextContents();
    check('XLSX 시트 탭, 숨은 시트는 뺀다(DV10)', tabs.join('|') === '매출|빈 시트', tabs.join('|'));
    check('XLSX 1,000줄 넘으면 잘림 띠', await dlg.getByText('앞 1,000줄·100열만 보입니다').isVisible());
    const row = await dlg.locator('tbody tr').filter({ hasText: '항목1' }).first().locator('td').allTextContents();
    check('XLSX 표시 형식: 천 단위·퍼센트·날짜·결과 없는 수식(재검토 D6)', row.join('|') === '항목1|1,000.50|0.1%|2026-01-02|=B2*2', row.join('|'));
    const align = await dlg.locator('tbody tr').filter({ hasText: '항목1' }).first().locator('td').nth(1).evaluate((el) => getComputedStyle(el).textAlign);
    check('XLSX 숫자는 오른쪽 정렬', align === 'right', align);
    const head = await dlg.locator('thead th').allTextContents();
    check('XLSX 열 머리 A·B·C', head.slice(1, 6).join('') === 'ABCDE', head.slice(0, 6).join(','));
    const rendered = await dlg.locator('tbody tr:not([aria-hidden])').count();
    check('XLSX 보이는 줄만 그린다(재검토 D9)', rendered > 10 && rendered < 200, `${rendered}줄`);
    const merged = await dlg.locator('tbody tr').first().locator('td').nth(1).textContent();
    check('XLSX 병합 칸은 왼쪽 위에만 값', merged === '', JSON.stringify(merged));
    check('XLSX 는 확대 단추가 없다', (await dlg.getByRole('button', { name: '확대' }).count()) === 0);
    await shot(page, 'file-viewer-xlsx-dark.png');
    await dlg.getByRole('tab', { name: '빈 시트' }).click();
    check('XLSX 빈 시트 문구(DV5)', await dlg.getByText('이 시트는 비어 있습니다').isVisible());
    check('바깥 요청 0건(XLSX)', external.length === 0, external.slice(0, 3).join(', '));
    check('페이지 오류 없음(XLSX)', errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close();
  }

  // ---- PPTX(2단계) ---------------------------------------------------------------
  {
    const { ctx, page, external, errors, open } = await session('dark');
    await open('deck.pptx');
    const dlg = page.getByRole('dialog', { name: 'deck.pptx' });
    await dlg.getByText('슬라이드 1 / 3').waitFor({ timeout: 30000 }).catch(async (e) => {
      console.log('PPTX 대화 상자:', (await dlg.innerText().catch(() => '')).slice(0, 400), '| 오류:', errors.join(' | '));
      throw e;
    });
    check('PPTX 머리에 슬라이드 번호(DV15)', true);
    await page.waitForTimeout(1500);
    const info = await dlg.locator('iframe[title="deck.pptx"]').evaluate((f) => {
      const d = f.contentDocument;
      const slides = d?.querySelectorAll('.pptx-preview-slide-wrapper') ?? [];
      return { slides: slides.length, sandbox: f.getAttribute('sandbox'), csp: !!d?.querySelector('meta[http-equiv="Content-Security-Policy"]'), w: slides[0]?.getBoundingClientRect().width ?? 0, h: f.clientHeight };
    });
    check('PPTX 슬라이드를 세로로 쌓아 격리 iframe 에 그린다', info.slides === 3 && info.sandbox === 'allow-same-origin' && info.csp, JSON.stringify(info));
    check('PPTX 슬라이드 폭은 맞춤 상한 960px 안', info.w > 600 && info.w <= 961, `${Math.round(info.w)}px`);
    check('PPTX 원본과 다를 수 있다는 띠(DV6)', await dlg.getByText('미리 보기라 원본과 모양이 다를 수 있습니다').isVisible());
    await dlg.getByRole('button', { name: '다음 쪽' }).click();
    await page.waitForTimeout(500);
    check('PPTX 다음 단추로 슬라이드가 바뀐다', await dlg.getByText('슬라이드 2 / 3').isVisible());
    await shot(page, 'file-viewer-pptx-dark.png');
    check('바깥 요청 0건(PPTX)', external.length === 0, external.slice(0, 3).join(', '));
    check('페이지 오류 없음(PPTX)', errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close();
  }
  {
    const { ctx, page, open } = await session('dark');
    await open('big-deck.pptx');
    const dlg = page.getByRole('dialog', { name: 'big-deck.pptx' });
    await dlg.getByText('슬라이드가 많아 미리 볼 수 없습니다').waitFor({ timeout: 20000 });
    check('PPTX 101장은 작은 창(재검토 E6)', true);
    await ctx.close();
  }

  // ---- HWP·HWPX(2단계, VIEWER_EXTRA 가 있을 때) -----------------------------------
  if (process.env.VIEWER_EXTRA) {
    for (const [name, pages] of [['s.hwp', 6], ['s.hwpx', 30]]) {
      const { ctx, page, external, errors, seen, open } = await session('dark');
      // wasm 받기를 늦춰 진행 막대를 본다(디자인 DV3)
      await ctx.route('**/*.wasm', async (route) => {
        await new Promise((r) => setTimeout(r, 1800));
        return route.continue();
      });
      await open(name);
      const dlg = page.getByRole('dialog', { name });
      const preparing = await dlg.getByText('한글 보기 준비 중', { exact: false }).waitFor({ timeout: 8000 }).then(() => true, () => false);
      check(`HWP 받는 동안 진행 표시(${name})`, preparing);
      await dlg.getByText(`1 / ${pages}쪽`).waitFor({ timeout: 40000 });
      check(`HWP 쪽 번호(${name})`, true);
      await page.waitForTimeout(1500);
      const info = await dlg.locator(`iframe[title="${name}"]`).evaluate((f) => {
        const d = f.contentDocument;
        return { slots: d?.querySelectorAll('.pg').length ?? 0, drawn: d?.querySelectorAll('.pg > svg').length ?? 0, csp: !!d?.querySelector('meta[http-equiv="Content-Security-Policy"]') };
      });
      check(`HWP 보이는 쪽 근처만 그린다(${name})`, info.slots === pages && info.drawn > 0 && info.drawn <= 5 && info.csp, JSON.stringify(info));
      check(`HWP 작업 스레드로 연다(리뷰 D4, ${name})`, seen.some((u) => u.includes('hwp.worker')));
      await shot(page, `file-viewer-${name.replace('s.', '')}-dark.png`);
      check(`바깥 요청 0건(${name})`, external.length === 0, external.slice(0, 3).join(', '));
      check(`페이지 오류 없음(${name})`, errors.length === 0, errors.slice(0, 2).join(' | '));
      await ctx.close();
    }
  } else console.log('- HWP 절 건너뜀(VIEWER_EXTRA 없음)');
} finally {
  await browser.close();
  stop();
}
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `실패 ${failed.length}건` : `통과 ${results.length}건`);
process.exit(failed.length ? 1 : 0);
