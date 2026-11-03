/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 좌측 메뉴. COP Console 의 Sidebar 와 같은 규격이다(폭 240px, 접으면 64px, 글자 13px, 선택한 묶음만 펼친다).
// 묶음(대화·운영·구성·자산)이 최상위 항목이고 화면이 그 아래 항목이다. 묶음을 누르면 그 묶음의 첫 화면으로 간다.
// 화면이 하나뿐인 묶음(대시보드)은 펼치지 않고 그 화면으로 바로 가는 한 줄이다(계획 2026-10-14-014 R3).
// 맨 아래 줄에 로고·버전 단추와 메뉴 접기 단추를 둔다(Observ 의 sidebar-footer 와 같은 모양). 메뉴 목록만 스크롤하고 아래 줄은 늘 보인다.
import AdminPanelSettingsOutlinedIcon from '@mui/icons-material/AdminPanelSettingsOutlined';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import DashboardOutlinedIcon from '@mui/icons-material/DashboardOutlined';
import ExtensionOutlinedIcon from '@mui/icons-material/ExtensionOutlined';
import HistoryOutlinedIcon from '@mui/icons-material/HistoryOutlined';
import ScheduleOutlinedIcon from '@mui/icons-material/ScheduleOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import { Box, Collapse, IconButton, List, ListItemButton, Menu, MenuItem, Tooltip, Typography } from '@mui/material';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { t } from '@/i18n';
import type { MenuGroup, Tone } from '@/lib/menu';
import { shellColors, shellMetrics } from '@/lib/shellTokens';
import type { GroupId } from '@/lib/views';

import { VersionButton } from './VersionButton';

// 묶음 아이콘(OMAI-1313): 대시보드 · 대화 · 내 에이전트(로봇) · 스킬(조각) · 자동화(시계) · 기록 · 관리 · 설정
const ICONS: Record<GroupId, typeof DashboardOutlinedIcon> = {
  dashboard: DashboardOutlinedIcon,
  talk: ChatBubbleOutlineIcon,
  agent: SmartToyOutlinedIcon,
  skill: ExtensionOutlinedIcon,
  automation: ScheduleOutlinedIcon,
  records: HistoryOutlinedIcon,
  admin: AdminPanelSettingsOutlinedIcon,
  settings: SettingsOutlinedIcon,
};

const ROW = 40.5;

interface Screen {
  id: string;
  label: string;
  badge?: number;
  tone?: Tone;
  hint?: string;
}

/** 묶음 안의 화면 항목. */
export function screensOf(group: MenuGroup): Screen[] {
  return group.items.map((i) => ({ id: i.id, label: i.label, badge: i.badge, tone: i.tone, hint: i.hint }));
}

function Count({ n, tone, hint }: { n?: number; tone?: Tone; hint?: string }) {
  if (!n) return null;
  const badge = (
    <Box
      component="span"
      aria-label={hint ?? t('sidebar.count', { count: n })}
      sx={{
        ml: 'auto',
        px: 0.75,
        minWidth: 18,
        textAlign: 'center',
        borderRadius: '9px',
        fontSize: 11,
        lineHeight: '18px',
        fontWeight: 500,
        color: '#fff',
        bgcolor: tone === 'bad' ? '#c62828' : tone === 'neutral' ? '#8a8f98' : '#b26a00',
      }}
    >
      {n}
    </Box>
  );
  return hint ? <Tooltip title={hint}>{badge}</Tooltip> : badge;
}

export interface SidebarProps {
  groups: MenuGroup[];
  currentView: string;
  currentGroup: GroupId;
  /** 접힌 상태(아이콘만) */
  collapsed: boolean;
  onNavigate?: () => void;
  /** 아래 줄의 메뉴 접기·펼치기. 주지 않으면(모바일 서랍) 단추를 그리지 않는다 */
  onToggleCollapse?: () => void;
}

