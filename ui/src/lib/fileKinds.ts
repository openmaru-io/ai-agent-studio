/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 파일 뱃지·뷰어가 함께 쓰는 판정(스펙 2026-10-20-002 §3-1·§3-5). 경로로 출처를, 이름으로 그리는 법·아이콘·형식을 정한다.
// 서버 attach_notice 의 「올렸습니다 / 골랐습니다」 기준(외부 검토 F10)과 fileSource 가 같은 규칙이어야 한다.

export type FileSource = 'upload' | 'agent' | 'meeting-in' | 'meeting-out' | 'kanban';
export type ViewerKind = 'markdown' | 'image' | 'svg' | 'text' | 'html' | 'csv' | 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'hwp' | 'audio' | 'video' | 'other';
export type IconKind = 'image' | 'pdf' | 'table' | 'doc' | 'code' | 'archive' | 'media' | 'file';

const SHARED_IN = 'workspace/uploads/aas-shared/';
const SHARED_OUT = 'workspace/uploads/aas-shared-out/';

/** 개인 작업 폴더 경로의 출처. 회의 화면·칸반은 자기 자료라 직접 넣는다. */
export function fileSource(path: string): FileSource {
  if (path.startsWith(SHARED_IN)) return 'meeting-in';
  if (path.startsWith(SHARED_OUT)) return 'meeting-out';
  if (path.startsWith('workspace/uploads/')) return 'upload';
  return 'agent';
}

/** 회의 공유 폴더 경로의 방 번호(aas-shared/<방>/…). 아니면 '' */
export function sharedRoom(path: string): string {
  const head = path.startsWith(SHARED_IN) ? SHARED_IN : path.startsWith(SHARED_OUT) ? SHARED_OUT : '';
  return head ? path.slice(head.length).split('/')[0] || '' : '';
}

export const extOf = (name: string) => {
  const base = name.split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
};

const TEXT_EXT = new Set(
  (
    'txt log json jsonl yaml yml toml ini cfg conf env xml xsd xsl plist py js mjs cjs jsx ts tsx mts cts sh bash zsh sql java kt kts ' +
    'scala sc go rs c h cc cpp cxx hpp cs php rb pl pm lua r swift ps1 psm1 bat cmd dockerfile scss less css graphql gql proto tf tfvars hcl ' +
    'j2 tmpl gitignore properties'
  ).split(' ')
);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg']);
const VIDEO_EXT = new Set(['mp4', 'webm']);

/** 이름 → 그리는 법(§3-5 표). 확장자가 없으면 'text' 후보로 두고 뷰어가 앞 4 KB 로 글인지 본다. */
export function viewerKind(name: string): ViewerKind {
  const base = (name.split('/').pop() || '').toLowerCase();
  if (base === 'dockerfile' || base === 'makefile') return 'text';
  const ext = extOf(name);
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'svg') return 'svg';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'csv' || ext === 'tsv') return 'csv';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx'; // Word(스펙 2026-10-20-005 1단계)
  if (ext === 'xlsx') return 'xlsx'; // 2단계. 옛 형식 doc·xls·ppt 는 받기만(§7 D6)
  if (ext === 'pptx') return 'pptx';
  if (ext === 'hwp' || ext === 'hwpx') return 'hwp';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (TEXT_EXT.has(ext) || !ext) return 'text';
  return 'other';
}

/** 미리 보기 한도(D3, 바이트). 글 종류는 넘으면 앞부분만 보이고(R3), 그 밖은 받지 않는다 */
export const VIEW_LIMIT: Record<ViewerKind, number> = {
  markdown: 2 * 1024 * 1024,
  text: 2 * 1024 * 1024,
  html: 2 * 1024 * 1024,
  csv: 5 * 1024 * 1024,
  svg: 20 * 1024 * 1024,
  image: 20 * 1024 * 1024,
  pdf: 50 * 1024 * 1024,
  docx: 20 * 1024 * 1024, // zip 이라 풀면 커진다 — 압축 전 크기는 따로 본다(005 리뷰 D13)
  xlsx: 10 * 1024 * 1024,
  pptx: 20 * 1024 * 1024,
  hwp: 20 * 1024 * 1024,
  audio: 100 * 1024 * 1024,
  video: 100 * 1024 * 1024,
  other: 0,
};
/** 앞부분만 읽어 보여도 되는 종류(R3) */
export const PARTIAL_OK = new Set<ViewerKind>(['text', 'markdown', 'csv']);

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
};
/** 받기 API 는 늘 octet-stream 이라 종류에 맞는 형식으로 Blob 을 다시 감싼다(외부 검토 F1) */
export const mimeOf = (name: string) => MIME[extOf(name)] || 'application/octet-stream';

export function iconKind(name: string): IconKind {
  const ext = extOf(name);
  const kind = viewerKind(name);
  if (kind === 'image' || kind === 'svg') return 'image';
  if (kind === 'pdf') return 'pdf';
  if (kind === 'csv' || ['xlsx', 'xls', 'ods'].includes(ext)) return 'table';
  if (kind === 'audio' || kind === 'video') return 'media';
  if (['zip', 'gz', 'tgz', 'tar', '7z', 'rar'].includes(ext)) return 'archive';
  if (kind === 'markdown' || ['txt', 'docx', 'doc', 'hwp', 'hwpx', 'pptx', 'ppt', 'odt', 'rtf'].includes(ext)) return 'doc';
  if (kind === 'text' || kind === 'html') return 'code';
  return 'file';
}
