/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 「/」 명령의 입력 칸 위 줄(스펙 2026-10-26-010 §11-2). 채팅과 오피스 1:1 이 같이 쓴다. 메시지 흐름에는 넣지 않는다 —
// 답하는 중에 흐름에 넣으면 흐르는 답이 둘로 갈라진다(DC7).
// - 회색 줄은 한 번에 하나: /compress 기다림(DC4) > 예약(DC8) > 잠깐 안내(steer 확인·바쁨, DC7) > 목표·반복(스펙 2026-10-27-002 §4-3).
//   연결 줄이 떠 있으면 부르는 쪽이 숨긴다.
// - 호박색 줄은 할 일이 있을 때: 사라진 예약(다시 쓰기), 다시 답하기 실패(입력창의 질문 보내기)(DC8·DC9).
import CloseIcon from '@mui/icons-material/Close';
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded';
import { Box, Button, IconButton, Tooltip } from '@mui/material';
import { useEffect, useId, useState } from 'react';

import { DisclosureButton } from '@/components/DisclosureButton';
import { tier2 } from '@/components/tierButton';
import { t } from '@/i18n';
import type { Control } from '@/lib/chat';
import { chatMetrics, chatType, coarseTouch } from '@/lib/chatTokens';
import { fmtClock } from '@/lib/format';

import { ReconnectRow, statusRowSx } from './ReconnectRow';
import { useChatTokens } from './useChatTokens';

export interface CommandRowsProps {
  /** /compress 를 시작한 시각(ms) */
  compressing?: number;
  compressSlow?: boolean;
  queue?: { id: string; text: string; hermes?: boolean }[];
  queueHeld?: boolean;
  queueLost?: number;
  flash?: { text: string; until: number };
  retryFailed?: boolean;
  compact?: boolean;
  /** 연결 줄이 떠 있다 — 회색 줄은 숨긴다(연결이 먼저, 11-2) */
  hideGray?: boolean;
  onQueue: (op: 'cancel' | 'drop' | 'send', id?: string) => void;
  /** 180초를 넘긴 뒤 「다시 확인」 */
  onCheck: () => void;
  onDismiss: (which: 'queueLost' | 'retryFailed' | 'compressSlow') => void;
  /** 목표·반복 상태(aas.control) */
  control?: Control;
  /** 멈춤·다시·지우기 단추를 보일까(주인·관리자, 스펙 2026-10-27-002 R12). 아니면 상태만 */
  canControl?: boolean;
  /** 단추 — /api/chat/command 에 goal pause 등을 보낸다(리뷰 D1). heartbeat 는 단추 전용 명령(스펙 2026-10-27-004 R9) */
  onControl?: (command: 'goal' | 'loop' | 'heartbeat', op: 'pause' | 'resume' | 'clear' | 'stop') => void;
  /** 답을 기다리는 곁 질문 수(3단계 R10) */
  btwWait?: number;
}

/** heartbeat 간격(초)을 「5분」처럼 */
function every(seconds?: number): string {
  const s = Math.max(0, Math.round(seconds ?? 0));
  if (s >= 3600 && s % 3600 === 0) return t('chat.ctl.hours', { n: s / 3600 });
  if (s >= 60) return t('chat.ctl.minutes', { n: Math.round(s / 60) });
  return t('chat.ctl.seconds', { n: s });
}

/** 목표·반복 줄의 글(상태가 진행·멈춤일 때만). 끝난 목표·멈춘 반복은 줄이 없다 */
export function controlLines(c?: Control): { kind: 'goal' | 'loop' | 'heartbeat'; text: string; paused: boolean }[] {
  const out: { kind: 'goal' | 'loop' | 'heartbeat'; text: string; paused: boolean }[] = [];
  const g = c?.goal;
  if (g && (g.status === 'active' || g.status === 'paused')) {
    const vars = { used: g.turns_used ?? 0, max: g.max_turns ?? 0 };
    out.push({ kind: 'goal', paused: g.status === 'paused', text: g.status === 'paused' ? t('chat.ctl.goalPaused', vars) : t('chat.ctl.goal', vars) });
  }
  const l = c?.loop;
  if (l && (l.status === 'active' || l.status === 'paused')) {
    const text = l.status === 'paused' ? t('chat.ctl.loopPaused') : l.next_due_at ? t('chat.ctl.loop', { at: fmtClock(l.next_due_at * 1000).slice(0, 5) }) : t('chat.ctl.loopSoon');
    out.push({ kind: 'loop', paused: l.status === 'paused', text });
  }
  const h = c?.heartbeat;
  if (h && (h.status === 'active' || h.status === 'paused'))
    out.push({ kind: 'heartbeat', paused: h.status === 'paused', text: h.status === 'paused' ? t('chat.ctl.heartbeatPaused') : t('chat.ctl.heartbeat', { every: every(h.interval_seconds) }) });
  return out;
}

function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [on]);
  return now;
}

