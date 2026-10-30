/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 순차 롤아웃 화면 조각(스펙 2026-10-28-015 §4-6, 디자인 리뷰 DD1~DD19). 「AI 에이전트」 화면이 관리자에게만 쓴다:
// 진행 띠(ListView banner 하나에 우선순위, DD1·DD4·DD5·DD9), 버전 칸(DD6), 시작 서랍(DD10), 상세 서랍(DD14), 숨은 알림 영역(DD16).
// 진행은 오퍼레이터가 하고 화면은 /api/agents 의 rollout 요약을 그린다. 단추는 /api/agents/rollout(·/action)을 부른다.
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import { Alert, Box, Button, Checkbox, FormControlLabel, IconButton, LinearProgress, NativeSelect, Stack, Table, TableBody, TableCell, TableHead, TableRow, TextField, Tooltip, Typography } from '@mui/material';
import { visuallyHidden } from '@mui/utils';
import { useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { AgentPicker } from '@/components/AgentPicker';
import { useConfirm } from '@/components/ConfirmDialog';
import { Pill } from '@/components/DataGrid';
import type { ListBanner } from '@/components/ListView';
import { useUi } from '@/components/UiContext';
import { t } from '@/i18n';
import { ApiError, post } from '@/lib/api';
import { fmtTs } from '@/lib/format';
import { MONO_FONT } from '@/lib/monoFont';

export interface RolloutAgent {
  name: string;
  state: string;
  image?: string;
  sidecarImage?: string;
  previous?: string;
  previousSidecar?: string;
  suspended?: boolean;
  startedAt?: string;
  finishedAt?: string;
  message?: string;
}

export interface RolloutInfo {
  name: string;
  /** image(기본) · resize(크기 롤아웃, 스펙 2026-10-30-003 §4-2b). 띠 우선순위는 같고 글만 나눈다(R9) */
  kind?: 'image' | 'resize';
  version: string;
  phase: string;
  message: string;
  image: string;
  sidecar_image: string;
  rollback_of: string;
  canary: string[];
  canary_info: { name: string; state: string; ready_seconds: number | null; waiting_seconds: number | null } | null;
  batch: number;
  batch_size: number;
  skip_busy: boolean;
  paused: boolean;
  approved: boolean;
  aborted: boolean;
  blocking: boolean;
  total: number;
  done: number;
  updating: string[];
  waiting: number;
  next_batch: string[];
  deferred_busy: number;
  suspended: number;
  excluded: string[];
  reverted: string[];
  failed: string[];
  started: string;
  completed: string;
  created_by: string;
  agents: RolloutAgent[];
}

/** /api/agents 관리자 응답에 더해지는 롤아웃 칸(DD18) */
export interface RolloutData {
  rollout?: RolloutInfo | null;
  target?: { image: string; sidecar_image: string; version: string };
  ever?: boolean;
  chart_differs?: boolean;
}

/** 행마다 더해지는 버전 칸(DD6). updating 은 모든 사용자에게 온다(DD7) */
export interface VersionFields {
  image_digest?: string;
  sidecar_digest?: string;
  version?: string;
  outdated?: boolean | null;
  pinned?: boolean;
  rollout_state?: string;
  updating?: boolean;
}

export const DIGEST_RE = /^[^@\s]+@sha256:[0-9a-f]{64}$/;

/** `저장소@sha256:…` 의 digest 앞 12자. 없으면 빈 글 */
export const shortDigest = (ref?: string) => {
  const i = (ref ?? '').indexOf('@sha256:');
  return i < 0 ? '' : (ref ?? '').slice(i + 8, i + 20);
};
export const repoOf = (ref?: string) => (ref ?? '').split('@')[0];
const minutes = (s: number | null | undefined) => Math.max(0, Math.round((s ?? 0) / 60));

// ---- 끝난 띠 닫기 기억(DD9): 보는 사람의 브라우저에만, 읽기·쓰기는 실패해도 화면이 그대로 그린다 -------------
const DISMISS_KEY = 'aas.rollout.dismissed';
export function dismissedRollouts(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(DISMISS_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
export function dismissRollout(name: string) {
  try {
    localStorage.setItem(DISMISS_KEY, JSON.stringify([...dismissedRollouts().filter((n) => n !== name), name].slice(-20)));
  } catch {
    /* 저장하지 못해도 이번 화면에서는 닫힌다 */
  }
}

/** 띠에 보일 것(DD1 우선순위: 진행 > 실패 > 끝남 24시간 > 차트 값과 다름 > 오래됨 알 수 없음). 없으면 null */
export type BandKind = 'progress' | 'failed' | 'done' | 'chart' | 'unknown';
export function bandKind(d: RolloutData, now: number, dismissed: string[]): BandKind | null {
  const r = d.rollout;
  if (r && r.phase !== 'Done' && r.phase !== 'Failed') return 'progress';
  if (r && r.phase === 'Failed' && !dismissed.includes(r.name)) return 'failed';
  if (r && r.phase === 'Done' && !dismissed.includes(r.name) && r.completed && now - Date.parse(r.completed) < 24 * 3600 * 1000) return 'done';
  if (d.chart_differs) return 'chart';
  if (d.ever === false && !r) return 'unknown';
  return null;
}

/** 할 일이 있는 단계(승인 대기·멈춤·실패)만 warning, 나머지는 info(DD4). 빨강은 실패 행 Pill 에만(DD5) */
export const bandSeverity = (kind: BandKind, phase?: string): 'info' | 'warning' =>
  kind === 'failed' || (kind === 'progress' && (phase === 'WaitingApproval' || phase === 'Paused')) ? 'warning' : 'info';

/** 띠 첫 줄(DD4·DD11). labelOf 는 에이전트 표시 이름 */
export function bandText(kind: BandKind, r: RolloutInfo | null | undefined, labelOf: (n: string) => string, now: number): string {
  if (kind === 'chart') return t('rollout.band.chart');
  if (kind === 'unknown') return t('rollout.band.unknown');
  if (!r) return '';
  const version = r.version || r.name;
  if (r.kind === 'resize') return resizeText(kind, r, labelOf);
  if (kind === 'failed') return t('rollout.band.failed', { message: r.message });
  if (kind === 'done') return t('rollout.band.done', { n: r.done, version, time: r.completed ? fmtTs(r.completed) : '' });
  const c = r.canary_info;
  switch (r.phase) {
    case 'Canary': {
      const started = r.agents.find((a) => a.name === c?.name)?.startedAt;
      return t('rollout.band.canary', { name: labelOf(c?.name ?? r.canary[0] ?? ''), min: started ? minutes((now - Date.parse(started)) / 1000) : 0 });
    }
    case 'WaitingApproval':
      return c && c.ready_seconds != null
        ? t('rollout.band.waiting', { name: labelOf(c.name), version, ready: minutes(c.ready_seconds), wait: minutes(c.waiting_seconds) })
        : t('rollout.band.waitingShort', { version });
    case 'Paused':
      return t('rollout.band.paused', { done: r.done, total: r.total });
    case 'Pending':
      return t('rollout.band.pending', { version });
    default:
      if (r.rollback_of) return t('rollout.band.rollback', { done: r.done, total: r.total });
      return (
        t('rollout.band.rolling', { version, batch: r.batch, done: r.done, total: r.total }) +
        (r.updating.length ? t('rollout.band.rollingNow', { names: r.updating.map(labelOf).join(', ') }) : '')
      );
  }
}

/** 크기 롤아웃의 띠 글(스펙 2026-10-30-003 §4-7 1C·7A): 「기본 크기를 적용하는 중 n / m」, 멈추면 「n / m 에서 멈춤 · <주인 · 작업공간> 노드 자리 없음」 */
function resizeText(kind: BandKind, r: RolloutInfo, labelOf: (n: string) => string): string {
  const version = r.version || r.name;
  if (kind === 'failed') return t('rollout.band.resizeFailed', { message: r.message });
  if (kind === 'done') return t('rollout.band.resizeDone', { version, time: r.completed ? fmtTs(r.completed) : '' });
  if (r.phase === 'Paused') {
    const why = r.failed.length ? t('rollout.band.resizeNoRoom', { name: labelOf(r.failed[0]) }) : r.message;
    return t('rollout.band.resizePaused', { done: r.done, total: r.total }) + (why ? ` · ${why}` : '');
  }
  return t('rollout.band.resizing', { version, done: r.done, total: r.total }) + (r.updating.length ? t('rollout.band.rollingNow', { names: r.updating.map(labelOf).join(', ') }) : '');
}

/** 띠 둘째 줄(DD19): 분모에 넣지 않은 것. 0 인 항목은 뺀다 */
export function bandNote(r: RolloutInfo): string {
  return [
    r.suspended ? t('rollout.band.suspended', { n: r.suspended }) : '',
    r.excluded.length ? t('rollout.band.excluded', { n: r.excluded.length }) : '',
    r.deferred_busy ? t('rollout.band.deferred', { n: r.deferred_busy }) : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** 바뀐 에이전트(되돌리기 대상) */
export const changedAgents = (r: RolloutInfo) => r.agents.filter((a) => a.state === 'done' || a.state === 'updating' || a.state === 'failed').map((a) => a.name);

// 글자 단추는 이 테마에서 포커스 링이 없어 직접 넣는다(DD15, 학습 text-button-no-red-focus-ring)
const textBtnSx = { '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'text.primary', outlineOffset: 2 } } as const;
const touchSx = { minHeight: { xs: 44, sm: 'auto' } } as const;

export interface BandHandlers {
  pause: () => void;
  resume: () => void;
  rollback: () => void;
  retry: () => void;
  detail: () => void;
  openCanary: () => void;
  close: () => void;
  start: () => void;
  reload: () => void;
  /** 크기 롤아웃 「그만두기」(스펙 2026-10-30-003 §4-2b) */
  abort?: () => void;
}

/** 진행 띠 전체(DD4·DD5·DD9·DD15·DD17·DD19). readError 면 단추를 끄고 다시 시도만(DD8). 보일 것이 없으면 null */
export function rolloutBanner(d: RolloutData, opts: { now: number; dismissed: string[]; labelOf: (n: string) => string; readError: boolean; on: BandHandlers }): ListBanner | null {
  if (opts.readError) {
    return { severity: 'warning', message: t('rollout.band.readError'), action: <Button size="small" onClick={opts.on.reload} sx={{ ...textBtnSx, ...touchSx }}>{t('rollout.retryRead')}</Button> };
  }
  const kind = bandKind(d, opts.now, opts.dismissed);
  if (!kind) return null;
  const r = d.rollout ?? null;
  const text = bandText(kind, r, opts.labelOf, opts.now);
  const severity = bandSeverity(kind, r?.phase);
  const btn = (label: string, onClick: () => void, primary = false) => (
    <Button key={label} size="small" variant={primary ? 'contained' : 'text'} color={primary ? undefined : 'inherit'} onClick={onClick} sx={{ ...(primary ? {} : textBtnSx), ...touchSx, whiteSpace: 'nowrap' }}>
      {label}
    </Button>
  );
  const buttons: ReactNode[] = [];
  if (r?.kind === 'resize' && (kind === 'progress' || kind === 'failed')) {
    // 크기 롤아웃: 되돌리기·다시 시작은 없다. 멈추면 계속·그만두기(§4-2b)
    if (kind === 'progress' && r.phase === 'Paused') buttons.push(btn(t('rollout.resume'), opts.on.resume, true), ...(opts.on.abort ? [btn(t('rollout.abort'), opts.on.abort)] : []));
    else if (kind === 'progress' && !r.aborted) buttons.push(btn(t('rollout.pause'), opts.on.pause));
    buttons.push(btn(t('rollout.detail'), opts.on.detail));
    if (kind === 'failed') buttons.push(btn(t('rollout.close'), opts.on.close));
  } else if (kind === 'progress' && r) {
    if (r.phase === 'WaitingApproval') buttons.push(btn(t('rollout.resume'), opts.on.resume, true), btn(t('rollout.openCanary'), opts.on.openCanary), btn(t('rollout.rollback'), opts.on.rollback));
    else if (r.phase === 'Paused') buttons.push(btn(t('rollout.resume'), opts.on.resume, true), btn(t('rollout.rollback'), opts.on.rollback), btn(t('rollout.detail'), opts.on.detail));
    else if (!r.aborted) buttons.push(btn(t('rollout.pause'), opts.on.pause), btn(t('rollout.detail'), opts.on.detail));
  } else if (kind === 'failed' && r) {
    const n = changedAgents(r).length;
    if (n && !r.rollback_of) buttons.push(btn(t('rollout.rollbackChanged', { n }), opts.on.rollback));
    if (!r.rollback_of) buttons.push(btn(t('rollout.retry'), opts.on.retry));
    buttons.push(btn(t('rollout.detail'), opts.on.detail), btn(t('rollout.close'), opts.on.close));
  } else if (kind === 'done') {
    buttons.push(btn(t('rollout.detail'), opts.on.detail), btn(t('rollout.close'), opts.on.close));
  } else if (kind === 'chart') {
    buttons.push(btn(t('rollout.start'), opts.on.start));
  }
  const showBar = kind === 'progress' && r && r.phase !== 'WaitingApproval' && r.total > 0;
  const note = r && kind === 'progress' ? bandNote(r) : '';
  return {
    severity,
    live: false, // 알릴 사건은 RolloutLive 가 말한다(DD16)
    message: (
      <Box data-rollout-band={kind} data-phase={r?.phase ?? ''}>
        <Typography variant="body2">{text}</Typography>
        {showBar && r && (
          <LinearProgress
            variant="determinate"
            value={(100 * r.done) / r.total}
            aria-label={t('rollout.band.progress', { done: r.done, total: r.total })}
            aria-valuetext={t('rollout.band.progress', { done: r.done, total: r.total })}
            sx={{ mt: 0.75, mb: 0.25, width: '100%', minWidth: { sm: 240 } }}
          />
        )}
        {note && (
          <Typography variant="caption" color="text.secondary" component="div">
            {note}
          </Typography>
        )}
        {/* 좁은 화면(600px 미만)에서는 단추를 문구 아래 줄로(DD17) */}
        {buttons.length > 0 && (
          <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap" sx={{ display: { xs: 'flex', sm: 'none' }, mt: 1 }}>
            {buttons}
          </Stack>
        )}
      </Box>
    ),
    action: buttons.length ? (
      <Stack direction="row" spacing={0.5} alignItems="center" sx={{ display: { xs: 'none', sm: 'flex' } }}>
        {buttons}
      </Stack>
    ) : undefined,
  };
}

/** 숨은 알림(DD16): 단계가 바뀌거나 묶음이 끝날 때만 한 번 읽는다. 실패·승인 대기는 assertive */
export function RolloutLive({ r }: { r: RolloutInfo | null | undefined }) {
  const last = useRef<{ name: string; phase: string; done: number } | null>(null);
  const [polite, setPolite] = useState('');
  const [loud, setLoud] = useState('');
  useEffect(() => {
    if (!r) return;
    const prev = last.current;
    last.current = { name: r.name, phase: r.phase, done: r.done };
    if (!prev || prev.name !== r.name) return; // 처음 그릴 때는 읽지 않는다
    const version = r.version || r.name;
    if (prev.phase !== r.phase) {
      const msg = t('rollout.live.phase', { version, state: t(`rollout.phase.${r.phase}`) });
      if (r.phase === 'Failed' || r.phase === 'WaitingApproval') setLoud(msg);
      else setPolite(msg);
    } else if (prev.done !== r.done) {
      setPolite(t('rollout.live.batch', { version, done: r.done, total: r.total }));
    }
  }, [r]);
  return (
    <>
      <Box role="alert" data-rollout-live="alert" sx={visuallyHidden}>
        {loud}
      </Box>
      <Box role="status" data-rollout-live="status" sx={visuallyHidden}>
        {polite}
      </Box>
    </>
  );
}

/** 버전 칸(DD6): 첫 줄 버전 이름(없으면 digest 12자), 둘째 줄 mono digest 12자(전체는 tooltip·복사). 색은 할 일이 있는 상태에만 */
export function VersionCell({ x }: { x: VersionFields & { suspended?: boolean } }) {
  const { enqueueSnackbar } = useSnackbar();
  const short = shortDigest(x.image_digest);
  const statePill = (() => {
    switch (x.rollout_state) {
      case 'waiting':
        return <Pill>{t('rollout.state.waiting')}</Pill>;
      case 'updating':
        return <Pill>{t('rollout.state.updating')}</Pill>;
      case 'reverted':
        return <Pill tone="warn">{t('rollout.state.reverted')}</Pill>;
      case 'failed':
        return <Pill tone="bad">{t('rollout.state.failed')}</Pill>;
      default:
        return null;
    }
  })();
  if (!x.image_digest) {
    const empty = x.suspended ? '—' : t('rollout.unknown');
    return (
      <Box component="span" sx={{ color: 'text.disabled' }}>
        {empty}
        {x.pinned && <Pill>{t('rollout.pinned')}</Pill>}
        {statePill}
      </Box>
    );
  }
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
        <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {x.version || short}
        </Box>
        {x.outdated && <Pill>{t('rollout.outdated')}</Pill>}
        {x.outdated == null && !x.pinned && <Pill>{t('rollout.unknown')}</Pill>}
        {x.pinned && <Pill>{t('rollout.pinned')}</Pill>}
      </Box>
      {/* 롤아웃 상태 알약은 둘째 줄: 첫 줄에 알약이 둘이면 190px 칸에서 버전 이름이 「1.0···」로 잘렸다(2026-10-29 OKE) */}
      <Box sx={{ display: 'flex', alignItems: 'center' }}>
        <Tooltip title={x.image_digest}>
          <Box component="span" sx={{ fontFamily: MONO_FONT, fontSize: 11, color: 'text.secondary' }}>
            {short}
          </Box>
        </Tooltip>
        <IconButton
          size="small"
          aria-label={t('rollout.copy')}
          onClick={(e) => {
            e.stopPropagation();
            void navigator.clipboard?.writeText(x.image_digest ?? '').then(() => enqueueSnackbar(t('rollout.copied'), { variant: 'success' }));
          }}
          sx={{ p: 0.25, ml: 0.25 }}
        >
          <ContentCopyOutlinedIcon sx={{ fontSize: 12 }} />
        </IconButton>
        {statePill}
      </Box>
    </Box>
  );
}

interface StartAgent {
  name: string;
  label: string;
  suspended?: boolean;
  pinned?: boolean;
  image_digest?: string;
}

/** 시작 서랍(DD10): 칸은 모두 보이는 라벨, 형식 검사, 저장소 경고(막지 않음), 대상 요약, 같은 요약을 담은 확인 창 */
export function RolloutStartForm({ agents, target, prefill }: { agents: StartAgent[]; target?: RolloutData['target']; prefill?: Partial<RolloutInfo> }) {
  const { enqueueSnackbar } = useSnackbar();
  const { closeDrawer } = useUi();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [version, setVersion] = useState(prefill?.version ?? '');
  const [image, setImage] = useState(prefill?.image ?? '');
  const [sidecar, setSidecar] = useState(prefill?.sidecar_image ?? '');
  const [canary, setCanary] = useState(prefill?.canary?.[0] ?? '');
  const [batch, setBatch] = useState(prefill?.batch_size ?? 2);
  const [skipBusy, setSkipBusy] = useState(prefill?.skip_busy ?? true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const badImage = !!image && !DIGEST_RE.test(image.trim());
  const badSidecar = !!sidecar && !DIGEST_RE.test(sidecar.trim());
  // 지금 쓰는 저장소: 목표가 있으면 그것, 없으면 가장 많은 에이전트가 도는 이미지의 저장소
  const repoNow =
    repoOf(target?.image) ||
    (() => {
      const count = new Map<string, number>();
      agents.forEach((a) => a.image_digest && count.set(repoOf(a.image_digest), (count.get(repoOf(a.image_digest)) ?? 0) + 1));
      return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    })();
  const repoDiffers = !!image && !badImage && !!repoNow && repoOf(image.trim()) !== repoNow;
  const k = agents.filter((a) => a.pinned).length;
  const j = agents.filter((a) => a.suspended && !a.pinned).length;
  const n = agents.length - k;
  const ready = !!version.trim() && (!!image.trim() || !!sidecar.trim()) && !badImage && !badSidecar;

  const submit = async () => {
    setError('');
    if (!image.trim() && !sidecar.trim()) {
      setError(t('rollout.form.needOne'));
      return;
    }
    const ok = await confirm(t('rollout.confirmStart', { version: version.trim(), n, k, j }), { title: t('rollout.confirmStartTitle'), confirmLabel: t('rollout.form.submit'), cancelFirst: true });
    if (!ok) return;
    setBusy(true);
    try {
      await post('/api/agents/rollout', {
        version_name: version.trim(),
        image: image.trim(),
        sidecar_image: sidecar.trim(),
        canary: canary ? [canary] : [],
        batch_size: batch,
        skip_busy: skipBusy,
      });
      enqueueSnackbar(t('rollout.started', { version: version.trim() }), { variant: 'success' });
      closeDrawer();
      await qc.invalidateQueries({ queryKey: ['hermes-agents'] });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const digestField = (label: string, value: string, set: (v: string) => void, bad: boolean, extra?: string) => (
    <TextField
      size="small"
      label={label}
      value={value}
      onChange={(e) => set(e.target.value)}
      error={bad}
      helperText={bad ? t('rollout.form.digestBad') : extra || t('rollout.form.digestHelp')}
      multiline
      minRows={2}
      slotProps={{ htmlInput: { spellCheck: false, style: { fontFamily: MONO_FONT, fontSize: 12, wordBreak: 'break-all' } } }}
    />
  );

  return (
    <Stack spacing={2}>
      <TextField size="small" label={t('rollout.form.version')} required value={version} onChange={(e) => setVersion(e.target.value)} placeholder={t('rollout.form.versionPlaceholder')} slotProps={{ htmlInput: { maxLength: 80 } }} />
      {digestField(t('rollout.form.image'), image, setImage, badImage)}
      {repoDiffers && (
        <Alert severity="warning" variant="outlined" sx={{ py: 0, color: 'text.primary' }}>
          {t('rollout.form.repoDiffers', { repo: repoNow })}
        </Alert>
      )}
      {digestField(t('rollout.form.sidecar'), sidecar, setSidecar, badSidecar)}
      <Box>
        <AgentPicker
          label={t('rollout.form.canary')}
          value={canary}
          onChange={setCanary}
          emptyLabel={t('rollout.form.noCanary')}
          options={agents.filter((a) => !a.pinned && !a.suspended).map((a) => ({ value: a.name, label: a.label }))}
        />
        <Typography variant="caption" color="text.secondary">
          {t('rollout.form.canaryHelp')}
        </Typography>
      </Box>
      <Box>
        <Typography component="label" htmlFor="rollout-batch" variant="caption" color="text.secondary" sx={{ display: 'block' }}>
          {t('rollout.form.batch')}
        </Typography>
        <NativeSelect id="rollout-batch" value={batch} onChange={(e) => setBatch(Number(e.target.value))}>
          {[1, 2, 3, 4, 5].map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </NativeSelect>
      </Box>
      <FormControlLabel control={<Checkbox checked={skipBusy} onChange={(e) => setSkipBusy(e.target.checked)} />} label={t('rollout.form.skipBusy')} />
      <Typography variant="body2" data-rollout-summary="">
        {t('rollout.form.summary', { n, k, j })}
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      <Box>
        <Button variant="contained" disabled={busy || !ready} onClick={submit}>
          {t('rollout.form.submit')}
        </Button>
      </Box>
    </Stack>
  );
}

const STATE_TONE: Record<string, 'warn' | 'bad' | undefined> = { reverted: 'warn', failed: 'bad' };

/** 상세 서랍(DD14): 에이전트별 상태·이전→목표·시간·메시지 */
export function RolloutDetail({ r, labelOf }: { r: RolloutInfo; labelOf: (n: string) => string }) {
  const change = (a: RolloutAgent) => {
    const parts = [];
    if (a.image) parts.push(`${shortDigest(a.previous) || '—'} → ${shortDigest(a.image)}`);
    if (a.sidecarImage) parts.push(`${t('rollout.kv.sidecar')} ${shortDigest(a.previousSidecar) || '—'} → ${shortDigest(a.sidecarImage)}`);
    return parts.join(' · ');
  };
  return (
    <Stack spacing={1.5}>
      {r.message && <Typography variant="body2">{r.message}</Typography>}
      <Box sx={{ overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>{t('rollout.col.agent')}</TableCell>
              <TableCell>{t('rollout.col.state')}</TableCell>
              <TableCell>{t('rollout.col.change')}</TableCell>
              <TableCell>{t('rollout.col.started')}</TableCell>
              <TableCell>{t('rollout.col.finished')}</TableCell>
              <TableCell>{t('rollout.col.message')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {r.agents.map((a) => (
              <TableRow key={a.name} data-rollout-agent={a.name}>
                <TableCell>{labelOf(a.name)}</TableCell>
                <TableCell>
                  <Pill flush tone={STATE_TONE[a.state]}>
                    {t(`rollout.state.${a.state}`)}
                  </Pill>
                </TableCell>
                <TableCell sx={{ fontFamily: MONO_FONT, fontSize: 12, whiteSpace: 'nowrap' }}>{change(a)}</TableCell>
                <TableCell sx={{ whiteSpace: 'nowrap' }}>{a.startedAt ? fmtTs(a.startedAt) : ''}</TableCell>
                <TableCell sx={{ whiteSpace: 'nowrap' }}>{a.finishedAt ? fmtTs(a.finishedAt) : ''}</TableCell>
                <TableCell>{a.message}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Box>
    </Stack>
  );
}

/** 띠 단추의 동작(DD5·DD8·DD12). 계속·되돌리기만 확인 창, 멈춤은 바로. 409 는 「다른 관리자가 이미 바꿨습니다」 뒤 다시 읽는다 */
export function useRolloutActions(r: RolloutInfo | null | undefined, labelOf: (n: string) => string) {
  const { enqueueSnackbar } = useSnackbar();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const send = async (action: string, done: string) => {
    if (!r) return;
    try {
      await post('/api/agents/rollout/action', { name: r.name, action });
      enqueueSnackbar(done, { variant: 'success' });
    } catch (e) {
      enqueueSnackbar(e instanceof ApiError && e.status === 409 ? t('rollout.conflict') : (e as Error).message, { variant: 'error' });
    }
    await qc.invalidateQueries({ queryKey: ['hermes-agents'] });
  };
  return {
    pause: () => void send('pause', t('rollout.paused')),
    resume: async () => {
      if (!r) return;
      const names = r.next_batch.map(labelOf);
      const ok = await confirm(t('rollout.confirmResume', { n: names.length, names: names.join(', ') }), { title: t('rollout.confirmResumeTitle'), confirmLabel: t('rollout.resume') });
      if (ok) await send('resume', t('rollout.resumed'));
    },
    abort: async () => {
      if (!r) return;
      const ok = await confirm(t('rollout.confirmAbort', { done: r.done, total: r.total }), { title: t('rollout.abort'), confirmLabel: t('rollout.abort'), cancelFirst: true });
      if (ok) await send('abort', t('rollout.aborted'));
    },
    rollback: async () => {
      if (!r) return;
      const names = changedAgents(r).map(labelOf);
      const ok = await confirm(t('rollout.confirmRollback', { n: names.length, names: names.join(', ') }), {
        title: t('rollout.confirmRollbackTitle'),
        confirmLabel: t('rollout.rollback'),
        cancelFirst: true,
      });
      if (ok) await send('rollback', t('rollout.rolledBack'));
    },
  };
}
