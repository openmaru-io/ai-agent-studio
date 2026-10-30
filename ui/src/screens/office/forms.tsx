/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 오피스 자리·TFT 방 편집 서랍. 쓰는 곳은 AAS DB 의 기록뿐이고 Hermes 는 건드리지 않는다.
// 배치 해제·기록 지우기는 서랍 머리의 단추로 두고 대화 상자에서 확인한다(COP Drawer 처럼, OMAI-1135).
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import MeetingRoomOutlinedIcon from '@mui/icons-material/MeetingRoomOutlined';
import WorkOffOutlinedIcon from '@mui/icons-material/WorkOffOutlined';
import { Alert, Box, Button, Checkbox, FormControlLabel, Stack, Switch, TextField, Typography } from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useConfirm } from '@/components/ConfirmDialog';
import { DisclosureButton } from '@/components/DisclosureButton';
import { DrawerActions } from '@/components/DrawerActions';
import { compactSwitchSx } from '@/components/ItemRow';
import { PersonMultiPicker, PersonPicker } from '@/components/PersonPicker';
import { useUi } from '@/components/UiContext';
import { UserChip } from '@/components/UserChip';
import { t } from '@/i18n';
import { get, post } from '@/lib/api';
import { useMe } from '@/lib/data';
import { seatLabel } from '@/lib/format';
import { hiddenFilled } from '@/lib/hiddenFilled';
import { Person, usePeople } from '@/lib/people';
import { Brief, BRIEF_KEYS, BRIEF_REQUIRED, BRIEF_SHOWN, buildBrief, parseBrief } from '@/lib/roomBrief';

export interface Seat {
  alias: string;
  pod: string;
  profile: string;
  enabled: boolean;
  title: string;
  role: string;
  team: string;
  note: string;
  /** 화면에 보일 에이전트 이름(서버가 준다, 2026-10-18-010). 자동 별칭(설치본 id)이면 에이전트 이름, 관리자가 지은 별칭이면 별칭 */
  label?: string;
}
export interface Room {
  id: number;
  name: string;
  purpose: string;
  owner: string;
  seats: string[];
  people: string[];
  /** 구성원 이메일. 관리자에게만 온다. */
  members?: string[];
  /** 구성원 부서의 team_key. 관리자에게만 온다 — 「볼 부서」의 TFT 방을 찾는다(스펙 2026-10-22-002). */
  teams?: string[];
  status: 'open' | 'closed';
  /** 'team' 이면 팀마다 서버가 저절로 두는 팀 방(계획 2026-10-13-011). 없으면 TFT 방이다. 팀 방은 TFT 방 탭에 보이지 않는다. */
  kind?: 'tft' | 'team';
  /** 관리자가 아닌 사람에게: 이 방을 고칠 수 있는 내 역할(2026-10-18-009). 담당이면 members 가 이메일 대신 사람 열쇠로 온다 */
  my_role?: 'owner' | 'member';
  /** 담당에게만: 담당의 사람 열쇠(구성원 목록에서 뺄 수 없게 한다) */
  owner_key?: string;
}

/** 방 서랍을 여는 사람의 역할: 관리자는 전부, 담당은 담당 바꾸기·지우기 빼고, 구성원은 이름·목적만(2026-10-18-009) */
export type RoomRole = 'admin' | 'owner' | 'member';

/** 담당이 구성원을 고를 때 쓰는 사람 목록. 이메일 대신 서버가 만든 열쇠를 email 자리에 둔다(이메일은 관리자만, 계획 007 R6) */
function useOfficePeople(enabled: boolean): Person[] {
  const q = useQuery<{ people?: { key: string; name: string }[] }>({ queryKey: ['office-people'], queryFn: () => get('/api/office/people'), enabled, staleTime: 60000 });
  return useMemo(() => (q.data?.people ?? []).map((p) => ({ email: p.key, name: p.name })), [q.data]);
}

