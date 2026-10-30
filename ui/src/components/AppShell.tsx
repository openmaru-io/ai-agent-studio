/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import { Box, Drawer, useMediaQuery } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { useInbox } from '@/features/office/useInbox';
import { t } from '@/i18n';
import { startActivity } from '@/lib/activity';
import { viewerAgentLabel } from '@/lib/agentLabel';
import { openChat } from '@/lib/chatPopup';
import { chatStore, useChat } from '@/lib/chatStore';
import { isAdmin, useAgents, useCreds, useHealth, useMe } from '@/lib/data';
import { fmtTs } from '@/lib/format';
import { requestGuideFocus, setHelpOpener, startGuide } from '@/lib/guideRun';
import { GUIDES } from '@/lib/guides';
import { guideSub, guideTitle } from '@/lib/guideText';
import { buildMenus } from '@/lib/menu';
import { reloadAtView, switchPod } from '@/lib/pod';
import { FOCUS_RING, shellColors, shellMetrics } from '@/lib/shellTokens';
import { useNotices } from '@/lib/useNotices';
import { viewById, viewVisible } from '@/lib/views';
import { wsClient } from '@/lib/ws';
import { AccountDrawer } from '@/screens/account/AccountDrawer';

import { AccountMenu } from './AccountMenu';
import { AgentSwitch } from './AgentSwitch';
import { ChatMascot } from './ChatMascot';
import { ChatPopup } from './ChatPopup';
import { CommandPalette } from './CommandPalette';
import { DrawerHost } from './DrawerHost';
import { LazyFileViewer } from './files/LazyFileViewer';
import { GuideRunner } from './help/GuideRunner';
import { HelpDrawer, HelpTab } from './help/HelpDrawer';
import { LinkPodSwitch } from './LinkPodSwitch';
import { NoticeBar, NoticeList, NoticeLive } from './NoticeBar';
import { PodRestarting } from './PodRestarting';
import { RoomChatPopup } from './RoomChatPopup';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { useUi } from './UiContext';
import { useShortcuts } from './useShortcuts';
import { useTeamManagerNotice } from './useTeamManagerNotice';
import { WsStatus } from './WsStatus';

const SIDEBAR_KEY = 'aas-sidebar';

function skipToMain() {
  const main = document.getElementById('main');
  if (!main) return;
  main.setAttribute('data-skipped', '');
  main.addEventListener('blur', () => main.removeAttribute('data-skipped'), { once: true });
  main.focus();
}

/** 포커스를 받을 때만 화면 왼쪽 위에 보이는 단추. 셸처럼 어두운 면이라 포커스 링은 흰색이다 */
const skipSx = {
  position: 'absolute',
  left: 8,
  top: 8,
  zIndex: 2000,
  px: 1.5,
  py: 0.75,
  font: 'inherit',
  fontSize: 13,
  cursor: 'pointer',
  color: shellColors.menuActiveText,
  bgcolor: shellColors.shellBg,
  border: '1px solid rgba(255, 255, 255, 0.24)',
  borderRadius: '6px',
  transform: 'translateY(-200%)',
  '&:focus-visible': { transform: 'none', outline: `2px solid ${shellColors.menuActiveText}`, outlineOffset: 1 },
} as const;

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === 'closed';
  } catch {
    return false;
  }
}

