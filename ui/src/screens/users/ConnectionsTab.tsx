/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 사용자 관리 › 「Claude Code 연결」 탭(관리자, 스펙 2026-10-28-001 §3-7 ②, 디자인 D19).
// 모든 사람의 살아 있는 연결을 보고, 사유를 적어 강제로 끊는다. 사유는 그 사람의 받은편지함과 자기 연결 화면의 끝난 줄에 보인다.
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, Typography } from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useState } from 'react';

import { StatusPill } from '@/components/StatusPill';
import { tier2, tier3 } from '@/components/tierButton';
import { UserChip } from '@/components/UserChip';
import { t } from '@/i18n';
import { get, post } from '@/lib/api';
import { expiringSoon, TokenRow } from '@/lib/connections';
import { fmtTs } from '@/lib/format';
import { usePeople } from '@/lib/people';

export type AdminTokenRow = TokenRow & { email: string };

const at = (sec: number | null | undefined): string => (sec ? fmtTs(new Date(sec * 1000).toISOString()) : '—');

export const useAllConnections = (enabled: boolean) =>
  useQuery<{ tokens: AdminTokenRow[] }>({ queryKey: ['tokens', 'all'], queryFn: () => get('/api/tokens/all'), enabled, staleTime: 30_000 });

function RevokeDialog({ row, onClose }: { row: AdminTokenRow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const close = () => {
    setReason('');
    setError('');
    onClose();
  };
  const run = async () => {
    if (!row) return;
    setBusy(true);
    setError('');
    try {
      await post('/api/tokens/admin-revoke', { id: row.id, email: row.email, reason: reason.trim() });
      enqueueSnackbar(t('conn.adminRevoked', { name: row.name }), { variant: 'success' });
      await qc.invalidateQueries({ queryKey: ['tokens'] });
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!row} onClose={busy ? undefined : close} fullWidth maxWidth="xs" aria-labelledby="conn-admin-title">
      <DialogTitle id="conn-admin-title">{row ? t('conn.adminRevokeTitle', { email: row.email, name: row.name }) : ''}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ mb: 2 }}>
          {t('conn.adminRevokeLead')}
        </Typography>
        <TextField size="small" fullWidth label={t('conn.adminReason')} value={reason} onChange={(e) => setReason(e.target.value)} inputProps={{ maxLength: 200 }} />
        {error && (
          <Alert severity="error" sx={{ mt: 1 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button variant="outlined" color="inherit" sx={tier2} onClick={close} disabled={busy}>
          {t('conn.cancel')}
        </Button>
        <Button variant="outlined" color="inherit" sx={tier3} disabled={busy || reason.trim().length < 2} onClick={() => void run()}>
          {t('conn.adminRevoke')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function ConnectionsTab() {
  const q = useAllConnections(true);
  const [target, setTarget] = useState<AdminTokenRow | null>(null);
  const people = usePeople(true); // 누구의 연결인지 이메일 대신 이름 칩으로(이메일은 풍선말, 2026-10-30)
  if (q.error) return <Alert severity="error">{(q.error as Error).message}</Alert>;
  if (!q.data) return <Typography color="text.secondary">{t('common.loading')}</Typography>;
  const rows = (q.data.tokens ?? []).filter((r) => r.state === 'active');
  const now = Date.now() / 1000;
  return (
    <Box>
      {rows.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {t('conn.adminEmpty')}
        </Typography>
      ) : (
        rows.map((r) => (
          <Box
            key={r.id}
            data-testid={`conn-admin-${r.id}`}
            sx={{
              display: 'grid',
              gap: 1,
              alignItems: 'center',
              py: 1,
              borderBottom: 1,
              borderColor: 'divider',
              gridTemplateColumns: { xs: '1fr auto', sm: 'minmax(0,1.5fr) minmax(0,2fr) 1fr 1fr auto' },
            }}
          >
            <Box sx={{ minWidth: 0 }}>
              <UserChip name={people.find((p) => p.email.toLowerCase() === r.email.toLowerCase())?.name} email={r.email} />
            </Box>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
              <Typography variant="body2" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
                {r.name}
              </Typography>
              <StatusPill tone="neutral">{r.kind === 'oauth' ? t('conn.kindOauth') : t('conn.kindPat')}</StatusPill>
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ display: { xs: 'none', sm: 'block' } }}>
              {t('conn.lastUsed', { at: at(r.last_used) })}
            </Typography>
            <Typography variant="body2" sx={{ display: { xs: 'none', sm: 'block' }, color: expiringSoon(r, now) ? 'warning.main' : 'text.secondary' }}>
              {t('conn.expires', { at: at(r.expires) })}
            </Typography>
            <Button
              size="small"
              variant="outlined"
              color="inherit"
              sx={tier2}
              aria-label={t('conn.adminRevokeAria', { email: r.email, name: r.name })}
              onClick={() => setTarget(r)}
            >
              {t('conn.adminRevoke')}
            </Button>
          </Box>
        ))
      )}
      <RevokeDialog row={target} onClose={() => setTarget(null)} />
    </Box>
  );
}
