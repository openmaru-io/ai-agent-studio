/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 글 편집 칸(Monaco, COP Console 과 같은 편집기). 글자 고치기·줄 번호·색칠·찾기는 Monaco 가 하고,
// 도구 줄·단축키·저장 흐름은 부르는 쪽(TextEditor)이 정한다 — 키 입력과 선택 범위를 이 부품이 넘겨준다.
// Monaco 는 무거워 이 파일은 LazyCodeEditor 로만 지연 로딩한다. 시험(jsdom)에서는 Monaco 가 돌지 않아
// src/test/setup.ts 가 같은 약속(codeLanguage.ts)을 지키는 입력칸으로 바꿔 끼운다.
import Editor, { type OnMount } from '@monaco-editor/react';
import { Box, useTheme } from '@mui/material';
import { useEffect, useImperativeHandle, useRef, useState } from 'react';

import { monaco } from '@/lib/monacoSetup';
import { MONO_FONT } from '@/lib/monoFont';

import type { CodeEditorProps } from './codeLanguage';

const LINE = 19; // fontSize 13 의 한 줄 높이

export function CodeEditor(props: CodeEditorProps) {
  const theme = useTheme();
  const ed = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [ready, setReady] = useState(false);
  const decos = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);

  useImperativeHandle(props.handle, () => ({
    selection: () => {
      const e = ed.current;
      const m = e?.getModel();
      const s = e?.getSelection();
      if (!e || !m || !s) return [0, 0];
      const a = m.getOffsetAt(s.getStartPosition());
      const b = m.getOffsetAt(s.getEndPosition());
      return [a, b];
    },
    select: (start, end) => {
      const e = ed.current;
      const m = e?.getModel();
      if (!e || !m) return;
      const a = m.getPositionAt(start);
      const b = m.getPositionAt(end);
      e.setSelection(new monaco.Selection(a.lineNumber, a.column, b.lineNumber, b.column));
      e.revealPositionInCenterIfOutsideViewport(b);
    },
    focus: () => ed.current?.focus(),
  }));

  useEffect(() => {
    ed.current?.updateOptions({ tabFocusMode: !props.tabIndents });
  }, [props.tabIndents]);

  // 근거 줄·옮겨 간 줄 칠하기(호출 흐름 코드 보기, 2026-10-17-022). 색은 DESIGN.md 의 Hover·Selected 상태 값이다
  useEffect(() => {
    const e = ed.current;
    if (!ready || !e) return;
    const cur = props.focusLine?.line;
    const list: monaco.editor.IModelDeltaDecoration[] = (props.marks ?? [])
      .filter((m) => m.line !== cur)
      .map((m) => ({
        range: new monaco.Range(m.line, 1, m.line, 1),
        options: { isWholeLine: true, className: 'aas-mark-line', linesDecorationsClassName: 'aas-mark-bar', hoverMessage: { value: m.note } },
      }));
    if (cur) {
      const note = props.marks?.find((m) => m.line === cur)?.note;
      list.push({
        range: new monaco.Range(cur, 1, cur, 1),
        options: { isWholeLine: true, className: 'aas-cur-line', linesDecorationsClassName: 'aas-cur-bar', ...(note ? { hoverMessage: { value: note } } : {}) },
      });
      e.revealLineInCenter(cur);
    }
    if (decos.current) decos.current.set(list);
    else decos.current = e.createDecorationsCollection(list);
  }, [ready, props.marks, props.focusLine?.line, props.focusLine?.key]);

  const onMount: OnMount = (editor) => {
    ed.current = editor;
    setReady(true);
    // Monaco 는 만들 때 글자 폭을 잰다. 번들 글꼴이 아직 안 왔으면 커서가 어긋나므로 로드 뒤 다시 잰다.
    void document.fonts?.load(`13px ${MONO_FONT}`).then(() => monaco.editor.remeasureFonts());
    editor.onKeyDown((ev) => {
      latest.current.onKey?.({
        key: ev.browserEvent.key,
        mod: ev.metaKey || ev.ctrlKey,
        shift: ev.shiftKey,
        alt: ev.altKey,
        composing: ev.browserEvent.isComposing,
        preventDefault: () => {
          ev.preventDefault();
          ev.stopPropagation();
        },
      });
    });
    editor.onDidFocusEditorText(() => latest.current.onFocus?.());
    editor.updateOptions({ tabFocusMode: !latest.current.tabIndents });
  };

  return (
    <Box
      sx={(th) => {
        const dark = th.palette.mode === 'dark';
        const ink = dark ? '255,255,255' : '17,24,39';
        return {
          border: 1,
          borderColor: 'divider',
          borderRadius: 1,
          overflow: 'hidden',
          // fill: 부모(flex 칸) 높이를 채운다. 줄 수 높이 대신 편집기 안에서 스크롤한다(파일 뷰어, 2026-10-20-002)
          ...(props.fill ? { flex: 1, minHeight: 0, height: '100%' } : {}),
          // DESIGN.md Interaction State Tokens: 근거 줄은 Hover 바탕 + Inactive 선, 옮겨 간 줄은 Selected 바탕 + 선
          '& .aas-mark-line': { background: `rgba(${ink},${dark ? 0.04 : 0.025})` },
          '& .aas-cur-line': { background: `rgba(${ink},${dark ? 0.06 : 0.04})` },
          '& .aas-mark-bar': { borderLeft: `2px solid rgba(${ink},${dark ? 0.5 : 0.45})`, marginLeft: '3px' },
          '& .aas-cur-bar': { borderLeft: `2px solid rgba(${ink},${dark ? 0.85 : 0.7})`, marginLeft: '3px' },
        };
      }}
    >
      <Editor
        height={props.fill ? '100%' : Math.min(Math.max(props.value.split('\n').length + 1, props.minRows), props.readOnly ? 40 : 32) * LINE + 16}
        language={props.language}
        value={props.value}
        theme={theme.palette.mode === 'dark' ? 'vs-dark' : 'vs'}
        onChange={(v) => props.onChange(v ?? '')}
        onMount={onMount}
        loading={null}
        options={{
          ariaLabel: props.ariaLabel,
          readOnly: !!props.readOnly,
          // 보기 전용은 커서 줄 강조를 끄고, 끝에 닿으면 바깥(서랍) 스크롤로 넘긴다. fill 은 바깥에 스크롤이 없어 편집기가 바퀴를 쓴다
          ...(props.readOnly ? { renderLineHighlight: 'none' as const } : {}),
          ...(props.readOnly && !props.fill ? { scrollbar: { alwaysConsumeMouseWheel: false } } : {}),
          fontFamily: MONO_FONT,
          fontSize: 13,
          lineHeight: LINE,
          minimap: { enabled: false },
          wordWrap: props.wordWrap ?? (props.language === 'markdown' ? 'on' : 'off'),
          scrollBeyondLastLine: false,
          tabSize: 2,
          insertSpaces: true,
          renderWhitespace: 'selection',
          automaticLayout: true,
          padding: { top: 8, bottom: 8 },
          unicodeHighlight: { ambiguousCharacters: false },
          // 링크를 누르면 바깥 주소로 나가지 않게 한다(폐쇄망)
          links: false,
        }}
      />
    </Box>
  );
}
