/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// PDF 본문(스펙 2026-10-20-005, 묶음 vendor-pdf). DocBody 가 처음 열 때 받는다.
// - 보이는 쪽과 앞뒤 2쪽만 그린다(리뷰 D5). 그린 쪽 화소 합이 상한을 넘으면 앞뒤 쪽 수를 줄인다(재검토 D4)
// - 쪽 하나가 15초 안에 안 그려지면 그 자리에 다시 단추(재검토 D8)
// - 암호 PDF 는 비밀번호 칸(디자인 DV4), 문서 안 링크는 그 쪽으로, 바깥 링크는 누를 수 없게(DV14)
// - 찾기: 처음 찾을 때 쪽마다 한 번 읽어 두고 300ms 뒤 찾는다. 1,000개에서 멈춘다(재검토 D1). 표시는 조각마다 이스케이프(E2·OV2-H3)
// pdf.js 는 넘긴 Uint8Array 를 작업 스레드로 옮겨 비우므로 늘 복사본을 넘긴다(OV2-M5). suspense 를 끄고 file·options 를 고정해
// 다시 그려도 작업 스레드를 다시 열지 않는다(§9).
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

import CloseIcon from '@mui/icons-material/Close';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import { Box, Button, IconButton, InputBase, Stack, TextField, Tooltip, Typography, useMediaQuery, useTheme } from '@mui/material';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { type FormEvent, type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';

import { useChatTokens } from '@/components/chat/useChatTokens';
import { t } from '@/i18n';

import type { DocBodyProps } from './DocBody';
import { assetGone } from './DocBody';
import { canvasRatio, escapeHtml, FIND_CAP, findIn, fitWidth, keepCount, markItem, pageAt, pageRange, type PageText, pageText } from './docMath';
import { docStore, useDoc } from './docStore';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
/** 빌드가 pdfjs-dist 의 cmaps·standard_fonts·wasm 을 버전 폴더로 복사한다(scripts/copy-pdfjs-assets.mjs, 외부 검토 OV6) */
export const PDFJS_BASE = `/assets/pdfjs-${pdfjs.version}/`;
const OPTIONS = { cMapUrl: `${PDFJS_BASE}cmaps/`, cMapPacked: true, standardFontDataUrl: `${PDFJS_BASE}standard_fonts/`, wasmUrl: `${PDFJS_BASE}wasm/` };
/** 다시 배포되면 지워지는 파일 — 실패하면 이 주소로 새 버전인지 본다(재검토 D7) */
const PROBES = [pdfjs.GlobalWorkerOptions.workerSrc, `${PDFJS_BASE}cmaps/Adobe-Korea1-UCS2.bcmap`];
const PAGE_TIMEOUT = 15_000;
const FIND_DELAY = 300;
const INCORRECT_PASSWORD = 2;

interface Hit {
  page: number;
  range: [number, number];
}

export default function PdfBody({ bytes, onFail }: DocBodyProps) {
  const tk = useChatTokens();
  const theme = useTheme();
  const narrow = useMediaQuery(theme.breakpoints.down('sm'));
  const doc = useDoc();
  // 복사본을 한 번만 만든다(다시 시도는 DocBody 가 이 본문을 새로 만든다)
  const [src] = useState(() => ({ data: bytes.slice() }));
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [ratio, setRatio] = useState(1.4142);
  const [password, setPassword] = useState<{ cb: (p: string) => void; wrong: boolean } | null>(null);
  const [stale, setStale] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 800, height: 600, top: 0 });

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
  const pages = pdf?.numPages ?? 0;
  const pad = narrow ? 8 : 24;
  const gap = narrow ? 8 : 16;
  const width = Math.round((fitWidth(box.width, narrow) * doc.zoom) / 100);
  const pageHeight = Math.round(width * ratio);
  const tops = useMemo(() => Array.from({ length: pages }, (_, i) => pad + i * (pageHeight + gap)), [pages, pageHeight, pad, gap]);
  const dpr = canvasRatio(width, pageHeight, typeof window === 'undefined' ? 1 : window.devicePixelRatio);
  const around = Math.min(2, Math.floor((keepCount(width * pageHeight * dpr * dpr) - 1) / 2));
  const current = pageAt(tops, box.top, box.height) || 1;
  const [from, to] = pageRange(current, pages, around);

  useEffect(() => {
    if (pages) docStore.setPage(current);
  }, [current, pages]);
  useEffect(() => {
    const el = scroller.current;
    if (!el || !doc.goto.seq) return;
    el.scrollTop = (tops[doc.goto.page - 1] ?? 0) - pad;
  }, [doc.goto.seq]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // 문서를 열면 포커스를 실제 스크롤 상자로(바깥 본문은 overflow hidden 이라 PageDown 이 안 움직인다, OV2-M1)
    const el = scroller.current;
    const active = document.activeElement;
    if (el && active && active !== el && active.contains(el)) el.focus({ preventScroll: true });
  }, [pdf]);

  // ---- 불러오기 --------------------------------------------------------------
  const onLoad = useCallback(
    async (p: PDFDocumentProxy) => {
      setPassword(null);
      if (!p.numPages) return onFail({ type: 'empty' });
      const first = await p.getPage(1);
      const vp = first.getViewport({ scale: 1 });
      setRatio(vp.height / vp.width);
      docStore.setPages(p.numPages);
      docStore.setNatural((vp.width / fitWidth(scroller.current?.clientWidth ?? 800, narrow)) * 100);
      setPdf(p);
      if (await assetGone(PROBES.slice(1))) setStale(true); // 글꼴 맵이 지워졌으면 글자가 깨진다 — 알린다
    },
    [onFail, narrow]
  );
  const onError = useCallback(async () => {
    onFail((await assetGone(PROBES)) ? { type: 'newVersion' } : { type: 'retry', reason: t('chat.viewer.doc.failOpen') });
  }, [onFail]);

  // ---- 찾기 ------------------------------------------------------------------
  const texts = useRef(new Map<number, PageText>());
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [capped, setCapped] = useState(false);
  const [progress, setProgress] = useState(0);
  const [at, setAt] = useState(0);
  useEffect(() => {
    if (!pdf || !doc.findOpen) return;
    const q = query.trim();
    let alive = true;
    const timer = setTimeout(async () => {
      const found: Hit[] = [];
      setProgress(0);
      for (let n = 1; n <= pdf.numPages && alive && q; n++) {
        let pt = texts.current.get(n);
        if (!pt) {
          const pg = await pdf.getPage(n);
          const tc = await pg.getTextContent();
          pt = pageText(tc.items.map((it) => ('str' in it ? it.str : '')));
          texts.current.set(n, pt);
          pg.cleanup(); // 읽은 쪽 객체를 놓는다(OV2-L6)
        }
        for (const r of findIn(pt.text, q, FIND_CAP - found.length)) found.push({ page: n, range: r });
        if (n % 10 === 0 && alive) setProgress(n);
        if (found.length >= FIND_CAP) break;
      }
      if (!alive) return;
      setHits(found);
      setCapped(found.length >= FIND_CAP);
      setProgress(0);
      setAt(0);
      if (found.length) docStore.goto(found[0].page);
    }, FIND_DELAY);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [pdf, query, doc.findOpen]);
  useEffect(() => {
    if (!doc.findOpen) {
      setHits([]);
      setQuery('');
    }
  }, [doc.findOpen]);
  const byPage = useMemo(() => {
    const m = new Map<number, [number, number][]>();
    for (const h of hits) m.set(h.page, [...(m.get(h.page) ?? []), h.range]);
    return m;
  }, [hits]);
  const cur = hits[at];
  const renderer = useMemo(() => {
    if (!hits.length) return undefined;
    return ({ str, itemIndex, pageNumber }: { str: string; itemIndex: number; pageNumber: number }) => {
      const pt = texts.current.get(pageNumber);
      if (!pt) return escapeHtml(str);
      return markItem(pt, itemIndex, byPage.get(pageNumber) ?? [], cur?.page === pageNumber ? cur.range : undefined);
    };
  }, [hits, byPage, cur]);
  const move = (dir: 1 | -1) => {
    if (!hits.length) return;
    const next = (at + dir + hits.length) % hits.length;
    setAt(next);
    docStore.goto(hits[next].page);
  };
  useEffect(() => {
    // 지금 결과가 그려지면 가운데로
    const id = setTimeout(() => scroller.current?.querySelector('mark[data-current]')?.scrollIntoView({ block: 'center' }), 120);
    return () => clearTimeout(id);
  }, [at, hits]);

  // ---- 쪽 그리기 한도 ---------------------------------------------------------
  const [late, setLate] = useState<Set<number>>(new Set());
  const [pageKey, setPageKey] = useState<Record<number, number>>({});
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const done = useRef(new Set<number>());
  useEffect(() => {
    for (let n = from; n <= to; n++) {
      if (timers.current.has(n) || done.current.has(n) || late.has(n)) continue;
      timers.current.set(
        n,
        setTimeout(() => setLate((s) => new Set(s).add(n)), PAGE_TIMEOUT)
      );
    }
  }, [from, to, late]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const rendered = (n: number) => {
    clearTimeout(timers.current.get(n));
    timers.current.delete(n);
    done.current.add(n);
  };
  const retryPage = (n: number) => {
    timers.current.delete(n);
    done.current.delete(n);
    setLate((s) => {
      const c = new Set(s);
      c.delete(n);
      return c;
    });
    setPageKey((k) => ({ ...k, [n]: (k[n] ?? 0) + 1 }));
  };

  // ---- 링크 ------------------------------------------------------------------
  const blockExternal = (e: MouseEvent) => {
    const a = (e.target as Element).closest?.('.annotationLayer a');
    const href = a?.getAttribute('href') || '';
    if (a && /^(https?:|mailto:|ftp:)/i.test(href)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  const titleLinks = () =>
    scroller.current?.querySelectorAll<HTMLAnchorElement>('.annotationLayer a[href]').forEach((a) => {
      const href = a.getAttribute('href') || '';
      if (/^(https?:|mailto:|ftp:)/i.test(href)) {
        a.title = href;
        a.removeAttribute('target');
        a.setAttribute('aria-disabled', 'true');
        a.style.cursor = 'default';
      }
    });

  return (
    <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {stale && (
        <Stack role="status" direction="row" alignItems="center" spacing={1} sx={{ minHeight: 32, px: 2, fontSize: 12, bgcolor: tk.warnWash, borderBottom: `1px solid ${tk.warnLine}`, color: tk.text }}>
          <span>{t('chat.viewer.doc.newVersion')}</span>
          <Button size="small" startIcon={<RefreshIcon />} onClick={() => window.location.reload()}>
            {t('chat.viewer.doc.refresh')}
          </Button>
        </Stack>
      )}
      {doc.findOpen && pdf && (
        <FindBar
          query={query}
          onQuery={setQuery}
          total={hits.length}
          at={at}
          capped={capped}
          progress={progress}
          pages={pages}
          onMove={move}
          onClose={() => docStore.closeFind()}
        />
      )}
      <Box
        ref={scroller}
        data-doc-scroll
        tabIndex={-1}
        onScroll={(e) => {
          const top = e.currentTarget.scrollTop;
          requestAnimationFrame(() => setBox((b) => (b.top === top ? b : { ...b, top })));
        }}
        onClickCapture={blockExternal}
        sx={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          bgcolor: tk.sunken,
          outline: 'none',
          '& mark': { bgcolor: 'rgba(245,158,11,0.35)', color: 'transparent' },
          '& mark[data-current]': { bgcolor: 'rgba(245,158,11,0.75)' },
        }}
      >
        {password && (
          <PasswordForm wrong={password.wrong} onSubmit={(p) => password.cb(p)} />
        )}
        <Document
          file={src}
          options={OPTIONS}
          suspense={false}
          onLoadSuccess={(p) => void onLoad(p)}
          onLoadError={() => void onError()}
          onSourceError={() => void onError()}
          onPassword={(cb, reason) => setPassword({ cb, wrong: reason === INCORRECT_PASSWORD })}
          onItemClick={({ pageNumber }) => docStore.goto(pageNumber)}
          externalLinkTarget="_self"
          loading=""
          error=""
          noData=""
        >
          {pdf && (
            <Box sx={{ py: `${pad}px`, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: `${gap}px`, minWidth: 'min-content' }}>
              {Array.from({ length: pages }, (_, i) => i + 1).map((n) => {
                const shown = n >= from && n <= to;
                return (
                  <Box
                    key={n}
                    role="group"
                    aria-label={shown ? t('chat.viewer.doc.pageOf', { page: n, pages }) : undefined}
                    sx={{ width, minHeight: pageHeight, bgcolor: '#fff', border: `1px solid ${tk.popup.edge}`, position: 'relative', flexShrink: 0 }}
                  >
                    {shown && late.has(n) ? (
                      <Stack alignItems="center" justifyContent="center" spacing={1} sx={{ height: pageHeight, color: '#374151' }}>
                        <Typography sx={{ fontSize: 13 }}>{t('chat.viewer.doc.pageFail')}</Typography>
                        <Button size="small" variant="outlined" startIcon={<RefreshIcon />} onClick={() => retryPage(n)}>
                          {t('chat.viewer.doc.pageRetry')}
                        </Button>
                      </Stack>
                    ) : shown ? (
                      <Page
                        key={`${n}-${pageKey[n] ?? 0}`}
                        pageNumber={n}
                        width={width}
                        devicePixelRatio={dpr}
                        loading=""
                        customTextRenderer={renderer}
                        onRenderSuccess={() => rendered(n)}
                        onRenderAnnotationLayerSuccess={titleLinks}
                      />
                    ) : null}
                  </Box>
                );
              })}
            </Box>
          )}
        </Document>
      </Box>
    </Box>
  );
}

function PasswordForm({ wrong, onSubmit }: { wrong: boolean; onSubmit: (p: string) => void }) {
  const tk = useChatTokens();
  const [value, setValue] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), [wrong]); // onPassword 가 열린 뒤에 늦게 불리므로 그때 포커스(OV2-L2)
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value) onSubmit(value);
    setValue('');
  };
  return (
    <Stack component="form" onSubmit={submit} alignItems="center" spacing={1.5} sx={{ p: 4, maxWidth: 360, mx: 'auto', textAlign: 'center' }}>
      <LockOutlinedIcon sx={{ fontSize: 40, color: tk.muted }} />
      <Typography sx={{ fontSize: 14, color: tk.text }}>{t('chat.viewer.doc.pdfPassword')}</Typography>
      <TextField
        inputRef={ref}
        type="password"
        size="small"
        fullWidth
        label={t('chat.viewer.doc.password')}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        error={wrong}
        helperText={wrong ? t('chat.viewer.doc.pdfPasswordWrong') : ' '}
        autoComplete="off"
      />
      <Button type="submit" variant="contained" size="small" disabled={!value}>
        {t('chat.viewer.doc.open')}
      </Button>
    </Stack>
  );
}