export function Sidebar({ groups, currentView, currentGroup, collapsed, onNavigate, onToggleCollapse }: SidebarProps) {
  // 접힌 상태에서는 글자가 없어 하위 화면에 들어갈 수 없다. 묶음 아이콘을 누르면 오른쪽에 화면 목록을 연다.
  const [fly, setFly] = useState<{ el: HTMLElement; group: MenuGroup } | null>(null);
  const closeFly = () => setFly(null);
  return (
    <Box
      component="nav"
      aria-label={t('sidebar.nav')}
      sx={{
        width: collapsed ? shellMetrics.sidebarRailWidth : shellMetrics.sidebarWidth,
        flexShrink: 0,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        bgcolor: shellColors.shellBg,
        color: shellColors.menuText,
        borderRight: `${shellMetrics.shellBorderWidth}px solid ${shellColors.shellBorder}`,
        transition: 'width 150ms cubic-bezier(0.4, 0, 0.6, 1)',
        py: 1,
        px: 0.875,
      }}
    >
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
        <List disablePadding>
          {groups.map((g) => {
            const screens = screensOf(g);
            if (!screens.length) return null;
            const open = g.id === currentGroup;
            const single = screens.length === 1;
            const Icon = ICONS[g.id] ?? SettingsOutlinedIcon;
            const linkProps = single
              ? { component: Link, to: '/' + screens[0].id, onClick: onNavigate, 'aria-label': collapsed ? g.label : undefined }
              : collapsed
              ? {
                  'aria-label': g.label,
                  'aria-haspopup': 'menu' as const,
                  'aria-expanded': fly?.group.id === g.id,
                  onClick: (e: React.MouseEvent<HTMLElement>) => setFly({ el: e.currentTarget, group: g }),
                }
              : { component: Link, to: '/' + screens[0].id, onClick: onNavigate, 'aria-expanded': open };
            const parent = (
              <ListItemButton
                {...linkProps}
                selected={open}
                aria-current={open ? (single ? 'page' : 'true') : undefined}
                sx={itemSx(open, false, collapsed)}
              >
                <Icon sx={{ fontSize: shellMetrics.iconButtonSize, flexShrink: 0 }} />
                {!collapsed && (
                  <>
                    <Typography component="span" sx={{ ml: '14px', fontSize: shellMetrics.menuFontSize, fontWeight: 'inherit' }}>
                      {g.label}
                    </Typography>
                    <Count n={g.badge} tone={g.tone} hint={g.hint} />
                  </>
                )}
              </ListItemButton>
            );
            return (
              <li key={g.id} style={{ listStyle: 'none' }}>
                {collapsed ? (
                  <Tooltip title={g.label} placement="right">
                    {parent}
                  </Tooltip>
                ) : (
                  parent
                )}
                {!collapsed && !single && (
                  <Collapse in={open} timeout={150} unmountOnExit>
                    <List disablePadding sx={{ ml: '34px' }}>
                      {screens.map((s) => {
                        const on = s.id === currentView;
                        return (
                          <li key={s.id} style={{ listStyle: 'none' }}>
                            <ListItemButton
                              component={Link}
                              to={'/' + s.id}
                              onClick={onNavigate}
                              selected={on}
                              aria-current={on ? 'page' : undefined}
                              sx={itemSx(on, true, false)}
                            >
                              <Typography component="span" sx={{ fontSize: shellMetrics.menuFontSize, fontWeight: 'inherit' }}>
                                {s.label}
                              </Typography>
                              <Count n={s.badge} tone={s.tone} hint={s.hint} />
                            </ListItemButton>
                          </li>
                        );
                      })}
                    </List>
                  </Collapse>
                )}
              </li>
            );
          })}
        </List>
      </Box>
      {/* 아래 줄: Observ 와 같이 셸보다 한 단계 어두운 띠(shellUserBg)에 펼침은 가로(버전 · 접기), 접힘은 세로(로고 위·펼치기 아래) */}
      <Box
        sx={{
          flexShrink: 0,
          mt: 1,
          mx: -0.875,
          mb: -1,
          px: '10px',
          py: 1,
          bgcolor: shellColors.shellUserBg,
          display: 'flex',
          flexDirection: collapsed ? 'column' : 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: collapsed ? 1 : 0.5,
        }}
      >
        <VersionButton collapsed={collapsed} />
        {onToggleCollapse && <CollapseButton collapsed={collapsed} onClick={onToggleCollapse} />}
      </Box>
      <Menu
        anchorEl={fly?.el}
        open={!!fly}
        onClose={closeFly}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{
          paper: {
            sx: {
              ml: 0.5,
              minWidth: 180,
              bgcolor: '#191a1b',
              color: shellColors.menuText,
              backgroundImage: 'none',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '8px',
            },
          },
        }}
      >
        {fly && (
          <Typography
            component="div"
            sx={{ px: 2, py: 0.75, fontSize: 12, color: 'rgba(255,255,255,0.5)' }}
            aria-hidden
          >
            {fly.group.label}
          </Typography>
        )}
        {fly &&
          screensOf(fly.group).map((sc) => (
            <MenuItem
              key={sc.id}
              component={Link}
              to={'/' + sc.id}
              selected={sc.id === currentView}
              onClick={() => {
                closeFly();
                onNavigate?.();
              }}
              sx={{
                fontSize: shellMetrics.menuFontSize,
                '&.Mui-selected': { bgcolor: shellColors.menuActiveBg, color: shellColors.menuActiveText },
                '&:hover': { bgcolor: shellColors.menuHoverBg },
              }}
            >
              {sc.label}
              <Count n={sc.badge} tone={sc.tone} hint={sc.hint} />
            </MenuItem>
          ))}
      </Menu>
    </Box>
  );
}

