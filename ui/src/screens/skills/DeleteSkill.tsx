/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
// 스킬 지우기(스펙 2026-10-29-005). 스킬 서랍과 프로파일 「스킬」 패널이 같은 판정·확인 창·결과 처리를 쓴다(디자인 DD4).
// - 내 스킬(local·agent): POST /api/skill/delete → Hermes 보관함(skills/.archive). 스킬 허브 › 보관됨에서 되살린다
// - 스킬 허브 스킬(market): 이미 있는 POST /api/market/remove(배달기 요청). 실제로 없어질 때까지 「지우는 중」(DD2)
// - 그 밖(기본·허브·외부 폴더·출처 모름)은 단추를 그리지 않는다(DD3)
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded';
import { Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Menu, MenuItem, Tooltip, Typography, useMediaQuery, useTheme } from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { DisclosureButton } from '@/components/DisclosureButton';
import { tier2, tier3 } from '@/components/tierButton';
import { t } from '@/i18n';
import { ApiError, get, post } from '@/lib/api';
import { useIsAdmin, useMe } from '@/lib/data';
import { profileName } from '@/lib/format';
import { MONO_FONT } from '@/lib/monoFont';

import { DownloadSkill } from './DownloadSkill';

/** 지우기를 판정하는 데 쓰는 스킬 목록(/api/skills) 한 줄 */
export interface DeletableSkill {
  id: string;
  name: string;
  profile: string;
  origin?: string;
  shared_from?: string;
  /** 서버가 정한 지울 수 없는 이유(origin·same_name·name). 빈 값이면 지울 수 있다(server.skill_delete_block) */
  delete_block?: string;
}

interface MarketLite {
  admin?: boolean;
  can_install?: boolean;
  install?: { enabled?: boolean };
  installed?: { profile: string; name: string; namespace: string; kind: string }[];
}

/** none 은 단추를 그리지 않는다. why 가 있으면 화면이 「지울 수 없음」 이유로 보인다(에이전트 중심 보기) */
export type DeleteMode = { kind: 'none'; why?: string } | { kind: 'archive' | 'hub'; disabled?: string; namespace?: string; folder?: string };

/** 서버 줄의 「부르는 곳」 상세(/api/skill?id= 의 dependents, skill_deps.py) */
export interface Dependents {
  block: { kind: string; id: string; label: string; profile: string }[];
  warn: { kind: string; id: string; label: string; profile: string }[];
  agents: string[];
  checked: boolean;
  n_block?: number;
}

const BUILTIN = new Set(['bundled', 'bundled_modified', 'hub', 'aas']);

const MINE = new Set(['local', 'agent']);
const PENDING_KEY = ['skill-delete', 'pending'];
const PENDING_STALE_MS = 120000;
const keyOf = (s: { profile: string; name: string }) => `${s.profile}/${s.name}`;
/** id(`프로파일:경로`)의 경로 끝이 skills/market/<폴더> 이면 그 폴더(= 설치한 패키지 이름) */
const marketFolder = (id: string) => /(?:^|\/)skills\/market\/([^/]+)$/.exec(id.slice(id.indexOf(':') + 1))?.[1] ?? '';
const canInstall = (m: MarketLite) => m.can_install ?? !!m.admin;

