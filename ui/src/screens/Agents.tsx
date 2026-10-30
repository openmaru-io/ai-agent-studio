/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// Hermes: 내 Hermes 를 만들고 상태를 본다. 한도(기본 3개)를 넘으면 서버가 거절한다. 관리자는 모든 Hermes 와 사람별 한도를 본다.
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import PlayCircleOutlineIcon from '@mui/icons-material/PlayCircleOutline';
import StarRoundedIcon from '@mui/icons-material/StarRounded';
import SyncAltOutlinedIcon from '@mui/icons-material/SyncAltOutlined';
import { Alert, Box, Button, InputAdornment, LinearProgress, NativeSelect, Stack, TextField, Tooltip, Typography } from '@mui/material';
import { visuallyHidden } from '@mui/utils';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useState } from 'react';

import { AddAction, AddIconButton } from '@/components/AddIconButton';
import { AgentChips } from '@/components/AgentChip';
import { KV, ScreenLoading, Section } from '@/components/bits';
import { useConfirm } from '@/components/ConfirmDialog';
import { ageColumn, agentNameColumn, GridColumn, Pill, statusColumn } from '@/components/DataGrid';
import { DrawerAction, DrawerActions } from '@/components/DrawerActions';
import { type PageOf } from '@/components/drawerPages';
import { useDrawerHead } from '@/components/drawerScope';
import { ListView } from '@/components/ListView';
import { OwnerChip } from '@/components/OwnerChip';
import { PersonPicker } from '@/components/PersonPicker';
import { tier1, tier3 } from '@/components/tierButton';
import { useUi } from '@/components/UiContext';
import { useRoutePage } from '@/components/useRoutePage';
import { t } from '@/i18n';
import { agentLabel, agentLabels } from '@/lib/agentLabel';
import { ApiError, get, post } from '@/lib/api';
import { chatStore } from '@/lib/chatStore';
import { useIsAdmin, useMe } from '@/lib/data';
import { fmtTs } from '@/lib/format';
import { usePeople } from '@/lib/people';
import type { SizeValues } from '@/lib/sizeUnits';
import { useFocusOnMount } from '@/lib/useFocusOnMount';
import { useTopic } from '@/lib/ws';

import { capacityAvailable, capacityCard, CapacityData, CapacityPanel, DefaultSizePanel, ownerSizeChanges, SizeDialog, SizeForm, sizeKv, sizeShort, useCapacity, useSizes } from './agents/capacity';
import { dismissedRollouts, dismissRollout, rolloutBanner, RolloutData, RolloutDetail, RolloutInfo, RolloutLive, RolloutStartForm, shortDigest, useRolloutActions, VersionCell, VersionFields } from './agents/rollout';

interface AgentRow extends VersionFields {
  name: string;
  owner: string;
  display_name: string;
  phase: string;
  message: string;
  ready: boolean;
  suspended: boolean;
  suspended_reason?: string;
  suspended_since?: string;
  created: string;
  /** 주 프로파일(main)을 아직 만드는 중(2026-10-19-001 디자인 D11) */
  primary_preparing?: boolean;
  /** 프로파일 이름(숨긴 루트 제외). 아직 읽지 못했거나 준비 전·읽기 실패면 null(스펙 2026-10-19-006) */
  profiles?: string[] | null;
  /** 채팅이 먼저 여는 프로파일. profiles 가 비면 빈 값 */
  chat_default?: string;
  /** 노드 자리가 없어 파드가 기다린다(오퍼레이터 status.waitReason, 스펙 2026-10-30-003 §4-2a) */
  wait_reason?: string;
  /** spec 의 크기 다섯 칸(§4-8). 정하지 않은 칸은 null */
  size?: SizeValues;
  /** 「설정과 다름」(관리자 응답에만, R13) */
  size_differs?: boolean;
  /** 대화 중(busy-until). 크기 저장 확인 창의 목록이 보인다(3A) */
  busy?: boolean;
}
interface AgentsData extends RolloutData {
  enabled: boolean;
  error?: string;
  limit: number;
  count: number;
  default_limit: number;
  can_create: boolean;
  admin: boolean;
  /** 「+」 만들기 칸에 미리 넣는 이름(「<내 이름>의 에이전트」, 겹치면 번호). 스펙 2026-10-21-019 */
  suggested_name?: string;
  limits?: Record<string, number>;
  collect?: {
    ts: string;
    seconds: number;
    pods: { ok: number; total: number; failed: { pod: string; reason: string }[] };
  } | null;
  agents: AgentRow[];
}

const PHASE_KEY: Record<string, string> = {
  Ready: 'agents.phaseReady',
  Pending: 'agents.phasePending',
  Provisioning: 'agents.phaseProvisioning',
  Failed: 'agents.phaseFailed',
  Suspended: 'agents.phaseSuspended',
  // 한 번 준비됐던 hermes 컨테이너가 준비되지 않은 상태(오퍼레이터가 씀, 스펙 agent-dashboard-self-kill-recovery §3-4)
  NotReady: 'agents.phaseNotReady',
};
const phaseText = (p: string) => (PHASE_KEY[p] ? t(PHASE_KEY[p]) : p);
const REASON_KEY: Record<string, string> = {
  idle: 'agents.reasonIdle',
  keycloak: 'agents.reasonKeycloak',
  admin: 'agents.reasonAdmin',
};
const reasonText = (r: string, fallback: string) => (REASON_KEY[r] ? t(REASON_KEY[r]) : fallback);
const phaseTone = (a: AgentRow) => (a.phase === 'Failed' ? 'bad' : a.ready ? 'good' : 'warn');
/** 아직 바뀌는 중인가. 실패와, 멈추라고 했고 멈춘 것은 끝난 상태다 — 멈춘 에이전트를 준비 중으로 쳐 따라 읽기가 끝나지 않았다(서버 ws._agent_preparing 과 같다) */
export const agentPreparing = (a: Pick<AgentRow, 'ready' | 'phase' | 'suspended'>) =>
  !a.ready && a.phase !== 'Failed' && !(a.phase === 'Suspended' && a.suspended);

