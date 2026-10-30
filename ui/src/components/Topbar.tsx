/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 상단 막대. COP Console 의 TopBar 와 같은 구성이다: 왼쪽 로고, 가운데 검색과 AI 단추, 오른쪽 아이콘(사이드바 접기, 다크·라이트, 전체 화면, 계정).
// 높이 48px, 배경 #0f1011(두 모드 공통), 아이콘 20px.
import AccountCircleOutlinedIcon from '@mui/icons-material/AccountCircleOutlined';
import CheckIcon from '@mui/icons-material/Check';
import DarkModeOutlinedIcon from '@mui/icons-material/DarkModeOutlined';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import LightModeOutlinedIcon from '@mui/icons-material/LightModeOutlined';
import MenuIcon from '@mui/icons-material/Menu';
import RefreshIcon from '@mui/icons-material/Refresh';
import SearchIcon from '@mui/icons-material/Search';
import TranslateIcon from '@mui/icons-material/Translate';
import { AppBar, Box, IconButton, ListItemIcon, Menu, MenuItem, Toolbar, Tooltip, Typography } from '@mui/material';
import { visuallyHidden } from '@mui/utils';
import { ReactNode, useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';

import { InboxButton } from '@/features/office/InboxButton';
import { LANGS, t } from '@/i18n';
import { brandLogos, brandProduct } from '@/lib/brand';
import { shellColors, shellMetrics, toastTokens } from '@/lib/shellTokens';

import { TipLines } from './AgentSwitch';
import { AiChatButton } from './AiChatButton';
import { useI18n } from './I18n';
import { OfficeLinkButton } from './OfficeLinkButton';
import { useThemeMode } from './ThemeMode';

/** 로고 높이. COP 이 가로 락업(종횡비 4.3~4.7)에 쓰는 21~22px 와 같다. 종횡비는 OPENMARU 4.34, MSAP·AINP 4.5 다. */
const LOGO_HEIGHT = 22;
/** 상단 막대 왼쪽 안쪽 여백(sm 이상 px: 3 = 24px). 왼쪽 묶음 폭을 사이드바 폭에 맞추는 데 쓴다 */
const SIDE_PAD = 24;

export interface TopbarProps {
  collapsed: boolean;
  onToggleSidebar: () => void;
  onSearch: () => void;
  /** 다시 읽기 풍선말 2줄과 단추 설명: 「마지막 수집 10-11 09:41 (1/1)」·「수집 실패 · 마지막 성공 …」(스펙 2026-10-19-019 R1·DD8) */
  collected?: string;
  /** 수집이 전체 또는 일부 실패: 다시 읽기 아이콘에 경고 점, 풍선말 2줄은 호박색(D3·DD7) */
  collectWarn?: boolean;
  /** 수집 전체 실패: 화면 읽기 알림(aria-live)에 collected 를 넣는다. 일부 실패는 알리지 않는다(DD7) */
  collectFailed?: boolean;
  /** 다시 읽기 단추: 화면의 데이터를 모두 다시 가져온다 */
  onReload?: () => void;
  reloading?: boolean;
  /** 다시 읽기 단추 왼쪽의 에이전트 고르개(AgentSwitch). 넓은 화면에서만 넘긴다(R5) */
  agentSwitch?: ReactNode;
  /** 계정 단추의 접근 이름과 표시 이름 */
  account: string;
  accountOpen: boolean;
  onAccount: (el: HTMLElement) => void;
  /** 도움말 서랍을 연다(OMAI-1274). 좁은 화면에서는 단추를 숨기고 계정 메뉴의 「도움말」이 대신한다 */
  onHelp?: () => void;
}

export function Topbar({ collapsed, onToggleSidebar, onSearch, collected, collectWarn, collectFailed, onReload, reloading, agentSwitch, account, accountOpen, onAccount, onHelp }: TopbarProps) {
  const { mode, toggle } = useThemeMode();
  const { lang, setLang } = useI18n();
  const [langEl, setLangEl] = useState<HTMLElement | null>(null);
  const [full, setFull] = useState(false);
  const descId = useId();
  useEffect(() => {
    const on = () => setFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void document.documentElement.requestFullscreen?.().catch(() => undefined);
  };
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  const iconSx = { color: 'inherit', flexShrink: 0 } as const;
  // 좁은 화면(xs)에서는 검색·AI·오피스 단추 자리를 위해 다시 읽기·전체 화면·언어·다크 모드 단추를 숨긴다. 언어와 모드는 설정 › 환경설정에서 바꾼다(2026-10-15, OMAI-1218)
  const wideOnlySx = { ...iconSx, display: { xs: 'none', sm: 'inline-flex' } } as const;
  return (
    <AppBar
      position="static"
      component="header"
      elevation={0}
      enableColorOnDark
      sx={{ bgcolor: shellColors.shellBg, color: shellColors.menuText, backgroundImage: 'none', zIndex: (t) => t.zIndex.drawer + 1 }}
    >
      <Toolbar sx={{ gap: 1, px: { xs: 1, sm: 3 } }}>
        {/* 왼쪽 묶음: 로고와 받은편지함 종. 종은 사이드바 폭의 오른쪽 끝에 놓는다(Observability 와 같은 자리, 2026-10-15) */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 1,
            flexShrink: 0,
            mr: { xs: 0, sm: 2 },
            width: { xs: 'auto', md: shellMetrics.sidebarWidth - SIDE_PAD - 8 },
          }}
        >
          <Box
            component={Link}
            to="/dashboard"
            aria-label={t('topbar.home')}
            sx={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0, textDecoration: 'none', color: shellColors.menuActiveText }}
          >
            {/* 설치 브랜드 로고(OMAI-1299). 상단 막대 배경은 두 모드 모두 어두워 흰 글자 판(rw_h)을 쓴다 */}
            <img src={brandLogos().rwh} alt={brandProduct()} style={{ height: LOGO_HEIGHT, width: 'auto', display: 'block' }} />
            <Typography component="span" sx={{ display: { xs: 'none', sm: 'inline' }, fontSize: shellMetrics.topbarFontSize + 2, fontWeight: 700, letterSpacing: 0.5 }}>
              AAS
            </Typography>
          </Box>
          <InboxButton sx={iconSx} />
        </Box>
        <Box sx={{ flex: '1 1 0', display: 'flex', justifyContent: 'center', minWidth: 0 }}>
          <Box
            component="button"
            type="button"
            onClick={onSearch}
            aria-label={t('topbar.searchAria')}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              width: { xs: 38, sm: '100%' },
              maxWidth: 555,
              minWidth: { xs: 38, sm: 0 },
              flexShrink: { xs: 0, sm: 1 },
              justifyContent: { xs: 'center', sm: 'flex-start' },
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              height: 38,
              px: { xs: 0, sm: 1.5 },
              cursor: 'text',
              font: 'inherit',
              fontSize: shellMetrics.topbarFontSize,
              color: 'rgba(255,255,255,0.6)',
              background: 'transparent',
              border: '1px solid rgba(255,255,255,0.23)',
              borderRadius: '4px',
              textAlign: 'left',
              '&:hover': { borderColor: 'rgba(255,255,255,0.5)' },
              '&:focus-visible': { outline: `2px solid ${shellColors.menuActiveText}`, outlineOffset: 1 },
            }}
          >
            <SearchIcon sx={{ fontSize: shellMetrics.iconButtonSize }} />
            <Box component="span" sx={{ flex: 1, display: { xs: 'none', sm: 'inline' } }}>
              {t('topbar.search')}
            </Box>
            <Box component="span" sx={{ display: { xs: 'none', lg: 'inline' }, flexShrink: 0 }}>
              {t('topbar.searchHint', { key: `${mac ? '⌘' : 'Ctrl'} + K` })}
            </Box>
          </Box>
          <Box sx={{ ml: { xs: 0.5, sm: 1 }, display: 'flex', gap: { xs: 0.5, sm: 1 }, flexShrink: 0 }}>
            <AiChatButton />
            <OfficeLinkButton />
          </Box>
        </Box>
        {agentSwitch}
        {onReload && (
          // 단추 이름은 「다시 읽기」, 수집 글자는 설명이다. 설명은 늘 있는 숨김 글자를 직접 가리킨다 — MUI describeChild 는 감싼 span 에,
          // 풍선말이 열렸을 때만 붙는다(스펙 2026-10-19-019 §8 찾은 것 2). 전체 실패면 설명을 비운다: 아래 알림과 두 번 읽힌다(O5)
          <Tooltip
            describeChild
            title={<TipLines lines={collected ? [{ text: t('topbar.reload') }, { text: collected, warn: collectWarn }] : [{ text: t('topbar.reload') }]} />}
          >
            <span>
              <IconButton
                aria-label={t('topbar.reload')}
                aria-describedby={collected && !collectFailed ? descId : undefined}
                onClick={onReload}
                disabled={reloading}
                sx={wideOnlySx}
              >
                <RefreshIcon
                  fontSize="inherit"
                  sx={reloading ? { animation: 'topbar-spin 1s linear infinite', '@keyframes topbar-spin': { to: { transform: 'rotate(360deg)' } }, '@media (prefers-reduced-motion: reduce)': { animation: 'none' } } : undefined}
                />
                {collectWarn && (
                  // 경고 점: 막대가 두 모드 모두 어두워 DESIGN.md 의 어두운 호박색을 고정으로 쓴다(DD10). 돌아가는 아이콘 밖에 둬 같이 돌지 않는다
                  <Box
                    component="span"
                    data-testid="collect-warn"
                    aria-hidden="true"
                    sx={{
                      position: 'absolute',
                      top: 6,
                      right: 6,
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      bgcolor: toastTokens.dark.accent.warning,
                      boxShadow: `0 0 0 2px ${shellColors.shellBg}, 0 0 4px rgba(245,158,11,0.4)`,
                    }}
                  />
                )}
              </IconButton>
            </span>
          </Tooltip>
        )}
        {/* 설명(수집 시각)과 실패 알림. 600px 미만에 숨는 다시 읽기 상자 밖에 늘 그려 둔다(O5) */}
        <Box component="span" id={descId} sx={visuallyHidden}>
          {collectFailed ? '' : collected}
        </Box>
        <Box component="span" role="status" aria-live="polite" sx={visuallyHidden}>
          {collectFailed ? collected : ''}
        </Box>
        <Tooltip title={collapsed ? t('topbar.expand') : t('topbar.collapse')}>
          <IconButton aria-label={collapsed ? t('topbar.expand') : t('topbar.collapse')} onClick={onToggleSidebar} sx={iconSx}>
            <MenuIcon fontSize="inherit" />
          </IconButton>
        </Tooltip>
        <Tooltip title={t('topbar.language')}>
          <IconButton
            aria-label={t('topbar.language')}
            aria-haspopup="menu"
            aria-expanded={!!langEl}
            onClick={(e) => setLangEl(e.currentTarget)}
            sx={wideOnlySx}
          >
            <TranslateIcon fontSize="inherit" />
          </IconButton>
        </Tooltip>
        <Menu
          anchorEl={langEl}
          open={!!langEl}
          onClose={() => setLangEl(null)}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
          transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        >
          {LANGS.map((l) => (
            <MenuItem
              key={l}
              selected={l === lang}
              onClick={() => {
                setLangEl(null);
                if (l !== lang) setLang(l);
              }}
            >
              <ListItemIcon sx={{ minWidth: 28 }}>{l === lang ? <CheckIcon fontSize="small" /> : null}</ListItemIcon>
              {t(`lang.${l}`)}
            </MenuItem>
          ))}
        </Menu>
        <Tooltip title={mode === 'dark' ? t('topbar.lightMode') : t('topbar.darkMode')}>
          <IconButton aria-label={mode === 'dark' ? t('topbar.lightMode') : t('topbar.darkMode')} onClick={toggle} sx={wideOnlySx}>
            {mode === 'dark' ? <LightModeOutlinedIcon fontSize="inherit" /> : <DarkModeOutlinedIcon fontSize="inherit" />}
          </IconButton>
        </Tooltip>
        <Tooltip title={full ? t('topbar.exitFullscreen') : t('topbar.fullscreen')}>
          <IconButton aria-label={full ? t('topbar.exitFullscreen') : t('topbar.fullscreen')} onClick={toggleFull} sx={wideOnlySx}>
            {full ? <FullscreenExitIcon fontSize="inherit" /> : <FullscreenIcon fontSize="inherit" />}
          </IconButton>
        </Tooltip>
        {onHelp && (
          <Tooltip title={t('guides.help')}>
            <IconButton aria-label={t('guides.help')} onClick={onHelp} sx={wideOnlySx}>
              <HelpOutlineIcon fontSize="inherit" />
            </IconButton>
          </Tooltip>
        )}
        <Tooltip title={account}>
          <IconButton
            aria-label={t('topbar.account', { name: account })}
            aria-haspopup="menu"
            aria-expanded={accountOpen}
            onClick={(e) => onAccount(e.currentTarget)}
            sx={iconSx}
          >
            <AccountCircleOutlinedIcon fontSize="inherit" />
          </IconButton>
        </Tooltip>
      </Toolbar>
    </AppBar>
  );
}
