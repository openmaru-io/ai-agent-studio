/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 위젯 화면(OMAI-1873): 떠 있는 캐릭터 단추 + 창(끌기·크기 조절·최대화, 폭 600px 미만은 전체 화면). 창 안은 채팅 화면의
// Conversation 을 compact 로 그대로 쓴다. 호스트에는 AAS 라우터가 없으므로 MemoryRouter 로 감싸고, 앱 셸이 주던 공급자를 여기 둔다.
import { CacheProvider, type EmotionCache } from '@emotion/react';
import CloseIcon from '@mui/icons-material/Close';
import CloseFullscreenIcon from '@mui/icons-material/CloseFullscreen';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import { Alert, Box, Button, Chip, Dialog, DialogContent, DialogTitle, GlobalStyles, IconButton, LinearProgress, Menu, MenuItem, ScopedCssBaseline, Tooltip, Typography } from '@mui/material';
import { createTheme, type Theme,ThemeProvider } from '@mui/material/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SnackbarProvider } from 'notistack';
import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { MemoryRouter } from 'react-router-dom';

import mascotUrl from '@/assets/mascot/cogentai-chat.png';
import { toastComponents } from '@/components/AppToast';
import { SaveAnswerPanel } from '@/components/chat/SaveAnswerFormat';
import { ConfirmProvider } from '@/components/ConfirmDialog';
import { I18nProvider, useI18n } from '@/components/I18n';
import { UiProvider } from '@/components/UiContext';
import { type Lang,t } from '@/i18n';
import { appHref } from '@/lib/api';
import { chatStore, groupLabel, useChat } from '@/lib/chatStore';
import { EmbedContext } from '@/lib/embedContext';
import { SELECTION_MAX } from '@/lib/pageContext';
import { focusRingColor } from '@/lib/shellTokens';
import { Conversation } from '@/screens/Chat';
import { PastBody } from '@/screens/chat/parts';
import { makeTheme } from '@/theme';

import type { ResolvedConfig } from './config';
import type { EmbedSession } from './session';
import { useWidgetState, type WidgetState, type WidgetStatus, type WidgetStore } from './state';

/** 이 폭 미만이면 창을 화면 전체로 연다(CogentAI 위젯과 같은 규칙) */
export const SMALL_VIEW = 600;
const BUTTON = 90;
const BUTTON_POS_KEY = 'aas-widget-button-pos';
const LOADER = '#B71C1C';

export function widgetTheme(state: Pick<WidgetState, 'config'>, portal: HTMLElement | null): Theme {
  const { theme: mode, fontFamily, primaryColor } = state.config;
  const base = makeTheme(mode);
  return createTheme(base, {
    ...(fontFamily ? { typography: { fontFamily } } : {}),
    ...(primaryColor ? { palette: { primary: { main: primaryColor } } } : {}),
    components: {
      // MUI 의 Menu·Dialog·Tooltip·Popover 는 document.body 로 포털을 띄운다 — 스타일이 든 그림자 안으로 옮긴다(CogentAI themeBuilder 와 같다)
      MuiPopover: { defaultProps: { container: portal } },
      MuiPopper: { defaultProps: { container: portal } },
      MuiModal: { defaultProps: { container: portal } },
    },
  });
}

const STATUS_TEXT: Partial<Record<WidgetStatus, string>> = {
  cert: 'embed.state.cert',
  origin: 'embed.state.origin',
  login: 'embed.state.login',
  auth_config: 'embed.state.authConfig',
  not_user: 'embed.state.notUser',
  idp: 'embed.state.idp',
  no_agent: 'embed.state.noAgent',
  rate_limited: 'embed.state.rateLimited',
  version: 'embed.state.version',
  ws_off: 'embed.state.wsOff',
  connect_check: 'embed.state.connectCheck',
  mixed: 'embed.state.mixed',
};
/** 다시 시도할 수 있는 상태(잠깐 뒤 나아질 수 있다). cert 는 안내 창을 취소한 뒤 다시 띄우는 길이다(OMAI-1873) */
export const RETRY: WidgetStatus[] = ['idp', 'rate_limited', 'connect_check', 'login', 'cert', 'auth_config'];

function LangBridge({ lang }: { lang: Lang | undefined }) {
  const { lang: cur, setLang } = useI18n();
  useEffect(() => {
    if (lang && lang !== cur) setLang(lang);
  }, [lang, cur, setLang]);
  return null;
}

