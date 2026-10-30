/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 양식 안의 작은 마크다운 칸: 따로 저장하지 않고 양식의 저장 버튼을 따른다. 미리 보기를 지원한다.
// monaco 를 켜면 입력칸 대신 다른 글 편집 화면과 같은 Monaco 편집기(LazyCodeEditor)를 쓴다(새 스킬 본문, 2026-10-28-003).
import PreviewOutlinedIcon from '@mui/icons-material/PreviewOutlined';
import { Box, Button, IconButton, Stack, TextField, Typography } from '@mui/material';
import { Suspense, useEffect, useRef, useState } from 'react';

import { t } from '@/i18n';
import * as T from '@/lib/mdtools';
import { Edit } from '@/lib/mdtools';

import type { EditorHandle, EditorKey } from './codeLanguage';
import { pressedSx } from './DisclosureButton';
import { LazyCodeEditor } from './LazyCodeEditor';
import { Markdown } from './Markdown';

interface Props {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  /** true 면 Monaco 편집기로 고친다(긴 본문용). 첫 화면에 싣지 않으려 지연 로딩한다 */
  monaco?: boolean;
}

// 옛 화면(삭제됨. 커밋 3e3319d 의 aas/web/js/editor.js)의 작은 칸과 같은 도구: 굵게·목록·코드·링크.
const tools = (): [string, string, (e: Edit) => Edit][] => [
  [t('mdfield.bold'), 'B', (e) => T.wrap(e, '**')],
  [t('mdfield.list'), '•', (e) => T.linePrefix(e, '- ')],
  [t('mdfield.code'), '`', (e) => T.wrap(e, '`', '`', t('mdtools.code'))],
  [t('mdfield.link'), '🔗', T.link],
];

export function MarkdownField({ value, onChange, label, placeholder, monaco }: Props) {
  const [preview, setPreview] = useState(false);
  const ta = useRef<HTMLTextAreaElement | null>(null);
  const ed = useRef<EditorHandle>(null);
  const pendingSel = useRef<[number, number] | null>(null);
  // Tab 은 들여쓰기, Esc 를 누른 뒤에는 다음 칸으로 넘어간다(TextEditor 와 같다)
  const [tabIndents, setTabIndents] = useState(true);
  // Monaco 는 새 값을 받은 뒤에 선택을 되살린다(TextEditor 와 같은 방법)
  useEffect(() => {
    if (pendingSel.current && ed.current) {
      ed.current.select(...pendingSel.current);
      pendingSel.current = null;
    }
  }, [value]);
  const apply = (fn: (e: Edit) => Edit) => {
    if (monaco) {
      const h = ed.current;
      if (!h) return;
      const [start, end] = h.selection();
      const r = fn({ value, start, end });
      pendingSel.current = [r.start, r.end];
      onChange(r.value);
      h.focus();
      return;
    }
    const el = ta.current;
    if (!el) return;
    const r = fn({ value: el.value, start: el.selectionStart, end: el.selectionEnd });
    onChange(r.value);
    // 값이 반영된 뒤에 선택을 되살린다
    setTimeout(() => {
      el.focus();
      el.setSelectionRange(r.start, r.end);
    }, 0);
  };
  const onKey = (e: EditorKey) => {
    const k = e.key.toLowerCase();
    if (e.mod && k === 'b') {
      e.preventDefault();
      apply((x) => T.wrap(x, '**'));
    } else if (e.mod && k === 'k') {
      e.preventDefault(); // 명령 팔레트(⌘K)로 올라가지 않게 한다
      apply(T.link);
    } else if (e.key === 'Escape') setTabIndents(false);
    else if (e.key === 'Tab' && tabIndents && !e.mod && !e.alt) {
      e.preventDefault();
      apply((x) => T.indent(x, e.shift));
    }
  };
  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 0.5 }}>
        <Typography variant="caption" color="text.secondary" aria-hidden="true">
          {label}
        </Typography>
        <Stack direction="row" alignItems="center" role="toolbar" aria-label={t('mdfield.toolbar')}>
          {tools().map(([title, glyph, run]) => (
            <IconButton
              key={title}
              size="small"
              aria-label={title}
              title={title}
              disabled={preview}
              onClick={() => apply(run)}
              sx={{ fontSize: 14 }}
            >
              {glyph}
            </IconButton>
          ))}
          {/* 미리 보기 아이콘(칸반 「내용 보기」와 같음). 도구줄 아이콘(14px)에 맞춰 16px, 켜지면 무채색 바탕(스펙 2026-10-19-005 R10·G5·G10) */}
          <Button size="small" startIcon={<PreviewOutlinedIcon sx={{ fontSize: '16px !important' }} />} aria-pressed={preview} onClick={() => setPreview((v) => !v)} sx={pressedSx}>
            {t('mdfield.preview')}
          </Button>
        </Stack>
      </Stack>
      {preview ? (
        <Markdown text={value || t('mdfield.empty')} />
      ) : monaco ? (
        <Suspense fallback={<Typography color="text.secondary">{t('editor.loading')}</Typography>}>
          <LazyCodeEditor
            handle={ed}
            value={value}
            onChange={onChange}
            language="markdown"
            ariaLabel={label}
            minRows={14}
            tabIndents={tabIndents}
            onKey={onKey}
            onFocus={() => setTabIndents(true)}
          />
        </Suspense>
      ) : (
        <TextField
          multiline
          minRows={4}
          fullWidth
          size="small"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          inputRef={ta}
          onKeyDown={(e) => {
            if (!(e.metaKey || e.ctrlKey)) return;
            const k = e.key.toLowerCase();
            if (k === 'b') {
              e.preventDefault();
              apply((e) => T.wrap(e, '**')); // 굵게(⌘B)
            } else if (k === 'k') {
              e.preventDefault();
              apply(T.link);
            }
          }}
          slotProps={{ htmlInput: { 'aria-label': label, spellCheck: false } }}
        />
      )}
    </Box>
  );
}
