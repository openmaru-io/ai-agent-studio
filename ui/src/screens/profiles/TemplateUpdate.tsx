/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 템플릿 새 판으로 올리기 창(스펙 2026-11-18-002 「템플릿 새 판」). 프로파일 상세의 「새 판 있음」에서 연다.
// MCP 차이(더함·바뀜·남겨 둠)와 새로 필요한 KEY 칸을 보이고, 명령 실행 MCP 는 동의를 받는다.
// 올리기는 기존 설치 요청(mode=update)이고, 끝나면 서버가 MCP 더함·바뀜만 합친다(없어진 것은 지우지 않는다). 새 KEY 는 화면이 env_set 한다.

import { Alert, Box, Button, Checkbox, CircularProgress, FormControlLabel, Stack, Typography } from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { t } from '@/i18n';
import { ApiError, get, post } from '@/lib/api';
import { MONO_FONT } from '@/lib/monoFont';

import { SecretField } from './McpServers';
import {
  consentReady,
  consentsOf,
  keyGroups,
  keysReady,
  phaseOf,
  POLL_MS,
  type RequestRow,
  type TemplateEnv,
  type TemplateMcp,
  timedOut,
} from './templateInstallState';

interface Diff {
  profile: string;
  namespace: string;
  name: string;
  from: string;
  to: string;
  added: TemplateMcp[];
  changed: TemplateMcp[];
  kept: string[];
  new_keys: TemplateEnv[];
  stdio: TemplateMcp[];
  hub_skills: { name?: string; version?: string }[];
}

function McpRow({ m, tag }: { m: TemplateMcp; tag: string }) {
  return (
    <Box component="li" sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1 }}>
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {tag} · {m.name}
      </Typography>
      <Typography variant="body2" sx={{ fontFamily: MONO_FONT, fontSize: 12, wordBreak: 'break-all' }}>
        {m.stdio ? [m.command, ...(m.args ?? [])].join(' ') : m.url}
      </Typography>
    </Box>
  );
}

export function TemplateUpdate({ profile }: { profile: string }) {
  const qc = useQueryClient();
  const diff = useQuery<Diff>({ queryKey: ['template-diff', profile], queryFn: () => get(`/api/market/template/diff?profile=${encodeURIComponent(profile)}`), retry: false });
  const d = diff.data;
  const [agreed, setAgreed] = useState<Record<string, boolean>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [later, setLater] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [request, setRequest] = useState<RequestRow | null>(null);
  const [outcome, setOutcome] = useState<'' | 'done' | 'failed' | 'timeout'>('');
  const started = useRef(0);
  const groups = d ? keyGroups({ env_requires: d.new_keys, mcp: [...d.added, ...d.changed] }) : [];

  const start = async () => {
    if (!d) return;
    setBusy(true);
    setError('');
    try {
      const r = await post<{ request: RequestRow }>('/api/market/install', {
        namespace: d.namespace,
        name: d.name,
        version: d.to,
        profile,
        mode: 'update',
        consents: consentsOf(d.stdio),
      });
      started.current = Date.now();
      setRequest(r.request);
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!request || outcome) return;
    const timer = window.setInterval(async () => {
      if (timedOut(started.current, Date.now())) {
        setValues({});
        setOutcome('timeout');
        return;
      }
      try {
        const r = await get<RequestRow>(`/api/market/request?id=${encodeURIComponent(request.id)}`);
        const ph = phaseOf(r);
        if (ph === 'created') {
          window.clearInterval(timer);
          for (const [key, raw] of Object.entries(values)) {
            if (!raw.trim() || later[key]) continue;
            try {
              await post('/api/profile/action', { name: profile, action: 'env_set', target: key, value: raw.trim() });
            } catch {
              /* 실패한 KEY 는 「확인할 것」의 남은 KEY 로 보인다 */
            }
          }
          setValues({});
          setOutcome('done');
          void qc.invalidateQueries({ queryKey: ['profiles'] });
        } else if (ph !== 'waiting') {
          window.clearInterval(timer);
          setValues({});
          setError(r.message ?? '');
          setOutcome('failed');
        }
      } catch {
        /* 다음 주기에 다시 읽는다 */
      }
    }, POLL_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.id, outcome]);

  if (diff.isLoading) return <CircularProgress size={20} />;
  if (diff.error) return <Alert severity="info">{(diff.error as Error).message}</Alert>;
  if (!d) return null;
  if (outcome === 'done') return <Alert severity="success">{t('profiles.tplUp.done', { to: d.to })}</Alert>;
  if (outcome === 'timeout') return <Alert severity="warning">{t('profiles.tpl.timeout')}</Alert>;
  if (request && !outcome)
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }} aria-live="polite">
        <CircularProgress size={18} />
        <Typography variant="body2">{t('profiles.tplUp.running', { to: d.to })}</Typography>
      </Box>
    );
  const nothing = !d.added.length && !d.changed.length;
  return (
    <Stack spacing={1.5}>
      <Typography variant="body2">{t('profiles.tplUp.summary', { from: d.from, to: d.to })}</Typography>
      {nothing ? (
        <Typography variant="body2" color="text.secondary">
          {t('profiles.tplUp.noMcpChange')}
        </Typography>
      ) : (
        <Stack spacing={1} component="ul" sx={{ pl: 0, m: 0, listStyle: 'none' }}>
          {d.added.map((m) => (
            <McpRow key={'a' + m.name} m={m} tag={t('profiles.tplUp.added')} />
          ))}
          {d.changed.map((m) => (
            <McpRow key={'c' + m.name} m={m} tag={t('profiles.tplUp.changed')} />
          ))}
        </Stack>
      )}
      {d.kept.length > 0 && (
        <Typography variant="caption" color="text.secondary">
          {t('profiles.tplUp.kept', { names: d.kept.join(', ') })}
        </Typography>
      )}
      {d.stdio.map((m) =>
        m.problem ? (
          <Alert key={m.name} severity="error">
            {m.problem}
          </Alert>
        ) : (
          <FormControlLabel
            key={m.name}
            control={<Checkbox checked={!!agreed[m.name]} onChange={(e) => setAgreed({ ...agreed, [m.name]: e.target.checked })} />}
            label={t('profiles.tplUp.consent', { name: m.name, command: [m.command, ...(m.args ?? [])].join(' ') })}
          />
        )
      )}
      {groups.map((g) =>
        g.fields.map((f) => (
          <Box key={f.name}>
            <SecretField
              label={f.name}
              required={f.required && !later[f.name]}
              helper={f.description}
              value={values[f.name] ?? ''}
              onChange={(v) => setValues({ ...values, [f.name]: v })}
            />
            <FormControlLabel
              control={<Checkbox size="small" checked={!!later[f.name]} onChange={(e) => setLater({ ...later, [f.name]: e.target.checked })} />}
              label={t('profiles.tpl.later')}
            />
          </Box>
        ))
      )}
      {outcome === 'failed' && <Alert severity="error">{t('profiles.tplUp.failed', { message: error })}</Alert>}
      {error && outcome !== 'failed' && <Alert severity="error">{error}</Alert>}
      <Box>
        <Button variant="contained" disabled={busy || !consentReady(d.stdio, agreed) || !keysReady(groups, values, later)} onClick={() => void start()}>
          {busy ? <CircularProgress size={18} /> : t('profiles.tplUp.start', { to: d.to })}
        </Button>
      </Box>
      <Typography variant="caption" color="text.secondary">
        {t('profiles.tplUp.note')}
      </Typography>
    </Stack>
  );
}
