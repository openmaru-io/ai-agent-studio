/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 설정 › 「Claude Code 연결」(스펙 2026-10-28-001 §3-7 ②, 디자인 D4·D5·D7·D8·D9·D17·D18).
// 위 구역은 OAuth 연결(Claude Code 가 브라우저 로그인으로 만든 것), 아래 구역은 브라우저 없는 곳용 수동 토큰.
// 줄 하나 = 연결 하나. 원문 토큰은 만든 창에서 한 번만 보이고 닫으면 다시 볼 수 없다.
import type { SxProps, Theme } from '@mui/material';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  FormLabel,
  InputLabel,
  Link,
  MenuItem,
  Radio,
  RadioGroup,
  Select,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import { visuallyHidden } from '@mui/utils';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useCallback, useState } from 'react';

import { monoFont, ScreenLoading, Section } from '@/components/bits';
import { useConfirm } from '@/components/ConfirmDialog';
import { DisclosureButton } from '@/components/DisclosureButton';
import { PageTitle } from '@/components/PageTitle';
import { StatusPill } from '@/components/StatusPill';
import { tier1, tier2, tier3 } from '@/components/tierButton';
import { t } from '@/i18n';
import { ApiError, get, post } from '@/lib/api';
import {
  activeCount,
  addCommand,
  addWithTokenCommand,
  caCheckCommand,
  caCurlEnvLine,
  caFetchCommand,
  caHostPort,
  caMkdirCommand,
  type CaOs,
  caRegisterCommands,
  detectCaOs,
  envFromKeychainCommand,
  expiringSoon,
  keychainCommand,
  loginCommand,
  splitRows,
  TokenRow,
  TokensData,
} from '@/lib/connections';
import { useMe } from '@/lib/data';
import { fmtTs } from '@/lib/format';

/** 단추 등급(tierButton, 테마를 받는 함수)에 이 화면의 크기 조정을 더한다 — 좁은 화면 단추 44px(디자인 D18) */
const withTier = (tier: SxProps<Theme>, extra: object): SxProps<Theme> =>
  ((th: Theme) => ({ ...(tier as (t: Theme) => object)(th), ...extra })) as SxProps<Theme>;
const at = (sec: number | null | undefined): string => (sec ? fmtTs(new Date(sec * 1000).toISOString()) : '—');
const bundleLabel = (b: string): string => t(`conn.bundle.${b}`);

/** 명령 한 줄 + 복사. 「복사함」은 화면 읽기 프로그램에도 알린다(aria-live) */
/** buttonOnly: 글은 다른 칸(원문 토큰 입력칸)이 이미 보여 단추만 둔다 */
function CopyLine({ text, label, testId, buttonOnly }: { text: string; label: string; testId?: string; buttonOnly?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <>
    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ xs: 'stretch', sm: 'center' }} sx={{ my: 0.5 }}>
      {!buttonOnly && (
        <Box
          component="code"
          data-testid={testId}
          sx={{ flex: 1, fontFamily: monoFont, fontSize: 12.5, px: 1.5, py: 1, border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: 'action.hover', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}
        >
          {text}
        </Box>
      )}
      <Button variant="outlined" color="inherit" sx={withTier(tier2, { flexShrink: 0, minHeight: { xs: 44, sm: 'auto' } })} onClick={copy} aria-label={label}>
        {copied ? t('conn.copied') : t('conn.copy')}
      </Button>
    </Stack>
    {/* 화면 읽기 프로그램에만 알린다. 흐름 밖에 둔다 — sx 의 width: 1 은 100% 라 좁은 화면이 옆으로 밀렸다(2026-10-28 실화면) */}
    <Box component="span" aria-live="polite" sx={visuallyHidden}>
      {copied ? t('conn.copiedLive') : ''}
    </Box>
    </>
  );
}

