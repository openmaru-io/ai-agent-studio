/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 글마다 따로 남는 판(版) 기록의 공통 호출. 글을 가리키는 열쇠(key)만 다르다.
import type { VersionInfo } from '@/components/TextEditor';
import type { LineDiff } from '@/lib/mdtools';

import { get, post } from './api';

export const versionApi = (key: string) => ({
  versions: async () =>
    (await get<{ versions: VersionInfo[] }>('/api/text/versions?key=' + encodeURIComponent(key))).versions,
  version: (id: number) => get<{ lines: string[] }>(`/api/text/version?key=${encodeURIComponent(key)}&id=${id}`),
  diff2: (a: number, b: number) => get<LineDiff>(`/api/text/diff2?key=${encodeURIComponent(key)}&a=${a}&b=${b}`),
  rename: (id: number, note: string) => post('/api/text/label', { key, id, note }),
});
