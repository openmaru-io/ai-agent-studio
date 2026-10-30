/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 프로파일 서랍 「MCP · 도구 묶음」 탭의 「서버 추가」 대화 상자(스펙 2026-10-15-025 §11): 원격 주소·프로그램 실행·카탈로그.
// 비밀 값(토큰·환경변수 값)은 점으로 가려 받고 저장할 때만 보낸다. 거절은 칸 아래(field)나 폼 위 경고 한 곳에 보인다.
import AddIcon from '@mui/icons-material/Add';
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  InputAdornment,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';

import { Tag } from '@/components/bits';
import { useConfirm } from '@/components/ConfirmDialog';
import { DisclosureButton } from '@/components/DisclosureButton';
import { ItemList, ItemRow } from '@/components/ItemRow';
import { tier1, tier2 } from '@/components/tierButton';
import { RequestAdminButton } from '@/features/requests/RequestAdminButton';
import { t } from '@/i18n';
import { ApiError } from '@/lib/api';
import { MONO_FONT } from '@/lib/monoFont';

import { calmAlertSx, useProfileAct } from './shared';

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/;
const ENV_NAME_RE = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/;
const TOUCH = { minHeight: 44, minWidth: 44 };

type Kind = 'url' | 'stdio' | 'catalog';
interface EnvRow {
  id: number;
  name: string;
  value: string;
}
interface CatalogEntry {
  name: string;
  description: string;
  transport: string;
  installed: boolean;
  /** secret: false 면 가리지 않는 칸(주소 등), value 는 미리 채울 값 */
  required_env: { name: string; prompt: string; required: boolean; secret?: boolean; value?: string }[];
  /** AAS 가 만든 항목(Docmost 2026-10-23-002 12-6, Outline 2026-10-23-004). 쓰기 도구를 고르고 켜고 끈다 */
  builtin?: boolean;
  write?: boolean;
  /** none·api_key·oauth. OAuth 는 원격 주소 항목만 온다(스펙 2026-10-16-010 Q5) */
  auth_type?: string;
  url?: string;
  /** 주소의 가능 여부(4-7). blocked 면 설치할 수 없다 */
  network?: { verdict: string; message: string };
}
/** AAS 항목 설치 결과(mcp_install). 도구 묶음 끄기·스킬 설치가 실패해도 설치는 성공이라 따로 알린다 */
interface BuiltinInstall {
  browser_off?: boolean;
  connections_off?: boolean;
  skill?: string;
}
/** 항목별 쓰기 스위치 동작과 문구. Outline 은 삭제 도구를 등록하지 않는다(2026-10-23-004 Q3) */
const writeAction = (n: string) => (n === 'outline' ? 'mcp_outline_write' : 'mcp_docmost_write');
const writeLabel = (n: string) => t(n === 'outline' ? 'profiles.mcp.outlineWrite' : 'profiles.mcp.docmostWrite');
const writeHelp = (n: string) => t(n === 'outline' ? 'profiles.mcp.outlineWriteHelp' : 'profiles.mcp.docmostWriteHelp');
/** 설치 결과에서 사용자에게 알릴 것만 문장으로 */
export function builtinNotes(r: BuiltinInstall): string[] {
  const out: string[] = [];
  if (r.browser_off === false) out.push(t('profiles.mcp.browserOffFailed'));
  if (r.connections_off === false) out.push(t('profiles.mcp.connectionsOffFailed'));
  if (r.skill === 'failed' || r.skill === 'busy') out.push(t('profiles.mcp.skillFailed'));
  if (r.skill === 'queued_later') out.push(t('profiles.mcp.skillLater'));
  return out;
}
interface CatalogData {
  entries: CatalogEntry[];
  hidden: { oauth: number; install: number; unknown: number };
}

/** 비밀 값 칸 아래 안내. 참조 꼴(${이름})은 자리표시자와 헷갈리지 않게 값으로 넘긴다 */
const secretNote = () => t('profiles.mcp.secretNote', { ref: '${' + t('profiles.mcp.refName') + '}' });

const useNarrow = () => useMediaQuery(useTheme().breakpoints.down('sm'));

