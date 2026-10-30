/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 마크다운 → React 요소(OMAI-1115). react-markdown + GFM(표·체크박스·취소선) + 한 줄 바꿈 유지 + 코드 강조.
// ```mermaid 는 다이어그램, ```echarts 는 차트로 그린다(따로 받는 묶음). HTML 은 해석하지 않는다 — 에이전트가 보낸 글이
// 그대로 실행되지 않게(rehype-raw 를 쓰지 않으면 react-markdown 은 HTML 을 글자로 둔다). 다만 블록 자리의 <table> 덩어리는
// 허용 목록 요소·속성만 골라 표로 그린다(htmlTablePlugin, 스펙 2026-10-27-005). 링크는 http(s)·mailto 만.
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import { Box, Button, Typography } from '@mui/material';
import { useSnackbar } from 'notistack';
import { type ComponentProps, lazy, type ReactNode, Suspense, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

import { t } from '@/i18n';
import { MONO_FONT } from '@/lib/monoFont';

import { remarkFilePaths } from './filePathPlugin';
import { remarkHtmlTables } from './htmlTablePlugin';
import { closePendingDiagram, hidePartialTable } from './preprocess';
const MermaidBlock = lazy(() => import('./MermaidBlock'));
const ChartBlock = lazy(() => import('./ChartBlock'));

const SAFE_HREF = /^(https?:|mailto:)/i;

function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object' && 'props' in node) return textOf((node.props as { children?: ReactNode }).children);
  return '';
}

function CodeBlock({ code, children }: { code: string; children: ReactNode }) {
  const { enqueueSnackbar } = useSnackbar();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      enqueueSnackbar(t('common.codeCopied'), { variant: 'success' });
    } catch {
      enqueueSnackbar(t('common.copyFailed'), { variant: 'error' });
    }
  };
  return (
    <Box component="pre" sx={{ position: 'relative', overflow: 'auto', p: 1.5, bgcolor: 'action.hover', borderRadius: 1 }}>
      <Button startIcon={<ContentCopyOutlinedIcon />} size="small" aria-label={t('common.copyCode')} onClick={copy} sx={{ position: 'absolute', top: 4, right: 4 }}>
        {t('common.copy')}
      </Button>
      {children}
    </Box>
  );
}

const pending = (label: string) => (
  <Typography variant="caption" color="text.secondary" component="div" sx={{ my: 1 }}>
    {label}
  </Typography>
);

type PreProps = ComponentProps<'pre'> & { node?: unknown };

function Pre({ children }: PreProps) {
  const child = (Array.isArray(children) ? children[0] : children) as { props?: { className?: string; children?: ReactNode } };
  const cls = child?.props?.className ?? '';
  const code = textOf(child?.props?.children).replace(/\n$/, '');
  if (/\blanguage-mermaid-pending\b/.test(cls)) return pending(t('common.diagramLoading'));
  if (/\blanguage-echarts-pending\b/.test(cls)) return pending(t('common.chartLoading'));
  if (/\blanguage-mermaid\b/.test(cls))
    return (
      <Suspense fallback={pending(t('common.diagramLoading'))}>
        <MermaidBlock code={code} />
      </Suspense>
    );
  if (/\blanguage-echarts\b/.test(cls))
    return (
      <Suspense fallback={pending(t('common.chartLoading'))}>
        <ChartBlock code={code} />
      </Suspense>
    );
  return <CodeBlock code={code}>{children}</CodeBlock>;
}

const components = {
  pre: Pre,
  a: ({ href, children }: ComponentProps<'a'> & { node?: unknown }) =>
    href && SAFE_HREF.test(href) ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  table: ({ children }: ComponentProps<'table'> & { node?: unknown }) => (
    <Box sx={{ overflowX: 'auto' }}>
      <table>{children}</table>
    </Box>
  ),
};

// rehype-highlight: 언어를 모르면 강조하지 않는다(detect 끔 — 짧은 글을 엉뚱한 언어로 칠하지 않게).
const rehypePlugins: ComponentProps<typeof ReactMarkdown>['rehypePlugins'] = [[rehypeHighlight, { detect: false }]];
// HTML 표는 맨 앞 — 표 밖으로 나온 글 문단의 줄바꿈을 remark-breaks 가 처리한다(스펙 2026-10-27-005 R5)
const remarkPlugins: ComponentProps<typeof ReactMarkdown>['remarkPlugins'] = [remarkHtmlTables, [remarkGfm, { singleTilde: false }], remarkBreaks];

