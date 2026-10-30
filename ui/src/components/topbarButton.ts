/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 상단 막대 검색창 옆 단추(AI·3D 오피스)의 모양(OMAI-1218). 검색창과 같은 높이·테두리의 38px 정사각 아이콘 단추다. 새 색을 쓰지 않는다.
import type { SxProps, Theme } from '@mui/material';

export const topbarButtonSx = (active: boolean): SxProps<Theme> => ({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  width: 38,
  height: 38,
  p: 0,
  cursor: 'pointer',
  font: 'inherit',
  textDecoration: 'none',
  color: active ? '#fff' : 'rgba(255,255,255,0.8)',
  background: active ? 'rgba(255,255,255,0.1)' : 'transparent',
  border: `1px solid ${active ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.23)'}`,
  borderRadius: '4px',
  '&:hover': { borderColor: 'rgba(255,255,255,0.5)', color: '#fff' },
  '&:focus-visible': { outline: '2px solid #fff', outlineOffset: 1 },
});
