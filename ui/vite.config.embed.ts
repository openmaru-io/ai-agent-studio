/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 다른 웹 페이지에 붙이는 채팅 위젯(OMAI-1873)의 빌드. 화면 빌드(vite.config.ts)와 따로 둔다.
// CogentAI 위젯처럼 UMD 파일 하나로 묶는다: 호스트 레포에 복사해 호스트와 같은 출처에서 내보내므로(script-src 'self') 조각 파일을 둘 수 없다.
// 이미지·글꼴은 모두 파일 안에 싣는다(에어갭 — 외부 주소를 쓰지 않는다). 산출물은 AAS 서버가 /static/js/aas-widget.js 로 내보낸다.
// 화면 빌드(npm run build)는 aas/static 을 비우므로 위젯은 그 뒤에 굽는다(build:widget).
import { readFileSync } from 'node:fs';

import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/** 위젯은 파일 하나라 늦게 불러오는 모듈도 모두 같은 파일에 들어간다(inlineDynamicImports). 그래서 위젯에서 열지 않는 것을 뺀다.
 *  - 다른 화면(@/screens/…)을 늦게 불러오는 곳: 서랍 등록부(components/drawerPages.ts)가 스킬·플로·사람 화면과 그 안의 글 편집기(monaco)를
 *    불러온다. 위젯에는 서랍이 없어 이 길로 가지 않는다 — 넣으면 파일이 약 6MB 커진다
 *  - 받아쓰기의 오디오 작업 파일(?url&no-inline)은 따로 파일로 나간다. 위젯은 받아쓰기를 끄므로 파일 안에 싣는다 */
function widgetOnly(): Plugin {
  return {
    name: 'aas-widget-only',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('/src/') || id.includes('/node_modules/')) return null;
      const out = code
        .replace(/import\((['"])@\/screens\/[^'"]+\1\)/g, "Promise.reject(new Error('not in the widget'))")
        .replace(/(['"][^'"]+)\?url&no-inline(['"])/g, '$1?url$2');
      return out === code ? null : { code: out, map: null };
    },
  };
}

/** esbuild 의 charset: 'ascii' 는 정규식 리터럴 안의 문자는 그대로 둔다. 남은 비ASCII 문자를 UTF-16 단위로 \\uXXXX 로 바꾼다 —
 *  문자열·정규식·식별자 어디서나 같은 뜻이다. 역슬래시 바로 뒤의 비ASCII 문자만은 뜻이 바뀌므로 그런 것이 있으면 빌드를 멈춘다 */
function asciiOnly(): Plugin {
  return {
    name: 'aas-widget-ascii',
    enforce: 'post',
    generateBundle(_opts, bundle) {
      for (const f of Object.values(bundle)) {
        if (f.type !== 'chunk') continue;
        if (/\\[^\x00-\x7f]/.test(f.code)) this.error(`${f.fileName}: a non-ASCII character follows a backslash; cannot escape safely`);
        f.code = f.code.replace(/[^\x00-\x7f]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
      }
    },
  };
}

/** window.__COGENTAI_AAS__ 를 읽어 init() 을 부르는 주입 스크립트(src/embed/aas-widget-init.js)를 위젯 옆에 그대로 내보낸다.
 *  묶지 않는 보통 스크립트다. emptyOutDir 가 aas/static/js 를 비운 뒤에 쓰므로 위젯과 늘 함께 나간다. 비ASCII 는 주석에만 있어야 한다 */
function initScript(): Plugin {
  return {
    name: 'aas-widget-init',
    generateBundle() {
      const source = readFileSync(new URL('./src/embed/aas-widget-init.js', import.meta.url), 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
      if (/[^\x00-\x7f]/.test(code)) this.error('aas-widget-init.js: non-ASCII characters outside comments');
      this.emitFile({ type: 'asset', fileName: 'aas-widget-init.js', source });
    },
  };
}

export default defineConfig({
  plugins: [widgetOnly(), react(), asciiOnly(), initScript()],
  resolve: { alias: { '@': '/src' } },
  assetsInclude: ['**/*.glb'],
  define: {
    // 라이브러리 빌드는 process.env 를 바꾸지 않는다 — React·MUI 가 개발용 판으로 묶이지 않게 넣는다
    'process.env.NODE_ENV': JSON.stringify('production'),
    // 호스트 페이지의 저장소·쿠키·<html lang> 을 건드리지 않는 판(i18n/index.ts)
    'import.meta.env.VITE_AAS_EMBED': JSON.stringify('1'),
  },
  // 호스트 페이지·서버가 문자 집합(UTF-8)을 알리지 않으면 브라우저가 파일을 다른 인코딩으로 읽어 한글 문자열·정규식이 깨지고
  // 파일 전체가 구문 오류가 난다(2026-11-09 Chrome 확인). 비ASCII 문자는 모두 \u 이스케이프로 내보낸다
  esbuild: { charset: 'ascii' },
  publicDir: false,
  worker: { format: 'es' },
  build: {
    outDir: '../aas/static/js',
    emptyOutDir: true, // aas/static/js 는 위젯 파일만 둔다 — 지난 빌드의 남은 파일이 함께 나가지 않게 비운다
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
    sourcemap: false,
    lib: {
      entry: 'src/embed/index.tsx',
      name: 'CogentAIAASWidget',
      formats: ['umd'],
      fileName: () => 'aas-widget.js',
    },
    rollupOptions: {
      output: { inlineDynamicImports: true, exports: 'named' },
    },
  },
});
