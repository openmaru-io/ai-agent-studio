/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { Alert, Box, Button, CircularProgress } from '@mui/material';
import { useState } from 'react';

import { tier2 } from '@/components/tierButton';
import { getLang, t } from '@/i18n';
import { api } from '@/lib/api';

/**
 * 스킬 서랍의 「내려받기(zip)」(OMAI-1195, DR1·DR6·DR7). 「파일 N개」 바로 아래의 보조(Tier 2) 글자 단추다.
 * 비밀값이 든 파일은 서버가 zip 에서 빼고 이름을 X-AAS-Excluded 머리로 알린다. 그 경고는 사라지는 알림이 아니라 서랍 안에 닫을 때까지 남는다.
 */
export function DownloadSkill({ s, onBusy }: { s: { name: string; profile: string; path: string }; /** 받는 동안 true — 지우기 창이 「지우기」를 막는다(2026-10-29-005 DD4) */ onBusy?: (busy: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [excluded, setExcluded] = useState<string[]>([]);
  const inRoot = s.path.replace(/^profiles\/[^/]+\//, '');
  const run = async () => {
    setBusy(true);
    onBusy?.(true);
    setError('');
    setExcluded([]);
    try {
      const r = await fetch(`/api/skill/download?profile=${encodeURIComponent(s.profile)}&path=${encodeURIComponent(inRoot)}`, {
        headers: { 'Accept-Language': getLang() },
      });
      if (r.status === 401) {
        api.toLogin('/auth/login?next=' + encodeURIComponent(window.location.pathname + window.location.hash));
        return;
      }
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || r.statusText);
      }
      let names: string[] = [];
      try {
        const raw = JSON.parse(r.headers.get('X-AAS-Excluded') ?? '[]') as unknown;
        names = Array.isArray(raw) ? raw.map(String) : [];
      } catch {
        names = [];
      }
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `${s.name}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      setExcluded(names);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      onBusy?.(false);
    }
  };
  return (
    <Box sx={{ my: 1 }}>
      <Button
        size="small"
        variant="outlined"
        color="inherit"
        sx={tier2}
        disabled={busy}
        aria-busy={busy}
        startIcon={busy ? <CircularProgress size={14} color="inherit" /> : undefined}
        onClick={() => void run()}
      >
        {busy ? t('skills.downloading') : t('skills.download')}
      </Button>
      {error && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {error}
        </Alert>
      )}
      {excluded.length > 0 && (
        <Alert severity="warning" sx={{ mt: 1 }} onClose={() => setExcluded([])}>
          {t('skills.downloadExcluded', { count: excluded.length, names: excluded.join(', ') })}
        </Alert>
      )}
    </Box>
  );
}
