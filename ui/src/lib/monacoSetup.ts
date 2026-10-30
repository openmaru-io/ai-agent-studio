/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 글 편집기(Monaco)를 폐쇄망에서 쓰도록 준비한다. COP Console(frontend/src/index.tsx)과 같은 방식이다.
//
// @monaco-editor/react 의 loader 는 monaco 를 넘겨받지 못하면 기본값으로 cdn.jsdelivr.net 에서 받는다.
// 폐쇄망에서는 그 요청이 끝나지 않아 편집기가 「Loading...」에서 멈춘다. 앱 진입점에서 번들한 monaco 를
// loader 에 넣어, 어떤 편집기보다 먼저 준비되게 한다. 언어 색칠은 쓰는 것만 넣는다(전체를 넣으면 묶음이 커진다).
// 고를 수 있는 언어(components/codeLanguage.ts languageOf)와 같아야 한다. 시험(codeLanguage.test.ts)이 맞는지 본다(2026-10-17-024).
// 파일 뷰어 원문 보기로 xml·java·go 등 22개를 더했다(2026-10-20-002 D7). 색칠(Monarch)만이라 지연 묶음 vendor-monaco 에만 들어간다
// 아이콘 글꼴(codicon)의 @font-face·.codicon 규칙. editor.api 는 이것을 불러오지 않는다 — 빠지면 찾기 창 단추가
// 빈 글자(막대)로 보인다. 글꼴 파일(codicon.ttf)은 빌드가 묶음에 넣는다(2026-10-28-007 §6)
import 'monaco-editor/esm/vs/base/browser/ui/codicons/codiconStyles';
import 'monaco-editor/esm/vs/basic-languages/bat/bat.contribution';
import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution';
import 'monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution';
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution';
import 'monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution';
import 'monaco-editor/esm/vs/basic-languages/go/go.contribution';
import 'monaco-editor/esm/vs/basic-languages/graphql/graphql.contribution';
import 'monaco-editor/esm/vs/basic-languages/hcl/hcl.contribution';
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution';
import 'monaco-editor/esm/vs/basic-languages/ini/ini.contribution';
import 'monaco-editor/esm/vs/basic-languages/java/java.contribution';
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution';
import 'monaco-editor/esm/vs/basic-languages/kotlin/kotlin.contribution';
import 'monaco-editor/esm/vs/basic-languages/less/less.contribution';
import 'monaco-editor/esm/vs/basic-languages/lua/lua.contribution';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution';
import 'monaco-editor/esm/vs/basic-languages/perl/perl.contribution';
import 'monaco-editor/esm/vs/basic-languages/php/php.contribution';
import 'monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution';
import 'monaco-editor/esm/vs/basic-languages/protobuf/protobuf.contribution';
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution';
import 'monaco-editor/esm/vs/basic-languages/r/r.contribution';
import 'monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution';
import 'monaco-editor/esm/vs/basic-languages/rust/rust.contribution';
import 'monaco-editor/esm/vs/basic-languages/scala/scala.contribution';
import 'monaco-editor/esm/vs/basic-languages/scss/scss.contribution';
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution';
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution';
import 'monaco-editor/esm/vs/basic-languages/swift/swift.contribution';
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution';
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution';
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution';
// 편집 기능(contrib). editor.api 는 편집기 핵심만 담아 찾기 창이 없다 — 쓰는 것만 하나씩 더한다(2026-10-28-007)
// 찾기·찾아 바꾸기: Cmd/Ctrl+F, Cmd+Option+F·Ctrl+H, F3·Shift+F3, Cmd+E
import 'monaco-editor/esm/vs/editor/contrib/find/browser/findController';
// 같은 글 고르기: Cmd/Ctrl+D(다음), Cmd/Ctrl+Shift+L(모두)
import 'monaco-editor/esm/vs/editor/contrib/multicursor/browser/multicursor';

import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';

loader.config({ monaco });

// JSON 은 basic-languages 에 없다(언어 서비스는 작업자가 따로 필요하다). 색칠만 하는 작은 규칙을 넣는다
monaco.languages.register({ id: 'json', extensions: ['.json'] });
monaco.languages.setMonarchTokensProvider('json', {
  tokenizer: {
    root: [
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'type'],
      [/"(?:[^"\\]|\\.)*"/, 'string'],
      [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
      [/\b(?:true|false|null)\b/, 'keyword'],
      [/[{}[\],:]/, 'delimiter'],
    ],
  },
});

// 편집기 작업자(web worker)도 번들한 파일을 쓴다. 언어 서비스(json·ts 등)는 넣지 않아 기본 작업자 하나면 된다.
self.MonacoEnvironment = {
  getWorker() {
    return new Worker(new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url), { type: 'module' });
  },
};

export { monaco };
