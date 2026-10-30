/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 화면 아래 알림(Toast). notistack 의 기본 어두운 직사각 상자 대신 다이얼로그와 같은 표면 위에 상태 아이콘 칩, 닫기 단추,
// 남은 시간을 보여 주는 가는 막대를 둔다. notistack-MuiContent 클래스는 시험과 접근성 도구가 찾으므로 그대로 유지한다.
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import PriorityHighRoundedIcon from '@mui/icons-material/PriorityHighRounded';
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded';
import { Box, IconButton, keyframes, useTheme } from '@mui/material';
import { CustomContentProps, SnackbarContent, useSnackbar, VariantType } from 'notistack';
import { forwardRef, ReactNode } from 'react';

import { t } from '@/i18n';
import { FOCUS_RING, toastTokens } from '@/lib/shellTokens';

const ICONS: Record<VariantType, ReactNode> = {
  default: <InfoOutlinedIcon sx={{ fontSize: 16 }} />,
  success: <CheckRoundedIcon sx={{ fontSize: 16 }} />,
  error: <PriorityHighRoundedIcon sx={{ fontSize: 16 }} />,
  warning: <WarningAmberRoundedIcon sx={{ fontSize: 16 }} />,
  info: <InfoOutlinedIcon sx={{ fontSize: 16 }} />,
};

const drain = keyframes`
  from { transform: scaleX(1); }
  to { transform: scaleX(0); }
`;

const AppToast = forwardRef<HTMLDivElement, CustomContentProps>(function AppToast(
  { id, message, variant, autoHideDuration, persist, hideIconVariant, action },
  ref,
) {
  const { closeSnackbar } = useSnackbar();
  const tk = toastTokens[useTheme().palette.mode];
  const accent = tk.accent[variant];
  const timed = !persist && !!autoHideDuration;
  return (
    <SnackbarContent
      ref={ref}
      role={variant === 'error' ? 'alert' : 'status'}
      className={`notistack-MuiContent notistack-MuiContent-${variant}`}
      style={{ display: 'block', flexGrow: 0, padding: 0, background: 'none', boxShadow: 'none' }}
    >
      <Box
        sx={{
          position: 'relative',
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'flex-start',
          gap: '10px',
          boxSizing: 'border-box',
          minWidth: 280,
          maxWidth: 'min(420px, calc(100vw - 32px))',
          p: '10px 6px 12px 12px',
          borderRadius: '10px',
          border: `1px solid ${tk.edge}`,
          bgcolor: tk.surface,
          boxShadow: tk.shadow,
          color: tk.text,
          '&:hover .toast-drain': { animationPlayState: 'paused' },
        }}
      >
        {!hideIconVariant && (
          <Box
            aria-hidden
            sx={{
              flex: 'none',
              width: 24,
              height: 24,
              mt: '1px',
              display: 'grid',
              placeItems: 'center',
              borderRadius: '7px',
              color: accent,
              bgcolor: `color-mix(in srgb, ${accent} 16%, transparent)`,
            }}
          >
            {ICONS[variant]}
          </Box>
        )}
        <Box sx={{ flex: 1, minWidth: 0, py: '3px', fontSize: 13, lineHeight: 1.55, fontWeight: 500, overflowWrap: 'anywhere' }}>
          {message}
          {action && (
            // 바로가기 단추는 글 아래 줄에 둔다. 다이얼로그의 Tier 2(윤곽선) 단추와 같은 모양이다.
            <Box
              sx={{
                mt: '8px',
                '& .MuiButton-root': { minWidth: 0, px: '10px', py: '2px', fontSize: 12, fontWeight: 500, color: tk.text, border: `1px solid ${tk.edge}`, borderRadius: '6px', '&:hover': { bgcolor: tk.closeHover } },
              }}
            >
              {typeof action === 'function' ? action(id) : action}
            </Box>
          )}
        </Box>
        <IconButton
          size="small"
          aria-label={t('toast.close')}
          onClick={() => closeSnackbar(id)}
          sx={{ flex: 'none', width: 24, height: 24, color: tk.muted, '&:hover': { color: tk.text, bgcolor: tk.closeHover }, '&.Mui-focusVisible': { boxShadow: `0 0 0 2px ${FOCUS_RING}` } }}
        >
          <CloseRoundedIcon sx={{ fontSize: 14 }} />
        </IconButton>
        {timed && (
          <Box
            aria-hidden
            className="toast-drain"
            sx={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              height: 2,
              bgcolor: accent,
              opacity: 0.6,
              transformOrigin: 'left center',
              animation: `${drain} ${autoHideDuration}ms linear forwards`,
              '@media (prefers-reduced-motion: reduce)': { display: 'none' },
            }}
          />
        )}
      </Box>
    </SnackbarContent>
  );
});

export const toastComponents = {
  default: AppToast,
  success: AppToast,
  error: AppToast,
  warning: AppToast,
  info: AppToast,
};