/** 점으로 가린 비밀 값 칸. 오른쪽 아이콘으로 세션 안에서만 잠깐 확인한다(스펙 §11 결정 8A) */
function SecretField({
  label,
  value,
  onChange,
  error,
  helper,
  inputRef,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  helper?: string;
  inputRef?: (el: HTMLInputElement | null) => void;
  required?: boolean;
}) {
  const [shown, setShown] = useState(false);
  const helpId = useId();
  return (
    <TextField
      size="small"
      fullWidth
      required={required}
      label={label}
      type={shown ? 'text' : 'password'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      error={!!error}
      helperText={error || helper}
      inputRef={inputRef}
      slotProps={{
        htmlInput: { autoComplete: 'off', 'aria-describedby': helper || error ? helpId : undefined, style: { fontFamily: MONO_FONT } },
        formHelperText: { id: helpId },
        input: {
          endAdornment: (
            <InputAdornment position="end">
              <IconButton
                size="small"
                edge="end"
                sx={TOUCH}
                aria-pressed={shown}
                aria-label={t(shown ? 'profiles.mcp.hide' : 'profiles.mcp.show', { label })}
                onClick={() => setShown((v) => !v)}
              >
                {shown ? <VisibilityOffOutlinedIcon fontSize="small" /> : <VisibilityOutlinedIcon fontSize="small" />}
              </IconButton>
            </InputAdornment>
          ),
        },
      }}
    />
  );
}

function CatalogList({
  name,
  onInstalled,
  onChanged,
  setError,
  secure,
}: {
  name: string;
  onInstalled: (n: string, info: { oauth: boolean; notes?: string[] }) => void;
  /** 설치한 항목의 설정을 바꿨다(Docmost·Outline 쓰기 도구). 부모가 「지금 적용」 배너를 켠다 */
  onChanged?: () => void;
  setError: (m: string) => void;
  secure: boolean;
}) {
  const { act } = useProfileAct(name);
  const q = useQuery<CatalogData>({ queryKey: ['mcp-catalog', name], queryFn: () => act<CatalogData>('mcp_catalog'), staleTime: 60_000 });
  const [env, setEnv] = useState<Record<string, Record<string, string>>>({});
  const [writes, setWrites] = useState<Record<string, boolean>>({});
  const [switched, setSwitched] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState('');
  const [search, setSearch] = useState('');
  const searchFocused = useRef(false);
  if (q.isLoading) return <Typography color="text.secondary">{t('profiles.mcp.catalogLoading')}</Typography>;
  if (q.isError || !q.data)
    return (
      <Alert severity="warning" sx={calmAlertSx} action={<Button startIcon={<RefreshIcon />} size="small" color="inherit" onClick={() => q.refetch()}>{t('profiles.mcp.catalogRetry')}</Button>}>
        {t('profiles.mcp.catalogFailed')}
      </Alert>
    );
  const { entries, hidden } = q.data;
  const valueOf = (e: CatalogEntry, v: CatalogEntry['required_env'][number]) => env[e.name]?.[v.name] ?? v.value ?? '';
  const envOf = (e: CatalogEntry) => {
    const out: Record<string, string> = { ...(env[e.name] ?? {}) };
    for (const v of e.required_env) if (out[v.name] === undefined && v.value) out[v.name] = v.value;
    return out;
  };
  const install = async (e: CatalogEntry) => {
    setBusy(e.name);
    setError('');
    try {
      const r = await act<BuiltinInstall>('mcp_install', { server: e.name, env: envOf(e), ...(e.builtin ? { write: !!writes[e.name] } : {}) });
      const notes = e.builtin && r ? builtinNotes(r) : [];
      onInstalled(e.name, notes.length ? { oauth: e.auth_type === 'oauth', notes } : { oauth: e.auth_type === 'oauth' });
    } catch (er) {
      setError((er as Error).message);
    }
    setBusy('');
  };
  const toggleWrite = async (e: CatalogEntry, on: boolean) => {
    setBusy(e.name);
    setError('');
    try {
      await act(writeAction(e.name), { write: on });
      // 게이트웨이의 자동 반영은 서버가 생기고 없어지는 것만 본다 — 도구 범위는 다시 시작해야 쓴다(스펙 2026-10-23-002 12-7)
      setSwitched((s) => ({ ...s, [e.name]: true }));
      onChanged?.();
      await q.refetch();
    } catch (er) {
      setError((er as Error).message);
    }
    setBusy('');
  };
  const hiddenCount = hidden.oauth + hidden.install + hidden.unknown;
  // 검색(2026-10-23): 이름·설명에서 대소문자 없이 찾는다. 대화 상자 뒤 서랍에도 검색 칸이 있어 「/」 단축키 표식(data-view-search)은 달지 않는다
  const needle = search.trim().toLowerCase();
  const shown = needle ? entries.filter((e) => `${e.name} ${e.description}`.toLowerCase().includes(needle)) : entries;
  return (
    <Box>
      {entries.length > 0 && (
        <TextField
          size="small"
          type="search"
          fullWidth
          placeholder={t('profiles.mcp.catalogSearch')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          slotProps={{ htmlInput: { 'aria-label': t('profiles.mcp.catalogSearch'), autoComplete: 'off' } }}
          // 목록은 대화 상자가 열린 뒤에 읽혀 onEntered 때 이 칸이 없을 수 있다. 처음 그려질 때 한 번만, 다른 칸에 있지 않으면 커서를 둔다
          // (ref 함수는 다시 그릴 때마다 불려 한 번으로 막지 않으면 「설치」 단추를 누른 뒤 커서가 이 칸으로 튄다)
          inputRef={(el: HTMLInputElement | null) => {
            if (!el || searchFocused.current) return;
            searchFocused.current = true;
            const on = document.activeElement?.tagName;
            if (on !== 'INPUT' && on !== 'TEXTAREA') el.focus();
          }}
          sx={{ mb: 1 }}
        />
      )}
      {entries.length === 0 ? (
        <Typography color="text.secondary">{t('profiles.mcp.catalogEmpty')}</Typography>
      ) : shown.length === 0 ? (
        <Typography color="text.secondary">{t('profiles.mcp.catalogNoMatch', { q: search.trim() })}</Typography>
      ) : (
        <ItemList>
          {shown.map((e) => {
            const need = e.required_env.filter((v) => v.required);
            const filled = need.every((v) => valueOf(e, v).trim());
            return (
              <ItemRow
                key={e.name}
                icon={DnsOutlinedIcon}
                name={e.name}
                tags={
                  <>
                    <Tag>{e.transport || '?'}</Tag>
                    {e.auth_type === 'oauth' && <Tag>OAuth</Tag>}
                  </>
                }
                description={
                  e.network?.verdict === 'blocked'
                    ? e.network.message
                    : e.auth_type === 'oauth'
                    ? `${e.description} · ${t('profiles.mcp.catalogOauthNote')}`
                    : e.description
                }
                control={
                  e.installed && e.builtin ? (
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                      <Tag tone="good">{t('profiles.mcp.installed')}</Tag>
                      <FormControlLabel
                        sx={{ mr: 0 }}
                        control={<Switch size="small" checked={!!e.write} disabled={!!busy} onChange={(_, on) => toggleWrite(e, on)} slotProps={{ input: { role: 'switch' } }} />}
                        label={t('profiles.mcp.docmostWriteSwitch')}
                      />
                    </Stack>
                  ) : e.installed ? (
                    <Tag tone="good">{t('profiles.mcp.installed')}</Tag>
                  ) : (
                    <Button
                      size="small"
                      variant="outlined"
                      color="inherit"
                      sx={[tier1 as object, { minHeight: 32 }]}
                      aria-label={t('profiles.mcp.installOf', { name: e.name })}
                      disabled={!!busy || !filled || (!secure && need.length > 0) || e.network?.verdict === 'blocked'}
                      onClick={() => install(e)}
                    >
                      {t('profiles.mcp.install')}
                    </Button>
                  )
                }
                below={
                  e.installed && e.builtin && switched[e.name] ? (
                    <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.5 }}>
                      {t('profiles.mcp.docmostWriteApply')}
                    </Typography>
                  ) : !e.installed && e.required_env.length ? (
                    <Stack spacing={1} sx={{ mt: 1 }}>
                      {e.required_env.map((v) => {
                        const change = (val: string) => setEnv((s) => ({ ...s, [e.name]: { ...s[e.name], [v.name]: val } }));
                        return v.secret === false ? (
                          <TextField key={v.name} size="small" fullWidth label={v.name} required={v.required} helperText={v.prompt} value={valueOf(e, v)} onChange={(ev) => change(ev.target.value)} />
                        ) : (
                          <SecretField key={v.name} label={v.name} required={v.required} helper={v.prompt} value={valueOf(e, v)} onChange={change} />
                        );
                      })}
                      {e.builtin && (
                        <FormControlLabel
                          control={<Checkbox size="small" checked={!!writes[e.name]} onChange={(_, on) => setWrites((s) => ({ ...s, [e.name]: on }))} />}
                          label={writeLabel(e.name)}
                        />
                      )}
                      {e.builtin && writes[e.name] && (
                        <Typography variant="caption" color="text.secondary">
                          {writeHelp(e.name)}
                        </Typography>
                      )}
                    </Stack>
                  ) : undefined
                }
              />
            );
          })}
        </ItemList>
      )}
      {hiddenCount > 0 && (
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
          {t('profiles.mcp.catalogHidden', { oauth: hidden.oauth, other: hidden.install + hidden.unknown })}
        </Typography>
      )}
    </Box>
  );
}

