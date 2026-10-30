/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import AddIcon from '@mui/icons-material/Add';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import { Alert, Box, Button, IconButton, Link as MuiLink, Stack, Tooltip } from '@mui/material';
import { Link } from 'react-router-dom';

import { AgentChip } from '@/components/AgentChip';
import { GridColumn, LocalDataGrid, nameColumn, Pill, profileNameColumn, statusColumn } from '@/components/DataGrid';
import { OwnerChip } from '@/components/OwnerChip';
import { useUi } from '@/components/UiContext';
import { UserChips } from '@/components/UserChip';
import { t } from '@/i18n';
import { agentLabel } from '@/lib/agentLabel';
import { useNameOfEmail } from '@/lib/people';
import { briefSummary } from '@/lib/roomBrief';
import { meetingPath, Room, RoomForm, RoomRole, Seat, SeatForm, tftRooms } from '@/screens/office/forms';

/** 오피스 화면 자료 가운데 자리·TFT 방 탭이 쓰는 부분 */
export interface TablesData {
  seats: Seat[];
  rooms: Room[];
  /** name: 에이전트 이름(HermesAgent displayName, 2026-10-18-010). 없으면 id */
  pods: { id: string; owner: string; owner_name?: string; name?: string; primary?: string; profiles: { name: string; seated: boolean }[] }[];
  can_edit: boolean;
}

// 자리·TFT 방 탭은 공통 표(LocalDataGrid)로 그린다(OMAI-1127 단계 7, 사용자 결정). 예전에는 에이전트(POD)마다 작은 표가
// 하나씩 있었고 행 끝 「배치」·「수정」 단추로 서랍을 열었다. 이제 한 표에 에이전트 열을 두고, 행을 누르면 같은 서랍이 열린다.
interface SeatRow {
  pod: string;
  owner: string;
  owner_name?: string;
  name: string;
  seat?: Seat;
}

export function SeatsTab({ data }: { data: TablesData }) {
  const { openDrawer } = useUi();
  const nameOf = useNameOfEmail();
  if (!data.pods.length) return <Alert severity="info">{t('office.noPods')}</Alert>;
  const by = new Map(data.seats.map((s) => [s.pod + '/' + s.profile, s]));
  const rows: SeatRow[] = data.pods.flatMap((p) => p.profiles.map((x) => ({ pod: p.id, owner: p.owner, owner_name: p.owner_name, name: x.name, seat: by.get(p.id + '/' + x.name) })));
  const podName = new Map(data.pods.map((p) => [p.id, p.name ?? '']));
  // 열 순서: 소유자 → 에이전트 → 프로파일 → 오피스 이름 → 역할 · 팀 → 상태(스펙 common-data-grid.md)
  const columns: GridColumn<SeatRow>[] = [
    { id: 'owner', label: t('office.colOwner'), value: (r) => r.owner, width: 'minmax(160px, 1.5fr)', render: (r) => (r.owner ? <OwnerChip email={r.owner} name={r.owner_name} /> : null) },
    {
      id: 'pod',
      label: t('office.colPod'),
      value: (r) => podName.get(r.pod) || r.pod,
      width: 'minmax(120px, 1fr)',
      // 에이전트 이름을 보이고 id 는 풍선말로 둔다. 점 색은 id 기준이라 다른 화면과 같다
      render: (r) => <AgentChip name={podName.get(r.pod) || r.pod} colorKey={r.pod} title={r.pod} size="sm" />,
    },
    profileNameColumn<SeatRow>({ id: 'profile', label: t('office.colProfile'), value: (r) => r.name }),
    {
      id: 'alias',
      label: t('office.colOfficeName'),
      value: (r) => (r.seat ? r.seat.label || r.seat.alias : ''),
      width: 'minmax(120px, 1fr)',
      render: (r) => (r.seat ? <AgentChip name={r.seat.label || r.seat.alias} colorKey={r.seat.alias} title={r.seat.alias} size="sm" /> : null),
    },
    {
      id: 'role',
      label: t('office.colRoleTeam'),
      value: (r) => (r.seat ? [r.seat.role, r.seat.team].filter(Boolean).join(' · ') || t('office.notWritten') : ''),
      width: 'minmax(160px, 2fr)',
    },
    statusColumn<SeatRow>({
      id: 'state',
      label: t('office.colState'),
      value: (r) => (r.seat ? (r.seat.enabled ? t('office.seated') : t('office.seatOff')) : t('office.notSeated')),
      tone: (r) => (r.seat?.enabled ? 'good' : undefined),
    }),
  ];
  const open = (r: SeatRow) =>
    openDrawer({
      title: r.seat ? t('office.seatDrawerTitle', { alias: r.seat.label || r.seat.alias }) : t('office.seatDrawerNew', { name: r.name }),
      // 서랍은 표의 주인 칸이 보이지 않아 「주인 · 에이전트 이름」으로 적는다(스펙 2026-10-19-003)
      sub: t('office.seatDrawerSub', { pod: agentLabel({ id: r.pod, name: podName.get(r.pod), owner: r.owner, owner_name: r.owner_name }, nameOf), name: r.name }),
      body: <SeatForm pod={r.pod} profile={r.name} seat={r.seat ?? null} />,
    });
  return (
    <LocalDataGrid<SeatRow>
      storageKey="office.seats"
      label={t('office.tabSeats')}
      columns={columns}
      rows={rows}
      rowId={(r) => `${r.pod}/${r.name}`}
      onRow={data.can_edit ? open : undefined}
      search={(r) => [r.name, r.pod, podName.get(r.pod), r.owner, r.seat?.alias, r.seat?.label, r.seat?.role, r.seat?.team].filter(Boolean).join(' ')}
    />
  );
}

