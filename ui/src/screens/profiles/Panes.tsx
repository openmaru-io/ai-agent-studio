/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 프로파일 상세의 탭: 비밀값, 스킬, 도구묶음·MCP, 크론.
import AddIcon from '@mui/icons-material/Add';
import BuildOutlinedIcon from '@mui/icons-material/BuildOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import ExtensionOutlinedIcon from '@mui/icons-material/ExtensionOutlined';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import NetworkCheckOutlinedIcon from '@mui/icons-material/NetworkCheckOutlined';
import ScheduleOutlinedIcon from '@mui/icons-material/ScheduleOutlined';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  IconButton,
  Menu,
  MenuItem,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import { visuallyHidden } from '@mui/utils';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Section, Tag } from '@/components/bits';
import { BundledRepair, BundledRepairNote } from '@/components/BundledRepairNote';
import { useConfirm } from '@/components/ConfirmDialog';
import { Pill } from '@/components/DataGrid';
import { DisclosureButton } from '@/components/DisclosureButton';
import { useInDrawer } from '@/components/drawerScope';
import { compactSwitchSx, ItemEmpty, ItemList, ItemRow } from '@/components/ItemRow';
import { StatusPill } from '@/components/StatusPill';
import { tier1 } from '@/components/tierButton';
import { useUi } from '@/components/UiContext';
import { hasKey, t } from '@/i18n';
import { get } from '@/lib/api';
import { describe } from '@/lib/cronmath';
import { useMe } from '@/lib/data';
import { MONO_FONT } from '@/lib/monoFont';
import { serverTerm } from '@/lib/serverTerms';
import { useFocusOnMount } from '@/lib/useFocusOnMount';
import { CreateSkill } from '@/screens/Skills';
import { DeletableSkill, SkillRowDelete, useSkillDelete } from '@/screens/skills/DeleteSkill';

import { NewJobBody } from '../cron/NewJob';
import { CredentialFiles } from './CredentialFiles';
import { type LoginEnd, loginView, useMcpLogin } from './McpLogin';
import { AddServerDialog } from './McpServers';
import { calmAlertSx, capWhy, mayManage, PaneUnreadable, useProfileAct } from './shared';
import { isMySkill, skillOriginLabel } from './skillOrigin';
import { useProfileSpot } from './spot';
import type { EnvVar, McpItem, ProfileDetailData, SkillItem, ToolsetItem } from './types';
function Toggle({
  on,
  label,
  done,
  disabled,
  change,
  offConfirm,
}: {
  on: boolean;
  label: string;
  /** 켜거나 끈 뒤 알림 글. 무엇을 켜고 껐는지 이름을 넣어서 준다 */
  done: (next: boolean) => string;
  disabled: boolean;
  change: (next: boolean) => Promise<unknown>;
  /** 끌 때 묻는 말. 끄면 에이전트가 그 도구를 못 쓰게 되므로 확인한다(OMAI-1135) */
  offConfirm?: string;
}) {
  const { enqueueSnackbar } = useSnackbar();
  const confirm = useConfirm();
  const [value, setValue] = useState(on);
  const [busy, setBusy] = useState(false);
  return (
    <Switch
      checked={value}
      sx={compactSwitchSx}
      disabled={disabled || busy}
      slotProps={{ input: { 'aria-label': label, role: 'switch' } }}
      onChange={async (e) => {
        const next = e.target.checked;
        if (!next && offConfirm && !(await confirm(offConfirm))) return;
        setBusy(true);
        try {
          await change(next);
          setValue(next);
          enqueueSnackbar(done(next), { variant: 'success' });
        } catch (er) {
          enqueueSnackbar((er as Error).message, { variant: 'error' });
        }
        setBusy(false);
      }}
    />
  );
}

// ---- 비밀값: 이름과 채워져 있는지만 보여 준다. 값은 넣을 수만 있고 다시 볼 수 없다. ----
export function SetValue({ name, target, overwrite, onDone }: { name: string; target: string; overwrite?: boolean; onDone: () => void }) {
  const { act, refresh } = useProfileAct(name);
  const { enqueueSnackbar } = useSnackbar();
  const confirm = useConfirm();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const first = useFocusOnMount<HTMLInputElement>();
  const save = async () => {
    if (!value) return;
    setError('');
    // 있는 값을 바꾸면 지금 값은 되찾을 수 없으므로 확인한다(OMAI-1135)
    if (overwrite && !(await confirm(t('profiles.envOverwriteConfirm', { target })))) return;
    setBusy(true);
    try {
      await act('env_set', { target, value });
      setValue('');
      enqueueSnackbar(t('profiles.envSaved', { target }), { variant: 'success' });
      await refresh();
      onDone();
    } catch (e) {
      // 거절 문구는 값을 넣던 칸 아래에 두고 포커스를 칸으로 돌려준다(디자인 결정 2A, TD3)
      setError((e as Error).message);
      first.current?.focus();
      setBusy(false);
    }
  };
  return (
    <Stack direction="row" spacing={1} sx={{ width: '100%' }}>
      <TextField
        size="small"
        type="password"
        inputRef={first}
        error={!!error}
        helperText={error || undefined}
        slotProps={{ htmlInput: { 'aria-label': t('profiles.newValueOf', { target }), spellCheck: false, 'aria-invalid': !!error }, formHelperText: { role: 'alert' } }}
        autoComplete="off"
        placeholder={t('profiles.newValue')}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        sx={{ flex: 1, minWidth: 160 }}
      />
      <Button variant="contained" disabled={busy} onClick={save}>
        {t('profiles.save')}
      </Button>
      <Button onClick={onDone}>{t('profiles.cancel')}</Button>
    </Stack>
  );
}

