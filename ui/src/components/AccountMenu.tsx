/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 상단 막대의 계정 메뉴(OMAI-1267). 머리(이니셜·이름·이메일·관리자 알약)와 묶음별 항목으로 이루며, 표면·테두리·그림자는
// 떠 있는 채팅 창(chatTokens.popup)과 같은 값을 쓴다. 새로 고침은 상단 막대에 단추가 있어 두지 않는다.
import CampaignOutlinedIcon from '@mui/icons-material/CampaignOutlined';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import KeyboardOutlinedIcon from '@mui/icons-material/KeyboardOutlined';
import LogoutIcon from '@mui/icons-material/Logout';
import ManageAccountsOutlinedIcon from '@mui/icons-material/ManageAccountsOutlined';
import PersonOutlineIcon from '@mui/icons-material/PersonOutline';
import { Box, BoxProps, Divider, ListItemIcon, Menu, MenuItem, Typography, useTheme } from '@mui/material';
import { ReactNode } from 'react';

import { t } from '@/i18n';
import { chatTokens } from '@/lib/chatTokens';
import type { Me } from '@/lib/data';
import { dialogTokens } from '@/lib/shellTokens';

import { agentMenuItems } from './AgentSwitch';
import { menuItemSx } from './menuItemSx';

/** 메뉴 맨 위 머리(이니셜·이름·이메일). MUI MenuList 는 열 때 첫 자식에 포커스를 주는데, 이 머리는 포커스를 받지 못해 포커스가
 *  메뉴 틀에 남고 화살표가 듣지 않았다(에이전트 묶음의 지금 줄이 없을 때, 스펙 2026-10-19-019 §7). Divider 처럼 건너뛰게 표시한다 */
function MenuHead(props: BoxProps) {
  return <Box role="presentation" {...props} />;
}
MenuHead.muiSkipListHighlight = true;

export interface AccountMenuProps {
  anchorEl: HTMLElement | null;
  onClose: () => void;
  me: Me | undefined;
  /** 「사용자·권한」을 보일지(관리자이거나 로그인을 쓰지 않는 설치) */
  showUsers: boolean;
  onProfile: () => void;
  onUsers: () => void;
  onShortcuts: () => void;
  /** 도움말 서랍(OMAI-1274). 부르는 쪽이 좁은 화면(600px 미만)에서만 넘긴다: 상단 막대의 도움말 단추가 그 폭에서 숨기 때문이다(디자인 리뷰 10A).
   *  CSS 로 숨기지 않는다 — MUI 메뉴의 화살표 이동이 숨은 줄 앞에서 멈춘다(스펙 2026-10-19-019 R6) */
  onHelp?: () => void;
  /** 「에이전트」 묶음을 그릴지. 넓은 화면(1200px 이상)은 상단 막대 고르개가 대신해 거짓이다(스펙 2026-10-19-019 D1·R5) */
  showAgents?: boolean;
  onPod: (id: string) => void;
  /** 지금 이 사람에게 보일 공지 수(닫은 것 포함). 0 이면 「지금 공지」 줄을 숨긴다(스펙 공지 바 3D) */
  notices?: number;
  onNotices?: () => void;
}

