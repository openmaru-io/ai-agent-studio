/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 대화 파일 화면 부품(OMAI-1153, 스펙 2026-10-14-005 §3-9 → 2026-10-20-002). 파일은 이름 뱃지(FileBadge)로 보이고 누르면 파일 뷰어를 연다.
// 색·모양은 DESIGN.md 토큰: 진행 막대는 단색, 실패만 alert 빨강, 안내·용량 경고는 amber. 이유 문구는 서버 코드를 번역한다(chatFiles.reasonText).
import AttachFileIcon from '@mui/icons-material/AttachFile';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CloseIcon from '@mui/icons-material/Close';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined';
import GroupsOutlinedIcon from '@mui/icons-material/GroupsOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import UploadFileOutlinedIcon from '@mui/icons-material/UploadFileOutlined';
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined';
import { Alert, Box, Button, ButtonBase, IconButton, Skeleton, Stack, Tooltip, Typography, useTheme } from '@mui/material';
import { useSnackbar } from 'notistack';
import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { useChatTokens } from '@/components/chat/useChatTokens';
import { useConfirm } from '@/components/ConfirmDialog';
import { FileBadge, FileIcon } from '@/components/files/FileBadge';
import { FileSearch, GroupHead } from '@/components/files/FileGroups';
import { fmtWhen } from '@/components/files/viewerParts';
import { openViewer, useViewer, type ViewerActions, type ViewerFile } from '@/components/files/viewerStore';
import { Markdown } from '@/components/Markdown';
import type { MarkdownFiles } from '@/components/markdown/Markdown';
import { useUi } from '@/components/UiContext';
import { t } from '@/i18n';
import { Item } from '@/lib/chat';
import { CHIP_FIRST, deleteFile, FileRef, fileUrl, humanSize, listFiles, Listing, ListingEntry, reasonText, Upload } from '@/lib/chatFiles';
import { ChatStore } from '@/lib/chatStore';
import { chatMetrics } from '@/lib/chatTokens';
import { fileSource, sharedRoom } from '@/lib/fileKinds';
import { splitPaths, takeLegacyPathLines } from '@/lib/filePaths';
import { buildTree, collapse, findFolder, TreeFolder, TreeNode, visibleAncestor, visibleRows, withAncestors } from '@/lib/fileTree';
import { FOCUS_RING } from '@/lib/shellTokens';

const AMBER = '#f59e0b';
const AMBER_LIGHT = '#ca8a04';
const ALERT = '#ef5350';
const ALERT_LIGHT = '#dc2626';

/** 개인 작업 폴더 파일 → 뷰어가 여는 파일(받기 주소는 지금 에이전트의 /api/chat/files) */
export function personalFile(store: ChatStore, f: { name: string; path: string; size?: number; mtime?: number; downloadable?: boolean; reason?: string }): ViewerFile {
  const src = fileSource(f.path);
  const room = sharedRoom(f.path);
  return {
    name: f.name,
    path: f.path,
    url: fileUrl(store.pod, f.path),
    source: src,
    size: f.size,
    mtime: f.mtime,
    place: room ? t('chat.files.roomLabel', { room }) : undefined,
    blocked: store.isDeleted(f.path, f.size) ? 'deleted' : f.downloadable === false ? f.reason || 'not_file' : undefined,
  };
}

/** 「AI 에게 묻기」(DD10): 첨부 뱃지로 붙이고 서랍(과 뷰어)을 닫고 입력 칸으로. 칸이 비었을 때만 묻는 글을 채운다 */
export function useAskAbout(store: ChatStore) {
  const { closeDrawer } = useUi();
  const { enqueueSnackbar } = useSnackbar();
  return (f: { name: string; path: string; size?: number }) => {
    const r = store.attachExisting(f);
    if (r === 'dup') enqueueSnackbar(t('chat.files.alreadyAttached'), { variant: 'info' });
    if (r === 'too_many') enqueueSnackbar(t('chat.files.maxAttached'), { variant: 'warning' });
    void closeDrawer();
    store.offerCompose(t('chat.files.askDraft'));
  };
}

// ---- 글 안 상대 경로를 맞춰 볼 서랍 목록(R14): 에이전트마다 한 번 읽어 두고, 답의 「바뀐 파일」로 보탠다 ----
const known = new Map<string, Set<string>>();
const loading = new Set<string>();
const knownSubs = new Set<() => void>();
let knownVer = 0;
const knownEmit = () => {
  knownVer++;
  knownSubs.forEach((f) => f());
};
export function addKnownPaths(pod: string, paths: string[]) {
  if (!pod || !paths.length) return;
  const set = known.get(pod) ?? new Set<string>();
  const before = set.size;
  paths.forEach((p) => set.add(p));
  known.set(pod, set);
  if (set.size !== before) knownEmit();
}
/** 지금 에이전트의 서랍 목록 경로 집합. 처음 부를 때 한 번 읽는다. 못 읽으면 빈 집합(상대 경로는 글로 남는다) */
export function useKnownPaths(pod: string): ReadonlySet<string> | undefined {
  useSyncExternalStore(
    (f) => {
      knownSubs.add(f);
      return () => void knownSubs.delete(f);
    },
    () => knownVer
  );
  useEffect(() => {
    if (!pod || known.has(pod) || loading.has(pod)) return;
    loading.add(pod);
    listFiles(pod)
      .then((l) => addKnownPaths(pod, l.entries.filter((e) => e.kind === 'file').map((e) => e.path)))
      .catch(() => undefined)
      .finally(() => loading.delete(pod));
  }, [pod]);
  return known.get(pod);
}

/** 개인 파일 뱃지(알약). 누르면 뷰어 — 받을 수 없음·지움도 열려 이유를 보인다(DD4) */
export function FileChip({ file, store, maxName, ellipsis }: { file: FileRef; store: ChatStore; maxName?: number | string; ellipsis?: number }) {
  const ask = useAskAbout(store);
  const vf = personalFile(store, file);
  const actions: ViewerActions = { onAsk: () => ask(file) };
  return (
    <FileBadge
      file={vf}
      actions={actions}
      sizeLabel={file.size != null ? humanSize(file.size) : file.sizeLabel}
      modified={file.status === 'modified'}
      deleted={vf.blocked === 'deleted'}
      maxName={maxName}
      ellipsis={ellipsis}
    />
  );
}

/** 글 안 경로 뱃지(DD1). 크기를 모르므로 뷰어 머리는 「크기 확인 중」으로 시작한다(DD9) */
export function InlineFile({ path, store }: { path: string; store: ChatStore }) {
  const ask = useAskAbout(store);
  const name = path.split('/').pop() || path;
  const vf = personalFile(store, { name, path });
  return <FileBadge variant="inline" file={vf} actions={{ onAsk: () => ask({ name, path }) }} deleted={vf.blocked === 'deleted'} />;
}