/** 사설 인증서 오류 안내 — 접어 둔다(공인 인증서면 필요 없다). 단계는 순서가 있는 일이라 번호를 쓴다 */
function CaGuide({ mcpUrl }: { mcpUrl: string }) {
  const [open, setOpen] = useState(false);
  const [os, setOs] = useState<CaOs>(() => detectCaOs(typeof navigator === 'undefined' ? '' : navigator.platform));
  const hostPort = caHostPort(mcpUrl);
  if (!hostPort) return null;
  const steps: { text: string; cmds: { cmd: string; label: string; name?: string; testId?: string }[] }[] = [
    { text: t('conn.ca.s1'), cmds: [{ cmd: caMkdirCommand(os), label: t('conn.ca.copyS1') }] },
    { text: t('conn.ca.s2'), cmds: [{ cmd: caFetchCommand(hostPort, os), label: t('conn.ca.copyS2'), testId: 'conn-ca-fetch' }] },
    { text: t('conn.ca.s3'), cmds: [{ cmd: caCheckCommand(os), label: t('conn.ca.copyS3') }] },
    {
      text: t(`conn.ca.s4.${os}`),
      cmds: caRegisterCommands(os).map((r) => ({ cmd: r.cmd, name: r.name, label: t('conn.ca.copyS4', { name: r.name ?? '' }).trim(), testId: 'conn-ca-register' })),
    },
  ];
  if (os === 'mac') steps.push({ text: t('conn.ca.s4curl'), cmds: [{ cmd: caCurlEnvLine(), label: t('conn.ca.copyCurl'), testId: 'conn-ca-curl' }] });
  return (
    <Box sx={{ mt: 1.5 }}>
      <DisclosureButton open={open} onToggle={() => setOpen((v) => !v)} label={open ? t('conn.ca.hide') : t('conn.ca.show')} controls="conn-ca-guide" />
      <Collapse in={open} unmountOnExit>
        <Tabs value={os} onChange={(_, v: CaOs) => setOs(v)} aria-label={t('conn.ca.osAria')} sx={{ mt: 1, minHeight: 40 }}>
          <Tab value="mac" label={t('conn.ca.osMac')} sx={{ minHeight: 40 }} />
          <Tab value="linux" label={t('conn.ca.osLinux')} sx={{ minHeight: 40 }} />
          <Tab value="windows" label={t('conn.ca.osWin')} sx={{ minHeight: 40 }} />
        </Tabs>
        <Alert severity="warning" sx={{ mt: 1 }}>
          {t('conn.ca.warn')}
        </Alert>
        {os === 'windows' && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            {t('conn.ca.winLead')}
          </Typography>
        )}
        <Box id="conn-ca-guide" component="ol" sx={{ m: 0, mt: 1, pl: 3, '& > li': { mb: 1.5 } }}>
          {steps.map((st) => (
            <li key={`${os}-${st.text}`}>
              <Typography variant="body2">{st.text}</Typography>
              {st.cmds.map((c) => (
                <Box key={c.label}>
                  {c.name && (
                    <Typography variant="caption" color="text.secondary">
                      {c.name}
                    </Typography>
                  )}
                  <CopyLine text={c.cmd} label={c.label} testId={c.testId} />
                </Box>
              ))}
            </li>
          ))}
          <li>
            <Typography variant="body2">{t('conn.ca.s5')}</Typography>
          </li>
        </Box>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {t('conn.ca.note')}
        </Typography>
      </Collapse>
    </Box>
  );
}

