/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

import { formatKst } from './src/lib/kstDate';

// 좌측 메뉴 아래 버전 단추가 보이는 빌드 정보(src/lib/buildInfo.ts). 이미지 빌드는 Dockerfile 이 빌드 인자로 넣는다.
// 값이 없으면 여기서 git 으로 채운다(로컬 빌드·개발 서버). 이미지 안에는 .git 이 없어 git 이 실패하고 빈 값(N/A)이 된다.
const git = (args: string) => {
  try {
    return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
};
process.env.VITE_AAS_GIT_COMMIT ||= git('rev-parse HEAD');
process.env.VITE_AAS_GIT_COMMIT_DATE ||= git('log -1 --format=%cd --date=iso');
// 커밋 날짜와 같은 모양(git --date=iso: 「2026-10-17 19:05:51 +0900」)
process.env.VITE_AAS_BUILD_DATE ||= formatKst(new Date());

// 개발 서버는 AAS 서버(17900)로 API 를 넘긴다. 빌드 산출물은 서버가 서빙하는 aas/static 으로 간다.
const API = process.env.AAS_API || 'http://127.0.0.1:17900';

// 개발 서버에서도 pdf.js 부가 파일(cmaps·standard_fonts·wasm)을 빌드와 같은 주소(/assets/pdfjs-<버전>/)로 낸다.
// 빌드는 scripts/copy-pdfjs-assets.mjs 가 복사한다(스펙 2026-10-20-005 §5-2).
const require = createRequire(import.meta.url);
const PDFJS_DIR = dirname(require.resolve('pdfjs-dist/package.json'));
const PDFJS_PREFIX = `/assets/pdfjs-${require('pdfjs-dist/package.json').version}/`;
function pdfjsAssets(): Plugin {
  return {
    name: 'aas-pdfjs-assets',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0];
        if (!url.startsWith(PDFJS_PREFIX)) return next();
        const rel = normalize(decodeURIComponent(url.slice(PDFJS_PREFIX.length)));
        const file = join(PDFJS_DIR, rel);
        if (rel.startsWith('..') || !/^(cmaps|standard_fonts|wasm)\//.test(rel) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('Content-Type', extname(file) === '.wasm' ? 'application/wasm' : 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), pdfjsAssets()],
  base: '/',
  assetsInclude: ['**/*.glb'],
  resolve: { alias: { '@': '/src' } },
  // 문서 작업 스레드(hwp.worker·xlsx.worker, 스펙 2026-10-20-005 리뷰 D4). manualChunks 는 Worker 묶음에 적용되지 않아 이름을 따로 정한다
  // — 에어갭 검사가 이 이름(hwp.worker-*·xlsx.worker-*)으로 허용 주소를 정한다(OV4). Worker 안 동적 import 를 위해 es 형식
  worker: { format: 'es', rollupOptions: { output: { entryFileNames: 'assets/[name]-[hash].js', chunkFileNames: 'assets/[name]-[hash].js' } } },
  build: {
    outDir: '../aas/static',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // 지연 로딩 도우미는 첫 화면 묶음에 둔다. 두지 않으면 monaco 묶음에 들어가 첫 화면이 monaco 를 받는다
          if (id.includes('vite/preload-helper')) return 'vendor-react';
          if (!id.includes('/node_modules/')) return undefined;
          // pptx-preview 는 echarts 5 를 자기 node_modules 에 따로 둔다(…/pptx-preview/node_modules/echarts/). 이 경로에도 /node_modules/echarts/ 가
          // 들어 있어 아래 vendor-echarts 규칙보다 먼저 가려야 앱의 echarts 6 과 섞이지 않는다(스펙 2026-10-20-005 §9)
          if (id.includes('/node_modules/pptx-preview/')) return 'vendor-pptx';
          const pkg = (names: string[]) => names.some((n) => id.includes(`/node_modules/${n}/`));
          if (pkg(['react', 'react-dom', 'react-router-dom', 'react-router', 'scheduler'])) return 'vendor-react';
          // dayjs 는 공지 관리 화면의 날짜 고르개(@mui/x-date-pickers)와 mermaid 가 함께 쓴다. 따로 묶지 않으면 mermaid 묶음에 들어가
          // 공지 화면이 mermaid 묶음 전체를 받고 vendor-grid ↔ vendor-mermaid 가 서로 부른다(스펙 2026-10-24-007 E10)
          if (pkg(['dayjs'])) return 'vendor-dayjs';
          // 목록 화면의 공통 표(material-react-table)와 그 의존성. 목록 화면을 열 때만 받는다(화면이 React.lazy, OMAI-1127).
          // @mui/ 규칙보다 앞에 둬야 날짜 선택 패키지가 vendor-mui 로 가지 않는다. react-query 는 넣지 않는다
          if (
            pkg(['material-react-table', '@tanstack/react-table', '@tanstack/table-core', '@tanstack/react-virtual',
              '@tanstack/virtual-core', '@tanstack/match-sorter-utils', 'highlight-words', 'remove-accents',
              '@mui/x-date-pickers', '@mui/x-internals'])
          )
            return 'vendor-grid';
          if (id.includes('/node_modules/@mui/') || id.includes('/node_modules/@emotion/')) return 'vendor-mui';
          if (pkg(['@tanstack/react-query', '@tanstack/query-core'])) return 'vendor-query';
          // 오피스 화면을 열 때만 받는 3D 묶음(화면이 React.lazy 로 불러온다)
          if (pkg(['three', '@react-three/fiber', '@react-three/drei', 'troika-three-text'])) return 'vendor-three';
          // 글을 고칠 때만 받는 편집기 묶음(LazyCodeEditor). 에어갭 검사가 이 묶음 이름으로 허용 주소를 정한다
          if (pkg(['monaco-editor', '@monaco-editor/react', '@monaco-editor/loader'])) return 'vendor-monaco';
          // 다이어그램·차트는 그 코드 블록이 있을 때만 받는다(components/markdown 이 React.lazy 로 불러온다, OMAI-1115).
          // 에어갭 검사가 이 묶음 이름으로 허용 주소를 정한다
          if (pkg(['mermaid', '@mermaid-js/parser'])) return 'vendor-mermaid';
          if (pkg(['echarts', 'zrender'])) return 'vendor-echarts';
          // 문서 뷰어(스펙 2026-10-20-005): 그 형식을 열 때만 받는다(DocBody 가 lazy 로 부른다). 에어갭 검사가 이 묶음 이름으로 허용 주소를 정한다.
          // react-pdf 의 작은 의존성(clsx 등)은 MUI 도 써서 여기 넣지 않는다 — 넣으면 첫 화면이 PDF 묶음을 받는다
          if (pkg(['react-pdf', 'pdfjs-dist'])) return 'vendor-pdf';
          if (pkg(['docx-preview'])) return 'vendor-docx';
          if (pkg(['jszip', 'pako', 'lie', 'immediate', 'setimmediate'])) return 'vendor-zip';
          // 오피스 얼굴(DiceBear, 스펙 2026-10-21-016). 스타일 출처·라이선스 주소 문자열이 있어 에어갭 검사가 이 묶음 이름으로 허용한다
          if (id.includes('/node_modules/@dicebear/')) return 'vendor-avatar';
          // Markdown 렌더러(react-markdown·unified 생태계·코드 강조). 오류 안내문에 저장소 주소가 있어 이름 있는 묶음으로 둔다
          if (
            pkg(['highlight.js', 'lowlight', 'react-markdown', 'unified', 'bail', 'trough', 'devlop', 'zwitch', 'ccount', 'vfile',
              'vfile-message', 'property-information', 'space-separated-tokens', 'comma-separated-tokens', 'html-url-attributes',
              'decode-named-character-reference', 'character-entities', 'trim-lines', 'longest-streak', 'markdown-table',
              'is-plain-obj', 'estree-util-is-identifier-name', 'style-to-js', 'style-to-object', 'inline-style-parser']) ||
            /\/node_modules\/(remark-|rehype-|micromark|mdast-|hast-|unist-)/.test(id)
          )
            return 'vendor-markdown';
          return undefined;
        },
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 3000,
    proxy: {
      '/api': { target: API, changeOrigin: false },
      '/auth': { target: API, changeOrigin: false },
      '/healthz': { target: API, changeOrigin: false },
      '/ws': { target: API.replace(/^http/, 'ws'), ws: true, changeOrigin: false },
    },
  },
});
