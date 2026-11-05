/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 섹션 제목 앞 아이콘. 번역 키 → 아이콘 한 곳에 모은다 — Section 은 받은 제목으로 여기서 찾는다.
// 같은 뜻은 같은 아이콘이다(관련 화면은 모두 링크, 확인할 것은 모두 경고).
// 동작(지우기·소유권 이전·끄기 등)은 섹션이 아니라 서랍 머리의 단추다(OMAI-1135).
// @mui/icons-material 의 SVG 라 그림이 JS 묶음 안에 있다 — 아이콘 글꼴·CDN 을 받지 않아 에어갭에서도 보인다.
// 코드에서 쓰는 섹션 제목 키가 모두 여기 있는지 sectionIcons.test.tsx 가 확인한다.
import type { SvgIconComponent } from '@mui/icons-material';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline';
import AdminPanelSettingsOutlinedIcon from '@mui/icons-material/AdminPanelSettingsOutlined';
import AltRouteOutlinedIcon from '@mui/icons-material/AltRouteOutlined';
import AssignmentOutlinedIcon from '@mui/icons-material/AssignmentOutlined';
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined';
import BadgeOutlinedIcon from '@mui/icons-material/BadgeOutlined';
import BuildOutlinedIcon from '@mui/icons-material/BuildOutlined';
import CallMadeOutlinedIcon from '@mui/icons-material/CallMadeOutlined';
import CallReceivedOutlinedIcon from '@mui/icons-material/CallReceivedOutlined';
import CampaignOutlinedIcon from '@mui/icons-material/CampaignOutlined';
import CancelScheduleSendOutlinedIcon from '@mui/icons-material/CancelScheduleSendOutlined';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import ChecklistOutlinedIcon from '@mui/icons-material/ChecklistOutlined';
import CodeOutlinedIcon from '@mui/icons-material/CodeOutlined';
import DataUsageOutlinedIcon from '@mui/icons-material/DataUsageOutlined';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import DomainOutlinedIcon from '@mui/icons-material/DomainOutlined';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import EditCalendarOutlinedIcon from '@mui/icons-material/EditCalendarOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import ExtensionOutlinedIcon from '@mui/icons-material/ExtensionOutlined';
import FactCheckOutlinedIcon from '@mui/icons-material/FactCheckOutlined';
import FileUploadOutlinedIcon from '@mui/icons-material/FileUploadOutlined';
import FilterAltOutlinedIcon from '@mui/icons-material/FilterAltOutlined';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import GroupsOutlinedIcon from '@mui/icons-material/GroupsOutlined';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import HistoryOutlinedIcon from '@mui/icons-material/HistoryOutlined';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import InputOutlinedIcon from '@mui/icons-material/InputOutlined';
import LinkOutlinedIcon from '@mui/icons-material/LinkOutlined';
import ManageAccountsOutlinedIcon from '@mui/icons-material/ManageAccountsOutlined';
import NetworkCheckOutlinedIcon from '@mui/icons-material/NetworkCheckOutlined';
import PaletteOutlinedIcon from '@mui/icons-material/PaletteOutlined';
import PlaceOutlinedIcon from '@mui/icons-material/PlaceOutlined';
import PsychologyOutlinedIcon from '@mui/icons-material/PsychologyOutlined';
import ReportProblemOutlinedIcon from '@mui/icons-material/ReportProblemOutlined';
import RouterOutlinedIcon from '@mui/icons-material/RouterOutlined';
import RuleOutlinedIcon from '@mui/icons-material/RuleOutlined';
import ScheduleOutlinedIcon from '@mui/icons-material/ScheduleOutlined';
import SendOutlinedIcon from '@mui/icons-material/SendOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import StarOutlineIcon from '@mui/icons-material/StarOutline';
import StickyNote2OutlinedIcon from '@mui/icons-material/StickyNote2Outlined';
import SwapHorizOutlinedIcon from '@mui/icons-material/SwapHorizOutlined';
import TextSnippetOutlinedIcon from '@mui/icons-material/TextSnippetOutlined';
import VpnKeyOutlinedIcon from '@mui/icons-material/VpnKeyOutlined';