/** 보낸 말풍선 안 본문 위의 파일 뱃지 줄(D4·DD2). */
export function SentFiles({ files, store }: { files: FileRef[]; store: ChatStore }) {
  return (
    <Stack direction="row" flexWrap="wrap" useFlexGap spacing={0.5} sx={{ mb: 0.5 }}>
      {files.map((f) => (
        <FileChip key={f.path} file={f} store={store} />
      ))}
    </Stack>
  );
}

/** 사용자 말풍선 본문(DD2): 옛 「AI」 단추 글의 「경로:」 줄은 떼어 본문 위 뱃지 줄로, 글 안 절대 경로는 글 안 뱃지로(F7) */
export function UserMessageBody({ text, files, store }: { text: string; files?: FileRef[]; store: ChatStore }) {
  const legacy = useMemo(() => takeLegacyPathLines(text), [text]);
  const all = useMemo(() => {
    const list = [...(files ?? [])];
    for (const path of legacy.paths) if (!list.some((f) => f.path === path)) list.push({ name: path.split('/').pop() || path, path });
    return list;
  }, [files, legacy]);
  return (
    <>
      {all.length > 0 && <SentFiles files={all} store={store} />}
      {splitPaths(legacy.text).map((part, i) => (typeof part === 'string' ? part : <InlineFile key={i} path={part.path} store={store} />))}
    </>
  );
}

/** 에이전트 답(Markdown): 글 안 절대 경로와, 서랍 목록에 있는 상대 경로를 글 안 뱃지로(§3-4, R14) */
export function AnswerMarkdown({ text, store }: { text: string; store: ChatStore }) {
  const knownPaths = useKnownPaths(store.pod);
  const files = useMemo<MarkdownFiles>(() => ({ render: (path) => <InlineFile path={path} store={store} />, known: knownPaths }), [store, knownPaths]);
  return <Markdown text={text} files={files} />;
}

/** 답 아래 「이번 답에서 바뀐 파일」 묶음(D5). 서버가 정렬·거름·자르기를 마쳤다. */
export function FilesBlock({ item, store }: { item: Item; store: ChatStore }) {
  const [all, setAll] = useState(false);
  const files = item.files ?? [];
  useEffect(() => addKnownPaths(store.pod, files.map((f) => f.path)), [files]); // eslint-disable-line react-hooks/exhaustive-deps
  if (item.truncated)
    return (
      <Typography variant="caption" color="text.secondary" component="div" sx={{ ml: 5, my: 1 }}>
        {t('chat.files.tooMany')}
      </Typography>
    );
  if (!files.length) return null;
  const shown = all ? files : files.slice(0, CHIP_FIRST);
  const more = files.length - shown.length;
  const beyond = (item.total ?? files.length) - files.length;
  return (
    <Box sx={{ ml: 5, mt: 1 }} role="group" aria-label={t('chat.files.changedTitle')}>
      <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 0.5 }}>
        {t('chat.files.changedTitle')}
      </Typography>
      <Stack direction="row" flexWrap="wrap" useFlexGap spacing={0.5}>
        {shown.map((f) => (
          <FileChip key={f.path} file={f} store={store} />
        ))}
        {more > 0 && (
          <Button size="small" onClick={() => setAll(true)}>
            {t('chat.files.more', { count: more })}
          </Button>
        )}
      </Stack>
      {beyond > 0 && (
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>
          {t('chat.files.beyond', { count: beyond })}
        </Typography>
      )}
    </Box>
  );
}

/** 작업 폴더 안내(D12) — 장애가 아니라 그 대화의 사실이라 빨간 알림 대신 amber 구분선. */
export function NoticeLine({ code, name, reason, text }: { code?: string; name?: string; reason?: string; text?: string }) {
  const tk = useChatTokens();
  // code 'command': 명령을 실행하지 않은 이유(이름 겹침·목록 실패·못 씀, 스펙 2026-10-26-010 11-4). 스킬 실패 줄과 같은 호박색 모양
  if (code === 'skill_failed' || code === 'command')
    // 스킬을 붙이지 못하고 글만 갔다(스펙 2026-10-19-012 DD5). 글은 이미 갔으니 빨간 오류 줄이 아니라 호박색 안내다 — 다시 보내 두 번 일하지 않게
    return (
      <Box
        role="note"
        sx={{
          my: 1,
          mx: 'auto',
          px: 1.5,
          py: 0.75,
          width: 'fit-content',
          maxWidth: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          fontSize: 12,
          color: tk.text,
          bgcolor: tk.warnWash,
          border: `1px solid ${tk.warnLine}`,
          borderRadius: '8px',
        }}
      >
        <WarningAmberOutlinedIcon sx={{ fontSize: 14, color: AMBER }} aria-hidden />
        {code === 'command' ? text : t('chat.skill.failed', { name: name ?? '', reason: t(`chat.skill.reason.${reason || 'error'}`) })}
      </Box>
    );
  return (
    <Typography
      variant="caption"
      component="div"
      align="center"
      role="note"
      sx={{ my: 1, color: AMBER, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0.5 }}
    >
      <WarningAmberOutlinedIcon sx={{ fontSize: 14 }} aria-hidden />
      {t(`chat.files.notice.${code || 'cwd_unchanged'}`)}
    </Typography>
  );
}

/** 입력창 위 보낼 첨부 하나. 올린 파일·고른 파일은 눌러서 뷰어로 열 수 있다. 실패는 빨간 테두리 + 이유(DD5), 고른 파일은 다시 시도 없이 ✕ 만 */
function UploadChip({ u, store }: { u: Upload; store: ChatStore }) {
  const fail = u.state === 'fail';
  const status =
    u.state === 'wait' ? t('chat.files.waiting') : u.state === 'up' ? `${u.pct}%` : fail ? reasonText(u.code) : u.size ? humanSize(u.size) : '';
  const tip = fail ? reasonText(u.code) : u.renamed ? t('chat.files.renamed') : t('chat.files.removeTip');
  const retry = fail && !u.picked && u.size > 0 && u.code !== 'too_large' && u.code !== 'too_many';
  const vf = personalFile(store, { name: u.name, path: u.path || '', size: u.size || undefined });
  return (
    <Tooltip title={tip}>
      <Box component="span" sx={{ display: 'inline-flex', flexShrink: 0, maxWidth: { xs: 'calc(50% - 24px)', sm: 260 } }}>
        <FileBadge
          file={vf}
          sizeLabel={status}
          error={fail}
          progress={u.state === 'up' ? u.pct : undefined}
          progressLabel={t('chat.files.progressAria', { name: u.name })}
          disabled={!u.path || u.state !== 'done'}
          maxName={200}
          ellipsis={20}
          trailing={
            <>
              {retry && (
                <Button size="small" sx={{ minWidth: 0, px: 0.5, fontSize: 12 }} onClick={() => store.retryUpload(u.key)}>
                  {t('chat.files.retry')}
                </Button>
              )}
              <IconButton
                size="small"
                aria-label={t('chat.files.removeAria', { name: u.name })}
                onClick={() => store.removeUpload(u.key)}
                sx={{
                  width: 24,
                  height: 24,
                  mr: '2px',
                  position: 'relative',
                  // 터치 화면은 보이는 크기는 두고 누르는 영역만 44px 로(DD18)
                  '@media (pointer: coarse)': { '&::after': { content: '""', position: 'absolute', inset: -10 } },
                }}
              >
                <CloseIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </>
          }
        />
      </Box>
    </Tooltip>
  );
}

