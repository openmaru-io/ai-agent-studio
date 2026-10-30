/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 탭 글자에 붙는 개수 배지(OMAI-1224·OMAI-1234). 받은편지함 종(InboxButton)과 같은 배지다: 오른쪽 위 모서리, 18px 원, 글자 10px 굵게.
// 0 이거나 tone 이 없으면 무채색이다. 탭의 색은 「여기 문제가 있다」는 뜻이라 0 에 칠하면 문제가 있는 것처럼 보인다.
// ListView 의 탭과 오피스 화면의 탭이 함께 쓴다.
import { Badge } from '@mui/material';
import type { ReactNode } from 'react';

export type TabTone = 'bad' | 'warn' | 'good';

const toneColor = (tone?: TabTone) =>
  tone === 'bad' ? 'error' : tone === 'warn' ? 'warning' : tone === 'good' ? 'success' : 'default';

export function TabCountBadge({ count, tone, children }: { count: number; tone?: TabTone; children: ReactNode }) {
  return (
    <Badge
      badgeContent={count}
      showZero
      max={999}
      color={toneColor(count ? tone : undefined)}
      sx={(th) => ({
        mr: 1.25, // 배지는 모서리에 반쯤 걸쳐 나간다. 그 폭만큼 다음 탭과 떨어뜨린다
        // 36px 탭에서는 MUI Tab 자신이 넘침을 잘라 기본 자리(위로 배지 높이의 50%)면 윗면이 잘린다. 모서리는 두고 30% 만 올린다(스펙 2026-10-19-005 R2)
        '& .MuiBadge-anchorOriginTopRight': { transform: 'scale(1) translate(50%, -30%)' },
        '& .MuiBadge-badge': {
          fontSize: 10,
          fontWeight: 700,
          minWidth: 18,
          height: 18,
          px: 0.5,
          // 0·tone 없음: 무채색 원(예전 Chip 의 default 색). tone 이 있으면 MUI 색
          // 색이 있는 배지의 숫자: 라이트 모드는 모두 흰색. 다크 모드는 주황·초록이 검은색, 빨강은 흰색
          // (2026-10-15 사용자 결정, 빨강은 2026-10-16 OMAI-1247 로 흰색)
          ...(count && tone
            ? { color: th.palette.mode === 'dark' && tone !== 'bad' ? '#08090a' : '#fff' }
            : { bgcolor: th.palette.mode === 'dark' ? 'rgba(255,255,255,0.16)' : 'rgba(17,24,39,0.12)', color: th.palette.text.primary }),
        },
      })}
    >
      {/* 글자 뒤 여백: 배지 중심이 글자가 아니라 이 빈칸 위에 놓인다 */}
      <span style={{ paddingRight: 10 }}>{children}</span>
    </Badge>
  );
}
