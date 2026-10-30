/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 폐쇄망 회귀 방지: 편집기 loader 가 번들한 monaco 를 받아야 한다. 이 설정이 빠지면 loader 가
// cdn.jsdelivr.net 에서 monaco 를 받으려다 편집기가 「Loading...」에서 멈춘다(COP Console index.airgap.test 와 같은 시험).
import { describe, expect, it, vi } from 'vitest';

const config = vi.fn();
const register = vi.fn();
const setMonarchTokensProvider = vi.fn();
vi.mock('@monaco-editor/react', () => ({ loader: { config } }));
vi.mock('monaco-editor/esm/vs/editor/editor.api', () => ({ __bundledMonaco: true, languages: { register, setMonarchTokensProvider } }));
// 색칠 규칙(언어)은 codeLanguage.test.ts 가 languageOf 와 맞는지 본다. 여기서는 불러오기만 막는다(2026-10-17-024)
for (const lang of [
  'bat', 'cpp', 'csharp', 'css', 'dockerfile', 'go', 'graphql', 'hcl', 'html', 'ini', 'java', 'javascript', 'kotlin', 'less', 'lua', 'markdown', 'perl', 'php', 'powershell', 'protobuf', 'python', 'r', 'ruby', 'rust', 'scala', 'scss', 'shell', 'sql', 'swift', 'typescript', 'xml', 'yaml',
])
  vi.doMock(`monaco-editor/esm/vs/basic-languages/${lang}/${lang}.contribution`, () => ({}));

// 편집 기능(contrib): editor.api 만으로는 찾기 창이 없어 Cmd+F 에 브라우저 찾기가 열렸다(2026-10-28-007)
const contribs = {
  find: vi.fn(() => ({})),
  multicursor: vi.fn(() => ({})),
  // 아이콘 글꼴(codicon). editor.api 는 불러오지 않아 찾기 창 단추가 빈 글자로 보였다(2026-10-28-007 §6)
  codicons: vi.fn(() => ({})),
};
vi.doMock('monaco-editor/esm/vs/editor/contrib/find/browser/findController', contribs.find);
vi.doMock('monaco-editor/esm/vs/editor/contrib/multicursor/browser/multicursor', contribs.multicursor);
vi.doMock('monaco-editor/esm/vs/base/browser/ui/codicons/codiconStyles', contribs.codicons);

describe('편집기 준비(폐쇄망)', () => {
  it('번들한 monaco 를 loader 에 넣고 작업자도 번들 파일로 만든다', async () => {
    await import('./monacoSetup');
    expect(config).toHaveBeenCalledWith({ monaco: expect.objectContaining({ __bundledMonaco: true }) });
    expect(typeof self.MonacoEnvironment?.getWorker).toBe('function');
    // JSON 은 basic-languages 에 없어 색칠 규칙을 직접 등록한다
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ id: 'json' }));
    expect(setMonarchTokensProvider).toHaveBeenCalledWith('json', expect.anything());
  });

  it('찾기·찾아 바꾸기(Cmd/Ctrl+F·H)와 같은 글 고르기(Cmd/Ctrl+D) 편집 기능을 불러온다', async () => {
    await import('./monacoSetup');
    expect(contribs.find).toHaveBeenCalled();
    expect(contribs.multicursor).toHaveBeenCalled();
  });

  it('찾기 창 단추의 아이콘 글꼴(codicon) 스타일을 불러온다', async () => {
    await import('./monacoSetup');
    expect(contribs.codicons).toHaveBeenCalled();
  });
});
