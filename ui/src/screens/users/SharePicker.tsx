/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 사람 고치기 서랍의 「다른 사람의 AI 에이전트 작업공간 공유」 고르개(스펙 2026-11-18-001).
// 체크박스를 줄바꿈으로 흘려 놓으면 20개가 넘을 때 정렬이 없고 「○○의 AI 에이전트 작업공간」이 되풀이돼 읽기 어려웠다.
// 한 열 목록으로 바꾸고 사람 이름 칸·작업공간 이름 칸을 나눈다. 같은 사람의 작업공간은 붙여 두고 사람 이름은 첫 줄에만 보인다.
import SearchIcon from '@mui/icons-material/Search';
import { Box, Button, Checkbox, InputBase, Stack, Typography } from '@mui/material';
import { useId, useMemo, useState } from 'react';

import { t } from '@/i18n';

export interface SharePod {
  id: string;
  owner?: string;
  name?: string;
}

export interface ShareRow {
  id: string;
  /** 주인의 사람 이름. 모르면 이메일, 주인이 없으면 빈 값 */
  owner: string;
  /** 작업공간 이름. 없으면 id */
  agent: string;
}

/** 찾기 칸을 보이는 최소 개수. 이보다 적으면 한눈에 보인다 */
export const SEARCH_MIN = 8;

/** 목록 줄: 사람 이름 순(주인 없는 것은 끝), 같은 사람 안에서는 작업공간 이름 순 */
export function shareRows(pods: SharePod[], nameOfEmail: (email: string) => string | undefined): ShareRow[] {
  const rows = pods.map((p) => {
    const email = p.owner && p.owner !== '*' ? p.owner : '';
    return { id: p.id, owner: email ? nameOfEmail(email) || email : '', agent: p.name || p.id };
  });
  return rows.sort((a, b) => {
    if (!a.owner !== !b.owner) return a.owner ? -1 : 1;
    return a.owner.localeCompare(b.owner, 'ko') || a.agent.localeCompare(b.agent, 'ko');
  });
}

/** 찾기: 사람 이름·작업공간 이름·id 에 글자가 들어 있으면 남긴다(대소문자 무시) */
export function filterShareRows(rows: ShareRow[], query: string): ShareRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => [r.owner, r.agent, r.id].some((s) => s.toLowerCase().includes(q)));
}

export interface SharePickerProps {
  rows: ShareRow[];
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}

