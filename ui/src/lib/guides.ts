/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 화면 내장 도움말의 가이드 목록(OMAI-1274). 가이드 하나는 「하고 싶은 일」 하나이고, 단계는 「한 화면에서 한 동작」이다.
// 문장은 번역 사전(i18n/{ko,en}/guides.ts)의 `guides.<가이드 id>.title` · `.sub` · `.<단계 id>.title` · `.<단계 id>.body` 에 있다.
// 강조할 칸은 화면 코드의 `data-guide="…"` 속성으로 찾는다. 글자·클래스로 찾지 않는다(문구·디자인이 바뀌어도 가이드가 깨지지 않게).
// guides.test.ts 가 주소·탭·강조 대상·권한 키가 실제로 있는지 확인한다.

export type GuideGroup = 'start' | 'tune' | 'connect' | 'ops';

/** 단계가 여는 화면. '$mine' 은 실행할 때 내 주 에이전트(useMe().primary.profile) 이름으로 바뀐다 */
export interface GuideTarget {
  view: string;
  params?: Record<string, string>;
}

export interface GuideStep {
  id: string;
  /** 이 단계에서 열 화면. 없으면 설명만 있는 단계 */
  to?: GuideTarget;
  /** 강조할 요소의 data-guide 값 */
  spot?: string;
  /** 프로파일 서랍 단계의 권한 키. 서버 응답 caps[cap] 로 판정한다 */
  cap?: string;
}

export interface Guide {
  id: string;
  audience: 'user' | 'admin';
  group: GuideGroup;
  /** 이 가이드와 관련된 화면(도움말 서랍 맨 위 「이 화면에서 할 수 있는 일」) */
  views: string[];
  /** 요청 안내만 있는 가이드: 끝냄 표시를 붙이지 않는다 */
  requestOnly?: boolean;
  steps: GuideStep[];
}

export const MINE = '$mine';

const soul: GuideTarget = { view: 'profiles', params: { name: MINE, pane: 'soul' } };
const overview: GuideTarget = { view: 'profiles', params: { name: MINE } };
const pane = (p: string): GuideTarget => ({ view: 'profiles', params: { name: MINE, pane: p } });
const view = (v: string): GuideTarget => ({ view: v });
/** 내 주 AI 에이전트와 연 채팅(주소 agent). 채팅 단추·입력칸을 강조하는 단계에 쓴다 */
const chatMine: GuideTarget = { view: 'chat', params: { agent: MINE } };
/** 채팅의 「지난 대화」·「파일」 서랍을 연 채로(주소 panel) */
const chatPanel = (p: 'past' | 'files'): GuideTarget => ({ view: 'chat', params: { agent: MINE, panel: p } });
/** 받은편지함 서랍을 연 채로(주소 inbox, 상단 막대의 종 단추가 열어 준다) */
const chatInbox: GuideTarget = { view: 'chat', params: { agent: MINE, inbox: '1' } };
/** 「새 스킬」 서랍을 연 채로(주소 new, 화면이 열어 준다) */
const skillsNew = (tab: 'write' | 'zip'): GuideTarget => ({ view: 'skills', params: { new: tab } });
const skillsTab = (tab: 'mine' | 'builtin'): GuideTarget => ({ view: 'skills', params: { tab } });
/** 프로파일 상세의 탭 하나(탭 줄의 data-guide="profiles.tab.<탭>") */
const tab = (p: string) => `profiles.tab.${p}`;