function CreateForm({ d: initial }: { d: AgentsData }) {
  const { enqueueSnackbar } = useSnackbar();
  const { closeDrawer } = useUi();
  const qc = useQueryClient();
  // 서랍을 연 뒤에 목록이 바뀌어도(다른 곳에서 만들기·웹소켓) 한도 안내와 만들기 가능 여부가 따라가도록 화면의 조회를 함께 본다
  const d = useQuery<AgentsData>({ queryKey: ['hermes-agents'], queryFn: () => get<AgentsData>('/api/agents'), enabled: false }).data ?? initial;
  const [name, setName] = useState(initial.suggested_name ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // 자리 없음(D10): 사용자는 available 만 받는다. 모르면 안내하지 않고 만들기 버튼은 그대로 켜 둔다(§4-7 상태 표)
  const cap = useQuery<CapacityData>({ queryKey: ['agent-capacity'], queryFn: () => get<CapacityData>('/api/agents/capacity'), retry: false, staleTime: 15000 });

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await post('/api/agents', { display_name: name.trim() });
      enqueueSnackbar(t('agents.createStarted', { name: name.trim() }), { variant: 'success' });
      closeDrawer();
      await qc.invalidateQueries({ queryKey: ['hermes-agents'] });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Stack spacing={1.5}>
      <TextField
        size="small"
        label={t('agents.nameOptional')}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t('agents.namePlaceholder')}
        slotProps={{ htmlInput: { maxLength: 80, 'aria-label': t('agents.name') } }}
      />
      <Typography variant="caption" color="text.secondary">
        {t('agents.createNote', { limit: d.limit, count: d.count })}
      </Typography>
      {capacityAvailable(cap.data) === false && <Alert severity="warning">{t('sizes.noRoom')}</Alert>}
      {error && <Alert severity="error">{error}</Alert>}
      <Box>
        <Button startIcon={<AddIcon />} variant="contained" disabled={busy || !d.can_create} onClick={save}>
          {t('agents.create')}
        </Button>
      </Box>
    </Stack>
  );
}

