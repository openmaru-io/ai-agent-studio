/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 막힌 자리의 「관리자에게 요청」 단추(스펙 2026-10-15-011 단계 5). 요청을 AAS 에 기록하고 관리자의 받은편지함에서 처리한다.
// 같은 (프로파일, 종류)의 요청이 처리를 기다리면 단추 대신 「처리 대기 중(N일)」을 보인다.
import SendOutlinedIcon from '@mui/icons-material/SendOutlined';
import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, SxProps, TextField, Theme, Typography } from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useState } from 'react';

import { t } from '@/i18n';
import { ApiError, get, post } from '@/lib/api';

export type RequestKind = 'model_change' | 'profile_limit' | 'office_seat' | 'archive_restore' | 'channel_apply' | 'workspace_size' | 'other';
/** 서버 aas/ops/admin_requests.py KINDS 와 같아야 한다(시험이 맞춰 본다) */
export const REQUEST_KINDS: readonly RequestKind[] = ['model_change', 'profile_limit', 'office_seat', 'archive_restore', 'channel_apply', 'workspace_size', 'other'];
export const DETAIL_MAX = 300;

interface Waiting {
  profile: string;
  kind: RequestKind;
  waiting_days: number;
}

/** detail: 요청 창을 열 때 미리 채울 내용(예: 막힌 MCP 주소와 이유). 사용자가 고쳐 보낼 수 있다 */
/** pod: 목록 줄처럼 지금 고른 에이전트가 아닌 작업공간을 가리킬 때(스펙 2026-11-06-005 D6). 없으면 쿠키로 고른 작업공간.
 *  ariaLabel: 같은 이름의 단추가 여러 줄에 있을 때 읽기 프로그램용 이름(D20) */
/** sx: 놓인 줄의 다른 단추와 모양을 맞출 때(채팅 줄의 tier2·44px, 스펙 2026-11-07-001 디자인 5A) */
export function RequestAdminButton({ profile, kind, label, detail: initial = '', pod, ariaLabel, sx, color }: { profile: string; kind: RequestKind; label?: string; detail?: string; pod?: string; ariaLabel?: string; sx?: SxProps<Theme>; color?: 'inherit' | 'primary' }) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const waiting = useQuery<{ waiting: Waiting[] }>({
    queryKey: pod ? ['admin-requests', pod] : ['admin-requests'],
    queryFn: () => get<{ waiting: Waiting[] }>(pod ? `/api/requests?pod=${encodeURIComponent(pod)}` : '/api/requests'),
    retry: false,
  });
  const mine = waiting.data?.waiting.find((w) => w.profile === profile && w.kind === kind);
  if (mine) {
    return (
      <Typography variant="body2" color="text.secondary">
        {mine.waiting_days > 0 ? t('requests.waiting', { days: mine.waiting_days }) : t('requests.waitingToday')}
      </Typography>
    );
  }
  const send = async () => {
    setBusy(true);
    setError('');
    try {
      await post('/api/requests', { profile, kind, detail: detail.trim(), ...(pod ? { pod } : {}) });
      enqueueSnackbar(t('requests.sent'), { variant: 'success' });
      setOpen(false);
      setDetail('');
      await qc.invalidateQueries({ queryKey: ['admin-requests'] });
    } catch (e) {
      // 이미 같은 요청이 대기 중(409): 오류 대신 대기 표시로 바꾼다(D7). 대기 여부를 못 읽었던 경우다
      if (e instanceof ApiError && e.status === 409) {
        setOpen(false);
        await qc.invalidateQueries({ queryKey: ['admin-requests'] });
        return;
      }
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
        color={color}
        sx={sx}
        aria-label={ariaLabel}
        disabled={waiting.isLoading}
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
            {kind === 'workspace_size' && (
              // 처리되면 크기 롤아웃으로 작업공간이 한 번 다시 시작된다(D13)
              <Typography variant="body2" color="text.secondary">
                {t('requests.sizeRestartNote')}
              </Typography>
            )}
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
