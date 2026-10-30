/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 회의: TFT 방의 사람과 에이전트가 한 대화를 나눈다. 왼쪽 방 목록과 오른쪽 대화(MeetingRoom)로 이룬다.
import AddIcon from '@mui/icons-material/Add';
import { Box, Button, Stack, Typography } from '@mui/material';
import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

import { ChatFrame } from '@/components/chat/ChatFrame';
import { useChatTokens } from '@/components/chat/useChatTokens';
import { Pill } from '@/components/DataGrid';
import { tier2 } from '@/components/tierButton';
import { t } from '@/i18n';
import { chatMetrics, chatType } from '@/lib/chatTokens';
import { briefSummary } from '@/lib/roomBrief';
import { FOCUS_RING } from '@/lib/shellTokens';
import { AgentAvatar } from '@/screens/chat/parts';
import { Room } from '@/screens/office/forms';
import { MeetingRoom } from '@/screens/office/MeetingRoom';
import { roomRole, TablesData, useRoomEditor } from '@/screens/office/Tables';

/** 왼쪽 방 목록(채팅의 에이전트 목록과 같은 모양). 방이 하나여도 늘 보인다(사용자 결정 2026-10-15). */
/** onCreate 를 주면(관리자) 목록 맨 위에 「새 TFT 방」 단추를 둔다(스펙 2026-10-20-018) */
function RoomList({ rooms, currentId, onPick, onCreate }: { rooms: Room[]; currentId: number; onPick: (id: number) => void; onCreate?: () => void }) {
  const tk = useChatTokens();
  return (
    <Box
      component="aside"
      aria-label={t('office.meetingRoomsLabel')}
      sx={{ borderRight: { md: `1px solid ${tk.line}` }, bgcolor: tk.rail, overflow: 'auto', minHeight: 0 }}
    >
      {onCreate && (
        <Box sx={{ p: 1, borderBottom: `1px solid ${tk.line}` }}>
          <Button fullWidth size="small" variant="outlined" color="inherit" startIcon={<AddIcon />} sx={tier2 as object} onClick={onCreate}>
            {t('office.newRoom')}
          </Button>
        </Box>
      )}
      <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
        {rooms.map((r) => {
          const full = r.kind === 'team' ? t('office.teamMeetingOption', { name: r.name }) : r.name;
          const sub = briefSummary(r.purpose); // 종류는 이름 옆 뱃지로 알린다(스펙 2026-10-20-020)
          return (
            <li key={r.id}>
              <Box
                component="button"
                type="button"
                aria-current={r.id === currentId}
                aria-label={full}
                title={full}
                onClick={() => onPick(r.id)}
                sx={{
                  all: 'unset',
                  boxSizing: 'border-box',
                  display: 'flex',
                  gap: 1.5,
                  width: '100%',
                  minHeight: 60,
                  px: 1.5,
                  py: 1,
                  cursor: 'pointer',
                  alignItems: 'center',
                  color: tk.text,
                  '&:hover': { bgcolor: tk.hover },
                  // 선택은 왼쪽 2px 선 + 단색 wash(채팅 목록과 같다)
                  '&[aria-current=true]': { bgcolor: tk.selected, boxShadow: `inset 2px 0 0 ${tk.selectedAccent}` },
                  '&:focus-visible': { outline: `2px solid ${FOCUS_RING}`, outlineOffset: -2 },
                  '@media (pointer: coarse)': { minHeight: chatMetrics.touch },
                }}
              >
                <AgentAvatar name={r.name} size={chatMetrics.listAvatar} />
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
                    <Box
                      sx={{
                        fontSize: chatType.name,
                        fontWeight: 500,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {r.name}
                    </Box>
                    {/* 같은 이름의 팀 방과 TFT 방이 함께 있어 이름 옆에 종류를 단다 */}
                    <Pill>{t(r.kind === 'team' ? 'office.roomKindTeam' : 'office.roomKindTft')}</Pill>
                  </Box>
                  {sub && (
                    <Typography noWrap sx={{ color: tk.muted, fontSize: 12 }}>
                      {sub}
                    </Typography>
                  )}
                </Box>
              </Box>
            </li>
          );
        })}
      </Box>
    </Box>
  );
}

/** data 를 주면 관리자와 그 방의 담당·구성원에게 TFT 방 머리의 「방 정보 고치기」를 보인다(스펙 2026-10-18-007·008) */
export function Meeting({ rooms, canAct, data }: { rooms: Room[]; canAct: boolean; data?: TablesData }) {
  const [params, setParams] = useSearchParams();
  const pickRoom = (id: number) => setParams({ tab: 'meeting', room: String(id) }, { replace: true });
  // 새 방을 저장하면 그 방의 회의로 옮겨 간다. 회의 탭에서 만든 사람은 그 회의에 들어가려는 것이다(스펙 2026-10-20-018)
  const editRoom = useRoomEditor(data ?? { seats: [], rooms: [], pods: [], can_edit: false }, pickRoom);
  const onCreate = data?.can_edit ? () => editRoom(null) : undefined; // 방 만들기는 관리자만(서버 /api/office/action 과 같다)
  const tk = useChatTokens();
  // 팀 방(내 팀)을 먼저, 그다음 TFT 방(계획 2026-10-13-011 §3-3). 서버가 보는 사람이 구성원인 방만 준다(관리자는 전부)
  const open = rooms
    .filter((r) => r.status !== 'closed')
    .sort((a, b) => Number(b.kind === 'team') - Number(a.kind === 'team'));
  const wanted = Number(params.get('room'));
  const room = open.find((r) => r.id === wanted) ?? open[0];
  // 좁은 화면(md 미만)은 채팅처럼 목록과 대화를 번갈아 보인다. 방을 골랐을 때(?room=)만 대화를 보인다
  const picked = open.some((r) => r.id === wanted);
  // 오피스 장면 위 창에서 「지난 대화」를 누르면 ?past=1(&thread=) 로 옮겨 온다 — 큰 화면에서 서랍을 연 뒤 주소에서 지운다(스펙 2026-10-20-027 DR13)
  const pastParam = params.get('past');
  const threadParam = params.get('thread');
  const initialPast = useMemo(
    () => (pastParam ? { thread: threadParam !== null && threadParam !== '' ? Number(threadParam) : undefined } : undefined),
    [pastParam, threadParam]
  );

  if (!room)
    return (
      <ChatFrame offset="230px" minHeight={440}>
        <Stack alignItems="center" justifyContent="center" spacing={2} sx={{ flex: 1, p: 3, textAlign: 'center' }}>
          <Typography sx={{ color: tk.muted, maxWidth: 420 }}>{t('office.meetingNoRoom')}</Typography>
          {onCreate && (
            <Button size="small" variant="outlined" color="inherit" startIcon={<AddIcon />} sx={tier2 as object} onClick={onCreate}>
              {t('office.newRoom')}
            </Button>
          )}
          <Button
            size="small"
            variant="outlined"
            color="inherit"
            sx={tier2 as object}
            onClick={() => setParams({ tab: 'rooms' }, { replace: true })}
          >
            {t('office.meetingOpenRooms')}
          </Button>
        </Stack>
      </ChatFrame>
    );

  return (
    <ChatFrame
      offset="230px"
      minHeight={440}
      sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '240px minmax(0, 1fr)' } }}
    >
      <Box sx={{ display: { xs: picked ? 'none' : 'block', md: 'block' }, minHeight: 0, overflow: 'auto' }}>
        <RoomList rooms={open} currentId={room.id} onPick={pickRoom} onCreate={onCreate} />
      </Box>
      <MeetingRoom
        roomId={room.id}
        name={room.name}
        purpose={room.purpose}
        canAct={canAct}
        onBack={() => setParams({ tab: 'meeting' }, { replace: true })}
        paneSx={{ display: { xs: picked ? 'flex' : 'none', md: 'flex' } }}
        onEdit={data && roomRole(data, room) ? () => editRoom(room) : undefined}
        // 주소의 방이 목록에 있을 때만 — 목록이 오래돼 첫 방이 보일 때 열면 엉뚱한 방의 지난 대화가 열렸다(OKE 확인 2026-10-20)
        initialPast={picked ? initialPast : undefined}
        onPastHandled={() => setParams({ tab: 'meeting', room: String(room.id) }, { replace: true })}
      />
    </ChatFrame>
  );
}