/** 입력 칸 위의 보낼 첨부 줄(D6·D20): 한 줄에 들어가는 만큼, 실패·올리는 중을 앞에, 나머지는 「+N」. */
export function UploadRow({ store }: { store: ChatStore }) {
  const [all, setAll] = useState(false);
  if (!store.uploads.length) return null;
  const rank = (u: Upload) => (u.state === 'fail' ? 0 : u.state === 'up' ? 1 : u.state === 'wait' ? 2 : 3);
  const list = [...store.uploads].sort((a, b) => rank(a) - rank(b));
  const FIRST = 2;
  const shown = all ? list : list.slice(0, FIRST);
  const more = list.length - shown.length;
  return (
    <Stack
      direction="row"
      spacing={0.5}
      useFlexGap
      flexWrap={all ? 'wrap' : 'nowrap'}
      alignItems="center"
      sx={{ mb: 0.5, overflow: 'hidden' }}
      aria-label={t('chat.files.attachedAria', { count: list.length })}
    >
      {shown.map((u) => (
        <UploadChip key={u.key} u={u} store={store} />
      ))}
      {more > 0 && (
        <Button size="small" onClick={() => setAll(true)} aria-label={t('chat.files.moreAttachedAria', { count: more })}>
          +{more}
        </Button>
      )}
    </Stack>
  );
}

// ---- 「파일」 서랍(§3-7) ----

type GroupKey = 'uploads' | 'shared' | 'agent';
const GROUP_ORDER: GroupKey[] = ['uploads', 'shared', 'agent'];
/** 묶음 머리 아이콘(§6-4): 올린 파일 · 회의 공유 파일 · 에이전트가 만든 파일 */
const GROUP_ICON: Record<GroupKey, ReactNode> = {
  uploads: <UploadFileOutlinedIcon />,
  shared: <GroupsOutlinedIcon />,
  agent: <SmartToyOutlinedIcon />,
};
const isFolderRoot = (p: string) => p === 'workspace/uploads' || p === 'workspace/uploads/aas-shared' || p === 'workspace/uploads/aas-shared-out';

function groupOf(e: ListingEntry): GroupKey {
  if (e.shared || e.path.startsWith('workspace/uploads/aas-shared')) return 'shared';
  if (e.path.startsWith('workspace/uploads/')) return 'uploads';
  return 'agent';
}

/** 묶음 점·막대 조각의 밝기(DD3 시안 값). 색조 없이 밝기 단계로만 */
const shade = (dark: boolean, g: GroupKey | 'other') =>
  dark
    ? { uploads: 'rgba(255,255,255,0.85)', shared: 'rgba(255,255,255,0.50)', agent: 'rgba(255,255,255,0.28)', other: 'rgba(255,255,255,0.12)' }[g]
    : { uploads: 'rgba(17,24,39,0.78)', shared: 'rgba(17,24,39,0.46)', agent: 'rgba(17,24,39,0.26)', other: 'rgba(17,24,39,0.12)' }[g];

const Dot = ({ color }: { color: string }) => <Box component="span" aria-hidden sx={{ width: 8, height: 8, borderRadius: '2px', bgcolor: color, flexShrink: 0 }} />;

/** 「계획 파일 열기」가 펼칠 폴더(스펙 2026-10-27-012 §4-9). 서버 PLANS(aas/hermes/workspace.py)와 같은 경로 — 바꾸면 두 곳을 함께 고친다 */
export const PLANS_DIR = 'workspace/.hermes/plans';

