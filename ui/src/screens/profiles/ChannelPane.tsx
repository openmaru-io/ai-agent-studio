/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 프로파일 서랍 「채널」 탭(스펙 2026-10-15-003 단계 3): Telegram·Discord·Slack·Mattermost(2026-10-19-008) 연결. 값은 저장할 때만 보내고 다시 보이지 않는다.
// 연결한 메신저만 카드로 보이고, 「+ 메신저 연결」 대화 상자에서 ① 메신저를 고르고 ② 값을 채운다(2026-10-18: 모든 메신저를 펼치면 너무 길다).
import AddIcon from '@mui/icons-material/Add';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined';
import NetworkCheckOutlinedIcon from '@mui/icons-material/NetworkCheckOutlined';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useId, useRef, useState } from 'react';

import { Section, Tag } from '@/components/bits';
import { useConfirm } from '@/components/ConfirmDialog';
import { ItemList, ItemRow } from '@/components/ItemRow';
import { t } from '@/i18n';
import { get } from '@/lib/api';

import { calmAlertSx, capWhy, mayManage, useProfileAct } from './shared';
import { useProfileSpot } from './spot';
import type { ProfileDetailData } from './types';

interface EnvVarInfo {
  key: string;
  required: boolean;
  is_set: boolean;
}
interface Platform {
  id: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  state?: string | null;
  error_message?: string;
  env_vars: EnvVarInfo[];
}
interface PairRow {
  platform: string;
  request_id: string;
  user_id: string;
  user_name: string;
}
interface ChannelsData {
  platforms: Platform[];
  pairing: { pending: PairRow[]; approved: PairRow[] } | null;
}
interface TestResult {
  test: { ok: boolean; state: string; message: string };
}

// 허용 사용자 칸 아래에 내 ID 를 찾는 방법을 보이는 채널(에어갭이라 링크 없이 글로만 안내한다)
const ID_HELP = ['telegram', 'discord', 'slack', 'mattermost'];
// 비밀값이 아니라 가리지 않는 칸: 메신저 서버 주소(Mattermost 의 MATTERMOST_URL)
const isPlain = (key: string) => key.endsWith('_ALLOWED_USERS') || key.endsWith('_URL');

const STATE: Record<string, [string, 'good' | 'warn' | 'bad' | undefined]> = {
  connected: ['profiles.chan.connected', 'good'],
  disabled: ['profiles.chan.off', undefined],
  not_configured: ['profiles.chan.needSetup', 'warn'],
  pending_restart: ['profiles.chan.pending', 'warn'],
  gateway_stopped: ['profiles.chan.gatewayStopped', 'warn'],
  startup_failed: ['profiles.chan.failed', 'bad'],
};

/** 연결 시험이 실패한 이유를 상태별 문장으로 풀어 쓴다(디자인 결정 2B). 모르는 상태는 서버가 준 문장을 그대로 보인다 */
function causeText(tr: TestResult['test']): string {
  const key = ({ startup_failed: 'failed', gateway_stopped: 'gatewayStopped', not_configured: 'needSetup', pending_restart: 'pending' } as Record<string, string>)[tr.state];
  const detail = tr.message || tr.state;
  return key ? t(`profiles.chan.cause.${key}`, { message: detail }) : detail;
}

