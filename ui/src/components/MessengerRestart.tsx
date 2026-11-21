/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 페어링·채널 설정을 반영하려면 게이트웨이를 다시 시작해야 한다(스펙 2026-11-17-008 §5-1). 소유자가 시점을 고른다 —
// 다시 시작하는 동안 이 작업공간의 메신저 대화가 잠시 끊긴다. 알림은 서버의 다시 시작 장부(/api/me 의 pod.restart_pending)에
// 페어링·채널 기록이 있을 때만 보인다(다시 시작할 수 있는 사람에게만 온다). 단추는 직접 다시 시작하지 않고 대화 상자를 연다(스펙 2026-11-18-016 4-5).
import { Alert, Button } from '@mui/material';

import { t } from '@/i18n';
import { useMe } from '@/lib/data';

import { openRestartPending, useRestartPending } from './RestartPending';

/** profiles 를 주면 그 프로파일의 기록만 본다(채널 탭). 없으면 작업공간 전체(공유·메신저 연결 탭) */
export function MessengerRestart({ pod, profiles }: { pod?: string; profiles?: string[] }) {
  const me = useMe().data;
  const rp = useRestartPending();
  if (!pod || me?.pod?.id !== pod) return null;
  const rows = (rp?.items ?? []).filter((r) => (r.kind === 'pairing' || r.kind === 'channel') && (!profiles?.length || profiles.includes(r.profile)));
  if (!rows.length) return null;
  return (
    <Alert
      severity="info"
      sx={{ my: 1 }}
      action={
        <Button color="inherit" size="small" onClick={() => openRestartPending({ focusProfile: rows[0].profile })}>
          {t('restartPending.open')}
        </Button>
      }
    >
      {t('restartPending.alertMessenger')}
    </Alert>
  );
}
