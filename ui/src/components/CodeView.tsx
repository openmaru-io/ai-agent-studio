/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 코드·설정 글을 보여 주기만 하는 칸. 고칠 때와 같은 Monaco 편집기(보기 전용)라 색칠·줄 번호·찾기·복사가 같다.
import { Typography } from '@mui/material';
import { Suspense } from 'react';

import { t } from '@/i18n';

import { languageOf } from './codeLanguage';
import { LazyCodeEditor } from './LazyCodeEditor';

export function CodeView({ text, filename, label, markdown = false }: { text: string; filename?: string; label: string; markdown?: boolean }) {
  return (
    <Suspense fallback={<Typography color="text.secondary">{t('editor.loading')}</Typography>}>
      <LazyCodeEditor
        readOnly
        value={text}
        onChange={() => undefined}
        language={languageOf(filename, markdown)}
        ariaLabel={label}
        minRows={3}
        tabIndents={false}
      />
    </Suspense>
  );
}
