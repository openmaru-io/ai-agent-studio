// Copyright 2026 OPENMARU, Inc.
// SPDX-License-Identifier: Apache-2.0
// 빌드 산출물에 외부 주소가 들어 있으면 실패한다. 폐쇄망에서는 런타임에 받아 올 곳이 없다.
// 허용 목록은 실행 중에 접속하지 않는 것만이다: XML 네임스페이스, 오류 메시지 안내문.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

// www.openmaru.io: 버전 정보 창 저작권 줄의 회사 주소 링크. 사람이 누를 때만 새 창으로 열고, 화면은 받아 오지 않는다(2026-10-30)
export const ALLOWED_HOSTS = ['www.w3.org', 'react.dev', 'mui.com', 'www.openmaru.io'];
// 3D 라이브러리(three·R3F·drei·troika)에 든 주석·오류 안내문·기본값 문자열의 호스트. 이 묶음 파일에서만 허용한다.
//  - github.com·docs.pmnd.rs·jcgt.org: 주석과 오류 안내문
//  - cdn.jsdelivr.net: troika 글자 라이브러리의 기본 글꼴 저장소. Text.tsx 가 configureTextBuilder 로 덮어써 접속하지 않는다
//  - www.gstatic.com: drei useGLTF 의 기본 Draco 디코더. 가구 모델은 압축하지 않았고 useGLTF(path, false) 로 부른다
// 정적 검사는 문자열이 코드에서 실제로 쓰이는지 구분하지 못하므로, 접속하지 않는다는 것은 네트워크를 막은 브라우저 시험
// (parity/offline.mjs)으로 따로 확인한다.
export const THREE_BUNDLE = /(^|[\\/])vendor-three-[^\\/]*\.js$/;
export const THREE_HOSTS = ['github.com', 'docs.pmnd.rs', 'jcgt.org', 'cdn.jsdelivr.net', 'www.gstatic.com'];
// 글 편집기(Monaco) 묶음의 문자열 호스트. 이 묶음에서만 허용한다.
//  - github.com·code.visualstudio.com·microsoft.com: 라이선스 주석, 도움말 문구 속 링크, 작업자를 못 띄울 때의 경고문
//  - cdn.jsdelivr.net: @monaco-editor/loader 의 기본 monaco 주소. lib/monacoSetup.ts 가 번들한 monaco 를 loader 에 넣어 받지 않는다
//    (src/lib/monacoSetup.test.ts 가 이 설정을 지킨다)
export const MONACO_BUNDLE = /(^|[\\/])vendor-monaco-[^\\/]*\.js$/;
export const MONACO_HOSTS = ['github.com', 'code.visualstudio.com', 'microsoft.com', 'cdn.jsdelivr.net'];
// Markdown·다이어그램·차트 묶음(OMAI-1115). 모두 라이선스 주석과 오류·경고 안내문 속 문서 주소다(실행 중에 접속하지 않는다).
//  - vendor-markdown: react-markdown·hast-util-to-jsx-runtime 의 변경 기록·오류 안내, highlight.js 의 보안 경고 문구(github.com)
//  - vendor-mermaid: mermaid 가 묶어 넣은 chevrotain·langium·lodash·dompurify 등의 라이선스 주석과 오류 안내
//  - vendor-echarts: 오류 안내문 속 저장소 주소
export const MARKDOWN_BUNDLE = /(^|[\\/])vendor-markdown-[^\\/]*\.js$/;
export const MARKDOWN_HOSTS = ['github.com'];
export const MERMAID_BUNDLE = /(^|[\\/])vendor-mermaid-[^\\/]*\.js$/;
export const MERMAID_HOSTS = ['github.com', 'chevrotain.io', 'langium.org', 'lodash.com', 'underscorejs.org', 'jquery.org',
  'openjsf.org', 'opensource.org', 'tldrlegal.com', 'en.wikipedia.org', 'engelschall.com'];
