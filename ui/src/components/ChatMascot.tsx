/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 로그인한 화면 어디서나 떠 있는 CogentAI 캐릭터 단추(OMAI-1264). 임베드 위젯(cogentai-ui/widget 의 floatingButton)과 같게 동작한다:
// 오른쪽 아래에서 시작하고, 끌어 옮길 수 있으며 옮긴 자리를 기억하고, 눌러(5px 이하 이동) 대화 창을 열고, 창이 떠 있는 동안은 숨는다.
// 대화 창은 새로 만들지 않고 상단 막대의 「AI」 단추와 같은 기존 ChatPopup 을 연다(내 에이전트 `default`).
import { keyframes } from '@emotion/react';
import { Box } from '@mui/material';
import { useEffect, useRef, useState } from 'react';

import mascotUrl from '@/assets/mascot/cogentai-chat.png';
import { t } from '@/i18n';
import { useCardAreaTop } from '@/lib/cardArea';
import { openChat, useChatPopup } from '@/lib/chatPopup';
import { PRIMARY } from '@/lib/chatStore';
import { useGuideRun } from '@/lib/guideRun';

export const MASCOT_KEY = 'aas-chat-mascot-pos';
export const MASCOT_SIZE = 90; // 위젯의 플로팅 버튼과 같은 크기
const DEFAULT_RIGHT = 20;
const DEFAULT_BOTTOM = 90; // 위젯 기본 위치(bottom-right)
const DRAG_THRESHOLD = 5; // 이 픽셀 이하로 움직인 것은 끌기가 아니라 누름이다

type Pos = { x: number; y: number };

/** 캐릭터가 화면 안에 전부 보이도록 좌표를 당긴다. */
export function clampMascot(p: Pos, view: { w: number; h: number }): Pos {
  return {
    x: Math.min(Math.max(0, p.x), Math.max(0, view.w - MASCOT_SIZE)),
    y: Math.min(Math.max(0, p.y), Math.max(0, view.h - MASCOT_SIZE)),
  };
}

const viewport = () => ({ w: window.innerWidth, h: window.innerHeight });

export const CARD_GAP = 12; // 카드 묶음 위 끝과 캐릭터 사이

/** 채팅 화면의 승인·되묻기 카드와 겹치면 카드 위로 비킨 자리(스펙 2026-10-23-005 디자인 D8). 겹치지 않으면 그대로.
 *  비킨 자리는 저장하지 않는다 — 카드가 없어지면 원래 자리로 돌아온다. */
export function avoidCards(p: Pos, cardTop: number | null): Pos {
  if (cardTop === null || p.y + MASCOT_SIZE <= cardTop - CARD_GAP) return p;
  return { x: p.x, y: Math.max(0, cardTop - CARD_GAP - MASCOT_SIZE) };
}