function StatusPanel({ status, session, config, popupLogin }: { status: WidgetStatus; session: EmbedSession; config: ResolvedConfig; popupLogin: boolean }) {
  const [waiting, setWaiting] = useState(false);
  const key = STATUS_TEXT[status];
  if (!key) return null;
  // 호스트가 로그인을 열 수 있거나(OMAI-1908) 서버가 popup_login 을 알렸으면(OMAI-1911) 「로그인」을 먼저 둔다. 누른 클릭 안에서 콜백·팝업을 열어야 막히지 않는다
  const hostLogin = typeof config.onLoginRequired === 'function';
  const canLogin = status === 'login' && (hostLogin || popupLogin);
  return (
    <Box role="status" data-testid={`aas-widget-status-${status}`} sx={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1.5, p: 3, textAlign: 'center' }}>
      <Typography sx={{ fontSize: 14 }}>{t(status === 'login' && !hostLogin && popupLogin ? 'embed.state.loginPopup' : key)}</Typography>
      {(canLogin || RETRY.includes(status)) && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 1 }}>
          {canLogin && (
            <Button
              size="small"
              variant="contained"
              disabled={waiting}
              data-testid="aas-widget-login"
              onClick={() => {
                setWaiting(true);
                void session.login().finally(() => setWaiting(false));
              }}
            >
              {t('embed.login')}
            </Button>
          )}
          {RETRY.includes(status) && (
            <Button size="small" variant="outlined" color="inherit" onClick={() => void session.connect()}>
              {t('embed.retry')}
            </Button>
          )}
        </Box>
      )}
      {canLogin && waiting && <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>{t('embed.loginWaiting')}</Typography>}
      {status === 'no_agent' && (
        <Button size="small" variant="outlined" color="inherit" component="a" href={`${config.backendUrl}/`} target="_blank" rel="noopener">
          {t('embed.openAas')}
        </Button>
      )}
    </Box>
  );
}

function AgentPick({ session, anchor, onClose }: { session: EmbedSession; anchor: HTMLElement | null; onClose: () => void }) {
  const store = useChat(chatStore);
  return (
    <Menu anchorEl={anchor} open={!!anchor} onClose={onClose}>
      {store.groups.map((g) => (
        <MenuItem
          key={g.pod ?? ''}
          selected={g.pod === store.status?.pod}
          onClick={() => {
            onClose();
            if (g.pod) void session.pickAgent(g.pod);
          }}
        >
          {groupLabel(g)}
        </MenuItem>
      ))}
    </Menu>
  );
}

function ChatBody({ session, epoch }: { session: EmbedSession; epoch: number }) {
  const store = useChat(chatStore);
  const [past, setPast] = useState(false);
  const [pick, setPick] = useState<HTMLElement | null>(null);
  const head = useRef<HTMLDivElement>(null);
  const multi = store.groups.length > 1;
  return (
    <Box ref={head} sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {multi && (
        <Box sx={{ px: 1.5, py: 0.5, borderBottom: 1, borderColor: 'divider' }}>
          <Button size="small" color="inherit" endIcon={<ExpandMoreIcon />} aria-haspopup="menu" aria-label={t('embed.pickAgent')} onClick={(e) => setPick(e.currentTarget)}>
            {groupLabel(store.status)}
          </Button>
        </Box>
      )}
      <Box sx={{ flex: 1, minHeight: 0 }}>
        <Conversation
          key={epoch}
          store={store}
          compact
          onPanel={(p) => (p === 'past' ? setPast(true) : window.open(appHref('/chat'), '_blank', 'noopener'))}
          onPickAgent={multi ? () => setPick(head.current) : () => void session.openAgent(store.status?.pod)}
        />
      </Box>
      <AgentPick session={session} anchor={pick} onClose={() => setPick(null)} />
      <Dialog open={past} onClose={() => setPast(false)} fullWidth maxWidth="sm">
        <DialogTitle>{t('chat.pastTitle')}</DialogTitle>
        <DialogContent>{past && <PastBody store={store} profile={store.profile} onPicked={() => setPast(false)} />}</DialogContent>
      </Dialog>
    </Box>
  );
}

type Rect = { left: number; top: number; width: number; height: number };

const px = (v: string, fallback: number, total: number) => {
  const m = /^(\d+(?:\.\d+)?)(px|%|vw|vh)?$/.exec(v.trim());
  if (!m) return fallback;
  const n = Number(m[1]);
  return m[2] === '%' || m[2] === 'vw' || m[2] === 'vh' ? (n / 100) * total : n;
};