/** 방 이름 옆의 「회의 열기」 뱃지. Pill 과 같은 모양(높이 20, 11px, radius 9999)의 링크다 */
function MeetingBadge({ to }: { to: string }) {
  return (
    <MuiLink
      component={Link}
      to={to}
      underline="none"
      title={t('office.openMeetingTip')}
      // 행 누르기(관리자의 편집 서랍)로 번지지 않게 한다
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      sx={{
        flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', height: 20, px: 1, borderRadius: 9999, fontSize: 11,
        fontWeight: 500, whiteSpace: 'nowrap', color: 'primary.main', border: '1px solid', borderColor: 'primary.main',
        '&:hover': { bgcolor: 'action.hover' },
        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 },
      }}
    >
      {t('office.openMeeting')}
    </MuiLink>
  );
}

/** 이 방을 고칠 수 있는 역할. 관리자는 admin, 아니면 서버가 준 내 역할(담당·구성원, 2026-10-18-009). 없으면 고치지 못한다 */
export const roomRole = (data: TablesData, room: Room): RoomRole | null =>
  room.kind === 'team' ? null : data.can_edit ? 'admin' : (room.my_role ?? null); // 팀 방은 자리의 팀을 따라가 서버가 모두에게 거절한다

/** TFT 방 서랍(만들기·고치기)을 연다. TFT 방 표와 회의 화면의 「방 정보 고치기」·「새 TFT 방」이 같은 서랍을 쓴다(스펙 2026-10-18-007·2026-10-20-018) */
export function useRoomEditor(data: TablesData, onCreated?: (id: number) => void) {
  const { openDrawer } = useUi();
  return (room: Room | null) =>
    openDrawer({
      title: room ? room.name : t('office.newRoom'),
      sub: t('office.roomDrawerSub'),
      body: (
        <RoomForm
          room={room}
          seats={data.seats}
          pods={data.pods}
          role={room ? (roomRole(data, room) ?? 'member') : 'admin'}
          onCreated={onCreated}
        />
      ),
    });
}