/** TFT 방(사람이 만든 방)만. 팀 방은 「회의」 탭에서만 고른다. */
export const tftRooms = (rooms: Room[]): Room[] => rooms.filter((r) => r.kind !== 'team');

/** 그 방이 선택된 「회의」 탭 주소. 「회의」 탭은 열린 방만 고른다. */
export const meetingPath = (roomId: number): string => `/office?tab=meeting&room=${roomId}`;

function useSave(done: (body: Record<string, unknown>) => string, after?: (out: { id?: number }) => void) {
  const { enqueueSnackbar } = useSnackbar();
  const { closeDrawer } = useUi();
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const out = await post<{ id?: number }>('/api/office/action', body);
      enqueueSnackbar(done(body), { variant: 'success' });
      closeDrawer();
      await qc.invalidateQueries({ queryKey: ['office'] });
      after?.(out);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return { run, error, busy };
}

export function SeatForm({ pod, profile, seat }: { pod: string; profile: string; seat: Seat | null }) {
  const confirm = useConfirm();
  // 서버는 오피스 이름 default 를 거절한다. 사용자별 Hermes 는 프로파일이 default 하나라 설치본 이름을 기본값으로 쓴다.
  const [alias, setAlias] = useState(seat?.alias ?? (profile === 'default' ? pod : profile));
  const [title, setTitle] = useState(seat?.title ?? '');
  const [role, setRole] = useState(seat?.role ?? '');
  const [team, setTeam] = useState(seat?.team ?? '');
  const [note, setNote] = useState(seat?.note ?? '');
  const [enabled, setEnabled] = useState(seat?.enabled ?? true);
  const { run, error, busy } = useSave((b) => t('office.seatSaved', { alias: String(b.alias || '') }));
  const remove = useSave((b) => t('office.seatRemoved', { alias: seat?.label || String(b.alias || '') }));

  const field = (label: string, value: string, set: (v: string) => void, hint?: string) => (
    <TextField
      size="small"
      label={label}
      value={value}
      onChange={(e) => set(e.target.value)}
      helperText={hint}
      slotProps={{ htmlInput: { spellCheck: false, 'aria-label': label } }}
    />
  );

  const save = async () => {
    // 끄면 장면에서 에이전트가 빠지므로 확인한다
    if (seat?.enabled && !enabled && !(await confirm(t('office.seatDisableConfirm', { alias: seat.label || seat.alias })))) return;
    void run({ action: 'seat.set', pod, profile, alias: alias.trim(), title, role, team, note, enabled });
  };

  return (
    <Stack spacing={1.5}>
      {seat && (
        <DrawerActions
          actions={[
            {
              id: 'remove',
              label: t('office.seatRemove'),
              description: t('office.seatRemoveTip'),
              icon: WorkOffOutlinedIcon,
              danger: true,
              confirm: {
                message: t('office.seatRemoveConfirm', { alias: seat.label || seat.alias }),
                okLabel: t('office.seatRemove'),
                onConfirm: () => remove.run({ action: 'seat.delete', alias: seat.alias }),
              },
            },
          ]}
        />
      )}
      {field(
        t('office.seatAliasLabel'),
        alias,
        setAlias,
        t('office.seatAliasHint')
      )}
      {field(t('office.seatTitleLabel'), title, setTitle)}
      {field(t('office.seatRoleLabel'), role, setRole, t('office.seatRoleHint'))}
      {field(t('office.seatTeamLabel'), team, setTeam)}
      {field(t('office.seatNoteLabel'), note, setNote)}
      {/* 켜고 끄는 값이라 체크박스 대신 작은 스위치(DESIGN.md §4 Toggle Switch) */}
      <FormControlLabel
        label={t('office.seatEnabled')}
        sx={{ ml: 0, gap: 1 }}
        control={
          <Switch
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            sx={compactSwitchSx}
            slotProps={{ input: { role: 'switch' } }}
          />
        }
      />
      {(error || remove.error) && <Alert severity="error">{error || remove.error}</Alert>}
      <Box>
        <Button variant="contained" disabled={busy || remove.busy} onClick={() => void save()}>
          {t('office.save')}
        </Button>
      </Box>
      <Typography variant="caption" color="text.secondary">
        {t('office.formAasNote')}
      </Typography>
    </Stack>
  );
}

