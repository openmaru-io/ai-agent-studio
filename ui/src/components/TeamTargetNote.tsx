/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 팀원 에이전트를 바꾸는 화면의 머리 표시(스펙 2026-10-22-001 DD5). 앱 전체 줄은 두지 않고, 그 화면이 다루는 에이전트가 팀원 것일 때만 보인다.
// 프로파일 서랍(비밀값·스킬 탭 포함)·스킬·예약 작업 화면은 쓰기가 지금 에이전트(aas_pod 쿠키)로 가므로 /api/me 의 pod 가 그 화면의 대상이다.
// 사건이 아니라 계속되는 상태라 하늘색(info) 띠가 아니라 채팅 입력 칸 위 줄과 같은 회색 상태 줄로 그린다(DESIGN §1-1.3, Chat Status Rows).
import GroupsOutlinedIcon from '@mui/icons-material/GroupsOutlined';
import { Box } from '@mui/material';

import { statusRowSx } from '@/components/chat/ReconnectRow';
import { useChatTokens } from '@/components/chat/useChatTokens';
import { t } from '@/i18n';
import { useMe } from '@/lib/data';

/** 대상 표시에 쓰는 주인 이름: 사람 이름 → 이메일 → 에이전트 id. 채팅 상태 줄과 화면 머리가 같은 사람을 같게 부른다 */
export const teamOwnerName = (p: { owner_name?: string; owner?: string; id?: string }) => p.owner_name || p.owner || p.id || '';

/** 입력 칸 위·화면 머리의 회색 상태 줄 하나(role="status", DD11) */
export function TeamStatusRow({ text }: { text: string }) {
  const tk = useChatTokens();
  return (
    <Box role="status" data-testid="team-target-row" sx={statusRowSx(tk)}>
      <GroupsOutlinedIcon aria-hidden="true" sx={{ fontSize: 14, color: tk.muted, flexShrink: 0 }} />
      <Box sx={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{text}</Box>
    </Box>
  );
}

/** 지금 에이전트가 팀원 것이면 「팀원 <주인>의 에이전트를 바꿉니다」 줄, 아니면 아무것도 그리지 않는다 */
export function TeamTargetNote() {
  const pod = useMe().data?.pod;
  return pod?.team ? <TeamStatusRow text={t('common.teamTarget', { owner: teamOwnerName(pod) })} /> : null;
}
