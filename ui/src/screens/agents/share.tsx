/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// AI 에이전트 작업공간 서랍의 「공유」 구역(스펙 2026-11-17-008 §3-4). 소유자가 팀원을 골라 「대화」·「편집」을 준다.
// 처음 공유할 때 확인 창(지난 대화·메모리·비밀값이 보인다는 안내, 공유 이전 대화는 기본으로 숨김), 구성원에게 보일 안내 한 줄.
// 관리자가 설치에서 공유를 끄면 구역을 그리지 않는다. 바꿀 수 없는 사람(편집 구성원·대화 구성원)에게는 목록만 보인다.
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import {
  Alert,
  Box,
  Button,
  IconButton,
  InputAdornment,
  NativeSelect,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { type ReactNode, useEffect, useState } from 'react';

import { Section } from '@/components/bits';
import { useConfirm } from '@/components/ConfirmDialog';
import { Pill } from '@/components/DataGrid';
import { MessengerLinkButton, useMessengerLinks } from '@/components/MessengerLink';
import { PersonPicker } from '@/components/PersonPicker';
import { tier1 } from '@/components/tierButton';
import { t } from '@/i18n';
import { get, post } from '@/lib/api';
import { avatarTile, hueOf } from '@/lib/chatTokens';
import type { Person } from '@/lib/people';

export type MemberRole = 'use' | 'edit';
interface MemberRow extends Person {
  role: MemberRole;
  by?: string;
  ts?: string;
}
export interface SharingData {
  pod: string;
  enabled: boolean;
  can_manage: boolean;
  owner: string;
  owner_name: string;
  my_role: string;
  members: MemberRow[];
  granted: Person[];
  note: string;
  since: string;
  hide_before: string;
  note_max: number;
  /** 팀 공지 대화방(§6-4): 실패한 예약 작업을 이 (프로파일, 메신저)의 홈 채널로도. 없으면 null */
  team_notice?: { profile: string; platform: string } | null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 이름 칸에 쓴 글자로 서버에서 사람을 찾는다(Keycloak → 로그인 기록). 두 글자부터, 0.25초 쉬었다가 */
function usePeopleSearch(q: string) {
  const [term, setTerm] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setTerm(q.trim()), 250);
    return () => clearTimeout(id);
  }, [q]);
  const r = useQuery<{ people: Person[] }>({
    queryKey: ['agent-members-search', term],
    queryFn: () => get(`/api/agents/members/search?q=${encodeURIComponent(term)}`),
    enabled: term.length >= 2 && !EMAIL.test(term),
    staleTime: 30_000,
  });
  return r.data?.people ?? [];
}

const roleLabel = (r: string) => t(r === 'edit' ? 'agents.share.roleEdit' : 'agents.share.roleUse');