function OwnerLimit({ x, d }: { x: AgentRow; d: AgentsData }) {
  const { enqueueSnackbar } = useSnackbar();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const current = d.limits?.[x.owner];
  const [value, setValue] = useState(String(current ?? d.default_limit));
  const people = usePeople(true); // 한도는 관리자만 고친다. 확인 글에 주인 이메일 대신 이름(2026-10-30)
  const owner = people.find((p) => p.email === x.owner)?.name || x.owner;
  const [error, setError] = useState('');

  const send = async (limit: number | null) => {
    // 한도 저장은 확인을 거친다(OMAI-1135: 확인 없던 영향 큰 동작)
    const msg = limit === null ? t('agents.limitResetConfirm', { owner, n: d.default_limit }) : t('agents.limitConfirm', { owner, n: limit });
    if (!(await confirm(msg))) return;
    setError('');
    try {
      await post('/api/agents/limit', { email: x.owner, limit });
      enqueueSnackbar(limit === null ? t('agents.limitReset', { owner, n: d.default_limit }) : t('agents.limitSaved', { owner, n: limit }), {
        variant: 'success',
      });
      await qc.invalidateQueries({ queryKey: ['hermes-agents'] });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={1} alignItems="center">
        <TextField
          size="small"
          type="number"
          label={t('agents.limitLabel')}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          slotProps={{
            input: { endAdornment: <InputAdornment position="end">{t('sizes.unit.cpu')}</InputAdornment> },
            htmlInput: { min: 0, max: 50, 'aria-label': t('agents.limit'), style: { fontVariantNumeric: 'tabular-nums' } },
            inputLabel: { shrink: true },
          }}
          sx={{ width: 140 }}
        />
        <Button variant="outlined" color="inherit" sx={tier1} onClick={() => send(Number(value))}>
          {t('agents.save')}
        </Button>
        {current !== undefined && (
          <Button size="small" onClick={() => send(null)}>
            {t('agents.resetToDefault', { n: d.default_limit })}
          </Button>
        )}
      </Stack>
      {error && <Alert severity="error">{error}</Alert>}
    </Stack>
  );
}

/** 재개는 확인 창 없이 바로 보낸다 — 행 「…」 메뉴와 서랍 단추가 같은 함수와 같은 조건을 쓴다(계획 2026-10-13-015 검토 D17) */
const canResume = (x: AgentRow) => x.suspended;
function useResume() {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  return async (x: AgentRow) => {
    try {
      await post('/api/agents/resume', { name: x.name });
      enqueueSnackbar(t('agents.resuming', { name: x.display_name || x.name }), { variant: 'success' });
      await qc.invalidateQueries({ queryKey: ['hermes-agents'] });
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
    }
  };
}

/** 에이전트 행 → 글자 함수의 입력. 이 화면은 설치본 id 를 name, 에이전트 이름을 display_name 으로 받는다 */
const rowRef = (x: AgentRow) => ({ id: x.name, name: x.display_name, owner: x.owner });

function DeleteForm({ x }: { x: AgentRow }) {
  const first = useFocusOnMount<HTMLInputElement>();
  const people = usePeople(useIsAdmin()); // 확인 글의 「주인 · 에이전트 이름」. 다시 입력할 값은 겹치지 않는 id 다(스펙 2026-10-19-003 D4)
  const { enqueueSnackbar } = useSnackbar();
  const { closeDrawer } = useUi();
  const qc = useQueryClient();
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const run = async () => {
    setError('');
    try {
      const r = await post<{ export?: string | null }>('/api/agents/delete', { name: x.name, confirm_name: typed });
      enqueueSnackbar(
        r.export
          ? t('agents.deletedWithExport', { agent: x.display_name || x.name, name: r.export })
          : t('agents.deletedNoExport', { agent: x.display_name || x.name }),
        { variant: 'success' }
      );
      closeDrawer();
      await qc.invalidateQueries({ queryKey: ['hermes-agents'] });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Stack spacing={1}>
      <Typography variant="caption" color="text.secondary">
        {t('agents.deleteNote', { name: x.name, agent: agentLabel(rowRef(x), (e) => people.find((p) => p.email === e)?.name) })}
      </Typography>
      <TextField
        size="small"
        label={t('agents.retypeName')}
        inputRef={first}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        slotProps={{ htmlInput: { spellCheck: false, 'aria-label': t('agents.retypeName') } }}
      />
      {error && <Alert severity="error">{error}</Alert>}
      <Box>
        <Button startIcon={<DeleteOutlineIcon />} color="error" variant="outlined" size="small" disabled={typed !== x.name} onClick={run}>
          {t('agents.delete')}
        </Button>
      </Box>
    </Stack>
  );
}

function OwnerForm({ x, onDone }: { x: AgentRow; onDone?: () => void }) {
  const { enqueueSnackbar } = useSnackbar();
  const first = useFocusOnMount<HTMLInputElement>();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [blocked, setBlocked] = useState('');
  const people = usePeople(true); // 소유자 이전은 관리자만 열 수 있다(GET /api/users 도 관리자 전용)
  const sizes = useSizes(true);
  const restarts = ownerSizeChanges(sizes.data, email, x.size);
  const run = async (force = false) => {
    setError('');
    setBlocked('');
    try {
      await post('/api/agents/owner', { name: x.name, owner_email: email.trim(), ...(force ? { force: true } : {}) });
      enqueueSnackbar(t('agents.ownerChanged', { name: x.display_name || x.name, owner: people.find((p) => p.email === email.trim())?.name || email.trim() }), { variant: 'success' });
      setEmail('');
      onDone?.();
      await qc.invalidateQueries({ queryKey: ['hermes-agents'] });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.data.blocked) setBlocked(e.message);
      else setError((e as Error).message);
    }
  };
  return (
    // pt: 대화 상자 본문 맨 위의 입력 칸은 떠 있는 라벨이 위로 잘린다(「수정」 대화 상자와 같은 값)
    <Stack spacing={1} sx={{ pt: 1 }}>
      <Stack direction="row" spacing={1} alignItems="center">
        <PersonPicker
          label={t('agents.newOwnerEmail')}
          inputRef={first}
          value={email}
          onChange={setEmail}
          people={people}
          store="email"
          sx={{ minWidth: 280 }}
        />
        <Button variant="outlined" size="small" disabled={!email.includes('@')} onClick={() => void run()}>
          {t('agents.move')}
        </Button>
      </Stack>
      {restarts && (
        <Typography variant="caption" color="text.secondary">
          {t('sizes.ownerRestart')}
        </Typography>
      )}
      {blocked && (
        <Alert severity="warning">
          {blocked}
          <Box sx={{ mt: 1 }}>
            <Button variant="outlined" color="inherit" size="small" sx={tier3} onClick={() => void run(true)}>
              {t('sizes.ownerForce')}
            </Button>
          </Box>
        </Alert>
      )}
      {error && <Alert severity="error">{error}</Alert>}
    </Stack>
  );
}

// 서랍 머리의 동작 단추(COP Drawer 처럼 닫기 앞, OMAI-1135). 예전에는 본문의 「멈춤」·「소유권 이전」·「지우기」 섹션이었다.
// 행 「…」 메뉴의 다시 시작은 확인 없이 그대로다(검토 D17) — 머리 단추는 다른 머리 단추처럼 확인을 거친다
/** 「수정」: 이름과 채팅 기본 프로파일(2026-10-19-001 R5·R3, 디자인 D10). 두 값은 서버가 함께 검사한 뒤 쓴다 */
function AgentEditForm({ x, onDone }: { x: AgentRow; onDone?: () => void }) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const first = useFocusOnMount<HTMLInputElement>();
  const [name, setName] = useState(x.display_name || '');
  const [pick, setPick] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const q = useQuery<{ profiles: string[]; chat_default: string; primary: string }>({
    queryKey: ['agent-profiles', x.name],
    queryFn: () => get(`/api/agents/profiles?name=${encodeURIComponent(x.name)}`),
    enabled: x.ready,
    retry: false,
  });
  const current = q.data?.chat_default ?? '';
  const chosen = pick || current;
  const trimmed = name.trim();
  const nameError = !trimmed ? t('agents.nameRequired') : trimmed.length > 80 ? t('agents.nameTooLong') : '';
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await post('/api/agents/update', {
        name: x.name,
        ...(trimmed !== (x.display_name || '') ? { display_name: trimmed } : {}),
        ...(q.data && chosen && chosen !== current ? { chat_default: chosen } : {}),
      });
      enqueueSnackbar(t('agents.editSaved'), { variant: 'success' });
      onDone?.();
      await qc.invalidateQueries({ predicate: (k) => ['hermes-agents', 'agent-profiles'].includes(String(k.queryKey[0])) });
      void chatStore.refresh(); // 채팅 묶음의 이름·채팅 기본을 다시 읽는다
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Stack spacing={2} sx={{ pt: 1, minWidth: { sm: 360 } }}>
      <TextField
        size="small"
        label={t('agents.name')}
        value={name}
        inputRef={first}
        onChange={(e) => setName(e.target.value)}
        error={!!nameError}
        helperText={nameError || ' '}
      />
      <Box>
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 0.5 }}>
          {t('agents.chatDefault')}
        </Typography>
        {!x.ready ? (
          <Typography variant="body2" color="text.secondary">
            {t('agents.chatDefaultNotReady')}
          </Typography>
        ) : q.isLoading ? (
          <LinearProgress aria-label={t('common.loading')} />
        ) : q.error ? (
          <Typography variant="body2" color="error">
            {(q.error as Error).message}
          </Typography>
        ) : (q.data?.profiles?.length ?? 0) <= 1 ? (
          // 고를 것이 하나뿐이면 선택 칸 대신 글자(디자인 D10 8A)
          <Typography variant="body2">{t('agents.chatDefaultOnly', { name: current || q.data?.primary || 'main' })}</Typography>
        ) : (
          <NativeSelect value={chosen} onChange={(e) => setPick(e.target.value)} inputProps={{ 'aria-label': t('agents.chatDefault') }}>
            {q.data!.profiles.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </NativeSelect>
        )}
      </Box>
      {error && <Alert severity="error">{error}</Alert>}
      <Box>
        <Button variant="contained" onClick={() => void save()} disabled={busy || !!nameError || (x.ready && q.isLoading)}>
          {t('agents.save')}
        </Button>
      </Box>
    </Stack>
  );
}