function FindBar(props: {
  query: string;
  onQuery: (q: string) => void;
  total: number;
  at: number;
  capped: boolean;
  progress: number;
  pages: number;
  onMove: (d: 1 | -1) => void;
  onClose: () => void;
}) {
  const tk = useChatTokens();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const status = props.progress
    ? t('chat.viewer.doc.finding', { n: props.progress, total: props.pages })
    : !props.query.trim()
      ? ''
      : props.total
        ? `${t('chat.viewer.doc.findCount', { n: props.at + 1, total: props.total })}${props.capped ? ` · ${t('chat.viewer.doc.findOver', { cap: FIND_CAP.toLocaleString() })}` : ''}`
        : t('chat.viewer.doc.findNone');
  return (
    <Stack direction="row" alignItems="center" spacing={1} sx={{ minHeight: 36, px: 1.5, borderBottom: `1px solid ${tk.line}`, bgcolor: tk.popup.surface, flexShrink: 0 }}>
      <InputBase
        inputRef={ref}
        value={props.query}
        onChange={(e) => props.onQuery(e.target.value)}
        placeholder={t('chat.viewer.doc.find')}
        inputProps={{ 'aria-label': t('chat.viewer.doc.find') }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            props.onMove(e.shiftKey ? -1 : 1);
          } else if (e.key === 'Escape') {
            // Esc 는 찾기 줄만 닫는다(002 DD15 ⑤)
            e.preventDefault();
            e.stopPropagation();
            props.onClose();
          }
        }}
        sx={{ flex: 1, fontSize: 13, color: tk.text }}
      />
      <Typography role="status" sx={{ fontSize: 12, color: tk.muted, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
        {status}
      </Typography>
      <Tooltip title={t('chat.viewer.doc.findPrev')}>
        <span>
          <IconButton size="small" aria-label={t('chat.viewer.doc.findPrev')} disabled={!props.total} onClick={() => props.onMove(-1)}>
            <KeyboardArrowUpIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title={t('chat.viewer.doc.findNext')}>
        <span>
          <IconButton size="small" aria-label={t('chat.viewer.doc.findNext')} disabled={!props.total} onClick={() => props.onMove(1)}>
            <KeyboardArrowDownIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title={t('chat.viewer.doc.findClose')}>
        <IconButton size="small" aria-label={t('chat.viewer.doc.findClose')} onClick={props.onClose}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Stack>
  );
}