export function SharePanel({ pod }: { pod: string }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { enqueueSnackbar } = useSnackbar();
  const q = useQuery<SharingData>({ queryKey: ['agent-members', pod], queryFn: () => get(`/api/agents/members?pod=${encodeURIComponent(pod)}`) });
  const [who, setWho] = useState('');
  const [role, setRole] = useState<MemberRole>('use');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const found = usePeopleSearch(who);
  const d = q.data;
  // 설치에서 공유를 끄면 구역이 없다(§3-6). 공유 API 가 없는 옛 서버(members 가 없는 응답)에도 그리지 않는다
  if (!d || !d.enabled || !Array.isArray(d.members)) return null;
  const reload = () => qc.invalidateQueries({ queryKey: ['agent-members', pod] });
  const send = async (body: Record<string, unknown>, done?: string) => {
    setBusy(true);
    setError('');
    try {
      await post('/api/agents/members', { pod, ...body });
      await reload();
      if (done) enqueueSnackbar(done, { variant: 'success' });
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const email = (found.find((p) => p.name === who.trim())?.email ?? who).trim().toLowerCase();
  const add = async () => {
    if (!EMAIL.test(email)) {
      setError(t('agents.share.needEmail'));
      return;
    }
    let showOld = false;
    if (!d.since) {
      // 처음 공유: 무엇이 보이는지 알리고, 공유 이전 대화는 기본으로 숨긴다(체크하면 보인다)
      const ok = await confirm(t('agents.share.firstBody'), {
        title: t('agents.share.firstTitle'),
        confirmLabel: t('agents.share.firstOk'),
        check: { label: t('agents.share.showOld'), onChange: (v) => (showOld = v) },
      });
      if (!ok) return;
    }
    if (await send({ op: 'set', email, role, hide_before: !showOld }, t('agents.share.added', { name: who.trim() || email }))) setWho('');
  };
  const change = (m: MemberRow, r: MemberRole) => send({ op: 'set', email: m.email, role: r }, t('agents.share.changed', { name: m.name, role: roleLabel(r) }));
  const remove = async (m: MemberRow) => {
    if (!(await confirm(t('agents.share.removeBody', { name: m.name }), { title: t('agents.share.removeTitle'), danger: true, confirmLabel: t('agents.share.remove') })))
      return;
    await send({ op: 'set', email: m.email, role: 'none' }, t('agents.share.removed', { name: m.name }));
  };
  const empty = d.members.length === 0 && d.granted.length === 0;
  const noteDirty = note !== null && note !== d.note;
  const saveNote = async () => {
    if (await send({ op: 'note', note: note ?? '' }, t('agents.share.noteSaved'))) setNote(null);
  };
  return (
    <Section title={t('agents.share.title')}>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5, maxWidth: '72ch' }}>
        {t('agents.share.help')}
      </Typography>
      {!d.can_manage && !d.owner && (
        <Alert severity="info" sx={{ mb: 1.5 }}>
          {t('agents.share.adminOnly')}
        </Alert>
      )}
      {/* 사람 목록 한 판: 소유자 → 공유받은 사람 → 관리자가 준 사람, 맨 아래에 추가 줄(소유자·관리자만) */}
      <Box sx={(th) => ({ border: `1px solid ${th.palette.divider}`, borderRadius: '8px', overflow: 'hidden', mb: 1.5 })}>
        <Box component="ul" aria-label={t('agents.share.listLabel')} sx={{ listStyle: 'none', p: 0, m: 0 }}>
          {d.owner && (
            <PersonRow email={d.owner} name={d.owner_name || d.owner}>
              <Pill>{t('agents.share.ownerTag')}</Pill>
            </PersonRow>
          )}
          {d.members.map((m) => (
            <PersonRow key={m.email} email={m.email} name={m.name} department={m.department}>
              {d.can_manage ? (
                <>
                  <RoleToggle value={m.role} disabled={busy} label={t('agents.share.roleOf', { name: m.name })} onChange={(r) => void change(m, r)} />
                  <Tooltip title={t('agents.share.remove')}>
                    <IconButton size="small" aria-label={t('agents.share.removeOf', { name: m.name })} disabled={busy} onClick={() => void remove(m)}>
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </>
              ) : (
                <Pill>{roleLabel(m.role)}</Pill>
              )}
            </PersonRow>
          ))}
          {d.granted.map((g) => (
            <PersonRow key={`g:${g.email}`} email={g.email} name={g.name} department={g.department}>
              <Pill>{t('agents.share.byAdmin')}</Pill>
            </PersonRow>
          ))}
          {empty && (
            <Box component="li" sx={(th) => ({ px: 1.5, py: 1.25, borderTop: d.owner ? `1px solid ${th.palette.divider}` : 0 })}>
              <Typography variant="body2" color="text.secondary">
                {t('agents.share.empty')}
              </Typography>
            </Box>
          )}
        </Box>
        {d.can_manage && (
          <Box
            sx={(th) => ({
              display: 'flex',
              flexDirection: { xs: 'column', sm: 'row' },
              alignItems: { sm: 'center' },
              gap: 1,
              px: 1.5,
              py: 1.25,
              borderTop: `1px solid ${th.palette.divider}`,
              bgcolor: th.palette.mode === 'dark' ? 'rgba(255,255,255,0.025)' : 'rgba(17,24,39,0.02)',
            })}
          >
            <PersonPicker
              label={t('agents.share.person')}
              placeholder={t('agents.share.personHint')}
              value={who}
              onChange={setWho}
              people={found}
              store="email"
              showName
              sx={{ flex: 1, minWidth: 0 }}
            />
            <Stack direction="row" spacing={1} alignItems="center" sx={{ flexShrink: 0 }}>
              <RoleToggle value={role} label={t('agents.share.role')} onChange={setRole} />
              <Button variant="outlined" color="inherit" sx={[tier1 as object, { whiteSpace: 'nowrap' }]} disabled={busy || !who.trim()} onClick={() => void add()}>
                {t('agents.share.add')}
              </Button>
            </Stack>
          </Box>
        )}
      </Box>
      {error && (
        <Alert severity="error" sx={{ mb: 1.5 }}>
          {error}
        </Alert>
      )}
      {d.can_manage ? (
        <TextField
          size="small"
          fullWidth
          label={t('agents.share.note')}
          placeholder={t('agents.share.noteHint')}
          value={note ?? d.note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && noteDirty && !busy) void saveNote();
          }}
          slotProps={{
            htmlInput: { maxLength: d.note_max },
            // 고친 글이 있을 때만 칸 안에 저장 단추가 나온다
            input: {
              endAdornment: noteDirty ? (
                <InputAdornment position="end">
                  <Button size="small" variant="outlined" color="inherit" sx={[tier1 as object, { whiteSpace: 'nowrap' }]} disabled={busy} onClick={() => void saveNote()}>
                    {t('agents.share.noteSave')}
                  </Button>
                </InputAdornment>
              ) : undefined,
            },
          }}
        />
      ) : (
        d.note && (
          <Typography variant="body2" sx={{ mt: 1 }}>
            {t('agents.share.noteFrom', { name: d.owner_name || '', note: d.note })}
          </Typography>
        )
      )}
      <Stack direction="row" useFlexGap flexWrap="wrap" spacing={1.5} alignItems="flex-start" sx={{ mt: 1.5 }}>
        <MessengerLinkButton pod={pod} />
        {d.can_manage && <TeamNotice pod={pod} value={d.team_notice ?? null} />}
      </Stack>
      <Stack direction="row" spacing={0.75} alignItems="flex-start" sx={{ mt: 1.5, color: 'text.secondary' }}>
        <LockOutlinedIcon sx={{ fontSize: 14, mt: '2px', flexShrink: 0 }} aria-hidden="true" />
        <Typography variant="caption" component="p" sx={{ maxWidth: '80ch' }}>
          {t('agents.share.trust')}
        </Typography>
      </Stack>
    </Section>
  );
}

