/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 파일 뷰어 본문(스펙 2026-10-20-002 §3-5) — LazyFileViewer 가 처음 열 때 받는 묶음이다(R9).
// 받기 API 를 fetch 하고(X-AAS 머리, F12), 실패는 X-AAS-Code(F2), 한도는 Content-Length 로 판단한다(R3). 글 종류는 앞부분만 읽어 보이고,
// 그 밖은 넘으면 받지 않는다. 바이트는 종류 형식으로 다시 감싸고(F1) 닫으면 요청을 끊고 Blob 주소를 놓는다.
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined';
import { Box, Stack, useTheme } from '@mui/material';
import { type ReactNode, type RefObject, Suspense, useEffect, useMemo, useState } from 'react';

import { useChatTokens } from '@/components/chat/useChatTokens';
import { languageOf } from '@/components/codeLanguage';
import { LazyCodeEditor } from '@/components/LazyCodeEditor';
import { Markdown } from '@/components/Markdown';
import { getLang, t } from '@/i18n';
import { humanSize, reasonText as chatReason } from '@/lib/chatFiles';
import { chatMetrics } from '@/lib/chatTokens';
import { parseCsv } from '@/lib/csv';
import { extOf, mimeOf, PARTIAL_OK, VIEW_LIMIT, type ViewerKind } from '@/lib/fileKinds';
import { prepareHtml } from '@/lib/htmlPrep';
import { MONO_FONT } from '@/lib/monoFont';

import { DocBody } from './docs/DocBody';
import { BodySkeleton, Failure, isDocKind, Notice } from './viewerParts';
import type { ViewerFile } from './viewerStore';

const CSV_ROWS = 1000;

type Loaded =
  | { state: 'loading' }
  | { state: 'fail'; reason: string; retry: boolean }
  | { state: 'small'; reason: string }
  | { state: 'empty' }
  | { state: 'text'; text: string; partial: boolean; url?: string }
  | { state: 'blob'; url: string }
  | { state: 'bytes'; bytes: Uint8Array };

/** 스트림을 limit 바이트까지만 읽는다. 넘으면 끊고 over 를 참으로(글 종류는 그만큼 보이고, 그 밖은 버린다) */
async function readUpTo(res: Response, limit: number): Promise<{ bytes: Uint8Array; over: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.length > limit ? { bytes: buf.slice(0, limit), over: true } : { bytes: buf, over: false };
  }
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.length > limit) {
      parts.push(value.slice(0, limit - total));
      total = limit;
      await reader.cancel();
      return { bytes: join(parts, total), over: true };
    }
    parts.push(value);
    total += value.length;
  }
  return { bytes: join(parts, total), over: false };
}

