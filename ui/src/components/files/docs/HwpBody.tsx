/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 한글(HWP·HWPX) 본문(스펙 2026-10-20-005 2단계). 해석·그리기는 hwp.worker(리뷰 D4), 문서마다 새 스레드(리뷰 D8).
// - wasm 을 받는 동안 1초가 넘으면 진행 막대(디자인 DV3). 압축 응답이면 받은 양만(재검토 D2). 15초 멈추면 실패(재검토 D8)
// - 30초 한도는 wasm 초기화가 끝난 뒤 문서 열기부터 센다(DV3·리뷰 D14). 쪽 하나는 15초(재검토 D8)
// - 쪽 SVG 는 격리 iframe(스크립트 금지 + CSP) 안 쪽 자리에 넣는다. iframe 높이는 내용에 맞추고 스크롤은 바깥 상자 하나(DV11).
//   그릴 쪽은 바깥 scrollTop 과 쪽 위치로 계산한다 — iframe 안 관찰자는 모든 쪽을 보이는 것으로 본다(재검토 E1)
// - 원본과 모양이 다를 수 있다는 띠(DV6)
import RefreshIcon from '@mui/icons-material/Refresh';
import { Box, Button, LinearProgress, Stack, Typography, useMediaQuery, useTheme } from '@mui/material';
import wasmUrl from '@rhwp/core/rhwp_bg.wasm?url';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useChatTokens } from '@/components/chat/useChatTokens';
import { t } from '@/i18n';

import { assetGone, type DocBodyProps } from './DocBody';
import { fitWidth, pageAt, pageRange } from './docMath';
import { docStore, useDoc } from './docStore';
import { connect, type DocWorker, DocWorkerError, OPEN_TIMEOUT, PAGE_TIMEOUT, progressText } from './workerClient';

const CSP = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data: blob:";
const GAP = 16;
/** wasm 받기·초기화는 멈춤 감지(15초)가 지키므로 전체 한도는 넉넉히 둔다 */
const INIT_GUARD = 10 * 60_000;

interface Size {
  w: number;
  h: number;
}

