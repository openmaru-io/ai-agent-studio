/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 흐름 그림 화면: 위쪽 도구, 그림(또는 목록), 오른쪽 살펴보기(노드·연결·코드).
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import HistoryOutlinedIcon from '@mui/icons-material/HistoryOutlined';
import ScheduleOutlinedIcon from '@mui/icons-material/ScheduleOutlined';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  FormControlLabel,
  IconButton,
  Paper,
  Stack,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  KeyboardEvent,
  PointerEvent,
  ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { ChatChip, KV, LinkChip, ScreenLoading, Section, Tag } from '@/components/bits';
import { languageOf } from '@/components/codeLanguage';
import { useConfirm } from '@/components/ConfirmDialog';
import { pageFromLink } from '@/components/drawerPages';
import { FlowCanvas } from '@/components/FlowCanvas';
import { KindMark } from '@/components/KindMark';
import { LazyCodeEditor } from '@/components/LazyCodeEditor';
import { TextEditor } from '@/components/TextEditor';
import { useUi } from '@/components/UiContext';
import { useFillHeight } from '@/components/useFillHeight';
import { useParamPatch, useRouteDrawerParams } from '@/components/useRouteDrawer';
import { t } from '@/i18n';
import { get, post } from '@/lib/api';
import { confLabel, KIND_IDS, kindLabel, relLabel } from '@/lib/flowLabels';
import { FEdge, FNode, Graph, hostsFromRoot } from '@/lib/flowLayout';
import { MONO_FONT } from '@/lib/monoFont';
import { badgeTone, serverTerm } from '@/lib/serverTerms';
import { versionApi } from '@/lib/textApi';

import { jobDrawerSpec } from '../cron/JobDrawer';
interface FileData {
  name: string;
  path: string;
  lines: string[];
  sha: string;
  versions?: number;
  masked_lines: number[];
  modified: string;
  editable: boolean;
  why_not?: string;
  siblings: string[];
}

const confTone = (c: string) =>
  c === 'mention' ? 'warn' : c === 'doc' ? undefined : c === 'observed' ? 'warn' : 'good';
const ConfTag = ({ c }: { c: string }) => (
  <Tag tone={confTone(c) as 'warn' | 'good' | undefined}>{confLabel(c)?.[0] ?? c}</Tag>
);
const ObsTag = ({ e }: { e: FEdge }) =>
  e.meta.observed ? <Tag>{t('flows.observedN', { count: e.meta.observed })}</Tag> : null;
const base = (p: string) => p.split('/').pop() as string;
const edgeKey = (e: FEdge) => `${e.from}>${e.to}>${e.kind}`;
// 중심 패널의 종류별 묶음 순서(디자인 D12). 외부 호스트는 따로 앞에 둔다
const GROUP_ORDER = ['script', 'skill', 'mcp', 'cred', 'lib', 'cron'];
const DEFAULT_HIDE = ['lib'];
const WARN_TEXT = '#f59e0b'; // DESIGN §1-1.3 경고 = 호박색(Amber)

// ---- 근거 ----
function Evidence({ e, onCode }: { e: FEdge; onCode: (file: string, line: number) => void }) {
  if (!e.evidence.length)
    return (
      <Typography variant="caption" color="text.secondary" component="p">
        {e.conf === 'observed'
          ? t('flows.evidenceObservedOnly', { count: e.meta.observed })
          : e.meta.bundled
          ? t('flows.evidenceBundled')
          : t('flows.evidenceNone')}
      </Typography>
    );
  return (
    <Box component="ul" sx={{ m: 0, pl: 0, listStyle: 'none' }}>
      {e.evidence.map((x, i) => (
        <li key={i}>
          <Button
            size="small"
            disabled={!x.line}
            title={x.line ? t('flows.openLine') : ''}
            onClick={() => onCode(x.file, x.line ?? 0)}
            sx={{ textTransform: 'none', justifyContent: 'flex-start' }}
          >
            <Box component="span" sx={{ mr: 1, color: 'text.secondary' }}>
              {base(x.file) + (x.line ? ':' + x.line : '')}
            </Box>
            <code>{x.text || ''}</code>
          </Button>
        </li>
      ))}
    </Box>
  );
}

function Legend() {
  const line = (dash: string, w: number) => (
    <svg width="40" height="8" aria-hidden="true">
      <line x1="0" y1="4" x2="40" y2="4" stroke="#8a94a6" strokeWidth={w} strokeDasharray={dash} />
    </svg>
  );
  return (
    <Section title={t('flows.legendTitle')}>
      <Box component="ul" sx={{ m: 0, pl: 0, listStyle: 'none' }}>
        <li>
          {line('', 2.2)} {t('flows.legendThick')}
        </li>
        <li>
          {line('', 1.3)} {t('flows.legendThin')}
        </li>
        <li>
          {line('3 4', 1.3)} {t('flows.legendDotted')}
        </li>
        <li>
          {line('10 5', 1.6)} {t('flows.legendLongDash')}
        </li>
        <li>{t('flows.legendChecked')}</li>
        {KIND_IDS.map((k) => (
          <li key={k} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <KindMark kind={k} />
            {kindLabel(k)}
          </li>
        ))}
      </Box>
      <Typography variant="caption" color="text.secondary" component="p">
        {t('flows.legendNote')}
      </Typography>
    </Section>
  );
}