export const GUIDES: Guide[] = [
  {
    id: 'user.first-chat',
    audience: 'user',
    group: 'start',
    views: ['chat', 'dashboard'],
    steps: [
      { id: 'open', to: { view: 'chat' }, spot: 'chat.agents' },
      { id: 'pick', to: { view: 'chat' }, spot: 'chat.agents' },
      { id: 'ask', to: { view: 'chat' }, spot: 'chat.composer' },
    ],
  },
  {
    id: 'user.attach-file',
    audience: 'user',
    group: 'start',
    views: ['chat'],
    steps: [
      { id: 'attach', to: chatMine, spot: 'chat.attach' },
      { id: 'ask', to: chatMine, spot: 'chat.composer' },
      { id: 'receive', to: chatPanel('files'), spot: 'chat.files' },
    ],
  },
  {
    id: 'user.file-viewer',
    audience: 'user',
    group: 'start',
    views: ['chat'],
    steps: [
      { id: 'open', to: chatPanel('files'), spot: 'chat.file-list' },
      { id: 'read', to: chatPanel('files'), spot: 'chat.file-list' },
      { id: 'use', to: chatPanel('files'), spot: 'chat.file-list' },
      { id: 'limits', to: chatPanel('files'), spot: 'chat.file-list' },
    ],
  },
  {
    id: 'user.voice',
    audience: 'user',
    group: 'start',
    views: ['chat', 'preferences'],
    steps: [
      { id: 'speak', to: chatMine, spot: 'chat.voice' },
      { id: 'check', to: chatMine, spot: 'chat.composer' },
      { id: 'listen', to: chatMine, spot: 'chat.read' },
      { id: 'voice', to: view('preferences'), spot: 'prefs.voice' },
    ],
  },
  {
    id: 'user.inbox',
    audience: 'user',
    group: 'start',
    views: ['chat'],
    steps: [
      { id: 'find', to: chatMine, spot: 'topbar.inbox' },
      { id: 'approve', to: chatInbox, spot: 'inbox.panel' },
      { id: 'answer', to: chatInbox, spot: 'inbox.panel' },
      { id: 'ack', to: chatInbox, spot: 'inbox.panel' },
    ],
  },
  {
    id: 'user.past-chat',
    audience: 'user',
    group: 'start',
    views: ['chat'],
    steps: [
      { id: 'past', to: chatPanel('past'), spot: 'chat.past' },
      { id: 'new', to: chatMine, spot: 'chat.new' },
      { id: 'stop', to: chatMine, spot: 'chat.composer' },
    ],
  },
  {
    id: 'user.preferences',
    audience: 'user',
    group: 'start',
    views: ['preferences'],
    steps: [
      { id: 'open', to: view('preferences'), spot: 'prefs.language' },
      { id: 'choose', to: view('preferences'), spot: 'prefs.theme' },
    ],
  },
  {
    id: 'user.my-agents',
    audience: 'user',
    group: 'start',
    views: ['agents', 'dashboard'],
    steps: [
      { id: 'list', to: { view: 'agents' }, spot: 'agents.list' },
      { id: 'create', to: { view: 'agents' }, spot: 'agents.create' },
    ],
  },
  {
    // 내 PC 의 Hermes 는 가져올 프로파일(main 이 아니어도, OMAI-1444) 상세 서랍 머리의 「PC 에서 가져오기」(스펙 2026-10-14-004), 다른 에이전트의 프로파일은
    // 새 프로파일 서랍의 「다른 에이전트에서 가져오기」(스펙 2026-10-15-011). R0(스펙 2026-10-21 agent-dashboard-self-kill-recovery §3-6)
    id: 'user.import-profile',
    audience: 'user',
    group: 'start',
    views: ['profiles'],
    steps: [
      { id: 'pc-open', to: overview, spot: 'drawer-action.pc-import' },
      { id: 'pc-upload', to: overview, spot: 'drawer-action.pc-import' },
      { id: 'pc-replace', to: overview, spot: 'drawer-action.pc-import' },
      { id: 'agent-open', to: view('profiles'), spot: 'profiles.list' },
      { id: 'agent-pick', to: view('profiles'), spot: 'profiles.list' },
    ],
  },
  {
    id: 'user.change-soul',
    audience: 'user',
    group: 'tune',
    views: ['profiles'],
    steps: [
      { id: 'open', to: soul, spot: 'profiles.soul', cap: 'soul' },
      { id: 'edit', to: soul, spot: 'profiles.soul', cap: 'soul' },
    ],
  },
  {
    id: 'user.change-model',
    audience: 'user',
    group: 'tune',
    views: ['profiles', 'models'],
    requestOnly: true,
    // 모델은 관리자만 바꾼다(caps.model). 주인에게는 개요 탭의 주 모델 줄에 「관리자에게 모델 변경 요청」 단추가 있다(Detail.tsx RequestAdminButton)
    steps: [{ id: 'ask', to: overview, spot: 'profiles.request-model' }],
  },
  {
    id: 'user.add-skill',
    audience: 'user',
    group: 'tune',
    views: ['market', 'skills'],
    steps: [
      { id: 'find', to: view('market'), spot: 'market.list' },
      { id: 'install', to: view('market'), spot: 'market.list' },
      { id: 'check', to: pane('skills'), spot: tab('skills'), cap: 'skills' },
    ],
  },
  {
    id: 'user.builtin-skills',
    audience: 'user',
    group: 'tune',
    views: ['skills'],
    steps: [
      { id: 'find', to: skillsTab('mine'), spot: 'skills.list' },
      { id: 'read', to: chatMine, spot: 'chat.composer' },
      { id: 'scan', to: chatMine, spot: 'chat.composer' },
      { id: 'make', to: chatMine, spot: 'chat.composer' },
      { id: 'write', to: chatMine, spot: 'chat.composer' },
      { id: 'cards', to: chatMine, spot: 'chat.composer' },
      { id: 'help', to: chatMine, spot: 'chat.composer' },
    ],
  },
  {
    id: 'user.make-skill',
    audience: 'user',
    group: 'tune',
    views: ['skills'],
    steps: [
      { id: 'open', to: view('skills'), spot: 'skills.new' },
      { id: 'write', to: skillsNew('write'), spot: 'skills.name' },
      { id: 'delegate', to: skillsNew('write'), spot: 'skills.delegate' },
      { id: 'zip', to: skillsNew('zip'), spot: 'skills.zip' },
      { id: 'check', to: skillsTab('mine'), spot: 'skills.list' },
    ],
  },
  {
    id: 'user.publish-skill',
    audience: 'user',
    group: 'tune',
    views: ['skills', 'market'],
    steps: [
      { id: 'pick', to: skillsTab('mine'), spot: 'skills.list' },
      { id: 'request', to: skillsTab('mine'), spot: 'skills.list' },
      { id: 'wait', to: skillsTab('mine'), spot: 'skills.list' },
      { id: 'install', to: view('market'), spot: 'market.list' },
    ],
  },
  {
    id: 'user.add-mcp',
    audience: 'user',
    group: 'connect',
    views: ['profiles'], // 도구 화면은 메뉴에서 숨겼다(스펙 2026-10-19-002). MCP 서버는 프로파일 상세에서 더한다
    steps: [
      { id: 'open', to: pane('tools'), spot: tab('tools'), cap: 'mcp' },
      { id: 'add', to: pane('tools'), spot: 'profiles.mcp-add', cap: 'mcp' },
      { id: 'test', to: pane('tools'), spot: 'profiles.tab.tools', cap: 'mcp' },
    ],
  },
  {
    id: 'user.secret',
    audience: 'user',
    group: 'connect',
    views: ['credentials'],
    steps: [
      { id: 'open', to: pane('env'), spot: tab('env'), cap: 'env' },
      { id: 'add', to: pane('env'), spot: 'profiles.env-add', cap: 'env' },
    ],
  },
  {
    id: 'user.messenger',
    audience: 'user',
    group: 'connect',
    views: ['channels'],
    steps: [
      { id: 'open', to: pane('channels'), spot: tab('channels'), cap: 'channels' },
      { id: 'allow', to: pane('channels'), spot: 'profiles.chan-add', cap: 'channels' },
      { id: 'check', to: view('channels'), spot: 'channels.list' },
    ],
  },
  {
    id: 'user.cron',
    audience: 'user',
    group: 'ops',
    views: ['cron'],
    steps: [
      { id: 'open', to: pane('cron'), spot: tab('cron'), cap: 'cron' },
      { id: 'add', to: pane('cron'), spot: 'profiles.cron-add', cap: 'cron' },
      { id: 'check', to: view('cron'), spot: 'cron.list' },
    ],
  },
  {
    id: 'user.office',
    audience: 'user',
    group: 'start',
    views: ['office'],
    steps: [
      { id: 'open', to: view('office'), spot: 'office.tabs' },
      { id: 'meet', to: view('office'), spot: 'office.tabs' },
    ],
  },
  {
    id: 'user.usage',
    audience: 'user',
    group: 'ops',
    views: ['activity', 'changes'],
    steps: [
      { id: 'activity', to: view('activity'), spot: 'activity.list' },
      { id: 'changes', to: view('changes'), spot: 'changes.list' },
    ],
  },
  {
    id: 'user.dept-goal',
    audience: 'user',
    group: 'ops',
    views: ['settings'],
    steps: [
      { id: 'open', to: view('settings'), spot: 'settings.goal' },
      { id: 'edit', to: view('settings'), spot: 'settings.goal' },
    ],
  },
  {
    id: 'admin.users',
    audience: 'admin',
    group: 'start',
    views: ['users'],
    steps: [
      { id: 'open', to: view('users'), spot: 'users.list' },
      { id: 'add', to: view('users'), spot: 'users.add' },
    ],
  },
  {
    id: 'admin.departments',
    audience: 'admin',
    group: 'start',
    views: ['users'],
    steps: [
      { id: 'open', to: view('users'), spot: 'users.list' },
      { id: 'add', to: view('users'), spot: 'users.add' },
    ],
  },
  {
    id: 'admin.agent-limit',
    audience: 'admin',
    group: 'tune',
    views: ['agents'],
    steps: [{ id: 'limit', to: view('agents'), spot: 'agents.create' }],
  },
  {
    id: 'admin.requests',
    audience: 'admin',
    group: 'ops',
    views: ['dashboard', 'profiles'],
    steps: [{ id: 'inbox', to: { view: 'dashboard', params: { inbox: '1' } }, spot: 'inbox.panel' }],
  },
  {
    id: 'admin.models',
    audience: 'admin',
    group: 'tune',
    views: ['models'],
    steps: [{ id: 'open', to: view('models'), spot: 'models.list' }],
  },
  {
    id: 'admin.soul-templates',
    audience: 'admin',
    group: 'tune',
    views: ['soul-templates'],
    steps: [
      { id: 'open', to: view('soul-templates'), spot: 'soul-templates.list' },
      { id: 'add', to: view('soul-templates'), spot: 'soul-templates.add' },
    ],
  },
  {
    id: 'admin.notices',
    audience: 'admin',
    group: 'ops',
    views: ['notices'],
    steps: [
      { id: 'open', to: view('notices'), spot: 'notices.list' },
      { id: 'add', to: view('notices'), spot: 'notices.add' },
    ],
  },
  {
    id: 'admin.company',
    audience: 'admin',
    group: 'tune',
    views: ['settings'],
    steps: [{ id: 'edit', to: view('settings'), spot: 'settings.company' }],
  },
  {
    id: 'admin.health',
    audience: 'admin',
    group: 'ops',
    views: ['dashboard', 'cron', 'channels', 'credentials'],
    steps: [
      { id: 'dashboard', to: view('dashboard'), spot: 'dashboard.fleet' },
      { id: 'cron', to: view('cron'), spot: 'cron.list' },
      { id: 'channels', to: view('channels'), spot: 'channels.list' },
      { id: 'creds', to: view('credentials'), spot: 'credentials.list' },
    ],
  },
  {
    id: 'admin.audit',
    audience: 'admin',
    group: 'ops',
    views: ['changes'],
    steps: [{ id: 'open', to: view('changes'), spot: 'changes.list' }],
  },
  {
    id: 'admin.change-model',
    audience: 'admin',
    group: 'tune',
    views: ['profiles', 'models'],
    steps: [
      { id: 'open', to: overview, spot: 'profiles.tab.overview' },
      { id: 'pick', to: overview, spot: 'profiles.model', cap: 'model' },
    ],
  },
];

