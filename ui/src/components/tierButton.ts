/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// DESIGN.md §4 「3-Tier 버튼 시스템」의 sx. 빨강은 Tier 3(되돌릴 수 없는 동작)에만 쓴다(§1-1.1).
// MUI Button 에 variant="outlined" color="inherit" 와 함께 붙인다: <Button variant="outlined" color="inherit" sx={tier1}>.
import type { SxProps, Theme } from '@mui/material';

/** Tier 1 · Primary: 저장·확인. 단색 wash + 1px 테두리 + 안쪽 빛 */
export const tier1: SxProps<Theme> = (th) =>
  th.palette.mode === 'dark'
    ? {
        bgcolor: 'rgba(255,255,255,0.06)',
        borderColor: 'rgba(255,255,255,0.14)',
        color: '#f7f8f8',
        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.04)',
        '&:hover': { bgcolor: 'rgba(255,255,255,0.12)', borderColor: 'rgba(255,255,255,0.24)', color: '#ffffff' },
        '&.Mui-focusVisible': { borderColor: 'rgba(255,255,255,0.55)', boxShadow: '0 0 0 3px rgba(255,255,255,0.12)' },
        '&.Mui-disabled': { bgcolor: 'rgba(255,255,255,0.03)', borderColor: 'rgba(255,255,255,0.06)', color: '#62666d' },
      }
    : {
        bgcolor: 'rgba(17,24,39,0.05)',
        borderColor: 'rgba(17,24,39,0.14)',
        color: '#111827',
        boxShadow: 'inset 0 0 0 1px rgba(17,24,39,0.03)',
        '&:hover': { bgcolor: 'rgba(17,24,39,0.10)', borderColor: 'rgba(17,24,39,0.24)', color: '#08090a' },
        '&.Mui-focusVisible': { borderColor: 'rgba(17,24,39,0.55)', boxShadow: '0 0 0 3px rgba(17,24,39,0.10)' },
        '&.Mui-disabled': { bgcolor: 'rgba(17,24,39,0.03)', borderColor: 'rgba(17,24,39,0.06)', color: '#9ca3af' },
      };

/** Tier 2 · Secondary(Ghost): 취소·닫기·보조 */
export const tier2: SxProps<Theme> = (th) =>
  th.palette.mode === 'dark'
    ? {
        bgcolor: 'transparent',
        borderColor: 'rgba(255,255,255,0.10)',
        color: '#d0d6e0',
        '&:hover': { bgcolor: 'rgba(255,255,255,0.04)', borderColor: 'rgba(255,255,255,0.18)', color: '#f7f8f8' },
        '&.Mui-disabled': { borderColor: 'rgba(255,255,255,0.05)', color: '#62666d' },
      }
    : {
        bgcolor: 'transparent',
        borderColor: 'rgba(17,24,39,0.10)',
        color: '#4b5563',
        '&:hover': { bgcolor: 'rgba(17,24,39,0.04)', borderColor: 'rgba(17,24,39,0.18)', color: '#111827' },
        '&.Mui-disabled': { borderColor: 'rgba(17,24,39,0.05)', color: '#9ca3af' },
      };

/** Tier 3 · Danger: 삭제·사용 중지처럼 되돌리기 어려운 동작의 확인 단추만 */
export const tier3: SxProps<Theme> = (th) =>
  th.palette.mode === 'dark'
    ? {
        bgcolor: 'rgba(218,41,28,0.16)',
        borderColor: 'rgba(218,41,28,0.55)',
        color: '#f5f6f7',
        boxShadow: 'inset 0 0 0 1px rgba(218,41,28,0.18)',
        '&:hover': { bgcolor: 'rgba(218,41,28,0.28)', borderColor: 'rgba(218,41,28,0.75)', color: '#ffffff' },
        '&.Mui-focusVisible': { borderColor: 'rgba(218,41,28,0.85)', boxShadow: '0 0 0 3px rgba(218,41,28,0.30)' },
        '&.Mui-disabled': { bgcolor: 'rgba(218,41,28,0.06)', borderColor: 'rgba(218,41,28,0.20)', color: 'rgba(218,41,28,0.5)' },
      }
    : {
        bgcolor: 'rgba(218,41,28,0.08)',
        borderColor: 'rgba(218,41,28,0.45)',
        color: '#da291c',
        boxShadow: 'inset 0 0 0 1px rgba(218,41,28,0.12)',
        '&:hover': { bgcolor: 'rgba(218,41,28,0.16)', borderColor: 'rgba(218,41,28,0.65)', color: '#b01e0a' },
        '&.Mui-disabled': { bgcolor: 'rgba(218,41,28,0.04)', borderColor: 'rgba(218,41,28,0.20)', color: 'rgba(218,41,28,0.5)' },
      };
