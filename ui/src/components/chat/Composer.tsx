/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 입력 카드: 입력칸·첨부·키 안내·전송(또는 중지)을 한 카드에 모은다(스펙 §4-4).
// 채팅·회의·오피스 장면 대화가 같이 쓴다. 전송 키는 sendOn 으로 고른다. 채팅·회의·오피스 대화 모두 Enter 다(오피스 대화는 Ctrl+Enter 였다).
// suggest 를 주면 「/」 스킬·「@」 에이전트 고르기 목록을 입력창 위에 띄운다(스펙 2026-10-19-012 P3·DD1~DD12). 목록이 닫혀 있을 때의
// Enter·Shift+Enter·Ctrl/Cmd+Enter·한글 조합 동작은 그대로다(R6). 목록이 열려 있으면 Enter·Tab 은 고르기, Ctrl/Cmd+Enter 는 그래도 보내기.
import SendIcon from '@mui/icons-material/Send';
import StopRoundedIcon from '@mui/icons-material/StopRounded';
import { Box, Button, IconButton, InputBase, Tooltip } from '@mui/material';
import { forwardRef, KeyboardEvent, ReactNode, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';

import { tier1, tier2 } from '@/components/tierButton';
import { t } from '@/i18n';
import { chatMetrics, chatType } from '@/lib/chatTokens';
import { activeToken, applyPick, applyPickToFront, filterItems, pickable, SuggestItem, SuggestWhere } from '@/lib/composerSuggest';

import { ReadBand, ReadLive, useReadBand } from './ReadAloud';
import { SuggestList, SuggestState } from './SuggestList';
import { useChatTokens } from './useChatTokens';
import { useVoiceView, VoiceBand, VoiceButton, VoiceEdit, VoiceLine, voiceRecorder, VoiceTarget } from './VoiceInput';

/** 고르기 목록 하나(「/」 또는 「@」). 항목은 부르는 쪽이 읽어 넘긴다 — 보낼 때 같은 목록으로 스킬을 가려야 해서다(R7) */
export interface ComposerSuggest {
  trigger: '/' | '@';
  where: SuggestWhere;
  /** 목록 머리줄(「스킬」·「에이전트」) */
  title: string;
  /** null 은 읽는 중 */
  items: SuggestItem[] | null;
  error?: boolean;
  onRetry?: () => void;
  loadingText?: string;
  errorText?: string;
  emptyText?: string;
  emptyLink?: { href: string; label: string };
  /** 맨 아래 고정 경고 줄(DD4) */
  warning?: string;
  /** where: 'start' 의 시작 위치(회의실은 앞의 @이름 들 뒤) */
  startAt?: (value: string) => number;
  /** 처음 열릴 때 한 번 — 목록을 그때 읽는다 */
  onOpen?: () => void;
  noMatchText: string;
  /** 화면 읽기 개수 글. shown 은 지금 보이는 줄(묶음별로 세는 「/」 목록, 스펙 2026-10-26-010 DC12) */
  countText: (n: number, shown?: SuggestItem[]) => string;
  /** 손가락 화면에서 입력칸 옆에 둘 「/」 단추의 이름(DD7). 없으면 단추를 두지 않는다 */
  touchButton?: string;
  /** where 'start' 목록을 글 중간(공백 뒤)에서도 연다. 고르면 맨 앞으로 옮긴다(스펙 2026-10-26-010 12-7) */
  anywhere?: boolean;
}

export interface ComposerHandle {
  focus(): void;
}

export interface ComposerProps {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  /** 'enter': Enter 전송·Shift+Enter 줄바꿈(Ctrl/Cmd+Enter 도 전송). 'mod-enter': Ctrl/Cmd+Enter 만 전송. */
  sendOn: 'enter' | 'mod-enter';
  /** false 면 전송 단추가 비활성이고 키로도 보내지 않는다(줄바꿈도 만들지 않는다). */
  canSend: boolean;
  busy?: boolean;
  /** 답하는 중에도 보낼 글이다(/steer·/queue, 스펙 2026-10-26-010 DC6). 참이면 멈춤 단추 앞에 보내기 단추를 둔다 */
  sendWhileBusy?: boolean;
  onStop?: () => void;
  /** 참이면 멈춤 단추도 비활성이다 — 연결이 끊긴 동안 내려간 서버로 보내지 않게(스펙 2026-10-20-030 DR5) */
  stopDisabled?: boolean;
  placeholder?: string;
  /** 입력칸의 접근성 이름 */
  inputLabel: string;
  sendLabel: string;
  stopLabel?: string;
  /** 키 안내 글자 */
  hint?: ReactNode;
  /** 입력칸 위(칩 줄·업로드 줄) */
  top?: ReactNode;
  /** 입력칸 아래 왼쪽(첨부 단추) */
  leading?: ReactNode;
  /** 추가로 입력칸을 설명하는 요소 id(전송이 막힌 이유 등) */
  describedBy?: string;
  /** 키 안내를 눈에서 숨긴다(대화 팝업). 화면 읽기 프로그램에는 남는다. */
  compact?: boolean;
  /** 고르기 목록(스펙 2026-10-19-012) */
  suggest?: ComposerSuggest[];
  /** 키 안내 뒤에 늘 보이는 한 줄(「· 스킬 /요약 으로 보냅니다」, DD6·DD9). compact 에서도 보인다 */
  note?: ReactNode;
  /** 주면 [첨부] 다음에 마이크 단추를 둔다(「말로 입력」, 스펙 2026-10-22-005 D2). 받은 글은 이 입력칸의 커서 자리에 넣는다 */
  voice?: VoiceTarget;
  /** 이 입력칸의 대화(읽어 주기 상태 키의 대화 id). 주면 이 대화의 답을 읽는 동안 아래 줄 가운데에 읽는 중 띠를 둔다(스펙 2026-10-28-012 DD4) */
  readConv?: string;
}

/** 조합이 끝나고 보내기까지 기다리는 시간. 확정된 글자로 다시 그려지고, 뒤따르는 Enter 이벤트가 지나갈 만큼 */
const IME_SEND_DELAY_MS = 30;
/** 2차 인식 결과를 이만큼 들고 있는다: 한글 조합 중이거나 사용자가 방금 손댔을 때(스펙 2026-11-01-001 D16) */
const VOICE_HOLD_MS = 1000;

const hidden = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
} as const;

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { value, onChange, onSend, sendOn, canSend: canSendProp, busy, sendWhileBusy, onStop, stopDisabled, placeholder, inputLabel, sendLabel, stopLabel, hint, top, leading, describedBy, compact, suggest, note, voice, readConv },
  ref
) {
  const tk = useChatTokens();
  const input = useRef<HTMLTextAreaElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const noteId = useId();
  const listId = useId();
  // 말로 입력: 녹음·받아쓰는 동안 보내기를 막는다(16A). 막기는 여기 한 곳에서 — Enter·단추·조합 뒤 늦은 보내기 모두(E3)
  const voiceOwner = useId();
  const bandId = useId();
  const lineId = useId();
  const vv = useVoiceView(voiceOwner);
  const voiceBusy = !!voice && vv.busy;
  const canSend = canSendProp && !voiceBusy;
  // 보내기는 모두 여기를 지난다(Enter·조합 뒤 Enter·단추 둘). 다듬는 중에 보내면 남은 2차 결과는 버린다(스펙 2026-11-01-001 D14)
  const send = () => {
    if (voice) {
      voiceText.current = null;
      voiceRecorder.sent(voiceOwner);
    }
    onSend();
  };
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }), []);

  // ---- 고르기 목록 --------------------------------------------------------
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState('');
  const [active, setActive] = useState(0);
  const found = (suggest ?? [])
    .map((src) => {
      const at = src.startAt?.(value) ?? 0;
      const tok = activeToken(value, caret, src.trigger, src.where, at);
      // 맨 앞이 아니면 공백 뒤 「/」도 연다(anywhere). 맨 앞에 이미 /낱말이 있으면 그 낱말이 먼저다
      return { src, tok: tok ?? (src.anywhere && src.where === 'start' ? activeToken(value, caret, src.trigger, 'word', at) : null) };
    })
    .find((x) => x.tok);
  const src = found?.src;
  const tok = found?.tok ?? null;
  const tokKey = tok && src ? `${src.trigger}${tok.start}:${tok.query}` : '';
  const shown = src?.items ? filterItems(src.items, tok?.query ?? '') : [];
  const state: SuggestState | null = !src ? null : src.items === null ? 'loading' : src.error ? 'error' : src.items.length === 0 ? 'empty' : 'list';
  // 맞는 것이 0개면 닫고 Enter 는 보내기(DD2). Esc 로 닫은 낱말은 바뀔 때까지 다시 열지 않는다
  const open = focused && !!tok && tokKey !== dismissed && !!state && (state !== 'list' || shown.length > 0);
  const optionId = (i: number) => `${listId}-o${i}`;
  useEffect(() => {
    if (src && tok) src.onOpen?.(); // 부르는 쪽이 한 번만 읽는다(useSkillSuggest)
  }, [tokKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // 처음 고른 줄은 고를 수 있는 첫 줄(상태 줄은 건너뛴다, DC1)
  const firstPick = shown.findIndex(pickable);
  useEffect(() => setActive(state === 'list' ? firstPick : -1), [tokKey, state, firstPick]);

  // 화면 읽기 프로그램: 열릴 때와 개수가 바뀔 때만 300ms 모아 알린다(DD12)
  const liveWant = !tok || !src || tokKey === dismissed ? '' : state === 'list' ? (shown.length ? src.countText(shown.length, shown) : src.noMatchText) : state === 'loading' ? (src.loadingText ?? '') : state === 'error' ? (src.errorText ?? '') : (src.emptyText ?? '');
  const [live, setLive] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setLive(liveWant), 300);
    return () => clearTimeout(id);
  }, [liveWant]);

  // 고른 뒤 커서는 값이 바뀐 바로 그 그리기에서 놓는다. 다음 프레임(requestAnimationFrame)으로 미루면 그 사이 친 글자 앞으로
  // 커서가 되돌아가 「정리」가 「리정」이 됐다(시험에서 찾음)
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const at = pendingCaret.current;
    if (at === null || !input.current) return;
    pendingCaret.current = null;
    input.current.focus();
    input.current.setSelectionRange(at, at);
  });
  const placeCaret = (at: number) => {
    pendingCaret.current = at;
    setCaret(at);
  };
  const pick = (item: SuggestItem) => {
    if (item.note) {
      item.action?.(); // 상태 줄(「다시 시도」)은 입력창에 넣지 않는다
      return;
    }
    if (!tok || !src) return;
    const at = src.startAt?.(value) ?? 0;
    let lead = at;
    while (lead < value.length && /\s/.test(value[lead])) lead++;
    // 글 중간에서 고른 명령·스킬은 실행되는 자리(맨 앞)로 옮긴다
    const r = src.where === 'start' && tok.start > lead ? applyPickToFront(value, tok, item, at) : applyPick(value, tok, item);
    onChange(r.value);
    placeCaret(r.caret);
  };
  const actStatus = () => {
    if (state === 'error') src?.onRetry?.();
    else if (state === 'empty' && src?.emptyLink) window.location.hash = src.emptyLink.href.replace(/^#/, '');
  };
  const sug = useRef({ open, state, shown, active, pick, actStatus });
  sug.current = { open, state, shown, active, pick, actStatus };

  // 한글 조합 중 Enter 는 글자 확정에 쓰인다. 그 Enter 를 기억했다가 조합이 끝나면 보낸다 — 끝 글자가 조합 중이면 Enter 로
  // 보내지지 않고 Ctrl+Enter(Ctrl 이 조합을 먼저 끝낸다)만 보내졌다(2026-10-16 사용자 보고). 조합이 끝난 뒤 바뀐 값으로 다시
  // 그린 다음 보내도록 한 박자 늦추고, 그 사이 브라우저가 Enter 를 한 번 더 보내면(macOS Chrome) 그 Enter 는 버린다.
  const latest = useRef({ onSend: send, canSend });
  latest.current = { onSend: send, canSend };
  const afterIme = useRef<'none' | 'pending' | 'sending'>('none');
  useEffect(() => () => void (afterIme.current = 'none'), []);

  const onKeyDown = (e: KeyboardEvent) => {
    userAt.current = Date.now();
    const mod0 = e.metaKey || e.ctrlKey;
    if (open && !e.nativeEvent.isComposing) {
      const count = state === 'list' ? shown.length : state === 'error' ? (src?.onRetry ? 1 : 0) : state === 'empty' ? (src?.emptyLink ? 1 : 0) : 0;
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && count) {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        const ok = (i: number) => state !== 'list' || pickable(shown[i]); // 할 일이 없는 상태 줄은 건너뛴다
        setActive((a) => {
          let i = a < 0 ? (step > 0 ? -1 : count) : a;
          for (let n = 0; n < count; n++) {
            i = (i + step + count) % count;
            if (ok(i)) return i;
          }
          return a;
        });
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation(); // 목록만 닫는다 — 서랍·창까지 닫히지 않게(DD10)
        setDismissed(tokKey);
        return;
      }
      if ((e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !mod0)) && active >= 0) {
        e.preventDefault();
        if (state === 'list' && shown[active]) pick(shown[active]);
        else actStatus();
        return;
      }
    }
    if (e.key !== 'Enter') {
      if (afterIme.current === 'pending' && !e.nativeEvent.isComposing) afterIme.current = 'none'; // 조합이 끝나지 않은 채 다른 키로 넘어갔다
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    const sends = sendOn === 'enter' ? !e.shiftKey || mod : mod;
    if (e.nativeEvent.isComposing) {
      if (sends) afterIme.current = 'pending';
      return;
    }
    if (!sends) return;
    e.preventDefault();
    if (afterIme.current === 'sending') return; // 조합을 끝낸 Enter 가 한 번 더 왔다 — 곧 보낸다
    if (canSend) send();
    else if (voiceBusy) voiceRecorder.sendBlocked(voiceOwner);
  };

  // 받아쓴 글 넣기(17A): 글이 도착한 때의 커서(선택 영역이면 그 끝) 자리에 넣고, 앞 글자가 공백이 아니면 공백 하나를 앞에 둔다.
  // 시작한 입력칸이 포커스를 갖고 있으면 insertText 로 넣어 Ctrl+Z 한 번으로 되돌리게 하고, 아니면 값 바꾸기로 넣는다(§11 M4).
  // 한글 조합 중이면 들고 있다가 조합이 끝난 뒤 넣는다(15A)
  // 스트리밍의 확정 구간(append, OMAI-1554 D19)은 커서와 관계없이 글 끝에 덧붙이고, 사용자가 입력칸에서 고치는 중이면 그 커서·선택을 그대로 둔다.
  // 이미 넣은 글은 바꾸지 않는다. 구간이 연달아 와도 앞 구간을 덮지 않게 latestValue 를 바로 고친다(다시 그리기 전에 다음 구간이 온다)
  const composing = useRef(false);
  const heldVoice = useRef<{ text: string; append: boolean } | null>(null);
  const keepSel = useRef<[number, number] | null>(null);
  useLayoutEffect(() => {
    const sel = keepSel.current;
    if (!sel || !input.current) return;
    keepSel.current = null;
    if (document.activeElement === input.current) input.current.setSelectionRange(sel[0], sel[1]);
  });
  /** 사용자가 커서를 놓은 적이 있는가. 없으면 글 끝에 넣는다 — 손대지 않은 입력칸의 selectionEnd 는 브라우저마다 0 일 수 있다 */
  const userCaret = useRef(false);
  const latestValue = useRef({ value, onChange });
  latestValue.current = { value, onChange };
  // 2차 인식(스펙 2026-11-01-001 D27): 이번 녹음이 덧붙인 글의 시작 자리와 내용. 녹음 중 그 글을 고치거나 사이에 글을 치면 broken.
  // 바꿀 때 그 자리 글이 그대로인지 다시 보고(D17), 앞에 글을 쳐 자리가 밀렸으면 같은 글이 하나뿐일 때만 그것으로 본다
  const voiceText = useRef<{ start: number; text: string; broken: boolean; original: string | null } | null>(null);
  /** 사용자가 마지막으로 입력칸에 손댄 때(키·포인터·입력). 앱이 넣은 글·옮긴 선택은 세지 않는다(D16) */
  const userAt = useRef(0);
  const insertVoice = (text: string, opts?: { append?: boolean }) => {
    if (composing.current) {
      const held = heldVoice.current;
      heldVoice.current = { text: held ? `${held.text} ${text}` : text, append: (held?.append ?? true) && !!opts?.append };
      return;
    }
    const el = input.current;
    const v = latestValue.current.value;
    if (opts?.append) {
      const next = v + (v && !/\s$/.test(v) ? ' ' : '') + text;
      const r = voiceText.current;
      if (!r) voiceText.current = { start: next.length - text.length, text, broken: false, original: null };
      else if (!r.broken) {
        if (v.slice(r.start) === r.text) r.text = next.slice(r.start);
        else r.broken = true; // 녹음 중 이 글을 고쳤거나 뒤에 글을 쳤다 — 다듬지 않는다
      }
      const focused = !!el && document.activeElement === el;
      if (focused && el) keepSel.current = [el.selectionStart ?? v.length, el.selectionEnd ?? v.length];
      latestValue.current = { ...latestValue.current, value: next };
      latestValue.current.onChange(next);
      return;
    }
    if (voiceText.current) voiceText.current.broken = true; // 일괄 경로로 커서 자리에 넣었다 — 이번 녹음 글이 이어지지 않는다
    const at = userCaret.current && el ? Math.min(el.selectionEnd ?? v.length, v.length) : v.length;
    const s = (at > 0 && !/\s/.test(v[at - 1]) ? ' ' : '') + text;
    if (el && document.activeElement === el && typeof document.execCommand === 'function') {
      el.setSelectionRange(at, at);
      let ok = false;
      try {
        ok = document.execCommand('insertText', false, s);
      } catch {
        ok = false;
      }
      if (ok) {
        setCaret(at + s.length);
        return;
      }
    }
    latestValue.current.onChange(v.slice(0, at) + s + v.slice(at));
    placeCaret(at + s.length); // 넣은 글 끝에 커서를 두고 입력칸에 포커스를 돌려준다
  };

  /** 이번 녹음 글을 to 로 바꾼다. 그 자리 글이 녹음이 넣은 그대로가 아니면 하지 않는다 */
  const swapVoice = (to: string): boolean => {
    const r = voiceText.current;
    if (!r || r.broken) return false;
    const v = latestValue.current.value;
    let at = v.slice(r.start, r.start + r.text.length) === r.text ? r.start : -1;
    if (at < 0) {
      const i = v.indexOf(r.text);
      at = i >= 0 && v.indexOf(r.text, i + 1) < 0 ? i : -1;
    }
    if (at < 0 || r.text === to) return false;
    const next = v.slice(0, at) + to + v.slice(at + r.text.length);
    const el = input.current;
    if (el && document.activeElement === el) {
      // 커서·선택은 바꾼 글 뒤면 길이 차이만큼 옮기고, 바꾼 글 안이면 바꾼 글 끝을 넘지 않게 한다
      const end = at + r.text.length;
      const move = (p: number) => (p >= end ? p + to.length - r.text.length : Math.min(p, at + to.length));
      keepSel.current = [move(el.selectionStart ?? v.length), move(el.selectionEnd ?? v.length)];
    }
    voiceText.current = { start: at, text: to, broken: false, original: r.original ?? r.text };
    latestValue.current = { ...latestValue.current, value: next };
    latestValue.current.onChange(next);
    return true;
  };
  const voiceEdit: VoiceEdit = {
    begin: () => void (voiceText.current = null),
    refine: async (text) => {
      const deadline = Date.now() + VOICE_HOLD_MS;
      const held = () =>
        composing.current || (document.activeElement === input.current && Date.now() - userAt.current < VOICE_HOLD_MS);
      while (held()) {
        if (Date.now() >= deadline) return false; // 계속 손대고 있다 — 다듬지 않는다
        await new Promise((ok) => setTimeout(ok, 100));
      }
      return swapVoice(text);
    },
    undo: () => {
      const r = voiceText.current;
      if (!r?.original || !swapVoice(r.original)) return;
      voiceText.current = { ...voiceText.current!, broken: true }; // 되돌린 글은 이후 바꾸지 않는다(D19)
    },
  };

  const onCompositionEnd = () => {
    composing.current = false;
    if (heldVoice.current) {
      const held = heldVoice.current;
      heldVoice.current = null;
      setTimeout(() => insertVoice(held.text, held.append ? { append: true } : undefined), 0); // 확정된 글자로 다시 그려진 뒤에 넣는다
    }
    if (afterIme.current !== 'pending') return;
    afterIme.current = 'sending';
    setTimeout(() => {
      if (afterIme.current !== 'sending') return;
      afterIme.current = 'none';
      const g = sug.current; // 조합을 끝낸 Enter 는 목록이 열려 있으면 고르기다(R6)
      if (g.open && g.state === 'list' && g.active >= 0 && g.shown[g.active]) g.pick(g.shown[g.active]);
      else if (latest.current.canSend) latest.current.onSend();
    }, IME_SEND_DELAY_MS);
  };

  const touch = { '@media (pointer: coarse)': { minWidth: chatMetrics.touch, minHeight: chatMetrics.touch } };
  const touchChildren = { '@media (pointer: coarse)': { '& button': { minWidth: chatMetrics.touch, minHeight: chatMetrics.touch } } };
  // 녹음 띠가 키 안내를 가리는 동안 입력칸 설명은 띠·안내 줄의 문구를 가리킨다(§11 R14·L3)
  // 읽는 중 띠도 같은 자리·규칙이다. 녹음 중이면 녹음 띠가 앞선다(DD4) — 녹음을 시작하면 읽기가 멈추므로 둘이 함께 보일 일은 거의 없다
  const readBandId = useId();
  const reading = useReadBand(readConv) && !(voice && vv.band);
  const band = (!!voice && vv.band) || reading;
  // 녹음 띠가 보이는 동안 입력칸은 줄어들지 않는다 — 다듬은 글이 짧아도 띠가 닫힐 때까지 높이를 둔다(D20)
  const voiceBand = !!voice && vv.band;
  const [frozenH, setFrozenH] = useState(0);
  useLayoutEffect(() => {
    if (!voiceBand) {
      if (frozenH) setFrozenH(0);
      return;
    }
    const h = input.current ? parseFloat(getComputedStyle(input.current).height) : 0;
    if (h > frozenH) setFrozenH(h);
  }, [voiceBand, frozenH, value]); // 글이 바뀔 때마다(늘어난 높이) 다시 잰다
  const describedIds = [band ? (reading ? readBandId : bandId) : hint ? hintId : '', !band && note ? noteId : '', voice && vv.line ? lineId : '', describedBy ?? ''].filter(Boolean).join(' ') || undefined;
  const slash = suggest?.find((x) => x.trigger === '/' && x.touchButton);
  // 손가락 화면의 「/」 단추(DD7): 글 맨 앞(회의실은 @이름 들 뒤)에 / 를 넣고 목록을 연다. 이미 /낱말이 있으면 그 끝으로 커서만
  const pressSlash = () => {
    if (!slash) return;
    let i = slash.startAt?.(value) ?? 0;
    while (i < value.length && /\s/.test(value[i])) i++;
    if (value[i] === '/') {
      let end = i;
      while (end < value.length && !/\s/.test(value[end])) end++;
      placeCaret(end);
    } else {
      const rest = value.slice(i);
      onChange(value.slice(0, i) + '/' + (rest && !/^\s/.test(rest) ? ' ' : '') + rest); // 뒤 글과 붙지 않게 공백 하나
      placeCaret(i + 1);
    }
    setDismissed('');
  };

  return (
    <Box
      ref={root}
      sx={{
        border: `1px solid ${tk.line}`,
        borderRadius: `${chatMetrics.panelRadius}px`,
        bgcolor: tk.composer,
        '&:focus-within': { borderColor: tk.composerFocus },
      }}
    >
      {top && <Box sx={{ px: 1.5, pt: 1 }}>{top}</Box>}
      <InputBase
        multiline
        maxRows={8}
        fullWidth
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          userCaret.current = true;
          userAt.current = Date.now();
          setCaret(e.target.selectionStart ?? e.target.value.length);
        }}
        inputRef={input}
        inputProps={{
          'aria-label': inputLabel,
          'aria-describedby': describedIds,
          onKeyDown,
          onCompositionEnd,
          onCompositionStart: () => void (composing.current = true),
          onPointerDown: () => void (userAt.current = Date.now()),
          onSelect: (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
            userCaret.current = true;
            setCaret(e.currentTarget.selectionStart ?? 0);
          },
          onFocus: () => setFocused(true),
          onBlur: () => setFocused(false),
          ...(suggest?.length
            ? {
                'aria-autocomplete': 'list' as const,
                'aria-controls': open && state === 'list' ? listId : undefined,
                'aria-activedescendant': open && active >= 0 ? optionId(active) : undefined,
              }
            : {}),
        }}
        sx={{
          px: 1.5,
          pt: 1.25,
          pb: 0.5,
          fontSize: chatType.body,
          lineHeight: chatType.bodyLine,
          color: tk.text,
          ...(frozenH ? { '& textarea': { minHeight: `${frozenH}px` } } : {}),
        }}
      />
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1, pb: 1, pt: 0.25 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', ...touchChildren }}>
          {leading}
          {slash && (
            <Tooltip title={slash.touchButton}>
              <IconButton
                aria-label={slash.touchButton}
                size="small"
                onPointerDown={(e) => e.preventDefault()}
                onClick={pressSlash}
                sx={{ color: tk.muted, fontSize: 15, fontWeight: 600, display: 'none', '@media (pointer: coarse)': { display: 'inline-flex' } }}
              >
                /
              </IconButton>
            </Tooltip>
          )}
        </Box>
        {band && !reading && <VoiceBand owner={voiceOwner} id={bandId} blocked={!!voice?.blockedReason} refresh={voice?.refresh} />}
        {reading && readConv && <ReadBand conv={readConv} id={readBandId} suggestOpen={open} rootRef={root} />}
        {!band && (
          <>
            <Box
              id={hintId}
              sx={{ minWidth: 0, fontSize: chatType.meta, color: tk.muted, ...(compact ? hidden : { flex: '0 0 auto', whiteSpace: 'nowrap' }) }}
            >
              {hint}
            </Box>
            {note && (
              <Box id={noteId} sx={{ minWidth: 0, flex: '0 1 auto', fontSize: chatType.meta, color: tk.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {note}
              </Box>
            )}
            {/* AI 답이 틀릴 수 있다는 안내. 전송 단추 바로 앞, 오른쪽에 붙인다. 팝업(compact)은 키 안내를 눈에서 숨기려고 position: absolute 로 빼
                사이를 채우던 칸이 사라지므로, 이 글이 그 칸을 대신 채워(flex: 1) 전송 단추를 오른쪽 끝에 둔다(키 안내가 보일 때도 같은 규칙). 좁으면 키 안내는 그대로 두고 이 글이 말줄임표로 줄며, 전체는 title 로 본다 */}
            <Box
              title={t('chat.disclaimer')}
              sx={{
                minWidth: 0,
                flex: 1,
                contain: 'inline-size', // 글 길이가 줄 전체의 최소 폭이 되지 않게 한다 — 없으면 좁은 화면에서 입력 카드가 부모 밖으로 밀려 나간다
                fontSize: chatType.micro,
                color: tk.muted,
                textAlign: 'right',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {t('chat.disclaimer')}
            </Box>
          </>
        )}
        {/* 마이크는 전송 단추 바로 앞(스펙 2026-10-22-005 §8-13 — 디자인 1A 의 「첨부 다음」을 바꿈).
            녹음 중에는 녹음 띠(경과·✕·✓)가 이 앞에 온다 */}
        {voice && (
          <Box sx={{ display: 'flex', alignItems: 'center', ...touchChildren }}>
            <VoiceButton owner={voiceOwner} voice={voice} onInsert={insertVoice} onEdit={voiceEdit} suggestOpen={open} rootRef={root} />
          </Box>
        )}
        {busy && sendWhileBusy && (
          // 답하는 중 /steer·/queue(DC6): [보내기][멈춤]. 손가락 화면은 각 44px(DC12)
          <Button
            variant="outlined"
            color="inherit"
            aria-label={sendLabel}
            disabled={!canSend}
            onClick={send}
            sx={[tier1 as object, { minWidth: 0, width: 32, height: 32, p: 0, borderRadius: '8px' }, touch]}
          >
            <SendIcon fontSize="small" />
          </Button>
        )}
        {busy ? (
          <Button
            variant="outlined"
            color="inherit"
            aria-label={stopLabel}
            disabled={stopDisabled}
            onClick={onStop}
            sx={[tier2 as object, { minWidth: 0, width: 32, height: 32, p: 0, borderRadius: '8px' }, touch]}
          >
            <StopRoundedIcon fontSize="small" />
          </Button>
        ) : (
          <Button
            variant="outlined"
            color="inherit"
            aria-label={sendLabel}
            disabled={!canSend}
            onClick={send}
            sx={[tier1 as object, { minWidth: 0, width: 32, height: 32, p: 0, borderRadius: '8px' }, touch]}
          >
            <SendIcon fontSize="small" />
          </Button>
        )}
      </Box>
      {voice && <VoiceLine owner={voiceOwner} id={lineId} />}
      {readConv && <ReadLive conv={readConv} />}
      {suggest?.length ? (
        <Box aria-live="polite" sx={hidden}>
          {live}
        </Box>
      ) : null}
      {open && src && state && (
        <SuggestList
          anchor={root.current}
          id={listId}
          title={src.title}
          state={state}
          items={shown}
          active={active}
          optionId={optionId}
          onPick={pick}
          onHover={setActive}
          loadingText={src.loadingText}
          errorText={src.errorText}
          onRetry={src.onRetry}
          emptyText={src.emptyText}
          emptyLink={src.emptyLink}
          warning={src.warning}
        />
      )}
    </Box>
  );
});
