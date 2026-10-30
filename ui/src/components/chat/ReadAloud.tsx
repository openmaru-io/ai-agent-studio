/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 답 「읽어 주기」의 화면 쪽(스펙 2026-10-28-012 §3-9·§3-9-1, 디자인 DD3~DD21): 행동 줄의 [읽어 주기] 단추와 상태 한 칸,
// 입력칸 아래 줄의 「읽는 중 띠」, 화면 읽기 알림 영역. 재생 자체는 readAloudPlayer 의 재생기 하나가 한다.
// 빨강·토스트·진행 막대는 쓰지 않는다(DD6·DD16).
import StopCircleOutlinedIcon from '@mui/icons-material/StopCircleOutlined';
import VolumeUpOutlinedIcon from '@mui/icons-material/VolumeUpOutlined';
import { Box, Button, CircularProgress, IconButton, Tooltip, useMediaQuery } from '@mui/material';
import { RefObject, useEffect, useRef, useSyncExternalStore } from 'react';

import { t } from '@/i18n';
import { chatMetrics, chatType } from '@/lib/chatTokens';

import { pickVoice,readAloud, ReadSnap, TtsVoice } from './readAloudPlayer';
import { useChatTokens } from './useChatTokens';
import { voiceRecorder } from './VoiceInput';

/** 읽힐 에이전트. 채팅은 대화 상대, 오피스 대화·회의실은 내 에이전트의 주 프로파일(DD13) */
export interface ReadTarget {
  pod?: string;
  profile: string;
  /** /api/chat/status 의 tts. 참일 때만 단추를 그린다 */
  tts?: boolean;
  voices?: TtsVoice[];
}

export const useReadSnap = (): ReadSnap => useSyncExternalStore(readAloud.subscribe, readAloud.getSnap);

/** 준비·재생·오류 중인 행은 행동 줄을 늘 보인다(DD3, MessageRow pinActions) */
export function readPinned(s: ReadSnap, conv: string, msg: string): boolean {
  return s.conv === conv && s.msg === msg && s.phase !== 'idle';
}

/** 답 글의 고유값: 글 해시 + 같은 글의 몇 번째인지. 배열 위치로 기억하지 않는다(F11) — 다시 그리거나 지난 기록을 다시 읽어도 같은 답에 붙는다 */
export function answerKeys(texts: string[]): string[] {
  const seen = new Map<string, number>();
  return texts.map((text) => {
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    const base = `${(h >>> 0).toString(36)}.${text.length}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${base}#${n}`;
  });
}

/** 대화를 바꾸거나 창을 닫거나 화면을 옮기면(언마운트) 그 대화의 읽기를 멈춘다(DD11). 탭이 숨겨져도 계속 읽는다 */
export function useReadScope(conv: string) {
  useEffect(() => () => readAloud.stopConv(conv), [conv]);
}

const useRecording = () => useSyncExternalStore(voiceRecorder.subscribe, () => voiceRecorder.active());
const touch = { '@media (pointer: coarse)': { minWidth: chatMetrics.touch, minHeight: chatMetrics.touch } };
const line = { fontSize: chatType.meta, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 } as const;

/** 행동 줄의 [읽어 주기] + 오른쪽 상태 한 칸(§3-9-1 상태표). tts 가 참이 아니면 그리지 않는다 */
export function ReadAloudButton({
  target,
  conv,
  msg,
  name,
  text,
  streaming,
}: {
  target?: ReadTarget;
  conv: string;
  msg: string;
  name: string;
  text: string;
  /** 답이 아직 만들어지는 중이면 막는다(§3-9) */
  streaming?: boolean;
}) {
  const tk = useChatTokens();
  const s = useReadSnap();
  const recording = useRecording();
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  if (target?.tts !== true) return null;
  const mine = readPinned(s, conv, msg);
  const phase = mine ? s.phase : 'idle';
  const reason = recording ? t('read.recording') : streaming ? t('read.streaming') : '';
  const label = phase === 'preparing' ? t('read.preparing') : phase === 'playing' ? t('read.stop') : t('read.label');
  const icon =
    phase === 'preparing' ? (
      reduced ? (
        <VolumeUpOutlinedIcon sx={{ fontSize: 16 }} />
      ) : (
        <CircularProgress size={14} thickness={5} sx={{ color: 'inherit' }} aria-hidden />
      )
    ) : phase === 'playing' ? (
      <StopCircleOutlinedIcon sx={{ fontSize: 16 }} />
    ) : (
      <VolumeUpOutlinedIcon sx={{ fontSize: 16 }} />
    );
  const press = () => {
    if (reason) return;
    readAloud.press({ conv, msg, name, pod: target.pod, profile: target.profile, text, voice: pickVoice(target.voices) });
  };
  const msgText =
    phase === 'preparing' && s.slow
      ? t('read.slow')
      : phase === 'playing' && s.truncated
      ? t('read.truncatedShort')
      : phase === 'empty'
      ? t('read.emptyShort')
      : phase === 'failed'
      ? t('read.failedShort')
      : phase === 'busy'
      ? t('read.busyShort')
      : '';
  const warn = phase === 'failed' || phase === 'busy';
  return (
    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, minWidth: 0 }} data-read-conv={conv} data-read-msg={msg}>
      <Tooltip title={reason || label}>
        <IconButton
          size="small"
          aria-label={label}
          data-guide="chat.read"
          aria-disabled={reason ? true : undefined}
          onClick={press}
          sx={{ color: tk.muted, '&:hover': { color: tk.text }, ...touch, ...(reason ? { opacity: 0.45, cursor: 'default' } : {}) }}
        >
          {icon}
        </IconButton>
      </Tooltip>
      {msgText && (
        <Box role="status" title={msgText} sx={{ ...line, color: warn ? tk.warn : tk.muted }}>
          {msgText}
        </Box>
      )}
      {warn && (
        // [다시 시도]는 말줄임에서 빠지는 별도 글자 단추(DD18). 실패한 조각부터 읽는다(DD7)
        <Button
          size="small"
          color="inherit"
          aria-disabled={recording ? true : undefined}
          onClick={() => !recording && readAloud.retry()}
          sx={{ color: tk.text, fontSize: chatType.meta, minWidth: 0, px: 1, flex: '0 0 auto', ...touch }}
        >
          {t('read.retry')}
        </Button>
      )}
    </Box>
  );
}

