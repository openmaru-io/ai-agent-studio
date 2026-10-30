/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 화면 위에 떠 있는 대화 창의 껍데기(OMAI-1115, 회의실 채팅 OMAI-1257). 에이전트 대화(ChatPopup)와 회의실 대화(RoomChatPopup)가 함께 쓴다.
// - 끌어서 옮기고(머리), 오른쪽 아래 모서리를 끌어 크기를 바꾼다. 방향키로도 된다. 위치·크기는 rectKey 로 기억한다.
// - 최소화해도 안쪽을 언마운트하지 않는다 — 대화는 마운트돼 있을 때만 답을 받아 온다.
// - 좁은 화면에서는 상단 막대 아래 전체를 덮는다.
// - 창이 둘 이상 뜰 수 있으므로 slot 으로 기본 자리(왼쪽으로 한 칸씩)와 최소화 칩 자리(위로 한 칸씩)를 나눈다.
//   마지막으로 누른 창이 위에 온다.
// zIndex 는 상단 막대(서랍+1)보다 위, MUI 대화상자(1300)보다 아래다 — 창 안의 메뉴는 그 위에 뜬다.
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import CloseIcon from '@mui/icons-material/Close';
import MinimizeIcon from '@mui/icons-material/Minimize';
import { Box, Chip, IconButton, Paper, Portal, Tooltip, Typography, useMediaQuery, useTheme } from '@mui/material';
import { ReactNode, useSyncExternalStore } from 'react';

import { t } from '@/i18n';
import { initialDetailDrawerWidth, useContentTopOffset } from '@/lib/detailDrawer';
import { popupStanding, raisePopup, subscribePopupFront } from '@/lib/popupOrder';

import { useChatTokens } from './chat/useChatTokens';
import { useUiOptional } from './UiContext';
import { useFloatingWindow } from './useFloatingWindow';
import { useKeepVisible } from './useKeepVisible';

const WIDTH = 440;
const GAP = 16;
const CHIP_STEP = 40;

export interface FloatingChatShellProps {
  /** 위치·크기를 기억하는 localStorage 키. 창마다 다르다 */
  rectKey: string;
  /** 머리줄 글자 */
  title: string;
  /** 창의 접근성 이름(role=dialog) */
  ariaLabel: string;
  /** 최소화 칩 글자 */
  chipLabel: string;
  /** 최소화 칩의 접근성 이름 */
  restoreLabel: string;
  /** 최소화한 동안 알릴 일(대화를 다시 열지 못함 등, 스펙 2026-10-20-030 DR14). 있으면 칩에 빨간 점과 이 글을 더한다 */
  alert?: string;
  minimized: boolean;
  onMinimize: () => void;
  onRestore: () => void;
  onClose: () => void;
  /** 0 이면 오른쪽 아래, 1 이면 그 왼쪽 옆. 최소화 칩은 한 칸씩 위로 쌓는다 */
  slot?: number;
  /** 머리줄의 최소화 단추 앞에 두는 단추(확대 등) */
  actions?: ReactNode;
  /** 본문 안쪽 여백(MUI 간격 단위) */
  bodyPadding?: number;
  children: ReactNode;
}

