/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { useSnackbar } from 'notistack';
import { useEffect, useRef } from 'react';

import { t } from '@/i18n';

const SEEN_KEY = 'aas-team-manager-notice';

/** 처음 지정된 팀 관리자에게 안내를 한 번 보인다(스펙 2026-10-22-001 DD9).
 *  본 여부는 「부서|지정 시각」을 localStorage 에 둔다. 다시 지정되면 시각이 달라져 다시 보인다.
 *  저장소를 못 쓰면(차단·시크릿 창) 이 탭에서만 한 번 보이고, 다시 열면 또 보일 수 있다 */
export function useTeamManagerNotice(since: string | undefined, department: string | undefined) {
  const { enqueueSnackbar } = useSnackbar();
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (!since) return;
    const dept = department ?? '';
    const stamp = `${dept}|${since}`;
    if (shown.current === stamp) return;
    let seen = false;
    try {
      seen = localStorage.getItem(SEEN_KEY) === stamp;
    } catch {
      /* 저장소를 못 읽으면 아직 못 본 것으로 둔다 */
    }
    if (seen) return;
    shown.current = stamp;
    try {
      localStorage.setItem(SEEN_KEY, stamp);
    } catch {
      /* 저장소를 못 쓰면 이 탭에서만 한 번 보인다 */
    }
    // 닫기 단추는 AppToast 가 기본으로 달고, persist 로 직접 닫을 때까지 둔다(읽을 시간을 준다)
    enqueueSnackbar(t('shell.teamManagerAssigned', { dept }), { variant: 'info', persist: true });
  }, [since, department, enqueueSnackbar]);
}
