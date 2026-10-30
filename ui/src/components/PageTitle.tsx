/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 본문 제목(h1). 지금 주소의 화면에 맞는 아이콘을 제목 앞에 둔다.
// 아이콘은 @mui/icons-material 의 SVG 라 그림이 JS 묶음 안에 있다 — 글꼴·CDN 을 받지 않아 에어갭에서도 그대로 보인다.
import type { SvgIconComponent } from '@mui/icons-material';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import BadgeOutlinedIcon from '@mui/icons-material/BadgeOutlined';
import BuildOutlinedIcon from '@mui/icons-material/BuildOutlined';
import BusinessOutlinedIcon from '@mui/icons-material/BusinessOutlined';
import CampaignOutlinedIcon from '@mui/icons-material/CampaignOutlined';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded';
import DashboardOutlinedIcon from '@mui/icons-material/DashboardOutlined';
import DisplaySettingsOutlinedIcon from '@mui/icons-material/DisplaySettingsOutlined';
import DomainOutlinedIcon from '@mui/icons-material/DomainOutlined';
import ExtensionOutlinedIcon from '@mui/icons-material/ExtensionOutlined';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import HistoryOutlinedIcon from '@mui/icons-material/HistoryOutlined';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import InsightsOutlinedIcon from '@mui/icons-material/InsightsOutlined';
import LibraryBooksOutlinedIcon from '@mui/icons-material/LibraryBooksOutlined';
import ManageAccountsOutlinedIcon from '@mui/icons-material/ManageAccountsOutlined';
import PsychologyOutlinedIcon from '@mui/icons-material/PsychologyOutlined';
import ScheduleOutlinedIcon from '@mui/icons-material/ScheduleOutlined';
import SelfImprovementOutlinedIcon from '@mui/icons-material/SelfImprovementOutlined';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import StorefrontOutlinedIcon from '@mui/icons-material/StorefrontOutlined';
import TerminalOutlinedIcon from '@mui/icons-material/TerminalOutlined';
import VpnKeyOutlinedIcon from '@mui/icons-material/VpnKeyOutlined';
import { Box, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import { visuallyHidden } from '@mui/utils';
import { ReactNode } from 'react';
import { useInRouterContext, useLocation } from 'react-router-dom';

import { t } from '@/i18n';
import { useIsAdmin } from '@/lib/data';
import { canOpenHelp, openHelp } from '@/lib/guideRun';
import { guidesForView } from '@/lib/guides';

/** 화면 id(lib/views.ts) → 제목 아이콘. 화면마다 다른 아이콘이다(시험이 확인한다) */
export const VIEW_ICONS: Record<string, SvgIconComponent> = {
  dashboard: DashboardOutlinedIcon,
  chat: ChatBubbleOutlineIcon,
  office: BusinessOutlinedIcon,
  cron: ScheduleOutlinedIcon,
  channels: HubOutlinedIcon,
  activity: InsightsOutlinedIcon,
  changes: HistoryOutlinedIcon,
  users: ManageAccountsOutlinedIcon,
  agents: SmartToyOutlinedIcon,
  profiles: BadgeOutlinedIcon,
  flows: AccountTreeOutlinedIcon,
  skills: ExtensionOutlinedIcon,
  models: PsychologyOutlinedIcon,
  market: StorefrontOutlinedIcon,
  credentials: VpnKeyOutlinedIcon,
  connections: TerminalOutlinedIcon,
  tools: BuildOutlinedIcon,
  libraries: LibraryBooksOutlinedIcon,
  preferences: DisplaySettingsOutlinedIcon,
  settings: DomainOutlinedIcon,
  'soul-templates': SelfImprovementOutlinedIcon,
  notices: CampaignOutlinedIcon,
};

/** 지금 주소의 화면 아이콘. 라우터 밖(일부 시험)이나 모르는 주소면 undefined. 본문 제목과 서랍 제목이 같이 쓴다 */
export function useViewIcon(): SvgIconComponent | undefined {
  const inRouter = useInRouterContext();
  // 라우터 안팎은 한 화면 트리에서 바뀌지 않으므로 조건부 호출이어도 호출 순서가 바뀌지 않는다
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const path = inRouter ? useLocation().pathname : '';
  return VIEW_ICONS[path.split('/')[1] ?? ''];
}

/** 본문 제목 옆 「이 화면 도움말」(OMAI-1274 §4-2 (나)). 이 화면의 가이드가 있을 때만 그린다. h1 밖이라 제목을 읽을 때 섞이지 않는다 */
function TitleHelp({ view }: { view: string }) {
  const admin = useIsAdmin();
  if (!guidesForView(view, admin).length) return null;
  return (
    <Tooltip title={t('guides.thisScreen')}>
      <IconButton aria-label={t('guides.thisScreen')} onClick={openHelp} data-title-help="" sx={{ width: 32, height: 32, my: -0.5, color: 'text.secondary', '&:hover': { color: 'text.primary' } }}>
        <HelpOutlineIcon sx={{ fontSize: 20 }} />
      </IconButton>
    </Tooltip>
  );
}

/**
 * @param action 제목 바로 옆 단추(추가 등). 순서는 [제목][action][도움말]이다(디자인 리뷰 12A): 추가가 주 동작이고 도움말은 보조라 뒤에 작고 연하게 둔다.
 */
export function PageTitle({
  children,
  gutterBottom,
  context,
  action,
}: {
  children: ReactNode;
  gutterBottom?: boolean;
  context?: string;
  action?: ReactNode;
}) {
  const inRouter = useInRouterContext();
  // 라우터 안팎은 한 화면 트리에서 바뀌지 않으므로 조건부 호출이어도 호출 순서가 바뀌지 않는다
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const view = inRouter ? useLocation().pathname.split('/')[1] || 'dashboard' : '';
  const help = canOpenHelp() && view ? <TitleHelp view={view} /> : null;
  const title = <TitleText gutterBottom={gutterBottom && !action && !help} context={context}>{children}</TitleText>;
  if (!action && !help) return title;
  return (
    <Stack direction="row" alignItems="center" spacing={1} useFlexGap sx={{ minWidth: 0, mb: gutterBottom ? '0.35em' : undefined }}>
      {title}
      {action}
      {help}
    </Stack>
  );
}

function TitleText({ children, gutterBottom, context }: { children: ReactNode; gutterBottom?: boolean; context?: string }) {
  const Icon = useViewIcon();
  return (
    <Typography variant="h5" component="h1" gutterBottom={gutterBottom} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
      {Icon && <Icon aria-hidden sx={{ fontSize: '1.1em', color: 'text.secondary', flexShrink: 0 }} />}
      {/* context: 회사처럼 제목이 속한 곳. 이름 앞에 작은 보조 글자와 화살표 아이콘으로 두고, 읽는 이름은 「맥락 > 이름」으로 같다 */}
      {context && (
        <>
          <Box component="span" data-title-context sx={{ fontSize: '0.74em', fontWeight: 500, color: 'text.secondary', letterSpacing: '0.01em', whiteSpace: 'nowrap' }}>
            {context}
          </Box>
          <Box component="span" sx={visuallyHidden}>
            {' > '}
          </Box>
          <ChevronRightRoundedIcon aria-hidden sx={{ fontSize: '0.9em', color: 'text.disabled', ml: -0.5, mr: -0.25, flexShrink: 0 }} />
        </>
      )}
      {children}
    </Typography>
  );
}
