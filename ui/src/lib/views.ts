/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 화면 목록. 옛 화면(삭제됨. 커밋 3e3319d 의 aas/web/js/app.js VIEWS)과 같은 순서·묶음·단축키(g 다음 글자)를 쓴다.
// 이름과 설명은 번역 사전(views.*)에 있고 읽는 때에 현재 언어로 나온다(게터).
import { t } from '@/i18n';

export type GroupId = 'dashboard' | 'talk' | 'agent' | 'skill' | 'automation' | 'records' | 'admin' | 'settings';

export interface View {
  readonly id: string;
  readonly key: string;
  readonly groupId: GroupId;
  /** 묶음 이름(현재 언어) */
  readonly group: string;
  readonly label: string;
  readonly sub: string;
}

const view = (id: string, key: string, groupId: GroupId): View => ({
  id,
  key,
  groupId,
  get group() {
    return t(`views.group.${groupId}`);
  },
  get label() {
    return t(`views.${id}.label`);
  },
  get sub() {
    return t(`views.${id}.sub`);
  },
});

// 묶음은 사용자가 하려는 일 기준이다(OMAI-1313, 스펙 2026-10-17-026): 대시보드 · 대화 · 내 에이전트 · 스킬 · 자동화 · 기록 · 관리 · 설정.
// 화면 id·주소·단축키 글자는 그대로 둔다(즐겨찾기·도움말 링크·서버가 보내는 주소가 깨지지 않게). 「프로파일」은 Hermes 프로파일, 「에이전트」는 사용자별 Hermes 설치다(2026-10-18 되돌림).
export const VIEWS: View[] = [
  view('dashboard', 'o', 'dashboard'), // 첫 화면
  view('chat', 'c', 'talk'),
  view('office', 'e', 'talk'),
  view('profiles', 'p', 'agent'), // 「프로파일」
  view('agents', 'n', 'agent'), // 「에이전트」
  view('models', 'm', 'agent'),
  view('skills', 's', 'skill'),
  view('market', 'b', 'skill'),
  view('flows', 'f', 'skill'), // 「스킬 연결도」
  view('cron', 'r', 'automation'), // 「예약 작업」
  view('channels', 'h', 'automation'), // 「메신저 연결」
  view('activity', 'a', 'records'), // 「사용량」
  view('changes', 'j', 'records'),
  view('users', 'u', 'admin'),
  view('soul-templates', 'w', 'admin'), // 「역할 템플릿」
  view('notices', 'y', 'admin'), // 「공지」(스펙 공지 바 4-6)
  view('preferences', 'v', 'settings'), // 「내 화면」
  view('credentials', 'k', 'settings'), // 「API 키·토큰」
  view('connections', 'z', 'settings'), // 「Claude Code 연결」(스펙 2026-10-28-001 §3-7 ②)
  view('settings', 'i', 'settings'),
];

/**
 * 메뉴·검색창·단축키에는 없고 주소(#/id)로만 열리는 화면. 화면 코드와 서버 API 는 그대로 두고 눈에 띄는 길만 뺀다.
 * 라이브러리: 이미지 패키지 목록을 채울 길이 없어 쿠버네티스에서 항상 0개라 숨긴다. 호출 흐름 그림의 라이브러리 링크가 이 주소로 온다
 * (스펙 2026-10-14-025 변경 B). 단축키(g l)는 달지 않는다.
 * 도구: 스크립트 목록이 스킬 목록·스킬 연결도와 겹치고 Hermes 의 「도구 묶음」과 이름이 헷갈려 숨긴다. 스킬·예약 작업 서랍과
 * 호출 흐름 그림의 스크립트 링크가 이 주소로 온다. MCP 서버 탭도 함께 숨긴다(스펙 2026-10-19-002). g t 도 열리지 않는다.
 */
const URL_ONLY_VIEWS: View[] = [view('libraries', 'l', 'skill'), view('tools', 't', 'skill')];

/** 관리자만 쓰는 화면(서버도 403). 관리자가 아니면 사이드바·검색창·단축키에서 뺀다. 변경 기록은 관리자와 에이전트 주인만(OMAI-1122·1126).
 * 회사 정보(settings)는 일반 사용자에게도 열린다: 자기 부서의 슬로건·목표만 고친다(OMAI-1230). 회사 이름·소개 문장은 화면 안에서 관리자에게만 보인다. */
const ADMIN_ONLY = new Set(['users', 'soul-templates', 'notices']);
export interface Viewer {
  admin: boolean;
  owner?: boolean;
  /** 지금 POD 를 팀 관리자로 보는 중(스펙 2026-10-22-001 DD8). 변경 기록을 주인처럼 본다 */
  teamManager?: boolean;
}
export const viewVisible = (id: string, who: Viewer): boolean =>
  who.admin || (id === 'changes' ? !!who.owner || !!who.teamManager : !ADMIN_ONLY.has(id));

export const viewById = (id: string): View | undefined => VIEWS.find((v) => v.id === id) ?? URL_ONLY_VIEWS.find((v) => v.id === id);
export const viewByKey = (key: string): View | undefined => VIEWS.find((v) => v.key === key.toLowerCase());

/** 단축키 표(키, 하는 일). 읽는 때에 현재 언어로 만든다. */
export const shortcuts = (who: Viewer = { admin: true }): [string, string][] => [

  ['⌘K · Ctrl+K', t('shortcuts.palette')],
  ['/', t('shortcuts.focusSearch')],
  [t('shortcuts.goKey'), VIEWS.filter((v) => viewVisible(v.id, who)).map((v) => `${v.key} ${v.label}`).join(' · ')],
  ['Esc', t('shortcuts.close')],
  ['⌥⇧H · Alt+Shift+H', t('guides.shortcut')],
  ['?', t('shortcuts.help')],
];
