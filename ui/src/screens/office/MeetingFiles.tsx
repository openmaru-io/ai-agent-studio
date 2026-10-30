/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 회의 파일 화면 부품(스펙 2026-10-15-015 §4-5, API 계약은 같은 스펙 §4-6). 입력 카드의 첨부 단추·칩·진행 막대,
// 말풍선 첨부 칩, 에이전트 결과 파일 칩, 「자료」 서랍 본문. 채팅 파일 화면(screens/chat/files.tsx)은 건드리지 않고
// 크기·이름 줄임 같은 순수 함수만 lib/chatFiles 에서 가져온다. 색은 대화 토큰(useChatTokens)만 쓴다.
import AttachFileIcon from '@mui/icons-material/AttachFile';
import CloseIcon from '@mui/icons-material/Close';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import UploadFileOutlinedIcon from '@mui/icons-material/UploadFileOutlined';
import { Box, Button, ButtonBase, IconButton, LinearProgress, Skeleton, Stack, Tooltip, Typography } from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { DragEvent, useEffect, useReducer, useRef, useState } from 'react';

import { MessageRow } from '@/components/chat/MessageRow';
import { useChatTokens } from '@/components/chat/useChatTokens';
import { useConfirm } from '@/components/ConfirmDialog';
import { FileBadge, FileIcon } from '@/components/files/FileBadge';
import { FileSearch, GroupHead } from '@/components/files/FileGroups';
import { fmtWhen } from '@/components/files/viewerParts';
import { openViewer, type ViewerActions, type ViewerFile } from '@/components/files/viewerStore';
import { getLang, hasKey, t } from '@/i18n';
import { ApiError, del, get, post } from '@/lib/api';
import { humanSize } from '@/lib/chatFiles';
import { chatMetrics, chatType } from '@/lib/chatTokens';
import { isAdmin, useMe } from '@/lib/data';
import { fmtTs } from '@/lib/format';
import { FOCUS_RING } from '@/lib/shellTokens';
import { AgentAvatar } from '@/screens/chat/parts';

// ---- 서버 계약 모양(meeting-files-api-contract) ----

export interface FilesInfo {
  enabled: boolean;
  limits: { file: number; room: number; total: number };
  max_per_message: number;
}
export interface AttachFile {
  id: string;
  name: string;
  size: number;
}
export interface AttachData {
  files?: AttachFile[];
  undelivered?: string[];
}
export interface AgentFileRef {
  path: string;
  name: string;
  size: number;
  room?: string; // 자동으로 방 자료에 올라간 파일 id
  skip?: string; // 자동 올리기를 건너뛴 이유(오류 코드)
}
export interface AgentFilesData {
  pod?: string;
  files?: AgentFileRef[];
}
export interface SkippedAgent {
  alias: string;
  reason: string;
}
interface RoomFile {
  id: string;
  name: string;
  size: number;
  uploader: string;
  ts: string;
  date: string;
  status: string;
  msg: number | null;
}
interface OutFile {
  path: string;
  name: string;
  size: number;
  mtime: number;
  alias: string;
  date: string;
}
/** 방 기록의 결과 칩 행에 남은 파일(에이전트가 자기 작업 폴더에 쓴 것). 받기·방에 올리기는 (msg, n) 으로 */
interface MadeFile {
  msg: number;
  n: number;
  alias: string;
  ts: string;
  path: string;
  name: string;
  size: number;
}
interface FilesList {
  files: RoomFile[];
  out: OutFile[];
  made?: MadeFile[];
  used: { room: number; total: number };
  out_truncated: boolean;
  /** 올린 사람(이메일)·에이전트 별칭 → 화면 이름(사람 이름, 「주인 · 에이전트 이름」). 없으면 값 그대로(스펙 2026-10-20-025 §6) */
  labels?: Record<string, string>;
}

const MAX_NAME = 22; // 칩에 보이는 이름 글자 수(가운데를 줄이고 확장자는 남긴다, 전체 이름은 title)
const PARALLEL = 2; // 동시에 올리는 수(채팅과 같다)
const NOTICE_KEY = 'aas.meetingFileNotice';

const filesUrl = (room: number, id: string) => `/api/office/meeting/files/${encodeURIComponent(id)}?room=${room}`;
const outUrl = (room: number, path: string) => `/api/office/meeting/out?room=${room}&path=${encodeURIComponent(path)}`;
const agentFileUrl = (room: number, msg: number, n: number) =>
  `/api/office/meeting/agent-file?room=${room}&msg=${msg}&n=${n}`;

/** 서버 오류 코드(또는 화면 검사 코드) → 문구. 모르는 코드는 일반 문구. */
export function fileReason(code?: string, info?: FilesInfo): string {
  const key = `office.meetingFileReason.${code || 'unknown'}`;
  if (!hasKey(key)) return t('office.meetingFileReason.unknown');
  return t(key, {
    max: info ? humanSize(info.limits.file) : '',
    room: info ? humanSize(info.limits.room) : '',
    count: info?.max_per_message ?? 10,
  });
}