/** 단추를 어떻게 보일지(DD3): 숨김(none) / 보관·스킬 허브 요청 + 비활성 이유. pending 은 지우기를 요청한 스킬 허브 스킬 */
export function deleteMode(s: DeletableSkill, ctx: { admin: boolean; market?: MarketLite; pending: boolean }): DeleteMode {
  if (s.shared_from) return { kind: 'none', why: t('skills.del.why.shared') };
  if (MINE.has(s.origin ?? '')) {
    if (s.delete_block === 'origin') return { kind: 'none', why: t('skills.del.why.origin') };
    if (s.delete_block === 'in_use') return { kind: 'archive', disabled: t('skills.del.why.in_use') };
    if (s.delete_block === 'same_name') return { kind: 'archive', disabled: t('skills.del.why.same_name') };
    if (s.delete_block === 'name') return { kind: 'archive', disabled: t('skills.del.why.name') };
    if (s.profile === 'default' && !ctx.admin) return { kind: 'archive', disabled: t('skills.del.why.default') };
    return { kind: 'archive' };
  }
  if (s.origin !== 'market' || !ctx.market)                                    // 출처를 모르거나 스킬 허브 기록을 아직 못 읽었다
    return { kind: 'none', why: BUILTIN.has(s.origin ?? '') ? t('skills.del.why.builtin') : s.origin === 'market' ? undefined : t('skills.del.why.origin') };
  const folder = marketFolder(s.id);
  const rec = (ctx.market.installed ?? []).find((r) => r.kind === 'skill' && r.profile === s.profile && r.name === folder);
  if (ctx.pending) return { kind: 'hub', disabled: t('skills.del.why.pending'), folder, namespace: rec?.namespace };
  if (ctx.market.install?.enabled === false || !canInstall(ctx.market)) return { kind: 'hub', disabled: t('skills.del.why.installOff') };
  if (!rec) return { kind: 'hub', disabled: t('skills.del.why.noRecord') };
  return { kind: 'hub', folder, namespace: rec.namespace };
}

/**
 * 지우기 판정·지우는 중 상태·확인 창을 한데 묶은 훅. rows 는 지금 보이는 스킬 목록(/api/skills).
 * 스킬 허브 스킬을 요청한 뒤에는 목록을 5초마다 다시 읽다가 그 줄이 없어지면 멈춘다(DD2).
 */
export function useSkillDelete(rows: DeletableSkill[] | undefined, onDeleted?: (s: DeletableSkill, kind: 'archive' | 'hub') => void) {
  const qc = useQueryClient();
  const admin = useIsAdmin();
  const pod = useMe().data?.pod?.id ?? '';
  const market = useQuery<MarketLite>({ queryKey: ['market', pod], queryFn: () => get<MarketLite>('/api/market'), staleTime: 60000 });
  const pending = useQuery<Record<string, number>>({ queryKey: PENDING_KEY, queryFn: () => ({}), initialData: {}, staleTime: Infinity }).data;
  const waiting = Object.keys(pending).length > 0;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!waiting) return;
    // 같은 열쇠에 관찰자를 하나 더 두면 목록 화면의 queryFn·로딩 상태를 바꿔 버려서, 타이머로 다시 읽게만 한다
    const id = window.setInterval(() => {
      setNow(Date.now());
      void qc.invalidateQueries({ queryKey: ['skills'] });
    }, 5000);
    return () => window.clearInterval(id);
  }, [waiting, qc]);
  useEffect(() => {
    // 요청한 스킬이 목록에서 사라졌으면(배달기가 지웠다) 기다리기를 끝낸다
    if (!rows || !waiting) return;
    const left = new Set(rows.map(keyOf));
    const next = Object.fromEntries(Object.entries(pending).filter(([k]) => left.has(k)));
    if (Object.keys(next).length !== Object.keys(pending).length) qc.setQueryData(PENDING_KEY, next);
  }, [rows, pending, waiting, qc]);
  const [open, setOpen] = useState<DeletableSkill | null>(null);
  const modeOf = (s: DeletableSkill) => deleteMode(s, { admin, market: market.data, pending: keyOf(s) in pending });
  /** 「지우는 중」: 요청한 스킬 허브 스킬. stale 은 2분이 지나도 남아 있을 때(요청 기록 링크를 보인다) */
  const pendingOf = (s: DeletableSkill) => (keyOf(s) in pending ? { stale: now - pending[keyOf(s)] > PENDING_STALE_MS } : null);
  const restorable = (s: DeletableSkill) => s.profile !== 'default' && !!market.data && canInstall(market.data);
  const dialog = open ? (
    <DeleteSkillDialog
      s={open}
      mode={modeOf(open)}
      restorable={restorable(open)}
      onClose={() => setOpen(null)}
      onDone={(kind) => {
        if (kind === 'hub') qc.setQueryData(PENDING_KEY, { ...pending, [keyOf(open)]: Date.now() });
        void qc.invalidateQueries({ queryKey: ['skills'] });
        void qc.invalidateQueries({ queryKey: ['market', pod, 'archived'] });       // 보관됨에 바로 보이게(DD6)
        void qc.invalidateQueries({ queryKey: ['skill', open.id] });
        onDeleted?.(open, kind);
      }}
    />
  ) : null;
  return { modeOf, pendingOf, open: setOpen, dialog };
}

