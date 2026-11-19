/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 관리 › 임베드 앱(OMAI-1873). 채팅 위젯(aas-widget.js)을 붙일 호스트 사이트를 등록·고치기·지우기 한다. CLI(python -m aas.auth.embed)와 같은 일을 한다.
// 목록은 공지 관리처럼 표, 등록·고치기는 서랍이다. 서버 /api/admin/embed-apps 가 관리자만 받고, 틀린 칸은 400 {error, field} 로 짚는다.
// keycloak 모드는 「호스트 realm 이 이메일 변경·자가 가입을 막는지 확인했다」 칸이 없으면 서버가 저장하지 않는다(CLI --idp-policy-checked 와 같다).
// keycloak 모드는 팝업 로그인 클라이언트(OMAI-1911)를 둘 수 있다. 비밀은 쓰기만 한다 — 서버는 login_client_secret_set 만 주고, 빈 값을 보내면 기존 값을 둔다.
import { Alert, Box, Button, Checkbox, FormControlLabel, FormHelperText, MenuItem, Radio, RadioGroup, Stack, TextField, Typography } from '@mui/material';
import { visuallyHidden } from '@mui/utils';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useId, useState } from 'react';

import { monoFont } from '@/components/bits';
import { useConfirm } from '@/components/ConfirmDialog';
import { GridColumn, Pill } from '@/components/DataGrid';
import { ListView } from '@/components/ListView';
import { useUi } from '@/components/UiContext';
import { localeOf, t } from '@/i18n';
import { ApiError, get, post } from '@/lib/api';

import { EmbedAppFormats } from './EmbedAppFormats';

export type EmbedMode = 'keycloak' | 'host-signed';

export interface EmbedApp {
  app_id: string;
  name: string;
  origins: string[];
  mode: EmbedMode;
  issuer: string;
  jwks_url: string;
  audience: string;
  public_jwk: string;
  default_agent: string;
  created: number;
  /** 팝업 로그인 클라이언트(OMAI-1911, keycloak 전용). 비면 위젯이 로그인 창을 열지 않는다 */
  login_client_id?: string;
  /** 클라이언트 비밀이 등록됐는가. 비밀 자체는 내려오지 않는다 */
  login_client_secret_set?: boolean;
}

export interface EmbedAppsResp {
  apps: EmbedApp[];
  modes: EmbedMode[];
  auth_enabled: boolean;
  ws_enabled: boolean;
  /** 이 화면을 연 AAS 주소. 위젯의 backendUrl 과 host-signed 토큰의 aud */
  aas_url: string;
  audiences: string[];
  host_ttl_max: number;
  agents: string[];
  /** 로그인 도메인 처리(스펙 2026-11-15-005)를 켰는가, AAS 영역 발급자, 최근 7일 identity_provider claim 이 온 client */
  login_alias_on?: boolean;
  aas_issuer?: string;
  login_claim_clients?: string[];
}

/** 로그인 도메인 처리를 켰는데 AAS 영역의 위젯 로그인 client 에 claim 이 오지 않았다 — 위젯 로그인은 처리되지 않는다 */
export const missingLoginClaim = (meta: EmbedAppsResp, issuer: string, client: string): boolean =>
  !!meta.login_alias_on && !!client && issuer.replace(/\/+$/, '') === (meta.aas_issuer ?? '').replace(/\/+$/, '') &&
  !(meta.login_claim_clients ?? []).includes(client);

export const EMBED_APPS_PATH = '/api/admin/embed-apps';
export const EMBED_APPS_KEY = ['embed-apps-admin'];
const MODES: EmbedMode[] = ['keycloak', 'host-signed'];
const FIELDS = ['name', 'origins', 'mode', 'issuer', 'jwks_url', 'audience', 'idp_policy_checked', 'login_client_id', 'login_client_secret', 'public_jwk', 'default_agent'] as const;
type Field = (typeof FIELDS)[number];

interface Draft {
  app_id: string;
  name: string;
  origins: string;
  mode: EmbedMode;
  issuer: string;
  jwks_url: string;
  audience: string;
  public_jwk: string;
  default_agent: string;
  idp: boolean;
  login_client_id: string;
  /** 새로 넣을 비밀. 비워 두면 서버가 기존 값을 둔다 */
  login_client_secret: string;
}