export const ECHARTS_BUNDLE = /(^|[\\/])vendor-echarts-[^\\/]*\.js$/;
export const ECHARTS_HOSTS = ['github.com'];
// 공통 표 묶음(OMAI-1127): @tanstack/match-sorter-utils 의 @license 주석 속 저자 주소(실행 중에 접속하지 않는다)
//  - github.com: @mui/x-date-pickers 의 오류 안내문 속 이슈 주소(공지 관리 화면의 날짜 고르개, 스펙 2026-10-24-007). 접속하지 않는다
export const GRID_BUNDLE = /(^|[\\/])vendor-grid-[^\\/]*\.js$/;
export const GRID_HOSTS = ['kentcdodds.com', 'github.com'];
// MUI 묶음: prop-types 의 운영용 대역(shim)이 던지는 오류 문장 속 안내 주소(fb.me). 공지 관리 화면의 날짜 고르개(@mui/x-date-pickers)가
// 모듈 수준에서 PropTypes 를 불러 대역이 남는다(스펙 2026-10-24-007). 문장일 뿐 접속하지 않는다. prop-types 를 vendor-grid 로 옮기면
// @mui/material 도 그것을 불러 첫 화면이 vendor-grid 를 받게 되어 옮기지 않았다
export const MUI_BUNDLE = /(^|[\\/])vendor-mui-[^\\/]*\.js$/;
export const MUI_HOSTS = ['fb.me'];
// 문서 뷰어 묶음(스펙 2026-10-20-005 §5-3). 모두 실행 중에 접속하지 않는 문자열이다.
//  - vendor-pdf·pdf.worker: 라이선스 주석(github.com·www.apache.org), 오류 안내(www.mozilla.org), XFA·XMP 네임스페이스(www.xfa.org·ns.adobe.com),
//    주소를 풀 때 쓰는 가짜 기준 주소(new URL(x, "https://foo.bar")·"http://example.com"). 작업 스레드는 .mjs 라 이름 규칙에 따로 넣는다(리뷰 R7)
//  - vendor-docx: OOXML 네임스페이스(schemas.openxmlformats.org·schemas.microsoft.com), 상대 경로를 풀 때 쓰는 가짜 기준 주소
//    (new URL(a, "http://docx/")), 라이선스 주석(github.com)
export const PDF_BUNDLE = /(^|[\\/])(vendor-pdf-[^\\/]*\.js|pdf\.worker\.min-[^\\/]*\.mjs)$/;
export const PDF_HOSTS = ['github.com', 'www.apache.org', 'www.mozilla.org', 'www.xfa.org', 'ns.adobe.com', 'foo.bar', 'example.com'];
export const DOCX_BUNDLE = /(^|[\\/])vendor-docx-[^\\/]*\.js$/;
export const DOCX_HOSTS = ['github.com', 'schemas.openxmlformats.org', 'schemas.microsoft.com', 'docx'];
//  - vendor-zip(jszip): 라이선스 주석 속 저자·저장소 주소
export const ZIP_BUNDLE = /(^|[\\/])vendor-zip-[^\\/]*\.js$/;
export const ZIP_HOSTS = ['stuartk.com', 'raw.github.com', 'github.com', 'stuk.github.io'];
//  - vendor-pptx(pptx-preview·echarts 5·lodash): OOXML 네임스페이스, lodash 라이선스 주석(lodash.com·openjsf.org·underscorejs.org),
//    core-js 오류 안내문(npms.io), 저장소 주소(github.com)
export const PPTX_BUNDLE = /(^|[\\/])vendor-pptx-[^\\/]*\.js$/;
export const PPTX_HOSTS = ['schemas.openxmlformats.org', 'schemas.microsoft.com', 'lodash.com', 'openjsf.org', 'underscorejs.org', 'npms.io', 'github.com'];
//  - xlsx.worker(exceljs 와 그 안의 jszip·buffer): OOXML·Dublin Core 네임스페이스(purl.org), 라이선스 주석(feross.org·stuartk.com·
//    raw.github.com·stuk.github.io·github.com). Worker 묶음은 manualChunks 밖이라 이름 규칙이 다르다(OV4)
export const XLSX_WORKER = /(^|[\\/])xlsx\.worker-[^\\/]*\.js$/;
export const XLSX_HOSTS = ['schemas.openxmlformats.org', 'schemas.microsoft.com', 'purl.org', 'feross.org', 'stuartk.com', 'raw.github.com', 'stuk.github.io', 'github.com'];
//  - vendor-avatar(DiceBear core·pixel-art, 스펙 2026-10-21-016): 스타일 출처(www.figma.com·www.dicebear.com), 라이선스(creativecommons.org·
//    github.com), SVG 메타데이터 네임스페이스(purl.org), 스키마 주소(json-schema.org·nsteffel.github.io). 얼굴은 문자열로 만들어 접속하지 않는다
export const AVATAR_BUNDLE = /(^|[\\/])vendor-avatar-[^\\/]*\.js$/;
export const AVATAR_HOSTS = ['www.figma.com', 'www.dicebear.com', 'creativecommons.org', 'github.com', 'purl.org', 'json-schema.org', 'nsteffel.github.io'];
const BUNDLE_HOSTS = [
  [THREE_BUNDLE, THREE_HOSTS],
  [MONACO_BUNDLE, MONACO_HOSTS],
  [MARKDOWN_BUNDLE, MARKDOWN_HOSTS],
  [MERMAID_BUNDLE, MERMAID_HOSTS],
  [ECHARTS_BUNDLE, ECHARTS_HOSTS],
  [GRID_BUNDLE, GRID_HOSTS],
  [MUI_BUNDLE, MUI_HOSTS],
  [PDF_BUNDLE, PDF_HOSTS],
  [DOCX_BUNDLE, DOCX_HOSTS],
  [ZIP_BUNDLE, ZIP_HOSTS],
  [PPTX_BUNDLE, PPTX_HOSTS],
  [XLSX_WORKER, XLSX_HOSTS],
  [AVATAR_BUNDLE, AVATAR_HOSTS],
];
// .mjs: pdf.js 작업 스레드(005). 빠지면 작업 스레드 속 주소를 보지 못한다
const TEXT = new Set(['.js', '.mjs', '.css', '.html', '.svg', '.json']);
const URL_RE = /(?:https?:)?\/\/[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}[^\s"'`)<>\\]*/g;
const PROTO_URL = /https?:\/\/([A-Za-z0-9.-]+)/g;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (TEXT.has(extname(p))) yield p;
  }
}

export function scan(dir, allowed = ALLOWED_HOSTS) {
  const found = [];
  for (const file of walk(dir)) {
    const text = readFileSync(file, 'utf8');
    const extra = BUNDLE_HOSTS.find(([re]) => re.test(file));
    const ok = extra ? [...allowed, ...extra[1]] : allowed;
    for (const m of text.matchAll(PROTO_URL)) {
      if (!ok.includes(m[1])) found.push(`${file}: ${m[0]}`);
    }
    // 프로토콜 없는 //host/경로 (CSS @import, <script src="//cdn…">)
    for (const m of text.matchAll(/(?:src|href)=["']\/\/([^"'\/]+)|@import\s+url\(["']?\/\/([^"')\/]+)/g)) {
      found.push(`${file}: //${m[1] || m[2]}`);
    }
  }
  return found;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('사용법: node scripts/check-airgap.mjs <빌드 폴더>');
    process.exit(2);
  }
  const bad = scan(dir);
  if (bad.length) {
    console.error('에어갭 검사 실패 — 빌드 산출물에 외부 주소가 있습니다:\n' + bad.map((b) => '  ' + b).join('\n'));
    process.exit(1);
  }
  console.log(`에어갭 검사 통과: ${dir}`);
}