/** 요청 오류의 글자. 서버가 코드만 보내는 오류(no_receiver·bad_file 등)는 번역하고, 문장이면 그대로 쓴다. */
export function fileErrorText(e: unknown, info?: FilesInfo): string {
  // 말하기(`say`) 오류는 서버가 문장을 `error` 에, 코드를 `reason` 에 보낸다(no_receiver·bad_file 등). 코드가 사전에 있으면 그것을 번역한다.
  const r = e instanceof ApiError ? e.reason : '';
  if (r && /^[a-z_]+$/.test(r) && hasKey(`office.meetingFileReason.${r}`)) return fileReason(r, info);
  const m = e instanceof Error ? e.message : '';
  if (/^[a-z_]+$/.test(m) && hasKey(`office.meetingFileReason.${m}`)) return fileReason(m, info);
  return m || fileReason('unknown', info);
}

const statusCode = (status: number): string =>
  ({
    401: 'login',
    403: 'forbidden',
    404: 'no_room',
    409: 'room_closed',
    413: 'too_large',
    429: 'busy',
    501: 'not_configured',
    502: 'io_error',
  }[status] ?? 'unknown');

// ---- 올리기(입력 카드) ----

export interface MUpload {
  key: string;
  room: number;
  file: File;
  name: string;
  size: number;
  state: 'wait' | 'up' | 'done' | 'fail';
  pct: number;
  id?: string;
  code?: string;
  xhr?: XMLHttpRequest;
  retried?: boolean;
}

/** 폐쇄 환경 안내를 이미 봤는가. 저장소를 못 써도(throw) 동작한다. */
const noticeSeen = () => {
  try {
    return localStorage.getItem(NOTICE_KEY) === '1';
  } catch {
    return false;
  }
};
const markNoticeSeen = () => {
  try {
    localStorage.setItem(NOTICE_KEY, '1');
  } catch {
    /* 저장하지 못해도 이번 화면에서는 한 번만 보인다 */
  }
};

/**
 * 입력 카드 위에 올려 둔 첨부 줄. 방이 바뀌면 올리는 중인 것을 멈추고 비운다(이미 올라간 파일은 서버가 24시간 뒤 정리한다).
 * 목록은 ref 의 가변 객체이고 화면은 reducer 로 다시 그린다(채팅 ChatStore 와 같은 방식).
 */