/** 호스트가 준 사각형을 화면 안으로 넣는다 */
function fitRect(r: Rect, view: { w: number; h: number }): Rect {
  const width = Math.max(320, Math.min(r.width, view.w));
  const height = Math.max(360, Math.min(r.height, view.h));
  return { width, height, left: Math.max(0, Math.min(r.left, view.w - width)), top: Math.max(0, Math.min(r.top, view.h - height)) };
}

function initialRect(state: WidgetState, view: { w: number; h: number }): Rect {
  if (state.openRect) return fitRect(state.openRect, view); // open({rect}) 가 position 보다 앞선다(D17)
  const c = state.config;
  const width = Math.min(state.size?.width ?? px(c.width, 620, view.w), view.w - 32);
  const height = Math.min(state.size?.height ?? px(c.height, 800, view.h), view.h - 32);
  const left = c.position.endsWith('left') ? 20 : view.w - width - 20;
  const top = c.position.startsWith('top') ? 20 : view.h - height - 20;
  return { left: Math.max(0, left), top: Math.max(0, top), width, height };
}

function readButtonPos(): { x: number; y: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(BUTTON_POS_KEY) || 'null');
    return Number.isFinite(v?.x) && Number.isFinite(v?.y) ? v : null;
  } catch {
    return null;
  }
}

/** 떠 있는 캐릭터 단추. 5px 넘게 움직이면 끌기, 아니면 누름(CogentAI floatingButton 과 같다). 옮긴 자리는 이 브라우저에 기억한다 */
function FloatingButton({ state, onToggle }: { state: WidgetState; onToggle: () => void }) {
  const [pos, setPos] = useState(readButtonPos);
  const drag = useRef<{ dx: number; dy: number; sx: number; sy: number; moved: boolean } | null>(null);
  const corner = state.config.position;
  const place = pos
    ? { left: pos.x, top: pos.y }
    : { [corner.endsWith('left') ? 'left' : 'right']: 20, [corner.startsWith('top') ? 'top' : 'bottom']: corner.startsWith('top') ? 20 : 90 };
  const down = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top, sx: e.clientX, sy: e.clientY, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const move = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || !state.config.draggable) return;
    if (!d.moved && Math.abs(e.clientX - d.sx) <= 5 && Math.abs(e.clientY - d.sy) <= 5) return;
    d.moved = true;
    setPos({ x: Math.max(0, Math.min(e.clientX - d.dx, window.innerWidth - BUTTON)), y: Math.max(0, Math.min(e.clientY - d.dy, window.innerHeight - BUTTON)) });
  };
  const up = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (!d.moved) return onToggle();
    try {
      localStorage.setItem(BUTTON_POS_KEY, JSON.stringify(pos));
    } catch {
      /* 저장소를 못 쓰면 이번 방문 동안만 기억한다 */
    }
  };
  if (state.open || !state.config.showLauncher) return null; // showLauncher:false 면 호스트 단추가 연다(A1b, D5)
  return (
    <Box
      component="button"
      type="button"
      aria-label={t('embed.open')}
      data-testid="aas-widget-button"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onKeyDown={(e: React.KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle();
        }
      }}
      sx={{
        position: 'fixed',
        ...place,
        width: BUTTON,
        height: BUTTON,
        p: 0,
        border: 'none',
        borderRadius: '50%',
        background: 'transparent',
        cursor: 'pointer',
        touchAction: 'none',
        zIndex: 1,
        '&:focus-visible': { outline: `2px solid ${focusRingColor[state.config.theme]}`, outlineOffset: 2 },
      }}
    >
      <Box component="img" src={mascotUrl} alt="" draggable={false} sx={{ width: '100%', height: '100%', pointerEvents: 'none', userSelect: 'none' }} />
    </Box>
  );
}

/** 입력 칸 위 페이지 맥락 칩(A1). 지우기는 그 페이지에만 적용하고 「다시 붙이기」로 푼다 */
export function ContextChips({ store }: { store: WidgetStore }) {
  const s = useWidgetState(store);
  const c = s.context;
  if (!c) return null;
  if (s.contextOff === c.pageId)
    return (
      <Box sx={{ px: 1.5, pt: 0.5 }}>
        <Button size="small" color="inherit" data-testid="aas-context-readd" onClick={() => store.set({ contextOff: null, contextSent: null })}>
          {t('embed.context.readd')}
        </Button>
      </Box>
    );
  return (
    <Box role="group" aria-label={t('embed.context.label')} data-testid="aas-context-chips" sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, px: 1.5, pt: 0.5 }}>
      <Tooltip title={`${c.title} — ${c.url}`}>
        <Chip
          size="small"
          variant="outlined"
          label={t('embed.context.page', { title: c.title })}
          onDelete={() => store.set({ contextOff: c.pageId })}
          deleteIcon={<CloseIcon aria-label={t('embed.context.remove')} />}
          sx={{ maxWidth: '100%', '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' } }}
        />
      </Tooltip>
      {c.selection && (
        <Chip size="small" variant="outlined" data-testid="aas-context-selection" label={s.contextTruncated ? t('embed.context.truncated', { n: SELECTION_MAX.toLocaleString() }) : t('embed.context.selection', { n: c.selection.length })} />
      )}
    </Box>
  );
}

