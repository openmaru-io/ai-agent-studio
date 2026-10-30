/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 파일 뷰어 머리(LazyFileViewer)와 본문(FileViewer)이 함께 쓰는 작은 부품·함수(스펙 2026-10-20-002 §3-5).
// 두 파일이 서로 불러오지 않게 여기에 둔다 — 본문은 처음 열 때 받는 묶음이다(R9).
import BrokenImageOutlinedIcon from '@mui/icons-material/BrokenImageOutlined';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import { Box, Button, Skeleton, Stack, Typography } from '@mui/material';

import { useChatTokens } from '@/components/chat/useChatTokens';
import { t } from '@/i18n';
import { PARTIAL_OK, VIEW_LIMIT, type ViewerKind, viewerKind } from '@/lib/fileKinds';

import { FIT_MAX } from './docs/docMath';
import { FileIcon } from './FileBadge';
import type { ViewerFile } from './viewerStore';

/** 처음부터 작은 창(최대 480px)으로 여는가(DD8): 미리 볼 수 없는 형식, 크기를 알고 한도를 넘는 그림·PDF·영상 */
export function startsSmall(f: ViewerFile): boolean {
  const kind = viewerKind(f.name);
  if (kind === 'other' || f.blocked) return true;
  return f.size != null && f.size > VIEW_LIMIT[kind] && !PARTIAL_OK.has(kind);
}

/** 오늘이면 01:28, 올해면 10/19 10:06, 그 전이면 2025-12-30(§3-7 시각 표기) */
export function fmtWhen(sec: number, now = new Date()): string {
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (d.getFullYear() === now.getFullYear()) return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function sourceLabel(f: ViewerFile): string {
  const place = f.place || '';
  switch (f.source) {
    case 'upload':
      return t('chat.viewer.srcUpload');
    case 'agent':
      return t('chat.viewer.srcAgent');
    case 'meeting-in':
      return t('chat.viewer.srcMeetingIn', { room: place });
    case 'meeting-out':
      return t('chat.viewer.srcMeetingOut', { room: place });
    case 'kanban':
      return t('chat.viewer.srcKanban', { board: place });
  }
}

/** 받기 — 받기 주소는 Content-Disposition attachment 라 브라우저가 디스크로 받는다 */
export function saveFile(f: ViewerFile) {
  const a = document.createElement('a');
  a.href = f.url;
  a.download = f.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** 문서 형식(스펙 2026-10-20-005)인가 — 책상·종이 모양으로 그리고 머리에 쪽·확대 단추를 둔다 */
export const isDocKind = (kind: ViewerKind) => kind === 'pdf' || kind === 'docx' || kind === 'xlsx' || kind === 'pptx' || kind === 'hwp';

/** 문서를 받는 동안의 뼈대(디자인 DV8): 책상 위에 A4 비율 종이. 그린 뒤와 같은 자리를 차지해 열릴 때 화면이 튀지 않는다 */
export function DocSkeleton({ kind }: { kind?: ViewerKind } = {}) {
  const tk = useChatTokens();
  if (kind === 'xlsx')
    return (
      <Box sx={{ flex: 1, minHeight: 0, overflow: 'hidden', p: 2 }} aria-busy="true" aria-label={t('chat.viewer.loading')}>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '1px', bgcolor: tk.line, border: `1px solid ${tk.line}` }}>
          {Array.from({ length: 48 }, (_, i) => (
            <Box key={i} sx={{ height: 28, bgcolor: i < 6 ? tk.rail : tk.popup.surface }} />
          ))}
        </Box>
      </Box>
    );
  return (
    <Stack alignItems="center" sx={{ flex: 1, minHeight: 0, overflow: 'hidden', bgcolor: tk.sunken, p: { xs: 1, sm: 3 } }} aria-busy="true" aria-label={t('chat.viewer.loading')}>
      <Box sx={{ width: '100%', maxWidth: FIT_MAX, aspectRatio: kind === 'pptx' ? '16 / 9' : '210 / 297', bgcolor: '#fff', border: `1px solid ${tk.popup.edge}`, p: 4 }}>
        <Stack spacing={1.25}>
          <Skeleton variant="rounded" height={18} width="55%" sx={{ bgcolor: 'rgba(17,24,39,0.08)' }} />
          <Skeleton variant="rounded" height={12} width="90%" sx={{ bgcolor: 'rgba(17,24,39,0.06)' }} />
          <Skeleton variant="rounded" height={12} width="85%" sx={{ bgcolor: 'rgba(17,24,39,0.06)' }} />
          <Skeleton variant="rounded" height={12} width="70%" sx={{ bgcolor: 'rgba(17,24,39,0.06)' }} />
        </Stack>
      </Box>
    </Stack>
  );
}

export function BodySkeleton({ kind }: { kind?: ViewerKind } = {}) {
  if (kind && isDocKind(kind)) return <DocSkeleton kind={kind} />;
  return (
    <Stack spacing={1} sx={{ p: 2 }} aria-busy="true" aria-label={t('chat.viewer.loading')}>
      <Skeleton variant="rounded" height={20} width="60%" />
      <Skeleton variant="rounded" height={20} width="85%" />
      <Skeleton variant="rounded" height={20} width="75%" />
      <Skeleton variant="rounded" height={160} />
    </Stack>
  );
}

/** 미리 볼 수 없음·한도 넘음·받을 수 없음(DD8). 받기는 머리의 주 단추가 맡는다(처음 포커스) */
export function Notice({ file, text }: { file: ViewerFile; text: string }) {
  const tk = useChatTokens();
  return (
    <Stack alignItems="center" spacing={1.5} sx={{ p: 4, textAlign: 'center' }}>
      <Box sx={{ color: tk.muted }}>
        <FileIcon name={file.name} size={48} />
      </Box>
      <Typography sx={{ fontSize: 14, color: tk.text }}>{text}</Typography>
    </Stack>
  );
}

/** 실패 한 모양(DD6): 아이콘 + 이유 한 줄 + 다시 시도(Tier 2) + 받기(Tier 1). 새 버전 배포면 다시 시도 자리가 「새로 고침」(005 디자인 DV2) */
export function Failure({ file, reason, onRetry, image, refresh }: { file: ViewerFile; reason: string; onRetry?: () => void; image?: boolean; refresh?: boolean }) {
  const tk = useChatTokens();
  return (
    <Stack alignItems="center" justifyContent="center" spacing={1.5} sx={{ flex: 1, p: 4, textAlign: 'center' }}>
      {image ? <BrokenImageOutlinedIcon sx={{ fontSize: 40, color: tk.muted }} /> : <ErrorOutlineIcon sx={{ fontSize: 40, color: tk.muted }} />}
      <Typography role="alert" sx={{ fontSize: 14, color: tk.text }}>
        {reason}
      </Typography>
      <Stack direction="row" spacing={1}>
        {refresh ? (
          <Button variant="outlined" size="small" startIcon={<RefreshIcon />} onClick={() => window.location.reload()}>
            {t('chat.viewer.doc.refresh')}
          </Button>
        ) : (
          onRetry && (
            <Button variant="outlined" size="small" startIcon={<RefreshIcon />} onClick={onRetry}>
              {t('chat.viewer.retry')}
            </Button>
          )
        )}
        {!file.blocked && (
          <Button variant="contained" size="small" startIcon={<FileDownloadOutlinedIcon />} onClick={() => saveFile(file)}>
            {t('chat.viewer.download')}
          </Button>
        )}
      </Stack>
    </Stack>
  );
}