function shell(edge: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>
:root{color-scheme:light dark;}
html,body{margin:0;padding:0;background:transparent;}
#pages{display:flex;flex-direction:column;align-items:center;gap:${GAP}px;}
.pg{background:#fff;color:#000;border:1px solid ${edge};box-sizing:border-box;overflow:hidden;flex-shrink:0;}
.pg>svg{display:block;width:100%;height:100%;}
</style></head><body><div id="pages"></div></body></html>`;
}

export default function HwpBody({ file, bytes, onFail }: DocBodyProps) {
  const tk = useChatTokens();
  const theme = useTheme();
  const narrow = useMediaQuery(theme.breakpoints.down('sm'));
  const doc = useDoc();
  const scroller = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const worker = useRef<DocWorker | null>(null);
  const [progress, setProgress] = useState<{ got: number; total: number; encoded: boolean } | null>(null);
  const [slow, setSlow] = useState(false);
  const [sizes, setSizes] = useState<Size[] | null>(null);
  const [frameReady, setFrameReady] = useState(false);
  const [box, setBox] = useState({ width: 800, height: 600, top: 0 });
  const [late, setLate] = useState<number[]>([]);
  const drawn = useRef(new Set<number>());
  const asked = useRef(new Set<number>());

  // ---- 스레드 시작: wasm 받기 → 문서 열기 -------------------------------------
  useEffect(() => {
    const w = connect(new Worker(new URL('./hwp.worker.ts', import.meta.url), { type: 'module', name: 'hwp' }));
    worker.current = w;
    const slowTimer = setTimeout(() => setSlow(true), 1000); // 1초 안에 끝나면 막대를 띄우지 않는다(캐시)
    w.on('progress', (d) => setProgress(d as { got: number; total: number; encoded: boolean }));
    const fail = async (e: unknown) => {
      const code = e instanceof DocWorkerError ? e.code : 'failed';
      if (code === 'gone') return;
      if (code === 'stall') return onFail({ type: 'retry', reason: t('chat.viewer.doc.stall') });
      if (code === 'timeout') return onFail({ type: 'retry', reason: t('chat.viewer.doc.timeout') });
      onFail((await assetGone([wasmUrl])) ? { type: 'newVersion' } : { type: 'retry', reason: t('chat.viewer.doc.failOpen') });
    };
    (async () => {
      await w.request({ type: 'init', wasmUrl }, INIT_GUARD);
      clearTimeout(slowTimer);
      setProgress(null);
      const copy = bytes.slice().buffer;
      const opened = await w.request<{ pages: number; sizes: Size[] }>({ type: 'open', bytes: copy }, OPEN_TIMEOUT, [copy]);
      if (!opened.pages) return onFail({ type: 'empty' });
      docStore.setPages(opened.pages);
      setSizes(opened.sizes);
    })().catch(fail);
    return () => {
      clearTimeout(slowTimer);
      w.terminate();
    };
  }, [bytes, onFail]);

  // ---- 크기·위치 -------------------------------------------------------------
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setBox((b) => ({ ...b, width: el.clientWidth, height: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const pad = narrow ? 8 : 24;
  const widest = sizes ? Math.max(...sizes.map((s) => s.w)) : 794;
  const fit = fitWidth(box.width, narrow);
  const factor = (fit / widest) * (doc.zoom / 100);
  const tops = useMemo(() => {
    const out: number[] = [];
    let y = pad;
    for (const s of sizes ?? []) {
      out.push(y);
      y += (s.h + GAP) * factor;
    }
    return out;
  }, [sizes, factor, pad]);
  const current = pageAt(tops, box.top, box.height) || 1;
  const [from, to] = pageRange(current, sizes?.length ?? 0);
  useEffect(() => {
    if (sizes) docStore.setPage(current);
  }, [current, sizes]);
  useEffect(() => {
    if (sizes) docStore.setNatural((widest / fit) * 100);
  }, [sizes, widest, fit]);
  useEffect(() => {
    const el = scroller.current;
    if (!el || !doc.goto.seq) return;
    el.scrollTop = (tops[doc.goto.page - 1] ?? 0) - pad;
  }, [doc.goto.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- 쪽 자리 만들기·zoom --------------------------------------------------------
  const frameDoc = () => frame.current?.contentDocument ?? null;
  useEffect(() => {
    const d = frameDoc();
    const host = d?.getElementById('pages');
    if (!frameReady || !sizes || !host || !d) return;
    host.innerHTML = sizes.map((s, i) => `<div class="pg" data-page="${i + 1}" style="width:${s.w}px;height:${s.h}px"></div>`).join('');
    drawn.current.clear();
    asked.current.clear();
    const el = scroller.current;
    const active = document.activeElement;
    if (el && active && active !== el && active.contains(el)) el.focus({ preventScroll: true });
  }, [frameReady, sizes]);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const d = frameDoc();
    if (!frameReady || !sizes || !d) return;
    (d.body.style as CSSStyleDeclaration & { zoom: string }).zoom = String(factor);
    setHeight(d.documentElement.scrollHeight);
  }, [frameReady, sizes, factor]);

  // ---- 보이는 쪽 그리기 ----------------------------------------------------------
  useEffect(() => {
    const d = frameDoc();
    const w = worker.current;
    if (!d || !w || !sizes) return;
    const slot = (n: number) => d.querySelector<HTMLElement>(`.pg[data-page="${n}"]`);
    for (let n = 1; n <= sizes.length; n++) {
      const inRange = n >= from && n <= to;
      if (!inRange && drawn.current.has(n)) {
        // 범위 밖 쪽은 비워 메모리를 돌려준다
        const s = slot(n);
        if (s) s.innerHTML = '';
        drawn.current.delete(n);
      }
      if (!inRange || drawn.current.has(n) || asked.current.has(n) || late.includes(n)) continue;
      asked.current.add(n);
      w.request<string>({ type: 'page', page: n }, PAGE_TIMEOUT)
        .then((svg) => {
          asked.current.delete(n);
          const s = slot(n);
          if (!s) return;
          s.innerHTML = svg; // 스크립트 금지 iframe 안이라 SVG 안 스크립트·이벤트 속성은 돌지 않는다
          s.setAttribute('role', 'group');
          s.setAttribute('aria-label', t('chat.viewer.doc.pageOf', { page: n, pages: sizes.length }));
          drawn.current.add(n);
        })
        .catch((e: unknown) => {
          asked.current.delete(n);
          if (e instanceof DocWorkerError && e.code === 'gone') return;
          setLate((l) => (l.includes(n) ? l : [...l, n]));
        });
    }
  }, [from, to, sizes, frameReady, late]);

  const p = progress ? progressText(progress.got, progress.total, progress.encoded) : null;
  return (
    <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <Stack role="status" direction="row" alignItems="center" spacing={1} sx={{ minHeight: 32, px: 2, fontSize: 12, color: tk.text, bgcolor: tk.rail, borderBottom: `1px solid ${tk.line}`, flexShrink: 0 }}>
        {late.length ? (
          <>
            <span>{`${t('chat.viewer.doc.pageFail')} (${late.join(', ')})`}</span>
            <Button size="small" startIcon={<RefreshIcon />} onClick={() => setLate([])}>
              {t('chat.viewer.doc.pageRetry')}
            </Button>
          </>
        ) : (
          <span>{t('chat.viewer.doc.mayDiffer')}</span>
        )}
      </Stack>
      {!sizes && slow && (
        <Stack alignItems="center" spacing={1} sx={{ px: 3, pt: 3, bgcolor: tk.sunken }}>
          <Box sx={{ width: '100%', maxWidth: 360 }}>
            <LinearProgress variant={p?.known ? 'determinate' : 'indeterminate'} value={p?.known && progress ? (progress.got / progress.total) * 100 : undefined} sx={{ height: 2 }} />
          </Box>
          <Typography sx={{ fontSize: 12, color: tk.muted, fontVariantNumeric: 'tabular-nums' }}>
            {`${t('chat.viewer.doc.hwpPreparing')}${p ? ` · ${p.text}` : ''}`}
          </Typography>
        </Stack>
      )}
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
          onLoad={() => setFrameReady(true)}
          // color-scheme 을 안쪽 문서와 같은 값으로(다르면 iframe 바탕이 흰색으로 칠해진다, §9)
          sx={{ display: 'block', width: '100%', height: height || '100%', border: 0, colorScheme: 'light dark', visibility: sizes ? 'visible' : 'hidden' }}
        />
      </Box>
    </Box>
  );
}