const seed = (x?: EmbedApp): Draft => ({
  app_id: x?.app_id ?? '',
  name: x?.name ?? '',
  origins: (x?.origins ?? []).join('\n'),
  mode: x?.mode ?? 'keycloak',
  issuer: x?.issuer ?? '',
  jwks_url: x?.jwks_url ?? '',
  audience: x?.audience ?? '',
  public_jwk: x?.public_jwk ?? '',
  default_agent: x?.default_agent ?? '',
  idp: false, // 고칠 때마다 다시 확인한다(CLI 도 등록마다 묻는다)
  login_client_id: x?.login_client_id ?? '',
  login_client_secret: '',
});

const originList = (text: string) => text.split(/\s+/).filter(Boolean);

/** 저장 전에 화면이 먼저 보는 것: 빈 칸·정책 확인. 형식(출처·JWK)은 서버가 본다 */
export function checkDraft(d: Draft): Partial<Record<Field, string>> {
  const out: Partial<Record<Field, string>> = {};
  if (!d.name.trim()) out.name = t('embedApps.err.name');
  if (!originList(d.origins).length) out.origins = t('embedApps.err.origins');
  if (d.mode === 'keycloak') {
    for (const f of ['issuer', 'jwks_url', 'audience'] as const) if (!d[f].trim()) out[f] = t('embedApps.err.required');
    if (!d.idp) out.idp_policy_checked = t('embedApps.err.idp');
  } else if (!d.public_jwk.trim()) out.public_jwk = t('embedApps.err.required');
  return out;
}

/** 붙여 넣을 코드 — HTML 에 그대로 넣는 일반 <script>(TypeScript·최상위 await 를 쓰지 않는다, OMAI-1873).
 *  위젯 파일은 AAS 서버에서 직접 불러온다(호스트에 복사하지 않아 버전이 늘 같다). 코드라 번역하지 않는다 */
export function hostSnippet(aasUrl: string, mode: EmbedMode): string {
  const base = (aasUrl || '<AAS URL>').replace(/\/+$/, '');
  // host-signed 토큰은 5분 안에 끝나고 한 번만 받으므로, 위젯이 교환할 때마다 호스트 서버에서 새로 받아 오게 한다.
  // 실패 응답(로그인 페이지 HTML 등)을 토큰으로 넘기지 않도록 r.ok 를 본다
  const token =
    mode === 'keycloak'
      ? ["        accessTokenCookie: 'COGENTAI_TOKEN',"]
      : [
          '        // called on every exchange: return a fresh host-signed JWT (valid for 5 minutes or less)',
          '        getAccessToken: function () {',
          "          return fetch('/my-app/aas-token', { credentials: 'include' })",
          "            .then(function (r) { return r.ok ? r.text() : ''; });",
          '        },',
        ];
  return [
    '<script>',
    '  (function () {',
    `    var AAS_URL = '${base}';`,
    "    var script = document.createElement('script');",
    "    script.src = AAS_URL + '/static/js/aas-widget.js';",
    '    script.async = true;',
    '    script.onload = function () {',
    '      // call window.aasWidget.destroy() when the user signs out',
    '      window.aasWidget = window.CogentAIAASWidget.init({',
    '        backendUrl: AAS_URL,',
    ...token,
    "        theme: 'light',",
    "        langCode: 'ko',",
    "        position: 'bottom-left',",
    '      });',
    '    };',
    '    document.head.appendChild(script);',
    '  })();',
    '</script>',
  ].join('\n');
}

/** host-signed 토큰의 내용(서명 전 JSON). exp 는 발급 시각 + 300초 이하 */
export function claimsExample(appId: string, aud: string): string {
  return JSON.stringify(
    { iss: appId || '<app_id>', aud: aud || '<AAS URL>', email: 'user@example.com', exp: '<now + 300>', jti: '<random, once>' },
    null,
    2
  );
}

