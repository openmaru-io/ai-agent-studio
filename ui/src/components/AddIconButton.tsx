/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 화면 제목 옆의 「새 항목 추가」 아이콘(COP Console 의 제목 옆 + 아이콘과 같은 자리·모양). 글자는 없고 이름은 aria-label 과 설명(툴팁)으로 준다.
// 비활성일 때(상한·권한) 이유를 설명과 보조 기술에 함께 준다. 아이콘만 흐려지면 이유를 알 수 없기 때문이다.
import AddIcon from '@mui/icons-material/Add';
import AddCircleIcon from '@mui/icons-material/AddCircle';
import { Box, Button, IconButton, Tooltip } from '@mui/material';
import { visuallyHidden } from '@mui/utils';
import { useId } from 'react';

import { FOCUS_RING } from '@/lib/shellTokens';

export interface AddAction {
  /** 만들 것의 이름. 예: 「새 프로파일」. 설명과 aria-label 에 쓴다 */
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** 비활성일 때만 보이고 읽힌다 */
  disabledReason?: string;
  /** 화면에 이미 이유 글이 있을 때 그 요소의 id(없으면 disabledReason 으로 만든다) */
  describedBy?: string;
  /** 가이드(따라하기)가 강조하는 자리의 data-guide 값 */
  guide?: string;
}

export function AddIconButton({ label, onClick, disabled, disabledReason, describedBy, guide }: AddAction) {
  const whyId = useId();
  const showWhy = !!disabled && !!disabledReason;
  return (
    <Tooltip title={showWhy ? `${label}: ${disabledReason}` : label}>
      {/* 비활성 단추는 마우스 이벤트를 받지 못해 감싸는 span 이 설명을 띄운다 */}
      <span style={{ display: 'inline-flex' }} data-guide={guide}>
        <IconButton
          aria-label={label}
          aria-describedby={showWhy ? whyId : describedBy}
          disabled={disabled}
          onClick={onClick}
          size="small"
          sx={{
            color: 'text.primary',
            p: '2px',
            // 키보드 포커스 링(DESIGN.md §1-1.5, 무채색 토큰 2026-10-19-014)
            '&.Mui-focusVisible': { boxShadow: `0 0 0 2px ${FOCUS_RING}` },
          }}
        >
          <AddCircleIcon sx={{ fontSize: 24 }} />
        </IconButton>
        {showWhy && (
          <Box id={whyId} component="span" sx={visuallyHidden}>
            {disabledReason}
          </Box>
        )}
      </span>
    </Tooltip>
  );
}

/**
 * 표 툴바 오른쪽 끝의 「+ 새 …」 글자 단추. 제목 옆 + 아이콘과 같은 동작을 표 가까이에도 둔다.
 * 모양은 프로파일 서랍 스킬 탭의 「새 스킬」 단추와 같다(outlined·inherit). 비활성 이유는 AddIconButton 과 같은 방식으로 준다.
 */
export function AddButton({ label, onClick, disabled, disabledReason, describedBy, guide }: AddAction) {
  const whyId = useId();
  const showWhy = !!disabled && !!disabledReason;
  return (
    <Tooltip title={showWhy ? disabledReason : ''}>
      <span style={{ display: 'inline-flex' }} data-guide={guide}>
        <Button
          startIcon={<AddIcon />}
          size="small"
          variant="outlined"
          color="inherit"
          aria-describedby={showWhy ? whyId : describedBy}
          disabled={disabled}
          onClick={onClick}
          sx={{ flexShrink: 0, whiteSpace: 'nowrap', '&.Mui-focusVisible': { boxShadow: `0 0 0 2px ${FOCUS_RING}` } }}
        >
          {label}
        </Button>
        {showWhy && (
          <Box id={whyId} component="span" sx={visuallyHidden}>
            {disabledReason}
          </Box>
        )}
      </span>
    </Tooltip>
  );
}
