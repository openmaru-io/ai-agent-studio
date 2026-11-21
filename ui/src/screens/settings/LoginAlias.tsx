/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 설정 › 로그인(관리자만, 스펙 2026-11-15-005 OMAI-2037). 구글 로그인은 옛 도메인(@legacy.example.com)으로만 되므로
// 그 사람을 회사 도메인(@openmaru.io) 사람으로 바꾼다. 맨 위에 로그인 제공자 관찰, 그 아래 설정(끔·기록만·켬, 도메인 짝, 대상 제공자,
// 제외 목록), 「전원 바꾸기」(미리 보기 → 기록만 → 실행), 확인 필요, 처리 기록. 저장 거절(400)은 그 칸의 그 줄에 보인다.
import {
  Alert,
  Box,
  Button,
  Chip,
  FormControlLabel,
  Radio,
  RadioGroup,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useEffect, useState } from 'react';

import { Section } from '@/components/bits';
import { useConfirm } from '@/components/ConfirmDialog';
import { t } from '@/i18n';
import { ApiError, get, post } from '@/lib/api';

type Mode = 'off' | 'record' | 'on';

export interface LoginAliasConfig {
  mode: Mode;
  pairs: string[][];
  providers: string[];
  exclude: string[];
  by?: string;
  ts?: string;
}

export interface LoginMergeRow {
  id: number;
  created: number;
  source: string;
  mode: string;
  kase: string;
  result: string;
  step: string;
  login_email: string;
  company_email: string;
  error: string;
}

export interface LoginAliasData {
  config: LoginAliasConfig;
  source: 'screen' | 'install' | 'error';
  install: LoginAliasConfig;
  observed: { client: string; alias: string; n: number }[];
  client: string;
  no_claim: boolean;
  unseen_providers: string[];
  keycloak: boolean;
  records: LoginMergeRow[];
  attention: LoginMergeRow[];
}

interface PreviewRow {
  user_id: string;
  login_email: string;
  company_email: string;
  enabled: boolean;
  excluded: boolean;
  conflict: boolean;
}

interface FieldError {
  field: string;
  line: number;
  message: string;
}

const KEY = ['settings-login'];
const pairsText = (pairs: string[][]) => pairs.map((p) => p.join(':')).join('\n');
const listText = (xs: string[]) => xs.join('\n');
const when = (sec: number) => new Date(sec * 1000).toLocaleString();

/** 처리 기록 한 줄의 결과 낱말(경우·결과·단계) → 화면 문구 */
export function resultLabel(r: Pick<LoginMergeRow, 'kase' | 'result' | 'step'>): string {
  if (r.kase === 'needs_admin') return t('loginAlias.resultNeedsAdmin');
  if (r.result === 'done') return t('loginAlias.resultDone');
  if (r.result === 'recorded') return t('loginAlias.resultRecorded');
  if (r.result === 'running') return t('loginAlias.resultRunning');
  return t('loginAlias.resultFailed', { step: r.step ? t(`loginAlias.step.${r.step}`) : t('loginAlias.step.none') });
}