export function useMeetingUploads(room: number | undefined, info: FilesInfo | undefined) {
  const list = useRef<MUpload[]>([]);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [notice, setNotice] = useState(false);
  const shown = useRef(false);
  const infoRef = useRef(info);
  infoRef.current = info;
  const roomRef = useRef(room);
  roomRef.current = room;
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();

  useEffect(
    () => () => {
      for (const u of list.current) u.xhr?.abort();
      list.current = [];
      shown.current = false;
    },
    [room]
  );
  useEffect(() => {
    setNotice(false);
  }, [room]);

  const finish = (u: MUpload) => {
    u.xhr = undefined;
    bump();
    pump();
  };

  const start = (u: MUpload) => {
    const xhr = new XMLHttpRequest();
    u.xhr = xhr;
    u.state = 'up';
    u.pct = 0;
    bump();
    xhr.open('PUT', `/api/office/meeting/files?room=${u.room}&name=${encodeURIComponent(u.name)}`);
    xhr.setRequestHeader('X-AAS', '1');
    xhr.setRequestHeader('Accept-Language', getLang());
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      u.pct = Math.round((e.loaded / e.total) * 100);
      bump();
    };
    xhr.onload = () => {
      let body: { id?: string; name?: string; size?: number; error?: string } = {};
      try {
        body = JSON.parse(xhr.responseText || '{}');
      } catch {
        /* 본문 없는 오류 */
      }
      if (xhr.status === 200 && body.id) {
        Object.assign(u, {
          state: 'done',
          pct: 100,
          id: body.id,
          name: body.name || u.name,
          size: body.size ?? u.size,
        });
        if (u.room === roomRef.current) {
          enqueueSnackbar(t('office.meetingFileUploaded', { name: u.name }), { variant: 'success' });
          void qc.invalidateQueries({ queryKey: ['meeting-files', u.room] });
        }
        return finish(u);
      }
      if (xhr.status === 429 && !u.retried) {
        // 서버가 바쁘면 한 번만 자동으로 다시 한다(채팅과 같다)
        u.retried = true;
        u.state = 'wait';
        u.xhr = undefined;
        bump();
        setTimeout(() => {
          if (list.current.includes(u) && u.state === 'wait') start(u);
        }, 1500);
        return;
      }
      Object.assign(u, { state: 'fail', code: body.error || statusCode(xhr.status) });
      finish(u);
    };
    xhr.onerror = () => {
      Object.assign(u, { state: 'fail', code: 'network' });
      finish(u);
    };
    xhr.onabort = () => {
      Object.assign(u, { state: 'fail', code: 'aborted' });
      u.xhr = undefined;
    };
    xhr.send(u.file);
  };

  function pump() {
    while (list.current.filter((u) => u.state === 'up').length < PARALLEL) {
      const next = list.current.find((u) => u.state === 'wait' && !u.xhr && !u.retried);
      if (!next) break;
      start(next);
    }
  }

  const add = (files: File[], rejected: { name: string; code: string }[] = []) => {
    const r = roomRef.current;
    const i = infoRef.current;
    if (r == null || !i) return;
    for (const x of rejected)
      list.current.push({
        key: crypto.randomUUID(),
        room: r,
        file: new File([], x.name),
        name: x.name,
        size: 0,
        state: 'fail',
        pct: 0,
        code: x.code,
      });
    let accepted = false;
    for (const f of files) {
      const active = list.current.filter((u) => u.state !== 'fail').length;
      const code =
        active >= i.max_per_message ? 'too_many' : f.size === 0 ? 'empty' : f.size > i.limits.file ? 'too_large' : '';
      list.current.push({
        key: crypto.randomUUID(),
        room: r,
        file: f,
        name: f.name,
        size: f.size,
        state: code ? 'fail' : 'wait',
        pct: 0,
        code: code || undefined,
      });
      if (!code) accepted = true;
    }
    if (accepted && !shown.current && !noticeSeen()) {
      setNotice(true);
      markNoticeSeen();
    }
    if (accepted) shown.current = true;
    bump();
    pump();
  };

  const after = () => {
    if (!list.current.length) setNotice(false);
    bump();
  };
  const remove = (key: string) => {
    const u = list.current.find((x) => x.key === key);
    if (!u) return;
    list.current = list.current.filter((x) => x !== u);
    u.xhr?.abort();
    if (u.state === 'done' && u.id) {
      // 보내지 않은 파일은 서버에서도 지운다(실패해도 서버가 24시간 뒤 정리한다)
      void del(filesUrl(u.room, u.id)).catch(() => undefined);
      void qc.invalidateQueries({ queryKey: ['meeting-files', u.room] });
    }
    after();
  };
  /** 말을 보낸 뒤: 보낸 파일 칩만 치우고 실패한 칩은 남긴다. */
  const consumeDone = () => {
    list.current = list.current.filter((u) => u.state !== 'done');
    after();
  };

  const items = list.current;
  return {
    uploads: items,
    add,
    remove,
    consumeDone,
    notice,
    ids: items.filter((u) => u.state === 'done' && u.id).map((u) => u.id as string),
    uploading: items.some((u) => u.state === 'wait' || u.state === 'up'),
  };
}

/** 끌어다 놓기. 대화 영역 밖에 놓아도 브라우저가 파일을 열지 않게 창의 기본 놓기를 막는다(채팅 D18 과 같다). */
export function useFileDrop(
  enabled: boolean,
  onFiles: (files: File[], rejected: { name: string; code: string }[]) => void
) {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const stop = (e: globalThis.DragEvent) => {
      if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
    };
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => {
      window.removeEventListener('dragover', stop);
      window.removeEventListener('drop', stop);
    };
  }, [enabled]);
  const bind = {
    onDragOver: (e: DragEvent) => {
      if (enabled && e.dataTransfer.types.includes('Files')) {
        e.preventDefault();
        setDragging(true);
      }
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      if (!enabled) return;
      const picked: File[] = [];
      const rejected: { name: string; code: string }[] = [];
      const items = Array.from(e.dataTransfer.items ?? []);
      Array.from(e.dataTransfer.files).forEach((f, i) => {
        if (items[i]?.webkitGetAsEntry?.()?.isDirectory) rejected.push({ name: f.name, code: 'folder' });
        else picked.push(f);
      });
      onFiles(picked, rejected);
    },
  };
  return { dragging, bind };
}

export function DropOverlay() {
  const tk = useChatTokens();
  return (
    <Box
      aria-hidden
      sx={{
        position: 'absolute',
        inset: 0,
        zIndex: 2,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
        bgcolor: tk.selected,
        border: `2px dashed ${tk.composerFocus}`,
        borderRadius: `${chatMetrics.panelRadius}px`,
        color: tk.text,
        fontSize: chatType.name,
      }}
    >
      {t('office.meetingFileDrop')}
    </Box>
  );
}