const hljsLight = {
  '& .hljs-comment, & .hljs-quote': { color: '#6a737d', fontStyle: 'italic' },
  '& .hljs-keyword, & .hljs-selector-tag, & .hljs-built_in, & .hljs-type': { color: '#d73a49' },
  '& .hljs-string, & .hljs-attr, & .hljs-template-variable': { color: '#032f62' },
  '& .hljs-number, & .hljs-literal, & .hljs-variable': { color: '#005cc5' },
  '& .hljs-title, & .hljs-section, & .hljs-name': { color: '#6f42c1' },
  '& .hljs-meta, & .hljs-symbol': { color: '#e36209' },
};
const hljsDark = {
  '& .hljs-comment, & .hljs-quote': { color: '#8b949e', fontStyle: 'italic' },
  '& .hljs-keyword, & .hljs-selector-tag, & .hljs-built_in, & .hljs-type': { color: '#ff7b72' },
  '& .hljs-string, & .hljs-attr, & .hljs-template-variable': { color: '#a5d6ff' },
  '& .hljs-number, & .hljs-literal, & .hljs-variable': { color: '#79c0ff' },
  '& .hljs-title, & .hljs-section, & .hljs-name': { color: '#d2a8ff' },
  '& .hljs-meta, & .hljs-symbol': { color: '#ffa657' },
};

/** 글 안 파일 경로를 뱃지로 그린다(스펙 2026-10-20-002 §3-4). known 은 상대 경로를 맞춰 볼 서랍 목록(R14) */
export interface MarkdownFiles {
  render: (path: string) => ReactNode;
  known?: ReadonlySet<string>;
}

// 바깥·상대 그림은 그리지 않는다(에어갭, 외부 검토 F8) — 대체 글과 주소만 보인다. 파일 뷰어의 md 보기에서 쓴다
const textImage = ({ src, alt }: ComponentProps<'img'> & { node?: unknown }) => (
  <Typography component="span" variant="body2" color="text.secondary">
    [{alt || ''}] {t('chat.viewer.remoteImage', { src: String(src || '') })}
  </Typography>
);

/** dense: 서랍 안 본문(칸반 카드). 머리 글을 서랍의 다른 머리(subtitle2, 13px 700)와 같은 크기로 줄인다(스펙 2026-10-18-002 D20)
 *  files: 글 안 경로를 파일 뱃지로(채팅 답·오피스 대화창). noRemoteImages: 그림을 글로만(파일 뷰어) */
export function Markdown({ text, dense = false, files, noRemoteImages = false }: { text: string; dense?: boolean; files?: MarkdownFiles; noRemoteImages?: boolean }) {
  const source = useMemo(() => closePendingDiagram(hidePartialTable(String(text || '').replace(/\r/g, ''))), [text]);
  const plugins = useMemo(() => (files ? [...(remarkPlugins ?? []), remarkFilePaths(files.known)] : remarkPlugins), [files?.known]); // eslint-disable-line react-hooks/exhaustive-deps
  const comps = useMemo(
    () => ({
      ...components,
      ...(noRemoteImages ? { img: textImage } : {}),
      ...(files ? { aasfile: ({ path }: { path?: string }) => (path ? files.render(path) : null) } : {}),
    }),
    [files, noRemoteImages]
  );
  return (
    <Box
      className="md"
      sx={(theme) => ({
        '& p': { my: 1 },
        '& pre': { fontFamily: MONO_FONT, fontSize: 13 },
        '& table': { borderCollapse: 'collapse' },
        '& th, & td': { border: 1, borderColor: 'divider', px: 1, py: 0.5 },
        '& blockquote': { m: 0, pl: 2, borderLeft: 3, borderColor: 'divider', color: 'text.secondary' },
        '& input[type=checkbox]': { mr: 0.5 },
        ...(dense ? { '& h1, & h2, & h3, & h4': { fontSize: 13, fontWeight: 700, lineHeight: 1.5, mt: 1.5, mb: 0.5 } } : {}),
        ...(theme.palette.mode === 'dark' ? hljsDark : hljsLight),
      })}
    >
      <ReactMarkdown remarkPlugins={plugins} rehypePlugins={rehypePlugins} components={comps as ComponentProps<typeof ReactMarkdown>['components']}>
        {source}
      </ReactMarkdown>
    </Box>
  );
}
