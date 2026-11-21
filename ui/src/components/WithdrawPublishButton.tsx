/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
/** 기다리는 게시 요청 거두기(이슈 #25, 스펙 2026-11-20-009 §3-2 6). 스킬 화면 게시 기록과 스킬 허브 요청 상세가 같이 쓴다. */
import { Button, CircularProgress } from '@mui/material';
import { useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useState } from 'react';

import { useConfirm } from '@/components/ConfirmDialog';
import { t } from '@/i18n';
import { post } from '@/lib/api';
import { type Me, useMe } from '@/lib/data';

export interface WithdrawableReq {
  id: string;
  name: string;
  version: string;
  status: string;
  who: string;
}

/** 서버가 요청자로 적는 이메일(소문자). 로그인이 꺼진 설치는 모두 'local' 이다. 아직 모르면 '' — 단추를 보이지 않는다 */
export const myPublishEmail = (me: Me | undefined): string =>
  (me?.user?.email ?? (me && !me.auth_enabled ? 'local' : '')).toLowerCase();

/** 거두기를 보일 요청: 기다리는 중이고 내가 보낸 것. 같은 프로파일·스킬이라도 남이 보낸 요청에는 보이지 않는다(서버도 403) */
export const canWithdraw = (r: Pick<WithdrawableReq, 'status' | 'who'>, mine: string): boolean =>
  r.status === 'requested' && !!mine && (r.who ?? '').toLowerCase() === mine;

export function WithdrawPublishButton({
  r,
  variant = 'text',
  onDone,
}: {
  r: WithdrawableReq;
  variant?: 'text' | 'outlined';
  onDone?: () => void;
}) {
  const me = useMe();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const [busy, setBusy] = useState(false);
  if (!canWithdraw(r, myPublishEmail(me.data))) return null;
  const go = async () => {
    const ok = await confirm(t('skills.withdrawBody', { name: r.name, version: r.version }), {
      title: t('skills.withdrawTitle'),
      confirmLabel: t('skills.withdraw'),
      cancelLabel: t('skills.withdrawKeep'),
      cancelFirst: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await post('/api/market/publish/withdraw', { id: r.id });
      enqueueSnackbar(t('skills.withdrawDone'), { variant: 'success' });
      onDone?.();
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' }); // 403·404·409(상태가 바뀜·busy): 서버 문장 그대로
    } finally {
      setBusy(false);
      await qc.invalidateQueries({ queryKey: ['market', 'publish'] }); // 성공·실패 모두 다시 읽어 상태가 바뀐 행에서 단추가 사라지게
    }
  };
  return (
    <Button
      size="small"
      variant={variant}
      color="inherit"
      disabled={busy}
      onClick={() => void go()}
      aria-label={t('skills.withdrawAria', { name: r.name, version: r.version })}
      startIcon={busy ? <CircularProgress size={12} color="inherit" aria-hidden /> : undefined}
      data-testid="publish-withdraw"
    >
      {t('skills.withdraw')}
    </Button>
  );
}