/** TFT 방 서랍이 자리 주인과 주 프로파일을 알기 위한 설치본 정보(GET /api/office 의 pods) */
export interface RoomPod {
  id: string;
  owner: string;
  primary?: string;
}

/** 구성원 한 명의 「주 프로파일 자리」: 그 사람 설치본의 주 프로파일 자리, 없으면 그 설치본의 자리가 하나뿐일 때 그 자리 */
export function primarySeats(email: string, seats: Seat[], pods: RoomPod[]): string[] {
  const mine = pods.filter((p) => p.owner.toLowerCase() === email.toLowerCase());
  return mine.flatMap((p) => {
    const on = seats.filter((s) => s.pod === p.id);
    const main = on.find((s) => s.profile === (p.primary || 'main'));
    return main ? [main.alias] : on.length === 1 ? [on[0].alias] : [];
  });
}

/** 「이 방의 에이전트」: 주인별로 묶어 보인다. 구성원의 에이전트를 위에, 나머지는 「다른 사람의 에이전트」로 접어 둔다(2026-10-18) */
function RoomSeatPicker({
  seats,
  pods,
  members,
  picked,
  onToggle,
  nameOf,
  canAdd,
}: {
  seats: Seat[];
  pods: RoomPod[];
  members: string[];
  picked: string[];
  onToggle: (alias: string, on: boolean) => void;
  nameOf: (email: string) => string;
  /** 주면 체크되지 않은 자리는 이 값이 참일 때만 체크할 수 있다(담당은 자기 에이전트만 새로 넣는다, 2026-10-18-009) */
  canAdd?: (alias: string) => boolean;
}) {
  const ownerOf = new Map(pods.map((p) => [p.id, p.owner.toLowerCase()]));
  const groups = new Map<string, Seat[]>();
  for (const s of seats) {
    const o = ownerOf.get(s.pod) ?? '';
    groups.set(o, [...(groups.get(o) ?? []), s]);
  }
  const inRoom = members.filter((m) => groups.has(m));
  const others = [...groups.keys()].filter((o) => !members.includes(o)).sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'ko'));
  // 다른 사람의 자리가 이미 체크돼 있으면 처음부터 펼친다(옛 방에서 숨은 체크가 없게)
  const [showOthers, setShowOthers] = useState(() => others.some((o) => (groups.get(o) ?? []).some((s) => picked.includes(s.alias))));
  const othersId = useId();
  const group = (owner: string) => (
    <Box key={owner || '-'} sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: 1, py: 0.25 }}>
      <Box sx={{ minWidth: 120 }}>{owner ? <UserChip name={nameOf(owner)} email={owner} /> : <Typography variant="body2" color="text.secondary">{t('office.roomSeatNoOwner')}</Typography>}</Box>
      {(groups.get(owner) ?? []).map((s) => (
        <FormControlLabel
          key={s.alias}
          title={seatLabel(s.alias, s.pod)}
          label={s.label || s.alias} // 자동 별칭(설치본 id)이면 에이전트 이름. 주인은 묶음 머리에 있다(스펙 2026-10-19-003)
          control={
            <Checkbox
              size="small"
              checked={picked.includes(s.alias)}
              disabled={!!canAdd && !picked.includes(s.alias) && !canAdd(s.alias)}
              onChange={(e) => onToggle(s.alias, e.target.checked)}
            />
          }
        />
      ))}
    </Box>
  );
  if (!seats.length)
    return (
      <Typography variant="body2" color="text.secondary">
        {t('office.roomSeatFirst')}
      </Typography>
    );
  return (
    <Box>
      {inRoom.length ? inRoom.map(group) : (
        <Typography variant="body2" color="text.secondary">
          {t('office.roomSeatNoMemberAgents')}
        </Typography>
      )}
      {others.length > 0 && (
        <>
          <DisclosureButton
            open={showOthers}
            onToggle={() => setShowOthers((v) => !v)}
            controls={othersId}
            sx={{ mt: 0.5 }}
            label={t(showOthers ? 'office.roomSeatOthersHide' : 'office.roomSeatOthers', { n: others.reduce((n, o) => n + (groups.get(o)?.length ?? 0), 0) })}
          />
          {showOthers && <Box id={othersId}>{others.map(group)}</Box>}
        </>
      )}
    </Box>
  );
}