export function RoomsTab({ data }: { data: TablesData }) {
  const open = useRoomEditor(data);
  const podOf = new Map(data.seats.map((s) => [s.alias, s.pod]));
  const labelOf = new Map(data.seats.map((s) => [s.alias, s.label || s.alias]));
  const rooms = tftRooms(data.rooms);
  const roomName = nameColumn<Room>({ label: t('office.colRoom'), value: (r) => r.name });
  const columns: GridColumn<Room>[] = [
    {
      ...roomName,
      // 회의로 가는 길을 방 이름 옆 뱃지로 둔다. 끝난 방은 「회의」 탭이 고르지 못해(Meeting.tsx) 뱃지를 두지 않는다.
      render: (r) => (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
          <Box sx={{ minWidth: 0, flex: '0 1 auto' }}>{roomName.render?.(r)}</Box>
          {r.status !== 'closed' && <MeetingBadge to={meetingPath(r.id)} />}
        </Box>
      ),
    },
    { id: 'purpose', label: t('office.colPurpose'), value: (r) => briefSummary(r.purpose) || '—', width: 'minmax(160px, 2fr)' }, // 항목별 목적은 「목표」 첫 줄(2026-10-18-004)
    {
      id: 'seats',
      label: t('office.colAgents'),
      value: (r) => r.seats.map((a) => labelOf.get(a) ?? a).join(' '),
      width: 'minmax(160px, 2fr)',
      render: (r) => (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
          {r.seats.map((a) => (
            <AgentChip key={a} name={labelOf.get(a) ?? a} colorKey={a} title={a} size="sm" />
          ))}
        </Box>
      ),
    },
    { id: 'people', label: t('office.colPeople'), value: (r) => r.people.join(', '), width: 'minmax(120px, 1fr)', render: (r) => (r.people.length ? <UserChips names={r.people} /> : null) },
    ...(data.can_edit
      ? [
          {
            id: 'members',
            label: t('office.colMembers'),
            value: (r: Room) => r.members?.length ?? 0,
            width: '88px',
            num: true,
            render: (r: Room) => t('office.memberCount', { n: r.members?.length ?? 0 }),
          },
        ]
      : []),
    statusColumn<Room>({
      label: t('office.colState'),
      value: (r) => (r.status === 'closed' ? t('office.roomEnded') : t('office.roomOngoing')),
      tone: (r) => (r.status === 'closed' ? undefined : 'good'),
      extra: (r) => (new Set(r.seats.map((a) => podOf.get(a))).size > 1 ? <Pill>{t('office.multiPod')}</Pill> : null),
    }),
    // 행을 눌러도 열리지만 고칠 수 있다는 것이 보이지 않아 행 끝에 연필 단추를 둔다(스펙 2026-10-18-007)
    ...(data.can_edit || rooms.some((r) => roomRole(data, r))
      ? [
          {
            id: 'edit',
            label: '',
            value: () => '',
            width: '48px',
            render: (r: Room) =>
              roomRole(data, r) && (
              <Tooltip title={t('office.editRoom')}>
                <IconButton
                  size="small"
                  aria-label={t('office.editRoomOf', { name: r.name })}
                  onClick={(e) => {
                    e.stopPropagation();
                    open(r);
                  }}
                >
                  <EditOutlinedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            ),
          } as GridColumn<Room>,
        ]
      : []),
  ];
  return rooms.length ? (
    <LocalDataGrid<Room>
      storageKey="office.rooms"
      label={t('office.tabRooms')}
      columns={columns}
      rows={rooms}
      rowId={(r) => String(r.id)}
      onRow={data.can_edit || rooms.some((r) => roomRole(data, r)) ? (r) => roomRole(data, r) && open(r) : undefined}
      cellControls
      search={(r) => [r.name, r.purpose, ...r.seats, ...r.seats.map((a) => labelOf.get(a) ?? a), ...r.people].join(' ')}
      toolbarEnd={
        data.can_edit ? (
          <Button startIcon={<AddIcon />} variant="contained" size="small" onClick={() => open(null)}>
            {t('office.newRoom')}
          </Button>
        ) : undefined
      }
    />
  ) : (
    <Stack spacing={1.5}>
      {data.can_edit && (
        <Box>
          <Button startIcon={<AddIcon />} variant="contained" size="small" onClick={() => open(null)}>
            {t('office.newRoom')}
          </Button>
        </Box>
      )}
      <Alert severity="info">{data.can_edit ? t('office.noRoomsAdmin') : t('office.noRoomsUser')}</Alert>
    </Stack>
  );
}
