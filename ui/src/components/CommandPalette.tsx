/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Dialog, List, ListItemButton, ListItemText, TextField, Typography } from '@mui/material';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { t } from '@/i18n';
import { Viewer, VIEWS, viewVisible } from '@/lib/views';

import { useUi } from './UiContext';

export interface PaletteItem {
  group: string;
  label: string;
  hint?: string;
  run: () => void;
}

// 화면 목록은 늘 들어간다. 에이전트는 extra 로 더한다(스킬·작업·자격증명 검색은 아직 없다).
export function CommandPalette({ extra = [], who = { admin: true } }: { extra?: PaletteItem[]; who?: Viewer }) {
  const { paletteOpen, closePalette } = useUi();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const items = useMemo<PaletteItem[]>(
    () => [
      ...VIEWS.filter((v) => viewVisible(v.id, who)).map((v) => ({
        group: t('palette.screens'),
        label: v.label,
        hint: `${v.group} · ${v.sub}`,
        run: () => navigate('/' + v.id),
      })),
      ...extra,
    ],
    [navigate, extra, who]
  );
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (
      needle ? items.filter((i) => (i.label + ' ' + (i.hint ?? '')).toLowerCase().includes(needle)) : items
    ).slice(0, 50);
  }, [items, q]);

  useEffect(() => {
    if (paletteOpen) {
      setQ('');
      setActive(0);
      const timer = window.setTimeout(() => inputRef.current?.focus(), 0); // 열리면 바로 칠 수 있게
      return () => window.clearTimeout(timer);
    }
  }, [paletteOpen]);
  useEffect(() => setActive(0), [q]);

  const pick = (i: PaletteItem | undefined) => {
    if (!i) return;
    closePalette();
    i.run();
  };

  return (
    <Dialog
      open={paletteOpen}
      onClose={closePalette}
      fullWidth
      maxWidth="sm"
      aria-label={t('palette.title')}
      slotProps={{ paper: { sx: { alignSelf: 'flex-start', mt: '12vh' } } }}
    >
      <TextField
        fullWidth
        inputRef={inputRef}
        type="search"
        placeholder={t('palette.placeholder')}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, shown.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            pick(shown[active]);
          }
        }}
        slotProps={{
          htmlInput: {
            role: 'combobox',
            'aria-label': t('palette.query'),
            'aria-controls': 'palette-list',
            'aria-expanded': true,
            'aria-activedescendant': shown[active] ? `palette-opt-${active}` : undefined,
            autoComplete: 'off',
          },
        }}
      />
      <List id="palette-list" role="listbox" aria-label={t('palette.results')} dense sx={{ maxHeight: '50vh', overflow: 'auto' }}>
        {shown.length === 0 && (
          <Box sx={{ p: 2 }}>
            <Typography variant="body2" color="text.secondary">
              {t('palette.none')}
            </Typography>
          </Box>
        )}
        {shown.map((it, i) => (
          <ListItemButton
            key={`${it.group}:${it.label}:${i}`}
            id={`palette-opt-${i}`}
            role="option"
            aria-selected={i === active}
            selected={i === active}
            onClick={() => pick(it)}
          >
            <ListItemText primary={it.label} secondary={it.hint} slotProps={{ secondary: { noWrap: true } }} />
            <Typography variant="caption" color="text.disabled" sx={{ ml: 2 }}>
              {it.group}
            </Typography>
          </ListItemButton>
        ))}
      </List>
      <Box sx={{ px: 2, py: 1, borderTop: 1, borderColor: 'divider' }}>
        <Typography variant="caption" color="text.secondary">
          {t('palette.footer')}
        </Typography>
      </Box>
    </Dialog>
  );
}
