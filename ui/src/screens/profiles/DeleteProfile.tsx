/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 프로파일 삭제 확인 창. 프로파일 상세 머리의 「삭제」 단추(대화 상자)와 마켓 「설치된 곳」의 에이전트 줄(서랍)이 함께 연다(OMAI-1126 디자인 결정 11A).
// 주인은 마켓 에이전트 패키지로 만든 프로파일만 지우고, 묶음 파일은 관리자만 꺼내므로 내보내기를 건너뛰지 못한다(12A).
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { Alert, Box, Button, Checkbox, FormControlLabel, Stack, TextField, Typography } from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { ScreenLoading } from '@/components/bits';
import { useUi } from '@/components/UiContext';
import { t } from '@/i18n';
import { ApiError } from '@/lib/api';
import { MONO_FONT } from '@/lib/monoFont';
import { useFocusOnMount } from '@/lib/useFocusOnMount';

import { profileQuery, useProfileAct } from './shared';
import { useProfileSpot } from './spot';
import type { ProfileDetailData } from './types';
/** 지우기를 막은 대화(서버 busy_sessions, 디자인 5C). 제목은 서버가 앞 40자로 자른다 */
interface BusySession {
  title?: string;
  kind?: 'chat' | 'relay';
}

const BUSY_SHOWN = 3;

function BusySessionsAlert({ sessions }: { sessions: BusySession[] }) {
  const shown = sessions.slice(0, BUSY_SHOWN);
  const more = sessions.length - shown.length;
  return (
    <Alert severity="warning" data-testid="delete-busy">
      <Typography variant="body2">{t('profiles.deleteBusy', { count: sessions.length })}</Typography>
      {shown.length > 0 && (
        <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 2.5 }}>
          {shown.map((x, i) => (
            <li key={i}>{x.kind === 'relay' ? t('profiles.deleteBusyRelay') : x.title?.trim() || t('profiles.deleteBusyUntitled')}</li>
          ))}
          {more > 0 && <li>{t('profiles.deleteBusyMore', { count: more })}</li>}
        </Box>
      )}
    </Alert>
  );
}

/** 지울 수 있는가. 옛 서버는 can_delete 를 보내지 않으므로 관리자 판정(can_edit)과 기본 프로파일로 가린다 */
export const canDelete = (d: ProfileDetailData) => !d.profile.is_default && (d.can_delete ?? d.can_edit);

/** 이름 바꾸기·삭제가 가져오기 진행 중이라 409 busy_import 로 거절되면 화면 문장으로(OMAI-1444 DD7) */
export const busyImportText = (e: unknown): string =>
  (e as { reason?: string }).reason === 'busy_import' ? t('profiles.pcImport.busyAction') : (e as Error).message;

export function ArchiveNote({ lead, path }: { lead: string; path: string }) {
  return (
    <>
      <Typography>{lead}</Typography>
      <Box component="pre" sx={{ fontFamily: MONO_FONT, whiteSpace: 'pre-wrap' }}>
        {path}
      </Box>
    </>
  );
}

function AfterDelete({ archive, owner, market }: { archive?: string; owner: boolean; market?: string }) {
  const { closeDrawer } = useUi();
  return (
    <Stack spacing={1.5}>
      {archive && <ArchiveNote lead={t('profiles.deleteArchiveLead')} path={archive} />}
      {owner && <Typography color="text.secondary">{t('profiles.deleteOwnerArchive')}</Typography>}
      {market && (
        <Box>
          <Button
            variant="outlined"
            component={Link}
            to={`/market?q=${encodeURIComponent(market.split('/').pop() ?? market)}`}
            onClick={closeDrawer}
          >
            {t('profiles.reinstallFromMarket')}
          </Button>
        </Box>
      )}
    </Stack>
  );
}

/** 마켓에서 열면 상세를 아직 받지 않았을 수 있다 — 받은 뒤에 폼을 그려야 이름 칸에 초점이 간다(디자인 결정 15A) */
export function DeleteBody({ name, bundle, onDone }: { name: string; /** 확인 단계의 PC 가져오기 묶음 파일 이름(함께 취소된다, OMAI-1444 DD7) */ bundle?: string; onDone?: () => void }) {
  const q = useQuery<ProfileDetailData>(profileQuery(name));
  if (!q.data) return <ScreenLoading title={name} error={q.error?.message} />;
  return <DeleteForm name={name} d={q.data} bundle={bundle} onDone={onDone} />;
}