export function SharePicker({ rows, value, onChange, disabled }: SharePickerProps) {
  const titleId = useId();
  const [query, setQuery] = useState('');
  const visible = useMemo(() => filterShareRows(rows, query), [rows, query]);
  const chosen = new Set(value);
  // 목록에 없는 id(지워진 작업공간)는 세지 않는다
  const count = rows.filter((r) => chosen.has(r.id)).length;
  const toggle = (id: string, on: boolean) => onChange(on ? [...value, id] : value.filter((x) => x !== id));

  return (
    <Box role="group" aria-labelledby={titleId} sx={{ mt: 1.5 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.75, minHeight: 24 }}>
        <Typography id={titleId} variant="caption" color="text.secondary" sx={{ flex: 1, minWidth: 0 }}>
          {t('users.shareTitle')}
        </Typography>
        {rows.length > 0 && (
          <Typography variant="caption" color={count ? 'text.primary' : 'text.secondary'} aria-live="polite" sx={{ whiteSpace: 'nowrap' }}>
            {t('users.shareCount', { n: count, total: rows.length })}
          </Typography>
        )}
        {count > 0 && (
          <Button size="small" color="inherit" disabled={disabled} onClick={() => onChange(value.filter((x) => !rows.some((r) => r.id === x)))} sx={{ minWidth: 0, py: 0, px: 0.75, fontSize: 12, color: 'text.secondary' }}>
            {t('users.shareClear')}
          </Button>
        )}
      </Stack>

      {rows.length === 0 ? (
        <Typography variant="caption" color="text.secondary" component="p" sx={{ m: 0 }}>
          {t('users.noShareable')}
        </Typography>
      ) : (
        <Box
          sx={(th) => ({
            border: 1,
            borderColor: th.palette.mode === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(17,24,39,0.10)',
            borderRadius: 1,
            overflow: 'hidden',
          })}
        >
          {rows.length > SEARCH_MIN && (
            <Box
              sx={(th) => {
                const dark = th.palette.mode === 'dark';
                return {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1,
                  px: 1.25,
                  height: 36,
                  bgcolor: dark ? 'rgba(255,255,255,0.025)' : 'rgba(17,24,39,0.02)',
                  borderBottom: 1,
                  borderColor: dark ? 'rgba(255,255,255,0.06)' : 'rgba(17,24,39,0.06)',
                };
              }}
            >
              <SearchIcon sx={{ fontSize: 16, color: 'text.secondary' }} aria-hidden="true" />
              <InputBase
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('users.shareSearch')}
                inputProps={{ 'aria-label': t('users.shareSearch'), spellCheck: false, type: 'search' }}
                sx={{ flex: 1, fontSize: 13 }}
              />
            </Box>
          )}
          <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0, maxHeight: 340, overflowY: 'auto' }}>
            {visible.length === 0 && (
              <Typography component="li" variant="caption" color="text.secondary" sx={{ display: 'block', px: 1.5, py: 1.5 }}>
                {t('users.shareNoMatch', { q: query.trim() })}
              </Typography>
            )}
            {visible.map((r, i) => {
              const first = i === 0 || visible[i - 1].owner !== r.owner;
              const on = chosen.has(r.id);
              // 접근성 이름은 늘 「주인 · 작업공간」. 사람 이름 칸은 묶음 첫 줄에만 보여도 보조기기는 줄마다 누구의 것인지 읽는다
              const full = r.owner ? t('common.agentOwner', { owner: r.owner, agent: r.agent }) : r.agent;
              return (
                <Box component="li" key={r.id} data-share-row={r.id} data-checked={on || undefined}>
                  <Box
                    component="label"
                    title={full}
                    sx={(th) => {
                      const dark = th.palette.mode === 'dark';
                      return {
                        display: 'grid',
                        gridTemplateColumns: { xs: '32px minmax(0, 6.5rem) minmax(0, 1fr)', sm: '32px minmax(0, 10rem) minmax(0, 1fr)' },
                        alignItems: 'center',
                        columnGap: 1,
                        minHeight: 36,
                        pr: 1.5,
                        cursor: disabled ? 'default' : 'pointer',
                        borderTop: first && i > 0 ? 1 : 0,
                        borderColor: dark ? 'rgba(255,255,255,0.05)' : 'rgba(17,24,39,0.06)',
                        boxShadow: on ? `inset 2px 0 0 ${dark ? 'rgba(255,255,255,0.85)' : 'rgba(17,24,39,0.70)'}` : 'none',
                        bgcolor: on ? (dark ? 'rgba(255,255,255,0.06)' : 'rgba(17,24,39,0.04)') : 'transparent',
                        '&:hover': { bgcolor: on ? undefined : dark ? 'rgba(255,255,255,0.04)' : 'rgba(17,24,39,0.025)' },
                      };
                    }}
                  >
                    <Checkbox size="small" checked={on} disabled={disabled} onChange={(e) => toggle(r.id, e.target.checked)} inputProps={{ 'aria-label': full }} sx={{ p: 0.75, justifySelf: 'center' }} />
                    <Typography
                      variant="body2"
                      noWrap
                      sx={{ fontWeight: 500, color: on ? 'text.primary' : 'text.secondary' }}
                      aria-hidden="true"
                    >
                      {first ? r.owner : ''}
                    </Typography>
                    <Typography variant="body2" noWrap aria-hidden="true" sx={{ color: on ? 'text.primary' : 'text.secondary' }}>
                      {r.agent}
                    </Typography>
                  </Box>
                </Box>
              );
            })}
          </Box>
        </Box>
      )}
    </Box>
  );
}
