/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 서랍 본문 안에서만 공통 표시 조각(bits)의 모양을 바꾼다. 전체 화면에 쓰인 같은 조각은 그대로 둔다.
// 모양은 COP Console 상세 Drawer 의 이름·값 표(`common/NameValueTable`)와 DESIGN.md §3·§4 를 따른다.
// - 이름·값(KV): 위아래 선과 줄 사이 선으로 나눈 표. 13px, 칸 여백 7px 12px. 이름은 보조 글자색. 맨 위에 머리줄(항목·값)
// - 묶음(Section): 묶음 사이 24px, 제목 13px 굵게, 제목과 내용 사이 12px, 내용은 22px 들여 씀(개수 뱃지 모양은 Section 자체에 있다)
// - 목록(RowList): 글머리표 없이 줄 사이 선
// - 칩: Neutral Pill 처럼 옅은 테두리, 올리면 옅은 바탕(색을 쓰지 않는다, DESIGN.md §1-1.2)
import { alpha, Theme } from '@mui/material';
import type { SystemStyleObject } from '@mui/system';

import { monoFont } from './bits';

export const drawerBodySx = (theme: Theme): SystemStyleObject<Theme> => {
  const line = `1px solid ${theme.palette.divider}`;
  return {
    // 맨 앞 설명 문단
    '& > p.MuiTypography-body1:first-of-type': {
      color: 'text.secondary',
      lineHeight: 1.7,
      mb: 2,
    },
    '& .aas-kv': {
      columnGap: 0,
      rowGap: 0,
      borderTop: line,
      borderBottom: line,
      '& dt, & dd': {
        fontSize: 13,
        lineHeight: 1.6,
        px: 1.5,
        py: '7px',
        borderBottom: line,
        minWidth: 0,
      },
      '& dt': { color: 'text.secondary', minWidth: 88 },
      // 머리줄(항목·값): 표 머리처럼 옅은 바탕·작은 굵은 글자(서랍 안에서만 그린다)
      '& > .aas-kv-head > dt, & > .aas-kv-head > dd': {
        fontSize: 12,
        fontWeight: 600,
        color: 'text.secondary',
        py: '6px',
        bgcolor: alpha(theme.palette.text.primary, 0.03),
      },
      '& dd': { color: 'text.primary', overflowWrap: 'anywhere' },
      // 마지막 줄은 표의 아래 선과 겹치지 않게 한다
      '& > div:last-of-type > dt, & > div:last-of-type > dd': { borderBottom: 'none' },
      '& code': { fontFamily: monoFont, fontSize: 12 },
    },
    '& .aas-section': { mt: 3 },
    // 서랍 맨 위 섹션(KV 의 「기본 정보」 등)은 머리 바로 아래라 위 여백을 두지 않는다
    '& > .aas-section:first-child': { mt: 0 },
    '& .aas-section-head': {
      display: 'flex',
      alignItems: 'center',
      fontSize: 13,
      fontWeight: 600,
      color: 'text.primary',
      mb: 1.5,
    },
    // 제목 아래 내용은 제목 글자 자리(아이콘 16px + 사이 6px)에서 시작한다. 제목은 그대로 둔다
    '& .aas-section-body': { pl: '22px' },
    '& .aas-list': {
      listStyle: 'none',
      pl: 0,
      // 제목이 위 경계 역할을 하므로 위 선과 마지막 줄 아래 선은 긋지 않는다(선이 겹쳐 무거워진다)
      '& > li': { py: 1 },
      '& > li + li': { borderTop: line },
      '& > li:first-of-type': { pt: 0 },
      '& > li .aas-mono': { mt: 0.5 },
    },
    // 상태 뱃지(Tag, 색 있음)는 그대로 두고 회색 칩(링크·동작)만 바꾼다
    '& .MuiChip-outlined.MuiChip-colorDefault': {
      borderColor: theme.palette.divider,
      color: 'text.secondary',
      '&.MuiChip-clickable:hover': { bgcolor: alpha(theme.palette.text.primary, 0.06), color: 'text.primary' },
    },
    '& .aas-footnote': {
      mt: 3,
      pt: 1.5,
      borderTop: line,
      color: 'text.disabled',
    },
  };
};