/** 입력 카드 왼쪽 끝의 첨부 단추(채팅과 같은 모양·이름). */
export function AttachButton({ onPick }: { onPick: (files: File[]) => void }) {
  const tk = useChatTokens();
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        data-testid="meeting-file-input"
        onChange={(e) => {
          onPick(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
      <Tooltip title={t('office.meetingFileAttach')}>
        <IconButton
          aria-label={t('office.meetingFileAttach')}
          size="small"
          onClick={() => input.current?.click()}
          sx={{ color: tk.muted }}
        >
          <AttachFileIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </>
  );
}

const hiddenSx = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
} as const;

function UploadChip({ u, info, onRemove }: { u: MUpload; info: FilesInfo; onRemove: () => void }) {
  const tk = useChatTokens();
  const fail = u.state === 'fail';
  const status = u.state === 'wait' ? t('office.meetingFileWaiting') : u.state === 'up' ? `${u.pct}%` : fail ? '' : humanSize(u.size);
  return (
    <Box
      component="li"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 0.25,
        // 칩은 최대 180px 이지만 실패 이유 한 줄은 더 넓게 읽히게 둔다
        maxWidth: fail ? 320 : chatMetrics.chipMax + 40,
        flexShrink: 0,
      }}
    >
      <FileBadge
        file={{ name: u.name, url: u.id ? filesUrl(u.room, u.id) : '', size: u.size, source: 'meeting-in', place: t('chat.files.roomLabel', { room: String(u.room) }) }}
        sizeLabel={status}
        error={fail}
        progress={u.state === 'up' ? u.pct : undefined}
        progressLabel={t('office.meetingFileProgressAria', { name: u.name })}
        disabled={u.state !== 'done' || !u.id}
        ellipsis={MAX_NAME}
        maxName={chatMetrics.chipMax}
        trailing={
          <IconButton
            size="small"
            aria-label={t('office.meetingFileRemoveAria', { name: u.name })}
            onClick={onRemove}
            sx={{ width: 24, height: 24, mr: '2px', color: tk.muted, position: 'relative', '@media (pointer: coarse)': { '&::after': { content: '""', position: 'absolute', inset: -10 } } }}
          >
            <CloseIcon sx={{ fontSize: 14 }} />
          </IconButton>
        }
      />
      {fail && (
        <Typography
          role="alert"
          component="div"
          sx={{
            display: 'flex',
            gap: 0.5,
            alignItems: 'flex-start',
            fontSize: chatType.meta,
            color: tk.text,
            lineHeight: 1.35,
          }}
        >
          <ErrorOutlineIcon aria-hidden sx={{ fontSize: 14, mt: '1px', flexShrink: 0, color: tk.muted }} />
          <span>{fileReason(u.code, info)}</span>
        </Typography>
      )}
    </Box>
  );
}

/** 입력 카드 위 첨부 줄: 폐쇄 환경 안내(처음 한 번)·칩·진행 막대·실패 이유. 진행은 끝났을 때 한 번만 읽는다. */
export function UploadChips({
  uploads,
  info,
  notice,
  uploading,
  onRemove,
}: {
  uploads: MUpload[];
  info: FilesInfo;
  notice: boolean;
  uploading: boolean;
  onRemove: (key: string) => void;
}) {
  const tk = useChatTokens();
  const done = uploads.filter((u) => u.state === 'done').length;
  const fail = uploads.filter((u) => u.state === 'fail').length;
  return (
    <>
      <Box aria-live="polite" sx={hiddenSx}>
        {uploads.length && !uploading ? t('office.meetingFileLive', { done, fail }) : ''}
      </Box>
      {uploads.length > 0 && (
        <Box sx={{ pb: 0.5 }}>
          {notice && (
            <Typography
              role="note"
              component="div"
              sx={{
                display: 'flex',
                gap: 0.75,
                alignItems: 'flex-start',
                mb: 0.75,
                fontSize: chatType.meta,
                color: tk.muted,
                lineHeight: 1.4,
              }}
            >
              <InfoOutlinedIcon aria-hidden sx={{ fontSize: 14, mt: '1px', flexShrink: 0 }} />
              <span>{t('office.meetingFileNotice')}</span>
            </Typography>
          )}
          <Box role="group" aria-label={t('office.meetingFileAttachedAria', { count: uploads.length })}>
            <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
              {uploads.map((u) => (
                <UploadChip key={u.key} u={u} info={info} onRemove={() => onRemove(u.key)} />
              ))}
            </Box>
          </Box>
        </Box>
      )}
    </>
  );
}