/** 메뉴 접기·펼치기 단추. Observ 의 toggle-btn 과 같은 32px 원형, 화살표만 보인다 */
function CollapseButton({ collapsed, onClick }: { collapsed: boolean; onClick: () => void }) {
  const label = collapsed ? t('topbar.expand') : t('topbar.collapse');
  return (
    <Tooltip title={label} placement="right">
      <IconButton
        aria-label={label}
        onClick={onClick}
        sx={{
          flexShrink: 0,
          width: 32,
          height: 32,
          color: shellColors.menuText,
          bgcolor: 'rgba(255, 255, 255, 0.04)',
          '&:hover, &.Mui-focusVisible': { bgcolor: 'rgba(255, 255, 255, 0.07)' },
        }}
      >
        {collapsed ? <ChevronRightIcon /> : <ChevronLeftIcon />}
      </IconButton>
    </Tooltip>
  );
}

/** 항목 한 줄의 스타일. COP 의 ListItemLink 와 같은 값이다. */
function itemSx(selected: boolean, child: boolean, collapsed: boolean) {
  const base = {
    position: 'relative',
    height: ROW,
    minHeight: ROW,
    py: 0,
    pl: child ? 2 : collapsed ? '15px' : '19px',
    pr: collapsed ? 0 : 1.5,
    borderRadius: '4px',
    color: shellColors.menuText,
    fontWeight: selected ? shellMetrics.menuActiveFontWeight : shellMetrics.menuFontWeight,
    opacity: child && !selected ? 0.9 : 1,
    '&:hover': { backgroundColor: shellColors.menuHoverBg },
    '&.Mui-selected': { backgroundColor: 'transparent' },
    '&.Mui-focusVisible': { backgroundColor: shellColors.menuHoverBg, outline: `1px solid ${shellColors.menuActiveText}` },
  } as const;
  if (!selected) return base;
  if (child) {
    return {
      ...base,
      color: shellColors.menuActiveText,
      '&.Mui-selected': { backgroundColor: 'transparent' },
      '&.Mui-selected:hover': { backgroundColor: shellColors.menuHoverBg },
      '&::before': {
        content: "''",
        position: 'absolute',
        left: 4,
        top: 7,
        bottom: 7,
        width: 4,
        borderRadius: '4px',
        background: shellColors.menuActiveText,
      },
    };
  }
  return {
    ...base,
    color: shellColors.menuActiveText,
    boxShadow: `inset ${shellMetrics.menuActiveAccentWidth}px 0 0 0 ${shellColors.menuActiveAccent}`,
    '&.Mui-selected': { backgroundColor: shellColors.menuActiveBg },
    '&.Mui-selected:hover': { backgroundColor: shellColors.menuActiveBg },
  };
}