function Row({ row, now, error, onRevoke }: { row: TokenRow; now: number; error?: string; onRevoke: (r: TokenRow) => void }) {
  const [open, setOpen] = useState(false);
  const soon = expiringSoon(row, now);
  const live = row.state === 'active';
  return (
    <Box data-testid={`conn-row-${row.id}`} sx={{ py: 1, borderBottom: 1, borderColor: 'divider' }}>
      <Box
        sx={{
          display: 'grid',
          gap: 1,
          alignItems: 'center',
          gridTemplateColumns: { xs: '1fr auto', sm: 'minmax(0,2fr) 1fr 1fr 1fr auto' },
        }}
      >
        <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
          <Typography variant="body2" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
            {row.name}
          </Typography>
          <StatusPill tone="neutral">{row.kind === 'oauth' ? t('conn.kindOauth') : t('conn.kindPat')}</StatusPill>
          {!live && <StatusPill tone="neutral">{row.state === 'revoked' ? t('conn.revokedAt', { at: at(row.ended) }) : t('conn.expiredAt', { at: at(row.ended) })}</StatusPill>}
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ display: { xs: 'none', sm: 'block' } }}>
          {bundleLabel(row.bundle)}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ gridColumn: { xs: '1 / -1', sm: 'auto' }, gridRow: { xs: 2, sm: 'auto' } }}>
          {t('conn.lastUsed', { at: at(row.last_used) })}
        </Typography>
        <Typography
          variant="body2"
          data-expiring={soon ? 'yes' : undefined}
          sx={{ gridColumn: { xs: 1, sm: 'auto' }, gridRow: { xs: 3, sm: 'auto' }, color: soon ? 'warning.main' : 'text.secondary', fontWeight: soon ? 600 : 400 }}
        >
          {t('conn.expires', { at: at(row.expires) })}
          {soon ? ` · ${t('conn.soon')}` : ''}
        </Typography>
        <Stack direction="row" spacing={0.5} sx={{ gridColumn: { xs: 2, sm: 'auto' }, gridRow: { xs: '1 / span 3', sm: 'auto' }, justifySelf: 'end' }}>
          <DisclosureButton open={open} onToggle={() => setOpen((v) => !v)} label={t('conn.details')} controls={`conn-detail-${row.id}`} />
          {live && (
            <Button
              size="small"
              variant="outlined"
              color="inherit"
              sx={withTier(tier2, { minHeight: { xs: 44, sm: 'auto' } })}
              aria-label={t('conn.revokeAria', { name: row.name })}
              onClick={() => onRevoke(row)}
            >
              {row.kind === 'oauth' ? t('conn.revokeOauth') : t('conn.revokePat')}
            </Button>
          )}
        </Stack>
      </Box>
      {open && (
        <Typography id={`conn-detail-${row.id}`} variant="caption" color="text.secondary" component="p" sx={{ mt: 0.5, fontFamily: monoFont }}>
          {t('conn.detailLine', { prefix: row.prefix, ip: row.last_ip || '—', created: at(row.created), bundle: bundleLabel(row.bundle) })}
        </Typography>
      )}
      {error && (
        <Alert severity="error" sx={{ mt: 1 }} action={<Button color="inherit" size="small" onClick={() => onRevoke(row)}>{t('conn.retry')}</Button>}>
          {error}
        </Alert>
      )}
    </Box>
  );
}

