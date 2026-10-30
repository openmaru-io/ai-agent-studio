/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// PC 가져오기·내보내기 서랍이 함께 쓰는 부품(OMAI-1136 §10-2·§10-3·§10-6): OS 탭, 명령 칸(복사 단추), 번호 붙은 단계 목록.
// 명령 칸은 줄바꿈 없이 가로로 넘기고 복사 단추는 칸 오른쪽에 고정한다. 복사하면 「복사했습니다」를 aria-live 로 알린다.
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import { Box, IconButton, type SxProps, Tab, Tabs, type Theme, Tooltip, Typography } from '@mui/material';
import { visuallyHidden } from '@mui/utils';
import { ReactNode, useState } from 'react';

import { t } from '@/i18n';
import { MONO_FONT } from '@/lib/monoFont';

import { type Os, OSES } from './pcImportApi';

/** 단추 등급(tierButton)에 누르는 높이 44px 를 더한다(§10-6) */
export const tall =
  (tier: SxProps<Theme>): SxProps<Theme> =>
  (th: Theme) => ({ ...(typeof tier === 'function' ? (tier(th) as object) : (tier as object)), minHeight: 44 });

export function OsTabs({ value, onChange }: { value: Os; onChange: (os: Os) => void }) {
  return (
    <Tabs
      value={value}
      onChange={(_, v: Os) => onChange(v)}
      aria-label={t('profiles.pcImport.osLabel')}
      sx={{ borderBottom: 1, borderColor: 'divider', '& .MuiTab-root': { textTransform: 'none' } }}
    >
      {OSES.map((os) => (
        <Tab key={os} value={os} label={t(`profiles.pcImport.os.${os}`)} />
      ))}
    </Tabs>
  );
}

/** 명령 한 칸. label 은 복사 단추의 읽는 이름(기본 「명령 복사」) */
export function CommandLine({ cmd, label }: { cmd: string; label?: string }) {
  const [said, setSaid] = useState('');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cmd);
      setSaid(t('profiles.pcImport.copied'));
    } catch {
      setSaid('');
    }
  };
  const name = label ?? t('profiles.pcImport.copy');
  return (
    <Box sx={{ display: 'flex', alignItems: 'stretch', border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: 'action.hover', minWidth: 0 }}>
      <Box
        component="pre"
        tabIndex={0}
        // 복사 단추(44px)에 맞춰 늘어난 칸에서 글을 세로 가운데에 둔다(OMAI-1444 실화면 지적)
        sx={{ flex: 1, minWidth: 0, m: 0, px: 1.25, py: 1, display: 'flex', alignItems: 'center', overflowX: 'auto', whiteSpace: 'pre', fontFamily: MONO_FONT, fontSize: 12, lineHeight: 1.6 }}
      >
        {cmd}
      </Box>
      <Tooltip title={said || name}>
        <IconButton aria-label={name} onClick={() => void copy()} sx={{ flexShrink: 0, minWidth: 44, minHeight: 44, borderRadius: 0 }}>
          <ContentCopyOutlinedIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Box component="span" role="status" aria-live="polite" sx={visuallyHidden}>
        {said}
      </Box>
    </Box>
  );
}

export interface Step {
  text: ReactNode;
  cmd?: string;
  /** 「꼭 먼저」 같은 표시 */
  mark?: string;
}

/** 번호 붙은 단계 목록. 명령이 있으면 문장 아래에 명령 칸 */
export function Steps({ steps }: { steps: Step[] }) {
  return (
    <Box component="ol" sx={{ m: 0, pl: 2.5, display: 'flex', flexDirection: 'column', gap: 1.25 }}>
      {steps.map((s, i) => (
        <Box component="li" key={i} sx={{ minWidth: 0 }}>
          <Typography variant="body2" component="div">
            {s.mark && (
              <Box
                component="span"
                sx={{ display: 'inline-block', mr: 0.75, px: 0.75, border: 1, borderColor: 'warning.main', borderRadius: '9999px', fontSize: 12, fontWeight: 600 }}
              >
                {s.mark}
              </Box>
            )}
            {s.text}
          </Typography>
          {s.cmd && (
            <Box sx={{ mt: 0.5 }}>
              <CommandLine cmd={s.cmd} />
            </Box>
          )}
        </Box>
      ))}
    </Box>
  );
}
