/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 비밀값 탭의 「인증 파일(JSON)」 구역(스펙 2026-10-22-004 §4-7, OMAI-1437).
// 내용은 화면에 그리지 않는다 — 파일을 고르면 이름·크기만 보이고 [저장]을 눌러야 보낸다(D10). 붙여넣기 상자는 없다(R8).
// auth.json 은 다루지 않는다(D23). 서버는 오류를 {code} 로만 보내고 문장은 화면이 번역 키로 고른다.
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import FileUploadOutlinedIcon from '@mui/icons-material/FileUploadOutlined';
import { Alert, Box, Button, CircularProgress, Skeleton, Stack, TextField, Typography, useMediaQuery, useTheme } from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useEffect, useRef, useState } from 'react';

import { Section, Tag } from '@/components/bits';
import { ItemList, ItemRow } from '@/components/ItemRow';
import { getLang, hasKey, t } from '@/i18n';
import { MONO_FONT } from '@/lib/monoFont';

import { calmAlertSx } from './shared';
import { useProfileSpot } from './spot';

export const MAX_BYTES = 64 * 1024;
const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export interface CredRow {
  slot: string;
  path: string;
  exists: boolean;
  type?: 'file' | 'unknown';
  mtime?: number;
  /** name 은 사람 이름. who(이메일 전체)는 관리자에게만 온다 */
  changed_by?: { name?: string; who?: string; role: string; ts: string } | null;
  outside?: boolean;
  outside_after?: boolean;
  by_other?: boolean;
}

export interface CredList {
  profile?: string;
  rows: CredRow[];
  reason: string;
  can_edit: boolean;
  admin: boolean;
}

export class CredError extends Error {
  constructor(public code: string, public status: number) {
    super(code);
  }
}

const q = (o: Record<string, string>) => new URLSearchParams(o).toString();

async function call<T>(method: 'GET' | 'PUT' | 'DELETE', url: string, body?: Blob): Promise<T> {
  let r: Response;
  try {
    r = await fetch(url, {
      method,
      body,
      headers: method === 'GET' ? { 'Accept-Language': getLang() } : { 'X-AAS': '1', 'Accept-Language': getLang(), 'Content-Type': 'application/json' },
    });
  } catch {
    throw new CredError('agent_unreachable', 0);
  }
  const out = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new CredError(String(out.code || 'unknown'), r.status);
  return out as T;
}

export const credKey = (pod: string | undefined, profile: string) => ['credential-files', pod ?? '', profile];
export const listCreds = (pod: string, profile: string) => call<CredList>('GET', `/api/profile/credential-files?${q({ pod, profile })}`);
export const putCred = (pod: string, profile: string, slot: string, file: Blob) =>
  call<{ ok: boolean; mtime_ns: number }>('PUT', `/api/profile/credential-file?${q({ pod, profile, slot })}`, file);
export const clearCred = (pod: string, profile: string, slot: string, path: string) =>
  call<{ ok: boolean }>('DELETE', `/api/profile/credential-file?${q({ pod, profile, slot, confirm: path })}`);

/** 오류 코드 → 문장. 모르는 코드는 「작업이 실패했습니다」 */
export const errText = (code: string): string => {
  const key = `profiles.cred.err.${code}`;
  return hasKey(key) ? t(key as Parameters<typeof t>[0]) : t('profiles.cred.err.unknown');
};

/** 구역 위 사유 한 줄. 관리자에게는 원인과 할 일, 주인·팀 관리자에게는 「관리자에게 문의」(D19) */
export const reasonText = (reason: string, admin: boolean): string => {
  if (!reason) return '';
  if (reason === 'grant' || reason === 'insecure') return t(`profiles.cred.why.${reason}` as Parameters<typeof t>[0]);
  const key = `profiles.cred.why.${reason}${admin ? 'Admin' : ''}`;
  return hasKey(key) ? t(key as Parameters<typeof t>[0]) : t('profiles.cred.why.unavailable');
};

/** 「새 JSON 파일」 이름: 앞뒤 공백과 끝 .json 을 떼고 소문자로(D17). 규칙에 맞지 않으면 null */
export function normalizeName(raw: string): string | null {
  const s = raw.trim().replace(/\.json$/i, '').toLowerCase();
  return NAME.test(s) ? s : null;
}

