/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 사람 이름 칩: 「(이니셜) 이름」. 원형 이니셜에 테두리가 없어 에이전트 칩(알약·점)·프로파일 칩(사각·점)과 한눈에 다르다.
// 글자는 이름, 없으면 이메일이다. 이메일이 따로 있으면 툴팁에 둔다. 색은 이메일(없으면 이름)로 정한다. 표시 전용이다.
import AutoModeIcon from '@mui/icons-material/AutoMode';
import LoginOutlinedIcon from '@mui/icons-material/LoginOutlined';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import { Box } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import type { ReactNode } from 'react';

import { avatarTile, chatMetrics, chatType, hueOf } from '@/lib/chatTokens';

type Size = 'sm' | 'md';

/** 원형 표시 + 이름. 사람 칩과 주체 칩이 같은 모양을 쓴다 */
function ChipShell({ mark, tile, label, title, size, attrs }: { mark: ReactNode; tile: { bg: string; fg: string }; label: string; title?: string; size: Size; attrs: Record<string, string> }) {
  const d = size === 'sm' ? 18 : 22;
  return (
    <Box
      component="span"
      {...attrs}
      title={title}
      sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, minWidth: 0, maxWidth: chatMetrics.chipMax, verticalAlign: 'middle', fontSize: size === 'sm' ? chatType.meta + 1 : chatType.name - 1 }}
    >
      <Box
        aria-hidden="true"
        component="span"
        sx={{ flex: `0 0 ${d}px`, width: d, height: d, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: size === 'sm' ? 10 : 11, fontWeight: 600, bgcolor: tile.bg, color: tile.fg }}
      >
        {mark}
      </Box>
      <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </Box>
    </Box>
  );
}

export function UserChip({ name, email, size = 'sm' }: { name?: string; email?: string; size?: Size }) {
  const mode = useTheme().palette.mode;
  const label = name || email || '';
  if (!label) return null;
  return (
    <ChipShell mark={label.slice(0, 1).toUpperCase()} tile={avatarTile(hueOf(email || name || ''), mode)} label={label} title={email} size={size} attrs={{ 'data-user-chip': '' }} />
  );
}

export type ActorKind = 'aas' | 'agent' | 'guest';

// 사람이 아닌 주체(변경 기록의 「누가」, 2026-10-17-012). 사람 칩과 같은 모양에 머리글자 대신 아이콘을 둔다.
// 색은 사람 칩 팔레트(AVATAR_HUES)에 없는 색으로 고정해 사람과 겹치지 않게 한다: AAS 자동 회색, 에이전트 청록, 로그인 전 주황
export const ACTOR_HUES: Record<ActorKind, string> = { aas: '#868e96', agent: '#0c8599', guest: '#e8590c' };
const ACTOR_ICONS = { aas: AutoModeIcon, agent: SmartToyOutlinedIcon, guest: LoginOutlinedIcon } as const;

export function ActorChip({ kind, label, size = 'sm' }: { kind: ActorKind; label: string; size?: Size }) {
  const mode = useTheme().palette.mode;
  const Icon = ACTOR_ICONS[kind];
  return (
    <ChipShell
      mark={<Icon sx={{ fontSize: size === 'sm' ? 12 : 14 }} />}
      tile={avatarTile(ACTOR_HUES[kind], mode)}
      label={label}
      size={size}
      attrs={{ 'data-actor-chip': kind }}
    />
  );
}

/** 사람 이름 여러 개: 줄바꿈하며 나열하고 max(기본 4) 개를 넘으면 「+N」. */
export function UserChips({ names, max = 4 }: { names: string[]; max?: number }) {
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  return (
    <Box component="span" sx={{ display: 'inline-flex', flexWrap: 'wrap', gap: '4px 10px', alignItems: 'center' }}>
      {shown.map((n) => (
        <UserChip key={n} name={n.includes('@') ? undefined : n} email={n.includes('@') ? n : undefined} />
      ))}
      {rest > 0 && (
        <Box component="span" title={names.slice(max).join(', ')} sx={{ fontSize: chatType.meta, color: 'text.secondary' }}>
          +{rest}
        </Box>
      )}
    </Box>
  );
}
