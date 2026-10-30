/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 프로파일 › 성격(SOUL) 창 위의 「템플릿에서 시작」. 계획 2026-10-13-009 §4.
// 고른 템플릿을 서버가 이 프로파일 기준(POD 주인의 부서·오피스 별칭)으로 채워 주면 편집기를 그 글로 연다.
// 저장은 평소 SOUL 저장과 같다(바뀐 줄 확인 → 메모 → 판 관리). 자동으로 바꾸지 않는다(Q1).
import { Alert, Button, NativeSelect, Stack, Typography } from '@mui/material';
import { useSnackbar } from 'notistack';
import { useState } from 'react';

import { t } from '@/i18n';
import { post } from '@/lib/api';
import { type SoulTemplate, tplKey, useSoulTemplates } from '@/screens/settings/SoulTemplates';

import type { SoulTemplateHint } from './types';

export interface StartedTemplate {
  id: string;
  lang: string;
  rev: number;
  name: string;
}

export function SoulTemplateBar({
  name,
  hint,
  onStart,
}: {
  name: string;
  hint: SoulTemplateHint | null;
  onStart: (text: string, tpl: StartedTemplate) => void;
}) {
  const q = useSoulTemplates();
  const { enqueueSnackbar } = useSnackbar();
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const items = q.data?.templates.filter((x) => !x.deleted) ?? [];
  const find = (id: string, lang: string) => items.find((x) => x.id === id && x.lang === lang);

  const start = async (x: SoulTemplate | undefined) => {
    if (!x) return;
    setBusy(true);
    try {
      const r = await post<{ content: string; rev: number }>('/api/soul-templates/render', {
        id: x.id,
        lang: x.lang,
        profile: name,
      });
      onStart(r.content, { id: x.id, lang: x.lang, rev: r.rev ?? x.rev, name: x.name });
      setOpen(false);
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const use = hint?.use;
  const rec = hint?.recommend;
  return (
    <Stack spacing={1} sx={{ mb: 1.5 }}>
      {use?.changed && (
        <Alert
          severity="info"
          action={
            <Button size="small" disabled={busy} onClick={() => void start(find(use.template_id, use.lang))}>
              {t('profiles.soulTplReapply')}
            </Button>
          }
        >
          {t('profiles.soulTplChanged', { name: use.name, rev: use.rev, now: use.current_rev ?? 0 })}
        </Alert>
      )}
      {rec && !use && (
        <Alert
          severity="info"
          action={
            <Button size="small" disabled={busy} onClick={() => void start(find(rec.id, rec.lang))}>
              {t('profiles.soulTplStartThis')}
            </Button>
          }
        >
          {t('profiles.soulTplRecommend', { name: rec.name, dept: hint?.department ?? '' })}
        </Alert>
      )}
      <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
        {!open ? (
          <Button size="small" variant="outlined" disabled={!items.length} onClick={() => setOpen(true)}>
            {t('profiles.soulTplStart')}
          </Button>
        ) : (
          <>
            <NativeSelect
              value={pick}
              onChange={(e) => setPick(e.target.value)}
              inputProps={{ 'aria-label': t('profiles.soulTplPick') }}
            >
              <option value="">{t('profiles.soulTplPick')}</option>
              {items.map((x) => (
                <option key={tplKey(x)} value={tplKey(x)}>
                  {`${x.name} (${t(`soulTpl.langName.${x.lang}`)})`}
                </option>
              ))}
            </NativeSelect>
            <Button
              size="small"
              variant="contained"
              disabled={!pick || busy}
              onClick={() => void start(items.find((x) => tplKey(x) === pick))}
            >
              {t('profiles.soulTplOpen')}
            </Button>
            <Button size="small" onClick={() => setOpen(false)}>
              {t('profiles.soulTplCancel')}
            </Button>
          </>
        )}
        {use && !use.changed && (
          <Typography variant="caption" color="text.secondary">
            {t('profiles.soulTplUsed', { name: use.name, rev: use.rev })}
          </Typography>
        )}
      </Stack>
    </Stack>
  );
}
