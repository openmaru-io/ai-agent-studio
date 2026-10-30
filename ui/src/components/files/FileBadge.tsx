/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 파일 이름 뱃지(스펙 2026-10-20-002 §3-1, 디자인 리뷰 DD1·DD4·DD12·DD13·DD16·DD18). 누르면 파일 뷰어를 연다.
// 알약(pill)은 입력창·보낸 말풍선·답 아래·회의·칸반, 글 안(inline)은 답 본문 문장 속. 전체 경로는 화면 글자·접근 이름에 넣지 않는다.
import ArchiveOutlinedIcon from '@mui/icons-material/ArchiveOutlined';
import DataObjectOutlinedIcon from '@mui/icons-material/DataObjectOutlined';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import MovieOutlinedIcon from '@mui/icons-material/MovieOutlined';
import PictureAsPdfOutlinedIcon from '@mui/icons-material/PictureAsPdfOutlined';
import TableChartOutlinedIcon from '@mui/icons-material/TableChartOutlined';
import { Box, ButtonBase, type SvgIconProps,useTheme } from '@mui/material';
import type { ReactNode } from 'react';

import { useChatTokens } from '@/components/chat/useChatTokens';
import { t } from '@/i18n';
import { humanSize, middleEllipsis, reasonText } from '@/lib/chatFiles';
import { chatMetrics } from '@/lib/chatTokens';
import { type IconKind,iconKind } from '@/lib/fileKinds';
import { FOCUS_RING } from '@/lib/shellTokens';

import { INLINE_HINT_ID, openViewer, type ViewerActions, type ViewerFile } from './viewerStore';

const ICONS: Record<IconKind, (p: SvgIconProps) => ReactNode> = {
  image: (p) => <ImageOutlinedIcon {...p} />,
  pdf: (p) => <PictureAsPdfOutlinedIcon {...p} />,
  table: (p) => <TableChartOutlinedIcon {...p} />,
  doc: (p) => <DescriptionOutlinedIcon {...p} />,
  code: (p) => <DataObjectOutlinedIcon {...p} />,
  archive: (p) => <ArchiveOutlinedIcon {...p} />,
  media: (p) => <MovieOutlinedIcon {...p} />,
  file: (p) => <InsertDriveFileOutlinedIcon {...p} />,
};

/** 확장자 → 아이콘. 서랍 종류 타일·뷰어 머리도 같은 함수(§3-7) */
export function FileIcon({ name, size = 16 }: { name: string; size?: number }) {
  return ICONS[iconKind(name)]({ sx: { fontSize: size, flexShrink: 0 }, 'aria-hidden': true });
}

/** 「회의」 표지 — DESIGN §4 Subtle Badge(DD13) */
export function MeetingMark() {
  const dark = useTheme().palette.mode === 'dark';
  const tk = useChatTokens();
  return (
    <Box
      component="span"
      sx={{
        px: 0.5,
        fontSize: 10,
        fontWeight: 500,
        lineHeight: '16px',
        borderRadius: '2px',
        bgcolor: dark ? 'rgba(255,255,255,0.05)' : 'rgba(17,24,39,0.05)',
        color: tk.muted,
        flexShrink: 0,
      }}
    >
      {t('chat.files.meetingMark')}
    </Box>
  );
}

export interface FileBadgeProps {
  file: ViewerFile;
  actions?: ViewerActions;
  variant?: 'pill' | 'inline';
  /** 크기 글자(알약만). 없으면 file.size 를 쓴다 */
  sizeLabel?: string;
  /** 이름 최대 폭(px 또는 CSS 값)과 가운데 줄임 글자 수(DD12: 입력창 200·20, 그 밖 180·28) */
  maxName?: number | string;
  ellipsis?: number;
  /** 「수정」 표지(답 아래 바뀐 파일) */
  modified?: boolean;
  /** 지운 파일(취소선) */
  deleted?: boolean;
  /** 올리기 실패·보낼 때 거절(빨간 테두리, DD5) */
  error?: boolean;
  /** 올리는 중 진행 막대(0~100). 있으면 누르지 않는다 */
  progress?: number;
  /** 진행 막대의 접근 이름 */
  progressLabel?: string;
  /** 뱃지 안 오른쪽 덧붙임(입력창의 ✕·다시) */
  trailing?: ReactNode;
  /** 누를 때 뷰어 대신 할 일(올리는 중 등은 undefined 로 막는다) */
  disabled?: boolean;
}

