/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 스킬 허브의 태그 칩 줄(OMAI-1275). 표 바로 위에서 태그를 켜고 꺼 스킬을 거른다. 여러 개를 켜면 고른 태그를 모두 가진 스킬만 남는다.
// 태그는 업무(영업·마케팅…, 스킬마다 하나)와 기능(문서·자동화…)으로 나뉘고, 둘 다 있으면 칩도 「업무」·「기능」 두 줄이다(스펙 2026-11-17-003).
// 색은 표의 거르기 배지(ListView toggles)와 같은 값(gridTokens)을 쓴다 — 켠 칩은 색이 아니라 테두리·바탕의 대비만 올린다(Hue Discipline).
import BusinessCenterOutlinedIcon from '@mui/icons-material/BusinessCenterOutlined';
import CategoryOutlinedIcon from '@mui/icons-material/CategoryOutlined';
import { Box, Stack } from '@mui/material';
import { ReactNode } from 'react';

import { t } from '@/i18n';
import { FOCUS_RING, gridTokens } from '@/lib/shellTokens';

export interface TagCount {
  id: string;
  n: number;
}

/** 업무 태그 id — 서버 aas/market/tags.py 의 WORK(업무 템플릿 soul_templates.CATALOG 의 id + common)와 같은 순서다. 칩도 이 순서로 놓는다 */
export const WORK_TAGS = ['marketing', 'sales', 'research', 'engineering', 'general_affairs', 'accounting', 'hr', 'support', 'planning', 'legal', 'common'] as const;
const WORK_SET = new Set<string>(WORK_TAGS);
export const isWorkTag = (id: string): boolean => WORK_SET.has(id);

/** 칩 하나를 켜거나 끈 다음 목록. 업무는 스킬마다 하나라 둘을 켜면 늘 0개가 되므로 업무 칩은 하나만 켜진다(다른 업무 칩은 꺼진다). 기능 칩은 여러 개 */
export function toggleTag(active: string[], id: string): string[] {
  if (active.includes(id)) return active.filter((x) => x !== id);
  return [...(isWorkTag(id) ? active.filter((x) => !isWorkTag(x)) : active), id];
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
  const chipOf = (c: TagCount) => {
    const on = active.includes(c.id);
    const n = view ? (view[c.id] ?? 0) : c.n;
    return (
      <Box key={c.id} component="button" type="button" aria-pressed={on} onClick={() => onToggle(c.id)} sx={[chip(on), !on && n === 0 ? { opacity: 0.5 } : {}]}>
        {tagLabel(c.id)}
        <Box component="span" sx={{ opacity: 0.7 }}>{n}</Box>
      </Box>
    );
  };
  const all = (
    <Box component="button" type="button" aria-pressed={active.length === 0} onClick={onClear} sx={chip(active.length === 0)}>
      {t('market.tagsAll')}
      <Box component="span" sx={{ opacity: 0.7 }}>{total}</Box>
    </Box>
  );
  // 업무 칩은 업무 목록 순서, 기능 칩은 많은 순(counts 순서 그대로)
  const work = WORK_TAGS.map((id) => counts.find((c) => c.id === id)).filter((c): c is TagCount => !!c);
  const kinds = counts.filter((c) => !isWorkTag(c.id));
  const row = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 0.75 } as const;
  // 두 줄일 때: 이름표는 왼쪽 칸에 고정하고 칩은 오른쪽 칸 안에서만 줄바꿈한다 — 넘친 칩이 이름표 아래 왼쪽 끝에서 시작하지 않게(2026-11-17 OKE 화면)
  const line = { display: 'flex', alignItems: 'flex-start', gap: 0.75 } as const;
  const chips = { ...row, flex: 1, minWidth: 0 } as const;
  // 줄 이름표(「업무별」·「기능별」): 아이콘 + 글자, 두 줄이 같은 폭이라 칩이 세로로 나란하다(2026-11-17 사용자 요청)
  const caption = (key: string, icon: ReactNode) => (
    <Box
      component="span"
      sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, width: 72, height: 28, flexShrink: 0, fontSize: 12, fontWeight: 600, color: 'text.secondary' }}
    >
      {icon}
      {t(key)}
    </Box>
  );
  const iconSx = { fontSize: 16, opacity: 0.8 } as const;
  // 한 갈래만 있으면(옛 태그만 있는 표·업무만 있는 표) 이름표 없이 한 줄 — 전과 같은 모양
  const grouped = work.length > 0 && kinds.length > 0;
  return (
    <Stack direction="row" alignItems="flex-start" spacing={1} sx={GAP}>
      {grouped ? (
        <Stack spacing={0.75} sx={{ flex: 1, minWidth: 0 }}>
          <Box role="group" aria-label={t('market.tagGroup.work')} sx={line}>
            {caption('market.tagGroup.work', <BusinessCenterOutlinedIcon sx={iconSx} />)}
            <Box sx={chips}>
              {all}
              {work.map(chipOf)}
            </Box>
          </Box>
          <Box role="group" aria-label={t('market.tagGroup.kind')} sx={line}>
            {caption('market.tagGroup.kind', <CategoryOutlinedIcon sx={iconSx} />)}
            <Box sx={chips}>{kinds.map(chipOf)}</Box>
          </Box>
        </Stack>
      ) : (
        <Box role="group" aria-label={t('market.tagsFilter')} sx={{ ...row, flex: 1, minWidth: 0 }}>
          {all}
          {[...work, ...kinds].map(chipOf)}
        </Box>
      )}
      {action}
    </Stack>
  );
}
