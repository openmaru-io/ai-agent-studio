/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 좌측 메뉴 모델. 묶음 › 화면. 숫자는 지금 확인할 것의 수.
// 옛 화면(삭제됨. 커밋 3e3319d 의 aas/web/js/app.js menus())의 묶음·화면 구성을 따른다.
import { t } from '@/i18n';

import { cronBad as countCronBad, expiringCreds } from './issueCounts';
import { GroupId, viewById } from './views';

/** neutral: 고장이 아닌 수(스킬 새 버전, 스펙 2026-10-24-003 D4) — 회색으로 그린다 */
export type Tone = 'bad' | 'warn' | 'neutral';
export type MenuAction = 'palette' | 'refresh' | 'shortcuts';

export interface MenuNode {
  /** 화면 id (눌러서 그 화면으로) */
  id: string;
  label: string;
  sub?: string;
  badge?: number;
  tone?: Tone;
  /** 배지가 무엇의 건수인가(풍선말·접근 이름). 없으면 「N건」(스펙 2026-11-02-001) */
  hint?: string;
}

export interface MenuGroup {
  id: GroupId;
  label: string;
  badge?: number;
  tone?: Tone;
  hint?: string;
  items: MenuNode[];
}

interface Totals {
  [k: string]: number | undefined;
}
export interface MenuInput {
  /** 답이나 승인을 기다리는 대화 수 */
  waiting?: number;
  health?: { totals?: Totals; dashboard_url?: string } | null;
  /** items 가 있으면 백업 파일을 뺀 만료 수를 쓴다(대시보드 숫자와 같게, R4) */
  creds?: { totals?: Totals; items?: { flags?: string[] }[] } | null;
  /** 관리자인가. 아니면 전체 변경 기록과 설정(회사 정보)을 메뉴에서 뺀다(OMAI-1122, 스펙 2026-10-13-012 D2·D3). 기본 참 */
  admin?: boolean;
  /** 관리자가 아니고 지금 POD 의 주인이면 기록 묶음에 「변경 기록」을 둔다(OMAI-1126 디자인 결정 2A). 화면 제목만 「내 AI 에이전트 작업공간 변경 기록」이다(2026-10-24, 메뉴가 두 줄로 넘쳐 줄임) */
  owner?: boolean;
  /** 관리자도 주인도 아니고 지금 POD 를 팀 관리자로 보는 중이면(me.team_manager) 「변경 기록」을 둔다(스펙 2026-10-22-001 DD8). 화면 제목만 「팀원 AI 에이전트 작업공간 변경 기록」이다(2026-10-24 메뉴 이름 줄임) */
  teamManager?: boolean;
  /** 지금 POD id(주인 메뉴의 부제) */
  pod?: string;
  /** 관리자에게 온 처리 대기 요청 수(스펙 2026-10-15-011 단계 5). 관리자가 아니면 항상 0 */
  adminRequests?: number;
  /** 이 작업공간에서 올릴 수 있는 스킬 새 버전 줄 수(/api/me market_updates, D4). 올리기 권한이 없으면 0 */
  marketUpdates?: number;
  /** 7일 안에 끝나는 수동 토큰 수(/api/me connections.expiring, 스펙 2026-10-28-001 §3-7 ②). OAuth 는 쓰면 늘어나 세지 않는다 */
  connectionsExpiring?: number;
}

const n = (v: number | undefined, tone: Tone): Pick<MenuNode, 'badge' | 'tone'> => (v ? { badge: v, tone } : {});

export function buildMenus({ health, creds, waiting = 0, admin = true, owner = false, teamManager = false, pod = '', adminRequests = 0, marketUpdates = 0, connectionsExpiring = 0 }: MenuInput): MenuGroup[] {
  const totals = health?.totals ?? {};
  const expiring = creds?.items ? expiringCreds(creds.items).length : creds?.totals?.expiring;
  const cronBad = countCronBad(totals);
  // 처리 대기 요청 배지는 프로파일 화면의 숫자와 관계없어 무엇의 건수인지 풍선말로 밝힌다(스펙 2026-11-02-001)
  const requests = adminRequests ? { ...n(adminRequests, 'warn'), hint: t('menu.adminRequests', { n: adminRequests }) } : {};
  const screen = (id: string, extra: Partial<Pick<MenuNode, 'badge' | 'tone' | 'label' | 'sub' | 'hint'>> = {}): MenuNode => {
    const v = viewById(id)!;
    return { id, label: v.label, sub: v.sub, ...extra };
  };
  const changesMenu = (): MenuNode[] =>
    admin
      ? [screen('changes')]
      : owner || teamManager
      ? [screen('changes', { sub: t('changes.ownerSub', { pod, days: 30 }) })]
      : [];
  const group = (id: GroupId, items: MenuNode[], extra: Pick<MenuNode, 'badge' | 'tone' | 'hint'> = {}): MenuGroup => ({
    id,
    label: t(`views.group.${id}`),
    ...extra,
    items,
  });
  // 할 일 기준 8묶음(OMAI-1313, 스펙 2026-10-17-026). 관리자가 아니면 「관리」 묶음을 통째로 뺀다(사용자·권한·역할 템플릿은 관리자만, 서버도 403)
  const groups: MenuGroup[] = [
    // 대시보드는 화면 하나짜리 묶음이라 사이드바가 펼치기 없는 한 줄로 그린다(R3)
    group('dashboard', [screen('dashboard')]),
    group('talk', [screen('chat', n(waiting, 'warn')), screen('office')], n(waiting, 'warn')),
    group(
      'agent',
      [
        // 처리 대기 요청은 「프로파일 열기」로 이어지는 프로파일 메뉴에 건수를 붙인다. 보조 문구는 건수를 말로 풀어 쓴다
        screen('profiles', { ...requests, ...(adminRequests ? { sub: t('menu.adminRequests', { n: adminRequests }) } : {}) }),
        screen('agents'),
        screen('models'),
      ],
      requests
    ),
    // 라이브러리는 이미지 패키지 목록을 채울 길이 없어 메뉴에서 숨긴다(스펙 2026-10-14-025 변경 B). 라우트와 서버는 그대로 둔다
    // 도구(스크립트 목록·MCP 서버 탭)도 같은 방식으로 숨긴다(스펙 2026-10-19-002)
    // 스킬 새 버전 수는 화면 항목에만 단다 — 묶음 머리에 올리면 고칠 것처럼 보인다(D4)
    group('skill', [screen('skills'), screen('market', n(marketUpdates, 'neutral')), screen('flows')]),
    group('automation', [screen('cron', n(cronBad, 'bad')), screen('channels')], n(cronBad, 'bad')),
    group('records', [screen('activity'), ...changesMenu()]),
    ...(admin ? [group('admin', [screen('users'), screen('soul-templates'), screen('notices')])] : []),
    // 일반(내 화면)·회사 정보(일반 사용자는 자기 부서 문구만, OMAI-1230)는 모두에게
    group(
      'settings',
      [screen('preferences'), screen('credentials', n(expiring, 'bad')), screen('connections', n(connectionsExpiring, 'bad')), screen('settings')],
      n((expiring ?? 0) + connectionsExpiring, 'bad')
    ),
  ];
  return groups;
}
