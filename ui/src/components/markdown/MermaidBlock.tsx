/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// ```mermaid 코드 블록을 다이어그램으로 그린다. 무거워서 따로 받는 묶음(vendor-mermaid)이다.
// securityLevel 'strict' — 다이어그램 글의 HTML·클릭 동작을 막는다(CogentAI 위젯의 'loose' 는 HTML 주입 경로였다, OMAI-1115).
import { Box, Typography, useTheme } from '@mui/material';
import mermaid from 'mermaid';
import { useEffect, useId, useState } from 'react';

import { t } from '@/i18n';

let queue: Promise<unknown> = Promise.resolve(); // mermaid.render 는 전역 설정을 쓰므로 한 번에 하나씩 그린다

export default function MermaidBlock({ code }: { code: string }) {
  const dark = useTheme().palette.mode === 'dark';
  const id = 'mmd-' + useId().replace(/[^a-zA-Z0-9]/g, '');
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    queue = queue.then(async () => {
      try {
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });
        const out = await mermaid.render(id, code);
        if (!cancelled) {
          setSvg(out.svg);
          setError('');
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        document.getElementById('d' + id)?.remove(); // 실패하면 mermaid 가 남긴 오류 그림을 치운다
      }
    });
    return () => {
      cancelled = true;
    };
  }, [code, dark, id]);

  if (error)
    return (
      <Box component="pre" sx={{ p: 1.5, bgcolor: 'action.hover', borderRadius: 1, overflow: 'auto' }}>
        <Typography variant="caption" color="error" component="div" sx={{ mb: 1 }}>
          {t('common.diagramFailed', { error })}
        </Typography>
        <code>{code}</code>
      </Box>
    );
  if (!svg)
    return (
      <Typography variant="caption" color="text.secondary">
        {t('common.diagramLoading')}
      </Typography>
    );
  // strict 모드의 svg 는 mermaid 가 DOMPurify 로 거른 것이다.
  return (
    <Box
      role="img"
      aria-label={t('common.diagram')}
      sx={{ overflow: 'auto', '& svg': { maxWidth: '100%', height: 'auto' } }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
