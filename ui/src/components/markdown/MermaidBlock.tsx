/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// ```mermaid 코드 블록을 다이어그램으로 그린다. 무거워서 따로 받는 묶음(vendor-mermaid)이다.
// securityLevel 'strict' — 다이어그램 글의 HTML·클릭 동작을 막는다(CogentAI 위젯의 'loose' 는 HTML 주입 경로였다, OMAI-1115).
// 380px 상자에 맞춰 그리고 휠·끌기·버튼으로 확대·이동한다(CogentAI 위젯과 같은 버튼: 전체 화면·확대·축소·초기화).
// ERD 가 원래 크기로 그려져 화면을 다 차지했다(2026-11-08).
import CloseIcon from '@mui/icons-material/Close';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import { Box, Dialog, Typography, useTheme } from '@mui/material';
import mermaid from 'mermaid';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { t } from '@/i18n';

import ViewerToolbar, { viewerFrameSx } from './ViewerToolbar';
import { DIAGRAM_HEIGHT, fitView, type View, ZOOM_FACTOR, zoomAt } from './viewport';

let queue: Promise<unknown> = Promise.resolve(); // mermaid.render 는 전역 설정을 쓰므로 한 번에 하나씩 그린다

// Viewer 는 svg 한 장을 고정 상자 안에서 확대·이동해 보여 준다(인라인·전체 화면이 각각 쓴다).
function Viewer({
  svg,
  height,
  fullscreen,
  onFullscreen,
  onClose,
}: {
  svg: string;
  height: number | string;
  fullscreen: boolean;
  onFullscreen?: () => void;
  onClose?: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const size = useRef({ w: 0, h: 0 });
  const view = useRef<View>({ scale: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const apply = useCallback((v: View) => {
    view.current = v;
    if (contentRef.current) contentRef.current.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.scale})`;
  }, []);

  const fit = useCallback(() => {
    const box = boxRef.current;
    if (box) apply(fitView(size.current.w, size.current.h, box.clientWidth, box.clientHeight));
  }, [apply]);

  // svg 를 넣고 원래 크기(viewBox)로 고정한 뒤 상자에 맞춘다. mermaid 는 width="100%"·max-width 로 그려 상자 폭에 늘어났다.
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    el.innerHTML = svg; // strict 모드의 svg 는 mermaid 가 DOMPurify 로 거른 것이다
    const s = el.querySelector('svg');
    if (s) {
      const vb = s.viewBox?.baseVal;
      const w = vb && vb.width ? vb.width : s.getBoundingClientRect().width;
      const h = vb && vb.height ? vb.height : s.getBoundingClientRect().height;
      s.style.maxWidth = 'none';
      s.setAttribute('width', String(w));
      s.setAttribute('height', String(h));
      size.current = { w, h };
    }
    fit();
    const ro = new ResizeObserver(() => fit());
    if (boxRef.current) ro.observe(boxRef.current);
    return () => ro.disconnect();
  }, [svg, fit]);

  // 휠: 마우스 위치를 고정점으로 확대·축소한다(passive: false 라야 페이지 스크롤을 막는다)
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = box.getBoundingClientRect();
      apply(zoomAt(view.current, e.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR, e.clientX - r.left, e.clientY - r.top));
    };
    box.addEventListener('wheel', onWheel, { passive: false });
    return () => box.removeEventListener('wheel', onWheel);
  }, [apply]);

  const zoomCenter = (factor: number) => {
    const box = boxRef.current;
    if (box) apply(zoomAt(view.current, factor, box.clientWidth / 2, box.clientHeight / 2));
  };

  const actions = [
    fullscreen
      ? {
          key: 'close',
          label: t('common.exitFullscreen'),
          icon: <CloseIcon fontSize="small" />,
          onClick: () => onClose?.(),
        }
      : {
          key: 'full',
          label: t('common.fullscreen'),
          icon: <FullscreenIcon fontSize="small" />,
          onClick: () => onFullscreen?.(),
        },
    {
      key: 'in',
      label: t('common.zoomIn'),
      icon: <ZoomInIcon fontSize="small" />,
      onClick: () => zoomCenter(ZOOM_FACTOR),
    },
    {
      key: 'out',
      label: t('common.zoomOut'),
      icon: <ZoomOutIcon fontSize="small" />,
      onClick: () => zoomCenter(1 / ZOOM_FACTOR),
    },
    { key: 'reset', label: t('common.resetView'), icon: <RestartAltIcon fontSize="small" />, onClick: fit },
  ];

  return (
    <Box sx={{ ...viewerFrameSx, height, overflow: 'hidden' }}>
      <ViewerToolbar actions={actions} always={fullscreen} />
      <Box
        ref={boxRef}
        role="img"
        aria-label={t('common.diagram')}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, vx: view.current.x, vy: view.current.y };
          setDragging(true);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d) apply({ ...view.current, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y });
        }}
        onPointerUp={() => {
          drag.current = null;
          setDragging(false);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setDragging(false);
        }}
        sx={{
          width: '100%',
          height: '100%',
          overflow: 'hidden',
          touchAction: 'none',
          cursor: dragging ? 'grabbing' : 'grab',
          userSelect: 'none',
        }}
      >
        <Box ref={contentRef} sx={{ transformOrigin: '0 0', width: 'max-content' }} />
      </Box>
    </Box>
  );
}

export default function MermaidBlock({ code }: { code: string }) {
  const dark = useTheme().palette.mode === 'dark';
  const id = 'mmd-' + useId().replace(/[^a-zA-Z0-9]/g, '');
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  const [full, setFull] = useState(false);

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
  return (
    <>
      <Box
        sx={{
          my: 1,
          border: 1,
          borderColor: 'divider',
          borderRadius: 1,
          overflow: 'hidden',
          bgcolor: 'background.paper',
        }}
      >
        <Viewer svg={svg} height={DIAGRAM_HEIGHT} fullscreen={false} onFullscreen={() => setFull(true)} />
      </Box>
      <Dialog fullScreen open={full} onClose={() => setFull(false)} aria-label={t('common.diagram')}>
        <Box sx={{ height: '100%', bgcolor: 'background.default' }}>
          {full && <Viewer svg={svg} height="100%" fullscreen onClose={() => setFull(false)} />}
        </Box>
      </Dialog>
    </>
  );
}