function PlatformForm({ p, name, ok, pairing }: { p: Platform; name: string; ok: boolean; pairing: ChannelsData['pairing'] }) {
  const qc = useQueryClient();
  const { act } = useProfileAct(name);
  const { enqueueSnackbar } = useSnackbar();
  const confirm = useConfirm();
  // 보이는 변수: 필수 값과 허용 사용자만. 나머지는 「비밀값」 탭에서 다룬다
  const vars = p.env_vars.filter((v) => v.required || v.key.endsWith('_ALLOWED_USERS'));
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState('');
  const [errorField, setErrorField] = useState('');                   // 서버가 거절한 칸의 이름(그 칸 아래에 문구를 보이고 포커스를 옮긴다, 디자인 결정 2A)
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const allowKey = vars.find((v) => v.key.endsWith('_ALLOWED_USERS'));
  const allowSet = !!allowKey && (allowKey.is_set || !!values[allowKey.key]?.trim());
  const missing = vars.filter((v) => v.required && !v.is_set && !values[v.key]?.trim());
  const refresh = () => qc.invalidateQueries({ queryKey: ['channels-platforms', name] });
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setErrorField('');
    try {
      await fn();
    } catch (e) {
      const field = (e as { field?: string }).field ?? '';
      setError((e as Error).message);
      setErrorField(vars.some((v) => v.key === field) ? field : '');
      if (field) setTimeout(() => inputs.current[field]?.focus(), 0);
    } finally {
      setBusy(false);
    }
  };
  const approve = (r: PairRow) =>
    run(async () => {
      await act('pairing_approve', { platform: p.id, request_id: r.request_id });
      enqueueSnackbar(t('profiles.chan.approved', { platform: p.name || p.id }), { variant: 'success' });
      await refresh();
    });
  const save = async (enabled: boolean) => {
    // 허용 사용자가 비어 있으면 켜도 아무도 대화할 수 없다. 켜기 전에 한 번 알린다
    const nobody = enabled && !!allowKey && !allowSet && !(pairing?.approved ?? []).some((r) => r.platform === p.id);
    if (nobody && !(await confirm(t('profiles.chan.confirmEmpty')))) return;
    await saveNow(enabled);
  };
  const saveNow = (enabled: boolean) =>
    run(async () => {
      const env = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()));
      const res = await act<{ hot_served?: boolean }>('channel_save', { platform: p.id, enabled, env });
      setValues({});
      // 저장 → 반영 → 연결 시험을 한 흐름으로 진행한다(디자인 결정 2B). 끄기와 바로 반영되지 않는 환경은 시험하지 않는다
      if (!enabled) setResult({ ok: true, text: t('profiles.chan.savedOff') });
      else if (res.hot_served === false) setResult({ ok: false, text: t('profiles.chan.notHot') });
      else {
        try {
          const tr = (await act<TestResult>('channel_test', { platform: p.id })).test;
          setResult(tr.ok ? { ok: true, text: t('profiles.chan.savedOk') } : { ok: false, text: t('profiles.chan.savedFailed', { cause: causeText(tr) }) });
        } catch (e) {
          setResult({ ok: false, text: t('profiles.chan.savedFailed', { cause: (e as Error).message }) });
        }
      }
      await Promise.all([refresh(), qc.invalidateQueries({ queryKey: ['channels'] }), qc.invalidateQueries({ queryKey: ['profile', name] })]);
    });
  const test = () =>
    run(async () => {
      const res = await act<TestResult>('channel_test', { platform: p.id });
      setResult({ ok: res.test.ok, text: res.test.message || res.test.state });
      await refresh();
    });
  const [labelKey, tone] = STATE[p.state ?? ''] ?? ['', undefined];
  const mine = (rows: PairRow[]) => rows.filter((r) => r.platform === p.id);
  return (
    <Stack spacing={1.25}>
        <Stack direction="row" spacing={1} alignItems="center">
          <Tag tone={tone}>{labelKey ? t(labelKey) : p.state || '—'}</Tag>
          {p.error_message && (
            <Typography variant="caption" color="text.secondary">
              {p.error_message}
            </Typography>
          )}
        </Stack>
        {vars.map((v) => (
          <TextField
            key={v.key}
            size="small"
            type={isPlain(v.key) ? 'text' : 'password'}
            label={v.key}
            value={values[v.key] ?? ''}
            disabled={!ok || busy}
            onChange={(e) => setValues((s) => ({ ...s, [v.key]: e.target.value }))}
            placeholder={v.is_set ? t('profiles.chan.keepValue') : ''}
            error={errorField === v.key}
            helperText={
              errorField === v.key
                ? error
                : v.is_set
                ? t('profiles.chan.isSet')
                : v.key.endsWith('_ALLOWED_USERS') && ID_HELP.includes(p.id)
                  ? t(`profiles.chan.idHelp.${p.id}`)
                  : v.key.endsWith('_URL')
                  ? t('profiles.chan.serverUrlHelp')
                  : v.required
                    ? t('profiles.chan.required')
                    : undefined
            }
            inputRef={(el: HTMLInputElement | null) => {
              inputs.current[v.key] = el;
            }}
            slotProps={{ htmlInput: { spellCheck: false, autoComplete: 'off' }, formHelperText: errorField === v.key ? { role: 'alert' } : undefined }}
          />
        ))}
        {allowKey && !allowSet && <Alert severity="info" sx={calmAlertSx}>{t('profiles.chan.allowEmpty', { platform: p.name || p.id })}</Alert>}
        {allowKey && !allowSet && mine(pairing?.pending ?? []).length > 0 && (
          // 요청이 이미 와 있으면 칸 바로 아래에서 그 자리에서 허용한다
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            {mine(pairing?.pending ?? []).map((r) => (
              <Button key={r.request_id} size="small" variant="outlined" disabled={!ok || busy} onClick={() => void approve(r)}>
                {t('profiles.chan.approveNamed', { name: r.user_name || r.user_id })}
              </Button>
            ))}
          </Stack>
        )}
        <Stack direction="row" spacing={1}>
          <Button variant="contained" size="small" disabled={!ok || busy || missing.length > 0} onClick={() => void save(true)}>
            {t('profiles.chan.saveOn')}
          </Button>
          <Button size="small" variant="outlined" disabled={!ok || busy || !p.enabled} onClick={() => void save(false)}>
            {t('profiles.chan.turnOff')}
          </Button>
          <Button startIcon={<NetworkCheckOutlinedIcon />} size="small" variant="outlined" disabled={!ok || busy} onClick={() => void test()}>
            {t('profiles.chan.test')}
          </Button>
        </Stack>
        {result && <Alert severity={result.ok ? 'success' : 'warning'} sx={calmAlertSx}>{result.text}</Alert>}
        {error && !errorField && <Alert severity="error" sx={calmAlertSx}>{error}</Alert>}
        {pairing && (
          <Box>
            <Typography variant="subtitle2">{t('profiles.chan.pairing')}</Typography>
            <ItemList>
              {mine(pairing.pending).map((r) => (
                <ItemRow
                  key={r.request_id}
                  name={r.user_name || r.user_id}
                  description={r.user_id}
                  control={
                    <Button
                      size="small"
                      disabled={!ok || busy}
                      onClick={() => void approve(r)}
                    >
                      {t('profiles.chan.approve')}
                    </Button>
                  }
                />
              ))}
              {mine(pairing.approved).map((r) => (
                <ItemRow
                  key={r.user_id}
                  name={r.user_name || r.user_id}
                  description={t('profiles.chan.allowedUser')}
                  control={
                    <Button
                      size="small"
                      disabled={!ok || busy}
                      onClick={() =>
                        void run(async () => {
                          await act('pairing_revoke', { platform: p.id, user_id: r.user_id });
                          await refresh();
                        })
                      }
                    >
                      {t('profiles.chan.revoke')}
                    </Button>
                  }
                />
              ))}
            </ItemList>
            {!mine(pairing.pending).length && !mine(pairing.approved).length && (
              <Typography variant="caption" color="text.secondary">
                {t('profiles.chan.noPairing')}
              </Typography>
            )}
          </Box>
        )}
    </Stack>
  );
}

