/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 지금 AI 에이전트 작업공간이 다시 뜨는 중이라는 띠(스펙 2026-10-23-006). 서버는 그동안 다른 작업공간으로 넘기지 않고(/api/me 의 pod.restarting),
// 그 작업공간의 목록·대화는 잠시 읽지 못할 수 있다. useMe 가 5초마다 다시 읽어 끝나면 띠가 저절로 사라진다.
import { Alert } from '@mui/material';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { t } from '@/i18n';
import type { Me } from '@/lib/data';

import { denseAlertSx } from './WsStatus';

export function PodRestarting({ pod }: { pod: Me['pod'] | undefined }) {
  const qc = useQueryClient();
  const restarting = !!pod?.restarting;
  // 다시 뜨는 중으로 바뀌면 열린 프로파일 서랍을 다시 읽는다. 서랍은 읽지 못한 것이 없으면 스스로 다시 읽지 않아
  // 「다시 시작하는 중」 안내가 나오지 않았다(스펙 2026-10-23-008)
  useEffect(() => {
    if (restarting) void qc.invalidateQueries({ queryKey: ['profile'] });
  }, [restarting, qc]);
  if (!restarting) return null;
  return (
    <Alert severity="info" role="status" sx={denseAlertSx}>
      {/* 롤아웃이 새 버전으로 바꾸는 중이면 왜·얼마나·무엇이 남는지 말한다(스펙 2026-10-28-015 DD13) */}
      {pod.restart_reason === 'update' ? t('rollout.userUpdating') : t('shell.podRestarting', { name: pod.name || pod.id })}
    </Alert>
  );
}
