/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 입력창 위 고르기 목록(스펙 2026-10-19-012 P3, 디자인 DD1~DD4·DD8·DD11·DD12).
// 줄 44px: 윗줄 입력창에 들어갈 글자(/키·@이름), 아랫줄 설명 한 줄 말줄임표, 오른쪽 hint. 고른 줄은 무채색 wash + 왼쪽 2px 줄(빨강 없음).
// 포커스는 입력칸에 남고(aria-activedescendant), 줄을 눌러도 입력칸이 포커스를 잃지 않게 pointerdown 기본 동작을 막는다(DD11).
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined';
import { Box, Button, CircularProgress, Link, Popper } from '@mui/material';
import { useEffect, useRef } from 'react';

import { t } from '@/i18n';
import { chatMetrics, chatType } from '@/lib/chatTokens';
import type { SuggestItem } from '@/lib/composerSuggest';

import { useChatTokens } from './useChatTokens';

export type SuggestState = 'list' | 'loading' | 'error' | 'empty';

export interface SuggestListProps {
  anchor: HTMLElement | null;
  id: string;
  title: string;
  state: SuggestState;
  items: SuggestItem[];
  /** 고른 줄(목록이면 항목 번호, 상태 줄이면 0 이 그 줄의 단추·링크) — -1 은 없음 */
  active: number;
  optionId: (i: number) => string;
  onPick: (item: SuggestItem) => void;
  onHover: (i: number) => void;
  loadingText?: string;
  errorText?: string;
  onRetry?: () => void;
  emptyText?: string;
  emptyLink?: { href: string; label: string };
  /** 맨 아래 고정 경고 줄(회의실 부분 실패, DD4) */
  warning?: string;
}

const ROW = chatMetrics.touch; // 44px — 마우스·손가락 같은 높이(DD1)

/** 줄을 묶음(group)별로 나눈다. 묶음이 없으면 하나. i 는 전체 목록에서의 번호(고른 줄·option id 에 쓴다) */
function sections(items: SuggestItem[]): { group?: string; key: number; rows: { it: SuggestItem; i: number }[] }[] {
  const out: { group?: string; key: number; rows: { it: SuggestItem; i: number }[] }[] = [];
  items.forEach((it, i) => {
    const last = out[out.length - 1];
    if (last && last.group === it.group) last.rows.push({ it, i });
    else out.push({ group: it.group, key: out.length, rows: [{ it, i }] });
  });
  return out;
}
const keepFocus = (e: React.PointerEvent | React.MouseEvent) => e.preventDefault();