// ---- 코드 창 ----
function CodePane({
  graph,
  path,
  line,
  onFile,
  onDirty,
}: {
  graph: Graph;
  path: string;
  line: number;
  onFile: (p: string) => void;
  onDirty: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const q = useQuery<FileData>({
    queryKey: ['file', path],
    queryFn: () => get<FileData>(`/api/file?siblings=1&path=${encodeURIComponent(path)}`),
  });
  const [mode, setMode] = useState<'view' | 'edit' | 'history'>('view');
  // 보기에서 옮겨 간 줄. key 를 올려 같은 줄을 다시 눌러도 다시 옮긴다
  const [cur, setCur] = useState<{ line: number; key: number } | undefined>();
  const f = q.data;
  const nodeOf = (id: string) => graph.nodes.find((n) => n.id === id);
  const hits = useMemo(() => {
    const m = new Map<number, string[]>();
    graph.edges.forEach((e) =>
      e.evidence.forEach(
        (x) =>
          x.file === path &&
          x.line &&
          m.set(x.line, [...(m.get(x.line) ?? []), `${relLabel(e.kind) || e.kind} → ${nodeOf(e.to)?.label ?? e.to}`])
      )
    );
    return m;
  }, [graph, path]); // eslint-disable-line react-hooks/exhaustive-deps

  const jump = (n: number) => setCur((c) => ({ line: n, key: (c?.key ?? 0) + 1 }));
  useEffect(() => {
    if (f && line) jump(line);
  }, [f, line]); // eslint-disable-line react-hooks/exhaustive-deps
  const marks = useMemo(() => [...hits].map(([n, notes]) => ({ line: n, note: notes.join(' / ') })), [hits]);

  if (!f)
    return q.error ? (
      <Alert severity="warning">{q.error.message}</Alert>
    ) : (
      <Typography color="text.secondary">{t('flows.loading')}</Typography>
    );

  if (mode !== 'view')
    return (
      <Box>
        <Button size="small" onClick={() => setMode('view')} sx={{ mb: 1 }}>
          {t('flows.backToCode')}
        </Button>
        <TextEditor
          key={mode}
          label={f.name}
          start={mode === 'edit' ? 'edit' : 'history'}
          mode="code"
          doc={f}
          editable={f.editable}
          whyNot={f.why_not}
          hint={t('flows.versionsSkillMdOnly')}
          draftKey={'file:' + f.path}
          filename={f.name}
          check={async (c) =>
            (await post<{ problem: string }>('/api/file/preview', { path: f.path, content: c })).problem
          }
          save={(c, sha, note) => post('/api/file/save', { path: f.path, content: c, base_sha: sha, note })}
          {...versionApi(f.path)}
          diff={(id) => get(`/api/file/diff?path=${encodeURIComponent(f.path)}&id=${id}`)}
          revert={(id, sha) => post('/api/file/revert', { path: f.path, id, base_sha: sha })}
          reload={async () => {
            await qc.invalidateQueries({ queryKey: ['file', path] });
            setTimeout(() => qc.invalidateQueries({ queryKey: ['flows'] }), 12000);
            setMode('view');
          }}
          onDirtyChange={onDirty}
        />
      </Box>
    );

  return (
    <Box>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
        {f.siblings.length > 1 ? (
          <select
            aria-label={t('flows.siblingFiles')}
            value={path}
            style={{ maxWidth: '100%' }}
            onChange={(e) => onFile(e.target.value)}
          >
            {f.siblings.map((p) => (
              <option key={p} value={p}>
                {p.split('/').slice(-2).join('/')}
              </option>
            ))}
          </select>
        ) : (
          <code>{path}</code>
        )}
        <Button
          startIcon={<ContentCopyOutlinedIcon />}
          size="small"
          onClick={() => navigator.clipboard.writeText(path)}
        >
          {t('flows.copyPath')}
        </Button>
        {/* 고치기는 위에도 둔다. 긴 파일은 아래 단추까지 내려가야 했다(2026-10-17-025) */}
        {f.editable && (
          <Button
            startIcon={<EditOutlinedIcon />}
            variant="contained"
            size="small"
            sx={{ ml: 'auto !important', flexShrink: 0 }}
            onClick={() => setMode('edit')}
          >
            {t('flows.edit')}
          </Button>
        )}
      </Stack>
      <Typography variant="caption" color="text.secondary" component="div">
        {f.masked_lines.length
          ? t('flows.codeInfoMasked', {
              count: f.lines.length,
              modified: f.modified.slice(0, 16).replace('T', ' '),
              masked: f.masked_lines.length,
            })
          : t('flows.codeInfo', { count: f.lines.length, modified: f.modified.slice(0, 16).replace('T', ' ') })}
      </Typography>
      {hits.size > 0 && (
        <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap" alignItems="center" sx={{ my: 0.5 }}>
          <Typography variant="caption" color="text.secondary">
            {t('flows.evidenceLines')}
          </Typography>
          {[...hits.keys()]
            .sort((a, b) => a - b)
            .slice(0, 30)
            .map((n) => (
              <Chip
                key={n}
                size="small"
                clickable
                label={String(n)}
                title={(hits.get(n) ?? []).join(' / ')}
                onClick={() => jump(n)}
              />
            ))}
        </Stack>
      )}
      {/* 고치기 전 보기도 고칠 때와 같은 편집기(Monaco)를 읽기 전용으로 쓴다(2026-10-17-022).
          색칠·줄 번호·찾기가 같고, 근거 줄은 칠해 두고 바로가기를 누르면 그 줄로 옮긴다 */}
      <Box sx={{ my: 1 }}>
        <Suspense fallback={<Typography color="text.secondary">{t('flows.loading')}</Typography>}>
          <LazyCodeEditor
            readOnly
            value={f.lines.join('\n')}
            onChange={() => undefined}
            language={languageOf(f.name, false)}
            ariaLabel={t('flows.codeOf', { name: f.name })}
            minRows={3}
            tabIndents={false}
            marks={marks}
            focusLine={cur}
          />
        </Suspense>
      </Box>
      <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
        {f.editable && (
          <Button startIcon={<EditOutlinedIcon />} variant="contained" size="small" onClick={() => setMode('edit')}>
            {t('flows.edit')}
          </Button>
        )}
        {!!f.versions && (
          <Button
            startIcon={<HistoryOutlinedIcon />}
            size="small"
            variant="outlined"
            onClick={() => setMode('history')}
          >
            {t('flows.versions', { n: f.versions })}
          </Button>
        )}
        <Typography variant="caption" color="text.secondary">
          {f.editable ? t('flows.editNote') : f.why_not}
        </Typography>
      </Stack>
    </Box>
  );
}

// ---- 목록(트리) 보기 ----
// 행 안의 요소(점·이름·종류·관계·표시)는 글자 사이 공백이 아니라 flex gap 으로 띄운다. 단추 안의 공백 글자는 합쳐져 사라져서 붙어 보였다(2026-10-15).
const TREE_ROW_SX = {
  textTransform: 'none',
  justifyContent: 'flex-start',
  alignItems: 'center',
  flexWrap: 'wrap',
  columnGap: 1.25,
  rowGap: 0.25,
  minHeight: 32,
  px: 1,
  py: 0.5,
  textAlign: 'left',
} as const;

function Tree({
  graph,
  hide,
  sel,
  onPick,
}: {
  graph: Graph;
  hide: Set<string>;
  sel: string | null;
  onPick: (id: string) => void;
}) {
  const nodeOf = (id: string) => graph.nodes.find((n) => n.id === id);
  const seen = new Set<string>();
  const item = (id: string, e?: FEdge): ReactNode => {
    const n = nodeOf(id);
    if (!n || (hide.has(n.kind) && id !== graph.root)) return null;
    const again = seen.has(id);
    seen.add(id);
    const kids = again
      ? []
      : graph.edges
          .filter((x) => x.from === id)
          .map((x) => item(x.to, x))
          .filter(Boolean);
    return (
      <li key={id + (e ? e.kind + e.from : '')}>
        <Button size="small" aria-current={sel === id} onClick={() => onPick(id)} sx={TREE_ROW_SX}>
          <KindMark kind={n.kind} />
          <strong>{n.label}</strong>
          <Typography component="span" variant="caption" color="text.secondary">
            {kindLabel(n.kind) + (n.badges.length ? ' · ' + n.badges.map(serverTerm).join(' · ') : '')}
          </Typography>
          {e && (
            <Typography component="span" variant="caption" color="text.secondary">
              {relLabel(e.kind)}
            </Typography>
          )}
          {e && <ConfTag c={e.conf} />}
          {again && (
            <Typography component="span" variant="caption">
              {t('flows.shownAbove')}
            </Typography>
          )}
        </Button>
        {kids.length > 0 && (
          // 들여쓴 자식에는 부모와 이어지는 가는 세로선을 둔다(계층을 보이는 구조 표시)
          <Box
            component="ul"
            sx={{ listStyle: 'none', m: 0, mt: 0.25, ml: 2, pl: 1.5, borderLeft: 1, borderColor: 'divider' }}
          >
            {kids}
          </Box>
        )}
      </li>
    );
  };
  const ups = graph.nodes.filter((n) => n.depth < 0);
  return (
    <Box sx={{ p: 2, overflow: 'auto' }}>
      {ups.length > 0 && (
        <Section title={t('flows.callersTitle', { n: ups.length })}>
          <Box component="ul" sx={{ listStyle: 'none', m: 0, pl: 0 }}>
            {ups.map((n) => (
              <li key={n.id}>
                <Button size="small" onClick={() => onPick(n.id)} sx={TREE_ROW_SX}>
                  <KindMark kind={n.kind} />
                  <strong>{n.label}</strong>
                  <Typography component="span" variant="caption" color="text.secondary">
                    {n.sub}
                  </Typography>
                </Button>
              </li>
            ))}
          </Box>
        </Section>
      )}
      <Section title={t('flows.title')}>
        <Box component="ul" sx={{ listStyle: 'none', m: 0, pl: 0 }}>
          {item(graph.root)}
        </Box>
      </Section>
    </Box>
  );
}

// ---- 살펴보기 폭 조절 ----
// 그림과 살펴보기 사이 세로 선을 끌거나 ←·→ 로 살펴보기 폭을 바꾼다. 서랍 폭 손잡이(DrawerHost)와 같은 방식이다.
// 바꾼 폭은 이 브라우저에만 기억한다(사람마다 화면이 달라서). 바꾸기 전에는 개요 380px, 코드 560px.
const SIDE_KEY = 'aas.flows.sideWidth';
const SIDE_MIN = 300;
const CANVAS_MIN = 320; // 그림 자리는 이만큼 남긴다
const SIDE_STEP = 32;
const readSide = () => {
  try {
    const v = Number(localStorage.getItem(SIDE_KEY));
    return v >= SIDE_MIN ? v : null;
  } catch {
    return null;
  }
};

function useSideWidth(pane: 'info' | 'code') {
  const [chosen, setChosen] = useState<number | null>(readSide);
  const gridRef = useRef<HTMLDivElement>(null);
  const width = chosen ?? (pane === 'code' ? 560 : 380);
  const clamp = (w: number) => {
    const total = gridRef.current?.getBoundingClientRect().width ?? 0;
    const max = total > 0 ? total - CANVAS_MIN : Infinity; // 크기를 모르면(시험 환경) 상한 없이
    return Math.round(Math.max(SIDE_MIN, Math.min(max, w)));
  };
  const set = (w: number) => {
    const v = clamp(w);
    setChosen(v);
    try {
      localStorage.setItem(SIDE_KEY, String(v));
    } catch {
      /* 저장하지 못해도 이번 화면에서는 바뀐 폭을 쓴다 */
    }
  };
  return { width, set, gridRef };
}

function SideResizer({ width, set, gridRef }: ReturnType<typeof useSideWidth>) {
  const drag = useRef(false);
  const [dragging, setDragging] = useState(false);
  const end = () => {
    drag.current = false;
    setDragging(false);
    document.body.style.removeProperty('cursor');
    document.body.style.removeProperty('user-select');
  };
  useEffect(() => end, []);
  return (
    <Box
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={t('flows.resizeSide')}
      aria-valuenow={width}
      aria-valuemin={SIDE_MIN}
      data-dragging={dragging ? '' : undefined}
      onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
        if (e.button > 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        drag.current = true;
        setDragging(true);
        document.body.style.cursor = 'ew-resize';
        document.body.style.userSelect = 'none';
      }}
      onPointerMove={(e: PointerEvent<HTMLDivElement>) => {
        if (!drag.current) return;
        const r = gridRef.current?.getBoundingClientRect();
        if (r) set(r.right - e.clientX); // 그림 영역 오른쪽 끝에서 포인터까지
      }}
      onPointerUp={(e: PointerEvent<HTMLDivElement>) => {
        e.currentTarget.releasePointerCapture?.(e.pointerId);
        end();
      }}
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
        const step = e.key === 'ArrowLeft' ? SIDE_STEP : e.key === 'ArrowRight' ? -SIDE_STEP : 0;
        if (!step) return;
        e.preventDefault();
        set(width + step);
      }}
      sx={{
        display: { xs: 'none', lg: 'block' },
        position: 'relative',
        cursor: 'ew-resize',
        touchAction: 'none',
        outline: 'none',
        // 1px 선(전에 살펴보기 왼쪽 테두리). 올리거나 끌거나 키보드로 오면 2px 강조
        '&::before': {
          content: '""',
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 3,
          width: '1px',
          bgcolor: 'divider',
        },
        '&::after': {
          content: '""',
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 2,
          width: 3,
          bgcolor: 'text.primary',
          opacity: 0,
          transition: 'opacity 120ms',
        },
        '&:hover::after, &[data-dragging]::after': { opacity: 0.35 },
        '&:focus-visible::after': { opacity: 0.7 },
        '@media (prefers-reduced-motion: reduce)': { '&::after': { transition: 'none' } },
      }}
    />
  );
}

