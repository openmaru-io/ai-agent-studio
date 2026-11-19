/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 스킬 화면의 「값 넣기」 창(스펙 2026-11-18-004). 값이 없는 환경변수를 다른 화면으로 가지 않고 넣는다.
// 넣을 곳(작업공간·프로파일)은 미리 채워 고칠 수 없고, 저장은 자격 증명 화면과 같은 env_set 을 키마다 차례로 보낸다.
//
//   오른쪽 개요 줄 ─┐
//   「필요한 것」 키 줄 ─┼─ useSkillEnv().open(row, key?) ──▶ SkillEnvProvider(창 상태) ──▶ SkillEnvDialog
//   개요 탭 설정 필요 줄 ┘                                                              └─ saveKeys(차례로, 30초 제한)
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import PasswordOutlinedIcon from '@mui/icons-material/PasswordOutlined';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Link,
  Skeleton,
  Stack,
  Tooltip,
  Typography,
  useMediaQuery,
} from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { LinkChip, Mono, Tag } from '@/components/bits';
import { SecretValueField } from '@/components/SecretValueField';
import { t } from '@/i18n';
import { viewerAgentLabel } from '@/lib/agentLabel';
import { ApiError, get, post } from '@/lib/api';
import { cleanSecret, ENV_KEY, useCanWriteSecrets } from '@/lib/credentialWrite';
import { isAdmin, useMe } from '@/lib/data';
import { fmtTs } from '@/lib/format';
import { MONO_FONT } from '@/lib/monoFont';

/** 창이 다루는 스킬 줄(AgentSkills 의 AgentSkillRow 가운데 쓰는 것) */
export interface EnvRow {
  id: string;
  name: string;
  profile: string;
  missing_env?: string[];
  readiness?: string;
}
/**
 * /api/skill 의 required_env 한 줄. managed 는 「AAS 가 LLM 접속값을 주는 이름」 고정 표시(스킬 선언에서 정해짐),
 * managed_source 는 요청마다 프로파일 .env 를 읽어 정한 출처 — aas(AAS 값을 씀)·profile(프로파일 값이 AAS 값을 덮음).
 * owner_locked 는 주인이 지울 수 없는 이름(owner_guard 의 이름 규칙)인 profile 줄(스펙 2026-11-19-002 §4-3)
 */
export interface RequiredEnv {
  name: string;
  prompt?: string;
  help?: string;
  required_for?: string;
  optional?: boolean;
  set?: boolean;
  managed?: 'aas';
  managed_source?: 'aas' | 'profile';
  owner_locked?: boolean;
}

export const isManagedEnv = (e: Pick<RequiredEnv, 'managed'>) => e.managed === 'aas';

/** 관리 이름을 AAS 값을 쓰는 것(aas)·프로파일 값이 덮는 것(profile)으로, 나머지(plain)와 나눈다 */
export function splitManaged<T extends RequiredEnv>(env: T[]) {
  return {
    plain: env.filter((e) => !isManagedEnv(e)),
    aas: env.filter((e) => isManagedEnv(e) && e.managed_source !== 'profile'),
    profile: env.filter((e) => isManagedEnv(e) && e.managed_source === 'profile'),
  };
}

/**
 * LLM 접속값 줄(대화상자·스킬 상세가 함께 쓴다). 순서: 출처가 갈리면 warn 한 줄 → AAS 값을 쓰는 이름 한 줄(info) → 프로파일 값 줄(good).
 * aas 줄은 할 일이 없어 꼬리표·입력 칸 없이 묶는다. profile 줄은 비밀값 화면 링크, 주인이 지울 수 없는 이름이면 링크 대신 안내.
 */