export function SuggestList(p: SuggestListProps) {
  const tk = useChatTokens();
  const listRef = useRef<HTMLDivElement>(null);
  const width = p.anchor ? Math.min(p.anchor.getBoundingClientRect().width || 440, 440) : 440;
  // 입력창 위 보이는 공간(키보드를 뺀 높이, DD11). 모자라면 목록 안에서 스크롤한다
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  const top = p.anchor?.getBoundingClientRect().top ?? 0;
  const room = Math.max(ROW * 2, top - (vv?.offsetTop ?? 0) - 8 - 52);
  const maxList = Math.min(ROW * 8, room);

  useEffect(() => {
    if (p.state !== 'list' || p.active < 0) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[id="${p.optionId(p.active)}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [p.active, p.state]); // eslint-disable-line react-hooks/exhaustive-deps

  const status = (body: React.ReactNode) => (
    <Box sx={{ minHeight: ROW, display: 'flex', alignItems: 'center', gap: 1, px: 1.5, fontSize: chatType.meta, color: tk.muted }}>{body}</Box>
  );
  const focusRing = (on: boolean) => (on ? { outline: `2px solid ${tk.selectedAccent}`, outlineOffset: 1 } : {});

  return (
    <Popper
      open={!!p.anchor}
      anchorEl={p.anchor}
      placement="top-start"
      modifiers={[{ name: 'offset', options: { offset: [0, 6] } }]}
      sx={{ zIndex: 1600 }}
    >
      <Box
        onPointerDown={keepFocus}
        onMouseDown={keepFocus}
        sx={{
          width,
          bgcolor: tk.popup.surface,
          border: `1px solid ${tk.popup.edge}`,
          boxShadow: tk.popup.shadow,
          borderRadius: `${chatMetrics.panelRadius}px`,
          overflow: 'hidden',
        }}
      >
        {p.title && <Box sx={{ px: 1.5, pt: 0.75, pb: 0.25, fontSize: chatType.meta, color: tk.muted }}>{p.title}</Box>}
        {p.state === 'loading' &&
          status(
            <>
              <CircularProgress size={12} color="inherit" aria-hidden />
              {p.loadingText}
            </>
          )}
        {p.state === 'error' &&
          status(
            <>
              <span>{p.errorText}</span>
              {p.onRetry && (
                <Button size="small" color="inherit" id={p.optionId(0)} onClick={p.onRetry} sx={{ minWidth: 0, px: 0.75, ...focusRing(p.active === 0) }}>
                  {t('chat.suggest.retry')}
                </Button>
              )}
            </>
          )}
        {p.state === 'empty' &&
          status(
            <>
              <span>{p.emptyText}</span>
              {p.emptyLink && (
                <Link id={p.optionId(0)} href={p.emptyLink.href} color="inherit" sx={{ ...focusRing(p.active === 0) }}>
                  {p.emptyLink.label}
                </Link>
              )}
            </>
          )}
        {p.state === 'list' && (
          <Box ref={listRef} id={p.id} role="listbox" aria-label={p.title || undefined} sx={{ maxHeight: maxList, overflowY: 'auto', pb: 0.5 }}>
            {sections(p.items).map((sec) => {
              const rows = sec.rows.map(({ it, i }) => {
              const on = i === p.active;
              if (it.note)
                // 묶음 안 상태 줄(읽는 중·빈·권한 없음, 스펙 2026-10-26-010 DC1·DC13). 할 일이 있으면(다시 시도) 고를 수 있다
                return (
                  <Box
                    key={`note-${i}`}
                    id={p.optionId(i)}
                    role="option"
                    aria-selected={on}
                    aria-disabled={!it.action || undefined}
                    onClick={() => it.action && p.onPick(it)}
                    onMouseMove={() => it.action && !on && p.onHover(i)}
                    sx={{
                      minHeight: ROW,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 1,
                      px: 1.5,
                      fontSize: chatType.meta,
                      color: tk.muted,
                      cursor: it.action ? 'pointer' : 'default',
                      borderLeft: '2px solid transparent',
                      ...(on ? { bgcolor: tk.selected, borderLeftColor: tk.selectedAccent } : {}),
                    }}
                  >
                    <Box sx={{ flex: 1, minWidth: 0 }}>{it.label}</Box>
                    {it.hint && <Box sx={{ flexShrink: 0 }}>{it.hint}</Box>}
                  </Box>
                );
              return (
                <Box
                  key={it.value}
                  id={p.optionId(i)}
                  role="option"
                  aria-selected={on}
                  aria-label={it.ariaLabel}
                  title={it.title ?? it.detail}
                  onClick={() => p.onPick(it)}
                  onMouseMove={() => !on && p.onHover(i)}
                  sx={{
                    minHeight: ROW,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    px: 1.5,
                    cursor: 'pointer',
                    borderLeft: '2px solid transparent',
                    ...(on ? { bgcolor: tk.selected, borderLeftColor: tk.selectedAccent } : { '&:hover': { bgcolor: tk.hover } }),
                  }}
                >
                  {it.dot && <Box aria-hidden sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: it.dot, flexShrink: 0 }} />}
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Box sx={{ fontSize: 13, fontWeight: 500, color: tk.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {it.label}
                    </Box>
                    {it.detail && (
                      <Box sx={{ fontSize: chatType.meta, color: tk.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {it.detail}
                      </Box>
                    )}
                  </Box>
                  {it.hint && (
                    <Box sx={{ fontSize: chatType.meta, color: tk.muted, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{it.hint}</Box>
                  )}
                </Box>
              );
              });
              if (!sec.group) return rows;
              // 묶음 머리줄(DC1): 「명령 · 10」, 목록을 내려도 붙어 있다
              const n = sec.rows.filter((r) => !r.it.note).length;
              const headId = `${p.id}-g-${sec.key}`;
              return (
                <Box key={headId} role="group" aria-labelledby={headId}>
                  <Box
                    id={headId}
                    sx={{ position: 'sticky', top: 0, zIndex: 1, px: 1.5, pt: 0.75, pb: 0.25, fontSize: chatType.meta, color: tk.muted, bgcolor: tk.popup.surface }}
                  >
                    {n ? t('chat.suggest.groupCount', { group: sec.group, count: n }) : sec.group}
                  </Box>
                  {rows}
                </Box>
              );
            })}
          </Box>
        )}
        {p.warning && (
          <Box
            role="note"
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.75,
              px: 1.5,
              py: 0.75,
              fontSize: chatType.meta,
              color: tk.text,
              bgcolor: tk.warnWash,
              borderTop: `1px solid ${tk.warnLine}`,
            }}
          >
            <WarningAmberOutlinedIcon sx={{ fontSize: 12, color: '#f59e0b' }} aria-hidden />
            <Box sx={{ flex: 1, minWidth: 0 }}>{p.warning}</Box>
            {p.onRetry && (
              <Button size="small" color="inherit" onClick={p.onRetry} sx={{ minWidth: 0, px: 0.75, py: 0 }}>
                {t('chat.suggest.retry')}
              </Button>
            )}
          </Box>
        )}
        {/* 마우스 화면만 키 안내(DD1). 손가락 화면은 숨긴다 */}
        <Box
          aria-hidden
          sx={{
            px: 1.5,
            py: 0.5,
            fontSize: chatType.meta,
            color: tk.muted,
            borderTop: `1px solid ${tk.line}`,
            '@media (pointer: coarse)': { display: 'none' },
          }}
        >
          {t('chat.suggest.keys')}
        </Box>
      </Box>
    </Popper>
  );
}