function AgentActions({ x, admin }: { x: AgentRow; admin: boolean }) {
  const resume = useResume();
  const actions: DrawerAction[] = [
    // 순서: 수정 → 다시 시작 → 소유권 이전 → 지우기. 「수정」만 글자 단추(디자인 D6)
    {
      id: 'edit',
      label: t('agents.edit'),
      description: t('agents.editTip'),
      icon: EditOutlinedIcon,
      text: true,
      dialog: { render: (close: () => void) => <AgentEditForm x={x} onDone={close} /> },
    },
    ...(canResume(x)
      ? [
          {
            id: 'resume',
            label: t('agents.resume'),
            description: t('agents.resumeTip'),
            icon: PlayCircleOutlineIcon,
            confirm: { message: t('agents.resumeConfirm', { name: x.display_name || x.name }), okLabel: t('agents.resume'), onConfirm: () => resume(x) },
          },
        ]
      : []),
    ...(admin
      ? [
          {
            id: 'owner',
            label: t('agents.transferOwnership'),
            description: t('agents.transferTip'),
            icon: SyncAltOutlinedIcon,
            dialog: { render: (close: () => void) => <OwnerForm x={x} onDone={close} /> },
          },
        ]
      : []),
    {
      id: 'delete',
      label: t('agents.delete'),
      description: t('agents.deleteTip'),
      icon: DeleteOutlineIcon,
      danger: true,
      dialog: { render: () => <DeleteForm x={x} /> }, // 지우면 서랍이 닫히며 대화 상자도 함께 사라진다
    },
  ];
  return <DrawerActions actions={actions} />;
}

/** 채팅 기본을 맨 앞에, 나머지는 이름 순 */
function orderedProfiles(x: AgentRow): string[] {
  const rest = (x.profiles ?? []).filter((n) => n !== x.chat_default).sort((a, b) => a.localeCompare(b));
  return x.chat_default && x.profiles?.includes(x.chat_default) ? [x.chat_default, ...rest] : rest;
}

/** 프로파일 칩 묶음(스펙 2026-10-19-006). max 가 있으면 표 칸(한 줄·「+N」), 없으면 서랍(전체·줄바꿈).
 *  채팅 기본 별은 2개 이상일 때만(DD6, 프로파일 화면 D12 와 같은 규칙), 무채색(DD7). 값이 없으면 흐린 「—」(DD4),
 *  준비된 줄인데 모르면 읽는 중·실패라는 설명을 붙인다(DD3) — 멈춤·main 준비 중은 상태 칸이 이유를 말한다 */
function ProfilesCell({ x, max }: { x: AgentRow; max?: number }) {
  const names = orderedProfiles(x);
  if (!names.length) {
    const unknown = x.profiles == null && x.ready && !x.primary_preparing;
    const dash = (
      <Box component="span" aria-hidden={unknown || undefined} sx={{ color: 'text.disabled' }}>
        —
      </Box>
    );
    return unknown ? (
      <Tooltip title={t('agents.profilesUnknown')}>
        <Box component="span">
          {dash}
          <Box component="span" sx={visuallyHidden}>
            {t('agents.profilesUnknown')}
          </Box>
        </Box>
      </Tooltip>
    ) : (
      dash
    );
  }
  const star =
    names.length >= 2 ? (
      <Box component="span" sx={{ display: 'inline-flex', flexShrink: 0 }}>
        <Box component="span" sx={visuallyHidden}>
          {`${t('agents.chatDefault')}:`}
        </Box>
        <StarRoundedIcon data-testid="chat-default-star" aria-hidden="true" sx={{ fontSize: 12, color: 'text.secondary' }} />
      </Box>
    ) : undefined;
  return (
    <AgentChips
      names={names}
      shape="square"
      nowrap={max != null}
      max={max ?? names.length}
      lead={star}
      moreLabel={(rest) => t('agents.profilesMore', { n: rest.length, names: rest.join(', ') })}
    />
  );
}

/** 지금(또는 마지막) 롤아웃이 이 에이전트를 바꾸기 전 Hermes 이미지 */
const prevOf = (d: AgentsData, name: string) => d.rollout?.agents.find((a) => a.name === name)?.previous ?? '';

