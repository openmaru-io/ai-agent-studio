/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 설정 › AI 에이전트 작업공간 공유(관리자, 스펙 2026-11-17-008 §3-6). 설치 전체 「소유자 공유 허용」 스위치와 공유 현황(CSV 내려받기).
// 끄면 소유자의 공유 구역이 숨고 구성원 권한이 사라진다(구성원 행은 남는다). 관리자가 준 보기(사용자 화면)는 그대로다.
import { Alert, Box, Button, FormControlLabel, Switch, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useState } from 'react';

import { Section } from '@/components/bits';
import { useConfirm } from '@/components/ConfirmDialog';
import { t } from '@/i18n';
import { apiUrl, get, post } from '@/lib/api';

interface ShareRow {
  pod: string;
  owner_name: string;
  email: string;
  name: string;
  department: string;
  role: 'use' | 'edit';
  source: 'owner' | 'admin';
  ts: string;
}

export function SharingSettings() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { enqueueSnackbar } = useSnackbar();
  const q = useQuery<{ enabled: boolean; rows: ShareRow[]; notify?: { installed: boolean; enabled: boolean } }>({
    queryKey: ['admin-sharing'],
    queryFn: () => get('/api/admin/sharing'),
  });
  const toggleNotify = async (on: boolean) => {
    setBusy(true);
    try {
      await post('/api/settings/sharing', { notify: on });
      await qc.invalidateQueries({ queryKey: ['admin-sharing'] });
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const [busy, setBusy] = useState(false);
  const d = q.data;
  const toggle = async (on: boolean) => {
    if (!on && !(await confirm(t('settings.sharing.offConfirm'), { title: t('settings.sharing.offTitle'), confirmLabel: t('settings.sharing.offOk') })))
      return;
    setBusy(true);
    try {
      await post('/api/settings/sharing', { enabled: on });
      await qc.invalidateQueries({ queryKey: ['admin-sharing'] });
      await qc.invalidateQueries({ queryKey: ['settings'] });
      enqueueSnackbar(t(on ? 'settings.sharing.turnedOn' : 'settings.sharing.turnedOff'), { variant: 'success' });
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={t('settings.sharing.title')} indent>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        {t('settings.sharing.help')}
      </Typography>
      {q.error ? (
        <Alert severity="error">{(q.error as Error).message}</Alert>
      ) : !d ? null : (
        <>
          <FormControlLabel
            control={<Switch checked={d.enabled} disabled={busy} onChange={(e) => void toggle(e.target.checked)} />}
            label={t('settings.sharing.switch')}
          />
          {/* 메신저 알림 전달(스펙 2026-11-17-008 §6-2): 설치에서 웹훅 길(차트 값)을 열었을 때만 고를 수 있다 */}
          <FormControlLabel
            control={<Switch checked={!!d.notify?.installed && !!d.notify?.enabled} disabled={busy || !d.notify?.installed} onChange={(e) => void toggleNotify(e.target.checked)} />}
            label={t('settings.sharing.notify')}
          />
          {!d.notify?.installed && (
            <Typography variant="caption" color="text.secondary" component="p">
              {t('settings.sharing.notifyNotInstalled')}
            </Typography>
          )}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 2, mb: 1 }}>
            <Typography variant="body2" component="h4" sx={{ fontWeight: 600, m: 0 }}>
              {t('settings.sharing.overview', { n: d.rows.length })}
            </Typography>
            {d.rows.length > 0 && (
              <Button size="small" variant="outlined" color="inherit" href={apiUrl('/api/admin/sharing?format=csv')} sx={{ ml: 'auto' }}>
                {t('settings.sharing.csv')}
              </Button>
            )}
          </Box>
          {d.rows.length === 0 ? (
            <Typography variant="body2">{t('settings.sharing.none')}</Typography>
          ) : (
            <Box sx={{ overflowX: 'auto' }}>
              <Table size="small" aria-label={t('settings.sharing.overviewLabel')}>
                <TableHead>
                  <TableRow>
                    <TableCell>{t('settings.sharing.colWorkspace')}</TableCell>
                    <TableCell>{t('settings.sharing.colMember')}</TableCell>
                    <TableCell>{t('settings.sharing.colRole')}</TableCell>
                    <TableCell>{t('settings.sharing.colSource')}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {d.rows.map((r) => (
                    <TableRow key={`${r.pod}:${r.email}:${r.source}`}>
                      <TableCell>
                        {r.owner_name ? `${r.owner_name} · ` : ''}
                        {r.pod}
                      </TableCell>
                      <TableCell title={r.email}>
                        {r.name}
                        {r.department ? ` (${r.department})` : ''}
                      </TableCell>
                      <TableCell>{t(r.role === 'edit' ? 'agents.share.roleEdit' : 'agents.share.roleUse')}</TableCell>
                      <TableCell>{t(r.source === 'admin' ? 'agents.share.byAdmin' : 'settings.sharing.byOwner')}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Box>
          )}
        </>
      )}
    </Section>
  );
}
