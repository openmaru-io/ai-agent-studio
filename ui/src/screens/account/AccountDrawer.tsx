/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 계정 메뉴의 「내 정보」 서랍(스펙 2026-10-14-017). 본인 정보는 읽기 전용이고, 비밀번호는 현재 비밀번호를 서버가 확인한 뒤 바꾼다.
// 비밀번호는 이 컴포넌트의 상태에만 두고 서랍을 닫으면 사라진다. 성공하면 입력칸을 비운다.
import { Alert, Box, Button, Link, Stack, TextField } from '@mui/material';
import { FormEvent, ReactNode, useRef, useState } from 'react';

import { AgentChips, podLabels } from '@/components/AgentChip';
import { KV, Section } from '@/components/bits';
import { tier1 } from '@/components/tierButton';
import { t } from '@/i18n';
import { ApiError, post } from '@/lib/api';
import { useMe } from '@/lib/data';

import { canSubmit, PasswordField, passwordProblems } from './logic';

type Result = { ok: true; others: number } | { ok: false; error: string; field?: PasswordField } | null;

const METHOD_LABEL: Record<string, string> = {
  keycloak: 'account.methodKeycloak',
  local: 'account.methodLocal',
  none: 'account.methodNone',
};

export function AccountDrawer() {
  const me = useMe().data;
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>(null);
  const currentRef = useRef<HTMLInputElement>(null);

  const account = me?.account;
  const problems = passwordProblems(cur, next, confirm);
  const role = me?.admin ? t('account.roleAdmin') : me?.owner ? t('account.roleOwner') : t('account.roleUser');
  const agents = me?.own_pods ?? [];

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !canSubmit(cur, next, confirm)) return;
    setBusy(true);
    setResult(null);
    try {
      const out = await post<{ other_sessions_ended?: number }>('/api/users/me/password', { current: cur, new: next });
      setCur('');
      setNext('');
      setConfirm('');
      setResult({ ok: true, others: out.other_sessions_ended ?? 0 });
    } catch (err) {
      const field = err instanceof ApiError && (err.field === 'current' || err.field === 'new') ? err.field : undefined;
      setResult({ ok: false, error: err instanceof Error ? err.message : String(err), field });
      if (field === 'current') {
        setCur('');
        requestAnimationFrame(() => currentRef.current?.focus());
      }
    } finally {
      setBusy(false);
    }
  }

  const failed = result && !result.ok ? result : null;
  const help = (f: PasswordField, base?: string) => {
    if (failed?.field === f) return failed.error;
    return problems[f] ? t(problems[f]!) : base;
  };

  return (
    <Box>
      <Section title={t('account.sectionAccount')}>
        <KV
          pairs={[
            [t('account.email'), me?.user?.email],
            [t('account.name'), me?.user?.name],
            [t('account.department'), me?.department || '—'],
            [t('account.role'), role],
            [t('account.agents'), agents.length ? <AgentChips key="a" names={agents} labels={podLabels(me?.pods)} /> : t('account.noAgents')],
            [t('account.method'), account ? t(METHOD_LABEL[account.method] ?? METHOD_LABEL.none) : undefined],
            // 「Claude Code 연결 n개 →」(스펙 2026-10-28-001 디자인 D4). 로그인을 끈 설치에는 없다
            ...(me?.connections
              ? [[t('account.connections'), <Link key="c" href="#/connections">{t('account.connectionsN', { n: me.connections.active })}</Link>] as [string, ReactNode]]
              : []),
          ]}
        />
      </Section>

      <Section title={t('account.sectionPassword')}>
        {account && !account.can_change_password ? (
          <Alert severity="info">{t('account.unsupported')}</Alert>
        ) : (
          <Stack spacing={1.5} component="form" noValidate onSubmit={(e) => void submit(e)} aria-busy={busy}>
            <TextField
              size="small"
              fullWidth
              type="password"
              label={t('account.current')}
              value={cur}
              disabled={busy}
              onChange={(e) => setCur(e.target.value)}
              error={failed?.field === 'current'}
              helperText={help('current')}
              inputRef={currentRef}
              slotProps={{ htmlInput: { autoComplete: 'current-password', 'data-field': 'current' } }}
            />
            <TextField
              size="small"
              fullWidth
              type="password"
              label={t('account.new')}
              value={next}
              disabled={busy}
              onChange={(e) => setNext(e.target.value)}
              error={!!problems.new || failed?.field === 'new'}
              helperText={help('new', t('account.newHelp'))}
              slotProps={{ htmlInput: { autoComplete: 'new-password', 'data-field': 'new' } }}
            />
            <TextField
              size="small"
              fullWidth
              type="password"
              label={t('account.confirm')}
              value={confirm}
              disabled={busy}
              onChange={(e) => setConfirm(e.target.value)}
              error={!!problems.confirm}
              helperText={help('confirm')}
              slotProps={{ htmlInput: { autoComplete: 'new-password', 'data-field': 'confirm' } }}
            />
            {failed && !failed.field && <Alert severity="error">{t('account.failed', { error: failed.error })}</Alert>}
            {result?.ok && (
              <Alert severity="success">
                {t('account.done')}
                {result.others > 0 && ' ' + t('account.doneOthers')}
              </Alert>
            )}
            <Box>
              <Button type="submit" variant="outlined" color="inherit" sx={tier1} disabled={busy || !canSubmit(cur, next, confirm)}>
                {busy ? t('account.submitting') : t('account.submit')}
              </Button>
            </Box>
          </Stack>
        )}
      </Section>
    </Box>
  );
}
