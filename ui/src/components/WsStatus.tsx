/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 웹소켓 연결 상태 띠(OMAI-1100). 짧은 끊김에는 아무것도 보이지 않는다 — 재시도가 5번을 넘거나 끊긴 지 10초가 넘었을 때만 보인다.
import { Alert, Button } from '@mui/material';

import { t } from '@/i18n';
import { useWsState, WsClient, wsClient } from '@/lib/ws';

/** 본문 위 상태 띠를 한 줄 약 36px 로(공지 띠와 함께 쌓일 때 덜 밀리게, 스펙 공지 바 6C·E11). PodRestarting 도 쓴다 */
export const denseAlertSx = {
  borderRadius: 0,
  py: '4px',
  alignItems: 'center',
  '& .MuiAlert-icon': { py: '4px', mr: 1.25, fontSize: 18 },
  '& .MuiAlert-message': { py: '4px' },
  '& .MuiAlert-action': { py: 0, pl: 1.5 },
  '& .MuiAlert-action .MuiButton-root': { py: '2px' },
} as const;

export function WsStatus({ client = wsClient }: { client?: WsClient }) {
  const state = useWsState(client);
  if (state === 'retrying-slow') {
    return (
      <Alert severity="warning" role="status" sx={denseAlertSx}>
        {t('ws.reconnecting')}
      </Alert>
    );
  }
  if (state === 'replaced') {
    return (
      <Alert
        severity="info"
        role="status"
        sx={denseAlertSx}
        action={
          <Button color="inherit" size="small" onClick={() => client.continueHere()}>
            {t('ws.continueHere')}
          </Button>
        }
      >
        {t('ws.replaced')}
      </Alert>
    );
  }
  if (state === 'auth-failed') {
    return (
      <Alert severity="error" role="status" sx={denseAlertSx}>
        {t('ws.authFailed')}
      </Alert>
    );
  }
  return null;
}