function CopyBlock({ text, label, testId }: { text: string; label: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  return (
    <Box>
      <Box
        component="pre"
        data-testid={testId}
        aria-label={label}
        sx={{ m: 0, fontFamily: monoFont, fontSize: 12, px: 1.5, py: 1, border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: 'action.hover', overflowX: 'auto' }}
      >
        {text}
      </Box>
      <Button size="small" variant="outlined" color="inherit" sx={{ mt: 0.5 }} onClick={copy} aria-label={`${t('embedApps.copy')}: ${label}`}>
        {copied ? t('embedApps.copied') : t('embedApps.copy')}
      </Button>
      <Box component="span" aria-live="polite" sx={visuallyHidden}>
        {copied ? t('embedApps.copied') : ''}
      </Box>
    </Box>
  );
}

export function EmbedAppEditor({ x, meta }: { x?: EmbedApp; meta: EmbedAppsResp }) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const { closeDrawer } = useUi();
  const confirm = useConfirm();
  const base = useId();
  const [d, setD] = useState<Draft>(() => seed(x));
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fieldId = (f: Field) => `${base}-${f}`;
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setD((p) => ({ ...p, [k]: v }));
    setErrors((e) => ({ ...e, [k === 'idp' ? 'idp_policy_checked' : k]: undefined }));
  };
  const focus = (f: Field) => setTimeout(() => document.getElementById(fieldId(f))?.focus(), 0);
  const refresh = () => qc.invalidateQueries({ queryKey: EMBED_APPS_KEY });
  const aud = meta.audiences[0] || meta.aas_url;

  const save = async () => {
    const found = checkDraft(d);
    setErrors(found);
    setError('');
    const first = FIELDS.find((f) => found[f]);
    if (first) return focus(first);
    setBusy(true);
    try {
      const r = await post<{ ok: boolean; app: EmbedApp }>(EMBED_APPS_PATH, {
        action: 'save',
        ...(d.app_id ? { app_id: d.app_id } : {}),
        name: d.name.trim(),
        origins: originList(d.origins),
        mode: d.mode,
        ...(d.mode === 'keycloak'
          ? {
              issuer: d.issuer.trim(),
              jwks_url: d.jwks_url.trim(),
              audience: d.audience.trim(),
              idp_policy_checked: d.idp,
              login_client_id: d.login_client_id.trim(),
              login_client_secret: d.login_client_secret.trim(),
            }
          : { public_jwk: d.public_jwk.trim() }),
        default_agent: d.default_agent,
      });
      enqueueSnackbar(t('embedApps.saved', { name: r.app.name }), { variant: 'success' });
      await refresh();
      closeDrawer();
    } catch (e) {
      const f = e instanceof ApiError ? (e.field as Field) : '';
      if (f && (FIELDS as readonly string[]).includes(f)) {
        setErrors({ [f]: (e as Error).message });
        focus(f);
      } else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!x) return;
    const ok = await confirm(t('embedApps.removeBody'), { title: t('embedApps.removeAsk', { name: x.name }), confirmLabel: t('embedApps.remove'), danger: true });
    if (!ok) return;
    try {
      await post(EMBED_APPS_PATH, { action: 'remove', app_id: x.app_id });
      enqueueSnackbar(t('embedApps.removed', { name: x.name }), { variant: 'success' });
      await refresh();
      closeDrawer();
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
    }
  };

  const text = (f: 'name' | 'issuer' | 'jwks_url' | 'audience' | 'login_client_id', label: string, help?: string) => (
    <TextField
      size="small"
      id={fieldId(f)}
      label={label}
      value={d[f]}
      onChange={(e) => set(f, e.target.value)}
      error={!!errors[f]}
      helperText={errors[f] || help}
    />
  );

  return (
    <Stack spacing={2} component="form" noValidate onSubmit={(e) => (e.preventDefault(), void save())}>
      {error && <Alert severity="error">{error}</Alert>}
      {x && (
        <Typography variant="body2" color="text.secondary">
          {t('embedApps.appId')}: <Box component="code" sx={{ fontFamily: monoFont }}>{x.app_id}</Box>
        </Typography>
      )}
      {text('name', t('embedApps.name'))}
      <TextField
        size="small"
        id={fieldId('origins')}
        label={t('embedApps.origins')}
        value={d.origins}
        multiline
        minRows={2}
        placeholder="https://<host>"
        onChange={(e) => set('origins', e.target.value)}
        error={!!errors.origins}
        helperText={errors.origins || t('embedApps.originsHelp')}
      />
      <Box>
        <Typography id={`${base}-mode-label`} variant="subtitle2" sx={{ mb: 0.5 }}>
          {t('embedApps.col.mode')}
        </Typography>
        <RadioGroup aria-labelledby={`${base}-mode-label`} value={d.mode} onChange={(e) => set('mode', e.target.value as EmbedMode)}>
          {MODES.map((m) => (
            <FormControlLabel
              key={m}
              value={m}
              control={<Radio size="small" {...(m === 'keycloak' ? { id: fieldId('mode') } : {})} />}
              label={
                <Box>
                  <Box component="span" sx={{ fontWeight: 500 }}>
                    {t(`embedApps.mode.${m}`)}
                  </Box>
                  <Typography variant="caption" color="text.secondary" component="div">
                    {t(`embedApps.modeUse.${m}`)}
                  </Typography>
                </Box>
              }
            />
          ))}
        </RadioGroup>
        {errors.mode && <FormHelperText error>{errors.mode}</FormHelperText>}
      </Box>
      {d.mode === 'keycloak' ? (
        <>
          {text('issuer', t('embedApps.issuer'), t('embedApps.issuerHelp'))}
          {text('jwks_url', t('embedApps.jwksUrl'), t('embedApps.jwksUrlHelp'))}
          {text('audience', t('embedApps.audience'), t('embedApps.audienceHelp'))}
          <Box>
            <FormControlLabel
              control={<Checkbox id={fieldId('idp_policy_checked')} checked={d.idp} onChange={(e) => set('idp', e.target.checked)} />}
              label={t('embedApps.idpChecked')}
            />
            <FormHelperText error={!!errors.idp_policy_checked}>{errors.idp_policy_checked || t('embedApps.idpHelp')}</FormHelperText>
          </Box>
          {text('login_client_id', t('embedApps.loginClientId'), t('embedApps.loginClientIdHelp'))}
          {missingLoginClaim(meta, d.issuer.trim(), d.login_client_id.trim()) && (
            <Alert severity="warning" data-testid="embed-login-claim">
              {t('embedApps.loginClaimMissing', { client: d.login_client_id.trim() })}
            </Alert>
          )}
          <TextField
            size="small"
            type="password"
            autoComplete="new-password"
            id={fieldId('login_client_secret')}
            label={t('embedApps.loginClientSecret')}
            value={d.login_client_secret}
            placeholder={x?.login_client_secret_set ? t('embedApps.loginClientSecretSet') : undefined}
            onChange={(e) => set('login_client_secret', e.target.value)}
            error={!!errors.login_client_secret}
            helperText={errors.login_client_secret || t('embedApps.loginClientSecretHelp')}
            slotProps={{ inputLabel: { shrink: x?.login_client_secret_set || !!d.login_client_secret || undefined } }}
          />
        </>
      ) : (
        <TextField
          size="small"
          id={fieldId('public_jwk')}
          label={t('embedApps.publicJwk')}
          value={d.public_jwk}
          multiline
          minRows={4}
          placeholder='{"kty":"RSA","n":"…","e":"AQAB"}'
          onChange={(e) => set('public_jwk', e.target.value)}
          error={!!errors.public_jwk}
          helperText={errors.public_jwk || t('embedApps.publicJwkHelp')}
          slotProps={{ htmlInput: { style: { fontFamily: monoFont, fontSize: 12 } } }}
        />
      )}
      <TextField
        select
        size="small"
        id={fieldId('default_agent')}
        label={t('embedApps.agent')}
        value={d.default_agent}
        onChange={(e) => set('default_agent', e.target.value)}
        error={!!errors.default_agent}
        helperText={errors.default_agent || t('embedApps.agentHelp')}
      >
        <MenuItem value="">{t('embedApps.agentNone')}</MenuItem>
        {[...new Set([...meta.agents, ...(d.default_agent ? [d.default_agent] : [])])].map((id) => (
          <MenuItem key={id} value={id}>
            {id}
          </MenuItem>
        ))}
      </TextField>
      {x && <Alert severity="info">{t('embedApps.trustNote')}</Alert>}
      <Stack direction="row" spacing={1}>
        <Button type="submit" variant="contained" disabled={busy}>
          {busy ? t('embedApps.saving') : t('embedApps.save')}
        </Button>
        {x && (
          <Button variant="outlined" color="error" onClick={() => void remove()}>
            {t('embedApps.remove')}
          </Button>
        )}
      </Stack>
      <Box>
        <Typography variant="subtitle2">{t('embedApps.code')}</Typography>
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 1 }}>
          {t('embedApps.codeHelp')} {t(d.mode === 'keycloak' ? 'embedApps.codeKeycloak' : 'embedApps.codeHostSigned')}
        </Typography>
        <CopyBlock text={hostSnippet(meta.aas_url, d.mode)} label={t('embedApps.code')} testId="embed-code" />
        {d.mode === 'host-signed' && (
          <Box sx={{ mt: 1.5 }}>
            <Typography variant="subtitle2">{t('embedApps.claims')}</Typography>
            {!d.app_id && (
              <Typography variant="caption" color="text.secondary" component="p">
                {t('embedApps.claimsAfterSave')}
              </Typography>
            )}
            <CopyBlock text={claimsExample(d.app_id, aud)} label={t('embedApps.claims')} testId="embed-claims" />
          </Box>
        )}
      </Box>
      {x && <EmbedAppFormats appId={x.app_id} aasUrl={meta.aas_url} />}
    </Stack>
  );
}

