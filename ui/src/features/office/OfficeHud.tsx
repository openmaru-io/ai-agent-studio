/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 장면 위 상태판·명단·카메라 단추(계획 007 P0, §3-3 G1·G4·G8). 장면 위에는 장면과 관련된 것만 둔다.
// 명단은 장면과 같은 정보를 가진 목록이라, 3D 를 쓸 수 없는 키보드·스크린리더 사용자도 같은 일을 할 수 있다.
// 「회의실」 탭(스펙 2026-10-20-021): 명단 옆에 회의 방 목록을 두고, 행은 카메라를 그 회의실로, 말풍선은 회의실 채팅 창을 연다.
import AddIcon from '@mui/icons-material/Add';
import CampaignOutlinedIcon from '@mui/icons-material/CampaignOutlined';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import HomeOutlinedIcon from '@mui/icons-material/HomeOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowLeftIcon from '@mui/icons-material/KeyboardArrowLeft';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import MyLocationIcon from '@mui/icons-material/MyLocation';
import QueueMusicOutlinedIcon from '@mui/icons-material/QueueMusicOutlined';
import RemoveIcon from '@mui/icons-material/Remove';
import RotateLeftIcon from '@mui/icons-material/RotateLeft';
import RotateRightIcon from '@mui/icons-material/RotateRight';
import ViewInArOutlinedIcon from '@mui/icons-material/ViewInArOutlined';
import VolumeOffOutlinedIcon from '@mui/icons-material/VolumeOffOutlined';
import VolumeUpOutlinedIcon from '@mui/icons-material/VolumeUpOutlined';
import { Avatar, Box, Button, ButtonBase, Collapse, IconButton, ListSubheader, Menu, MenuItem, Stack, Tab, Tabs, Tooltip, Typography } from '@mui/material';
import { KeyboardEvent, ReactElement, ReactNode, RefObject, useEffect, useId, useRef, useState } from 'react';

import { useThemeMode } from '@/components/ThemeMode';
import { moodLabel, TRACK_GROUPS, TrackLabel } from '@/features/office/audio/TrackPicker';
import { trackById } from '@/features/office/audio/tracks';
import { agentSeed, faceUrl } from '@/features/office/avatars/face';
import { countByStatus, filterAgents, HUD_ORDER, type HudRoom, orderAgents, sceneStatus, STATUS_LABEL } from '@/features/office/hud';
import { agentName, type ServerAgent } from '@/features/office/model';
import type { CameraNudge } from '@/features/office/scene3d/retro-office/core/cameraFocus';
import { HUD_PALETTE, HUD_STATUS_COLOR, prefersReducedMotion, SceneStatus } from '@/features/office/tokens';
import { t } from '@/i18n';
import { briefSummary } from '@/lib/roomBrief';

// DESIGN.md §1-1.2·§2·§2-1: 반투명 패널 + 반투명 보더, 선택 = wash + 2px 강조선(빨강 아님), 반경 8px.
// 색은 패널 루트의 CSS 변수(--hud-*)로 내려 하위 요소(HudBanner 포함)가 테마를 함께 따른다.
// 패널은 테마를 따른다: 다크는 #0f1011 계열, 라이트는 카드 표면 #f5f6f9 와 #111827 투명도 단계.
function hudVars(mode: 'dark' | 'light') {
  const c = HUD_PALETTE[mode];
  return {
    '--hud-surface': c.surface,
    '--hud-solid': c.solid,
    '--hud-line': c.line,
    '--hud-line-soft': c.lineSoft,
    '--hud-fg': c.fg,
    '--hud-fg2': c.fg2,
    '--hud-fg3': c.fg3,
    '--hud-fg4': c.fg4,
    '--hud-wash': c.wash,
    '--hud-wash-hover': c.washHover,
    '--hud-accent': c.accent,
    '--hud-warn': c.warn,
    '--hud-error': c.error,
  } as const;
}

const GLASS = {
  bgcolor: 'var(--hud-surface)',
  backdropFilter: 'blur(12px)',
  border: '1px solid var(--hud-line)',
  borderRadius: '8px',
  color: 'var(--hud-fg)',
  fontSize: 13,
} as const;

// 하단 단추는 한 줄 도구 막대 안에 둔다. 사각 단추 여러 개를 따로 띄우지 않고, 눌림은 탭 활성과 같은 wash + 아래 강조선이다(§1-1.3).
const BAR_BUTTON = {
  minHeight: 32,
  px: 1.25,
  gap: 0.75,
  borderRadius: '6px',
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--hud-fg2)',
  textTransform: 'none',
  whiteSpace: 'nowrap',
  '& .MuiButton-startIcon': { m: 0, '& > *:nth-of-type(1)': { fontSize: 16 } },
  '&:hover': { bgcolor: 'var(--hud-wash-hover)', color: 'var(--hud-fg)' },
  '&[aria-pressed="true"]': { bgcolor: 'var(--hud-wash)', color: 'var(--hud-fg)', boxShadow: 'inset 0 -2px 0 var(--hud-accent)' },
  '&.Mui-focusVisible': { boxShadow: '0 0 0 2px var(--hud-accent)' },
  '&.Mui-disabled': { color: 'var(--hud-fg4)' },
} as const;

// 단추 설명 풍선말. 단추 이름(aria-label·글자)은 그대로 두고 설명은 aria-describedby 로 붙인다(describeChild).
// 터치 화면에서는 누르는 즉시 보인다.
function HudTip({ title, children }: { title: string; children: ReactElement }) {
  return (
    <Tooltip title={title} placement="top" describeChild enterTouchDelay={0} leaveTouchDelay={4000}>
      {children}
    </Tooltip>
  );
}

