/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 글 편집 칸(CodeEditor)의 약속과 언어 고르기. Monaco 를 불러오지 않는다(시험·첫 화면이 가볍게).
import type { Ref } from 'react';

/** 부르는 쪽에 넘기는 키 입력. preventDefault 를 부르면 편집기가 그 키를 처리하지 않는다. */
export interface EditorKey {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
  composing: boolean;
  preventDefault: () => void;
}

/** 선택 범위(글 전체에서의 글자 위치). */
export interface EditorHandle {
  selection: () => [number, number];
  select: (start: number, end: number) => void;
  focus: () => void;
}

export interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language: string;
  ariaLabel: string;
  minRows: number;
  /** false 면 Tab 이 들여쓰기 대신 다음 칸으로 넘어간다(Esc 를 누른 뒤). */
  tabIndents: boolean;
  /** true 면 보기만 한다(고칠 수 없다). 색칠·줄 번호·찾기·복사는 편집 때와 같다. */
  readOnly?: boolean;
  /** true 면 줄 수로 높이를 정하지 않고 부모 높이를 채운다(100%, 안쪽 스크롤). 부모가 높이를 가진 flex 칸이어야 한다(파일 뷰어, 2026-10-20-002). */
  fill?: boolean;
  /** 줄 바꿈. 주지 않으면 Markdown 만 켠다. */
  wordWrap?: 'on' | 'off';
  /** 표시할 줄(1부터). 보기 전용 코드에서 근거 줄을 칠하고, 마우스를 올리면 note 를 보인다. */
  marks?: { line: number; note: string }[];
  /** 이 줄로 옮겨 가운데에 두고 칠한다. key 가 바뀌면 같은 줄이라도 다시 옮긴다. */
  focusLine?: { line: number; key: number };
  onKey?: (e: EditorKey) => void;
  onFocus?: () => void;
  handle?: Ref<EditorHandle>;
}

/** 파일 이름으로 색칠할 언어를 고른다. 모르는 것은 글자만(plaintext).
 *  서버가 보여 주는 글 파일(aas/assets/files.py TEXT_EXT)과 파일 뷰어의 원문 보기(2026-10-20-002 D7)를 다룬다.
 *  고를 수 있는 언어는 lib/monacoSetup.ts 에 색칠이 있어야 한다(2026-10-17-024). */
export function languageOf(filename: string | undefined, markdown: boolean): string {
  if (markdown) return 'markdown';
  // 템플릿 꼬리(page.html.j2, config.yaml.tmpl)는 앞의 확장자로 본다
  const name = (filename || '').toLowerCase().replace(/\.(j2|tmpl)$/, '');
  if (/\.(ya?ml)$/.test(name)) return 'yaml';
  if (/(^|\.)env$|\.(ini|toml|conf|cfg)$/.test(name)) return 'ini';
  if (/\.py$/.test(name)) return 'python';
  if (/\.(sh|bash|zsh)$/.test(name)) return 'shell';
  if (/\.(md|markdown)$/.test(name)) return 'markdown';
  if (/\.html?$/.test(name)) return 'html';
  if (/\.css$/.test(name)) return 'css';
  if (/\.(m?js|cjs|jsx)$/.test(name)) return 'javascript';
  if (/\.(ts|tsx|mts|cts)$/.test(name)) return 'typescript';
  if (/\.json$/.test(name)) return 'json';
  if (/\.sql$/.test(name)) return 'sql';
  // 아래는 파일 뷰어 원문 보기에서 늘린 언어(D7). Dockerfile 은 확장자 없이 이름으로 본다
  if (/(^|\/)dockerfile$|\.dockerfile$/.test(name)) return 'dockerfile';
  const ext = /\.([a-z0-9]+)$/.exec(name)?.[1];
  return (ext && EXT_LANG[ext]) || 'plaintext';
}

const EXT_LANG: Record<string, string> = {
  xml: 'xml', svg: 'xml', xsd: 'xml', xsl: 'xml', plist: 'xml',
  java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', sc: 'scala',
  go: 'go', rs: 'rust',
  c: 'cpp', h: 'cpp', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', cs: 'csharp',
  php: 'php', rb: 'ruby', pl: 'perl', pm: 'perl', lua: 'lua', r: 'r', swift: 'swift',
  ps1: 'powershell', psm1: 'powershell', bat: 'bat', cmd: 'bat',
  scss: 'scss', less: 'less',
  graphql: 'graphql', gql: 'graphql', proto: 'protobuf', tf: 'hcl', tfvars: 'hcl', hcl: 'hcl',
};
