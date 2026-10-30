/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 부서 슬로건 AI 추천(스펙 2026-10-17-015). 창을 열면 부서 이름으로 바로 3개를 받고, 키워드를 적으면 그것으로 다시 받는다.
// 고른 후보는 onPick 으로 넘긴다 — 설정 화면은 입력 칸에 넣고(저장은 사람이 누른다), 부서 상세 창은 바로 저장한다(pickLabel 로 단추 글을 바꾼다).
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Stack,
  TextField,
  Tooltip,
} from '@mui/material';
import { useEffect, useRef, useState } from 'react';

import { t } from '@/i18n';
import { post } from '@/lib/api';

export function SloganSuggestDialog({
  open,
  team,
  onClose,
  onPick,
  pickLabel,
}: {
  open: boolean;
  team: string;
  onClose: () => void;
  onPick: (slogan: string) => void | Promise<void>;
  pickLabel?: string;
}) {
  const [keywords, setKeywords] = useState('');
  const [items, setItems] = useState<string[]>([]);
  const [chosen, setChosen] = useState('');
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');
  const asked = useRef(0);

  const ask = async (kw: string) => {
    const id = ++asked.current;
    setBusy(true);
    setError('');
    try {
      const out = await post<{ suggestions: string[] }>('/api/settings/goal/suggest', { team, keywords: kw.trim() });
      if (id !== asked.current) return;
      setItems(out.suggestions);
      setChosen(out.suggestions[0] ?? '');
    } catch (e) {
      if (id === asked.current) setError((e as Error).message);
    } finally {
      if (id === asked.current) setBusy(false);
    }
  };

  // 열 때마다 처음부터: 키워드 없이 부서 이름으로 받는다. 닫으면 늦게 온 답은 버린다
  useEffect(() => {
    if (!open) {
      asked.current++;
      return;
    }
    setKeywords('');
    setItems([]);
    setChosen('');
    void ask('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, team]);

  const pick = async () => {
    if (!chosen) return;
    setPicking(true);
    try {
      await onPick(chosen);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPicking(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="slogan-suggest-title">
      <DialogTitle id="slogan-suggest-title">{t('settings.sloganTitle', { team })}</DialogTitle>
      <DialogContent>
        <Stack direction="row" spacing={1} alignItems="flex-start" sx={{ mt: 1 }}>
          <TextField
            size="small"
            fullWidth
            label={t('settings.sloganKeywords')}
            placeholder={t('settings.sloganKeywordsPlaceholder')}
            helperText={t('settings.sloganKeywordsHelp')}
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy) void ask(keywords);
            }}
            slotProps={{ htmlInput: { maxLength: 100 } }}
          />
          <Button variant="outlined" onClick={() => void ask(keywords)} disabled={busy} sx={{ flexShrink: 0, mt: '1px' }}>
            {t('settings.sloganAsk')}
          </Button>
        </Stack>
        <Box sx={{ mt: 2, minHeight: 156 }} aria-live="polite" aria-busy={busy}>
          {busy ? (
            <Stack direction="row" spacing={1} alignItems="center" sx={{ color: 'text.secondary', py: 2 }}>
              <CircularProgress size={16} />
              <span>{t('settings.sloganLoading')}</span>
            </Stack>
          ) : error ? (
            <Alert severity="error">{error}</Alert>
          ) : (
            <List disablePadding role="listbox" aria-label={t('settings.sloganList')}>
              {items.map((s) => (
                <ListItemButton
                  key={s}
                  role="option"
                  aria-selected={s === chosen}
                  selected={s === chosen}
                  onClick={() => setChosen(s)}
                  sx={{ borderRadius: 1, mb: 0.5, border: 1, borderColor: s === chosen ? 'primary.main' : 'divider' }}
                >
                  <ListItemText primary={s} secondary={t('settings.sloganLength', { count: s.length })} />
                </ListItemButton>
              ))}
            </List>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="contained" onClick={() => void pick()} disabled={!chosen || busy || picking}>
          {pickLabel ?? t('settings.sloganUse')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** 입력 칸 옆의 AI 추천 단추. 누르면 추천 창을 연다 */
export function SloganSuggestButton({
  team,
  onPick,
  disabled,
  pickLabel,
}: {
  team: string;
  onPick: (slogan: string) => void | Promise<void>;
  disabled?: boolean;
  pickLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  // 한 화면에 부서마다 단추가 있으므로 이름에 부서를 넣어 구분한다
  const label = team ? t('settings.sloganButtonFor', { team }) : t('settings.sloganButton');
  return (
    <>
      {/* describeChild: 감싸는 span 이 아니라 단추가 이름을 갖게 한다(꺼진 단추는 툴팁을 받으려고 span 으로 감싼다) */}
      <Tooltip title={disabled ? t('settings.sloganNeedTeam') : label} describeChild>
        <span>
          <IconButton aria-label={label} onClick={() => setOpen(true)} disabled={disabled} size="small" sx={{ mt: '4px' }}>
            <AutoAwesomeOutlinedIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <SloganSuggestDialog open={open} team={team} onClose={() => setOpen(false)} onPick={onPick} pickLabel={pickLabel} />
    </>
  );
}