function EnvRow({ v, name, ok }: { v: EnvVar; name: string; ok: boolean }) {
  const { act, refresh } = useProfileAct(name);
  const { enqueueSnackbar } = useSnackbar();
  const [mode, setMode] = useState<'idle' | 'set' | 'clear'>('idle');
  const [confirmName, setConfirmName] = useState('');
  const clear = async () => {
    try {
      await act('env_clear', { target: v.name, confirm: confirmName });
      enqueueSnackbar(t('profiles.envCleared', { name: v.name }), { variant: 'success' });
      await refresh();
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
    }
  };
  return (
    <ItemRow
      icon={KeyOutlinedIcon}
      name={v.name}
      mono
      off={!v.set}
      tags={
        <>
          {v.set ? <Tag tone="good">{t('profiles.envSet')}</Tag> : <Tag>{t('profiles.envEmpty')}</Tag>}
          {v.locked && (
            <Tag>
              <LockOutlinedIcon sx={{ fontSize: 12, mr: 0.5, verticalAlign: 'text-bottom' }} aria-hidden />
              {t('profiles.envLocked')}
            </Tag>
          )}
          {v.channel && <Tag>{t('profiles.envForChannel')}</Tag>}
          {v.category && <Tag>{hasKey(`profiles.envCat.${v.category}`) ? t(`profiles.envCat.${v.category}`) : v.category}</Tag>}
        </>
      }
      description={v.description_src ? <span title={v.description_src}>{v.description}</span> : v.description}
      control={
        ok && !v.locked && mode === 'idle' ? (
          <>
            <Button size="small" startIcon={<EditOutlinedIcon />} onClick={() => setMode('set')}>
              {v.set ? t('profiles.envChange') : t('profiles.envPut')}
            </Button>
            {v.set && (
              <Button startIcon={<DeleteOutlineIcon />} size="small" color="error" onClick={() => setMode('clear')}>
                {t('profiles.envClear')}
              </Button>
            )}
          </>
        ) : null
      }
      below={
        v.locked ? (
          <Typography variant="caption" color="text.secondary">
            {v.locked}
          </Typography>
        ) : mode === 'set' ? (
          <SetValue name={name} target={v.name} overwrite={v.set} onDone={() => setMode('idle')} />
        ) : mode === 'clear' ? (
          <Stack direction="row" spacing={1} alignItems="center" sx={{ width: '100%' }}>
            <Typography variant="caption">{t('profiles.envClearTypeName')}</Typography>
            <TextField
              size="small"
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              placeholder={v.name}
              slotProps={{ htmlInput: { 'aria-label': t('profiles.confirmNameLabel'), style: { fontFamily: MONO_FONT } } }}
            />
            <Button startIcon={<DeleteOutlineIcon />} size="small" color="error" variant="contained" onClick={clear}>
              {t('profiles.envClear')}
            </Button>
            <Button size="small" onClick={() => setMode('idle')}>
              {t('profiles.cancel')}
            </Button>
          </Stack>
        ) : null
      }
    />
  );
}

export function EnvPane({ d }: { d: ProfileDetailData }) {
  const { enqueueSnackbar } = useSnackbar();
  // 스킬 서랍의 「비밀값 탭에서 넣기」가 ?key= 로 그 변수를 고른다(스펙 2026-10-16-010 2단계). 아직 없는 변수면 넣기 칸을 바로 연다
  const wanted = (useProfileSpot().get('key') ?? '').toUpperCase();
  const known = !!wanted && (d.env ?? []).some((v) => v.name === wanted);
  const [q, setQ] = useState(known ? wanted : '');
  const [all, setAll] = useState(known);
  const [showLocked, setShowLocked] = useState(false);
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState<string | null>(wanted && !known && /^[A-Z][A-Z0-9_]{1,63}$/.test(wanted) ? wanted : null);
  // 링크(?key=)로 와서 비어 있던 그 변수를 넣으면 「Claude Code 로 돌아가세요」(스펙 2026-10-28-001 §3-7 ⑥). 처음부터 있던 값이면 띄우지 않는다
  const wasSet = useRef(!!wanted && (d.env ?? []).some((v) => v.name === wanted && v.set));
  const savedFromLink = !!wanted && !wasSet.current && (d.env ?? []).some((v) => v.name === wanted && v.set);
  const name = d.profile.name;
  if (!d.env)
    return (
      <PaneUnreadable d={d}>
        <Alert severity="warning">{t('profiles.envUnreadable')}</Alert>
      </PaneUnreadable>
    );
  const mayEdit = d.can_edit || mayManage(d); // 관리자와 그 에이전트의 주인. 모델 제공자 키·동작 변수는 서버가 거절한다(스펙 2026-10-15-011 D3)
  const ok = mayEdit && d.secure;
  const why =
    capWhy(d, 'env') ||
    (!mayEdit ? t('profiles.adminOnlyChange') : !d.secure ? t('profiles.envInsecure') : '');
  const needle = q.trim().toLowerCase();
  // 주인 화면: 서버가 막는 변수는 기본으로 접고 「잠긴 변수도 보기」를 켜면 잠금 사유와 함께 보인다(디자인 결정 2C)
  const lockedCount = d.env.filter((v) => v.locked).length;
  const visible = showLocked ? d.env : d.env.filter((v) => !v.locked || v.set);
  const shown = (all ? visible : visible.filter((v) => v.set)).filter(
    (v) => !needle || [v.name, v.description ?? '', v.description_src ?? ''].join(' ').toLowerCase().includes(needle)
  );
  return (
    <Box>
      {why && (
        <Alert severity="warning" sx={{ mb: 1, ...calmAlertSx }}>
          {why}
        </Alert>
      )}
      {savedFromLink && (
        <Alert severity="success" role="status" sx={{ mb: 1 }}>
          {t('profiles.envSavedBack', { target: wanted })}
        </Alert>
      )}
      <Stack direction="row" spacing={1.5} alignItems="center" useFlexGap flexWrap="wrap" sx={{ mb: 1 }}>
        <TextField
          size="small"
          type="search"
          placeholder={t('profiles.envSearch')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          slotProps={{ htmlInput: { 'aria-label': t('profiles.envSearchLabel'), 'data-view-search': '' } }}
        />
        <FormControlLabel
          control={<Checkbox checked={all} onChange={(e) => setAll(e.target.checked)} />}
          label={t('profiles.envShowAll', { n: d.env.length })}
        />
        {lockedCount > 0 && (
          <FormControlLabel
            control={<Checkbox checked={showLocked} onChange={(e) => setShowLocked(e.target.checked)} />}
            label={t('profiles.envShowLocked', { n: lockedCount })}
          />
        )}
        <Typography variant="caption" color="text.secondary">{t('profiles.envFilled', {
          n: d.env.filter((v) => v.set).length,
        })}</Typography>
      </Stack>
      <ItemList>
        {shown.length ? (
          shown.slice(0, 300).map((v) => <EnvRow key={v.name} v={v} name={name} ok={ok} />)
        ) : (
          <ItemEmpty>{all ? t('profiles.envNoMatch') : t('profiles.envNoneFilled')}</ItemEmpty>
        )}
      </ItemList>
      {ok && (
        <Section title={t('profiles.envAddTitle')}>
          {adding ? (
            <Stack direction="row" spacing={1} alignItems="center">
              <code>{adding}</code>
              <SetValue name={name} target={adding} onDone={() => setAdding(null)} />
            </Stack>
          ) : (
            <Stack direction="row" spacing={1}>
              <TextField
                size="small"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t('profiles.envNewPlaceholder')}
                slotProps={{ htmlInput: { 'aria-label': t('profiles.envNewLabel'), spellCheck: false } }}
              />
              <Button startIcon={<AddIcon />} data-guide="profiles.env-add"
                onClick={() => {
                  const k = newName.trim().toUpperCase();
                  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(k))
                    enqueueSnackbar(t('profiles.envNameRule'), { variant: 'error' });
                  else setAdding(k);
                }}
              >
                {t('profiles.envAddButton')}
              </Button>
            </Stack>
          )}
        </Section>
      )}
      <CredentialFiles pod={d.pod} profile={name} />
      <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
        {t('profiles.envNote')}
      </Typography>
    </Box>
  );
}

