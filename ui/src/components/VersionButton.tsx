/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 좌측 메뉴 맨 아래의 로고·버전. 누르면 버전 정보 창을 연다.
// COP Console 의 Sidebar/VersionButton.tsx 와 같은 모양·크기다(펼침: 로고 11px + 버전 9px·커밋 날짜 8px, 접힘: 로고 8px).
import CloseIcon from '@mui/icons-material/Close';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import {
  Box,
  ButtonBase,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  Link,
  Table,
  TableBody,
  TableCell,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import { useState } from 'react';

import { t } from '@/i18n';
import { brandLogos, brandProduct } from '@/lib/brand';
import { type BuildInfo, buildInfo, shortHash, versionLabel, versionRows } from '@/lib/buildInfo';
import { shellColors } from '@/lib/shellTokens';

import { useThemeMode } from './ThemeMode';

export function VersionButton({ collapsed, info = buildInfo() }: { collapsed: boolean; info?: BuildInfo }) {
  const [open, setOpen] = useState(false);
  const { mode } = useThemeMode();
  const logos = brandLogos();
  const product = `${brandProduct()} AAS`;
  const version = versionLabel(info);
  const button = (
    <ButtonBase
      onClick={() => setOpen(true)}
      aria-label={t('about.open', { version })}
      aria-haspopup="dialog"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        width: '100%',
        color: shellColors.menuText,
        opacity: 0.7,
        py: 0.5,
        borderRadius: 1,
        transition: 'opacity 0.2s, background-color 0.2s',
        '&:hover, &.Mui-focusVisible': { opacity: 1, backgroundColor: 'rgba(255, 255, 255, 0.1)' },
      }}
    >
      {collapsed ? (
        <img src={logos.wh} alt={product} style={{ height: 8 }} />
      ) : (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <img src={logos.wh} alt={product} style={{ height: 11 }} />
          {/* 크기는 COP·Observ 의 사이드바 아래와 같은 px 값이다(버전 9px/500, 해시·날짜 8px/400, 줄높이 1.5) */}
          <Box sx={{ display: 'flex', flexDirection: 'column', textAlign: 'left' }}>
            <Typography component="span" sx={{ fontSize: '9px', fontWeight: 500, lineHeight: 1.5 }}>
              {version}{' '}
              <Box component="span" sx={{ fontSize: '8px', fontWeight: 400 }}>
                | #{shortHash(info.gitCommit) || 'N/A'}
              </Box>
            </Typography>
            <Typography component="span" sx={{ fontSize: '8px', lineHeight: 1.5 }}>
              {info.gitCommitDate || 'N/A'}
            </Typography>
          </Box>
        </Box>
      )}
    </ButtonBase>
  );

  return (
    <>
      {collapsed ? (
        <Tooltip title={t('about.title')} placement="right">
          {button}
        </Tooltip>
      ) : (
        button
      )}
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="sm" fullWidth aria-labelledby="aas-version-title">
        <DialogTitle id="aas-version-title" sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pb: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <InfoOutlinedIcon />
            <Typography variant="h6" component="span">
              {t('about.title')}
            </Typography>
          </Box>
          <IconButton onClick={() => setOpen(false)} size="small" aria-label={t('common.close')}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', mt: 2, mb: 3 }}>
            {/* 창 배경은 테마를 따른다: 다크는 흰 글자 판, 라이트는 검정 글자 판 */}
            <img src={mode === 'dark' ? logos.rwh : logos.h} alt={product} style={{ height: 48 }} />
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              {t('about.tagline')}
            </Typography>
          </Box>
          <Table size="small">
            <TableBody>
              {versionRows(info, product).map((r) => (
                <TableRow key={r.label}>
                  <TableCell component="th" scope="row" sx={{ fontWeight: 500, width: '25%', whiteSpace: 'nowrap' }}>
                    {r.label}
                  </TableCell>
                  <TableCell sx={{ fontFamily: r.mono ? 'monospace' : 'inherit', wordBreak: 'break-all' }}>{r.value}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2, textAlign: 'center' }}>
            Copyright (c) 2026. OPENMARU, Inc. ·{' '}
            {/* 회사 주소 링크. 색은 저작권 줄 글자색 그대로(사용자 지시 2026-10-30) */}
            <Link href="https://www.openmaru.io/" target="_blank" rel="noopener" color="inherit" underline="hover">
              https://www.openmaru.io/
            </Link>
          </Typography>
        </DialogContent>
      </Dialog>
    </>
  );
}
