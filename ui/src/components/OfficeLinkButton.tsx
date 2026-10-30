/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 상단 막대의 「오피스」 단추(OMAI-1218). AI 단추 옆에서 3D 오피스 화면(/office)으로 간다. 아이콘만 보이고 이름은 툴팁·접근 이름이다(건물 아이콘은 오피스 화면 제목과 같다). 오피스 화면에 있으면 현재 화면 표시(aria-current)가 선다.
import BusinessOutlinedIcon from '@mui/icons-material/BusinessOutlined';
import { Box, Tooltip } from '@mui/material';
import { Link, useLocation } from 'react-router-dom';

import { t } from '@/i18n';
import { shellMetrics } from '@/lib/shellTokens';

import { topbarButtonSx } from './topbarButton';

export function OfficeLinkButton() {
  const here = useLocation().pathname.startsWith('/office');
  return (
    <Tooltip title={t('topbar.office')}>
      <Box component={Link} to="/office" aria-label={t('topbar.office')} aria-current={here ? 'page' : undefined} sx={topbarButtonSx(here)}>
        <BusinessOutlinedIcon sx={{ fontSize: shellMetrics.iconButtonSize }} />
      </Box>
    </Tooltip>
  );
}