function DeleteForm({ name, d, bundle, onDone }: { name: string; d: ProfileDetailData; bundle?: string; onDone?: () => void }) {
  const { act, refresh } = useProfileAct(name);
  const qc = useQueryClient();
  const { closeDrawer, openDrawer } = useUi();
  const { enqueueSnackbar } = useSnackbar();
  const spot = useProfileSpot();
  const [typed, setTyped] = useState('');
  const first = useFocusOnMount<HTMLInputElement>();
  const [skip, setSkip] = useState(false);
  const [showSkip, setShowSkip] = useState(false);
  const [error, setError] = useState('');
  const [busySessions, setBusySessions] = useState<BusySession[] | null>(null);
  const [busy, setBusy] = useState(false);
  const owner = !d.can_edit;
  const openChats = d.open_chats ?? 0;
  const go = async () => {
    setBusy(true);
    setError('');
    setBusySessions(null);
    try {
      const r = await act<{ archive?: string; market_package?: string }>('delete', { confirm: typed, skip_export: skip });
      (onDone ?? closeDrawer)(); // 프로파일 상세 머리의 대화 상자에서 열었으면 대화 상자만 닫는다(상세 서랍은 name=null 로 닫힌다)
      enqueueSnackbar(t('profiles.deleted', { name }), { variant: 'success' });
      spot.patch({ name: null, pane: null });
      void refresh();
      void qc.invalidateQueries({ queryKey: ['market'] });          // 설치 기록이 프로파일을 따라 내려간다
      if (r.archive || r.market_package)
        openDrawer({
          title: t('profiles.deleted', { name }),
          sub: name,
          body: <AfterDelete archive={r.archive} owner={owner} market={r.market_package} />,
        });
    } catch (e) {
      // 답하는 중·뒤에서 일하는 대화가 남았다(디자인 5C) — 목록으로 보인다. 닫기가 시간 안에 끝나지 않으면 지우지 않았다(3D)
      const reason = (e as { reason?: string }).reason;
      const data = e instanceof ApiError ? e.data : {};
      if (reason === 'busy_sessions') {
        setBusySessions(Array.isArray(data.sessions) ? (data.sessions as BusySession[]) : []);
        setBusy(false);
        return;
      }
      const msg = reason === 'close_failed' ? t('profiles.deleteCloseFailed') : busyImportText(e);
      setError(msg);
      // 문장은 언어마다 달라지므로 서버가 보내는 reason 코드로 가린다. 주인은 내보내기를 건너뛰지 못한다(서버도 무시한다)
      if ((e as { reason?: string }).reason === 'export_failed' && !owner) setShowSkip(true);
      setBusy(false);
    }
  };
  return (
    <Stack spacing={1.5}>
      <Alert severity="error">
        {t('profiles.deleteWarning', { name, count: d.profile.jobs_total })}
        {d.places && d.places.seats > 0 && ' ' + t('profiles.deletePlaces', { seats: d.places.seats, rooms: d.places.rooms })}
        {!!d.places?.channels && ' ' + t('profiles.deleteChannels', { count: d.places.channels })}
        {openChats > 0 && ' ' + t('profiles.deleteOpenChats', { count: openChats })}
      </Alert>
      <Typography>
        {t('profiles.deleteExportFirst')}
        {owner && ' ' + t('profiles.deleteOwnerArchive')}
      </Typography>
      {bundle && <Typography variant="body2">{t('profiles.pcImport.cancelsBundle', { file: bundle })}</Typography>}
      <TextField
        size="small"
        inputRef={first}
        label={t('profiles.deleteTypeName', { name })}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        placeholder={name}
        slotProps={{ htmlInput: { 'aria-label': t('profiles.confirmNameLabel'), spellCheck: false } }}
      />
      {error && <Alert severity="error">{error}</Alert>}
      {busySessions && <BusySessionsAlert sessions={busySessions} />}
      {busy && (openChats > 0 || !skip) && (
        // 서버 순서: 내보내기 → 열린 대화 닫기 → 지우기. 내보내기는 먼 워커에서 1분을 넘기도 해(2026-11-07-001 §6) 그 동안에도 무엇을 하는지 보인다
        <Typography variant="body2" color="text.secondary" role="status">
          {t(skip ? 'profiles.deleteClosingChats' : openChats > 0 ? 'profiles.deleteExportingClosingChats' : 'profiles.deleteExporting')}
        </Typography>
      )}
      {showSkip && (
        <FormControlLabel
          control={<Checkbox checked={skip} onChange={(e) => setSkip(e.target.checked)} />}
          label={t('profiles.deleteSkipExport')}
        />
      )}
      <Box>
        <Button startIcon={<DeleteOutlineIcon />} color="error" variant="contained" disabled={typed !== name || busy} onClick={go}>
          {t('profiles.deleteForever')}
        </Button>
      </Box>
    </Stack>
  );
}