/** AI 에이전트 작업공간 서랍 본문. 목록이 연 서랍과 서랍 안 페이지(AgentPage)가 함께 쓴다 */
function AgentDetail({ x, d }: { x: AgentRow; d: AgentsData }) {
  const sizes = useSizes(!!d.admin);
  const people = usePeople(!!d.admin);
  const nameOf = (e: string) => people.find((p) => p.email === e)?.name;
  const mine = d.agents.filter((a) => a.owner && a.owner === x.owner);
  return (
    <>
      <KV
        pairs={[
          // 이름은 에이전트 이름(없으면 ID), ID 는 따로. 예전에는 「이름」 행이 ID 였고 이름은 서랍 제목에만 있었다(2026-10-18)
          [t('agents.name'), x.display_name || x.name],
          [t('agents.id'), x.name],
          [t('agents.owner'), x.owner ? <OwnerChip key="o" email={x.owner} /> : ''],
          [t('agents.status'), phaseText(x.phase)],
          // 표의 「+N」에 숨은 프로파일을 키보드·터치로도 본다(스펙 2026-10-19-006 DD5)
          [t('agents.profiles'), <ProfilesCell key="p" x={x} />],
          [t('agents.createdAt'), x.created ? fmtTs(x.created) : ''],
          // 버전(DD14): 관리자 응답에만 있다(DD18). 이전 버전은 지금 롤아웃이 이 에이전트를 바꾸기 전 이미지
          ...(d.admin && x.image_digest
            ? ([
                [t('rollout.kv.version'), `${x.version ? `${x.version} · ` : ''}${shortDigest(x.image_digest)}`],
                ...(prevOf(d, x.name) ? [[t('rollout.kv.previous'), shortDigest(prevOf(d, x.name))]] : []),
                ...(x.sidecar_digest ? [[t('rollout.kv.sidecar'), shortDigest(x.sidecar_digest)]] : []),
              ] as [string, string][])
            : []),
          // 크기(스펙 2026-10-30-003 §4-7): spec 칸, 없으면 설치값. PVC 는 실제 요청을 함께
          ...(d.admin && sizes.data ? ([[t('sizes.kvLabel'), sizeKv(x.size, sizes.data.install, sizes.data.agents[x.name]?.pvc)]] as [string, string][]) : []),
          ...(x.message ? ([[t('agents.message'), x.message]] as [string, string][]) : []),
          ...(x.suspended
            ? ([
                [
                  t('agents.suspendedLabel'),
                  t('agents.suspendedNote', {
                    reason: x.suspended_reason ? reasonText(x.suspended_reason, x.suspended_reason) : t('agents.phaseSuspended'),
                    since: x.suspended_since ? ` · ${fmtTs(x.suspended_since)}` : '',
                  }),
                ],
              ] as [string, string][])
            : []),
        ]}
      />
      <AgentActions x={x} admin={!!d.admin} />
      {d.admin && (
        // 「이 사람의 설정」: 개수 한도와 크기 다섯 칸(1A). 주인을 지운 작업공간은 사람이 없어 크기를 두지 않는다
        <Section title={t('agents.ownerLimit')}>
          {/* 개수와 크기를 소제목으로 나누고 저장도 따로 한다(2026-10-30 디자인 다시 짬) */}
          <Typography variant="body2" component="h4" sx={{ fontWeight: 600, m: 0, mb: 1.5 }}>
            {t('agents.ownerCount')}
          </Typography>
          <OwnerLimit x={x} d={d} />
          {x.owner && (
            <Box sx={{ mt: 3 }}>
              <Typography variant="body2" component="h4" sx={{ fontWeight: 600, m: 0, mb: 1 }}>
                {t('agents.ownerSize')}
              </Typography>
              {sizes.data ? (
                <SizeForm
                  key={`${x.owner}:${JSON.stringify(sizes.data.people[x.owner] ?? null)}:${JSON.stringify(sizes.data.admin)}`}
                  scope={x.owner}
                  sizes={sizes.data}
                  owner={nameOf(x.owner) || x.owner}
                  targets={mine.map((a) => ({ name: a.name, label: agentLabel(rowRef(a), nameOf), busy: a.busy }))}
                />
              ) : sizes.error ? (
                <Alert severity="error">{(sizes.error as Error).message}</Alert>
              ) : (
                <LinearProgress aria-label={t('common.loading')} />
              )}
            </Box>
          )}
        </Section>
      )}

    </>
  );
}

/** 서랍 안에서 연 AI 에이전트 작업공간(프로파일 개요의 「들어 있는 에이전트」, 스펙 2026-10-26-003 2단계) */
export function AgentPage({ page }: { page: PageOf<'agent'> }) {
  const q = useQuery<AgentsData>({ queryKey: ['hermes-agents'], queryFn: () => get<AgentsData>('/api/agents') });
  const x = q.data?.agents?.find((a) => a.name === page.pod);
  useDrawerHead(x ? { title: x.display_name || x.name, sub: phaseText(x.phase) } : null);
  if (!q.data || !x) return q.data ? <Alert severity="warning">{t('agents.notFound', { id: page.pod })}</Alert> : <ScreenLoading title={page.pod} error={q.error?.message} />;
  return <AgentDetail x={x} d={q.data} />;
}

