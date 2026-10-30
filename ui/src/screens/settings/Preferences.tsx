/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 설정 › 일반: 사용자가 자기 화면 환경(언어·표의 행 수·날짜 시간대·오피스 배경음악·테마)을 고른다. COP Console 「일반 설정」과 같은 짜임.
// 모두 이 브라우저에만 기억한다(언어·테마·행 수는 머리 막대·표 아래 고르기와 같은 값). 스펙 2026-10-14-013.
import StopCircleOutlinedIcon from '@mui/icons-material/StopCircleOutlined';
import VolumeUpOutlinedIcon from '@mui/icons-material/VolumeUpOutlined';
import { Autocomplete, Box, Button, ButtonBase, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { DataTable, Section } from '@/components/bits';
import { useReadSnap } from '@/components/chat/ReadAloud';
import { pickVoice, readAloud, readVoicePref, saveVoicePref, subscribeVoicePref, TtsVoice, voiceName } from '@/components/chat/readAloudPlayer';
import { loadRowsPerPage, PAGE_SIZES, saveRowsPerPage } from '@/components/DataGrid';
import { useI18n } from '@/components/I18n';
import { PageTitle } from '@/components/PageTitle';
import { useThemeMode } from '@/components/ThemeMode';
import { saveTrack, useTrack } from '@/features/office/ambient';
import { TrackLabel } from '@/features/office/audio/TrackPicker';
import { trackById, TRACKS } from '@/features/office/audio/tracks';
import { Lang, LANGS, t } from '@/i18n';
import { get } from '@/lib/api';
import { browserTimeZone, formatInZone, setStoredTimeZone, storedTimeZone, timeZones, zoneLabel } from '@/lib/prefs';
import { contentBackground, shellColors } from '@/lib/shellTokens';
import { ThemeMode } from '@/theme';

const BROWSER = '';

const genderLabel = (g?: string) => (g === 'female' ? t('read.female') : g === 'male' ? t('read.male') : g ?? '');
const voiceLabel = (v: TtsVoice) => [voiceName(v), genderLabel(v.gender)].filter(Boolean).join(' · ');

/** 「읽어 주기 목소리」 줄(스펙 2026-10-28-012 DD19): 목록은 GET /api/tts/voices, 미리 듣기는 POST /api/tts/preview(에이전트가 없어도 된다, R11).
 *  목록을 받기 전·실패·tts 꺼짐이면 그리지 않는다. 고른 값은 이 브라우저에 저장하고, 고르지 않았으면 첫 목소리다.
 *  키보드로 목록을 옮길 때 자동으로 소리 내지 않는다 — 미리 듣기는 단추로만 */
function useVoiceRow(): React.ReactNode[] | null {
  const q = useQuery<{ tts?: boolean; voices?: TtsVoice[] }>({ queryKey: ['tts-voices'], queryFn: () => get('/api/tts/voices') });
  useSyncExternalStore(subscribeVoicePref, readVoicePref);
  const rs = useReadSnap();
  useEffect(() => () => void (readAloud.snap.preview && readAloud.stop()), []); // 화면을 옮기면 미리 듣기를 멈춘다
  const voices = q.data?.voices ?? [];
  if (q.data?.tts !== true || !voices.length) return null;
  const value = pickVoice(voices);
  const playing = !!value && rs.preview === value;
  return [
    t('read.voice'),
    <Stack key="tts" data-guide="prefs.voice" direction="row" spacing={1} alignItems="flex-start" sx={{ width: 380, maxWidth: '100%' }}>
      <TextField
        select
        size="small"
        variant="outlined"
        value={value}
        onChange={(e) => saveVoicePref(e.target.value)}
        helperText={t('read.voiceHelp')}
        sx={{ flex: 1, minWidth: 0 }}
        inputProps={{ 'aria-label': t('read.voice') }}
      >
        {voices.map((v) => (
          <MenuItem key={v.id} value={v.id}>
            {voiceLabel(v)}
          </MenuItem>
        ))}
      </TextField>
      <Button
        variant="outlined"
        size="small"
        color="inherit"
        startIcon={playing ? <StopCircleOutlinedIcon /> : <VolumeUpOutlinedIcon />}
        aria-label={playing ? t('read.previewStop') : t('read.preview')}
        onClick={() => void readAloud.preview(value)}
        sx={{ flex: '0 0 auto', mt: 0.25, whiteSpace: 'nowrap' }}
      >
        {t('read.preview')}
      </Button>
    </Stack>,
  ];
}

/** 테마 카드의 작은 미리보기: 셸(머리 막대·좌측 메뉴)은 두 판 모두 어둡고, 본문만 테마를 따른다 */
function ThemePreview({ mode }: { mode: ThemeMode }) {
  const bg = contentBackground[mode];
  const block = mode === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  return (
    <Box aria-hidden sx={{ width: 120, height: 84, display: 'grid', gridTemplateRows: '12px 1fr', border: 1, borderColor: 'divider', borderRadius: 0.5, overflow: 'hidden' }}>
      <Box sx={{ bgcolor: shellColors.shellBg, borderBottom: `1px solid ${shellColors.shellBorder}` }} />
      <Box sx={{ display: 'grid', gridTemplateColumns: '34px 1fr' }}>
        <Box sx={{ bgcolor: shellColors.shellBg, p: '6px 5px', display: 'grid', alignContent: 'start', gap: '4px' }}>
          <Box sx={{ height: 3, bgcolor: shellColors.menuActiveAccent, width: 14 }} />
          <Box sx={{ height: 3, bgcolor: 'rgba(255,255,255,0.18)' }} />
          <Box sx={{ height: 3, bgcolor: 'rgba(255,255,255,0.18)' }} />
        </Box>
        <Box sx={{ bgcolor: bg.default, p: '6px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px', alignContent: 'start' }}>
          <Box sx={{ height: 18, bgcolor: bg.surface, border: `1px solid ${block}` }} />
          <Box sx={{ height: 18, bgcolor: bg.surface, border: `1px solid ${block}` }} />
        </Box>
      </Box>
    </Box>
  );
}

function ThemeCard({ mode, selected, onPick }: { mode: ThemeMode; selected: boolean; onPick: () => void }) {
  return (
    <ButtonBase
      role="radio"
      aria-checked={selected}
      onClick={onPick}
      data-testid={`theme-${mode}`}
      sx={{
        flexDirection: 'column',
        gap: 1,
        px: 4,
        py: 1.5,
        borderRadius: 1,
        border: selected ? 2 : 1,
        borderColor: selected ? 'text.primary' : 'divider',
        m: selected ? 0 : '1px',
        '&.Mui-focusVisible': { outline: 2, outlineColor: 'primary.main', outlineOffset: 2 },
      }}
    >
      <ThemePreview mode={mode} />
      <Typography variant="body2">{mode === 'dark' ? t('prefs.themeDark') : t('prefs.themeLight')}</Typography>
    </ButtonBase>
  );
}

export function Preferences() {
  const { lang, setLang } = useI18n();
  const { mode, setMode } = useThemeMode();
  const [rows, setRows] = useState(loadRowsPerPage);
  const [zone, setZone] = useState(storedTimeZone);
  const track = useTrack();
  const zones = useMemo(() => [BROWSER, ...timeZones()], []);
  const labels = useMemo(() => new Map(zones.map((z) => [z, z ? zoneLabel(z) : t('prefs.timeZoneBrowser', { zone: zoneLabel(browserTimeZone()) })])), [zones]);
  const now = formatInZone(new Date(), zone || browserTimeZone());
  const voiceRow = useVoiceRow();

  const field = { size: 'small' as const, variant: 'outlined' as const };
  const table = [
    [
      t('prefs.language'),
      <TextField key="lang" select data-guide="prefs.language" {...field} value={lang} onChange={(e) => setLang(e.target.value as Lang)} sx={{ minWidth: 140 }} inputProps={{ 'aria-label': t('prefs.language') }}>
        {LANGS.map((l) => (
          <MenuItem key={l} value={l}>
            {t(`lang.${l}`)}
          </MenuItem>
        ))}
      </TextField>,
    ],
    [
      t('prefs.rows'),
      <TextField
        key="rows"
        select
        {...field}
        value={rows}
        onChange={(e) => {
          const n = Number(e.target.value);
          setRows(n);
          saveRowsPerPage(n);
        }}
        sx={{ minWidth: 100 }}
        inputProps={{ 'aria-label': t('prefs.rows') }}
      >
        {PAGE_SIZES.map((n) => (
          <MenuItem key={n} value={n}>
            {n}
          </MenuItem>
        ))}
      </TextField>,
    ],
    [
      t('prefs.timeZone'),
      <Autocomplete
        key="tz"
        size="small"
        disableClearable
        options={zones}
        value={zone}
        getOptionLabel={(z) => labels.get(z) ?? z}
        onChange={(_, z) => {
          setStoredTimeZone(z);
          setZone(storedTimeZone());
        }}
        sx={{ width: 380, maxWidth: '100%' }}
        renderInput={(params) => <TextField {...params} inputProps={{ ...params.inputProps, 'aria-label': t('prefs.timeZone') }} helperText={t('prefs.timeZoneHelp', { now })} />}
      />,
    ],
    [
      t('prefs.officeMusic'),
      // 곡만 저장하고 배경음을 켜지 않는다(스펙 2026-10-21-014 D5). 오피스 하단 ♫ 메뉴와 같은 값이다.
      // Select 는 묶음 제목(ListSubheader)도 선택지로 만들어, 분위기는 곡 줄 둘째 줄에 붙인다(TrackLabel withMood)
      <TextField
        key="music"
        select
        {...field}
        value={track}
        onChange={(e) => saveTrack(e.target.value)}
        helperText={t('prefs.officeMusicHelp')}
        sx={{ width: 380, maxWidth: '100%' }}
        SelectProps={{ renderValue: (id) => trackById(id as string).title }}
        inputProps={{ 'aria-label': t('prefs.officeMusic') }}
      >
        {TRACKS.map((x) => (
          <MenuItem key={x.id} value={x.id}>
            <TrackLabel track={x} withMood />
          </MenuItem>
        ))}
      </TextField>,
    ],
    // 「오피스 배경음악」 다음 줄(DD19)
    ...(voiceRow ? [voiceRow] : []),
  ];

  return (
    <Box sx={{ maxWidth: 960 }}>
      <PageTitle>{t('views.preferences.label')}</PageTitle>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        {t('prefs.localOnly')}
      </Typography>
      <Box sx={{ '& td:first-of-type': { width: '40%', verticalAlign: 'top', pt: 1.75 } }}>
        <DataTable columns={[{ label: t('prefs.colName') }, { label: t('prefs.colValue') }]} rows={table} />
      </Box>
      <Section title={t('prefs.theme')} guide="prefs.theme" indent>
        <Stack direction="row" spacing={2} role="radiogroup" aria-label={t('prefs.theme')} sx={{ flexWrap: 'wrap' }}>
          {(['light', 'dark'] as ThemeMode[]).map((m) => (
            <ThemeCard key={m} mode={m} selected={mode === m} onPick={() => setMode(m)} />
          ))}
        </Stack>
      </Section>
    </Box>
  );
}