export const GROUPS: GuideGroup[] = ['start', 'tune', 'connect', 'ops'];

/** 프로파일 상세 탭 줄 끝의 도움말 단추가 시작하는 가이드(탭 → 가이드). 개요는 관리자면 모델 바꾸기, 아니면 요청 안내 */
export const PANE_GUIDES: Record<string, { user: string; admin?: string }> = {
  overview: { user: 'user.change-model', admin: 'admin.change-model' },
  soul: { user: 'user.change-soul' },
  env: { user: 'user.secret' },
  skills: { user: 'user.add-skill' },
  tools: { user: 'user.add-mcp' },
  cron: { user: 'user.cron' },
  channels: { user: 'user.messenger' },
};

export const guideById = (id: string | null | undefined): Guide | undefined => GUIDES.find((g) => g.id === id);

/** '$mine' 을 바꾼 대상. 바꿀 이름이 없으면 null */
export function resolveTarget(to: GuideTarget, mine: string | null | undefined): GuideTarget | null {
  if (!to.params) return to;
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(to.params)) {
    if (v === MINE) {
      if (!mine) return null;
      params[k] = mine;
    } else params[k] = v;
  }
  return { view: to.view, params };
}

/** 대상의 주소(`/profiles?name=ma&pane=soul`). 개요 탭(overview)은 주소에 적지 않는다(프로파일 상세와 같은 규칙) */
export function targetHref(to: GuideTarget): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(to.params ?? {})) if (!(k === 'pane' && v === 'overview')) q.set(k, v);
  const s = q.toString();
  return '/' + to.view + (s ? '?' + s : '');
}

