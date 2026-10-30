/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 파일 뷰어 창(스펙 2026-10-20-002 §3-5, 리뷰 R9, 디자인 리뷰 DD3·DD6·DD8·DD14·DD15·DD17).
// 창 껍데기와 머리 영역은 여기서 바로 그리고, 본문(받기·종류별 그리기)은 FileViewer 묶음을 처음 열 때 받는다 — 받는 동안에도 무엇을 열었는지 보인다.
import AddIcon from '@mui/icons-material/Add';
import CheckIcon from '@mui/icons-material/Check';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CloseIcon from '@mui/icons-material/Close';
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import FitScreenOutlinedIcon from '@mui/icons-material/FitScreenOutlined';
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import RemoveIcon from '@mui/icons-material/Remove';
import SearchIcon from '@mui/icons-material/Search';
import ShareOutlinedIcon from '@mui/icons-material/ShareOutlined';
import WrapTextIcon from '@mui/icons-material/WrapText';
import {
  Box,
  Button,
  Collapse,
  Dialog,
  Divider,
  IconButton,
  ListItemIcon,
  Menu,
  MenuItem,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';

import { useChatTokens } from '@/components/chat/useChatTokens';
import { DisclosureButton } from '@/components/DisclosureButton';
import { t } from '@/i18n';
import { humanSize } from '@/lib/chatFiles';
import { chatMetrics } from '@/lib/chatTokens';
import { type ViewerKind,viewerKind } from '@/lib/fileKinds';
import { DATA_ROOT } from '@/lib/filePaths';
import { MONO_FONT } from '@/lib/monoFont';
import { FOCUS_RING } from '@/lib/shellTokens';

import { zoomStep } from './docs/docMath';
import { docStore, useDoc } from './docs/docStore';
import { FileIcon } from './FileBadge';
import { BodySkeleton, fmtWhen, isDocKind, saveFile, sourceLabel, startsSmall } from './viewerParts';
import { closeViewer, INLINE_HINT_ID, useViewer } from './viewerStore';

const FileViewer = lazy(() => import('./FileViewer'));

/** 「보기 / 원문」을 바꿀 수 있는 종류 — 그린 것과 원문이 다른 것만 */
const TOGGLE = new Set<ViewerKind>(['markdown', 'html', 'csv', 'svg']);
const WRAPPABLE = new Set<ViewerKind>(['text', 'markdown', 'html', 'csv', 'svg']);

export function LazyFileViewer() {
  const { file, actions, seq } = useViewer();
  const tk = useChatTokens();
  const theme = useTheme();
  const narrow = useMediaQuery(theme.breakpoints.down('sm'));
  const { enqueueSnackbar } = useSnackbar();
  const titleId = useId();
  const detailsId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const [mode, setMode] = useState<'view' | 'source'>('view');
  const [wrap, setWrap] = useState(false);
  const [fit, setFit] = useState(true);
  const [size, setSize] = useState<number | undefined>();
  const [small, setSmall] = useState(false);
  const [details, setDetails] = useState(false);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const doc = useDoc();
  const entered = useRef(false);

  const kind = file ? viewerKind(file.name) : 'other';
  useEffect(() => {
    if (!file) return;
    setMode('view');
    setWrap(kind === 'markdown');
    setFit(true);
    setSize(file.size);
    setSmall(startsSmall(file));
    setDetails(false);
    setCopied(false);
    entered.current = false;
    docStore.reset();
  }, [seq]); // eslint-disable-line react-hooks/exhaustive-deps

  // 열린 뒤 작은 창으로 줄면 포커스를 옮긴다(005 재검토 D3). 처음 포커스는 onEntered 가 맡는다. 주 단추를 쓸 수 없으면 본문(OV2-L2)
  useEffect(() => {
    if (!small || !entered.current) return;
    const p = primaryRef.current;
    (p && !p.disabled && !actions.onToRoom ? p : bodyRef.current)?.focus();
  }, [small]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!file) return <HiddenHint />;

  const canToggle = TOGGLE.has(kind) && !small;
  const canWrap = !small && (kind === 'text' || (mode === 'source' && WRAPPABLE.has(kind)));
  const docKind = isDocKind(kind) && !small;
  const canFit = !small && mode === 'view' && (kind === 'image' || kind === 'svg');
  const docFit = doc.zoom === 100;
  const primaryIsRoom = !!actions.onToRoom;
  const agentPath = file.path ? DATA_ROOT + file.path : '';
  const folder = file.path ? file.path.split('/').slice(0, -1).join('/') : '';
  const meta = [size != null ? humanSize(size) : t('chat.viewer.sizeChecking'), file.mtime ? fmtWhen(file.mtime) : '', sourceLabel(file)].filter(Boolean);

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(agentPath);
      setCopied(true);
      enqueueSnackbar(t('chat.viewer.copied'), { variant: 'success' });
    } catch {
      enqueueSnackbar(t('chat.files.copyFail'), { variant: 'error' });
    }
  };
  const ask = () => {
    closeViewer(false);
    actions.onAsk?.();
  };
  const remove = async () => {
    setMenu(null);
    if (!actions.onDelete) return;
    if (await actions.onDelete()) {
      closeViewer(false);
      actions.afterDelete?.();
    }
  };
  const toRoom = async () => {
    setBusy(true);
    try {
      await actions.onToRoom?.();
    } finally {
      setBusy(false);
    }
  };

  const primary = primaryIsRoom ? (
    <Button ref={primaryRef} variant="contained" size="small" startIcon={<ShareOutlinedIcon />} disabled={busy} onClick={() => void toRoom()} sx={touch}>
      {t('chat.viewer.toRoom')}
    </Button>
  ) : (
    <Button ref={primaryRef} variant="contained" size="small" startIcon={<FileDownloadOutlinedIcon />} disabled={!!file.blocked} onClick={() => saveFile(file)} sx={touch}>
      {t('chat.viewer.download')}
    </Button>
  );
  const askBtn = actions.onAsk && (
    <Tooltip title={t('chat.viewer.ask')}>
      <IconButton aria-label={t('chat.viewer.ask')} onClick={ask} sx={touch}>
        <ForumOutlinedIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  );
  const copyBtn = agentPath && (
    <Tooltip title={t('chat.viewer.copyPath')}>
      <IconButton aria-label={t('chat.viewer.copyPath')} onClick={() => void copyPath()} sx={touch}>
        {copied ? <CheckIcon fontSize="small" /> : <ContentCopyOutlinedIcon fontSize="small" />}
      </IconButton>
    </Tooltip>
  );
  // 좁은 화면은 AI·복사·줄 바꿈·자세히도 「…」 안으로(DD17). 넓은 화면의 「…」 은 지우기만(DD3)
  const menuItems = [
    ...(narrow && actions.onAsk ? [{ key: 'ask', icon: <ForumOutlinedIcon fontSize="small" />, label: t('chat.viewer.ask'), run: ask }] : []),
    ...(narrow && agentPath ? [{ key: 'copy', icon: <ContentCopyOutlinedIcon fontSize="small" />, label: t('chat.viewer.copyPath'), run: () => void copyPath() }] : []),
    ...(narrow && canWrap ? [{ key: 'wrap', icon: <WrapTextIcon fontSize="small" />, label: t('chat.viewer.wrap'), run: () => setWrap((w) => !w) }] : []),
    ...(narrow && docKind && kind !== 'xlsx'
      ? [
          { key: 'zoomIn', icon: <AddIcon fontSize="small" />, label: `${t('chat.viewer.doc.zoomIn')} (${doc.zoom}%)`, run: () => docStore.setZoom(zoomStep(doc.zoom, 1)) },
          { key: 'zoomOut', icon: <RemoveIcon fontSize="small" />, label: t('chat.viewer.doc.zoomOut'), run: () => docStore.setZoom(zoomStep(doc.zoom, -1)) },
          { key: 'fit', icon: <FitScreenOutlinedIcon fontSize="small" />, label: t('chat.viewer.fit'), run: () => docStore.setZoom(100) },
          ...(kind === 'pdf' ? [{ key: 'find', icon: <SearchIcon fontSize="small" />, label: t('chat.viewer.doc.find'), run: () => docStore.openFind() }] : []),
        ]
      : []),
    ...(narrow && agentPath ? [{ key: 'details', icon: <ExpandMoreIcon fontSize="small" />, label: t('chat.viewer.details'), run: () => setDetails((d) => !d) }] : []),
  ];
  const hasMenu = menuItems.length > 0 || !!actions.onDelete;

  // 문서 형식의 확대/축소(005 재검토 D5)·맞춤/원래 크기(디자인 DV1)·찾기(DV16). 좁은 화면은 「…」 안으로
  const docTools = (
    <Stack direction="row" alignItems="center" spacing={0.25}>
      <Tooltip title={t('chat.viewer.doc.zoomOut')}>
        <span>
          <IconButton aria-label={t('chat.viewer.doc.zoomOut')} disabled={doc.zoom <= 50} onClick={() => docStore.setZoom(zoomStep(doc.zoom, -1))} sx={touch}>
            <RemoveIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Typography sx={{ fontSize: 12, color: tk.muted, fontVariantNumeric: 'tabular-nums', minWidth: 40, textAlign: 'center' }}>{doc.zoom}%</Typography>
      <Tooltip title={t('chat.viewer.doc.zoomIn')}>
        <span>
          <IconButton aria-label={t('chat.viewer.doc.zoomIn')} disabled={doc.zoom >= 300} onClick={() => docStore.setZoom(zoomStep(doc.zoom, 1))} sx={touch}>
            <AddIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title={docFit ? t('chat.viewer.original') : t('chat.viewer.fit')}>
        <span>
          <IconButton
            aria-label={docFit ? t('chat.viewer.original') : t('chat.viewer.fit')}
            disabled={docFit && !doc.natural}
            onClick={() => docStore.setZoom(docFit ? doc.natural : 100)}
            sx={touch}
          >
            <FitScreenOutlinedIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      {kind === 'pdf' && (
        <Tooltip title={t('chat.viewer.doc.find')}>
          <IconButton aria-label={t('chat.viewer.doc.find')} aria-pressed={doc.findOpen} onClick={() => (doc.findOpen ? docStore.closeFind() : docStore.openFind())} sx={{ ...touch, bgcolor: doc.findOpen ? tk.selected : undefined }}>
            <SearchIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      )}
    </Stack>
  );
  const toggles = (
    <Stack direction="row" spacing={0.5} alignItems="center">
      {canToggle && (
        <ToggleButtonGroup exclusive size="small" value={mode} onChange={(_, v) => v && setMode(v)} aria-label={t('chat.viewer.view')}>
          <ToggleButton value="view" sx={touch}>
            {t('chat.viewer.view')}
          </ToggleButton>
          <ToggleButton value="source" sx={touch}>
            {t('chat.viewer.source')}
          </ToggleButton>
        </ToggleButtonGroup>
      )}
      {canWrap && !narrow && (
        <Tooltip title={t('chat.viewer.wrap')}>
          <IconButton aria-label={t('chat.viewer.wrap')} aria-pressed={wrap} onClick={() => setWrap((w) => !w)} sx={{ ...touch, bgcolor: wrap ? tk.selected : undefined }}>
            <WrapTextIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      )}
      {canFit && (
        <Tooltip title={fit ? t('chat.viewer.original') : t('chat.viewer.fit')}>
          <IconButton aria-label={fit ? t('chat.viewer.original') : t('chat.viewer.fit')} onClick={() => setFit((f) => !f)} sx={touch}>
            <FitScreenOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      )}
      {docKind && doc.pages > 0 && (
        <Stack direction="row" alignItems="center" spacing={0.25}>
          <Tooltip title={t('chat.viewer.doc.prev')}>
            <span>
              <IconButton aria-label={t('chat.viewer.doc.prev')} disabled={doc.page <= 1} onClick={() => docStore.goto(doc.page - 1)} sx={touch}>
                <ChevronLeftIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Typography sx={{ fontSize: 12, color: tk.muted, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
            {t(kind === 'pptx' ? 'chat.viewer.doc.slideOf' : 'chat.viewer.doc.pageOf', { page: doc.page || 1, pages: doc.pages })}
          </Typography>
          <Tooltip title={t('chat.viewer.doc.next')}>
            <span>
              <IconButton aria-label={t('chat.viewer.doc.next')} disabled={doc.page >= doc.pages} onClick={() => docStore.goto(doc.page + 1)} sx={touch}>
                <ChevronRightIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>
      )}
      {docKind && kind !== 'xlsx' && !narrow && docTools}
    </Stack>
  );
  const moreBtn = hasMenu && (
    <>
      <Tooltip title={t('chat.viewer.more')}>
        <IconButton aria-label={t('chat.viewer.more')} aria-haspopup="menu" onClick={(e) => setMenu(e.currentTarget)} sx={touch}>
          <MoreHorizIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Menu anchorEl={menu} open={!!menu} onClose={() => setMenu(null)}>
        {menuItems.map((m) => (
          <MenuItem
            key={m.key}
            onClick={() => {
              setMenu(null);
              m.run();
            }}
          >
            <ListItemIcon>{m.icon}</ListItemIcon>
            {m.label}
          </MenuItem>
        ))}
        {actions.onDelete && menuItems.length > 0 && <Divider />}
        {actions.onDelete && (
          <MenuItem onClick={() => void remove()} sx={{ color: 'error.main' }}>
            <ListItemIcon sx={{ color: 'inherit' }}>
              <DeleteOutlineIcon fontSize="small" />
            </ListItemIcon>
            {t('chat.viewer.delete')}
          </MenuItem>
        )}
      </Menu>
    </>
  );
  const closeBtn = (
    <Tooltip title={t('chat.viewer.close')}>
      <IconButton aria-label={t('chat.viewer.close')} onClick={() => closeViewer()} sx={touch}>
        <CloseIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  );
  const nameBlock = (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0, flex: 1 }}>
      <FileIcon name={file.name} size={20} />
      <Box sx={{ minWidth: 0 }}>
        <Tooltip title={file.name}>
          <Typography id={titleId} noWrap sx={{ fontSize: 14, fontWeight: 500, color: tk.text }}>
            {file.name}
          </Typography>
        </Tooltip>
        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
          <Typography noWrap sx={{ fontSize: 12, color: tk.muted }}>
            {meta.join(' · ')}
          </Typography>
          {agentPath && !narrow && (
            <DisclosureButton open={details} onToggle={() => setDetails((d) => !d)} controls={detailsId} label={t('chat.viewer.details')} sx={{ fontSize: 12, minWidth: 0, py: 0, color: tk.muted }} />
          )}
        </Stack>
      </Box>
    </Stack>
  );

  return (
    <>
      <HiddenHint />
      <Dialog
        open
        fullScreen={narrow && !small}
        onClose={(_, reason) => {
          // Monaco 찾기 위젯이나 문서 찾기 줄이 열려 있으면 Esc 는 찾기만 닫는다(DD15 ⑤, 005 OV2-L1)
          if (reason === 'escapeKeyDown' && document.querySelector('.monaco-editor .find-widget.visible')) return;
          if (reason === 'escapeKeyDown' && docStore.get().findOpen) return docStore.closeFind();
          closeViewer();
        }}
        onKeyDown={(e) => {
          // 뷰어 안 Ctrl+F 는 PDF 전체 찾기(디자인 DV16) — 브라우저 찾기는 그려 둔 쪽만 찾는다
          if (kind === 'pdf' && !small && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
            e.preventDefault();
            docStore.openFind();
          }
        }}
        aria-labelledby={titleId}
        TransitionProps={{
          onEntered: () => {
            entered.current = true;
            // 문서는 실제 스크롤 상자로(바깥 본문은 overflow hidden 이라 PageDown 이 안 움직인다, 005 OV2-M1)
            (small ? primaryRef.current : (bodyRef.current?.querySelector<HTMLElement>('[data-doc-scroll]') ?? bodyRef.current))?.focus();
          },
        }}
        PaperProps={{
          sx: {
            bgcolor: tk.popup.surface,
            backgroundImage: 'none',
            border: `1px solid ${tk.popup.edge}`,
            borderRadius: narrow && !small ? 0 : `${chatMetrics.panelRadius}px`,
            ...(small ? { width: '100%', maxWidth: 480 } : narrow ? {} : { width: '90vw', height: '90vh', maxWidth: 'none', maxHeight: 'none' }),
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          },
        }}
      >
        <Box sx={{ px: 2, py: 1, borderBottom: `1px solid ${tk.line}`, minHeight: 56, flexShrink: 0 }}>
          {narrow ? (
            <Stack spacing={0.5}>
              <Stack direction="row" alignItems="center" spacing={1}>
                {nameBlock}
                {closeBtn}
              </Stack>
              <Stack direction="row" alignItems="center" spacing={1}>
                {toggles}
                <Box sx={{ flex: 1 }} />
                {primary}
                {moreBtn}
              </Stack>
            </Stack>
          ) : (
            <Stack direction="row" alignItems="center" spacing={1.5}>
              {nameBlock}
              {toggles}
              {primary}
              {askBtn}
              {copyBtn}
              {moreBtn}
              {closeBtn}
            </Stack>
          )}
          {agentPath && (
            <Collapse in={details} id={detailsId} unmountOnExit>
              <Box component="dl" sx={{ m: 0, mt: 1, fontSize: 12, color: tk.muted, display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 1.5, rowGap: 0.25 }}>
                <dt>{t('chat.viewer.folder')}</dt>
                <Box component="dd" sx={{ m: 0, overflowWrap: 'anywhere' }}>
                  {folder}
                </Box>
                <dt>{t('chat.viewer.agentPath')}</dt>
                <Box component="dd" sx={{ m: 0, overflowWrap: 'anywhere', fontFamily: MONO_FONT }}>
                  {agentPath}
                </Box>
              </Box>
            </Collapse>
          )}
        </Box>
        <Box ref={bodyRef} tabIndex={-1} sx={{ flex: 1, minHeight: small ? 0 : 200, display: 'flex', flexDirection: 'column', overflow: 'hidden', outline: 'none', '&:focus-visible': { outline: `2px solid ${FOCUS_RING}`, outlineOffset: -2 } }}>
          <Suspense fallback={<BodySkeleton kind={kind} />}>
            <FileViewer key={seq} file={file} kind={kind} mode={mode} wrap={wrap} fit={fit} small={small} onSize={setSize} onSmall={() => setSmall(true)} primaryRef={primaryRef} />
          </Suspense>
        </Box>
      </Dialog>
    </>
  );
}

const touch = { '@media (pointer: coarse)': { minWidth: chatMetrics.touch, minHeight: chatMetrics.touch } };

/** 글 안 뱃지의 aria-describedby 대상(DD16) — 화면에 하나 */
function HiddenHint() {
  return (
    <Box component="span" id={INLINE_HINT_ID} sx={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>
      {t('chat.files.inlineHint')}
    </Box>
  );
}