/** 펼친 폴더 기억(§4-4): 에이전트(pod)마다 sessionStorage. 쓸 수 없거나 pod 가 없으면 이 서랍을 여는 동안만 기억한다 */
const openKey = (pod: string) => `aas.files.open.${pod}`;
function readOpen(pod: string | undefined): Set<string> {
  if (!pod) return new Set();
  try {
    const v: unknown = JSON.parse(sessionStorage.getItem(openKey(pod)) || '[]');
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}
function writeOpen(pod: string | undefined, open: ReadonlySet<string>) {
  if (!pod) return;
  try {
    sessionStorage.setItem(openKey(pod), JSON.stringify([...open]));
  } catch {
    // 저장소를 쓸 수 없으면(사생활 보호 창 등) 이 서랍 안에서만 기억한다
  }
}

const rowPath = (n: TreeNode) => (n.kind === 'dir' ? n.path : n.entry.path);

/** 「파일」 서랍(D3·D10·D11, R15, 스펙 2026-10-20-002 §3-7): 묶음별 조각 사용량 막대, 묶음 셋, 이름 찾기, 줄을 누르면 뷰어.
 *  「AI 에이전트가 만든 파일」은 폴더 트리로 보인다(스펙 2026-10-27-012). reveal 은 처음 성공한 목록 뒤 한 번 펼칠 폴더 */
/** 「파일」 서랍 본문. 목록을 읽지 못해 오류가 보일 때도 가이드가 강조할 수 있게 바깥을 감싼다 */
export function FilesDrawerBody(props: { store: ChatStore; reveal?: string }) {
  return (
    <Box data-guide="chat.file-list">
      <FilesDrawerInner {...props} />
    </Box>
  );
}

function FilesDrawerInner({ store, reveal }: { store: ChatStore; reveal?: string }) {
  const tk = useChatTokens();
  const dark = useTheme().palette.mode === 'dark';
  const confirm = useConfirm();
  const ask = useAskAbout(store);
  const { enqueueSnackbar } = useSnackbar();
  const viewer = useViewer();
  const pod = store.pod;
  const [data, setData] = useState<Listing | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  // 접은 묶음(이 서랍을 여는 동안만 기억한다). 찾는 동안에는 접힌 묶음도 맞는 줄을 보인다
  const [closed, setClosed] = useState<ReadonlySet<GroupKey>>(new Set());
  const toggle = (k: GroupKey) =>
    setClosed((c) => {
      const n = new Set(c);
      if (!n.delete(k)) n.add(k);
      return n;
    });
  // 펼친 폴더(사용자가 펴거나 reveal 로 편 경로만 저장한다). 위 폴더는 그릴 때마다 계산한다(R2·R6)
  const [opened, setOpenedState] = useState<ReadonlySet<string>>(() => readOpen(pod));
  const setOpened = (f: (o: ReadonlySet<string>) => ReadonlySet<string>) =>
    setOpenedState((o) => {
      const next = f(o);
      writeOpen(pod, next);
      return next;
    });
  const [planNote, setPlanNote] = useState<'' | 'planMissing' | 'planNotListed'>('');
  const revealed = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  // 서랍에서 고른 파일도 입력창 첨부와 같은 길(store.addFiles)로 올린다. 올리기가 끝날 때마다 목록을 다시 읽는다
  const uploaded = useSyncExternalStore(store.subscribe, () => store.uploads.filter((u) => u.state === 'done' && !u.picked).length);
  const seenUploaded = useRef(uploaded);

  const load = async () => {
    setError('');
    try {
      const l = await listFiles(pod);
      setData(l);
      addKnownPaths(pod, l.entries.filter((e) => e.kind === 'file').map((e) => e.path));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, [pod]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (uploaded > seenUploaded.current) void load();
    seenUploaded.current = uploaded;
  }, [uploaded]); // eslint-disable-line react-hooks/exhaustive-deps

  const needle = q.trim().toLowerCase();
  const searching = !!needle;
  const groups = useMemo(() => {
    const all = (data?.entries ?? []).filter((e) => e.kind === 'file' && !isFolderRoot(e.path));
    // 에이전트 묶음은 화면에 보이는 상대 경로(폴더 + 이름)로, 나머지는 이름으로 찾는다(4A)
    const hay = (e: ListingEntry) => (groupOf(e) === 'agent' ? e.path.replace(/^workspace\//, '') : e.name).toLowerCase();
    const rows = all.filter((e) => !needle || hay(e).includes(needle)).sort((a, b) => b.mtime - a.mtime);
    return GROUP_ORDER.map((key) => ({
      key,
      rows: rows.filter((e) => groupOf(e) === key),
      total: all.filter((e) => groupOf(e) === key).reduce((s, e) => s + e.size, 0),
    }));
  }, [data, needle]);
  const tree = useMemo(() => buildTree((data?.entries ?? []).filter((e) => e.kind === 'file' && groupOf(e) === 'agent')), [data]);
  // 올린 파일 날짜 폴더 트리(스펙 2026-10-28-002 F3). 회의 공유 파일은 shared 묶음이라 들어오지 않는다
  const uploadsTree = useMemo(() => buildTree((data?.entries ?? []).filter((e) => e.kind === 'file' && groupOf(e) === 'uploads'), 'workspace/uploads'), [data]);
  const treeOf = (key: GroupKey) => (key === 'uploads' ? uploadsTree : tree);
  const open = useMemo(() => withAncestors(opened), [opened]);
  // 서랍을 열 때마다 가장 최근 날짜 폴더를 한 번 편다 — 방금 올린 파일이 바로 보이게(F3). 사용자가 접으면 이 서랍에서는 접힌 채
  const seededUploads = useRef(false);
  useEffect(() => {
    if (!data || seededUploads.current) return;
    seededUploads.current = true;
    const latest = uploadsTree.find((n): n is TreeFolder => n.kind === 'dir');
    if (latest) setOpened((o) => (o.has(latest.path) ? o : new Set([...o, latest.path])));
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const rowEl = (p?: string) => (p ? listRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(p)}"]`) : null);
  const toggleFolder = (f: TreeFolder) => setOpened((o) => (open.has(f.path) ? collapse(o, f) : new Set([...o, f.path])));

  // reveal(§4-9): 처음 성공한 목록 뒤 한 번 펴고 그 줄로 포커스. 없으면 안내(6A), 목록이 잘렸으면 「찾지 못했습니다」(R10).
  // 안내 뒤 계획이 생겨도 저절로 펴지 않는다 — 단추를 다시 누르면 서랍이 새로 열려 편다
  useEffect(() => {
    if (!data || !reveal) return;
    const f = findFolder(tree, reveal);
    if (revealed.current) {
      if (f) setPlanNote('');
      return;
    }
    revealed.current = true;
    if (!f) {
      setPlanNote(data.truncated ? 'planNotListed' : 'planMissing');
      return;
    }
    setOpened((o) => new Set([...o, f.path]));
    setTimeout(() => {
      const el = rowEl(f.path);
      // 폴더 줄을 목록 맨 위로 올려 그 아래 계획 파일까지 보이게 한다. nearest 로는 위에 파일이 많을 때 폴더 줄만 화면 끝에 걸렸다(OKE 2026-10-28)
      el?.scrollIntoView?.({ block: 'start' });
      el?.focus({ preventScroll: true });
    }, 50);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 지운 줄 다음 줄로(없으면 이전 줄, 그것도 없으면 찾기 칸) 포커스(DD11). 트리에서는 보이는 줄 순서이고, 곧 사라질 위 폴더 줄은 건너뛴다 */
  const focusAfterDelete = (path: string, key: GroupKey, gone = 1) => {
    const skip = new Set([path]);
    let order: string[];
    if (key !== 'shared' && !searching) {
      const rows = visibleRows(treeOf(key), open);
      order = rows.map(rowPath);
      // 지운 폴더 아래 줄, 지운 것이 전부라 곧 사라질 위 폴더 줄은 건너뛴다(폴더 지우기는 gone = 그 폴더 파일 수)
      for (const n of rows) {
        const p = rowPath(n);
        if (p.startsWith(path + '/') || (n.kind === 'dir' && n.files === gone && path.startsWith(n.path + '/'))) skip.add(p);
      }
    } else order = (groups.find((x) => x.key === key)?.rows ?? []).map((e) => e.path);
    const i = order.indexOf(path);
    const next = order.slice(i + 1).find((p) => !skip.has(p)) ?? order.slice(0, Math.max(0, i)).reverse().find((p) => !skip.has(p));
    setTimeout(() => (rowEl(next) || searchRef.current)?.focus(), 50);
  };

  /** 트리 키보드(§4-10, 7A·R11): → 접힌 폴더 펴기·펼친 폴더 첫 자식으로, ← 펼친 폴더 접기·그 밖은 부모 줄로 */
  const onTreeKey = (ev: KeyboardEvent, n: TreeNode, parent?: string) => {
    if (ev.key === 'ArrowRight' && n.kind === 'dir') {
      ev.preventDefault();
      if (!open.has(n.path)) toggleFolder(n);
      else if (n.children[0]) rowEl(rowPath(n.children[0]))?.focus();
    } else if (ev.key === 'ArrowLeft') {
      if (n.kind === 'dir' && open.has(n.path)) {
        ev.preventDefault();
        toggleFolder(n);
      } else if (parent) {
        ev.preventDefault();
        rowEl(parent)?.focus();
      }
    }
  };

  const fileActions = (e: ListingEntry, key: GroupKey): ViewerActions => ({
    onAsk: () => ask(e),
    ...(key !== 'shared' && e.reason !== 'link' && e.reason !== 'hardlink'
      ? {
          onDelete: async () => {
            if (!(await confirm(t('chat.files.deleteConfirm', { name: e.name }), { danger: true }))) return false;
            const code = await deleteFile(pod, e.path);
            if (code) {
              enqueueSnackbar(reasonText(code), { variant: 'error' });
              return false;
            }
            store.markDeleted(e.path, e.size);
            enqueueSnackbar(t('chat.files.deletedToast', { name: e.name }), { variant: 'success' });
            void load();
            return true;
          },
          afterDelete: () => focusAfterDelete(e.path, key),
        }
      : {}),
  });
  const fileRow = (e: ListingEntry, key: GroupKey, tree?: { parent?: string }) => (
    <FileRow
      e={e}
      group={key}
      tree={!!tree}
      selected={viewer.file?.path === e.path}
      file={personalFile(store, e)}
      actions={fileActions(e, key)}
      onKeyDown={tree ? (ev) => onTreeKey(ev, { kind: 'file', entry: e, depth: 0 }, tree.parent) : undefined}
    />
  );

  if (error)
    return (
      <Alert severity="error" action={<Button startIcon={<RefreshIcon />} onClick={() => void load()}>{t('chat.files.reload')}</Button>}>
        {error}
      </Alert>
    );
  if (!data)
    return (
      <Stack spacing={1} aria-busy="true" aria-label={t('chat.files.loading')}>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} variant="rounded" height={36} />
        ))}
      </Stack>
    );

  const used = data.used;
  const quota = Math.max(1, data.quota);
  const ratio = used == null ? 0 : used / quota;
  const tone = ratio >= 1 ? (dark ? ALERT : ALERT_LIGHT) : ratio >= 0.8 ? (dark ? AMBER : AMBER_LIGHT) : undefined;
  const sum = (k: GroupKey) => groups.find((g) => g.key === k)?.total ?? 0;
  const segs = (['uploads', 'agent'] as const).map((k) => ({ key: k as GroupKey | 'other', size: sum(k) }));
  if (used != null) segs.push({ key: 'other', size: Math.max(0, used - sum('uploads') - sum('agent')) });
  const split = !data.truncated && used != null;
  // 서랍 전체가 비었는지는 파일만 센다. 목록이 잘렸으면 빈 서랍으로 보지 않는다(스펙 2026-10-27-012 재검토 12-3)
  const empty = !data.truncated && !data.entries.some((e) => e.kind === 'file' && !isFolderRoot(e.path));
  const sharedUsed = data.shared_used ?? sum('shared');
  const noMatch = searching && groups.every((g) => !g.rows.length);
  // 뷰어로 연 파일이 접힌 폴더 안에 있으면 보이는 위 폴더 줄에 Inactive 표시(5A)
  const hiddenSel = viewer.file?.path && !searching ? (visibleAncestor(viewer.file.path, tree, open) ?? visibleAncestor(viewer.file.path, uploadsTree, open)) : undefined;
  const note = planNote && (
    <Typography sx={{ fontSize: 12, color: tk.muted }} role="status">
      {t(`chat.files.${planNote}`)}
    </Typography>
  );
  const attach = (
    <>
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        data-testid="drawer-file-input"
        onChange={(e) => {
          store.addFiles(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
      <Tooltip title={t('chat.files.attachDrawerTip')} describeChild>
        <Button
          size="small"
          variant="outlined"
          color="inherit"
          startIcon={<AttachFileIcon fontSize="small" />}
          onClick={() => picker.current?.click()}
          sx={{ flexShrink: 0, height: 36, '@media (pointer: coarse)': { height: 44 } }}
        >
          {t('chat.files.attach')}
        </Button>
      </Tooltip>
    </>
  );
  /** 폴더 지우기(스펙 2026-10-28-002): 확인 창(파일 수·숨은 파일 안내) → DELETE recursive=1 → 안 파일 모두 지운 표시 → 다음 줄 포커스 */
  const deleteFolder = async (f: TreeFolder, key: GroupKey) => {
    const name = f.path.replace(/^workspace\//, '');
    const msg = t(data?.truncated ? 'chat.files.folderDeleteConfirmAtLeast' : 'chat.files.folderDeleteConfirm', { name, count: f.files });
    if (!(await confirm(msg, { danger: true }))) return;
    const code = await deleteFile(pod, f.path, true);
    if (code) {
      enqueueSnackbar(reasonText(code), { variant: 'error' });
      return;
    }
    const each = (n: TreeNode) => (n.kind === 'dir' ? n.children.forEach(each) : store.markDeleted(n.entry.path, n.entry.size));
    f.children.forEach(each);
    enqueueSnackbar(t('chat.files.folderDeletedToast', { name }), { variant: 'success' });
    setOpened((o) => collapse(o, f));
    void load();
    focusAfterDelete(f.path, key, f.files);
  };
  const renderTree = (nodes: TreeNode[], key: GroupKey, parent?: string): ReactNode =>
    nodes.map((n) =>
      n.kind === 'dir' ? (
        <li key={n.path}>
          <FolderRow
            f={n}
            open={open.has(n.path)}
            truncated={data.truncated}
            inactive={hiddenSel === n.path}
            onToggle={() => toggleFolder(n)}
            onDelete={() => void deleteFolder(n, key)}
            onKeyDown={(ev) => onTreeKey(ev, n, parent)}
          >
            {renderTree(n.children, key, n.path)}
          </FolderRow>
        </li>
      ) : (
        <li key={n.entry.path}>{fileRow(n.entry, key, { parent })}</li>
      )
    );

  return (
    <Stack spacing={2} sx={{ containerType: 'inline-size' }}>
      <Box>
        <Stack direction="row" alignItems="baseline" flexWrap="wrap" columnGap={1.5} rowGap={0.5}>
          <Typography component="span" sx={{ fontSize: 17, fontWeight: 700, color: tone ?? tk.text }}>
            {used == null ? t('chat.files.usageUnknown') : humanSize(used)}
          </Typography>
          <Typography component="span" sx={{ fontSize: 13, color: tk.muted }}>
            {t('chat.files.usedOf', { quota: humanSize(data.quota) })}
          </Typography>
          <Typography component="span" sx={{ fontSize: 12, color: tk.muted, ml: 'auto' }}>
            {t('chat.files.podNote')}
          </Typography>
        </Stack>
        <Box
          role="img"
          aria-label={`${t('chat.files.usage')} ${used == null ? t('chat.files.usageUnknown') : humanSize(used)} / ${humanSize(data.quota)}`}
          sx={{ display: 'flex', gap: '2px', height: 6, mt: 1, borderRadius: '3px', overflow: 'hidden', bgcolor: dark ? 'rgba(255,255,255,0.06)' : 'rgba(17,24,39,0.06)' }}
        >
          {split
            ? segs.map((s) =>
                s.size > 0 ? <Box key={s.key} sx={{ width: `${(s.size / quota) * 100}%`, minWidth: 2, bgcolor: shade(dark, s.key) }} /> : null
              )
            : used != null && <Box sx={{ width: `${Math.min(100, ratio * 100)}%`, bgcolor: shade(dark, 'uploads') }} />}
        </Box>
        {split && (
          <Stack direction="row" flexWrap="wrap" columnGap={1.5} rowGap={0.5} sx={{ mt: 0.75, fontSize: 12, color: tk.muted }}>
            {segs.map((s) => (
              <Stack key={s.key} direction="row" alignItems="center" spacing={0.5}>
                <Dot color={shade(dark, s.key)} />
                <span>
                  {s.key === 'other' ? t('chat.files.legendOther') : s.key === 'uploads' ? t('chat.files.groupUploads') : t('chat.files.groupOther')} {humanSize(s.size)}
                </span>
              </Stack>
            ))}
            {sharedUsed > 0 && (
              <Stack direction="row" alignItems="center" spacing={0.5}>
                <Dot color={shade(dark, 'shared')} />
                <span>
                  {t('chat.files.groupShared')} {t('chat.files.legendShared', { size: humanSize(sharedUsed) })}
                </span>
              </Stack>
            )}
          </Stack>
        )}
        {ratio >= 1 ? (
          <Typography variant="caption" component="div" sx={{ color: tone, mt: 0.5 }}>
            {t('chat.files.quotaFull')}
          </Typography>
        ) : ratio >= 0.8 ? (
          <Typography variant="caption" component="div" sx={{ color: tone, mt: 0.5 }}>
            {t('chat.files.quotaWarn', { quota: humanSize(data.quota) })}
          </Typography>
        ) : null}
      </Box>
      {empty ? (
        <Stack spacing={1.5} alignItems="flex-start">
          <Typography color="text.secondary">{t('chat.files.empty')}</Typography>
          {note}
          {attach}
        </Stack>
      ) : (
        <>
          <Stack direction="row" spacing={1} alignItems="center">
            <FileSearch inputRef={searchRef} value={q} onChange={setQ} placeholder={t('chat.files.searchPlaceholderPath')} />
            {attach}
            <Tooltip title={t('chat.files.reload')}>
              <IconButton aria-label={t('chat.files.reload')} onClick={() => void load()} sx={{ width: 36, height: 36, '@media (pointer: coarse)': { width: 44, height: 44 } }}>
                <RefreshIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
          {data.truncated && <Alert severity="warning">{t('chat.files.partial')}</Alert>}
          {note}
          <Box ref={listRef}>
            {noMatch ? (
              <Typography sx={{ px: 1, fontSize: 12, color: tk.muted }}>{t('chat.files.noMatch', { q: q.trim() })}</Typography>
            ) : (
              <>
                <Box
                  aria-hidden
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: `28px 1fr 88px 100px ${ACTIONS_W}px`,
                    columnGap: 1.5,
                    pl: 1,
                    fontSize: 12,
                    color: dark ? 'rgba(255,255,255,0.5)' : 'rgba(17,24,39,0.6)',
                    '@container (max-width: 559px)': { display: 'none' },
                  }}
                >
                  <span />
                  <span>{t('chat.files.colName')}</span>
                  <Box component="span" sx={{ textAlign: 'right' }}>
                    {t('chat.files.colSize')}
                  </Box>
                  <Box component="span" sx={{ textAlign: 'right' }}>
                    {t('chat.files.colTime')}
                  </Box>
                </Box>
                {groups.map((g) => {
                  // 목록이 잘리면 에이전트 묶음 머리도 일부 값이라고 보인다(2A)
                  const partial = g.key === 'agent' && data.truncated;
                  const treeMode = g.key !== 'shared' && !searching;
                  return (
                    <Box key={g.key} component="section" aria-label={groupTitle(g.key)} sx={{ mt: 2.5 }}>
                      <GroupHead
                        icon={GROUP_ICON[g.key]}
                        title={groupTitle(g.key)}
                        count={partial ? `${g.rows.length}+` : g.rows.length}
                        ariaLabel={partial ? t('chat.files.groupAtLeastAria', { title: groupTitle(g.key), count: g.rows.length }) : undefined}
                        tail={
                          <>
                            <Dot color={shade(dark, g.key)} />
                            {partial ? '—' : humanSize(g.total)}
                          </>
                        }
                        open={searching || !closed.has(g.key)}
                        onToggle={() => toggle(g.key)}
                        controls={`fg-${g.key}`}
                      />
                      <Box id={`fg-${g.key}`} hidden={!searching && closed.has(g.key)}>
                        {!g.rows.length && !searching && (
                          <Typography sx={{ px: 1, fontSize: 12, color: tk.muted }}>
                            {t(g.key === 'uploads' ? 'chat.files.emptyUploads' : g.key === 'shared' ? 'chat.files.emptyShared' : 'chat.files.emptyAgent')}
                          </Typography>
                        )}
                        <Stack component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
                          {treeMode ? renderTree(treeOf(g.key), g.key) : g.rows.map((e) => <li key={e.path}>{fileRow(e, g.key)}</li>)}
                        </Stack>
                      </Box>
                    </Box>
                  );
                })}
              </>
            )}
          </Box>
        </>
      )}
    </Stack>
  );
}

const groupTitle = (k: GroupKey) => t(k === 'uploads' ? 'chat.files.groupUploads' : k === 'shared' ? 'chat.files.groupShared' : 'chat.files.groupOther');

/** 이름 칸: 하위 폴더가 있으면 폴더 부분만 흐리게(report/**summary.md**). 올린 파일은 날짜 폴더를 보이지 않는다. 트리 안에서는 폴더 줄이 경로를 보이므로 이름만 */
function displayName(e: ListingEntry, group: GroupKey, tree: boolean): { dir: string; base: string } {
  if (group !== 'agent' || tree) return { dir: '', base: e.name };
  const rel = e.path.replace(/^workspace\//, '');
  const cut = rel.lastIndexOf('/');
  return cut < 0 ? { dir: '', base: rel } : { dir: rel.slice(0, cut + 1), base: rel.slice(cut + 1) };
}

const rowGrid = {
  display: 'grid',
  gridTemplateColumns: '28px 1fr 88px 100px',
  columnGap: 1.5,
  alignItems: 'center',
  '@container (max-width: 559px)': { gridTemplateColumns: '28px 1fr', rowGap: 0 },
} as const;
/** 에이전트 묶음 트리 줄: 앞 칸 = 꺾쇠 16px + 6px + 타일 28px(R1·13A). 크기·시각 칸은 다른 묶음과 같다 */
const LEAD_W = 50;
const treeGrid = {
  ...rowGrid,
  gridTemplateColumns: `${LEAD_W}px 1fr 88px 100px`,
  '@container (max-width: 559px)': { gridTemplateColumns: `${LEAD_W}px 1fr`, rowGap: 0 },
} as const;
/** 자식 목록 들여쓰기(12A·9A): 넓은 서랍 15 + 테두리 1(안내선, 꺾쇠 가운데 아래) + 4 = 20px, 좁은 서랍 0 + 1 + 11 = 12px, 7단계부터 0 */
const subList = (depth: number, dark: boolean) => ({
  listStyle: 'none',
  m: 0,
  p: 0,
  ...(depth + 1 < 6
    ? {
        ml: '15px',
        pl: '4px',
        borderLeft: `1px solid ${dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.06)'}`,
        '@container (max-width: 559px)': { ml: 0, pl: '11px' },
      }
    : {}),
});

/** 줄 끝 단추 칸 폭(28px 단추 둘 + 틈 4px). 열 머리도 같은 폭을 비워 크기·시각 열을 맞춘다 */
const ACTIONS_W = 60;

/** 줄 끝 작은 아이콘 단추. 터치 화면은 보이는 크기는 두고 누르는 영역만 넓힌다(DD18) */
const rowBtn = {
  width: 28,
  height: 28,
  borderRadius: '6px',
  position: 'relative',
  '@media (pointer: coarse)': { '&::after': { content: '""', position: 'absolute', inset: -8 } },
} as const;

/** 종류 타일 28px(파일·폴더 같음) */
const tileSx = (dark: boolean, muted: string) => ({
  width: 28,
  height: 28,
  borderRadius: '6px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  bgcolor: dark ? 'rgba(255,255,255,0.04)' : 'rgba(17,24,39,0.03)',
  color: muted,
});

/** 파일 줄: 열기 단추(종류 타일·이름·크기·시각, §3-7·F9)와 그 옆 「AI 에게 묻기」·「지우기」 단추(2026-10-21).
 *  단추 안에 단추를 넣지 않으려고 열기 단추와 줄 끝 단추를 형제로 둔다. 접근 이름은 「〈이름〉 열기」, 크기·시각은 aria-describedby.
 *  tree 면 앞에 꺾쇠 칸만큼 비우고 이름만 보인다(스펙 2026-10-27-012) */
function FileRow({
  e,
  group,
  file,
  actions,
  selected,
  tree = false,
  onKeyDown,
}: {
  e: ListingEntry;
  group: GroupKey;
  file: ViewerFile;
  actions: ViewerActions;
  selected: boolean;
  tree?: boolean;
  onKeyDown?: (ev: KeyboardEvent) => void;
}) {
  const tk = useChatTokens();
  const dark = useTheme().palette.mode === 'dark';
  const metaId = `fm-${e.path}`;
  const { dir, base } = displayName(e, group, tree);
  const size = humanSize(e.size);
  const when = fmtWhen(e.mtime);
  const room = e.room || sharedRoom(e.path);
  const roomTail = group === 'shared' && room ? (e.path.includes('aas-shared-out/') ? t('chat.files.roomResult', { room: t('chat.files.roomLabel', { room }) }) : t('chat.files.roomLabel', { room })) : '';
  const remove = async () => {
    if (await actions.onDelete?.()) actions.afterDelete?.();
  };
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.5,
        borderRadius: '6px',
        bgcolor: selected ? tk.selected : 'transparent',
        boxShadow: selected ? `inset 2px 0 0 ${dark ? 'rgba(255,255,255,0.85)' : 'rgba(17,24,39,0.70)'}` : 'none',
        '&:hover': { bgcolor: selected ? tk.selected : tk.hover },
        // 줄 끝 단추는 가리킨 줄·포커스가 들어온 줄·뷰어를 연 줄에서만 보인다. 터치 화면은 가리킬 수 없어 늘 보인다. 자리는 늘 차지해 열이 흔들리지 않는다
        '& .row-actions': { opacity: selected ? 1 : 0 },
        '&:hover .row-actions, &:focus-within .row-actions': { opacity: 1 },
        '@media (pointer: coarse)': { '& .row-actions': { opacity: 1 } },
      }}
    >
      <ButtonBase
        data-path={e.path}
        aria-label={t('chat.files.rowOpenAria', { name: e.name })}
        aria-describedby={metaId}
        aria-haspopup="dialog"
        onClick={(ev) => openViewer(file, actions, ev.currentTarget)} // 닫으면 포커스가 이 줄로(§3-7)
        onKeyDown={onKeyDown}
        sx={{
          ...(tree ? treeGrid : rowGrid),
          flex: 1,
          minWidth: 0,
          minHeight: chatMetrics.touch,
          px: 1,
          textAlign: 'left',
          borderRadius: '6px',
          font: 'inherit',
          opacity: file.blocked ? 0.55 : 1,
          '&:focus-visible': { outline: `2px solid ${FOCUS_RING}`, outlineOffset: -2 },
        }}
      >
        <Box sx={{ display: 'flex', justifyContent: tree ? 'flex-end' : 'flex-start', '@container (max-width: 559px)': { gridRow: 'span 2' } }}>
          <Box sx={tileSx(dark, tk.muted)}>
            <FileIcon name={e.name} />
          </Box>
        </Box>
        <Box sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 }}>
          {dir && <Box component="span" sx={{ color: tk.muted, fontWeight: 400 }}>{dir}</Box>}
          <Box component="span" sx={{ color: tk.text, fontWeight: 500, textDecoration: file.blocked === 'deleted' ? 'line-through' : 'none' }}>
            {base}
          </Box>
          {roomTail && <Box component="span" sx={{ color: tk.muted, fontSize: 12, ml: 0.75 }}>{roomTail}</Box>}
        </Box>
        <Box id={metaId} sx={{ display: 'contents', fontSize: 12, color: tk.muted, fontVariantNumeric: 'tabular-nums', '@container (max-width: 559px)': { display: 'block', gridColumn: 2 } }}>
          <Box component="span" sx={{ textAlign: 'right', fontSize: 12, color: tk.muted, '@container (max-width: 559px)': { display: 'none' } }}>
            {size}
          </Box>
          <Tooltip title={new Date(e.mtime * 1000).toLocaleString()}>
            <Box component="span" sx={{ textAlign: 'right', fontSize: 12, color: tk.muted, '@container (max-width: 559px)': { display: 'none' } }}>
              {when}
            </Box>
          </Tooltip>
          <Box component="span" sx={{ display: 'none', fontSize: 12, color: tk.muted, '@container (max-width: 559px)': { display: 'inline' } }}>
            {size}, {when}
          </Box>
        </Box>
      </ButtonBase>
      <Stack className="row-actions" direction="row" spacing={0.5} sx={{ width: ACTIONS_W, flexShrink: 0, pr: 0.5, justifyContent: 'flex-start', transition: 'opacity 120ms', '@media (prefers-reduced-motion: reduce)': { transition: 'none' } }}>
        {actions.onAsk && !file.blocked && (
          <Tooltip title={t('chat.viewer.ask')}>
            <IconButton aria-label={t('chat.files.askAria', { name: e.name })} onClick={actions.onAsk} sx={{ ...rowBtn, color: tk.muted, '&:hover': { color: tk.text } }}>
              <ForumOutlinedIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        )}
        {actions.onDelete && (
          <Tooltip title={t('chat.viewer.delete')}>
            <IconButton
              aria-label={t('chat.files.deleteAria', { name: e.name })}
              onClick={() => void remove()}
              sx={{ ...rowBtn, color: tk.muted, '&:hover': { color: dark ? ALERT : ALERT_LIGHT } }}
            >
              <DeleteOutlineIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        )}
      </Stack>
    </Box>
  );
}

/** 폴더 줄(스펙 2026-10-27-012 §4-2·§4-12): 줄 전체가 펼침 단추. 꺾쇠 + 폴더 타일 + 이름(앞 경로가 먼저 줄어듦, 14A) + 「파일 N개」, 크기 합·최근 시각.
 *  줄 끝 지우기 단추는 폴더를 통째로 지운다(스펙 2026-10-28-002, 2026-10-27-012 R9 의 흐린 단추를 바꿈). 자식 목록은 접혀도 남겨 aria-controls 가 가리킨다 */
function FolderRow({
  f,
  open,
  truncated,
  inactive,
  onToggle,
  onDelete,
  onKeyDown,
  children,
}: {
  f: TreeFolder;
  open: boolean;
  truncated: boolean;
  inactive: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onKeyDown: (ev: KeyboardEvent) => void;
  children: ReactNode;
}) {
  const tk = useChatTokens();
  const dark = useTheme().palette.mode === 'dark';
  const listId = useId();
  const metaId = useId();
  const name = f.path.replace(/^workspace\//, '');
  const cut = f.label.lastIndexOf('/');
  const head = f.label.slice(0, cut + 1);
  const last = f.label.slice(cut + 1);
  const countText = t(truncated ? 'chat.files.folderCountAtLeast' : 'chat.files.folderCount', { count: f.files });
  const size = truncated ? '—' : humanSize(f.size);
  const when = fmtWhen(f.mtime);
  // Inactive(DESIGN §1-1.2): 뷰어로 연 파일이 이 접힌 폴더 안에 있다(5A). 선택된 파일 줄처럼 가리켜도 바탕을 유지한다
  const inactiveBg = dark ? 'rgba(255,255,255,0.03)' : 'rgba(17,24,39,0.02)';
  const clip = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const;
  return (
    <>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          borderRadius: '6px',
          bgcolor: inactive ? inactiveBg : 'transparent',
          boxShadow: inactive ? `inset 2px 0 0 ${dark ? 'rgba(255,255,255,0.50)' : 'rgba(17,24,39,0.40)'}` : 'none',
          '&:hover': { bgcolor: inactive ? inactiveBg : tk.hover },
          '& .row-actions': { opacity: 0 },
          '&:hover .row-actions, &:focus-within .row-actions': { opacity: 1 },
          '@media (pointer: coarse)': { '& .row-actions': { opacity: 1 } },
        }}
      >
        <ButtonBase
          data-path={f.path}
          aria-label={t(truncated ? 'chat.files.folderAtLeastAria' : 'chat.files.folderAria', { name, count: f.files })}
          aria-expanded={open}
          aria-controls={listId}
          aria-describedby={metaId}
          onClick={onToggle}
          onKeyDown={onKeyDown}
          sx={{
            ...treeGrid,
            flex: 1,
            minWidth: 0,
            minHeight: chatMetrics.touch,
            px: 1,
            textAlign: 'left',
            borderRadius: '6px',
            font: 'inherit',
            '&:focus-visible': { outline: `2px solid ${FOCUS_RING}`, outlineOffset: -2 },
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: '6px', '@container (max-width: 559px)': { gridRow: 'span 2' } }}>
            <ChevronRightIcon
              aria-hidden
              sx={{
                fontSize: 16,
                color: tk.muted,
                transform: open ? 'rotate(90deg)' : 'none',
                transition: 'transform 160ms',
                '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
              }}
            />
            <Box sx={tileSx(dark, tk.muted)}>
              <FolderOutlinedIcon sx={{ fontSize: 16 }} aria-hidden />
            </Box>
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75, minWidth: 0, fontSize: 13 }}>
            <Tooltip title={name}>
              <Box component="span" sx={{ display: 'flex', minWidth: 0, color: tk.text, fontWeight: 500 }}>
                {head && (
                  <Box component="span" sx={{ ...clip, flexShrink: 1000 }}>
                    {head}
                  </Box>
                )}
                <Box component="span" sx={{ ...clip, flexShrink: 1 }}>
                  {last}
                  <Box component="span" sx={{ color: tk.muted, fontWeight: 400 }}>
                    /
                  </Box>
                </Box>
              </Box>
            </Tooltip>
            <Box component="span" sx={{ flexShrink: 0, fontSize: 12, color: tk.muted, '@container (max-width: 559px)': { display: 'none' } }}>
              {countText}
            </Box>
          </Box>
          <Box id={metaId} sx={{ display: 'contents', fontSize: 12, color: tk.muted, fontVariantNumeric: 'tabular-nums', '@container (max-width: 559px)': { display: 'block', gridColumn: 2 } }}>
            <Box component="span" sx={{ textAlign: 'right', fontSize: 12, color: tk.muted, '@container (max-width: 559px)': { display: 'none' } }}>
              {size}
            </Box>
            <Tooltip title={new Date(f.mtime * 1000).toLocaleString()}>
              <Box component="span" sx={{ textAlign: 'right', fontSize: 12, color: tk.muted, '@container (max-width: 559px)': { display: 'none' } }}>
                {when}
              </Box>
            </Tooltip>
            <Box component="span" sx={{ display: 'none', fontSize: 12, color: tk.muted, '@container (max-width: 559px)': { display: 'inline' } }}>
              <span aria-hidden>{countText}, </span>
              {size}, {when}
            </Box>
          </Box>
        </ButtonBase>
        <Stack className="row-actions" direction="row" spacing={0.5} sx={{ width: ACTIONS_W, flexShrink: 0, pr: 0.5, transition: 'opacity 120ms', '@media (prefers-reduced-motion: reduce)': { transition: 'none' } }}>
          <Box sx={{ width: 28, flexShrink: 0 }} />
          <Tooltip title={t('chat.viewer.delete')}>
            <IconButton aria-label={t('chat.files.deleteAria', { name })} onClick={onDelete} sx={{ ...rowBtn, color: tk.muted, '&:hover': { color: dark ? ALERT : ALERT_LIGHT } }}>
              <DeleteOutlineIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        </Stack>
      </Box>
      <Box component="ul" id={listId} hidden={!open} sx={subList(f.depth, dark)}>
        {open ? children : null}
      </Box>
    </>
  );
}