// 배경음악 고르기(스펙 2026-10-21-014 §5-4): 배경음 단추 바로 옆 아이콘 단추가 분위기별 곡 메뉴를 위로 연다.
// 메뉴는 포털로 그려져 패널의 --hud-* 변수를 받지 못하므로 메뉴 표면에 다시 준다. 고르면 꺼져 있어도 켠다(D5).
function TrackMenu({ track, onPick, mode }: { track: string; onPick: (id: string) => void; mode: 'dark' | 'light' }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const menuId = useId();
  const current = trackById(track);
  return (
    <>
      <HudTip title={t('office.trackPickTip', { title: current.title })}>
        <IconButton
          size="small"
          aria-label={t('office.trackPick')}
          aria-haspopup="menu"
          aria-expanded={anchor ? 'true' : undefined}
          aria-controls={anchor ? menuId : undefined}
          onClick={(e) => setAnchor(e.currentTarget)}
          sx={{ ...BAR_BUTTON, minWidth: 32, width: 32, px: 0, '& svg': { fontSize: 18 } }}
        >
          <QueueMusicOutlinedIcon aria-hidden />
        </IconButton>
      </HudTip>
      <Menu
        id={menuId}
        anchorEl={anchor}
        open={!!anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{
          paper: {
            sx: { ...hudVars(mode), mb: 0.5, bgcolor: 'var(--hud-solid)', color: 'var(--hud-fg)', border: '1px solid var(--hud-line)', borderRadius: '8px', backgroundImage: 'none', minWidth: 240 },
          },
        }}
        MenuListProps={{ dense: true, sx: { py: 0.5 } }}
      >
        {TRACK_GROUPS.flatMap(({ mood, tracks }) => [
          <ListSubheader key={mood} sx={{ bgcolor: 'var(--hud-solid)', color: 'var(--hud-fg3)', fontSize: 11, fontWeight: 600, lineHeight: '28px' }}>
            {moodLabel(mood)}
          </ListSubheader>,
          ...tracks.map((x) => (
            <MenuItem
              key={x.id}
              role="menuitemradio"
              aria-checked={x.id === current.id}
              selected={x.id === current.id}
              onClick={() => {
                setAnchor(null);
                onPick(x.id);
              }}
              sx={{ gap: 1, pl: 1, '&:hover': { bgcolor: 'var(--hud-wash-hover)' }, '&.Mui-selected, &.Mui-selected:hover': { bgcolor: 'var(--hud-wash)' } }}
            >
              <Box component="span" aria-hidden sx={{ width: 16, color: 'var(--hud-accent)', fontSize: 13, textAlign: 'center' }}>
                {x.id === current.id ? '✓' : ''}
              </Box>
              <TrackLabel track={x} subColor="var(--hud-fg3)" />
            </MenuItem>
          )),
        ])}
      </Menu>
    </>
  );
}

const ACTION_ICON = {
  width: 28,
  height: 28,
  color: 'var(--hud-fg3)',
  '&:hover': { color: 'var(--hud-fg)', bgcolor: 'var(--hud-wash-hover)' },
  '&.Mui-focusVisible': { boxShadow: '0 0 0 2px var(--hud-accent)' },
} as const;

// 상태판 탭(스펙 2026-10-20-021 DR10): DESIGN.md Bordered Tabs — 고른 탭은 아래 2px 선만. wash 는 상태 칩의 눌림에 쓰므로 탭에는 쓰지 않는다.
// 터치 화면에서는 전역 테마가 MuiTab 높이를 44px 로 덮는다(G7, DR15 와 같은 뜻).
const HUD_TAB = {
  minHeight: 32,
  minWidth: 0,
  px: 1.25,
  py: 0,
  fontSize: 12,
  fontWeight: 500,
  textTransform: 'none',
  color: 'var(--hud-fg3)',
  '&:hover': { color: 'var(--hud-fg2)' },
  '&.Mui-selected': { color: 'var(--hud-fg)', fontWeight: 600 },
  '&.Mui-focusVisible': { boxShadow: 'inset 0 0 0 2px var(--hud-accent)' },
} as const;

/** 회의실 목록 행 높이·말풍선은 손가락 화면에서 키운다(DR15) */
const COARSE = '@media (pointer: coarse)';

// 카메라 조작(스펙 2026-10-21-006). 이동은 원 다이얼(가운데 = 처음 구도), 확대·회전은 그 옆 2×2. 터치 화면에서는 단추를 40px 로 키운다.
// 장면 오른쪽 끝(right 12)에 붙인다. 처음에는 앱 캐릭터(ChatMascot)를 비켜 캐릭터 폭만큼 띄웠는데, 오른쪽 끝에 붙여 달라는 요청으로 바꿨다(2026-10-21) — 캐릭터는 끌어 옮길 수 있다.
const CAM_BUTTON = {
  width: 28,
  height: 28,
  color: 'var(--hud-fg2)',
  '& svg': { fontSize: 18 },
  '&:hover': { color: 'var(--hud-fg)', bgcolor: 'var(--hud-wash-hover)' },
  '&.Mui-focusVisible': { boxShadow: '0 0 0 2px var(--hud-accent)' },
  '&.Mui-disabled': { color: 'var(--hud-fg4)' },
  [COARSE]: { width: 40, height: 40 },
} as const;
const DIAL = { size: 88, coarse: 124 } as const;

