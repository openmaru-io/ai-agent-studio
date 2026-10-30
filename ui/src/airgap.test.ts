/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const script = join(__dirname, '..', 'scripts', 'check-airgap.mjs');

function build(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'airgap-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}
const run = (dir: string) => spawnSync('node', [script, dir], { encoding: 'utf8' });

describe('에어갭 검사', () => {
  it('허용한 주소(XML 네임스페이스, 오류 안내문)만 있으면 통과한다', () => {
    const dir = build({
      'index.html': '<div id="root"></div>',
      'assets/a.js':
        'const ns="http://www.w3.org/2000/svg";const m="https://react.dev/errors/1";const u="https://mui.com/x";',
    });
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('통과');
  });

  it.each([
    ['글꼴 CDN', { 'assets/a.css': '@import url(https://fonts.googleapis.com/css2?family=Inter);' }],
    ['스크립트 CDN', { 'index.html': '<script src="https://cdn.jsdelivr.net/npm/x.js"></script>' }],
    ['프로토콜 없는 주소', { 'index.html': '<script src="//unpkg.com/x.js"></script>' }],
    ['번들 안의 API 주소', { 'assets/a.js': 'fetch("https://api.example.com/data")' }],
  ])('%s 가 있으면 실패하고 어디인지 알려 준다', (_name, files) => {
    const r = run(build(files));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('에어갭 검사 실패');
    expect(r.stderr).toMatch(/googleapis|jsdelivr|unpkg|api\.example/);
  });

  it('3D 묶음(vendor-three)에 든 라이브러리 기본값·주석 주소는 그 파일에서만 허용한다', () => {
    const lib =
      'const d="https://cdn.jsdelivr.net/gh/x/data";const g="https://www.gstatic.com/draco/";// https://github.com/a/b https://docs.pmnd.rs/x https://jcgt.org/p';
    expect(run(build({ 'assets/vendor-three-abc123.js': lib })).status).toBe(0);
    const other = run(build({ 'assets/index-abc123.js': lib }));
    expect(other.status).toBe(1);
    expect(other.stderr).toMatch(/jsdelivr|gstatic|github|pmnd|jcgt/);
  });

  it('3D 묶음에서도 허용 목록 밖의 호스트는 실패한다', () => {
    const r = run(build({ 'assets/vendor-three-abc123.js': 'fetch("https://api.example.com/data")' }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('api.example.com');
  });

  it('Markdown·다이어그램·차트 묶음의 주석·안내문 주소는 그 묶음에서만 허용한다(OMAI-1115)', () => {
    const md = '// https://github.com/remarkjs/react-markdown/blob/main/changelog.md';
    const mmd = '// https://chevrotain.io/docs https://langium.org https://lodash.com/license https://en.wikipedia.org/wiki/x';
    expect(run(build({ 'assets/vendor-markdown-abc.js': md, 'assets/vendor-mermaid-abc.js': mmd, 'assets/vendor-echarts-abc.js': md })).status).toBe(0);
    expect(run(build({ 'assets/index-abc.js': md })).status).toBe(1);
    expect(run(build({ 'assets/vendor-markdown-abc.js': mmd })).status).toBe(1);
    expect(run(build({ 'assets/vendor-mermaid-abc.js': 'fetch("https://api.example.com/x")' })).status).toBe(1);
  });

  it('공통 표 묶음(vendor-grid)의 라이선스 주석 주소는 그 묶음에서만 허용한다(OMAI-1127)', () => {
    const lic = '/** @license match-sorter-utils ... Kent C. Dodds <me@kentcdodds.com> (https://kentcdodds.com) */';
    expect(run(build({ 'assets/vendor-grid-abc.js': lic })).status).toBe(0);
    expect(run(build({ 'assets/index-abc.js': lic })).status).toBe(1);
    expect(run(build({ 'assets/vendor-grid-abc.js': 'fetch("https://api.example.com/x")' })).status).toBe(1);
  });

  it('pdf.js 작업 스레드(.mjs)도 검사한다 — 그 안의 바깥 주소는 실패(스펙 2026-10-20-005 리뷰 R7)', () => {
    const r = run(build({ 'assets/other-abc.mjs': 'fetch("https://api.example.com/x")' }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('api.example.com');
  });

  it('문서 뷰어 묶음(vendor-pdf·pdf.worker·vendor-docx·vendor-zip)의 네임스페이스·주석 주소는 그 묶음에서만 허용한다', () => {
    const pdf = '// https://github.com/mozilla/pdf.js http://ns.adobe.com/xap/1.0/ http://www.xfa.org/schema/ new URL(x,"https://foo.bar")';
    const docx = 'const ns="http://schemas.openxmlformats.org/wordprocessingml/2006/main";new URL(a,"http://docx/")';
    const zip = '/* (c) Stuart Knightley <stuart [at] stuartk.com> https://raw.github.com/Stuk/jszip */';
    expect(run(build({ 'assets/vendor-pdf-abc.js': pdf, 'assets/pdf.worker.min-abc.mjs': pdf, 'assets/vendor-docx-abc.js': docx, 'assets/vendor-zip-abc.js': zip })).status).toBe(0);
    expect(run(build({ 'assets/index-abc.js': pdf })).status).toBe(1);
    expect(run(build({ 'assets/vendor-pdf-abc.js': docx })).status).toBe(1);
    expect(run(build({ 'assets/pdf.worker.min-abc.mjs': 'fetch("https://api.example.com/x")' })).status).toBe(1);
  });

  it('2단계 묶음(vendor-pptx·xlsx.worker)의 네임스페이스·주석 주소는 그 묶음에서만 허용한다', () => {
    const pptx = '/* https://lodash.com/license https://openjsf.org */ const ns="http://schemas.openxmlformats.org/presentationml/2006/main"';
    const xlsx = 'const dc="http://purl.org/dc/elements/1.1/";/* Feross Aboukhadijeh <https://feross.org/opensource> */';
    expect(run(build({ 'assets/vendor-pptx-abc.js': pptx, 'assets/xlsx.worker-abc.js': xlsx })).status).toBe(0);
    expect(run(build({ 'assets/index-abc.js': pptx })).status).toBe(1);
    expect(run(build({ 'assets/hwp.worker-abc.js': xlsx })).status).toBe(1);
    expect(run(build({ 'assets/xlsx.worker-abc.js': 'fetch("https://api.example.com/x")' })).status).toBe(1);
  });

  it('얼굴 묶음(vendor-avatar)의 스타일 출처·라이선스 주소는 그 묶음에서만 허용한다(스펙 2026-10-21-016)', () => {
    const avatar = 'source:"https://www.figma.com/community/file/1198754108850888330",license:"https://creativecommons.org/publicdomain/zero/1.0/",dc:"http://purl.org/dc/elements/1.1/"';
    expect(run(build({ 'assets/vendor-avatar-abc.js': avatar })).status).toBe(0);
    expect(run(build({ 'assets/index-abc.js': avatar })).status).toBe(1);
    expect(run(build({ 'assets/vendor-avatar-abc.js': 'fetch("https://api.example.com/x")' })).status).toBe(1);
  });

  it('빌드 폴더를 안 주면 사용법을 알리고 2로 끝난다', () => {
    const r = spawnSync('node', [script], { encoding: 'utf8' });
    expect(r.status).toBe(2);
  });

  // 빌드 전(깨끗한 작업본·공개 스냅샷)에는 폴더가 없다. 검사 스크립트는 없는 폴더에서 처리되지 않은 오류로 종료 코드 1 을 내서
  // 「외부 주소 발견」(1)과 구별되지 않았다 — 폴더가 있는지 먼저 본다(2026-10-22)
  const real = join(__dirname, '..', '..', 'aas', 'static');
  it.skipIf(!existsSync(real))('실제 빌드 산출물(aas/static)이 있으면 그것도 통과한다', () => {
    execFileSync('node', [script, real], { encoding: 'utf8' });          // 외부 주소가 있으면 종료 코드 1 로 실패한다
  });
});