/** 시각: 올해면 MM-DD HH:mm, 아니면 YYYY-MM-DD HH:mm(D18) */
export function fmtWhen(sec: number, now = new Date()): string {
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  const hm = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return d.getFullYear() === now.getFullYear() ? hm : `${d.getFullYear()}-${hm}`;
}

const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`);   // 작은 JSON 이 「0.0 KB」로 보이지 않게

const DESC: Record<string, string> = {
  google_client_secret: 'profiles.cred.desc.googleClientSecret',
  google_token: 'profiles.cred.desc.googleToken',
};

/** 고른 파일 검사(서버도 다시 본다). 맞으면 빈 문자열 */
export function pickProblem(f: { name: string; size: number }): string {
  if (!/\.json$/i.test(f.name)) return 'not_json_file';
  if (f.size > MAX_BYTES) return 'too_large';
  if (f.size === 0) return 'empty';
  return '';
}

type Mode = { kind: 'idle' } | { kind: 'pick'; file: File } | { kind: 'busy' } | { kind: 'clear' } | { kind: 'error'; code: string } | { kind: 'unknown'; before?: number };

function CredLine({ row, pod, profile, canEdit, focused, onDone }: { row: CredRow; pod: string; profile: string; canEdit: boolean; focused: boolean; onDone: () => Promise<CredList | undefined> }) {
  const { enqueueSnackbar } = useSnackbar();
  const [mode, setMode] = useState<Mode>({ kind: 'idle' });
  const [confirm, setConfirm] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const narrow = useMediaQuery(useTheme().breakpoints.down('sm'));
  const back = () => {
    setMode({ kind: 'idle' });
    setConfirm('');
    setTimeout(() => first.current?.focus(), 0);
  };
  useEffect(() => {
    if (focused) first.current?.focus();
  }, [focused]);

  const save = async (file: File) => {
    setMode({ kind: 'busy' });
    try {
      await putCred(pod, profile, row.slot, file);
      await onDone();
      enqueueSnackbar(row.slot === 'google_client_secret' ? t('profiles.cred.savedNextGoogle') : t('profiles.cred.saved', { path: row.path }), { variant: 'success' });
      back();
    } catch (e) {
      const code = e instanceof CredError ? e.code : 'unknown';
      setMode(code === 'timeout' ? { kind: 'unknown', before: row.mtime } : { kind: 'error', code });
    }
  };
  const clear = async () => {
    setMode({ kind: 'busy' });
    try {
      await clearCred(pod, profile, row.slot, row.path);
      await onDone();
      enqueueSnackbar(t('profiles.cred.cleared', { path: row.path }), { variant: 'success' });
      back();
    } catch (e) {
      const code = e instanceof CredError ? e.code : 'unknown';
      setMode(code === 'timeout' ? { kind: 'unknown', before: row.mtime } : { kind: 'error', code });
    }
  };
  const recheck = async (before?: number) => {
    const list = await onDone();
    const now = list?.rows.find((r) => r.path === row.path);
    const changed = (now?.mtime ?? null) !== (before ?? null);
    enqueueSnackbar(changed ? t('profiles.cred.recheckSaved') : t('profiles.cred.recheckNot'), { variant: changed ? 'success' : 'warning' });
    back();
  };

  const unknown = row.type === 'unknown';
  const buttons =
    canEdit && !unknown && row.slot && mode.kind === 'idle' ? (
      <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap" sx={narrow ? { mt: 1 } : undefined}>
        <Button
          ref={first}
          size="small"
          startIcon={<FileUploadOutlinedIcon />}
          sx={{ minHeight: 44 }}
          aria-label={t(row.exists ? 'profiles.cred.replaceOf' : 'profiles.cred.uploadOf', { path: row.path })}
          onClick={() => input.current?.click()}
        >
          {row.exists ? t('profiles.cred.replace') : t('profiles.cred.upload')}
        </Button>
        {row.exists && (
          <Button size="small" color="error" startIcon={<DeleteOutlineIcon />} sx={{ minHeight: 44 }} aria-label={t('profiles.cred.clearOf', { path: row.path })} onClick={() => setMode({ kind: 'clear' })}>
            {t('profiles.cred.clear')}
          </Button>
        )}
        <input
          ref={input}
          type="file"
          hidden
          accept=".json,application/json"
          data-testid={`cred-file-${row.path}`}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            const why = pickProblem(f);
            setMode(why ? { kind: 'error', code: why } : { kind: 'pick', file: f });
          }}
        />
      </Stack>
    ) : null;

  const who = row.changed_by
    ? `${row.changed_by.name || row.changed_by.who || ''}${row.changed_by.role === 'admin' ? ` (${t('profiles.cred.roleAdmin')})` : row.changed_by.role === 'team' ? ` (${t('profiles.cred.roleTeam')})` : ''}`
    : '';
  const caption = !row.exists
    ? ''
    : [row.mtime != null ? fmtWhen(row.mtime) : '', row.changed_by ? who : t('profiles.cred.outside'), row.outside_after ? t('profiles.cred.outsideAfter') : '']
        .filter(Boolean)
        .join(' · ');

  let below = null;
  if (mode.kind === 'pick') {
    below = (
      <Stack spacing={1} sx={{ width: '100%' }}>
        <Typography variant="body2">{t('profiles.cred.picked', { name: mode.file.name, size: kb(mode.file.size) })}</Typography>
        {row.exists && <Typography variant="caption" color="text.secondary">{t('profiles.cred.noUndo')}</Typography>}
        <Stack direction="row" spacing={1}>
          <Button size="small" variant="contained" sx={{ minHeight: 44 }} onClick={() => void save(mode.file)}>
            {t('profiles.cred.save')}
          </Button>
          <Button size="small" sx={{ minHeight: 44 }} onClick={back}>
            {t('profiles.cancel')}
          </Button>
        </Stack>
      </Stack>
    );
  } else if (mode.kind === 'busy') {
    below = (
      <Stack direction="row" spacing={1} alignItems="center" aria-busy>
        <CircularProgress size={16} />
        <Typography variant="caption">{t('profiles.cred.saving')}</Typography>
      </Stack>
    );
  } else if (mode.kind === 'clear') {
    below = (
      <Stack spacing={1} sx={{ width: '100%' }}>
        <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
          <Typography variant="caption">{t('profiles.cred.clearTypePath')}</Typography>
          <TextField
            size="small"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder={row.path}
            slotProps={{ htmlInput: { 'aria-label': t('profiles.cred.clearTypePath'), spellCheck: false, style: { fontFamily: MONO_FONT } } }}
          />
          <Button size="small" color="error" variant="contained" startIcon={<DeleteOutlineIcon />} sx={{ minHeight: 44 }} disabled={confirm !== row.path} onClick={() => void clear()}>
            {t('profiles.cred.clear')}
          </Button>
          <Button size="small" sx={{ minHeight: 44 }} onClick={back}>
            {t('profiles.cancel')}
          </Button>
        </Stack>
        <Typography variant="caption" color="text.secondary">{t('profiles.cred.noUndoClear')}</Typography>
      </Stack>
    );
  } else if (mode.kind === 'error') {
    below = (
      <Alert severity="error" role="alert" onClose={back} sx={{ width: '100%' }}>
        {errText(mode.code)}
      </Alert>
    );
  } else if (mode.kind === 'unknown') {
    below = (
      <Alert
        severity="warning"
        role="alert"
        sx={{ width: '100%' }}
        action={
          <Button size="small" color="inherit" onClick={() => void recheck(mode.before)}>
            {t('profiles.cred.recheck')}
          </Button>
        }
      >
        {t('profiles.cred.err.timeout')}
      </Alert>
    );
  }

  return (
    <ItemRow
      icon={DescriptionOutlinedIcon}
      name={row.path}
      mono
      off={!row.exists}
      focused={focused}
      tags={
        <>
          {unknown ? <Tag tone="warn">{t('profiles.cred.unknown')}</Tag> : row.exists ? <Tag tone="good">{t('profiles.envSet')}</Tag> : <Tag>{t('profiles.cred.none')}</Tag>}
          {row.by_other && <Tag>{t('profiles.cred.byOther')}</Tag>}
        </>
      }
      description={
        <>
          {unknown ? t('profiles.cred.unknownWhy') : t((DESC[row.slot] ?? 'profiles.cred.desc.secret') as Parameters<typeof t>[0])}
          {caption && (
            <Typography component="span" variant="caption" color="text.secondary" sx={{ display: 'block' }} title={row.changed_by?.who}>
              {caption}
            </Typography>
          )}
        </>
      }
      control={narrow ? null : buttons}
      below={narrow && buttons ? <Box sx={{ width: '100%' }}>{buttons}{below}</Box> : below}
    />
  );
}

function NewFile({ pod, profile, rows, onDone }: { pod: string; profile: string; rows: CredRow[]; onDone: () => Promise<CredList | undefined> }) {
  const [raw, setRaw] = useState('');
  const name = normalizeName(raw);
  const path = name ? `secrets/${name}.json` : '';
  const existing = rows.find((r) => r.path === path);
  const row: CredRow = existing ?? { slot: name ? `secret:${name}` : '', path, exists: false };
  const [open, setOpen] = useState(false);
  return (
    <Box sx={{ mt: 1 }}>
      <Stack direction="row" spacing={1} alignItems="flex-start" useFlexGap flexWrap="wrap">
        <TextField
          size="small"
          value={raw}
          onChange={(e) => {
            setRaw(e.target.value);
            setOpen(false);
          }}
          placeholder={t('profiles.cred.newPlaceholder')}
          error={!!raw.trim() && !name}
          helperText={raw.trim() ? (name ? t('profiles.cred.newPreview', { path }) : t('profiles.cred.newRule')) : ' '}
          slotProps={{ htmlInput: { 'aria-label': t('profiles.cred.newLabel'), spellCheck: false } }}
        />
        <Button startIcon={<AddIcon />} sx={{ minHeight: 44 }} disabled={!name} onClick={() => setOpen(true)}>
          {t('profiles.cred.newButton')}
        </Button>
      </Stack>
      {open && name && (
        <ItemList>
          <CredLine row={row} pod={pod} profile={profile} canEdit focused onDone={async () => {
            const out = await onDone();
            setRaw('');
            setOpen(false);
            return out;
          }} />
        </ItemList>
      )}
    </Box>
  );
}

export function CredentialFiles({ pod, profile }: { pod?: string; profile: string }) {
  const qc = useQueryClient();
  const wanted = useProfileSpot().get('file') ?? '';
  const query = useQuery<CredList, CredError>({
    queryKey: credKey(pod, profile),
    queryFn: () => listCreds(pod as string, profile),
    enabled: !!pod,
    retry: false,
  });
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: credKey(pod, profile) });
    return qc.getQueryData<CredList>(credKey(pod, profile));
  };
  if (!pod) return null;
  const d = query.data;
  return (
    <Section title={t('profiles.cred.title')}>
      <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 1 }}>
        {t('profiles.cred.caption')}
      </Typography>
      {query.isLoading ? (
        <Stack spacing={1} data-testid="cred-loading">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} variant="rounded" height={44} />
          ))}
        </Stack>
      ) : query.isError || !d ? (
        <Alert
          severity="error"
          role="alert"
          action={
            <Button size="small" color="inherit" onClick={() => void query.refetch()}>
              {t('profiles.cred.reload')}
            </Button>
          }
        >
          {t('profiles.cred.listFailed')}
        </Alert>
      ) : (
        <>
          {d.reason && (
            <Alert severity="info" sx={{ mb: 1, ...calmAlertSx }}>
              {reasonText(d.reason, d.admin)}
            </Alert>
          )}
          <ItemList>
            {d.rows.map((r) => (
              <CredLine key={r.path} row={r} pod={pod} profile={profile} canEdit={d.can_edit} focused={!!wanted && wanted === r.path} onDone={refresh} />
            ))}
          </ItemList>
          {d.can_edit && <NewFile pod={pod} profile={profile} rows={d.rows} onDone={refresh} />}
        </>
      )}
    </Section>
  );
}