function WidgetWindow({ state, store, session, panelRef }: { state: WidgetState; store: WidgetStore; session: EmbedSession; panelRef: (el: HTMLDivElement | null) => void }) {
  const c = state.config;
  const { lang } = useI18n();
  const box = useRef<HTMLDivElement | null>(null);
  const view = () => ({ w: window.innerWidth, h: window.innerHeight });
  const [small, setSmall] = useState(() => view().w < SMALL_VIEW);
  const [rect, setRect] = useState<Rect>(() => initialRect(state, view()));
  const act = useRef<{ kind: 'move' | 'size'; x: number; y: number; r: Rect } | null>(null);
  useEffect(() => {
    const on = () => {
      setSmall(view().w < SMALL_VIEW);
      setRect((r) => ({ ...r, left: Math.max(0, Math.min(r.left, view().w - 80)), top: Math.max(0, Math.min(r.top, view().h - 40)) }));
    };
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  // 호스트가 resizeEvent 로 크기를 정했다
  useEffect(() => {
    if (state.size) setRect((r) => ({ ...r, ...state.size! }));
  }, [state.size]);
  // 호스트가 open({rect}) 로 자리를 정했다(D15: 묻기 창과 같은 자리·크기)
  useEffect(() => {
    if (state.openRect) setRect(fitRect(state.openRect, view()));
  }, [state.openRect]);
  // focus(): 입력 칸에 초점을 둔다. 연결 전이면 창 자체에 둔다
  useEffect(() => {
    if (!state.focusTick) return;
    requestAnimationFrame(() => {
      const el = box.current?.querySelector<HTMLElement>('[data-guide="chat.composer"] textarea:not([aria-hidden])') ?? box.current;
      el?.focus();
    });
  }, [state.focusTick]);
  const full = small || state.maximized;
  const start = (kind: 'move' | 'size') => (e: ReactPointerEvent<HTMLElement>) => {
    if (full || (kind === 'move' && !c.draggable) || (kind === 'size' && !c.resizable)) return;
    if (kind === 'move' && (e.target as HTMLElement).closest('button')) return; // 머리줄 단추는 끌기가 아니다
    act.current = { kind, x: e.clientX, y: e.clientY, r: rect };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  const move = (e: ReactPointerEvent<HTMLElement>) => {
    const a = act.current;
    if (!a) return;
    const dx = e.clientX - a.x;
    const dy = e.clientY - a.y;
    const v = view();
    if (a.kind === 'move') setRect({ ...a.r, left: Math.max(0, Math.min(a.r.left + dx, v.w - 80)), top: Math.max(0, Math.min(a.r.top + dy, v.h - 40)) });
    else setRect({ ...a.r, width: Math.max(320, Math.min(a.r.width + dx, v.w - a.r.left)), height: Math.max(360, Math.min(a.r.height + dy, v.h - a.r.top)) });
  };
  const end = () => {
    act.current = null;
  };
  const radius = full ? 0 : c.borderRadius;
  return (
    <Box
      ref={(el: HTMLDivElement | null) => {
        box.current = el;
        panelRef(el);
      }}
      tabIndex={-1}
      role="dialog"
      aria-label={c.title}
      data-testid="aas-widget-window"
      sx={{
        position: 'fixed',
        display: state.open ? 'flex' : 'none', // 닫아도 내리지 않는다 — 답을 받는 중인 대화가 이어진다
        flexDirection: 'column',
        ...(full ? { inset: 0, width: '100vw', height: '100dvh' } : { left: rect.left, top: rect.top, width: rect.width, height: rect.height }),
        bgcolor: 'background.default',
        color: 'text.primary',
        borderRadius: radius,
        border: full ? 'none' : 1,
        borderColor: 'divider',
        boxShadow: full ? 'none' : '0 12px 48px rgba(0,0,0,.25)',
        overflow: 'hidden',
        zIndex: 2,
      }}
    >
      <Box
        onPointerDown={start('move')}
        onPointerMove={move}
        onPointerUp={end}
        sx={{ display: 'flex', alignItems: 'center', gap: 0.5, px: 1.5, minHeight: 40, borderBottom: 1, borderColor: 'divider', cursor: full || !c.draggable ? 'default' : 'move', userSelect: 'none', touchAction: 'none' }}
      >
        <Typography component="h2" noWrap sx={{ flex: 1, fontSize: 14, fontWeight: 700 }}>
          {c.title}
        </Typography>
        {c.headerAction && (
          <Button size="small" color="inherit" data-testid="aas-widget-header-action" onClick={() => c.headerAction?.onClick()} sx={{ flexShrink: 0 }}>
            {lang === 'en' ? c.headerAction.label.en : c.headerAction.label.ko}
          </Button>
        )}
        {c.maximizable && !small && (
          <Tooltip title={state.maximized ? t('embed.restore') : t('embed.maximize')}>
            <IconButton size="small" aria-label={state.maximized ? t('embed.restore') : t('embed.maximize')} onClick={() => store.set({ maximized: !state.maximized })}>
              {state.maximized ? <CloseFullscreenIcon fontSize="small" /> : <OpenInFullIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
        )}
        <Tooltip title={t('embed.close')}>
          <IconButton size="small" aria-label={t('embed.close')} onClick={() => store.set({ open: false })}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
      {state.status === 'connecting' && (
        <LinearProgress aria-label={t('embed.state.connecting')} sx={{ height: '1px', bgcolor: 'transparent', '& .MuiLinearProgress-bar': { bgcolor: LOADER } }} />
      )}
      {state.notice && (
        <Alert
          severity={state.notice === 'rateLimited' ? 'warning' : 'info'}
          onClose={() => store.set({ notice: '' })}
          slotProps={{ closeButton: { 'aria-label': t('embed.dismiss') } }}
          sx={{ borderRadius: 0, py: 0 }}
        >
          {t(state.notice === 'rateLimited' ? 'embed.state.rateLimited' : 'embed.state.userChanged')}
        </Alert>
      )}
      {state.status === 'ready' && <SaveAnswerPanel store={store} />}
      {state.status === 'ready' ? (
        <ChatBody session={session} epoch={state.epoch} />
      ) : (
        <StatusPanel status={state.status} session={session} config={c} popupLogin={state.popupLogin} />
      )}
      {c.resizable && !full && (
        <Box
          aria-label={t('embed.resize')}
          onPointerDown={start('size')}
          onPointerMove={move}
          onPointerUp={end}
          sx={{ position: 'absolute', right: 0, bottom: 0, width: 16, height: 16, cursor: 'nwse-resize', touchAction: 'none', zIndex: 3 }}
        />
      )}
    </Box>
  );
}

export function EmbedRoot({
  store,
  session,
  cache,
  portal,
  certBox,
  queryClient,
}: {
  store: WidgetStore;
  session: EmbedSession;
  cache: EmotionCache;
  portal: HTMLElement;
  certBox: (el: HTMLDivElement | null) => void;
  queryClient: QueryClient;
}) {
  const state = useWidgetState(store);
  const theme = useMemo(() => widgetTheme(state, portal), [state.config.theme, state.config.fontFamily, state.config.primaryColor, portal]); // eslint-disable-line react-hooks/exhaustive-deps
  const embed = useMemo(() => ({ backendUrl: state.config.backendUrl, composerTop: <ContextChips store={store} />, widgetStore: store }), [state.config.backendUrl, store]);
  return (
    <CacheProvider value={cache}>
      <ThemeProvider theme={theme}>
        <GlobalStyles styles={{ ':host': { '--aas-focus-ring': focusRingColor[state.config.theme] } }} />
        <QueryClientProvider client={queryClient}>
          <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <EmbedContext.Provider value={embed}>
              <SnackbarProvider maxSnack={3} autoHideDuration={4000} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }} Components={toastComponents}>
                <I18nProvider>
                  <LangBridge lang={state.lang} />
                  <UiProvider>
                    <ConfirmProvider>
                      <ScopedCssBaseline enableColorScheme sx={{ bgcolor: 'transparent' }}>
                        <FloatingButton state={state} onToggle={() => store.set({ open: !store.get().open })} />
                        <WidgetWindow state={state} store={store} session={session} panelRef={certBox} />
                      </ScopedCssBaseline>
                    </ConfirmProvider>
                  </UiProvider>
                </I18nProvider>
              </SnackbarProvider>
            </EmbedContext.Provider>
          </MemoryRouter>
        </QueryClientProvider>
      </ThemeProvider>
    </CacheProvider>
  );
}

