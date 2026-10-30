/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 프로파일 › 작업 지침(AGENTS.md) 탭 위의 안내들(스펙 2026-10-19-004 §4-4 10~19, §9, §10 D19·D20).
// 배치 순서는 고정이다(D3): ① 편집을 막는 사유 하나 ② 에이전트 변경·출처 모름 배너 ③ 임시 저장 이어 쓰기(편집기 안) ④ 본문.
// 경고색은 MUI 기본 Alert warning 을 그대로 쓴다(D11).
import MoreVertIcon from '@mui/icons-material/MoreVert';
import { Alert, Box, Button, IconButton, Menu, MenuItem, Stack, Typography, useMediaQuery, useTheme } from '@mui/material';
import { useSnackbar } from 'notistack';
import { useId, useState } from 'react';

import { useConfirm } from '@/components/ConfirmDialog';
import { DisclosureButton } from '@/components/DisclosureButton';
import { DiffView } from '@/components/TextEditor';
import { t } from '@/i18n';
import { get } from '@/lib/api';
import { fmtTs } from '@/lib/format';
import type { LineDiff } from '@/lib/mdtools';
import { versionApi } from '@/lib/textApi';

import type { AgentsDoc, AgentsReadonlyReason } from './types';

/** 읽기 전용 사유 → 문구. 숨긴 루트·보기 권한·가림은 다른 탭과 같은 문구를 쓴다(D5) */
export function agentsWhy(reason: AgentsReadonlyReason): string {
  switch (reason) {
    case 'masked':
      return t('profiles.maskedNoEdit');
    case 'hidden_root':
      return t('profiles.why.hidden_root');
    case 'view_only':
      return t('profiles.ownerOrAdminEdit');
    default:
      return t(`profiles.agents.why.${reason}` as Parameters<typeof t>[0]);
  }
}

/** 읽기 오류: 본문 없이 오류와 「다시 읽기」. 서랍 위 d.notes 에도 서버가 한 줄 넣는다(D15) */
export function AgentsReadError({ onReload }: { onReload: () => unknown }) {
  return (
    <Alert
      severity="warning"
      role="alert"
      sx={{ mb: 1 }}
      action={
        <Button color="inherit" size="small" onClick={() => void onReload()}>
          {t('profiles.agents.reload')}
        </Button>
      }
    >
      {t('profiles.agents.why.read_error')}
    </Alert>
  );
}

/** 빈 상태: 파일이 없거나 공백만 있을 때. 「예시로 시작」은 편집기에만 채우고 바로 저장하지 않는다(D10) */
export function AgentsEmpty({ exists, onExample }: { exists: boolean; onExample?: () => void }) {
  return (
    <Box sx={{ mb: 1.5 }} data-agents-empty="">
      <Typography variant="body2">{t('profiles.agents.empty1')}</Typography>
      <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap" sx={{ mt: 0.5 }}>
        {!exists && (
          <Typography variant="body2" color="text.secondary">
            {t('profiles.agents.empty2')}
          </Typography>
        )}
        {onExample && (
          <Button size="small" variant="outlined" onClick={onExample}>
            {t('profiles.agents.startExample')}
          </Button>
        )}
      </Stack>
    </Box>
  );
}

/**
 * 에이전트 변경 배너(D7·D19)와 출처 모름 배너(D8). 둘 다 해당하면 한 배너에 두 문장.
 * canAck: 「확인함」을 보낼 수 있다(주인·관리자). canRevert: 되돌리기 저장을 할 수 있다(권한 + 파일이 쓸 수 있는 상태).
 * 600px 미만이면 단추를 문장 아래 줄에 두고 「바뀐 줄 보기」만 남기며 나머지는 ⋮ 메뉴(D12). 단추는 본문보다 Tab 순서가 앞이다(D13).
 */
