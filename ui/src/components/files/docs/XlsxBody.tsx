/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 엑셀 본문(스펙 2026-10-20-005 2단계, 디자인 DV10). 해석은 xlsx.worker(리뷰 D4), 30초 한도(리뷰 D14).
// 시트 탭(DESIGN §4 Bordered Tabs), 열 머리 A·B·C 와 행 번호를 고정, 숫자는 오른쪽 정렬, 칸 값은 글자로만 넣는다(HTML 아님).
// 줄 높이가 고정이라 보이는 줄 + 앞뒤 20줄만 그린다(재검토 D9). @tanstack/react-virtual 3.10.6(앱에 있는 판)은 React 19 를
// 지원하지 않아 설치가 막혀, 같은 일을 하는 계산을 여기 둔다.
import { Box, Stack, Tab, Tabs, Typography } from '@mui/material';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useChatTokens } from '@/components/chat/useChatTokens';
import { t } from '@/i18n';

import type { DocBodyProps } from './DocBody';
import { connect, DocWorkerError, OPEN_TIMEOUT } from './workerClient';
import type { Sheet } from './xlsx.worker';
import { colName } from './xlsxFormat';

const ROW = 28;
const OVERSCAN = 20;

/** 스크롤 위치 → 그릴 줄 범위 [시작, 끝) */
export function rowWindow(scrollTop: number, viewport: number, total: number): [number, number] {
  const start = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN);
  const end = Math.min(total, Math.ceil((scrollTop + viewport) / ROW) + OVERSCAN);
  return [start, end];
}

export default function XlsxBody({ bytes, onFail }: DocBodyProps) {
  const tk = useChatTokens();
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  const [tab, setTab] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 600 });

  useEffect(() => {
    const w = connect(new Worker(new URL('./xlsx.worker.ts', import.meta.url), { type: 'module', name: 'xlsx' }));
    const copy = bytes.slice().buffer;
    w.request<Sheet[]>({ type: 'open', bytes: copy }, OPEN_TIMEOUT, [copy])
      .then((s) => (s.length ? setSheets(s) : onFail({ type: 'empty' })))
      .catch((e: unknown) => {
        const code = e instanceof DocWorkerError ? e.code : 'failed';
        if (code === 'gone') return;
        onFail({ type: 'retry', reason: t(code === 'timeout' ? 'chat.viewer.doc.timeout' : 'chat.viewer.doc.failOpen') });
      });
    return () => w.terminate(); // 문서마다 새 스레드, 닫으면 끊는다(리뷰 D8)
  }, [bytes, onFail]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setView({ top: el.scrollTop, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [sheets, tab]);
  useEffect(() => {
    const el = scroller.current;
    const active = document.activeElement;
    if (sheets && el && active && active !== el && active.contains(el)) el.focus({ preventScroll: true });
  }, [sheets]);

  const sheet = sheets?.[tab];
  const empty = useMemo(() => !sheet || sheet.rows.every((r) => r.every((c) => c === '')), [sheet]);
  if (!sheets || !sheet) return null;
  const [from, to] = rowWindow(view.top, view.height, sheet.rows.length);
  const cut = sheet.cutRows || sheet.cutCols;
  const cell = { borderRight: `1px solid ${tk.line}`, borderBottom: `1px solid ${tk.line}`, px: 1, height: ROW, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const;
  const head = { ...cell, bgcolor: tk.rail, color: tk.muted, fontSize: 12, fontWeight: 400, position: 'sticky', zIndex: 1 } as const;

  return (
    <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <Tabs
        value={tab}
        onChange={(_, v: number) => {
          setTab(v);
          scroller.current?.scrollTo({ top: 0 });
        }}
        variant="scrollable"
        scrollButtons="auto"
        aria-label={t('chat.viewer.doc.sheets')}
        sx={{
          minHeight: 36,
          borderBottom: `1px solid ${tk.line}`,
          flexShrink: 0,
          '& .MuiTab-root': { minHeight: 36, textTransform: 'none', fontSize: 13, color: tk.muted, '@media (pointer: coarse)': { minHeight: 44 } },
          '& .Mui-selected': { color: `${tk.text} !important`, fontWeight: 600 },
          '& .MuiTabs-indicator': { bgcolor: tk.text, height: 2 },
        }}
      >
        {sheets.map((s, i) => (
          <Tab key={s.name + i} label={s.name} value={i} />
        ))}
      </Tabs>
      {cut && (
        <Stack role="status" direction="row" alignItems="center" sx={{ minHeight: 32, px: 2, fontSize: 12, color: tk.text, bgcolor: tk.warnWash, borderBottom: `1px solid ${tk.warnLine}`, flexShrink: 0 }}>
          {t('chat.viewer.doc.sheetCut')}
        </Stack>
      )}
      {empty ? (
        <Stack alignItems="center" justifyContent="center" sx={{ flex: 1 }}>
          <Typography sx={{ fontSize: 14, color: tk.muted }}>{t('chat.viewer.doc.emptySheet')}</Typography>
        </Stack>
      ) : (
        <Box
          ref={scroller}
          data-doc-scroll
          tabIndex={0}
          role="region"
          aria-label={sheet.name}
          onScroll={(e) => {
            const top = e.currentTarget.scrollTop;
            requestAnimationFrame(() => setView((v) => (v.top === top ? v : { ...v, top })));
          }}
          sx={{ flex: 1, minHeight: 0, overflow: 'auto', outline: 'none', '&:focus-visible': { boxShadow: `inset 0 0 0 2px ${tk.line}` } }}
        >
          <Box component="table" sx={{ borderCollapse: 'separate', borderSpacing: 0, fontSize: 13, color: tk.text, fontVariantNumeric: 'tabular-nums' }}>
            <thead>
              <tr>
                <Box component="th" sx={{ ...head, top: 0, left: 0, zIndex: 2, minWidth: 48 }} />
                {Array.from({ length: sheet.cols }, (_, c) => (
                  <Box component="th" key={c} scope="col" sx={{ ...head, top: 0, textAlign: 'center', minWidth: 80 }}>
                    {colName(c + 1)}
                  </Box>
                ))}
              </tr>
            </thead>
            <tbody>
              {from > 0 && <tr style={{ height: from * ROW }} aria-hidden />}
              {sheet.rows.slice(from, to).map((row, i) => {
                const r = from + i;
                return (
                  <tr key={r}>
                    <Box component="th" scope="row" sx={{ ...head, left: 0, textAlign: 'right', minWidth: 48 }}>
                      {r + 1}
                    </Box>
                    {row.map((v, c) => (
                      <Box component="td" key={c} title={v.length > 40 ? v : undefined} sx={{ ...cell, textAlign: sheet.numeric[r * sheet.cols + c] ? 'right' : 'left' }}>
                        {v}
                      </Box>
                    ))}
                  </tr>
                );
              })}
              {to < sheet.rows.length && <tr style={{ height: (sheet.rows.length - to) * ROW }} aria-hidden />}
            </tbody>
          </Box>
        </Box>
      )}
    </Box>
  );
}
