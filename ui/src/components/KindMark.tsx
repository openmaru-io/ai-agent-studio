/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 호출 흐름의 종류 표시(스·코·M·외 등): 종류 색 동그라미 안의 흰 글자. 그림 노드·종류 칩·읽는 법·살펴보기가 모두 이것을 쓴다
// (2026-10-14 — 글자만 있으면 어느 종류인지 색으로 이어지지 않는다). 읽기 프로그램에는 종류 이름이 따로 있어 숨긴다.
import { Box } from '@mui/material';

import { kindMark } from '@/lib/flowLabels';

export const KIND_COLOR: Record<string, string> = {
  cron: '#d9480f',
  skill: '#4f6bed',
  script: '#0e9f6e',
  mcp: '#9c36b5',
  host: '#c2255c',
  cred: '#e67700',
  lib: '#1c7ed6',
};
export const kindColor = (k: string) => KIND_COLOR[k] ?? '#888';

/** size: 지름(px). 그림 노드 24, 글줄 안 16 */
export function KindMark({ kind, size = 16 }: { kind: string; size?: number }) {
  return (
    <Box
      component="span"
      aria-hidden="true"
      data-kind-mark={kind}
      sx={{
        width: size,
        height: size,
        borderRadius: '50%',
        bgcolor: kindColor(kind),
        color: '#fff',
        fontSize: Math.round(size / 2),
        fontWeight: 500,
        lineHeight: 1,
        display: 'inline-grid',
        placeItems: 'center',
        flex: 'none',
        verticalAlign: 'middle',
      }}
    >
      {kindMark(kind)}
    </Box>
  );
}
