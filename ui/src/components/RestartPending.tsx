/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 게이트웨이 다시 시작 필요(스펙 2026-11-18-016 4-5). MCP 서버·메신저·비밀값처럼 게이트웨이가 다시 떠야 읽히는 설정을 바꾸면
// 서버가 장부에 적고 /api/me 의 pod.restart_pending 으로 보낸다. 상단 막대 아이콘·프로파일 서랍 표시·MCP 탭·메신저 알림이 모두
// 같은 대화 상자(AppShell 에 하나)를 openRestartPending 으로 연다. 각 자리의 단추가 직접 다시 시작하지 않는다 — 쿠버네티스는
// 프로파일 하나를 다시 시작해도 루트가 다시 떠 다른 기록까지 반영되므로, 무엇이 함께 반영되는지 늘 이 대화 상자에서 보인다.
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import {
  Alert,
  Badge,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Link as MuiLink,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import { visuallyHidden } from '@mui/utils';
import { useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import { t } from '@/i18n';
import { ApiError, post } from '@/lib/api';
import { RestartItem, RestartKind, RestartPending, useMe } from '@/lib/data';
import { fmtTs, profileName } from '@/lib/format';

import { useConfirm } from './ConfirmDialog';

/** 경고 앰버(DESIGN.md §1-1). 상단 막대가 두 모드 모두 어두워 고정 값을 쓴다 */
export const RESTART_AMBER = '#f59e0b';
/** 「다시 시작하기」 전에 보이는 「다시 시도」의 상한(4-4) */
export const MAX_RETRIES = 2;

// ---- 여는 함수(입구 여럿, 대화 상자 하나) ---------------------------------------------------------------------------------

interface OpenState {
  open: boolean;
  focusProfile?: string;
}
let openState: OpenState = { open: false };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** 대화 상자를 연다. focusProfile 을 주면 그 프로파일 묶음을 맨 위에 두고 강조한다 */
export function openRestartPending(opts: { focusProfile?: string } = {}): void {
  openState = { open: true, focusProfile: opts.focusProfile };
  emit();
}
export function closeRestartPending(): void {
  openState = { open: false };
  emit();
}
const useOpenState = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => openState
  );

// ---- 자료와 문구 ---------------------------------------------------------------------------------------------------------

/** 지금 작업공간의 다시 시작 필요 기록. 다시 시작하는 중이면 없는 것으로 본다(그때는 기존 띠가 보인다) */
export function useRestartPending(): RestartPending | undefined {
  const pod = useMe().data?.pod;
  if (!pod || pod.restarting) return undefined;
  return pod.restart_pending;
}

/** 그 프로파일에 kinds 가운데 하나의 기록이 있는가 */
export function useProfileRestartPending(profile: string, kinds?: RestartKind[]): boolean {
  const rp = useRestartPending();
  return !!rp?.items.some((r) => r.profile === profile && (!kinds || kinds.includes(r.kind)));
}

/** 「바꾼 것」 문구(4-5 표) */
export function kindText(r: Pick<RestartItem, 'kind' | 'target' | 'note'>): string {
  switch (r.kind) {
    case 'mcp':
      return r.note ? t('restartPending.kind.mcpNote', { target: r.target, note: r.note }) : t('restartPending.kind.mcp', { target: r.target });
    case 'channel':
      return t('restartPending.kind.channel', { target: r.target });
    case 'pairing':
      return r.target && r.target !== '*' ? t('restartPending.kind.pairing', { target: r.target }) : t('restartPending.kind.pairingAny');
    case 'env':
      return t('restartPending.kind.env', { target: r.target });
    case 'config':
      return t('restartPending.kind.config', { target: r.target });
    case 'mindwiki':
      return t('restartPending.kind.mindwiki');
  }
}

/** 「바꾼 사람」: 사람 이름, AAS MCP 도구로 바꾼 것은 「이름 · MCP 도구」, 서버가 한 것은 「자동」 */
export function byText(r: Pick<RestartItem, 'by' | 'by_name' | 'by_kind'>): string {
  const name = r.by_name || r.by.split('@')[0] || '';
  if (r.by_kind === 'auto' || !name) return t('restartPending.by.auto');
  return r.by_kind === 'mcp_tool' ? t('restartPending.by.tool', { name }) : name;
}

/** 「3분 전」. at 은 에포크 초 */
export function agoText(at: number, now = Date.now()): string {
  if (!at) return '—';
  const min = Math.floor((now / 1000 - at) / 60);
  if (min < 1) return t('restartPending.ago.now');
  if (min < 60) return t('restartPending.ago.min', { n: min });
  const h = Math.floor(min / 60);
  return h < 24 ? t('restartPending.ago.hour', { n: h }) : t('restartPending.ago.day', { n: Math.floor(h / 24) });
}

const rowKey = (r: Pick<RestartItem, 'profile' | 'kind' | 'target'>) => `${r.profile}\u0000${r.kind}\u0000${r.target}`;

// ---- 상단 막대 아이콘 --------------------------------------------------------------------------------------------------

export function RestartPendingButton() {
  const rp = useRestartPending();
  const total = rp?.total ?? 0;
  const tip = t('restartPending.tip', { count: total });
  return (
    <>
      {/* 아이콘이 처음 나타날 때 한 번 알린다. 알림 자리는 늘 있어야 바뀐 글이 읽힌다 */}
      <Box component="span" aria-live="polite" data-testid="restart-pending-live" sx={visuallyHidden}>
        {total > 0 ? tip : ''}
      </Box>
      {total > 0 && (
        <Tooltip title={tip}>
          <IconButton aria-label={tip} onClick={() => openRestartPending()} sx={{ color: 'inherit', flexShrink: 0 }} data-testid="restart-pending-button">
            <Badge
              badgeContent={total}
              max={99}
              sx={{ '& .MuiBadge-badge': { bgcolor: RESTART_AMBER, color: '#111', fontWeight: 600, fontSize: 11, minWidth: 16, height: 16, px: 0.5 } }}
            >
              <RestartAltIcon fontSize="inherit" />
            </Badge>
          </IconButton>
        </Tooltip>
      )}
    </>
  );
}

// ---- 프로파일 서랍 머리의 표시 -------------------------------------------------------------------------------------------

/** 「게이트웨이 실행 중」 옆의 「다시 시작 필요」 알약. 단추 역할이며 대화 상자를 그 프로파일에 맞춰 연다 */
export function RestartPendingPill({ profile }: { profile: string }) {
  const has = useProfileRestartPending(profile);
  if (!has) return null;
  return (
    <Box
      component="button"
      type="button"
      onClick={() => openRestartPending({ focusProfile: profile })}
      sx={{
        font: 'inherit',
        fontSize: 12,
        lineHeight: '18px',
        px: 1,
        borderRadius: 999,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        color: 'warning.main',
        bgcolor: 'rgba(245,158,11,0.15)',
        border: '1px solid rgba(245,158,11,0.25)',
        '&:hover': { bgcolor: 'rgba(245,158,11,0.25)' },
        '&:focus-visible': { outline: `2px solid ${RESTART_AMBER}`, outlineOffset: 1 },
      }}
    >
      {t('restartPending.pill')}
    </Box>
  );
}

// ---- 대화 상자 ---------------------------------------------------------------------------------------------------------

interface Failure {
  profile: string;
  reason: string;
  error: string;
}

export function RestartPendingDialog() {
  const { open, focusProfile } = useOpenState();
  const me = useMe().data;
  const pod = me?.pod;
  const rp = pod?.restart_pending;
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { enqueueSnackbar } = useSnackbar();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<Failure[]>([]);
  const [info, setInfo] = useState('');
  const [retries, setRetries] = useState(0);
  const [since, setSince] = useState<number | undefined>();
  const done = useRef(false); // 성공으로 닫는 중 — 0건이 되어 닫는 알림과 겹치지 않게
  const seen = useRef(false); // 열린 뒤 기록을 한 번이라도 보았다
  const focusNow = useCallback((node: HTMLButtonElement | null) => node?.focus(), []);

  useEffect(() => {
    if (!open) return;
    setFailed([]);
    setInfo('');
    setRetries(0);
    setSince(undefined);
    done.current = false;
    seen.current = false;
  }, [open]);

  const total = rp?.total ?? 0;
  useEffect(() => {
    if (!open) return;
    if (total > 0) seen.current = true;
    // 열려 있는 동안 기록이 모두 사라졌다(바깥 다시 시작·다른 탭) — 닫고 알린다. 실패 줄이 있으면 남긴다
    else if (seen.current && !busy && !done.current && !failed.length) {
      closeRestartPending();
      enqueueSnackbar(t('restartPending.allApplied'), { variant: 'success' });
    }
  }, [open, total, busy, failed.length, enqueueSnackbar]);

  const reread = () => void qc.invalidateQueries({ queryKey: ['me'] });
  const close = () => {
    if (!busy) closeRestartPending();
  };

  const restart = async () => {
    if (!pod) return;
    setBusy(true);
    setInfo('');
    try {
      await post('/api/restart-pending/apply', { pod: pod.id, ...(since ? { since } : {}) });
      done.current = true;
      closeRestartPending();
      enqueueSnackbar(t('restartPending.requested'), { variant: 'success' });
      reread();
      // 게이트웨이가 다시 뜨는 동안 「다시 시작하는 중」 띠가 이어서 보이게 두 번 더 읽는다(ToolsPane 과 같은 간격)
      for (const ms of [4000, 12000]) window.setTimeout(reread, ms);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.reason === 'restart_locked') {
        setInfo(t('restartPending.locked', { n: Number(e.data.retry_after) || 30 }));
      } else if (e instanceof ApiError && e.status === 409) {
        setInfo(t('restartPending.inProgress'));
      } else if (e instanceof ApiError && Array.isArray(e.data.failed)) {
        const f = e.data.failed as Failure[];
        setFailed(f);
        setRetries((n) => n + 1);
        if (f.some((x) => x.reason === 'outcome_unknown') && typeof e.data.asked_at === 'number') setSince(e.data.asked_at);
      } else {
        setFailed([{ profile: '', reason: 'error', error: (e as Error).message }]);
        setRetries((n) => n + 1);
      }
      reread();
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async (r: RestartItem) => {
    if (!pod) return;
    if (r.kind === 'mindwiki' && !(await confirm(t('restartPending.dismissMindwiki')))) return;
    try {
      await post('/api/restart-pending/dismiss', { pod: pod.id, profile: r.profile, kind: r.kind, target: r.target });
      setFailed((f) => f.filter((x) => x.profile !== r.profile));
      reread();
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
    }
  };

  const items = rp?.items ?? [];
  const failedProfiles = new Set(failed.map((f) => f.profile));
  const profiles = [...new Set(items.map((r) => r.profile))].sort((a, b) => (a === focusProfile ? -1 : b === focusProfile ? 1 : 0));
  const grouped = profiles.length > 1;
  const exhausted = failed.length > 0 && retries > MAX_RETRIES;
  const firstFailed = failed.find((f) => f.profile)?.profile;

  const rows = (list: RestartItem[]) =>
    list.map((r) => (
      <TableRow key={rowKey(r)} data-testid="restart-pending-row">
        <TableCell sx={{ wordBreak: 'break-word' }}>
          {kindText(r)}
          {failedProfiles.has(r.profile) && (
            <Typography component="span" variant="caption" color="error" sx={{ ml: 1 }}>
              {t('restartPending.failedRow')}
            </Typography>
          )}
        </TableCell>
        <TableCell>{byText(r)}</TableCell>
        <TableCell>
          <Tooltip title={r.at ? fmtTs(new Date(r.at * 1000).toISOString()) : ''}>
            <span>{agoText(r.at)}</span>
          </Tooltip>
        </TableCell>
        <TableCell align="right">
          <Button size="small" disabled={busy} onClick={() => void dismiss(r)}>
            {t('restartPending.dismiss')}
          </Button>
        </TableCell>
      </TableRow>
    ));

  return (
    <Dialog open={open && !!pod} onClose={close} maxWidth="md" fullWidth aria-labelledby="restart-pending-title">
      <DialogTitle id="restart-pending-title">{t('restartPending.title')}</DialogTitle>
      <DialogContent>
        {failed.length > 0 && (
          <Alert severity="error" sx={{ mb: 1.5 }}>
            {t('restartPending.failed', {
              list: failed.map((f) => (f.profile ? `${profileName(f.profile)} — ${f.error}` : f.error)).join(' · '),
            })}
            {exhausted && (
              <Box sx={{ mt: 0.5 }}>
                {t('restartPending.checkGateway')}{' '}
                {firstFailed && (
                  <MuiLink component={RouterLink} to={`/profiles?name=${encodeURIComponent(firstFailed)}`} onClick={() => closeRestartPending()}>
                    {t('restartPending.openProfile')}
                  </MuiLink>
                )}
              </Box>
            )}
          </Alert>
        )}
        {info && (
          <Alert severity="info" sx={{ mb: 1.5 }}>
            {info}
          </Alert>
        )}
        <Typography sx={{ mb: 1 }}>{t('restartPending.summary', { count: total })}</Typography>
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('restartPending.col.what')}</TableCell>
                <TableCell>{t('restartPending.col.by')}</TableCell>
                <TableCell>{t('restartPending.col.at')}</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            {grouped ? (
              profiles.map((p) => (
                <TableBody
                  key={p}
                  data-testid={`restart-pending-group-${p}`}
                  sx={p === focusProfile ? { outline: `2px solid ${RESTART_AMBER}`, outlineOffset: -2 } : undefined}
                >
                  <TableRow>
                    <TableCell colSpan={4} sx={{ fontWeight: 600, bgcolor: 'action.hover' }}>
                      {profileName(p)}
                    </TableCell>
                  </TableRow>
                  {rows(items.filter((r) => r.profile === p))}
                </TableBody>
              ))
            ) : (
              <TableBody>{rows(items)}</TableBody>
            )}
          </Table>
        </Box>
        {total > items.length && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            {t('restartPending.more', { n: total - items.length })}
          </Typography>
        )}
        <Alert severity="warning" sx={{ mt: 2 }}>
          {rp?.shared_gateway ? t('restartPending.warnK8s') : t('restartPending.warn')}
          {rp?.has_members && <Box sx={{ mt: 0.5 }}>{t('restartPending.warnShared')}</Box>}
        </Alert>
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1, px: 3 }}>
        {/* 초점은 「나중에」에서 시작한다 — 엔터를 잘못 눌러 다시 시작하지 않게(4-5). ConfirmDialog 와 같은 ref 방식 */}
        <Button onClick={close} disabled={busy} ref={focusNow}>
          {t('restartPending.later')}
        </Button>
        {!exhausted && (
          <Button
            variant="contained"
            onClick={() => void restart()}
            disabled={busy || total === 0}
            startIcon={busy ? <CircularProgress size={16} color="inherit" /> : <RestartAltIcon />}
          >
            {failed.length ? t('restartPending.retry') : t('restartPending.now')}
          </Button>
        )}
      </DialogActions>
      <Typography variant="caption" color="text.secondary" component="p" sx={{ px: 3, pb: 2 }}>
        {t('restartPending.outside')}
      </Typography>
    </Dialog>
  );
}

/** 저장 응답의 restart_pending 이 "unrecorded" 면(기록 실패) 그 자리에 띄울 문구. 아니면 빈 값 */
export const unrecordedNote = (res: unknown): string =>
  res && typeof res === 'object' && (res as { restart_pending?: unknown }).restart_pending === 'unrecorded' ? t('restartPending.unrecorded') : '';