/** 지금 주소가 대상과 같은가. 대상에 없는 검색 값(목록의 탭·검색 등)은 보지 않는다. pane 이 없으면 개요다 */
export function atTarget(pathname: string, search: string, to: GuideTarget): boolean {
  if ((pathname.split('/').filter(Boolean)[0] ?? 'dashboard') !== to.view) return false;
  const q = new URLSearchParams(search);
  const want = to.params ?? {};
  for (const [k, v] of Object.entries(want)) if ((q.get(k) ?? (k === 'pane' ? 'overview' : '')) !== v) return false;
  if (want.name && !('pane' in want) && q.get('pane') && q.get('pane') !== 'overview') return false;
  return true;
}

/** 대상이 여는 주소 서랍의 id. 프로파일 서랍은 `route:name`, 목록 서랍(useRoutePage, 스펙 2026-10-28-014 외부 검토 L3)은 `route:open`. 없으면 null */
export function routeDrawerId(to: GuideTarget | null | undefined): string | null {
  if (to?.params?.name) return 'route:name';
  if (to?.params?.open) return 'route:open';
  return null;
}

/** 대상이 지금 열린 프로파일 서랍의 다른 탭인가(서랍을 닫지 않고 탭만 바꾼다, 재검토 D8) */
export function sameDrawer(pathname: string, search: string, to: GuideTarget): boolean {
  if (to.view !== 'profiles' || !to.params?.name) return false;
  if ((pathname.split('/').filter(Boolean)[0] ?? '') !== 'profiles') return false;
  return new URLSearchParams(search).get('name') === to.params.name;
}

/** 지금 화면에 대한 가이드(도움말 서랍 맨 위). 보는 사람이 쓸 수 있는 것만 */
export const guidesForView = (view: string, admin: boolean): Guide[] =>
  GUIDES.filter((g) => g.views.includes(view) && (admin || g.audience === 'user'));

/** 가이드 제목·한 줄 설명으로 찾는다. 대소문자와 띄어쓰기를 무시한다(디자인 리뷰 14A) */
export function matchesQuery(text: string, q: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '');
  const n = norm(q);
  return !n || norm(text).includes(n);
}
