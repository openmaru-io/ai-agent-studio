/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 공개 타입(aas-widget.d.ts)으로 쓴 페이지 예시가 TypeScript 검사를 통과하고, 틀린 예시는 실패하는지 본다(스펙 2026-11-18-012 D25⑩).
// 손으로 쓴 파일이라 위젯 코드와 어긋날 수 있다 — 메서드·onSave 인자·오류 코드 목록을 위젯 코드와 맞대어 본다.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { WIDGET_FEATURES, WIDGET_METHODS } from './widget';

const DTS = resolve(__dirname, '../../types/aas-widget.d.ts');

function diagnostics(code: string): string[] {
  const file = resolve(__dirname, '../../types/__example__.ts');
  const host = ts.createCompilerHost({ strict: true, noEmit: true, target: ts.ScriptTarget.ES2020, lib: ['lib.es2020.d.ts', 'lib.dom.d.ts'], types: [] });
  const read = host.readFile.bind(host);
  host.readFile = (f) => (f === file ? code : read(f));
  host.fileExists = ((orig) => (f: string) => f === file || orig(f))(host.fileExists.bind(host));
  const getSource = host.getSourceFile.bind(host);
  host.getSourceFile = (f, v) => (f === file ? ts.createSourceFile(f, code, v) : getSource(f, v));
  const program = ts.createProgram([DTS, file], { strict: true, noEmit: true, target: ts.ScriptTarget.ES2020, lib: ['lib.es2020.d.ts', 'lib.dom.d.ts'], types: [] }, host);
  return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

const GOOD = `
const w = CogentAIAASWidget.init({
  backendUrl: 'https://aas.example',
  saveAnswer: {
    format: 'board-post',
    timeoutMs: 60000,
    onError: (e) => console.warn(e.code, e.detail),
    onSave: async (r) => {
      if (r.source === 'registered') { const v: number = r.version; const p: Record<string, unknown> = r.payload; void v; void p; }
      if (r.source === 'none') { const p: null = r.payload; void p; }
      return { message: 'saved ' + r.attemptId };
    },
  },
});
const st: 'ready' | 'pending' | 'disabled' = w.saveAnswerState().state;
w.updateConfig({ saveAnswer: null });
const ok: boolean = CogentAIAASWidget.validateSaveAnswer({}).ok;
void st; void ok;
`;

describe('aas-widget.d.ts', () => {
  it('바른 예시는 오류가 없다', () => {
    expect(diagnostics(GOOD)).toEqual([]);
  });

  it('틀린 예시는 오류가 난다(onSave 빠짐, 없는 메서드, none 의 payload 를 객체로)', () => {
    expect(diagnostics(`CogentAIAASWidget.init({ saveAnswer: { format: 'x' } });`).length).toBeGreaterThan(0);
    expect(diagnostics(`CogentAIAASWidget.init().saveAnswerStatus();`).length).toBeGreaterThan(0);
    expect(diagnostics(`CogentAIAASWidget.init({ saveAnswer: { label: { ko: 'a', en: 'b' }, onSave: (r) => { if (r.source === 'none') { const p: Record<string, unknown> = r.payload; void p; } } } });`).length).toBeGreaterThan(0);
  });

  it('위젯 코드와 어긋나지 않는다(메서드·onSave 인자·오류 코드)', () => {
    const dts = readFileSync(DTS, 'utf-8');
    for (const m of [...WIDGET_METHODS, 'saveAnswerState']) expect(dts, m).toMatch(new RegExp(`\\b${m}\\(`));
    expect(WIDGET_FEATURES).toContain('saveAnswer');
    const src = readFileSync(resolve(__dirname, 'saveAnswer.ts'), 'utf-8');
    const resultKeys = /export interface SaveAnswerResult \{([\s\S]*?)\n\}/.exec(src)![1].match(/^\s+(\w+):/gm)!.map((s) => s.trim().replace(':', ''));
    for (const k of resultKeys) expect(dts, k).toMatch(new RegExp(`\\b${k}:`));
    const codes = [...src.matchAll(/'(saveAnswer\.[a-z_]+)'/g)].map((m) => m[1]);
    for (const c of new Set(codes)) expect(dts, c).toContain(`'${c}'`);
  });
});
