/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 차트·다이어그램 블록 오른쪽 위의 세로 버튼 막대다(CogentAI 위젯과 같은 자리·순서).
// 마우스를 올리거나 키보드로 버튼에 들어오면 보이고, 마우스가 없는 화면(터치)에서는 늘 보인다.
import { Box, IconButton, Tooltip } from '@mui/material';
import type { ReactNode } from 'react';

export interface ViewerAction {
  key: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
}

// 블록 상자에 붙이는 sx: 막대를 hover·focus 때 보이게 한다.
export const viewerFrameSx = {
  position: 'relative',
  '&:hover .viewer-toolbar, &:focus-within .viewer-toolbar': { opacity: 1 },
  '@media (hover: none)': { '& .viewer-toolbar': { opacity: 1 } },
} as const;

export default function ViewerToolbar({ actions, always = false }: { actions: ViewerAction[]; always?: boolean }) {
  return (
    <Box
      className="viewer-toolbar"
      sx={{
        position: 'absolute',
        top: 8,
        right: 8,
        zIndex: 2,
        display: 'flex',
        flexDirection: 'column',
        gap: 0.5,
        opacity: always ? 1 : 0,
        transition: 'opacity 0.15s',
        '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
      }}
    >
      {actions.map((a) => (
        <Tooltip key={a.key} title={a.label} placement="left">
          <IconButton
            size="small"
            aria-label={a.label}
            onClick={a.onClick}
            sx={{
              bgcolor: 'background.paper',
              border: 1,
              borderColor: 'divider',
              color: 'text.secondary',
              '&:hover': { bgcolor: 'action.hover', color: 'text.primary' },
            }}
          >
            {a.icon}
          </IconButton>
        </Tooltip>
      ))}
    </Box>
  );
}