/** 확인 창(DD1·DD4·DD5·DD7). 내용 순서: 어디서 지움 → 예약 작업 경고 → 되살리기/다시 설치 안내 → 내려받기 → [취소][지우기] */
export function DeleteSkillDialog({
  s,
  mode,
  restorable,
  onClose,
  onDone,
}: {
  s: DeletableSkill;
  mode: DeleteMode;
  restorable: boolean;
  onClose: (deleted: boolean) => void;
  onDone: (kind: 'archive' | 'hub') => void;
}) {
  const { enqueueSnackbar, closeSnackbar } = useSnackbar();
  const navigate = useNavigate();
  const fullScreen = useMediaQuery(useTheme().breakpoints.down('sm'));
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<{ message: string; detail: string } | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const detailId = useId();
  // 예약 작업 수·이름과 내려받기 경로는 스킬 상세에 있다. 패널에서 열면 여기서 처음 읽는다(DD4)
  const one = useQuery<{ path: string; cron: { profile: string; job: string }[]; dependents?: Dependents }>({
    queryKey: ['skill', s.id],
    queryFn: () => get('/api/skill?id=' + encodeURIComponent(s.id)),
  });
  const kind = mode.kind === 'hub' ? 'hub' : 'archive';
  const deps = one.data?.dependents;
  // 부르는 곳이 있으면 막는다(서버 skill_deps). 서버가 아직 색인을 못 만들었으면 예약 작업 경고만 보이고 지울 때 서버가 다시 본다
  const blocked = deps?.checked ? deps.block : [];
  const crons = (one.data?.cron ?? []).filter(() => !blocked.length);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      if (kind === 'hub') await post('/api/market/remove', { namespace: mode.kind === 'hub' ? mode.namespace : '', name: mode.kind === 'hub' ? mode.folder : '', profile: s.profile });
      else await post('/api/skill/delete', { id: s.id });
    } catch (e) {
      const detail = e instanceof ApiError ? String(e.data.detail ?? '') : '';
      setError({ message: (e as Error).message, detail });
      setBusy(false);
      return;
    }
    onDone(kind);
    onClose(true);
    enqueueSnackbar(kind === 'hub' ? t('skills.del.requested', { name: s.name }) : t('skills.del.done', { name: s.name }), {
      variant: 'success',
      action:
        kind === 'archive' && restorable
          ? (key) => (
              <Button
                size="small"
                color="inherit"
                onClick={() => {
                  closeSnackbar(key);
                  navigate('/market?tab=arch');
                }}
              >
                {t('skills.del.openArchived')}
              </Button>
            )
          : undefined,
    });
  };
  return (
    <Dialog open onClose={busy ? undefined : () => onClose(false)} aria-labelledby={titleId} fullWidth maxWidth="sm" fullScreen={fullScreen} TransitionProps={{ onEntered: () => cancelRef.current?.focus() }}>
      <DialogTitle id={titleId}>{t('skills.del.label', { name: s.name })}</DialogTitle>
      <DialogContent>
        <Typography variant="body2">{t('skills.del.where', { profile: profileName(s.profile) })}</Typography>
        {one.isPending ? (
          <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1.5, display: 'flex', alignItems: 'center', gap: 1 }}>
            <CircularProgress size={12} color="inherit" />
            {t('skills.del.loading')}
          </Typography>
        ) : (
          <>
            {blocked.length > 0 && (
              <Alert severity="error" sx={{ mt: 1.5 }} data-delete-blocked>
                {t('skills.del.blockTitle', { n: deps?.n_block ?? blocked.length })}
                <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 2 }}>
                  {blocked.map((d) => (
                    <li key={d.kind + d.id}>
                      <Typography variant="body2">{`${t(`skills.del.kind.${d.kind === 'cron' ? 'cron' : 'skill'}`)} · ${d.label}${d.profile ? ` (${profileName(d.profile)})` : ''}`}</Typography>
                    </li>
                  ))}
                </Box>
              </Alert>
            )}
            {crons.length > 0 && (
              <Alert severity="warning" icon={<WarningAmberRoundedIcon fontSize="small" />} sx={{ mt: 1.5 }}>
                {t('skills.del.cron', { count: crons.length, names: crons.map((c) => c.job).join(', ') })}
              </Alert>
            )}
            {!blocked.length && !!deps?.agents.length && (
              <Alert severity="warning" icon={<WarningAmberRoundedIcon fontSize="small" />} sx={{ mt: 1.5 }}>
                {t('skills.del.agents', { n: deps.agents.length, names: deps.agents.join(', ') })}
              </Alert>
            )}
            {!blocked.length && !!deps?.warn.length && (
              <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
                {t('skills.del.mentions', { n: deps.warn.length, names: deps.warn.map((d) => d.label).join(', ') })}
              </Typography>
            )}
          </>
        )}
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1.5 }}>
          {kind === 'hub' ? t('skills.del.reinstall') : restorable ? t('skills.del.restoreHere') : t('skills.del.restoreAdmin')}
        </Typography>
        {kind === 'archive' && one.data && <DownloadSkill s={{ name: s.name, profile: s.profile, path: one.data.path }} onBusy={setDownloading} />}
        {error && (
          <Alert severity="error" sx={{ mt: 1.5 }}>
            {error.message}
            {error.detail && (
              <Box sx={{ mt: 0.5 }}>
                <DisclosureButton open={showDetail} onToggle={() => setShowDetail((v) => !v)} label={t('skills.del.detail')} controls={detailId} />
                {showDetail && (
                  <Typography id={detailId} variant="caption" component="div" sx={{ fontFamily: MONO_FONT, mt: 0.5 }}>
                    {error.detail}
                  </Typography>
                )}
              </Box>
            )}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        {/* 처음 초점은 취소(되돌리기 어려운 동작, DD1) */}
        <Button variant="outlined" color="inherit" sx={tier2} onClick={() => onClose(false)} disabled={busy} ref={cancelRef}>
          {t('common.cancel')}
        </Button>
        <Button
          variant="outlined"
          color="inherit"
          sx={tier3}
          onClick={() => void run()}
          disabled={busy || downloading || blocked.length > 0}
          startIcon={busy ? <CircularProgress size={14} color="inherit" /> : undefined}
        >
          {busy ? t('skills.del.busy') : t('skills.del.ok')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * 프로파일 「스킬」 패널 줄 끝의 지우기(DD9). MCP 줄과 같은 모양: 44px 아이콘 단추, 600px 미만은 ⋮ 메뉴, 지울 수 없는 줄은
 * 단추 없이 44px 자리만 비워 스위치 열을 맞춘다. 비활성이면 이유를 툴팁과 설명(aria-describedby)으로 읽는다.
 */
export function SkillRowDelete({ name, mode, narrow, onOpen }: { name: string; mode: DeleteMode; narrow: boolean; onOpen: () => void }) {
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const reasonId = useId();
  // 단추가 없는 줄도 같은 44px 자리를 차지해 줄 높이가 같다(OKE T4: 높이를 안 줘서 단추 있는 줄만 높았다)
  if (mode.kind === 'none') return <Box aria-hidden data-skill-del-slot sx={{ width: 44, height: 44, ml: 1, flexShrink: 0 }} />;
  const label = t('skills.del.label', { name });
  if (narrow)
    return (
      <>
        <IconButton aria-label={label} aria-haspopup="menu" data-skill-del={name} onClick={(e) => setMenu(e.currentTarget)} sx={{ ml: 1, minWidth: 44, minHeight: 44 }}>
          <MoreVertIcon fontSize="small" />
        </IconButton>
        <Menu anchorEl={menu} open={!!menu} onClose={() => setMenu(null)}>
          <MenuItem
            disabled={!!mode.disabled}
            sx={{ minHeight: 44 }}
            onClick={() => {
              setMenu(null);
              onOpen();
            }}
          >
            {mode.disabled ? `${t('skills.del.menu')} · ${mode.disabled}` : t('skills.del.menu')}
          </MenuItem>
        </Menu>
      </>
    );
  if (mode.disabled)
    return (
      <>
        <Tooltip title={mode.disabled}>
          <span>
            <IconButton aria-label={label} aria-disabled="true" aria-describedby={reasonId} data-skill-del={name} onClick={(e) => e.preventDefault()} sx={{ ml: 1, minWidth: 44, minHeight: 44, opacity: 0.38, cursor: 'not-allowed' }}>
              <DeleteOutlineIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <span id={reasonId} hidden>
          {mode.disabled}
        </span>
      </>
    );
  return (
    <Tooltip title={label}>
      <IconButton aria-label={label} data-skill-del={name} onClick={onOpen} sx={{ ml: 1, minWidth: 44, minHeight: 44, '&:hover, &:focus-visible': { color: 'error.main' } }}>
        <DeleteOutlineIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  );
}

/**
 * 정리 모드의 한꺼번에 지우기. 새 일괄 API 없이 /api/skill/delete 를 하나씩 — 서버가 줄마다 권한·부르는 곳을 다시 본다.
 * 막히거나 실패한 스킬은 건너뛰고 끝에 이유를 모아 보인다.
 */
export function BulkDeleteDialog({ skills, onClose }: { skills: DeletableSkill[]; onClose: (done: boolean) => void }) {
  const qc = useQueryClient();
  const pod = useMe().data?.pod?.id ?? '';
  const { enqueueSnackbar } = useSnackbar();
  const fullScreen = useMediaQuery(useTheme().breakpoints.down('sm'));
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [done, setDone] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<{ name: string; error: string }[] | null>(null);
  const run = async () => {
    setBusy(true);
    const bad: { name: string; error: string }[] = [];
    let ok = 0;
    for (const s of skills) {
      try {
        await post('/api/skill/delete', { id: s.id });
        ok++;
      } catch (e) {
        bad.push({ name: s.name, error: (e as Error).message });
      }
      setDone((n) => n + 1);
    }
    void qc.invalidateQueries({ queryKey: ['skills'] });
    void qc.invalidateQueries({ queryKey: ['market', pod, 'archived'] });
    setBusy(false);
    if (ok) enqueueSnackbar(t('skills.del.bulkDone', { n: ok }), { variant: 'success' });
    if (bad.length) setFailed(bad);
    else onClose(true);
  };
  return (
    <Dialog open onClose={busy ? undefined : () => onClose(!!failed)} aria-labelledby={titleId} fullWidth maxWidth="sm" fullScreen={fullScreen} TransitionProps={{ onEntered: () => cancelRef.current?.focus() }}>
      <DialogTitle id={titleId}>{t('skills.del.bulkTitle', { n: skills.length })}</DialogTitle>
      <DialogContent>
        <Typography variant="body2">{t('skills.del.bulkWhat')}</Typography>
        <Box component="ul" sx={{ m: 0, mt: 1, pl: 2, maxHeight: 240, overflow: 'auto' }}>
          {skills.map((s) => (
            <li key={s.id}>
              <Typography variant="body2" sx={{ fontFamily: MONO_FONT, fontSize: 13 }}>
                {s.name}
              </Typography>
            </li>
          ))}
        </Box>
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
          {t('skills.del.restoreHere')}
        </Typography>
        {busy && (
          <Typography variant="body2" sx={{ mt: 1, display: 'flex', alignItems: 'center', gap: 1 }} role="status">
            <CircularProgress size={14} color="inherit" />
            {t('skills.del.bulkBusy', { done, n: skills.length })}
          </Typography>
        )}
        {failed && (
          <Alert severity="error" sx={{ mt: 1.5 }}>
            {t('skills.del.bulkFailed', { n: failed.length })}
            <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 2 }}>
              {failed.map((f) => (
                <li key={f.name}>
                  <Typography variant="body2">{`${f.name} — ${f.error}`}</Typography>
                </li>
              ))}
            </Box>
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button variant="outlined" color="inherit" sx={tier2} onClick={() => onClose(!!failed)} disabled={busy} ref={cancelRef}>
          {failed ? t('common.close') : t('common.cancel')}
        </Button>
        {!failed && (
          <Button
            variant="outlined"
            color="inherit"
            sx={tier3}
            onClick={() => void run()}
            disabled={busy || !skills.length}
            startIcon={busy ? <CircularProgress size={14} color="inherit" /> : <DeleteOutlineIcon />}
          >
            {busy ? t('skills.del.bulkBusy', { done, n: skills.length }) : t('skillsAgent.cleanupGo', { n: skills.length })}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