/** onCreated: 새 방을 저장하면 서버가 준 방 id 로 부른다(회의 탭이 새 방을 고른다, 스펙 2026-10-20-018) */
export function RoomForm({
  room,
  seats,
  pods = [],
  role = 'admin',
  onCreated,
}: {
  room: Room | null;
  seats: Seat[];
  pods?: RoomPod[];
  role?: RoomRole;
  onCreated?: (id: number) => void;
}) {
  const confirm = useConfirm();
  const [name, setName] = useState(room?.name ?? '');
  // 목적은 항목별로 받아 Markdown 하나로 저장한다(스펙 2026-10-18-004). 옛 방의 자유 글은 「추가 설명」으로 읽힌다
  const [brief, setBrief] = useState<Brief>(() => parseBrief(room?.purpose ?? ''));
  const [more, setMore] = useState(() => BRIEF_KEYS.some((k) => !BRIEF_SHOWN.includes(k) && !!parseBrief(room?.purpose ?? '')[k]));
  const needGoal = !room && !brief.goal?.trim(); // 새 방만 목표를 필수로 한다. 옛 방은 목표 없이도 저장된다
  const moreId = useId();
  const briefField = (k: (typeof BRIEF_KEYS)[number]) => (
    <TextField
      key={k}
      size="small"
      multiline
      maxRows={8}
      required={!room && BRIEF_REQUIRED.includes(k)}
      label={t(`office.brief.${k}.q`)}
      placeholder={t(`office.brief.${k}.example`)}
      value={brief[k] ?? ''}
      onChange={(e) => setBrief((b) => ({ ...b, [k]: e.target.value }))}
      slotProps={{ inputLabel: { shrink: true } }}
    />
  );
  // 담당·구성원은 사용자 목록에서 고른다(2026-10-18). 「사람」 칸은 없앴다 — 서버가 구성원으로 만든다. 새 방은 만드는 사람이 담당·구성원
  const myEmail = (useMe().data?.user?.email ?? '').toLowerCase();
  const admin = role === 'admin';
  const adminPeople = usePeople(admin);
  const keyPeople = useOfficePeople(role === 'owner');
  const people = admin ? adminPeople : keyPeople;
  const [owner, setOwner] = useState(room ? (admin ? room.owner : room.owner_key ?? '') : myEmail);
  const [members, setMembers] = useState<string[]>(room ? room.members ?? [] : myEmail ? [myEmail] : []);
  const [picked, setPicked] = useState<string[]>(() => room?.seats ?? (myEmail ? primarySeats(myEmail, seats, pods) : []));
  // 담당 칸 값: 관리자는 이메일, 담당은 자기 열쇠(p_…). 구성원 목록에서 뺄 수 없게 고정한다
  const ownerEmail = admin ? (owner.includes('@') ? owner.trim().toLowerCase() : '') : owner;
  // 담당은 자기 에이전트만 새로 넣는다(서버 office_access.room_edit 와 같은 규칙). 내 설치본(pods)의 자리만 새로 체크할 수 있다
  const myPods = new Set(pods.map((p) => p.id));
  const canAdd = admin ? undefined : (alias: string) => myPods.has(seats.find((x) => x.alias === alias)?.pod ?? '');
  const nameOf = (email: string) => people.find((p) => p.email.toLowerCase() === email)?.name || email.split('@')[0];
  // 구성원을 넣으면 그 사람의 주 프로파일 자리를 체크하고, 빼면 그렇게 체크했던 자리만 뺀다. 손으로 체크한 자리는 두지 않는다
  const auto = useRef<Map<string, string[]>>(new Map(!room && myEmail ? [[myEmail, primarySeats(myEmail, seats, pods)]] : []));
  const changeMembers = (next: string[]) => {
    const added = next.filter((m) => !members.includes(m));
    const removed = members.filter((m) => !next.includes(m));
    setPicked((cur) => {
      let out = cur;
      for (const m of removed) {
        const drop = auto.current.get(m) ?? [];
        out = out.filter((a) => !drop.includes(a));
        auto.current.delete(m);
      }
      for (const m of added) {
        const add = primarySeats(m, seats, pods).filter((a) => !out.includes(a));
        if (add.length) auto.current.set(m, add);
        out = [...out, ...add];
      }
      return out;
    });
    setMembers(next);
  };
  // 내 정보가 서랍보다 늦게 오면 새 방의 처음 값을 그때 채운다(사람이 이미 고쳤으면 두지 않는다)
  useEffect(() => {
    if (room || !myEmail) return;
    setOwner((v) => v || myEmail);
    if (members.length) return;
    const add = primarySeats(myEmail, seats, pods);
    if (add.length) auto.current.set(myEmail, add);
    setMembers([myEmail]);
    setPicked((cur) => (cur.length ? cur : add));
    // 새 방을 연 처음 한 번만 채운다. seats·pods 가 바뀌어도 다시 하지 않는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, myEmail]);
  const [closed, setClosed] = useState(room?.status === 'closed');
  const { run, error, busy } = useSave(
    (b) => t('office.roomSaved', { name: String(b.name || '') }),
    (out) => {
      if (!room && out.id) onCreated?.(out.id);
    }
  );
  const remove = useSave(() => t('office.roomRecordDeleted', { name: room?.name ?? '' }));
  const navigate = useNavigate();
  const { dismissDrawer } = useUi();

  const save = async () => {
    // 방을 끝내면 회의에서 고를 수 없게 되므로 확인한다
    if (room && room.status !== 'closed' && closed && !(await confirm(t('office.roomCloseConfirm', { name: room.name })))) return;
    const base = { action: 'room.set', id: room?.id ?? 0, name, purpose: buildBrief(brief) };
    if (role === 'member') return void run(base); // 구성원은 이름·목적만(서버가 나머지를 지운다)
    const withOwner = ownerEmail && !members.includes(ownerEmail) ? [...members, ownerEmail] : members;
    void run({
      ...base,
      ...(admin ? { owner } : {}), // 담당 바꾸기는 관리자만
      status: closed ? 'closed' : 'open',
      seats: picked,
      members: withOwner,
    });
  };

  return (
    <Stack spacing={1.5}>
      {room && (
        <DrawerActions
          actions={[
            // 끝난 방은 「회의」 탭이 고르지 못해 단추를 두지 않는다. 바뀌는 것이 없는 이동이라 확인을 거치지 않는다.
            ...(room.status !== 'closed'
              ? [
                  {
                    id: 'meeting',
                    label: t('office.openMeeting'),
                    description: t('office.openMeetingTip'),
                    icon: MeetingRoomOutlinedIcon,
                    onClick: () => {
                      dismissDrawer();
                      navigate(meetingPath(room.id));
                    },
                  },
                ]
              : []),
            ...(admin ? [{
              id: 'delete',
              label: t('office.roomDelete'),
              description: t('office.roomDeleteTip'),
              icon: DeleteOutlineIcon,
              danger: true,
              confirm: {
                message: t('office.roomDeleteConfirm', { name: room.name }),
                okLabel: t('office.roomDelete'),
                onConfirm: () => remove.run({ action: 'room.delete', id: room.id }),
              },
            }] : []),
          ]}
        />
      )}
      <TextField size="small" label={t('office.roomNameLabel')} value={name} onChange={(e) => setName(e.target.value)} />
      <Box component="fieldset" sx={{ border: 0, m: 0, p: 0, minWidth: 0 }}>
        <Typography component="legend" variant="subtitle2" sx={{ mb: 1 }}>
          {t('office.roomPurposeLabel')}
        </Typography>
        <Stack spacing={1.25}>
          {BRIEF_SHOWN.map(briefField)}
          {/* 펼쳐지는 칸은 한 묶음(id)이라 단추의 aria-controls 가 가리킨다(스펙 2026-10-19-005 O3) */}
          {more && (
            <Stack id={moreId} spacing={1.25}>
              {BRIEF_KEYS.filter((k) => !BRIEF_SHOWN.includes(k)).map(briefField)}
            </Stack>
          )}
          <Stack direction="row" alignItems="center" spacing={1}>
            <DisclosureButton open={more} onToggle={() => setMore((v) => !v)} controls={moreId} label={t(more ? 'office.briefLess' : 'office.briefMore')} />
            {/* 접으면 적은 칸도 숨는다. 숨은 글 칸에 값이 있으면 개수를 보인다(G13·R13) */}
            {!more && hiddenFilled(BRIEF_KEYS, BRIEF_SHOWN, brief) > 0 && (
              <Typography variant="caption" color="text.secondary">
                {t('office.briefHiddenFilled', { count: hiddenFilled(BRIEF_KEYS, BRIEF_SHOWN, brief) })}
              </Typography>
            )}
          </Stack>
        </Stack>
      </Box>
      {role === 'member' ? (
        <Typography variant="caption" color="text.secondary" component="p">
          {t('office.roomEditMemberNote')}
        </Typography>
      ) : (
      <>
      <PersonMultiPicker
        label={t('office.roomMembersLabel')}
        value={members}
        onChange={changeMembers}
        people={people}
        fixed={ownerEmail ? [ownerEmail] : []}
        helperText={t('office.roomMembersHint')}
      />
      {/* 담당 후보는 구성원. 칸에는 이름을 보이고 값은 이메일이다(2026-10-20). 옛 방의 담당이 이메일이 아닌 글자면 그대로 보이고, 고르면 바뀐다. 담당 바꾸기는 관리자만 */}
      {!admin ? (
        <Typography variant="body2" data-room-owner="">
          {t('office.roomOwnerLabel')}: {room?.owner}
        </Typography>
      ) : (
      <PersonPicker
        label={t('office.roomOwnerLabel')}
        value={owner}
        onChange={setOwner}
        people={members.map((e) => people.find((p) => p.email.toLowerCase() === e) ?? { email: e, name: e.split('@')[0], username: e.split('@')[0] })}
        store="email"
        showName
      />
      )}
      <Box>
        <Typography variant="subtitle2">{t('office.roomAgents')}</Typography>
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 0.5 }}>
          {t('office.roomAgentsHint')}
        </Typography>
        <RoomSeatPicker
          seats={seats}
          pods={pods}
          members={members}
          picked={picked}
          nameOf={nameOf}
          onToggle={(alias, on) => setPicked((cur) => (on ? [...cur, alias] : cur.filter((v) => v !== alias)))}
          canAdd={canAdd}
        />
        {!admin && (
          <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.5 }}>
            {t('office.roomEditOwnerNote')}
          </Typography>
        )}
      </Box>
      {room && (
        <FormControlLabel
          label={t('office.roomClosed')}
          control={<Checkbox checked={closed} onChange={(e) => setClosed(e.target.checked)} />}
        />
      )}
      </>
      )}
      {(error || remove.error) && <Alert severity="error">{error || remove.error}</Alert>}
      <Box>
        <Button variant="contained" disabled={busy || remove.busy || needGoal} onClick={() => void save()}>
          {t('office.save')}
        </Button>
        {needGoal && (
          <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1.5 }}>
            {t('office.briefGoalNeeded')}
          </Typography>
        )}
      </Box>
    </Stack>
  );
}