import { getLang, Lang, t } from '@/i18n';

const LINK = LinkOutlinedIcon; // 관련 화면·이어서 보기
const REVIEW = ReportProblemOutlinedIcon; // 확인할 것
const ERROR = ErrorOutlineIcon;

export const SECTION_ICONS: Record<string, SvgIconComponent> = {
  'common.kv.title': InfoOutlinedIcon,
  // 관련 화면
  'activity.seeNext': LINK,
  'channels.seeNext': LINK,
  'cron.alsoSee': LINK,
  'inventory.seeNext': LINK,
  'models.seeNext': LINK,
  'profiles.relatedTitle': LINK,
  // 확인할 것
  'channels.review': REVIEW,
  'inventory.review': REVIEW,
  'models.review': REVIEW,
  'profiles.issuesTitle': REVIEW,
  // 오류
  'cron.errorTitle': ERROR,
  'cronJob.lastError': ERROR,
  'cron.deliveryError': CancelScheduleSendOutlinedIcon,
  // 활동
  'activity.byProfile': BadgeOutlinedIcon,
  'activity.whereFrom': InputOutlinedIcon,
  // 에이전트
  'agents.ownerLimit': DataUsageOutlinedIcon,
  // 채널
  'channels.channelsTitle': HubOutlinedIcon,
  'profiles.chan.linkedTitle': HubOutlinedIcon, // 프로파일 「메신저 연결」 탭의 연결한 메신저(채널 화면의 채널 구역과 같은 아이콘)
  // Cron
  'cron.manage': SettingsOutlinedIcon,
  'cron.skillsUsed': ExtensionOutlinedIcon,
  'cron.thisProfileOnly': FilterAltOutlinedIcon,
  'cron.todo': ChecklistOutlinedIcon,
  'cronJob.calls': CallMadeOutlinedIcon,
  'cronJob.changePeriodTitle': EditCalendarOutlinedIcon,
  'cronJob.conditions': RuleOutlinedIcon,
  'cronJob.conditionsBlocked': RuleOutlinedIcon,
  'cronJob.deliverTarget': SendOutlinedIcon,
  'cronJob.newReview': FactCheckOutlinedIcon,
  'cronJob.newWillDo': DescriptionOutlinedIcon,
  'cronJob.note': StickyNote2OutlinedIcon,
  'cronJob.period': ScheduleOutlinedIcon,
  'cronJob.prompt': TextSnippetOutlinedIcon,
  'cronJob.recentRuns': HistoryOutlinedIcon,
  'cronJob.skillToRun': ExtensionOutlinedIcon,
  'cronJob.whatItDoes': DescriptionOutlinedIcon,
  // 호출 흐름
  'flows.callersTitle': CallReceivedOutlinedIcon,
  'flows.evidenceTitle': FactCheckOutlinedIcon,
  'flows.incoming': CallReceivedOutlinedIcon,
  'flows.legendTitle': HelpOutlineIcon,
  'flows.outgoing': CallMadeOutlinedIcon,
  'flows.title': AccountTreeOutlinedIcon,
  // 자산
  'inventory.changeValue': EditOutlinedIcon,
  'inventory.chatWithTool': ChatBubbleOutlineIcon,
  'inventory.registryTitle': AssignmentOutlinedIcon,
  'inventory.usedByTitle': AltRouteOutlinedIcon,
  'inventory.mcpEnvNames': VpnKeyOutlinedIcon,     // 도구 화면의 MCP 서버 서랍(OMAI-1249): 환경변수·헤더 이름은 비밀값 이름이라 자격증명과 같은 열쇠
  'inventory.mcpHeaderNames': VpnKeyOutlinedIcon,
  // 마켓
  'market.summary.title': AutoAwesomeOutlinedIcon,   // 스킬 AI 요약(스펙 2026-10-17-002)
  'market.description': DescriptionOutlinedIcon,
  'market.includedFiles': FolderOutlinedIcon,
  'market.install': DownloadOutlinedIcon,
  'market.installedPlaces': PlaceOutlinedIcon,
  'market.needsTitle': EditOutlinedIcon,
  // 모델
  'models.fallbackProfiles': SwapHorizOutlinedIcon,
  'models.primaryProfiles': StarOutlineIcon,
  'models.probe': NetworkCheckOutlinedIcon,
  // 프로파일
  'profiles.about': DescriptionOutlinedIcon,
  'profiles.envAddTitle': AddCircleOutlineIcon,
  'profiles.cred.title': VpnKeyOutlinedIcon,    // 비밀값 탭의 인증 파일(JSON) 구역(2026-10-22-004) — 자격증명 열쇠
  'profiles.gateway': RouterOutlinedIcon,
  'profiles.mainModel': PsychologyOutlinedIcon,
  'profiles.mcpSection': DnsOutlinedIcon,
  'profiles.toolsetSection': BuildOutlinedIcon,
  // 회사 정보
  'settings.companyTitle': DomainOutlinedIcon,
  'settings.identityTitle': BadgeOutlinedIcon,
  'settings.goalTitle': CampaignOutlinedIcon,
  'conn.commandTitle': CodeOutlinedIcon,
  'conn.oauthTitle': LinkOutlinedIcon,
  'conn.patTitle': VpnKeyOutlinedIcon,
  'settings.teamTitle': GroupsOutlinedIcon,
  'prefs.theme': PaletteOutlinedIcon,
  // 스킬
  'skills.cronJobs': ScheduleOutlinedIcon,
  'skills.flowAndChat': AccountTreeOutlinedIcon,
  'skills.mcpServers': DnsOutlinedIcon,
  'skills.publishTitle': FileUploadOutlinedIcon,
  'skills.otherSkills': ExtensionOutlinedIcon,
  'skills.envTitle': VpnKeyOutlinedIcon,         // 스킬이 선언한 필요한 비밀값(스펙 2026-10-16-010 2단계): 자격증명과 같은 열쇠
  // 스킬 — 에이전트 중심 보기(screens/skills/AgentSkills.tsx)
  'skillsAgent.folderFiles': FolderOutlinedIcon,
  'skillsAgent.checks': FactCheckOutlinedIcon,
  'skillsAgent.packageFiles': ChecklistOutlinedIcon,
  'skillsAgent.headerPreview': DescriptionOutlinedIcon,
  'skillsAgent.publishHistory': HistoryOutlinedIcon,
  // 사용자
  'users.changeRole': ManageAccountsOutlinedIcon,
  'account.sectionAccount': BadgeOutlinedIcon, // 내 정보 서랍(스펙 2026-10-14-017)
  'account.sectionPassword': VpnKeyOutlinedIcon,
  'users.role': AdminPanelSettingsOutlinedIcon,
};

// 번역문(현재 언어) → 아이콘. 「{n}」 같은 자리는 아무 값이나 맞게 정규식으로 둔다. 언어마다 한 번 만든다
const cache = new Map<Lang, [RegExp, SvgIconComponent][]>();
const escape = (s: string) => s.replace(/[.*+?^$()|[\]\\]/g, '\\$&');

export function sectionIconFor(title: string): SvgIconComponent | undefined {
  const lang = getLang();
  let table = cache.get(lang);
  if (!table) {
    table = Object.entries(SECTION_ICONS).map(([key, icon]) => [
      new RegExp('^' + escape(t(key)).replace(/\{\w+\}/g, '.+?') + '$'),
      icon,
    ]);
    cache.set(lang, table);
  }
  return table.find(([re]) => re.test(title))?.[1];
}
