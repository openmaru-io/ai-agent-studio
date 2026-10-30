/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 스킬 허브의 태그 칩 줄(OMAI-1275). 표 바로 위에서 태그를 켜고 꺼 스킬을 거른다. 여러 개를 켜면 고른 태그를 모두 가진 스킬만 남는다.
// 색은 표의 거르기 배지(ListView toggles)와 같은 값(gridTokens)을 쓴다 — 켠 칩은 색이 아니라 테두리·바탕의 대비만 올린다(Hue Discipline).
import { Box, Stack } from '@mui/material';
import { ReactNode } from 'react';

import { t } from '@/i18n';
import { FOCUS_RING, gridTokens } from '@/lib/shellTokens';

export interface TagCount {
  id: string;
  n: number;
}

/** 태그마다 몇 개가 가졌는지: 많은 순, 같으면 id 순. 태그 없는 항목은 세지 않는다 */
export function tagCounts(items: { tags?: string[] }[]): TagCount[] {
  const n = new Map<string, number>();
  for (const it of items) for (const id of new Set(it.tags ?? [])) n.set(id, (n.get(id) ?? 0) + 1);
  return [...n].map(([id, c]) => ({ id, n: c })).sort((a, b) => b.n - a.n || a.id.localeCompare(b.id));
}

/** 고른 태그를 모두 가졌는가. 고른 것이 없으면 늘 참 */
export const tagMatches = (item: { tags?: string[] }, active: string[]): boolean => active.every((id) => (item.tags ?? []).includes(id));

/** 태그 이름(현재 언어). 번역이 없는 id 는 그대로 보인다 */
export const tagLabel = (id: string): string => {
  const key = `market.tag.${id}`;
  const v = t(key);
  return v === key ? id : v;
};

export interface TagBarProps {
  counts: TagCount[];
  /** 거르기 전 전체 개수(「전체」 칩) */
  total: number;
  active: string[];
  onToggle: (id: string) => void;
  onClear: () => void;
  /** 줄 오른쪽 끝의 동작(관리자 「AI 태그 다시 분류」) */
  action?: ReactNode;
  /** 칩에 보일 수(지금 보기 기준, 스펙 2026-10-27-011 D6). 주면 칩 목록·순서는 counts 그대로 두고 수만 바꾸며, 0 인 칩은 흐리게(누를 수는 있다) */
  view?: Record<string, number>;
}

// 탭 줄(카드 모드에서는 보기 카드 줄, 2026-10-17-011) 바로 밑에 그려진다(ListView 의 above). 위 간격을 두고 아래는 두지 않는다 — 아래는 표가 mt 1.5 를 가진다.
// 전에는 아래에만 1.5 를 둬 탭 밑줄에 칩이 붙고, 표와의 사이는 두 배(24px)였다(2026-10-17 사용자 보고)
const GAP = { mt: 1.5 } as const;

export function TagBar({ counts, total, active, onToggle, onClear, action, view }: TagBarProps) {
  // 태그가 하나도 없으면 칩은 그리지 않는다. 그래도 동작(관리자 「AI 태그 다시 분류」)은 남긴다 — 분류가 모두 실패해 태그가 없을 때 다시 시도할 길이 필요하다
  if (!counts.length)
    return action ? (
      <Stack direction="row" justifyContent="flex-end" sx={GAP}>
        {action}
      </Stack>
    ) : null;
  const chip = (on: boolean) => (th: { palette: { mode: 'light' | 'dark' } }) => {
    const tk = gridTokens[th.palette.mode];
    return {
      all: 'unset',
      boxSizing: 'border-box',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 0.75,
      height: 28,
      px: 1.25,
      borderRadius: 9999,
      border: `1px solid ${on ? tk.selectedAccent : tk.toggleLine}`,
      bgcolor: on ? tk.selected : 'transparent',
      color: on ? tk.selectedText : 'text.secondary',
      fontSize: 12,
      fontWeight: on ? 600 : 400,
      cursor: 'pointer',
      whiteSpace: 'nowrap',
      '&:hover': { bgcolor: tk.hover },
      '&:focus-visible': { outline: `2px solid ${FOCUS_RING}`, outlineOffset: 2 },
    };
  };
  return (
    <Stack direction="row" alignItems="flex-start" spacing={1} sx={GAP}>
      <Box role="group" aria-label={t('market.tagsFilter')} sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, flex: 1, minWidth: 0 }}>
        <Box component="button" type="button" aria-pressed={active.length === 0} onClick={onClear} sx={chip(active.length === 0)}>
          {t('market.tagsAll')}
          <Box component="span" sx={{ opacity: 0.7 }}>{total}</Box>
        </Box>
        {counts.map((c) => {
          const on = active.includes(c.id);
          const n = view ? (view[c.id] ?? 0) : c.n;
          return (
            <Box key={c.id} component="button" type="button" aria-pressed={on} onClick={() => onToggle(c.id)} sx={[chip(on), !on && n === 0 ? { opacity: 0.5 } : {}]}>
              {tagLabel(c.id)}
              <Box component="span" sx={{ opacity: 0.7 }}>{n}</Box>
            </Box>
          );
        })}
      </Box>
      {action}
    </Stack>
  );
}
