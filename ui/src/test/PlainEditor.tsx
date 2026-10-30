/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 시험용 편집 칸. jsdom 에서는 Monaco 가 돌지 않아 setup.ts 가 CodeEditor 를 이 입력칸으로 바꿔 끼운다.
// CodeEditor 와 같은 약속(값·키 입력·선택 범위)을 지켜, TextEditor 의 도구 줄·단축키·저장 흐름을 그대로 시험한다.
import { useImperativeHandle, useRef } from 'react';

import type { CodeEditorProps } from '@/components/codeLanguage';

export function PlainEditor(props: CodeEditorProps) {
  const ta = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(props.handle, () => ({
    selection: () => [ta.current?.selectionStart ?? 0, ta.current?.selectionEnd ?? 0],
    select: (a, b) => ta.current?.setSelectionRange(a, b),
    focus: () => ta.current?.focus(),
  }));
  return (
    <textarea
      ref={ta}
      aria-label={props.ariaLabel}
      data-language={props.language}
      data-marks={props.marks?.map((m) => m.line).join(',')}
      data-focus-line={props.focusLine?.line}
      rows={props.minRows}
      value={props.value}
      spellCheck={false}
      readOnly={props.readOnly}
      onChange={(e) => props.onChange(e.target.value)}
      onFocus={props.onFocus}
      onKeyDown={(e) =>
        props.onKey?.({
          key: e.key,
          mod: e.metaKey || e.ctrlKey,
          shift: e.shiftKey,
          alt: e.altKey,
          composing: e.nativeEvent.isComposing,
          preventDefault: () => {
            e.preventDefault();
            e.stopPropagation();
          },
        })
      }
    />
  );
}