/** 이 대화의 읽기가 준비·재생 중인가 — 입력칸 아래 줄에 읽는 중 띠를 둔다(DD4) */
export function useReadBand(conv?: string): boolean {
  return useSyncExternalStore(readAloud.subscribe, () => !!conv && readAloud.snap.conv === conv && readAloud.active());
}

/** 읽는 답의 행으로 스크롤하고 그 행에 포커스를 준다(DD21) */
function goToAnswer(conv: string, msg: string) {
  const el = Array.from(document.querySelectorAll<HTMLElement>('[data-read-conv]')).find(
    (x) => x.dataset.readConv === conv && x.dataset.readMsg === msg
  );
  if (!el) return;
  const row = (el.closest('.chat-row') as HTMLElement | null) ?? el;
  if (!row.hasAttribute('tabindex')) row.setAttribute('tabindex', '-1');
  row.scrollIntoView?.({ block: 'center' });
  row.focus({ preventScroll: true });
}

/** 읽는 중 띠: `[VolumeUpOutlined] {에이전트}의 답 읽는 중  [StopCircleOutlined 멈추기]`. 녹음 띠와 같은 자리·규칙(키 안내를 가림).
 *  Esc 순서(DD17): 고르기 목록 → 녹음 → **읽기 멈추기** → 서랍·창 닫기 */
export function ReadBand({
  conv,
  id,
  suggestOpen,
  rootRef,
}: {
  conv: string;
  id: string;
  suggestOpen: boolean;
  rootRef: RefObject<HTMLElement | null>;
}) {
  const tk = useChatTokens();
  const s = useReadSnap();
  const shown = s.conv === conv && (s.phase === 'preparing' || s.phase === 'playing');
  const openRef = useRef(suggestOpen);
  openRef.current = suggestOpen;
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing || openRef.current || voiceRecorder.active() || !readAloud.active()) return;
      const root = rootRef.current;
      const modal = Array.from(document.querySelectorAll('.MuiModal-root, [role="dialog"][aria-modal="true"]')).some(
        (el) => !el.classList.contains('MuiModal-hidden') && !(root && el.contains(root))
      );
      if (modal) return;
      e.preventDefault();
      e.stopPropagation();
      readAloud.stop();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [shown, rootRef]);
  if (!shown) return null;
  const keepFocus = (e: React.PointerEvent) => e.preventDefault();
  return (
    <Box id={id} sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flex: 1, minWidth: 0 }}>
      <VolumeUpOutlinedIcon aria-hidden sx={{ fontSize: 16, color: tk.muted, flex: '0 0 auto' }} />
      <Button
        size="small"
        color="inherit"
        aria-label={t('read.bandGo', { name: s.name })}
        onPointerDown={keepFocus}
        onClick={() => goToAnswer(s.conv, s.msg)}
        sx={{ ...line, display: 'block', textAlign: 'left', textTransform: 'none', color: tk.muted, px: 0.5, minWidth: 0, ...touch }}
      >
        {t('read.band', { name: s.name })}
      </Button>
      <Box sx={{ flex: 1 }} />
      <Button
        size="small"
        color="inherit"
        startIcon={<StopCircleOutlinedIcon sx={{ fontSize: 16 }} />}
        onPointerDown={keepFocus}
        onClick={() => readAloud.stop()}
        sx={{ color: tk.text, fontSize: chatType.meta, minWidth: 0, px: 1, flex: '0 0 auto', ...touch }}
      >
        {t('read.bandStop')}
      </Button>
    </Box>
  );
}

/** 읽기 알림(시작·끝·실패·잘림)의 화면 읽기 영역(DD17). 이 대화의 알림만 읽는다 */
export function ReadLive({ conv }: { conv: string }) {
  const s = useReadSnap();
  const a = s.announce;
  return (
    <Box
      aria-live="polite"
      sx={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}
    >
      {a.conv === conv && a.text ? a.text + (a.n % 2 ? ' ' : '') : ''}
    </Box>
  );
}