function join(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** UTF-8 로 읽는다. 자른 끝의 덜 끝난 글자는 버린다(stream). 대체 문자가 많으면 글이 아니다 */
export function decodeText(bytes: Uint8Array, partial: boolean): string | null {
  const text = new TextDecoder('utf-8').decode(bytes, { stream: partial });
  const sample = text.slice(0, 4096);
  const bad = (sample.match(/�/g) || []).length;
  if (sample.length && bad / sample.length > 0.1) return null;
  if (sample.includes(String.fromCharCode(0))) return null; // NUL 이 있으면 바이너리
  return text;
}

export function useFileBytes(file: ViewerFile, kind: ViewerKind, attempt: number, onSize: (n: number) => void, onSmall: () => void): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const reasonText = (code: string) => (file.reasonOf ?? chatReason)(code);
  useEffect(() => {
    if (file.blocked) {
      setLoaded({ state: 'small', reason: reasonText(file.blocked) });
      onSmall();
      return;
    }
    if (kind === 'other') {
      setLoaded({ state: 'small', reason: t('chat.viewer.unsupported') });
      return;
    }
    const ctl = new AbortController();
    let url = '';
    setLoaded({ state: 'loading' });
    (async () => {
      let res: Response;
      try {
        res = await fetch(file.url, { headers: { 'X-AAS': '1', 'Accept-Language': getLang() }, signal: ctl.signal });
      } catch {
        if (!ctl.signal.aborted) setLoaded({ state: 'fail', reason: reasonText('agent_unreachable'), retry: true });
        return;
      }
      if (!res.ok) {
        const code = res.headers.get('X-AAS-Code') || (res.status === 404 ? 'not_found' : 'unknown');
        setLoaded({ state: 'fail', reason: reasonText(code), retry: code === 'busy' || code === 'agent_unreachable' || code === 'unknown' });
        return;
      }
      const length = Number(res.headers.get('Content-Length'));
      const limit = VIEW_LIMIT[kind];
      if (Number.isFinite(length) && length >= 0 && res.headers.get('Content-Length')) onSize(length);
      if (length > limit && !PARTIAL_OK.has(kind)) {
        ctl.abort();
        setLoaded({ state: 'small', reason: t('chat.viewer.tooLarge') });
        onSmall();
        return;
      }
      const { bytes, over } = await readUpTo(res, PARTIAL_OK.has(kind) ? limit : limit + 1);
      if (ctl.signal.aborted) return;
      if (over && !PARTIAL_OK.has(kind)) {
        setLoaded({ state: 'small', reason: t('chat.viewer.tooLarge') });
        onSmall();
        return;
      }
      if (!bytes.length) return setLoaded({ state: 'empty' });
      if (isDocKind(kind)) return setLoaded({ state: 'bytes', bytes }); // 문서는 본문 라이브러리가 바이트를 읽는다(005)
      if (kind === 'text' || kind === 'markdown' || kind === 'csv' || kind === 'html') {
        const text = decodeText(bytes, over);
        if (text == null) {
          if (kind === 'text' && !extOf(file.name)) {
            setLoaded({ state: 'small', reason: t('chat.viewer.unsupported') });
            onSmall();
          } else setLoaded({ state: 'fail', reason: t('chat.viewer.notText'), retry: false });
          return;
        }
        return setLoaded({ state: 'text', text, partial: over });
      }
      if (kind === 'svg') {
        // SVG 는 보기(그림)와 원문 둘 다 쓴다 — 글로도 읽어 둔다
        url = URL.createObjectURL(new Blob([bytes], { type: mimeOf(file.name) }));
        return setLoaded({ state: 'text', text: new TextDecoder().decode(bytes), partial: false, url });
      }
      url = URL.createObjectURL(new Blob([bytes], { type: mimeOf(file.name) }));
      setLoaded({ state: 'blob', url });
    })().catch(() => {
      if (!ctl.signal.aborted) setLoaded({ state: 'fail', reason: t('chat.viewer.failLoad'), retry: true });
    });
    return () => {
      ctl.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [file, kind, attempt]); // eslint-disable-line react-hooks/exhaustive-deps
  return loaded;
}

interface Props {
  file: ViewerFile;
  kind: ViewerKind;
  mode: 'view' | 'source';
  wrap: boolean;
  fit: boolean;
  small: boolean;
  onSize: (n: number) => void;
  onSmall: () => void;
  primaryRef: RefObject<HTMLButtonElement | null>;
}

export default function FileViewer({ file, kind, mode, wrap, fit, onSize, onSmall }: Props) {
  const [attempt, setAttempt] = useState(0);
  const loaded = useFileBytes(file, kind, attempt, onSize, onSmall);
  const [renderFail, setRenderFail] = useState('');
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    setRenderFail('');
    setBroken(false);
  }, [attempt]);

  if (loaded.state === 'loading') return <BodySkeleton kind={kind} />;
  if (loaded.state === 'small') return <Notice file={file} text={loaded.reason} />;
  if (loaded.state === 'empty') return <Notice file={file} text={t('chat.viewer.empty')} />;
  if (loaded.state === 'fail' || renderFail)
    return (
      <Failure
        file={file}
        image={broken}
        reason={renderFail || (loaded.state === 'fail' ? loaded.reason : '')}
        onRetry={loaded.state === 'fail' && !loaded.retry && !renderFail ? undefined : () => setAttempt((a) => a + 1)}
      />
    );

  if (loaded.state === 'bytes') return <DocBody file={file} kind={kind} bytes={loaded.bytes} onSmall={onSmall} />;

  if (loaded.state === 'text') {
    const svgUrl = loaded.url;
    if (kind === 'svg' && mode === 'view' && svgUrl) return <ImageView url={svgUrl} name={file.name} fit={fit} onError={() => (setBroken(true), setRenderFail(t('chat.viewer.failImage')))} />;
    const strip = loaded.partial ? <Strip warn text={t('chat.viewer.partial', { size: humanSize(VIEW_LIMIT[kind]) })} /> : null;
    if (mode === 'view' && kind === 'markdown')
      return (
        <Scroll strip={strip}>
          <Box sx={{ maxWidth: chatMetrics.columnMax, mx: 'auto', px: 3, py: 2 }}>
            <Markdown text={loaded.text} noRemoteImages />
          </Box>
        </Scroll>
      );
    if (mode === 'view' && kind === 'csv') return <CsvView text={loaded.text} tsv={extOf(file.name) === 'tsv'} strip={strip} />;
    if (mode === 'view' && kind === 'html')
      return (
        <Scroll strip={<Strip text={`${t('chat.viewer.htmlWarn')} · ${t('chat.viewer.iframeHint')}`} />} noScroll>
          <Box
            component="iframe"
            title={file.name}
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={prepareHtml(loaded.text)}
            sx={{ flex: 1, width: '100%', border: 0, bgcolor: '#fff' }}
          />
        </Scroll>
      );
    const language = languageOf(file.name, kind === 'markdown');
    return (
      <Scroll strip={strip} noScroll>
        <Suspense fallback={<Pre text={loaded.text} />}>
          <Box sx={{ flex: 1, minHeight: 0, display: 'flex', '& > *': { flex: 1 } }}>
            <LazyCodeEditor
              value={loaded.text}
              onChange={() => undefined}
              language={language}
              ariaLabel={file.name}
              minRows={1}
              tabIndents={false}
              readOnly
              fill
              wordWrap={wrap ? 'on' : 'off'}
            />
          </Box>
        </Suspense>
      </Scroll>
    );
  }

  const url = loaded.url;
  if (kind === 'image') return <ImageView url={url} name={file.name} fit={fit} onError={() => (setBroken(true), setRenderFail(t('chat.viewer.failImage')))} />;
  if (kind === 'audio')
    return (
      <Center>
        <Box component="audio" controls src={url} onError={() => setRenderFail(t('chat.viewer.failMedia'))} sx={{ width: '100%', maxWidth: 560 }} />
      </Center>
    );
  return (
    <Center>
      <Box component="video" controls src={url} onError={() => setRenderFail(t('chat.viewer.failMedia'))} sx={{ maxWidth: '100%', maxHeight: '100%' }} />
    </Center>
  );
}

