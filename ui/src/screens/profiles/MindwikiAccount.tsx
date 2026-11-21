/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * 「MindWiki 계정으로 연결」(스펙 2026-11-14-001 2단계). 카탈로그의 mindwiki 항목 아래에 둔다.
 * 위에서부터: 상태 줄(role=status) → 워크스페이스 고르기(여럿일 때) → 쓰기 허용 스위치 → [MindWiki 계정으로 연결] → 접힌 「개인 토큰 직접 붙여 넣기」.
 * 연결은 서버 뒤 작업이라 버튼은 곧바로 돌아오고, 부모(CatalogList)가 pending 동안 카탈로그를 다시 읽는다.
 * 3단계(스펙 2026-11-14-012 3-4): 상태 줄은 문구 하나만 보인다. 겹치면 순위 0(기한 지남) > 1(revoked) > 2(지금 적용 + 예전 키 기한)
 * > 3(지금 적용) > 4(자동 점검 실패) > 5(곧 만료) > 6(연결됨). 자동 첫 연결 뒤에는 닫을 때까지 남는 안내를 위에 둔다.
 */
import { Alert, Box, Button, FormControlLabel, MenuItem, Stack, Switch, TextField, Typography } from '@mui/material';
import { type ReactNode, useId, useState } from 'react';

import { DisclosureButton } from '@/components/DisclosureButton';
import { hasKey, t } from '@/i18n';

export interface MindwikiAccount {
  enabled: boolean;
  status: 'none' | 'pending' | 'connected' | 'soon' | 'failed' | 'expired' | 'revoked' | 'opted_out' | 'idle';
  reason?: string;
  /** need_workspace: 고를 워크스페이스, token_limit: AAS 가 만든 토큰 이름 */
  detail?: { id: string; name: string; slug: string }[] | string[] | null;
  write?: boolean;
  expires_at?: string;
  tool_count?: number;
  last_checked?: string;
  connected?: boolean;
  days?: number;
  write_days?: number;
  /** 3단계: 서버 뒤 작업이 키를 바꿨고 게이트웨이가 아직 새 키를 쓰지 않는다 */
  needs_apply?: boolean;
  prev_expires_at?: string;
  auto_reason?: string;
  next_check_at?: string;
  auto_connected?: boolean;
}

export interface AccountView {
  tone: 'info' | 'success' | 'warning' | 'error';
  text: string;
  button: string;
  busy: boolean;
  /** 보조 문구(지금 적용의 영향, 다음 자동 확인, 마지막 확인) */
  note?: string;
  /** 순위 0·2·3: 「지금 적용」을 권한다 */
  apply?: boolean;
  rank: number;
}

const day = (iso?: string) => (iso ?? '').slice(0, 10);

