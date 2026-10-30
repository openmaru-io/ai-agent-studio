/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 3D 오피스의 회의실 채팅 창(OMAI-1257). 회의실 빔 스크린을 누르면 그 방의 회의 대화를 장면 위에 띄운다.
// 대화 본문은 오피스 › 회의 화면과 같은 MeetingRoom 이다(보내기·@이름 호출·받는 에이전트·파일·요약).
// 에이전트 대화 팝업(ChatPopup)과 함께 떠 있을 수 있다: 그 창이 열려 있으면 왼쪽 옆(slot 1)에, 아니면 오른쪽 아래(slot 0)에 처음 놓는다.
// 최소화해도 대화를 내리지 않는다.
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import { Button, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';

import { t } from '@/i18n';
import { useChatPopup } from '@/lib/chatPopup';
import { closeRoomChat, ROOM_CHAT_RECT_KEY, setRoomChatMinimized, useRoomChatPopup } from '@/lib/roomChatPopup';
import { MeetingRoom } from '@/screens/office/MeetingRoom';

import { FloatingChatShell } from './FloatingChatShell';
import { tier2 } from './tierButton';

const KEY = ROOM_CHAT_RECT_KEY;

export function RoomChatPopup() {
  const { target, minimized, openedAt } = useRoomChatPopup();
  const navigate = useNavigate();
  const agentChat = useChatPopup();
  if (!target) return null;
  const { room, name, canAct, emptyNote } = target;

  return (
    <FloatingChatShell
      rectKey={KEY}
      slot={agentChat.target && agentChat.openedAt < openedAt ? 1 : 0} // 에이전트 대화 창이 먼저 떠 있었으면 그 왼쪽 옆, 아니면 오른쪽 아래
      title={t('office.roomChatLabel', { name })}
      ariaLabel={t('office.roomChatLabel', { name })}
      chipLabel={t('office.roomChatLabel', { name })}
      restoreLabel={t('office.roomChatRestore', { name })}
      minimized={minimized}
      onMinimize={() => setRoomChatMinimized(true)}
      onRestore={() => setRoomChatMinimized(false)}
      onClose={closeRoomChat}
      actions={
        room !== null ? (
          <Tooltip title={t('office.roomChatExpand')}>
            <IconButton
              size="small"
              aria-label={t('office.roomChatExpand')}
              onClick={() => {
                closeRoomChat();
                navigate(`/office?tab=meeting&room=${room}`);
              }}
            >
              <OpenInFullIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        ) : undefined
      }
    >
      {room !== null ? (
        <MeetingRoom roomId={room} name={name} canAct={canAct} compact />
      ) : (
        <Stack alignItems="center" justifyContent="center" spacing={2} sx={{ flex: 1, p: 3, textAlign: 'center' }}>
          <Typography color="text.secondary">{emptyNote ?? t('office.roomChatNone')}</Typography>
          <Button
            size="small"
            variant="outlined"
            color="inherit"
            sx={tier2 as object}
            onClick={() => {
              closeRoomChat();
              navigate('/office?tab=rooms');
            }}
          >
            {t('office.meetingOpenRooms')}
          </Button>
        </Stack>
      )}
    </FloatingChatShell>
  );
}
