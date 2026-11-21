/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 「내 메신저 계정 연결」(스펙 2026-11-17-008 §5-2). 공유받은 사람(또는 소유자)이 이 작업공간의 봇에게 말을 걸어 받은 연결 코드를 넣으면
// AAS 가 승인하고 메신저 계정을 이 사람으로 기록한다. 연결되면 「@이름 이 연결되었습니다. 본인 계정이 아니면 바로 해제하세요」를 보이고
// 소유자에게 알림이 간다. 메신저마다 봇을 찾는 법이 달라 한 줄 안내를 둔다.
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  NativeSelect,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { ItemList, ItemRow } from '@/components/ItemRow';
import { MessengerRestart } from '@/components/MessengerRestart';
import { tier2 } from '@/components/tierButton';
import { t } from '@/i18n';
import { get, post } from '@/lib/api';

interface Bot {
  profile: string;
  platform: string;
  state: string;
  connected: boolean;
}
interface Link {
  profile: string;
  platform: string;
  platform_user_id: string;
  user_name: string;
  dm_chat_id: string;
  ts: string;
}
export interface MessengerLinks {
  pod: string;
  can_link: boolean;
  bots: Bot[];
  mine: Link[];
  owner_name: string;
  restart_needed: string[];
}

const PLATFORM: Record<string, string> = { telegram: 'Telegram', slack: 'Slack', discord: 'Discord', mattermost: 'Mattermost' };
const label = (b: { profile: string; platform: string }) => `${PLATFORM[b.platform] ?? b.platform} · ${b.profile}`;

export function useMessengerLinks(pod?: string) {
  return useQuery<MessengerLinks>({
    queryKey: ['messenger-links', pod],
    queryFn: () => get(`/api/messenger/links?pod=${encodeURIComponent(pod ?? '')}`),
    enabled: !!pod,
  });
}

/** 단추 + 창. 이 작업공간에 메신저를 이을 수 없는 사람에게는 그리지 않는다. 소유자에게는 다시 시작 안내도 함께 */
export function MessengerLinkButton({ pod }: { pod: string }) {
  const q = useMessengerLinks(pod);
  const [open, setOpen] = useState(false);
  const d = q.data;
  if (!d || !d.can_link) return null;
  return (
    <>
      <MessengerRestart pod={pod} />
      <Stack direction="row" spacing={1} alignItems="center">
        <Button size="small" variant="outlined" color="inherit" sx={tier2 as object} onClick={() => setOpen(true)}>
          {t('messenger.linkButton')}
        </Button>
        {d.mine.length > 0 && (
          <Typography variant="caption" color="text.secondary">
            {t('messenger.linkedCount', { n: d.mine.length })}
          </Typography>
        )}
      </Stack>
      {open && <MessengerLinkDialog pod={pod} data={d} onClose={() => setOpen(false)} />}
    </>
  );
}

/** 메신저 알림 받기(사람마다, §6-2). 설치에서 알림 전달을 켜지 않았으면 그리지 않는다 */
function NotifyPref() {
  const qc = useQueryClient();
  const q = useQuery<{ enabled: boolean; off: boolean }>({ queryKey: ['notify-prefs'], queryFn: () => get('/api/notify/prefs') });
  if (!q.data?.enabled) return null;
  return (
    <FormControlLabel
      sx={{ mt: 1.5 }}
      control={
        <Switch
          checked={!q.data.off}
          onChange={async (e) => {
            await post('/api/notify/prefs', { off: !e.target.checked });
            await qc.invalidateQueries({ queryKey: ['notify-prefs'] });
          }}
        />
      }
      label={t('messenger.notifyMe')}
    />
  );
}

function MessengerLinkDialog({ pod, data, onClose }: { pod: string; data: MessengerLinks; onClose: () => void }) {
  const qc = useQueryClient();
  const titleId = useId();
  const [pick, setPick] = useState(0);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ name: string; delivery: boolean } | null>(null);
  const bot = data.bots[pick];
  const reload = () => qc.invalidateQueries({ queryKey: ['messenger-links', pod] });
  const link = async () => {
    if (!bot) return;
    setBusy(true);
    setError('');
    try {
      const out = await post<{ link: Link; delivery: boolean }>('/api/messenger/links', { pod, op: 'link', profile: bot.profile, platform: bot.platform, code });
      setDone({ name: out.link.user_name || out.link.platform_user_id, delivery: out.delivery });
      setCode('');
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const unlink = async (l: Link) => {
    setBusy(true);
    setError('');
    try {
      await post('/api/messenger/links', { pod, op: 'unlink', profile: l.profile, platform: l.platform, user_id: l.platform_user_id });
      setDone(null);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={busy ? undefined : onClose} aria-labelledby={titleId} fullWidth maxWidth="sm">
      <DialogTitle id={titleId}>{t('messenger.title')}</DialogTitle>
      <DialogContent>
        {data.bots.length === 0 ? (
          <Alert severity="info">{t('messenger.noBot', { name: data.owner_name || '' })}</Alert>
        ) : (
          <Stack spacing={1.5}>
            <Typography variant="body2">{t('messenger.help')}</Typography>
            {data.bots.length > 1 && (
              <NativeSelect value={pick} onChange={(e) => setPick(Number(e.target.value))} inputProps={{ 'aria-label': t('messenger.which') }}>
                {data.bots.map((b, i) => (
                  <option key={`${b.profile}:${b.platform}`} value={i}>
                    {label(b)}
                  </option>
                ))}
              </NativeSelect>
            )}
            {bot && (
              <Typography variant="body2" color="text.secondary">
                {t(`messenger.hint.${bot.platform}` as Parameters<typeof t>[0])}
              </Typography>
            )}
            {bot && !bot.connected && <Alert severity="warning">{t('messenger.botOff')}</Alert>}
            <Stack direction="row" spacing={1} alignItems="flex-start">
              <TextField
                size="small"
                label={t('messenger.code')}
                placeholder="ABCD2345"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                slotProps={{ htmlInput: { maxLength: 12, autoComplete: 'off', spellCheck: false } }}
                sx={{ flex: 1 }}
              />
              <Button variant="outlined" color="inherit" disabled={busy || !code.trim() || !bot} onClick={() => void link()}>
                {t('messenger.link')}
              </Button>
            </Stack>
          </Stack>
        )}
        {done && (
          <Alert severity="success" sx={{ mt: 1.5 }}>
            {t('messenger.linked', { name: done.name })}
            {!done.delivery && <Box component="span">{' ' + t('messenger.noDelivery')}</Box>}
          </Alert>
        )}
        {error && (
          <Alert severity="error" sx={{ mt: 1.5 }}>
            {error}
          </Alert>
        )}
        {data.mine.length > 0 && <NotifyPref />}
        {data.mine.length > 0 && (
          <Box sx={{ mt: 2 }}>
            <Typography variant="subtitle2">{t('messenger.mine')}</Typography>
            <ItemList>
              {data.mine.map((l) => (
                <ItemRow
                  key={`${l.profile}:${l.platform}:${l.platform_user_id}`}
                  name={l.user_name || l.platform_user_id}
                  description={label(l)}
                  control={
                    <Button size="small" disabled={busy} onClick={() => void unlink(l)}>
                      {t('messenger.unlink')}
                    </Button>
                  }
                />
              ))}
            </ItemList>
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          {t('common.close')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