/** 뷰어를 여는 뱃지. 받을 수 없음·지움도 눌러서 이유를 본다(DD4) */
export function FileBadge(props: FileBadgeProps) {
  const { file, actions, variant = 'pill', modified, deleted, error, progress, trailing, disabled } = props;
  const tk = useChatTokens();
  const dark = useTheme().palette.mode === 'dark';
  const meeting = file.source === 'meeting-in' || file.source === 'meeting-out';
  const blocked = deleted ? 'deleted' : file.blocked;
  const open = (e: { currentTarget: HTMLElement }) => openViewer(deleted ? { ...file, blocked: 'deleted' } : file, actions, e.currentTarget);
  const busy = progress != null;

  if (variant === 'inline')
    return (
      <ButtonBase
        component="span"
        onClick={open}
        aria-label={file.name}
        aria-describedby={INLINE_HINT_ID}
        aria-haspopup="dialog"
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '3px',
          verticalAlign: '-3px',
          height: 20,
          px: '4px',
          maxWidth: '100%',
          borderRadius: '4px',
          font: 'inherit',
          color: dark ? '#d0d6e0' : '#374151',
          whiteSpace: 'nowrap',
          position: 'relative',
          textDecoration: deleted ? 'line-through' : 'none',
          '&:hover': { textDecoration: 'underline' },
          '&:focus-visible': { outline: `2px solid ${FOCUS_RING}`, outlineOffset: -2 },
          // 터치 화면은 높이를 늘리지 않고 누르는 영역만 넓힌다(DD1)
          '&::after': { content: '""', position: 'absolute', inset: '-12px 0' },
        }}
      >
        <FileIcon name={file.name} size={14} />
        {meeting && <MeetingMark />}
        <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {middleEllipsis(file.name, props.ellipsis ?? 40)}
        </Box>
      </ButtonBase>
    );

  const size = props.sizeLabel ?? (file.size != null ? humanSize(file.size) : '');
  const label = blocked ? t('chat.files.openBlockedAria', { name: file.name, reason: (file.reasonOf ?? reasonText)(blocked) }) : t('chat.files.openAria', { name: file.name });
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        maxWidth: '100%',
        minHeight: 28,
        border: 1,
        borderColor: error ? 'error.main' : tk.line,
        borderRadius: '9999px',
        color: tk.text,
        fontSize: 12,
        fontWeight: 500,
        position: 'relative',
        overflow: 'hidden',
        opacity: blocked ? 0.55 : 1,
        '@media (pointer: coarse)': { minHeight: chatMetrics.touch },
      }}
    >
      <ButtonBase
        onClick={busy || disabled ? undefined : open}
        disabled={busy || disabled}
        aria-label={label}
        aria-haspopup="dialog"
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.5,
          minWidth: 0,
          alignSelf: 'stretch',
          pl: '6px',
          pr: trailing ? '2px' : '8px',
          font: 'inherit',
          color: 'inherit',
          borderRadius: '9999px',
          textDecoration: deleted ? 'line-through' : 'none',
          '&:hover': { bgcolor: tk.hover },
          '&:focus-visible': { outline: `2px solid ${FOCUS_RING}`, outlineOffset: -2 },
        }}
      >
        <FileIcon name={file.name} />
        {meeting && <MeetingMark />}
        <Box component="span" sx={{ minWidth: 0, maxWidth: props.maxName ?? chatMetrics.chipMax, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {middleEllipsis(file.name, props.ellipsis ?? 28)}
        </Box>
        {size && (
          <Box component="span" sx={{ color: error ? 'error.main' : tk.muted, whiteSpace: 'nowrap', flexShrink: 0 }}>
            {size}
          </Box>
        )}
        {modified && (
          <Box component="span" sx={{ px: 0.5, fontSize: 10, borderRadius: '2px', bgcolor: 'action.selected', flexShrink: 0 }}>
            {t('chat.files.modified')}
          </Box>
        )}
      </ButtonBase>
      {trailing}
      {busy && (
        <Box
          role="progressbar"
          aria-label={props.progressLabel}
          aria-valuenow={progress}
          aria-valuemin={0}
          aria-valuemax={100}
          sx={{ position: 'absolute', left: 0, bottom: 0, height: 2, width: `${progress}%`, bgcolor: 'text.primary', transition: 'width 120ms linear' }}
        />
      )}
    </Box>
  );
}

