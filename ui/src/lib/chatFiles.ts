/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 대화 파일(OMAI-1153, 스펙 2026-10-14-005 §3-9·§3-10): 올리기 대기열, 받기 전 확인, 서랍 목록·지우기.
// 서버는 이유를 코드로만 보내고 문구는 여기서 번역 키로 바꾼다(재검토 O-7). 화면과 네트워크 말고는 기대지 않는다.
import { getLang, t } from '@/i18n';

export const MAX_FILES = 10; // 한 메시지에 붙이는 파일 수(D7)
export const MAX_SIZE = 100 * 1024 * 1024; // 한 파일 상한(D8, 단계 0 의 Ingress 실측이 더 작으면 그 값으로)
export const PARALLEL = 2; // 화면이 동시에 올리는 수(D7)
export const CHIP_FIRST = 5; // 결과 칩을 처음에 보이는 수(D5)

export type UploadState = 'wait' | 'up' | 'done' | 'fail';

export interface Upload {
  key: string;
  file: File;
  name: string;
  size: number;
  state: UploadState;
  pct: number;
  path?: string;
  renamed?: boolean;
  code?: string;
  xhr?: XMLHttpRequest;
  retried?: boolean;
  /** 작업 폴더에서 고른 파일(올리지 않고 붙임, attachExisting). 다시 올릴 수 없다 */
  picked?: boolean;
}

export interface FileRef {
  name: string;
  path: string;
  size?: number;
  sizeLabel?: string;
  status?: 'new' | 'modified';
  downloadable?: boolean;
  reason?: string;
}

export interface ListingEntry {
  path: string;
  name: string;
  size: number;
  mtime: number;
  kind: 'file' | 'dir';
  downloadable: boolean;
  reason: string;
  /** 회의 공유 볼륨 안의 파일(리뷰 R10) */
  shared?: boolean;
  room?: string;
}

export interface Listing {
  entries: ListingEntry[];
  truncated: boolean;
  used: number | null;
  quota: number;
  /** 회의 공유 파일 합계 — 에이전트 한도 밖(R10) */
  shared_used?: number | null;
  shared_truncated?: boolean;
}

/** 사람이 읽는 크기 — 서버 attach_notice.human_size 와 같은 규칙. */
export function humanSize(n: number): string {
  let v = Math.max(0, Math.floor(n));
  const units = ['B', 'KB', 'MB', 'GB'];
  for (let i = 0; i < units.length; i++) {
    if (v < 1024 || i === units.length - 1) {
      if (i === 0) return `${v} B`;
      return `${v.toFixed(1).replace(/\.0$/, '')} ${units[i]}`;
    }
    v /= 1024;
  }
  return `${v} B`;
}

/** 긴 이름은 가운데를 줄이고 확장자는 남긴다(D5, DESIGN §8). */
export function middleEllipsis(name: string, max = 28): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 8 ? name.slice(dot) : '';
  const room = max - ext.length - 1;
  const head = Math.ceil(room * 0.6);
  return name.slice(0, head) + '…' + name.slice(name.length - ext.length - (room - head), name.length - ext.length) + ext;
}

/** 이유 코드 → 화면 문구. 모르는 코드는 일반 문구. */
export function reasonText(code?: string): string {
  const key = `chat.files.reason.${code || 'unknown'}`;
  const text = t(key);
  return text === key ? t('chat.files.reason.unknown') : text;
}

/** 올리기 전 화면 검사(D7): 개수·크기·빈 파일. 폴더는 끌어 놓기에서 따로 걸러낸다. 이유 코드, 없으면 ''. */
export function precheck(file: File, attached: number): string {
  if (attached >= MAX_FILES) return 'too_many';
  if (file.size === 0) return 'empty';
  if (file.size > MAX_SIZE) return 'too_large';
  return '';
}

export const fileUrl = (pod: string, path: string) =>
  `/api/chat/files?pod=${encodeURIComponent(pod)}&path=${encodeURIComponent(path)}`;

/** 받기 전에 확인한다(R16). 되면 '', 아니면 이유 코드. */
export async function checkDownload(pod: string, path: string): Promise<string> {
  try {
    const r = await fetch(fileUrl(pod, path), { method: 'HEAD', headers: { 'X-AAS': '1', 'Accept-Language': getLang() } });
    return r.ok ? '' : r.headers.get('X-AAS-Code') || 'unknown';
  } catch {
    return 'agent_unreachable';
  }
}

/** 확인이 되면 브라우저가 디스크로 받게 한다(메모리에 올리지 않는다, R11). */
export async function download(pod: string, path: string, name: string): Promise<string> {
  const code = await checkDownload(pod, path);
  if (code) return code;
  const a = document.createElement('a');
  a.href = fileUrl(pod, path);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  return '';
}

export async function listFiles(pod: string): Promise<Listing> {
  const r = await fetch(`/api/chat/files/list?pod=${encodeURIComponent(pod)}`, { headers: { 'Accept-Language': getLang() } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(reasonText((body as { code?: string }).code));
  return body as Listing;
}

/** 파일(또는 recursive 면 폴더 통째로, 스펙 2026-10-28-002)을 지운다. 성공이면 '', 실패면 이유 코드 */
export async function deleteFile(pod: string, path: string, recursive = false): Promise<string> {
  try {
    const r = await fetch(fileUrl(pod, path) + (recursive ? '&recursive=1' : ''), { method: 'DELETE', headers: { 'X-AAS': '1', 'Accept-Language': getLang() } });
    if (r.ok) return '';
    return ((await r.json().catch(() => ({}))) as { code?: string }).code || 'unknown';
  } catch {
    return 'agent_unreachable';
  }
}

/** 파일 하나를 올린다(XHR — 진행률을 받는다). 429 는 한 번만 자동으로 다시 한다(D7). */
export function sendUpload(pod: string, u: Upload, onChange: () => void): Promise<void> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    u.xhr = xhr;
    u.state = 'up';
    u.pct = 0;
    onChange();
    xhr.open('PUT', `/api/chat/files?pod=${encodeURIComponent(pod)}&name=${encodeURIComponent(u.name)}`);
    xhr.setRequestHeader('X-AAS', '1');
    xhr.setRequestHeader('Accept-Language', getLang());
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        u.pct = Math.round((e.loaded / e.total) * 100);
        onChange();
      }
    };
    const finish = () => {
      u.xhr = undefined;
      onChange();
      resolve();
    };
    xhr.onload = () => {
      let body: { path?: string; name?: string; renamed?: boolean; code?: string } = {};
      try {
        body = JSON.parse(xhr.responseText || '{}');
      } catch {
        /* 본문 없는 오류 */
      }
      if (xhr.status === 200 && body.path) {
        Object.assign(u, { state: 'done', pct: 100, path: body.path, name: body.name || u.name, renamed: !!body.renamed });
        return finish();
      }
      if (xhr.status === 429 && !u.retried) {
        u.retried = true;
        u.state = 'wait';
        onChange();
        setTimeout(() => void sendUpload(pod, u, onChange).then(resolve), 1500);
        return;
      }
      Object.assign(u, { state: 'fail', code: body.code || (xhr.status === 429 ? 'busy' : 'unknown') });
      finish();
    };
    xhr.onerror = () => {
      Object.assign(u, { state: 'fail', code: 'agent_unreachable' });
      finish();
    };
    xhr.onabort = () => {
      Object.assign(u, { state: 'fail', code: 'aborted' });
      finish();
    };
    xhr.send(u.file);
  });
}
