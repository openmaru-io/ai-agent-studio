/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// PowerPoint 본문(스펙 2026-10-20-005 2단계, 묶음 vendor-pptx, §7 D2 pptx-preview). DocBody 가 처음 열 때 받는다.
// 슬라이드를 세로로 쌓는다(디자인 DV15, mode 'list'). 100장 상한은 DocBody 가 zip 목차로 미리 본다(재검토 E6).
// 격리 iframe(스크립트 금지 + CSP) 안에 그리고 높이를 내용에 맞춘다. 맞춤·확대는 CSS zoom(OV2-M4).
// 슬라이드 번호는 바깥 scrollTop 과 슬라이드 위치로 계산한다(재검토 E1). 원본과 다를 수 있다는 띠(DV6).
import { Box, Stack, useMediaQuery, useTheme } from '@mui/material';
import { init } from 'pptx-preview';
import { useEffect, useRef, useState } from 'react';

import { useChatTokens } from '@/components/chat/useChatTokens';
import { t } from '@/i18n';

import type { DocBodyProps } from './DocBody';
import { fitWidth, pageAt } from './docMath';
import { docStore, useDoc } from './docStore';

const CSP = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data: blob:";
/** 이 폭으로 그린 뒤 zoom 으로 맞춘다 */
const BASE = 960;
const REMEASURE = [0, 150, 500, 1500];

function shell(edge: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>
:root{color-scheme:light dark;}
html,body{margin:0;padding:0;background:transparent;}
.pptx-preview-wrapper{background:transparent!important;display:flex;flex-direction:column;align-items:center;gap:16px;overflow:visible!important;height:auto!important;width:auto!important;}
.pptx-preview-slide-wrapper{background:#fff;color:#000;border:1px solid ${edge};box-sizing:border-box;margin:0!important;flex-shrink:0;}
</style></head><body><div id="aas-pptx"></div></body></html>`;
}

export default function PptxBody({ file, bytes, onFail }: DocBodyProps) {
  const tk = useChatTokens();
  const theme = useTheme();
  const narrow = useMediaQuery(theme.breakpoints.down('sm'));
  const doc = useDoc();
  const scroller = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [ratio, setRatio] = useState(9 / 16);
  const [natural, setNatural] = useState(0);
  const [height, setHeight] = useState(0);
  const [box, setBox] = useState({ width: 800, height: 600, top: 0 });
  const [tops, setTops] = useState<number[]>([]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setBox((b) => ({ ...b, width: el.clientWidth, height: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const render = async () => {
    const d = frame.current?.contentDocument;
    const host = d?.getElementById('aas-pptx');
    if (!d || !host) return;
    try {
      // 슬라이드 크기를 먼저 읽고(같은 라이브러리로 한 번 더 해석), 그 비율로 그린다
      const probe = init(d.createElement('div'), {});
      const deck = await probe.load(bytes.slice().buffer);
      const r = deck.width && deck.height ? deck.height / deck.width : 9 / 16;
      probe.destroy();
      if (!deck.slides?.length) return onFail({ type: 'empty' });
      setRatio(r);
      setNatural(deck.width || BASE);
      docStore.setPages(deck.slides.length);
      await init(host, { mode: 'list', width: BASE, height: Math.round(BASE * r) }).preview(bytes.slice().buffer);
    } catch {
      return onFail({ type: 'retry', reason: t('chat.viewer.doc.failOpen') });
    }
    setReady(true);
  };

  const pad = narrow ? 8 : 24;
  const fit = fitWidth(box.width, narrow);
  const factor = (fit / BASE) * (doc.zoom / 100);
  useEffect(() => {
    if (natural) docStore.setNatural((natural / fit) * 100);
  }, [natural, fit]);
  useEffect(() => {
    const d = frame.current?.contentDocument;
    if (!ready || !d) return;
    (d.body.style as CSSStyleDeclaration & { zoom: string }).zoom = String(factor);
    const ids = REMEASURE.map((ms) =>
      setTimeout(() => {
        setHeight(d.documentElement.scrollHeight);
        const slides = [...d.querySelectorAll<HTMLElement>('.pptx-preview-slide-wrapper')];
        setTops(slides.map((s) => pad + s.getBoundingClientRect().top + (d.documentElement.scrollTop || 0)));
        slides.forEach((s, i) => {
          s.setAttribute('role', 'group');
          s.setAttribute('aria-label', t('chat.viewer.doc.slideOf', { page: i + 1, pages: slides.length }));
        });
      }, ms)
    );
    return () => ids.forEach(clearTimeout);
  }, [ready, factor, pad, ratio]);
  const current = pageAt(tops, box.top, box.height) || 1;
  useEffect(() => {
    if (ready) docStore.setPage(current);
  }, [current, ready]);
  useEffect(() => {
    const el = scroller.current;
    if (!el || !doc.goto.seq) return;
    el.scrollTop = (tops[doc.goto.page - 1] ?? 0) - pad;
  }, [doc.goto.seq]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = scroller.current;
    const active = document.activeElement;
    if (ready && el && active && active !== el && active.contains(el)) el.focus({ preventScroll: true });
  }, [ready]);

  return (
    <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <Stack role="status" direction="row" alignItems="center" sx={{ minHeight: 32, px: 2, fontSize: 12, color: tk.text, bgcolor: tk.rail, borderBottom: `1px solid ${tk.line}`, flexShrink: 0 }}>
        {t('chat.viewer.doc.mayDiffer')}
      </Stack>
      <Box
        ref={scroller}
        data-doc-scroll
        tabIndex={-1}
        onScroll={(e) => {
          const top = e.currentTarget.scrollTop;
          requestAnimationFrame(() => setBox((b) => (b.top === top ? b : { ...b, top })));
        }}
        sx={{ flex: 1, minHeight: 0, overflow: 'auto', bgcolor: tk.sunken, outline: 'none', px: `${pad}px`, py: `${pad}px` }}
      >
        <Box
          component="iframe"
          ref={frame}
          title={file.name}
          sandbox="allow-same-origin"
          referrerPolicy="no-referrer"
          tabIndex={-1}
          srcDoc={shell(tk.popup.edge)}
          onLoad={() => void render()}
          sx={{ display: 'block', width: '100%', height: height || '100%', border: 0, colorScheme: 'light dark', visibility: ready ? 'visible' : 'hidden' }}
        />
      </Box>
    </Box>
  );
}