type CameraKind = CameraNudge | 'reset';
const DIAL_KEYS: { kind: CameraKind; label: string; icon: ReactNode; at: Record<string, unknown> }[] = [
  { kind: 'up', label: 'office.camUp', icon: <KeyboardArrowUpIcon />, at: { top: 2, left: '50%', transform: 'translateX(-50%)' } },
  { kind: 'down', label: 'office.camDown', icon: <KeyboardArrowDownIcon />, at: { bottom: 2, left: '50%', transform: 'translateX(-50%)' } },
  { kind: 'left', label: 'office.camLeft', icon: <KeyboardArrowLeftIcon />, at: { left: 2, top: '50%', transform: 'translateY(-50%)' } },
  { kind: 'right', label: 'office.camRight', icon: <KeyboardArrowRightIcon />, at: { right: 2, top: '50%', transform: 'translateY(-50%)' } },
  { kind: 'reset', label: 'office.camReset', icon: <HomeOutlinedIcon />, at: { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' } },
];
// 2×2: 왼쪽 열 확대·축소, 오른쪽 열 돌리기(행 순서로 놓는다)
const GRID_KEYS: { kind: CameraKind; label: string; icon: ReactNode }[] = [
  { kind: 'zoomIn', label: 'office.camZoomIn', icon: <AddIcon /> },
  { kind: 'rotateLeft', label: 'office.camRotateLeft', icon: <RotateLeftIcon /> },
  { kind: 'zoomOut', label: 'office.camZoomOut', icon: <RemoveIcon /> },
  { kind: 'rotateRight', label: 'office.camRotateRight', icon: <RotateRightIcon /> },
];

/** 오른쪽 아래의 카메라 조작. 따라가기 중에는 따라가기 카메라가 매 프레임 덮어쓰므로 모두 끈다. */
function CameraDial({ disabled, onCamera, shadow }: { disabled: boolean; onCamera: (kind: CameraKind) => void; shadow: string }) {
  const key = (k: { kind: CameraKind; label: string; icon: ReactNode }, sx: Record<string, unknown> = {}) => (
    <Tooltip key={k.kind} title={disabled ? '' : t(k.label)} placement="top">
      <IconButton
        size="small"
        aria-label={t(k.label)}
        data-camera={k.kind}
        disabled={disabled}
        onClick={() => onCamera(k.kind)}
        sx={{ ...CAM_BUTTON, ...sx }}
      >
        {k.icon}
      </IconButton>
    </Tooltip>
  );
  return (
    <Tooltip title={disabled ? t('office.camFollowing') : ''} placement="top">
      <Box
        role="group"
        aria-label={t('office.camGroup')}
        sx={{ ...GLASS, p: 0.75, display: 'flex', alignItems: 'center', gap: 1, boxShadow: shadow }}
      >
        <Box
          sx={{
            position: 'relative',
            width: DIAL.size,
            height: DIAL.size,
            borderRadius: '50%',
            border: '1px solid var(--hud-line)',
            bgcolor: 'var(--hud-wash)',
            flex: 'none',
            [COARSE]: { width: DIAL.coarse, height: DIAL.coarse },
          }}
        >
          {DIAL_KEYS.map((k) =>
            key(k, {
              position: 'absolute',
              ...k.at,
              ...(k.kind === 'reset' ? { bgcolor: 'var(--hud-surface)', border: '1px solid var(--hud-line)' } : {}),
            })
          )}
        </Box>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, auto)',
            gap: 0.25,
            pl: 1,
            borderLeft: '1px solid var(--hud-line-soft)',
          }}
        >
          {GRID_KEYS.map((k) => key(k, { borderRadius: '6px' }))}
        </Box>
      </Box>
    </Tooltip>
  );
}

/** 칩이나 목록에서 눌러 고른 상태 점 */
function Dot({ status, size = 8 }: { status: SceneStatus; size?: number }) {
  const { mode } = useThemeMode();
  const color = HUD_STATUS_COLOR[mode][status];
  return (
    <Box
      component="span"
      aria-hidden
      sx={{
        width: size,
        height: size,
        borderRadius: '50%',
        bgcolor: color,
        flex: 'none',
        // DESIGN.md §2 Amber Glow: 상태 점의 할로. 일하는 중·문제만 빛난다.
        boxShadow: status === 'working' || status === 'error' ? `0 0 4px ${color}66` : 'none',
      }}
    />
  );
}

/** 회의가 없거나 아직 모를 때의 점: 테두리 고리(꽉 찬 회색 점은 명단에서 「대기」 라 겹치지 않게, DR11) */
function RingDot() {
  return (
    <Box
      component="span"
      aria-hidden
      data-ring=""
      sx={{ width: 8, height: 8, borderRadius: '50%', border: '1.5px solid var(--hud-fg4)', boxSizing: 'border-box', flex: 'none' }}
    />
  );
}

