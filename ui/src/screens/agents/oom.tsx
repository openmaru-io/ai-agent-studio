/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 작업공간 메모리 초과 안내(OMAI-1856, cogentai-aas-docs docs-plan/deploy/field-report-20261105-six-issues.md 「화면 설계」 U1).
// 서버가 /api/agents 행마다 oom(이 사람이 닫지 않은 안내)을 준다 — 판정(OOMKilled·7일·한도를 늘리지 않음)은 서버 agents.oom_notice.
//   목록: 상태 칸 Pill warn 「메모리 초과로 재시작」(D3). 서랍: Alert warning 세 줄 + 요청 단추(사용자)·크기 바꾸기(관리자) + [닫기](D4·D8·D21).
import { Alert, Box, Button, Stack, Typography } from '@mui/material';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { Pill } from '@/components/DataGrid';
import { RequestAdminButton } from '@/features/requests/RequestAdminButton';
import { t } from '@/i18n';
import { post } from '@/lib/api';
import { fmtTs } from '@/lib/format';

export interface OomNotice {
  id: string;
  finished_at: string;
  limit_memory: string;
}

export function OomPill() {
  return <Pill tone="warn">{t('agents.oomPill')}</Pill>;
}

/** 서랍 맨 위의 경고 상자. admin 이면 요청 대신 같은 서랍의 크기 구역으로 보낸다(D20: 단추 이름에 작업공간 이름) */
export function OomAlert({ pod, label, oom, admin, onSize }: { pod: string; label: string; oom: OomNotice; admin: boolean; onSize?: () => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const close = async () => {
    setBusy(true);
    try {
      await post('/api/office/inbox/answer', { id: oom.id, choice: 'ack' });
      await Promise.all([qc.invalidateQueries({ queryKey: ['hermes-agents'] }), qc.invalidateQueries({ queryKey: ['office-inbox'] })]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Alert severity="warning" sx={{ mb: 2 }} role="status">
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {t('agents.oomLine1', { limit: oom.limit_memory || '?', at: fmtTs(oom.finished_at) })}
      </Typography>
      <Typography variant="body2">{t('agents.oomLine2')}</Typography>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mt: 1 }} alignItems={{ xs: 'stretch', sm: 'center' }}>
        {admin ? (
          <Button size="small" variant="outlined" onClick={onSize} sx={{ minHeight: 44 }}>
            {t('agents.oomSizeLink')}
          </Button>
        ) : (
          <Box>
            <RequestAdminButton
              profile="_workspace"
              pod={pod}
              kind="workspace_size"
              label={t('requests.askSize')}
              ariaLabel={t('requests.askSizeFor', { name: label })}
              detail={t('requests.sizeDetail', { at: fmtTs(oom.finished_at), limit: oom.limit_memory || '?' })}
            />
          </Box>
        )}
        <Button size="small" onClick={() => void close()} disabled={busy} sx={{ minHeight: 44 }} aria-label={t('agents.oomClose')}>
          {t('common.close')}
        </Button>
      </Stack>
    </Alert>
  );
}
