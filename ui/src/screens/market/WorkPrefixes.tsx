/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 스킬 이름 접두어 → 업무(관리자 설정, 스펙 2026-11-17-003). 팀이 스킬 이름에 접두어를 붙이는 설치(sa- 영업, ma- 마케팅)는
// LLM 이 「하는 일」로 고른 업무 대신 팀 업무를 쓴다. 서버가 읽을 때 바꾸므로 저장하면 바로 보인다(다시 분류하지 않는다).
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  NativeSelect,
  Stack,
  TextField,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import { useId, useState } from 'react';

import { tagLabel, WORK_TAGS } from '@/components/TagBar';
import { tier1, tier2 } from '@/components/tierButton';
import { t } from '@/i18n';
import { post } from '@/lib/api';

export interface WorkPrefix {
  prefix: string;
  work: string;
}

const blank = (): WorkPrefix => ({ prefix: '', work: 'sales' });

/** 관리자 단추 + 편집 창. 저장하면 onSaved 로 목록을 다시 읽게 한다 */
export function WorkPrefixesButton({ rules, onSaved }: { rules: WorkPrefix[]; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<WorkPrefix[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const titleId = useId();
  const fullScreen = useMediaQuery(useTheme().breakpoints.down('sm'));
  const start = () => {
    setRows(rules.length ? rules.map((r) => ({ ...r })) : [blank()]);
    setError('');
    setOpen(true);
  };
  const set = (i: number, patch: Partial<WorkPrefix>) => setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await post('/api/market/work-prefixes', { rules: rows.filter((r) => r.prefix.trim()) });
      setOpen(false);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button size="small" variant="outlined" color="inherit" sx={tier2 as object} onClick={start}>
        {t('market.workPrefix.button')}
        {rules.length ? ` ${rules.length}` : ''}
      </Button>
      <Dialog open={open} onClose={busy ? undefined : () => setOpen(false)} aria-labelledby={titleId} fullWidth maxWidth="sm" fullScreen={fullScreen}>
        <DialogTitle id={titleId}>{t('market.workPrefix.title')}</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>{t('market.workPrefix.help')}</DialogContentText>
          <Stack spacing={1.25}>
            {rows.map((r, i) => (
              <Stack key={i} direction="row" spacing={1} alignItems="center">
                <TextField
                  size="small"
                  label={t('market.workPrefix.prefix')}
                  placeholder="sa-"
                  value={r.prefix}
                  onChange={(e) => set(i, { prefix: e.target.value })}
                  inputProps={{ maxLength: 24 }}
                  sx={{ flex: 1 }}
                />
                <NativeSelect
                  value={r.work}
                  onChange={(e) => set(i, { work: e.target.value })}
                  inputProps={{ 'aria-label': t('market.workPrefix.work') }}
                  sx={{ flex: 1, fontSize: 14 }}
                >
                  {WORK_TAGS.map((id) => (
                    <option key={id} value={id}>
                      {tagLabel(id)}
                    </option>
                  ))}
                </NativeSelect>
                <IconButton size="small" aria-label={t('market.workPrefix.remove')} onClick={() => setRows((rs) => rs.filter((_, k) => k !== i))}>
                  <DeleteOutlineIcon fontSize="small" />
                </IconButton>
              </Stack>
            ))}
            <div>
              <Button size="small" startIcon={<AddIcon />} color="inherit" onClick={() => setRows((rs) => [...rs, blank()])}>
                {t('market.workPrefix.add')}
              </Button>
            </div>
          </Stack>
          {error && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {error}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button variant="outlined" color="inherit" sx={tier2} onClick={() => setOpen(false)} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="outlined"
            color="inherit"
            sx={tier1}
            onClick={() => void save()}
            disabled={busy}
            startIcon={busy ? <CircularProgress size={14} color="inherit" /> : undefined}
          >
            {t('market.workPrefix.save')}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
