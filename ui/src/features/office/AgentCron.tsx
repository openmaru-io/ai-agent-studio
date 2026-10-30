/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 에이전트 서랍의 크론(계획 007 P4): 다음 실행·마지막 결과와 지금 실행. 오피스 크론 API(/api/office/cron/<자리>/*)를 쓴다 —
// 권한은 서버가 정한다(거절되면 사유를 그대로 보인다).
import PlayArrowOutlinedIcon from '@mui/icons-material/PlayArrowOutlined';
import { Alert, Box, Button, Skeleton, Stack, Typography } from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';

import { useConfirm } from '@/components/ConfirmDialog';
import { DisclosureButton } from '@/components/DisclosureButton';
import { t } from '@/i18n';
import { get, post } from '@/lib/api';
import { fmtTs } from '@/lib/format';
import { NewJobBody } from '@/screens/cron/NewJob';

interface Job {
  id: string;
  name: string;
  state: string;
  next_run_at?: string | null;
  last_run_at?: string | null;
  last_status?: string | null;
  schedule_display?: string;
}

export function AgentCron({
  alias,
  canAct,
  createProfile,
}: {
  alias: string;
  canAct: boolean;
  /** 만들 수 있는 사람(주인·관리자)에게만 그 에이전트의 프로파일 이름. 있으면 「새 크론」을 보인다(스펙 2026-10-15-003 R1) */
  createProfile?: string;
}) {
  const url = `/api/office/cron/${encodeURIComponent(alias)}/jobs`;
  const q = useQuery<{ jobs: Job[] }>({ queryKey: ['office-cron', alias], queryFn: () => get(url), retry: false });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const qc = useQueryClient();
  const confirm = useConfirm();
  // 「새 예약 작업」은 접고 펼치는 단추다(스펙 2026-10-19-005 R9). 입력 칸은 단추 아래 한 자리(V4), 만든 뒤 포커스는 단추로(G8)
  const regionId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const focusToggle = useRef(false);
  useEffect(() => {
    if (focusToggle.current && !adding) {
      focusToggle.current = false;
      toggleRef.current?.focus();
    }
  });
  if (q.isLoading) return <Skeleton height={40} />;
  if (q.error) return <Alert severity="error">{(q.error as Error).message}</Alert>;
  const jobs = q.data?.jobs ?? [];
  const toggle = createProfile && (
    <DisclosureButton
      ref={toggleRef}
      open={adding}
      onToggle={() => setAdding((v) => !v)}
      controls={regionId}
      color="primary"
      label={t(adding ? 'profiles.cronNewClose' : 'profiles.cronNew')}
    />
  );
  const region = createProfile && adding && (
    <Box id={regionId}>
      <NewJobBody
        profiles={[createProfile]}
        fixedProfile={createProfile}
        officeAlias={alias}
        onDone={async () => {
          // 목록을 다시 읽은 뒤 접는다. 먼저 접으면 빈 상태 줄 단추에 포커스가 갔다가 목록이 바뀌며 단추가 다시 만들어져 포커스를 잃는다(V3)
          await qc.invalidateQueries({ queryKey: ['office-cron', alias] });
          focusToggle.current = true;
          setAdding(false);
        }}
      />
    </Box>
  );
  if (!jobs.length)
    return (
      <Stack spacing={1}>
        {/* 작업이 없으면 안내 글과 단추를 한 줄에(G2). 만들 권한이 없으면 글만(V10) */}
        <Stack direction="row" alignItems="center" spacing={1} useFlexGap flexWrap="wrap">
          <Typography variant="body2" color="text.secondary">
            {t('office.noCron')}
          </Typography>
          {toggle}
        </Stack>
        {region}
      </Stack>
    );
  // 지금 실행하면 에이전트가 일을 하고 결과를 보내므로 확인한다(OMAI-1135)
  const run = async (j: Job) =>
    (await confirm(t('office.cronRunConfirm', { name: j.name || j.id }))) &&
    post(`${url}/${encodeURIComponent(j.id)}/run`, {})
      .then(() => setMsg({ ok: true, text: t('office.cronStarted', { name: j.name || j.id }) }))
      .catch((e: Error) => setMsg({ ok: false, text: e.message }));
  return (
    <Stack spacing={1}>
      {toggle && <Box>{toggle}</Box>}
      {region}
      {jobs.slice(0, 10).map((j) => (
        <Box key={j.id} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="body2" noWrap>
              {j.name || j.id}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {t('office.cronNext', { at: j.next_run_at ? fmtTs(j.next_run_at) : '—' })} ·{' '}
              {t('office.cronLast', { status: j.last_status || '—' })}
            </Typography>
          </Box>
          {canAct && j.state !== 'paused' && (
            <Button startIcon={<PlayArrowOutlinedIcon />} size="small" variant="outlined" onClick={() => void run(j)}>
              {t('office.cronRunNow')}
            </Button>
          )}
        </Box>
      ))}
      {msg && <Alert severity={msg.ok ? 'success' : 'error'}>{msg.text}</Alert>}
    </Stack>
  );
}