/** 말을 받지 못한 에이전트 안내(응답의 skipped). 입력 카드 위 한 줄. */
export function SkippedLine({ skipped, onClose }: { skipped: SkippedAgent[]; onClose: () => void }) {
  const tk = useChatTokens();
  if (!skipped.length) return null;
  const list = skipped
    .map((s) =>
      t(s.reason === 'not_visible' ? 'office.meetingFileSkipNotVisible' : 'office.meetingFileSkipUnsupported', {
        alias: s.alias,
      })
    )
    .join(', ');
  return (
    <Box
      role="status"
      sx={{
        mb: 1,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 1,
        px: 1.5,
        py: 0.75,
        bgcolor: tk.warnWash,
        border: `1px solid ${tk.warnLine}`,
        borderRadius: `${chatMetrics.tileRadius}px`,
        fontSize: chatType.meta + 1,
        color: tk.text,
      }}
    >
      <InfoOutlinedIcon aria-hidden sx={{ fontSize: 16, mt: '1px', flexShrink: 0, color: tk.muted }} />
      <Box sx={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{t('office.meetingFileSkipped', { list })}</Box>
      <IconButton
        size="small"
        aria-label={t('office.meetingFileSkipClose')}
        onClick={onClose}
        sx={{
          p: 0.25,
          color: tk.muted,
          '@media (pointer: coarse)': { minWidth: chatMetrics.touch, minHeight: chatMetrics.touch },
        }}
      >
        <CloseIcon sx={{ fontSize: 14 }} />
      </IconButton>
    </Box>
  );
}

// ---- 방 기록 ----

/** 회의 파일 뱃지(스펙 2026-10-20-002 §3-3). 누르면 파일 뷰어 — 받기는 뷰어 머리의 주 단추(DD3) */
function RoomFileBadge({ url, name, size, source, room, actions }: { url: string; name: string; size?: number; source: 'meeting-in' | 'meeting-out'; room: number; actions?: ViewerActions }) {
  return (
    <FileBadge
      file={{ name, url, size, source, place: t('chat.files.roomLabel', { room: String(room) }) }}
      actions={actions}
      ellipsis={MAX_NAME}
    />
  );
}

/** 사용자 말풍선 아래: 첨부 칩, 받지 않은 에이전트 안내, 작성자·시각. */
export function AttachFoot({ room, data, meta }: { room: number; data?: AttachData | null; meta: string }) {
  const tk = useChatTokens();
  const files = data?.files ?? [];
  const undelivered = data?.undelivered ?? [];
  return (
    <Stack alignItems="flex-end" spacing={0.5}>
      {files.length > 0 && (
        <Box
          role="group"
          aria-label={t('office.meetingFileAttachedAria', { count: files.length })}
          sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 0.5 }}
        >
          {files.map((f) => (
            <RoomFileBadge key={f.id} url={filesUrl(room, f.id)} name={f.name} size={f.size} source="meeting-in" room={room} />
          ))}
        </Box>
      )}
      {undelivered.length > 0 && (
        <Box sx={{ color: tk.muted, fontSize: chatType.meta }}>
          {t('office.meetingFileUndelivered', { names: undelivered.join(', ') })}
        </Box>
      )}
      <Box>{meta}</Box>
    </Stack>
  );
}

/** 에이전트 결과 파일의 「방에 올리기」(뷰어 머리의 주 단추, DD3). 대화의 칩과 「자료」 서랍이 같이 쓴다 */
function useToRoom(room: number, msg: number, n: number, name: string) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  return async () => {
    try {
      const r = await post<{ name?: string }>('/api/office/meeting/files/from-agent', { room, msg, n });
      enqueueSnackbar(t('office.meetingFileToRoomDone', { name: r.name || name }), { variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['meeting-files', room] });
    } catch (e) {
      enqueueSnackbar(fileErrorText(e), { variant: 'error' });
    }
  };
}

function AgentFileItem({ room, msg, n, file }: { room: number; msg: number; n: number; file: AgentFileRef }) {
  const toRoom = useToRoom(room, msg, n, file.name);
  // 이미 방 자료에 올라간 파일은 「방에 올리기」가 없다. 건너뛴 파일은 손으로 올릴 수 있다
  return <RoomFileBadge url={agentFileUrl(room, msg, n)} name={file.name} size={file.size} source="meeting-out" room={room} actions={file.room ? undefined : { onToRoom: toRoom }} />;
}

/** 에이전트가 만든 파일 행(role=system 이어도 kind=files 면 경고 행이 아니다): 아바타·별칭 머리줄 아래 파일 칩. */
export function AgentFilesRow({
  room,
  msg,
  name,
  enter,
  info,
}: {
  room: number;
  msg: { id: number; author: string; ts: string; data?: AgentFilesData | null };
  /** 글쓴이의 화면 이름(회의 labels). 없으면 별칭 */
  name?: string;
  enter: boolean;
  info?: FilesInfo;
}) {
  const tk = useChatTokens();
  const files = msg.data?.files ?? [];
  if (!files.length) return null;
  return (
    <MessageRow
      side="agent"
      enter={enter}
      head={{
        avatar: <AgentAvatar name={msg.author} label={name ?? msg.author} size={chatMetrics.rowAvatar} tone="hue" />,
        name: name ?? msg.author,
        time: fmtTs(msg.ts),
      }}
    >
      <Box
        role="group"
        aria-label={t('office.meetingFileAgentFiles', { alias: name ?? msg.author })}
        sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}
      >
        {files.map((f, i) => (
          <AgentFileItem key={`${f.path}:${i}`} room={room} msg={msg.id} n={i} file={f} />
        ))}
      </Box>
      {files
        .filter((f) => f.skip)
        .map((f, i) => (
          <Box key={`skip:${f.path}:${i}`} sx={{ color: tk.muted, fontSize: chatType.meta, mt: 0.5 }}>
            {t('office.meetingFileAutoSkipped', { name: f.name, reason: fileReason(f.skip, info) })}
          </Box>
        ))}
    </MessageRow>
  );
}