function Rows({ rows, empty, testId }: { rows: LoginMergeRow[]; empty: string; testId: string }) {
  if (!rows.length)
    return (
      <Typography variant="body2" color="text.secondary" data-testid={testId}>
        {empty}
      </Typography>
    );
  return (
    <Table size="small" data-testid={testId}>
      <TableHead>
        <TableRow>
          <TableCell>{t('loginAlias.colRef')}</TableCell>
          <TableCell>{t('loginAlias.colWhen')}</TableCell>
          <TableCell>{t('loginAlias.colWho')}</TableCell>
          <TableCell>{t('loginAlias.colResult')}</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.id}>
            <TableCell>{r.id}</TableCell>
            <TableCell>
              {when(r.created)}
              <Typography variant="caption" color="text.secondary" component="div">
                {t(`loginAlias.source.${r.source}`)}
              </Typography>
            </TableCell>
            <TableCell sx={{ overflowWrap: 'anywhere' }}>
              {r.login_email} → {r.company_email}
            </TableCell>
            <TableCell>
              {resultLabel(r)}
              {r.error && r.result !== 'done' && (
                <Typography variant="caption" color="text.secondary" component="div" sx={{ overflowWrap: 'anywhere' }}>
                  {r.error}
                </Typography>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function LoginAlias() {
  const q = useQuery<LoginAliasData>({ queryKey: KEY, queryFn: () => get<LoginAliasData>('/api/settings/login') });
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { enqueueSnackbar } = useSnackbar();
  const [mode, setMode] = useState<Mode>('off');
  const [pairs, setPairs] = useState('');
  const [providers, setProviders] = useState('');
  const [exclude, setExclude] = useState('');
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<FieldError | null>(null);
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  const d = q.data;

  useEffect(() => {
    if (!d?.config) return;
    setMode(d.config.mode);
    setPairs(pairsText(d.config.pairs));
    setProviders(listText(d.config.providers));
    setExclude(listText(d.config.exclude));
  }, [d]);

  // /api/settings 를 흉내 낸 다른 응답이나 권한 없음(403)이면 그리지 않는다
  if (!d?.config) return null;

  const after = async (out: LoginAliasData) => {
    qc.setQueryData(KEY, out);
    setFieldError(null);
  };
  const failed = (e: unknown) => {
    if (e instanceof ApiError && e.status === 400 && typeof e.data.field === 'string') {
      setFieldError({ field: String(e.data.field), line: Number(e.data.line || 0), message: e.message });
      return;
    }
    enqueueSnackbar((e as Error).message, { variant: 'error' });
  };
  const save = async () => {
    setBusy(true);
    try {
      const out = await post<LoginAliasData>('/api/settings/login', { action: 'save', mode, pairs, providers, exclude });
      await after(out);
      enqueueSnackbar(t('loginAlias.saved'), { variant: 'success' });
      if (out.unseen_providers.length) enqueueSnackbar(t('loginAlias.unseenWarn', { names: out.unseen_providers.join(', ') }), { variant: 'warning' });
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };
  const reset = async () => {
    if (!(await confirm(t('loginAlias.resetConfirm')))) return;
    setBusy(true);
    try {
      await after(await post<LoginAliasData>('/api/settings/login', { action: 'reset' }));
      enqueueSnackbar(t('loginAlias.resetDone'), { variant: 'success' });
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };
  const loadPreview = async () => {
    setBusy(true);
    try {
      setPreview((await get<{ people: PreviewRow[] }>('/api/settings/login/preview')).people);
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };
  const bulk = async (action: 'record' | 'run') => {
    if (action === 'run' && !(await confirm(t('loginAlias.runConfirm'), { danger: true, confirmLabel: t('loginAlias.run') }))) return;
    setBusy(true);
    try {
      const out = await post<LoginAliasData & { result: Record<string, number> }>('/api/settings/login/bulk', { action });
      await after(out);
      enqueueSnackbar(t('loginAlias.bulkDone', out.result), { variant: out.result.failed ? 'warning' : 'success' });
      setPreview(null);
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };
  const err = (field: string) => (fieldError?.field === field ? fieldError.message : '');
  const changed =
    mode !== d.config.mode ||
    pairs.trim() !== pairsText(d.config.pairs) ||
    providers.trim() !== listText(d.config.providers) ||
    exclude.trim() !== listText(d.config.exclude);
  const seen = d.observed.filter((r) => r.client === d.client);

  return (
    <Section title={t('loginAlias.title')} guide="settings.login" indent>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        {t('loginAlias.lead')}
      </Typography>

      <Typography variant="body2" fontWeight={600}>
        {t('loginAlias.observedTitle')}
      </Typography>
      {seen.length ? (
        <Box component="ul" sx={{ m: 0, pl: 2.5 }} data-testid="login-observed">
          {seen.map((r) => (
            <li key={r.alias}>
              <Typography variant="body2">
                {r.alias ? t('loginAlias.observedAlias', { alias: r.alias, n: r.n }) : t('loginAlias.observedNone', { n: r.n })}
              </Typography>
            </li>
          ))}
        </Box>
      ) : (
        <Typography variant="body2" color="text.secondary">
          {t('loginAlias.observedEmpty')}
        </Typography>
      )}
      {d.no_claim && mode !== 'off' && (
        <Alert severity="warning" sx={{ mt: 1 }} data-testid="login-no-claim">
          {t('loginAlias.noClaim')}
        </Alert>
      )}
      {!d.keycloak && (
        <Alert severity="info" sx={{ mt: 1 }}>
          {t('loginAlias.noKeycloak')}
        </Alert>
      )}

      <Typography variant="body2" fontWeight={600} sx={{ mt: 2 }}>
        {t('loginAlias.settingsTitle')}
      </Typography>
      <Typography variant="caption" color="text.secondary" component="p" data-testid="login-source">
        {d.source === 'screen'
          ? t('loginAlias.sourceScreen', { by: d.config.by || '-', ts: d.config.ts || '-' })
          : t('loginAlias.sourceInstall')}
      </Typography>
      <RadioGroup row value={mode} onChange={(e) => setMode(e.target.value as Mode)} aria-label={t('loginAlias.mode')}>
        {(['off', 'record', 'on'] as Mode[]).map((m) => (
          <FormControlLabel key={m} value={m} control={<Radio size="small" />} label={t(`loginAlias.mode.${m}`)} disabled={busy} />
        ))}
      </RadioGroup>
      <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 1 }}>
        {t(`loginAlias.modeHelp.${mode}`)}
      </Typography>
      <Stack spacing={1.5}>
        <TextField
          size="small"
          multiline
          minRows={2}
          label={t('loginAlias.pairs')}
          value={pairs}
          onChange={(e) => setPairs(e.target.value)}
          disabled={busy}
          error={!!err('pairs')}
          helperText={err('pairs') || t('loginAlias.pairsHelp')}
          inputProps={{ 'data-testid': 'login-pairs' }}
        />
        <TextField
          size="small"
          label={t('loginAlias.providers')}
          value={providers}
          onChange={(e) => setProviders(e.target.value)}
          disabled={busy}
          error={!!err('providers')}
          helperText={err('providers') || t('loginAlias.providersHelp')}
        />
        <TextField
          size="small"
          multiline
          minRows={1}
          label={t('loginAlias.exclude')}
          value={exclude}
          onChange={(e) => setExclude(e.target.value)}
          disabled={busy}
          error={!!err('exclude')}
          helperText={err('exclude') || t('loginAlias.excludeHelp')}
        />
        {fieldError && !['pairs', 'providers', 'exclude'].includes(fieldError.field) && <Alert severity="error">{fieldError.message}</Alert>}
        <Stack direction="row" spacing={1}>
          <Button variant="contained" disabled={!changed || busy} onClick={() => void save()}>
            {t('settings.save')}
          </Button>
          {d.source === 'screen' && (
            <Button variant="outlined" disabled={busy} onClick={() => void reset()}>
              {t('loginAlias.reset')}
            </Button>
          )}
        </Stack>
      </Stack>

      <Typography variant="body2" fontWeight={600} sx={{ mt: 2 }}>
        {t('loginAlias.bulkTitle')}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        {t('loginAlias.bulkLead')}
      </Typography>
      <Stack direction="row" spacing={1} sx={{ mb: 1 }} flexWrap="wrap" useFlexGap>
        <Button variant="outlined" disabled={busy || !d.keycloak} onClick={() => void loadPreview()}>
          {t('loginAlias.preview')}
        </Button>
        <Button variant="outlined" disabled={busy || !d.keycloak || !d.config.pairs.length} onClick={() => void bulk('record')}>
          {t('loginAlias.recordOnly')}
        </Button>
        <Button variant="outlined" color="error" disabled={busy || !d.keycloak || !d.config.pairs.length} onClick={() => void bulk('run')}>
          {t('loginAlias.run')}
        </Button>
      </Stack>
      {preview && (
        <Box data-testid="login-preview" sx={{ mb: 1 }}>
          {preview.length ? (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t('loginAlias.colWho')}</TableCell>
                  <TableCell>{t('loginAlias.colState')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {preview.map((p) => (
                  <TableRow key={p.user_id}>
                    <TableCell sx={{ overflowWrap: 'anywhere' }}>
                      {p.login_email} → {p.company_email}
                    </TableCell>
                    <TableCell>
                      {p.conflict ? (
                        <Chip size="small" color="warning" label={t('loginAlias.conflict')} />
                      ) : p.excluded ? (
                        <Chip size="small" label={t('loginAlias.excluded')} />
                      ) : (
                        <Chip size="small" color="success" variant="outlined" label={t('loginAlias.willChange')} />
                      )}
                      {!p.enabled && <Chip size="small" sx={{ ml: 0.5 }} label={t('loginAlias.disabled')} />}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Typography variant="body2" color="text.secondary">
              {t('loginAlias.previewEmpty')}
            </Typography>
          )}
        </Box>
      )}

      <Typography variant="body2" fontWeight={600} sx={{ mt: 2 }}>
        {t('loginAlias.attentionTitle')}
      </Typography>
      <Rows rows={d.attention} empty={t('loginAlias.attentionEmpty')} testId="login-attention" />

      <Typography variant="body2" fontWeight={600} sx={{ mt: 2 }}>
        {t('loginAlias.recordsTitle')}
      </Typography>
      <Rows rows={d.records} empty={t('loginAlias.recordsEmpty')} testId="login-records" />
    </Section>
  );
}