export function AddServerDialog({
  open,
  name,
  secure,
  callbackUrl = '',
  admin = false,
  onClose,
  onAdded,
  onChanged,
}: {
  open: boolean;
  /** 프로파일 이름 */
  name: string;
  secure: boolean;
  /** 인가 서버에 등록할 AAS 콜백 주소. OAuth 를 고르면 복사할 수 있게 보인다(스펙 2026-10-16-010 V7) */
  callbackUrl?: string;
  /** 관리자: 이 환경에서 쓸 수 없다고 판정한 주소도 「그래도 추가」할 수 있다(스펙 2026-10-16-010 V16·Q7) */
  admin?: boolean;
  onClose: () => void;
  /** 서버 이름을 넘긴다. 부모가 대화 상자를 닫고 목록을 새로 읽는다. oauth: OAuth 로 추가한 원격 서버 */
  onAdded: (server: string, info?: { oauth: boolean; notes?: string[] }) => void;
  /** 이미 있는 서버의 설정을 바꿨다(카탈로그의 Docmost·Outline 쓰기 도구 스위치). 부모가 「지금 적용」 배너를 켠다 */
  onChanged?: () => void;
}) {
  const { act } = useProfileAct(name);
  const confirm = useConfirm();
  const fullScreen = useNarrow();
  const titleId = useId();
  // 카탈로그로 연다(2026-10-23, OMAI-1450): 고르기만 하면 되는 설치가 먼저, 직접 입력은 다음이다
  const [kind, setKind] = useState<Kind>('catalog');
  const [server, setServer] = useState('');
  const [url, setUrl] = useState('');
  const [authMode, setAuthMode] = useState<'none' | 'header' | 'oauth'>('none');
  const [copied, setCopied] = useState(false);
  const [net, setNet] = useState<{ verdict: string; message: string } | null>(null);
  const [showClient, setShowClient] = useState(false);
  const clientId = useId();
  const [client, setClient] = useState({ client_id: '', client_secret: '', scope: '' });
  const [token, setToken] = useState('');
  const [command, setCommand] = useState('uvx');
  const [argsText, setArgsText] = useState('');
  const [envRows, setEnvRows] = useState<EnvRow[]>([]);
  const nextId = useRef(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});
  const refs = useRef<Record<string, HTMLInputElement | null>>({});

  const dirty = !!(server || url || token || argsText || envRows.length);
  const wantsSecret =
    (kind === 'url' && authMode === 'header') ||
    (kind === 'url' && authMode === 'oauth' && !!client.client_secret) ||
    (kind === 'stdio' && envRows.some((r) => r.value));
  const blocked = kind === 'url' && net?.verdict === 'blocked';
  // 주소 칸 아래 가능 여부(V2): 입력이 멈추고 300ms 뒤에 서버 설정(외부 접속 모드·허용 목록)으로 판정한다. 서버는 그 주소로 요청하지 않는다(R8)
  useEffect(() => {
    if (kind !== 'url' || !/^https?:\/\/\S+/.test(url.trim())) {
      setNet(null);
      return;
    }
    let stop = false;
    const timer = setTimeout(() => {
      act<{ verdict: string; message: string }>('mcp_url_check', { url: url.trim() })
        .then((r) => !stop && setNet(r))
        .catch(() => !stop && setNet(null));
    }, 300);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [kind, url, act]);
  const blockedBySecure = wantsSecret && !secure;
  const nameBad = server !== '' && !NAME_RE.test(server) ? t('profiles.mcp.nameHelp') : '';
  const envBad = envRows.some((r) => r.name && !ENV_NAME_RE.test(r.name));
  const ready =
    NAME_RE.test(server) &&
    !blockedBySecure &&
    !blocked &&
    !(authMode === 'oauth' && client.client_secret && !client.client_id.trim()) &&
    (kind === 'url'
      ? /^https?:\/\/\S+/.test(url) && (authMode !== 'header' || !!token.trim())
      : kind === 'stdio'
      ? !!command.trim() && !envBad && envRows.every((r) => !r.name === !r.value)
      : false);

  const reset = () => {
    setServer('');
    setUrl('');
    setToken('');
    setAuthMode('none');
    setCopied(false);
    setNet(null);
    setShowClient(false);
    setClient({ client_id: '', client_secret: '', scope: '' });
    setCommand('uvx');
    setArgsText('');
    setEnvRows([]);
    setError('');
    setFieldErr({});
    setKind('catalog');
  };
  const close = async () => {
    if (busy) return;
    if (dirty && !(await confirm(t('profiles.mcp.discard')))) return;
    reset();
    onClose();
  };
  const added = (s: string, info: { oauth: boolean; notes?: string[] }) => {
    reset();
    onAdded(s, info);
  };
  const submit = async (force = false) => {
    setBusy(true);
    setError('');
    setFieldErr({});
    try {
      const body =
        kind === 'url'
          ? {
              kind,
              server,
              url: url.trim(),
              auth: authMode,
              ...(authMode === 'header' ? { bearer_token: token } : {}),
              ...(authMode === 'oauth' && (client.client_id || client.client_secret || client.scope)
                ? { oauth_client: Object.fromEntries(Object.entries(client).filter(([, v]) => v.trim())) }
                : {}),
              ...(force ? { force: true } : {}),
            }
          : {
              kind,
              server,
              command: command.trim(),
              args: argsText.split('\n').map((l) => l.trim()).filter(Boolean),
              env: Object.fromEntries(envRows.filter((r) => r.name).map((r) => [r.name, r.value])),
            };
      await act('mcp_add', body);
      added(server, { oauth: kind === 'url' && authMode === 'oauth' });
    } catch (e) {
      const field = e instanceof ApiError ? e.field : '';
      const message = (e as Error).message || t('profiles.mcp.saveFailed');
      if (field && field in { name: 1, url: 1, bearer_token: 1, command: 1, args: 1, env: 1, client_id: 1, client_secret: 1, scope: 1 }) {
        const key = field === 'name' ? 'server' : field;
        setFieldErr({ [key]: message });
        setTimeout(() => refs.current[key]?.focus(), 0);
      } else {
        setError(message);
      }
    }
    setBusy(false);
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      aria-labelledby={titleId}
      fullWidth
      maxWidth="sm"
      fullScreen={fullScreen}
      slotProps={{
        transition: {
          // 열린 뒤 처음 입력 칸에 커서를 둔다. 사용자가 이미 다른 칸을 눌렀으면 빼앗지 않는다
          onEntered: () => {
            const on = document.activeElement?.tagName;
            if (on !== 'INPUT' && on !== 'TEXTAREA' && on !== 'BUTTON') refs.current.server?.focus();
          },
        },
      }}
    >
      <DialogTitle id={titleId}>{t('profiles.mcp.addTitle')}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          <ToggleButtonGroup
            exclusive
            size="small"
            fullWidth
            value={kind}
            aria-label={t('profiles.mcp.kindLabel')}
            onChange={(_, v: Kind | null) => {
              if (!v) return;
              setKind(v);
              setError('');
              setFieldErr({});
              setUrl('');
              setToken('');
              setArgsText('');
              setEnvRows([]);
            }}
            sx={{ flexWrap: 'wrap' }}
          >
            {(['catalog', 'url', 'stdio'] as Kind[]).map((k) => (
              <ToggleButton key={k} value={k} sx={{ flex: 1 }}>
                {t(`profiles.mcp.kind.${k}`)}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>

          {error && (
            <Alert severity="warning" sx={calmAlertSx}>
              {error}
            </Alert>
          )}
          {blockedBySecure && (
            <Alert severity="warning" sx={calmAlertSx}>
              {t('profiles.mcp.insecure')}
            </Alert>
          )}

          {kind !== 'catalog' && (
            <TextField
              size="small"
              required
              label={t('profiles.mcp.name')}
              value={server}
              onChange={(e) => setServer(e.target.value)}
              error={!!(nameBad || fieldErr.server)}
              helperText={fieldErr.server || nameBad || t('profiles.mcp.nameHelp')}
              inputRef={(el) => {
                refs.current.server = el;
              }}
              slotProps={{ htmlInput: { autoComplete: 'off' } }}
            />
          )}

          {kind === 'url' && (
            <>
              <TextField
                size="small"
                required
                label={t('profiles.mcp.url')}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                error={!!fieldErr.url}
                helperText={fieldErr.url || (net && !blocked ? net.message : '')}
                inputRef={(el) => {
                  refs.current.url = el;
                }}
                slotProps={{ htmlInput: { autoComplete: 'off', inputMode: 'url', style: { fontFamily: MONO_FONT } } }}
              />
              {blocked && net && (
                <Alert
                  severity="warning"
                  sx={calmAlertSx}
                  action={
                    admin ? (
                      <Button
                        size="small"
                        variant="outlined"
                        color="inherit"
                        sx={[tier2 as object, { minHeight: 36 }]}
                        disabled={busy || !NAME_RE.test(server)}
                        onClick={async () => {
                          if (await confirm(t('profiles.mcp.forceConfirm', { reason: net.message }))) void submit(true);
                        }}
                      >
                        {t('profiles.mcp.force')}
                      </Button>
                    ) : (
                      <RequestAdminButton
                        profile={name}
                        kind="other"
                        label={t('profiles.mcp.askAdmin')}
                        detail={t('profiles.mcp.askAdminDetail', { url: url.trim(), reason: net.message })}
                      />
                    )
                  }
                >
                  {net.message}
                </Alert>
              )}
              <ToggleButtonGroup
                exclusive
                size="small"
                value={authMode}
                aria-label={t('profiles.mcp.auth')}
                onChange={(_, v: 'none' | 'header' | 'oauth' | null) => v && setAuthMode(v)}
              >
                {(['none', 'header', 'oauth'] as const).map((a) => (
                  <ToggleButton key={a} value={a}>
                    {t(`profiles.mcp.auth.${a}`)}
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
              {authMode === 'oauth' && (
                <Box>
                  <TextField
                    size="small"
                    fullWidth
                    label={t('profiles.mcp.oauthCallback')}
                    value={callbackUrl}
                    helperText={t('profiles.mcp.oauthCallbackHelp')}
                    slotProps={{
                      htmlInput: { readOnly: true, style: { fontFamily: MONO_FONT } },
                      input: {
                        endAdornment: (
                          <InputAdornment position="end">
                            <Button
                              startIcon={<ContentCopyOutlinedIcon />}
                              size="small"
                              sx={TOUCH}
                              disabled={!callbackUrl}
                              onClick={() => {
                                void navigator.clipboard?.writeText(callbackUrl).then(() => setCopied(true));
                              }}
                            >
                              {copied ? t('profiles.mcp.copied') : t('profiles.mcp.copy')}
                            </Button>
                          </InputAdornment>
                        ),
                      },
                    }}
                  />
                  <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.5 }}>
                    {t('profiles.mcp.oauthNext')}
                  </Typography>
                  {/* 왼쪽 여백 -5px 로 아이콘을 입력 칸 왼쪽 선에 맞춘다(스펙 2026-10-19-005 G10) */}
                  <DisclosureButton
                    open={showClient}
                    onToggle={() => setShowClient((v) => !v)}
                    controls={clientId}
                    sx={{ mt: 0.5, ml: -0.625, minHeight: 36 }}
                    label={t('profiles.mcp.client')}
                  />
                  {showClient && (
                    <Stack id={clientId} spacing={1.5} sx={{ mt: 1 }}>
                      <TextField
                        size="small"
                        label="client_id"
                        value={client.client_id}
                        onChange={(e) => setClient((c) => ({ ...c, client_id: e.target.value }))}
                        error={!!fieldErr.client_id}
                        helperText={fieldErr.client_id}
                        slotProps={{ htmlInput: { autoComplete: 'off', style: { fontFamily: MONO_FONT } } }}
                      />
                      <SecretField
                        label="client_secret"
                        value={client.client_secret}
                        onChange={(v) => setClient((c) => ({ ...c, client_secret: v }))}
                        error={fieldErr.client_secret}
                        helper={secretNote()}
                      />
                      <TextField
                        size="small"
                        label="scope"
                        value={client.scope}
                        onChange={(e) => setClient((c) => ({ ...c, scope: e.target.value }))}
                        helperText={fieldErr.scope || t('profiles.mcp.scopeHelp')}
                        error={!!fieldErr.scope}
                        slotProps={{ htmlInput: { autoComplete: 'off', style: { fontFamily: MONO_FONT } } }}
                      />
                    </Stack>
                  )}
                </Box>
              )}
              {authMode === 'header' && (
                <SecretField
                  required
                  label={t('profiles.mcp.token')}
                  value={token}
                  onChange={setToken}
                  error={fieldErr.bearer_token}
                  helper={secretNote()}
                  inputRef={(el) => {
                    refs.current.bearer_token = el;
                  }}
                />
              )}
            </>
          )}

          {kind === 'stdio' && (
            <>
              <TextField
                size="small"
                required
                label={t('profiles.mcp.command')}
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                error={!!fieldErr.command}
                helperText={fieldErr.command || t('profiles.mcp.commandHelp')}
                inputRef={(el) => {
                  refs.current.command = el;
                }}
                slotProps={{ htmlInput: { autoComplete: 'off', style: { fontFamily: MONO_FONT } } }}
              />
              <TextField
                size="small"
                multiline
                minRows={2}
                label={t('profiles.mcp.args')}
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                error={!!fieldErr.args}
                helperText={fieldErr.args || t('profiles.mcp.argsHelp')}
                inputRef={(el) => {
                  refs.current.args = el as HTMLInputElement | null;
                }}
                slotProps={{ htmlInput: { autoComplete: 'off', style: { fontFamily: MONO_FONT } } }}
              />
              <Box role="group" aria-label={t('profiles.mcp.env')}>
                <Typography variant="subtitle2" component="div" sx={{ mb: 0.5 }}>
                  {t('profiles.mcp.env')}
                </Typography>
                <Stack spacing={1}>
                  {envRows.map((r) => (
                    <Stack key={r.id} direction="row" spacing={1} alignItems="flex-start">
                      <TextField
                        size="small"
                        label={t('profiles.mcp.envName')}
                        value={r.name}
                        error={!!r.name && !ENV_NAME_RE.test(r.name)}
                        onChange={(e) => setEnvRows((rows) => rows.map((x) => (x.id === r.id ? { ...x, name: e.target.value.toUpperCase() } : x)))}
                        sx={{ flex: 1 }}
                        slotProps={{ htmlInput: { autoComplete: 'off', style: { fontFamily: MONO_FONT } } }}
                      />
                      <Box sx={{ flex: 1.4 }}>
                        <SecretField
                          label={t('profiles.mcp.envValue')}
                          value={r.value}
                          onChange={(v) => setEnvRows((rows) => rows.map((x) => (x.id === r.id ? { ...x, value: v } : x)))}
                        />
                      </Box>
                      <IconButton
                        sx={TOUCH}
                        aria-label={t('profiles.mcp.envRemove', { name: r.name || '…' })}
                        onClick={() => setEnvRows((rows) => rows.filter((x) => x.id !== r.id))}
                      >
                        <DeleteOutlineIcon fontSize="small" />
                      </IconButton>
                    </Stack>
                  ))}
                </Stack>
                {fieldErr.env && (
                  <Typography variant="caption" color="error" component="p" role="alert">
                    {fieldErr.env}
                  </Typography>
                )}
                {envRows.length > 0 && (
                  <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.5 }}>
                    {secretNote()}
                  </Typography>
                )}
                <Button
                  size="small"
                  variant="outlined"
                  color="inherit"
                  startIcon={<AddIcon />}
                  sx={[tier2 as object, { mt: 1, minHeight: 36 }]}
                  onClick={() => setEnvRows((rows) => [...rows, { id: nextId.current++, name: '', value: '' }])}
                >
                  {t('profiles.mcp.envAdd')}
                </Button>
              </Box>
            </>
          )}

          {kind === 'catalog' && (
            <CatalogList
              name={name}
              secure={secure}
              setError={setError}
              onInstalled={added}
              onChanged={onChanged}
            />
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ position: fullScreen ? 'sticky' : undefined, bottom: 0 }}>
        <Typography role="status" aria-live="polite" variant="caption" color="text.secondary" sx={{ mr: 'auto', pl: 1 }}>
          {busy ? t('profiles.mcp.saving') : ''}
        </Typography>
        <Button variant="outlined" color="inherit" sx={[tier2 as object, TOUCH]} onClick={close}>
          {t('common.cancel')}
        </Button>
        {kind !== 'catalog' && (
          <Button variant="outlined" color="inherit" sx={[tier1 as object, TOUCH]} disabled={!ready || busy} onClick={() => void submit()}>
            {t('profiles.mcp.submit')}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
