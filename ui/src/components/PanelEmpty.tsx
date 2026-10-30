/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 서랍 안의 빈 상태: 아이콘 하나, 한 줄 제목, 보조 설명, 이어 갈 곳. 가운데 정렬하고 단추는 내용 폭만큼만 차지한다.
import type { SvgIconComponent } from '@mui/icons-material';
import { Box, Typography } from '@mui/material';
import type { ReactNode } from 'react';

export function PanelEmpty({ icon: Icon, title, sub, action }: { icon: SvgIconComponent; title: string; sub?: string; action?: ReactNode }) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 0.5, py: 6, px: 2 }}>
      <Box
        sx={{ width: 44, height: 44, borderRadius: '50%', display: 'grid', placeItems: 'center', bgcolor: 'action.hover', color: 'text.secondary', mb: 1 }}
      >
        <Icon aria-hidden sx={{ fontSize: 22 }} />
      </Box>
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {title}
      </Typography>
      {sub && (
        <Typography variant="caption" color="text.secondary">
          {sub}
        </Typography>
      )}
      {action && <Box sx={{ mt: 1.5 }}>{action}</Box>}
    </Box>
  );
}