/** 토큰 만들기 창. 만든 뒤에는 원문을 한 번만 보이고, 실수로 닫히지 않게 ESC·바깥 클릭을 막고 닫을 때 한 번 더 묻는다 */
function CreateDialog({ data, open, onClose }: { data: TokensData; open: boolean; onClose: () => void }) {
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [bundle, setBundle] = useState('skill-dev');
  const [days, setDays] = useState(data.default_days);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; field: string } | null>(null);
  const [secret, setSecret] = useState('');
  const focusSecret = useCallback((el: HTMLInputElement | null) => el?.select(), []);

  const reset = () => {
    setName('');
    setBundle('skill-dev');
    setDays(data.default_days);
    setError(null);
    setSecret('');
  };
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await post<{ secret: string }>('/api/tokens/create', { name: name.trim(), bundle, days });
      setSecret(out.secret);
      await qc.invalidateQueries({ queryKey: ['tokens'] });
      await qc.invalidateQueries({ queryKey: ['me'] });
    } catch (e) {
      setError({ text: (e as Error).message, field: e instanceof ApiError ? e.field : '' });
    } finally {
      setBusy(false);
    }
  };
  const close = async () => {
    if (secret && !(await confirm(t('conn.closeConfirm'), { title: t('conn.closeTitle'), confirmLabel: t('conn.closeOk'), cancelFirst: true }))) return;
    reset();
    onClose();
  };

  return (
    <Dialog open={open} onClose={() => undefined} disableEscapeKeyDown fullWidth maxWidth="sm" aria-labelledby="conn-create-title">
      <DialogTitle id="conn-create-title">{secret ? t('conn.createdTitle') : t('conn.createTitle')}</DialogTitle>
      <DialogContent>
        {!secret ? (
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Typography variant="body2" color="text.secondary">
              {t('conn.createLead')}
            </Typography>
            <TextField
              size="small"
              label={t('conn.name')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              error={error?.field === 'name'}
              helperText={error?.field === 'name' ? error.text : t('conn.nameHelp')}
              inputProps={{ maxLength: 60 }}
            />
            <FormControl>
              <FormLabel id="conn-bundle">{t('conn.bundleLabel')}</FormLabel>
              <RadioGroup aria-labelledby="conn-bundle" value={bundle} onChange={(e) => setBundle(e.target.value)}>
                {Object.keys(data.bundles).map((b) => (
                  <FormControlLabel key={b} value={b} control={<Radio size="small" />} label={`${bundleLabel(b)} — ${t(`conn.bundleDesc.${b}`)}`} />
                ))}
              </RadioGroup>
            </FormControl>
            <FormControl size="small" sx={{ maxWidth: 200 }}>
              <InputLabel id="conn-days">{t('conn.days')}</InputLabel>
              <Select labelId="conn-days" label={t('conn.days')} value={days} onChange={(e) => setDays(Number(e.target.value))}>
                {data.expiry_days.map((d) => (
                  <MenuItem key={d} value={d}>
                    {t('conn.daysN', { n: d })}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            {error && error.field !== 'name' && <Alert severity="error">{error.text}</Alert>}
          </Stack>
        ) : (
          <Stack spacing={1.5} sx={{ pt: 1 }}>
            <Alert severity="warning">{t('conn.onceWarning')}</Alert>
            <TextField
              size="small"
              label={t('conn.secret')}
              inputProps={{ 'data-testid': 'conn-secret' }}
              value={secret}
              inputRef={focusSecret}
              InputProps={{ readOnly: true, sx: { fontFamily: monoFont, fontSize: 12.5 } }}
            />
            <CopyLine text={secret} label={t('conn.copySecret')} buttonOnly />
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {t('conn.step1')}
            </Typography>
            <CopyLine text={keychainCommand()} label={t('conn.copyStep1')} />
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {t('conn.step2')}
            </Typography>
            <CopyLine text={envFromKeychainCommand()} label={t('conn.copyStep2')} />
            <CopyLine text={addWithTokenCommand(data.mcp_url)} label={t('conn.copyStep3')} testId="conn-add-with-token" />
            <Typography variant="caption" color="text.secondary">
              {t('conn.otherOs')}
            </Typography>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        {!secret && (
          <Button variant="outlined" color="inherit" sx={tier1} disabled={busy || !name.trim()} onClick={() => void create()}>
            {t('conn.create')}
          </Button>
        )}
        <Button variant="outlined" color="inherit" sx={tier2} onClick={() => void close()}>
          {secret ? t('conn.done') : t('conn.cancel')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** 모두 끊기: 내 이메일을 적어 확인. 연결·토큰과 함께 이 브라우저를 포함한 내 로그인 세션도 끝난다(재검토 D8) */
function RevokeAllDialog({ open, email, onClose }: { open: boolean; email: string; onClose: () => void }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ok = typed.trim().toLowerCase() === email.toLowerCase();
  const run = async () => {
    setBusy(true);
    setError('');
    try {
      await post('/api/tokens/revoke-all', { confirm: typed.trim() });
      window.location.assign('/auth/login');
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="xs" aria-labelledby="conn-all-title">
      <DialogTitle id="conn-all-title">{t('conn.allTitle')}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ mb: 1 }}>
          {t('conn.allLead')}
        </Typography>
        <Alert severity="warning" sx={{ mb: 2 }}>
          {t('conn.allLogout')}
        </Alert>
        <TextField size="small" fullWidth label={t('conn.allTypeEmail', { email })} value={typed} onChange={(e) => setTyped(e.target.value)} />
        {error && (
          <Alert severity="error" sx={{ mt: 1 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button variant="outlined" color="inherit" sx={tier2} onClick={onClose} disabled={busy}>
          {t('conn.cancel')}
        </Button>
        <Button variant="outlined" color="inherit" sx={tier3} disabled={!ok || busy} onClick={() => void run()}>
          {t('conn.allOk')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function Connections() {
  const [ended, setEnded] = useState(false);
  const q = useQuery<TokensData>({ queryKey: ['tokens', ended], queryFn: () => get<TokensData>(`/api/tokens${ended ? '?ended=1' : ''}`) });
  const me = useMe();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { enqueueSnackbar } = useSnackbar();
  const [creating, setCreating] = useState(false);
  const [all, setAll] = useState(false);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  const err = q.error as ApiError | null;
  if (err?.reason === 'login_off')
    return (
      <Box sx={{ maxWidth: 880 }}>
        <PageTitle>{t('views.connections.label')}</PageTitle>
        <Alert severity="info">{t('conn.loginOff')}</Alert>
      </Box>
    );
  const d = q.data;
  if (!d) return <ScreenLoading title={t('views.connections.label')} error={err?.message} />;

  const now = Date.now() / 1000;
  const { oauth, pat } = splitRows(d.tokens);
  const active = activeCount(d.tokens);
  const full = active >= d.max;
  const empty = d.tokens.length === 0;

  const revoke = async (row: TokenRow) => {
    const okd = await confirm(t('conn.revokeConfirm', { name: row.name }), {
      danger: true,
      title: t('conn.revokeTitle', { name: row.name }),
      confirmLabel: row.kind === 'oauth' ? t('conn.revokeOauth') : t('conn.revokePat'),
    });
    if (!okd) return;
    try {
      await post('/api/tokens/revoke', { id: row.id });
      setRowErrors(({ [row.id]: _gone, ...rest }) => rest);
      enqueueSnackbar(t('conn.revoked', { name: row.name }), { variant: 'success' });
      await qc.invalidateQueries({ queryKey: ['tokens'] });
      await qc.invalidateQueries({ queryKey: ['me'] });
    } catch (e) {
      setRowErrors((m) => ({ ...m, [row.id]: (e as Error).message }));
    }
  };
  const rows = (list: TokenRow[]) => list.map((r) => <Row key={r.id} row={r} now={now} error={rowErrors[r.id]} onRevoke={(x) => void revoke(x)} />);

  return (
    <Box sx={{ maxWidth: 880 }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'flex-start' }}>
        <Box>
          <PageTitle>{t('views.connections.label')}</PageTitle>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {t('views.connections.sub')}
          </Typography>
        </Box>
        {active > 0 && (
          <Button variant="outlined" color="inherit" sx={withTier(tier2, { flexShrink: 0, minHeight: { xs: 44, sm: 'auto' } })} onClick={() => setAll(true)}>
            {t('conn.allButton')}
          </Button>
        )}
      </Stack>

      <Section title={t('conn.commandTitle')} indent>
        <CopyLine text={addCommand(d.mcp_url)} label={t('conn.copyCommand')} testId="conn-command" />
        <CopyLine text={loginCommand()} label={t('conn.copyLogin')} testId="conn-login" />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {t('conn.commandLead')}
        </Typography>
        <CaGuide mcpUrl={d.mcp_url} />
        {empty && (
          <Stack direction="row" spacing={2} sx={{ mt: 1 }} flexWrap="wrap">
            <Link component="button" type="button" variant="body2" onClick={() => setCreating(true)}>
              {t('conn.noBrowserLink')}
            </Link>
            <Typography variant="body2" color="text.secondary">
              {t('conn.humanNeeded')}
            </Typography>
          </Stack>
        )}
      </Section>

      <Section title={t('conn.oauthTitle')} count={oauth.filter((r) => r.state === 'active').length} indent>
        {oauth.length ? rows(oauth) : <Typography variant="body2" color="text.secondary">{t('conn.oauthEmpty')}</Typography>}
      </Section>

      <Section
        title={t('conn.patTitle')}
        count={pat.filter((r) => r.state === 'active').length}
        indent
        action={
          <Button variant="outlined" color="inherit" size="small" sx={tier2} disabled={full} onClick={() => setCreating(true)}>
            {t('conn.createButton')}
          </Button>
        }
      >
        {full && (
          <Alert severity="info" sx={{ mb: 1 }}>
            {t('conn.full', { max: d.max })}
          </Alert>
        )}
        {pat.length ? rows(pat) : <Typography variant="body2" color="text.secondary">{t('conn.patEmpty')}</Typography>}
      </Section>

      <FormControlLabel control={<Checkbox size="small" checked={ended} onChange={(e) => setEnded(e.target.checked)} />} label={t('conn.showEnded')} />

      <CreateDialog data={d} open={creating} onClose={() => setCreating(false)} />
      <RevokeAllDialog open={all} email={me.data?.user?.email ?? ''} onClose={() => setAll(false)} />
    </Box>
  );
}