/** 사람 한 줄: 원형 머리글자(사람 칩과 같은 색) + 이름·부서 + 오른쪽 조작 */
function PersonRow({ email, name, department, children }: { email: string; name: string; department?: string; children: ReactNode }) {
  const mode = useTheme().palette.mode;
  const tile = avatarTile(hueOf(email || name), mode);
  return (
    <Box
      component="li"
      sx={(th) => ({ display: 'flex', alignItems: 'center', gap: 1.25, px: 1.5, py: 1, minWidth: 0, '& + li': { borderTop: `1px solid ${th.palette.divider}` } })}
    >
      <Box
        aria-hidden="true"
        sx={{ flex: '0 0 28px', width: 28, height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600, bgcolor: tile.bg, color: tile.fg }}
      >
        {(name || email).slice(0, 1).toUpperCase()}
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="body2" noWrap title={email} sx={{ fontWeight: 500 }}>
          {name}
        </Typography>
        {department && (
          <Typography variant="caption" color="text.secondary" noWrap component="div">
            {department}
          </Typography>
        )}
      </Box>
      <Stack direction="row" spacing={0.5} alignItems="center" sx={{ flexShrink: 0 }}>
        {children}
      </Stack>
    </Box>
  );
}

/** 대화·편집 두 칸. 지금 권한이 한눈에 보이게 고르기 상자 대신 쓴다 */
function RoleToggle({ value, label, disabled, onChange }: { value: MemberRole; label: string; disabled?: boolean; onChange: (r: MemberRole) => void }) {
  return (
    <ToggleButtonGroup
      exclusive
      size="small"
      value={value}
      disabled={disabled}
      aria-label={label}
      // 눌린 칸을 다시 누르면 null 이 온다 — 무시한다(SkillsViewToggle 과 같다)
      onChange={(_e, v: MemberRole | null) => v && v !== value && onChange(v)}
      sx={{ '& .MuiToggleButton-root': { px: 1.25, py: '3px', whiteSpace: 'nowrap' } }}
    >
      <ToggleButton value="use">{t('agents.share.roleUse')}</ToggleButton>
      <ToggleButton value="edit">{t('agents.share.roleEdit')}</ToggleButton>
    </ToggleButtonGroup>
  );
}

/** 팀 공지 대화방 고르기(소유자, 스펙 2026-11-17-008 §6-4). 이 작업공간에 연결된 봇 중 하나, 또는 보내지 않음 */
function TeamNotice({ pod, value }: { pod: string; value: { profile: string; platform: string } | null }) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const links = useMessengerLinks(pod);
  const bots = links.data?.bots ?? [];
  if (!bots.length) return null;
  const cur = value ? `${value.profile}|${value.platform}` : '';
  return (
    <Box sx={{ flex: '1 1 280px', minWidth: 0 }}>
      <NativeSelect
        value={cur}
        inputProps={{ 'aria-label': t('messenger.team') }}
        onChange={async (e) => {
          const [profile, platform] = e.target.value ? e.target.value.split('|') : ['', ''];
          try {
            await post('/api/agents/members', { pod, op: 'team', profile, platform });
            await qc.invalidateQueries({ queryKey: ['agent-members', pod] });
            enqueueSnackbar(t('messenger.teamSaved'), { variant: 'success' });
          } catch (err) {
            enqueueSnackbar((err as Error).message, { variant: 'error' });
          }
        }}
        sx={{ fontSize: 14 }}
      >
        <option value="">{`${t('messenger.team')}: ${t('messenger.teamOff')}`}</option>
        {bots.map((b) => (
          <option key={`${b.profile}|${b.platform}`} value={`${b.profile}|${b.platform}`}>
            {`${t('messenger.team')}: ${b.platform} · ${b.profile}`}
          </option>
        ))}
      </NativeSelect>
      <Typography variant="caption" color="text.secondary" component="p">
        {t('messenger.teamHelp')}
      </Typography>
    </Box>
  );
}