export function ManagedEnvLines({ env, mixed, profile }: { env: RequiredEnv[]; mixed?: boolean; profile: string }) {
  const me = useMe().data;
  const admin = isAdmin(me);
  const { aas, profile: own } = splitManaged(env);
  if (!aas.length && !own.length) return null;
  const llm = (rows: RequiredEnv[]) =>
    rows
      .filter((e) => !e.name.startsWith('HERMES_'))
      .map((e) => e.name)
      .join('·');
  return (
    <Stack spacing={0.75} data-testid="skill-env-managed">
      {mixed && (
        <Stack direction="row" spacing={0.75} alignItems="flex-start" data-tone="warn">
          <WarningAmberIcon color="warning" sx={{ fontSize: 16, mt: '2px' }} aria-hidden />
          <Typography variant="caption">
            {t('skillsAgent.env.mixedSource', { profile: llm(own), aas: llm(aas) })}
          </Typography>
        </Stack>
      )}
      {aas.length > 0 && (
        <Stack direction="row" spacing={0.75} alignItems="flex-start" data-tone="info">
          <InfoOutlinedIcon color="info" sx={{ fontSize: 16, mt: '2px' }} aria-hidden />
          <Typography variant="caption" color="text.secondary">
            {t('skillsAgent.env.managedGroup', { names: aas.map((e) => e.name).join('·') })}
          </Typography>
        </Stack>
      )}
      {own.map((e) => (
        <Box key={e.name} data-managed-profile={e.name}>
          <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
            <Mono>{e.name}</Mono>
            <Tag tone="good">{t('skillsAgent.env.profileOverrides')}</Tag>
            {e.owner_locked && !admin ? (
              <Typography variant="caption" color="text.secondary">
                {t('skillsAgent.env.adminClears')}
              </Typography>
            ) : (
              <>
                <Typography variant="caption" color="text.secondary">
                  {t('skillsAgent.env.profileFollowHint')}
                </Typography>
                <LinkChip to="profiles" params={{ name: profile, pane: 'env', key: e.name }} page>
                  {t('skills.envFill')}
                </LinkChip>
              </>
            )}
          </Stack>
        </Box>
      ))}
    </Stack>
  );
}

/** 키 하나의 요청 제한 시간. api.ts 의 send 에는 제한이 없어 Hermes·NFS 가 멈추면 끝나지 않는다(Eng 1) */
export const SAVE_TIMEOUT_MS = 30_000;

// ── 저장 반복: 컴포넌트 밖 순수 함수. 창이 사라져도(isAlive=false) 남은 키를 멈춘다 ──

export type SaveKind = 'saved' | 'refused' | 'unknown' | 'pod' | 'skipped';
export interface SaveResult {
  key: string;
  kind: SaveKind;
  wasSet?: string;
  mcp?: string[];
  reason?: string;
  message?: string;
}
type EnvSetResponse = { was_set?: string; mcp_enabled?: string[] };

/** 키마다 env_set 을 차례로 보낸다. 작업공간이 바뀌었으면(409 agent_changed) 그 뒤는 보내지 않는다 */
export async function saveKeys(
  items: { key: string; value: string }[],
  deps: {
    post: (key: string, value: string, signal: AbortSignal) => Promise<EnvSetResponse>;
    isAlive: () => boolean;
    onEach?: (r: SaveResult) => void;
    timeoutMs?: number;
  }
): Promise<SaveResult[]> {
  const out: SaveResult[] = [];
  let stop = false;
  for (const { key, value } of items) {
    if (stop || !deps.isAlive()) {
      out.push({ key, kind: 'skipped' });
      continue;
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), deps.timeoutMs ?? SAVE_TIMEOUT_MS);
    let r: SaveResult;
    try {
      const res = await deps.post(key, value, ctl.signal);
      r = { key, kind: 'saved', wasSet: res?.was_set, mcp: res?.mcp_enabled };
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.reason === 'agent_changed') {
        r = { key, kind: 'pod', message: e.message };
        stop = true;
      } else if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
        r = { key, kind: 'refused', reason: e.reason, message: e.message };
      } else {
        r = { key, kind: 'unknown', message: (e as Error)?.message }; // 응답 없음·시간 초과·5xx·네트워크 — 저장됐는지 모른다
      }
    } finally {
      clearTimeout(timer);
    }
    out.push(r);
    deps.onEach?.(r);
  }
  return out;
}

// ── 세 여는 곳이 함께 쓰는 문(컨텍스트)과 단추 ──