export function AgentsBanner({
  name,
  doc,
  canAck,
  canRevert,
  act,
  refresh,
}: {
  name: string;
  doc: AgentsDoc;
  canAck: boolean;
  canRevert: boolean;
  act: <T = unknown>(action: string, extra?: Record<string, unknown>) => Promise<T>;
  refresh: () => Promise<unknown>;
}) {
  // 「확인함」·「되돌리기」가 성공하면 상세를 다시 읽기(2~5초) 전에 그 변경의 배너를 바로 숨긴다(OKE 확인 2026-10-19).
  // 다시 읽은 뒤 서버가 새 변경을 주면 id 가 달라 다시 보인다
  const [settled, setSettled] = useState<number | null>(null);
  const change = doc.agent_change && doc.agent_change.id !== settled ? doc.agent_change : null;
  const narrow = useMediaQuery(useTheme().breakpoints.down('sm'));
  const confirm = useConfirm();
  const { enqueueSnackbar } = useSnackbar();
  const menuId = useId();
  const diffId = useId();
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [diff, setDiff] = useState<{ id: number; d: LineDiff } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!change && !doc.never_saved) return null;

  const fail = async (e: unknown) => {
    enqueueSnackbar((e as Error).message, { variant: 'error' });
    await refresh(); // 409(그사이 다른 판이 생김)면 새 상태를 받아 배너를 맞춘다
  };
  const toggleDiff = async () => {
    if (!change || change.compare_id == null) return;
    if (diff) {
      setDiff(null);
      return;
    }
    try {
      const d = await get<LineDiff>(
        `/api/profile/soul/diff?name=${encodeURIComponent(name)}&id=${change.compare_id}&kind=agents`
      );
      setDiff({ id: change.compare_id, d });
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
    }
  };
  const revert = async () => {
    setMenu(null);
    if (!change || change.revert_id == null) return;
    const id = change.revert_id;
    // 되돌릴 판이 한도를 넘으면 확인 창에도 크기 경고를 붙인다(L2). 판 목록을 못 읽으면 경고 없이 묻는다
    let warn = '';
    try {
      const v = (await versionApi(`agents:${name}`).versions()).find((x) => x.id === id);
      const max = doc.limit ?? 20000;
      if (v && v.size > max) warn = ' ' + t('profiles.agents.sizeWarn', { n: v.size, max });
    } catch {
      /* 경고만 빠진다 */
    }
    const msg = t(change.deleted ? 'profiles.agents.confirmRecreate' : 'profiles.agents.confirmRevert', { id }) + warn;
    if (!(await confirm(msg))) return;
    setBusy(true);
    try {
      await act('agents_revert', { id, base_sha: doc.sha });
      setSettled(change.id);
      enqueueSnackbar(t('profiles.agents.reverted', { id }), { variant: 'success' });
      setDiff(null);
      await refresh();
    } catch (e) {
      await fail(e);
    } finally {
      setBusy(false);
    }
  };
  const ack = async () => {
    setMenu(null);
    if (!change) return;
    setBusy(true);
    try {
      await act('agents_ack', { version_id: change.id });
      setSettled(change.id);
      enqueueSnackbar(t('profiles.agents.acked'), { variant: 'success' });
      await refresh();
    } catch (e) {
      await fail(e);
    } finally {
      setBusy(false);
    }
  };

  const showRevert = !!change && canRevert && change.revert_id != null;
  const showAck = !!change && canAck;
  const btnSx = narrow ? { minHeight: 44 } : undefined; // 좁은 화면은 누르는 영역 44px 이상(D12)
  const diffBtn = change && change.compare_id != null && (
    // 접고 펼치는 공통 단추(스펙 2026-10-19-005 E11). 좁은 화면 44 는 그대로 넘긴다
    <DisclosureButton
      open={!!diff}
      onToggle={() => void toggleDiff()}
      controls={diffId}
      sx={btnSx}
      label={diff ? t('profiles.agents.hideDiff') : t('profiles.agents.showDiff')}
    />
  );
  const wideButtons = (
    <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap" sx={{ mt: 0.5, ml: -0.5 }}>
      {diffBtn}
      {showRevert && (
        <Button color="inherit" size="small" disabled={busy} onClick={revert}>
          {t('profiles.agents.revertPrev')}
        </Button>
      )}
      {showAck && (
        <Button color="inherit" size="small" disabled={busy} onClick={ack}>
          {t('profiles.agents.ack')}
        </Button>
      )}
    </Stack>
  );
  const narrowButtons = (
    <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 0.5 }}>
      {diffBtn}
      {(showRevert || showAck) && (
        <>
          <IconButton
            size="small"
            aria-label={t('profiles.agents.more')}
            aria-haspopup="menu"
            aria-controls={menu ? menuId : undefined}
            aria-expanded={!!menu}
            disabled={busy}
            onClick={(e) => setMenu(e.currentTarget)}
            sx={{ minWidth: 44, minHeight: 44 }}
          >
            <MoreVertIcon fontSize="small" />
          </IconButton>
          <Menu id={menuId} anchorEl={menu} open={!!menu} onClose={() => setMenu(null)}>
            {showRevert && (
              <MenuItem sx={{ minHeight: 44 }} onClick={revert}>
                {t('profiles.agents.revertPrev')}
              </MenuItem>
            )}
            {showAck && (
              <MenuItem sx={{ minHeight: 44 }} onClick={ack}>
                {t('profiles.agents.ack')}
              </MenuItem>
            )}
          </Menu>
        </>
      )}
    </Stack>
  );

  return (
    <Box sx={{ mb: 1 }}>
      {/* 배너는 알림이 아니라 상태다(role=status, D13). 색만이 아니라 MUI 경고 아이콘과 문장을 함께 둔다 */}
      <Alert
        severity="warning"
        role="status"
        data-agents-banner=""
      >
        {/* 단추는 문장 아래 한 줄에 둔다. 오른쪽 action 자리에 두면 서랍 폭에서 「확인함」만 다음 줄로 넘어가 가운데 놓였다(OKE 확인 2026-10-19) */}
        {change && (
          <Box>
            {t(change.deleted ? 'profiles.agents.deleted' : 'profiles.agents.changed', { time: fmtTs(change.at) })}
          </Box>
        )}
        {doc.never_saved && <Box>{t('profiles.agents.neverSaved')}</Box>}
        {change && (narrow ? narrowButtons : wideButtons)}
      </Alert>
      {diff && (
        <Box id={diffId} sx={{ mt: 1 }}>
          <Typography variant="caption">
            {t('editor.diffVersionToNow', { id: diff.id, added: diff.d.added, removed: diff.d.removed })}
          </Typography>
          <DiffView d={diff.d} />
        </Box>
      )}
    </Box>
  );
}