// ---- 「자료」 서랍 ----

const bySort = <T,>(rows: T[], key: (r: T) => string, dir: 1 | -1 = 1) =>
  [...rows].sort((a, b) => dir * key(a).localeCompare(key(b)));

/** 서랍 줄의 칸(개인 「파일」 서랍 §3-7 과 같은 값): 종류 타일 │ 이름 │ 크기 │ 시각. 서랍 폭이 560px 미만이면 크기·시각을 이름 아랫줄로 */
const rowGrid = {
  display: 'grid',
  gridTemplateColumns: '28px 1fr 88px 100px',
  columnGap: 1.5,
  alignItems: 'center',
  '@container (max-width: 559px)': { gridTemplateColumns: '28px 1fr' },
} as const;

/** 서버 시각(ISO 문자열) → 초. 읽지 못하면 undefined(시각 칸을 비운다) */
const isoSec = (ts: string) => {
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? undefined : ms / 1000;
};

/** 서랍 줄 — 줄 전체가 하나의 단추로 뷰어를 연다(개인 서랍 §3-7 과 같은 모양, DD3). 받기·지우기는 뷰어 머리에서.
 *  크기·시각은 열로(2026-10-21), 올린 사람 같은 덧붙일 말(sub)과 오류는 이름 아랫줄 */
function FileRow({ name, sub, err, sec, file, actions }: { name: string; sub?: string; err?: string; sec?: number; file: ViewerFile; actions?: ViewerActions }) {
  const tk = useChatTokens();
  const metaId = `mf-${file.url}`;
  const size = humanSize(file.size ?? 0);
  const when = sec == null ? '' : fmtWhen(sec);
  const cell = { textAlign: 'right', fontSize: chatType.meta, color: tk.muted, fontVariantNumeric: 'tabular-nums', '@container (max-width: 559px)': { display: 'none' } } as const;
  const line = err || [sub, size, when].filter(Boolean).join(', ');
  return (
    <li>
      <ButtonBase
        aria-label={t('chat.files.rowOpenAria', { name })}
        aria-describedby={metaId}
        aria-haspopup="dialog"
        onClick={(e) => openViewer(file, actions, e.currentTarget)}
        sx={{
          ...rowGrid,
          width: '100%',
          minHeight: chatMetrics.touch,
          px: 1,
          textAlign: 'left',
          borderRadius: '6px',
          font: 'inherit',
          '&:hover': { bgcolor: tk.hover },
          '&:focus-visible': { outline: `2px solid ${FOCUS_RING}`, outlineOffset: -2 },
        }}
      >
        <Box sx={{ width: 28, height: 28, borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: tk.hover, color: tk.muted }}>
          <FileIcon name={name} />
        </Box>
        <Box sx={{ minWidth: 0 }}>
          <Typography noWrap title={name} sx={{ fontSize: chatType.name, fontWeight: 500, color: tk.text }}>
            {name}
          </Typography>
          {(err || sub) && (
            <Typography component="div" sx={{ fontSize: chatType.meta, color: err ? 'error.main' : tk.muted, overflowWrap: 'anywhere', '@container (max-width: 559px)': { display: 'none' } }}>
              {err || sub}
            </Typography>
          )}
          {/* 좁은 서랍: 덧붙일 말·크기·시각을 아랫줄 하나로 */}
          <Typography id={metaId} component="div" sx={{ display: 'none', fontSize: chatType.meta, color: err ? 'error.main' : tk.muted, overflowWrap: 'anywhere', '@container (max-width: 559px)': { display: 'block' } }}>
            {line}
          </Typography>
        </Box>
        <Box component="span" sx={cell}>
          {size}
        </Box>
        {when ? (
          <Tooltip title={new Date((sec ?? 0) * 1000).toLocaleString()}>
            <Box component="span" sx={cell}>
              {when}
            </Box>
          </Tooltip>
        ) : (
          <Box component="span" sx={cell} />
        )}
      </ButtonBase>
    </li>
  );
}

/** 서랍의 결과 칩 파일 줄 — 대화의 칩과 같은 받기 주소·「방에 올리기」 */
function MadeRow({ room, f }: { room: number; f: MadeFile }) {
  const toRoom = useToRoom(room, f.msg, f.n, f.name);
  return (
    <FileRow
      name={f.name}
      sec={isoSec(f.ts)}
      file={{ name: f.name, url: agentFileUrl(room, f.msg, f.n), size: f.size, source: 'meeting-out', place: t('chat.files.roomLabel', { room: String(room) }) }}
      actions={{ onToRoom: toRoom }}
    />
  );
}

/** 「자료」 서랍 본문: ① 올린 파일 ② 에이전트 출력(공유 출력 폴더 + 자기 작업 폴더에 만든 결과 칩 파일). 열 때와 올리기·지우기 뒤에 목록을 다시 읽는다.
 *  onAttach 가 있으면(말할 수 있는 열린 방) 「올린 파일」 머리에 첨부 단추를 둔다. 고른 파일은 입력 카드의 보낼 첨부로 붙는다
 *  — 보내지 않은 파일은 서버가 24시간 뒤 지우므로 서랍에서 따로 올리는 길을 두지 않는다. */
