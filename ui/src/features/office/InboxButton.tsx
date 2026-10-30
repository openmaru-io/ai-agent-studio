/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 상단 막대의 종 단추(계획 007 G2). 어느 화면에서나 받은편지함 개수를 빨간 배지로 보이고, 누르면 받은편지함 서랍을 연다.
import NotificationsNoneOutlinedIcon from '@mui/icons-material/NotificationsNoneOutlined';
import { Badge, IconButton, Tooltip } from '@mui/material';
import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useUi } from '@/components/UiContext';
import { InboxPanel } from '@/features/office/InboxPanel';
import { hasOld, useInbox } from '@/features/office/useInbox';
import { t } from '@/i18n';

export function InboxButton({ sx }: { sx?: object }) {
  const { items } = useInbox();
  const { openDrawer } = useUi();
  const old = hasOld(items, Date.now() / 1000);
  const label = t('office.inboxLabel', { n: items.length });
  const open = () => openDrawer({ title: t('office.inbox'), icon: NotificationsNoneOutlinedIcon, body: <InboxPanel /> });
  // 주소 ?inbox=1 이면 서랍을 연다(가이드 따라하기 user.inbox 가 서랍을 열어 준다). 값이 없어지면 다시 열 수 있다
  const [params] = useSearchParams();
  const asked = params.get('inbox') === '1';
  const opened = useRef(false);
  useEffect(() => {
    if (!asked) opened.current = false;
    else if (!opened.current) {
      opened.current = true;
      open();
    }
  }, [asked]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Tooltip title={label}>
      <IconButton
        aria-label={label}
        data-guide="topbar.inbox"
        // 머리 아이콘은 지금 화면의 것이 아니라 종(어느 화면에서 열어도 같은 서랍)
        onClick={open}
        sx={sx}
      >
        <Badge
          badgeContent={items.length}
          max={99}
          invisible={!items.length}
          // 빨간 숫자 배지(DESIGN.md 알림색 #DA291C). 오래 기다린 승인·되묻기가 있으면 앰버(G2)
          sx={{ '& .MuiBadge-badge': { bgcolor: old ? '#f59e0b' : '#DA291C', color: old ? '#08090a' : '#fff', fontSize: 10, fontWeight: 700, minWidth: 18, height: 18, px: 0.5 } }}
        >
          <NotificationsNoneOutlinedIcon fontSize="inherit" />
        </Badge>
      </IconButton>
    </Tooltip>
  );
}