/** 본문 맨 위 고정 띠(DD7). warn 이면 호박색 바탕, 아니면 무채색 */
function Strip({ text, warn }: { text: string; warn?: boolean }) {
  const tk = useChatTokens();
  return (
    <Stack
      role="status"
      direction="row"
      alignItems="center"
      spacing={0.75}
      sx={{ minHeight: 32, px: 2, fontSize: 12, color: tk.text, bgcolor: warn ? tk.warnWash : tk.rail, borderBottom: `1px solid ${warn ? tk.warnLine : tk.line}`, flexShrink: 0 }}
    >
      {warn ? <WarningAmberOutlinedIcon sx={{ fontSize: 14, color: '#f59e0b' }} aria-hidden /> : <InfoOutlinedIcon sx={{ fontSize: 14, color: tk.muted }} aria-hidden />}
      <span>{text}</span>
    </Stack>
  );
}

function Scroll({ strip, children, noScroll }: { strip?: ReactNode; children: ReactNode; noScroll?: boolean }) {
  return (
    <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {strip}
      <Box sx={{ flex: 1, minHeight: 0, overflow: noScroll ? 'hidden' : 'auto', display: 'flex', flexDirection: 'column' }}>{children}</Box>
    </Box>
  );
}

function Center({ children }: { children: ReactNode }) {
  return <Box sx={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', p: 2 }}>{children}</Box>;
}

function Pre({ text }: { text: string }) {
  return (
    <Box component="pre" sx={{ m: 0, p: 2, fontFamily: MONO_FONT, fontSize: 13, whiteSpace: 'pre-wrap', overflow: 'auto' }}>
      {text}
    </Box>
  );
}

function ImageView({ url, name, fit, onError }: { url: string; name: string; fit: boolean; onError: () => void }) {
  const dark = useTheme().palette.mode === 'dark';
  const [a, b] = dark ? ['rgba(255,255,255,0.04)', 'rgba(255,255,255,0.08)'] : ['rgba(17,24,39,0.03)', 'rgba(17,24,39,0.07)'];
  return (
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        overflow: 'auto',
        display: 'flex',
        alignItems: fit ? 'center' : 'flex-start',
        justifyContent: fit ? 'center' : 'flex-start',
        p: 2,
        // 투명 그림이 보이도록 8px 체크무늬(DD14)
        backgroundImage: `conic-gradient(${a} 25%, ${b} 0 50%, ${a} 0 75%, ${b} 0)`,
        backgroundSize: '16px 16px',
      }}
    >
      <Box component="img" src={url} alt={name} onError={onError} sx={fit ? { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' } : { maxWidth: 'none' }} />
    </Box>
  );
}

function CsvView({ text, tsv, strip }: { text: string; tsv: boolean; strip: ReactNode }) {
  const tk = useChatTokens();
  const { rows, truncated } = useMemo(() => parseCsv(text, tsv ? '\t' : ',', CSV_ROWS), [text, tsv]);
  const [head, ...body] = rows;
  return (
    <Scroll strip={truncated ? <Strip warn text={t('chat.viewer.csvCut', { count: CSV_ROWS.toLocaleString() })} /> : strip}>
      <Box component="table" sx={{ borderCollapse: 'collapse', fontSize: 13, '& th, & td': { border: `1px solid ${tk.line}`, px: 1, py: 0.5, textAlign: 'left', whiteSpace: 'pre-wrap', verticalAlign: 'top' } }}>
        {head && (
          <Box component="thead" sx={{ position: 'sticky', top: 0, bgcolor: tk.popup.surface }}>
            <tr>
              {head.map((c, i) => (
                <th key={i}>{c}</th>
              ))}
            </tr>
          </Box>
        )}
        <tbody>
          {body.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </Box>
    </Scroll>
  );
}