export function FloatingChatShell({
  rectKey,
  title,
  ariaLabel,
  chipLabel,
  restoreLabel,
  alert,
  minimized,
  onMinimize,
  onRestore,
  onClose,
  slot = 0,
  actions,
  bodyPadding = 0,
  children,
}: FloatingChatShellProps) {
  const theme = useTheme();
  const small = useMediaQuery(theme.breakpoints.down('sm'));
  const top = useContentTopOffset();
  const ui = useUiOptional();
  const keep = useKeepVisible();
  const tk = useChatTokens();
  const standing = useSyncExternalStore(subscribePopupFront, () => popupStanding(rectKey));
  const isFront = standing === 'front';
  const { rect, moveHandle, resizeHandle } = useFloatingWindow(rectKey, () => {
    const h = Math.min(640, window.innerHeight - top - 32);
    const right = ui?.drawer ? initialDetailDrawerWidth() : 0; // 서랍이 열려 있으면 그 왼쪽에 띄운다
    return { x: window.innerWidth - right - WIDTH - 24 - slot * (WIDTH + GAP), y: window.innerHeight - h - 24, w: WIDTH, h };
  });
  const z = theme.zIndex.drawer + 2 + (isFront ? 1 : 0);

  return (
    <Portal>
      <div ref={keep}>
        {minimized && (
          <Chip
            color="primary"
            label={chipLabel}
            icon={alert ? <Box component="span" aria-hidden="true" sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: '#ef5350', ml: '8px !important' }} /> : undefined}
            onClick={onRestore}
            onDelete={onClose}
            aria-label={alert ? `${restoreLabel} · ${alert}` : restoreLabel}
            sx={{ position: 'fixed', right: 24, bottom: 24 + slot * CHIP_STEP, zIndex: z, boxShadow: 4 }}
          />
        )}
        <Paper
          role="dialog"
          aria-modal={false}
          aria-label={ariaLabel}
          elevation={0}
          onPointerDownCapture={() => raisePopup(rectKey)}
          sx={{
            position: 'fixed',
            zIndex: z,
            display: minimized ? 'none' : 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            // 창을 자기 GPU 층으로 고정한다(스펙 2026-10-21-009). 없으면 CPU 가 바쁠 때 Chrome 이 창 타일을 제때 못 그려
            // 아래 3D 오피스 캔버스가 한 프레임 창 위로 비쳐 보였다
            willChange: 'transform',
            transform: 'translateZ(0)',
            contain: 'paint',
            borderRadius: small ? 0 : '12px',
            // 면·테두리·그림자로 서랍·페이지와 가른다(OMAI-1265). 앞 창(또는 혼자일 때)이 더 또렷한 테두리를 가진다
            bgcolor: tk.popup.surface,
            border: '1px solid',
            borderColor: standing === 'back' ? tk.popup.edge : tk.popup.edgeFront,
            boxShadow: small ? 'none' : `${tk.popup.shadow}, ${tk.popup.highlight}`,
            ...(small ? { left: 0, right: 0, bottom: 0, top: `${top}px` } : {}),
          }}
          // 위치·크기는 인라인 style 로 준다 — 끄는 동안 sx 로 주면 움직일 때마다 CSS 클래스를 새로 만든다
          style={small ? undefined : { left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, px: 1, py: 0.5, bgcolor: tk.popup.head, borderBottom: `1px solid ${tk.line}` }}>
            <Box
              role="button"
              tabIndex={0}
              aria-label={t('chat.popupMove')}
              {...(small ? {} : moveHandle)}
              sx={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 1, cursor: small ? 'default' : 'move', userSelect: 'none', touchAction: 'none', py: 0.5 }}
            >
              <ChatBubbleOutlineIcon fontSize="small" color="action" sx={{ flexShrink: 0 }} />
              <Typography variant="subtitle2" noWrap>
                {title}
              </Typography>
            </Box>
            {actions}
            <Tooltip title={t('chat.popupMinimize')}>
              <IconButton size="small" aria-label={t('chat.popupMinimize')} onClick={onMinimize}>
                <MinimizeIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title={t('chat.popupClose')}>
              <IconButton size="small" aria-label={t('chat.popupClose')} onClick={onClose}>
                <CloseIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Box>
          <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', p: bodyPadding }}>{children}</Box>
          {!small && (
            <Box
              role="separator"
              tabIndex={0}
              aria-label={t('chat.popupResize')}
              aria-orientation="vertical"
              {...resizeHandle}
              sx={{
                position: 'absolute',
                right: 0,
                bottom: 0,
                width: 16,
                height: 16,
                cursor: 'nwse-resize',
                touchAction: 'none',
                background: `linear-gradient(135deg, transparent 50%, ${theme.palette.divider} 50%)`,
              }}
            />
          )}
        </Paper>
      </div>
    </Portal>
  );
}