const SOON_MS = 14 * 86_400_000;
const hhmm = (iso?: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const past = (iso: string | undefined, now: number) => !!iso && Date.parse(iso) <= now;

/** 상태 → 상태 줄 하나와 버튼(스펙 2026-11-14-012 3-4 순위). now 는 시험이 고정한다 */
export function accountView(a: MindwikiAccount, now: number = Date.now()): AccountView {
  const scope = t(a.write ? 'profiles.mcp.mindwikiScopeWrite' : 'profiles.mcp.mindwikiScopeRead');
  const connected = t('profiles.mcp.mindwikiConnected', { scope, n: a.tool_count ?? 0, date: day(a.expires_at) });
  const reconnect = t('profiles.mcp.mindwikiReconnect');
  const checked = a.last_checked ? t('profiles.mcp.mindwikiLastChecked', { date: day(a.last_checked) }) : '';
  if (a.status === 'pending') return { tone: 'info', text: t('profiles.mcp.mindwikiConnecting'), button: t('profiles.mcp.mindwikiConnect'), busy: true, rank: -1 };
  const live = a.status === 'connected' || a.status === 'soon' || a.status === 'expired' || (a.status === 'failed' && !!a.connected);
  const applyNote = t('profiles.mcp.mindwikiApplyNote');
  // 0: 지금 토큰이 만료됐거나, 새 키를 아직 적용하지 않았는데 예전 키가 만료됐다 — 지금 MindWiki 도구가 동작하지 않는다
  if (live && (a.status === 'expired' || past(a.expires_at, now) || (a.needs_apply && past(a.prev_expires_at, now))))
    return { tone: 'error', text: t('profiles.mcp.mindwikiDown'), note: a.needs_apply ? t('profiles.mcp.mindwikiDownApply') : checked, button: reconnect, busy: false, apply: !!a.needs_apply, rank: 0 };
  if (a.status === 'revoked') return { tone: 'error', text: t('profiles.mcp.mindwikiRevoked'), button: t('profiles.mcp.mindwikiConnect'), busy: false, rank: 1 };
  if (live && a.needs_apply && a.prev_expires_at) {
    const left = Math.max(0, Math.ceil((Date.parse(a.prev_expires_at) - now) / 86_400_000));
    return { tone: 'warning', text: t('profiles.mcp.mindwikiApplyBy', { date: day(a.prev_expires_at), n: left }), note: applyNote, button: reconnect, busy: false, apply: true, rank: 2 };
  }
  if (live && a.needs_apply) return { tone: 'warning', text: t('profiles.mcp.mindwikiApplyNeeded'), note: applyNote, button: reconnect, busy: false, apply: true, rank: 3 };
  if (live && a.auto_reason) {
    const soon = a.expires_at && Date.parse(a.expires_at) - now <= SOON_MS ? ` ${t('profiles.mcp.mindwikiKeyExpires', { date: day(a.expires_at) })}` : '';
    const next = hhmm(a.next_check_at) ? t('profiles.mcp.mindwikiNextCheck', { time: hhmm(a.next_check_at) }) : '';
    return { tone: 'warning', text: autoReasonText(a.auto_reason), note: `${next}${soon}`.trim(), button: reconnect, busy: false, rank: 4 };
  }
  if (live && (a.status === 'soon' || (a.expires_at && Date.parse(a.expires_at) - now <= SOON_MS)))
    return { tone: 'warning', text: `${connected} · ${t('profiles.mcp.mindwikiSoon')}`, note: checked, button: reconnect, busy: false, rank: 5 };
  if (a.status === 'connected') return { tone: 'success', text: connected, note: checked, button: reconnect, busy: false, rank: 6 };
  if (a.status === 'failed')
    return { tone: 'warning', text: reasonText(a), button: t(a.connected ? 'profiles.mcp.mindwikiReconnect' : 'profiles.mcp.mindwikiConnect'), busy: false, rank: 7 };
  if (a.status === 'idle' && a.auto_reason) return { tone: 'info', text: autoReasonText(a.auto_reason), button: t('profiles.mcp.mindwikiConnect'), busy: false, rank: 7 };
  return { tone: 'info', text: '', button: t('profiles.mcp.mindwikiConnect'), busy: false, rank: 8 };
}

/** 자동 점검 이유 코드 → 한 줄. internal_error:<상관 id> 는 상관 id 를 붙인다. 모르는 코드는 기본 문구(OPERATIONS.md#mindwiki-auto-reason) */
export function autoReasonText(code: string): string {
  const [base, corr] = code.split(':');
  const key = `profiles.mcp.mindwikiAuto.${base}`;
  if (!hasKey(key)) return t('profiles.mcp.mindwikiAuto.unknown', { code: base });
  return corr ? `${t(key)} (${corr})` : t(key);
}

export function reasonText(a: Pick<MindwikiAccount, 'reason' | 'detail'>): string {
  const code = a.reason || 'internal';
  const base = t(`profiles.mcp.mindwikiReason.${code}`);
  if (code === 'token_limit' && Array.isArray(a.detail) && a.detail.length) return `${base} (${(a.detail as string[]).join(', ')})`;
  return base;
}

export function MindwikiAccountPanel({
  account,
  installed,
  busy,
  onConnect,
  paste,
  settingsUrl,
  onAck,
}: {
  account: MindwikiAccount;
  installed: boolean;
  busy: boolean;
  onConnect: (write: boolean, workspace: string) => void;
  /** 자동 첫 연결 안내의 「그대로 두기」 */
  onAck?: () => void;
  /** 1단계의 개인 토큰 칸(설치 전에만). 접어 둔다 */
  paste?: ReactNode;
  settingsUrl?: string;
}) {
  const view = accountView(account);
  const [write, setWrite] = useState(!!account.write);
  const [workspace, setWorkspace] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const pasteId = useId();
  const choices = account.reason === 'need_workspace' && Array.isArray(account.detail) ? (account.detail as { id: string; name: string; slug: string }[]) : [];
  const needChoice = choices.length > 0 && !workspace;
  return (
    <Stack spacing={1} sx={{ mt: 1 }}>
      {account.auto_connected && (
        <Alert
          severity="info"
          action={
            onAck && (
              <Button size="small" color="inherit" onClick={onAck} disabled={busy}>
                {t('profiles.mcp.mindwikiAutoKeep')}
              </Button>
            )
          }
        >
          {t('profiles.mcp.mindwikiAutoConnected')}
        </Alert>
      )}
      {view.text && (
        <Alert severity={view.tone} role="status" aria-live="polite" sx={{ py: 0 }}>
          {view.text}
          {view.note && (
            <Typography variant="caption" color="text.secondary" component="span" sx={{ display: 'block' }}>
              {view.note}
            </Typography>
          )}
        </Alert>
      )}
      {choices.length > 0 && (
        <TextField select size="small" fullWidth label={t('profiles.mcp.mindwikiWorkspace')} value={workspace} onChange={(ev) => setWorkspace(ev.target.value)}>
          {choices.map((w) => (
            <MenuItem key={w.id} value={w.slug || w.id}>
              {`${w.name} (${w.slug})`}
            </MenuItem>
          ))}
        </TextField>
      )}
      <FormControlLabel
        control={<Switch size="small" checked={write} disabled={busy || view.busy} onChange={(_, on) => setWrite(on)} slotProps={{ input: { role: 'switch' } }} />}
        label={t('profiles.mcp.mindwikiWriteAllow')}
      />
      <Typography variant="caption" color="text.secondary">
        {write
          ? t('profiles.mcp.mindwikiWriteRisk', { days: account.write_days ?? 30 })
          : t('profiles.mcp.mindwikiReadNote', { days: account.days ?? 90 })}
      </Typography>
      <Box>
        <Button
          variant="contained"
          size="small"
          disabled={busy || view.busy || needChoice}
          onClick={() => onConnect(write, workspace)}
          sx={{ width: { xs: '100%', sm: 'auto' } }}
        >
          {view.button}
        </Button>
      </Box>
      {settingsUrl && (
        <Typography variant="caption" color="text.secondary">
          {t('profiles.mcp.mindwikiSettingsNote')}{' '}
          <a href={settingsUrl} target="_blank" rel="noopener noreferrer">
            {settingsUrl}
          </a>
        </Typography>
      )}
      {!installed && paste && (
        <Box>
          <DisclosureButton open={pasteOpen} onToggle={() => setPasteOpen((o) => !o)} label={t('profiles.mcp.mindwikiPaste')} controls={pasteId} />
          {pasteOpen && <Box id={pasteId}>{paste}</Box>}
        </Box>
      )}
    </Stack>
  );
}