// ---- 스킬 ----

export function SkillsPane({ d }: { d: ProfileDetailData }) {
  const { act, refresh } = useProfileAct(d.profile.name);
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [mineOnly, setMineOnly] = useState(false);
  const { openDrawer, navigateDrawer } = useUi();
  const inDrawer = useInDrawer();
  const me = useMe().data;
  const list = useQuery<{ skills: DeletableSkill[]; can_upload?: boolean; bundled_repaired?: BundledRepair[] }>({
    queryKey: ['skills'],
    queryFn: () => get('/api/skills'),
    staleTime: 120000,
  });
  // 지우기(스펙 2026-10-29-005 DD9·DD10): 줄 끝 단추. 지운 뒤 초점은 다음 줄의 지우기 단추 → 이전 줄 → 검색 칸, 결과는 aria-live 로 읽는다
  const narrow = useMediaQuery(useTheme().breakpoints.down('sm'));
  const paneRef = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState('');
  const [focusAfter, setFocusAfter] = useState<{ next?: string; prev?: string; gone: string } | null>(null);
  const del = useSkillDelete(list.data?.skills, (x, kind) => {
    setLive(kind === 'hub' ? t('skills.del.requested', { name: x.name }) : t('skills.del.done', { name: x.name }));
    void refresh();
  });
  useEffect(() => {
    if (!focusAfter || d.skills?.some((x) => x.name === focusAfter.gone)) return;   // 목록이 새로 읽혀 그 줄이 사라진 뒤에 옮긴다
    const pane = paneRef.current;
    const pick = (n?: string) => (n ? pane?.querySelector<HTMLElement>(`[data-skill-del="${CSS.escape(n)}"]`) : null);
    (pick(focusAfter.next) ?? pick(focusAfter.prev) ?? pane?.querySelector<HTMLElement>('[data-view-search]'))?.focus();
    setFocusAfter(null);
  }, [focusAfter, d.skills]);
  if (!d.skills)
    return (
      <PaneUnreadable d={d}>
        <Alert severity="warning">{t('profiles.skillsUnreadable')}</Alert>
      </PaneUnreadable>
    );
  const name = d.profile.name;
  const open = (s: SkillItem) => {
    const g = list.data?.skills ?? [];
    const m = g.find((x) => x.name === s.name && x.profile === name) ?? g.find((x) => x.name === s.name);
    // 서랍 안이면 메뉴를 옮기지 않고 이 서랍에 스킬 연결도를 연다(스펙 2026-10-26-003 T1). 스킬을 못 찾으면 지금처럼 스킬 목록 검색으로
    if (m && inDrawer) return void navigateDrawer({ kind: 'skillMap', root: 'skill:' + m.id });
    navigate(
      m ? `/flows?${new URLSearchParams({ root: 'skill:' + m.id })}` : `/skills?${new URLSearchParams({ tab: 'all', profile: name, q: s.name })}`
    );
  };
  const originOf = (s: SkillItem) => skillOriginLabel(list.data?.skills ?? [], name, s.name, s.provenance);
  const needle = q.trim().toLowerCase();
  const canAddSkill = d.caps?.skills?.can ?? (d.can_edit || mayManage(d));
  // 내 스킬: 스킬 목록(/api/skills)에서 이 프로파일의 기본 제공(Hermes 기본·AAS 기본)이 아닌 것(스펙 2026-10-27-011 R7·R13, 「스킬」 화면과 같은 판정).
  // 목록에 없는 줄(출처를 모름)은 내 스킬로 세지 않는다. 목록을 받는 중이면 수를 「—」로, 못 받으면 체크 상자를 숨긴다(디자인 리뷰 D9)
  const mine = new Set((list.data?.skills ?? []).filter((x) => x.profile === name && isMySkill(x.origin)).map((x) => x.name));
  const listReady = !!list.data;
  const hit = d.skills.filter(
    (s) =>
      (!needle || [s.name, s.description ?? '', s.description_src ?? ''].join(' ').toLowerCase().includes(needle)) && (!mineOnly || !listReady || mine.has(s.name))
  );
  /** 이 줄의 스킬 목록 항목 — 이 프로파일의 것만(공용 줄과 섞지 않는다). 못 찾으면 출처를 몰라 지우기 단추를 그리지 않는다(DD3) */
  const rowOf = (s: SkillItem) => (list.data?.skills ?? []).find((x) => x.name === s.name && x.profile === name);
  const shown = hit.slice(0, 300);
  return (
    <Box ref={paneRef}>
      <Box aria-live="polite" sx={visuallyHidden}>
        {live}
      </Box>
      {del.dialog}
      <BundledRepairNote pod={me?.pod?.id ?? ''} records={list.data?.bundled_repaired} profile={name} />
      {/* 좁은 서랍에서 「새 스킬」이 잘리지 않게 줄을 바꾼다(디자인 리뷰 D21) */}
      <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
        <TextField
          size="small"
          type="search"
          placeholder={t('profiles.skillSearch')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          slotProps={{ htmlInput: { 'aria-label': t('profiles.skillSearchLabel'), 'data-view-search': '' } }}
        />
        {!list.isError && (
          <FormControlLabel
            control={<Checkbox size="small" checked={mineOnly && listReady} disabled={!listReady} onChange={(e) => setMineOnly(e.target.checked)} />}
            label={listReady ? t('profiles.skillsMineOnly', { n: mine.size }) : t('profiles.skillsMineOnlyLoading')}
            title={t('profiles.skillsMineOnlyTip')}
            sx={{ mr: 0, '& .MuiFormControlLabel-label': { fontSize: 13 } }}
          />
        )}
        <Typography variant="caption" color="text.secondary">{t('profiles.skillsEnabledSummary', {
          total: d.skills.length,
          enabled: d.skills.filter((s) => s.enabled).length,
        })}</Typography>
        {/* 새 스킬: 탭 바로 밑 줄 오른쪽 끝(2026-10-17-017). 스킬 화면의 새 스킬 서랍을 이 프로파일로 연다.
            만든 뒤에는 스킬 화면으로 가지 않고 이 탭에 머물며 목록을 다시 읽는다 */}
        {canAddSkill && (
          <Button
            startIcon={<AddIcon />}
            size="small"
            variant="outlined"
            color="inherit"
            sx={{ ml: 'auto !important', flexShrink: 0 }}
            onClick={() =>
              openDrawer({
                title: t('skills.newSkill'),
                sub: t('profiles.newSkillSub', { name }),
                body: <CreateSkill profiles={[name]} initialProfile={name} canUpload={!!list.data?.can_upload} onCreated={() => void refresh()} />,
              })
            }
          >
            {t('skills.newSkill')}
          </Button>
        )}
      </Stack>
      <ItemList>
        {hit.length ? (
          shown.map((s, i) => {
            const r = rowOf(s);
            const pend = r ? del.pendingOf(r) : null;
            return (
            <ItemRow
              key={s.name}
              dense
              icon={ExtensionOutlinedIcon}
              name={s.name}
              onName={() => open(s)}
              off={!s.enabled}
              tags={
                <>
                  {s.usage ? <Tag>{t('profiles.skillUsage', { n: s.usage })}</Tag> : null}
                  {s.category ? <Tag>{s.category}</Tag> : null}
                  {originOf(s) ? <Tag>{originOf(s)}</Tag> : null}
                  {pend && <Pill tone="warn">{t('skills.del.pending')}</Pill>}
                </>
              }
              description={s.description_src ? <span title={s.description_src}>{s.description}</span> : s.description || t('profiles.noDescription')}
              control={
                <>
                <Toggle
                  on={s.enabled}
                  label={t('profiles.skillToggle', { name: s.name })}
                  done={(on) => t(on ? 'profiles.skillOn' : 'profiles.skillOff', { name: s.name })}
                  disabled={!d.can_edit && !mayManage(d)}
                  change={(on) => act('skill', { target: s.name, enabled: on })}
                  offConfirm={t('profiles.skillOffConfirm', { name: s.name })}
                />
                <SkillRowDelete
                  name={s.name}
                  mode={r ? del.modeOf(r) : { kind: 'none' }}
                  narrow={narrow}
                  onOpen={() => {
                    if (!r) return;
                    setFocusAfter({ next: shown[i + 1]?.name, prev: shown[i - 1]?.name, gone: s.name });
                    del.open(r);
                  }}
                />
                </>
              }
            />
            );
          })
        ) : (
          <ItemEmpty>{mineOnly && listReady && !needle && !mine.size ? t('profiles.skillsMineNone') : t('profiles.skillsNoMatch')}</ItemEmpty>
        )}
      </ItemList>
    </Box>
  );
}

// ---- MCP · 도구 묶음 ----
function McpRow({ m, d, name, auto, focused, onRemoved, onChanged }: { m: McpItem; d: ProfileDetailData; name: string; auto?: boolean; focused?: boolean; onRemoved: (info: string) => void; onChanged: () => void }) {
  const { act, refresh } = useProfileAct(name);
  const confirm = useConfirm();
  const spot = useProfileSpot();
  const [result, setResult] = useState<ReactNode>(null);
  const [busy, setBusy] = useState(false);
  const mayEdit = d.can_edit || mayManage(d);
  const test = async () => {
    setBusy(true);
    setResult(<Typography color="text.secondary">{t('profiles.mcp.testing', { name: m.name })}</Typography>);
    try {
      const r = await act<{ test: { ok: boolean; tools: number; error?: string; timeout?: boolean } }>('mcp_test', { target: m.name });
      setResult(
        r.test.ok ? (
          r.test.tools > 0 ? (
            <Tag tone="good">{t('profiles.mcpConnected', { name: m.name, count: r.test.tools })}</Tag>
          ) : (
            <Alert severity="warning" sx={calmAlertSx}>{`${m.name}: ${t('profiles.mcp.noTools')}`}</Alert>
          )
        ) : (
          <Alert severity="warning" sx={calmAlertSx}>
            <Box>
              {r.test.timeout ? `${m.name}: ${t('profiles.mcp.timeout')}` : `${m.name}: ${t('profiles.mcp.failed', { error: r.test.error || t('profiles.mcpFailed') })}`}
            </Box>
            {mayEdit && (
              <Button size="small" color="inherit" sx={{ mt: 0.5, ml: -1 }} onClick={() => spot.patch({ name, pane: 'config' }, { replace: true })}>
                {t('profiles.mcp.fixInConfig')}
              </Button>
            )}
          </Alert>
        )
      );
    } catch (e) {
      setResult(<Alert severity="warning" sx={calmAlertSx}>{(e as Error).message}</Alert>);
    }
    setBusy(false);
  };
  // OAuth 서버(스펙 2026-10-16-010 11-3): 상태 알약·주 단추·설명 줄. 로그인은 팝업으로 하고 끝나면 목록을 다시 읽는다
  const oauth = m.auth === 'oauth';
  const qc = useQueryClient();
  const narrow = useMediaQuery(useTheme().breakpoints.down('sm')); // 600px 미만: 주 단추는 설명 아래 전체 폭, 오른쪽은 스위치와 더보기만(V12)
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const [focusAfter, setFocusAfter] = useState(false);
  const login = useMcpLogin({
    pod: d.pod ?? '',
    profile: name,
    server: m.name,
    resume: !!(oauth && m.login_state?.state === 'logging_in' && m.login_state.mine),
    onEnd: async (end: LoginEnd, error?: string) => {
      const said: Record<LoginEnd, string> = {
        approved: t('profiles.mcp.login.done', { name: m.name }),
        cancelled: t('profiles.mcp.login.cancelled', { name: m.name }),
        expired: t('profiles.mcp.login.expired', { name: m.name }),
        error: t('profiles.mcp.login.error', { name: m.name, error: error || '' }),
      };
      setResult(end === 'approved' ? <Typography color="text.secondary">{said[end]}</Typography> : <Alert severity="warning" sx={calmAlertSx}>{said[end]}</Alert>);
      await Promise.all([refresh(), qc.invalidateQueries({ queryKey: ['inventory', 'credentials'] })]); // 자산 › 자격증명의 토큰 행(T7, 11-6)
      setFocusAfter(true); // 초점은 그 행의 새 주 단추로(V13)
    },
  });
  // 이 창에서 시작한 로그인은 목록을 다시 읽기 전에도 「로그인 중」·「취소」로 보인다(V10)
  const view = oauth ? loginView(login.active ? { ...m, login_state: { state: 'logging_in', mine: true } } : m, mayEdit) : null;
  useEffect(() => {
    if (focusAfter) {
      primaryRef.current?.focus();
      setFocusAfter(false);
    }
  }, [focusAfter, m.login_state?.state]);
  // 방금 추가한 서버는 행이 뜨자마자 한 번 시험한다(스펙 §11 결정 5A). OAuth 서버는 로그인이 먼저라 건너뛰고 「로그인」에 초점을 둔다(V9)
  const ran = useRef(false);
  useEffect(() => {
    if (auto && !ran.current) {
      ran.current = true;
      if (oauth) primaryRef.current?.focus();
      else void test();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto]);
  const remove = async () => {
    if (!(await confirm(t('profiles.mcp.deleteConfirm', { name: m.name }), { danger: true }))) return;
    setBusy(true);
    try {
      const r = await act<{ env_cleared?: number; env_left?: number; toolsets_off_notice?: boolean }>('mcp_remove', { target: m.name });
      onChanged();
      await refresh();
      onRemoved(
        r.env_left
          ? t('profiles.mcp.deletedLeft', { name: m.name, count: r.env_left })
          : r.env_cleared
          ? t('profiles.mcp.deletedSecrets', { name: m.name, count: r.env_cleared })
          : t('profiles.mcp.deleted', { name: m.name })
      );
      // Outline 을 설치할 때 끈 브라우저·외부 연결 도구는 지워도 돌아오지 않는다 — 다시 켜지 않고 알린다(2026-10-23-004 R6·D9)
      if (r.toolsets_off_notice) onRemoved(t('profiles.mcp.toolsetsStillOff'));
    } catch (e) {
      setResult(<Alert severity="warning" sx={calmAlertSx}>{(e as Error).message}</Alert>);
      setBusy(false);
    }
  };
  // 헤더 인증 원격 서버를 OAuth 로 바꾸기(V15). 지금 토큰 줄을 지우고, 이어서 로그인해야 한다
  const headerRemote = m.auth === 'header' && m.transport !== 'stdio';
  const toOauth = async () => {
    setMenu(null);
    const key = `MCP_${m.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')}_API_KEY`;
    if (!(await confirm(t('profiles.mcp.toOauthConfirm', { name: m.name, key })))) return;
    setBusy(true);
    try {
      await act('mcp_to_oauth', { target: m.name });
      onChanged();
      await refresh();
      setResult(<Typography color="text.secondary">{t('profiles.mcp.toOauthDone', { name: m.name })}</Typography>);
      setFocusAfter(true); // 행이 「로그인 필요」가 되면 초점은 「로그인」으로(V9 와 같은 모습)
    } catch (e) {
      setResult(<Alert severity="warning" sx={calmAlertSx}>{(e as Error).message}</Alert>);
    }
    setBusy(false);
  };
  const primary =
    !view || view.primary === 'test' ? (
      <Button startIcon={<NetworkCheckOutlinedIcon />} size="small" disabled={busy} onClick={test} ref={primaryRef} fullWidth={narrow} sx={narrow ? { minHeight: 44 } : undefined}>
        {t('profiles.mcpTest')}
      </Button>
    ) : view.primary === 'cancel' ? (
      <Button size="small" disabled={busy} onClick={() => void login.cancel()} ref={primaryRef} fullWidth={narrow} sx={{ minHeight: narrow ? 44 : 36 }}>
        {t('profiles.mcp.login.cancel')}
      </Button>
    ) : view.primary === 'login' || view.primary === 'relogin' ? (
      <Button
        size="small"
        variant="outlined"
        color="inherit"
        disabled={busy || !d.pod}
        onClick={() => {
          setResult(null);
          login.start();
        }}
        ref={primaryRef}
        fullWidth={narrow}
        aria-label={t(view.primary === 'relogin' ? 'profiles.mcp.login.reloginOf' : 'profiles.mcp.login.loginOf', { name: m.name })}
        sx={[tier1 as object, { minHeight: narrow ? 44 : 36 }]}
      >
        {t(view.primary === 'relogin' ? 'profiles.mcp.login.relogin' : 'profiles.mcp.login.login')}
      </Button>
    ) : null;
  const menuItems = [
    ...(mayEdit && headerRemote ? [{ key: 'oauth', label: t('profiles.mcp.toOauth'), run: toOauth }] : []),
    ...(mayEdit && narrow ? [{ key: 'delete', label: t('profiles.mcp.delete', { name: m.name }), run: () => { setMenu(null); void remove(); } }] : []),
  ];
  return (
    <ItemRow
      icon={DnsOutlinedIcon}
      name={m.name}
      off={!m.enabled}
      focused={focused}
      tags={
        <>
          {view && (
            <Box component="span" sx={{ mr: 0.5 }}>
              <StatusPill tone={view.tone}>{view.label}</StatusPill>
            </Box>
          )}
          <Tag>{m.transport || '?'}</Tag>
        </>
      }
      description={
        (view ? view.note : `${m.target}` + (m.env_names.length ? ` · ${t('profiles.mcpAuthNames', { names: m.env_names.join(', ') })}` : '')) +
        (m.forced ? ` · ${t('profiles.mcp.forcedNote')}` : '')
      }
      control={
        <>
          {!narrow && primary}
          <Toggle
            on={m.enabled}
            label={t('profiles.mcpToggle', { name: m.name })}
            done={(on) => t(on ? 'profiles.mcpOn' : 'profiles.mcpOff', { name: m.name })}
            disabled={!d.can_edit && !mayManage(d)}
            change={async (on) => {
              const r = await act('mcp', { target: m.name, enabled: on });
              onChanged();
              return r;
            }}
            offConfirm={t('profiles.mcpOffConfirm', { name: m.name })}
          />
          {mayEdit && !narrow && (
            <IconButton
              aria-label={t('profiles.mcp.delete', { name: m.name })}
              disabled={busy}
              onClick={remove}
              sx={{ ml: 1, minWidth: 44, minHeight: 44 }}
            >
              <DeleteOutlineIcon fontSize="small" />
            </IconButton>
          )}
          {menuItems.length > 0 && (
            <>
              <IconButton
                aria-label={t('profiles.mcp.more', { name: m.name })}
                aria-haspopup="menu"
                disabled={busy}
                onClick={(e) => setMenu(e.currentTarget)}
                sx={{ minWidth: 44, minHeight: 44 }}
              >
                <MoreVertIcon fontSize="small" />
              </IconButton>
              <Menu anchorEl={menu} open={!!menu} onClose={() => setMenu(null)}>
                {menuItems.map((it) => (
                  <MenuItem key={it.key} onClick={it.run} sx={{ minHeight: 44 }}>
                    {it.label}
                  </MenuItem>
                ))}
              </Menu>
            </>
          )}
        </>
      }
      below={
        narrow && primary ? (
          <Box>
            <Box sx={{ mt: 1 }}>{primary}</Box>
            {result && <Box aria-live="polite">{result}</Box>}
          </Box>
        ) : result ? (
          <Box aria-live="polite">{result}</Box>
        ) : undefined
      }
    />
  );
}

function ToolsetRow({ ts, d, name }: { ts: ToolsetItem; d: ProfileDetailData; name: string }) {
  const { act } = useProfileAct(name);
  return (
    <ItemRow
      icon={BuildOutlinedIcon}
      name={ts.label}
      meta={ts.label !== ts.name ? ts.name : undefined}
      off={!ts.enabled}
      tags={
        <>
          {!ts.configured && <Tag tone="warn">{t('profiles.toolsetNeedsSetup')}</Tag>}
        </>
      }
      description={t('profiles.toolsetSecondary', { description: ts.description, count: ts.tools })}
      control={
        <Toggle
          on={ts.enabled}
          label={t('profiles.toolsetToggle', { label: ts.label })}
          done={(on) => t(on ? 'profiles.toolsetOn' : 'profiles.toolsetOff', { label: ts.label })}
          disabled={!d.can_edit && !mayManage(d)}
          change={(on) => act('toolset', { target: ts.name, enabled: on })}
          offConfirm={t('profiles.toolsetOffConfirm', { label: ts.label })}
        />
      }
    />
  );
}

// 찾기·켜짐 거르기(스펙 2026-10-23-007): 도구 묶음이 27개라 한 화면에 다 들지 않는다. 두 구역을 같은 조건으로 거른다
type OnFilter = 'all' | 'on' | 'off';
const passes = (enabled: boolean, f: OnFilter) => f === 'all' || enabled === (f === 'on');
const hasText = (needle: string, ...parts: (string | undefined)[]) => !needle || parts.join(' ').toLowerCase().includes(needle);

export function ToolsPane({ d }: { d: ProfileDetailData }) {
  const name = d.profile.name;
  const [q, setQ] = useState('');
  const [onFilter, setOnFilter] = useState<OnFilter>('all');
  const qc = useQueryClient();
  const { refresh } = useProfileAct(name);
  const { enqueueSnackbar } = useSnackbar();
  const [adding, setAdding] = useState(false);
  const [justAdded, setJustAdded] = useState('');
  const focusServer = useProfileSpot().get('server') ?? ''; // 도구 화면의 MCP 서버 서랍 링크(OMAI-1249 V17)
  const [changed, setChanged] = useState(false);
  const confirm = useConfirm();
  const { act: actTools } = useProfileAct(name);
  const apply = async () => {
    if (!(await confirm(t('profiles.mcp.applyConfirm')))) return;
    try {
      await actTools('mcp_apply');
      setChanged(false);
      // 게이트웨이가 다시 뜨는 동안 지금 작업공간은 「다시 시작하는 중」이다 — 곧 다시 읽어 띠를 띄운다(스펙 2026-10-23-006).
      // OKE 에서 NotReady 가 되기까지 약 7초 걸려 두 번 읽는다. 한 번 restarting 을 받으면 useMe 가 5초마다 이어 읽는다
      for (const ms of [4000, 12000]) window.setTimeout(() => void qc.invalidateQueries({ queryKey: ['me'] }), ms);
      enqueueSnackbar(t('profiles.mcp.applied'), { variant: 'success' });
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
    }
  };
  const mayEdit = d.can_edit || mayManage(d);
  const added = async (server: string, info?: { oauth: boolean; notes?: string[] }) => {
    setAdding(false);
    setJustAdded(server);
    setQ(''); // 거르기에 가려 방금 넣은 서버가 안 보이지 않게
    setOnFilter('all');
    // OAuth 서버는 게이트웨이가 다시 시작 없이 설정을 읽고 로그인하면 바로 붙는다(스펙 2026-10-16-010 14-2·14-5·14-16, 결정 D6).
    // 「다시 시작해야 씁니다」 안내는 그 밖의 서버에만 띄운다(토큰·stdio 서버는 다시 시작 없이 붙는지 확인하지 않았다)
    if (!info?.oauth) setChanged(true);
    enqueueSnackbar(t('profiles.mcp.added', { name: server }), { variant: 'success' });
    for (const note of info?.notes ?? []) enqueueSnackbar(note, { variant: 'warning' }); // 도구 묶음 끄기·사용 규칙 스킬 설치 실패(설치는 성공)
    await refresh();
  };
  const needle = q.trim().toLowerCase();
  const filtering = !!needle || onFilter !== 'all';
  const mcpHit = (d.mcp ?? []).filter((m) => passes(m.enabled, onFilter) && hasText(needle, m.name, m.target, m.transport));
  const toolsetHit = (d.toolsets ?? []).filter((x) => passes(x.enabled, onFilter) && hasText(needle, x.label, x.name, x.description));
  return (
    <Box>
      {/* 새 MCP 서버: 탭 바로 밑 줄 오른쪽 끝(2026-10-17-019). 스킬 탭의 「새 스킬」과 같은 자리·모양이다.
          권한이 없으면 숨기지 않고 이유와 함께 잠근다(2026-10-15-025 §11). 구역 제목 옆 + 아이콘과 빈 상태 글자 단추는 겹쳐서 뺐다 */}
      <Stack direction="row" spacing={1.5} useFlexGap alignItems="center" flexWrap="wrap" sx={{ mb: 1 }}>
        <TextField
          size="small"
          type="search"
          placeholder={t('profiles.toolsSearch')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          sx={{ width: { xs: 1, sm: 260 } }}
          slotProps={{ htmlInput: { 'aria-label': t('profiles.toolsSearchLabel'), 'data-view-search': '' } }}
        />
        <ToggleButtonGroup
          exclusive
          size="small"
          value={onFilter}
          aria-label={t('profiles.toolsFilterLabel')}
          onChange={(_, v: OnFilter | null) => v && setOnFilter(v)}
        >
          {(['all', 'on', 'off'] as OnFilter[]).map((k) => (
            <ToggleButton key={k} value={k} sx={{ px: 1.5, height: 40, fontSize: 13 }}>
              {t(`profiles.toolsFilter.${k}`)}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        <Tooltip title={mayEdit ? '' : t('profiles.mcp.addDisabled')}>
          <span style={{ marginLeft: 'auto' }}>
            <Button
              startIcon={<AddIcon />}
              size="small"
              variant="outlined"
              color="inherit"
              disabled={!mayEdit}
              data-guide="profiles.mcp-add"
              aria-description={mayEdit ? undefined : t('profiles.mcp.addDisabled')}
              onClick={() => setAdding(true)}
            >
              {t('profiles.mcp.new')}
            </Button>
          </span>
        </Tooltip>
      </Stack>
      <Section title={t('profiles.mcpSection')} count={filtering ? mcpHit.length : (d.mcp ?? []).length}>
        {d.mcp && d.mcp.length ? (
          <ItemList>
            {!mcpHit.length && <ItemEmpty>{t('profiles.mcpNoMatch')}</ItemEmpty>}
            {mcpHit.map((m) => (
              <McpRow
                key={m.name}
                m={m}
                d={d}
                name={name}
                auto={m.name === justAdded}
                focused={!!focusServer && m.name === focusServer}
                onRemoved={(info) => enqueueSnackbar(info, { variant: 'success' })}
                onChanged={() => setChanged(true)}
              />
            ))}
          </ItemList>
        ) : d.mcp ? (
          <Box>
            <Typography color="text.secondary">{t('profiles.mcp.empty')}</Typography>
            <Typography variant="caption" color="text.secondary" component="p">
              {t('profiles.mcp.emptyHelp')}
            </Typography>
          </Box>
        ) : (
          <PaneUnreadable d={d}>
            <Typography color="text.secondary">{t('profiles.mcpUnreadable')}</Typography>
          </PaneUnreadable>
        )}
        {changed && mayEdit && (
          <Alert
            severity="info"
            sx={{ ...calmAlertSx, mt: 1 }}
            action={
              <Button size="small" color="inherit" onClick={apply}>
                {t('profiles.mcp.applyButton')}
              </Button>
            }
          >
            {t('profiles.mcp.applyBanner')}
          </Alert>
        )}
        <Typography variant="caption" color="text.secondary" component="p">
          {t('profiles.mcpNote')}
        </Typography>
      </Section>
      <AddServerDialog open={adding} name={name} secure={!!d.secure} callbackUrl={d.mcp_oauth_callback} admin={!!d.can_edit} onClose={() => setAdding(false)} onAdded={added} onChanged={() => setChanged(true)} />
      <Section title={t('profiles.toolsetSection')} count={filtering ? toolsetHit.length : (d.toolsets ?? []).length}>
        {d.toolsets ? (
          <ItemList>
            {toolsetHit.length ? (
              toolsetHit.map((x) => <ToolsetRow key={x.name} ts={x} d={d} name={name} />)
            ) : (
              <ItemEmpty>{t('profiles.toolsetsNoMatch')}</ItemEmpty>
            )}
          </ItemList>
        ) : (
          <PaneUnreadable d={d}>
            <Typography color="text.secondary">{t('profiles.toolsetsUnreadable')}</Typography>
          </PaneUnreadable>
        )}
      </Section>
    </Box>
  );
}

// ---- 크론 ----
// 목록은 Hermes 의 작업 목록(GET /api/cron/jobs)을 그대로 읽는다. 탭 숫자도 같은 목록의 길이를 쓴다(스펙 2026-10-15-003 R2).
// 예전에는 호출 흐름 그림(/api/flows)의 시작점을 읽어, 지시문만 있는 작업이나 만든 직후의 작업이 빠졌다.
export interface CronJob {
  id: string;
  name: string;
  enabled?: boolean;
  state?: string;
  schedule_display?: string;
  deliver?: string;
  last_status?: string | null;
  skills?: string[] | null;
}

export function useCronJobs(profile: string) {
  return useQuery<{ jobs: CronJob[]; can_edit: boolean }>({
    queryKey: ['cron-jobs', profile],
    queryFn: () => get(`/api/cron/jobs?profile=${encodeURIComponent(profile)}`),
    staleTime: 15000,
  });
}

export function CronPane({ d }: { d: ProfileDetailData }) {
  const name = d.profile.name;
  const navigate = useNavigate();
  const { navigateDrawer } = useUi();
  const inDrawer = useInDrawer();
  const [adding, setAdding] = useState(false);
  const q = useCronJobs(name);
  // 「새 예약 작업」은 접고 펼치는 단추(스펙 2026-10-19-005 R9). 단추는 늘 하나, 오른쪽 위(2026-10-17-019 §4), 모양은 「새 MCP 서버」와 같은 테두리·+ 아이콘(§5), 입력 칸은 단추 아래 한 자리(V4), 만든 뒤 포커스는 단추로(G8)
  const regionId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const focusToggle = useRef(false);
  useEffect(() => {
    if (focusToggle.current && !adding) {
      focusToggle.current = false;
      toggleRef.current?.focus();
    }
  });
  if (!q.data)
    return q.error ? (
      <Alert severity="warning">{q.error.message}</Alert>
    ) : (
      <Typography color="text.secondary">{t('profiles.loading')}</Typography>
    );
  const jobs = q.data.jobs;
  const canCreate = q.data.can_edit;
  const toggle = canCreate && (
    <DisclosureButton
      ref={toggleRef}
      look="create"
      data-guide="profiles.cron-add"
      open={adding}
      onToggle={() => setAdding((v) => !v)}
      controls={regionId}
      label={t(adding ? 'profiles.cronNewClose' : 'profiles.cronNew')}
    />
  );
  // NewJobBody 가 cron-jobs 다시 읽기를 기다린 뒤 onDone 을 부른다(NewJob.tsx). 그래서 바로 접어도 목록이 한 번에 바뀐다(V3)
  const region = canCreate && adding && (
    <Box id={regionId}>
      <NewJobBody
        profiles={[name]}
        fixedProfile={name}
        onDone={() => {
          focusToggle.current = true;
          setAdding(false);
        }}
      />
    </Box>
  );
  return (
    <Stack spacing={1.5}>
      {/* 새 예약 작업: 작업이 있든 없든 탭 바로 밑 줄 오른쪽 끝, 「새 MCP 서버」와 같은 자리(2026-10-17-019 §4).
          빈 상태 줄 단추(2026-10-19-005 G2·R12)는 뺐다. 단추가 자리를 옮기지 않아 만든 뒤 포커스도 같은 단추로 돌아온다(G8) */}
      {toggle && <Stack direction="row" justifyContent="flex-end">{toggle}</Stack>}
      {region}
      {!jobs.length ? (
        <Typography color="text.secondary">{t('profiles.cronNone')}</Typography>
      ) : (
        <ItemList>
          {jobs.map((j) => {
            const sched = j.schedule_display ?? '';
            const words = describe(sched);
            const off = j.enabled === false || j.state === 'paused';
            return (
              <ItemRow
                key={j.id}
                icon={ScheduleOutlinedIcon}
                name={j.name || j.id}
                off={off}
                // 서랍 안이면 이 서랍에 작업을 연다(스펙 2026-10-26-003 D5 1단계). 크론 화면의 ?open= 은 「프로파일/작업」 꼴이다(§2-3 ①)
                onRow={() =>
                  inDrawer
                    ? void navigateDrawer({ kind: 'cronJob', profile: name, id: j.id, label: j.name || j.id })
                    : navigate(`/cron?${new URLSearchParams({ tab: 'jobs', profile: name, open: `${name}/${j.id}` })}`)
                }
                tags={
                  <>
                    {off ? <Tag>{t('profiles.off')}</Tag> : <Tag tone="good">{t('profiles.on')}</Tag>}
                    {j.last_status && !['ok', 'success', 'completed'].includes(j.last_status) && (
                      <Tag tone="bad">{serverTerm(j.last_status)}</Tag>
                    )}
                  </>
                }
                description={sched + (words ? ` (${words})` : '')}
                control={
                  j.skills && j.skills.length > 0 ? (
                    <Typography variant="caption" color="text.secondary">
                      {t('profiles.skillsList', { names: j.skills.join(', ') })}
                    </Typography>
                  ) : undefined
                }
              />
            );
          })}
        </ItemList>
      )}
    </Stack>
  );
}