export function Agents() {
  const qc = useQueryClient();
  // 웹소켓이면 서버가 바뀐 목록을 보낸다(만들기·지우기는 곧바로, 준비 중이면 2초마다). 아니면 HTTP 로 따라간다
  const live = useTopic<AgentsData>('agents', (d) => qc.setQueryData(['hermes-agents'], d));
  const q = useQuery<AgentsData>({
    queryKey: ['hermes-agents'],
    queryFn: () => get<AgentsData>('/api/agents'),
    // 만드는 중인 것이 있으면 준비될 때까지 따라간다
    refetchInterval: (query) => (!live && query.state.data?.agents?.some(agentPreparing) ? 5000 : false),
  });
  const { openDrawer } = useUi();
  const myEmail = (useMe().data?.user?.email ?? '').toLowerCase();
  const resume = useResume();
  const people = usePeople(!!q.data?.admin); // 수집 실패 목록의 「주인 · 에이전트 이름」(스펙 2026-10-19-003)
  // 행 서랍은 주소 ?open=<pod id> 와 묶인다(스펙 2026-10-28-014 D8). 「들어 있는 에이전트」 링크(스펙 2026-10-19-011 A3)도 같은 길로 연다.
  // 값이 POD id 라 pod 는 함께 쓰지 않는다(D10)
  const { open, openRow, clearOnTab } = useRoutePage('agents', { pod: false });
  const [dismissed, setDismissed] = useState<string[]>(dismissedRollouts);
  const qcSize = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  // 「기존에도 적용」·행 「다시 적용」 확인 창(스펙 2026-10-30-003 3B). names 가 없으면 「설정과 다름」 모두
  const [ask, setAsk] = useState<{ names?: string[]; n: number } | null>(null);
  const cap = useCapacity(!!q.data?.admin && !!q.data?.enabled);
  // 띠와 확인 창이 같은 이름표(「주인 · 에이전트 이름」)를 쓴다
  const rolloutLabels = agentLabels((q.data?.agents ?? []).map(rowRef), (e) => people.find((p) => p.email === e)?.name);
  const rolloutActions = useRolloutActions(q.data?.rollout, (n) => rolloutLabels[n] ?? n);
  const d = q.data;
  if (!d) return <ScreenLoading title={t('views.agents.label')} error={q.error?.message} />;

  // 목록 없는 응답(쿠버네티스가 아닐 때)에서도 그린다 — 아래 「쿠버네티스 모드가 아닙니다」 안내보다 먼저 돈다
  const labelOf = agentLabels((d.agents ?? []).map(rowRef), (e) => people.find((p) => p.email === e)?.name);

  // 공통 표(OMAI-1127). 두 줄 목록의 둘째 줄(실패 이유·소유자)은 「메시지」·「소유자」 열로, 실패 행의 빨간 이름은 상태 칸으로 옮겼다(디자인 1B)
  const columns: GridColumn<AgentRow>[] = [
    (() => {
      const base = agentNameColumn<AgentRow>({ label: t('agents.name'), value: (x) => x.display_name || x.name });
      // 내가 주인인 에이전트는 이름 옆에 「내 에이전트」 뱃지(2026-10-17-016). 관리자는 여러 사람의 에이전트를 함께 본다
      return {
        ...base,
        // 뱃지 「내 AI 에이전트 작업공간」이 길어 기본 폭(200px)에서는 이름 칩이 「김··」까지 줄었다 — 이 화면만 넓힌다(스펙 2026-10-23-003 §10-4)
        width: 'minmax(270px, 2fr)',
        render: (x: AgentRow) => (
          <>
            {base.render?.(x)}
            {myEmail && x.owner?.toLowerCase() === myEmail && (
              <Pill tone="good">
                {t('agents.mineBadge')}
              </Pill>
            )}
          </>
        ),
      };
    })(),
    {
      ...statusColumn<AgentRow>({
        label: t('agents.status'),
        value: (x) => phaseText(x.phase),
        tone: phaseTone,
        extra: (x) =>
          x.suspended ? (
            <Pill tone="warn">
              {x.suspended_reason ? reasonText(x.suspended_reason, t('agents.phaseSuspended')) : t('agents.phaseSuspended')}
            </Pill>
          ) : x.wait_reason ? (
            // 노드 자리가 없어 기다린다(스펙 2026-10-30-003 2C, 무채색). 「문제」 탭에도 넣는다
            <Pill>{t('sizes.waitingPill')}</Pill>
          ) : x.updating ? (
            // 롤아웃이 새 버전으로 바꾸는 중 — 「문제」가 아니다(스펙 2026-10-28-015 DD7, 「main 준비 중」과 같은 무채색).
            // 크기 롤아웃이면 「크기 바꾸는 중」(스펙 2026-10-30-003 3A)
            <Pill>{d.rollout?.kind === 'resize' ? t('sizes.resizingPill') : t('rollout.updatingPill')}</Pill>
          ) : x.ready && x.primary_preparing ? (
            // 파드는 떴지만 main 을 만드는 중 — 채팅·스킬 허브의 「준비 중」과 같은 사실을 같게 보인다(무채색, 디자인 D11·D12)
            <Pill>{t('agents.primaryPreparing')}</Pill>
          ) : null,
      }),
      // 이름 칸을 넓힌 뒤 「사용할 수 있음」+「오래 쓰지 않아 멈춤」 줄이 접혔다 — 상태 칸이 줄지 않게 한다
      width: 'minmax(260px, auto)',
    },
    // 버전 칸(DD6): 상태 칸 바로 뒤라 가로 스크롤 전에 보인다(DD17). 관리자만(DD18)
    {
      id: 'version',
      label: t('rollout.version'),
      help: t('rollout.versionHelp'),
      hidden: !d.admin,
      value: (x) => x.version || shortDigest(x.image_digest) || undefined,
      width: 'minmax(190px, 1fr)',
      render: (x) => <VersionCell x={x} />,
    },
    { id: 'owner', label: t('agents.owner'), value: (x) => x.owner, width: 'minmax(140px, 1fr)', hidden: !d.admin, render: (x) => (x.owner ? <OwnerChip email={x.owner} /> : null) },
    // 프로파일 칸(스펙 2026-10-19-006): 소유자 뒤(DD1), 240px 이상(DD8). 정렬 값은 「개수 채팅 기본」이라 숫자 먼저 비교되고, 모르면 빈 값이라 늘 끝(DD11)
    {
      id: 'profiles',
      label: t('agents.profiles'),
      help: t('agents.profilesHelp'),
      value: (x) => (x.profiles?.length ? `${x.profiles.length} ${x.chat_default ?? ''}` : undefined),
      width: 'minmax(240px, 2fr)',
      render: (x) => <ProfilesCell x={x} max={3} />,
    },
    // 크기 칸(6A): 관리자만, 숨김 기본 열. 정한 칸만 보이고 없으면 「기본」
    ...(d.admin
      ? [
          {
            id: 'size',
            label: t('sizes.column'),
            help: t('sizes.columnHelp'),
            hidden: true,
            value: (x: AgentRow) => sizeShort(x.size),
            width: 'minmax(180px, 1fr)',
            render: (x: AgentRow) => (
              <Box component="span" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                {sizeShort(x.size)}
                {x.size_differs && <Pill tone="warn">{t('sizes.differs')}</Pill>}
              </Box>
            ),
          },
        ]
      : []),
    { id: 'message', label: t('agents.message'), value: (x) => x.message, width: 'minmax(120px, 2fr)' },
    ageColumn<AgentRow>({ id: 'created', label: t('agents.createdAt'), value: (x) => x.created }),
  ];

  if (!d.enabled) {
    return (
      <ListView<AgentRow>
        title={t('views.agents.label')}
        sub={t('agents.notK8s')}
        error={q.error?.message}
        tabs={[
          { id: 'all', label: t('agents.all'), items: [], empty: t('agents.k8sOnly') },
        ]}
        id="agents"
        columns={columns}
        rowId={(x) => x.name}
      />
    );
  }

  // 롤아웃이 일부러 다시 띄우는 에이전트는 「문제」가 아니다(DD7). 제한 시간을 넘겨 실패하면 롤아웃이 되돌리고 주석을 지워 다시 센다
  const problem = d.agents.filter((a) => a.phase === 'Failed' || !!a.wait_reason || (!a.ready && a.message && !a.updating));
  const outdated = d.agents.filter((a) => a.outdated);
  const r = d.rollout ?? null;
  const label = (n: string) => labelOf[n] ?? n;
  const startAgents = d.agents.map((a) => ({ name: a.name, label: label(a.name), suspended: a.suspended, pinned: a.pinned, image_digest: a.image_digest }));
  const openStart = (prefill?: Partial<RolloutInfo>) =>
    openDrawer({ title: t('rollout.start'), sub: t('rollout.form.sub'), body: <RolloutStartForm agents={startAgents} target={d.target} prefill={prefill} /> });
  const readError = !!d.admin && !!q.error;
  const banner = d.admin
    ? rolloutBanner(d, {
        now: Date.now(),
        dismissed,
        labelOf: label,
        readError,
        on: {
          pause: rolloutActions.pause,
          resume: () => void rolloutActions.resume(),
          rollback: () => void rolloutActions.rollback(),
          retry: () => openStart(r ?? undefined),
          abort: () => void rolloutActions.abort(),
          detail: () => r && openDrawer({ title: t('rollout.detailTitle', { version: r.version || r.name }), body: <RolloutDetail r={r} labelOf={label} /> }),
          openCanary: () => r?.canary[0] && openRow(r.canary[0]),
          close: () => {
            if (r) dismissRollout(r.name);
            setDismissed(dismissedRollouts());
          },
          start: () => openStart(),
          reload: () => void q.refetch(),
        },
      })
    : null;
  // 「새 버전 롤아웃」(DD3): 관리자만, 진행 중이거나 상태를 읽지 못했으면 끄고 이유를 tooltip 으로
  const startBlocked = readError ? t('rollout.startUnknown') : r?.blocking ? t('rollout.startBusy') : '';
  // 제목 오른쪽 [기본 크기][새 버전 롤아웃](스펙 2026-10-30-003 1D): 둘 다 관리자만. 기본 크기는 롤아웃 시작처럼 서랍으로 연다
  const openDefaults = () => openDrawer({ title: t('sizes.defaults'), sub: t('sizes.defaultsSub'), body: <DefaultSizePanel /> });
  const rolloutButton = d.admin ? (
    <Stack direction="row" spacing={1}>
      <Button variant="outlined" size="small" onClick={openDefaults} data-size-defaults="">
        {t('sizes.defaults')}
      </Button>
      <Tooltip title={startBlocked}>
        <span>
          <Button variant="outlined" size="small" disabled={!!startBlocked} onClick={() => openStart()} data-rollout-start="">
            {t('rollout.start')}
          </Button>
        </span>
      </Tooltip>
    </Stack>
  ) : undefined;
  // 「설정과 다름」(3B·R11): 0 이면 숨기되 크기 롤아웃이 진행·멈춤 중이면 남긴다. 롤아웃이 진행 중이면 적용 버튼을 끄고 이유를 보인다(1C)
  const differs = d.agents.filter((a) => a.size_differs);
  const resizeActive = !!r && r.kind === 'resize' && r.blocking;
  // 두 번째 관리자는 보기만(7A): 이유에 시작한 사람을 적는다
  const startedBy = r?.blocking && r.created_by ? t('sizes.startedBy', { who: people.find((p) => p.email === r.created_by)?.name || r.created_by }) : '';
  const applyBlocked = readError ? t('rollout.startUnknown') : r?.blocking ? [t('sizes.applyBusy'), startedBy].filter(Boolean).join(' · ') : '';
  const applyButton = (
    <Tooltip title={applyBlocked}>
      <span>
        <Button variant="outlined" color="inherit" size="small" sx={tier1} disabled={!!applyBlocked || !differs.length} onClick={() => setAsk({ n: differs.length })} data-size-apply="">
          {t('sizes.apply', { n: differs.length })}
        </Button>
      </span>
    </Tooltip>
  );
  const runApply = async () => {
    if (!ask) return;
    const out = await post<{ targets: string[] }>('/api/agents/size/apply', ask.names ? { names: ask.names } : {});
    enqueueSnackbar(t('sizes.applyStarted', { n: out.targets?.length ?? ask.n }), { variant: 'success' });
    await qcSize.invalidateQueries({ queryKey: ['hermes-agents'] });
  };

  const add: AddAction = {
    label: t('agents.createHermes'),
    disabled: !d.can_create,
    disabledReason: t('agents.limitReached', { limit: d.limit }),
    onClick: () => openDrawer({ title: t('agents.createHermes'), sub: t('agents.createSub'), body: <CreateForm d={d} /> }),
  };

  return (
    <>
    {d.admin && <RolloutLive r={r} />}
    <ListView<AgentRow>
      guide="agents.list"
      title={t('views.agents.label')}
      sub={t('agents.sub', { count: d.count, limit: d.limit })}
      error={[q.error?.message, d.error].filter(Boolean).join(' ') || null}
      banner={banner}
      headerAction={rolloutButton}
      titleAction={
        // 가이드가 강조하는 자리(OMAI-1274 user.my-agents)
        <Box component="span" data-guide="agents.create" sx={{ display: 'inline-flex' }}>
        <AddIconButton {...add} />
        </Box>
      }
      gridAction={add}
      // 보기 카드(2026-10-17-011)가 탭 줄을 대신한다. 「전체 Hermes」·「문제」 숫자는 보기 카드가 보이고, 관리자 구분은 보기 카드 라벨로 남긴다
      cards={[
        {
          n: `${d.count} / ${d.limit}`,
          label: t('agents.myHermes'),
          sub: d.can_create ? t('agents.canCreateMore') : t('agents.atLimit'),
        },
        ...(d.collect
          ? [
              {
                n: `${d.collect.pods.ok} / ${d.collect.pods.total}`,
                label: t('agents.lastCollectedPods'),
                sub: d.collect.pods.failed.length
                  ? t('agents.collectFailed', { pods: d.collect.pods.failed.map((f) => labelOf[f.pod] ?? f.pod).join(', ') })
                  : t('agents.collectOk', { seconds: d.collect.seconds, time: fmtTs(d.collect.ts) }),
                tone: d.collect.pods.failed.length ? ('bad' as const) : undefined,
              },
            ]
          : []),
        // 「더 만들 수 있는 작업공간」(1B·2A): 관리자만. 누르면 노드 표 서랍
        ...(d.admin ? [capacityCard(cap.data, !!cap.error, Date.now(), () => openDrawer({ title: t('sizes.node.title'), body: <CapacityPanel /> }))] : []),
      ]}
      tabs={[
        {
          id: 'all',
          label: d.admin ? t('agents.allHermes') : t('agents.visibleHermes'),
          items: d.agents,
          empty: t('agents.emptyAll'),
          card: {},
        },
        {
          id: 'problem',
          label: t('agents.hasProblem'),
          items: problem,
          empty: t('agents.emptyProblems'),
          tone: problem.length ? 'bad' : undefined,
          card: {},
        },
        // 「오래됨」 보기 카드(DD2): 관리자만. 롤아웃을 한 번도 하지 않았으면 알 수 없어 「—」
        ...(d.admin
          ? [
              {
                id: 'outdated',
                label: t('rollout.outdatedTab'),
                items: outdated,
                empty: t('rollout.outdatedEmpty'),
                count: d.ever || r ? outdated.length : null,
                card: { sub: d.target?.version ? t('rollout.outdatedSub', { version: d.target.version }) : undefined },
              },
            ]
          : []),
        ...(d.admin && (differs.length || resizeActive)
          ? [
              {
                id: 'size-differs',
                label: t('sizes.differsTab'),
                items: differs,
                empty: t('sizes.differsEmpty'),
                tone: differs.length ? ('warn' as const) : undefined,
                card: {},
                banner: { severity: 'warning' as const, message: t('sizes.applyNote', { n: differs.length }), action: applyButton },
              },
            ]
          : []),
      ]}
      text={(x) => `${x.display_name} ${x.name} ${x.owner} ${(x.profiles ?? []).join(' ')}`}
      id="agents"
      rowId={(x) => x.name}
      columns={columns}
      actions={[
        { id: 'resume', label: t('agents.resume'), onClick: resume, visible: canResume },
        // 행 「다시 적용」(3B): 설정과 다를 때만, 확인 창을 거친다
        { id: 'reapply', label: t('sizes.reapply'), onClick: (x: AgentRow) => setAsk({ names: [x.name], n: 1 }), visible: (x: AgentRow) => !!d.admin && !!x.size_differs, disabled: () => !!applyBlocked },
      ]}
      onRefresh={() => void q.refetch()}
      isFetching={q.isFetching}
      // 서랍 본문(AgentPage)이 목록과 같은 조회를 스스로 읽어 소유자 한도(d.limits 등)도 따라 바뀐다
      onRow={(x) => openRow(x.name)}
      openId={open}
      clearOnTab={clearOnTab}
      note={t('agents.note')}
    />
    <SizeDialog
      open={!!ask}
      title={t('sizes.applyTitle')}
      message={t('sizes.applyConfirm', { n: ask?.n ?? 0 })}
      okLabel={ask?.names ? t('sizes.reapply') : t('sizes.apply', { n: ask?.n ?? 0 })}
      onConfirm={runApply}
      onClose={() => setAsk(null)}
    />
    </>
  );
}
