/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// Word 본문(스펙 2026-10-20-005, 묶음 vendor-docx). DocBody 가 처음 열 때 받는다.
// 격리 iframe(sandbox="allow-same-origin", 스크립트 금지 + CSP 로 바깥 요청 0건, §6) 안 문서에 docx-preview 로 그린다.
// iframe 높이는 내용에 맞추고 스크롤은 바깥 상자 하나가 맡는다(디자인 DV11). 맞춤 폭으로 줄일 때는 CSS zoom 을 쓴다
// — transform: scale 은 배치 높이가 그대로라 높이 계산이 틀린다(외부 검토 OV2-M4).
import { Box, useMediaQuery, useTheme } from '@mui/material';
import { renderAsync } from 'docx-preview';
import { useEffect, useRef, useState } from 'react';

import { useChatTokens } from '@/components/chat/useChatTokens';
import { t } from '@/i18n';

import type { DocBodyProps } from './DocBody';
import { fitWidth } from './docMath';
import { docStore, useDoc } from './docStore';

const CSP = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data: blob:";
/** 높이를 다시 재는 때(ms). 스크립트 금지 iframe 안은 ResizeObserver 로 볼 수 있는지 확인하지 않아, 그림·글꼴이 늦게 들어오는 시간에 맞춰 잰다 */
const REMEASURE = [0, 100, 400, 1200, 3000];

function shell(edge: string): string {
  // 종이는 테마와 관계없이 흰색, 그림자 없이 1px 테두리(디자인 DV9). docx-preview 의 회색 바탕은 끈다
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>
html,body{margin:0;padding:0;background:transparent;}
:root{color-scheme:light dark;}
.docx-wrapper{background:transparent!important;padding:0!important;display:flex;flex-direction:column;align-items:center;gap:16px;}
.docx-wrapper>section.docx{box-shadow:none!important;border:1px solid ${edge};margin:0!important;background:#fff;color:#000;}
</style></head><body><div id="aas-docx-styles"></div><div id="aas-docx-body"></div></body></html>`;
}

export default function DocxBody({ file, bytes, onFail }: DocBodyProps) {
  const tk = useChatTokens();
  const theme = useTheme();
  const narrow = useMediaQuery(theme.breakpoints.down('sm'));
  const doc = useDoc();
  const scroller = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [height, setHeight] = useState(0);
  const [paper, setPaper] = useState(0);
  const [boxWidth, setBoxWidth] = useState(800);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setBoxWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const render = async () => {
    const d = frame.current?.contentDocument;
    const body = d?.getElementById('aas-docx-body');
    const styles = d?.getElementById('aas-docx-styles');
    if (!d || !body || !styles) return;
    try {
      // 스타일 자리는 따로 둔다 — docx-preview 는 넘긴 자리를 먼저 비워서 head 를 넘기면 CSP meta 와 덮어쓰기 스타일이 지워진다
      await renderAsync(bytes.slice(), body, styles, {
        inWrapper: true,
        ignoreLastRenderedPageBreak: true,
        renderAltChunks: false, // 문서에 박힌 HTML 조각은 그리지 않는다
        useBase64URL: true, // 그림·글꼴을 data 주소로(CSP 는 data·blob 만 허용)
        experimental: false,
      });
    } catch {
      onFail({ type: 'retry', reason: t('chat.viewer.doc.failOpen') });
      return;
    }
    // 바깥으로 나가는 것을 지운다: 링크 주소, data·blob 이 아닌 그림(§6)
    d.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href') || '';
      if (!href.startsWith('#')) a.setAttribute('title', href);
      a.removeAttribute('href');
    });
    d.querySelectorAll('img').forEach((img) => {
      const s = img.getAttribute('src') || '';
      if (!/^(data:|blob:)/i.test(s)) img.removeAttribute('src');
    });
    const first = d.querySelector<HTMLElement>('section.docx');
    if (!first || (!d.body.textContent?.trim() && !d.querySelector('img'))) return onFail({ type: 'empty' });
    setPaper(first.offsetWidth);
    setReady(true);
  };

  // 맞춤·확대 → zoom, 그리고 높이 맞추기
  const fit = fitWidth(boxWidth, narrow);
  const factor = paper ? (fit / paper) * (doc.zoom / 100) : 1;
  useEffect(() => {
    if (paper) docStore.setNatural((paper / fit) * 100);
  }, [paper, fit]);
  useEffect(() => {
    const d = frame.current?.contentDocument;
    if (!ready || !d) return;
    (d.body.style as CSSStyleDeclaration & { zoom: string }).zoom = String(factor);
    const ids = REMEASURE.map((ms) => setTimeout(() => setHeight(d.documentElement.scrollHeight), ms));
    return () => ids.forEach(clearTimeout);
  }, [ready, factor]);
  useEffect(() => {
    const el = scroller.current;
    const active = document.activeElement;
    if (ready && el && active && active !== el && active.contains(el)) el.focus({ preventScroll: true });
  }, [ready]);

  return (
    <Box ref={scroller} data-doc-scroll tabIndex={-1} sx={{ flex: 1, minHeight: 0, overflow: 'auto', bgcolor: tk.sunken, outline: 'none', px: `${narrow ? 8 : 24}px`, py: `${narrow ? 8 : 24}px` }}>
      <Box
        component="iframe"
        ref={frame}
        title={file.name}
        sandbox="allow-same-origin"
        referrerPolicy="no-referrer"
        tabIndex={-1}
        srcDoc={shell(tk.popup.edge)}
        onLoad={() => void render()}
        // iframe 요소와 안쪽 문서의 color-scheme 을 같은 값(light dark)으로 둔다 — 다르게 풀리면 브라우저가 iframe 바탕을
        // 불투명한 흰색으로 칠해 책상이 가려진다(normal 끼리도 Chrome 은 칠했다, 2026-10-20 확인)
        sx={{ display: 'block', width: '100%', height: height || '100%', border: 0, colorScheme: 'light dark', visibility: ready ? 'visible' : 'hidden' }}
      />
    </Box>
  );
}