export function AccountMenu({ anchorEl, onClose, me, showUsers, onProfile, onUsers, onShortcuts, onHelp, showAgents = true, onPod, notices = 0, onNotices }: AccountMenuProps) {
  const mode = useTheme().palette.mode;
  const tk = chatTokens[mode];
  const dlg = dialogTokens[mode];
  const user = me?.user ?? null;
  const name = user ? user.name || user.email.split('@')[0] : '';
  const pods = showAgents ? me?.pods ?? [] : [];

  const itemSx = menuItemSx(tk);
  const icon = (node: ReactNode) => <ListItemIcon>{node}</ListItemIcon>;
  const close = (fn: () => void) => () => {
    onClose();
    fn();
  };
  const rule = <Divider sx={{ my: 0.75, borderColor: tk.line }} />;

  return (
    <Menu
      anchorEl={anchorEl}
      open={!!anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      slotProps={{
        paper: {
          sx: {
            mt: 0.75,
            width: 296,
            maxWidth: 'calc(100vw - 16px)',
            borderRadius: '12px',
            bgcolor: dlg.surface,
            backgroundImage: 'none',
            border: '1px solid',
            borderColor: tk.popup.edge,
            boxShadow: `${tk.popup.shadow}, ${tk.popup.highlight}`,
          },
        },
        list: { sx: { py: 0.75 } },
      }}
    >
      {user && (
        <MenuHead sx={{ display: 'flex', alignItems: 'center', gap: 1.25, px: 2, pt: 1, pb: 0.5 }}>
          <Box
            aria-hidden="true"
            sx={{
              width: 36,
              height: 36,
              flexShrink: 0,
              borderRadius: '50%',
              display: 'grid',
              placeItems: 'center',
              bgcolor: tk.monoTile,
              border: `1px solid ${tk.line}`,
              color: tk.text,
              fontSize: 15,
              fontWeight: 600,
            }}
          >
            {name.slice(0, 1).toUpperCase()}
          </Box>
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
              <Typography noWrap title={name} sx={{ fontSize: 14, fontWeight: 600, color: tk.text, lineHeight: 1.4 }}>
                {name}
              </Typography>
              {me?.admin && (
                <Box
                  component="span"
                  sx={{
                    flexShrink: 0,
                    px: 0.75,
                    fontSize: 11,
                    lineHeight: '18px',
                    borderRadius: '9px',
                    border: `1px solid ${tk.popup.edge}`,
                    color: tk.muted,
                  }}
                >
                  {t('account.roleAdmin')}
                </Box>
              )}
            </Box>
            <Typography noWrap title={user.email} sx={{ fontSize: 12, color: tk.muted, lineHeight: 1.4 }}>
              {user.email}
            </Typography>
          </Box>
        </MenuHead>
      )}
      {user && rule}
      {user && (
        <MenuItem sx={itemSx} onClick={close(onProfile)}>
          {icon(<PersonOutlineIcon sx={{ fontSize: 18 }} />)}
          {t('account.menu')}
        </MenuItem>
      )}
      {showUsers && (
        <MenuItem sx={itemSx} onClick={close(onUsers)}>
          {icon(<ManageAccountsOutlinedIcon sx={{ fontSize: 18 }} />)}
          {t('views.users.label')}
        </MenuItem>
      )}
      {notices > 0 && onNotices && (
        <MenuItem sx={itemSx} onClick={close(onNotices)}>
          {icon(<CampaignOutlinedIcon sx={{ fontSize: 18 }} />)}
          {t('notice.menuNow', { n: notices })}
        </MenuItem>
      )}
      {pods.length > 1 && rule}
      {pods.length > 1 && (
        <Typography role="presentation" sx={{ px: 2.25, pt: 0.25, pb: 0.5, fontSize: 12, color: tk.muted }}>
          {t('shell.agents')}
        </Typography>
      )}
      {pods.length > 1 &&
        agentMenuItems({ pods, currentId: me?.pod?.id, viewerEmail: me?.user?.email, sx: itemSx, onClose, onPick: onPod })}
      {rule}
      {onHelp && (
        <MenuItem sx={itemSx} onClick={close(onHelp)}>
          {icon(<HelpOutlineIcon sx={{ fontSize: 18 }} />)}
          {t('guides.help')}
        </MenuItem>
      )}
      <MenuItem sx={itemSx} onClick={close(onShortcuts)}>
        {icon(<KeyboardOutlinedIcon sx={{ fontSize: 18 }} />)}
        <Box component="span" sx={{ flex: 1 }}>
          {t('shell.shortcuts')}
        </Box>
        <Box
          component="kbd"
          aria-hidden="true"
          sx={{ px: 0.75, fontFamily: 'inherit', fontSize: 11, lineHeight: '18px', borderRadius: '5px', border: `1px solid ${tk.popup.edge}`, color: tk.muted }}
        >
          ?
        </Box>
      </MenuItem>
      {user && rule}
      {user && (
        <MenuItem component="a" href="/auth/logout" sx={itemSx} onClick={onClose}>
          {icon(<LogoutIcon sx={{ fontSize: 18 }} />)}
          {t('shell.logout')}
        </MenuItem>
      )}
    </Menu>
  );
}