interface Ctx {
  open: (row: EnvRow, focusKey?: string) => void;
  /** 이 사람이 이 프로파일에 값을 넣을 수 있는가: none(단추 없음, 지금 링크) · wait(끈 단추+이유) · ok */
  gate: (profile: string) => { state: 'none' | 'wait' | 'ok'; why?: string };
}
const EnvCtx = createContext<Ctx | null>(null);
export const useSkillEnv = () => useContext(EnvCtx);

/** 스킬 화면을 감싼다. 창 상태는 줄 밖(여기)에 두어 저장 뒤 목록이 바뀌어도 창이 남는다(스펙 §3-1) */
export function SkillEnvProvider({
  rows,
  profiles,
  children,
}: {
  rows: EnvRow[];
  /** /api/skills 의 profiles(_skill_targets). 루트가 숨겨지면 default 가 빠진다. 옛 서버는 없다 */
  profiles?: string[];
  children: ReactNode;
}) {
  const [opened, setOpened] = useState<{ row: EnvRow; focusKey?: string; n: number } | null>(null);
  const { may, secure } = useCanWriteSecrets();
  const gate = useCallback<Ctx['gate']>(
    (profile) => {
      if (!may) return { state: 'none' };
      if (profile === 'default' && profiles && !profiles.includes('default')) return { state: 'none' }; // 숨긴 루트
      if (secure === undefined) return { state: 'wait', why: t('skillsAgent.env.checking') };
      if (secure === false) return { state: 'wait', why: t('inventory.needSecure') };
      return { state: 'ok' };
    },
    [may, secure, profiles]
  );
  const open = useCallback<Ctx['open']>(
    (row, focusKey) => setOpened((o) => ({ row, focusKey, n: (o?.n ?? 0) + 1 })),
    []
  );
  const value = useMemo(() => ({ open, gate }), [open, gate]);
  return (
    <EnvCtx.Provider value={value}>
      {children}
      {opened && (
        <SkillEnvDialog
          key={opened.n}
          row={opened.row}
          rows={rows.filter((r) => r.profile === opened.row.profile)}
          focusKey={opened.focusKey}
          onClose={() => setOpened(null)}
        />
      )}
    </EnvCtx.Provider>
  );
}

/** 「값 넣기」 단추. 스킬 하나(row)나 키 하나(envKey)를 연다. 넣을 수 없는 사람이면 fallback(지금 링크)을 그린다 */
export function SkillEnvButton({
  row,
  envKey,
  fallback = null,
}: {
  row: EnvRow;
  envKey?: string;
  fallback?: ReactNode;
}) {
  const env = useSkillEnv();
  if (!env) return <>{fallback}</>;
  const g = env.gate(row.profile);
  const enterable = envKey ? ENV_KEY.test(envKey) : (row.missing_env ?? []).some((k) => ENV_KEY.test(k));
  if (g.state === 'none' || !enterable) return <>{fallback}</>;
  const label = envKey
    ? t('skillsAgent.env.openKey', { name: envKey })
    : t('skillsAgent.env.openSkill', { name: row.name });
  const btn = (
    // 줄의 할 일이라 Tier 1(contained)과 가린 값 아이콘으로 눈에 띄게 한다. 옆의 「API 키·토큰 화면 보기」 링크(열쇠)와 모양을 나눈다
    <Button
      size="small"
      variant="contained"
      startIcon={<PasswordOutlinedIcon />}
      aria-label={label}
      disabled={g.state !== 'ok'}
      onClick={() => env.open(row, envKey)}
      sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}
    >
      {t('skillsAgent.env.open')}
    </Button>
  );
  return g.state === 'ok' ? (
    btn
  ) : (
    <Tooltip title={g.why}>
      <span>{btn}</span>
    </Tooltip>
  );
}

// ── 창 ──

type FieldState =
  | { kind: 'idle' }
  | { kind: 'saved'; replaced: boolean }
  | { kind: 'refused'; reason?: string; message?: string; at: string }
  | { kind: 'unknown'; at: string };

const URL_ONLY = /^https?:\/\/\S+$/;
const hostOf = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return '';
  }
};
const ADMIN_REASONS = new Set(['platform_var', 'url_proxy', 'provider_key']);