function WarnRow({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  const tk = useChatTokens();
  return (
    <Box
      role="note"
      sx={{
        mb: 1,
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 1.5,
        py: 1,
        bgcolor: tk.warnWash,
        border: `1px solid ${tk.warnLine}`,
        borderRadius: `${chatMetrics.tileRadius}px`,
        fontSize: chatType.name,
        color: tk.text,
      }}
    >
      <WarningAmberRoundedIcon aria-hidden="true" sx={{ fontSize: 18, color: tk.warn, flexShrink: 0 }} />
      <Box sx={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{text}</Box>
      <Tooltip title={t('chat.cmd.dismiss')}>
        <IconButton size="small" aria-label={t('chat.cmd.dismiss')} onClick={onDismiss} sx={[{ color: tk.muted }, coarseTouch]}>
          <CloseIcon sx={{ fontSize: 16 }} />
        </IconButton>
      </Tooltip>
    </Box>
  );
}

export function CommandRows(p: CommandRowsProps) {
  const tk = useChatTokens();
  const [shown, setShown] = useState(false);
  const listId = useId();
  const flashOn = !!p.flash && p.flash.until > Date.now();
  const now = useNow(!!p.compressing || flashOn);
  const queue = p.queue ?? [];
  const btn = (label: string, onClick: () => void) => (
    <Button size="small" variant="outlined" color="inherit" onClick={onClick} sx={[tier2 as object, coarseTouch]}>
      {label}
    </Button>
  );

  let gray: React.ReactNode = null;
  if (!p.hideGray) {
    if (p.compressing) {
      const s = Math.max(0, Math.floor((now - p.compressing) / 1000));
      const tail = queue.length ? ` ${t('chat.cmd.queueTail', { count: queue.length })}` : '';
      gray = <ReconnectRow text={t('chat.cmd.compressing', { s }) + tail} short={t('chat.cmd.compressingShort', { s })} compact={p.compact} />;
    } else if (p.compressSlow) {
      gray = (
        <Box sx={statusRowSx(tk)}>
          <Box sx={{ flex: 1, minWidth: 0 }}>{t('chat.cmd.compressSlow')}</Box>
          {btn(t('chat.cmd.compressCheck'), p.onCheck)}
        </Box>
      );
    } else if (queue.length) {
      gray = (
        <Box sx={statusRowSx(tk)}>
          <Box sx={{ flex: 1, minWidth: 0 }}>{p.queueHeld ? t('chat.cmd.queueHeld', { count: queue.length }) : t('chat.cmd.queue', { count: queue.length })}</Box>
          {p.queueHeld ? (
            <>
              {btn(t('chat.cmd.queueSendNow'), () => p.onQueue('send'))}
              {btn(t('chat.cmd.queueDrop'), () => p.onQueue('drop'))}
            </>
          ) : (
            <DisclosureButton open={shown} onToggle={() => setShown((v) => !v)} controls={listId} label={shown ? t('chat.cmd.queueHide') : t('chat.cmd.queueShow')} />
          )}
          {(shown || p.queueHeld) && (
            <Box component="ul" id={listId} sx={{ m: 0, p: 0, listStyle: 'none', width: '100%' }}>
              {queue.map((q) => (
                <Box component="li" key={q.id} sx={{ display: 'flex', alignItems: 'center', gap: 1, fontSize: chatType.meta, color: tk.muted }}>
                  <Box sx={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.text}</Box>
                  {q.hermes ? (
                    // Hermes 대기열에 넘겨 곧 시작한다 — 지울 수 없다(스펙 2026-10-27-002 R5)
                    <Box component="span" sx={{ flexShrink: 0 }}>
                      {t('chat.cmd.queueSoon')}
                    </Box>
                  ) : (
                    <Tooltip title={t('chat.cmd.queueCancel', { text: q.text })}>
                      <IconButton size="small" aria-label={t('chat.cmd.queueCancel', { text: q.text })} onClick={() => p.onQueue('cancel', q.id)} sx={[{ color: tk.muted }, coarseTouch]}>
                        <CloseIcon sx={{ fontSize: 14 }} />
                      </IconButton>
                    </Tooltip>
                  )}
                </Box>
              ))}
            </Box>
          )}
        </Box>
      );
    } else if (flashOn && p.flash) gray = <Box sx={statusRowSx(tk)}>{p.flash.text}</Box>;
    else if (p.btwWait) gray = <Box sx={statusRowSx(tk)}>{t('chat.cmd.btwWait', { count: p.btwWait })}</Box>;
    else if (controlLines(p.control).length) {
      const on = p.canControl && p.onControl;
      gray = (
        <>
          {controlLines(p.control).map((l) => (
            <Box key={l.kind} data-testid={`control-${l.kind}`} sx={[statusRowSx(tk), { mb: 0.5 }]}>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                {l.text}
                {p.control?.resting && !l.paused ? ` · ${t('chat.ctl.resting')}` : ''}
              </Box>
              {on && btn(l.paused ? t('chat.ctl.resume') : t('chat.ctl.pause'), () => p.onControl?.(l.kind, l.paused ? 'resume' : 'pause'))}
              {on && btn(l.kind === 'loop' ? t('chat.ctl.stop') : t('chat.ctl.clear'), () => p.onControl?.(l.kind, l.kind === 'loop' ? 'stop' : 'clear'))}
            </Box>
          ))}
        </>
      );
    }
  }

  if (!gray && !p.queueLost && !p.retryFailed) return null;
  return (
    <Box>
      {p.queueLost ? <WarnRow text={t('chat.cmd.queueLost', { count: p.queueLost })} onDismiss={() => p.onDismiss('queueLost')} /> : null}
      {p.retryFailed && <WarnRow text={t('chat.cmd.retryFailed')} onDismiss={() => p.onDismiss('retryFailed')} />}
      {gray && (
        <Box role="status" data-testid="command-row">
          {gray}
        </Box>
      )}
    </Box>
  );
}

/** 키 안내 줄의 「/」 판정 한 줄(DC5·DC10). warn 이면 호박색 글자(DD9 와 같은 warning.main) */
export function SlashNote({ text, warn }: { text: string; warn?: boolean }) {
  return warn ? (
    <Box component="span" sx={{ color: 'warning.main' }}>
      {text}
    </Box>
  ) : (
    <>{text}</>
  );
}
