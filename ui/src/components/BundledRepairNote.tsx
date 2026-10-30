/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 자동 복구 안내 띠(스펙 2026-10-27-011 디자인 리뷰 D14). 내보내기 때 가려진 기본 스킬을 서버가 되돌리면 그 줄이 「내 스킬」에서
// 「기본 제공」으로 옮겨 간다. 말없이 줄면 「데이터가 날아갔나」로 읽히므로 한 번만 보이는 회색 상태 줄로 알린다(할 일이 없는 상태라 호박색 아님, DESIGN §1-1).
// ListView 의 banner 는 info·warning 뿐이라 TeamTargetNote 처럼 ListView 밖에 그린다. 닫으면 보인 기록의 키를 이 브라우저에 둔다.
import AutorenewRoundedIcon from '@mui/icons-material/AutorenewRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import { Box, IconButton, Link } from '@mui/material';
import { useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import { statusRowSx } from '@/components/chat/ReconnectRow';
import { useChatTokens } from '@/components/chat/useChatTokens';
import { t } from '@/i18n';

/** /api/skills 의 bundled_repaired 한 줄: 이 POD 의 프로파일에서 최근 7일 안에 되돌린 기록(서버가 n>0 만 준다) */
export interface BundledRepair {
  profile: string;
  n: number;
  at: string;
}

const SEEN = 'aas.bundledRepairSeen';
export const repairKey = (pod: string, r: BundledRepair) => `${pod}:${r.profile}:${r.at}`;

function readSeen(): string[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(SEEN) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeSeen(keys: string[]) {
  try {
    window.localStorage.setItem(SEEN, JSON.stringify(keys.slice(-200)));
  } catch {
    // 저장소를 못 쓰면 이번 화면에서만 닫힌다
  }
}

/** 닫지 않은 기록을 합쳐 줄 하나. profile 을 주면 그 프로파일 기록만(프로파일 패널) */
export function BundledRepairNote({ pod, records, profile }: { pod: string; records?: BundledRepair[]; profile?: string }) {
  const tk = useChatTokens();
  const [seen, setSeen] = useState<string[]>(readSeen);
  const shown = (records ?? []).filter((r) => r.n > 0 && (!profile || r.profile === profile) && !seen.includes(repairKey(pod, r)));
  if (!shown.length) return null;
  const n = shown.reduce((a, r) => a + r.n, 0);
  // 기록이 한 프로파일이면 그 프로파일, 여럿이면 전체 프로파일로 연다(스펙 2026-10-27-013 §4-5)
  const profiles = [...new Set(shown.map((r) => r.profile))];
  const only = profiles.length === 1 ? profiles[0] : undefined;
  const close = () => {
    const next = [...seen, ...shown.map((r) => repairKey(pod, r))];
    writeSeen(next);
    setSeen(next);
  };
  return (
    <Box role="status" data-testid="bundled-repair-note" sx={statusRowSx(tk)}>
      <AutorenewRoundedIcon aria-hidden="true" sx={{ fontSize: 14, color: tk.muted, flexShrink: 0 }} />
      <Box sx={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
        {t('skills.repairedNote', { n })}{' '}
        <Link component={RouterLink} to={`/skills?${new URLSearchParams({ tab: 'builtin', profile: only ?? '*' })}`} underline="hover" color="inherit">
          {t('skills.repairedNoteLink')}
        </Link>
      </Box>
      <IconButton size="small" aria-label={t('skills.repairedNoteClose')} onClick={close} sx={{ p: 0.25 }}>
        <CloseRoundedIcon sx={{ fontSize: 14 }} />
      </IconButton>
    </Box>
  );
}