function HelpLine({ help }: { help: string }) {
  const h = help.trim();
  const host = URL_ONLY.test(h) ? hostOf(h) : '';
  if (!host) return <>{h}</>; // 문장이면 안에 주소가 있어도 글자 그대로(자동 링크 없음, 스펙 §3-2)
  return (
    <>
      {t('skillsAgent.env.helpLink')}{' '}
      <Link href={h} target="_blank" rel="noopener noreferrer">
        <b>{host}</b>
        <OpenInNewIcon sx={{ fontSize: 12, ml: 0.25, verticalAlign: 'middle' }} aria-hidden />
      </Link>
    </>
  );
}

export function SkillEnvDialog({
  row,
  rows,
  focusKey,
  onClose,
}: {
  row: EnvRow;
  /** 같은 프로파일의 스킬 줄(같은 키를 쓰는 다른 스킬 계산, E1) */
  rows: EnvRow[];
  focusKey?: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const me = useMe().data;
  const narrow = useMediaQuery('(max-width:899.98px)');
  const one = useQuery<{ required_env?: RequiredEnv[]; managed_mixed?: boolean }>({
    queryKey: ['skill', row.id],
    queryFn: () => get('/api/skill?id=' + encodeURIComponent(row.id)),
  });
  // 창을 연 때의 작업공간. env_set 마다 expect_pod 로 실어 다른 탭에서 바뀌면 서버가 409 로 막는다(스펙 §3-2)
  const podAtOpen = useRef(me?.pod?.id ?? '');
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);
  const [values, setValues] = useState<Record<string, string>>({}); // 키 이름으로 묶는다 — 설명이 늦게 와도 적은 값이 남는다
  const [states, setStates] = useState<Record<string, FieldState>>({});
  const unknownBefore = useRef(new Set<string>()); // 「결과 모름」이었던 키 — 다시 보내 was_set=true 가 와도 「바꿨음」이 아니다
  const [sending, setSending] = useState(false);
  const [podChanged, setPodChanged] = useState(false);
  const doneToasted = useRef(false);

  const reqAll = one.data?.required_env;
  // AAS 가 주는 LLM 접속값은 칸으로 그리지 않고 칸 아래 한 묶음으로 모은다 — 선언의 앞쪽에 있어도 맨 뒤(스펙 2026-11-19-002 §4-3).
  // 칸 목록·포커스·저장 대상은 나머지만이다
  const req = useMemo(() => reqAll?.filter((e) => !isManagedEnv(e)), [reqAll]);
  const managed = useMemo(() => (reqAll ?? []).filter(isManagedEnv), [reqAll]);
  // 칸 목록: 설명을 받기 전에는 missing_env 이름만으로 그린다. 필수는 missing_env 순서 그대로, 선택은 끝에(디자인 7)
  const fields = useMemo(() => {
    const missing = row.missing_env ?? [];
    if (!req) return missing.map((name) => ({ name, optional: false } as RequiredEnv));
    const byName = new Map(req.map((e) => [e.name, e]));
    const req1 = [
      ...missing.filter((n) => byName.has(n)),
      ...req.filter((e) => !e.optional && !missing.includes(e.name)).map((e) => e.name),
    ];
    const opt = req.filter((e) => e.optional).map((e) => e.name);
    return [...req1, ...opt].map((n) => byName.get(n)!).filter(Boolean);
  }, [req, row.missing_env]);
  const isSaved = (n: string) => states[n]?.kind === 'saved';
  const serverSet = (f: RequiredEnv) => !!f.set && !isSaved(f.name);
  const enterable = (f: RequiredEnv) => ENV_KEY.test(f.name) && !serverSet(f);
  const targets = fields.filter((f) => !f.optional && ENV_KEY.test(f.name) && (!f.set || isSaved(f.name)));
  const done = targets.length > 0 && targets.every((f) => isSaved(f.name));
  const allSet =
    !!req && fields.length + managed.length > 0 && fields.every((f) => f.set) && !fields.some((f) => isSaved(f.name));
  const managedLines = <ManagedEnvLines env={managed} mixed={one.data?.managed_mixed} profile={row.profile} />;
  useEffect(() => {
    if (allSet) void qc.invalidateQueries({ queryKey: ['skills'] }); // 목록은 최대 60초 늦다
  }, [allSet, qc]);

  const typed = fields.filter((f) => enterable(f) && (values[f.name] ?? '') !== '');
  const errorOf = (n: string) => {
    const v = values[n] ?? '';
    if (!v) return undefined;
    const c = cleanSecret(v);
    return c.error && c.error !== 'empty' ? t(`inventory.secretBad.${c.error}`) : undefined;
  };
  const canSave = !sending && !podChanged && typed.length > 0 && typed.every((f) => !errorOf(f.name));

  const ws = me?.pod ? viewerAgentLabel(me.pod, me.user?.email) : '—';
  const others = !!me?.pod && !!me.user && (me.pod.owner ?? '').toLowerCase() !== me.user.email.toLowerCase();
  const shared = (key: string) =>
    rows
      .filter((r) => r.id !== row.id && r.readiness === 'setup' && (r.missing_env ?? []).includes(key))
      .map((r) => r.name);

  const save = async () => {
    if (!canSave) return;
    setSending(true);
    const items = typed.map((f) => ({ key: f.name, value: cleanSecret(values[f.name]).value }));
    const at = fmtTs(new Date().toISOString()); // 실패 맥락 줄의 시각(관리자에게 보낼 때 함께 적는다)
    const results = await saveKeys(items, {
      post: (key, value, signal) =>
        post<EnvSetResponse>(
          '/api/profile/action',
          {
            name: row.profile,
            action: 'env_set',
            target: key,
            value,
            ...(podAtOpen.current ? { expect_pod: podAtOpen.current } : {}),
          },
          { signal }
        ),
      isAlive: () => alive.current,
      onEach: (r) => {
        if (!alive.current) return;
        if (r.kind === 'saved') {
          const replaced = r.wasSet === 'true' && !unknownBefore.current.has(r.key);
          setStates((s) => ({ ...s, [r.key]: { kind: 'saved', replaced } }));
          setValues((v) => ({ ...v, [r.key]: '' }));
        } else if (r.kind === 'refused')
          setStates((s) => ({ ...s, [r.key]: { kind: 'refused', reason: r.reason, message: r.message, at } }));
        else if (r.kind === 'unknown') {
          unknownBefore.current.add(r.key);
          setStates((s) => ({ ...s, [r.key]: { kind: 'unknown', at } }));
        } else if (r.kind === 'pod') setPodChanged(true);
      },
    });
    for (const k of ['skills', 'inventory']) void qc.invalidateQueries({ queryKey: [k] });
    void qc.invalidateQueries({ queryKey: ['skill', row.id] });
    void qc.invalidateQueries({ queryKey: ['profile', row.profile] });
    const saved = results.filter((r) => r.kind === 'saved');
    const skipped = results.filter((r) => r.kind === 'skipped').length;
    if (!alive.current) {
      // 보내는 도중 화면을 떠났다 — 일부만 저장된 것을 알린다(DX P7)
      if (skipped)
        enqueueSnackbar(t('skillsAgent.env.leftToast', { name: row.name, saved: saved.length, left: skipped }), {
          variant: 'info',
        });
      return;
    }
    setSending(false);
    // 한 번 저장의 결과를 알림 하나로 모은다(디자인 4)
    const replacedN = saved.filter((r) => r.wasSet === 'true' && !unknownBefore.current.has(r.key)).length;
    const mcp = [...new Set(saved.flatMap((r) => r.mcp ?? []))];
    const parts = [
      replacedN ? t('skillsAgent.env.replacedN', { n: replacedN }) : '',
      mcp.length ? t('skillsAgent.env.mcpOn', { names: mcp.join(', ') }) : '',
    ].filter(Boolean);
    if (parts.length) enqueueSnackbar(parts.join(' · '), { variant: 'info' });
  };

  useEffect(() => {
    if (done && !doneToasted.current) {
      doneToasted.current = true;
      enqueueSnackbar(t('skillsAgent.env.doneToast', { name: row.name }), { variant: 'success' });
    }
  }, [done, enqueueSnackbar, row.name]);

  const showDone = done && typed.length === 0;
  const close = () => {
    if (!sending) onClose();
  };
  // 열릴 때 한 번만 첫 칸(또는 누른 키의 칸)에 포커스(jsx-a11y/no-autofocus 때문에 autoFocus 대신 ref)
  const focused = useRef(false);
  const takeFocus = (el: HTMLInputElement | null) => {
    if (!el || focused.current) return;
    focused.current = true;
    setTimeout(() => el.focus());
  };
  const firstFocus =
    focusKey && fields.some((f) => f.name === focusKey && enterable(f)) ? focusKey : fields.find(enterable)?.name;

  return (
    <Dialog
      open
      onClose={close}
      disableEscapeKeyDown={sending}
      fullWidth
      maxWidth="sm"
      fullScreen={narrow}
      aria-labelledby="skill-env-title"
      data-testid="skill-env-dialog"
    >
      <DialogTitle id="skill-env-title">{t('skillsAgent.env.title', { name: row.name })}</DialogTitle>
      <DialogContent>
        {podChanged && (
          <Alert severity="warning" sx={{ mb: 1.5 }}>
            {t('skillsAgent.env.podChanged')}
          </Alert>
        )}
        {one.isError && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {t('skillsAgent.env.descFailed')}
          </Typography>
        )}
        <Typography variant="overline" color="text.secondary">
          {t('skillsAgent.env.where')}
        </Typography>
        <Box
          component="dl"
          sx={{ m: 0, mb: 2, display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 2, rowGap: 0.5 }}
        >
          <Typography component="dt" variant="body2" color="text.secondary">
            {t('skillsAgent.env.workspace')}
          </Typography>
          <Typography component="dd" variant="body2" sx={{ m: 0 }} data-testid="skill-env-workspace">
            {ws}
          </Typography>
          <Typography component="dt" variant="body2" color="text.secondary">
            {t('skillsAgent.env.profile')}
          </Typography>
          <Typography component="dd" variant="body2" sx={{ m: 0 }}>
            {row.profile}
          </Typography>
        </Box>
        {others && (
          <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mt: -1, mb: 2 }}>
            <InfoOutlinedIcon color="info" fontSize="small" aria-hidden />
            <Typography variant="body2">{t('skillsAgent.env.otherWorkspace')}</Typography>
          </Stack>
        )}
        {allSet ? (
          <Stack spacing={1.5}>
            {managedLines}
            <Typography variant="body2">{t('skillsAgent.env.allSet')}</Typography>
          </Stack>
        ) : (
          <Stack spacing={2}>
            {fields.map((f) => (
              <EnvField
                key={f.name}
                f={f}
                loading={one.isLoading}
                value={values[f.name] ?? ''}
                onChange={(v) => setValues((s) => ({ ...s, [f.name]: v }))}
                state={states[f.name] ?? { kind: 'idle' }}
                serverSet={serverSet(f)}
                error={errorOf(f.name)}
                disabled={sending || podChanged}
                takeFocus={f.name === firstFocus ? takeFocus : undefined}
                shared={f.optional ? [] : shared(f.name)}
                context={{ workspace: ws, profile: row.profile }}
              />
            ))}
            {managedLines}
          </Stack>
        )}
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 2 }}>
          {t('skillsAgent.env.applyNote')}
        </Typography>
      </DialogContent>
      <DialogActions>
        {!showDone && (
          <Button onClick={close} disabled={sending}>
            {t('skillsAgent.env.close')}
          </Button>
        )}
        {showDone ? (
          <Button variant="contained" onClick={onClose}>
            {t('skillsAgent.env.done')}
          </Button>
        ) : (
          <Button
            variant="contained"
            onClick={() => void save()}
            disabled={!canSave}
            startIcon={sending ? <CircularProgress size={14} aria-hidden /> : undefined}
          >
            {t('skillsAgent.env.save')}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

function EnvField({
  f,
  loading,
  value,
  onChange,
  state,
  serverSet,
  error,
  disabled,
  takeFocus,
  shared,
  context,
}: {
  f: RequiredEnv;
  loading: boolean;
  value: string;
  onChange: (v: string) => void;
  state: FieldState;
  serverSet: boolean;
  error?: string;
  disabled: boolean;
  takeFocus?: (el: HTMLInputElement | null) => void;
  shared: string[];
  context: { workspace: string; profile: string };
}) {
  const tag = f.optional ? t('skillsAgent.env.optional') : t('skillsAgent.env.required');
  const head = (
    <Stack direction="row" spacing={1} alignItems="baseline">
      <Typography variant="body2" sx={{ fontFamily: MONO_FONT, fontWeight: 600 }}>
        {f.name}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {tag}
      </Typography>
    </Stack>
  );
  if (serverSet)
    return (
      <Box>
        {head}
        <Typography variant="body2" color="text.secondary">
          {t('skillsAgent.env.alreadySet')}
        </Typography>
      </Box>
    );
  if (!ENV_KEY.test(f.name))
    return (
      <Box>
        {head}
        <Typography variant="body2" color="text.secondary">
          {t('skillsAgent.env.badName')}
        </Typography>
      </Box>
    );
  const status =
    state.kind === 'saved' ? (
      <Stack direction="row" spacing={0.5} alignItems="center" role="status">
        <CheckCircleOutlineIcon color="success" sx={{ fontSize: 16 }} aria-hidden />
        <span>{state.replaced ? t('skillsAgent.env.savedReplaced') : t('skillsAgent.env.saved')}</span>
      </Stack>
    ) : null;
  const failure =
    state.kind === 'refused' || state.kind === 'unknown' ? (
      <Box role="status">
        <RefusalText state={state} keyName={f.name} />
        <Typography variant="caption" color="text.secondary" component="div">
          {t('skillsAgent.env.context', {
            workspace: context.workspace,
            profile: context.profile,
            key: f.name,
            time: state.at,
          })}
        </Typography>
      </Box>
    ) : null;
  const helper = (
    <>
      {loading ? <Skeleton width="60%" /> : f.help ? <HelpLine help={f.help} /> : null}
      {shared.length > 0 && (
        <Box component="span" sx={{ display: 'block' }}>
          {t('skillsAgent.env.sharedWith', { names: shared.join('·') })}
        </Box>
      )}
      {status}
    </>
  );
  return (
    <Box>
      {head}
      {loading ? (
        <Skeleton width="40%" />
      ) : f.prompt ? (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
          {f.prompt}
        </Typography>
      ) : null}
      {/* 떠 있는 레이블이 위 설명 줄과 겹치지 않게 띄운다 */}
      <Box sx={{ mt: 1 }}>
        <SecretValueField
          label={f.name}
          value={value}
          onChange={onChange}
          error={error}
          invalid={!!failure}
          helper={helper}
          disabled={disabled}
          inputRef={takeFocus}
        />
      </Box>
      {failure}
    </Box>
  );
}

function RefusalText({
  state,
  keyName,
}: {
  state: Extract<FieldState, { kind: 'refused' } | { kind: 'unknown' }>;
  keyName: string;
}) {
  if (state.kind === 'unknown')
    return (
      <Typography variant="body2" color="error">
        {t('skillsAgent.env.unknown')}
      </Typography>
    );
  const reason = state.reason ?? '';
  if (ADMIN_REASONS.has(reason))
    return (
      <Stack direction="row" spacing={0.5} alignItems="center">
        <Typography variant="body2" color="error">
          {t('skillsAgent.env.adminOnly')}
        </Typography>
        <IconButton
          size="small"
          aria-label={t('skillsAgent.env.copyKey')}
          onClick={() => void navigator.clipboard?.writeText(keyName)}
        >
          <ContentCopyOutlinedIcon sx={{ fontSize: 16 }} />
        </IconButton>
      </Stack>
    );
  if (reason === 'channel_var')
    return (
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Typography variant="body2" color="error">
          {state.message}
        </Typography>
        <LinkChip to="channels">{t('skillsAgent.env.channelVar')}</LinkChip>
      </Stack>
    );
  if (reason === 'list_unreadable')
    return (
      <Typography variant="body2" color="error">
        {t('skillsAgent.env.retryLater')}
      </Typography>
    );
  return (
    <Typography variant="body2" color="error">
      {state.message}
    </Typography>
  );
}