export function MeetingFilesDrawer({ room, info, onAttach }: { room: number; info: FilesInfo; onAttach?: (files: File[]) => void }) {
  const tk = useChatTokens();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const me = useMe().data;
  const admin = isAdmin(me);
  const [rowErr, setRowErr] = useState<Record<string, string>>({});
  // 이름 찾기와 접은 구역(이 서랍을 여는 동안만 기억한다, 스펙 2026-10-20-002 §6-4). 찾는 동안에는 접힌 구역도 맞는 줄을 보인다
  const [needle, setNeedle] = useState('');
  const [closed, setClosed] = useState<ReadonlySet<'up' | 'out'>>(new Set());
  const toggle = (k: 'up' | 'out') =>
    setClosed((c) => {
      const n = new Set(c);
      if (!n.delete(k)) n.add(k);
      return n;
    });
  const picker = useRef<HTMLInputElement>(null);
  const q = useQuery<FilesList>({
    queryKey: ['meeting-files', room],
    queryFn: () => get<FilesList>(`/api/office/meeting/files?room=${room}`),
    staleTime: 0,
    refetchOnMount: 'always',
  });

  if (q.isError)
    return (
      <Stack spacing={1} alignItems="flex-start">
        <Typography role="alert">
          {t('office.meetingFileLoadFailed', { error: fileErrorText(q.error, info) })}
        </Typography>
        <Button startIcon={<RefreshIcon />} size="small" variant="outlined" color="inherit" onClick={() => void q.refetch()}>
          {t('office.meetingFileReload')}
        </Button>
      </Stack>
    );
  const data = q.data;
  if (!data)
    return (
      <Stack spacing={1} aria-busy="true" aria-label={t('office.meetingFileLoading')}>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} variant="rounded" height={36} />
        ))}
      </Stack>
    );

  // 지우기 단추는 올린 사람과 관리자에게만 보인다(서버도 같은 규칙으로 403)
  const mine = (uploader: string) => !!uploader && [me?.user?.name, me?.user?.email].includes(uploader);
  const remove = async (f: RoomFile): Promise<boolean> => {
    if (!(await confirm(t('office.meetingFileDeleteConfirm', { name: f.name }), { danger: true }))) return false;
    try {
      await del(filesUrl(room, f.id));
      enqueueSnackbar(t('office.meetingFileDeleted', { name: f.name }), { variant: 'success' });
      setRowErr((r) => ({ ...r, [f.id]: '' }));
      void qc.invalidateQueries({ queryKey: ['meeting-files', room] });
      return true;
    } catch (e) {
      setRowErr((r) => ({ ...r, [f.id]: fileErrorText(e, info) }));
      return false;
    }
  };

  const who = (v: string) => data.labels?.[v] ?? v;
  const ratio = Math.min(1, data.used.room / Math.max(1, info.limits.room));
  // 에이전트 출력 = 공유 출력 폴더(out) + 방 기록의 결과 칩(made, 옛 서버는 키가 없다). 별칭·날짜로 함께 묶는다
  const find = needle.trim().toLowerCase();
  const hit = (name: string) => !find || name.toLowerCase().includes(find);
  const shown = (k: 'up' | 'out') => !!find || !closed.has(k);
  const upRows = data.files.filter((f) => hit(f.name));
  const outRows = [
    ...data.out.map((o) => ({
      name: o.name,
      alias: o.alias,
      date: o.date,
      el: (
        <FileRow
          key={`out:${o.path}`}
          name={o.name}
          sec={o.mtime}
          file={{ name: o.name, url: outUrl(room, o.path), size: o.size, mtime: o.mtime, source: 'meeting-out', place: t('chat.files.roomLabel', { room: String(room) }) }}
        />
      ),
    })),
    ...(data.made ?? []).map((f) => ({ name: f.name, alias: f.alias, date: f.ts.slice(0, 10), el: <MadeRow key={`made:${f.msg}:${f.n}`} room={room} f={f} /> })),
  ].filter((o) => hit(o.name));
  const aliases = bySort(Array.from(new Set(outRows.map((o) => o.alias))), (a) => a);
  return (
    <Stack spacing={2.5} sx={{ containerType: 'inline-size' }}>
      <Box>
        <Stack direction="row" justifyContent="space-between">
          <Typography sx={{ fontSize: chatType.name }}>{t('office.meetingFileUsage')}</Typography>
          <Typography sx={{ fontSize: chatType.name }}>
            {t('office.meetingFileUsageValue', { used: humanSize(data.used.room), limit: humanSize(info.limits.room) })}
          </Typography>
        </Stack>
        <LinearProgress
          variant="determinate"
          value={ratio * 100}
          aria-label={t('office.meetingFileUsage')}
          sx={{
            height: 4,
            mt: 0.5,
            bgcolor: tk.line,
            '& .MuiLinearProgress-bar': { bgcolor: ratio >= 1 ? tk.warnLine : tk.text },
          }}
        />
      </Box>

      <FileSearch value={needle} onChange={setNeedle} placeholder={t('chat.files.searchPlaceholder')} />

      {/* 열 머리(개인 서랍과 같은 말). 좁은 서랍은 줄이 두 줄이라 숨긴다 */}
      <Box aria-hidden sx={{ ...rowGrid, px: 1, mb: '-12px !important', fontSize: 12, color: tk.muted, '@container (max-width: 559px)': { display: 'none' } }}>
        <span />
        <span>{t('chat.files.colName')}</span>
        <Box component="span" sx={{ textAlign: 'right' }}>
          {t('chat.files.colSize')}
        </Box>
        <Box component="span" sx={{ textAlign: 'right' }}>
          {t('chat.files.colTime')}
        </Box>
      </Box>

      <Box component="section" aria-label={t('office.meetingFileSecUploaded')}>
        <GroupHead
          icon={<UploadFileOutlinedIcon />}
          title={t('office.meetingFileSecUploaded')}
          count={upRows.length}
          open={shown('up')}
          onToggle={() => toggle('up')}
          controls={`mfg-up-${room}`}
          action={
            onAttach && (
              <>
                <input
                  ref={picker}
                  type="file"
                  multiple
                  hidden
                  data-testid="meeting-drawer-file-input"
                  onChange={(e) => {
                    onAttach(Array.from(e.target.files ?? []));
                    e.target.value = '';
                  }}
                />
                <Tooltip title={t('office.meetingFileAttachDrawerTip')} describeChild>
                  <Button
                    size="small"
                    variant="outlined"
                    color="inherit"
                    startIcon={<AttachFileIcon fontSize="small" />}
                    onClick={() => picker.current?.click()}
                    sx={{ flexShrink: 0, '@media (pointer: coarse)': { minHeight: chatMetrics.touch } }}
                  >
                    {t('office.meetingFileAttach')}
                  </Button>
                </Tooltip>
              </>
            )
          }
        />
        <Box id={`mfg-up-${room}`} hidden={!shown('up')}>
          {upRows.length ? (
            <Stack component="ul" spacing={0.25} sx={{ listStyle: 'none', m: 0, p: 0 }}>
              {upRows.map((f) => (
                <FileRow
                  key={f.id}
                  name={f.name}
                  sub={who(f.uploader)}
                  sec={isoSec(f.ts)}
                  err={rowErr[f.id]}
                  file={{ name: f.name, url: filesUrl(room, f.id), size: f.size, source: 'meeting-in', place: t('chat.files.roomLabel', { room: String(room) }) }}
                  actions={admin || mine(f.uploader) ? { onDelete: () => remove(f) } : undefined}
                />
              ))}
            </Stack>
          ) : (
            !find && <Typography sx={{ px: 1, color: tk.muted, fontSize: chatType.meta }}>{t('office.meetingFileEmpty')}</Typography>
          )}
        </Box>
      </Box>

      <Box component="section" aria-label={t('office.meetingFileSecOut')}>
        <GroupHead
          icon={<SmartToyOutlinedIcon />}
          title={t('office.meetingFileSecOut')}
          count={outRows.length}
          open={shown('out')}
          onToggle={() => toggle('out')}
          controls={`mfg-out-${room}`}
        />
        <Box id={`mfg-out-${room}`} hidden={!shown('out')}>
          {data.out_truncated && (
            <Typography role="note" sx={{ px: 1, color: tk.muted, fontSize: chatType.meta, mb: 0.5 }}>
              {t('office.meetingFileTruncated')}
            </Typography>
          )}
          {outRows.length ? (
            aliases.map((alias) => {
              const mineOut = outRows.filter((o) => o.alias === alias);
              const dates = bySort(Array.from(new Set(mineOut.map((o) => o.date))), (d) => d, -1);
              return (
                <Box key={alias} component="div" role="group" aria-label={who(alias)} sx={{ mb: 1.5 }}>
                  <Typography sx={{ px: 1, fontSize: chatType.name, fontWeight: 500 }}>{who(alias)}</Typography>
                  {dates.map((date) => (
                    <Box key={date}>
                      <Typography sx={{ px: 1, fontSize: chatType.meta, color: tk.muted, mt: 0.5 }}>{date}</Typography>
                      <Stack component="ul" spacing={0.25} sx={{ listStyle: 'none', m: 0, p: 0 }}>
                        {mineOut.filter((o) => o.date === date).map((o) => o.el)}
                      </Stack>
                    </Box>
                  ))}
                </Box>
              );
            })
          ) : (
            !find && <Typography sx={{ px: 1, color: tk.muted, fontSize: chatType.meta }}>{t('office.meetingFileOutEmpty')}</Typography>
          )}
        </Box>
      </Box>
    </Stack>
  );
}
