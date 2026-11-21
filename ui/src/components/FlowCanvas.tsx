/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 흐름 캔버스: 노드는 버튼(키보드·읽기 프로그램에 그대로 잡힌다), 선은 그 아래 SVG 한 장.
// 끌어서 움직이고, Ctrl(⌘)+휠로 확대·축소하고, 노드에서는 방향키로 옆 노드로 간다.
import { Box, Button, Stack, Typography } from '@mui/material';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { getLang, t } from '@/i18n';
import { confLabel, kindLabel, relLabel } from '@/lib/flowLabels';
import { FEdge, FNode, Graph, GX, Layout, layout, NODE_H, NODE_W, PAD } from '@/lib/flowLayout';

import { kindColor, KindMark } from './KindMark';

const MIN = 0.3;
const MAX = 1.6;

const curve = (x1: number, y1: number, x2: number, y2: number) => {
  const dx = Math.max(28, Math.abs(x2 - x1) / 2) * Math.sign(x2 - x1 || 1);
  return `C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
};

function pathOf(L: Layout, e: FEdge): string {
  const a = L.pos[e.from];
  const b = L.pos[e.to];
  const ya = a.y + NODE_H / 2;
  const yb = b.y + NODE_H / 2;
  if (b.c === a.c) {
    const x = a.x + NODE_W;
    const bow = 34 + Math.min(40, Math.abs(yb - ya) / 6);
    return `M${x},${ya} C${x + bow},${ya} ${x + bow},${yb} ${x + 7},${yb}`; // 같은 단: 오른쪽으로 휘어 돌아온다
  }
  const fwd = b.c > a.c;
  const lanes = (L.via.get(e) ?? []).map((id) => L.pos[id]);
  if (!fwd) lanes.reverse();
  let x = fwd ? a.x + NODE_W : a.x;
  let y = ya;
  let d = `M${x},${y} `;
  for (const p of lanes) {
    const y2 = p.y + p.h / 2;
    const xin = fwd ? p.x : p.x + NODE_W;
    const xout = fwd ? p.x + NODE_W : p.x;
    d += curve(x, y, xin, y2) + ` L${xout},${y2} `;
    x = xout;
    y = y2;
  }
  const xe = fwd ? b.x - 7 : b.x + NODE_W + 7;
  return d + curve(x, y, xe, yb);
}

/** 그림에 보일 둘째 줄. 단 제목·종류 표시와 겹치는 말(「스킬 내부 스크립트」·「외부 호스트」)은 뺀다(스펙 2026-10-28-013 디자인 D8).
 *  서버 sub 는 그대로 두어 찾기·목록 탭·번역은 바뀌지 않는다. */
export function shortSub(n: FNode): string {
  if (n.kind === 'host') return '';
  if (n.kind === 'script' || n.kind === 'skill') return n.sub.split(' · ')[0];
  return n.sub;
}

function labelAt(L: Layout, e: FEdge): [number, number] {
  const a = L.pos[e.from];
  const b = L.pos[e.to];
  const lanes = L.via.get(e) ?? [];
  if (lanes.length) {
    const p = L.pos[lanes[Math.floor(lanes.length / 2)]];
    return [p.x + NODE_W / 2, p.y + p.h / 2 - 3];
  }
  return [(a.x + (b.c > a.c ? NODE_W : 0) + b.x + (b.c < a.c ? NODE_W : 0)) / 2, (a.y + b.y) / 2 + NODE_H / 2 - 4];
}

const DASH: Record<string, string | undefined> = { mention: '3 4', observed: '10 5' };
const WIDTH: Record<string, number> = { code: 2.2, config: 2.2, doc: 1.3, mention: 1.3, observed: 1.6 };

interface Props {
  graph: Graph;
  hide: Set<string>;
  query: string;
  selected: string | null;
  onSelect: (n: FNode | null) => void;
  onEdge: (e: FEdge) => void;
  /** 노드를 두 번 누르거나 Enter — 그 노드로 옮겨 간다(스킬 화면의 연결도 탭). 없으면 고르기만 한다 */
  onOpen?: (n: FNode) => void;
}

export function FlowCanvas({ graph, hide, query, selected, onSelect, onEdge, onOpen }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const lang = getLang();
  // 단 제목은 언어에 따라 달라지므로 언어가 바뀌면 배치를 다시 만든다
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const L = useMemo(() => layout(graph, hide), [graph, hide, lang]);
  const [view, setView] = useState({ scale: 1, tx: 0, ty: 0 });
  const drag = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null);

  const size = () => ({ w: host.current?.clientWidth ?? 0, h: host.current?.clientHeight ?? 0 });

  /** 글자가 읽히는 크기를 지킨다: 전체가 안 들어가면 0.8배까지만 줄이고 중심 노드부터 보이게 둔다. */
  const fit = useCallback(
    (whole = false) => {
      const { w, h } = size();
      const full = Math.min(1, (w - 16) / L.width, (h - 16) / L.height);
      const scale = whole ? Math.max(MIN, full) : Math.max(0.8, full);
      let tx = L.width * scale <= w ? (w - L.width * scale) / 2 : 12;
      // 낮은 그림은 가로처럼 세로도 가운데에 둔다(2026-10-17-023). 넘치면 아래에서 중심 노드 쪽으로 옮긴다
      let ty = L.height * scale <= h ? Math.max(8, (h - L.height * scale) / 2) : 8;
      const p = L.pos[graph.root];
      if (p && L.width * scale > w) tx = Math.min(12, w * 0.3 - p.x * scale);
      if (p && L.height * scale > h) ty = Math.min(8, h * 0.4 - p.y * scale);
      setView({ scale, tx, ty });
    },
    [L, graph.root]
  );
  useLayoutEffect(() => fit(), [fit]);

  const zoomBy = (f: number, cx = size().w / 2, cy = size().h / 2) =>
    setView((v) => {
      const ns = Math.max(MIN, Math.min(MAX, v.scale * f));
      return { scale: ns, tx: cx - ((cx - v.tx) * ns) / v.scale, ty: cy - ((cy - v.ty) * ns) / v.scale };
    });

  const center = (id: string) => {
    const p = L.pos[id];
    if (!p) return;
    const { w, h } = size();
    setView((v) => {
      const vx = p.x * v.scale + v.tx;
      const vy = p.y * v.scale + v.ty;
      if (vx < 20 || vx + NODE_W * v.scale > w - 20 || vy < 20 || vy + NODE_H * v.scale > h - 20)
        return { ...v, tx: w / 2 - (p.x + NODE_W / 2) * v.scale, ty: h / 2 - (p.y + NODE_H / 2) * v.scale };
      return v;
    });
  };

  // 선택한 노드가 화면 밖이면 가운데로 가져온다
  useEffect(() => {
    if (selected) center(selected);
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  // 휠은 passive 가 아니어야 기본 스크롤을 막을 수 있다
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect();
        zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top);
      } else setView((v) => ({ ...v, tx: v.tx - e.deltaX, ty: v.ty - e.deltaY }));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const near = useMemo(() => {
    const s = new Set<string>(selected ? [selected] : []);
    if (selected)
      L.edges.forEach((e) => {
        if (e.from === selected) s.add(e.to);
        if (e.to === selected) s.add(e.from);
      });
    return s;
  }, [L, selected]);
  const q = query.trim().toLowerCase();
  const dimNode = (n: FNode) =>
    (!!selected && !near.has(n.id)) || (!!q && !(n.label + ' ' + n.sub).toLowerCase().includes(q));

  const arrow = (n: FNode, key: string) => {
    const dir = (
      { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] } as Record<string, number[]>
    )[key];
    if (!dir) return;
    const p = L.pos[n.id];
    const cand = L.nodes.filter(
      (m) =>
        m.id !== n.id &&
        (dir[0] ? L.pos[m.id].c === p.c + dir[0] : L.pos[m.id].c === p.c && Math.sign(L.pos[m.id].y - p.y) === dir[1])
    );
    const next = cand.sort((x, y) => Math.abs(L.pos[x.id].y - p.y) - Math.abs(L.pos[y.id].y - p.y))[0];
    if (next) {
      refs.current.get(next.id)?.focus({ preventScroll: true });
      center(next.id);
    }
  };

  return (
    <Box
      ref={host}
      data-testid="flow-stage"
      onPointerDown={(e) => {
        if ((e.target as Element).closest('[data-id],[data-tools],.fc-hit')) return;
        drag.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty, moved: false };
        try {
          host.current?.setPointerCapture(e.pointerId);
        } catch {
          /* 포인터 캡처를 못 쓰는 환경에서도 끌기는 된다 */
        }
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
        setView((v) => ({ ...v, tx: d.tx + dx, ty: d.ty + dy }));
      }}
      onPointerUp={() => {
        if (drag.current && !drag.current.moved) onSelect(null);
        drag.current = null;
      }}
      sx={{
        position: 'relative',
        overflow: 'hidden',
        width: '100%',
        height: '100%',
        minHeight: 360,
        touchAction: 'none',
        cursor: 'grab',
        bgcolor: 'background.default',
      }}
    >
      {/* 끌 때마다 바뀌는 값이라 sx(클래스 생성) 대신 style 로 준다 */}
      <Box
        data-flow-stage=""
        sx={{ position: 'absolute', left: 0, top: 0, transformOrigin: '0 0' }}
        style={{
          width: L.width,
          height: L.height,
          transform: `translate(${view.tx}px,${view.ty}px) scale(${view.scale})`,
        }}
      >
        <svg width={L.width} height={L.height} aria-hidden="true" style={{ position: 'absolute', left: 0, top: 0 }}>
          <defs>
            <marker
              id="fc-arrow"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L8,4 L0,8 z" fill="#8a94a6" />
            </marker>
          </defs>
          {L.edges.map((e) => {
            const d = pathOf(L, e);
            const on = !selected || e.from === selected || e.to === selected;
            const [mx, my] = labelAt(L, e);
            return (
              <g key={`${e.from}>${e.to}>${e.kind}`} data-edge={`${e.from}>${e.to}`} opacity={on ? 1 : 0.15}>
                <path
                  d={d}
                  fill="none"
                  stroke={selected && on ? '#4f6bed' : '#8a94a6'}
                  strokeWidth={WIDTH[e.conf] ?? 1.3}
                  strokeDasharray={DASH[e.conf]}
                  markerEnd="url(#fc-arrow)"
                />
                <path
                  className="fc-hit"
                  d={d}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={12}
                  style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onEdge(e);
                  }}
                >
                  <title>
                    {`${L.pos[e.from].n.label} → ${L.pos[e.to].n.label} · ${relLabel(e.kind) || e.kind} · ${
                      confLabel(e.conf)?.[0] ?? e.conf
                    }` + (e.meta.observed ? ` · ${t('flows.observedN', { count: e.meta.observed })}` : '')}
                  </title>
                </path>
                {e.meta.observed ? (
                  <text x={mx} y={my} textAnchor="middle" fontSize="11" fill="#4f6bed">
                    {t('flows.checkedN', { count: e.meta.observed })}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
        {L.cols.map((label, c) => (
          <Typography
            key={label}
            variant="caption"
            color="text.secondary"
            sx={{ position: 'absolute', top: 6, left: PAD + c * (NODE_W + GX), width: NODE_W }}
          >
            {label}
          </Typography>
        ))}
        {L.nodes.map((n) => {
          const p = L.pos[n.id];
          const root = n.id === graph.root;
          return (
            <Box
              key={n.id}
              component="button"
              type="button"
              ref={(el: HTMLButtonElement | null) => {
                if (el) refs.current.set(n.id, el);
                else refs.current.delete(n.id);
              }}
              data-id={n.id}
              data-dim={String(dimNode(n))}
              aria-pressed={n.id === selected}
              aria-label={
                `${kindLabel(n.kind)} ${n.label}` +
                (root ? ', ' + t('flows.centerMark') : '') +
                (n.badges.length ? ', ' + n.badges.join(', ') : '')
              }
              onClick={(ev) => {
                ev.stopPropagation();
                onSelect(n);
              }}
              onDoubleClick={
                onOpen
                  ? (ev) => {
                      ev.stopPropagation();
                      onOpen(n);
                    }
                  : undefined
              }
              onKeyDown={(ev) => {
                if (onOpen && ev.key === 'Enter' && n.id === selected) {
                  ev.preventDefault();
                  onOpen(n);
                  return;
                }
                if (['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(ev.key)) {
                  ev.preventDefault();
                  arrow(n, ev.key);
                }
              }}
              sx={{
                position: 'absolute',
                left: p.x,
                top: p.y,
                width: NODE_W,
                height: NODE_H,
                boxSizing: 'border-box',
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                px: 1,
                textAlign: 'left',
                cursor: 'pointer',
                color: 'text.primary',
                bgcolor: 'background.paper',
                border: root ? 2 : 1,
                borderColor: n.status === 'bad' ? 'error.main' : root ? 'primary.main' : 'divider',
                borderLeft: `4px solid ${kindColor(n.kind)}`,
                borderRadius: 1,
                opacity: dimNode(n) ? 0.25 : 1,
                '&[aria-pressed=true]': { outline: '2px solid', outlineColor: 'primary.main' },
              }}
            >
              <KindMark kind={n.kind} size={24} />
              <Box component="span" sx={{ minWidth: 0, flex: 1 }}>
                <Box
                  component="span"
                  sx={{
                    display: 'block',
                    fontWeight: 600,
                    fontSize: 13,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {n.label}
                </Box>
                <Box
                  component="span"
                  sx={{
                    display: 'block',
                    fontSize: 11,
                    color: 'text.secondary',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {n.badges.length ? n.badges.join(' · ') : shortSub(n)}
                </Box>
              </Box>
              {n.more ? (
                <Box
                  component="span"
                  title={t('flows.moreTitle', { n: n.more })}
                  sx={{ fontSize: 11, color: 'text.secondary' }}
                >
                  {'+' + n.more}
                </Box>
              ) : null}
            </Box>
          );
        })}
      </Box>
      <Stack
        data-tools
        direction="row"
        spacing={0.5}
        alignItems="center"
        role="group"
        aria-label={t('flows.viewControls')}
        sx={{
          position: 'absolute',
          right: 8,
          bottom: 8,
          bgcolor: 'background.paper',
          p: 0.5,
          borderRadius: 1,
          border: 1,
          borderColor: 'divider',
        }}
      >
        <Button size="small" aria-label={t('flows.zoomOut')} onClick={() => zoomBy(1 / 1.2)}>
          −
        </Button>
        <Typography variant="caption" aria-live="polite">
          {Math.round(view.scale * 100) + '%'}
        </Typography>
        <Button size="small" aria-label={t('flows.zoomIn')} onClick={() => zoomBy(1.2)}>
          +
        </Button>
        <Button size="small" onClick={() => fit()}>
          {t('flows.fitReadable')}
        </Button>
        <Button size="small" onClick={() => fit(true)}>
          {t('flows.fitAll')}
        </Button>
      </Stack>
    </Box>
  );
}