function readSaved(): Pos | null {
  try {
    const raw = localStorage.getItem(MASCOT_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return Number.isFinite(v?.x) && Number.isFinite(v?.y) ? clampMascot({ x: v.x, y: v.y }, viewport()) : null;
  } catch {
    return null;
  }
}

function save(p: Pos) {
  try {
    localStorage.setItem(MASCOT_KEY, JSON.stringify(p));
  } catch {
    // 저장소를 못 쓰는 창에서는 이번 접속 동안만 위치를 유지한다
  }
}

// 위젯의 stay-and-heart-beat 와 같은 동작: 가만히 있다가 두 번 두근거리고 통통 튄다(5.5초 반복)
const still = 'rotateY(0deg) scale(1) translateY(0)';
const beat = 'rotateY(0deg) scale(1.35) translateY(0)';
const hop = (y: number) => `rotateY(0deg) scale(1) translateY(${y}px)`;
const heartBeat = keyframes({
  '0%, 40%': { transform: still },
  '45%': { transform: beat },
  '50%': { transform: still },
  '55%': { transform: beat },
  '60%, 76%': { transform: still },
  '80%': { transform: hop(-17) },
  '83%, 85%': { transform: still },
  '89%': { transform: hop(-17) },
  '92%': { transform: still },
  '94%': { transform: hop(-6) },
  '96%': { transform: still },
  '98%': { transform: hop(-3) },
  '100%': { transform: still },
});

export function ChatMascot() {
  const { target } = useChatPopup();
  const guide = useGuideRun();
  const [pos, setPos] = useState<Pos | null>(readSaved);
  const drag = useRef<{ from: Pos; start: Pos; moved: boolean } | null>(null);
  const el = useRef<HTMLButtonElement>(null);
  const cardTop = useCardAreaTop();

  // 창 크기가 줄어 캐릭터가 밖으로 나가면 안으로 당긴다
  useEffect(() => {
    const onResize = () => setPos((p) => (p ? clampMascot(p, viewport()) : p));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // 대화 창이 떠 있는 동안(최소화한 칩 포함)은 숨긴다. 위젯도 창이 열리면 단추를 숨긴다.
  if (target) return null;
  // 가이드 진행 카드(알약·완료 카드 포함)가 떠 있는 동안도 숨긴다(OMAI-1274)
  if (guide.run || guide.finished) return null;

  const v = viewport();
  const base: Pos = pos ?? { x: v.w - MASCOT_SIZE - DEFAULT_RIGHT, y: v.h - MASCOT_SIZE - DEFAULT_BOTTOM };
  // 끄는 동안에는 비키지 않는다 — 손가락 밑에서 튀지 않게
  const shown = drag.current?.moved ? base : avoidCards(base, cardTop);
  const shifted = shown !== base;
  // 끌기는 화면에 보이는 자리에서 시작한다. 비킨 상태에서 끌면 비킴을 끝내고 놓은 자리를 저장한다(재리뷰 R19)
  const current = (): Pos => {
    if (pos || shifted) return shown;
    const rect = el.current?.getBoundingClientRect();
    if (rect && rect.width > 0) return { x: rect.left, y: rect.top };
    return base;
  };
  const open = () => openChat({ kind: 'chat', agent: PRIMARY });

  return (
    <Box
      component="button"
      type="button"
      ref={el}
      aria-label={t('mascot.open')}
      onPointerDown={(e: React.PointerEvent<HTMLButtonElement>) => {
        if (e.button > 0) return; // 마우스 오른쪽·가운데 단추는 무시
        drag.current = { from: current(), start: { x: e.clientX, y: e.clientY }, moved: false };
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e: React.PointerEvent<HTMLButtonElement>) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.start.x;
        const dy = e.clientY - d.start.y;
        if (!d.moved && Math.abs(dx) <= DRAG_THRESHOLD && Math.abs(dy) <= DRAG_THRESHOLD) return;
        d.moved = true;
        setPos(clampMascot({ x: d.from.x + dx, y: d.from.y + dy }, viewport()));
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        if (!d) return;
        if (d.moved) {
          if (pos) save(pos);
        } else open();
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      // 마우스·손가락은 pointerup 에서 열었다. 키보드(Enter·Space)로 누른 click 만 여기서 연다.
      onClick={(e: React.MouseEvent) => {
        if (e.detail === 0) open();
      }}
      style={pos || shifted ? { left: shown.x, top: shown.y } : { right: DEFAULT_RIGHT, bottom: DEFAULT_BOTTOM }}
      sx={{
        position: 'fixed',
        zIndex: 1050,
        width: MASCOT_SIZE,
        height: MASCOT_SIZE,
        p: 0,
        border: 0,
        borderRadius: '50%',
        bgcolor: 'transparent',
        cursor: 'pointer',
        touchAction: 'none', // 손가락으로 끌 때 화면이 같이 밀리지 않게
        userSelect: 'none',
        transition: 'transform 0.3s ease',
        '&:hover': { transform: 'scale(1.2)' },
        '&:active': { transform: 'scale(0.95)' },
        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 },
      }}
    >
      <Box
        component="img"
        src={mascotUrl}
        alt=""
        draggable={false}
        sx={{
          width: MASCOT_SIZE,
          height: MASCOT_SIZE,
          pointerEvents: 'none',
          animation: `${heartBeat} 5.5s infinite`,
          '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
        }}
      />
    </Box>
  );
}