const when = (sec: number) => (sec ? new Date(sec * 1000).toLocaleDateString(localeOf()) : '');

const COLUMNS = (): GridColumn<EmbedApp>[] => [
  { id: 'name', label: t('embedApps.col.name'), value: (x) => x.name, width: 'minmax(160px, 2fr)', hideable: false },
  {
    id: 'mode',
    label: t('embedApps.col.mode'),
    value: (x) => t(`embedApps.mode.${x.mode}`),
    width: '170px',
    render: (x) => (
      <Pill flush tone={x.mode === 'keycloak' ? 'info' : undefined}>
        {t(`embedApps.mode.${x.mode}`)}
      </Pill>
    ),
  },
  { id: 'origins', label: t('embedApps.col.origins'), value: (x) => x.origins.join(', '), width: 'minmax(220px, 3fr)' },
  { id: 'agent', label: t('embedApps.col.agent'), value: (x) => x.default_agent, width: 'minmax(140px, 1fr)' },
  { id: 'created', label: t('embedApps.col.created'), value: (x) => String(x.created), render: (x) => when(x.created), width: '120px' },
];

export function EmbedApps() {
  const q = useQuery<EmbedAppsResp>({ queryKey: EMBED_APPS_KEY, queryFn: () => get<EmbedAppsResp>(EMBED_APPS_PATH) });
  const { openDrawer } = useUi();
  const meta = q.data;
  const apps = meta?.apps ?? [];
  const openNew = () => meta && openDrawer({ title: t('embedApps.newTitle'), body: <EmbedAppEditor meta={meta} /> });
  const openEdit = (x: EmbedApp) => meta && openDrawer({ title: x.name, sub: t(`embedApps.mode.${x.mode}`), body: <EmbedAppEditor key={x.app_id} x={x} meta={meta} /> });
  const banner = !meta
    ? null
    : !meta.auth_enabled
      ? { severity: 'warning' as const, message: t('embedApps.authOff') }
      : !meta.ws_enabled
        ? { severity: 'warning' as const, message: t('embedApps.wsOff') }
        : null;
  return (
    <ListView<EmbedApp>
      title={t('views.embed-apps.label')}
      sub={t('views.embed-apps.sub')}
      error={q.error?.message}
      banner={banner}
      tabs={[{ id: 'all', label: t('embedApps.all'), items: apps, empty: q.data ? t('embedApps.empty') : undefined }]}
      text={(x) => [x.name, x.app_id, ...x.origins, x.issuer, x.default_agent].join(' ')}
      gridAction={meta ? { label: t('embedApps.new'), onClick: openNew } : null}
      onRow={openEdit}
      id="embed-apps"
      columns={COLUMNS()}
      rowId={(x) => x.app_id}
      rowName={(x) => x.name}
      note={t('embedApps.note')}
    />
  );
}