// ---- 살펴보기 ----
interface SideProps {
  graph: Graph;
  sel: string | null;
  edge: FEdge | null;
  pane: 'info' | 'code';
  file: string;
  line: number;
  onPick: (id: string) => void;
  onCode: (path: string, line: number) => void;
  onPane: (p: 'info' | 'code') => void;
  onClose: () => void;
  onCloseEdge: () => void;
  onDirty: (v: boolean) => void;
  /** 「이것을 중심으로 보기」. 서랍 안 페이지면 서랍 기록을 쌓고, 메뉴에서 연 그림이면 주소 root 를 바꾼다(스펙 2026-10-26-003 T7) */
  onCenter: (root: string) => void;
  /** 스킬 노드의 「중심으로 보기」 대신 쓸 이름(스킬 화면: 「이 스킬로 이동」) */
  moveLabel?: string;
}

function Side({
  graph,
  sel,
  edge,
  pane,
  file,
  line,
  onPick,
  onCode,
  onPane,
  onClose,
  onCloseEdge,
  onDirty,
  onCenter,
  moveLabel,
}: SideProps) {
  const { openDrawer } = useUi();
  const nodeOf = (id: string) => graph.nodes.find((n) => n.id === id);
  const n = sel ? nodeOf(sel) : undefined;
  // 연결 줄은 접힌 채 보이고 꺾쇠로 근거를 편다(디자인 D13). 고른 노드가 바뀌면 다시 접는다.
  // 중심이 아닌 노드에 연결이 둘 이하면 처음부터 편다(스펙 §3-3-4)
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => {
    const few = !!n && n.id !== graph.root && graph.edges.filter((e) => e.from === n.id || e.to === n.id).length <= 2;
    setOpen(few ? new Set(graph.edges.filter((e) => e.from === n?.id || e.to === n?.id).map(edgeKey)) : new Set());
  }, [sel]); // eslint-disable-line react-hooks/exhaustive-deps

  if (edge && pane !== 'code') {
    const a = nodeOf(edge.from) as FNode;
    const b = nodeOf(edge.to) as FNode;
    const o = graph.observed;
    return (
      <Box>
        <Stack direction="row" alignItems="flex-start" sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
          <Box sx={{ flex: 1 }}>
            <Typography variant="caption" color="text.secondary">
              {t('flows.edgeCaption')}
            </Typography>
            <Typography variant="h6" component="h2">{`${a.label} → ${b.label}`}</Typography>
          </Box>
          <Button aria-label={t('flows.close')} size="small" onClick={onCloseEdge}>
            ✕
          </Button>
        </Stack>
        <Box sx={{ p: 2 }}>
          <KV
            pairs={[
              [t('flows.kvRelation'), relLabel(edge.kind) || edge.kind],
              [
                t('flows.kvConfidence'),
                <span key="c">
                  <ConfTag c={edge.conf} />{' '}
                  <Typography component="span" variant="caption" color="text.secondary">
                    {confLabel(edge.conf)?.[1]}
                  </Typography>
                </span>,
              ],
              [
                t('flows.kvRuns'),
                edge.meta.observed
                  ? t('flows.recentRuns', { days: o?.days || 14, scope: o?.scope || '', n: edge.meta.observed })
                  : '',
              ],
              [t('flows.kvTools'), (edge.meta.tools ?? []).join(', ')],
              [t('flows.kvUrls'), (edge.meta.urls ?? []).join(' ')],
            ]}
          />
          <Section title={t('flows.evidenceTitle', { n: edge.evidence.length })}>
            <Evidence e={edge} onCode={onCode} />
          </Section>
          <Stack direction="row" spacing={1}>
            <Button onClick={() => onPick(a.id)}>{t('flows.view', { label: a.label })}</Button>
            <Button onClick={() => onPick(b.id)}>{t('flows.view', { label: b.label })}</Button>
          </Stack>
        </Box>
      </Box>
    );
  }

  if (!n)
    return (
      <Box sx={{ p: 2 }}>
        <Typography color="text.secondary">{t('flows.sideEmpty')}</Typography>
        <Legend />
      </Box>
    );

  const outs = graph.edges.filter((e) => e.from === n.id);
  const ins = graph.edges.filter((e) => e.to === n.id);
  const center = n.id === graph.root;
  // 중심 노드: 연결을 종류별 소제목으로 기본 정보보다 먼저 보인다(디자인 D12). 외부 호스트는 스크립트를 거친 것까지,
  // 수는 서버가 스킬 목록과 같은 규칙으로 센 값(D5·재검토 D3)
  const centerGroups = () => {
    const reached = hostsFromRoot(graph);
    const mentioned = outs.filter(
      (e) => e.to.startsWith('host:') && e.conf === 'mention' && !reached.some((r) => r.host === e.to)
    );
    const hostN = graph.root_hosts ?? reached.length;
    const groups = GROUP_ORDER.map((k) => [k, outs.filter((e) => nodeOf(e.to)?.kind === k)] as const).filter(
      ([, es]) => es.length
    );
    return (
      <>
        {(reached.length > 0 || mentioned.length > 0 || hostN > 0) && (
          <Section title={kindLabel('host')} count={hostN}>
            {reached.length < hostN && (
              <Typography variant="caption" color="text.secondary" component="p">
                {t('flows.hostsDrawnOnly', { m: reached.length })}
              </Typography>
            )}
            <Box component="ul" sx={{ m: 0, pl: 0, listStyle: 'none' }}>
              {reached.map(({ edge: e }) => edgeRow(e, e.to, '→', e.from !== n.id ? nodeOf(e.from)?.label : undefined))}
              {mentioned.map((e) => edgeRow(e, e.to, '→'))}
            </Box>
          </Section>
        )}
        {groups.map(([k, es]) => (
          <Section key={k} title={kindLabel(k)} count={es.length}>
            <Box component="ul" sx={{ m: 0, pl: 0, listStyle: 'none' }}>
              {es.map((e) => edgeRow(e, e.to, '→'))}
            </Box>
          </Section>
        ))}
      </>
    );
  };
  const talk = n.kind === 'skill' ? n.profile || 'default' : n.profile || 'default';
  const edgeRow = (e: FEdge, other: string, arrow: string, via?: string) => {
    const m = nodeOf(other);
    const key = edgeKey(e);
    const isOpen = open.has(key);
    const toggle = (v: boolean) =>
      setOpen((cur) => {
        const next = new Set(cur);
        if (v) next.add(key);
        else next.delete(key);
        return next;
      });
    const panelId = 'flow-edge-' + key.replace(/[^\w-]/g, '_');
    return (
      <li key={key}>
        <Stack direction="row" spacing={0.5} alignItems="center" useFlexGap flexWrap="wrap">
          <IconButton
            size="small"
            aria-expanded={isOpen}
            aria-controls={panelId}
            aria-label={t(isOpen ? 'flows.collapseEdge' : 'flows.expandEdge', { label: m?.label ?? other })}
            onClick={() => toggle(!isOpen)}
            onKeyDown={(ev) => {
              if (ev.key === 'ArrowRight' && !isOpen) toggle(true);
              else if (ev.key === 'ArrowLeft' && isOpen) toggle(false);
            }}
            sx={{
              p: 0,
              '@media (pointer: coarse)': { minWidth: 44, minHeight: 44 },
              '& svg': { fontSize: 16, transition: 'transform 160ms', transform: isOpen ? 'rotate(90deg)' : 'none' },
              '@media (prefers-reduced-motion: reduce)': { '& svg': { transition: 'none' } },
            }}
          >
            <ChevronRightIcon />
          </IconButton>
          <Typography variant="caption" color="text.secondary">
            {arrow}
          </Typography>
          {m ? (
            <Chip
              size="small"
              clickable
              variant="outlined"
              icon={<KindMark kind={m.kind} />}
              label={m.label}
              onClick={() => onPick(m.id)}
            />
          ) : (
            other
          )}
          <Typography variant="caption" color="text.secondary">
            {relLabel(e.kind) || e.kind}
          </Typography>
          <ConfTag c={e.conf} />
          {e.conf === 'observed' ? null : <ObsTag e={e} />}
          {via && (
            <Typography variant="caption" color="text.secondary">
              {t('flows.viaScript', { name: via })}
            </Typography>
          )}
        </Stack>
        <Box id={panelId} hidden={!isOpen} sx={{ pl: 3 }}>
          {isOpen && e.meta.tools && (
            <Typography variant="caption" color="text.secondary" component="div" sx={{ fontFamily: MONO_FONT }}>
              {t('flows.toolsLine', { names: e.meta.tools.join(', ') })}
            </Typography>
          )}
          {isOpen && e.meta.urls && (
            <Typography
              variant="caption"
              color="text.secondary"
              component="div"
              sx={{ fontFamily: MONO_FONT, wordBreak: 'break-all' }}
            >
              {e.meta.urls.slice(0, 3).join(' ')}
            </Typography>
          )}
          {isOpen && <Evidence e={e} onCode={onCode} />}
        </Box>
      </li>
    );
  };

  return (
    <Box>
      {/* 머리: 종류 줄 + 제목과 뱃지를 한 줄에(2026-10-17-017 컴팩트). 예전에는 제목(h6)·뱃지가 각각 줄을 차지했다 */}
      <Stack
        direction="row"
        alignItems="flex-start"
        spacing={1}
        sx={{ px: 2, py: 1.25, borderBottom: 1, borderColor: 'divider' }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography
            variant="caption"
            color="text.secondary"
            component="div"
            sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}
          >
            <KindMark kind={n.kind} />
            {kindLabel(n.kind) + (n.id === graph.root ? ' · ' + t('flows.centerMark') : '')}
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: 1, rowGap: 0.5 }}>
            <Typography
              component="h2"
              sx={{ fontSize: 16, fontWeight: 600, lineHeight: 1.4, overflowWrap: 'anywhere' }}
            >
              {n.label}
            </Typography>
            {n.badges.map((b) => (
              <Tag key={b} tone={badgeTone(b)}>
                {serverTerm(b)}
              </Tag>
            ))}
          </Box>
        </Box>
        <Button aria-label={t('flows.close')} size="small" onClick={onClose}>
          ✕
        </Button>
      </Stack>
      {(n.path || pane === 'code') && (
        <Tabs
          value={pane}
          onChange={(_, v: 'info' | 'code') =>
            v === 'code' ? onCode(file && pane === 'code' ? file : (n.path as string), 0) : onPane('info')
          }
          sx={{ px: 2 }}
        >
          <Tab value="info" label={t('flows.tabInfo')} />
          <Tab value="code" label={t('flows.tabCode')} />
        </Tabs>
      )}
      <Box sx={{ px: 2, py: 1.5 }}>
        {pane === 'code' && file ? (
          <CodePane graph={graph} path={file} line={line} onFile={(p) => onCode(p, 0)} onDirty={onDirty} />
        ) : (
          <>
            {center && centerGroups()}
            <KV
              pairs={
                Object.entries(n.meta)
                  .filter(([, v]) => v)
                  .map(([k, v]) => [serverTerm(k), v]) as [string, ReactNode][]
              }
            />
            <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ my: 1 }}>
              {n.id !== graph.root && ['skill', 'cron', 'script'].includes(n.kind) && (
                <Button variant="contained" size="small" onClick={() => onCenter(n.id)}>
                  {n.kind === 'skill' && moveLabel ? moveLabel : t('flows.viewAsCenter')}
                </Button>
              )}
              {n.kind === 'cron' && (
                <Button
                  startIcon={<ScheduleOutlinedIcon />}
                  variant="contained"
                  size="small"
                  onClick={() => {
                    const k = n.id.slice(5);
                    const i = k.indexOf('/');
                    openDrawer(jobDrawerSpec(k.slice(0, i), k.slice(i + 1), n.label));
                  }}
                >
                  {t('flows.cronActions')}
                </Button>
              )}
              {n.path && (
                <Button size="small" variant="outlined" onClick={() => onCode(n.path as string, 0)}>
                  {t('flows.viewCode')}
                </Button>
              )}
              {n.link && (
                <LinkChip to={n.link.view} params={n.link.params} page={pageFromLink(n.link.view, n.link.params)}>
                  {['skills', 'tools', 'credentials', 'cron'].includes(n.link.view)
                    ? t(`flows.openIn.${n.link.view}`)
                    : t('flows.openIn.other')}
                </LinkChip>
              )}
              {(n.kind === 'skill' || n.kind === 'script') && (
                <ChatChip
                  agent={talk}
                  text={
                    n.kind === 'skill'
                      ? // i18n-ignore: 서버가 보내는 메타 항목 이름(경로)으로 값을 찾는다
                        t('flows.explainSkillPrompt', { label: n.label, path: n.meta['경로'] })
                      : t('flows.explainScriptPrompt', { path: n.path })
                  }
                >
                  {t('flows.explainByChat')}
                </ChatChip>
              )}
            </Stack>
            {!center && outs.length > 0 && (
              <Section title={t('flows.outgoing', { n: outs.length })}>
                <Box component="ul" sx={{ m: 0, pl: 0, listStyle: 'none' }}>
                  {outs.map((e) => edgeRow(e, e.to, '→'))}
                </Box>
              </Section>
            )}
            {ins.length > 0 && (
              <Section title={t('flows.incoming', { n: ins.length })}>
                <Box component="ul" sx={{ m: 0, pl: 0, listStyle: 'none' }}>
                  {ins.map((e) => edgeRow(e, e.from, '←'))}
                </Box>
              </Section>
            )}
            {!outs.length && !ins.length && <Typography color="text.secondary">{t('flows.noLinks')}</Typography>}
            {n.more ? (
              <Typography variant="caption" color="text.secondary" component="p">
                {t('flows.moreNote', { n: n.more })}
              </Typography>
            ) : null}
          </>
        )}
      </Box>
    </Box>
  );
}