/** 탭·머리줄의 개수 알약(명단 머리줄과 같다) */
function CountPill({ n }: { n: number }) {
  return (
    <Box
      component="span"
      aria-hidden
      sx={{
        px: 0.75,
        minWidth: 18,
        borderRadius: '999px',
        bgcolor: 'var(--hud-wash)',
        fontSize: 11,
        lineHeight: '18px',
        textAlign: 'center',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {n}
    </Box>
  );
}

/** 상태판 전용 「팀」·「TFT」 뱃지(DR12): 행 44px 안에 들도록 16px, 색은 상태판 변수 */
function HudBadge({ children }: { children: ReactNode }) {
  return (
    <Box
      component="span"
      sx={{
        flex: 'none',
        ml: '6px',
        height: 16,
        px: '6px',
        display: 'inline-flex',
        alignItems: 'center',
        borderRadius: '9999px',
        fontSize: 10,
        fontWeight: 500,
        lineHeight: 1,
        bgcolor: 'var(--hud-wash)',
        border: '1px solid var(--hud-line)',
        color: 'var(--hud-fg2)',
      }}
    >
      {children}
    </Box>
  );
}

/** 위·아래 방향키로 목록의 다음 항목에 초점만 옮긴다. 옮긴 항목(방향키가 아니면 null)을 돌려준다 — 명단과 회의실 목록이 함께 쓴다(R3) */
function moveFocus(e: KeyboardEvent<HTMLElement>, list: HTMLElement | null, selector: string): HTMLElement | null {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return null;
  const items = Array.from(list?.querySelectorAll<HTMLElement>(selector) ?? []);
  const i = items.indexOf(document.activeElement as HTMLElement);
  e.preventDefault();
  const next = items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
  next?.focus();
  return next ?? null;
}

/** 팀 방은 회의실 탭과 같은 「<팀> · 팀 회의」, TFT 방은 방 이름 — 접근 이름에 종류를 싣는다(R8) */
const roomLabel = (r: HudRoom) => (r.kind === 'team' ? t('office.teamMeetingOption', { name: r.name }) : r.name);

/** 행 둘째 줄(DR7): 늘 한 줄을 둬 행 높이가 같다. 첫 응답 전에는 비운다(DR6) */
function roomSecondLine(r: HudRoom, ready: boolean): string {
  if (!ready) return ' ';
  if (r.state === 'live') return r.agents ? t('office.hudRoomLive', { count: r.agents }) : t('office.hudRoomLiveOnly');
  if (r.state === 'moved') {
    const place = r.placeLabel ?? '';
    return r.agents ? t('office.hudRoomLiveMoved', { place, count: r.agents }) : t('office.hudRoomLiveAt', { place });
  }
  return briefSummary(r.purpose) || t('office.hudRoomAgents', { count: r.agents });
}

interface RoomListProps {
  rooms: HudRoom[];
  is3d: boolean;
  ready: boolean;
  warning: string | null;
  openRoomId: number | null;
  flashId: number | null;
  listRef: RefObject<HTMLUListElement | null>;
  onRow: (r: HudRoom) => void;
  onChat: (id: number) => void;
  onNewRoom?: () => void;
}

/** 회의실 목록: 경고 줄 → (빈 안내) → 관리자 「새 TFT 방」 → 행 */
function RoomList({ rooms, is3d, ready, warning, openRoomId, flashId, listRef, onRow, onChat, onNewRoom }: RoomListProps) {
  const onKey = (e: KeyboardEvent<HTMLUListElement>) => void moveFocus(e, listRef.current, '[data-room-item]');
  return (
    <Box sx={{ px: 0.5, pb: 0.5 }}>
      {warning && (
        <Box
          role="status"
          sx={{ display: 'flex', alignItems: 'center', gap: 0.75, px: 1, py: 0.5, fontSize: 12, color: 'var(--hud-warn)' }}
        >
          <Box component="span" aria-hidden sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: 'var(--hud-warn)', flex: 'none' }} />
          {warning}
        </Box>
      )}
      {rooms.length === 0 && (
        <Typography sx={{ px: 1, py: 1, fontSize: 12, color: 'var(--hud-fg3)' }}>{t('office.hudRoomsEmpty')}</Typography>
      )}
      {onNewRoom && (
        <HudTip title={t('office.newRoomTip')}>
          <Button
            size="small"
            startIcon={<AddIcon aria-hidden />}
            onClick={onNewRoom}
            sx={{ ...BAR_BUTTON, minHeight: 28, px: 1, justifyContent: 'flex-start', [COARSE]: { minHeight: 44 } }}
          >
            {t('office.newRoom')}
          </Button>
        </HudTip>
      )}
      <Box
        component="ul"
        ref={listRef}
        role="list"
        aria-label={t('office.hudTabRooms')}
        onKeyDown={onKey}
        sx={{ listStyle: 'none', m: 0, p: 0, maxHeight: is3d ? 340 : 'min(340px, 40vh)', overflowX: 'hidden', overflowY: 'auto' }}
      >
        {rooms.map((r) => {
          const label = roomLabel(r);
          const focusable = is3d && r.place;
          const open = openRoomId === r.id;
          const chatName = t('office.openRoomChatFor', { name: label });
          const rowName =
            (focusable ? t('office.showRoomFor', { name: label }) : chatName) +
            (!is3d && open ? t('office.hudRoomChatOpenSuffix') : '');
          const active = ready && r.state !== 'idle';
          return (
            <Box
              component="li"
              key={r.id}
              sx={{
                display: 'flex',
                alignItems: 'center',
                '& .hud-actions': { opacity: 0.7, transition: 'opacity 120ms' },
                '&:hover .hud-actions, &:focus-within .hud-actions': { opacity: 1 },
              }}
            >
              <ButtonBase
                data-room-item
                data-room-id={r.id}
                aria-label={rowName}
                title={is3d && !r.place ? t('office.hudRoomNoPlace') : undefined}
                onClick={() => onRow(r)}
                sx={{
                  flex: 1,
                  minWidth: 0,
                  justifyContent: 'flex-start',
                  gap: 1.25,
                  pl: 1,
                  pr: 0.5,
                  py: 0.75,
                  minHeight: 44,
                  borderRadius: '6px',
                  textAlign: 'left',
                  color: 'var(--hud-fg)',
                  // 선택 표시는 두지 않는다(R7). 카메라를 옮긴 행만 1.2초 wash(DR9)
                  bgcolor: flashId === r.id ? 'var(--hud-wash)' : 'transparent',
                  transition: 'background-color 200ms',
                  '&:hover': { bgcolor: 'var(--hud-wash-hover)' },
                  '&.Mui-focusVisible': { boxShadow: 'inset 0 0 0 2px var(--hud-accent)' },
                  [COARSE]: { minHeight: 48 },
                }}
              >
                {/* 28px 칸 가운데 점 — 탭을 바꿔도 이름 글자의 x 위치가 명단과 같다(DR11) */}
                <Box sx={{ width: 28, height: 28, flex: 'none', display: 'grid', placeItems: 'center' }}>
                  {active ? <Dot status="working" /> : <RingDot />}
                </Box>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
                    <Box
                      component="span"
                      sx={{ fontSize: 13, fontWeight: 500, lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {r.name}
                    </Box>
                    <HudBadge>{t(r.kind === 'team' ? 'office.roomKindTeam' : 'office.roomKindTft')}</HudBadge>
                  </Box>
                  <Box
                    component="span"
                    data-second-line=""
                    sx={{
                      display: 'block',
                      fontSize: 11,
                      lineHeight: 1.4,
                      color: active ? 'var(--hud-fg2)' : 'var(--hud-fg3)', // 초록 글자는 쓰지 않는다(§1-1)
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {roomSecondLine(r, ready)}
                  </Box>
                </Box>
              </ButtonBase>
              <Box className="hud-actions" style={open ? { opacity: 1 } : undefined} sx={{ px: 0.25 }}>
                {focusable ? (
                  <Tooltip title={chatName}>
                    <IconButton
                      size="small"
                      aria-label={chatName}
                      aria-pressed={open}
                      onClick={() => onChat(r.id)}
                      sx={{ ...ACTION_ICON, ...(open ? OPEN_BUBBLE : {}), [COARSE]: { width: 44, height: 44 } }}
                    >
                      <ChatBubbleOutlineIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  </Tooltip>
                ) : (
                  // 행이 같은 일(창 열기)을 하는 행 — 2D 전부와 3D 의 장면 자리 없는 방 — 은 말풍선을 키보드·스크린리더 정지점에서 뺀다(DR16).
                  // 열림은 2D 에서 행 이름이 알린다(N10)
                  <IconButton
                    size="small"
                    tabIndex={-1}
                    aria-hidden
                    onClick={() => onChat(r.id)}
                    sx={{ ...ACTION_ICON, ...(open ? OPEN_BUBBLE : {}), [COARSE]: { width: 44, height: 44 } }}
                  >
                    <ChatBubbleOutlineIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                )}
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

/** 창이 열려 있는 방의 말풍선: 눌린 모양(DR8, 하단 도구 막대 눌림과 같다) */
const OPEN_BUBBLE = { bgcolor: 'var(--hud-wash)', color: 'var(--hud-fg)', boxShadow: 'inset 0 -2px 0 var(--hud-accent)' } as const;

export interface OfficeHudProps {
  agents: ServerAgent[];
  selected: string | null;
  following: string | null;
  view: '3d' | '2d';
  live: boolean;
  /** 마지막 갱신 뒤 지난 초. 끊겼을 때만 보인다. */
  staleSeconds: number;
  banner?: ReactNode;
  ownerOf?: (a: ServerAgent) => string;
  isMine?: (a: ServerAgent) => boolean;
  onSelect: (alias: string) => void;
  /** 대화 팝업을 연다(OMAI-1115). 있으면 행마다 '대화'·'상세' 단추를 둔다. */
  onChat?: (alias: string) => void;
  onFocus: (alias: string) => void;
  onFollow: (alias: string | null) => void;
  onView: (v: '3d' | '2d') => void;
  /** 내 아바타로 걸을 수 있을 때 보이는 안내(계획 007 P6b). */
  walkHint?: string;
  /** 관리자에게만 — 배치 편집을 연다(계획 007 P7). */
  onEdit?: () => void;
  /** 배경음(계획 007 P8). 브라우저가 WebAudio 를 지원할 때만. track·setTrack 은 곡 고르기(스펙 2026-10-21-014). */
  ambient?: { on: boolean; toggle: () => void; track: string; setTrack: (id: string, opts?: { turnOn?: boolean }) => void };
  /** 부서 슬로건·목표 현수막 켜고 끄기(3D 보기에서만, 스펙 2026-10-15-018). 문구가 하나도 없으면 주지 않는다. */
  slogan?: { on: boolean; toggle: () => void };
  /** 회의실 탭의 방(스펙 2026-10-20-021). 주지 않으면 지금처럼 명단만 보인다. */
  rooms?: HudRoom[];
  /** 회의 목록 첫 응답이 왔는지(DR6). 오기 전에는 점을 고리로, 둘째 줄을 비운다 */
  meetingsReady?: boolean;
  /** 회의 목록 읽기 실패(DR6) */
  meetingsFailed?: boolean;
  /** 방 목록 다시 읽기 실패(N7) */
  roomsStale?: boolean;
  /** 회의실 채팅 창이 열려 있는 방(최소화 아님, DR8) */
  openRoomId?: number | null;
  /** 좁은 화면(600px 미만). 2D 에서 회의실 목록을 처음에 접는다(DR14·N9) */
  narrow?: boolean;
  /** 회의실 행 — 장면 자리가 있는 방(3D)만 부른다(DR5) */
  onRoomFocus?: (id: number) => void;
  /** 회의실 채팅 창을 연다 */
  onRoomChat?: (id: number) => void;
  /** 회의실 탭을 고르거나 2D 목록을 펼칠 때 — 방 목록을 다시 읽는다(R9·N8) */
  onRoomsTab?: () => void;
  /** 관리자에게만 — 새 TFT 방 서랍(R13) */
  onNewRoom?: () => void;
  /** 카메라 조작 단추(3D, 스펙 2026-10-21-006) */
  onCamera?: (kind: CameraNudge | 'reset') => void;
  /** 회의 중 사용자가 카메라를 옮겼을 때 회의 보기로 돌아가는 단추. 카메라 조작 옆(왼쪽)에 둔다 */
  onBackToMeeting?: () => void;
}

export function OfficeHud(p: OfficeHudProps) {
  const { mode } = useThemeMode();
  const [filter, setFilter] = useState<SceneStatus | null>(null);
  const [tab, setTab] = useState<'agents' | 'rooms'>('agents');
  // 2D 이고 좁은 화면이면 처음에 접는다(DR14). 초기값은 부모가 넘긴 narrow 로 정한다 — 미디어 쿼리로 잡으면 첫 렌더에서 접히지 않는다(N9)
  const [open, setOpen] = useState(() => !(p.rooms && p.view === '2d' && p.narrow));
  const [flash, setFlash] = useState<{ id: number; n: number } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const roomsRef = useRef<HTMLUListElement>(null);
  const ids = useId();
  const counts = countByStatus(p.agents);
  const shown = orderAgents(filterAgents(p.agents, filter), p.isMine);
  const vars = hudVars(mode);
  const rooms = p.rooms;
  const ready = p.meetingsReady ?? true;
  const liveRooms = ready && rooms ? rooms.filter((r) => r.state !== 'idle').length : 0;
  const warning = p.roomsStale ? t('office.hudRoomsListError') : p.meetingsFailed ? t('office.hudRoomsReadError') : null;

  // 보기가 바뀌면 그 보기의 처음 상태로: 3D 는 펼침, 좁은 2D 는 접음(N9)
  const prevView = useRef(p.view);
  useEffect(() => {
    if (prevView.current === p.view) return;
    prevView.current = p.view;
    if (p.view === '3d') setOpen(true);
    else if (p.rooms && p.narrow) setOpen(false);
  }, [p.view, p.narrow, p.rooms]);
  // 2D 목록이 펼친 채로 뜨면 그때 방 목록을 한 번 다시 읽는다(N8). 보기가 바뀔 때만 본다
  useEffect(() => {
    if (p.rooms && p.view === '2d' && open) p.onRoomsTab?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.view]);
  // 카메라를 옮긴 행의 표시는 1.2초 뒤 끈다(DR9). 같은 행을 다시 누르면 n 이 바뀌어 다시 센다
  useEffect(() => {
    if (!flash) return;
    const id = window.setTimeout(() => setFlash(null), 1200);
    return () => window.clearTimeout(id);
  }, [flash]);

  const onKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const next = moveFocus(e, listRef.current, '[data-roster-item]');
    if (next) {
      if (next.dataset.alias) p.onFocus(next.dataset.alias);
      return;
    }
    const items = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[data-roster-item]') ?? []);
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if ((e.key === 'f' || e.key === 'F') && i >= 0) {
      e.preventDefault();
      const alias = items[i].dataset.alias ?? null;
      p.onFollow(p.following === alias ? null : alias);
    }
  };

  const onRoomRow = (r: HudRoom) => {
    if (p.view === '3d' && r.place) {
      p.onRoomFocus?.(r.id);
      if (!prefersReducedMotion()) setFlash((f) => ({ id: r.id, n: (f?.n ?? 0) + 1 }));
    } else {
      p.onRoomChat?.(r.id);
    }
  };
  const onRoomChat = (id: number) => p.onRoomChat?.(id);

  const roomList = rooms && (
    <RoomList
      rooms={rooms}
      is3d={p.view === '3d'}
      ready={ready}
      warning={warning}
      openRoomId={p.openRoomId ?? null}
      flashId={flash?.id ?? null}
      listRef={roomsRef}
      onRow={onRoomRow}
      onChat={onRoomChat}
      onNewRoom={p.onNewRoom}
    />
  );
  // 회의실 탭 글자 앞의 회의 점(DR2)
  const liveDot = liveRooms > 0 ? <Dot status="working" size={6} /> : null;
  const roomsName = `${t('office.hudTabRooms')} ${rooms?.length ?? 0}${liveRooms ? t('office.hudRoomsLiveSuffix', { count: liveRooms }) : ''}`;

  const rosterList = (
    <Box
      component="ul"
      ref={listRef}
      role="list"
      aria-label={t('office.roster')}
      onKeyDown={onKey}
      sx={{ listStyle: 'none', m: 0, px: 0.5, pt: 0, pb: 0.5, maxHeight: 340, overflowX: 'hidden', overflowY: 'auto' }}
    >
      {shown.length === 0 && (
        <Typography component="li" sx={{ px: 1, py: 1, fontSize: 12, color: 'var(--hud-fg3)' }}>
          {t('office.rosterEmpty')}
        </Typography>
      )}
      {shown.map((a) => {
        const st = sceneStatus(a);
        const mine = p.isMine?.(a) ?? false;
        const selected = p.selected === a.alias;
        const name = agentName(a);
        const state = p.following === a.alias ? t('office.follow') : mine ? t('office.mine') : t(STATUS_LABEL[st]);
        const owner = p.ownerOf?.(a);
        return (
          <Box
            component="li"
            key={a.alias}
            sx={{
              display: 'flex',
              alignItems: 'center',
              '& .hud-actions': { opacity: 0.7, transition: 'opacity 120ms' },
              '&:hover .hud-actions, &:focus-within .hud-actions': { opacity: 1 },
            }}
          >
            <ButtonBase
              data-roster-item
              data-alias={a.alias}
              onClick={() => p.onFocus(a.alias)}
              title={t('office.rosterHint')}
              sx={{
                flex: 1, // 남는 폭만 쓴다 — 100% 이면 뒤의 대화·상세 단추만큼 넘쳐 좌우 스크롤이 생겼다
                minWidth: 0,
                justifyContent: 'flex-start',
                gap: 1.25,
                pl: 1,
                pr: 0.5,
                py: 0.75,
                minHeight: 44,
                borderRadius: '6px',
                textAlign: 'left',
                color: 'var(--hud-fg)',
                // 선택 = wash + 왼쪽 2px 강조선(§1-1.2). 브랜드 레드는 쓰지 않는다.
                bgcolor: selected ? 'var(--hud-wash)' : 'transparent',
                boxShadow: selected ? 'inset 2px 0 0 var(--hud-accent)' : 'none',
                '&:hover': { bgcolor: selected ? 'var(--hud-wash)' : 'var(--hud-wash-hover)' },
                '&.Mui-focusVisible': { boxShadow: 'inset 0 0 0 2px var(--hud-accent)' },
              }}
            >
              <Box sx={{ position: 'relative', width: 28, height: 28, flex: 'none' }}>
                <Avatar
                  alt=""
                  src={faceUrl(agentSeed(a))}
                  sx={{
                    width: 28,
                    height: 28,
                    // 내 에이전트는 아바타 둘레 고리로 가린다(이름 칸을 가리는 외곽선 대신).
                    boxShadow: mine ? '0 0 0 1.5px var(--hud-solid), 0 0 0 2.5px var(--hud-accent)' : 'none',
                  }}
                />
                <Box
                  sx={{
                    position: 'absolute',
                    right: -3,
                    bottom: -3,
                    p: '2px',
                    display: 'flex',
                    borderRadius: '50%',
                    bgcolor: 'var(--hud-solid)',
                  }}
                >
                  <Dot status={st} size={8} />
                </Box>
              </Box>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Box
                  component="span"
                  sx={{
                    display: 'block',
                    fontSize: 13,
                    fontWeight: 500,
                    lineHeight: 1.4,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {name}
                </Box>
                <Box
                  component="span"
                  sx={{
                    display: 'block',
                    fontSize: 11,
                    lineHeight: 1.4,
                    color: p.following === a.alias ? 'var(--hud-fg)' : 'var(--hud-fg3)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {state}
                  {owner && ` · ${owner}`}
                </Box>
              </Box>
            </ButtonBase>
            {p.onChat && (
              <Stack direction="row" spacing={0.25} className="hud-actions" sx={{ pl: 0.25, pr: 0.25 }}>
                <Tooltip title={t('office.openChatFor', { name })}>
                  <IconButton
                    size="small"
                    aria-label={t('office.openChatFor', { name })}
                    onClick={() => p.onChat?.(a.alias)}
                    sx={ACTION_ICON}
                  >
                    <ChatBubbleOutlineIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                </Tooltip>
                <Tooltip title={t('office.openDetailFor', { name })}>
                  <IconButton
                    size="small"
                    aria-label={t('office.openDetailFor', { name })}
                    onClick={() => {
                      p.onFocus(a.alias);
                      p.onSelect(a.alias);
                    }}
                    sx={ACTION_ICON}
                  >
                    <InfoOutlinedIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                </Tooltip>
              </Stack>
            )}
          </Box>
        );
      })}
    </Box>
  );

  const toggleSx = {
    fontSize: 12,
    fontWeight: 500,
    color: 'var(--hud-fg3)',
    '&:hover': { color: 'var(--hud-fg)' },
    '&.Mui-focusVisible': { boxShadow: 'inset 0 0 0 2px var(--hud-accent)' },
  } as const;
  const expandIcon = (
    <ExpandMoreIcon aria-hidden sx={{ fontSize: 18, transition: 'transform 160ms', transform: open ? 'none' : 'rotate(-90deg)' }} />
  );
  const tabId = (k: string) => `${ids}-tab-${k}`;
  const panelId = (k: string) => `${ids}-panel-${k}`;

  return (
    <>
      <Box
        role="region"
        aria-label={t('office.hudLabel')}
        sx={{
          ...vars,
          ...GLASS,
          position: 'absolute',
          top: 12,
          right: 12,
          width: 288,
          maxWidth: 'calc(100% - 24px)',
          zIndex: 2,
          boxShadow: HUD_PALETTE[mode].shadow,
          overflow: 'hidden',
        }}
      >
        {p.banner}
        <Stack direction="row" flexWrap="wrap" useFlexGap spacing={0.5} sx={{ p: 1 }}>
          {HUD_ORDER.filter((s) => counts[s] > 0 || s === 'working' || s === 'idle' || s === 'error').map((s) => (
            <HudTip key={s} title={filter === s ? t('office.hudFilterClearTip') : t('office.hudFilterTip', { label: t(STATUS_LABEL[s]) })}>
              <ButtonBase
                aria-pressed={filter === s}
                onClick={() => {
                  // 회의실 탭에서 칩을 누르면 명단 탭으로 넘겨 걸러진 결과를 보인다(DR1)
                  if (rooms && tab === 'rooms' && p.view === '3d') {
                    setTab('agents');
                    setOpen(true);
                    setFilter(s);
                    return;
                  }
                  setFilter(filter === s ? null : s);
                }}
                sx={{
                  gap: 0.75,
                  px: 1,
                  minHeight: 28,
                  borderRadius: '999px',
                  fontSize: 12,
                  fontWeight: 500,
                  color: filter === s ? 'var(--hud-fg)' : 'var(--hud-fg2)',
                  border: '1px solid',
                  borderColor: filter === s ? 'var(--hud-line)' : 'transparent',
                  bgcolor: filter === s ? 'var(--hud-wash)' : 'transparent',
                  '&:hover': { bgcolor: filter === s ? 'var(--hud-wash)' : 'var(--hud-wash-hover)' },
                  '&.Mui-focusVisible': { boxShadow: '0 0 0 2px var(--hud-accent)' },
                }}
              >
                <Dot status={s} />
                {t('office.hudCount', { label: t(STATUS_LABEL[s]), n: counts[s] })}
              </ButtonBase>
            </HudTip>
          ))}
          <Box sx={{ flex: 1 }} />
          {!p.live && (
            <Box
              component="span"
              role="status"
              sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, fontSize: 12, color: 'var(--hud-warn)', px: 0.5 }}
            >
              <Box component="span" aria-hidden sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: 'var(--hud-warn)' }} />
              {t('office.lastUpdate', { s: p.staleSeconds })}
            </Box>
          )}
        </Stack>
        {p.view === '3d' && !rooms && (
          <Box sx={{ borderTop: '1px solid var(--hud-line-soft)' }}>
            <ButtonBase
              aria-expanded={open}
              aria-label={t('office.rosterToggle')}
              onClick={() => setOpen(!open)}
              sx={{ ...toggleSx, width: '100%', justifyContent: 'space-between', px: 1.5, py: 0.75 }}
            >
              <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
                {t('office.roster')}
                <CountPill n={shown.length} />
              </Box>
              {expandIcon}
            </ButtonBase>
            <Collapse in={open}>{rosterList}</Collapse>
          </Box>
        )}
        {p.view === '3d' && rooms && (
          <Box sx={{ borderTop: '1px solid var(--hud-line-soft)' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', pr: 0.5 }}>
              <Tabs
                value={tab}
                onChange={(_, v: 'agents' | 'rooms') => {
                  setTab(v);
                  setOpen(true);
                  if (v === 'rooms') p.onRoomsTab?.();
                }}
                selectionFollowsFocus
                aria-label={t('office.hudTabsLabel')}
                sx={{
                  flex: 1,
                  minWidth: 0,
                  minHeight: 32,
                  px: 0.5,
                  // 접힌 상태에서는 「이 목록을 보고 있다」 는 선을 숨긴다(DR10)
                  '& .MuiTabs-indicator': { height: 2, bgcolor: 'var(--hud-accent)', display: open ? 'block' : 'none' },
                }}
              >
                <Tab
                  value="agents"
                  id={tabId('agents')}
                  aria-controls={panelId('agents')}
                  aria-label={`${t('office.roster')} ${shown.length}`}
                  onClick={() => setOpen(true)} // 이미 고른 탭을 접힌 채 눌러도 펼친다(F8 — onChange 는 값이 바뀔 때만 불린다)
                  label={
                    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
                      {t('office.roster')}
                      <CountPill n={shown.length} />
                    </Box>
                  }
                  sx={HUD_TAB}
                />
                <Tab
                  value="rooms"
                  id={tabId('rooms')}
                  aria-controls={panelId('rooms')}
                  aria-label={roomsName}
                  onClick={() => setOpen(true)}
                  label={
                    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
                      {liveDot}
                      {t('office.hudTabRooms')}
                      <CountPill n={rooms.length} />
                    </Box>
                  }
                  sx={HUD_TAB}
                />
              </Tabs>
              <HudTip title={open ? t('office.hudListCloseTip') : t('office.hudListOpenTip')}>
                <ButtonBase
                  aria-expanded={open}
                  aria-label={t('office.hudListToggle')}
                  aria-controls={`${panelId('agents')} ${panelId('rooms')}`}
                  onClick={() => setOpen(!open)}
                  sx={{ ...toggleSx, width: 28, height: 28, borderRadius: '6px', flex: 'none' }}
                >
                  {expandIcon}
                </ButtonBase>
              </HudTip>
            </Box>
            <Collapse in={open}>
              <Box role="tabpanel" id={panelId('agents')} aria-labelledby={tabId('agents')} hidden={tab !== 'agents'}>
                {rosterList}
              </Box>
              <Box role="tabpanel" id={panelId('rooms')} aria-labelledby={tabId('rooms')} hidden={tab !== 'rooms'}>
                {roomList}
              </Box>
            </Collapse>
          </Box>
        )}
        {p.view === '2d' && rooms && (
          // 2D: 명단은 지금처럼 3D 전용이라 탭 없이 회의실 목록만(R15, DR14)
          <Box sx={{ borderTop: '1px solid var(--hud-line-soft)' }}>
            <ButtonBase
              aria-expanded={open}
              aria-label={t('office.hudListToggle')}
              onClick={() => {
                if (!open) p.onRoomsTab?.(); // 펼칠 때 방 목록을 다시 읽는다(N8)
                setOpen(!open);
              }}
              sx={{ ...toggleSx, width: '100%', justifyContent: 'space-between', px: 1.5, py: 0.75 }}
            >
              <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
                {liveDot}
                {t('office.hudTabRooms')}
                <CountPill n={rooms.length} />
              </Box>
              {expandIcon}
            </ButtonBase>
            <Collapse in={open}>{roomList}</Collapse>
          </Box>
        )}
      </Box>
      {p.view === '3d' && (p.onCamera || p.onBackToMeeting) && (
        <Stack
          direction="row"
          spacing={1}
          sx={{ ...vars, position: 'absolute', right: 12, bottom: 12, zIndex: 2, alignItems: 'flex-end' }}
        >
          {p.onBackToMeeting && (
            <HudTip title={t('office.backToMeetingTip')}>
              <Button
                size="small"
                variant="outlined"
                onClick={p.onBackToMeeting}
                sx={{ bgcolor: 'rgba(15,16,17,0.85)', minHeight: 36, whiteSpace: 'nowrap' }}
              >
                {t('office.backToMeeting')}
              </Button>
            </HudTip>
          )}
          {p.onCamera && <CameraDial disabled={!!p.following} onCamera={p.onCamera} shadow={HUD_PALETTE[mode].shadow} />}
        </Stack>
      )}
      <Stack direction="row" spacing={1} sx={{ ...vars, position: 'absolute', left: 12, bottom: 12, zIndex: 2, alignItems: 'center' }}>
        <Stack
          direction="row"
          spacing={0.25}
          sx={{ ...GLASS, p: 0.5, boxShadow: HUD_PALETTE[mode].shadow }}
        >
          {p.view === '3d' && (
            <HudTip title={p.following ? t('office.followOffTip') : p.selected ? t('office.followTip') : t('office.followNeedSelect')}>
              <span>
                <Button
                  size="small"
                  startIcon={<MyLocationIcon aria-hidden />}
                  disabled={!p.following && !p.selected}
                  aria-pressed={!!p.following}
                  onClick={() => p.onFollow(p.following ? null : p.selected)}
                  sx={BAR_BUTTON}
                >
                  {p.following ? t('office.followOff') : t('office.follow')}
                </Button>
              </span>
            </HudTip>
          )}
          {/* 3D 에서는 2D 로 바꾸는 단추를 두지 않는다. 좁은 화면·WebGL 없음으로 2D 가 된 경우에만 3D 로 돌아가는 단추를 둔다 */}
          {p.view === '2d' && (
            <HudTip title={t('office.view3dTip')}>
              <Button size="small" startIcon={<ViewInArOutlinedIcon aria-hidden />} onClick={() => p.onView('3d')} sx={BAR_BUTTON}>
                {t('office.view3d')}
              </Button>
            </HudTip>
          )}
          {p.ambient && (
            <HudTip title={p.ambient.on ? t('office.ambientOffTip') : t('office.ambientOnTip')}>
              <Button
                size="small"
                startIcon={p.ambient.on ? <VolumeUpOutlinedIcon aria-hidden /> : <VolumeOffOutlinedIcon aria-hidden />}
                aria-pressed={p.ambient.on}
                onClick={p.ambient.toggle}
                sx={BAR_BUTTON}
              >
                {p.ambient.on ? t('office.ambientOff') : t('office.ambientOn')}
              </Button>
            </HudTip>
          )}
          {p.ambient && <TrackMenu track={p.ambient.track} onPick={(id) => p.ambient!.setTrack(id, { turnOn: true })} mode={mode} />}
          {p.view === '3d' && p.slogan && (
            <HudTip title={p.slogan.on ? t('office.bannerOffTip') : t('office.bannerOnTip')}>
              <Button
                size="small"
                startIcon={<CampaignOutlinedIcon aria-hidden />}
                aria-pressed={p.slogan.on}
                onClick={p.slogan.toggle}
                sx={BAR_BUTTON}
              >
                {p.slogan.on ? t('office.bannerOff') : t('office.bannerOn')}
              </Button>
            </HudTip>
          )}
          {p.view === '3d' && p.onEdit && (
            <HudTip title={t('office.editLayoutTip')}>
              <Button size="small" startIcon={<EditOutlinedIcon aria-hidden />} onClick={p.onEdit} sx={BAR_BUTTON}>
                {t('office.editLayout')}
              </Button>
            </HudTip>
          )}
          {/* 걷기 안내는 늘 띄워 두지 않고 ? 단추의 풍선말로. 막대 끝에 둔다 */}
          {p.view === '3d' && p.walkHint && (
            <HudTip title={p.walkHint}>
              <IconButton size="small" aria-label={t('office.walkHelp')} sx={{ ...ACTION_ICON, width: 32, height: 32, borderRadius: '6px' }}>
                <HelpOutlineIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </HudTip>
          )}
        </Stack>
      </Stack>
    </>
  );
}

/** 상태판 위 한 줄 배너(문제 Alert 를 장면 위에 쌓지 않는다, G1). 색은 상태판의 --hud-* 변수를 따른다. */
export function HudBanner({ text, more }: { text: string; more: number }) {
  return (
    <Box
      role="alert"
      sx={{
        px: 1.5,
        py: 0.75,
        fontSize: 12,
        color: 'var(--hud-fg)',
        borderBottom: '1px solid var(--hud-line-soft)',
        display: 'flex',
        gap: 1,
        alignItems: 'center',
      }}
    >
      <Box
        component="span"
        aria-hidden
        sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: 'var(--hud-error)', flex: 'none' }}
      />
      <Box
        component="span"
        sx={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        title={text}
      >
        {text}
      </Box>
      {more > 0 && <span>{t('office.problemsMore', { count: more + 1 })}</span>}
    </Box>
  );
}
