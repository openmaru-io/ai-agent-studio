/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 코드에 한글 문장이 직접 남아 있지 않은지 본다. 화면 문구는 번역 사전(i18n/ko, i18n/en)에만 있어야 한다.
// 주석·정규식은 제외하고, 한글이 꼭 코드에 있어야 하는 줄(서버가 보내는 한글 값과 맞대어 보는 곳 등)에는 같은 줄이나 바로 윗줄에
// `i18n-ignore` 주석을 단다. 이유를 함께 적는다.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const HANGUL = /[가-힣]/;
const SKIP_DIR = new Set(['i18n', 'test', 'scene3d']);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return SKIP_DIR.has(name) ? [] : files(p);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

function findings(path: string): string[] {
  const text = readFileSync(path, 'utf-8');
  const src = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines = text.split('\n');
  const out: string[] = [];
  const ignored = (line: number) => /i18n-ignore/.test(lines[line] ?? '') || /i18n-ignore/.test(lines[line - 1] ?? '');
  const visit = (node: ts.Node) => {
    const literal =
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node);
    if (literal && HANGUL.test(node.text)) {
      const line = src.getLineAndCharacterOfPosition(node.getStart()).line;
      if (!ignored(line)) out.push(`${relative(ROOT, path)}:${line + 1}  ${node.text.trim().slice(0, 40)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return out;
}

describe('번역 누락', () => {
  it('코드에 한글 문장이 직접 들어 있지 않다(번역 사전으로 옮긴다)', () => {
    const all = files(ROOT).flatMap(findings);
    expect(all).toEqual([]);
  });
});
