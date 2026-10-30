/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// CodeEditor 가 Monaco 에 넘기는 높이·줄 바꿈 값. jsdom 에서는 Monaco 가 돌지 않아 Editor 를 받은 값만 적는 부품으로 바꾼다
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CodeEditor } from './CodeEditor';
import type { CodeEditorProps } from './codeLanguage';

const seen: { height?: number | string; options?: { wordWrap?: string; scrollbar?: unknown } } = {};
vi.mock('@monaco-editor/react', () => ({
  default: (p: { height: number | string; options: object }) => {
    seen.height = p.height;
    seen.options = p.options;
    return null;
  },
}));
vi.mock('@/lib/monacoSetup', () => ({ monaco: {} }));

const base: CodeEditorProps = { value: 'a\nb\nc', onChange: () => {}, language: 'python', ariaLabel: '코드', minRows: 2, tabIndents: true };

describe('CodeEditor 높이·줄 바꿈', () => {
  beforeEach(() => {
    delete seen.height;
    delete seen.options;
  });

  it('기본은 줄 수로 높이를 정하고 보기 전용은 40줄에서 멈춘다(영혼 템플릿·플로 화면 그대로)', () => {
    render(<CodeEditor {...base} />);
    expect(seen.height).toBe(4 * 19 + 16);
    render(<CodeEditor {...base} readOnly value={'x\n'.repeat(100)} />);
    expect(seen.height).toBe(40 * 19 + 16);
    expect(seen.options?.scrollbar).toEqual({ alwaysConsumeMouseWheel: false });
  });

  it('fill 이면 줄 수와 상관없이 부모 높이를 채우고 편집기 안에서 스크롤한다(파일 뷰어, 2026-10-20-002)', () => {
    render(<CodeEditor {...base} readOnly fill value={'x\n'.repeat(100)} />);
    expect(seen.height).toBe('100%');
    expect(seen.options?.scrollbar).toBeUndefined();
  });

  it('줄 바꿈은 Markdown 만 기본으로 켜고, wordWrap 을 주면 그 값을 쓴다', () => {
    render(<CodeEditor {...base} />);
    expect(seen.options?.wordWrap).toBe('off');
    render(<CodeEditor {...base} language="markdown" />);
    expect(seen.options?.wordWrap).toBe('on');
    render(<CodeEditor {...base} language="markdown" wordWrap="off" />);
    expect(seen.options?.wordWrap).toBe('off');
    render(<CodeEditor {...base} wordWrap="on" />);
    expect(seen.options?.wordWrap).toBe('on');
  });
});
