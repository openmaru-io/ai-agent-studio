/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 숨겨진 루트(default)에 붙이는 「사용 금지」 표식(OMAI-1268). 「루트(숨김)」 알약만으로는 에이전트로 쓰면 안 된다는 점이 눈에 띄지 않았다.
// 경고 색(호박색)에 금지 아이콘을 더하고, 이유는 툴팁으로 읽는다.
import BlockIcon from '@mui/icons-material/Block';
import { Box, Tooltip } from '@mui/material';

import { Tag } from '@/components/bits';
import { Pill } from '@/components/DataGrid';
import { t } from '@/i18n';

const mark = (
  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
    <BlockIcon aria-hidden="true" sx={{ fontSize: 12 }} />
    {t('profiles.doNotUse')}
  </Box>
);

/** 목록의 이름 옆(표 안) */
export function DoNotUsePill() {
  return (
    <Tooltip title={t('profiles.doNotUseTip')}>
      <span>
        <Pill tone="warn">{mark}</Pill>
      </span>
    </Tooltip>
  );
}

/** 상세 머리의 뱃지 줄 */
export function DoNotUseTag() {
  return (
    <Tooltip title={t('profiles.doNotUseTip')}>
      <span>
        <Tag tone="warn">{mark}</Tag>
      </span>
    </Tooltip>
  );
}
