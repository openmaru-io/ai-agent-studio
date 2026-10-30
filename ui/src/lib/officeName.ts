/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { t } from '@/i18n';

/** 오피스 화면 제목에 쓰는 이름(OMAI-1121 §3-5). 좌측 메뉴는 「오피스」 그대로 둔다(사용자 결정 2026-10-13).
 *  회사명(설정 화면에 적은 값)과 보는 사람의 Keycloak 부서가 있으면 「<회사> > <부서> 오피스」, 회사명이 없으면 「<부서> 오피스」,
 *  부서가 없으면 「오피스」. 회사명 기본값(OPENMARU, Inc.)은 서버가 주지 않으므로 여기서도 쓰지 않는다. */
type Who = { company_name?: string; department?: string } | null | undefined;

/** 제목을 회사 맥락(있을 때만)과 이름으로 나눈다. 화면은 맥락을 작은 보조 글자로, 이름을 제목으로 그린다 */
export interface TitleParts {
  context?: string;
  title: string;
}

function teamTitle(me: Who, plain: string, withTeam: (team: string) => string): TitleParts {
  const team = (me?.department ?? '').trim();
  if (!team) return { title: plain };
  const title = withTeam(team);
  const context = (me?.company_name ?? '').trim();
  return context ? { context, title } : { title };
}

const joined = (p: TitleParts) => (p.context ? `${p.context} > ${p.title}` : p.title);

export function officeTitle(me: Who): TitleParts {
  return teamTitle(me, t('office.title'), (team) => t('office.teamOffice', { team }));
}

/** 글자만 필요한 곳(문서 제목·읽는 중 화면 등)용: 「<회사> > <이름>」 */
export function officeName(me: Who): string {
  return joined(officeTitle(me));
}

/** 채팅 화면 제목도 오피스와 같은 규칙이다: 「<회사> > <부서> 채팅」, 회사명이 없으면 「<부서> 채팅」, 부서가 없으면 「채팅」.
 *  좌측 메뉴와 탭 제목은 「채팅」 그대로 둔다. */
export function chatTitle(me: Who): TitleParts {
  return teamTitle(me, t('views.chat.label'), (team) => t('chat.teamTitle', { team }));
}

export function chatName(me: Who): string {
  return joined(chatTitle(me));
}