/** 이 프로파일에 연결한(켰거나 값을 넣은) 메신저. 나머지는 「+ 메신저 연결」에서 고른다 */
const linked = (p: Platform) => p.enabled || p.configured;

function stateTag(p: Platform) {
  const [labelKey, tone] = STATE[p.state ?? ''] ?? ['', undefined];
  return <Tag tone={tone}>{labelKey ? t(labelKey) : p.state || '—'}</Tag>;
}

/** 연결한 메신저 한 줄: 이름·상태·승인 대기 수, 「설정」으로 같은 대화 상자의 ②단계를 연다 */
function PlatformCard({ p, pending, onOpen }: { p: Platform; pending: number; onOpen: () => void }) {
  return (
    <ItemRow
      icon={ForumOutlinedIcon}
      name={p.name}
      tags={
        <>
          {stateTag(p)}
          {pending > 0 && <Tag tone="warn">{t('profiles.chan.pendingCount', { n: pending })}</Tag>}
        </>
      }
      description={p.error_message || undefined}
      control={
        <Button size="small" variant="outlined" color="inherit" onClick={onOpen} aria-label={t('profiles.chan.settingsNamed', { name: p.name })}>
          {t('profiles.chan.settings')}
        </Button>
      }
    />
  );
}

/** 「+ 메신저 연결」 대화 상자. pick=null 이면 ① 고르기, 아니면 ② 그 메신저의 칸. 카드의 「설정」은 ②로 바로 연다 */
function ConnectDialog({
  open,
  pick,
  fromPicker,
  data,
  name,
  ok,
  onPick,
  onClose,
}: {
  open: boolean;
  pick: string | null;
  fromPicker: boolean;
  data: ChannelsData;
  name: string;
  ok: boolean;
  onPick: (id: string | null) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const fullScreen = useMediaQuery(useTheme().breakpoints.down('sm'));
  const p = pick ? data.platforms.find((x) => x.id === pick) : undefined; // 저장 뒤 다시 읽은 값으로 그린다
  return (
    <Dialog open={open} onClose={onClose} aria-labelledby={titleId} fullWidth maxWidth="sm" fullScreen={fullScreen}>
      <DialogTitle id={titleId}>
        {p ? t(linked(p) ? 'profiles.chan.editTitle' : 'profiles.chan.formTitle', { name: p.name }) : t('profiles.chan.pickTitle')}
      </DialogTitle>
      <DialogContent>
        {p ? (
          <Box sx={{ pt: 0.5 }}>
            <PlatformForm key={p.id} p={p} name={name} ok={ok} pairing={data.pairing} />
          </Box>
        ) : (
          <Stack spacing={1} sx={{ pt: 0.5 }}>
            <Typography variant="body2" color="text.secondary">
              {t('profiles.chan.pickHint')}
            </Typography>
            <ItemList>
              {data.platforms.map((x) => (
                <ItemRow
                  key={x.id}
                  icon={ForumOutlinedIcon}
                  name={x.name}
                  tags={linked(x) ? stateTag(x) : undefined}
                  description={linked(x) ? t('profiles.chan.alreadyLinked') : undefined}
                  rowTitle={t('profiles.chan.pickNamed', { name: x.name })}
                  onRow={() => onPick(x.id)}
                  control={<ChevronRightIcon fontSize="small" color="action" />}
                />
              ))}
            </ItemList>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        {p && fromPicker && (
          <Button color="inherit" sx={{ mr: 'auto' }} onClick={() => onPick(null)}>
            {t('profiles.chan.pickBack')}
          </Button>
        )}
        <Button variant="outlined" color="inherit" onClick={onClose}>
          {t('common.close')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function ChannelPane({ d }: { d: ProfileDetailData }) {
  const name = d.profile.name;
  // 다른 화면이 「?add=1」로 보내면 대화 상자를 열고 시작한다(메신저 연결 화면의 「메신저 연결하기」)
  const spot = useProfileSpot();
  const [dlg, setDlg] = useState<{ open: boolean; pick: string | null; fromPicker: boolean }>(() => ({ open: spot.get('add') === '1', pick: null, fromPicker: true }));
  const q = useQuery<ChannelsData>({
    queryKey: ['channels-platforms', name],
    queryFn: () => get(`/api/channels/platforms?profile=${encodeURIComponent(name)}`),
    staleTime: 15000,
  });
  if (!q.data)
    return q.error ? (
      <Alert severity="warning" sx={calmAlertSx}>{q.error.message}</Alert>
    ) : (
      <Typography color="text.secondary">{t('profiles.loading')}</Typography>
    );
  const mayEdit = d.can_edit || mayManage(d); // 관리자와 그 에이전트의 주인(스펙 2026-10-15-011 단계 1). 막을 이름·값은 서버가 가려 오류 문구로 알린다
  const ok = mayEdit && d.secure;
  const why = capWhy(d, 'channels') || (!mayEdit ? t('profiles.adminOnlyChange') : !d.secure ? t('profiles.envInsecure') : '');
  const data = q.data;
  const shown = data.platforms.filter(linked);
  const pendingOf = (id: string) => (data.pairing?.pending ?? []).filter((r) => r.platform === id).length;
  const close = () => {
    setDlg((s) => ({ ...s, open: false }));
    if (spot.get('add')) spot.patch({ add: null }, { replace: true });
  };
  return (
    <Stack spacing={1.5}>
      <Stack direction="row" spacing={2} alignItems="flex-start">
        <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
          {t('profiles.chan.intro')}
        </Typography>
        <Button
          startIcon={<AddIcon />}
          size="small"
          variant="outlined"
          color="inherit"
          sx={{ flexShrink: 0 }}
          disabled={!ok}
          data-guide="profiles.chan-add"
          onClick={() => setDlg({ open: true, pick: null, fromPicker: true })}
        >
          {t('profiles.chan.add')}
        </Button>
      </Stack>
      {why && <Alert severity="warning" sx={calmAlertSx}>{why}</Alert>}
      <Section title={t('profiles.chan.linkedTitle')} count={shown.length}>
        {shown.length ? (
          <ItemList>
            {shown.map((p) => (
              <PlatformCard key={p.id} p={p} pending={pendingOf(p.id)} onOpen={() => setDlg({ open: true, pick: p.id, fromPicker: false })} />
            ))}
          </ItemList>
        ) : (
          <Typography variant="body2" color="text.secondary">
            {t('profiles.chan.none')}
          </Typography>
        )}
      </Section>
      <ConnectDialog
        open={dlg.open}
        pick={dlg.pick}
        fromPicker={dlg.fromPicker}
        data={data}
        name={name}
        ok={ok}
        onPick={(id) => setDlg((s) => ({ ...s, pick: id }))}
        onClose={close}
      />
    </Stack>
  );
}