// ---- 화면 ----
export function GraphView({
  root,
  inDrawer = false,
  onGuard,
  onCenter,
  moveLabel,
}: {
  root: string;
  /** 목록 위 서랍 안에 그린다: 처음으로 돌아가기 단추를 빼고, 그림 높이를 서랍 머리만큼 줄이고, 닫기 전 확인을 서랍에 건다 */
  inDrawer?: boolean;
  onGuard?: (fn: (() => Promise<boolean>) | null) => void;
  /** 서랍 안 페이지로 그린다(스펙 2026-10-26-003 §5-8): 주소를 읽거나 쓰지 않고, 보기 방식은 이 그림 안에 두고, 중심 보기는 이 함수로 */
  onCenter?: (root: string) => void;
  /** 스킬 노드를 중심으로 옮기는 단추 이름. 주면 노드를 두 번 누르거나 Enter 로도 옮긴다 */
  moveLabel?: string;
}) {
  const [, setParams] = useSearchParams();
  // 뒤로 가기로 저장 확인을 묻는 동안은 묻기 전 주소 값을 읽는다 — 바뀐 주소(mentions 없음)로 그림을 다시 받으면 고치던 코드 창이 사라진다
  const params = useRouteDrawerParams('root');
  const navigate = useNavigate();
  const patchParams = useParamPatch();
  const confirm = useConfirm();
  const local = !!onCenter;
  const [own, setOwn] = useState<{ view?: string; mentions?: string }>({});
  const read = (k: 'view' | 'mentions') => (local ? own[k] : params.get(k));
  const mentions = read('mentions') === '1';
  const view = read('view') === 'tree' ? 'tree' : 'canvas';
  const q = useQuery<Graph>({
    queryKey: ['flow', root, mentions],
    queryFn: () => get<Graph>(`/api/flow?root=${encodeURIComponent(root)}` + (mentions ? '&mentions=1' : '')),
  });
  const graph = q.data;
  // 라이브러리는 처음에 숨긴다(스펙 2026-10-28-013 Q5). 설치 문제를 찾을 때만 칩으로 켠다
  const [hide, setHide] = useState<Set<string>>(() => new Set(DEFAULT_HIDE));
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [edge, setEdge] = useState<FEdge | null>(null);
  const [pane, setPane] = useState<'info' | 'code'>('info');
  const [file, setFile] = useState('');
  const [line, setLine] = useState(0);
  const side = useSideWidth(pane);
  // 그림 높이는 위쪽 끝에서 화면 아래까지를 잰다. 공지 띠·연결 상태 띠가 생겨도 넘치지 않게(스펙 공지 바 R8). 재기 전에는 옛 고정 값
  const fill = useFillHeight<HTMLDivElement>();
  const { gridRef } = side;
  const fillRef = fill.ref;
  const gridEl = useCallback(
    (el: HTMLDivElement | null) => {
      gridRef.current = el;
      fillRef(el);
    },
    [gridRef, fillRef]
  );
  const dirty = useRef(false);

  useEffect(() => {
    setHide(new Set(DEFAULT_HIDE));
    setSel(null);
    setEdge(null);
    setPane('info');
  }, [root]);
  useEffect(() => {
    if (graph && (!sel || !graph.nodes.some((n) => n.id === sel))) setSel(graph.root);
  }, [graph]); // eslint-disable-line react-hooks/exhaustive-deps

  const setParam = (k: 'view' | 'mentions', v: string | null) =>
    local
      ? setOwn((o) => ({ ...o, [k]: v ?? undefined }))
      : setParams(
          (prev) => {
            const next = new URLSearchParams(prev);
            if (v) next.set(k, v);
            else next.delete(k);
            return next;
          },
          { replace: true }
        );
  const keep = async () => !dirty.current || (await confirm(t('flows.discardAsk')));
  const keepRef = useRef(keep);
  keepRef.current = keep;
  useEffect(() => {
    if (!onGuard) return;
    onGuard(() => keepRef.current());
    return () => onGuard(null);
  }, [onGuard]);

  if (!graph)
    return q.error ? (
      <Box>
        <Alert
          role="alert"
          severity="error"
          action={
            // 서랍 안 페이지는 시작점 목록이 없다(주소를 건드리면 뒤의 메뉴 서랍이 바뀐다)
            !local && (
              <Button size="small" onClick={() => patchParams({ root: null, view: null, mentions: null })}>
                {t('flows.backToStarts')}
              </Button>
            )
          }
        >
          {q.error.message}
        </Alert>
      </Box>
    ) : (
      <ScreenLoading title={t('flows.title')} />
    );

  const nodeById = (id: string) => graph.nodes.find((n) => n.id === id);
  const r = nodeById(graph.root) as FNode;
  const kinds = [...new Set(graph.nodes.map((n) => n.kind))];
  const pick = async (id: string) => {
    if (!(await keep())) return;
    dirty.current = false;
    setSel(id);
    setEdge(null);
    setPane('info');
  };
  const showCode = async (path: string, ln: number) => {
    if (!(await keep())) return;
    dirty.current = false;
    setPane('code');
    setFile(path);
    setLine(ln);
  };
  const o = graph.observed;

  return (
    <Box>
      <Stack direction="row" spacing={1.5} alignItems="center" useFlexGap flexWrap="wrap" sx={{ mb: 1 }}>
        {!inDrawer && (
          <Button size="small" onClick={() => navigate('/flows')}>
            {t('flows.backToStart')}
          </Button>
        )}
        <Box sx={{ flex: 1, minWidth: 120 }}>
          <strong>{r.label}</strong>{' '}
          <Typography component="span" variant="caption" color="text.secondary">
            {t('flows.summary', { kind: kindLabel(r.kind), nodes: graph.nodes.length, edges: graph.edges.length }) +
              (graph.truncated ? ' · ' + t('flows.truncated') : '')}
          </Typography>
        </Box>
        <Tabs
          value={view}
          onChange={(_, v: string) => setParam('view', v === 'tree' ? 'tree' : null)}
          aria-label={t('flows.viewMode')}
        >
          <Tab value="canvas" label={t('flows.viewCanvas')} />
          <Tab value="tree" label={t('flows.viewTree')} />
        </Tabs>
        <TextField
          size="small"
          type="search"
          placeholder={t('flows.findPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          slotProps={{ htmlInput: { 'aria-label': t('flows.findLabel'), 'data-view-search': '' } }}
        />
        <FormControlLabel
          control={
            <Checkbox
              size="small"
              checked={mentions}
              onChange={(e) => setParam('mentions', e.target.checked ? '1' : null)}
            />
          }
          label={t('flows.includeMentions') + (graph.hidden_mentions ? ` (${graph.hidden_mentions})` : '')}
        />
      </Stack>
      {/* 종류 칩과 실행 기록을 한 줄에(2026-10-17-017 컴팩트). 좁으면 실행 기록이 다음 줄로 넘어간다 */}
      <Stack direction="row" alignItems="center" useFlexGap flexWrap="wrap" columnGap={1.5} rowGap={0.5} sx={{ mb: 1 }}>
        <Stack
          direction="row"
          spacing={0.5}
          role="group"
          aria-label={t('flows.filterByKind')}
          useFlexGap
          flexWrap="wrap"
        >
          {kinds.map((k) => {
            const count = graph.nodes.filter((n) => n.kind === k).length;
            // 라이브러리는 설치 목록에 없다는 경고 수를 붙인다(디자인 D10). Node 패키지는 경고가 없다(D5)
            const warn = k === 'lib' ? graph.nodes.filter((n) => n.kind === k && n.status === 'warn').length : 0;
            const chip = (
              <Chip
                key={k}
                clickable
                size="small"
                component="button"
                aria-pressed={!hide.has(k)}
                aria-label={
                  `${kindLabel(k)} ${count}` +
                  (warn ? t('flows.chipWarnAria', { n: warn }) : '') +
                  (hide.has(k) ? t('flows.chipHiddenAria') : '')
                }
                variant={hide.has(k) ? 'outlined' : 'filled'}
                onClick={() =>
                  setHide((cur) => {
                    const next = new Set(cur);
                    if (next.has(k)) next.delete(k);
                    else next.add(k);
                    return next;
                  })
                }
                label={
                  <>
                    <KindMark kind={k} />
                    {` ${kindLabel(k)} ${count}`}
                    {warn > 0 && (
                      <Box component="span" sx={{ color: WARN_TEXT }}>
                        {' · ' + t('flows.warnN', { n: warn })}
                      </Box>
                    )}
                  </>
                }
              />
            );
            // 종류 칩의 외부 호스트 수는 그림 전체 수다. 서랍의 수는 중심 패널 「외부 호스트」와 같다(디자인 D5)
            return k === 'host' ? (
              <Tooltip key={k} title={t('flows.hostChipHelp')}>
                {chip}
              </Tooltip>
            ) : (
              chip
            );
          })}
        </Stack>
        {o && (
          // 세 상태를 같은 자리에 짧게, 설명은 도움말 단추의 풍선말로(디자인 D9)
          <Stack direction="row" alignItems="center" spacing={0.25}>
            <Typography variant="caption" color="text.secondary" component="div">
              {o.error
                ? t('flows.runsUnreadable')
                : o.hint || t('flows.runsShort', { runs: o.runs, matched: o.matched })}
            </Typography>
            <Tooltip title={t('flows.runsHelp', { days: o.days, scope: o.scope })} describeChild>
              <IconButton size="small" aria-label={t('flows.runsHelpLabel')} sx={{ p: 0.25 }}>
                <HelpOutlineIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
          </Stack>
        )}
      </Stack>
      <Box
        ref={gridEl}
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', lg: `minmax(0, 1fr) 8px ${side.width}px` },
          border: 1,
          borderColor: 'divider',
          borderRadius: 1,
          // 서랍 안에서는 상단 막대·서랍 머리·여백만큼 더 뺀다
          // 머리 줄을 줄인 만큼(실행 기록 줄 하나와 탭 12px) 그림을 키운다(2026-10-17-017)
          height: fill.height ?? (inDrawer ? 'calc(100vh - 254px)' : 'calc(100vh - 224px)'),
          minHeight: 420,
        }}
      >
        <Box sx={{ minHeight: 0, overflow: 'hidden' }}>
          {view === 'tree' ? (
            <Tree graph={graph} hide={hide} sel={sel} onPick={pick} />
          ) : (
            <FlowCanvas
              graph={graph}
              hide={hide}
              query={query}
              selected={sel}
              onSelect={(n) => {
                setSel(n ? n.id : null);
                setEdge(null);
                setPane('info');
              }}
              onEdge={(e) => {
                setEdge(e);
                setPane('info');
              }}
              onOpen={
                onCenter && moveLabel
                  ? (n) => {
                      if (n.id !== graph.root && ['skill', 'cron', 'script'].includes(n.kind)) onCenter(n.id);
                    }
                  : undefined
              }
            />
          )}
        </Box>
        <SideResizer {...side} />
        <Paper
          component="aside"
          aria-label={t('flows.inspector')}
          square
          variant="outlined"
          sx={{ overflow: 'auto', minHeight: 0, borderWidth: 0 }}
        >
          <Side
            graph={graph}
            sel={sel}
            edge={edge}
            pane={pane}
            file={file}
            line={line}
            onPick={pick}
            onCode={showCode}
            onPane={setPane}
            onClose={() => {
              setSel(null);
              setPane('info');
            }}
            onCloseEdge={() => setEdge(null)}
            onCenter={onCenter ?? ((id) => patchParams({ root: id }))}
            moveLabel={moveLabel}
            onDirty={(v) => {
              dirty.current = v;
            }}
          />
        </Paper>
      </Box>
    </Box>
  );
}