export function AppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const loc = useLocation();
  const qc = useQueryClient();
  const ui = useUi();
  const { enqueueSnackbar } = useSnackbar();
  const me = useMe();
  useEffect(() => wsClient.configure(!!me.data?.ws, me.data?.pod?.id), [me.data?.ws, me.data?.pod?.id]); // 서버가 켰을 때만 웹소켓으로 받는다
  useEffect(() => (me.data?.auth_enabled ? startActivity() : undefined), [me.data?.auth_enabled]); // 조작할 때만 로그인을 연장한다(OMAI-1112)
  // 주 프로파일(main) 준비가 끝나면 프로파일을 쓰는 목록(채팅·스킬 허브·프로파일)을 다시 받아 main 이 저절로 나타나게 한다(2026-10-19-001 디자인 D8)
  const primaryReady = me.data?.primary?.ready;
  const wasPreparing = useRef(false);
  useEffect(() => {
    if (primaryReady === false) wasPreparing.current = true;
    else if (primaryReady && wasPreparing.current) {
      wasPreparing.current = false;
      void qc.invalidateQueries({ predicate: (q) => ['agents', 'profiles', 'hermes-agents'].includes(String(q.queryKey[0])) });
      void chatStore.refresh();
    }
  }, [primaryReady, qc]);
  useTeamManagerNotice(me.data?.team_manager_since, me.data?.department); // 처음 지정된 팀 관리자 안내 한 번(2026-10-22-001 DD9)
  const health = useHealth();
  const creds = useCreds();
  const agents = useAgents();
  const chat = useChat(chatStore);
  const waiting = chat.waiting();
  const inbox = useInbox();
  const adminRequests = inbox.items.filter((i) => i.kind === 'admin_request').length;     // 관리자에게 온 처리 대기 요청(스펙 2026-10-15-011 단계 5)
  const [acct, setAcct] = useState<HTMLElement | null>(null);
  const theme = useTheme();
  const small = useMediaQuery(theme.breakpoints.down('sm'));
  // 1200px 이상이면 상단 막대 고르개, 미만이면 계정 메뉴의 「에이전트」 묶음. 한 값으로 둘을 함께 정해 경계에서 둘 다 있거나 없지 않다(스펙 2026-10-19-019 R5·O4)
  const wide = useMediaQuery(theme.breakpoints.up('lg'));
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);
  const toggleSidebar = useCallback(() => {
    if (small) return setMobileOpen((v) => !v);
    setCollapsed((cur) => {
      try {
        localStorage.setItem(SIDEBAR_KEY, cur ? 'open' : 'closed');
      } catch {
        /* 저장소를 못 쓰면 이번 방문에서만 바뀐다 */
      }
      return !cur;
    });
  }, [small]);

  const viewId = loc.pathname.split('/').filter(Boolean)[0] ?? 'dashboard';
  const view = viewById(viewId) ?? viewById('dashboard')!;
  // 화면(첫 경로 조각)이 바뀌면 주소에 묶이지 않은 서랍은 치운다(OMAI-1284). 스킬 서랍처럼 openDrawer 로 연 서랍은 주소에 값이 없어 스스로 닫히지
  // 않고, 메뉴·팔레트·뒤로 가기로 다른 화면에 가도 그 위에 남았다. 주소에 묶인 서랍(useRouteDrawer)은 화면이 내려갈 때 스스로 닫고,
  // keep 서랍(도움말)은 화면을 옮겨도 계속 본다. 같은 화면 안에서 주소 값만 바뀌면(필터·탭) 그대로 둔다.
  const dismissTransient = ui.dismissTransient;
  const lastViewId = useRef(viewId);
  useEffect(() => {
    if (lastViewId.current === viewId) return;
    lastViewId.current = viewId;
    dismissTransient();
  }, [viewId, dismissTransient]);
  const who = useMemo(() => ({ admin: isAdmin(me.data), owner: !!me.data?.owner, teamManager: !!me.data?.team_manager }), [me.data]);
  const groups = useMemo(
    () =>
      buildMenus({
        health: health.data,
        creds: creds.data,
        waiting,
        admin: isAdmin(me.data),
        owner: !!me.data?.owner,
        teamManager: !!me.data?.team_manager,
        // 「내 에이전트 변경 기록」 부제. 본인 것이라 주인 이름은 붙이지 않는다(스펙 2026-10-19-003 D1). 팀 관리자는 남의 것이라 「주인 · 에이전트」(DD8)
        pod: me.data?.team_manager && me.data.pod ? viewerAgentLabel(me.data.pod, me.data.user?.email) : me.data?.pod?.name || me.data?.pod?.id,
        adminRequests,
        marketUpdates: me.data?.market_updates ?? 0,
        connectionsExpiring: me.data?.connections?.expiring ?? 0,
      }),
    [health.data, creds.data, waiting, me.data, adminRequests]
  );

  const paletteAgents = useMemo(
    () => [
      // 프로파일이 하나뿐이면 프로파일 이름(main) 대신 에이전트 이름(2026-10-19-013 R5·DC2). 이름이 없으면 지금처럼
      ...(agents.data ?? []).map((a) => {
        const one = (agents.data ?? []).length === 1 && !!me.data?.pod?.name;
        return {
          group: t('shell.agents'),
          label: one ? (me.data?.pod?.name as string) : a.title || a.name,
          hint: (!one && a.title ? a.name + ' · ' : '') + t('shell.chatWith'),
          run: () => openChat({ kind: 'chat', agent: a.name }), // 화면을 떠나지 않고 대화 팝업으로 연다(OMAI-1115)
        };
      }),
      // 가이드도 찾아 바로 시작한다(OMAI-1274 §4-2 (라)). 관리자 가이드는 관리자에게만
      ...GUIDES.filter((g) => who.admin || g.audience === 'user').map((g) => ({
        group: t('guides.paletteGroup'),
        label: guideTitle(g),
        hint: guideSub(g),
        run: () => startGuide(g.id),
      })),
    ],
    [agents.data, who.admin, me.data?.pod?.name]
  );
  // 도움말 서랍(OMAI-1274). `?` 키·계정 메뉴 「단축키」는 「단축키」 탭으로 연다. 다른 서랍 위에 쌓아 보던 서랍이 바뀌지 않게 한다(keep)
  const openHelp = (tab?: HelpTab) =>
    ui.openDrawer({
      id: 'help',
      keep: true,
      icon: HelpOutlineIcon,
      title: t('guides.help'),
      body: (
        <HelpDrawer
          who={who}
          initialTab={tab}
          onStart={(id) => {
            ui.dismissDrawer('help');
            startGuide(id);
          }}
        />
      ),
    });
  const showHelp = () => openHelp('shortcuts');
  // 본문 제목 옆 「이 화면 도움말」이 부른다(PageTitle). 자식 화면보다 먼저 그려지는 이 자리에서 등록한다:
  // effect 에서 등록하면 제목이 맨 h1 으로 한 번 그려진 뒤 단추 줄로 다시 만들어진다. 셸이 사라지면 뗀다
  const openHelpRef = useRef(openHelp);
  openHelpRef.current = openHelp;
  setHelpOpener(openHelpFromTitle);
  useEffect(() => () => setHelpOpener(null), []);
  function openHelpFromTitle() {
    openHelpRef.current();
  }
  const [reloading, setReloading] = useState(false);
  const reload = async () => {
    setReloading(true);
    try {
      await qc.invalidateQueries();
      enqueueSnackbar(t('shell.reloaded'), { variant: 'success' }); // variant 가 없으면 아이콘 없이 뜬다(OMAI-1205)
    } finally {
      setReloading(false);
    }
  };

  useShortcuts({
    go: (id) => viewVisible(id, who) && navigate('/' + id),
    togglePalette: ui.togglePalette,
    closePalette: ui.closePalette,
    closeDrawer: ui.closeDrawer,
    paletteOpen: () => ui.paletteOpen,
    drawerOpen: () => !!ui.drawer,
    showHelp,
    focusGuide: requestGuideFocus,
  });

  const totals = health.data?.totals;
  // 실패해도 React Query 는 이전 수집 결과를 들고 있어 「마지막 성공」 시각을 보인다(DD8). 일부 실패도 경고 점(DD7)
  const collected = health.isError
    ? health.data
      ? t('shell.collectFailedSince', { at: fmtTs(health.data.collected_at) })
      : t('shell.collectFailed')
    : health.data
    ? t('shell.collected', { at: fmtTs(health.data.collected_at), ok: totals?.profiles_ok, total: totals?.profiles })
    : '';
  const collectWarn = health.isError || (!!totals && (totals.profiles_ok ?? 0) < (totals.profiles ?? 0));
  // 에이전트 바꾸기. 바꾸는 중에는 고르개가 고른 이름과 돌아가는 표시를 보이고(DD4) 다시 읽기도 막는다. 성공하면 그 화면의 목록으로 새로 고친다(DD5)
  const [switching, setSwitching] = useState<string | null>(null);
  const pickPod = async (id: string) => {
    setSwitching(id);
    try {
      await switchPod(id);
      reloadAtView(view.id);
    } catch (e) {
      setSwitching(null);
      enqueueSnackbar(t('shell.switchFailed', { error: (e as Error).message }), { variant: 'error' });
    }
  };
  const m = me.data;
  // 계정 메뉴 「지금 공지 N」(3D). 띠와 같은 훅을 써 닫은 공지 상태를 함께 본다(E7)
  const notices = useNotices();
  const sidebar = (
    <Sidebar
      groups={groups}
      currentView={view.id}
      currentGroup={view.groupId}
      collapsed={!small && collapsed}
      onNavigate={() => setMobileOpen(false)}
      onToggleCollapse={small ? undefined : toggleSidebar}
    />
  );

  return (
    <Box sx={{ height: '100vh', width: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column', bgcolor: 'background.default' }}>
      {/* 본문으로 건너뛰기(6A·E1). 포커스를 받을 때만 보인다. HashRouter 라 href="#main" 은 경로를 바꾸므로 단추로 #main 에 포커스를 옮긴다 */}
      <Box component="button" type="button" onClick={skipToMain} sx={skipSx}>
        {t('shell.skipToMain')}
      </Box>
      {/* 공지 띠(스펙 공지 바 4-5). 상단 막대 앞, 화면 폭 전체라 왼쪽 메뉴도 함께 밀린다. 공지가 없으면 그리지 않는다 */}
      <NoticeBar />
      <Topbar
        collapsed={collapsed}
        onToggleSidebar={toggleSidebar}
        onSearch={ui.openPalette}
        collected={collected}
        collectWarn={collectWarn}
        collectFailed={health.isError}
        onReload={() => void reload()}
        reloading={reloading || !!switching}
        agentSwitch={
          wide && m ? (
            <AgentSwitch pods={m.pods ?? []} pod={m.pod} viewerEmail={m.user?.email} registryError={m.registry_error} pendingId={switching} onPick={(id) => void pickPod(id)} />
          ) : undefined
        }
        account={m?.user ? m.user.name || m.user.email.split('@')[0] : t('shell.settings')}
        accountOpen={!!acct}
        onAccount={setAcct}
        onHelp={() => openHelp()}
      />
      <AccountMenu
        anchorEl={acct}
        onClose={() => setAcct(null)}
        me={m}
        showUsers={!!(m?.admin || !m?.auth_enabled)}
        onProfile={() => ui.openDrawer({ title: t('account.title'), body: <AccountDrawer /> })}
        onUsers={() => navigate('/users')}
        notices={notices.all?.length ?? 0}
        onNotices={() => ui.openDrawer({ title: t('notice.listTitle'), body: <NoticeList /> })}
        onShortcuts={showHelp}
        onHelp={small ? () => openHelp() : undefined}
        showAgents={!wide}
        onPod={(id) => void pickPod(id)}
      />
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {small ? (
          <Drawer open={mobileOpen} onClose={() => setMobileOpen(false)} PaperProps={{ sx: { width: shellMetrics.sidebarWidth } }}>
            {sidebar}
          </Drawer>
        ) : (
          sidebar
        )}
        {/* 연결 상태 띠는 본문 위에만 둔다. 화면 폭 전체에 두면 왼쪽 메뉴가 띠 높이만큼 밀린다.
            공지 띠(NoticeBar)는 일부러 상단 막대 앞, 화면 폭 전체에 둔다 — 모든 사람에게 알리는 셸의 일부다(스펙 공지 바 4-5, 외부 검토 O11) */}
        <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <WsStatus />
          <PodRestarting pod={me.data?.pod} />
          <LinkPodSwitch me={me.data} />
          {/* tabIndex -1 이라 빈 곳을 누르면 포커스를 받는다. 그 뒤 Esc 등 키를 누르면 Chrome 이 :focus-visible 로 바꿔 본문 전체에 외곽선을 그리므로 끈다 */}
          {/* 「본문으로 건너뛰기」로 왔을 때만(data-skipped) 테두리를 보인다 */}
          <Box
            component="main"
            id="main"
            tabIndex={-1}
            sx={{ flex: 1, minHeight: 0, overflow: 'auto', p: 2.5, outline: 'none', '&[data-skipped]:focus-visible': { outline: `2px solid ${FOCUS_RING}`, outlineOffset: -2 } }}
          >
            {children}
          </Box>
        </Box>
      </Box>
      <DrawerHost />
      <NoticeLive />
      <LazyFileViewer />
      <ChatPopup />
      <RoomChatPopup />
      <ChatMascot />
      <GuideRunner who={who} mainLeft={small ? 0 : collapsed ? shellMetrics.sidebarRailWidth : shellMetrics.sidebarWidth} />
      <CommandPalette extra={paletteAgents} who={who} />
    </Box>
  );
}
