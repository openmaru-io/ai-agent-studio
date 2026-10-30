/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 막힌 자리의 「관리자에게 요청」 단추(스펙 2026-10-15-011 단계 5). 요청을 AAS 에 기록하고 관리자의 받은편지함에서 처리한다.
// 같은 (프로파일, 종류)의 요청이 처리를 기다리면 단추 대신 「처리 대기 중(N일)」을 보인다.
import SendOutlinedIcon from '@mui/icons-material/SendOutlined';
import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, Typography } from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useState } from 'react';

import { t } from '@/i18n';
import { get, post } from '@/lib/api';

export type RequestKind = 'model_change' | 'profile_limit' | 'office_seat' | 'archive_restore' | 'channel_apply' | 'other';
export const DETAIL_MAX = 300;

interface Waiting {
  profile: string;
  kind: RequestKind;
  waiting_days: number;
}

/** detail: 요청 창을 열 때 미리 채울 내용(예: 막힌 MCP 주소와 이유). 사용자가 고쳐 보낼 수 있다 */
export function RequestAdminButton({ profile, kind, label, detail: initial = '' }: { profile: string; kind: RequestKind; label?: string; detail?: string }) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const waiting = useQuery<{ waiting: Waiting[] }>({ queryKey: ['admin-requests'], queryFn: () => get<{ waiting: Waiting[] }>('/api/requests'), retry: false });
  const mine = waiting.data?.waiting.find((w) => w.profile === profile && w.kind === kind);
  if (mine) {
    return (
      <Typography variant="body2" color="text.secondary">
        {t('requests.waiting', { days: mine.waiting_days })}
      </Typography>
    );
  }
  const send = async () => {
    setBusy(true);
    setError('');
    try {
      await post('/api/requests', { profile, kind, detail: detail.trim() });
      enqueueSnackbar(t('requests.sent'), { variant: 'success' });
      setOpen(false);
      setDetail('');
      await qc.invalidateQueries({ queryKey: ['admin-requests'] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button
        size="small"
        variant="outlined"
        onClick={() => {
          if (initial && !detail) setDetail(initial.slice(0, DETAIL_MAX));
          setOpen(true);
        }}
      >
        {label ?? t('requests.ask')}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="xs" fullWidth aria-labelledby="request-title">
        <DialogTitle id="request-title">{t(`requests.title.${kind}`)}</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ pt: 1 }}>
            <Typography variant="body2" color="text.secondary">
              {t('requests.note')}
            </Typography>
            <TextField
              size="small"
              multiline
              minRows={3}
              label={t('requests.detail')}
              value={detail}
              onChange={(e) => setDetail(e.target.value.slice(0, DETAIL_MAX))}
              helperText={`${detail.length}/${DETAIL_MAX}`}
            />
            {error && (
              <Typography variant="body2" role="alert" sx={{ borderLeft: '3px solid', borderColor: 'error.main', pl: 1 }}>
                {error}
              </Typography>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
          <Button startIcon={<SendOutlinedIcon />} variant="contained" disabled={busy} onClick={() => void send()}>
            {t('requests.send')}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
